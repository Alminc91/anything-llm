/* eslint-env jest, node */
// KIE-533 — Abrechnungsfelder eines Workspaces (messagesLimit, cycleStartDate,
// cycleDurationMonths): wer sie ändern darf und welche Werte gelten.
//
// - Über die Oberfläche (Sitzung) ändert sie nur admin; für manager werden sie
//   verworfen. Die API mit Schlüssel ändert sie weiterhin.
// - Ungültige Werte werden mit 400 abgelehnt statt umgedeutet.
// - 0 heißt gesperrt, null heißt unbegrenzt.
//
// Geprüft wird gegen die echten Routen mit ihrer ganzen Middleware-Kette
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
jest.mock("../../utils/chats/apiChatHandler", () => ({
  ApiChatHandler: { chatSync: jest.fn(), streamChat: jest.fn() },
}));
jest.mock("../../utils/chats/openaiCompatible", () => ({
  OpenAICompatibleChat: { chatSync: jest.fn(), streamChat: jest.fn() },
}));

const prisma = require("../../utils/prisma");
const { Workspace } = require("../../models/workspace");
const { workspaceEndpoints } = require("../../endpoints/workspaces");
const { apiWorkspaceEndpoints } = require("../../endpoints/api/workspace");
const { apiOpenAICompatibleEndpoints } = require("../../endpoints/api/openai");
const { checkWorkspaceMessagesLimit } = require("../../utils/helpers");
const {
  getCycleInfoWithMessageCount,
  isCycleLimitReached,
} = require("../../utils/helpers/cycleHelpers");
const {
  collectRoutes,
  invoke,
  setMultiUserMode,
  createUser,
} = require("./support/routeHarness");

const sessionRoutes = collectRoutes(workspaceEndpoints);
const apiRoutes = collectRoutes(apiWorkspaceEndpoints);
const openaiRoutes = collectRoutes(apiOpenAICompatibleEndpoints);
const ROUTE = {
  sessionUpdate: sessionRoutes["POST /workspace/:slug/update"],
  sessionUsage: sessionRoutes["GET /workspace/:slug/usage"],
  apiUpdate: apiRoutes["POST /v1/workspace/:slug/update"],
  apiNew: apiRoutes["POST /v1/workspace/new"],
  apiLimits: openaiRoutes["GET /v1/openai/workspace/:slug/limits"],
};

const API_KEY = "kie-533-api-key";
const NOW = new Date("2026-10-12T10:00:00+02:00");
const SLUG = "kunde";

let workspace;

function seedWorkspace(slug, billing = {}) {
  return prisma.__seed("workspaces", { name: slug, slug, ...billing });
}

const row = (slug = SLUG) =>
  prisma.__rows("workspaces").find((entry) => entry.slug === slug);
const billingOf = (slug = SLUG) => {
  const { messagesLimit, cycleStartDate, cycleDurationMonths } = row(slug);
  return { messagesLimit, cycleStartDate, cycleDurationMonths };
};

const apiUpdate = (body, slug = SLUG) =>
  invoke(ROUTE.apiUpdate, { params: { slug }, body, token: API_KEY });
const sessionUpdate = (user, body, slug = SLUG) =>
  invoke(ROUTE.sessionUpdate, {
    params: { slug },
    body,
    token: user?.token ?? null,
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
  jest.useFakeTimers().setSystemTime(NOW);
  prisma.__reset();
  setMultiUserMode(prisma, true);
  prisma.__seed("api_keys", { secret: API_KEY });
  workspace = seedWorkspace(SLUG, {
    messagesLimit: 600,
    cycleStartDate: new Date("2026-01-15"),
    cycleDurationMonths: 3,
  });
});

afterEach(() => {
  jest.useRealTimers();
});

test("alle geprüften Routen sind registriert", () => {
  for (const chain of Object.values(ROUTE))
    expect(Array.isArray(chain)).toBe(true);
});

