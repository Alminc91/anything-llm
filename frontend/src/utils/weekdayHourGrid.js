// Karte „Wann schreiben Ihre Besucher?" (KIE-539): Zustände, Aussagen,
// Farbstufen und Geometrie des Rasters Wochentag × Stunde – ohne React, damit
// sich alles ohne Browser prüfen lässt
// (frontend/__tests__/weekdayHourGrid.test.mjs).
//
// Das Raster kommt fertig vom Server (analytics/summary, Feld weekdayHour):
// 7 Zeilen, Montag bis Sonntag, mit je 24 Feldern für die Berliner Stunden
// 0–23. Hier wird nichts mehr in Zeitzonen umgerechnet.
//
// Wochentagsnamen kommen über Intl in der Sprache der Oberfläche, immer im
// gregorianischen Kalender. Stundenangaben stehen wie im Diagramm darüber in
// den Sprachdateien („10–11 Uhr"): Intl schreibt sie je nach Sprache und
// Browser anders („08–17 Uhr") und kennt keine Stunde 23–24.
import {
  daysBetween,
  tooltipPlacement,
  valueLabel,
} from "./analyticsTimeline.js";

export const WEEKDAYS = 7;
export const HOURS = 24;

// Ein Muster aus wenigen Tagen oder wenigen Nachrichten ist Zufall: Raster und
// Aussagen gibt es erst ab so vielen Tagen UND so vielen Nachrichten im
// Zeitraum (Hard Constraint 8).
export const MIN_PERIOD_DAYS = 28;
export const MIN_MESSAGES = 200;

// Kernzeit der zweiten Aussage – in KIE-539 fest: Montag bis Freitag, 8:00 bis
// 16:59 Uhr (toHour ist die erste Stunde danach). Feiertage zählen als
// normale Wochentage. Die Beschriftung der Aussage entsteht aus diesen Werten.
export const CORE_TIME = {
  fromWeekday: 0,
  toWeekday: 4,
  fromHour: 8,
  toHour: 17,
};

// Fünf Stufen einer Farbe, dazu die Stufe 0 als eigene, neutrale Fläche
// (--theme-analytics-heat-0 … -5 in index.css). Die Fläche der Stufe 0 hebt
// sich von der Karte kaum ab; sie hat deshalb eine Kontur (emptyOutlineBox).
export const HEAT_LEVELS = 5;

// Geometrie des Rasters (px): Zeilenhöhe und kleinste Feldbreite jeweils samt
// Lücke; darunter die Stundenachse, beschriftet alle drei Stunden.
export const ROW_HEIGHT = 28;
export const MIN_CELL_WIDTH = 24;
export const CELL_GAP = 2;
export const AXIS_HEIGHT = 22;
export const HOUR_TICK_STEP = 3;
// Kontur der Felder ohne Nachricht (--theme-analytics-empty-outline): ein
// Strich innen an der Fläche des Feldes.
export const EMPTY_OUTLINE_WIDTH = 1;
// Mittlere Zeichenbreite der Wochentage am Rand (12 px Schrift)
const LABEL_CHAR_WIDTH = 7;
const LABEL_MIN_WIDTH = 28;
const LABEL_PADDING = 10;

/** @typedef {{weekday: number, hour: number}} Slot - Wochentag 0 = Montag … 6 = Sonntag, Stunde 0–23 */

// ---------------------------------------------------------------------------
// Raster und Zustände
// ---------------------------------------------------------------------------

/**
 * Das Raster einer Antwort von analytics/summary – oder null, wenn die Antwort
 * keines enthält (ein Server vor KIE-539) oder es nicht 7 × 24 ganze Zahlen
 * ab 0 sind. Mit einem Raster, dem etwas fehlt, zeigte die Karte ein falsches
 * Muster; dann lieber keine Karte.
 * @param {{weekdayHour?: number[][]}|null} summary
 * @returns {number[][]|null}
 */
