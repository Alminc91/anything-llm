const prisma = require("../utils/prisma");
const { EventLogs } = require("./eventLogs");
const {
  BILLING_TIME_ZONE,
  berlinDayOf,
  berlinMidnight,
  dayToMarker,
} = require("../utils/helpers/billingWindow");
const {
  timelineLayout,
  previousLayout,
} = require("../utils/helpers/ledgerTimeline");

/**
 * Zählerbuch (KIE-532) - die eine Quelle für Kontingent und Statistik.
 *
 * Eine Zeile je Workspace, Widget, Berliner Kalendertag und Berliner Stunde
 * (Tabelle message_ledger). Gezählt wird beim Anlegen der Chat-Zeile, in
 * derselben interaktiven Transaktion: Chat-Zeile und Zähler entstehen
 * gemeinsam oder gar nicht. Es gibt genau einen Weg dorthin:
 *
 *   MessageLedger.transaction(kontext, async (tx) => {
 *     const chat = await tx.<chat-tabelle>.create(...);
 *     await MessageLedger.record(tx, { ..., at: chat.createdAt });
 *   });
 *
 * Regeln:
 * - messages und copied werden nie verringert. Hier gibt es bewusst keine
 *   Funktion, die einen Zähler senkt oder eine Zeile löscht; kein Löschpfad
 *   fasst das Zählerbuch an.
 * - embed_id 0 steht für Workspace-Chats (GUI, API, Agent). Für
 *   Widget-Nachrichten gilt die workspace_id des Widgets zum Zeitpunkt des
 *   Schreibens.
 * - Tag und Stunde werden ausdrücklich in Europe/Berlin bestimmt, nie über die
 *   Zeitzone des Prozesses.
 *
 * Die Markierung des einmaligen Nachtrags (system_settings, Label
 * message_ledger_backfill) wird ebenfalls hier geführt, weil Schreib- und
 * Lesepfad sie brauchen. Den Nachtrag selbst führt
 * utils/boot/messageLedgerBackfill.js aus.
 *
 * Die Auswertung „Konversationen" (KIE-536) liest Kennzahlen und Zeitreihe
 * eines Widgets hier (timelineForEmbed, firstDayForEmbed). Sie liest nur.
 * Dasselbe gilt für den Vergleich mit dem Vorzeitraum (KIE-537,
 * previousTimelineForEmbed).
 *
 * Die Karte „Wann schreiben Ihre Besucher?" (KIE-539) liest die Nachrichten
 * eines Widgets nach Wochentag und Stunde zusammen mit Kennzahlen und
 * Zeitreihe in einer Anweisung (summaryForEmbed). Auch sie liest nur.
 */

/**
 * @typedef {Object} LedgerCell
 * @property {number} workspaceId
 * @property {number} embedId - 0 = Workspace-Chat
 * @property {string} day - Berliner Kalendertag "YYYY-MM-DD"
 * @property {number} hour - Berliner Stunde 0-23
 * @property {number} [messages]
 * @property {number} [copied]
 * @property {number} [conversationsStarted]
 * @property {number} [feedbackPositive]
 * @property {number} [feedbackNegative]
 */

/**
 * @typedef {Object} EmbedCounts
 * @property {number} messages
 * @property {number} conversations - begonnene Konversationen
 * @property {number} feedbackPositive
 * @property {number} feedbackNegative
 */

/**
 * @typedef {Object} BackfillTableState
 * @property {number} maxId - Wasserstand: höchster Zeilenschlüssel beim Festhalten
 * @property {number} lastId - bis hierhin nachgetragen
 * @property {boolean} done
 * @property {number} rows - nachgetragene Zeilen
 * @property {number} skippedOrphaned - Zeilen ohne Workspace bzw. Widget
 * @property {number} skippedWithoutTime - Zeilen, deren createdAt keine Zahl ist
 */

/**
 * @typedef {Object} BackfillState
 * @property {number} version
 * @property {"pending"|"running"|"complete"|"failed"} state
 * @property {{workspace_chats: BackfillTableState, embed_chats: BackfillTableState}} tables
 * @property {string} capturedAt
 * @property {string|null} startedAt
 * @property {string|null} completedAt
 * @property {number} durationMs
 * @property {string|null} error
 */

const BACKFILL_LABEL = "message_ledger_backfill";
const BACKFILL_TABLES = ["workspace_chats", "embed_chats"];
const EVENT_WRITE_FAILED = "message_ledger_write_failed";
const EVENT_MISMATCH = "message_ledger_mismatch";
const EVENT_MARKER_RECOVERED = "message_ledger_marker_recovered";
const MS_PER_HOUR = 60 * 60 * 1000;
// Ließ sich message_ledger_write_failed nicht schreiben: nächster Versuch
const WRITE_FAILED_RETRY_MS = 60 * 1000;
// Höchstens 999 Platzhalter je Anweisung (ältere SQLite-Grenze), 9 je Zeile.
const CELLS_PER_STATEMENT = 100;

const berlinHourFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: BILLING_TIME_ZONE,
  hourCycle: "h23",
  hour: "numeric",
});

/**
 * Berliner Kalendertag und Berliner Stunde eines Zeitpunkts.
 * Am Tag der Rückstellung auf Winterzeit gibt es die Stunde 2 zweimal; beide
 * Durchläufe landen in derselben Zeile. Am Tag der Umstellung auf Sommerzeit
 * gibt es keine Stunde 2.
 * @param {Date|string|number} instant
 * @returns {{day: string, hour: number}}
 */
function berlinDayHour(instant) {
  const date = instant instanceof Date ? instant : new Date(instant);
  if (isNaN(date.getTime())) throw new Error("berlinDayHour: invalid date");
  const hourPart = berlinHourFormatter
    .formatToParts(date)
    .find((part) => part.type === "hour");
  return { day: berlinDayOf(date), hour: Number(hourPart.value) };
}

function isCount(value) {
  return Number.isInteger(value) && value >= 0;
}

// ---------------------------------------------------------------------------
// Eine Transaktion zur Zeit
// ---------------------------------------------------------------------------

// Zählerbuch-Transaktionen eines Prozesses laufen nacheinander. SQLite kennt
// nur einen Schreiber; ohne die Reihe warten parallele Transaktionen in der
// Engine mit Busy-Timeout aufeinander, statt hier ohne Zeitgrenze anzustehen.
let queue = Promise.resolve();

function exclusive(task) {
  const run = queue.then(task, task);
  queue = run.then(
    () => {},
    () => {}
  );
  return run;
}

// ---------------------------------------------------------------------------
// Markierung des Nachtrags
// ---------------------------------------------------------------------------

