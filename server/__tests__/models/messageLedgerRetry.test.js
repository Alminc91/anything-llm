/* eslint-env jest, node */
// KIE-542 Stufe 1 — Speichern von Chats bei Datenbank-Sperre automatisch
// wiederholen.
//
// Hält ein anderer Schreiber (z. B. der Dokumentimport) die SQLite-Datei
// länger als das Busy-Timeout gesperrt, scheitert die Transaktion aus
// Chat-Zeile und Zählerbuch. Sie wird dann nach kurzer Pause wiederholt
// (höchstens zwei weitere Versuche), ohne Doppelzeile und ohne Doppelzählung.
//
// Alle Prüfungen laufen gegen eine echte SQLite-Datei; die Sperre hält eine
// zweite Verbindung (helpers/sqliteTestDatabase.js, holdLock). Gemessen
// (Prisma 6.14, 14.10.2026): Beide Sperren enden in P1008 "Socket timeout" -
// die Schreibsperre schon beim Beginn (BEGIN IMMEDIATE), die Lesesperre beim
// COMMIT ("transaction failed to commit"). In beiden Fällen ist nichts
// geschrieben. Dass die Engine trotz "Socket timeout" geschrieben hat, ließ
// sich nicht herbeiführen; AK-5 simuliert den Fall deshalb.
//
// Nachbesserung nach dem Review: Eine Wiederholung erkennt ihren früheren
// Versuch an den ids der Zeilen, die er angelegt hat (nicht mehr an Zeitpunkt
// und Inhalt), behält ihren Platz in der Reihe, beginnt nur innerhalb von
// RETRY_BUDGET_MS, und eine gelungene Wiederholung schreibt das Ereignis
// message_ledger_saved_after_retry.
jest.mock(
  "../../utils/prisma",
  () => require("../helpers/sqliteTestDatabase").testPrisma
);
// Der Logger des Servers (im Betrieb winston mit "[backend] warn:"): Hier
// gibt er an die Konsole weiter und merkt sich die Warnungen.
const mockLoggerWarn = jest.fn();
jest.mock("../../utils/logger", () => () => ({
  info: (...args) => console.info(...args),
  error: (...args) => console.error(...args),
  warn: (...args) => {
    mockLoggerWarn(...args);
    console.warn(...args);
  },
}));

const { Prisma } = require("@prisma/client");
const {
  createTestDatabase,
  removeTestDatabases,
  createWorkspace,
  createEmbed,
  holdLock,
  eventsOf,
  berlinCell,
} = require("../helpers/sqliteTestDatabase");
const { MessageLedger } = require("../../models/messageLedger");
const { WorkspaceChats } = require("../../models/workspaceChats");
const { EmbedChats } = require("../../models/embedChats");

// Der erste Test jeder Datei erzeugt die Vorlage mit `prisma migrate deploy`.
jest.setTimeout(60000);

const SECRET = "GEHEIMER CHATINHALT 4711";
const EVENT = "message_ledger_write_failed";
const SAVED_EVENT = "message_ledger_saved_after_retry";

let db;
let spies;
let locks;
beforeEach(() => {
  MessageLedger._resetCache();
  EmbedChats._resetFeedbackLimits();
  locks = [];
  mockLoggerWarn.mockClear();
  spies = ["error", "warn", "log", "info"].map((method) =>
    jest.spyOn(console, method).mockImplementation(() => {})
  );
});
afterEach(async () => {
  for (const lock of locks) await lock.release().catch(() => {});
  await MessageLedger._settleEvents();
  for (const spy of spies) spy.mockRestore();
  jest.restoreAllMocks();
  if (db) await db.close();
  db = null;
});
afterAll(() => {
  MessageLedger._resetCache();
  removeTestDatabases();
});

/** Testdatenbank; busyTimeoutSeconds 1 hält die Tests kurz. */
async function open(busyTimeoutSeconds = 1, options = {}) {
  db = await createTestDatabase({ busyTimeoutSeconds, ...options });
  return db;
}

/** Metadaten der Ereignisse "nach Wiederholung gespeichert". */
async function savedAfterRetry() {
  await MessageLedger._settleEvents();
  return (await eventsOf(db.client, SAVED_EVENT)).map(
    ({ metadata }) => metadata
  );
}

/** Sperre über eine zweite Verbindung, frei nach ms (oder erst am Testende). */
async function lockFor(kind, ms = null) {
  const lock = await holdLock(db.file, kind);
  locks.push(lock);
  if (ms !== null) setTimeout(() => lock.release(), ms);
  return lock;
}

/** Zählt die Versuche: jede Transaktion gegen die Testdatenbank. */
function countTransactions() {
  return jest.spyOn(db.client, "$transaction");
}

/**
 * "Socket timeout nach Commit": Der erste Versuch schreibt wirklich, meldet
 * danach aber P1008, wie es die Engine bei einer Zeitüberschreitung tut.
 */
function timeoutAfterFirstCommit() {
  const original = db.client.$transaction.bind(db.client);
  let calls = 0;
  return jest
    .spyOn(db.client, "$transaction")
    .mockImplementation(async (...args) => {
      const result = await original(...args);
      if (++calls === 1)
        throw new Prisma.PrismaClientKnownRequestError(
          "Socket timeout (the database failed to respond to a query within the configured timeout).",
          { code: "P1008", clientVersion: Prisma.prismaVersion.client }
        );
      return result;
    });
}

async function ledgerSum(where = {}) {
  const { _sum } = await db.client.message_ledger.aggregate({
    where,
    _sum: {
      messages: true,
      copied: true,
      conversations_started: true,
      feedback_positive: true,
      feedback_negative: true,
    },
  });
  return _sum;
}

/** Alles, was in die Konsole ging, als ein Text. */
function consoleText() {
  return spies
    .flatMap((spy) => spy.mock.calls)
    .map((args) => args.map(String).join(" "))
    .join("\n");
}

