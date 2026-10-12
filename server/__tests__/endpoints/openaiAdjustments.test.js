/* eslint-env jest, node */
// Prisma-Ersatz im Speicher für den Vertrags-Test der Kontingent-Abfrage
// (KIE-531, AK-8): Die echten Modelle und die echte Fensterberechnung laufen,
// nur die Datenbank ist ersetzt.
jest.mock("../../utils/prisma", () => {
  const rows = {
    workspace_chats: [],
    embed_chats: [],
    workspace_message_adjustments: [],
  };
  const inRange = (createdAt, range = {}) =>
    (range.gte === undefined || createdAt >= range.gte) &&
    (range.gt === undefined || createdAt > range.gt) &&
    (range.lt === undefined || createdAt < range.lt) &&
    (range.lte === undefined || createdAt <= range.lte);
  const adjustments = (where) =>
    rows.workspace_message_adjustments.filter(
      (row) =>
        row.workspaceId === where.workspaceId &&
        inRange(row.createdAt, where.createdAt)
    );
  return {
    __rows: rows,
    workspace_chats: {
      count: async ({ where }) =>
        rows.workspace_chats.filter(
          (row) =>
            row.workspaceId === where.workspaceId &&
            inRange(row.createdAt, where.createdAt)
        ).length,
    },
    embed_chats: {
      count: async ({ where }) =>
        rows.embed_chats.filter(
          (row) =>
            row.workspaceId === where.embed_config.workspace_id &&
            inRange(row.createdAt, where.createdAt)
        ).length,
    },
    workspace_message_adjustments: {
      aggregate: async ({ where }) => ({
        _sum: {
          amount: adjustments(where).reduce((sum, row) => sum + row.amount, 0),
        },
      }),
      count: async ({ where }) => adjustments(where).length,
      // Wie das Modell: neueste zuerst
      findMany: async ({ where }) =>
        adjustments(where).sort((a, b) => b.createdAt - a.createdAt),
    },
  };
});
jest.mock("../../models/workspace", () => ({
  Workspace: { get: jest.fn() },
}));
jest.mock("../../models/telemetry", () => ({
  Telemetry: { sendTelemetry: jest.fn() },
}));
jest.mock("../../models/eventLogs", () => ({
  EventLogs: { logEvent: jest.fn() },
}));
jest.mock("../../utils/middleware/validApiKey", () => ({
  validApiKey: jest.fn(),
}));
jest.mock("../../utils/chats/openaiCompatible", () => ({
  OpenAICompatibleChat: { chatSync: jest.fn(), streamChat: jest.fn() },
}));
jest.mock("../../endpoints/utils", () => ({
  getModelTag: jest.fn(() => "test-model"),
}));

const prisma = require("../../utils/prisma");
const { Workspace } = require("../../models/workspace");
const { apiOpenAICompatibleEndpoints } = require("../../endpoints/api/openai");
const {
  validateAdjustmentRequest,
} = require("../../endpoints/api/openai/helpers");

describe("validateAdjustmentRequest", () => {
  test("accepts a plain deduction", () => {
    const result = validateAdjustmentRequest({ amount: 250 });
    expect(result).toEqual({
      valid: true,
      error: null,
      amount: 250,
      reason: null,
    });
  });

  test("accepts a credit (negative amount) with reason", () => {
    const result = validateAdjustmentRequest({
      amount: -50,
      reason: "Storno Telefon-KI",
    });
    expect(result.valid).toBe(true);
    expect(result.amount).toBe(-50);
    expect(result.reason).toBe("Storno Telefon-KI");
  });

  test("rejects missing/empty bodies", () => {
    for (const body of [undefined, null, "x", 5, []]) {
      expect(validateAdjustmentRequest(body).valid).toBe(false);
    }
    const missing = validateAdjustmentRequest({});
    expect(missing.valid).toBe(false);
    expect(missing.error).toMatch(/required/);
  });

  test("rejects non-integer amounts including numeric strings", () => {
    for (const amount of ["250", 1.5, NaN, Infinity, true]) {
      const result = validateAdjustmentRequest({ amount });
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/integer/);
    }
  });

  test("rejects 0 with a hint about the sign convention", () => {
    const result = validateAdjustmentRequest({ amount: 0 });
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/positive amount to deduct/);
  });

  test("enforces the absolute cap from options", () => {
    expect(
      validateAdjustmentRequest({ amount: 1001 }, { maxAbsAmount: 1000 }).valid
    ).toBe(false);
    expect(
      validateAdjustmentRequest({ amount: 1000 }, { maxAbsAmount: 1000 }).valid
    ).toBe(true);
    expect(
      validateAdjustmentRequest({ amount: -1001 }, { maxAbsAmount: 1000 }).valid
    ).toBe(false);
  });

  test("enforces reason type and length", () => {
    expect(validateAdjustmentRequest({ amount: 1, reason: 42 }).valid).toBe(
      false
    );
    expect(
      validateAdjustmentRequest(
        { amount: 1, reason: "x".repeat(11) },
        { maxReasonLength: 10 }
      ).valid
    ).toBe(false);
    expect(
      validateAdjustmentRequest({ amount: 1, reason: "x".repeat(500) }).valid
    ).toBe(true);
  });

  test("normalizes empty-string reason to null", () => {
    const result = validateAdjustmentRequest({ amount: 5, reason: "" });
    expect(result.valid).toBe(true);
    expect(result.reason).toBeNull();
  });

  test("ignores unknown extra fields", () => {
    const result = validateAdjustmentRequest({ amount: 5, foo: "bar" });
    expect(result.valid).toBe(true);
  });
});

