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
        max_tokens: 4096,
        chat_template_kwargs: { enable_thinking: true },
      },
    });
    expect(connector.getChatCompletion.mock.calls[0][1]).toEqual({
      temperature: 0.7,
      max_tokens: 4096,
      chat_template_kwargs: { enable_thinking: true },
    });
  });

  test("streamChat reicht Optionen an den Connector durch", async () => {
    const response = { write: jest.fn(), status: jest.fn() };
    await OpenAICompatibleChat.streamChat({
      ...baseArgs(),
      response,
      llmOptions: { top_p: 0.5, reasoning_effort: "high" },
    });
    expect(connector.streamGetChatCompletion.mock.calls[0][1]).toEqual({
      temperature: 0.7,
      top_p: 0.5,
      reasoning_effort: "high",
    });
  });

  test("streamChat ohne Optionen: Connector-Optionen exakt wie bisher", async () => {
    const response = { write: jest.fn(), status: jest.fn() };
    await OpenAICompatibleChat.streamChat({ ...baseArgs(), response });
    expect(
      Object.keys(connector.streamGetChatCompletion.mock.calls[0][1])
    ).toEqual(["temperature"]);
  });

  describe("usage.prompt_tokens_details in der API-Antwort", () => {
    const details = { cached_tokens: 1024 };

    test("chatSync: prompt_tokens_details aus den Metriken erscheint unter usage", async () => {
      connector.getChatCompletion.mockResolvedValue({
        textResponse: "391",
        metrics: { prompt_tokens: 1200, prompt_tokens_details: details },
      });
      const result = await OpenAICompatibleChat.chatSync(baseArgs());
      expect(result.usage.prompt_tokens_details).toEqual(details);
    });

    test("chatSync ohne prompt_tokens_details: usage unverändert", async () => {
      connector.getChatCompletion.mockResolvedValue({
        textResponse: "391",
        metrics: { prompt_tokens: 12 },
      });
      const result = await OpenAICompatibleChat.chatSync(baseArgs());
      expect(result.usage).toEqual({ prompt_tokens: 12 });
    });

    test("streamChat: prompt_tokens_details erscheint im Abschluss-Chunk", async () => {
      const stream = { metrics: {} };
      connector.streamGetChatCompletion.mockResolvedValue(stream);
      connector.handleStream.mockImplementation(async () => {
        // wie endMeasurement(usage) im GenericOpenAiLLM
        stream.metrics = {
          prompt_tokens: 1200,
          prompt_tokens_details: details,
        };
        return "391";
      });
      const response = { write: jest.fn(), status: jest.fn() };
      await OpenAICompatibleChat.streamChat({ ...baseArgs(), response });
      const final = writtenEvents(response).pop();
      expect(final.usage.prompt_tokens_details).toEqual(details);
    });
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
        llmOptions: { max_tokens: 100 },
      });
      const message = result.choices[0].message;
      expect(message.content).toBe("<think>17*20=340, 17*3=51</think>391");
      expect(message).not.toHaveProperty("reasoning_content");
    });

    test("mit chat_template_kwargs: reasoning_content getrennt, DB unverändert", async () => {
      const result = await OpenAICompatibleChat.chatSync({
        ...baseArgs(),
        llmOptions: { chat_template_kwargs: { enable_thinking: true } },
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

    test.each([
      [
        "enable_thinking: false",
        { chat_template_kwargs: { enable_thinking: false } },
      ],
      ["leere kwargs", { chat_template_kwargs: {} }],
      ["reasoning_effort: none", { reasoning_effort: "none" }],
    ])(
      "%s: Antwortform unverändert (kein reasoning_content)",
      async (_label, llmOptions) => {
        const result = await OpenAICompatibleChat.chatSync({
          ...baseArgs(),
          llmOptions,
        });
        const message = result.choices[0].message;
        expect(message.content).toBe("<think>17*20=340, 17*3=51</think>391");
        expect(message).not.toHaveProperty("reasoning_content");
      }
    );

    test("mit reasoning_effort low: reasoning_content getrennt", async () => {
      const result = await OpenAICompatibleChat.chatSync({
        ...baseArgs(),
        llmOptions: { reasoning_effort: "low" },
      });
      expect(result.choices[0].message.content).toBe("391");
      expect(result.choices[0].message.reasoning_content).toBe(
        "17*20=340, 17*3=51"
      );
    });

    test("nur Reasoning (abgeschnitten): content leer, reasoning_content gefüllt, gespeichert", async () => {
      connector.getChatCompletion.mockResolvedValue({
        textResponse: "<think>17*20=340, 17*3</think>",
        metrics: {},
      });
      const result = await OpenAICompatibleChat.chatSync({
        ...baseArgs(),
        llmOptions: { chat_template_kwargs: { enable_thinking: true } },
      });
      expect(result.choices[0].message.content).toBe("");
      expect(result.choices[0].message.reasoning_content).toBe(
        "17*20=340, 17*3"
      );
      expect(WorkspaceChats.new).toHaveBeenCalledWith(
        expect.objectContaining({
          response: expect.objectContaining({
            text: "<think>17*20=340, 17*3</think>",
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
        llmOptions: { reasoning_effort: "high" },
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

    test("mit enable_thinking: false: delta.content wie bisher", async () => {
      const events = await runStream({
        chat_template_kwargs: { enable_thinking: false },
      });
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
        chat_template_kwargs: { enable_thinking: true },
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
        max_tokens: 4096,
        top_p: 0.9,
        reasoning_effort: "low",
        chat_template_kwargs: { enable_thinking: true },
      },
    });
    expect(connector.getChatCompletion.mock.calls[0][1]).toEqual({
      temperature: 1.0,
      user: null,
      max_tokens: 4096,
      top_p: 0.9,
      reasoning_effort: "low",
      chat_template_kwargs: { enable_thinking: true },
    });
  });

  test("streamChat (Stream aktiv) reicht Optionen durch", async () => {
    const response = { write: jest.fn() };
    await ApiChatHandler.streamChat({
      ...baseArgs(),
      response,
      llmOptions: { temperature: 0.1, max_tokens: 512 },
    });
    expect(connector.streamGetChatCompletion.mock.calls[0][1]).toEqual({
      temperature: 0.1,
      user: null,
      max_tokens: 512,
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
      llmOptions: { chat_template_kwargs: { enable_thinking: true } },
    });
    expect(connector.streamGetChatCompletion).not.toHaveBeenCalled();
    expect(connector.getChatCompletion.mock.calls[0][1]).toEqual({
      temperature: 1.0,
      user: null,
      chat_template_kwargs: { enable_thinking: true },
    });
  });
});
