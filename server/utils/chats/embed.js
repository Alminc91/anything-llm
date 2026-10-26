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
const { courseInventoryGuard } = require("./courseInventory");
const { rewriteQueryForSearch } = require("../helpers/chat/queryRewriter");
const { startMetadataFilterResolution } = require("./metadataFilterResolver");
const {
  courseCardsEnabled,
  buildCourseSources,
  mergeCourseSources,
  completeCourseSourcesFromReply,
  resolveMarkerCourses,
  courseTeasersFromLines,
  createCourseLookup,
  DISCLAIMER_PROMPT_NOTE,
  FOLLOW_UPS_PROMPT_NOTE,
} = require("./embedCourseSources");
const { EMBED_FIXED_STANDARDS } = require("./embedStandards");
const {
  courseCardsPromptNote,
  removeCourseCardsSections,
} = require("./embedDefaults");
const {
  createCardsMarkerResponse,
  parseCardsReply,
  storedTeaserLines,
  restoreCardsMarkers,
} = require("./embedCardsMarker");
const {
  buildChainedContext,
  createOverviewLinkGuard,
} = require("./embedCategoryChains");

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
    // tatsächliche Darstellung des Widgets ("inline"|"bubble"), nur für
    // den Standard von „Antworten mit Kursen“ (R4, Fixliste 7.22-rc8)
    displayMode,
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
  // KIE-576 Paket 3 (E35): veraltete Kursdokumente (Kursnummer nicht im
  // Feed) kommen weder als angeheftetes Dokument noch über den Rückgriff
  // in Kontext und Quellen; die Suche schließt sie selbst aus
  // (lance/index.js). Ohne gültigen Kursbestand null: alles wie heute.
  const inventoryGuard = await courseInventoryGuard(embed.workspace);
  await new DocumentManager({
    workspace: embed.workspace,
    maxTokens: LLMConnector.promptWindowLimit(),
  })
    .pinnedDocs()
    .then((pinnedDocs) => {
      const keptDocs = inventoryGuard?.filterPinned(pinnedDocs) ?? pinnedDocs;
      keptDocs.forEach((doc) => {
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
    excludeSource: inventoryGuard?.hidesSource ?? null,
  });
  inventoryGuard?.report();

  // Why does contextTexts get all the info, but sources only get current search?
  // This is to give the ability of the LLM to "comprehend" a contextual response without
  // populating the Citations under a response with documents the user "thinks" are irrelevant
  // due to how we manage backfilling of the context to keep chats with the LLM more correct in responses.
  // If a past citation was used to answer the question - that is visible in the history so it logically makes sense
  // and does not appear to the user that a new response used information that is otherwise irrelevant for a given prompt.
  // TLDR; reduces GitHub issues for "LLM citing document that has no answer in it" while keep answers highly accurate.
  // Folgefragen sind fester Standard (immer an): Prompt-Hinweis am Ende
  // (embedSystemPrompt) und Chunk an das Widget. Kurskarten nach der Wahl
  // im Design Center (KIE-567, courseCards "auto" = Kurskarten, "off" = Nur
  // Text mit Links: klassischer Prompt ohne Karten-Abschnitt); ohne
  // gespeicherte Wahl nach der Darstellung, die das Widget mitschickt (R4:
  // In der Seite an, Chatfenster aus).
  const cardsOn = courseCardsEnabled(embed, { displayMode });
  const systemPrompt = embedSystemPrompt(
    await chatPrompt(embed.workspace, username),
    { cardsOn }
  );

  // KIE-576: mit gültiger Kategorie-Karte je Kursdokument die Kette
  // „Kategorie-Ebene d: …“ statt der Kategorie-/Bereich-Link-Zeilen (nur
  // contextTexts; sources, Kurskarten und Verlauf bleiben unverändert). Der
  // Prüfer der Links kennt nur Adressen aus geprüften Quellen (R4-D3):
  // Karte (Knoten, course_links), Kontext, System-Prompt (Kundenregeln) und
  // die gespeicherten Quellen früherer Antworten (Feld sources), nicht deren
  // Text.
  // Ohne Karte und im Kurskarten-Modus (R1-D4, NAK-9) gibt es weder Kette
  // noch Prüfer (alles wie vorher).
  const chained = await buildChainedContext(contextTexts, filledSources, {
    enabled: !cardsOn,
  });
  contextTexts = chained.contextTexts;
  const overviewLinks = createOverviewLinkGuard({
    contextTexts,
    map: chained.map,
    systemPrompt,
    storedChats: rawHistory,
  });
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

  // Compress message to ensure prompt passes token limit with room for response
  // and build system messages based on inputs and history.
  const messages = await LLMConnector.compressMessages(
    {
      systemPrompt,
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
  // Nur mit Karten an (cardsOn, Wahl im Design Center): ange-
  // kündigte Kurse sofort als eigener Chunk + Nachschläge (Marker-Folge-
  // Chunks + Antwort-Links teilen Cache und Limit).
  // KIE-576 Paket 3: veraltete Kursdokumente ergeben keine Karte, auch
  // nicht über den Nachschlag der Antwort-Links
  const courseLookup = cardsOn
    ? createCourseLookup({
        workspace: embed.workspace,
        hideDocument: inventoryGuard?.hidesDocument ?? null,
      })
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
    parsedReply = parseCardsReply(completeText, {
      userMessage: message,
      overviewLinks,
    });
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
      userMessage: message,
      overviewLinks,
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
  parsedReply ??= parseCardsReply(completeText, {
    userMessage: message,
    overviewLinks,
  });
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

  // Folgefragen: Zeile "[[FRAGEN: … | …]]" (siehe embedCardsMarker.js; FF1:
  // überall im Text, Pillen aus der letzten Zeile, ohne Pillen gleich der
  // Nutzerfrage) — Erkennen, Entfernen und Speichern (followUps) laufen
  // IMMER (wie der Marker). Folgefragen sind fester Standard: eigener
  // Chunk nach dem letzten Textchunk (der Text ist jetzt vollständig) und
  // vor finalizeResponseStream.
  const followUps = parsedReply.followUps;
  if (followUps.length > 0)
    writeResponseChunk(response, {
      uuid,
      type: "followUps",
      followUps,
      close: false,
      error: false,
    });

  // Kurskarten (cardsOn, Wahl im Design Center): nur Kurs-
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
 *  1. Karten-Abschnitt (nur mit Karten: fester Stil „kurz“, Beispiel ohne
 *     KI-Hinweis-Zeile, weil der KI-Hinweis fest im Widget steht),
 *  2. Disclaimer-Hinweis (KI-Hinweis fest unter der Eingabe),
 *  3. Folgefragen-Hinweis.
 * Hinweis 2 und 3 und der Stil sind feste Standards des vereinfachten
 * Design Centers (embedStandards.js EMBED_FIXED_STANDARDS) und hängen immer
 * an; variabel ist nur, ob Karten an sind (cardsOn, gespeicherte Wahl
 * „Kurse anzeigen als“, KIE-567). Die Reihenfolge Karten/Text
 * (courseCardsPosition) ändert den Prompt nicht: In beiden Fällen kündigt
 * der Server die Kurse über den Marker an, das Widget ordnet nur an.
 * Der Server besitzt den Karten-Abschnitt: Steht im Workspace-Prompt schon
 * ein Abschnitt "### Course Cards Mode…" (Prompt-Rollout/Demo), wird er
 * immer entfernt; mit Karten hängt der Server genau einen aktuellen am Ende
 * an, ohne Karten keinen (sonst antwortete das Modell kurz ohne Links, aber
 * es erschienen keine Karten).
 * @param {string} basePrompt
 * @param {{cardsOn: boolean}} switches
 * @returns {string}
 */
function embedSystemPrompt(basePrompt, { cardsOn }) {
  return (
    removeCourseCardsSections(basePrompt) +
    (cardsOn
      ? courseCardsPromptNote({
          style: EMBED_FIXED_STANDARDS.courseCardsAnswerStyle,
          footer: true,
        })
      : "") +
    DISCLAIMER_PROMPT_NOTE +
    FOLLOW_UPS_PROMPT_NOTE
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
