// KIE-537: Vergleich mit dem Vorzeitraum – Schalter, Anfragen, Tooltip und
// Tabelle. Die Komponenten sind mit React DOM in ein Dokument ohne Browser
// eingehängt (helpers/renderSettingsPage.mjs, mount): Effekte laufen, Eingaben
// werden über die Handler der Elemente nachgestellt (helpers/testDom.mjs).
//
// Der Aufbau folgt embedAnalyticsInteraction.test.mjs (KIE-536); was dort für
// das Diagramm ohne Vergleich geprüft ist, bleibt dort. Themes, Graustufen und
// Layout bleiben Sache des Browser-Tests.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import {
  createRenderer,
  hasFrontendDeps,
} from "./helpers/renderSettingsPage.mjs";
import { click, elements, movePointer, pressKey } from "./helpers/testDom.mjs";
import {
  DEFAULT_RANGE_DAYS,
  addDays,
  formatDate,
  lastDaysRange,
  rangeFromDates,
  toDayString,
} from "../src/utils/analyticsTimeline.js";
// Adressen und Rümpfe der Anfragen – dieselben, mit denen der Server-Test die
// echten Routen aufruft (embedAnalyticsSummary.test.js).
import requests from "../../server/__tests__/endpoints/support/embedAnalyticsRequests.js";

const { ROUTES, summaryBody } = requests;

const DIR = "/src/pages/GeneralSettings/ChatEmbedWidgets/EmbedAnalytics";
const CHART = `${DIR}/TimelineChart.jsx`;
const VIEW = `${DIR}/index.jsx`;
const LOCATION = "/settings/chatbot/conversations";
const skip = hasFrontendDeps
  ? false
  : "frontend/node_modules nicht installiert";

let renderer;
before(async () => {
  if (hasFrontendDeps) renderer = await createRenderer();
});
after(async () => {
  await renderer?.close();
});

/** Hängt eine Komponente ein und räumt nach dem Test wieder ab. */
async function mount(t, modulePath, props, options = {}) {
  const mounted = await renderer.mount(modulePath, {
    location: LOCATION,
    props,
    ...options,
  });
  t.after(() => mounted.unmount());
  return mounted;
}

const withAttribute = (container, name) =>
  elements(container, (element) => element.hasAttribute(name));
const columnsOf = (container) => withAttribute(container, "data-column");
const barsOf = (container) =>
  withAttribute(container, "data-bar").map((bar) => bar.getAttribute("d"));
const switchOf = (container) => {
  const [toggle, ...more] = withAttribute(container, "data-compare-switch");
  assert.ok(toggle, "kein Schalter");
  assert.equal(more.length, 0, "mehr als ein Schalter");
  return toggle;
};
const isOn = (container) =>
  switchOf(container).getAttribute("aria-checked") === "true";
/** Linie des Vorzeitraums; null ohne Linie. */
const lineOf = (container) =>
  withAttribute(container, "data-previous-line")[0] ?? null;
const legendOf = (container) =>
  withAttribute(container, "data-chart-legend")[0] ?? null;
const noteOf = (container) =>
  withAttribute(container, "data-compare-note")[0] ?? null;
/** Hinweis über dem Diagramm, warum es keine Säulen gibt; null ohne. */
const chartNoteOf = (container) =>
  withAttribute(container, "data-chart-note")[0]?.textContent ?? null;
/** Text des Leerzustands im Rahmen des Diagramms; null ohne Rahmen. */
const frameOf = (container) =>
  withAttribute(container, "data-chart-frame")[0]?.textContent ?? null;
/** Zeilen der Veränderung in den Kennzahl-Feldern (sichtbarer Text). */
const changesOf = (container) =>
  withAttribute(container, "data-kpi-change").map(
    (line) => line.firstChild.textContent
  );
/** Die Kennzahl-Felder ohne die Zeile der Veränderung. */
const kpiTextOf = (container) =>
  withAttribute(container, "data-kpi").map((field) => {
    const [change] = withAttribute(field, "data-kpi-change");
    const text = field.textContent;
    return change ? text.slice(0, -change.textContent.length) : text;
  });
/** Der Tooltip: null, wenn keiner zu sehen ist. */
function tooltipOf(container) {
  const [tooltip, ...more] = elements(container, (element) =>
    (element.getAttribute("class") ?? "").includes("pointer-events-none")
  );
  assert.equal(more.length, 0, "mehr als ein Tooltip");
  return tooltip ?? null;
}
/** Zweite Zeile des Tooltips; null ohne Vergleich oder ohne Tooltip. */
const tooltipPreviousOf = (container) => {
  const tooltip = tooltipOf(container);
  if (!tooltip) return null;
  return (
    withAttribute(tooltip, "data-tooltip-previous")[0]?.textContent ?? null
  );
};
/** Wochentag eines Kalendertags, wie die deutsche Oberfläche ihn schreibt. */
const weekdayOf = (day) =>
  ["So.", "Mo.", "Di.", "Mi.", "Do.", "Fr.", "Sa."][
    new Date(`${day}T00:00:00Z`).getUTCDay()
  ];
/** Schaltfläche mit genau dieser Beschriftung. */
function buttonOf(container, label) {
  const [button, ...more] = elements(
    container,
    (element) => element.tagName === "BUTTON" && element.textContent === label
  );
  assert.ok(button, `keine Schaltfläche „${label}“`);
  assert.equal(more.length, 0, `mehrere Schaltflächen „${label}“`);
  return button;
}

// ---------------------------------------------------------------------------
// Der Server der Ansicht
// ---------------------------------------------------------------------------

const EMBED = {
  id: 3,
  chat_retention_days: 30,
  workspace: { name: "VHS Musterstadt" },
};
const SECOND_EMBED = {
  id: 7,
  chat_retention_days: null,
  workspace: { name: "VHS Beispielstadt" },
};
const TOTALS = {
  messages: 421,
  conversations: 60,
  feedbackPositive: 9,
  feedbackNegative: 3,
};
const PREVIOUS_TOTALS = {
  messages: 266,
  conversations: 0,
  feedbackPositive: 6,
  feedbackNegative: 4,
};
// Werte je Tag: im Zeitraum 14, 15, … – im Vorzeitraum darunter, damit die
// Achse dieselbe bleibt.
const CURRENT = (i) => 14 + i;
const PREVIOUS = (i) => 3 + (i % 5);

/** Adresse einer Route für das Widget, wie das Frontend sie aufruft. */
async function urlOf(route, embedId = EMBED.id) {
  const { API_BASE } = await renderer.load("/src/utils/constants.js");
  return `${API_BASE}${route.path.replace(":embedId", embedId)}`;
}

