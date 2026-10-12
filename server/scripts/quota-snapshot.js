#!/usr/bin/env node
/**
 * Kontingent-Schnappschuss für den Rollout des einheitlichen Zyklusfensters
 * (KIE-531).
 *
 * Arbeitet ohne laufenden Server direkt auf einer SQLite-Datei, am besten auf
 * einer Kopie. Es wird nur gelesen.
 *
 *   node scripts/quota-snapshot.js snapshot --mode legacy --legacy-tz Europe/Berlin \
 *        --db /pfad/anythingllm.db --now 2026-10-12T08:00:00Z --out vorher.json
 *   node scripts/quota-snapshot.js snapshot --mode current \
 *        --db /pfad/anythingllm.db --now 2026-10-12T08:00:00Z --out nachher.json
 *   node scripts/quota-snapshot.js compare vorher.json nachher.json
 *
 * snapshot gibt je Workspace Limit, Fenster und Verbrauch als JSON aus.
 *   --mode legacy   Fenster wie vor KIE-531: in der Zeitzone des damaligen
 *                   Serverprozesses (--legacy-tz, Pflicht), verkettetes
 *                   addMonths, Ende auf 23:59:59,999 des Vortags geklemmt.
 *   --mode current  Fenster aus getBillingWindow (Berliner Zeit, halboffen).
 *   --db            SQLite-Datei; ohne Angabe gilt die Prisma-Konfiguration.
 *   --now           Bezugszeitpunkt. Für beide Schnappschüsse denselben Wert
 *                   angeben, sonst ist nichts vergleichbar. Gezählt wird nur
 *                   bis zu diesem Zeitpunkt.
 *
 * compare vergleicht zwei Schnappschüsse und nennt je Abweichung die Ursache:
 *   - Nachrichten in der bisherigen Lücke (zwischen 00:00 Uhr Berliner Zeit
 *     und dem bisherigen Zyklusstart am selben Tag),
 *   - Zyklusstart verschoben (Starttag 29.–31., der bisher auf dem geklemmten
 *     Tag hängen blieb).
 * Workspaces, die durch die neuen Grenzen ihr Limit erreichen, stehen in einer
 * eigenen Liste. Bleibt ein Unterschied ohne eine der beiden Ursachen, endet
 * compare mit Status 1: Der Rollout darf dann nicht fortgesetzt werden.
 *
 * Status: 0 = alles erklärt, 1 = unerklärter Unterschied, 2 = Aufruf- oder
 * Laufzeitfehler.
 */

const fs = require("fs");
const path = require("path");
const {
  getBillingWindow,
  berlinDayOf,
} = require("../utils/helpers/billingWindow");

const SNAPSHOT_SCHEMA = "quota-snapshot/1";
const MS_PER_DAY = 24 * 60 * 60 * 1000;
// Die bisherige Zyklussuche zählt hoch. Ein Startdatum weit in der
// Vergangenheit soll den Schnappschuss nicht aufhängen.
const LEGACY_MAX_CYCLES = 50000;

// ---------------------------------------------------------------------------
// Bisherige Fensterlogik (Stand vor KIE-531), nachgebildet für eine
// ausdrücklich genannte Zeitzone statt für die des laufenden Prozesses.
// ---------------------------------------------------------------------------

const zoneFormatters = new Map();

function zoneFormatter(timeZone) {
  if (!zoneFormatters.has(timeZone)) {
    zoneFormatters.set(
      timeZone,
      new Intl.DateTimeFormat("en-US", {
        timeZone,
        hourCycle: "h23",
        era: "short",
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "numeric",
        minute: "numeric",
        second: "numeric",
      })
    );
  }
  return zoneFormatters.get(timeZone);
}

/**
 * Wanduhrzeit eines Zeitpunkts in einer Zeitzone als "falsches UTC": ein
 * Millisekundenwert, dessen UTC-Felder die Ortszeit zeigen. Damit lässt sich
 * mit den UTC-Methoden von Date so rechnen, wie der bisherige Code mit den
 * lokalen Methoden gerechnet hat.
 * @param {number} instantMs
 * @param {string} timeZone
 * @returns {number}
 */
