/* eslint-env jest, node */
// Query Rewriter, Variante E mit Form E2 im Widget-Chat
// (issues/folgefragen-variante-e.md):
// - AK-2: der Rewriter bekommt die früheren Fragen derselben Unterhaltung,
//   unabhängig von message_limit; höchstens 2 (E-R6, Nutzer 16.11. abends,
//   vorher 5), älteste zuerst, ohne die Fragen der Runden im Block „Chat
//   history“ (die letzten 2 geladenen) und ohne die aktuelle; Antworten ohne
//   Protokollzeilen (E-R1).
// - NAK-1: Fragen anderer Sitzungen, Unterhaltungen, Widgets und gelöschte
//   Zeilen erscheinen nie.
// - NAK-2: Verlauf und Prompt des Antwortmodells (compressMessages), der
//   Verlauf des Metadatenfilters und die gespeicherte Zeile bleiben wie
//   bisher.
// - NAK-3 (Widget): erste Nachricht ohne zusätzliche Abfrage und ohne Rewrite.
// Test-Gerüst wie embedStreamFollowUps.test.js; echte Modelle EmbedChats und
// queryRewriter, prisma als Tabelle im Speicher (Auswertung wie SQLite für
// die hier genutzten Bedingungen; die echte SQL-Bindung prüft
// models/embedChatsEarlierPrompts.test.js).
jest.mock("../../../utils/prisma", () => ({
  embed_chats: { findMany: jest.fn() },
  system_settings: { findFirst: jest.fn().mockResolvedValue(null) },
}));
jest.mock("../../../models/workspace", () => ({
  Workspace: {
    _resolveVectorSearchMode: jest.fn().mockResolvedValue("default"),
  },
}));
jest.mock("../../../utils/helpers", () => ({
  getVectorDbClass: jest.fn(),
  getLLMProvider: jest.fn(),
}));
jest.mock("../../../utils/chats/index", () => ({
  chatPrompt: jest.fn().mockResolvedValue("System"),
  sourceIdentifier: jest.fn(),
}));
jest.mock("../../../utils/chats/courseInventory", () => ({
  courseInventoryGuard: jest.fn().mockResolvedValue(null),
}));
jest.mock("../../../utils/DocumentManager", () => ({
  DocumentManager: class {
    pinnedDocs() {
      return Promise.resolve([]);
    }
  },
}));
jest.mock("../../../utils/chats/metadataFilterResolver", () => ({
  startMetadataFilterResolution: jest.fn(() => null),
}));
jest.mock("../../../utils/helpers/chat", () => ({
  fillSourceWindow: jest.fn(({ searchResults = [] }) => ({
    sources: searchResults,
    contextTexts: searchResults.map((s) => s.text),
  })),
}));

const prisma = require("../../../utils/prisma");
const helpers = require("../../../utils/helpers");
const {
  startMetadataFilterResolution,
} = require("../../../utils/chats/metadataFilterResolver");
const { EmbedChats } = require("../../../models/embedChats");
const { streamChatWithForEmbed } = require("../../../utils/chats/embed");

const EMBED_ID = 3;
const SESSION = "sess";
const CONVERSATION = "conv";
const MESSAGE = "Gibt es auch später Kurse?";
const REWRITTEN = "Gibt es auch später Yoga-Kurse?";
const REPLY = "Ja, es gibt Yoga am Abend.";

// Antwort mit Zeilenumbruch und doppeltem Leerzeichen: das Antwortmodell
// bekommt sie unverändert, der Rewriter wie gemessen auf eine Zeile gekürzt
const answer = (n) => `Antwort ${n}:\n\n- Punkt  eins`;
const row = (id, prompt, extra = {}) => ({
  id,
  embed_id: EMBED_ID,
  prompt,
  response: JSON.stringify({ text: answer(id), sources: [] }),
  session_id: SESSION,
  conversation_id: CONVERSATION,
  include: true,
  ...extra,
});

