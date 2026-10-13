// Auswertung „Konversationen" (KIE-536): Zeitraum, Beschriftungen, Kennzahlen
// und Geometrie des Säulendiagramms – ohne React, damit sich alles ohne
// Browser prüfen lässt (frontend/__tests__/analyticsTimeline.test.mjs).
//
// Gerechnet wird mit Kalendertagen ("YYYY-MM-DD"), so wie der Server sie
// liefert und erwartet. Ein Kalendertag wird hier nie über die Zeitzone des
// Browsers in einen Zeitpunkt umgerechnet; Wochentag, Kalenderwoche und Monat
// ergeben sich aus dem Tag allein.
//
// Datumsangaben stehen wie überall im Fork in deutscher Schreibweise
// (TT.MM.JJJJ), Zahlen mit toLocaleString("de-DE"). Nur der Wochentag und die
// Angabe „Monat Jahr" folgen der Sprache der Oberfläche – immer im
// gregorianischen Kalender und mit denselben Ziffern wie die Datumsangaben.

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const NUMBER_LOCALE = "de-DE";

export const DEFAULT_RANGE_DAYS = 30;
// Mehr Säulen zeigt kein Diagramm; der Server nimmt deshalb höchstens so viele
// Kalendermonate an (server/utils/helpers/ledgerTimeline.js).
export const MAX_BUCKETS = 92;
// Säulen: höchstens so breit, nie die ganze Spalte; oben abgerundet.
export const BAR_MAX_WIDTH = 24;
export const BAR_RADIUS = 4;
// Mittlere Zeichenbreite der Achsenbeschriftung (11 px Schrift)
const TICK_CHAR_WIDTH = 6;
// Tooltip: Abstand zur Säule; für die geschätzte Breite die mittlere
// Zeichenbreite (12 px Schrift, großzügig) und Innenabstand samt Rand.
export const TOOLTIP_GAP = 8;
const TOOLTIP_CHAR_WIDTH = 6.5;
const TOOLTIP_PADDING = 22;
// Linie des Vorzeitraums (KIE-537): gepunktet (runde Punkte im Abstand von
// 5 px), mit einer Punktmarke je Wert – solange die Säulenplätze breit genug
// sind, dass die Marken einander nicht berühren.
export const PREVIOUS_LINE = {
  width: 2,
  dash: "0.1 5",
  markerRadius: 3,
  markerMinSlot: 12,
};

/** @typedef {"hour"|"day"|"week"|"month"} Granularity */
/** @typedef {{start: string, end: string, partial: boolean, hour?: number, messages: number, conversations: number}} Bucket */
/** @typedef {{granularity: Granularity, buckets: Bucket[], totals: {messages: number, conversations: number, feedbackPositive: number, feedbackNegative: number}, firstLedgerDay: string|null, fromDay: string, toDay: string, previous?: Previous}} Summary */
/** @typedef {{available: boolean, fromDay: string|null, toDay: string|null, totals: Summary["totals"]|null, buckets: Bucket[]}} Previous - Vorzeitraum (KIE-537), nur mit eingeschaltetem Vergleich */

// ---------------------------------------------------------------------------
// Kalendertage
// ---------------------------------------------------------------------------

const pad = (value) => String(value).padStart(2, "0");

/** Laufende Tagesnummer eines Kalendertags (ohne Zeitzone). */
function serialOf(day) {
  const [year, month, date] = day.split("-").map(Number);
  return Math.round(Date.UTC(year, month - 1, date) / MS_PER_DAY);
}

function dayOfSerial(serial) {
  return new Date(serial * MS_PER_DAY).toISOString().slice(0, 10);
}

/**
 * Der Kalendertag, den ein Date in der Zeitzone des Browsers zeigt – der Tag,
 * den der Nutzer im Kalender gewählt hat.
 * @param {Date} date
 * @returns {string} - "YYYY-MM-DD"
 */
