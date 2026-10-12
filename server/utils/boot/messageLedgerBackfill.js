const { Prisma } = require("@prisma/client");
const prisma = require("../prisma");
const { MessageLedger } = require("../../models/messageLedger");

/**
 * Einmaliger Nachtrag des Zählerbuchs aus dem Bestand (KIE-532).
 *
 * Läuft beim Start, bevor der Server Anfragen annimmt (utils/boot/index.js).
 * Danach entspricht das Zählerbuch exakt der bisherigen Live-Zählung:
 * messages je Workspace, Widget, Berliner Tag und Stunde = Zahl der
 * vorhandenen Chat-Zeilen.
 *
 * Ablauf:
 * - Vor dem ersten Paket wird der höchste Zeilenschlüssel von workspace_chats
 *   und embed_chats festgehalten (Wasserstand). Nachgetragen werden nur Zeilen
 *   bis dahin; alles Spätere zählt der laufende Betrieb beim Anlegen. So steht
 *   jede Nachricht genau einmal im Zählerbuch.
 * - Verarbeitet wird in Paketen über den Zeilenschlüssel (id > ? ORDER BY id
 *   LIMIT n), gelesen werden nur schmale Spalten. Zähler und Fortschritt eines
 *   Pakets werden in derselben Transaktion geschrieben: Ein Abbruch setzt beim
 *   nächsten Start hinter dem letzten vollständigen Paket fort, ein zweiter
 *   Lauf ändert nichts.
 * - Die Markierung message_ledger_backfill (system_settings) wird in der
 *   Transaktion des letzten Pakets auf "complete" gesetzt. Erst dann liest das
 *   Kontingent das Zählerbuch.
 * - Bestandszeilen werden nur gelesen, nie geändert.
 *
 * Bereits vorhandene Kopien aus Thread-Verzweigungen sind nicht erkennbar und
 * zählen als messages - wie in der bisherigen Zählung. Für Widget-Zeilen gilt
 * der heutige Workspace des Widgets.
 *
 * Nicht nachgetragen (und in der Markierung gezählt) werden Zeilen, die auch
 * die bisherige Zählung keinem Workspace zurechnet: Zeilen ohne Workspace bzw.
 * Widget und Zeilen, deren createdAt keine Zahl ist.
 *
 * Schlägt der Nachtrag fehl, startet der Server trotzdem: Die Markierung
 * bleibt unvollständig, das Kontingent liest weiter die Live-Zählung, und ein
 * Ereignis message_ledger_backfill_failed wird geschrieben.
 */

const EVENT_BACKFILL_FAILED = "message_ledger_backfill_failed";
const DEFAULT_BATCH_SIZE = 50_000;
const MS_PER_HOUR = 60 * 60 * 1000;
// Ausdrücklich gesetzt. Ein Paket liest bis zu batchSize Zeilen und darf
// dafür deutlich länger brauchen als eine Chat-Transaktion.
const TRANSACTION_OPTIONS = { maxWait: 10_000, timeout: 120_000 };

/**
 * Stunde seit Epoche (UTC) zu einem createdAt in Millisekunden, abgerundet
 * auch für Werte vor 1970. Berlin weicht in ganzen Stunden von UTC ab, jede
 * dieser Stunden gehört also zu genau einem Berliner Tag und einer Berliner
 * Stunde - die Zuordnung übernimmt MessageLedger.berlinDayHour.
 * @param {string} column - fester Spaltenname, nie Eingabe von außen
 */
function hourBucketSql(column) {
  const ms = Prisma.raw(`CAST(${column} AS INTEGER)`);
  return Prisma.sql`((${ms} - (((${ms} % ${MS_PER_HOUR}) + ${MS_PER_HOUR}) % ${MS_PER_HOUR})) / ${MS_PER_HOUR})`;
}

/** createdAt ist als Zahl gespeichert (so schreibt und vergleicht es Prisma). */
function hasTimeSql(column) {
  return Prisma.raw(`(typeof(${column}) IN ('integer', 'real'))`);
}