// Vier eigene Runden (1, 3, 6, 8) mit fremden Zeilen dazwischen
const FOREIGN_PROMPTS = [
  "FREMDE SITZUNG: Gibt es Malkurse?",
  "ANDERE UNTERHALTUNG: Gibt es Spanisch?",
  "GELÖSCHT: Gibt es Töpfern?",
  "ANDERES WIDGET: Gibt es Tanz?",
];
const FOUR_ROUNDS = () => [
  row(1, "Gibt es Yoga?"),
  row(2, FOREIGN_PROMPTS[0], { session_id: "fremd" }),
  row(3, "Ich bin Anfänger"),
  row(4, FOREIGN_PROMPTS[1], { conversation_id: "andere" }),
  row(5, FOREIGN_PROMPTS[2], { include: false }),
  row(6, "Und am Abend?"),
  row(7, FOREIGN_PROMPTS[3], { embed_id: 99 }),
  row(8, "Wie teuer ist das?"),
];

// Gemessene Form E2 (Abschnitt 4): frühere Fragen vor den letzten 2
// Runden, dann diese 2 Runden
const EXPECTED_REWRITE_USER =
  "Earlier user questions (oldest first):\n" +
  "1. Gibt es Yoga?\n2. Ich bin Anfänger\n\n" +
  "Chat history:\nUser: Und am Abend?\nAssistant: Antwort 6: - Punkt eins\n" +
  "User: Wie teuer ist das?\nAssistant: Antwort 8: - Punkt eins\n\n" +
  `Latest question: ${MESSAGE}`;

let TABLE = [];

function matches(r, where) {
  return Object.entries(where).every(([key, value]) => {
    if (key === "OR") return value.some((sub) => matches(r, sub));
    if (value !== null && typeof value === "object") {
      const ops = Object.keys(value);
      if (ops.length !== 1 || ops[0] !== "lt")
        throw new Error(`Bedingung nicht nachgebildet: ${key}`);
      return r[key] < value.lt;
    }
    return r[key] === value;
  });
}

function findMany({ where, select, orderBy, take }) {
  const direction = orderBy?.id === "desc" ? -1 : 1;
  let rows = TABLE.filter((r) => matches(r, where)).sort(
    (a, b) => (a.id - b.id) * direction
  );
  if (take !== undefined) rows = rows.slice(0, take);
  if (select)
    rows = rows.map((r) =>
      Object.fromEntries(Object.keys(select).map((key) => [key, r[key]]))
    );
  return Promise.resolve(rows.map((r) => ({ ...r })));
}

function makeEmbed(messageLimit, queryRewriteMode = "on") {
  return {
    id: EMBED_ID,
    chat_mode: "chat",
    message_limit: messageLimit,
    visual_config: JSON.stringify({ courseCards: "off" }),
    workspace: {
      id: 9,
      slug: "chatbot",
      messagesLimit: null,
      topN: 4,
      queryRewriteMode,
    },
  };
}

let newSpy;
beforeEach(() => {
  jest.clearAllMocks();
  TABLE = FOUR_ROUNDS();
  prisma.embed_chats.findMany.mockImplementation(findMany);
  newSpy = jest
    .spyOn(EmbedChats, "new")
    .mockResolvedValue({ chat: { id: 42 }, message: null });
  jest.spyOn(console, "log").mockImplementation(() => {});
  helpers.getVectorDbClass.mockReturnValue({
    hasNamespace: jest.fn().mockResolvedValue(true),
    namespaceCount: jest.fn().mockResolvedValue(10),
    performSimilaritySearch: jest.fn().mockResolvedValue({
      contextTexts: [],
      sources: [],
      message: null,
    }),
  });
});
afterEach(() => jest.restoreAllMocks());