export function toDayString(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * @param {string} day - "YYYY-MM-DD"
 * @param {number} days
 * @returns {string}
 */
export function addDays(day, days) {
  return dayOfSerial(serialOf(day) + days);
}

/** Tage von a bis b (b - a). */
export function daysBetween(a, b) {
  return serialOf(b) - serialOf(a);
}

/** Wochentag eines Kalendertags, 0 = Montag … 6 = Sonntag. */
function weekdayIndex(day) {
  return (((serialOf(day) + 3) % 7) + 7) % 7;
}

/**
 * Kalenderwoche nach ISO 8601 (Montag–Sonntag; KW 1 enthält den ersten
 * Donnerstag des Jahres).
 * @param {string} day
 * @returns {{week: number, year: number}}
 */
export function isoWeek(day) {
  const thursday = addDays(day, 3 - weekdayIndex(day));
  const year = Number(thursday.slice(0, 4));
  return {
    year,
    week: Math.floor(daysBetween(`${year}-01-01`, thursday) / 7) + 1,
  };
}

/**
 * Zeitraum der Datumsauswahl als Kalendertage.
 * @param {Date|null} startDate
 * @param {Date|null} endDate
 * @returns {{fromDay: string, toDay: string}|null} - null = „Gesamt"
 */
export function rangeFromDates(startDate, endDate) {
  if (!startDate || !endDate) return null;
  return { fromDay: toDayString(startDate), toDay: toDayString(endDate) };
}

/**
 * Die letzten n Tage: heute und die n - 1 Tage davor, als Grenzen der
 * Datumsauswahl (00:00 Uhr bis 23:59:59,999 Uhr in der Zeitzone des Browsers).
 * @param {number} days
 * @param {Date} [now]
 * @returns {{startDate: Date, endDate: Date}}
 */
export function lastDaysRange(days, now = new Date()) {
  const startDate = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() - (days - 1)
  );
  const endDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  endDate.setHours(23, 59, 59, 999);
  return { startDate, endDate };
}

/**
 * Die letzten n Monate bis heute: der Tag nach dem gleichen Datum vor n
 * Monaten bis heute (12 Monate am 12.10.2026: 13.10.2025–12.10.2026).
 * @param {number} months
 * @param {Date} [now]
 * @returns {{startDate: Date, endDate: Date}}
 */
export function lastMonthsRange(months, now = new Date()) {
  const startDate = new Date(
    now.getFullYear(),
    now.getMonth() - months,
    now.getDate() + 1
  );
  const endDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  endDate.setHours(23, 59, 59, 999);
  return { startDate, endDate };
}

/**
 * Zeitraum für „Gesamt": vom ersten Tag mit Zählwerten bis heute, höchstens
 * der längste Zeitraum, den der Server annimmt – MAX_BUCKETS Kalendermonate
 * einschließlich des laufenden (am 12.10.2026 ab dem 01.03.2019).
 * @param {string|null} firstLedgerDay
 * @param {string} today
 * @returns {{fromDay: string, toDay: string}}
 */
export function allTimeRange(firstLedgerDay, today) {
  const [year, month] = today.split("-").map(Number);
  const earliest = new Date(Date.UTC(year, month - MAX_BUCKETS, 1))
    .toISOString()
    .slice(0, 10);
  const first =
    firstLedgerDay && firstLedgerDay <= today ? firstLedgerDay : today;
  return { fromDay: first < earliest ? earliest : first, toDay: today };
}

// ---------------------------------------------------------------------------
// Beschriftungen
// ---------------------------------------------------------------------------

const formatters = new Map();
/**
 * Formatierer für Kalendertage in der Sprache der Oberfläche. Der Kalender
 * ist fest gregorianisch (fa und ar-SA rechnen sonst persisch bzw. nach der
 * Hidschra – der Kalendertag ist aber ein gregorianischer), die Ziffern sind
 * die lateinischen der Datumsangaben daneben.
 */
function formatterOf(locale, options) {
  const key = `${locale}|${JSON.stringify(options)}`;
  if (!formatters.has(key)) {
    const fixed = {
      ...options,
      calendar: "gregory",
      numberingSystem: "latn",
      timeZone: "UTC",
    };
    let formatter;
    try {
      formatter = new Intl.DateTimeFormat(locale, fixed);
    } catch {
      formatter = new Intl.DateTimeFormat(NUMBER_LOCALE, fixed);
    }
    formatters.set(key, formatter);
  }
  return formatters.get(key);
}

