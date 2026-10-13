/* eslint-env jest, node */
// KIE-532 — Das Kontingent liest das Zählerbuch: Keine Löschung senkt den
// Verbrauch, Umhängen verschiebt nichts, Kopien zählen nicht, ein neuer Zyklus
// beginnt bei 0, und eine Abweichung löst einen Alarm aus, keinen Rückfall.
//
// Alle Prüfungen laufen gegen eine echte SQLite-Datei aus den Migrationen
// (helpers/sqliteTestDatabase.js), über die Modelle und Endpunkte des Servers.
// Die Zeitzone des Prozesses wird nicht gesetzt.
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
  seedWorkspaceChats,
  eventsOf,
  collectRoutes,
  mockRequest,
  mockResponse,
} = require("../helpers/sqliteTestDatabase");
const { MessageLedger } = require("../../models/messageLedger");
const { WorkspaceChats } = require("../../models/workspaceChats");
const { EmbedChats } = require("../../models/embedChats");
const { EmbedConfig } = require("../../models/embedConfig");
const {
  WorkspaceMessageAdjustments,
} = require("../../models/workspaceMessageAdjustments");
const {
  runMessageLedgerBackfill,
} = require("../../utils/boot/messageLedgerBackfill");
const {
  getMessageLimitInfo,
  checkWorkspaceMessagesLimit,
  countMessagesInDateRange,
} = require("../../utils/helpers");
const {
  getCycleInfoWithMessageCount,
  countMessagesForCurrentCycle,
  isCycleLimitReached,
} = require("../../utils/helpers/cycleHelpers");
const { getBillingWindow } = require("../../utils/helpers/billingWindow");

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

/**
 * Workspace mit laufendem Zyklus, der vor 20 Tagen begann: Bestandszeilen der
 * letzten Tage liegen sicher im laufenden Fenster, an jedem Kalendertag.
 */
async function cycleWorkspace(data = {}) {
  return await createWorkspace(db.client, {
    cycleStartDate: new Date(Date.now() - 20 * DAY),
    cycleDurationMonths: 1,
    ...data,
  });
}

async function reload(workspace) {
  return await db.client.workspaces.findUnique({ where: { id: workspace.id } });
}

async function usage(workspace, now = new Date()) {
  return (await getMessageLimitInfo(await reload(workspace), now)).messageCount;
}

async function completeBackfill() {
  const result = await runMessageLedgerBackfill(quiet);
  expect(result.ok).toBe(true);
  expect(result.state.state).toBe("complete");
}

async function ledgerSum(where = {}) {
  const sum = await db.client.message_ledger.aggregate({
    where,
    _sum: { messages: true, copied: true },
  });
  return { messages: sum._sum.messages ?? 0, copied: sum._sum.copied ?? 0 };
}

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

describe("loeschjob_haelt_stand (AK-2)", () => {
  test("loeschjob_haelt_stand: Limit 600, Frist 1 Tag, 400 von 500 Widget-Nachrichten gelöscht - der Stand bleibt 500/600, gesperrt wird ab der 600. Nachricht", async () => {
    const workspace = await cycleWorkspace({ messagesLimit: 600 });
    const embed = await createEmbed(db.client, workspace, {
      chat_retention_days: 1,
      retention_started_at: new Date(Date.now() - 5 * DAY),
    });
    // 400 Nachrichten älter als die Frist (Bestand, 2 bis 4 Tage alt) …
    await seedEmbedChats(
      db.client,
      Array.from({ length: 400 }, (_, i) => ({
        embed_id: embed.id,
        createdAt: new Date(Date.now() - 2 * DAY - i * 7 * 60 * 1000),
        session_id: `alt-${i % 40}`,
      }))
    );
    await completeBackfill();
    // … und 100 von heute.
    const write = () =>
      EmbedChats.new({ embedId: embed.id, prompt: "Frage", sessionId: "neu" });
    for (let i = 0; i < 100; i++) await write();
    expect(
      (await getMessageLimitInfo(await reload(workspace))).contingent
    ).toBe("500/600");

    await runCleanupJob();

    // Der Löschjob hat die 400 alten Zeilen gelöscht und das protokolliert.
    expect(await db.client.embed_chats.count()).toBe(100);
    expect(
      (await eventsOf(db.client, "embed_chats_auto_deleted")).map(
        (event) => event.metadata.deletedCount
      )
    ).toEqual([400]);

    const info = await getMessageLimitInfo(await reload(workspace));
    expect(info.contingent).toBe("500/600");
    expect(info.messageCount).toBe(500);
    expect(
      (await getCycleInfoWithMessageCount(await reload(workspace))).contingent
    ).toBe("500/600");

    const check = async () =>
      await checkWorkspaceMessagesLimit(await reload(workspace), null, {
        returnData: true,
        uuid: "u",
      });
    expect((await check()).limitReached).toBe(false);

    // Nachrichten 501 bis 599: noch nicht gesperrt
    for (let i = 0; i < 99; i++) await write();
    expect(await check()).toEqual(
      expect.objectContaining({ limitReached: false, messageCount: 599 })
    );
    // mit der 600. Nachricht ist das Limit erreicht
    await write();
    expect(await check()).toEqual(
      expect.objectContaining({
        limitReached: true,
        messageCount: 600,
        messagesLimit: 600,
      })
    );
    // Weniger Zeilen als gezählt ist kein Alarm.
    expect(await eventsOf(db.client, "message_ledger_mismatch")).toEqual([]);
  }, 60000);
});

