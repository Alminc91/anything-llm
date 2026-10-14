/* eslint-env jest, node */
// KIE-533 — Widget-Endpunkte der Oberfläche sind an den Workspace gebunden.
//
// Geprüft wird gegen die echten Routen mit ihrer ganzen Middleware-Kette
// (siehe support/routeHarness.js): Anmeldung, Rollenprüfung, Modelle echt,
// nur die Datenbank ist ein Ersatz im Speicher.
//
// Regel (Muster des Konversations-Endpunkts, KIE-527): Die Bindung greift nur
// für die Rolle default. admin und manager sind nicht eingeschränkt; ohne
// Mehrbenutzermodus gibt es kein Nutzerobjekt, dann wird nicht geprüft.
jest.mock("../../utils/prisma", () =>
  require("./support/routeHarness").createFakePrisma()
);
jest.mock("../../models/telemetry", () => ({
  Telemetry: { sendTelemetry: jest.fn() },
}));
jest.mock("../../models/eventLogs", () => ({
  EventLogs: { logEvent: jest.fn() },
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
// Der Upload selbst (multer) ist ersetzt: Entscheidend ist, ob die Kette ihn
// überhaupt erreicht.
jest.mock("../../utils/files/multer", () => ({
  handleEmbedLogoUpload: jest.fn((request, _response, next) => {
    request.randomFileName = "logo-neu.png";
    next();
  }),
}));
jest.mock("../../utils/files/embedLogo", () => ({
  deleteOldEmbedLogo: jest.fn(),
}));

const prisma = require("../../utils/prisma");
const { EventLogs } = require("../../models/eventLogs");
const { EmbedChats } = require("../../models/embedChats");
const { handleEmbedLogoUpload } = require("../../utils/files/multer");
const { deleteOldEmbedLogo } = require("../../utils/files/embedLogo");
const { embedManagementEndpoints } = require("../../endpoints/embedManagement");
const {
  chatHistoryViewable,
} = require("../../utils/middleware/chatHistoryViewable");
const {
  collectRoutes,
  invoke,
  setMultiUserMode,
  createUser,
} = require("./support/routeHarness");

const routes = collectRoutes(embedManagementEndpoints);
const ROUTE = {
  create: routes["POST /embeds/new"],
  update: routes["POST /embed/update/:embedId"],
  remove: routes["DELETE /embed/:embedId"],
  // KIE-538: tritt an die Stelle von DELETE /embed/chats/:chatId (einzelne
  // Nachricht), das mit der Nachrichtentabelle entfallen ist. Die Konversation
  // bezeichnet der Rumpf über die id ihrer ersten Zeile ({ chatId }).
  // Ausführlich geprüft in models/embedChatsDeleteConversation.test.js.
  deleteConversation: routes["DELETE /embed/:embedId/conversation"],
  // Flache Nachrichtenliste der entfallenen Nachrichtentabelle: bleibt
  // bestehen (siehe „nachrichtentabelle_entfallen").
  chats: routes["POST /embed/chats"],
  clearChats: routes["DELETE /embed-chats/clear/:embedId"],
  uploadLogo: routes["POST /embed/:embedId/upload-logo"],
  removeLogo: routes["DELETE /embed/:embedId/remove-logo"],
  overview: routes["POST /embed/:embedId/analytics/overview"],
  conversation: routes["GET /embed/:embedId/conversation/:chatId"],
};
// Vergleichsroute für AK-13 (KIE-527): dieselbe Ablehnung bei abgeschaltetem
// Chat-Verlauf.
const CONVERSATION_LIST =
  routes["POST /embed/:embedId/analytics/conversations"];

let workspaceA, workspaceB, workspaceC;
let embedA, embedB;
let chatA, chatB;

function seedWorkspace(name) {
  return prisma.__seed("workspaces", { name, slug: name.toLowerCase() });
}

function seedEmbed(workspace, extra = {}) {
  return prisma.__seed("embed_configs", {
    uuid: `uuid-${workspace.slug}-${prisma.__rows("embed_configs").length}`,
    enabled: true,
    chat_mode: "query",
    workspace_id: workspace.id,
    chat_retention_days: null,
    retention_started_at: null,
    visual_config: JSON.stringify({ logoFilename: "logo-alt.png" }),
    ...extra,
  });
}

function seedChat(embed, extra = {}) {
  return prisma.__seed("embed_chats", {
    prompt: "Wann beginnt der Kurs?",
    response: JSON.stringify({ text: "Am Montag." }),
    session_id: `session-${embed.id}`,
    conversation_id: null,
    feedbackScore: null,
    embed_id: embed.id,
    ...extra,
  });
}

const embedRow = (id) =>
  prisma.__rows("embed_configs").find((row) => row.id === id);
const chatIds = () => prisma.__rows("embed_chats").map((row) => row.id);
const snapshot = () =>
  JSON.stringify({
    embeds: prisma.__rows("embed_configs"),
    chats: prisma.__rows("embed_chats"),
  });

beforeAll(() => {
  jest.spyOn(console, "error").mockImplementation(() => {});
  jest.spyOn(console, "log").mockImplementation(() => {});
});

afterAll(() => {
  console.error.mockRestore();
  console.log.mockRestore();
});

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.DISABLE_VIEW_CHAT_HISTORY;
  prisma.__reset();
  setMultiUserMode(prisma, true);

  workspaceA = seedWorkspace("A");
  workspaceB = seedWorkspace("B");
  workspaceC = seedWorkspace("C");
  embedA = seedEmbed(workspaceA);
  embedB = seedEmbed(workspaceB);
  chatA = seedChat(embedA);
  chatB = seedChat(embedB);
});

test("alle geprüften Routen sind registriert", () => {
  for (const chain of Object.values(ROUTE)) {
    expect(Array.isArray(chain)).toBe(true);
    expect(chain.length).toBeGreaterThan(1);
  }
});

// ============================================================================
// KIE-538 — Die Nachrichtentabelle ist entfallen
// ============================================================================
describe("nachrichtentabelle_entfallen (KIE-538)", () => {
  const registered = (method) =>
    Object.keys(routes)
      .filter((key) => key.startsWith(`${method} `))
      .sort();

  test("DELETE /embed/chats/:chatId (einzelne Nachricht) gibt es nicht mehr - gelöscht wird nur über genau diese Routen", () => {
    expect(routes["DELETE /embed/chats/:chatId"]).toBeUndefined();
    // Positivliste: Eine weitere Lösch-Route (etwa nach einer
    // Konfliktauflösung) fällt hier auf.
    expect(registered("DELETE")).toEqual([
      "DELETE /embed-chats/clear/:embedId",
      "DELETE /embed/:embedId",
      "DELETE /embed/:embedId/conversation",
      "DELETE /embed/:embedId/conversation/visitor",
      "DELETE /embed/:embedId/remove-logo",
    ]);
  });

  test("Keine Lösch-Route trägt eine vom Besucher vergebene Kennung in der Adresse - der einzige Platzhalter ist :embedId", () => {
    // "." und ".." löst der Browser als Pfadsegmente auf: Aus
    // DELETE /embed/5/conversation/.. würde DELETE /embed/5/, das Widget.
    for (const key of registered("DELETE"))
      expect([key, key.match(/:\w+/g)]).toEqual([key, [":embedId"]]);
    // Auch die Einzelansicht nennt die Konversation nicht mehr über eine
    // Kennung des Besuchers, sondern über die id einer Zeile.
    expect(
      Object.keys(routes).filter((key) =>
        /:(conversationId|sessionId)\b/.test(key)
      )
    ).toEqual([]);
  });

  test("Konversationen löschen nur mit Einsichtsrecht: chatHistoryViewable steht an erster Stelle (NAK-5)", () => {
    for (const key of [
      "DELETE /embed/:embedId/conversation",
      "DELETE /embed/:embedId/conversation/visitor",
      "POST /embed/:embedId/conversation/deletion-preview",
    ])
      expect([key, routes[key][0]]).toEqual([key, chatHistoryViewable]);
  });

  describe("POST /embed/chats bleibt (ohne Aufrufer in der Oberfläche)", () => {
    const list = (token = null, body = {}) =>
      invoke(ROUTE.chats, { body, token });

    test("default: nur Nachrichten der Widgets seiner Workspaces", async () => {
      const kunde = createUser(prisma, "default", [workspaceA.id]);
      const result = await list(kunde.token);
      expect(result.statusCode).toBe(200);
      expect(result.body.chats.map((chat) => chat.id)).toEqual([chatA.id]);
      expect(result.body.totalChats).toBe(1);
      expect(result.body.hasPages).toBe(false);

      const ohne = createUser(prisma, "default", []);
      expect((await list(ohne.token)).body).toEqual({
        chats: [],
        hasPages: false,
        totalChats: 0,
      });
    });

    test("admin und manager: alle Widgets; ohne Mehrbenutzermodus keine Prüfung", async () => {
      for (const role of ["admin", "manager"]) {
        const result = await list(createUser(prisma, role).token);
        expect(result.statusCode).toBe(200);
        expect(result.body.chats.map((chat) => chat.id)).toEqual([
          chatB.id,
          chatA.id,
        ]);
        expect(result.body.totalChats).toBe(2);
      }
      setMultiUserMode(prisma, false);
      expect((await list()).body.totalChats).toBe(2);
    });

    test("Chat-Verlauf abgeschaltet (DISABLE_VIEW_CHAT_HISTORY): 422 für jede Rolle, ohne Inhalte", async () => {
      process.env.DISABLE_VIEW_CHAT_HISTORY = "1";
      for (const role of ["admin", "manager", "default"]) {
        const user = createUser(prisma, role, [workspaceA.id]);
        const result = await list(user.token);
        expect([role, result.statusCode]).toEqual([role, 422]);
        expect(JSON.stringify(result.body)).not.toMatch(/Wann beginnt/);
      }
    });

    // Fixliste 7, F02: Die Route bleibt für den Upstream-Merge, liefert aber
    // nur noch, was die Tabelle zeigte.
    test("gehärtet (Fixliste 7, F02): keine Verbindungsdaten, nur der Text der Antwort, keine vom Besucher geleerten Zeilen", async () => {
      prisma.__reset();
      setMultiUserMode(prisma, true);
      workspaceA = seedWorkspace("A");
      embedA = seedEmbed(workspaceA);
      const shown = seedChat(embedA, {
        response: JSON.stringify({
          text: "Am Montag.",
          sources: [{ title: "kursprogramm.pdf", text: "QUELLENTEXT" }],
          metrics: { model: "gemma" },
        }),
        connection_information: JSON.stringify({
          ip: "203.0.113.7",
          host: "kunde.example.org",
          username: "max",
        }),
      });
      const plain = seedChat(embedA, { response: "kein JSON" });
      seedChat(embedA, {
        prompt: "geleerte Frage",
        include: false,
        connection_information: JSON.stringify({ ip: "203.0.113.8" }),
      });

      // Den Text liest die Route per SQL (Fixliste 8, L3; echt geprüft in
      // embedConversationSearch.test.js) – hier die Antwort der Datenbank
      prisma.__onRawQuery = (sql) =>
        /json_extract\(response, '\$\.text'\)/.test(sql)
          ? [
              { id: shown.id, answer: "Am Montag." },
              { id: plain.id, answer: "kein JSON" },
            ]
          : [{}];
      const result = await list(createUser(prisma, "admin").token);
      expect(result.statusCode).toBe(200);
      expect(result.body.totalChats).toBe(2);
      expect(result.body.chats.map((chat) => chat.id)).toEqual([
        plain.id,
        shown.id,
      ]);
      const [, chat] = result.body.chats;
      expect(Object.keys(chat).sort()).toEqual([
        "createdAt",
        "embed_config",
        "embed_id",
        "id",
        "prompt",
        "response",
        "session_id",
      ]);
      expect(JSON.parse(chat.response)).toEqual({ text: "Am Montag." });
      expect(JSON.parse(result.body.chats[0].response)).toEqual({
        text: "kein JSON",
      });
      expect(chat.embed_config).toEqual({ workspace: { name: "A" } });
      const body = JSON.stringify(result.body);
      expect(body).not.toMatch(
        /203\.0\.113|kunde\.example|connection_information|QUELLENTEXT|gemma|geleerte Frage/
      );
    });

    test("gehärtet (Fixliste 7, F02): offset und limit wie die Konversationsliste geprüft – ganze Zahlen, limit 1–100, sonst 400; offset zählt Seiten", async () => {
      const admin = createUser(prisma, "admin");
      for (const body of [
        { limit: 0 },
        { limit: 101 },
        { limit: 100000 },
        { limit: "5" },
        { offset: -1 },
        { offset: "1" },
        { offset: 1.5 },
        { offset: Number.MAX_SAFE_INTEGER, limit: 100 },
      ]) {
        const result = await list(admin.token, body);
        expect([body, result.statusCode]).toEqual([body, 400]);
        expect(JSON.stringify(result.body)).not.toMatch(/Wann beginnt/);
      }
      const first = await list(admin.token, { offset: 0, limit: 1 });
      expect(first.body.chats.map((chat) => chat.id)).toEqual([chatB.id]);
      expect(first.body.hasPages).toBe(true);
      const second = await list(admin.token, { offset: 1, limit: 1 });
      expect(second.body.chats.map((chat) => chat.id)).toEqual([chatA.id]);
      expect(second.body.hasPages).toBe(false);
    });
  });
});

// ============================================================================
// AK-3 — Fremdes Widget
// ============================================================================
describe("fremdes_widget (AK-3)", () => {
  let kunde;
  beforeEach(() => {
    // Zugriff auf A und C, nicht auf B
    kunde = createUser(prisma, "default", [workspaceA.id, workspaceC.id]);
  });

  const foreignCalls = () => ({
    "Widget ändern": [
      ROUTE.update,
      { params: { embedId: String(embedB.id) }, body: { enabled: false } },
    ],
    "Widget löschen": [
      ROUTE.remove,
      { params: { embedId: String(embedB.id) } },
    ],
    "Konversation löschen": [
      ROUTE.deleteConversation,
      {
        params: { embedId: String(embedB.id) },
        body: { chatId: chatB.id },
      },
    ],
    "Chats leeren": [
      ROUTE.clearChats,
      { params: { embedId: String(embedB.id) } },
    ],
    "Logo hochladen": [
      ROUTE.uploadLogo,
      { params: { embedId: String(embedB.id) } },
    ],
    "Logo entfernen": [
      ROUTE.removeLogo,
      { params: { embedId: String(embedB.id) } },
    ],
    "Statistik lesen": [
      ROUTE.overview,
      { params: { embedId: String(embedB.id) }, body: {} },
    ],
  });

  test.each([
    "Widget ändern",
    "Widget löschen",
    "Konversation löschen",
    "Chats leeren",
    "Logo hochladen",
    "Logo entfernen",
    "Statistik lesen",
  ])("%s: 403, nichts geändert", async (name) => {
    const [chain, request] = foreignCalls()[name];
    const before = snapshot();

    const result = await invoke(chain, { ...request, token: kunde.token });

    expect(result.statusCode).toBe(403);
    expect(result.body).toBeUndefined();
    expect(snapshot()).toBe(before);
    expect(EventLogs.logEvent).not.toHaveBeenCalled();
  });

  test("Logo hochladen: die Datei wird gar nicht erst angenommen", async () => {
    await invoke(ROUTE.uploadLogo, {
      params: { embedId: String(embedB.id) },
      token: kunde.token,
    });
    expect(handleEmbedLogoUpload).not.toHaveBeenCalled();
    expect(deleteOldEmbedLogo).not.toHaveBeenCalled();
  });

  test("Statistik lesen: es wird nichts abgefragt", async () => {
    const result = await invoke(ROUTE.overview, {
      params: { embedId: String(embedB.id) },
      body: {},
      token: kunde.token,
    });
    expect(result.statusCode).toBe(403);
    expect(prisma.__rawQueries).toHaveLength(0);
  });

  test("unbekanntes Widget ist von einem fremden nicht zu unterscheiden (403, nicht 404)", async () => {
    for (const chain of [
      ROUTE.update,
      ROUTE.remove,
      ROUTE.uploadLogo,
      ROUTE.removeLogo,
      ROUTE.overview,
      ROUTE.deleteConversation,
    ]) {
      for (const embedId of ["9999", "abc", "-1", "0"]) {
        const result = await invoke(chain, {
          params: { embedId },
          body: {},
          token: kunde.token,
        });
        expect(result.statusCode).toBe(403);
      }
    }
  });

  test("Chats leeren: auch das eigene Widget und der Gesamtbestand bleiben admin/manager vorbehalten", async () => {
    for (const embedId of [String(embedA.id), "-1"]) {
      const result = await invoke(ROUTE.clearChats, {
        params: { embedId },
        token: kunde.token,
      });
      expect(result.statusCode).toBe(403);
    }
    expect(chatIds()).toEqual([chatA.id, chatB.id]);
  });

  test("Nutzer ohne jeden Workspace erreicht kein Widget", async () => {
    const ohneWorkspace = createUser(prisma, "default", []);
    const before = snapshot();
    for (const embed of [embedA, embedB]) {
      const result = await invoke(ROUTE.update, {
        params: { embedId: String(embed.id) },
        body: { enabled: false },
        token: ohneWorkspace.token,
      });
      expect(result.statusCode).toBe(403);
    }
    expect(snapshot()).toBe(before);
  });

  test("ohne Anmeldung: 401 an jeder Route", async () => {
    const before = snapshot();
    for (const [name, chain] of Object.entries(ROUTE)) {
      const result = await invoke(chain, {
        params: {
          embedId: String(embedB.id),
          chatId: String(chatB.id),
        },
        body: {
          workspace_id: workspaceB.id,
          chatId: chatB.id,
        },
      });
      expect([name, result.statusCode]).toEqual([name, 401]);
    }
    expect(snapshot()).toBe(before);
  });
});

// ============================================================================
// AK-13 — Einzelne Konversation eines fremden Widgets (Nachtrag 12.10.2026)
// ============================================================================
describe("konversation_detail (AK-13)", () => {
  let kunde;
  let detailSpy;
  let rowIdsSpy;
  let followUpA, followUpB;

  beforeEach(() => {
    // Zugriff auf A und C, nicht auf B
    kunde = createUser(prisma, "default", [workspaceA.id, workspaceC.id]);
    // Je Widget eine zweite Konversation in derselben Browser-Sitzung, mit
    // eigener Kennung. KIE-538: Die Einzelansicht zeigt eine Konversation wie
    // Liste, Export und Löschen sie verstehen - bezeichnet über die id einer
    // ihrer Zeilen: die Alt-Zeilen ohne conversation_id (chatA/chatB) oder
    // die Konversation mit eigener Kennung, nicht die ganze Sitzung.
    followUpA = seedChat(embedA, {
      prompt: "Und wo findet er statt?",
      response: JSON.stringify({ text: "Im Haus der Bildung." }),
      conversation_id: "konversation-a",
    });
    followUpB = seedChat(embedB, {
      prompt: "Was kostet der Kurs?",
      response: JSON.stringify({ text: "89 Euro." }),
      conversation_id: "konversation-b",
    });
    detailSpy = jest.spyOn(EmbedChats, "getConversationDetails");
    // Die ids der Konversation liest eine Raw-Abfrage mit Index-Hinweis
    // (Fixliste 9, A3); der Ersatz im Speicher kennt kein SQL - dieselben
    // Bedingungen (scope.where, include) über seine findMany.
    rowIdsSpy = jest
      .spyOn(EmbedChats, "_conversationRowIds")
      .mockImplementation(async (scope) =>
        (
          await prisma.embed_chats.findMany({
            where: { ...scope.where, include: true },
            orderBy: { createdAt: "asc" },
          })
        ).map((row) => row.id)
      );
  });

  afterEach(() => {
    detailSpy.mockRestore();
    rowIdsSpy.mockRestore();
  });

  const detail = (embedId, chatId, token = null) =>
    invoke(ROUTE.conversation, {
      params: { embedId: String(embedId), chatId: String(chatId) },
      token,
    });

  // Felder wie vor KIE-533: genau die aus getConversationDetails.
  const message = (chat) => ({
    id: chat.id,
    prompt: chat.prompt,
    response: chat.response,
    createdAt: chat.createdAt.toISOString(),
    conversation_id: chat.conversation_id,
    session_id: chat.session_id,
    feedbackScore: null,
    feedbackText: null,
    feedbackReason: null,
  });

  describe("Rolle default", () => {
    test.each([
      ["Alt-Konversation", () => chatB.id],
      ["Konversation mit eigener Kennung", () => followUpB.id],
    ])(
      "fremdes Widget, %s: 403 ohne Inhalte, nichts abgefragt",
      async (_name, chatId) => {
        const result = await detail(embedB.id, chatId(), kunde.token);

        expect(result.statusCode).toBe(403);
        expect(result.body).toBeUndefined();
        expect(detailSpy).not.toHaveBeenCalled();
      }
    );

    test("unbekanntes Widget ist von einem fremden nicht zu unterscheiden (403)", async () => {
      for (const embedId of ["9999", "abc", "-1", "0"]) {
        const result = await detail(embedId, chatB.id, kunde.token);
        expect([embedId, result.statusCode]).toEqual([embedId, 403]);
        expect(result.body).toBeUndefined();
      }
      expect(detailSpy).not.toHaveBeenCalled();
    });

    test("Nutzer ohne jeden Workspace erreicht keine Konversation", async () => {
      const ohneWorkspace = createUser(prisma, "default", []);
      for (const [embed, chat] of [
        [embedA, chatA],
        [embedB, chatB],
      ]) {
        const result = await detail(embed.id, chat.id, ohneWorkspace.token);
        expect(result.statusCode).toBe(403);
        expect(result.body).toBeUndefined();
      }
      expect(detailSpy).not.toHaveBeenCalled();
    });

    test("eigenes Widget, Alt-Konversation: die Alt-Zeilen der Sitzung, nicht ihre übrigen Konversationen", async () => {
      const result = await detail(embedA.id, chatA.id, kunde.token);

      expect(result.statusCode).toBe(200);
      expect(result.body).toEqual({
        success: true,
        messages: [message(chatA)],
      });
    });

    test("eigenes Widget, Konversation mit eigener Kennung", async () => {
      const result = await detail(embedA.id, followUpA.id, kunde.token);

      expect(result.statusCode).toBe(200);
      expect(result.body).toEqual({
        success: true,
        messages: [message(followUpA)],
      });
    });

    test("fremde Konversation über das eigene Widget: keine Inhalte", async () => {
      // die Zeilen des fremden Widgets - und dessen Kennungen, die seit
      // KIE-538 nichts mehr bezeichnen
      for (const chatId of [
        chatB.id,
        followUpB.id,
        chatB.session_id,
        followUpB.conversation_id,
      ]) {
        const result = await detail(embedA.id, chatId, kunde.token);
        expect(result.statusCode).toBe(200);
        expect(result.body).toEqual({ success: true, messages: [] });
      }
    });

    test("Kennungen des eigenen Widgets bezeichnen keine Konversation mehr: keine Inhalte", async () => {
      for (const key of [chatA.session_id, followUpA.conversation_id]) {
        const result = await detail(embedA.id, key, kunde.token);
        expect(result.statusCode).toBe(200);
        expect(result.body).toEqual({ success: true, messages: [] });
      }
    });
  });

  describe.each(["admin", "manager"])("Rolle %s", (role) => {
    let user;
    beforeEach(() => {
      // Bewusst ohne jede Workspace-Mitgliedschaft
      user = createUser(prisma, role, []);
    });

    test("Konversationen beliebiger Widgets wie zuvor", async () => {
      for (const [embed, chat, followUp] of [
        [embedA, chatA, followUpA],
        [embedB, chatB, followUpB],
      ]) {
        for (const row of [chat, followUp]) {
          const result = await detail(embed.id, row.id, user.token);
          expect(result.statusCode).toBe(200);
          expect(result.body).toEqual({
            success: true,
            messages: [message(row)],
          });
        }
      }
    });

    test("unbekanntes Widget: leere Liste wie zuvor", async () => {
      const result = await detail("9999", chatB.id, user.token);
      expect(result.statusCode).toBe(200);
      expect(result.body).toEqual({ success: true, messages: [] });
    });
  });

  test("ohne Mehrbenutzermodus: keine Prüfung (NAK-2)", async () => {
    setMultiUserMode(prisma, false);
    for (const [embed, chat, followUp] of [
      [embedA, chatA, followUpA],
      [embedB, chatB, followUpB],
    ]) {
      for (const row of [chat, followUp]) {
        const result = await detail(embed.id, row.id);
        expect(result.statusCode).toBe(200);
        expect(result.body).toEqual({
          success: true,
          messages: [message(row)],
        });
      }
    }
  });

  describe("Chat-Verlauf abgeschaltet (DISABLE_VIEW_CHAT_HISTORY)", () => {
    beforeEach(() => {
      process.env.DISABLE_VIEW_CHAT_HISTORY = "1";
    });

    test("dieselbe Ablehnung wie die Konversationsliste, für jede Rolle, ohne Inhalte", async () => {
      const users = [
        createUser(prisma, "admin"),
        createUser(prisma, "manager"),
        kunde,
      ];
      for (const user of users) {
        for (const [embed, chat] of [
          [embedA, chatA],
          [embedB, chatB],
        ]) {
          const list = await invoke(CONVERSATION_LIST, {
            params: { embedId: String(embed.id) },
            body: {},
            token: user.token,
          });
          const result = await detail(embed.id, chat.id, user.token);

          expect(list.statusCode).toBe(422);
          expect([user.role, result.statusCode]).toEqual([user.role, 422]);
          expect(result.body).toBe(list.body);
          expect(typeof result.body).toBe("string");
        }
      }
      expect(detailSpy).not.toHaveBeenCalled();
    });

    test("ohne Mehrbenutzermodus ebenso", async () => {
      setMultiUserMode(prisma, false);
      const list = await invoke(CONVERSATION_LIST, {
        params: { embedId: String(embedB.id) },
        body: {},
      });
      const result = await detail(embedB.id, chatB.id);

      expect(result.statusCode).toBe(422);
      expect(result.body).toBe(list.body);
      expect(detailSpy).not.toHaveBeenCalled();
    });
  });
});

// ============================================================================
// AK-4 — Eigenes Widget bleibt bearbeitbar
// ============================================================================
describe("eigenes_widget (AK-4)", () => {
  let kunde;
  beforeEach(() => {
    kunde = createUser(prisma, "default", [workspaceA.id, workspaceC.id]);
  });

  test("Aussehen und Aufbewahrungsfrist werden gespeichert", async () => {
    const visualConfig = JSON.stringify({ primaryColor: "#123456" });
    const result = await invoke(ROUTE.update, {
      params: { embedId: String(embedA.id) },
      body: { visual_config: visualConfig, chat_retention_days: 30 },
      token: kunde.token,
    });

    expect(result.statusCode).toBe(200);
    expect(result.body).toEqual({ success: true, error: null });
    expect(embedRow(embedA.id).visual_config).toBe(visualConfig);
    expect(embedRow(embedA.id).chat_retention_days).toBe(30);
    expect(embedRow(embedA.id).retention_started_at).toBeInstanceOf(Date);
    expect(EventLogs.logEvent).toHaveBeenCalledWith(
      "embed_updated",
      { embedId: String(embedA.id) },
      kunde.id
    );
  });

  test("das Formular sendet den eigenen Workspace mit: bleibt zulässig", async () => {
    const result = await invoke(ROUTE.update, {
      params: { embedId: String(embedA.id) },
      body: { workspace_id: String(workspaceA.id), max_chats_per_day: 50 },
      token: kunde.token,
    });
    expect(result.statusCode).toBe(200);
    expect(embedRow(embedA.id).workspace_id).toBe(workspaceA.id);
    expect(embedRow(embedA.id).max_chats_per_day).toBe(50);
  });

  test("Logo hochladen und entfernen", async () => {
    const upload = await invoke(ROUTE.uploadLogo, {
      params: { embedId: String(embedA.id) },
      token: kunde.token,
    });
    expect(upload.statusCode).toBe(200);
    expect(upload.body).toEqual({
      success: true,
      logoFilename: "logo-neu.png",
    });
    expect(JSON.parse(embedRow(embedA.id).visual_config).logoFilename).toBe(
      "logo-neu.png"
    );

    const removal = await invoke(ROUTE.removeLogo, {
      params: { embedId: String(embedA.id) },
      token: kunde.token,
    });
    expect(removal.statusCode).toBe(200);
    expect(
      JSON.parse(embedRow(embedA.id).visual_config).logoFilename
    ).toBeNull();
  });

  test("Statistik des eigenen Widgets", async () => {
    const result = await invoke(ROUTE.overview, {
      params: { embedId: String(embedA.id) },
      body: {},
      token: kunde.token,
    });
    expect(result.statusCode).toBe(200);
    expect(result.body.success).toBe(true);
    expect(result.body.stats.total_chats).toBe(1);
  });

  test("Konversation des eigenen Widgets löschen (KIE-538) und eigenes Widget löschen wie zuvor", async () => {
    const chat = await invoke(ROUTE.deleteConversation, {
      params: { embedId: String(embedA.id) },
      body: { chatId: chatA.id },
      token: kunde.token,
    });
    expect(chat.statusCode).toBe(200);
    expect(chat.body).toEqual({ success: true, deletedCount: 1 });
    expect(chatIds()).toEqual([chatB.id]);

    const widget = await invoke(ROUTE.remove, {
      params: { embedId: String(embedA.id) },
      token: kunde.token,
    });
    expect(widget.statusCode).toBe(200);
    expect(embedRow(embedA.id)).toBeUndefined();
    expect(embedRow(embedB.id)).toBeDefined();
  });

  test("Widget im eigenen Workspace anlegen", async () => {
    const result = await invoke(ROUTE.create, {
      body: { workspace_id: String(workspaceC.id), chat_mode: "chat" },
      token: kunde.token,
    });
    expect(result.statusCode).toBe(200);
    expect(result.body.error).toBeNull();
    expect(result.body.embed.workspace_id).toBe(workspaceC.id);
    expect(embedRow(result.body.embed.id).workspace_id).toBe(workspaceC.id);
  });
});

// ============================================================================
// AK-5 — Umhängen nur in einen eigenen Workspace
// ============================================================================
describe("umhaengen_eigener_workspace (AK-5)", () => {
  let kunde;
  beforeEach(() => {
    kunde = createUser(prisma, "default", [workspaceA.id, workspaceC.id]);
  });

  test("von A nach C: gespeichert", async () => {
    const result = await invoke(ROUTE.update, {
      params: { embedId: String(embedA.id) },
      body: { workspace_id: workspaceC.id },
      token: kunde.token,
    });
    expect(result.statusCode).toBe(200);
    expect(result.body).toEqual({ success: true, error: null });
    expect(embedRow(embedA.id).workspace_id).toBe(workspaceC.id);
  });

  test("von A nach B: 403, workspace_id und alle anderen Felder unverändert", async () => {
    const before = snapshot();
    const result = await invoke(ROUTE.update, {
      params: { embedId: String(embedA.id) },
      // Auch die übrigen Felder derselben Anfrage dürfen nicht ankommen.
      body: { workspace_id: workspaceB.id, enabled: false },
      token: kunde.token,
    });
    expect(result.statusCode).toBe(403);
    expect(snapshot()).toBe(before);
    expect(embedRow(embedA.id).workspace_id).toBe(workspaceA.id);
    expect(EventLogs.logEvent).not.toHaveBeenCalled();
  });

  test.each([
    ["Zeichenkette", (b) => String(b)],
    ["Liste mit einem Eintrag", (b) => [b]],
    ["Zahl mit Nachkommastellen", (b) => `${b}.0`],
  ])("Ziel B als %s: 403", async (_name, encode) => {
    const result = await invoke(ROUTE.update, {
      params: { embedId: String(embedA.id) },
      body: { workspace_id: encode(workspaceB.id) },
      token: kunde.token,
    });
    expect(result.statusCode).toBe(403);
    expect(embedRow(embedA.id).workspace_id).toBe(workspaceA.id);
  });

  test.each([[null], [""], ["abc"], [0], [-1], [9999], [{ id: 2 }]])(
    "unbrauchbares Ziel %j: 403, unverändert",
    async (workspaceId) => {
      const result = await invoke(ROUTE.update, {
        params: { embedId: String(embedA.id) },
        body: { workspace_id: workspaceId },
        token: kunde.token,
      });
      expect(result.statusCode).toBe(403);
      expect(embedRow(embedA.id).workspace_id).toBe(workspaceA.id);
    }
  );

  test("geprüft wird derselbe Wert, den das Modell schreibt (true wird als 1 gelesen)", async () => {
    // Workspace A hat die id 1: Für ein Mitglied von A ändert sich nichts …
    expect(workspaceA.id).toBe(1);
    const own = await invoke(ROUTE.update, {
      params: { embedId: String(embedA.id) },
      body: { workspace_id: true },
      token: kunde.token,
    });
    expect(own.statusCode).toBe(200);
    expect(embedRow(embedA.id).workspace_id).toBe(workspaceA.id);

    // … wer nicht zu A gehört, kommt so auch nicht hinein.
    const embedC = seedEmbed(workspaceC);
    const nurC = createUser(prisma, "default", [workspaceC.id]);
    const foreign = await invoke(ROUTE.update, {
      params: { embedId: String(embedC.id) },
      body: { workspace_id: true },
      token: nurC.token,
    });
    expect(foreign.statusCode).toBe(403);
    expect(embedRow(embedC.id).workspace_id).toBe(workspaceC.id);
  });

  test("ein fremdes Widget lässt sich nicht in den eigenen Workspace holen", async () => {
    const result = await invoke(ROUTE.update, {
      params: { embedId: String(embedB.id) },
      body: { workspace_id: workspaceA.id },
      token: kunde.token,
    });
    expect(result.statusCode).toBe(403);
    expect(embedRow(embedB.id).workspace_id).toBe(workspaceB.id);
  });
});

// ============================================================================
// AK-6 — Widget nur im eigenen Workspace anlegen
// ============================================================================
describe("anlegen_fremd (AK-6)", () => {
  let kunde;
  beforeEach(() => {
    kunde = createUser(prisma, "default", [workspaceA.id]);
  });

  test.each([
    ["Workspace B", () => workspaceB.id],
    ["Workspace B als Zeichenkette", () => String(workspaceB.id)],
    ["Workspace C", () => workspaceC.id],
    ["unbekannter Workspace", () => 9999],
    ["ohne Workspace", () => undefined],
    ["null", () => null],
  ])("%s: 403, kein Widget entsteht", async (_name, workspaceId) => {
    const result = await invoke(ROUTE.create, {
      body: { workspace_id: workspaceId(), chat_mode: "chat" },
      token: kunde.token,
    });
    expect(result.statusCode).toBe(403);
    expect(prisma.__rows("embed_configs")).toHaveLength(2);
    expect(EventLogs.logEvent).not.toHaveBeenCalled();
  });
});

// ============================================================================
// AK-10 — overview zählt wie die Liste (include = 1)
// ============================================================================
describe("overview_include (AK-10)", () => {
  let admin;
  beforeEach(() => {
    admin = createUser(prisma, "admin");
    // 10 Nachrichten in 5 Konversationen, davon 2 zurückgesetzt (include = 0)
    prisma.__rows("embed_chats").length = 0;
    for (let i = 0; i < 10; i++)
      seedChat(embedA, {
        session_id: `session-${i % 5}`,
        include: i < 8,
        feedbackScore: i === 0 ? true : i === 9 ? false : null,
      });
    seedChat(embedB);

    // Die beiden Roh-Abfragen (Konversationen, Wortzahlen) rechnet der
    // Ersatz nach - mit include-Filter nur, wenn das SQL ihn enthält.
    prisma.__onRawQuery = (sql) => {
      const rows = prisma
        .__rows("embed_chats")
        .filter(
          (row) =>
            row.embed_id === embedA.id &&
            (!/\binclude = 1\b/.test(sql) || row.include)
        );
      if (/COUNT\(DISTINCT/.test(sql))
        return [{ count: BigInt(new Set(rows.map((r) => r.session_id)).size) }];
      return [{ total_words_prompt: BigInt(rows.length * 4) }];
    };
  });

  test("10 Nachrichten, davon 2 mit include = 0: overview nennt 8", async () => {
    const result = await invoke(ROUTE.overview, {
      params: { embedId: String(embedA.id) },
      body: {},
      token: admin.token,
    });

    expect(result.statusCode).toBe(200);
    expect(result.body.success).toBe(true);
    expect(result.body.stats.total_chats).toBe(8);
    // Konversationen 0-4, in jeder liegt noch mindestens eine gültige Zeile
    expect(result.body.stats.unique_conversations).toBe(5);
    expect(result.body.stats.avg_chats_per_conversation).toBe(8 / 5);
    expect(result.body.stats.total_words_prompt).toBe(32);
    // Die zurückgesetzte 👎-Bewertung (Zeile 9) zählt nicht mehr mit.
    expect(result.body.stats.feedback_positive).toBe(1);
    expect(result.body.stats.feedback_negative).toBe(0);
  });

  test("beide Roh-Abfragen filtern auf include = 1", async () => {
    await invoke(ROUTE.overview, {
      params: { embedId: String(embedA.id) },
      body: {},
      token: admin.token,
    });
    expect(prisma.__rawQueries).toHaveLength(2);
    for (const sql of prisma.__rawQueries)
      expect(sql).toMatch(/WHERE embed_id = \? AND include = 1/);
  });

  test("mit Zeitraum: derselbe Filter", async () => {
    const result = await invoke(ROUTE.overview, {
      params: { embedId: String(embedA.id) },
      body: { startDate: "2020-01-01", endDate: "2099-01-01" },
      token: admin.token,
    });
    expect(result.body.stats.total_chats).toBe(8);
    for (const sql of prisma.__rawQueries)
      expect(sql).toMatch(
        /AND include = 1 AND createdAt >= \? AND createdAt <= \?/
      );
  });

  test("Chat-Verlauf abgeschaltet (DISABLE_VIEW_CHAT_HISTORY): 422 für jede Rolle", async () => {
    process.env.DISABLE_VIEW_CHAT_HISTORY = "1";
    const kunde = createUser(prisma, "default", [workspaceA.id]);
    for (const user of [admin, createUser(prisma, "manager"), kunde]) {
      const result = await invoke(ROUTE.overview, {
        params: { embedId: String(embedA.id) },
        body: {},
        token: user.token,
      });
      expect(result.statusCode).toBe(422);
    }
    expect(prisma.__rawQueries).toHaveLength(0);
  });
});

// ============================================================================
// NAK-2 — Container ohne Mehrbenutzermodus bleiben benutzbar
// ============================================================================
describe("ohne_mehrbenutzer (NAK-2)", () => {
  beforeEach(() => {
    setMultiUserMode(prisma, false);
  });

  test("Widget anlegen, ändern, umhängen, Logo, Statistik, Chats und Löschen: nichts wird abgewiesen", async () => {
    const created = await invoke(ROUTE.create, {
      body: { workspace_id: workspaceB.id, chat_mode: "chat" },
    });
    expect(created.statusCode).toBe(200);
    expect(created.body.embed.workspace_id).toBe(workspaceB.id);

    const updated = await invoke(ROUTE.update, {
      params: { embedId: String(embedB.id) },
      body: { workspace_id: workspaceC.id, chat_retention_days: 90 },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.body).toEqual({ success: true, error: null });
    expect(embedRow(embedB.id).workspace_id).toBe(workspaceC.id);

    const upload = await invoke(ROUTE.uploadLogo, {
      params: { embedId: String(embedB.id) },
    });
    expect(upload.statusCode).toBe(200);

    const removal = await invoke(ROUTE.removeLogo, {
      params: { embedId: String(embedB.id) },
    });
    expect(removal.statusCode).toBe(200);

    const overview = await invoke(ROUTE.overview, {
      params: { embedId: String(embedB.id) },
      body: {},
    });
    expect(overview.statusCode).toBe(200);
    expect(overview.body.stats.total_chats).toBe(1);

    const chat = await invoke(ROUTE.deleteConversation, {
      params: { embedId: String(embedA.id) },
      body: { chatId: chatA.id },
    });
    expect(chat.statusCode).toBe(200);
    expect(chatIds()).toEqual([chatB.id]);

    const cleared = await invoke(ROUTE.clearChats, {
      params: { embedId: String(embedB.id) },
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.body).toEqual({ success: true, deletedCount: 1 });

    const removed = await invoke(ROUTE.remove, {
      params: { embedId: String(embedB.id) },
    });
    expect(removed.statusCode).toBe(200);
    expect(embedRow(embedB.id)).toBeUndefined();
  });

  test("Gesamtbestand der Widget-Chats leeren", async () => {
    const result = await invoke(ROUTE.clearChats, {
      params: { embedId: "-1" },
    });
    expect(result.statusCode).toBe(200);
    expect(result.body).toEqual({ success: true, deletedCount: 2 });
    expect(chatIds()).toEqual([]);
  });

  test("unbekanntes Widget: 404 wie zuvor", async () => {
    const result = await invoke(ROUTE.update, {
      params: { embedId: "9999" },
      body: { enabled: false },
    });
    expect(result.statusCode).toBe(404);
  });
});

// ============================================================================
// NAK-3 — Admin und Manager verlieren keinen Widget-Zugriff
// ============================================================================
describe("admin_manager (NAK-3)", () => {
  describe.each(["admin", "manager"])("Rolle %s", (role) => {
    let user;
    beforeEach(() => {
      // Bewusst ohne jede Workspace-Mitgliedschaft
      user = createUser(prisma, role, []);
    });

    test("Widgets beliebiger Workspaces ändern, umhängen und anlegen", async () => {
      const updated = await invoke(ROUTE.update, {
        params: { embedId: String(embedB.id) },
        body: { workspace_id: workspaceC.id, enabled: false },
        token: user.token,
      });
      expect(updated.statusCode).toBe(200);
      expect(updated.body).toEqual({ success: true, error: null });
      expect(embedRow(embedB.id).workspace_id).toBe(workspaceC.id);
      expect(embedRow(embedB.id).enabled).toBe(false);

      const created = await invoke(ROUTE.create, {
        body: { workspace_id: workspaceA.id, chat_mode: "chat" },
        token: user.token,
      });
      expect(created.statusCode).toBe(200);
      expect(created.body.embed.workspace_id).toBe(workspaceA.id);
    });

    test("Logo, Statistik, Chats und Löschen", async () => {
      const upload = await invoke(ROUTE.uploadLogo, {
        params: { embedId: String(embedB.id) },
        token: user.token,
      });
      expect(upload.statusCode).toBe(200);
      expect(handleEmbedLogoUpload).toHaveBeenCalledTimes(1);

      const removal = await invoke(ROUTE.removeLogo, {
        params: { embedId: String(embedB.id) },
        token: user.token,
      });
      expect(removal.statusCode).toBe(200);

      const overview = await invoke(ROUTE.overview, {
        params: { embedId: String(embedB.id) },
        body: {},
        token: user.token,
      });
      expect(overview.statusCode).toBe(200);
      expect(overview.body.stats.total_chats).toBe(1);

      const chat = await invoke(ROUTE.deleteConversation, {
        params: { embedId: String(embedA.id) },
        body: { chatId: chatA.id },
        token: user.token,
      });
      expect(chat.statusCode).toBe(200);
      expect(chatIds()).toEqual([chatB.id]);

      const cleared = await invoke(ROUTE.clearChats, {
        params: { embedId: String(embedB.id) },
        token: user.token,
      });
      expect(cleared.statusCode).toBe(200);
      expect(cleared.body).toEqual({ success: true, deletedCount: 1 });

      const removed = await invoke(ROUTE.remove, {
        params: { embedId: String(embedB.id) },
        token: user.token,
      });
      expect(removed.statusCode).toBe(200);
      expect(embedRow(embedB.id)).toBeUndefined();
    });

    test("Gesamtbestand der Widget-Chats leeren", async () => {
      const result = await invoke(ROUTE.clearChats, {
        params: { embedId: "-1" },
        token: user.token,
      });
      expect(result.statusCode).toBe(200);
      expect(result.body).toEqual({ success: true, deletedCount: 2 });
    });

    test("unbekanntes Widget: 404 wie zuvor", async () => {
      for (const chain of [
        ROUTE.update,
        ROUTE.remove,
        ROUTE.uploadLogo,
        ROUTE.removeLogo,
      ]) {
        const result = await invoke(chain, {
          params: { embedId: "9999" },
          body: {},
          token: user.token,
        });
        expect(result.statusCode).toBe(404);
      }
    });
  });

  test("gesperrter Nutzer: 401, auch als admin", async () => {
    const admin = createUser(prisma, "admin");
    prisma.__rows("users").find((row) => row.id === admin.id).suspended = 1;
    const result = await invoke(ROUTE.update, {
      params: { embedId: String(embedB.id) },
      body: { enabled: false },
      token: admin.token,
    });
    expect(result.statusCode).toBe(401);
    expect(embedRow(embedB.id).enabled).toBe(true);
  });
});
