/* eslint-env jest, node */
// KIE-538 — „Konversation löschen": EmbedChats.deleteConversation und
// deleteVisitorConversations über die Endpunkte
//   DELETE /embed/:embedId/conversation
//   DELETE /embed/:embedId/conversation/visitor
//   POST   /embed/:embedId/conversation/deletion-preview
// Die Konversation bezeichnet jeweils der Rumpf: { chatId }, die id ihrer
// ersten Zeile, wie die Liste sie nennt (first_chat_id).
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
const DETAIL = routes["GET /embed/:embedId/conversation/:chatId"];
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

// Eine id, die keine Zeile trägt: Die Karte gibt es nicht (mehr).
const NO_CHAT = 999_999;

/**
 * Die Karte einer Konversation in der Liste des Widgets: die id ihrer ersten
 * Zeile (first_chat_id). `conversation` ist die Kennung, die die Karte zeigt
 * (conversation_id, für Alt-Zeilen die session_id); `session` unterscheidet
 * zwei Karten mit derselben Kennung. Gibt es im Widget keine solche Zeile:
 * NO_CHAT.
 */
async function card(embed, conversation, session = null) {
  const embedId = Number(embed?.id ?? embed);
  if (!Number.isInteger(embedId)) return NO_CHAT;
  const first = await db.client.embed_chats.findFirst({
    where: {
      embed_id: embedId,
      ...(session ? { session_id: session } : {}),
      OR: [
        { conversation_id: conversation },
        { conversation_id: null, session_id: conversation },
      ],
    },
    orderBy: { id: "asc" },
    select: { id: true },
  });
  return first?.id ?? NO_CHAT;
}

/** Die Anfrage mit genau diesem Wert als chatId im Rumpf. */
const raw = (chain, embed, chatId, user = null) =>
  invoke(chain, {
    params: { embedId: String(embed?.id ?? embed) },
    body: conversationBody(chatId),
    token: user?.token ?? null,
  });
/**
 * `target` bezeichnet die Konversation: als Zahl die id einer Zeile, als
 * Text die Kennung, die ihre Karte in der Liste dieses Widgets zeigt.
 */
const call = async (chain, embed, target, user = null) =>
  raw(
    chain,
    embed,
    typeof target === "string" ? await card(embed, target) : target,
    user
  );
const deleteConversation = (embed, target, user) =>
  call(DELETE_CONVERSATION, embed, target, user);
const deleteVisitor = (embed, target, user) =>
  call(DELETE_VISITOR, embed, target, user);
const preview = (embed, target, user) => call(PREVIEW, embed, target, user);

/** Die aufgeklappte Konversation: ihre Nachrichten, wie die Karte sie lädt. */
async function shown(embed, target, user) {
  const chatId =
    typeof target === "string" ? await card(embed, target) : target;
  const result = await invoke(DETAIL, {
    params: { embedId: String(embed.id), chatId: String(chatId) },
    token: user?.token ?? null,
  });
  expect(result.statusCode).toBe(200);
  return result.body.messages;
}

/** Die Konversationen, die die Liste des Widgets zeigt, nach ihrer ID. */
async function cards(embed, user) {
  const result = await invoke(CONVERSATIONS, {
    params: { embedId: String(embed.id) },
    body: conversationsBody({ limit: 100 }),
    token: user?.token ?? null,
  });
  expect(result.statusCode).toBe(200);
  return result.body.conversations.sort(
    (a, b) =>
      a.conversation_id.localeCompare(b.conversation_id) ||
      a.first_chat_id - b.first_chat_id
  );
}

