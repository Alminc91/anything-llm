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
 * firstLedgerDay beginnt. Die Konversationsliste ist leer.
 */
async function analyticsServer(t, { firstLedgerDay } = {}) {
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
  "Tooltip (AK-5): nennt zusätzlich „Vorzeitraum: N“ – unter dem Mauszeiger und mit der Tastatur; ohne Vergleich bleibt er einzeilig",
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

    await act(() => movePointer(document, columns[OCT_07]));
    assert.equal(tooltipPreviousOf(container), "Vorzeitraum: 32");
    assert.equal(
      tooltipOf(container).textContent,
      "Mi., 07.10.2026 — 38 NachrichtenVorzeitraum: 32"
    );
    // Die zweite Zeile ist eine eigene Zeile, in deutscher Zahlenschreibweise.
    await act(() => movePointer(document, columns[OCT_06]));
    assert.equal(tooltipPreviousOf(container), "Vorzeitraum: 1.008");
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
      "Mo., 12.10.2026 — 43 NachrichtenVorzeitraum: 37"
    );
    await act(() => pressKey(document, "ArrowLeft"));
    assert.equal(document.activeElement, columns[28]);
    assert.equal(tooltipPreviousOf(container), "Vorzeitraum: 36");
    await act(() => pressKey(document, "Home"));
    assert.equal(
      tooltipOf(container).textContent,
      "So., 13.09.2026 — 14 NachrichtenVorzeitraum: 8"
    );
    // Dieselbe Angabe wie am Säulenplatz für Screenreader
    assert.match(
      columns[0].getAttribute("aria-label"),
      /^So\., 13\.09\.2026 — 14 Nachrichten\. Vorzeitraum: 8\. Die Eingabetaste /
    );
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
      "Di., 06.10.2026 — 2 KonversationenVorzeitraum: 2"
    );
    await act(() => movePointer(document, columnsOf(container)[OCT_07]));
    assert.equal(tooltipPreviousOf(container), "Vorzeitraum: 0");
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
