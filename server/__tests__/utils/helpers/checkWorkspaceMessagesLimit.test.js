/* eslint-env jest, node */
// KIE-531 / NAK-4 — Die Limitprüfung bleibt unverändert: gleiche Meldung,
// gleiches Sperrverhalten. Die erwarteten Texte sind die Ausgaben des Standes
// vor KIE-531 (origin/master @ 73afab1b, TZ=Europe/Berlin) für dieselben
// Eingaben. Geändert haben sich nur die Fenstergrenzen dahinter.
//
// Die Zeitzone des Prozesses wird nicht gesetzt; die Erwartungen gelten für
// TZ=UTC, TZ=Europe/Berlin und TZ=America/New_York (NAK-3).
//
// KIE-534 (NAK-3): Die bestehende Limitprüfung des normalen GUI-Chats bleibt
// unverändert – Ergebnis und Zeitpunkt. Nachrichten ohne @agent werden genau
// einmal geprüft, nach der Vektorsuche und vor dem LLM-Aufruf; nur
// @agent-Nachrichten werden vorab geprüft, bevor eine Sitzung angelegt wird.

jest.mock("../../../utils/prisma", () => ({}));
jest.mock("../../../models/workspaceChats", () => ({
  WorkspaceChats: { count: jest.fn(), new: jest.fn() },
}));
jest.mock("../../../models/embedChats", () => ({
  EmbedChats: { countForWorkspaceInDateRange: jest.fn() },
}));
jest.mock("../../../models/workspaceMessageAdjustments", () => ({
  WorkspaceMessageAdjustments: { sumForWorkspaceInDateRange: jest.fn() },
}));
jest.mock("../../../models/workspaceAgentInvocation", () => {
  const actual = jest.requireActual("../../../models/workspaceAgentInvocation");
  return {
    WorkspaceAgentInvocation: {
      ...actual.WorkspaceAgentInvocation,
      new: jest.fn(),
    },
  };
});
jest.mock("../../../models/workspace", () => ({
  Workspace: {
    _resolveVectorSearchMode: jest.fn().mockResolvedValue("default"),
  },
}));
jest.mock("../../../models/workspaceParsedFiles", () => ({
  WorkspaceParsedFiles: { getContextFiles: jest.fn().mockResolvedValue([]) },
}));
// Die Limitprüfung bleibt echt; nur LLM und Vektor-DB werden ersetzt.
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
jest.mock("../../../utils/helpers/chat", () => ({
  fillSourceWindow: jest.fn(() => ({ contextTexts: [], sources: [] })),
}));

const { WorkspaceChats } = require("../../../models/workspaceChats");
const { EmbedChats } = require("../../../models/embedChats");
const {
  WorkspaceMessageAdjustments,
} = require("../../../models/workspaceMessageAdjustments");
const {
  WorkspaceAgentInvocation,
} = require("../../../models/workspaceAgentInvocation");
const helpers = require("../../../utils/helpers");
const { writeResponseChunk } = require("../../../utils/helpers/chat/responses");
const { streamChatWithWorkspace } = require("../../../utils/chats/stream");

const { checkWorkspaceMessagesLimit, getWorkspaceMessageLimitErrorText } =
  helpers;
const LIMIT_TEXT = /Limit von 5 Nachrichten .* erreicht/;

function mockCounts({ chats = 0, embeds = 0, adjustments = 0 } = {}) {
  WorkspaceChats.count.mockResolvedValue(chats);
  EmbedChats.countForWorkspaceInDateRange.mockResolvedValue(embeds);
  WorkspaceMessageAdjustments.sumForWorkspaceInDateRange.mockResolvedValue(
    adjustments
  );
}

const monthlyWorkspace = { id: 1, name: "W", slug: "w", messagesLimit: 600 };
const cycleWorkspace = {
  ...monthlyWorkspace,
  cycleStartDate: new Date("2026-01-15"),
  cycleDurationMonths: 3,
};