describe("loeschpfade_halten_stand (AK-3)", () => {
  test("loeschpfade_halten_stand: einzelner Chat, eine Konversation, alle Konversationen eines Besuchers, alle Chats eines Widgets, alle Widget-Chats, das Widget selbst und die Workspace-Chats - der Verbrauch bleibt 120", async () => {
    const {
      embedManagementEndpoints,
    } = require("../../endpoints/embedManagement");
    const { workspaceEndpoints } = require("../../endpoints/workspaces");
    const {
      workspaceThreadEndpoints,
    } = require("../../endpoints/workspaceThreads");
    const { systemEndpoints } = require("../../endpoints/system");
    const embedRoutes = collectRoutes(embedManagementEndpoints);
    const workspaceRoutes = collectRoutes(workspaceEndpoints);
    const threadRoutes = collectRoutes(workspaceThreadEndpoints);
    const systemRoutes = collectRoutes(systemEndpoints);

    const workspace = await cycleWorkspace({ messagesLimit: 1000 });
    const first = await createEmbed(db.client, workspace);
    const second = await createEmbed(db.client, workspace);
    // admin: Seit KIE-533 prüfen die Widget-Endpunkte die Rolle im Handler
    // ("Chats löschen" nur admin und manager, ein Default-User nur in Widgets
    // seiner Workspaces). Hier löscht, wer alle diese Wege gehen darf.
    const user = await db.client.users.create({
      data: { username: "anna", password: "x", role: "admin" },
    });
    const thread = await db.client.workspace_threads.create({
      data: {
        name: "Thread",
        slug: "thread-1",
        workspace_id: workspace.id,
        user_id: user.id,
      },
    });

    // 60 Nachrichten aus dem Bestand (nachgetragen) …
    await seedEmbedChats(db.client, [
      ...Array.from({ length: 20 }, (_, i) => ({
        embed_id: first.id,
        createdAt: new Date(Date.now() - 3 * DAY - i * HOUR),
      })),
      ...Array.from({ length: 15 }, (_, i) => ({
        embed_id: second.id,
        createdAt: new Date(Date.now() - 2 * DAY - i * HOUR),
      })),
    ]);
    await seedWorkspaceChats(
      db.client,
      Array.from({ length: 25 }, (_, i) => ({
        workspaceId: workspace.id,
        createdAt: new Date(Date.now() - 4 * DAY - i * HOUR),
        user_id: i % 2 ? user.id : null,
      }))
    );
    await completeBackfill();
    // … und 60 beim Anlegen gezählte.
    for (let i = 0; i < 15; i++)
      await EmbedChats.new({ embedId: first.id, prompt: "a", sessionId: "s" });
    for (let i = 0; i < 15; i++)
      await EmbedChats.new({ embedId: second.id, prompt: "b", sessionId: "s" });
    for (let i = 0; i < 10; i++)
      await WorkspaceChats.new({ workspaceId: workspace.id, prompt: "c" });
    for (let i = 0; i < 10; i++)
      await WorkspaceChats.new({
        workspaceId: workspace.id,
        prompt: "d",
        user,
      });
    for (let i = 0; i < 10; i++)
      await WorkspaceChats.new({
        workspaceId: workspace.id,
        prompt: "e",
        user,
        threadId: thread.id,
      });
    expect(await usage(workspace)).toBe(120);

    const locals = { workspace: await reload(workspace), user, thread };
    const call = async (routes, route, request = {}) => {
      const response = mockResponse(locals);
      await routes[route](mockRequest(request), response);
      expect(response.statusCode).toBe(200);
    };
    const rowsLeft = async () =>
      (await db.client.embed_chats.count()) +
      (await db.client.workspace_chats.count());
    let rows = await rowsLeft();
    expect(rows).toBe(120);
    const expectDeletedAndUnchanged = async () => {
      const left = await rowsLeft();
      expect(left).toBeLessThan(rows);
      rows = left;
      expect(await usage(workspace)).toBe(120);
    };

    // 1. ein einzelner Widget-Chat
    const single = await db.client.embed_chats.findFirst({
      where: { embed_id: first.id },
    });
    await call(embedRoutes, "DELETE /embed/chats/:chatId", {
      params: { chatId: String(single.id) },
    });
    await expectDeletedAndUnchanged();

    // 1b. eine ganze Konversation (KIE-538): die 19 verbliebenen
    // Bestandszeilen des ersten Widgets (Alt-Zeilen der Sitzung "sitzung")
    await call(
      embedRoutes,
      "DELETE /embed/:embedId/conversation/:conversationId",
      {
        params: { embedId: String(first.id), conversationId: "sitzung" },
      }
    );
    expect(
      await db.client.embed_chats.count({
        where: { embed_id: first.id, session_id: "sitzung" },
      })
    ).toBe(0);
    await expectDeletedAndUnchanged();
    // 1c. alle Konversationen eines Besuchers (KIE-538): die 15 beim Anlegen
    // gezählten Zeilen der Sitzung "s" im zweiten Widget
    await call(
      embedRoutes,
      "DELETE /embed/:embedId/conversation/:conversationId/visitor",
      { params: { embedId: String(second.id), conversationId: "s" } }
    );
    expect(
      await db.client.embed_chats.count({
        where: { embed_id: second.id, session_id: "s" },
      })
    ).toBe(0);
    await expectDeletedAndUnchanged();

    // 2. alle Chats eines Widgets ("Chats löschen")
    await call(embedRoutes, "DELETE /embed-chats/clear/:embedId", {
      params: { embedId: String(first.id) },
    });
    expect(
      await db.client.embed_chats.count({ where: { embed_id: first.id } })
    ).toBe(0);
    await expectDeletedAndUnchanged();

    // 3. das Widget selbst (Kaskade auf seine Chats)
    await call(embedRoutes, "DELETE /embed/:embedId", {
      params: { embedId: String(first.id) },
    });
    expect(await db.client.embed_configs.count()).toBe(1);
    expect(await usage(workspace)).toBe(120);

    // 4. alle Widget-Chats aller Widgets
    await call(embedRoutes, "DELETE /embed-chats/clear/:embedId", {
      params: { embedId: "-1" },
    });
    expect(await db.client.embed_chats.count()).toBe(0);
    await expectDeletedAndUnchanged();

    // 5. Workspace-Chats: ausgewählte Chats eines Nutzers …
    const own = await db.client.workspace_chats.findMany({
      where: { user_id: user.id, thread_id: null },
      take: 3,
    });
    await call(workspaceRoutes, "DELETE /workspace/:slug/delete-chats", {
      body: { chatIds: own.map((chat) => chat.id) },
    });
    await expectDeletedAndUnchanged();
    // … bearbeitete Chats ab einer Nachricht (Workspace und Thread) …
    const edited = await db.client.workspace_chats.findFirst({
      where: { user_id: user.id, thread_id: null },
      orderBy: { id: "desc" },
    });
    await call(workspaceRoutes, "DELETE /workspace/:slug/delete-edited-chats", {
      body: { startingId: edited.id },
    });
    await expectDeletedAndUnchanged();
    const inThread = await db.client.workspace_chats.findFirst({
      where: { thread_id: thread.id },
      orderBy: { id: "desc" },
    });
    await call(
      threadRoutes,
      "DELETE /workspace/:slug/thread/:threadSlug/delete-edited-chats",
      { body: { startingId: inThread.id } }
    );
    await expectDeletedAndUnchanged();
    // … ein einzelner Chat in der Verwaltung …
    const any = await db.client.workspace_chats.findFirst();
    await call(systemRoutes, "DELETE /system/workspace-chats/:id", {
      params: { id: String(any.id) },
    });
    await expectDeletedAndUnchanged();
    // … die Chats eines gelöschten Nutzers (Kaskade) …
    await db.client.users.delete({ where: { id: user.id } });
    await expectDeletedAndUnchanged();
    // … und alle Workspace-Chats.
    await call(systemRoutes, "DELETE /system/workspace-chats/:id", {
      params: { id: "-1" },
    });
    expect(await rowsLeft()).toBe(0);
    expect(await usage(workspace)).toBe(120);

    // Keine Zeile mehr vorhanden, das Zählerbuch unverändert, kein Alarm.
    expect(await ledgerSum({ workspace_id: workspace.id })).toEqual({
      messages: 120,
      copied: 0,
    });
    expect(await eventsOf(db.client, "message_ledger_mismatch")).toEqual([]);
  }, 60000);

  test("loeschpfade_halten_stand: Modell-Löschungen und als ungültig markierter Verlauf ändern den Stand nicht", async () => {
    const workspace = await cycleWorkspace();
    const embed = await createEmbed(db.client, workspace);
    for (let i = 0; i < 4; i++)
      await EmbedChats.new({ embedId: embed.id, prompt: "a", sessionId: "s" });
    for (let i = 0; i < 4; i++)
      await WorkspaceChats.new({ workspaceId: workspace.id, prompt: "b" });
    await completeBackfill();
    expect(await usage(workspace)).toBe(8);

    await EmbedChats.markHistoryInvalid(embed.id, "s");
    await WorkspaceChats.markHistoryInvalid(workspace.id, null);
    expect(await usage(workspace)).toBe(8);
    // KIE-538: eine Konversation bzw. alle Konversationen eines Besuchers
    await EmbedChats.new({
      embedId: embed.id,
      prompt: "a",
      sessionId: "t",
      conversationId: "konversation",
    });
    await EmbedChats.new({ embedId: embed.id, prompt: "a", sessionId: "t" });
    expect(await usage(workspace)).toBe(10);
    expect(await EmbedChats.deleteConversation(embed.id, "konversation")).toBe(
      1
    );
    expect(await EmbedChats.deleteVisitorConversations(embed.id, "t")).toEqual({
      deletedCount: 1,
      conversationCount: 1,
      ambiguous: false,
    });
    expect(await EmbedChats.deleteVisitorConversations(embed.id, "s")).toEqual({
      deletedCount: 4,
      conversationCount: 1,
      ambiguous: false,
    });
    expect(await db.client.embed_chats.count()).toBe(0);
    expect(await usage(workspace)).toBe(10);
    await EmbedChats.delete({ embed_id: embed.id });
    await WorkspaceChats.delete({ workspaceId: workspace.id });
    await EmbedConfig.delete({ id: embed.id });
    expect(await usage(workspace)).toBe(10);
  });
});

