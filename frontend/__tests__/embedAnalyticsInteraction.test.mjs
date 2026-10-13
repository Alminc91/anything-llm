// KIE-536: Ansicht „Konversationen" – Maus, Tastatur und das Laden. Die
// Komponenten sind mit React DOM in ein Dokument ohne Browser eingehängt
// (helpers/renderSettingsPage.mjs, mount): Effekte laufen, Eingaben werden
// über die Handler der Elemente nachgestellt (helpers/testDom.mjs).
//
// Was ein Browser bei einer Eingabe auslöst (ein Klick fokussiert den
// Säulenplatz, Layout, Themes), bleibt Sache des Browser-Tests.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import {
  createRenderer,
  hasFrontendDeps,
} from "./helpers/renderSettingsPage.mjs";
import {
  click,
  elements,
  handlersOf,
  leaveWindow,
  movePointer,
  pressKey,
  returnToWindow,
  tap,
} from "./helpers/testDom.mjs";
import {
  DEFAULT_RANGE_DAYS,
  addDays,
  formatDate,
  lastDaysRange,
  rangeFromDates,
} from "../src/utils/analyticsTimeline.js";
// Adressen und Rümpfe der Anfragen – dieselben, mit denen der Server-Test die
// echten Routen aufruft (embedAnalyticsSummary.test.js).
import requests from "../../server/__tests__/endpoints/support/embedAnalyticsRequests.js";

const { ROUTES, summaryBody, conversationsBody } = requests;

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

const columnsOf = (container) =>
  elements(container, (element) => element.hasAttribute("data-column"));
/** Text des Tooltips; null, wenn keiner zu sehen ist. */
function tooltipOf(container) {
  const [tooltip, ...more] = elements(container, (element) =>
    (element.getAttribute("class") ?? "").includes("pointer-events-none")
  );
  assert.equal(more.length, 0, "mehr als ein Tooltip");
  return tooltip?.textContent ?? null;
}
/** Säulenplätze mit Fokusrahmen (Index). */
const ringsOf = (container) =>
  columnsOf(container)
    .map((column, i) => [column.firstChild.getAttribute("stroke"), i])
    .filter(([stroke]) => stroke !== "none")
    .map(([, i]) => i);

/** Säulenplätze mit Hervorhebung (Index). */
const highlightsOf = (container) =>
  columnsOf(container)
    .map((column, i) => [column.firstChild.getAttribute("fill-opacity"), i])
    .filter(([opacity]) => opacity !== "0")
    .map(([, i]) => i);

// 30 Tage ab 13.09.2026: der 06.10. ist Platz 23, der 07.10. Platz 24.
const FROM = "2026-09-13";
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
  buckets: Array.from({ length: 30 }, (_, i) => ({
    start: addDays(FROM, i),
    end: addDays(FROM, i),
    partial: false,
    messages: 14 + i,
    conversations: 2,
  })),
};
const OCT_06 = 23;
const OCT_07 = 24;

// ---------------------------------------------------------------------------
// Schmale Zeile ohne Konversation (Feinschliff nach KIE-539)
// ---------------------------------------------------------------------------

test(
  "Größe „Konversationen“ ohne begonnene Konversation: eine schmale Zeile mit dem Schalter, der weiterhilft – zurück zu „Nachrichten“ wieder die Säulen",
  { skip },
  async (t) => {
    const summary = {
      ...THIRTY_DAYS,
      totals: { ...THIRTY_DAYS.totals, conversations: 0 },
      buckets: THIRTY_DAYS.buckets.map((bucket) => ({
        ...bucket,
        conversations: 0,
      })),
    };
    const { container, act } = await mount(t, CHART, {
      summary,
      loading: false,
    });
    const section = () =>
      elements(container, (element) => element.tagName === "SECTION")[0];
    const labels = () =>
      elements(container, (element) => element.tagName === "BUTTON").map(
        (button) => button.textContent
      );
    assert.equal(section().getAttribute("data-chart-compact"), null);
    assert.equal(columnsOf(container).length, 30);

    await act(() => click(buttonOf(container, "Konversationen")));
    assert.equal(section().getAttribute("data-chart-compact"), "conversations");
    assert.match(section().getAttribute("class"), /\bpy-3\b/);
    assert.equal(
      elements(section(), (element) => element.tagName === "P")[0].textContent,
      "Konversationen pro Tag – Im gewählten Zeitraum wurde keine Konversation begonnen"
    );
    assert.equal(columnsOf(container).length, 0);
    assert.equal(
      elements(container, (element) => element.tagName === "svg").length,
      0
    );
    // Vergleich und Größe ändern die Lage, „Als Tabelle“ nicht.
    assert.deepEqual(labels(), [
      "Vorzeitraum vergleichen",
      "Nachrichten",
      "Konversationen",
    ]);

    await act(() => click(buttonOf(container, "Nachrichten")));
    assert.equal(section().getAttribute("data-chart-compact"), null);
    assert.equal(columnsOf(container).length, 30);
  }
);

// ---------------------------------------------------------------------------
// Tooltip (AK-6)
// ---------------------------------------------------------------------------

test(
  "Tooltip (AK-6): Der Mauszeiger über einer Säule zeigt Wochentag, Datum und Wert – ohne Zeiger kein Tooltip",
  { skip },
  async (t) => {
    const { container, document, act } = await mount(t, CHART, {
      summary: THIRTY_DAYS,
      loading: false,
    });
    const columns = columnsOf(container);
    assert.equal(columns.length, 30);
    assert.equal(tooltipOf(container), null);

    await act(() => movePointer(document, columns[OCT_06]));
    assert.equal(tooltipOf(container), "Di., 06.10.2026 — 37 Nachrichten");

    await act(() => movePointer(document, columns[OCT_07]));
    assert.equal(tooltipOf(container), "Mi., 07.10.2026 — 38 Nachrichten");

    await act(() => movePointer(document, null));
    assert.equal(tooltipOf(container), null);
  }
);

test(
  "Tooltip (AK-6): Nach einem Klick auf eine Säule folgt der Tooltip weiter dem Mauszeiger",
  { skip },
  async (t) => {
    const selected = [];
    const { container, document, act } = await mount(t, CHART, {
      summary: THIRTY_DAYS,
      loading: false,
      onSelectBucket: (bucket) => selected.push(bucket),
    });
    const columns = columnsOf(container);

    // Der Klick fokussiert den Säulenplatz – und filtert die Liste (AK-7).
    await act(() => click(columns[OCT_06]));
    assert.equal(document.activeElement, columns[OCT_06]);
    assert.deepEqual(selected, [
      { start: "2026-10-06", end: "2026-10-06", label: "Di., 06.10.2026" },
    ]);
    assert.equal(tooltipOf(container), "Di., 06.10.2026 — 37 Nachrichten");

    // Der Fokus bleibt auf dem 06.10., der Zeiger steht auf dem 07.10.
    await act(() => movePointer(document, columns[OCT_07]));
    assert.equal(document.activeElement, columns[OCT_06]);
    assert.equal(tooltipOf(container), "Mi., 07.10.2026 — 38 Nachrichten");

    await act(() => movePointer(document, columns[2]));
    assert.equal(tooltipOf(container), "Di., 15.09.2026 — 16 Nachrichten");
  }
);

test(
  "Tooltip (AK-6): Tastaturfokus zeigt den Tooltip, die Pfeiltasten nehmen ihn mit – auch wenn der Mauszeiger auf einer anderen Säule ruht",
  { skip },
  async (t) => {
    const { container, document, act } = await mount(t, CHART, {
      summary: THIRTY_DAYS,
      loading: false,
    });
    const columns = columnsOf(container);

    // Tab erreicht den einen Tab-Stopp des Diagramms: die letzte Säule.
    const tabStop = columns.filter(
      (column) => column.getAttribute("tabindex") === "0"
    );
    assert.deepEqual(tabStop, [columns[29]]);
    await act(() => columns[29].focus());
    assert.equal(tooltipOf(container), "Mo., 12.10.2026 — 43 Nachrichten");
    assert.deepEqual(ringsOf(container), [29]);

    await act(() => pressKey(document, "ArrowLeft"));
    assert.equal(document.activeElement, columns[28]);
    assert.equal(tooltipOf(container), "So., 11.10.2026 — 42 Nachrichten");
    assert.deepEqual(ringsOf(container), [28]);

    // Der Mauszeiger kommt dazu: Er gewinnt, der Fokusrahmen bleibt.
    await act(() => movePointer(document, columns[OCT_06]));
    assert.equal(tooltipOf(container), "Di., 06.10.2026 — 37 Nachrichten");
    assert.deepEqual(ringsOf(container), [28]);

    // Der Zeiger ruht, die Pfeiltaste wechselt die Säule: Der Tooltip folgt ihr.
    await act(() => pressKey(document, "ArrowLeft"));
    assert.equal(document.activeElement, columns[27]);
    assert.equal(tooltipOf(container), "Sa., 10.10.2026 — 41 Nachrichten");
    await act(() => pressKey(document, "Home"));
    assert.equal(tooltipOf(container), "So., 13.09.2026 — 14 Nachrichten");

    // Der Zeiger bewegt sich auf seiner Säule: wieder die Säule unter ihm.
    await act(() => movePointer(document, columns[OCT_06]));
    assert.equal(tooltipOf(container), "Di., 06.10.2026 — 37 Nachrichten");

    // Der Zeiger verlässt das Diagramm: zurück zur fokussierten Säule.
    await act(() => movePointer(document, null));
    assert.equal(tooltipOf(container), "So., 13.09.2026 — 14 Nachrichten");

    // Der Fokus verlässt das Diagramm: kein Tooltip, kein Rahmen.
    await act(() => columns[0].blur());
    assert.equal(tooltipOf(container), null);
    assert.deepEqual(ringsOf(container), []);
    // Der zuletzt fokussierte Platz bleibt der Tab-Stopp.
    assert.deepEqual(
      columnsOf(container)
        .map((column, i) => [column.getAttribute("tabindex"), i])
        .filter(([tabindex]) => tabindex === "0"),
      [["0", 0]]
    );
  }
);

