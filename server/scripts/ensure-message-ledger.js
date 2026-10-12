#!/usr/bin/env node
/**
 * Sichert die Tabelle des Zählerbuchs ab (KIE-532) - Fallback zur Migration
 * 20261012150626_add_message_ledger, aufgerufen aus docker-entrypoint.sh nach
 * `prisma migrate deploy`.
 *
 * Warum: Der Fallback im Entrypoint markiert eine fehlgeschlagene Migration
 * als angewendet, ohne ihre Anweisungen auszuführen. Ohne message_ledger
 * könnte der Server keine Chat-Zeile mehr speichern, weil Zeile und Zähler in
 * einer Transaktion entstehen.
 *
 * Führt genau die Anweisungen der Migration aus. Die sind rein additiv und
 * idempotent (nur CREATE TABLE / CREATE INDEX mit IF NOT EXISTS): Ist alles
 * vorhanden, passiert nichts; keine bestehende Zeile wird angefasst.
 *
 *   node scripts/ensure-message-ledger.js [--db /pfad/anythingllm.db]
 *
 * Status: 0 = Tabelle und Indizes vorhanden, 1 = Fehler.
 */

const fs = require("fs");
const path = require("path");

const MIGRATION_FILE = path.resolve(
  __dirname,
  "../prisma/migrations/20261012150626_add_message_ledger/migration.sql"
);
const ALLOWED_STATEMENT =
  /^CREATE (TABLE|INDEX|UNIQUE INDEX) IF NOT EXISTS "[A-Za-z_]+"/;

/**
 * Anweisungen der Migration, ohne Kommentare. Wirft, wenn etwas anderes als
 * CREATE TABLE / CREATE INDEX mit IF NOT EXISTS darin steht: Dieser Weg darf
 * nie mehr tun als anlegen, was fehlt.
 * @returns {string[]}
 */
function ledgerStatements() {
  const statements = fs
    .readFileSync(MIGRATION_FILE, "utf8")
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);
  for (const statement of statements)
    if (!ALLOWED_STATEMENT.test(statement))
      throw new Error(
        `Unerwartete Anweisung in der Migration: ${statement.slice(0, 60)}`
      );
  return statements;
}

/**
 * @param {import("@prisma/client").PrismaClient} client
 * @returns {Promise<string[]>} - Namen der Tabellen und Indizes, die neu angelegt wurden
 */
async function ensureMessageLedger(client) {
  const names = async () =>
    (
      await client.$queryRaw`
        SELECT name FROM sqlite_master
        WHERE tbl_name IN ('message_ledger', 'embed_chats')`
    ).map((row) => row.name);

  const before = new Set(await names());
  // Statisches SQL aus der Migrationsdatei des Repos, keine Eingabe von außen.
  for (const statement of ledgerStatements())
    await client.$executeRawUnsafe(statement);
  return (await names()).filter((name) => !before.has(name));
}

async function main(
  argv,
  { stdout = process.stdout, stderr = process.stderr } = {}
) {
  let client = null;
  try {
    const dbIndex = argv.indexOf("--db");
    if (dbIndex !== -1) {
      const file = argv[dbIndex + 1];
      if (!file || !fs.existsSync(path.resolve(file)))
        throw new Error(`Datenbank nicht gefunden: ${file}`);
      const { PrismaClient } = require("@prisma/client");
      client = new PrismaClient({
        datasources: { db: { url: `file:${path.resolve(file)}` } },
      });
    } else {
      client = require("../utils/prisma");
    }

    const created = await ensureMessageLedger(client);
    stdout.write(
      created.length
        ? `ensure-message-ledger: angelegt: ${created.join(", ")}\n`
        : "ensure-message-ledger: Tabelle und Indizes vorhanden\n"
    );
    return 0;
  } catch (error) {
    stderr.write(`ensure-message-ledger: ${error.message}\n`);
    return 1;
  } finally {
    if (client) await client.$disconnect().catch(() => {});
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then((status) => {
    process.exitCode = status;
  });
}

module.exports = {
  MIGRATION_FILE,
  ledgerStatements,
  ensureMessageLedger,
  main,
};
