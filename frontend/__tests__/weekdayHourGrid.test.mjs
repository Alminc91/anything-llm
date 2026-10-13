// KIE-539: Karte „Wann schreiben Ihre Besucher?" – Zustände, Aussagen,
// Farbstufen und Geometrie des Rasters Wochentag × Stunde, die Logik ohne
// React (src/utils/weekdayHourGrid.js), geprüft mit den Texten der
// Sprachdateien und den Farbwerten beider Themes in index.css.
//
// Die Raster sind dieselben, die der Server-Test über die echte Route
// erzeugt (server/__tests__/endpoints/support/weekdayHourScenarios.js).
// Die Zeitzone des Prozesses wird nicht gesetzt (nodeTests.test.js läuft in
// TZ=UTC, Europe/Berlin und America/New_York).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import de from "../src/locales/de/common.js";
import en from "../src/locales/en/common.js";
import scenarios from "../../server/__tests__/endpoints/support/weekdayHourScenarios.js";
import { TOOLTIP_GAP, valueLabel } from "../src/utils/analyticsTimeline.js";
import {
  AXIS_HEIGHT,
  CELL_GAP,
  CORE_TIME,
  HEAT_LEVELS,
  HOURS,
  MIN_CELL_WIDTH,
  MIN_MESSAGES,
  MIN_PERIOD_DAYS,
  ROW_HEIGHT,
  WEEKDAYS,
  cellBox,
  cellTooltipPlacement,
  columnTotals,
  gridLayout,
  gridTotal,
  heatLegend,
  heatLevel,
  heatmapState,
  hoursLabel,
  isCoreTime,
  outsideCoreLabel,
  outsideCoreShare,
  peakCell,
  peakNote,
  peakTies,
  periodDays,
  rowLabelWidth,
  rowTotals,
  slotLabel,
  weekdayHourGrid,
  weekdayName,
} from "../src/utils/weekdayHourGrid.js";

const { PERIOD, DISTRIBUTION, CORE_TIME_WEEK, DST, addDays, gridOf } =
  scenarios;

/** t() über einer Sprachdatei: Punktpfade, {{Platzhalter}}, _one/_other. */
function translator(resources) {
  const lookup = (key) =>
    key.split(".").reduce((node, part) => node?.[part], resources);
  return (key, params = {}) => {
    let text = lookup(key);
    if (text === undefined && "count" in params)
      text = lookup(`${key}_${params.count === 1 ? "one" : "other"}`);
    assert.equal(typeof text, "string", `Text fehlt: ${key}`);
    return text.replace(/{{(\w+)}}/g, (_match, name) => String(params[name]));
  };
}
const t = translator(de);
const context = { t, locale: "de" };
const english = { t: translator(en), locale: "en" };

const emptyGrid = () => gridOf([]);
/** Antwort von analytics/summary zu einem Raster. */
const summaryOf = (grid, { fromDay, toDay } = PERIOD) => ({
  success: true,
  fromDay,
  toDay,
  firstLedgerDay: "2026-01-01",
  totals: { messages: gridTotal(grid) },
  weekdayHour: grid,
});
/** Ein Raster mit total Nachrichten, verteilt auf die Werktage 9–16 Uhr. */
function gridWith(total) {
  const grid = emptyGrid();
  for (let i = 0; i < total; i++) grid[i % 5][9 + (i % 8)] += 1;
  return grid;
}

// ---------------------------------------------------------------------------
// Raster der Antwort
// ---------------------------------------------------------------------------

test("Raster: 7 Zeilen (Montag bis Sonntag) mit je 24 Feldern – so, wie der Server es liefert", () => {
  const grid = weekdayHourGrid(summaryOf(gridOf(DISTRIBUTION.cells)));
  assert.equal(grid.length, WEEKDAYS);
  assert.deepEqual(
    grid.map((row) => row.length),
    Array(7).fill(HOURS)
  );
  assert.equal(gridTotal(grid), DISTRIBUTION.total);
  assert.equal(
    rowTotals(grid).reduce((a, b) => a + b),
    DISTRIBUTION.total
  );
  assert.equal(
    columnTotals(grid).reduce((a, b) => a + b),
    DISTRIBUTION.total
  );
  assert.equal(rowTotals(grid).length, 7);
  assert.equal(columnTotals(grid).length, 24);
  // nachts schreibt in diesem Bestand niemand
  assert.deepEqual(columnTotals(grid).slice(0, 8), Array(8).fill(0));
  assert.deepEqual(columnTotals(grid).slice(20), Array(4).fill(0));
});

