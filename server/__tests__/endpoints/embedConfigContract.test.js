/* eslint-env jest, node */
// Vertrag Fork und Widget für GET /embed/:id/config (Fixliste 7.22-rc13,
// Entscheidungen E10 bis E12; Vorrang nach E10 neu und E23, Fixliste
// 7.22-rc17): Startvorschläge und Willkommensblasen als JSON-Array, ein
// gespeichertes [] mit defaultMessagesSaved, der Standard der Sprache mit
// defaultMessagesStandard, die Sprache aus ?language=. Im Widget gilt
// gespeichert vor Standard; Skript-Attribute dazu wirken nicht. Die Fälle
// stehen in __tests__/utils/chats/fixtures/embedConfigContract.json, einer
// wortgleichen Kopie von tests/fixtures/embedConfigContract.json im
// Widget-Repo (dort prüft tests/embed-config-contract.test.js die
// Widget-Seite: Abruf mit ?language= und Auflösung samt Skript-Attributen).
// Hier die Server-Seite: visualConfig und Sprache ergeben die Schlüssel in
// config; configAbsent fehlen. Fälle mit fork: false gelten nur dem Widget
// (älterer Server).
//
// Aufruf wie das Widget (F01, Review 7.22-rc12): Die Route hängt wie im
// Betrieb unter /api an einem echten Express-Router, der Test ruft sie per
// HTTP mit der Adresse auf, die das Widget baut (embedConfigUrl:
// `${baseApiUrl}/${embedId}/config?language=…`). So kommt die Sprache durch
// das Parsen der Adresse, nicht als eingesetztes request.query.