async function run({
  messageLimit = 2,
  sessionId = SESSION,
  conversationId = CONVERSATION,
  message = MESSAGE,
  queryRewriteMode = "on",
} = {}) {
  const response = {
    locals: {},
    write: jest.fn(),
    on: jest.fn(),
    removeListener: jest.fn(),
  };
  const connector = {
    defaultTemp: 0.7,
    promptWindowLimit: jest.fn().mockReturnValue(4096),
    compressMessages: jest.fn().mockResolvedValue([]),
    streamingEnabled: jest.fn().mockReturnValue(true),
    // nur der Rewriter ruft getChatCompletion (Antwort läuft als Stream)
    getChatCompletion: jest
      .fn()
      .mockResolvedValue({ textResponse: REWRITTEN, metrics: {} }),
    streamGetChatCompletion: jest.fn().mockResolvedValue({ metrics: {} }),
    handleStream: jest.fn().mockResolvedValue(REPLY),
  };
  helpers.getLLMProvider.mockReturnValue(connector);
  const vectorDb = helpers.getVectorDbClass();
  helpers.getVectorDbClass.mockReturnValue(vectorDb);
  await streamChatWithForEmbed(
    response,
    makeEmbed(messageLimit, queryRewriteMode),
    message,
    sessionId,
    { conversationId, displayMode: "bubble" }
  );
  const rewriteCalls = connector.getChatCompletion.mock.calls;
  return {
    connector,
    vectorDb,
    rewriteUser: rewriteCalls[0]?.[0]?.[1]?.content ?? null,
    rewriteCalls,
  };
}

// prisma-Aufrufe mit select (Abfrage der früheren Fragen)
const earlierQueries = () =>
  prisma.embed_chats.findMany.mock.calls
    .map(([args]) => args)
    .filter((args) => args.select);