test("Raster: Eine Antwort ohne oder mit unvollständigem Raster gilt als „kein Raster“ – nie ein halbes Muster", () => {
  const good = gridOf(DISTRIBUTION.cells);
  const broken = [
    undefined,
    null,
    "raster",
    {},
    [],
    good.slice(0, 6),
    [...good, good[0]],
    good.map((row) => row.slice(0, 23)),
    good.map((row, i) => (i === 3 ? [...row, 1] : row)),
    good.map((row, i) => (i === 3 ? null : row)),
    good.map((row, i) =>
      i === 2 ? row.map((v, h) => (h === 5 ? -1 : v)) : row
    ),
    good.map((row, i) =>
      i === 2 ? row.map((v, h) => (h === 5 ? 1.5 : v)) : row
    ),
    good.map((row, i) =>
      i === 2 ? row.map((v, h) => (h === 5 ? "3" : v)) : row
    ),
    good.map((row, i) =>
      i === 2 ? row.map((v, h) => (h === 5 ? null : v)) : row
    ),
  ];
  for (const weekdayHour of broken) {
    const summary = { ...summaryOf(good), weekdayHour };
    assert.equal(weekdayHourGrid(summary), null, JSON.stringify(weekdayHour));
    assert.equal(heatmapState(summary), "unavailable");
  }
  assert.equal(weekdayHourGrid(null), null);
  assert.equal(heatmapState(null), "unavailable");
  assert.equal(weekdayHourGrid(summaryOf(good)), good);
});

// ---------------------------------------------------------------------------
// Schwellen (Hard Constraint 8, AK-7) und Leerzustand (AK-8)
// ---------------------------------------------------------------------------

test("Schwellen (AK-7): Raster und Aussagen erst ab 28 Tagen UND 200 Nachrichten im Zeitraum", () => {
  assert.equal(MIN_PERIOD_DAYS, 28);
  assert.equal(MIN_MESSAGES, 200);

  const days = (count) => ({
    fromDay: addDays("2026-10-12", -(count - 1)),
    toDay: "2026-10-12",
  });
  assert.equal(periodDays(days(28)), 28);
  assert.equal(periodDays(days(1)), 1);
  assert.equal(periodDays(PERIOD), 30);
  assert.equal(periodDays(null), 0);

  // (a) weniger als 28 Tage – auch mit sehr vielen Nachrichten
  for (const count of [1, 7, 27])
    assert.equal(
      heatmapState(summaryOf(gridWith(5000), days(count))),
      "short-range",
      `${count} Tage`
    );
  // (b) 30 Tage mit 150 Nachrichten
  assert.equal(heatmapState(summaryOf(gridWith(150))), "few-messages");
  assert.equal(heatmapState(summaryOf(gridWith(199))), "few-messages");
  // genau an der Schwelle: 28 Tage und 200 Nachrichten
  assert.equal(heatmapState(summaryOf(gridWith(200), days(28))), "data");
  assert.equal(
    heatmapState(summaryOf(gridWith(199), days(28))),
    "few-messages"
  );
  assert.equal(heatmapState(summaryOf(gridWith(200), days(27))), "short-range");
  // lange Zeiträume
  assert.equal(
    heatmapState(
      summaryOf(gridWith(200), { fromDay: "2019-03-01", toDay: "2026-10-12" })
    ),
    "data"
  );
  // zu kurz UND zu wenige: Zuerst fehlt der Zeitraum.
  assert.equal(heatmapState(summaryOf(gridWith(3), days(7))), "short-range");
});

test("Leerzustand (AK-8): ohne Nachrichten „leer“ – in jedem Zeitraum, auch in einem kurzen", () => {
  for (const range of [
    PERIOD,
    { fromDay: "2026-10-06", toDay: "2026-10-06" },
    { fromDay: "2019-03-01", toDay: "2026-10-12" },
  ])
    assert.equal(heatmapState(summaryOf(emptyGrid(), range)), "empty");
  // Ein Widget ganz ohne Zählwerte ist ebenfalls leer.
  assert.equal(
    heatmapState({ ...summaryOf(emptyGrid()), firstLedgerDay: null }),
    "empty"
  );
});

test("Schwellen: Die Hinweise nennen die Schwellen aus den Konstanten – wörtlich wie im Issue", () => {
  assert.equal(
    t("embed-analytics.weekday-hour.hint.short-range", {
      days: MIN_PERIOD_DAYS,
    }),
    "Für diese Ansicht bitte mindestens 28 Tage wählen"
  );
  assert.equal(
    t("embed-analytics.weekday-hour.hint.few-messages", {
      messages: MIN_MESSAGES,
    }),
    "Zu wenige Nachrichten für ein verlässliches Muster (mindestens 200)"
  );
  assert.equal(
    t("embed-analytics.chart.empty.range"),
    "Keine Nachrichten im gewählten Zeitraum"
  );
});

// ---------------------------------------------------------------------------
// Aussagen (AK-3, AK-4, NAK-3)
// ---------------------------------------------------------------------------

test("staerkster_zeitabschnitt (AK-3): Höchstwert dienstags zwischen 10 und 11 Uhr – „Dienstag, 10–11 Uhr“", () => {
  const grid = gridOf(DISTRIBUTION.cells);
  const peak = peakCell(grid);
  assert.deepEqual(peak, DISTRIBUTION.peak);
  assert.deepEqual(peak, { weekday: 1, hour: 10, messages: 14 });
  assert.equal(slotLabel(peak, context), "Dienstag, 10–11 Uhr");
  assert.equal(slotLabel(peak, english), "Tuesday, 10:00–11:00");

  // Ränder des Rasters
  assert.equal(slotLabel({ weekday: 0, hour: 0 }, context), "Montag, 0–1 Uhr");
  assert.equal(
    slotLabel({ weekday: 6, hour: 23 }, context),
    "Sonntag, 23–24 Uhr"
  );
  // Tooltip eines Feldes (AK-5)
  assert.equal(
    t("embed-analytics.weekday-hour.tooltip", {
      slot: slotLabel(peak, context),
      value: valueLabel(peak.messages, "messages", t),
    }),
    "Dienstag, 10–11 Uhr: 14 Nachrichten"
  );
});

