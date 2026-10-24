/* eslint-env jest, node */
// KIE-576 Paket 3 (E35, AK-K3) in allen Chatpfaden: Embed
// (streamChatWithForEmbed), Workspace (streamChatWithWorkspace), API
// (ApiChatHandler.chatSync/streamChat) und OpenAI-kompatibel
// (OpenAICompatibleChat.chatSync/streamChat). Mit gültigem Kursbestand kommt
// ein veraltetes Kursdokument weder als angeheftetes Dokument noch über den
// Rückgriff auf frühere Quellen (fillSourceWindow, echt) in Kontext und
// gespeicherte Quellen; Dokumente ohne Kursnummer bleiben. Die Suche selbst
// schließt veraltete Kurse im Vektorspeicher aus (courseInventoryExclusion
// .test.js), hier ist sie eine Attrappe. Ohne Kursbestand alles wie heute
// (NAK-K1). Kurskarten: der Nachschlag über Antwort-Links liefert kein
// veraltetes Dokument.

jest.mock("../../../utils/prisma", () => ({
  system_settings: { findFirst: jest.fn() },
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
      return Promise.resolve(globalThis.__pinnedDocs ?? []);
    }
  },
}));
jest.mock("../../../utils/helpers/chat/queryRewriter", () => ({
  rewriteQueryForSearch: jest.fn(async ({ userQuery }) => userQuery),
}));
jest.mock("../../../utils/chats/metadataFilterResolver", () => ({
  startMetadataFilterResolution: jest.fn(() => null),
}));

const prisma = require("../../../utils/prisma");
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
const {
  createCourseLookup,
  completeCourseSourcesFromReply,
} = require("../../../utils/chats/embedCourseSources");
const { __test__: inventory } = require("../../../utils/chats/courseInventory");

const HOST = "https://www.vhs-beispiel.de";
const courseDoc = (number, title) =>
  [
    `Titel: ${title}`,
    `Kursnummer: ${number}`,
    `Kurs-Link: ${HOST}/kurs/${number}`,
    "",
    `Kursbeschreibung: ${title} für alle.`,
  ].join("\n");
const chunk = (text, file = "kurs.txt") =>
  `<document_metadata>\nsourceDocument: ${file}\n</document_metadata>\n\n${text}`;

// Angeheftet: ein angebotener Kurs, ein veralteter, Zusatzwissen
const PINNED = () => [
  {
    title: "pin-aktuell.txt",
    pageContent: courseDoc("262-100", "Yoga aktuell"),
    token_count_estimate: 10,
  },
  {
    title: "pin-alt.txt",
    pageContent: courseDoc("262-900", "Yoga alt"),
    token_count_estimate: 10,
  },
  {
    title: "faq.txt",
    pageContent: "Wie melde ich mich an? Online.",
    token_count_estimate: 10,
  },
];
// Suche (Attrappe des Vektorspeichers, der veraltete Kurse schon ausschließt)
const SEARCH = () => [
  {
    id: "s1",
    title: "such.txt",
    text: chunk(courseDoc("262-101", "Pilates"), "such.txt"),
    score: 0.9,
  },
];
// Frühere Antwort mit Quellen: veraltet über die Vektor-ID (Folgeabschnitt
// ohne Kopfzeilen) und über den Kopfblock, dazu ein aktueller Kurs und eine
// Webseite ohne Kursnummer
const OLD_SOURCES = () => [
  {
    id: "v901",
    title: "alt-folge.txt",
    text: "Folgeabschnitt eines alten Kurses",
    score: 0.8,
  },
  {
    id: "x1",
    title: "alt-kopf.txt",
    text: chunk(courseDoc("262-555", "Tanz alt"), "alt-kopf.txt"),
    score: 0.8,
  },
  {
    id: "h1",
    title: "aktuell.txt",
    text: chunk(courseDoc("262-102", "Tanz"), "aktuell.txt"),
    score: 0.7,
  },
  {
    id: "w1",
    title: "seite.html",
    text: "Webseite: Anmeldung und Ermäßigungen",
    score: 0.6,
  },
];
const STALE_TEXT = /262-900|262-555|Folgeabschnitt eines alten Kurses/;

