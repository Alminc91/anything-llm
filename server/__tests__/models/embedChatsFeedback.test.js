/* eslint-env jest, node */
// KIE-504 — Bewertungsfunktion (👍/👎) pro Embed-Antwort.
// updateFeedbackScore muss die chatId zusätzlich an embed_id UND die besitzende
// session_id binden (BOLA/IDOR-Härtung, analog KIE-505), damit eine geleakte
// chatId keine fremde Antwort bewerten kann. Zusätzlich: korrektes Mapping von
// true/false/null auf den feedbackScore.
const prisma = require("../../utils/prisma");

jest.mock("../../utils/prisma", () => ({
  embed_chats: {
    updateMany: jest.fn(),
  },
}));

jest.mock("../../utils/http", () => ({
  safeJsonParse: (v) => {
    try {
      return JSON.parse(v);
    } catch {
      return {};
    }
  },
}));

const { EmbedChats } = require("../../models/embedChats");

const OWNER_SESSION = "owner-session";
const ATTACKER_SESSION = "attacker-session";
const EMBED_ID = 1;
const CHAT_ID = 42;
// One rated-able row owned by OWNER_SESSION under embed 1.
const ROWS = [
  {
    id: CHAT_ID,
    embed_id: EMBED_ID,
    session_id: OWNER_SESSION,
    feedbackScore: null,
  },
];

function rowMatches(row, where) {
  return Object.entries(where).every(([k, v]) => row[k] === v);
}

beforeEach(() => {
  jest.clearAllMocks();
  prisma.embed_chats.updateMany.mockImplementation(async ({ where }) => ({
    count: ROWS.filter((r) => rowMatches(r, where)).length,
  }));
});

describe("updateFeedbackScore — chatId bound to embed + session (KIE-504)", () => {
  test("owner session sets 👍 (true) — where has id + embed_id + session_id", async () => {
    const ok = await EmbedChats.updateFeedbackScore(
      EMBED_ID,
      OWNER_SESSION,
      CHAT_ID,
      true
    );
    expect(ok).toBe(true);
    const { where, data } = prisma.embed_chats.updateMany.mock.calls[0][0];
    expect(where).toMatchObject({
      id: CHAT_ID,
      embed_id: EMBED_ID,
      session_id: OWNER_SESSION,
    });
    // KIE-507: 👍 leert Kommentar/Grund konsistent mit (keine verwaisten Felder).
    expect(data).toEqual({
      feedbackScore: true,
      feedbackText: null,
      feedbackReason: null,
    });
  });

  test("👎 (false) maps to feedbackScore false", async () => {
    const ok = await EmbedChats.updateFeedbackScore(
      EMBED_ID,
      OWNER_SESSION,
      CHAT_ID,
      false
    );
    expect(ok).toBe(true);
    const { data } = prisma.embed_chats.updateMany.mock.calls[0][0];
    expect(data).toEqual({ feedbackScore: false });
  });

  test("null removes the rating (toggle) — feedbackScore + Kommentar/Grund geleert", async () => {
    const ok = await EmbedChats.updateFeedbackScore(
      EMBED_ID,
      OWNER_SESSION,
      CHAT_ID,
      null
    );
    expect(ok).toBe(true);
    const { data } = prisma.embed_chats.updateMany.mock.calls[0][0];
    // KIE-507: Entfernen der Bewertung leert auch Freitext + Grund konsistent.
    expect(data).toEqual({
      feedbackScore: null,
      feedbackText: null,
      feedbackReason: null,
    });
  });

  test("foreign session cannot rate owner's chat (count 0 -> false)", async () => {
    const ok = await EmbedChats.updateFeedbackScore(
      EMBED_ID,
      ATTACKER_SESSION,
      CHAT_ID,
      true
    );
    expect(ok).toBe(false);
    const { where } = prisma.embed_chats.updateMany.mock.calls[0][0];
    expect(where.session_id).toBe(ATTACKER_SESSION);
  });

  test("wrong embed scope cannot rate the chat (count 0 -> false)", async () => {
    const ok = await EmbedChats.updateFeedbackScore(
      999,
      OWNER_SESSION,
      CHAT_ID,
      true
    );
    expect(ok).toBe(false);
  });

  test("missing args short-circuit without touching the DB", async () => {
    expect(await EmbedChats.updateFeedbackScore(null, OWNER_SESSION, CHAT_ID, true)).toBe(false);
    expect(await EmbedChats.updateFeedbackScore(EMBED_ID, null, CHAT_ID, true)).toBe(false);
    expect(await EmbedChats.updateFeedbackScore(EMBED_ID, OWNER_SESSION, null, true)).toBe(false);
    expect(prisma.embed_chats.updateMany).not.toHaveBeenCalled();
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
    const { data } = prisma.embed_chats.updateMany.mock.calls[0][0];
    expect(data).toEqual({
      feedbackScore: false,
      feedbackText: "Antwort war zu allgemein",
      feedbackReason: "Zu ungenau",
    });
  });

  test("ohne opts wird NUR feedbackScore geschrieben (Text/Grund unangetastet)", async () => {
    await EmbedChats.updateFeedbackScore(EMBED_ID, OWNER_SESSION, CHAT_ID, false);
    const { data } = prisma.embed_chats.updateMany.mock.calls[0][0];
    expect(data).toEqual({ feedbackScore: false });
    expect(data).not.toHaveProperty("feedbackText");
    expect(data).not.toHaveProperty("feedbackReason");
  });

  test("nur comment übergeben → nur feedbackText in data (Grund unangetastet)", async () => {
    await EmbedChats.updateFeedbackScore(EMBED_ID, OWNER_SESSION, CHAT_ID, false, {
      feedbackText: "Detail fehlt",
    });
    const { data } = prisma.embed_chats.updateMany.mock.calls[0][0];
    expect(data).toEqual({ feedbackScore: false, feedbackText: "Detail fehlt" });
    expect(data).not.toHaveProperty("feedbackReason");
  });

  test("überlanger Freitext wird auf 2000 Zeichen gekürzt", async () => {
    const long = "x".repeat(5000);
    await EmbedChats.updateFeedbackScore(EMBED_ID, OWNER_SESSION, CHAT_ID, false, {
      feedbackText: long,
    });
    const { data } = prisma.embed_chats.updateMany.mock.calls[0][0];
    expect(data.feedbackText).toHaveLength(2000);
  });

  test("Wechsel 👎→👍 leert alten Kommentar/Grund (keine verwaisten Felder)", async () => {
    // Nutzer klickt später 👍; Widget sendt keine comment/reason mit.
    await EmbedChats.updateFeedbackScore(EMBED_ID, OWNER_SESSION, CHAT_ID, true);
    const { data } = prisma.embed_chats.updateMany.mock.calls[0][0];
    expect(data).toEqual({
      feedbackScore: true,
      feedbackText: null,
      feedbackReason: null,
    });
  });

  test("fremde Session kann auch mit Kommentar nichts schreiben (BOLA)", async () => {
    const ok = await EmbedChats.updateFeedbackScore(
      EMBED_ID,
      ATTACKER_SESSION,
      CHAT_ID,
      false,
      { feedbackText: "hack", feedbackReason: "Falsch" }
    );
    expect(ok).toBe(false);
    const { where } = prisma.embed_chats.updateMany.mock.calls[0][0];
    expect(where.session_id).toBe(ATTACKER_SESSION);
  });
});
