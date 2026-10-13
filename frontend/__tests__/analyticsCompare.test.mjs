// KIE-537: Vergleich mit dem Vorzeitraum – die Logik ohne React
// (src/utils/analyticsTimeline.js): Veränderung in Prozent, die Zeile im
// Kennzahl-Feld, was vom Vorzeitraum zu zeigen ist, Geometrie der Linie und
// der Tooltip über ihr. Geprüft mit den deutschen Texten der Sprachdatei.
//
// Was die Komponenten daraus zeichnen, prüft embedAnalyticsCompareView.test.mjs,
// Schalter und Anfragen embedAnalyticsCompare.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import de from "../src/locales/de/common.js";
import en from "../src/locales/en/common.js";
import {
  PREVIOUS_LINE,
  TOOLTIP_GAP,
  addDays,
  changeLabel,
  columnLayout,
  comparisonOf,
  formatDayRange,
  formatPercentChange,
  linePath,
  linePoints,
  percentChange,
  previousValueLabel,
  tooltipPlacement,
  valueScale,
} from "../src/utils/analyticsTimeline.js";

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

// ---------------------------------------------------------------------------
// Texte (Hard Constraint 8)
// ---------------------------------------------------------------------------

/** Punktpfade aller Texte unter einem Knoten, mit ihrem Wert. */
function leaves(node, prefix = "") {
  return Object.entries(node).flatMap(([key, value]) =>
    value !== null && typeof value === "object"
      ? leaves(value, `${prefix}${key}.`)
      : [[`${prefix}${key}`, value]]
  );
}

test("Texte (Hard Constraint 8): Deutsch und Englisch sind ausformuliert, jede Sprachdatei führt dieselben Schlüssel", async () => {
  const { resources } = await import("../src/locales/resources.js");
  const keys = leaves(de["embed-analytics"].compare).map(([key]) => key);
  assert.ok(keys.includes("toggle"));
  assert.ok(keys.includes("legend.previous"));
  assert.ok(keys.length >= 14);

  for (const [lang, { common }] of Object.entries(resources)) {
    const block = common["embed-analytics"]?.compare;
    assert.ok(block, `${lang}: embed-analytics.compare fehlt`);
    assert.deepEqual(
      leaves(block).map(([key]) => key),
      keys,
      lang
    );
    for (const [key, value] of leaves(block))
      if (lang === "de" || lang === "en")
        assert.ok(
          typeof value === "string" && value.trim() !== "",
          `${lang}: ${key}`
        );
      else assert.ok(value === null || typeof value === "string", lang);
  }
  assert.equal(de["embed-analytics"].compare.toggle, "Vorzeitraum vergleichen");
  assert.equal(
    de["embed-analytics"].compare.legend.current,
    "Gewählter Zeitraum"
  );
  assert.equal(de["embed-analytics"].compare.legend.previous, "Vorzeitraum");
  assert.equal(
    de["embed-analytics"].compare.unavailable,
    "Kein Vergleich verfügbar"
  );
});

// ---------------------------------------------------------------------------
// Veränderung in den Kennzahlen (AK-4)
// ---------------------------------------------------------------------------

test("Veränderung (AK-4): 421 gegenüber 266 sind +58 % – ganze Prozent, kaufmännisch gerundet", () => {
  assert.equal(percentChange(421, 266), 58); // 58,27
  assert.equal(percentChange(266, 421), -37); // −36,82
  assert.equal(percentChange(150, 100), 50);
  assert.equal(percentChange(50, 100), -50);
  assert.equal(percentChange(200, 100), 100);
  assert.equal(percentChange(5000, 2), 249900);
  // Grenze x,5: weg von der Null, in beide Richtungen gleich
  assert.equal(percentChange(201, 200), 1); // +0,5
  assert.equal(percentChange(199, 200), -1); // −0,5
  assert.equal(percentChange(1005, 1000), 1); // +0,5
  assert.equal(percentChange(1004, 1000), 0); // +0,4
  assert.equal(percentChange(996, 1000), 0); // −0,4
  assert.equal(percentChange(329, 200), 65); // +64,5
  assert.equal(percentChange(71, 200), -65); // −64,5
});

