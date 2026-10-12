/* eslint-env jest, node */
// KIE-536 — POST /embed/:embedId/analytics/summary: Kennzahlen und Zeitreihe
// eines Widgets aus dem Zählerbuch.
//
// Geprüft wird gegen die echte Route mit ihrer ganzen Middleware-Kette
// (support/routeHarness.js: Anmeldung, Rollenprüfung, Bindung an den
// Workspace) und gegen eine echte SQLite-Datei aus den Migrationen
// (helpers/sqliteTestDatabase.js) - Zählerbuch, Gruppierung und die
// Konversationsliste laufen also wie im Betrieb.
//
// Die Zeitzone des Prozesses wird nicht gesetzt; alle Zeitpunkte sind
// Berliner Wanduhrzeiten (berlinInstant). Die Erwartungen gelten für TZ=UTC,
// TZ=Europe/Berlin und TZ=America/New_York (extras/scripts/testTimezones.mjs).
jest.mock(
  "../../utils/prisma",
  () => require("../helpers/sqliteTestDatabase").testPrisma
);
jest.mock("../../models/telemetry", () => ({
  Telemetry: { sendTelemetry: jest.fn() },
}));
// Kein Abruf der Modell-Liste aus dem Netz beim Laden der Provider.
jest.mock("../../utils/AiProviders/modelMap", () => ({
  MODEL_MAP: { get: () => null },
}));
// Nur für den Passwortschutz des Einbenutzerbetriebs nötig (hier ohne).
jest.mock("../../utils/EncryptionManager", () => ({
  EncryptionManager: class {
    decrypt() {
      return null;
    }
  },
}));
jest.mock("../../utils/files/multer", () => ({
  handleEmbedLogoUpload: jest.fn((_request, _response, next) => next()),
}));
jest.mock("../../utils/files/embedLogo", () => ({
  deleteOldEmbedLogo: jest.fn(),
}));

// Setzt JWT_SECRET, bevor utils/http geladen wird.
const { collectRoutes, invoke } = require("./support/routeHarness");
const {
  createTestDatabase,
  removeTestDatabases,
  createWorkspace,
  createEmbed,
  berlinCell,
  berlinInstant,
} = require("../helpers/sqliteTestDatabase");
const { makeJWT } = require("../../utils/http");
const { MessageLedger } = require("../../models/messageLedger");
const { EmbedChats } = require("../../models/embedChats");
const { EmbedConfig } = require("../../models/embedConfig");
const { embedManagementEndpoints } = require("../../endpoints/embedManagement");

const routes = collectRoutes(embedManagementEndpoints);
const SUMMARY = routes["POST /embed/:embedId/analytics/summary"];
const CONVERSATIONS = routes["POST /embed/:embedId/analytics/conversations"];
const OVERVIEW = routes["POST /embed/:embedId/analytics/overview"];

const DAY = 24 * 60 * 60 * 1000;

// Der erste Test jeder Datei erzeugt die Vorlage mit `prisma migrate deploy`.
jest.setTimeout(60000);

let db;
let errorSpy;
let logSpy;
let timelineSpy;
let firstDaySpy;
let userCounter = 0;

beforeEach(async () => {
  MessageLedger._resetCache();
  EmbedChats._resetFeedbackLimits();
  delete process.env.DISABLE_VIEW_CHAT_HISTORY;
  db = await createTestDatabase();
  errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
  timelineSpy = jest.spyOn(MessageLedger, "timelineForEmbed");
  firstDaySpy = jest.spyOn(MessageLedger, "firstDayForEmbed");
});
afterEach(async () => {
  delete process.env.DISABLE_VIEW_CHAT_HISTORY;
  jest.restoreAllMocks();
  errorSpy.mockRestore();
  logSpy.mockRestore();
  await db.close();
});
afterAll(() => {
  MessageLedger._resetCache();
  removeTestDatabases();
});

// ---------------------------------------------------------------------------
// Bestand
// ---------------------------------------------------------------------------

/** Kalendertag + n Tage, unabhängig vom geprüften Code gerechnet. */
function addDays(day, n) {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + n);
  return date.toISOString().slice(0, 10);
}

function daysOf(from, to) {
  const days = [];
  for (let day = from; day <= to; day = addDays(day, 1)) days.push(day);
  return days;
}

async function setMultiUserMode(enabled) {
  await db.client.system_settings.upsert({
    where: { label: "multi_user_mode" },
    update: { value: String(enabled) },
    create: { label: "multi_user_mode", value: String(enabled) },
  });
}

/**
 * Legt einen Nutzer an und liefert sein Sitzungs-Token (echtes JWT).
 * @param {"admin"|"manager"|"default"} role
 * @param {number[]} [workspaceIds] - Mitgliedschaften
 */
async function createUser(role, workspaceIds = []) {
  const user = await db.client.users.create({
    data: { username: `${role}-${++userCounter}`, password: "x", role },
  });
  for (const workspaceId of workspaceIds)
    await db.client.workspace_users.create({
      data: { user_id: user.id, workspace_id: workspaceId },
    });
  return {
    id: user.id,
    role,
    token: makeJWT({ id: user.id, username: user.username }),
  };
}

/**
 * Eine Widget-Nachricht zu einem vorgegebenen Zeitpunkt, gezählt wie in
 * EmbedChats.new: Chat-Zeile und Zähler in einer Transaktion, über die eine
 * Zählfunktion MessageLedger.record.
 */
async function chatAt(embed, instant, data = {}) {
  return await MessageLedger.transaction(
    { source: "test", embedId: embed.id },
    async (tx) => {
      const created = await tx.embed_chats.create({
        data: {
          prompt: "Frage",
          response: JSON.stringify({ text: "Antwort" }),
          session_id: "sitzung",
          embed_id: embed.id,
          createdAt: instant,
          ...data,
        },
      });
      const owner = await tx.embed_configs.findUnique({
        where: { id: embed.id },
        select: { workspace_id: true },
      });
      await MessageLedger.record(tx, {
        workspaceId: owner.workspace_id,
        embedId: embed.id,
        at: created.createdAt,
        messages: 1,
        conversationStarted: await EmbedChats._startsConversation(tx, created),
      });
      return created;
    }
  );
}

/** Zählwerte ohne Chat-Zeilen: der Stand, nachdem die Inhalte gelöscht sind. */
async function countsOnly(embed, cells) {
  await MessageLedger.transaction(
    { source: "test", embedId: embed.id },
    async (tx) =>
      await MessageLedger.addCells(
        tx,
        cells.map((cell) => ({
          workspaceId: embed.workspace_id,
          embedId: embed.id,
          hour: 12,
          ...cell,
        }))
      )
  );
}

function summary(embed, body, user = null) {
  return invoke(SUMMARY, {
    params: { embedId: String(embed?.id ?? embed) },
    body,
    token: user?.token ?? null,
  });
}

function conversations(embed, body, user = null) {
  return invoke(CONVERSATIONS, {
    params: { embedId: String(embed.id) },
    body,
    token: user?.token ?? null,
  });
}

const sum = (buckets, key) =>
  buckets.reduce((total, bucket) => total + bucket[key], 0);

