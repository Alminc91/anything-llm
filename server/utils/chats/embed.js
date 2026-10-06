const { v4: uuidv4 } = require("uuid");
const { getVectorDbClass, getLLMProvider } = require("../helpers");
const { chatPrompt, sourceIdentifier } = require("./index");
const { EmbedChats } = require("../../models/embedChats");
const { Workspace } = require("../../models/workspace");
const {
  convertToPromptHistory,
  writeResponseChunk,
} = require("../helpers/chat/responses");
const { DocumentManager } = require("../DocumentManager");
const { rewriteQueryForSearch } = require("../helpers/chat/queryRewriter");
const { startMetadataFilterResolution } = require("./metadataFilterResolver");
const {
  courseCardsEnabled,
  courseCardsAnswerStyle,
  buildCourseSources,
  mergeCourseSources,
  completeCourseSourcesFromReply,
  resolveMarkerCourses,
  courseTeasersFromLines,
  createCourseLookup,
  disclaimerFooterEnabled,
  DISCLAIMER_PROMPT_NOTE,
  followUpsEnabled,
  FOLLOW_UPS_PROMPT_NOTE,
} = require("./embedCourseSources");
const {
  courseCardsPromptNote,
  promptHasCourseCardsSection,
} = require("./embedDefaults");
const {
  createCardsMarkerResponse,
  parseCardsReply,
  storedTeaserLines,
  restoreCardsMarkers,
} = require("./embedCardsMarker");

