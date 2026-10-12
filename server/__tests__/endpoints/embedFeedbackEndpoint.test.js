/* eslint-env jest, node */
// KIE-532 — Öffentlicher Endpunkt POST /embed/:embedId/:sessionId/feedback.
//
// Vor dem Endpunkt steht nur validEmbedConfig: kein Login, keine
// Origin-Prüfung. Jede gebuchte Bewertung läuft durch die eine Reihe der
// Zählerbuch-Transaktionen, in der auch die Chat-Speicherungen stehen, und ein
// Fehler darin schreibt das Ereignis message_ledger_write_failed. Anfragen mit
// unbrauchbarer oder nicht passender chatId dürfen deshalb weder die Reihe
// belegen noch ein Ereignis auslösen, und eine Sitzung darf die Reihe nicht
// beliebig oft belegen.
//
// Echter Handler, echte Modelle, echte SQLite-Datei
// (helpers/sqliteTestDatabase.js).
jest.mock(
  "../../utils/prisma",
  () => require("../helpers/sqliteTestDatabase").testPrisma
);
jest.mock("../../models/telemetry", () => ({
  Telemetry: { sendTelemetry: jest.fn(), flush: jest.fn() },
}));
jest.mock("../../utils/chats/embed", () => ({
  streamChatWithForEmbed: jest.fn(),
}));
jest.mock("../../utils/TextToSpeech", () => ({
  getTTSProvider: jest.fn(),
  isTTSConfigured: jest.fn(),
}));
jest.mock("../../utils/SpeechToText", () => ({
  getSTTProvider: jest.fn(),
  isSTTConfigured: jest.fn(),
}));

const {
  createTestDatabase,
  removeTestDatabases,
  createWorkspace,
  createEmbed,
  eventsOf,
  collectRoutes,
  mockRequest,
  mockResponse,
} = require("../helpers/sqliteTestDatabase");
const { MessageLedger } = require("../../models/messageLedger");
const { EmbedChats } = require("../../models/embedChats");
const { embeddedEndpoints } = require("../../endpoints/embed");

const SESSION = "owner-session";
const feedbackRoute =
  collectRoutes(embeddedEndpoints)["POST /embed/:embedId/:sessionId/feedback"];

// Der erste Test jeder Datei erzeugt die Vorlage mit `prisma migrate deploy`.
jest.setTimeout(60000);

let db;
let embed;
let chat;
beforeEach(async () => {
  MessageLedger._resetCache();
  EmbedChats._resetFeedbackLimits();
  db = await createTestDatabase();
  jest.spyOn(console, "error").mockImplementation(() => {});
  jest.spyOn(console, "log").mockImplementation(() => {});

  const workspace = await createWorkspace(db.client);
  embed = await createEmbed(db.client, workspace);
  chat = (
    await EmbedChats.new({
      embedId: embed.id,
      prompt: "Gibt es Yogakurse?",
      response: { text: "Ja." },
      sessionId: SESSION,
    })
  ).chat;
});
afterEach(async () => {
  jest.restoreAllMocks();
  await db.close();
});
afterAll(() => removeTestDatabases());

/** Ruft den Handler so auf, wie er nach validEmbedConfig läuft. */
async function postFeedback(body, sessionId = SESSION) {
  const response = mockResponse({ embedConfig: embed });
  await feedbackRoute(
    mockRequest({ params: { embedId: embed.uuid, sessionId }, body }),
    response
  );
  return { status: response.statusCode, body: response.body };
}

async function storedScore() {
  return (await db.client.embed_chats.findUnique({ where: { id: chat.id } }))
    .feedbackScore;
}

async function ledgerFeedback() {
  const sum = await db.client.message_ledger.aggregate({
    _sum: { feedback_positive: true, feedback_negative: true },
  });
  return [sum._sum.feedback_positive ?? 0, sum._sum.feedback_negative ?? 0];
}

