/* eslint-env jest, node */
// KIE-532 — Nachtrag des Zählerbuchs: exakt, wiederholbar, fortsetzbar, ohne
// Doppelzählung, ohne Änderung am Bestand - und der Kontingentstand jedes
// Workspaces ist danach derselbe wie davor.
//
// Alle Prüfungen laufen gegen eine echte SQLite-Datei aus den Migrationen
// (helpers/sqliteTestDatabase.js). Die Zeitzone des Prozesses wird nicht
// gesetzt.
jest.mock(
  "../../utils/prisma",
  () => require("../helpers/sqliteTestDatabase").testPrisma
);
// Für den Startpfad (bootHTTP): alles, was erst nach dem Lauschen geschieht.
jest.mock("../../models/telemetry", () => ({
  Telemetry: { flush: jest.fn(), sendTelemetry: jest.fn() },
}));
jest.mock("../../utils/BackgroundWorkers", () => ({
  BackgroundService: jest.fn(() => ({ boot: jest.fn() })),
}));
jest.mock("../../utils/EncryptionManager", () => ({
  EncryptionManager: jest.fn(),
}));
jest.mock("../../utils/comKey", () => ({ CommunicationKey: jest.fn() }));
jest.mock("../../utils/telemetry", () => jest.fn());
jest.mock("../../utils/boot/eagerLoadContextWindows", () => jest.fn());
jest.mock("../../utils/boot/markOnboarded", () => jest.fn());
jest.mock("../../utils/PushNotifications", () => ({
  PushNotifications: { setupPushNotificationService: jest.fn() },
}));

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  createTestDatabase,
  removeTestDatabases,
  createWorkspace,
  createEmbed,
  seedEmbedChats,
  seedWorkspaceChats,
  ledgerRows,
  berlinCell,
  eventsOf,
} = require("../helpers/sqliteTestDatabase");
const { MessageLedger } = require("../../models/messageLedger");
const { WorkspaceChats } = require("../../models/workspaceChats");
const { EmbedChats } = require("../../models/embedChats");
const {
  runMessageLedgerBackfill,
} = require("../../utils/boot/messageLedgerBackfill");
const { getMessageLimitInfo } = require("../../utils/helpers");
const quotaSnapshot = require("../../scripts/quota-snapshot");
const {
  resyncLedger,
  main: resyncMain,
} = require("../../scripts/ledger-resync");

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const quiet = { log: () => {} };

// Der erste Test jeder Datei erzeugt die Vorlage mit `prisma migrate deploy`.
jest.setTimeout(60000);