function toWallClock(instantMs, timeZone) {
  const fields = {};
  for (const { type, value } of zoneFormatter(timeZone).formatToParts(
    new Date(instantMs)
  ))
    fields[type] = Number.isNaN(Number(value)) ? value : Number(value);
  const year = fields.era === "BC" ? 1 - fields.year : fields.year;
  const wall = new Date(0);
  // setUTCFullYear statt Date.UTC: Letzteres legt die Jahre 0-99 auf 1900-1999.
  wall.setUTCFullYear(year, fields.month - 1, fields.day);
  wall.setUTCHours(fields.hour, fields.minute, fields.second, 0);
  return wall.getTime() + (((instantMs % 1000) + 1000) % 1000);
}

/**
 * Umkehrung von toWallClock. Zeiten, die es wegen der Zeitumstellung doppelt
 * oder gar nicht gibt, werden wie bei Date mit dem Versatz vor der Umstellung
 * gedeutet.
 * @param {number} wallMs
 * @param {string} timeZone
 * @returns {number}
 */
function fromWallClock(wallMs, timeZone) {
  const offsetAt = (ms) => toWallClock(ms, timeZone) - ms;
  const before = wallMs - offsetAt(wallMs - MS_PER_DAY);
  const after = wallMs - offsetAt(wallMs + MS_PER_DAY);
  if (before === after) return before;
  const beforeFits = toWallClock(before, timeZone) === wallMs;
  const afterFits = toWallClock(after, timeZone) === wallMs;
  return afterFits && !beforeFits ? after : before;
}

/** Bisheriges addMonths: Ortszeit, klemmt auf den letzten Tag des Zielmonats. */
function legacyAddMonths(instantMs, months, timeZone) {
  const wall = new Date(toWallClock(instantMs, timeZone));
  const originalDay = wall.getUTCDate();
  wall.setUTCMonth(wall.getUTCMonth() + months);
  let result = fromWallClock(wall.getTime(), timeZone);

  const check = new Date(toWallClock(result, timeZone));
  if (check.getUTCDate() !== originalDay) {
    check.setUTCDate(0);
    result = fromWallClock(check.getTime(), timeZone);
  }
  return result;
}

/** Bisheriges Klemmen des Fensterendes auf 23:59:59,999 Ortszeit. */
function legacyEndOfDay(instantMs, timeZone) {
  const wall = new Date(toWallClock(instantMs, timeZone));
  wall.setUTCHours(23, 59, 59, 999);
  return fromWallClock(wall.getTime(), timeZone);
}

function toValidDate(value) {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? value : new Date(value);
  return isNaN(date.getTime()) ? null : date;
}

/**
 * Fenster, in dem der Code vor KIE-531 zu einem Zeitpunkt gezählt hat.
 *
 * Mit cycleStartDate: Zyklen durch verkettetes addMonths in Ortszeit ab dem
 * gespeicherten Zeitpunkt (00:00 UTC, also 01:00/02:00 Uhr in Berlin); das
 * Ende ist der Vortag des nächsten Starts, geklemmt auf 23:59:59,999. Ohne
 * cycleStartDate: der Kalendermonat in Ortszeit. Das inklusive Ende wird
 * hier als exklusives Ende (+1 ms) zurückgegeben.
 *
 * @param {{cycleStartDate?: Date|string|null, cycleDurationMonths?: number|null}} workspace
 * @param {Date} now
 * @param {string} timeZone - Zeitzone des damaligen Serverprozesses (IANA)
 * @returns {{start: Date, endExclusive: Date, cycleNumber: number|null}}
 */
