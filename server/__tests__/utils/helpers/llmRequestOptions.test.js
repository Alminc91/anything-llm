/* eslint-env jest, node */
const {
  parseLLMRequestOptions,
  parseLLMRequestOptionsForWorkspace,
  resolveMaxTokensCeiling,
  resolveChatTemplateKwargsAllowlist,
  shouldSeparateReasoning,
  splitThinkBlock,
  ThinkBlockSplitter,
} = require("../../../utils/helpers/chat/llmRequestOptions");

// Für Werte-Tests der chat_template_kwargs: Schlüssel "a", "k0"… erlauben.
const OPEN_ALLOWLIST = {
  chatTemplateKwargsAllowlist: [
    "a",
    "enable_thinking",
    "budget",
    "mode",
    ...Array.from({ length: 11 }, (_, i) => `k${i}`),
  ],
};

const ENV_KEYS = [
  "LLM_REQUEST_MAX_TOKENS_CEILING",
  "LLM_CHAT_TEMPLATE_KWARGS_ALLOWLIST",
];
const savedEnv = {};
beforeAll(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  jest.spyOn(console, "error").mockImplementation(() => {});
  jest.spyOn(console, "log").mockImplementation(() => {});
});
afterAll(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  console.error.mockRestore();
  console.log.mockRestore();
});
beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  console.error.mockClear();
  console.log.mockClear();
});

