/* eslint-env jest, node */
// KIE-533 — POST /admin/workspaces/new: Workspaces legt nur admin an.
//
// Ein neuer Workspace hat kein Limit (messagesLimit NULL = unbegrenzt); ein
// Manager könnte sich so ein unbegrenztes Kontingent verschaffen.
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

const prisma = require("../../utils/prisma");
const { adminEndpoints } = require("../../endpoints/admin");
const {
  collectRoutes,
  invoke,
  setMultiUserMode,
  createUser,
} = require("./support/routeHarness");

const newWorkspace =
  collectRoutes(adminEndpoints)["POST /admin/workspaces/new"];

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
});

test("die Route ist registriert", () => {
  expect(Array.isArray(newWorkspace)).toBe(true);
});

// ============================================================================
// AK-12 — Manager legt keinen Workspace an
// ============================================================================
describe("nur_admin (AK-12)", () => {
  test("manager: 403, es entsteht kein Workspace", async () => {
    const manager = createUser(prisma, "manager");

    const result = await invoke(newWorkspace, {
      body: { name: "Unbegrenzt" },
      token: manager.token,
    });

    expect(result.statusCode).toBe(403);
    expect(result.body).toBeUndefined();
    expect(prisma.__rows("workspaces")).toHaveLength(0);
    expect(prisma.__rows("workspace_users")).toHaveLength(0);
  });

  test("admin: der Workspace entsteht, Antwort wie zuvor", async () => {
    const admin = createUser(prisma, "admin");

    const result = await invoke(newWorkspace, {
      body: { name: "Neuer Kunde" },
      token: admin.token,
    });

    expect(result.statusCode).toBe(200);
    expect(Object.keys(result.body)).toEqual(["workspace", "error"]);
    expect(result.body.error).toBeNull();
    expect(result.body.workspace).toMatchObject({
      name: "Neuer Kunde",
      slug: "neuer-kunde",
    });
    expect(prisma.__rows("workspaces")).toHaveLength(1);
    // Wie zuvor wird der Ersteller dem Workspace zugeordnet.
    expect(prisma.__rows("workspace_users")).toEqual([
      expect.objectContaining({
        user_id: admin.id,
        workspace_id: result.body.workspace.id,
      }),
    ]);
  });

  test("default: 401 wie zuvor, kein Workspace", async () => {
    const kunde = createUser(prisma, "default");
    const result = await invoke(newWorkspace, {
      body: { name: "Unbegrenzt" },
      token: kunde.token,
    });
    expect(result.statusCode).toBe(401);
    expect(prisma.__rows("workspaces")).toHaveLength(0);
  });

  test("ohne Anmeldung: 401, kein Workspace", async () => {
    const result = await invoke(newWorkspace, { body: { name: "Unbegrenzt" } });
    expect(result.statusCode).toBe(401);
    expect(prisma.__rows("workspaces")).toHaveLength(0);
  });

  test("ohne Mehrbenutzermodus: 401 wie zuvor (Route nur im Mehrbenutzermodus)", async () => {
    setMultiUserMode(prisma, false);
    const result = await invoke(newWorkspace, { body: { name: "Unbegrenzt" } });
    expect(result.statusCode).toBe(401);
    expect(prisma.__rows("workspaces")).toHaveLength(0);
  });
});
