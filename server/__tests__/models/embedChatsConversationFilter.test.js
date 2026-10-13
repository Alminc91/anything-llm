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

// ============================================================================
// KIE-536 — Abschnitts-Filter der Konversationsliste (Klick auf eine Säule):
// nur Konversationen, deren erste vorhandene Nachricht im Abschnitt liegt.
// ============================================================================
describe("beginn_im_abschnitt — SQL-Form (KIE-536, AK-7)", () => {
  const BETWEEN = {
    start: new Date("2026-10-05T22:00:00Z"),
    endExclusive: new Date("2026-10-06T22:00:00Z"),
  };

  test("Bedingung auf started_at NACH der Gruppierung, halboffen, als gebundene Werte", async () => {
    await EmbedChats.getConversations(
      EMBED_ID,
      0,
      20,
      null,
      null,
      "all",
      BETWEEN
    );
    const sql = lastSql();
    expect(sql).toMatch(
      /GROUP BY .*\) WHERE started_at >= \? AND started_at < \? ORDER BY/
    );
    expect(sql).toMatch(/MIN\(createdAt\) as started_at/);
    expect(sql).not.toMatch(/HAVING/i);
    expect(lastBoundValues()).toEqual(
      expect.arrayContaining([BETWEEN.start, BETWEEN.endExclusive])
    );
  });

  test("Gruppierung ohne Datumsfilter: startDate/endDate bleiben mit Abschnitts-Filter unbeachtet", async () => {
    const start = new Date("2026-09-13T00:00:00Z");
    const end = new Date("2026-10-12T23:59:59Z");
    await EmbedChats.getConversations(
      EMBED_ID,
      0,
      20,
      start,
      end,
      "all",
      BETWEEN
    );
    expect(lastSql()).not.toMatch(/createdAt >=|createdAt <=/);
    expect(lastSql()).toMatch(/WHERE include = 1 AND embed_id = \? GROUP BY/);
    expect(lastBoundValues()).not.toContain(start);
    expect(lastBoundValues()).not.toContain(end);

    await EmbedChats.countConversations(EMBED_ID, start, end, "all", BETWEEN);
    expect(lastSql()).not.toMatch(/createdAt >=|createdAt <=/);
    expect(lastBoundValues()).not.toContain(start);
  });

  test("zusammen mit dem Feedback-Filter: beide Bedingungen nach der Gruppierung", async () => {
    await EmbedChats.getConversations(
      EMBED_ID,
      0,
      20,
      null,
      null,
      "negative",
      BETWEEN
    );
    expect(lastSql()).toMatch(
      /GROUP BY .*\) WHERE negative_count > 0 AND started_at >= \? AND started_at < \? ORDER BY/
    );
    await EmbedChats.getConversations(
      EMBED_ID,
      0,
      20,
      null,
      null,
      "positive",
      BETWEEN
    );
    expect(lastSql()).toMatch(
      /GROUP BY .*\) WHERE positive_count > 0 AND started_at >= \? AND started_at < \? ORDER BY/
    );
  });

  test("Liste und Zähler teilen Gruppierung und Bedingung", async () => {
    prisma.$queryRaw.mockResolvedValue([{ count: BigInt(2) }]);
    expect(
      await EmbedChats.countConversations(
        EMBED_ID,
        null,
        null,
        "negative",
        BETWEEN
      )
    ).toBe(2);
    const countSql = lastSql();
    prisma.$queryRaw.mockResolvedValue(RAW_ROWS);
    await EmbedChats.getConversations(
      EMBED_ID,
      0,
      20,
      null,
      null,
      "negative",
      BETWEEN
    );
    const listSql = lastSql();
    const tail = (sql) =>
      sql.slice(sql.indexOf("( SELECT"), sql.indexOf("started_at < ?"));
    expect(tail(countSql)).toBe(tail(listSql));
    expect(countSql).toMatch(/started_at >= \? AND started_at < \?/);
  });

  test("ohne Abschnitts-Filter ändert sich das SQL nicht (NAK-5)", async () => {
    const start = new Date("2026-01-01T00:00:00Z");
    const end = new Date("2026-02-01T00:00:00Z");
    for (const filter of ["all", "negative", "positive"]) {
      await EmbedChats.getConversations(EMBED_ID, 0, 20, start, end, filter);
      const without = lastSql();
      for (const none of [null, undefined]) {
        await EmbedChats.getConversations(
          EMBED_ID,
          0,
          20,
          start,
          end,
          filter,
          none
        );
        expect(lastSql()).toBe(without);
      }
      expect(without).not.toMatch(/started_at >=|started_at </);
      expect(without).toMatch(/AND createdAt >= \? AND createdAt <= \?/);
    }
  });

  test("unbrauchbarer Abschnitt → kein Filter, nichts davon gelangt ins SQL", async () => {
    const evil = "0) OR (1=1";
    for (const value of [
      evil,
      { start: evil, endExclusive: evil },
      { start: "2026-10-06", endExclusive: "2026-10-07" },
      { start: new Date(NaN), endExclusive: new Date() },
      { start: new Date() },
      {},
      42,
    ]) {
      await EmbedChats.getConversations(
        EMBED_ID,
        0,
        20,
        null,
        null,
        "all",
        value
      );
      expect(lastSql()).not.toMatch(/started_at >=|started_at </);
      expect(lastSql()).not.toContain(evil);
      expect(lastBoundValues()).not.toContain(evil);
      expect(EmbedChats.normalizeStartedBetween(value)).toBeNull();
    }
  });

  test("Helfer funktionieren auch losgelöst vom Objekt (kein this)", () => {
    const { conversationFilterCondition, normalizeStartedBetween } = EmbedChats;
    expect(normalizeStartedBetween(BETWEEN)).toEqual(BETWEEN);
    expect(conversationFilterCondition("all", null)).toBe(
      EmbedChats.feedbackFilterCondition("all")
    );
    expect(
      conversationFilterCondition("negative", null).strings.join("?")
    ).toBe("WHERE negative_count > 0");
  });
});