test(
  "Tooltip: Tastatur allein – Tab, Pfeiltasten, Pos1/Ende, Eingabe- und Leertaste; Tooltip und Rahmen bleiben auf der fokussierten Säule",
  { skip },
  async (t) => {
    const selected = [];
    const { container, document, act } = await mount(t, CHART, {
      summary: THIRTY_DAYS,
      loading: false,
      onSelectBucket: (bucket) => selected.push(bucket),
    });
    const columns = columnsOf(container);

    await act(() => columns[29].focus());
    assert.equal(tooltipOf(container), "Mo., 12.10.2026 — 43 Nachrichten");
    assert.deepEqual(ringsOf(container), [29]);
    assert.deepEqual(highlightsOf(container), [29]);

    await act(() => pressKey(document, "Home"));
    assert.equal(document.activeElement, columns[0]);
    await act(() => pressKey(document, "ArrowRight"));
    assert.equal(tooltipOf(container), "Mo., 14.09.2026 — 15 Nachrichten");
    assert.deepEqual(ringsOf(container), [1]);

    await act(() => pressKey(document, "Enter"));
    assert.equal(selected.at(-1).start, "2026-09-14");
    assert.equal(tooltipOf(container), "Mo., 14.09.2026 — 15 Nachrichten");
    assert.deepEqual(ringsOf(container), [1]);

    await act(() => pressKey(document, "End"));
    await act(() => pressKey(document, " "));
    assert.equal(selected.at(-1).start, "2026-10-12");
    assert.equal(selected.length, 2);
    assert.equal(tooltipOf(container), "Mo., 12.10.2026 — 43 Nachrichten");
    assert.deepEqual(ringsOf(container), [29]);

    // Am Rand bleibt der Fokus stehen.
    await act(() => pressKey(document, "ArrowRight"));
    assert.equal(document.activeElement, columns[29]);
    assert.deepEqual(ringsOf(container), [29]);
  }
);

test(
  "Tooltip: Nach einem Mausklick verschwinden Tooltip und Hervorhebung, sobald der Zeiger das Diagramm verlässt – kein Fokusrahmen; der Abschnitts-Filter bleibt",
  { skip },
  async (t) => {
    const server = await analyticsServer(t);
    const { container, document, act, days } = await mountView(t, server);
    const day = addDays(days.fromDay, 23);

    await act(() => click(columnsOf(container)[23]));
    assert.equal(document.activeElement, columnsOf(container)[23]);
    assert.match(tooltipOf(container), / — 37 Nachrichten$/);
    assert.deepEqual(highlightsOf(container), [23]);
    // Der Klick fokussiert den Platz, ein Rahmen erscheint dabei nicht.
    assert.deepEqual(ringsOf(container), []);

    await act(() => movePointer(document, null));
    assert.equal(tooltipOf(container), null);
    assert.deepEqual(highlightsOf(container), []);
    assert.deepEqual(ringsOf(container), []);

    // Die Auswahl bleibt: Säule gedrückt, Liste gefiltert und markiert.
    assert.equal(columnsOf(container)[23].getAttribute("aria-pressed"), "true");
    assert.ok(bucketMarkOf(container).textContent.endsWith(formatDate(day)));
    assert.equal(server.lists().at(-1).body.startedFromDay, day);
    // Der Platz bleibt Tab-Stopp und aktives Element – die Tastatur setzt dort fort.
    assert.equal(document.activeElement, columnsOf(container)[23]);
    assert.equal(columnsOf(container)[23].getAttribute("tabindex"), "0");

    // Ein zweiter Klick hebt den Filter auf, wieder ohne Rahmen.
    await act(() => click(columnsOf(container)[23]));
    assert.equal(bucketMarkOf(container), null);
    assert.deepEqual(ringsOf(container), []);
    await act(() => movePointer(document, null));
    assert.equal(tooltipOf(container), null);
  }
);

test(
  "Tooltip: Ein Klick mit dem Stift zählt wie ein Mausklick – kein Fokusrahmen, und verlässt der Stift das Diagramm, verschwinden Tooltip und Hervorhebung",
  { skip },
  async (t) => {
    const selected = [];
    const { container, document, act } = await mount(t, CHART, {
      summary: THIRTY_DAYS,
      loading: false,
      onSelectBucket: (bucket) => selected.push(bucket),
    });
    const columns = columnsOf(container);

    // Der Stift schwebt über dem Platz und tippt ihn an.
    await act(() => movePointer(document, columns[OCT_06]));
    await act(() => click(columns[OCT_06], "pen"));
    assert.equal(selected.length, 1);
    assert.equal(document.activeElement, columns[OCT_06]);
    assert.equal(tooltipOf(container), "Di., 06.10.2026 — 37 Nachrichten");
    assert.deepEqual(highlightsOf(container), [OCT_06]);
    assert.deepEqual(ringsOf(container), []);

    await act(() => movePointer(document, null));
    assert.equal(tooltipOf(container), null);
    assert.deepEqual(highlightsOf(container), []);
    assert.deepEqual(ringsOf(container), []);

    // Die Tastatur setzt dort fort, mit Rahmen.
    await act(() => pressKey(document, "ArrowRight"));
    assert.equal(tooltipOf(container), "Mi., 07.10.2026 — 38 Nachrichten");
    assert.deepEqual(ringsOf(container), [OCT_07]);
  }
);

test(
  "Tooltip: Nach einem Mausklick übernimmt die Tastatur – Pfeiltasten und Eingabetaste zeigen Rahmen und Tooltip wieder",
  { skip },
  async (t) => {
    const selected = [];
    const { container, document, act } = await mount(t, CHART, {
      summary: THIRTY_DAYS,
      loading: false,
      onSelectBucket: (bucket) => selected.push(bucket),
    });
    const columns = columnsOf(container);

    await act(() => click(columns[OCT_06]));
    await act(() => movePointer(document, null));
    assert.equal(tooltipOf(container), null);

    await act(() => pressKey(document, "Enter"));
    assert.equal(selected.length, 2);
    assert.equal(tooltipOf(container), "Di., 06.10.2026 — 37 Nachrichten");
    assert.deepEqual(ringsOf(container), [OCT_06]);

    await act(() => pressKey(document, "ArrowRight"));
    assert.equal(document.activeElement, columns[OCT_07]);
    assert.equal(tooltipOf(container), "Mi., 07.10.2026 — 38 Nachrichten");
    assert.deepEqual(ringsOf(container), [OCT_07]);

    // Klick auf die letzte Säule, Zeiger weg, Pfeil nach rechts: Der Fokus
    // bleibt am Rand stehen und gilt jetzt als Tastaturfokus.
    await act(() => click(columns[29]));
    assert.deepEqual(ringsOf(container), []);
    await act(() => movePointer(document, null));
    assert.equal(tooltipOf(container), null);
    await act(() => pressKey(document, "ArrowRight"));
    assert.equal(tooltipOf(container), "Mo., 12.10.2026 — 43 Nachrichten");
    assert.deepEqual(ringsOf(container), [29]);

    // Tab aus dem Diagramm und zurück: Tastaturfokus mit Rahmen.
    await act(() => columns[29].blur());
    assert.equal(tooltipOf(container), null);
    await act(() => click(columns[OCT_06]));
    await act(() => movePointer(document, null));
    await act(() => columns[OCT_06].blur());
    await act(() => columns[OCT_06].focus());
    assert.equal(tooltipOf(container), "Di., 06.10.2026 — 37 Nachrichten");
    assert.deepEqual(ringsOf(container), [OCT_06]);
  }
);

test(
  "Tooltip: Fensterwechsel ist keine Eingabe – nach einem Mausklick bleibt das Diagramm bei der Rückkehr ohne Tooltip, ein Tastaturfokus behält ihn",
  { skip },
  async (t) => {
    const { container, document, act } = await mount(t, CHART, {
      summary: THIRTY_DAYS,
      loading: false,
    });
    const columns = columnsOf(container);

    await act(() => click(columns[OCT_06]));
    await act(() => movePointer(document, null));
    await act(() => leaveWindow(document));
    await act(() => returnToWindow(document));
    assert.equal(document.activeElement, columns[OCT_06]);
    assert.equal(tooltipOf(container), null);
    assert.deepEqual(ringsOf(container), []);

    await act(() => pressKey(document, "ArrowRight"));
    assert.equal(tooltipOf(container), "Mi., 07.10.2026 — 38 Nachrichten");
    await act(() => leaveWindow(document));
    await act(() => returnToWindow(document));
    assert.equal(tooltipOf(container), "Mi., 07.10.2026 — 38 Nachrichten");
    assert.deepEqual(ringsOf(container), [OCT_07]);

    // Danach verlässt der Fokus das Diagramm wie gewohnt.
    await act(() => columns[OCT_07].blur());
    assert.equal(tooltipOf(container), null);
    assert.deepEqual(ringsOf(container), []);
  }
);