describe("AK-2: frühere Fragen derselben Unterhaltung für den Rewriter", () => {
  test("message_limit 2 mit 4 Runden: zwei frühere Fragen, älteste zuerst, vor den 2 Runden im Block", async () => {
    const { rewriteUser, vectorDb } = await run({ messageLimit: 2 });
    expect(rewriteUser).toBe(EXPECTED_REWRITE_USER);
    // die umgeschriebene Frage geht an die Suche
    expect(vectorDb.performSimilaritySearch.mock.calls[0][0].input).toBe(
      REWRITTEN
    );
    // eine zusätzliche, sparsame Abfrage: nur prompt, vor der letzten Runde
    const queries = earlierQueries();
    expect(queries).toHaveLength(1);
    expect(queries[0]).toMatchObject({
      select: { prompt: true },
      take: 2,
      orderBy: { id: "desc" },
      where: {
        embed_id: EMBED_ID,
        include: true,
        conversation_id: CONVERSATION,
        session_id: SESSION,
        id: { lt: 6 },
      },
    });
  });

  test("unabhängig von message_limit: 2 und 20 ergeben dieselbe Rewriter-Nachricht", async () => {
    for (const messageLimit of [2, 20]) {
      jest.clearAllMocks();
      prisma.embed_chats.findMany.mockImplementation(findMany);
      const { rewriteUser } = await run({ messageLimit });
      expect(rewriteUser).toBe(EXPECTED_REWRITE_USER);
    }
  });

  test("message_limit 1: eine Runde im Block wie heute, davor die 2 neuesten Fragen bei den früheren", async () => {
    const { rewriteUser } = await run({ messageLimit: 1 });
    expect(rewriteUser).toBe(
      "Earlier user questions (oldest first):\n" +
        "1. Ich bin Anfänger\n2. Und am Abend?\n\n" +
        "Chat history:\nUser: Wie teuer ist das?\nAssistant: Antwort 8: - Punkt eins\n\n" +
        `Latest question: ${MESSAGE}`
    );
  });

  // E-R6 (Nutzer 16.11. abends): höchstens 2 frühere Fragen, der Rewriter
  // soll kaum mehr wissen als das Antwortmodell (2 Runden)
  test("höchstens 2 frühere Fragen: 4 Fragen vor den 2 Runden im Block ergeben die 2 neuesten, älteste zuerst", async () => {
    TABLE = Array.from({ length: 6 }, (_, i) => row(i + 1, `Frage ${i + 1}`));
    const { rewriteUser } = await run({ messageLimit: 2 });
    expect(rewriteUser).toBe(
      "Earlier user questions (oldest first):\n" +
        "1. Frage 3\n2. Frage 4\n\n" +
        "Chat history:\nUser: Frage 5\nAssistant: Antwort 5: - Punkt eins\n" +
        "User: Frage 6\nAssistant: Antwort 6: - Punkt eins\n\n" +
        `Latest question: ${MESSAGE}`
    );
    expect(earlierQueries()[0]).toMatchObject({
      take: 2,
      where: { id: { lt: 5 } },
    });
  });

  // E-R5: die Grenze der früheren Fragen kommt aus denselben Zeilen wie der
  // Rewriter-Verlauf, auch wenn convertToPromptHistory eine Zeile verwirft
  test("verworfene Zeile im Verlauf: frühere Fragen enden vor der ersten gezeigten Runde", async () => {
    TABLE = FOUR_ROUNDS().map((r) =>
      r.id === 6 ? { ...r, response: JSON.stringify({ sources: [] }) } : r
    );
    // message_limit 2 lädt 6 und 8; 6 hat keinen Antworttext, im Block steht
    // nur 8, die Frage aus 6 gehört zu den früheren; davon die 2 neuesten
    const { rewriteUser } = await run({ messageLimit: 2 });
    expect(rewriteUser).toBe(
      "Earlier user questions (oldest first):\n" +
        "1. Ich bin Anfänger\n2. Und am Abend?\n\n" +
        "Chat history:\nUser: Wie teuer ist das?\nAssistant: Antwort 8: - Punkt eins\n\n" +
        `Latest question: ${MESSAGE}`
    );
    expect(earlierQueries()[0].where.id).toEqual({ lt: 8 });

    // message_limit 20: im Block 3 und 8, davor nur 1
    jest.clearAllMocks();
    prisma.embed_chats.findMany.mockImplementation(findMany);
    const wide = await run({ messageLimit: 20 });
    expect(wide.rewriteUser).toBe(
      "Earlier user questions (oldest first):\n1. Gibt es Yoga?\n\n" +
        "Chat history:\nUser: Ich bin Anfänger\nAssistant: Antwort 3: - Punkt eins\n" +
        "User: Wie teuer ist das?\nAssistant: Antwort 8: - Punkt eins\n\n" +
        `Latest question: ${MESSAGE}`
    );
    expect(earlierQueries()[0].where.id).toEqual({ lt: 3 });
  });

  test("eine frühere Runde: kein Block, nur diese Runde", async () => {
    TABLE = [row(1, "Gibt es Yoga?")];
    const { rewriteUser } = await run();
    expect(rewriteUser).toBe(
      "Chat history:\nUser: Gibt es Yoga?\nAssistant: Antwort 1: - Punkt eins\n\n" +
        `Latest question: ${MESSAGE}`
    );
  });
});

