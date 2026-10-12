/* eslint-env jest, node */
// KIE-533 — GET /system/export-chats
//
// Der Sammel-Export der Widget-Chats (chatType=embed) liefert die Nachrichten
// aller Workspaces der Instanz und ist deshalb admin vorbehalten. Der Export
// der Workspace-Chats (Administrator → Workspace-Chats) bleibt, wie er war.
//
// Geprüft wird gegen die echte Route mit ihrer ganzen Middleware-Kette
// (siehe support/routeHarness.js).
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

// Schon vor dem Laden: Die Endpunkte melden sich beim require (TokenManager,
// TTS-Normalizer).
jest.spyOn(console, "error").mockImplementation(() => {});
jest.spyOn(console, "warn").mockImplementation(() => {});
jest.spyOn(console, "log").mockImplementation(() => {});

const prisma = require("../../utils/prisma");
const { EventLogs } = require("../../models/eventLogs");
const { systemEndpoints } = require("../../endpoints/system");
const {
  collectRoutes,
  invoke,
  setMultiUserMode,
  createUser,
} = require("./support/routeHarness");

const exportChats = collectRoutes(systemEndpoints)["GET /system/export-chats"];

const SENT_AT = new Date("2026-10-01T08:30:00.000Z");
let workspaceA, workspaceB;
let users;

afterAll(() => {
  console.error.mockRestore();
  console.warn.mockRestore();
  console.log.mockRestore();
});

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.DISABLE_VIEW_CHAT_HISTORY;
  prisma.__reset();
  setMultiUserMode(prisma, true);

  workspaceA = prisma.__seed("workspaces", { name: "A", slug: "a" });
  workspaceB = prisma.__seed("workspaces", { name: "B", slug: "b" });
  users = {
    admin: createUser(prisma, "admin"),
    manager: createUser(prisma, "manager"),
    default: createUser(prisma, "default", [workspaceA.id]),
  };

  for (const workspace of [workspaceA, workspaceB]) {
    const embed = prisma.__seed("embed_configs", {
      uuid: `uuid-${workspace.slug}`,
      enabled: true,
      workspace_id: workspace.id,
    });
    prisma.__seed("embed_chats", {
      prompt: `Widget-Frage ${workspace.name}`,
      response: JSON.stringify({ text: `Widget-Antwort ${workspace.name}` }),
      session_id: `session-${workspace.slug}`,
      embed_id: embed.id,
      createdAt: SENT_AT,
    });
  }
  prisma.__seed("workspace_chats", {
    workspaceId: workspaceA.id,
    prompt: 'Frage mit "Anführung"',
    response: JSON.stringify({ text: "Antwort\nzweizeilig", attachments: [] }),
    user_id: users.default.id,
    api_session_id: null,
    feedbackScore: true,
    include: true,
    createdAt: SENT_AT,
  });
  prisma.__seed("workspace_chats", {
    workspaceId: workspaceB.id,
    prompt: "Frage über die API",
    response: JSON.stringify({ text: "Antwort B", attachments: [] }),
    user_id: null,
    api_session_id: "api-1",
    feedbackScore: null,
    include: true,
    createdAt: SENT_AT,
  });
});

test("die Route ist registriert", () => {
  expect(Array.isArray(exportChats)).toBe(true);
});

// ============================================================================
// AK-7 — Sammel-Export der Widget-Chats nur für Admin
// ============================================================================
describe("embed_nur_admin (AK-7)", () => {
  test.each(["default", "manager"])(
    "%s: 403, keine Daten, kein Export-Ereignis",
    async (role) => {
      for (const type of ["csv", "json", "jsonl", "jsonAlpaca", undefined]) {
        const result = await invoke(exportChats, {
          query: { type, chatType: "embed" },
          token: users[role].token,
        });
        expect(result.statusCode).toBe(403);
        expect(result.body).toBeUndefined();
        expect(result.headers).toEqual({});
      }
      expect(EventLogs.logEvent).not.toHaveBeenCalled();
    }
  );

  test("admin erhält die Datei mit den Widget-Chats aller Workspaces", async () => {
    const result = await invoke(exportChats, {
      query: { type: "json", chatType: "embed" },
      token: users.admin.token,
    });

    expect(result.statusCode).toBe(200);
    expect(result.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(result.body)).toEqual([
      {
        id: 1,
        prompt: "Widget-Frage A",
        response: "Widget-Antwort A",
        sent_at: SENT_AT.toISOString(),
        attachments: [],
        workspace: "A",
      },
      {
        id: 2,
        prompt: "Widget-Frage B",
        response: "Widget-Antwort B",
        sent_at: SENT_AT.toISOString(),
        attachments: [],
        workspace: "B",
      },
    ]);
    expect(EventLogs.logEvent).toHaveBeenCalledWith(
      "exported_chats",
      { type: "json", chatType: "embed" },
      users.admin.id
    );
  });

  test.each(["default", "manager"])(
    "%s: auch andere Schreibweisen von chatType liefern keine Widget-Chats",
    async (role) => {
      for (const chatType of [["embed"], ["embed", "embed"], "EMBED", ""]) {
        const result = await invoke(exportChats, {
          query: { type: "json", chatType },
          token: users[role].token,
        });
        expect(result.statusCode).toBe(403);
        expect(result.body).toBeUndefined();
      }
    }
  );

  test("ohne Anmeldung: 401", async () => {
    const result = await invoke(exportChats, {
      query: { type: "json", chatType: "embed" },
    });
    expect(result.statusCode).toBe(401);
  });

  test("ohne Mehrbenutzermodus wird nicht geprüft (NAK-2)", async () => {
    setMultiUserMode(prisma, false);
    const result = await invoke(exportChats, {
      query: { type: "json", chatType: "embed" },
    });
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toHaveLength(2);
  });

  test("Chat-Verlauf abgeschaltet (DISABLE_VIEW_CHAT_HISTORY): 422 auch für admin", async () => {
    process.env.DISABLE_VIEW_CHAT_HISTORY = "1";
    const result = await invoke(exportChats, {
      query: { type: "json", chatType: "embed" },
      token: users.admin.token,
    });
    expect(result.statusCode).toBe(422);
  });
});