test(
  "Tooltip: Als Fensterwechsel gilt ein blur nur, wenn das Dokument den Fokus verloren hat (document.hasFocus) – nennt das Ereignis den Platz noch als aktives Element, während das Fenster den Fokus behält, ist der Fokus fort",
  { skip },
  async (t) => {
    const { container, document, act } = await mount(t, CHART, {
      summary: THIRTY_DAYS,
      loading: false,
    });
    const columns = columnsOf(container);

    await act(() => columns[OCT_06].focus());
    assert.equal(tooltipOf(container), "Di., 06.10.2026 — 37 Nachrichten");
    assert.deepEqual(ringsOf(container), [OCT_06]);

    // Der Fokus geht an ein anderes Element der Seite. Das blur-Ereignis
    // kommt, bevor das Dokument sein aktives Element umstellt – das Fenster
    // behält den Fokus.
    assert.equal(document.hasFocus(), true);
    await act(() => {
      const place = columns[OCT_06];
      handlersOf(place).onBlur({ target: place, currentTarget: place });
      document.activeElement = document.body;
    });
    assert.equal(tooltipOf(container), null);
    assert.deepEqual(ringsOf(container), []);

    // Der nächste Fokus ist eine Eingabe, keine Rückkehr ins Fenster – auch
    // nach einem Mausklick, der selbst keinen Rahmen zeigt.
    await act(() => click(columns[OCT_07]));
    await act(() => movePointer(document, null));
    assert.equal(tooltipOf(container), null);
    await act(() => {
      const place = columns[OCT_07];
      handlersOf(place).onBlur({ target: place, currentTarget: place });
      document.activeElement = document.body;
    });
    await act(() => columns[OCT_07].focus());
    assert.equal(tooltipOf(container), "Mi., 07.10.2026 — 38 Nachrichten");
    assert.deepEqual(ringsOf(container), [OCT_07]);

    // Ohne document.hasFocus entscheidet das aktive Element allein.
    const { hasFocus } = document;
    delete document.hasFocus;
    t.after(() => {
      document.hasFocus = hasFocus;
      document.windowFocused = true;
    });
    await act(() => leaveWindow(document));
    await act(() => returnToWindow(document));
    assert.equal(tooltipOf(container), "Mi., 07.10.2026 — 38 Nachrichten");
    assert.deepEqual(ringsOf(container), [OCT_07]);
    await act(() => columns[OCT_07].blur());
    assert.equal(tooltipOf(container), null);
  }
);

test(
  "Tooltip: Tippen (Touch) zeigt den Tooltip der Säule, auch nachdem der Finger weg ist – ohne Mauszeiger trägt ihn der Fokus",
  { skip },
  async (t) => {
    const selected = [];
    const { container, document, act } = await mount(t, CHART, {
      summary: THIRTY_DAYS,
      loading: false,
      onSelectBucket: (bucket) => selected.push(bucket),
    });
    const columns = columnsOf(container);

    await act(() => tap(columns[OCT_06]));
    assert.equal(selected.length, 1);
    assert.equal(tooltipOf(container), "Di., 06.10.2026 — 37 Nachrichten");

    await act(() => tap(columns[OCT_07]));
    assert.equal(tooltipOf(container), "Mi., 07.10.2026 — 38 Nachrichten");

    await act(() => columns[OCT_07].blur());
    assert.equal(tooltipOf(container), null);
  }
);

test(
  "Tooltip: steht über der hohen Nachbarsäule statt auf ihr – ohne die Karte zu verschieben",
  { skip },
  async (t) => {
    // wie in der Abnahme: 84 Nachrichten am 06.10., eine am 07.10.
    const summary = {
      ...THIRTY_DAYS,
      buckets: THIRTY_DAYS.buckets.map((bucket, i) => ({
        ...bucket,
        messages: { 2: 3, [OCT_06]: 84, [OCT_07]: 1 }[i] ?? 0,
      })),
    };
    const { container, document, act } = await mount(t, CHART, {
      summary,
      loading: false,
    });
    const columns = columnsOf(container);
    const tooltipTop = async (i) => {
      await act(() => movePointer(document, columns[i]));
      const [tooltip] = elements(container, (element) =>
        (element.getAttribute("class") ?? "").includes("pointer-events-none")
      );
      // außerhalb des Textflusses: Die Karte ändert ihre Größe nicht.
      assert.match(tooltip.getAttribute("class"), /(^| )absolute( |$)/);
      return parseFloat(tooltip.style.top);
    };

    const tall = await tooltipTop(OCT_06);
    assert.equal(tooltipOf(container), "Di., 06.10.2026 — 84 Nachrichten");
    assert.equal(await tooltipTop(OCT_07), tall);
    assert.equal(tooltipOf(container), "Mi., 07.10.2026 — 1 Nachricht");
    // Platz ohne Säule rechts daneben: dieselbe Höhe
    assert.equal(await tooltipTop(OCT_07 + 1), tall);
    // weit weg von der hohen Säule: direkt über der eigenen, also viel tiefer
    assert.ok((await tooltipTop(2)) > tall + 100);
    assert.equal(tooltipOf(container), "Di., 15.09.2026 — 3 Nachrichten");
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
  "Tooltip im schmalen Diagramm (340 px, 240 px): ragt an keinem Platz hinaus – am Diagramm verankert, höchstens bis zum anderen Rand breit, ein längerer Text bricht um und wächst nach oben",
  { skip },
  async (t) => {
    // 13 Kalenderwochen ab 13.07.2026, die letzte angeschnitten
    const start = "2026-07-13";
    const summary = {
      ...THIRTY_DAYS,
      granularity: "week",
      fromDay: start,
      toDay: addDays(start, 12 * 7 + 1),
      buckets: Array.from({ length: 13 }, (_, i) => ({
        start: addDays(start, i * 7),
        end: addDays(start, i === 12 ? i * 7 + 1 : i * 7 + 6),
        partial: i === 12,
        messages: 1234 + i,
        conversations: 2,
      })),
    };
    const setWidth = chartWidth(t);
    const { container, document, act } = await mount(t, CHART, {
      summary,
      loading: false,
    });
    const columns = columnsOf(container);
    const tooltipAt = async (i) => {
      await act(() => movePointer(document, columns[i]));
      const [tooltip] = elements(container, (element) =>
        (element.getAttribute("class") ?? "").includes("pointer-events-none")
      );
      return tooltip;
    };
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

    for (const width of [340, 240]) {
      await act(() => setWidth(width));
      // das Diagramm, nicht das Symbol am Schalter „Als Tabelle“
      const [chart] = elements(
        container,
        (element) => element.getAttribute("role") === "group"
      ).filter((element) => element.tagName === "svg");
      assert.equal(chart.getAttribute("width"), String(width));
      for (let i = 0; i < columns.length; i++) {
        const tooltip = await tooltipAt(i);
        const where = `${width} px, Platz ${i}`;
        const classes = tooltip.getAttribute("class").split(" ");
        // so breit wie der Text, aber umbrechbar – und außerhalb des Textflusses
        assert.ok(classes.includes("w-max"), where);
        assert.ok(classes.includes("absolute"), where);
        assert.ok(!classes.includes("whitespace-nowrap"), where);
        const box = boxOf(tooltip, width);
        assert.ok(box.left >= 0 && box.right <= width, where);
        // Die Unterkante steht fest: Mehr Zeilen wachsen nach oben.
        assert.match(tooltip.style.transform, /-100%\)$/, where);
      }
    }

    // 340 px: „KW 29 (13.07.–19.07.2026) — 1.234 Nachrichten" ist geschätzt
    // 314,5 px breit.
    await act(() => setWidth(340));
    const first = await tooltipAt(0);
    assert.equal(
      first.textContent,
      "KW 29 (13.07.–19.07.2026) — 1.234 Nachrichten"
    );
    // links verankert bei 39 px ragte er rechts hinaus (353,5 px): 25,5 px
    assert.equal(first.style.left, "25.5px");
    assert.equal(first.style.maxWidth, "314.5px");
    // mittig (188 px) ragte er rechts hinaus: am rechten Rand
    const middle = await tooltipAt(6);
    assert.equal(middle.style.right, "0");
    assert.equal(middle.style.maxWidth, "340px");
    assert.equal(middle.style.transform, "translateY(-100%)");

    // 240 px: breiter als das Diagramm – über die ganze Breite, mit Umbruch.
    await act(() => setWidth(240));
    const narrow = await tooltipAt(0);
    assert.equal(narrow.style.left, "0");
    assert.equal(narrow.style.maxWidth, "240px");

    // Breit bleibt er, wie er war: mittig über dem Platz, viel Luft.
    await act(() => setWidth(1130));
    const wide = await tooltipAt(6);
    assert.equal(wide.style.left, `${44 + 6.5 * (1078 / 13)}px`);
    assert.equal(wide.style.transform, "translate(-50%, -100%)");
    assert.ok(parseFloat(wide.style.maxWidth) > 600);
  }
);

// ---------------------------------------------------------------------------
// Anfragen an den Server (Hard Constraint 5, AK-7)
// ---------------------------------------------------------------------------

const EMBED = {
  id: 3,
  chat_retention_days: 30,
  workspace: { name: "VHS Musterstadt" },
};
const TOTALS = {
  messages: 885,
  conversations: 60,
  feedbackPositive: 9,
  feedbackNegative: 3,
};

/** Adresse einer Route für das Widget, wie das Frontend sie aufruft. */
async function urlOf(route, embedId = EMBED.id) {
  const { API_BASE } = await renderer.load("/src/utils/constants.js");
  return `${API_BASE}${route.path.replace(":embedId", embedId)}`;
}

/**
 * Ersetzt fetch für die Dauer eines Tests: merkt sich jede Anfrage (Methode,
 * Adresse, Rumpf) und antwortet mit dem, was respond liefert.
 */
function stubFetch(t, respond) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const call = {
      method: init.method,
      url,
      body: init.body === undefined ? undefined : JSON.parse(init.body),
    };
    calls.push(call);
    return { ok: true, status: 200, json: async () => respond(call) };
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return calls;
}

/**
 * Der Server der Ansicht: analytics/summary antwortet mit den übergebenen
 * Abschnitten (sonst je Tag des angefragten Zeitraums einer), die
 * Konversationsliste ist leer – oder antwortet mit dem, was list liefert.
 * Beide Routen antworten für jedes Widget.
 */