function makeWorkspace(messagesLimit = 5) {
  return {
    id: 5,
    name: "Test",
    slug: "test-ws",
    chatMode: "chat",
    messagesLimit,
    cycleStartDate: null,
  };
}

function mockResponse() {
  const response = {
    status: jest.fn(() => response),
    json: jest.fn(() => response),
  };
  return response;
}

function makeResponse() {
  const response = {
    write: jest.fn(),
    status: jest.fn(),
    json: jest.fn(),
  };
  response.status.mockReturnValue(response);
  response.events = () =>
    response.write.mock.calls
      .map(([raw]) => String(raw))
      .filter((raw) => raw.startsWith("data: {"))
      .map((raw) => JSON.parse(raw.slice("data: ".length)));
  return response;
}

function setNow(iso) {
  jest.useFakeTimers().setSystemTime(new Date(iso));
}

let logSpy;
beforeEach(() => {
  jest.clearAllMocks();
  mockCounts();
  logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  logSpy.mockRestore();
  jest.useRealTimers();
});

describe("checkWorkspaceMessagesLimit - Meldung unverändert", () => {
  test("Kalendermonat, deutsch", async () => {
    setNow("2026-10-12T10:00:00+02:00");
    mockCounts({ chats: 600 });
    const result = await checkWorkspaceMessagesLimit(monthlyWorkspace, null, {
      returnData: true,
      uuid: "u",
    });
    expect(result).toEqual({
      limitReached: true,
      messageCount: 600,
      messagesLimit: 600,
      cycleInfo: null,
      errorData: {
        id: "u",
        type: "abort",
        textResponse: null,
        sources: [],
        close: true,
        error:
          "Dieser Workspace hat das monatliche Limit von 600 Nachrichten für den Monat Oktober erreicht. Ihr Limit wird in 19 Tagen am 01.11.2026 zurückgesetzt.",
        messages_limit: 600,
        contingent: "600/600",
      },
    });
  });

  test("Kalendermonat, englisch", async () => {
    setNow("2026-10-12T10:00:00+02:00");
    mockCounts({ chats: 600 });
    const { errorData } = await checkWorkspaceMessagesLimit(
      monthlyWorkspace,
      null,
      { returnData: true, language: "en" }
    );
    // Der Monatsname kommt wie bisher aus der Standard-Locale des Prozesses.
    expect(errorData.error).toMatch(
      /^This workspace has reached the monthly message limit of 600 for (October|Oktober)\. Your limit will reset in 19 days on 01\.11\.2026\.$/
    );
  });

  test("Kalendermonat, letzter Tag: wie bisher 0 Tage", async () => {
    setNow("2026-10-31T10:00:00+01:00");
    mockCounts({ chats: 600 });
    const { errorData } = await checkWorkspaceMessagesLimit(
      monthlyWorkspace,
      null,
      { returnData: true }
    );
    expect(errorData.error).toBe(
      "Dieser Workspace hat das monatliche Limit von 600 Nachrichten für den Monat Oktober erreicht. Ihr Limit wird in 0 Tagen am 01.11.2026 zurückgesetzt."
    );
  });

  test("Kalendermonat richtet sich nach Berliner Zeit, nicht nach der Prozess-Zeitzone", async () => {
    // 01.11. 00:30 Uhr in Berlin; in UTC und New York ist noch der 31.10.
    setNow("2026-10-31T23:30:00Z");
    mockCounts({ chats: 600 });
    const { errorData } = await checkWorkspaceMessagesLimit(
      monthlyWorkspace,
      null,
      { returnData: true }
    );
    expect(errorData.error).toBe(
      "Dieser Workspace hat das monatliche Limit von 600 Nachrichten für den Monat November erreicht. Ihr Limit wird in 29 Tagen am 01.12.2026 zurückgesetzt."
    );
    expect(WorkspaceChats.count).toHaveBeenCalledWith({
      workspaceId: 1,
      createdAt: {
        gte: new Date("2026-10-31T23:00:00.000Z"),
        lt: new Date("2026-11-30T23:00:00.000Z"),
      },
    });
  });

  test("Zyklus, deutsch, mit cycle_info", async () => {
    setNow("2026-05-20T10:00:00+02:00");
    mockCounts({ chats: 600 });
    const { errorData, cycleInfo } = await checkWorkspaceMessagesLimit(
      cycleWorkspace,
      null,
      { returnData: true, uuid: "u" }
    );
    expect(errorData).toEqual({
      id: "u",
      type: "abort",
      textResponse: null,
      sources: [],
      close: true,
      error:
        "Dieser Workspace hat das Limit von 600 Nachrichten für den aktuellen Quartalszyklus erreicht. Ihr Limit wird in 56 Tagen am 15.07.2026 zurückgesetzt.",
      messages_limit: 600,
      contingent: "600/600",
      cycle_info: {
        cycleNumber: 2,
        daysRemaining: 56,
        nextReset: "2026-07-15T00:00:00.000Z",
        cycleDurationMonths: 3,
      },
    });
    expect(cycleInfo.cycleNumber).toBe(2);
    expect(cycleInfo.daysRemaining).toBe(56);
  });

  test("Zyklus, englisch", async () => {
    setNow("2026-05-20T10:00:00+02:00");
    mockCounts({ chats: 600 });
    const { errorData } = await checkWorkspaceMessagesLimit(
      cycleWorkspace,
      null,
      { returnData: true, language: "en" }
    );
    expect(errorData.error).toBe(
      "This workspace has reached the message limit of 600 for the current quarterly cycle. Your limit will reset in 56 days on 15.07.2026."
    );
  });

  test("Zyklus: Einzahl bei einer Nachricht und einem Tag", async () => {
    setNow("2026-07-14T23:00:00+02:00");
    mockCounts({ chats: 1 });
    const { errorData } = await checkWorkspaceMessagesLimit(
      { ...cycleWorkspace, messagesLimit: 1 },
      null,
      { returnData: true }
    );
    expect(errorData.error).toBe(
      "Dieser Workspace hat das Limit von 1 Nachricht für den aktuellen Quartalszyklus erreicht. Ihr Limit wird in 1 Tag am 15.07.2026 zurückgesetzt."
    );
  });

  test("vor dem Zyklusstart gilt die Monatsmeldung, der Reset ist der Vertragsbeginn", async () => {
    setNow("2026-10-12T10:00:00+02:00");
    mockCounts({ chats: 600 });
    const { errorData, cycleInfo } = await checkWorkspaceMessagesLimit(
      {
        ...monthlyWorkspace,
        cycleStartDate: "2026-10-20",
        cycleDurationMonths: 3,
      },
      null,
      { returnData: true }
    );
    expect(cycleInfo).toBeNull();
    expect(errorData.cycle_info).toBeUndefined();
    expect(errorData.error).toBe(
      "Dieser Workspace hat das monatliche Limit von 600 Nachrichten für den Monat Oktober erreicht. Ihr Limit wird in 7 Tagen am 20.10.2026 zurückgesetzt."
    );
  });
});