describe("umhaengen (AK-4)", () => {
  test("umhaengen: ein Widget mit 80 Nachrichten in A wird nach B umgehängt und erzeugt dort 5 - A hat 80, B hat 5", async () => {
    const a = await cycleWorkspace();
    const b = await cycleWorkspace();
    const embed = await createEmbed(db.client, a);
    await seedEmbedChats(
      db.client,
      Array.from({ length: 50 }, (_, i) => ({
        embed_id: embed.id,
        createdAt: new Date(Date.now() - 2 * DAY - i * 30 * 60 * 1000),
      }))
    );
    await completeBackfill();
    for (let i = 0; i < 30; i++)
      await EmbedChats.new({ embedId: embed.id, prompt: "a", sessionId: "s" });
    expect(await usage(a)).toBe(80);
    expect(await usage(b)).toBe(0);

    await EmbedConfig.update(embed.id, { workspace_id: b.id });
    expect((await EmbedConfig.get({ id: embed.id })).workspace_id).toBe(b.id);
    // Umhängen allein verschiebt nichts.
    expect(await usage(a)).toBe(80);
    expect(await usage(b)).toBe(0);

    for (let i = 0; i < 5; i++)
      await EmbedChats.new({ embedId: embed.id, prompt: "b", sessionId: "s" });

    expect(await usage(a)).toBe(80);
    expect(await usage(b)).toBe(5);
    expect(await ledgerSum({ workspace_id: a.id, embed_id: embed.id })).toEqual(
      {
        messages: 80,
        copied: 0,
      }
    );
    expect(await ledgerSum({ workspace_id: b.id, embed_id: embed.id })).toEqual(
      {
        messages: 5,
        copied: 0,
      }
    );
  });
});