/**
 * Ersetzt fetch für die Dauer eines Tests. analytics/summary antwortet wie
 * der Server: je Tag des angefragten Zeitraums ein Abschnitt – und nur auf
 * compare: true zusätzlich previous, mit gleich vielen Tagen unmittelbar
 * davor. Der Vergleich ist verfügbar, solange der Vorzeitraum nicht vor
 * firstLedgerDay beginnt. Die Konversationsliste ist leer. summaryOf kann
 * die Antwort von analytics/summary für einzelne Anfragen ersetzen (Rumpf der
 * Anfrage → Antwort, null = wie oben).
 */
async function analyticsServer(t, { firstLedgerDay, summaryOf } = {}) {
  const first = firstLedgerDay ?? addDays(toDayString(new Date()), -400);
  const original = globalThis.fetch;
  const calls = [];
  const isSummary = (url) => url.endsWith("/analytics/summary");
  const isList = (url) => url.endsWith("/analytics/conversations");
  globalThis.fetch = async (url, init = {}) => {
    const body = init.body === undefined ? undefined : JSON.parse(init.body);
    calls.push({ method: init.method, url, body });
    return { ok: true, status: 200, json: async () => respond(url, body) };
  };
  t.after(() => {
    globalThis.fetch = original;
  });

  const bucketsOf = (from, count, value) =>
    Array.from({ length: count }, (_, i) => ({
      start: addDays(from, i),
      end: addDays(from, i),
      partial: false,
      messages: value(i),
      conversations: 2,
    }));
  function respond(url, body) {
    if (isList(url))
      return {
        success: true,
        conversations: [],
        hasMore: false,
        totalCount: 0,
      };
    if (!isSummary(url)) return { success: false, error: "unbekannt" };
    const own = summaryOf?.(body);
    if (own) return own;
    let count = 0;
    for (let day = body.fromDay; day <= body.toDay; day = addDays(day, 1))
      count++;
    const previousFrom = addDays(body.fromDay, -count);
    return {
      success: true,
      granularity: "day",
      fromDay: body.fromDay,
      toDay: body.toDay,
      firstLedgerDay: first,
      totals: TOTALS,
      buckets: bucketsOf(body.fromDay, count, CURRENT),
      ...(body.compare === true
        ? {
            previous: {
              available: previousFrom >= first,
              fromDay: previousFrom,
              toDay: addDays(body.fromDay, -1),
              totals: PREVIOUS_TOTALS,
              buckets: bucketsOf(previousFrom, count, PREVIOUS),
            },
          }
        : {}),
    };
  }
  return {
    calls,
    firstLedgerDay: first,
    summaries: () => calls.filter((call) => isSummary(call.url)),
    lists: () => calls.filter((call) => isList(call.url)),
    summaryUrl: await urlOf(ROUTES.summary),
  };
}

/** Die Ansicht im Standard-Zeitraum (letzte 30 Tage). */
async function mountView(t, embeds = [EMBED]) {
  const { startDate, endDate } = lastDaysRange(DEFAULT_RANGE_DAYS);
  const mounted = await mount(
    t,
    VIEW,
    { embedsLoaded: true, embeds },
    { exportName: "AnalyticsScreen" }
  );
  return { ...mounted, days: rangeFromDates(startDate, endDate) };
}

/** Wählt in der Datumsauswahl eine Vorauswahl, z. B. „Letzter Monat". */
async function choosePreset({ container, act }, label) {
  const buttons = () =>
    elements(container, (element) => element.tagName === "BUTTON");
  const trigger = buttons().find((button) =>
    /^(\d{2}\.\d{2}\.\d{4} - \d{2}\.\d{2}\.\d{4}|Gesamt)$/.test(
      button.textContent
    )
  );
  await act(() => click(trigger));
  // erste Schaltfläche des Popovers: das Menü der Vorauswahlen
  await act(() => click(buttons()[buttons().indexOf(trigger) + 1]));
  await act(() => click(buttonOf(container, label)));
}

/** Wählt in der Kopfzeile ein anderes Widget. */
async function chooseWidget({ container, act }, embed) {
  const [dropdown] = elements(
    container,
    (element) => element.getAttribute("aria-haspopup") === "listbox"
  );
  await act(() => click(dropdown));
  const [option] = elements(
    container,
    (element) =>
      element.getAttribute("role") === "option" &&
      element.textContent.startsWith(`Embed #${embed.id} `)
  );
  await act(() => click(option));
}

// ---------------------------------------------------------------------------
// Schalter und Anfragen (AK-8, NAK-2, Hard Constraint 6)
// ---------------------------------------------------------------------------

test(
  "Schalter aus (AK-8): Beim Laden der Ansicht wird compare nicht angefragt – der Schalter ist aus, keine Linie, keine Zeile der Veränderung",
  { skip },
  async (t) => {
    const server = await analyticsServer(t);
    const { container, days } = await mountView(t);

    assert.deepEqual(server.summaries(), [
      {
        method: ROUTES.summary.method,
        url: server.summaryUrl,
        body: summaryBody(days.fromDay, days.toDay),
      },
    ]);
    assert.deepEqual(Object.keys(server.summaries()[0].body), [
      "fromDay",
      "toDay",
    ]);
    assert.ok(!("compare" in server.summaries()[0].body));

    assert.equal(isOn(container), false);
    assert.equal(switchOf(container).getAttribute("role"), "switch");
    assert.equal(switchOf(container).textContent, "Vorzeitraum vergleichen");
    assert.equal(lineOf(container), null);
    assert.equal(legendOf(container), null);
    assert.deepEqual(changesOf(container), []);
    assert.equal(columnsOf(container).length, 30);
  }
);

test(
  "Schalter an und wieder aus (AK-8, NAK-2): eingeschaltet fragt die Ansicht denselben Zeitraum mit compare: true an, ausgeschaltet wieder ohne – die großen Zahlen und die Säulen bleiben dieselben",
  { skip },
  async (t) => {
    const server = await analyticsServer(t);
    const { container, act, days } = await mountView(t);
    const kpis = kpiTextOf(container);
    const bars = barsOf(container);
    assert.equal(kpis.length, 4);
    assert.match(kpis[0], /^Nachrichten421/);
    assert.equal(bars.length, 30);

    // ein
    await act(() => click(switchOf(container)));
    assert.equal(isOn(container), true);
    assert.equal(server.summaries().length, 2);
    assert.deepEqual(server.summaries()[1], {
      method: ROUTES.summary.method,
      url: server.summaryUrl,
      body: summaryBody(days.fromDay, days.toDay, { compare: true }),
    });
    assert.equal(server.summaries()[1].body.compare, true);
    assert.ok(lineOf(container), "keine Linie");
    assert.equal(
      legendOf(container).textContent,
      `Gewählter ZeitraumVorzeitraum${formatDate(addDays(days.fromDay, -30))}–${formatDate(addDays(days.fromDay, -1))}`
    );
    assert.deepEqual(changesOf(container), [
      "+58 % ggü. Vorzeitraum (266)",
      "Vorzeitraum: 0",
      "+50 % ggü. Vorzeitraum (6)",
      "−25 % ggü. Vorzeitraum (4)",
    ]);
    // Zahlen und Säulen des gewählten Zeitraums: unverändert
    assert.deepEqual(kpiTextOf(container), kpis);
    assert.deepEqual(barsOf(container), bars);

    // aus
    await act(() => click(switchOf(container)));
    assert.equal(isOn(container), false);
    assert.equal(server.summaries().length, 3);
    assert.deepEqual(
      server.summaries()[2].body,
      summaryBody(days.fromDay, days.toDay)
    );
    assert.ok(!("compare" in server.summaries()[2].body));
    assert.equal(lineOf(container), null);
    assert.equal(legendOf(container), null);
    assert.deepEqual(changesOf(container), []);
    assert.deepEqual(kpiTextOf(container), kpis);
    assert.deepEqual(barsOf(container), bars);

    // Die Konversationsliste hängt nicht am Schalter.
    assert.equal(server.lists().length, 1);
  }
);

