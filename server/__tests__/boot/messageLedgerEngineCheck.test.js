/* eslint-env jest, node */
// KIE-532 / AK-19 — Selbsttest der Query-Engine beim Start: Die interaktive
// Transaktion des Zählerbuchs setzt mehr Arbeits-Threads als
// Pool-Verbindungen voraus. Der Startpfad prüft das vor dem Lauschen; ein
// nicht bestandener Test steht in der Konsole und als Ereignis
// message_ledger_engine_check_failed im Protokoll, der Server startet
// trotzdem.
//
// Mit wie vielen Threads die Engine lädt, entscheidet die Umgebung des
// Prozesses. Jest gibt Tests nur eine Kopie von process.env, die die Engine
// nicht erreicht: Der Startpfad läuft deshalb in einem gewöhnlichen
// Node-Prozess (helpers/engineCheckProcess.js) gegen eine echte SQLite-Datei
// aus den Migrationen. Nur die rechnerische Prüfung, die die Engine nicht
// braucht, läuft zusätzlich hier im Jest-Prozess.
jest.mock(
  "../../utils/prisma",
  () => require("../helpers/sqliteTestDatabase").testPrisma
);

const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  createTestDatabase,
  removeTestDatabases,
  createWorkspace,
  seedWorkspaceChats,
  eventsOf,
} = require("../helpers/sqliteTestDatabase");
const { bootInProcess } = require("../helpers/engineCheckBoot");

const EVENT = "message_ledger_engine_check_failed";
const HOUR = 60 * 60 * 1000;

// Der erste Test jeder Datei erzeugt die Vorlage mit `prisma migrate deploy`.
jest.setTimeout(120000);

let db;
beforeEach(async () => {
  db = await createTestDatabase();
});
afterEach(async () => db.close());
afterAll(() => removeTestDatabases());

const tablesOf = async (client) =>
  (
    await client.$queryRawUnsafe(
      `SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`
    )
  ).map((row) => row.name);

