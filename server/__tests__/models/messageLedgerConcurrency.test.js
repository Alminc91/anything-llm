/* eslint-env jest, node */
// KIE-532 — Chat-Zeile und Zähler entstehen in einer interaktiven Transaktion.
// Unter parallelen Anfragen darf das weder Nachrichten kosten noch andere
// Schreibzugriffe scheitern lassen.
//
// Hintergrund: Die Query-Engine führt SQLite-Aufrufe blockierend auf ihren
// Arbeits-Threads aus. Warten so viele Schreiber auf die Sperre einer offenen
// Transaktion, wie es Threads gibt, kommt die Transaktion selbst nicht mehr an
// die Reihe - Stillstand bis zum Busy-Timeout (5 s), danach schlagen
// Schreibzugriffe fehl. Dagegen stehen zwei Vorkehrungen, die dieser Test
// absichert: utils/prisma/engineThreads.js (mehr Threads als Verbindungen) und
// die Reihe in MessageLedger.transaction (eine Transaktion zur Zeit).
//
// Die parallelen Anfragen laufen in einem gewöhnlichen Node-Prozess
// (helpers/concurrentRequests.js) gegen eine echte SQLite-Datei: Jest gibt
// Tests nur eine Kopie von process.env, die die Engine nicht erreicht.
jest.mock(
  "../../utils/prisma",
  () => require("../helpers/sqliteTestDatabase").testPrisma
);

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const {
  createTestDatabase,
  removeTestDatabases,
  createWorkspace,
  createEmbed,
  eventsOf,
} = require("../helpers/sqliteTestDatabase");
const { ensureEngineThreads } = require("../../utils/prisma/engineThreads");

// Der erste Test jeder Datei erzeugt die Vorlage mit `prisma migrate deploy`.
jest.setTimeout(60000);

let db;
beforeEach(async () => {
  db = await createTestDatabase();
});
afterEach(async () => db.close());
afterAll(() => removeTestDatabases());

describe("parallele Anfragen", () => {
  test("jede Nachricht wird gespeichert und genau einmal gezählt, kein anderer Schreibzugriff scheitert", async () => {
    const workspace = await createWorkspace(db.client);
    const embed = await createEmbed(db.client, workspace);
    const REQUESTS = 60;

    // Wie im Container: Der Betrieb setzt TOKIO_WORKER_THREADS nicht.
    const env = { ...process.env };
    delete env.TOKIO_WORKER_THREADS;
    const output = execFileSync(
      process.execPath,
      [
        path.resolve(__dirname, "../helpers/concurrentRequests.js"),
        db.file,
        String(workspace.id),
        String(embed.id),
        String(REQUESTS),
      ],
      { env, encoding: "utf8", timeout: 100000 }
    );
    const result = JSON.parse(output.trim().split("\n").pop());

    expect(result.crashed).toBeUndefined();
    expect(result.errors).toEqual([]);
    expect(Number(result.engineThreads)).toBeGreaterThan(
      2 * os.cpus().length + 1
    );
    expect(result.failedSaves).toBe(0);
    expect(result.failedEvents).toBe(0);
    expect(result.ratings).toEqual(Array(10).fill(true));
    expect(result.newChats).toEqual(Array(10).fill(null));
    expect(result.copies).toBeNull();
    // Ohne die Vorkehrungen steht der Lauf mindestens ein Busy-Timeout (5 s) still.
    expect(result.durationMs).toBeLessThan(5000);

    // 60 parallele Anfragen, danach 10 weitere Nachrichten und 10 Kopien
    expect(await db.client.workspace_chats.count()).toBe(REQUESTS / 2 + 20);
    expect(await db.client.embed_chats.count()).toBe(REQUESTS / 2);
    expect(
      await db.client.event_logs.count({ where: { event: "sent_chat" } })
    ).toBe(REQUESTS);
    expect(await eventsOf(db.client, "message_ledger_write_failed")).toEqual(
      []
    );

    const sum = await db.client.message_ledger.aggregate({
      _sum: {
        messages: true,
        copied: true,
        conversations_started: true,
        feedback_positive: true,
        feedback_negative: true,
      },
    });
    expect(sum._sum).toEqual({
      messages: REQUESTS + 10,
      copied: 10,
      // 5 Konversationen, jede genau einmal begonnen - auch wenn ihre ersten
      // Nachrichten gleichzeitig eintreffen.
      conversations_started: 5,
      feedback_positive: 5,
      feedback_negative: 5,
    });
  }, 120000);
});

describe("ensureEngineThreads", () => {
  const saved = process.env.TOKIO_WORKER_THREADS;
  afterEach(() => {
    if (saved === undefined) delete process.env.TOKIO_WORKER_THREADS;
    else process.env.TOKIO_WORKER_THREADS = saved;
  });

  test("setzt mehr Arbeits-Threads, als die Engine Verbindungen hält (2 × CPUs + 1)", () => {
    delete process.env.TOKIO_WORKER_THREADS;
    ensureEngineThreads();
    expect(Number(process.env.TOKIO_WORKER_THREADS)).toBeGreaterThan(
      2 * os.cpus().length + 1
    );
  });

  test("ein vom Betrieb gesetzter Wert bleibt erhalten", () => {
    process.env.TOKIO_WORKER_THREADS = "3";
    ensureEngineThreads();
    expect(process.env.TOKIO_WORKER_THREADS).toBe("3");
  });

  test("utils/prisma setzt den Wert, bevor der Client entsteht", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "../../utils/prisma/index.js"),
      "utf8"
    );
    expect(source.indexOf("ensureEngineThreads()")).toBeGreaterThan(-1);
    expect(source.indexOf("ensureEngineThreads()")).toBeLessThan(
      source.indexOf('require("@prisma/client")')
    );
  });
});
