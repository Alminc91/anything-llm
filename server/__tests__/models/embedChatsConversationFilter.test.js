/* eslint-env jest, node */
// KIE-508 / KIE-527 — Embed-Analytics: Konversationsliste nach 👎 bzw. 👍
// filtern. getConversations/countConversations müssen (a) ohne Filter KEINE
// Filterbedingung senden, (b) für "negative" auf negative_count und für
// "positive" auf positive_count filtern — und zwar NACH der Gruppierung, damit
// conversation_number stabil bleibt, (c) den Legacy-Boolean onlyNegative=true
// weiter akzeptieren, (d) unbekannte Werte auf "all" normalisieren (kein
// User-Input im SQL), (e) DSGVO: include = 1 in Liste UND Zähler, (f) Zähler
// als Number liefern.
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
// Werte werden zu "?", verschachtelte Prisma.sql-Fragmente (WHERE-Join,
// Gruppierungs-Subquery, Filterbedingung) werden rekursiv inline gesetzt.
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
  return out.replace(/\s+/g, " ");
}

function lastSql() {
  const [templateStrings, ...values] = prisma.$queryRaw.mock.calls.at(-1);
  return flattenSql(templateStrings, values);
}

// Alle gebundenen Werte des letzten Aufrufs, inkl. der in verschachtelten
// Prisma.sql-Fragmenten (z. B. `AND embed_id = ${embedId}`).
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

describe("feedbackFilterCondition", () => {
  test("'all' und Unbekanntes liefern Prisma.empty (keine Bedingung)", () => {
    const { Prisma } = require("@prisma/client");
    expect(EmbedChats.feedbackFilterCondition("all")).toBe(Prisma.empty);
    expect(EmbedChats.feedbackFilterCondition("garbage")).toBe(Prisma.empty);
  });

  test("'negative' filtert auf negative_count, 'positive' auf positive_count", () => {
    const neg =
      EmbedChats.feedbackFilterCondition("negative").strings.join("?");
    const pos =
      EmbedChats.feedbackFilterCondition("positive").strings.join("?");
    expect(neg).toBe("WHERE negative_count > 0");
    expect(pos).toBe("WHERE positive_count > 0");
    // Legacy-Boolean landet auf der 👎-Bedingung
    expect(EmbedChats.feedbackFilterCondition(true).strings.join("?")).toBe(
      neg
    );
  });

  test("Helfer funktionieren auch losgelöst vom Objekt (kein this)", () => {
    const { feedbackFilterCondition, normalizeFeedbackFilter } = EmbedChats;
    expect(normalizeFeedbackFilter("positive")).toBe("positive");
    expect(feedbackFilterCondition("positive").strings.join("?")).toBe(
      "WHERE positive_count > 0"
    );
  });
});