describe("Fehlerarten", () => {
  test("isLockError erkennt Sperre und Zeitüberschreitung, sonst nichts", () => {
    const known = (code, message = "x") =>
      new Prisma.PrismaClientKnownRequestError(message, {
        code,
        clientVersion: Prisma.prismaVersion.client,
      });
    for (const error of [
      known("P1008"),
      known("P2034"),
      known("P2024"),
      new Error("SQLITE_BUSY: database is locked"),
      new Error("database is locked"),
      new Error(
        "Socket timeout (the database failed to respond to a query within the configured timeout)."
      ),
      new Error("transaction failed to commit"),
      // Der Pool gab innerhalb von maxWait keine Verbindung her: nichts
      // geschrieben, also wiederholbar.
      known(
        "P2028",
        "Transaction API error: Unable to start a transaction in the given time."
      ),
      known(
        "P2010",
        "Raw query failed. Code: `5`. Message: `database is locked`"
      ),
    ])
      expect(MessageLedger.isLockError(error)).toBe(true);

    for (const error of [
      known("P2002", "Unique constraint failed"),
      known("P2003", "Foreign key constraint failed"),
      known("P2028", "Transaction already closed"),
      known(
        "P2028",
        "Transaction API error: Transaction already closed: A commit cannot be executed on an expired transaction."
      ),
      // Nur die letzte Zeile (die Ursache) zählt: Davor kann Prisma den
      // Aufruf samt Inhalten wiedergeben.
      known(
        "P2002",
        'Invalid `prisma.embed_chats.create()` invocation:\n  prompt: "database is locked"\n\nUnique constraint failed on the fields: (`id`)'
      ),
      new Prisma.PrismaClientValidationError(
        'Invalid `prisma.embed_chats.create()` invocation:\n{ data: { prompt: "Socket timeout database is locked" } }\nArgument `prompt`: Invalid value provided. Expected String, provided Object.\ndatabase is locked',
        { clientVersion: Prisma.prismaVersion.client }
      ),
      new Error("künstlicher Fehler im Zählerbuch"),
      new TypeError("cannot read properties of null"),
      null,
      undefined,
      "Socket",
    ])
      expect(MessageLedger.isLockError(error)).toBe(false);
  });

  test("Pausen zwischen den Versuchen: höchstens zwei Wiederholungen, zusammen höchstens 1,2 s; Wiederholungen beginnen nur innerhalb von 8 s", () => {
    expect(MessageLedger.RETRY_DELAYS_MS).toEqual([300, 900]);
    expect(MessageLedger.RETRY_BUDGET_MS).toBe(8000);
  });
});

