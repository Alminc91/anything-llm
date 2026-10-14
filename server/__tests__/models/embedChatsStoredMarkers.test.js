/* eslint-env jest, node */
// L4 (Kontroll-Review rc20): Altdatensätze aus der Zeit vor FF1 tragen die
// Folgefragen-Zeile "[[FRAGEN: …]]" noch im gespeicherten Text (sie stand vor
// dem KI-Hinweis und wurde nicht erkannt). Jeder Leser der gespeicherten
// Antwort bekommt sie über EmbedChats.withoutProtocolMarkers ohne Marker:
// Widget-Verlauf, LLM-Verlauf (forEmbedByUser), Admin-Konversation
// (getConversationDetails), Admin-Chatliste (whereWithEmbedAndWorkspace) und
// Entwickler-API (where, Routen in apiEmbedChatsStoredMarkers.test.js).

jest.mock("../../utils/prisma", () => ({
  embed_chats: { findMany: jest.fn() },
}));
jest.mock("../../utils/http", () => ({
  safeJsonParse: (v, fallback = null) => {
    try {
      return JSON.parse(v);
    } catch {
      return fallback;
    }
  },
}));

const prisma = require("../../utils/prisma");
const { EmbedChats } = require("../../models/embedChats");

const BODY = "Ja, es gibt passende Englischkurse für Sie.";
const FOOTER = "*Ich bin eine KI und kann Fehler machen.*";
const OLD_TEXT = `${BODY}\n\n[[FRAGEN: Gibt es B1-Kurse? | Auch online?]]\n\n${FOOTER}`;
const CLEAN_TEXT = `${BODY}\n\n${FOOTER}`;

function rows() {
  return [
    {
      id: 1,
      embed_id: 7,
      session_id: "s1",
      conversation_id: "c1",
      prompt: "Englisch?",
      response: JSON.stringify({ text: OLD_TEXT, sources: [{ title: "x" }] }),
    },
    {
      id: 2,
      embed_id: 7,
      session_id: "s1",
      conversation_id: "c1",
      prompt: "Und B1?",
      response: JSON.stringify({ text: BODY, followUps: ["Mehr?"] }),
    },
  ];
}

const textOf = (row) => JSON.parse(row.response).text;

beforeEach(() => {
  prisma.embed_chats.findMany.mockReset();
  prisma.embed_chats.findMany.mockImplementation(async () => rows());
});

describe("L4: gespeicherte Antworten ohne Protokoll-Marker lesen", () => {
  test("withoutProtocolMarkers: nur der Text bereinigt, Zeilen nicht verändert", () => {
    const input = rows();
    const before = JSON.stringify(input);
    const out = EmbedChats.withoutProtocolMarkers(input);
    expect(textOf(out[0])).toBe(CLEAN_TEXT);
    expect(JSON.parse(out[0].response).sources).toEqual([{ title: "x" }]);
    expect(out[0].prompt).toBe("Englisch?");
    // ohne Marker: dieselbe Zeile
    expect(out[1]).toBe(input[1]);
    expect(JSON.stringify(input)).toBe(before);
    // Zeilen ohne response (select ohne das Feld) bleiben, wie sie sind
    const bare = { id: 3, prompt: "x" };
    expect(EmbedChats.withoutProtocolMarkers([bare])[0]).toBe(bare);
    expect(EmbedChats.withoutProtocolMarkers(null)).toEqual([]);
  });

  test("forEmbedByUser (LLM-Verlauf, ohne filterSources) liefert den Text ohne Marker", async () => {
    const chats = await EmbedChats.forEmbedByUser(
      7,
      "c1",
      20,
      { id: "desc" },
      "conversation_id",
      "s1"
    );
    expect(chats.map(textOf)).toEqual([CLEAN_TEXT, BODY]);
    // Quellen bleiben für den LLM-Pfad erhalten
    expect(JSON.parse(chats[0].response).sources).toEqual([{ title: "x" }]);
  });

  test("forEmbedByUser mit filterSources (Widget-Verlauf) ebenso", async () => {
    const chats = await EmbedChats.forEmbedByUser(7, "s1", null, null, true);
    expect(chats.map(textOf)).toEqual([CLEAN_TEXT, BODY]);
    expect(JSON.parse(chats[0].response).sources).toBeUndefined();
  });

  test("getConversationDetails (Admin-Konversation) liefert den Text ohne Marker", async () => {
    // Seit der Konversationsansicht (KIE-560) bestimmen _conversationScope
    // und _conversationRowIds die Zeilen über eine Zeilen-id; hier ohne SQL.
    const scope = jest
      .spyOn(EmbedChats, "_conversationScope")
      .mockResolvedValue({ id: 7, sessionId: "s1", where: { embed_id: 7 } });
    const rowIds = jest
      .spyOn(EmbedChats, "_conversationRowIds")
      .mockResolvedValue([1, 2]);
    const messages = await EmbedChats.getConversationDetails(1, 7);
    scope.mockRestore();
    rowIds.mockRestore();
    expect(messages.map(textOf)).toEqual([CLEAN_TEXT, BODY]);
  });

  test("whereWithEmbedAndWorkspace (Admin-Chatliste) liefert den Text ohne Marker", async () => {
    const chats = await EmbedChats.whereWithEmbedAndWorkspace({}, 20);
    expect(chats.map(textOf)).toEqual([CLEAN_TEXT, BODY]);
  });
});
