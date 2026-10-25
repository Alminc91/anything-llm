/* eslint-env jest, node */
// KIE-576 Paket 3 (Fixliste r2b Nr. 2): Der Server prüft die Bezeichnung der
// Kursanzahl (visual_config.courseCountWord) beim Speichern aus dem Design
// Center (POST /embed/update/:embedId). Vertrag: ein Wort, nach trim 1 bis
// 20 UTF-16-Einheiten, Buchstaben, Bindestrich nur zwischen Buchstaben.
// Ungültig: HTTP 400 mit Meldung, nichts gespeichert; leer: Feld entfernt.
// Die Beispiele stehen in der Fixture des Vertrags (courseCountWords), die
// das Widget wortgleich prüft. Echte Route mit Middleware-Kette
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
const {
  COURSE_COUNT_WORD_ERROR,
  courseCountWordValue,
} = require("../../utils/chats/embedStandards");
const CONTRACT = require("../utils/chats/fixtures/embedConfigContract.json");
const {
  collectRoutes,
  invoke,
  setMultiUserMode,
  createUser,
} = require("./support/routeHarness");

const update = collectRoutes(embedManagementEndpoints)[
  "POST /embed/update/:embedId"
];
const STORED = { logoFilename: "logo.png", courseCountWord: "Seminare" };

let embed;
let admin;
beforeAll(() => jest.spyOn(console, "error").mockImplementation(() => {}));
afterAll(() => console.error.mockRestore());
beforeEach(() => {
  prisma.__reset();
  setMultiUserMode(prisma, true);
  const workspace = prisma.__seed("workspaces", { name: "A", slug: "a" });
  embed = prisma.__seed("embed_configs", {
    uuid: "uuid-a",
    enabled: true,
    chat_mode: "query",
    workspace_id: workspace.id,
    visual_config: JSON.stringify(STORED),
  });
  admin = createUser(prisma, "admin");
});

const save = (visualConfig) =>
  invoke(update, {
    params: { embedId: String(embed.id) },
    body: { visual_config: JSON.stringify(visualConfig) },
    token: admin.token,
  });
const stored = () =>
  JSON.parse(
    prisma.__rows("embed_configs").find((row) => row.id === embed.id)
      .visual_config
  );

test("Vertrag: Beispiele der Fixture (courseCountWords)", () => {
  expect(CONTRACT.courseCountWords.valid.length).toBeGreaterThan(0);
  expect(CONTRACT.courseCountWords.invalid.length).toBeGreaterThan(0);
  for (const [input, word] of CONTRACT.courseCountWords.valid)
    expect([input, courseCountWordValue(input)]).toEqual([input, word]);
  for (const input of CONTRACT.courseCountWords.invalid)
    expect([input, courseCountWordValue(input)]).toEqual([input, null]);
});

test.each(CONTRACT.courseCountWords.valid)(
  "gültig %j: gespeichert als %j",
  async (input, word) => {
    const result = await save({ ...STORED, courseCountWord: input });
    expect(result.statusCode).toBe(200);
    expect(result.body).toEqual({ success: true, error: null });
    expect(stored()).toEqual({ ...STORED, courseCountWord: word });
  }
);

test.each(CONTRACT.courseCountWords.invalid)(
  "ungültig %j: 400 mit Meldung, nichts gespeichert",
  async (input) => {
    const result = await save({
      logoFilename: "neu.png",
      courseCountWord: input,
    });
    expect(result.statusCode).toBe(400);
    expect(result.body).toEqual({
      success: false,
      error: COURSE_COUNT_WORD_ERROR,
    });
    expect(COURSE_COUNT_WORD_ERROR).toBe(
      "Bitte ein Wort aus Buchstaben, höchstens 20 Zeichen, etwa Seminare oder Online-Kurse."
    );
    expect(stored()).toEqual(STORED);
  }
);

test.each([
  ["leer", ""],
  ["nur Leerzeichen", "   "],
  ["null", null],
])("%s: Feld entfernt (Standard der Sprache)", async (_name, input) => {
  const result = await save({ ...STORED, courseCountWord: input });
  expect(result.statusCode).toBe(200);
  expect(stored()).toEqual({ logoFilename: "logo.png" });
});

test("kein Text (Zahl): 400, nichts gespeichert", async () => {
  const result = await save({ ...STORED, courseCountWord: 2 });
  expect(result.statusCode).toBe(400);
  expect(stored()).toEqual(STORED);
});

test("ohne Feld courseCountWord: visual_config unverändert wie gesendet", async () => {
  const body = JSON.stringify({ logoFilename: "neu.png" });
  const result = await invoke(update, {
    params: { embedId: String(embed.id) },
    body: { visual_config: body },
    token: admin.token,
  });
  expect(result.statusCode).toBe(200);
  expect(
    prisma.__rows("embed_configs").find((row) => row.id === embed.id)
      .visual_config
  ).toBe(body);
});