let db;
let errorSpy;
let logSpy;
beforeEach(async () => {
  MessageLedger._resetCache();
  db = await createTestDatabase();
  errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(async () => {
  jest.restoreAllMocks();
  await db.close();
});
afterAll(() => removeTestDatabases());

// ---------------------------------------------------------------------------
// Bestand: Chat-Zeilen aus 40 Tagen in zwei Workspaces und drei Widgets
// ---------------------------------------------------------------------------

/** Fester Zufallsgenerator: Die Daten sind in jedem Lauf dieselben. */
function random(seed) {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 40 Tage ab dem 10.03.2026 - die Umstellung auf Sommerzeit am 29.03. liegt
 * darin. Die Zeilen werden nicht in zeitlicher Reihenfolge angelegt.
 */
async function seedFortyDays(client) {
  const next = random(532);
  const first = await createWorkspace(client);
  const second = await createWorkspace(client);
  const embeds = [
    await createEmbed(client, first),
    await createEmbed(client, first),
    await createEmbed(client, second),
  ];
  const start = new Date("2026-03-10T00:00:00+01:00").getTime();
  const instant = () => new Date(start + Math.floor(next() * 40 * DAY));

  const workspaceChats = Array.from({ length: 260 }, () => ({
    workspaceId: next() < 0.6 ? first.id : second.id,
    createdAt: instant(),
    include: next() < 0.9,
  }));
  const embedChats = Array.from({ length: 420 }, () => {
    const embed = embeds[Math.floor(next() * embeds.length)];
    const session = `sitzung-${Math.floor(next() * 60)}`;
    const feedback = next();
    return {
      embed_id: embed.id,
      createdAt: instant(),
      session_id: session,
      // Alt-Zeilen ohne conversation_id, sonst ein bis zwei Konversationen je Sitzung
      conversation_id:
        next() < 0.25 ? null : `${session}-k${Math.floor(next() * 2)}`,
      feedbackScore: feedback < 0.1 ? true : feedback < 0.15 ? false : null,
    };
  });
  await seedWorkspaceChats(client, workspaceChats);
  await seedEmbedChats(client, embedChats);
  return { first, second, embeds };
}

/**
 * Was im Zählerbuch stehen muss, unabhängig vom geprüften Code aus den
 * vorhandenen Zeilen bestimmt.
 */
async function expectedLedger(client) {
  const cells = new Map();
  const cell = (workspaceId, embedId, instant) => {
    const { day, hour } = berlinCell(instant);
    const key = `${workspaceId}|${embedId}|${day}|${hour}`;
    if (!cells.has(key))
      cells.set(key, {
        workspace_id: workspaceId,
        embed_id: embedId,
        day,
        hour,
        messages: 0,
        copied: 0,
        conversations_started: 0,
        feedback_positive: 0,
        feedback_negative: 0,
      });
    return cells.get(key);
  };

  for (const chat of await client.workspace_chats.findMany())
    cell(chat.workspaceId, 0, chat.createdAt).messages += 1;

  const embeds = new Map(
    (await client.embed_configs.findMany()).map((embed) => [
      embed.id,
      embed.workspace_id,
    ])
  );
  const seenConversations = new Set();
  for (const chat of await client.embed_chats.findMany({
    orderBy: { id: "asc" },
  })) {
    const target = cell(
      embeds.get(chat.embed_id),
      chat.embed_id,
      chat.createdAt
    );
    target.messages += 1;
    if (chat.feedbackScore === true) target.feedback_positive += 1;
    if (chat.feedbackScore === false) target.feedback_negative += 1;
    const conversation = `${chat.embed_id}|${chat.conversation_id ?? chat.session_id}`;
    if (!seenConversations.has(conversation)) {
      seenConversations.add(conversation);
      target.conversations_started += 1;
    }
  }

  const order = (a, b) =>
    a.workspace_id - b.workspace_id ||
    a.embed_id - b.embed_id ||
    a.day.localeCompare(b.day) ||
    a.hour - b.hour;
  return [...cells.values()].sort(order);
}

/** Summe messages je Workspace, Widget und Tag. */
function perDay(rows) {
  const days = {};
  for (const row of rows) {
    const key = `${row.workspace_id}|${row.embed_id}|${row.day}`;
    days[key] = (days[key] ?? 0) + row.messages;
  }
  return days;
}

/** Zeilenzahl je Workspace, Widget und Berliner Tag, direkt aus den Chat-Tabellen. */
async function rowsPerDay(client) {
  const days = {};
  const add = (workspaceId, embedId, instant) => {
    const key = `${workspaceId}|${embedId}|${berlinCell(instant).day}`;
    days[key] = (days[key] ?? 0) + 1;
  };
  for (const chat of await client.workspace_chats.findMany())
    add(chat.workspaceId, 0, chat.createdAt);
  for (const chat of await client.embed_chats.findMany({
    include: { embed_config: true },
  }))
    add(chat.embed_config.workspace_id, chat.embed_id, chat.createdAt);
  return days;
}

describe("exakt_idempotent_fortsetzbar (AK-8)", () => {
  test("exakt_idempotent_fortsetzbar: ein Lauf, ein zweiter Lauf und ein nach dem zweiten Paket abgebrochener Lauf führen auf dieselben exakten Zähler", async () => {
    await seedFortyDays(db.client);
    const expected = await expectedLedger(db.client);
    expect(new Set(expected.map((row) => row.day)).size).toBeGreaterThanOrEqual(
      40
    );
    expect(new Set(expected.map((row) => row.workspace_id)).size).toBe(2);
    expect(new Set(expected.map((row) => row.embed_id)).size).toBe(4); // 0 + drei Widgets

    // 1. Lauf, in Paketen. Die Markierung ist erst mit dem letzten Paket
    // "complete" - und erst dann liest das Kontingent das Zählerbuch.
    const states = [];
    const first = await runMessageLedgerBackfill({
      ...quiet,
      batchSize: 37,
      afterBatch: async ({ state }) => {
        states.push(state.state);
        MessageLedger._resetCache();
        expect(await MessageLedger.isBackfillComplete()).toBe(
          state.state === "complete"
        );
      },
    });
    expect(first.ok).toBe(true);
    expect(first.rows).toBe(680);
    expect(states.length).toBeGreaterThan(18);
    expect(states.slice(0, -1).every((state) => state === "running")).toBe(
      true
    );
    expect(states[states.length - 1]).toBe("complete");

    const afterFirst = await ledgerRows(db.client);
    expect(afterFirst).toEqual(expected);
    // Summe messages je Workspace, Widget und Tag = Zeilenzahl
    expect(perDay(afterFirst)).toEqual(await rowsPerDay(db.client));

    const marker = await MessageLedger.backfillState();
    expect(marker).toEqual(
      expect.objectContaining({
        state: "complete",
        completedAt: expect.any(String),
        error: null,
      })
    );
    expect(marker.tables.workspace_chats).toEqual(
      expect.objectContaining({
        maxId: 260,
        lastId: 260,
        done: true,
        rows: 260,
      })
    );
    expect(marker.tables.embed_chats).toEqual(
      expect.objectContaining({
        maxId: 420,
        lastId: 420,
        done: true,
        rows: 420,
      })
    );

    // 2. Lauf: ändert nichts.
    const second = await runMessageLedgerBackfill({ ...quiet, batchSize: 37 });
    expect(second).toEqual(
      expect.objectContaining({ ok: true, alreadyComplete: true, rows: 0 })
    );
    expect(await ledgerRows(db.client)).toEqual(expected);
    expect((await MessageLedger.backfillState()).completedAt).toBe(
      marker.completedAt
    );

    // 3. Durchgang auf einer frischen Datenbank mit denselben Daten: Abbruch
    // nach dem zweiten Paket, dann Neustart.
    await db.close();
    db = await createTestDatabase();
    MessageLedger._resetCache();
    await seedFortyDays(db.client);

    let batches = 0;
    const aborted = await runMessageLedgerBackfill({
      ...quiet,
      batchSize: 37,
      afterBatch: () => {
        if (++batches === 2) throw new Error("Abbruch nach dem zweiten Paket");
      },
    });
    expect(aborted.ok).toBe(false);
    expect(batches).toBe(2);
    let interrupted = await MessageLedger.backfillState();
    expect(interrupted.state).toBe("failed");
    expect(interrupted.completedAt).toBeNull();
    expect(interrupted.tables.workspace_chats).toEqual(
      expect.objectContaining({ lastId: 74, done: false, rows: 74 })
    );
    expect(await MessageLedger.isBackfillComplete()).toBe(false);
    // Genau zwei Pakete stehen im Zählerbuch.
    const partial = await ledgerRows(db.client);
    expect(partial.reduce((sum, row) => sum + row.messages, 0)).toBe(74);

    // Ein hart beendeter Prozess hinterlässt "running" statt "failed".
    interrupted.state = "running";
    interrupted.error = null;
    await db.client.system_settings.update({
      where: { label: "message_ledger_backfill" },
      data: { value: JSON.stringify(interrupted) },
    });

    const resumed = await runMessageLedgerBackfill({ ...quiet, batchSize: 37 });
    expect(resumed.ok).toBe(true);
    expect(resumed.rows).toBe(680 - 74);
    expect(await ledgerRows(db.client)).toEqual(expected);
    expect(perDay(await ledgerRows(db.client))).toEqual(
      await rowsPerDay(db.client)
    );
    expect((await MessageLedger.backfillState()).state).toBe("complete");
  }, 60000);

  test("exakt_idempotent_fortsetzbar: jede Paketgröße führt auf dasselbe Ergebnis, auch wenn die letzte Zeile genau ein Paket füllt", async () => {
    const workspace = await createWorkspace(db.client);
    const embed = await createEmbed(db.client, workspace);
    await seedWorkspaceChats(
      db.client,
      Array.from({ length: 12 }, (_, i) => ({
        workspaceId: workspace.id,
        createdAt: new Date(
          Date.parse("2026-06-01T08:00:00+02:00") + i * 20 * 60000
        ),
      }))
    );
    await seedEmbedChats(
      db.client,
      Array.from({ length: 6 }, (_, i) => ({
        embed_id: embed.id,
        createdAt: new Date(
          Date.parse("2026-06-01T08:00:00+02:00") + i * 50 * 60000
        ),
        session_id: `s${i % 2}`,
      }))
    );
    const expected = await expectedLedger(db.client);

    // 12 und 6 Zeilen in Paketen zu 6: Jede Tabelle endet auf einer Paketgrenze.
    expect(
      (await runMessageLedgerBackfill({ ...quiet, batchSize: 6 })).ok
    ).toBe(true);
    expect(await ledgerRows(db.client)).toEqual(expected);

    for (const batchSize of [1, 5, 1000]) {
      await db.close();
      db = await createTestDatabase();
      MessageLedger._resetCache();
      const again = await createWorkspace(db.client);
      const againEmbed = await createEmbed(db.client, again);
      await seedWorkspaceChats(
        db.client,
        Array.from({ length: 12 }, (_, i) => ({
          workspaceId: again.id,
          createdAt: new Date(
            Date.parse("2026-06-01T08:00:00+02:00") + i * 20 * 60000
          ),
        }))
      );
      await seedEmbedChats(
        db.client,
        Array.from({ length: 6 }, (_, i) => ({
          embed_id: againEmbed.id,
          createdAt: new Date(
            Date.parse("2026-06-01T08:00:00+02:00") + i * 50 * 60000
          ),
          session_id: `s${i % 2}`,
        }))
      );
      expect((await runMessageLedgerBackfill({ ...quiet, batchSize })).ok).toBe(
        true
      );
      expect(await ledgerRows(db.client)).toEqual(expected);
    }
  }, 60000);

  test("exakt_idempotent_fortsetzbar: leere Datenbank - der Nachtrag ist sofort abgeschlossen", async () => {
    const result = await runMessageLedgerBackfill(quiet);
    expect(result).toEqual(
      expect.objectContaining({ ok: true, alreadyComplete: false, rows: 0 })
    );
    expect(await MessageLedger.isBackfillComplete()).toBe(true);
    expect(await db.client.message_ledger.count()).toBe(0);
  });

  test("exakt_idempotent_fortsetzbar: Zeilen, die auch die Live-Zählung keinem Workspace zurechnet, werden nicht nachgetragen und in der Markierung gezählt", async () => {
    const workspace = await createWorkspace(db.client);
    await seedWorkspaceChats(db.client, [
      {
        workspaceId: workspace.id,
        createdAt: new Date("2026-06-01T08:00:00Z"),
      },
      // Workspace gibt es nicht (mehr)
      { workspaceId: 4711, createdAt: new Date("2026-06-01T09:00:00Z") },
    ]);
    // createdAt als Text statt als Zahl (an Prisma vorbei eingefügt)
    await db.client.$executeRaw`
      INSERT INTO workspace_chats (workspaceId, prompt, response, createdAt)
      VALUES (${workspace.id}, 'x', '{}', '2026-06-01 10:00:00')`;

    // Die Live-Zählung sieht im Juni genau eine Zeile dieses Workspaces.
    const june = [
      new Date("2026-05-31T22:00:00Z"),
      new Date("2026-06-30T22:00:00Z"),
    ];
    expect(
      await WorkspaceChats.count({
        workspaceId: workspace.id,
        createdAt: { gte: june[0], lt: june[1] },
      })
    ).toBe(1);

    const result = await runMessageLedgerBackfill(quiet);
    expect(result.ok).toBe(true);
    expect(result.state.tables.workspace_chats).toEqual(
      expect.objectContaining({
        rows: 1,
        skippedOrphaned: 1,
        skippedWithoutTime: 1,
        lastId: 3,
        done: true,
      })
    );
    expect(await ledgerRows(db.client)).toEqual([
      expect.objectContaining({
        workspace_id: workspace.id,
        day: "2026-06-01",
        hour: 10,
        messages: 1,
      }),
    ]);
  });
});

describe("wasserstand (AK-9)", () => {
  async function expectEveryMessageOnce() {
    expect(await ledgerRows(db.client)).toEqual(
      await expectedLedger(db.client)
    );
    const total = await db.client.message_ledger.aggregate({
      _sum: { messages: true },
    });
    expect(total._sum.messages).toBe(
      (await db.client.workspace_chats.count()) +
        (await db.client.embed_chats.count())
    );
  }

  test("wasserstand: Nachrichten, die während des Nachtrags entstehen, stehen genau einmal im Zählerbuch", async () => {
    const { first, embeds } = await seedFortyDays(db.client);

    let written = 0;
    const result = await runMessageLedgerBackfill({
      ...quiet,
      batchSize: 50,
      afterBatch: async ({ state }) => {
        if (state.state === "complete") return;
        // laufender Betrieb zwischen zwei Paketen
        const chat = await WorkspaceChats.new({
          workspaceId: first.id,
          prompt: "neu",
        });
        const widget = await EmbedChats.new({
          embedId: embeds[0].id,
          prompt: "neu",
          sessionId: "sitzung-neu",
          conversationId: "konversation-neu",
        });
        expect(chat.message).toBeNull();
        expect(widget.message).toBeNull();
        // Sie liegen über dem Wasserstand und gehören nicht dem Nachtrag.
        expect(chat.chat.id).toBeGreaterThan(
          state.tables.workspace_chats.maxId
        );
        expect(widget.chat.id).toBeGreaterThan(state.tables.embed_chats.maxId);
        written += 2;
      },
    });

    expect(result.ok).toBe(true);
    expect(written).toBeGreaterThan(20);
    // Der Nachtrag hat nur die Zeilen bis zum Wasserstand verarbeitet.
    expect(result.rows).toBe(680);
    expect(result.state.tables.workspace_chats.maxId).toBe(260);
    expect(result.state.tables.embed_chats.maxId).toBe(420);
    expect(await db.client.workspace_chats.count()).toBe(260 + written / 2);
    await expectEveryMessageOnce();
  }, 60000);

  test("wasserstand: die erste Nachricht des neuen Images hält den Wasserstand selbst fest, falls der Nachtrag beim Start nicht dazu kam", async () => {
    const { first, embeds } = await seedFortyDays(db.client);
    expect(await MessageLedger.backfillState()).toBeNull();

    // Der Server läuft, ohne dass der Nachtrag begonnen hat.
    await WorkspaceChats.new({ workspaceId: first.id, prompt: "neu" });
    await EmbedChats.new({
      embedId: embeds[1].id,
      prompt: "neu",
      sessionId: "s",
    });
    const marker = await MessageLedger.backfillState();
    expect(marker.state).toBe("pending");
    // Wasserstand = höchster Zeilenschlüssel vor der ersten gezählten Nachricht
    expect(marker.tables.workspace_chats.maxId).toBe(260);
    expect(marker.tables.embed_chats.maxId).toBe(420);
    expect(await MessageLedger.isBackfillComplete()).toBe(false);

    // Der spätere Nachtrag bucht die beiden neuen Zeilen nicht noch einmal.
    const result = await runMessageLedgerBackfill({ ...quiet, batchSize: 100 });
    expect(result.ok).toBe(true);
    expect(result.rows).toBe(680);
    await expectEveryMessageOnce();
  }, 60000);

  test("wasserstand: zwei gleichzeitig gestartete Läufe buchen kein Paket doppelt", async () => {
    await seedFortyDays(db.client);
    const [a, b] = await Promise.all([
      runMessageLedgerBackfill({ ...quiet, batchSize: 40 }),
      runMessageLedgerBackfill({ ...quiet, batchSize: 40 }),
    ]);
    expect(a.ok && b.ok).toBe(true);
    expect(a.rows + b.rows).toBe(680);
    await expectEveryMessageOnce();
  }, 60000);
});

// ---------------------------------------------------------------------------
// Umstellung: Stand vor der Migration gegen Stand nach Migration und Nachtrag
// ---------------------------------------------------------------------------

const ROLLOUT_NOW = "2026-10-12T08:00:00.000Z";

/** Datenbank auf dem Stand von KIE-531 mit laufenden Kontingenten. */
async function seedRunningQuotas(client) {
  const at = (iso) => new Date(iso);
  const spread = (fromIso, toIso, count) => {
    const from = Date.parse(fromIso);
    const to = Date.parse(toIso);
    return Array.from(
      { length: count },
      (_, i) => new Date(from + Math.round(((to - from) * i) / (count - 1)))
    );
  };

  // 1: Kalendermonat, Limit 600, Widget, Buchungen
  const monthly = await createWorkspace(client, { messagesLimit: 600 });
  const monthlyEmbed = await createEmbed(client, monthly);
  // 2: Zyklus 3 Monate ab 15.07., Limit erreicht
  const quarterly = await createWorkspace(client, {
    messagesLimit: 120,
    cycleStartDate: at("2026-07-15"),
    cycleDurationMonths: 3,
  });
  const quarterlyEmbed = await createEmbed(client, quarterly);
  // 3: Start am 31. (geklemmter Reset-Tag), 1 Monat
  const clamped = await createWorkspace(client, {
    messagesLimit: 50,
    cycleStartDate: at("2026-01-31"),
    cycleDurationMonths: 1,
  });
  // 4: ohne Chats, ohne Limit
  await createWorkspace(client);
  // 5: Gutschriften über dem Verbrauch
  const credited = await createWorkspace(client, { messagesLimit: 10 });
  // 6: Zyklusstart in der Zukunft - bis dahin gilt der Kalendermonat
  const future = await createWorkspace(client, {
    messagesLimit: 30,
    cycleStartDate: at("2026-11-01"),
    cycleDurationMonths: 6,
  });
  // 7: Widget, das vor der Umstellung von monthly hierher umgehängt wurde
  const adopter = await createWorkspace(client, { messagesLimit: 40 });
  const movedEmbed = await createEmbed(client, monthly);

  await seedWorkspaceChats(client, [
    // monthly: letzter Augenblick des Septembers, erster des Oktobers, Oktober
    { workspaceId: monthly.id, createdAt: at("2026-09-30T23:59:59.999+02:00") },
    { workspaceId: monthly.id, createdAt: at("2026-10-01T00:00:00.000+02:00") },
    ...spread(
      "2026-10-01T06:00:00+02:00",
      "2026-10-12T09:59:00+02:00",
      180
    ).map((createdAt, i) => ({
      workspaceId: monthly.id,
      createdAt,
      include: i % 7 !== 0,
    })),
    // quarterly: vor dem Zyklus und im Zyklus (auch am ersten Tag um 00:00 Uhr)
    ...spread("2026-06-01T10:00:00+02:00", "2026-07-14T23:59:59+02:00", 40).map(
      (createdAt) => ({ workspaceId: quarterly.id, createdAt })
    ),
    { workspaceId: quarterly.id, createdAt: at("2026-07-15T00:00:00+02:00") },
    ...spread("2026-07-15T08:00:00+02:00", "2026-10-11T22:00:00+02:00", 70).map(
      (createdAt) => ({ workspaceId: quarterly.id, createdAt })
    ),
    // clamped: Fenster 30.09. bis 31.10.
    ...spread("2026-09-28T12:00:00+02:00", "2026-10-10T12:00:00+02:00", 26).map(
      (createdAt) => ({ workspaceId: clamped.id, createdAt })
    ),
    ...spread("2026-10-03T12:00:00+02:00", "2026-10-05T12:00:00+02:00", 4).map(
      (createdAt) => ({ workspaceId: credited.id, createdAt })
    ),
    ...spread("2026-09-20T12:00:00+02:00", "2026-10-11T12:00:00+02:00", 33).map(
      (createdAt) => ({ workspaceId: future.id, createdAt })
    ),
    // Zeile eines Workspaces, den es nicht mehr gibt
    { workspaceId: 9000, createdAt: at("2026-10-05T12:00:00+02:00") },
  ]);
  await seedEmbedChats(client, [
    ...spread("2026-09-25T08:00:00+02:00", "2026-10-12T09:30:00+02:00", 95).map(
      (createdAt, i) => ({
        embed_id: monthlyEmbed.id,
        createdAt,
        session_id: `m-${i % 12}`,
        feedbackScore: i % 9 === 0 ? true : i % 13 === 0 ? false : null,
      })
    ),
    ...spread("2026-07-10T08:00:00+02:00", "2026-10-12T07:00:00+02:00", 60).map(
      (createdAt, i) => ({
        embed_id: quarterlyEmbed.id,
        createdAt,
        session_id: `q-${i % 5}`,
        conversation_id: `q-${i % 5}-${i % 2}`,
      })
    ),
    ...spread("2026-10-02T08:00:00+02:00", "2026-10-09T18:00:00+02:00", 17).map(
      (createdAt) => ({ embed_id: movedEmbed.id, createdAt, session_id: "x" })
    ),
  ]);
  await client.embed_configs.update({
    where: { id: movedEmbed.id },
    data: { workspace_id: adopter.id },
  });
  // Nach dem Bezugszeitpunkt (10:00 Uhr Berliner Zeit), aber noch in derselben
  // Stunde entstanden: gehören in keinen der beiden Schnappschüsse.
  await seedWorkspaceChats(client, [
    { workspaceId: adopter.id, createdAt: at("2026-10-12T10:59:59.999+02:00") },
  ]);
  await seedEmbedChats(client, [
    {
      embed_id: movedEmbed.id,
      createdAt: at("2026-10-12T10:20:00+02:00"),
      session_id: "y",
    },
  ]);
  // createdAt als Text (an Prisma vorbei): zählt weder bisher noch künftig
  await client.$executeRaw`
    INSERT INTO workspace_chats (workspaceId, prompt, response, createdAt)
    VALUES (${monthly.id}, 'x', '{}', '2026-10-05 10:00:00')`;

  for (const [workspaceId, amount, createdAt] of [
    [monthly.id, 50, "2026-10-02T10:00:00+02:00"],
    [monthly.id, -20, "2026-10-08T10:00:00+02:00"],
    [monthly.id, 99, "2026-09-15T10:00:00+02:00"], // voriger Monat
    [quarterly.id, 5, "2026-08-01T10:00:00+02:00"],
    [credited.id, -25, "2026-10-04T10:00:00+02:00"],
  ])
    await client.workspace_message_adjustments.create({
      data: { workspaceId, amount, createdAt: at(createdAt) },
    });

  return await client.workspaces.findMany({ orderBy: { id: "asc" } });
}

/** Zeilenzahl und Prüfsumme über alle Spalten aller Zeilen einer Tabelle. */
async function checksum(client, table) {
  const rows = await client.$queryRawUnsafe(
    `SELECT * FROM "${table}" ORDER BY id`
  );
  const text = JSON.stringify(rows, (_key, value) =>
    typeof value === "bigint" ? value.toString() : value
  );
  return {
    rows: rows.length,
    sha256: crypto.createHash("sha256").update(text).digest("hex"),
  };
}

const PROTECTED_TABLES = [
  "workspace_chats",
  "embed_chats",
  "workspaces",
  "workspace_message_adjustments",
];

async function runCli(main, argv) {
  let stdout = "";
  let stderr = "";
  const status = await main(argv, {
    stdout: { write: (text) => (stdout += text) },
    stderr: { write: (text) => (stderr += text) },
  });
  return { status, stdout, stderr };
}

describe("vorher_nachher und bestand_unveraendert (AK-10, NAK-1, NAK-2)", () => {
  let workDir;
  beforeEach(async () => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "quota-snapshot-"));
    // Stand von KIE-531: ohne die Migration des Zählerbuchs
    await db.close();
    db = await createTestDatabase({ withoutLedger: true });
    MessageLedger._resetCache();
  });
  afterEach(() => fs.rmSync(workDir, { recursive: true, force: true }));

  test("vorher_nachher: quota-snapshot vor der Migration und nach Migration und Nachtrag - jeder Workspace identisch", async () => {
    const workspaces = await seedRunningQuotas(db.client);
    const now = new Date(ROLLOUT_NOW);
    const before = path.join(workDir, "vorher.json");
    const after = path.join(workDir, "nachher.json");
    expect(
      await db.client.$queryRaw`
        SELECT name FROM sqlite_master WHERE name = 'message_ledger'`
    ).toEqual([]);

    // Stand des Servers vor der Umstellung (Live-Zählung)
    const serverBefore = [];
    for (const workspace of workspaces)
      serverBefore.push((await getMessageLimitInfo(workspace, now)).contingent);
    // Von Hand aus den angelegten Zeilen bestimmt:
    expect(serverBefore).toEqual([
      // 181 Chats + 63 Widget-Chats im Oktober + Buchungen 50 − 20
      "274/600",
      // 71 Chats + 57 Widget-Chats seit 15.07. + Buchung 5: Limit überschritten
      "133/120",
      // 22 Chats seit 30.09.
      "22/50",
      "0/Unlimited",
      // 4 Chats, Gutschrift 25: nicht unter 0
      "0/10",
      // 17 Chats im Oktober, der erste genau am 01.10. um 00:00 Uhr
      "17/30",
      // 17 Chats des hierher umgehängten Widgets, dazu 2 Nachrichten nach
      // dem Bezugszeitpunkt (der Server zählt das ganze Fenster)
      "19/40",
    ]);

    const snapshotArgs = [
      "snapshot",
      "--mode",
      "current",
      "--db",
      db.file,
      "--now",
      ROLLOUT_NOW,
    ];
    expect(
      (await runCli(quotaSnapshot.main, [...snapshotArgs, "--out", before]))
        .status
    ).toBe(0);

    // Vor Migration und Nachtrag gibt es kein Zählerbuch zum Vergleichen.
    const tooEarly = await runCli(quotaSnapshot.main, [
      ...snapshotArgs,
      "--source",
      "ledger",
    ]);
    expect(tooEarly.status).toBe(2);
    expect(tooEarly.stderr).toMatch(
      /Nachtrag des Zählerbuchs ist nicht als abgeschlossen markiert/
    );

    // Migration (wie beim Start des Containers) und Nachtrag
    expect(await db.migrate()).toMatch(/20261012150626_add_message_ledger/);
    const backfill = await runMessageLedgerBackfill({
      ...quiet,
      batchSize: 64,
    });
    expect(backfill.ok).toBe(true);
    expect(backfill.state.tables.workspace_chats).toEqual(
      expect.objectContaining({
        rows: 357,
        skippedOrphaned: 1,
        skippedWithoutTime: 1,
      })
    );

    expect(
      (
        await runCli(quotaSnapshot.main, [
          ...snapshotArgs,
          "--source",
          "ledger",
          "--out",
          after,
        ])
      ).status
    ).toBe(0);

    const comparison = await runCli(quotaSnapshot.main, [
      "compare-ledger",
      before,
      after,
    ]);
    expect(comparison.status).toBe(0);
    const lines = comparison.stdout.trim().split("\n");
    expect(lines.filter((line) => line.includes(": identisch (")).length).toBe(
      workspaces.length
    );
    expect(comparison.stdout).toContain(
      `Ergebnis: ${workspaces.length} identisch, 0 abweichend.`
    );
    expect(comparison.stdout).not.toMatch(/abweichend –/);

    // Die Schnappschüsse nennen je Workspace dieselben Zahlen …
    const snapshotBefore = JSON.parse(fs.readFileSync(before, "utf8"));
    const snapshotAfter = JSON.parse(fs.readFileSync(after, "utf8"));
    expect(snapshotAfter.source).toBe("ledger");
    const numbers = (snapshot) =>
      snapshot.workspaces.map((ws) => [
        ws.id,
        ws.messageCount,
        ws.workspaceChatCount,
        ws.embedChatCount,
        ws.adjustmentsTotal,
        ws.limitReached,
      ]);
    expect(numbers(snapshotAfter)).toEqual(numbers(snapshotBefore));
    expect(snapshotBefore.workspaces.map((ws) => ws.messageCount)).toEqual([
      274, 133, 22, 0, 0, 17, 17,
    ]);

    // … und der Server liefert nach der Umstellung exakt denselben Stand.
    expect(await MessageLedger.isBackfillComplete()).toBe(true);
    const serverAfter = [];
    for (const workspace of workspaces)
      serverAfter.push((await getMessageLimitInfo(workspace, now)).contingent);
    expect(serverAfter).toEqual(serverBefore);
    expect(await eventsOf(db.client, "message_ledger_mismatch")).toEqual([]);

    // Gegenprobe: Eine einzige abweichende Buchung im Zählerbuch fällt auf.
    await db.client.message_ledger.updateMany({
      where: { workspace_id: workspaces[2].id, day: "2026-10-10", hour: 12 },
      data: { messages: { increment: 1 } },
    });
    const tampered = path.join(workDir, "verstellt.json");
    await runCli(quotaSnapshot.main, [
      ...snapshotArgs,
      "--source",
      "ledger",
      "--out",
      tampered,
    ]);
    const mismatch = await runCli(quotaSnapshot.main, [
      "compare-ledger",
      before,
      tampered,
    ]);
    expect(mismatch.status).toBe(1);
    expect(mismatch.stdout).toMatch(
      /\[3\] workspace-\d+: abweichend – Stand 22 → 23, Chats 22 → 23/
    );
    expect(mismatch.stdout).toContain(
      "Der Rollout darf nicht fortgesetzt werden."
    );
  }, 120000);

  test("vorher_nachher: Nachrichten nach --now in derselben Berliner Stunde zählen in keinem der beiden Schnappschüsse, auch in der doppelten Stunde 2", async () => {
    const workspace = await createWorkspace(db.client, { messagesLimit: 10 });
    const embed = await createEmbed(db.client, workspace);
    const at = (iso) => new Date(iso);
    // 25.10.2026, Rückstellung auf Winterzeit: 02:00–02:59 Uhr gibt es zweimal.
    await seedWorkspaceChats(db.client, [
      { workspaceId: workspace.id, createdAt: at("2026-10-25T01:10:00+02:00") },
      { workspaceId: workspace.id, createdAt: at("2026-10-25T02:30:00+02:00") },
      // nach dem Bezugszeitpunkt: erster Durchlauf, zweiter Durchlauf, später
      { workspaceId: workspace.id, createdAt: at("2026-10-25T02:50:00+02:00") },
      { workspaceId: workspace.id, createdAt: at("2026-10-25T02:30:00+01:00") },
      { workspaceId: workspace.id, createdAt: at("2026-10-25T03:05:00+01:00") },
    ]);
    await seedEmbedChats(db.client, [
      { embed_id: embed.id, createdAt: at("2026-10-25T02:39:59+02:00") },
      { embed_id: embed.id, createdAt: at("2026-10-25T02:40:00+02:00") },
      { embed_id: embed.id, createdAt: at("2026-10-25T02:59:00+01:00") },
    ]);
    // Bezugszeitpunkt 02:40 Uhr im ersten Durchlauf
    const args = [
      "snapshot",
      "--mode",
      "current",
      "--db",
      db.file,
      "--now",
      "2026-10-25T00:40:00.000Z",
    ];
    const before = path.join(workDir, "vorher.json");
    const after = path.join(workDir, "nachher.json");
    await runCli(quotaSnapshot.main, [...args, "--out", before]);

    await db.migrate();
    expect((await runMessageLedgerBackfill(quiet)).ok).toBe(true);
    await runCli(quotaSnapshot.main, [
      ...args,
      "--source",
      "ledger",
      "--out",
      after,
    ]);

    const numbers = (file) => {
      const [ws] = JSON.parse(fs.readFileSync(file, "utf8")).workspaces;
      return [ws.messageCount, ws.workspaceChatCount, ws.embedChatCount];
    };
    // 2 Chats und 2 Widget-Chats bis 02:40:00,000 Uhr (einschließlich)
    expect(numbers(before)).toEqual([4, 2, 2]);
    expect(numbers(after)).toEqual([4, 2, 2]);
    expect(
      (await runCli(quotaSnapshot.main, ["compare-ledger", before, after]))
        .status
    ).toBe(0);
    // Im Zählerbuch stehen alle Nachrichten der Stunde 2 in einer Zeile.
    expect(
      await db.client.message_ledger.aggregate({
        where: { day: "2026-10-25", hour: 2 },
        _sum: { messages: true },
      })
    ).toEqual({ _sum: { messages: 6 } });
  }, 120000);

  test("vorher_nachher: Kopien einer Thread-Verzweigung nach --now in derselben Berliner Stunde werden nicht als Nachrichten abgezogen - der Workspace gilt als nicht auswertbar", async () => {
    const at = (iso) => new Date(iso);
    const copies = (workspace, iso, count) =>
      Array.from({ length: count }, () => ({
        workspaceId: workspace.id,
        prompt: "Kopie",
        response: "{}",
        createdAt: at(iso),
      }));
    // Bezugszeitpunkt 10:00 Uhr Berliner Zeit. Jeder Workspace hat eine
    // Nachricht davor; was danach kommt, unterscheidet sie.
    const forked = await createWorkspace(db.client, { messagesLimit: 10 });
    const forkedEarlier = await createWorkspace(db.client);
    const nothingLate = await createWorkspace(db.client);
    const embed = await createEmbed(db.client, nothingLate);
    await seedWorkspaceChats(db.client, [
      { workspaceId: forked.id, createdAt: at("2026-10-12T09:50:00+02:00") },
      // genau am Bezugszeitpunkt: zählt noch
      { workspaceId: forked.id, createdAt: at("2026-10-12T10:00:00+02:00") },
      // späte Nachricht derselben Stunde
      { workspaceId: forked.id, createdAt: at("2026-10-12T10:20:00+02:00") },
      {
        workspaceId: forkedEarlier.id,
        createdAt: at("2026-10-12T09:50:00+02:00"),
      },
      {
        workspaceId: forkedEarlier.id,
        createdAt: at("2026-10-12T10:20:00+02:00"),
      },
      {
        workspaceId: nothingLate.id,
        createdAt: at("2026-10-12T09:50:00+02:00"),
      },
    ]);
    await seedEmbedChats(db.client, [
      { embed_id: embed.id, createdAt: at("2026-10-12T09:55:00+02:00") },
      // späte Widget-Zeile: Widget-Zeilen sind nie Kopien
      { embed_id: embed.id, createdAt: at("2026-10-12T10:25:00+02:00") },
    ]);

    const args = [
      "snapshot",
      "--mode",
      "current",
      "--db",
      db.file,
      "--now",
      ROLLOUT_NOW,
    ];
    const before = path.join(workDir, "vorher.json");
    const after = path.join(workDir, "nachher.json");
    await runCli(quotaSnapshot.main, [...args, "--out", before]);

    await db.migrate();
    expect((await runMessageLedgerBackfill(quiet)).ok).toBe(true);
    // Das neue Image läuft: Threads werden verzweigt.
    for (const chatsData of [
      // nach dem Bezugszeitpunkt, in derselben Stunde wie die späte Nachricht
      copies(forked, "2026-10-12T10:30:00+02:00", 3),
      // in der Stunde davor: Die Stunde des Bezugszeitpunkts führt keine Kopien
      copies(forkedEarlier, "2026-10-12T09:40:00+02:00", 3),
      // in der Stunde des Bezugszeitpunkts, aber keine späte Zeile
      copies(nothingLate, "2026-10-12T10:00:00+02:00", 2),
    ])
      expect((await WorkspaceChats.bulkCreate(chatsData)).message).toBeNull();
    expect(
      (await ledgerRows(db.client, { day: "2026-10-12", hour: 10 })).map(
        (row) => [row.workspace_id, row.embed_id, row.messages, row.copied]
      )
    ).toEqual([
      [forked.id, 0, 2, 3],
      [forkedEarlier.id, 0, 1, 0],
      [nothingLate.id, 0, 0, 2],
      [nothingLate.id, embed.id, 1, 0],
    ]);

    expect(
      (
        await runCli(quotaSnapshot.main, [
          ...args,
          "--source",
          "ledger",
          "--out",
          after,
        ])
      ).status
    ).toBe(0);
    const entries = (file) =>
      Object.fromEntries(
        JSON.parse(fs.readFileSync(file, "utf8")).workspaces.map((ws) => [
          ws.id,
          ws.error
            ? { error: ws.error, messageCount: ws.messageCount }
            : [ws.messageCount, ws.workspaceChatCount, ws.embedChatCount],
        ])
      );
    expect(entries(before)).toEqual({
      [forked.id]: [2, 2, 0],
      [forkedEarlier.id]: [1, 1, 0],
      [nothingLate.id]: [2, 1, 1],
    });
    const ledger = entries(after);
    // Von den vier späten Zeilen sind drei Kopien: Das Zählerbuch kann sie
    // nicht von der Nachricht unterscheiden und nennt deshalb keine Zahl.
    expect(ledger[forked.id]).toEqual({
      error: expect.stringMatching(
        /^Stand der Stunde 2026-10-12 10 Uhr nicht bestimmbar: .*Kopien aus einer Thread-Verzweigung.*eingefrorenen Stand/
      ),
      messageCount: undefined,
    });
    // Ohne Kopien in der Stunde bzw. ohne späte Chat-Zeilen bleibt es exakt.
    expect(ledger[forkedEarlier.id]).toEqual([1, 1, 0]);
    expect(ledger[nothingLate.id]).toEqual([2, 1, 1]);

    const comparison = await runCli(quotaSnapshot.main, [
      "compare-ledger",
      before,
      after,
    ]);
    expect(comparison.status).toBe(1);
    expect(comparison.stdout).toMatch(
      new RegExp(
        `\\[${forked.id}\\] ${forked.slug}: nicht auswertbar \\(Stand der Stunde 2026-10-12 10 Uhr nicht bestimmbar`
      )
    );
    // keine falsche Zahl
    expect(comparison.stdout).not.toMatch(/Stand 2 →/);
    expect(comparison.stdout).toContain("Ergebnis: 2 identisch, 1 abweichend.");
  }, 120000);

  test("bestand_unveraendert: Migration und Nachtrag ändern keine Zeile in workspace_chats, embed_chats, workspaces und workspace_message_adjustments", async () => {
    await seedRunningQuotas(db.client);
    const before = {};
    for (const table of PROTECTED_TABLES)
      before[table] = await checksum(db.client, table);
    expect(before.workspace_chats.rows).toBe(359);
    expect(before.embed_chats.rows).toBe(173);
    const tablesBefore = await db.client.$queryRaw`
      SELECT name, sql FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE '_prisma%' ORDER BY name`;

    await db.migrate();
    for (const table of PROTECTED_TABLES)
      expect(await checksum(db.client, table)).toEqual(before[table]);

    expect(
      (await runMessageLedgerBackfill({ ...quiet, batchSize: 50 })).ok
    ).toBe(true);
    for (const table of PROTECTED_TABLES)
      expect(await checksum(db.client, table)).toEqual(before[table]);
    expect(await db.client.message_ledger.count()).toBeGreaterThan(100);

    // Die Migration hat keine bestehende Tabelle umgebaut: Hinzugekommen ist
    // allein message_ledger.
    const tablesAfter = await db.client.$queryRaw`
      SELECT name, sql FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE '_prisma%' ORDER BY name`;
    expect(
      tablesAfter.filter((table) => table.name !== "message_ledger")
    ).toEqual(tablesBefore);
    expect(tablesAfter.map((table) => table.name)).toContain("message_ledger");
  }, 120000);
});

