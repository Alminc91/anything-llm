/* eslint-env jest, node */
// KIE-534: Limitprüfung für @agent im GUI-Chat.
//
// Geprüft werden beide Agent-Einstiege:
//   1. streamChatWithWorkspace (HTTP) – legt die Agent-Sitzung an,
//   2. der Websocket /agent-invocation/:uuid – führt die Sitzung.
//
// Echt sind: die Limitprüfung samt Zählfunktion (utils/helpers), die Modelle
// WorkspaceChats / WorkspaceAgentInvocation / EmbedChats /
// WorkspaceMessageAdjustments, grepAgents, der Websocket-Endpunkt, die
// AIbitat-Laufzeit und ihre Plugins websocket + chat-history.
// Attrappen sind: die Datenbank (Prisma im Speicher), der Websocket, das LLM und
// der AgentHandler (verdrahtet die echte Laufzeit ohne Skills, MCP, Provider).
const { EventEmitter } = require("events");

jest.mock("../../../utils/prisma", () => {
  const db = { chats: [], invocations: [], workspaces: [] };
  const inRange = (value, range = {}) =>
    (range.gte === undefined || value >= range.gte) &&
    (range.gt === undefined || value > range.gt) &&
    (range.lte === undefined || value <= range.lte) &&
    (range.lt === undefined || value < range.lt);

  return {
    __db: db,
    workspace_chats: {
      create: jest.fn(async ({ data }) => {
        const row = { id: db.chats.length + 1, createdAt: new Date(), ...data };
        db.chats.push(row);
        return row;
      }),
      count: jest.fn(
        async ({ where = {} } = {}) =>
          db.chats.filter(
            (row) =>
              (where.workspaceId === undefined ||
                row.workspaceId === where.workspaceId) &&
              inRange(row.createdAt, where.createdAt)
          ).length
      ),
    },
    embed_chats: { count: jest.fn(async () => 0) },
    workspace_message_adjustments: {
      aggregate: jest.fn(async () => ({ _sum: { amount: null } })),
    },
    workspace_agent_invocations: {
      create: jest.fn(async ({ data }) => {
        const row = { id: db.invocations.length + 1, closed: false, ...data };
        db.invocations.push(row);
        return row;
      }),
      update: jest.fn(async ({ where, data }) => {
        const row = db.invocations.find((inv) => inv.uuid === where.uuid);
        if (!row) throw new Error("Record to update not found.");
        return Object.assign(row, data);
      }),
      findFirst: jest.fn(async ({ where = {}, include = {} } = {}) => {
        const row = db.invocations.find((inv) => inv.uuid === where.uuid);
        if (!row) return null;
        if (!include.workspace) return { ...row };
        // Wie Prisma: jede Abfrage liefert einen eigenen Schnappschuss der
        // Zeile – spätere Änderungen am Workspace wirken nicht rückwirkend.
        const workspace = db.workspaces.find(
          (ws) => ws.id === row.workspace_id
        );
        return { ...row, workspace: workspace ? { ...workspace } : null };
      }),
    },
  };
});
jest.mock("../../../models/telemetry", () => ({
  Telemetry: { sendTelemetry: jest.fn() },
}));
jest.mock("../../../models/workspace", () => ({
  Workspace: {
    _resolveVectorSearchMode: jest.fn().mockResolvedValue("default"),
  },
}));
jest.mock("../../../models/workspaceParsedFiles", () => ({
  WorkspaceParsedFiles: { getContextFiles: jest.fn().mockResolvedValue([]) },
}));
// Die Limitprüfung und ihre Zählfunktion bleiben echt; nur LLM und Vektor-DB
// des normalen Chats werden ersetzt.
jest.mock("../../../utils/helpers", () => ({
  ...jest.requireActual("../../../utils/helpers"),
  getVectorDbClass: jest.fn(),
  getLLMProvider: jest.fn(),
}));
jest.mock("../../../utils/chats/index", () => ({
  grepCommand: jest.fn(async (message) => message),
  VALID_COMMANDS: {},
  chatPrompt: jest.fn().mockResolvedValue("System"),
  sourceIdentifier: jest.fn(),
  recentChatHistory: jest
    .fn()
    .mockResolvedValue({ rawHistory: [], chatHistory: [] }),
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

// LLM-Attrappe der Agent-Laufzeit: jeder Aufruf ist ein Agent-Zug.
const mockAgentLlm = {
  supportsAgentStreaming: false,
  attachHandlerProps: jest.fn(),
  complete: jest.fn(),
};

// AgentHandler-Attrappe: gleiche Schnittstelle wie utils/agents (init,
// createAIbitat, startAgentCluster), aber mit der echten AIbitat-Laufzeit und
// den echten Plugins websocket + chat-history statt Skills/MCP/Provider-Setup.
jest.mock("../../../utils/agents", () => {
  const AIbitat = jest.requireActual("../../../utils/agents/aibitat");
  const {
    websocket,
  } = require("../../../utils/agents/aibitat/plugins/websocket");
  const {
    chatHistory,
  } = require("../../../utils/agents/aibitat/plugins/chat-history");
  const {
    WorkspaceAgentInvocation,
  } = require("../../../models/workspaceAgentInvocation");

  class AgentHandler {
    static created = 0;
    invocation = null;
    aibitat = null;

    constructor({ uuid }) {
      this.uuid = uuid;
    }

    log() {}
    closeAlert() {}

    async init() {
      const invocation = await WorkspaceAgentInvocation.getWithWorkspace({
        uuid: String(this.uuid),
      });
      if (invocation?.closed)
        throw new Error("This agent invocation is already closed");
      this.invocation = invocation ?? null;
      return this;
    }

    async createAIbitat({ socket }) {
      AgentHandler.created++;
      this.aibitat = new AIbitat({
        provider: mockAgentLlm,
        model: "attrappe",
        chats: [],
        handlerProps: { invocation: this.invocation, log: this.log },
      });
      this.aibitat.use(
        websocket.plugin({ socket, muteUserReply: true, introspection: true })
      );
      this.aibitat.use(chatHistory.plugin());
      this.aibitat.agent("USER", { interrupt: "ALWAYS", role: "Mensch" });
      this.aibitat.agent("@agent", { role: "Assistent", functions: [] });
    }

    startAgentCluster() {
      return this.aibitat.start({
        from: "USER",
        to: "@agent",
        content: this.invocation.prompt,
      });
    }
  }

  return { AgentHandler };
});

// Schon das Laden der Agent-Laufzeit schreibt ins Log.
jest.spyOn(console, "log").mockImplementation(() => {});
jest.spyOn(console, "error").mockImplementation(() => {});

const prisma = require("../../../utils/prisma");
const helpers = require("../../../utils/helpers");
const {
  countMessagesForCurrentCycle,
} = require("../../../utils/helpers/cycleHelpers");
const { Telemetry } = require("../../../models/telemetry");
const { AgentHandler } = require("../../../utils/agents");
const { grepCommand } = require("../../../utils/chats/index");
const { streamChatWithWorkspace } = require("../../../utils/chats/stream");
const { agentWebsocket } = require("../../../endpoints/agentWebsocket");

const db = prisma.__db;
const user = { id: 7 };
const AGENT_PROMPT = "@agent Wie ist das Wetter?";
const LIMIT_TEXT = /Limit von \d+ Nachricht(en)? .* erreicht/;
const CHECK_FAILED_TEXT = /could not be verified/;

// Die drei Zählabfragen der Limitprüfung. Ihre Modelle fangen einen
// Datenbankfehler im Normalfall ab und zählen 0; dritte Spalte: der Verbrauch,
// den die tolerante Zählung dann bei drei Chat-Zeilen meldet.
const COUNT_QUERIES = [
  ["workspace_chats.count", () => prisma.workspace_chats.count, 0],
  ["embed_chats.count", () => prisma.embed_chats.count, 3],
  [
    "workspace_message_adjustments.aggregate",
    () => prisma.workspace_message_adjustments.aggregate,
    3,
  ],
];

// Der Endpunkt registriert genau eine Route – ihr Handler ist der Prüfling.
const app = { ws: jest.fn() };
agentWebsocket(app);
const [wsRoute, websocketHandler] = app.ws.mock.calls[0];

let openSockets = [];
let limitCheckSpy = null;

// Lässt die Prüffunktion selbst beim nächsten Aufruf werfen – für Fehler, die
// keine Zählabfrage sind. Einen Datenbankfehler lösen die Tests dagegen an der
// Prisma-Attrappe aus (COUNT_QUERIES), denn nur so läuft die echte Zählung mit.
// Greift an beiden Einstiegen, weil sie die Funktion erst beim Aufruf laden.
function failNextLimitCheck(error) {
  limitCheckSpy = jest
    .spyOn(helpers, "checkWorkspaceMessagesLimit")
    .mockRejectedValueOnce(error);
}

function makeWorkspace({ id = 1, messagesLimit = null, chats = 0 } = {}) {
  const workspace = {
    id,
    name: `Workspace ${id}`,
    slug: `workspace-${id}`,
    chatMode: "chat",
    messagesLimit,
    cycleStartDate: null,
  };
  db.workspaces.push(workspace);
  for (let i = 0; i < chats; i++) {
    db.chats.push({
      id: db.chats.length + 1,
      workspaceId: id,
      prompt: `Altbestand ${i + 1}`,
      response: "{}",
      user_id: user.id,
      createdAt: new Date(),
    });
  }
  return workspace;
}

// Verbrauch über die echte Zählfunktion des normalen Chats
async function usage(workspace) {
  return (await helpers.getMessageLimitInfo(workspace)).messageCount;
}

function chatRows(workspace) {
  return db.chats.filter((row) => row.workspaceId === workspace.id);
}

function makeResponse() {
  const response = { write: jest.fn(), status: jest.fn() };
  response.events = () =>
    response.write.mock.calls
      .map(([raw]) => String(raw))
      .filter((raw) => raw.startsWith("data: {"))
      .map((raw) => JSON.parse(raw.slice("data: ".length)));
  return response;
}

function makeSocket() {
  const socket = new EventEmitter();
  socket.frames = [];
  socket.closed = false;
  socket.send = jest.fn((raw) => socket.frames.push(JSON.parse(raw)));
  socket.close = jest.fn(() => {
    if (socket.closed) return;
    socket.closed = true;
    socket.emit("close");
  });
  openSockets.push(socket);
  return socket;
}

// Alles im Test läuft über Mikrotasks (keine echte I/O) – ein Makrotask-Takt
// reicht, damit Agent-Zug und Speicherung des Verlaufs abgeschlossen sind.
async function settle() {
  for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r));
}

async function sendGuiChat(workspace, message) {
  const response = makeResponse();
  await streamChatWithWorkspace(response, workspace, message, "chat", user);
  return response;
}

async function connect(uuid) {
  const socket = makeSocket();
  await websocketHandler(socket, { params: { uuid } });
  await settle();
  return socket;
}

// Vollständiger Start wie im Browser: HTTP-Nachricht, dann Websocket.
async function startSession(workspace, message = AGENT_PROMPT) {
  const response = await sendGuiChat(workspace, message);
  const init = response
    .events()
    .find((event) => event.type === "agentInitWebsocketConnection");
  const socket = init ? await connect(init.websocketUUID) : null;
  return { response, socket, uuid: init?.websocketUUID ?? null };
}

// Weitere Nutzernachricht in der laufenden Sitzung, so wie das Frontend sie sendet.
async function say(socket, feedback) {
  socket.emit(
    "message",
    JSON.stringify({ type: "awaitingFeedback", feedback })
  );
  await settle();
}

const agentReplies = (socket) =>
  socket.frames.filter((frame) => frame.from === "@agent");
const failures = (socket) =>
  socket.frames.filter((frame) => frame.type === "wssFailure");
const waitingPrompts = (socket) =>
  socket.frames.filter((frame) => frame.type === "WAITING_ON_INPUT");

afterAll(() => {
  console.log.mockRestore();
  console.error.mockRestore();
});

beforeEach(() => {
  jest.clearAllMocks();
  db.chats.length = 0;
  db.invocations.length = 0;
  db.workspaces.length = 0;
  openSockets = [];
  AgentHandler.created = 0;

  let turn = 0;
  mockAgentLlm.complete.mockImplementation(async () => ({
    textResponse: `Antwort ${++turn}`,
    cost: 0,
  }));
  helpers.getLLMProvider.mockReturnValue({
    promptWindowLimit: jest.fn().mockReturnValue(4096),
    compressMessages: jest.fn(),
    streamingEnabled: jest.fn(),
    getChatCompletion: jest.fn(),
    streamGetChatCompletion: jest.fn(),
    handleStream: jest.fn(),
  });
  helpers.getVectorDbClass.mockReturnValue({
    hasNamespace: jest.fn().mockResolvedValue(false),
    namespaceCount: jest.fn().mockResolvedValue(0),
    performSimilaritySearch: jest.fn(),
  });
});

afterEach(async () => {
  // Wartende Sitzungen sauber beenden, sonst bleibt der 5-Minuten-Timer des
  // Websocket-Plugins offen.
  for (const socket of openSockets) {
    if (socket.handleFeedback) await say(socket, "exit");
  }
  limitCheckSpy?.mockRestore();
  limitCheckSpy = null;
});

test("der Websocket-Endpunkt hängt an der Route der Agent-Sitzung", () => {
  expect(wsRoute).toBe("/agent-invocation/:uuid");
});

describe("AK-1 start_blockiert", () => {
  test("start_blockiert: @agent bei erreichtem Limit liefert die Limit-Meldung des normalen Chats, keine Sitzung, kein LLM", async () => {
    const workspace = makeWorkspace({ messagesLimit: 3, chats: 3 });

    const normal = await sendGuiChat(workspace, "Wie ist das Wetter?");
    const llmCallsNormal = helpers.getLLMProvider.mock.calls.length;
    const agent = await sendGuiChat(workspace, AGENT_PROMPT);

    const [normalEvent] = normal.events();
    const agentEvents = agent.events();
    expect(agentEvents).toHaveLength(1);
    expect(agentEvents[0].type).toBe("textResponse");
    expect(agentEvents[0].textResponse).toMatch(LIMIT_TEXT);
    expect(agentEvents[0].close).toBe(true);
    // Bis auf die Nachrichten-ID identisch mit der Meldung des normalen Chats
    expect({ ...agentEvents[0], id: null }).toEqual({
      ...normalEvent,
      id: null,
    });
    expect(agent.status).toHaveBeenCalledWith(429);

    // keine Agent-Sitzung
    expect(db.invocations).toHaveLength(0);
    expect(prisma.workspace_agent_invocations.create).not.toHaveBeenCalled();
    expect(
      agentEvents.some((event) => event.type === "agentInitWebsocketConnection")
    ).toBe(false);

    // kein LLM – weder der Chat-Connector noch das Agent-Modell
    expect(helpers.getLLMProvider.mock.calls.length).toBe(llmCallsNormal);
    expect(mockAgentLlm.complete).not.toHaveBeenCalled();
    expect(AgentHandler.created).toBe(0);
  });

  test("start_blockiert: auch in einem Thread", async () => {
    const workspace = makeWorkspace({ messagesLimit: 1, chats: 1 });
    const response = makeResponse();
    await streamChatWithWorkspace(
      response,
      workspace,
      AGENT_PROMPT,
      "chat",
      user,
      { id: 11, slug: "thread-11" }
    );

    expect(response.events()).toHaveLength(1);
    expect(response.events()[0].textResponse).toMatch(LIMIT_TEXT);
    expect(db.invocations).toHaveLength(0);
  });

  test("start_blockiert: ein Preset-Befehl, der zu @agent expandiert, wird genauso abgewiesen", async () => {
    const workspace = makeWorkspace({ messagesLimit: 3, chats: 3 });
    // /wetter ist ein Slash-Preset des Nutzers mit dem Prompt "@agent …"
    grepCommand.mockResolvedValueOnce(AGENT_PROMPT);

    const response = await sendGuiChat(workspace, "/wetter");

    const events = response.events();
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("textResponse");
    expect(events[0].textResponse).toMatch(LIMIT_TEXT);
    expect(response.status).toHaveBeenCalledWith(429);
    expect(db.invocations).toHaveLength(0);
    expect(prisma.workspace_agent_invocations.create).not.toHaveBeenCalled();
    expect(mockAgentLlm.complete).not.toHaveBeenCalled();
  });

  test("start_blockiert: Websocket-Verbindung zu einer bestehenden Invocation startet bei erreichtem Limit keinen Agenten", async () => {
    const workspace = makeWorkspace({ messagesLimit: 3, chats: 2 });
    // Sitzung wird unter dem Limit angelegt …
    const response = await sendGuiChat(workspace, AGENT_PROMPT);
    const { websocketUUID } = response.events()[0];
    expect(db.invocations).toHaveLength(1);

    // … bis der Websocket verbindet, ist das Limit erreicht.
    db.chats.push({
      id: db.chats.length + 1,
      workspaceId: workspace.id,
      prompt: "anderer Nutzer",
      response: "{}",
      createdAt: new Date(),
    });
    const expected = await helpers.checkWorkspaceMessagesLimit(
      workspace,
      null,
      { returnData: true }
    );
    const socket = await connect(websocketUUID);

    expect(socket.frames).toEqual([
      { type: "wssFailure", content: expected.errorData.error },
    ]);
    expect(socket.frames[0].content).toMatch(LIMIT_TEXT);
    expect(socket.close).toHaveBeenCalled();
    expect(db.invocations[0].closed).toBe(true);
    expect(AgentHandler.created).toBe(0);
    expect(mockAgentLlm.complete).not.toHaveBeenCalled();
    expect(Telemetry.sendTelemetry).not.toHaveBeenCalledWith(
      "agent_chat_started"
    );
    expect(chatRows(workspace)).toHaveLength(3);
  });
});

describe("AK-2 sitzung_blockiert", () => {
  test("sitzung_blockiert: bei Verbrauch = Limit − 1 wird die erste weitere Nachricht beantwortet, die zweite abgewiesen und die Sitzung beendet", async () => {
    const workspace = makeWorkspace({ messagesLimit: 5, chats: 3 });
    const { socket, uuid } = await startSession(workspace);

    // laufende Sitzung, Verbrauch = Limit − 1
    expect(agentReplies(socket)).toHaveLength(1);
    expect(waitingPrompts(socket)).toHaveLength(1);
    expect(await usage(workspace)).toBe(4);
    expect(socket.closed).toBe(false);

    await say(socket, "Und morgen?");
    expect(agentReplies(socket).map((frame) => frame.content)).toEqual([
      "Antwort 1",
      "Antwort 2",
    ]);
    expect(waitingPrompts(socket)).toHaveLength(2);
    expect(failures(socket)).toHaveLength(0);
    expect(socket.closed).toBe(false);
    expect(await usage(workspace)).toBe(5);

    const framesBefore = socket.frames.length;
    await say(socket, "Und übermorgen?");

    const expected = await helpers.checkWorkspaceMessagesLimit(
      workspace,
      null,
      { returnData: true }
    );
    expect(socket.frames.slice(framesBefore)).toEqual([
      { type: "wssFailure", content: expected.errorData.error },
    ]);
    expect(socket.frames.at(-1).content).toMatch(LIMIT_TEXT);

    // Sitzung beendet: Socket zu, Invocation geschlossen, kein dritter Agent-Zug
    expect(socket.close).toHaveBeenCalledTimes(1);
    expect(socket.closed).toBe(true);
    expect(db.invocations.find((inv) => inv.uuid === uuid).closed).toBe(true);
    expect(mockAgentLlm.complete).toHaveBeenCalledTimes(2);

    // Nachzügler auf dem beendeten Socket bleiben wirkungslos
    await say(socket, "Hallo?");
    expect(mockAgentLlm.complete).toHaveBeenCalledTimes(2);
    expect(socket.frames).toHaveLength(framesBefore + 1);
    expect(await usage(workspace)).toBe(5);
  });

  test("sitzung_blockiert: die Limit-Meldung der Sitzung trägt denselben Text wie die des normalen Chats", async () => {
    const workspace = makeWorkspace({ messagesLimit: 2, chats: 1 });
    const { socket } = await startSession(workspace);
    await say(socket, "Noch eine Frage");

    const normal = await sendGuiChat(workspace, "Normale Frage");
    expect(failures(socket)).toHaveLength(1);
    expect(failures(socket)[0].content).toBe(normal.events()[0].textResponse);
  });

  test.each([
    ["gesenkt (100 → 4)", 100, 4],
    ["erstmals gesetzt (unbegrenzt → 4)", null, 4],
    ["zum Sperren auf 0 gesetzt", null, 0],
  ])(
    "sitzung_blockiert: Limit während der Sitzung %s – die nächste Nachricht wird abgewiesen",
    async (_fall, limitAtStart, limitNow) => {
      const workspace = makeWorkspace({
        messagesLimit: limitAtStart,
        chats: 3,
      });
      const { socket, uuid } = await startSession(workspace);
      expect(await usage(workspace)).toBe(4);
      expect(failures(socket)).toHaveLength(0);

      // Admin-GUI bzw. Kundenmanager ändern die Zeile in der Datenbank.
      workspace.messagesLimit = limitNow;
      const expected = await helpers.checkWorkspaceMessagesLimit(
        workspace,
        null,
        { returnData: true }
      );
      const framesBefore = socket.frames.length;
      await say(socket, "Und morgen?");

      expect(socket.frames.slice(framesBefore)).toEqual([
        { type: "wssFailure", content: expected.errorData.error },
      ]);
      expect(socket.frames.at(-1).content).toMatch(LIMIT_TEXT);
      expect(socket.closed).toBe(true);
      expect(db.invocations.find((inv) => inv.uuid === uuid).closed).toBe(true);
      expect(mockAgentLlm.complete).toHaveBeenCalledTimes(1);
      expect(await usage(workspace)).toBe(4);
    }
  );

  test("sitzung_blockiert: ein während der Sitzung angehobenes Limit gilt ebenfalls sofort", async () => {
    const workspace = makeWorkspace({ messagesLimit: 2, chats: 1 });
    const { socket } = await startSession(workspace);
    expect(await usage(workspace)).toBe(2);

    workspace.messagesLimit = 10;
    await say(socket, "Und morgen?");

    expect(agentReplies(socket)).toHaveLength(2);
    expect(failures(socket)).toHaveLength(0);
    expect(socket.closed).toBe(false);
    expect(await usage(workspace)).toBe(3);
  });

  test("sitzung_blockiert: sofort antwortender Client – die Prüfung wartet auf das Speichern der vorigen Chat-Zeile", async () => {
    const workspace = makeWorkspace({ messagesLimit: 2, chats: 1 });
    // Das Speichern der ersten Antwort bleibt offen, bis der Test es freigibt.
    let releaseSave;
    const insertRow = prisma.workspace_chats.create.getMockImplementation();
    prisma.workspace_chats.create.mockImplementationOnce(async (args) => {
      await new Promise((resolve) => (releaseSave = resolve));
      return insertRow(args);
    });

    const { socket } = await startSession(workspace);
    expect(agentReplies(socket)).toHaveLength(1);
    expect(waitingPrompts(socket)).toHaveLength(1);
    // Verbrauch noch auf dem alten Stand: Limit − 1
    expect(chatRows(workspace)).toHaveLength(1);

    // Die Nachricht trifft ein, bevor die Zeile geschrieben ist: weder
    // beantwortet noch abgewiesen, solange das Speichern läuft.
    await say(socket, "Sofort hinterher");
    expect(mockAgentLlm.complete).toHaveBeenCalledTimes(1);
    expect(socket.frames).toHaveLength(2);
    expect(socket.closed).toBe(false);

    releaseSave();
    await settle();

    expect(chatRows(workspace)).toHaveLength(2);
    expect(failures(socket)).toHaveLength(1);
    expect(failures(socket)[0].content).toMatch(LIMIT_TEXT);
    expect(socket.closed).toBe(true);
    expect(mockAgentLlm.complete).toHaveBeenCalledTimes(1);
    expect(
      chatRows(workspace).some((row) => row.prompt === "Sofort hinterher")
    ).toBe(false);
  });

  test("sitzung_blockiert: /exit bei erreichtem Limit beendet die Sitzung ohne Limit-Meldung", async () => {
    const workspace = makeWorkspace({ messagesLimit: 2, chats: 1 });
    const { socket } = await startSession(workspace);
    expect(await usage(workspace)).toBe(2);

    await say(socket, "/exit");
    expect(socket.closed).toBe(true);
    expect(failures(socket)).toHaveLength(0);
  });
});

describe("AK-3 unter_limit", () => {
  test("unter_limit: Sitzung mit zwei Nachrichten erzeugt zwei Chat-Zeilen, Verbrauch +2, Ablauf unverändert", async () => {
    const workspace = makeWorkspace({ messagesLimit: 100, chats: 10 });
    const usageBefore = await usage(workspace);

    const { response, socket, uuid } = await startSession(workspace);
    await say(socket, "Und morgen?");

    // HTTP-Antwort beim Start: unverändert Websocket-Übergabe + Statusmeldung
    const events = response.events();
    expect(events).toEqual([
      {
        id: events[0].id,
        type: "agentInitWebsocketConnection",
        textResponse: null,
        sources: [],
        close: false,
        error: null,
        websocketUUID: uuid,
      },
      {
        id: events[0].id,
        type: "statusResponse",
        textResponse:
          "Agent @agent invoked.\nSwapping over to agent chat. Type /exit to exit agent execution loop early.",
        sources: [],
        close: true,
        error: null,
        animate: true,
      },
    ]);
    expect(response.status).not.toHaveBeenCalled();

    // Websocket: nur Antworten und Eingabeaufforderungen, sonst nichts
    expect(
      socket.frames.map(
        (frame) => frame.type ?? `${frame.from}:${frame.content}`
      )
    ).toEqual([
      "@agent:Antwort 1",
      "WAITING_ON_INPUT",
      "@agent:Antwort 2",
      "WAITING_ON_INPUT",
    ]);
    expect(socket.closed).toBe(false);
    expect(Telemetry.sendTelemetry).toHaveBeenCalledWith("agent_chat_started");

    // zwei Chat-Zeilen, Verbrauch +2
    const rows = chatRows(workspace).slice(10);
    expect(
      rows.map((row) => [row.prompt, JSON.parse(row.response).text])
    ).toEqual([
      [AGENT_PROMPT, "Antwort 1"],
      ["Und morgen?", "Antwort 2"],
    ]);
    expect(rows.every((row) => row.user_id === user.id)).toBe(true);
    expect(await usage(workspace)).toBe(usageBefore + 2);
    expect(mockAgentLlm.complete).toHaveBeenCalledTimes(2);

    // Ende per /exit wie bisher, ohne weitere Zeile
    await say(socket, "/exit");
    expect(socket.closed).toBe(true);
    expect(failures(socket)).toHaveLength(0);
    expect(db.invocations[0].closed).toBe(true);
    expect(await usage(workspace)).toBe(usageBefore + 2);
  });

  test("unter_limit: die letzte freie Nachricht (Verbrauch = Limit − 1) startet die Sitzung noch", async () => {
    const workspace = makeWorkspace({ messagesLimit: 4, chats: 3 });
    const { socket } = await startSession(workspace);

    expect(agentReplies(socket)).toHaveLength(1);
    expect(failures(socket)).toHaveLength(0);
    expect(await usage(workspace)).toBe(4);
  });
});

describe("AK-4 unbegrenzt", () => {
  test("unbegrenzt: messagesLimit = null weist nie ab", async () => {
    const workspace = makeWorkspace({ messagesLimit: null, chats: 50 });
    const { response, socket } = await startSession(workspace);
    for (const text of ["zwei", "drei", "vier", "fünf"])
      await say(socket, text);

    expect(response.events()[0].type).toBe("agentInitWebsocketConnection");
    expect(agentReplies(socket)).toHaveLength(5);
    expect(failures(socket)).toHaveLength(0);
    expect(socket.closed).toBe(false);
    expect(await usage(workspace)).toBe(55);
    expect(mockAgentLlm.complete).toHaveBeenCalledTimes(5);
  });
});

describe("NAK-1 keine_zeile", () => {
  test("keine_zeile: abgewiesener Start erzeugt weder Chat-Zeile noch Verbrauch", async () => {
    const workspace = makeWorkspace({ messagesLimit: 3, chats: 3 });
    await sendGuiChat(workspace, AGENT_PROMPT);
    await settle();

    expect(prisma.workspace_chats.create).not.toHaveBeenCalled();
    expect(chatRows(workspace)).toHaveLength(3);
    expect(await usage(workspace)).toBe(3);
  });

  test("keine_zeile: in der Sitzung abgewiesene Nachricht erzeugt weder Chat-Zeile noch Verbrauch", async () => {
    const workspace = makeWorkspace({ messagesLimit: 2, chats: 1 });
    const { socket } = await startSession(workspace);
    expect(prisma.workspace_chats.create).toHaveBeenCalledTimes(1);

    await say(socket, "Diese Nachricht wird abgewiesen");
    await settle();

    expect(failures(socket)).toHaveLength(1);
    expect(prisma.workspace_chats.create).toHaveBeenCalledTimes(1);
    expect(chatRows(workspace)).toHaveLength(2);
    expect(
      chatRows(workspace).some(
        (row) => row.prompt === "Diese Nachricht wird abgewiesen"
      )
    ).toBe(false);
    expect(await usage(workspace)).toBe(2);
  });
});

describe("NAK-2 pruefung_fehlt", () => {
  const dbError = new Error("SQLITE_BUSY: database is locked");
  let unhandled;
  const onUnhandled = (reason) => unhandled.push(reason);

  beforeEach(() => {
    unhandled = [];
    process.on("unhandledRejection", onUnhandled);
  });

  afterEach(() => {
    process.off("unhandledRejection", onUnhandled);
  });

  test.each(COUNT_QUERIES)(
    "pruefung_fehlt: Datenbankfehler in %s während der Sitzung beendet sie mit Fehlermeldung – kein stilles Durchlassen, kein Absturz",
    async (_name, query) => {
      // Verbrauch = Limit: Ein als 0 gezählter Fehler ließe die Nachricht durch.
      const workspace = makeWorkspace({ messagesLimit: 2, chats: 1 });
      const { socket, uuid } = await startSession(workspace);
      expect(await usage(workspace)).toBe(2);
      const framesBefore = socket.frames.length;

      query().mockRejectedValueOnce(dbError);
      await say(socket, "Noch eine Frage");
      await settle();

      const tail = socket.frames.slice(framesBefore);
      expect(tail).toHaveLength(1);
      expect(tail[0].type).toBe("wssFailure");
      expect(tail[0].content).toMatch(CHECK_FAILED_TEXT);
      // kein Datenbank-Interna im Client
      expect(tail[0].content).not.toContain("SQLITE");
      expect(socket.closed).toBe(true);
      expect(db.invocations.find((inv) => inv.uuid === uuid).closed).toBe(true);
      expect(mockAgentLlm.complete).toHaveBeenCalledTimes(1);
      expect(chatRows(workspace)).toHaveLength(2);
      expect(unhandled).toEqual([]);
    }
  );

  test.each(COUNT_QUERIES)(
    "pruefung_fehlt: Datenbankfehler in %s beim Verbinden startet keinen Agenten",
    async (_name, query) => {
      const workspace = makeWorkspace({ messagesLimit: 3, chats: 2 });
      const response = await sendGuiChat(workspace, AGENT_PROMPT);
      const { websocketUUID } = response.events()[0];
      // Bis der Websocket verbindet, ist das Limit erreicht.
      db.chats.push({
        id: db.chats.length + 1,
        workspaceId: workspace.id,
        prompt: "anderer Nutzer",
        response: "{}",
        createdAt: new Date(),
      });

      query().mockRejectedValueOnce(dbError);
      const socket = await connect(websocketUUID);

      expect(socket.frames).toHaveLength(1);
      expect(socket.frames[0].type).toBe("wssFailure");
      expect(socket.frames[0].content).toMatch(CHECK_FAILED_TEXT);
      expect(socket.frames[0].content).not.toContain("SQLITE");
      expect(socket.closed).toBe(true);
      expect(AgentHandler.created).toBe(0);
      expect(mockAgentLlm.complete).not.toHaveBeenCalled();
      expect(Telemetry.sendTelemetry).not.toHaveBeenCalledWith(
        "agent_chat_started"
      );
      expect(chatRows(workspace)).toHaveLength(3);
      expect(unhandled).toEqual([]);
    }
  );

  test.each(COUNT_QUERIES)(
    "pruefung_fehlt: Datenbankfehler in %s beim Start legt keine Sitzung an und meldet den Fehler neutral",
    async (_name, query) => {
      const workspace = makeWorkspace({ messagesLimit: 3, chats: 3 });

      query().mockRejectedValueOnce(dbError);
      const response = await sendGuiChat(workspace, AGENT_PROMPT);

      const events = response.events();
      expect(events).toEqual([
        {
          id: expect.any(String),
          type: "abort",
          textResponse: null,
          sources: [],
          close: true,
          error: expect.stringMatching(CHECK_FAILED_TEXT),
        },
      ]);
      expect(JSON.stringify(events)).not.toContain("SQLITE");
      expect(db.invocations).toHaveLength(0);
      expect(prisma.workspace_agent_invocations.create).not.toHaveBeenCalled();
      expect(AgentHandler.created).toBe(0);
      expect(mockAgentLlm.complete).not.toHaveBeenCalled();
      expect(chatRows(workspace)).toHaveLength(3);
    }
  );

  test.each([
    ["wirft", (findFirst) => findFirst.mockRejectedValueOnce(dbError)],
    ["findet nichts", (findFirst) => findFirst.mockResolvedValueOnce(null)],
  ])(
    "pruefung_fehlt: das Laden des Workspaces %s – die Sitzung endet mit Fehlermeldung",
    async (_fall, breakLoad) => {
      const workspace = makeWorkspace({ messagesLimit: 100, chats: 0 });
      const { socket, uuid } = await startSession(workspace);
      const framesBefore = socket.frames.length;

      breakLoad(prisma.workspace_agent_invocations.findFirst);
      await say(socket, "Noch eine Frage");
      await settle();

      const tail = socket.frames.slice(framesBefore);
      expect(tail).toHaveLength(1);
      expect(tail[0].type).toBe("wssFailure");
      expect(tail[0].content).toMatch(CHECK_FAILED_TEXT);
      expect(tail[0].content).not.toContain("SQLITE");
      expect(socket.closed).toBe(true);
      expect(db.invocations.find((inv) => inv.uuid === uuid).closed).toBe(true);
      expect(mockAgentLlm.complete).toHaveBeenCalledTimes(1);
      expect(chatRows(workspace)).toHaveLength(1);
      expect(unhandled).toEqual([]);
    }
  );

  test("pruefung_fehlt: die Prüfung am Socket wirft nie, auch wenn nach dem Datenbankfehler das Senden fehlschlägt", async () => {
    const workspace = makeWorkspace({ messagesLimit: 100, chats: 0 });
    const { socket } = await startSession(workspace);

    prisma.workspace_chats.count.mockRejectedValueOnce(dbError);
    socket.send.mockImplementationOnce(() => {
      throw new Error("WebSocket is not open");
    });

    await expect(socket.checkMessagesLimit()).resolves.toBe(true);
    expect(socket.closed).toBe(true);
    expect(unhandled).toEqual([]);
  });

  test("pruefung_fehlt: wirft die Prüffunktion selbst (kein Zählfehler), endet die Sitzung ebenfalls mit Fehlermeldung", async () => {
    const workspace = makeWorkspace({ messagesLimit: 100, chats: 0 });
    const { socket } = await startSession(workspace);
    const framesBefore = socket.frames.length;

    failNextLimitCheck(new TypeError("unerwarteter Programmfehler"));
    await say(socket, "Noch eine Frage");
    await settle();

    const tail = socket.frames.slice(framesBefore);
    expect(tail).toHaveLength(1);
    expect(tail[0].type).toBe("wssFailure");
    expect(tail[0].content).toMatch(CHECK_FAILED_TEXT);
    expect(tail[0].content).not.toContain("Programmfehler");
    expect(socket.closed).toBe(true);
    expect(mockAgentLlm.complete).toHaveBeenCalledTimes(1);
    expect(unhandled).toEqual([]);
  });

  test("pruefung_fehlt: wirft die Prüffunktion selbst beim Start, entsteht keine Sitzung", async () => {
    const workspace = makeWorkspace({ messagesLimit: 100, chats: 0 });
    failNextLimitCheck(new TypeError("unerwarteter Programmfehler"));

    const response = await sendGuiChat(workspace, AGENT_PROMPT);

    const events = response.events();
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("abort");
    expect(events[0].error).toMatch(CHECK_FAILED_TEXT);
    expect(events[0].error).not.toContain("Programmfehler");
    expect(db.invocations).toHaveLength(0);
    expect(mockAgentLlm.complete).not.toHaveBeenCalled();
  });

  test("pruefung_fehlt: ein Speicherfehler der vorigen Chat-Zeile hält die nächste Nachricht nicht auf", async () => {
    const workspace = makeWorkspace({ messagesLimit: 100, chats: 0 });
    prisma.workspace_chats.create.mockRejectedValueOnce(dbError);
    const { socket } = await startSession(workspace);

    await say(socket, "Noch eine Frage");

    expect(agentReplies(socket)).toHaveLength(2);
    expect(failures(socket)).toHaveLength(0);
    expect(socket.closed).toBe(false);
    expect(unhandled).toEqual([]);
  });
});

// Die strikte Zählung ist dieselbe Zählfunktion wie im normalen Chat – nur mit
// throwOnError. Ohne die Option bleibt sie fehlertolerant wie bisher.
describe("NAK-2 Zählfehler: throwOnError der Limitprüfung", () => {
  const dbError = new Error("SQLITE_BUSY: database is locked");

  test.each(COUNT_QUERIES)(
    "ohne throwOnError bleibt ein Fehler in %s wie bisher eine 0 (normaler Chat, API-Pfade)",
    async (_name, query, toleratedCount) => {
      const workspace = makeWorkspace({ messagesLimit: 3, chats: 3 });
      query().mockRejectedValueOnce(dbError);

      const result = await helpers.checkWorkspaceMessagesLimit(
        workspace,
        null,
        { returnData: true }
      );

      expect(result.messageCount).toBe(toleratedCount);
      expect(result.limitReached).toBe(toleratedCount >= 3);
    }
  );

  test.each(COUNT_QUERIES)(
    "mit throwOnError reicht die Prüfung einen Fehler in %s weiter",
    async (_name, query) => {
      const workspace = makeWorkspace({ messagesLimit: 3, chats: 3 });
      query().mockRejectedValueOnce(dbError);

      await expect(
        helpers.checkWorkspaceMessagesLimit(workspace, null, {
          returnData: true,
          throwOnError: true,
        })
      ).rejects.toThrow(dbError.message);
    }
  );

  test.each(COUNT_QUERIES)(
    "mit throwOnError auch bei zyklusbasierter Zählung (%s)",
    async (_name, query) => {
      const workspace = makeWorkspace({ messagesLimit: 3, chats: 3 });
      workspace.cycleStartDate = new Date(Date.now() - 24 * 60 * 60 * 1000);
      workspace.cycleDurationMonths = 1;
      query().mockRejectedValueOnce(dbError);

      // Seit KIE-531 ist das zweite Argument der Bezugszeitpunkt des Fensters.
      await expect(
        helpers.getMessageLimitInfo(workspace, new Date(), {
          throwOnError: true,
        })
      ).rejects.toThrow(dbError.message);
      // tolerant wie bisher, sobald die Option fehlt
      query().mockRejectedValueOnce(dbError);
      await expect(helpers.getMessageLimitInfo(workspace)).resolves.toEqual(
        expect.objectContaining({ messagesLimit: 3 })
      );
    }
  );

  // Seit KIE-531 zählt getMessageLimitInfo direkt im Abrechnungsfenster. Die
  // Zählhelfer für Kalendermonat und Zyklus reichen die Option ebenfalls weiter.
  test.each(COUNT_QUERIES)(
    "mit throwOnError auch in der Monats- und der Zykluszählung (%s)",
    async (_name, query, toleratedCount) => {
      const workspace = makeWorkspace({ messagesLimit: 3, chats: 3 });
      const strict = { throwOnError: true };

      query().mockRejectedValueOnce(dbError);
      await expect(
        helpers.countMessagesForCurrentMonth(workspace, strict)
      ).rejects.toThrow(dbError.message);
      query().mockRejectedValueOnce(dbError);
      await expect(
        countMessagesForCurrentCycle(workspace, null, strict)
      ).rejects.toThrow(dbError.message);

      // tolerant wie bisher, sobald die Option fehlt
      query().mockRejectedValueOnce(dbError);
      expect(
        (await helpers.countMessagesForCurrentMonth(workspace)).total
      ).toBe(toleratedCount);
      query().mockRejectedValueOnce(dbError);
      expect((await countMessagesForCurrentCycle(workspace)).total).toBe(
        toleratedCount
      );
    }
  );

  test("mit throwOnError ohne Fehler: gleiches Ergebnis wie ohne", async () => {
    const workspace = makeWorkspace({ messagesLimit: 3, chats: 3 });

    const tolerant = await helpers.checkWorkspaceMessagesLimit(
      workspace,
      null,
      { returnData: true, uuid: "fest" }
    );
    const strict = await helpers.checkWorkspaceMessagesLimit(workspace, null, {
      returnData: true,
      uuid: "fest",
      throwOnError: true,
    });

    expect(strict).toEqual(tolerant);
    expect(strict.limitReached).toBe(true);
  });

  test("fehlende Tabelle der Kontingent-Buchungen ist kein Zählfehler: ohne Tabelle gibt es keine Buchungen", async () => {
    const workspace = makeWorkspace({ messagesLimit: 3, chats: 3 });
    prisma.workspace_message_adjustments.aggregate.mockRejectedValueOnce(
      Object.assign(
        new Error(
          "The table `main.workspace_message_adjustments` does not exist in the current database."
        ),
        { code: "P2021" }
      )
    );

    const result = await helpers.checkWorkspaceMessagesLimit(workspace, null, {
      returnData: true,
      throwOnError: true,
    });

    expect(result.messageCount).toBe(3);
    expect(result.limitReached).toBe(true);
  });
});
