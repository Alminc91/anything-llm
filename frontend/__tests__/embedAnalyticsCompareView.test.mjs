// KIE-537: Vergleich mit dem Vorzeitraum – was Diagramm und Kennzahlen-Streifen
// zu einem gegebenen Stand zeichnen, serverseitig gerendert
// (helpers/renderSettingsPage.mjs). Effekte laufen dabei nicht: Schalter,
// Anfragen, Tooltip und Tabelle prüft embedAnalyticsCompare.test.mjs; Themes,
// Graustufen und Layout gehören in den Browser-Test.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import {
  createRenderer,
  hasFrontendDeps,
} from "./helpers/renderSettingsPage.mjs";
import { fixClock } from "./helpers/fixedClock.mjs";
import { PREVIOUS_LINE, addDays } from "../src/utils/analyticsTimeline.js";

const DIR = "/src/pages/GeneralSettings/ChatEmbedWidgets/EmbedAnalytics";
const CHART = `${DIR}/TimelineChart.jsx`;
const KPI = `${DIR}/StatisticsGrid.jsx`;
const LOCATION = "/settings/chatbot/conversations";
const skip = hasFrontendDeps
  ? false
  : "frontend/node_modules nicht installiert";

const BAR = "var(--theme-analytics-bar)";
const TEXT = "var(--theme-text-primary)";
const count = (html, pattern) => (html.match(pattern) ?? []).length;
const columns = (html) => count(html, /<g data-column=""/g);
const bars = (html) => count(html, /<path data-bar=""/g);
/** Sichtbarer Text ohne Markup. */
const textOf = (html) =>
  html
    .replace(/<!-- -->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
/** Die Gruppe der Linie des Vorzeitraums; null ohne Linie. */
const lineOf = (html) =>
  html.match(/<g data-previous-line=""[^>]*>(.*?)<\/g>/)?.[0] ?? null;
/** Ecken der Linie [x, y], je Säulenplatz eine. */
const pointsOf = (line) =>
  line
    .match(/<path d="([^"]+)"/)[1]
    .split(" ")
    .map((command) => command.slice(1).split(",").map(Number));
/** Punktmarken der Linie [x, y, Radius]. */
const markersOf = (line) =>
  [
    ...line.matchAll(
      /<circle data-previous-marker="" cx="([^"]+)" cy="([^"]+)" r="([^"]+)"/g
    ),
  ].map((match) => match.slice(1).map(Number));
/** Plätze (Index), an denen eine Punktmarke sitzt. */
const markedPlaces = (line) => {
  const points = pointsOf(line);
  return markersOf(line).map(([cx, cy]) => {
    const at = points.findIndex(
      ([x, y]) => Math.abs(x - cx) < 0.01 && Math.abs(y - cy) < 0.01
    );
    assert.ok(at >= 0, `Marke bei ${cx},${cy} liegt auf keinem Wert`);
    return at;
  });
};
/** Die Legende; null ohne Legende. */
const legendOf = (html) =>
  html.match(/<ul data-chart-legend=""[^>]*>.*?<\/ul>/)?.[0] ?? null;
const switchOf = (html) =>
  html.match(/<button[^>]*data-compare-switch=""[^>]*>.*?<\/button>/)?.[0];
/** Beschriftungen der Wertachse (rechtsbündig vor der Zeichenfläche). */
const axisValues = (html) =>
  [...html.matchAll(/<text x="-8"[^>]*>([^<]*)<\/text>/g)].map(([, text]) =>
    Number(text.replace(/\./g, ""))
  );
/** Zeile der Veränderung je Kennzahl-Feld: [Feld, Text, Tooltip]. */
const changesOf = (html) =>
  [...html.matchAll(/<div data-kpi="([^"]+)"[^>]*>(.*?)<\/dd><\/div>/g)].map(
    ([, key, inner]) => {
      const change = inner.match(
        /<span data-kpi-change="" title="([^"]*)"[^>]*>(.*?)<\/span>(?=<\/dd>|$)/
      );
      if (!change) return [key, null, null];
      // ohne den Text nur für Screenreader
      const visible = change[2].replace(
        /<span class="sr-only">.*?<\/span>/,
        ""
      );
      return [key, textOf(visible), change[1]];
    }
  );

/** Zeile unter dem Kennzahlen-Streifen (das ganze Element); null ohne. */
const compareLineOf = (html) =>
  html.match(/<p data-compare-line=""[^>]*>.*?<\/p>/)?.[0] ?? null;

const FROM = "2026-09-13";
function dayBuckets(from, days, value) {
  return Array.from({ length: days }, (_, i) => {
    const messages = value(i);
    return {
      start: addDays(from, i),
      end: addDays(from, i),
      partial: false,
      messages,
      conversations: Math.ceil(messages / 3),
    };
  });
}
const sum = (buckets, key) =>
  buckets.reduce((total, bucket) => total + bucket[key], 0);

/**
 * Antwort von analytics/summary für Tage ab from – mit Vorzeitraum (dieselbe
 * Zahl Tage unmittelbar davor), wenn previous die Werte nennt.
 */
function daySummary({
  from = FROM,
  days = 30,
  value,
  previous,
  totals,
  ...overrides
}) {
  const buckets = dayBuckets(from, days, value);
  const before = previous
    ? dayBuckets(addDays(from, -days), days, previous)
    : null;
  return {
    success: true,
    granularity: "day",
    fromDay: from,
    toDay: addDays(from, days - 1),
    firstLedgerDay: "2026-01-01",
    totals: {
      messages: sum(buckets, "messages"),
      conversations: sum(buckets, "conversations"),
      feedbackPositive: 9,
      feedbackNegative: 3,
    },
    buckets,
    ...(before
      ? {
          previous: {
            available: true,
            fromDay: addDays(from, -days),
            toDay: addDays(from, -1),
            totals: {
              messages: sum(before, "messages"),
              conversations: sum(before, "conversations"),
              feedbackPositive: 6,
              feedbackNegative: 4,
              ...totals,
            },
            buckets: before,
          },
        }
      : {}),
    ...overrides,
  };
}

// 30 Tage, an jedem dritten Tag keine Nachricht; im Vorzeitraum liegt der
// Höchstwert (70) höher als im Zeitraum (33) und steht neben einer Null.
const CURRENT = (i) => (i % 3 === 2 ? 0 : 5 + i);
const PREVIOUS = (i) => (i === 11 ? 0 : i === 12 ? 70 : i === 13 ? 0 : 4 + i);
const COMPARED = daySummary({ value: CURRENT, previous: PREVIOUS });
const PLAIN = daySummary({ value: CURRENT });
// Kein Tag mit Nachricht, der Vorzeitraum wie oben.
const EMPTY_NOW = daySummary({ value: () => 0, previous: PREVIOUS });

