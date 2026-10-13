// KIE-536: Ansicht „Konversationen" – Kennzahlen-Streifen, Säulendiagramm und
// Leerzustände, serverseitig gerendert (helpers/renderSettingsPage.mjs).
// Effekte laufen dabei nicht: Geprüft wird, was die Komponenten zu einem
// gegebenen Stand zeichnen, nicht das Laden. Maus, Tastatur und die Anfragen
// an den Server prüft embedAnalyticsInteraction.test.mjs; Themes und Layout
// gehören in den Browser-Test.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import {
  createRenderer,
  hasFrontendDeps,
} from "./helpers/renderSettingsPage.mjs";
import {
  DEFAULT_RANGE_DAYS,
  addDays,
  formatDate,
  lastDaysRange,
  toDayString,
} from "../src/utils/analyticsTimeline.js";

const DIR = "/src/pages/GeneralSettings/ChatEmbedWidgets/EmbedAnalytics";
const CHART = `${DIR}/TimelineChart.jsx`;
const KPI = `${DIR}/StatisticsGrid.jsx`;
const LIST = `${DIR}/ConversationList.jsx`;
const VIEW = `${DIR}/index.jsx`;
const LOCATION = "/settings/chatbot/conversations";
const WIDGETS = "/settings/chatbot/widgets";
const skip = hasFrontendDeps
  ? false
  : "frontend/node_modules nicht installiert";

const BAR = "var(--theme-analytics-bar)";
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

function daySummary({ from = "2026-09-13", days = 30, value, ...overrides }) {
  const buckets = Array.from({ length: days }, (_, i) => {
    const messages = value(i);
    return {
      start: addDays(from, i),
      end: addDays(from, i),
      partial: false,
      messages,
      conversations: Math.ceil(messages / 3),
    };
  });
  const sum = (key) => buckets.reduce((total, b) => total + b[key], 0);
  return {
    success: true,
    granularity: "day",
    fromDay: from,
    toDay: addDays(from, days - 1),
    firstLedgerDay: "2026-01-01",
    totals: {
      messages: sum("messages"),
      conversations: sum("conversations"),
      feedbackPositive: 9,
      feedbackNegative: 3,
    },
    buckets,
    ...overrides,
  };
}

// 30 Tage, an jedem dritten Tag keine Nachricht (10 Lücken)
const THIRTY_DAYS = daySummary({ value: (i) => (i % 3 === 2 ? 0 : 5 + i) });
const EMPTY_TOTALS = {
  messages: 0,
  conversations: 0,
  feedbackPositive: 0,
  feedbackNegative: 0,
};

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
// Diagramm
// ---------------------------------------------------------------------------