describe("parseLLMRequestOptions", () => {
  test("liefert leere Optionen bei fehlendem oder leerem Input", () => {
    for (const input of [undefined, null, {}]) {
      expect(parseLLMRequestOptions(input)).toEqual({ ok: true, options: {} });
    }
  });

  test("lehnt Nicht-Objekte ab", () => {
    for (const input of ["x", 5, true, [], [1, 2]]) {
      const result = parseLLMRequestOptions(input, {
        fieldPrefix: "llmOptions.",
      });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/llmOptions must be a JSON object/);
    }
  });

  test("ignoriert unbekannte Felder (z. B. model, messages, stream)", () => {
    const result = parseLLMRequestOptions({
      model: "ws",
      messages: [],
      stream: true,
      foo: "bar",
      max_completion_tokens: 5,
    });
    expect(result).toEqual({ ok: true, options: {} });
  });

  test("behandelt null wie nicht gesetzt", () => {
    expect(
      parseLLMRequestOptions(
        {
          max_tokens: null,
          top_p: null,
          reasoning_effort: null,
          chat_template_kwargs: null,
          temperature: null,
        },
        { allowTemperature: true }
      )
    ).toEqual({ ok: true, options: {} });
  });

  test("liefert alle gültigen Optionen provider-fertig in snake_case", () => {
    const kwargs = { enable_thinking: true, budget: 512, mode: "x" };
    const result = parseLLMRequestOptions(
      {
        max_tokens: 4096,
        top_p: 0.9,
        reasoning_effort: "high",
        chat_template_kwargs: kwargs,
        temperature: 0.1,
      },
      { allowTemperature: true, ...OPEN_ALLOWLIST }
    );
    expect(result).toEqual({
      ok: true,
      options: {
        max_tokens: 4096,
        top_p: 0.9,
        reasoning_effort: "high",
        chat_template_kwargs: { enable_thinking: true, budget: 512, mode: "x" },
        temperature: 0.1,
      },
    });
    // Kopie, nicht dieselbe Referenz (reine Funktion)
    expect(result.options.chat_template_kwargs).not.toBe(kwargs);
  });

  describe("max_tokens", () => {
    test.each([1, 4096, 16384])("akzeptiert %p", (value) => {
      expect(parseLLMRequestOptions({ max_tokens: value }).options).toEqual({
        max_tokens: value,
      });
    });
    test.each([0, -1, 16385, 1.5, "4096", true, NaN, Infinity, {}, []])(
      "lehnt %p ab (Standard-Obergrenze 16384, strikt)",
      (value) => {
        const result = parseLLMRequestOptions({ max_tokens: value });
        expect(result.ok).toBe(false);
        expect(result.param).toBe("max_tokens");
        expect(result.error).toMatch(
          /max_tokens must be an integer between 1 and 16384/
        );
      }
    );

    test("strikt: kein Klemmen, kein Log", () => {
      const result = parseLLMRequestOptions(
        { max_tokens: 20000 },
        { fieldPrefix: "llmOptions." }
      );
      expect(result.ok).toBe(false);
      expect(result.param).toBe("llmOptions.max_tokens");
      expect(console.log).not.toHaveBeenCalled();
    });

    test("max_completion_tokens wird ohne allowMaxCompletionTokens ignoriert", () => {
      expect(parseLLMRequestOptions({ max_completion_tokens: 512 })).toEqual({
        ok: true,
        options: {},
      });
    });

    test("respektiert die übergebene Obergrenze und nennt sie im Fehler", () => {
      expect(
        parseLLMRequestOptions({ max_tokens: 8192 }, { maxTokensCeiling: 8192 })
          .options
      ).toEqual({ max_tokens: 8192 });
      const result = parseLLMRequestOptions(
        { max_tokens: 8193 },
        { maxTokensCeiling: 8192, fieldPrefix: "llmOptions." }
      );
      expect(result).toEqual({
        ok: false,
        error: "llmOptions.max_tokens must be an integer between 1 and 8192.",
        param: "llmOptions.max_tokens",
      });
    });
  });

  describe("top_p", () => {
    test.each([0.0001, 0.5, 1])("akzeptiert %p", (value) => {
      expect(parseLLMRequestOptions({ top_p: value }).options).toEqual({
        top_p: value,
      });
    });
    test.each([0, -0.1, 1.01, "0.5", false, NaN, Infinity])(
      "lehnt %p ab",
      (value) => {
        const result = parseLLMRequestOptions({ top_p: value });
        expect(result.ok).toBe(false);
        expect(result.error).toMatch(
          /top_p must be a number greater than 0 and at most 1/
        );
      }
    );
  });

  describe("reasoning_effort", () => {
    test.each(["none", "minimal", "low", "medium", "high"])(
      "akzeptiert %p",
      (value) => {
        expect(
          parseLLMRequestOptions({ reasoning_effort: value }).options
        ).toEqual({ reasoning_effort: value });
      }
    );
    test.each(["hoch", "HIGH", "xhigh", "", 1, true, {}])(
      "lehnt %p mit Hinweis auf erlaubte Werte ab",
      (value) => {
        const result = parseLLMRequestOptions({ reasoning_effort: value });
        expect(result.ok).toBe(false);
        expect(result.error).toBe(
          "reasoning_effort must be one of: none, minimal, low, medium, high."
        );
      }
    );
  });

  describe("chat_template_kwargs", () => {
    test("akzeptiert genau das übergebene flache Objekt", () => {
      expect(
        parseLLMRequestOptions({
          chat_template_kwargs: { enable_thinking: true },
        }).options
      ).toEqual({ chat_template_kwargs: { enable_thinking: true } });
    });

    test("akzeptiert ein leeres Objekt und 10 Schlüssel", () => {
      expect(
        parseLLMRequestOptions({ chat_template_kwargs: {} }).options
      ).toEqual({ chat_template_kwargs: {} });
      const ten = Object.fromEntries(
        Array.from({ length: 10 }, (_, i) => [`k${i}`, i])
      );
      expect(
        parseLLMRequestOptions({ chat_template_kwargs: ten }, OPEN_ALLOWLIST)
          .options.chat_template_kwargs
      ).toEqual(ten);
    });

    test("lehnt 11 Schlüssel ab", () => {
      const eleven = Object.fromEntries(
        Array.from({ length: 11 }, (_, i) => [`k${i}`, true])
      );
      const result = parseLLMRequestOptions(
        { chat_template_kwargs: eleven },
        OPEN_ALLOWLIST
      );
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/at most 10 keys/);
    });

    test.each([
      ["verschachteltes Objekt", { a: { b: true } }],
      ["Array-Wert", { a: [1, 2] }],
      ["Funktions-Wert", { a: () => true }],
      ["null-Wert", { a: null }],
      ["undefined-Wert", { a: undefined }],
      ["NaN-Wert", { a: NaN }],
      ["zu langer String", { a: "x".repeat(257) }],
    ])("lehnt %s ab", (_label, kwargs) => {
      const result = parseLLMRequestOptions(
        { chat_template_kwargs: kwargs },
        OPEN_ALLOWLIST
      );
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/chat_template_kwargs\.a /);
    });

    test("prüft auch Werte erlaubter Standard-Schlüssel", () => {
      const result = parseLLMRequestOptions({
        chat_template_kwargs: { enable_thinking: { nested: true } },
      });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(
        /chat_template_kwargs\.enable_thinking must be a boolean/
      );
    });

    test("akzeptiert String mit genau 256 Zeichen", () => {
      const value = "x".repeat(256);
      expect(
        parseLLMRequestOptions(
          { chat_template_kwargs: { a: value } },
          OPEN_ALLOWLIST
        ).ok
      ).toBe(true);
    });

    test.each([
      ["Array statt Objekt", [true]],
      ["String statt Objekt", "enable_thinking"],
      ["Zahl statt Objekt", 1],
      ["Klasseninstanz", new Date()],
    ])("lehnt %s ab", (_label, kwargs) => {
      const result = parseLLMRequestOptions({ chat_template_kwargs: kwargs });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(
        /chat_template_kwargs must be a flat JSON object/
      );
    });

    test.each(["1abc", "a-b", "a b", "", "ä", "x".repeat(65)])(
      "lehnt ungültigen Schlüssel %p ab",
      (key) => {
        const result = parseLLMRequestOptions(
          { chat_template_kwargs: { [key]: true } },
          { chatTemplateKwargsAllowlist: [key] }
        );
        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/invalid key/);
      }
    );

    test("akzeptiert Schlüssel mit 64 Zeichen und führendem Unterstrich", () => {
      const key = "_" + "a".repeat(63);
      expect(
        parseLLMRequestOptions(
          { chat_template_kwargs: { [key]: 1 } },
          { chatTemplateKwargsAllowlist: [key] }
        ).ok
      ).toBe(true);
    });

    test("lehnt __proto__/constructor/prototype als Schlüssel ab (Prototype Pollution)", () => {
      for (const raw of [
        '{"__proto__": {"polluted": true}}',
        '{"__proto__": true}',
        '{"constructor": "x"}',
        '{"prototype": 1}',
      ]) {
        const result = parseLLMRequestOptions(
          { chat_template_kwargs: JSON.parse(raw) },
          {
            chatTemplateKwargsAllowlist: [
              "__proto__",
              "constructor",
              "prototype",
            ],
          }
        );
        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/invalid key/);
      }
      expect({}.polluted).toBeUndefined();
    });

    describe("Schlüssel-Whitelist", () => {
      test.each([
        "chat_template",
        "add_generation_prompt",
        "continue_final_message",
        "tools",
        "documents",
        "a",
      ])("lehnt nicht erlaubten Schlüssel %p mit Nennung ab", (key) => {
        const result = parseLLMRequestOptions(
          { chat_template_kwargs: { enable_thinking: true, [key]: "x" } },
          { fieldPrefix: "llmOptions." }
        );
        expect(result).toEqual({
          ok: false,
          error: `llmOptions.chat_template_kwargs contains the key "${key}", which is not allowed. Allowed keys: enable_thinking.`,
          param: "llmOptions.chat_template_kwargs",
        });
      });

      test("Standard-Whitelist ist enable_thinking", () => {
        expect(resolveChatTemplateKwargsAllowlist()).toEqual([
          "enable_thinking",
        ]);
        expect(resolveChatTemplateKwargsAllowlist("")).toEqual([
          "enable_thinking",
        ]);
      });

      test("ENV erweitert die Whitelist, ungültige Einträge werden ignoriert", () => {
        expect(
          resolveChatTemplateKwargsAllowlist(
            " thinking_budget , enable_thinking,,a-b,__proto__,x y,_mode"
          )
        ).toEqual(["enable_thinking", "thinking_budget", "_mode"]);
      });

      test("Parser liest die ENV-Whitelist pro Aufruf", () => {
        const input = { chat_template_kwargs: { thinking_budget: 256 } };
        expect(parseLLMRequestOptions(input).ok).toBe(false);
        process.env.LLM_CHAT_TEMPLATE_KWARGS_ALLOWLIST = "thinking_budget";
        expect(parseLLMRequestOptions(input)).toEqual({
          ok: true,
          options: { chat_template_kwargs: { thinking_budget: 256 } },
        });
        // Standard-Schlüssel bleibt erlaubt
        expect(
          parseLLMRequestOptions({
            chat_template_kwargs: { enable_thinking: false },
          }).ok
        ).toBe(true);
      });
    });
  });

  describe("temperature", () => {
    test("wird ohne allowTemperature ignoriert (auch ungültige Werte)", () => {
      expect(parseLLMRequestOptions({ temperature: 0.1 })).toEqual({
        ok: true,
        options: {},
      });
      expect(parseLLMRequestOptions({ temperature: "heiß" })).toEqual({
        ok: true,
        options: {},
      });
    });
    test.each([0, 0.1, 1, 2])("akzeptiert %p mit allowTemperature", (value) => {
      expect(
        parseLLMRequestOptions(
          { temperature: value },
          { allowTemperature: true }
        ).options
      ).toEqual({ temperature: value });
    });
    test.each([-0.1, 2.01, "0.5", true, NaN])(
      "lehnt %p mit allowTemperature ab",
      (value) => {
        const result = parseLLMRequestOptions(
          { temperature: value },
          { allowTemperature: true, fieldPrefix: "llmOptions." }
        );
        expect(result.ok).toBe(false);
        expect(result.error).toBe(
          "llmOptions.temperature must be a number between 0 and 2."
        );
      }
    );
  });

  describe("coerce-Modus (OpenAI-kompatibler Endpunkt)", () => {
    const coerce = { coerce: true, allowTemperature: true };

    test("wandelt Zahlen-Strings um", () => {
      expect(
        parseLLMRequestOptions(
          { max_tokens: "4096", top_p: "0.5", temperature: " 1.2 " },
          coerce
        )
      ).toEqual({
        ok: true,
        options: { max_tokens: 4096, top_p: 0.5, temperature: 1.2 },
      });
    });

    test.each([
      0,
      "0",
      -1,
      "-1",
      -4096,
      null,
      undefined,
      "viel",
      "0x10",
      "",
      true,
      {},
      [],
    ])("max_tokens %p gilt als nicht gesetzt", (value) => {
      expect(parseLLMRequestOptions({ max_tokens: value }, coerce)).toEqual({
        ok: true,
        options: {},
      });
    });

    test.each([
      [20000, 16384],
      ["1000000", 16384],
      [16384, 16384],
    ])(
      "max_tokens %p wird auf %p geklemmt (ohne Fehler)",
      (value, expected) => {
        expect(parseLLMRequestOptions({ max_tokens: value }, coerce)).toEqual({
          ok: true,
          options: { max_tokens: expected },
        });
      }
    );

    test("Klemmen wird genau einmal per console.log vermerkt", () => {
      const result = parseLLMRequestOptions(
        { max_tokens: 9000 },
        { ...coerce, maxTokensCeiling: 8192 }
      );
      expect(result.options).toEqual({ max_tokens: 8192 });
      expect(console.log).toHaveBeenCalledTimes(1);
      expect(console.log.mock.calls[0][0]).toMatch(
        /max_tokens=9000 exceeds the server ceiling and was clamped to 8192/
      );
      expect(console.error).not.toHaveBeenCalled();
    });

    test("max_tokens unter der Obergrenze: kein Log", () => {
      parseLLMRequestOptions({ max_tokens: 4096 }, coerce);
      expect(console.log).not.toHaveBeenCalled();
    });

    test.each([0, "0", -0.5, "-1"])(
      "top_p %p gilt als nicht gesetzt",
      (value) => {
        expect(parseLLMRequestOptions({ top_p: value }, coerce)).toEqual({
          ok: true,
          options: {},
        });
      }
    );

    describe("max_completion_tokens (Alias, nur mit allowMaxCompletionTokens)", () => {
      const alias = { ...coerce, allowMaxCompletionTokens: true };

      test("wird als max_tokens übernommen", () => {
        expect(
          parseLLMRequestOptions({ max_completion_tokens: 512 }, alias)
        ).toEqual({ ok: true, options: { max_tokens: 512 } });
      });

      test("max_tokens gewinnt, wenn beide gesetzt sind", () => {
        expect(
          parseLLMRequestOptions(
            { max_tokens: 256, max_completion_tokens: 512 },
            alias
          ).options
        ).toEqual({ max_tokens: 256 });
        // auch wenn max_tokens "nicht gesetzt" bedeutet (-1 = unbegrenzt)
        expect(
          parseLLMRequestOptions(
            { max_tokens: -1, max_completion_tokens: 512 },
            alias
          ).options
        ).toEqual({});
      });

      test("max_tokens null: Alias greift", () => {
        expect(
          parseLLMRequestOptions(
            { max_tokens: null, max_completion_tokens: "512" },
            alias
          ).options
        ).toEqual({ max_tokens: 512 });
      });

      test("Alias wird ebenfalls geklemmt und tolerant gelesen", () => {
        expect(
          parseLLMRequestOptions({ max_completion_tokens: 50000 }, alias)
            .options
        ).toEqual({ max_tokens: 16384 });
        expect(
          parseLLMRequestOptions({ max_completion_tokens: 0 }, alias).options
        ).toEqual({});
      });

      test("Fehler nennt den Alias als param", () => {
        expect(
          parseLLMRequestOptions({ max_completion_tokens: 12.5 }, alias)
        ).toEqual({
          ok: false,
          error:
            "max_completion_tokens must be an integer between 1 and 16384.",
          param: "max_completion_tokens",
        });
      });
    });

    test.each([
      [
        { reasoning_effort: "auto" },
        /reasoning_effort must be one of/,
        "reasoning_effort",
      ],
      [{ top_p: 1.5 }, /top_p must be a number/, "top_p"],
      [{ top_p: "1.5" }, /top_p must be a number/, "top_p"],
      [{ top_p: "abc" }, /top_p must be a number/, "top_p"],
      [{ max_tokens: "4096.5" }, /max_tokens must be an integer/, "max_tokens"],
      [{ max_tokens: 1.5 }, /max_tokens must be an integer/, "max_tokens"],
      [
        { temperature: "hot" },
        /temperature must be a number between 0 and 2/,
        "temperature",
      ],
      [
        { temperature: 3 },
        /temperature must be a number between 0 and 2/,
        "temperature",
      ],
      [
        { temperature: "" },
        /temperature must be a number between 0 and 2/,
        "temperature",
      ],
      [
        { chat_template_kwargs: { enable_thinking: {} } },
        /chat_template_kwargs\.enable_thinking must be/,
        "chat_template_kwargs",
      ],
    ])("bleibt strikt bei %p", (input, pattern, param) => {
      const result = parseLLMRequestOptions(input, coerce);
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(pattern);
      expect(result.param).toBe(param);
    });

    test("kwargs-Werte werden nicht umgewandelt", () => {
      expect(
        parseLLMRequestOptions(
          { chat_template_kwargs: { enable_thinking: "true" } },
          coerce
        ).options
      ).toEqual({ chat_template_kwargs: { enable_thinking: "true" } });
    });

    test("ohne coerce keine Umwandlung und max_tokens 0 bleibt ungültig", () => {
      for (const input of [
        { max_tokens: "4096" },
        { max_tokens: 0 },
        { top_p: "0.5" },
      ])
        expect(parseLLMRequestOptions(input).ok).toBe(false);
      expect(
        parseLLMRequestOptions(
          { temperature: "0.5" },
          { allowTemperature: true }
        ).ok
      ).toBe(false);
    });
  });

  test("verwendet das Präfix in Fehlermeldungen", () => {
    const result = parseLLMRequestOptions(
      { reasoning_effort: "hoch" },
      { fieldPrefix: "llmOptions." }
    );
    expect(result.error).toMatch(
      /^llmOptions\.reasoning_effort must be one of/
    );
  });

  test("verändert den Input nicht", () => {
    const input = {
      max_tokens: 10,
      chat_template_kwargs: { enable_thinking: true },
    };
    const snapshot = JSON.stringify(input);
    parseLLMRequestOptions(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});

describe("resolveMaxTokensCeiling", () => {
  const helpers = require("../../../utils/helpers");
  let classSpy;
  let modelSpy;
  let providerSpy;
  const workspace = { chatProvider: "generic-openai", chatModel: "Chat1" };
  const withWindow = (limit) =>
    classSpy.mockReturnValue({ promptWindowLimit: jest.fn(() => limit) });

  beforeEach(() => {
    classSpy = jest.spyOn(helpers, "getLLMProviderClass");
    modelSpy = jest
      .spyOn(helpers, "getBaseLLMProviderModel")
      .mockReturnValue("BaseModel");
    providerSpy = jest.spyOn(helpers, "getLLMProvider");
    withWindow(131072);
  });
  afterEach(() => {
    classSpy.mockRestore();
    modelSpy.mockRestore();
    providerSpy.mockRestore();
  });

  test("ENV hat Vorrang vor Standard und Kontextfenster", () => {
    process.env.LLM_REQUEST_MAX_TOKENS_CEILING = "32768";
    expect(resolveMaxTokensCeiling(workspace)).toBe(32768);
    expect(classSpy).not.toHaveBeenCalled();
  });

  test("ohne ENV: min(16384, Kontextfenster)", () => {
    expect(resolveMaxTokensCeiling(workspace)).toBe(16384);
    withWindow(8192);
    expect(resolveMaxTokensCeiling(workspace)).toBe(8192);
    withWindow("4096");
    expect(resolveMaxTokensCeiling(workspace)).toBe(4096);
  });

  test("statisch über die Provider-Klasse, ohne Provider-Instanz", () => {
    const promptWindowLimit = jest.fn(() => 8192);
    classSpy.mockReturnValue({ promptWindowLimit });
    resolveMaxTokensCeiling(workspace);
    expect(classSpy).toHaveBeenCalledWith({ provider: "generic-openai" });
    expect(promptWindowLimit).toHaveBeenCalledWith("Chat1");
    expect(providerSpy).not.toHaveBeenCalled();
  });

  test("ohne Workspace-Provider/-Modell: System-Provider und Basis-Modell", () => {
    const saved = process.env.LLM_PROVIDER;
    process.env.LLM_PROVIDER = "generic-openai";
    const promptWindowLimit = jest.fn(() => 8192);
    classSpy.mockReturnValue({ promptWindowLimit });
    try {
      expect(resolveMaxTokensCeiling({})).toBe(8192);
      expect(classSpy).toHaveBeenCalledWith({ provider: "generic-openai" });
      expect(modelSpy).toHaveBeenCalledWith({ provider: "generic-openai" });
      expect(promptWindowLimit).toHaveBeenCalledWith("BaseModel");
    } finally {
      if (saved === undefined) delete process.env.LLM_PROVIDER;
      else process.env.LLM_PROVIDER = saved;
    }
  });

  test.each(["abc", "0", "-5", "1.5", " "])(
    "ungültige ENV %p wird ignoriert",
    (value) => {
      process.env.LLM_REQUEST_MAX_TOKENS_CEILING = value;
      withWindow(4096);
      expect(resolveMaxTokensCeiling(workspace)).toBe(4096);
    }
  );

  test("ungültige ENV wird per console.error gemeldet", () => {
    process.env.LLM_REQUEST_MAX_TOKENS_CEILING = "abc";
    resolveMaxTokensCeiling(workspace);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("LLM_REQUEST_MAX_TOKENS_CEILING")
    );
  });

  test("Kontextfenster nicht ermittelbar: konservativ 16384", () => {
    classSpy.mockReturnValue(null);
    expect(resolveMaxTokensCeiling(workspace)).toBe(16384);
    classSpy.mockReturnValue({});
    expect(resolveMaxTokensCeiling(workspace)).toBe(16384);
    withWindow(NaN);
    expect(resolveMaxTokensCeiling(workspace)).toBe(16384);
    // asynchrones Limit (z. B. TogetherAI) ist hier nicht nutzbar
    classSpy.mockReturnValue({
      promptWindowLimit: () => Promise.reject(new Error("offline")),
    });
    expect(resolveMaxTokensCeiling(workspace)).toBe(16384);
    expect(resolveMaxTokensCeiling(null)).toBe(16384);
  });

  test("Fehler beim Ermitteln: 16384 und console.error", () => {
    classSpy.mockImplementation(() => {
      throw new Error("kein Provider");
    });
    expect(resolveMaxTokensCeiling(workspace)).toBe(16384);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("kein Provider")
    );
  });
});