// ============================================================================
// AK-1 — Manager ändert den Zyklus nicht
// ============================================================================
describe("manager_zyklus (AK-1)", () => {
  test("Zyklusstart, Zyklusdauer und Limit bleiben unverändert, der Name ist gespeichert", async () => {
    const manager = createUser(prisma, "manager");
    const before = billingOf();

    const result = await sessionUpdate(manager, {
      // "Zyklus auf heute" = Verbrauch 0: genau das darf nicht mehr gehen
      cycleStartDate: "2026-10-12",
      cycleDurationMonths: 12,
      messagesLimit: 999999,
      name: "Neuer Name",
    });

    expect(result.statusCode).toBe(200);
    expect(result.body.message).toBeNull();
    expect(result.body.workspace.name).toBe("Neuer Name");
    expect(row().name).toBe("Neuer Name");
    expect(billingOf()).toEqual(before);
    expect(result.body.workspace.messagesLimit).toBe(600);
    expect(result.body.workspace.cycleDurationMonths).toBe(3);
    expect(result.body.workspace.cycleStartDate).toBe(
      "2026-01-15T00:00:00.000Z"
    );
  });

  test("auch einzeln und mit null: kein Abrechnungsfeld kommt an", async () => {
    const manager = createUser(prisma, "manager");
    const before = billingOf();
    for (const body of [
      { cycleStartDate: "2026-10-12" },
      { cycleDurationMonths: 1 },
      { cycleStartDate: null, cycleDurationMonths: null },
      { messagesLimit: null },
      { messagesLimit: 0 },
    ]) {
      const result = await sessionUpdate(manager, body);
      expect(result.statusCode).toBe(200);
      expect(billingOf()).toEqual(before);
    }
  });

  test("ungültige Abrechnungswerte eines Managers werden verworfen, nicht geprüft", async () => {
    const manager = createUser(prisma, "manager");
    const result = await sessionUpdate(manager, {
      cycleDurationMonths: 5,
      messagesLimit: "abc",
      name: "Trotzdem gespeichert",
    });
    expect(result.statusCode).toBe(200);
    expect(row().name).toBe("Trotzdem gespeichert");
    expect(billingOf().cycleDurationMonths).toBe(3);
  });

  test("Rolle default erreicht die Route weiterhin nicht (401)", async () => {
    const kunde = createUser(prisma, "default", [workspace.id]);
    const before = JSON.stringify(row());
    const result = await sessionUpdate(kunde, {
      cycleStartDate: "2026-10-12",
      name: "x",
    });
    expect(result.statusCode).toBe(401);
    expect(JSON.stringify(row())).toBe(before);
  });

  test("ohne Anmeldung: 401", async () => {
    const result = await sessionUpdate(null, { cycleStartDate: "2026-10-12" });
    expect(result.statusCode).toBe(401);
  });

  test("ohne Mehrbenutzermodus: wie bisher schon das Limit sind die Zyklusfelder nur über die API änderbar", async () => {
    setMultiUserMode(prisma, false);
    const before = billingOf();
    const result = await sessionUpdate(null, {
      cycleStartDate: "2026-10-12",
      cycleDurationMonths: 12,
      messagesLimit: 5,
      name: "Einbenutzerbetrieb",
    });
    expect(result.statusCode).toBe(200);
    expect(row().name).toBe("Einbenutzerbetrieb");
    expect(billingOf()).toEqual(before);
  });
});

// ============================================================================
// AK-2 — Admin und API ändern den Zyklus weiterhin
// ============================================================================
describe("admin_und_api (AK-2)", () => {
  const body = {
    cycleStartDate: "2026-10-01",
    cycleDurationMonths: 6,
    messagesLimit: 1200,
  };
  const saved = {
    cycleStartDate: new Date("2026-10-01T00:00:00.000Z"),
    cycleDurationMonths: 6,
    messagesLimit: 1200,
  };

  test("admin über die Oberfläche", async () => {
    const admin = createUser(prisma, "admin");
    const result = await sessionUpdate(admin, body);
    expect(result.statusCode).toBe(200);
    expect(result.body.message).toBeNull();
    expect(billingOf()).toEqual(saved);
    expect(result.body.workspace).toMatchObject({
      cycleStartDate: "2026-10-01T00:00:00.000Z",
      cycleDurationMonths: 6,
      messagesLimit: 1200,
    });
  });

  test("admin sendet das Formular der Abrechnungsansicht (alles als Zeichenkette)", async () => {
    const admin = createUser(prisma, "admin");
    const result = await sessionUpdate(admin, {
      messagesLimit: "1200",
      cycleStartDate: "2026-10-01",
      cycleDurationMonths: "6",
    });
    expect(result.statusCode).toBe(200);
    expect(billingOf()).toEqual(saved);
  });

  test("API mit Schlüssel", async () => {
    const result = await apiUpdate(body);
    expect(result.statusCode).toBe(200);
    expect(result.body.message).toBeNull();
    expect(billingOf()).toEqual(saved);
  });

  test("API ohne oder mit falschem Schlüssel: 403, nichts gespeichert", async () => {
    const before = billingOf();
    for (const token of [null, "falscher-schluessel"]) {
      const result = await invoke(ROUTE.apiUpdate, {
        params: { slug: SLUG },
        body,
        token,
      });
      expect(result.statusCode).toBe(403);
    }
    expect(billingOf()).toEqual(before);
  });

  test("ein Sitzungs-Token ist kein API-Schlüssel", async () => {
    const manager = createUser(prisma, "manager");
    const before = billingOf();
    const result = await invoke(ROUTE.apiUpdate, {
      params: { slug: SLUG },
      body,
      token: manager.token,
    });
    expect(result.statusCode).toBe(403);
    expect(billingOf()).toEqual(before);
  });
});