// ============================================================================
// AK-1 — Säulen zeigen Nachrichten pro Tag
// ============================================================================
describe("tage_mit_luecken (AK-1)", () => {
  test("tage_mit_luecken: 30 Tage, Nachrichten an 20 davon - 30 Tagesabschnitte, 10 mit Wert 0", async () => {
    const workspace = await createWorkspace(db.client);
    const embed = await createEmbed(db.client, workspace);
    const days = daysOf("2026-09-13", "2026-10-12");
    expect(days).toHaveLength(30);

    // Jeder dritte Tag bleibt leer; an den übrigen 1 bis 3 Nachrichten.
    const expected = {};
    for (const [i, day] of days.entries()) {
      expected[day] = i % 3 === 2 ? 0 : (i % 3) + 1 + (i % 2);
      for (let n = 0; n < expected[day]; n++)
        await chatAt(embed, berlinInstant(day, 8 + n, 15), {
          conversation_id: `${day}-${n}`,
        });
    }
    expect(Object.values(expected).filter((value) => value === 0)).toHaveLength(
      10
    );

    const result = await summary(embed, {
      fromDay: "2026-09-13",
      toDay: "2026-10-12",
    });

    expect(result.statusCode).toBe(200);
    expect(result.body.success).toBe(true);
    expect(result.body.granularity).toBe("day");
    expect(result.body.buckets).toHaveLength(30);
    expect(result.body.buckets.map((bucket) => bucket.start)).toEqual(days);
    expect(
      Object.fromEntries(
        result.body.buckets.map((bucket) => [bucket.start, bucket.messages])
      )
    ).toEqual(expected);
    expect(
      result.body.buckets.filter((bucket) => bucket.messages === 0)
    ).toHaveLength(10);
    for (const bucket of result.body.buckets) {
      expect(bucket.end).toBe(bucket.start);
      expect(bucket.partial).toBe(false);
      // Jede Nachricht begann hier eine eigene Konversation.
      expect(bucket.conversations).toBe(bucket.messages);
    }
    const total = Object.values(expected).reduce((a, b) => a + b, 0);
    expect(result.body.totals).toEqual({
      messages: total,
      conversations: total,
      feedbackPositive: 0,
      feedbackNegative: 0,
    });
  });

  test("tage_mit_luecken: ein Zeitraum ganz ohne Zählwerte liefert die leeren Abschnitte und Summen 0", async () => {
    const workspace = await createWorkspace(db.client);
    const embed = await createEmbed(db.client, workspace);

    const result = await summary(embed, {
      fromDay: "2026-09-13",
      toDay: "2026-10-12",
    });

    expect(result.statusCode).toBe(200);
    expect(result.body.buckets).toHaveLength(30);
    expect(sum(result.body.buckets, "messages")).toBe(0);
    expect(result.body.totals).toEqual({
      messages: 0,
      conversations: 0,
      feedbackPositive: 0,
      feedbackNegative: 0,
    });
    expect(result.body.firstLedgerDay).toBeNull();
  });
});

// ============================================================================
// AK-2 — Kennzahl gleich Diagrammsumme
// ============================================================================
describe("summe_gleich_kennzahl (AK-2)", () => {
  // Zählwerte über gut drei Jahre, in jeder Körnung liegt ein Teil davon
  // außerhalb des abgefragten Zeitraums.
  const FIRST = "2023-06-01";
  const LAST = "2026-10-20";

  /** Erwartete Summen eines Zeitraums, unabhängig vom Server gerechnet. */
  function expectedTotals(cells, from, to, embedId) {
    const totals = {
      messages: 0,
      conversations: 0,
      feedbackPositive: 0,
      feedbackNegative: 0,
    };
    for (const cell of cells) {
      if (cell.embedId !== embedId || cell.day < from || cell.day > to)
        continue;
      totals.messages += cell.messages;
      totals.conversations += cell.conversationsStarted;
      totals.feedbackPositive += cell.feedbackPositive;
      totals.feedbackNegative += cell.feedbackNegative;
    }
    return totals;
  }

  test.each([
    ["hour", "2026-10-07", "2026-10-07", 24],
    ["day", "2026-09-13", "2026-10-12", 30],
    ["week", "2025-10-13", "2026-10-12", 53],
    ["month", "2023-10-09", "2026-10-12", 37],
  ])(
    "summe_gleich_kennzahl: %s (%s bis %s) - Summe der Abschnitte = totals, für Nachrichten und Konversationen",
    async (granularity, fromDay, toDay, bucketCount) => {
      const workspace = await createWorkspace(db.client);
      const embed = await createEmbed(db.client, workspace);
      const other = await createEmbed(db.client, workspace);

      // Je Tag bis zu drei Stunden mit Werten, fest aus dem Tag abgeleitet.
      const cells = [];
      for (const [i, day] of daysOf(FIRST, LAST).entries()) {
        if (i % 5 === 3) continue; // Lücken
        for (const hour of [0, 9 + (i % 7), 23]) {
          if ((i + hour) % 4 === 0) continue;
          cells.push({
            workspaceId: workspace.id,
            embedId: embed.id,
            day,
            hour,
            messages: 1 + ((i * 7 + hour) % 9),
            conversationsStarted: (i + hour) % 3,
            feedbackPositive: (i + hour) % 2,
            feedbackNegative: i % 11 === 0 ? 1 : 0,
          });
        }
        // Ein zweites Widget im selben Workspace zählt nie mit.
        cells.push({
          workspaceId: workspace.id,
          embedId: other.id,
          day,
          hour: 10,
          messages: 100,
          conversationsStarted: 50,
          feedbackPositive: 5,
          feedbackNegative: 5,
        });
      }
      // Workspace-Chats (embed_id 0) zählen ebenfalls nie mit.
      cells.push({
        workspaceId: workspace.id,
        embedId: 0,
        day: fromDay,
        hour: 10,
        messages: 1000,
        conversationsStarted: 0,
        feedbackPositive: 0,
        feedbackNegative: 0,
      });
      await MessageLedger.transaction({ source: "test" }, (tx) =>
        MessageLedger.addCells(tx, cells)
      );

      const result = await summary(embed, { fromDay, toDay });

      expect(result.statusCode).toBe(200);
      expect(result.body.granularity).toBe(granularity);
      expect(result.body.buckets).toHaveLength(bucketCount);

      const expected = expectedTotals(cells, fromDay, toDay, embed.id);
      expect(expected.messages).toBeGreaterThan(0);
      expect(expected.conversations).toBeGreaterThan(0);
      expect(result.body.totals).toEqual(expected);
      expect(sum(result.body.buckets, "messages")).toBe(
        result.body.totals.messages
      );
      expect(sum(result.body.buckets, "conversations")).toBe(
        result.body.totals.conversations
      );

      // Jeder Abschnitt nennt genau die Werte seiner Tage (bzw. seiner Stunde).
      for (const bucket of result.body.buckets) {
        const own = cells.filter(
          (cell) =>
            cell.embedId === embed.id &&
            cell.day >= bucket.start &&
            cell.day <= bucket.end &&
            (bucket.hour === undefined || cell.hour === bucket.hour)
        );
        expect([bucket.start, bucket.hour, bucket.messages]).toEqual([
          bucket.start,
          bucket.hour,
          own.reduce((total, cell) => total + cell.messages, 0),
        ]);
        expect([bucket.start, bucket.hour, bucket.conversations]).toEqual([
          bucket.start,
          bucket.hour,
          own.reduce((total, cell) => total + cell.conversationsStarted, 0),
        ]);
      }
    }
  );

  test("summe_gleich_kennzahl: Bewertungen stehen in totals in der Stunde der bewerteten Nachricht, nie je Abschnitt", async () => {
    const workspace = await createWorkspace(db.client);
    const embed = await createEmbed(db.client, workspace);
    const inside = await chatAt(embed, berlinInstant("2026-10-06", 23, 30), {
      session_id: "s-1",
    });
    const second = await chatAt(embed, berlinInstant("2026-10-06", 9, 0), {
      session_id: "s-2",
    });
    const outside = await chatAt(embed, berlinInstant("2026-10-07", 0, 30), {
      session_id: "s-3",
    });
    // Bewertet wird heute; gebucht wird auf die Stunde der Nachricht.
    for (const [chat, session, score] of [
      [inside, "s-1", true],
      [second, "s-2", false],
      [outside, "s-3", true],
    ])
      expect(
        await EmbedChats.updateFeedbackScore(embed.id, session, chat.id, score)
      ).toBeTruthy();

    const result = await summary(embed, {
      fromDay: "2026-10-06",
      toDay: "2026-10-06",
    });

    expect(result.body.totals).toEqual({
      messages: 2,
      conversations: 2,
      feedbackPositive: 1,
      feedbackNegative: 1,
    });
    for (const bucket of result.body.buckets)
      expect(Object.keys(bucket).sort()).toEqual([
        "conversations",
        "end",
        "hour",
        "messages",
        "partial",
        "start",
      ]);
  });
});

