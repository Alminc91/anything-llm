/* eslint-env jest, node */
// Weitergabe der optionalen LLM-Optionen durch die Chat-Handler an den
// LLMConnector (OpenAI-kompatibler Pfad + workspace/chat-API-Pfad) sowie die
// optionale reasoning_content-Trennung am OpenAI-kompatiblen Endpunkt.

jest.mock("../../../utils/prisma", () => ({}));
jest.mock("../../../models/workspaceChats", () => ({
  WorkspaceChats: {
    new: jest.fn(),
    markThreadHistoryInvalidV2: jest.fn(),
  },
}));
jest.mock("../../../models/workspace", () => ({
  Workspace: {
    _resolveVectorSearchMode: jest.fn().mockResolvedValue("default"),
  },
}));
jest.mock("../../../models/telemetry", () => ({
  Telemetry: { sendTelemetry: jest.fn() },
}));
jest.mock("../../../utils/helpers", () => ({
  getVectorDbClass: jest.fn(),
  getLLMProvider: jest.fn(),
  getMessageLimitInfo: jest.fn(),
  getMessageLimitErrorText: jest.fn(),
  checkWorkspaceMessagesLimit: jest.fn(),
}));
jest.mock("../../../utils/chats/index", () => ({
  chatPrompt: jest.fn().mockResolvedValue("System"),
  sourceIdentifier: jest.fn(),
  recentChatHistory: jest
    .fn()
    .mockResolvedValue({ rawHistory: [], chatHistory: [] }),
  grepAllSlashCommands: jest.fn(async (message) => message),
}));
jest.mock("../../../utils/agents/ephemeral", () => ({
  EphemeralAgentHandler: { isAgentInvocation: () => false },
  EphemeralEventListener: class {},
}));
jest.mock("../../../utils/collectorApi", () => ({ CollectorApi: class {} }));
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
jest.mock("../../../utils/helpers/chat", () => ({
  fillSourceWindow: jest.fn(() => ({ contextTexts: [], sources: [] })),
}));

const { WorkspaceChats } = require("../../../models/workspaceChats");
const helpers = require("../../../utils/helpers");
const { writeResponseChunk } = require("../../../utils/helpers/chat/responses");
const {
  OpenAICompatibleChat,
} = require("../../../utils/chats/openaiCompatible");
const { ApiChatHandler } = require("../../../utils/chats/apiChatHandler");

let connector;
let workspace;

function makeConnector() {
  return {
    defaultTemp: 0.7,
    promptWindowLimit: jest.fn().mockReturnValue(4096),
    compressMessages: jest
      .fn()
      .mockResolvedValue([{ role: "user", content: "x" }]),
    getChatCompletion: jest
      .fn()
      .mockResolvedValue({ textResponse: "391", metrics: {} }),
    streamingEnabled: jest.fn().mockReturnValue(true),
    streamGetChatCompletion: jest.fn().mockResolvedValue({ metrics: {} }),
    handleStream: jest.fn().mockResolvedValue("391"),
  };
}

function writtenEvents(response) {
  return response.write.mock.calls
    .map(([raw]) => String(raw))
    .filter((raw) => raw.startsWith("data: {"))
    .map((raw) => JSON.parse(raw.slice("data: ".length)));
}

beforeAll(() => {
  jest.spyOn(console, "log").mockImplementation(() => {});
});

afterAll(() => {
  console.log.mockRestore();
});

beforeEach(() => {
  jest.clearAllMocks();
  connector = makeConnector();
  workspace = {
    id: 1,
    slug: "ws",
    chatMode: "chat",
    openAiTemp: 1.0,
    chatProvider: "generic-openai",
  };
  helpers.getLLMProvider.mockReturnValue(connector);
  helpers.getVectorDbClass.mockReturnValue({
    hasNamespace: jest.fn().mockResolvedValue(true),
    namespaceCount: jest.fn().mockResolvedValue(0),
    performSimilaritySearch: jest.fn(),
  });
  helpers.getMessageLimitInfo.mockResolvedValue({
    messageCount: 1,
    messagesLimit: null,
    contingent: "1/Unlimited",
  });
  helpers.checkWorkspaceMessagesLimit.mockResolvedValue({
    limitReached: false,
  });
  WorkspaceChats.new.mockResolvedValue({ chat: { id: 42 } });
});

