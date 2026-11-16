/* eslint-env jest, node */
// Startvermerk zur Fragezeit (issues/kurszustand-zur-fragezeit.md) in allen
// Chatpfaden: Widget (streamChatWithForEmbed), Workspace
// (streamChatWithWorkspace), API (ApiChatHandler.chatSync/streamChat) und
// OpenAI-kompatibel (OpenAICompatibleChat.chatSync/streamChat). Die Suche
// ist die echte LanceDb.performSimilaritySearch gegen eine temporäre
// Tabelle; Widget, Workspace und API bauen den Kontext des Modells aus den
// Quellen (fillSourceWindow), OpenAI-kompatibel aus contextTexts.
//
// AK-2: Der Text an das Antwortmodell und die gespeicherten Quellen tragen
// den Vermerk nach start_date und heute; die Regel steht an einer Stelle.
// NAK-2: Der System-Prompt ist byte-gleich, ob die Regel einen Text ändert
// oder nicht (Prefix-Cache).
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.STORAGE_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), "chat-startvermerk-")
);

jest.mock("../../../utils/prisma", () => ({
  system_settings: { findFirst: jest.fn(async () => null) },
}));
jest.mock("../../../models/workspaceChats", () => ({
  WorkspaceChats: {
    new: jest.fn(),
    markThreadHistoryInvalidV2: jest.fn(),
  },
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
jest.mock("../../../models/workspaceParsedFiles", () => ({
  WorkspaceParsedFiles: { getContextFiles: jest.fn().mockResolvedValue([]) },
}));
jest.mock("../../../models/workspaceAgentInvocation", () => ({
  WorkspaceAgentInvocation: { parseAgents: jest.fn(() => []) },
}));
jest.mock("../../../models/telemetry", () => ({
  Telemetry: { sendTelemetry: jest.fn() },
}));
jest.mock("../../../utils/chats/agents", () => ({
  grepAgents: jest.fn().mockResolvedValue(false),
}));
jest.mock("../../../utils/helpers", () => ({
  getVectorDbClass: jest.fn(),
  getLLMProvider: jest.fn(),
  getMessageLimitInfo: jest.fn(),
  getMessageLimitErrorText: jest.fn(),
  checkWorkspaceMessagesLimit: jest.fn(),
}));
jest.mock("../../../utils/chats/index", () => ({
  grepCommand: jest.fn(async (message) => message),
  VALID_COMMANDS: {},
  chatPrompt: jest.fn().mockResolvedValue("System"),
  sourceIdentifier: jest.fn((doc) => `title:${doc?.title}`),
  recentChatHistory: jest.fn(),
  grepAllSlashCommands: jest.fn(async (message) => message),
}));
jest.mock("../../../utils/agents/ephemeral", () => ({
  EphemeralAgentHandler: { isAgentInvocation: () => false },
  EphemeralEventListener: class {},
}));
jest.mock("../../../utils/collectorApi", () => ({ CollectorApi: class {} }));
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

const helpers = require("../../../utils/helpers");
const { WorkspaceChats } = require("../../../models/workspaceChats");
const { EmbedChats } = require("../../../models/embedChats");
const { recentChatHistory } = require("../../../utils/chats/index");
const { ApiChatHandler } = require("../../../utils/chats/apiChatHandler");
const { streamChatWithWorkspace } = require("../../../utils/chats/stream");
const { streamChatWithForEmbed } = require("../../../utils/chats/embed");
const {
  OpenAICompatibleChat,
} = require("../../../utils/chats/openaiCompatible");
const { LanceDb } = require("../../../utils/vectorDbProviders/lance");
const {
  berlinToday,
} = require("../../../utils/vectorDbProviders/lance/contextSelection");

const OPEN = " — Bereits gestartet, Einstieg möglich";
const STARTED = " — Bereits gestartet";
const TODAY = berlinToday();
const inDays = (n) => {
  const d = new Date(`${TODAY}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const de = (iso) => iso.split("-").reverse().join(".");

const NS_CHANGE = "ws_vermerk";
const NS_SAME = "ws_richtig";
const QUERY_VECTOR = [1, 0, 0, 0];

const courseText = (knr, beginn) =>
  [
    "<document_metadata>",
    `sourceDocument: kurs-${knr.toLowerCase()}.txt`,
    "</document_metadata>",
    "",
    `Titel: Kochkurs ${knr}`,
    `Kursnummer: ${knr}`,
    beginn,
    `Kurs-Link: https://www.vhs-beispiel.de/kurssuche/kurs/x/${knr}`,
    "",
    "Kursbeschreibung: Türkische Küche.",
  ].join("\n");
const START = de(inDays(-13));
const LINE_PLAIN = `Beginn: ${START}, 18:00 Uhr`;
const INFO_TEXT = `Kochen an der vhs\nBeginn: ${START}\nAlle Kochkurse.`;
// Tabelle, in der die Regel ändert: begonnen ohne Vermerk, Warteliste mit
// Vermerk des Extraktors
const RAW = {
  lauf: courseText("I1", LINE_PLAIN),
  warte: courseText("I2", LINE_PLAIN + OPEN),
};
const EXPECTED = {
  lauf: courseText("I1", LINE_PLAIN + OPEN),
  warte: courseText("I2", LINE_PLAIN + STARTED),
};
const rows = (texts) => [
  {
    id: "seite",
    title: "seite.html",
    text: INFO_TEXT,
    vector: [1, 0.05, 0, 0],
  },
  ...[
    ["lauf", true, [1, 0.01, 0, 0]],
    ["warte", false, [1, 0.02, 0, 0]],
  ].map(([id, bookable, vector]) => ({
    id,
    title: `kurs-${id}.txt`,
    text: texts[id],
    vector,
    start_date: inDays(-13),
    end_date: inDays(-13),
    bookable,
    start_minutes: 1080,
    price: 34,
  })),
];

const lance = new LanceDb();
let connector;
const workspaceFor = (slug) => ({
  id: 1,
  slug,
  chatMode: "chat",
  openAiTemp: 1.0,
  chatProvider: "generic-openai",
  topN: 4,
});

beforeAll(async () => {
  const { client } = await lance.connect();
  for (const ns of [NS_CHANGE, NS_SAME]) {
    await client.dropTable(ns).catch(() => {});
    // Nicht-Kurs-Dokument zuerst, Kurse per Schema-Migration (wie im Bestand)
    const all = rows(ns === NS_CHANGE ? RAW : EXPECTED);
    await lance.updateOrCreateCollection(client, all.slice(0, 1), ns);
    await lance.updateOrCreateCollection(client, all.slice(1), ns);
  }
}, 60000);

afterAll(() => {
  fs.rmSync(process.env.STORAGE_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "log").mockImplementation(() => {});
  connector = {
    defaultTemp: 0.7,
    promptWindowLimit: jest.fn().mockReturnValue(4096),
    embedTextInput: jest.fn().mockResolvedValue(QUERY_VECTOR),
    compressMessages: jest
      .fn()
      .mockResolvedValue([{ role: "user", content: "x" }]),
    getChatCompletion: jest
      .fn()
      .mockResolvedValue({ textResponse: "Antwort", metrics: {} }),
    streamingEnabled: jest.fn().mockReturnValue(true),
    streamGetChatCompletion: jest.fn().mockResolvedValue({ metrics: {} }),
    handleStream: jest.fn().mockResolvedValue("Antwort"),
  };
  helpers.getLLMProvider.mockReturnValue(connector);
  helpers.getVectorDbClass.mockReturnValue(lance);
  helpers.getMessageLimitInfo.mockResolvedValue({
    messageCount: 1,
    messagesLimit: null,
    contingent: "1/Unlimited",
  });
  helpers.checkWorkspaceMessagesLimit.mockResolvedValue({
    limitReached: false,
  });
  WorkspaceChats.new.mockResolvedValue({ chat: { id: 42 } });
  recentChatHistory.mockResolvedValue({ rawHistory: [], chatHistory: [] });
  EmbedChats.forEmbedByUser.mockResolvedValue([]);
});
afterEach(() => console.log.mockRestore());

const response = () => ({
  locals: {},
  write: jest.fn(),
  on: jest.fn(),
  removeListener: jest.fn(),
});
const apiArgs = (workspace) => ({
  workspace,
  message: "Kochkurse?",
  mode: "chat",
  user: null,
  thread: null,
  sessionId: null,
  attachments: [],
  reset: false,
});
const embed = (workspace) => ({
  id: 3,
  chat_mode: "chat",
  message_limit: 20,
  visual_config: JSON.stringify({ courseCards: "off" }),
  workspace: { ...workspace, messagesLimit: null },
});

const PATHS = [
  [
    "Widget streamChatWithForEmbed",
    "embed",
    (ws) =>
      streamChatWithForEmbed(response(), embed(ws), "Kochkurse?", "sess", {
        conversationId: "conv",
        displayMode: "bubble",
      }),
  ],
  [
    "Workspace streamChatWithWorkspace",
    "workspace",
    (ws) => streamChatWithWorkspace(response(), ws, "Kochkurse?"),
  ],
  [
    "API ApiChatHandler.chatSync",
    "workspace",
    (ws) => ApiChatHandler.chatSync(apiArgs(ws)),
  ],
  [
    "API ApiChatHandler.streamChat",
    "workspace",
    (ws) => ApiChatHandler.streamChat({ response: response(), ...apiArgs(ws) }),
  ],
  [
    "OpenAI OpenAICompatibleChat.chatSync",
    "workspace",
    (ws) =>
      OpenAICompatibleChat.chatSync({
        workspace: ws,
        prompt: "Kochkurse?",
        messagesLimit: null,
        messageCount: 0,
      }),
  ],
  [
    "OpenAI OpenAICompatibleChat.streamChat",
    "workspace",
    (ws) =>
      OpenAICompatibleChat.streamChat({
        workspace: ws,
        response: response(),
        prompt: "Kochkurse?",
        messagesLimit: null,
        messageCount: 0,
      }),
  ],
];

const stored = (kind) =>
  kind === "embed"
    ? EmbedChats.new.mock.calls[0][0].response
    : WorkspaceChats.new.mock.calls[0][0].response;

describe.each(PATHS)("%s", (_name, kind, call) => {
  test("AK-2: Text an das Modell und gespeicherte Quellen mit Vermerk zur Fragezeit", async () => {
    await call(workspaceFor(NS_CHANGE));
    expect(connector.compressMessages).toHaveBeenCalledTimes(1);
    const { contextTexts } = connector.compressMessages.mock.calls[0][0];
    expect(contextTexts).toEqual(
      expect.arrayContaining([EXPECTED.lauf, EXPECTED.warte, INFO_TEXT])
    );
    expect(contextTexts).not.toContain(RAW.lauf);
    expect(contextTexts).not.toContain(RAW.warte);
    const texts = Object.fromEntries(
      stored(kind).sources.map((s) => [s.id, s.text])
    );
    expect(texts).toEqual({
      lauf: EXPECTED.lauf,
      warte: EXPECTED.warte,
      seite: INFO_TEXT,
    });
  });

  test("NAK-2: System-Prompt byte-gleich, ob die Regel ändert oder nicht", async () => {
    await call(workspaceFor(NS_CHANGE));
    await call(workspaceFor(NS_SAME));
    expect(connector.compressMessages).toHaveBeenCalledTimes(2);
    const [changed, same] = connector.compressMessages.mock.calls.map(
      (c) => c[0]
    );
    expect(changed.systemPrompt).toBe(same.systemPrompt);
    expect(changed.systemPrompt).not.toMatch(/Beginn:|Bereits gestartet/);
    // Kontext gleich: in der zweiten Tabelle stehen die Vermerke schon
    expect([...changed.contextTexts].sort()).toEqual(
      [...same.contextTexts].sort()
    );
  });
});

describe("AK-2: eine Stelle im Code, kein Nachbau je Chatweg", () => {
  const SERVER = path.resolve(__dirname, "../../..");
  const MODULE = path.join(
    SERVER,
    "utils/vectorDbProviders/lance/courseStartNote.js"
  );
  const jsFiles = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      if (entry.name === "node_modules" || entry.name === "__tests__")
        return [];
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return jsFiles(full);
      return entry.name.endsWith(".js") ? [full] : [];
    });

  test("Regel nur in courseStartNote.js, aufgerufen nur in lance/index.js", () => {
    const files = [
      ...jsFiles(path.join(SERVER, "utils")),
      ...jsFiles(path.join(SERVER, "endpoints")),
    ];
    const callers = files
      .filter((file) => file !== MODULE)
      .filter((file) =>
        /\b(withStartNotes|startNoteText)\s*\(/.test(
          fs.readFileSync(file, "utf8")
        )
      )
      .map((file) => path.relative(SERVER, file));
    expect(callers).toEqual(["utils/vectorDbProviders/lance/index.js"]);
    const index = fs.readFileSync(
      path.join(SERVER, "utils/vectorDbProviders/lance/index.js"),
      "utf8"
    );
    expect(index.match(/\bwithStartNotes\s*\(/g)).toHaveLength(1);
    // Kein Chatpfad setzt den Vermerk selbst (Wortlaut nur in der Regel)
    const chatPaths = [
      "utils/chats/embed.js",
      "utils/chats/stream.js",
      "utils/chats/apiChatHandler.js",
      "utils/chats/openaiCompatible.js",
      "utils/helpers/chat/index.js",
    ].map((file) => path.join(SERVER, file));
    for (const file of chatPaths)
      expect(fs.readFileSync(file, "utf8")).not.toMatch(/Bereits gestartet/);
  });
});