const INVENTORY = () =>
  JSON.stringify({
    version: 1,
    client: "vhs-beispiel",
    created: new Date(Date.now() - 60 * 1000).toISOString(),
    offered: ["262-100", "262-101", "262-102"],
  });

function useInventory(on) {
  prisma.system_settings.findFirst.mockImplementation(async ({ where }) =>
    on && where.label === "kufer_course_inventory"
      ? { value: INVENTORY() }
      : null
  );
}

const DOCS = {
  "custom-documents/d100.json": courseDoc("262-100", "Yoga aktuell"),
  "custom-documents/d900.json": courseDoc("262-900", "Yoga alt"),
  "custom-documents/d901.json": courseDoc(
    "262-901",
    "Alt ohne Kopf im Treffer"
  ),
};

let connector;
const workspace = {
  id: 1,
  slug: "ws",
  chatMode: "chat",
  openAiTemp: 1.0,
  chatProvider: "generic-openai",
  topN: 6,
};

beforeAll(() => {
  jest.spyOn(console, "log").mockImplementation(() => {});
});
afterAll(() => {
  console.log.mockRestore();
  delete globalThis.__pinnedDocs;
});

beforeEach(() => {
  jest.clearAllMocks();
  inventory.reset();
  inventory.setDeps({
    findWorkspaceId: async () => 1,
    listDocuments: async () =>
      Object.keys(DOCS).map((docpath) => ({
        docId: docpath.match(/d\d+/)[0],
        docpath,
      })),
    listVectors: async (docIds) =>
      docIds.map((docId) => ({ docId, vectorId: `v${docId.slice(1)}` })),
    readDocumentText: async (docpath) => DOCS[docpath],
    existingVectorIds: async () => null,
  });
  globalThis.__pinnedDocs = PINNED();
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
      contextTexts: SEARCH().map((s) => s.text),
      sources: SEARCH(),
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
  const history = [
    {
      id: 1,
      prompt: "Gibt es Tanz?",
      response: JSON.stringify({ text: "Ja.", sources: OLD_SOURCES() }),
    },
  ];
  recentChatHistory.mockResolvedValue({
    rawHistory: history.map((h) => ({ ...h })),
    chatHistory: [],
  });
  EmbedChats.forEmbedByUser.mockResolvedValue(history.map((h) => ({ ...h })));
});

const response = () => ({
  locals: {},
  write: jest.fn(),
  on: jest.fn(),
  removeListener: jest.fn(),
});
const apiArgs = () => ({
  workspace,
  message: "Yoga?",
  mode: "chat",
  user: null,
  thread: null,
  sessionId: null,
  attachments: [],
  reset: false,
});
const embed = () => ({
  id: 3,
  chat_mode: "chat",
  message_limit: 20,
  visual_config: JSON.stringify({ courseCards: "off" }),
  workspace: { ...workspace, messagesLimit: null },
});

const stored = (kind) =>
  kind === "embed"
    ? EmbedChats.new.mock.calls[0][0].response
    : WorkspaceChats.new.mock.calls[0][0].response;

const PATHS = [
  [
    "Embed streamChatWithForEmbed",
    "embed",
    true,
    () =>
      streamChatWithForEmbed(response(), embed(), "Yoga?", "sess", {
        conversationId: "conv",
        displayMode: "bubble",
      }),
  ],
  [
    "Workspace streamChatWithWorkspace",
    "workspace",
    true,
    () => streamChatWithWorkspace(response(), workspace, "Yoga?"),
  ],
  [
    "API ApiChatHandler.chatSync",
    "workspace",
    true,
    () => ApiChatHandler.chatSync(apiArgs()),
  ],
  [
    "API ApiChatHandler.streamChat",
    "workspace",
    true,
    () => ApiChatHandler.streamChat({ response: response(), ...apiArgs() }),
  ],
  [
    "OpenAI OpenAICompatibleChat.chatSync",
    "workspace",
    false,
    () =>
      OpenAICompatibleChat.chatSync({
        workspace,
        prompt: "Yoga?",
        messagesLimit: null,
        messageCount: 0,
      }),
  ],
  [
    "OpenAI OpenAICompatibleChat.streamChat",
    "workspace",
    false,
    () =>
      OpenAICompatibleChat.streamChat({
        workspace,
        response: response(),
        prompt: "Yoga?",
        messagesLimit: null,
        messageCount: 0,
      }),
  ],
];

