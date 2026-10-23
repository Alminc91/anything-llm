/* eslint-env jest, node */
// KIE-576 Paket 2 im Embed-Pfad (streamChatWithForEmbed): Kette im Kontext an
// das Modell (AK-14), Quellen/Verlauf unverändert, Übersichtslinks geprüft im
// Stream, ohne Streaming und im gespeicherten Text gleich (AK-15); ohne
// gültige Karte exakt wie vorher (NAK-6).

jest.mock("../../../utils/prisma", () => ({
  system_settings: { findFirst: jest.fn() },
}));
jest.mock("../../../models/embedChats", () => ({
  EmbedChats: {
    new: jest.fn().mockResolvedValue({ chat: { id: 42 }, message: null }),
    forEmbedByUser: jest.fn().mockResolvedValue([]),
  },
}));
jest.mock("../../../models/workspace", () => ({
  Workspace: {
    _resolveVectorSearchMode: jest.fn().mockResolvedValue("default"),
  },
}));
jest.mock("../../../utils/helpers", () => ({
  getVectorDbClass: jest.fn(),
  getLLMProvider: jest.fn(),
}));
jest.mock("../../../utils/chats/index", () => ({
  chatPrompt: jest.fn().mockResolvedValue("System"),
  sourceIdentifier: jest.fn(),
}));
jest.mock("../../../utils/helpers/chat/responses", () => ({
  convertToPromptHistory: jest.fn(() => []),
  writeResponseChunk: jest.fn((response, data) =>
    response.write(`data: ${JSON.stringify(data)}\n\n`)
  ),
}));
jest.mock("../../../utils/DocumentManager", () => ({
  DocumentManager: class {
    pinnedDocs() {
      return Promise.resolve([]);
    }
  },
}));
jest.mock("../../../utils/helpers/chat/queryRewriter", () => ({
  rewriteQueryForSearch: jest.fn(async ({ userQuery }) => userQuery),
}));
jest.mock("../../../utils/chats/metadataFilterResolver", () => ({
  startMetadataFilterResolution: jest.fn(() => null),
}));
jest.mock("../../../utils/helpers/chat", () => ({
  fillSourceWindow: jest.fn(({ searchResults = [] }) => ({
    sources: searchResults,
    contextTexts: searchResults.map((s) => s.text),
  })),
}));

const prisma = require("../../../utils/prisma");
const helpers = require("../../../utils/helpers");
const { EmbedChats } = require("../../../models/embedChats");
const {
  writeResponseChunk,
  convertToPromptHistory,
} = require("../../../utils/helpers/chat/responses");
const { chatPrompt } = require("../../../utils/chats/index");
const { streamChatWithForEmbed } = require("../../../utils/chats/embed");
const {
  __test__: chains,
} = require("../../../utils/chats/embedCategoryChains");

const HOST = "https://www.vhs-beispiel.de";
const SPORT_URL = `${HOST}/kursprogramm/sport`;
const COURSE_URL = `${HOST}/kurssuche/kurs/rueckenfit/26100-001`;
const COURSE_TEXT = [
  "<document_metadata>",
  "sourceDocument: www-vhs-beispiel-de-kurssuche-kurs-rueckenfit.txt",
  "published: 10/22/2026, 4:41:54 AM",
  "</document_metadata>",
  "",
  "Titel: Rückenfit",
  "Kursnummer: 26100-001",
  "Kategorie: Rücken",
  "Kategoriepfad: Sport \\ Rücken",
  `Kurs-Link: ${COURSE_URL}`,
  "Kategorie-Link-Titel: Rücken",
  `Kategorie-Link: ${HOST}/alt/ruecken`,
  "Bereich-Link-Titel: Sport",
  `Bereich-Link: ${SPORT_URL}`,
  "",
  "Kursbeschreibung: Kräftigung für den Rücken.",
].join("\n");
const PAGE_TEXT = `<document_metadata>\nsourceDocument: sport.html\nsource: ${SPORT_URL}\n</document_metadata>\n\nSport an der VHS`;
const MAP_JSON = () =>
  JSON.stringify({
    version: 1,
    client: "vhs-beispiel",
    created: new Date().toISOString(),
    nodes: {
      Sport: { title: "Sport", url: SPORT_URL, count: 40 },
      "Sport \\ Rücken": {
        title: "Rücken",
        url: `${SPORT_URL}/ruecken`,
        count: 7,
      },
    },
    courses: {},
  });