describe("getWorkspaceMessageLimitErrorText - dieselbe Meldung ohne Zählung", () => {
  const preStartWorkspace = {
    ...monthlyWorkspace,
    cycleStartDate: "2026-10-20",
    cycleDurationMonths: 3,
  };

  test.each([
    ["Kalendermonat", monthlyWorkspace, "2026-10-12T10:00:00+02:00"],
    [
      "Kalendermonat, letzter Tag",
      monthlyWorkspace,
      "2026-10-31T10:00:00+01:00",
    ],
    // 01.11. 00:30 Uhr in Berlin; in UTC und New York ist noch der 31.10.
    [
      "Monatswechsel in Berliner Zeit",
      monthlyWorkspace,
      "2026-10-31T23:30:00Z",
    ],
    ["Zyklus", cycleWorkspace, "2026-05-20T10:00:00+02:00"],
    // 15.04. 00:30 Uhr in Berlin: bereits der neue Zyklus.
    ["Zykluswechsel in Berliner Zeit", cycleWorkspace, "2026-04-14T22:30:00Z"],
    ["vor dem Zyklusstart", preStartWorkspace, "2026-10-12T10:00:00+02:00"],
  ])("%s: wortgleich mit checkWorkspaceMessagesLimit", async (_, ws, now) => {
    setNow(now);
    mockCounts({ chats: 600 });
    for (const language of ["de", "en"]) {
      const { errorData } = await checkWorkspaceMessagesLimit(ws, null, {
        returnData: true,
        language,
      });
      expect(getWorkspaceMessageLimitErrorText(ws, 600, language)).toBe(
        errorData.error
      );
    }
    // Für die Meldung allein wird nicht noch einmal gezählt.
    jest.clearAllMocks();
    getWorkspaceMessageLimitErrorText(ws, 600);
    expect(WorkspaceChats.count).not.toHaveBeenCalled();
  });

  test("Zyklus: Standard ist Englisch, Reset aus dem Zyklusfenster statt aus dem Kalendermonat", () => {
    // Limit am 20.04. erreicht: Der Reset ist der 15.07., nicht der 01.05.
    expect(
      getWorkspaceMessageLimitErrorText(
        cycleWorkspace,
        600,
        undefined,
        new Date("2026-04-20T10:00:00+02:00")
      )
    ).toBe(
      "This workspace has reached the message limit of 600 for the current quarterly cycle. Your limit will reset in 86 days on 15.07.2026."
    );
  });

  test("Kalendermonat: Monat und Reset in Berliner Zeit", () => {
    expect(
      getWorkspaceMessageLimitErrorText(
        monthlyWorkspace,
        600,
        "de",
        new Date("2026-10-31T23:30:00Z")
      )
    ).toBe(
      "Dieser Workspace hat das monatliche Limit von 600 Nachrichten für den Monat November erreicht. Ihr Limit wird in 29 Tagen am 01.12.2026 zurückgesetzt."
    );
  });
});

