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
  inventory.setDeps({
    readDocumentText: async (docpath) => docs[docpath]?.pageContent ?? null,
    readDocument: async (docpath) => docs[docpath] ?? null,
    tableRows: async () => null,
    rowTexts: async () => [],
  });
  setMultiUserMode(prisma, true);

  workspaceA = prisma.__seed("workspaces", { name: "VHS Beispiel", slug: "a" });
  workspaceB = prisma.__seed("workspaces", { name: "Dokubot", slug: "b" });
  embedA1 = seedEmbed(workspaceA);
  embedA2 = seedEmbed(workspaceA, { courseCountMode: "off" });
  embedB = seedEmbed(workspaceB);
  // A kennt 94 von 100 angebotenen Kursen (6 % fehlen: gelb), B hat keine
  for (let i = 1; i <= 94; i++) seedCourse(workspaceA, `262-${i}`);
  prisma.__seed("system_settings", {
    label: "kufer_course_inventory",
    value: JSON.stringify({
      version: 2,
      client: "vhs-beispiel",
      created: iso(NOW - HOUR),
      offered: Array.from({ length: 100 }, (_, i) => `262-${i + 1}`),
      titles: { "262-95": "Japanisch A1.1" },
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
          "details",
          "estimatedEnd",
          "headline",
          "hidden",
          "lastRun",
          "listApplied",
          "missing",
          "missingPercent",
          "reasons",
          "state",
          "syncedAt",
          "visitors",
          "widgets",
          "workspace",
        ].sort()
      );
      expect(res.body).toMatchObject({
        state: "gelb",
        headline: "unvollstaendig",
        details: ["unvollstaendig"],
        reasons: ["fehlen"],
        counts: { offered: 100, count: 94, missing: 6, hidden: 0 },
        missingPercent: 6,
        listApplied: true,
        workspace: { name: "VHS Beispiel" },
        widgets: [
          { id: embedA1.id, name: "VHS Beispiel" },
          { id: embedA2.id, name: "VHS Beispiel" },
        ],
        visitors: { count: 94, word: "Kurse" },
        lastRun: { at: iso(NOW - HOUR), result: "ok", cause: null },
      });
      expect(res.body.missing[0]).toEqual({
        knr: "262-95",
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

  test("NAK-3: liest nur, schreibt keine Einstellung (auch keinen Verlauf)", async () => {
    const before = JSON.stringify(prisma.__rows("system_settings"));
    await statusOf(embedA1.id, createUser(prisma, "default", [workspaceA.id]));
    await invoke(MENU, { token: createUser(prisma, "admin").token });
    expect(JSON.stringify(prisma.__rows("system_settings"))).toBe(before);
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
        "details",
        "estimatedEnd",
        "headline",
        "hidden",
        "lastRun",
        "listApplied",
        "missing",
        "missingPercent",
        "name",
        "reasons",
        "slug",
        "state",
        "syncedAt",
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
      headline: "unvollstaendig",
      details: ["unvollstaendig"],
      reasons: ["fehlen"],
      counts: { offered: 100, count: 94, missing: 6, hidden: 0 },
      missingPercent: 6,
      listApplied: true,
    });
    expect(entry.missing).toHaveLength(6);
    expect(JSON.stringify(res.body)).not.toContain("geheim");
  });
});

// Fixliste r2 Nr. 7 (F9): Workspaces ohne Widget (zum Beispiel ein Test-Klon
// mit denselben Kursen) bewertet die Entwickler-API nicht.
test("F9: GET /v1/course-status nur für Workspaces mit Widget", async () => {
  const clone = prisma.__seed("workspaces", { name: "Klon", slug: "c" });
  for (let i = 1; i <= 50; i++) seedCourse(clone, `262-${i}`);
  prisma.__seed("api_keys", { secret: "geheim" });
  const res = await invoke(API, { token: "geheim" });
  expect(res.statusCode).toBe(200);
  expect(res.body.workspaces.map((entry) => entry.slug)).toEqual(["a"]);
});

// Fixliste r2 Nr. 6 (F8): Ein Lesefehler im Statuspfad erscheint nicht als
// „nicht eingerichtet“. Alle drei Endpunkte antworten mit 500 ohne Details;
// die Seite zeigt dann ihren Ladefehlertext, der Menüpunkt keinen Punkt.
describe("Lesefehler (Fixliste r2 Nr. 6)", () => {
  beforeEach(() => {
    const findFirst = prisma.system_settings.findFirst;
    jest
      .spyOn(prisma.system_settings, "findFirst")
      .mockImplementation(async (args) => {
        if (args?.where?.label === "kufer_course_inventory")
          throw new Error("SQLITE_BUSY: database is locked");
        return findFirst(args);
      });
  });
  afterEach(() => {
    prisma.system_settings.findFirst.mockRestore();
  });

  test("Status-Seite: 500 ohne Details", async () => {
    const res = await statusOf(embedA1.id, createUser(prisma, "admin"));
    expect(res.statusCode).toBe(500);
    expect(res.body).toBeUndefined();
  });

  test("Menüpunkt: 500 ohne Details", async () => {
    const res = await invoke(MENU, {
      token: createUser(prisma, "admin").token,
    });
    expect(res.statusCode).toBe(500);
    expect(res.body).toBeUndefined();
  });

  test("Entwickler-API: 500 ohne Details", async () => {
    prisma.__seed("api_keys", { secret: "geheim" });
    const res = await invoke(API, { token: "geheim" });
    expect(res.statusCode).toBe(500);
    expect(res.body).toBeUndefined();
  });
});

// Fixliste r4 Nr. 4 (NF5): Ein Lesefehler bei einem Workspace verdeckt den
// Punkt der übrigen nicht. Die Entwickler-API bleibt bei 500, sonst verlöre
// ein still ausgelassener Workspace sein Rot.
describe("Lesefehler bei einem Workspace (Fixliste r4 Nr. 4)", () => {
  beforeEach(() => {
    // B bekommt Kurse, sein Index scheitert am Lesen der Dokumente
    for (let i = 1; i <= 3; i++) seedCourse(workspaceB, `262-${i}`);
    inventory.setDeps({
      readDocumentText: async (docpath) => docs[docpath]?.pageContent ?? null,
      readDocument: async (docpath) => docs[docpath] ?? null,
      tableRows: async () => null,
      rowTexts: async () => [],
      listDocuments: async (workspaceId) => {
        if (workspaceId === workspaceB.id) throw new Error("SQLITE_BUSY");
        return await prisma.workspace_documents.findMany({
          where: { workspaceId },
          select: { docId: true, docpath: true },
        });
      },
    });
  });

  test("Menüpunkt: der schlechteste lesbare Zustand, 500 nur ohne lesbaren Workspace; Entwickler-API 500", async () => {
    const res = await invoke(MENU, {
      token: createUser(prisma, "admin").token,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ state: "gelb" });

    const onlyBroken = createUser(prisma, "default", [workspaceB.id]);
    const broken = await invoke(MENU, { token: onlyBroken.token });
    expect(broken.statusCode).toBe(500);
    expect(broken.body).toBeUndefined();

    prisma.__seed("api_keys", { secret: "geheim" });
    expect((await invoke(API, { token: "geheim" })).statusCode).toBe(500);
  });
});