describe("nicht_fatal (AK-14)", () => {
  test("nicht_fatal: bricht der Nachtrag mit einem Fehler ab, liest das Kontingent die Live-Zählung, das Ereignis ist geschrieben und neue Nachrichten werden trotzdem gezählt", async () => {
    const workspace = await createWorkspace(db.client, { messagesLimit: 100 });
    await seedWorkspaceChats(
      db.client,
      Array.from({ length: 30 }, (_, i) => ({
        workspaceId: workspace.id,
        createdAt: new Date(Date.now() - HOUR - i * 1000),
      }))
    );
    const window = (await getMessageLimitInfo(workspace)).billingWindow;
    const live = await WorkspaceChats.count({
      workspaceId: workspace.id,
      createdAt: { gte: window.start, lt: window.endExclusive },
    });

    const failed = await runMessageLedgerBackfill({
      ...quiet,
      batchSize: 10,
      afterBatch: () => {
        throw new Error("künstlicher Fehler im Nachtrag");
      },
    });
    expect(failed).toEqual(
      expect.objectContaining({
        ok: false,
        error: "Error: künstlicher Fehler im Nachtrag",
      })
    );

    const marker = await MessageLedger.backfillState();
    expect(marker.state).toBe("failed");
    expect(marker.error).toBe("Error: künstlicher Fehler im Nachtrag");
    expect(marker.completedAt).toBeNull();
    const events = await eventsOf(db.client, "message_ledger_backfill_failed");
    expect(events).toHaveLength(1);
    expect(events[0].metadata.error).toBe(
      "Error: künstlicher Fehler im Nachtrag"
    );

    // Das Kontingent liefert die Live-Zählung (10 der 30 Zeilen stehen im Zählerbuch).
    expect(await MessageLedger.isBackfillComplete()).toBe(false);
    expect((await getMessageLimitInfo(workspace)).messageCount).toBe(live);

    // Neue Nachrichten werden trotzdem im Zählerbuch gezählt.
    const { chat } = await WorkspaceChats.new({
      workspaceId: workspace.id,
      prompt: "neu",
    });
    const cell = berlinCell(chat.createdAt);
    const ledgerNow = await db.client.message_ledger.aggregate({
      _sum: { messages: true },
    });
    expect(ledgerNow._sum.messages).toBe(11);
    expect(
      (await ledgerRows(db.client)).some(
        (row) => row.day === cell.day && row.hour === cell.hour
      )
    ).toBe(true);
    expect((await getMessageLimitInfo(workspace)).messageCount).toBe(live + 1);

    // Der nächste Start setzt fort; danach gilt das Zählerbuch, ohne Doppelzählung.
    const resumed = await runMessageLedgerBackfill({ ...quiet, batchSize: 10 });
    expect(resumed.ok).toBe(true);
    expect(resumed.rows).toBe(20);
    expect(await ledgerRows(db.client)).toEqual(
      await expectedLedger(db.client)
    );
    expect(await MessageLedger.isBackfillComplete()).toBe(true);
    expect((await getMessageLimitInfo(workspace)).messageCount).toBe(live + 1);
  });

  test("nicht_fatal: ein Datenbankfehler im Nachtrag wird nicht weitergereicht", async () => {
    const workspace = await createWorkspace(db.client);
    await seedWorkspaceChats(db.client, [
      { workspaceId: workspace.id, createdAt: new Date() },
    ]);
    await db.client.$executeRawUnsafe(
      `CREATE TRIGGER kuenstlicher_fehler BEFORE INSERT ON message_ledger
       BEGIN SELECT RAISE(ABORT, 'künstlicher Fehler im Zählerbuch'); END`
    );

    const failed = await runMessageLedgerBackfill(quiet);
    expect(failed.ok).toBe(false);
    expect(failed.error).toMatch(/künstlicher Fehler im Zählerbuch/);
    expect((await MessageLedger.backfillState()).state).toBe("failed");
    expect(await db.client.message_ledger.count()).toBe(0);
    expect(
      await eventsOf(db.client, "message_ledger_backfill_failed")
    ).toHaveLength(1);
    expect((await getMessageLimitInfo(workspace)).messageCount).toBe(1);
  });

  describe("Startpfad", () => {
    function fakeApp(onListen = () => {}) {
      const app = {
        listening: null,
        listen: jest.fn((port) => {
          app.listening = Promise.resolve(onListen(port));
          return { on: jest.fn() };
        }),
      };
      return app;
    }
    async function untilListening(app) {
      for (let i = 0; i < 400 && !app.listening; i++)
        await new Promise((resolve) => setTimeout(resolve, 10));
      expect(app.listen).toHaveBeenCalledTimes(1);
      return await app.listening;
    }

    test("nicht_fatal: der Server nimmt Anfragen erst nach dem Nachtrag an", async () => {
      const { bootHTTP } = require("../../utils/boot");
      const workspace = await createWorkspace(db.client);
      await seedWorkspaceChats(
        db.client,
        Array.from({ length: 5 }, () => ({
          workspaceId: workspace.id,
          createdAt: new Date(Date.now() - HOUR),
        }))
      );

      // Beim Lauschen ist der Nachtrag abgeschlossen.
      const app = fakeApp(() => MessageLedger.backfillState());
      bootHTTP(app, 3999);
      expect(app.listen).not.toHaveBeenCalled();
      const stateAtListen = await untilListening(app);

      expect(app.listen.mock.calls[0][0]).toBe(3999);
      expect(stateAtListen.state).toBe("complete");
      expect(stateAtListen.tables.workspace_chats.rows).toBe(5);
    });

    test("Startpfad: die Thread-Zahl der Query-Engine gilt nur bis zum Lauschen im Prozess", async () => {
      const { bootHTTP } = require("../../utils/boot");
      const {
        ensureEngineThreads,
      } = require("../../utils/prisma/engineThreads");
      const saved = process.env.TOKIO_WORKER_THREADS;
      try {
        // wie utils/prisma beim Laden
        delete process.env.TOKIO_WORKER_THREADS;
        ensureEngineThreads();
        expect(process.env.TOKIO_WORKER_THREADS).toEqual(expect.any(String));

        // Beim Lauschen ist die Engine geladen und die Variable wieder frei
        // für Module, die erst mit den Anfragen laden (LanceDB).
        const app = fakeApp(() => process.env.TOKIO_WORKER_THREADS);
        bootHTTP(app, 3999);
        expect(await untilListening(app)).toBeUndefined();

        // Ein vom Betrieb gesetzter Wert bleibt stehen.
        process.env.TOKIO_WORKER_THREADS = "24";
        ensureEngineThreads();
        const second = fakeApp(() => process.env.TOKIO_WORKER_THREADS);
        bootHTTP(second, 3999);
        expect(await untilListening(second)).toBe("24");
      } finally {
        if (saved === undefined) delete process.env.TOKIO_WORKER_THREADS;
        else process.env.TOKIO_WORKER_THREADS = saved;
      }
    });

    test("nicht_fatal: schlägt der Nachtrag fehl, startet der Server trotzdem", async () => {
      const { bootHTTP } = require("../../utils/boot");
      const workspace = await createWorkspace(db.client);
      await seedWorkspaceChats(db.client, [
        { workspaceId: workspace.id, createdAt: new Date(Date.now() - HOUR) },
      ]);
      await db.client.$executeRawUnsafe(
        `CREATE TRIGGER kuenstlicher_fehler BEFORE INSERT ON message_ledger
         BEGIN SELECT RAISE(ABORT, 'künstlicher Fehler im Zählerbuch'); END`
      );

      const app = fakeApp(() => MessageLedger.backfillState());
      bootHTTP(app, 3999);
      const stateAtListen = await untilListening(app);

      expect(stateAtListen.state).toBe("failed");
      expect(
        await eventsOf(db.client, "message_ledger_backfill_failed")
      ).toHaveLength(1);
      expect((await getMessageLimitInfo(workspace)).messageCount).toBe(1);
    });
  });
});

