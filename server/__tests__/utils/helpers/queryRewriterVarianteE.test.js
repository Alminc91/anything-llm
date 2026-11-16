/* eslint-env jest, node */
// Query Rewriter, Variante E mit Nachrichtenform E2
// (issues/folgefragen-variante-e.md, Abschnitt 4, D4):
// - AK-1: System-Prompt byte-gleich zur gemessenen Vorlage (Fixture
//   queryRewritePromptE.txt, Kopie von issues/folgefragen-variante-e/
//   prompt_e.txt); User-Nachricht byte-gleich zur Form E2 der Messung
//   (Fixture queryRewriteFormE2.json, erzeugt mit form_e2_referenz.py): 1 und
//   2 Runden ohne frühere Fragen, 1 und 7 frühere Fragen, Kürzung auf 40
//   Wörter. Den Zufallsabgleich (400 Fälle) macht abgleich_form_e2.js.
// - Bestand (D2): eine Form für alle Aufrufer; ohne frühere Fragen fehlt nur
//   der Block.
// - NAK-3: erste Nachricht und Fragen über der Wortgrenze ohne Rewrite.
// - E-R2: frühere Fragen lädt der Rewriter erst, wenn er umschreibt.
const fs = require("fs");
const path = require("path");

const {
  rewriteQueryForSearch,
  buildRewriteMessages,
  rewriteHistoryTurns,
  REWRITE_PROMPT,
} = require("../../../utils/helpers/chat/queryRewriter");

const FIXTURES = path.join(__dirname, "fixtures");
const PROMPT_E = fs.readFileSync(
  path.join(FIXTURES, "queryRewritePromptE.txt"),
  "utf8"
);
const { faelle: FORM_CASES } = require("./fixtures/queryRewriteFormE2.json");

// Workspace-Schalter an, damit keine Systemeinstellung gelesen wird
const WORKSPACE_ON = { queryRewriteMode: "on" };

function connector(reply = "Gibt es auch später Yoga-Kurse?") {
  return {
    getChatCompletion: jest.fn().mockResolvedValue({ textResponse: reply }),
  };
}

// ganzer Verlauf als user/assistant, je Frage eine Runde; die letzten
// Runden wählt buildRewriteMessages selbst
function historyOf(nutzer, antworten) {
  return nutzer.flatMap((q, i) => [
    { role: "user", content: q },
    { role: "assistant", content: antworten[i] },
  ]);
}

const userMessage = (input) => buildRewriteMessages(input)[1].content;

const ORIGINAL_ENV = { ...process.env };
beforeEach(() => {
  delete process.env.QUERY_REWRITE_MAX_HISTORY;
});
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
      chatHistory: historyOf(["Gibt es Yoga?"], ["Ja."]),
      LLMConnector: llm,
      workspace: WORKSPACE_ON,
      loadEarlierUserQuestions: async () => [],
    });
    const [messages, options] = llm.getChatCompletion.mock.calls[0];
    expect(messages[0]).toEqual({ role: "system", content: PROMPT_E });
    expect(options).toEqual({ temperature: 0.1 });
  });
});

