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
  }
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

test("NAK-2: courseCards nicht 'auto' -> keine Hülle, 0 Zugriffe, kein courseSources", async () => {
  for (const vc of [null, JSON.stringify({ courseCards: "off" })]) {
    jest.clearAllMocks();
    const reply = `[[KARTEN: 1]]\n${REPLY_BODY}`;
    const { log, stored, connector, response } = await run({
      reply,
      embed: makeEmbed(vc),
    });
    // Provider bekommt die echte Response, Text unverändert (Bestandskunden)
    expect(connector.handleStream.mock.calls[0][0]).toBe(response);
    expect(stored.text).toBe(reply);
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