describe("checkWorkspaceMessagesLimit - Sperrverhalten unverändert", () => {
  beforeEach(() => setNow("2026-05-20T10:00:00+02:00"));

  test.each([
    ["Kalendermonat", monthlyWorkspace],
    ["Zyklus", cycleWorkspace],
  ])("%s: unter dem Limit keine Sperre und keine Antwort", async (_, ws) => {
    mockCounts({ chats: 500, embeds: 99 });
    const response = mockResponse();
    const result = await checkWorkspaceMessagesLimit(ws, response);
    expect(result.limitReached).toBe(false);
    expect(result.messageCount).toBe(599);
    expect(result.errorData).toBeNull();
    expect(response.status).not.toHaveBeenCalled();
    expect(response.json).not.toHaveBeenCalled();
  });

  test.each([
    ["Kalendermonat", monthlyWorkspace],
    ["Zyklus", cycleWorkspace],
  ])("%s: Limit genau erreicht sperrt mit 429", async (_, ws) => {
    mockCounts({ chats: 500, embeds: 90, adjustments: 10 });
    const response = mockResponse();
    const result = await checkWorkspaceMessagesLimit(ws, response, {
      uuid: "u",
    });
    expect(result.limitReached).toBe(true);
    expect(response.status).toHaveBeenCalledWith(429);
    expect(response.json).toHaveBeenCalledWith(result.errorData);
    expect(result.errorData.type).toBe("abort");
    expect(result.errorData.contingent).toBe("600/600");
  });

  test("Gutschrift hebt die Sperre wieder auf", async () => {
    mockCounts({ chats: 650, adjustments: -100 });
    const response = mockResponse();
    const result = await checkWorkspaceMessagesLimit(cycleWorkspace, response);
    expect(result.limitReached).toBe(false);
    expect(result.messageCount).toBe(550);
    expect(response.status).not.toHaveBeenCalled();
  });

  test("ohne Limit nie gesperrt", async () => {
    mockCounts({ chats: 100000 });
    const response = mockResponse();
    const result = await checkWorkspaceMessagesLimit(
      { ...cycleWorkspace, messagesLimit: null },
      response
    );
    expect(result.limitReached).toBe(false);
    expect(result.messagesLimit).toBeNull();
    expect(response.status).not.toHaveBeenCalled();
  });

  test("Streaming: 429 und Text-Chunk mit der Meldung", async () => {
    mockCounts({ chats: 600 });
    const response = mockResponse();
    const writeResponseChunk = jest.fn();
    const { errorData } = await checkWorkspaceMessagesLimit(
      cycleWorkspace,
      response,
      {
        isStreaming: true,
        writeResponseChunk,
        attachments: ["a"],
        uuid: "u",
      }
    );
    expect(response.status).toHaveBeenCalledWith(429);
    expect(response.json).not.toHaveBeenCalled();
    expect(writeResponseChunk).toHaveBeenCalledWith(response, {
      ...errorData,
      type: "textResponse",
      textResponse: errorData.error,
      attachments: ["a"],
      httpStatusCode: 429,
    });
  });

  test("returnData: Sperre wird gemeldet, aber nichts gesendet", async () => {
    mockCounts({ chats: 600 });
    const response = mockResponse();
    const result = await checkWorkspaceMessagesLimit(cycleWorkspace, response, {
      returnData: true,
    });
    expect(result.limitReached).toBe(true);
    expect(response.status).not.toHaveBeenCalled();
    expect(response.json).not.toHaveBeenCalled();
  });

  test("gezählt wird im halboffenen Fenster des laufenden Zyklus", async () => {
    mockCounts({ chats: 1 });
    await checkWorkspaceMessagesLimit(cycleWorkspace, mockResponse());
    const start = new Date("2026-04-14T22:00:00.000Z"); // 15.04. 00:00 MESZ
    const endExclusive = new Date("2026-07-14T22:00:00.000Z"); // 15.07. 00:00 MESZ
    expect(WorkspaceChats.count).toHaveBeenCalledWith({
      workspaceId: 1,
      createdAt: { gte: start, lt: endExclusive },
    });
    expect(EmbedChats.countForWorkspaceInDateRange).toHaveBeenCalledWith(
      1,
      start,
      endExclusive
    );
    expect(
      WorkspaceMessageAdjustments.sumForWorkspaceInDateRange
    ).toHaveBeenCalledWith(1, start, endExclusive);
  });
});

