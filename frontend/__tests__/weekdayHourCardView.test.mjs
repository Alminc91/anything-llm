// KIE-539: Karte „Wann schreiben Ihre Besucher?" – Raster, Aussagen, Legende
// und die Zustände ohne Raster, serverseitig gerendert
// (helpers/renderSettingsPage.mjs). Effekte laufen dabei nicht: Geprüft wird,
// was die Karte zu einer Antwort von analytics/summary zeichnet. Maus,
// Tastatur, Touch, die Tabellenansicht und die schmale Karte prüft
// weekdayHourCardInteraction.test.mjs; wie es aussieht (Themes, 1440 px und
// 390 px), zeigt nur der Browser-Test.
//
// Die Raster sind dieselben, die der Server-Test über die echte Route
// erzeugt (server/__tests__/endpoints/support/weekdayHourScenarios.js).
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import {
  createRenderer,
  hasFrontendDeps,
} from "./helpers/renderSettingsPage.mjs";
import scenarios from "../../server/__tests__/endpoints/support/weekdayHourScenarios.js";

const { PERIOD, DISTRIBUTION, CORE_TIME_WEEK, addDays, gridOf } = scenarios;

const DIR = "/src/pages/GeneralSettings/ChatEmbedWidgets/EmbedAnalytics";
const CARD = `${DIR}/WeekdayHourCard.jsx`;
const VIEW = `${DIR}/index.jsx`;
const LOCATION = "/settings/chatbot/conversations";
const skip = hasFrontendDeps
  ? false
  : "frontend/node_modules nicht installiert";

const WEEKDAYS = [
  "Montag",
  "Dienstag",
  "Mittwoch",
  "Donnerstag",
  "Freitag",
  "Samstag",
  "Sonntag",
];
const count = (html, pattern) => (html.match(pattern) ?? []).length;
/** Sichtbarer Text ohne Markup. */
const textOf = (html) =>
  html
    .replace(/<!-- -->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
/** Die 168 Felder in Leserichtung: Stufe, Beschriftung, Tab-Stopp, Farbe. */
const cellsOf = (html) =>
  [
    ...html.matchAll(
      /<g data-heat-cell="" data-level="(\d)" role="img" aria-label="([^"]*)" tabindex="(-?\d)"[^>]*>(.*?)<\/g>/g
    ),
  ].map(([, level, label, tabindex, inner]) => ({
    level: Number(level),
    label,
    tabindex: Number(tabindex),
    fill: /<rect data-heat-tile=""[^>]* fill="([^"]+)"/.exec(inner)?.[1],
    stroke: /<rect data-heat-tile=""[^>]* stroke="([^"]+)"/.exec(inner)?.[1],
  }));
/** Text eines Elements mit diesem Attribut. */
const blockOf = (html, attribute) =>
  textOf(
    new RegExp(`<(\\w+) ${attribute}[^>]*>(.*?)</\\1>`).exec(html)?.[2] ?? ""
  );

/** Antwort von analytics/summary zu Zählwerten. */
function summaryOf(cells, overrides = {}) {
  const grid = gridOf(cells);
  const messages = grid.flat().reduce((total, value) => total + value, 0);
  return {
    success: true,
    granularity: "day",
    ...PERIOD,
    firstLedgerDay: "2026-01-01",
    totals: {
      messages,
      conversations: Math.ceil(messages / 3),
      feedbackPositive: 9,
      feedbackNegative: 3,
    },
    buckets: [],
    weekdayHour: grid,
    ...overrides,
  };
}
const times = (cells, factor) =>
  cells.map((cell) => ({ ...cell, messages: cell.messages * factor }));

// 30 Tage, 252 Nachrichten, Höchstwert dienstags 10–11 Uhr (14)
const DATA = summaryOf(DISTRIBUTION.cells);
// 300 Nachrichten, davon 180 Montag–Freitag zwischen 8:00 und 16:59 Uhr
const CORE = summaryOf(times(CORE_TIME_WEEK.cells, 3));

let renderer;
before(async () => {
  if (hasFrontendDeps) renderer = await createRenderer();
});
after(async () => {
  await renderer?.close();
});

const render = (modulePath, props, options = {}) =>
  renderer.render(modulePath, { location: LOCATION, props, ...options });
const card = (summary, props = {}) =>
  render(CARD, { summary, loading: false, ...props });

// ---------------------------------------------------------------------------
// Raster (AK-1)
// ---------------------------------------------------------------------------

