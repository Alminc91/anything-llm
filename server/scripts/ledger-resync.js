#!/usr/bin/env node
/**
 * Neuaufbau einzelner Tage des Zählerbuchs aus den vorhandenen Chat-Zeilen
 * (KIE-532).
 *
 * Gedacht für den Fall, dass eine Zeit lang Chat-Zeilen ohne Zählung
 * entstanden sind: nach einem Rollback auf ein älteres Image (das das
 * Zählerbuch nicht kennt) mit anschließendem erneutem Update. Für die Stunden
 * ab dem genannten Berliner Kalendertag wird nachgezählt, was an Zeilen
 * vorhanden ist, und das Zählerbuch dort angehoben, wo es darunter liegt.
 *
 *   node scripts/ledger-resync.js --from=2026-10-12 [--db /pfad/anythingllm.db]
 *        [--dry-run] [--json]
 *
 * Regeln:
 * - Es wird nur angehoben, nie gesenkt: Kein Wert von messages, copied,
 *   conversations_started, feedback_positive oder feedback_negative sinkt.
 *   Gelöschte Zeilen bleiben also gezählt.
 * - Workspace-Chats: Fehlen in einer Stunde Zeilen im Zählerbuch (vorhandene
 *   Zeilen > messages + copied), steigt messages um die Differenz. Kopien aus
 *   Thread-Verzweigungen, die das ältere Image angelegt hat, zählen dabei als
 *   messages - so hat sie das ältere Image auch gezählt.
 * - Widget-Chats: Verglichen wird je Widget, Tag und Stunde über alle
 *   Workspaces hinweg. Ein umgehängtes Widget verschiebt dadurch nichts; nur
 *   was insgesamt fehlt, wird dem heutigen Workspace des Widgets gutgeschrieben.
 * - Chat-Zeilen werden nur gelesen.
 * - Grenze: Verglichen wird je Stunde die Zahl der vorhandenen Zeilen mit dem
 *   gebuchten Stand. Wurden in derselben Stunde gezählte Zeilen gelöscht und
 *   ungezählte angelegt, bleibt diese Differenz unerkannt.
 *
 * Voraussetzung: Der Nachtrag ist abgeschlossen (Markierung
 * message_ledger_backfill). Vorher würde der Nachtrag dieselben Zeilen später
 * noch einmal buchen.
 *
 * Der Lauf ist eine einzige Transaktion: Schreibzugriffe eines laufenden
 * Servers warten so lange (Busy-Timeout 5 s). Bei großen Datenbanken und
 * weit zurückliegendem Datum deshalb nachts oder bei gestopptem Server
 * ausführen. --dry-run zeigt nur, was sich ändern würde.
 *
 * Status: 0 = erledigt, 2 = Aufruf- oder Laufzeitfehler.
 */

const fs = require("fs");
const path = require("path");
const { Prisma } = require("@prisma/client");
const { berlinMidnight } = require("../utils/helpers/billingWindow");
const { MessageLedger } = require("../models/messageLedger");
const {
  STARTS_CONVERSATION_SQL,
  hourBucketSql,
  hasTimeSql,
} = require("../utils/boot/messageLedgerBackfill");

const MS_PER_HOUR = 60 * 60 * 1000;
// Ausdrücklich gesetzt: Der Lauf liest alle Zeilen ab dem Datum.
const TRANSACTION_OPTIONS = { maxWait: 10_000, timeout: 600_000 };

/**
 * Vorhandene Chat-Zeilen ab einem Zeitpunkt, je Workspace bzw. Widget und
 * Berliner Stunde. Zeilen ohne Workspace/Widget oder ohne Zahl in createdAt
 * bleiben außen vor, wie in der Live-Zählung und im Nachtrag.
 */
async function readExistingRows(tx, startMs) {
  const workspaceGroups = await tx.$queryRaw`
    SELECT c.workspaceId AS workspace_id,
           ${hourBucketSql("c.createdAt")} AS bucket,
           COUNT(*) AS n
    FROM workspace_chats c
    JOIN workspaces w ON w.id = c.workspaceId
    WHERE c.createdAt >= ${startMs} AND ${hasTimeSql("c.createdAt")}
    GROUP BY 1, 2`;
  const embedGroups = await tx.$queryRaw`
    SELECT e.workspace_id AS workspace_id,
           c.embed_id AS embed_id,
           ${hourBucketSql("c.createdAt")} AS bucket,
           COUNT(*) AS n,
           SUM(CASE WHEN ${STARTS_CONVERSATION_SQL} THEN 1 ELSE 0 END) AS started,
           SUM(CASE WHEN c.feedbackScore = 1 THEN 1 ELSE 0 END) AS positive,
           SUM(CASE WHEN c.feedbackScore = 0 THEN 1 ELSE 0 END) AS negative
    FROM (
      SELECT id, embed_id, createdAt, feedbackScore,
             COALESCE(conversation_id, session_id) AS k
      FROM embed_chats
      WHERE createdAt >= ${startMs} AND ${hasTimeSql("createdAt")}
    ) c
    JOIN embed_configs e ON e.id = c.embed_id
    JOIN workspaces w ON w.id = e.workspace_id
    GROUP BY 1, 2, 3`;
  return { workspaceGroups, embedGroups };
}