test(
  "Schalter (Hard Constraint 6): Der Zustand bleibt beim Wechsel von Zeitraum und Widget erhalten – eingeschaltet wie ausgeschaltet",
  { skip },
  async (t) => {
    const server = await analyticsServer(t);
    const view = await mountView(t, [EMBED, SECOND_EMBED]);
    const { container, act, days } = view;

    await act(() => click(switchOf(container)));
    assert.equal(isOn(container), true);

    // anderer Zeitraum: Der Vergleich geht mit.
    await choosePreset(view, "Letzter Monat");
    const month = server.summaries().at(-1);
    assert.notEqual(month.body.toDay, days.toDay);
    assert.equal(month.body.compare, true);
    assert.deepEqual(Object.keys(month.body), ["fromDay", "toDay", "compare"]);
    assert.equal(isOn(container), true);
    assert.ok(lineOf(container));
    assert.equal(changesOf(container).length, 4);

    // anderes Widget
    await chooseWidget(view, SECOND_EMBED);
    assert.deepEqual(server.summaries().at(-1), {
      method: ROUTES.summary.method,
      url: await urlOf(ROUTES.summary, SECOND_EMBED.id),
      body: summaryBody(month.body.fromDay, month.body.toDay, {
        compare: true,
      }),
    });
    assert.equal(isOn(container), true);
    assert.ok(lineOf(container));

    // Ausgeschaltet bleibt er ebenso aus.
    await act(() => click(switchOf(container)));
    await choosePreset(view, "Letzte 30 Tage");
    await chooseWidget(view, EMBED);
    assert.equal(isOn(container), false);
    assert.deepEqual(server.summaries().at(-1), {
      method: ROUTES.summary.method,
      url: server.summaryUrl,
      body: summaryBody(days.fromDay, days.toDay),
    });
    for (const { body } of server.summaries().slice(-2))
      assert.ok(!("compare" in body));
    assert.equal(lineOf(container), null);
    assert.deepEqual(changesOf(container), []);
  }
);

test(
  "Kein Vergleich (AK-6): Beginnt der Vorzeitraum vor dem ersten Zählwert, zeigen die Kennzahl-Felder „Kein Vergleich verfügbar“, das Diagramm nennt den Tag – keine Linie; die Säulen bleiben",
  { skip },
  async (t) => {
    // Zählwerte erst seit 40 Tagen: Der Vorzeitraum der letzten 30 Tage
    // beginnt davor.
    const today = toDayString(new Date());
    const server = await analyticsServer(t, {
      firstLedgerDay: addDays(today, -40),
    });
    const { container, act } = await mountView(t);
    const kpis = kpiTextOf(container);
    const bars = barsOf(container);

    await act(() => click(switchOf(container)));

    assert.equal(server.summaries().at(-1).body.compare, true);
    assert.equal(isOn(container), true);
    assert.equal(lineOf(container), null);
    assert.equal(legendOf(container), null);
    assert.deepEqual(
      changesOf(container),
      Array.from({ length: 4 }, () => "Kein Vergleich verfügbar")
    );
    assert.equal(
      noteOf(container).textContent,
      `Kein Vergleich verfügbar: Der Vorzeitraum beginnt vor dem ${formatDate(addDays(today, -40))}, dem ersten Tag mit Zählwerten.`
    );
    assert.deepEqual(kpiTextOf(container), kpis);
    assert.deepEqual(barsOf(container), bars);
    // Kein Wert des Vorzeitraums, auch nicht im Tooltip
    await act(() =>
      movePointer(container.ownerDocument, columnsOf(container)[5])
    );
    assert.ok(tooltipOf(container));
    assert.equal(tooltipPreviousOf(container), null);
    assert.doesNotMatch(container.textContent, /266|ggü\./);

    // Ausgeschaltet verschwindet die Angabe wieder.
    await act(() => click(switchOf(container)));
    assert.equal(noteOf(container), null);
    assert.deepEqual(changesOf(container), []);
  }
);

test(
  "„Gesamt“ mit Vergleich: Die Frage nach dem ersten Tag mit Zählwerten geht ohne compare, der Zeitraum mit – sein Vorzeitraum liegt vor der Zählung",
  { skip },
  async (t) => {
    const server = await analyticsServer(t);
    const view = await mountView(t);
    const { container, act } = view;
    const today = toDayString(new Date());

    await act(() => click(switchOf(container)));
    const before = server.summaries().length;
    await choosePreset(view, "Gesamt");

    assert.deepEqual(
      server
        .summaries()
        .slice(before)
        .map((call) => call.body),
      [
        summaryBody(today, today),
        summaryBody(server.firstLedgerDay, today, { compare: true }),
      ]
    );
    assert.equal(isOn(container), true);
    assert.equal(lineOf(container), null);
    assert.deepEqual(
      changesOf(container),
      Array.from({ length: 4 }, () => "Kein Vergleich verfügbar")
    );
    assert.ok(noteOf(container));
  }
);

// ---------------------------------------------------------------------------
// Tooltip und Tabelle (AK-5)
// ---------------------------------------------------------------------------

// 30 Tage ab 13.09.2026: der 06.10. ist Platz 23, der 07.10. Platz 24.
const FROM = "2026-09-13";
const OCT_06 = 23;
const OCT_07 = 24;
const dayBuckets = (from, value, conversations) =>
  Array.from({ length: 30 }, (_, i) => ({
    start: addDays(from, i),
    end: addDays(from, i),
    partial: false,
    messages: value(i),
    conversations: conversations(i),
  }));
const sum = (buckets, key) =>
  buckets.reduce((total, bucket) => total + bucket[key], 0);