describe("parseLLMRequestOptionsForWorkspace", () => {
  const helpers = require("../../../utils/helpers");
  let classSpy;
  beforeEach(() => {
    classSpy = jest
      .spyOn(helpers, "getLLMProviderClass")
      .mockReturnValue({ promptWindowLimit: () => 8192 });
  });
  afterEach(() => classSpy.mockRestore());

  test("Obergrenze aus dem Modell des Workspaces", () => {
    const workspace = { chatProvider: "generic-openai", chatModel: "Chat1" };
    expect(
      parseLLMRequestOptionsForWorkspace({ max_tokens: 8192 }, workspace)
    ).toEqual({ ok: true, options: { max_tokens: 8192 } });
    const result = parseLLMRequestOptionsForWorkspace(
      { max_tokens: 8193 },
      workspace
    );
    expect(result.error).toBe(
      "max_tokens must be an integer between 1 and 8192."
    );
    expect(classSpy).toHaveBeenCalledWith({ provider: "generic-openai" });
  });

  test("ermittelt keine Obergrenze, wenn max_tokens fehlt", () => {
    expect(parseLLMRequestOptionsForWorkspace({ top_p: 0.5 }, {})).toEqual({
      ok: true,
      options: { top_p: 0.5 },
    });
    expect(parseLLMRequestOptionsForWorkspace(undefined, {}).ok).toBe(true);
    // Alias ohne allowMaxCompletionTokens zählt nicht
    parseLLMRequestOptionsForWorkspace({ max_completion_tokens: 5 }, {});
    expect(classSpy).not.toHaveBeenCalled();
  });

  test("Alias max_completion_tokens nutzt dieselbe Obergrenze (geklemmt)", () => {
    expect(
      parseLLMRequestOptionsForWorkspace(
        { max_completion_tokens: 10000 },
        { chatProvider: "generic-openai" },
        { coerce: true, allowMaxCompletionTokens: true }
      )
    ).toEqual({ ok: true, options: { max_tokens: 8192 } });
    expect(classSpy).toHaveBeenCalledTimes(1);
  });
});