async function analyticsServer(t, { granularity = "day", buckets, list } = {}) {
  const summaryUrl = await urlOf(ROUTES.summary);
  const listUrl = await urlOf(ROUTES.conversations);
  const isSummary = (url) => url.endsWith("/analytics/summary");
  const isList = (url) => url.endsWith("/analytics/conversations");
  const calls = stubFetch(t, (call) => {
    const { url, body } = call;
    if (isList(url))
      return (
        list?.(call) ?? {
          success: true,
          conversations: [],
          hasMore: false,
          totalCount: 0,
        }
      );
    // Gesprächsverlauf (Seitenpanel): geladen, ohne Nachrichten – das Panel
    // zeigt dann die Angaben der Zeile.
    if (call.method === "GET" && /\/conversation\/\d+$/.test(url))
      return { success: true, messages: [] };
    if (!isSummary(url)) return { success: false, error: "unbekannt" };
    const days = [];
    for (let day = body.fromDay; day <= body.toDay; day = addDays(day, 1))
      days.push(day);
    return {
      success: true,
      granularity,
      fromDay: body.fromDay,
      toDay: body.toDay,
      firstLedgerDay: "2026-01-01",
      totals: TOTALS,
      buckets:
        buckets ??
        days.map((day, i) => ({
          start: day,
          end: day,
          partial: false,
          messages: 14 + i,
          conversations: 2,
        })),
    };
  });
  return {
    calls,
    summaries: () => calls.filter((call) => isSummary(call.url)),
    lists: () => calls.filter((call) => isList(call.url)),
    summaryUrl,
    listUrl,
  };
}

/**
 * Die Ansicht im Standard-Zeitraum (letzte 30 Tage) – mit einem Widget, wenn
 * embeds nichts anderes nennt.
 */
async function mountView(t, server, embeds = [EMBED]) {
  const { startDate, endDate } = lastDaysRange(DEFAULT_RANGE_DAYS);
  const mounted = await mount(
    t,
    VIEW,
    { embedsLoaded: true, embeds },
    { exportName: "AnalyticsScreen" }
  );
  return {
    ...mounted,
    days: rangeFromDates(startDate, endDate),
    // Die Liste bekommt denselben Zeitraum als Zeitstempel des Browsers.
    period: {
      startDate: startDate.toISOString(),
      endDate: endDate.toISOString(),
    },
    listRequest: (request = {}) => ({
      method: ROUTES.conversations.method,
      url: server.listUrl,
      body: conversationsBody({
        startDate: startDate.toISOString(),
        endDate: endDate.toISOString(),
        ...request,
      }),
    }),
  };
}

/** Markierung „Nur <Abschnitt>" der Liste; null, wenn kein Abschnitt gewählt ist. */
function bucketMarkOf(container) {
  const [mark] = elements(container, (element) =>
    element.hasAttribute("data-bucket-filter")
  );
  return mark ?? null;
}
const kpiTextOf = (container) =>
  elements(container, (element) => element.hasAttribute("data-kpi")).map(
    (element) => element.textContent
  );

test(
  "Anfrage (Hard Constraint 5): getAnalyticsSummary sendet die gewählten Kalendertage als { fromDay, toDay } an analytics/summary",
  { skip },
  async (t) => {
    const calls = stubFetch(t, () => ({ success: true }));
    const { default: Embed } = await renderer.load("/src/models/embed.js");

    const answer = await Embed.getAnalyticsSummary(
      3,
      "2026-09-13",
      "2026-10-12"
    );

    assert.deepEqual(answer, { success: true });
    assert.deepEqual(calls, [
      {
        method: ROUTES.summary.method,
        url: await urlOf(ROUTES.summary, 3),
        body: summaryBody("2026-09-13", "2026-10-12"),
      },
    ]);
    assert.deepEqual(Object.keys(calls[0].body), ["fromDay", "toDay"]);
    assert.match(calls[0].url, /\/embed\/3\/analytics\/summary$/);
  }
);

test(
  "Anfrage (AK-7): getConversations sendet den Abschnitt als startedFromDay/startedToDay – ohne Abschnitt keines der beiden Felder",
  { skip },
  async (t) => {
    const calls = stubFetch(t, () => ({ success: true, conversations: [] }));
    const { default: Embed } = await renderer.load("/src/models/embed.js");
    const period = {
      startDate: "2026-09-12T22:00:00.000Z",
      endDate: "2026-10-12T21:59:59.999Z",
    };

    await Embed.getConversations(
      3,
      20,
      20,
      period.startDate,
      period.endDate,
      "negative",
      { fromDay: "2026-10-05", toDay: "2026-10-11" }
    );
    await Embed.getConversations(
      3,
      0,
      20,
      period.startDate,
      period.endDate,
      "all",
      null
    );
    await Embed.getConversations(3, 0, 20, null, null);

    const url = await urlOf(ROUTES.conversations, 3);
    assert.deepEqual(calls, [
      {
        method: ROUTES.conversations.method,
        url,
        body: conversationsBody({
          ...period,
          offset: 20,
          feedbackFilter: "negative",
          bucket: { start: "2026-10-05", end: "2026-10-11" },
        }),
      },
      {
        method: ROUTES.conversations.method,
        url,
        body: conversationsBody(period),
      },
      { method: ROUTES.conversations.method, url, body: conversationsBody() },
    ]);
    assert.equal(calls[0].body.startedFromDay, "2026-10-05");
    assert.equal(calls[0].body.startedToDay, "2026-10-11");
    for (const { body } of calls.slice(1)) {
      assert.ok(!("startedFromDay" in body));
      assert.ok(!("startedToDay" in body));
    }
    assert.match(url, /\/embed\/3\/analytics\/conversations$/);
  }
);

test(
  "Laden (Hard Constraint 5): Die Ansicht fragt Zählwerte mit den Kalendertagen des Zeitraums ab, die Liste mit den Zeitstempeln des Browsers",
  { skip },
  async (t) => {
    const server = await analyticsServer(t);
    const { container, days, listRequest } = await mountView(t, server);

    assert.equal(addDays(days.fromDay, DEFAULT_RANGE_DAYS - 1), days.toDay);
    assert.deepEqual(server.summaries(), [
      {
        method: ROUTES.summary.method,
        url: server.summaryUrl,
        body: summaryBody(days.fromDay, days.toDay),
      },
    ]);
    assert.deepEqual(server.lists(), [listRequest()]);
    assert.equal(server.calls.length, 2);
    // Die Antwort ist gezeichnet: 30 Säulenplätze, Kennzahlen aus totals.
    assert.equal(columnsOf(container).length, 30);
    assert.match(kpiTextOf(container)[0], /^Nachrichten885/);
    assert.equal(bucketMarkOf(container), null);
  }
);

test(
  "Klick auf eine Säule (AK-7, AK-17): Die Liste wird mit dem Abschnitt neu geladen und markiert, die Seite springt weich zu ihr (Fixliste 2, B3); zweiter Klick oder Schließen hebt den Filter auf, ohne zu springen; die Kennzahlen bleiben",
  { skip },
  async (t) => {
    const server = await analyticsServer(t);
    const { container, act, days, listRequest } = await mountView(t, server);
    const day = addDays(days.fromDay, 23);
    const bucket = { start: day, end: day };
    const kpis = kpiTextOf(container);
    assert.equal(kpis.length, 4);
    // wie „N negativ“ und der Verweis in der Kopfzeile: zum Bereich der Liste
    const [listArea] = elements(container, (element) =>
      (element.getAttribute("class") ?? "").split(" ").includes("scroll-mt-4")
    );
    const scrolls = [];
    listArea.scrollIntoView = (options) => scrolls.push(options);

    await act(() => click(columnsOf(container)[23]));
    assert.deepEqual(scrolls, [{ behavior: "smooth", block: "start" }]);
    assert.deepEqual(server.lists(), [listRequest(), listRequest({ bucket })]);
    assert.equal(server.lists().at(-1).body.startedFromDay, day);
    assert.equal(server.lists().at(-1).body.startedToDay, day);
    const mark = bucketMarkOf(container);
    assert.match(mark.textContent, /^Nur \S+, /);
    assert.ok(mark.textContent.endsWith(formatDate(day)), mark.textContent);
    assert.equal(columnsOf(container)[23].getAttribute("aria-pressed"), "true");

    // zweiter Klick auf dieselbe Säule: Filter weg, kein Sprung
    await act(() => click(columnsOf(container)[23]));
    assert.deepEqual(server.lists().at(-1), listRequest());
    assert.equal(server.lists().length, 3);
    assert.equal(bucketMarkOf(container), null);
    assert.equal(scrolls.length, 1);

    // andere Säule, dann die Schließen-Schaltfläche der Markierung
    const other = addDays(days.fromDay, 5);
    await act(() => click(columnsOf(container)[5]));
    assert.deepEqual(
      server.lists().at(-1),
      listRequest({ bucket: { start: other, end: other } })
    );
    const [close] = elements(bucketMarkOf(container), (element) =>
      (element.getAttribute("aria-label") ?? "").startsWith("Filter „")
    );
    assert.equal(scrolls.length, 2);
    await act(() => click(close));
    assert.deepEqual(server.lists().at(-1), listRequest());
    assert.equal(server.lists().length, 5);
    assert.equal(bucketMarkOf(container), null);
    assert.equal(scrolls.length, 2);

    // Die Kennzahlen wurden nicht neu abgefragt und stehen unverändert da.
    assert.equal(server.summaries().length, 1);
    assert.deepEqual(kpiTextOf(container), kpis);
  }
);

test(
  "Klick auf eine Säule (AK-7): Kalenderwoche, angeschnittene Woche und Monat gehen mit ihrem ersten und letzten Tag an die Liste",
  { skip },
  async (t) => {
    const week = (start, end, partial) => ({
      start,
      end,
      partial,
      messages: 10,
      conversations: 3,
    });
    const weeks = await analyticsServer(t, {
      granularity: "week",
      buckets: [
        week("2026-09-28", "2026-10-04", false),
        week("2026-10-05", "2026-10-11", false),
        week("2026-10-12", "2026-10-12", true),
      ],
    });
    const view = await mountView(t, weeks);
    assert.equal(columnsOf(view.container).length, 3);

    await view.act(() => click(columnsOf(view.container)[1]));
    assert.deepEqual(
      weeks.lists().at(-1),
      view.listRequest({ bucket: { start: "2026-10-05", end: "2026-10-11" } })
    );
    assert.equal(
      bucketMarkOf(view.container).textContent,
      "Nur KW 41 (05.10.–11.10.2026)"
    );

    await view.act(() => click(columnsOf(view.container)[2]));
    assert.deepEqual(
      weeks.lists().at(-1),
      view.listRequest({ bucket: { start: "2026-10-12", end: "2026-10-12" } })
    );
    assert.equal(
      bucketMarkOf(view.container).textContent,
      "Nur KW 42 – bis 12.10."
    );
    await view.unmount();

    const months = await analyticsServer(t, {
      granularity: "month",
      buckets: [
        week("2026-09-01", "2026-09-30", false),
        week("2026-10-01", "2026-10-12", true),
      ],
    });
    const monthly = await mountView(t, months);
    await monthly.act(() => click(columnsOf(monthly.container)[0]));
    assert.deepEqual(
      months.lists().at(-1),
      monthly.listRequest({
        bucket: { start: "2026-09-01", end: "2026-09-30" },
      })
    );
    assert.equal(
      bucketMarkOf(monthly.container).textContent,
      "Nur September 2026"
    );
  }
);