/** Die 24 Stunden eines Tages. */
const hours = (day, value) =>
  Array.from({ length: 24 }, (_, hour) => ({
    start: day,
    end: day,
    partial: false,
    hour,
    messages: value(hour),
    conversations: 0,
  }));

let renderer;
before(async () => {
  if (hasFrontendDeps) renderer = await createRenderer();
});
after(async () => {
  await renderer?.close();
});

const render = (modulePath, props, options = {}) =>
  renderer.render(modulePath, { location: LOCATION, props, ...options });

// ---------------------------------------------------------------------------
// Schalter aus (AK-8, Hard Constraint 6)
// ---------------------------------------------------------------------------

test(
  "Schalter aus (AK-8): Der Vergleich ist standardmäßig aus – ein Schalter „Vorzeitraum vergleichen“, sonst das Diagramm von KIE-536: keine Linie, keine Legende",
  { skip },
  async () => {
    const html = await render(CHART, { summary: PLAIN, loading: false });

    const toggle = switchOf(html);
    assert.match(toggle, /role="switch"/);
    assert.match(toggle, /aria-checked="false"/);
    assert.match(toggle, /^<button type="button"/);
    assert.equal(textOf(toggle), "Vorzeitraum vergleichen");
    assert.equal(count(html, /role="switch"/g), 1);

    assert.equal(lineOf(html), null);
    assert.equal(legendOf(html), null);
    assert.doesNotMatch(html, /legend/i);
    assert.doesNotMatch(html, /data-previous|data-compare-note/);
    assert.doesNotMatch(textOf(html), /Vorzeitraum(?! vergleichen)/);
    assert.equal(columns(html), 30);
    assert.equal(bars(html), 20);
    // Die Säulenfarbe steht nur an den Säulen.
    assert.equal(count(html, /theme-analytics-bar/g), 20);
    assert.deepEqual(axisValues(html), [0, 10, 20, 30, 40]);
  }
);

test(
  "Schalter aus: Nennt die Antwort noch einen Vorzeitraum, wird er nicht gezeigt – dieselbe Darstellung wie ohne",
  { skip },
  async () => {
    const plain = await render(CHART, { summary: PLAIN, loading: false });
    for (const props of [
      { summary: PLAIN, loading: false, compare: false },
      { summary: COMPARED, loading: false },
      { summary: COMPARED, loading: false, compare: false },
    ])
      assert.equal(await render(CHART, props), plain);

    const kpi = await render(KPI, { summary: PLAIN, loading: false });
    for (const props of [
      { summary: PLAIN, loading: false, compare: false },
      { summary: COMPARED, loading: false },
      { summary: COMPARED, loading: false, compare: false },
    ])
      assert.equal(await render(KPI, props), kpi);
    assert.doesNotMatch(
      kpi,
      /data-kpi-change|data-compare-line|Vorzeitraum|Vergleich|Veränderung/
    );
  }
);

test(
  "Schalter an, die Antwort ist noch ohne Vergleich geladen: Säulen und Kennzahlen bleiben stehen, noch keine Linie und kein „kein Vergleich“",
  { skip },
  async () => {
    const plain = await render(CHART, { summary: PLAIN, loading: false });
    const html = await render(CHART, {
      summary: PLAIN,
      loading: true,
      compare: true,
    });

    assert.match(switchOf(html), /aria-checked="true"/);
    assert.equal(lineOf(html), null);
    assert.equal(legendOf(html), null);
    assert.doesNotMatch(html, /data-compare-note/);
    // dieselben Säulen wie ausgeschaltet
    const barsOf = (source) =>
      [...source.matchAll(/<path data-bar="" d="([^"]+)"/g)].map(
        (match) => match[1]
      );
    assert.deepEqual(barsOf(html), barsOf(plain));

    const kpi = await render(KPI, {
      summary: PLAIN,
      loading: true,
      compare: true,
    });
    assert.doesNotMatch(kpi, /data-kpi-change|data-compare-line/);
  }
);

// ---------------------------------------------------------------------------
// Linie und Legende (AK-3, NAK-1, NAK-4)
// ---------------------------------------------------------------------------

test(
  "Linie und Legende (AK-3): gepunktete Linie über den Säulen, Legende „Gewählter Zeitraum“ / „Vorzeitraum“, die Achse reicht bis zum höheren Höchstwert",
  { skip },
  async () => {
    const html = await render(CHART, {
      summary: COMPARED,
      loading: false,
      compare: true,
    });
    assert.match(switchOf(html), /aria-checked="true"/);

    // Linie: ein Pfad, gepunktet, ohne Fläche
    const line = lineOf(html);
    assert.ok(line, "keine Linie");
    assert.equal(count(html, /<g data-previous-line=""/g), 1);
    const [, path] = line.match(/<path d="([^"]+)"/);
    assert.match(line, /<path [^>]*fill="none"/);
    assert.match(line, new RegExp(`stroke-dasharray="${PREVIOUS_LINE.dash}"`));
    assert.match(line, /stroke-linecap="round"/);
    assert.match(line, new RegExp(`stroke-width="${PREVIOUS_LINE.width}"`));
    // 30 Werte, gerade verbunden
    assert.equal(path.split(" ").length, 30);
    assert.match(path, /^M[\d.]+,[\d.]+( L[\d.]+,[\d.]+){29}$/);

    // Sie liegt über den Säulen (später gezeichnet) und vor der Zeitachse.
    const lastBar = html.lastIndexOf("<path data-bar");
    const firstTick = html.indexOf("<text data-tick");
    const lineAt = html.indexOf("<g data-previous-line");
    assert.ok(lastBar < lineAt && lineAt < firstTick);

    // Legende: beide Serien, mit den Tagen des Vorzeitraums
    const legend = legendOf(html);
    assert.ok(legend, "keine Legende");
    assert.equal(
      textOf(legend),
      "Gewählter Zeitraum Vorzeitraum 14.08.2026–12.09.2026"
    );
    assert.equal(count(legend, /<li /g), 2);
    assert.match(legend, /aria-label="Legende"/);
    // Sie steht vor dem Diagramm, nicht darin.
    assert.ok(html.indexOf("data-chart-legend") < html.indexOf("<svg width="));

    // Achse: Höchstwert im Zeitraum 33, im Vorzeitraum 70 → bis 80
    assert.deepEqual(axisValues(html), [0, 20, 40, 60, 80]);
    // Der höchste Punkt der Linie liegt auf 70 von 80 der Zeichenfläche.
    const ys = path
      .split(" ")
      .map((command) => Number(command.slice(1).split(",")[1]));
    const plotHeight = 240 - 12 - 26;
    assert.equal(
      Math.min(...ys),
      Math.round(plotHeight * (1 - 70 / 80) * 100) / 100
    );
    assert.equal(ys[12], Math.min(...ys));
    // Die Nullen daneben liegen auf der Grundlinie, nicht darunter (NAK-1).
    assert.equal(ys[11], plotHeight);
    assert.equal(ys[13], plotHeight);
    assert.ok(ys.every((y) => y >= 0 && y <= plotHeight));
  }
);

