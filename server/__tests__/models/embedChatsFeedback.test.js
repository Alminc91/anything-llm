/* eslint-env jest, node */
// KIE-504 — Bewertungsfunktion (👍/👎) pro Embed-Antwort.
// updateFeedbackScore muss die chatId zusätzlich an embed_id UND die besitzende
// session_id binden (BOLA/IDOR-Härtung, analog KIE-505), damit eine geleakte
// chatId keine fremde Antwort bewerten kann. Zusätzlich: korrektes Mapping von
// true/false/null auf den feedbackScore.
//
// KIE-532: Die Bewertung wird in derselben Transaktion im Zählerbuch gebucht.
// Die Prüfungen laufen deshalb gegen eine echte SQLite-Datei
// (helpers/sqliteTestDatabase.js) und sehen auf die gespeicherte Zeile und das
// Zählerbuch statt auf den Aufruf einer Attrappe. Eine fremde Session darf
// weder die Chat-Zeile noch das Zählerbuch ändern (NAK-6).
jest.mock(
  "../../utils/prisma",
  () => require("../helpers/sqliteTestDatabase").testPrisma
);

const {
  createTestDatabase,
  removeTestDatabases,
  createWorkspace,
  createEmbed,
  ledgerRows,
} = require("../helpers/sqliteTestDatabase");
const { MessageLedger } = require("../../models/messageLedger");
const { EmbedChats } = require("../../models/embedChats");

const OWNER_SESSION = "owner-session";
const ATTACKER_SESSION = "attacker-session";

// Der erste Test jeder Datei erzeugt die Vorlage mit `prisma migrate deploy`.
jest.setTimeout(60000);

let db;
let errorSpy;
let logSpy;
let EMBED_ID;
let OTHER_EMBED_ID;
let CHAT_ID;

beforeEach(async () => {
  MessageLedger._resetCache();
  db = await createTestDatabase();
  errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  logSpy = jest.spyOn(console, "log").mockImplementation(() => {});

  // One rated-able row owned by OWNER_SESSION under the first embed.
  const workspace = await createWorkspace(db.client);
  EMBED_ID = (await createEmbed(db.client, workspace)).id;
  OTHER_EMBED_ID = (await createEmbed(db.client, workspace)).id;
  const { chat } = await EmbedChats.new({
    embedId: EMBED_ID,
    prompt: "Gibt es Yogakurse?",
    response: { text: "Ja." },
    sessionId: OWNER_SESSION,
    conversationId: "konversation",
  });
  CHAT_ID = chat.id;
});
afterEach(async () => {
  errorSpy.mockRestore();
  logSpy.mockRestore();
  await db.close();
});
afterAll(() => removeTestDatabases());

async function storedChat() {
  const chat = await db.client.embed_chats.findUnique({
    where: { id: CHAT_ID },
  });
  return {
    feedbackScore: chat.feedbackScore,
    feedbackText: chat.feedbackText,
    feedbackReason: chat.feedbackReason,
  };
}

/** [feedback_positive, feedback_negative] über das ganze Zählerbuch */
async function ledgerFeedback() {
  const sum = await db.client.message_ledger.aggregate({
    _sum: { feedback_positive: true, feedback_negative: true },
  });
  return [sum._sum.feedback_positive ?? 0, sum._sum.feedback_negative ?? 0];
}

