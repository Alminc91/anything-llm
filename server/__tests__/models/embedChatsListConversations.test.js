/* eslint-env jest, node */
// KIE-503 — Public embed endpoint "Frühere Chats": listConversationsForSession
// must be strictly bound to embed_id AND session_id (BOLA/IDOR, analog KIE-505),
// truncate titles to 80 chars, normalize BigInt aggregates to Number and
// short-circuit to [] when args are missing.
const prisma = require("../../utils/prisma");

// Mock prisma. $queryRaw is a tagged template: the mock receives
// (templateStrings, ...values) so we can assert both the SQL text and the
// bound values that reach the DB. findMany serves the title lookup.
jest.mock("../../utils/prisma", () => ({
  $queryRaw: jest.fn(),
  embed_chats: {
    findMany: jest.fn(),
  },
}));

// embedChats.js only pulls safeJsonParse out of utils/http (used by
// filterSources, not by the path under test). Mock it to avoid loading the
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

const EMBED_ID = 7;
const SESSION_ID = "session-abc-123";

// Aggregated rows as SQLite/Prisma returns them from $queryRaw: COUNT/MIN(id)
// come back as BigInt, timestamps as numbers.
const RAW_ROWS = [
  {
    conversation_id: "conv-uuid-1",
    first_chat_id: BigInt(11),
    started_at: 1750000000000,
    last_message_at: 1750000500000,
    message_count: BigInt(3),
  },
  {
    conversation_id: "conv-uuid-2",
    first_chat_id: BigInt(42),
    started_at: 1749000000000,
    last_message_at: 1749000900000,
    message_count: BigInt(1),
  },
];

const LONG_PROMPT = "x".repeat(200);
const FIRST_CHATS = [
  { id: 11, prompt: "Wann beginnt der Yoga-Kurs?" },
  { id: 42, prompt: LONG_PROMPT },
];

beforeEach(() => {
  jest.clearAllMocks();
  prisma.$queryRaw.mockResolvedValue(RAW_ROWS);
  prisma.embed_chats.findMany.mockResolvedValue(FIRST_CHATS);
});

describe("listConversationsForSession — session binding (KIE-503/505)", () => {
  test("embedId AND sessionId flow into the raw query as bound values", async () => {
    await EmbedChats.listConversationsForSession(EMBED_ID, SESSION_ID);

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    const [templateStrings, ...values] = prisma.$queryRaw.mock.calls[0];

    // Both identifiers must be bound template values (Prisma parameterization,
    // no string interpolation) — a list without the session bind would be BOLA.
    expect(values).toContain(EMBED_ID);
    expect(values).toContain(SESSION_ID);

    // The SQL text must bind embed_id + session_id and filter DSGVO-invalidated
    // rows (include = 1, set to 0 by markHistoryInvalid).
    const sql = templateStrings.join("?");
    expect(sql).toMatch(/WHERE\s+embed_id\s*=\s*\?/i);
    expect(sql).toMatch(/AND\s+session_id\s*=\s*\?/i);
    expect(sql).toMatch(/AND\s+include\s*=\s*1/i);
    expect(sql).toMatch(/GROUP BY\s+COALESCE\(conversation_id,\s*session_id\)/i);
    expect(sql).toMatch(/ORDER BY\s+last_message_at\s+DESC/i);
  });

  test("default limit 50 is bound; custom limit is passed through", async () => {
    await EmbedChats.listConversationsForSession(EMBED_ID, SESSION_ID);
    expect(prisma.$queryRaw.mock.calls[0].slice(1)).toContain(50);

    await EmbedChats.listConversationsForSession(EMBED_ID, SESSION_ID, 5);
    expect(prisma.$queryRaw.mock.calls[1].slice(1)).toContain(5);
  });

  test("titles are loaded in ONE findMany (no N+1) via id IN first_chat_ids", async () => {
    await EmbedChats.listConversationsForSession(EMBED_ID, SESSION_ID);

    expect(prisma.embed_chats.findMany).toHaveBeenCalledTimes(1);
    const args = prisma.embed_chats.findMany.mock.calls[0][0];
    expect(args.where.id.in).toEqual([11, 42]);
    expect(args.select).toEqual({ id: true, prompt: true });
  });
});

describe("listConversationsForSession — result shape", () => {
  test("title is the first prompt truncated to 80 characters", async () => {
    const result = await EmbedChats.listConversationsForSession(
      EMBED_ID,
      SESSION_ID
    );

    expect(result[0].title).toBe("Wann beginnt der Yoga-Kurs?");
    expect(result[1].title).toBe(LONG_PROMPT.slice(0, 80));
    expect(result[1].title).toHaveLength(80);
  });

  test("BigInt aggregates are normalized to Number (JSON-serializable)", async () => {
    const result = await EmbedChats.listConversationsForSession(
      EMBED_ID,
      SESSION_ID
    );

    expect(result).toHaveLength(2);
    for (const conv of result) {
      expect(typeof conv.messageCount).toBe("number");
      expect(typeof conv.startedAt).toBe("number");
      expect(typeof conv.lastMessageAt).toBe("number");
    }
    expect(result[0]).toEqual({
      conversationId: "conv-uuid-1",
      title: "Wann beginnt der Yoga-Kurs?",
      startedAt: 1750000000000,
      lastMessageAt: 1750000500000,
      messageCount: 3,
    });
    // JSON.stringify would throw on any leftover BigInt.
    expect(() => JSON.stringify(result)).not.toThrow();
  });

  test("first_chat_id is internal and not exposed in the response", async () => {
    const result = await EmbedChats.listConversationsForSession(
      EMBED_ID,
      SESSION_ID
    );
    for (const conv of result) {
      expect(conv).not.toHaveProperty("first_chat_id");
      expect(conv).not.toHaveProperty("firstChatId");
    }
  });

  test("empty result set returns [] without a title lookup", async () => {
    prisma.$queryRaw.mockResolvedValueOnce([]);
    const result = await EmbedChats.listConversationsForSession(
      EMBED_ID,
      SESSION_ID
    );
    expect(result).toEqual([]);
    expect(prisma.embed_chats.findMany).not.toHaveBeenCalled();
  });
});

describe("listConversationsForSession — guards", () => {
  test("missing embedId short-circuits to [] without touching the DB", async () => {
    const result = await EmbedChats.listConversationsForSession(
      null,
      SESSION_ID
    );
    expect(result).toEqual([]);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(prisma.embed_chats.findMany).not.toHaveBeenCalled();
  });

  test("missing sessionId short-circuits to [] without touching the DB", async () => {
    const result = await EmbedChats.listConversationsForSession(EMBED_ID, null);
    expect(result).toEqual([]);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(prisma.embed_chats.findMany).not.toHaveBeenCalled();
  });

  test("DB error is caught and returns [] (console.error, no throw)", async () => {
    prisma.$queryRaw.mockRejectedValueOnce(new Error("db down"));
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    const result = await EmbedChats.listConversationsForSession(
      EMBED_ID,
      SESSION_ID
    );
    expect(result).toEqual([]);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