test(
  "Linie: in der Textfarbe des Themes, nicht in einer zweiten Akzentfarbe – die Säulen bleiben das Hauptelement",
  { skip },
  async () => {
    const html = await render(CHART, {
      summary: COMPARED,
      loading: false,
      compare: true,
    });
    const line = lineOf(html);

    assert.match(
      line,
      new RegExp(`<path [^>]*stroke="${TEXT.replace(/[()]/g, "\\$&")}"`)
    );
    assert.doesNotMatch(line, /theme-analytics-bar/);
    // Säulen: unverändert alle in der einen Akzentfarbe, mit voller Deckkraft
    const fills = [...html.matchAll(/<path data-bar=""[^>]* fill="([^"]+)"/g)];
    assert.equal(fills.length, 20);
    assert.deepEqual([...new Set(fills.map((match) => match[1]))], [BAR]);
    assert.equal(count(html, /<path data-bar=""[^>]* fill-opacity="1"/g), 20);
    // Die Akzentfarbe steht sonst nur am Muster der Legende.
    assert.equal(count(html, /theme-analytics-bar/g), 21);
    assert.equal(count(legendOf(html), /theme-analytics-bar/g), 1);
    // Kein fest verdrahteter Farbwert, keine weitere Farbe im Diagramm.
    assert.doesNotMatch(html, /#[0-9a-f]{6}\b/i);
    const colours = new Set(
      [...html.matchAll(/(?:fill|stroke)="(var\([^"]+\))"/g)].map(
        (match) => match[1]
      )
    );
    assert.deepEqual([...colours].sort(), [
      "var(--theme-analytics-bar)",
      "var(--theme-analytics-grid)",
      "var(--theme-analytics-text-muted)",
      "var(--theme-bg-primary)",
      "var(--theme-text-primary)",
    ]);
  }
);

test(
  "Linie (NAK-4): nicht nur über die Farbe erkennbar – gepunktet mit Punktmarken an den Werten gegen gefüllte Säulen, dasselbe Muster in der Legende",
  { skip },
  async () => {
    const html = await render(CHART, {
      summary: COMPARED,
      loading: false,
      compare: true,
    });
    const line = lineOf(html);

    // Je Wert über 0 eine Punktmarke: 30 Werte, zwei davon 0 (neben dem
    // Höchstwert) – dort läuft die gepunktete Linie ohne Marke durch.
    assert.equal(pointsOf(line).length, 30);
    assert.equal(count(line, /<circle data-previous-marker=""/g), 28);
    assert.equal(
      count(
        line,
        new RegExp(`<circle [^>]*r="${PREVIOUS_LINE.markerRadius}"`, "g")
      ),
      28
    );
    assert.deepEqual(
      markedPlaces(line),
      Array.from({ length: 30 }, (_, i) => i).filter((i) => PREVIOUS(i) > 0)
    );
    assert.ok(!markedPlaces(line).includes(11));
    assert.ok(markedPlaces(line).includes(12));
    // Keine Marke liegt auf der Grundlinie.
    const plotHeight = 240 - 12 - 26;
    assert.ok(markersOf(line).every(([, cy]) => cy < plotHeight));
    // Legende: Säulenform für den Zeitraum, gepunktete Linie mit Marke für
    // den Vorzeitraum
    const [current, previous] = legendOf(html).split("</li>");
    assert.match(
      current,
      /<path d="M[^"]+Z" fill="var\(--theme-analytics-bar\)"/
    );
    assert.doesNotMatch(current, /stroke-dasharray|<circle/);
    assert.match(
      previous,
      new RegExp(`<line [^>]*stroke-dasharray="${PREVIOUS_LINE.dash}"`)
    );
    assert.match(previous, /<circle /);
    assert.doesNotMatch(previous, /theme-analytics-bar/);
  }
);

test(
  "Linie: nimmt keine Eingaben an und ist für Screenreader kein eigenes Element – jeder Säulenplatz nennt seinen Vorzeitraumwert",
  { skip },
  async () => {
    const html = await render(CHART, {
      summary: COMPARED,
      loading: false,
      compare: true,
    });

    assert.match(
      html,
      /<g data-previous-line="" aria-hidden="true" pointer-events="none">/
    );
    // Säulenplätze: unverändert viele, ein Tab-Stopp
    assert.equal(columns(html), 30);
    assert.equal(count(html, /<g data-column="" role="button"/g), 20);
    assert.equal(count(html, /<g data-column=""[^>]* tabindex="0"/g), 1);
    // 13.09. (5 Nachrichten, am 14.08. davor 4), mit Hinweis auf den Filter –
    // der Abschnitt des Vorzeitraums steht dabei, in derselben Schreibweise.
    assert.match(
      html,
      /aria-label="So\., 13\.09\.2026 — 5 Nachrichten\. Vorzeitraum: Fr\., 14\.08\.2026 — 4 Nachrichten\. Die Eingabetaste /
    );
    // 15.09. ohne Nachricht (keine Schaltfläche), am 16.08. davor 6
    assert.match(
      html,
      /aria-label="Di\., 15\.09\.2026 — 0 Nachrichten\. Vorzeitraum: So\., 16\.08\.2026 — 6 Nachrichten"/
    );
    // Jeder Platz nennt seinen Abschnitt – keiner nur die Zahl.
    assert.equal(
      count(
        html,
        /<g data-column=""[^>]* aria-label="[^"]*\. Vorzeitraum: [A-Z][a-z]\., \d\d\.\d\d\.2026 — [\d.]+ Nachricht(en)?[."]/g
      ),
      30
    );
    assert.doesNotMatch(html, /Vorzeitraum: \d/);
    // Zusammenfassung des Diagramms nennt die zweite Serie
    assert.match(
      html,
      /aria-label="Säulendiagramm: Nachrichten pro Tag, 13\.09\.2026 bis 12\.10\.2026\. Summe [\d.]+, höchster Wert 33\. Vorzeitraum 14\.08\.2026–12\.09\.2026 als gepunktete Linie: Summe [\d.]+, höchster Wert 70\. Mit den Pfeiltasten /
    );
    // Der Tooltip-Text kollidiert nicht mit dem einzigen Tooltip-Element.
    assert.equal(count(html, /pointer-events-none/g), 0);
  }
);