test("Veränderung: gleiche Werte sind 0 (nie −0), ein Rückgang auf 0 ist −100", () => {
  assert.ok(Object.is(percentChange(266, 266), 0));
  assert.ok(Object.is(percentChange(996, 1000), 0));
  assert.ok(Object.is(percentChange(1004, 1000), 0));
  assert.equal(percentChange(0, 266), -100);
  assert.equal(percentChange(0, 1), -100);
});

test("Veränderung (AK-4): Bei einem Vorzeitraumwert von 0 gibt es keine Prozentzahl – auch nicht, wenn beide 0 sind", () => {
  assert.equal(percentChange(421, 0), null);
  assert.equal(percentChange(0, 0), null);
  assert.equal(percentChange(1, 0), null);
  // Unsinn als Vorzeitraumwert ist kein Vergleich
  for (const previous of [undefined, null, NaN, -5])
    assert.equal(percentChange(421, previous), null, String(previous));
  // Ein fehlender Wert im Zeitraum zählt als 0.
  assert.equal(percentChange(undefined, 50), -100);
});

test("Veränderung: Vorzeichen und Zahl in deutscher Schreibweise – Plus, Minuszeichen, ±0, Tausenderpunkt", () => {
  assert.equal(formatPercentChange(58), "+58");
  assert.equal(formatPercentChange(-37), "−37");
  assert.equal(formatPercentChange(-100), "−100");
  assert.equal(formatPercentChange(0), "±0");
  assert.equal(formatPercentChange(1150), "+1.150");
  assert.equal(formatPercentChange(249900), "+249.900");
  // ein Minuszeichen (U+2212), kein Bindestrich
  assert.equal(formatPercentChange(-1).codePointAt(0), 0x2212);
});

test("Zeile im Kennzahl-Feld (AK-4): „+58 % ggü. Vorzeitraum (266)“; bei 0 im Vorzeitraum „Vorzeitraum: 0“ ohne Prozentzahl", () => {
  assert.equal(changeLabel(421, 266, t), "+58 % ggü. Vorzeitraum (266)");
  assert.equal(changeLabel(266, 421, t), "−37 % ggü. Vorzeitraum (421)");
  assert.equal(changeLabel(0, 12, t), "−100 % ggü. Vorzeitraum (12)");
  assert.equal(changeLabel(266, 266, t), "±0 % ggü. Vorzeitraum (266)");
  assert.equal(changeLabel(13000, 1234, t), "+953 % ggü. Vorzeitraum (1.234)");
  assert.equal(changeLabel(30000, 2, t), "+1.499.900 % ggü. Vorzeitraum (2)");

  assert.equal(changeLabel(421, 0, t), "Vorzeitraum: 0");
  assert.equal(changeLabel(0, 0, t), "Vorzeitraum: 0");
  assert.doesNotMatch(changeLabel(421, 0, t), /%/);
  assert.doesNotMatch(changeLabel(0, 0, t), /%/);
});

test("Zeile im Kennzahl-Feld und Tooltip, englische Oberfläche: Zahlen bleiben in deutscher Schreibweise", () => {
  const tEn = translator(en);
  assert.equal(
    changeLabel(13000, 1234, tEn),
    "+953 % vs. previous period (1.234)"
  );
  assert.equal(changeLabel(421, 0, tEn), "Previous period: 0");
  assert.equal(previousValueLabel(1234, tEn), "Previous period: 1.234");
});

test("Tooltip (AK-5): zweite Zeile „Vorzeitraum: N“", () => {
  assert.equal(previousValueLabel(31, t), "Vorzeitraum: 31");
  assert.equal(previousValueLabel(0, t), "Vorzeitraum: 0");
  assert.equal(previousValueLabel(1234, t), "Vorzeitraum: 1.234");
});

test("Bereich des Vorzeitraums: zwei Tage mit Halbgeviertstrich, ein einzelner Tag allein", () => {
  assert.equal(
    formatDayRange("2026-08-14", "2026-09-12", t),
    "14.08.2026–12.09.2026"
  );
  assert.equal(
    formatDayRange("2025-12-30", "2026-01-02", t),
    "30.12.2025–02.01.2026"
  );
  assert.equal(formatDayRange("2026-10-11", "2026-10-11", t), "11.10.2026");
});