describe("neuer_zyklus_null (AK-5)", () => {
  test("neuer_zyklus_null: Start 15.01., Dauer 3 Monate, 550 Nachrichten bis 14.04. - am 15.04. um 09:00 Uhr steht der Verbrauch bei 0, die Historie bleibt", async () => {
    const workspace = await createWorkspace(db.client, {
      messagesLimit: 600,
      cycleStartDate: new Date("2026-01-15"),
      cycleDurationMonths: 3,
    });
    const embed = await createEmbed(db.client, workspace);
    // 550 Nachrichten zwischen 15.01. 00:00 Uhr und 14.04. 23:59 Uhr Berliner Zeit
    const first = new Date("2026-01-15T00:00:00+01:00").getTime();
    const last = new Date("2026-04-14T23:59:59+02:00").getTime();
    const instants = Array.from(
      { length: 550 },
      (_, i) => new Date(first + Math.round(((last - first) * i) / 549))
    );
    await seedWorkspaceChats(
      db.client,
      instants
        .filter((_, i) => i % 2 === 0)
        .map((createdAt) => ({ workspaceId: workspace.id, createdAt }))
    );
    await seedEmbedChats(
      db.client,
      instants
        .filter((_, i) => i % 2 === 1)
        .map((createdAt) => ({ embed_id: embed.id, createdAt }))
    );
    await completeBackfill();

    // letzter Augenblick des ersten Zyklus: alle 550 zählen
    expect(await usage(workspace, new Date("2026-04-14T23:59:59+02:00"))).toBe(
      550
    );

    // 15.04., 09:00 Uhr Berliner Zeit: neuer Zyklus, Verbrauch 0
    const now = new Date("2026-04-15T09:00:00+02:00");
    const info = await getMessageLimitInfo(await reload(workspace), now);
    expect(info.messageCount).toBe(0);
    expect(info.contingent).toBe("0/600");
    expect(info.cycleInfo.cycleNumber).toBe(2);
    expect(info.billingWindow.startDay).toBe("2026-04-15");

    // Die 550 Nachrichten des ersten Zyklus stehen unverändert im Zählerbuch.
    expect(await ledgerSum({ workspace_id: workspace.id })).toEqual({
      messages: 550,
      copied: 0,
    });
    expect(
      await MessageLedger.sumMessages(workspace.id, "2026-01-15", "2026-04-15")
    ).toBe(550);
    expect(
      await MessageLedger.sumMessages(workspace.id, "2026-04-15", "2026-07-15")
    ).toBe(0);

    // Eine Nachricht am ersten Tag des neuen Zyklus um 00:00 Uhr zählt neu,
    // eine um 23:59 Uhr des Vortags gehört noch zum alten.
    await MessageLedger.transaction({ source: "test" }, async (tx) => {
      await MessageLedger.record(tx, {
        workspaceId: workspace.id,
        at: new Date("2026-04-15T00:00:00+02:00"),
        messages: 1,
      });
    });
    expect(await usage(workspace, now)).toBe(1);
    expect(await usage(workspace, new Date("2026-04-14T12:00:00+02:00"))).toBe(
      550
    );
  });
});

describe("verzweigung (AK-7)", () => {
  test("verzweigung: ein Thread mit 50 Nachrichten wird verzweigt - der Verbrauch bleibt 50, copied steigt um 50", async () => {
    const { workspaceEndpoints } = require("../../endpoints/workspaces");
    const routes = collectRoutes(workspaceEndpoints);

    const workspace = await cycleWorkspace({ messagesLimit: 100 });
    const user = await db.client.users.create({
      data: { username: "anna", password: "x" },
    });
    const thread = await db.client.workspace_threads.create({
      data: {
        name: "Thread",
        slug: "thread-1",
        workspace_id: workspace.id,
        user_id: user.id,
      },
    });
    await completeBackfill();
    let lastChat = null;
    for (let i = 0; i < 50; i++)
      lastChat = (
        await WorkspaceChats.new({
          workspaceId: workspace.id,
          prompt: `Frage ${i}`,
          response: { text: `Antwort ${i}` },
          user,
          threadId: thread.id,
        })
      ).chat;
    expect(await usage(workspace)).toBe(50);
    expect(await ledgerSum()).toEqual({ messages: 50, copied: 0 });

    const response = mockResponse({ workspace: await reload(workspace), user });
    await routes["POST /workspace/:slug/thread/fork"](
      mockRequest({ body: { chatId: lastChat.id, threadSlug: thread.slug } }),
      response
    );
    expect(response.statusCode).toBe(200);
    expect(response.body.newThreadSlug).toEqual(expect.any(String));

    // 50 Kopien sind entstanden …
    expect(await db.client.workspace_chats.count()).toBe(100);
    // … der Verbrauch bleibt 50, copied steigt um 50.
    expect(await usage(workspace)).toBe(50);
    expect(await ledgerSum()).toEqual({ messages: 50, copied: 50 });
    // Die Kopien sind Zeilen ohne Kontingentwirkung, keine Abweichung.
    expect(await eventsOf(db.client, "message_ledger_mismatch")).toEqual([]);

    // Eine neue Nachricht im verzweigten Thread zählt wieder normal.
    const forked = await db.client.workspace_threads.findFirst({
      where: { slug: response.body.newThreadSlug },
    });
    await WorkspaceChats.new({
      workspaceId: workspace.id,
      prompt: "weiter",
      user,
      threadId: forked.id,
    });
    expect(await usage(workspace)).toBe(51);
  }, 30000);
});