export function weekdayHourGrid(summary) {
  const grid = summary?.weekdayHour;
  if (!Array.isArray(grid) || grid.length !== WEEKDAYS) return null;
  for (const row of grid) {
    if (!Array.isArray(row) || row.length !== HOURS) return null;
    if (!row.every((value) => Number.isInteger(value) && value >= 0))
      return null;
  }
  return grid;
}

/** Summe aller Felder – die Kennzahl „Nachrichten" des Zeitraums. */
export function gridTotal(grid) {
  return grid.reduce(
    (total, row) => total + row.reduce((sum, value) => sum + value, 0),
    0
  );
}

/** Summen der sieben Zeilen (je Wochentag). */
export function rowTotals(grid) {
  return grid.map((row) => row.reduce((sum, value) => sum + value, 0));
}

/** Summen der 24 Spalten (je Stunde). */
export function columnTotals(grid) {
  return Array.from({ length: HOURS }, (_, hour) =>
    grid.reduce((sum, row) => sum + row[hour], 0)
  );
}

/**
 * Tage des Zeitraums, beide Grenzen einschließlich.
 * @param {{fromDay?: string, toDay?: string}|null} summary
 * @returns {number}
 */
export function periodDays(summary) {
  if (!summary?.fromDay || !summary?.toDay) return 0;
  return daysBetween(summary.fromDay, summary.toDay) + 1;
}

/**
 * Was die Karte zeigt.
 *   unavailable:  Die Antwort enthält kein Raster – keine Karte.
 *   empty:        keine Nachrichten im gewählten Zeitraum.
 *   short-range:  Der Zeitraum hat weniger als MIN_PERIOD_DAYS Tage.
 *   few-messages: Der Zeitraum hat weniger als MIN_MESSAGES Nachrichten.
 *   data:         Aussagen und Raster.
 * Ein leerer Zeitraum ist zuerst leer – auch ein kurzer: Dann hülfe ein
 * längerer nicht weiter.
 * @param {object|null} summary - Antwort von analytics/summary
 * @returns {"unavailable"|"empty"|"short-range"|"few-messages"|"data"}
 */
export function heatmapState(summary) {
  const grid = weekdayHourGrid(summary);
  if (!grid) return "unavailable";
  const total = gridTotal(grid);
  if (total === 0) return "empty";
  if (periodDays(summary) < MIN_PERIOD_DAYS) return "short-range";
  if (total < MIN_MESSAGES) return "few-messages";
  return "data";
}

// ---------------------------------------------------------------------------
// Aussagen
// ---------------------------------------------------------------------------

/**
 * Das Feld mit dem Höchstwert – der stärkste Zeitabschnitt. Teilen sich
 * mehrere Felder den Höchstwert, gilt das erste in Leserichtung (Montag vor
 * Dienstag, früh vor spät); die übrigen nennt peakTies.
 * @param {number[][]} grid
 * @returns {(Slot & {messages: number})|null} - null ohne Nachrichten
 */
export function peakCell(grid) {
  let peak = null;
  grid.forEach((row, weekday) =>
    row.forEach((messages, hour) => {
      if (messages > (peak?.messages ?? 0)) peak = { weekday, hour, messages };
    })
  );
  return peak;
}

/**
 * Die weiteren Felder mit dem Höchstwert, in Leserichtung – ohne das Feld, das
 * peakCell nennt. Leer, wenn der Höchstwert nur einmal vorkommt.
 * @param {number[][]} grid
 * @returns {Slot[]}
 */
export function peakTies(grid) {
  const peak = peakCell(grid);
  if (!peak) return [];
  const ties = [];
  grid.forEach((row, weekday) =>
    row.forEach((messages, hour) => {
      if (messages !== peak.messages) return;
      if (weekday === peak.weekday && hour === peak.hour) return;
      ties.push({ weekday, hour });
    })
  );
  return ties;
}

/** Liegt das Feld in der Kernzeit (Montag–Freitag, 8–17 Uhr)? */
export function isCoreTime(weekday, hour) {
  return (
    weekday >= CORE_TIME.fromWeekday &&
    weekday <= CORE_TIME.toWeekday &&
    hour >= CORE_TIME.fromHour &&
    hour < CORE_TIME.toHour
  );
}