describe("verlorene Markierung", () => {
  test("wasserstand: fehlt die Markierung bei gefülltem Zählerbuch, wird nicht ein zweites Mal nachgetragen", async () => {
    const { first, embeds } = await seedFortyDays(db.client);
    expect((await runMessageLedgerBackfill(quiet)).ok).toBe(true);
    await WorkspaceChats.new({ workspaceId: first.id, prompt: "neu" });
    const expected = await expectedLedger(db.client);
    expect(await ledgerRows(db.client)).toEqual(expected);

    // Die Markierung geht verloren (von Hand gelöscht) bzw. ist unlesbar.
    for (const damage of [
      () =>
        db.client.system_settings.delete({
          where: { label: "message_ledger_backfill" },
        }),
      () =>
        db.client.system_settings.update({
          where: { label: "message_ledger_backfill" },
          data: { value: "{kaputt" },
        }),
    ]) {
      await damage();
      MessageLedger._resetCache();

      const result = await runMessageLedgerBackfill(quiet);
      expect(result).toEqual(
        expect.objectContaining({ ok: true, alreadyComplete: true, rows: 0 })
      );
      expect(result.state).toEqual(
        expect.objectContaining({ state: "complete", recovered: true })
      );
      // nichts doppelt gebucht
      expect(await ledgerRows(db.client)).toEqual(expected);
      expect(await MessageLedger.isBackfillComplete()).toBe(true);
    }
    expect(
      await eventsOf(db.client, "message_ledger_marker_recovered")
    ).toHaveLength(2);

    // Auch die erste Nachricht nach dem Verlust löst keinen Nachtrag aus.
    await db.client.system_settings.delete({
      where: { label: "message_ledger_backfill" },
    });
    MessageLedger._resetCache();
    await EmbedChats.new({
      embedId: embeds[0].id,
      prompt: "neu",
      sessionId: "nach-verlust",
    });
    expect((await MessageLedger.backfillState()).state).toBe("complete");
    expect((await runMessageLedgerBackfill(quiet)).alreadyComplete).toBe(true);
    expect(await ledgerRows(db.client)).toEqual(
      await expectedLedger(db.client)
    );
  });
});

