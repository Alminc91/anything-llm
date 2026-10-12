/* eslint-env jest, node */
// KIE-531 — Der OpenAI-kompatible Pfad rechnet für die Limit-Meldung nicht
// mehr selbst (Kalendermonat in der Zeitzone des Prozesses, ohne Zyklus),
// sondern nimmt Zeitraum, Resttage und Reset-Tag aus dem Abrechnungsfenster
// des Workspaces – wie checkWorkspaceMessagesLimit.
//
// Die Zeitzone des Prozesses wird nicht gesetzt; die Erwartungen gelten für
// TZ=UTC, TZ=Europe/Berlin und TZ=America/New_York (NAK-3).

jest.mock("../../../utils/prisma", () => ({}));
jest.mock("../../../models/workspaceChats", () => ({
  WorkspaceChats: { new: jest.fn() },
}));
jest.mock("../../../models/workspace", () => ({
  Workspace: {},
}));
jest.mock("../../../utils/chats/index", () => ({
  chatPrompt: jest.fn(),
  sourceIdentifier: jest.fn(),
}));
jest.mock("../../../utils/DocumentManager", () => ({
  DocumentManager: class {},
}));
jest.mock("../../../utils/helpers/chat/queryRewriter", () => ({
  rewriteQueryForSearch: jest.fn(),
}));
// Zieht sonst die Systemeinstellungen samt .env und Datenbankmodellen nach.
jest.mock("../../../utils/chats/metadataFilterResolver", () => ({
  startMetadataFilterResolution: jest.fn(),
}));

const { WorkspaceChats } = require("../../../models/workspaceChats");
const helpers = require("../../../utils/helpers");
const {
  OpenAICompatibleChat,
} = require("../../../utils/chats/openaiCompatible");

const monthlyWorkspace = { id: 1, name: "W", slug: "w", messagesLimit: 600 };
const cycleWorkspace = {
  ...monthlyWorkspace,
  cycleStartDate: new Date("2026-01-15"),
  cycleDurationMonths: 3,
};

// Die Meldung steht im internen Abbruch-Objekt; die Antwort im OpenAI-Format
// trägt sie nicht nach außen. Geprüft wird deshalb, was der Pfad als Meldung
// bildet, und dass die Antwort selbst unverändert bleibt.
let limitTextSpy;
beforeEach(() => {
  jest.clearAllMocks();
  limitTextSpy = jest.spyOn(helpers, "getWorkspaceMessageLimitErrorText");
});
afterEach(() => {
  limitTextSpy.mockRestore();
  jest.useRealTimers();
});

function setNow(iso) {
  jest.useFakeTimers().setSystemTime(new Date(iso));
}

function limitText() {
  expect(limitTextSpy).toHaveBeenCalledTimes(1);
  return limitTextSpy.mock.results[0].value;
}

const cases = [
  [
    "Zyklus: Reset ist der nächste Zyklusstart, nicht der Monatserste",
    cycleWorkspace,
    "2026-04-20T10:00:00+02:00",
    "This workspace has reached the message limit of 600 for the current quarterly cycle. Your limit will reset in 86 days on 15.07.2026.",
  ],
  [
    // 01.11. 00:30 Uhr in Berlin; in UTC und New York ist noch der 31.10.
    "Kalendermonat: Monat und Reset in Berliner Zeit",
    monthlyWorkspace,
    "2026-10-31T23:30:00Z",
    "This workspace has reached the monthly message limit of 600 for November. Your limit will reset in 29 days on 01.12.2026.",
  ],
  [
    "vor dem Zyklusstart: Reset ist der Starttag",
    { ...monthlyWorkspace, cycleStartDate: "2026-10-20" },
    "2026-10-12T10:00:00+02:00",
    // Der Monatsname kommt wie bisher aus der Standard-Locale des Prozesses.
    /^This workspace has reached the monthly message limit of 600 for (October|Oktober)\. Your limit will reset in 7 days on 20\.10\.2026\.$/,
  ],
];

describe("OpenAICompatibleChat - Limit erreicht", () => {
  test.each(cases)("chatSync - %s", async (_, workspace, now, expected) => {
    setNow(now);
    const result = await OpenAICompatibleChat.chatSync({
      workspace,
      prompt: "Hallo",
      messagesLimit: 600,
      messageCount: 600,
    });

    expect(limitTextSpy).toHaveBeenCalledWith(workspace, 600);
    expect(limitText()).toEqual(expect.stringMatching(expected));
    expect(WorkspaceChats.new).not.toHaveBeenCalled();
    // Antwort wie bisher: 429-Kennzeichen, Kontingent, kein Inhalt.
    expect(result).toEqual({
      id: expect.any(String),
      object: "chat.completion",
      created: Math.floor(new Date(now).getTime() / 1000),
      model: "w",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: null },
          logprobs: null,
          finish_reason: "abort",
        },
      ],
      usage: {},
      contingent: "600/600",
      messages_limit: 600,
      httpStatusCode: 429,
    });
  });

  test.each(cases)("streamChat - %s", async (_, workspace, now, expected) => {
    setNow(now);
    const response = { status: jest.fn(), write: jest.fn() };
    await OpenAICompatibleChat.streamChat({
      workspace,
      response,
      prompt: "Hallo",
      messagesLimit: 600,
      messageCount: 600,
    });

    expect(limitTextSpy).toHaveBeenCalledWith(workspace, 600);
    expect(limitText()).toEqual(expect.stringMatching(expected));
    expect(WorkspaceChats.new).not.toHaveBeenCalled();
    expect(response.status).toHaveBeenCalledWith(429);
    expect(response.write).toHaveBeenCalledTimes(2);
    const [[chunk], [done]] = response.write.mock.calls;
    expect(JSON.parse(chunk.replace(/^data: /, ""))).toMatchObject({
      choices: [
        {
          message: { role: "assistant", content: null },
          finish_reason: "abort",
        },
      ],
      contingent: "600/600",
      messages_limit: 600,
      httpStatusCode: 429,
    });
    expect(done).toBe("data: [DONE]\n\n");
  });
});