test("staerkster_zeitabschnitt: mehrere Felder mit dem Höchstwert – das erste in Leserichtung; ohne Nachrichten keiner", () => {
  const grid = emptyGrid();
  grid[4][9] = 7;
  grid[2][15] = 7;
  grid[2][8] = 7;
  grid[6][0] = 6;
  assert.deepEqual(peakCell(grid), { weekday: 2, hour: 8, messages: 7 });
  grid[0][23] = 7;
  assert.deepEqual(peakCell(grid), { weekday: 0, hour: 23, messages: 7 });
  grid[6][23] = 8;
  assert.deepEqual(peakCell(grid), { weekday: 6, hour: 23, messages: 8 });
  assert.equal(peakCell(emptyGrid()), null);
});

test("staerkster_zeitabschnitt: Gleichstand ist zu erkennen – die Nebenzeile nennt das eine weitere Feld mit dem Höchstwert oder die Zahl der weiteren", () => {
  // Browser-Abnahme: Dienstag 20–21 Uhr und Donnerstag 10–11 Uhr mit je 16
  const grid = emptyGrid();
  grid[1][20] = 16;
  grid[3][10] = 16;
  grid[0][9] = 15;
  // Die Regel bleibt: genannt wird das erste Feld in Leserichtung.
  assert.deepEqual(peakCell(grid), { weekday: 1, hour: 20, messages: 16 });
  assert.deepEqual(peakTies(grid), [{ weekday: 3, hour: 10 }]);
  assert.equal(
    peakNote(grid, context),
    "16 Nachrichten · gleichauf mit Donnerstag, 10–11 Uhr"
  );
  assert.equal(
    peakNote(grid, english),
    "16 messages · tied with Thursday, 10:00–11:00"
  );

  // mehrere weitere Felder: ihre Zahl, in Leserichtung gezählt
  grid[6][23] = 16;
  assert.deepEqual(peakTies(grid), [
    { weekday: 3, hour: 10 },
    { weekday: 6, hour: 23 },
  ]);
  assert.equal(
    peakNote(grid, context),
    "16 Nachrichten · gleichauf mit 2 weiteren Zeitabschnitten"
  );
  assert.equal(
    peakNote(grid, english),
    "16 messages · tied with 2 other time slots"
  );
  grid[0][0] = 16;
  // Jetzt steht Montag, 0–1 Uhr vorn – der Dienstag zählt zu den weiteren.
  assert.deepEqual(peakCell(grid), { weekday: 0, hour: 0, messages: 16 });
  assert.equal(peakTies(grid).length, 3);
  assert.ok(
    peakTies(grid).every(({ weekday, hour }) => weekday !== 0 || hour !== 0)
  );
  assert.equal(
    peakNote(grid, context),
    "16 Nachrichten · gleichauf mit 3 weiteren Zeitabschnitten"
  );

  // ohne Gleichstand nur die Anzahl – auch mit einem Feld knapp darunter
  const single = gridOf(DISTRIBUTION.cells);
  assert.deepEqual(peakTies(single), []);
  assert.equal(peakNote(single, context), "14 Nachrichten");
  assert.equal(peakNote(single, english), "14 messages");
  const one = emptyGrid();
  one[2][8] = 1;
  assert.equal(peakNote(one, context), "1 Nachricht");
  // Alle 168 Felder gleich: 167 weitere, große Werte in deutscher Schreibweise
  const even = emptyGrid().map((row) => row.map(() => 1200));
  assert.equal(peakTies(even).length, 167);
  assert.equal(
    peakNote(even, context),
    "1.200 Nachrichten · gleichauf mit 167 weiteren Zeitabschnitten"
  );
  // ohne Nachrichten weder Feld noch Zeile
  assert.deepEqual(peakTies(emptyGrid()), []);
  assert.equal(peakNote(emptyGrid(), context), null);

  // Die Texte stehen im Block der Karte, mit Einzahl und Mehrzahl.
  for (const resources of [de, en]) {
    const peak = resources["embed-analytics"]["weekday-hour"].peak;
    assert.deepEqual(Object.keys(peak).sort(), [
      "label",
      "tie-count_one",
      "tie-count_other",
      "tie-slot",
    ]);
    for (const text of Object.values(peak))
      assert.ok(typeof text === "string" && text.length > 0);
  }
  assert.equal(
    t("embed-analytics.weekday-hour.peak.tie-count", {
      value: "3 Nachrichten",
      count: 1,
    }),
    "3 Nachrichten · gleichauf mit 1 weiteren Zeitabschnitt"
  );
  assert.equal(
    english.t("embed-analytics.weekday-hour.peak.tie-count", {
      value: "3 messages",
      count: 1,
    }),
    "3 messages · tied with 1 other time slot"
  );
});

