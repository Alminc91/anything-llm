/* eslint-env jest, node */
// KIE-532 (AK-18) — quota-snapshot --deleted-report gegen eine echte
// SQLite-Datei.
//
// quotaSnapshot.test.js prüft die Vorschlagsliste gegen einen Prisma-Ersatz im
// Speicher mit handgeschriebenen Ereignissen. Hier schreiben der Löschjob und
// "Chats löschen" ihre Ereignisse selbst in die Datenbank, und der Befehl
// liest sie mit --db aus der Datei - ohne eine Tabelle zu ändern.
jest.mock(
  "../../utils/prisma",
  () => require("../helpers/sqliteTestDatabase").testPrisma
);
jest.mock("../../models/telemetry", () => ({
  Telemetry: { sendTelemetry: jest.fn(), flush: jest.fn() },
}));

const {
  createTestDatabase,
  removeTestDatabases,
  createWorkspace,
  createEmbed,
  seedEmbedChats,
  berlinCell,
  eventsOf,
  tableChecksum,
  collectRoutes,
  mockRequest,
  mockResponse,
} = require("../helpers/sqliteTestDatabase");
const { MessageLedger } = require("../../models/messageLedger");
const {
  runMessageLedgerBackfill,
} = require("../../utils/boot/messageLedgerBackfill");
const { getBillingWindow } = require("../../utils/helpers/billingWindow");
const quotaSnapshot = require("../../scripts/quota-snapshot");

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// Der erste Test jeder Datei erzeugt die Vorlage mit `prisma migrate deploy`.
jest.setTimeout(60000);