const THIRTY_DAYS = {
  success: true,
  granularity: "day",
  fromDay: FROM,
  toDay: addDays(FROM, 29),
  firstLedgerDay: "2026-01-01",
  totals: {
    messages: 885,
    conversations: 60,
    feedbackPositive: 9,
    feedbackNegative: 3,
  },
  buckets: dayBuckets(
    FROM,
    (i) => 14 + i,
    () => 2
  ),
  previous: {
    available: true,
    fromDay: "2026-08-14",
    toDay: "2026-09-12",
    totals: {
      messages: 1500,
      conversations: 45,
      feedbackPositive: 6,
      feedbackNegative: 4,
    },
    // 1.008 am Platz des 06.10., sonst 8, 9, …
    buckets: dayBuckets(
      "2026-08-14",
      (i) => (i === OCT_06 ? 1008 : 8 + i),
      (i) => i % 3
    ),
  },
};

test(
  "Tooltip (AK-5): nennt zusätzlich den Wert des Vorzeitraums mit seinem Abschnitt, „Vorzeitraum: Mo., 07.09.2026 — 32 Nachrichten“ – unter dem Mauszeiger und mit der Tastatur",
  { skip },
  async (t) => {
    const { container, document, act } = await mount(t, CHART, {
      summary: THIRTY_DAYS,
      loading: false,
      compare: true,
    });
    const columns = columnsOf(container);
    assert.equal(columns.length, 30);
    assert.equal(tooltipOf(container), null);

    // Der 07.10. ist der 25. Tag des Zeitraums: Die Linie zeigt dort den 25.
    // Tag des Vorzeitraums, den 07.09. – die zweite Zeile nennt ihn, in
    // derselben Schreibweise wie die erste.
    await act(() => movePointer(document, columns[OCT_07]));
    assert.equal(
      tooltipPreviousOf(container),
      "Vorzeitraum: Mo., 07.09.2026 — 32 Nachrichten"
    );
    assert.equal(
      tooltipOf(container).textContent,
      "Mi., 07.10.2026 — 38 NachrichtenVorzeitraum: Mo., 07.09.2026 — 32 Nachrichten"
    );
    // Die zweite Zeile ist eine eigene Zeile, in deutscher Zahlenschreibweise.
    await act(() => movePointer(document, columns[OCT_06]));
    assert.equal(
      tooltipPreviousOf(container),
      "Vorzeitraum: So., 06.09.2026 — 1.008 Nachrichten"
    );
    const [second] = withAttribute(
      tooltipOf(container),
      "data-tooltip-previous"
    );
    assert.match(second.getAttribute("class"), /(^| )block( |$)/);
    await act(() => movePointer(document, null));
    assert.equal(tooltipOf(container), null);

    // Tastatur: Tab-Stopp, Pfeiltasten – der Tooltip folgt mit beiden Zeilen.
    await act(() => columns[29].focus());
    assert.equal(
      tooltipOf(container).textContent,
      "Mo., 12.10.2026 — 43 NachrichtenVorzeitraum: Sa., 12.09.2026 — 37 Nachrichten"
    );
    await act(() => pressKey(document, "ArrowLeft"));
    assert.equal(document.activeElement, columns[28]);
    assert.equal(
      tooltipPreviousOf(container),
      "Vorzeitraum: Fr., 11.09.2026 — 36 Nachrichten"
    );
    await act(() => pressKey(document, "Home"));
    assert.equal(
      tooltipOf(container).textContent,
      "So., 13.09.2026 — 14 NachrichtenVorzeitraum: Fr., 14.08.2026 — 8 Nachrichten"
    );
    // Dieselbe Angabe wie am Säulenplatz für Screenreader – an jedem Platz
    assert.match(
      columns[0].getAttribute("aria-label"),
      /^So\., 13\.09\.2026 — 14 Nachrichten\. Vorzeitraum: Fr\., 14\.08\.2026 — 8 Nachrichten\. Die Eingabetaste /
    );
    for (const [i, column] of columns.entries()) {
      await act(() => movePointer(document, column));
      const previous = tooltipPreviousOf(container);
      assert.match(
        previous,
        /^Vorzeitraum: [A-Z][a-z]\., \d\d\.\d\d\.2026 — [\d.]+ Nachrichten$/
      );
      assert.ok(
        column.getAttribute("aria-label").includes(`. ${previous}. `),
        `Platz ${i}`
      );
    }
  }
);

test(
  "Tooltip ohne Vergleich: einzeilig wie in KIE-536 – auch wenn die Antwort einen Vorzeitraum nennt",
  { skip },
  async (t) => {
    const { container, document, act } = await mount(t, CHART, {
      summary: THIRTY_DAYS,
      loading: false,
      compare: false,
    });
    await act(() => movePointer(document, columnsOf(container)[OCT_06]));
    assert.equal(
      tooltipOf(container).textContent,
      "Di., 06.10.2026 — 37 Nachrichten"
    );
    assert.equal(tooltipPreviousOf(container), null);
    assert.equal(
      columnsOf(container)[0].getAttribute("aria-label"),
      "So., 13.09.2026 — 14 Nachrichten. Die Eingabetaste zeigt in der Liste nur die Konversationen dieses Abschnitts."
    );
  }
);

test(
  "Tooltip: steht über der Linie, wo sie über den Säulen liegt – er verdeckt weder die Punktmarke noch eine Säule",
  { skip },
  async (t) => {
    const top = async (compare, i) => {
      const { container, document, act, unmount } = await mount(t, CHART, {
        summary: THIRTY_DAYS,
        loading: false,
        compare,
      });
      await act(() => movePointer(document, columnsOf(container)[i]));
      const tooltip = tooltipOf(container);
      // außerhalb des Textflusses: Die Karte ändert ihre Größe nicht.
      assert.match(tooltip.getAttribute("class"), /(^| )absolute( |$)/);
      const marker = withAttribute(container, "data-previous-marker")[i];
      const result = {
        top: parseFloat(tooltip.style.top),
        marker: marker ? Number(marker.getAttribute("cy")) : null,
      };
      await unmount();
      return result;
    };

    // Am 06.10. liegt der Vorzeitraum (1.008) weit über der Säule (37).
    const compared = await top(true, OCT_06);
    // Oberkante der Zeichenfläche bei 12 px; die Marke hat 3 px Radius + 1 px
    // am angesteuerten Platz, der Tooltip 8 px Abstand.
    assert.ok(compared.top <= 12 + compared.marker - 3 - 8);
    // Ohne Vergleich gibt es keine Linie: Er steht über den Säulen.
    const plain = await top(false, OCT_06);
    assert.equal(plain.marker, null);
    assert.ok(Number.isFinite(plain.top));
  }
);

/**
 * Das Diagramm misst seine Breite am umgebenden Element und folgt ihr über
 * einen ResizeObserver. Liefert eine Funktion, die die Breite setzt.
 */
function chartWidth(t) {
  const observers = [];
  globalThis.ResizeObserver = class {
    constructor(callback) {
      this.callback = callback;
    }
    observe(element) {
      observers.push({ element, callback: this.callback });
    }
    disconnect() {}
  };
  t.after(() => delete globalThis.ResizeObserver);
  return (width) => {
    assert.equal(observers.length, 1);
    for (const { element, callback } of observers) {
      element.getBoundingClientRect = () => ({ width });
      callback();
    }
  };
}