const instantOf = (day) => new Date(`${day}T00:00:00Z`);

/**
 * @param {number} value
 * @param {number} [fractionDigits]
 * @returns {string} - deutsche Schreibweise (1.234,5)
 */
export function formatNumber(value, fractionDigits = 0) {
  return Number(value || 0).toLocaleString(NUMBER_LOCALE, {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  });
}

/** "06.10.2026" */
export function formatDate(day) {
  const [year, month, date] = day.split("-");
  return `${date}.${month}.${year}`;
}

/** "06.10." */
export function formatDateShort(day) {
  const [, month, date] = day.split("-");
  return `${date}.${month}.`;
}

/** "Di., 06.10.2026" */
export function formatWeekdayDate(day, locale) {
  // Der Wochentag, wie er vor einem Datum steht ("Di." statt "Di").
  const weekday = formatterOf(locale, {
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  })
    .formatToParts(instantOf(day))
    .find((part) => part.type === "weekday");
  return `${weekday?.value ?? ""}, ${formatDate(day)}`;
}

/**
 * "Oktober 2026", kurz "Okt. 2026" – Monat und Jahr, wie die Sprache sie
 * schreibt: Reihenfolge und Form sind nicht überall „Name Jahr" (japanisch
 * "2026年10月").
 * @param {string} day - ein Tag des Monats
 * @param {string} locale
 * @param {"long"|"short"} [width]
 * @returns {string}
 */
export function formatMonth(day, locale, width = "long") {
  return formatterOf(locale, { month: width, year: "numeric" }).format(
    instantOf(day)
  );
}

/** Erster und letzter Tag des Kalenderabschnitts, zu dem ein Abschnitt gehört. */
function calendarSpan(bucket, granularity) {
  if (granularity === "week") {
    const monday = addDays(bucket.start, -weekdayIndex(bucket.start));
    return { first: monday, last: addDays(monday, 6) };
  }
  if (granularity === "month") {
    const [year, month] = bucket.start.split("-").map(Number);
    return {
      first: `${bucket.start.slice(0, 7)}-01`,
      last: new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10),
    };
  }
  return { first: bucket.start, last: bucket.end };
}

/**
 * Ausgeschriebener Name eines Abschnitts – für Tooltip, Tabelle und die
 * Markierung „Nur <Abschnitt>" der Liste.
 *   Stunde: "Di., 06.10.2026, 13–14 Uhr"
 *   Tag:    "Di., 06.10.2026"
 *   Woche:  "KW 41 (05.10.–11.10.2026)", angeschnitten "KW 42 – bis 12.10."
 *   Monat:  "Oktober 2026", angeschnitten "Oktober 2026 – bis 12.10."
 * @param {Bucket} bucket
 * @param {Granularity} granularity
 * @param {{t: Function, locale: string}} context
 * @returns {string}
 */
export function bucketLabel(bucket, granularity, { t, locale }) {
  if (granularity === "hour")
    return t("embed-analytics.chart.period.hour", {
      day: formatWeekdayDate(bucket.start, locale),
      from: bucket.hour,
      to: bucket.hour + 1,
    });
  if (granularity === "day") return formatWeekdayDate(bucket.start, locale);

  const { first, last } = calendarSpan(bucket, granularity);
  const period =
    granularity === "week"
      ? t("embed-analytics.chart.period.week", {
          week: isoWeek(bucket.start).week,
        })
      : formatMonth(bucket.start, locale);

  const cutStart = bucket.start !== first;
  const cutEnd = bucket.end !== last;
  if (cutStart && cutEnd)
    return t("embed-analytics.chart.period.partial-between", {
      period,
      start: formatDateShort(bucket.start),
      end: formatDateShort(bucket.end),
    });
  if (cutStart)
    return t("embed-analytics.chart.period.partial-from", {
      period,
      start: formatDateShort(bucket.start),
    });
  if (cutEnd)
    return t("embed-analytics.chart.period.partial-until", {
      period,
      end: formatDateShort(bucket.end),
    });
  if (granularity === "week")
    return t("embed-analytics.chart.period.week-range", {
      period,
      start: formatDateShort(first),
      end: formatDate(last),
    });
  return period;
}