// ============================================================================
// KIE-531 / AK-8 — Vertrags-Test: Aufbau der Kontingent-Antwort
// ============================================================================

function collectRoutes(register) {
  const routes = {};
  const app = new Proxy(
    {},
    {
      get:
        (_target, method) =>
        (path, ...handlers) => {
          routes[`${String(method).toUpperCase()} ${path}`] =
            handlers[handlers.length - 1];
        },
    }
  );
  register(app);
  return routes;
}

async function call(handler, request) {
  let statusCode = 200;
  let body;
  const response = {
    status: (code) => {
      statusCode = code;
      return response;
    },
    json: (payload) => {
      // Wie über HTTP: Dates kommen als ISO-Zeichenkette beim Aufrufer an.
      body = JSON.parse(JSON.stringify(payload));
      return response;
    },
    end: () => response,
  };
  await handler(request, response);
  return { statusCode, body };
}

describe("Kontingent-Abfrage - Vertrag der API-Antwort (KIE-531, AK-8)", () => {
  const routes = collectRoutes(apiOpenAICompatibleEndpoints);
  const limits = routes["GET /v1/openai/workspace/:slug/limits"];
  const listAdjustments =
    routes["GET /v1/openai/workspace/:slug/limits/adjustments"];
  const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

  const cycleWorkspace = {
    id: 3,
    slug: "kufersql",
    name: "KuferSQL",
    messagesLimit: 600,
    cycleStartDate: new Date("2026-01-31"),
    cycleDurationMonths: 1,
  };

  function addRow(table, iso, extra = {}) {
    prisma.__rows[table].push({
      workspaceId: 3,
      createdAt: new Date(iso),
      ...extra,
    });
  }

  beforeEach(() => {
    for (const table of Object.values(prisma.__rows)) table.length = 0;
    // 20.03.2026 10:00 Uhr Berliner Zeit, Zyklus 28.02. bis 30.03.
    jest.useFakeTimers().setSystemTime(new Date("2026-03-20T10:00:00+01:00"));
    jest.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test("Routen sind registriert", () => {
    expect(typeof limits).toBe("function");
    expect(typeof listAdjustments).toBe("function");
  });

  test("Workspace mit Zyklus: Feldnamen und -typen wie zuvor, currentCycleEnd ist der letzte Tag", async () => {
    Workspace.get.mockResolvedValue(cycleWorkspace);
    addRow("workspace_chats", "2026-02-27T23:59:59+01:00"); // Vorzyklus
    addRow("workspace_chats", "2026-02-28T00:00:00+01:00");
    addRow("embed_chats", "2026-03-19T12:00:00+01:00");
    addRow("workspace_message_adjustments", "2026-03-01T08:00:00+01:00", {
      amount: 10,
    });

    const { statusCode, body } = await call(limits, {
      params: { slug: "kufersql" },
    });

    expect(statusCode).toBe(200);
    expect(Object.keys(body).sort()).toEqual(
      [
        "workspace_slug",
        "workspace_name",
        "messageCount",
        "messagesLimit",
        "messagesRemaining",
        "contingent",
        "adjustmentsTotal",
        "messages_limit",
        "unlimited",
        "limitReached",
        "cycleInfo",
      ].sort()
    );
    expect(body).toMatchObject({
      workspace_slug: "kufersql",
      workspace_name: "KuferSQL",
      messageCount: 12,
      messagesLimit: 600,
      messagesRemaining: 588,
      contingent: "12/600",
      adjustmentsTotal: 10,
      messages_limit: 600,
      unlimited: false,
      limitReached: false,
    });

    const { cycleInfo } = body;
    expect(Object.keys(cycleInfo).sort()).toEqual(
      [
        "cycleNumber",
        "cycleDurationMonths",
        "currentCycleStart",
        "currentCycleEnd",
        "nextReset",
        "daysRemaining",
      ].sort()
    );
    expect(typeof cycleInfo.cycleNumber).toBe("number");
    expect(typeof cycleInfo.cycleDurationMonths).toBe("number");
    expect(typeof cycleInfo.daysRemaining).toBe("number");
    for (const field of ["currentCycleStart", "currentCycleEnd", "nextReset"]) {
      expect(typeof cycleInfo[field]).toBe("string");
      expect(cycleInfo[field]).toMatch(ISO_TIMESTAMP);
    }

    // Start 31.01.: Zyklus 2 läuft vom 28.02. bis einschließlich 30.03.,
    // der nächste Reset ist der 31.03. (nicht der 28.03.).
    expect(cycleInfo).toEqual({
      cycleNumber: 2,
      cycleDurationMonths: 1,
      currentCycleStart: "2026-02-28T00:00:00.000Z",
      currentCycleEnd: "2026-03-30T00:00:00.000Z",
      nextReset: "2026-03-31T00:00:00.000Z",
      daysRemaining: 11,
    });
    // currentCycleEnd ist der Tag vor dem nächsten Reset.
    expect(
      new Date(cycleInfo.nextReset) - new Date(cycleInfo.currentCycleEnd)
    ).toBe(24 * 60 * 60 * 1000);
  });

  test("Workspace ohne Zyklus: cycleInfo bleibt null, gezählt wird der Berliner Kalendermonat", async () => {
    Workspace.get.mockResolvedValue({
      id: 3,
      slug: "kufersql",
      name: "KuferSQL",
      messagesLimit: null,
    });
    addRow("workspace_chats", "2026-02-28T23:59:59+01:00"); // Februar
    addRow("workspace_chats", "2026-03-01T00:00:00+01:00");

    const { body } = await call(limits, { params: { slug: "kufersql" } });
    expect(body.cycleInfo).toBeNull();
    expect(body.messageCount).toBe(1);
    expect(body.messagesLimit).toBeNull();
    expect(body.messagesRemaining).toBeNull();
    expect(body.unlimited).toBe(true);
    expect(body.limitReached).toBe(false);
    expect(body.contingent).toBe("1/Unlimited");
  });

  test("Zyklusstart in der Zukunft: wie ohne Zyklus, cycleInfo null", async () => {
    Workspace.get.mockResolvedValue({
      ...cycleWorkspace,
      cycleStartDate: new Date("2026-06-01"),
    });
    addRow("workspace_chats", "2026-03-05T09:00:00+01:00");

    const { body } = await call(limits, { params: { slug: "kufersql" } });
    expect(body.cycleInfo).toBeNull();
    expect(body.messageCount).toBe(1);
    expect(body.messagesLimit).toBe(600);
  });

  test("unbekannter Workspace: 404 wie zuvor", async () => {
    Workspace.get.mockResolvedValue(null);
    const { statusCode, body } = await call(limits, {
      params: { slug: "gibt-es-nicht" },
    });
    expect(statusCode).toBe(404);
    expect(body).toEqual({ error: "Workspace not found." });
  });

  test("Buchungsliste mit currentCycle=true nutzt dasselbe halboffene Fenster wie die Zählung", async () => {
    Workspace.get.mockResolvedValue(cycleWorkspace);
    addRow("workspace_message_adjustments", "2026-02-27T23:59:59.999+01:00", {
      id: 1,
      amount: 500,
    });
    // Genau auf dem Fensterstart (28.02. 00:00 Uhr Berliner Zeit): gehört dazu.
    addRow("workspace_message_adjustments", "2026-02-28T00:00:00+01:00", {
      id: 5,
      amount: 7,
    });
    addRow("workspace_message_adjustments", "2026-02-28T00:30:00+01:00", {
      id: 2,
      amount: 10,
    });
    addRow("workspace_message_adjustments", "2026-03-30T23:59:59.999+02:00", {
      id: 3,
      amount: -4,
    });
    addRow("workspace_message_adjustments", "2026-03-31T00:00:00+02:00", {
      id: 4,
      amount: 900,
    });

    const current = await call(listAdjustments, {
      params: { slug: "kufersql" },
      query: { currentCycle: "true" },
    });
    expect(current.statusCode).toBe(200);
    expect(current.body.adjustments.map((row) => row.id)).toEqual([3, 2, 5]);
    expect(current.body.totalCount).toBe(3);
    expect(current.body.adjustmentsTotal).toBe(13);
    expect(current.body.currentCycle).toBe(true);

    // Die Kontingent-Abfrage nennt für dasselbe Fenster dieselbe Summe.
    const { body } = await call(limits, { params: { slug: "kufersql" } });
    expect(body.adjustmentsTotal).toBe(13);

    const all = await call(listAdjustments, {
      params: { slug: "kufersql" },
      query: {},
    });
    expect(all.body.totalCount).toBe(5);
  });
});