describe("AK-1: Nachrichtenform E2 wie gemessen", () => {
  test("die Fixture deckt 1 und 2 Runden ohne frühere Fragen, 1 und 7 frühere Fragen ab", () => {
    expect(
      FORM_CASES.map((c) => [c.nutzer.length, Math.max(0, c.nutzer.length - 2)])
    ).toEqual([
      [1, 0],
      [2, 0],
      [3, 1],
      [9, 7],
    ]);
  });

  // Vertrag wie abgleich_form_e2.js: chatHistory = ganzer Verlauf,
  // earlierUserQuestions = alle Fragen vor den letzten 2 Runden
  test.each(FORM_CASES.map((c) => [c.name, c]))(
    "%s: User-Nachricht byte-gleich zur Python-Referenz",
    async (_name, c) => {
      const chatHistory = historyOf(c.nutzer, c.antworten);
      const earlierUserQuestions = c.nutzer.slice(0, -2);
      expect(
        buildRewriteMessages({
          userQuery: c.cur,
          chatHistory,
          earlierUserQuestions,
        })
      ).toEqual([
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

  test("7 frühere Fragen: nur die 5 neuesten, älteste zuerst; 5 übergebene ergeben dieselbe Nachricht", () => {
    const c = FORM_CASES.find((x) => x.nutzer.length === 9);
    const chatHistory = historyOf(c.nutzer, c.antworten);
    const fromSeven = userMessage({
      userQuery: c.cur,
      chatHistory,
      earlierUserQuestions: c.nutzer.slice(0, 7),
    });
    const fromFive = userMessage({
      userQuery: c.cur,
      chatHistory,
      earlierUserQuestions: c.nutzer.slice(2, 7),
    });
    expect(fromSeven).toBe(fromFive);
    expect(fromSeven).not.toContain(c.nutzer[0]);
    expect(fromSeven).not.toContain(c.nutzer[1]);
    expect(fromSeven.match(/^\d+\. /gm)).toEqual([
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
    const content = userMessage({
      userQuery: "Und dann?",
      chatHistory: historyOf(["Frage"], ["Antwort"]),
      earlierUserQuestions: [words(41, "a"), words(40, "b")],
    });
    expect(content).toContain(`1. ${words(40, "a")}...\n`);
    expect(content).toContain(`2. ${words(40, "b")}\n\n`);
    expect(content).not.toContain("a41");
  });

  test("Chat history: die letzten 2 Runden, Fragen ungekürzt, Antworten auf 150 Wörter", () => {
    const long = Array.from({ length: 160 }, (_, i) => `w${i + 1}`).join(" ");
    const question = Array.from({ length: 60 }, (_, i) => `q${i + 1}`).join(
      " "
    );
    const content = userMessage({
      userQuery: "Und?",
      chatHistory: historyOf(
        ["Alt 1", "Alt 2", question, "Frage 4"],
        ["A1", "A2", long, "A4"]
      ),
      earlierUserQuestions: ["Alt 1", "Alt 2"],
    });
    const first150 = long.split(" ").slice(0, 150).join(" ");
    expect(content).toBe(
      "Earlier user questions (oldest first):\n1. Alt 1\n2. Alt 2\n\n" +
        `Chat history:\nUser: ${question}\nAssistant: ${first150}...\n` +
        "User: Frage 4\nAssistant: A4\n\nLatest question: Und?"
    );
  });
});

// E-R5 (E-N5): QUERY_REWRITE_MAX_HISTORY nur als ganze Zahl ab 1, sonst 2
describe("Runden im Block „Chat history“ (QUERY_REWRITE_MAX_HISTORY)", () => {
  const chatHistory = historyOf(
    ["F1", "F2", "F3", "F4"],
    ["A1", "A2", "A3", "A4"]
  );
  const shown = () =>
    userMessage({ userQuery: "Und?", chatHistory })
      .split("\n")
      .filter((line) => line.startsWith("User: "));

  test.each([
    [undefined, 2],
    ["1", 1],
    ["2", 2],
    ["3", 3],
    ["0", 2],
    ["-1", 2],
    ["1.5", 2],
    ["3abc", 2],
    ["abc", 2],
    ["", 2],
  ])("Wert %p: %i Runden", (value, turns) => {
    if (value !== undefined) process.env.QUERY_REWRITE_MAX_HISTORY = value;
    expect(rewriteHistoryTurns()).toBe(turns);
    expect(shown()).toEqual(
      ["F1", "F2", "F3", "F4"].slice(-turns).map((q) => `User: ${q}`)
    );
  });
});

describe("Bestand (D2): eine Form für alle Aufrufer, ohne frühere Fragen ohne Block", () => {
  const CHAT_HISTORY = [
    { role: "user", content: "Gibt es Yoga?" },
    { role: "assistant", content: "Ja:\n\n1. Hatha\n2. Yin" },
    { role: "user", content: "Ich bin Anfänger" },
    { role: "assistant", content: "Dann passt  Hatha sanft." },
  ];
  // Form E2 ohne Block: die letzten 2 Runden, Antworten mit normalisiertem
  // Leerraum (shortenWords wie gemessen)
  const WITHOUT_EARLIER =
    "Chat history:\nUser: Gibt es Yoga?\nAssistant: Ja: 1. Hatha 2. Yin\n" +
    "User: Ich bin Anfänger\nAssistant: Dann passt Hatha sanft.\n\n" +
    "Latest question: Und später?";

  test.each([
    ["ohne Lader (Workspace- und API-Chat)", {}],
    ["Lader liefert []", { loadEarlierUserQuestions: async () => [] }],
    [
      "Lader liefert null (Datenbankfehler)",
      { loadEarlierUserQuestions: async () => null },
    ],
  ])("%s: kein Block, sonst dieselbe Form", async (_name, extra) => {
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
    expect(user.content).toBe(WITHOUT_EARLIER);
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
  test("13 Wörter: Original, kein LLM-Aufruf; 12 Wörter: Rewrite", async () => {
    const thirteen =
      "Ich suche noch einen Yogakurs für Anfänger am Abend in der Nähe bitte";
    const twelve =
      "Ich suche einen Yogakurs für Anfänger am Abend in der Nähe bitte";
    expect(thirteen.split(" ")).toHaveLength(13);
    expect(twelve.split(" ")).toHaveLength(12);
    const args = {
      chatHistory: historyOf(["Gibt es Yoga?"], ["Ja."]),
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
});

// Fixliste rc7 E-R2: rewriteQueryForSearch bekommt einen Lader und ruft ihn
// erst nach shouldRewrite auf; ohne Rewrite läuft keine Abfrage.
describe("E-R2: frühere Fragen erst laden, wenn umgeschrieben wird", () => {
  const loader = (list = ["Gibt es Gebärdensprache?"]) =>
    jest.fn().mockResolvedValue(list);
  const base = {
    userQuery: "Und abends?",
    chatHistory: historyOf(["Für Anfänger"], ["Ja."]),
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