describe("POST /embed/:embedId/:sessionId/feedback (KIE-532)", () => {
  test("der Endpunkt ist registriert", () => {
    expect(typeof feedbackRoute).toBe("function");
  });

  test("gültige Bewertung: 200, gespeichert und im Zählerbuch gebucht - chatId als Zahl oder als Ziffernfolge", async () => {
    expect(await postFeedback({ chatId: chat.id, feedback: true })).toEqual({
      status: 200,
      body: { success: true },
    });
    expect(await storedScore()).toBe(true);
    expect(await ledgerFeedback()).toEqual([1, 0]);

    expect(
      await postFeedback({ chatId: String(chat.id), feedback: false })
    ).toEqual({ status: 200, body: { success: true } });
    expect(await storedScore()).toBe(false);
    expect(await ledgerFeedback()).toEqual([0, 1]);
  });

  test("chatId, die keine positive ganze Zahl ist: 400 - ohne Datenbankzugriff, ohne Transaktion, ohne Ereignis", async () => {
    const readSpy = jest.spyOn(db.client.embed_chats, "findFirst");
    const transactionSpy = jest.spyOn(MessageLedger, "transaction");

    for (const chatId of [
      "abc",
      "1e999",
      "12abc",
      "",
      "0",
      0,
      -1,
      1.5,
      2 ** 60,
      true,
      {},
      { a: 1 },
      [1, 2],
      [chat.id],
    ])
      expect(await postFeedback({ chatId, feedback: true })).toEqual({
        status: 400,
        body: { success: false, error: "chatId must be a positive integer." },
      });
    for (const body of [{ feedback: true }, { chatId: null, feedback: true }])
      expect(await postFeedback(body)).toEqual({
        status: 400,
        body: { success: false, error: "chatId is required." },
      });

    expect(readSpy).not.toHaveBeenCalled();
    expect(transactionSpy).not.toHaveBeenCalled();
    expect(await eventsOf(db.client, "message_ledger_write_failed")).toEqual(
      []
    );
    expect(await storedScore()).toBeNull();
  });

  test("ohne Treffer: 200 mit success false, die Reihe des Zählerbuchs bleibt frei", async () => {
    const transactionSpy = jest.spyOn(MessageLedger, "transaction");

    expect(await postFeedback({ chatId: 424242, feedback: true })).toEqual({
      status: 200,
      body: { success: false },
    });
    expect(
      await postFeedback({ chatId: chat.id, feedback: true }, "fremde-session")
    ).toEqual({ status: 200, body: { success: false } });

    expect(transactionSpy).not.toHaveBeenCalled();
    expect(await storedScore()).toBeNull();
    expect(await ledgerFeedback()).toEqual([0, 0]);
  });

  test("eine Flut unbrauchbarer Anfragen hält keine Chat-Speicherung auf und füllt das Ereignisprotokoll nicht", async () => {
    const transactionSpy = jest.spyOn(MessageLedger, "transaction");
    const eventsBefore = await db.client.event_logs.count();

    const flood = [
      ...Array.from({ length: 150 }, () =>
        postFeedback({ chatId: "abc", feedback: true })
      ),
      ...Array.from({ length: 150 }, (_, i) =>
        postFeedback({ chatId: 500000 + i, feedback: true })
      ),
      ...Array.from({ length: 150 }, (_, i) =>
        postFeedback({ chatId: chat.id, feedback: true }, `geraten-${i}`)
      ),
    ];
    const saved = await EmbedChats.new({
      embedId: embed.id,
      prompt: "Frage",
      sessionId: SESSION,
    });
    const answers = await Promise.all(flood);

    expect(saved.message).toBeNull();
    expect(answers.map((answer) => answer.status)).toEqual([
      ...Array(150).fill(400),
      ...Array(300).fill(200),
    ]);
    expect(answers.some((answer) => answer.body.success)).toBe(false);
    // In der Reihe stand allein die Chat-Speicherung.
    expect(transactionSpy).toHaveBeenCalledTimes(1);
    expect(transactionSpy.mock.calls[0][0]).toEqual(
      expect.objectContaining({ source: "embed_chat" })
    );
    expect(await db.client.event_logs.count()).toBe(eventsBefore);
    expect(await storedScore()).toBeNull();
  });

  test("zu viele Bewertungen einer Sitzung: 429, nichts wird geändert", async () => {
    const nowSpy = jest.spyOn(Date, "now").mockReturnValue(Date.now());
    for (let i = 0; i < EmbedChats.FEEDBACK_MAX_PER_WINDOW; i++)
      expect(
        (await postFeedback({ chatId: chat.id, feedback: i % 2 === 0 })).status
      ).toBe(200);
    expect(await storedScore()).toBe(false);

    expect(await postFeedback({ chatId: chat.id, feedback: true })).toEqual({
      status: 429,
      body: {
        success: false,
        error: "Too many feedback requests - try again later.",
      },
    });
    expect(await storedScore()).toBe(false);
    expect(await ledgerFeedback()).toEqual([0, 1]);
    nowSpy.mockRestore();
  });

  test("volle Reihe: 429; ein Fehler beim Schreiben: 200 mit success false", async () => {
    const applySpy = jest
      .spyOn(EmbedChats, "applyFeedback")
      .mockResolvedValueOnce("busy")
      .mockResolvedValueOnce("error");

    expect(await postFeedback({ chatId: chat.id, feedback: true })).toEqual({
      status: 429,
      body: {
        success: false,
        error: "Too many feedback requests - try again later.",
      },
    });
    expect(await postFeedback({ chatId: chat.id, feedback: true })).toEqual({
      status: 200,
      body: { success: false },
    });
    // Das Model bekommt Widget und Sitzung aus dem Pfad, nicht aus dem Body.
    expect(applySpy).toHaveBeenLastCalledWith(
      embed.id,
      SESSION,
      chat.id,
      true,
      { feedbackText: undefined, feedbackReason: undefined }
    );
  });
});