const SEARCH = () => [
  { id: "c1", text: COURSE_TEXT, score: 0.9, title: "Rückenfit" },
  { id: "p1", text: PAGE_TEXT, score: 0.8, title: "Sport" },
];
const REPLY = [
  "Passend:",
  `1. [**Rückenfit**](${COURSE_URL})`,
  "",
  `[**Alle 3 Kurse in Rücken**](${SPORT_URL}/ruecken)`,
  `👉 [**Alle Kurse in Rückenfit**](${COURSE_URL})`,
  "Fragen? Gern.",
].join("\n");
const GUARDED = [
  "Passend:",
  `1. [**Rückenfit**](${COURSE_URL})`,
  "",
  `Mehr Kurse zum Thema: [Rücken (7 Kurse)](${SPORT_URL}/ruecken)`,
  "Fragen? Gern.",
].join("\n");
// E29: neue Form vom Modell, zwei Links in einer Zeile, dazu Fließtext mit
// Knoten-Link
const REPLY_E29 = [
  `Passend ist [Rückenfit](${COURSE_URL}), mehr unter [Sport (3 Kurse)](${SPORT_URL}).`,
  "",
  `**Mehr Kurse zum Thema:** [Rücken](${SPORT_URL}/ruecken) und [Sport](${SPORT_URL})`,
].join("\n");
const GUARDED_E29 = [
  `Passend ist [Rückenfit](${COURSE_URL}), mehr unter [Sport (40 Kurse)](${SPORT_URL}).`,
  "",
  `Mehr Kurse zum Thema: [Rücken (7 Kurse)](${SPORT_URL}/ruecken) · [Sport (40 Kurse)](${SPORT_URL})`,
].join("\n");