// Dieselbe Frage gegen eine echte SQLite-Datei aus den Migrationen: Ob eine
// Konversation mit Nachrichten an zwei Tagen nur am ersten erscheint, zeigt
// sich an den Daten, nicht am SQL-Text. Das Modell wird dafür ein zweites Mal
// geladen, mit der Testdatenbank anstelle der Attrappe oben. Dieser Block
// steht deshalb am Ende der Datei.
describe("beginn_im_abschnitt (KIE-536, AK-7)", () => {
  const {
    createTestDatabase,
    removeTestDatabases,
    createWorkspace,
    createEmbed,
    berlinInstant,
  } = require("../helpers/sqliteTestDatabase");

  // Der erste Test erzeugt die Vorlage mit `prisma migrate deploy`.
  jest.setTimeout(60000);

  let Chats;
  let db;
  let embed;

  beforeAll(() => {
    // Die Attrappe von utils/prisma ist in dieser Datei schon geladen, und
    // Jest reicht eine geladene Attrappe auch in jest.isolateModules weiter.
    // Deshalb: Module verwerfen, den Ersatz neu festlegen, das Modell neu
    // laden. Die Tests oben behalten ihr Modell mit der Attrappe.
    jest.resetModules();
    jest.doMock(
      "../../utils/prisma",
      () => require("../helpers/sqliteTestDatabase").testPrisma
    );
    Chats = require("../../models/embedChats").EmbedChats;
  });
  beforeEach(async () => {
    db = await createTestDatabase();
    const workspace = await createWorkspace(db.client);
    embed = await createEmbed(db.client, workspace);
  });
  afterEach(async () => {
    await db.close();
  });
  afterAll(() => removeTestDatabases());

  /** Abschnitt aus Berliner Kalendertagen, beide einschließlich. */
  function bucket(fromDay, toDay = fromDay) {
    const next = new Date(`${toDay}T12:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    return {
      start: berlinInstant(fromDay, 0),
      endExclusive: berlinInstant(next.toISOString().slice(0, 10), 0),
    };
  }

  async function message(conversation, instant, data = {}) {
    return await db.client.embed_chats.create({
      data: {
        prompt: `Frage in ${conversation}`,
        response: JSON.stringify({ text: "Antwort" }),
        session_id: `sitzung-${conversation}`,
        conversation_id: conversation,
        embed_id: embed.id,
        createdAt: instant,
        ...data,
      },
    });
  }

  const ids = (rows) => rows.map((row) => row.conversation_id).sort();

  async function listAndCount(...args) {
    const [list, count] = await Promise.all([
      Chats.getConversations(embed.id, 0, 20, ...args),
      Chats.countConversations(embed.id, ...args),
    ]);
    expect(count).toBe(list.length);
    return list;
  }

  test("beginn_im_abschnitt: Konversation mit Nachrichten an zwei Tagen erscheint nur am ersten", async () => {
    await message("zwei-tage", berlinInstant("2026-10-05", 22, 10));
    await message("zwei-tage", berlinInstant("2026-10-06", 9, 30));
    await message("zwei-tage", berlinInstant("2026-10-06", 9, 45));
    await message("nur-am-06", berlinInstant("2026-10-06", 14, 0));
    await message("nur-am-07", berlinInstant("2026-10-07", 8, 0));

    expect(
      ids(await listAndCount(null, null, "all", bucket("2026-10-05")))
    ).toEqual(["zwei-tage"]);
    expect(
      ids(await listAndCount(null, null, "all", bucket("2026-10-06")))
    ).toEqual(["nur-am-06"]);
    expect(
      ids(await listAndCount(null, null, "all", bucket("2026-10-07")))
    ).toEqual(["nur-am-07"]);
    expect(await listAndCount(null, null, "all", bucket("2026-10-08"))).toEqual(
      []
    );

    // Zum Vergleich der Datumsfilter der Liste (unverändert): Er filtert die
    // Nachrichten vor der Gruppierung, die Konversation erscheint an beiden
    // Tagen.
    const day06 = bucket("2026-10-06");
    expect(
      ids(
        await listAndCount(
          day06.start,
          new Date(day06.endExclusive.getTime() - 1),
          "all"
        )
      )
    ).toEqual(["nur-am-06", "zwei-tage"]);
  });

  test("beginn_im_abschnitt: started_at, Anzahl und letzte Nachricht gelten für die ganze Konversation", async () => {
    const first = await message(
      "zwei-tage",
      berlinInstant("2026-10-05", 22, 10)
    );
    await message("zwei-tage", berlinInstant("2026-10-06", 9, 30));
    const last = await message("zwei-tage", berlinInstant("2026-10-09", 9, 45));

    // Ein Datumsfilter, der nur den 06.10. umfasst, bleibt unbeachtet.
    const day06 = bucket("2026-10-06");
    const [conversation] = await listAndCount(
      day06.start,
      day06.endExclusive,
      "all",
      bucket("2026-10-05")
    );

    expect(conversation).toMatchObject({
      conversation_id: "zwei-tage",
      first_chat_id: first.id,
      started_at: first.createdAt.getTime(),
      last_message_at: last.createdAt.getTime(),
      message_count: 3,
      preview: "Frage in zwei-tage",
    });
  });

  test("beginn_im_abschnitt: Wochen- und Monatsabschnitt, Grenzen halboffen in Berliner Zeit", async () => {
    // KW 41/2026: Montag 05.10. bis Sonntag 11.10.
    await message("sonntag-davor", berlinInstant("2026-10-04", 23, 59));
    await message("montag-frueh", berlinInstant("2026-10-05", 0, 0));
    await message("sonntag-spaet", berlinInstant("2026-10-11", 23, 59));
    await message("montag-danach", berlinInstant("2026-10-12", 0, 0));
    await message("september", berlinInstant("2026-09-30", 23, 30));

    expect(
      ids(
        await listAndCount(
          null,
          null,
          "all",
          bucket("2026-10-05", "2026-10-11")
        )
      )
    ).toEqual(["montag-frueh", "sonntag-spaet"]);
    expect(
      ids(
        await listAndCount(
          null,
          null,
          "all",
          bucket("2026-10-01", "2026-10-31")
        )
      )
    ).toEqual([
      "montag-danach",
      "montag-frueh",
      "sonntag-davor",
      "sonntag-spaet",
    ]);
    expect(
      ids(
        await listAndCount(
          null,
          null,
          "all",
          bucket("2026-09-01", "2026-09-30")
        )
      )
    ).toEqual(["september"]);
  });

  test("beginn_im_abschnitt: erste VORHANDENE Nachricht - gelöschte und vom Besucher geleerte Zeilen zählen nicht", async () => {
    const deleted = await message("geloescht", berlinInstant("2026-10-05", 10));
    await message("geloescht", berlinInstant("2026-10-06", 10));
    await message("geleert", berlinInstant("2026-10-05", 11), {
      include: false,
    });
    await message("geleert", berlinInstant("2026-10-06", 11));
    await db.client.embed_chats.delete({ where: { id: deleted.id } });

    expect(await listAndCount(null, null, "all", bucket("2026-10-05"))).toEqual(
      []
    );
    const day06 = await listAndCount(null, null, "all", bucket("2026-10-06"));
    expect(ids(day06)).toEqual(["geleert", "geloescht"]);
    expect(day06.map((row) => row.message_count)).toEqual([1, 1]);
  });

  test("beginn_im_abschnitt: zusammen mit dem Feedback-Filter, nur das eigene Widget, Blättern", async () => {
    const workspace = await createWorkspace(db.client);
    const other = await createEmbed(db.client, workspace);
    await message("fremd", berlinInstant("2026-10-06", 8), {
      embed_id: other.id,
      feedbackScore: false,
    });
    await message("ohne", berlinInstant("2026-10-06", 9));
    await message("negativ", berlinInstant("2026-10-06", 10), {
      feedbackScore: false,
    });
    await message("positiv", berlinInstant("2026-10-06", 11), {
      feedbackScore: true,
    });
    // 👎 erst am Folgetag: Die Konversation gehört trotzdem zum 06.10.
    await message("spaeter-negativ", berlinInstant("2026-10-06", 12));
    await message("spaeter-negativ", berlinInstant("2026-10-07", 12), {
      feedbackScore: false,
    });
    await message("negativ-am-07", berlinInstant("2026-10-07", 13), {
      feedbackScore: false,
    });

    const day = bucket("2026-10-06");
    expect(ids(await listAndCount(null, null, "all", day))).toEqual([
      "negativ",
      "ohne",
      "positiv",
      "spaeter-negativ",
    ]);
    expect(ids(await listAndCount(null, null, "negative", day))).toEqual([
      "negativ",
      "spaeter-negativ",
    ]);
    expect(ids(await listAndCount(null, null, "positive", day))).toEqual([
      "positiv",
    ]);
    expect(ids(await listAndCount(null, null, true, day))).toEqual([
      "negativ",
      "spaeter-negativ",
    ]);

    // Blättern: neueste zuerst, Zähler über alle Seiten.
    const pageOne = await Chats.getConversations(
      embed.id,
      0,
      3,
      null,
      null,
      "all",
      day
    );
    const pageTwo = await Chats.getConversations(
      embed.id,
      3,
      3,
      null,
      null,
      "all",
      day
    );
    expect(pageOne.map((row) => row.conversation_id)).toEqual([
      "spaeter-negativ",
      "positiv",
      "negativ",
    ]);
    expect(pageTwo.map((row) => row.conversation_id)).toEqual(["ohne"]);
    expect(
      await Chats.countConversations(embed.id, null, null, "all", day)
    ).toBe(4);
  });

  test("beginn_im_abschnitt: Alt-Daten ohne conversation_id werden über die Sitzung gruppiert", async () => {
    await message("alt", berlinInstant("2026-10-05", 10), {
      conversation_id: null,
      session_id: "alte-sitzung",
    });
    await message("alt", berlinInstant("2026-10-06", 10), {
      conversation_id: null,
      session_id: "alte-sitzung",
    });

    expect(
      ids(await listAndCount(null, null, "all", bucket("2026-10-05")))
    ).toEqual(["alte-sitzung"]);
    expect(await listAndCount(null, null, "all", bucket("2026-10-06"))).toEqual(
      []
    );
  });
});