// ============================================================================
// AK-3 — Körnung nach Zeitraumlänge
// ============================================================================
describe("koernung (AK-3)", () => {
  // 644 Tage sind 92 Wochen; als Kalenderwochen (Montag-Sonntag) gehen sie
  // auf, wenn der Zeitraum an einem Montag beginnt (06.01.2025).
  test.each([
    [1, "2026-10-12", "hour"],
    [2, "2026-10-11", "day"],
    [92, "2026-07-13", "day"],
    [93, "2026-07-12", "week"],
    [365, "2025-10-13", "week"],
    [644, "2025-01-06", "week"],
    [645, "2025-01-06", "month"],
    [1100, "2023-10-09", "month"],
  ])("koernung: %i Tage ab %s → %s", async (days, fromDay, granularity) => {
    const workspace = await createWorkspace(db.client);
    const embed = await createEmbed(db.client, workspace);
    const toDay = addDays(fromDay, days - 1);
    await countsOnly(embed, [
      { day: fromDay, messages: 3, conversationsStarted: 1 },
      { day: toDay, messages: 4, conversationsStarted: 2 },
    ]);

    const result = await summary(embed, { fromDay, toDay });

    expect(result.statusCode).toBe(200);
    expect(result.body.granularity).toBe(granularity);
    expect(result.body.buckets.length).toBeLessThanOrEqual(
      granularity === "hour" ? 24 : 92
    );
    if (days === 1) expect(result.body.buckets).toHaveLength(24);
    if (days === 2 || days === 92)
      expect(result.body.buckets).toHaveLength(days);
    if (days === 644) expect(result.body.buckets).toHaveLength(92);

    // Erster und letzter Abschnitt enden am Zeitraum; nichts geht verloren.
    expect(result.body.buckets[0].start).toBe(fromDay);
    expect(result.body.buckets.at(-1).end).toBe(toDay);
    expect(result.body.totals).toMatchObject({ messages: 7, conversations: 3 });
    expect(sum(result.body.buckets, "messages")).toBe(7);
    expect(sum(result.body.buckets, "conversations")).toBe(3);
  });

  test("koernung: angeschnittene Kalenderwoche und angeschnittener Monat sind gekennzeichnet", async () => {
    const workspace = await createWorkspace(db.client);
    const embed = await createEmbed(db.client, workspace);

    // Mittwoch 01.07.2026 bis Montag 12.10.2026
    const weeks = await summary(embed, {
      fromDay: "2026-07-01",
      toDay: "2026-10-12",
    });
    expect(weeks.body.granularity).toBe("week");
    expect(weeks.body.buckets[0]).toMatchObject({
      start: "2026-07-01",
      end: "2026-07-05",
      partial: true,
    });
    expect(weeks.body.buckets[1]).toMatchObject({
      start: "2026-07-06",
      end: "2026-07-12",
      partial: false,
    });
    expect(weeks.body.buckets.at(-1)).toMatchObject({
      start: "2026-10-12",
      end: "2026-10-12",
      partial: true,
    });

    const months = await summary(embed, {
      fromDay: "2023-10-09",
      toDay: "2026-10-12",
    });
    expect(months.body.granularity).toBe("month");
    expect(months.body.buckets[0]).toMatchObject({
      start: "2023-10-09",
      end: "2023-10-31",
      partial: true,
    });
    expect(months.body.buckets[1]).toMatchObject({
      start: "2023-11-01",
      end: "2023-11-30",
      partial: false,
    });
    expect(months.body.buckets.at(-1)).toMatchObject({
      start: "2026-10-01",
      end: "2026-10-12",
      partial: true,
    });
  });
});