test(
  "Tooltip mit dem Abschnitt des Vorzeitraums im schmalen Diagramm (320, 308 und 240 px): Die längere zweite Zeile bestimmt die Breite – er bleibt an jedem Platz im Diagramm und über Säulen und Linie",
  { skip },
  async (t) => {
    const setWidth = chartWidth(t);
    const { container, document, act } = await mount(t, CHART, {
      summary: THIRTY_DAYS,
      loading: false,
      compare: true,
    });
    const columns = columnsOf(container);
    /** Wo der Tooltip höchstens liegen kann: Anker und Höchstbreite. */
    const boxOf = ({ style }, width) => {
      const max = parseFloat(style.maxWidth);
      assert.ok(max > 0, "keine Höchstbreite");
      if (style.right !== undefined && style.right !== "") {
        const right = width - parseFloat(style.right);
        return { left: right - max, right, max };
      }
      const left = parseFloat(style.left);
      return style.transform.startsWith("translate(-50%")
        ? { left: left - max / 2, right: left + max / 2, max }
        : { left, right: left + max, max };
    };
    /**
     * Oberkanten der Säulen und der Punktmarken der Linie (3 px Radius), ab
     * der Zeichenfläche.
     */
    const topsOf = () => [
      ...barsOf(container).map((d) => Number(d.match(/Q[\d.]+,([\d.]+) /)[1])),
      ...elements(lineOf(container), (element) => element.tagName === "path")[0]
        .getAttribute("d")
        .split(" ")
        .map((command) => Number(command.slice(1).split(",")[1]) - 3),
    ];

    for (const width of [320, 308, 240]) {
      await act(() => setWidth(width));
      const highest = Math.min(...topsOf());
      for (const [i, column] of columns.entries()) {
        await act(() => movePointer(document, column));
        const tooltip = tooltipOf(container);
        const where = `${width} px, Platz ${i}`;
        const first = tooltip.firstChild.textContent;
        const second = tooltipPreviousOf(container);
        assert.ok(second.length > tooltip.textContent.length / 2, where);
        const classes = tooltip.getAttribute("class").split(" ");
        // so breit wie der Text, aber umbrechbar – und außerhalb des Textflusses
        for (const name of ["w-max", "break-words", "absolute"])
          assert.ok(classes.includes(name), where);
        assert.ok(!classes.includes("whitespace-nowrap"), where);
        const box = boxOf(tooltip, width);
        assert.ok(box.left >= 0 && box.right <= width, where);
        // Platz für die längere Zeile – die erste allein brauchte weniger.
        const estimated = Math.min(width, second.length * 6.5 + 22);
        assert.ok(first.length < second.length, where);
        assert.ok(box.max >= estimated, where);
        // Die Unterkante steht fest: Mehr Zeilen wachsen nach oben.
        assert.match(tooltip.style.transform, /-100%\)$/, where);
        // Überspannt er das ganze Diagramm, steht er über der höchsten Säule
        // und der höchsten Punktmarke der Linie, mit 8 px Abstand (Oberkante
        // der Zeichenfläche bei 12 px; der Pfad der Linie ist auf 0,01 px
        // gerundet).
        if (estimated === width)
          assert.ok(
            Math.abs(parseFloat(tooltip.style.top) - (12 + highest - 8)) < 0.01,
            where
          );
      }
    }

    // 320 px, erster Platz: „So., 13.09.2026 — 14 Nachrichten“ (geschätzt
    // 230 px) stünde 16 px nach innen gerückt bei 32,3 px. „Vorzeitraum: Fr.,
    // 14.08.2026 — 8 Nachrichten“ (308 px) ragte dort hinaus: 12 px vom Rand.
    await act(() => setWidth(320));
    await act(() => movePointer(document, columns[0]));
    const first = tooltipOf(container);
    assert.equal(
      tooltipPreviousOf(container),
      "Vorzeitraum: Fr., 14.08.2026 — 8 Nachrichten"
    );
    assert.equal(first.style.left, "12px");
    assert.equal(first.style.maxWidth, "308px");
    assert.equal(first.style.transform, "translateY(-100%)");
    // Platz des 10.10. (bei 289,7 px), vom rechten Rand: 16 px nach innen
    // gerückt wären 14,3 px – mit 314,5 px Breite bleiben 5,5 px.
    await act(() => movePointer(document, columns[27]));
    const right = tooltipOf(container);
    assert.equal(
      tooltipPreviousOf(container),
      "Vorzeitraum: Do., 10.09.2026 — 35 Nachrichten"
    );
    assert.equal(right.style.right, "5.5px");
    assert.equal(right.style.maxWidth, "314.5px");

    // 308 px (Handy): breiter geschätzt als das Diagramm – über die ganze
    // Breite, mit Umbruch.
    await act(() => setWidth(308));
    await act(() => movePointer(document, columns[29]));
    assert.equal(tooltipOf(container).style.right, "0");
    assert.equal(tooltipOf(container).style.maxWidth, "308px");

    // Breit bleibt er, wie er war: mittig über dem Platz.
    await act(() => setWidth(1130));
    await act(() => movePointer(document, columns[15]));
    assert.ok(
      Math.abs(
        parseFloat(tooltipOf(container).style.left) - (44 + 15.5 * (1078 / 30))
      ) < 1e-6
    );
    assert.equal(
      tooltipOf(container).style.transform,
      "translate(-50%, -100%)"
    );
  }
);

test(
  "Tabelle (AK-5): Mit Vergleich hat jede Größe eine zweite Spalte mit dem Wert des Vorzeitraums; die Summen sind die der Spalten",
  { skip },
  async (t) => {
    const { container, act } = await mount(t, CHART, {
      summary: THIRTY_DAYS,
      loading: false,
      compare: true,
    });
    await act(() => click(buttonOf(container, "Als Tabelle")));

    const rowsOf = (section) =>
      elements(container, (element) => element.tagName === section).flatMap(
        (part) =>
          elements(part, (element) => element.tagName === "TR").map((row) =>
            elements(row, (cell) => ["TH", "TD"].includes(cell.tagName)).map(
              (cell) => cell.textContent
            )
          )
      );
    assert.deepEqual(rowsOf("THEAD"), [
      [
        "Zeitabschnitt",
        "Nachrichten",
        "Nachrichten (Vorzeitraum)",
        "Konversationen",
        "Konversationen (Vorzeitraum)",
      ],
    ]);
    const body = rowsOf("TBODY");
    assert.equal(body.length, 30);
    assert.deepEqual(body[0], ["So., 13.09.2026", "14", "8", "2", "0"]);
    assert.deepEqual(body[OCT_06], [
      "Di., 06.10.2026",
      "37",
      "1.008",
      "2",
      "2",
    ]);
    assert.deepEqual(body[29], ["Mo., 12.10.2026", "43", "37", "2", "2"]);
    for (const row of body) assert.equal(row.length, 5);

    const previous = THIRTY_DAYS.previous.buckets;
    assert.equal(sum(previous, "messages"), 1652);
    assert.deepEqual(rowsOf("TFOOT"), [
      ["Summe", "885", "1.652", "60", String(sum(previous, "conversations"))],
    ]);
    // In der Tabelle gibt es keine Linie und keine Legende.
    assert.equal(lineOf(container), null);
    assert.equal(legendOf(container), null);
  }
);