describe.each(PATHS)("%s", (_name, kind, backfills, call) => {
  test("mit gültigem Kursbestand: kein veraltetes Kursdokument in Kontext und Quellen", async () => {
    useInventory(true);
    await call();
    const { contextTexts } = connector.compressMessages.mock.calls[0][0];
    for (const text of contextTexts) expect(text).not.toMatch(STALE_TEXT);
    // angeheftet: aktueller Kurs und Zusatzwissen bleiben
    expect(contextTexts).toEqual(
      expect.arrayContaining([
        courseDoc("262-100", "Yoga aktuell"),
        "Wie melde ich mich an? Online.",
        SEARCH()[0].text,
      ])
    );
    if (backfills)
      // Rückgriff: aktueller Kurs und Webseite ohne Kursnummer bleiben
      expect(contextTexts).toEqual(
        expect.arrayContaining([OLD_SOURCES()[2].text, OLD_SOURCES()[3].text])
      );
    const saved = stored(kind);
    expect(JSON.stringify(saved.sources)).not.toMatch(/262-900|pin-alt/);
    expect(saved.sources.map((s) => s.title)).toEqual(
      expect.arrayContaining(["pin-aktuell.txt", "faq.txt", "such.txt"])
    );
  });

  test("NAK-K1: ohne Kursbestand wie heute (veraltete Dokumente bleiben)", async () => {
    useInventory(false);
    await call();
    const { contextTexts } = connector.compressMessages.mock.calls[0][0];
    expect(contextTexts).toEqual(
      expect.arrayContaining([courseDoc("262-900", "Yoga alt")])
    );
    if (backfills)
      expect(contextTexts).toEqual(
        expect.arrayContaining([OLD_SOURCES()[0].text, OLD_SOURCES()[1].text])
      );
    expect(stored(kind).sources.map((s) => s.title)).toContain("pin-alt.txt");
  });
});

describe("Kurskarten: Nachschlag über Antwort-Links", () => {
  const lookupDeps = () => ({
    listDocpaths: async () => [
      "custom-documents/www-vhs-beispiel-de-kurs-262-900-11111111-1111-4111-8111-111111111111.json",
      "custom-documents/www-vhs-beispiel-de-kurs-262-100-22222222-2222-4222-8222-222222222222.json",
    ],
    readFile: async (full) =>
      JSON.stringify({
        pageContent: full.includes("262-900")
          ? courseDoc("262-900", "Yoga alt")
          : courseDoc("262-100", "Yoga aktuell"),
      }),
    documentsPath: () => "/storage/documents",
  });
  const REPLY = `Passend: [Yoga alt](${HOST}/kurs/262-900) und [Yoga aktuell](${HOST}/kurs/262-100)`;

  test("veraltetes Kursdokument ergibt keine Karte, der aktuelle Kurs schon", async () => {
    useInventory(true);
    const {
      courseInventoryGuard,
    } = require("../../../utils/chats/courseInventory");
    const guard = await courseInventoryGuard(workspace);
    const lookup = createCourseLookup({
      deps: lookupDeps(),
      hideDocument: guard.hidesDocument,
    });
    const cards = await completeCourseSourcesFromReply({
      replyText: REPLY,
      lookup,
    });
    expect(cards.map((c) => c.url)).toEqual([`${HOST}/kurs/262-100`]);
  });

  test("ohne Prüfer wie heute: beide Kurse", async () => {
    const lookup = createCourseLookup({ deps: lookupDeps() });
    const cards = await completeCourseSourcesFromReply({
      replyText: REPLY,
      lookup,
    });
    expect(cards.map((c) => c.url)).toEqual([
      `${HOST}/kurs/262-900`,
      `${HOST}/kurs/262-100`,
    ]);
  });
});
