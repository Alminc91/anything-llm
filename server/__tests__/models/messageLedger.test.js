/* eslint-env jest, node */
// KIE-532 — Zählerbuch: Zählen beim Anlegen, Sommerzeit, Bewertungen,
// Konversationen, Atomarität und die Regeln am Quelltext.
//
// Alle Prüfungen laufen gegen eine echte SQLite-Datei aus den Migrationen
// (helpers/sqliteTestDatabase.js). Die Zeitzone des Prozesses wird nicht
// gesetzt; die Erwartungen gelten für TZ=UTC, TZ=Europe/Berlin und
// TZ=America/New_York.
jest.mock(
  "../../utils/prisma",
  () => require("../helpers/sqliteTestDatabase").testPrisma
);

const fs = require("fs");
const path = require("path");
const { Prisma } = require("@prisma/client");
const {
  createTestDatabase,
  removeTestDatabases,
  createWorkspace,
  createEmbed,
  seedEmbedChats,
  seedWorkspaceChats,
  ledgerRows,
  berlinCell,
  berlinInstant,
  eventsOf,
} = require("../helpers/sqliteTestDatabase");
const { MessageLedger } = require("../../models/messageLedger");
const { WorkspaceChats } = require("../../models/workspaceChats");
const { EmbedChats } = require("../../models/embedChats");
const {
  runMessageLedgerBackfill,
} = require("../../utils/boot/messageLedgerBackfill");
const {
  chatHistory,
} = require("../../utils/agents/aibitat/plugins/chat-history");

const quiet = { log: () => {} };

// Der erste Test jeder Datei erzeugt die Vorlage mit `prisma migrate deploy`.
jest.setTimeout(60000);

