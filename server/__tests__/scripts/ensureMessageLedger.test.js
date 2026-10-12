/* eslint-env jest, node */
// KIE-532 — Migration des Zählerbuchs und ihre Absicherung im Entrypoint.
//
// Die Migration enthält nur CREATE TABLE und CREATE INDEX, verträgt eine
// Wiederholung und ändert keine bestehende Zeile. Der Fallback
// (scripts/ensure-message-ledger.js, aufgerufen aus docker-entrypoint.sh)
// führt auf denselben Stand wie die Migration.
// Gegen eine echte SQLite-Datei (helpers/sqliteTestDatabase.js).
jest.mock(
  "../../utils/prisma",
  () => require("../helpers/sqliteTestDatabase").testPrisma
);

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const {
  LEDGER_MIGRATION,
  createTestDatabase,
  removeTestDatabases,
  schemaDrift,
  createWorkspace,
  createEmbed,
  seedEmbedChats,
  seedWorkspaceChats,
} = require("../helpers/sqliteTestDatabase");
const { MessageLedger } = require("../../models/messageLedger");
const { WorkspaceChats } = require("../../models/workspaceChats");
const {
  MIGRATION_FILE,
  ledgerStatements,
  ensureMessageLedger,
  main,
} = require("../../scripts/ensure-message-ledger");

const repoRoot = path.resolve(__dirname, "../../..");

// Der erste Test jeder Datei erzeugt die Vorlage mit `prisma migrate deploy`.
jest.setTimeout(60000);
const migrationSql = fs.readFileSync(
  path.join(
    repoRoot,
    "server/prisma/migrations",
    LEDGER_MIGRATION,
    "migration.sql"
  ),
  "utf8"
);