// ---------------------------------------------------------------------------
// Was vom Vorzeitraum zu zeigen ist (Hard Constraints 5 und 6, AK-6, AK-8)
// ---------------------------------------------------------------------------

const FROM = "2026-09-13";
const TOTALS = {
  messages: 421,
  conversations: 60,
  feedbackPositive: 9,
  feedbackNegative: 3,
};
const dayBuckets = (from, days, value) =>
  Array.from({ length: days }, (_, i) => ({
    start: addDays(from, i),
    end: addDays(from, i),
    partial: false,
    messages: value(i),
    conversations: 1,
  }));
/** Antwort von analytics/summary für 30 Tage, mit Vorzeitraum nach Wunsch. */
function summaryWith(previous) {
  return {
    success: true,
    granularity: "day",
    fromDay: FROM,
    toDay: addDays(FROM, 29),
    firstLedgerDay: "2026-01-01",
    totals: TOTALS,
    buckets: dayBuckets(FROM, 30, (i) => 14 + i),
    ...(previous === undefined ? {} : { previous }),
  };
}
const PREVIOUS = {
  available: true,
  fromDay: "2026-08-14",
  toDay: "2026-09-12",
  totals: {
    messages: 266,
    conversations: 0,
    feedbackPositive: 6,
    feedbackNegative: 0,
  },
  buckets: dayBuckets("2026-08-14", 30, (i) => 3 + (i % 5)),
};

test("Schalter aus (AK-8): kein Vergleich – auch wenn die Antwort noch einen Vorzeitraum nennt", () => {
  assert.equal(comparisonOf(summaryWith(PREVIOUS), false), null);
  assert.equal(comparisonOf(summaryWith(undefined), false), null);
  assert.equal(comparisonOf(null, false), null);
});

test("Schalter an, die Antwort ist noch ohne Vergleich geladen: nichts zu zeigen, statt „kein Vergleich“", () => {
  assert.equal(comparisonOf(summaryWith(undefined), true), null);
  assert.equal(comparisonOf(summaryWith(null), true), null);
  assert.equal(comparisonOf(null, true), null);
});

test("Schalter an: Kennzahlen des Vorzeitraums und die Linie – je Säule ein Abschnitt, mit ihren eigenen Tagen", () => {
  const comparison = comparisonOf(summaryWith(PREVIOUS), true);
  assert.equal(comparison.available, true);
  assert.equal(comparison.fromDay, "2026-08-14");
  assert.equal(comparison.toDay, "2026-09-12");
  assert.deepEqual(comparison.totals, PREVIOUS.totals);
  assert.equal(comparison.buckets, PREVIOUS.buckets);
  assert.equal(comparison.buckets.length, 30);
  assert.equal(comparison.lineFromDay, "2026-08-14");
  assert.equal(comparison.lineToDay, "2026-09-12");

  // Wochen: Die Linie zeigt ganze Kalenderwochen, die Kennzahlen andere Tage.
  const weeks = {
    ...summaryWith(undefined),
    granularity: "week",
    buckets: [
      { start: "2026-09-30", end: "2026-10-04", partial: true },
      { start: "2026-10-05", end: "2026-10-11", partial: false },
    ],
    previous: {
      available: true,
      fromDay: "2026-09-18",
      toDay: "2026-09-29",
      totals: PREVIOUS.totals,
      buckets: [
        { start: "2026-09-14", end: "2026-09-20", partial: false },
        { start: "2026-09-21", end: "2026-09-27", partial: false },
      ],
    },
  };
  const weekly = comparisonOf(weeks, true);
  assert.equal(weekly.fromDay, "2026-09-18");
  assert.equal(weekly.toDay, "2026-09-29");
  assert.equal(weekly.lineFromDay, "2026-09-14");
  assert.equal(weekly.lineToDay, "2026-09-27");
});