// ============================================================================
// AK-4 — Statistik überlebt die Löschung
// ============================================================================
describe("nach_loeschung (AK-4)", () => {
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

  test("nach_loeschung: Frist 30 Tage, 25 Nachrichten vor 45 Tagen gelöscht - der Tag nennt 25, die Liste zeigt für ihn keine Konversation", async () => {
    const workspace = await createWorkspace(db.client);
    const embed = await createEmbed(db.client, workspace, {
      chat_retention_days: 30,
      retention_started_at: new Date(Date.now() - 90 * DAY),
    });

    // 25 Nachrichten in 5 Konversationen vor 45 Tagen, 3 Nachrichten gestern.
    const oldInstant = new Date(Date.now() - 45 * DAY);
    const oldDay = berlinCell(oldInstant).day;
    for (let i = 0; i < 25; i++)
      await chatAt(embed, berlinInstant(oldDay, 8 + (i % 5), i), {
        session_id: `alt-${i % 5}`,
        conversation_id: `alt-${i % 5}`,
        prompt: `Alte Frage ${i}`,
      });
    const recentInstant = new Date(Date.now() - 1 * DAY);
    const recentDay = berlinCell(recentInstant).day;
    for (let i = 0; i < 3; i++)
      await chatAt(embed, recentInstant, {
        session_id: "neu",
        conversation_id: "neu",
        prompt: `Neue Frage ${i}`,
      });
    const fromDay = berlinCell(new Date(Date.now() - 59 * DAY)).day;
    const toDay = berlinCell(new Date()).day;
    const range = {
      startDate: new Date(Date.now() - 60 * DAY).toISOString(),
      endDate: new Date().toISOString(),
    };

    // Vor der Löschung: Statistik und Liste nennen dasselbe.
    const before = await summary(embed, { fromDay, toDay });
    expect(before.body.totals).toMatchObject({
      messages: 28,
      conversations: 6,
    });
    expect((await conversations(embed, range)).body.totalCount).toBe(6);

    await runCleanupJob();
    expect(await db.client.embed_chats.count()).toBe(3);

    const after = await summary(embed, { fromDay, toDay });
    expect(after.statusCode).toBe(200);
    expect(after.body.granularity).toBe("day");
    expect(
      after.body.buckets.find((bucket) => bucket.start === oldDay)
    ).toMatchObject({ messages: 25, conversations: 5 });
    expect(
      after.body.buckets.find((bucket) => bucket.start === recentDay)
    ).toMatchObject({ messages: 3, conversations: 1 });
    expect(after.body.totals).toEqual(before.body.totals);
    expect(after.body.firstLedgerDay).toBe(oldDay);

    // Der Tag allein, in Stunden: weiterhin 25.
    const dayOnly = await summary(embed, { fromDay: oldDay, toDay: oldDay });
    expect(dayOnly.body.granularity).toBe("hour");
    expect(dayOnly.body.totals.messages).toBe(25);

    // Die Liste liest embed_chats: Für den gelöschten Tag zeigt sie nichts.
    const list = await conversations(embed, range);
    expect(list.body.totalCount).toBe(1);
    expect(list.body.conversations.map((c) => c.conversation_id)).toEqual([
      "neu",
    ]);
    const filtered = await conversations(embed, {
      ...range,
      startedFromDay: oldDay,
      startedToDay: oldDay,
    });
    expect(filtered.statusCode).toBe(200);
    expect(filtered.body.conversations).toEqual([]);
    expect(filtered.body.totalCount).toBe(0);
  });

  test("nach_loeschung: „Chats löschen“ und das Löschen des Widgets ändern die Zählwerte nicht", async () => {
    const workspace = await createWorkspace(db.client);
    const embed = await createEmbed(db.client, workspace);
    for (let i = 0; i < 4; i++)
      await chatAt(embed, berlinInstant("2026-10-06", 10, i), {
        session_id: `s-${i % 2}`,
      });
    const body = { fromDay: "2026-10-01", toDay: "2026-10-12" };
    const before = await summary(embed, body);
    expect(before.body.totals).toMatchObject({ messages: 4, conversations: 2 });

    await EmbedChats.delete({ embed_id: embed.id });
    expect(await db.client.embed_chats.count()).toBe(0);

    const after = await summary(embed, body);
    expect(after.body).toEqual(before.body);
  });
});

// ============================================================================
// AK-9 — Einzelner Tag
// ============================================================================
describe("stunden (AK-9)", () => {
  test("stunden: ein einzelner Tag liefert 24 Stunden-Abschnitte in Berliner Zeit", async () => {
    const workspace = await createWorkspace(db.client);
    const embed = await createEmbed(db.client, workspace);
    const day = "2026-10-06";
    const perHour = { 0: 1, 7: 2, 13: 4, 23: 1 };
    for (const [hour, count] of Object.entries(perHour))
      for (let i = 0; i < count; i++)
        await chatAt(embed, berlinInstant(day, Number(hour), 5 + i), {
          session_id: `s-${hour}`,
        });

    const result = await summary(embed, { fromDay: day, toDay: day });

    expect(result.statusCode).toBe(200);
    expect(result.body.granularity).toBe("hour");
    expect(result.body.buckets).toHaveLength(24);
    expect(result.body.buckets.map((bucket) => bucket.hour)).toEqual(
      Array.from({ length: 24 }, (_, hour) => hour)
    );
    for (const bucket of result.body.buckets) {
      expect(bucket.start).toBe(day);
      expect(bucket.end).toBe(day);
      expect(bucket.partial).toBe(false);
      expect(bucket.messages).toBe(perHour[bucket.hour] ?? 0);
      // Je Stunde eine Sitzung: eine begonnene Konversation.
      expect(bucket.conversations).toBe(perHour[bucket.hour] ? 1 : 0);
    }
    expect(result.body.totals).toMatchObject({ messages: 8, conversations: 4 });
  });

  test("stunden: Tage der Zeitumstellung haben ebenfalls 24 Abschnitte, keine Nachricht geht verloren", async () => {
    const workspace = await createWorkspace(db.client);
    const embed = await createEmbed(db.client, workspace);
    // 29.03.2026: Die Stunde 2 gibt es nicht. 25.10.2026: Die Stunde 2 gibt
    // es zweimal, beide Durchläufe stehen in derselben Zeile.
    await chatAt(embed, new Date("2026-03-29T00:30:00Z")); // 01:30 Berlin
    await chatAt(embed, new Date("2026-03-29T01:30:00Z")); // 03:30 Berlin
    await chatAt(embed, new Date("2026-10-25T00:30:00Z")); // 02:30 Berlin (Sommerzeit)
    await chatAt(embed, new Date("2026-10-25T01:30:00Z")); // 02:30 Berlin (Winterzeit)

    const spring = await summary(embed, {
      fromDay: "2026-03-29",
      toDay: "2026-03-29",
    });
    expect(spring.body.buckets).toHaveLength(24);
    expect(
      spring.body.buckets.filter((b) => b.messages > 0).map((b) => b.hour)
    ).toEqual([1, 3]);
    expect(spring.body.totals.messages).toBe(2);

    const autumn = await summary(embed, {
      fromDay: "2026-10-25",
      toDay: "2026-10-25",
    });
    expect(autumn.body.buckets).toHaveLength(24);
    expect(autumn.body.buckets[2].messages).toBe(2);
    expect(autumn.body.totals.messages).toBe(2);
  });
});

