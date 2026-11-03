/* eslint-env jest, node */
// Thinking-Schalter per Umgebungsvariable GENERIC_OPEN_AI_ENABLE_THINKING
// (Spezifikation issues/thinking-schalter-generic-openai.md, AK-1 bis AK-3,
// NAK-1 bis NAK-3). Der openai-Client wird gemockt; geprüft wird exakt der
// Body, der an `chat.completions.create` übergeben wird.

// Kein Netzwerkzugriff auf die Remote-Model-Map (wird vom openAi-Provider geladen).
jest.mock("../../../utils/AiProviders/modelMap", () => ({
  MODEL_MAP: { get: () => 128_000 },
}));

const ENV_KEYS = [
  "GENERIC_OPEN_AI_BASE_PATH",
  "GENERIC_OPEN_AI_MODEL_PREF",
  "GENERIC_OPEN_AI_MAX_TOKENS",
  "GENERIC_OPEN_AI_API_KEY",
  "GENERIC_OPEN_AI_ENABLE_THINKING",
  "OPEN_AI_KEY",
  "LITE_LLM_BASE_PATH",
  "LITE_LLM_MODEL_PREF",
  "LITE_LLM_API_KEY",
];
const savedEnv = {};

const fakeEmbedder = {
  embedTextInput: jest.fn(),
  embedChunks: jest.fn(),
};

const messages = [{ role: "user", content: "Wann beginnt der Kurs?" }];

// Body ohne Schalter, wie vor der Änderung (Reihenfolge der Schlüssel zählt
// für den Prompt-Cache-Präfix nicht, wird aber trotzdem exakt geprüft).
const PLAIN_BODY = {
  model: "Chat1",
  messages,
  temperature: 0.3,
  max_tokens: 2048,
};
const PLAIN_STREAM_BODY = {
  model: "Chat1",
  stream: true,
  messages,
  temperature: 0.3,
  max_tokens: 2048,
};