test("anteil_ausserhalb (AK-4): 100 Nachrichten, davon 60 Montag–Freitag zwischen 8:00 und 16:59 Uhr – „40 % der Nachrichten“ unter „Außerhalb von Montag–Freitag, 8–17 Uhr“", () => {
  const grid = gridOf(CORE_TIME_WEEK.cells);
  const share = outsideCoreShare(grid);
  assert.deepEqual(share, {
    total: CORE_TIME_WEEK.total,
    inside: CORE_TIME_WEEK.insideCore,
    outside: 40,
    percent: CORE_TIME_WEEK.outsidePercent,
  });
  assert.equal(share.total, 100);
  assert.equal(share.percent, 40);

  assert.equal(
    outsideCoreLabel(context),
    "Außerhalb von Montag–Freitag, 8–17 Uhr"
  );
  assert.equal(
    t("embed-analytics.weekday-hour.outside.value", { percent: share.percent }),
    "40 % der Nachrichten"
  );
  assert.equal(outsideCoreLabel(english), "Outside Monday–Friday, 8:00–17:00");
  // Hard Constraint 5: Der Hinweis am Feld nennt die Feiertage.
  assert.equal(
    t("embed-analytics.weekday-hour.outside.note"),
    "Feiertage zählen als normale Wochentage."
  );
});

test("anteil_ausserhalb: Die Kernzeit ist Montag bis Freitag, 8:00 bis 16:59 Uhr – jede Grenze auf das Feld genau", () => {
  assert.deepEqual(CORE_TIME, {
    fromWeekday: 0,
    toWeekday: 4,
    fromHour: 8,
    toHour: 17,
  });
  const inside = [];
  for (let weekday = 0; weekday < 7; weekday++)
    for (let hour = 0; hour < 24; hour++)
      if (isCoreTime(weekday, hour)) inside.push(`${weekday}-${hour}`);
  // 5 Tage × 9 Stunden (8, 9 … 16)
  assert.equal(inside.length, 45);
  assert.ok(isCoreTime(0, 8) && isCoreTime(4, 16));
  for (const [weekday, hour] of [
    [0, 7],
    [0, 17],
    [4, 17],
    [5, 10],
    [6, 12],
    [2, 0],
    [3, 23],
  ])
    assert.equal(isCoreTime(weekday, hour), false, `${weekday}/${hour}`);

  // Jede Nachricht zählt genau einmal: innerhalb + außerhalb = Summe.
  const grid = gridOf(DISTRIBUTION.cells);
  const share = outsideCoreShare(grid);
  assert.equal(share.inside + share.outside, gridTotal(grid));
  // alles innerhalb, alles außerhalb, nichts
  const only = (weekday, hour) => {
    const one = emptyGrid();
    one[weekday][hour] = 3;
    return outsideCoreShare(one).percent;
  };
  assert.equal(only(2, 12), 0);
  assert.equal(only(5, 12), 100);
  assert.equal(outsideCoreShare(emptyGrid()), null);
  // gerundet auf ganze Prozent
  const third = emptyGrid();
  third[0][10] = 2;
  third[6][10] = 1;
  assert.equal(outsideCoreShare(third).percent, 33);
});

test("NAK-3: Die zweite Aussage nennt die feste Grenze wörtlich – nirgends „Geschäftszeiten“ oder „Öffnungszeiten“", () => {
  for (const [name, resources, forbidden] of [
    ["de", de, /geschäftszeit|öffnungszeit|ihre[rn]? zeiten/i],
    ["en", en, /business hours|opening hours|office hours|your hours/i],
  ]) {
    const texts = JSON.stringify(resources["embed-analytics"]["weekday-hour"]);
    assert.doesNotMatch(texts, forbidden, name);
  }
  assert.doesNotMatch(outsideCoreLabel(context), /Ihre/);
  // Die Beschriftung folgt den Konstanten: Wochentage und Stunden der Kernzeit.
  assert.ok(
    outsideCoreLabel(context).includes(
      `${weekdayName(CORE_TIME.fromWeekday, "de")}–${weekdayName(CORE_TIME.toWeekday, "de")}, ${hoursLabel(CORE_TIME.fromHour, CORE_TIME.toHour, t)}`
    )
  );
});

test("Sommerzeit (AK-6): Die Felder des Servers stehen in Zeile Sonntag, Spalten 1 und 3 – das Frontend rechnet nichts um", () => {
  const grid = emptyGrid();
  for (const hour of DST.spring.hours) grid[DST.spring.weekday][hour] += 1;
  const cells = [];
  grid.forEach((row, weekday) =>
    row.forEach((value, hour) => {
      if (value > 0) cells.push(slotLabel({ weekday, hour }, context));
    })
  );
  assert.deepEqual(cells, ["Sonntag, 1–2 Uhr", "Sonntag, 3–4 Uhr"]);
});

// ---------------------------------------------------------------------------
// Wochentage
// ---------------------------------------------------------------------------