test(
  "Linie bei vielen Säulenplätzen (92 Tage): gepunktete Linie ohne Punktmarken – sie berührten einander",
  { skip },
  async () => {
    const html = await render(CHART, {
      summary: daySummary({
        from: "2026-07-13",
        days: 92,
        value: (i) => 4 + ((i * 11) % 23),
        previous: (i) => 2 + ((i * 7) % 17),
      }),
      loading: false,
      compare: true,
    });
    const line = lineOf(html);
    assert.ok(line);
    assert.equal(line.match(/<path d="([^"]+)"/)[1].split(" ").length, 92);
    assert.equal(count(line, /<circle/g), 0);
    assert.equal(columns(html), 92);
  }
);

test(
  "Einzelner Tag (AK-7): Die Linie zeigt die 24 Stundenwerte des Vortags, die Legende nennt den Tag",
  { skip },
  async () => {
    const html = await render(CHART, {
      loading: false,
      compare: true,
      summary: {
        granularity: "hour",
        fromDay: "2026-10-12",
        toDay: "2026-10-12",
        firstLedgerDay: "2026-01-01",
        totals: {
          messages: 182,
          conversations: 0,
          feedbackPositive: 0,
          feedbackNegative: 0,
        },
        buckets: hours("2026-10-12", (hour) =>
          hour >= 8 && hour <= 20 ? hour : 0
        ),
        previous: {
          available: true,
          fromDay: "2026-10-11",
          toDay: "2026-10-11",
          totals: {
            messages: 48,
            conversations: 0,
            feedbackPositive: 0,
            feedbackNegative: 0,
          },
          buckets: hours("2026-10-11", (hour) => (hour % 2 ? 4 : 0)),
        },
      },
    });

    assert.equal(columns(html), 24);
    const line = lineOf(html);
    assert.equal(line.match(/<path d="([^"]+)"/)[1].split(" ").length, 24);
    // Marken an den zwölf Stunden mit Nachrichten (jede ungerade)
    assert.deepEqual(
      markedPlaces(line),
      [1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21, 23]
    );
    assert.equal(
      textOf(legendOf(html)),
      "Gewählter Zeitraum Vorzeitraum 11.10.2026"
    );
    // Stunden: dieselbe Stunde des Vortags
    assert.match(
      html,
      /aria-label="Mo\., 12\.10\.2026, 13–14 Uhr — 13 Nachrichten\. Vorzeitraum: So\., 11\.10\.2026, 13–14 Uhr — 4 Nachrichten"/
    );
    assert.match(
      html,
      /aria-label="Mo\., 12\.10\.2026, 0–1 Uhr — 0 Nachrichten\. Vorzeitraum: So\., 11\.10\.2026, 0–1 Uhr — 0 Nachrichten"/
    );
  }
);

test(
  "Stundenansicht mit vielen Nullwerten („Gestern“): Punktmarken nur an Stunden mit Wert im Vorzeitraum – keine Punktreihe auf der Grundlinie; die gepunktete Linie läuft durch die Nullwerte, die Legende bleibt",
  { skip },
  async () => {
    const totals = (messages) => ({
      messages,
      conversations: 0,
      feedbackPositive: 0,
      feedbackNegative: 0,
    });
    // wie in der Abnahme: 12.10. mit 2 und 3 Nachrichten um 11 und 12 Uhr,
    // am 11.10. vier Nachrichten um 17 Uhr – sonst nichts
    const yesterday = (previous) => ({
      granularity: "hour",
      fromDay: "2026-10-12",
      toDay: "2026-10-12",
      firstLedgerDay: "2026-01-01",
      totals: totals(5),
      buckets: hours("2026-10-12", (hour) =>
        hour === 11 ? 2 : hour === 12 ? 3 : 0
      ),
      previous: {
        available: true,
        fromDay: "2026-10-11",
        toDay: "2026-10-11",
        totals: totals(4),
        buckets: hours("2026-10-11", previous),
      },
    });
    const html = await render(CHART, {
      loading: false,
      compare: true,
      summary: yesterday((hour) => (hour === 17 ? 4 : 0)),
    });
    const line = lineOf(html);
    const plotHeight = 240 - 12 - 26;

    // Die Linie: 24 Werte, gepunktet, 23 davon auf der Grundlinie
    const points = pointsOf(line);
    assert.equal(points.length, 24);
    assert.equal(points.filter(([, y]) => y === plotHeight).length, 23);
    assert.match(line, new RegExp(`stroke-dasharray="${PREVIOUS_LINE.dash}"`));
    // eine Marke, am Wert von 17 Uhr (4 von 4 der Achse: Oberkante)
    assert.deepEqual(markedPlaces(line), [17]);
    assert.deepEqual(
      markersOf(line).map(([, cy, radius]) => [cy, radius]),
      [[0, PREVIOUS_LINE.markerRadius]]
    );
    assert.equal(count(html, /<circle data-previous-marker=""/g), 1);
    // Legende unverändert: gepunktete Linie mit Marke
    const [, previous] = legendOf(html).split("</li>");
    assert.match(
      previous,
      new RegExp(`<line [^>]*stroke-dasharray="${PREVIOUS_LINE.dash}"`)
    );
    assert.equal(count(previous, /<circle /g), 1);
    // Jeder Platz nennt weiter seinen Wert – auch die ohne Marke.
    assert.match(
      html,
      /aria-label="Mo\., 12\.10\.2026, 3–4 Uhr — 0 Nachrichten\. Vorzeitraum: So\., 11\.10\.2026, 3–4 Uhr — 0 Nachrichten"/
    );

    // Vorzeitraum ganz ohne Wert: die gepunktete Linie auf der Grundlinie,
    // keine Marke – erkennbar bleibt sie am Muster und an der Legende.
    const flat = await render(CHART, {
      loading: false,
      compare: true,
      summary: yesterday(() => 0),
    });
    assert.equal(pointsOf(lineOf(flat)).length, 24);
    assert.deepEqual(markersOf(lineOf(flat)), []);
    assert.ok(legendOf(flat));
  }
);

