/* eslint-env jest, node */
// streamChatWithForEmbed mit Kurskarten v2: Karten-Marker in der ersten
// Antwortzeile -> angekündigte Kurse sofort als eigener Chunk (vor dem
// ersten Text-Token), Marker nie im Text an das Widget und nie in der DB,
// verlinkte Kurse ohne Treffer-Dokument werden am Ende nachgeschlagen.

const fs = require("fs");
const path = require("path");

jest.mock("../../../utils/prisma", () => ({}));
jest.mock("../../../models/embedChats", () => ({
  EmbedChats: {
    new: jest.fn().mockResolvedValue({ chat: { id: 42 }, message: null }),
    forEmbedByUser: jest.fn().mockResolvedValue([]),
  },
}));
jest.mock("../../../models/workspace", () => ({
  Workspace: {
    _resolveVectorSearchMode: jest.fn().mockResolvedValue("default"),
  },
}));
jest.mock("../../../models/documents", () => ({
  Document: { where: jest.fn() },
}));
jest.mock("../../../utils/files", () => {
  const actual = jest.requireActual("../../../utils/files");
  return {
    documentsPath: "/srv/storage/documents",
    isWithin: actual.isWithin,
    normalizePath: actual.normalizePath,
  };
});
jest.mock("../../../utils/helpers", () => ({
  getVectorDbClass: jest.fn(),
  getLLMProvider: jest.fn(),
}));
jest.mock("../../../utils/chats/index", () => ({
  chatPrompt: jest.fn().mockResolvedValue("System"),
  sourceIdentifier: jest.fn(),
}));
// Gemeinsames Protokoll: jeder Chunk landet über response.write im Log
jest.mock("../../../utils/helpers/chat/responses", () => ({
  convertToPromptHistory: jest.fn(() => []),
  writeResponseChunk: jest.fn((response, data) =>
    response.write(`data: ${JSON.stringify(data)}\n\n`)
  ),
}));
jest.mock("../../../utils/DocumentManager", () => ({
  DocumentManager: class {
    pinnedDocs() {
      return Promise.resolve([]);
    }
  },
}));
jest.mock("../../../utils/helpers/chat/queryRewriter", () => ({
  rewriteQueryForSearch: jest.fn(async ({ userQuery }) => userQuery),
}));
jest.mock("../../../utils/chats/metadataFilterResolver", () => ({
  startMetadataFilterResolution: jest.fn(() => null),
}));
jest.mock("../../../utils/helpers/chat", () => ({
  fillSourceWindow: jest.fn(({ searchResults = [] }) => ({
    sources: searchResults,
    contextTexts: searchResults.map((s) => s.text),
  })),
}));

const helpers = require("../../../utils/helpers");
const { EmbedChats } = require("../../../models/embedChats");
const { Document } = require("../../../models/documents");
const { writeResponseChunk } = require("../../../utils/helpers/chat/responses");
const { streamChatWithForEmbed } = require("../../../utils/chats/embed");
const { documents } = require("./fixtures/demoInlineCourseDocuments.json");
const sourcesFixture = require("./fixtures/praesentationSources.json");

const clone = (v) => JSON.parse(JSON.stringify(v));
const DOCS_ROOT = "/srv/storage/documents";
const BASE = "https://aw.donau.kufer.de/kurssuche/kurs";
const AEROBIC_URL = `${BASE}/aerobic/262-3208`;
const GYM_URL = `${BASE}/spielerische-gymnastik-fuer-eltern-und-kind/262-3204`;
const SPORT_URL = `${BASE}/sport-am-familienwochenende/262-3217`;
const docOf = (needle) =>
  Object.entries(documents).find(([dp]) => dp.includes(needle));

// Treffer wie bei "gibt es sportkurse?": 2 Kategorieseiten + 2 Kurs-
// dokumente (Kopf-Chunks), Aerobic nur über eine Kategorieseite
function courseChunk(needle) {
  const [, doc] = docOf(needle);
  const { pageContent, ...meta } = doc;
  return { ...clone(meta), text: pageContent, score: 0.8 };
}
const CATEGORY = sourcesFixture.donauYogaCategoryAndCourses.find((s) =>
  /^link:\/\//.test(s.chunkSource || "")
);
const SEARCH = () => [
  clone(CATEGORY), // [CONTEXT 0]
  courseChunk("gymnastik"), // [CONTEXT 1]
  courseChunk("sport-am-familienwochenende"), // [CONTEXT 2]
  { ...clone(CATEGORY), id: "kat-2" }, // [CONTEXT 3]
];

const REPLY_BODY = [
  "Ja, es gibt passende Sportkurse:",
  `1. [**Aerobic**](${AEROBIC_URL})`,
  `2. [**Spielerische Gymnastik für Eltern und Kind**](${GYM_URL})`,
  `3. [**Sport am Familienwochenende**](${SPORT_URL})`,
].join("\n");