describe("getConversations — SQL-Form", () => {
  test("Default (kein Filter): keine Filterbedingung, beide Zähler, include = 1 (NAK-2)", async () => {
    await EmbedChats.getConversations(EMBED_ID, 0, 20);
    const sql = lastSql();
    expect(sql).not.toMatch(/negative_count > 0|positive_count > 0/);
    expect(sql).not.toMatch(/HAVING/i);
    expect(sql).toMatch(
      /SUM\(CASE WHEN feedbackScore = 0 THEN 1 ELSE 0 END\) as negative_count/
    );
    expect(sql).toMatch(
      /SUM\(CASE WHEN feedbackScore = 1 THEN 1 ELSE 0 END\) as positive_count/
    );
    // DSGVO: invalidierte Zeilen (markHistoryInvalid) nie in der Liste
    expect(sql).toMatch(/WHERE include = 1 AND embed_id = \?/);
    expect(lastBoundValues()).toContain(EMBED_ID);
  });

  test("'negative' → Bedingung auf negative_count NACH der Gruppierung (KIE-508)", async () => {
    await EmbedChats.getConversations(EMBED_ID, 0, 20, null, null, "negative");
    const sql = lastSql();
    expect(sql).toMatch(/GROUP BY .*\) WHERE negative_count > 0 ORDER BY/);
    expect(sql).not.toMatch(/positive_count > 0/);
  });

  test("'positive' → Bedingung auf positive_count NACH der Gruppierung (KIE-527, AK-1)", async () => {
    await EmbedChats.getConversations(EMBED_ID, 0, 20, null, null, "positive");
    const sql = lastSql();
    expect(sql).toMatch(/GROUP BY .*\) WHERE positive_count > 0 ORDER BY/);
    expect(sql).not.toMatch(/negative_count > 0/);
  });

  test("conversation_number wird VOR dem Filter vergeben (stabil je Filterzustand)", async () => {
    await EmbedChats.getConversations(EMBED_ID, 0, 20, null, null, "positive");
    const sql = lastSql();
    const rowNumberIdx = sql.indexOf("ROW_NUMBER() OVER");
    const filterIdx = sql.indexOf("WHERE positive_count > 0");
    expect(rowNumberIdx).toBeGreaterThan(-1);
    expect(filterIdx).toBeGreaterThan(rowNumberIdx);
    // kein HAVING mehr innerhalb der Gruppierung
    expect(sql).not.toMatch(/HAVING/i);
  });

  test("Legacy onlyNegative=true verhält sich wie 'negative' (AK-4)", async () => {
    await EmbedChats.getConversations(EMBED_ID, 0, 20, null, null, true);
    const legacySql = lastSql();
    await EmbedChats.getConversations(EMBED_ID, 0, 20, null, null, "negative");
    expect(legacySql).toBe(lastSql());
  });

  test("ungültiger Filter-Wert → keine Bedingung, Wert taucht nirgends auf (NAK-1)", async () => {
    const evil = "1=1) OR (1=1";
    await EmbedChats.getConversations(EMBED_ID, 0, 20, null, null, evil);
    expect(lastSql()).not.toMatch(/negative_count > 0|positive_count > 0/);
    expect(lastSql()).not.toContain(evil);
    expect(lastBoundValues()).not.toContain(evil);
  });

  test("Datumsfilter werden als gebundene Werte übergeben", async () => {
    const start = new Date("2026-01-01T00:00:00Z");
    const end = new Date("2026-02-01T00:00:00Z");
    await EmbedChats.getConversations(EMBED_ID, 0, 20, start, end, "all");
    expect(lastSql()).toMatch(/AND createdAt >= \? AND createdAt <= \?/);
    expect(lastBoundValues()).toEqual(expect.arrayContaining([start, end]));
  });
});

describe("countConversations — gleiche Gruppierung wie die Liste", () => {
  beforeEach(() => {
    prisma.$queryRaw.mockResolvedValue([{ count: BigInt(7) }]);
  });

  test("zählt Gruppen mit include = 1 und identischem Filter", async () => {
    const total = await EmbedChats.countConversations(
      EMBED_ID,
      null,
      null,
      "positive"
    );
    expect(total).toBe(7);
    const sql = lastSql();
    expect(sql).toMatch(/SELECT COUNT\(\*\) as count FROM \( SELECT/);
    expect(sql).toMatch(/WHERE include = 1 AND embed_id = \?/);
    expect(sql).toMatch(/GROUP BY .*\) WHERE positive_count > 0/);
  });

  test("Liste und Zähler teilen exakt dasselbe Gruppierungs-Fragment", async () => {
    await EmbedChats.countConversations(EMBED_ID, null, null, "negative");
    const countSql = lastSql();
    prisma.$queryRaw.mockResolvedValue(RAW_ROWS);
    await EmbedChats.getConversations(EMBED_ID, 0, 20, null, null, "negative");
    const listSql = lastSql();
    const groupFragment = (sql) =>
      sql.slice(sql.indexOf("( SELECT"), sql.indexOf("WHERE negative_count"));
    expect(groupFragment(countSql)).toBe(groupFragment(listSql));
  });

  test("ohne Filter keine Bedingung; Ergebnis ist Number", async () => {
    const total = await EmbedChats.countConversations(EMBED_ID);
    expect(typeof total).toBe("number");
    expect(lastSql()).not.toMatch(/_count > 0/);
  });

  test("DB-Fehler → 0 statt Exception", async () => {
    prisma.$queryRaw.mockRejectedValue(new Error("boom"));
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    expect(await EmbedChats.countConversations(EMBED_ID)).toBe(0);
    spy.mockRestore();
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