describe("alarm_ohne_rueckfall (AK-13)", () => {
  /**
   * Künstlich: setzt das Zählerbuch eines Workspaces auf genau diese Summen,
   * auch wenn seine Nachrichten in zwei Stunden entstanden sind.
   */
  async function setLedger(workspace, messages, copied = 0) {
    await db.client.message_ledger.updateMany({
      where: { workspace_id: workspace.id },
      data: { messages: 0, copied: 0 },
    });
    const cell = await db.client.message_ledger.findFirst({
      where: { workspace_id: workspace.id },
    });
    await db.client.message_ledger.update({
      where: { id: cell.id },
      data: { messages, copied },
    });
  }
  const mismatchWorkspaces = async () =>
    (await eventsOf(db.client, "message_ledger_mismatch")).map(
      (event) => event.metadata.workspaceId
    );

  test("alarm_ohne_rueckfall: liegt das Zählerbuch unter der Live-Zählung, gilt trotzdem das Zählerbuch - mit Ereignis, höchstens einmal je Workspace und Stunde", async () => {
    const workspace = await cycleWorkspace({ messagesLimit: 100 });
    const other = await cycleWorkspace({ messagesLimit: 100 });
    const second = await cycleWorkspace({ messagesLimit: 100 });
    for (let i = 0; i < 10; i++) {
      await WorkspaceChats.new({ workspaceId: workspace.id, prompt: "a" });
      await WorkspaceChats.new({ workspaceId: other.id, prompt: "b" });
    }
    for (let i = 0; i < 7; i++)
      await WorkspaceChats.new({ workspaceId: second.id, prompt: "c" });
    await completeBackfill();
    expect(await usage(workspace)).toBe(10);
    expect(await eventsOf(db.client, "message_ledger_mismatch")).toEqual([]);

    // Künstlich: Das Zählerbuch von workspace und von second liegt unter der
    // Live-Zählung (4 statt 10 bzw. 0 statt 7).
    await setLedger(workspace, 4);
    await setLedger(second, 0);

    // Die Uhr des Alarms steht für diesen Test: Ein Stundenwechsel mitten im
    // Lauf soll kein zweites Ereignis auslösen.
    const startedAt = Date.now();
    const nowSpy = jest.spyOn(Date, "now").mockReturnValue(startedAt);

    const info = await getMessageLimitInfo(await reload(workspace));
    // kein Rückfall auf die Live-Zählung (10), keine Summe (14)
    expect(info.messageCount).toBe(4);
    expect(info.contingent).toBe("4/100");

    const window = getBillingWindow(await reload(workspace));
    let events = await eventsOf(db.client, "message_ledger_mismatch");
    expect(events).toHaveLength(1);
    expect(events[0].metadata).toEqual(
      expect.objectContaining({
        workspaceId: workspace.id,
        workspaceSlug: workspace.slug,
        ledgerMessages: 4,
        ledgerCopied: 0,
        liveCount: 10,
        window: {
          start: window.start.toISOString(),
          endExclusive: window.endExclusive.toISOString(),
          startDay: window.startDay,
          endDayExclusive: window.endDayExclusive,
        },
      })
    );
    // Die bekannte Ursache ohne Fehler ist im Alarmtext benannt.
    expect(events[0].metadata.note).toMatch(/umgehängt/);

    // Weitere Abfragen in derselben Stunde: kein zweites Ereignis - auch
    // nicht nach einem Neustart (der Prozess hat alles vergessen).
    for (let i = 0; i < 3; i++) expect(await usage(workspace)).toBe(4);
    MessageLedger._resetCache();
    expect(await usage(workspace)).toBe(4);
    expect(await eventsOf(db.client, "message_ledger_mismatch")).toHaveLength(
      1
    );

    // Der andere Workspace stimmt: kein Ereignis für ihn.
    expect(await usage(other)).toBe(10);
    expect(await eventsOf(db.client, "message_ledger_mismatch")).toHaveLength(
      1
    );

    // Die Sperre gilt je Workspace: Ein zweiter Workspace mit Abweichung wird
    // in derselben Stunde ebenfalls gemeldet - gleich nach einem Neustart, wenn
    // allein das Ereignisprotokoll sagt, wer in dieser Stunde schon gemeldet ist.
    MessageLedger._resetCache();
    expect(await usage(second)).toBe(0);
    expect(await mismatchWorkspaces()).toEqual([workspace.id, second.id]);
    events = await eventsOf(db.client, "message_ledger_mismatch");
    expect(events[1].metadata).toEqual(
      expect.objectContaining({ ledgerMessages: 0, liveCount: 7 })
    );
    // Beide sind für diese Stunde gemeldet, mit und ohne Gedächtnis des Prozesses.
    for (const forget of [false, true, true]) {
      if (forget) MessageLedger._resetCache();
      expect(await usage(second)).toBe(0);
      expect(await usage(workspace)).toBe(4);
    }
    expect(await mismatchWorkspaces()).toEqual([workspace.id, second.id]);

    // In einer späteren Stunde wird erneut gemeldet, solange die Abweichung
    // besteht - und auch dann je Workspace nur einmal.
    nowSpy.mockReturnValue(startedAt + 2 * HOUR);
    for (let i = 0; i < 2; i++) {
      expect(await usage(workspace)).toBe(4);
      expect(await usage(second)).toBe(0);
    }
    nowSpy.mockRestore();
    expect(await mismatchWorkspaces()).toEqual([
      workspace.id,
      second.id,
      workspace.id,
      second.id,
    ]);
  });

  test("alarm_ohne_rueckfall: schon eine einzige ungezählte Chat-Zeile ist eine Abweichung, Gleichstand ist keine - Kopien zählen dabei mit", async () => {
    const equal = await cycleWorkspace();
    const oneBelow = await cycleWorkspace();
    const copiesEqual = await cycleWorkspace();
    const copiesOneBelow = await cycleWorkspace();
    for (const workspace of [equal, oneBelow, copiesEqual, copiesOneBelow])
      for (let i = 0; i < 5; i++)
        await WorkspaceChats.new({ workspaceId: workspace.id, prompt: "a" });
    await completeBackfill();

    // Live-Zählung 5 in jedem Workspace; das Zählerbuch künstlich darauf bzw.
    // genau eins darunter gesetzt.
    await setLedger(equal, 5);
    await setLedger(oneBelow, 4);
    await setLedger(copiesEqual, 3, 2);
    await setLedger(copiesOneBelow, 3, 1);

    expect(await usage(equal)).toBe(5);
    expect(await usage(copiesEqual)).toBe(3);
    expect(await eventsOf(db.client, "message_ledger_mismatch")).toEqual([]);

    expect(await usage(oneBelow)).toBe(4);
    expect(await usage(copiesOneBelow)).toBe(3);
    const events = await eventsOf(db.client, "message_ledger_mismatch");
    expect(
      events.map(({ metadata }) => [
        metadata.workspaceId,
        metadata.ledgerMessages,
        metadata.ledgerCopied,
        metadata.liveCount,
      ])
    ).toEqual([
      [oneBelow.id, 4, 0, 5],
      [copiesOneBelow.id, 3, 1, 5],
    ]);
  });

  test("alarm_ohne_rueckfall: Löschungen (Zählerbuch über der Live-Zählung) sind keine Abweichung", async () => {
    const workspace = await cycleWorkspace();
    for (let i = 0; i < 6; i++)
      await WorkspaceChats.new({ workspaceId: workspace.id, prompt: "a" });
    await completeBackfill();
    await WorkspaceChats.delete({ workspaceId: workspace.id });

    expect(await usage(workspace)).toBe(6);
    expect(await eventsOf(db.client, "message_ledger_mismatch")).toEqual([]);
  });

  test("alarm_ohne_rueckfall: ein in den Workspace umgehängtes Widget löst den Alarm aus, der Stand bleibt beim Zählerbuch", async () => {
    const a = await cycleWorkspace();
    const b = await cycleWorkspace();
    const embed = await createEmbed(db.client, a);
    for (let i = 0; i < 7; i++)
      await EmbedChats.new({ embedId: embed.id, prompt: "a", sessionId: "s" });
    await completeBackfill();
    await EmbedConfig.update(embed.id, { workspace_id: b.id });

    // Die Live-Zählung wandert mit dem Widget nach B, das Zählerbuch nicht.
    expect(await usage(b)).toBe(0);
    expect(await usage(a)).toBe(7);
    const events = await eventsOf(db.client, "message_ledger_mismatch");
    expect(events.map((event) => event.metadata.workspaceId)).toEqual([b.id]);
    expect(events[0].metadata).toEqual(
      expect.objectContaining({ ledgerMessages: 0, liveCount: 7 })
    );
  });
});