// Nur "abgeschlossen" und "Wasserstand vorhanden" werden gemerkt: Beides
// ändert sich danach nicht mehr. Alles andere wird jedes Mal gelesen.
let backfillComplete = false;
let watermarkCaptured = false;
// Workspace → Stunde (Epoche), in der zuletzt eine Abweichung gemeldet wurde
const reportedMismatches = new Map();
// Quelle|Workspace|Widget → Meldestand zu message_ledger_write_failed: die
// Stunde (Epoche) des letzten geschriebenen Ereignisses und die Fehler, die
// noch in keinem Ereignis stehen (Anzahl, der letzte davon, sein Zeitpunkt)
const writeFailures = new Map();
// Geplantes Nachreichen (Timer und Fälligkeit), siehe scheduleWriteFailureFlush
let writeFailureFlush = null;
let writeFailureFlushDueAt = null;

function emptyTableState(maxId) {
  return {
    maxId,
    lastId: 0,
    done: false,
    rows: 0,
    skippedOrphaned: 0,
    skippedWithoutTime: 0,
  };
}

/**
 * @param {string|null|undefined} value - Wert aus system_settings
 * @returns {BackfillState|null}
 */
function parseBackfillState(value) {
  if (!value) return null;
  try {
    const state = JSON.parse(value);
    if (!state || typeof state !== "object" || !state.tables) return null;
    for (const table of BACKFILL_TABLES)
      if (!Number.isInteger(state.tables[table]?.maxId)) return null;
    return state;
  } catch {
    return null;
  }
}

/**
 * Schreibt das Ereignis message_ledger_write_failed für die noch nicht
 * gemeldeten Fehler eines Schlüssels, sofern in dieser Stunde für ihn noch
 * keines im Protokoll steht. Gemeldet ist erst, was geschrieben wurde:
 * EventLogs.logEvent wirft bei einem Datenbankfehler nicht, sondern liefert
 * eventLog null - etwa bei derselben Schreibsperre, an der schon die
 * Transaktion gescheitert ist. Die Fehler bleiben dann offen.
 *
 * @param {Object} entry - Eintrag aus writeFailures
 * @param {boolean} deferred - nachgereicht, also nicht vom Fehler selbst ausgelöst
 * @returns {Promise<boolean>} - true, wenn ein Ereignis geschrieben wurde
 */
async function reportWriteFailures(entry, deferred) {
  const hourBucket = Math.floor(Date.now() / MS_PER_HOUR);
  // Je Schlüssel ein Schreibversuch zur Zeit: Was währenddessen scheitert,
  // zählt weiter und steht im nächsten Ereignis.
  if (entry.writing || !entry.unreported || entry.reportedHour === hourBucket)
    return false;

  const count = entry.unreported;
  entry.writing = true;
  try {
    const logged = await EventLogs.logEvent(EVENT_WRITE_FAILED, {
      source: entry.source,
      workspaceId: entry.workspaceId,
      embedId: entry.embedId,
      error: entry.lastError,
      ...(count > 1 ? { suppressed: count - 1 } : {}),
      ...(deferred
        ? {
            deferred: true,
            lastFailureAt: new Date(entry.lastFailureAt).toISOString(),
          }
        : {}),
    });
    if (!logged?.eventLog) return false;
    entry.reportedHour = hourBucket;
    entry.unreported -= count;
    return true;
  } finally {
    entry.writing = false;
  }
}

function cancelWriteFailureFlush() {
  clearTimeout(writeFailureFlush);
  writeFailureFlush = null;
  writeFailureFlushDueAt = null;
}

/**
 * Plant das Nachreichen offener Fehler, damit sie auch ohne einen weiteren
 * Fehler im Protokoll ankommen: Ließ sich das Ereignis nicht schreiben, folgt
 * der nächste Versuch nach WRITE_FAILED_RETRY_MS. Steht für die Stunde schon
 * eines im Protokoll, wird der Rest mit dem Stundenwechsel nachgereicht. Der
 * Timer hält den Prozess nicht am Leben.
 */
function scheduleWriteFailureFlush() {
  const now = Date.now();
  const hourBucket = Math.floor(now / MS_PER_HOUR);
  let dueAt = null;
  for (const entry of writeFailures.values()) {
    if (!entry.unreported) continue;
    const entryDueAt =
      entry.reportedHour === hourBucket
        ? (hourBucket + 1) * MS_PER_HOUR
        : now + WRITE_FAILED_RETRY_MS;
    dueAt = dueAt === null ? entryDueAt : Math.min(dueAt, entryDueAt);
  }
  if (dueAt === null) return cancelWriteFailureFlush();
  if (writeFailureFlush && writeFailureFlushDueAt <= dueAt) return;

  cancelWriteFailureFlush();
  writeFailureFlushDueAt = dueAt;
  writeFailureFlush = setTimeout(
    () => {
      writeFailureFlush = null;
      writeFailureFlushDueAt = null;
      MessageLedger._flushWriteFailures();
    },
    Math.max(dueAt - now, 0)
  );
  writeFailureFlush.unref?.();
}