// Fixliste rc7 E-R1, D3: der Rewriter bekommt die Antworten ohne
// Protokollzeilen (Kurskarten-Marker, Teaserzeilen, Folgefragen-Vorschläge),
// so wie gemessen; das Antwortmodell und der Metadatenfilter bekommen sie
// weiter (restoreCardsMarkers, NAK-2).
describe("E-R1: Rewriter ohne Protokollzeilen, Antwortmodell mit", () => {
  const MARKED = {
    text: "Antwort 8: Hatha Yoga passt.",
    sources: [],
    courseCardsMarker: [0],
    courseTeaserLines: [{ index: 0, text: "Sanft starten." }],
    followUps: ["Gibt es Pilates?", "Wann beginnt der Kurs?"],
  };
  // Altdatensatz (vor FF1): Folgefragen-Zeile noch im gespeicherten Text
  const LEGACY_TEXT =
    "Antwort 6: Yoga am Abend.\n[[FRAGEN: Gibt es Tanz? | Kosten?]]";

  beforeEach(() => {
    TABLE = [
      row(1, "Gibt es Yoga?"),
      row(3, "Ich bin Anfänger"),
      row(6, "Und am Abend?", {
        response: JSON.stringify({ text: LEGACY_TEXT, sources: [] }),
      }),
      row(8, "Wie teuer ist das?", { response: JSON.stringify(MARKED) }),
    ];
  });

  test("Rewriter-Nachricht ohne [[KARTEN, [[TEASER und [[FRAGEN", async () => {
    const { rewriteUser } = await run({ messageLimit: 2 });
    expect(rewriteUser).toContain("Hatha Yoga passt.");
    for (const marker of [
      "[[KARTEN",
      "[[TEASER",
      "[[FRAGEN",
      "Sanft starten.",
      "Gibt es Pilates?",
      "Gibt es Tanz?",
    ])
      expect(rewriteUser).not.toContain(marker);
  });

  test("Antwortmodell und Metadatenfilter bekommen die Zeilen weiter (wie bisher)", async () => {
    const { connector } = await run({ messageLimit: 2 });
    const answers = (history) =>
      history.filter((m) => m.role === "assistant").map((m) => m.content);
    const expected = [
      "Antwort 6: Yoga am Abend.",
      "[[KARTEN: 0]]\n[[TEASER 0: Sanft starten.]]\nAntwort 8: Hatha Yoga passt.\n" +
        "[[FRAGEN: Gibt es Pilates? | Wann beginnt der Kurs?]]",
    ];
    const [input] = connector.compressMessages.mock.calls[0];
    expect(answers(input.chatHistory)).toEqual(expected);
    const [filterInput] = startMetadataFilterResolution.mock.calls[0];
    expect(answers(filterInput.chatHistory)).toEqual(expected);
  });
});

describe("NAK-1: nur Fragen derselben Sitzung und Unterhaltung", () => {
  test("fremde Sitzung, andere Unterhaltung, anderes Widget und gelöschte Zeilen erscheinen nie", async () => {
    for (const messageLimit of [2, 20]) {
      jest.clearAllMocks();
      prisma.embed_chats.findMany.mockImplementation(findMany);
      const { rewriteUser } = await run({ messageLimit });
      for (const foreign of FOREIGN_PROMPTS)
        expect(rewriteUser).not.toContain(foreign);
    }
  });

  test("fremde Sitzung mit bekannter conversationId sieht keine Frage des Besitzers", async () => {
    const { rewriteUser } = await run({ sessionId: "fremd" });
    // die fremde Sitzung hat nur ihre eigene Runde: kein Block
    expect(rewriteUser).toBe(
      `Chat history:\nUser: ${FOREIGN_PROMPTS[0]}\nAssistant: Antwort 2: - Punkt eins\n\n` +
        `Latest question: ${MESSAGE}`
    );
    for (const own of ["Gibt es Yoga?", "Ich bin Anfänger", "Und am Abend?"])
      expect(rewriteUser).not.toContain(own);
    expect(earlierQueries()[0].where.session_id).toBe("fremd");
  });
});