test(
  "Wochen: Die Legende nennt die Tage der Linie (ganze Kalenderwochen), nicht die der Kennzahlen",
  { skip },
  async () => {
    const week = (start, end, partial, messages) => ({
      start,
      end,
      partial,
      messages,
      conversations: 1,
    });
    const summary = {
      granularity: "week",
      fromDay: "2026-09-30",
      toDay: "2026-10-12",
      firstLedgerDay: "2026-01-01",
      totals: {
        messages: 30,
        conversations: 3,
        feedbackPositive: 0,
        feedbackNegative: 0,
      },
      buckets: [
        week("2026-09-30", "2026-10-04", true, 10),
        week("2026-10-05", "2026-10-11", false, 15),
        week("2026-10-12", "2026-10-12", true, 5),
      ],
      previous: {
        available: true,
        // 13 Tage unmittelbar vor dem 30.09.
        fromDay: "2026-09-17",
        toDay: "2026-09-29",
        totals: {
          messages: 20,
          conversations: 2,
          feedbackPositive: 0,
          feedbackNegative: 0,
        },
        // drei ganze Kalenderwochen vor der Woche der ersten Säule
        buckets: [
          week("2026-09-07", "2026-09-13", false, 7),
          week("2026-09-14", "2026-09-20", false, 12),
          week("2026-09-21", "2026-09-27", false, 9),
        ],
      },
    };
    const html = await render(CHART, {
      summary,
      loading: false,
      compare: true,
    });

    assert.equal(
      textOf(legendOf(html)),
      "Gewählter Zeitraum Vorzeitraum 07.09.2026–27.09.2026"
    );
    // Jeder Platz nennt die Kalenderwoche, deren Wert die Linie dort zeigt –
    // auch der angeschnittene: Im Vorzeitraum steht eine ganze Woche.
    assert.match(
      html,
      /aria-label="KW 41 \(05\.10\.–11\.10\.2026\) — 15 Nachrichten\. Vorzeitraum: KW 38 \(14\.09\.–20\.09\.2026\) — 12 Nachrichten\./
    );
    assert.match(
      html,
      /aria-label="KW 40 – ab 30\.09\. — 10 Nachrichten\. Vorzeitraum: KW 37 \(07\.09\.–13\.09\.2026\) — 7 Nachrichten\./
    );
    // Die Kennzahlen nennen ihre eigenen Tage – im Tooltip der Felder und
    // sichtbar in der Zeile unter dem Streifen: gleich viele Kalendertage
    // unmittelbar davor, nicht die Kalenderwochen der Linie.
    const kpi = await render(KPI, { summary, loading: false, compare: true });
    assert.deepEqual(changesOf(kpi)[0], [
      "messages",
      "+50 % ggü. Vorzeitraum (20)",
      "Vorzeitraum: 17.09.2026–29.09.2026",
    ]);
    assert.equal(
      textOf(compareLineOf(kpi)),
      "Veränderung gegenüber dem Vorzeitraum 17.09.2026–29.09.2026."
    );
    assert.doesNotMatch(kpi, /07\.09\.2026|27\.09\.2026/);
    assert.doesNotMatch(html, /17\.09\.2026|29\.09\.2026/);
  }
);

// ---------------------------------------------------------------------------
// Kein Vergleich ohne Daten (AK-6, Hard Constraint 5)
// ---------------------------------------------------------------------------

const UNAVAILABLE = {
  ...COMPARED,
  firstLedgerDay: "2026-09-01",
  previous: { ...COMPARED.previous, available: false },
};

test(
  "Kein Vergleich (AK-6): keine Linie, keine Legende – das Diagramm nennt den Tag, ab dem Zählwerte vorliegen; Säulen und Achse wie ohne Vergleich",
  { skip },
  async () => {
    const html = await render(CHART, {
      summary: UNAVAILABLE,
      loading: false,
      compare: true,
    });
    const plain = await render(CHART, {
      summary: { ...PLAIN, firstLedgerDay: "2026-09-01" },
      loading: false,
    });

    assert.match(switchOf(html), /aria-checked="true"/);
    assert.equal(lineOf(html), null);
    assert.equal(legendOf(html), null);
    assert.match(
      html,
      /<p data-compare-note=""[^>]*>Kein Vergleich verfügbar: Der Vorzeitraum beginnt vor dem 01\.09\.2026, dem ersten Tag mit Zählwerten\.<\/p>/
    );
    // Die Werte des Vorzeitraums erscheinen nirgends – auch die 70 nicht.
    assert.doesNotMatch(html, /Vorzeitraum: \d/);
    assert.deepEqual(axisValues(html), [0, 10, 20, 30, 40]);
    // Bis auf Schalter und Angabe dieselbe Darstellung wie ohne Vergleich
    const without = (source) =>
      source
        .replace(/<button[^>]*data-compare-switch.*?<\/button>/, "")
        .replace(/<p data-compare-note.*?<\/p>/, "");
    assert.equal(without(html), without(plain));
  }
);

test(
  "Kein Vergleich: ein Widget ohne jeden Zählwert – der Leerzustand sagt es schon, keine zweite Angabe",
  { skip },
  async () => {
    const html = await render(CHART, {
      loading: false,
      compare: true,
      summary: {
        ...UNAVAILABLE,
        firstLedgerDay: null,
        totals: {
          messages: 0,
          conversations: 0,
          feedbackPositive: 0,
          feedbackNegative: 0,
        },
      },
    });
    assert.match(html, /data-chart-frame="empty"/);
    assert.doesNotMatch(html, /data-compare-note|data-previous-line|legend/);
  }
);

// ---------------------------------------------------------------------------
// Zeitraum ohne Nachrichten, Vorzeitraum mit Werten (AK-7: „Heute“ vor der
// ersten Nachricht)
// ---------------------------------------------------------------------------

test(
  "Zeitraum ohne Nachrichten, Vorzeitraum mit Werten: kein Leerzustand – Linie und Legende über Plätzen ohne Säulen, der Hinweis steht als Zeile darüber",
  { skip },
  async () => {
    const html = await render(CHART, {
      loading: false,
      compare: true,
      summary: EMPTY_NOW,
    });
    const compared = await render(CHART, {
      summary: COMPARED,
      loading: false,
      compare: true,
    });

    assert.doesNotMatch(html, /data-chart-frame/);
    // Plätze wie sonst, nur ohne Säulen – keiner ist eine Schaltfläche.
    assert.equal(columns(html), 30);
    assert.equal(bars(html), 0);
    assert.equal(count(html, /<g data-column="" role="img"/g), 30);
    assert.equal(count(html, /<g data-column=""[^>]* tabindex="0"/g), 1);
    // Die Linie ist dieselbe wie über den Säulen: Die Achse kommt aus den
    // Werten des Vorzeitraums (Höchstwert 70 → bis 80).
    assert.ok(lineOf(html), "keine Linie");
    assert.equal(lineOf(html), lineOf(compared));
    assert.deepEqual(axisValues(html), [0, 20, 40, 60, 80]);
    assert.equal(legendOf(html), legendOf(compared));
    // Die Säulenfarbe steht nur noch am Muster der Legende.
    assert.equal(count(html, /theme-analytics-bar/g), 1);

    // Der Hinweis des Leerzustands: eine Zeile über Legende und Diagramm
    assert.equal(count(html, /Keine Nachrichten im gewählten Zeitraum/g), 1);
    assert.match(
      html,
      /<p data-chart-note=""[^>]*>Keine Nachrichten im gewählten Zeitraum<\/p>/
    );
    const noteAt = html.indexOf("data-chart-note");
    assert.ok(noteAt < html.indexOf("data-chart-legend"));
    assert.ok(noteAt < html.indexOf("<svg width="));

    // Jeder Platz nennt beide Werte, die Zusammenfassung beide Serien.
    assert.match(
      html,
      /aria-label="So\., 13\.09\.2026 — 0 Nachrichten\. Vorzeitraum: Fr\., 14\.08\.2026 — 4 Nachrichten"/
    );
    assert.match(
      html,
      /aria-label="Fr\., 25\.09\.2026 — 0 Nachrichten\. Vorzeitraum: Mi\., 26\.08\.2026 — 70 Nachrichten"/
    );
    assert.match(
      html,
      /Summe 0, höchster Wert 0\. Vorzeitraum 14\.08\.2026–12\.09\.2026 als gepunktete Linie: Summe [\d.]+, höchster Wert 70\./
    );
  }
);