// Provider-Stream-Handler: schreibt Token für Token über writeResponseChunk
function streamingHandler(tokens) {
  return jest.fn(async (response, _stream, { uuid }) => {
    let full = "";
    for (const token of tokens) {
      full += token;
      writeResponseChunk(response, {
        uuid,
        sources: [],
        type: "textResponseChunk",
        textResponse: token,
        close: false,
        error: false,
      });
      await new Promise((r) => setImmediate(r));
    }
    writeResponseChunk(response, {
      uuid,
      sources: [],
      type: "textResponseChunk",
      textResponse: "",
      close: true,
      error: false,
    });
    return full;
  });
}

function tokensOf(text) {
  return text.match(/[\s\S]{1,7}/g);
}

function makeEmbed(visual_config = JSON.stringify({ courseCards: "auto" })) {
  return {
    id: 3,
    chat_mode: "chat",
    message_limit: 20,
    visual_config,
    workspace: { id: 9, slug: "chatbot", messagesLimit: null, topN: 4 },
  };
}

let readSpy;
beforeEach(() => {
  jest.clearAllMocks();
  Document.where.mockResolvedValue(
    Object.keys(documents).map((docpath) => ({ docpath }))
  );
  readSpy = jest
    .spyOn(fs.promises, "readFile")
    .mockImplementation(async (p) => {
      const hit = Object.entries(documents).find(
        ([dp]) => path.resolve(DOCS_ROOT, dp) === p
      );
      if (!hit) throw new Error(`ENOENT ${p}`);
      return JSON.stringify(hit[1]);
    });
  helpers.getVectorDbClass.mockReturnValue({
    hasNamespace: jest.fn().mockResolvedValue(true),
    namespaceCount: jest.fn().mockResolvedValue(10),
    performSimilaritySearch: jest.fn().mockResolvedValue({
      contextTexts: [],
      sources: SEARCH(),
      message: null,
    }),
  });
});
afterEach(() => readSpy.mockRestore());

async function run({ reply, embed = makeEmbed(), streaming = true }) {
  const log = [];
  const response = {
    locals: {},
    write: jest.fn((raw) => log.push(JSON.parse(raw.slice(6)))),
    on: jest.fn(),
    removeListener: jest.fn(),
  };
  const connector = {
    defaultTemp: 0.7,
    promptWindowLimit: jest.fn().mockReturnValue(4096),
    compressMessages: jest.fn().mockResolvedValue([]),
    streamingEnabled: jest.fn().mockReturnValue(streaming),
    getChatCompletion: jest
      .fn()
      .mockResolvedValue({ textResponse: reply, metrics: {} }),
    streamGetChatCompletion: jest.fn().mockResolvedValue({ metrics: {} }),
    handleStream: streamingHandler(tokensOf(reply)),
  };
  helpers.getLLMProvider.mockReturnValue(connector);
  await streamChatWithForEmbed(response, embed, "gibt es sportkurse?", "sess", {
    conversationId: "conv",
  });
  const stored = EmbedChats.new.mock.calls[0][0].response;
  const text = log
    .filter((c) => c.type === "textResponseChunk")
    .map((c) => c.textResponse)
    .join("");
  return { log, stored, text, connector, response };
}

test("AK-1/AK-4b: angekündigte Kurse vor dem ersten Text-Token, verlinkter dritter Kurs am Ende", async () => {
  const { log, stored, text } = await run({
    reply: `[[KARTEN: 1, 2]]\n\n${REPLY_BODY}`,
  });
  const firstText = log.findIndex(
    (c) => c.type === "textResponseChunk" && c.textResponse
  );
  const early = log.findIndex((c) => c.type === "courseSources");
  expect(early).toBeGreaterThanOrEqual(0);
  expect(early).toBeLessThan(firstText);
  expect(log[early].courseSources.map((c) => c.url)).toEqual([
    GYM_URL,
    SPORT_URL,
  ]);
  expect(log.filter((c) => c.type === "courseSources")).toHaveLength(1);

  // Marker nie im Text an das Widget, nie in der DB
  expect(text).toBe(REPLY_BODY);
  expect(JSON.stringify(log)).not.toMatch(/KARTEN/);
  expect(stored.text).toBe(REPLY_BODY);

  // Abschluss: vollständige Liste (Ergänzung Aerobic), Anzahl angekündigt
  const final = log.find((c) => c.type === "finalizeResponseStream");
  expect(final.courseSources.map((c) => c.title)).toEqual([
    "Spielerische Gymnastik für Eltern und Kind",
    "Sport am Familienwochenende",
    "Aerobic",
  ]);
  expect(final.courseSources[2]).toMatchObject({
    url: AEROBIC_URL,
    start_date: "2026-10-05",
  });
  expect(final.courseCardsAnnounced).toBe(2);
  expect(stored.courseSources).toEqual(final.courseSources);
  expect(stored.courseCardsAnnounced).toBe(2);
  expect(JSON.stringify(final)).not.toMatch(/Kursbeschreibung|chunkSource/);
  expect(readSpy).toHaveBeenCalledTimes(1);
});

test("Marker deckt alle verlinkten Kurse: Abschluss ohne courseSources (nichts Neues), 0 Dateizugriffe", async () => {
  const reply = `[[KARTEN: 2, 1]]\n${REPLY_BODY.split("\n")
    .filter((l) => !/Aerobic/.test(l))
    .join("\n")}`;
  const { log, stored } = await run({ reply });
  const final = log.find((c) => c.type === "finalizeResponseStream");
  expect(final).not.toHaveProperty("courseSources");
  expect(final).not.toHaveProperty("courseCardsAnnounced");
  expect(stored.courseSources.map((c) => c.url)).toEqual([SPORT_URL, GYM_URL]);
  expect(stored.courseCardsAnnounced).toBe(2);
  expect(readSpy).not.toHaveBeenCalled();
  expect(Document.where).not.toHaveBeenCalled();
});

