/* eslint-env jest, node */
// Admin-Endpunkt GET /embed/defaults?lang=de|en (Design Center): liefert die
// Widget-Standardtexte, nur mit Anmeldung — gleiche Middleware-Kette wie die
// übrigen Embed-Verwaltungsendpunkte (validatedRequest + flexUserRoleValid).
// Die echte Middleware läuft; Datenbank/JWT sind gemockt.

jest.mock("../../utils/prisma", () => ({}));
jest.mock("../../models/embedChats", () => ({ EmbedChats: {} }));
jest.mock("../../models/embedConfig", () => ({ EmbedConfig: {} }));
jest.mock("../../models/eventLogs", () => ({ EventLogs: {} }));
jest.mock("../../models/workspaceUsers", () => ({ WorkspaceUser: {} }));
jest.mock("../../models/systemSettings", () => ({
  SystemSettings: { isMultiUserMode: jest.fn() },
}));
jest.mock("../../models/user", () => ({ User: { get: jest.fn() } }));
jest.mock("../../utils/EncryptionManager", () => ({
  EncryptionManager: class {
    decrypt() {
      return null;
    }
  },
}));
jest.mock("../../utils/http", () => ({
  reqBody: jest.fn(),
  userFromSession: jest.fn(),
  decodeJWT: jest.fn(),
}));
jest.mock("../../utils/middleware/embedMiddleware", () => ({
  validEmbedConfigId: jest.fn(),
}));
jest.mock("../../utils/middleware/chatHistoryViewable", () => ({
  chatHistoryViewable: jest.fn(),
}));
jest.mock("../../utils/files/multer", () => ({
  handleEmbedLogoUpload: jest.fn(),
}));
jest.mock("../../utils/files/embedLogo", () => ({
  deleteOldEmbedLogo: jest.fn(),
}));

const { SystemSettings } = require("../../models/systemSettings");
const { User } = require("../../models/user");
const { decodeJWT } = require("../../utils/http");
const { validatedRequest } = require("../../utils/middleware/validatedRequest");
const { embedManagementEndpoints } = require("../../endpoints/embedManagement");
const { embedDefaultTexts } = require("../../utils/chats/embedDefaults");

// Fake-App: merkt sich je Route die vollständige Handler-Kette
function collectRoutes(register) {
  const routes = {};
  const app = new Proxy(
    {},
    {
      get: (_target, method) => (path, middlewares, handler) => {
        routes[`${String(method).toUpperCase()} ${path}`] = [
          ...middlewares,
          handler,
        ];
      },
    }
  );
  register(app);
  return routes;
}
const routes = collectRoutes(embedManagementEndpoints);

function mockResponse() {
  const res = {
    statusCode: 200,
    body: undefined,
    locals: {},
    status: jest.fn((code) => {
      res.statusCode = code;
      return res;
    }),
    sendStatus: jest.fn((code) => {
      res.statusCode = code;
      return res;
    }),
    json: jest.fn((body) => {
      res.body = body;
      return res;
    }),
    end: jest.fn(() => res),
  };
  return res;
}

// Express-artig: nächste Funktion nur, wenn next() gerufen wurde
async function runChain(chain, request) {
  const res = mockResponse();
  for (const fn of chain) {
    let nextCalled = false;
    await fn(request, res, () => {
      nextCalled = true;
    });
    if (!nextCalled) break;
  }
  return res;
}

function request({ token = null, lang } = {}) {
  return {
    query: lang === undefined ? {} : { lang },
    header: (name) =>
      name === "Authorization" && token ? `Bearer ${token}` : undefined,
  };
}

const chain = routes["GET /embed/defaults"];

beforeEach(() => {
  jest.clearAllMocks();
  SystemSettings.isMultiUserMode.mockResolvedValue(true);
  decodeJWT.mockImplementation((t) => (t === "gueltig" ? { id: 7 } : null));
  User.get.mockResolvedValue({ id: 7, role: "admin", suspended: 0 });
});

describe("GET /embed/defaults — Auth wie die übrigen Embed-Verwaltungsendpunkte", () => {
  test("gleiche Middleware-Kette (validatedRequest + Rollenprüfung) wie GET /embeds", () => {
    expect(chain).toHaveLength(3);
    expect(chain[0]).toBe(validatedRequest);
    expect(routes["GET /embeds"][0]).toBe(validatedRequest);
    expect(typeof chain[1]).toBe("function");
  });

  test("NAK-1: ohne Token 401, Handler läuft nicht", async () => {
    const res = await runChain(chain, request());
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: "No auth token found." });
  });

  test("NAK-1: ungültiges Token / unbekannter / gesperrter Nutzer -> 401", async () => {
    let res = await runChain(chain, request({ token: "kaputt" }));
    expect(res.statusCode).toBe(401);
    User.get.mockResolvedValue(null);
    res = await runChain(chain, request({ token: "gueltig" }));
    expect(res.statusCode).toBe(401);
    User.get.mockResolvedValue({ id: 7, role: "admin", suspended: 1 });
    res = await runChain(chain, request({ token: "gueltig" }));
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: "User is suspended from system" });
  });

  test("NAK-1: Nutzer ohne erlaubte Rolle -> 401", async () => {
    User.get.mockResolvedValue({ id: 7, role: "gast", suspended: 0 });
    const res = await runChain(chain, request({ token: "gueltig" }));
    expect(res.statusCode).toBe(401);
    expect(res.body).toBeUndefined();
  });

  test("AK-2: angemeldeter Admin bekommt die Standardtexte (de)", async () => {
    const res = await runChain(
      chain,
      request({ token: "gueltig", lang: "de" })
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ lang: "de", defaults: embedDefaultTexts("de") });
    expect(res.body.defaults.privacyTitle).toBe("Datenschutz:");
    expect(res.body.defaults.privacyText.split("\n")).toHaveLength(3);
  });

  test("AK-2: lang=en -> englisch; fehlend/unbekannt -> deutsch", async () => {
    let res = await runChain(chain, request({ token: "gueltig", lang: "en" }));
    expect(res.body.lang).toBe("en");
    expect(res.body.defaults.privacyTitle).toBe("Privacy:");
    for (const lang of [undefined, "fr", "<x>", ["en"]]) {
      res = await runChain(chain, request({ token: "gueltig", lang }));
      expect(res.statusCode).toBe(200);
      expect(res.body.lang).toBe("de");
    }
  });

  test("Single-User-Modus ohne AUTH_TOKEN: wie die übrigen Endpunkte offen", async () => {
    SystemSettings.isMultiUserMode.mockResolvedValue(false);
    const saved = process.env.AUTH_TOKEN;
    delete process.env.AUTH_TOKEN;
    const res = await runChain(chain, request({ lang: "de" }));
    if (saved !== undefined) process.env.AUTH_TOKEN = saved;
    expect(res.statusCode).toBe(200);
    expect(res.body.lang).toBe("de");
  });
});
