/* eslint-env jest, node */
// KIE-505 — BOLA/IDOR hardening: a conversation_id lookup must additionally be
// bound to its owning session_id so a leaked conversationId cannot load or
// invalidate foreign chat history.
const prisma = require("../../utils/prisma");

// Mock prisma so we can assert on the WHERE clause that reaches the DB. The
// findMany/updateMany mocks emulate SQLite row filtering: a row is only
// returned/affected when every field in the WHERE clause matches.
jest.mock("../../utils/prisma", () => ({
  embed_chats: {
    findMany: jest.fn(),
    updateMany: jest.fn(),
  },
}));

// embedChats.js only pulls safeJsonParse out of utils/http (used by
// filterSources, not by the paths under test). Mock it to avoid loading the
// heavy http/auth module graph.
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

// Simulated store: chat rows for one embed. The owner session created the
// conversation; an attacker knows the conversationId but has a different
// session_id.
const OWNER_SESSION = "owner-session";
const ATTACKER_SESSION = "attacker-session";
const CONVERSATION_ID = "conv-uuid-123";
const ROWS = [
  {
    id: 1,
    embed_id: 1,
    prompt: "hi",
    response: "{}",
    session_id: OWNER_SESSION,
    conversation_id: CONVERSATION_ID,
    include: true,
  },
];

function rowMatches(row, where) {
  return Object.entries(where).every(([k, v]) => row[k] === v);
}

beforeEach(() => {
  jest.clearAllMocks();
  prisma.embed_chats.findMany.mockImplementation(async ({ where }) =>
    ROWS.filter((r) => rowMatches(r, where))
  );
  prisma.embed_chats.updateMany.mockImplementation(async ({ where }) => ({
    count: ROWS.filter((r) => rowMatches(r, where)).length,
  }));
});

describe("forEmbedByUser — conversation bound to session (KIE-505)", () => {
  test("owner session + conversationId loads the history", async () => {
    const history = await EmbedChats.forEmbedByUser(
      1,
      CONVERSATION_ID,
      null,
      null,
      "conversation_id",
      OWNER_SESSION
    );
    expect(history).toHaveLength(1);
    const { where } = prisma.embed_chats.findMany.mock.calls[0][0];
    expect(where).toMatchObject({
      embed_id: 1,
      include: true,
      conversation_id: CONVERSATION_ID,
      session_id: OWNER_SESSION,
    });
  });

  test("foreign session + known conversationId returns EMPTY (IDOR blocked)", async () => {
    const history = await EmbedChats.forEmbedByUser(
      1,
      CONVERSATION_ID,
      null,
      null,
      "conversation_id",
      ATTACKER_SESSION
    );
    expect(history).toEqual([]);
    const { where } = prisma.embed_chats.findMany.mock.calls[0][0];
    expect(where.session_id).toBe(ATTACKER_SESSION);
  });

  test("no boundSessionId keeps legacy behavior (conversation_id only)", async () => {
    await EmbedChats.forEmbedByUser(
      1,
      CONVERSATION_ID,
      null,
      null,
      "conversation_id"
    );
    const { where } = prisma.embed_chats.findMany.mock.calls[0][0];
    expect(where).not.toHaveProperty("session_id");
    expect(where.conversation_id).toBe(CONVERSATION_ID);
  });

  test("legacy filterSources boolean arg still works and does not bind session", async () => {
    // Old callers pass a boolean as the 5th arg. It must be treated as
    // filterSources and default identifierType back to session_id.
    await EmbedChats.forEmbedByUser(1, OWNER_SESSION, null, null, true);
    const { where } = prisma.embed_chats.findMany.mock.calls[0][0];
    expect(where.session_id).toBe(OWNER_SESSION);
    expect(where).not.toHaveProperty("conversation_id");
  });

  test("backwards-compat: old chats where conversation_id == session_id still match", async () => {
    // KIE-502 legacy row: conversation_id equals session_id.
    prisma.embed_chats.findMany.mockImplementationOnce(async ({ where }) =>
      [
        {
          id: 9,
          embed_id: 1,
          session_id: "legacy",
          conversation_id: "legacy",
          include: true,
        },
      ].filter((r) => rowMatches(r, where))
    );
    const history = await EmbedChats.forEmbedByUser(
      1,
      "legacy",
      null,
      null,
      "conversation_id",
      "legacy"
    );
    expect(history).toHaveLength(1);
  });
});

describe("markHistoryInvalid — conversation bound to session (KIE-505)", () => {
  test("boundSessionId adds session_id to the updateMany WHERE clause", async () => {
    await EmbedChats.markHistoryInvalid(
      1,
      CONVERSATION_ID,
      "conversation_id",
      OWNER_SESSION
    );
    const { where, data } = prisma.embed_chats.updateMany.mock.calls[0][0];
    expect(where).toMatchObject({
      embed_id: 1,
      conversation_id: CONVERSATION_ID,
      session_id: OWNER_SESSION,
    });
    expect(data).toEqual({ include: false });
  });

  test("foreign session cannot invalidate owner's conversation (count 0)", async () => {
    await EmbedChats.markHistoryInvalid(
      1,
      CONVERSATION_ID,
      "conversation_id",
      ATTACKER_SESSION
    );
    const result = await prisma.embed_chats.updateMany.mock.results[0].value;
    expect(result.count).toBe(0);
  });
});