/**
 * Kurze Beschriftung an der Zeitachse.
 * @param {Bucket} bucket
 * @param {Granularity} granularity
 * @param {{t: Function, locale: string}} context
 * @returns {string}
 */
export function bucketTick(bucket, granularity, { t, locale }) {
  if (granularity === "hour")
    return t("embed-analytics.chart.tick.hour", { hour: bucket.hour });
  if (granularity === "day") return formatDateShort(bucket.start);
  if (granularity === "week")
    return t("embed-analytics.chart.period.week", {
      week: isoWeek(bucket.start).week,
    });
  return formatMonth(bucket.start, locale, "short");
}

/**
 * Wert mit Einheit: "37 Nachrichten", "1 Konversation".
 * @param {number} value
 * @param {"messages"|"conversations"} metric
 * @param {Function} t
 * @returns {string}
 */
export function valueLabel(value, metric, t) {
  return t(`embed-analytics.chart.value.${metric}`, {
    count: value,
    formatted: formatNumber(value),
  });
}

// ---------------------------------------------------------------------------
// Zustände und Kennzahlen
// ---------------------------------------------------------------------------

/**
 * Was die Ansicht zeigt, bevor es um ein Widget geht.
 * @param {{embedsLoaded: boolean, embeds: Array}} state
 * @returns {"loading"|"no-widget"|"ready"}
 */
export function viewState({ embedsLoaded, embeds }) {
  if (!embedsLoaded) return "loading";
  return embeds?.length > 0 ? "ready" : "no-widget";
}

/**
 * Was der Diagrammrahmen zeigt.
 *   no-data:      Das Widget hat noch keinen Zählwert.
 *   empty-range:  keine Nachrichten im gewählten Zeitraum.
 *   empty-metric: Nachrichten ja, aber keine begonnene Konversation.
 *   data:         Säulen.
 * @param {Summary|null} summary
 * @param {"messages"|"conversations"} metric
 * @returns {"no-data"|"empty-range"|"empty-metric"|"data"}
 */
export function chartState(summary, metric) {
  if (!summary?.firstLedgerDay) return "no-data";
  if (!(summary.totals?.messages > 0)) return "empty-range";
  if (!(summary.totals?.[metric] > 0)) return "empty-metric";
  return "data";
}

/**
 * Beginnt der Zeitraum vor dem ersten Zählwert, nennt das Diagramm den Tag.
 * @param {Summary|null} summary
 * @returns {string|null} - "YYYY-MM-DD" oder null
 */
export function countsSinceDay(summary) {
  if (!summary?.firstLedgerDay || !summary.fromDay) return null;
  return summary.fromDay < summary.firstLedgerDay
    ? summary.firstLedgerDay
    : null;
}

/**
 * Die vier Kennzahlen mit ihren Nebenwerten.
 * @param {Summary|null} summary
 * @returns {{messages: number, conversations: number, positive: number, negative: number, averagePerBucket: number|null, averagePerConversation: number|null, positiveShare: number|null}}
 */
export function kpiValues(summary) {
  const totals = summary?.totals ?? {};
  const messages = totals.messages ?? 0;
  const conversations = totals.conversations ?? 0;
  const positive = totals.feedbackPositive ?? 0;
  const negative = totals.feedbackNegative ?? 0;
  const bucketCount = summary?.buckets?.length ?? 0;
  const rated = positive + negative;
  return {
    messages,
    conversations,
    positive,
    negative,
    averagePerBucket: bucketCount > 0 ? messages / bucketCount : null,
    averagePerConversation: conversations > 0 ? messages / conversations : null,
    positiveShare: rated > 0 ? Math.round((positive / rated) * 100) : null,
  };
}

/**
 * Zeigt die Liste den Hinweis auf gelöschte Inhalte? Ja, wenn das Widget eine
 * Aufbewahrungsfrist hat und der betrachtete Abschnitt weiter zurückreicht.
 * @param {{retentionDays: number|null, startDay: string|null, today: string}} params
 * @returns {boolean}
 */
export function showsDeletedHint({ retentionDays, startDay, today }) {
  if (!(retentionDays > 0) || !startDay) return false;
  return daysBetween(startDay, today) >= retentionDays;
}

