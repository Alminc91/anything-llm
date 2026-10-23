/* eslint-env jest, node */
// KIE-576 S1: SystemSetting kufer_category_map (Kategorie-Karte der Pipeline).
// Validator (JSON, version 1, höchstens 2 MB, sonst abgelehnt) greift in
// _updateSettings, dem Schreibweg der Pipeline (docker exec). R1-D6: nicht
// über HTTP schreibbar (nicht in supportedFields, updateSettings verwirft das
// Label) und kein Ausgabeweg: nicht in publicFields (einzige generische
// Ausgabe /admin/system-preferences-for), kein Endpunkt nennt das Label.

const fs = require("fs");
const path = require("path");

jest.mock("../../utils/prisma", () => ({
  system_settings: { upsert: jest.fn(), findFirst: jest.fn() },
}));

const prisma = require("../../utils/prisma");
const { SystemSettings } = require("../../models/systemSettings");

const LABEL = "kufer_category_map";
const MAP = JSON.stringify({
  version: 1,
  client: "vhs-beispiel",
  created: "2026-10-22T21:00:00Z",
  nodes: {
    Sport: {
      title: "Sport",
      url: "https://www.vhs-beispiel.de/sport",
      count: 4,
    },
  },
  courses: {},
});

beforeEach(() => {
  jest.clearAllMocks();
  prisma.system_settings.upsert.mockResolvedValue({});
});

describe("Whitelist und Validator", () => {
  test("R1-D6: nicht über HTTP schreibbar (supportedFields), nie öffentlich (publicFields)", () => {
    expect(SystemSettings.supportedFields).not.toContain(LABEL);
    expect(SystemSettings.publicFields).not.toContain(LABEL);
  });

  test("R1-D6: updateSettings (Weg der HTTP-Endpunkte) schreibt die Karte nicht", async () => {
    const result = await SystemSettings.updateSettings({ [LABEL]: MAP });
    expect(result).toEqual({ success: true, error: null });
    expect(prisma.system_settings.upsert).not.toHaveBeenCalled();
  });

  test("gültige Karte wird über _updateSettings unverändert gespeichert", async () => {
    const result = await SystemSettings._updateSettings({ [LABEL]: MAP });
    expect(result).toEqual({ success: true, error: null });
    expect(prisma.system_settings.upsert).toHaveBeenCalledWith({
      where: { label: LABEL },
      update: { value: MAP },
      create: { label: LABEL, value: MAP },
    });
  });

  test("K2: Karte mit updated und unbekanntem Feld wird unverändert gespeichert", async () => {
    const value = MAP.replace(
      '"courses":{}',
      '"courses":{},"updated":"2026-10-23T07:00:00Z","neu":true'
    );
    const result = await SystemSettings._updateSettings({ [LABEL]: value });
    expect(result).toEqual({ success: true, error: null });
    expect(prisma.system_settings.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: { value } })
    );
  });

  test("leerer Wert leert die Karte (null)", async () => {
    const result = await SystemSettings._updateSettings({ [LABEL]: "" });
    expect(result).toEqual({ success: true, error: null });
    expect(prisma.system_settings.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: { value: null } })
    );
  });

  test.each([
    ["kein JSON", "{"],
    ["version 2", MAP.replace('"version":1', '"version":2')],
    [
      "größer als 2 MB",
      MAP.replace(
        '"courses":{}',
        `"courses":{},"pad":"${"x".repeat(2 * 1024 * 1024)}"`
      ),
    ],
  ])(
    "%s: abgelehnt, nichts geschrieben, Fehler an den Aufrufer",
    async (_name, value) => {
      jest.spyOn(console, "error").mockImplementation(() => {});
      const result = await SystemSettings._updateSettings({ [LABEL]: value });
      console.error.mockRestore();
      expect(result.success).toBe(false);
      expect(result.error).toMatch(LABEL);
      expect(prisma.system_settings.upsert).not.toHaveBeenCalled();
    }
  );
});

describe("kein Ausgabeweg für die Karte", () => {
  const serverRoot = path.resolve(__dirname, "../..");
  const jsFiles = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory())
        return ["node_modules", "__tests__", "storage"].includes(entry.name)
          ? []
          : jsFiles(full);
      return entry.name.endsWith(".js") ? [full] : [];
    });

  test("das Label steht nur im Modell und im Lesemodul der Kette", () => {
    const users = jsFiles(serverRoot)
      .filter((file) => fs.readFileSync(file, "utf8").includes(LABEL))
      .map((file) => path.relative(serverRoot, file))
      .sort();
    expect(users).toEqual([
      path.join("models", "systemSettings.js"),
      path.join("utils", "chats", "embedCategoryChains.js"),
    ]);
  });

  test("K2: der Stand der Karte (categoryMapUpdatedAt) wird nirgends ausgegeben", () => {
    const users = jsFiles(serverRoot)
      .filter((file) =>
        fs.readFileSync(file, "utf8").includes("categoryMapUpdatedAt")
      )
      .map((file) => path.relative(serverRoot, file));
    expect(users).toEqual([
      path.join("utils", "chats", "embedCategoryChains.js"),
    ]);
  });

  test("/admin/system-preferences-for gibt die Karte nicht aus", async () => {
    jest.resetModules();
    jest.doMock("../../utils/prisma", () => ({
      system_settings: {
        findFirst: jest.fn(async ({ where }) => ({
          label: where.label,
          value: where.label === LABEL ? MAP : "hilfe@vhs-test.de",
        })),
      },
    }));
    const { adminEndpoints } = require("../../endpoints/admin");
    const routes = {};
    const app = new Proxy(
      {},
      {
        get: (_target, method) => (route, middlewares, handler) => {
          routes[`${String(method).toUpperCase()} ${route}`] = handler;
        },
      }
    );
    adminEndpoints(app);
    const handler = routes["GET /admin/system-preferences-for"];
    expect(typeof handler).toBe("function");
    const response = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
      sendStatus: jest.fn().mockReturnThis(),
      end: jest.fn(),
    };
    await handler({ query: { labels: `${LABEL},support_email` } }, response);
    const sent = JSON.stringify(response.json.mock.calls);
    expect(sent).not.toContain(LABEL);
    expect(sent).not.toContain("vhs-beispiel");
    // Gegenprobe: ein öffentliches Feld kommt mit demselben Datenbank-Ersatz durch
    expect(response.json).toHaveBeenCalledWith({
      settings: { support_email: "hilfe@vhs-test.de" },
    });
  });
});