/**
 * Anteil der Nachrichten außerhalb der Kernzeit, in ganzen Prozent.
 * @param {number[][]} grid
 * @returns {{total: number, inside: number, outside: number, percent: number}|null} - null ohne Nachrichten
 */
export function outsideCoreShare(grid) {
  let total = 0;
  let inside = 0;
  grid.forEach((row, weekday) =>
    row.forEach((messages, hour) => {
      total += messages;
      if (isCoreTime(weekday, hour)) inside += messages;
    })
  );
  if (total === 0) return null;
  const outside = total - inside;
  return {
    total,
    inside,
    outside,
    percent: Math.round((outside / total) * 100),
  };
}

// ---------------------------------------------------------------------------
// Farbstufen
// ---------------------------------------------------------------------------

/**
 * Stufe eines Feldes: 0 für kein einziges, sonst 1 bis HEAT_LEVELS nach gleich
 * breiten Klassen des Höchstwerts (bei 15: 1–3, 4–6, 7–9, 10–12, 13–15).
 *
 * Gleich breite Klassen statt Quantilen: Die Stufe sagt, wie nah ein Feld am
 * stärksten Feld liegt – doppelt so viele Nachrichten sind nie dieselbe und
 * nie eine um vier Stufen dunklere Farbe. Quantile verteilten die Farben
 * gleichmäßig auf die Felder; bei den vielen kleinen, oft gleichen Werten
 * eines solchen Rasters fielen ihre Grenzen mitten in gleiche Werte, und ein
 * Unterschied von einer Nachricht sähe aus wie einer von fünfzig. Die
 * Bereiche der Legende sind so lückenlos, gleich breit und ohne Rechnen zu
 * lesen. Das Feld mit dem Höchstwert hat immer die stärkste Stufe.
 * @param {number} value
 * @param {number} max - Höchstwert des Rasters
 * @returns {number} - 0 … HEAT_LEVELS
 */
export function heatLevel(value, max) {
  if (!(value > 0) || !(max > 0)) return 0;
  // Ganze Zahlen: value * HEAT_LEVELS ist genau, die Grenzen sind es auch.
  return Math.min(HEAT_LEVELS, Math.ceil((value * HEAT_LEVELS) / max));
}

/**
 * Die sechs Stufen der Legende mit ihren Wertebereichen (ganze Nachrichten).
 * Unter einem Höchstwert von HEAT_LEVELS bleiben Stufen ohne Wert (from und
 * to null) – bei höchstens 3 Nachrichten je Feld gibt es keine fünf Bereiche.
 * @param {number} max - Höchstwert des Rasters
 * @returns {Array<{level: number, from: number|null, to: number|null}>}
 */
export function heatLegend(max) {
  const top = max > 0 ? max : 0;
  const steps = [{ level: 0, from: 0, to: 0 }];
  for (let level = 1; level <= HEAT_LEVELS; level++) {
    const from = Math.floor(((level - 1) * top) / HEAT_LEVELS) + 1;
    const to = Math.floor((level * top) / HEAT_LEVELS);
    steps.push(
      from <= to ? { level, from, to } : { level, from: null, to: null }
    );
  }
  return steps;
}

// ---------------------------------------------------------------------------
// Beschriftungen
// ---------------------------------------------------------------------------

const weekdayFormatters = new Map();
// 01.01.2024 war ein Montag.
const MONDAY = Date.UTC(2024, 0, 1);

/**
 * Name eines Wochentags in der Sprache der Oberfläche ("Dienstag", kurz
 * "Di"). Der Kalender ist fest gregorianisch.
 * @param {number} weekday - 0 = Montag … 6 = Sonntag
 * @param {string} locale
 * @param {"long"|"short"} [width]
 * @returns {string}
 */