describe("NAK-2: Antwortmodell, Metadatenfilter und Speichern wie bisher", () => {
  // Verlauf nach message_limit 2: genau die Runden 6 und 8, Antworten
  // unverändert (mit Zeilenumbruch und doppeltem Leerzeichen)
  const EXPECTED_HISTORY = [
    { role: "user", content: "Und am Abend?" },
    { role: "assistant", content: answer(6) },
    { role: "user", content: "Wie teuer ist das?" },
    { role: "assistant", content: answer(8) },
  ];

  test("compressMessages bekommt genau den Verlauf nach message_limit, ohne frühere Fragen", async () => {
    const { connector } = await run({ messageLimit: 2 });
    expect(connector.compressMessages).toHaveBeenCalledTimes(1);
    const [input, rawHistory] = connector.compressMessages.mock.calls[0];
    expect(input.userPrompt).toBe(MESSAGE);
    expect(input.chatHistory).toEqual(EXPECTED_HISTORY);
    expect(input.contextTexts).toEqual([]);
    expect(rawHistory.map((r) => r.id)).toEqual([6, 8]);
    const sent = JSON.stringify(connector.compressMessages.mock.calls[0]);
    expect(sent).not.toContain("Gibt es Yoga?");
    expect(sent).not.toContain("Ich bin Anfänger");
    expect(sent).not.toContain("Earlier user questions");
  });

  test("byte-gleich mit und ohne frühere Fragen (Antwortmodell, Filter, Speichern)", async () => {
    const snapshot = async () => {
      jest.clearAllMocks();
      prisma.embed_chats.findMany.mockImplementation(findMany);
      const { connector } = await run({ messageLimit: 2 });
      return {
        compress: JSON.stringify(connector.compressMessages.mock.calls),
        filter: JSON.stringify(startMetadataFilterResolution.mock.calls),
        stored: JSON.stringify(newSpy.mock.calls),
        answerStream: JSON.stringify(
          connector.streamGetChatCompletion.mock.calls
        ),
      };
    };
    const withEarlier = await snapshot();
    // gleiche Unterhaltung ohne die beiden ältesten Runden: keine früheren
    // Fragen außer Runde 6, Verlauf des Antwortmodells identisch
    TABLE = FOUR_ROUNDS().filter((r) => r.id >= 6);
    const fewer = await snapshot();
    expect(fewer).toEqual(withEarlier);
    expect(JSON.parse(withEarlier.filter)[0][0].chatHistory).toEqual(
      EXPECTED_HISTORY
    );
    expect(JSON.parse(withEarlier.stored)[0][0]).toMatchObject({
      prompt: MESSAGE,
      sessionId: SESSION,
      conversationId: CONVERSATION,
    });
  });
});

describe("NAK-3 im Widget: erste Nachricht, Wortgrenze, Schalter", () => {
  test("ohne Verlauf keine Abfrage der früheren Fragen und kein Rewrite", async () => {
    TABLE = [];
    const { rewriteCalls, vectorDb } = await run();
    expect(earlierQueries()).toHaveLength(0);
    expect(rewriteCalls).toHaveLength(0);
    expect(vectorDb.performSimilaritySearch.mock.calls[0][0].input).toBe(
      MESSAGE
    );
  });

  // E-R2: die Abfrage der früheren Fragen läuft erst, wenn der Rewriter
  // tatsächlich umschreibt (nach shouldRewrite)
  test("Frage über der Wortgrenze: kein Rewrite, keine Abfrage der früheren Fragen, Suche mit der Originalfrage", async () => {
    const long =
      "Ich suche noch einen Yogakurs für Anfänger am Abend in der Nähe bitte";
    const { rewriteCalls, vectorDb } = await run({ message: long });
    expect(rewriteCalls).toHaveLength(0);
    expect(earlierQueries()).toHaveLength(0);
    expect(vectorDb.performSimilaritySearch.mock.calls[0][0].input).toBe(long);
  });

  test("Schalter aus (queryRewriteMode off): kein Rewrite, keine Abfrage der früheren Fragen", async () => {
    const { rewriteCalls, vectorDb } = await run({ queryRewriteMode: "off" });
    expect(rewriteCalls).toHaveLength(0);
    expect(earlierQueries()).toHaveLength(0);
    expect(vectorDb.performSimilaritySearch.mock.calls[0][0].input).toBe(
      MESSAGE
    );
  });
});