describe("OpenAICompatibleChat – LLM-Optionen", () => {
  const baseArgs = () => ({
    workspace,
    prompt: "Was ist 17*23?",
    history: [],
    temperature: 0.7,
    messageCount: 0,
    messagesLimit: null,
  });

  test("chatSync ohne Optionen: Connector-Optionen exakt wie bisher", async () => {
    await OpenAICompatibleChat.chatSync(baseArgs());
    const options = connector.getChatCompletion.mock.calls[0][1];
    expect(options).toEqual({ temperature: 0.7 });
    expect(Object.keys(options)).toEqual(["temperature"]);
  });

  test("chatSync reicht Optionen an den Connector durch", async () => {
    await OpenAICompatibleChat.chatSync({
      ...baseArgs(),
      llmOptions: {
        maxTokens: 4096,
        chatTemplateKwargs: { enable_thinking: true },
      },
    });
    expect(connector.getChatCompletion.mock.calls[0][1]).toEqual({
      temperature: 0.7,
      maxTokens: 4096,
      chatTemplateKwargs: { enable_thinking: true },
    });
  });

  test("streamChat reicht Optionen an den Connector durch", async () => {
    const response = { write: jest.fn(), status: jest.fn() };
    await OpenAICompatibleChat.streamChat({
      ...baseArgs(),
      response,
      llmOptions: { topP: 0.5, reasoningEffort: "high" },
    });
    expect(connector.streamGetChatCompletion.mock.calls[0][1]).toEqual({
      temperature: 0.7,
      topP: 0.5,
      reasoningEffort: "high",
    });
  });

  test("streamChat ohne Optionen: Connector-Optionen exakt wie bisher", async () => {
    const response = { write: jest.fn(), status: jest.fn() };
    await OpenAICompatibleChat.streamChat({ ...baseArgs(), response });
    expect(
      Object.keys(connector.streamGetChatCompletion.mock.calls[0][1])
    ).toEqual(["temperature"]);
  });

  describe("reasoning_content-Trennung (Nicht-Stream)", () => {
    beforeEach(() => {
      connector.getChatCompletion.mockResolvedValue({
        textResponse: "<think>17*20=340, 17*3=51</think>391",
        metrics: {},
      });
    });

    test("ohne Reasoning-Optionen bleibt content unverändert (inkl. <think>)", async () => {
      const result = await OpenAICompatibleChat.chatSync({
        ...baseArgs(),
        llmOptions: { maxTokens: 100 },
      });
      const message = result.choices[0].message;
      expect(message.content).toBe("<think>17*20=340, 17*3=51</think>391");
      expect(message).not.toHaveProperty("reasoning_content");
    });

    test("mit chat_template_kwargs: reasoning_content getrennt, DB unverändert", async () => {
      const result = await OpenAICompatibleChat.chatSync({
        ...baseArgs(),
        llmOptions: { chatTemplateKwargs: { enable_thinking: true } },
      });
      const message = result.choices[0].message;
      expect(message.content).toBe("391");
      expect(message.reasoning_content).toBe("17*20=340, 17*3=51");
      expect(WorkspaceChats.new).toHaveBeenCalledWith(
        expect.objectContaining({
          response: expect.objectContaining({
            text: "<think>17*20=340, 17*3=51</think>391",
          }),
        })
      );
    });

    test("mit reasoning_effort, aber ohne think-Block: keine Änderung", async () => {
      connector.getChatCompletion.mockResolvedValue({
        textResponse: "391",
        metrics: {},
      });
      const result = await OpenAICompatibleChat.chatSync({
        ...baseArgs(),
        llmOptions: { reasoningEffort: "none" },
      });
      expect(result.choices[0].message.content).toBe("391");
      expect(result.choices[0].message).not.toHaveProperty("reasoning_content");
    });
  });

  describe("reasoning_content-Trennung (Stream)", () => {
    function simulateGenericStream() {
      // Chunk-Struktur wie GenericOpenAiLLM.handleStream
      connector.handleStream.mockImplementation(
        async (res, _stream, { uuid }) => {
          const chunk = (textResponse, close = false) =>
            writeResponseChunk(res, {
              uuid,
              sources: [],
              type: "textResponseChunk",
              textResponse,
              close,
              error: false,
            });
          chunk("<think>17*20");
          chunk("=340");
          chunk("</think>");
          chunk("39");
          chunk("1");
          chunk("", true);
          return "<think>17*20=340</think>391";
        }
      );
    }

    async function runStream(llmOptions) {
      simulateGenericStream();
      const response = { write: jest.fn(), status: jest.fn() };
      await OpenAICompatibleChat.streamChat({
        ...baseArgs(),
        response,
        llmOptions,
      });
      // Interceptor-Events laufen asynchron (PassThrough)
      await new Promise((resolve) => setImmediate(resolve));
      return writtenEvents(response).filter(
        (event) => event.choices?.[0]?.delta
      );
    }

    test("ohne Reasoning-Optionen: delta.content wie bisher", async () => {
      const events = await runStream(undefined);
      const content = events
        .map((e) => e.choices[0].delta.content ?? "")
        .join("");
      expect(content).toBe("<think>17*20=340</think>391");
      expect(
        events.some((e) => "reasoning_content" in e.choices[0].delta)
      ).toBe(false);
    });

    test("mit chat_template_kwargs: delta.reasoning_content getrennt", async () => {
      const events = await runStream({
        chatTemplateKwargs: { enable_thinking: true },
      });
      const content = events
        .map((e) => e.choices[0].delta.content ?? "")
        .join("");
      const reasoning = events
        .map((e) => e.choices[0].delta.reasoning_content ?? "")
        .join("");
      expect(content).toBe("391");
      expect(reasoning).toBe("17*20=340");
      // Chat-Verlauf in der DB bleibt der vollständige Text
      expect(WorkspaceChats.new).toHaveBeenCalledWith(
        expect.objectContaining({
          response: expect.objectContaining({
            text: "<think>17*20=340</think>391",
          }),
        })
      );
    });
  });
});

