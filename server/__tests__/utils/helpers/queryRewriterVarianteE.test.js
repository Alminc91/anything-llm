/* eslint-env jest, node */
// Query Rewriter, Variante E (issues/folgefragen-variante-e.md):
// - AK-1: System-Prompt byte-gleich zur gemessenen Vorlage (Fixture
//   queryRewritePromptE.txt, Kopie von issues/folgefragen-variante-e/
//   prompt_e.txt); User-Nachricht mit früheren Fragen byte-gleich zur Form
//   der Messung (Fixture queryRewriteFormE.json, erzeugt mit der wörtlichen
//   Python-Referenz aus fable/lib.py): 0, 1 und 6 frühere Fragen, Kürzung
//   auf 40 Wörter.
// - Bestand (D2): ohne frühere Fragen neuer Prompt, sonst Form wie bisher.
// - NAK-3: erste Nachricht und Fragen über der Wortgrenze ohne Rewrite.
const fs = require("fs");
const path = require("path");

const {
  rewriteQueryForSearch,
  buildRewriteMessages,
  REWRITE_PROMPT,
} = require("../../../utils/helpers/chat/queryRewriter");

const FIXTURES = path.join(__dirname, "fixtures");
const PROMPT_E = fs.readFileSync(
  path.join(FIXTURES, "queryRewritePromptE.txt"),
  "utf8"
);
const { faelle: FORM_CASES } = require("./fixtures/queryRewriteFormE.json");

// Workspace-Schalter an, damit keine Systemeinstellung gelesen wird
const WORKSPACE_ON = { queryRewriteMode: "on" };

function connector(reply = "Gibt es auch später Yoga-Kurse?") {
  return {
    getChatCompletion: jest.fn().mockResolvedValue({ textResponse: reply }),
  };
}

// Verlauf, wie das Widget ihn lädt: die letzten Runden als user/assistant
function historyOf(nutzer, antworten, rounds) {
  return nutzer
    .map((q, i) => [
      { role: "user", content: q },
      { role: "assistant", content: antworten[i] },
    ])
    .slice(-rounds)
    .flat();
}

const ORIGINAL_ENV = { ...process.env };
afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("AK-1: System-Prompt byte-gleich zur Messung", () => {
  test("REWRITE_PROMPT entspricht prompt_e.txt Byte für Byte", () => {
    expect(
      Buffer.from(REWRITE_PROMPT, "utf8").equals(
        fs.readFileSync(path.join(FIXTURES, "queryRewritePromptE.txt"))
      )
    ).toBe(true);
  });

  test("der Aufruf schickt genau diesen Prompt als System-Nachricht (temperature 0.1)", async () => {
    const llm = connector();
    await rewriteQueryForSearch({
      userQuery: "Auch abends?",
      chatHistory: historyOf(["Gibt es Yoga?"], ["Ja."], 1),
      LLMConnector: llm,
      workspace: WORKSPACE_ON,
      loadEarlierUserQuestions: async () => [],
    });
    const [messages, options] = llm.getChatCompletion.mock.calls[0];
    expect(messages[0]).toEqual({ role: "system", content: PROMPT_E });
    expect(options).toEqual({ temperature: 0.1 });
  });
});

