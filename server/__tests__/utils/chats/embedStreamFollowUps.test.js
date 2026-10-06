/* eslint-env jest, node */
// streamChatWithForEmbed mit Folgefragen: Endzeile "[[FRAGEN: … | …]]" ->
// Textchunks ohne Zeile, Chunk { type: "followUps" } nach dem letzten
// Textchunk und vor finalizeResponseStream, gespeichert als followUps,
// response.text ohne Zeile. Karten/Teaser-Reihenfolge bleibt unverändert.
// (Test-Gerüst wie embedStreamCardsMarker.test.js)
const fs = require("fs");
const path = require("path");

jest.mock("../../../utils/prisma", () => ({}));
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
jest.mock("../../../models/documents", () => ({
  Document: { where: jest.fn() },
}));
jest.mock("../../../utils/files", () => {
  const actual = jest.requireActual("../../../utils/files");
  return {
    documentsPath: "/srv/storage/documents",
    isWithin: actual.isWithin,
    normalizePath: actual.normalizePath,
  };
});
jest.mock("../../../utils/helpers", () => ({
  getVectorDbClass: jest.fn(),
  getLLMProvider: jest.fn(),
}));
jest.mock("../../../utils/chats/index", () => ({
  chatPrompt: jest.fn().mockResolvedValue("System"),
  sourceIdentifier: jest.fn(),
}));
// Gemeinsames Protokoll: jeder Chunk landet über response.write im Log
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

const helpers = require("../../../utils/helpers");
const { EmbedChats } = require("../../../models/embedChats");
const { Document } = require("../../../models/documents");
const { writeResponseChunk } = require("../../../utils/helpers/chat/responses");
const { streamChatWithForEmbed } = require("../../../utils/chats/embed");
const { documents } = require("./fixtures/demoInlineCourseDocuments.json");
const sourcesFixture = require("./fixtures/praesentationSources.json");

const clone = (v) => JSON.parse(JSON.stringify(v));
const DOCS_ROOT = "/srv/storage/documents";
const BASE = "https://aw.donau.kufer.de/kurssuche/kurs";
const AEROBIC_URL = `${BASE}/aerobic/262-3208`;
const GYM_URL = `${BASE}/spielerische-gymnastik-fuer-eltern-und-kind/262-3204`;
const SPORT_URL = `${BASE}/sport-am-familienwochenende/262-3217`;
const docOf = (needle) =>
  Object.entries(documents).find(([dp]) => dp.includes(needle));

// Treffer wie bei "gibt es sportkurse?": 2 Kategorieseiten + 2 Kurs-
// dokumente (Kopf-Chunks), Aerobic nur über eine Kategorieseite
function courseChunk(needle) {
  const [, doc] = docOf(needle);
  const { pageContent, ...meta } = doc;
  return { ...clone(meta), text: pageContent, score: 0.8 };
}
const CATEGORY = sourcesFixture.donauYogaCategoryAndCourses.find((s) =>
  /^link:\/\//.test(s.chunkSource || "")
);
const SEARCH = () => [
  clone(CATEGORY), // [CONTEXT 0]
  courseChunk("gymnastik"), // [CONTEXT 1]
  courseChunk("sport-am-familienwochenende"), // [CONTEXT 2]
  { ...clone(CATEGORY), id: "kat-2" }, // [CONTEXT 3]
];

const REPLY_BODY = [
  "Ja, es gibt passende Sportkurse:",
  `1. [**Aerobic**](${AEROBIC_URL})`,
  `2. [**Spielerische Gymnastik für Eltern und Kind**](${GYM_URL})`,
  `3. [**Sport am Familienwochenende**](${SPORT_URL})`,
].join("\n");

// Provider-Stream-Handler: schreibt Token für Token über writeResponseChunk
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

function tokensOf(text) {
  return text.match(/[\s\S]{1,7}/g);
}

