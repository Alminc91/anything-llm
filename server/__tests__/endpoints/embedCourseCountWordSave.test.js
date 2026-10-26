/* eslint-env jest, node */
// KIE-576 Paket 3 (Fixliste r2b Nr. 2, r3 Nr. 4 und 5): Der Server prüft die
// Bezeichnung der Kursanzahl (visual_config.courseCountWord) auf jedem
// Schreibweg (validatedCreationData, hier POST /embed/update/:embedId und
// POST /embeds/new). Vertrag: ein Wort, nach NFC und trim 1 bis 20
// UTF-16-Einheiten, Buchstaben, Bindestrich nur zwischen Buchstaben.
// Gültig: in NFC und getrimmt gespeichert. Ungültig, leer oder kein Text:
// Feld verworfen, es gilt der Standard wie beim Lesen; der Rest wird
// gespeichert (r3-S1: ein ungültiger Altwert sperrt das Speichern nicht).
// Eine neu eingegebene ungültige Bezeichnung lehnt das Design Center mit
// Meldung ab (validateConfig). Die Beispiele stehen in der Fixture des
// Vertrags (courseCountWords), die das Widget wortgleich prüft. Echte Route
// mit Middleware-Kette (support/routeHarness.js), nur die Datenbank ist ein
// Ersatz im Speicher.
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
const { courseCountWordValue } = require("../../utils/chats/embedStandards");
const CONTRACT = require("../utils/chats/fixtures/embedConfigContract.json");
const {
  collectRoutes,
  invoke,
  setMultiUserMode,
  createUser,
} = require("./support/routeHarness");

const routes = collectRoutes(embedManagementEndpoints);
const update = routes["POST /embed/update/:embedId"];
const create = routes["POST /embeds/new"];
const STORED = { logoFilename: "logo.png", courseCountWord: "Seminare" };

let embed;
let admin;
let workspace;
beforeAll(() => jest.spyOn(console, "error").mockImplementation(() => {}));
afterAll(() => console.error.mockRestore());
beforeEach(() => {
  prisma.__reset();
  setMultiUserMode(prisma, true);
  workspace = prisma.__seed("workspaces", { name: "A", slug: "a" });
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
  "ungültig %j: verworfen (Standard), der Rest gespeichert",
  async (input) => {
    const result = await save({
      logoFilename: "neu.png",
      courseCountWord: input,
    });
    expect(result.statusCode).toBe(200);
    expect(result.body).toEqual({ success: true, error: null });
    expect(stored()).toEqual({ logoFilename: "neu.png" });
  }
);

test("r3-S1: ungültiger Altwert sperrt das Speichern nicht (reine Farbänderung)", async () => {
  const old = { ...STORED, courseCountWord: "Kurse am Abend" };
  prisma
    .__rows("embed_configs")
    .find((row) => row.id === embed.id).visual_config = JSON.stringify(old);
  const result = await save({ ...old, accentColor: "#123456" });
  expect(result.statusCode).toBe(200);
  expect(result.body).toEqual({ success: true, error: null });
  expect(stored()).toEqual({
    logoFilename: "logo.png",
    accentColor: "#123456",
  });
});

test("r3-S1: dieselbe Regel beim Anlegen (POST /embeds/new)", async () => {
  const send = (courseCountWord) =>
    invoke(create, {
      body: {
        workspace_id: String(workspace.id),
        chat_mode: "query",
        visual_config: JSON.stringify({
          logoFilename: "x.png",
          courseCountWord,
        }),
      },
      token: admin.token,
    });
  const row = (result) =>
    JSON.parse(
      prisma.__rows("embed_configs").find((r) => r.id === result.body.embed.id)
        .visual_config
    );
  const invalid = await send("Kurse 2026");
  expect(invalid.statusCode).toBe(200);
  expect(row(invalid)).toEqual({ logoFilename: "x.png" });
  const nfd = await send(" U\u0308bungen ");
  expect(row(nfd)).toEqual({
    logoFilename: "x.png",
    courseCountWord: "Übungen",
  });
});

test.each([
  ["leer", ""],
  ["nur Leerzeichen", "   "],
  ["null", null],
])("%s: Feld entfernt (Standard der Sprache)", async (_name, input) => {
  const result = await save({ ...STORED, courseCountWord: input });
  expect(result.statusCode).toBe(200);
  expect(stored()).toEqual({ logoFilename: "logo.png" });
});

test("kein Text (Zahl): verworfen, der Rest gespeichert", async () => {
  const result = await save({ ...STORED, courseCountWord: 2 });
  expect(result.statusCode).toBe(200);
  expect(stored()).toEqual({ logoFilename: "logo.png" });
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
