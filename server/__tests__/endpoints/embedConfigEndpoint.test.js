/* eslint-env jest, node */
// Öffentlicher Endpunkt GET /embed/:embedId/config: Welche visual_config-
// Schlüssel gehen (validiert) an das Embed-Widget? Hier: Theme und die
// Inline-/Kurskarten-Schlüssel. Die Route wird an einer Fake-App registriert
// und direkt aufgerufen.

jest.mock("../../utils/prisma", () => ({}));
jest.mock("../../models/telemetry", () => ({
  Telemetry: { sendTelemetry: jest.fn() },
}));
jest.mock("../../utils/chats/embed", () => ({
  streamChatWithForEmbed: jest.fn(),
}));
jest.mock("../../models/embedChats", () => ({ EmbedChats: {} }));
jest.mock("../../utils/middleware/embedMiddleware", () => ({
  validEmbedConfig: jest.fn(),
  canRespond: jest.fn(),
  setConnectionMeta: jest.fn(),
}));
jest.mock("../../models/embedConfig", () => ({
  EmbedConfig: { getVisualConfig: jest.fn() },
}));
jest.mock("../../utils/files/embedLogo", () => ({
  fetchEmbedLogo: jest.fn(),
  determineEmbedLogoFilepath: jest.fn(),
}));
jest.mock("../../utils/helpers/chat/responses", () => ({
  convertToChatHistory: jest.fn(),
  writeResponseChunk: jest.fn(),
}));
jest.mock("../../utils/TextToSpeech", () => ({
  getTTSProvider: jest.fn(),
  isTTSConfigured: jest.fn(),
}));
jest.mock("../../utils/SpeechToText", () => ({
  getSTTProvider: jest.fn(),
  isSTTConfigured: jest.fn(),
}));

const { EmbedConfig } = require("../../models/embedConfig");
const { embeddedEndpoints } = require("../../endpoints/embed");

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

function mockResponse() {
  const res = {
    statusCode: 200,
    body: undefined,
    headers: {},
    locals: { embedConfig: { id: 1, uuid: "embed-uuid" } },
    status: jest.fn(function (code) {
      res.statusCode = code;
      return res;
    }),
    json: jest.fn(function (body) {
      res.body = body;
      return res;
    }),
    setHeader: jest.fn((key, value) => {
      res.headers[key] = value;
    }),
  };
  return res;
}

const configRoute =
  collectRoutes(embeddedEndpoints)["GET /embed/:embedId/config"];

async function fetchConfig(visualConfig) {
  EmbedConfig.getVisualConfig.mockResolvedValue(visualConfig);
  const res = mockResponse();
  await configRoute(
    {
      params: { embedId: "embed-uuid" },
      protocol: "https",
      get: () => "example.org",
    },
    res
  );
  return res;
}

beforeAll(() => {
  jest.spyOn(console, "error").mockImplementation(() => {});
});

afterAll(() => {
  console.error.mockRestore();
});

beforeEach(() => {
  jest.clearAllMocks();
});

describe("GET /embed/:embedId/config — Theme- und Inline-Schlüssel", () => {
  test("liefert gesetzte Schlüssel an das Widget", async () => {
    const res = await fetchConfig({
      theme: "dark",
      inlineInput: true,
      inlineInputPlaceholder: "  Stellen Sie hier Ihre Frage …  ",
      inlineSendText: "Chatten",
      courseCards: "auto",
      inlineLayout: "overlay",
      inlineEffect: "spring",
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      theme: "dark",
      inlineInput: true,
      inlineInputPlaceholder: "Stellen Sie hier Ihre Frage …",
      inlineSendText: "Chatten",
      courseCards: "auto",
      inlineLayout: "overlay",
      inlineEffect: "spring",
    });
  });

  test("theme: light/dark/auto, Groß-/Kleinschreibung egal", async () => {
    for (const [input, expected] of [
      ["light", "light"],
      ["auto", "auto"],
      [" Dark ", "dark"],
    ]) {
      const res = await fetchConfig({ theme: input });
      expect(res.body.theme).toBe(expected);
    }
  });

  test("ungültige Werte werden weggelassen", async () => {
    const res = await fetchConfig({
      theme: "blau",
      inlineInput: "true",
      inlineInputPlaceholder: "x".repeat(201),
      inlineSendText: "   ",
      courseCards: 1,
      inlineLayout: ["overlay"],
      inlineEffect: { name: "grow" },
    });
    expect(res.body).toEqual({});
  });

  test("theme als Zahl wird weggelassen", async () => {
    const res = await fetchConfig({ theme: 7 });
    expect(res.body).not.toHaveProperty("theme");
  });

  test("200 Zeichen sind erlaubt, false wird durchgereicht", async () => {
    const res = await fetchConfig({
      inlineSendText: "y".repeat(200),
      inlineInput: false,
    });
    expect(res.body.inlineSendText).toHaveLength(200);
    expect(res.body.inlineInput).toBe(false);
  });

  test("ohne die Schlüssel bleibt die Antwort wie bisher", async () => {
    const res = await fetchConfig({
      accentColor: "#FFA102",
      inlineTheme: "dark",
      displayMode: "inline",
    });
    expect(res.body).toEqual({
      buttonColor: "#FFA102",
      userBgColor: "#FFA102",
      linkColor: "#FFA102",
      inlineTheme: "dark",
      displayMode: "inline",
    });
  });
});

describe("GET /embed/:embedId/config — courseCardsPosition (Kurskarten v2)", () => {
  test("below/above wie theme: Enum, Groß-/Kleinschreibung egal", async () => {
    for (const [input, expected] of [
      ["below", "below"],
      ["above", "above"],
      [" Above ", "above"],
    ]) {
      const res = await fetchConfig({ courseCardsPosition: input });
      expect(res.statusCode).toBe(200);
      expect(res.body.courseCardsPosition).toBe(expected);
    }
  });

  test("ungültige Werte werden weggelassen", async () => {
    for (const input of ["oben", "", 1, true, ["above"], { v: "above" }]) {
      const res = await fetchConfig({ courseCardsPosition: input });
      expect(res.body).not.toHaveProperty("courseCardsPosition");
    }
  });

  test("zusammen mit courseCards ausgeliefert", async () => {
    const res = await fetchConfig({
      courseCards: "auto",
      courseCardsPosition: "above",
    });
    expect(res.body).toEqual({
      courseCards: "auto",
      courseCardsPosition: "above",
    });
  });
});