/** Gemockter openai-Client (chat.completions) für Provider auf Chat-Completions-Basis. */
function mockChatCompletions(llm) {
  const create = jest.fn((body) => {
    if (body.stream)
      return Promise.resolve({ [Symbol.asyncIterator]: async function* () {} });
    return Promise.resolve({
      choices: [{ message: { content: "Am Montag." } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
  });
  llm.openai = { chat: { completions: { create } } };
  return create;
}

function makeGenericProvider() {
  const {
    GenericOpenAiLLM,
  } = require("../../../utils/AiProviders/genericOpenAi");
  const llm = new GenericOpenAiLLM(fakeEmbedder);
  return { llm, create: mockChatCompletions(llm) };
}

/** Ruft getChatCompletion und streamGetChatCompletion auf, liefert beide Bodies. */
async function sentBodies(options = { temperature: 0.3 }) {
  const { llm, create } = makeGenericProvider();
  await llm.getChatCompletion(messages, { ...options });
  await llm.streamGetChatCompletion(messages, { ...options });
  expect(create).toHaveBeenCalledTimes(2);
  return { sync: create.mock.calls[0][0], stream: create.mock.calls[1][0] };
}

function setThinkingEnv(value) {
  if (value === undefined) delete process.env.GENERIC_OPEN_AI_ENABLE_THINKING;
  else process.env.GENERIC_OPEN_AI_ENABLE_THINKING = value;
}

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
  delete process.env.GENERIC_OPEN_AI_ENABLE_THINKING;
  jest.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  console.warn.mockRestore();
});

describe("GENERIC_OPEN_AI_ENABLE_THINKING im Body des Generic-OpenAI-Providers", () => {
  test.each(["false", "FALSE", " False ", "\tfalse\n"])(
    "AK-1: Wert %j setzt enable_thinking: false (Stream und Nicht-Stream)",
    async (value) => {
      setThinkingEnv(value);
      const { sync, stream } = await sentBodies();
      expect(sync).toEqual({
        ...PLAIN_BODY,
        chat_template_kwargs: { enable_thinking: false },
      });
      expect(stream).toEqual({
        ...PLAIN_STREAM_BODY,
        chat_template_kwargs: { enable_thinking: false },
      });
      // Alle übrigen Felder unverändert und in der bisherigen Reihenfolge
      expect(Object.keys(sync)).toEqual([
        ...Object.keys(PLAIN_BODY),
        "chat_template_kwargs",
      ]);
      expect(Object.keys(stream)).toEqual([
        ...Object.keys(PLAIN_STREAM_BODY),
        "chat_template_kwargs",
      ]);
    }
  );

  test.each(["true", "TRUE", " True "])(
    "AK-2: Wert %j setzt enable_thinking: true (Stream und Nicht-Stream)",
    async (value) => {
      setThinkingEnv(value);
      const { sync, stream } = await sentBodies();
      expect(sync.chat_template_kwargs).toEqual({ enable_thinking: true });
      expect(stream.chat_template_kwargs).toEqual({ enable_thinking: true });
      expect(sync).toEqual({
        ...PLAIN_BODY,
        chat_template_kwargs: { enable_thinking: true },
      });
    }
  );

  test("JSON des Bodys enthält genau den Schalter als Boolean", async () => {
    setThinkingEnv("false");
    const { sync, stream } = await sentBodies();
    expect(JSON.stringify(sync)).toContain(
      '"chat_template_kwargs":{"enable_thinking":false}'
    );
    expect(JSON.stringify(stream)).toContain(
      '"chat_template_kwargs":{"enable_thinking":false}'
    );
  });

  describe("AK-3: Zusammenführung mit den Optionen des Aufrufers", () => {
    test("Aufrufer enable_thinking: true gewinnt gegen Variable false", async () => {
      setThinkingEnv("false");
      const { sync, stream } = await sentBodies({
        temperature: 0.3,
        chat_template_kwargs: { enable_thinking: true },
      });
      expect(sync.chat_template_kwargs).toEqual({ enable_thinking: true });
      expect(stream.chat_template_kwargs).toEqual({ enable_thinking: true });
    });

    test("Aufrufer enable_thinking: false gewinnt gegen Variable true", async () => {
      setThinkingEnv("true");
      const { sync, stream } = await sentBodies({
        temperature: 0.3,
        chat_template_kwargs: { enable_thinking: false },
      });
      expect(sync.chat_template_kwargs).toEqual({ enable_thinking: false });
      expect(stream.chat_template_kwargs).toEqual({ enable_thinking: false });
    });

    test("Aufrufer ohne enable_thinking: Wert der Variablen wird ergänzt", async () => {
      setThinkingEnv("false");
      const callerKwargs = { reasoning_budget: 512 };
      const { sync, stream } = await sentBodies({
        temperature: 0.3,
        chat_template_kwargs: callerKwargs,
      });
      expect(sync.chat_template_kwargs).toEqual({
        reasoning_budget: 512,
        enable_thinking: false,
      });
      expect(stream.chat_template_kwargs).toEqual({
        reasoning_budget: 512,
        enable_thinking: false,
      });
      // Das Objekt des Aufrufers bleibt unverändert
      expect(callerKwargs).toEqual({ reasoning_budget: 512 });
    });

    test("leeres kwargs-Objekt des Aufrufers: Wert der Variablen wird ergänzt", async () => {
      setThinkingEnv("true");
      const { sync, stream } = await sentBodies({
        temperature: 0.3,
        chat_template_kwargs: {},
      });
      expect(sync.chat_template_kwargs).toEqual({ enable_thinking: true });
      expect(stream.chat_template_kwargs).toEqual({ enable_thinking: true });
    });

    test("übrige Anfrage-Optionen bleiben unverändert", async () => {
      setThinkingEnv("false");
      const { sync } = await sentBodies({
        temperature: 0.1,
        max_tokens: 4096,
        top_p: 0.9,
      });
      expect(sync).toEqual({
        model: "Chat1",
        messages,
        temperature: 0.1,
        max_tokens: 4096,
        top_p: 0.9,
        chat_template_kwargs: { enable_thinking: false },
      });
    });
  });

  // Fixliste 8.1-rc2, D7: reasoning_effort ist der zweite dokumentierte
  // Schalter der Entwickler-API; wer ihn schickt, hat selbst gewählt.
  describe("D7: reasoning_effort des Aufrufers hat Vorrang vor der Variablen", () => {
    test.each([
      ["true", "none"],
      ["false", "high"],
      ["true", "low"],
      ["false", "none"],
    ])(
      "Variable %j, reasoning_effort %j: Body ohne chat_template_kwargs",
      async (value, reasoningEffort) => {
        setThinkingEnv(value);
        const { sync, stream } = await sentBodies({
          temperature: 0.3,
          reasoning_effort: reasoningEffort,
        });
        expect(sync).toEqual({
          ...PLAIN_BODY,
          reasoning_effort: reasoningEffort,
        });
        expect(stream).toEqual({
          ...PLAIN_STREAM_BODY,
          reasoning_effort: reasoningEffort,
        });
        expect(JSON.stringify(sync)).not.toContain("enable_thinking");
        expect(JSON.stringify(stream)).not.toContain("enable_thinking");
      }
    );

    test("eigene chat_template_kwargs ohne enable_thinking gehen unverändert in den Body", async () => {
      setThinkingEnv("false");
      const callerKwargs = { reasoning_budget: 512 };
      const { sync, stream } = await sentBodies({
        temperature: 0.3,
        reasoning_effort: "high",
        chat_template_kwargs: callerKwargs,
      });
      expect(sync.chat_template_kwargs).toEqual({ reasoning_budget: 512 });
      expect(stream.chat_template_kwargs).toEqual({ reasoning_budget: 512 });
      expect(sync.reasoning_effort).toBe("high");
      expect(callerKwargs).toEqual({ reasoning_budget: 512 });
    });
  });

  describe("NAK-1: ohne gültigen Wert ist der Body wie vor der Änderung", () => {
    test.each([
      ["nicht gesetzt", undefined],
      ["leer", ""],
      ["nur Leerzeichen", "   "],
      ["nein", "nein"],
      ["0", "0"],
      ["1", "1"],
      ["yes", "yes"],
      ["JSON", '{"enable_thinking":false}'],
      ["mit Anführungszeichen", "'false'"],
    ])("%s: kein chat_template_kwargs im Body", async (_label, value) => {
      setThinkingEnv(value);
      const { sync, stream } = await sentBodies();
      expect(JSON.stringify(sync)).toBe(JSON.stringify(PLAIN_BODY));
      expect(JSON.stringify(stream)).toBe(JSON.stringify(PLAIN_STREAM_BODY));
      expect(sync).not.toHaveProperty("chat_template_kwargs");
      expect(stream).not.toHaveProperty("chat_template_kwargs");
    });

    test("ungültiger Wert: kwargs des Aufrufers bleiben genau wie übergeben", async () => {
      setThinkingEnv("nein");
      const { sync, stream } = await sentBodies({
        temperature: 0.3,
        chat_template_kwargs: { reasoning_budget: 512 },
      });
      expect(sync.chat_template_kwargs).toEqual({ reasoning_budget: 512 });
      expect(stream.chat_template_kwargs).toEqual({ reasoning_budget: 512 });
    });
  });

  describe("NAK-2: ungültiger Wert warnt höchstens einmal je Prozess", () => {
    const warningsAboutVariable = () =>
      console.warn.mock.calls.filter((args) =>
        args.join(" ").includes("GENERIC_OPEN_AI_ENABLE_THINKING")
      );

    test("eine Warnung über viele Anfragen und Instanzen, kein Fehler", async () => {
      await jest.isolateModulesAsync(async () => {
        setThinkingEnv("nein");
        const first = makeGenericProvider();
        await expect(
          first.llm.getChatCompletion(messages, { temperature: 0.3 })
        ).resolves.toMatchObject({ textResponse: "Am Montag." });
        await first.llm.streamGetChatCompletion(messages, {
          temperature: 0.3,
        });
        setThinkingEnv("0");
        const second = makeGenericProvider();
        await second.llm.getChatCompletion(messages, { temperature: 0.3 });
        await second.llm.streamGetChatCompletion(messages, {
          temperature: 0.3,
        });
        expect(warningsAboutVariable()).toHaveLength(1);
        for (const call of [
          ...first.create.mock.calls,
          ...second.create.mock.calls,
        ])
          expect(call[0]).not.toHaveProperty("chat_template_kwargs");
      });
    });

    test("die Warnung stimmt auch, wenn der Aufrufer eigene kwargs schickt", async () => {
      await jest.isolateModulesAsync(async () => {
        setThinkingEnv("nein");
        const { llm, create } = makeGenericProvider();
        await llm.getChatCompletion(messages, {
          temperature: 0.3,
          chat_template_kwargs: { reasoning_budget: 512 },
        });
        expect(create.mock.calls[0][0].chat_template_kwargs).toEqual({
          reasoning_budget: 512,
        });
        const [warning] = warningsAboutVariable();
        const text = warning.join(" ");
        expect(text).toContain("the variable adds no chat_template_kwargs");
        expect(text).not.toMatch(/sent without chat_template_kwargs/);
      });
    });

    test("die Warnung nennt die erlaubten Werte, aber nicht den gesetzten Wert", async () => {
      await jest.isolateModulesAsync(async () => {
        setThinkingEnv("geheim-123");
        const { llm } = makeGenericProvider();
        await llm.getChatCompletion(messages, { temperature: 0.3 });
        const [warning] = warningsAboutVariable();
        const text = warning.join(" ");
        expect(text).toMatch(/true/);
        expect(text).toMatch(/false/);
        expect(text).not.toContain("geheim-123");
      });
    });

    test.each([undefined, "", "true", "false", " FALSE "])(
      "Wert %j: keine Warnung",
      async (value) => {
        await jest.isolateModulesAsync(async () => {
          setThinkingEnv(value);
          const { llm } = makeGenericProvider();
          await llm.getChatCompletion(messages, { temperature: 0.3 });
          await llm.streamGetChatCompletion(messages, { temperature: 0.3 });
          expect(warningsAboutVariable()).toHaveLength(0);
        });
      }
    );
  });
});

describe("NAK-3: andere Provider schicken auch mit gesetzter Variable keinen Schalter", () => {
  test.each(["false", "true"])(
    "LiteLLM-Provider mit Variable %j: Body ohne chat_template_kwargs",
    async (value) => {
      setThinkingEnv(value);
      process.env.LITE_LLM_BASE_PATH = "http://litellm.invalid";
      process.env.LITE_LLM_MODEL_PREF = "Chat1";
      process.env.LITE_LLM_API_KEY = "test-key";
      const { LiteLLM } = require("../../../utils/AiProviders/liteLLM");
      const llm = new LiteLLM(fakeEmbedder);
      const create = mockChatCompletions(llm);
      await llm.getChatCompletion(messages, { temperature: 0.3 });
      await llm.streamGetChatCompletion(messages, { temperature: 0.3 });
      expect(create.mock.calls[0][0]).toEqual({
        model: "Chat1",
        messages,
        temperature: 0.3,
      });
      expect(create.mock.calls[1][0]).toEqual({
        model: "Chat1",
        stream: true,
        messages,
        temperature: 0.3,
      });
    }
  );

  test("OpenAiLLM mit Variable false: Body gleich wie ohne Variable", async () => {
    process.env.OPEN_AI_KEY = "sk-test";
    const { OpenAiLLM } = require("../../../utils/AiProviders/openAi");
    const llm = new OpenAiLLM(fakeEmbedder, "gpt-4o");
    llm.isValidChatCompletionModel = async () => true;
    const create = jest.fn().mockResolvedValue({
      output_text: "ok",
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    });
    llm.openai = { responses: { create } };

    await llm.getChatCompletion(messages, { temperature: 0.2 });
    setThinkingEnv("false");
    await llm.getChatCompletion(messages, { temperature: 0.2 });
    expect(create.mock.calls[1][0]).toEqual(create.mock.calls[0][0]);
    expect(JSON.stringify(create.mock.calls[1][0])).not.toContain(
      "enable_thinking"
    );
  });
});

// Fixliste 8.1-rc2, F1: Wer die Beispielzeile übernimmt und nur "# " entfernt,
// bekommt genau den Wert false (Erklärung in eigenen Kommentarzeilen darüber).
describe("Beispielzeile in beiden .env.example", () => {
  const fs = require("fs");
  const path = require("path");
  const dotenv = require("dotenv");
  const EXAMPLES = [
    ["docker/.env.example", path.resolve(__dirname, "../../../../docker")],
    ["server/.env.example", path.resolve(__dirname, "../../..")],
  ];

  /** Zeilen nach GENERIC_OPEN_AI_CUSTOM_HEADERS bis zur Variablenzeile. */
  function thinkingBlock(dir) {
    const lines = fs
      .readFileSync(path.join(dir, ".env.example"), "utf8")
      .split("\n");
    const end = lines.findIndex((line) =>
      line.startsWith("# GENERIC_OPEN_AI_ENABLE_THINKING=")
    );
    const start = lines.findIndex((line) =>
      line.startsWith("# GENERIC_OPEN_AI_CUSTOM_HEADERS=")
    );
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return lines.slice(start + 1, end + 1);
  }

  test.each(EXAMPLES)(
    "%s: ohne '# ' liest dotenv genau false",
    (_label, dir) => {
      const block = thinkingBlock(dir);
      const variableLine = block[block.length - 1];
      expect(dotenv.parse(variableLine.replace(/^# /, ""))).toEqual({
        GENERIC_OPEN_AI_ENABLE_THINKING: "false",
      });
      // Erklärung nur in reinen Kommentarzeilen darüber
      for (const line of block.slice(0, -1)) expect(line).toMatch(/^# /);
      expect(dotenv.parse(block.join("\n"))).toEqual({});
    }
  );

  test("beide Dateien haben denselben Block", () => {
    expect(thinkingBlock(EXAMPLES[0][1])).toEqual(
      thinkingBlock(EXAMPLES[1][1])
    );
  });
});