/** IDs der Konversationen, die die Liste des Widgets zeigt. */
const listed = async (embed, user) =>
  (await cards(embed, user)).map((c) => c.conversation_id).sort();

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
      params: { embedId: String(embed.id), chatId: String(target[0].id) },
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
    const shownCard = list.body.conversations.find(
      (c) => c.conversation_id === "ziel"
    );
    expect(shownCard.message_count).toBe(1);
    // … und nennt als erste Zeile die eine, die noch einsehbar ist.
    expect(shownCard.first_chat_id).toBe(target[3].id);
    // Die Vorschau nennt, was wirklich gelöscht wird.
    const before = await preview(embed, shownCard.first_chat_id, kunde);
    expect(before.body.messageCount).toBe(4);

    const result = await deleteConversation(
      embed,
      shownCard.first_chat_id,
      kunde
    );
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

  test("loescht_genau_diese: Die aufgeklappte Konversation zeigt genau die Zeilen, die gelöscht werden - auch die Alt-Konversation, deren ID die session_id ist", async () => {
    // Alt-Konversation der Sitzung besucher-1: zwei Zeilen - nicht die acht
    // der ganzen Sitzung (ziel, nachbar und die Alt-Zeilen).
    expect(
      (await shown(embed, "besucher-1", kunde)).map((m) => [
        m.prompt,
        m.conversation_id,
      ])
    ).toEqual([
      ["besucher-1: Frage 1", null],
      ["besucher-1: Frage 2", null],
    ]);
    // Eine vom Besucher geleerte Zeile zählt die Liste nicht mehr und die
    // aufgeklappte Konversation zeigt sie nicht (Konversationen-Ansicht,
    // Fixliste Punkt 5); gelöscht wird sie weiterhin mit.
    await db.client.embed_chats.update({
      where: { id: target[0].id },
      data: { include: false },
    });

    // Jede Karte der Liste, über die Zeile, die die Liste nennt.
    const list = await cards(embed, kunde);
    expect(list.map((c) => c.conversation_id)).toEqual([
      "besucher-1",
      "fremd",
      "nachbar",
      "ziel",
    ]);
    expect(list.at(-1).first_chat_id).toBe(target[1].id);
    for (const { conversation_id: id, first_chat_id: chatId } of list) {
      const visible = (await shown(embed, chatId, kunde))
        .map((m) => m.id)
        .sort((a, b) => a - b);
      const hidden = id === "ziel" ? [target[0].id] : [];
      expect(visible).not.toContain(target[0].id);
      const all = [...visible, ...hidden].sort((a, b) => a - b);
      const look = await preview(embed, chatId, kunde);
      expect([id, look.body.messageCount]).toEqual([id, all.length]);

      const before = await chatIds();
      const result = await deleteConversation(embed, chatId, kunde);
      expect([id, result.body]).toEqual([
        id,
        { success: true, deletedCount: all.length },
      ]);
      const after = await chatIds();
      expect([id, before.filter((chat) => !after.includes(chat))]).toEqual([
        id,
        all,
      ]);
      expect(await shown(embed, chatId, kunde)).toEqual([]);
    }
    // Übrig ist nur das andere Widget.
    expect(
      await db.client.embed_chats.count({ where: { embed_id: embed.id } })
    ).toBe(0);
    expect(await db.client.embed_chats.count()).toBe(2);
  });

  // Die conversation_id vergibt der Besucher: Der öffentliche Chat-Endpunkt
  // speichert jede gesendete Kennung. Wer die Chat-ID eines anderen kennt,
  // kann sie aus seiner eigenen Sitzung senden.
  test("loescht_genau_diese: Dieselbe Kennung aus einer zweiten Browser-Sitzung ist eine zweite Konversation - Liste, Einzelansicht, Vorschau und Löschen meinen die eine Karte, die andere bleibt", async () => {
    const [intruder] = await converse(embed, {
      conversation: "ziel",
      session: "besucher-3",
      n: 1,
      at: new Date(T0().getTime() + 2 * DAY),
    });
    const list = (await cards(embed, kunde)).filter(
      (c) => c.conversation_id === "ziel"
    );
    expect(
      list.map((c) => [c.session_id, c.first_chat_id, c.message_count])
    ).toEqual([
      ["besucher-1", target[0].id, 4],
      ["besucher-3", intruder.id, 1],
    ]);
    const [own, foreign] = list.map((c) => c.first_chat_id);

    // Die Karte der zweiten Sitzung: eine Nachricht, nicht fünf.
    expect((await shown(embed, foreign, kunde)).map((m) => m.id)).toEqual([
      intruder.id,
    ]);
    expect((await preview(embed, foreign, kunde)).body).toEqual({
      success: true,
      messageCount: 1,
      visitor: { conversationCount: 1, messageCount: 1 },
    });
    expect((await shown(embed, own, kunde)).map((m) => m.id)).toEqual(
      target.map((chat) => chat.id)
    );
    expect((await preview(embed, own, kunde)).body).toEqual({
      success: true,
      messageCount: 4,
      visitor: { conversationCount: 3, messageCount: 8 },
    });

    const result = await deleteConversation(embed, foreign, kunde);
    expect(result.body).toEqual({ success: true, deletedCount: 1 });
    expect(await chatIds()).toEqual(
      [...target, ...others].map((chat) => chat.id).sort((a, b) => a - b)
    );
    expect(await listed(embed, kunde)).toEqual([
      "besucher-1",
      "fremd",
      "nachbar",
      "ziel",
    ]);

    // … und umgekehrt: Die Karte der ersten Sitzung lässt die zweite stehen.
    const [again] = await converse(embed, {
      conversation: "ziel",
      session: "besucher-3",
      n: 1,
      at: new Date(T0().getTime() + 2 * DAY),
    });
    expect((await deleteConversation(embed, own, kunde)).body).toEqual({
      success: true,
      deletedCount: 4,
    });
    expect(await chatIds()).toEqual(
      [...others, again].map((chat) => chat.id).sort((a, b) => a - b)
    );
  });

  test("loescht_genau_diese: Auch die session_id eines anderen als Kennung trifft dessen Alt-Konversation nicht - und dessen „alle Konversationen dieses Besuchers“ bleibt möglich", async () => {
    // Für die erste Konversation eines Widgets ist die Kennung die session_id.
    const [intruder] = await converse(embed, {
      conversation: "besucher-1",
      session: "besucher-3",
      n: 1,
      at: new Date(T0().getTime() + 2 * DAY),
    });
    const list = (await cards(embed, kunde)).filter(
      (c) => c.conversation_id === "besucher-1"
    );
    expect(list.map((c) => [c.session_id, c.message_count])).toEqual([
      ["besucher-1", 2],
      ["besucher-3", 1],
    ]);
    const [own, foreign] = list.map((c) => c.first_chat_id);

    expect((await preview(embed, own, kunde)).body).toEqual({
      success: true,
      messageCount: 2,
      visitor: { conversationCount: 3, messageCount: 8 },
    });
    const result = await deleteConversation(embed, foreign, kunde);
    expect(result.body).toEqual({ success: true, deletedCount: 1 });
    expect(await chatIds()).toEqual(
      [...target, ...others].map((chat) => chat.id).sort((a, b) => a - b)
    );

    // Mit der zweiten Sitzung im Bestand: alle acht Zeilen der ersten, nur die.
    const [again] = await converse(embed, {
      conversation: "besucher-1",
      session: "besucher-3",
      n: 1,
      at: new Date(T0().getTime() + 2 * DAY),
    });
    const all = await deleteVisitor(embed, own, kunde);
    expect(all.statusCode).toBe(200);
    expect(all.body).toEqual({
      success: true,
      deletedCount: 8,
      conversationCount: 3,
    });
    expect(
      await db.client.embed_chats.findMany({
        where: { embed_id: embed.id },
        orderBy: { id: "asc" },
        select: { id: true, session_id: true },
      })
    ).toEqual([
      ...others
        .filter((chat) => chat.session_id === "besucher-2")
        .map((chat) => ({ id: chat.id, session_id: "besucher-2" })),
      { id: again.id, session_id: "besucher-3" },
    ]);
  });

  test("loescht_genau_diese: ein zweites Löschen findet nichts mehr - 404, kein weiteres Ereignis", async () => {
    const chatId = await card(embed, "ziel");
    expect((await deleteConversation(embed, chatId, kunde)).statusCode).toBe(
      200
    );
    const again = await deleteConversation(embed, chatId, kunde);
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

  test("loescht_genau_diese: eine einzige Löschanweisung, gebunden an Widget, Sitzung und Kennung - das Modell meldet die Zahl der Zeilen, bei einem Datenbankfehler null", async () => {
    const deleteMany = jest.spyOn(db.client.embed_chats, "deleteMany");
    const findFirst = jest.spyOn(db.client.embed_chats, "findFirst");
    // jede Zeile der Konversation bezeichnet sie, nicht nur die erste
    expect(await EmbedChats.deleteConversation(embed.id, target[2].id)).toBe(4);
    expect(findFirst.mock.calls.map(([args]) => args.where)).toEqual([
      { id: target[2].id, embed_id: embed.id },
    ]);
    expect(deleteMany).toHaveBeenCalledTimes(1);
    expect(deleteMany.mock.calls[0][0]).toEqual({
      where: {
        embed_id: embed.id,
        session_id: "besucher-1",
        OR: [
          { conversation_id: "ziel" },
          { conversation_id: null, session_id: "ziel" },
        ],
      },
    });

    // Unbrauchbare Angaben: kein Datenbankzugriff, 0 Zeilen
    const nachbar = await card(embed, "nachbar");
    deleteMany.mockClear();
    findFirst.mockClear();
    for (const [embedId, chatId] of [
      [embed.id, ""],
      [embed.id, null],
      [embed.id, undefined],
      [embed.id, { id: nachbar }],
      [embed.id, [nachbar]],
      [embed.id, true],
      [embed.id, 0],
      [embed.id, -nachbar],
      [embed.id, nachbar + 0.5],
      [embed.id, NaN],
      [embed.id, Infinity],
      [embed.id, 2 ** 53],
      [embed.id, "nachbar"],
      [embed.id, `${nachbar} `],
      [embed.id, `0${nachbar}`],
      [embed.id, `${nachbar}.0`],
      [embed.id, `${nachbar}e0`],
      [embed.id, `0x${nachbar.toString(16)}`],
      [0, nachbar],
      [-1, nachbar],
      [NaN, nachbar],
      ["abc", nachbar],
      [null, nachbar],
    ])
      expect([
        String(chatId),
        await EmbedChats.deleteConversation(embedId, chatId),
      ]).toEqual([String(chatId), 0]);
    expect(findFirst).not.toHaveBeenCalled();
    // Eine Zeile, die es nicht gibt, und die Zeile eines anderen Widgets:
    // nachgesehen, nichts gelöscht.
    expect(await EmbedChats.deleteConversation(embed.id, NO_CHAT)).toBe(0);
    expect(await EmbedChats.deleteConversation(otherEmbed.id, nachbar)).toBe(0);
    expect(findFirst).toHaveBeenCalledTimes(2);
    expect(deleteMany).not.toHaveBeenCalled();
    expect(await db.client.embed_chats.count()).toBe(9);
    // Die Ziffernfolge aus einem Pfadabschnitt gilt wie die Zahl.
    expect(await shown(embed, nachbar, kunde)).toHaveLength(2);

    deleteMany.mockRejectedValueOnce(new Error("database is locked"));
    expect(await EmbedChats.deleteConversation(embed.id, nachbar)).toBeNull();
    findFirst.mockRejectedValueOnce(new Error("database is locked"));
    expect(await EmbedChats.deleteConversation(embed.id, nachbar)).toBeNull();
    deleteMany.mockRejectedValueOnce(new Error("database is locked"));
    const failed = await deleteConversation(embed, nachbar, kunde);
    expect(failed.statusCode).toBe(500);
    expect(await db.client.embed_chats.count()).toBe(9);
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

  test("ganze_sitzung: Eine Karte, deren Zeilen inzwischen gelöscht sind, bezeichnet keine Sitzung mehr - die Vorschau nennt nichts, gelöscht wird nichts", async () => {
    const [first] = await converse(embed, {
      conversation: "n-1",
      session: "neuer-besucher",
      n: 2,
      at: T0(),
    });
    await converse(embed, {
      conversation: "n-2",
      session: "neuer-besucher",
      n: 3,
      at: new Date(T0().getTime() + DAY),
    });
    expect((await preview(embed, first.id, kunde)).body).toEqual({
      success: true,
      messageCount: 2,
      visitor: { conversationCount: 2, messageCount: 5 },
    });
    // Die Konversation verschwindet (Aufbewahrungsfrist, ein anderer Nutzer),
    // die Karte steht noch im Browser.
    await db.client.embed_chats.deleteMany({
      where: { conversation_id: "n-1" },
    });
    const before = await chatIds();

    expect((await preview(embed, first.id, kunde)).body).toEqual({
      success: true,
      messageCount: 0,
      visitor: null,
    });
    const result = await deleteVisitor(embed, first.id, kunde);
    expect(result.statusCode).toBe(404);
    expect(result.body).toEqual({ success: false, error: expect.any(String) });
    expect(await chatIds()).toEqual(before);
    expect(await db.client.event_logs.count()).toBe(0);

    // Über ihre andere Konversation ist die Sitzung weiter bestimmt.
    expect((await preview(embed, "n-2", kunde)).body).toEqual({
      success: true,
      messageCount: 3,
      visitor: { conversationCount: 1, messageCount: 3 },
    });
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

  test("ganze_sitzung: Dieselbe Kennung aus einer zweiten Sitzung nimmt das Angebot nicht weg (kein 409) - gelöscht wird die Sitzung der Karte, die andere bleibt", async () => {
    // Dieselbe conversation_id, von einer zweiten Sitzung gesendet
    const [intruder] = await converse(embed, {
      conversation: "k-1",
      session: "anderer",
      n: 1,
      at: T0(),
    });
    const own = await card(embed, "k-1", "besucher");

    expect((await preview(embed, own, kunde)).body).toEqual({
      success: true,
      messageCount: 4,
      visitor: { conversationCount: 4, messageCount: 11 },
    });
    // Die Karte der zweiten Sitzung nennt deren Bestand: a-1 und k-1.
    expect((await preview(embed, intruder.id, kunde)).body).toEqual({
      success: true,
      messageCount: 1,
      visitor: { conversationCount: 2, messageCount: 3 },
    });

    const result = await deleteVisitor(embed, own, kunde);
    expect(result.statusCode).toBe(200);
    expect(result.body).toEqual({
      success: true,
      deletedCount: 11,
      conversationCount: 4,
    });
    expect(await chatIds()).toEqual(
      [...survivors, intruder].map((chat) => chat.id).sort((a, b) => a - b)
    );
  });

  test("ganze_sitzung: unbekannte Zeile, Zeile eines anderen Widgets und unbrauchbare Angabe - 404, nichts gelöscht", async () => {
    const before = await chatIds();
    // k-9: dieselbe Sitzungs-Kennung, aber im anderen Widget
    const elsewhere = await card(otherEmbed, "k-9");
    expect(elsewhere).not.toBe(NO_CHAT);
    for (const chatId of [NO_CHAT, elsewhere, "k-1", "%", "' OR 1=1 --"]) {
      const result = await raw(DELETE_VISITOR, embed, chatId, kunde);
      expect([chatId, result.statusCode]).toEqual([chatId, 404]);
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

  test("ganze_sitzung: eine einzige Löschanweisung, gebunden an Widget und Sitzung - in einer Transaktion mit der Zählung (Fixliste 7, F10)", async () => {
    // Die Löschung läuft in einer Transaktion: deren Löschanweisungen
    // mitschreiben (tx ist ein eigener Client).
    const deleteMany = jest.fn();
    const original = db.client.$transaction.bind(db.client);
    jest.spyOn(db.client, "$transaction").mockImplementation((work, ...rest) =>
      original(
        (tx) =>
          work(
            new Proxy(tx, {
              get(target, property) {
                const value = target[property];
                if (property !== "embed_chats")
                  return typeof value === "function"
                    ? value.bind(target)
                    : value;
                return new Proxy(value, {
                  get(model, name) {
                    if (name === "deleteMany")
                      return (args) => {
                        deleteMany(args);
                        return model.deleteMany(args);
                      };
                    const member = model[name];
                    return typeof member === "function"
                      ? member.bind(model)
                      : member;
                  },
                });
              },
            })
          ),
        ...rest
      )
    );
    const other = await card(embed, "a-1");
    expect(
      await EmbedChats.deleteVisitorConversations(
        embed.id,
        await card(embed, "k-2")
      )
    ).toEqual({ deletedCount: 11, conversationCount: 4 });
    expect(deleteMany).toHaveBeenCalledTimes(1);
    expect(deleteMany.mock.calls[0][0]).toEqual({
      where: { embed_id: embed.id, session_id: "besucher" },
    });

    deleteMany.mockClear();
    for (const [embedId, chatId] of [
      [embed.id, ""],
      [embed.id, null],
      [embed.id, { session_id: "anderer" }],
      [embed.id, "a-1"],
      [embed.id, "anderer"],
      [embed.id, NO_CHAT],
      [otherEmbed.id, other],
      [0, other],
      ["abc", other],
    ])
      expect(
        await EmbedChats.deleteVisitorConversations(embedId, chatId)
      ).toEqual({ deletedCount: 0, conversationCount: 0 });
    expect(deleteMany).not.toHaveBeenCalled();
  });

  test("ganze_sitzung (Fixliste 7, F10): Gelöscht wird nur, was die Rückfrage genannt hat – schreibt der Besucher dazwischen weiter, 409 mit dem neuen Stand, nichts gelöscht; mit den neuen Zahlen klappt es", async () => {
    const { visitor } = (await preview(embed, "k-1", kunde)).body;
    expect(visitor).toEqual({ conversationCount: 4, messageCount: 11 });

    // Nach der Rückfrage beginnt der Besucher eine fünfte Konversation.
    await converse(embed, {
      conversation: "k-neu",
      session: "besucher",
      n: 1,
      at: new Date(T0().getTime() + 3 * DAY),
    });
    const changed = await invoke(DELETE_VISITOR, {
      params: { embedId: String(embed.id) },
      body: conversationBody(await card(embed, "k-1"), visitor),
      token: kunde.token,
    });
    expect(changed.statusCode).toBe(409);
    expect(changed.body).toEqual({
      success: false,
      reason: "changed",
      visitor: { conversationCount: 5, messageCount: 12 },
      error: expect.any(String),
    });
    expect(
      await db.client.embed_chats.count({
        where: { embed_id: embed.id, session_id: "besucher" },
      })
    ).toBe(12);
    expect(
      await eventsOf(db.client, "embed_visitor_conversations_deleted")
    ).toEqual([]);

    // Eine weitere Nachricht in einer bestehenden Konversation ändert nur
    // die Zahl der Nachrichten - auch das ist ein anderer Stand.
    const current = changed.body.visitor;
    await converse(embed, {
      conversation: "k-2",
      session: "besucher",
      n: 1,
      at: new Date(T0().getTime() + 4 * DAY),
    });
    const again = await invoke(DELETE_VISITOR, {
      params: { embedId: String(embed.id) },
      body: conversationBody(await card(embed, "k-1"), current),
      token: kunde.token,
    });
    expect(again.statusCode).toBe(409);
    expect(again.body.visitor).toEqual({
      conversationCount: 5,
      messageCount: 13,
    });

    // Mit dem Stand, den die Rückfrage jetzt nennt: gelöscht, Antwort und
    // Protokoll nennen dieselben Zahlen.
    const done = await invoke(DELETE_VISITOR, {
      params: { embedId: String(embed.id) },
      body: conversationBody(await card(embed, "k-1"), again.body.visitor),
      token: kunde.token,
    });
    expect(done.statusCode).toBe(200);
    expect(done.body).toEqual({
      success: true,
      deletedCount: 13,
      conversationCount: 5,
    });
    const [event] = await eventsOf(
      db.client,
      "embed_visitor_conversations_deleted"
    );
    expect(event.metadata).toEqual({
      embedId: embed.id,
      conversationCount: 5,
      deletedCount: 13,
    });
  });

  test("ganze_sitzung (Fixliste 7, F10): unbrauchbare erwartete Zahlen → 400, nichts gelöscht", async () => {
    const chatId = await card(embed, "k-1");
    for (const expected of [
      "4",
      [4, 11],
      { conversationCount: 4 },
      { conversationCount: "4", messageCount: 11 },
      { conversationCount: -1, messageCount: 11 },
      { conversationCount: 4, messageCount: 1.5 },
    ]) {
      const result = await invoke(DELETE_VISITOR, {
        params: { embedId: String(embed.id) },
        body: { chatId, expected },
        token: kunde.token,
      });
      expect([expected, result.statusCode]).toEqual([expected, 400]);
    }
    expect(
      await db.client.embed_chats.count({
        where: { embed_id: embed.id, session_id: "besucher" },
      })
    ).toBe(11);
  });
});

// ============================================================================
// Die Konversation bezeichnet der Rumpf, nie die Adresse - und nicht über
// ihre Kennung
// ============================================================================
// Die conversation_id vergibt der Besucher (der öffentliche Chat-Endpunkt
// speichert sie ungeprüft). Als Teil der Adresse würde ein Browser "." und
// ".." als Pfadsegmente auflösen - aus „Konversation .. löschen" würde
// DELETE /embed/:embedId, das Löschen des ganzen Widgets. Im Rumpf steht die
// id der ersten Zeile, wie die Liste sie nennt.
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
  async function send(route, conversationId, user) {
    const chatId = await card(embed, conversationId);
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
        body: JSON.stringify(conversationBody(chatId)),
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

  test("kennung_im_rumpf: ohne chatId im Rumpf trifft die Anfrage keine Zeile - 404, nichts gelöscht; die Kennung der Konversation und eine Angabe in der Adresse zählen nicht", async () => {
    const before = await tableChecksum(db.client, "embed_chats");
    const chatId = rest[0].id;
    for (const body of [
      undefined,
      {},
      null,
      "null",
      "{}",
      '".."',
      String(chatId),
      { chatId: null },
      { chatId: "" },
      { chatId: [chatId] },
      { chatId: { equals: chatId } },
      { chatId: "bleibt" },
      { chat_id: chatId },
      { id: chatId },
      { conversationId: "bleibt" },
      { conversation_id: "bleibt" },
      { sessionId: "anderer" },
    ])
      for (const chain of [DELETE_CONVERSATION, DELETE_VISITOR]) {
        const result = await invoke(chain, {
          // in der Adresse: wird nicht gelesen
          params: {
            embedId: String(embed.id),
            chatId: String(chatId),
            conversationId: "bleibt",
          },
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
          params: { embedId: String(embed.id), chatId: String(chatId) },
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
      body: JSON.stringify(conversationBody(chatId)),
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

  test("fremde_konversation: Zeile einer Konversation eines anderen Workspaces über das eigene Widget - keine Zeile wird gelöscht, nichts wird gezeigt", async () => {
    const before = await tableChecksum(db.client, "embed_chats");
    // jede Zeile des fremden Widgets: b-fremd, Alt-Zeilen, doppelt
    const foreign = await chatIds({ embed_id: widgetB.id });
    expect(foreign).toHaveLength(9);
    for (const chatId of foreign) {
      for (const chain of [DELETE_CONVERSATION, DELETE_VISITOR]) {
        const result = await raw(chain, widgetA, chatId, kunde);
        expect([chatId, result.statusCode]).toEqual([chatId, 404]);
        expect(result.body).toEqual({
          success: false,
          error: expect.any(String),
        });
      }
      expect((await preview(widgetA, chatId, kunde)).body).toEqual({
        success: true,
        messageCount: 0,
        visitor: null,
      });
      expect(await shown(widgetA, chatId, kunde)).toEqual([]);
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

  test("fremde_konversation: Zeile einer Konversation eines anderen Widgets desselben Workspaces - keine Zeile wird gelöscht", async () => {
    const before = await tableChecksum(db.client, "embed_chats");
    const inA = await card(widgetA, "a-eigen");
    const inA2 = await card(widgetA2, "a2-eigen");
    expect([inA, inA2]).not.toContain(NO_CHAT);
    expect((await deleteConversation(widgetA, inA2, kunde)).statusCode).toBe(
      404
    );
    expect((await deleteConversation(widgetA2, inA, kunde)).statusCode).toBe(
      404
    );
    expect((await deleteVisitor(widgetA, inA2, kunde)).statusCode).toBe(404);
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

  test("fremde_konversation: Platzhalter, SQL-Bruchstücke, Sonderzeichen und die Kennung selbst als chatId treffen keine Zeile", async () => {
    const before = await tableChecksum(db.client, "embed_chats");
    const own = await card(widgetA, "a-eigen");
    for (const chatId of [
      "%",
      "_",
      "*",
      "' OR '1'='1",
      `${own}' --`,
      `${own} OR 1=1`,
      `${own}" OR ""="`,
      `${own}\u0000`,
      ` ${own}`,
      `+${own}`,
      `-${own}`,
      `${own}.0`,
      "a-eigen",
      "A-EIGEN",
      "s-a",
      "null",
      "undefined",
    ])
      for (const chain of [DELETE_CONVERSATION, DELETE_VISITOR]) {
        const result = await raw(chain, widgetA, chatId, kunde);
        expect([chatId, result.statusCode]).toEqual([chatId, 404]);
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
