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
//
// KIE-576 Paket 3: courseCount {count, offered, hidden, stand, word} nach
// Vertrag (issues/KIE-576/KIE-576-kursanzahl.md, D-K5) mit den
// Beispielwerten der Fixture: Kursbestand mit 837 Kursnummern, 812 davon als
// Kursdokumente im Workspace, 14 veraltete (hidden). Der Kursbestand kommt
// aus der echten courseInventory.js (Datenbankzeile und Workspace-Dokumente
// als Attrappen).

jest.mock("../../utils/prisma", () => ({
  system_settings: {
    findFirst: jest.fn(async ({ where }) =>
      where?.label === "kufer_course_inventory"
        ? globalThis.__courseInventoryRow ?? null
        : null
    ),
  },
}));
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
      workspace: { id: 1, slug: "ws" },
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
const {
  __test__: courseInventory,
} = require("../../utils/chats/courseInventory");

// Kursbestand der Beispielwerte: A = 837 Kursnummern, B = 812 davon plus 14
// veraltete, Stand 24.10.2026 08:00 UTC; die Uhr des Tests läuft zwei Stunden
// danach (der Stand ist gültig, höchstens 24 h alt)
const STAND = "2026-10-24T08:00:00Z";
const OFFERED = Array.from(
  { length: 837 },
  (_, i) => `262-${String(i + 1).padStart(4, "0")}`
);
const INVENTORY_ROW = {
  value: JSON.stringify({
    version: 1,
    client: "vhs-beispiel",
    created: STAND,
    offered: OFFERED,
  }),
};
const STALE_NUMBERS = Array.from({ length: 14 }, (_, i) => `ALT-${i + 1}`);
const WORKSPACE_NUMBERS = [...OFFERED.slice(0, 812), ...STALE_NUMBERS];
function installCourseInventory(row = INVENTORY_ROW) {
  globalThis.__courseInventoryRow = row;
  courseInventory.reset();
  courseInventory.setDeps({
    findWorkspaceId: async (slug) => (slug === "ws" ? 1 : null),
    listDocuments: async () =>
      WORKSPACE_NUMBERS.map((number) => ({
        docId: `d-${number}`,
        docpath: `custom-documents/${number}.json`,
      })),
    listVectors: async (docIds) =>
      docIds.map((docId) => ({ docId, vectorId: `v-${docId}` })),
    readDocumentText: async (docpath) =>
      `Titel: Kurs\nKursnummer: ${docpath.slice(17, -5)}\nKurs-Link: https://www.vhs-beispiel.de/kurs\n`,
    tableRows: async () => null,
  });
}
const realDateNow = Date.now;
const CLOCK_OFFSET = Date.parse("2026-10-24T10:00:00Z") - realDateNow();

// Kennzeichen der Startvorschläge
const FLAGS = ["defaultMessagesSaved", "defaultMessagesStandard"];

const EMBED_ID = "78eda2c6-5bd0-44b5-b097-30d694a56677";
let server;
let baseApiUrl;