test("Kein Vergleich (AK-6): available false – mit dem ersten Tag der Zählwerte, keine Werte des Vorzeitraums", () => {
  const unavailable = comparisonOf(
    {
      ...summaryWith({ ...PREVIOUS, available: false }),
      firstLedgerDay: "2026-09-01",
    },
    true
  );
  assert.deepEqual(unavailable, { available: false, since: "2026-09-01" });

  // Vor dem 01.01.0001 nennt der Server weder Tage noch Werte.
  assert.deepEqual(
    comparisonOf(
      summaryWith({
        available: false,
        fromDay: null,
        toDay: null,
        totals: null,
        buckets: [],
      }),
      true
    ),
    { available: false, since: "2026-01-01" }
  );
  // Ein Widget ohne jeden Zählwert
  assert.deepEqual(
    comparisonOf(
      {
        ...summaryWith({ ...PREVIOUS, available: false }),
        firstLedgerDay: null,
      },
      true
    ),
    { available: false, since: null }
  );
});

test("Kein Vergleich: Eine Antwort, deren Linie nicht zu den Säulen passt, wird nicht gezeichnet", () => {
  for (const previous of [
    { ...PREVIOUS, buckets: PREVIOUS.buckets.slice(1) },
    { ...PREVIOUS, buckets: [] },
    { ...PREVIOUS, buckets: undefined },
    { ...PREVIOUS, totals: null },
    { ...PREVIOUS, fromDay: null },
    { ...PREVIOUS, available: "true" },
    { ...PREVIOUS, available: undefined },
  ])
    assert.deepEqual(comparisonOf(summaryWith(previous), true), {
      available: false,
      since: "2026-01-01",
    });
});

// ---------------------------------------------------------------------------
// Linie (Hard Constraint 4, AK-3, NAK-1)
// ---------------------------------------------------------------------------

const PLOT = { width: 900, height: 200 };
function plotOf(values, previousValues) {
  const scale = valueScale(Math.max(...values, ...previousValues, 0));
  const columns = columnLayout({ values, ...PLOT, max: scale.max });
  const line = linePoints({
    values: previousValues,
    columns,
    height: PLOT.height,
    max: scale.max,
  });
  return { scale, columns, line };
}

test("Linie (AK-3): je Säulenplatz ein Punkt über dessen Mitte, in der Höhe des Werts", () => {
  const { scale, columns, line } = plotOf([10, 20, 0, 40], [0, 20, 40, 10]);
  assert.equal(scale.max, 40);
  assert.equal(line.length, 4);
  assert.deepEqual(
    line.map((point) => point.x),
    columns.map((column) => column.center)
  );
  assert.deepEqual(
    line.map((point) => point.y),
    [200, 100, 0, 150]
  );
  // Gleicher Wert, gleiche Höhe: Der Punkt liegt auf der Oberkante der Säule.
  assert.equal(line[1].y, columns[1].bar.y);
});

test("Achse (AK-3): reicht bis zum höheren der beiden Höchstwerte – auch wenn der Vorzeitraum ihn hat", () => {
  const { scale, line } = plotOf([10, 20, 5], [70, 3, 0]);
  assert.equal(scale.max, 80);
  assert.ok(scale.ticks.at(-1) >= 70);
  // Kein Punkt über der Zeichenfläche, keiner unter der Grundlinie.
  for (const point of line) assert.ok(point.y >= 0 && point.y <= PLOT.height);
  assert.equal(line[0].y, PLOT.height - (70 / 80) * PLOT.height);
  // Ohne den Vorzeitraum reichte die Achse nur bis 20.
  assert.equal(valueScale(20).max, 20);
});

test("Linie (Hard Constraint 4): nie unter 0 und nie über der Zeichenfläche – auch bei Unsinn als Wert", () => {
  const values = [5, 5, 5, 5, 5, 5];
  const columns = columnLayout({ values, ...PLOT, max: 10 });
  const line = linePoints({
    values: [-3, 0, undefined, NaN, 25, 10],
    columns,
    height: PLOT.height,
    max: 10,
  });
  assert.deepEqual(
    line.map((point) => point.y),
    [200, 200, 200, 200, 0, 0]
  );
});