describe("updateFeedbackScore — chatId bound to embed + session (KIE-504)", () => {
  test("owner session sets 👍 (true) — where has id + embed_id + session_id", async () => {
    const ok = await EmbedChats.updateFeedbackScore(
      EMBED_ID,
      OWNER_SESSION,
      CHAT_ID,
      true
    );
    expect(ok).toBe(true);
    // KIE-507: 👍 leert Kommentar/Grund konsistent mit (keine verwaisten Felder).
    expect(await storedChat()).toEqual({
      feedbackScore: true,
      feedbackText: null,
      feedbackReason: null,
    });
    expect(await ledgerFeedback()).toEqual([1, 0]);
  });

  test("👎 (false) maps to feedbackScore false", async () => {
    const ok = await EmbedChats.updateFeedbackScore(
      EMBED_ID,
      OWNER_SESSION,
      CHAT_ID,
      false
    );
    expect(ok).toBe(true);
    expect((await storedChat()).feedbackScore).toBe(false);
    expect(await ledgerFeedback()).toEqual([0, 1]);
  });

  test("1/0 werden wie true/false behandelt", async () => {
    await EmbedChats.updateFeedbackScore(EMBED_ID, OWNER_SESSION, CHAT_ID, 1);
    expect((await storedChat()).feedbackScore).toBe(true);
    await EmbedChats.updateFeedbackScore(EMBED_ID, OWNER_SESSION, CHAT_ID, 0);
    expect((await storedChat()).feedbackScore).toBe(false);
    expect(await ledgerFeedback()).toEqual([0, 1]);
  });

  test("null removes the rating (toggle) — feedbackScore + Kommentar/Grund geleert", async () => {
    await EmbedChats.updateFeedbackScore(
      EMBED_ID,
      OWNER_SESSION,
      CHAT_ID,
      false,
      { feedbackText: "zu allgemein", feedbackReason: "Zu ungenau" }
    );
    const ok = await EmbedChats.updateFeedbackScore(
      EMBED_ID,
      OWNER_SESSION,
      CHAT_ID,
      null
    );
    expect(ok).toBe(true);
    // KIE-507: Entfernen der Bewertung leert auch Freitext + Grund konsistent.
    expect(await storedChat()).toEqual({
      feedbackScore: null,
      feedbackText: null,
      feedbackReason: null,
    });
    expect(await ledgerFeedback()).toEqual([0, 0]);
  });

  test("foreign session cannot rate owner's chat (count 0 -> false)", async () => {
    const chatBefore = await db.client.embed_chats.findUnique({
      where: { id: CHAT_ID },
    });
    const ledgerBefore = await ledgerRows(db.client);

    const ok = await EmbedChats.updateFeedbackScore(
      EMBED_ID,
      ATTACKER_SESSION,
      CHAT_ID,
      true
    );
    expect(ok).toBe(false);
    // NAK-6: weder die Chat-Zeile noch das Zählerbuch ändern sich
    expect(
      await db.client.embed_chats.findUnique({ where: { id: CHAT_ID } })
    ).toEqual(chatBefore);
    expect(await ledgerRows(db.client)).toEqual(ledgerBefore);
  });

  test("foreign session cannot change or remove an existing rating (NAK-6)", async () => {
    await EmbedChats.updateFeedbackScore(
      EMBED_ID,
      OWNER_SESSION,
      CHAT_ID,
      true
    );
    const chatBefore = await db.client.embed_chats.findUnique({
      where: { id: CHAT_ID },
    });
    const ledgerBefore = await ledgerRows(db.client);
    expect(await ledgerFeedback()).toEqual([1, 0]);

    for (const score of [false, null, true])
      expect(
        await EmbedChats.updateFeedbackScore(
          EMBED_ID,
          ATTACKER_SESSION,
          CHAT_ID,
          score
        )
      ).toBe(false);

    expect(
      await db.client.embed_chats.findUnique({ where: { id: CHAT_ID } })
    ).toEqual(chatBefore);
    expect(await ledgerRows(db.client)).toEqual(ledgerBefore);
  });

  test("wrong embed scope cannot rate the chat (count 0 -> false)", async () => {
    const ledgerBefore = await ledgerRows(db.client);
    for (const embedId of [OTHER_EMBED_ID, 999])
      expect(
        await EmbedChats.updateFeedbackScore(
          embedId,
          OWNER_SESSION,
          CHAT_ID,
          true
        )
      ).toBe(false);
    expect((await storedChat()).feedbackScore).toBeNull();
    expect(await ledgerRows(db.client)).toEqual(ledgerBefore);
  });

  test("missing args short-circuit without touching the DB", async () => {
    const transactionSpy = jest.spyOn(db.client, "$transaction");
    expect(
      await EmbedChats.updateFeedbackScore(null, OWNER_SESSION, CHAT_ID, true)
    ).toBe(false);
    expect(
      await EmbedChats.updateFeedbackScore(EMBED_ID, null, CHAT_ID, true)
    ).toBe(false);
    expect(
      await EmbedChats.updateFeedbackScore(EMBED_ID, OWNER_SESSION, null, true)
    ).toBe(false);
    expect(transactionSpy).not.toHaveBeenCalled();
    transactionSpy.mockRestore();
    expect((await storedChat()).feedbackScore).toBeNull();
  });

  test("schlägt die Buchung im Zählerbuch fehl, wird auch die Bewertung nicht gespeichert", async () => {
    const adjustSpy = jest
      .spyOn(MessageLedger, "adjustFeedback")
      .mockRejectedValue(new Error("künstlich"));
    const ok = await EmbedChats.updateFeedbackScore(
      EMBED_ID,
      OWNER_SESSION,
      CHAT_ID,
      true
    );
    adjustSpy.mockRestore();

    expect(ok).toBe(false);
    expect((await storedChat()).feedbackScore).toBeNull();
    expect(await ledgerFeedback()).toEqual([0, 0]);
  });
});