test(
  "Klick auf eine Säule (AK-9): Im Stundendiagramm filtert er die Liste nicht",
  { skip },
  async (t) => {
    const server = await analyticsServer(t, {
      granularity: "hour",
      buckets: Array.from({ length: 24 }, (_, hour) => ({
        start: "2026-10-06",
        end: "2026-10-06",
        partial: false,
        hour,
        messages: hour,
        conversations: 1,
      })),
    });
    const { container, act } = await mountView(t, server);
    assert.equal(columnsOf(container).length, 24);

    await act(() => click(columnsOf(container)[13]));
    assert.equal(
      tooltipOf(container),
      "Di., 06.10.2026, 13–14 Uhr — 13 Nachrichten"
    );
    assert.equal(server.lists().length, 1);
    assert.equal(bucketMarkOf(container), null);
    assert.equal(server.summaries().length, 1);
  }
);

// ---------------------------------------------------------------------------
// Blättern (NAK-5): Jeder Wechsel des Zuschnitts führt auf Seite 1 – seit
// der Konversationen-Ansicht: Nachgeladenes verfällt, die Liste beginnt vorn
// ---------------------------------------------------------------------------

const SECOND_EMBED = {
  id: 7,
  chat_retention_days: null,
  workspace: { name: "VHS Beispielstadt" },
};
const PAGE_SIZE = 20;

/** Die Liste hat 45 einsehbare Konversationen – drei Seiten. */
function pagedList({ body }) {
  const total = 45;
  const count = Math.max(0, Math.min(body.limit, total - body.offset));
  return {
    success: true,
    totalCount: total,
    hasMore: body.offset + count < total,
    conversations: Array.from({ length: count }, (_, i) => ({
      conversation_id: `konversation-${body.offset + i + 1}`,
      // Schlüssel der Karte (KIE-538): die id der ersten Zeile
      first_chat_id: 1000 + body.offset + i,
      conversation_number: body.offset + i + 1,
      preview: "Gibt es Sportkurse?",
      started_at: Date.UTC(2026, 9, 6, 10),
      last_message_at: Date.UTC(2026, 9, 6, 11),
      message_count: 2,
      positive_count: 0,
      negative_count: 0,
    })),
  };
}

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

/**
 * Bewertungsfilter der Liste, benannt wie für Screenreader und im Tooltip.
 * Sein Text steht doppelt im Dokument (kurz für schmale Fenster, sonst
 * ausgeschrieben) – welcher zu sehen ist, entscheidet das CSS.
 */
function feedbackFilterOf(container, name) {
  const [button, ...more] = elements(
    container,
    (element) =>
      element.tagName === "BUTTON" &&
      element.getAttribute("aria-label") === name
  );
  assert.ok(button, `kein Bewertungsfilter „${name}“`);
  assert.equal(more.length, 0, `mehrere Bewertungsfilter „${name}“`);
  return button;
}
const ONLY_POSITIVE =
  "Nur Konversationen mit positiv bewerteter Antwort anzeigen";
const ONLY_NEGATIVE =
  "Nur Konversationen mit negativ bewerteter Antwort anzeigen";

/**
 * Lädt weitere Konversationen nach („Weitere Konversationen laden") und
 * prüft, dass die Liste die zweite Seite anfragt.
 */
async function openSecondPage({ container, act }, server) {
  const [more] = elements(container, (element) =>
    element.hasAttribute("data-load-more")
  );
  assert.ok(more, "keine Schaltfläche „Weitere Konversationen laden“");
  assert.equal(more.textContent, "Weitere Konversationen laden");
  await act(() => click(more));
  assert.equal(server.lists().at(-1).body.offset, PAGE_SIZE);
}

/** Die Zeilen der Liste: id ihrer ersten Zeile (first_chat_id). */
const rowIdsOf = (container) =>
  elements(container, (element) =>
    element.hasAttribute("data-conversation-row")
  ).map((element) => Number(element.getAttribute("data-conversation-row")));

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
      element.textContent === embed.workspace.name
  );
  await act(() => click(option));
}

test(
  "Blättern (NAK-5): Bewertungsfilter an und wieder aus führt auf Seite 1 – die frühere Seite 2 kommt nicht zurück",
  { skip },
  async (t) => {
    const server = await analyticsServer(t, { list: pagedList });
    const view = await mountView(t, server);
    const { container, act, listRequest } = view;

    for (const [label, feedbackFilter] of [
      [ONLY_POSITIVE, "positive"],
      [ONLY_NEGATIVE, "negative"],
    ]) {
      await openSecondPage(view, server);
      const before = server.lists().length;

      await act(() => click(feedbackFilterOf(container, label)));
      assert.deepEqual(server.lists().at(-1), listRequest({ feedbackFilter }));

      await act(() => click(feedbackFilterOf(container, label)));
      assert.deepEqual(server.lists().at(-1), listRequest());
      assert.equal(server.lists().at(-1).body.offset, 0);
      // je Wechsel genau eine Anfrage
      assert.equal(server.lists().length, before + 2);
      // Die Liste zeigt die Einträge 1–20.
      // Die Liste zeigt wieder die ersten 20 – nicht die nachgeladenen.
      assert.deepEqual(
        rowIdsOf(container),
        Array.from({ length: PAGE_SIZE }, (_, i) => 1000 + i)
      );
    }
  }
);

