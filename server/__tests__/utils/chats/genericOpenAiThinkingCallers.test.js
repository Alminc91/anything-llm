/* eslint-env jest, node */
// Thinking-Schalter GENERIC_OPEN_AI_ENABLE_THINKING über echte Aufrufer
// (Spezifikation issues/thinking-schalter-generic-openai.md, AK-4): Embed-
// Widget (streamChatWithForEmbed, mit und ohne Streaming) und Filter-
// Normalizer (completeWith) laufen mit dem echten GenericOpenAiLLM; nur der
// openai-Client ist gemockt. Die Aufrufer selbst kennen den Schalter nicht.
// (Test-Gerüst wie embedStreamFollowUps.test.js)

jest.mock("../../../utils/AiProviders/modelMap", () => ({
  MODEL_MAP: { get: () => 128_000 },
}));
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
  Document: { where: jest.fn().mockResolvedValue([]) },
}));
jest.mock("../../../utils/helpers", () => ({
  getVectorDbClass: jest.fn(),
  getLLMProvider: jest.fn(),
}));
jest.mock("../../../utils/chats/index", () => ({
  chatPrompt: jest.fn().mockResolvedValue("System"),
  sourceIdentifier: jest.fn(),
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
// Kursbestand ist hier nicht Gegenstand: ohne gültigen Bestand wie heute
jest.mock("../../../utils/chats/courseInventory", () => ({
  courseInventoryGuard: jest.fn().mockResolvedValue(null),
}));
jest.mock("../../../utils/chats/metadataFilterResolver", () => ({
  startMetadataFilterResolution: jest.fn(() => null),
}));
jest.mock("../../../utils/helpers/chat", () => ({
  fillSourceWindow: jest.fn(({ searchResults = [] }) => ({
    sources: searchResults,
    contextTexts: searchResults.map((s) => s.text),
  })),
  // Kompression ist hier nicht Gegenstand: Nachrichten unverändert weiter
  messageArrayCompressor: jest.fn(async (_llm, messageArray) => messageArray),
}));

const helpers = require("../../../utils/helpers");
const { streamChatWithForEmbed } = require("../../../utils/chats/embed");
const {
  always,
  completeWith,
} = require("../../../utils/chats/metadataFilterNormalizer");
const {
  GenericOpenAiLLM,
} = require("../../../utils/AiProviders/genericOpenAi");

const ENV_KEYS = [
  "GENERIC_OPEN_AI_BASE_PATH",
  "GENERIC_OPEN_AI_MODEL_PREF",
  "GENERIC_OPEN_AI_MAX_TOKENS",
  "GENERIC_OPEN_AI_API_KEY",
  "GENERIC_OPEN_AI_ENABLE_THINKING",
  "GENERIC_OPENAI_STREAMING_DISABLED",
];
const savedEnv = {};

const REPLY = "Der Kurs beginnt am Montag um 18 Uhr.";

// Echter Provider, nur der openai-Client ist gemockt
function makeConnector() {
  const llm = new GenericOpenAiLLM({
    embedTextInput: jest.fn(),
    embedChunks: jest.fn(),
  });
  const create = jest.fn((body) => {
    if (body.stream)
      return Promise.resolve({
        [Symbol.asyncIterator]: async function* () {
          yield { choices: [{ delta: { content: REPLY } }] };
          yield { choices: [{ delta: {}, finish_reason: "stop" }] };
        },
      });
    return Promise.resolve({
      choices: [{ message: { content: REPLY }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 9, total_tokens: 19 },
    });
  });
  llm.openai = { chat: { completions: { create } } };
  return { llm, create };
}

function makeEmbed() {
  return {
    id: 3,
    chat_mode: "chat",
    message_limit: 20,
    visual_config: JSON.stringify({ displayMode: "inline" }),
    workspace: { id: 9, slug: "ki-helfer", messagesLimit: null, topN: 4 },
  };
}

async function runEmbedChat() {
  const { llm, create } = makeConnector();
  helpers.getLLMProvider.mockReturnValue(llm);
  const log = [];
  const response = {
    locals: {},
    write: jest.fn((raw) => log.push(JSON.parse(raw.slice(6)))),
    on: jest.fn(),
    removeListener: jest.fn(),
  };
  await streamChatWithForEmbed(
    response,
    makeEmbed(),
    "Wann beginnt der Kurs?",
    "sess",
    { conversationId: "conv", displayMode: "inline" }
  );
  const text = log
    .filter((c) => c.type === "textResponseChunk")
    .map((c) => c.textResponse)
    .join("");
  return { create, text };
}

beforeAll(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
});

afterAll(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  console.log.mockRestore();
  console.warn.mockRestore();
});

beforeEach(() => {
  jest.clearAllMocks();
  process.env.GENERIC_OPEN_AI_BASE_PATH = "http://stackit.invalid/v1";
  process.env.GENERIC_OPEN_AI_MODEL_PREF = "google/gemma-4-31B-it";
  process.env.GENERIC_OPEN_AI_MAX_TOKENS = "1024";
  process.env.GENERIC_OPEN_AI_API_KEY = "test-key";
  delete process.env.GENERIC_OPEN_AI_ENABLE_THINKING;
  delete process.env.GENERIC_OPENAI_STREAMING_DISABLED;
  helpers.getVectorDbClass.mockReturnValue({
    hasNamespace: jest.fn().mockResolvedValue(true),
    namespaceCount: jest.fn().mockResolvedValue(10),
    performSimilaritySearch: jest.fn().mockResolvedValue({
      contextTexts: [],
      sources: [],
      message: null,
    }),
  });
});

describe("AK-4: Embed-Widget schickt den Schalter ohne eigene Änderung", () => {
  test.each([
    ["Streaming", undefined],
    ["ohne Streaming", "true"],
  ])(
    "%s: Variable false ergibt enable_thinking: false im Body",
    async (_label, streamingDisabled) => {
      if (streamingDisabled)
        process.env.GENERIC_OPENAI_STREAMING_DISABLED = streamingDisabled;
      process.env.GENERIC_OPEN_AI_ENABLE_THINKING = "false";
      const { create, text } = await runEmbedChat();
      expect(create).toHaveBeenCalledTimes(1);
      const body = create.mock.calls[0][0];
      expect(body.stream === true).toBe(!streamingDisabled);
      expect(body.model).toBe("google/gemma-4-31B-it");
      expect(body.max_tokens).toBe(1024);
      expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
      expect(text).toBe(REPLY);
    }
  );

  test("Variable true ergibt enable_thinking: true im Body", async () => {
    process.env.GENERIC_OPEN_AI_ENABLE_THINKING = "true";
    const { create } = await runEmbedChat();
    expect(create.mock.calls[0][0].chat_template_kwargs).toEqual({
      enable_thinking: true,
    });
  });

  test("ohne Variable: Body ohne chat_template_kwargs wie bisher", async () => {
    const { create, text } = await runEmbedChat();
    expect(create.mock.calls[0][0]).not.toHaveProperty("chat_template_kwargs");
    expect(text).toBe(REPLY);
  });
});

describe("AK-4: Filter-Normalizer schickt den Schalter ohne eigene Änderung", () => {
  async function runNormalizer() {
    const { llm, create } = makeConnector();
    create.mockImplementation(() =>
      Promise.resolve({
        choices: [{ message: { content: '{"date_from":"today"}' } }],
        usage: {},
      })
    );
    const result = await always("Kurse ab heute", {
      referenceDate: "2026-11-03",
      knownLocations: [],
      complete: completeWith(llm),
    });
    return { create, result };
  }

  test("Variable false ergibt enable_thinking: false im Body", async () => {
    process.env.GENERIC_OPEN_AI_ENABLE_THINKING = "false";
    const { create, result } = await runNormalizer();
    expect(create).toHaveBeenCalledTimes(1);
    const body = create.mock.calls[0][0];
    expect(body.temperature).toBe(0);
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(result.stage).toBe("llm");
  });

  test("ohne Variable: Body ohne chat_template_kwargs wie bisher", async () => {
    const { create, result } = await runNormalizer();
    expect(create.mock.calls[0][0]).not.toHaveProperty("chat_template_kwargs");
    expect(result.stage).toBe("llm");
  });
});
