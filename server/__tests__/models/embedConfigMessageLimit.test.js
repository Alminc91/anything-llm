/* eslint-env jest, node */
// widget-grenzen-kontakt (issues/widget-grenzen-kontakt.md): EmbedConfig.new
// speichert ohne gültige Angabe NULL wie vor 8.2 (8.2-rc2 F2, D5; Hard
// Constraint 2: Die Entwickler-API legt über dieses Modell an). Den Standard 2
// beim Anlegen in der Oberfläche setzt /embeds/new (AK-3,
// endpoints/embedMessageLimitRoles.test.js); NULL heißt zur Laufzeit 2
// (utils/chats/embedMessageLimitDefault.test.js). Das Schema nennt seit
// jeher @default(20), eine Migration ist ausgeschlossen (Hard Constraint 1).
// Gegen eine echte SQLite-Datei aus den Migrationen, damit der Standard des
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

test("neues Widget ohne gültige Angabe: message_limit NULL in der Datenbank (wie vor 8.2, nicht 20 aus dem Schema)", async () => {
  expect(await storedLimit({})).toBeNull();
  for (const value of [undefined, null, "", 0, "0", -1, "abc"])
    expect([value, await storedLimit({ message_limit: value })]).toEqual([
      value,
      null,
    ]);
});

test("neues Widget mit Angabe: der Wert wird übernommen", async () => {
  expect(await storedLimit({ message_limit: 6 })).toBe(6);
  expect(await storedLimit({ message_limit: "1" })).toBe(1);
});