test("ohne Marker: Verhalten wie bisher (Karten erst im Abschluss-Chunk)", async () => {
  const { log, stored, text } = await run({ reply: REPLY_BODY });
  expect(log.find((c) => c.type === "courseSources")).toBeUndefined();
  expect(text).toBe(REPLY_BODY);
  const final = log.find((c) => c.type === "finalizeResponseStream");
  expect(final.courseSources.map((c) => c.url)).toEqual([
    GYM_URL,
    SPORT_URL,
    AEROBIC_URL,
  ]);
  expect(final).not.toHaveProperty("courseCardsAnnounced");
  expect(stored).not.toHaveProperty("courseCardsAnnounced");
});

test("[[KARTEN: -]] und kaputter Marker: entfernt, keine Vorab-Karten", async () => {
  for (const marker of [
    "[[KARTEN: -]]",
    "[[KARTEN: zwei]]",
    "[[KARTEN: 1, 2",
  ]) {
    jest.clearAllMocks();
    const { log, stored, text } = await run({
      reply: `${marker}\nLeider habe ich keinen passenden Kurs gefunden.`,
    });
    expect(log.find((c) => c.type === "courseSources")).toBeUndefined();
    expect(text).toBe("Leider habe ich keinen passenden Kurs gefunden.");
    expect(stored.text).toBe(text);
    // "-" = Marker war da, leer -> []; kaputt -> Feld fehlt
    if (marker === "[[KARTEN: -]]")
      expect(stored.courseCardsMarker).toEqual([]);
    else expect(stored).not.toHaveProperty("courseCardsMarker");
  }
});

test("ohne Marker: courseCardsMarker fehlt in der gespeicherten Antwort", async () => {
  const { stored } = await run({ reply: REPLY_BODY });
  expect(stored).not.toHaveProperty("courseCardsMarker");
});

test("ohne Streaming: courseSources-Chunk vor dem Text, Marker entfernt", async () => {
  const { log, stored } = await run({
    reply: `[[KARTEN: 1]]\n${REPLY_BODY}`,
    streaming: false,
  });
  const early = log.findIndex((c) => c.type === "courseSources");
  const textIdx = log.findIndex((c) => c.type === "textResponseChunk");
  expect(early).toBeLessThan(textIdx);
  expect(log[textIdx].textResponse).toBe(REPLY_BODY);
  expect(stored.text).toBe(REPLY_BODY);
  expect(stored.courseCardsAnnounced).toBe(1);
});

test("NAK-2: courseCards nicht 'auto' -> Marker trotzdem entfernt, 0 Zugriffe, kein courseSources", async () => {
  for (const streaming of [true, false])
    for (const vc of [null, JSON.stringify({ courseCards: "off" })]) {
      jest.clearAllMocks();
      const reply = `[[KARTEN: 1]]\n${REPLY_BODY}`;
      const { log, stored, text } = await run({
        reply,
        embed: makeEmbed(vc),
        streaming,
      });
      // Prompt kann den Marker flottenweit verlangen: nie im Stream/DB-Text
      expect(text).toBe(REPLY_BODY);
      expect(JSON.stringify(log)).not.toMatch(/KARTEN/);
      expect(stored.text).toBe(REPLY_BODY);
      // Nummern nur für den LLM-Verlauf
      expect(stored.courseCardsMarker).toEqual([1]);
      expect(stored).not.toHaveProperty("courseSources");
      expect(stored).not.toHaveProperty("courseCardsAnnounced");
      expect(log.find((c) => c.type === "courseSources")).toBeUndefined();
      expect(
        log.find((c) => c.type === "finalizeResponseStream")
      ).not.toHaveProperty("courseSources");
      expect(Document.where).not.toHaveBeenCalled();
      expect(readSpy).not.toHaveBeenCalled();
    }
});

test("Befund 4: gespeicherter Marker steht im LLM-Verlauf wieder vorn, Text in der DB ohne", async () => {
  const {
    convertToPromptHistory,
  } = require("../../../utils/helpers/chat/responses");
  EmbedChats.forEmbedByUser.mockResolvedValueOnce([
    {
      id: 2,
      prompt: "und abends?",
      response: JSON.stringify({ text: "Nein.", courseCardsMarker: [] }),
    },
    {
      id: 1,
      prompt: "gibt es sportkurse?",
      response: JSON.stringify({
        text: REPLY_BODY,
        courseCardsMarker: [1, 2],
        courseCardsAnnounced: 2,
      }),
    },
  ]);
  const { connector } = await run({ reply: `[[KARTEN: 2]]\n${REPLY_BODY}` });
  const history = convertToPromptHistory.mock.calls[0][0];
  expect(history.map((r) => JSON.parse(r.response).text)).toEqual([
    `[[KARTEN: 1, 2]]\n${REPLY_BODY}`,
    "[[KARTEN: -]]\nNein.",
  ]);
  // dieselben Datensätze gehen an compressMessages (Verlaufskürzung)
  expect(connector.compressMessages.mock.calls[0][1]).toBe(history);
  const stored = EmbedChats.new.mock.calls[0][0].response;
  expect(stored.text).toBe(REPLY_BODY);
  expect(stored.courseCardsMarker).toEqual([2]);
});

