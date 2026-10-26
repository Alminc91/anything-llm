/* eslint-env jest, node */
// KB-3: Endpunkte der Status-Seite gegen die echten Routen mit ihrer ganzen
// Middleware-Kette (support/routeHarness.js), Bewertung echt
// (courseStatus.js, courseInventory.js), nur Datenbank und Dateien ersetzt.
//   AK-1  GET /embed/course-status?widget=<id>: Sitzung, Rollen admin,
//         manager, default; nur sichtbare Widgets, sonst 404 ohne Details.
//   AK-5  GET /embeds/course-status: nur der Zustand für den Menüpunkt.
//   AK-2  GET /v1/course-status: API-Schlüssel, je Workspace mit Kursliste.
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
const { __test__: inventory } = require("../../utils/chats/courseInventory");
const { __test__: status } = require("../../utils/chats/courseStatus");
const {
  collectRoutes,
  invoke,
  setMultiUserMode,
  createUser,
} = require("./support/routeHarness");

const routes = collectRoutes(embedManagementEndpoints);
const apiRoutes = collectRoutes(apiEmbedEndpoints);
const STATUS = routes["GET /embed/course-status"];
const MENU = routes["GET /embeds/course-status"];
const API = apiRoutes["GET /v1/course-status"];

const NOW = Date.parse("2026-10-26T10:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();

let workspaceA, workspaceB, embedA1, embedA2, embedB;
let history;
const docs = {};

const courseText = (number) =>
  [
    `Titel: Kurs ${number}`,
    `Kursnummer: ${number}`,
    `Kurs-Link: https://www.vhs-beispiel.de/kurs/${number}`,
    "",
    "Kursbeschreibung: Beschreibung.",
  ].join("\n");

function seedCourse(workspace, number) {
  const docId = `d-${number}`;
  const docpath = `custom-documents/${docId}.json`;
  docs[docpath] = { pageContent: courseText(number) };
  prisma.__seed("workspace_documents", {
    docId,
    filename: `${docId}.json`,
    docpath,
    workspaceId: workspace.id,
  });
  prisma.__seed("document_vectors", { docId, vectorId: `v-${docId}` });
}

function seedEmbed(workspace, visualConfig = {}) {
  return prisma.__seed("embed_configs", {
    uuid: `uuid-${workspace.slug}-${prisma.__rows("embed_configs").length}`,
    enabled: true,
    chat_mode: "query",
    workspace_id: workspace.id,
    visual_config: JSON.stringify(visualConfig),
  });
}

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
  for (const key of Object.keys(docs)) delete docs[key];
  inventory.reset();
  status.reset();
  history = null;
  inventory.setDeps({
    readDocumentText: async (docpath) => docs[docpath]?.pageContent ?? null,
    readDocument: async (docpath) => docs[docpath] ?? null,
    tableRows: async () => null,
    rowTexts: async () => [],
  });
  status.setDeps({
    readHistory: async () => history,
    writeHistory: async (value) => {
      history = value;
    },
  });
  setMultiUserMode(prisma, true);

  workspaceA = prisma.__seed("workspaces", { name: "VHS Beispiel", slug: "a" });
  workspaceB = prisma.__seed("workspaces", { name: "Dokubot", slug: "b" });
  embedA1 = seedEmbed(workspaceA);
  embedA2 = seedEmbed(workspaceA, { courseCountMode: "off" });
  embedB = seedEmbed(workspaceB);
  // A kennt 96 von 100 angebotenen Kursen (gelb), B hat keine Kurse
  for (let i = 1; i <= 96; i++) seedCourse(workspaceA, `262-${i}`);
  prisma.__seed("system_settings", {
    label: "kufer_course_inventory",
    value: JSON.stringify({
      version: 2,
      client: "vhs-beispiel",
      created: iso(NOW - HOUR),
      offered: Array.from({ length: 100 }, (_, i) => `262-${i + 1}`),
      titles: { "262-97": "Japanisch A1.1" },
      estimatedEnd: false,
      run: { at: iso(NOW - HOUR), result: "ok", cause: null },
    }),
  });
});

afterEach(() => {
  Date.now.mockRestore();
});

const statusOf = (widget, user) =>
  invoke(STATUS, { query: { widget: String(widget) }, token: user?.token });