describe("limit_meldung (NAK-7)", () => {
  test("limit_meldung: eine wegen erreichtem Limit abgewiesene Anfrage erzeugt keinen Verbrauch", async () => {
    const workspace = await cycleWorkspace({ messagesLimit: 3 });
    const embed = await createEmbed(db.client, workspace);
    for (let i = 0; i < 3; i++)
      await EmbedChats.new({ embedId: embed.id, prompt: "a", sessionId: "s" });
    await completeBackfill();
    const before = await db.client.message_ledger.findMany();
    expect(await usage(workspace)).toBe(3);

    // Widget: der echte Stream-Handler bricht mit der Limit-Meldung ab.
    const { streamChatWithForEmbed } = require("../../utils/chats/embed");
    const chunks = [];
    const streamResponse = { write: (chunk) => chunks.push(chunk) };
    await streamChatWithForEmbed(
      streamResponse,
      { ...embed, workspace: await reload(workspace) },
      "Noch eine Frage",
      "s",
      {}
    );
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatch(/"httpStatusCode":429/);
    expect(chunks[0]).toMatch(/Limit von 3 Nachrichten/);

    // Limitprüfung der übrigen Pfade: nicht gestreamt und als Daten
    const jsonResponse = mockResponse();
    const direct = await checkWorkspaceMessagesLimit(
      await reload(workspace),
      jsonResponse
    );
    expect(direct.limitReached).toBe(true);
    const asData = await checkWorkspaceMessagesLimit(
      await reload(workspace),
      null,
      { returnData: true }
    );
    expect(asData.limitReached).toBe(true);

    // OpenAI-kompatibler Pfad
    const {
      OpenAICompatibleChat,
    } = require("../../utils/chats/openaiCompatible");
    const aborted = await OpenAICompatibleChat.chatSync({
      workspace: await reload(workspace),
      prompt: "Noch eine Frage",
      messagesLimit: 3,
      messageCount: 3,
    });
    expect(JSON.stringify(aborted)).toMatch(/abort/);

    // Nichts ist entstanden: keine Chat-Zeile, kein Zähler.
    expect(await db.client.embed_chats.count()).toBe(3);
    expect(await db.client.workspace_chats.count()).toBe(0);
    expect(await db.client.message_ledger.findMany()).toEqual(before);
    expect(await usage(workspace)).toBe(3);
  });
});

// KIE-533: 0 heißt gesperrt, null heißt unbegrenzt. Die Tests von KIE-533
// (endpoints/workspaceBillingFields.test.js) laufen gegen eine Attrappe ohne
// Zählerbuch, also mit der Live-Zählung. Hier dieselbe Regel, wenn das
// Kontingent das Zählerbuch liest.
describe("limit_null_gegen_nullwert (KIE-533, AK-9) mit dem Zählerbuch als Quelle", () => {
  test("Limit 0 sperrt schon beim Stand 0, Limit null sperrt nie - auch nach Löschungen und mit throwOnError", async () => {
    const gesperrt = await cycleWorkspace({ messagesLimit: 0 });
    const unbegrenzt = await cycleWorkspace({ messagesLimit: null });
    const embed = await createEmbed(db.client, gesperrt);
    for (let i = 0; i < 5; i++)
      await WorkspaceChats.new({ workspaceId: unbegrenzt.id, prompt: "a" });
    await completeBackfill();
    // Gelöschte Zeilen senken den Stand nicht: Es zählt das Zählerbuch.
    await WorkspaceChats.delete({ workspaceId: unbegrenzt.id });
    expect(await db.client.workspace_chats.count()).toBe(0);
    expect(await MessageLedger.isBackfillComplete()).toBe(true);
    const before = await db.client.message_ledger.findMany();

    for (const options of [{}, { throwOnError: true }]) {
      const blocked = await checkWorkspaceMessagesLimit(
        await reload(gesperrt),
        null,
        { returnData: true, ...options }
      );
      expect(blocked).toEqual(
        expect.objectContaining({
          limitReached: true,
          messageCount: 0,
          messagesLimit: 0,
        })
      );
      expect(blocked.errorData.contingent).toBe("0/0");

      const open = await checkWorkspaceMessagesLimit(
        await reload(unbegrenzt),
        null,
        { returnData: true, ...options }
      );
      expect(open).toEqual(
        expect.objectContaining({
          limitReached: false,
          messageCount: 5,
          messagesLimit: null,
        })
      );
      expect(open.errorData).toBeNull();

      expect(
        await getMessageLimitInfo(await reload(gesperrt), new Date(), options)
      ).toEqual(
        expect.objectContaining({
          messageCount: 0,
          messagesLimit: 0,
          contingent: "0/0",
        })
      );
      expect(
        await getMessageLimitInfo(await reload(unbegrenzt), new Date(), options)
      ).toEqual(
        expect.objectContaining({
          messageCount: 5,
          messagesLimit: null,
          contingent: "5/Unlimited",
        })
      );
    }

    // Zyklusinfo (cycleHelpers, seit KIE-533 mit 0 = gesperrt)
    expect(await isCycleLimitReached(await reload(gesperrt))).toBe(true);
    expect(await isCycleLimitReached(await reload(unbegrenzt))).toBe(false);
    expect(await getCycleInfoWithMessageCount(await reload(gesperrt))).toEqual(
      expect.objectContaining({
        messageCount: 0,
        messagesRemaining: 0,
        contingent: "0/0",
      })
    );
    expect(
      await getCycleInfoWithMessageCount(await reload(unbegrenzt))
    ).toEqual(
      expect.objectContaining({
        messageCount: 5,
        messagesRemaining: null,
        contingent: "5/Unlimited",
      })
    );

    // Widget eines gesperrten Workspaces: Der echte Stream-Handler bricht mit
    // der Limit-Meldung ab, es entsteht weder Chat-Zeile noch Zähler.
    const { streamChatWithForEmbed } = require("../../utils/chats/embed");
    const chunks = [];
    await streamChatWithForEmbed(
      { write: (chunk) => chunks.push(chunk) },
      { ...embed, workspace: await reload(gesperrt) },
      "Eine Frage",
      "s",
      {}
    );
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatch(/"httpStatusCode":429/);
    expect(await db.client.embed_chats.count()).toBe(0);
    expect(await db.client.message_ledger.findMany()).toEqual(before);
  });
});