// ============================================================================
// AK-14 — Beginn der Zählung
// ============================================================================
describe("beginn_der_zaehlung (AK-14)", () => {
  test("beginn_der_zaehlung: firstLedgerDay ist der früheste Tag mit Zählwerten dieses Widgets - unabhängig vom Zeitraum", async () => {
    const workspace = await createWorkspace(db.client);
    const embed = await createEmbed(db.client, workspace);
    const other = await createEmbed(db.client, workspace);
    await countsOnly(other, [{ day: "2025-01-15", messages: 9 }]);
    await countsOnly(embed, [
      { day: "2026-08-03", messages: 2, conversationsStarted: 1 },
      { day: "2026-09-20", messages: 5, conversationsStarted: 2 },
    ]);
    // Workspace-Chats (embed_id 0) sind keine Zählwerte eines Widgets.
    await MessageLedger.transaction({ source: "test" }, (tx) =>
      MessageLedger.addCells(tx, [
        {
          workspaceId: workspace.id,
          embedId: 0,
          day: "2024-05-01",
          hour: 9,
          messages: 7,
        },
      ])
    );

    // Der Zeitraum beginnt vor dem ersten Zählwert …
    const early = await summary(embed, {
      fromDay: "2026-07-01",
      toDay: "2026-07-31",
    });
    expect(early.body.firstLedgerDay).toBe("2026-08-03");
    expect(early.body.totals.messages).toBe(0);
    // … umfasst ihn …
    const around = await summary(embed, {
      fromDay: "2026-07-01",
      toDay: "2026-09-30",
    });
    expect(around.body.firstLedgerDay).toBe("2026-08-03");
    expect(around.body.totals.messages).toBe(7);
    // … oder liegt danach.
    const late = await summary(embed, {
      fromDay: "2026-10-01",
      toDay: "2026-10-12",
    });
    expect(late.body.firstLedgerDay).toBe("2026-08-03");

    expect(
      (await summary(other, { fromDay: "2026-10-01", toDay: "2026-10-12" }))
        .body.firstLedgerDay
    ).toBe("2025-01-15");
  });

  test("beginn_der_zaehlung: ohne Zählwerte null; Zeilen ohne Zählwert zählen nicht als Beginn", async () => {
    const workspace = await createWorkspace(db.client);
    const embed = await createEmbed(db.client, workspace);
    const body = { fromDay: "2026-10-01", toDay: "2026-10-12" };
    expect((await summary(embed, body)).body.firstLedgerDay).toBeNull();

    // Eine Zeile, deren Stand wieder bei 0 liegt (Bewertung zurückgenommen).
    await countsOnly(embed, [{ day: "2026-01-10", messages: 0 }]);
    expect((await summary(embed, body)).body.firstLedgerDay).toBeNull();

    await countsOnly(embed, [{ day: "2026-03-10", feedbackNegative: 1 }]);
    expect((await summary(embed, body)).body.firstLedgerDay).toBe("2026-03-10");
  });

  test("beginn_der_zaehlung: Ein umgehängtes Widget behält seine Zählwerte aus dem früheren Workspace", async () => {
    const workspaceA = await createWorkspace(db.client);
    const workspaceB = await createWorkspace(db.client);
    const embed = await createEmbed(db.client, workspaceA);
    await chatAt(embed, berlinInstant("2026-09-01", 10), { session_id: "a" });
    await chatAt(embed, berlinInstant("2026-09-01", 11), { session_id: "a" });

    expect(
      (await EmbedConfig.update(embed.id, { workspace_id: workspaceB.id }))
        .success
    ).toBe(true);
    await chatAt(embed, berlinInstant("2026-09-02", 10), { session_id: "b" });

    // Das Zählerbuch führt die Zeilen unter dem Workspace beim Schreiben …
    expect(
      (
        await db.client.message_ledger.findMany({ orderBy: { day: "asc" } })
      ).map((row) => [row.workspace_id, row.embed_id, row.day, row.messages])
    ).toEqual([
      [workspaceA.id, embed.id, "2026-09-01", 1],
      [workspaceA.id, embed.id, "2026-09-01", 1],
      [workspaceB.id, embed.id, "2026-09-02", 1],
    ]);

    // … die Auswertung des Widgets zählt sie alle.
    const result = await summary(embed, {
      fromDay: "2026-09-01",
      toDay: "2026-09-30",
    });
    expect(result.body.totals).toMatchObject({ messages: 3, conversations: 2 });
    expect(result.body.firstLedgerDay).toBe("2026-09-01");
    expect(result.body.buckets.slice(0, 2).map((b) => b.messages)).toEqual([
      2, 1,
    ]);
  });
});

// ============================================================================
// Lesefunktionen des Zählerbuchs
// ============================================================================
describe("Lesefunktionen (MessageLedger.timelineForEmbed, firstDayForEmbed)", () => {
  const { tableChecksum } = require("../helpers/sqliteTestDatabase");

  test("lesen nur: Das Zählerbuch ist nach den Abfragen Byte für Byte dasselbe", async () => {
    const workspace = await createWorkspace(db.client);
    const embed = await createEmbed(db.client, workspace);
    await chatAt(embed, berlinInstant("2026-10-06", 10));
    await countsOnly(embed, [
      { day: "2026-09-01", messages: 5, conversationsStarted: 2 },
    ]);
    const before = await tableChecksum(db.client, "message_ledger");
    expect(before.rows).toBe(2);

    for (const body of [
      { fromDay: "2026-10-06", toDay: "2026-10-06" },
      { fromDay: "2026-09-01", toDay: "2026-10-12" },
      { fromDay: "2025-10-13", toDay: "2026-10-12" },
      { fromDay: "2016-10-13", toDay: "2026-10-12" },
    ])
      expect((await summary(embed, body)).statusCode).toBe(200);

    expect(await tableChecksum(db.client, "message_ledger")).toEqual(before);
  });

  test("embed_id 0 (Workspace-Chats) und Unsinn als Kennung werfen, statt fremde Zähler zu liefern", async () => {
    const workspace = await createWorkspace(db.client);
    await MessageLedger.transaction({ source: "test" }, (tx) =>
      MessageLedger.addCells(tx, [
        {
          workspaceId: workspace.id,
          embedId: 0,
          day: "2026-10-06",
          hour: 9,
          messages: 777,
        },
      ])
    );
    for (const embedId of [0, -1, 1.5, "abc", null, undefined, NaN]) {
      await expect(
        MessageLedger.timelineForEmbed(embedId, "2026-10-01", "2026-10-12")
      ).rejects.toThrow(/invalid embedId/);
      await expect(MessageLedger.firstDayForEmbed(embedId)).rejects.toThrow(
        /invalid embedId/
      );
    }
  });

  test("ein ungültiger Zeitraum wirft vor der Abfrage", async () => {
    const workspace = await createWorkspace(db.client);
    const embed = await createEmbed(db.client, workspace);
    const groupBy = jest.spyOn(db.client.message_ledger, "groupBy");
    for (const [fromDay, toDay] of [
      ["2026-10-07", "2026-10-06"],
      ["2026-02-30", "2026-03-05"],
      ["2016-10-12", "2026-10-12"],
      [undefined, undefined],
    ])
      await expect(
        MessageLedger.timelineForEmbed(embed.id, fromDay, toDay)
      ).rejects.toThrow(/timelineLayout/);
    expect(groupBy).not.toHaveBeenCalled();
  });

  test("ein Datenbankfehler wird weitergereicht; der Endpunkt antwortet mit 500 ohne Zahlen", async () => {
    const workspace = await createWorkspace(db.client);
    const embed = await createEmbed(db.client, workspace);
    await countsOnly(embed, [{ day: "2026-10-06", messages: 3 }]);
    jest
      .spyOn(db.client.message_ledger, "groupBy")
      .mockRejectedValue(new Error("database is locked"));

    await expect(
      MessageLedger.timelineForEmbed(embed.id, "2026-10-01", "2026-10-12")
    ).rejects.toThrow("database is locked");
    const result = await summary(embed, {
      fromDay: "2026-10-01",
      toDay: "2026-10-12",
    });
    expect(result.statusCode).toBe(500);
    expect(result.body).toBeUndefined();
  });
});

