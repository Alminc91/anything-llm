/* eslint-env jest, node */
// KIE-508 / KIE-527 — Embed-Analytics: Konversationsliste nach 👎 bzw. 👍
// filtern. getConversations muss (a) ohne Filter KEINE HAVING-Klausel senden,
// (b) für "negative" auf feedbackScore = 0 und für "positive" auf
// feedbackScore = 1 filtern, (c) den Legacy-Boolean onlyNegative=true weiter
// akzeptieren, (d) unbekannte Werte auf "all" normalisieren (kein User-Input
// im SQL) und (e) negative_count + positive_count als Number liefern.
const prisma = require("../../utils/prisma");

jest.mock("../../utils/prisma", () => ({
  $queryRaw: jest.fn(),
  embed_chats: {
    findMany: jest.fn(),
  },
}));

jest.mock("../../utils/http", () => ({
  safeJsonParse: (v) => {
    try {
      return JSON.parse(v);
    } catch {
      return {};
    }
  },
}));

const { EmbedChats } = require("../../models/embedChats");

const EMBED_ID = 3;

// Aggregierte Zeilen wie SQLite/Prisma sie aus $queryRaw liefert: COUNT/SUM/
// MIN(id) kommen als BigInt zurück.
const RAW_ROWS = [
  {
    conversation_id: "conv-1",
    session_id: "sess-1",
    embed_id: BigInt(EMBED_ID),
    first_chat_id: BigInt(11),
    started_at: 1750000000000,
    last_message_at: 1750000500000,
    message_count: BigInt(4),
    negative_count: BigInt(1),
    positive_count: BigInt(2),
    conversation_number: BigInt(1),
  },
  {
    conversation_id: "conv-2",
    session_id: "sess-2",
    embed_id: BigInt(EMBED_ID),
    first_chat_id: BigInt(42),
    started_at: 1749000000000,
    last_message_at: 1749000900000,
    message_count: BigInt(1),
    negative_count: null, // Alt-Daten / kein Feedback
    positive_count: null,
    conversation_number: BigInt(2),
  },
];

const FIRST_CHATS = [
  {
    id: 11,
    prompt: "Wann beginnt der Yoga-Kurs?",
    embed_config: { workspace: { name: "chatbot" } },
  },
  {
    id: 42,
    prompt: "Gibt es Excel-Kurse?",
    embed_config: { workspace: { name: "chatbot" } },
  },
];

// Flacht den zuletzt gesendeten $queryRaw-Aufruf zu lesbarem SQL ab: gebundene
// Werte werden zu "?", verschachtelte Prisma.sql-Fragmente (WHERE-Join, HAVING)
// werden rekursiv inline gesetzt — so lässt sich die HAVING-Klausel im Text prüfen.
function flattenSql(strings, values) {
  let out = "";
  strings.forEach((str, i) => {
    out += str;
    if (i < values.length) {
      const v = values[i];
      out +=
        v && Array.isArray(v.strings) ? flattenSql(v.strings, v.values) : "?";
    }
  });
  return out;
}

function lastSql() {
  const [templateStrings, ...values] = prisma.$queryRaw.mock.calls.at(-1);
  return flattenSql(templateStrings, values);
}

// Alle gebundenen Werte des letzten Aufrufs, inkl. der in verschachtelten
// Prisma.sql-Fragmenten (z. B. `WHERE embed_id = ${embedId}`).
function lastBoundValues() {
  const collect = (values) =>
    values.flatMap((v) =>
      v && Array.isArray(v.strings) ? collect(v.values) : [v]
    );
  return collect(prisma.$queryRaw.mock.calls.at(-1).slice(1));
}

beforeEach(() => {
  jest.clearAllMocks();
  prisma.$queryRaw.mockResolvedValue(RAW_ROWS);
  prisma.embed_chats.findMany.mockResolvedValue(FIRST_CHATS);
});

describe("normalizeFeedbackFilter", () => {
  test.each([
    ["negative", "negative"],
    ["positive", "positive"],
    ["all", "all"],
    [true, "negative"], // Legacy onlyNegative=true
    [false, "all"],
    [undefined, "all"],
    [null, "all"],
    ["", "all"],
    ["1=1) OR (1=1", "all"], // NAK-1: kein User-Input im SQL
    ["POSITIVE", "all"], // case-sensitive, kein Raten
  ])("%p → %p", (input, expected) => {
    expect(EmbedChats.normalizeFeedbackFilter(input)).toBe(expected);
  });
});