function legacyWindow(workspace, now, timeZone) {
  const nowMs = now.getTime();
  const startDate = toValidDate(workspace.cycleStartDate);

  if (startDate) {
    const duration = workspace.cycleDurationMonths || 1;
    let cycleStart = startDate.getTime();
    let cycleNumber = 1;
    let nextReset = legacyAddMonths(cycleStart, duration, timeZone);
    while (nextReset <= nowMs) {
      if (cycleNumber >= LEGACY_MAX_CYCLES || nextReset <= cycleStart)
        throw new Error(
          `Bisheriges Fenster nicht bestimmbar (cycleStartDate ${startDate.toISOString()}, Dauer ${duration}).`
        );
      cycleStart = nextReset;
      cycleNumber++;
      nextReset = legacyAddMonths(cycleStart, duration, timeZone);
    }

    const lastDay = new Date(toWallClock(nextReset, timeZone));
    lastDay.setUTCDate(lastDay.getUTCDate() - 1);
    const cycleEnd = fromWallClock(lastDay.getTime(), timeZone);
    return {
      start: new Date(cycleStart),
      endExclusive: new Date(legacyEndOfDay(cycleEnd, timeZone) + 1),
      cycleNumber,
    };
  }

  const wallNow = new Date(toWallClock(nowMs, timeZone));
  const startOfMonth = new Date(0);
  startOfMonth.setUTCFullYear(
    wallNow.getUTCFullYear(),
    wallNow.getUTCMonth(),
    1
  );
  const endOfMonth = new Date(0);
  endOfMonth.setUTCFullYear(
    wallNow.getUTCFullYear(),
    wallNow.getUTCMonth() + 1,
    0
  );
  return {
    start: new Date(fromWallClock(startOfMonth.getTime(), timeZone)),
    endExclusive: new Date(
      legacyEndOfDay(fromWallClock(endOfMonth.getTime(), timeZone), timeZone) +
        1
    ),
    cycleNumber: null,
  };
}

// ---------------------------------------------------------------------------
// Schnappschuss
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} WindowCounts
 * @property {number} workspaceChatCount
 * @property {number} embedChatCount
 * @property {number} adjustmentsTotal
 */

/** Summe ohne die Klemmung auf 0, damit sich Fensteranteile addieren lassen. */
function rawTotal(counts) {
  return (
    counts.workspaceChatCount + counts.embedChatCount + counts.adjustmentsTotal
  );
}

const EMPTY_COUNTS = {
  workspaceChatCount: 0,
  embedChatCount: 0,
  adjustmentsTotal: 0,
};

function dayOfMonth(day) {
  return Number(day.slice(-2));
}

/**
 * Beschreibt, worin sich bisheriges und neues Fenster eines Workspaces
 * unterscheiden und wie viele Einheiten (Nachrichten plus Buchungsbeträge) in
 * den Abschnitten liegen, die nur eines der beiden Fenster enthält. Daraus
 * leitet compare die Ursache einer Abweichung ab.
 *
 * @returns {Promise<Object>}
 */