export function weekdayName(weekday, locale, width = "long") {
  const key = `${locale}|${width}`;
  if (!weekdayFormatters.has(key)) {
    const options = { weekday: width, calendar: "gregory", timeZone: "UTC" };
    let formatter;
    try {
      formatter = new Intl.DateTimeFormat(locale, options);
    } catch {
      formatter = new Intl.DateTimeFormat("de-DE", options);
    }
    weekdayFormatters.set(key, formatter);
  }
  return weekdayFormatters
    .get(key)
    .format(new Date(MONDAY + weekday * 24 * 60 * 60 * 1000));
}

/**
 * "10–11 Uhr" – die Stunden von from bis vor to.
 * @param {number} from
 * @param {number} to
 * @param {Function} t
 * @returns {string}
 */
export function hoursLabel(from, to, t) {
  return t("embed-analytics.weekday-hour.hours", { from, to });
}

/**
 * Ausgeschriebener Name eines Feldes: "Dienstag, 10–11 Uhr".
 * @param {Slot} slot
 * @param {{t: Function, locale: string}} context
 * @returns {string}
 */
export function slotLabel({ weekday, hour }, { t, locale }) {
  return t("embed-analytics.weekday-hour.slot", {
    weekday: weekdayName(weekday, locale),
    hours: hoursLabel(hour, hour + 1, t),
  });
}

/**
 * Nebenzeile der ersten Aussage: die Anzahl im stärksten Zeitabschnitt – und,
 * wenn weitere Felder denselben Höchstwert haben, dass es so ist. Die Aussage
 * nennt weiter das erste Feld in Leserichtung (peakCell); ohne den Hinweis
 * sähe es aus, als läge es allein vorn.
 *   "16 Nachrichten"
 *   "16 Nachrichten · gleichauf mit Donnerstag, 10–11 Uhr"
 *   "16 Nachrichten · gleichauf mit 2 weiteren Zeitabschnitten"
 * @param {number[][]} grid
 * @param {{t: Function, locale: string}} context
 * @returns {string|null} - null ohne Nachrichten
 */
export function peakNote(grid, context) {
  const peak = peakCell(grid);
  if (!peak) return null;
  const { t } = context;
  const value = valueLabel(peak.messages, "messages", t);
  const ties = peakTies(grid);
  if (ties.length === 0) return value;
  if (ties.length === 1)
    return t("embed-analytics.weekday-hour.peak.tie-slot", {
      value,
      slot: slotLabel(ties[0], context),
    });
  return t("embed-analytics.weekday-hour.peak.tie-count", {
    value,
    count: ties.length,
  });
}

/**
 * Beschriftung der zweiten Aussage, aus CORE_TIME: "Außerhalb von
 * Montag–Freitag, 8–17 Uhr". Sie nennt die feste Grenze wörtlich – über
 * Geschäftszeiten des Kunden sagt die Karte nichts.
 * @param {{t: Function, locale: string}} context
 * @returns {string}
 */
export function outsideCoreLabel({ t, locale }) {
  return t("embed-analytics.weekday-hour.outside.label", {
    from: weekdayName(CORE_TIME.fromWeekday, locale),
    to: weekdayName(CORE_TIME.toWeekday, locale),
    hours: hoursLabel(CORE_TIME.fromHour, CORE_TIME.toHour, t),
  });
}

// ---------------------------------------------------------------------------
// Geometrie des Rasters
// ---------------------------------------------------------------------------

/**
 * Platz für die Wochentage links vom Raster, nach der längsten Beschriftung.
 * @param {string[]} labels
 * @returns {number} - px
 */
export function rowLabelWidth(labels) {
  const longest = Math.max(0, ...labels.map((label) => label.length));
  return Math.max(LABEL_MIN_WIDTH, longest * LABEL_CHAR_WIDTH + LABEL_PADDING);
}

/**
 * Lage der Felder. Die Wochentage stehen links fest, die 24 Spalten teilen
 * sich den Rest der Breite – aber kein Feld wird schmaler als MIN_CELL_WIDTH:
 * In einer schmalen Karte ist das Raster breiter als sein sichtbarer Bereich
 * und lässt sich darin waagerecht schieben (scrolls), die Seite nicht.
 * @param {{width: number, labelWidth: number}} params - Breite der Karte innen, Platz der Wochentage
 * @returns {{labelWidth: number, visibleWidth: number, plotWidth: number, slot: number, height: number, scrolls: boolean}}
 */