test(
  "Bewertungsfilter: ein Daumen und Text je Schaltfläche, kein Emoji – der Klick setzt aria-pressed und fragt die Liste mit feedbackFilter an",
  { skip },
  async (t) => {
    const server = await analyticsServer(t);
    const view = await mountView(t, server);
    const { container, act, listRequest } = view;
    const positive = () => feedbackFilterOf(container, ONLY_POSITIVE);
    const negative = () => feedbackFilterOf(container, ONLY_NEGATIVE);
    const pressed = () =>
      [positive(), negative()].map((button) =>
        button.getAttribute("aria-pressed")
      );
    /** Der Daumen einer Schaltfläche: sein Pfad (Umriss oder gefüllt). */
    const thumbOf = (button) => {
      const icons = elements(button, (element) => element.tagName === "svg");
      assert.equal(icons.length, 1, "genau ein Symbol je Schaltfläche");
      assert.equal(icons[0].getAttribute("fill"), "currentColor");
      const [path] = elements(
        icons[0],
        (element) => element.tagName === "path"
      );
      return path.getAttribute("d");
    };
    const outline = {
      positive: thumbOf(positive()),
      negative: thumbOf(negative()),
    };
    assert.notEqual(outline.positive, outline.negative);

    // Bildzeichen wie 👍 und 👎 – in keiner der beiden Schaltflächen.
    const emoji =
      /\p{Extended_Pictographic}|[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u;
    assert.match("Nur mit 👍", emoji);
    for (const [button, short, long] of [
      [positive(), "Positiv", "Positiv bewertet"],
      [negative(), "Negativ", "Negativ bewertet"],
    ]) {
      assert.deepEqual(
        elements(button, (element) => element.tagName === "SPAN").map(
          (span) => [span.getAttribute("class"), span.textContent]
        ),
        [
          ["sm:hidden", short],
          ["hidden sm:inline", long],
        ]
      );
      assert.doesNotMatch(button.textContent, emoji);
      assert.equal(
        button.getAttribute("title"),
        button.getAttribute("aria-label")
      );
    }
    assert.deepEqual(pressed(), ["false", "false"]);
    assert.deepEqual(server.lists().at(-1), listRequest());

    // an: aria-pressed und der gefüllte Daumen – nicht nur die Farbe
    let before = server.lists().length;
    await act(() => click(positive()));
    assert.deepEqual(pressed(), ["true", "false"]);
    assert.notEqual(thumbOf(positive()), outline.positive);
    assert.equal(thumbOf(negative()), outline.negative);
    assert.deepEqual(
      server.lists().at(-1),
      listRequest({ feedbackFilter: "positive" })
    );
    assert.equal(server.lists().length, before + 1);

    // Die beiden Filter schließen sich aus.
    before = server.lists().length;
    await act(() => click(negative()));
    assert.deepEqual(pressed(), ["false", "true"]);
    assert.equal(thumbOf(positive()), outline.positive);
    assert.notEqual(thumbOf(negative()), outline.negative);
    assert.deepEqual(
      server.lists().at(-1),
      listRequest({ feedbackFilter: "negative" })
    );
    assert.equal(server.lists().length, before + 1);

    // Der zweite Klick hebt den Filter auf.
    await act(() => click(negative()));
    assert.deepEqual(pressed(), ["false", "false"]);
    assert.equal(thumbOf(negative()), outline.negative);
    assert.deepEqual(server.lists().at(-1), listRequest());
  }
);

test(
  "Feld „Bewertungen“: „3 negativ“ setzt den Listenfilter „Negativ bewertet“ und springt zur Liste",
  { skip },
  async (t) => {
    const server = await analyticsServer(t);
    const view = await mountView(t, server);
    const { container, act, listRequest } = view;
    const [ratings] = elements(
      container,
      (element) => element.getAttribute("data-kpi") === "ratings"
    );
    assert.equal(
      ratings.textContent,
      // 12 von 885 Antworten bewertet: 1,36 % → 1 %
      "Bewertungen121 % der Antworten bewertet · 9 positiv, 3 negativ"
    );
    const [satisfaction] = elements(
      container,
      (element) => element.getAttribute("data-kpi") === "satisfaction"
    );
    assert.equal(
      satisfaction.textContent,
      "Zufriedenheit75 %9 von 12 Bewertungen positiv"
    );

    // Der Bereich der Liste merkt sich, dass zu ihm gesprungen wird.
    const [listArea] = elements(container, (element) =>
      (element.getAttribute("class") ?? "").split(" ").includes("scroll-mt-4")
    );
    const scrolls = [];
    listArea.scrollIntoView = (options) => scrolls.push(options);

    const link = buttonOf(ratings, "3 negativ");
    assert.equal(
      link.getAttribute("aria-label"),
      "3 negativ – Betroffene Konversationen anzeigen"
    );
    await act(() => click(link));
    assert.deepEqual(
      server.lists().at(-1),
      listRequest({ feedbackFilter: "negative" })
    );
    assert.equal(
      feedbackFilterOf(container, ONLY_NEGATIVE).getAttribute("aria-pressed"),
      "true"
    );
    assert.deepEqual(scrolls, [{ behavior: "smooth", block: "start" }]);
    // Die Liste zeigt sofort, welcher Filter gilt.
    const [mark] = elements(container, (element) =>
      element.hasAttribute("data-feedback-filter-mark")
    );
    assert.equal(mark.textContent, "Filter: Negativ bewertet");
  }
);

test(
  "Feld „Bewertungen“: „9 positiv“ setzt den Listenfilter „Positiv bewertet“ und springt zur Liste – die Markierung „Filter: Positiv bewertet“ erscheint",
  { skip },
  async (t) => {
    const server = await analyticsServer(t);
    const view = await mountView(t, server);
    const { container, act, listRequest } = view;
    const [ratings] = elements(
      container,
      (element) => element.getAttribute("data-kpi") === "ratings"
    );
    const [listArea] = elements(container, (element) =>
      (element.getAttribute("class") ?? "").split(" ").includes("scroll-mt-4")
    );
    const scrolls = [];
    listArea.scrollIntoView = (options) => scrolls.push(options);

    const link = buttonOf(ratings, "9 positiv");
    assert.equal(
      link.getAttribute("aria-label"),
      "9 positiv – Betroffene Konversationen anzeigen"
    );
    assert.equal(
      link.getAttribute("class"),
      buttonOf(ratings, "3 negativ").getAttribute("class")
    );
    await act(() => click(link));
    assert.deepEqual(
      server.lists().at(-1),
      listRequest({ feedbackFilter: "positive" })
    );
    assert.equal(
      feedbackFilterOf(container, ONLY_POSITIVE).getAttribute("aria-pressed"),
      "true"
    );
    assert.deepEqual(scrolls, [{ behavior: "smooth", block: "start" }]);
    const [mark] = elements(container, (element) =>
      element.hasAttribute("data-feedback-filter-mark")
    );
    assert.equal(mark.textContent, "Filter: Positiv bewertet");
  }
);

test(
  "Sprung zur Liste: In der Kopfzeile „45 Konversationen ansehen ↓“ – der Klick scrollt weich zur Liste und setzt den Fokus auf ihre Überschrift",
  { skip },
  async (t) => {
    const server = await analyticsServer(t, { list: pagedList });
    const { container, document, act } = await mountView(t, server);
    const jumpOf = () =>
      elements(container, (element) =>
        element.hasAttribute("data-jump-to-list")
      )[0] ?? null;

    const jump = jumpOf();
    assert.ok(jump, "kein Verweis zur Liste");
    assert.equal(jump.tagName, "BUTTON");
    assert.equal(jump.textContent, "45 Konversationen ansehen ↓");
    // bei der Überschrift „Konversationen“ der Ansicht, nicht beim Zeitraum
    assert.equal(jump.parentNode.firstChild.tagName, "H2");
    assert.equal(jump.parentNode.firstChild.textContent, "Konversationen");

    const [listArea] = elements(container, (element) =>
      (element.getAttribute("class") ?? "").split(" ").includes("scroll-mt-4")
    );
    const scrolls = [];
    listArea.scrollIntoView = (options) => scrolls.push(options);
    const [heading] = elements(container, (element) =>
      element.hasAttribute("data-list-heading")
    );
    assert.equal(heading.getAttribute("tabindex"), "-1");
    assert.notEqual(document.activeElement, heading);

    const before = server.lists().length;
    await act(() => click(jump));
    assert.deepEqual(scrolls, [{ behavior: "smooth", block: "start" }]);
    assert.equal(document.activeElement, heading);
    // Der Sprung lädt nichts neu.
    assert.equal(server.lists().length, before);
  }
);

test(
  "Sprung zur Liste: Die Zahl folgt der Liste – „1 Konversation ansehen ↓“; ohne einsehbare Konversation entfällt der Verweis",
  { skip },
  async (t) => {
    const listOf =
      (totalCount) =>
      ({ body }) => ({
        ...pagedList({ body }),
        totalCount,
        hasMore: false,
        conversations: pagedList({ body }).conversations.slice(0, totalCount),
      });
    const jumpText = async (totalCount) => {
      const server = await analyticsServer(t, { list: listOf(totalCount) });
      const view = await mountView(t, server);
      const [jump] = elements(view.container, (element) =>
        element.hasAttribute("data-jump-to-list")
      );
      await view.unmount();
      return jump?.textContent ?? null;
    };
    assert.equal(await jumpText(1), "1 Konversation ansehen ↓");
    assert.equal(await jumpText(1234), "1.234 Konversationen ansehen ↓");
    assert.equal(await jumpText(0), null);
  }
);

// ---------------------------------------------------------------------------
// Gesetzte Filter sichtbar: Verweis, „N von M einsehbar", Markierung
// ---------------------------------------------------------------------------

/**
 * Liste, deren Zahl vom Filter abhängt: im Zeitraum 214 einsehbare
 * Konversationen, davon 18 negativ und 25 positiv bewertet (zwei Seiten);
 * im gewählten
 * Abschnitt 6, davon 2 negativ und 3 positiv.
 */
function ratedList({ body }) {
  const totals = body.startedFromDay
    ? { all: 6, negative: 2, positive: 3 }
    : { all: 214, negative: 18, positive: 25 };
  const total = totals[body.feedbackFilter];
  const count = Math.max(0, Math.min(body.limit, total - body.offset));
  return {
    ...pagedList({ body }),
    totalCount: total,
    hasMore: body.offset + count < total,
    conversations: pagedList({ body }).conversations.slice(0, count),
  };
}

/** Verweis zur Liste in der Kopfzeile (Text); null, wenn er fehlt. */
const jumpTextOf = (container) =>
  elements(container, (element) => element.hasAttribute("data-jump-to-list"))[0]
    ?.textContent ?? null;
/** „N einsehbar" bzw. „N von M einsehbar" in der Kopfzeile der Liste. */
const viewableOf = (container) =>
  elements(container, (element) =>
    element.hasAttribute("data-viewable-count")
  )[0]?.textContent ?? null;
/** Markierung „Filter: …" der Liste; null ohne Bewertungsfilter. */
const feedbackMarkOf = (container) =>
  elements(container, (element) =>
    element.hasAttribute("data-feedback-filter-mark")
  )[0] ?? null;

test(
  "Gesetzte Filter: Der Verweis in der Kopfzeile nennt Bewertungsfilter und Abschnitt – ohne Filter wie bisher",
  { skip },
  async (t) => {
    const server = await analyticsServer(t, { list: ratedList });
    const view = await mountView(t, server);
    const { container, act } = view;
    assert.equal(jumpTextOf(container), "214 Konversationen ansehen ↓");

    await act(() => click(feedbackFilterOf(container, ONLY_NEGATIVE)));
    assert.equal(
      jumpTextOf(container),
      "18 negativ bewertete Konversationen ansehen ↓"
    );
    await act(() => click(feedbackFilterOf(container, ONLY_POSITIVE)));
    assert.equal(
      jumpTextOf(container),
      "25 positiv bewertete Konversationen ansehen ↓"
    );
    await act(() => click(feedbackFilterOf(container, ONLY_POSITIVE)));
    assert.equal(jumpTextOf(container), "214 Konversationen ansehen ↓");

    // Abschnitt: so benannt wie in der Markierung „Nur …“
    await act(() => click(columnsOf(container)[23]));
    const period = bucketMarkOf(container).textContent.replace(/^Nur /, "");
    assert.match(period, /^\S+, \d{2}\.\d{2}\.\d{4}$/);
    assert.equal(
      jumpTextOf(container),
      `6 Konversationen aus „${period}“ ansehen ↓`
    );

    // beides: die Kurzform – die Liste zeigt beide Markierungen
    await act(() => click(feedbackFilterOf(container, ONLY_NEGATIVE)));
    assert.equal(
      jumpTextOf(container),
      "2 gefilterte Konversationen ansehen ↓"
    );
    assert.ok(bucketMarkOf(container));
    assert.ok(feedbackMarkOf(container));

    // Einzahl
    await act(() => click(feedbackFilterOf(container, ONLY_NEGATIVE)));
    await act(() => click(columnsOf(container)[23]));
    assert.equal(bucketMarkOf(container), null);
    const single = await analyticsServer(t, {
      list: ({ body }) => ({
        ...ratedList({ body }),
        totalCount: 1,
        hasMore: false,
        conversations: ratedList({ body }).conversations.slice(0, 1),
      }),
    });
    await view.unmount();
    const one = await mountView(t, single);
    await one.act(() => click(feedbackFilterOf(one.container, ONLY_NEGATIVE)));
    assert.equal(
      jumpTextOf(one.container),
      "1 negativ bewertete Konversation ansehen ↓"
    );
    assert.equal(viewableOf(one.container), "1 von 1 einsehbar");
  }
);

test(
  "Gesetzte Filter: Mit Bewertungsfilter „18 von 214 einsehbar“ und die Markierung „Filter: Negativ bewertet“ – ihr ✕ hebt ihn auf (ungefiltert, Seite 1)",
  { skip },
  async (t) => {
    const server = await analyticsServer(t, { list: ratedList });
    const view = await mountView(t, server);
    const { container, act, listRequest } = view;
    assert.equal(viewableOf(container), "214 einsehbar");
    assert.equal(feedbackMarkOf(container), null);

    const before = server.lists().length;
    await act(() => click(feedbackFilterOf(container, ONLY_NEGATIVE)));
    // Die Zahl ohne Filter kam schon mit der ungefilterten Liste: keine
    // zusätzliche Anfrage.
    assert.deepEqual(server.lists().slice(before), [
      listRequest({ feedbackFilter: "negative" }),
    ]);
    assert.equal(viewableOf(container), "18 von 214 einsehbar");
    const mark = feedbackMarkOf(container);
    assert.equal(mark.getAttribute("data-feedback-filter-mark"), "negative");
    assert.equal(mark.textContent, "Filter: Negativ bewertet");
    // gleiche Gestaltung wie die Markierung „Nur …“
    await act(() => click(columnsOf(container)[23]));
    assert.equal(
      mark.getAttribute("class"),
      bucketMarkOf(container).getAttribute("class")
    );
    await act(() => click(columnsOf(container)[23]));
    assert.equal(bucketMarkOf(container), null);

    // ✕ hebt den Filter auf
    const closeOf = () =>
      elements(
        feedbackMarkOf(container),
        (element) => element.tagName === "BUTTON"
      )[0];
    assert.equal(
      closeOf().getAttribute("aria-label"),
      "Filter „Negativ bewertet“ aufheben"
    );
    assert.equal(
      closeOf().getAttribute("title"),
      closeOf().getAttribute("aria-label")
    );
    await act(() => click(closeOf()));
    assert.deepEqual(server.lists().at(-1), listRequest());
    assert.equal(feedbackMarkOf(container), null);
    assert.equal(viewableOf(container), "214 einsehbar");
    assert.equal(
      feedbackFilterOf(container, ONLY_NEGATIVE).getAttribute("aria-pressed"),
      "false"
    );
    assert.equal(jumpTextOf(container), "214 Konversationen ansehen ↓");

    // positiv ebenso – auf Seite 2 geblättert führt ✕ auf Seite 1
    await act(() => click(feedbackFilterOf(container, ONLY_POSITIVE)));
    assert.equal(viewableOf(container), "25 von 214 einsehbar");
    assert.equal(
      feedbackMarkOf(container).textContent,
      "Filter: Positiv bewertet"
    );
    await openSecondPage(view, server);
    assert.equal(server.lists().at(-1).body.feedbackFilter, "positive");
    assert.equal(
      closeOf().getAttribute("aria-label"),
      "Filter „Positiv bewertet“ aufheben"
    );
    await act(() => click(closeOf()));
    assert.deepEqual(server.lists().at(-1), listRequest());
    assert.equal(server.lists().at(-1).body.offset, 0);
    assert.equal(feedbackMarkOf(container), null);
    assert.equal(
      feedbackFilterOf(container, ONLY_POSITIVE).getAttribute("aria-pressed"),
      "false"
    );
    assert.deepEqual(
      rowIdsOf(container),
      Array.from({ length: PAGE_SIZE }, (_, i) => 1000 + i)
    );
  }
);

test(
  "Gesetzte Filter: Fehlt die Zahl ohne Bewertungsfilter für den Zuschnitt, fragt die Liste sie einmal parallel an (eine Konversation, ohne Filter) – ohne Bewertungsfilter nie",
  { skip },
  async (t) => {
    const server = await analyticsServer(t, { list: ratedList });
    const view = await mountView(t, server);
    const { container, act, days, listRequest } = view;
    const day = addDays(days.fromDay, 23);
    const bucket = { start: day, end: day };

    // ohne Bewertungsfilter: Laden, Abschnitt an und aus, Blättern – jede
    // Anfrage ist eine Seite der Liste
    await act(() => click(columnsOf(container)[23]));
    await act(() => click(columnsOf(container)[23]));
    await openSecondPage(view, server);
    assert.deepEqual(
      server.lists().map(({ body }) => [body.limit, body.feedbackFilter]),
      [
        [20, "all"],
        [20, "all"],
        [20, "all"],
        [20, "all"],
      ]
    );

    // Filter an (Zahl bekannt), dann ein Abschnitt, für den sie fehlt
    await act(() => click(feedbackFilterOf(container, ONLY_NEGATIVE)));
    let before = server.lists().length;
    await act(() => click(columnsOf(container)[23]));
    assert.deepEqual(server.lists().slice(before), [
      listRequest({ limit: 1, bucket }),
      listRequest({ feedbackFilter: "negative", bucket }),
    ]);
    assert.equal(viewableOf(container), "2 von 6 einsehbar");

    // Wechsel zu positiv und zurück im selben Abschnitt: bekannt
    before = server.lists().length;
    await act(() => click(feedbackFilterOf(container, ONLY_POSITIVE)));
    await act(() => click(feedbackFilterOf(container, ONLY_NEGATIVE)));
    assert.deepEqual(server.lists().slice(before), [
      listRequest({ feedbackFilter: "positive", bucket }),
      listRequest({ feedbackFilter: "negative", bucket }),
    ]);

    // Abschnitt aus: wieder ein anderer Zuschnitt – einmal die Zählabfrage
    before = server.lists().length;
    await act(() => click(columnsOf(container)[23]));
    assert.deepEqual(server.lists().slice(before), [
      listRequest({ limit: 1 }),
      listRequest({ feedbackFilter: "negative" }),
    ]);
    assert.equal(viewableOf(container), "18 von 214 einsehbar");

    // anderer Zeitraum mit gesetztem Filter: einmal die Zählabfrage
    before = server.lists().length;
    await choosePreset(view, "Letzter Monat");
    const added = server.lists().slice(before);
    assert.deepEqual(
      added.map(({ body }) => [body.offset, body.limit, body.feedbackFilter]),
      [
        [0, 1, "all"],
        [0, 20, "negative"],
      ]
    );
    assert.equal(added[0].body.startDate, added[1].body.startDate);
    assert.equal(added[0].body.endDate, added[1].body.endDate);
    assert.equal(viewableOf(container), "18 von 214 einsehbar");
  }
);

test(
  "Blättern (NAK-5): Abschnitts-Filter an und wieder aus (zweiter Klick, Schließen) führt auf Seite 1",
  { skip },
  async (t) => {
    const server = await analyticsServer(t, { list: pagedList });
    const view = await mountView(t, server);
    const { container, act, days, listRequest } = view;
    const day = addDays(days.fromDay, 23);
    const bucket = { start: day, end: day };

    // an: Klick auf die Säule – aus: zweiter Klick
    await openSecondPage(view, server);
    await act(() => click(columnsOf(container)[23]));
    assert.deepEqual(server.lists().at(-1), listRequest({ bucket }));
    await act(() => click(columnsOf(container)[23]));
    assert.deepEqual(server.lists().at(-1), listRequest());

    // an – im Abschnitt auf Seite 2 – aus über die Schließen-Schaltfläche
    await openSecondPage(view, server);
    await act(() => click(columnsOf(container)[23]));
    assert.deepEqual(server.lists().at(-1), listRequest({ bucket }));
    await openSecondPage(view, server);
    const [close] = elements(bucketMarkOf(container), (element) =>
      (element.getAttribute("aria-label") ?? "").startsWith("Filter „")
    );
    await act(() => click(close));
    assert.deepEqual(server.lists().at(-1), listRequest());

    // Derselbe Abschnitt noch einmal: Seite 1, nicht die frühere Seite 2.
    await act(() => click(columnsOf(container)[23]));
    assert.deepEqual(server.lists().at(-1), listRequest({ bucket }));
  }
);

test(
  "Blättern (NAK-5): Zeitraum gewechselt und zurück führt auf Seite 1",
  { skip },
  async (t) => {
    const server = await analyticsServer(t, { list: pagedList });
    const view = await mountView(t, server);
    await openSecondPage(view, server);

    // „Letzter Monat" endet am letzten Tag des Vormonats, nie heute.
    await choosePreset(view, "Letzter Monat");
    const other = server.lists().at(-1).body;
    assert.equal(other.offset, 0);
    assert.notEqual(other.endDate, view.period.endDate);

    await choosePreset(view, "Letzte 30 Tage");
    assert.deepEqual(server.lists().at(-1), view.listRequest());
  }
);

test(
  "Blättern (NAK-5): Widget gewechselt und zurück führt auf Seite 1",
  { skip },
  async (t) => {
    const server = await analyticsServer(t, { list: pagedList });
    const view = await mountView(t, server, [EMBED, SECOND_EMBED]);
    await openSecondPage(view, server);

    await chooseWidget(view, SECOND_EMBED);
    assert.deepEqual(server.lists().at(-1), {
      ...view.listRequest(),
      url: await urlOf(ROUTES.conversations, SECOND_EMBED.id),
    });

    await chooseWidget(view, EMBED);
    assert.deepEqual(server.lists().at(-1), view.listRequest());
  }
);

test(
  "Abschnitts-Filter: Nach einem Wechsel von Zeitraum oder Widget kommt er nicht zurück, wenn der frühere Stand wieder gilt",
  { skip },
  async (t) => {
    const server = await analyticsServer(t, { list: pagedList });
    const view = await mountView(t, server, [EMBED, SECOND_EMBED]);
    const { container, act } = view;

    await act(() => click(columnsOf(container)[23]));
    assert.ok(bucketMarkOf(container));
    await choosePreset(view, "Letzter Monat");
    assert.equal(bucketMarkOf(container)?.textContent, undefined);
    await choosePreset(view, "Letzte 30 Tage");
    assert.equal(bucketMarkOf(container)?.textContent, undefined);
    assert.deepEqual(server.lists().at(-1), view.listRequest());

    await act(() => click(columnsOf(container)[23]));
    assert.ok(bucketMarkOf(container));
    await chooseWidget(view, SECOND_EMBED);
    assert.equal(bucketMarkOf(container)?.textContent, undefined);
    await chooseWidget(view, EMBED);
    assert.equal(bucketMarkOf(container)?.textContent, undefined);
    assert.deepEqual(server.lists().at(-1), view.listRequest());
    assert.deepEqual(
      columnsOf(container).filter(
        (column) => column.getAttribute("aria-pressed") === "true"
      ),
      []
    );
  }
);

// ---------------------------------------------------------------------------
// Laden: Nur die jüngste Anfrage setzt den Zustand
// ---------------------------------------------------------------------------

const LOAD_ERROR = "Die Zählwerte konnten nicht geladen werden.";

/**
 * Ersetzt fetch durch eines, dessen Antworten der Test auslöst: Jede Anfrage
 * bleibt offen, bis answer() (Antwort als JSON) oder fail() (die Anfrage
 * selbst scheitert, z. B. abgebrochen) aufgerufen wird.
 */
function heldFetch(t) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = (url, init = {}) =>
    new Promise((resolve, reject) => {
      calls.push({
        url,
        body: init.body === undefined ? undefined : JSON.parse(init.body),
        answer: (json) =>
          resolve({ ok: true, status: 200, json: async () => json }),
        fail: (error) => reject(error),
      });
    });
  t.after(() => {
    globalThis.fetch = original;
  });
  const open = (suffix, embed) =>
    calls.filter((call) => call.url.endsWith(`/embed/${embed.id}${suffix}`));
  return {
    calls,
    summaries: (embed) => open("/analytics/summary", embed),
    lists: (embed) => open("/analytics/conversations", embed),
  };
}