async function streamChatWithForEmbed(
  response,
  /** @type {import("@prisma/client").embed_configs & {workspace?: import("@prisma/client").workspaces}} */
  embed,
  /** @type {String} */
  message,
  /** @type {String} */
  sessionId,
  {
    conversationId,
    promptOverride,
    modelOverride,
    temperatureOverride,
    username,
  }
) {
  const chatMode = embed.chat_mode;
  const chatModel = embed.allow_model_override ? modelOverride : null;

  // If there are overrides in request & they are permitted, override the default workspace ref information.
  if (embed.allow_prompt_override)
    embed.workspace.openAiPrompt = promptOverride;
  if (embed.allow_temperature_override)
    embed.workspace.openAiTemp = parseFloat(temperatureOverride);

  const uuid = uuidv4();

  // Check workspace billing limit BEFORE making LLM calls (saves costs)
  if (
    embed.workspace.messagesLimit !== null &&
    embed.workspace.messagesLimit !== undefined
  ) {
    const { checkWorkspaceMessagesLimit } = require("../helpers");
    const { limitReached } = await checkWorkspaceMessagesLimit(
      embed.workspace,
      response,
      {
        isStreaming: true,
        writeResponseChunk,
        attachments: [],
        uuid,
        language: "de",
      }
    );
    if (limitReached) return;
  }

  const LLMConnector = getLLMProvider({
    provider: embed?.workspace?.chatProvider,
    model: chatModel ?? embed.workspace?.chatModel,
  });
  const VectorDb = getVectorDbClass();

  const messageLimit = embed.message_limit ?? 20;
  const hasVectorizedSpace = await VectorDb.hasNamespace(embed.workspace.slug);
  const embeddingsCount = await VectorDb.namespaceCount(embed.workspace.slug);

  // User is trying to query-mode chat a workspace that has no data in it - so
  // we should exit early as no information can be found under these conditions.
  if ((!hasVectorizedSpace || embeddingsCount === 0) && chatMode === "query") {
    writeResponseChunk(response, {
      id: uuid,
      type: "textResponse",
      textResponse:
        "I do not have enough information to answer that. Try another question.",
      sources: [],
      close: true,
      error: null,
    });
    return;
  }

  let completeText;
  let metrics = {};
  let contextTexts = [];
  let sources = [];
  let pinnedDocIdentifiers = [];
  const { rawHistory, chatHistory } = await recentEmbedChatHistory(
    conversationId, // Use conversationId instead of sessionId for RAG context
    embed,
    messageLimit,
    sessionId // BOLA/IDOR hardening (KIE-505): only load context of the owning session
  );

  // See stream.js comment for more information on this implementation.
  await new DocumentManager({
    workspace: embed.workspace,
    maxTokens: LLMConnector.promptWindowLimit(),
  })
    .pinnedDocs()
    .then((pinnedDocs) => {
      pinnedDocs.forEach((doc) => {
        const { pageContent, ...metadata } = doc;
        pinnedDocIdentifiers.push(sourceIdentifier(doc));
        contextTexts.push(doc.pageContent);
        sources.push({
          text:
            pageContent.slice(0, 1_000) +
            "...continued on in source document...",
          ...metadata,
        });
      });
    });

  // Kurskarten: Quellen der angehefteten Dokumente (gleiche Reihenfolge wie
  // ihre contextTexts) — für die Marker-Nummern [CONTEXT n].
  const pinnedSources = [...sources];

  // KIE-480: Filter-Erkennung startet parallel zu Rewrite + Einbettung (Roh-Nachricht)
  const filtersPromise =
    embeddingsCount !== 0
      ? startMetadataFilterResolution({
          userQuery: message,
          chatHistory: chatHistory,
          namespace: embed.workspace.slug,
          LLMConnector,
        })
      : null;

  const searchQuery = await rewriteQueryForSearch({
    userQuery: message,
    chatHistory,
    LLMConnector,
    workspace: embed.workspace,
  });

  const vectorSearchResults =
    embeddingsCount !== 0
      ? await VectorDb.performSimilaritySearch({
          namespace: embed.workspace.slug,
          filtersPromise,
          input: searchQuery,
          LLMConnector,
          similarityThreshold: embed.workspace?.similarityThreshold,
          topN: embed.workspace?.topN,
          filterIdentifiers: pinnedDocIdentifiers,
          searchMode: await Workspace._resolveVectorSearchMode(
            embed.workspace?.vectorSearchMode
          ),
        })
      : {
          contextTexts: [],
          sources: [],
          message: null,
        };

  // Failed similarity search if it was run at all and failed.
  if (!!vectorSearchResults.message) {
    writeResponseChunk(response, {
      id: uuid,
      type: "abort",
      textResponse: null,
      sources: [],
      close: true,
      error: "Failed to connect to vector database provider.",
    });
    return;
  }

  const { fillSourceWindow } = require("../helpers/chat");
  const filledSources = fillSourceWindow({
    nDocs: embed.workspace?.topN || 4,
    searchResults: vectorSearchResults.sources,
    history: rawHistory,
    filterIdentifiers: pinnedDocIdentifiers,
  });

  // Why does contextTexts get all the info, but sources only get current search?
  // This is to give the ability of the LLM to "comprehend" a contextual response without
  // populating the Citations under a response with documents the user "thinks" are irrelevant
  // due to how we manage backfilling of the context to keep chats with the LLM more correct in responses.
  // If a past citation was used to answer the question - that is visible in the history so it logically makes sense
  // and does not appear to the user that a new response used information that is otherwise irrelevant for a given prompt.
  // TLDR; reduces GitHub issues for "LLM citing document that has no answer in it" while keep answers highly accurate.
  contextTexts = [...contextTexts, ...filledSources.contextTexts];
  sources = [...sources, ...vectorSearchResults.sources];
  // Quelle je Kontextblock [CONTEXT n] (n = Index in contextTexts)
  const contextSources = [...pinnedSources, ...filledSources.sources];

  // If in query mode and no sources are found in current search or backfilled from history, do not
  // let the LLM try to hallucinate a response or use general knowledge
  if (chatMode === "query" && contextTexts.length === 0) {
    writeResponseChunk(response, {
      id: uuid,
      type: "textResponse",
      textResponse:
        embed.workspace?.queryRefusalResponse ??
        "There is no relevant information in this workspace to answer your query.",
      sources: [],
      close: true,
      error: null,
    });
    return;
  }

  // Folgefragen (visual_config.followUps = "pills"): Prompt-Hinweis am Ende
  // (nach dem Disclaimer-Hinweis) und Chunk an das Widget nur dann.
  const followUpsOn = followUpsEnabled(embed);
  // Kurskarten (opt-in, visual_config.courseCards = "auto")
  const cardsOn = courseCardsEnabled(embed);

  // Compress message to ensure prompt passes token limit with room for response
  // and build system messages based on inputs and history.
  const messages = await LLMConnector.compressMessages(
    {
      systemPrompt: embedSystemPrompt(
        await chatPrompt(embed.workspace, username),
        embed,
        { cardsOn, followUpsOn }
      ),
      userPrompt: message,
      contextTexts,
      chatHistory,
    },
    rawHistory
  );

  // Kurskarten v2: Karten-Marker in der ersten Antwortzeile ("[[KARTEN: 0,
  // 2]]", siehe embedCardsMarker.js). Erkennen und Entfernen laufen IMMER
  // (der Prompt kann den Marker flottenweit verlangen, auch wenn die Karten
  // für dieses Embed aus sind) — der Marker erreicht nie Widget oder DB-Text.
  // Nur mit Karten an (opt-in, visual_config.courseCards = "auto"): ange-
  // kündigte Kurse sofort als eigener Chunk + Nachschläge (Marker-Folge-
  // Chunks + Antwort-Links teilen Cache und Limit).
  const courseLookup = cardsOn
    ? createCourseLookup({ workspace: embed.workspace })
    : null;
  let announced = [];
  let announcedUrlByIndex = new Map();
  const announceCourses = async ({ indices }) => {
    if (!cardsOn) return;
    const resolved = await resolveMarkerCourses({
      indices,
      contextSources,
      lookup: courseLookup,
    });
    announced = resolved.courseSources;
    announcedUrlByIndex = resolved.urlByIndex;
    if (announced.length === 0) return;
    writeResponseChunk(response, {
      uuid,
      type: "courseSources",
      courseSources: announced,
      close: false,
      error: false,
    });
  };
  // Kurskarten v3: Teaserzeilen ("[[TEASER n: …]]" direkt nach dem Marker)
  // gesammelt als eigener Chunk — nach den angekündigten Karten, vor dem
  // ersten Textchunk. Nur Nummern mit angekündigter Karte, Text bereinigt.
  // Bereinigt wird genau einmal: Stream-Meldung (onTeasers) und Speichern
  // teilen das Ergebnis (beide Wege entscheiden gleich, parseCardsReply).
  let cleanedTeaserLines = null;
  const cleanTeaserLines = (lines) =>
    (cleanedTeaserLines ??= storedTeaserLines(lines));
  const sendCourseTeasers = (lines) => {
    const cleaned = cleanTeaserLines(lines);
    if (!cardsOn || announced.length === 0) return;
    const teasers = courseTeasersFromLines(cleaned, announcedUrlByIndex);
    if (Object.keys(teasers).length === 0) return;
    writeResponseChunk(response, {
      uuid,
      type: "courseTeasers",
      teasers,
      close: false,
      error: false,
    });
  };

  // Marker/Teaser/Folgefragen/Text der vollständigen Antwort (einmal geparst)
  let parsedReply = null;

  // If streaming is not explicitly enabled for connector
  // we do regular waiting of a response and send a single chunk.
  if (LLMConnector.streamingEnabled() !== true) {
    console.log(
      `\x1b[31m[STREAMING DISABLED]\x1b[0m Streaming is not available for ${LLMConnector.constructor.name}. Will use regular chat method.`
    );
    const { textResponse, metrics: performanceMetrics } =
      await LLMConnector.getChatCompletion(messages, {
        temperature: embed.workspace?.openAiTemp ?? LLMConnector.defaultTemp,
      });
    completeText = textResponse;
    metrics = performanceMetrics;
    parsedReply = parseCardsReply(completeText);
    if (parsedReply.marker.state === "marker") {
      await announceCourses({ indices: parsedReply.marker.indices ?? [] });
      sendCourseTeasers(parsedReply.teasers);
    }
    writeResponseChunk(response, {
      uuid,
      sources: [],
      type: "textResponseChunk",
      textResponse: parsedReply.text,
      close: true,
      error: false,
    });
  } else {
    const stream = await LLMConnector.streamGetChatCompletion(messages, {
      temperature: embed.workspace?.openAiTemp ?? LLMConnector.defaultTemp,
    });
    const markerStream = createCardsMarkerResponse(response, {
      onMarker: announceCourses,
      onTeasers: sendCourseTeasers,
    });
    completeText = await LLMConnector.handleStream(
      markerStream.response,
      stream,
      {
        uuid,
        sources: [],
      }
    );
    await markerStream.done();
    metrics = stream.metrics;
  }

  // Marker und Teaserzeilen aus dem gespeicherten Text entfernen (gleiche
  // Entscheidung wie der Stream-Filter); die Nummernliste bleibt als
  // courseCardsMarker nur für den LLM-Verlauf von Folgefragen erhalten
  // (restoreCardsMarkers). [] = "[[KARTEN: -]]", null = kein/kaputter Marker
  // (Feld fehlt). Kurskarten v3: Teaserzeilen zu Marker-Nummern (nur die
  // sammelt parseCardsReply) ebenso als courseTeaserLines (LLM-Verlauf), den
  // Karten zugeordnet als courseTeasers (Widget-Verlauf).
  parsedReply ??= parseCardsReply(completeText);
  const replyMarker = parsedReply.marker;
  const courseCardsMarker =
    replyMarker.state === "marker" && replyMarker.valid
      ? replyMarker.indices
      : null;
  const courseTeaserLines = cleanTeaserLines(parsedReply.teasers);
  const courseTeasers =
    cardsOn && announced.length > 0
      ? courseTeasersFromLines(courseTeaserLines, announcedUrlByIndex)
      : {};
  completeText = parsedReply.text;

  // Folgefragen: Endzeile "[[FRAGEN: … | …]]" (siehe embedCardsMarker.js) —
  // Erkennen, Entfernen und Speichern (followUps) laufen IMMER (wie der
  // Marker). Nur mit visual_config.followUps = "pills" eigener Chunk nach
  // dem letzten Textchunk (die Zeile steht am Ende, der Text ist jetzt
  // vollständig) und vor finalizeResponseStream.
  const followUps = parsedReply.followUps;
  if (followUpsOn && followUps.length > 0)
    writeResponseChunk(response, {
      uuid,
      type: "followUps",
      followUps,
      close: false,
      error: false,
    });

  // Kurskarten (opt-in, visual_config.courseCards = "auto"): nur Kurs-
  // Metadaten der Whitelist, nie text — sources selbst bleiben serverseitig.
  // Reihenfolge: angekündigte Kurse (Marker), Kurse der Treffer, dann
  // verlinkte Kurse ohne Treffer-Dokument (Nachschlag per Dateiname).
  let courseSources = [];
  if (cardsOn) {
    courseSources = await completeCourseSourcesFromReply({
      replyText: completeText,
      courseSources: mergeCourseSources(announced, buildCourseSources(sources)),
      workspace: embed.workspace,
      lookup: courseLookup,
    });
  }
  const courseCardsAnnounced = announced.length;
  // Abschluss-Chunk trägt courseSources nur, wenn sie über die schon
  // gesendeten angekündigten Kurse hinausgehen (sonst nichts Neues).
  const finalCourseSources =
    courseSources.length > courseCardsAnnounced ? courseSources : [];

  const { chat } = await EmbedChats.new({
    embedId: embed.id,
    prompt: message,
    response: {
      text: completeText,
      type: chatMode,
      sources,
      ...(courseSources.length > 0 ? { courseSources } : {}),
      ...(courseCardsAnnounced > 0 ? { courseCardsAnnounced } : {}),
      ...(courseCardsMarker ? { courseCardsMarker } : {}),
      ...(Object.keys(courseTeasers).length > 0 ? { courseTeasers } : {}),
      ...(courseTeaserLines.length > 0 ? { courseTeaserLines } : {}),
      ...(followUps.length > 0 ? { followUps } : {}),
      metrics,
    },
    connection_information: response.locals.connection
      ? {
          ...response.locals.connection,
          username: !!username ? String(username) : null,
        }
      : { username: !!username ? String(username) : null },
    sessionId,
    conversationId, // Save conversation ID for grouping
  });

  // KIE-504: chatId ans Widget nachreichen, damit die 👍/👎-Bewertung der gerade
  // gestreamten Antwort sofort (ohne History-Reload) zugeordnet werden kann.
  // Muster: workspace-Stream (stream.js finalizeResponseStream). Wird NACH dem
  // Text-close gesendet; das Widget verarbeitet den Chunk additiv (nur chatId),
  // ohne close/animate zu verändern -> keine Flicker-Regression.
  // Kurskarten: courseSources reisen im selben Abschluss-Chunk mit (die
  // Provider-Stream-Handler bleiben unverändert). Mit Marker kamen die
  // angekündigten Kurse schon vorab (type "courseSources"); hier folgt nur
  // noch die vollständige Liste, wenn sie Neues enthält. courseCardsAnnounced
  // = Anzahl der angekündigten Einträge am Listenanfang.
  writeResponseChunk(response, {
    uuid,
    type: "finalizeResponseStream",
    close: true,
    error: false,
    chatId: chat?.id ?? null,
    ...(finalCourseSources.length > 0
      ? {
          courseSources: finalCourseSources,
          ...(courseCardsAnnounced > 0 ? { courseCardsAnnounced } : {}),
        }
      : {}),
  });
  return;
}