test(
  "Raster (AK-1): 7 Zeilen (Mo–So) und 24 Spalten; Felder ohne Nachrichten haben die Null-Stufe, das Feld mit dem Höchstwert die stärkste",
  { skip },
  async () => {
    const html = await card(DATA);
    const cells = cellsOf(html);
    const grid = DATA.weekdayHour;

    assert.equal(cells.length, 7 * 24);
    assert.equal(count(html, /<g data-heat-cell=""/g), 168);
    // Zeilen Montag bis Sonntag, je 24 Felder von 0 bis 23 Uhr
    cells.forEach((cell, index) => {
      const weekday = Math.floor(index / 24);
      const hour = index % 24;
      assert.ok(
        cell.label.startsWith(
          `${WEEKDAYS[weekday]}, ${hour}–${hour + 1} Uhr: `
        ),
        `${index}: ${cell.label}`
      );
      // ohne Nachrichten: Null-Stufe – und nur dann
      assert.equal(cell.level === 0, grid[weekday][hour] === 0, cell.label);
      assert.equal(cell.fill, `var(--theme-analytics-heat-${cell.level})`);
    });
    assert.equal(cells.filter((cell) => cell.level === 0).length, 84);

    // Das Feld mit dem Höchstwert – und nur dieses – hat die stärkste Stufe.
    const strongest = cells.filter((cell) => cell.level === 5);
    assert.deepEqual(
      strongest.map((cell) => cell.label),
      ["Dienstag, 10–11 Uhr: 14 Nachrichten"]
    );
    assert.equal(cells[1 * 24 + 10], strongest[0]);

    // Wochentage links, Uhrzeiten alle drei Stunden unten
    assert.deepEqual(
      [...html.matchAll(/<div data-heat-row-label=""[^>]*>([^<]*)</g)].map(
        (match) => match[1]
      ),
      ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"]
    );
    assert.deepEqual(
      [...html.matchAll(/<text data-heat-tick=""[^>]*>(.*?)<\/text>/g)].map(
        (match) => textOf(match[1])
      ),
      [0, 3, 6, 9, 12, 15, 18, 21].map((hour) => `${hour} Uhr`)
    );
    // Titel und Zeitraum
    assert.match(
      textOf(html),
      /^Wann schreiben Ihre Besucher\? Nachrichten nach Wochentag und Uhrzeit, 13\.09\.2026–12\.10\.2026 /
    );
    assert.match(html, /<section [^>]*data-weekday-hour-card="data"/);
  }
);

test(
  "Tooltip (AK-5, NAK-2): Jedes der 168 Felder nennt Wochentag, Stunde und Anzahl – auch die leeren; zusammen ergeben sie die Kennzahl „Nachrichten“",
  { skip },
  async () => {
    const html = await card(DATA);
    const cells = cellsOf(html);
    const pattern = new RegExp(
      `^(${WEEKDAYS.join("|")}), (\\d+)–(\\d+) Uhr: ([\\d.]+) Nachricht(en)?$`
    );
    let total = 0;
    for (const cell of cells) {
      const match = pattern.exec(cell.label);
      assert.ok(match, cell.label);
      assert.equal(Number(match[3]), Number(match[2]) + 1);
      // Einzahl nur bei genau einer Nachricht
      assert.equal(match[5] === undefined, match[4] === "1", cell.label);
      total += Number(match[4]);
    }
    assert.equal(total, DATA.totals.messages);
    assert.equal(total, 252);
    assert.ok(cells.some((cell) => cell.label.endsWith(": 0 Nachrichten")));

    // Ein Tab-Stopp für das ganze Raster: das stärkste Feld.
    assert.deepEqual(
      cells.filter((cell) => cell.tabindex === 0).map((cell) => cell.label),
      ["Dienstag, 10–11 Uhr: 14 Nachrichten"]
    );
    assert.equal(cells.filter((cell) => cell.tabindex === -1).length, 167);
    // ohne Eingabe weder Tooltip noch Rahmen
    assert.doesNotMatch(html, /pointer-events-none/);
    assert.deepEqual([...new Set(cells.map((cell) => cell.stroke))], ["none"]);
    // Das Raster als Ganzes nennt Zeitraum, Summe und Höchstwert.
    assert.match(
      html,
      /role="group" aria-label="Raster mit 7 Wochentagen und 24 Stunden: Nachrichten nach Wochentag und Uhrzeit, 13\.09\.2026 bis 12\.10\.2026\. Summe 252, höchster Wert 14 \(Dienstag, 10–11 Uhr\)\. Mit den Pfeiltasten wechseln Sie zwischen den Feldern\."/
    );
  }
);