describe("Fehlerantworten", () => {
  const {
    sendLLMOptionsError,
    sendOpenAIInvalidRequestError,
  } = require("../../../utils/helpers/chat/llmRequestOptions");
  const mockResponse = () => {
    const res = {
      status: jest.fn(() => res),
      json: jest.fn(() => res),
    };
    return res;
  };

  test("sendLLMOptionsError: bestehendes Format der workspace-Endpunkte", () => {
    const res = mockResponse();
    sendLLMOptionsError(res, "llmOptions.top_p must be …");
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      id: expect.any(String),
      type: "abort",
      textResponse: null,
      sources: [],
      close: true,
      error: "llmOptions.top_p must be …",
    });
  });

  test("sendOpenAIInvalidRequestError: OpenAI-Fehlerform", () => {
    const res = mockResponse();
    sendOpenAIInvalidRequestError(res, {
      ok: false,
      error: "top_p must be …",
      param: "top_p",
    });
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: {
        message: "top_p must be …",
        type: "invalid_request_error",
        param: "top_p",
        code: null,
      },
    });
  });
});

describe("shouldSeparateReasoning", () => {
  test("nur wenn Thinking tatsächlich angefordert wurde", () => {
    expect(shouldSeparateReasoning()).toBe(false);
    expect(shouldSeparateReasoning({})).toBe(false);
    expect(shouldSeparateReasoning({ max_tokens: 5, top_p: 0.5 })).toBe(false);
    expect(shouldSeparateReasoning({ chat_template_kwargs: {} })).toBe(false);
    expect(
      shouldSeparateReasoning({
        chat_template_kwargs: { enable_thinking: false },
      })
    ).toBe(false);
    expect(
      shouldSeparateReasoning({
        chat_template_kwargs: { enable_thinking: "true" },
      })
    ).toBe(false);
    expect(shouldSeparateReasoning({ reasoning_effort: "none" })).toBe(false);
    expect(
      shouldSeparateReasoning({
        chat_template_kwargs: { enable_thinking: true },
      })
    ).toBe(true);
    expect(shouldSeparateReasoning({ reasoning_effort: "low" })).toBe(true);
    expect(
      shouldSeparateReasoning({
        reasoning_effort: "high",
        chat_template_kwargs: { enable_thinking: false },
      })
    ).toBe(true);
  });
});

