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
      ["yes", true],
      [" No ", false],
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

describe("GET /embed/:embedId/config — Leisten-Variante „Öffnen bei Klick“", () => {
  test("liefert inlineOpenOn, nicht die zurückgebauten Schlüssel (Schließen/Hinweis)", async () => {
    const res = await fetchConfig({
      inlineInput: true,
      inlineOpenOn: "focus",
      // Bestands-Werte aus der Zeit vor dem Rückbau: kein Fehler, nicht ausgeliefert
      inlineCloseOn: "leave",
      inlineResumeHint: true,
      inlineResumePlaceholder: "Weiter fragen …",
      inlineResumeText: "Unterhaltung fortsetzen",
      inlineRestartText: "Neu starten",
    });
    expect(res.statusCode).toBe(200);
    // toEqual ist streng: jeder zusätzliche Schlüssel ließe den Test scheitern
    expect(res.body).toEqual({ inlineInput: true, inlineOpenOn: "focus" });
  });

  test("inlineOpenOn: Enum, Groß-/Kleinschreibung egal", async () => {
    for (const openOn of ["submit", "focus", " Focus "]) {
      const res = await fetchConfig({ inlineOpenOn: openOn });
      expect(res.body).toEqual({ inlineOpenOn: openOn.trim().toLowerCase() });
    }
  });

  test("falscher Typ, leer oder unbekannter Wert wird weggelassen", async () => {
    for (const openOn of [1, "   ", "hover", null, ["focus"], { v: "focus" }]) {
      const res = await fetchConfig({ inlineOpenOn: openOn });
      expect(res.body).toEqual({});
    }
  });

  test("ohne den Schlüssel bleibt die Antwort wie bisher", async () => {
    const res = await fetchConfig({
      inlineInput: true,
      inlineLayout: "overlay",
    });
    expect(res.body).toEqual({ inlineInput: true, inlineLayout: "overlay" });
  });
});