test(
  "Tabelle ohne Vergleich und ohne verfügbaren Vergleich: drei Spalten wie in KIE-536",
  { skip },
  async (t) => {
    for (const props of [
      { summary: THIRTY_DAYS, compare: false },
      {
        summary: {
          ...THIRTY_DAYS,
          firstLedgerDay: "2026-09-01",
          previous: { ...THIRTY_DAYS.previous, available: false },
        },
        compare: true,
      },
    ]) {
      const { container, act, unmount } = await mount(t, CHART, {
        ...props,
        loading: false,
      });
      await act(() => click(buttonOf(container, "Als Tabelle")));
      const header = elements(
        container,
        (element) =>
          element.tagName === "TH" && element.getAttribute("scope") === "col"
      ).map((cell) => cell.textContent);
      assert.deepEqual(header, [
        "Zeitabschnitt",
        "Nachrichten",
        "Konversationen",
      ]);
      assert.doesNotMatch(container.textContent, /1\.008|\(Vorzeitraum\)/);
      // Warum es keinen Vergleich gibt, steht auch über der Tabelle.
      assert.equal(!!noteOf(container), props.compare);
      await unmount();
    }
  }
);

// ---------------------------------------------------------------------------
// Zeitraum ohne Werte, Vorzeitraum mit Werten (AK-5, AK-7)
// ---------------------------------------------------------------------------

/** Kopfzeile, Zeilen und Summe der Tabelle; null ohne Tabelle. */
function tableOf(container) {
  const [table] = elements(container, (element) => element.tagName === "TABLE");
  if (!table) return null;
  const rowsOf = (section) =>
    elements(table, (element) => element.tagName === section).flatMap((part) =>
      elements(part, (element) => element.tagName === "TR").map((row) =>
        elements(row, (cell) => ["TH", "TD"].includes(cell.tagName)).map(
          (cell) => cell.textContent
        )
      )
    );
  return {
    head: rowsOf("THEAD")[0],
    body: rowsOf("TBODY"),
    foot: rowsOf("TFOOT")[0],
  };
}

// Wie THIRTY_DAYS, im gewählten Zeitraum aber keine Nachricht.
const NO_MESSAGES = {
  ...THIRTY_DAYS,
  totals: {
    messages: 0,
    conversations: 0,
    feedbackPositive: 0,
    feedbackNegative: 0,
  },
  buckets: dayBuckets(
    FROM,
    () => 0,
    () => 0
  ),
};

test(
  "Zeitraum ohne Nachrichten: Mit Vergleich zeigt „Als Tabelle“ die Werte des Vorzeitraums, das Diagramm die Linie über Plätzen ohne Säulen – ohne Vergleich bleibt es in beiden beim Leerzustand",
  { skip },
  async (t) => {
    const { container, document, act } = await mount(t, CHART, {
      summary: NO_MESSAGES,
      loading: false,
      compare: true,
    });
    assert.equal(frameOf(container), null);
    assert.equal(columnsOf(container).length, 30);
    assert.deepEqual(barsOf(container), []);
    assert.ok(lineOf(container), "keine Linie");
    assert.ok(legendOf(container), "keine Legende");
    assert.equal(
      chartNoteOf(container),
      "Keine Nachrichten im gewählten Zeitraum"
    );
    // Der Tooltip nennt beide Werte; ein Platz ohne Säule filtert nicht.
    await act(() => movePointer(document, columnsOf(container)[OCT_06]));
    assert.equal(
      tooltipOf(container).textContent,
      "Di., 06.10.2026 — 0 NachrichtenVorzeitraum: So., 06.09.2026 — 1.008 Nachrichten"
    );
    assert.equal(columnsOf(container)[OCT_06].getAttribute("role"), "img");
    await act(() => movePointer(document, null));

    await act(() => click(buttonOf(container, "Als Tabelle")));
    assert.equal(frameOf(container), null);
    const table = tableOf(container);
    assert.ok(table, "keine Tabelle");
    assert.deepEqual(table.head, [
      "Zeitabschnitt",
      "Nachrichten",
      "Nachrichten (Vorzeitraum)",
      "Konversationen",
      "Konversationen (Vorzeitraum)",
    ]);
    assert.equal(table.body.length, 30);
    assert.deepEqual(table.body[0], ["So., 13.09.2026", "0", "8", "0", "0"]);
    assert.deepEqual(table.body[OCT_06], [
      "Di., 06.10.2026",
      "0",
      "1.008",
      "0",
      "2",
    ]);
    assert.deepEqual(table.foot, [
      "Summe",
      "0",
      "1.652",
      "0",
      String(sum(THIRTY_DAYS.previous.buckets, "conversations")),
    ]);
    // Linie, Legende und Hinweis gehören zum Diagramm.
    assert.equal(lineOf(container), null);
    assert.equal(legendOf(container), null);
    assert.equal(chartNoteOf(container), null);
    await act(() => click(buttonOf(container, "Als Tabelle")));
    assert.ok(lineOf(container));

    // Die Linie zeigt die gewählte Größe, die Tabelle beide: Ohne Konversation
    // im Vorzeitraum bleibt „Konversationen“ beim Leerzustand, die Tabelle
    // nennt weiter die Nachrichten des Vorzeitraums.
    const messagesOnly = await mount(t, CHART, {
      loading: false,
      compare: true,
      summary: {
        ...NO_MESSAGES,
        previous: {
          ...NO_MESSAGES.previous,
          buckets: NO_MESSAGES.previous.buckets.map((bucket) => ({
            ...bucket,
            conversations: 0,
          })),
        },
      },
    });
    await messagesOnly.act(() =>
      click(buttonOf(messagesOnly.container, "Konversationen"))
    );
    assert.equal(
      frameOf(messagesOnly.container),
      "Keine Nachrichten im gewählten Zeitraum"
    );
    assert.equal(lineOf(messagesOnly.container), null);
    assert.equal(legendOf(messagesOnly.container), null);
    await messagesOnly.act(() =>
      click(buttonOf(messagesOnly.container, "Als Tabelle"))
    );
    assert.deepEqual(tableOf(messagesOnly.container).body[OCT_06], [
      "Di., 06.10.2026",
      "0",
      "1.008",
      "0",
      "0",
    ]);
    await messagesOnly.unmount();

    // Ohne Vergleich, ohne verfügbaren Vergleich und mit einem Vorzeitraum
    // ohne Werte: der Leerzustand von KIE-536 – auch als Tabelle.
    for (const props of [
      { summary: NO_MESSAGES, compare: false },
      {
        summary: {
          ...NO_MESSAGES,
          firstLedgerDay: "2026-09-01",
          previous: { ...NO_MESSAGES.previous, available: false },
        },
        compare: true,
      },
      {
        summary: {
          ...NO_MESSAGES,
          previous: {
            ...NO_MESSAGES.previous,
            buckets: NO_MESSAGES.buckets.map((bucket, i) => ({
              ...bucket,
              start: addDays("2026-08-14", i),
              end: addDays("2026-08-14", i),
            })),
          },
        },
        compare: true,
      },
    ]) {
      const other = await mount(t, CHART, { ...props, loading: false });
      for (const asTable of [false, true]) {
        if (asTable)
          await other.act(() =>
            click(buttonOf(other.container, "Als Tabelle"))
          );
        assert.equal(
          frameOf(other.container),
          "Keine Nachrichten im gewählten Zeitraum"
        );
        assert.equal(tableOf(other.container), null);
        assert.equal(columnsOf(other.container).length, 0);
        assert.equal(lineOf(other.container), null);
        assert.equal(legendOf(other.container), null);
        assert.equal(chartNoteOf(other.container), null);
      }
      await other.unmount();
    }
  }
);

