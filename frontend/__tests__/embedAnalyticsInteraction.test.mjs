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
import { click, elements, movePointer, pressKey } from "./helpers/testDom.mjs";
import { addDays } from "../src/utils/analyticsTimeline.js";

const DIR = "/src/pages/GeneralSettings/ChatEmbedWidgets/EmbedAnalytics";
const CHART = `${DIR}/TimelineChart.jsx`;
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