// ---------------------------------------------------------------------------
// Aussagen (AK-3, AK-4, NAK-3)
// ---------------------------------------------------------------------------

test(
  "staerkster_zeitabschnitt (AK-3): Die erste Aussage nennt „Dienstag, 10–11 Uhr“",
  { skip },
  async () => {
    const html = await card(DATA);
    assert.equal(
      blockOf(html, 'data-statement="peak"'),
      "Stärkster Zeitabschnitt Dienstag, 10–11 Uhr 14 Nachrichten"
    );
    assert.match(
      html,
      /<div data-statement="peak"[^>]*><dt[^>]*>Stärkster Zeitabschnitt<\/dt><dd[^>]*>Dienstag, 10–11 Uhr<\/dd>/
    );
    // Die Aussagen stehen über dem Raster.
    assert.ok(
      html.indexOf('data-statement="outside"') < html.indexOf("data-heat-grid")
    );
    assert.ok(
      html.indexOf('data-statement="peak"') <
        html.indexOf('data-statement="outside"')
    );
  }
);

test(
  "anteil_ausserhalb (AK-4, NAK-3): je 100 Nachrichten 60 Montag–Freitag zwischen 8:00 und 16:59 Uhr – „40 % der Nachrichten“ unter „Außerhalb von Montag–Freitag, 8–17 Uhr“, mit dem Hinweis zu Feiertagen",
  { skip },
  async () => {
    assert.equal(CORE.totals.messages, 300);
    const html = await card(CORE);

    assert.match(
      html,
      /<div data-statement="outside"[^>]*><dt[^>]*>Außerhalb von Montag–Freitag, 8–17 Uhr<\/dt><dd[^>]*>40 % der Nachrichten<\/dd><dd[^>]*>Feiertage zählen als normale Wochentage\.<\/dd><\/div>/
    );
    assert.equal(
      blockOf(html, 'data-statement="peak"'),
      "Stärkster Zeitabschnitt Dienstag, 10–11 Uhr 42 Nachrichten"
    );
    // keine Aussage über die Geschäftszeiten des Kunden
    assert.doesNotMatch(
      textOf(html),
      /Geschäftszeit|Öffnungszeit|Ihrer? Zeiten/i
    );

    // Der Bestand aus AK-1 hat seinen eigenen Anteil.
    const inside = DISTRIBUTION.cells
      .filter(
        ({ day, hour }) =>
          scenarios.weekdayOf(day) <= 4 && hour >= 8 && hour < 17
      )
      .reduce((total, cell) => total + cell.messages, 0);
    const percent = Math.round(((252 - inside) / 252) * 100);
    assert.ok(
      blockOf(await card(DATA), 'data-statement="outside"').includes(
        ` ${percent} % der Nachrichten `
      )
    );
  }
);

// ---------------------------------------------------------------------------
// Legende (AK-9)
// ---------------------------------------------------------------------------

test(
  "Legende (AK-9): „weniger … mehr“ zeigt die sechs Stufen mit ihren Wertebereichen",
  { skip },
  async () => {
    const html = await card(DATA);
    const legend = /<div data-heat-legend=""[^>]*>(.*?)<\/ul>.*?<\/div>/.exec(
      html
    )[0];
    assert.equal(textOf(legend), "weniger 0 1–2 3–5 6–8 9–11 12–14 mehr");
    const steps = [
      ...legend.matchAll(
        /<li data-heat-step="(\d)"[^>]*><span aria-hidden="true"[^>]*style="background-color:([^"]+)"><\/span><span[^>]*>([^<]*)<\/span><\/li>/g
      ),
    ].map(([, level, color, range]) => [Number(level), color, range]);
    assert.deepEqual(steps, [
      [0, "var(--theme-analytics-heat-0)", "0"],
      [1, "var(--theme-analytics-heat-1)", "1–2"],
      [2, "var(--theme-analytics-heat-2)", "3–5"],
      [3, "var(--theme-analytics-heat-3)", "6–8"],
      [4, "var(--theme-analytics-heat-4)", "9–11"],
      [5, "var(--theme-analytics-heat-5)", "12–14"],
    ]);
    assert.match(legend, /<ul aria-label="Legende: Nachrichten je Feld"/);

    // Große Werte in deutscher Schreibweise; ein einzelner Wert ohne Bereich
    const big = gridOf([]);
    big[1][10] = 6000;
    big[2][11] = 1;
    assert.match(
      textOf(await card(summaryOf([], { weekdayHour: big }))),
      /weniger 0 1–1\.200 1\.201–2\.400 2\.401–3\.600 3\.601–4\.800 4\.801–6\.000 mehr/
    );
  }
);