test("Linie (NAK-1): gerade Stücke von Wert zu Wert, keine Kurve – zwischen Null und Höchstwert schwingt nichts über oder unter", () => {
  // eine Null neben dem Höchstwert, beidseitig
  const { line } = plotOf([10, 10, 10, 10, 10], [0, 34, 0, 34, 34]);
  const path = linePath(line);

  // Nur M (Anfang) und L (gerade weiter): keine Kurven-, Bogen- oder
  // Glättungsbefehle.
  assert.match(path, /^M[\d.]+,[\d.]+( L[\d.]+,[\d.]+)+$/);
  assert.doesNotMatch(path, /[CSQTAcsqtahvHV]/);
  const commands = path.split(" ");
  assert.equal(commands.length, line.length);
  assert.ok(commands[0].startsWith("M"));
  assert.ok(commands.slice(1).every((command) => command.startsWith("L")));

  // Die Ecken des Pfads sind genau die Werte, in ihrer Reihenfolge.
  const corners = commands.map((command) =>
    command.slice(1).split(",").map(Number)
  );
  assert.deepEqual(
    corners,
    line.map((point) => [
      Math.round(point.x * 100) / 100,
      Math.round(point.y * 100) / 100,
    ])
  );
  // Zwischen zwei Ecken liegt eine Gerade: nie über dem höheren, nie unter
  // dem niedrigeren der beiden Werte – und damit nie unter der Grundlinie.
  const top = Math.min(...line.map((point) => point.y));
  for (const [, y] of corners) assert.ok(y >= top && y <= PLOT.height);
});

test("Linie: gepunktet, schmaler als die Säulen und mit Punktmarken – nicht nur über die Farbe zu erkennen (NAK-4)", () => {
  const [dash, gap] = PREVIOUS_LINE.dash.split(" ").map(Number);
  // Punkte: Strichlänge nahe 0 mit runden Enden, die Lücke größer als der Punkt
  assert.ok(dash < 1);
  assert.ok(gap > PREVIOUS_LINE.width);
  assert.ok(PREVIOUS_LINE.width <= 2);
  assert.ok(PREVIOUS_LINE.markerRadius * 2 > PREVIOUS_LINE.width);
  // Marken berühren einander nicht, solange es sie gibt.
  assert.ok(PREVIOUS_LINE.markerMinSlot >= PREVIOUS_LINE.markerRadius * 4);
});

// ---------------------------------------------------------------------------
// Tooltip mit zweiter Zeile (AK-5)
// ---------------------------------------------------------------------------

const MARGIN_LEFT = 44;
const MARGIN_RIGHT = 8;

/** Diagramm wie in TimelineChart.jsx: Säulen, Linie, Tooltip an jedem Platz. */
function chartOf(width, values, previousValues) {
  const plotWidth = Math.max(40, width - MARGIN_LEFT - MARGIN_RIGHT);
  const plotHeight = (width < 520 ? 200 : 240) - 12 - 26;
  const scale = valueScale(Math.max(...values, ...previousValues, 0));
  const columns = columnLayout({
    values,
    width: plotWidth,
    height: plotHeight,
    max: scale.max,
  });
  const line = linePoints({
    values: previousValues,
    columns,
    height: plotHeight,
    max: scale.max,
  });
  const place = (active, text, withLine = true) =>
    tooltipPlacement({
      columns,
      active,
      text,
      width,
      plotLeft: MARGIN_LEFT,
      plotHeight,
      ...(withLine ? { line } : {}),
    });
  return { columns, line, plotHeight, place };
}

test("Tooltip: Ohne Linie steht er, wo er vor KIE-537 stand", () => {
  const values = Array.from({ length: 30 }, (_, i) =>
    i % 3 === 2 ? 0 : 5 + i
  );
  const previousValues = values.map(() => 0);
  const { columns, plotHeight, place } = chartOf(960, values, previousValues);
  const text = "Di., 06.10.2026 — 37 Nachrichten";
  for (let active = 0; active < values.length; active++) {
    const without = tooltipPlacement({
      columns,
      active,
      text,
      width: 960,
      plotLeft: MARGIN_LEFT,
      plotHeight,
    });
    assert.deepEqual(place(active, text, false), without);
    assert.deepEqual(
      tooltipPlacement({
        columns,
        active,
        text,
        width: 960,
        plotLeft: MARGIN_LEFT,
        plotHeight,
        line: null,
      }),
      without
    );
  }
});