describe("feedbackHavingClause", () => {
  test("'all' liefert Prisma.empty (kein HAVING)", () => {
    const { Prisma } = require("@prisma/client");
    expect(EmbedChats.feedbackHavingClause("all")).toBe(Prisma.empty);
    expect(EmbedChats.feedbackHavingClause("garbage")).toBe(Prisma.empty);
  });

  test("'negative' filtert auf feedbackScore = 0, 'positive' auf = 1", () => {
    const neg = EmbedChats.feedbackHavingClause("negative").strings.join("?");
    const pos = EmbedChats.feedbackHavingClause("positive").strings.join("?");
    expect(neg).toMatch(
      /HAVING SUM\(CASE WHEN feedbackScore = 0 THEN 1 ELSE 0 END\) > 0/
    );
    expect(pos).toMatch(
      /HAVING SUM\(CASE WHEN feedbackScore = 1 THEN 1 ELSE 0 END\) > 0/
    );
    // Legacy-Boolean landet auf der 👎-Klausel
    expect(EmbedChats.feedbackHavingClause(true).strings.join("?")).toBe(neg);
  });
});

describe("getConversations — Feedback-Filter im SQL", () => {
  test("Default (kein Filter): keine HAVING-Klausel, beide Zähler im SELECT (NAK-2)", async () => {
    await EmbedChats.getConversations(EMBED_ID, 0, 20);
    const sql = lastSql();
    expect(sql).not.toMatch(/HAVING/i);
    expect(sql).toMatch(
      /SUM\(CASE WHEN feedbackScore = 0 THEN 1 ELSE 0 END\) as negative_count/
    );
    expect(sql).toMatch(
      /SUM\(CASE WHEN feedbackScore = 1 THEN 1 ELSE 0 END\) as positive_count/
    );
    // embed_id bleibt gebundener Wert
    expect(lastBoundValues()).toContain(EMBED_ID);
  });

  test("'negative' → HAVING auf feedbackScore = 0 (KIE-508)", async () => {
    await EmbedChats.getConversations(EMBED_ID, 0, 20, null, null, "negative");
    expect(lastSql()).toMatch(
      /GROUP BY[^]*HAVING SUM\(CASE WHEN feedbackScore = 0 THEN 1 ELSE 0 END\) > 0/
    );
    expect(lastSql()).not.toMatch(/feedbackScore = 1 THEN 1 ELSE 0 END\) > 0/);
  });

  test("'positive' → HAVING auf feedbackScore = 1 (KIE-527, AK-1)", async () => {
    await EmbedChats.getConversations(EMBED_ID, 0, 20, null, null, "positive");
    expect(lastSql()).toMatch(
      /GROUP BY[^]*HAVING SUM\(CASE WHEN feedbackScore = 1 THEN 1 ELSE 0 END\) > 0/
    );
    expect(lastSql()).not.toMatch(/feedbackScore = 0 THEN 1 ELSE 0 END\) > 0/);
  });

  test("Legacy onlyNegative=true verhält sich wie 'negative' (AK-4)", async () => {
    await EmbedChats.getConversations(EMBED_ID, 0, 20, null, null, true);
    const legacySql = lastSql();
    await EmbedChats.getConversations(EMBED_ID, 0, 20, null, null, "negative");
    expect(legacySql).toBe(lastSql());
  });

  test("ungültiger Filter-Wert → kein HAVING, Wert taucht nirgends im SQL auf (NAK-1)", async () => {
    const evil = "1=1) OR (1=1";
    await EmbedChats.getConversations(EMBED_ID, 0, 20, null, null, evil);
    expect(lastSql()).not.toMatch(/HAVING/i);
    expect(lastSql()).not.toContain(evil);
    expect(lastBoundValues()).not.toContain(evil);
  });
});

describe("getConversations — Ergebnisform", () => {
  test("negative_count und positive_count sind Number; NULL → 0", async () => {
    const result = await EmbedChats.getConversations(EMBED_ID, 0, 20);
    expect(result[0].negative_count).toBe(1);
    expect(result[0].positive_count).toBe(2);
    expect(typeof result[0].positive_count).toBe("number");
    expect(result[1].negative_count).toBe(0);
    expect(result[1].positive_count).toBe(0);
    expect(() => JSON.stringify(result)).not.toThrow();
  });
});