describe("GET /embed/:embedId/config — Panel-Optik, Datenschutz- und KI-Hinweis", () => {
  const PANEL = {
    suggestionStyle: "pills",
    greetingStyle: "bubble",
    greetingBubbleText: "Hallo! Ich bin Ihr KI-Kursberater.",
    assistantSubtitle: "durchsucht 1.243 Kurse",
    onlineDot: true,
    privacyNotice: "modal",
    privacyTitle: "Datenschutz:",
    privacyText: "Läuft auf eigener Infrastruktur in Deutschland.\nKI-Hinweis",
    privacyButtonText: "Start",
    privacyUrl: "https://vhs.example/datenschutz",
    disclaimer: "footer",
    disclaimerText: "Ich bin eine KI und kann Fehler machen.",
  };

  test("liefert alle Schlüssel an das Widget", async () => {
    const res = await fetchConfig(PANEL);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(PANEL);
  });

  test("Enums: Groß-/Kleinschreibung egal, unbekannt oder falscher Typ weggelassen", async () => {
    const res = await fetchConfig({
      suggestionStyle: " Pills ",
      greetingStyle: "TEXT",
      privacyNotice: "None",
      disclaimer: " FOOTER",
    });
    expect(res.body).toEqual({
      suggestionStyle: "pills",
      greetingStyle: "text",
      privacyNotice: "none",
      disclaimer: "footer",
    });
    for (const notice of ["none", "bubble", "modal"]) {
      const r = await fetchConfig({ privacyNotice: notice });
      expect(r.body).toEqual({ privacyNotice: notice });
    }
    for (const v of ["chips", 1, null, ["pills"], "   "]) {
      const bad = await fetchConfig({
        suggestionStyle: v,
        greetingStyle: v,
        privacyNotice: v,
        disclaimer: v,
      });
      expect(bad.body).toEqual({});
    }
  });

  test("Texte: getrimmt, Höchstlängen wie im Widget, zu lang weggelassen", async () => {
    const ok = await fetchConfig({
      greetingBubbleText: ` ${"x".repeat(300)} `,
      assistantSubtitle: "y".repeat(60),
      privacyTitle: "t".repeat(120),
      // 5 Punkte à 160 Zeichen, Trenner "|" + 49 Leerzeichen -> Rohtext 1000
      privacyText: Array(5)
        .fill("z".repeat(160))
        .join(`|${" ".repeat(49)}`),
      privacyButtonText: "b".repeat(40),
      privacyUrl: `https://vhs.example/${"p".repeat(492)}`, // 512 Zeichen
      disclaimerText: "d".repeat(160),
    });
    expect(ok.body.greetingBubbleText).toHaveLength(300);
    expect(ok.body.assistantSubtitle).toHaveLength(60);
    expect(ok.body.privacyTitle).toHaveLength(120);
    expect(ok.body.privacyText).toBe(Array(5).fill("z".repeat(160)).join("\n"));
    expect(ok.body.privacyButtonText).toHaveLength(40);
    expect(ok.body.privacyUrl).toHaveLength(512);
    expect(ok.body.disclaimerText).toHaveLength(160);
    const tooLong = await fetchConfig({
      greetingBubbleText: "x".repeat(301),
      assistantSubtitle: "y".repeat(61),
      privacyTitle: "t".repeat(121),
      privacyText: Array(5)
        .fill("z".repeat(160))
        .join(`|${" ".repeat(50)}`),
      privacyButtonText: "b".repeat(41),
      privacyUrl: `https://vhs.example/${"p".repeat(493)}`, // 513 Zeichen
      disclaimerText: "d".repeat(161),
    });
    expect(tooLong.body).toEqual({});
  });

  test("onlineDot: Boolean bzw. Boolean-String, sonst weggelassen", async () => {
    expect((await fetchConfig({ onlineDot: false })).body).toEqual({
      onlineDot: false,
    });
    expect((await fetchConfig({ onlineDot: "on" })).body).toEqual({
      onlineDot: true,
    });
    for (const [input, expected] of [
      [true, true],
      ["yes", true],
      ["1", true],
      ["no", false],
      ["0", false],
      ["off", false],
      ["false", false],
    ]) {
      expect((await fetchConfig({ onlineDot: input })).body).toEqual({
        onlineDot: expected,
      });
    }
    for (const bad of ["vielleicht", "", 1, null]) {
      expect((await fetchConfig({ onlineDot: bad })).body).toEqual({});
    }
  });

  test("privacyUrl: nur https:// oder /pfad, ohne Leer-/Steuerzeichen", async () => {
    for (const url of ["https://vhs.example/datenschutz", "/datenschutz"]) {
      expect((await fetchConfig({ privacyUrl: url })).body).toEqual({
        privacyUrl: url,
      });
    }
    expect((await fetchConfig({ privacyUrl: " /datenschutz " })).body).toEqual({
      privacyUrl: "/datenschutz",
    });
    for (const bad of [
      "javascript:alert(1)",
      "http://vhs.example/datenschutz",
      "//evil.example/x",
      "/\\\\evil.example/x",
      "https://vhs.example/a\\\\b",
      "https://vhs.example/daten schutz",
      "/daten\tschutz",
      "datenschutz",
      "",
      42,
    ]) {
      expect((await fetchConfig({ privacyUrl: bad })).body).toEqual({});
    }
  });

  test("privacyText: Stichpunkte wie im Widget geprüft und normalisiert", async () => {
    expect((await fetchConfig({ privacyText: "a | b | c" })).body).toEqual({
      privacyText: "a\nb\nc",
    });
    expect(
      (await fetchConfig({ privacyText: " a\r\n\n | b \n" })).body
    ).toEqual({ privacyText: "a\nb" });
    expect(
      (await fetchConfig({ privacyText: "1|2|3|4|5" })).body.privacyText
    ).toBe("1\n2\n3\n4\n5");
    for (const bad of [
      "1|2|3|4|5|6", // 6 Punkte
      `ok|${"x".repeat(161)}`, // ein Punkt mit 161 Zeichen
      " | \n ", // nur leere Punkte
      42,
    ]) {
      expect((await fetchConfig({ privacyText: bad })).body).toEqual({});
    }
  });

  test("ohne die Schlüssel bleibt die Antwort wie bisher", async () => {
    const res = await fetchConfig({ inlineInput: true, theme: "dark" });
    expect(res.body).toEqual({ inlineInput: true, theme: "dark" });
  });
});

describe("GET /embed/:embedId/config — Folgefragen", () => {
  test("followUps: pills/none (Groß-/Kleinschreibung egal) werden geliefert", async () => {
    expect((await fetchConfig({ followUps: "pills" })).body).toEqual({
      followUps: "pills",
    });
    expect((await fetchConfig({ followUps: " PILLS " })).body).toEqual({
      followUps: "pills",
    });
    expect((await fetchConfig({ followUps: "none" })).body).toEqual({
      followUps: "none",
    });
  });

  test("ungültig oder falscher Typ wird weggelassen", async () => {
    for (const v of ["chips", "", 1, true, null, ["pills"], { v: "pills" }]) {
      expect((await fetchConfig({ followUps: v })).body).toEqual({});
    }
  });
});