describe("eine_quelle (NAK-8)", () => {
  test("eine_quelle: vor Abschluss des Nachtrags zählt allein die Live-Zählung, danach allein das Zählerbuch - nie die Summe", async () => {
    const workspace = await cycleWorkspace({ messagesLimit: 100 });
    const embed = await createEmbed(db.client, workspace);
    // 15 Bestandszeilen ohne Zählerbuch …
    await seedWorkspaceChats(
      db.client,
      Array.from({ length: 9 }, (_, i) => ({
        workspaceId: workspace.id,
        createdAt: new Date(Date.now() - DAY - i * HOUR),
      }))
    );
    await seedEmbedChats(
      db.client,
      Array.from({ length: 6 }, (_, i) => ({
        embed_id: embed.id,
        createdAt: new Date(Date.now() - DAY - i * HOUR),
      }))
    );
    // … und 5 neue Nachrichten, die schon im Zählerbuch stehen.
    for (let i = 0; i < 3; i++)
      await WorkspaceChats.new({ workspaceId: workspace.id, prompt: "a" });
    for (let i = 0; i < 2; i++)
      await EmbedChats.new({ embedId: embed.id, prompt: "b", sessionId: "s" });
    expect(await ledgerSum()).toEqual({ messages: 5, copied: 0 });
    expect((await MessageLedger.backfillState()).state).toBe("pending");

    const window = getBillingWindow(await reload(workspace));
    // Nachtrag offen: Live-Zählung (20), nicht Zählerbuch (5), nicht Summe (25)
    expect(await usage(workspace)).toBe(20);
    expect(
      await countMessagesInDateRange(
        workspace,
        window.start,
        window.endExclusive
      )
    ).toEqual({
      total: 20,
      workspaceChatCount: 12,
      embedChatCount: 8,
      adjustmentsTotal: 0,
    });

    await completeBackfill();
    // Nachtrag abgeschlossen: Zählerbuch (20), nicht Summe (40)
    expect(await ledgerSum()).toEqual({ messages: 20, copied: 0 });
    expect(await usage(workspace)).toBe(20);

    // Nach Löschungen unterscheiden sich die Quellen: Zählerbuch 20, live 8.
    await WorkspaceChats.delete({ workspaceId: workspace.id });
    expect(await db.client.workspace_chats.count()).toBe(0);
    expect(
      await countMessagesInDateRange(
        workspace,
        window.start,
        window.endExclusive
      )
    ).toEqual({
      total: 20,
      workspaceChatCount: 12,
      embedChatCount: 8,
      adjustmentsTotal: 0,
    });

    // Buchungen zählen wie bisher dazu, Gutschriften drücken nicht unter 0.
    await WorkspaceMessageAdjustments.new({
      workspaceId: workspace.id,
      amount: 30,
    });
    expect(await usage(workspace)).toBe(50);
    await WorkspaceMessageAdjustments.new({
      workspaceId: workspace.id,
      amount: -500,
    });
    expect(await usage(workspace)).toBe(0);
  });

  test("eine_quelle: ein fehlgeschlagener Nachtrag lässt die Live-Zählung gelten, bis er abgeschlossen ist", async () => {
    const workspace = await cycleWorkspace();
    await seedWorkspaceChats(
      db.client,
      Array.from({ length: 12 }, (_, i) => ({
        workspaceId: workspace.id,
        createdAt: new Date(Date.now() - DAY - i * HOUR),
      }))
    );
    const failed = await runMessageLedgerBackfill({
      ...quiet,
      batchSize: 5,
      afterBatch: () => {
        throw new Error("künstlicher Abbruch");
      },
    });
    expect(failed.ok).toBe(false);
    // 5 von 12 Zeilen stehen im Zählerbuch - es gilt die Live-Zählung.
    expect(await ledgerSum()).toEqual({ messages: 5, copied: 0 });
    expect(await usage(workspace)).toBe(12);

    await completeBackfill();
    expect(await usage(workspace)).toBe(12);
    await WorkspaceChats.delete({ workspaceId: workspace.id });
    expect(await usage(workspace)).toBe(12);
  });
});

