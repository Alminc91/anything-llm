const prisma = require("../utils/prisma");
const {
  BILLING_TIME_ZONE,
  berlinDayOf,
  berlinMidnight,
  dayToMarker,
} = require("../utils/helpers/billingWindow");

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
   * ein Ereignis message_ledger_write_failed wird geschrieben und der Fehler
   * weitergereicht.
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

  _logWriteFailed: async function (context = {}, error) {
    console.error(
      `\x1b[31m[MessageLedger]\x1b[0m Chat-Zeile und Zähler nicht geschrieben (${context?.source ?? "unbekannt"}): ${error?.message}`
    );
    const { EventLogs } = require("./eventLogs");
    await EventLogs.logEvent(EVENT_WRITE_FAILED, {
      source: context?.source ?? null,
      workspaceId: context?.workspaceId ?? null,
      embedId: context?.embedId ?? null,
      error: MessageLedger.errorSummary(error),
    });
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
      select: { workspace_id: true, messages: true },
    });
    const target =
      counted.find((cell) => cell.workspace_id === workspaceId) ??
      counted.sort((a, b) => b.messages - a.messages)[0];
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
   * @returns {Promise<number>}
   */
  sumMessages: async function (workspaceId, fromDay, toDayExclusive) {
    try {
      const sums = await MessageLedger.sumForWorkspace(
        workspaceId,
        fromDay,
        toDayExclusive
      );
      return sums.messages;
    } catch (error) {
      console.error(error.message);
      return 0;
    }
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
      const { EventLogs } = require("./eventLogs");
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
   * @returns {Promise<boolean>}
   */
  isBackfillComplete: async function () {
    if (backfillComplete) return true;
    try {
      const state = await MessageLedger.backfillState();
      if (state) watermarkCaptured = true;
      if (state?.state === "complete") backfillComplete = true;
      return backfillComplete;
    } catch (error) {
      console.error(error.message);
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
  },
};

module.exports = { MessageLedger };
