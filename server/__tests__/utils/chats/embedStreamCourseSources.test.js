/* eslint-env jest, node */
// streamChatWithForEmbed: courseSources reisen nur bei
// visual_config.courseCards = "auto" im Abschluss-Chunk (finalizeResponseStream,
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

test("auto: courseSources im Abschluss-Chunk und in der gespeicherten Antwort", async () => {
  const { finalChunk, stored } = await run(
    makeEmbed(JSON.stringify({ courseCards: "auto" }))
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

test.each([
  ["ohne visual_config", null],
  ["courseCards off", JSON.stringify({ courseCards: "off" })],
  ["andere Schlüssel", JSON.stringify({ theme: "dark" })],
])("%s: kein courseSources-Feld, Verhalten wie bisher", async (_l, vc) => {
  const { finalChunk, stored } = await run(makeEmbed(vc));
  expect(finalChunk).toEqual({
    uuid: expect.any(String),
    type: "finalizeResponseStream",
    close: true,
    error: false,
    chatId: 42,
  });
  expect(stored).not.toHaveProperty("courseSources");
  expect(stored.sources).toHaveLength(8);
});

test("auto, aber nur Info-Seiten: kein courseSources-Feld", async () => {
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
    makeEmbed(JSON.stringify({ courseCards: "auto" }))
  );
  expect(finalChunk).not.toHaveProperty("courseSources");
  expect(stored).not.toHaveProperty("courseSources");
});

test("auto ohne Streaming-Connector: courseSources ebenfalls im Abschluss-Chunk", async () => {
  connector = makeConnector({ streaming: false });
  helpers.getLLMProvider.mockReturnValue(connector);
  const { finalChunk } = await run(
    makeEmbed(JSON.stringify({ courseCards: "auto" }))
  );
  expect(finalChunk.courseSources).toHaveLength(2);
  const textChunk = writeResponseChunk.mock.calls
    .map(([, c]) => c)
    .find((c) => c.type === "textResponseChunk");
  expect(textChunk.sources).toEqual([]);
});