export function gridLayout({ width, labelWidth }) {
  const visibleWidth = Math.max(0, width - labelWidth);
  const plotWidth = Math.max(visibleWidth, HOURS * MIN_CELL_WIDTH);
  return {
    labelWidth,
    visibleWidth,
    plotWidth,
    slot: plotWidth / HOURS,
    height: WEEKDAYS * ROW_HEIGHT,
    scrolls: plotWidth > visibleWidth,
  };
}

/**
 * Platz und gezeichnete Fläche eines Feldes im Raster. Der Platz reicht bis
 * an die Nachbarn (Trefferfläche), die Fläche lässt ringsum die halbe Lücke.
 * @param {ReturnType<typeof gridLayout>} layout
 * @param {Slot} slot
 * @returns {{x: number, y: number, width: number, height: number, center: number, tile: {x: number, y: number, width: number, height: number}}}
 */
export function cellBox(layout, { weekday, hour }) {
  const x = hour * layout.slot;
  const y = weekday * ROW_HEIGHT;
  return {
    x,
    y,
    width: layout.slot,
    height: ROW_HEIGHT,
    center: x + layout.slot / 2,
    tile: {
      x: x + CELL_GAP / 2,
      y: y + CELL_GAP / 2,
      width: layout.slot - CELL_GAP,
      height: ROW_HEIGHT - CELL_GAP,
    },
  };
}

/**
 * Lage der Kontur eines Feldes ohne Nachricht: ein Strich von
 * EMPTY_OUTLINE_WIDTH innen an der Fläche des Feldes (tile aus cellBox) – nie
 * in der Lücke zum Nachbarn. Die Fläche liegt selten auf ganzen Pixeln (die
 * Breite der Karte teilt sich nicht glatt durch 24); der Strich schon, damit
 * er als eine scharfe Linie zu sehen ist statt blass über zwei Pixel. Er
 * rückt dafür um weniger als einen Pixel nach innen.
 * @param {{x: number, y: number, width: number, height: number}} tile
 * @returns {{x: number, y: number, width: number, height: number}} - Mittellinie des Strichs
 */
export function emptyOutlineBox(tile) {
  const half = EMPTY_OUTLINE_WIDTH / 2;
  const left = Math.ceil(tile.x);
  const top = Math.ceil(tile.y);
  const right = Math.floor(tile.x + tile.width);
  const bottom = Math.floor(tile.y + tile.height);
  return {
    x: left + half,
    y: top + half,
    width: right - left - EMPTY_OUTLINE_WIDTH,
    height: bottom - top - EMPTY_OUTLINE_WIDTH,
  };
}

/**
 * Lage des Tooltips in der Karte (Maße ab der linken oberen Ecke des Rasters
 * samt Wochentagen). Er steht mit seiner Unterkante über der Zeile des
 * angesteuerten Feldes und verdeckt es deshalb nie; waagerecht bleibt er wie
 * im Säulendiagramm in der Karte (tooltipPlacement). Ist das Raster
 * verschoben (scrollLeft), zählt die Stelle, an der das Feld zu sehen ist –
 * höchstens der Rand des sichtbaren Bereichs.
 * @param {Object} params
 * @param {ReturnType<typeof gridLayout>} params.layout
 * @param {Slot} params.slot
 * @param {number} params.scrollLeft - um so viel ist das Raster nach links geschoben
 * @param {string} params.text - Text des Tooltips
 * @returns {ReturnType<typeof tooltipPlacement>}
 */
export function cellTooltipPlacement({ layout, slot, scrollLeft, text }) {
  const box = cellBox(layout, slot);
  const seen = Math.max(
    0,
    Math.min(layout.visibleWidth, box.center - scrollLeft)
  );
  return tooltipPlacement({
    columns: [{ center: layout.labelWidth + seen, bar: null }],
    active: 0,
    text,
    width: layout.labelWidth + layout.visibleWidth,
    plotLeft: 0,
    plotHeight: box.y,
  });
}