describe("updateFeedbackScore — Freitext + Grund bei 👎 (KIE-507)", () => {
  test("👎 mit comment + reason schreibt feedbackText/feedbackReason", async () => {
    const ok = await EmbedChats.updateFeedbackScore(
      EMBED_ID,
      OWNER_SESSION,
      CHAT_ID,
      false,
      { feedbackText: "Antwort war zu allgemein", feedbackReason: "Zu ungenau" }
    );
    expect(ok).toBe(true);
    expect(await storedChat()).toEqual({
      feedbackScore: false,
      feedbackText: "Antwort war zu allgemein",
      feedbackReason: "Zu ungenau",
    });
  });

  test("ohne opts wird NUR feedbackScore geschrieben (Text/Grund unangetastet)", async () => {
    await EmbedChats.updateFeedbackScore(
      EMBED_ID,
      OWNER_SESSION,
      CHAT_ID,
      false,
      {
        feedbackText: "Detail fehlt",
        feedbackReason: "Zu ungenau",
      }
    );
    await EmbedChats.updateFeedbackScore(
      EMBED_ID,
      OWNER_SESSION,
      CHAT_ID,
      false
    );
    expect(await storedChat()).toEqual({
      feedbackScore: false,
      feedbackText: "Detail fehlt",
      feedbackReason: "Zu ungenau",
    });
  });

  test("nur comment übergeben → nur feedbackText in data (Grund unangetastet)", async () => {
    await EmbedChats.updateFeedbackScore(
      EMBED_ID,
      OWNER_SESSION,
      CHAT_ID,
      false,
      {
        feedbackReason: "Zu ungenau",
      }
    );
    await EmbedChats.updateFeedbackScore(
      EMBED_ID,
      OWNER_SESSION,
      CHAT_ID,
      false,
      {
        feedbackText: "Detail fehlt",
      }
    );
    expect(await storedChat()).toEqual({
      feedbackScore: false,
      feedbackText: "Detail fehlt",
      feedbackReason: "Zu ungenau",
    });
    // Ein neuer Kommentar bei gleicher Bewertung ist kein Übergang.
    expect(await ledgerFeedback()).toEqual([0, 1]);
  });

  test("überlanger Freitext wird auf 2000 Zeichen gekürzt", async () => {
    const long = "x".repeat(5000);
    await EmbedChats.updateFeedbackScore(
      EMBED_ID,
      OWNER_SESSION,
      CHAT_ID,
      false,
      {
        feedbackText: long,
        feedbackReason: "y".repeat(300),
      }
    );
    const chat = await storedChat();
    expect(chat.feedbackText).toHaveLength(2000);
    expect(chat.feedbackReason).toHaveLength(100);
  });

  test("Wechsel 👎→👍 leert alten Kommentar/Grund (keine verwaisten Felder)", async () => {
    await EmbedChats.updateFeedbackScore(
      EMBED_ID,
      OWNER_SESSION,
      CHAT_ID,
      false,
      {
        feedbackText: "Detail fehlt",
        feedbackReason: "Zu ungenau",
      }
    );
    // Nutzer klickt später 👍; Widget sendt keine comment/reason mit.
    await EmbedChats.updateFeedbackScore(
      EMBED_ID,
      OWNER_SESSION,
      CHAT_ID,
      true
    );
    expect(await storedChat()).toEqual({
      feedbackScore: true,
      feedbackText: null,
      feedbackReason: null,
    });
    expect(await ledgerFeedback()).toEqual([1, 0]);
  });

  test("fremde Session kann auch mit Kommentar nichts schreiben (BOLA)", async () => {
    const ledgerBefore = await ledgerRows(db.client);
    const ok = await EmbedChats.updateFeedbackScore(
      EMBED_ID,
      ATTACKER_SESSION,
      CHAT_ID,
      false,
      { feedbackText: "hack", feedbackReason: "Falsch" }
    );
    expect(ok).toBe(false);
    expect(await storedChat()).toEqual({
      feedbackScore: null,
      feedbackText: null,
      feedbackReason: null,
    });
    expect(await ledgerRows(db.client)).toEqual(ledgerBefore);
  });
});
