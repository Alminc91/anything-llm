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
      inlineInput: "ja",
      inlineInputPlaceholder: "x".repeat(121),
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

  test("Höchstlängen wie im Widget, false wird durchgereicht", async () => {
    const res = await fetchConfig({
      inlineSendText: "y".repeat(40),
      inlineInputPlaceholder: "p".repeat(120),
      inlineInput: false,
    });
    expect(res.body.inlineSendText).toHaveLength(40);
    expect(res.body.inlineInputPlaceholder).toHaveLength(120);
    expect(res.body.inlineInput).toBe(false);
  });

  test("zu lange Texte werden weggelassen, nicht gekürzt", async () => {
    const res = await fetchConfig({
      inlineSendText: "y".repeat(41),
      inlineInputPlaceholder: "p".repeat(121),
      courseCards: "c".repeat(41),
    });
    expect(res.body).toEqual({});
  });

  test("inlineCollapsedText: getrimmt, 1–120 Zeichen", async () => {
    let res = await fetchConfig({ inlineCollapsedText: "  Fragen Sie uns  " });
    expect(res.body).toEqual({ inlineCollapsedText: "Fragen Sie uns" });
    res = await fetchConfig({ inlineCollapsedText: "t".repeat(120) });
    expect(res.body.inlineCollapsedText).toHaveLength(120);
    for (const input of ["t".repeat(121), "   ", 5, true]) {
      res = await fetchConfig({ inlineCollapsedText: input });
      expect(res.body).not.toHaveProperty("inlineCollapsedText");
    }
  });

  test("inlineInput: Strings wie im Widget als Boolean", async () => {
    for (const [input, expected] of [
      ["true", true],
      [" ON ", true],
      ["1", true],
      ["false", false],
      ["Off", false],
      ["0", false],
    ]) {
      const res = await fetchConfig({ inlineInput: input });
      expect(res.body.inlineInput).toBe(expected);
    }
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

describe("GET /embed/:embedId/config — Leisten-Varianten (Öffnen/Schließen/Hinweis)", () => {
  test("liefert inlineOpenOn, inlineCloseOn, inlineResumeHint, inlineResumePlaceholder", async () => {
    const res = await fetchConfig({
      inlineInput: true,
      inlineOpenOn: "focus",
      inlineCloseOn: "leave",
      inlineResumeHint: true,
      inlineResumePlaceholder: "  Weiter fragen …  ",
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      inlineInput: true,
      inlineOpenOn: "focus",
      inlineCloseOn: "leave",
      inlineResumeHint: true,
      inlineResumePlaceholder: "Weiter fragen …",
    });
  });

  test("false wird durchgereicht (Hinweis im Design Center abgeschaltet)", async () => {
    const res = await fetchConfig({ inlineResumeHint: false });
    expect(res.body).toEqual({ inlineResumeHint: false });
  });

  test("falscher Typ / leer / zu lang wird weggelassen", async () => {
    const res = await fetchConfig({
      inlineOpenOn: 1,
      inlineCloseOn: "   ",
      inlineResumeHint: "ja",
      inlineResumePlaceholder: "x".repeat(121),
    });
    expect(res.body).toEqual({});
  });

  test("inlineResumePlaceholder: 120 Zeichen sind erlaubt", async () => {
    const res = await fetchConfig({ inlineResumePlaceholder: "w".repeat(120) });
    expect(res.body.inlineResumePlaceholder).toHaveLength(120);
  });

  test("inlineResumeText/inlineRestartText: getrimmt, Grenzen 120/40", async () => {
    const res = await fetchConfig({
      inlineResumeText: "  Gespräch fortsetzen  ",
      inlineRestartText: "Neu beginnen",
    });
    expect(res.body.inlineResumeText).toBe("Gespräch fortsetzen");
    expect(res.body.inlineRestartText).toBe("Neu beginnen");
    const tooLong = await fetchConfig({
      inlineResumeText: "x".repeat(121),
      inlineRestartText: "y".repeat(41),
    });
    expect(tooLong.body).toEqual({});
  });

  test("inlineResumeHint: Strings wie im Widget als Boolean", async () => {
    for (const [input, expected] of [
      ["true", true],
      [" On ", true],
      ["1", true],
      ["false", false],
      ["OFF", false],
      ["0", false],
    ]) {
      const res = await fetchConfig({ inlineResumeHint: input });
      expect(res.body).toEqual({ inlineResumeHint: expected });
    }
    for (const input of ["", "yes", "wahr", 1, null, ["true"]]) {
      const res = await fetchConfig({ inlineResumeHint: input });
      expect(res.body).not.toHaveProperty("inlineResumeHint");
    }
  });

  test("inlineOpenOn/inlineCloseOn: Enum, Groß-/Kleinschreibung egal", async () => {
    for (const [openOn, closeOn] of [
      ["submit", "outside"],
      ["focus", "leave"],
      [" Focus ", " LEAVE "],
    ]) {
      const res = await fetchConfig({
        inlineOpenOn: openOn,
        inlineCloseOn: closeOn,
      });
      expect(res.body).toEqual({
        inlineOpenOn: openOn.trim().toLowerCase(),
        inlineCloseOn: closeOn.trim().toLowerCase(),
      });
    }
  });

  test("unbekannte Enum-Werte werden weggelassen", async () => {
    const res = await fetchConfig({
      inlineOpenOn: "hover",
      inlineCloseOn: "never",
    });
    expect(res.body).toEqual({});
    expect(res.body).not.toHaveProperty("inlineOpenOn");
    expect(res.body).not.toHaveProperty("inlineCloseOn");
  });

  test("ohne die Schlüssel bleibt die Antwort wie bisher", async () => {
    const res = await fetchConfig({
      inlineInput: true,
      inlineLayout: "overlay",
    });
    expect(res.body).toEqual({ inlineInput: true, inlineLayout: "overlay" });
  });
});
