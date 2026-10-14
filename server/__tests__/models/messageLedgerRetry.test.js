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
jest.mock(
  "../../utils/prisma",
  () => require("../helpers/sqliteTestDatabase").testPrisma
);

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

let db;
let spies;
let locks;
beforeEach(() => {
  MessageLedger._resetCache();
  EmbedChats._resetFeedbackLimits();
  locks = [];
  spies = ["error", "warn", "log", "info"].map((method) =>
    jest.spyOn(console, method).mockImplementation(() => {})
  );
});
afterEach(async () => {
  for (const lock of locks) await lock.release().catch(() => {});
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
async function open(busyTimeoutSeconds = 1) {
  db = await createTestDatabase({ busyTimeoutSeconds });
  return db;
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
    ])
      expect(MessageLedger.isLockError(error)).toBe(true);

    for (const error of [
      known("P2002", "Unique constraint failed"),
      known("P2003", "Foreign key constraint failed"),
      known("P2028", "Transaction already closed"),
      new Error("künstlicher Fehler im Zählerbuch"),
      new TypeError("cannot read properties of null"),
      null,
      undefined,
      "Socket",
    ])
      expect(MessageLedger.isLockError(error)).toBe(false);
  });

  test("Pausen zwischen den Versuchen: höchstens zwei Wiederholungen, zusammen höchstens 1,2 s", () => {
    expect(MessageLedger.RETRY_DELAYS_MS).toEqual([300, 900]);
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
    expect(MessageLedger.retryStats()).toEqual({
      retried: 1,
      savedAfterRetry: 1,
      alreadySaved: 0,
      failedAfterRetries: 0,
    });
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
    expect(MessageLedger.retryStats().savedAfterRetry).toBe(1);
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
    expect(MessageLedger.retryStats()).toEqual(
      expect.objectContaining({ savedAfterRetry: 2, failedAfterRetries: 0 })
    );
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
    expect(MessageLedger.retryStats().savedAfterRetry).toBe(1);
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
    // Drei Versuche à 1 s Busy-Timeout und 300 + 900 ms Pause; dazu der
    // Versuch, das Ereignis zu schreiben (ebenfalls 1 s Busy-Timeout). Die
    // obere Grenze lässt Luft für eine ausgelastete Maschine.
    expect(elapsed).toBeGreaterThanOrEqual(3 * 1000 + 1200 - 50);
    expect(elapsed).toBeLessThan(3 * 1000 + 1200 + 1000 + 5000);

    await lock.release();
    expect(await db.client.embed_chats.count()).toBe(0);
    expect(await db.client.message_ledger.count()).toBe(0);
    // Das Ereignis ließ sich unter derselben Sperre nicht schreiben; es wird
    // nachgereicht - genau eines, mit der Zahl der Versuche.
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
    expect(MessageLedger.retryStats()).toEqual({
      retried: 2,
      savedAfterRetry: 0,
      alreadySaved: 0,
      failedAfterRetries: 1,
    });
    // NAK-1: weder in der Konsole noch im Ereignis ein Inhalt
    expect(consoleText()).toMatch(/Versuch 2\/3/);
    expect(consoleText()).not.toContain(SECRET);
    expect(JSON.stringify(events)).not.toContain(SECRET);
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
    const events = await eventsOf(db.client, EVENT);
    expect(events).toHaveLength(1);
    expect(events[0].metadata.attempts).toBeUndefined();
    expect(MessageLedger.retryStats().retried).toBe(0);
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
    expect(MessageLedger.retryStats().retried).toBe(0);
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
    expect(MessageLedger.retryStats().retried).toBe(0);
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
    expect(MessageLedger.retryStats()).toEqual({
      retried: 1,
      savedAfterRetry: 0,
      alreadySaved: 1,
      failedAfterRetries: 0,
    });
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
    expect(MessageLedger.retryStats()).toEqual(
      expect.objectContaining({ savedAfterRetry: 1, alreadySaved: 0 })
    );
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
    expect(MessageLedger.retryStats().alreadySaved).toBe(2);
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