// ---------------------------------------------------------------------------
// Geometrie des Diagramms
// ---------------------------------------------------------------------------

/**
 * Wertachse: ganze, runde Schritte von 0 bis über den größten Wert.
 * @param {number} maxValue
 * @param {number} [intervals]
 * @returns {{max: number, ticks: number[]}}
 */
export function valueScale(maxValue, intervals = 4) {
  const top = Math.max(1, Math.ceil(maxValue || 0));
  const rough = top / intervals;
  const magnitude = 10 ** Math.floor(Math.log10(Math.max(rough, 1)));
  const step =
    [1, 2, 5, 10]
      .map((factor) => factor * magnitude)
      .find((candidate) => candidate >= rough) ?? 10 * magnitude;
  const max = Math.ceil(top / step) * step;
  const ticks = [];
  for (let value = 0; value <= max; value += step) ticks.push(value);
  return { max, ticks };
}

/**
 * Jede wievielte Säule an der Zeitachse beschriftet wird, damit sich die
 * Beschriftungen nicht berühren.
 * @param {number} count - Säulenplätze
 * @param {number} plotWidth - Breite der Zeichenfläche in px
 * @param {number} labelWidth - Platz je Beschriftung in px
 * @returns {number}
 */
export function tickStep(count, plotWidth, labelWidth) {
  if (!(count > 0) || !(plotWidth > 0)) return 1;
  const fitting = Math.max(1, Math.floor(plotWidth / labelWidth));
  const step = Math.ceil(count / fitting);
  // Schritte, die sich lesen lassen (jede 2., jede Woche …)
  return (
    [1, 2, 3, 4, 6, 7, 12, 14, 24, 28].find((nice) => nice >= step) ?? step
  );
}

/**
 * Platz je Beschriftung an der Zeitachse: der übliche, bei langen
 * Beschriftungen (Monat und Jahr, z. B. lettisch "2026. g. sept.") so viel,
 * wie die längste nach ihrer Zeichenzahl braucht.
 * @param {string[]} labels
 * @param {number} minimum - üblicher Platz in px
 * @returns {number}
 */
export function tickLabelWidth(labels, minimum) {
  const longest = Math.max(0, ...labels.map((label) => label.length));
  return Math.max(minimum, longest * TICK_CHAR_WIDTH + 8);
}

/**
 * Säulenplätze und Säulen: Die Zeichenfläche wird gleichmäßig geteilt, die
 * Säule steht mittig auf der Grundlinie und ist höchstens BAR_MAX_WIDTH breit.
 * Ein Platz ohne Wert bekommt keine Säule (bar: null).
 * @param {{values: number[], width: number, height: number, max: number}} params
 * @returns {Array<{x: number, width: number, center: number, bar: {x: number, y: number, width: number, height: number}|null}>}
 */
export function columnLayout({ values, width, height, max }) {
  const slot = values.length > 0 ? width / values.length : 0;
  const barWidth = Math.max(1, Math.min(BAR_MAX_WIDTH, slot * 0.62));
  return values.map((value, i) => {
    const x = i * slot;
    const center = x + slot / 2;
    if (!(value > 0)) return { x, width: slot, center, bar: null };
    // Auch der kleinste Wert bleibt als Säule sichtbar.
    const barHeight = Math.max(2, (value / max) * height);
    return {
      x,
      width: slot,
      center,
      bar: {
        x: center - barWidth / 2,
        y: height - barHeight,
        width: barWidth,
        height: barHeight,
      },
    };
  });
}

/**
 * Pfad einer Säule: oben abgerundet, an der Grundlinie eckig.
 * @param {{x: number, y: number, width: number, height: number}} bar
 * @returns {string}
 */
export function barPath({ x, y, width, height }) {
  const radius = Math.min(BAR_RADIUS, width / 2, height);
  const n = (value) => Math.round(value * 100) / 100;
  return [
    `M${n(x)},${n(y + height)}`,
    `V${n(y + radius)}`,
    `Q${n(x)},${n(y)} ${n(x + radius)},${n(y)}`,
    `H${n(x + width - radius)}`,
    `Q${n(x + width)},${n(y)} ${n(x + width)},${n(y + radius)}`,
    `V${n(y + height)}`,
    "Z",
  ].join(" ");
}