let db;
beforeEach(async () => {
  MessageLedger._resetCache();
  db = await createTestDatabase();
  jest.spyOn(console, "error").mockImplementation(() => {});
  jest.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(async () => {
  jest.restoreAllMocks();
  await db.close();
});
afterAll(() => removeTestDatabases());

/** Lässt den Löschjob so laufen, wie ihn der Hintergrunddienst startet. */
function runCleanupJob() {
  return new Promise((resolve) => {
    jest.isolateModules(() => {
      jest.doMock("../../jobs/helpers/index.js", () => ({
        log: () => {},
        conclude: resolve,
      }));
      require("../../jobs/cleanup-old-embed-chats.js");
    });
  });
}

async function runCli(argv) {
  let stdout = "";
  let stderr = "";
  const status = await quotaSnapshot.main(argv, {
    stdout: { write: (text) => (stdout += text) },
    stderr: { write: (text) => (stderr += text) },
  });
  return { status, stdout, stderr };
}

async function checksums() {
  const tables = await db.client.$queryRaw`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`;
  const sums = {};
  for (const { name } of tables)
    sums[name] = await tableChecksum(db.client, name);
  return sums;
}

const formatDayDE = (day) => day.split("-").reverse().join(".");

describe("quota-snapshot --deleted-report gegen die Datenbank (KIE-532, AK-18)", () => {
  test("loeschmengen_vorschlag: liest die Ereignisse des Löschjobs und von „Chats löschen“ aus der SQLite-Datei, listet sie je Workspace und ändert keine Tabelle", async () => {
    const {
      embedManagementEndpoints,
    } = require("../../endpoints/embedManagement");
    const routes = collectRoutes(embedManagementEndpoints);

    // Laufender Zyklus seit 20 Tagen: Die Löschungen liegen an jedem
    // Kalendertag im laufenden Fenster.
    const workspace = await createWorkspace(db.client, {
      messagesLimit: 600,
      cycleStartDate: new Date(Date.now() - 20 * DAY),
      cycleDurationMonths: 1,
    });
    const quietWorkspace = await createWorkspace(db.client);
    const retained = await createEmbed(db.client, workspace, {
      chat_retention_days: 1,
      retention_started_at: new Date(Date.now() - 5 * DAY),
    });
    const cleared = await createEmbed(db.client, workspace);
    const untouched = await createEmbed(db.client, quietWorkspace);
    await seedEmbedChats(db.client, [
      // älter als die Frist: löscht der Löschjob
      ...Array.from({ length: 12 }, (_, i) => ({
        embed_id: retained.id,
        createdAt: new Date(Date.now() - 2 * DAY - i * HOUR),
      })),
      // innerhalb der Frist: bleiben
      ...Array.from({ length: 3 }, (_, i) => ({
        embed_id: retained.id,
        createdAt: new Date(Date.now() - (i + 1) * HOUR),
      })),
      ...Array.from({ length: 5 }, (_, i) => ({
        embed_id: cleared.id,
        createdAt: new Date(Date.now() - 3 * DAY - i * HOUR),
      })),
      ...Array.from({ length: 4 }, (_, i) => ({
        embed_id: untouched.id,
        createdAt: new Date(Date.now() - 3 * DAY - i * HOUR),
      })),
    ]);
    expect((await runMessageLedgerBackfill({ log: () => {} })).ok).toBe(true);

    // Der Löschjob und "Chats löschen" schreiben ihre Ereignisse selbst.
    await runCleanupJob();
    const response = mockResponse({});
    await routes["DELETE /embed-chats/clear/:embedId"](
      mockRequest({ params: { embedId: String(cleared.id) } }),
      response
    );
    expect(response.body).toEqual({ success: true, deletedCount: 5 });
    expect(await db.client.embed_chats.count()).toBe(3 + 4);
    const [autoDeleted] = await eventsOf(db.client, "embed_chats_auto_deleted");
    const [clearedEvent] = await eventsOf(db.client, "embed_chats_cleared");
    expect(autoDeleted.metadata).toEqual(
      expect.objectContaining({ embedId: retained.id, deletedCount: 12 })
    );
    expect(clearedEvent.metadata).toEqual({
      embedId: cleared.id,
      deletedCount: 5,
    });

    const before = await checksums();
    expect(before.event_logs.rows).toBe(2);
    expect(before.message_ledger.rows).toBeGreaterThan(10);

    const json = await runCli(["--deleted-report", "--db", db.file, "--json"]);
    expect(json.stderr).toBe("");
    expect(json.status).toBe(0);
    const report = JSON.parse(json.stdout);
    const window = getBillingWindow(
      await db.client.workspaces.findUnique({ where: { id: workspace.id } })
    );
    // Nur der Workspace mit Löschungen, mit beiden Mengen und ihrem Datum.
    expect(report.unassigned).toEqual([]);
    expect(report.workspaces).toEqual([
      {
        id: workspace.id,
        slug: workspace.slug,
        name: workspace.name,
        messagesLimit: 600,
        window: {
          startDay: window.startDay,
          endDayExclusive: window.endDayExclusive,
        },
        deletedTotal: 17,
        suggestedMax: 17,
        entries: [
          {
            event: "embed_chats_auto_deleted",
            embedId: retained.id,
            occurredAt: autoDeleted.occurredAt.toISOString(),
            day: berlinCell(autoDeleted.occurredAt).day,
            deletedCount: 12,
            cutoffDate: autoDeleted.metadata.cutoffDate,
            suggestedMax: 12,
          },
          {
            event: "embed_chats_cleared",
            embedId: cleared.id,
            occurredAt: clearedEvent.occurredAt.toISOString(),
            day: berlinCell(clearedEvent.occurredAt).day,
            deletedCount: 5,
            cutoffDate: null,
            suggestedMax: 5,
          },
        ],
      },
    ]);

    const text = await runCli(["--deleted-report", "--db", db.file]);
    expect(text.status).toBe(0);
    expect(text.stdout).toContain("es wird nichts gebucht");
    expect(text.stdout).toContain(
      `[${workspace.id}] ${workspace.slug} – Fenster ab ${formatDayDE(window.startDay)}: gelöscht 17, Vorschlag höchstens 17`
    );
    expect(text.stdout).toContain(
      `Löschjob, Widget ${retained.id}: 12 Nachrichten`
    );
    expect(text.stdout).toContain(
      `Chats löschen, Widget ${cleared.id}: 5 Nachrichten`
    );
    expect(text.stdout).not.toContain(quietWorkspace.slug);

    // Vor dem Bezugszeitpunkt der Löschungen gibt es nichts vorzuschlagen.
    const earlier = await runCli([
      "--deleted-report",
      "--db",
      db.file,
      "--json",
      "--now",
      new Date(autoDeleted.occurredAt.getTime() - 1).toISOString(),
    ]);
    expect(JSON.parse(earlier.stdout).workspaces).toEqual([]);

    // Es wurde nur gelesen: Keine Tabelle hat sich geändert - keine Buchung,
    // kein Zähler, kein Ereignis.
    expect(await checksums()).toEqual(before);
    expect(await db.client.workspace_message_adjustments.count()).toBe(0);
  });
});