let db;
let errorSpy;
let logSpy;
beforeEach(async () => {
  MessageLedger._resetCache();
  EmbedChats._resetFeedbackLimits();
  db = await createTestDatabase();
  errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(async () => {
  errorSpy.mockRestore();
  logSpy.mockRestore();
  await db.close();
});
afterAll(() => removeTestDatabases());

/** Zeile des Zählerbuchs für Workspace, Widget und den Zeitpunkt (oder null). */
async function cellAt(workspaceId, embedId, instant) {
  const { day, hour } = berlinCell(instant);
  return await db.client.message_ledger.findUnique({
    where: {
      workspace_id_embed_id_day_hour: {
        workspace_id: workspaceId,
        embed_id: embedId,
        day,
        hour,
      },
    },
  });
}

async function totals(where = {}) {
  const sum = await db.client.message_ledger.aggregate({
    where,
    _sum: {
      messages: true,
      copied: true,
      conversations_started: true,
      feedback_positive: true,
      feedback_negative: true,
    },
  });
  return Object.fromEntries(
    Object.entries(sum._sum).map(([key, value]) => [key, value ?? 0])
  );
}

describe("zaehlt_je_pfad (AK-1)", () => {
  test("zaehlt_je_pfad: Widget, GUI-Chat, API-Sitzung und Agent-Pfad zählen je +1 in der Berliner Stunde", async () => {
    const workspace = await createWorkspace(db.client);
    const embed = await createEmbed(db.client, workspace);
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

    // Widget
    const widget = await EmbedChats.new({
      embedId: embed.id,
      prompt: "Gibt es Yogakurse?",
      response: { text: "Ja." },
      sessionId: "sitzung-1",
      conversationId: "konversation-1",
    });
    expect(widget.message).toBeNull();
    expect(await cellAt(workspace.id, embed.id, widget.chat.createdAt)).toEqual(
      expect.objectContaining({ messages: 1, copied: 0 })
    );

    // GUI-Chat (Nutzer, Thread)
    const gui = await WorkspaceChats.new({
      workspaceId: workspace.id,
      prompt: "Hallo",
      response: { text: "Hallo!" },
      user,
      threadId: thread.id,
    });
    expect(gui.message).toBeNull();
    expect(await totals({ workspace_id: workspace.id, embed_id: 0 })).toEqual(
      expect.objectContaining({ messages: 1 })
    );

    // API-Sitzung, mit include = false
    const api = await WorkspaceChats.new({
      workspaceId: workspace.id,
      prompt: "API",
      response: { text: "ok" },
      apiSessionId: "api-sitzung",
      include: false,
    });
    expect(api.chat.include).toBe(false);
    expect(await totals({ workspace_id: workspace.id, embed_id: 0 })).toEqual(
      expect.objectContaining({ messages: 2 })
    );

    // Agent-Pfad: das Plugin speichert, sobald auf eine Nutzernachricht eine
    // Antwort folgt.
    const handlers = [];
    const aibitat = {
      chats: [
        { from: "USER", content: "@agent such etwas" },
        { from: "@agent", content: "Gefunden." },
      ],
      handlerProps: {
        invocation: {
          workspace_id: workspace.id,
          user_id: user.id,
          thread_id: thread.id,
        },
      },
      onMessage: (handler) => handlers.push(handler),
    };
    chatHistory.plugin().setup(aibitat);
    // KIE-534: Der Listener wartet nicht selbst; das laufende Speichern hängt
    // am aibitat-Objekt.
    handlers[0]();
    await aibitat._pendingHistorySave;
    const agentChat = await db.client.workspace_chats.findFirst({
      where: { prompt: "@agent such etwas" },
    });
    expect(agentChat).not.toBeNull();

    // Vier Chat-Zeilen, vier Zählungen: eine unter der Widget-ID, drei unter 0.
    expect(await db.client.workspace_chats.count()).toBe(3);
    expect(await db.client.embed_chats.count()).toBe(1);
    expect(await totals()).toEqual(
      expect.objectContaining({ messages: 4, copied: 0 })
    );
    expect(await totals({ embed_id: embed.id })).toEqual(
      expect.objectContaining({ messages: 1 })
    );
    expect(await totals({ embed_id: 0 })).toEqual(
      expect.objectContaining({ messages: 3 })
    );

    // Jede Zählung steht in der Zeile des Berliner Tages und der Berliner
    // Stunde, in der die Chat-Zeile entstand.
    const expected = new Map();
    for (const [embedId, chat] of [
      [embed.id, widget.chat],
      [0, gui.chat],
      [0, api.chat],
      [0, agentChat],
    ]) {
      const { day, hour } = berlinCell(chat.createdAt);
      const key = `${embedId}|${day}|${hour}`;
      expected.set(key, (expected.get(key) ?? 0) + 1);
    }
    const actual = new Map(
      (await ledgerRows(db.client)).map((row) => [
        `${row.embed_id}|${row.day}|${row.hour}`,
        row.messages,
      ])
    );
    expect(actual).toEqual(expected);
    expect(
      (await ledgerRows(db.client)).every(
        (row) => row.workspace_id === workspace.id
      )
    ).toBe(true);
  });

  test("zaehlt_je_pfad: Widget-Nachrichten zählen unter dem Workspace, dem das Widget beim Schreiben gehört", async () => {
    const first = await createWorkspace(db.client);
    const second = await createWorkspace(db.client);
    const embed = await createEmbed(db.client, first);

    await EmbedChats.new({
      embedId: embed.id,
      prompt: "a",
      sessionId: "s",
    });
    await db.client.embed_configs.update({
      where: { id: embed.id },
      data: { workspace_id: second.id },
    });
    await EmbedChats.new({
      embedId: embed.id,
      prompt: "b",
      sessionId: "s",
    });

    expect(await totals({ workspace_id: first.id })).toEqual(
      expect.objectContaining({ messages: 1 })
    );
    expect(await totals({ workspace_id: second.id })).toEqual(
      expect.objectContaining({ messages: 1 })
    );
  });

  test("record nimmt nur Werte >= 0 an: Auf diesem Weg sinkt kein Zähler", async () => {
    const workspace = await createWorkspace(db.client);
    const at = new Date("2026-10-12T10:00:00+02:00");
    await MessageLedger.transaction({ source: "test" }, (tx) =>
      MessageLedger.record(tx, { workspaceId: workspace.id, at, messages: 3 })
    );

    for (const params of [
      { messages: -1 },
      { copied: -2 },
      { messages: 1.5 },
      { messages: "2" },
    ])
      await expect(
        MessageLedger.transaction({ source: "test" }, (tx) =>
          MessageLedger.record(tx, { workspaceId: workspace.id, at, ...params })
        )
      ).rejects.toThrow(/invalid/);

    expect(await ledgerRows(db.client)).toEqual([
      expect.objectContaining({ day: "2026-10-12", hour: 10, messages: 3 }),
    ]);
  });
});

describe("sommerzeit (AK-6)", () => {
  // Berliner Wanduhrzeit → Zeitpunkt, ausdrücklich mit UTC-Versatz
  const instants = {
    spring0159: new Date("2026-03-29T01:59:00+01:00"),
    spring0301: new Date("2026-03-29T03:01:00+02:00"),
    autumn0230first: new Date("2026-10-25T02:30:00+02:00"),
    autumn0230second: new Date("2026-10-25T02:30:00+01:00"),
  };
  const expectedCells = [
    { day: "2026-03-29", hour: 1, messages: 1 },
    { day: "2026-03-29", hour: 3, messages: 1 },
    // beide Durchläufe von 02:30 Uhr gemeinsam in Stunde 2
    { day: "2026-10-25", hour: 2, messages: 2 },
  ];

  test("sommerzeit: berlinDayHour ordnet Tag und Stunde unabhängig von der Zeitzone des Prozesses zu", () => {
    expect(MessageLedger.berlinDayHour(instants.spring0159)).toEqual({
      day: "2026-03-29",
      hour: 1,
    });
    expect(MessageLedger.berlinDayHour(instants.spring0301)).toEqual({
      day: "2026-03-29",
      hour: 3,
    });
    expect(MessageLedger.berlinDayHour(instants.autumn0230first)).toEqual({
      day: "2026-10-25",
      hour: 2,
    });
    expect(MessageLedger.berlinDayHour(instants.autumn0230second)).toEqual({
      day: "2026-10-25",
      hour: 2,
    });
    // Tagesgrenze: 23:59:59,999 und 00:00:00,000 Berliner Zeit
    expect(
      MessageLedger.berlinDayHour(new Date("2026-10-11T21:59:59.999Z"))
    ).toEqual({ day: "2026-10-11", hour: 23 });
    expect(
      MessageLedger.berlinDayHour(new Date("2026-10-11T22:00:00.000Z"))
    ).toEqual({ day: "2026-10-12", hour: 0 });
    // Winter: 23:30 UTC ist schon der nächste Berliner Tag
    expect(
      MessageLedger.berlinDayHour(new Date("2026-12-31T23:30:00Z"))
    ).toEqual({ day: "2027-01-01", hour: 0 });
    expect(() => MessageLedger.berlinDayHour("kein Datum")).toThrow();
  });

  test("sommerzeit: beim Anlegen gezählte Nachrichten liegen am richtigen Berliner Tag, 02:30 Uhr zweimal in Stunde 2", async () => {
    const workspace = await createWorkspace(db.client);
    for (const at of Object.values(instants))
      await MessageLedger.transaction({ source: "test" }, (tx) =>
        MessageLedger.record(tx, { workspaceId: workspace.id, at, messages: 1 })
      );

    expect(
      (await ledgerRows(db.client)).map(({ day, hour, messages }) => ({
        day,
        hour,
        messages,
      }))
    ).toEqual(expectedCells);
  });

  test("sommerzeit: der Nachtrag ordnet Bestandszeilen genauso zu (Workspace- und Widget-Chats)", async () => {
    const workspace = await createWorkspace(db.client);
    const embed = await createEmbed(db.client, workspace);
    await seedWorkspaceChats(
      db.client,
      Object.values(instants).map((createdAt) => ({
        workspaceId: workspace.id,
        createdAt,
      }))
    );
    await seedEmbedChats(
      db.client,
      Object.values(instants).map((createdAt) => ({
        embed_id: embed.id,
        createdAt,
      }))
    );

    expect((await runMessageLedgerBackfill(quiet)).ok).toBe(true);

    for (const embedId of [0, embed.id])
      expect(
        (await ledgerRows(db.client, { embed_id: embedId })).map(
          ({ day, hour, messages }) => ({ day, hour, messages })
        )
      ).toEqual(expectedCells);
    // Am Tag der Umstellung auf Sommerzeit gibt es keine Stunde 2.
    expect(
      await db.client.message_ledger.count({
        where: { day: "2026-03-29", hour: 2 },
      })
    ).toBe(0);
  });
});

describe("feedback_uebergaenge (AK-11)", () => {
  async function feedbackOf(workspaceId, embedId, instant) {
    const cell = await cellAt(workspaceId, embedId, instant);
    return [cell?.feedback_positive ?? null, cell?.feedback_negative ?? null];
  }

  test("feedback_uebergaenge: Bewertung einer Nachricht von gestern 14 Uhr wird auf gestern 14 Uhr gebucht", async () => {
    const workspace = await createWorkspace(db.client);
    const embed = await createEmbed(db.client, workspace);
    const yesterday = berlinCell(Date.now() - 24 * 60 * 60 * 1000).day;
    const createdAt = berlinInstant(yesterday, 14, 20);
    await seedEmbedChats(db.client, [
      { embed_id: embed.id, createdAt, session_id: "sitzung" },
    ]);
    const chat = await db.client.embed_chats.findFirst();
    expect((await runMessageLedgerBackfill(quiet)).ok).toBe(true);
    expect(await feedbackOf(workspace.id, embed.id, createdAt)).toEqual([0, 0]);

    // positiv, negativ, entfernt, positiv, positiv
    const steps = [
      [true, [1, 0]],
      [false, [0, 1]],
      [null, [0, 0]],
      [true, [1, 0]],
      [true, [1, 0]],
    ];
    for (const [score, expected] of steps) {
      expect(
        await EmbedChats.updateFeedbackScore(
          embed.id,
          "sitzung",
          chat.id,
          score
        )
      ).toBe(true);
      expect(await feedbackOf(workspace.id, embed.id, createdAt)).toEqual(
        expected
      );
    }

    // Gebucht wurde nur auf die Stunde, in der die Nachricht entstand.
    expect(await ledgerRows(db.client)).toEqual([
      expect.objectContaining({
        day: yesterday,
        hour: 14,
        messages: 1,
        feedback_positive: 1,
        feedback_negative: 0,
      }),
    ]);
  });

  test("feedback_uebergaenge: eine eben angelegte Nachricht wird in ihrer Stunde bewertet; die Zähler fallen nie unter 0", async () => {
    const workspace = await createWorkspace(db.client);
    const embed = await createEmbed(db.client, workspace);
    const { chat } = await EmbedChats.new({
      embedId: embed.id,
      prompt: "Frage",
      sessionId: "sitzung",
    });

    await EmbedChats.updateFeedbackScore(embed.id, "sitzung", chat.id, false, {
      feedbackText: "zu ungenau",
    });
    expect(await feedbackOf(workspace.id, embed.id, chat.createdAt)).toEqual([
      0, 1,
    ]);
    // Derselbe Wert mit neuem Kommentar ist kein Übergang.
    await EmbedChats.updateFeedbackScore(embed.id, "sitzung", chat.id, false, {
      feedbackText: "immer noch",
    });
    expect(await feedbackOf(workspace.id, embed.id, chat.createdAt)).toEqual([
      0, 1,
    ]);

    // Künstlich verstellter Zähler: Entfernen der Bewertung drückt ihn nicht unter 0.
    await db.client.message_ledger.updateMany({
      data: { feedback_negative: 0 },
    });
    await EmbedChats.updateFeedbackScore(embed.id, "sitzung", chat.id, null);
    expect(await feedbackOf(workspace.id, embed.id, chat.createdAt)).toEqual([
      0, 0,
    ]);
  });

  test("feedback_uebergaenge: wird die bewertete Nachricht gelöscht, bleibt ihr letzter Stand gezählt", async () => {
    const workspace = await createWorkspace(db.client);
    const embed = await createEmbed(db.client, workspace);
    const { chat } = await EmbedChats.new({
      embedId: embed.id,
      prompt: "Frage",
      sessionId: "sitzung",
    });
    await EmbedChats.updateFeedbackScore(embed.id, "sitzung", chat.id, true);
    await EmbedChats.delete({ id: chat.id });

    expect(await feedbackOf(workspace.id, embed.id, chat.createdAt)).toEqual([
      1, 0,
    ]);
  });

  test("feedback_uebergaenge: vor dem Nachtrag bewertete Bestandszeilen werden nicht doppelt gebucht", async () => {
    const workspace = await createWorkspace(db.client);
    const embed = await createEmbed(db.client, workspace);
    const createdAt = new Date("2026-10-01T09:15:00+02:00");
    await seedEmbedChats(db.client, [
      { embed_id: embed.id, createdAt, session_id: "sitzung" },
    ]);
    const chat = await db.client.embed_chats.findFirst();

    // Der Nachtrag ist noch nicht gelaufen: Die Zeile steht nicht im
    // Zählerbuch, der Übergang wird deshalb nicht gebucht …
    expect(
      await EmbedChats.updateFeedbackScore(embed.id, "sitzung", chat.id, true)
    ).toBe(true);
    expect(await ledgerRows(db.client)).toEqual([]);

    // … der Nachtrag erfasst die Zeile mit ihrem dann aktuellen Stand.
    expect((await runMessageLedgerBackfill(quiet)).ok).toBe(true);
    expect(await feedbackOf(workspace.id, embed.id, createdAt)).toEqual([1, 0]);
    await EmbedChats.updateFeedbackScore(embed.id, "sitzung", chat.id, false);
    expect(await feedbackOf(workspace.id, embed.id, createdAt)).toEqual([0, 1]);
  });

  test("feedback_uebergaenge: nach dem Umhängen des Widgets wird auf die Zeile gebucht, in der die Nachricht gezählt wurde", async () => {
    const first = await createWorkspace(db.client);
    const second = await createWorkspace(db.client);
    const embed = await createEmbed(db.client, first);
    const { chat } = await EmbedChats.new({
      embedId: embed.id,
      prompt: "Frage",
      sessionId: "sitzung",
    });
    await db.client.embed_configs.update({
      where: { id: embed.id },
      data: { workspace_id: second.id },
    });

    await EmbedChats.updateFeedbackScore(embed.id, "sitzung", chat.id, true);

    expect(await feedbackOf(first.id, embed.id, chat.createdAt)).toEqual([
      1, 0,
    ]);
    expect(await totals({ workspace_id: second.id })).toEqual(
      expect.objectContaining({ feedback_positive: 0, messages: 0 })
    );
  });

  describe("in derselben Stunde umgehängt: Zeilen unter beiden Workspaces", () => {
    const createdAt = new Date("2026-10-01T09:15:00+02:00");
    let first;
    let second;
    let embed;
    let chat;

    // Eine Nachricht des Widgets unter first gezählt, danach umgehängt; eine
    // weitere Nachricht derselben Stunde zählt unter second.
    async function moveWithinHour(score) {
      first = await createWorkspace(db.client);
      second = await createWorkspace(db.client);
      embed = await createEmbed(db.client, first);
      await seedEmbedChats(db.client, [
        { embed_id: embed.id, createdAt, session_id: "sitzung" },
      ]);
      chat = await db.client.embed_chats.findFirst();
      expect((await runMessageLedgerBackfill(quiet)).ok).toBe(true);
      await EmbedChats.updateFeedbackScore(embed.id, "sitzung", chat.id, score);

      await db.client.embed_configs.update({
        where: { id: embed.id },
        data: { workspace_id: second.id },
      });
      await MessageLedger.transaction({ source: "test" }, (tx) =>
        MessageLedger.record(tx, {
          workspaceId: second.id,
          embedId: embed.id,
          at: new Date("2026-10-01T09:40:00+02:00"),
          messages: 1,
        })
      );
      expect(
        (await ledgerRows(db.client)).map((row) => [
          row.workspace_id,
          row.hour,
          row.messages,
        ])
      ).toEqual([
        [first.id, 9, 1],
        [second.id, 9, 1],
      ]);
    }
    const feedback = async () => [
      await feedbackOf(first.id, embed.id, createdAt),
      await feedbackOf(second.id, embed.id, createdAt),
    ];
    const rate = (score) =>
      EmbedChats.updateFeedbackScore(embed.id, "sitzung", chat.id, score);

    test("feedback_uebergaenge: eine entfernte Bewertung wird dort abgezogen, wo sie gebucht wurde - es bleibt kein alter Stand stehen", async () => {
      await moveWithinHour(true);
      expect(await feedback()).toEqual([
        [1, 0],
        [0, 0],
      ]);

      expect(await rate(null)).toBe(true);
      expect(await feedback()).toEqual([
        [0, 0],
        [0, 0],
      ]);

      // Eine neue Bewertung steht unter dem heutigen Workspace des Widgets
      // und wird auch dort wieder abgezogen.
      await rate(false);
      expect(await feedback()).toEqual([
        [0, 0],
        [0, 1],
      ]);
      await rate(null);
      expect(await feedback()).toEqual([
        [0, 0],
        [0, 0],
      ]);
    });

    test("feedback_uebergaenge: ein Wechsel 👎 → 👍 bleibt auf der Zeile, auf der die Bewertung steht", async () => {
      await moveWithinHour(false);
      expect(await feedback()).toEqual([
        [0, 1],
        [0, 0],
      ]);

      await rate(true);
      expect(await feedback()).toEqual([
        [1, 0],
        [0, 0],
      ]);
      await rate(false);
      expect(await feedback()).toEqual([
        [0, 1],
        [0, 0],
      ]);
      await rate(null);
      expect(await feedback()).toEqual([
        [0, 0],
        [0, 0],
      ]);
    });
  });
});

describe("konversationen (AK-12)", () => {
  test("konversationen: eine Sitzung mit zwei Konversationen zu je drei Nachrichten beginnt zwei Konversationen", async () => {
    const workspace = await createWorkspace(db.client);
    const embed = await createEmbed(db.client, workspace);
    for (const conversationId of ["konversation-a", "konversation-b"])
      for (let i = 0; i < 3; i++)
        await EmbedChats.new({
          embedId: embed.id,
          prompt: `Frage ${i}`,
          sessionId: "sitzung-1",
          conversationId,
        });

    expect(await totals({ embed_id: embed.id })).toEqual(
      expect.objectContaining({ messages: 6, conversations_started: 2 })
    );
  });

  test("konversationen: ohne conversation_id zählt die Sitzung als eine Konversation, je Widget getrennt", async () => {
    const workspace = await createWorkspace(db.client);
    const embed = await createEmbed(db.client, workspace);
    const other = await createEmbed(db.client, workspace);
    for (let i = 0; i < 3; i++)
      await EmbedChats.new({
        embedId: embed.id,
        prompt: `Frage ${i}`,
        sessionId: "alt-sitzung",
      });
    // dieselbe Sitzungskennung in einem anderen Widget ist eine eigene Konversation
    await EmbedChats.new({
      embedId: other.id,
      prompt: "Frage",
      sessionId: "alt-sitzung",
    });

    expect(await totals({ embed_id: embed.id })).toEqual(
      expect.objectContaining({ messages: 3, conversations_started: 1 })
    );
    expect(await totals({ embed_id: other.id })).toEqual(
      expect.objectContaining({ messages: 1, conversations_started: 1 })
    );
  });

  test("konversationen: dieselbe conversation_id in zwei Widgets beginnt in jedem Widget eine eigene Konversation", async () => {
    const workspace = await createWorkspace(db.client);
    const embed = await createEmbed(db.client, workspace);
    const other = await createEmbed(db.client, workspace);
    for (const [embedId, sessionId] of [
      [embed.id, "sitzung-1"],
      [embed.id, "sitzung-1"],
      [other.id, "sitzung-2"],
      [other.id, "sitzung-2"],
      // auch mit derselben Sitzungskennung: weiter die Konversation des Widgets
      [other.id, "sitzung-1"],
    ])
      await EmbedChats.new({
        embedId,
        prompt: "Frage",
        sessionId,
        conversationId: "gleiche-konversation",
      });

    expect(await totals({ embed_id: embed.id })).toEqual(
      expect.objectContaining({ messages: 2, conversations_started: 1 })
    );
    expect(await totals({ embed_id: other.id })).toEqual(
      expect.objectContaining({ messages: 3, conversations_started: 1 })
    );
  });

  test("konversationen: mischt eine Sitzung Zeilen mit und ohne conversation_id, zählt COALESCE(conversation_id, session_id) - beim Anlegen wie im Nachtrag", async () => {
    const workspace = await createWorkspace(db.client);
    const embed = await createEmbed(db.client, workspace);
    // [conversation_id, beginnt eine Konversation?]
    const sequence = [
      ["k-1", true],
      // ohne conversation_id: Schlüssel ist die Sitzung - noch nicht gesehen,
      // obwohl die Sitzung schon eine Zeile hat
      [null, true],
      ["k-1", false],
      [null, false],
      ["k-2", true],
      // conversation_id gleich der Sitzungskennung: setzt die Zeilen ohne
      // conversation_id fort
      ["gemischt", false],
    ];
    let started = 0;
    for (const [conversationId, starts] of sequence) {
      await EmbedChats.new({
        embedId: embed.id,
        prompt: "Frage",
        sessionId: "gemischt",
        conversationId,
      });
      if (starts) started += 1;
      expect(await totals({ embed_id: embed.id })).toEqual(
        expect.objectContaining({ conversations_started: started })
      );
    }
    expect(started).toBe(3);

    // Der Nachtrag zählt dieselben Zeilen genauso.
    const written = await db.client.embed_chats.findMany({
      orderBy: { id: "asc" },
    });
    await db.close();
    db = await createTestDatabase();
    MessageLedger._resetCache();
    const again = await createWorkspace(db.client);
    const againEmbed = await createEmbed(db.client, again);
    await seedEmbedChats(
      db.client,
      written.map(({ createdAt, session_id, conversation_id }) => ({
        embed_id: againEmbed.id,
        createdAt,
        session_id,
        conversation_id,
      }))
    );
    expect((await runMessageLedgerBackfill(quiet)).ok).toBe(true);
    expect(await totals({ embed_id: againEmbed.id })).toEqual(
      expect.objectContaining({ messages: 6, conversations_started: 3 })
    );
  });

  test("konversationen: der Nachtrag zählt dieselbe Sitzung als 2 und die Alt-Zeile ohne conversation_id über ihre session_id als 1", async () => {
    const workspace = await createWorkspace(db.client);
    const embed = await createEmbed(db.client, workspace);
    const today = berlinCell(Date.now() - 60 * 60 * 1000).day;
    const rows = [];
    // Alt-Zeilen ohne conversation_id (vor KIE-502)
    rows.push(
      {
        embed_id: embed.id,
        createdAt: new Date("2026-02-03T10:00:00+01:00"),
        session_id: "alt-sitzung",
        conversation_id: null,
      },
      {
        embed_id: embed.id,
        createdAt: new Date("2026-02-03T10:05:00+01:00"),
        session_id: "alt-sitzung",
        conversation_id: null,
      }
    );
    // Heute: eine Sitzung, zwei Konversationen mit je drei Nachrichten
    for (const [index, conversation_id] of ["k-1", "k-2"].entries())
      for (let i = 0; i < 3; i++)
        rows.push({
          embed_id: embed.id,
          createdAt: new Date(
            berlinInstant(today, 0, 1).getTime() + (index * 3 + i) * 1000
          ),
          session_id: "sitzung-heute",
          conversation_id,
        });
    await seedEmbedChats(db.client, rows);

    // kleines Paket: Die Konversationen laufen über Paketgrenzen
    expect(
      (await runMessageLedgerBackfill({ ...quiet, batchSize: 2 })).ok
    ).toBe(true);

    expect(await totals({ day: today })).toEqual(
      expect.objectContaining({ messages: 6, conversations_started: 2 })
    );
    expect(await totals({ day: "2026-02-03" })).toEqual(
      expect.objectContaining({ messages: 2, conversations_started: 1 })
    );

    // Eine weitere Nachricht der Alt-Sitzung ohne conversation_id setzt die
    // bestehende Konversation fort.
    await EmbedChats.new({
      embedId: embed.id,
      prompt: "noch eine",
      sessionId: "alt-sitzung",
    });
    expect(await totals()).toEqual(
      expect.objectContaining({ messages: 9, conversations_started: 3 })
    );
  });

  test("konversationen: wurden frühere Zeilen der Konversation gelöscht, zählt sie erneut", async () => {
    const workspace = await createWorkspace(db.client);
    const embed = await createEmbed(db.client, workspace);
    const write = () =>
      EmbedChats.new({
        embedId: embed.id,
        prompt: "Frage",
        sessionId: "s",
        conversationId: "k",
      });
    await write();
    await EmbedChats.delete({ embed_id: embed.id });
    await write();

    expect(await totals()).toEqual(
      expect.objectContaining({ messages: 2, conversations_started: 2 })
    );
  });
});

describe("atomar (NAK-3)", () => {
  // Das Hochzählen schlägt in der Datenbank fehl, mitten in der Transaktion.
  async function breakLedger() {
    await db.client.$executeRawUnsafe(
      `CREATE TRIGGER kuenstlicher_fehler BEFORE INSERT ON message_ledger
       BEGIN SELECT RAISE(ABORT, 'künstlicher Fehler im Zählerbuch'); END`
    );
  }

  test("atomar: schlägt das Hochzählen fehl, entsteht keine Chat-Zeile und ein Ereignis message_ledger_write_failed", async () => {
    const workspace = await createWorkspace(db.client);
    const embed = await createEmbed(db.client, workspace);
    await breakLedger();

    const chat = await WorkspaceChats.new({
      workspaceId: workspace.id,
      prompt: "Hallo",
      response: { text: "x" },
    });
    expect(chat.chat).toBeNull();
    expect(chat.message).toMatch(/künstlicher Fehler/);

    const widget = await EmbedChats.new({
      embedId: embed.id,
      prompt: "Hallo",
      sessionId: "s",
    });
    expect(widget.chat).toBeNull();

    const copies = await WorkspaceChats.bulkCreate([
      { workspaceId: workspace.id, prompt: "a", response: "{}" },
      { workspaceId: workspace.id, prompt: "b", response: "{}" },
    ]);
    expect(copies.chats).toBeNull();

    expect(await db.client.workspace_chats.count()).toBe(0);
    expect(await db.client.embed_chats.count()).toBe(0);
    expect(await db.client.message_ledger.count()).toBe(0);

    const events = await eventsOf(db.client, "message_ledger_write_failed");
    expect(events.map((event) => event.metadata.source)).toEqual([
      "workspace_chat",
      "embed_chat",
      "thread_fork",
    ]);
    expect(events[0].metadata).toEqual(
      expect.objectContaining({ workspaceId: workspace.id, embedId: null })
    );
    expect(events[1].metadata).toEqual(
      expect.objectContaining({ embedId: embed.id })
    );
    // Das Ereignis nennt den Fehler, aber keine Inhalte der Nachricht.
    expect(events[0].metadata.error).toMatch(/künstlicher Fehler/);
    expect(JSON.stringify(events)).not.toContain("Hallo");
  });

  test("atomar: das Ereignis enthält keine Inhalte, auch wenn die Fehlermeldung von Prisma die Argumente des Aufrufs nennt", async () => {
    const workspace = await createWorkspace(db.client);
    // response fehlt: Prisma beschreibt in der Meldung den ganzen Aufruf.
    const copies = await WorkspaceChats.bulkCreate([
      { workspaceId: workspace.id, prompt: "STRENG GEHEIMER INHALT" },
    ]);
    expect(copies.chats).toBeNull();
    expect(copies.message).toContain("STRENG GEHEIMER INHALT");

    const events = await eventsOf(db.client, "message_ledger_write_failed");
    expect(events).toHaveLength(1);
    expect(events[0].metadata).toEqual({
      source: "thread_fork",
      workspaceId: workspace.id,
      embedId: null,
      error: "PrismaClientValidationError: Argument `response` is missing.",
    });
    expect(JSON.stringify(events)).not.toContain("GEHEIM");
  });

  test("atomar: auch ein Fehler in der Zählfunktion selbst lässt keine Chat-Zeile zurück", async () => {
    const workspace = await createWorkspace(db.client);
    const recordSpy = jest
      .spyOn(MessageLedger, "record")
      .mockRejectedValue(new Error("künstlich"));
    try {
      const result = await WorkspaceChats.new({
        workspaceId: workspace.id,
        prompt: "Hallo",
      });
      expect(result).toEqual({ chat: null, message: "künstlich" });
    } finally {
      recordSpy.mockRestore();
    }
    expect(await db.client.workspace_chats.count()).toBe(0);
    expect(
      await eventsOf(db.client, "message_ledger_write_failed")
    ).toHaveLength(1);
  });

  test("atomar: das Ereignis wird je Quelle, Workspace bzw. Widget und Stunde höchstens einmal geschrieben; das nächste nennt, was dazwischen ausblieb", async () => {
    const workspace = await createWorkspace(db.client);
    const other = await createWorkspace(db.client);
    const embed = await createEmbed(db.client, workspace);
    await breakLedger();
    const startedAt = Date.now();
    const nowSpy = jest.spyOn(Date, "now").mockReturnValue(startedAt);
    const fail = async (workspaceId) =>
      expect(
        (await WorkspaceChats.new({ workspaceId, prompt: "Hallo" })).chat
      ).toBeNull();
    const reported = async () =>
      (await eventsOf(db.client, "message_ledger_write_failed")).map(
        ({ metadata }) => [
          metadata.source,
          metadata.workspaceId,
          metadata.embedId,
          metadata.suppressed,
        ]
      );

    // Ein anhaltender Fehler: vier gescheiterte Speicherungen, ein Ereignis.
    for (let i = 0; i < 4; i++) await fail(workspace.id);
    errorSpy.mockClear();
    await fail(workspace.id);
    expect(await reported()).toEqual([
      ["workspace_chat", workspace.id, null, undefined],
    ]);
    // In der Konsole steht jeder Fehler.
    expect(
      errorSpy.mock.calls.filter(([text]) =>
        String(text).includes("Chat-Zeile und Zähler nicht geschrieben")
      )
    ).toHaveLength(1);

    // Ein anderer Workspace, eine andere Quelle und ein Widget melden für sich.
    await fail(other.id);
    await WorkspaceChats.bulkCreate([
      { workspaceId: workspace.id, prompt: "a", response: "{}" },
    ]);
    for (let i = 0; i < 2; i++)
      await EmbedChats.new({ embedId: embed.id, prompt: "a", sessionId: "s" });
    expect(await reported()).toEqual([
      ["workspace_chat", workspace.id, null, undefined],
      ["workspace_chat", other.id, null, undefined],
      ["thread_fork", workspace.id, null, undefined],
      ["embed_chat", null, embed.id, undefined],
    ]);

    // Kurz vor dem Stundenwechsel noch still, in der nächsten Stunde wieder
    // ein Ereignis - mit der Zahl der seither nicht gemeldeten Fehler.
    const nextHour = (Math.floor(startedAt / 3600000) + 1) * 3600000;
    nowSpy.mockReturnValue(nextHour - 1);
    await fail(workspace.id);
    expect(await reported()).toHaveLength(4);
    nowSpy.mockReturnValue(nextHour);
    await fail(workspace.id);
    await fail(workspace.id);
    expect((await reported()).slice(4)).toEqual([
      ["workspace_chat", workspace.id, null, 5],
    ]);
    nowSpy.mockReturnValue(nextHour + 3600000);
    await fail(workspace.id);
    expect((await reported()).slice(5)).toEqual([
      ["workspace_chat", workspace.id, null, 1],
    ]);
    nowSpy.mockRestore();
    expect(await db.client.workspace_chats.count()).toBe(0);
  });

  test("atomar: kein Zähler ohne Zeile - scheitert das Anlegen der Chat-Zeile, bleibt das Zählerbuch unverändert", async () => {
    const workspace = await createWorkspace(db.client);
    await WorkspaceChats.new({ workspaceId: workspace.id, prompt: "ok" });
    const before = await ledgerRows(db.client);

    // Widget gibt es nicht: Der Fremdschlüssel lässt die Chat-Zeile nicht zu.
    const widget = await EmbedChats.new({
      embedId: 9999,
      prompt: "Hallo",
      sessionId: "s",
    });
    expect(widget.chat).toBeNull();
    // Die zweite Kopie ist ungültig: Auch die erste entsteht nicht.
    const copies = await WorkspaceChats.bulkCreate([
      { workspaceId: workspace.id, prompt: "a", response: "{}" },
      { workspaceId: workspace.id, prompt: "b" },
    ]);
    expect(copies.chats).toBeNull();

    expect(await db.client.workspace_chats.count()).toBe(1);
    expect(await db.client.embed_chats.count()).toBe(0);
    expect(await ledgerRows(db.client)).toEqual(before);
  });

  test("atomar: die Transaktion ist interaktiv und hat ausdrücklich gesetzte Werte für maxWait und timeout", async () => {
    const workspace = await createWorkspace(db.client);
    const transactionSpy = jest.spyOn(db.client, "$transaction");
    await WorkspaceChats.new({ workspaceId: workspace.id, prompt: "Hallo" });

    expect(transactionSpy).toHaveBeenCalledTimes(1);
    const [work, options] = transactionSpy.mock.calls[0];
    expect(typeof work).toBe("function");
    expect(options).toEqual({ maxWait: 5000, timeout: 10000 });
    transactionSpy.mockRestore();
  });
});

describe("Regeln am Quelltext", () => {
  const serverRoot = path.resolve(__dirname, "../..");

  function sourceFiles(dir = serverRoot, files = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (
        ["node_modules", "__tests__", "storage", "public"].includes(entry.name)
      )
        continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) sourceFiles(full, files);
      else if (/\.(js|cjs|mjs|ts)$/.test(entry.name)) files.push(full);
    }
    return files;
  }

  function occurrences(pattern) {
    const found = {};
    for (const file of sourceFiles()) {
      const matches = fs.readFileSync(file, "utf8").match(pattern);
      if (matches)
        found[path.relative(serverRoot, file).split(path.sep).join("/")] =
          matches.length;
    }
    return found;
  }

  test("kein_roher_create: Chat-Zeilen entstehen nur in den drei Modellfunktionen (NAK-4)", () => {
    // Anlegen über Prisma (auch als Massen- oder Upsert-Aufruf) …
    const creates = occurrences(
      /\b(workspace_chats|embed_chats)\s*\.\s*(create|createMany|createManyAndReturn|upsert)\s*\(/g
    );
    expect(creates).toEqual({
      // WorkspaceChats.new und WorkspaceChats.bulkCreate
      "models/workspaceChats.js": 2,
      // EmbedChats.new
      "models/embedChats.js": 1,
      // Namentliche Ausnahmen: Entwickler-Skripte für Testdaten, nicht Teil des
      // Servers. Was sie anlegen, zählt nicht.
      "create-old-chats.js": 3,
      "test-retention.js": 1,
    });

    // … und nicht an Prisma vorbei.
    expect(
      occurrences(
        /INSERT\s+(OR\s+\w+\s+)?INTO\s+["'`]?(workspace_chats|embed_chats)\b/gi
      )
    ).toEqual({});

    // In den Modellen läuft jedes Anlegen über die Transaktion (tx), nie
    // direkt über den Client - und jede der drei Funktionen zählt über die
    // eine gemeinsame Funktion.
    const workspaceChats = fs.readFileSync(
      path.join(serverRoot, "models/workspaceChats.js"),
      "utf8"
    );
    const embedChats = fs.readFileSync(
      path.join(serverRoot, "models/embedChats.js"),
      "utf8"
    );
    expect(
      workspaceChats.match(/\btx\.workspace_chats\.create\(/g)
    ).toHaveLength(2);
    expect(embedChats.match(/\btx\.embed_chats\.create\(/g)).toHaveLength(1);
    expect(workspaceChats.match(/MessageLedger\.record\(tx,/g)).toHaveLength(2);
    expect(embedChats.match(/MessageLedger\.record\(tx,/g)).toHaveLength(1);
    expect(workspaceChats.match(/MessageLedger\.transaction\(/g)).toHaveLength(
      2
    );

    // Außerhalb der Modelle ruft niemand die Zählfunktion auf.
    expect(Object.keys(occurrences(/MessageLedger\.record\(/g)).sort()).toEqual(
      [
        "models/embedChats.js",
        "models/messageLedger.js",
        "models/workspaceChats.js",
      ]
    );
  });

  test("keine Batch-Transaktion: $transaction erhält überall eine an Ort und Stelle geschriebene Funktion, nie eine Liste (Hard Constraint 2)", () => {
    // Hard Constraint 2 (KIE-532): Batch-Transaktionen - prisma.$transaction([…])
    // - sind für Schreibpfade unzulässig. Prisma 6.14 lässt mit SQLite nach
    // einem fehlgeschlagenen COMMIT die Verbindung mit offener Transaktion
    // zurück: Die Datenbank bleibt bis zum Neustart gesperrt, spätere
    // Schreibzugriffe gehen still verloren (gemessen im Architektur-Review vom
    // 12.10.2026). Zulässig ist allein die interaktive Form
    // $transaction(async (tx) => …).
    //
    // Geprüft wird das erste Argument jedes Aufrufs: Es muss eine dort
    // geschriebene Funktion sein. Eine Liste ([…], x.map(…)) oder ein Name,
    // hinter dem eine Liste stehen kann, zählt als Batch-Transaktion.
    const INLINE_FUNCTION =
      /^(async\s+)?(function\b|\([^()]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/;
    const batches = {};
    let calls = 0;
    for (const file of sourceFiles()) {
      const source = fs.readFileSync(file, "utf8");
      for (const match of source.matchAll(/\$transaction\s*\(\s*/g)) {
        calls += 1;
        const argument = source.slice(match.index + match[0].length);
        if (INLINE_FUNCTION.test(argument)) continue;
        const name = path.relative(serverRoot, file).split(path.sep).join("/");
        batches[name] = (batches[name] ?? 0) + 1;
      }
    }

    expect(batches).toEqual({
      // Namentliche Ausnahmen: Bestand aus dem Upstream-Code, vor KIE-532 und
      // außerhalb des Zählerbuchs (Rechtezuordnung, Wiederherstellungscodes,
      // Vektor-Verweise). Sie tragen dasselbe Risiko und sind hier
      // festgehalten, damit keine weitere dazukommt; ihre Umstellung ist nicht
      // Teil von KIE-532.
      "models/workspaceUsers.js": 2,
      "models/passwordRecovery.js": 1,
      "models/vectors.js": 1,
    });
    // Die Prüfung sieht die interaktiven Transaktionen des Zählerbuchs.
    expect(calls).toBeGreaterThanOrEqual(4 + 5);

    // Gegenprobe der Erkennung
    for (const batch of [
      "[a, b])",
      "inserts)",
      "ids.map((id) => prisma.x.create({ data: { id } })))",
      "[\n  prisma.a.create()])",
    ])
      expect(INLINE_FUNCTION.test(batch)).toBe(false);
    for (const interactive of [
      "async (tx) => {",
      "(tx) => work(tx),",
      "async function (tx) {",
      "tx => work(tx))",
    ])
      expect(INLINE_FUNCTION.test(interactive)).toBe(true);
  });

  test("kein Löschpfad fasst das Zählerbuch an: nirgends wird eine Zeile gelöscht oder ein Zähler gesenkt", () => {
    expect(
      occurrences(
        /message_ledger\s*\.\s*(delete|deleteMany|update|updateMany|upsert)\s*\(/g
      )
    ).toEqual({});
    expect(
      occurrences(/(DELETE\s+FROM|UPDATE)\s+["'`]?message_ledger\b/gi)
    ).toEqual({});

    // Geschrieben wird nur an zwei Stellen, beide in models/messageLedger.js:
    // addCells (addiert Werte >= 0) und adjustFeedback (nur die Bewertungen).
    expect(occurrences(/INSERT\s+INTO\s+message_ledger\b/gi)).toEqual({
      "models/messageLedger.js": 2,
    });
    const ledger = fs.readFileSync(
      path.join(serverRoot, "models/messageLedger.js"),
      "utf8"
    );
    // Was die beiden Anweisungen an einer vorhandenen Zeile ändern:
    const updates = [...ledger.matchAll(/DO UPDATE SET([^`]+)`/g)].map(
      (match) =>
        match[1]
          .split(",\n")
          .map((assignment) => assignment.trim().replace(/\s+/g, " "))
    );
    expect(updates).toEqual([
      [
        "messages = messages + excluded.messages",
        "copied = copied + excluded.copied",
        "conversations_started = conversations_started + excluded.conversations_started",
        "feedback_positive = feedback_positive + excluded.feedback_positive",
        "feedback_negative = feedback_negative + excluded.feedback_negative",
      ],
      [
        "feedback_positive = MAX(0, feedback_positive + ${positive})",
        "feedback_negative = MAX(0, feedback_negative + ${negative})",
      ],
    ]);
  });

  test("nur_zaehlspalten: das Zählerbuch enthält keine Inhalte, Sitzungs-, Konversations- oder Verbindungsdaten (NAK-5)", async () => {
    const allowed = [
      "id",
      "workspace_id",
      "embed_id",
      "day",
      "hour",
      "messages",
      "copied",
      "conversations_started",
      "feedback_positive",
      "feedback_negative",
    ];

    // Prisma-Modell
    const model = Prisma.dmmf.datamodel.models.find(
      (entry) => entry.name === "message_ledger"
    );
    expect(
      model.fields
        .filter((field) => field.kind === "scalar")
        .map((field) => field.name)
    ).toEqual(allowed);
    expect(
      model.fields
        .filter((field) => field.kind !== "scalar")
        .map((field) => field.name)
    ).toEqual(["workspace"]);
    // Einzige Textspalte ist der Kalendertag.
    expect(
      model.fields
        .filter((field) => field.type === "String")
        .map((field) => field.name)
    ).toEqual(["day"]);

    // Tabelle in der Datenbank
    const columns = await db.client.$queryRaw`
      SELECT name, type FROM pragma_table_info('message_ledger') ORDER BY cid`;
    expect(columns.map((column) => column.name)).toEqual(allowed);
    expect(
      columns
        .filter((column) => column.type !== "INTEGER")
        .map((column) => column.name)
    ).toEqual(["day"]);

    // embed_id ohne Fremdschlüssel, workspace_id mit Kaskade
    const foreignKeys = await db.client.$queryRaw`
      SELECT "from", "table", on_delete FROM pragma_foreign_key_list('message_ledger')`;
    expect(foreignKeys).toEqual([
      { from: "workspace_id", table: "workspaces", on_delete: "CASCADE" },
    ]);
  });

  test("nur_zaehlspalten: Schlüssel und Indizes wie vorgegeben", async () => {
    const indexes = await db.client.$queryRaw`
      SELECT name, sql FROM sqlite_master
      WHERE type = 'index' AND tbl_name IN ('message_ledger', 'embed_chats')
        AND name IN (
          'message_ledger_workspace_id_embed_id_day_hour_key',
          'message_ledger_workspace_id_day_idx',
          'message_ledger_embed_id_day_idx',
          'embed_chats_embed_id_createdAt_idx'
        )
      ORDER BY name`;
    expect(indexes.map((index) => index.sql)).toEqual([
      'CREATE INDEX "embed_chats_embed_id_createdAt_idx" ON "embed_chats"("embed_id", "createdAt")',
      'CREATE INDEX "message_ledger_embed_id_day_idx" ON "message_ledger"("embed_id", "day")',
      'CREATE INDEX "message_ledger_workspace_id_day_idx" ON "message_ledger"("workspace_id", "day")',
      'CREATE UNIQUE INDEX "message_ledger_workspace_id_embed_id_day_hour_key" ON "message_ledger"("workspace_id", "embed_id", "day", "hour")',
    ]);
  });

  test("das Zählerbuch überlebt das Löschen des Widgets und verschwindet erst mit dem Workspace", async () => {
    const workspace = await createWorkspace(db.client);
    const embed = await createEmbed(db.client, workspace);
    await EmbedChats.new({ embedId: embed.id, prompt: "a", sessionId: "s" });

    await db.client.embed_configs.delete({ where: { id: embed.id } });
    expect(await db.client.embed_chats.count()).toBe(0);
    expect(await totals({ embed_id: embed.id })).toEqual(
      expect.objectContaining({ messages: 1 })
    );

    await db.client.workspaces.delete({ where: { id: workspace.id } });
    expect(await db.client.message_ledger.count()).toBe(0);
  });
});
