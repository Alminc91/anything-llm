/* eslint-env jest, node */
// KB-10 Teil 2: Benachrichtigung per E-Mail gegen die echten Routen mit ihrer
// ganzen Middleware-Kette (support/routeHarness.js), SystemSettings echt,
// nur die Datenbank ersetzt.
//   AK-T2-1  GET/POST /embeds/course-status/notify: Sitzung, Lesen admin,
//            manager, default; Speichern nur admin und manager; 400 mit
//            deutscher Meldung.
//   AK-T2-3  Beide Labels nicht über HTTP (updateSettings) schreibbar,
//            Validator in _updateSettings.
//   AK-T2-4  GET /v1/course-status liefert notify nach Vertrag (Fixture).
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
const CONTRACT = require("../fixtures/courseStatusNotify/contract.json");
const { embedManagementEndpoints } = require("../../endpoints/embedManagement");
const { apiEmbedEndpoints } = require("../../endpoints/api/embed");
const { SystemSettings } = require("../../models/systemSettings");
const { __test__: inventory } = require("../../utils/chats/courseInventory");
const { __test__: status } = require("../../utils/chats/courseStatus");
const {
  collectRoutes,
  invoke,
  setMultiUserMode,
  createUser,
} = require("./support/routeHarness");

const routes = collectRoutes(embedManagementEndpoints);
const GET = routes["GET /embeds/course-status/notify"];
const POST = routes["POST /embeds/course-status/notify"];
const API = collectRoutes(apiEmbedEndpoints)["GET /v1/course-status"];

const NOW = Date.parse("2026-10-29T12:05:00.000Z");
const CONTACTS = CONTRACT.contacts.emails;

let workspace;

const setting = (label) =>
  prisma.__rows("system_settings").find((row) => row.label === label) ?? null;
const seedSetting = (label, value) =>
  prisma.__seed("system_settings", { label, value: JSON.stringify(value) });

beforeAll(() => {
  jest.spyOn(console, "error").mockImplementation(() => {});
  jest.spyOn(console, "log").mockImplementation(() => {});
});

afterAll(() => {
  console.error.mockRestore();
  console.log.mockRestore();
});

beforeEach(() => {
  jest.spyOn(Date, "now").mockImplementation(() => NOW);
  prisma.__reset();
  inventory.reset();
  status.reset();
  setMultiUserMode(prisma, true);
  workspace = prisma.__seed("workspaces", { name: "VHS Beispiel", slug: "a" });
  prisma.__seed("embed_configs", {
    uuid: "uuid-a",
    enabled: true,
    chat_mode: "query",
    workspace_id: workspace.id,
    visual_config: "{}",
  });
  seedSetting("kufer_course_status_contacts", CONTRACT.contacts);
});

afterEach(() => {
  Date.now.mockRestore();
});

describe("AK-T2-1: GET /embeds/course-status/notify", () => {
  test("ohne Anmeldung 401", async () => {
    expect((await invoke(GET, {})).statusCode).toBe(401);
  });

  test("ohne gespeicherte Einstellung: an, Kontaktadressen gelten", async () => {
    const admin = createUser(prisma, "admin");
    const res = await invoke(GET, { token: admin.token });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      enabled: true,
      recipients: null,
      contacts: CONTACTS,
      effective: CONTACTS,
      canEdit: true,
    });
  });

  test("eigene Empfänger und ausgeschaltet", async () => {
    seedSetting("kufer_course_status_notify", CONTRACT.notifyOwn);
    const manager = createUser(prisma, "manager");
    expect((await invoke(GET, { token: manager.token })).body).toEqual({
      enabled: true,
      recipients: ["kursbestand@vhs-beispiel.de"],
      contacts: CONTACTS,
      effective: ["kursbestand@vhs-beispiel.de"],
      canEdit: true,
    });
    setting("kufer_course_status_notify").value = JSON.stringify(
      CONTRACT.notifyOff
    );
    expect((await invoke(GET, { token: manager.token })).body).toMatchObject({
      enabled: false,
      recipients: null,
      effective: CONTACTS,
    });
  });

  test("Default-User mit Widget liest, darf aber nicht speichern (canEdit false)", async () => {
    const user = createUser(prisma, "default", [workspace.id]);
    const res = await invoke(GET, { token: user.token });
    expect(res.statusCode).toBe(200);
    expect(res.body.contacts).toEqual(CONTACTS);
    expect(res.body.canEdit).toBe(false);
  });

  test("Default-User ohne sichtbares Widget: 404 ohne Adressen", async () => {
    const user = createUser(prisma, "default");
    const res = await invoke(GET, { token: user.token });
    expect(res.statusCode).toBe(404);
    expect(JSON.stringify(res.body ?? null)).not.toMatch(/@/);
  });

  test("ohne Mehrbenutzermodus: lesen und speichern erlaubt", async () => {
    setMultiUserMode(prisma, false);
    expect((await invoke(GET, {})).body.canEdit).toBe(true);
    const res = await invoke(POST, {
      body: { enabled: false, recipients: null },
    });
    expect(res.statusCode).toBe(200);
  });

  test("ungültige Kontaktadressen im Speicher: [] und kein Protokoll mit Adresse", async () => {
    setting("kufer_course_status_contacts").value = JSON.stringify({
      version: 1,
      emails: ["Geheim@vhs-beispiel.de"],
      at: "2026-10-29T12:00:00.000Z",
    });
    console.error.mockClear();
    const admin = createUser(prisma, "admin");
    const res = await invoke(GET, { token: admin.token });
    expect(res.body.contacts).toEqual([]);
    expect(res.body.effective).toEqual([]);
    const logged = JSON.stringify(console.error.mock.calls);
    expect(logged).not.toMatch(/geheim/i);
  });

  test("Lesefehler der Datenbank: 500", async () => {
    const admin = createUser(prisma, "admin");
    const original = prisma.system_settings.findFirst;
    prisma.system_settings.findFirst = async ({ where }) => {
      if (String(where?.label).startsWith("kufer_course_status"))
        throw new Error("db weg");
      return original({ where });
    };
    try {
      expect((await invoke(GET, { token: admin.token })).statusCode).toBe(500);
    } finally {
      prisma.system_settings.findFirst = original;
    }
  });
});