// ============================================================================
// AK-8 — Ungültige Abrechnungswerte werden abgelehnt
// ============================================================================
describe("validierung (AK-8)", () => {
  // [Beschreibung, Anfrage, Feld mit Fehlermeldung]
  const invalid = [
    ['messagesLimit "abc"', { messagesLimit: "abc" }, "messagesLimit"],
    ["messagesLimit -1", { messagesLimit: -1 }, "messagesLimit"],
    ['messagesLimit "-1"', { messagesLimit: "-1" }, "messagesLimit"],
    ['messagesLimit "10.000"', { messagesLimit: "10.000" }, "messagesLimit"],
    ["messagesLimit 10.5", { messagesLimit: 10.5 }, "messagesLimit"],
    ['messagesLimit "1e3"', { messagesLimit: "1e3" }, "messagesLimit"],
    ["messagesLimit true", { messagesLimit: true }, "messagesLimit"],
    ["messagesLimit [5]", { messagesLimit: [5] }, "messagesLimit"],
    ["messagesLimit zu groß", { messagesLimit: 2147483648 }, "messagesLimit"],
    [
      "messagesLimit zu groß (Zeichenkette)",
      { messagesLimit: "2147483648" },
      "messagesLimit",
    ],
    ["Dauer 5", { cycleDurationMonths: 5 }, "cycleDurationMonths"],
    ["Dauer 0", { cycleDurationMonths: 0 }, "cycleDurationMonths"],
    [
      'Dauer "3 Monate"',
      { cycleDurationMonths: "3 Monate" },
      "cycleDurationMonths",
    ],
    ["Dauer 1.5", { cycleDurationMonths: 1.5 }, "cycleDurationMonths"],
    ["Start im Jahr 1900", { cycleStartDate: "1900-01-01" }, "cycleStartDate"],
    ["Start vor 2020", { cycleStartDate: "2019-12-31" }, "cycleStartDate"],
    [
      "Start mehr als 5 Jahre voraus",
      { cycleStartDate: "2031-10-13" },
      "cycleStartDate",
    ],
    ['Start "15.01.2026"', { cycleStartDate: "15.01.2026" }, "cycleStartDate"],
    ['Start "2026"', { cycleStartDate: "2026" }, "cycleStartDate"],
    ['Start "2026-02-30"', { cycleStartDate: "2026-02-30" }, "cycleStartDate"],
    ['Start "morgen"', { cycleStartDate: "morgen" }, "cycleStartDate"],
    ["Start als Zahl", { cycleStartDate: 1767225600000 }, "cycleStartDate"],
    [
      "Start entfernt, Dauer bleibt gespeichert",
      { cycleStartDate: null },
      "cycleDurationMonths",
    ],
    [
      "Start entfernt, Dauer mitgesendet",
      { cycleStartDate: "", cycleDurationMonths: 3 },
      "cycleDurationMonths",
    ],
  ];

  test.each(invalid)(
    "API: %s → 400 mit Meldung am Feld, Workspace unverändert",
    async (_name, body, field) => {
      const before = JSON.stringify(row());

      // Ein gültiges Feld in derselben Anfrage darf nicht gespeichert werden.
      const result = await apiUpdate({ ...body, name: "Nicht speichern" });

      expect(result.statusCode).toBe(400);
      expect(result.body.workspace).toBeNull();
      expect(Object.keys(result.body.errors)).toEqual([field]);
      expect(typeof result.body.errors[field]).toBe("string");
      expect(result.body.errors[field]).toContain(field);
      expect(result.body.message).toContain(result.body.errors[field]);
      expect(JSON.stringify(row())).toBe(before);
    }
  );

  test("API: Dauer ohne Startdatum (weder gesendet noch gespeichert) → 400", async () => {
    seedWorkspace("ohne-zyklus");
    const before = JSON.stringify(row("ohne-zyklus"));

    const result = await apiUpdate({ cycleDurationMonths: 3 }, "ohne-zyklus");

    expect(result.statusCode).toBe(400);
    expect(Object.keys(result.body.errors)).toEqual(["cycleDurationMonths"]);
    expect(result.body.errors.cycleDurationMonths).toMatch(/cycleStartDate/);
    expect(JSON.stringify(row("ohne-zyklus"))).toBe(before);
  });

  test("API: mehrere ungültige Felder → eine Meldung je Feld", async () => {
    const before = JSON.stringify(row());
    const result = await apiUpdate({
      messagesLimit: "10.000",
      cycleDurationMonths: 5,
      cycleStartDate: "1900-01-01",
    });
    expect(result.statusCode).toBe(400);
    expect(Object.keys(result.body.errors).sort()).toEqual([
      "cycleDurationMonths",
      "cycleStartDate",
      "messagesLimit",
    ]);
    for (const message of Object.values(result.body.errors))
      expect(result.body.message).toContain(message);
    expect(JSON.stringify(row())).toBe(before);
  });

  test("Oberfläche (admin): dieselbe Prüfung, 400 mit Meldung je Feld", async () => {
    const admin = createUser(prisma, "admin");
    const before = JSON.stringify(row());
    const result = await sessionUpdate(admin, {
      messagesLimit: "10.000",
      name: "Nicht speichern",
    });
    expect(result.statusCode).toBe(400);
    expect(result.body.workspace).toBeNull();
    expect(Object.keys(result.body.errors)).toEqual(["messagesLimit"]);
    expect(JSON.stringify(row())).toBe(before);
  });

  test("API: Anlegen mit ungültigen Werten → 400, es entsteht kein Workspace", async () => {
    for (const [body, field] of [
      [{ messagesLimit: "abc" }, "messagesLimit"],
      [{ cycleDurationMonths: 5 }, "cycleDurationMonths"],
      // Dauer ohne Startdatum
      [{ cycleDurationMonths: 3 }, "cycleDurationMonths"],
      [{ cycleStartDate: "1900-01-01" }, "cycleStartDate"],
    ]) {
      const result = await invoke(ROUTE.apiNew, {
        body: { name: "Neukunde", ...body },
        token: API_KEY,
      });
      expect(result.statusCode).toBe(400);
      expect(result.body.workspace).toBeNull();
      expect(Object.keys(result.body.errors)).toEqual([field]);
    }
    expect(prisma.__rows("workspaces")).toHaveLength(1);
  });

  test("Grenzen des Startdatums: 2020-01-01 und heute + 5 Jahre gelten noch", async () => {
    for (const day of ["2020-01-01", "2031-10-12"]) {
      const result = await apiUpdate({ cycleStartDate: day });
      expect(result.statusCode).toBe(200);
      expect(billingOf().cycleStartDate).toEqual(new Date(day));
    }
  });

  test("validateBillingFields: unberührte Felder bleiben unberührt, leere Werte sind null", () => {
    expect(Workspace.validateBillingFields({ name: "x" })).toEqual({
      values: {},
      errors: null,
      message: null,
    });
    expect(
      Workspace.validateBillingFields(
        { messagesLimit: "", cycleStartDate: "", cycleDurationMonths: "" },
        { messagesLimit: 5, cycleStartDate: new Date(), cycleDurationMonths: 1 }
      ).values
    ).toEqual({
      messagesLimit: null,
      cycleStartDate: null,
      cycleDurationMonths: null,
    });
    expect(
      Workspace.validateBillingFields({ messagesLimit: undefined }).values
    ).toEqual({});
  });

  test("validateFields reicht Abrechnungsfelder nie ungeprüft durch", () => {
    expect(
      Workspace.validateFields({
        name: "x",
        messagesLimit: "abc",
        cycleStartDate: "1900-01-01",
        cycleDurationMonths: 5,
      })
    ).toEqual({ name: "x" });
  });
});