/** Merkt sich die Meldungen (Toasts), die die Ansicht während des Tests zeigt. */
async function watchToasts(t) {
  const { toast } = await import("react-toastify");
  const shown = [];
  for (const type of ["success", "error", "info", "warn"]) {
    const original = toast[type];
    toast[type] = (message) => shown.push({ type, message });
    t.after(() => {
      toast[type] = original;
    });
  }
  return shown;
}

/** Die Model-Funktionen melden gescheiterte Anfragen auf der Konsole. */
function silenceConsoleError(t) {
  const original = console.error;
  console.error = () => {};
  t.after(() => {
    console.error = original;
  });
}

const summaryOf = (call, messages) => ({
  success: true,
  granularity: "day",
  fromDay: call.body.fromDay,
  toDay: call.body.toDay,
  firstLedgerDay: "2026-01-01",
  totals: {
    messages,
    conversations: 1,
    feedbackPositive: 0,
    feedbackNegative: 0,
  },
  buckets: [
    {
      start: call.body.fromDay,
      end: call.body.fromDay,
      partial: false,
      messages,
      conversations: 1,
    },
    {
      start: call.body.toDay,
      end: call.body.toDay,
      partial: false,
      messages: 0,
      conversations: 0,
    },
  ],
});
const EMPTY_LIST = {
  success: true,
  conversations: [],
  hasMore: false,
  totalCount: 0,
};