const MessageLedger = {
  WORKSPACE_EMBED_ID: 0,
  BACKFILL_LABEL,
  BACKFILL_TABLES,
  EVENT_WRITE_FAILED,
  EVENT_MISMATCH,
  EVENT_MARKER_RECOVERED,

  // Ausdrücklich gesetzt: höchstens 5 s auf den Beginn warten (Busy-Timeout
  // von SQLite), danach höchstens 10 s für die wenigen Anweisungen.
  TRANSACTION_OPTIONS: { maxWait: 5_000, timeout: 10_000 },

  berlinDayHour,
  exclusive,

  /**
   * Führt work in einer interaktiven Transaktion aus, in der Chat-Zeile und
   * Zähler gemeinsam entstehen. Schlägt sie fehl, entsteht nichts von beidem,
   * ein Ereignis message_ledger_write_failed wird geschrieben (höchstens
   * einmal je Quelle, Workspace bzw. Widget und Stunde; lässt es sich nicht
   * schreiben, wird es nachgereicht) und der Fehler weitergereicht.
   *
   * Vor der ersten Transaktion wird der Wasserstand des Nachtrags
   * festgehalten, falls das beim Start nicht gelungen ist: Sonst würde ein
   * späterer Nachtrag Zeilen erfassen, die hier schon gezählt wurden.
   *
   * Transaktionen eines Prozesses laufen nacheinander: work darf selbst keine
   * weitere MessageLedger.transaction öffnen (sie würde auf sich selbst warten).
   *
   * @template T
   * @param {{source: string, workspaceId?: number|null, embedId?: number|null}} context - für das Fehler-Ereignis, keine Inhalte
   * @param {(tx: import("@prisma/client").Prisma.TransactionClient) => Promise<T>} work - nur über tx arbeiten
   * @param {{timeout?: number}} [options]
   * @returns {Promise<T>}
   */
  transaction: async function (context, work, options = {}) {
    try {
      return await exclusive(async () => {
        let captured = false;
        const result = await prisma.$transaction(
          async (tx) => {
            if (!watermarkCaptured) {
              await MessageLedger.ensureWatermark(tx);
              captured = true;
            }
            return await work(tx);
          },
          { ...MessageLedger.TRANSACTION_OPTIONS, ...options }
        );
        if (captured) watermarkCaptured = true;
        return result;
      });
    } catch (error) {
      // Das Protokollieren darf den eigentlichen Fehler nicht verdecken.
      try {
        await MessageLedger._logWriteFailed(context, error);
      } catch (logError) {
        console.error(logError.message);
      }
      throw error;
    }
  },

  /**
   * Schreibt das Ereignis message_ledger_write_failed, höchstens einmal je
   * Quelle, Workspace bzw. Widget und Stunde: Ein anhaltender Fehler (oder
   * jemand, der ihn von außen auslösen kann) soll das Ereignisprotokoll nicht
   * füllen. Was dazwischen nicht gemeldet wurde, nennt das nächste Ereignis
   * als suppressed; in der Konsole steht jeder Fehler. Über alle Ereignisse
   * eines Schlüssels ergibt 1 + suppressed die Zahl der Fehler.
   *
   * Als gemeldet gilt ein Fehler erst, wenn sein Ereignis im Protokoll steht.
   * Lässt es sich nicht schreiben, bleibt der Schlüssel offen: Der nächste
   * Fehler versucht es erneut, sonst _flushWriteFailures nach
   * WRITE_FAILED_RETRY_MS. Was in einer Stunde nach dem Ereignis noch
   * scheitert, wird spätestens mit dem Stundenwechsel nachgereicht. Offene
   * Fehler stehen nur im Speicher des Prozesses; ein Neustart verliert sie.
   */
  _logWriteFailed: async function (context = {}, error) {
    console.error(
      `\x1b[31m[MessageLedger]\x1b[0m Chat-Zeile und Zähler nicht geschrieben (${context?.source ?? "unbekannt"}): ${error?.message}`
    );
    const source = context?.source ?? null;
    const workspaceId = context?.workspaceId ?? null;
    const embedId = context?.embedId ?? null;

    const key = `${source}|${workspaceId}|${embedId}`;
    let entry = writeFailures.get(key);
    if (!entry) {
      entry = {
        source,
        workspaceId,
        embedId,
        reportedHour: null,
        unreported: 0,
        lastError: null,
        lastFailureAt: null,
        writing: false,
      };
      writeFailures.set(key, entry);
    }
    entry.unreported += 1;
    entry.lastError = MessageLedger.errorSummary(error);
    entry.lastFailureAt = Date.now();

    try {
      await reportWriteFailures(entry, false);
    } finally {
      scheduleWriteFailureFlush();
    }
  },

  /**
   * Reicht nach, was zu message_ledger_write_failed noch in keinem Ereignis
   * steht (deferred: true, lastFailureAt nennt den letzten Fehler), und plant
   * den nächsten Lauf, solange etwas offen bleibt. Wirft nie.
   * @returns {Promise<void>}
   */
  _flushWriteFailures: async function () {
    for (const entry of [...writeFailures.values()]) {
      try {
        await reportWriteFailures(entry, true);
      } catch (error) {
        console.error(error.message);
      }
    }
    scheduleWriteFailureFlush();
  },

  /**
   * Kurzfassung eines Fehlers für Ereignisse: Art, Prisma-Code und die letzte
   * Zeile der Meldung (die Ursache). Die vollständige Meldung von Prisma kann
   * die Argumente des Aufrufs enthalten, also Inhalte einer Nachricht - die
   * gehören nicht ins Ereignisprotokoll.
   * @param {Error|*} error
   * @returns {string}
   */
  errorSummary: function (error) {
    const lines = String(error?.message ?? error)
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const cause = lines[lines.length - 1] ?? "";
    const kind = [error?.name, error?.code].filter(Boolean).join(" ");
    return `${kind ? `${kind}: ` : ""}${cause}`.slice(0, 300);
  },

  /**
   * Die eine Zählfunktion: bucht angelegte Chat-Zeilen auf die Zeile des
   * Berliner Tages und der Berliner Stunde von at. Nur innerhalb der
   * Transaktion aufrufen, in der die Chat-Zeile entsteht.
   *
   * @param {import("@prisma/client").Prisma.TransactionClient} tx
   * @param {Object} params
   * @param {number} params.workspaceId
   * @param {number} [params.embedId] - 0 = Workspace-Chat
   * @param {Date} params.at - createdAt der Chat-Zeile
   * @param {number} [params.messages] - kontingentwirksam
   * @param {number} [params.copied] - Kopien aus der Thread-Verzweigung, nicht kontingentwirksam
   * @param {boolean} [params.conversationStarted]
   * @returns {Promise<void>}
   */
  record: async function (
    tx,
    {
      workspaceId,
      embedId = MessageLedger.WORKSPACE_EMBED_ID,
      at,
      messages = 0,
      copied = 0,
      conversationStarted = false,
    }
  ) {
    const { day, hour } = berlinDayHour(at);
    await MessageLedger.addCells(tx, [
      {
        workspaceId,
        embedId,
        day,
        hour,
        messages,
        copied,
        conversationsStarted: conversationStarted ? 1 : 0,
      },
    ]);
  },

  /**
   * Addiert Zählerstände auf ihre Zeilen (legt fehlende Zeilen an). Grundlage
   * von record und des Nachtrags. Nimmt nur Werte >= 0 an: Auf diesem Weg
   * kann kein Zähler sinken.
   *
   * @param {import("@prisma/client").Prisma.TransactionClient} tx
   * @param {LedgerCell[]} cells
   * @returns {Promise<void>}
   */
  addCells: async function (tx, cells = []) {
    const { Prisma } = require("@prisma/client");
    const rows = cells.map((cell) => {
      const row = {
        workspaceId: cell.workspaceId,
        embedId: cell.embedId ?? MessageLedger.WORKSPACE_EMBED_ID,
        day: cell.day,
        hour: cell.hour,
        messages: cell.messages ?? 0,
        copied: cell.copied ?? 0,
        conversationsStarted: cell.conversationsStarted ?? 0,
        feedbackPositive: cell.feedbackPositive ?? 0,
        feedbackNegative: cell.feedbackNegative ?? 0,
      };
      if (!Number.isInteger(row.workspaceId) || row.workspaceId <= 0)
        throw new Error(
          `MessageLedger: invalid workspaceId ${row.workspaceId}`
        );
      if (!isCount(row.embedId))
        throw new Error(`MessageLedger: invalid embedId ${row.embedId}`);
      if (typeof row.day !== "string" || !row.day)
        throw new Error(`MessageLedger: invalid day ${row.day}`);
      if (!isCount(row.hour) || row.hour > 23)
        throw new Error(`MessageLedger: invalid hour ${row.hour}`);
      for (const key of [
        "messages",
        "copied",
        "conversationsStarted",
        "feedbackPositive",
        "feedbackNegative",
      ])
        if (!isCount(row[key]))
          throw new Error(`MessageLedger: invalid ${key} ${row[key]}`);
      return row;
    });

    for (let i = 0; i < rows.length; i += CELLS_PER_STATEMENT) {
      const values = rows
        .slice(i, i + CELLS_PER_STATEMENT)
        .map(
          (row) =>
            Prisma.sql`(${row.workspaceId}, ${row.embedId}, ${row.day}, ${row.hour}, ${row.messages}, ${row.copied}, ${row.conversationsStarted}, ${row.feedbackPositive}, ${row.feedbackNegative})`
        );
      await tx.$executeRaw`
        INSERT INTO message_ledger
          (workspace_id, embed_id, day, hour, messages, copied, conversations_started, feedback_positive, feedback_negative)
        VALUES ${Prisma.join(values)}
        ON CONFLICT (workspace_id, embed_id, day, hour) DO UPDATE SET
          messages = messages + excluded.messages,
          copied = copied + excluded.copied,
          conversations_started = conversations_started + excluded.conversations_started,
          feedback_positive = feedback_positive + excluded.feedback_positive,
          feedback_negative = feedback_negative + excluded.feedback_negative`;
    }
  },

  /**
   * Bucht den Übergang einer Bewertung (👍/👎/keine) auf die Stunde, in der
   * die Nachricht entstand. feedback_positive und feedback_negative geben den
   * aktuellen Stand wieder und fallen nie unter 0.
   *
   * Gebucht wird auf die Zeile, in der die Nachricht gezählt wurde. Wurde das
   * Widget seitdem umgehängt, ist das die Zeile des damaligen Workspaces;
   * workspaceId (der heutige Workspace des Widgets) gilt nur, wenn es für
   * Widget, Tag und Stunde noch keine Zeile gibt.
   *
   * Gibt es für Widget, Tag und Stunde Zeilen unter mehreren Workspaces (in
   * dieser Stunde umgehängt, oder ledger-resync hat Fehlendes dem heutigen
   * Workspace gutgeschrieben), nennt das Zählerbuch die Zeile der einzelnen
   * Nachricht nicht. Eine Bewertung wird dann dort abgezogen, wo sie steht:
   * auf einer Zeile, deren Stand für diesen Zähler über 0 liegt. Das neue
   * Vorzeichen eines Wechsels (👍 → 👎) geht auf dieselbe Zeile. So bleibt
   * nach dem Entfernen kein alter Stand stehen.
   *
   * @param {import("@prisma/client").Prisma.TransactionClient} tx
   * @param {Object} params
   * @param {number} params.workspaceId - heutiger Workspace des Widgets
   * @param {number} params.embedId
   * @param {Date} params.at - createdAt der bewerteten Chat-Zeile
   * @param {boolean|null} params.from - bisherige Bewertung
   * @param {boolean|null} params.to - neue Bewertung
   * @returns {Promise<void>}
   */
  adjustFeedback: async function (tx, { workspaceId, embedId, at, from, to }) {
    const positive = (to === true ? 1 : 0) - (from === true ? 1 : 0);
    const negative = (to === false ? 1 : 0) - (from === false ? 1 : 0);
    if (positive === 0 && negative === 0) return;
    if (!Number.isInteger(embedId) || embedId <= 0)
      throw new Error(`MessageLedger: invalid embedId ${embedId}`);

    const { day, hour } = berlinDayHour(at);
    const counted = await tx.message_ledger.findMany({
      where: { embed_id: embedId, day, hour },
      select: {
        workspace_id: true,
        messages: true,
        feedback_positive: true,
        feedback_negative: true,
      },
    });
    // Reihenfolge der Wahl: der heutige Workspace, sonst die meisten Nachrichten
    const candidates = counted.sort(
      (a, b) =>
        (b.workspace_id === workspaceId) - (a.workspace_id === workspaceId) ||
        b.messages - a.messages
    );
    // Was abgezogen wird, muss auf der Zeile stehen.
    const removed =
      positive < 0
        ? "feedback_positive"
        : negative < 0
          ? "feedback_negative"
          : null;
    const target =
      (removed && candidates.find((cell) => cell[removed] > 0)) ??
      candidates[0];
    // Ohne Zeile gibt es nichts abzuziehen.
    if (!target && positive <= 0 && negative <= 0) return;
    const targetWorkspaceId = target?.workspace_id ?? workspaceId;
    if (!Number.isInteger(targetWorkspaceId) || targetWorkspaceId <= 0)
      throw new Error(
        `MessageLedger: invalid workspaceId ${targetWorkspaceId}`
      );

    await tx.$executeRaw`
      INSERT INTO message_ledger
        (workspace_id, embed_id, day, hour, feedback_positive, feedback_negative)
      VALUES
        (${targetWorkspaceId}, ${embedId}, ${day}, ${hour}, MAX(0, ${positive}), MAX(0, ${negative}))
      ON CONFLICT (workspace_id, embed_id, day, hour) DO UPDATE SET
        feedback_positive = MAX(0, feedback_positive + ${positive}),
        feedback_negative = MAX(0, feedback_negative + ${negative})`;
  },

  /**
   * Summen eines Workspaces über Berliner Kalendertage [fromDay,
   * toDayExclusive). Wirft bei Datenbankfehlern.
   *
   * @param {number} workspaceId
   * @param {string} fromDay - "YYYY-MM-DD", inklusiv
   * @param {string} toDayExclusive - "YYYY-MM-DD", exklusiv
   * @param {import("@prisma/client").PrismaClient} [client]
   * @returns {Promise<{messages: number, copied: number, workspaceMessages: number, embedMessages: number}>}
   */
  sumForWorkspace: async function (
    workspaceId,
    fromDay,
    toDayExclusive,
    client = prisma
  ) {
    const groups = await client.message_ledger.groupBy({
      by: ["embed_id"],
      where: {
        workspace_id: Number(workspaceId),
        day: { gte: String(fromDay), lt: String(toDayExclusive) },
      },
      _sum: { messages: true, copied: true },
    });

    const sums = {
      messages: 0,
      copied: 0,
      workspaceMessages: 0,
      embedMessages: 0,
    };
    for (const group of groups) {
      const messages = group._sum.messages ?? 0;
      sums.messages += messages;
      sums.copied += group._sum.copied ?? 0;
      if (group.embed_id === MessageLedger.WORKSPACE_EMBED_ID)
        sums.workspaceMessages += messages;
      else sums.embedMessages += messages;
    }
    return sums;
  },

  /**
   * Kontingentwirksame Nachrichten eines Workspaces über Berliner Kalendertage
   * [fromDay, toDayExclusive). Liefert wie die übrigen Zähler des Kontingents
   * bei einem Datenbankfehler 0.
   *
   * @param {number} workspaceId
   * @param {string} fromDay - "YYYY-MM-DD", inklusiv
   * @param {string} toDayExclusive - "YYYY-MM-DD", exklusiv
   * @param {{throwOnError?: boolean}} [options] - KIE-534: true reicht einen
   * Datenbankfehler weiter, statt ihn als 0 zu zählen (Limitprüfung der Agent-Sitzung).
   * @returns {Promise<number>}
   */
  sumMessages: async function (
    workspaceId,
    fromDay,
    toDayExclusive,
    { throwOnError = false } = {}
  ) {
    try {
      const sums = await MessageLedger.sumForWorkspace(
        workspaceId,
        fromDay,
        toDayExclusive
      );
      return sums.messages;
    } catch (error) {
      console.error(error.message);
      if (throwOnError) throw error;
      return 0;
    }
  },

  /**
   * Kennzahlen und Zeitreihe eines Widgets (KIE-536) über die Berliner
   * Kalendertage [fromDay, toDay], beide einschließlich. Die Körnung der
   * Abschnitte bestimmt timelineLayout (utils/helpers/ledgerTimeline.js):
   * ein einzelner Tag in Stunden, sonst Tage, Kalenderwochen oder Monate.
   *
   * Summen und Abschnitte entstehen aus derselben Abfrage: Jede gelesene
   * Zeile geht in genau einen Abschnitt und in die Summen. Die Summe der
   * Abschnitte ist damit immer die Kennzahl. Bewertungen gibt es nur als
   * Summe, nicht je Abschnitt.
   *
   * Gezählt werden alle Zeilen mit der embed_id, unter welchem Workspace sie
   * auch stehen: Nach dem Umhängen eines Widgets bleiben seine früheren
   * Zeilen beim damaligen Workspace, gehören aber weiter zur Auswertung des
   * Widgets - wie seine Konversationen in embed_chats. embed_id 0
   * (Workspace-Chats) ist hier nie gemeint. Wirft bei Datenbankfehlern.
   *
   * @param {number} embedId
   * @param {string} fromDay - "YYYY-MM-DD", einschließlich
   * @param {string} toDay - "YYYY-MM-DD", einschließlich
   * @param {import("@prisma/client").PrismaClient} [client]
   * @param {{groups?: Array<Object>}} [options] - KIE-539: groups sind die
   * schon gelesenen Gruppen dieses Widgets und Zeitraums in der Form von
   * groupBy (summaryForEmbed liest sie mit dem Raster in einer Anweisung);
   * dann wird hier nicht noch einmal gelesen.
   * @returns {Promise<{granularity: "hour"|"day"|"week"|"month", totals: EmbedCounts, buckets: Array<import("../utils/helpers/ledgerTimeline").TimelineBucket & {messages: number, conversations: number}>}>}
   */
  timelineForEmbed: async function (
    embedId,
    fromDay,
    toDay,
    client = prisma,
    { groups: groupsRead = null } = {}
  ) {
    const id = Number(embedId);
    if (!Number.isInteger(id) || id <= 0)
      throw new Error(`MessageLedger: invalid embedId ${embedId}`);

    const layout = timelineLayout(fromDay, toDay);
    const groups =
      groupsRead ??
      (await client.message_ledger.groupBy({
        by: [layout.granularity === "hour" ? "hour" : "day"],
        where: { embed_id: id, day: { gte: fromDay, lte: toDay } },
        _sum: {
          messages: true,
          conversations_started: true,
          feedback_positive: true,
          feedback_negative: true,
        },
      }));

    const totals = {
      messages: 0,
      conversations: 0,
      feedbackPositive: 0,
      feedbackNegative: 0,
    };
    const buckets = layout.buckets.map((bucket) => ({
      ...bucket,
      messages: 0,
      conversations: 0,
    }));
    for (const group of groups) {
      const bucket = buckets[layout.indexOf(group)];
      if (!bucket)
        throw new Error(
          `MessageLedger: no bucket for ${group.day ?? group.hour}`
        );
      const messages = group._sum.messages ?? 0;
      const conversations = group._sum.conversations_started ?? 0;
      bucket.messages += messages;
      bucket.conversations += conversations;
      totals.messages += messages;
      totals.conversations += conversations;
      totals.feedbackPositive += group._sum.feedback_positive ?? 0;
      totals.feedbackNegative += group._sum.feedback_negative ?? 0;
    }

    return { granularity: layout.granularity, totals, buckets };
  },

  /**
   * Kennzahlen und Linie des Vorzeitraums eines Widgets (KIE-537) - der
   * Vergleich zu timelineForEmbed für denselben Zeitraum [fromDay, toDay].
   * Welche Tage das sind, bestimmt previousLayout
   * (utils/helpers/ledgerTimeline.js): totals zählt gleich viele Kalendertage
   * unmittelbar vor fromDay, buckets hat je Abschnitt des Zeitraums den
   * Abschnitt an derselben Stelle davor - bei Kalenderwochen und Monaten
   * ganze Wochen bzw. Monate, also nicht dieselben Tage wie totals.
   *
   * Eine Abfrage über beide Bereiche; sie umfasst nie mehr Abschnitte als der
   * Zeitraum selbst. Gezählt wird wie in timelineForEmbed: alle Zeilen mit der
   * embed_id, nie embed_id 0. Wirft bei Datenbankfehlern.
   *
   * available sagt, ob es den Vergleich gibt: nur wenn der Vorzeitraum (der
   * frühere der beiden Bereiche) nicht vor firstLedgerDay beginnt. Sonst
   * fehlen ihm Zählwerte; totals und buckets nennen dann nur, was das
   * Zählerbuch führt, und sind nicht als Vergleich zu zeigen.
   *
   * @param {number} embedId
   * @param {string} fromDay - "YYYY-MM-DD", einschließlich (des Zeitraums)
   * @param {string} toDay - "YYYY-MM-DD", einschließlich (des Zeitraums)
   * @param {string|null} firstLedgerDay - siehe firstDayForEmbed
   * @param {import("@prisma/client").PrismaClient} [client]
   * @returns {Promise<{available: boolean, fromDay: string|null, toDay: string|null, totals: EmbedCounts|null, buckets: Array<import("../utils/helpers/ledgerTimeline").TimelineBucket & {messages: number, conversations: number}>}>} -
   *   fromDay/toDay: Tage der Kennzahlen. Läge der Vorzeitraum vor dem
   *   01.01.0001, gibt es ihn nicht: available false, keine Tage, keine Werte.
   */
  previousTimelineForEmbed: async function (
    embedId,
    fromDay,
    toDay,
    firstLedgerDay,
    client = prisma
  ) {
    const id = Number(embedId);
    if (!Number.isInteger(id) || id <= 0)
      throw new Error(`MessageLedger: invalid embedId ${embedId}`);

    const layout = previousLayout(fromDay, toDay);
    if (!layout)
      return {
        available: false,
        fromDay: null,
        toDay: null,
        totals: null,
        buckets: [],
      };

    const groups = await client.message_ledger.groupBy({
      by: [layout.granularity === "hour" ? "hour" : "day"],
      where: {
        embed_id: id,
        day: { gte: layout.readFromDay, lte: layout.toDay },
      },
      _sum: {
        messages: true,
        conversations_started: true,
        feedback_positive: true,
        feedback_negative: true,
      },
    });

    const totals = {
      messages: 0,
      conversations: 0,
      feedbackPositive: 0,
      feedbackNegative: 0,
    };
    const buckets = layout.buckets.map((bucket) => ({
      ...bucket,
      messages: 0,
      conversations: 0,
    }));
    for (const group of groups) {
      // Eine Zeile zählt zur Linie, zu den Kennzahlen oder zu beidem.
      const bucket = buckets[layout.indexOf(group)];
      const counted = layout.inTotals(group);
      if (!bucket && !counted)
        throw new Error(
          `MessageLedger: no previous bucket for ${group.day ?? group.hour}`
        );
      const messages = group._sum.messages ?? 0;
      const conversations = group._sum.conversations_started ?? 0;
      if (bucket) {
        bucket.messages += messages;
        bucket.conversations += conversations;
      }
      if (counted) {
        totals.messages += messages;
        totals.conversations += conversations;
        totals.feedbackPositive += group._sum.feedback_positive ?? 0;
        totals.feedbackNegative += group._sum.feedback_negative ?? 0;
      }
    }

    return {
      available:
        typeof firstLedgerDay === "string" &&
        firstLedgerDay <= layout.readFromDay,
      fromDay: layout.fromDay,
      toDay: layout.toDay,
      totals,
      buckets,
    };
  },

  /**
   * Frühester Berliner Kalendertag, für den das Zählerbuch zu einem Widget
   * Zählwerte führt (KIE-536) - unabhängig vom Workspace der Zeile. Davor
   * gibt es für das Widget keine Statistik. Wirft bei Datenbankfehlern.
   *
   * @param {number} embedId
   * @param {import("@prisma/client").PrismaClient} [client]
   * @returns {Promise<string|null>} - "YYYY-MM-DD" oder null ohne Zählwerte
   */
  firstDayForEmbed: async function (embedId, client = prisma) {
    const id = Number(embedId);
    if (!Number.isInteger(id) || id <= 0)
      throw new Error(`MessageLedger: invalid embedId ${embedId}`);

    const first = await client.message_ledger.findFirst({
      where: {
        embed_id: id,
        OR: [
          { messages: { gt: 0 } },
          { conversations_started: { gt: 0 } },
          { feedback_positive: { gt: 0 } },
          { feedback_negative: { gt: 0 } },
        ],
      },
      orderBy: { day: "asc" },
      select: { day: true },
    });
    return first?.day ?? null;
  },

  /**
   * Kennzahlen, Zeitreihe und Nachrichten nach Wochentag und Stunde eines
   * Widgets (KIE-539) über die Berliner Kalendertage [fromDay, toDay], beide
   * einschließlich: was timelineForEmbed liefert, dazu weekdayHour - 7 Zeilen
   * (Montag bis Sonntag) mit je 24 Feldern (Berliner Stunde 0-23).
   *
   * Eine einzige Anweisung liest beides, also aus einem Lesestand: Die Summe
   * der 168 Felder ist die Kennzahl „Nachrichten" derselben Antwort, auch
   * wenn währenddessen gezählt wird. Eine Transaktion wäre dafür der falsche
   * Weg - die Engine beginnt jede mit BEGIN IMMEDIATE, sie nähme also die
   * Schreibsperre und stünde den Buchungen im Weg.
   *
   * Gruppiert wird in der Datenbank: je Abschnitt der Zeitreihe eine Zeile
   * wie in timelineForEmbed und höchstens 168 für das Raster, nie die
   * Stundenzeilen des Zeitraums selbst.
   *
   * Der Wochentag ergibt sich aus dem Kalendertag der Zeile (strftime %w):
   * reine Kalenderrechnung, ohne Zeitpunkt und ohne die Zeitzone des
   * Prozesses. Die Stunde ist die der Zeile - am Tag der Umstellung auf
   * Sommerzeit bleibt die Stunde 2 leer, am Tag der Rückstellung stehen beide
   * Durchläufe in der Stunde 2 (berlinCell). Feiertage sind Wochentage wie
   * alle anderen.
   *
   * Gezählt werden dieselben Zeilen wie in timelineForEmbed (alle Zeilen der
   * embed_id, unter welchem Workspace sie auch stehen; embed_id 0 ist nie
   * gemeint). Wirft bei einem ungültigen Zeitraum (timelineLayout) und bei
   * Datenbankfehlern.
   *
   * @param {number} embedId
   * @param {string} fromDay - "YYYY-MM-DD", einschließlich
   * @param {string} toDay - "YYYY-MM-DD", einschließlich
   * @param {import("@prisma/client").PrismaClient} [client]
   * @returns {Promise<{granularity: "hour"|"day"|"week"|"month", totals: EmbedCounts, buckets: Array<import("../utils/helpers/ledgerTimeline").TimelineBucket & {messages: number, conversations: number}>, weekdayHour: number[][]}>} - weekdayHour: [Wochentag 0 = Montag … 6 = Sonntag][Stunde 0-23]
   */
  summaryForEmbed: async function (embedId, fromDay, toDay, client = prisma) {
    const id = Number(embedId);
    if (!Number.isInteger(id) || id <= 0)
      throw new Error(`MessageLedger: invalid embedId ${embedId}`);

    const { Prisma } = require("@prisma/client");
    // Ein einzelner Tag steht in Stunden, sonst je Tag - wie timelineForEmbed.
    const hourly = timelineLayout(fromDay, toDay).granularity === "hour";
    const slot = hourly ? Prisma.sql`hour` : Prisma.sql`day`;
    // Zeilen der Zeitreihe (grid 0): slot ist Tag bzw. Stunde. Zeilen des
    // Rasters (grid 1): slot ist die Stunde, weekday der Wochentag des Tages.
    const rows = await client.$queryRaw`
      SELECT 0 AS grid, ${slot} AS slot, NULL AS weekday,
        SUM(messages) AS messages,
        SUM(conversations_started) AS conversations_started,
        SUM(feedback_positive) AS feedback_positive,
        SUM(feedback_negative) AS feedback_negative
      FROM message_ledger
      WHERE embed_id = ${id} AND day >= ${fromDay} AND day <= ${toDay}
      GROUP BY ${slot}
      UNION ALL
      SELECT 1, hour, CAST(strftime('%w', day) AS INTEGER),
        SUM(messages), 0, 0, 0
      FROM message_ledger
      WHERE embed_id = ${id} AND day >= ${fromDay} AND day <= ${toDay}
        AND messages > 0
      GROUP BY 2, 3`;

    // Ganze Zahlen kommen als BigInt, eine fehlende Angabe als null.
    const whole = (value) => (value === null ? null : Number(value));
    const groups = [];
    const weekdayHour = Array.from({ length: 7 }, () => new Array(24).fill(0));
    for (const row of rows) {
      if (whole(row.grid) === 0) {
        groups.push({
          ...(hourly ? { hour: whole(row.slot) } : { day: row.slot }),
          _sum: {
            messages: whole(row.messages),
            conversations_started: whole(row.conversations_started),
            feedback_positive: whole(row.feedback_positive),
            feedback_negative: whole(row.feedback_negative),
          },
        });
        continue;
      }
      // strftime %w zählt ab Sonntag (0); ohne gültigen Tag fehlt der Wert.
      const fromSunday = whole(row.weekday);
      const hour = whole(row.slot);
      const cells =
        fromSunday === null ? null : weekdayHour[(fromSunday + 6) % 7];
      if (!cells || !Number.isInteger(hour) || hour < 0 || hour > 23)
        throw new Error(
          `MessageLedger: no weekday-hour cell for ${row.weekday} ${row.slot}`
        );
      cells[hour] += whole(row.messages);
    }

    const timeline = await MessageLedger.timelineForEmbed(
      id,
      fromDay,
      toDay,
      client,
      { groups }
    );
    return { ...timeline, weekdayHour };
  },

  /**
   * Berliner Kalendertage, die ein halboffenes Fenster [start, endExclusive)
   * abdeckt. Die Fenster aus getBillingWindow beginnen und enden um 00:00 Uhr
   * Berliner Zeit und entsprechen damit genau ganzen Tagen (aligned). Das
   * Zählerbuch kennt keine feinere Grenze: Ein Fenster, das nicht auf 00:00
   * Uhr Berliner Zeit liegt, wird auf die angeschnittenen Tage erweitert.
   *
   * @param {Date} start - inklusiv
   * @param {Date} endExclusive - exklusiv
   * @returns {{fromDay: string, toDayExclusive: string, aligned: boolean}}
   */
  daysOfWindow: function (start, endExclusive) {
    const fromDay = berlinDayOf(start);
    const endDay = berlinDayOf(endExclusive);
    const startAligned =
      berlinMidnight(fromDay).getTime() === new Date(start).getTime();
    const endAligned =
      berlinMidnight(endDay).getTime() === new Date(endExclusive).getTime();
    return {
      fromDay,
      toDayExclusive: endAligned
        ? endDay
        : dayToMarker(endDay, 1).toISOString().slice(0, 10),
      aligned: startAligned && endAligned,
    };
  },

  /**
   * Meldet eine Abweichung zwischen Zählerbuch und Live-Zählung als Ereignis
   * message_ledger_mismatch, höchstens einmal je Workspace und Stunde. Am
   * gelieferten Stand ändert das nichts: Es gilt das Zählerbuch.
   *
   * Eine Abweichung liegt vor, wenn im Fenster mehr Chat-Zeilen vorhanden
   * sind, als das Zählerbuch je gebucht hat (messages + copied). Weniger
   * Zeilen sind der Normalfall: Löschungen senken nur die Live-Zählung.
   *
   * @param {Object} params
   * @param {{id: number, slug?: string}} params.workspace
   * @param {{messages: number, copied: number}} params.ledger
   * @param {number} params.liveCount - vorhandene Chat-Zeilen im Fenster
   * @param {Date} params.start
   * @param {Date} params.endExclusive
   * @returns {Promise<boolean>} - true, wenn ein Ereignis geschrieben wurde
   */
  reportMismatch: async function ({
    workspace,
    ledger,
    liveCount,
    start,
    endExclusive,
  }) {
    if (liveCount <= ledger.messages + ledger.copied) return false;

    const hourBucket = Math.floor(Date.now() / MS_PER_HOUR);
    if (reportedMismatches.get(workspace.id) === hourBucket) return false;
    reportedMismatches.set(workspace.id, hourBucket);

    try {
      // Auch über einen Neustart hinweg höchstens einmal je Stunde.
      const recent = await prisma.event_logs.findMany({
        where: {
          event: EVENT_MISMATCH,
          occurredAt: { gte: new Date(hourBucket * MS_PER_HOUR) },
        },
        select: { metadata: true },
      });
      const alreadyReported = recent.some((entry) => {
        try {
          return JSON.parse(entry.metadata)?.workspaceId === workspace.id;
        } catch {
          return false;
        }
      });
      if (alreadyReported) return false;

      console.error(
        `\x1b[31m[MessageLedger]\x1b[0m Abweichung in Workspace ${workspace.id}: Zählerbuch ${ledger.messages} (+${ledger.copied} Kopien), vorhandene Chat-Zeilen ${liveCount}. Es gilt das Zählerbuch.`
      );
      await EventLogs.logEvent(EVENT_MISMATCH, {
        workspaceId: workspace.id,
        workspaceSlug: workspace.slug ?? null,
        ledgerMessages: ledger.messages,
        ledgerCopied: ledger.copied,
        liveCount,
        window: {
          start: new Date(start).toISOString(),
          endExclusive: new Date(endExclusive).toISOString(),
          startDay: berlinDayOf(start),
          endDayExclusive: berlinDayOf(endExclusive),
        },
        note: "Im Fenster sind mehr Chat-Zeilen vorhanden, als im Zählerbuch gebucht wurden. Bekannte Ursache ohne Fehler: Ein Widget wurde in diesen Workspace umgehängt (die Live-Zählung wandert mit, das Zählerbuch nicht). Sonst: Zeilen ohne Zählung, z. B. nach einem Rollback auf ein älteres Image (scripts/ledger-resync.js).",
      });
      return true;
    } catch (error) {
      console.error(error.message);
      return false;
    }
  },

  // -------------------------------------------------------------------------
  // Markierung des Nachtrags
  // -------------------------------------------------------------------------

  parseBackfillState,

  /**
   * Liest die Markierung des Nachtrags. Wirft bei Datenbankfehlern.
   * @param {import("@prisma/client").PrismaClient|import("@prisma/client").Prisma.TransactionClient} [client]
   * @returns {Promise<BackfillState|null>} - null, solange kein Wasserstand festgehalten ist
   */
  backfillState: async function (client = prisma) {
    const setting = await client.system_settings.findUnique({
      where: { label: BACKFILL_LABEL },
    });
    return parseBackfillState(setting?.value);
  },

  /**
   * Schreibt die Markierung des Nachtrags (innerhalb der Transaktion, die das
   * zugehörige Paket verarbeitet).
   * @param {import("@prisma/client").Prisma.TransactionClient} tx
   * @param {BackfillState} state
   */
  writeBackfillState: async function (tx, state) {
    const value = JSON.stringify(state);
    await tx.system_settings.upsert({
      where: { label: BACKFILL_LABEL },
      update: { value, lastUpdatedAt: new Date() },
      create: { label: BACKFILL_LABEL, value },
    });
  },

  /**
   * Hält den Wasserstand fest, falls noch keiner vorliegt: den höchsten
   * Zeilenschlüssel von workspace_chats und embed_chats. Zeilen bis dahin
   * gehören dem Nachtrag, alle späteren werden beim Anlegen gezählt. Die
   * Schlüssel beider Tabellen werden nie wiederverwendet (AUTOINCREMENT).
   *
   * @param {import("@prisma/client").Prisma.TransactionClient} tx
   * @returns {Promise<BackfillState>}
   */
  ensureWatermark: async function (tx) {
    const existing = await MessageLedger.backfillState(tx);
    if (existing) return existing;

    const [max] = await tx.$queryRaw`
      SELECT
        (SELECT MAX(id) FROM workspace_chats) AS workspace_chats,
        (SELECT MAX(id) FROM embed_chats) AS embed_chats`;
    const now = new Date().toISOString();
    const state = {
      version: 1,
      state: "pending",
      tables: {
        workspace_chats: emptyTableState(Number(max.workspace_chats ?? 0)),
        embed_chats: emptyTableState(Number(max.embed_chats ?? 0)),
      },
      capturedAt: now,
      startedAt: null,
      completedAt: null,
      durationMs: 0,
      error: null,
    };

    // Ein gefülltes Zählerbuch ohne Markierung gibt es im Betrieb nicht: Jede
    // Buchung hält vorher den Wasserstand fest. Die Markierung ist also
    // verloren gegangen oder unlesbar. Ein neuer Nachtrag würde den Bestand
    // ein zweites Mal buchen, und senken lässt sich das Zählerbuch nicht mehr.
    // Deshalb gilt der Nachtrag als abgeschlossen; was dem Zählerbuch fehlen
    // sollte, meldet der Vergleich mit der Live-Zählung (ledger-resync).
    if ((await tx.message_ledger.count()) > 0) {
      state.state = "complete";
      state.completedAt = now;
      state.recovered = true;
      for (const table of BACKFILL_TABLES) {
        state.tables[table].lastId = state.tables[table].maxId;
        state.tables[table].done = true;
      }
      console.error(
        `\x1b[31m[MessageLedger]\x1b[0m Markierung ${BACKFILL_LABEL} fehlt bei gefülltem Zählerbuch. Kein neuer Nachtrag (er würde doppelt zählen); der Nachtrag gilt als abgeschlossen.`
      );
      await tx.event_logs.create({
        data: {
          event: EVENT_MARKER_RECOVERED,
          metadata: JSON.stringify({ tables: state.tables }),
          occurredAt: new Date(),
        },
      });
    }

    await MessageLedger.writeBackfillState(tx, state);
    return state;
  },

  /**
   * Ist der Nachtrag als abgeschlossen markiert? Erst dann liest das
   * Kontingent das Zählerbuch. Bei einem Lesefehler: nein.
   * @param {{throwOnError?: boolean}} [options] - KIE-534: true reicht den
   * Lesefehler weiter. Sonst fiele die Limitprüfung der Agent-Sitzung still
   * auf die Live-Zählung zurück (zu niedrig, sobald Zeilen gelöscht wurden).
   * @returns {Promise<boolean>}
   */
  isBackfillComplete: async function ({ throwOnError = false } = {}) {
    if (backfillComplete) return true;
    try {
      const state = await MessageLedger.backfillState();
      if (state) watermarkCaptured = true;
      if (state?.state === "complete") backfillComplete = true;
      return backfillComplete;
    } catch (error) {
      console.error(error.message);
      if (throwOnError) throw error;
      return false;
    }
  },

  /**
   * Steht eine Chat-Zeile schon im Zählerbuch? Ja, wenn sie nach dem
   * Wasserstand entstand (beim Anlegen gezählt) oder der Nachtrag sie bereits
   * erfasst hat. Für Bewertungen: Der Übergang wird nur für gezählte Zeilen
   * gebucht, die übrigen erfasst der Nachtrag mit ihrem dann aktuellen Stand.
   *
   * @param {import("@prisma/client").Prisma.TransactionClient} tx
   * @param {"workspace_chats"|"embed_chats"} table
   * @param {number} id
   * @returns {Promise<boolean>}
   */
  isRowCounted: async function (tx, table, id) {
    if (backfillComplete) return true;
    const state = await MessageLedger.ensureWatermark(tx);
    if (state.state === "complete") return true;
    const progress = state.tables[table];
    return id > progress.maxId || progress.done || id <= progress.lastId;
  },

  /** Nur für Tests: vergisst, was sich der Prozess gemerkt hat. */
  _resetCache: function () {
    backfillComplete = false;
    watermarkCaptured = false;
    reportedMismatches.clear();
    writeFailures.clear();
    cancelWriteFailureFlush();
  },
};

module.exports = { MessageLedger };