test("Wochentage: Montag bis Sonntag in der Sprache der Oberfläche, fest gregorianisch", () => {
  const names = (locale, width) =>
    Array.from({ length: 7 }, (_, weekday) =>
      weekdayName(weekday, locale, width)
    );
  assert.deepEqual(names("de"), [
    "Montag",
    "Dienstag",
    "Mittwoch",
    "Donnerstag",
    "Freitag",
    "Samstag",
    "Sonntag",
  ]);
  assert.deepEqual(names("de", "short"), [
    "Mo",
    "Di",
    "Mi",
    "Do",
    "Fr",
    "Sa",
    "So",
  ]);
  assert.deepEqual(names("en"), [
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
    "Sunday",
  ]);
  assert.equal(weekdayName(0, "fr"), "lundi");
  // fa und ar-SA rechnen sonst persisch bzw. nach der Hidschra: Der Montag
  // bleibt der Montag.
  for (const locale of ["fa", "ar-SA", "he", "ja", "zh"]) {
    const expected = Array.from({ length: 7 }, (_, weekday) =>
      new Intl.DateTimeFormat(locale, {
        weekday: "long",
        timeZone: "UTC",
      }).format(new Date(Date.UTC(2026, 9, 5 + weekday)))
    );
    assert.deepEqual(names(locale), expected, locale);
    assert.equal(new Set(names(locale)).size, 7, locale);
  }
  // Ein Sprachkürzel, das Intl nicht kennt (Ordnername pt_BR): deutsche Namen
  // statt eines Fehlers.
  assert.equal(weekdayName(1, "pt_BR"), "Dienstag");
});

// ---------------------------------------------------------------------------
// Farbstufen (Hard Constraint 3, AK-1) und Legende (AK-9)
// ---------------------------------------------------------------------------

test("Stufen (AK-1): Felder ohne Nachricht haben die Null-Stufe, das Feld mit dem Höchstwert die stärkste – gleich breite Klassen des Höchstwerts", () => {
  assert.equal(HEAT_LEVELS, 5);
  // Höchstwert 15: 1–3, 4–6, 7–9, 10–12, 13–15
  assert.deepEqual(
    Array.from({ length: 16 }, (_, value) => heatLevel(value, 15)),
    [0, 1, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 4, 5, 5, 5]
  );
  // Der Bestand aus AK-1: Höchstwert 14
  const grid = gridOf(DISTRIBUTION.cells);
  const max = peakCell(grid).messages;
  const levels = grid.map((row) => row.map((value) => heatLevel(value, max)));
  assert.equal(levels[1][10], 5);
  assert.equal(levels.flat().filter((level) => level === 5).length, 1);
  grid.forEach((row, weekday) =>
    row.forEach((value, hour) => {
      assert.equal(levels[weekday][hour] === 0, value === 0);
    })
  );
  assert.equal(levels.flat().filter((level) => level === 0).length, 84);

  // 0 ist nie eine Farbstufe, mehr als 0 nie die Null-Stufe.
  for (const max of [1, 2, 3, 4, 5, 6, 14, 99, 100, 101, 1234, 99999]) {
    assert.equal(heatLevel(0, max), 0);
    assert.equal(heatLevel(1, max) >= 1, true, `1 von ${max}`);
    assert.equal(heatLevel(max, max), 5, `Höchstwert ${max}`);
  }
  assert.equal(heatLevel(0, 0), 0);
  assert.equal(heatLevel(3, 0), 0);
});

test("Stufen: Mehr Nachrichten sind nie eine schwächere Stufe; die Bereiche der Legende decken jeden Wert genau einmal ab", () => {
  for (const max of [
    1, 2, 3, 4, 5, 6, 7, 9, 10, 14, 15, 16, 49, 50, 51, 200, 1234,
  ]) {
    const legend = heatLegend(max);
    assert.deepEqual(
      legend.map((step) => step.level),
      [0, 1, 2, 3, 4, 5]
    );
    assert.deepEqual(legend[0], { level: 0, from: 0, to: 0 });

    let previous = 0;
    for (let value = 1; value <= max; value++) {
      const level = heatLevel(value, max);
      assert.ok(level >= previous, `${value} von ${max}`);
      assert.ok(level >= 1 && level <= 5);
      previous = level;
      // genau ein Bereich der Legende enthält den Wert – der seiner Stufe
      const containing = legend.filter(
        (step) =>
          step.level > 0 &&
          step.from !== null &&
          step.from <= value &&
          value <= step.to
      );
      assert.deepEqual(
        containing.map((step) => step.level),
        [level],
        `${value} von ${max}`
      );
    }
    // lückenlos von 1 bis zum Höchstwert
    const used = legend.filter((step) => step.level > 0 && step.from !== null);
    assert.equal(used[0].from, 1);
    assert.equal(used.at(-1).to, max);
    assert.equal(used.at(-1).level, 5);
    for (let i = 1; i < used.length; i++)
      assert.equal(used[i].from, used[i - 1].to + 1);
    // Ab einem Höchstwert von 5 hat jede Stufe einen Bereich.
    assert.equal(used.length, Math.min(5, max), `Höchstwert ${max}`);
  }
});