// ---------------------------------------------------------------------------
// Farbe ist nie der einzige Träger (Hard Constraint 3 und 4, NAK-2)
// ---------------------------------------------------------------------------

test(
  "Farbe: Die Stufen kommen aus dem Theme und stehen nur an Feldern und Legendenflächen – Text steht nie in der Datenfarbe",
  { skip },
  async () => {
    const html = await card(DATA);

    // 168 Felder + 6 Flächen der Legende, sonst nirgends
    assert.equal(count(html, /theme-analytics-heat-/g), 168 + 6);
    assert.equal(
      count(
        html,
        /<rect data-heat-tile=""[^>]* fill="var\(--theme-analytics-heat-[0-5]\)"/g
      ),
      168
    );
    assert.equal(
      count(
        html,
        /<span aria-hidden="true" class="[^"]*" style="background-color:var\(--theme-analytics-heat-[0-5]\)"><\/span>/g
      ),
      6
    );
    // Kein fest verdrahteter Farbwert: Die Farben kommen aus dem Theme.
    assert.doesNotMatch(html, /#[0-9a-f]{6}\b/i);
    assert.doesNotMatch(html, /rgb\(/);
    // Achsenbeschriftung in der gedämpften Textfarbe
    const texts = [...html.matchAll(/<text [^>]*fill="([^"]+)"/g)];
    assert.equal(texts.length, 8);
    assert.deepEqual(
      [...new Set(texts.map((match) => match[1]))],
      ["var(--theme-analytics-text-muted)"]
    );
    // Die Felder selbst tragen keinen Text: Die Zahl steht im Tooltip und in
    // der Tabelle.
    assert.doesNotMatch(html, /<g data-heat-cell=""[^>]*>(?:(?!<\/g>).)*<text/);
    // „Als Tabelle“ gehört zur Karte.
    assert.match(
      html,
      /aria-pressed="false"[^>]*>(<svg.*?<\/svg>)?Als Tabelle</
    );
  }
);

// ---------------------------------------------------------------------------
// Zu wenig Daten (AK-7), Leerzustand (AK-8), Laden
// ---------------------------------------------------------------------------

/** Die Karte zeigt nur den Hinweis: kein Raster, keine Aussagen, keine Legende. */
function assertOnlyHint(html, state, hint) {
  assert.match(html, new RegExp(`data-weekday-hour-card="${state}"`));
  assert.equal(blockOf(html, 'data-heat-frame=""'), hint);
  assert.equal(count(html, /data-heat-cell/g), 0);
  assert.equal(count(html, /data-statement/g), 0);
  assert.equal(count(html, /data-heat-legend/g), 0);
  assert.equal(count(html, /data-heat-table/g), 0);
  assert.doesNotMatch(html, /Als Tabelle/);
  assert.doesNotMatch(
    textOf(html),
    /Stärkster Zeitabschnitt|Außerhalb von|% der Nachrichten/
  );
  assert.doesNotMatch(html, /theme-analytics-heat-/);
  // Der Titel bleibt.
  assert.match(textOf(html), /^Wann schreiben Ihre Besucher\? /);
}

test(
  "Zu wenig Daten (AK-7 a): weniger als 28 Tage – „Für diese Ansicht bitte mindestens 28 Tage wählen“ statt des Rasters, keine Aussagen",
  { skip },
  async () => {
    for (const days of [27, 7, 1]) {
      const summary = {
        ...summaryOf(times(DISTRIBUTION.cells, 5)),
        fromDay: addDays(PERIOD.toDay, -(days - 1)),
      };
      assert.ok(summary.totals.messages > 1000);
      assertOnlyHint(
        await card(summary),
        "short-range",
        "Für diese Ansicht bitte mindestens 28 Tage wählen"
      );
    }
    // 28 Tage reichen.
    const enough = {
      ...DATA,
      fromDay: addDays(PERIOD.toDay, -27),
    };
    assert.equal(cellsOf(await card(enough)).length, 168);
  }
);

test(
  "Zu wenig Daten (AK-7 b): 30 Tage mit 150 Nachrichten – „Zu wenige Nachrichten für ein verlässliches Muster (mindestens 200)“ statt des Rasters, keine Aussagen",
  { skip },
  async () => {
    const few = (messages) => {
      const cells = [];
      for (let i = 0; i < messages; i++)
        cells.push({
          day: addDays(PERIOD.fromDay, i % 30),
          hour: 9 + (i % 8),
          messages: 1,
        });
      return summaryOf(cells);
    };
    assert.equal(few(150).totals.messages, 150);
    for (const messages of [150, 199, 1])
      assertOnlyHint(
        await card(few(messages)),
        "few-messages",
        "Zu wenige Nachrichten für ein verlässliches Muster (mindestens 200)"
      );
    // 200 Nachrichten reichen.
    const html = await card(few(200));
    assert.equal(cellsOf(html).length, 168);
    assert.equal(count(html, /data-statement/g), 2);
  }
);

test(
  "Leerzustand (AK-8): Zeitraum ohne Nachrichten – „Keine Nachrichten im gewählten Zeitraum“, keine Aussagen",
  { skip },
  async () => {
    assertOnlyHint(
      await card(summaryOf([])),
      "empty",
      "Keine Nachrichten im gewählten Zeitraum"
    );
    // auch in einem kurzen Zeitraum und für ein Widget ganz ohne Zählwerte
    assertOnlyHint(
      await card(summaryOf([], { fromDay: "2026-10-12" })),
      "empty",
      "Keine Nachrichten im gewählten Zeitraum"
    );
    assertOnlyHint(
      await card(summaryOf([], { firstLedgerDay: null })),
      "empty",
      "Keine Nachrichten im gewählten Zeitraum"
    );
  }
);

test(
  "Laden: vor der ersten Antwort „Laden...“, nach einem Fehler eine Meldung – nie Felder ohne Werte; eine Antwort ohne Raster zeigt keine Karte",
  { skip },
  async () => {
    const loading = await card(null, { loading: true });
    assert.equal(blockOf(loading, 'data-heat-frame=""'), "Laden...");
    assert.equal(count(loading, /data-heat-cell/g), 0);
    assert.equal(textOf(loading), "Wann schreiben Ihre Besucher? Laden...");
    assert.match(loading, /aria-busy="true"/);

    const failed = await card(null, { failed: true });
    assert.equal(
      blockOf(failed, 'data-heat-frame=""'),
      "Die Zählwerte konnten nicht geladen werden."
    );
    assert.equal(count(failed, /data-heat-cell/g), 0);

    // Wird neu geladen, bleibt die bisherige Darstellung gedämpft stehen.
    const reloading = await card(DATA, { loading: true });
    assert.equal(cellsOf(reloading).length, 168);
    assert.match(
      reloading,
      /class="transition-opacity opacity-50" aria-busy="true"/
    );

    // Antwort ohne weekdayHour (Server vor KIE-539) oder mit einem Raster,
    // dem etwas fehlt: keine Karte statt eines falschen Musters.
    const { weekdayHour, ...without } = DATA;
    assert.equal(await card(without), "");
    assert.equal(
      await card({ ...DATA, weekdayHour: weekdayHour.slice(0, 6) }),
      ""
    );
  }
);

test(
  "Beginn der Zählung: Beginnt der Zeitraum vor dem ersten Zählwert, nennt auch diese Karte den Tag",
  { skip },
  async () => {
    const html = await card({ ...DATA, firstLedgerDay: "2026-09-20" });
    assert.match(textOf(html), /Zählwerte liegen ab 20\.09\.2026 vor/);
    assert.doesNotMatch(textOf(await card(DATA)), /Zählwerte liegen ab/);
  }
);

// ---------------------------------------------------------------------------
// Seitenaufbau
// ---------------------------------------------------------------------------

test(
  "Seitenaufbau: Die Karte steht zwischen dem Säulendiagramm und der Konversationsliste",
  { skip },
  async () => {
    const html = await render(
      VIEW,
      {
        embedsLoaded: true,
        embeds: [
          { id: 3, chat_retention_days: 30, workspace: { name: "VHS" } },
        ],
      },
      { exportName: "AnalyticsScreen" }
    );
    const sections = [...html.matchAll(/<section /g)].map(
      (match) => match.index
    );
    assert.equal(sections.length, 2);
    const order = [
      html.indexOf('data-kpi="messages"'),
      sections[0],
      html.indexOf("Dargestellte Größe"),
      sections[1],
      html.indexOf("Wann schreiben Ihre Besucher?"),
      html.indexOf("Nur mit 👍"),
    ];
    assert.ok(
      order.every((index) => index >= 0),
      `Reihenfolge: ${order}`
    );
    assert.deepEqual(
      order,
      [...order].sort((a, b) => a - b)
    );
    assert.match(html, /<section [^>]*data-weekday-hour-card="pending"/);
  }
);