beforeAll(async () => {
  jest.spyOn(console, "error").mockImplementation(() => {});
  jest
    .spyOn(Date, "now")
    .mockImplementation(() => realDateNow() + CLOCK_OFFSET);
  installCourseInventory();
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
  Date.now.mockRestore();
  delete globalThis.__embedVisualConfig;
  delete globalThis.__courseInventoryRow;
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

// KIE-576 Paket 3: Fälle nur des Servers zu courseCount (die Fixture hat die
// Beispielwerte vorhanden/fehlend, beide laufen oben mit)
describe("Vertrag /config: courseCount (KIE-576 Paket 3)", () => {
  const EXAMPLE = {
    count: 812,
    offered: 837,
    hidden: 14,
    stand: "2026-10-24T08:00:00.000Z",
    word: "Kurse",
  };
  afterEach(() => installCourseInventory());

  test("Fixture: je ein Fall mit und ohne courseCount, Beispielwerte des Vertrags", () => {
    const withCount = forkCases.filter((c) => c.config.courseCount);
    const without = forkCases.filter((c) =>
      (c.configAbsent || []).includes("courseCount")
    );
    expect(withCount.map((c) => c.config.courseCount)).toEqual([EXAMPLE]);
    expect(without.length).toBeGreaterThanOrEqual(1);
  });

  test("genau die fünf Felder, Zahlen als ganze Zahlen", async () => {
    const { body } = await widgetFetch({}, "de");
    expect(body.courseCount).toEqual(EXAMPLE);
    expect(Object.keys(body.courseCount).sort()).toEqual([
      "count",
      "hidden",
      "offered",
      "stand",
      "word",
    ]);
    for (const key of ["count", "offered", "hidden"])
      expect(Number.isSafeInteger(body.courseCount[key])).toBe(true);
  });

  // D-K5: hidden = veraltete Kursdokumente des Workspace, die die Suche
  // ausblendet (staleDocCount), auch 0
  test("D-K5: hidden ohne veraltete Kursdokumente 0", async () => {
    globalThis.__courseInventoryRow = INVENTORY_ROW;
    courseInventory.reset();
    courseInventory.setDeps({
      findWorkspaceId: async () => 1,
      listDocuments: async () =>
        OFFERED.slice(0, 812).map((number) => ({
          docId: `d-${number}`,
          docpath: `custom-documents/${number}.json`,
        })),
      listVectors: async (docIds) =>
        docIds.map((docId) => ({ docId, vectorId: `v-${docId}` })),
      readDocumentText: async (docpath) =>
        `Titel: Kurs\nKursnummer: ${docpath.slice(17, -5)}\n`,
      tableRows: async () => null,
    });
    const { body } = await widgetFetch({}, "de");
    expect(body.courseCount).toEqual({ ...EXAMPLE, hidden: 0 });
  });

  // Info-Karte (D-K5): die Zeilen baut das Widget; die Fixture hält sie
  // wortgleich für beide Seiten. Hier: der Beispielfall passt zur Antwort
  // des Servers, die Wortlaute folgen dem Vertrag.
  test("D-K5: Fixture courseCountTexts zum Beispiel des Servers, Wortlaut nach Vertrag", async () => {
    const { cases } = CONTRACT.courseCountTexts;
    const { body } = await widgetFetch({}, "de");
    expect(cases[0].courseCount).toEqual(body.courseCount);
    const de = cases.filter((c) => c.language === "de");
    const en = cases.filter((c) => c.language === "en");
    expect(de.length).toBeGreaterThanOrEqual(4);
    expect(en.length).toBeGreaterThanOrEqual(3);
    const lines = cases.flatMap((c) => c.lines);
    expect(lines).toEqual(
      expect.arrayContaining([
        "Enthalten sind die aktuellen Kurse aus unserem Kursprogramm.",
        "1 Kurs ist ausgeblendet, da er voraussichtlich beendet ist.",
        "Zurzeit fehlt 1 Kurs.",
        "Für eine vollständige Suche nutzen Sie bitte die Kurssuche auf unserer Webseite.",
        "Stand: heute, 10:00 Uhr, stündlich aktualisiert. Verbindlich ist das Kursprogramm auf unserer Webseite.",
        "1 course is hidden because it has probably ended.",
        "1 course is currently missing.",
      ])
    );
    // entfallen (D-K5): „Alle … sind enthalten.“, „… von … angebotenen …“
    for (const line of lines) {
      expect(line).not.toMatch(/sind enthalten|on offer are included/);
      expect(line).not.toMatch(/[–—]/);
    }
  });

  test.each([
    ["englisches Widget: Standardwort courses", {}, "en", "courses"],
    ["eigene Bezeichnung", { courseCountWord: " Angebote " }, "de", "Angebote"],
    [
      "eigene Bezeichnung auch englisch",
      { courseCountWord: "Lehrgänge" },
      "en",
      "Lehrgänge",
    ],
    [
      "Bindestrich zwischen Buchstaben erlaubt",
      { courseCountWord: "Online-Kurse" },
      "de",
      "Online-Kurse",
    ],
    [
      "Leerzeichen: Standard (ein Wort, Fixliste r2b)",
      { courseCountWord: "Online-Kurse vor Ort" },
      "de",
      "Kurse",
    ],
    ["Ziffer: Standard", { courseCountWord: "Kurse 2026" }, "de", "Kurse"],
    ["Satzzeichen: Standard", { courseCountWord: "Kurse!" }, "de", "Kurse"],
    ["HTML: Standard", { courseCountWord: "<b>Kurse</b>" }, "de", "Kurse"],
    [
      "länger als 20 Zeichen: Standard",
      { courseCountWord: "Weiterbildungsangebote" },
      "de",
      "Kurse",
    ],
    ["leer: Standard", { courseCountWord: "  " }, "en", "courses"],
  ])("%s", async (_name, visualConfig, language, word) => {
    const { body } = await widgetFetch(visualConfig, language);
    expect(body.courseCount).toEqual({ ...EXAMPLE, word });
  });

  // Vertrag der Bezeichnung (Fixture courseCountWords, wortgleich im
  // Widget): ein gespeicherter ungültiger Wert (Altbestand) gilt wie leer
  test.each(CONTRACT.courseCountWords.valid)(
    "Bezeichnung gültig %j: word %j",
    async (input, word) => {
      const { body } = await widgetFetch({ courseCountWord: input }, "de");
      expect(body.courseCount).toEqual({ ...EXAMPLE, word });
    }
  );
  test.each(CONTRACT.courseCountWords.invalid)(
    "Bezeichnung ungültig %j: Standard der Sprache",
    async (input) => {
      for (const [language, word] of [
        ["de", "Kurse"],
        ["en", "courses"],
      ]) {
        const { body } = await widgetFetch(
          { courseCountWord: input },
          language
        );
        expect(body.courseCount).toEqual({ ...EXAMPLE, word });
      }
    }
  );

  test.each([
    ["Anzeige aus (auch groß geschrieben)", { courseCountMode: " OFF " }],
  ])("%s: kein Feld", async (_name, visualConfig) => {
    const { body } = await widgetFetch(visualConfig, "de");
    expect(body).not.toHaveProperty("courseCount");
  });

  test.each([
    ["unbekannter Wert", { courseCountMode: "vielleicht" }],
    ["an", { courseCountMode: "on" }],
  ])("Anzeige %s: wie Standard an", async (_name, visualConfig) => {
    const { body } = await widgetFetch(visualConfig, "de");
    expect(body.courseCount).toEqual(EXAMPLE);
  });

  test.each([
    ["kein Kursbestand", null],
    ["kaputter Kursbestand", { value: "{" }],
    [
      "Kursbestand älter als 24 h",
      {
        value: INVENTORY_ROW.value.replace(STAND, "2026-10-23T09:00:00Z"),
      },
    ],
  ])(
    "%s: kein Feld, Untertitel unverändert (NAK-K1, NAK-K5)",
    async (_name, row) => {
      installCourseInventory(row);
      const { body } = await widgetFetch(
        { assistantSubtitle: "Ihr Kursberater" },
        "de"
      );
      expect(body).not.toHaveProperty("courseCount");
      expect(body.assistantSubtitle).toBe("Ihr Kursberater");
    }
  );

  test("mit courseCount bleibt der gespeicherte Untertitel in der Antwort (NAK-K5)", async () => {
    const { body } = await widgetFetch(
      { assistantSubtitle: "Ihr Kursberater" },
      "de"
    );
    expect(body.courseCount).toEqual(EXAMPLE);
    expect(body.assistantSubtitle).toBe("Ihr Kursberater");
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