/**
 * System-Prompt des Embeds: Workspace-Prompt (inkl. Zeitzeile) plus Hinweise
 * nur am ENDE (der gecachte Präfix der Flotte bleibt unverändert), in dieser
 * Reihenfolge:
 *  1. Karten-Abschnitt (courseCards = "auto"; Stil nach
 *     courseCardsAnswerStyle) — nicht, wenn der Workspace-Prompt schon einen
 *     Abschnitt "### Course Cards Mode" enthält (Prompt-Rollout/Demo),
 *  2. Disclaimer-Hinweis (disclaimer = "footer"),
 *  3. Folgefragen-Hinweis (followUps = "pills").
 * Ohne diese Schlüssel bleibt der Prompt unverändert.
 * @param {string} basePrompt
 * @param {Object} embed
 * @param {{cardsOn: boolean, followUpsOn: boolean}} switches
 * @returns {string}
 */
function embedSystemPrompt(basePrompt, embed, { cardsOn, followUpsOn }) {
  const cardsNote =
    cardsOn && !promptHasCourseCardsSection(basePrompt)
      ? courseCardsPromptNote(courseCardsAnswerStyle(embed))
      : "";
  return (
    basePrompt +
    cardsNote +
    (disclaimerFooterEnabled(embed) ? DISCLAIMER_PROMPT_NOTE : "") +
    (followUpsOn ? FOLLOW_UPS_PROMPT_NOTE : "")
  );
}

