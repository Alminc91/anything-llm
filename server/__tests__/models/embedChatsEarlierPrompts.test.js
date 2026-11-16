/* eslint-env jest, node */
// Query Rewriter, Variante E (issues/folgefragen-variante-e.md): frühere
// Besucherfragen einer Unterhaltung (EmbedChats.earlierPrompts) gegen eine
// echte SQLite-Datei (helpers/sqliteTestDatabase.js).
// - NAK-1: Fragen anderer Sitzungen, Unterhaltungen oder Widgets erscheinen
//   nie; Bindung an die Sitzung wie forEmbedByUser (KIE-505), Legacy-Zeilen
//   ohne conversation_id nur im Bucket der eigenen Sitzung (KIE-503).
// - Gelöschte oder unsichtbare Zeilen (include false) wie im Verlauf nicht.
// - Nur Zeilen vor der letzten Runde (beforeId), höchstens limit (Standard
//   und Widget: EARLIER_QUESTIONS_MAX = 1, E-R7), älteste zuerst, nur das
//   Feld prompt.
jest.mock(
  "../../utils/prisma",
  () => require("../helpers/sqliteTestDatabase").testPrisma
);

const {
  createTestDatabase,
  removeTestDatabases,
  createWorkspace,
  createEmbed,
  seedEmbedChats,
} = require("../helpers/sqliteTestDatabase");
const { EmbedChats } = require("../../models/embedChats");
const {
  EARLIER_QUESTIONS_MAX,
} = require("../../utils/helpers/chat/queryRewriter");

// Der erste Test jeder Datei erzeugt die Vorlage mit `prisma migrate deploy`.
jest.setTimeout(60000);

const SESSION = "besitzer-sitzung";
const FOREIGN_SESSION = "fremde-sitzung";
const CONVERSATION = "unterhaltung-1";

let db;
let EMBED_ID;
let OTHER_EMBED_ID;

beforeEach(async () => {
  db = await createTestDatabase();
  const workspace = await createWorkspace(db.client);
  EMBED_ID = (await createEmbed(db.client, workspace)).id;
  OTHER_EMBED_ID = (await createEmbed(db.client, workspace)).id;
});
afterEach(async () => {
  jest.restoreAllMocks();
  await db.close();
});
afterAll(() => removeTestDatabases());

const own = (prompt, extra = {}) => ({
  embed_id: EMBED_ID,
  prompt,
  session_id: SESSION,
  conversation_id: CONVERSATION,
  ...extra,
});

// Eigene Unterhaltung mit Zeilen anderer Sitzungen, Unterhaltungen und
// Widgets dazwischen; gibt die id der letzten eigenen Zeile zurück.
async function seedMixed() {
  await seedEmbedChats(db.client, [
    own("Gibt es Yoga?"),
    own("FREMD: Gibt es Malkurse?", { session_id: FOREIGN_SESSION }),
    own("Ich bin Anfänger"),
    own("ANDERE UNTERHALTUNG: Gibt es Spanisch?", {
      conversation_id: "unterhaltung-2",
    }),
    own("GELÖSCHT: Gibt es Töpfern?", { include: false }),
    own("ANDERES WIDGET: Gibt es Tanz?", { embed_id: OTHER_EMBED_ID }),
    own("LEGACY OHNE UNTERHALTUNG: Gibt es Schach?", { conversation_id: null }),
    own("Und am Abend?"),
    own("Wie teuer ist das?"),
  ]);
  const last = await db.client.embed_chats.findFirst({
    where: { session_id: SESSION, conversation_id: CONVERSATION },
    orderBy: { id: "desc" },
  });
  return last.id;
}

const call = (overrides = {}) =>
  EmbedChats.earlierPrompts({
    embedId: EMBED_ID,
    conversationId: CONVERSATION,
    boundSessionId: SESSION,
    limit: EARLIER_QUESTIONS_MAX,
    ...overrides,
  });