describe("resync (AK-17)", () => {
  /** Zeilen, wie sie ein älteres Image anlegt: ohne Zählerbuch. */
  async function rollbackPeriod(workspace, embed) {
    await seedWorkspaceChats(db.client, [
      // Stunde, in der schon gezählt wurde
      {
        workspaceId: workspace.id,
        createdAt: new Date("2026-10-10T09:40:00+02:00"),
      },
      {
        workspaceId: workspace.id,
        createdAt: new Date("2026-10-10T09:50:00+02:00"),
      },
      // neue Stunden
      {
        workspaceId: workspace.id,
        createdAt: new Date("2026-10-11T15:05:00+02:00"),
      },
      {
        workspaceId: workspace.id,
        createdAt: new Date("2026-10-12T00:00:00+02:00"),
      },
    ]);
    await seedEmbedChats(db.client, [
      {
        embed_id: embed.id,
        createdAt: new Date("2026-10-11T15:10:00+02:00"),
        session_id: "rollback",
        conversation_id: "rollback-1",
        feedbackScore: true,
      },
      {
        embed_id: embed.id,
        createdAt: new Date("2026-10-11T15:20:00+02:00"),
        session_id: "rollback",
        conversation_id: "rollback-1",
      },
    ]);
  }

  async function seedBeforeRollback() {
    const workspace = await createWorkspace(db.client);
    const other = await createWorkspace(db.client);
    const embed = await createEmbed(db.client, workspace);
    await seedWorkspaceChats(db.client, [
      {
        workspaceId: workspace.id,
        createdAt: new Date("2026-10-08T11:00:00+02:00"),
      },
      {
        workspaceId: workspace.id,
        createdAt: new Date("2026-10-10T09:10:00+02:00"),
      },
      {
        workspaceId: workspace.id,
        createdAt: new Date("2026-10-10T09:20:00+02:00"),
      },
      {
        workspaceId: workspace.id,
        createdAt: new Date("2026-10-10T09:30:00+02:00"),
      },
      {
        workspaceId: other.id,
        createdAt: new Date("2026-10-10T09:30:00+02:00"),
      },
    ]);
    await seedEmbedChats(db.client, [
      {
        embed_id: embed.id,
        createdAt: new Date("2026-10-10T16:00:00+02:00"),
        session_id: "frueh",
        conversation_id: "frueh-1",
      },
    ]);
    expect((await runMessageLedgerBackfill(quiet)).ok).toBe(true);
    return { workspace, other, embed };
  }

  test("resync: ledger-resync --from berechnet die Stunden ab dem Datum neu und senkt keinen Wert", async () => {
    const { workspace, other, embed } = await seedBeforeRollback();

    // Vor dem Rollback: zwei gezählte Zeilen der Stunde 9 werden gelöscht.
    const hourNine = await db.client.workspace_chats.findMany({
      where: {
        workspaceId: workspace.id,
        createdAt: {
          gte: new Date("2026-10-10T09:00:00+02:00"),
          lt: new Date("2026-10-10T10:00:00+02:00"),
        },
      },
      take: 2,
    });
    await db.client.workspace_chats.deleteMany({
      where: { id: { in: hourNine.map((chat) => chat.id) } },
    });
    // Rollback auf ein älteres Image: Zeilen entstehen ohne Zählung - auch
    // vor dem Datum, ab dem nachher neu berechnet wird.
    await rollbackPeriod(workspace, embed);
    await seedWorkspaceChats(db.client, [
      {
        workspaceId: workspace.id,
        createdAt: new Date("2026-10-09T12:00:00+02:00"),
      },
    ]);
    const before = await ledgerRows(db.client);

    // Probelauf: zeigt die Änderungen, schreibt nichts.
    const dryRun = await resyncLedger({
      client: db.client,
      fromDay: "2026-10-10",
      dryRun: true,
    });
    expect(dryRun.messagesAdded).toBe(4);
    expect(await ledgerRows(db.client)).toEqual(before);

    const result = await runCli(resyncMain, [
      "--from=2026-10-10",
      "--db",
      db.file,
      "--json",
    ]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).messagesAdded).toBe(4);

    const after = await ledgerRows(db.client);
    const cellOf = (rows, workspaceId, embedId, day, hour) =>
      rows.find(
        (row) =>
          row.workspace_id === workspaceId &&
          row.embed_id === embedId &&
          row.day === day &&
          row.hour === hour
      );
    // Stunde 9 am 10.10.: 3 gezählt, 2 davon gelöscht, 2 ungezählte neue →
    // 3 Zeilen vorhanden, 3 gezählt: nichts anzuheben, nichts zu senken.
    expect(cellOf(after, workspace.id, 0, "2026-10-10", 9).messages).toBe(3);
    // neue Stunden aus der Zeit des Rollbacks
    expect(cellOf(after, workspace.id, 0, "2026-10-11", 15).messages).toBe(1);
    expect(cellOf(after, workspace.id, 0, "2026-10-12", 0).messages).toBe(1);
    expect(cellOf(after, workspace.id, embed.id, "2026-10-11", 15)).toEqual(
      expect.objectContaining({
        messages: 2,
        conversations_started: 1,
        feedback_positive: 1,
        feedback_negative: 0,
      })
    );
    // vor dem Datum bleibt alles, wie es war - auch die ungezählte Zeile vom 09.10.
    expect(cellOf(after, workspace.id, 0, "2026-10-09", 12)).toBeUndefined();
    expect(cellOf(after, workspace.id, 0, "2026-10-08", 11).messages).toBe(1);
    expect(cellOf(after, other.id, 0, "2026-10-10", 9).messages).toBe(1);

    // Kein Wert ist gesunken.
    const key = (row) =>
      `${row.workspace_id}|${row.embed_id}|${row.day}|${row.hour}`;
    const afterByKey = new Map(after.map((row) => [key(row), row]));
    for (const row of before)
      for (const column of [
        "messages",
        "copied",
        "conversations_started",
        "feedback_positive",
        "feedback_negative",
      ])
        expect(afterByKey.get(key(row))[column]).toBeGreaterThanOrEqual(
          row[column]
        );

    // Ein zweiter Lauf ändert nichts mehr.
    const again = await resyncLedger({
      client: db.client,
      fromDay: "2026-10-10",
    });
    expect(again.raised).toEqual([]);
    expect(await ledgerRows(db.client)).toEqual(after);
  });

  test("resync: Kopien und umgehängte Widgets werden nicht als fehlende Nachrichten gebucht", async () => {
    const { workspace, other, embed } = await seedBeforeRollback();
    const user = await db.client.users.create({
      data: { username: "anna", password: "x" },
    });
    // Kopien aus einer Verzweigung (zählen als copied, nicht als messages)
    await WorkspaceChats.bulkCreate([
      {
        workspaceId: workspace.id,
        prompt: "a",
        response: "{}",
        user_id: user.id,
      },
      {
        workspaceId: workspace.id,
        prompt: "b",
        response: "{}",
        user_id: user.id,
      },
    ]);
    // Widget nach dem Zählen umgehängt: Seine Nachrichten stehen im Zählerbuch
    // des früheren Workspaces.
    await EmbedChats.new({ embedId: embed.id, prompt: "x", sessionId: "s" });
    await db.client.embed_configs.update({
      where: { id: embed.id },
      data: { workspace_id: other.id },
    });
    const before = await ledgerRows(db.client);

    const result = await resyncLedger({
      client: db.client,
      fromDay: "2026-10-01",
    });

    expect(result.raised).toEqual([]);
    expect(await ledgerRows(db.client)).toEqual(before);
  });

  test("resync: läuft nur nach abgeschlossenem Nachtrag und nur mit gültigem Datum", async () => {
    const workspace = await createWorkspace(db.client);
    await seedWorkspaceChats(db.client, [
      {
        workspaceId: workspace.id,
        createdAt: new Date("2026-10-10T09:10:00+02:00"),
      },
    ]);

    await expect(
      resyncLedger({ client: db.client, fromDay: "2026-10-01" })
    ).rejects.toThrow(/Nachtrag des Zählerbuchs ist nicht abgeschlossen/);
    expect(await db.client.message_ledger.count()).toBe(0);

    expect((await runMessageLedgerBackfill(quiet)).ok).toBe(true);
    for (const fromDay of ["10.10.2026", "2026-13-01", "2026-02-30", ""])
      await expect(
        resyncLedger({ client: db.client, fromDay })
      ).rejects.toThrow(/--from/);

    const missing = await runCli(resyncMain, ["--db", db.file]);
    expect(missing.status).toBe(2);
    expect(missing.stderr).toMatch(/--from=<YYYY-MM-DD> angeben/);
    const unknown = await runCli(resyncMain, ["--from=2026-10-01", "--delete"]);
    expect(unknown.status).toBe(2);
  });
});