function makeEmbed(visual_config = JSON.stringify({ courseCards: "auto" })) {
  return {
    id: 3,
    chat_mode: "chat",
    message_limit: 20,
    visual_config,
    workspace: { id: 9, slug: "chatbot", messagesLimit: null, topN: 4 },
  };
}

let readSpy;
beforeEach(() => {
  jest.clearAllMocks();
  Document.where.mockResolvedValue(
    Object.keys(documents).map((docpath) => ({ docpath }))
  );
  readSpy = jest
    .spyOn(fs.promises, "readFile")
    .mockImplementation(async (p) => {
      const hit = Object.entries(documents).find(
        ([dp]) => path.resolve(DOCS_ROOT, dp) === p
      );
      if (!hit) throw new Error(`ENOENT ${p}`);
      return JSON.stringify(hit[1]);
    });
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
afterEach(() => readSpy.mockRestore());

async function run({ reply, embed = makeEmbed(), streaming = true }) {
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
    handleStream: streamingHandler(tokensOf(reply)),
  };
  helpers.getLLMProvider.mockReturnValue(connector);
  await streamChatWithForEmbed(response, embed, "gibt es sportkurse?", "sess", {
    conversationId: "conv",
  });
  const stored = EmbedChats.new.mock.calls[0][0].response;
  const text = log
    .filter((c) => c.type === "textResponseChunk")
    .map((c) => c.textResponse)
    .join("");
  return { log, stored, text, connector, response };
}

const FU_BODY = "Ja, es gibt passende Englischkurse für Sie.";
const FU_LINE = "[[FRAGEN: Gibt es B1-Kurse? | Auch online?]]";
const FU = ["Gibt es B1-Kurse?", "Auch online?"];

function checkOrder(log) {
  const types = log.map((c) => c.type);
  const iFollow = types.indexOf("followUps");
  const iFinal = types.indexOf("finalizeResponseStream");
  const iLastText = types.lastIndexOf("textResponseChunk");
  expect(types.filter((t) => t === "followUps")).toHaveLength(1);
  expect(iFollow).toBeGreaterThan(iLastText);
  expect(iFollow).toBeLessThan(iFinal);
  return log[iFollow];
}

describe("Folgefragen im Embed-Stream", () => {
  test("AK-1: Zeile nicht im Text, Chunk followUps (2) nach dem letzten Text und vor finalize, gespeichert", async () => {
    for (const streaming of [true, false])
      for (const vc of [
        JSON.stringify({ followUps: "pills" }),
        JSON.stringify({ courseCards: "auto", followUps: " Pills " }),
      ]) {
        jest.clearAllMocks();
        const { log, stored, text } = await run({
          reply: `${FU_BODY}\n${FU_LINE}`,
          embed: makeEmbed(vc),
          streaming,
        });
        expect(text).toBe(FU_BODY);
        expect(
          JSON.stringify(log.filter((c) => c.type !== "followUps"))
        ).not.toMatch(/FRAGEN|B1-Kurse/);
        const chunk = checkOrder(log);
        expect(chunk.followUps).toEqual(FU);
        expect(chunk.close).toBe(false);
        expect(stored.text).toBe(FU_BODY);
        expect(stored.followUps).toEqual(FU);
      }
  });

  test("Befund 3: ohne pills (none/fehlend/kaputt) kein Chunk — Zeile trotzdem entfernt und gespeichert", async () => {
    for (const streaming of [true, false])
      for (const vc of [
        null,
        JSON.stringify({ courseCards: "auto" }),
        JSON.stringify({ courseCards: "auto", followUps: "none" }),
        "{nicht json",
      ]) {
        jest.clearAllMocks();
        const { log, stored, text } = await run({
          reply: `${FU_BODY}\n${FU_LINE}`,
          embed: makeEmbed(vc),
          streaming,
        });
        expect(text).toBe(FU_BODY);
        expect(JSON.stringify(log)).not.toMatch(/FRAGEN|B1-Kurse/);
        expect(log.find((c) => c.type === "followUps")).toBeUndefined();
        expect(stored.text).toBe(FU_BODY);
        expect(stored.followUps).toEqual(FU);
      }
  });

  test("Befund 3: Prompt-Hinweis nur bei pills, am Ende nach dem Disclaimer-Hinweis", async () => {
    const {
      DISCLAIMER_PROMPT_NOTE,
      FOLLOW_UPS_PROMPT_NOTE,
    } = require("../../../utils/chats/embedCourseSources");
    const promptFor = async (vc) => {
      jest.clearAllMocks();
      const { connector } = await run({
        reply: `${FU_BODY}\n${FU_LINE}`,
        embed: makeEmbed(vc),
      });
      return connector.compressMessages.mock.calls[0][0].systemPrompt;
    };
    expect(FOLLOW_UPS_PROMPT_NOTE).toMatch(
      /^\n\n### Follow-up Suggestions \(ACTIVE\)\n/
    );
    expect(FOLLOW_UPS_PROMPT_NOTE).toContain("[[FRAGEN: -]]");
    expect(await promptFor(JSON.stringify({ followUps: "pills" }))).toBe(
      `System${FOLLOW_UPS_PROMPT_NOTE}`
    );
    expect(
      await promptFor(
        JSON.stringify({ followUps: "pills", disclaimer: "footer" })
      )
    ).toBe(`System${DISCLAIMER_PROMPT_NOTE}${FOLLOW_UPS_PROMPT_NOTE}`);
    for (const vc of [
      null,
      JSON.stringify({ followUps: "none" }),
      JSON.stringify({ courseCards: "auto" }),
      "{nicht json",
    ])
      expect(await promptFor(vc)).toBe("System");
    expect(
      await promptFor(
        JSON.stringify({ followUps: "none", disclaimer: "footer" })
      )
    ).toBe(`System${DISCLAIMER_PROMPT_NOTE}`);
  });

  test("Reihenfolge mit Karten und Teasern: courseSources -> courseTeasers -> Text -> followUps -> finalize", async () => {
    const reply = [
      "[[KARTEN: 1, 2]]",
      "[[TEASER 1: Spielerisch bewegen.]]",
      "[[TEASER 2: Ein Nachmittag voller Bewegung.]]",
      REPLY_BODY,
      "",
      FU_LINE,
    ].join("\n");
    const { log, stored, text } = await run({
      reply,
      embed: makeEmbed(
        JSON.stringify({ courseCards: "auto", followUps: "pills" })
      ),
    });
    const types = log.map((c) => c.type);
    const order = [
      types.indexOf("courseSources"),
      types.indexOf("courseTeasers"),
      types.findIndex(
        (t, i) => t === "textResponseChunk" && log[i].textResponse
      ),
      types.indexOf("followUps"),
      types.indexOf("finalizeResponseStream"),
    ];
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    checkOrder(log);
    expect(text).toBe(REPLY_BODY);
    expect(stored.text).toBe(REPLY_BODY);
    expect(stored.followUps).toEqual(FU);
    expect(stored.courseCardsMarker).toEqual([1, 2]);
    expect(stored.courseTeaserLines).toHaveLength(2);
  });

  test("Befund 1/6: erkennbare, inhaltlich kaputte Zeile wird entfernt, gültige Einträge als Chunk, gespeicherter Text ohne Reste", async () => {
    for (const [line, expected] of [
      [
        `[[FRAGEN: Gibt es B1-Kurse? | ${"sehr lange Frage ".repeat(5)}?]]`,
        ["Gibt es B1-Kurse?"],
      ],
      ["[[FRAGEN: a? | b? | c? | d?]]", ["a?", "b?", "c?"]],
      [`[[FRAGEN: ${"sehr lange Frage ".repeat(5)}?]]`, []],
      ["[[FRAGEN: | | ]]", []],
    ]) {
      for (const streaming of [true, false]) {
        jest.clearAllMocks();
        const reply = `${FU_BODY}\n${line}`;
        const { log, stored, text } = await run({
          reply,
          embed: makeEmbed(JSON.stringify({ followUps: "pills" })),
          streaming,
        });
        expect(text).toBe(FU_BODY);
        expect(stored.text).toBe(FU_BODY);
        expect(JSON.stringify(stored)).not.toMatch(/FRAGEN|d\?|sehr lange/);
        if (expected.length > 0) {
          expect(checkOrder(log).followUps).toEqual(expected);
          expect(stored.followUps).toEqual(expected);
        } else {
          expect(log.find((c) => c.type === "followUps")).toBeUndefined();
          expect(stored).not.toHaveProperty("followUps");
        }
      }
    }
  });

  test("NAK-1: offene/zu lange Zeile oder zwei Gruppen gehen als Text durch, kein Chunk, nichts gespeichert", async () => {
    for (const line of [
      `[[FRAGEN: ${"Frage ".repeat(60)}]]`,
      "[[FRAGEN: Gibt es B1-Kurse? | Auch online?",
      "[[FRAGEN: a? | b?]] [[FRAGEN: c?]]",
    ]) {
      jest.clearAllMocks();
      const reply = `${FU_BODY}\n${line}`;
      const { log, stored, text } = await run({
        reply,
        embed: makeEmbed(JSON.stringify({ followUps: "pills" })),
      });
      expect(text).toBe(reply);
      expect(stored.text).toBe(reply);
      expect(log.find((c) => c.type === "followUps")).toBeUndefined();
      expect(stored).not.toHaveProperty("followUps");
    }
  });

  test("NAK-1: Zeile mitten im Text bleibt Text", async () => {
    const reply = `${FU_BODY}\n${FU_LINE}\nNoch ein Satz.`;
    const { log, stored, text } = await run({ reply });
    expect(text).toBe(reply);
    expect(stored.text).toBe(reply);
    expect(log.find((c) => c.type === "followUps")).toBeUndefined();
  });

  test("ohne Endzeile: kein followUps-Chunk, Feld fehlt, Text wie bisher", async () => {
    const { log, stored, text } = await run({ reply: REPLY_BODY });
    expect(text).toBe(REPLY_BODY);
    expect(log.find((c) => c.type === "followUps")).toBeUndefined();
    expect(stored).not.toHaveProperty("followUps");
  });

  test("[[FRAGEN: -]] / [[FRAGEN: –]]: Zeile entfernt, kein Chunk", async () => {
    for (const line of [
      "[[FRAGEN: -]]",
      "[[FRAGEN: –]]",
      "[[FRAGEN: — | •]]",
    ]) {
      jest.clearAllMocks();
      const { log, stored, text } = await run({
        reply: `${FU_BODY}\n${line}`,
        embed: makeEmbed(JSON.stringify({ followUps: "pills" })),
      });
      expect(text).toBe(FU_BODY);
      expect(stored.text).toBe(FU_BODY);
      expect(log.find((c) => c.type === "followUps")).toBeUndefined();
      expect(stored).not.toHaveProperty("followUps");
    }
  });

  test("LLM-Verlauf: gespeicherte Vorschläge stehen wieder als letzte Zeile", async () => {
    const {
      convertToPromptHistory,
    } = require("../../../utils/helpers/chat/responses");
    EmbedChats.forEmbedByUser.mockResolvedValueOnce([
      {
        id: 1,
        prompt: "gibt es englischkurse?",
        response: JSON.stringify({
          text: FU_BODY,
          courseCardsMarker: [],
          followUps: FU,
        }),
      },
    ]);
    await run({ reply: `${FU_BODY}\n${FU_LINE}` });
    const history = convertToPromptHistory.mock.calls[0][0];
    expect(JSON.parse(history[0].response).text).toBe(
      `[[KARTEN: -]]\n${FU_BODY}\n${FU_LINE}`
    );
  });
});