describe("earlierPrompts: frühere Fragen derselben Unterhaltung und Sitzung", () => {
  test("nur eigene, sichtbare Fragen vor der letzten Runde, älteste zuerst", async () => {
    const lastId = await seedMixed();
    const idOf = async (prompt) =>
      (await db.client.embed_chats.findFirst({ where: { prompt } })).id;
    // die neueste eigene (E-R7: höchstens 1)
    expect(await call({ beforeId: lastId })).toEqual(["Und am Abend?"]);
    // direkt davor liegen nur fremde Zeilen (Legacy, anderes Widget,
    // gelöscht, andere Unterhaltung); sie zählen nicht
    expect(await call({ beforeId: await idOf("Und am Abend?") })).toEqual([
      "Ich bin Anfänger",
    ]);
    // davor nur noch die eigene erste Frage, nicht die der fremden Sitzung
    expect(await call({ beforeId: await idOf("Ich bin Anfänger") })).toEqual([
      "Gibt es Yoga?",
    ]);
    // mit größerem limit älteste zuerst
    expect(await call({ beforeId: lastId, limit: 3 })).toEqual([
      "Gibt es Yoga?",
      "Ich bin Anfänger",
      "Und am Abend?",
    ]);
  });

  test("NAK-1: fremde Sitzung mit bekannter conversationId sieht keine Frage des Besitzers", async () => {
    await seedMixed();
    const foreignRow = await db.client.embed_chats.findFirst({
      where: { session_id: FOREIGN_SESSION },
    });
    const result = await call({
      boundSessionId: FOREIGN_SESSION,
      beforeId: foreignRow.id + 1000,
    });
    // nur die eigene Zeile der fremden Sitzung, nie die des Besitzers
    expect(result).toEqual(["FREMD: Gibt es Malkurse?"]);
  });

  test("NAK-1: keine Sitzung, keine Abfrage (leer)", async () => {
    const lastId = await seedMixed();
    const findMany = jest.spyOn(db.client.embed_chats, "findMany");
    expect(await call({ boundSessionId: null, beforeId: lastId })).toEqual([]);
    expect(await call({ boundSessionId: "", beforeId: lastId })).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });

  test("KIE-503: im Bucket der Sitzung (conversationId gleich sessionId) auch Legacy-Zeilen ohne conversation_id, nur der eigenen Sitzung", async () => {
    await seedEmbedChats(db.client, [
      own("Legacy eins", { conversation_id: null }),
      own("Legacy fremd", { conversation_id: null, session_id: "andere" }),
      own("Migriert zwei", { conversation_id: SESSION }),
      own("Letzte Runde", { conversation_id: SESSION }),
    ]);
    const last = await db.client.embed_chats.findFirst({
      where: { prompt: "Letzte Runde" },
    });
    // limit über EARLIER_QUESTIONS_MAX (1), damit die Legacy-Zeile unter der
    // migrierten mitgezählt wird; die fremde Legacy-Zeile dazwischen nie
    expect(
      await call({ conversationId: SESSION, beforeId: last.id, limit: 3 })
    ).toEqual(["Legacy eins", "Migriert zwei"]);
  });

  test("höchstens limit Fragen, die neuesten vor der letzten Runde, älteste zuerst", async () => {
    await seedEmbedChats(
      db.client,
      Array.from({ length: 9 }, (_, i) => own(`Frage ${i + 1}`))
    );
    const last = await db.client.embed_chats.findFirst({
      where: { prompt: "Frage 9" },
    });
    expect(await call({ beforeId: last.id })).toEqual(["Frage 8"]);
    // E-R7: ohne limit gilt EARLIER_QUESTIONS_MAX, dieselbe Zahl wie im
    // Rewriter (Nutzer 16.11. abends: höchstens 1)
    expect(
      await EmbedChats.earlierPrompts({
        embedId: EMBED_ID,
        conversationId: CONVERSATION,
        boundSessionId: SESSION,
        beforeId: last.id,
      })
    ).toEqual(["Frage 8"]);
    expect(await call({ beforeId: last.id, limit: 3 })).toEqual([
      "Frage 6",
      "Frage 7",
      "Frage 8",
    ]);
  });

  test("liest nur das Feld prompt, mit kleinem take und absteigend nach id", async () => {
    const lastId = await seedMixed();
    const findMany = jest.spyOn(db.client.embed_chats, "findMany");
    await call({ beforeId: lastId });
    expect(findMany).toHaveBeenCalledTimes(1);
    const args = findMany.mock.calls[0][0];
    expect(args.select).toEqual({ prompt: true });
    expect(args.take).toBe(1);
    expect(args.orderBy).toEqual({ id: "desc" });
    expect(args.where).toMatchObject({
      embed_id: EMBED_ID,
      include: true,
      conversation_id: CONVERSATION,
      session_id: SESSION,
      id: { lt: lastId },
    });
  });

  test("ohne gültige beforeId keine Abfrage (leer)", async () => {
    await seedMixed();
    const findMany = jest.spyOn(db.client.embed_chats, "findMany");
    for (const beforeId of [null, undefined, "abc", 1.5])
      expect(await call({ beforeId })).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });

  test("Datenbankfehler: null (der Rewriter arbeitet dann wie ohne frühere Fragen)", async () => {
    const lastId = await seedMixed();
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    jest
      .spyOn(db.client.embed_chats, "findMany")
      .mockRejectedValueOnce(new Error("database is locked"));
    expect(await call({ beforeId: lastId })).toBeNull();
    expect(errorSpy).toHaveBeenCalled();
  });
});

