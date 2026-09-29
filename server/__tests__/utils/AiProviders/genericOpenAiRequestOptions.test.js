/* eslint-env jest, node */
// Provider-Body-Aufbau des generischen OpenAI-Providers mit optionalen
// Anfrage-Optionen (max_tokens, top_p, reasoning_effort, chat_template_kwargs).
// Der openai-Client wird gemockt; geprüft wird exakt der Body, der an
// `chat.completions.create` übergeben wird.

// Kein Netzwerkzugriff auf die Remote-Model-Map (wird vom openAi-Provider geladen).
jest.mock("../../../utils/AiProviders/modelMap", () => ({
  MODEL_MAP: { get: () => 128_000 },
}));

const ENV_KEYS = [
  "GENERIC_OPEN_AI_BASE_PATH",
  "GENERIC_OPEN_AI_MODEL_PREF",
  "GENERIC_OPEN_AI_MAX_TOKENS",
  "GENERIC_OPEN_AI_API_KEY",
  "OPEN_AI_KEY",
];
const savedEnv = {};

const fakeEmbedder = {
  embedTextInput: jest.fn(),
  embedChunks: jest.fn(),
};

// Provider-fertige Optionen, wie parseLLMRequestOptions sie liefert.
const EXTRA_OPTIONS = {
  max_tokens: 4096,
  top_p: 0.9,
  reasoning_effort: "high",
  chat_template_kwargs: { enable_thinking: true },
};