test("Legende (AK-9): sechs Stufen mit Wertebereichen – für den Bestand aus AK-1 (Höchstwert 14) 0, 1–2, 3–5, 6–8, 9–11, 12–14", () => {
  assert.deepEqual(heatLegend(14), [
    { level: 0, from: 0, to: 0 },
    { level: 1, from: 1, to: 2 },
    { level: 2, from: 3, to: 5 },
    { level: 3, from: 6, to: 8 },
    { level: 4, from: 9, to: 11 },
    { level: 5, from: 12, to: 14 },
  ]);
  // Bei höchstens 3 Nachrichten je Feld gibt es keine fünf Bereiche.
  assert.deepEqual(heatLegend(3), [
    { level: 0, from: 0, to: 0 },
    { level: 1, from: null, to: null },
    { level: 2, from: 1, to: 1 },
    { level: 3, from: null, to: null },
    { level: 4, from: 2, to: 2 },
    { level: 5, from: 3, to: 3 },
  ]);
  assert.equal(t("embed-analytics.weekday-hour.legend.less"), "weniger");
  assert.equal(t("embed-analytics.weekday-hour.legend.more"), "mehr");
});

// ---------------------------------------------------------------------------
// Theme-Variablen und Kontrast (Hard Constraint 3, AK-10)
// ---------------------------------------------------------------------------

/** Die Variablen beider Themes aus index.css (hell erbt von dunkel). */
function themes() {
  const css = readFileSync(
    new URL("../src/index.css", import.meta.url),
    "utf8"
  );
  const tokensOf = (block) =>
    Object.fromEntries(
      [...block.matchAll(/^\s*(--[\w-]+):\s*([^;]+);/gm)].map((match) => [
        match[1],
        match[2].trim(),
      ])
    );
  const [rootBlock, lightBlock] = css.split('[data-theme="light"] {');
  const dark = tokensOf(rootBlock.slice(rootBlock.indexOf(":root {")));
  const light = { ...dark, ...tokensOf(lightBlock.split("\n}")[0]) };
  return { dark, light };
}

/** "#0e0f0f" oder "rgba(255, 255, 255, 0.6)" als [r, g, b, a]. */
function colorOf(value) {
  const hex = /^#([0-9a-f]{6})$/i.exec(value);
  if (hex)
    return [0, 2, 4]
      .map((at) => parseInt(hex[1].slice(at, at + 2), 16))
      .concat(1);
  const rgba = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/.exec(
    value
  );
  assert.ok(rgba, `Farbe nicht lesbar: ${value}`);
  return [
    Number(rgba[1]),
    Number(rgba[2]),
    Number(rgba[3]),
    Number(rgba[4] ?? 1),
  ];
}

/** Farbe auf einer deckenden Fläche, wie sie zu sehen ist. */
function over(value, surface) {
  const [r, g, b, a] = colorOf(value);
  const below = colorOf(surface);
  return [r, g, b].map((channel, i) => channel * a + below[i] * (1 - a));
}