describe("splitThinkBlock / ThinkBlockSplitter", () => {
  test("trennt einen führenden think-Block", () => {
    expect(splitThinkBlock("<think>17*23 …</think>391")).toEqual({
      reasoning: "17*23 …",
      content: "391",
    });
  });

  test("lässt Text ohne think-Block unverändert", () => {
    expect(splitThinkBlock("Antwort")).toEqual({
      reasoning: "",
      content: "Antwort",
    });
    expect(splitThinkBlock("  Antwort <think>x</think>")).toEqual({
      reasoning: "",
      content: "  Antwort <think>x</think>",
    });
    expect(splitThinkBlock("")).toEqual({ reasoning: "", content: "" });
    expect(splitThinkBlock(null)).toEqual({ reasoning: "", content: null });
    expect(splitThinkBlock("<thi")).toEqual({ reasoning: "", content: "<thi" });
  });

  test("nicht geschlossener think-Block wird komplett Reasoning", () => {
    expect(splitThinkBlock("<think>abgeschnitten")).toEqual({
      reasoning: "abgeschnitten",
      content: "",
    });
  });

  test("Stream: Tags über Chunk-Grenzen hinweg", () => {
    const pieces = ["<th", "ink>Den", "ke</th", "in", "k>Ant", "wort"];
    const splitter = new ThinkBlockSplitter();
    let reasoning = "";
    let content = "";
    for (const piece of pieces) {
      const out = splitter.push(piece);
      reasoning += out.reasoning;
      content += out.content;
    }
    const rest = splitter.flush();
    reasoning += rest.reasoning;
    content += rest.content;
    expect(reasoning).toBe("Denke");
    expect(content).toBe("Antwort");
  });

  test("Stream: Chunk-Struktur des generischen OpenAI-Providers", () => {
    const splitter = new ThinkBlockSplitter();
    expect(splitter.push("<think>Erst")).toEqual({
      reasoning: "Erst",
      content: "",
    });
    expect(splitter.push(" denken")).toEqual({
      reasoning: " denken",
      content: "",
    });
    expect(splitter.push("</think>")).toEqual({ reasoning: "", content: "" });
    expect(splitter.push("391")).toEqual({ reasoning: "", content: "391" });
    expect(splitter.push("")).toEqual({ reasoning: "", content: "" });
    expect(splitter.flush()).toEqual({ reasoning: "", content: "" });
  });
});

describe("Swagger-Beschreibung für llmOptions", () => {
  const {
    LLM_OPTIONS_SWAGGER_PLACEHOLDER,
    LLM_OPTIONS_SWAGGER_DESCRIPTION,
  } = require("../../../utils/helpers/chat/llmRequestOptions");

  test("ohne geschweifte Klammern (swagger-autogen, requestBody)", () => {
    expect(LLM_OPTIONS_SWAGGER_DESCRIPTION).not.toMatch(/[{}]/);
    expect(LLM_OPTIONS_SWAGGER_DESCRIPTION).toMatch(/otherwise 16384/);
  });

  test("openapi.json enthält den Text an allen vier Chat-Endpunkten, keinen Platzhalter", () => {
    const spec = JSON.stringify(require("../../../swagger/openapi.json"));
    expect(spec).not.toContain(LLM_OPTIONS_SWAGGER_PLACEHOLDER);
    const occurrences = spec.split(
      JSON.stringify(LLM_OPTIONS_SWAGGER_DESCRIPTION).slice(1, -1)
    ).length;
    expect(occurrences - 1).toBe(4);
  });
});