function streamingHandler(tokens) {
  return jest.fn(async (response, _stream, { uuid }) => {
    let full = "";
    for (const token of tokens) {
      full += token;
      writeResponseChunk(response, {
        uuid,
        sources: [],
        type: "textResponseChunk",
        textResponse: token,
        close: false,
        error: false,
      });
      await new Promise((r) => setImmediate(r));
    }
    writeResponseChunk(response, {
      uuid,
      sources: [],
      type: "textResponseChunk",
      textResponse: "",
      close: true,
      error: false,
    });
    return full;
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  chains.resetCache();
  helpers.getVectorDbClass.mockReturnValue({
    hasNamespace: jest.fn().mockResolvedValue(true),
    namespaceCount: jest.fn().mockResolvedValue(10),
    performSimilaritySearch: jest.fn().mockResolvedValue({
      contextTexts: [],
      sources: SEARCH(),
      message: null,
    }),
  });
});

async function run({
  reply = REPLY,
  streaming = true,
  map = MAP_JSON(),
  courseCards = "off",
}) {
  prisma.system_settings.findFirst.mockResolvedValue(
    map === null ? null : { value: map }
  );
  const log = [];
  const response = {
    locals: {},
    write: jest.fn((raw) => log.push(JSON.parse(raw.slice(6)))),
    on: jest.fn(),
    removeListener: jest.fn(),
  };
  const connector = {
    defaultTemp: 0.7,
    promptWindowLimit: jest.fn().mockReturnValue(4096),
    compressMessages: jest.fn().mockResolvedValue([]),
    streamingEnabled: jest.fn().mockReturnValue(streaming),
    getChatCompletion: jest
      .fn()
      .mockResolvedValue({ textResponse: reply, metrics: {} }),
    streamGetChatCompletion: jest.fn().mockResolvedValue({ metrics: {} }),
    handleStream: streamingHandler(reply.match(/[\s\S]{1,5}/g)),
  };
  helpers.getLLMProvider.mockReturnValue(connector);
  const embed = {
    id: 3,
    chat_mode: "chat",
    message_limit: 20,
    visual_config: JSON.stringify({ courseCards }),
    workspace: { id: 9, slug: "chatbot", messagesLimit: null, topN: 4 },
  };
  jest.spyOn(console, "log").mockImplementation(() => {});
  await streamChatWithForEmbed(response, embed, "Rückenkurse?", "sess", {
    conversationId: "conv",
    displayMode: "bubble",
  });
  console.log.mockRestore();
  const stored = EmbedChats.new.mock.calls[0][0].response;
  const text = log
    .filter((c) => c.type === "textResponseChunk")
    .map((c) => c.textResponse)
    .join("");
  const contextTexts = connector.compressMessages.mock.calls[0][0].contextTexts;
  return { log, stored, text, contextTexts };
}

describe("mit gültiger Karte", () => {
  test.each([
    ["Stream", true],
    ["ohne Streaming", false],
  ])(
    "%s: Kette an das Modell, Quellen unverändert, Übersichtslinks geprüft und gleich gespeichert",
    async (_name, streaming) => {
      const { stored, text, contextTexts } = await run({ streaming });
      expect(contextTexts[0]).toContain(
        [
          "Kategoriepfad: Sport \\ Rücken",
          `Kategorie-Ebene 1: Sport (40 Kurse) | ${SPORT_URL}`,
          `Kategorie-Ebene 2: Rücken (7 Kurse) | ${SPORT_URL}/ruecken`,
          `Kurs-Link: ${COURSE_URL}`,
          "",
        ].join("\n")
      );
      expect(contextTexts[0]).not.toMatch(/Kategorie-Link|Bereich-Link/);
      expect(contextTexts[1]).toBe(
        PAGE_TEXT.replace(
          "</document_metadata>\n",
          `</document_metadata>\nKategorie-Ebene 1: Sport (40 Kurse) | ${SPORT_URL}\n`
        )
      );
      // Quellen (Verlauf, Kurskarten, Zitate) bleiben die Originaltexte
      expect(stored.sources.map((s) => s.text)).toEqual([
        COURSE_TEXT,
        PAGE_TEXT,
      ]);
      expect(text).toBe(GUARDED);
      expect(stored.text).toBe(GUARDED);
    }
  );

  test.each([
    ["Stream", true],
    ["ohne Streaming", false],
  ])(
    "%s: E29 Übersichtszeile vom Server gesetzt, gesendet gleich gespeichert",
    async (_name, streaming) => {
      const { stored, text } = await run({ streaming, reply: REPLY_E29 });
      expect(text).toBe(GUARDED_E29);
      expect(stored.text).toBe(GUARDED_E29);
    }
  );
});

describe("bekannte Adressen aus System-Prompt und gespeicherten Quellen (R1-D1 Regel 3, S3, R4-D3)", () => {
  const GEESTE_URL = `${HOST}/kurssuche/liste?suchesetzen=false&kfs_aussenst=Geeste`;
  const WINTER_URL = `${HOST}/kurse/winter`;
  const REPLY_KNOWN = [
    `[**Alle Kurse in Geeste**](${GEESTE_URL})`,
    `[**Alle Kurse in Winter**](${WINTER_URL})`,
    `[**Alle Kurse in Pilates**](${HOST}/kurse/pilates)`,
    "Ende",
  ].join("\n");
  const KEPT = [
    `[**Alle Kurse in Geeste**](${GEESTE_URL})`,
    `[**Alle Kurse in Winter**](${WINTER_URL})`,
    "Ende",
  ].join("\n");

  test.each([
    ["Stream", true],
    ["ohne Streaming", false],
  ])(
    "%s: Standort-Link der Kundenregel und Adresse aus den Quellen der vorigen Antwort bleiben; Echo der Nutzeradresse und erfundener Link weg",
    async (_name, streaming) => {
      chatPrompt.mockResolvedValueOnce(`Regeln\n▪ Geeste → \`${GEESTE_URL}\``);
      // Die vorige Antwort wiederholt die Adresse aus der Nutzerfrage; nur
      // ihre gespeicherten Quellen (sources) machen Adressen bekannt
      const echo = `Siehe ${HOST}/kurse/pilates und [Winter](${WINTER_URL}).`;
      EmbedChats.forEmbedByUser.mockResolvedValueOnce([
        {
          id: 1,
          prompt: `Und ${HOST}/kurse/pilates ?`,
          response: JSON.stringify({
            text: echo,
            sources: [{ text: `Winterprogramm: ${WINTER_URL}` }],
          }),
        },
      ]);
      convertToPromptHistory.mockReturnValueOnce([
        { role: "user", content: `Und ${HOST}/kurse/pilates ?` },
        { role: "assistant", content: echo },
      ]);
      const { stored, text } = await run({ streaming, reply: REPLY_KNOWN });
      expect(text).toBe(KEPT);
      expect(stored.text).toBe(KEPT);
    }
  );
});

describe("AK-21 Kurslink nachschlagen im Embed-Pfad (ohne Kurskarten)", () => {
  const kurs = (n) => `${HOST}/kurssuche/kurs/pilates/${n}`;
  const MAP_COURSES = () =>
    JSON.stringify({
      ...JSON.parse(MAP_JSON()),
      course_links: {
        "26200-020": {
          title: "Pilates",
          start: "2026-02-02T18:00",
          place: "Lingen",
          url: kurs("26200-020"),
        },
        "26200-021": {
          title: "Pilates",
          start: "2026-02-09T18:00",
          place: "Lingen",
          url: kurs("26200-021"),
        },
      },
    });
  // Kurstitel verlinkt auf die gecrawlte Kategorieseite (Quelle p1)
  const REPLY_COURSE = [
    "Passend:",
    `**1.** [**Pilates**](${SPORT_URL})`,
    "  Kräftigung für den ganzen Körper.",
    "  **Beginn:** Mo. 09.02.2026, 18:00 - 19:30 Uhr | 10x",
    "  **Ort:** Lingen",
    "",
    "Fragen? Gern.",
  ].join("\n");
  const RESOLVED = REPLY_COURSE.replace(
    `(${SPORT_URL})`,
    `(${kurs("26200-021")})`
  );

  test.each([
    ["Stream", true],
    ["ohne Streaming", false],
  ])(
    "%s: zwei gleiche Titel, Datum entscheidet; gesendet gleich gespeichert",
    async (_name, streaming) => {
      const { stored, text } = await run({
        streaming,
        reply: REPLY_COURSE,
        map: MAP_COURSES(),
      });
      expect(text).toBe(RESOLVED);
      expect(stored.text).toBe(RESOLVED);
    }
  );

  test.each([
    ["Stream", true],
    ["ohne Streaming", false],
  ])(
    "%s: Kurskarten an: Antwort unverändert (R1-D4)",
    async (_name, streaming) => {
      const { stored, text } = await run({
        streaming,
        reply: REPLY_COURSE,
        map: MAP_COURSES(),
        courseCards: "auto",
      });
      expect(text).toBe(REPLY_COURSE);
      expect(stored.text).toBe(REPLY_COURSE);
    }
  );
});

describe("R1-D4 (NAK-9): im Kurskarten-Modus weder Kette noch Prüfer", () => {
  test.each([
    ["Stream", true],
    ["ohne Streaming", false],
  ])(
    "%s: gültige Karte, Kurskarten an: Kontext und Antwort mit Übersichtslinks unverändert",
    async (_name, streaming) => {
      const { stored, text, contextTexts } = await run({
        streaming,
        courseCards: "auto",
      });
      expect(contextTexts).toEqual([COURSE_TEXT, PAGE_TEXT]);
      expect(text).toBe(REPLY);
      expect(stored.text).toBe(REPLY);
      expect(prisma.system_settings.findFirst).not.toHaveBeenCalledWith(
        expect.objectContaining({ where: { label: "kufer_category_map" } })
      );
    }
  );
});

describe("NAK-6: ohne gültige Karte wie vorher", () => {
  const INVALID = [
    ["kein Eintrag", null],
    ["leer", ""],
    [
      "abgelaufen",
      MAP_JSON().replace(
        /"created":"[^"]+"/,
        '"created":"2026-01-01T00:00:00Z"'
      ),
    ],
    [
      "knapp älter als 36 h",
      MAP_JSON().replace(
        /"created":"[^"]+"/,
        `"created":"${new Date(Date.now() - 36 * 3600 * 1000 - 60 * 1000).toISOString()}"`
      ),
    ],
    ["kaputt", "{"],
    ["version 2", MAP_JSON().replace('"version":1', '"version":2')],
  ];
  const cases = INVALID.flatMap(([name, map]) =>
    [
      ["Stream", true],
      ["ohne Streaming", false],
    ].flatMap(([mode, streaming]) => [
      [`${name}, ${mode}, alte Form`, map, streaming, REPLY],
      [`${name}, ${mode}, neue Form`, map, streaming, REPLY_E29],
    ])
  );
  test.each(cases)(
    "%s: Kontext bytegleich, Antwort gesendet und gespeichert unverändert",
    async (_name, map, streaming, reply) => {
      const { stored, text, contextTexts } = await run({
        map,
        streaming,
        reply,
      });
      expect(contextTexts).toEqual([COURSE_TEXT, PAGE_TEXT]);
      expect(text).toBe(reply);
      expect(stored.text).toBe(reply);
    }
  );
});
