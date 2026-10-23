/* eslint-env jest, node */
// KIE-576 AK-14: Kette im Kontext auch im API-Pfad (ApiChatHandler.chatSync
// und streamChat) und im Workspace-Chat (streamChatWithWorkspace). Nur der
// Kontext an das Modell ändert sich, die gespeicherten Quellen nicht; ohne
// gültige Karte bytegleich (NAK-6). Die Absicherung der Übersichtslinks gibt
// es in diesem Paket nur im Embed-Pfad.

jest.mock("../../../utils/prisma", () => ({
  system_settings: { findFirst: jest.fn() },
}));
jest.mock("../../../models/workspaceChats", () => ({
  WorkspaceChats: {
    new: jest.fn(),
    markThreadHistoryInvalidV2: jest.fn(),
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
  sourceIdentifier: jest.fn(),
  recentChatHistory: jest
    .fn()
    .mockResolvedValue({ rawHistory: [], chatHistory: [] }),
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
jest.mock("../../../utils/helpers/chat", () => ({
  fillSourceWindow: jest.fn(({ searchResults = [] }) => ({
    sources: searchResults,
    contextTexts: searchResults.map((s) => s.text),
  })),
}));

const prisma = require("../../../utils/prisma");
const helpers = require("../../../utils/helpers");
const { WorkspaceChats } = require("../../../models/workspaceChats");
const { ApiChatHandler } = require("../../../utils/chats/apiChatHandler");
const { streamChatWithWorkspace } = require("../../../utils/chats/stream");
const {
  __test__: chains,
} = require("../../../utils/chats/embedCategoryChains");

const HOST = "https://www.vhs-beispiel.de";
const COURSE_TEXT = [
  "<document_metadata>",
  "sourceDocument: kurs.txt",
  "</document_metadata>",
  "",
  "Titel: Rückenfit",
  "Kursnummer: 26100-001",
  "Kategoriepfad: Sport \\ Rücken",
  `Kurs-Link: ${HOST}/kurs/26100-001`,
  "Kategorie-Link-Titel: Rücken",
  `Kategorie-Link: ${HOST}/alt/ruecken`,
  "",
  "Kursbeschreibung: Kräftigung.",
].join("\n");
const CHAINED = COURSE_TEXT.replace(
  /Kurs-Link: (.*)\nKategorie-Link-Titel: .*\nKategorie-Link: .*\n/,
  `Kategorie-Ebene 1: Sport (40 Kurse) | ${HOST}/sport\nKurs-Link: $1\n`
);
const MAP_JSON = () =>
  JSON.stringify({
    version: 1,
    client: "vhs-beispiel",
    created: new Date().toISOString(),
    nodes: { Sport: { title: "Sport", url: `${HOST}/sport`, count: 40 } },
    courses: {},
  });

let connector;
const workspace = {
  id: 1,
  slug: "ws",
  chatMode: "chat",
  openAiTemp: 1.0,
  chatProvider: "generic-openai",
};

beforeAll(() => {
  jest.spyOn(console, "log").mockImplementation(() => {});
});
afterAll(() => console.log.mockRestore());

beforeEach(() => {
  jest.clearAllMocks();
  chains.resetCache();
  connector = {
    defaultTemp: 0.7,
    promptWindowLimit: jest.fn().mockReturnValue(4096),
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
  helpers.getVectorDbClass.mockReturnValue({
    hasNamespace: jest.fn().mockResolvedValue(true),
    namespaceCount: jest.fn().mockResolvedValue(5),
    performSimilaritySearch: jest.fn().mockResolvedValue({
      contextTexts: [],
      sources: [{ id: "c1", text: COURSE_TEXT, score: 0.9 }],
      message: null,
    }),
  });
  helpers.getMessageLimitInfo.mockResolvedValue({
    messageCount: 1,
    messagesLimit: null,
    contingent: "1/Unlimited",
  });
  helpers.checkWorkspaceMessagesLimit.mockResolvedValue({
    limitReached: false,
  });
  WorkspaceChats.new.mockResolvedValue({ chat: { id: 42 } });
});

const response = () => ({
  write: jest.fn(),
  on: jest.fn(),
  removeListener: jest.fn(),
});
const apiArgs = () => ({
  workspace,
  message: "Rückenkurse?",
  mode: "chat",
  user: null,
  thread: null,
  sessionId: null,
  attachments: [],
  reset: false,
});

const PATHS = [
  ["ApiChatHandler.chatSync", () => ApiChatHandler.chatSync(apiArgs())],
  [
    "ApiChatHandler.streamChat",
    () => ApiChatHandler.streamChat({ response: response(), ...apiArgs() }),
  ],
  [
    "streamChatWithWorkspace",
    () => streamChatWithWorkspace(response(), workspace, "Rückenkurse?"),
  ],
];

test("Erwartete Kette: die beiden Link-Zeilen ersetzt", () => {
  expect(CHAINED).toContain(
    `Kategoriepfad: Sport \\ Rücken\nKategorie-Ebene 1: Sport (40 Kurse) | ${HOST}/sport\nKurs-Link: `
  );
});

describe.each(PATHS)("%s", (_name, call) => {
  test("mit gültiger Karte: Kette an das Modell, gespeicherte Quellen unverändert", async () => {
    prisma.system_settings.findFirst.mockResolvedValue({ value: MAP_JSON() });
    await call();
    const { contextTexts } = connector.compressMessages.mock.calls[0][0];
    expect(contextTexts).toEqual([CHAINED]);
    const stored = WorkspaceChats.new.mock.calls[0][0].response;
    expect(stored.sources.map((s) => s.text)).toEqual([COURSE_TEXT]);
  });

  test("NAK-6: ohne Karte Kontext bytegleich", async () => {
    prisma.system_settings.findFirst.mockResolvedValue(null);
    await call();
    const { contextTexts } = connector.compressMessages.mock.calls[0][0];
    expect(contextTexts).toEqual([COURSE_TEXT]);
  });
});
