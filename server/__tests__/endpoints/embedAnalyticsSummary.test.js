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
// Adressen und Rümpfe, wie der Browser sie sendet - dieselben, gegen die das
// Frontend geprüft ist.
const {
  ROUTES,
  summaryBody,
  conversationsBody,
} = require("./support/embedAnalyticsRequests");
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
const SUMMARY = routes[`${ROUTES.summary.method} ${ROUTES.summary.path}`];
const CONVERSATIONS =
  routes[`${ROUTES.conversations.method} ${ROUTES.conversations.path}`];
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

    const result = await summary(
      embed,
      summaryBody("2026-09-13", "2026-10-12")
    );

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

  test("koernung: nie über 92 Abschnitte - 92 Kalendermonate sind der längste Zeitraum, der 93. Monat ergibt 400", async () => {
    const workspace = await createWorkspace(db.client);
    const embed = await createEmbed(db.client, workspace);
    await countsOnly(embed, [
      { day: "2019-02-28", messages: 9, conversationsStarted: 9 },
      { day: "2019-03-01", messages: 3, conversationsStarted: 1 },
      { day: "2026-10-12", messages: 4, conversationsStarted: 2 },
    ]);

    // 01.03.2019 bis 12.10.2026: März 2019 bis Oktober 2026 = 92 Monate
    const longest = await summary(embed, {
      fromDay: "2019-03-01",
      toDay: "2026-10-12",
    });
    expect(longest.statusCode).toBe(200);
    expect(longest.body.granularity).toBe("month");
    expect(longest.body.buckets).toHaveLength(92);
    expect(longest.body.buckets[0]).toMatchObject({
      start: "2019-03-01",
      end: "2019-03-31",
      partial: false,
      messages: 3,
    });
    expect(longest.body.buckets.at(-1)).toMatchObject({
      start: "2026-10-01",
      end: "2026-10-12",
      partial: true,
      messages: 4,
    });
    expect(longest.body.totals).toMatchObject({
      messages: 7,
      conversations: 3,
    });

    // Einen Tag früher begonnen wären es 93 Monate: keine Körnung passt mehr.
    timelineSpy.mockClear();
    const tooLong = await summary(embed, {
      fromDay: "2019-02-28",
      toDay: "2026-10-12",
    });
    expect(tooLong.statusCode).toBe(400);
    expect(tooLong.body).toEqual({ success: false, error: expect.any(String) });
    expect(tooLong.body.buckets).toBeUndefined();
    expect(timelineSpy).not.toHaveBeenCalled();
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
// KIE-539 — Karte „Wann schreiben Ihre Besucher?": weekdayHour, 7 × 24 Felder
// (Montag bis Sonntag, Berliner Stunde 0-23) in derselben Antwort.
// Die Bestände stehen in support/weekdayHourScenarios.js - das Frontend prüft
// seine Aussagen, Stufen und Tooltips gegen dieselben Raster.
// ============================================================================
describe("Raster Wochentag × Stunde (KIE-539)", () => {
  const {
    PERIOD,
    DISTRIBUTION,
    CORE_TIME_WEEK,
    DST,
    gridOf,
    totalOf,
  } = require("./support/weekdayHourScenarios");
  const { tableChecksum } = require("../helpers/sqliteTestDatabase");

  const MONDAY = 0;
  const FRIDAY = 4;
  const SUNDAY = 6;
  const emptyGrid = () => gridOf([]);
  const gridSum = (grid) =>
    grid.flat().reduce((total, value) => total + value, 0);
  /** Was die Antwort außer dem Raster über den Zeitraum sagt. */
  const timelineOf = ({ granularity, totals, buckets }) => ({
    granularity,
    totals,
    buckets,
  });
  /** Text einer Anweisung, wie sie an $queryRaw ging (ohne die Werte). */
  const sqlOf = ([strings, ...values]) =>
    strings.reduce(
      (text, part, i) =>
        text + (values[i - 1]?.strings?.join("?") ?? "?") + part
    );

  /**
   * Legt die Nachrichten eines Bestands an: je Feld eine echte Widget-Nachricht
   * zur Berliner Wanduhrzeit (minute, sonst :30) über den Schreibpfad, den
   * Rest als Zählwerte - der Stand, nachdem die Inhalte gelöscht sind.
   */
  async function seed(embed, cells) {
    for (const [i, cell] of cells.entries()) {
      await chatAt(
        embed,
        berlinInstant(cell.day, cell.hour, cell.minute ?? 30),
        {
          session_id: `s-${i}`,
        }
      );
      if (cell.messages > 1)
        await countsOnly(embed, [
          { day: cell.day, hour: cell.hour, messages: cell.messages - 1 },
        ]);
    }
  }

  // ==========================================================================
  // AK-1 — Raster zeigt die Verteilung
  // ==========================================================================
  describe("wochentag_stunde (AK-1)", () => {
    test("wochentag_stunde: 30 Tage - 7 Zeilen (Montag bis Sonntag) mit je 24 Stunden, jedes Feld nennt die Nachrichten seines Wochentags und seiner Stunde", async () => {
      const workspace = await createWorkspace(db.client);
      const embed = await createEmbed(db.client, workspace);
      await countsOnly(embed, DISTRIBUTION.cells);
      const expected = gridOf(DISTRIBUTION.cells);

      const result = await summary(
        embed,
        summaryBody(DISTRIBUTION.fromDay, DISTRIBUTION.toDay)
      );

      expect(result.statusCode).toBe(200);
      const grid = result.body.weekdayHour;
      expect(grid).toHaveLength(7);
      for (const row of grid) expect(row).toHaveLength(24);
      expect(grid).toEqual(expected);

      // Der Höchstwert liegt dienstags zwischen 10 und 11 Uhr (AK-3) …
      const { peak } = DISTRIBUTION;
      expect(grid[peak.weekday][peak.hour]).toBe(peak.messages);
      expect(
        grid.flat().filter((value) => value >= peak.messages)
      ).toHaveLength(1);
      // … nachts schreibt niemand: Diese Felder sind 0 und bleiben im Raster.
      for (const row of grid)
        for (const hour of [0, 1, 2, 3, 4, 5, 6, 7, 20, 21, 22, 23])
          expect(row[hour]).toBe(0);
      expect(grid.flat().filter((value) => value === 0)).toHaveLength(84);
      expect(result.body.totals.messages).toBe(DISTRIBUTION.total);
    });

    test("wochentag_stunde: Der Wochentag kommt vom Berliner Kalendertag - 23:30 am Sonntag ist Sonntag, 00:30 danach Montag", async () => {
      const workspace = await createWorkspace(db.client);
      const embed = await createEmbed(db.client, workspace);
      // Sommerzeit (Berlin = UTC + 2): 21:30 UTC ist 23:30, 22:30 UTC ist 00:30.
      await chatAt(embed, new Date("2026-10-04T21:30:00Z")); // So 23:30
      await chatAt(embed, new Date("2026-10-04T22:30:00Z")); // Mo 00:30
      // Winterzeit (Berlin = UTC + 1) und Jahreswechsel
      await chatAt(embed, new Date("2026-12-31T22:30:00Z")); // Do 23:30
      await chatAt(embed, new Date("2026-12-31T23:30:00Z")); // Fr 00:30, 01.01.2027

      const autumn = await summary(
        embed,
        summaryBody("2026-10-01", "2026-10-31")
      );
      const expected = emptyGrid();
      expected[SUNDAY][23] = 1;
      expected[MONDAY][0] = 1;
      expect(autumn.body.weekdayHour).toEqual(expected);

      const newYear = await summary(
        embed,
        summaryBody("2026-12-01", "2027-01-31")
      );
      const turn = emptyGrid();
      turn[3][23] = 1;
      turn[FRIDAY][0] = 1;
      expect(newYear.body.weekdayHour).toEqual(turn);
    });

    test("wochentag_stunde: nur die Tage des Zeitraums und nur dieses Widget - keine Workspace-Chats, kein zweites Widget", async () => {
      const workspace = await createWorkspace(db.client);
      const embed = await createEmbed(db.client, workspace);
      const other = await createEmbed(db.client, workspace);
      await countsOnly(embed, [
        { day: "2026-09-12", hour: 10, messages: 50 }, // Tag davor
        { day: "2026-09-13", hour: 10, messages: 2 }, // erster Tag (So)
        { day: "2026-10-12", hour: 10, messages: 3 }, // letzter Tag (Mo)
        { day: "2026-10-13", hour: 10, messages: 70 }, // Tag danach
      ]);
      await countsOnly(other, [{ day: "2026-10-06", hour: 10, messages: 100 }]);
      await MessageLedger.transaction({ source: "test" }, (tx) =>
        MessageLedger.addCells(tx, [
          {
            workspaceId: workspace.id,
            embedId: 0,
            day: "2026-10-06",
            hour: 10,
            messages: 1000,
          },
        ])
      );

      const result = await summary(
        embed,
        summaryBody(PERIOD.fromDay, PERIOD.toDay)
      );

      const expected = emptyGrid();
      expected[SUNDAY][10] = 2;
      expected[MONDAY][10] = 3;
      expect(result.body.weekdayHour).toEqual(expected);
      expect(result.body.totals.messages).toBe(5);
    });

    test("wochentag_stunde: Ein umgehängtes Widget behält seine Felder aus dem früheren Workspace - gleiche Stunde, ein Feld", async () => {
      const workspaceA = await createWorkspace(db.client);
      const workspaceB = await createWorkspace(db.client);
      const embed = await createEmbed(db.client, workspaceA);
      await chatAt(embed, berlinInstant("2026-10-06", 10, 5), {
        session_id: "a",
      });
      expect(
        (await EmbedConfig.update(embed.id, { workspace_id: workspaceB.id }))
          .success
      ).toBe(true);
      await chatAt(embed, berlinInstant("2026-10-06", 10, 40), {
        session_id: "b",
      });
      // zwei Zeilen im Zählerbuch für denselben Tag und dieselbe Stunde
      expect(await db.client.message_ledger.count()).toBe(2);

      const result = await summary(
        embed,
        summaryBody(PERIOD.fromDay, PERIOD.toDay)
      );

      const expected = emptyGrid();
      expected[1][10] = 2;
      expect(result.body.weekdayHour).toEqual(expected);
    });

    test("wochentag_stunde: ohne Zählwerte 7 × 24 Nullen - auch für einen einzelnen Tag", async () => {
      const workspace = await createWorkspace(db.client);
      const embed = await createEmbed(db.client, workspace);

      for (const body of [
        summaryBody(PERIOD.fromDay, PERIOD.toDay),
        summaryBody("2026-10-06", "2026-10-06"),
      ]) {
        const result = await summary(embed, body);
        expect(result.statusCode).toBe(200);
        expect(result.body.weekdayHour).toEqual(emptyGrid());
      }
    });

    test("wochentag_stunde: nur Zählwerte - 168 ganze Zahlen, keine Inhalte; die übrigen Felder der Antwort bleiben, wie sie sind", async () => {
      const workspace = await createWorkspace(db.client);
      const embed = await createEmbed(db.client, workspace);
      const chat = await chatAt(embed, berlinInstant("2026-10-06", 10), {
        prompt: "GEHEIME-FRAGE",
        response: JSON.stringify({ text: "GEHEIME-ANTWORT" }),
        session_id: "GEHEIME-SITZUNG",
      });
      await EmbedChats.updateFeedbackScore(
        embed.id,
        "GEHEIME-SITZUNG",
        chat.id,
        true
      );
      const timeline = await MessageLedger.timelineForEmbed(
        embed.id,
        PERIOD.fromDay,
        PERIOD.toDay
      );

      const result = await summary(
        embed,
        summaryBody(PERIOD.fromDay, PERIOD.toDay)
      );

      const { weekdayHour, ...rest } = result.body;
      expect(rest).toEqual({
        success: true,
        fromDay: PERIOD.fromDay,
        toDay: PERIOD.toDay,
        granularity: timeline.granularity,
        totals: timeline.totals,
        buckets: timeline.buckets,
        firstLedgerDay: "2026-10-06",
      });
      expect(weekdayHour.flat()).toHaveLength(168);
      for (const value of weekdayHour.flat())
        expect(Number.isInteger(value) && value >= 0).toBe(true);
      // Bewertungen sind keine Nachrichten: Das Feld bleibt bei 1.
      expect(gridSum(weekdayHour)).toBe(1);
      expect(JSON.stringify(weekdayHour)).not.toMatch(/GEHEIM/);
    });

    test("wochentag_stunde: Gelesen wird nur das Zählerbuch - keine Abfrage auf embed_chats (Hard Constraint 1)", async () => {
      const workspace = await createWorkspace(db.client);
      const embed = await createEmbed(db.client, workspace);
      // Es gibt Konversationsinhalte - gelesen werden dürfen sie nicht.
      await seed(embed, CORE_TIME_WEEK.cells);
      expect(await db.client.embed_chats.count()).toBe(
        CORE_TIME_WEEK.cells.length
      );
      const chatReads = [
        "findMany",
        "findFirst",
        "findFirstOrThrow",
        "findUnique",
        "findUniqueOrThrow",
        "groupBy",
        "count",
        "aggregate",
      ].map((method) => jest.spyOn(db.client.embed_chats, method));
      const queryRaw = jest.spyOn(db.client, "$queryRaw");
      const queryRawUnsafe = jest.spyOn(db.client, "$queryRawUnsafe");

      const result = await summary(
        embed,
        summaryBody(CORE_TIME_WEEK.fromDay, CORE_TIME_WEEK.toDay)
      );
      const direct = await MessageLedger.summaryForEmbed(
        embed.id,
        CORE_TIME_WEEK.fromDay,
        CORE_TIME_WEEK.toDay
      );

      // Gegenprobe: Beide Aufrufe haben gelesen und das Raster geliefert.
      expect(result.statusCode).toBe(200);
      expect(result.body.weekdayHour).toEqual(gridOf(CORE_TIME_WEEK.cells));
      expect(direct.weekdayHour).toEqual(gridOf(CORE_TIME_WEEK.cells));
      expect(queryRaw).toHaveBeenCalledTimes(2);

      for (const read of chatReads) expect(read).not.toHaveBeenCalled();
      expect(queryRawUnsafe).not.toHaveBeenCalled();
      for (const call of queryRaw.mock.calls) {
        expect(sqlOf(call)).toMatch(/\bFROM message_ledger\b/);
        expect(sqlOf(call)).not.toMatch(/embed_chats|workspace_chats/);
      }
    });
  });

  // ==========================================================================
  // AK-2 — Summe stimmt
  // ==========================================================================
  describe("raster_summe (AK-2)", () => {
    // Zählwerte über gut drei Jahre; in jeder Körnung liegt ein Teil davon
    // außerhalb des abgefragten Zeitraums.
    const FIRST = "2023-06-01";
    const LAST = "2026-10-20";

    test.each([
      ["ein einzelner Tag", "2026-10-07", "2026-10-07"],
      ["27 Tage", "2026-09-16", "2026-10-12"],
      ["30 Tage", "2026-09-13", "2026-10-12"],
      ["12 Monate mit beiden Zeitumstellungen", "2025-10-13", "2026-10-12"],
      ["gut drei Jahre", "2023-10-09", "2026-10-12"],
    ])(
      "raster_summe: %s (%s bis %s) - die 168 Felder ergeben zusammen die Kennzahl „Nachrichten“",
      async (_name, fromDay, toDay) => {
        const workspace = await createWorkspace(db.client);
        const embed = await createEmbed(db.client, workspace);
        const other = await createEmbed(db.client, workspace);

        const cells = [];
        for (const [i, day] of daysOf(FIRST, LAST).entries()) {
          if (i % 5 === 3) continue; // Lücken
          for (const hour of [0, 2, 9 + (i % 7), 23]) {
            if ((i + hour) % 4 === 0) continue;
            cells.push({
              workspaceId: workspace.id,
              embedId: embed.id,
              day,
              hour,
              messages: 1 + ((i * 7 + hour) % 9),
              conversationsStarted: (i + hour) % 3,
            });
          }
          cells.push({
            workspaceId: workspace.id,
            embedId: other.id,
            day,
            hour: 10,
            messages: 100,
          });
        }
        await MessageLedger.transaction({ source: "test" }, (tx) =>
          MessageLedger.addCells(tx, cells)
        );
        // Tage der Zeitumstellung: Im Frühjahr gibt es die Berliner Stunde 2
        // nicht, im Herbst zweimal - beide Durchläufe zählen in Stunde 2.
        for (const instant of [
          "2025-10-26T00:30:00Z", // 02:30 Sommerzeit
          "2025-10-26T01:30:00Z", // 02:30 Winterzeit
          "2026-03-29T00:30:00Z", // 01:30
          "2026-03-29T01:30:00Z", // 03:30
        ])
          await chatAt(embed, new Date(instant), { session_id: instant });

        const result = await summary(embed, summaryBody(fromDay, toDay));

        expect(result.statusCode).toBe(200);
        const grid = result.body.weekdayHour;
        expect(grid.flat()).toHaveLength(168);
        expect(result.body.totals.messages).toBeGreaterThan(0);
        expect(gridSum(grid)).toBe(result.body.totals.messages);
        expect(gridSum(grid)).toBe(sum(result.body.buckets, "messages"));
        // Kennzahlen und Abschnitte sind dieselben wie aus der Gruppierung
        // von timelineForEmbed - in jeder Körnung.
        expect(timelineOf(result.body)).toEqual(
          await MessageLedger.timelineForEmbed(embed.id, fromDay, toDay)
        );

        // Jedes Feld nennt genau die Werte seines Wochentags und seiner Stunde.
        const own = (await db.client.message_ledger.findMany()).filter(
          (row) =>
            row.embed_id === embed.id && row.day >= fromDay && row.day <= toDay
        );
        expect(grid).toEqual(gridOf(own));
        expect(gridSum(grid)).toBe(totalOf(own));
      }
    );

    test("raster_summe: Tage der Zeitumstellung - im Frühjahr fehlt die Stunde 2, im Herbst zählt sie doppelt; die Summe bleibt die Kennzahl", async () => {
      const workspace = await createWorkspace(db.client);
      const embed = await createEmbed(db.client, workspace);
      for (const { instants } of [DST.spring, DST.autumn])
        for (const instant of instants) await chatAt(embed, new Date(instant));

      for (const [fromDay, toDay, messages] of [
        [DST.spring.day, DST.spring.day, 2],
        [DST.autumn.day, DST.autumn.day, 2],
        ["2026-03-01", "2026-10-31", 4],
      ]) {
        const result = await summary(embed, summaryBody(fromDay, toDay));
        expect(result.body.totals.messages).toBe(messages);
        expect(gridSum(result.body.weekdayHour)).toBe(messages);
      }
    });

    test.each([
      ["30 Tage", PERIOD.fromDay, PERIOD.toDay],
      ["ein einzelner Tag", "2026-10-07", "2026-10-07"],
    ])(
      "raster_summe: %s - wird während der Abfrage gezählt, bleibt die Summe der 168 Felder die Kennzahl derselben Antwort (ein Lesestand)",
      async (_name, fromDay, toDay) => {
        const workspace = await createWorkspace(db.client);
        const embed = await createEmbed(db.client, workspace);
        await countsOnly(embed, [{ day: "2026-10-07", hour: 10, messages: 3 }]);

        // Nach jedem Lesezugriff auf das Zählerbuch entsteht eine weitere
        // Widget-Nachricht im Zeitraum - über den echten Schreibpfad und
        // bevor der Aufrufer weiterliest. Der Schreibpfad liest selbst (in
        // seiner Transaktion); das löst keine weitere Nachricht aus.
        let written = 0;
        let writing = false;
        const writeAfter = (target, method) => {
          const read = target[method];
          return jest.spyOn(target, method).mockImplementation(async function (
            ...args
          ) {
            const result = await read.apply(this, args);
            if (writing) return result;
            writing = true;
            try {
              written += 1;
              await chatAt(embed, berlinInstant("2026-10-07", 11, written), {
                session_id: `dazwischen-${written}`,
              });
            } finally {
              writing = false;
            }
            return result;
          });
        };
        timelineSpy.mockRestore();
        const hooks = [
          writeAfter(db.client, "$queryRaw"),
          writeAfter(db.client.message_ledger, "groupBy"),
          writeAfter(db.client.message_ledger, "findMany"),
          writeAfter(MessageLedger, "timelineForEmbed"),
        ];

        const result = await summary(embed, summaryBody(fromDay, toDay));

        expect(result.statusCode).toBe(200);
        // Gegenprobe: Während der Abfrage ist wirklich gezählt worden.
        expect(written).toBeGreaterThanOrEqual(2);
        expect(await db.client.message_ledger.count()).toBe(2);
        const { totals, buckets, weekdayHour } = result.body;
        expect(gridSum(weekdayHour)).toBe(totals.messages);
        expect(sum(buckets, "messages")).toBe(totals.messages);
        // Der Stand vor dem ersten Schreibzugriff - in allen drei Angaben.
        expect(totals.messages).toBe(3);
        expect(weekdayHour[2][10]).toBe(3);
        expect(weekdayHour[2][11]).toBe(0);

        // Die nächste Abfrage zeigt, was inzwischen gezählt wurde.
        for (const hook of hooks) hook.mockRestore();
        const later = await summary(embed, summaryBody(fromDay, toDay));
        expect(later.body.totals.messages).toBe(3 + written);
        expect(gridSum(later.body.weekdayHour)).toBe(3 + written);
        expect(later.body.weekdayHour[2][11]).toBe(written);
      }
    );
  });

  // ==========================================================================
  // AK-4 — Anteil außerhalb der Kernzeit (Montag-Freitag, 8-17 Uhr)
  // ==========================================================================
  describe("anteil_ausserhalb (AK-4)", () => {
    /** Nachrichten Montag bis Freitag in den Stunden 8 bis 16 (8:00-16:59 Uhr). */
    const insideCore = (grid) =>
      gridSum(grid.slice(MONDAY, FRIDAY + 1).map((row) => row.slice(8, 17)));

    test("anteil_ausserhalb: 100 Nachrichten, davon 60 Montag bis Freitag zwischen 8:00 und 16:59 Uhr - 40 liegen in den Feldern außerhalb", async () => {
      const workspace = await createWorkspace(db.client);
      const embed = await createEmbed(db.client, workspace);
      await seed(embed, CORE_TIME_WEEK.cells);

      const result = await summary(
        embed,
        summaryBody(CORE_TIME_WEEK.fromDay, CORE_TIME_WEEK.toDay)
      );

      const grid = result.body.weekdayHour;
      expect(grid).toEqual(gridOf(CORE_TIME_WEEK.cells));
      expect(result.body.totals.messages).toBe(CORE_TIME_WEEK.total);
      expect(gridSum(grid)).toBe(100);
      expect(insideCore(grid)).toBe(CORE_TIME_WEEK.insideCore);
      expect(
        Math.round(((gridSum(grid) - insideCore(grid)) / gridSum(grid)) * 100)
      ).toBe(CORE_TIME_WEEK.outsidePercent);

      // Die Grenzen auf die Minute: 07:59 und 17:00 Uhr liegen außerhalb,
      // 08:00 und 16:59 Uhr innerhalb.
      expect(grid[MONDAY][7]).toBe(5);
      expect(grid[MONDAY][8]).toBe(10);
      expect(grid[FRIDAY][16]).toBe(12);
      expect(grid[FRIDAY][17]).toBe(4);
      // Samstag und Sonntag liegen ganz außerhalb, auch mitten am Tag.
      expect(grid[5][10]).toBe(10);
      expect(grid[SUNDAY][12]).toBe(8);
    });

    test("anteil_ausserhalb: Feiertage zählen als normale Wochentage - der 01.05.2026 ist ein Freitag, der 25.12.2026 auch", async () => {
      const workspace = await createWorkspace(db.client);
      const embed = await createEmbed(db.client, workspace);
      await chatAt(embed, berlinInstant("2026-05-01", 10, 15)); // Tag der Arbeit
      await chatAt(embed, berlinInstant("2026-12-25", 10, 45)); // 1. Weihnachtstag

      const result = await summary(
        embed,
        summaryBody("2026-05-01", "2026-12-31")
      );

      const expected = emptyGrid();
      expected[FRIDAY][10] = 2;
      expect(result.body.weekdayHour).toEqual(expected);
      expect(insideCore(result.body.weekdayHour)).toBe(2);
    });
  });

  // ==========================================================================
  // AK-6 — Sommerzeit
  // ==========================================================================
  describe("raster_sommerzeit (AK-6)", () => {
    test("raster_sommerzeit: 29.03.2026 um 01:30 und 03:30 Berliner Zeit - Zeile Sonntag, Spalten 1 und 3; die Spalte 2 bleibt leer", async () => {
      const workspace = await createWorkspace(db.client);
      const embed = await createEmbed(db.client, workspace);
      for (const instant of DST.spring.instants)
        await chatAt(embed, new Date(instant));
      // Dieselben Zeitpunkte als Berliner Wanduhrzeit
      expect(DST.spring.instants.map((instant) => berlinCell(instant))).toEqual(
        [
          { day: "2026-03-29", hour: 1 },
          { day: "2026-03-29", hour: 3 },
        ]
      );

      for (const body of [
        summaryBody("2026-03-29", "2026-03-29"),
        summaryBody("2026-03-01", "2026-03-31"),
      ]) {
        const grid = (await summary(embed, body)).body.weekdayHour;
        const expected = emptyGrid();
        expected[SUNDAY][1] = 1;
        expected[SUNDAY][3] = 1;
        expect(grid).toEqual(expected);
        expect(grid[SUNDAY][2]).toBe(0);
      }
    });

    test("raster_sommerzeit: 25.10.2026 - die Stunde 2 gibt es zweimal, beide Durchläufe stehen in Spalte 2 der Zeile Sonntag", async () => {
      const workspace = await createWorkspace(db.client);
      const embed = await createEmbed(db.client, workspace);
      for (const instant of DST.autumn.instants)
        await chatAt(embed, new Date(instant));

      const grid = (
        await summary(embed, summaryBody("2026-10-01", "2026-10-31"))
      ).body.weekdayHour;

      const expected = emptyGrid();
      expected[DST.autumn.weekday][2] = 2;
      expect(grid).toEqual(expected);
    });
  });

  // ==========================================================================
  // NAK-1 — Keine fremden Zahlen: dieselben Prüfungen wie für die Kennzahlen
  // ==========================================================================
  describe("fremdes_widget (NAK-1, erweitert)", () => {
    let workspaceA, workspaceB, embedA, embedB, summarySpy;
    const body = summaryBody(PERIOD.fromDay, PERIOD.toDay);

    beforeEach(async () => {
      await setMultiUserMode(true);
      workspaceA = await createWorkspace(db.client);
      workspaceB = await createWorkspace(db.client);
      embedA = await createEmbed(db.client, workspaceA);
      embedB = await createEmbed(db.client, workspaceB);
      await countsOnly(embedA, [{ day: "2026-10-06", hour: 10, messages: 3 }]);
      await countsOnly(embedB, [{ day: "2026-10-06", hour: 15, messages: 40 }]);
      summarySpy = jest.spyOn(MessageLedger, "summaryForEmbed");
    });

    test("fremdes_widget: default aus Workspace A erhält für ein Widget aus Workspace B 403 - kein Raster, das Zählerbuch wird nicht gelesen", async () => {
      const kunde = await createUser("default", [workspaceA.id]);
      const reads = [
        jest.spyOn(db.client, "$queryRaw"),
        jest.spyOn(db.client.message_ledger, "groupBy"),
        jest.spyOn(db.client.message_ledger, "findMany"),
      ];

      const result = await summary(embedB, body, kunde);

      expect(result.statusCode).toBe(403);
      expect(result.body).toBeUndefined();
      expect(summarySpy).not.toHaveBeenCalled();
      for (const read of reads) expect(read).not.toHaveBeenCalled();
    });

    test("fremdes_widget: das eigene Widget liefert nur dessen Raster", async () => {
      const kunde = await createUser("default", [workspaceA.id]);

      const result = await summary(embedA, body, kunde);

      expect(result.statusCode).toBe(200);
      const expected = emptyGrid();
      expected[1][10] = 3;
      expect(result.body.weekdayHour).toEqual(expected);
      expect(JSON.stringify(result.body)).not.toContain("40");
    });

    test("fremdes_widget: Nach dem Umhängen entscheidet der heutige Workspace des Widgets", async () => {
      const kunde = await createUser("default", [workspaceA.id]);
      await EmbedConfig.update(embedB.id, { workspace_id: workspaceA.id });
      expect((await summary(embedB, body, kunde)).body.weekdayHour[1][15]).toBe(
        40
      );

      await EmbedConfig.update(embedA.id, { workspace_id: workspaceB.id });
      const moved = await summary(embedA, body, kunde);
      expect(moved.statusCode).toBe(403);
      expect(moved.body).toBeUndefined();
    });

    test("fremdes_widget: kein Raster ohne Anmeldung (401), bei abgeschaltetem Chat-Verlauf (422), für ein unbekanntes Widget oder embed_id 0 (404) und bei ungültigem Zeitraum (400)", async () => {
      const admin = await createUser("admin");
      const cases = [
        [401, embedA, body, null],
        [401, embedA, body, { token: "kein-gueltiges-token" }],
        [404, 99999, body, admin],
        [404, 0, body, admin],
        [400, embedA, summaryBody("2026-10-07", "2026-10-06"), admin],
        [400, embedA, summaryBody("2019-02-28", "2026-10-12"), admin],
      ];
      for (const [status, embed, request, user] of cases) {
        const result = await summary(embed, request, user);
        expect([status, result.statusCode]).toEqual([status, status]);
        expect(result.body?.weekdayHour).toBeUndefined();
      }

      process.env.DISABLE_VIEW_CHAT_HISTORY = "1";
      const disabled = await summary(embedA, body, admin);
      expect(disabled.statusCode).toBe(422);
      expect(disabled.body?.weekdayHour).toBeUndefined();

      expect(summarySpy).not.toHaveBeenCalled();
    });

    test("fremdes_widget: admin und manager sind nicht eingeschränkt", async () => {
      for (const role of ["admin", "manager"]) {
        const result = await summary(embedB, body, await createUser(role));
        expect(result.statusCode).toBe(200);
        expect(result.body.weekdayHour[1][15]).toBe(40);
      }
    });
  });

  // ==========================================================================
  // Lesefunktion des Zählerbuchs
  // ==========================================================================
  describe("Lesefunktion (MessageLedger.summaryForEmbed)", () => {
    test("liest nur: Das Zählerbuch ist nach den Abfragen Byte für Byte dasselbe", async () => {
      const workspace = await createWorkspace(db.client);
      const embed = await createEmbed(db.client, workspace);
      await seed(embed, CORE_TIME_WEEK.cells);
      const before = await tableChecksum(db.client, "message_ledger");
      expect(before.rows).toBe(CORE_TIME_WEEK.cells.length);

      for (const [fromDay, toDay] of [
        ["2026-10-06", "2026-10-06"],
        [PERIOD.fromDay, PERIOD.toDay],
        ["2019-03-01", "2026-10-12"],
      ]) {
        const read = await MessageLedger.summaryForEmbed(
          embed.id,
          fromDay,
          toDay
        );
        expect(read.weekdayHour.flat()).toHaveLength(168);
        // Dazu genau das, was timelineForEmbed liefert.
        expect(timelineOf(read)).toEqual(
          await MessageLedger.timelineForEmbed(embed.id, fromDay, toDay)
        );
        expect(Object.keys(read).sort()).toEqual([
          "buckets",
          "granularity",
          "totals",
          "weekdayHour",
        ]);
      }

      expect(await tableChecksum(db.client, "message_ledger")).toEqual(before);
    });

    test("gruppiert in der Datenbank: eine Anweisung, je Tag eine Zeile und höchstens 168 für das Raster - die Stundenzeilen des Zeitraums kommen nicht in den Prozess", async () => {
      const workspace = await createWorkspace(db.client);
      const embed = await createEmbed(db.client, workspace);
      // Neun Wochen, jede Stunde belegt: 63 Tage × 24 Stunden = 1512 Zeilen
      const days = daysOf("2026-08-10", "2026-10-11");
      const cells = days.flatMap((day, i) =>
        Array.from({ length: 24 }, (_, hour) => ({
          day,
          hour,
          messages: 1 + ((i + hour) % 3),
        }))
      );
      await countsOnly(embed, cells);
      expect(await db.client.message_ledger.count()).toBe(63 * 24);

      const reads = [];
      const queryRaw = db.client.$queryRaw;
      jest.spyOn(db.client, "$queryRaw").mockImplementation(async function (
        ...args
      ) {
        const rows = await queryRaw.apply(this, args);
        reads.push(rows);
        return rows;
      });
      const findMany = jest.spyOn(db.client.message_ledger, "findMany");
      const groupBy = jest.spyOn(db.client.message_ledger, "groupBy");

      const result = await summary(
        embed,
        summaryBody("2026-08-10", "2026-10-11")
      );

      expect(result.statusCode).toBe(200);
      expect(result.body.weekdayHour).toEqual(gridOf(cells));
      expect(result.body.totals.messages).toBe(totalOf(cells));
      expect(gridSum(result.body.weekdayHour)).toBe(totalOf(cells));
      // Eine einzige Anweisung für Zeitreihe und Raster, keine weitere Lesung
      expect(reads).toHaveLength(1);
      expect(findMany).not.toHaveBeenCalled();
      expect(groupBy).not.toHaveBeenCalled();
      const [rows] = reads;
      expect(rows.filter((row) => Number(row.grid) === 1)).toHaveLength(168);
      expect(rows.filter((row) => Number(row.grid) === 0)).toHaveLength(63);
      expect(rows).toHaveLength(63 + 168);
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
      const queryRaw = jest.spyOn(db.client, "$queryRaw");
      for (const embedId of [0, -1, 1.5, "abc", null, undefined, NaN])
        await expect(
          MessageLedger.summaryForEmbed(embedId, "2026-10-01", "2026-10-12")
        ).rejects.toThrow(/invalid embedId/);
      expect(queryRaw).not.toHaveBeenCalled();
    });

    test("ein ungültiger Zeitraum wirft vor der Abfrage", async () => {
      const workspace = await createWorkspace(db.client);
      const embed = await createEmbed(db.client, workspace);
      const queryRaw = jest.spyOn(db.client, "$queryRaw");
      for (const [fromDay, toDay] of [
        ["2026-10-07", "2026-10-06"],
        ["2026-02-30", "2026-03-05"],
        ["2019-02-28", "2026-10-12"],
        [undefined, undefined],
      ])
        await expect(
          MessageLedger.summaryForEmbed(embed.id, fromDay, toDay)
        ).rejects.toThrow(/timelineLayout/);
      expect(queryRaw).not.toHaveBeenCalled();
    });

    test("eine Zeile mit einer Stunde außerhalb 0-23 wirft, statt die Summe zu verfälschen", async () => {
      const workspace = await createWorkspace(db.client);
      const embed = await createEmbed(db.client, workspace);
      await countsOnly(embed, [{ day: "2026-10-06", hour: 10, messages: 2 }]);
      const outside = async (hour) =>
        await db.client.message_ledger.create({
          data: {
            workspace_id: workspace.id,
            embed_id: embed.id,
            day: "2026-10-06",
            hour,
            messages: 1,
          },
        });

      for (const hour of [24, -1]) {
        const row = await outside(hour);
        // über mehrere Tage und für den einzelnen Tag (Abschnitte in Stunden)
        await expect(
          MessageLedger.summaryForEmbed(embed.id, "2026-10-01", "2026-10-12")
        ).rejects.toThrow(/no weekday-hour cell/);
        await expect(
          MessageLedger.summaryForEmbed(embed.id, "2026-10-06", "2026-10-06")
        ).rejects.toThrow(/no weekday-hour cell/);
        const result = await summary(
          embed,
          summaryBody("2026-10-01", "2026-10-12")
        );
        expect(result.statusCode).toBe(500);
        expect(result.body).toBeUndefined();
        await db.client.message_ledger.delete({ where: { id: row.id } });
      }

      // Gegenprobe: Ohne die Zeile gibt es das Raster wieder.
      const read = await MessageLedger.summaryForEmbed(
        embed.id,
        "2026-10-01",
        "2026-10-12"
      );
      expect(gridSum(read.weekdayHour)).toBe(2);
    });

    test("eine Zeile ohne gültigen Kalendertag wirft, statt in einem Wochentag zu landen", async () => {
      const workspace = await createWorkspace(db.client);
      const embed = await createEmbed(db.client, workspace);
      await db.client.message_ledger.create({
        data: {
          workspace_id: workspace.id,
          embed_id: embed.id,
          day: "2026-10-1x",
          hour: 10,
          messages: 1,
        },
      });

      await expect(
        MessageLedger.summaryForEmbed(embed.id, "2026-10-01", "2026-10-31")
      ).rejects.toThrow(/no weekday-hour cell/);
    });

    test("ein Datenbankfehler wird weitergereicht; der Endpunkt antwortet mit 500 ohne Zahlen", async () => {
      const workspace = await createWorkspace(db.client);
      const embed = await createEmbed(db.client, workspace);
      await countsOnly(embed, [{ day: "2026-10-06", messages: 3 }]);
      jest
        .spyOn(db.client, "$queryRaw")
        .mockRejectedValue(new Error("database is locked"));

      await expect(
        MessageLedger.summaryForEmbed(embed.id, "2026-10-01", "2026-10-12")
      ).rejects.toThrow("database is locked");
      const result = await summary(
        embed,
        summaryBody("2026-10-01", "2026-10-12")
      );
      expect(result.statusCode).toBe(500);
      expect(result.body).toBeUndefined();
    });
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
// KIE-537 — Vergleich mit dem Vorzeitraum (compare: true → previous)
// ============================================================================
describe("Vorzeitraum (KIE-537)", () => {
  const { tableChecksum } = require("../helpers/sqliteTestDatabase");
  let previousSpy;
  beforeEach(() => {
    previousSpy = jest.spyOn(MessageLedger, "previousTimelineForEmbed");
  });

  /** Anfrage mit eingeschaltetem Vergleich, wie der Browser sie sendet. */
  const compared = (embed, fromDay, toDay, user = null) =>
    summary(embed, summaryBody(fromDay, toDay, { compare: true }), user);

  /**
   * Zählwerte für jeden Tag von first bis last (mit Lücken), fest aus dem Tag
   * abgeleitet - dazu ein zweites Widget und Workspace-Chats, die nie
   * mitzählen. Liefert die Zellen des Widgets.
   */
  async function seedDays(workspace, embed, first, last) {
    const other = await createEmbed(db.client, workspace);
    const own = [];
    const foreign = [];
    for (const [i, day] of daysOf(first, last).entries()) {
      if (i % 7 === 4) continue; // Lücken
      own.push({
        workspaceId: workspace.id,
        embedId: embed.id,
        day,
        hour: 8 + (i % 11),
        messages: 1 + ((i * 5) % 13),
        conversationsStarted: i % 4,
        feedbackPositive: i % 3 === 0 ? 1 : 0,
        feedbackNegative: i % 10 === 0 ? 1 : 0,
      });
      foreign.push(
        {
          workspaceId: workspace.id,
          embedId: other.id,
          day,
          hour: 10,
          messages: 100,
          conversationsStarted: 50,
          feedbackPositive: 5,
          feedbackNegative: 5,
        },
        {
          workspaceId: workspace.id,
          embedId: 0,
          day,
          hour: 10,
          messages: 1000,
        }
      );
    }
    await MessageLedger.transaction({ source: "test" }, (tx) =>
      MessageLedger.addCells(tx, [...own, ...foreign])
    );
    return own;
  }

  /** Summen der Tage from bis to, unabhängig vom Server gerechnet. */
  function totalsOf(cells, from, to) {
    const totals = {
      messages: 0,
      conversations: 0,
      feedbackPositive: 0,
      feedbackNegative: 0,
    };
    for (const cell of cells) {
      if (cell.day < from || cell.day > to) continue;
      totals.messages += cell.messages;
      totals.conversations += cell.conversationsStarted;
      totals.feedbackPositive += cell.feedbackPositive;
      totals.feedbackNegative += cell.feedbackNegative;
    }
    return totals;
  }

  /** Jeder Abschnitt nennt genau die Werte seiner Tage. */
  function expectBucketsOf(buckets, cells) {
    for (const bucket of buckets) {
      const own = totalsOf(cells, bucket.start, bucket.end);
      expect([bucket.start, bucket.messages, bucket.conversations]).toEqual([
        bucket.start,
        own.messages,
        own.conversations,
      ]);
      expect(bucket.partial).toBe(false);
    }
  }

  // --------------------------------------------------------------------------
  // AK-1 — Vorzeitraum bei Tageskörnung
  // --------------------------------------------------------------------------
  describe("vorzeitraum_tage (AK-1)", () => {
    test("vorzeitraum_tage: 13.09.-12.10.2026 → previous 14.08.-12.09., 30 Tagesabschnitte in zeitlicher Reihenfolge", async () => {
      const workspace = await createWorkspace(db.client);
      const embed = await createEmbed(db.client, workspace);
      const cells = await seedDays(
        workspace,
        embed,
        "2026-07-02",
        "2026-10-20"
      );
      // Zählwerte auch an den Tagen unmittelbar vor und nach dem Vorzeitraum
      for (const day of [
        "2026-08-13",
        "2026-08-14",
        "2026-09-12",
        "2026-09-13",
      ])
        expect(totalsOf(cells, day, day).messages).toBeGreaterThan(0);

      const result = await compared(embed, "2026-09-13", "2026-10-12");

      expect(result.statusCode).toBe(200);
      const { previous } = result.body;
      expect(previous.fromDay).toBe("2026-08-14");
      expect(previous.toDay).toBe("2026-09-12");
      expect(previous.available).toBe(true);
      expect(previous.buckets).toHaveLength(30);
      expect(previous.buckets).toHaveLength(result.body.buckets.length);
      expect(previous.buckets.map((bucket) => bucket.start)).toEqual(
        daysOf("2026-08-14", "2026-09-12")
      );
      for (const bucket of previous.buckets)
        expect(bucket.end).toBe(bucket.start);
      expectBucketsOf(previous.buckets, cells);

      // Kennzahlen: dieselben 30 Tage - die Summe der Linie ist die Kennzahl.
      const expected = totalsOf(cells, "2026-08-14", "2026-09-12");
      expect(expected.messages).toBeGreaterThan(0);
      expect(expected.feedbackPositive).toBeGreaterThan(0);
      expect(previous.totals).toEqual(expected);
      expect(sum(previous.buckets, "messages")).toBe(expected.messages);
      expect(sum(previous.buckets, "conversations")).toBe(
        expected.conversations
      );
      // Der Tag davor und der erste Tag des Zeitraums zählen nicht mit.
      expect(previous.totals).not.toEqual(
        totalsOf(cells, "2026-08-13", "2026-09-12")
      );
      expect(previous.totals).not.toEqual(
        totalsOf(cells, "2026-08-14", "2026-09-13")
      );
    });

    test("vorzeitraum_tage: Der gewählte Zeitraum bleibt mit Vergleich, wie er ohne ist (NAK-2)", async () => {
      const workspace = await createWorkspace(db.client);
      const embed = await createEmbed(db.client, workspace);
      await seedDays(workspace, embed, "2026-07-01", "2026-10-20");

      const plain = await summary(
        embed,
        summaryBody("2026-09-13", "2026-10-12")
      );
      const result = await compared(embed, "2026-09-13", "2026-10-12");

      expect(plain.body.totals.messages).toBeGreaterThan(0);
      const { previous, ...rest } = result.body;
      expect(rest).toEqual(plain.body);
      expect(previous).toBeDefined();
      expect("previous" in plain.body).toBe(false);
    });

    test("vorzeitraum_tage: über Monats- und Jahresgrenzen, Zählwerte bleiben nach dem Löschen der Inhalte", async () => {
      const workspace = await createWorkspace(db.client);
      const embed = await createEmbed(db.client, workspace);
      // Inhalte im Vorzeitraum, danach gelöscht - gezählt bleiben sie.
      await chatAt(embed, berlinInstant("2025-12-31", 23, 30));
      await chatAt(embed, berlinInstant("2025-12-30", 0, 30));
      await chatAt(embed, berlinInstant("2025-12-29", 23, 30)); // davor
      await chatAt(embed, berlinInstant("2026-01-01", 0, 30)); // im Zeitraum
      await db.client.embed_chats.deleteMany({});

      const result = await compared(embed, "2026-01-01", "2026-01-02");

      expect(result.body.previous).toEqual({
        available: true,
        fromDay: "2025-12-30",
        toDay: "2025-12-31",
        totals: {
          messages: 2,
          conversations: 1,
          feedbackPositive: 0,
          feedbackNegative: 0,
        },
        buckets: [
          {
            start: "2025-12-30",
            end: "2025-12-30",
            partial: false,
            messages: 1,
            conversations: 0,
          },
          {
            start: "2025-12-31",
            end: "2025-12-31",
            partial: false,
            messages: 1,
            conversations: 1,
          },
        ],
      });
      expect(result.body.totals.messages).toBe(1);
    });
  });

  // --------------------------------------------------------------------------
  // AK-2 — Vorzeitraum bei Wochen- und Monatskörnung
  // --------------------------------------------------------------------------
  describe("vorzeitraum_wochen_monate (AK-2)", () => {
    const FIRST = "2020-06-01";
    const LAST = "2026-10-20";

    test.each([
      // Körnung, Zeitraum, Säulen, Linie von-bis, Kennzahlen von-bis
      [
        "week",
        ["2025-10-13", "2026-10-11"],
        52,
        ["2024-10-14", "2025-10-12"],
        ["2024-10-14", "2025-10-12"],
      ],
      [
        // erste Säule angeschnitten (Mittwoch), 363 Tage
        "week",
        ["2025-10-15", "2026-10-12"],
        53,
        ["2024-10-07", "2025-10-12"],
        ["2024-10-17", "2025-10-14"],
      ],
      [
        // 730 Tage; die 24 Monate davor haben 731 (29.02.2024)
        "month",
        ["2024-11-01", "2026-10-31"],
        24,
        ["2022-11-01", "2024-10-31"],
        ["2022-11-02", "2024-10-31"],
      ],
      [
        // 731 Tage (29.02.2024); die 24 Monate davor haben 730 - die
        // Kennzahlen beginnen einen Tag vor der Linie
        "month",
        ["2023-11-01", "2025-10-31"],
        24,
        ["2021-11-01", "2023-10-31"],
        ["2021-10-31", "2023-10-31"],
      ],
      [
        // beide Randsäulen angeschnitten, 1100 Tage
        "month",
        ["2023-10-09", "2026-10-12"],
        37,
        ["2020-09-01", "2023-09-30"],
        ["2020-10-04", "2023-10-08"],
      ],
    ])(
      "vorzeitraum_wochen_monate: %s %j - %i ganze Abschnitte unmittelbar vor der ersten Säule, Kennzahlen über gleich viele Tage vor fromDay",
      async (granularity, [fromDay, toDay], count, line, range) => {
        const workspace = await createWorkspace(db.client);
        const embed = await createEmbed(db.client, workspace);
        const cells = await seedDays(workspace, embed, FIRST, LAST);

        const result = await compared(embed, fromDay, toDay);

        expect(result.statusCode).toBe(200);
        expect(result.body.granularity).toBe(granularity);
        expect(result.body.buckets).toHaveLength(count);
        const { previous } = result.body;
        expect(previous.available).toBe(true);
        expect(previous.buckets).toHaveLength(count);

        // Linie: ganze Kalenderwochen bzw. Monate, lückenlos, in zeitlicher
        // Reihenfolge, bis unmittelbar vor die erste Säule.
        expect(previous.buckets[0].start).toBe(line[0]);
        expect(previous.buckets.at(-1).end).toBe(line[1]);
        expect(
          previous.buckets.flatMap((bucket) => daysOf(bucket.start, bucket.end))
        ).toEqual(daysOf(line[0], line[1]));
        for (const bucket of previous.buckets) {
          if (granularity === "week") {
            expect(new Date(`${bucket.start}T12:00:00Z`).getUTCDay()).toBe(1);
            expect(bucket.end).toBe(addDays(bucket.start, 6));
          } else {
            expect(bucket.start.slice(8)).toBe("01");
            expect(addDays(bucket.end, 1).slice(8)).toBe("01");
            expect(bucket.end.slice(0, 7)).toBe(bucket.start.slice(0, 7));
          }
        }
        // … vor der Kalenderwoche bzw. dem Monat der ersten Säule
        const firstBar = result.body.buckets[0].start;
        expect(line[1] < firstBar).toBe(true);
        expect(daysOf(line[1], firstBar).length).toBeLessThanOrEqual(
          granularity === "week" ? 8 : 32
        );
        expectBucketsOf(previous.buckets, cells);

        // Kennzahlen: gleich viele Kalendertage unmittelbar vor fromDay
        expect(previous.fromDay).toBe(range[0]);
        expect(previous.toDay).toBe(range[1]);
        expect(previous.toDay).toBe(addDays(fromDay, -1));
        expect(daysOf(range[0], range[1])).toHaveLength(
          daysOf(fromDay, toDay).length
        );
        const expected = totalsOf(cells, range[0], range[1]);
        expect(expected.messages).toBeGreaterThan(0);
        expect(previous.totals).toEqual(expected);
        // Beginnen die Kennzahlen vor der Linie, zählen auch diese Tage - sie
        // haben hier Zählwerte.
        if (range[0] < line[0]) {
          const ahead = totalsOf(cells, range[0], addDays(line[0], -1));
          expect(ahead.messages).toBeGreaterThan(0);
          expect(previous.totals).not.toEqual(
            totalsOf(cells, line[0], range[1])
          );
        }
        // Decken sich die Bereiche nicht, ist die Summe der Linie eine andere.
        if (line[0] !== range[0] || line[1] !== range[1])
          expect(sum(previous.buckets, "messages")).not.toBe(
            previous.totals.messages
          );
        else
          expect(sum(previous.buckets, "messages")).toBe(
            previous.totals.messages
          );
      }
    );

    test("vorzeitraum_wochen_monate: Monate, der Zeitraum hat einen Tag mehr als die 24 Monate davor - der Tag vor der Linie zählt zu den Kennzahlen, nicht zur Linie", async () => {
      const workspace = await createWorkspace(db.client);
      const embed = await createEmbed(db.client, workspace);
      // 01.11.2023-31.10.2025: 731 Tage. Kennzahlen ab 31.10.2021, Linie ab
      // 01.11.2021.
      await countsOnly(embed, [
        { day: "2021-10-30", messages: 9, conversationsStarted: 4 }, // davor
        { day: "2021-10-31", messages: 5, conversationsStarted: 3 },
        { day: "2021-11-02", messages: 2, conversationsStarted: 1 },
        { day: "2023-10-31", messages: 4, conversationsStarted: 1 },
        { day: "2023-11-01", messages: 7 }, // im Zeitraum
      ]);

      const result = await compared(embed, "2023-11-01", "2025-10-31");

      expect(result.statusCode).toBe(200);
      expect(result.body.granularity).toBe("month");
      expect(result.body.buckets).toHaveLength(24);
      expect(result.body.totals.messages).toBe(7);
      const { previous } = result.body;
      expect(previous.fromDay).toBe("2021-10-31");
      expect(previous.toDay).toBe("2023-10-31");
      expect(previous.buckets).toHaveLength(24);
      expect(previous.buckets[0]).toEqual({
        start: "2021-11-01",
        end: "2021-11-30",
        partial: false,
        messages: 2,
        conversations: 1,
      });
      expect(previous.buckets.at(-1)).toEqual({
        start: "2023-10-01",
        end: "2023-10-31",
        partial: false,
        messages: 4,
        conversations: 1,
      });
      // Kennzahlen mit dem 31.10.2021, Linie ohne ihn.
      expect(previous.totals).toEqual({
        messages: 11,
        conversations: 5,
        feedbackPositive: 0,
        feedbackNegative: 0,
      });
      expect(sum(previous.buckets, "messages")).toBe(6);
      expect(sum(previous.buckets, "conversations")).toBe(2);
      // Die Zählung beginnt vor dem Vorzeitraum.
      expect(result.body.firstLedgerDay).toBe("2021-10-30");
      expect(previous.available).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // AK-7 — Einzelner Tag
  // --------------------------------------------------------------------------
  describe("vorzeitraum_stunden (AK-7)", () => {
    test("vorzeitraum_stunden: ein einzelner Tag → die 24 Stundenwerte des Vortags in Berliner Zeit", async () => {
      const workspace = await createWorkspace(db.client);
      const embed = await createEmbed(db.client, workspace);
      const yesterday = "2026-10-11";
      const perHour = { 0: 1, 9: 3, 17: 2, 23: 1 };
      for (const [hour, count] of Object.entries(perHour))
        for (let i = 0; i < count; i++)
          await chatAt(embed, berlinInstant(yesterday, Number(hour), 30 + i), {
            session_id: `s-${hour}`,
          });
      // Vorgestern 23:30 und heute 00:30 gehören nicht zu gestern.
      await chatAt(embed, berlinInstant("2026-10-10", 23, 30));
      await chatAt(embed, berlinInstant("2026-10-12", 0, 30));

      const result = await compared(embed, "2026-10-12", "2026-10-12");

      expect(result.statusCode).toBe(200);
      expect(result.body.granularity).toBe("hour");
      const { previous } = result.body;
      expect(previous.fromDay).toBe(yesterday);
      expect(previous.toDay).toBe(yesterday);
      expect(previous.available).toBe(true);
      expect(previous.buckets).toHaveLength(24);
      expect(previous.buckets.map((bucket) => bucket.hour)).toEqual(
        Array.from({ length: 24 }, (_, hour) => hour)
      );
      for (const bucket of previous.buckets) {
        expect(bucket.start).toBe(yesterday);
        expect(bucket.end).toBe(yesterday);
        expect(bucket.partial).toBe(false);
        expect([bucket.hour, bucket.messages]).toEqual([
          bucket.hour,
          perHour[bucket.hour] ?? 0,
        ]);
        expect(bucket.conversations).toBe(perHour[bucket.hour] ? 1 : 0);
      }
      expect(previous.totals).toEqual({
        messages: 7,
        conversations: 4,
        feedbackPositive: 0,
        feedbackNegative: 0,
      });
      // Heute: nur die Nachricht um 00:30.
      expect(result.body.totals.messages).toBe(1);
      expect(result.body.buckets[0].messages).toBe(1);
    });

    test("vorzeitraum_stunden: Der Vortag ist ein Tag der Zeitumstellung - 24 Abschnitte, keine Nachricht geht verloren", async () => {
      const workspace = await createWorkspace(db.client);
      const embed = await createEmbed(db.client, workspace);
      await countsOnly(embed, [{ day: "2026-01-01", messages: 1 }]);
      await chatAt(embed, new Date("2026-03-29T00:30:00Z")); // 01:30 Berlin
      await chatAt(embed, new Date("2026-03-29T01:30:00Z")); // 03:30 Berlin
      await chatAt(embed, new Date("2026-10-25T00:30:00Z")); // 02:30 Berlin (Sommerzeit)
      await chatAt(embed, new Date("2026-10-25T01:30:00Z")); // 02:30 Berlin (Winterzeit)

      const spring = await compared(embed, "2026-03-30", "2026-03-30");
      expect(spring.body.previous.fromDay).toBe("2026-03-29");
      expect(spring.body.previous.buckets).toHaveLength(24);
      expect(
        spring.body.previous.buckets
          .filter((bucket) => bucket.messages > 0)
          .map((bucket) => bucket.hour)
      ).toEqual([1, 3]);
      expect(spring.body.previous.totals.messages).toBe(2);

      const autumn = await compared(embed, "2026-10-26", "2026-10-26");
      expect(autumn.body.previous.fromDay).toBe("2026-10-25");
      expect(autumn.body.previous.buckets).toHaveLength(24);
      expect(autumn.body.previous.buckets[2].messages).toBe(2);
      expect(autumn.body.previous.totals.messages).toBe(2);
    });
  });

  // --------------------------------------------------------------------------
  // AK-6 — Kein Vergleich ohne Daten
  // --------------------------------------------------------------------------
  describe("vergleich_ohne_daten (AK-6)", () => {
    test("vergleich_ohne_daten: Der Vorzeitraum beginnt vor firstLedgerDay → available false, kein Fehler; der Zeitraum selbst bleibt vollständig", async () => {
      const workspace = await createWorkspace(db.client);
      const embed = await createEmbed(db.client, workspace);
      // Das Zählerbuch beginnt am 01.09.; der Vorzeitraum am 14.08.
      await countsOnly(embed, [
        { day: "2026-09-01", messages: 4, conversationsStarted: 2 },
        { day: "2026-09-20", messages: 6, conversationsStarted: 1 },
      ]);

      const result = await compared(embed, "2026-09-13", "2026-10-12");

      expect(result.statusCode).toBe(200);
      expect(result.body.firstLedgerDay).toBe("2026-09-01");
      expect(result.body.totals.messages).toBe(6);
      const { previous } = result.body;
      expect(previous.available).toBe(false);
      expect(previous.fromDay).toBe("2026-08-14");
      expect(previous.toDay).toBe("2026-09-12");
      // Die Form bleibt; die Werte sind, was das Zählerbuch führt.
      expect(previous.buckets).toHaveLength(30);
      expect(previous.totals.messages).toBe(4);
    });

    test.each([
      ["am ersten Tag des Vorzeitraums", "2026-08-14", true],
      ["davor", "2026-08-01", true],
      ["einen Tag nach dessen Beginn", "2026-08-15", false],
      ["am letzten Tag des Vorzeitraums", "2026-09-12", false],
      ["erst im gewählten Zeitraum", "2026-09-13", false],
    ])(
      "vergleich_ohne_daten: Tage - die Zählung beginnt %s (%s) → available %p",
      async (_name, firstDay, available) => {
        const workspace = await createWorkspace(db.client);
        const embed = await createEmbed(db.client, workspace);
        await countsOnly(embed, [
          { day: firstDay, messages: 2 },
          { day: "2026-10-01", messages: 5 },
        ]);

        const result = await compared(embed, "2026-09-13", "2026-10-12");

        expect(result.statusCode).toBe(200);
        expect(result.body.firstLedgerDay).toBe(firstDay);
        expect(result.body.previous.available).toBe(available);
      }
    );

    test("vergleich_ohne_daten: ein Widget ohne jeden Zählwert → available false", async () => {
      const workspace = await createWorkspace(db.client);
      const embed = await createEmbed(db.client, workspace);
      // Ein anderes Widget zählt seit Jahren - das ändert nichts.
      const other = await createEmbed(db.client, workspace);
      await countsOnly(other, [{ day: "2020-01-01", messages: 9 }]);

      const result = await compared(embed, "2026-09-13", "2026-10-12");

      expect(result.statusCode).toBe(200);
      expect(result.body.firstLedgerDay).toBeNull();
      expect(result.body.previous.available).toBe(false);
      expect(sum(result.body.previous.buckets, "messages")).toBe(0);
    });

    test.each([
      // Wochen, erste Säule angeschnitten: Die Linie beginnt am 07.10.2024,
      // die Kennzahlen am 17.10.2024.
      ["2025-10-15", "2026-10-12", "2024-10-07", true],
      ["2025-10-15", "2026-10-12", "2024-10-08", false],
      ["2025-10-15", "2026-10-12", "2024-10-17", false],
      // Monate: Die Kennzahlen beginnen am 02.11.2022, die Linie am 01.11.
      ["2024-11-01", "2026-10-31", "2022-11-01", true],
      ["2024-11-01", "2026-10-31", "2022-11-02", false],
      // Monate, umgekehrt: Die Kennzahlen beginnen am 31.10.2021, die Linie
      // am 01.11.2021.
      ["2023-11-01", "2025-10-31", "2021-10-31", true],
      ["2023-11-01", "2025-10-31", "2021-11-01", false],
      // Monate, erste Säule angeschnitten: Linie ab 01.09.2020, Kennzahlen
      // ab 04.10.2020.
      ["2023-10-09", "2026-10-12", "2020-09-01", true],
      ["2023-10-09", "2026-10-12", "2020-09-02", false],
    ])(
      "vergleich_ohne_daten: Wochen und Monate - %s bis %s, Zählung ab %s → available %p (der frühere der beiden Bereiche entscheidet)",
      async (fromDay, toDay, firstDay, available) => {
        const workspace = await createWorkspace(db.client);
        const embed = await createEmbed(db.client, workspace);
        await countsOnly(embed, [{ day: firstDay, messages: 2 }]);

        const result = await compared(embed, fromDay, toDay);

        expect(result.statusCode).toBe(200);
        expect(result.body.previous.available).toBe(available);
      }
    );

    test("vergleich_ohne_daten: Der längste Zeitraum (92 Kalendermonate) mit Vergleich ist kein Fehler - der Vorzeitraum liegt vor der Zählung", async () => {
      const workspace = await createWorkspace(db.client);
      const embed = await createEmbed(db.client, workspace);
      await countsOnly(embed, [
        { day: "2019-03-01", messages: 3 },
        { day: "2026-10-06", messages: 5 },
      ]);
      const groupBy = jest.spyOn(db.client.message_ledger, "groupBy");

      const result = await compared(embed, "2019-03-01", "2026-10-12");

      expect(result.statusCode).toBe(200);
      expect(result.body.granularity).toBe("month");
      expect(result.body.buckets).toHaveLength(92);
      expect(result.body.totals.messages).toBe(8);
      expect(result.body.previous.available).toBe(false);
      expect(result.body.previous.buckets).toHaveLength(92);
      expect(result.body.previous.buckets[0].start).toBe("2011-07-01");
      expect(result.body.previous.toDay).toBe("2019-02-28");
      expect(sum(result.body.previous.buckets, "messages")).toBe(0);

      // Keine unbegrenzte Abfrage: Der Vorzeitraum hat feste Grenzen, so
      // viele Abschnitte wie der Zeitraum - und endet vor ihm.
      expect(groupBy).toHaveBeenCalledTimes(2);
      expect(groupBy.mock.calls[1][0].where).toEqual({
        embed_id: embed.id,
        day: { gte: "2011-07-01", lte: "2019-02-28" },
      });
    });

    test("vergleich_ohne_daten: Vor dem 01.01.0001 gibt es keinen Vorzeitraum - available false ohne Tage und ohne Abfrage", async () => {
      const workspace = await createWorkspace(db.client);
      const embed = await createEmbed(db.client, workspace);
      await countsOnly(embed, [{ day: "2026-10-06", messages: 5 }]);
      const groupBy = jest.spyOn(db.client.message_ledger, "groupBy");

      const result = await compared(embed, "0001-01-05", "0001-02-01");

      expect(result.statusCode).toBe(200);
      expect(result.body.buckets).toHaveLength(28);
      expect(result.body.previous).toEqual({
        available: false,
        fromDay: null,
        toDay: null,
        totals: null,
        buckets: [],
      });
      expect(groupBy).toHaveBeenCalledTimes(1);
    });
  });

  // --------------------------------------------------------------------------
  // AK-8 — Schalter aus
  // --------------------------------------------------------------------------
  describe("schalter_aus (AK-8)", () => {
    test.each([
      ["ohne compare", {}],
      ["compare: false", { compare: false }],
      ["compare: null", { compare: null }],
      ['compare: "true" (Text)', { compare: "true" }],
      ["compare: 1", { compare: 1 }],
      ["compare: {}", { compare: {} }],
      ["compare: [true]", { compare: [true] }],
    ])(
      "schalter_aus: %s - die Antwort hat kein previous, der Vorzeitraum wird nicht gelesen",
      async (_name, extra) => {
        const workspace = await createWorkspace(db.client);
        const embed = await createEmbed(db.client, workspace);
        await countsOnly(embed, [
          { day: "2026-08-20", messages: 7 },
          { day: "2026-10-06", messages: 3 },
        ]);
        const groupBy = jest.spyOn(db.client.message_ledger, "groupBy");

        const result = await summary(embed, {
          ...summaryBody("2026-09-13", "2026-10-12"),
          ...extra,
        });

        expect(result.statusCode).toBe(200);
        expect(Object.keys(result.body).sort()).toEqual([
          "buckets",
          "firstLedgerDay",
          "fromDay",
          "granularity",
          "success",
          "toDay",
          "totals",
        ]);
        expect(result.body.totals.messages).toBe(3);
        expect(previousSpy).not.toHaveBeenCalled();
        expect(groupBy).toHaveBeenCalledTimes(1);
      }
    );

    test("schalter_aus: Die Anfrage des Browsers nennt compare nur eingeschaltet", () => {
      expect(summaryBody("2026-09-13", "2026-10-12")).toEqual({
        fromDay: "2026-09-13",
        toDay: "2026-10-12",
      });
      expect(
        summaryBody("2026-09-13", "2026-10-12", { compare: false })
      ).toEqual({ fromDay: "2026-09-13", toDay: "2026-10-12" });
      expect(
        summaryBody("2026-09-13", "2026-10-12", { compare: true })
      ).toEqual({ fromDay: "2026-09-13", toDay: "2026-10-12", compare: true });
    });
  });

  // --------------------------------------------------------------------------
  // NAK-3 — Keine fremden Zahlen
  // --------------------------------------------------------------------------
  describe("fremdes_widget (NAK-3)", () => {
    let workspaceA, workspaceB, embedA, embedB;
    const FROM = "2026-09-13";
    const TO = "2026-10-12";

    beforeEach(async () => {
      await setMultiUserMode(true);
      workspaceA = await createWorkspace(db.client);
      workspaceB = await createWorkspace(db.client);
      embedA = await createEmbed(db.client, workspaceA);
      embedB = await createEmbed(db.client, workspaceB);
      // Beide Widgets zählen im Zeitraum und im Vorzeitraum.
      await countsOnly(embedA, [
        { day: "2026-08-01", messages: 1 },
        { day: "2026-08-20", messages: 2 },
        { day: "2026-10-06", messages: 3 },
      ]);
      await countsOnly(embedB, [
        { day: "2026-08-01", messages: 1 },
        { day: "2026-08-20", messages: 40, conversationsStarted: 12 },
        { day: "2026-10-06", messages: 50, conversationsStarted: 9 },
      ]);
    });

    test("fremdes_widget: default aus Workspace A erhält den Vergleich für ein Widget aus Workspace B nicht - 403 und keine Zahlen", async () => {
      const kunde = await createUser("default", [workspaceA.id]);
      const groupBy = jest.spyOn(db.client.message_ledger, "groupBy");
      const findFirst = jest.spyOn(db.client.message_ledger, "findFirst");

      const result = await compared(embedB, FROM, TO, kunde);

      expect(result.statusCode).toBe(403);
      expect(result.body).toBeUndefined();
      expect(timelineSpy).not.toHaveBeenCalled();
      expect(firstDaySpy).not.toHaveBeenCalled();
      expect(previousSpy).not.toHaveBeenCalled();
      expect(groupBy).not.toHaveBeenCalled();
      expect(findFirst).not.toHaveBeenCalled();
    });

    test("fremdes_widget: mit Vergleich ist ein unbekanntes Widget für default von einem fremden nicht zu unterscheiden (403), ohne Mitgliedschaft ebenso", async () => {
      const kunde = await createUser("default", [workspaceA.id]);
      for (const embedId of [9999, 0, -1, "abc", "1 OR 1=1"]) {
        const result = await compared(embedId, FROM, TO, kunde);
        expect([embedId, result.statusCode]).toEqual([embedId, 403]);
        expect(result.body).toBeUndefined();
      }
      const fremd = await createUser("default", []);
      for (const embed of [embedA, embedB])
        expect((await compared(embed, FROM, TO, fremd)).statusCode).toBe(403);
      expect(previousSpy).not.toHaveBeenCalled();
    });

    test("fremdes_widget: Das eigene Widget liefert im Vorzeitraum nur dessen Zahlen", async () => {
      const kunde = await createUser("default", [workspaceA.id]);

      const result = await compared(embedA, FROM, TO, kunde);

      expect(result.statusCode).toBe(200);
      expect(result.body.totals.messages).toBe(3);
      expect(result.body.previous.available).toBe(true);
      expect(result.body.previous.totals).toEqual({
        messages: 2,
        conversations: 0,
        feedbackPositive: 0,
        feedbackNegative: 0,
      });
      expect(sum(result.body.previous.buckets, "messages")).toBe(2);
      expect(sum(result.body.previous.buckets, "conversations")).toBe(0);
      expect(sum(result.body.buckets, "messages")).toBe(3);
    });

    test("fremdes_widget: Nach dem Umhängen entscheidet der heutige Workspace - die früheren Zählwerte des Widgets gehören zu seinem Vorzeitraum", async () => {
      const kundeA = await createUser("default", [workspaceA.id]);
      const kundeB = await createUser("default", [workspaceB.id]);
      await EmbedConfig.update(embedB.id, { workspace_id: workspaceA.id });

      expect((await compared(embedB, FROM, TO, kundeB)).statusCode).toBe(403);
      const result = await compared(embedB, FROM, TO, kundeA);
      expect(result.statusCode).toBe(200);
      expect(result.body.previous.totals.messages).toBe(40);
    });

    test("fremdes_widget: admin und manager sind nicht eingeschränkt; ohne Anmeldung 401", async () => {
      for (const role of ["admin", "manager"]) {
        const user = await createUser(role);
        const result = await compared(embedB, FROM, TO, user);
        expect([role, result.statusCode]).toEqual([role, 200]);
        expect(result.body.previous.totals.messages).toBe(40);
      }
      previousSpy.mockClear();
      expect((await compared(embedA, FROM, TO)).statusCode).toBe(401);
      expect(previousSpy).not.toHaveBeenCalled();
    });

    test("fremdes_widget: unbekanntes Widget, embed_id 0 und Unsinn als Kennung mit Vergleich: 404 für admin - nie die Zähler der Workspace-Chats", async () => {
      const admin = await createUser("admin");
      await MessageLedger.transaction({ source: "test" }, (tx) =>
        MessageLedger.addCells(tx, [
          {
            workspaceId: workspaceA.id,
            embedId: 0,
            day: "2026-08-20",
            hour: 9,
            messages: 777,
          },
        ])
      );
      for (const embedId of [9999, 0, -1, "abc", "1.5"]) {
        const result = await compared(embedId, FROM, TO, admin);
        expect([embedId, result.statusCode]).toEqual([embedId, 404]);
        expect(result.body).toBeUndefined();
      }
      expect(previousSpy).not.toHaveBeenCalled();
    });

    test("fremdes_widget: DISABLE_VIEW_CHAT_HISTORY - auch der Vergleich endet mit 422 ohne Daten", async () => {
      const users = [
        await createUser("admin"),
        await createUser("default", [workspaceA.id]),
      ];
      process.env.DISABLE_VIEW_CHAT_HISTORY = "1";
      for (const user of users) {
        const result = await compared(embedA, FROM, TO, user);
        expect([user.role, result.statusCode]).toEqual([user.role, 422]);
        expect(String(result.body)).not.toMatch(/\d/);
      }
      expect(previousSpy).not.toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  // Nur Zahlen, Eingaben, Lesefunktion
  // --------------------------------------------------------------------------
  test("nur_zahlen: previous enthält nur Zählwerte und Kalendertage - keine Texte, keine Sitzungs- oder Verbindungsdaten", async () => {
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
    await countsOnly(embed, [{ day: "2011-07-01", messages: 1 }]);
    const chat = await chatAt(embed, berlinInstant("2026-10-05", 10), secrets);
    await EmbedChats.updateFeedbackScore(
      embed.id,
      secrets.session_id,
      chat.id,
      false
    );

    for (const [fromDay, toDay] of [
      ["2026-10-06", "2026-10-06"],
      ["2026-10-06", "2026-10-12"],
      ["2026-10-06", "2027-10-05"],
      ["2026-10-06", "2029-10-05"],
    ]) {
      const result = await compared(embed, fromDay, toDay);
      expect(result.statusCode).toBe(200);
      expect(Object.keys(result.body).sort()).toEqual([
        "buckets",
        "firstLedgerDay",
        "fromDay",
        "granularity",
        "previous",
        "success",
        "toDay",
        "totals",
      ]);
      const { previous } = result.body;
      expect(Object.keys(previous).sort()).toEqual([
        "available",
        "buckets",
        "fromDay",
        "toDay",
        "totals",
      ]);
      expect(previous.available).toBe(true);
      expect(previous.fromDay).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(previous.toDay).toBe("2026-10-05");
      expect(previous.totals).toEqual({
        messages: 1,
        conversations: 1,
        feedbackPositive: 0,
        feedbackNegative: 1,
      });
      expect(previous.buckets).toHaveLength(result.body.buckets.length);
      for (const bucket of previous.buckets) {
        const { start, end, partial, messages, conversations, hour, ...rest } =
          bucket;
        expect(rest).toEqual({});
        expect(start).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(end).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(partial).toBe(false);
        expect(Number.isInteger(messages)).toBe(true);
        expect(Number.isInteger(conversations)).toBe(true);
        if (hour !== undefined) expect(Number.isInteger(hour)).toBe(true);
      }

      const text = JSON.stringify(result.body);
      expect(text).not.toMatch(/GEHEIM/i);
      expect(text).not.toContain("203.0.113.77");
      expect(text).not.toContain("Arzttermin");
      expect(text).not.toMatch(/session|conversation_id|prompt|response|ip"/i);
    }
  });

  test("eingaben: Ein ungültiger Zeitraum endet auch mit Vergleich mit 400, bevor das Zählerbuch gelesen wird", async () => {
    const workspace = await createWorkspace(db.client);
    const embed = await createEmbed(db.client, workspace);
    await countsOnly(embed, [{ day: "2026-10-06", messages: 3 }]);
    const groupBy = jest.spyOn(db.client.message_ledger, "groupBy");
    const findFirst = jest.spyOn(db.client.message_ledger, "findFirst");

    for (const [fromDay, toDay] of [
      ["2026-10-07", "2026-10-06"],
      ["2026-02-30", "2026-03-05"],
      ["2019-02-28", "2026-10-12"], // 93 Kalendermonate
      ["06.10.2026", "12.10.2026"],
      [undefined, undefined],
    ]) {
      const result = await compared(embed, fromDay, toDay);
      expect([fromDay, result.statusCode]).toEqual([fromDay, 400]);
      expect(result.body).toEqual({
        success: false,
        error: expect.any(String),
      });
    }
    expect(previousSpy).not.toHaveBeenCalled();
    expect(groupBy).not.toHaveBeenCalled();
    expect(findFirst).not.toHaveBeenCalled();
  });

  describe("Lesefunktion (MessageLedger.previousTimelineForEmbed)", () => {
    test("liest nur: Das Zählerbuch ist nach den Abfragen mit Vergleich Byte für Byte dasselbe", async () => {
      const workspace = await createWorkspace(db.client);
      const embed = await createEmbed(db.client, workspace);
      await chatAt(embed, berlinInstant("2026-10-05", 10));
      await countsOnly(embed, [
        { day: "2026-09-01", messages: 5, conversationsStarted: 2 },
        { day: "2019-01-15", messages: 1 },
      ]);
      const before = await tableChecksum(db.client, "message_ledger");
      expect(before.rows).toBe(3);

      for (const [fromDay, toDay] of [
        ["2026-10-06", "2026-10-06"],
        ["2026-09-13", "2026-10-12"],
        ["2025-10-13", "2026-10-12"],
        ["2023-10-09", "2026-10-12"],
        ["2019-03-01", "2026-10-12"],
      ])
        expect((await compared(embed, fromDay, toDay)).statusCode).toBe(200);

      expect(previousSpy).toHaveBeenCalledTimes(5);
      expect(await tableChecksum(db.client, "message_ledger")).toEqual(before);
    });

    test("eine Abfrage mit festen Grenzen: von der früheren der beiden Untergrenzen bis zum Tag vor dem Zeitraum", async () => {
      const workspace = await createWorkspace(db.client);
      const embed = await createEmbed(db.client, workspace);
      const groupBy = jest.spyOn(db.client.message_ledger, "groupBy");
      const findFirst = jest.spyOn(db.client.message_ledger, "findFirst");

      for (const [fromDay, toDay, by, gte, lte] of [
        ["2026-10-12", "2026-10-12", "hour", "2026-10-11", "2026-10-11"],
        ["2026-09-13", "2026-10-12", "day", "2026-08-14", "2026-09-12"],
        // Wochen: Die Linie beginnt früher als die Kennzahlen.
        ["2025-10-15", "2026-10-12", "day", "2024-10-07", "2025-10-14"],
        // Monate: Die Linie beginnt einen Tag früher als die Kennzahlen.
        ["2024-11-01", "2026-10-31", "day", "2022-11-01", "2024-10-31"],
        // Monate: Die Kennzahlen beginnen einen Tag früher als die Linie.
        ["2023-11-01", "2025-10-31", "day", "2021-10-31", "2023-10-31"],
      ]) {
        groupBy.mockClear();
        findFirst.mockClear();
        await MessageLedger.previousTimelineForEmbed(
          embed.id,
          fromDay,
          toDay,
          null
        );
        expect(groupBy).toHaveBeenCalledTimes(1);
        expect(groupBy.mock.calls[0][0].by).toEqual([by]);
        expect(groupBy.mock.calls[0][0].where).toEqual({
          embed_id: embed.id,
          day: { gte, lte },
        });
        // firstLedgerDay wird übergeben, nicht noch einmal gelesen.
        expect(findFirst).not.toHaveBeenCalled();
      }
    });

    test("available: nur mit einem Kalendertag als Beginn der Zählung, der nicht nach dem Beginn des Vorzeitraums liegt", async () => {
      const workspace = await createWorkspace(db.client);
      const embed = await createEmbed(db.client, workspace);
      const available = async (firstLedgerDay) =>
        (
          await MessageLedger.previousTimelineForEmbed(
            embed.id,
            "2026-09-13",
            "2026-10-12",
            firstLedgerDay
          )
        ).available;

      expect(await available("2026-08-14")).toBe(true);
      expect(await available("2020-01-01")).toBe(true);
      expect(await available("2026-08-15")).toBe(false);
      expect(await available(null)).toBe(false);
      expect(await available(undefined)).toBe(false);
    });

    test("embed_id 0 (Workspace-Chats) und Unsinn als Kennung werfen, statt fremde Zähler zu liefern", async () => {
      const workspace = await createWorkspace(db.client);
      await MessageLedger.transaction({ source: "test" }, (tx) =>
        MessageLedger.addCells(tx, [
          {
            workspaceId: workspace.id,
            embedId: 0,
            day: "2026-08-20",
            hour: 9,
            messages: 777,
          },
        ])
      );
      const groupBy = jest.spyOn(db.client.message_ledger, "groupBy");
      for (const embedId of [0, -1, 1.5, "abc", null, undefined, NaN])
        await expect(
          MessageLedger.previousTimelineForEmbed(
            embedId,
            "2026-09-13",
            "2026-10-12",
            "2026-01-01"
          )
        ).rejects.toThrow(/invalid embedId/);
      expect(groupBy).not.toHaveBeenCalled();
    });

    test("ein ungültiger Zeitraum wirft vor der Abfrage", async () => {
      const workspace = await createWorkspace(db.client);
      const embed = await createEmbed(db.client, workspace);
      const groupBy = jest.spyOn(db.client.message_ledger, "groupBy");
      for (const [fromDay, toDay] of [
        ["2026-10-07", "2026-10-06"],
        ["2026-02-30", "2026-03-05"],
        ["2019-02-28", "2026-10-12"],
        [undefined, undefined],
      ])
        await expect(
          MessageLedger.previousTimelineForEmbed(embed.id, fromDay, toDay, null)
        ).rejects.toThrow(/timelineLayout/);
      expect(groupBy).not.toHaveBeenCalled();
    });

    test("ein Datenbankfehler im Vorzeitraum wird weitergereicht; der Endpunkt antwortet mit 500 ohne Zahlen - auch nicht die des Zeitraums", async () => {
      const workspace = await createWorkspace(db.client);
      const embed = await createEmbed(db.client, workspace);
      await countsOnly(embed, [
        { day: "2026-08-20", messages: 7 },
        { day: "2026-10-06", messages: 3 },
      ]);
      // Die Abfrage des Zeitraums gelingt, die des Vorzeitraums scheitert.
      const groupBy = db.client.message_ledger.groupBy.bind(
        db.client.message_ledger
      );
      jest
        .spyOn(db.client.message_ledger, "groupBy")
        .mockImplementationOnce((args) => groupBy(args))
        .mockRejectedValue(new Error("database is locked"));

      const result = await compared(embed, "2026-09-13", "2026-10-12");

      expect(timelineSpy).toHaveBeenCalledTimes(1);
      expect(previousSpy).toHaveBeenCalledTimes(1);
      expect(result.statusCode).toBe(500);
      expect(result.body).toBeUndefined();
      await expect(
        MessageLedger.previousTimelineForEmbed(
          embed.id,
          "2026-09-13",
          "2026-10-12",
          "2026-08-01"
        )
      ).rejects.toThrow("database is locked");
    });
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
      { fromDay: "2019-03-01", toDay: "2026-10-12" },
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
      ["2019-02-28", "2026-10-12"],
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
    // KIE-539: Die Route liest Zeitreihe und Raster in einer Anweisung.
    jest
      .spyOn(db.client, "$queryRaw")
      .mockRejectedValue(new Error("database is locked"));
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
        "weekdayHour",
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
// AK-7 — Klick auf eine Säule filtert die Liste: Tag, Kalenderwoche, Monat
// ============================================================================
describe("beginn_im_abschnitt (AK-7) über den Endpunkt", () => {
  // Der Browser sendet den Abschnitt der Säule als Kalendertage; die Berliner
  // Grenzen [00:00 des ersten Tages, 00:00 nach dem letzten) bildet der
  // Endpunkt. Dazu wie immer den Zeitraum der Ansicht als Zeitstempel.
  const VIEW = {
    startDate: "2026-09-12T22:00:00.000Z",
    endDate: "2026-11-12T22:59:59.999Z",
  };

  /** Je Eintrag eine Konversation, begonnen zur Berliner Wanduhrzeit. */
  async function startConversations(embed, entries) {
    for (const [name, day, hour, minute] of entries)
      await chatAt(embed, berlinInstant(day, hour, minute), {
        session_id: name,
        conversation_id: name,
      });
  }

  async function listed(embed, bucket, request = {}) {
    const result = await conversations(
      embed,
      conversationsBody({ ...VIEW, ...request, bucket })
    );
    expect(result.statusCode).toBe(200);
    expect(result.body.success).toBe(true);
    const names = result.body.conversations.map((c) => c.conversation_id);
    expect(result.body.totalCount).toBe(names.length);
    return names.sort();
  }

  test("beginn_im_abschnitt: Kalenderwoche 05.10.-11.10. - Montag 00:00 bis Sonntag 23:59 Berliner Zeit, nicht nur der Montag", async () => {
    const workspace = await createWorkspace(db.client);
    const embed = await createEmbed(db.client, workspace);
    await startConversations(embed, [
      ["a-so-2359", "2026-10-04", 23, 59],
      ["b-mo-0000", "2026-10-05", 0, 0],
      ["c-do-1200", "2026-10-08", 12, 0],
      ["d-so-2359", "2026-10-11", 23, 59],
      ["e-mo-0000", "2026-10-12", 0, 0],
      ["f-mo-2359", "2026-10-12", 23, 59],
      ["g-di-0000", "2026-10-13", 0, 0],
    ]);
    // Am Sonntag davor begonnen, in der Woche fortgesetzt: gehört zur Vorwoche.
    await chatAt(embed, berlinInstant("2026-10-06", 9, 0), {
      session_id: "a-so-2359",
      conversation_id: "a-so-2359",
    });

    expect(
      await listed(embed, { start: "2026-10-05", end: "2026-10-11" })
    ).toEqual(["b-mo-0000", "c-do-1200", "d-so-2359"]);

    // Angeschnittener Abschnitt „KW 42 - bis 12.10.": nur der Montag.
    expect(
      await listed(embed, { start: "2026-10-12", end: "2026-10-12" })
    ).toEqual(["e-mo-0000", "f-mo-2359"]);

    // Angeschnitten an beiden Enden: Dienstag bis Donnerstag der KW 41.
    expect(
      await listed(embed, { start: "2026-10-06", end: "2026-10-08" })
    ).toEqual(["c-do-1200"]);

    // Ohne Abschnitt: alle sieben.
    expect(await listed(embed, null)).toHaveLength(7);
  });

  test("beginn_im_abschnitt: Monat 01.10.-31.10. - vom Ersten 00:00 bis zum Letzten 23:59, über die Zeitumstellung hinweg", async () => {
    const workspace = await createWorkspace(db.client);
    const embed = await createEmbed(db.client, workspace);
    await startConversations(embed, [
      ["a-sep-30", "2026-09-30", 23, 59],
      ["b-okt-01", "2026-10-01", 0, 0],
      ["c-okt-12", "2026-10-12", 23, 59],
      ["d-okt-13", "2026-10-13", 0, 0],
      // 25.10.2026: Ende der Sommerzeit
      ["e-okt-25", "2026-10-25", 2, 30],
      ["f-okt-31", "2026-10-31", 23, 59],
      ["g-nov-01", "2026-11-01", 0, 0],
    ]);
    // Sommerzeit am Anfang, Winterzeit am Ende des Monats.
    expect(berlinInstant("2026-10-01", 0, 0).toISOString()).toBe(
      "2026-09-30T22:00:00.000Z"
    );
    expect(berlinInstant("2026-11-01", 0, 0).toISOString()).toBe(
      "2026-10-31T23:00:00.000Z"
    );

    expect(
      await listed(embed, { start: "2026-10-01", end: "2026-10-31" })
    ).toEqual(["b-okt-01", "c-okt-12", "d-okt-13", "e-okt-25", "f-okt-31"]);

    // Angeschnittener Abschnitt „Oktober 2026 - bis 12.10."
    expect(
      await listed(embed, { start: "2026-10-01", end: "2026-10-12" })
    ).toEqual(["b-okt-01", "c-okt-12"]);

    // Nachbarmonate nennen je genau ihre eine Konversation.
    expect(
      await listed(embed, { start: "2026-09-01", end: "2026-09-30" })
    ).toEqual(["a-sep-30"]);
    expect(
      await listed(embed, { start: "2026-11-01", end: "2026-11-30" })
    ).toEqual(["g-nov-01"]);
  });

  test("beginn_im_abschnitt: Blättern und Feedback-Filter gelten innerhalb des Abschnitts", async () => {
    const workspace = await createWorkspace(db.client);
    const embed = await createEmbed(db.client, workspace);
    await startConversations(embed, [
      ["a-vorwoche", "2026-10-04", 12, 0],
      ["b-mo", "2026-10-05", 9, 0],
      ["c-mi", "2026-10-07", 9, 0],
      ["d-so", "2026-10-11", 9, 0],
      ["e-folgewoche", "2026-10-12", 9, 0],
    ]);
    const week = { start: "2026-10-05", end: "2026-10-11" };

    const first = await conversations(
      embed,
      conversationsBody({ ...VIEW, limit: 2, bucket: week })
    );
    expect(first.body.totalCount).toBe(3);
    expect(first.body.hasMore).toBe(true);
    // jüngste zuerst
    expect(first.body.conversations.map((c) => c.conversation_id)).toEqual([
      "d-so",
      "c-mi",
    ]);
    const second = await conversations(
      embed,
      conversationsBody({ ...VIEW, offset: 2, limit: 2, bucket: week })
    );
    expect(second.body.hasMore).toBe(false);
    expect(second.body.conversations.map((c) => c.conversation_id)).toEqual([
      "b-mo",
    ]);

    // 👎 am Mittwoch und in der Folgewoche
    for (const name of ["c-mi", "e-folgewoche"]) {
      const chat = await db.client.embed_chats.findFirst({
        where: { conversation_id: name },
      });
      expect(
        await EmbedChats.updateFeedbackScore(embed.id, name, chat.id, false)
      ).toBeTruthy();
    }
    expect(await listed(embed, week, { feedbackFilter: "negative" })).toEqual([
      "c-mi",
    ]);
    expect(await listed(embed, week, { feedbackFilter: "positive" })).toEqual(
      []
    );
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
      "mehr als 92 Kalendermonate (93, um einen Tag)",
      { fromDay: "2019-02-28", toDay: "2026-10-12" },
    ],
    [
      "genau 10 Jahre (121 Kalendermonate)",
      { fromDay: "2016-10-13", toDay: "2026-10-12" },
    ],
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
      const queryRaw = jest.spyOn(db.client, "$queryRaw");

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
      expect(queryRaw).not.toHaveBeenCalled();
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

  test("eingaben: genau 92 Kalendermonate und ein einzelner Tag sind gültig", async () => {
    // Gegenprobe zu den Spionen oben: Ein gültiger Aufruf liest das Zählerbuch
    // (KIE-539: Zeitreihe und Raster in einer Anweisung, $queryRaw).
    const queryRaw = jest.spyOn(db.client, "$queryRaw");
    const findFirst = jest.spyOn(db.client.message_ledger, "findFirst");

    const longest = await summary(embed, {
      fromDay: "2019-03-01",
      toDay: "2026-10-12",
    });
    expect(longest.statusCode).toBe(200);
    expect(queryRaw).toHaveBeenCalledTimes(1);
    expect(findFirst).toHaveBeenCalledTimes(1);
    expect(timelineSpy).toHaveBeenCalledTimes(1);
    expect(longest.body.granularity).toBe("month");
    expect(longest.body.buckets).toHaveLength(92);
    expect(longest.body.totals.messages).toBe(3);

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