/**
 * Lage des Tooltips im Diagramm. Waagerecht steht er mittig über dem
 * angesteuerten Platz, im linken und rechten Drittel nach innen gerückt – und
 * nie außerhalb des Diagramms: Ragte er hinaus (schmales Diagramm, langer
 * Text), rückt er so weit zurück, dass er am Rand endet; ist er breiter als
 * das Diagramm, nimmt er dessen Breite ein und bricht um.
 * Senkrecht steht er mit seiner Unterkante über der höchsten Säule, die er
 * überspannt – so verdeckt er weder die angesteuerte Säule noch ihre Nachbarn
 * (eine niedrige Säule neben einer hohen), auch nicht mit zwei Zeilen: Er
 * wächst nach oben. Seine Breite ist dafür nach der Zeichenzahl geschätzt.
 * Mit der Linie des Vorzeitraums (KIE-537) gilt dasselbe für sie: Der
 * Tooltip steht auch über jedem Stück der Linie und jeder Punktmarke, die er
 * überspannt.
 * @param {Object} params
 * @param {ReturnType<typeof columnLayout>} params.columns
 * @param {number} params.active - Index des angesteuerten Platzes
 * @param {string} params.text - Text des Tooltips; bei mehreren Zeilen die längste
 * @param {number} params.width - Breite des Diagramms in px
 * @param {number} params.plotLeft - linker Rand der Zeichenfläche im Diagramm
 * @param {number} params.plotHeight - Höhe der Zeichenfläche
 * @param {Array<{x: number, y: number}>|null} [params.line] - Punkte der Linie des Vorzeitraums (linePoints)
 * @returns {{align: "start"|"center"|"end", x: number, y: number, from: number, to: number, maxWidth: number}} -
 *   x: Abstand vom linken Rand (start), Mitte (center) oder Abstand vom
 *   rechten Rand (end); y: Unterkante des Tooltips, ab der Oberkante der
 *   Zeichenfläche; from/to: geschätzte Ausdehnung im Diagramm; maxWidth: so
 *   breit darf er an dieser Stelle höchstens werden, ohne aus dem Diagramm
 *   zu ragen (ein breiterer Text bricht um)
 */
export function tooltipPlacement({
  columns,
  active,
  text,
  width,
  plotLeft,
  plotHeight,
  line = null,
}) {
  const center = plotLeft + columns[active].center;
  const size = Math.min(
    width,
    text.length * TOOLTIP_CHAR_WIDTH + TOOLTIP_PADDING
  );
  // So weit darf der Tooltip vom Rand stehen, an dem er verankert ist, ohne
  // am anderen Rand hinauszuragen.
  const room = width - size;
  let align = "center";
  let x = center;
  if (center < width * 0.3) {
    align = "start";
    x = Math.max(0, Math.min(center - 16, room));
  } else if (center > width * 0.7) {
    align = "end";
    x = Math.max(0, Math.min(width - center - 16, room));
  } else if (center - size / 2 < 0) {
    // Mittig ragte er links hinaus: an den linken Rand …
    align = "start";
    x = 0;
  } else if (center + size / 2 > width) {
    // … oder rechts: an den rechten Rand.
    align = "end";
    x = 0;
  }
  const from = Math.max(
    0,
    align === "start"
      ? x
      : align === "end"
        ? width - x - size
        : center - size / 2
  );
  const to = Math.min(width, from + size);
  const maxWidth = align === "center" ? 2 * Math.min(x, width - x) : width - x;

  let top = columns[active].bar ? columns[active].bar.y : plotHeight;
  for (const { bar } of columns) {
    if (!bar) continue;
    const left = plotLeft + bar.x;
    if (left < to && left + bar.width > from) top = Math.min(top, bar.y);
  }
  if (line?.length > 0)
    top = Math.min(top, lineTop(line, from - plotLeft, to - plotLeft));
  return { align, x, y: top - TOOLTIP_GAP, from, to, maxWidth };
}

