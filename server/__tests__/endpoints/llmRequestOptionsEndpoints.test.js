/* eslint-env jest, node */
// Endpunkt-Validierung der optionalen LLM-Optionen:
// - POST /v1/openai/chat/completions (Optionen flach im Body)
// - POST /v1/workspace/:slug/chat und /stream-chat (Optionen unter `llmOptions`)
// Die Routen werden an einer Fake-App registriert und direkt aufgerufen.

jest.mock("../../utils/prisma", () => ({}));
jest.mock("../../models/workspace", () => ({
  Workspace: { get: jest.fn() },
}));
jest.mock("../../models/telemetry", () => ({
  Telemetry: { sendTelemetry: jest.fn() },
}));
jest.mock("../../models/eventLogs", () => ({
  EventLogs: { logEvent: jest.fn() },
}));
jest.mock("../../utils/middleware/validApiKey", () => ({
  validApiKey: jest.fn(),
}));
jest.mock("../../utils/helpers", () => ({
  getLLMProvider: jest.fn(),
  getEmbeddingEngineSelection: jest.fn(),
  getVectorDbClass: jest.fn(),
  getMessageLimitInfo: jest.fn(),
}));
jest.mock("../../utils/chats/openaiCompatible", () => ({
  OpenAICompatibleChat: { chatSync: jest.fn(), streamChat: jest.fn() },
}));
jest.mock("../../utils/chats/apiChatHandler", () => ({
  ApiChatHandler: { chatSync: jest.fn(), streamChat: jest.fn() },
}));
jest.mock("../../endpoints/utils", () => ({
  getModelTag: jest.fn(() => "test-model"),
}));

const { Workspace } = require("../../models/workspace");
const helpers = require("../../utils/helpers");
const { OpenAICompatibleChat } = require("../../utils/chats/openaiCompatible");
const { ApiChatHandler } = require("../../utils/chats/apiChatHandler");
const { apiOpenAICompatibleEndpoints } = require("../../endpoints/api/openai");
const { apiWorkspaceEndpoints } = require("../../endpoints/api/workspace");

function collectRoutes(register) {
  const routes = {};
  const app = new Proxy(
    {},
    {
      get:
        (_target, method) =>
        (path, ...handlers) => {
          routes[`${String(method).toUpperCase()} ${path}`] =
            handlers[handlers.length - 1];
        },
    }
  );
  register(app);
  return routes;
}

function mockResponse() {
  const res = {
    statusCode: 200,
    body: undefined,
    headers: {},
    status: jest.fn(function (code) {
      res.statusCode = code;
      return res;
    }),
    json: jest.fn(function (body) {
      res.body = body;
      return res;
    }),
    end: jest.fn(() => res),
    sendStatus: jest.fn(() => res),
    setHeader: jest.fn((key, value) => {
      res.headers[key] = value;
    }),
    flushHeaders: jest.fn(),
    write: jest.fn(),
  };
  return res;
}

const openaiRoutes = collectRoutes(apiOpenAICompatibleEndpoints);
const workspaceRoutes = collectRoutes(apiWorkspaceEndpoints);
const openaiChat = openaiRoutes["POST /v1/openai/chat/completions"];
const workspaceChat = workspaceRoutes["POST /v1/workspace/:slug/chat"];
const workspaceStreamChat =
  workspaceRoutes["POST /v1/workspace/:slug/stream-chat"];

beforeAll(() => {
  jest.spyOn(console, "error").mockImplementation(() => {});
});

afterAll(() => {
  console.error.mockRestore();
});

beforeEach(() => {
  jest.clearAllMocks();
  Workspace.get.mockResolvedValue({
    id: 1,
    slug: "ws",
    name: "WS",
    openAiTemp: 1.0,
  });
  helpers.getMessageLimitInfo.mockResolvedValue({
    messageCount: 0,
    messagesLimit: null,
    contingent: "0/Unlimited",
  });
  OpenAICompatibleChat.chatSync.mockResolvedValue({ choices: [] });
  OpenAICompatibleChat.streamChat.mockResolvedValue();
  ApiChatHandler.chatSync.mockResolvedValue({ type: "textResponse" });
  ApiChatHandler.streamChat.mockResolvedValue();
});

test("Routen sind registriert", () => {
  expect(typeof openaiChat).toBe("function");
  expect(typeof workspaceChat).toBe("function");
  expect(typeof workspaceStreamChat).toBe("function");
});