test(
  "Größe „Konversationen“ ohne begonnene Konversation: Mit Werten im Vorzeitraum liegt die Linie über Plätzen ohne Säulen, der Hinweis steht darüber – ohne Werte bleibt es beim Leerzustand",
  { skip },
  async (t) => {
    // Nachrichten wie in THIRTY_DAYS, aber keine begonnene Konversation
    const noConversations = {
      ...THIRTY_DAYS,
      totals: { ...THIRTY_DAYS.totals, conversations: 0 },
      buckets: dayBuckets(
        FROM,
        (i) => 14 + i,
        () => 0
      ),
    };
    const { container, document, act } = await mount(t, CHART, {
      summary: noConversations,
      loading: false,
      compare: true,
    });
    // „Nachrichten“: Säulen und Linie wie sonst, kein Hinweis
    assert.equal(barsOf(container).length, 30);
    assert.ok(lineOf(container));
    assert.equal(chartNoteOf(container), null);
    const pathOf = () =>
      elements(
        lineOf(container),
        (element) => element.tagName === "path"
      )[0].getAttribute("d");
    const messages = pathOf();

    await act(() => click(buttonOf(container, "Konversationen")));
    assert.equal(frameOf(container), null);
    assert.equal(columnsOf(container).length, 30);
    assert.deepEqual(barsOf(container), []);
    assert.ok(lineOf(container), "keine Linie");
    assert.notEqual(pathOf(), messages);
    assert.ok(legendOf(container), "keine Legende");
    assert.equal(
      chartNoteOf(container),
      "Im gewählten Zeitraum wurde keine Konversation begonnen"
    );
    await act(() => movePointer(document, columnsOf(container)[OCT_06]));
    assert.equal(
      tooltipOf(container).textContent,
      "Di., 06.10.2026 — 0 KonversationenVorzeitraum: So., 06.09.2026 — 2 Konversationen"
    );
    await act(() => movePointer(document, null));
    // Die Tabelle gab es hier schon in KIE-536 – jetzt mit dem Vorzeitraum.
    await act(() => click(buttonOf(container, "Als Tabelle")));
    assert.deepEqual(tableOf(container).body[OCT_06], [
      "Di., 06.10.2026",
      "37",
      "1.008",
      "0",
      "2",
    ]);
    assert.equal(chartNoteOf(container), null);

    // Auch im Vorzeitraum keine Konversation, und ohne Vergleich: der
    // Leerzustand von KIE-536 – die Nachrichten des Vorzeitraums zählen für
    // diese Größe nicht.
    for (const props of [
      {
        summary: {
          ...noConversations,
          previous: {
            ...noConversations.previous,
            buckets: noConversations.previous.buckets.map((bucket) => ({
              ...bucket,
              conversations: 0,
            })),
          },
        },
        compare: true,
      },
      { summary: noConversations, compare: false },
    ]) {
      const other = await mount(t, CHART, { ...props, loading: false });
      await other.act(() => click(buttonOf(other.container, "Konversationen")));
      assert.equal(
        frameOf(other.container),
        "Im gewählten Zeitraum wurde keine Konversation begonnen"
      );
      assert.equal(columnsOf(other.container).length, 0);
      assert.equal(lineOf(other.container), null);
      assert.equal(legendOf(other.container), null);
      assert.equal(chartNoteOf(other.container), null);
      // „Nachrichten“ zeigt weiter die Säulen.
      await other.act(() => click(buttonOf(other.container, "Nachrichten")));
      assert.equal(barsOf(other.container).length, 30);
      assert.equal(!!lineOf(other.container), props.compare);
      await other.unmount();
    }
  }
);

test(
  "„Heute“ vor der ersten Nachricht (AK-7): Die Ansicht zeigt die 24 Stundenwerte von gestern als Linie, die Kennzahlen den Rückgang – ausgeschaltet wieder den Leerzustand",
  { skip },
  async (t) => {
    const today = toDayString(new Date());
    const yesterday = addDays(today, -1);
    const hoursOf = (day, value) =>
      Array.from({ length: 24 }, (_, hour) => ({
        start: day,
        end: day,
        partial: false,
        hour,
        messages: value(hour),
        conversations: value(hour) > 0 ? 1 : 0,
      }));
    const totalsOf = (buckets) => ({
      messages: sum(buckets, "messages"),
      conversations: sum(buckets, "conversations"),
      feedbackPositive: 0,
      feedbackNegative: 0,
    });
    // Heute noch keine Nachricht, gestern 8–18 Uhr je so viele wie die Stunde
    const server = await analyticsServer(t, {
      summaryOf: (body) => {
        if (body.fromDay !== body.toDay) return null;
        const buckets = hoursOf(body.fromDay, () => 0);
        const before = hoursOf(addDays(body.fromDay, -1), (hour) =>
          hour >= 8 && hour <= 18 ? hour : 0
        );
        return {
          success: true,
          granularity: "hour",
          fromDay: body.fromDay,
          toDay: body.toDay,
          firstLedgerDay: addDays(today, -400),
          totals: totalsOf(buckets),
          buckets,
          ...(body.compare === true
            ? {
                previous: {
                  available: true,
                  fromDay: addDays(body.fromDay, -1),
                  toDay: addDays(body.fromDay, -1),
                  totals: totalsOf(before),
                  buckets: before,
                },
              }
            : {}),
        };
      },
    });
    const view = await mountView(t);
    const { container, act } = view;
    await act(() => click(switchOf(container)));
    await choosePreset(view, "Heute");

    assert.deepEqual(
      server.summaries().at(-1).body,
      summaryBody(today, today, { compare: true })
    );
    assert.equal(frameOf(container), null);
    assert.equal(columnsOf(container).length, 24);
    assert.deepEqual(barsOf(container), []);
    const [path] = elements(
      lineOf(container),
      (element) => element.tagName === "path"
    );
    assert.equal(path.getAttribute("d").split(" ").length, 24);
    assert.equal(
      legendOf(container).textContent,
      `Gewählter ZeitraumVorzeitraum${formatDate(yesterday)}`
    );
    assert.equal(
      chartNoteOf(container),
      "Keine Nachrichten im gewählten Zeitraum"
    );
    // 9–10 Uhr heute: 0 – gestern in derselben Stunde 9
    assert.ok(
      columnsOf(container)[9]
        .getAttribute("aria-label")
        .endsWith(
          `${formatDate(today)}, 9–10 Uhr — 0 Nachrichten. Vorzeitraum: ${weekdayOf(yesterday)}, ${formatDate(yesterday)}, 9–10 Uhr — 9 Nachrichten`
        ),
      columnsOf(container)[9].getAttribute("aria-label")
    );
    assert.deepEqual(changesOf(container).slice(0, 2), [
      "−100 % ggü. Vorzeitraum (143)",
      "−100 % ggü. Vorzeitraum (11)",
    ]);

    await act(() => click(buttonOf(container, "Als Tabelle")));
    const table = tableOf(container);
    assert.equal(table.body.length, 24);
    assert.deepEqual(table.body[9].slice(1), ["0", "9", "0", "1"]);
    assert.deepEqual(table.foot, ["Summe", "0", "143", "0", "11"]);
    await act(() => click(buttonOf(container, "Als Tabelle")));

    // aus: der Leerzustand von KIE-536
    await act(() => click(switchOf(container)));
    assert.deepEqual(server.summaries().at(-1).body, summaryBody(today, today));
    assert.equal(frameOf(container), "Keine Nachrichten im gewählten Zeitraum");
    assert.equal(columnsOf(container).length, 0);
    assert.equal(lineOf(container), null);
    assert.equal(legendOf(container), null);
    assert.equal(chartNoteOf(container), null);
    assert.deepEqual(changesOf(container), []);
  }
);