describe("AK-T2-1: POST /embeds/course-status/notify", () => {
  const save = (user, body) => invoke(POST, { token: user?.token, body });

  test("admin speichert eigene Empfänger nach Vertrag", async () => {
    const admin = createUser(prisma, "admin");
    const res = await save(admin, {
      enabled: true,
      recipients: [" Kursbestand@VHS-Beispiel.de "],
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      success: true,
      enabled: true,
      recipients: ["kursbestand@vhs-beispiel.de"],
      contacts: CONTACTS,
      effective: ["kursbestand@vhs-beispiel.de"],
      canEdit: true,
    });
    expect(JSON.parse(setting("kufer_course_status_notify").value)).toEqual(
      CONTRACT.notifyOwn
    );
  });

  test("manager schaltet aus; Kontaktadressen als Eingabe ergeben null", async () => {
    const manager = createUser(prisma, "manager");
    const res = await save(manager, {
      enabled: false,
      recipients: [...CONTACTS],
    });
    expect(res.statusCode).toBe(200);
    const stored = JSON.parse(setting("kufer_course_status_notify").value);
    expect(stored).toEqual({
      ...CONTRACT.notifyOff,
      updatedAt: stored.updatedAt,
    });
    expect(stored.updatedAt).toBe(new Date(NOW).toISOString());
  });

  test("Default-User: 401, nichts gespeichert", async () => {
    const user = createUser(prisma, "default", [workspace.id]);
    const res = await save(user, { enabled: false, recipients: null });
    expect(res.statusCode).toBe(401);
    expect(setting("kufer_course_status_notify")).toBeNull();
  });

  test("ohne Anmeldung: 401", async () => {
    expect((await save(null, { enabled: false })).statusCode).toBe(401);
  });

  test.each([
    [
      "ungültige Adresse",
      { enabled: true, recipients: ["kontakt@vhs-beispiel"] },
      {
        code: "adresse",
        address: "kontakt@vhs-beispiel",
        error: "„kontakt@vhs-beispiel“ ist keine gültige E-Mail-Adresse.",
      },
    ],
    [
      "mehr als 5",
      {
        enabled: true,
        recipients: Array.from({ length: 6 }, (_, i) => `a${i}@b.de`),
      },
      {
        code: "zu_viele",
        address: null,
        error: "Bitte geben Sie höchstens 5 Empfänger an.",
      },
    ],
    [
      "enabled fehlt",
      { recipients: null },
      { code: "ungueltig", address: null, error: "Die Angaben sind ungültig." },
    ],
    [
      "kein JSON",
      "{kaputt",
      { code: "ungueltig", address: null, error: "Die Angaben sind ungültig." },
    ],
  ])("400: %s, nichts gespeichert", async (_name, body, expected) => {
    const admin = createUser(prisma, "admin");
    const res = await save(admin, body);
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ success: false, ...expected });
    expect(setting("kufer_course_status_notify")).toBeNull();
  });

  test("Schreibfehler: 500 mit deutscher Meldung, ohne Adressen im Protokoll", async () => {
    const admin = createUser(prisma, "admin");
    const spy = jest
      .spyOn(SystemSettings, "_updateSettings")
      .mockResolvedValue({ success: false, error: "kaputt" });
    console.error.mockClear();
    try {
      const res = await save(admin, {
        enabled: true,
        recipients: ["geheim@vhs-beispiel.de"],
      });
      expect(res.statusCode).toBe(500);
      expect(res.body).toEqual({
        success: false,
        code: "fehler",
        error: "Die Benachrichtigung konnte nicht gespeichert werden.",
      });
      expect(JSON.stringify(console.error.mock.calls)).not.toMatch(/geheim/);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("AK-T2-3: nicht über HTTP schreibbar, Validator beim Schreiben", () => {
  test("updateSettings (HTTP-Weg) übergeht beide Labels", async () => {
    const before = setting("kufer_course_status_contacts").value;
    await SystemSettings.updateSettings({
      kufer_course_status_contacts: JSON.stringify({
        version: 1,
        emails: ["fremd@example.de"],
        at: "2026-10-29T12:00:00.000Z",
      }),
      kufer_course_status_notify: JSON.stringify(CONTRACT.notifyOwn),
    });
    expect(setting("kufer_course_status_contacts").value).toBe(before);
    expect(setting("kufer_course_status_notify")).toBeNull();
    expect(SystemSettings.supportedFields).not.toContain(
      "kufer_course_status_contacts"
    );
    expect(SystemSettings.supportedFields).not.toContain(
      "kufer_course_status_notify"
    );
    expect(SystemSettings.publicFields).not.toContain(
      "kufer_course_status_contacts"
    );
  });

  test("_updateSettings (Pipeline) nimmt nur gültige Werte an", async () => {
    const valid = JSON.stringify({
      ...CONTRACT.contacts,
      emails: ["neu@vhs-beispiel.de"],
    });
    expect(
      await SystemSettings._updateSettings({
        kufer_course_status_contacts: valid,
      })
    ).toEqual({ success: true, error: null });
    expect(setting("kufer_course_status_contacts").value).toBe(valid);

    const result = await SystemSettings._updateSettings({
      kufer_course_status_contacts: JSON.stringify({
        ...CONTRACT.contacts,
        emails: ["Gross@vhs-beispiel.de"],
      }),
    });
    expect(result.success).toBe(false);
    expect(result.error).not.toMatch(/gross/i);
    expect(setting("kufer_course_status_contacts").value).toBe(valid);
    expect(typeof SystemSettings.validations.kufer_course_status_contacts).toBe(
      "function"
    );
    expect(typeof SystemSettings.validations.kufer_course_status_notify).toBe(
      "function"
    );
  });
});

describe("AK-T2-4: GET /v1/course-status liefert notify nach Vertrag", () => {
  const api = async () => {
    prisma.__seed("api_keys", { secret: "geheim" });
    const res = await invoke(API, { token: "geheim" });
    expect(res.statusCode).toBe(200);
    return res.body;
  };

  test("ohne Einstellung: an, Kontaktadressen (v1NotifyDefault)", async () => {
    const body = await api();
    expect(body.notify).toEqual(CONTRACT.v1NotifyDefault);
    expect(body.workspaces).toEqual([]);
  });

  test("eigene Empfänger (v1NotifyOwn)", async () => {
    seedSetting("kufer_course_status_notify", CONTRACT.notifyOwn);
    expect((await api()).notify).toEqual(CONTRACT.v1NotifyOwn);
  });

  test("ausgeschaltet nennt trotzdem die wirksamen Empfänger (v1NotifyOff)", async () => {
    seedSetting("kufer_course_status_notify", CONTRACT.notifyOff);
    expect((await api()).notify).toEqual(CONTRACT.v1NotifyOff);
  });

  test("ohne Kontaktadressen: recipients []", async () => {
    prisma
      .__rows("system_settings")
      .splice(
        prisma
          .__rows("system_settings")
          .indexOf(setting("kufer_course_status_contacts")),
        1
      );
    expect((await api()).notify).toEqual({ enabled: true, recipients: [] });
  });

  test("ohne API-Schlüssel: 403 ohne Adressen", async () => {
    const res = await invoke(API, {});
    expect(res.statusCode).toBe(403);
    expect(JSON.stringify(res.body ?? null)).not.toMatch(/@/);
  });
});