describe("ApiChatHandler – llmOptions am workspace/chat-Pfad", () => {
  const baseArgs = () => ({
    workspace,
    message: "Was ist 17*23?",
    mode: "chat",
    user: null,
    thread: null,
    sessionId: null,
    attachments: [],
    reset: false,
  });

  test("chatSync ohne llmOptions: Workspace-Temperatur, Optionen wie bisher", async () => {
    const result = await ApiChatHandler.chatSync(baseArgs());
    expect(result.type).toBe("textResponse");
    const options = connector.getChatCompletion.mock.calls[0][1];
    expect(options).toEqual({ temperature: 1.0, user: null });
    expect(Object.keys(options)).toEqual(["temperature", "user"]);
  });

  test("chatSync: Anfrage-Temperatur 0.1 schlägt Workspace-Temperatur 1.0", async () => {
    await ApiChatHandler.chatSync({
      ...baseArgs(),
      llmOptions: { temperature: 0.1 },
    });
    expect(connector.getChatCompletion.mock.calls[0][1]).toEqual({
      temperature: 0.1,
      user: null,
    });
  });

  test("chatSync: Temperatur 0 wird respektiert (kein Fallback)", async () => {
    await ApiChatHandler.chatSync({
      ...baseArgs(),
      llmOptions: { temperature: 0 },
    });
    expect(connector.getChatCompletion.mock.calls[0][1].temperature).toBe(0);
  });

  test("chatSync ohne Workspace-Temperatur: Provider-Default", async () => {
    workspace.openAiTemp = null;
    await ApiChatHandler.chatSync(baseArgs());
    expect(connector.getChatCompletion.mock.calls[0][1].temperature).toBe(0.7);
  });

  test("chatSync reicht alle Optionen durch", async () => {
    await ApiChatHandler.chatSync({
      ...baseArgs(),
      llmOptions: {
        maxTokens: 4096,
        topP: 0.9,
        reasoningEffort: "low",
        chatTemplateKwargs: { enable_thinking: true },
      },
    });
    expect(connector.getChatCompletion.mock.calls[0][1]).toEqual({
      temperature: 1.0,
      user: null,
      maxTokens: 4096,
      topP: 0.9,
      reasoningEffort: "low",
      chatTemplateKwargs: { enable_thinking: true },
    });
  });

  test("streamChat (Stream aktiv) reicht Optionen durch", async () => {
    const response = { write: jest.fn() };
    await ApiChatHandler.streamChat({
      ...baseArgs(),
      response,
      llmOptions: { temperature: 0.1, maxTokens: 512 },
    });
    expect(connector.streamGetChatCompletion.mock.calls[0][1]).toEqual({
      temperature: 0.1,
      user: null,
      maxTokens: 512,
    });
  });

  test("streamChat ohne llmOptions: Optionen wie bisher", async () => {
    const response = { write: jest.fn() };
    await ApiChatHandler.streamChat({ ...baseArgs(), response });
    expect(connector.streamGetChatCompletion.mock.calls[0][1]).toEqual({
      temperature: 1.0,
      user: null,
    });
  });

  test("streamChat (Stream deaktiviert) nutzt getChatCompletion mit Optionen", async () => {
    connector.streamingEnabled.mockReturnValue(false);
    const response = { write: jest.fn() };
    await ApiChatHandler.streamChat({
      ...baseArgs(),
      response,
      llmOptions: { chatTemplateKwargs: { enable_thinking: true } },
    });
    expect(connector.streamGetChatCompletion).not.toHaveBeenCalled();
    expect(connector.getChatCompletion.mock.calls[0][1]).toEqual({
      temperature: 1.0,
      user: null,
      chatTemplateKwargs: { enable_thinking: true },
    });
  });
});