async function describeTransition({
  workspace,
  now,
  legacyTimeZone,
  countInWindow,
}) {
  const current = getBillingWindow(workspace, now);
  const legacy = legacyWindow(workspace, now, legacyTimeZone);
  const legacyStartDay = berlinDayOf(legacy.start);
  const transition = {
    legacyTimeZone,
    legacyStart: legacy.start.toISOString(),
    legacyEndExclusive: legacy.endExclusive.toISOString(),
    legacyStartDay,
    currentStart: current.start.toISOString(),
    currentStartDay: current.startDay,
    comparable: true,
    note: null,
    gapUnits: 0,
    shiftUnits: 0,
    shiftFromDay: null,
    shiftToDay: null,
  };

  // Nur wenn beide Fenster den Bezugszeitpunkt enthalten, unterscheiden sie
  // sich allein am Anfang. Sonst zählen sie verschiedene Zyklen.
  if (now < legacy.start || now >= legacy.endExclusive) {
    transition.comparable = false;
    if (now >= legacy.endExclusive)
      transition.note =
        "Bezugszeitpunkt liegt in der bisherigen Lücke: bisher galt noch der vorige Zyklus.";
    else if (current.cycleNumber === 0)
      transition.note =
        "Zyklusstart in der Zukunft: bisher zählte bis dahin nichts, jetzt gilt der Kalendermonat.";
    else
      transition.note =
        "Bezugszeitpunkt liegt vor dem bisherigen Zyklusstart: bisher zählte bis dahin nichts.";
    return transition;
  }

  const originDate = toValidDate(workspace.cycleStartDate);
  const originDay = originDate ? dayOfMonth(berlinDayOf(originDate)) : null;
  const countUnits = async (start, endExclusive) =>
    start < endExclusive
      ? rawTotal(await countInWindow(workspace, start, endExclusive))
      : 0;
  const upToNow = new Date(now.getTime() + 1);

  if (legacyStartDay === current.startDay) {
    if (current.start < legacy.start) {
      // Zwischen 00:00 Uhr Berliner Zeit und dem bisherigen Start. Eine Lücke
      // ist das nur, soweit der vorige bisherige Zyklus dort schon zu Ende war.
      const previous = legacyWindow(
        workspace,
        new Date(legacy.start.getTime() - 1),
        legacyTimeZone
      );
      const gapStart =
        previous.start < legacy.start && previous.endExclusive > current.start
          ? previous.endExclusive
          : current.start;
      const gapEnd = legacy.start < upToNow ? legacy.start : upToNow;
      transition.gapUnits = await countUnits(gapStart, gapEnd);
    }
  } else if (originDay !== null && originDay >= 29) {
    // Starttag 29.–31.: Der bisherige Start blieb auf dem geklemmten Tag.
    // Entweder hat das neue Fenster später begonnen (die Tage dazwischen
    // fallen heraus), oder es läuft noch bis zum Originaltag weiter (der
    // bisher schon abgeschnittene Zyklus zählt noch mit).
    const newStartsLater = legacy.start < current.start;
    const [from, to] = newStartsLater
      ? [legacy.start, current.start]
      : [current.start, legacy.start];
    const units = await countUnits(from, to < upToNow ? to : upToNow);
    transition.shiftUnits = newStartsLater ? -units : units;
    transition.shiftFromDay = dayOfMonth(legacyStartDay);
    transition.shiftToDay = dayOfMonth(
      newStartsLater ? current.startDay : current.endDayExclusive
    );
  }

  return transition;
}

/**
 * Erstellt den Schnappschuss: je Workspace Limit, Fenster und Verbrauch.
 *
 * @param {Object} params
 * @param {Array<Object>} params.workspaces - id, slug, name, messagesLimit, cycleStartDate, cycleDurationMonths
 * @param {(workspace: Object, start: Date, endExclusive: Date) => Promise<WindowCounts>} params.countInWindow - zählt im halboffenen Fenster
 * @param {Date} params.now - Bezugszeitpunkt
 * @param {"legacy"|"current"} params.mode
 * @param {string|null} [params.legacyTimeZone] - Pflicht für mode "legacy"
 * @param {string|null} [params.database]
 * @returns {Promise<Object>}
 */