test(
  "Einzelner Tag ohne Nachricht (AK-7): „Heute“ vor der ersten Nachricht – die Linie zeigt die 24 Stundenwerte des Vortags",
  { skip },
  async () => {
    const totals = (messages) => ({
      messages,
      conversations: 0,
      feedbackPositive: 0,
      feedbackNegative: 0,
    });
    const html = await render(CHART, {
      loading: false,
      compare: true,
      summary: {
        granularity: "hour",
        fromDay: "2026-10-13",
        toDay: "2026-10-13",
        firstLedgerDay: "2026-01-01",
        totals: totals(0),
        buckets: hours("2026-10-13", () => 0),
        previous: {
          available: true,
          fromDay: "2026-10-12",
          toDay: "2026-10-12",
          totals: totals(143),
          buckets: hours("2026-10-12", (hour) =>
            hour >= 8 && hour <= 18 ? hour : 0
          ),
        },
      },
    });

    assert.doesNotMatch(html, /data-chart-frame/);
    assert.equal(columns(html), 24);
    assert.equal(bars(html), 0);
    const line = lineOf(html);
    assert.ok(line, "keine Linie");
    const ys = line
      .match(/<path d="([^"]+)"/)[1]
      .split(" ")
      .map((command) => Number(command.slice(1).split(",")[1]));
    assert.equal(ys.length, 24);
    // 18 Uhr ist der Höchstwert (18 von 20 der Achse), nachts die Grundlinie.
    const plotHeight = 240 - 12 - 26;
    assert.deepEqual(axisValues(html), [0, 5, 10, 15, 20]);
    assert.equal(ys[18], Math.round(plotHeight * (1 - 18 / 20) * 100) / 100);
    assert.equal(ys[3], plotHeight);
    // Marken an den elf Stunden mit Nachrichten (8–18 Uhr)
    assert.deepEqual(
      markedPlaces(line),
      [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]
    );
    assert.equal(
      textOf(legendOf(html)),
      "Gewählter Zeitraum Vorzeitraum 12.10.2026"
    );
    assert.match(
      html,
      /<p data-chart-note=""[^>]*>Keine Nachrichten im gewählten Zeitraum<\/p>/
    );
    assert.match(
      html,
      /aria-label="Di\., 13\.10\.2026, 9–10 Uhr — 0 Nachrichten\. Vorzeitraum: Mo\., 12\.10\.2026, 9–10 Uhr — 9 Nachrichten"/
    );
  }
);

test(
  "Leerzustand mit Vergleich: Ist auch der Vorzeitraum ohne Nachrichten, bleibt es beim Hinweis im Rahmen – keine Linie, keine Legende, keine Plätze",
  { skip },
  async () => {
    const empty = daySummary({ value: () => 0 });
    const plain = await render(CHART, { summary: empty, loading: false });
    assert.match(plain, /data-chart-frame="empty"/);
    const withoutSwitch = (source) =>
      source.replace(/<button[^>]*data-compare-switch.*?<\/button>/, "");

    for (const props of [
      // Vorzeitraum ebenfalls leer
      {
        compare: true,
        summary: daySummary({ value: () => 0, previous: () => 0 }),
      },
      // Vorzeitraum mit Werten, der Schalter ist aus
      { compare: false, summary: EMPTY_NOW },
      { summary: EMPTY_NOW },
    ]) {
      const html = await render(CHART, { loading: false, ...props });
      assert.match(html, /Keine Nachrichten im gewählten Zeitraum/);
      assert.equal(lineOf(html), null);
      assert.equal(legendOf(html), null);
      assert.equal(columns(html), 0);
      assert.doesNotMatch(html, /data-chart-note|<svg[^>]* role="group"/);
      // Dieselbe Darstellung wie in KIE-536
      assert.equal(withoutSwitch(html), withoutSwitch(plain));
    }
  }
);

test(
  "Leerzustand ohne verfügbaren Vergleich (AK-6): Zeitraum ohne Nachrichten, der Vorzeitraum beginnt vor dem ersten Zählwert – Hinweis im Rahmen und die Angabe, keine Linie",
  { skip },
  async () => {
    const html = await render(CHART, {
      loading: false,
      compare: true,
      summary: {
        ...EMPTY_NOW,
        firstLedgerDay: "2026-09-01",
        previous: { ...EMPTY_NOW.previous, available: false },
      },
    });
    assert.match(html, /data-chart-frame="empty"/);
    assert.match(html, /Keine Nachrichten im gewählten Zeitraum/);
    assert.match(html, /<p data-compare-note=""/);
    assert.equal(lineOf(html), null);
    assert.equal(legendOf(html), null);
    assert.equal(columns(html), 0);
    assert.doesNotMatch(html, /data-chart-note|Vorzeitraum: \d/);
  }
);

// ---------------------------------------------------------------------------
// Kennzahlen (AK-4, AK-6, NAK-2)
// ---------------------------------------------------------------------------

const KPI_SUMMARY = {
  ...COMPARED,
  totals: {
    messages: 421,
    conversations: 60,
    feedbackPositive: 9,
    feedbackNegative: 3,
  },
  previous: {
    ...COMPARED.previous,
    totals: {
      messages: 266,
      conversations: 0,
      feedbackPositive: 6,
      feedbackNegative: 4,
    },
  },
};

test(
  "Kennzahlen (AK-4): 421 Nachrichten gegenüber 266 – „+58 % ggü. Vorzeitraum (266)“; bei 0 im Vorzeitraum „Vorzeitraum: 0“ ohne Prozentzahl",
  { skip },
  async () => {
    const html = await render(KPI, {
      summary: KPI_SUMMARY,
      loading: false,
      compare: true,
    });
    const range = "Vorzeitraum: 14.08.2026–12.09.2026";

    assert.deepEqual(changesOf(html), [
      ["messages", "+58 % ggü. Vorzeitraum (266)", range],
      ["conversations", "Vorzeitraum: 0", range],
      ["positive", "+50 % ggü. Vorzeitraum (6)", range],
      ["negative", "−25 % ggü. Vorzeitraum (4)", range],
    ]);
    // Die Tage des Vergleichs stehen auch im Text für Screenreader.
    assert.equal(
      count(
        html,
        /<span class="sr-only"> \(Vorzeitraum: 14\.08\.2026–12\.09\.2026\)<\/span>/g
      ),
      4
    );
  }
);