describe("POST /v1/openai/chat/completions", () => {
  const messages = () => [{ role: "user", content: "Was ist 17*23?" }];

  async function call(body) {
    const res = mockResponse();
    await openaiChat(
      { body: { model: "ws", messages: messages(), ...body } },
      res
    );
    return res;
  }

  test("ohne neue Felder: llmOptions leer, Temperatur wie bisher", async () => {
    const res = await call({ temperature: 0.3 });
    expect(res.statusCode).toBe(200);
    const args = OpenAICompatibleChat.chatSync.mock.calls[0][0];
    expect(args.llmOptions).toEqual({});
    expect(args.temperature).toBe(0.3);
  });

  test("Temperatur-Fallback auf den Workspace bleibt wie bisher", async () => {
    await call({});
    expect(OpenAICompatibleChat.chatSync.mock.calls[0][0].temperature).toBe(
      1.0
    );
  });

  test("max_tokens: 4096 wird durchgereicht", async () => {
    await call({ max_tokens: 4096 });
    expect(OpenAICompatibleChat.chatSync.mock.calls[0][0].llmOptions).toEqual({
      maxTokens: 4096,
    });
  });

  test("chat_template_kwargs wird im Stream-Pfad durchgereicht", async () => {
    const res = await call({
      stream: true,
      chat_template_kwargs: { enable_thinking: true },
      top_p: 0.8,
    });
    expect(res.status).not.toHaveBeenCalledWith(400);
    expect(OpenAICompatibleChat.streamChat.mock.calls[0][0].llmOptions).toEqual(
      {
        chatTemplateKwargs: { enable_thinking: true },
        topP: 0.8,
      }
    );
  });

  test("null-Werte (OpenAI-Clients) gelten als nicht gesetzt", async () => {
    const res = await call({ max_tokens: null, top_p: null });
    expect(res.statusCode).toBe(200);
    expect(OpenAICompatibleChat.chatSync.mock.calls[0][0].llmOptions).toEqual(
      {}
    );
  });

  test.each([
    [
      "reasoning_effort: hoch",
      { reasoning_effort: "hoch" },
      /reasoning_effort must be one of: none, minimal, low, medium, high/,
    ],
    ["max_tokens: 0", { max_tokens: 0 }, /max_tokens must be an integer/],
    [
      "max_tokens als String",
      { max_tokens: "4096" },
      /max_tokens must be an integer/,
    ],
    ["top_p: 1.5", { top_p: 1.5 }, /top_p must be a number/],
    [
      "chat_template_kwargs mit 11 Schlüsseln",
      {
        chat_template_kwargs: Object.fromEntries(
          Array.from({ length: 11 }, (_, i) => [`k${i}`, true])
        ),
      },
      /at most 10 keys/,
    ],
    [
      "verschachteltes Objekt",
      { chat_template_kwargs: { a: { b: 1 } } },
      /chat_template_kwargs\.a must be/,
    ],
    [
      "Array-Wert",
      { chat_template_kwargs: { a: [true] } },
      /chat_template_kwargs\.a must be/,
    ],
    [
      "Funktions-Wert",
      { chat_template_kwargs: { a: () => 1 } },
      /chat_template_kwargs\.a must be/,
    ],
  ])("HTTP 400 bei %s", async (_label, extra, errorPattern) => {
    for (const stream of [false, true]) {
      jest.clearAllMocks();
      const res = await call({ ...extra, stream });
      expect(res.statusCode).toBe(400);
      expect(res.body).toEqual({
        id: expect.any(String),
        type: "abort",
        textResponse: null,
        sources: [],
        close: true,
        error: expect.stringMatching(errorPattern),
      });
      expect(OpenAICompatibleChat.chatSync).not.toHaveBeenCalled();
      expect(OpenAICompatibleChat.streamChat).not.toHaveBeenCalled();
      expect(res.flushHeaders).not.toHaveBeenCalled();
    }
  });
});

describe.each([
  [
    "POST /v1/workspace/:slug/chat",
    () => workspaceChat,
    () => ApiChatHandler.chatSync,
  ],
  [
    "POST /v1/workspace/:slug/stream-chat",
    () => workspaceStreamChat,
    () => ApiChatHandler.streamChat,
  ],
])("%s", (_route, getHandler, getChatFn) => {
  async function call(body) {
    const res = mockResponse();
    await getHandler()(
      {
        params: { slug: "ws" },
        body: { message: "Hallo", mode: "chat", ...body },
      },
      res
    );
    return res;
  }

  test("ohne llmOptions: Handler bekommt leere Optionen", async () => {
    const res = await call({});
    expect(res.status).not.toHaveBeenCalledWith(400);
    expect(getChatFn().mock.calls[0][0].llmOptions).toEqual({});
  });

  test("llmOptions werden validiert und normalisiert durchgereicht", async () => {
    await call({
      llmOptions: {
        max_tokens: 4096,
        temperature: 0.1,
        chat_template_kwargs: { enable_thinking: true },
        unbekannt: "wird ignoriert",
      },
    });
    expect(getChatFn().mock.calls[0][0].llmOptions).toEqual({
      maxTokens: 4096,
      temperature: 0.1,
      chatTemplateKwargs: { enable_thinking: true },
    });
  });

  test("flache Felder außerhalb von llmOptions werden wie bisher ignoriert", async () => {
    await call({ max_tokens: "egal", temperature: 99 });
    expect(getChatFn().mock.calls[0][0].llmOptions).toEqual({});
  });

  test.each([
    [
      "llmOptions kein Objekt",
      { llmOptions: "thinking" },
      /llmOptions must be a JSON object/,
    ],
    [
      "llmOptions als Array",
      { llmOptions: [1] },
      /llmOptions must be a JSON object/,
    ],
    [
      "temperature: 3",
      { llmOptions: { temperature: 3 } },
      /llmOptions\.temperature must be a number between 0 and 2/,
    ],
    [
      "reasoning_effort: hoch",
      { llmOptions: { reasoning_effort: "hoch" } },
      /llmOptions\.reasoning_effort must be one of: none, minimal, low, medium, high/,
    ],
    [
      "verschachtelte kwargs",
      { llmOptions: { chat_template_kwargs: { a: { b: 1 } } } },
      /llmOptions\.chat_template_kwargs\.a must be/,
    ],
  ])("HTTP 400 bei %s", async (_label, extra, errorPattern) => {
    const res = await call(extra);
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({
      id: expect.any(String),
      type: "abort",
      textResponse: null,
      sources: [],
      close: true,
      error: expect.stringMatching(errorPattern),
    });
    expect(getChatFn()).not.toHaveBeenCalled();
    expect(res.flushHeaders).not.toHaveBeenCalled();
  });

  test("bestehende Validierung (leere Nachricht) hat weiterhin Vorrang", async () => {
    const res = await call({ message: "", llmOptions: { temperature: 3 } });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe("Message is empty");
  });
});
