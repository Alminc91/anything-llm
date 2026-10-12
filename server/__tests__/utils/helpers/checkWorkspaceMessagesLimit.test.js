/* eslint-env jest, node */
// KIE-531 / NAK-4 — Die Limitprüfung bleibt unverändert: gleiche Meldung,
// gleiches Sperrverhalten. Die erwarteten Texte sind die Ausgaben des Standes
// vor KIE-531 (origin/master @ 73afab1b, TZ=Europe/Berlin) für dieselben
// Eingaben. Geändert haben sich nur die Fenstergrenzen dahinter.
//
// Die Zeitzone des Prozesses wird nicht gesetzt; die Erwartungen gelten für
// TZ=UTC, TZ=Europe/Berlin und TZ=America/New_York (NAK-3).
const { WorkspaceChats } = require("../../../models/workspaceChats");
const { EmbedChats } = require("../../../models/embedChats");
const {
  WorkspaceMessageAdjustments,
} = require("../../../models/workspaceMessageAdjustments");
const { checkWorkspaceMessagesLimit } = require("../../../utils/helpers");

jest.mock("../../../models/workspaceChats", () => ({
  WorkspaceChats: { count: jest.fn() },
}));
jest.mock("../../../models/embedChats", () => ({
  EmbedChats: { countForWorkspaceInDateRange: jest.fn() },
}));
jest.mock("../../../models/workspaceMessageAdjustments", () => ({
  WorkspaceMessageAdjustments: { sumForWorkspaceInDateRange: jest.fn() },
}));

const monthlyWorkspace = { id: 1, name: "W", slug: "w", messagesLimit: 600 };
const cycleWorkspace = {
  ...monthlyWorkspace,
  cycleStartDate: new Date("2026-01-15"),
  cycleDurationMonths: 3,
};

function mockCounts({ chats = 0, embeds = 0, adjustments = 0 } = {}) {
  WorkspaceChats.count.mockResolvedValue(chats);
  EmbedChats.countForWorkspaceInDateRange.mockResolvedValue(embeds);
  WorkspaceMessageAdjustments.sumForWorkspaceInDateRange.mockResolvedValue(
    adjustments
  );
}

function mockResponse() {
  const response = {
    status: jest.fn(() => response),
    json: jest.fn(() => response),
  };
  return response;
}

function setNow(iso) {
  jest.useFakeTimers().setSystemTime(new Date(iso));
}

let logSpy;
beforeEach(() => {
  jest.clearAllMocks();
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