test(
  "Diagramm (AK-1): 30 Säulenplätze, an den 10 Tagen ohne Nachricht keine Säule, Beschriftung „pro Tag“",
  { skip },
  async () => {
    const html = await render(CHART, { summary: THIRTY_DAYS, loading: false });

    assert.equal(columns(html), 30);
    assert.equal(bars(html), 20);
    assert.match(textOf(html), /^Nachrichten pro Tag /);
    // Jeder Platz nennt Tag und Wert, auch der leere.
    assert.match(html, /aria-label="So\., 13\.09\.2026 — 5 Nachrichten\./);
    assert.match(html, /aria-label="Di\., 15\.09\.2026 — 0 Nachrichten"/);
    // Umschalter Nachrichten | Konversationen und „Als Tabelle“ am Diagramm
    assert.match(
      html,
      /role="group" aria-label="Dargestellte Größe"[^>]*><button type="button" aria-pressed="true"[^>]*>Nachrichten<\/button><button type="button" aria-pressed="false"[^>]*>Konversationen<\/button>/
    );
    assert.match(
      html,
      /aria-pressed="false"[^>]*>(<svg.*?<\/svg>)?Als Tabelle</
    );
  }
);

test(
  "Diagramm: eine Akzentfarbe für die Säulen, Text nie in der Säulenfarbe, keine Legende",
  { skip },
  async () => {
    const html = await render(CHART, { summary: THIRTY_DAYS, loading: false });

    const fills = [...html.matchAll(/<path data-bar=""[^>]* fill="([^"]+)"/g)];
    assert.equal(fills.length, 20);
    assert.deepEqual([...new Set(fills.map((match) => match[1]))], [BAR]);
    // Achsen- und Wertbeschriftung in der gedämpften Textfarbe
    const texts = [...html.matchAll(/<text [^>]*fill="([^"]+)"/g)];
    assert.ok(texts.length > 5);
    assert.deepEqual(
      [...new Set(texts.map((match) => match[1]))],
      ["var(--theme-analytics-text-muted)"]
    );
    // Die Säulenfarbe steht nirgends an Text oder als Textklasse.
    assert.equal(count(html, /theme-analytics-bar/g), 20);
    assert.doesNotMatch(html, /legend/i);
    // Kein fest verdrahteter Farbwert: Die Farben kommen aus dem Theme.
    assert.doesNotMatch(html, /#[0-9a-f]{6}\b/i);
  }
);

test(
  "Diagramm: Die Säulenfarben beider Themes stehen als Theme-Variablen in index.css",
  { skip },
  async () => {
    const { readFileSync } = await import("node:fs");
    const css = readFileSync(
      new URL("../src/index.css", import.meta.url),
      "utf8"
    );
    const [dark, light] = css.split('[data-theme="light"] {');
    assert.match(dark, /--theme-analytics-bar: #1a9bdc;/);
    assert.match(light.split("}")[0], /--theme-analytics-bar: #0284c7;/);
    assert.match(light.split("}")[0], /--theme-analytics-text-muted: #5f6368;/);
  }
);

test(
  "Diagramm: Säulen eines Tagesdiagramms sind Schaltflächen, ein Tab-Stopp für das ganze Diagramm",
  { skip },
  async () => {
    const html = await render(CHART, { summary: THIRTY_DAYS, loading: false });

    assert.equal(count(html, /<g data-column="" role="button"/g), 20);
    assert.equal(count(html, /<g data-column="" role="img"/g), 10);
    assert.equal(count(html, /<g data-column=""[^>]* tabindex="0"/g), 1);
    assert.equal(count(html, /<g data-column=""[^>]* tabindex="-1"/g), 29);
    assert.equal(count(html, /aria-pressed="true" aria-label="[^"]* — /g), 0);
  }
);

test(
  "Diagramm (AK-7): Der gewählte Abschnitt ist markiert, die übrigen Säulen treten zurück",
  { skip },
  async () => {
    const selected = THIRTY_DAYS.buckets[3];
    const html = await render(CHART, {
      summary: THIRTY_DAYS,
      loading: false,
      selectedBucket: { start: selected.start, end: selected.end },
    });

    assert.equal(
      count(html, /<g data-column="" role="button" aria-pressed="true"/g),
      1
    );
    assert.match(
      html,
      /aria-pressed="true" aria-label="Mi\., 16\.09\.2026 — 8 Nachrichten\./
    );
    assert.equal(count(html, /<path data-bar=""[^>]* fill-opacity="1"/g), 1);
    assert.equal(count(html, /<path data-bar=""[^>]* fill-opacity="0.4"/g), 19);
  }
);

test(
  "Diagramm (AK-9): einzelner Tag – 24 Stunden-Säulenplätze, „pro Stunde“, kein Platz ist eine Schaltfläche",
  { skip },
  async () => {
    const buckets = Array.from({ length: 24 }, (_, hour) => ({
      start: "2026-10-06",
      end: "2026-10-06",
      partial: false,
      hour,
      messages: hour >= 8 && hour <= 20 ? hour : 0,
      conversations: hour === 9 ? 2 : 0,
    }));
    const summary = {
      granularity: "hour",
      fromDay: "2026-10-06",
      toDay: "2026-10-06",
      firstLedgerDay: "2026-01-01",
      totals: {
        messages: 182,
        conversations: 2,
        feedbackPositive: 0,
        feedbackNegative: 0,
      },
      buckets,
    };
    const html = await render(CHART, { summary, loading: false });

    assert.equal(columns(html), 24);
    assert.equal(bars(html), 13);
    assert.match(textOf(html), /^Nachrichten pro Stunde /);
    assert.equal(count(html, /<g data-column="" role="button"/g), 0);
    assert.equal(count(html, /<g data-column="" role="img"/g), 24);
    assert.doesNotMatch(html, /Eingabetaste/);
    assert.match(
      html,
      /aria-label="Di\., 06\.10\.2026, 13–14 Uhr — 13 Nachrichten"/
    );
    // Auch ein gesetzter Abschnitt markiert im Stundendiagramm nichts.
    const withSelection = await render(CHART, {
      summary,
      loading: false,
      selectedBucket: { start: "2026-10-06", end: "2026-10-06" },
    });
    assert.equal(count(withSelection, /fill-opacity="0.4"/g), 0);
  }
);

test(
  "Diagramm: Wochen und Monate – Beschriftung der Körnung, angeschnittene Abschnitte mit tatsächlichem Bereich",
  { skip },
  async () => {
    const weeks = await render(CHART, {
      loading: false,
      summary: {
        granularity: "week",
        fromDay: "2026-09-28",
        toDay: "2026-10-12",
        firstLedgerDay: "2026-01-01",
        totals: {
          messages: 30,
          conversations: 9,
          feedbackPositive: 0,
          feedbackNegative: 0,
        },
        buckets: [
          {
            start: "2026-09-28",
            end: "2026-10-04",
            partial: false,
            messages: 10,
            conversations: 3,
          },
          {
            start: "2026-10-05",
            end: "2026-10-11",
            partial: false,
            messages: 15,
            conversations: 4,
          },
          {
            start: "2026-10-12",
            end: "2026-10-12",
            partial: true,
            messages: 5,
            conversations: 2,
          },
        ],
      },
    });
    assert.match(textOf(weeks), /^Nachrichten pro Woche /);
    assert.equal(columns(weeks), 3);
    assert.match(
      weeks,
      /aria-label="KW 41 \(05\.10\.–11\.10\.2026\) — 15 Nachrichten\./
    );
    assert.match(weeks, /aria-label="KW 42 – bis 12\.10\. — 5 Nachrichten\./);
    assert.match(weeks, />KW 41<\/text>/);

    const months = await render(CHART, {
      loading: false,
      summary: {
        granularity: "month",
        fromDay: "2026-08-01",
        toDay: "2026-10-12",
        firstLedgerDay: "2026-01-01",
        totals: {
          messages: 60,
          conversations: 20,
          feedbackPositive: 0,
          feedbackNegative: 0,
        },
        buckets: [
          {
            start: "2026-08-01",
            end: "2026-08-31",
            partial: false,
            messages: 20,
            conversations: 7,
          },
          {
            start: "2026-09-01",
            end: "2026-09-30",
            partial: false,
            messages: 30,
            conversations: 9,
          },
          {
            start: "2026-10-01",
            end: "2026-10-12",
            partial: true,
            messages: 10,
            conversations: 4,
          },
        ],
      },
    });
    assert.match(textOf(months), /^Nachrichten pro Monat /);
    assert.match(months, /aria-label="September 2026 — 30 Nachrichten\./);
    assert.match(
      months,
      /aria-label="Oktober 2026 – bis 12\.10\. — 10 Nachrichten\./
    );
  }
);

test(
  "Leerzustand (AK-10 a): Zeitraum ohne Nachrichten – Hinweis im Diagrammrahmen, keine Säulenplätze",
  { skip },
  async () => {
    const summary = daySummary({ value: () => 0, totals: EMPTY_TOTALS });
    const html = await render(CHART, { summary, loading: false });

    assert.equal(columns(html), 0);
    assert.equal(bars(html), 0);
    assert.doesNotMatch(html, /<svg[^>]* role="group"/);
    assert.match(html, /data-chart-frame="empty"/);
    assert.match(textOf(html), /Keine Nachrichten im gewählten Zeitraum$/);
    assert.doesNotMatch(html, new RegExp(`href="${WIDGETS}"`));
  }
);

test(
  "Leerzustand (AK-10 b): Widget ohne jede Nachricht – Hinweis mit Verweis auf „Widgets“, keine Säulenplätze",
  { skip },
  async () => {
    const summary = daySummary({
      value: () => 0,
      totals: EMPTY_TOTALS,
      firstLedgerDay: null,
    });
    const html = await render(CHART, { summary, loading: false });

    assert.equal(columns(html), 0);
    assert.equal(bars(html), 0);
    assert.match(html, /data-chart-frame="empty"/);
    assert.match(
      textOf(html),
      /Für dieses Widget wurden noch keine Nachrichten gezählt\. .*„Widgets“\. Zu den Widgets$/
    );
    assert.match(html, new RegExp(`<a [^>]*href="${WIDGETS}"`));
    assert.doesNotMatch(
      textOf(html),
      /Keine Nachrichten im gewählten Zeitraum/
    );
  }
);

test(
  "Leerzustände: vor der ersten Antwort „Laden...“, nach einem Fehler eine Meldung – nie Säulenplätze ohne Werte",
  { skip },
  async () => {
    const loading = await render(CHART, { summary: null, loading: true });
    assert.equal(columns(loading), 0);
    assert.match(textOf(loading), /Laden\.\.\.$/);

    const failed = await render(CHART, {
      summary: null,
      loading: false,
      failed: true,
    });
    assert.equal(columns(failed), 0);
    assert.match(
      textOf(failed),
      /Die Zählwerte konnten nicht geladen werden\.$/
    );
  }
);

test(
  "Beginn der Zählung (AK-14): Angabe am Diagramm, wenn der Zeitraum davor beginnt",
  { skip },
  async () => {
    const before = await render(CHART, {
      loading: false,
      summary: { ...THIRTY_DAYS, firstLedgerDay: "2026-09-20" },
    });
    assert.match(textOf(before), /Zählwerte liegen ab 20\.09\.2026 vor/);

    const within = await render(CHART, {
      loading: false,
      summary: { ...THIRTY_DAYS, firstLedgerDay: "2026-09-13" },
    });
    assert.doesNotMatch(textOf(within), /Zählwerte liegen ab/);
  }
);

// ---------------------------------------------------------------------------
// Kennzahlen-Streifen
// ---------------------------------------------------------------------------

/** Die Felder des Streifens in Anzeigereihenfolge: Schlüssel und sichtbarer Text. */
function kpiFields(html) {
  return [
    ...html.matchAll(/<div data-kpi="([^"]+)"[^>]*>(.*?)<\/dd><\/div>/g),
  ].map(([, key, inner]) => [key, textOf(inner)]);
}

test(
  "Kennzahlen-Streifen (AK-8): vier Felder mit Nebenwerten, aus den Summen des Zählerbuchs",
  { skip },
  async () => {
    const summary = {
      ...THIRTY_DAYS,
      totals: {
        messages: 1284,
        conversations: 321,
        feedbackPositive: 9,
        feedbackNegative: 3,
      },
    };
    const html = await render(KPI, { summary, loading: false, embedId: 1 });

    assert.deepEqual(kpiFields(html), [
      ["messages", "Nachrichten 1.284 Ø 42,8 pro Tag"],
      ["conversations", "Konversationen 321 Ø 4,0 Nachrichten je Konversation"],
      [
        "positive",
        "Positiv bewertete Antworten 9 75 % der bewerteten Antworten",
      ],
      [
        "negative",
        "Negativ bewertete Antworten 3 Betroffene Konversationen anzeigen",
      ],
    ]);
    // Der Verweis ist eine Schaltfläche (setzt den Listenfilter „negativ“).
    assert.match(
      html,
      /<button type="button"[^>]*>Betroffene Konversationen anzeigen<\/button>/
    );
    // Erklärung an der Kennzahl „Konversationen“
    assert.match(html, /title="Im Zeitraum begonnene Konversationen\./);
  }
);

test(
  "Kennzahlen-Streifen: ein ruhiger Streifen – schmal 2 × 2, breit vier nebeneinander, ohne die sechs Kachelfarben",
  { skip },
  async () => {
    const html = await render(KPI, {
      summary: THIRTY_DAYS,
      loading: false,
      embedId: 1,
    });

    assert.match(html, /<dl [^>]*class="grid grid-cols-2 lg:grid-cols-4 /);
    assert.equal(count(html, /<div data-kpi="/g), 4);
    assert.doesNotMatch(html, /#[0-9a-f]{6}\b/i);
    assert.doesNotMatch(html, /style="color:/);
    assert.doesNotMatch(html, /theme-analytics-bar/);
    assert.doesNotMatch(html, /👍|👎/);
  }
);

test(
  "Kennzahlen-Streifen: Ø je Säuleneinheit folgt der Körnung; ohne Bewertungen kein Anteil",
  { skip },
  async () => {
    const html = await render(KPI, {
      loading: false,
      embedId: 1,
      summary: {
        granularity: "week",
        fromDay: "2026-09-28",
        toDay: "2026-10-11",
        firstLedgerDay: "2026-01-01",
        totals: {
          messages: 25,
          conversations: 0,
          feedbackPositive: 0,
          feedbackNegative: 0,
        },
        buckets: [
          {
            start: "2026-09-28",
            end: "2026-10-04",
            partial: false,
            messages: 10,
            conversations: 0,
          },
          {
            start: "2026-10-05",
            end: "2026-10-11",
            partial: false,
            messages: 15,
            conversations: 0,
          },
        ],
      },
    });
    assert.deepEqual(kpiFields(html), [
      ["messages", "Nachrichten 25 Ø 12,5 pro Woche"],
      ["conversations", "Konversationen 0 –"],
      ["positive", "Positiv bewertete Antworten 0 Keine Bewertungen"],
      ["negative", "Negativ bewertete Antworten 0 Keine Bewertungen"],
    ]);
    assert.doesNotMatch(html, /Betroffene Konversationen anzeigen/);
  }
);

test(
  "Kennzahlen-Streifen: „Betroffene Konversationen anzeigen“ nur, wenn es negativ bewertete Antworten gibt – bei 0 der Nebentext",
  { skip },
  async () => {
    const withRatings = async (feedbackPositive, feedbackNegative) => {
      const html = await render(KPI, {
        loading: false,
        embedId: 1,
        summary: {
          ...THIRTY_DAYS,
          totals: { ...THIRTY_DAYS.totals, feedbackPositive, feedbackNegative },
        },
      });
      const negative = Object.fromEntries(kpiFields(html)).negative;
      return {
        negative,
        link: /<button type="button"[^>]*>Betroffene Konversationen anzeigen<\/button>/.test(
          html
        ),
      };
    };

    // nur positive Bewertungen: Es gibt Bewertungen, aber keine negative.
    assert.deepEqual(await withRatings(5, 0), {
      negative: "Negativ bewertete Antworten 0 Keine negativen Bewertungen",
      link: false,
    });
    // gar keine Bewertung: derselbe Nebentext wie im Feld „positiv“
    assert.deepEqual(await withRatings(0, 0), {
      negative: "Negativ bewertete Antworten 0 Keine Bewertungen",
      link: false,
    });
    // ab der ersten negativen Bewertung der Verweis, kein Nebentext
    assert.deepEqual(await withRatings(5, 1), {
      negative:
        "Negativ bewertete Antworten 1 Betroffene Konversationen anzeigen",
      link: true,
    });
    assert.deepEqual(await withRatings(0, 2), {
      negative:
        "Negativ bewertete Antworten 2 Betroffene Konversationen anzeigen",
      link: true,
    });
  }
);

test(
  "Kennzahlen-Streifen: vor der ersten Antwort Platzhalter statt Nullen",
  { skip },
  async () => {
    const html = await render(KPI, {
      summary: null,
      loading: true,
      embedId: 1,
    });
    assert.deepEqual(
      kpiFields(html).map(([key, text]) => [key, text.split(" ").slice(-1)[0]]),
      [
        ["messages", "–"],
        ["conversations", "–"],
        ["positive", "–"],
        ["negative", "–"],
      ]
    );
    assert.doesNotMatch(html, /Betroffene Konversationen anzeigen/);
    assert.doesNotMatch(textOf(html), /\b0\b/);
  }
);

test("Technische Details: nur für admin, eingeklappt", { skip }, async () => {
  const props = { summary: THIRTY_DAYS, loading: false, embedId: 1 };
  const admin = await render(KPI, props, { role: "admin" });
  assert.match(
    admin,
    /<button type="button" aria-expanded="false"[^>]*>.*Technische Details anzeigen/
  );
  assert.doesNotMatch(admin, /Ø Wörter/);

  for (const role of ["manager", "default"]) {
    const html = await render(KPI, props, { role });
    assert.doesNotMatch(html, /Technische Details/);
    assert.equal(count(html, /<div data-kpi="/g), 4);
  }
});

// ---------------------------------------------------------------------------
// Seitenaufbau
// ---------------------------------------------------------------------------

const EMBED = {
  id: 3,
  chat_retention_days: 30,
  workspace: { name: "VHS Musterstadt" },
};

test(
  "Leerzustand (AK-10 c): kein sichtbares Widget – „Noch kein Widget vorhanden“ mit Verweis auf „Widgets“, nicht „Laden...“",
  { skip },
  async () => {
    for (const role of ["default", "manager", "admin"]) {
      const html = await render(
        VIEW,
        { embedsLoaded: true, embeds: [] },
        { exportName: "AnalyticsScreen", role }
      );
      assert.match(html, /data-empty-state="no-widget"/);
      assert.match(textOf(html), /Noch kein Widget vorhanden/);
      assert.match(
        html,
        new RegExp(`<a [^>]*href="${WIDGETS}"[^>]*>Zu den Widgets</a>`)
      );
      assert.doesNotMatch(textOf(html), /Laden/);
      assert.equal(count(html, /<div data-kpi="/g), 0);
    }

    // Solange die Widget-Liste lädt, steht „Laden...“ – und nur dann.
    const loading = await render(
      VIEW,
      { embedsLoaded: false, embeds: [] },
      { exportName: "AnalyticsScreen" }
    );
    assert.equal(textOf(loading), "Laden...");
    assert.equal(textOf(await render(VIEW, {})), "Laden...");
  }
);

test(
  "Seitenaufbau: Kopfzeile, Aufbewahrung als eine Zeile (AK-13), Kennzahlen, Diagramm, Liste – in dieser Reihenfolge",
  { skip },
  async () => {
    const html = await render(
      VIEW,
      { embedsLoaded: true, embeds: [EMBED] },
      { exportName: "AnalyticsScreen" }
    );
    const text = textOf(html);

    const order = [
      html.indexOf("<h2"),
      html.indexOf('data-retention-line=""'),
      html.indexOf('data-kpi="messages"'),
      html.indexOf("<section"),
      html.indexOf("Nur mit 👍"),
    ];
    assert.deepEqual(
      order,
      [...order].sort((a, b) => a - b)
    );
    assert.ok(
      order.every((index) => index >= 0),
      `Reihenfolge: ${order}`
    );

    assert.match(
      html,
      /<p data-retention-line=""[^>]*>Konversationsinhalte werden nach 30 Tagen gelöscht\. Die Zählwerte bleiben erhalten\.<\/p>/
    );
    // Der bisherige Kasten mit dem Verfallsdatum entfällt.
    assert.doesNotMatch(text, /DSGVO-Datenlöschung|verfallen am/);
    assert.doesNotMatch(html, /border-l-4 border-blue-400/);
  }
);

test(
  "Seitenaufbau: ohne Aufbewahrungsfrist keine Angabe zur Löschung",
  { skip },
  async () => {
    for (const chat_retention_days of [null, 0, undefined]) {
      const html = await render(
        VIEW,
        { embedsLoaded: true, embeds: [{ ...EMBED, chat_retention_days }] },
        { exportName: "AnalyticsScreen" }
      );
      assert.doesNotMatch(html, /data-retention-line/);
      assert.doesNotMatch(textOf(html), /gelöscht/);
    }
  }
);

test(
  "Standard-Zeitraum (AK-12): Die Datumsauswahl zeigt die letzten 30 Tage",
  { skip },
  async () => {
    const html = await render(
      VIEW,
      { embedsLoaded: true, embeds: [EMBED] },
      { exportName: "AnalyticsScreen" }
    );
    const { startDate, endDate } = lastDaysRange(DEFAULT_RANGE_DAYS);
    const from = formatDate(toDayString(startDate));
    const to = formatDate(toDayString(endDate));
    assert.equal(to, formatDate(toDayString(new Date())));
    assert.ok(textOf(html).includes(`${from} - ${to}`), `${from} - ${to}`);
  }
);

test(
  "Widget-Auswahl (AK-17): bei genau einem Widget keine Auswahl, bei mehreren schon",
  { skip },
  async () => {
    const one = await render(
      VIEW,
      { embedsLoaded: true, embeds: [EMBED] },
      { exportName: "AnalyticsScreen" }
    );
    assert.doesNotMatch(one, /aria-haspopup="listbox"/);
    assert.doesNotMatch(textOf(one), /Embed #3/);

    const two = await render(
      VIEW,
      {
        embedsLoaded: true,
        embeds: [EMBED, { id: 4, workspace: { name: "Zweigstelle" } }],
      },
      { exportName: "AnalyticsScreen" }
    );
    assert.match(
      two,
      /<button type="button" aria-haspopup="listbox"[^>]*aria-label="Widget"/
    );
    assert.match(textOf(two), /Embed #3 \(VHS Musterstadt\)/);
    // Das erste Widget ist gewählt: Seine Aufbewahrungsfrist steht da.
    assert.match(two, /data-retention-line=""/);
  }
);

// ---------------------------------------------------------------------------
// Liste
// ---------------------------------------------------------------------------

test(
  "Liste (AK-7): Markierung „Nur <Abschnitt>“ mit Schließen-Schaltfläche, Feedback-Filter bleiben",
  { skip },
  async () => {
    const props = {
      embedId: 3,
      startDate: "2026-09-12T22:00:00.000Z",
      endDate: "2026-10-12T21:59:59.999Z",
      feedbackFilter: "negative",
    };
    const filtered = await render(LIST, {
      ...props,
      bucket: {
        start: "2026-10-05",
        end: "2026-10-11",
        label: "KW 41 (05.10.–11.10.2026)",
      },
    });
    assert.match(
      filtered,
      /<span data-bucket-filter=""[^>]*><span[^>]*>Nur KW 41 \(05\.10\.–11\.10\.2026\)<\/span><button type="button" aria-label="Filter „KW 41 \(05\.10\.–11\.10\.2026\)“ aufheben"/
    );
    assert.match(textOf(filtered), /^Konversationen /);
    assert.match(
      filtered,
      /<button type="button" aria-pressed="false"[^>]*>.*?Nur mit 👍<\/button><button type="button" aria-pressed="true"[^>]*>.*?Nur mit 👎<\/button>/
    );

    const plain = await render(LIST, props);
    assert.doesNotMatch(plain, /data-bucket-filter/);
    // Während des Ladens weder Anzahl noch Hinweis auf gelöschte Inhalte.
    assert.doesNotMatch(plain, /data-viewable-count|data-deleted-hint/);
  }
);