// ============================================================================
// AK-9 — 0 heißt gesperrt, null heißt unbegrenzt
// ============================================================================
describe("null_gegen_nullwert (AK-9)", () => {
  let gesperrt, unbegrenzt, admin;
  beforeEach(() => {
    gesperrt = seedWorkspace("gesperrt", { messagesLimit: 0 });
    unbegrenzt = seedWorkspace("unbegrenzt", { messagesLimit: null });
    admin = createUser(prisma, "admin");
  });

  test("Limitprüfung: 0 meldet Limit erreicht, null nie", async () => {
    const blocked = await checkWorkspaceMessagesLimit(gesperrt, null, {
      returnData: true,
    });
    expect(blocked.limitReached).toBe(true);
    expect(blocked.messagesLimit).toBe(0);
    expect(blocked.errorData.contingent).toBe("0/0");

    const open = await checkWorkspaceMessagesLimit(unbegrenzt, null, {
      returnData: true,
    });
    expect(open.limitReached).toBe(false);
    expect(open.messagesLimit).toBeNull();
    expect(open.errorData).toBeNull();
  });

  test("Zyklusinfo: 0 meldet Limit erreicht und 0 verbleibend, null unbegrenzt", async () => {
    expect(await isCycleLimitReached(gesperrt)).toBe(true);
    expect(await isCycleLimitReached(unbegrenzt)).toBe(false);
    // Ein Feld, das fehlt, ist wie null kein Limit.
    expect(await isCycleLimitReached({ id: unbegrenzt.id })).toBe(false);

    const blocked = await getCycleInfoWithMessageCount(gesperrt);
    expect(blocked.messagesRemaining).toBe(0);
    expect(blocked.contingent).toBe("0/0");

    const open = await getCycleInfoWithMessageCount(unbegrenzt);
    expect(open.messagesRemaining).toBeNull();
    expect(open.contingent).toBe("0/Unlimited");
  });

  test("Abrechnungsansicht (GET /workspace/:slug/usage): 0 bleibt 0, null bleibt null", async () => {
    const blocked = await invoke(ROUTE.sessionUsage, {
      params: { slug: "gesperrt" },
      token: admin.token,
    });
    expect(blocked.statusCode).toBe(200);
    expect(blocked.body.messagesLimit).toBe(0);
    expect(blocked.body.messageCount).toBe(0);
    expect(blocked.body.contingent).toBe("0/0");

    const open = await invoke(ROUTE.sessionUsage, {
      params: { slug: "unbegrenzt" },
      token: admin.token,
    });
    expect(open.statusCode).toBe(200);
    expect(open.body.messagesLimit).toBeNull();
    expect(open.body.contingent).toBe("0/Unlimited");
  });

  test("Kontingent-Abfrage der API: 0 → limitReached, null → unlimited", async () => {
    const blocked = await invoke(ROUTE.apiLimits, {
      params: { slug: "gesperrt" },
      token: API_KEY,
    });
    expect(blocked.body).toMatchObject({
      messagesLimit: 0,
      messagesRemaining: 0,
      unlimited: false,
      limitReached: true,
    });

    const open = await invoke(ROUTE.apiLimits, {
      params: { slug: "unbegrenzt" },
      token: API_KEY,
    });
    expect(open.body).toMatchObject({
      messagesLimit: null,
      messagesRemaining: null,
      unlimited: true,
      limitReached: false,
    });
  });

  test("0 wird als 0 gespeichert, nicht als unbegrenzt", async () => {
    for (const value of [0, "0"]) {
      row().messagesLimit = 600;
      const result = await apiUpdate({ messagesLimit: value });
      expect(result.statusCode).toBe(200);
      expect(billingOf().messagesLimit).toBe(0);
      expect(result.body.workspace.messagesLimit).toBe(0);
    }
    for (const value of [null, ""]) {
      row().messagesLimit = 600;
      const result = await apiUpdate({ messagesLimit: value });
      expect(result.statusCode).toBe(200);
      expect(billingOf().messagesLimit).toBeNull();
    }
  });
});