describe("AK-1: GET /embed/course-status", () => {
  test.each(["admin", "manager"])(
    "%s: Bewertung des Kursprogramms mit Widgets und was Besucher sehen",
    async (role) => {
      const user = createUser(prisma, role);
      const res = await statusOf(embedA1.id, user);
      expect(res.statusCode).toBe(200);
      expect(Object.keys(res.body).sort()).toEqual(
        [
          "counts",
          "estimatedEnd",
          "hidden",
          "lastRun",
          "missing",
          "reason",
          "since",
          "state",
          "visitors",
          "whoActs",
          "widgets",
          "workspace",
        ].sort()
      );
      expect(res.body).toMatchObject({
        state: "gelb",
        reason: "fehlen",
        whoActs: "kufer",
        counts: { offered: 100, count: 96, missing: 4, hidden: 0 },
        workspace: { name: "VHS Beispiel" },
        widgets: [
          { id: embedA1.id, name: "VHS Beispiel" },
          { id: embedA2.id, name: "VHS Beispiel" },
        ],
        visitors: { count: 96, word: "Kurse" },
        lastRun: { at: iso(NOW - HOUR), result: "ok", cause: null },
      });
      expect(res.body.missing[0]).toEqual({
        knr: "262-97",
        title: "Japanisch A1.1",
      });
    }
  );

  test("Widget mit abgeschalteter Kursanzahl: Besucher sehen keine Zahl", async () => {
    const res = await statusOf(embedA2.id, createUser(prisma, "admin"));
    expect(res.body.visitors).toBeNull();
    expect(res.body.state).toBe("gelb");
  });

  test("default mit Mitgliedschaft im Workspace des Widgets", async () => {
    const user = createUser(prisma, "default", [workspaceA.id]);
    const res = await statusOf(embedA1.id, user);
    expect(res.statusCode).toBe(200);
    expect(res.body.state).toBe("gelb");
  });

  test.each([
    ["fremdes Widget (default ohne Mitgliedschaft)", () => embedA1.id],
    ["unbekanntes Widget", () => 999],
    ["keine Zahl", () => "abc"],
    ["0", () => 0],
    ["leer", () => ""],
  ])("%s: 404 ohne Details", async (_name, widget) => {
    const user = createUser(prisma, "default", [workspaceB.id]);
    const res = await statusOf(widget(), user);
    expect(res.statusCode).toBe(404);
    expect(res.body).toBeUndefined();
  });

  test("ohne Sitzung: abgelehnt", async () => {
    const res = await statusOf(embedA1.id, null);
    expect(res.statusCode).toBe(401);
    expect(res.body?.state).toBeUndefined();
  });

  test("Workspace ohne Kurse: nicht eingerichtet", async () => {
    const res = await statusOf(embedB.id, createUser(prisma, "admin"));
    expect(res.body).toMatchObject({
      state: "nicht_eingerichtet",
      counts: null,
      missing: [],
      hidden: [],
      widgets: [{ id: embedB.id, name: "Dokubot" }],
    });
  });

  test("NAK-3: liest nur; geschrieben wird allein der eigene Verlauf", async () => {
    const before = JSON.stringify(prisma.__rows("system_settings"));
    await statusOf(embedA1.id, createUser(prisma, "default", [workspaceA.id]));
    const after = prisma
      .__rows("system_settings")
      .filter((row) => row.label !== "kufer_course_status_history");
    expect(JSON.stringify(after)).toBe(
      JSON.stringify(
        JSON.parse(before).filter(
          (row) => row.label !== "kufer_course_status_history"
        )
      )
    );
    expect(Object.keys(JSON.parse(history))).toEqual(["a"]);
  });
});

describe("AK-5: GET /embeds/course-status", () => {
  test("nur der schlechteste Zustand der sichtbaren Widgets", async () => {
    const res = await invoke(MENU, {
      token: createUser(prisma, "admin").token,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ state: "gelb" });
  });

  test("default sieht nur die Widgets seiner Workspaces", async () => {
    const user = createUser(prisma, "default", [workspaceB.id]);
    const res = await invoke(MENU, { token: user.token });
    expect(res.body).toEqual({ state: "nicht_eingerichtet" });
  });

  test("ohne Sitzung: abgelehnt", async () => {
    const res = await invoke(MENU, {});
    expect(res.statusCode).toBe(401);
  });
});

describe("AK-2: GET /v1/course-status", () => {
  test("ohne gültigen API-Schlüssel: 403", async () => {
    expect((await invoke(API, {})).statusCode).toBe(403);
    expect((await invoke(API, { token: "falsch" })).statusCode).toBe(403);
  });

  test("je Workspace mit Kursliste dieselbe Bewertung, keine weiteren Kursdaten", async () => {
    prisma.__seed("api_keys", { secret: "geheim" });
    const res = await invoke(API, { token: "geheim" });
    expect(res.statusCode).toBe(200);
    expect(res.body.workspaces).toHaveLength(1);
    const [entry] = res.body.workspaces;
    expect(Object.keys(entry).sort()).toEqual(
      [
        "counts",
        "estimatedEnd",
        "hidden",
        "lastRun",
        "missing",
        "name",
        "reason",
        "since",
        "slug",
        "state",
        "whoActs",
        "widgets",
      ].sort()
    );
    expect(entry).toMatchObject({
      slug: "a",
      name: "VHS Beispiel",
      state: "gelb",
      widgets: [
        { id: embedA1.id, uuid: embedA1.uuid },
        { id: embedA2.id, uuid: embedA2.uuid },
      ],
      counts: { offered: 100, count: 96, missing: 4, hidden: 0 },
    });
    expect(entry.missing).toHaveLength(4);
    expect(JSON.stringify(res.body)).not.toContain("geheim");
  });
});