// ---------------------------------------------------------------------------
// Kurskarten v3: KI-Teaser "[[TEASER n: …]]" direkt nach dem Marker
// ---------------------------------------------------------------------------
describe("Kurskarten v3: Teaser im Embed-Stream", () => {
  const TEASER_GYM =
    "Spielerisch bewegen mit Ihrem Kind und Anregungen für zu Hause.";
  const TEASER_SPORT =
    "Ein gemeinsamer Nachmittag voller Bewegung für Familien.";
  const BODY = "Ja, zwei Kurse passen gut zu Ihrer Frage.";
  const TEASER_REPLY = [
    "[[KARTEN: 1, 2]]",
    `[[TEASER 1: ${TEASER_GYM}]]`,
    `[[TEASER 2: ${TEASER_SPORT}]]`,
    BODY,
  ].join("\n");

  // Wie run(), protokolliert aber zusätzlich jedes Provider-Token im selben
  // Log (type "__token") — zeigt, WANN ein Chunk relativ zum Strom rausgeht.
  async function runLogged({ reply, embed = makeEmbed(), size = 4 }) {
    const log = [];
    const response = {
      locals: {},
      write: jest.fn((raw) => log.push(JSON.parse(raw.slice(6)))),
      on: jest.fn(),
      removeListener: jest.fn(),
    };
    const tokens = reply.match(new RegExp(`[\\s\\S]{1,${size}}`, "g"));
    const connector = {
      defaultTemp: 0.7,
      promptWindowLimit: jest.fn().mockReturnValue(4096),
      compressMessages: jest.fn().mockResolvedValue([]),
      streamingEnabled: jest.fn().mockReturnValue(true),
      streamGetChatCompletion: jest.fn().mockResolvedValue({ metrics: {} }),
      handleStream: jest.fn(async (res, _stream, { uuid }) => {
        let full = "";
        for (const token of tokens) {
          full += token;
          log.push({ type: "__token", token, sofar: full });
          writeResponseChunk(res, {
            uuid,
            sources: [],
            type: "textResponseChunk",
            textResponse: token,
            close: false,
            error: false,
          });
          await new Promise((r) => setImmediate(r));
        }
        writeResponseChunk(res, {
          uuid,
          sources: [],
          type: "textResponseChunk",
          textResponse: "",
          close: true,
          error: false,
        });
        return full;
      }),
    };
    helpers.getLLMProvider.mockReturnValue(connector);
    await streamChatWithForEmbed(
      response,
      embed,
      "gibt es sportkurse?",
      "sess",
      {
        conversationId: "conv",
      }
    );
    const stored = EmbedChats.new.mock.calls[0][0].response;
    const chunks = log.filter((c) => c.type !== "__token");
    const text = chunks
      .filter((c) => c.type === "textResponseChunk")
      .map((c) => c.textResponse)
      .join("");
    return { log, chunks, stored, text };
  }

  test("AK-3: courseSources -> courseTeasers (URL -> Text) -> Text ab 'Ja, …'; gespeichert ohne Marker/Teaser", async () => {
    const { chunks, stored, text } = await runLogged({ reply: TEASER_REPLY });
    const types = chunks.map((c) => c.type);
    const iSources = types.indexOf("courseSources");
    const iTeasers = types.indexOf("courseTeasers");
    const iText = chunks.findIndex(
      (c) => c.type === "textResponseChunk" && c.textResponse
    );
    expect(iSources).toBeGreaterThanOrEqual(0);
    expect(iSources).toBeLessThan(iTeasers);
    expect(iTeasers).toBeLessThan(iText);
    expect(types.filter((t) => t === "courseTeasers")).toHaveLength(1);
    expect(chunks[iSources].courseSources.map((c) => c.url)).toEqual([
      GYM_URL,
      SPORT_URL,
    ]);
    expect(chunks[iTeasers].teasers).toEqual({
      [GYM_URL]: TEASER_GYM,
      [SPORT_URL]: TEASER_SPORT,
    });
    // Text an das Widget und in der DB ohne Marker/Teaser
    expect(text).toBe(BODY);
    expect(chunks[iText].textResponse.startsWith("Ja")).toBe(true);
    expect(
      JSON.stringify(chunks.filter((c) => c.type === "textResponseChunk"))
    ).not.toMatch(/TEASER|KARTEN/);
    expect(stored.text).toBe(BODY);
    expect(stored.courseTeasers).toEqual({
      [GYM_URL]: TEASER_GYM,
      [SPORT_URL]: TEASER_SPORT,
    });
    expect(stored.courseTeaserLines).toEqual([
      { index: 1, text: TEASER_GYM },
      { index: 2, text: TEASER_SPORT },
    ]);
    expect(stored.courseCardsMarker).toEqual([1, 2]);
    // Karten mit Dauer/Ort aus den Kopfzeilen
    expect(chunks[iSources].courseSources[0]).toMatchObject({
      sessions: "14 x vormittags",
      venue: "vhs-Haus",
    });
  });

  test("AK-4: courseSources geht direkt nach dem Marker raus, bevor Teaserzeilen eintreffen", async () => {
    for (const size of [1, 4, 9]) {
      jest.clearAllMocks();
      const { log } = await runLogged({ reply: TEASER_REPLY, size });
      const iSources = log.findIndex((c) => c.type === "courseSources");
      const firstTeaserToken = log.findIndex(
        (c) => c.type === "__token" && /\[\[TEASER/.test(c.sofar)
      );
      expect(iSources).toBeGreaterThan(0);
      // vor dem Token, mit dem "[[TEASER" vollständig wäre
      expect(iSources).toBeLessThan(firstTeaserToken);
      // courseTeasers erst nach dem Token, das die letzte Zeile schließt
      const lastTeaserClosed = log.findIndex(
        (c) => c.type === "__token" && c.sofar.includes(`${TEASER_SPORT}]]`)
      );
      const iTeasers = log.findIndex((c) => c.type === "courseTeasers");
      expect(iTeasers).toBeGreaterThan(lastTeaserClosed);
    }
  });

  test("NAK-1: fremder Index verworfen, kaputte Zeile als Text; nichts davon in courseTeasers", async () => {
    const broken = `[[TEASER 2: ${"sehr lang ".repeat(30)}`;
    const reply = [
      "[[KARTEN: 1, 2]]",
      `[[TEASER 7: Fremder Kurs.]]`,
      `[[TEASER 1: ${TEASER_GYM}]]`,
      broken,
      BODY,
    ].join("\n");
    const { chunks, stored, text } = await runLogged({ reply });
    const teasers = chunks.find((c) => c.type === "courseTeasers");
    expect(teasers.teasers).toEqual({ [GYM_URL]: TEASER_GYM });
    expect(JSON.stringify(chunks)).not.toMatch(/Fremder Kurs/);
    // kaputte Zeile + Rest unverändert als Text, nichts verloren
    expect(text).toBe(`${broken}\n${BODY}`);
    expect(stored.text).toBe(text);
    expect(stored.courseTeasers).toEqual({ [GYM_URL]: TEASER_GYM });
    expect(stored.courseTeaserLines).toEqual([{ index: 1, text: TEASER_GYM }]);
  });

  test("NAK-2: Teaser bereinigt (Markdown/HTML), ≤ 200 Zeichen, nur Whitelist-Felder", async () => {
    const reply = [
      "[[KARTEN: 1, 2]]",
      `[[TEASER 1: **Ideal** <i>für</i> [Familien](${GYM_URL}) und mehr]]`,
      `[[TEASER 2: ${"Bewegung ".repeat(24)}]]`,
      BODY,
    ].join("\n");
    const { chunks, text } = await runLogged({ reply });
    expect(text).toBe(BODY);
    const { teasers } = chunks.find((c) => c.type === "courseTeasers");
    expect(Object.keys(teasers)).toEqual([GYM_URL, SPORT_URL]);
    expect(teasers[GYM_URL]).toBe("Ideal für Familien und mehr");
    expect(teasers[SPORT_URL].length).toBeLessThanOrEqual(200);
    expect(teasers[SPORT_URL].endsWith("…")).toBe(true);
    const sources = chunks.find((c) => c.type === "courseSources");
    expect(JSON.stringify(sources)).not.toMatch(/Kursbeschreibung|"text"/);
  });

  test("NAK-3: alter Prompt ohne Teaserzeilen -> wie v2, kein courseTeasers", async () => {
    const { chunks, stored, text } = await runLogged({
      reply: `[[KARTEN: 1, 2]]\n\n${BODY}`,
    });
    expect(chunks.find((c) => c.type === "courseTeasers")).toBeUndefined();
    expect(chunks.find((c) => c.type === "courseSources")).toBeDefined();
    expect(text).toBe(BODY);
    expect(stored).not.toHaveProperty("courseTeasers");
    expect(stored).not.toHaveProperty("courseTeaserLines");
  });

  test("[[KARTEN: -]] mit (verbotenen) Teaserzeilen: entfernt, keine Chunks", async () => {
    const { chunks, stored, text } = await runLogged({
      reply: `[[KARTEN: -]]\n[[TEASER 1: Doch einer.]]\nLeider nichts.`,
    });
    expect(chunks.find((c) => c.type === "courseTeasers")).toBeUndefined();
    expect(text).toBe("Leider nichts.");
    expect(stored).not.toHaveProperty("courseTeaserLines");
  });

  test("Review-Befund 4: ungültiger Marker mit Teaserzeilen -> Teaser entfernt (Protokoll), nichts gesendet/gespeichert", async () => {
    const { chunks, stored, text } = await runLogged({
      reply: `[[KARTEN: 1, x]]\n[[TEASER 1: ${TEASER_GYM}]]\n${BODY}`,
    });
    expect(text).toBe(BODY);
    expect(JSON.stringify(chunks)).not.toMatch(/TEASER|KARTEN/);
    expect(chunks.find((c) => c.type === "courseSources")).toBeUndefined();
    expect(chunks.find((c) => c.type === "courseTeasers")).toBeUndefined();
    expect(stored.text).toBe(BODY);
    expect(stored).not.toHaveProperty("courseCardsMarker");
    expect(stored).not.toHaveProperty("courseTeasers");
    expect(stored).not.toHaveProperty("courseTeaserLines");
  });

  test("Review-Befund 2: ']]' im Teasertext -> nichts davon im Text, Teaser bereinigt", async () => {
    const { chunks, stored, text } = await runLogged({
      reply: `[[KARTEN: 1]]\n[[TEASER 1: Kurs [Modul A]] für Einsteiger]]\n${BODY}`,
    });
    expect(text).toBe(BODY);
    const { teasers } = chunks.find((c) => c.type === "courseTeasers");
    expect(teasers).toEqual({ [GYM_URL]: "Kurs [Modul A] für Einsteiger" });
    expect(stored.courseTeaserLines).toEqual([
      { index: 1, text: "Kurs [Modul A] für Einsteiger" },
    ]);
  });

  test("NAK-4: courseCards nicht 'auto' -> Marker und Teaser entfernt, keine Chunks", async () => {
    for (const vc of [null, JSON.stringify({ courseCards: "off" })]) {
      jest.clearAllMocks();
      const { chunks, stored, text } = await runLogged({
        reply: TEASER_REPLY,
        embed: makeEmbed(vc),
      });
      expect(text).toBe(BODY);
      expect(JSON.stringify(chunks)).not.toMatch(/TEASER|KARTEN/);
      expect(chunks.find((c) => c.type === "courseSources")).toBeUndefined();
      expect(chunks.find((c) => c.type === "courseTeasers")).toBeUndefined();
      expect(stored.text).toBe(BODY);
      expect(stored).not.toHaveProperty("courseTeasers");
      // nur für den LLM-Verlauf
      expect(stored.courseTeaserLines).toHaveLength(2);
    }
  });

  test("ohne Streaming: courseSources -> courseTeasers -> Text", async () => {
    const { log, stored } = await run({
      reply: TEASER_REPLY,
      streaming: false,
    });
    const types = log.map((c) => c.type);
    expect(types.indexOf("courseSources")).toBeLessThan(
      types.indexOf("courseTeasers")
    );
    expect(types.indexOf("courseTeasers")).toBeLessThan(
      types.indexOf("textResponseChunk")
    );
    expect(log.find((c) => c.type === "textResponseChunk").textResponse).toBe(
      BODY
    );
    expect(stored.courseTeasers[GYM_URL]).toBe(TEASER_GYM);
  });

  test("AK-8: Folgefrage — Marker und Teaserzeilen stehen im LLM-Verlauf wieder vor der Antwort", async () => {
    const {
      convertToPromptHistory,
    } = require("../../../utils/helpers/chat/responses");
    EmbedChats.forEmbedByUser.mockResolvedValueOnce([
      {
        id: 1,
        prompt: "gibt es sportkurse?",
        response: JSON.stringify({
          text: BODY,
          courseCardsMarker: [1, 2],
          courseTeaserLines: [
            { index: 1, text: TEASER_GYM },
            { index: 2, text: TEASER_SPORT },
          ],
          courseTeasers: { [GYM_URL]: TEASER_GYM },
        }),
      },
    ]);
    await run({ reply: TEASER_REPLY });
    const history = convertToPromptHistory.mock.calls[0][0];
    expect(JSON.parse(history[0].response).text).toBe(TEASER_REPLY);
  });
});

// Fester KI-Hinweis im Widget (visual_config.disclaimer = "footer"): der
// System-Prompt bekommt am Ende eine Zeile, die den Modell-Footer unterdrückt.
// Mit courseCards = "auto" steht davor der Karten-Abschnitt (Design Center).
describe("disclaimer = footer: Prompt-Footer wird unterdrückt", () => {
  const {
    DISCLAIMER_PROMPT_NOTE,
  } = require("../../../utils/chats/embedCourseSources");
  const {
    COURSE_CARDS_PROMPT_NOTE,
  } = require("../../../utils/chats/embedDefaults");

  test("mit disclaimer footer endet der System-Prompt mit dem Override", async () => {
    const { connector } = await run({
      reply: `[[KARTEN: -]]\nKurze Antwort.`,
      embed: makeEmbed(
        JSON.stringify({ courseCards: "auto", disclaimer: " Footer " })
      ),
    });
    const systemPrompt =
      connector.compressMessages.mock.calls[0][0].systemPrompt;
    expect(systemPrompt.startsWith("System")).toBe(true);
    expect(systemPrompt.endsWith(DISCLAIMER_PROMPT_NOTE)).toBe(true);
  });

  test("ohne disclaimer (oder none) kein Footer-Override", async () => {
    for (const vc of [
      JSON.stringify({ courseCards: "auto" }),
      JSON.stringify({ courseCards: "auto", disclaimer: "none" }),
    ]) {
      jest.clearAllMocks();
      const { connector } = await run({
        reply: `[[KARTEN: -]]\nKurze Antwort.`,
        embed: makeEmbed(vc),
      });
      expect(connector.compressMessages.mock.calls[0][0].systemPrompt).toBe(
        `System${COURSE_CARDS_PROMPT_NOTE}`
      );
    }
    jest.clearAllMocks();
    const { connector } = await run({
      reply: `[[KARTEN: -]]\nKurze Antwort.`,
      embed: makeEmbed("{nicht json"),
    });
    expect(connector.compressMessages.mock.calls[0][0].systemPrompt).toBe(
      "System"
    );
  });
});

// Design Center: Karten-Modus serverseitig. Bei courseCards = "auto" hängt
// der Server den Karten-Abschnitt ans Ende des System-Prompts (nach der
// Zeitzeile des Workspace-Prompts), vor Disclaimer- und Folgefragen-Hinweis.
describe("Karten-Abschnitt am Prompt-Ende (courseCards = auto)", () => {
  const {
    DISCLAIMER_PROMPT_NOTE,
    FOLLOW_UPS_PROMPT_NOTE,
  } = require("../../../utils/chats/embedCourseSources");
  const {
    COURSE_CARDS_PROMPT_NOTE,
    COURSE_CARDS_LONG_PROMPT_NOTE,
    courseCardsPromptNote,
  } = require("../../../utils/chats/embedDefaults");
  const { chatPrompt } = require("../../../utils/chats/index");
  // Abschnitte mit Footer Override: Beispiel ohne KI-Hinweis-Zeile
  const SHORT_FOOTER = courseCardsPromptNote({ style: "short", footer: true });
  const LONG_FOOTER = courseCardsPromptNote({ style: "long", footer: true });

  const WORKSPACE_PROMPT =
    "### Security Rules\n…\n### Time Reference\nHeute ist Dienstag, 06.10.2026.";

  async function promptFor(vc, basePrompt = WORKSPACE_PROMPT) {
    jest.clearAllMocks();
    chatPrompt.mockResolvedValueOnce(basePrompt);
    const { connector } = await run({
      reply: `[[KARTEN: -]]\nKurze Antwort.`,
      embed: makeEmbed(vc === null ? null : JSON.stringify(vc)),
    });
    return connector.compressMessages.mock.calls[0][0].systemPrompt;
  }

  test("AK-4: Reihenfolge Workspace-Prompt -> Karten -> Disclaimer -> Folgefragen", async () => {
    expect(
      await promptFor({
        courseCards: "auto",
        disclaimer: "footer",
        followUps: "pills",
      })
    ).toBe(
      `${WORKSPACE_PROMPT}${SHORT_FOOTER}${DISCLAIMER_PROMPT_NOTE}${FOLLOW_UPS_PROMPT_NOTE}`
    );
    expect(await promptFor({ courseCards: "auto", followUps: "pills" })).toBe(
      `${WORKSPACE_PROMPT}${COURSE_CARDS_PROMPT_NOTE}${FOLLOW_UPS_PROMPT_NOTE}`
    );
    expect(await promptFor({ courseCards: " AUTO " })).toBe(
      `${WORKSPACE_PROMPT}${COURSE_CARDS_PROMPT_NOTE}`
    );
  });

  test("AK-4: Präfix bleibt unverändert (Anhang nur am Ende, nach der Zeitzeile)", async () => {
    const prompt = await promptFor({
      courseCards: "auto",
      disclaimer: "footer",
    });
    expect(prompt.startsWith(WORKSPACE_PROMPT)).toBe(true);
    expect(prompt.indexOf("### Course Cards Mode")).toBeGreaterThan(
      prompt.indexOf("### Time Reference")
    );
  });

  test("disclaimer = footer: Beispiel im Karten-Abschnitt ohne KI-Hinweis-Zeile", async () => {
    const KI = "*Ich bin eine KI und kann Fehler machen.";
    const withFooter = await promptFor({
      courseCards: "auto",
      disclaimer: "footer",
    });
    expect(withFooter).not.toContain(KI);
    expect(withFooter).toContain("[[TEASER 1:");
    const withoutFooter = await promptFor({ courseCards: "auto" });
    expect(withoutFooter).toContain(KI);
  });

  test("courseCardsAnswerStyle classic: kein Karten-Abschnitt, übrige Hinweise bleiben", async () => {
    expect(
      await promptFor({
        courseCards: "auto",
        courseCardsAnswerStyle: "classic",
      })
    ).toBe(WORKSPACE_PROMPT);
    expect(
      await promptFor({
        courseCards: "auto",
        courseCardsAnswerStyle: " Classic ",
        disclaimer: "footer",
        followUps: "pills",
      })
    ).toBe(
      `${WORKSPACE_PROMPT}${DISCLAIMER_PROMPT_NOTE}${FOLLOW_UPS_PROMPT_NOTE}`
    );
  });

  test("courseCardsAnswerStyle: long -> Liste mit Links, short/fehlend/ungültig -> Suche", async () => {
    expect(
      await promptFor({ courseCards: "auto", courseCardsAnswerStyle: "long" })
    ).toBe(`${WORKSPACE_PROMPT}${COURSE_CARDS_LONG_PROMPT_NOTE}`);
    expect(
      await promptFor({
        courseCards: "auto",
        courseCardsAnswerStyle: " Long ",
        disclaimer: "footer",
      })
    ).toBe(`${WORKSPACE_PROMPT}${LONG_FOOTER}${DISCLAIMER_PROMPT_NOTE}`);
    for (const style of ["short", "lang", 1, undefined])
      expect(
        await promptFor({ courseCards: "auto", courseCardsAnswerStyle: style })
      ).toBe(`${WORKSPACE_PROMPT}${COURSE_CARDS_PROMPT_NOTE}`);
  });

  test("AK-4/AK-6: ohne courseCards = auto kein Karten-Abschnitt", async () => {
    for (const vc of [
      null,
      {},
      { courseCards: "off" },
      { courseCards: "" },
      { courseCardsAnswerStyle: "long" },
      { courseCardsPosition: "above" },
    ])
      expect(await promptFor(vc)).toBe(WORKSPACE_PROMPT);
    expect(await promptFor({ disclaimer: "footer", followUps: "pills" })).toBe(
      `${WORKSPACE_PROMPT}${DISCLAIMER_PROMPT_NOTE}${FOLLOW_UPS_PROMPT_NOTE}`
    );
  });

  test("AK-6: Bestandskunde ohne neue Schlüssel — Prompt exakt unverändert (Snapshot)", async () => {
    const prompt = await promptFor({
      accentColor: "#FFA102",
      name: "Ihr Online-Berater",
      displayMode: "inline",
    });
    expect(prompt).toMatchInlineSnapshot(`
"### Security Rules
…
### Time Reference
Heute ist Dienstag, 06.10.2026."
`);
  });

  // Server besitzt den Abschnitt: vorhandener Abschnitt im Workspace-Prompt
  // (Prompt-Rollout/Demo) wird entfernt und der serverseitige angehängt
  const SECTIONS = [
    "### Course Cards Mode — Search (ACTIVE — overrides the Course Information Blueprint)\nAlte Regel 1\n[[KARTEN: 3, 1]]\n",
    "### Course Cards Mode (ACTIVE — overrides the Course Information Blueprint)\nAlte Regel 2\n",
    "  ###   course  CARDS mode — Search (alt)\nAlte Regel 3\n",
  ];
  const withSection = (section) =>
    `### Security Rules\n…\n▪▪▪\n\n${section}▪▪▪\n\n### Time Reference\nHeute.`;
  const WITHOUT =
    "### Security Rules\n…\n▪▪▪\n\n▪▪▪\n\n### Time Reference\nHeute.";

  test("NAK-2: Workspace-Abschnitt + short -> genau ein Abschnitt, am Ende (vor Disclaimer/Folgefragen)", async () => {
    for (const section of SECTIONS) {
      const prompt = await promptFor(
        { courseCards: "auto", disclaimer: "footer", followUps: "pills" },
        withSection(section)
      );
      expect(prompt).toBe(
        `${WITHOUT}${SHORT_FOOTER}${DISCLAIMER_PROMPT_NOTE}${FOLLOW_UPS_PROMPT_NOTE}`
      );
      expect(prompt.match(/###\s*course\s+cards\s+mode/gi)).toHaveLength(1);
      expect(prompt).not.toMatch(/Alte Regel/);
      expect(
        await promptFor(
          { courseCards: "auto", courseCardsAnswerStyle: "long" },
          withSection(section)
        )
      ).toBe(`${WITHOUT}${COURSE_CARDS_LONG_PROMPT_NOTE}`);
    }
    const prompt = await promptFor({ courseCards: "auto" });
    expect(prompt.split("### Course Cards Mode")).toHaveLength(2);
  });

  test("Workspace-Abschnitt bis zur nächsten ###-Überschrift bzw. bis zum Ende", async () => {
    const base =
      "### A\nx\n\n### Course Cards Mode — Search\nalt\n\n### Time Reference\nHeute.";
    expect(await promptFor({ courseCards: "auto" }, base)).toBe(
      `### A\nx\n\n### Time Reference\nHeute.${COURSE_CARDS_PROMPT_NOTE}`
    );
    const atEnd = "### A\nx\n\n### Course Cards Mode\nalt\n";
    expect(await promptFor({ courseCards: "auto" }, atEnd)).toBe(
      `### A\nx${COURSE_CARDS_PROMPT_NOTE}`
    );
  });

  test("classic: Workspace-Prompt mit Abschnitt bleibt unverändert (Bestands-Prompts)", async () => {
    for (const section of SECTIONS) {
      const base = withSection(section);
      expect(
        await promptFor(
          { courseCards: "auto", courseCardsAnswerStyle: "classic" },
          base
        )
      ).toBe(base);
      expect(
        await promptFor(
          {
            courseCards: "auto",
            courseCardsAnswerStyle: "classic",
            disclaimer: "footer",
          },
          base
        )
      ).toBe(`${base}${DISCLAIMER_PROMPT_NOTE}`);
    }
  });

  test("ohne courseCards = auto: vorhandener Workspace-Abschnitt bleibt unangetastet", async () => {
    const base = withSection(SECTIONS[0]);
    expect(await promptFor({}, base)).toBe(base);
    expect(await promptFor({ courseCardsAnswerStyle: "short" }, base)).toBe(
      base
    );
  });
});
