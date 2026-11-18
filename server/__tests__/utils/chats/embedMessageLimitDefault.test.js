/* eslint-env jest, node */
// widget-grenzen-kontakt (issues/widget-grenzen-kontakt.md), AK-3: Ein
// Widget mit message_limit NULL nutzt zur Laufzeit 2 frühere Nachrichten als
// Zusammenhang (bis 8.1: 20). Geprüft am Aufruf, der den Verlauf lädt
// (EmbedChats.forEmbedByUser); danach bricht der Test den Lauf ab.
jest.mock("../../../utils/prisma", () => ({}));
jest.mock("../../../models/embedChats", () => ({
  EmbedChats: { forEmbedByUser: jest.fn() },
}));
jest.mock("../../../utils/helpers", () => ({
  getVectorDbClass: jest.fn(),
  getLLMProvider: jest.fn(),
}));
jest.mock("../../../utils/chats/index", () => ({
  chatPrompt: jest.fn().mockResolvedValue("System"),
  sourceIdentifier: jest.fn(),
}));

const helpers = require("../../../utils/helpers");
const { EmbedChats } = require("../../../models/embedChats");
const { streamChatWithForEmbed } = require("../../../utils/chats/embed");

const STOP = new Error("Verlauf geladen, Lauf beendet");

beforeEach(() => {
  jest.clearAllMocks();
  helpers.getVectorDbClass.mockReturnValue({
    hasNamespace: jest.fn().mockResolvedValue(true),
    namespaceCount: jest.fn().mockResolvedValue(10),
  });
  helpers.getLLMProvider.mockReturnValue({});
  EmbedChats.forEmbedByUser.mockRejectedValue(STOP);
});

/** Anzahl früherer Nachrichten, mit der der Verlauf geladen wird. */
async function historyLimit(message_limit) {
  const embed = {
    id: 3,
    chat_mode: "chat",
    message_limit,
    visual_config: null,
    workspace: { id: 9, slug: "chatbot", messagesLimit: null, topN: 4 },
  };
  await expect(
    streamChatWithForEmbed({ locals: {} }, embed, "Hallo", "sess", {
      conversationId: "conv",
    })
  ).rejects.toBe(STOP);
  expect(EmbedChats.forEmbedByUser).toHaveBeenCalledTimes(1);
  const [embedId, conversationId, limit] =
    EmbedChats.forEmbedByUser.mock.calls[0];
  expect([embedId, conversationId]).toEqual([3, "conv"]);
  jest.clearAllMocks();
  EmbedChats.forEmbedByUser.mockRejectedValue(STOP);
  return limit;
}

test("message_limit NULL oder fehlend: 2 frühere Nachrichten", async () => {
  expect(await historyLimit(null)).toBe(2);
  expect(await historyLimit(undefined)).toBe(2);
});

test("gespeicherter Wert gilt weiter", async () => {
  expect(await historyLimit(5)).toBe(5);
  expect(await historyLimit(20)).toBe(20);
});