async function buildSnapshot({
  workspaces,
  countInWindow,
  now,
  mode,
  legacyTimeZone = null,
  database = null,
}) {
  if (!["legacy", "current"].includes(mode))
    throw new Error(`Unbekannter Modus: ${mode}`);
  if (mode === "legacy" && !legacyTimeZone)
    throw new Error("Für mode legacy muss legacyTimeZone angegeben sein.");
  if (legacyTimeZone) zoneFormatter(legacyTimeZone); // wirft bei unbekannter Zeitzone

  // Nach dem Bezugszeitpunkt eingegangene Zeilen bleiben außen vor, damit
  // zwei Läufe gegen eine weiterlaufende Datenbank vergleichbar sind.
  const upToNow = new Date(now.getTime() + 1);
  const entries = [];

  for (const workspace of workspaces) {
    const entry = {
      id: workspace.id,
      slug: workspace.slug ?? null,
      name: workspace.name ?? null,
      messagesLimit: workspace.messagesLimit ?? null,
      cycleStartDate:
        toValidDate(workspace.cycleStartDate)?.toISOString() ?? null,
      cycleDurationMonths: workspace.cycleDurationMonths ?? null,
    };

    try {
      let window;
      if (mode === "current") {
        const billingWindow = getBillingWindow(workspace, now);
        window = {
          start: billingWindow.start,
          endExclusive: billingWindow.endExclusive,
          cycleNumber: billingWindow.cycleNumber,
        };
      } else {
        window = legacyWindow(workspace, now, legacyTimeZone);
      }

      const countEnd =
        window.endExclusive < upToNow ? window.endExclusive : upToNow;
      const counts =
        window.start < countEnd
          ? await countInWindow(workspace, window.start, countEnd)
          : EMPTY_COUNTS;
      // Wie der Server: Gutschriften drücken den Stand nicht unter 0.
      const messageCount = Math.max(0, rawTotal(counts));

      Object.assign(entry, {
        window: {
          start: window.start.toISOString(),
          endExclusive: window.endExclusive.toISOString(),
          startDay: berlinDayOf(window.start),
          endDayExclusive: berlinDayOf(window.endExclusive),
          cycleNumber: window.cycleNumber,
        },
        messageCount,
        workspaceChatCount: counts.workspaceChatCount,
        embedChatCount: counts.embedChatCount,
        adjustmentsTotal: counts.adjustmentsTotal,
        limitReached:
          entry.messagesLimit !== null && messageCount >= entry.messagesLimit,
        transition: legacyTimeZone
          ? await describeTransition({
              workspace,
              now,
              legacyTimeZone,
              countInWindow,
            })
          : null,
      });
    } catch (error) {
      // Ein nicht auswertbarer Workspace bleibt sichtbar und gilt im Vergleich
      // als unerklärt.
      entry.error = error.message;
    }

    entries.push(entry);
  }

  return {
    schema: SNAPSHOT_SCHEMA,
    mode,
    legacyTimeZone,
    now: now.toISOString(),
    database,
    workspaces: entries,
  };
}

// ---------------------------------------------------------------------------
// Vergleich (reine Funktion)
// ---------------------------------------------------------------------------

function formatSigned(value) {
  return value > 0 ? `+${value}` : String(value);
}

function label(entry) {
  return `[${entry.id}] ${entry.slug ?? "?"}`;
}

/**
 * Vergleicht zwei Schnappschüsse und nennt je Abweichung die Ursache.
 *
 * Status je Workspace:
 * - "identical": derselbe Stand.
 * - "explained": Der Unterschied entspricht genau den Nachrichten in der
 *   bisherigen Lücke und/oder dem verschobenen Zyklusstart.
 * - "unexplained": alles andere. Dann ist ok false.
 *
 * limitReached listet gesondert die Workspaces, die erst durch die neuen
 * Grenzen ihr Limit erreichen oder überschreiten.
 *
 * @param {Object} before - Schnappschuss vor dem Wechsel (mode legacy)
 * @param {Object} after - Schnappschuss nach dem Wechsel (mode current)
 * @returns {{ok: boolean, warnings: string[], workspaces: Object[], unexplained: Object[], limitReached: Object[], resetDayChanged: Object[]}}
 */