/**
 * Höchste Stelle (kleinstes y) der Linie des Vorzeitraums zwischen left und
 * right: Punktmarken, die in den Bereich ragen, und die geraden Stücke der
 * Linie, soweit sie durch ihn laufen.
 * @param {Array<{x: number, y: number}>} points
 * @param {number} left
 * @param {number} right
 * @returns {number} - Infinity, wenn dort nichts von der Linie liegt
 */
function lineTop(points, left, right) {
  const { markerRadius, width } = PREVIOUS_LINE;
  let top = Infinity;
  for (const [i, point] of points.entries()) {
    if (point.x + markerRadius > left && point.x - markerRadius < right)
      top = Math.min(top, point.y - markerRadius);
    const next = points[i + 1];
    if (!next || next.x <= left || point.x >= right) continue;
    // Das Stück bis zum nächsten Punkt, auf den Bereich beschnitten: Eine
    // Gerade ist an einem der beiden Enden am höchsten.
    const yAt = (x) =>
      point.y + ((next.y - point.y) * (x - point.x)) / (next.x - point.x);
    top = Math.min(
      top,
      yAt(Math.max(point.x, left)) - width / 2,
      yAt(Math.min(next.x, right)) - width / 2
    );
  }
  return top;
}

// ---------------------------------------------------------------------------
// Vergleich mit dem Vorzeitraum (KIE-537)
// ---------------------------------------------------------------------------

/**
 * Was vom Vorzeitraum zu zeigen ist.
 *   null:             Der Vergleich ist aus – oder die Antwort nennt (noch)
 *                     keinen Vorzeitraum, weil sie ohne Vergleich geladen ist.
 *   available false:  Es gibt keinen Vergleich: keine Linie, keine
 *                     Prozentzahl. since ist der erste Tag mit Zählwerten
 *                     (null ohne Zählwerte).
 *   available true:   totals und fromDay/toDay für die Kennzahlen; buckets
 *                     für die Linie – je Säule ein Abschnitt, von lineFromDay
 *                     bis lineToDay (bei Wochen und Monaten andere Tage als
 *                     die der Kennzahlen).
 * Als nicht verfügbar gilt auch eine Antwort, deren Linie nicht zu den Säulen
 * passt: Gezeichnet wird nur, was an derselben Stelle steht.
 * @param {Summary|null} summary
 * @param {boolean} compare - Schalter „Vorzeitraum vergleichen"
 * @returns {null|{available: false, since: string|null}|{available: true, fromDay: string, toDay: string, lineFromDay: string, lineToDay: string, totals: Summary["totals"], buckets: Bucket[]}}
 */
export function comparisonOf(summary, compare) {
  const previous = compare ? summary?.previous : null;
  if (!previous) return null;
  const buckets = Array.isArray(previous.buckets) ? previous.buckets : [];
  const usable =
    previous.available === true &&
    !!previous.totals &&
    !!previous.fromDay &&
    !!previous.toDay &&
    buckets.length > 0 &&
    buckets.length === summary.buckets?.length;
  if (!usable)
    return { available: false, since: summary.firstLedgerDay ?? null };
  return {
    available: true,
    fromDay: previous.fromDay,
    toDay: previous.toDay,
    lineFromDay: buckets[0].start,
    lineToDay: buckets[buckets.length - 1].end,
    totals: previous.totals,
    buckets,
  };
}

/**
 * Veränderung gegenüber dem Vorzeitraum in ganzen Prozent, kaufmännisch
 * gerundet (421 gegenüber 266: +58). Ohne Wert im Vorzeitraum gibt es keine
 * Prozentzahl – auch nicht, wenn beide Werte 0 sind.
 * @param {number} current
 * @param {number} previous
 * @returns {number|null} - z. B. 58, -100, 0; null bei einem Vorzeitraumwert von 0
 */
export function percentChange(current, previous) {
  if (!(previous > 0)) return null;
  const change = (((current || 0) - previous) * 100) / previous;
  // || 0: nie -0
  return Math.sign(change) * Math.round(Math.abs(change)) || 0;
}

/**
 * Prozentzahl mit Vorzeichen in deutscher Schreibweise: "+58", "−12" (mit
 * Minuszeichen, nicht Bindestrich), "±0", "+1.150".
 * @param {number} percent
 * @returns {string}
 */