test(
  "Laden: Scheitert die jüngste Anfrage, zeigt die Ansicht die Meldung im Diagramm und einen Toast",
  { skip },
  async (t) => {
    silenceConsoleError(t);
    const toasts = await watchToasts(t);
    const server = heldFetch(t);
    const { container, act } = await mountView(t, server);

    await act(() => server.lists(EMBED)[0].answer(EMPTY_LIST));
    assert.doesNotMatch(container.textContent, new RegExp(LOAD_ERROR));
    await act(() => server.summaries(EMBED)[0].fail(new TypeError("fetch")));

    assert.match(container.textContent, new RegExp(LOAD_ERROR));
    assert.deepEqual(toasts, [
      { type: "error", message: "Fehler beim Laden der Konversationsdaten." },
    ]);
    assert.match(kpiTextOf(container)[0], /^Nachrichten–/);
  }
);

for (const [name, late] of [
  ["mit Erfolg", (call) => call.answer(summaryOf(call, 885))],
  ["mit einem Fehler", (call) => call.answer({ success: false })],
  [
    "abgebrochen",
    (call) => call.fail(new DOMException("aborted", "AbortError")),
  ],
]) {
  test(
    `Laden: Widget gewechselt – die überholte Anfrage des ersten Widgets antwortet danach ${name}: Die Ansicht zeigt die Zählwerte des zweiten, ohne Fehlertext und ohne Toast`,
    { skip },
    async (t) => {
      silenceConsoleError(t);
      const toasts = await watchToasts(t);
      const server = heldFetch(t);
      const view = await mountView(t, server, [EMBED, SECOND_EMBED]);
      const { container, act } = view;
      assert.equal(server.summaries(EMBED).length, 1);

      // Die Anfrage des ersten Widgets ist noch offen.
      await chooseWidget(view, SECOND_EMBED);
      const [second] = server.summaries(SECOND_EMBED);
      await act(() => {
        second.answer(summaryOf(second, 5));
        server.lists(SECOND_EMBED)[0].answer(EMPTY_LIST);
      });
      assert.match(kpiTextOf(container)[0], /^Nachrichten5Ø/);

      // Jetzt erst antworten die Anfragen des ersten Widgets.
      await act(() => {
        late(server.summaries(EMBED)[0]);
        late(server.lists(EMBED)[0]);
      });
      assert.match(kpiTextOf(container)[0], /^Nachrichten5Ø/);
      assert.equal(columnsOf(container).length, 2);
      assert.doesNotMatch(container.textContent, new RegExp(LOAD_ERROR));
      assert.deepEqual(toasts, []);
      assert.equal(server.calls.length, 4);
    }
  );
}

for (const [name, late] of [
  ["mit Erfolg", (call) => call.answer(summaryOf(call, 885))],
  ["mit einem Fehler", (call) => call.answer({ success: false })],
]) {
  test(
    `Laden: „Gesamt“ fragt in zwei Schritten – wird währenddessen ein anderer Zeitraum gewählt, zählt nur dessen Antwort; der erste Schritt antwortet danach ${name} und löst keinen zweiten aus`,
    { skip },
    async (t) => {
      silenceConsoleError(t);
      const toasts = await watchToasts(t);
      const server = heldFetch(t);
      const view = await mountView(t, server);
      const { container, act, days } = view;
      const [first] = server.summaries(EMBED);
      await act(() => first.answer(summaryOf(first, 885)));

      // „Gesamt": erst die Frage nach heute (erster Tag mit Zählwerten) …
      await choosePreset(view, "Gesamt");
      const probe = server.summaries(EMBED)[1];
      assert.equal(probe.body.fromDay, probe.body.toDay);

      // … die noch offen ist, als wieder „Letzte 30 Tage" gewählt wird.
      await choosePreset(view, "Letzte 30 Tage");
      const latest = server.summaries(EMBED)[2];
      assert.deepEqual(latest.body, summaryBody(days.fromDay, days.toDay));
      await act(() => latest.answer(summaryOf(latest, 7)));
      assert.match(kpiTextOf(container)[0], /^Nachrichten7Ø/);

      await act(() => late(probe));
      assert.equal(server.summaries(EMBED).length, 3);
      assert.match(kpiTextOf(container)[0], /^Nachrichten7Ø/);
      assert.doesNotMatch(container.textContent, new RegExp(LOAD_ERROR));
      assert.deepEqual(toasts, []);
    }
  );
}

// ---------------------------------------------------------------------------
// Kennung kopieren – in der Fußzeile des Seitenpanels (AK-15)
// ---------------------------------------------------------------------------

/** Ersetzt navigator für die Dauer eines Tests. */
function stubNavigator(t, navigator) {
  const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    value: navigator,
    configurable: true,
  });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, "navigator", original);
    else delete globalThis.navigator;
  });
}

for (const [name, clipboard, expected] of [
  [
    "Der Browser kopiert: Erfolgsmeldung",
    { writeText: async () => {} },
    { type: "success", message: "Kennung kopiert" },
  ],
  [
    "Der Browser lehnt das Kopieren ab: Fehlermeldung statt Erfolgsmeldung",
    {
      writeText: async () => {
        throw new DOMException("Write permission denied.", "NotAllowedError");
      },
    },
    {
      type: "error",
      message: "Kopieren nicht möglich — bitte manuell markieren.",
    },
  ],
  [
    "Ohne Zwischenablage (kein HTTPS): Fehlermeldung statt Erfolgsmeldung",
    undefined,
    {
      type: "error",
      message: "Kopieren nicht möglich — bitte manuell markieren.",
    },
  ],
]) {
  test(`Kennung kopieren – ${name}`, { skip }, async (t) => {
    const written = [];
    stubNavigator(t, {
      clipboard: clipboard && {
        writeText: (text) => {
          written.push(text);
          return clipboard.writeText(text);
        },
      },
    });
    const toasts = await watchToasts(t);
    const server = await analyticsServer(t, { list: pagedList });
    const { container, act } = await mountView(t, server);
    // Die Zeile zeigt keine Kennung (AK-1) – erst das geöffnete Panel.
    assert.equal(
      elements(
        container,
        (element) => element.getAttribute("title") === "Kennung kopieren"
      ).length,
      0
    );
    assert.doesNotMatch(container.textContent, /konversation-1/);
    const [row] = elements(container, (element) =>
      element.hasAttribute("data-conversation-row")
    );
    await act(() => click(row));
    const [copy] = elements(
      container,
      (element) =>
        element.hasAttribute("data-panel-id") &&
        element.getAttribute("title") === "Kennung kopieren"
    );
    // gekürzt: die ersten 8 Zeichen
    assert.equal(copy.textContent, "ID konversa…");

    await act(() => click(copy));

    assert.deepEqual(toasts, [expected]);
    assert.deepEqual(written, clipboard ? ["konversation-1"] : []);
  });
}