// ============================================================================
// NAK-5 — Export der Workspace-Chats unverändert
// ============================================================================
describe("workspace_unveraendert (NAK-5)", () => {
  const expectedJson = () => [
    {
      id: 1,
      prompt: 'Frage mit "Anführung"',
      response: "Antwort\nzweizeilig",
      sent_at: SENT_AT.toISOString(),
      attachments: [],
      workspace: "A",
      username: "default-3",
      rating: "GOOD",
    },
    {
      id: 2,
      prompt: "Frage über die API",
      response: "Antwort B",
      sent_at: SENT_AT.toISOString(),
      attachments: [],
      workspace: "B",
      username: "API",
      rating: "--",
    },
  ];

  describe.each(["admin", "manager", "default"])("Rolle %s", (role) => {
    test("JSON: Inhalt und Aufbau wie zuvor", async () => {
      const result = await invoke(exportChats, {
        query: { type: "json", chatType: "workspace" },
        token: users[role].token,
      });
      expect(result.statusCode).toBe(200);
      expect(result.headers["Content-Type"]).toBe("application/json");
      expect(JSON.parse(result.body)).toEqual(expectedJson());
      // Vier Leerzeichen Einzug wie zuvor
      expect(result.body.startsWith('[\n    {\n        "id": 1,')).toBe(true);
      expect(EventLogs.logEvent).toHaveBeenCalledWith(
        "exported_chats",
        { type: "json", chatType: "workspace" },
        users[role].id
      );
    });

    test("CSV: Spalten, Reihenfolge und Maskierung wie zuvor", async () => {
      const result = await invoke(exportChats, {
        query: { type: "csv", chatType: "workspace" },
        token: users[role].token,
      });
      expect(result.statusCode).toBe(200);
      expect(result.headers["Content-Type"]).toBe("text/csv");
      expect(result.body).toBe(
        [
          "id,workspace,prompt,response,sent_at,username,rating",
          `"1","A","Frage mit ""Anführung""","Antwort zweizeilig","${String(SENT_AT)}","default-3","GOOD"`,
          `"2","B","Frage über die API","Antwort B","${String(SENT_AT)}","API","--"`,
        ].join("\n")
      );
    });

    test("ohne chatType: Workspace-Chats als JSONL (Standard)", async () => {
      const result = await invoke(exportChats, {
        query: {},
        token: users[role].token,
      });
      expect(result.statusCode).toBe(200);
      expect(result.headers["Content-Type"]).toBe("application/jsonl");
      const lines = result.body.split("\n").map((line) => JSON.parse(line));
      expect(lines).toHaveLength(2);
      expect(lines[0].messages.map((message) => message.role)).toEqual([
        "system",
        "user",
        "assistant",
      ]);
      expect(lines[0].messages[1].content).toEqual([
        { type: "text", text: 'Frage mit "Anführung"' },
      ]);
      expect(lines[1].messages[2].content).toEqual([
        { type: "text", text: "Antwort B" },
      ]);
      expect(EventLogs.logEvent).toHaveBeenCalledWith(
        "exported_chats",
        { type: "jsonl", chatType: "workspace" },
        users[role].id
      );
    });
  });

  test("ohne Mehrbenutzermodus wie zuvor", async () => {
    setMultiUserMode(prisma, false);
    const result = await invoke(exportChats, {
      query: { type: "json", chatType: "workspace" },
    });
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual(expectedJson());
  });

  test("ohne Anmeldung: 401 wie zuvor", async () => {
    const result = await invoke(exportChats, {
      query: { type: "json", chatType: "workspace" },
    });
    expect(result.statusCode).toBe(401);
  });

  test("Chat-Verlauf abgeschaltet: 422 wie zuvor", async () => {
    process.env.DISABLE_VIEW_CHAT_HISTORY = "1";
    const result = await invoke(exportChats, {
      query: { type: "json", chatType: "workspace" },
      token: users.admin.token,
    });
    expect(result.statusCode).toBe(422);
  });
});