/**
 * Bedingung "diese Zeile beginnt eine Konversation": Für
 * COALESCE(conversation_id, session_id) gibt es in diesem Widget keine frühere
 * Zeile. Erwartet eine Zeile c mit id, embed_id und k (dem Schlüssel).
 * Dieselbe Regel wendet EmbedChats.new beim Anlegen an.
 * Das vorangestellte + nimmt eine Spalte aus der Indexwahl: Gesucht wird über
 * conversation_id bzw. (embed_id, session_id), nie über alle Zeilen des Widgets.
 */
const STARTS_CONVERSATION_SQL = Prisma.sql`(
  NOT EXISTS (
    SELECT 1 FROM embed_chats p
    WHERE p.conversation_id = c.k AND +p.embed_id = c.embed_id AND p.id < c.id
  )
  AND NOT EXISTS (
    SELECT 1 FROM embed_chats p
    WHERE p.embed_id = c.embed_id AND p.session_id = c.k
      AND +p.conversation_id IS NULL AND p.id < c.id
  )
)`;

/**
 * Liest ein Paket workspace_chats, gruppiert nach Workspace und Stunde.
 */
async function readWorkspaceChats(tx, { afterId, maxId, limit }) {
  return await tx.$queryRaw`
    SELECT
      c.workspaceId AS workspace_id,
      0 AS embed_id,
      ${hourBucketSql("c.createdAt")} AS bucket,
      COUNT(*) AS n,
      MAX(c.id) AS last_id,
      0 AS started,
      0 AS positive,
      0 AS negative,
      (w.id IS NOT NULL) AS has_workspace,
      ${hasTimeSql("c.createdAt")} AS has_time
    FROM (
      SELECT id, workspaceId, createdAt FROM workspace_chats
      WHERE id > ${afterId} AND id <= ${maxId}
      ORDER BY id LIMIT ${limit}
    ) c
    LEFT JOIN workspaces w ON w.id = c.workspaceId
    GROUP BY 1, 3, 9, 10`;
}

/**
 * Liest ein Paket embed_chats, gruppiert nach heutigem Workspace des Widgets,
 * Widget und Stunde - mit begonnenen Konversationen und dem aktuellen Stand
 * der Bewertungen.
 */
async function readEmbedChats(tx, { afterId, maxId, limit }) {
  return await tx.$queryRaw`
    SELECT
      e.workspace_id AS workspace_id,
      c.embed_id AS embed_id,
      ${hourBucketSql("c.createdAt")} AS bucket,
      COUNT(*) AS n,
      MAX(c.id) AS last_id,
      SUM(CASE WHEN ${STARTS_CONVERSATION_SQL} THEN 1 ELSE 0 END) AS started,
      SUM(CASE WHEN c.feedbackScore = 1 THEN 1 ELSE 0 END) AS positive,
      SUM(CASE WHEN c.feedbackScore = 0 THEN 1 ELSE 0 END) AS negative,
      (w.id IS NOT NULL) AS has_workspace,
      ${hasTimeSql("c.createdAt")} AS has_time
    FROM (
      SELECT id, embed_id, createdAt, feedbackScore,
             COALESCE(conversation_id, session_id) AS k
      FROM embed_chats
      WHERE id > ${afterId} AND id <= ${maxId}
      ORDER BY id LIMIT ${limit}
    ) c
    LEFT JOIN embed_configs e ON e.id = c.embed_id
    LEFT JOIN workspaces w ON w.id = e.workspace_id
    GROUP BY 1, 2, 3, 9, 10`;
}

const READERS = {
  workspace_chats: readWorkspaceChats,
  embed_chats: readEmbedChats,
};

