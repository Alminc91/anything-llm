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
  seedEmbedChats,
  ledgerRows,
  eventsOf,
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
  EmbedChats._resetFeedbackLimits();
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
  jest.restoreAllMocks();
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

// Der Endpunkt POST /embed/:embedId/:sessionId/feedback ist öffentlich. Jede
// Zählerbuch-Transaktion belegt die eine Reihe, in der auch die
// Chat-Speicherungen stehen; ein Fehler darin schreibt ein Ereignis.
describe("updateFeedbackScore — nur passende Anfragen erreichen die Reihe des Zählerbuchs (KIE-532)", () => {
  const INVALID_CHAT_IDS = [
    "abc",
    "1e999",
    "12abc",
    " 5",
    "0",
    "-1",
    "1.0",
    "99999999999999999999",
    0,
    -1,
    1.5,
    NaN,
    Infinity,
    2 ** 60,
    true,
    {},
    { a: 1 },
    [1, 2],
  ];

  test("ungültige chatId: kein Datenbankzugriff, keine Transaktion, kein Ereignis message_ledger_write_failed", async () => {
    const readSpy = jest.spyOn(db.client.embed_chats, "findFirst");
    const transactionSpy = jest.spyOn(MessageLedger, "transaction");
    errorSpy.mockClear();

    for (const chatId of [...INVALID_CHAT_IDS, [CHAT_ID]]) {
      expect(EmbedChats.parseChatId(chatId)).toBeNull();
      expect(
        await EmbedChats.updateFeedbackScore(
          EMBED_ID,
          OWNER_SESSION,
          chatId,
          true
        )
      ).toBe(false);
    }

    expect(readSpy).not.toHaveBeenCalled();
    expect(transactionSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    expect(await eventsOf(db.client, "message_ledger_write_failed")).toEqual(
      []
    );
    expect((await storedChat()).feedbackScore).toBeNull();
    expect(await ledgerFeedback()).toEqual([0, 0]);
  });

  test("eine Ziffernfolge ist eine gültige chatId", async () => {
    expect(EmbedChats.parseChatId(String(CHAT_ID))).toBe(CHAT_ID);
    expect(EmbedChats.parseChatId(CHAT_ID)).toBe(CHAT_ID);
    expect(EmbedChats.parseChatId(Number.MAX_SAFE_INTEGER)).toBe(
      Number.MAX_SAFE_INTEGER
    );
    expect(
      await EmbedChats.updateFeedbackScore(
        EMBED_ID,
        OWNER_SESSION,
        String(CHAT_ID),
        true
      )
    ).toBe(true);
    expect((await storedChat()).feedbackScore).toBe(true);
    expect(await ledgerFeedback()).toEqual([1, 0]);
  });

  test("ohne Treffer (geratene chatId, fremde Session, fremdes Widget) entsteht keine Transaktion", async () => {
    const transactionSpy = jest.spyOn(MessageLedger, "transaction");
    const clientSpy = jest.spyOn(db.client, "$transaction");

    for (const [embedId, sessionId, chatId] of [
      [EMBED_ID, OWNER_SESSION, 424242],
      [EMBED_ID, ATTACKER_SESSION, CHAT_ID],
      [OTHER_EMBED_ID, OWNER_SESSION, CHAT_ID],
    ])
      expect(
        await EmbedChats.applyFeedback(embedId, sessionId, chatId, true)
      ).toBe("not_found");

    expect(transactionSpy).not.toHaveBeenCalled();
    expect(clientSpy).not.toHaveBeenCalled();
    expect((await storedChat()).feedbackScore).toBeNull();
  });

  test("unveränderte Bewertung: nichts zu buchen, keine Transaktion - Kommentar und Grund werden trotzdem gespeichert", async () => {
    const transactionSpy = jest.spyOn(MessageLedger, "transaction");
    const rate = (score, opts) =>
      EmbedChats.updateFeedbackScore(
        EMBED_ID,
        OWNER_SESSION,
        CHAT_ID,
        score,
        opts
      );

    // Übergang: eine Transaktion
    expect(await rate(false, { feedbackText: "zu allgemein" })).toBe(true);
    expect(transactionSpy).toHaveBeenCalledTimes(1);

    // dieselbe Bewertung noch einmal, dann mit neuem Kommentar und Grund
    expect(await rate(false)).toBe(true);
    expect(
      await rate(false, {
        feedbackText: "Detail fehlt",
        feedbackReason: "Zu ungenau",
      })
    ).toBe(true);
    expect(transactionSpy).toHaveBeenCalledTimes(1);
    expect(await storedChat()).toEqual({
      feedbackScore: false,
      feedbackText: "Detail fehlt",
      feedbackReason: "Zu ungenau",
    });
    expect(await ledgerFeedback()).toEqual([0, 1]);

    // Entfernen ist wieder ein Übergang, das Wiederholen nicht.
    expect(await rate(null)).toBe(true);
    expect(await rate(null)).toBe(true);
    expect(transactionSpy).toHaveBeenCalledTimes(2);
    expect(await ledgerFeedback()).toEqual([0, 0]);
  });

  test("ändert sich die Bewertung zwischen Lesen und Schreiben, wird der Übergang trotzdem gebucht", async () => {
    await EmbedChats.updateFeedbackScore(
      EMBED_ID,
      OWNER_SESSION,
      CHAT_ID,
      true
    );
    expect(await ledgerFeedback()).toEqual([1, 0]);

    // Das Lesen vor der Reihe sieht noch 👎: Eine zweite Anfrage hat die
    // Bewertung inzwischen auf 👍 gesetzt.
    jest.spyOn(db.client.embed_chats, "findFirst").mockResolvedValueOnce({
      feedbackScore: false,
      feedbackText: null,
      feedbackReason: null,
    });
    expect(
      await EmbedChats.updateFeedbackScore(
        EMBED_ID,
        OWNER_SESSION,
        CHAT_ID,
        false,
        { feedbackText: "doch nicht" }
      )
    ).toBe(true);

    expect(await storedChat()).toEqual({
      feedbackScore: false,
      feedbackText: "doch nicht",
      feedbackReason: null,
    });
    expect(await ledgerFeedback()).toEqual([0, 1]);
  });

  test("je Widget und Sitzung höchstens FEEDBACK_MAX_PER_WINDOW Bewertungen je Minute; Anfragen ohne Treffer zählen nicht", async () => {
    const { chat: otherChat } = await EmbedChats.new({
      embedId: EMBED_ID,
      prompt: "Frage",
      sessionId: "andere-sitzung",
    });
    const startedAt = Date.now();
    const nowSpy = jest.spyOn(Date, "now").mockReturnValue(startedAt);
    const rate = (score, sessionId = OWNER_SESSION, chatId = CHAT_ID) =>
      EmbedChats.applyFeedback(EMBED_ID, sessionId, chatId, score);

    // Eine fremde Session verbraucht nichts vom Fenster des Besitzers.
    for (let i = 0; i < EmbedChats.FEEDBACK_MAX_PER_WINDOW + 5; i++)
      expect(await rate(true, ATTACKER_SESSION)).toBe("not_found");

    for (let i = 0; i < EmbedChats.FEEDBACK_MAX_PER_WINDOW; i++)
      expect(await rate(i % 2 === 0)).toBe("updated");
    const stored = await storedChat();
    const ledger = await ledgerFeedback();
    expect(stored.feedbackScore).toBe(false);
    expect(ledger).toEqual([0, 1]);

    // Die nächste Bewertung derselben Sitzung wird abgewiesen und ändert nichts.
    const transactionSpy = jest.spyOn(MessageLedger, "transaction");
    expect(await rate(true)).toBe("rate_limited");
    expect(
      await EmbedChats.updateFeedbackScore(
        EMBED_ID,
        OWNER_SESSION,
        CHAT_ID,
        null
      )
    ).toBe(false);
    expect(transactionSpy).not.toHaveBeenCalled();
    expect(await storedChat()).toEqual(stored);
    expect(await ledgerFeedback()).toEqual(ledger);

    // Eine andere Sitzung desselben Widgets ist nicht betroffen.
    expect(await rate(true, "andere-sitzung", otherChat.id)).toBe("updated");

    // Kurz vor Ablauf der Minute noch gesperrt, danach wieder frei.
    nowSpy.mockReturnValue(startedAt + 59_999);
    expect(await rate(true)).toBe("rate_limited");
    nowSpy.mockReturnValue(startedAt + 60_000);
    expect(await rate(true)).toBe("updated");
    expect(await ledgerFeedback()).toEqual([2, 0]);
  });

  test("steht die Reihe, warten höchstens FEEDBACK_MAX_PENDING Bewertungen darin - weitere werden abgewiesen, Chat-Speicherungen nicht", async () => {
    const REJECTED = 8;
    await seedEmbedChats(
      db.client,
      Array.from(
        { length: EmbedChats.FEEDBACK_MAX_PENDING + REJECTED },
        (_, i) => ({
          embed_id: EMBED_ID,
          createdAt: new Date("2026-10-01T09:15:00+02:00"),
          session_id: `sitzung-${i}`,
        })
      )
    );
    const chats = await db.client.embed_chats.findMany({
      where: { session_id: { startsWith: "sitzung-" } },
    });

    // Die Reihe steht, z. B. hinter einer langen Thread-Verzweigung.
    let release;
    const blocker = MessageLedger.exclusive(
      () => new Promise((resolve) => (release = resolve))
    );
    const settled = [];
    const requests = chats.map((chat) =>
      EmbedChats.applyFeedback(EMBED_ID, chat.session_id, chat.id, true).then(
        (outcome) => {
          settled.push(outcome);
          return outcome;
        }
      )
    );
    for (let i = 0; i < 300 && settled.length < REJECTED; i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    // Abgewiesen wird sofort, ohne auf die Reihe zu warten.
    expect(settled).toEqual(Array(REJECTED).fill("busy"));

    // Eine Chat-Speicherung stellt sich hinter die wartenden Bewertungen.
    const saving = EmbedChats.new({
      embedId: EMBED_ID,
      prompt: "Frage",
      sessionId: "neu",
    });
    release();
    await blocker;

    const outcomes = await Promise.all(requests);
    expect(outcomes.filter((outcome) => outcome === "updated")).toHaveLength(
      EmbedChats.FEEDBACK_MAX_PENDING
    );
    expect(outcomes.filter((outcome) => outcome === "busy")).toHaveLength(
      REJECTED
    );
    expect((await saving).message).toBeNull();
    expect(await ledgerFeedback()).toEqual([
      EmbedChats.FEEDBACK_MAX_PENDING,
      0,
    ]);

    // Die Reihe ist wieder frei: Eine vorhin abgewiesene Bewertung gelingt.
    const unrated = await db.client.embed_chats.findFirst({
      where: { session_id: { startsWith: "sitzung-" }, feedbackScore: null },
    });
    expect(
      await EmbedChats.applyFeedback(
        EMBED_ID,
        unrated.session_id,
        unrated.id,
        true
      )
    ).toBe("updated");
  });
});
