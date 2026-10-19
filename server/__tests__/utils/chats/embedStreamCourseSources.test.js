/* eslint-env jest, node */
// streamChatWithForEmbed: courseSources reisen nur mit Kurskarten im
// Abschluss-Chunk (finalizeResponseStream, close: true) und in der
// gespeicherten Antwort mit. Kurskarten: gespeicherte Wahl courseCards
// "auto"|"off" (KIE-567) in beiden Darstellungen; ohne Wahl nach der
// tatsächlichen Darstellung, die das Widget mit der Anfrage schickt (R4,
// Fixliste 7.22-rc8: inline an, sonst aus). Der Stream selbst bekommt
// weiterhin sources: [], die DB weiterhin die vollen sources.

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
jest.mock("../../../utils/helpers", () => ({
  getVectorDbClass: jest.fn(),
  getLLMProvider: jest.fn(),
}));
jest.mock("../../../utils/chats/index", () => ({
  chatPrompt: jest.fn().mockResolvedValue("System"),
  sourceIdentifier: jest.fn(),
}));
jest.mock("../../../utils/helpers/chat/responses", () => ({
  convertToPromptHistory: jest.fn(() => []),
  writeResponseChunk: jest.fn(),
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
  fillSourceWindow: jest.fn(() => ({
    contextTexts: ["Kontext"],
    sources: [],
  })),
}));

const helpers = require("../../../utils/helpers");
const { EmbedChats } = require("../../../models/embedChats");
const { writeResponseChunk } = require("../../../utils/helpers/chat/responses");
const { streamChatWithForEmbed } = require("../../../utils/chats/embed");
const fixtures = require("./fixtures/praesentationSources.json");

function makeConnector({ streaming = true } = {}) {
  return {
    defaultTemp: 0.7,
    promptWindowLimit: jest.fn().mockReturnValue(4096),
    compressMessages: jest.fn().mockResolvedValue([]),
    streamingEnabled: jest.fn().mockReturnValue(streaming),
    getChatCompletion: jest
      .fn()
      .mockResolvedValue({ textResponse: "Antwort", metrics: {} }),
    streamGetChatCompletion: jest.fn().mockResolvedValue({ metrics: {} }),
    handleStream: jest.fn().mockResolvedValue("Antwort"),
  };
}

function makeEmbed(visual_config) {
  return {
    id: 3,
    chat_mode: "chat",
    message_limit: 20,
    visual_config,
    workspace: { slug: "chatbot", messagesLimit: null, topN: 4 },
  };
}

let connector;
beforeEach(() => {
  jest.clearAllMocks();
  connector = makeConnector();
  helpers.getLLMProvider.mockReturnValue(connector);
  helpers.getVectorDbClass.mockReturnValue({
    hasNamespace: jest.fn().mockResolvedValue(true),
    namespaceCount: jest.fn().mockResolvedValue(10),
    performSimilaritySearch: jest.fn().mockResolvedValue({
      contextTexts: [],
      sources: JSON.parse(JSON.stringify(fixtures.donauYogaCategoryAndCourses)),
      message: null,
    }),
  });
});

// displayMode: tatsächliche Darstellung aus dem Body von stream-chat (R4);
// ohne Angabe wie das Chatfenster
async function run(embed, displayMode) {
  const response = { locals: {} };
  await streamChatWithForEmbed(response, embed, "Yoga am Abend?", "sess", {
    conversationId: "conv",
    ...(displayMode === undefined ? {} : { displayMode }),
  });
  const finalChunk = writeResponseChunk.mock.calls
    .map(([, chunk]) => chunk)
    .find((c) => c.type === "finalizeResponseStream");
  const stored = EmbedChats.new.mock.calls[0][0].response;
  return { finalChunk, stored };
}

test("In der Seite (Widget meldet inline): courseSources im Abschluss-Chunk und in der gespeicherten Antwort", async () => {
  const { finalChunk, stored } = await run(makeEmbed(null), "inline");
  expect(finalChunk).toMatchObject({ close: true, chatId: 42 });
  expect(finalChunk.courseSources.map((c) => c.title)).toEqual([
    "Yoga (Aufbaukurs)",
    "Yoga",
  ]);
  expect(JSON.stringify(finalChunk)).not.toMatch(
    /Kursbeschreibung|document_metadata|chunkSource|docSource/
  );
  // Stream an das Widget weiterhin ohne Quellen
  expect(connector.handleStream.mock.calls[0][2]).toEqual({
    uuid: expect.any(String),
    sources: [],
  });
  // DB: Text unverändert, volle sources wie bisher, plus courseSources
  expect(stored.text).toBe("Antwort");
  expect(stored.sources).toHaveLength(8);
  expect(stored.courseSources).toEqual(finalChunk.courseSources);
});