describe("checkWorkspaceMessagesLimit – Ergebnis unverändert", () => {
  test("unter dem Limit: nicht erreicht, keine Antwort geschrieben", async () => {
    mockCounts({ chats: 3, embeds: 1 });
    const response = makeResponse();
    const result = await checkWorkspaceMessagesLimit(
      makeWorkspace(),
      response,
      { isStreaming: true, writeResponseChunk, uuid: "u-1" }
    );

    expect(result).toMatchObject({
      limitReached: false,
      messageCount: 4,
      messagesLimit: 5,
      errorData: null,
      cycleInfo: null,
    });
    expect(response.write).not.toHaveBeenCalled();
    expect(response.status).not.toHaveBeenCalled();
  });

  test("Limit erreicht, Streaming: textResponse-Chunk mit Limit-Meldung und Status 429", async () => {
    mockCounts({ chats: 4, embeds: 1 });
    const response = makeResponse();
    const attachments = [{ name: "bild.png" }];
    const result = await checkWorkspaceMessagesLimit(
      makeWorkspace(),
      response,
      { isStreaming: true, writeResponseChunk, attachments, uuid: "u-2" }
    );

    expect(result.limitReached).toBe(true);
    expect(result.messageCount).toBe(5);
    expect(response.status).toHaveBeenCalledWith(429);
    const events = response.events();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      id: "u-2",
      type: "textResponse",
      textResponse: result.errorData.error,
      sources: [],
      close: true,
      error: result.errorData.error,
      messages_limit: 5,
      contingent: "5/5",
      attachments,
      httpStatusCode: 429,
    });
    expect(events[0].textResponse).toMatch(LIMIT_TEXT);
  });

  test("Limit erreicht, returnData: liefert Text und Daten, ohne ein Antwortobjekt anzufassen", async () => {
    mockCounts({ chats: 7 });
    const result = await checkWorkspaceMessagesLimit(makeWorkspace(), null, {
      returnData: true,
      uuid: "u-3",
    });

    expect(result.limitReached).toBe(true);
    expect(result.errorData).toMatchObject({
      id: "u-3",
      type: "abort",
      textResponse: null,
      sources: [],
      close: true,
      error: expect.stringMatching(LIMIT_TEXT),
      messages_limit: 5,
      contingent: "7/5",
    });
  });

  test("Limit erreicht, ohne Streaming: 429 als JSON", async () => {
    mockCounts({ chats: 5 });
    const response = makeResponse();
    const result = await checkWorkspaceMessagesLimit(
      makeWorkspace(),
      response,
      { uuid: "u-4" }
    );

    expect(response.status).toHaveBeenCalledWith(429);
    expect(response.json).toHaveBeenCalledWith(result.errorData);
    expect(response.write).not.toHaveBeenCalled();
  });

  test("messagesLimit = null: nie erreicht", async () => {
    mockCounts({ chats: 10_000 });
    const response = makeResponse();
    const result = await checkWorkspaceMessagesLimit(
      makeWorkspace(null),
      response,
      { isStreaming: true, writeResponseChunk }
    );

    expect(result.limitReached).toBe(false);
    expect(result.errorData).toBeNull();
    expect(response.write).not.toHaveBeenCalled();
  });

  test("Abzüge zählen mit, Gutschriften entlasten", async () => {
    mockCounts({ chats: 3, adjustments: 2 });
    const reached = await checkWorkspaceMessagesLimit(makeWorkspace(), null, {
      returnData: true,
    });
    expect(reached.limitReached).toBe(true);

    mockCounts({ chats: 6, adjustments: -2 });
    const free = await checkWorkspaceMessagesLimit(makeWorkspace(), null, {
      returnData: true,
    });
    expect(free.limitReached).toBe(false);
    expect(free.messageCount).toBe(4);
  });
});