/** Summiert Gruppen auf Berliner Tag und Stunde (Stunde 2 gibt es im Herbst zweimal). */
function byBerlinHour(groups, keyOf) {
  const cells = new Map();
  for (const group of groups) {
    const { day, hour } = MessageLedger.berlinDayHour(
      Number(group.bucket) * MS_PER_HOUR
    );
    const key = `${keyOf(group)}|${day}|${hour}`;
    const cell = cells.get(key) ?? {
      workspaceId: Number(group.workspace_id),
      embedId: Number(group.embed_id ?? 0),
      day,
      hour,
      rows: 0,
      started: 0,
      positive: 0,
      negative: 0,
    };
    cell.rows += Number(group.n);
    cell.started += Number(group.started ?? 0);
    cell.positive += Number(group.positive ?? 0);
    cell.negative += Number(group.negative ?? 0);
    cells.set(key, cell);
  }
  return cells;
}

/**
 * Berechnet die Stunden ab fromDay neu und hebt das Zählerbuch an, wo
 * vorhandene Zeilen nicht gezählt sind.
 *
 * @param {Object} params
 * @param {import("@prisma/client").PrismaClient} params.client
 * @param {string} params.fromDay - Berliner Kalendertag "YYYY-MM-DD", inklusiv
 * @param {boolean} [params.dryRun] - nichts schreiben
 * @returns {Promise<{fromDay: string, dryRun: boolean, raised: Array<Object>, messagesAdded: number}>}
 */
async function resyncLedger({ client, fromDay, dryRun = false }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(fromDay)))
    throw new Error(`--from ist kein Datum (YYYY-MM-DD): ${fromDay}`);
  const start = berlinMidnight(fromDay);
  if (
    isNaN(start.getTime()) ||
    MessageLedger.berlinDayHour(start).day !== fromDay
  )
    throw new Error(`--from ist kein Kalendertag: ${fromDay}`);

  return await client.$transaction(async (tx) => {
    const backfill = await MessageLedger.backfillState(tx);
    if (backfill?.state !== "complete")
      throw new Error(
        "Der Nachtrag des Zählerbuchs ist nicht abgeschlossen. Erst den Server starten und den Nachtrag durchlaufen lassen."
      );

    const { workspaceGroups, embedGroups } = await readExistingRows(
      tx,
      start.getTime()
    );
    const ledger = await tx.message_ledger.findMany({
      where: { day: { gte: fromDay } },
    });

    // Workspace-Chats: je Workspace, Tag und Stunde
    const workspaceLedger = new Map();
    // Widget-Chats: je Widget, Tag und Stunde über alle Workspaces
    const embedLedger = new Map();
    for (const row of ledger) {
      if (row.embed_id === MessageLedger.WORKSPACE_EMBED_ID) {
        workspaceLedger.set(
          `${row.workspace_id}|${row.day}|${row.hour}`,
          row.messages + row.copied
        );
        continue;
      }
      const key = `${row.embed_id}|${row.day}|${row.hour}`;
      const total = embedLedger.get(key) ?? {
        booked: 0,
        started: 0,
        positive: 0,
        negative: 0,
      };
      total.booked += row.messages + row.copied;
      total.started += row.conversations_started;
      total.positive += row.feedback_positive;
      total.negative += row.feedback_negative;
      embedLedger.set(key, total);
    }

    const additions = [];
    for (const [key, cell] of byBerlinHour(workspaceGroups, (group) =>
      Number(group.workspace_id)
    )) {
      const missing = cell.rows - (workspaceLedger.get(key) ?? 0);
      if (missing > 0)
        additions.push({
          workspaceId: cell.workspaceId,
          embedId: MessageLedger.WORKSPACE_EMBED_ID,
          day: cell.day,
          hour: cell.hour,
          messages: missing,
        });
    }
    for (const [key, cell] of byBerlinHour(embedGroups, (group) =>
      Number(group.embed_id)
    )) {
      const booked = embedLedger.get(key) ?? {
        booked: 0,
        started: 0,
        positive: 0,
        negative: 0,
      };
      const addition = {
        workspaceId: cell.workspaceId,
        embedId: cell.embedId,
        day: cell.day,
        hour: cell.hour,
        messages: Math.max(0, cell.rows - booked.booked),
        conversationsStarted: Math.max(0, cell.started - booked.started),
        feedbackPositive: Math.max(0, cell.positive - booked.positive),
        feedbackNegative: Math.max(0, cell.negative - booked.negative),
      };
      if (
        addition.messages ||
        addition.conversationsStarted ||
        addition.feedbackPositive ||
        addition.feedbackNegative
      )
        additions.push(addition);
    }

    // addCells addiert nur Werte >= 0: Auf diesem Weg sinkt kein Zähler.
    if (!dryRun) await MessageLedger.addCells(tx, additions);
    return {
      fromDay,
      dryRun,
      raised: additions,
      messagesAdded: additions.reduce((sum, cell) => sum + cell.messages, 0),
    };
  }, TRANSACTION_OPTIONS);
}

