/* eslint-env jest, node */
// widget-grenzen-kontakt (issues/widget-grenzen-kontakt.md): Den
// Nachrichtenverlauf für das Modell (message_limit) ändert in der
// Oberfläche nur ein admin im Mehrbenutzermodus.
//   AK-2   manager oder default schicken message_limit an /embed/update/:id
//          bzw. /embeds/new: gespeicherter Wert unverändert bzw. 2.
//   AK-3   neues Widget ohne Angabe: message_limit 2.
//   NAK-1  manager und default ändern message_limit über keinen Endpunkt
//          der Oberfläche.
//   NAK-2  Einbenutzerbetrieb (kein Nutzerobjekt, §11 E2): Wert verworfen.
//   §7     Entwickler-API (/v1/embed/...) setzt message_limit weiter; die
//          übrigen Felder des Widgets speichern alle Rollen wie bisher.
//
// Gegen die echten Routen mit ihrer ganzen Middleware-Kette
// (support/routeHarness.js), nur die Datenbank ist ein Ersatz im Speicher.
jest.mock("../../utils/prisma", () =>
  require("./support/routeHarness").createFakePrisma()
);
jest.mock("../../models/telemetry", () => ({
  Telemetry: { sendTelemetry: jest.fn() },
}));
jest.mock("../../models/eventLogs", () => ({
  EventLogs: { logEvent: jest.fn() },
}));
jest.mock("../../utils/AiProviders/modelMap", () => ({
  MODEL_MAP: { get: () => null },
}));
jest.mock("../../utils/EncryptionManager", () => ({
  EncryptionManager: class {
    decrypt() {
      return null;
    }
  },
}));

const prisma = require("../../utils/prisma");
const { embedManagementEndpoints } = require("../../endpoints/embedManagement");
const { apiEmbedEndpoints } = require("../../endpoints/api/embed");
const {
  collectRoutes,
  invoke,
  setMultiUserMode,
  createUser,
} = require("./support/routeHarness");

const routes = collectRoutes(embedManagementEndpoints);
const apiRoutes = collectRoutes(apiEmbedEndpoints);
const CREATE = routes["POST /embeds/new"];
const UPDATE = routes["POST /embed/update/:embedId"];
const API_CREATE = apiRoutes["POST /v1/embed/new"];
const API_UPDATE = apiRoutes["POST /v1/embed/:embedUuid"];

let workspace;
let embed;

const embedRow = (id) =>
  prisma.__rows("embed_configs").find((row) => row.id === id);

/** Alle Felder, die das Formular „Widget bearbeiten“ schickt. */
const FORM = (workspaceId) => ({
  workspace_id: String(workspaceId),
  chat_mode: "chat",
  allowlist_domains: "vhs-beispiel.de",
  max_chats_per_day: "300",
  max_chats_per_session: "12",
  chat_retention_days: "30",
  history_enabled: true,
  allow_model_override: false,
  allow_temperature_override: false,
  allow_prompt_override: false,
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
  prisma.__reset();
  setMultiUserMode(prisma, true);
  workspace = prisma.__seed("workspaces", { name: "A", slug: "a" });
  embed = prisma.__seed("embed_configs", {
    uuid: "uuid-a",
    enabled: true,
    chat_mode: "query",
    workspace_id: workspace.id,
    message_limit: 2,
    max_chats_per_day: null,
    max_chats_per_session: null,
    chat_retention_days: null,
    retention_started_at: null,
    visual_config: null,
  });
});

/** Nutzer der Rolle mit Zugriff auf den Workspace; ohne Rolle: Einbenutzerbetrieb. */
function login(role) {
  if (role === null) {
    setMultiUserMode(prisma, false);
    return null;
  }
  return createUser(prisma, role, [workspace.id]).token;
}

const ROLES_WITHOUT = [
  ["manager", "manager"],
  ["default", "default"],
  ["Einbenutzerbetrieb", null],
];