function luminance(rgb) {
  const [r, g, b] = rgb
    .map((channel) => channel / 255)
    .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Kontrastverhältnis nach WCAG 2.x */
function contrast(a, b) {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
}

const HEAT = [0, 1, 2, 3, 4, 5].map(
  (level) => `--theme-analytics-heat-${level}`
);

test("Farbstufen (Hard Constraint 3): eine Farbe in fünf Stufen als Theme-Variablen – hell und dunkel mit genau den geprüften Werten", () => {
  const { dark, light } = themes();
  assert.deepEqual(
    HEAT.slice(1).map((name) => light[name]),
    ["#5fbdf2", "#2e9fe0", "#0284c7", "#0a659b", "#0c4a70"]
  );
  assert.deepEqual(
    HEAT.slice(1).map((name) => dark[name]),
    ["#15608f", "#0b7ab3", "#1a9bdc", "#5cbcf0", "#a5dcfa"]
  );
  // Das helle Theme definiert alle sechs selbst, nichts erbt vom dunklen.
  const css = readFileSync(
    new URL("../src/index.css", import.meta.url),
    "utf8"
  );
  for (const name of HEAT)
    assert.equal(css.split(`${name}:`).length - 1, 2, name);

  for (const [theme, tokens] of [
    ["hell", light],
    ["dunkel", dark],
  ]) {
    // keine Regenbogenskala: ein Farbton (Blau überwiegt, Rot ist am
    // schwächsten) in jeder der fünf Stufen
    for (const name of HEAT.slice(1)) {
      const [r, g, b] = colorOf(tokens[name]);
      assert.ok(b > g && g > r, `${theme} ${name}: ${tokens[name]}`);
    }
    // mehr Nachrichten = mehr Abstand zur Fläche der Karte, Stufe für Stufe
    const surface = colorOf(tokens["--theme-bg-primary"]);
    const distances = HEAT.map((name) =>
      contrast(colorOf(tokens[name]), surface)
    );
    for (let level = 1; level <= 5; level++)
      assert.ok(
        distances[level] > distances[level - 1] * 1.3,
        `${theme}: Stufe ${level} (${distances[level].toFixed(2)}:1) gegen Stufe ${level - 1} (${distances[level - 1].toFixed(2)}:1)`
      );
  }
});

test("Null-Stufe: eine eigene, neutrale Fläche – kein Blau, von der Karte und von der ersten Stufe zu unterscheiden", () => {
  const { dark, light } = themes();
  for (const [theme, tokens] of [
    ["hell", light],
    ["dunkel", dark],
  ]) {
    const zero = colorOf(tokens[HEAT[0]]);
    const [r, g, b] = zero;
    // neutral: die drei Kanäle liegen dicht beieinander
    assert.ok(Math.max(r, g, b) - Math.min(r, g, b) <= 8, `${theme}: ${zero}`);
    // keine der fünf Stufen
    assert.ok(!HEAT.slice(1).some((name) => tokens[name] === tokens[HEAT[0]]));
    const surface = colorOf(tokens["--theme-bg-primary"]);
    const first = colorOf(tokens[HEAT[1]]);
    // als Feld zu erkennen, aber nah an der Fläche …
    const onSurface = contrast(zero, surface);
    assert.ok(onSurface >= 1.15 && onSurface < 1.5, `${theme}: ${onSurface}`);
    // … und deutlich schwächer als die erste Stufe
    assert.ok(
      contrast(first, zero) >= 1.7,
      `${theme}: ${contrast(first, zero)}`
    );
  }
});

test("Kontrast (AK-10): Beschriftungen des Rasters, der Legende und der Aussagen erreichen in beiden Themes mindestens 4,5:1", () => {
  const { dark, light } = themes();
  const measured = {};
  for (const [theme, tokens] of [
    ["hell", light],
    ["dunkel", dark],
  ]) {
    const card = tokens["--theme-bg-primary"];
    const tooltip = tokens["--theme-bg-secondary"];
    const pairs = {
      // Wochentage, Stunden, Legende, Beschriftung der Aussagen, Hinweise
      "gedämpfter Text auf der Karte": [
        tokens["--theme-analytics-text-muted"],
        card,
      ],
      // Titel, Werte der Aussagen, Tabelle
      "Text auf der Karte": [tokens["--theme-text-primary"], card],
      "Text im Tooltip": [tokens["--theme-text-primary"], tooltip],
    };
    for (const [name, [text, surface]] of Object.entries(pairs)) {
      const ratio = contrast(over(text, surface), colorOf(surface).slice(0, 3));
      measured[`${theme}: ${name}`] = Math.round(ratio * 100) / 100;
      assert.ok(ratio >= 4.5, `${theme}, ${name}: ${ratio.toFixed(2)}:1`);
    }
    // Rahmen des angesteuerten Feldes (Textfarbe) gegen die Lücke zwischen
    // den Feldern (Fläche der Karte): mindestens 3:1 wie für Bedienelemente
    assert.ok(
      contrast(
        colorOf(tokens["--theme-text-primary"]).slice(0, 3),
        colorOf(card).slice(0, 3)
      ) >= 3
    );
  }
  // rechnerisch belegt (WCAG 2.x)
  assert.deepEqual(measured, {
    "hell: gedämpfter Text auf der Karte": 6.05,
    "hell: Text auf der Karte": 19.2,
    "hell: Text im Tooltip": 19.2,
    "dunkel: gedämpfter Text auf der Karte": 7.25,
    "dunkel: Text auf der Karte": 19.2,
    "dunkel: Text im Tooltip": 17.18,
  });
});

// ---------------------------------------------------------------------------
// Geometrie: Raster, schmale Karte, Tooltip (AK-10)
// ---------------------------------------------------------------------------

const LABELS = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];

test("Geometrie: 7 × 24 Felder teilen sich die Breite neben den Wochentagen, mit einer Lücke von 2 px – nichts überlappt", () => {
  const labelWidth = rowLabelWidth(LABELS);
  assert.equal(labelWidth, 28);
  // Lange Kurzformen (lettisch "Pirmd.") bekommen den Platz, den sie brauchen.
  assert.ok(rowLabelWidth(["Pirmd.", "Otrd."]) > 28);

  const layout = gridLayout({ width: 1028, labelWidth });
  assert.deepEqual(
    { ...layout },
    {
      labelWidth: 28,
      visibleWidth: 1000,
      plotWidth: 1000,
      slot: 1000 / 24,
      height: 7 * ROW_HEIGHT,
      scrolls: false,
    }
  );

  const tiles = [];
  for (let weekday = 0; weekday < 7; weekday++)
    for (let hour = 0; hour < 24; hour++) {
      const box = cellBox(layout, { weekday, hour });
      // die gezeichnete Fläche liegt mittig im Platz
      assert.equal(box.tile.x - box.x, CELL_GAP / 2);
      assert.equal(box.tile.y - box.y, CELL_GAP / 2);
      assert.ok(Math.abs(box.width - box.tile.width - CELL_GAP) < 1e-9);
      assert.equal(box.height - box.tile.height, CELL_GAP);
      assert.ok(box.tile.x >= 0 && box.tile.x + box.tile.width <= 1000);
      assert.ok(
        box.tile.y >= 0 && box.tile.y + box.tile.height <= layout.height
      );
      tiles.push(box);
    }
  // Nachbarn berühren sich als Platz und lassen als Fläche die Lücke.
  const first = cellBox(layout, { weekday: 0, hour: 0 });
  const right = cellBox(layout, { weekday: 0, hour: 1 });
  const below = cellBox(layout, { weekday: 1, hour: 0 });
  assert.ok(Math.abs(right.x - (first.x + first.width)) < 1e-9);
  assert.ok(
    Math.abs(right.tile.x - (first.tile.x + first.tile.width) - CELL_GAP) < 1e-9
  );
  assert.equal(below.tile.y - (first.tile.y + first.tile.height), CELL_GAP);
  assert.equal(tiles.length, 168);
  assert.ok(AXIS_HEIGHT >= 16);
});