function compareSnapshots(before, after) {
  const warnings = [];
  for (const [name, snapshot] of [
    ["vorher", before],
    ["nachher", after],
  ]) {
    if (snapshot?.schema !== SNAPSHOT_SCHEMA)
      throw new Error(
        `Schnappschuss "${name}" hat nicht das Format ${SNAPSHOT_SCHEMA}.`
      );
  }

  const sameNow = before.now === after.now;
  if (!sameNow)
    warnings.push(
      `Unterschiedliche Bezugszeitpunkte (vorher ${before.now}, nachher ${after.now}): Abweichungen lassen sich keiner Ursache zuordnen. Beide Schnappschüsse mit demselben --now erstellen.`
    );
  if (before.mode !== "legacy" || after.mode !== "current")
    warnings.push(
      `Erwartet wird vorher = legacy und nachher = current (ist: ${before.mode} und ${after.mode}).`
    );

  const beforeById = new Map(before.workspaces.map((ws) => [ws.id, ws]));
  const afterById = new Map(after.workspaces.map((ws) => [ws.id, ws]));
  const ids = [...new Set([...beforeById.keys(), ...afterById.keys()])].sort(
    (a, b) => a - b
  );

  const results = [];
  const limitReached = [];
  const resetDayChanged = [];

  for (const id of ids) {
    const old = beforeById.get(id);
    const now = afterById.get(id);
    const reference = now ?? old;
    const result = {
      id,
      slug: reference.slug,
      name: reference.name,
      messagesLimit: reference.messagesLimit,
      before: old?.messageCount ?? null,
      after: now?.messageCount ?? null,
      delta: null,
      status: "unexplained",
      causes: [],
      unexplainedUnits: null,
      notes: [],
      message: "",
    };

    if (!old || !now) {
      result.message = `${label(reference)}: nur im Schnappschuss ${old ? "vorher" : "nachher"} enthalten, unerklärt`;
      results.push(result);
      continue;
    }
    if (old.error || now.error) {
      result.message = `${label(reference)}: nicht auswertbar (${old.error ?? now.error}), unerklärt`;
      results.push(result);
      continue;
    }

    result.delta = now.messageCount - old.messageCount;
    const rawDelta = rawTotal(now) - rawTotal(old);
    const transition = sameNow ? old.transition ?? now.transition : null;

    if (transition?.shiftFromDay && transition?.shiftToDay) {
      const change = {
        id,
        slug: reference.slug,
        name: reference.name,
        fromDay: transition.shiftFromDay,
        toDay: transition.shiftToDay,
      };
      resetDayChanged.push(change);
      if (rawDelta === 0)
        result.notes.push(
          `Zyklusstart verschoben vom ${change.fromDay}. auf den ${change.toDay}. (ohne Auswirkung auf den Stand)`
        );
    }

    if (rawDelta === 0 && result.delta === 0) {
      result.status = "identical";
      result.message = `${label(reference)}: identisch (${now.messageCount})`;
    } else {
      if (transition?.gapUnits)
        result.causes.push({
          code: "legacy_gap",
          units: transition.gapUnits,
          text: "Nachrichten in der bisherigen Lücke",
        });
      if (transition?.shiftUnits)
        result.causes.push({
          code: "cycle_start_shifted",
          units: transition.shiftUnits,
          text: `Zyklusstart verschoben vom ${transition.shiftFromDay}. auf den ${transition.shiftToDay}.`,
        });

      const explainedUnits = result.causes.reduce(
        (sum, cause) => sum + cause.units,
        0
      );
      result.unexplainedUnits = rawDelta - explainedUnits;
      const causeText = result.causes
        .map((cause) =>
          result.causes.length > 1
            ? `${cause.text} (${formatSigned(cause.units)})`
            : cause.text
        )
        .join(" und ");
      const change = `${label(reference)}: ${old.messageCount} → ${now.messageCount}, ${formatSigned(result.delta)}`;

      if (result.unexplainedUnits === 0 && result.causes.length > 0) {
        result.status = "explained";
        result.message = `${change}, Ursache: ${causeText}`;
      } else {
        if (transition?.note) result.notes.push(transition.note);
        result.message =
          result.causes.length > 0
            ? `${change}, unerklärt: ${formatSigned(result.unexplainedUnits)} neben ${causeText}`
            : `${change}, unerklärt: keine der benannten Ursachen`;
      }
    }

    if (now.limitReached && !old.limitReached)
      limitReached.push({
        id,
        slug: reference.slug,
        name: reference.name,
        messagesLimit: now.messagesLimit,
        before: old.messageCount,
        after: now.messageCount,
        status: result.status,
      });

    results.push(result);
  }

  const unexplained = results.filter(
    (result) => result.status === "unexplained"
  );
  return {
    ok: unexplained.length === 0,
    warnings,
    workspaces: results,
    unexplained,
    limitReached,
    resetDayChanged,
  };
}