// ============================================================================
// NAK-1 — Kundenmanager-Integration bricht nicht
// ============================================================================
describe("vertrag_kundenmanager (NAK-1)", () => {
  test("Limit, Start und Dauer setzen: Antwort { workspace, message } mit dem gespeicherten Workspace", async () => {
    const result = await apiUpdate({
      messagesLimit: 500,
      cycleStartDate: "2026-09-01",
      cycleDurationMonths: 3,
    });

    expect(result.statusCode).toBe(200);
    expect(Object.keys(result.body)).toEqual(["workspace", "message"]);
    expect(result.body.message).toBeNull();
    // Der zurückgegebene Workspace ist die gespeicherte Zeile.
    expect(result.body.workspace).toEqual(JSON.parse(JSON.stringify(row())));
    expect(result.body.workspace).toMatchObject({
      id: workspace.id,
      slug: SLUG,
      messagesLimit: 500,
      cycleStartDate: "2026-09-01T00:00:00.000Z",
      cycleDurationMonths: 3,
    });
    expect(billingOf()).toEqual({
      messagesLimit: 500,
      cycleStartDate: new Date("2026-09-01T00:00:00.000Z"),
      cycleDurationMonths: 3,
    });
  });

  test("Zyklusstart in der Zukunft bleibt zulässig", async () => {
    const result = await apiUpdate({
      messagesLimit: 500,
      cycleStartDate: "2027-03-01",
      cycleDurationMonths: 12,
    });
    expect(result.statusCode).toBe(200);
    expect(billingOf()).toEqual({
      messagesLimit: 500,
      cycleStartDate: new Date("2027-03-01T00:00:00.000Z"),
      cycleDurationMonths: 12,
    });
  });

  test.each([1, 2, 3, 4, 6, 12])("Dauer %i", async (months) => {
    const result = await apiUpdate({ cycleDurationMonths: months });
    expect(result.statusCode).toBe(200);
    expect(billingOf().cycleDurationMonths).toBe(months);
  });

  test("Schreibweisen gültiger Werte: Zahl als Zeichenkette, ISO-Zeitstempel", async () => {
    const result = await apiUpdate({
      messagesLimit: "500",
      cycleStartDate: "2026-09-01T00:00:00.000Z",
      cycleDurationMonths: "3",
    });
    expect(result.statusCode).toBe(200);
    expect(billingOf()).toEqual({
      messagesLimit: 500,
      cycleStartDate: new Date("2026-09-01T00:00:00.000Z"),
      cycleDurationMonths: 3,
    });
  });

  test("einzelne Felder: nur das Limit bzw. nur die Dauer (Start ist gespeichert)", async () => {
    expect((await apiUpdate({ messagesLimit: 750 })).statusCode).toBe(200);
    expect((await apiUpdate({ cycleDurationMonths: 6 })).statusCode).toBe(200);
    expect(billingOf()).toEqual({
      messagesLimit: 750,
      cycleStartDate: new Date("2026-01-15T00:00:00.000Z"),
      cycleDurationMonths: 6,
    });
  });

  test("Zyklus und Limit entfernen (null bzw. leere Zeichenkette)", async () => {
    for (const empty of [null, ""]) {
      Object.assign(row(), {
        messagesLimit: 600,
        cycleStartDate: new Date("2026-01-15"),
        cycleDurationMonths: 3,
      });
      const result = await apiUpdate({
        messagesLimit: empty,
        cycleStartDate: empty,
        cycleDurationMonths: empty,
      });
      expect(result.statusCode).toBe(200);
      expect(billingOf()).toEqual({
        messagesLimit: null,
        cycleStartDate: null,
        cycleDurationMonths: null,
      });
    }
  });

  test("dieselben Werte erneut senden: dieselbe Antwort mit vollständigem Workspace", async () => {
    const body = {
      messagesLimit: 600,
      cycleStartDate: "2026-01-15",
      cycleDurationMonths: 3,
    };
    const first = await apiUpdate(body);
    const second = await apiUpdate(body);
    expect(first.statusCode).toBe(200);
    expect(second.body).toEqual(first.body);
    expect(second.body.message).toBeNull();
    expect(second.body.workspace.slug).toBe(SLUG);
  });

  test("andere Felder ohne Abrechnungswerte wie zuvor", async () => {
    const before = billingOf();
    const result = await apiUpdate({ name: "Umbenannt", openAiTemp: 0.2 });
    expect(result.statusCode).toBe(200);
    expect(Object.keys(result.body)).toEqual(["workspace", "message"]);
    expect(row().name).toBe("Umbenannt");
    expect(row().openAiTemp).toBe(0.2);
    expect(billingOf()).toEqual(before);
  });

  test("unbekannter Workspace: 400 wie zuvor", async () => {
    const result = await apiUpdate({ messagesLimit: 5 }, "gibt-es-nicht");
    expect(result.statusCode).toBe(400);
  });

  test("Anlegen mit Limit, Start und Dauer: 200 mit { workspace, message }", async () => {
    const result = await invoke(ROUTE.apiNew, {
      body: {
        name: "Neukunde",
        messagesLimit: 300,
        cycleStartDate: "2026-11-01",
        cycleDurationMonths: 1,
      },
      token: API_KEY,
    });
    expect(result.statusCode).toBe(200);
    expect(Object.keys(result.body)).toEqual(["workspace", "message"]);
    expect(result.body.message).toBeNull();
    expect(result.body.workspace).toMatchObject({
      name: "Neukunde",
      slug: "neukunde",
      messagesLimit: 300,
      cycleStartDate: "2026-11-01T00:00:00.000Z",
      cycleDurationMonths: 1,
    });
    expect(billingOf("neukunde")).toEqual({
      messagesLimit: 300,
      cycleStartDate: new Date("2026-11-01T00:00:00.000Z"),
      cycleDurationMonths: 1,
    });
  });

  test("Anlegen ohne Abrechnungswerte: unbegrenzt wie zuvor", async () => {
    const result = await invoke(ROUTE.apiNew, {
      body: { name: "Ohne Limit" },
      token: API_KEY,
    });
    expect(result.statusCode).toBe(200);
    expect(billingOf("ohne-limit")).toEqual({
      messagesLimit: null,
      cycleStartDate: null,
      cycleDurationMonths: null,
    });
  });
});