// Fixliste rc7 E-R3: Lesen (forEmbedByUser), frühere Fragen (earlierPrompts)
// und Invalidieren (markHistoryInvalid, „Verlauf löschen“ im Widget) meinen
// dieselben Zeilen, sonst tauchen gelöschte Fragen im Verlauf oder im Block
// „Earlier user questions“ wieder auf.
describe("markHistoryInvalid: dieselben Zeilen wie forEmbedByUser und earlierPrompts", () => {
  const read = (conversationId, boundSessionId) =>
    EmbedChats.forEmbedByUser(
      EMBED_ID,
      conversationId,
      null,
      null,
      "conversation_id",
      boundSessionId
    );
  const hiddenIds = async () =>
    (
      await db.client.embed_chats.findMany({
        where: { include: false },
        select: { id: true },
        orderBy: { id: "asc" },
      })
    ).map((r) => r.id);
  const allPrompts = (conversationId, boundSessionId) =>
    call({
      conversationId,
      boundSessionId,
      beforeId: Number.MAX_SAFE_INTEGER,
      limit: 1000,
    });

  // invalidiert die Unterhaltung und gibt die Prompts der Zeilen zurück,
  // die dabei unsichtbar wurden
  async function invalidate(conversationId, boundSessionId) {
    const before = await hiddenIds();
    const rows = await read(conversationId, boundSessionId);
    expect(rows.length).toBeGreaterThan(0);
    expect(await allPrompts(conversationId, boundSessionId)).toEqual(
      rows.map((r) => r.prompt)
    );
    await EmbedChats.markHistoryInvalid(
      EMBED_ID,
      conversationId,
      "conversation_id",
      boundSessionId
    );
    const newlyHidden = (await hiddenIds()).filter(
      (id) => !before.includes(id)
    );
    // genau die gelesenen Zeilen, keine mehr und keine weniger
    expect(newlyHidden).toEqual(rows.map((r) => r.id));
    expect(await read(conversationId, boundSessionId)).toEqual([]);
    expect(await allPrompts(conversationId, boundSessionId)).toEqual([]);
    return rows.map((r) => r.prompt);
  }

  test("eigene Unterhaltung: fremde Sitzung, andere Unterhaltung, anderes Widget und Legacy-Zeilen bleiben", async () => {
    await seedMixed();
    expect(await invalidate(CONVERSATION, SESSION)).toEqual([
      "Gibt es Yoga?",
      "Ich bin Anfänger",
      "Und am Abend?",
      "Wie teuer ist das?",
    ]);
    const stillVisible = (
      await db.client.embed_chats.findMany({
        where: { include: true },
        orderBy: { id: "asc" },
      })
    ).map((r) => r.prompt);
    expect(stillVisible).toEqual([
      "FREMD: Gibt es Malkurse?",
      "ANDERE UNTERHALTUNG: Gibt es Spanisch?",
      "ANDERES WIDGET: Gibt es Tanz?",
      "LEGACY OHNE UNTERHALTUNG: Gibt es Schach?",
    ]);
  });

  test("fremde Sitzung mit bekannter conversationId invalidiert nur ihre eigene Zeile", async () => {
    await seedMixed();
    expect(await invalidate(CONVERSATION, FOREIGN_SESSION)).toEqual([
      "FREMD: Gibt es Malkurse?",
    ]);
    expect((await read(CONVERSATION, SESSION)).map((r) => r.prompt)).toEqual([
      "Gibt es Yoga?",
      "Ich bin Anfänger",
      "Und am Abend?",
      "Wie teuer ist das?",
    ]);
  });

  test("KIE-503: Bucket der Sitzung (conversationId gleich sessionId) mit Legacy-NULL, nur der eigenen Sitzung", async () => {
    await seedEmbedChats(db.client, [
      own("Legacy eins", { conversation_id: null }),
      own("Legacy fremd", { conversation_id: null, session_id: "andere" }),
      own("Migriert zwei", { conversation_id: SESSION }),
      own("Andere Unterhaltung derselben Sitzung"),
    ]);
    expect(await invalidate(SESSION, SESSION)).toEqual([
      "Legacy eins",
      "Migriert zwei",
    ]);
    const stillVisible = (
      await db.client.embed_chats.findMany({
        where: { include: true },
        orderBy: { id: "asc" },
      })
    ).map((r) => r.prompt);
    expect(stillVisible).toEqual([
      "Legacy fremd",
      "Andere Unterhaltung derselben Sitzung",
    ]);
  });

  test("eine Quelle: markHistoryInvalid baut sein WHERE über _historyWhere", async () => {
    await seedMixed();
    const spy = jest.spyOn(EmbedChats, "_historyWhere");
    await EmbedChats.markHistoryInvalid(
      EMBED_ID,
      CONVERSATION,
      "conversation_id",
      SESSION
    );
    expect(spy).toHaveBeenCalledWith(
      EMBED_ID,
      CONVERSATION,
      "conversation_id",
      SESSION
    );
  });
});