// ============================================================================
// NAK-1 — Keine fremden Zahlen
// ============================================================================
describe("fremdes_widget (NAK-1)", () => {
  let workspaceA, workspaceB, embedA, embedB;
  const body = { fromDay: "2026-10-01", toDay: "2026-10-12" };

  beforeEach(async () => {
    await setMultiUserMode(true);
    workspaceA = await createWorkspace(db.client);
    workspaceB = await createWorkspace(db.client);
    embedA = await createEmbed(db.client, workspaceA);
    embedB = await createEmbed(db.client, workspaceB);
    await countsOnly(embedA, [{ day: "2026-10-06", messages: 3 }]);
    await countsOnly(embedB, [
      { day: "2026-10-06", messages: 40, conversationsStarted: 12 },
    ]);
  });

  test("fremdes_widget: default aus Workspace A erhält für ein Widget aus Workspace B 403 und keine Zahlen", async () => {
    const kunde = await createUser("default", [workspaceA.id]);

    const result = await summary(embedB, body, kunde);

    expect(result.statusCode).toBe(403);
    expect(result.body).toBeUndefined();
    expect(timelineSpy).not.toHaveBeenCalled();
    expect(firstDaySpy).not.toHaveBeenCalled();
  });

  test("fremdes_widget: dieselbe Ablehnung wie overview und die Konversationsliste", async () => {
    const kunde = await createUser("default", [workspaceA.id]);
    const request = {
      params: { embedId: String(embedB.id) },
      body,
      token: kunde.token,
    };
    for (const route of [SUMMARY, OVERVIEW, CONVERSATIONS])
      expect((await invoke(route, request)).statusCode).toBe(403);
  });

  test("fremdes_widget: ein unbekanntes Widget ist für default von einem fremden nicht zu unterscheiden (403)", async () => {
    const kunde = await createUser("default", [workspaceA.id]);
    for (const embedId of [9999, 0, -1, "abc", "1 OR 1=1"]) {
      const result = await summary(embedId, body, kunde);
      expect([embedId, result.statusCode]).toEqual([embedId, 403]);
      expect(result.body).toBeUndefined();
    }
    expect(timelineSpy).not.toHaveBeenCalled();
  });

  test("fremdes_widget: default ohne Mitgliedschaft in irgendeinem Workspace: 403", async () => {
    const kunde = await createUser("default", []);
    for (const embed of [embedA, embedB])
      expect((await summary(embed, body, kunde)).statusCode).toBe(403);
    expect(timelineSpy).not.toHaveBeenCalled();
  });

  test("fremdes_widget: das eigene Widget liefert nur dessen Zahlen", async () => {
    const kunde = await createUser("default", [workspaceA.id]);

    const result = await summary(embedA, body, kunde);

    expect(result.statusCode).toBe(200);
    expect(result.body.totals).toEqual({
      messages: 3,
      conversations: 0,
      feedbackPositive: 0,
      feedbackNegative: 0,
    });
  });

  test("fremdes_widget: Nach dem Umhängen entscheidet der heutige Workspace des Widgets", async () => {
    const kundeA = await createUser("default", [workspaceA.id]);
    const kundeB = await createUser("default", [workspaceB.id]);
    await EmbedConfig.update(embedB.id, { workspace_id: workspaceA.id });

    expect((await summary(embedB, body, kundeB)).statusCode).toBe(403);
    const result = await summary(embedB, body, kundeA);
    expect(result.statusCode).toBe(200);
    expect(result.body.totals.messages).toBe(40);
  });

  test("fremdes_widget: admin und manager sind nicht eingeschränkt", async () => {
    for (const role of ["admin", "manager"]) {
      const user = await createUser(role);
      const result = await summary(embedB, body, user);
      expect([role, result.statusCode]).toEqual([role, 200]);
      expect(result.body.totals.messages).toBe(40);
    }
  });

  test("fremdes_widget: ohne Anmeldung 401, gesperrter Nutzer 401", async () => {
    expect((await summary(embedA, body)).statusCode).toBe(401);
    expect(
      (await summary(embedA, body, { token: "kein.gültiges.token" })).statusCode
    ).toBe(401);

    const kunde = await createUser("default", [workspaceA.id]);
    await db.client.users.update({
      where: { id: kunde.id },
      data: { suspended: 1 },
    });
    expect((await summary(embedA, body, kunde)).statusCode).toBe(401);
    expect(timelineSpy).not.toHaveBeenCalled();
  });

  test("fremdes_widget: unbekanntes Widget, embed_id 0 und Unsinn als Kennung: 404 für admin - nie die Zähler der Workspace-Chats", async () => {
    const admin = await createUser("admin");
    await MessageLedger.transaction({ source: "test" }, (tx) =>
      MessageLedger.addCells(tx, [
        {
          workspaceId: workspaceA.id,
          embedId: 0,
          day: "2026-10-06",
          hour: 9,
          messages: 777,
        },
      ])
    );
    for (const embedId of [9999, 0, -1, "abc", "1.5"]) {
      const result = await summary(embedId, body, admin);
      expect([embedId, result.statusCode]).toEqual([embedId, 404]);
      expect(result.body).toBeUndefined();
    }
    expect(timelineSpy).not.toHaveBeenCalled();
  });

  test("fremdes_widget: ohne Mehrbenutzermodus wird nicht geprüft (kein Nutzerobjekt)", async () => {
    await setMultiUserMode(false);
    const result = await summary(embedB, body);
    expect(result.statusCode).toBe(200);
    expect(result.body.totals.messages).toBe(40);
  });
});

// ============================================================================
// NAK-2 — Kein Zugriff bei abgeschaltetem Chat-Verlauf
// ============================================================================
describe("verlauf_aus (NAK-2)", () => {
  test("verlauf_aus: DISABLE_VIEW_CHAT_HISTORY - 422 ohne Daten für jede Rolle, wie die Konversationsliste", async () => {
    await setMultiUserMode(true);
    const workspace = await createWorkspace(db.client);
    const embed = await createEmbed(db.client, workspace);
    await countsOnly(embed, [{ day: "2026-10-06", messages: 3 }]);
    const users = [
      await createUser("admin"),
      await createUser("manager"),
      await createUser("default", [workspace.id]),
    ];
    const body = { fromDay: "2026-10-01", toDay: "2026-10-12" };

    process.env.DISABLE_VIEW_CHAT_HISTORY = "1";
    for (const user of users) {
      const result = await summary(embed, body, user);
      const list = await conversations(embed, {}, user);
      expect([user.role, result.statusCode]).toEqual([user.role, 422]);
      expect(result.body).toBe(list.body);
      expect(typeof result.body).toBe("string");
      expect(result.body).not.toMatch(/\d/);
    }
    expect(timelineSpy).not.toHaveBeenCalled();
    expect(firstDaySpy).not.toHaveBeenCalled();

    // Wieder eingeschaltet: Die Zahlen sind da.
    delete process.env.DISABLE_VIEW_CHAT_HISTORY;
    expect((await summary(embed, body, users[2])).body.totals.messages).toBe(3);
  });

  test("verlauf_aus: ohne Mehrbenutzermodus ebenso, auch mit leerem Wert der Variable", async () => {
    const workspace = await createWorkspace(db.client);
    const embed = await createEmbed(db.client, workspace);
    await countsOnly(embed, [{ day: "2026-10-06", messages: 3 }]);

    process.env.DISABLE_VIEW_CHAT_HISTORY = "";
    const result = await summary(embed, {
      fromDay: "2026-10-01",
      toDay: "2026-10-12",
    });

    expect(result.statusCode).toBe(422);
    expect(timelineSpy).not.toHaveBeenCalled();
  });
});