describe("selbsttest (AK-19)", () => {
  test("selbsttest: mit wirksamer Thread-Einstellung besteht er ohne Ereignis - vor dem Lauschen, ohne merkliche Verzögerung und ohne Spuren", async () => {
    const workspace = await createWorkspace(db.client);
    await seedWorkspaceChats(db.client, [
      { workspaceId: workspace.id, createdAt: new Date(Date.now() - HOUR) },
    ]);
    const tablesBefore = await tablesOf(db.client);

    // Wie im Container: Der Betrieb setzt TOKIO_WORKER_THREADS nicht.
    const boot = bootInProcess(db);

    expect(boot.crashed).toBeUndefined();
    expect(boot.listening).toEqual({ port: 3999, threadsAtListen: null });
    expect(boot.check).toEqual({
      ok: true,
      reason: null,
      // von der Engine selbst genannt, beim Verbinden des Servers mitgelesen
      poolSize: expect.any(Number),
      engineThreads: boot.minimumThreads,
      minimumThreads: boot.minimumThreads,
      // auf jeder Verbindung eine Transaktion, dazu 3, die anstehen
      parallel: Math.min(boot.check.poolSize, 7) + 3,
      completed: boot.check.parallel,
      durationMs: expect.any(Number),
      timeLimitMs: 1500,
      error: null,
    });
    expect(boot.check.engineThreads).toBeGreaterThan(boot.check.poolSize);
    expect(boot.check.durationMs).toBeLessThan(1500);
    // Gemessen rund 0,1 s einschließlich Client, Datei und Aufräumen.
    expect(boot.checkMs).toBeLessThan(1500);
    expect(boot.errors).toEqual([]);
    // Die Zeitgrenze misst die Engine, nicht die Platte: Die parallelen
    // Transaktionen nehmen die Schreibsperre, ändern die Testdatei aber
    // nicht (kein Journal, kein fsync). Geändert hat sie allein das Anlegen
    // der Tabelle. Mit ändernden Transaktionen meldete der Selbsttest eine
    // langsame Platte als message_ledger_engine_check_failed.
    expect(boot.checkFileChanges).toBe(1);

    // Keine Spuren: nichts im temporären Verzeichnis, nichts im Storage,
    // die Datenbank des Servers unberührt - und der Nachtrag lief davor.
    expect(boot.temporaryEntries).toEqual([]);
    expect(boot.storageEntries).toEqual([]);
    expect(await tablesOf(db.client)).toEqual(tablesBefore);
    expect(await eventsOf(db.client, EVENT)).toEqual([]);
    expect(await db.client.event_logs.count()).toBe(0);
    expect(
      await db.client.message_ledger.aggregate({ _sum: { messages: true } })
    ).toEqual({ _sum: { messages: 1 } });
  });

  test("selbsttest: mehr Verbindungen als Arbeits-Threads - Konsolenfehler und Ereignis, der Server startet trotzdem", async () => {
    // Künstlich unwirksam: Die Datenbank-URL verlangt einen Pool, der um eins
    // über den Arbeits-Threads liegt.
    const boot = bootInProcess(db, { scenario: "pool_groesser" });

    expect(boot.crashed).toBeUndefined();
    expect(boot.listening).toEqual({ port: 3999, threadsAtListen: null });
    expect(boot.check).toEqual(
      expect.objectContaining({
        ok: false,
        reason: "threads_not_above_pool",
        poolSize: boot.minimumThreads + 1,
        engineThreads: boot.minimumThreads,
        // Die parallelen Transaktionen laufen dann nicht mehr: Sie würden die
        // Threads der Engine nur bis zum Busy-Timeout belegen.
        parallel: 0,
      })
    );
    expect(boot.errors).toHaveLength(1);
    expect(boot.errors[0]).toContain("Selbsttest der Query-Engine");
    expect(boot.errors[0]).toContain(
      `${boot.minimumThreads} Arbeits-Threads bei ${boot.minimumThreads + 1} Verbindungen`
    );

    const events = await eventsOf(db.client, EVENT);
    expect(events).toHaveLength(1);
    expect(events[0].metadata).toEqual({
      reason: "threads_not_above_pool",
      poolSize: boot.minimumThreads + 1,
      engineThreads: boot.minimumThreads,
      minimumThreads: boot.minimumThreads,
      parallel: 0,
      completed: 0,
      durationMs: 0,
      timeLimitMs: 1500,
      error: null,
    });
    expect(boot.temporaryEntries).toEqual([]);
    expect(boot.storageEntries).toEqual([]);
  });

  test("selbsttest: die Engine hat weniger Arbeits-Threads, als die Variable nennt - die parallelen Transaktionen bleiben stehen: Konsolenfehler und Ereignis, der Server startet trotzdem", async () => {
    // Künstlich unwirksam: Die Engine lädt mit 2 Threads (weniger als
    // Verbindungen), die Variable nennt danach wieder den Sollwert. Die
    // rechnerische Prüfung sieht nichts; die Transaktionen zeigen es.
    const boot = bootInProcess(db, { scenario: "variable_unwirksam" });

    expect(boot.crashed).toBeUndefined();
    expect(boot.listening).toEqual({ port: 3999, threadsAtListen: null });
    expect(boot.check).toEqual(
      expect.objectContaining({
        ok: false,
        reason: "transactions_timed_out",
        engineThreads: boot.minimumThreads,
        timeLimitMs: 1500,
      })
    );
    expect(boot.check.poolSize).toBeGreaterThan(2);
    expect(boot.check.parallel).toBe(Math.min(boot.check.poolSize, 7) + 3);
    expect(boot.check.completed).toBeLessThan(boot.check.parallel);
    expect(boot.check.durationMs).toBeGreaterThanOrEqual(1500);
    // Auch ohne eine geänderte Zeile bleiben die Transaktionen stehen: Die
    // wartenden Schreiber belegen die Threads der Engine.
    expect(boot.checkFileChanges).toBe(1);
    expect(boot.errors.join("\n")).toContain("Selbsttest der Query-Engine");

    const events = await eventsOf(db.client, EVENT);
    expect(events).toHaveLength(1);
    expect(events[0].metadata).toEqual(
      expect.objectContaining({
        reason: "transactions_timed_out",
        poolSize: boot.check.poolSize,
        engineThreads: boot.minimumThreads,
        parallel: boot.check.parallel,
        timeLimitMs: 1500,
      })
    );
    // Auch nach einem stehenden Lauf ist aufgeräumt.
    expect(boot.temporaryEntries).toEqual([]);
    expect(boot.storageEntries).toEqual([]);
    expect(await tablesOf(db.client)).not.toContain("engine_check");
  });

  test("selbsttest: lässt sich das temporäre Verzeichnis nicht beschreiben, startet der Server trotzdem - als nicht geprüft gemeldet", async () => {
    const missing = path.join(os.tmpdir(), `gibt-es-nicht-${process.pid}`);
    expect(fs.existsSync(missing)).toBe(false);

    const boot = bootInProcess(db, { temporaryDirectory: missing });

    expect(boot.crashed).toBeUndefined();
    expect(boot.listening).toEqual({ port: 3999, threadsAtListen: null });
    expect(boot.check).toEqual(
      expect.objectContaining({ ok: false, reason: "check_error" })
    );
    expect(boot.check.error).toMatch(/ENOENT/);
    expect(boot.errors.join("\n")).toContain("nicht ausführbar");
    expect(fs.existsSync(missing)).toBe(false);
    expect(boot.storageEntries).toEqual([]);

    const events = await eventsOf(db.client, EVENT);
    expect(events).toHaveLength(1);
    expect(events[0].metadata.reason).toBe("check_error");
  });
});

