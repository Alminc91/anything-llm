/* eslint-env jest, node */
// streamChatWithForEmbed: courseSources reisen nur mit Kurskarten (seit dem
// vereinfachten Design Center fest: Inline an, Chatblase aus) im
// Abschluss-Chunk (finalizeResponseStream,
// close: true) und in der gespeicherten Antwort mit. Der Stream selbst bekommt
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

async function run(embed) {
  const response = { locals: {} };
  await streamChatWithForEmbed(response, embed, "Yoga am Abend?", "sess", {
    conversationId: "conv",
  });
  const finalChunk = writeResponseChunk.mock.calls
    .map(([, chunk]) => chunk)
    .find((c) => c.type === "finalizeResponseStream");
  const stored = EmbedChats.new.mock.calls[0][0].response;
  return { finalChunk, stored };
}

test("Inline: courseSources im Abschluss-Chunk und in der gespeicherten Antwort", async () => {
  const { finalChunk, stored } = await run(
    makeEmbed(JSON.stringify({ displayMode: "inline" }))
  );
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

// D1 (7.22-rc3): Kurskarten auch in der Chatblase und ohne gespeicherte
// Darstellung (F01: Inline nur per Script-Attribut; F02: Rückfall auf die
// Chatblase ohne Platzhalter)
test.each([
  ["ohne visual_config", null],
  ["Chatblase", JSON.stringify({ displayMode: "bubble" })],
  ["ungültiger Wert", JSON.stringify({ courseCards: "kaputt" })],
  ["Text zuerst", JSON.stringify({ courseCardsPosition: "below" })],
  ["andere Schlüssel", JSON.stringify({ theme: "dark" })],
])(
  "%s: courseSources wie bei Inline (Karten in beiden Darstellungen)",
  async (_l, vc) => {
    const { finalChunk, stored } = await run(makeEmbed(vc));
    expect(finalChunk.courseSources.map((c) => c.title)).toEqual([
      "Yoga (Aufbaukurs)",
      "Yoga",
    ]);
    expect(stored.courseSources).toEqual(finalChunk.courseSources);
    expect(stored.sources).toHaveLength(8);
  }
);

// KIE-567: „Nur Text mit Links“ in beiden Darstellungen: keine Kurskarten,
// volle sources bleiben serverseitig wie bisher
test.each([
  ["Chatblase", JSON.stringify({ courseCards: "off" })],
  ["Inline", JSON.stringify({ displayMode: "inline", courseCards: "off" })],
])("%s mit courseCards off: kein courseSources-Feld", async (_l, vc) => {
  const { finalChunk, stored } = await run(makeEmbed(vc));
  expect(finalChunk).toMatchObject({ close: true, chatId: 42 });
  expect(finalChunk).not.toHaveProperty("courseSources");
  expect(stored).not.toHaveProperty("courseSources");
  expect(stored.sources).toHaveLength(8);
});

test("Inline, aber nur Info-Seiten: kein courseSources-Feld", async () => {
  helpers.getVectorDbClass.mockReturnValue({
    hasNamespace: jest.fn().mockResolvedValue(true),
    namespaceCount: jest.fn().mockResolvedValue(10),
    performSimilaritySearch: jest.fn().mockResolvedValue({
      contextTexts: [],
      sources: JSON.parse(JSON.stringify(fixtures.infoPagesOnly)),
      message: null,
    }),
  });
  const { finalChunk, stored } = await run(
    makeEmbed(JSON.stringify({ displayMode: "inline" }))
  );
  expect(finalChunk).not.toHaveProperty("courseSources");
  expect(stored).not.toHaveProperty("courseSources");
});

test("Inline ohne Streaming-Connector: courseSources ebenfalls im Abschluss-Chunk", async () => {
  connector = makeConnector({ streaming: false });
  helpers.getLLMProvider.mockReturnValue(connector);
  const { finalChunk } = await run(
    makeEmbed(JSON.stringify({ displayMode: "inline" }))
  );
  expect(finalChunk.courseSources).toHaveLength(2);
  const textChunk = writeResponseChunk.mock.calls
    .map(([, c]) => c)
    .find((c) => c.type === "textResponseChunk");
  expect(textChunk.sources).toEqual([]);
});