// KIE-534 reicht throwOnError durch alle Zählfunktionen: Die Limitprüfung der
// Agent-Sitzung darf einen Zählfehler nicht als Verbrauch 0 werten. Das gilt
// auch für das Zählerbuch als Quelle. Die Fehler entstehen hier in der echten
// Datenbank: Die jeweilige Tabelle fehlt.
describe("Lesefehler der Zählquelle (KIE-534: throwOnError)", () => {
  const STRICT = { throwOnError: true };

  async function workspaceWithUsage(messages = 4) {
    const workspace = await cycleWorkspace({ messagesLimit: 100 });
    for (let i = 0; i < messages; i++)
      await WorkspaceChats.new({ workspaceId: workspace.id, prompt: "a" });
    return await reload(workspace);
  }
  const windowOf = (workspace) => getBillingWindow(workspace);
  const count = (workspace, options) =>
    countMessagesInDateRange(
      workspace,
      windowOf(workspace).start,
      windowOf(workspace).endExclusive,
      options
    );
  /** Jeder Einstieg, über den die Limitprüfung zählt. */
  const strictEntryPoints = (workspace) => [
    () => count(workspace, STRICT),
    () => getMessageLimitInfo(workspace, new Date(), STRICT),
    () => countMessagesForCurrentCycle(workspace, null, STRICT),
    () =>
      checkWorkspaceMessagesLimit(workspace, null, {
        returnData: true,
        ...STRICT,
      }),
  ];
  async function expectEveryStrictEntryPointToThrow(workspace, table) {
    for (const attempt of strictEntryPoints(workspace))
      await expect(attempt()).rejects.toThrow(table);
  }

  test("Zählerbuch nicht lesbar: ohne throwOnError zählt es wie bisher als 0, mit throwOnError wirft jeder Einstieg", async () => {
    const workspace = await workspaceWithUsage(4);
    await completeBackfill();
    await WorkspaceMessageAdjustments.new({
      workspaceId: workspace.id,
      amount: 3,
    });
    expect(await count(workspace)).toEqual({
      total: 7,
      workspaceChatCount: 4,
      embedChatCount: 0,
      adjustmentsTotal: 3,
    });
    expect(await count(workspace, STRICT)).toEqual(await count(workspace));

    await db.client.$executeRawUnsafe(`DROP TABLE message_ledger`);

    // Ohne die Option: 0 Nachrichten, kein Rückfall auf die 4 vorhandenen
    // Zeilen; die Buchungen zählen weiter.
    expect(await count(workspace)).toEqual({
      total: 3,
      workspaceChatCount: 0,
      embedChatCount: 0,
      adjustmentsTotal: 3,
    });
    expect(await count(workspace, { throwOnError: false })).toEqual(
      await count(workspace)
    );
    expect(await usage(workspace)).toBe(3);
    const lenient = await checkWorkspaceMessagesLimit(workspace, null, {
      returnData: true,
    });
    expect(lenient.limitReached).toBe(false);
    expect(lenient.messageCount).toBe(3);

    await expectEveryStrictEntryPointToThrow(workspace, /message_ledger/);

    const { fromDay, toDayExclusive } = MessageLedger.daysOfWindow(
      windowOf(workspace).start,
      windowOf(workspace).endExclusive
    );
    expect(
      await MessageLedger.sumMessages(workspace.id, fromDay, toDayExclusive)
    ).toBe(0);
    await expect(
      MessageLedger.sumMessages(workspace.id, fromDay, toDayExclusive, STRICT)
    ).rejects.toThrow(/message_ledger/);
  });

  test("Markierung des Nachtrags nicht lesbar: ohne throwOnError gilt wie bisher die Live-Zählung, mit throwOnError wirft jeder Einstieg", async () => {
    const workspace = await workspaceWithUsage(4);
    await completeBackfill();
    // Zählerbuch 4, vorhandene Zeilen 1 - die Quellen sind unterscheidbar.
    const [first] = await db.client.workspace_chats.findMany({ take: 1 });
    await db.client.workspace_chats.deleteMany({
      where: { id: { not: first.id } },
    });
    expect((await count(workspace, STRICT)).total).toBe(4);

    // Neuer Prozess (nichts gemerkt), die Markierung ist nicht lesbar.
    MessageLedger._resetCache();
    await db.client.$executeRawUnsafe(`DROP TABLE system_settings`);

    expect(await MessageLedger.isBackfillComplete()).toBe(false);
    expect((await count(workspace)).total).toBe(1);
    await expect(MessageLedger.isBackfillComplete(STRICT)).rejects.toThrow(
      /system_settings/
    );
    await expectEveryStrictEntryPointToThrow(workspace, /system_settings/);
    // Ein Lesefehler wird nicht als "nicht abgeschlossen" gemerkt.
    expect((await count(workspace)).total).toBe(1);
  });

  test("Markierung lesbar, Nachtrag offen: der Rückfall auf die Live-Zählung wirft mit throwOnError, wenn sie nicht lesbar ist", async () => {
    const workspace = await workspaceWithUsage(4);
    const embed = await createEmbed(db.client, workspace);
    await EmbedChats.new({ embedId: embed.id, prompt: "b", sessionId: "s" });
    expect((await MessageLedger.backfillState()).state).toBe("pending");
    expect((await count(workspace, STRICT)).total).toBe(5);

    await db.client.$executeRawUnsafe(`DROP TABLE embed_chats`);

    // Ohne die Option fehlt wie bisher nur der Anteil der Widgets.
    expect(await count(workspace)).toEqual({
      total: 4,
      workspaceChatCount: 4,
      embedChatCount: 0,
      adjustmentsTotal: 0,
    });
    await expectEveryStrictEntryPointToThrow(workspace, /embed_chats/);
  });

  test("Nachtrag abgeschlossen, Vergleichszählung nicht lesbar: ohne throwOnError gilt das Zählerbuch ohne Alarm, mit throwOnError wirft jeder Einstieg", async () => {
    const workspace = await workspaceWithUsage(4);
    const embed = await createEmbed(db.client, workspace);
    await EmbedChats.new({ embedId: embed.id, prompt: "b", sessionId: "s" });
    await completeBackfill();

    await db.client.$executeRawUnsafe(`DROP TABLE embed_chats`);

    expect(await count(workspace)).toEqual({
      total: 5,
      workspaceChatCount: 4,
      embedChatCount: 1,
      adjustmentsTotal: 0,
    });
    expect(await eventsOf(db.client, "message_ledger_mismatch")).toEqual([]);
    // Streng heißt: Jede Abfrage der Zählung muss gelingen, auch die, die nur
    // dem Vergleich dient.
    await expectEveryStrictEntryPointToThrow(workspace, /embed_chats/);
  });

  test("Zählerbuch lesbar, Abweichung nicht meldbar: die Zählung gelingt auch mit throwOnError", async () => {
    const workspace = await workspaceWithUsage(4);
    await completeBackfill();
    // Eine ungezählte Zeile: Abweichung zwischen Zählerbuch (4) und Zeilen (5)
    await seedWorkspaceChats(db.client, [
      { workspaceId: workspace.id, createdAt: new Date(Date.now() - HOUR) },
    ]);
    await db.client.$executeRawUnsafe(`DROP TABLE event_logs`);

    expect((await count(workspace, STRICT)).total).toBe(4);
    expect((await count(workspace)).total).toBe(4);
  });
});