describe("selbsttest: rechnerische Prüfung im Jest-Prozess", () => {
  const saved = process.env.TOKIO_WORKER_THREADS;
  let errorSpy;
  let logSpy;
  let engineThreads;
  let engineCheck;
  beforeEach(() => {
    jest.resetModules();
    engineThreads = require("../../utils/prisma/engineThreads");
    engineCheck = require("../../utils/boot/messageLedgerEngineCheck");
    errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    errorSpy.mockRestore();
    logSpy.mockRestore();
    if (saved === undefined) delete process.env.TOKIO_WORKER_THREADS;
    else process.env.TOKIO_WORKER_THREADS = saved;
  });

  test.each([
    ["genauso viele Arbeits-Threads wie Verbindungen", 0],
    ["weniger Arbeits-Threads als Verbindungen", -3],
  ])(
    "selbsttest: %s gelten als nicht bestanden, ohne dass eine Transaktion läuft",
    async (_name, difference) => {
      delete process.env.TOKIO_WORKER_THREADS;
      engineThreads.ensureEngineThreads();
      const threads = engineThreads.minimumEngineThreads();
      engineThreads.notePoolSize(
        `Starting a sqlite pool with ${threads - difference} connections.`
      );
      engineThreads.releaseEngineThreads();

      const result = await engineCheck.runMessageLedgerEngineCheck();

      expect(result).toEqual(
        expect.objectContaining({
          ok: false,
          reason: "threads_not_above_pool",
          poolSize: threads - difference,
          engineThreads: threads,
          parallel: 0,
        })
      );
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(await eventsOf(db.client, EVENT)).toHaveLength(1);
    }
  );

  test("selbsttest: lässt sich auch das Ereignis nicht schreiben, wirft er trotzdem nicht", async () => {
    delete process.env.TOKIO_WORKER_THREADS;
    engineThreads.ensureEngineThreads();
    engineThreads.notePoolSize("Starting a sqlite pool with 999 connections.");
    engineThreads.releaseEngineThreads();
    await db.client.$executeRawUnsafe(`DROP TABLE event_logs`);

    const result = await engineCheck.runMessageLedgerEngineCheck();

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("threads_not_above_pool");
  });
});