let db;
let errorSpy;
let logSpy;
beforeEach(() => {
  MessageLedger._resetCache();
  errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(async () => {
  jest.restoreAllMocks();
  if (db) await db.close();
  db = null;
});
afterAll(() => removeTestDatabases());

/** Alles, was die Migration anlegt, wie es in der Datenbank steht. */
async function ledgerObjects(client) {
  return await client.$queryRaw`
    SELECT type, name, tbl_name, sql FROM sqlite_master
    WHERE tbl_name = 'message_ledger'
       OR name = 'embed_chats_embed_id_createdAt_idx'
    ORDER BY type, name`;
}

async function seed(client) {
  const workspace = await createWorkspace(client, { messagesLimit: 10 });
  const embed = await createEmbed(client, workspace);
  await seedWorkspaceChats(client, [
    { workspaceId: workspace.id, createdAt: new Date("2026-10-01T10:00:00Z") },
    { workspaceId: workspace.id, createdAt: new Date("2026-10-02T10:00:00Z") },
  ]);
  await seedEmbedChats(client, [
    { embed_id: embed.id, createdAt: new Date("2026-10-03T10:00:00Z") },
  ]);
  return workspace;
}

async function checksums(client) {
  const sums = {};
  for (const table of [
    "workspace_chats",
    "embed_chats",
    "workspaces",
    "workspace_message_adjustments",
    "embed_configs",
  ]) {
    const rows = await client.$queryRawUnsafe(
      `SELECT * FROM "${table}" ORDER BY id`
    );
    sums[table] = crypto
      .createHash("sha256")
      .update(
        JSON.stringify(rows, (_key, value) =>
          typeof value === "bigint" ? value.toString() : value
        )
      )
      .digest("hex");
  }
  return sums;
}

async function runMain(argv) {
  let stdout = "";
  let stderr = "";
  const status = await main(argv, {
    stdout: { write: (text) => (stdout += text) },
    stderr: { write: (text) => (stderr += text) },
  });
  return { status, stdout, stderr };
}

describe("Migration 20261012150626_add_message_ledger", () => {
  test("enthält nur CREATE TABLE und CREATE INDEX, jeweils mit IF NOT EXISTS", () => {
    const statements = migrationSql
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n")
      .split(";")
      .map((statement) => statement.trim())
      .filter(Boolean);

    expect(
      statements.map((statement) => statement.split('"')[0].trim())
    ).toEqual([
      "CREATE TABLE IF NOT EXISTS",
      "CREATE INDEX IF NOT EXISTS",
      "CREATE INDEX IF NOT EXISTS",
      "CREATE UNIQUE INDEX IF NOT EXISTS",
      "CREATE INDEX IF NOT EXISTS",
    ]);
    expect(statements.map((statement) => statement.split('"')[1])).toEqual([
      "message_ledger",
      "message_ledger_workspace_id_day_idx",
      "message_ledger_embed_id_day_idx",
      "message_ledger_workspace_id_embed_id_day_hour_key",
      "embed_chats_embed_id_createdAt_idx",
    ]);
    // nichts, was eine bestehende Zeile ändern oder löschen könnte (die
    // Wörter DELETE und UPDATE kommen nur in der Kaskade des Fremdschlüssels vor)
    expect(
      statements.join("\n").replace("ON DELETE CASCADE ON UPDATE CASCADE", "")
    ).not.toMatch(/\b(ALTER|UPDATE|DELETE|DROP|INSERT|REPLACE|PRAGMA)\b/i);
    // keine Schalter mit Standardwert: Standard 0 nur für die Zähler und embed_id
    expect(migrationSql.match(/DEFAULT \S+/g)).toEqual(
      Array(6).fill("DEFAULT 0,")
    );
  });

  test("verträgt eine Wiederholung und ändert dabei nichts", async () => {
    db = await createTestDatabase();
    const workspace = await seed(db.client);
    await WorkspaceChats.new({ workspaceId: workspace.id, prompt: "gezählt" });
    const objects = await ledgerObjects(db.client);
    const ledger = await db.client.message_ledger.findMany();
    const before = await checksums(db.client);
    expect(objects.map((object) => object.name)).toEqual([
      "embed_chats_embed_id_createdAt_idx",
      "message_ledger_embed_id_day_idx",
      "message_ledger_workspace_id_day_idx",
      "message_ledger_workspace_id_embed_id_day_hour_key",
      "message_ledger",
    ]);

    for (let run = 0; run < 2; run++)
      for (const statement of ledgerStatements())
        await db.client.$executeRawUnsafe(statement);

    expect(await ledgerObjects(db.client)).toEqual(objects);
    expect(await db.client.message_ledger.findMany()).toEqual(ledger);
    expect(await checksums(db.client)).toEqual(before);
  });

  test("Schema und Migrationen stimmen überein: Prisma sieht keinen Unterschied", async () => {
    db = await createTestDatabase();
    expect(schemaDrift(db.file)).toBe("");
  });
});

describe("Fallback ensure-message-ledger", () => {
  test("legt auf einer Datenbank ohne die Migration Tabelle und Indizes an - wie die Migration, ohne den Bestand anzufassen", async () => {
    const migrated = await createTestDatabase({ activate: false });
    const expected = await ledgerObjects(migrated.client);
    await migrated.close();

    db = await createTestDatabase({ withoutLedger: true });
    await seed(db.client);
    const before = await checksums(db.client);
    expect(await ledgerObjects(db.client)).toEqual([]);

    const first = await runMain(["--db", db.file]);
    expect(first).toEqual({
      status: 0,
      stdout:
        "ensure-message-ledger: angelegt: message_ledger, message_ledger_workspace_id_day_idx, message_ledger_embed_id_day_idx, message_ledger_workspace_id_embed_id_day_hour_key, embed_chats_embed_id_createdAt_idx\n",
      stderr: "",
    });
    expect(await ledgerObjects(db.client)).toEqual(expected);
    expect(await checksums(db.client)).toEqual(before);
    expect(await db.client.message_ledger.count()).toBe(0);

    // idempotent
    const second = await runMain(["--db", db.file]);
    expect(second).toEqual({
      status: 0,
      stdout: "ensure-message-ledger: Tabelle und Indizes vorhanden\n",
      stderr: "",
    });
    expect(await ledgerObjects(db.client)).toEqual(expected);
    expect(await checksums(db.client)).toEqual(before);

    // Die Datenbank entspricht dem Prisma-Schema …
    expect(schemaDrift(db.file)).toBe("");
    // … und die Migration läuft danach auf den vorhandenen Objekten durch.
    expect(await db.migrate()).toMatch(LEDGER_MIGRATION);
    expect(await ledgerObjects(db.client)).toEqual(expected);
    expect(await checksums(db.client)).toEqual(before);
  }, 60000);

  test("eine als angewendet markierte, aber nie ausgeführte Migration: Erst der Fallback macht das Speichern von Chats wieder möglich", async () => {
    db = await createTestDatabase({ withoutLedger: true });
    const workspace = await seed(db.client);
    // So hinterlässt der Fallback im Entrypoint eine fehlgeschlagene Migration.
    await db.client.$executeRaw`
      INSERT INTO _prisma_migrations
        (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count)
      VALUES
        (${crypto.randomUUID()},
         ${crypto.createHash("sha256").update(migrationSql).digest("hex")},
         ${Date.now()}, ${LEDGER_MIGRATION}, NULL, NULL, ${Date.now()}, 1)`;
    expect(await db.migrate()).toMatch(/No pending migrations to apply/);
    expect(await ledgerObjects(db.client)).toEqual([]);

    // Ohne Tabelle: Zeile und Zähler entstehen gemeinsam oder gar nicht.
    const failed = await WorkspaceChats.new({
      workspaceId: workspace.id,
      prompt: "geht nicht",
    });
    expect(failed.chat).toBeNull();
    expect(await db.client.workspace_chats.count()).toBe(2);

    expect(await ensureMessageLedger(db.client)).toHaveLength(5);
    MessageLedger._resetCache();
    const saved = await WorkspaceChats.new({
      workspaceId: workspace.id,
      prompt: "geht",
    });
    expect(saved.message).toBeNull();
    expect(await db.client.message_ledger.count()).toBe(1);
    expect(schemaDrift(db.file)).toBe("");
  }, 60000);

  test("führt nie etwas anderes aus als CREATE … IF NOT EXISTS", () => {
    expect(ledgerStatements()).toHaveLength(5);
    const read = jest.spyOn(fs, "readFileSync");
    for (const sql of [
      'DROP TABLE "workspace_chats";',
      'CREATE TABLE "x" ("id" INTEGER);',
      'CREATE TABLE IF NOT EXISTS "x" ("id" INTEGER);\nDELETE FROM "embed_chats";',
      'UPDATE "workspaces" SET "messagesLimit" = NULL;',
    ]) {
      read.mockImplementation((file, ...rest) =>
        file === MIGRATION_FILE
          ? sql
          : jest.requireActual("fs").readFileSync(file, ...rest)
      );
      expect(() => ledgerStatements()).toThrow(/Unerwartete Anweisung/);
    }
  });

  test("fehlende Datenbank ist ein Fehler, kein stilles Anlegen", async () => {
    const result = await runMain(["--db", "/gibt/es/nicht.db"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Datenbank nicht gefunden/);
  });
});

describe("docker-entrypoint.sh", () => {
  const entrypoint = fs.readFileSync(
    path.join(repoRoot, "docker/docker-entrypoint.sh"),
    "utf8"
  );

  test("sichert das Zählerbuch nach `prisma migrate deploy` und vor dem Start des Servers ab", () => {
    const deploy = entrypoint.lastIndexOf("npx prisma migrate deploy");
    const ensure = entrypoint.indexOf(
      "node /app/server/scripts/ensure-message-ledger.js"
    );
    const server = entrypoint.indexOf("node /app/server/index.js");
    expect(deploy).toBeGreaterThan(-1);
    expect(ensure).toBeGreaterThan(deploy);
    expect(server).toBeGreaterThan(ensure);
    // Das Skript, das der Entrypoint aufruft, gibt es an dieser Stelle im Image
    // (./server wird nach /app/server kopiert).
    expect(
      fs.existsSync(
        path.join(repoRoot, "server/scripts/ensure-message-ledger.js")
      )
    ).toBe(true);
    expect(MIGRATION_FILE).toBe(
      path.join(
        repoRoot,
        "server/prisma/migrations",
        LEDGER_MIGRATION,
        "migration.sql"
      )
    );
  });

  test("ein Fehler der Absicherung verhindert den Start nicht", () => {
    const block = entrypoint.slice(
      entrypoint.indexOf("# --- KIE-532"),
      entrypoint.indexOf("# --- KIE-478/480")
    );
    expect(block).toMatch(
      /if ! \$LEDGER_RUN node \/app\/server\/scripts\/ensure-message-ledger\.js; then\s+echo "\[entrypoint\] ⚠️/
    );
    expect(block).toMatch(/\n\s+true\n\s+\} &&\n/);
    expect(block).not.toMatch(/exit 1/);
  });
});