test("Schmale Karte (AK-10, 390 px): Kein Feld wird schmaler als 24 px – das Raster ist breiter als sein sichtbarer Bereich und lässt sich darin schieben", () => {
  // 390 px Fenster: 8 px Seitenrand und 16 px Innenabstand der Karte je Seite
  const width = 390 - 2 * 8 - 2 * 16;
  const layout = gridLayout({ width, labelWidth: rowLabelWidth(LABELS) });
  assert.equal(layout.visibleWidth, 314);
  assert.equal(layout.plotWidth, HOURS * MIN_CELL_WIDTH);
  assert.equal(layout.plotWidth, 576);
  assert.equal(layout.slot, 24);
  assert.equal(layout.scrolls, true);
  // Sichtbarer Bereich und Wochentage zusammen sind nie breiter als die Karte.
  assert.equal(layout.labelWidth + layout.visibleWidth, width);

  // Breit (1440 px Fenster) wird nichts geschoben.
  assert.equal(gridLayout({ width: 1060, labelWidth: 28 }).scrolls, false);
  // Grenze: genau 24 px je Feld
  assert.equal(gridLayout({ width: 576 + 28, labelWidth: 28 }).scrolls, false);
  assert.equal(gridLayout({ width: 575 + 28, labelWidth: 28 }).scrolls, true);
  // ohne gemessene Breite kein negativer Bereich
  assert.equal(gridLayout({ width: 0, labelWidth: 28 }).visibleWidth, 0);
});

test("Tooltip: bleibt für jedes Feld in der Karte und steht über der Zeile des Feldes – breit, schmal und mit verschobenem Raster", () => {
  const grid = gridOf(DISTRIBUTION.cells);
  const textOf = (slot) =>
    t("embed-analytics.weekday-hour.tooltip", {
      slot: slotLabel(slot, context),
      value: valueLabel(grid[slot.weekday][slot.hour], "messages", t),
    });
  /** Wo der Tooltip höchstens liegen kann: Anker und Höchstbreite. */
  const boxOf = ({ align, x, maxWidth }, width) => {
    if (align === "end")
      return { left: width - x - maxWidth, right: width - x };
    if (align === "center")
      return { left: x - maxWidth / 2, right: x + maxWidth / 2 };
    return { left: x, right: x + maxWidth };
  };

  for (const width of [1028, 342, 260]) {
    const layout = gridLayout({ width, labelWidth: 28 });
    const furthest = layout.plotWidth - layout.visibleWidth;
    for (const scrollLeft of new Set([0, furthest / 2, furthest]))
      for (let weekday = 0; weekday < 7; weekday++)
        for (let hour = 0; hour < 24; hour++) {
          const slot = { weekday, hour };
          const where = `${width} px, ${scrollLeft} px verschoben, ${weekday}/${hour}`;
          const placement = cellTooltipPlacement({
            layout,
            slot,
            scrollLeft,
            text: textOf(slot),
          });
          const box = boxOf(placement, width);
          assert.ok(box.left >= 0 && box.right <= width, where);
          assert.ok(placement.maxWidth > 0, where);
          // Unterkante über der Zeile: Das Feld bleibt frei.
          assert.equal(
            placement.y,
            cellBox(layout, slot).y - TOOLTIP_GAP,
            where
          );
          assert.ok(placement.y < cellBox(layout, slot).tile.y, where);
        }
  }

  // Breit: mittig über dem Feld.
  const wide = gridLayout({ width: 1028, labelWidth: 28 });
  const middle = cellTooltipPlacement({
    layout: wide,
    slot: { weekday: 1, hour: 10 },
    scrollLeft: 0,
    text: "Dienstag, 10–11 Uhr: 14 Nachrichten",
  });
  assert.equal(middle.align, "center");
  assert.ok(Math.abs(middle.x - (28 + 10.5 * (1000 / 24))) < 1e-9);
  assert.equal(middle.y, ROW_HEIGHT - TOOLTIP_GAP);

  // Schmal und verschoben: Der Tooltip folgt der Stelle, an der das Feld zu
  // sehen ist …
  const narrow = gridLayout({ width: 342, labelWidth: 28 });
  const text = "Sonntag, 21–22 Uhr: 0 Nachrichten";
  const shifted = cellTooltipPlacement({
    layout: narrow,
    slot: { weekday: 6, hour: 21 },
    scrollLeft: 262,
    text,
  });
  const unshifted = cellTooltipPlacement({
    layout: narrow,
    slot: { weekday: 6, hour: 21 },
    scrollLeft: 0,
    text,
  });
  assert.equal(shifted.align, "end");
  // … und ein Feld außerhalb des sichtbaren Bereichs hält ihn am Rand.
  assert.equal(unshifted.align, "end");
  assert.equal(unshifted.x, 0);
  assert.equal(
    cellTooltipPlacement({
      layout: narrow,
      slot: { weekday: 0, hour: 0 },
      scrollLeft: 262,
      text,
    }).align,
    "start"
  );
});
