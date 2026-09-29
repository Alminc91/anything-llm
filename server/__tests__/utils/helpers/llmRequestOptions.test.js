/* eslint-env jest, node */
const {
  parseLLMRequestOptions,
  withLLMRequestOptions,
  shouldSeparateReasoning,
  splitThinkBlock,
  ThinkBlockSplitter,
} = require("../../../utils/helpers/chat/llmRequestOptions");

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

  test("normalisiert alle gültigen Optionen nach camelCase", () => {
    const kwargs = { enable_thinking: true, budget: 512, mode: "x" };
    const result = parseLLMRequestOptions(
      {
        max_tokens: 4096,
        top_p: 0.9,
        reasoning_effort: "high",
        chat_template_kwargs: kwargs,
        temperature: 0.1,
      },
      { allowTemperature: true }
    );
    expect(result).toEqual({
      ok: true,
      options: {
        maxTokens: 4096,
        topP: 0.9,
        reasoningEffort: "high",
        chatTemplateKwargs: { enable_thinking: true, budget: 512, mode: "x" },
        temperature: 0.1,
      },
    });
    // Kopie, nicht dieselbe Referenz (reine Funktion)
    expect(result.options.chatTemplateKwargs).not.toBe(kwargs);
  });

  describe("max_tokens", () => {
    test.each([1, 4096, 1_000_000])("akzeptiert %p", (value) => {
      expect(parseLLMRequestOptions({ max_tokens: value }).options).toEqual({
        maxTokens: value,
      });
    });
    test.each([0, -1, 1_000_001, 1.5, "4096", true, NaN, Infinity, {}, []])(
      "lehnt %p ab",
      (value) => {
        const result = parseLLMRequestOptions({ max_tokens: value });
        expect(result.ok).toBe(false);
        expect(result.error).toMatch(
          /max_tokens must be an integer between 1 and 1000000/
        );
      }
    );
  });

  describe("top_p", () => {
    test.each([0.0001, 0.5, 1])("akzeptiert %p", (value) => {
      expect(parseLLMRequestOptions({ top_p: value }).options).toEqual({
        topP: value,
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
        ).toEqual({ reasoningEffort: value });
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
      ).toEqual({ chatTemplateKwargs: { enable_thinking: true } });
    });

    test("akzeptiert ein leeres Objekt und 10 Schlüssel", () => {
      expect(
        parseLLMRequestOptions({ chat_template_kwargs: {} }).options
      ).toEqual({ chatTemplateKwargs: {} });
      const ten = Object.fromEntries(
        Array.from({ length: 10 }, (_, i) => [`k${i}`, i])
      );
      expect(
        parseLLMRequestOptions({ chat_template_kwargs: ten }).options
          .chatTemplateKwargs
      ).toEqual(ten);
    });

    test("lehnt 11 Schlüssel ab", () => {
      const eleven = Object.fromEntries(
        Array.from({ length: 11 }, (_, i) => [`k${i}`, true])
      );
      const result = parseLLMRequestOptions({ chat_template_kwargs: eleven });
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
      const result = parseLLMRequestOptions({ chat_template_kwargs: kwargs });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/chat_template_kwargs\.a /);
    });

    test("akzeptiert String mit genau 256 Zeichen", () => {
      const value = "x".repeat(256);
      expect(
        parseLLMRequestOptions({ chat_template_kwargs: { a: value } }).ok
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
        const result = parseLLMRequestOptions({
          chat_template_kwargs: { [key]: true },
        });
        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/invalid key/);
      }
    );

    test("akzeptiert Schlüssel mit 64 Zeichen und führendem Unterstrich", () => {
      const key = "_" + "a".repeat(63);
      expect(
        parseLLMRequestOptions({ chat_template_kwargs: { [key]: 1 } }).ok
      ).toBe(true);
    });

    test("lehnt __proto__/constructor/prototype als Schlüssel ab (Prototype Pollution)", () => {
      for (const raw of [
        '{"__proto__": {"polluted": true}}',
        '{"__proto__": true}',
        '{"constructor": "x"}',
        '{"prototype": 1}',
      ]) {
        const result = parseLLMRequestOptions({
          chat_template_kwargs: JSON.parse(raw),
        });
        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/invalid key/);
      }
      expect({}.polluted).toBeUndefined();
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

describe("withLLMRequestOptions", () => {
  test("liefert ohne Optionen ein gleiches Objekt ohne zusätzliche Schlüssel", () => {
    const base = { temperature: 0.7, user: null };
    const result = withLLMRequestOptions(base, {});
    expect(result).toEqual(base);
    expect(Object.keys(result)).toEqual(["temperature", "user"]);
    expect(result).not.toBe(base);
    expect(Object.keys(withLLMRequestOptions(base))).toEqual([
      "temperature",
      "user",
    ]);
  });

  test("ergänzt gesetzte Optionen, aber nie temperature", () => {
    expect(
      withLLMRequestOptions(
        { temperature: 0.7 },
        {
          maxTokens: 10,
          topP: 0.5,
          reasoningEffort: "low",
          chatTemplateKwargs: { enable_thinking: true },
          temperature: 1.5,
        }
      )
    ).toEqual({
      temperature: 0.7,
      maxTokens: 10,
      topP: 0.5,
      reasoningEffort: "low",
      chatTemplateKwargs: { enable_thinking: true },
    });
  });
});

describe("shouldSeparateReasoning", () => {
  test("nur bei Reasoning-Optionen", () => {
    expect(shouldSeparateReasoning()).toBe(false);
    expect(shouldSeparateReasoning({})).toBe(false);
    expect(shouldSeparateReasoning({ maxTokens: 5, topP: 0.5 })).toBe(false);
    expect(shouldSeparateReasoning({ reasoningEffort: "none" })).toBe(true);
    expect(shouldSeparateReasoning({ chatTemplateKwargs: {} })).toBe(true);
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
