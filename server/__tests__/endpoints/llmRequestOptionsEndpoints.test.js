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

const ENV_KEYS = [
  "LLM_REQUEST_MAX_TOKENS_CEILING",
  "LLM_CHAT_TEMPLATE_KWARGS_ALLOWLIST",
];
const savedEnv = {};

beforeAll(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  jest.spyOn(console, "error").mockImplementation(() => {});
});

afterAll(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  console.error.mockRestore();
});

beforeEach(() => {
  jest.clearAllMocks();
  for (const key of ENV_KEYS) delete process.env[key];
  // Provider des Workspaces: Kontextfenster 131072 (-> max_tokens-Obergrenze)
  helpers.getLLMProvider.mockReturnValue({ promptWindowLimit: () => 131072 });
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
      max_tokens: 4096,
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
        chat_template_kwargs: { enable_thinking: true },
        top_p: 0.8,
      }
    );
  });

  test("null-Werte (OpenAI-Clients) gelten als nicht gesetzt", async () => {
    const res = await call({
      max_tokens: null,
      top_p: null,
      temperature: null,
    });
    expect(res.statusCode).toBe(200);
    const args = OpenAICompatibleChat.chatSync.mock.calls[0][0];
    expect(args.llmOptions).toEqual({});
    expect(args.temperature).toBe(1.0);
  });

  test("Altclients: Zahlen als String werden umgewandelt, max_tokens 0 = nicht gesetzt", async () => {
    await call({ max_tokens: "4096", top_p: "0.5", temperature: "0.3" });
    let args = OpenAICompatibleChat.chatSync.mock.calls[0][0];
    expect(args.llmOptions).toEqual({ max_tokens: 4096, top_p: 0.5 });
    expect(args.temperature).toBe(0.3);

    jest.clearAllMocks();
    const res = await call({ max_tokens: 0 });
    expect(res.statusCode).toBe(200);
    expect(OpenAICompatibleChat.chatSync.mock.calls[0][0].llmOptions).toEqual(
      {}
    );
  });

  test("temperature aus der Anfrage wird nicht zusätzlich in llmOptions gereicht", async () => {
    await call({ temperature: 0, stream: true });
    const args = OpenAICompatibleChat.streamChat.mock.calls[0][0];
    expect(args.temperature).toBe(0);
    expect(args.llmOptions).toEqual({});
  });

  test("max_tokens-Obergrenze = Kontextfenster des Workspace-Providers", async () => {
    helpers.getLLMProvider.mockReturnValue({ promptWindowLimit: () => 8192 });
    let res = await call({ max_tokens: 8192 });
    expect(res.statusCode).toBe(200);
    jest.clearAllMocks();
    res = await call({ max_tokens: 8193 });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe(
      "max_tokens must be an integer between 1 and 8192."
    );
  });

  test("max_tokens-Obergrenze per ENV LLM_REQUEST_MAX_TOKENS_CEILING", async () => {
    process.env.LLM_REQUEST_MAX_TOKENS_CEILING = "2048";
    const res = await call({ max_tokens: 4096 });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe(
      "max_tokens must be an integer between 1 and 2048."
    );
    expect(OpenAICompatibleChat.chatSync).not.toHaveBeenCalled();
  });

  test("unbekannter Workspace bleibt 401 (vor der Options-Prüfung)", async () => {
    Workspace.get.mockResolvedValue(null);
    const res = await call({ top_p: 5 });
    expect(res.statusCode).toBe(401);
  });

  test.each([
    [
      "reasoning_effort: hoch",
      { reasoning_effort: "hoch" },
      /reasoning_effort must be one of: none, minimal, low, medium, high/,
    ],
    [
      "reasoning_effort: auto",
      { reasoning_effort: "auto" },
      /reasoning_effort must be one of/,
    ],
    ["max_tokens: -1", { max_tokens: -1 }, /max_tokens must be an integer/],
    [
      "max_tokens über dem Kontextfenster",
      { max_tokens: 131073 },
      /max_tokens must be an integer between 1 and 131072/,
    ],
    [
      "max_tokens nicht numerisch",
      { max_tokens: "viel" },
      /max_tokens must be an integer/,
    ],
    ["top_p: 1.5", { top_p: 1.5 }, /top_p must be a number/],
    [
      "temperature: hot",
      { temperature: "hot" },
      /^temperature must be a number between 0 and 2/,
    ],
    [
      "temperature: 3",
      { temperature: 3 },
      /^temperature must be a number between 0 and 2/,
    ],
    [
      "nicht erlaubter kwargs-Schlüssel chat_template",
      { chat_template_kwargs: { chat_template: "{{ evil }}" } },
      /chat_template_kwargs contains the key "chat_template", which is not allowed/,
    ],
    [
      "nicht erlaubter kwargs-Schlüssel add_generation_prompt",
      {
        chat_template_kwargs: {
          enable_thinking: true,
          add_generation_prompt: false,
        },
      },
      /contains the key "add_generation_prompt", which is not allowed/,
    ],
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
      { chat_template_kwargs: { enable_thinking: { b: 1 } } },
      /chat_template_kwargs\.enable_thinking must be/,
    ],
    [
      "Array-Wert",
      { chat_template_kwargs: { enable_thinking: [true] } },
      /chat_template_kwargs\.enable_thinking must be/,
    ],
    [
      "Funktions-Wert",
      { chat_template_kwargs: { enable_thinking: () => 1 } },
      /chat_template_kwargs\.enable_thinking must be/,
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
      max_tokens: 4096,
      temperature: 0.1,
      chat_template_kwargs: { enable_thinking: true },
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
      { llmOptions: { chat_template_kwargs: { enable_thinking: { b: 1 } } } },
      /llmOptions\.chat_template_kwargs\.enable_thinking must be/,
    ],
    [
      "nicht erlaubter kwargs-Schlüssel",
      { llmOptions: { chat_template_kwargs: { tools: "x" } } },
      /llmOptions\.chat_template_kwargs contains the key "tools", which is not allowed\. Allowed keys: enable_thinking\./,
    ],
    [
      "max_tokens über dem Kontextfenster",
      { llmOptions: { max_tokens: 131073 } },
      /llmOptions\.max_tokens must be an integer between 1 and 131072/,
    ],
    // Strikt: keine Koerzierung am workspace-Endpunkt
    [
      "max_tokens als String",
      { llmOptions: { max_tokens: "4096" } },
      /llmOptions\.max_tokens must be an integer/,
    ],
    [
      "max_tokens: 0",
      { llmOptions: { max_tokens: 0 } },
      /llmOptions\.max_tokens must be an integer/,
    ],
    [
      "temperature als String",
      { llmOptions: { temperature: "0.5" } },
      /llmOptions\.temperature must be a number between 0 and 2/,
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

  test("ENV-Whitelist erlaubt zusätzliche kwargs-Schlüssel", async () => {
    process.env.LLM_CHAT_TEMPLATE_KWARGS_ALLOWLIST = "thinking_budget";
    const res = await call({
      llmOptions: { chat_template_kwargs: { thinking_budget: 256 } },
    });
    expect(res.status).not.toHaveBeenCalledWith(400);
    expect(getChatFn().mock.calls[0][0].llmOptions).toEqual({
      chat_template_kwargs: { thinking_budget: 256 },
    });
  });

  test("bestehende Validierung (leere Nachricht) hat weiterhin Vorrang", async () => {
    const res = await call({ message: "", llmOptions: { temperature: 3 } });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe("Message is empty");
  });
});