jest.mock("../../utils/prisma", () => ({}));
jest.mock("../../models/telemetry", () => ({
  Telemetry: { sendTelemetry: jest.fn() },
}));
jest.mock("../../utils/chats/embed", () => ({
  streamChatWithForEmbed: jest.fn(),
}));
jest.mock("../../models/embedChats", () => ({ EmbedChats: {} }));
// Middleware wie im Betrieb: die Zeile des Widgets steht danach in
// response.locals.embedConfig (hier mit der gespeicherten visual_config des
// Falls)
jest.mock("../../utils/middleware/embedMiddleware", () => ({
  validEmbedConfig: jest.fn((request, response, next) => {
    response.locals.embedConfig = {
      id: 1,
      uuid: request.params.embedId,
      visual_config: JSON.stringify(globalThis.__embedVisualConfig ?? {}),
    };
    next();
  }),
  canRespond: jest.fn((_request, _response, next) => next()),
  setConnectionMeta: jest.fn((_request, _response, next) => next()),
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

const fs = require("fs");
const http = require("http");
const path = require("path");
const express = require("express");
const { embeddedEndpoints } = require("../../endpoints/embed");
const { DEFAULT_SUGGESTIONS } = require("../../utils/chats/embedDefaults");
const CONTRACT = require("../utils/chats/fixtures/embedConfigContract.json");

// Kennzeichen der Startvorschläge
const FLAGS = ["defaultMessagesSaved", "defaultMessagesStandard"];

const EMBED_ID = "78eda2c6-5bd0-44b5-b097-30d694a56677";
let server;
let baseApiUrl;

beforeAll(async () => {
  jest.spyOn(console, "error").mockImplementation(() => {});
  const app = express();
  const apiRouter = express.Router();
  app.use("/api", apiRouter);
  embeddedEndpoints(apiRouter);
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  // wie data-base-api-url im Einbau-Schnipsel (EmbedTab embedScriptSnippet)
  baseApiUrl = `http://127.0.0.1:${server.address().port}/api/embed`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  console.error.mockRestore();
  delete globalThis.__embedVisualConfig;
});

/**
 * GET /config wie das Widget: Adresse aus baseApiUrl und embedId, die
 * Sprache als ?language= (E12); ohne Sprache ohne Query.
 */
async function widgetFetch(visualConfig, language) {
  globalThis.__embedVisualConfig = visualConfig;
  const query =
    language === null || language === undefined
      ? ""
      : `?language=${encodeURIComponent(language)}`;
  const res = await fetch(`${baseApiUrl}/${EMBED_ID}/config${query}`);
  return { status: res.status, body: await res.json() };
}

const forkCases = CONTRACT.cases.filter((c) => c.fork !== false);

describe("Vertrag /config (E10 bis E12): Fälle der Fixture über HTTP wie das Widget", () => {
  test("Fixture: Standards wortgleich mit DEFAULT_SUGGESTIONS, Fälle für den Server vorhanden", async () => {
    expect(CONTRACT.standardSuggestions).toEqual({
      de: [...DEFAULT_SUGGESTIONS.de],
      en: [...DEFAULT_SUGGESTIONS.en],
    });
    expect(forkCases.length).toBeGreaterThan(5);
    // und der Server liefert sie so (Standard, ohne Sprache deutsch)
    const { body } = await widgetFetch({}, undefined);
    expect(body.defaultMessages).toEqual(CONTRACT.standardSuggestions.de);
    expect(body.defaultMessagesStandard).toBe(true);
  });

  // E42 (Nutzerentscheidung 22.10.2026, 7.22-rc23): Standard der
  // Startvorschläge in jeder Sprache leer; der Vertrag (Array, Kennzeichen
  // defaultMessagesStandard) bleibt. Bis 7.22-rc22 zwei Beispiele je Sprache.
  test("E42: Standard der Fixture leer, der Server liefert in jeder Sprache [] mit Kennzeichen", async () => {
    expect(CONTRACT.standardSuggestions).toEqual({ de: [], en: [] });
    expect(JSON.stringify(CONTRACT)).not.toMatch(/Deutschkurs|Excel/);
    const standardCases = forkCases.filter(
      (c) => c.config.defaultMessagesStandard === true
    );
    expect(standardCases.length).toBeGreaterThanOrEqual(4);
    for (const c of standardCases) {
      expect([c.name, c.config.defaultMessages]).toEqual([c.name, []]);
      expect([c.name, c.widget.defaultMessages]).toEqual([c.name, []]);
    }
    for (const language of [undefined, "de", "en", "en-gb", "fr", "tr"]) {
      const { status, body } = await widgetFetch({}, language);
      expect(status).toBe(200);
      expect([language, body.defaultMessages]).toEqual([language, []]);
      expect(body.defaultMessagesStandard).toBe(true);
    }
  });

  test.each(CONTRACT.languageQuery.map((c) => [c.query, c.standards]))(
    "?language=%s -> Standard-Startvorschläge %s",
    async (query, standards) => {
      const { status, body } = await widgetFetch({}, query);
      expect(status).toBe(200);
      expect(body.defaultMessages).toEqual(
        CONTRACT.standardSuggestions[standards]
      );
      expect(body.defaultMessagesStandard).toBe(true);
      expect(body).not.toHaveProperty("defaultMessagesSaved");
    }
  );

  test.each(forkCases.map((c) => [c.name, c]))(
    "%s",
    async (
      _name,
      { visualConfig, request = {}, config, configAbsent = [] }
    ) => {
      const { status, body } = await widgetFetch(
        visualConfig,
        request.language
      );
      expect(status).toBe(200);
      for (const [key, value] of Object.entries(config))
        expect([key, body[key]]).toEqual([key, value]);
      for (const key of configAbsent) expect(body).not.toHaveProperty(key);
      // mit Startvorschlägen in config: genau deren Kennzeichen, kein anderes
      if ("defaultMessages" in config)
        for (const flag of FLAGS)
          expect([flag, body[flag]]).toEqual([flag, config[flag]]);
      // Listen als Array von Strings, nie kommagetrennt (E11)
      for (const key of ["defaultMessages", "chatbotBubblesMessages"])
        if (key in body) {
          expect(Array.isArray(body[key])).toBe(true);
          for (const item of body[key]) expect(typeof item).toBe("string");
        }
    }
  );

  // AK-12 und AK-10 (Review AF-6, Fixliste AK-12 A4): Der Vertrag deckt in
  // beiden Kopien den Schalter „Zusätzlich beim Start als Blase zeigen“ ab
  // (privacyStartBubble: der Server liefert ihn nur bei gespeichert genau
  // true, das Widget zeigt die Blase nur dann; ein Skript-Attribut wirkt
  // nicht, Gruppe A) und den festen Link „Datenschutz“ (privacyNotice
  // "link", auch bei gespeichertem Altwert und Skript-Attribut). Bis rc5 nur
  // je Seite getestet: Änderte eine Seite die Form des Werts, blieben beide
  // Suiten grün.
  test('AK-12, AK-10: Fixture mit Fällen für privacyStartBubble (true, "true", false, fehlt) und privacyNotice "link"', () => {
    const stored = (c) => c.visualConfig?.privacyStartBubble;
    const bubbleCases = forkCases.filter(
      (c) => "privacyStartBubble" in c.widget
    );
    const storedValues = bubbleCases.map(stored);
    for (const value of [true, "true", false, undefined])
      expect([value, storedValues.includes(value)]).toEqual([value, true]);
    for (const c of bubbleCases) {
      const on = stored(c) === true;
      expect([c.name, c.widget.privacyStartBubble]).toEqual([c.name, on]);
      if (on)
        expect([c.name, c.config.privacyStartBubble]).toEqual([c.name, true]);
      else
        expect([c.name, c.configAbsent]).toEqual([
          c.name,
          expect.arrayContaining(["privacyStartBubble"]),
        ]);
    }
    expect(
      bubbleCases.some(
        (c) =>
          c.script?.privacyStartBubble !== undefined &&
          c.widget.privacyStartBubble === false
      )
    ).toBe(true);
    const noticeCases = forkCases.filter((c) => "privacyNotice" in c.config);
    expect(noticeCases.length).toBeGreaterThanOrEqual(1);
    for (const c of noticeCases)
      expect([c.name, c.config.privacyNotice, c.widget.privacyNotice]).toEqual([
        c.name,
        "link",
        "link",
      ]);
    // ein gespeicherter Altwert und ein Skript-Attribut ändern den Link nicht
    expect(
      noticeCases.some((c) => c.visualConfig.privacyNotice === "bubble")
    ).toBe(true);
    expect(noticeCases.some((c) => c.script?.privacyNotice !== undefined)).toBe(
      true
    );
  });

  // E23 (Fixliste 7.22-rc17, E10 neu): Startvorschläge und
  // Willkommensblasen stellt das Design Center ein (Gruppe A). In keinem Fall
  // der Fixture ändert ein Skript-Attribut die aufgelöste Liste: Das Widget
  // zeigt die Liste aus der Antwort des Servers (kommagetrennt nur bei einem
  // älteren Server), ohne Liste keine Startvorschläge bzw. die
  // Standardblasen ([]). Bis rc16 galt das Skript-Attribut vor dem Standard.
  test("E23: kein Skript-Attribut ändert Startvorschläge oder Willkommensblasen", () => {
    const list = (v) =>
      Array.isArray(v)
        ? v
        : String(v)
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
    let withScript = 0;
    for (const c of CONTRACT.cases)
      for (const key of ["defaultMessages", "chatbotBubblesMessages"]) {
        if (!(key in c.widget)) continue;
        const fromServer = key in c.config ? list(c.config[key]) : [];
        expect([c.name, key, c.widget[key]]).toEqual([c.name, key, fromServer]);
        if (c.script?.[key] !== undefined) withScript++;
      }
    // genug Fälle mit gesetztem Skript-Attribut (gespeichert, Standard,
    // gespeichertes [], älterer Server)
    expect(withScript).toBeGreaterThanOrEqual(6);
  });

  // Fälle, die nur den Server betreffen (das Widget sieht dieselben Antworten
  // wie in der Fixture)
  test.each([
    [
      "keine Liste gespeichert (Text statt Array): Standard der Sprache",
      { defaultMessages: "Eins,Zwei" },
      "en",
      {
        defaultMessages: [...DEFAULT_SUGGESTIONS.en],
        defaultMessagesStandard: true,
      },
    ],
    [
      "Willkommensblasen leer gespeichert: kein Schlüssel (Standardblasen)",
      { chatbotBubblesMessages: [] },
      "de",
      {
        defaultMessages: [...DEFAULT_SUGGESTIONS.de],
        defaultMessagesStandard: true,
      },
    ],
  ])("%s", async (_name, visualConfig, language, lists) => {
    const { body } = await widgetFetch(visualConfig, language);
    for (const [key, value] of Object.entries(lists))
      expect(body[key]).toEqual(value);
    expect(body).not.toHaveProperty("chatbotBubblesMessages");
    expect(body).not.toHaveProperty("defaultMessagesSaved");
  });

  test("Sprache nur über ?language= der Adresse; Kopfzeilen und andere Parameter zählen nicht", async () => {
    globalThis.__embedVisualConfig = {};
    const res = await fetch(`${baseApiUrl}/${EMBED_ID}/config?lang=en`, {
      headers: { "Accept-Language": "en" },
    });
    expect((await res.json()).defaultMessages).toEqual([
      ...DEFAULT_SUGGESTIONS.de,
    ]);
    // doppelte Angabe (?language=en&language=fr): keine Zeichenkette ->
    // Standard de, kein Fehler
    const twice = await fetch(
      `${baseApiUrl}/${EMBED_ID}/config?language=en&language=fr`
    );
    expect(twice.status).toBe(200);
    expect((await twice.json()).defaultMessages).toEqual([
      ...DEFAULT_SUGGESTIONS.de,
    ]);
  });
});

// Gegenprobe gegen das Widget-Repo (wie embedDefaults.test.js mit
// KUFER_EMBED_DIR): Die Kopie der Fixture im Widget ist wortgleich, und der
// Abruf von /config im Widget schickt die Sprache als ?language= mit.
const embedDir = process.env.KUFER_EMBED_DIR;
const describeWidget = embedDir ? describe : describe.skip;
describeWidget(
  "Vertrag /config: Gegenprobe im Embed-Repo (KUFER_EMBED_DIR)",
  () => {
    test("Kopie der Fixture im Widget-Repo ist wortgleich", () => {
      const copy = JSON.parse(
        fs.readFileSync(
          path.join(embedDir, "tests/fixtures/embedConfigContract.json"),
          "utf8"
        )
      );
      expect(copy).toEqual(CONTRACT);
    });

    test("Widget ruft /config mit ?language= ab", () => {
      const source = fs.readFileSync(
        path.join(embedDir, "src/hooks/useScriptAttributes.js"),
        "utf8"
      );
      expect(source).toMatch(/\/config\?language=/);
    });
  }
);