test(
  "Kennzahlen: Die Tage des Vorzeitraums stehen einmal sichtbar in einer gedämpften Zeile direkt unter dem Streifen – nicht nur im Tooltip der Felder",
  { skip },
  async () => {
    const html = await render(KPI, {
      summary: KPI_SUMMARY,
      loading: false,
      compare: true,
    });

    // eine Zeile, als Text im Lesefluss: weder title noch nur für Screenreader
    assert.equal(count(html, /data-compare-line/g), 1);
    const line = compareLineOf(html);
    assert.equal(
      textOf(line),
      "Veränderung gegenüber dem Vorzeitraum 14.08.2026–12.09.2026."
    );
    assert.match(line, /^<p data-compare-line="" class="[^"]*">/);
    assert.doesNotMatch(line, /title=|sr-only|aria-hidden|hidden/);
    const classes = line.match(/class="([^"]*)"/)[1].split(/\s+/);
    assert.ok(classes.includes("text-xs"));
    assert.ok(
      classes.includes("text-[color:var(--theme-analytics-text-muted)]")
    );
    // direkt unter dem Streifen: nach den vier Feldern, vor den technischen
    // Details
    const at = html.indexOf("<p data-compare-line");
    assert.equal(html.slice(at - 5, at), "</dl>");
    assert.ok(html.lastIndexOf("data-kpi=") < at);
    assert.ok(at < html.indexOf("Technische Details anzeigen"));
    // auch ohne die technischen Details (kein Admin)
    const manager = await render(
      KPI,
      { summary: KPI_SUMMARY, loading: false, compare: true },
      { role: "manager" }
    );
    assert.doesNotMatch(manager, /Technische Details/);
    assert.equal(textOf(compareLineOf(manager)), textOf(line));

    // Ein einzelner Tag steht allein.
    const day = await render(KPI, {
      loading: false,
      compare: true,
      summary: {
        ...KPI_SUMMARY,
        fromDay: "2026-10-12",
        toDay: "2026-10-12",
        previous: {
          ...KPI_SUMMARY.previous,
          fromDay: "2026-10-11",
          toDay: "2026-10-11",
        },
      },
    });
    assert.equal(
      textOf(compareLineOf(day)),
      "Veränderung gegenüber dem Vorzeitraum 11.10.2026."
    );
    // Während neu geladen wird, tritt die Zeile mit dem Streifen zurück.
    const loading = await render(KPI, {
      summary: KPI_SUMMARY,
      loading: true,
      compare: true,
    });
    assert.match(compareLineOf(loading), /class="[^"]*\bopacity-50\b/);
    assert.doesNotMatch(line, /opacity-50/);
  }
);

const RUNNING =
  "Der gewählte Zeitraum läuft noch – die Veränderung ist vorläufig.";
/** Kennzahlen eines Zeitraums von days Tagen ab from, mit Vorzeitraum. */
const kpiOf = (from, days, overrides = {}) =>
  render(KPI, {
    loading: false,
    compare: true,
    summary: daySummary({
      from,
      days,
      value: CURRENT,
      previous: PREVIOUS,
      ...overrides,
    }),
  });

test(
  "Laufender Zeitraum: Enthält der Zeitraum den heutigen Tag, sagt es die Zeile unter dem Streifen – „Heute“ und „Letzte 30 Tage“ ja, „Gestern“ und ein abgeschlossener Zeitraum nicht",
  { skip },
  async (t) => {
    // 13.10.2026, 12:00 Uhr in Berlin
    fixClock(t, "2026-10-13T10:00:00Z");

    // „Letzte 30 Tage": 14.09.–13.10.
    const month = await kpiOf("2026-09-14", 30);
    assert.equal(
      textOf(compareLineOf(month)),
      `Veränderung gegenüber dem Vorzeitraum 15.08.2026–13.09.2026. ${RUNNING}`
    );
    assert.equal(count(month, /data-compare-running/g), 1);
    assert.match(
      compareLineOf(month),
      new RegExp(`<span data-compare-running="">${RUNNING}</span></p>$`)
    );
    // „Heute": ein laufender Tag gegen den ganzen Vortag
    const today = await kpiOf("2026-10-13", 1, {
      totals: { messages: 5, conversations: 4 },
    });
    assert.equal(
      textOf(compareLineOf(today)),
      `Veränderung gegenüber dem Vorzeitraum 12.10.2026. ${RUNNING}`
    );
    // Der Hinweis steht einmal, an der Zeile – nicht in den Feldern.
    assert.equal(count(today, /läuft noch/g), 1);
    assert.deepEqual(
      changesOf(today).map(([, text]) => text),
      [
        "±0 % ggü. Vorzeitraum (5)",
        "−50 % ggü. Vorzeitraum (4)",
        "+50 % ggü. Vorzeitraum (6)",
        "−25 % ggü. Vorzeitraum (4)",
      ]
    );

    // „Gestern" und die 30 Tage bis gestern: abgeschlossen
    for (const [from, days, range] of [
      ["2026-10-12", 1, "11.10.2026"],
      ["2026-09-13", 30, "14.08.2026–12.09.2026"],
    ]) {
      const html = await kpiOf(from, days);
      assert.equal(
        textOf(compareLineOf(html)),
        `Veränderung gegenüber dem Vorzeitraum ${range}.`
      );
      assert.doesNotMatch(html, /data-compare-running|läuft noch/);
    }
    // Ohne Vergleich gibt es nichts, was vorläufig wäre.
    const off = await render(KPI, {
      loading: false,
      compare: false,
      summary: daySummary({
        from: "2026-10-13",
        days: 1,
        value: CURRENT,
        previous: PREVIOUS,
      }),
    });
    assert.doesNotMatch(off, /data-compare|läuft noch/);
  }
);

test(
  "Laufender Zeitraum: „heute“ ist der Berliner Kalendertag – um 00:30 Uhr in Berlin ist der 13.10. abgeschlossen und der 14.10. läuft, in welcher Zeitzone der Browser auch steht",
  { skip },
  async (t) => {
    // 14.10.2026, 00:30 Uhr in Berlin: in UTC 22:30 Uhr, in New York
    // 18:30 Uhr am 13.10.
    fixClock(t, "2026-10-13T22:30:00Z");

    for (const [from, days] of [
      ["2026-10-13", 1],
      ["2026-09-14", 30],
    ]) {
      const html = await kpiOf(from, days);
      assert.ok(compareLineOf(html));
      assert.doesNotMatch(html, /data-compare-running|läuft noch/);
    }
    for (const [from, days] of [
      ["2026-10-14", 1],
      ["2026-09-15", 30],
    ]) {
      const html = await kpiOf(from, days);
      assert.equal(count(html, /data-compare-running/g), 1);
      assert.ok(textOf(compareLineOf(html)).endsWith(`. ${RUNNING}`));
    }
  }
);

