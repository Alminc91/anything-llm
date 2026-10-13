/* eslint-env jest, node */
// KIE-538 — „Konversation löschen": EmbedChats.deleteConversation und
// deleteVisitorConversations über die Endpunkte
//   DELETE /embed/:embedId/conversation
//   DELETE /embed/:embedId/conversation/visitor
//   POST   /embed/:embedId/conversation/deletion-preview
// Die Kennung der Konversation steht jeweils im Rumpf ({ conversationId }).
//
// Geprüft wird gegen die echten Routen mit ihrer ganzen Middleware-Kette
// (endpoints/support/routeHarness.js: Anmeldung, Rollenprüfung, Bindung an
// den Workspace) und gegen eine echte SQLite-Datei aus den Migrationen
// (helpers/sqliteTestDatabase.js) - Löschanweisung, Zählerbuch, Kontingent
// und die Konversationsliste laufen wie im Betrieb.
//
// Die Zeitzone des Prozesses wird nicht gesetzt (TZ=UTC, Europe/Berlin und
// America/New_York: extras/scripts/testTimezones.mjs).
jest.mock(
  "../../utils/prisma",
  () => require("../helpers/sqliteTestDatabase").testPrisma
);
jest.mock("../../models/telemetry", () => ({
  Telemetry: { sendTelemetry: jest.fn(), flush: jest.fn() },
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
const { collectRoutes, invoke } = require("../endpoints/support/routeHarness");
const {
  ROUTES,
  summaryBody,
  conversationsBody,
  conversationBody,
} = require("../endpoints/support/embedAnalyticsRequests");
const {
  createTestDatabase,
  removeTestDatabases,
  createWorkspace,
  createEmbed,
  berlinCell,
  berlinInstant,
  eventsOf,
  ledgerRows,
  tableChecksum,
} = require("../helpers/sqliteTestDatabase");
const { makeJWT } = require("../../utils/http");
const { MessageLedger } = require("../../models/messageLedger");
const { EmbedChats } = require("../../models/embedChats");
const {
  runMessageLedgerBackfill,
} = require("../../utils/boot/messageLedgerBackfill");
const { getMessageLimitInfo } = require("../../utils/helpers");
const { embedManagementEndpoints } = require("../../endpoints/embedManagement");

const routes = collectRoutes(embedManagementEndpoints);
const route = ({ method, path }) => routes[`${method} ${path}`];
const DELETE_CONVERSATION = route(ROUTES.deleteConversation);
const DELETE_VISITOR = route(ROUTES.deleteVisitor);
const PREVIEW = route(ROUTES.deletionPreview);
const CONVERSATIONS = route(ROUTES.conversations);
const SUMMARY = route(ROUTES.summary);
const DETAIL = routes["GET /embed/:embedId/conversation/:sessionId"];
const OVERVIEW = routes["POST /embed/:embedId/analytics/overview"];

const DAY = 24 * 60 * 60 * 1000;

// Der erste Test jeder Datei erzeugt die Vorlage mit `prisma migrate deploy`.
jest.setTimeout(60000);

let db;
let errorSpy;
let logSpy;
let userCounter = 0;

beforeEach(async () => {
  MessageLedger._resetCache();
  EmbedChats._resetFeedbackLimits();
  delete process.env.DISABLE_VIEW_CHAT_HISTORY;
  db = await createTestDatabase();
  errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
  await setMultiUserMode(true);
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
 * EmbedChats.new: Chat-Zeile und Zähler in einer Transaktion.
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
          connection_information: JSON.stringify({ ip: "203.0.113.9" }),
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

/** n Nachrichten einer Konversation, eine Minute Abstand. */
async function converse(embed, { conversation, session, n, at, ...data }) {
  const chats = [];
  for (let i = 0; i < n; i++)
    chats.push(
      await chatAt(embed, new Date(at.getTime() + i * 60_000), {
        prompt: `${conversation ?? session}: Frage ${i + 1}`,
        conversation_id: conversation ?? null,
        session_id: session,
        ...data,
      })
    );
  return chats;
}

const call = (chain, embed, conversationId, user = null) =>
  invoke(chain, {
    params: { embedId: String(embed?.id ?? embed) },
    body: conversationBody(conversationId),
    token: user?.token ?? null,
  });
const deleteConversation = (embed, conversationId, user) =>
  call(DELETE_CONVERSATION, embed, conversationId, user);
const deleteVisitor = (embed, conversationId, user) =>
  call(DELETE_VISITOR, embed, conversationId, user);
const preview = (embed, conversationId, user) =>
  call(PREVIEW, embed, conversationId, user);

/** IDs der Konversationen, die die Liste des Widgets zeigt. */
async function listed(embed, user) {
  const result = await invoke(CONVERSATIONS, {
    params: { embedId: String(embed.id) },
    body: conversationsBody({ limit: 100 }),
    token: user?.token ?? null,
  });
  expect(result.statusCode).toBe(200);
  return result.body.conversations.map((c) => c.conversation_id).sort();
}

const chatIds = async (where = {}) =>
  (
    await db.client.embed_chats.findMany({
      where,
      orderBy: { id: "asc" },
      select: { id: true },
    })
  ).map((chat) => chat.id);

const T0 = () => berlinInstant("2026-10-06", 9, 0);

// ============================================================================
// AK-6 — Konversation löschen
// ============================================================================
describe("loescht_genau_diese (AK-6)", () => {
  let workspace, embed, otherEmbed, kunde;
  let target, others;

  beforeEach(async () => {
    workspace = await createWorkspace(db.client);
    embed = await createEmbed(db.client, workspace);
    otherEmbed = await createEmbed(db.client, workspace);
    kunde = await createUser("default", [workspace.id]);

    // Die Konversation mit vier Nachrichten …
    target = await converse(embed, {
      conversation: "ziel",
      session: "besucher-1",
      n: 4,
      at: T0(),
    });
    // … und alles, was stehen bleiben muss:
    others = [
      // andere Konversation derselben Browser-Sitzung
      ...(await converse(embed, {
        conversation: "nachbar",
        session: "besucher-1",
        n: 2,
        at: new Date(T0().getTime() + DAY),
      })),
      // Alt-Zeilen derselben Sitzung (ohne conversation_id)
      ...(await converse(embed, {
        session: "besucher-1",
        n: 2,
        at: new Date(T0().getTime() - DAY),
      })),
      // andere Sitzung
      ...(await converse(embed, {
        conversation: "fremd",
        session: "besucher-2",
        n: 3,
        at: T0(),
      })),
      // dieselbe conversation_id in einem anderen Widget
      ...(await converse(otherEmbed, {
        conversation: "ziel",
        session: "besucher-1",
        n: 2,
        at: T0(),
      })),
    ];
  });

  test("loescht_genau_diese: default-Nutzer im Workspace des Widgets löscht eine Konversation mit vier Nachrichten - sie verschwindet aus der Liste, die vier Zeilen sind aus embed_chats entfernt, das Ereignis nennt Nutzer, Widget und Anzahl", async () => {
    expect(await listed(embed, kunde)).toEqual([
      "besucher-1",
      "fremd",
      "nachbar",
      "ziel",
    ]);

    const result = await deleteConversation(embed, "ziel", kunde);

    expect(result.statusCode).toBe(200);
    expect(result.body).toEqual({ success: true, deletedCount: 4 });
    expect(await listed(embed, kunde)).toEqual([
      "besucher-1",
      "fremd",
      "nachbar",
    ]);
    // genau die vier Zeilen, sonst keine
    expect(await chatIds()).toEqual(
      others.map((chat) => chat.id).sort((a, b) => a - b)
    );
    expect(
      await db.client.embed_chats.count({
        where: { id: { in: target.map((chat) => chat.id) } },
      })
    ).toBe(0);
    // Die aufgeklappte Ansicht findet nichts mehr.
    const detail = await invoke(DETAIL, {
      params: { embedId: String(embed.id), sessionId: "ziel" },
      token: kunde.token,
    });
    expect(detail.body).toEqual({ success: true, messages: [] });

    const events = await eventsOf(db.client, "embed_conversation_deleted");
    expect(events).toHaveLength(1);
    expect(events[0].userId).toBe(kunde.id);
    expect(events[0].metadata).toEqual({ embedId: embed.id, deletedCount: 4 });
    expect(events[0].occurredAt).toBeInstanceOf(Date);
    expect(await db.client.event_logs.count()).toBe(1);
  });

  test("loescht_genau_diese: Das Protokoll enthält keine Inhalte, keine Konversations- oder Sitzungs-Kennung und keine Verbindungsdaten", async () => {
    await deleteConversation(embed, "ziel", kunde);
    const [log] = await db.client.event_logs.findMany();
    expect(Object.keys(JSON.parse(log.metadata)).sort()).toEqual([
      "deletedCount",
      "embedId",
    ]);
    expect(log.metadata).not.toMatch(/ziel|besucher|Frage|203\.0\.113/);
  });

  test("loescht_genau_diese: auch die vom Besucher bereits geleerten Zeilen (include = 0) der Konversation", async () => {
    await db.client.embed_chats.updateMany({
      where: { id: { in: target.slice(0, 3).map((chat) => chat.id) } },
      data: { include: false },
    });
    // Die Liste zählt nur noch eine Nachricht …
    const list = await invoke(CONVERSATIONS, {
      params: { embedId: String(embed.id) },
      body: conversationsBody({ limit: 100 }),
      token: kunde.token,
    });
    expect(
      list.body.conversations.find((c) => c.conversation_id === "ziel")
        .message_count
    ).toBe(1);
    // … die Vorschau nennt, was wirklich gelöscht wird.
    const before = await preview(embed, "ziel", kunde);
    expect(before.body.messageCount).toBe(4);

    const result = await deleteConversation(embed, "ziel", kunde);
    expect(result.body).toEqual({ success: true, deletedCount: 4 });
    expect(
      await db.client.embed_chats.count({
        where: { conversation_id: "ziel", embed_id: embed.id },
      })
    ).toBe(0);
    expect(await chatIds()).toEqual(
      others.map((chat) => chat.id).sort((a, b) => a - b)
    );
  });

  test("loescht_genau_diese: Alt-Konversation (ohne conversation_id) - gelöscht werden nur ihre Zeilen, nicht die übrigen Konversationen derselben Sitzung", async () => {
    // In der Liste trägt sie die session_id als ID.
    const result = await deleteConversation(embed, "besucher-1", kunde);

    expect(result.body).toEqual({ success: true, deletedCount: 2 });
    expect(await listed(embed, kunde)).toEqual(["fremd", "nachbar", "ziel"]);
    expect(
      await db.client.embed_chats.count({
        where: { embed_id: embed.id, session_id: "besucher-1" },
      })
    ).toBe(6);
    expect(
      await db.client.embed_chats.count({
        where: {
          embed_id: embed.id,
          session_id: "besucher-1",
          conversation_id: null,
        },
      })
    ).toBe(0);
  });

  test("loescht_genau_diese: Die session_id einer Sitzung ohne Alt-Zeilen bezeichnet keine Konversation - nichts wird gelöscht", async () => {
    const before = await chatIds();
    const result = await deleteConversation(embed, "besucher-2", kunde);
    expect(result.statusCode).toBe(404);
    expect(result.body).toEqual({ success: false, error: expect.any(String) });
    expect(await chatIds()).toEqual(before);
    expect(await db.client.event_logs.count()).toBe(0);
  });

  test("loescht_genau_diese: ein zweites Löschen findet nichts mehr - 404, kein weiteres Ereignis", async () => {
    expect((await deleteConversation(embed, "ziel", kunde)).statusCode).toBe(
      200
    );
    const again = await deleteConversation(embed, "ziel", kunde);
    expect(again.statusCode).toBe(404);
    expect(again.body.success).toBe(false);
    expect(
      await eventsOf(db.client, "embed_conversation_deleted")
    ).toHaveLength(1);
  });

  test("loescht_genau_diese: admin und manager löschen in jedem Widget, ohne Mitgliedschaft; ohne Mehrbenutzermodus wird nicht geprüft", async () => {
    const adminUser = await createUser("admin");
    const manager = await createUser("manager");

    expect((await deleteConversation(embed, "ziel", adminUser)).body).toEqual({
      success: true,
      deletedCount: 4,
    });
    expect((await deleteConversation(embed, "nachbar", manager)).body).toEqual({
      success: true,
      deletedCount: 2,
    });
    const events = await eventsOf(db.client, "embed_conversation_deleted");
    expect(events.map((event) => event.userId)).toEqual([
      adminUser.id,
      manager.id,
    ]);
    // unbekanntes Widget: 404 wie an den übrigen Widget-Endpunkten
    for (const embedId of ["9999", "abc", "0"])
      expect(
        (await deleteConversation(embedId, "fremd", adminUser)).statusCode
      ).toBe(404);

    await setMultiUserMode(false);
    expect((await deleteConversation(embed, "fremd")).body).toEqual({
      success: true,
      deletedCount: 3,
    });
    expect(
      (await eventsOf(db.client, "embed_conversation_deleted")).at(-1).userId
    ).toBeNull();
  });

  test("loescht_genau_diese: Die Vorschau nennt die Zahl der Zeilen und, was die Browser-Sitzung im Widget insgesamt hat - nur Zahlen", async () => {
    const result = await preview(embed, "ziel", kunde);
    expect(result.statusCode).toBe(200);
    expect(result.body).toEqual({
      success: true,
      messageCount: 4,
      // besucher-1 in diesem Widget: ziel (4), nachbar (2), Alt-Zeilen (2)
      visitor: { conversationCount: 3, messageCount: 8 },
    });
    expect((await preview(embed, "fremd", kunde)).body).toEqual({
      success: true,
      messageCount: 3,
      visitor: { conversationCount: 1, messageCount: 3 },
    });
    expect((await preview(embed, "gibt-es-nicht", kunde)).body).toEqual({
      success: true,
      messageCount: 0,
      visitor: null,
    });
    // Die Vorschau ändert nichts und protokolliert nichts.
    expect(await db.client.embed_chats.count()).toBe(13);
    expect(await db.client.event_logs.count()).toBe(0);
  });

  test("loescht_genau_diese: eine einzige Löschanweisung, gebunden an Widget und Konversation - das Modell meldet die Zahl der Zeilen, bei einem Datenbankfehler null", async () => {
    const deleteMany = jest.spyOn(db.client.embed_chats, "deleteMany");
    expect(await EmbedChats.deleteConversation(embed.id, "ziel")).toBe(4);
    expect(deleteMany).toHaveBeenCalledTimes(1);
    expect(deleteMany.mock.calls[0][0]).toEqual({
      where: {
        embed_id: embed.id,
        OR: [
          { conversation_id: "ziel" },
          { conversation_id: null, session_id: "ziel" },
        ],
      },
    });

    // Unbrauchbare Angaben: kein Datenbankzugriff, 0 Zeilen
    deleteMany.mockClear();
    for (const [embedId, conversationId] of [
      [embed.id, ""],
      [embed.id, null],
      [embed.id, undefined],
      [embed.id, { conversation_id: "nachbar" }],
      [embed.id, ["nachbar"]],
      [0, "nachbar"],
      [-1, "nachbar"],
      [NaN, "nachbar"],
      ["abc", "nachbar"],
      [null, "nachbar"],
    ])
      expect(await EmbedChats.deleteConversation(embedId, conversationId)).toBe(
        0
      );
    expect(deleteMany).not.toHaveBeenCalled();
    expect(await db.client.embed_chats.count()).toBe(9);

    deleteMany.mockRejectedValueOnce(new Error("database is locked"));
    expect(await EmbedChats.deleteConversation(embed.id, "nachbar")).toBeNull();
    deleteMany.mockRejectedValueOnce(new Error("database is locked"));
    const failed = await deleteConversation(embed, "nachbar", kunde);
    expect(failed.statusCode).toBe(500);
    expect(await db.client.event_logs.count()).toBe(0);
  });
});

// ============================================================================
// AK-7 — Löschen ändert Statistik und Kontingent nicht
// ============================================================================
describe("zaehlerbuch_unveraendert (AK-7)", () => {
  const quiet = { log: () => {} };
  let workspace, embed, admin, day;

  async function usage() {
    const fresh = await db.client.workspaces.findUnique({
      where: { id: workspace.id },
    });
    return (await getMessageLimitInfo(fresh, new Date())).messageCount;
  }
  async function chartDay() {
    const result = await invoke(SUMMARY, {
      params: { embedId: String(embed.id) },
      // Zwei Tage, damit die Antwort Tages-Abschnitte hat (ein einzelner Tag
      // käme als 24 Stunden).
      body: summaryBody(day, berlinCell(Date.now() - 2 * DAY).day),
      token: admin.token,
    });
    expect(result.statusCode).toBe(200);
    return result.body;
  }

  beforeEach(async () => {
    workspace = await createWorkspace(db.client, {
      messagesLimit: 1000,
      cycleStartDate: new Date(Date.now() - 20 * DAY),
      cycleDurationMonths: 1,
    });
    embed = await createEmbed(db.client, workspace);
    admin = await createUser("admin");
    // Nachtrag abgeschlossen: Das Kontingent liest das Zählerbuch (KIE-532),
    // nicht die Zeilen. Alles Folgende wird beim Anlegen gezählt.
    const backfill = await runMessageLedgerBackfill(quiet);
    expect(backfill.ok).toBe(true);
    expect(backfill.state.state).toBe("complete");
    // Tag der Konversation: vor drei Tagen (Berliner Kalender)
    day = berlinCell(Date.now() - 3 * DAY).day;

    // 80 Nachrichten an einem früheren Tag des laufenden Zyklus …
    const earlier = berlinInstant(berlinCell(Date.now() - 6 * DAY).day, 10, 0);
    for (let i = 0; i < 80; i++)
      await chatAt(embed, new Date(earlier.getTime() + i * 60_000), {
        session_id: `frueher-${i % 20}`,
        conversation_id: `frueher-${i % 20}`,
      });
    // … und 40 am Tag der Konversation: 36 in neun anderen, 4 in dieser.
    const noon = berlinInstant(day, 12, 0);
    for (let i = 0; i < 36; i++)
      await chatAt(embed, new Date(noon.getTime() + i * 60_000), {
        session_id: `tag-${i % 9}`,
        conversation_id: `tag-${i % 9}`,
      });
    await converse(embed, {
      conversation: "ziel",
      session: "besucher",
      n: 4,
      at: new Date(noon.getTime() + 3_600_000),
    });
  });

  test("zaehlerbuch_unveraendert: Verbrauch 120 und 40 Nachrichten im Diagramm am Tag der Konversation - nach dem Löschen bleiben Verbrauch und Diagrammwert unverändert", async () => {
    // Bewertung in der Konversation: auch sie bleibt gezählt.
    const rated = await db.client.embed_chats.findFirst({
      where: { conversation_id: "ziel" },
    });
    expect(
      await EmbedChats.updateFeedbackScore(
        embed.id,
        "besucher",
        rated.id,
        false
      )
    ).toBe(true);

    expect(await usage()).toBe(120);
    const before = await chartDay();
    expect(before.buckets[0]).toEqual(
      expect.objectContaining({
        start: day,
        end: day,
        messages: 40,
        conversations: 10,
      })
    );
    expect(before.totals).toEqual(
      expect.objectContaining({
        messages: 40,
        conversations: 10,
        feedbackNegative: 1,
      })
    );
    const ledgerBefore = await tableChecksum(db.client, "message_ledger");
    const rowsBefore = await ledgerRows(db.client);

    const result = await deleteConversation(embed, "ziel", admin);
    expect(result.body).toEqual({ success: true, deletedCount: 4 });
    expect(await db.client.embed_chats.count()).toBe(116);

    // Kontingent, Diagramm und Kennzahlen: unverändert
    expect(await usage()).toBe(120);
    expect(await chartDay()).toEqual(before);
    // Das Zählerbuch ist Byte für Byte dasselbe.
    expect(await tableChecksum(db.client, "message_ledger")).toEqual(
      ledgerBefore
    );
    expect(await ledgerRows(db.client)).toEqual(rowsBefore);
    expect(await eventsOf(db.client, "message_ledger_mismatch")).toEqual([]);

    // Die Inhalte sind dagegen weg: Die aus embed_chats gerechnete Übersicht
    // zählt vier Nachrichten weniger.
    const overview = await invoke(OVERVIEW, {
      params: { embedId: String(embed.id) },
      body: {},
      token: admin.token,
    });
    expect(overview.body.stats.total_chats).toBe(116);
    expect(overview.body.stats.feedback_negative).toBe(0);
  });

  test("zaehlerbuch_unveraendert: auch „Alle Konversationen dieses Besuchers löschen“ ändert weder Verbrauch noch Diagramm", async () => {
    await converse(embed, {
      conversation: "ziel-2",
      session: "besucher",
      n: 3,
      at: new Date(berlinInstant(day, 15, 0)),
    });
    expect(await usage()).toBe(123);
    const before = await chartDay();
    expect(before.buckets[0].messages).toBe(43);
    const ledgerBefore = await tableChecksum(db.client, "message_ledger");

    const result = await deleteVisitor(embed, "ziel", admin);
    expect(result.body).toEqual({
      success: true,
      deletedCount: 7,
      conversationCount: 2,
    });

    expect(await usage()).toBe(123);
    expect(await chartDay()).toEqual(before);
    expect(await tableChecksum(db.client, "message_ledger")).toEqual(
      ledgerBefore
    );
  });

  test("zaehlerbuch_unveraendert: Eine nach dem Löschen fortgesetzte Konversation zählt ihre neuen Nachrichten - nichts wird zurückgebucht", async () => {
    await deleteConversation(embed, "ziel", admin);
    await EmbedChats.new({
      embedId: embed.id,
      prompt: "weiter",
      sessionId: "besucher",
      conversationId: "ziel",
    });
    expect(await usage()).toBe(121);
  });
});

// ============================================================================
// AK-12 — Alle Konversationen eines Besuchers löschen
// ============================================================================
describe("ganze_sitzung (AK-12)", () => {
  let workspace, embed, otherEmbed, kunde;
  let survivors;

  beforeEach(async () => {
    workspace = await createWorkspace(db.client);
    embed = await createEmbed(db.client, workspace);
    otherEmbed = await createEmbed(db.client, workspace);
    kunde = await createUser("default", [workspace.id]);
    const at = (days) => new Date(T0().getTime() + days * DAY);

    // Die Browser-Sitzung „besucher" hat in diesem Widget vier Konversationen:
    await converse(embed, {
      conversation: "k-1",
      session: "besucher",
      n: 4,
      at: at(0),
    });
    await converse(embed, {
      conversation: "k-2",
      session: "besucher",
      n: 2,
      at: at(1),
    });
    // … eine davon vom Besucher selbst geleert …
    await converse(embed, {
      conversation: "k-3",
      session: "besucher",
      n: 3,
      at: at(2),
      include: false,
    });
    // … und eine aus Alt-Zeilen ohne conversation_id.
    await converse(embed, { session: "besucher", n: 2, at: at(-5) });

    survivors = [
      // andere Sitzungen im selben Widget
      ...(await converse(embed, {
        conversation: "a-1",
        session: "anderer",
        n: 2,
        at: at(0),
      })),
      ...(await converse(embed, { session: "alt-anderer", n: 1, at: at(-5) })),
      // dieselbe Sitzungs-Kennung in einem anderen Widget
      ...(await converse(otherEmbed, {
        conversation: "k-9",
        session: "besucher",
        n: 2,
        at: at(0),
      })),
    ];
  });

  test("ganze_sitzung: Die Sitzung der aufgeklappten Konversation hat drei weitere Konversationen im Widget - alle vier sind gelöscht, Konversationen anderer Sitzungen bleiben", async () => {
    // Die Rückfrage nennt die Anzahl.
    expect((await preview(embed, "k-1", kunde)).body).toEqual({
      success: true,
      messageCount: 4,
      visitor: { conversationCount: 4, messageCount: 11 },
    });

    const result = await deleteVisitor(embed, "k-1", kunde);

    expect(result.statusCode).toBe(200);
    expect(result.body).toEqual({
      success: true,
      deletedCount: 11,
      conversationCount: 4,
    });
    expect(
      await db.client.embed_chats.count({
        where: { embed_id: embed.id, session_id: "besucher" },
      })
    ).toBe(0);
    expect(await chatIds()).toEqual(
      survivors.map((chat) => chat.id).sort((a, b) => a - b)
    );
    expect(await listed(embed, kunde)).toEqual(["a-1", "alt-anderer"]);
    expect(await listed(otherEmbed, kunde)).toEqual(["k-9"]);

    const events = await eventsOf(
      db.client,
      "embed_visitor_conversations_deleted"
    );
    expect(events).toHaveLength(1);
    expect(events[0].userId).toBe(kunde.id);
    expect(events[0].metadata).toEqual({
      embedId: embed.id,
      conversationCount: 4,
      deletedCount: 11,
    });
    // Weder Antwort noch Protokoll nennen die Sitzung.
    expect(JSON.stringify(result.body) + events[0].metadata).not.toMatch(
      /besucher/
    );
    expect(await db.client.event_logs.count()).toBe(1);
  });

  test("ganze_sitzung: von jeder Konversation der Sitzung aus - auch von der Alt-Konversation", async () => {
    // Die Alt-Konversation trägt in der Liste die session_id als ID.
    expect((await preview(embed, "besucher", kunde)).body.visitor).toEqual({
      conversationCount: 4,
      messageCount: 11,
    });
    const result = await deleteVisitor(embed, "besucher", kunde);
    expect(result.body).toEqual({
      success: true,
      deletedCount: 11,
      conversationCount: 4,
    });
    expect(await chatIds()).toEqual(
      survivors.map((chat) => chat.id).sort((a, b) => a - b)
    );
  });

  test("ganze_sitzung: Eine Sitzung mit nur dieser einen Konversation - die Vorschau nennt 1 (kein Angebot), das Löschen entfernt nur sie", async () => {
    expect((await preview(embed, "a-1", kunde)).body.visitor).toEqual({
      conversationCount: 1,
      messageCount: 2,
    });
    const result = await deleteVisitor(embed, "a-1", kunde);
    expect(result.body).toEqual({
      success: true,
      deletedCount: 2,
      conversationCount: 1,
    });
    expect(
      await db.client.embed_chats.count({ where: { embed_id: embed.id } })
    ).toBe(12);
  });

  test("ganze_sitzung: Gehören die Zeilen einer Konversation zu mehr als einer Sitzung, wird nichts gelöscht (409) und nichts angeboten", async () => {
    // Dieselbe conversation_id, von einer zweiten Sitzung gesendet
    await converse(embed, {
      conversation: "k-1",
      session: "anderer",
      n: 1,
      at: T0(),
    });
    const before = await chatIds();

    expect((await preview(embed, "k-1", kunde)).body).toEqual({
      success: true,
      messageCount: 5,
      visitor: null,
    });
    const result = await deleteVisitor(embed, "k-1", kunde);
    expect(result.statusCode).toBe(409);
    expect(result.body).toEqual({ success: false, error: expect.any(String) });
    expect(await chatIds()).toEqual(before);
    expect(await db.client.event_logs.count()).toBe(0);
  });

  test("ganze_sitzung: unbekannte Konversation und Konversation eines anderen Widgets - 404, nichts gelöscht", async () => {
    const before = await chatIds();
    for (const conversationId of ["gibt-es-nicht", "k-9", "%", "' OR 1=1 --"]) {
      const result = await deleteVisitor(embed, conversationId, kunde);
      expect([conversationId, result.statusCode]).toEqual([
        conversationId,
        404,
      ]);
    }
    expect(await chatIds()).toEqual(before);
    expect(await db.client.event_logs.count()).toBe(0);
  });

  test("ganze_sitzung: dieselben Prüfungen wie beim Löschen einer Konversation - fremdes Widget 403, ohne Anmeldung 401, Chat-Verlauf abgeschaltet 422", async () => {
    const fremd = await createUser("default", []);
    const before = await chatIds();

    expect((await deleteVisitor(embed, "k-1", fremd)).statusCode).toBe(403);
    expect((await deleteVisitor(embed, "k-1", null)).statusCode).toBe(401);
    process.env.DISABLE_VIEW_CHAT_HISTORY = "1";
    for (const user of [
      kunde,
      await createUser("admin"),
      await createUser("manager"),
    ])
      expect((await deleteVisitor(embed, "k-1", user)).statusCode).toBe(422);

    expect(await chatIds()).toEqual(before);
    expect(await db.client.event_logs.count()).toBe(0);
  });

  test("ganze_sitzung: eine einzige Löschanweisung, gebunden an Widget und Sitzung", async () => {
    const deleteMany = jest.spyOn(db.client.embed_chats, "deleteMany");
    expect(
      await EmbedChats.deleteVisitorConversations(embed.id, "k-2")
    ).toEqual({
      deletedCount: 11,
      conversationCount: 4,
      ambiguous: false,
    });
    expect(deleteMany).toHaveBeenCalledTimes(1);
    expect(deleteMany.mock.calls[0][0]).toEqual({
      where: { embed_id: embed.id, session_id: "besucher" },
    });

    deleteMany.mockClear();
    for (const [embedId, conversationId] of [
      [embed.id, ""],
      [embed.id, null],
      [embed.id, { session_id: "anderer" }],
      [0, "a-1"],
      ["abc", "a-1"],
    ])
      expect(
        await EmbedChats.deleteVisitorConversations(embedId, conversationId)
      ).toEqual({ deletedCount: 0, conversationCount: 0, ambiguous: false });
    expect(deleteMany).not.toHaveBeenCalled();
  });
});

// ============================================================================
// Die Kennung der Konversation steht im Rumpf, nie in der Adresse
// ============================================================================
// Die conversation_id vergibt der Besucher (der öffentliche Chat-Endpunkt
// speichert sie ungeprüft). Als Teil der Adresse würde ein Browser "." und
// ".." als Pfadsegmente auflösen - aus „Konversation .. löschen" würde
// DELETE /embed/:embedId, das Löschen des ganzen Widgets.
describe("kennung_im_rumpf", () => {
  const express = require("express");
  const TRICKY = ["..", ".", "%2e%2e", "../..", "a/../../b", "x?y#z", "ä ö"];
  let workspace, embed, kunde, rest;

  beforeEach(async () => {
    workspace = await createWorkspace(db.client);
    embed = await createEmbed(db.client, workspace);
    kunde = await createUser("default", [workspace.id]);
    for (const [i, conversation] of TRICKY.entries())
      await converse(embed, {
        conversation,
        session: `besucher-${i}`,
        n: 2,
        at: new Date(T0().getTime() + i * 3_600_000),
      });
    rest = await converse(embed, {
      conversation: "bleibt",
      session: "anderer",
      n: 3,
      at: T0(),
    });
  });

  /**
   * Die Anfrage, wie sie beim Server ankommt: Die Adresse löst ein Browser
   * vor dem Senden auf (WHATWG URL, wie fetch), der echte Express-Router
   * ordnet sie einer Route zu. Der Rumpf ist Text, wie das Frontend ihn
   * sendet (JSON ohne Content-Type: bodyParser.text).
   */
  function send(route, conversationId, user) {
    const address = `/api${route.path.replace(":embedId", embed.id)}`;
    const { pathname } = new URL(
      address,
      "https://kunde.example.org/settings/chatbot/conversations"
    );
    const router = express.Router();
    embedManagementEndpoints(router);
    const headers = { authorization: `Bearer ${user.token}` };
    return new Promise((resolve, reject) => {
      const result = { address, pathname, statusCode: 200, body: undefined };
      const done = () => resolve(result);
      const response = {
        locals: {},
        status: (code) => {
          result.statusCode = code;
          return response;
        },
        sendStatus: (code) => {
          result.statusCode = code;
          done();
          return response;
        },
        json: (payload) => {
          result.body = payload;
          done();
          return response;
        },
        send: (payload) => {
          result.body = payload;
          done();
          return response;
        },
        setHeader: () => {},
        end: () => {
          done();
          return response;
        },
      };
      const request = {
        method: route.method,
        url: pathname.replace(/^\/api/, ""),
        headers,
        header: (name) => headers[String(name).toLowerCase()],
        params: {},
        query: {},
        body: JSON.stringify(conversationBody(conversationId)),
      };
      router.handle(request, response, (error) =>
        error ? reject(error) : resolve({ ...result, statusCode: 404 })
      );
    });
  }

  test("kennung_im_rumpf: Konversationen mit den Kennungen „..“ und „.“ stehen in der Liste und lassen sich löschen - genau ihre Zeilen, das Widget bleibt", async () => {
    expect(await listed(embed, kunde)).toEqual([...TRICKY, "bleibt"].sort());

    for (const id of TRICKY) {
      expect((await preview(embed, id, kunde)).body).toEqual({
        success: true,
        messageCount: 2,
        visitor: { conversationCount: 1, messageCount: 2 },
      });
      const result = await deleteConversation(embed, id, kunde);
      expect([id, result.statusCode, result.body]).toEqual([
        id,
        200,
        { success: true, deletedCount: 2 },
      ]);
    }

    expect(await chatIds()).toEqual(rest.map((chat) => chat.id));
    expect(await listed(embed, kunde)).toEqual(["bleibt"]);
    // Das Widget ist noch da - gelöscht wurden Konversationen, sonst nichts.
    expect(await db.client.embed_configs.count()).toBe(1);
    expect(await eventsOf(db.client, "embed_deleted")).toEqual([]);
    expect(
      await eventsOf(db.client, "embed_conversation_deleted")
    ).toHaveLength(TRICKY.length);
  });

  test("kennung_im_rumpf: durch den echten Express-Router, mit der Adresse, wie ein Browser sie auflöst - Vorschau, Löschen und „alle des Besuchers“ treffen ihre Route, das Widget bleibt", async () => {
    for (const id of TRICKY) {
      const look = await send(ROUTES.deletionPreview, id, kunde);
      // Die Adresse enthält nichts vom Besucher: Es gibt nichts aufzulösen.
      expect([id, look.pathname]).toEqual([id, look.address]);
      expect([id, look.statusCode, look.body]).toEqual([
        id,
        200,
        {
          success: true,
          messageCount: 2,
          visitor: { conversationCount: 1, messageCount: 2 },
        },
      ]);
    }

    const [first, second, ...others] = TRICKY;
    const one = await send(ROUTES.deleteConversation, first, kunde);
    expect(one.pathname).toBe(`/api/embed/${embed.id}/conversation`);
    expect([one.statusCode, one.body]).toEqual([
      200,
      { success: true, deletedCount: 2 },
    ]);
    const all = await send(ROUTES.deleteVisitor, second, kunde);
    expect(all.pathname).toBe(`/api/embed/${embed.id}/conversation/visitor`);
    expect([all.statusCode, all.body]).toEqual([
      200,
      { success: true, deletedCount: 2, conversationCount: 1 },
    ]);
    for (const id of others)
      expect((await send(ROUTES.deleteConversation, id, kunde)).body).toEqual({
        success: true,
        deletedCount: 2,
      });

    expect(await chatIds()).toEqual(rest.map((chat) => chat.id));
    expect(await db.client.embed_configs.count()).toBe(1);
    expect(await eventsOf(db.client, "embed_deleted")).toEqual([]);
  });

  test("kennung_im_rumpf: ohne Kennung im Rumpf trifft die Anfrage keine Zeile - 404, nichts gelöscht; eine Kennung in der Adresse zählt nicht", async () => {
    const before = await tableChecksum(db.client, "embed_chats");
    for (const body of [
      undefined,
      {},
      null,
      "null",
      "{}",
      '".."',
      { conversationId: null },
      { conversationId: "" },
      { conversationId: ["bleibt"] },
      { conversationId: { equals: "bleibt" } },
      { conversation_id: "bleibt" },
      { sessionId: "anderer" },
    ])
      for (const chain of [DELETE_CONVERSATION, DELETE_VISITOR]) {
        const result = await invoke(chain, {
          // wie früher in der Adresse: wird nicht gelesen
          params: { embedId: String(embed.id), conversationId: "bleibt" },
          body,
          token: kunde.token,
        });
        expect([JSON.stringify(body), result.statusCode]).toEqual([
          JSON.stringify(body),
          404,
        ]);
      }
    expect(
      (
        await invoke(PREVIEW, {
          params: { embedId: String(embed.id), conversationId: "bleibt" },
          body: {},
          token: kunde.token,
        })
      ).body
    ).toEqual({ success: true, messageCount: 0, visitor: null });
    expect(await tableChecksum(db.client, "embed_chats")).toEqual(before);
    expect(await db.client.event_logs.count()).toBe(0);

    // Der Rumpf als Text, wie das Frontend ihn sendet
    const result = await invoke(DELETE_CONVERSATION, {
      params: { embedId: String(embed.id) },
      body: JSON.stringify(conversationBody("bleibt")),
      token: kunde.token,
    });
    expect(result.body).toEqual({ success: true, deletedCount: 3 });
  });
});

// ============================================================================
// NAK-2 — Kein Löschen fremder Konversationen
// ============================================================================
describe("fremde_konversation (NAK-2)", () => {
  let workspaceA, workspaceB, widgetA, widgetA2, widgetB, kunde;

  beforeEach(async () => {
    workspaceA = await createWorkspace(db.client);
    workspaceB = await createWorkspace(db.client);
    widgetA = await createEmbed(db.client, workspaceA);
    widgetA2 = await createEmbed(db.client, workspaceA);
    widgetB = await createEmbed(db.client, workspaceB);
    kunde = await createUser("default", [workspaceA.id]);

    await converse(widgetA, {
      conversation: "a-eigen",
      session: "s-a",
      n: 2,
      at: T0(),
    });
    await converse(widgetA2, {
      conversation: "a2-eigen",
      session: "s-a2",
      n: 2,
      at: T0(),
    });
    await converse(widgetB, {
      conversation: "b-fremd",
      session: "s-b",
      n: 3,
      at: T0(),
    });
    await converse(widgetB, { session: "s-b-alt", n: 2, at: T0() });
    // dieselbe Kennung in A und B
    await converse(widgetA, {
      conversation: "doppelt",
      session: "s-a",
      n: 1,
      at: T0(),
    });
    await converse(widgetB, {
      conversation: "doppelt",
      session: "s-b",
      n: 4,
      at: T0(),
    });
  });

  test("fremde_konversation: conversationId eines anderen Workspaces über das eigene Widget - keine Zeile wird gelöscht", async () => {
    const before = await tableChecksum(db.client, "embed_chats");
    for (const conversationId of ["b-fremd", "s-b-alt", "s-b"]) {
      for (const chain of [DELETE_CONVERSATION, DELETE_VISITOR]) {
        const result = await call(chain, widgetA, conversationId, kunde);
        expect([conversationId, result.statusCode]).toEqual([
          conversationId,
          404,
        ]);
        expect(result.body).toEqual({
          success: false,
          error: expect.any(String),
        });
      }
      expect((await preview(widgetA, conversationId, kunde)).body).toEqual({
        success: true,
        messageCount: 0,
        visitor: null,
      });
    }
    expect(await tableChecksum(db.client, "embed_chats")).toEqual(before);
    expect(await db.client.event_logs.count()).toBe(0);
  });

  test("fremde_konversation: das fremde Widget selbst - 403 ohne Angaben, keine Zeile wird gelöscht, nichts wird abgefragt", async () => {
    const before = await tableChecksum(db.client, "embed_chats");
    const deleteOne = jest.spyOn(EmbedChats, "deleteConversation");
    const deleteAll = jest.spyOn(EmbedChats, "deleteVisitorConversations");
    const look = jest.spyOn(EmbedChats, "conversationDeletionPreview");

    for (const conversationId of ["b-fremd", "doppelt", "a-eigen"])
      for (const chain of [DELETE_CONVERSATION, DELETE_VISITOR, PREVIEW]) {
        const result = await call(chain, widgetB, conversationId, kunde);
        expect(result.statusCode).toBe(403);
        expect(result.body).toBeUndefined();
      }
    // ein unbekanntes Widget ist von einem fremden nicht zu unterscheiden
    for (const embedId of ["9999", "abc", "-1", "0"])
      expect(
        (await deleteConversation(embedId, "b-fremd", kunde)).statusCode
      ).toBe(403);

    expect(deleteOne).not.toHaveBeenCalled();
    expect(deleteAll).not.toHaveBeenCalled();
    expect(look).not.toHaveBeenCalled();
    expect(await tableChecksum(db.client, "embed_chats")).toEqual(before);
    expect(await db.client.event_logs.count()).toBe(0);
  });

  test("fremde_konversation: conversationId eines anderen Widgets desselben Workspaces - keine Zeile wird gelöscht", async () => {
    const before = await tableChecksum(db.client, "embed_chats");
    expect(
      (await deleteConversation(widgetA, "a2-eigen", kunde)).statusCode
    ).toBe(404);
    expect(
      (await deleteConversation(widgetA2, "a-eigen", kunde)).statusCode
    ).toBe(404);
    expect((await deleteVisitor(widgetA, "a2-eigen", kunde)).statusCode).toBe(
      404
    );
    expect(await tableChecksum(db.client, "embed_chats")).toEqual(before);
  });

  test("fremde_konversation: Dieselbe Kennung in zwei Widgets - gelöscht wird nur im genannten Widget", async () => {
    const result = await deleteConversation(widgetA, "doppelt", kunde);
    expect(result.body).toEqual({ success: true, deletedCount: 1 });
    expect(
      await db.client.embed_chats.count({
        where: { conversation_id: "doppelt", embed_id: widgetB.id },
      })
    ).toBe(4);
    expect(
      await db.client.embed_chats.count({ where: { embed_id: widgetB.id } })
    ).toBe(9);
  });

  test("fremde_konversation: Platzhalter, SQL-Bruchstücke und Sonderzeichen als Kennung treffen keine Zeile", async () => {
    const before = await tableChecksum(db.client, "embed_chats");
    for (const conversationId of [
      "%",
      "_",
      "a-%",
      "*",
      "' OR '1'='1",
      "a-eigen' --",
      'a-eigen" OR ""="',
      "a-eigen\u0000",
      " a-eigen",
      "A-EIGEN",
      "null",
      "undefined",
    ])
      for (const chain of [DELETE_CONVERSATION, DELETE_VISITOR]) {
        const result = await call(chain, widgetA, conversationId, kunde);
        expect([conversationId, result.statusCode]).toEqual([
          conversationId,
          404,
        ]);
      }
    expect(await tableChecksum(db.client, "embed_chats")).toEqual(before);
    expect(await db.client.event_logs.count()).toBe(0);
  });

  test("fremde_konversation: Nach dem Umhängen des Widgets entscheidet dessen heutiger Workspace", async () => {
    await db.client.embed_configs.update({
      where: { id: widgetA.id },
      data: { workspace_id: workspaceB.id },
    });
    const result = await deleteConversation(widgetA, "a-eigen", kunde);
    expect(result.statusCode).toBe(403);
    expect(
      await db.client.embed_chats.count({
        where: { conversation_id: "a-eigen" },
      })
    ).toBe(2);
  });
});

// ============================================================================
// NAK-5 — Kein Löschen ohne Einsichtsrecht
// ============================================================================
describe("ohne_einsichtsrecht (NAK-5)", () => {
  let workspace, embed, users;

  beforeEach(async () => {
    workspace = await createWorkspace(db.client);
    embed = await createEmbed(db.client, workspace);
    users = {
      admin: await createUser("admin"),
      manager: await createUser("manager"),
      default: await createUser("default", [workspace.id]),
    };
    await converse(embed, {
      conversation: "ziel",
      session: "besucher",
      n: 4,
      at: T0(),
    });
  });

  const CHAINS = () => [DELETE_CONVERSATION, DELETE_VISITOR, PREVIEW];

  test("ohne_einsichtsrecht: Chat-Verlauf der Instanz nicht einsehbar - kein Löschen für keine Rolle, dieselbe Ablehnung wie die Konversationsliste", async () => {
    process.env.DISABLE_VIEW_CHAT_HISTORY = "1";
    const deleteMany = jest.spyOn(db.client.embed_chats, "deleteMany");

    for (const user of Object.values(users)) {
      const list = await invoke(CONVERSATIONS, {
        params: { embedId: String(embed.id) },
        body: conversationsBody(),
        token: user.token,
      });
      expect(list.statusCode).toBe(422);
      for (const chain of CHAINS()) {
        const result = await call(chain, embed, "ziel", user);
        expect([user.role, result.statusCode]).toEqual([user.role, 422]);
        expect(result.body).toBe(list.body);
      }
    }
    // auch mit leerem Wert der Variable und ohne Mehrbenutzermodus
    process.env.DISABLE_VIEW_CHAT_HISTORY = "";
    await setMultiUserMode(false);
    for (const chain of CHAINS())
      expect((await call(chain, embed, "ziel")).statusCode).toBe(422);

    expect(deleteMany).not.toHaveBeenCalled();
    expect(await db.client.embed_chats.count()).toBe(4);
    expect(await db.client.event_logs.count()).toBe(0);
  });

  test("ohne_einsichtsrecht: nicht angemeldet - 401, keine Zeile wird gelöscht", async () => {
    for (const chain of CHAINS()) {
      expect((await call(chain, embed, "ziel", null)).statusCode).toBe(401);
      expect(
        (await call(chain, embed, "ziel", { token: "kein.gültiges.token" }))
          .statusCode
      ).toBe(401);
    }
    expect(await db.client.embed_chats.count()).toBe(4);
    expect(await db.client.event_logs.count()).toBe(0);
  });

  test("ohne_einsichtsrecht: gesperrter Nutzer 401; default ohne Mitgliedschaft im Workspace des Widgets 403", async () => {
    await db.client.users.update({
      where: { id: users.admin.id },
      data: { suspended: 1 },
    });
    const fremd = await createUser("default", []);
    const andererWorkspace = await createWorkspace(db.client);
    const nachbar = await createUser("default", [andererWorkspace.id]);

    for (const chain of CHAINS()) {
      expect((await call(chain, embed, "ziel", users.admin)).statusCode).toBe(
        401
      );
      expect((await call(chain, embed, "ziel", fremd)).statusCode).toBe(403);
      expect((await call(chain, embed, "ziel", nachbar)).statusCode).toBe(403);
    }
    expect(await db.client.embed_chats.count()).toBe(4);
    expect(await db.client.event_logs.count()).toBe(0);
  });

  test("ohne_einsichtsrecht: Wer einsehen darf, darf löschen - und nur der (Liste und Löschen entscheiden gleich)", async () => {
    const andererWorkspace = await createWorkspace(db.client);
    const candidates = [
      users.admin,
      users.manager,
      users.default,
      await createUser("default", []),
      await createUser("default", [andererWorkspace.id]),
    ];
    for (const user of candidates) {
      const list = await invoke(CONVERSATIONS, {
        params: { embedId: String(embed.id) },
        body: conversationsBody(),
        token: user.token,
      });
      const look = await preview(embed, "ziel", user);
      expect([user.role, look.statusCode]).toEqual([
        user.role,
        list.statusCode,
      ]);
      // Löschen einer Konversation, die es nicht gibt: zeigt die Entscheidung,
      // ohne den Bestand zu ändern.
      const result = await deleteConversation(embed, "gibt-es-nicht", user);
      expect(result.statusCode).toBe(list.statusCode === 200 ? 404 : 403);
    }
    expect(await db.client.embed_chats.count()).toBe(4);
  });
});