describe("streamChatWithWorkspace – Zeitpunkt der Limitprüfung", () => {
  let connector;
  let vectorDb;
  let limitCheck;

  const order = (mockFn) => mockFn.mock.invocationCallOrder[0];

  beforeEach(() => {
    connector = {
      defaultTemp: 0.7,
      promptWindowLimit: jest.fn().mockReturnValue(4096),
      compressMessages: jest
        .fn()
        .mockResolvedValue([{ role: "user", content: "x" }]),
      streamingEnabled: jest.fn().mockReturnValue(true),
      streamGetChatCompletion: jest.fn().mockResolvedValue({ metrics: {} }),
      handleStream: jest.fn().mockResolvedValue("Antwort"),
    };
    vectorDb = {
      hasNamespace: jest.fn().mockResolvedValue(true),
      namespaceCount: jest.fn().mockResolvedValue(12),
      performSimilaritySearch: jest
        .fn()
        .mockResolvedValue({ contextTexts: [], sources: [], message: null }),
    };
    helpers.getLLMProvider.mockReturnValue(connector);
    helpers.getVectorDbClass.mockReturnValue(vectorDb);
    WorkspaceChats.new.mockResolvedValue({ chat: { id: 42 }, message: null });
    WorkspaceAgentInvocation.new.mockResolvedValue({
      invocation: { uuid: "inv-1" },
      message: null,
    });
    // Durchreichende Beobachtung: stream.js lädt die Funktion erst beim Aufruf.
    limitCheck = jest.spyOn(helpers, "checkWorkspaceMessagesLimit");
  });

  afterEach(() => {
    limitCheck.mockRestore();
  });

  test("ohne @agent, unter dem Limit: genau eine Prüfung – nach der Vektorsuche, vor dem LLM", async () => {
    mockCounts({ chats: 2 });
    const workspace = makeWorkspace();
    const response = makeResponse();
    const attachments = [{ name: "bild.png" }];
    await streamChatWithWorkspace(
      response,
      workspace,
      "Wie ist das Wetter?",
      "chat",
      { id: 1 },
      null,
      attachments
    );

    expect(limitCheck).toHaveBeenCalledTimes(1);
    expect(order(vectorDb.performSimilaritySearch)).toBeLessThan(
      order(limitCheck)
    );
    expect(order(limitCheck)).toBeLessThan(order(connector.compressMessages));
    expect(limitCheck).toHaveBeenCalledWith(workspace, response, {
      isStreaming: true,
      writeResponseChunk,
      attachments,
      uuid: expect.any(String),
    });

    expect(connector.streamGetChatCompletion).toHaveBeenCalledTimes(1);
    expect(WorkspaceChats.new).toHaveBeenCalledTimes(1);
    expect(WorkspaceAgentInvocation.new).not.toHaveBeenCalled();
    expect(response.status).not.toHaveBeenCalled();
    expect(response.events().at(-1).type).toBe("finalizeResponseStream");
  });

  test("ohne @agent, Limit erreicht: genau eine Prüfung an derselben Stelle, Limit-Meldung, kein LLM, keine Zeile", async () => {
    mockCounts({ chats: 5 });
    const response = makeResponse();
    await streamChatWithWorkspace(
      response,
      makeWorkspace(),
      "Wie ist das Wetter?",
      "chat",
      { id: 1 }
    );

    expect(limitCheck).toHaveBeenCalledTimes(1);
    expect(order(vectorDb.performSimilaritySearch)).toBeLessThan(
      order(limitCheck)
    );
    const events = response.events();
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("textResponse");
    expect(events[0].textResponse).toMatch(LIMIT_TEXT);
    expect(events[0].httpStatusCode).toBe(429);
    expect(response.status).toHaveBeenCalledWith(429);
    expect(connector.compressMessages).not.toHaveBeenCalled();
    expect(connector.streamGetChatCompletion).not.toHaveBeenCalled();
    expect(WorkspaceChats.new).not.toHaveBeenCalled();
  });

  test("@agent mitten im Text löst keine Sitzung aus und wird wie jede normale Nachricht geprüft", async () => {
    mockCounts({ chats: 2 });
    const response = makeResponse();
    await streamChatWithWorkspace(
      response,
      makeWorkspace(),
      "Frag bitte @agent nach dem Wetter",
      "chat",
      { id: 1 }
    );

    expect(WorkspaceAgentInvocation.new).not.toHaveBeenCalled();
    expect(limitCheck).toHaveBeenCalledTimes(1);
    expect(order(vectorDb.performSimilaritySearch)).toBeLessThan(
      order(limitCheck)
    );
    expect(connector.streamGetChatCompletion).toHaveBeenCalledTimes(1);
  });

  test("mit @agent: eine Prüfung vor dem Anlegen der Sitzung, Vektorsuche und LLM werden nicht erreicht", async () => {
    mockCounts({ chats: 2 });
    const response = makeResponse();
    await streamChatWithWorkspace(
      response,
      makeWorkspace(),
      "@agent Wie ist das Wetter?",
      "chat",
      { id: 1 }
    );

    expect(limitCheck).toHaveBeenCalledTimes(1);
    expect(order(limitCheck)).toBeLessThan(order(WorkspaceAgentInvocation.new));
    expect(vectorDb.performSimilaritySearch).not.toHaveBeenCalled();
    expect(helpers.getLLMProvider).not.toHaveBeenCalled();
    expect(response.events().map((event) => event.type)).toEqual([
      "agentInitWebsocketConnection",
      "statusResponse",
    ]);
  });
});