// R4 (Fixliste 7.22-rc8, bewusst geändert gegenüber D1 aus 7.22-rc3): ohne
// gespeicherte Wahl entscheidet die Darstellung, die das Widget meldet, nicht
// der gespeicherte displayMode (F01: Inline nur per Script-Attribut; F02:
// Rückfall auf das Chatfenster ohne Platzhalter)
test.each([
  ["ohne visual_config", null],
  ["gespeichert Chatfenster", JSON.stringify({ displayMode: "bubble" })],
  ["gespeichert In der Seite", JSON.stringify({ displayMode: "inline" })],
  ["ungültiger Wert", JSON.stringify({ courseCards: "kaputt" })],
  ["Text zuerst", JSON.stringify({ courseCardsPosition: "below" })],
  ["andere Schlüssel", JSON.stringify({ theme: "dark" })],
])(
  "%s ohne Wahl: Widget meldet inline -> courseSources, bubble oder nichts -> keine",
  async (_l, vc) => {
    const inline = await run(makeEmbed(vc), "inline");
    expect(inline.finalChunk.courseSources.map((c) => c.title)).toEqual([
      "Yoga (Aufbaukurs)",
      "Yoga",
    ]);
    expect(inline.stored.courseSources).toEqual(
      inline.finalChunk.courseSources
    );
    expect(inline.stored.sources).toHaveLength(8);
    for (const displayMode of ["bubble", undefined, "kaputt", null]) {
      jest.clearAllMocks();
      const { finalChunk, stored } = await run(makeEmbed(vc), displayMode);
      expect(finalChunk).toMatchObject({ close: true, chatId: 42 });
      expect(finalChunk).not.toHaveProperty("courseSources");
      expect(stored).not.toHaveProperty("courseSources");
      expect(stored.sources).toHaveLength(8);
    }
  }
);

// KIE-567: gespeicherte Wahl gewinnt in beiden Darstellungen: „Nur Text mit
// Links“ keine Kurskarten (volle sources bleiben serverseitig wie bisher),
// „Kurskarten“ auch im Chatfenster
test.each([
  ["Chatfenster", JSON.stringify({ courseCards: "off" }), "bubble"],
  ["In der Seite", JSON.stringify({ courseCards: "off" }), "inline"],
  [
    "In der Seite gespeichert",
    JSON.stringify({ displayMode: "inline", courseCards: "off" }),
    "inline",
  ],
])("%s mit courseCards off: kein courseSources-Feld", async (_l, vc, dm) => {
  const { finalChunk, stored } = await run(makeEmbed(vc), dm);
  expect(finalChunk).toMatchObject({ close: true, chatId: 42 });
  expect(finalChunk).not.toHaveProperty("courseSources");
  expect(stored).not.toHaveProperty("courseSources");
  expect(stored.sources).toHaveLength(8);
});

test.each([
  ["Chatfenster", "bubble"],
  ["ohne Angabe", undefined],
  ["In der Seite", "inline"],
])("%s mit courseCards auto: courseSources", async (_l, dm) => {
  const { finalChunk, stored } = await run(
    makeEmbed(JSON.stringify({ courseCards: "auto" })),
    dm
  );
  expect(finalChunk.courseSources).toHaveLength(2);
  expect(stored.courseSources).toEqual(finalChunk.courseSources);
});

test("In der Seite, aber nur Info-Seiten: kein courseSources-Feld", async () => {
  helpers.getVectorDbClass.mockReturnValue({
    hasNamespace: jest.fn().mockResolvedValue(true),
    namespaceCount: jest.fn().mockResolvedValue(10),
    performSimilaritySearch: jest.fn().mockResolvedValue({
      contextTexts: [],
      sources: JSON.parse(JSON.stringify(fixtures.infoPagesOnly)),
      message: null,
    }),
  });
  const { finalChunk, stored } = await run(makeEmbed(null), "inline");
  expect(finalChunk).not.toHaveProperty("courseSources");
  expect(stored).not.toHaveProperty("courseSources");
});

test("In der Seite ohne Streaming-Connector: courseSources ebenfalls im Abschluss-Chunk", async () => {
  connector = makeConnector({ streaming: false });
  helpers.getLLMProvider.mockReturnValue(connector);
  const { finalChunk } = await run(makeEmbed(null), "inline");
  expect(finalChunk.courseSources).toHaveLength(2);
  const textChunk = writeResponseChunk.mock.calls
    .map(([, c]) => c)
    .find((c) => c.type === "textResponseChunk");
  expect(textChunk.sources).toEqual([]);
});