/**
 * Fasst die Gruppen eines Pakets zu Zeilen des Zählerbuchs zusammen. Zwei
 * UTC-Stunden können auf dieselbe Berliner Stunde fallen (Stunde 2 am Tag der
 * Rückstellung auf Winterzeit), deshalb wird hier nochmals summiert.
 * @returns {{cells: import("../../models/messageLedger").LedgerCell[], total: number, counted: number, skippedOrphaned: number, skippedWithoutTime: number, lastId: number|null}}
 */
function toCells(groups) {
  const cells = new Map();
  const summary = {
    total: 0,
    counted: 0,
    skippedOrphaned: 0,
    skippedWithoutTime: 0,
    lastId: null,
  };

  for (const group of groups) {
    const n = Number(group.n);
    summary.total += n;
    summary.lastId = Math.max(summary.lastId ?? 0, Number(group.last_id));
    if (Number(group.has_workspace) !== 1) {
      summary.skippedOrphaned += n;
      continue;
    }
    if (Number(group.has_time) !== 1) {
      summary.skippedWithoutTime += n;
      continue;
    }

    const workspaceId = Number(group.workspace_id);
    const embedId = Number(group.embed_id);
    const { day, hour } = MessageLedger.berlinDayHour(
      Number(group.bucket) * MS_PER_HOUR
    );
    const key = `${workspaceId}|${embedId}|${day}|${hour}`;
    const cell = cells.get(key) ?? {
      workspaceId,
      embedId,
      day,
      hour,
      messages: 0,
      conversationsStarted: 0,
      feedbackPositive: 0,
      feedbackNegative: 0,
    };
    cell.messages += n;
    cell.conversationsStarted += Number(group.started ?? 0);
    cell.feedbackPositive += Number(group.positive ?? 0);
    cell.feedbackNegative += Number(group.negative ?? 0);
    cells.set(key, cell);
    summary.counted += n;
  }

  return { cells: [...cells.values()], ...summary };
}

/**
 * Verarbeitet das nächste Paket: Zähler und Fortschritt in einer Transaktion.
 * Der Fortschritt wird in der Transaktion gelesen, zwei gleichzeitige Läufe
 * können ein Paket also nicht doppelt buchen.
 * @returns {Promise<{state: import("../../models/messageLedger").BackfillState, table: string|null, rows: number}>}
 */
async function processBatch(tx, { batchSize }) {
  const batchStartedAt = Date.now();
  const state = await MessageLedger.ensureWatermark(tx);
  if (state.state === "complete") return { state, table: null, rows: 0 };

  const table = MessageLedger.BACKFILL_TABLES.find(
    (name) => !state.tables[name].done
  );
  let rows = 0;
  if (table) {
    const progress = state.tables[table];
    const groups = await READERS[table](tx, {
      afterId: progress.lastId,
      maxId: progress.maxId,
      limit: batchSize,
    });
    const batch = toCells(groups);
    await MessageLedger.addCells(tx, batch.cells);

    rows = batch.total;
    progress.lastId = batch.lastId ?? progress.lastId;
    progress.rows += batch.counted;
    progress.skippedOrphaned += batch.skippedOrphaned;
    progress.skippedWithoutTime += batch.skippedWithoutTime;
    // Ein nicht volles Paket war das letzte dieser Tabelle.
    if (batch.total < batchSize) progress.done = true;
  }

  const now = new Date().toISOString();
  const complete = MessageLedger.BACKFILL_TABLES.every(
    (name) => state.tables[name].done
  );
  state.state = complete ? "complete" : "running";
  state.startedAt = state.startedAt ?? now;
  state.completedAt = complete ? now : null;
  state.error = null;
  state.durationMs = (state.durationMs ?? 0) + (Date.now() - batchStartedAt);
  await MessageLedger.writeBackfillState(tx, state);
  return { state, table: table ?? null, rows };
}