test(
  "Kennzahlen (NAK-2): Die großen Zahlen und die übrigen Nebenwerte sind mit und ohne Vergleich dieselben – es kommt nur die Zeile der Veränderung dazu",
  { skip },
  async () => {
    const off = await render(KPI, {
      summary: KPI_SUMMARY,
      loading: false,
      compare: false,
    });
    const on = await render(KPI, {
      summary: KPI_SUMMARY,
      loading: false,
      compare: true,
    });

    assert.equal(count(on, /data-kpi-change/g), 4);
    assert.equal(count(off, /data-kpi-change/g), 0);
    assert.equal(count(on, /data-compare-line/g), 1);
    assert.equal(count(off, /data-compare-line/g), 0);
    const withoutChange = on
      .replace(/<span data-kpi-change="".*?<\/span><\/span>/g, "")
      .replace(/<p data-compare-line="".*?<\/p>/, "");
    assert.equal(withoutChange, off);
    // Rückgang auf 0 und unveränderter Wert
    const edge = await render(KPI, {
      loading: false,
      compare: true,
      summary: {
        ...KPI_SUMMARY,
        totals: {
          messages: 0,
          conversations: 0,
          feedbackPositive: 6,
          feedbackNegative: 0,
        },
      },
    });
    assert.deepEqual(
      changesOf(edge).map(([key, text]) => [key, text]),
      [
        ["messages", "−100 % ggü. Vorzeitraum (266)"],
        ["conversations", "Vorzeitraum: 0"],
        ["positive", "±0 % ggü. Vorzeitraum (6)"],
        ["negative", "−100 % ggü. Vorzeitraum (4)"],
      ]
    );
  }
);

test(
  "Kennzahlen (AK-6): ohne Vergleich steht in jedem Feld „Kein Vergleich verfügbar“ – keine Prozentzahl, kein Wert des Vorzeitraums; der Tooltip nennt den ersten Tag mit Zählwerten",
  { skip },
  async () => {
    const html = await render(KPI, {
      loading: false,
      compare: true,
      summary: {
        ...KPI_SUMMARY,
        firstLedgerDay: "2026-09-01",
        previous: { ...KPI_SUMMARY.previous, available: false },
      },
    });
    const reason =
      "Kein Vergleich verfügbar: Der Vorzeitraum beginnt vor dem 01.09.2026, dem ersten Tag mit Zählwerten.";

    assert.deepEqual(
      changesOf(html),
      ["messages", "conversations", "positive", "negative"].map((key) => [
        key,
        "Kein Vergleich verfügbar",
        reason,
      ])
    );
    assert.doesNotMatch(html, /266|ggü\.|sr-only/);
    // Die großen Zahlen bleiben.
    assert.match(textOf(html), /^Nachrichten 421 /);

    // Ohne jeden Zählwert: derselbe Text, eine andere Begründung
    const empty = await render(KPI, {
      loading: false,
      compare: true,
      summary: {
        ...KPI_SUMMARY,
        firstLedgerDay: null,
        previous: { ...KPI_SUMMARY.previous, available: false },
      },
    });
    assert.deepEqual(changesOf(empty)[0], [
      "messages",
      "Kein Vergleich verfügbar",
      "Kein Vergleich verfügbar: Für den Vorzeitraum liegen keine Zählwerte vor.",
    ]);
  }
);

test(
  "Kennzahlen: vor der ersten Antwort Platzhalter – auch mit eingeschaltetem Vergleich keine Zeile der Veränderung",
  { skip },
  async () => {
    const html = await render(KPI, {
      summary: null,
      loading: true,
      compare: true,
    });
    assert.doesNotMatch(html, /data-kpi-change|data-compare-line/);
    assert.equal(count(html, /data-kpi=/g), 4);
  }
);

// ---------------------------------------------------------------------------
// Klassen
// ---------------------------------------------------------------------------

/** Deklarationen, die Tailwind mit der Konfiguration des Projekts erzeugt. */
async function tailwindRules(classes) {
  const { default: postcss } = await import("postcss");
  const { default: tailwind } = await import("tailwindcss");
  const { default: config } = await import("../tailwind.config.js");
  const { root } = await postcss([
    tailwind({
      ...config,
      content: [{ raw: classes.join(" ") }],
      safelist: [],
    }),
  ]).process("@tailwind utilities;", { from: undefined });
  const escapeClass = (name) => name.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  return (className) => {
    const selector = `.${escapeClass(className)}`;
    let found = 0;
    root.walkRules((rule) => {
      const names = rule.selectors.some((candidate) => {
        const at = candidate.indexOf(selector);
        return (
          at >= 0 && !/[\w\\-]/.test(candidate[at + selector.length] ?? "")
        );
      });
      if (names) rule.walkDecls(() => found++);
    });
    return found;
  };
}

test(
  "Klassen: Für jede Klasse von Schalter, Legende, Angabe, Hinweis und Zeile der Veränderung erzeugt Tailwind CSS – in beiden Zuständen des Schalters",
  { skip },
  async () => {
    const used = new Set();
    for (const html of [
      await render(CHART, { summary: PLAIN, loading: false }),
      await render(CHART, { summary: COMPARED, loading: false, compare: true }),
      await render(CHART, {
        summary: EMPTY_NOW,
        loading: false,
        compare: true,
      }),
      await render(CHART, {
        summary: UNAVAILABLE,
        loading: false,
        compare: true,
      }),
      await render(KPI, {
        summary: KPI_SUMMARY,
        loading: false,
        compare: true,
      }),
      await render(KPI, {
        summary: UNAVAILABLE,
        loading: false,
        compare: true,
      }),
    ])
      for (const [, classes] of html.matchAll(/ class="([^"]*)"/g))
        for (const name of classes.split(/\s+/)) if (name) used.add(name);

    // Darunter die neuen: Bahn und Knopf des Schalters in beiden Zuständen
    for (const expected of [
      "bg-theme-text-primary",
      "border-theme-text-primary",
      "bg-theme-bg-primary",
      "translate-x-[14px]",
      "border-[color:var(--theme-analytics-text-muted)]",
      "bg-[color:var(--theme-analytics-text-muted)]",
      "bg-transparent",
      "sr-only",
    ])
      assert.ok(used.has(expected), expected);

    const declarations = await tailwindRules([...used]);
    const missing = [...used].filter((name) => declarations(name) === 0);
    assert.deepEqual(missing, [], "Klassen ohne CSS");
  }
);