function formatResult(result) {
  const lines = [
    `Neuaufbau des Zählerbuchs ab ${result.fromDay}${result.dryRun ? " (Probelauf, nichts geschrieben)" : ""}`,
    "",
  ];
  for (const cell of result.raised) {
    const parts = [];
    if (cell.messages) parts.push(`messages +${cell.messages}`);
    if (cell.conversationsStarted)
      parts.push(`conversations_started +${cell.conversationsStarted}`);
    if (cell.feedbackPositive)
      parts.push(`feedback_positive +${cell.feedbackPositive}`);
    if (cell.feedbackNegative)
      parts.push(`feedback_negative +${cell.feedbackNegative}`);
    lines.push(
      `Workspace ${cell.workspaceId}, ${cell.embedId ? `Widget ${cell.embedId}` : "Workspace-Chats"}, ${cell.day} ${String(cell.hour).padStart(2, "0")} Uhr: ${parts.join(", ")}`
    );
  }
  if (result.raised.length === 0)
    lines.push("Nichts anzuheben: Alle vorhandenen Zeilen sind gezählt.");
  lines.push(
    "",
    `Ergebnis: ${result.raised.length} Stunde(n) angehoben, messages +${result.messagesAdded}. Kein Wert wurde gesenkt.`
  );
  return lines.join("\n");
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) throw new Error(`Unbekanntes Argument: ${arg}`);
    const [name, inline] = arg.slice(2).split(/=(.*)/s);
    if (["dry-run", "json", "help"].includes(name)) {
      options[name] = true;
      continue;
    }
    if (!["from", "db"].includes(name))
      throw new Error(`Unbekannte Option: --${name}`);
    const value = inline !== undefined ? inline : argv[++i];
    if (value === undefined || value === "")
      throw new Error(`Wert für --${name} fehlt.`);
    options[name] = value;
  }
  return options;
}

const USAGE = `Aufruf:
  node scripts/ledger-resync.js --from=<YYYY-MM-DD> [--db <datei.db>] [--dry-run] [--json]`;

/**
 * @param {string[]} argv - Argumente ohne node und Skriptpfad
 * @returns {Promise<number>} - Exit-Status
 */
async function main(
  argv,
  { stdout = process.stdout, stderr = process.stderr } = {}
) {
  let client = null;
  try {
    const options = parseArgs(argv);
    if (options.help) {
      stdout.write(`${USAGE}\n`);
      return 0;
    }
    if (!options.from) throw new Error("--from=<YYYY-MM-DD> angeben.");

    if (options.db) {
      const databasePath = path.resolve(options.db);
      if (!fs.existsSync(databasePath))
        throw new Error(`Datenbank nicht gefunden: ${databasePath}`);
      const { PrismaClient } = require("@prisma/client");
      client = new PrismaClient({
        datasources: { db: { url: `file:${databasePath}` } },
      });
    } else {
      client = require("../utils/prisma");
    }

    const result = await resyncLedger({
      client,
      fromDay: options.from,
      dryRun: Boolean(options["dry-run"]),
    });
    stdout.write(
      options.json
        ? `${JSON.stringify(result, null, 2)}\n`
        : `${formatResult(result)}\n`
    );
    return 0;
  } catch (error) {
    stderr.write(`ledger-resync: ${error.message}\n${USAGE}\n`);
    return 2;
  } finally {
    if (client) await client.$disconnect().catch(() => {});
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then((status) => {
    process.exitCode = status;
  });
}

module.exports = { resyncLedger, formatResult, main };