describe("AK-1: Nachrichtenform mit früheren Fragen wie gemessen", () => {
  test("die Fixture deckt 0, 1 und 6 frühere Fragen ab", () => {
    expect(FORM_CASES.map((c) => c.nutzer.length - 1)).toEqual([0, 1, 6]);
  });

  test.each(FORM_CASES.map((c) => [c.name, c]))(
    "%s: User-Nachricht byte-gleich zur Python-Referenz",
    async (_name, c) => {
      // Das Widget lädt mehr als die letzte Runde (hier bis zu zwei); in die
      // Nachricht kommt wie gemessen nur die letzte.
      const chatHistory = historyOf(c.nutzer, c.antworten, 2);
      const earlierUserQuestions = c.nutzer.slice(0, -1);
      const built = buildRewriteMessages({
        userQuery: c.cur,
        chatHistory,
        earlierUserQuestions,
      });
      expect(built).toEqual([
        { role: "system", content: PROMPT_E },
        { role: "user", content: c.erwartet },
      ]);

      const llm = connector();
      await rewriteQueryForSearch({
        userQuery: c.cur,
        chatHistory,
        LLMConnector: llm,
        workspace: WORKSPACE_ON,
        loadEarlierUserQuestions: async () => earlierUserQuestions,
      });
      expect(llm.getChatCompletion).toHaveBeenCalledTimes(1);
      expect(llm.getChatCompletion.mock.calls[0][0][1]).toEqual({
        role: "user",
        content: c.erwartet,
      });
    }
  );

  test("6 frühere Fragen: nur die 5 neuesten, älteste zuerst; 5 übergebene ergeben dieselbe Nachricht", () => {
    const c = FORM_CASES.find((x) => x.nutzer.length === 7);
    const chatHistory = historyOf(c.nutzer, c.antworten, 2);
    const fromSix = buildRewriteMessages({
      userQuery: c.cur,
      chatHistory,
      earlierUserQuestions: c.nutzer.slice(0, 6),
    })[1].content;
    const fromFive = buildRewriteMessages({
      userQuery: c.cur,
      chatHistory,
      earlierUserQuestions: c.nutzer.slice(1, 6),
    })[1].content;
    expect(fromSix).toBe(fromFive);
    expect(fromSix).not.toContain(c.nutzer[0]);
    expect(fromSix).toMatch(/^Earlier user questions \(oldest first\):\n1\. /);
    expect(fromSix.match(/^\d+\. /gm)).toEqual([
      "1. ",
      "2. ",
      "3. ",
      "4. ",
      "5. ",
    ]);
  });

  test("Kürzung auf 40 Wörter: 41 Wörter mit „...“, genau 40 ohne", () => {
    const words = (n, stem) =>
      Array.from({ length: n }, (_, i) => `${stem}${i + 1}`).join(" ");
    const content = buildRewriteMessages({
      userQuery: "Und dann?",
      chatHistory: historyOf(["Frage"], ["Antwort"], 1),
      earlierUserQuestions: [words(41, "a"), words(40, "b")],
    })[1].content;
    expect(content).toContain(`1. ${words(40, "a")}...\n`);
    expect(content).toContain(`2. ${words(40, "b")}\n\n`);
    expect(content).not.toContain("a41");
  });

  test("Chat history mit früheren Fragen bleibt bei der letzten Runde, auch mit QUERY_REWRITE_MAX_HISTORY", () => {
    process.env.QUERY_REWRITE_MAX_HISTORY = "3";
    const content = buildRewriteMessages({
      userQuery: "Und abends?",
      chatHistory: historyOf(["F1", "F2", "F3"], ["A1", "A2", "A3"], 3),
      earlierUserQuestions: ["F1", "F2"],
    })[1].content;
    expect(content).toBe(
      "Earlier user questions (oldest first):\n1. F1\n2. F2\n\n" +
        "Chat history:\nUser: F3\nAssistant: A3\n\nLatest question: Und abends?"
    );
  });
});

describe("Bestand (D2): ohne frühere Fragen neuer Prompt, Form wie bisher", () => {
  const CHAT_HISTORY = [
    { role: "user", content: "Gibt es Yoga?" },
    { role: "assistant", content: "Ja:\n\n1. Hatha\n2. Yin" },
    { role: "user", content: "Ich bin Anfänger" },
    { role: "assistant", content: "Dann passt  Hatha sanft." },
  ];
  // Form wie bisher: bis zu zwei Runden, kurze Antworten unverändert
  const TODAY =
    "Chat history:\nUser: Gibt es Yoga?\nAssistant: Ja:\n\n1. Hatha\n2. Yin\n" +
    "User: Ich bin Anfänger\nAssistant: Dann passt  Hatha sanft.\n\n" +
    "Latest question: Und später?";

  test.each([
    ["ohne Parameter", {}],
    [
      "Lader liefert null (Datenbankfehler)",
      { loadEarlierUserQuestions: async () => null },
    ],
  ])("%s: kein Block, Verlauf wie bisher", async (_name, extra) => {
    const llm = connector();
    await rewriteQueryForSearch({
      userQuery: "Und später?",
      chatHistory: CHAT_HISTORY,
      LLMConnector: llm,
      workspace: WORKSPACE_ON,
      ...extra,
    });
    const [system, user] = llm.getChatCompletion.mock.calls[0][0];
    expect(system.content).toBe(PROMPT_E);
    expect(user.content).toBe(TODAY);
    expect(user.content).not.toContain("Earlier user questions");
  });

  test("lange Antwort (über 150 Wörter) wie bisher gekürzt", () => {
    const long = Array.from({ length: 160 }, (_, i) => `w${i + 1}`).join(" ");
    const content = buildRewriteMessages({
      userQuery: "Und?",
      chatHistory: [
        { role: "user", content: "Frage" },
        { role: "assistant", content: long },
      ],
    })[1].content;
    const first150 = long.split(" ").slice(0, 150).join(" ");
    expect(content).toBe(
      `Chat history:\nUser: Frage\nAssistant: ${first150}...\n\nLatest question: Und?`
    );
  });

  test("Nachbearbeitung wie bisher: think-Tags weg, erste Zeile, gleiche Frage bleibt Original", async () => {
    const run = async (reply, userQuery = "Und später?") =>
      await rewriteQueryForSearch({
        userQuery,
        chatHistory: CHAT_HISTORY,
        LLMConnector: connector(reply),
        workspace: WORKSPACE_ON,
        loadEarlierUserQuestions: async () => ["Gibt es Yoga?"],
      });
    expect(
      await run("<think>überlegen</think>Gibt es später Yoga?\nZweite Zeile")
    ).toBe("Gibt es später Yoga?");
    expect(await run("  ")).toBe("Und später?");
    expect(await run("und SPÄTER?")).toBe("Und später?");
  });
});