describe("Widget bearbeiten: message_limit nur von admin", () => {
  test.each(ROLES_WITHOUT)(
    "%s: message_limit verworfen, die übrigen Felder gespeichert (AK-2, NAK-1, NAK-2)",
    async (_name, role) => {
      const token = login(role);
      const result = await invoke(UPDATE, {
        params: { embedId: String(embed.id) },
        body: { ...FORM(workspace.id), message_limit: "20" },
        token,
      });
      expect(result.statusCode).toBe(200);
      expect(result.body).toEqual({ success: true, error: null });
      const row = embedRow(embed.id);
      expect(row.message_limit).toBe(2);
      // §7 Bestand: die übrigen Felder wie bisher
      expect(row).toMatchObject({
        chat_mode: "chat",
        allowlist_domains: JSON.stringify(["https://vhs-beispiel.de"]),
        max_chats_per_day: 300,
        max_chats_per_session: 12,
        chat_retention_days: 30,
        history_enabled: true,
      });
    }
  );

  test.each(ROLES_WITHOUT)(
    "%s: auch ein leerer oder ungültiger Wert lässt den gespeicherten stehen",
    async (_name, role) => {
      prisma.__rows("embed_configs")[0].message_limit = 4;
      const token = login(role);
      for (const value of ["", null, 0, "abc", -3, 7, "1"]) {
        const result = await invoke(UPDATE, {
          params: { embedId: String(embed.id) },
          body: { ...FORM(workspace.id), message_limit: value },
          token,
        });
        expect([value, result.statusCode]).toEqual([value, 200]);
        expect([value, embedRow(embed.id).message_limit]).toEqual([value, 4]);
      }
    }
  );

  test.each(ROLES_WITHOUT)(
    "%s: nur message_limit im Rumpf: nichts gespeichert, kein Serverfehler",
    async (_name, role) => {
      const before = JSON.stringify(prisma.__rows("embed_configs"));
      const result = await invoke(UPDATE, {
        params: { embedId: String(embed.id) },
        body: { message_limit: 10 },
        token: login(role),
      });
      expect(result.statusCode).toBe(200);
      expect(result.body.success).toBe(false);
      expect(JSON.stringify(prisma.__rows("embed_configs"))).toBe(before);
    }
  );

  test("admin: message_limit wird gespeichert, ein leerer Wert heißt Standard (zur Laufzeit 2)", async () => {
    const token = login("admin");
    let result = await invoke(UPDATE, {
      params: { embedId: String(embed.id) },
      body: { ...FORM(workspace.id), message_limit: "6" },
      token,
    });
    expect(result.statusCode).toBe(200);
    expect(embedRow(embed.id).message_limit).toBe(6);

    result = await invoke(UPDATE, {
      params: { embedId: String(embed.id) },
      body: { ...FORM(workspace.id), message_limit: 0 },
      token,
    });
    expect(result.statusCode).toBe(200);
    expect(embedRow(embed.id).message_limit).toBeNull();
  });
});

describe("Neues Widget: message_limit 2, außer ein admin gibt einen Wert an", () => {
  test.each(ROLES_WITHOUT)(
    "%s: gesendeter Wert verworfen, das Widget bekommt 2 (AK-2, AK-3, NAK-2)",
    async (_name, role) => {
      const token = login(role);
      for (const value of ["20", 20, "1"]) {
        const result = await invoke(CREATE, {
          body: { ...FORM(workspace.id), message_limit: value },
          token,
        });
        expect(result.statusCode).toBe(200);
        expect(result.body.error).toBeNull();
        const row = embedRow(result.body.embed.id);
        expect([value, row.message_limit]).toEqual([value, 2]);
        expect(row.max_chats_per_session).toBe(12);
      }
    }
  );

  test.each([["admin", "admin"], ...ROLES_WITHOUT])(
    "%s: ohne Angabe 2 (AK-3)",
    async (_name, role) => {
      const token = login(role);
      const result = await invoke(CREATE, {
        body: FORM(workspace.id),
        token,
      });
      expect(result.statusCode).toBe(200);
      expect(embedRow(result.body.embed.id).message_limit).toBe(2);
    }
  );

  test("admin: angegebener Wert wird übernommen, leer oder 0 heißt 2", async () => {
    const token = login("admin");
    const created = async (value) => {
      const result = await invoke(CREATE, {
        body: { ...FORM(workspace.id), message_limit: value },
        token,
      });
      return embedRow(result.body.embed.id).message_limit;
    };
    expect(await created("5")).toBe(5);
    expect(await created(3)).toBe(3);
    expect(await created("")).toBe(2);
    expect(await created(0)).toBe(2);
  });
});

// §7 Bestand, Hard Constraint 2: Entwickler-API unverändert
describe("Entwickler-API setzt message_limit weiter", () => {
  beforeEach(() => {
    prisma.__seed("api_keys", { secret: "geheim" });
  });

  test("POST /v1/embed/:embedUuid ändert message_limit, auch im Mehrbenutzermodus ohne Nutzer", async () => {
    for (const multiUser of [true, false]) {
      setMultiUserMode(prisma, multiUser);
      const result = await invoke(API_UPDATE, {
        params: { embedUuid: embed.uuid },
        body: { message_limit: multiUser ? 8 : 9 },
        token: "geheim",
      });
      expect(result.statusCode).toBe(200);
      expect(result.body).toEqual({ success: true, error: null });
      expect(embedRow(embed.id).message_limit).toBe(multiUser ? 8 : 9);
    }
  });

  test("POST /v1/embed/new übernimmt message_limit; ohne Angabe 2", async () => {
    const created = async (body) => {
      const result = await invoke(API_CREATE, {
        body: { workspace_slug: "a", ...body },
        token: "geheim",
      });
      expect(result.statusCode).toBe(200);
      return embedRow(result.body.embed.id).message_limit;
    };
    expect(await created({ message_limit: 12 })).toBe(12);
    expect(await created({})).toBe(2);
  });
});