// ============================================================================
// NAK-4 — Bestehende Werte bleiben gültig
// ============================================================================
describe("bestand (NAK-4)", () => {
  // Werte, die nach den neuen Regeln nicht mehr angenommen würden
  const ALT = {
    messagesLimit: -5,
    cycleStartDate: new Date("1999-06-01T00:00:00.000Z"),
    cycleDurationMonths: 5,
  };
  let admin;
  beforeEach(() => {
    seedWorkspace("alt", { ...ALT });
    // Dauer ohne Startdatum: bisher möglich, fällt auf den Kalendermonat
    seedWorkspace("nur-dauer", { messagesLimit: 100, cycleDurationMonths: 3 });
    admin = createUser(prisma, "admin");
  });

  test("Lesen und Chatten scheitern nicht", async () => {
    for (const slug of ["alt", "nur-dauer"]) {
      const usage = await invoke(ROUTE.sessionUsage, {
        params: { slug },
        token: admin.token,
      });
      expect(usage.statusCode).toBe(200);
      expect(usage.body.messagesLimit).toBe(row(slug).messagesLimit);

      const limits = await invoke(ROUTE.apiLimits, {
        params: { slug },
        token: API_KEY,
      });
      expect(limits.statusCode).toBe(200);

      const check = await checkWorkspaceMessagesLimit(row(slug), null, {
        returnData: true,
      });
      expect(typeof check.limitReached).toBe("boolean");
    }
  });

  test("API: andere Felder speichern, Bestandswerte bleiben stehen", async () => {
    for (const slug of ["alt", "nur-dauer"]) {
      const before = billingOf(slug);
      const result = await apiUpdate({ name: `${slug} neu` }, slug);
      expect(result.statusCode).toBe(200);
      expect(row(slug).name).toBe(`${slug} neu`);
      expect(billingOf(slug)).toEqual(before);
    }
  });

  test("Oberfläche: Das Formular sendet die Bestandswerte unverändert mit - kein Fehler", async () => {
    const result = await sessionUpdate(
      admin,
      {
        name: "alt neu",
        messagesLimit: "-5",
        cycleStartDate: "1999-06-01",
        cycleDurationMonths: "5",
      },
      "alt"
    );
    expect(result.statusCode).toBe(200);
    expect(row("alt").name).toBe("alt neu");
    expect(billingOf("alt")).toEqual(ALT);

    // Dauer ohne Startdatum, unverändert zurückgesendet
    const onlyDuration = await sessionUpdate(
      admin,
      { messagesLimit: "250", cycleStartDate: "", cycleDurationMonths: "3" },
      "nur-dauer"
    );
    expect(onlyDuration.statusCode).toBe(200);
    expect(billingOf("nur-dauer")).toEqual({
      messagesLimit: 250,
      cycleStartDate: null,
      cycleDurationMonths: 3,
    });
  });

  // Die Abrechnungsansicht sendet vom Startdatum nur den UTC-Kalendertag
  // zurück (BillingAdminView.jsx, formatDateForInput).
  const formDay = (date) => date.toISOString().split("T")[0];

  test.each([
    // per API als Zeitstempel gesetzt
    ["1999-06-01T10:00:00.000Z", "1999-06-01"],
    // "2019-07-01T00:00:00+02:00": UTC-Tag und Berliner Tag fallen auseinander
    ["2019-06-30T22:00:00.000Z", "2019-06-30"],
    // mehr als 5 Jahre voraus
    ["2040-03-15T08:30:00.000Z", "2040-03-15"],
  ])(
    "Oberfläche: Altwert mit Uhrzeit (%s) - das Formular sendet nur den Tag, das Limit wird trotzdem gespeichert",
    async (storedIso, day) => {
      const stored = new Date(storedIso);
      seedWorkspace("alt-uhrzeit", {
        messagesLimit: 100,
        cycleStartDate: stored,
        cycleDurationMonths: 3,
      });
      expect(formDay(stored)).toBe(day);

      const result = await sessionUpdate(
        admin,
        {
          messagesLimit: "200",
          cycleStartDate: formDay(stored),
          cycleDurationMonths: "3",
        },
        "alt-uhrzeit"
      );

      expect(result.statusCode).toBe(200);
      expect(result.body.message).toBeNull();
      // Der gespeicherte Zeitpunkt bleibt stehen, er wird nicht auf 00:00 UTC
      // des Tages umgeschrieben.
      expect(billingOf("alt-uhrzeit")).toEqual({
        messagesLimit: 200,
        cycleStartDate: new Date(storedIso),
        cycleDurationMonths: 3,
      });
      expect(result.body.workspace.cycleStartDate).toBe(storedIso);
    }
  );

  test("Oberfläche: auch ein gültiger Startwert mit Uhrzeit bleibt stehen, wenn nur das Limit geändert wird", async () => {
    // "2026-09-01T00:00:00+02:00": Das Formular zeigt und sendet "2026-08-31".
    const stored = new Date("2026-08-31T22:00:00.000Z");
    seedWorkspace("mit-uhrzeit", {
      messagesLimit: 100,
      cycleStartDate: stored,
      cycleDurationMonths: 3,
    });
    const result = await sessionUpdate(
      admin,
      {
        messagesLimit: "200",
        cycleStartDate: formDay(stored),
        cycleDurationMonths: "3",
      },
      "mit-uhrzeit"
    );
    expect(result.statusCode).toBe(200);
    // nicht auf 00:00 UTC des 31.08. umgeschrieben: Der Zyklus beginnt weiter
    // am Berliner Tag 01.09.
    expect(billingOf("mit-uhrzeit")).toEqual({
      messagesLimit: 200,
      cycleStartDate: new Date("2026-08-31T22:00:00.000Z"),
      cycleDurationMonths: 3,
    });
  });

  test("Altwert mit Uhrzeit: ein anderer Tag oder eine andere Uhrzeit ist eine Änderung und wird geprüft", async () => {
    const stored = new Date("1999-06-01T10:00:00.000Z");
    seedWorkspace("alt-uhrzeit", {
      messagesLimit: 100,
      cycleStartDate: stored,
      cycleDurationMonths: 3,
    });
    for (const cycleStartDate of [
      "1999-06-02",
      "1999-05-31",
      "1999-06-01T00:00:00.000Z",
      "1999-06-01T11:00:00.000Z",
    ]) {
      const result = await sessionUpdate(
        admin,
        { messagesLimit: "200", cycleStartDate },
        "alt-uhrzeit"
      );
      expect(result.statusCode).toBe(400);
      expect(Object.keys(result.body.errors)).toEqual(["cycleStartDate"]);
    }
    expect(billingOf("alt-uhrzeit")).toEqual({
      messagesLimit: 100,
      cycleStartDate: stored,
      cycleDurationMonths: 3,
    });
  });

  test("validateBillingFields: der reine Tageswert eines Bestandswerts mit Uhrzeit gilt als unverändert", () => {
    const stored = new Date("1999-05-05T10:00:00.000Z");
    const current = {
      messagesLimit: 100,
      cycleStartDate: stored,
      cycleDurationMonths: 3,
    };
    expect(
      Workspace.validateBillingFields({ cycleStartDate: "1999-05-05" }, current)
    ).toEqual({
      values: { cycleStartDate: stored },
      errors: null,
      message: null,
    });
    // Auch als Zeichenkette aus der Datenbank gelesen
    expect(
      Workspace.validateBillingFields(
        { cycleStartDate: " 1999-05-05 " },
        { ...current, cycleStartDate: "1999-05-05T10:00:00.000Z" }
      ).errors
    ).toBeNull();
    expect(
      Workspace.validateBillingFields({ cycleStartDate: "1999-05-06" }, current)
        .errors
    ).toHaveProperty("cycleStartDate");
  });

  test("API: Bestandswerte unverändert zurückgesendet - kein Fehler", async () => {
    const result = await apiUpdate(
      {
        messagesLimit: -5,
        cycleStartDate: "1999-06-01T00:00:00.000Z",
        cycleDurationMonths: 5,
      },
      "alt"
    );
    expect(result.statusCode).toBe(200);
    expect(billingOf("alt")).toEqual(ALT);
  });

  test("ein Bestandswert lässt sich einzeln berichtigen", async () => {
    const result = await apiUpdate({ messagesLimit: 100 }, "alt");
    expect(result.statusCode).toBe(200);
    expect(billingOf("alt")).toEqual({ ...ALT, messagesLimit: 100 });
  });

  test("ein neuer ungültiger Wert wird auch hier abgelehnt", async () => {
    for (const body of [
      { messagesLimit: -6 },
      { cycleDurationMonths: 7 },
      { cycleStartDate: "1999-06-02" },
    ]) {
      const result = await apiUpdate(body, "alt");
      expect(result.statusCode).toBe(400);
    }
    expect(billingOf("alt")).toEqual(ALT);
  });
});