// ---------------------------------------------------------------------------
// Bedienung des Diagramms mit eingeschaltetem Vergleich
// ---------------------------------------------------------------------------

test(
  "Mit Vergleich unverändert: Schalter Nachrichten | Konversationen – Säulen und Linie zeigen dieselbe Größe; „Als Tabelle“ und zurück",
  { skip },
  async (t) => {
    const { container, document, act } = await mount(t, CHART, {
      summary: THIRTY_DAYS,
      loading: false,
      compare: true,
    });
    const pathOf = () =>
      elements(
        lineOf(container),
        (element) => element.tagName === "path"
      )[0].getAttribute("d");
    const messages = pathOf();

    await act(() => click(buttonOf(container, "Konversationen")));
    assert.equal(columnsOf(container).length, 30);
    assert.notEqual(pathOf(), messages);
    await act(() => movePointer(document, columnsOf(container)[OCT_06]));
    assert.equal(
      tooltipOf(container).textContent,
      "Di., 06.10.2026 — 2 KonversationenVorzeitraum: So., 06.09.2026 — 2 Konversationen"
    );
    await act(() => movePointer(document, columnsOf(container)[OCT_07]));
    assert.equal(
      tooltipPreviousOf(container),
      "Vorzeitraum: Mo., 07.09.2026 — 0 Konversationen"
    );
    await act(() => movePointer(document, null));

    await act(() => click(buttonOf(container, "Nachrichten")));
    assert.equal(pathOf(), messages);

    await act(() => click(buttonOf(container, "Als Tabelle")));
    assert.equal(lineOf(container), null);
    await act(() => click(buttonOf(container, "Als Tabelle")));
    assert.equal(pathOf(), messages);
    assert.ok(legendOf(container));
  }
);

test(
  "Mit Vergleich unverändert: Klick und Eingabetaste auf einer Säule filtern die Liste, die Pfeiltasten wechseln den Platz – die Linie nimmt keine Eingaben an",
  { skip },
  async (t) => {
    const selected = [];
    const { container, document, act } = await mount(t, CHART, {
      summary: THIRTY_DAYS,
      loading: false,
      compare: true,
      onSelectBucket: (bucket) => selected.push(bucket),
    });
    const columns = columnsOf(container);

    await act(() => click(columns[OCT_06]));
    assert.deepEqual(selected, [
      { start: "2026-10-06", end: "2026-10-06", label: "Di., 06.10.2026" },
    ]);
    assert.equal(document.activeElement, columns[OCT_06]);

    await act(() => pressKey(document, "ArrowRight"));
    assert.equal(document.activeElement, columns[OCT_07]);
    await act(() => pressKey(document, "Enter"));
    assert.equal(selected.at(-1).start, "2026-10-07");
    assert.equal(selected.at(-1).label, "Mi., 07.10.2026");
    await act(() => pressKey(document, "End"));
    assert.equal(document.activeElement, columns[29]);

    // Ein Tab-Stopp für das Diagramm – die Linie ist keiner.
    const line = lineOf(container);
    assert.equal(line.getAttribute("pointer-events"), "none");
    assert.equal(line.getAttribute("aria-hidden"), "true");
    assert.deepEqual(
      elements(line, (element) => element.hasAttribute("tabindex")),
      []
    );
    assert.equal(
      columns.filter((column) => column.getAttribute("tabindex") === "0")
        .length,
      1
    );
    // Der angesteuerte Platz hebt seine Punktmarke hervor.
    const radii = withAttribute(container, "data-previous-marker").map(
      (marker) => marker.getAttribute("r")
    );
    assert.equal(radii.length, 30);
    assert.equal(radii.filter((radius) => radius === "4").length, 1);
    assert.equal(radii[29], "4");
  }
);

test(
  "Mit Vergleich unverändert: Der Klick-Filter der Ansicht lädt die Liste mit dem Abschnitt, die Zählwerte werden nicht neu angefragt – der Schalter bleibt an",
  { skip },
  async (t) => {
    const server = await analyticsServer(t);
    const { container, act, days } = await mountView(t);
    await act(() => click(switchOf(container)));
    const summaries = server.summaries().length;
    const day = addDays(days.fromDay, 23);

    await act(() => click(columnsOf(container)[23]));

    assert.equal(server.lists().at(-1).body.startedFromDay, day);
    assert.equal(server.lists().at(-1).body.startedToDay, day);
    assert.equal(columnsOf(container)[23].getAttribute("aria-pressed"), "true");
    assert.equal(server.summaries().length, summaries);
    assert.equal(isOn(container), true);
    assert.ok(lineOf(container));
    assert.equal(changesOf(container).length, 4);

    // Der Schalter hebt den Filter nicht auf.
    await act(() => click(switchOf(container)));
    assert.equal(columnsOf(container)[23].getAttribute("aria-pressed"), "true");
    assert.equal(server.lists().at(-1).body.startedFromDay, day);
  }
);