function makeGenericProvider() {
  const {
    GenericOpenAiLLM,
  } = require("../../../utils/AiProviders/genericOpenAi");
  const llm = new GenericOpenAiLLM(fakeEmbedder);
  const create = jest.fn((body) => {
    if (body.stream)
      return Promise.resolve({ [Symbol.asyncIterator]: async function* () {} });
    return Promise.resolve({
      choices: [{ message: { content: "391" } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
  });
  llm.openai = { chat: { completions: { create } } };
  return { llm, create };
}

const messages = [{ role: "user", content: "Was ist 17*23?" }];

beforeAll(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  jest.spyOn(console, "log").mockImplementation(() => {});
});

afterAll(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  console.log.mockRestore();
});

beforeEach(() => {
  process.env.GENERIC_OPEN_AI_BASE_PATH = "http://litellm.invalid/v1";
  process.env.GENERIC_OPEN_AI_MODEL_PREF = "Chat1";
  process.env.GENERIC_OPEN_AI_MAX_TOKENS = "2048";
  process.env.GENERIC_OPEN_AI_API_KEY = "test-key";
});

describe("GenericOpenAiLLM – Anfrage-Optionen im Provider-Body", () => {
  describe("getChatCompletion (Nicht-Stream)", () => {
    test("ohne Optionen: Body exakt wie bisher", async () => {
      const { llm, create } = makeGenericProvider();
      await llm.getChatCompletion(messages, { temperature: 0.3 });
      expect(create).toHaveBeenCalledTimes(1);
      const body = create.mock.calls[0][0];
      expect(JSON.stringify(body)).toBe(
        JSON.stringify({
          model: "Chat1",
          messages,
          temperature: 0.3,
          max_tokens: 2048,
        })
      );
      // kein zweites Argument (keine Request-Options-Overrides)
      expect(create.mock.calls[0].length).toBe(1);
    });

    test("ohne Optionen mit user-Feld (API-Handler): Body exakt wie bisher", async () => {
      const { llm, create } = makeGenericProvider();
      await llm.getChatCompletion(messages, { temperature: 0.7, user: null });
      expect(Object.keys(create.mock.calls[0][0])).toEqual([
        "model",
        "messages",
        "temperature",
        "max_tokens",
      ]);
    });

    test("mit allen Optionen: gesetzte Felder erscheinen im Body", async () => {
      const { llm, create } = makeGenericProvider();
      await llm.getChatCompletion(messages, {
        temperature: 0.1,
        ...EXTRA_OPTIONS,
      });
      expect(create.mock.calls[0][0]).toEqual({
        model: "Chat1",
        messages,
        temperature: 0.1,
        max_tokens: 4096,
        top_p: 0.9,
        reasoning_effort: "high",
        chat_template_kwargs: { enable_thinking: true },
      });
    });

    test("max_tokens aus der Anfrage überschreibt ENV, sonst ENV-Wert", async () => {
      const { llm, create } = makeGenericProvider();
      await llm.getChatCompletion(messages, {
        temperature: 0.7,
        max_tokens: 4096,
      });
      await llm.getChatCompletion(messages, { temperature: 0.7 });
      expect(create.mock.calls[0][0].max_tokens).toBe(4096);
      expect(create.mock.calls[1][0].max_tokens).toBe(2048);
    });

    test("nur chat_template_kwargs: genau dieses Objekt, sonst nichts Neues", async () => {
      const { llm, create } = makeGenericProvider();
      await llm.getChatCompletion(messages, {
        temperature: 0.7,
        chat_template_kwargs: { enable_thinking: true },
      });
      const body = create.mock.calls[0][0];
      expect(body.chat_template_kwargs).toEqual({ enable_thinking: true });
      expect(Object.keys(body)).toEqual([
        "model",
        "messages",
        "temperature",
        "max_tokens",
        "chat_template_kwargs",
      ]);
    });

    test("reasoning_content wird weiterhin als <think> vorangestellt", async () => {
      const { llm, create } = makeGenericProvider();
      create.mockResolvedValueOnce({
        choices: [{ message: { content: "391", reasoning_content: "17*23" } }],
        usage: {},
      });
      const result = await llm.getChatCompletion(messages, {
        temperature: 0.7,
        chat_template_kwargs: { enable_thinking: true },
      });
      expect(result.textResponse).toBe("<think>17*23</think>391");
    });

    test("nur reasoning_content, content null (Thinking abgeschnitten): kein 'null'", async () => {
      const { llm, create } = makeGenericProvider();
      create.mockResolvedValueOnce({
        choices: [
          {
            finish_reason: "length",
            message: { content: null, reasoning_content: "17*20=340, 17*3" },
          },
        ],
        usage: {},
      });
      const result = await llm.getChatCompletion(messages, {
        temperature: 0.7,
        max_tokens: 20,
        chat_template_kwargs: { enable_thinking: true },
      });
      expect(result.textResponse).toBe("<think>17*20=340, 17*3</think>");
      expect(result.textResponse.endsWith("</think>")).toBe(true);
      expect(result.textResponse).not.toContain("null");
    });

    test("ohne reasoning_content bleibt content null wie bisher", async () => {
      const { llm, create } = makeGenericProvider();
      create.mockResolvedValueOnce({
        choices: [{ message: { content: null } }],
        usage: {},
      });
      const result = await llm.getChatCompletion(messages, {
        temperature: 0.7,
      });
      expect(result.textResponse).toBeNull();
    });

    test("user und unbekannte Optionen landen nicht im Body", async () => {
      const { llm, create } = makeGenericProvider();
      await llm.getChatCompletion(messages, {
        temperature: 0.7,
        user: { id: 1, username: "admin" },
        maxTokens: 5,
        foo: "bar",
      });
      expect(Object.keys(create.mock.calls[0][0])).toEqual([
        "model",
        "messages",
        "temperature",
        "max_tokens",
      ]);
      expect(create.mock.calls[0][0].max_tokens).toBe(2048);
    });
    test("prompt_tokens_details wird unverändert in die Metriken übernommen", async () => {
      const { llm, create } = makeGenericProvider();
      create.mockResolvedValueOnce({
        choices: [{ message: { content: "391" } }],
        usage: {
          prompt_tokens: 1200,
          completion_tokens: 3,
          total_tokens: 1203,
          prompt_tokens_details: { cached_tokens: 1024 },
        },
      });
      const { metrics } = await llm.getChatCompletion(messages, {});
      expect(metrics.prompt_tokens_details).toEqual({ cached_tokens: 1024 });
      expect(metrics.prompt_tokens).toBe(1200);
    });

    test("ohne prompt_tokens_details (oder null) keine neue Metrik", async () => {
      const { llm, create } = makeGenericProvider();
      let { metrics } = await llm.getChatCompletion(messages, {});
      expect(metrics).not.toHaveProperty("prompt_tokens_details");
      create.mockResolvedValueOnce({
        choices: [{ message: { content: "391" } }],
        usage: { prompt_tokens: 1, prompt_tokens_details: null },
      });
      ({ metrics } = await llm.getChatCompletion(messages, {}));
      expect(metrics).not.toHaveProperty("prompt_tokens_details");
    });
  });

  describe("streamGetChatCompletion (Stream)", () => {
    test("ohne Optionen: Body exakt wie bisher", async () => {
      const { llm, create } = makeGenericProvider();
      await llm.streamGetChatCompletion(messages, { temperature: 0.3 });
      expect(JSON.stringify(create.mock.calls[0][0])).toBe(
        JSON.stringify({
          model: "Chat1",
          stream: true,
          messages,
          temperature: 0.3,
          max_tokens: 2048,
        })
      );
      expect(create.mock.calls[0].length).toBe(1);
    });

    test("mit allen Optionen: gesetzte Felder erscheinen im Body", async () => {
      const { llm, create } = makeGenericProvider();
      await llm.streamGetChatCompletion(messages, {
        temperature: 0.1,
        user: null,
        ...EXTRA_OPTIONS,
      });
      expect(create.mock.calls[0][0]).toEqual({
        model: "Chat1",
        stream: true,
        messages,
        temperature: 0.1,
        max_tokens: 4096,
        top_p: 0.9,
        reasoning_effort: "high",
        chat_template_kwargs: { enable_thinking: true },
      });
    });

    test("ohne max_tokens-Option gilt der ENV-Wert", async () => {
      const { llm, create } = makeGenericProvider();
      await llm.streamGetChatCompletion(messages, {
        temperature: 0.7,
        top_p: 0.5,
      });
      const body = create.mock.calls[0][0];
      expect(body.max_tokens).toBe(2048);
      expect(body.top_p).toBe(0.5);
      expect(body).not.toHaveProperty("reasoning_effort");
      expect(body).not.toHaveProperty("chat_template_kwargs");
    });
  });

  describe("handleStream", () => {
    function fakeResponse() {
      const { EventEmitter } = require("events");
      const res = new EventEmitter();
      res.write = jest.fn();
      return res;
    }
    function fakeStream(chunks) {
      return {
        endMeasurement: jest.fn(),
        [Symbol.asyncIterator]: async function* () {
          for (const chunk of chunks) yield chunk;
        },
      };
    }
    function written(res) {
      return res.write.mock.calls.map(([raw]) =>
        JSON.parse(String(raw).slice("data: ".length))
      );
    }
    const reasoningChunk = (text, finish_reason = null) => ({
      choices: [{ delta: { reasoning_content: text }, finish_reason }],
    });

    test("nur Reasoning + finish_reason length: <think>…</think> wird zurückgegeben", async () => {
      const { llm } = makeGenericProvider();
      const res = fakeResponse();
      const stream = fakeStream([
        reasoningChunk("17*20"),
        reasoningChunk("=340, "),
        reasoningChunk("17*3", "length"),
      ]);
      const text = await llm.handleStream(res, stream, { uuid: "u1" });
      expect(text).toBe("<think>17*20=340, 17*3</think>");
      const events = written(res);
      const streamed = events.map((e) => e.textResponse).join("");
      expect(streamed).toBe("<think>17*20=340, 17*3</think>");
      // </think> kommt vor dem close-Chunk, genau ein close-Chunk
      expect(events[events.length - 1]).toMatchObject({
        close: true,
        textResponse: "",
      });
      expect(events.filter((e) => e.close)).toHaveLength(1);
      expect(stream.endMeasurement).toHaveBeenCalledTimes(1);
    });

    test("nur Reasoning, Stream endet ohne finish_reason: trotzdem abgeschlossen", async () => {
      const { llm } = makeGenericProvider();
      const res = fakeResponse();
      const stream = fakeStream([reasoningChunk("denke"), reasoningChunk("…")]);
      const text = await llm.handleStream(res, stream, { uuid: "u2" });
      expect(text).toBe("<think>denke…</think>");
      const events = written(res);
      expect(events.filter((e) => e.close)).toHaveLength(1);
      expect(stream.endMeasurement).toHaveBeenCalledTimes(1);
    });

    test("Reasoning gefolgt von Content: unverändert wie bisher", async () => {
      const { llm } = makeGenericProvider();
      const res = fakeResponse();
      const stream = fakeStream([
        reasoningChunk("17*23"),
        { choices: [{ delta: { content: "39" }, finish_reason: null }] },
        { choices: [{ delta: { content: "1" }, finish_reason: "stop" }] },
      ]);
      const text = await llm.handleStream(res, stream, { uuid: "u3" });
      expect(text).toBe("<think>17*23</think>391");
      const streamed = written(res)
        .map((e) => e.textResponse)
        .join("");
      expect(streamed).toBe("<think>17*23</think>391");
      expect(
        written(res).filter((e) => e.textResponse === "</think>")
      ).toHaveLength(1);
    });

    test("ohne Reasoning: unverändert wie bisher", async () => {
      const { llm } = makeGenericProvider();
      const res = fakeResponse();
      const stream = fakeStream([
        { choices: [{ delta: { content: "391" }, finish_reason: "stop" }] },
      ]);
      const text = await llm.handleStream(res, stream, { uuid: "u4" });
      expect(text).toBe("391");
      expect(written(res).map((e) => e.textResponse)).toEqual(["391", ""]);
    });

    test("Chunk mit reasoning_content UND content: </think> vor dem Content", async () => {
      const { llm } = makeGenericProvider();
      const res = fakeResponse();
      const stream = fakeStream([
        reasoningChunk("17*23"),
        {
          choices: [
            {
              delta: { reasoning_content: " = 391", content: "39" },
              finish_reason: null,
            },
          ],
        },
        { choices: [{ delta: { content: "1" }, finish_reason: "stop" }] },
      ]);
      const text = await llm.handleStream(res, stream, { uuid: "u5" });
      expect(text).toBe("<think>17*23 = 391</think>391");
      const events = written(res);
      expect(events.map((e) => e.textResponse)).toEqual([
        "<think>17*23",
        " = 391",
        "</think>",
        "39",
        "1",
        "",
      ]);
      expect(events.filter((e) => e.textResponse === "</think>")).toHaveLength(
        1
      );
    });

    test("erster Chunk mit reasoning_content UND content: nichts geht verloren", async () => {
      const { llm } = makeGenericProvider();
      const res = fakeResponse();
      const stream = fakeStream([
        {
          choices: [
            {
              delta: { reasoning_content: "kurz", content: "391" },
              finish_reason: "stop",
            },
          ],
        },
      ]);
      const text = await llm.handleStream(res, stream, { uuid: "u6" });
      expect(text).toBe("<think>kurz</think>391");
      expect(written(res).map((e) => e.textResponse)).toEqual([
        "<think>kurz",
        "</think>",
        "391",
        "",
      ]);
    });

    describe("Fehler beim Abschluss", () => {
      beforeEach(() => {
        jest.spyOn(console, "error").mockImplementation(() => {});
      });
      afterEach(() => {
        console.error.mockRestore();
      });

      test("endMeasurement wirft: Promise löst trotzdem auf, Fehler geloggt", async () => {
        const { llm } = makeGenericProvider();
        const res = fakeResponse();
        const stream = fakeStream([
          { choices: [{ delta: { content: "391" }, finish_reason: "stop" }] },
        ]);
        stream.endMeasurement.mockImplementation(() => {
          throw new Error("measure kaputt");
        });
        const text = await llm.handleStream(res, stream, { uuid: "u7" });
        expect(text).toBe("391");
        expect(stream.endMeasurement).toHaveBeenCalledTimes(1);
        expect(console.error).toHaveBeenCalledWith(
          expect.stringContaining("measure kaputt")
        );
        // Abbruch-Listener ist trotz Fehler entfernt bzw. wirkungslos
        res.emit("close");
        expect(stream.endMeasurement).toHaveBeenCalledTimes(1);
      });

      test("Schreiben des close-Chunks wirft: Promise löst mit vollem Text auf", async () => {
        const { llm } = makeGenericProvider();
        const res = fakeResponse();
        res.write.mockImplementation((raw) => {
          if (String(raw).includes('"close":true'))
            throw new Error("socket zu");
        });
        const stream = fakeStream([reasoningChunk("denke", "length")]);
        const text = await llm.handleStream(res, stream, { uuid: "u8" });
        expect(text).toBe("<think>denke</think>");
        expect(stream.endMeasurement).toHaveBeenCalledTimes(1);
        expect(console.error).toHaveBeenCalledWith(
          expect.stringContaining("socket zu")
        );
      });

      test("Fehler im Stream nach Abschluss: kein Hängen, kein zweites Ende", async () => {
        const { llm } = makeGenericProvider();
        const res = fakeResponse();
        const stream = {
          endMeasurement: jest.fn(),
          [Symbol.asyncIterator]: async function* () {
            yield {
              choices: [{ delta: { content: "39" }, finish_reason: null }],
            };
            res.emit("close"); // Client bricht ab
            throw new Error("Verbindung weg");
          },
        };
        const text = await llm.handleStream(res, stream, { uuid: "u9" });
        expect(text).toBe("39");
        expect(stream.endMeasurement).toHaveBeenCalledTimes(1);
      });
    });

    test("prompt_tokens_details aus dem letzten usage-Chunk landet in den Metriken", async () => {
      const { llm } = makeGenericProvider();
      const res = fakeResponse();
      const stream = fakeStream([
        { choices: [{ delta: { content: "391" }, finish_reason: null }] },
        {
          choices: [{ delta: {}, finish_reason: "stop" }],
          usage: {
            prompt_tokens: 1200,
            completion_tokens: 3,
            total_tokens: 1203,
            prompt_tokens_details: { cached_tokens: 1024 },
          },
        },
      ]);
      await llm.handleStream(res, stream, { uuid: "u10" });
      expect(stream.endMeasurement).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt_tokens: 1200,
          completion_tokens: 3,
          prompt_tokens_details: { cached_tokens: 1024 },
        })
      );
    });

    test("ohne prompt_tokens_details (oder null) kein neues Feld", async () => {
      const { llm } = makeGenericProvider();
      const res = fakeResponse();
      const stream = fakeStream([
        {
          choices: [{ delta: { content: "391" }, finish_reason: "stop" }],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 1,
            prompt_tokens_details: null,
          },
        },
      ]);
      await llm.handleStream(res, stream, { uuid: "u11" });
      expect(stream.endMeasurement.mock.calls[0][0]).toEqual({
        prompt_tokens: 10,
        completion_tokens: 1,
      });
    });
  });

  test("openai-SDK serialisiert unbekannte Body-Felder unverändert", async () => {
    const { OpenAI } = require("openai");
    let sentBody = null;
    const client = new OpenAI({
      apiKey: "x",
      baseURL: "http://litellm.invalid/v1",
      maxRetries: 0,
      fetch: async (_url, init) => {
        sentBody = JSON.parse(init.body);
        return new Response(
          JSON.stringify({
            id: "a",
            choices: [{ message: { content: "ok" } }],
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      },
    });
    await client.chat.completions.create({
      model: "Chat1",
      messages,
      chat_template_kwargs: { enable_thinking: true },
      reasoning_effort: "high",
    });
    expect(sentBody.chat_template_kwargs).toEqual({ enable_thinking: true });
    expect(sentBody.reasoning_effort).toBe("high");
  });
});

describe("Andere Provider ignorieren die zusätzlichen Optionen", () => {
  test("OpenAiLLM: Body unverändert, kein Fehler", async () => {
    process.env.OPEN_AI_KEY = "sk-test";
    const { OpenAiLLM } = require("../../../utils/AiProviders/openAi");
    const llm = new OpenAiLLM(fakeEmbedder, "gpt-4o");
    llm.isValidChatCompletionModel = async () => true;
    const create = jest.fn().mockResolvedValue({
      output_text: "ok",
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    });
    llm.openai = { responses: { create } };

    const withOptions = await llm.getChatCompletion(messages, {
      temperature: 0.2,
      user: null,
      ...EXTRA_OPTIONS,
    });
    const withoutOptions = await llm.getChatCompletion(messages, {
      temperature: 0.2,
    });
    expect(withOptions.textResponse).toBe("ok");
    expect(withoutOptions.textResponse).toBe("ok");
    expect(create.mock.calls[0][0]).toEqual(create.mock.calls[1][0]);
    for (const key of [
      "max_tokens",
      "top_p",
      "reasoning_effort",
      "chat_template_kwargs",
    ])
      expect(create.mock.calls[0][0]).not.toHaveProperty(key);
  });
});