describe("NAK-3: kein Rewrite bei erster Nachricht und über der Wortgrenze", () => {
  test("erste Nachricht (leerer Verlauf): Original, kein LLM-Aufruf", async () => {
    const llm = connector();
    const result = await rewriteQueryForSearch({
      userQuery: "Gibt es Yoga?",
      chatHistory: [],
      LLMConnector: llm,
      workspace: WORKSPACE_ON,
      loadEarlierUserQuestions: async () => ["Gibt es Malkurse?"],
    });
    expect(result).toBe("Gibt es Yoga?");
    expect(llm.getChatCompletion).not.toHaveBeenCalled();
  });

  test("13 Wörter: Original, kein LLM-Aufruf; 12 Wörter: Rewrite", async () => {
    const thirteen =
      "Ich suche noch einen Yogakurs für Anfänger am Abend in der Nähe bitte";
    const twelve =
      "Ich suche einen Yogakurs für Anfänger am Abend in der Nähe bitte";
    expect(thirteen.split(" ")).toHaveLength(13);
    expect(twelve.split(" ")).toHaveLength(12);
    const args = {
      chatHistory: historyOf(["Gibt es Yoga?"], ["Ja."], 1),
      workspace: WORKSPACE_ON,
      loadEarlierUserQuestions: async () => ["Hallo"],
    };
    const llmLong = connector();
    expect(
      await rewriteQueryForSearch({
        ...args,
        userQuery: thirteen,
        LLMConnector: llmLong,
      })
    ).toBe(thirteen);
    expect(llmLong.getChatCompletion).not.toHaveBeenCalled();

    const llmShort = connector();
    await rewriteQueryForSearch({
      ...args,
      userQuery: twelve,
      LLMConnector: llmShort,
    });
    expect(llmShort.getChatCompletion).toHaveBeenCalledTimes(1);
  });

  test("Schalter aus: kein Rewrite, auch mit früheren Fragen", async () => {
    const llm = connector();
    expect(
      await rewriteQueryForSearch({
        userQuery: "Und abends?",
        chatHistory: historyOf(["Gibt es Yoga?"], ["Ja."], 1),
        LLMConnector: llm,
        workspace: { queryRewriteMode: "off" },
        loadEarlierUserQuestions: async () => ["Hallo"],
      })
    ).toBe("Und abends?");
    expect(llm.getChatCompletion).not.toHaveBeenCalled();
  });
});

// Fixliste rc7 E-R2: rewriteQueryForSearch bekommt einen Lader und ruft ihn
// erst nach shouldRewrite auf; ohne Rewrite läuft keine Abfrage.
describe("E-R2: frühere Fragen erst laden, wenn umgeschrieben wird", () => {
  const loader = (list = ["Gibt es Gebärdensprache?"]) =>
    jest.fn().mockResolvedValue(list);
  const base = {
    userQuery: "Und abends?",
    chatHistory: historyOf(["Für Anfänger"], ["Ja."], 1),
    workspace: WORKSPACE_ON,
  };

  test("Rewrite: Lader genau einmal, seine Fragen stehen im Block", async () => {
    const load = loader();
    const llm = connector();
    await rewriteQueryForSearch({
      ...base,
      LLMConnector: llm,
      loadEarlierUserQuestions: load,
    });
    expect(load).toHaveBeenCalledTimes(1);
    expect(llm.getChatCompletion.mock.calls[0][0][1].content).toMatch(
      /^Earlier user questions \(oldest first\):\n1\. Gibt es Gebärdensprache\?\n\n/
    );
  });

  test.each([
    ["erste Nachricht (leerer Verlauf)", { chatHistory: [] }],
    [
      "über der Wortgrenze",
      {
        userQuery:
          "Ich suche noch einen Yogakurs für Anfänger am Abend in der Nähe bitte",
      },
    ],
    ["Schalter aus", { workspace: { queryRewriteMode: "off" } }],
  ])("%s: Lader nie aufgerufen, kein LLM-Aufruf", async (_name, extra) => {
    const load = loader();
    const llm = connector();
    const args = { ...base, ...extra };
    expect(
      await rewriteQueryForSearch({
        ...args,
        LLMConnector: llm,
        loadEarlierUserQuestions: load,
      })
    ).toBe(args.userQuery);
    expect(load).not.toHaveBeenCalled();
    expect(llm.getChatCompletion).not.toHaveBeenCalled();
  });
});
