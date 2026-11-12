/* eslint-env jest, node */
// widget-grenzen-kontakt (issues/widget-grenzen-kontakt.md), AK-3: Ein neues
// Widget ohne Angabe hat message_limit 2. Das Schema nennt seit jeher
// @default(20); eine Migration ist in diesem Paket ausgeschlossen (Hard
// Constraint 1), deshalb setzt EmbedConfig.new den Standard selbst. Gegen
// eine echte SQLite-Datei aus den Migrationen, damit der Standard des
// Schemas mitspielt.
jest.mock(
  "../../utils/prisma",
  () => require("../helpers/sqliteTestDatabase").testPrisma
);

const {
  createTestDatabase,
  createWorkspace,
} = require("../helpers/sqliteTestDatabase");
const { EmbedConfig } = require("../../models/embedConfig");
const {
  EMBED_MESSAGE_LIMIT_DEFAULT,
} = require("../../utils/chats/embedStandards");

jest.setTimeout(60000);

let db;
let workspace;
beforeEach(async () => {
  jest.spyOn(console, "error").mockImplementation(() => {});
  db = await createTestDatabase();
  workspace = await createWorkspace(db.client);
});
afterEach(async () => {
  console.error.mockRestore();
  await db.close();
});

async function storedLimit(data) {
  const { embed, message } = await EmbedConfig.new({
    workspace_id: workspace.id,
    ...data,
  });
  expect(message).toBeNull();
  const row = await db.client.embed_configs.findFirst({
    where: { id: embed.id },
  });
  return row.message_limit;
}

test("Standard des Nachrichtenverlaufs ist 2", () => {
  expect(EMBED_MESSAGE_LIMIT_DEFAULT).toBe(2);
});

test("neues Widget ohne Angabe: message_limit 2 in der Datenbank (nicht NULL, nicht 20 aus dem Schema)", async () => {
  expect(await storedLimit({})).toBe(2);
  for (const value of [undefined, null, "", 0, "0", -1, "abc"])
    expect([value, await storedLimit({ message_limit: value })]).toEqual([
      value,
      2,
    ]);
});

test("neues Widget mit Angabe: der Wert wird übernommen", async () => {
  expect(await storedLimit({ message_limit: 6 })).toBe(6);
  expect(await storedLimit({ message_limit: "1" })).toBe(1);
});