// ============================================================================
// NAK-3 — Keine Inhalte im Endpunkt
// ============================================================================
describe("nur_zahlen (NAK-3)", () => {
  test("nur_zahlen: Die Antwort enthält nur Zählwerte und Kalendertage - keine Texte, keine Sitzungs- oder Verbindungsdaten", async () => {
    const workspace = await createWorkspace(db.client, {
      name: "Geheimer-Workspace",
    });
    const embed = await createEmbed(db.client, workspace);
    const secrets = {
      prompt: "GEHEIME-FRAGE Wann ist mein Arzttermin?",
      response: JSON.stringify({ text: "GEHEIME-ANTWORT Am Dienstag." }),
      session_id: "GEHEIME-SITZUNG-4711",
      conversation_id: "GEHEIME-KONVERSATION-0815",
      connection_information: JSON.stringify({
        host: "https://geheim.example",
        ip: "203.0.113.77",
      }),
      feedbackText: "GEHEIMER-KOMMENTAR",
      feedbackReason: "GEHEIMER-GRUND",
    };
    const chat = await chatAt(embed, berlinInstant("2026-10-06", 10), secrets);
    await EmbedChats.updateFeedbackScore(
      embed.id,
      secrets.session_id,
      chat.id,
      false
    );

    for (const body of [
      { fromDay: "2026-10-06", toDay: "2026-10-06" },
      { fromDay: "2026-10-01", toDay: "2026-10-12" },
      { fromDay: "2025-10-13", toDay: "2026-10-12" },
      { fromDay: "2023-10-09", toDay: "2026-10-12" },
    ]) {
      const result = await summary(embed, body);
      expect(result.statusCode).toBe(200);
      expect(result.body.totals).toEqual({
        messages: 1,
        conversations: 1,
        feedbackPositive: 0,
        feedbackNegative: 1,
      });

      // Genau diese Felder, sonst nichts.
      expect(Object.keys(result.body).sort()).toEqual([
        "buckets",
        "firstLedgerDay",
        "fromDay",
        "granularity",
        "success",
        "toDay",
        "totals",
      ]);
      for (const bucket of result.body.buckets) {
        const { start, end, partial, messages, conversations, hour, ...rest } =
          bucket;
        expect(rest).toEqual({});
        expect(start).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(end).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(typeof partial).toBe("boolean");
        expect(Number.isInteger(messages)).toBe(true);
        expect(Number.isInteger(conversations)).toBe(true);
        if (hour !== undefined) expect(Number.isInteger(hour)).toBe(true);
      }
      for (const value of Object.values(result.body.totals))
        expect(Number.isInteger(value)).toBe(true);

      const text = JSON.stringify(result.body);
      expect(text).not.toMatch(/GEHEIM/i);
      expect(text).not.toContain("203.0.113.77");
      expect(text).not.toContain("Arzttermin");
      expect(text).not.toMatch(/session|conversation_id|prompt|response|ip"/i);
    }
  });
});

// ============================================================================
// NAK-4 — Kein Tagesversatz
// ============================================================================
describe("kein_tagesversatz (NAK-4)", () => {
  test("kein_tagesversatz: 06.10. zählt nur 00:30 und 23:30 Berliner Zeit, nicht 05.10. 23:30 und nicht 07.10. 00:30", async () => {
    const workspace = await createWorkspace(db.client);
    const embed = await createEmbed(db.client, workspace);
    // Sommerzeit: Berlin = UTC + 2
    const instants = [
      new Date("2026-10-05T21:30:00Z"), // 05.10. 23:30
      new Date("2026-10-05T22:30:00Z"), // 06.10. 00:30
      new Date("2026-10-06T21:30:00Z"), // 06.10. 23:30
      new Date("2026-10-06T22:30:00Z"), // 07.10. 00:30
    ];
    expect(instants).toEqual([
      berlinInstant("2026-10-05", 23, 30),
      berlinInstant("2026-10-06", 0, 30),
      berlinInstant("2026-10-06", 23, 30),
      berlinInstant("2026-10-07", 0, 30),
    ]);
    for (const [i, instant] of instants.entries())
      await chatAt(embed, instant, { session_id: `s-${i}` });

    const result = await summary(embed, {
      fromDay: "2026-10-06",
      toDay: "2026-10-06",
    });

    expect(result.statusCode).toBe(200);
    expect(result.body.totals).toMatchObject({ messages: 2, conversations: 2 });
    expect(
      result.body.buckets.filter((b) => b.messages > 0).map((b) => b.hour)
    ).toEqual([0, 23]);

    // Die Nachbartage nennen je genau ihre eine Nachricht.
    const days = await summary(embed, {
      fromDay: "2026-10-05",
      toDay: "2026-10-07",
    });
    expect(days.body.buckets.map((b) => [b.start, b.messages])).toEqual([
      ["2026-10-05", 1],
      ["2026-10-06", 2],
      ["2026-10-07", 1],
    ]);
  });

  test("kein_tagesversatz: Winterzeit (Berlin = UTC + 1) und Jahreswechsel", async () => {
    const workspace = await createWorkspace(db.client);
    const embed = await createEmbed(db.client, workspace);
    for (const [i, instant] of [
      new Date("2025-12-31T22:30:00Z"), // 31.12. 23:30
      new Date("2025-12-31T23:30:00Z"), // 01.01. 00:30
      new Date("2026-01-01T22:30:00Z"), // 01.01. 23:30
      new Date("2026-01-01T23:30:00Z"), // 02.01. 00:30
    ].entries())
      await chatAt(embed, instant, { session_id: `s-${i}` });

    const result = await summary(embed, {
      fromDay: "2026-01-01",
      toDay: "2026-01-01",
    });

    expect(result.body.totals.messages).toBe(2);
    expect(
      result.body.buckets.filter((b) => b.messages > 0).map((b) => b.hour)
    ).toEqual([0, 23]);
  });

  test("kein_tagesversatz: Der Abschnitts-Filter der Liste hat dieselben Berliner Tagesgrenzen", async () => {
    const workspace = await createWorkspace(db.client);
    const embed = await createEmbed(db.client, workspace);
    for (const [name, instant] of [
      ["vortag", berlinInstant("2026-10-05", 23, 30)],
      ["frueh", berlinInstant("2026-10-06", 0, 30)],
      ["spaet", berlinInstant("2026-10-06", 23, 30)],
      ["folgetag", berlinInstant("2026-10-07", 0, 30)],
    ])
      await chatAt(embed, instant, {
        session_id: name,
        conversation_id: name,
      });

    const list = await conversations(embed, {
      startedFromDay: "2026-10-06",
      startedToDay: "2026-10-06",
    });

    expect(list.statusCode).toBe(200);
    expect(list.body.totalCount).toBe(2);
    expect(
      list.body.conversations.map((c) => c.conversation_id).sort()
    ).toEqual(["frueh", "spaet"]);
  });
});

// ============================================================================
// NAK-6 — Ungültige Eingaben
// ============================================================================
describe("eingaben (NAK-6)", () => {
  let embed;
  beforeEach(async () => {
    const workspace = await createWorkspace(db.client);
    embed = await createEmbed(db.client, workspace);
    await countsOnly(embed, [{ day: "2026-10-06", messages: 3 }]);
  });

  test.each([
    ["fromDay nach toDay", { fromDay: "2026-10-07", toDay: "2026-10-06" }],
    ["30. Februar", { fromDay: "2026-02-30", toDay: "2026-03-05" }],
    [
      "29. Februar ohne Schaltjahr",
      { fromDay: "2026-02-29", toDay: "2026-03-05" },
    ],
    ["13. Monat", { fromDay: "2026-10-01", toDay: "2026-13-01" }],
    ["Tag 0", { fromDay: "2026-10-00", toDay: "2026-10-06" }],
    ["deutsche Schreibweise", { fromDay: "06.10.2026", toDay: "12.10.2026" }],
    ["ohne führende Null", { fromDay: "2026-10-6", toDay: "2026-10-12" }],
    [
      "Zeitstempel statt Kalendertag",
      {
        fromDay: "2026-10-06T00:00:00.000Z",
        toDay: "2026-10-12T21:59:59.999Z",
      },
    ],
    ["Zahl", { fromDay: 20261006, toDay: 20261012 }],
    ["Liste", { fromDay: ["2026-10-06"], toDay: ["2026-10-12"] }],
    ["Objekt", { fromDay: { gte: "2026-10-06" }, toDay: "2026-10-12" }],
    ["leere Zeichenkette", { fromDay: "", toDay: "" }],
    ["null", { fromDay: null, toDay: null }],
    ["toDay fehlt", { fromDay: "2026-10-06" }],
    ["fromDay fehlt", { toDay: "2026-10-06" }],
    ["leerer Rumpf", {}],
    [
      "alte Feldnamen der Liste",
      {
        startDate: "2026-10-06T00:00:00.000Z",
        endDate: "2026-10-12T21:59:59.999Z",
      },
    ],
    ["SQL im Wert", { fromDay: "2026-10-06' OR '1'='1", toDay: "2026-10-12" }],
    [
      "mehr als 10 Jahre (10 Jahre und 1 Tag)",
      { fromDay: "2016-10-12", toDay: "2026-10-12" },
    ],
    [
      "mehr als 10 Jahre (Jahrzehnte)",
      { fromDay: "1990-01-01", toDay: "2026-10-12" },
    ],
  ])(
    "eingaben: %s → 400, das Zählerbuch wird nicht gelesen",
    async (_name, body) => {
      const groupBy = jest.spyOn(db.client.message_ledger, "groupBy");
      const findFirst = jest.spyOn(db.client.message_ledger, "findFirst");

      const result = await summary(embed, body);

      expect(result.statusCode).toBe(400);
      expect(result.body).toEqual({
        success: false,
        error: expect.any(String),
      });
      expect(timelineSpy).not.toHaveBeenCalled();
      expect(firstDaySpy).not.toHaveBeenCalled();
      expect(groupBy).not.toHaveBeenCalled();
      expect(findFirst).not.toHaveBeenCalled();
    }
  );

  test("eingaben: ohne Rumpf 400", async () => {
    const result = await invoke(SUMMARY, {
      params: { embedId: String(embed.id) },
      body: undefined,
    });
    expect(result.statusCode).toBe(400);
    expect(timelineSpy).not.toHaveBeenCalled();
  });

  test("eingaben: genau 10 Jahre und ein einzelner Tag sind gültig", async () => {
    // Gegenprobe zu den Spionen oben: Ein gültiger Aufruf liest das Zählerbuch.
    const groupBy = jest.spyOn(db.client.message_ledger, "groupBy");
    const findFirst = jest.spyOn(db.client.message_ledger, "findFirst");

    const decade = await summary(embed, {
      fromDay: "2016-10-13",
      toDay: "2026-10-12",
    });
    expect(decade.statusCode).toBe(200);
    expect(groupBy).toHaveBeenCalledTimes(1);
    expect(findFirst).toHaveBeenCalledTimes(1);
    expect(timelineSpy).toHaveBeenCalledTimes(1);
    expect(decade.body.granularity).toBe("month");
    expect(decade.body.totals.messages).toBe(3);

    const day = await summary(embed, {
      fromDay: "2026-10-06",
      toDay: "2026-10-06",
    });
    expect(day.statusCode).toBe(200);
    expect(day.body.totals.messages).toBe(3);
  });

  test("eingaben: Die Rechteprüfung kommt vor der Eingabeprüfung (403 statt 400 für ein fremdes Widget)", async () => {
    await setMultiUserMode(true);
    const kunde = await createUser("default", []);
    const result = await summary(
      embed,
      { fromDay: "2026-10-07", toDay: "2026-10-06" },
      kunde
    );
    expect(result.statusCode).toBe(403);
  });

  test("eingaben: Abschnitts-Filter der Liste - Tage am Rand des Kalenders ergeben Grenzen statt eines Fehlers", async () => {
    for (const body of [
      { startedFromDay: "9998-12-31", startedToDay: "9998-12-31" },
      { startedFromDay: "0001-01-01", startedToDay: "0001-01-01" },
    ]) {
      const result = await conversations(embed, body);
      expect([body, result.statusCode]).toEqual([body, 200]);
      expect(result.body).toMatchObject({ conversations: [], totalCount: 0 });
    }
  });

  test("eingaben: Abschnitts-Filter der Liste - ungültige Kalendertage → 400 ohne Abfrage der Konversationen", async () => {
    const listSpy = jest.spyOn(EmbedChats, "getConversations");
    const countSpy = jest.spyOn(EmbedChats, "countConversations");
    for (const body of [
      { startedFromDay: "2026-10-07", startedToDay: "2026-10-06" },
      { startedFromDay: "2026-02-30", startedToDay: "2026-03-05" },
      { startedFromDay: "2026-10-06" },
      { startedToDay: "2026-10-06" },
      { startedFromDay: "", startedToDay: "" },
      { startedFromDay: 20261006, startedToDay: 20261006 },
      { startedFromDay: "2026-10-06' OR '1'='1", startedToDay: "2026-10-06" },
      { startedFromDay: "9999-12-31", startedToDay: "9999-12-31" },
      { startedFromDay: "0000-01-01", startedToDay: "0000-01-02" },
    ]) {
      const result = await conversations(embed, body);
      expect([body, result.statusCode]).toEqual([body, 400]);
      expect(result.body).toEqual({
        success: false,
        error: expect.any(String),
      });
    }
    expect(listSpy).not.toHaveBeenCalled();
    expect(countSpy).not.toHaveBeenCalled();
  });
});