/**
 * Lesbare Ausgabe eines Vergleichs.
 * @param {ReturnType<typeof compareSnapshots>} comparison
 * @returns {string}
 */
function formatComparison(comparison) {
  const lines = ["Vergleich der Kontingent-Schnappschüsse (KIE-531)", ""];
  for (const warning of comparison.warnings) lines.push(`Warnung: ${warning}`);
  if (comparison.warnings.length) lines.push("");

  for (const result of comparison.workspaces) {
    lines.push(result.message);
    for (const note of result.notes) lines.push(`    Hinweis: ${note}`);
  }

  lines.push("");
  if (comparison.limitReached.length) {
    lines.push(
      "Limit durch die neuen Grenzen erreicht oder überschritten (vor dem Rollout auf Kundencontainer klären, bei Bedarf Gutschrift buchen):"
    );
    for (const entry of comparison.limitReached)
      lines.push(
        `  [${entry.id}] ${entry.slug ?? "?"}: ${entry.before} → ${entry.after} bei Limit ${entry.messagesLimit}`
      );
  } else {
    lines.push("Kein Workspace erreicht durch die neuen Grenzen sein Limit.");
  }

  if (comparison.resetDayChanged.length) {
    lines.push("", "Geänderter Reset-Tag (Starttag 29.–31.):");
    for (const entry of comparison.resetDayChanged)
      lines.push(
        `  [${entry.id}] ${entry.slug ?? "?"}: vom ${entry.fromDay}. auf den ${entry.toDay}.`
      );
  }

  const count = (status) =>
    comparison.workspaces.filter((result) => result.status === status).length;
  lines.push(
    "",
    `Ergebnis: ${count("identical")} identisch, ${count("explained")} erklärt, ${count("unexplained")} unerklärt.`
  );
  if (!comparison.ok)
    lines.push(
      "Unerklärter Unterschied: Der Rollout darf nicht fortgesetzt werden."
    );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Datenbankzugriff und Aufruf
// ---------------------------------------------------------------------------

/**
 * Öffnet die Datenbank ohne Server. Mit Pfad wird genau diese SQLite-Datei
 * verwendet, sonst die Prisma-Konfiguration des Servers.
 * @param {string|null} databasePath
 */
function openDatabase(databasePath) {
  if (!databasePath) return require("../utils/prisma");
  const { PrismaClient } = require("@prisma/client");
  return new PrismaClient({
    datasources: { db: { url: `file:${databasePath}` } },
  });
}

/**
 * Zählfunktion wie im Server (Chats, Embed-Chats, Buchungen), nur dass
 * Datenbankfehler hier nicht verschluckt werden: Ein Schnappschuss mit
 * stillen Nullen wäre wertlos.
 * @param {import("@prisma/client").PrismaClient} prisma
 */
function databaseCounter(prisma) {
  return async function countInWindow(workspace, start, endExclusive) {
    const createdAt = { gte: start, lt: endExclusive };
    const [workspaceChatCount, embedChatCount, adjustments] = await Promise.all(
      [
        prisma.workspace_chats.count({
          where: { workspaceId: workspace.id, createdAt },
        }),
        prisma.embed_chats.count({
          where: { embed_config: { workspace_id: workspace.id }, createdAt },
        }),
        prisma.workspace_message_adjustments.aggregate({
          _sum: { amount: true },
          where: { workspaceId: workspace.id, createdAt },
        }),
      ]
    );
    return {
      workspaceChatCount,
      embedChatCount,
      adjustmentsTotal: adjustments?._sum?.amount ?? 0,
    };
  };
}

function parseArgs(argv) {
  const positional = [];
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (name === "json" || name === "help") {
      options[name] = true;
      continue;
    }
    const value = argv[++i];
    if (value === undefined) throw new Error(`Wert für --${name} fehlt.`);
    options[name] = value;
  }
  return { positional, options };
}

