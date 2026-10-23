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
const { writeResponseChunk } = require("../../../utils/helpers/chat/responses");
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
  `[**Alle 7 Kurse in Rücken**](${SPORT_URL}/ruecken)`,
  "Fragen? Gern.",
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

async function run({ reply = REPLY, streaming = true, map = MAP_JSON() }) {
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
    visual_config: JSON.stringify({ courseCards: "off" }),
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
});

describe("NAK-6: ohne gültige Karte wie vorher", () => {
  test.each([
    ["kein Eintrag", null],
    [
      "abgelaufen",
      MAP_JSON().replace(
        /"created":"[^"]+"/,
        '"created":"2026-01-01T00:00:00Z"'
      ),
    ],
    ["kaputt", "{"],
  ])("%s: Kontext bytegleich, Antwort unverändert", async (_name, map) => {
    const { stored, text, contextTexts } = await run({ map });
    expect(contextTexts).toEqual([COURSE_TEXT, PAGE_TEXT]);
    expect(text).toBe(REPLY);
    expect(stored.text).toBe(REPLY);
  });
});