/** Markierung auf "failed" setzen und das Ereignis schreiben - beides ohne zu werfen. */
async function reportFailure(client, error) {
  const message = MessageLedger.errorSummary(error);
  let state = null;
  try {
    state = await client.$transaction(async (tx) => {
      const current = await MessageLedger.backfillState(tx);
      if (!current || current.state === "complete") return current;
      current.state = "failed";
      current.error = message;
      await MessageLedger.writeBackfillState(tx, current);
      return current;
    }, TRANSACTION_OPTIONS);
  } catch (markError) {
    console.error(markError.message);
  }

  try {
    await client.event_logs.create({
      data: {
        event: EVENT_BACKFILL_FAILED,
        metadata: JSON.stringify({
          error: message,
          tables: state?.tables ?? null,
        }),
        occurredAt: new Date(),
      },
    });
  } catch (eventError) {
    console.error(eventError.message);
  }
  return state;
}

/**
 * Führt den Nachtrag aus oder setzt ihn fort. Wirft nie.
 *
 * @param {Object} [options]
 * @param {import("@prisma/client").PrismaClient} [options.client] - Standard: die Datenbank des Servers
 * @param {number} [options.batchSize] - Zeilen je Paket
 * @param {(batch: {state: Object, table: string|null, rows: number}) => Promise<void>|void} [options.afterBatch] - nach jedem abgeschlossenen Paket; ein Fehler darin bricht den Lauf ab
 * @param {(message: string) => void} [options.log]
 * @returns {Promise<{ok: boolean, alreadyComplete: boolean, state: import("../../models/messageLedger").BackfillState|null, rows: number, durationMs: number, error: string|null}>}
 */
async function runMessageLedgerBackfill({
  client = prisma,
  batchSize = DEFAULT_BATCH_SIZE,
  afterBatch = null,
  log = console.log,
} = {}) {
  const runStartedAt = Date.now();
  let rows = 0;
  try {
    if (!Number.isInteger(batchSize) || batchSize <= 0)
      throw new Error(`Invalid batchSize: ${batchSize}`);

    let state = await MessageLedger.exclusive(() =>
      client.$transaction(
        (tx) => MessageLedger.ensureWatermark(tx),
        TRANSACTION_OPTIONS
      )
    );
    if (state.state === "complete")
      return {
        ok: true,
        alreadyComplete: true,
        state,
        rows: 0,
        durationMs: Date.now() - runStartedAt,
        error: null,
      };

    log(
      `\x1b[36m[MessageLedger]\x1b[0m Nachtrag des Zählerbuchs: workspace_chats bis id ${state.tables.workspace_chats.maxId}, embed_chats bis id ${state.tables.embed_chats.maxId}`
    );
    while (state.state !== "complete") {
      const batch = await MessageLedger.exclusive(() =>
        client.$transaction(
          (tx) => processBatch(tx, { batchSize }),
          TRANSACTION_OPTIONS
        )
      );
      state = batch.state;
      rows += batch.rows;
      if (afterBatch) await afterBatch(batch);
    }

    const durationMs = Date.now() - runStartedAt;
    log(
      `\x1b[36m[MessageLedger]\x1b[0m Nachtrag abgeschlossen: ${state.tables.workspace_chats.rows} Workspace-Chats und ${state.tables.embed_chats.rows} Widget-Chats in ${(durationMs / 1000).toFixed(1)} s`
    );
    return {
      ok: true,
      alreadyComplete: false,
      state,
      rows,
      durationMs,
      error: null,
    };
  } catch (error) {
    console.error(
      `\x1b[31m[MessageLedger]\x1b[0m Nachtrag fehlgeschlagen, das Kontingent liest weiter die Live-Zählung: ${error.message}`
    );
    const state = await reportFailure(client, error);
    return {
      ok: false,
      alreadyComplete: false,
      state,
      rows,
      durationMs: Date.now() - runStartedAt,
      error: MessageLedger.errorSummary(error),
    };
  }
}

module.exports = {
  EVENT_BACKFILL_FAILED,
  DEFAULT_BATCH_SIZE,
  STARTS_CONVERSATION_SQL,
  hourBucketSql,
  hasTimeSql,
  runMessageLedgerBackfill,
};