describe("Sperre wird frei (AK-1, AK-2)", () => {
  test("AK-1: Widget-Chat - Schreibsperre länger als das Busy-Timeout (5 s), 1 s danach frei: genau einmal gespeichert und gezählt", async () => {
    await open(null); // Busy-Timeout wie im Betrieb (5 s)
    const workspace = await createWorkspace(db.client);
    const embed = await createEmbed(db.client, workspace);
    const transactions = countTransactions();
    await lockFor("write", 6000);

    const startedAt = Date.now();
    const { chat, message } = await EmbedChats.new({
      embedId: embed.id,
      prompt: SECRET,
      response: { text: SECRET },
      sessionId: "s1",
    });
    const elapsed = Date.now() - startedAt;

    expect(message).toBeNull();
    expect(chat).toEqual(expect.objectContaining({ embed_id: embed.id }));
    expect(transactions).toHaveBeenCalledTimes(2);
    expect(elapsed).toBeGreaterThanOrEqual(5000);
    expect(elapsed).toBeLessThan(11000);
    expect(await db.client.embed_chats.count()).toBe(1);
    expect(await ledgerSum()).toEqual({
      messages: 1,
      copied: 0,
      conversations_started: 1,
      feedback_positive: 0,
      feedback_negative: 0,
    });
    expect(await eventsOf(db.client, EVENT)).toEqual([]);
    expect(await savedAfterRetry()).toEqual([
      {
        source: "embed_chat",
        workspaceId: null,
        embedId: embed.id,
        attempts: 2,
      },
    ]);
    // Die Wiederholung steht im Log, ohne Inhalte.
    expect(consoleText()).toMatch(/embed_chat.*Versuch 1\/3/);
    expect(consoleText()).toMatch(/nach Wiederholung gespeichert/);
    expect(consoleText()).not.toContain(SECRET);
  }, 30000);

  test('AK-1: Widget-Chat - Lesesperre lässt das COMMIT scheitern ("transaction failed to commit"), der nächste Versuch speichert genau einmal', async () => {
    await open();
    const workspace = await createWorkspace(db.client);
    const embed = await createEmbed(db.client, workspace);
    const transactions = countTransactions();
    await lockFor("read", 1500);

    const { chat, message } = await EmbedChats.new({
      embedId: embed.id,
      prompt: SECRET,
      sessionId: "s1",
    });

    expect(message).toBeNull();
    expect(chat).not.toBeNull();
    expect(transactions.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(await db.client.embed_chats.count()).toBe(1);
    expect(await ledgerSum()).toEqual(
      expect.objectContaining({ messages: 1, conversations_started: 1 })
    );
    expect(await eventsOf(db.client, EVENT)).toEqual([]);
    expect(await savedAfterRetry()).toEqual([
      expect.objectContaining({ source: "embed_chat" }),
    ]);
  });

  test("AK-2: Workspace-Chats aus GUI (Nutzer, Thread) und API (Session) werden nach der Sperre genau einmal gespeichert und gezählt", async () => {
    await open();
    const workspace = await createWorkspace(db.client);

    await lockFor("write", 1500);
    const gui = await WorkspaceChats.new({
      workspaceId: workspace.id,
      prompt: SECRET,
      response: { text: SECRET },
      threadId: 7,
    });
    await lockFor("write", 1500);
    const api = await WorkspaceChats.new({
      workspaceId: workspace.id,
      prompt: SECRET,
      response: { text: SECRET },
      apiSessionId: "api-1",
    });

    expect(gui.message).toBeNull();
    expect(gui.chat).toEqual(expect.objectContaining({ thread_id: 7 }));
    expect(api.message).toBeNull();
    expect(api.chat).toEqual(
      expect.objectContaining({ api_session_id: "api-1" })
    );
    expect(await db.client.workspace_chats.count()).toBe(2);
    expect(await ledgerSum()).toEqual(
      expect.objectContaining({ messages: 2, copied: 0 })
    );
    expect(await savedAfterRetry()).toEqual([
      expect.objectContaining({ source: "workspace_chat", attempts: 2 }),
      expect.objectContaining({ source: "workspace_chat", attempts: 2 }),
    ]);
    expect(await eventsOf(db.client, EVENT)).toEqual([]);
    // NAK-2: Das Kontingent sieht genau diese zwei Nachrichten.
    const { day } = berlinCell(gui.chat.createdAt);
    const nextDay = new Date(Date.parse(`${day}T12:00:00Z`) + 86400000)
      .toISOString()
      .slice(0, 10);
    expect(await MessageLedger.sumMessages(workspace.id, day, nextDay)).toBe(2);
    expect(consoleText()).not.toContain(SECRET);
  });

  test("AK-2: Widget-Bewertung (👍) nach der Sperre genau einmal gebucht", async () => {
    await open();
    const workspace = await createWorkspace(db.client);
    const embed = await createEmbed(db.client, workspace);
    const { chat } = await EmbedChats.new({
      embedId: embed.id,
      prompt: "Frage",
      sessionId: "s1",
    });

    await lockFor("write", 1500);
    const outcome = await EmbedChats.applyFeedback(embed.id, "s1", chat.id, 1);

    expect(outcome).toBe("updated");
    expect(
      (await db.client.embed_chats.findUnique({ where: { id: chat.id } }))
        .feedbackScore
    ).toBe(true);
    expect(await ledgerSum()).toEqual(
      expect.objectContaining({
        messages: 1,
        feedback_positive: 1,
        feedback_negative: 0,
      })
    );
    expect(await savedAfterRetry()).toEqual([
      expect.objectContaining({ source: "embed_feedback" }),
    ]);
  });

  test("AK-2: Thread-Verzweigung - Kopien nach der Sperre genau einmal angelegt und als copied gezählt", async () => {
    await open();
    const workspace = await createWorkspace(db.client);

    await lockFor("write", 1500);
    const { chats, message } = await WorkspaceChats.bulkCreate(
      ["a", "b", "c"].map((prompt) => ({
        workspaceId: workspace.id,
        prompt,
        response: "{}",
        thread_id: 42,
      }))
    );

    expect(message).toBeNull();
    expect(chats).toHaveLength(3);
    expect(await db.client.workspace_chats.count()).toBe(3);
    expect(await ledgerSum()).toEqual(
      expect.objectContaining({ messages: 0, copied: 3 })
    );
  });
});

describe("Sperre bleibt (AK-3)", () => {
  test("AK-3: Sperre über alle Versuche - kein halber Stand, genau ein Ereignis, Rückgabe wie bisher", async () => {
    await open();
    const workspace = await createWorkspace(db.client);
    const embed = await createEmbed(db.client, workspace);
    const transactions = countTransactions();
    const lock = await lockFor("write");

    const startedAt = Date.now();
    const result = await EmbedChats.new({
      embedId: embed.id,
      prompt: SECRET,
      response: { text: SECRET },
      sessionId: "s1",
    });
    const elapsed = Date.now() - startedAt;

    // Rückgabe wie bisher bei einem Fehlschlag: kein Chat, die Meldung.
    expect(result).toEqual({
      chat: null,
      message: expect.stringMatching(/Socket timeout/),
    });
    expect(transactions).toHaveBeenCalledTimes(3);
    // Drei Versuche à 1 s Busy-Timeout und 300 + 900 ms Pause; das Ereignis
    // wird nicht abgewartet. Die obere Grenze lässt Luft für eine
    // ausgelastete Maschine.
    expect(elapsed).toBeGreaterThanOrEqual(3 * 1000 + 1200 - 50);
    expect(elapsed).toBeLessThan(3 * 1000 + 1200 + 5000);

    await lock.release();
    expect(await db.client.embed_chats.count()).toBe(0);
    expect(await db.client.message_ledger.count()).toBe(0);
    // Das Ereignis ließ sich unter derselben Sperre nicht schreiben; es wird
    // nachgereicht - genau eines, mit der Zahl der Versuche.
    await MessageLedger._settleEvents();
    await MessageLedger._flushWriteFailures();
    const events = await eventsOf(db.client, EVENT);
    expect(events.map(({ metadata }) => metadata)).toEqual([
      expect.objectContaining({
        source: "embed_chat",
        embedId: embed.id,
        attempts: 3,
        error: expect.stringMatching(/P1008.*Socket timeout/),
      }),
    ]);
    expect(events[0].metadata.suppressed).toBeUndefined();
    expect(await savedAfterRetry()).toEqual([]);
    // NAK-1: weder in der Konsole noch im Ereignis ein Inhalt
    expect(consoleText()).toMatch(/Versuch 2\/3/);
    expect(consoleText()).not.toContain(SECRET);
    expect(JSON.stringify(events)).not.toContain(SECRET);
  });

  test("AK-3: Workspace-Chat - Schreibsperre über alle Versuche: keine Zeile, keine Zählung, ein Ereignis", async () => {
    await open();
    const workspace = await createWorkspace(db.client);
    const transactions = countTransactions();
    const lock = await lockFor("write");

    const result = await WorkspaceChats.new({
      workspaceId: workspace.id,
      prompt: SECRET,
      response: { text: SECRET },
      threadId: 5,
    });

    expect(result).toEqual({
      chat: null,
      message: expect.stringMatching(/Socket timeout/),
    });
    expect(transactions).toHaveBeenCalledTimes(3);
    await lock.release();
    expect(await db.client.workspace_chats.count()).toBe(0);
    expect(await db.client.message_ledger.count()).toBe(0);
    await MessageLedger._settleEvents();
    await MessageLedger._flushWriteFailures();
    expect(
      (await eventsOf(db.client, EVENT)).map(({ metadata }) => metadata)
    ).toEqual([
      expect.objectContaining({
        source: "workspace_chat",
        workspaceId: workspace.id,
        attempts: 3,
      }),
    ]);
    expect(await savedAfterRetry()).toEqual([]);
    expect(consoleText()).not.toContain(SECRET);
  });

  test("AK-3: Lesesperre über alle Versuche - jedes COMMIT scheitert, danach steht nichts in Chat-Zeilen und Zählerbuch", async () => {
    await open();
    const workspace = await createWorkspace(db.client);
    const embed = await createEmbed(db.client, workspace);
    const transactions = countTransactions();
    const lock = await lockFor("read");

    const result = await EmbedChats.new({
      embedId: embed.id,
      prompt: SECRET,
      sessionId: "s1",
    });

    expect(result.chat).toBeNull();
    expect(transactions).toHaveBeenCalledTimes(3);
    await lock.release();
    // Kein halber Stand: Keines der drei geschriebenen, aber nicht
    // übernommenen Ergebnisse ist geblieben.
    expect(await db.client.embed_chats.count()).toBe(0);
    expect(await db.client.message_ledger.count()).toBe(0);
    await MessageLedger._settleEvents();
    await MessageLedger._flushWriteFailures();
    expect(
      (await eventsOf(db.client, EVENT)).map(({ metadata }) => metadata)
    ).toEqual([expect.objectContaining({ source: "embed_chat", attempts: 3 })]);
  });

  test("AK-3: Widget-Bewertung - Sperre über alle Versuche: Bewertung und Zähler unverändert, ein Ereignis", async () => {
    await open();
    const workspace = await createWorkspace(db.client);
    const embed = await createEmbed(db.client, workspace);
    const { chat } = await EmbedChats.new({
      embedId: embed.id,
      prompt: "Frage",
      sessionId: "s1",
    });
    const before = await ledgerSum();
    const transactions = countTransactions();
    const lock = await lockFor("write");

    expect(await EmbedChats.applyFeedback(embed.id, "s1", chat.id, 1)).toBe(
      "error"
    );

    expect(transactions).toHaveBeenCalledTimes(3);
    await lock.release();
    expect(
      (await db.client.embed_chats.findUnique({ where: { id: chat.id } }))
        .feedbackScore
    ).toBeNull();
    expect(await ledgerSum()).toEqual(before);
    await MessageLedger._settleEvents();
    await MessageLedger._flushWriteFailures();
    expect(
      (await eventsOf(db.client, EVENT)).map(({ metadata }) => metadata)
    ).toEqual([
      expect.objectContaining({ source: "embed_feedback", attempts: 3 }),
    ]);
  });

  test("Gesamtdauer begrenzt: Mit Busy-Timeout wie im Betrieb (5 s) gibt eine anhaltende Sperre nach zwei Versuchen auf (≈ 2 x 5 s + 300 ms statt 3 x 5 s + 1,2 s)", async () => {
    await open(null);
    const workspace = await createWorkspace(db.client);
    const embed = await createEmbed(db.client, workspace);
    const transactions = countTransactions();
    await lockFor("write");

    const startedAt = Date.now();
    const result = await EmbedChats.new({
      embedId: embed.id,
      prompt: SECRET,
      sessionId: "s1",
    });
    const elapsed = Date.now() - startedAt;

    expect(result.chat).toBeNull();
    // Die zweite Wiederholung begänne erst nach ≈ 10,3 s + 900 ms > 8 s.
    expect(transactions).toHaveBeenCalledTimes(2);
    // 2 x 5 s + 300 ms. Das Ereignis (unter derselben Sperre bis zu 5 s)
    // wartet der Aufrufer nicht ab; vorher bis zu 3 x 5 s + 1,2 s + 5 s.
    expect(elapsed).toBeGreaterThanOrEqual(2 * 5000 + 300 - 50);
    expect(elapsed).toBeLessThan(2 * 5000 + 300 + 1500);
    expect(consoleText()).toMatch(/nach 2 Versuchen/);
  }, 40000);

  test("Gesamtdauer begrenzt: Eine Wiederholung beginnt nur, solange RETRY_BUDGET_MS seit dem ersten Versuch nicht überschritten ist", async () => {
    await open();
    const workspace = await createWorkspace(db.client);
    const embed = await createEmbed(db.client, workspace);
    const transactions = countTransactions();
    await lockFor("write");
    const budget = MessageLedger.RETRY_BUDGET_MS;
    MessageLedger.RETRY_BUDGET_MS = 1500;
    try {
      const result = await EmbedChats.new({
        embedId: embed.id,
        prompt: "Frage",
        sessionId: "s1",
      });
      expect(result.chat).toBeNull();
    } finally {
      MessageLedger.RETRY_BUDGET_MS = budget;
    }
    // 1 s + 300 ms < 1,5 s: zweiter Versuch; 2,3 s + 900 ms > 1,5 s: kein dritter
    expect(transactions).toHaveBeenCalledTimes(2);
  });
});

describe("andere Fehler (AK-4)", () => {
  test("AK-4: Fremdschlüssel-Verletzung wird nicht wiederholt", async () => {
    await open();
    const transactions = countTransactions();
    const result = await EmbedChats.new({
      embedId: 999999,
      prompt: SECRET,
      sessionId: "s1",
    });

    expect(result.chat).toBeNull();
    expect(result.message).toMatch(/Foreign key constraint/);
    expect(transactions).toHaveBeenCalledTimes(1);
    await MessageLedger._settleEvents();
    const events = await eventsOf(db.client, EVENT);
    expect(events).toHaveLength(1);
    expect(events[0].metadata.attempts).toBeUndefined();
    expect(consoleText()).not.toMatch(/Speichern gesperrt/);
  });

  test("AK-4: ein Fehler im Zählerbuch (kein Sperrfehler) wird nicht wiederholt", async () => {
    await open();
    const workspace = await createWorkspace(db.client);
    await db.client.$executeRawUnsafe(
      `CREATE TRIGGER kuenstlicher_fehler BEFORE INSERT ON message_ledger
       BEGIN SELECT RAISE(ABORT, 'künstlicher Fehler im Zählerbuch'); END`
    );
    const transactions = countTransactions();
    const result = await WorkspaceChats.new({
      workspaceId: workspace.id,
      prompt: "Hallo",
    });

    expect(result.chat).toBeNull();
    expect(result.message).toMatch(/künstlicher Fehler/);
    expect(transactions).toHaveBeenCalledTimes(1);
    expect(await db.client.workspace_chats.count()).toBe(0);
    expect(consoleText()).not.toMatch(/Speichern gesperrt/);
  });

  test("ohne Angabe des Aufrufers, wie eine Wiederholung sicher ist, wird auch ein Sperrfehler nicht wiederholt", async () => {
    await open();
    const workspace = await createWorkspace(db.client);
    const transactions = countTransactions();
    await lockFor("write", 1500);

    await expect(
      MessageLedger.transaction({ source: "test" }, (tx) =>
        MessageLedger.record(tx, {
          workspaceId: workspace.id,
          at: new Date(),
          messages: 1,
        })
      )
    ).rejects.toThrow(/Socket timeout/);
    expect(transactions).toHaveBeenCalledTimes(1);
    expect(consoleText()).not.toMatch(/Speichern gesperrt/);
  });
});

describe("Zeitüberschreitung nach Commit (AK-5)", () => {
  test("AK-5: Widget-Chat - keine Doppelzeile, keine Doppelzählung", async () => {
    await open();
    const workspace = await createWorkspace(db.client);
    const embed = await createEmbed(db.client, workspace);
    const transactions = timeoutAfterFirstCommit();

    const { chat, message } = await EmbedChats.new({
      embedId: embed.id,
      prompt: SECRET,
      sessionId: "s1",
      conversationId: "k1",
    });

    expect(message).toBeNull();
    expect(transactions).toHaveBeenCalledTimes(2);
    const rows = await db.client.embed_chats.findMany();
    expect(rows).toHaveLength(1);
    // Zurück kommt die Zeile des ersten Versuchs.
    expect(chat.id).toBe(rows[0].id);
    expect(await ledgerSum()).toEqual(
      expect.objectContaining({ messages: 1, conversations_started: 1 })
    );
    expect(await eventsOf(db.client, EVENT)).toEqual([]);
    expect(await savedAfterRetry()).toEqual([
      expect.objectContaining({ attempts: 2, alreadySaved: true }),
    ]);
    expect(consoleText()).toMatch(/schon beim früheren Versuch gespeichert/);
    expect(consoleText()).not.toContain(SECRET);
  });

  test("AK-5: eine gleichlautende frühere Nachricht derselben Sitzung gilt nicht als schon gespeichert", async () => {
    await open();
    const workspace = await createWorkspace(db.client);
    const embed = await createEmbed(db.client, workspace);
    await EmbedChats.new({
      embedId: embed.id,
      prompt: "Hallo",
      sessionId: "s1",
    });
    await lockFor("write", 1500);

    const { chat } = await EmbedChats.new({
      embedId: embed.id,
      prompt: "Hallo",
      sessionId: "s1",
    });

    expect(chat).not.toBeNull();
    expect(await db.client.embed_chats.count()).toBe(2);
    expect(await ledgerSum()).toEqual(
      expect.objectContaining({ messages: 2, conversations_started: 1 })
    );
    expect(await savedAfterRetry()).toEqual([
      expect.not.objectContaining({ alreadySaved: true }),
    ]);
  });

  test("AK-5: Workspace-Chat (GUI und API) - keine Doppelzeile, keine Doppelzählung", async () => {
    await open();
    const workspace = await createWorkspace(db.client);

    const first = timeoutAfterFirstCommit();
    const gui = await WorkspaceChats.new({
      workspaceId: workspace.id,
      prompt: SECRET,
      threadId: 3,
    });
    first.mockRestore();
    timeoutAfterFirstCommit();
    const api = await WorkspaceChats.new({
      workspaceId: workspace.id,
      prompt: SECRET,
      apiSessionId: "api-1",
    });

    expect(gui.message).toBeNull();
    expect(api.message).toBeNull();
    const rows = await db.client.workspace_chats.findMany({
      orderBy: { id: "asc" },
    });
    expect(rows.map((row) => row.id)).toEqual([gui.chat.id, api.chat.id]);
    expect(await ledgerSum()).toEqual(
      expect.objectContaining({ messages: 2, copied: 0 })
    );
    expect(await savedAfterRetry()).toEqual([
      expect.objectContaining({ source: "workspace_chat", alreadySaved: true }),
      expect.objectContaining({ source: "workspace_chat", alreadySaved: true }),
    ]);
  });

  test("AK-5: Widget-Bewertung - keine Doppelbuchung", async () => {
    await open();
    const workspace = await createWorkspace(db.client);
    const embed = await createEmbed(db.client, workspace);
    const { chat } = await EmbedChats.new({
      embedId: embed.id,
      prompt: "Frage",
      sessionId: "s1",
    });

    const transactions = timeoutAfterFirstCommit();
    expect(await EmbedChats.applyFeedback(embed.id, "s1", chat.id, 0)).toBe(
      "updated"
    );

    expect(transactions).toHaveBeenCalledTimes(2);
    expect(await ledgerSum()).toEqual(
      expect.objectContaining({ feedback_positive: 0, feedback_negative: 1 })
    );
  });

  test("AK-5: Thread-Verzweigung - keine doppelten Kopien", async () => {
    await open();
    const workspace = await createWorkspace(db.client);

    const transactions = timeoutAfterFirstCommit();
    const { chats, message } = await WorkspaceChats.bulkCreate(
      ["a", "b"].map((prompt) => ({
        workspaceId: workspace.id,
        prompt,
        response: "{}",
        thread_id: 9,
      }))
    );

    expect(message).toBeNull();
    expect(transactions).toHaveBeenCalledTimes(2);
    expect(chats.map((chat) => chat.prompt)).toEqual(["a", "b"]);
    expect(await db.client.workspace_chats.count()).toBe(2);
    expect(await ledgerSum()).toEqual(
      expect.objectContaining({ messages: 0, copied: 2 })
    );
  });
});

describe("Nachbesserung nach dem Review", () => {
  test("ein Validierungsfehler wird nicht wiederholt, auch wenn die Nachricht 'database is locked' enthält", async () => {
    await open();
    const workspace = await createWorkspace(db.client);
    const embed = await createEmbed(db.client, workspace);
    const transactions = countTransactions();

    // Ein Objekt statt Text: Prisma meldet einen Validierungsfehler und gibt
    // dabei die Argumente des Aufrufs wieder.
    const result = await EmbedChats.new({
      embedId: embed.id,
      prompt: { text: "Socket timeout: database is locked" },
      sessionId: "s1",
    });

    expect(result.chat).toBeNull();
    expect(result.message).toMatch(/database is locked/);
    expect(transactions).toHaveBeenCalledTimes(1);
    expect(consoleText()).not.toMatch(/Speichern gesperrt/);
    await MessageLedger._settleEvents();
    const events = await eventsOf(db.client, EVENT);
    expect(events).toHaveLength(1);
    expect(events[0].metadata.attempts).toBeUndefined();
  });

  test("P2028 'Unable to start a transaction in the given time' (Pool belegt, weil eine andere Anfrage im Busy-Timeout hängt) wird wiederholt", async () => {
    // Eine Verbindung im Pool: Eine Anfrage außerhalb des Zählerbuchs hängt
    // unter der Sperre im Busy-Timeout und hält sie, die Transaktion bekommt
    // innerhalb von maxWait keine.
    await open(1, { connectionLimit: 1 });
    const workspace = await createWorkspace(db.client);
    const transactions = countTransactions();
    await lockFor("write", 1200);
    const blocking = db.client.workspaces
      .create({ data: { name: "fremd", slug: "fremd" } })
      .catch((error) => error);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const errors = [];
    await MessageLedger.transaction(
      { source: "test", workspaceId: workspace.id },
      (tx) =>
        MessageLedger.record(tx, {
          workspaceId: workspace.id,
          at: new Date(),
          messages: 1,
        }),
      { maxWait: 200, retry: { idempotent: true } }
    ).catch((error) => errors.push(error));

    await blocking;
    expect(errors).toEqual([]);
    expect(transactions.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(consoleText()).toMatch(
      /Speichern gesperrt.*P2028.*Unable to start a transaction/
    );
    expect(await ledgerSum()).toEqual(expect.objectContaining({ messages: 1 }));
  });

  test("die Wiederholung behält ihren Platz in der Reihe: Ein später begonnener Chat wird nicht vor ihr gespeichert (id und createdAt in Reihenfolge)", async () => {
    await open();
    const workspace = await createWorkspace(db.client);
    // Frei kurz nach dem Busy-Timeout des ersten Versuchs, während seiner
    // Pause von 300 ms.
    await lockFor("write", 1100);

    const first = WorkspaceChats.new({
      workspaceId: workspace.id,
      prompt: "A",
      apiSessionId: "api-1",
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const second = WorkspaceChats.new({
      workspaceId: workspace.id,
      prompt: "B",
      apiSessionId: "api-1",
    });
    const [a, b] = await Promise.all([first, second]);

    expect(a.chat.id).toBeLessThan(b.chat.id);
    expect(a.chat.createdAt.getTime()).toBeLessThanOrEqual(
      b.chat.createdAt.getTime()
    );
    expect(await ledgerSum()).toEqual(expect.objectContaining({ messages: 2 }));
  });

  test("gleichlautender Chat ohne Nutzer, Thread und Session im selben Augenblick: die Wiederholung übernimmt nicht die fremde Zeile", async () => {
    await open();
    const workspace = await createWorkspace(db.client);
    // Gleiche Millisekunde: Date steht still, alles andere läuft weiter.
    jest.useFakeTimers({
      now: new Date("2026-10-14T10:00:00.000Z"),
      doNotFake: [
        "hrtime",
        "nextTick",
        "performance",
        "queueMicrotask",
        "setImmediate",
        "clearImmediate",
        "setInterval",
        "clearInterval",
        "setTimeout",
        "clearTimeout",
      ],
    });
    try {
      const refusal = { text: "Keine passenden Informationen.", sources: [] };
      const earlier = await WorkspaceChats.new({
        workspaceId: workspace.id,
        prompt: "Hallo",
        response: refusal,
        include: false,
      });
      // Dieselbe Zeile noch einmal, wie von einem zweiten Aufruf im selben
      // Augenblick - dieser scheitert zuerst an der Sperre.
      await db.client.workspace_chats.update({
        where: { id: earlier.chat.id },
        data: { createdAt: new Date() },
      });
      await lockFor("write", 1500);
      const later = await WorkspaceChats.new({
        workspaceId: workspace.id,
        prompt: "Hallo",
        response: refusal,
        include: false,
      });

      expect(later.chat).not.toBeNull();
      expect(later.chat.id).not.toBe(earlier.chat.id);
    } finally {
      jest.useRealTimers();
    }
    expect(await db.client.workspace_chats.count()).toBe(2);
    expect(await ledgerSum()).toEqual(expect.objectContaining({ messages: 2 }));
  });

  test("Thread-Verzweigung in einen Thread, der schon Zeilen hat: Die Wiederholung legt die Kopien trotzdem an", async () => {
    await open();
    const workspace = await createWorkspace(db.client);
    await WorkspaceChats.new({
      workspaceId: workspace.id,
      prompt: "schon da",
      threadId: 42,
    });

    await lockFor("write", 1500);
    const { chats, message } = await WorkspaceChats.bulkCreate(
      ["a", "b"].map((prompt) => ({
        workspaceId: workspace.id,
        prompt,
        response: "{}",
        thread_id: 42,
      }))
    );

    expect(message).toBeNull();
    expect(chats.map((chat) => chat.prompt)).toEqual(["a", "b"]);
    expect(
      (
        await db.client.workspace_chats.findMany({
          where: { thread_id: 42 },
          orderBy: { id: "asc" },
        })
      ).map((chat) => chat.prompt)
    ).toEqual(["schon da", "a", "b"]);
    expect(await ledgerSum()).toEqual(
      expect.objectContaining({ messages: 1, copied: 2 })
    );
  });

  test("Thread-Verzweigung: Schreibt ein anderer während der Sperre eine Zeile in den neuen Thread, legt die Wiederholung die Kopien trotzdem an", async () => {
    await open();
    const workspace = await createWorkspace(db.client);
    // Die Sperre hält ein fremder Schreiber, der selbst in den Thread schreibt.
    const lock = await lockFor("write", 1500);
    await lock.client.$executeRawUnsafe(
      `INSERT INTO workspace_chats (workspaceId, prompt, response, thread_id, include, createdAt, lastUpdatedAt)
       VALUES (${workspace.id}, 'fremd', '{}', 77, 1, ${Date.now()}, ${Date.now()})`
    );

    const { chats } = await WorkspaceChats.bulkCreate(
      ["a", "b", "c"].map((prompt) => ({
        workspaceId: workspace.id,
        prompt,
        response: "{}",
        thread_id: 77,
      }))
    );

    expect(chats.map((chat) => chat.prompt)).toEqual(["a", "b", "c"]);
    expect(
      await db.client.workspace_chats.count({ where: { thread_id: 77 } })
    ).toBe(4);
    expect(await ledgerSum()).toEqual(expect.objectContaining({ copied: 3 }));
  });

  test("die Prüfung vor der Wiederholung sucht über den Primärschlüssel", async () => {
    await open();
    const workspace = await createWorkspace(db.client);
    const lookups = [];
    const original = db.client.$transaction.bind(db.client);
    let calls = 0;
    jest
      .spyOn(db.client, "$transaction")
      .mockImplementation(async (fn, options) => {
        const result = await original(
          (tx) =>
            fn(
              new Proxy(tx, {
                get(target, model) {
                  const delegate = target[model];
                  if (model !== "workspace_chats") return delegate;
                  return new Proxy(delegate, {
                    get(d, method) {
                      if (!["findFirst", "findMany"].includes(method))
                        return d[method];
                      return (args) => {
                        lookups.push({ method, where: args?.where });
                        return d[method](args);
                      };
                    },
                  });
                },
              })
            ),
          options
        );
        if (++calls === 1)
          throw new Prisma.PrismaClientKnownRequestError("Socket timeout", {
            code: "P1008",
            clientVersion: Prisma.prismaVersion.client,
          });
        return result;
      });

    const { chat } = await WorkspaceChats.new({
      workspaceId: workspace.id,
      prompt: SECRET,
    });

    expect(lookups).toEqual([
      { method: "findMany", where: { id: { in: [chat.id] } } },
    ]);
    expect(await db.client.workspace_chats.count()).toBe(1);
  });
});

describe("Nachbesserung nach der Kontrolle (rc2)", () => {
  /**
   * Wie timeoutAfterFirstCommit, dazu zwischen den Versuchen ein Eingriff von
   * außerhalb der Reihe (etwa "Neuer Chat" in der Pause vor der Wiederholung).
   */
  function timeoutAfterFirstCommitThen(meanwhile) {
    const original = db.client.$transaction.bind(db.client);
    let calls = 0;
    return jest
      .spyOn(db.client, "$transaction")
      .mockImplementation(async (...args) => {
        const result = await original(...args);
        if (++calls === 1) {
          await meanwhile();
          throw new Prisma.PrismaClientKnownRequestError(
            "Socket timeout (the database failed to respond to a query within the configured timeout).",
            { code: "P1008", clientVersion: Prisma.prismaVersion.client }
          );
        }
        return result;
      });
  }

  test("F07: Widget-Chat - Historie in der Pause zurückgesetzt (include = false): keine Doppelzeile, keine Doppelzählung, der Reset bleibt", async () => {
    await open();
    const workspace = await createWorkspace(db.client);
    const embed = await createEmbed(db.client, workspace);
    const transactions = timeoutAfterFirstCommitThen(() =>
      EmbedChats.markHistoryInvalid(embed.id, "s1")
    );

    const { chat, message } = await EmbedChats.new({
      embedId: embed.id,
      prompt: SECRET,
      sessionId: "s1",
    });

    expect(message).toBeNull();
    expect(transactions).toHaveBeenCalledTimes(2);
    const rows = await db.client.embed_chats.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0].include).toBe(false);
    expect(chat.id).toBe(rows[0].id);
    expect(await ledgerSum()).toEqual(
      expect.objectContaining({ messages: 1, conversations_started: 1 })
    );
    expect(await savedAfterRetry()).toEqual([
      expect.objectContaining({ attempts: 2, alreadySaved: true }),
    ]);
  });

  test("F07: Workspace-Chat - Historie in der Pause zurückgesetzt und bewertet: keine Doppelzeile, keine Doppelzählung", async () => {
    await open();
    const workspace = await createWorkspace(db.client);
    timeoutAfterFirstCommitThen(async () => {
      await WorkspaceChats.markThreadHistoryInvalidV2({
        workspaceId: workspace.id,
      });
      const [row] = await db.client.workspace_chats.findMany();
      await WorkspaceChats.updateFeedbackScore(row.id, 1);
    });

    const { chat, message } = await WorkspaceChats.new({
      workspaceId: workspace.id,
      prompt: SECRET,
      threadId: 4,
    });

    expect(message).toBeNull();
    const rows = await db.client.workspace_chats.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(
      expect.objectContaining({ include: false, feedbackScore: true })
    );
    expect(chat.id).toBe(rows[0].id);
    expect(await ledgerSum()).toEqual(expect.objectContaining({ messages: 1 }));
  });

  test("F07: Thread-Verzweigung - Kopien in der Pause zurückgesetzt: keine doppelten Kopien", async () => {
    await open();
    const workspace = await createWorkspace(db.client);
    timeoutAfterFirstCommitThen(() =>
      WorkspaceChats.markThreadHistoryInvalidV2({ thread_id: 11 })
    );

    const { chats } = await WorkspaceChats.bulkCreate(
      ["a", "b"].map((prompt) => ({
        workspaceId: workspace.id,
        prompt,
        response: "{}",
        thread_id: 11,
      }))
    );

    expect(chats.map((chat) => chat.prompt)).toEqual(["a", "b"]);
    expect(await db.client.workspace_chats.count()).toBe(2);
    expect(await ledgerSum()).toEqual(expect.objectContaining({ copied: 2 }));
  });

  test("F08: Der Aufrufer wartet das Ereignis message_ledger_write_failed nicht ab; es steht trotzdem im Protokoll", async () => {
    await open();
    const workspace = await createWorkspace(db.client);
    const embed = await createEmbed(db.client, workspace);
    const logged = jest.spyOn(MessageLedger, "_logWriteFailed");
    const lock = await lockFor("write");

    const result = await EmbedChats.new({
      embedId: embed.id,
      prompt: SECRET,
      sessionId: "s1",
    });

    expect(result.chat).toBeNull();
    expect(logged).toHaveBeenCalledTimes(1);
    // Das Ereignis hängt noch unter der Sperre, der Aufrufer hat sein
    // Ergebnis schon; die Konsolenzeile steht sofort da.
    let settled = false;
    const settling = MessageLedger._settleEvents().then(() => {
      settled = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    expect(consoleText()).toMatch(/nicht geschrieben.*nach 3 Versuchen/);

    await lock.release();
    await settling;
    await MessageLedger._flushWriteFailures();
    expect(
      (await eventsOf(db.client, EVENT)).map(({ metadata }) => metadata)
    ).toEqual([expect.objectContaining({ source: "embed_chat", attempts: 3 })]);
    expect(consoleText()).not.toContain(SECRET);
  });

  test("F21 (NAK-1): Validierungsfehler mit Chat-Inhalt - die Aufrufer schreiben den Inhalt nicht ins Log", async () => {
    await open();
    const workspace = await createWorkspace(db.client);
    const embed = await createEmbed(db.client, workspace);

    // Ein Objekt statt Text: Prisma gibt in der Meldung die Argumente wieder.
    const embedChat = await EmbedChats.new({
      embedId: embed.id,
      prompt: { text: SECRET },
      sessionId: "s1",
    });
    const workspaceChat = await WorkspaceChats.new({
      workspaceId: workspace.id,
      prompt: { text: SECRET },
    });
    const fork = await WorkspaceChats.bulkCreate([
      { workspaceId: workspace.id, prompt: { text: SECRET }, response: "{}" },
    ]);
    await MessageLedger._settleEvents();

    expect(embedChat.chat).toBeNull();
    expect(workspaceChat.chat).toBeNull();
    expect(fork.chats).toBeNull();
    // Die Rückgabe an den Aufrufer bleibt wie bisher (volle Meldung).
    expect(embedChat.message).toContain(SECRET);
    expect(consoleText()).toMatch(/\[EmbedChats\.new\].*Validation/);
    expect(consoleText()).toMatch(/\[WorkspaceChats\.new\].*Validation/);
    expect(consoleText()).toMatch(/\[WorkspaceChats\.bulkCreate\].*Validation/);
    expect(consoleText()).not.toContain(SECRET);
    expect(JSON.stringify(await eventsOf(db.client, EVENT))).not.toContain(
      SECRET
    );
  });

  test("Vertrag createdRows: Meldet work keine angelegte Zeile, wird gewarnt (ohne Inhalte) und nicht wiederholt", async () => {
    await open();
    const workspace = await createWorkspace(db.client);
    const transactions = timeoutAfterFirstCommit();

    await expect(
      MessageLedger.transaction(
        { source: "test", workspaceId: workspace.id },
        async (tx) => {
          const chat = await tx.workspace_chats.create({
            data: { workspaceId: workspace.id, prompt: SECRET, response: "{}" },
          });
          await MessageLedger.record(tx, {
            workspaceId: workspace.id,
            at: chat.createdAt,
            messages: 1,
          });
        },
        { retry: { createdRows: true } }
      )
    ).rejects.toThrow(/Socket timeout/);

    expect(transactions).toHaveBeenCalledTimes(1);
    // Der erste Versuch hat wirklich geschrieben; ohne Wiederholung bleibt es
    // bei einer Zeile und einer Zählung.
    expect(await db.client.workspace_chats.count()).toBe(1);
    expect(await ledgerSum()).toEqual(expect.objectContaining({ messages: 1 }));
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.stringMatching(/keine angelegte Zeile gemeldet.*Workspace/)
    );
    expect(consoleText()).not.toMatch(/Speichern gesperrt/);
    expect(consoleText()).not.toContain(SECRET);
  });

  test("F19: Das Budget misst unabhängig von der Systemuhr (steht die Uhr still, gibt es trotzdem keinen dritten Versuch)", async () => {
    await open();
    const workspace = await createWorkspace(db.client);
    const embed = await createEmbed(db.client, workspace);
    const transactions = countTransactions();
    await lockFor("write");
    const budget = MessageLedger.RETRY_BUDGET_MS;
    MessageLedger.RETRY_BUDGET_MS = 1500;
    // Die Wanduhr (Date) steht still, alles andere läuft weiter.
    jest.useFakeTimers({
      now: new Date("2026-10-14T10:00:00.000Z"),
      doNotFake: [
        "hrtime",
        "nextTick",
        "performance",
        "queueMicrotask",
        "setImmediate",
        "clearImmediate",
        "setInterval",
        "clearInterval",
        "setTimeout",
        "clearTimeout",
      ],
    });
    try {
      const result = await EmbedChats.new({
        embedId: embed.id,
        prompt: "Frage",
        sessionId: "s1",
      });
      expect(result.chat).toBeNull();
    } finally {
      jest.useRealTimers();
      MessageLedger.RETRY_BUDGET_MS = budget;
    }
    // 1 s + 300 ms < 1,5 s: zweiter Versuch; 2,3 s + 900 ms > 1,5 s: kein dritter
    expect(transactions).toHaveBeenCalledTimes(2);
  });

  test("Der Hinweis 'Speichern gesperrt' geht über den Logger des Servers (im Betrieb mit '[backend] warn:')", async () => {
    await open();
    const workspace = await createWorkspace(db.client);
    await lockFor("write", 1500);

    const { chat } = await WorkspaceChats.new({
      workspaceId: workspace.id,
      prompt: SECRET,
    });

    expect(chat).not.toBeNull();
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.stringMatching(/Speichern gesperrt.*workspace_chat.*Versuch 1\/3/)
    );
    expect(mockLoggerWarn.mock.calls.flat().join("\n")).not.toContain(SECRET);
  });
});