/**
 * @param {string} conversationId the conversation id (or session id for backwards compatibility)
 * @param {Object} embed the embed config object
 * @param {Number} messageLimit the number of messages to return
 * @param {string|null} boundSessionId when set, binds the conversation to its owning session (BOLA/IDOR hardening, KIE-505)
 * Kurskarten v2: rawHistory/chatHistory sind nur für den LLM-Prompt — gespeicherte
 * Karten-Marker (courseCardsMarker) stehen dort wieder als erste Antwortzeile,
 * gespeicherte Folgefragen (followUps) als letzte.
 * @returns {Promise<{rawHistory: import("@prisma/client").embed_chats[], chatHistory: {role: string, content: string, attachments?: Object[]}[]}>
 */
async function recentEmbedChatHistory(
  conversationId,
  embed,
  messageLimit = 20,
  boundSessionId = null
) {
  const rawHistory = (
    await EmbedChats.forEmbedByUser(
      embed.id,
      conversationId,
      messageLimit,
      { id: "desc" },
      "conversation_id", // Use conversation_id field instead of session_id
      boundSessionId // BOLA/IDOR hardening (KIE-505): bind conversation to owning session
    )
  ).reverse();
  // Kurskarten v2: Marker früherer Antworten nur im LLM-Verlauf wieder
  // voranstellen (Vorbild für Folgeantworten); /history bleibt ohne Marker.
  const promptHistory = restoreCardsMarkers(rawHistory);
  return {
    rawHistory: promptHistory,
    chatHistory: convertToPromptHistory(promptHistory),
  };
}

module.exports = {
  streamChatWithForEmbed,
  embedSystemPrompt,
};