export function formatPercentChange(percent) {
  const sign = percent > 0 ? "+" : percent < 0 ? "−" : "±";
  return `${sign}${formatNumber(Math.abs(percent))}`;
}

/**
 * Zeile der Veränderung in einem Kennzahl-Feld:
 * "+58 % ggü. Vorzeitraum (266)"; bei einem Vorzeitraumwert von 0
 * "Vorzeitraum: 0" ohne Prozentzahl.
 * @param {number} current
 * @param {number} previous
 * @param {Function} t
 * @returns {string}
 */
export function changeLabel(current, previous, t) {
  const percent = percentChange(current, previous);
  if (percent === null) return previousValueLabel(previous, t);
  return t("embed-analytics.compare.change", {
    change: formatPercentChange(percent),
    previous: formatNumber(previous),
  });
}

/**
 * Wert des Vorzeitraums ohne Abschnitt, wie er im Kennzahl-Feld steht, wenn
 * es keine Prozentzahl gibt: "Vorzeitraum: 0".
 * @param {number} value
 * @param {Function} t
 * @returns {string}
 */
export function previousValueLabel(value, t) {
  return t("embed-analytics.compare.previous-value", {
    value: formatNumber(value),
  });
}

/**
 * Zweite Zeile im Tooltip des Diagramms: der Abschnitt des Vorzeitraums, der
 * an der Stelle der Säule steht, und sein Wert – der Abschnitt in derselben
 * Schreibweise wie in der ersten Zeile (bucketLabel), damit zu lesen ist,
 * wozu die Zahl gehört:
 *   Tag:    "Vorzeitraum: Fr., 09.10.2026 — 12 Nachrichten"
 *   Stunde: "Vorzeitraum: So., 11.10.2026, 10–11 Uhr — 3 Nachrichten"
 *   Woche:  "Vorzeitraum: KW 37 (07.09.–13.09.2026) — 12 Nachrichten"
 *   Monat:  "Vorzeitraum: September 2026 — 12 Nachrichten"
 * @param {Bucket} bucket - Abschnitt des Vorzeitraums
 * @param {"messages"|"conversations"} metric
 * @param {Granularity} granularity
 * @param {{t: Function, locale: string}} context
 * @returns {string}
 */
export function previousBucketLabel(bucket, metric, granularity, context) {
  return context.t("embed-analytics.compare.previous-bucket", {
    period: bucketLabel(bucket, granularity, context),
    value: valueLabel(bucket[metric] ?? 0, metric, context.t),
  });
}

/**
 * Bereich aus zwei Kalendertagen: "14.08.2026–12.09.2026", ein einzelner Tag
 * "11.10.2026".
 * @param {string} fromDay
 * @param {string} toDay
 * @param {Function} t
 * @returns {string}
 */
export function formatDayRange(fromDay, toDay, t) {
  if (fromDay === toDay) return formatDate(fromDay);
  return t("embed-analytics.compare.range", {
    from: formatDate(fromDay),
    to: formatDate(toDay),
  });
}

/**
 * Punkte der Linie des Vorzeitraums: je Säulenplatz ein Punkt über dessen
 * Mitte, in der Höhe des Werts – nie unter der Grundlinie und nie über der
 * Zeichenfläche. Zwischen den Punkten verläuft die Linie gerade (linePath).
 * @param {{values: number[], columns: ReturnType<typeof columnLayout>, height: number, max: number}} params
 * @returns {Array<{x: number, y: number}>}
 */
export function linePoints({ values, columns, height, max }) {
  return columns.map((column, i) => {
    const value = Math.min(max, Math.max(0, values[i] || 0));
    return { x: column.center, y: height - (value / max) * height };
  });
}

/**
 * Pfad der Linie: gerade Stücke von Punkt zu Punkt (M … L …), keine Kurven –
 * zwischen zwei Werten liegt die Linie nie über dem höheren und nie unter dem
 * niedrigeren.
 * @param {Array<{x: number, y: number}>} points
 * @returns {string}
 */
export function linePath(points) {
  const n = (value) => Math.round(value * 100) / 100;
  return points
    .map(({ x, y }, i) => `${i === 0 ? "M" : "L"}${n(x)},${n(y)}`)
    .join(" ");
}