test("Tooltip (AK-5): verdeckt mit der Zeile „Vorzeitraum: N“ weder eine Säule noch die Linie oder eine Punktmarke – bei 30, 53 und 92 Plätzen, breit und schmal", () => {
  for (const count of [30, 53, 92])
    for (const width of [1130, 960, 390, 340]) {
      // Säulen und Linie mit Spitzen an verschiedenen Stellen
      const values = Array.from({ length: count }, (_, i) =>
        i % 9 === 4 ? 0 : 3 + ((i * 7) % 40)
      );
      const previousValues = Array.from({ length: count }, (_, i) =>
        i % 11 === 3 ? 95 : i % 5 === 0 ? 0 : 2 + ((i * 13) % 30)
      );
      const { columns, line, place } = chartOf(width, values, previousValues);
      const first = "KW 41 (05.10.–11.10.2026) — 1.234 Nachrichten";
      const second = previousValueLabel(1234, t);
      const text = first.length > second.length ? first : second;

      for (let active = 0; active < count; active++) {
        const placement = place(active, text);
        const where = `${count} Plätze, ${width} px, Platz ${active}`;
        // im Diagramm
        assert.ok(placement.from >= 0, where);
        assert.ok(placement.to <= width, where);
        // Unterkante des Tooltips: über jeder Säule, die er überspannt …
        for (const { bar } of columns) {
          if (!bar) continue;
          const left = MARGIN_LEFT + bar.x;
          if (left < placement.to && left + bar.width > placement.from)
            assert.ok(placement.y <= bar.y - TOOLTIP_GAP, where);
        }
        // … über jeder Punktmarke …
        const radius = PREVIOUS_LINE.markerRadius;
        for (const point of line) {
          const x = MARGIN_LEFT + point.x;
          if (x + radius > placement.from && x - radius < placement.to)
            assert.ok(placement.y <= point.y - radius - TOOLTIP_GAP, where);
        }
        // … und über der Linie an jeder Stelle seiner Breite.
        for (let x = placement.from; x <= placement.to; x += 1) {
          const at = x - MARGIN_LEFT;
          const i = line.findIndex(
            (point, index) =>
              line[index + 1] && point.x <= at && at <= line[index + 1].x
          );
          if (i < 0) continue;
          const [a, b] = [line[i], line[i + 1]];
          const y = a.y + ((b.y - a.y) * (at - a.x)) / (b.x - a.x);
          assert.ok(placement.y <= y - TOOLTIP_GAP + 0.001, where);
        }
      }
    }
});

test("Tooltip: Liegt die Linie über den Säulen, rückt er über die Linie; liegt sie darunter, bleibt er über den Säulen", () => {
  const values = Array.from({ length: 30 }, () => 20);
  const low = chartOf(
    960,
    values,
    values.map(() => 5)
  );
  const high = chartOf(
    960,
    [...values.slice(1), 80],
    values.map(() => 60)
  );
  const text = "Di., 06.10.2026 — 20 Nachrichten";

  // Linie unter den Säulen: dieselbe Lage wie ohne Linie
  assert.deepEqual(low.place(15, text), low.place(15, text, false));
  // Linie über den Säulen: Der Tooltip steht höher – über der Punktmarke.
  const lifted = high.place(15, text);
  assert.ok(lifted.y < high.place(15, text, false).y);
  assert.equal(
    lifted.y,
    high.line[15].y - PREVIOUS_LINE.markerRadius - TOOLTIP_GAP
  );
  // Waagerecht ändert die Linie nichts.
  const { y: _y, ...horizontal } = lifted;
  const { y: _plainY, ...plain } = high.place(15, text, false);
  assert.deepEqual(horizontal, plain);
});
