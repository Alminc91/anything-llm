/* eslint-env jest, node */
// KIE-576 Paket 3: GET /embed/defaults?embedId=<id> liefert dem Design Center
// zusätzlich courseInventory für die Vorschau, seit Fixliste r4 Nr. 2 und 3
// nur noch {count} (die Vorschau zeigt nur die Zahl; angeboten,
// ausgeblendet und Stand bleiben intern). Kein neuer
// Endpunkt, nur lesend; nur für ein Widget, das der Nutzer verwalten darf
// (wie validEmbedAccess), sonst fehlt das Feld und die Standardtexte kommen
// trotzdem. Die Middleware-Kette prüft
// embedDefaultsEndpoint.test.js; hier der Handler selbst.

jest.mock("../../utils/prisma", () => ({}));
jest.mock("../../models/embedChats", () => ({ EmbedChats: {} }));
jest.mock("../../models/embedConfig", () => ({
  EmbedConfig: { get: jest.fn(), getWithWorkspace: jest.fn() },
}));
jest.mock("../../models/eventLogs", () => ({ EventLogs: {} }));
jest.mock("../../models/workspaceUsers", () => ({
  WorkspaceUser: { get: jest.fn() },
}));
jest.mock("../../models/systemSettings", () => ({
  SystemSettings: { isMultiUserMode: jest.fn() },
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
jest.mock("../../utils/chats/courseInventory", () => ({
  courseInventoryStatus: jest.fn(),
}));

const { EmbedConfig } = require("../../models/embedConfig");
const { WorkspaceUser } = require("../../models/workspaceUsers");
const { userFromSession } = require("../../utils/http");
const { courseInventoryStatus } = require("../../utils/chats/courseInventory");
const { embedManagementEndpoints } = require("../../endpoints/embedManagement");
const { embedDefaultTexts } = require("../../utils/chats/embedDefaults");

const routes = {};
embedManagementEndpoints(
  new Proxy(
    {},
    {
      get: (_target, method) => (path, middlewares, handler) => {
        routes[`${String(method).toUpperCase()} ${path}`] = handler;
      },
    }
  )
);
const handler = routes["GET /embed/defaults"];

async function call(query) {
  const res = {
    statusCode: 200,
    body: undefined,
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
  await handler({ query }, res);
  return res;
}

const STATUS = {
  count: 812,
  offered: 837,
  hidden: 14,
  stand: "2026-10-24T08:00:00.000Z",
};

beforeEach(() => {
  jest.clearAllMocks();
  userFromSession.mockResolvedValue({ id: 7, role: "admin" });
  EmbedConfig.get.mockResolvedValue({ id: 5, workspace_id: 9 });
  EmbedConfig.getWithWorkspace.mockResolvedValue({
    id: 5,
    workspace_id: 9,
    workspace: { id: 9, slug: "kurse" },
  });
  courseInventoryStatus.mockResolvedValue(STATUS);
});

test("ohne embedId wie bisher: nur Sprache und Standardtexte", async () => {
  const res = await call({ lang: "de" });
  expect(res.statusCode).toBe(200);
  expect(res.body).toEqual({ lang: "de", defaults: embedDefaultTexts("de") });
  expect(courseInventoryStatus).not.toHaveBeenCalled();
});

test("mit embedId: courseInventory des Workspace des Widgets, nur count", async () => {
  const res = await call({ lang: "de", embedId: "5" });
  expect(res.body).toEqual({
    lang: "de",
    defaults: embedDefaultTexts("de"),
    courseInventory: { count: 812 },
  });
  expect(Object.keys(res.body.courseInventory)).toEqual(["count"]);
  expect(EmbedConfig.getWithWorkspace).toHaveBeenCalledWith({ id: 5 });
  expect(courseInventoryStatus).toHaveBeenCalledWith({ id: 9, slug: "kurse" });
});

test("ohne gültigen Kursbestand: courseInventory null (Vorschau mit Beispielzahl)", async () => {
  courseInventoryStatus.mockResolvedValue(null);
  const res = await call({ lang: "de", embedId: "5" });
  expect(res.body.courseInventory).toBeNull();
});

test("Default-Nutzer ohne Zugriff auf den Workspace: kein Feld, Standardtexte trotzdem", async () => {
  userFromSession.mockResolvedValue({ id: 8, role: "default" });
  WorkspaceUser.get.mockResolvedValue(null);
  const res = await call({ lang: "de", embedId: "5" });
  expect(res.statusCode).toBe(200);
  expect(res.body).toEqual({ lang: "de", defaults: embedDefaultTexts("de") });
  expect(courseInventoryStatus).not.toHaveBeenCalled();
});

test("Default-Nutzer mit Zugriff: courseInventory", async () => {
  userFromSession.mockResolvedValue({ id: 8, role: "default" });
  WorkspaceUser.get.mockResolvedValue({ id: 1 });
  const res = await call({ lang: "de", embedId: "5" });
  expect(res.body.courseInventory).toEqual({ count: 812 });
});

test.each([["abc"], ["-1"], ["0"], ["1.5"], [""]])(
  "embedId %j: kein Feld, kein Nachschlag",
  async (embedId) => {
    const res = await call({ lang: "de", embedId });
    expect(res.body).not.toHaveProperty("courseInventory");
    expect(EmbedConfig.getWithWorkspace).not.toHaveBeenCalled();
  }
);

test("unbekanntes Widget: kein Feld", async () => {
  EmbedConfig.getWithWorkspace.mockResolvedValue(null);
  const res = await call({ lang: "de", embedId: "77" });
  expect(res.body).not.toHaveProperty("courseInventory");
});