const USAGE = `Aufruf:
  node scripts/quota-snapshot.js snapshot --mode <legacy|current> [--legacy-tz <Zeitzone>]
       [--db <datei.db>] [--now <ISO-Zeitpunkt>] [--out <datei.json>]
  node scripts/quota-snapshot.js compare <vorher.json> <nachher.json> [--json]`;

async function runSnapshot(options, stdout) {
  const mode = options.mode;
  if (!["legacy", "current"].includes(mode))
    throw new Error("--mode legacy oder --mode current angeben.");
  const legacyTimeZone = options["legacy-tz"] ?? null;
  if (mode === "legacy" && !legacyTimeZone)
    throw new Error(
      "--legacy-tz angeben: die Zeitzone des bisherigen Serverprozesses, z. B. Europe/Berlin."
    );

  const now = options.now ? new Date(options.now) : new Date();
  if (isNaN(now.getTime()))
    throw new Error(`--now ist kein Zeitpunkt: ${options.now}`);

  const databasePath = options.db ? path.resolve(options.db) : null;
  if (databasePath && !fs.existsSync(databasePath))
    throw new Error(`Datenbank nicht gefunden: ${databasePath}`);

  const prisma = openDatabase(databasePath);
  try {
    const workspaces = await prisma.workspaces.findMany({
      select: {
        id: true,
        name: true,
        slug: true,
        messagesLimit: true,
        cycleStartDate: true,
        cycleDurationMonths: true,
      },
      orderBy: { id: "asc" },
    });
    const snapshot = await buildSnapshot({
      workspaces,
      countInWindow: databaseCounter(prisma),
      now,
      mode,
      legacyTimeZone,
      database: databasePath,
    });

    const json = JSON.stringify(snapshot, null, 2);
    if (options.out) fs.writeFileSync(path.resolve(options.out), `${json}\n`);
    else stdout.write(`${json}\n`);
    return 0;
  } finally {
    await prisma.$disconnect();
  }
}

function runCompare(positional, options, stdout) {
  if (positional.length !== 2)
    throw new Error("compare braucht genau zwei Schnappschuss-Dateien.");
  const [before, after] = positional.map((file) =>
    JSON.parse(fs.readFileSync(path.resolve(file), "utf8"))
  );
  const comparison = compareSnapshots(before, after);
  stdout.write(
    options.json
      ? `${JSON.stringify(comparison, null, 2)}\n`
      : `${formatComparison(comparison)}\n`
  );
  return comparison.ok ? 0 : 1;
}

/**
 * @param {string[]} argv - Argumente ohne node und Skriptpfad
 * @returns {Promise<number>} - Exit-Status
 */
async function main(
  argv,
  { stdout = process.stdout, stderr = process.stderr } = {}
) {
  try {
    const { positional, options } = parseArgs(argv);
    const [command, ...rest] = positional;
    if (options.help || !command) {
      stdout.write(`${USAGE}\n`);
      return options.help ? 0 : 2;
    }
    if (command === "snapshot") return await runSnapshot(options, stdout);
    if (command === "compare") return runCompare(rest, options, stdout);
    throw new Error(`Unbekannter Befehl: ${command}`);
  } catch (error) {
    stderr.write(`quota-snapshot: ${error.message}\n${USAGE}\n`);
    return 2;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then((status) => {
    process.exitCode = status;
  });
}

module.exports = {
  SNAPSHOT_SCHEMA,
  legacyWindow,
  buildSnapshot,
  compareSnapshots,
  formatComparison,
  main,
};
