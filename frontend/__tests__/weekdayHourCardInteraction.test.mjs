// KIE-539: Karte „Wann schreiben Ihre Besucher?" – Maus, Tastatur, Touch, die
// Tabellenansicht, die schmale Karte und das Laden in der Ansicht. Die
// Komponenten sind mit React DOM in ein Dokument ohne Browser eingehängt
// (helpers/renderSettingsPage.mjs, mount): Effekte laufen, Eingaben werden
// über die Handler der Elemente nachgestellt (helpers/testDom.mjs).
//
// Was ein Browser bei einer Eingabe auslöst, wie die Stufen in beiden Themes
// aussehen und ob die Seite bei 390 px nicht waagerecht scrollt, bleibt Sache
// des Browser-Tests.
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
  lastDaysRange,
  rangeFromDates,
} from "../src/utils/analyticsTimeline.js";
import requests from "../../server/__tests__/endpoints/support/embedAnalyticsRequests.js";
import scenarios from "../../server/__tests__/endpoints/support/weekdayHourScenarios.js";

const { ROUTES, summaryBody } = requests;
const { PERIOD, DISTRIBUTION, CORE_TIME_WEEK, gridOf, weekdayOf } = scenarios;

const DIR = "/src/pages/GeneralSettings/ChatEmbedWidgets/EmbedAnalytics";
const CARD = `${DIR}/WeekdayHourCard.jsx`;
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
/** Die 168 Felder in Leserichtung; cellAt(Wochentag, Stunde) = Feld. */
const cellsOf = (container) => withAttribute(container, "data-heat-cell");
const cellAt = (container, weekday, hour) =>
  cellsOf(container)[weekday * 24 + hour];
const cardOf = (container) =>
  withAttribute(container, "data-weekday-hour-card")[0] ?? null;
/** Der Tooltip der Karte; null, wenn keiner zu sehen ist. */
function tooltipElementOf(container) {
  const [tooltip, ...more] = elements(cardOf(container), (element) =>
    (element.getAttribute("class") ?? "").includes("pointer-events-none")
  );
  assert.equal(more.length, 0, "mehr als ein Tooltip");
  return tooltip ?? null;
}
const tooltipOf = (container) =>
  tooltipElementOf(container)?.textContent ?? null;
const tileOf = (cell) => cell.childNodes[1];
/** Felder mit Rahmen (Tooltip-Feld oder Tastaturfokus) als [Wochentag, Stunde]. */
const outlinedOf = (container, width) =>
  cellsOf(container)
    .map((cell, index) => [tileOf(cell), index])
    .filter(
      ([tile]) =>
        tile.getAttribute("stroke") !== "none" &&
        (width === undefined || tile.getAttribute("stroke-width") === width)
    )
    .map(([, index]) => [Math.floor(index / 24), index % 24]);
/** Felder mit dem Rahmen des Tastaturfokus. */
const ringsOf = (container) => outlinedOf(container, "2");
const tabStopsOf = (container) =>
  cellsOf(container)
    .map((cell, index) => [cell.getAttribute("tabindex"), index])
    .filter(([tabindex]) => tabindex === "0")
    .map(([, index]) => [Math.floor(index / 24), index % 24]);
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

/** Antwort von analytics/summary zu Zählwerten im Zeitraum. */
function summaryOf(cells, { fromDay, toDay } = PERIOD) {
  const grid = gridOf(cells);
  const messages = grid.flat().reduce((total, value) => total + value, 0);
  const days = [];
  for (let day = fromDay; day <= toDay; day = addDays(day, 1)) days.push(day);
  return {
    success: true,
    granularity: "day",
    fromDay,
    toDay,
    firstLedgerDay: "2026-01-01",
    totals: {
      messages,
      conversations: Math.ceil(messages / 3),
      feedbackPositive: 9,
      feedbackNegative: 3,
    },
    buckets: days.map((day) => ({
      start: day,
      end: day,
      partial: false,
      messages: cells
        .filter((cell) => cell.day === day)
        .reduce((total, cell) => total + cell.messages, 0),
      conversations: 1,
    })),
    weekdayHour: grid,
  };
}

// 30 Tage, 252 Nachrichten, Höchstwert dienstags 10–11 Uhr (14)
const DATA = summaryOf(DISTRIBUTION.cells);
const GRID = DATA.weekdayHour;
const TUESDAY = 1;

// ---------------------------------------------------------------------------
// Tooltip (AK-5)
// ---------------------------------------------------------------------------

test(
  "Tooltip (AK-5): Der Mauszeiger über einem Feld zeigt „Dienstag, 10–11 Uhr: 14 Nachrichten“ – ohne Zeiger kein Tooltip",
  { skip },
  async (t) => {
    const { container, document, act } = await mount(t, CARD, {
      summary: DATA,
      loading: false,
    });
    assert.equal(cellsOf(container).length, 168);
    assert.equal(tooltipOf(container), null);

    await act(() => movePointer(document, cellAt(container, TUESDAY, 10)));
    assert.equal(tooltipOf(container), "Dienstag, 10–11 Uhr: 14 Nachrichten");
    // dasselbe wie die Beschriftung des Feldes
    assert.equal(
      cellAt(container, TUESDAY, 10).getAttribute("aria-label"),
      tooltipOf(container)
    );
    assert.deepEqual(outlinedOf(container), [[TUESDAY, 10]]);
    // Der Mauszeiger allein gibt keinen Fokusrahmen.
    assert.deepEqual(ringsOf(container), []);

    // ein Feld ohne Nachrichten nennt die 0
    await act(() => movePointer(document, cellAt(container, 0, 3)));
    assert.equal(tooltipOf(container), "Montag, 3–4 Uhr: 0 Nachrichten");
    await act(() => movePointer(document, cellAt(container, 6, 23)));
    assert.equal(tooltipOf(container), "Sonntag, 23–24 Uhr: 0 Nachrichten");
    assert.equal(GRID[3][9], 3);
    await act(() => movePointer(document, cellAt(container, 3, 9)));
    assert.equal(tooltipOf(container), "Donnerstag, 9–10 Uhr: 3 Nachrichten");

    await act(() => movePointer(document, null));
    assert.equal(tooltipOf(container), null);
    assert.deepEqual(outlinedOf(container), []);
  }
);

test(
  "Tooltip (AK-5): Tastaturfokus zeigt den Tooltip; die Pfeiltasten wechseln das Feld in beide Richtungen, Pos1 und Ende springen an die Ränder der Zeile",
  { skip },
  async (t) => {
    const { container, document, act } = await mount(t, CARD, {
      summary: DATA,
      loading: false,
    });

    // Tab erreicht den einen Tab-Stopp des Rasters: das stärkste Feld.
    assert.deepEqual(tabStopsOf(container), [[TUESDAY, 10]]);
    await act(() => cellAt(container, TUESDAY, 10).focus());
    assert.equal(tooltipOf(container), "Dienstag, 10–11 Uhr: 14 Nachrichten");
    assert.deepEqual(ringsOf(container), [[TUESDAY, 10]]);

    await act(() => pressKey(document, "ArrowRight"));
    assert.equal(document.activeElement, cellAt(container, TUESDAY, 11));
    assert.equal(
      tooltipOf(container),
      `Dienstag, 11–12 Uhr: ${GRID[1][11]} Nachrichten`
    );
    await act(() => pressKey(document, "ArrowDown"));
    assert.equal(document.activeElement, cellAt(container, 2, 11));
    assert.match(tooltipOf(container), /^Mittwoch, 11–12 Uhr: /);
    await act(() => pressKey(document, "ArrowLeft"));
    await act(() => pressKey(document, "ArrowLeft"));
    assert.match(tooltipOf(container), /^Mittwoch, 9–10 Uhr: /);
    await act(() => pressKey(document, "ArrowUp"));
    await act(() => pressKey(document, "ArrowUp"));
    assert.match(tooltipOf(container), /^Montag, 9–10 Uhr: /);
    assert.deepEqual(ringsOf(container), [[0, 9]]);

    // Ränder: Pos1 und Ende in der Zeile, darüber hinaus bleibt der Fokus.
    await act(() => pressKey(document, "Home"));
    assert.equal(tooltipOf(container), "Montag, 0–1 Uhr: 0 Nachrichten");
    await act(() => pressKey(document, "ArrowLeft"));
    await act(() => pressKey(document, "ArrowUp"));
    assert.equal(document.activeElement, cellAt(container, 0, 0));
    assert.deepEqual(ringsOf(container), [[0, 0]]);
    await act(() => pressKey(document, "End"));
    assert.equal(tooltipOf(container), "Montag, 23–24 Uhr: 0 Nachrichten");
    for (let i = 0; i < 8; i++)
      await act(() => pressKey(document, "ArrowDown"));
    await act(() => pressKey(document, "ArrowRight"));
    assert.equal(document.activeElement, cellAt(container, 6, 23));
    assert.equal(tooltipOf(container), "Sonntag, 23–24 Uhr: 0 Nachrichten");

    // Der Fokus verlässt das Raster: kein Tooltip, kein Rahmen – der zuletzt
    // fokussierte Platz bleibt der Tab-Stopp.
    await act(() => cellAt(container, 6, 23).blur());
    assert.equal(tooltipOf(container), null);
    assert.deepEqual(outlinedOf(container), []);
    assert.deepEqual(tabStopsOf(container), [[6, 23]]);
  }
);

test(
  "Tooltip: Die letzte Eingabe entscheidet – der Mauszeiger löst den Fokus ab, eine Pfeiltaste den Mauszeiger; fällt eines weg, gilt das andere",
  { skip },
  async (t) => {
    const { container, document, act } = await mount(t, CARD, {
      summary: DATA,
      loading: false,
    });

    await act(() => cellAt(container, TUESDAY, 10).focus());
    assert.equal(tooltipOf(container), "Dienstag, 10–11 Uhr: 14 Nachrichten");

    // Der Mauszeiger kommt dazu: Er gewinnt, der Fokusrahmen bleibt.
    await act(() => movePointer(document, cellAt(container, 4, 15)));
    assert.match(tooltipOf(container), /^Freitag, 15–16 Uhr: /);
    assert.deepEqual(ringsOf(container), [[TUESDAY, 10]]);
    assert.deepEqual(outlinedOf(container), [
      [TUESDAY, 10],
      [4, 15],
    ]);

    // Der Zeiger ruht, die Pfeiltaste wechselt das Feld: Der Tooltip folgt ihr.
    await act(() => pressKey(document, "ArrowRight"));
    assert.match(tooltipOf(container), /^Dienstag, 11–12 Uhr: /);
    // Der Zeiger bewegt sich auf seinem Feld: wieder das Feld unter ihm.
    await act(() => movePointer(document, cellAt(container, 4, 15)));
    assert.match(tooltipOf(container), /^Freitag, 15–16 Uhr: /);
    // Der Zeiger verlässt das Raster: zurück zum fokussierten Feld.
    await act(() => movePointer(document, null));
    assert.match(tooltipOf(container), /^Dienstag, 11–12 Uhr: /);
    assert.deepEqual(ringsOf(container), [[TUESDAY, 11]]);
  }
);

test(
  "Tooltip: Nach einem Klick mit Maus oder Stift kein Fokusrahmen – verlässt der Zeiger das Raster, verschwindet der Tooltip; die Tastatur setzt am Feld fort",
  { skip },
  async (t) => {
    for (const pointerType of ["mouse", "pen"]) {
      const { container, document, act, unmount } = await mount(t, CARD, {
        summary: DATA,
        loading: false,
      });

      await act(() => click(cellAt(container, 2, 12), pointerType));
      assert.equal(document.activeElement, cellAt(container, 2, 12));
      assert.match(tooltipOf(container), /^Mittwoch, 12–13 Uhr: /, pointerType);
      assert.deepEqual(ringsOf(container), [], pointerType);

      await act(() => movePointer(document, cellAt(container, 2, 13)));
      assert.match(tooltipOf(container), /^Mittwoch, 13–14 Uhr: /);
      await act(() => movePointer(document, null));
      assert.equal(tooltipOf(container), null, pointerType);
      assert.deepEqual(outlinedOf(container), [], pointerType);
      // Das angeklickte Feld ist der Tab-Stopp.
      assert.deepEqual(tabStopsOf(container), [[2, 12]]);

      await act(() => pressKey(document, "ArrowLeft"));
      assert.match(tooltipOf(container), /^Mittwoch, 11–12 Uhr: /);
      assert.deepEqual(ringsOf(container), [[2, 11]]);
      await unmount();
    }
  }
);

test(
  "Tooltip (Touch): Tippen zeigt den Tooltip des Feldes und lässt ihn stehen – bis ein anderes Feld angetippt wird oder der Fokus das Raster verlässt",
  { skip },
  async (t) => {
    const { container, act } = await mount(t, CARD, {
      summary: DATA,
      loading: false,
    });

    await act(() => tap(cellAt(container, TUESDAY, 10)));
    assert.equal(tooltipOf(container), "Dienstag, 10–11 Uhr: 14 Nachrichten");
    await act(() => tap(cellAt(container, 5, 19)));
    assert.match(tooltipOf(container), /^Samstag, 19–20 Uhr: /);
    assert.equal(outlinedOf(container).length, 1);

    await act(() => cellAt(container, 5, 19).blur());
    assert.equal(tooltipOf(container), null);
  }
);

test(
  "Tooltip: Ein Fensterwechsel ist keine Eingabe – nach der Rückkehr steht kein Fokusrahmen am angeklickten Feld",
  { skip },
  async (t) => {
    const { container, document, act } = await mount(t, CARD, {
      summary: DATA,
      loading: false,
    });

    await act(() => click(cellAt(container, 3, 14)));
    await act(() => movePointer(document, null));
    assert.equal(tooltipOf(container), null);

    await act(() => leaveWindow(document));
    await act(() => returnToWindow(document));
    assert.equal(tooltipOf(container), null);
    assert.deepEqual(ringsOf(container), []);

    // Mit Tastaturfokus bleibt der Tooltip über den Fensterwechsel stehen.
    await act(() => pressKey(document, "ArrowRight"));
    assert.match(tooltipOf(container), /^Donnerstag, 15–16 Uhr: /);
    await act(() => leaveWindow(document));
    await act(() => returnToWindow(document));
    assert.match(tooltipOf(container), /^Donnerstag, 15–16 Uhr: /);
    assert.deepEqual(ringsOf(container), [[3, 15]]);
  }
);

// ---------------------------------------------------------------------------
// Schmale Karte (AK-10)
// ---------------------------------------------------------------------------

/**
 * Das Raster misst seine Breite am umgebenden Element und folgt ihr über
 * einen ResizeObserver. Liefert eine Funktion, die die Breite setzt.
 */
function gridWidth(t) {
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
  "Schmale Karte (AK-10, 390 px): Das Raster lässt sich innerhalb der Karte waagerecht schieben – die Wochentage bleiben stehen, nichts ist breiter als die Karte, und der Tooltip bleibt darin",
  { skip },
  async (t) => {
    const setWidth = gridWidth(t);
    const { container, document, act } = await mount(t, CARD, {
      summary: DATA,
      loading: false,
    });
    const [wrapper] = withAttribute(container, "data-heat-grid");
    const [scroller] = withAttribute(container, "data-heat-scroller");
    const svg = scroller.firstChild;
    const labels = withAttribute(container, "data-heat-row-label");
    const classes = (element) => element.getAttribute("class").split(/\s+/);
    /** Wo der Tooltip höchstens liegen kann: Anker und Höchstbreite. */
    const boxOf = ({ style }, width) => {
      const max = parseFloat(style.maxWidth);
      assert.ok(max > 0, "keine Höchstbreite");
      if (style.right !== undefined && style.right !== "") {
        const right = width - parseFloat(style.right);
        return { left: right - max, right };
      }
      const left = parseFloat(style.left);
      return style.transform.startsWith("translate(-50%")
        ? { left: left - max / 2, right: left + max / 2 }
        : { left, right: left + max };
    };

    // Der verschiebbare Bereich: nimmt den Rest der Breite, wird nie breiter
    // als die Karte (min-w-0) und schiebt nur waagerecht.
    for (const name of ["min-w-0", "flex-1", "overflow-x-auto"])
      assert.ok(classes(scroller).includes(name), name);
    assert.ok(classes(wrapper).includes("w-full"));
    assert.ok(classes(wrapper).includes("relative"));
    // Die Wochentage stehen daneben, nicht darin.
    assert.equal(labels.length, 7);
    for (const label of labels) assert.ok(!scroller.contains(label));
    assert.ok(classes(labels[0].parentNode).includes("shrink-0"));
    // Der Tooltip steht außerhalb des verschiebbaren Bereichs: Er wird nicht
    // abgeschnitten und nicht mitgeschoben.
    await act(() => movePointer(document, cellAt(container, 0, 0)));
    assert.equal(tooltipElementOf(container).parentNode, wrapper);
    assert.ok(!scroller.contains(tooltipElementOf(container)));

    // 390 px Fenster: 342 px in der Karte, davon 28 px für die Wochentage
    await act(() => setWidth(342));
    assert.equal(svg.getAttribute("width"), "576");
    assert.equal(labels[0].parentNode.style.width, "28px");
    assert.ok(576 > 342 - 28, "das Raster ist breiter als sein Bereich");
    for (const scrollLeft of [0, 131, 262]) {
      await act(() =>
        handlersOf(scroller).onScroll({ currentTarget: { scrollLeft } })
      );
      for (const [weekday, hour] of [
        [0, 0],
        [0, 12],
        [6, 23],
        [3, 5],
        [TUESDAY, 10],
      ]) {
        await act(() =>
          movePointer(document, cellAt(container, weekday, hour))
        );
        const tooltip = tooltipElementOf(container);
        const where = `${scrollLeft} px verschoben, ${weekday}/${hour}`;
        const box = boxOf(tooltip, 342);
        assert.ok(box.left >= 0 && box.right <= 342, where);
        // so breit wie der Text, aber umbrechbar – und außerhalb des Textflusses
        for (const name of ["w-max", "absolute", "break-words"])
          assert.ok(classes(tooltip).includes(name), where);
        // Unterkante über der Zeile des Feldes: Mehr Zeilen wachsen nach oben.
        assert.match(tooltip.style.transform, /-100%\)$/, where);
        assert.equal(parseFloat(tooltip.style.top), weekday * 28 - 8, where);
      }
    }
    // Verschoben folgt der Tooltip der Stelle, an der das Feld zu sehen ist.
    await act(() =>
      handlersOf(scroller).onScroll({ currentTarget: { scrollLeft: 0 } })
    );
    await act(() => movePointer(document, cellAt(container, 2, 6)));
    const before = tooltipElementOf(container).style.left;
    await act(() =>
      handlersOf(scroller).onScroll({ currentTarget: { scrollLeft: 100 } })
    );
    assert.notEqual(tooltipElementOf(container).style.left, before);

    // Breit (1440 px Fenster): Das Raster füllt die Karte, nichts ist zu schieben.
    await act(() => setWidth(1060));
    assert.equal(svg.getAttribute("width"), String(1060 - 28));
  }
);

// ---------------------------------------------------------------------------
// Tabellenansicht (AK-9, NAK-2)
// ---------------------------------------------------------------------------

test(
  "Tabellenansicht (AK-9): „Als Tabelle“ zeigt die 168 Werte mit Wochentagen als Zeilen und Stunden als Spalten – mit Zeilen- und Spaltensummen",
  { skip },
  async (t) => {
    const { container, act } = await mount(t, CARD, {
      summary: DATA,
      loading: false,
    });
    const toggle = buttonOf(container, "Als Tabelle");
    assert.equal(toggle.getAttribute("aria-pressed"), "false");
    assert.equal(withAttribute(container, "data-heat-table").length, 0);

    await act(() => click(toggle));
    assert.equal(toggle.getAttribute("aria-pressed"), "true");
    assert.equal(cellsOf(container).length, 0);
    const [region] = withAttribute(container, "data-heat-table");
    // per Tastatur erreichbar, markierbar, in der Karte waagerecht verschiebbar
    assert.equal(region.getAttribute("tabindex"), "0");
    assert.equal(region.getAttribute("role"), "region");
    assert.equal(
      region.getAttribute("aria-label"),
      "Nachrichten nach Wochentag und Uhrzeit"
    );
    const regionClasses = region.getAttribute("class").split(/\s+/);
    assert.ok(regionClasses.includes("overflow-x-auto"));
    assert.ok(regionClasses.includes("select-text"));

    const rowsOf = (section) =>
      elements(region, (element) => element.tagName === section)[0]
        .childNodes.filter((row) => row.tagName === "TR")
        .map((row) => row.childNodes.map((cell) => cell.textContent));
    const [head, hours] = rowsOf("THEAD");
    assert.deepEqual(head, ["Wochentag", "Stunde ab … Uhr", "Summe"]);
    assert.deepEqual(
      hours,
      Array.from({ length: 24 }, (_, hour) => String(hour))
    );
    // Jede Stundenspalte nennt ihren Zeitabschnitt.
    const hourHeads = elements(
      region,
      (element) => element.tagName === "TH" && /^\d+$/.test(element.textContent)
    );
    assert.equal(hourHeads[10].getAttribute("aria-label"), "10–11 Uhr");
    assert.equal(hourHeads[23].getAttribute("aria-label"), "23–24 Uhr");

    const body = rowsOf("TBODY");
    assert.equal(body.length, 7);
    assert.deepEqual(
      body.map((row) => row[0]),
      [
        "Montag",
        "Dienstag",
        "Mittwoch",
        "Donnerstag",
        "Freitag",
        "Samstag",
        "Sonntag",
      ]
    );
    // 7 × 24 Werte – genau das Raster – und die Zeilensummen
    assert.deepEqual(
      body.map((row) => row.slice(1, 25).map(Number)),
      GRID
    );
    assert.equal(body.flatMap((row) => row.slice(1, 25)).length, 168);
    assert.deepEqual(
      body.map((row) => Number(row[25])),
      GRID.map((row) => row.reduce((a, b) => a + b))
    );
    assert.equal(body[TUESDAY][1 + 10], "14");

    // Spaltensummen und Gesamtsumme = Kennzahl „Nachrichten“
    const [foot] = rowsOf("TFOOT");
    assert.equal(foot[0], "Summe");
    assert.deepEqual(
      foot.slice(1, 25).map(Number),
      Array.from({ length: 24 }, (_, hour) =>
        GRID.reduce((total, row) => total + row[hour], 0)
      )
    );
    assert.equal(foot[25], "252");
    assert.equal(Number(foot[25]), DATA.totals.messages);

    // Die Aussagen und die Legende bleiben stehen; zurück zum Raster.
    assert.equal(withAttribute(container, "data-statement").length, 2);
    assert.equal(withAttribute(container, "data-heat-legend").length, 1);
    await act(() => click(toggle));
    assert.equal(cellsOf(container).length, 168);
    assert.equal(withAttribute(container, "data-heat-table").length, 0);
  }
);

test(
  "Tabellenansicht: große Werte in deutscher Schreibweise; die Wochentage bleiben beim Schieben stehen",
  { skip },
  async (t) => {
    const big = summaryOf([
      { day: "2026-10-06", hour: 10, messages: 12345 },
      { day: "2026-10-07", hour: 11, messages: 1000 },
    ]);
    const { container, act } = await mount(t, CARD, {
      summary: big,
      loading: false,
    });
    await act(() => click(buttonOf(container, "Als Tabelle")));
    const [region] = withAttribute(container, "data-heat-table");
    const texts = elements(region, (element) => element.tagName === "TD").map(
      (cell) => cell.textContent
    );
    assert.ok(texts.includes("12.345"));
    assert.ok(texts.includes("1.000"));
    assert.equal(texts.at(-1), "13.345");

    const rowHeads = elements(
      region,
      (element) =>
        element.tagName === "TH" && element.getAttribute("scope") === "row"
    );
    assert.equal(rowHeads.length, 8);
    for (const head of rowHeads) {
      const names = head.getAttribute("class").split(/\s+/);
      assert.ok(names.includes("sticky") && names.includes("left-0"));
      // deckend, damit die Werte darunter nicht durchscheinen
      assert.ok(names.includes("bg-theme-bg-primary"));
    }
  }
);

// ---------------------------------------------------------------------------
// Klassen (AK-10): Tailwind erzeugt für jede Klasse der Karte CSS
// ---------------------------------------------------------------------------

/** Das CSS, das Tailwind für diese Klassen erzeugt (PostCSS-Baum). */
async function tailwindCss(classes) {
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
  return root;
}

test(
  "Jede Klasse der Karte gibt es: Tailwind erzeugt mit der Konfiguration des Projekts CSS dafür – Raster mit Tooltip, Tabelle, Hinweis und Laden",
  { skip },
  async (t) => {
    const used = new Set();
    const collect = (container) => {
      for (const element of elements(container))
        for (const name of (element.getAttribute("class") ?? "").split(/\s+/))
          if (name) used.add(name);
    };
    const data = await mount(t, CARD, { summary: DATA, loading: false });
    await data.act(() => cellAt(data.container, TUESDAY, 10).focus());
    assert.ok(tooltipOf(data.container));
    collect(data.container);
    await data.act(() => click(buttonOf(data.container, "Als Tabelle")));
    collect(data.container);
    for (const props of [
      { summary: summaryOf([]), loading: false },
      { summary: null, loading: true },
      { summary: DATA, loading: true },
    ])
      collect((await mount(t, CARD, props)).container);

    for (const expected of [
      "overflow-x-auto",
      "min-w-0",
      "h-[160px]",
      "text-[11px]",
      "min-w-[26px]",
      "sm:grid-cols-2",
      "text-[color:var(--theme-analytics-text-muted)]",
      "opacity-50",
    ])
      assert.ok(used.has(expected), expected);

    const css = await tailwindCss([...used]);
    const escape = (name) => name.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
    const missing = [...used].filter((name) => {
      const selector = `.${escape(name)}`;
      let found = false;
      css.walkRules((rule) => {
        if (
          rule.selectors.some((candidate) => {
            const at = candidate.indexOf(selector);
            return (
              at >= 0 && !/[\w\\-]/.test(candidate[at + selector.length] ?? "")
            );
          })
        )
          found = true;
      });
      return !found;
    });
    assert.deepEqual(missing, [], "Klassen ohne CSS");
    // Keine Klasse färbt Text in einer Datenfarbe.
    assert.deepEqual(
      [...used].filter((name) => /heat|analytics-bar/.test(name)),
      []
    );
  }
);

// ---------------------------------------------------------------------------
// In der Ansicht: eine Anfrage, Zustände folgen dem Zeitraum
// ---------------------------------------------------------------------------

const EMBED = {
  id: 3,
  chat_retention_days: 30,
  workspace: { name: "VHS Musterstadt" },
};

/** Adresse einer Route für das Widget, wie das Frontend sie aufruft. */
async function urlOf(route, embedId = EMBED.id) {
  const { API_BASE } = await renderer.load("/src/utils/constants.js");
  return `${API_BASE}${route.path.replace(":embedId", embedId)}`;
}

/**
 * Der Server der Ansicht: analytics/summary antwortet zu jedem Zeitraum mit
 * den Zählwerten, die cellsFor für ihn nennt (Kennzahlen, Säulen und Raster
 * aus denselben Werten); die Konversationsliste ist leer.
 */
async function analyticsServer(t, cellsFor) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const call = {
      method: init.method,
      url,
      body: init.body === undefined ? undefined : JSON.parse(init.body),
    };
    calls.push(call);
    const json = url.endsWith("/analytics/summary")
      ? summaryOf(cellsFor(call.body), call.body)
      : { success: true, conversations: [], hasMore: false, totalCount: 0 };
    return { ok: true, status: 200, json: async () => json };
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return {
    summaryUrl: await urlOf(ROUTES.summary),
    summaries: () =>
      calls.filter((call) => call.url.endsWith("/analytics/summary")),
  };
}

/** Wählt in der Datumsauswahl eine Vorauswahl, z. B. „Letzte Woche". */
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

/** Je Tag des Zeitraums perDay Nachrichten, verteilt auf 9–16 Uhr. */
const perDay =
  (count) =>
  ({ fromDay, toDay }) => {
    const cells = [];
    let n = 0;
    for (let day = fromDay; day <= toDay; day = addDays(day, 1))
      for (let i = 0; i < count; i++)
        cells.push({ day, hour: 9 + (n++ % 8), messages: 1 });
    return cells;
  };

test(
  "Ansicht (AK-1): „Letzte 30 Tage“ – die Karte zeigt das Raster aus derselben Antwort wie Kennzahlen und Diagramm, ohne eigene Anfrage",
  { skip },
  async (t) => {
    const { startDate, endDate } = lastDaysRange(DEFAULT_RANGE_DAYS);
    const days = rangeFromDates(startDate, endDate);
    const server = await analyticsServer(t, perDay(10));
    const { container, document, act } = await mount(
      t,
      VIEW,
      { embedsLoaded: true, embeds: [EMBED] },
      { exportName: "AnalyticsScreen" }
    );

    // eine Anfrage an analytics/summary mit den gewählten Kalendertagen
    assert.deepEqual(server.summaries(), [
      {
        method: ROUTES.summary.method,
        url: server.summaryUrl,
        body: summaryBody(days.fromDay, days.toDay),
      },
    ]);
    assert.equal(
      cardOf(container).getAttribute("data-weekday-hour-card"),
      "data"
    );
    assert.equal(cellsOf(container).length, 168);

    // Die 168 Felder ergeben zusammen die Kennzahl „Nachrichten“ (AK-2).
    const [kpi] = elements(
      container,
      (element) => element.getAttribute("data-kpi") === "messages"
    );
    const total = cellsOf(container)
      .map((cell) =>
        Number(/: ([\d.]+) Nachricht/.exec(cell.getAttribute("aria-label"))[1])
      )
      .reduce((a, b) => a + b);
    assert.equal(total, 300);
    assert.ok(kpi.textContent.includes("300"), kpi.textContent);

    // Die Karte steht zwischen Diagramm und Liste.
    const sections = elements(
      container,
      (element) => element.tagName === "SECTION"
    );
    assert.equal(sections.length, 2);
    assert.equal(sections[1], cardOf(container));
    assert.equal(withAttribute(sections[0], "data-column").length, 30);

    // Der Tooltip der Karte und der des Diagramms stören einander nicht.
    const weekday = weekdayOf(days.toDay);
    await act(() => movePointer(document, cellAt(container, weekday, 9)));
    assert.match(tooltipOf(container), /, 9–10 Uhr: \d+ Nachrichten$/);
    await act(() =>
      movePointer(document, withAttribute(container, "data-column")[29])
    );
    assert.equal(tooltipOf(container), null);
  }
);

test(
  "Ansicht (AK-7, AK-8): Der Zustand folgt dem Zeitraum – „Letzte Woche“ ist zu kurz, 30 Tage mit 150 Nachrichten sind zu wenige, ohne Nachrichten ist die Karte leer",
  { skip },
  async (t) => {
    // „Letzte 30 Tage“: 150 Nachrichten (b); „Letzter Monat“: keine;
    // „Letzte 12 Monate“: genug; „Letzte Woche“: 7 Tage mit je 100 (a).
    const server = await analyticsServer(t, (body) => {
      const length =
        (Date.parse(body.toDay) - Date.parse(body.fromDay)) / 86400000 + 1;
      if (length === 30 && body.toDay === rangeFromDates(...today()).toDay)
        return perDay(5)(body);
      if (length === 7) return perDay(100)(body);
      if (length > 300) return perDay(1)(body);
      return [];
    });
    function today() {
      const { startDate, endDate } = lastDaysRange(DEFAULT_RANGE_DAYS);
      return [startDate, endDate];
    }
    const view = await mount(
      t,
      VIEW,
      { embedsLoaded: true, embeds: [EMBED] },
      { exportName: "AnalyticsScreen" }
    );
    const { container } = view;
    const stateOf = () =>
      cardOf(container).getAttribute("data-weekday-hour-card");
    const hintOf = () =>
      withAttribute(container, "data-heat-frame")[0]?.textContent ?? null;
    const assertNoGrid = () => {
      assert.equal(cellsOf(container).length, 0);
      assert.equal(withAttribute(container, "data-statement").length, 0);
      assert.equal(withAttribute(container, "data-heat-legend").length, 0);
    };

    // (b) 30 Tage mit 150 Nachrichten
    assert.equal(stateOf(), "few-messages");
    assert.equal(
      hintOf(),
      "Zu wenige Nachrichten für ein verlässliches Muster (mindestens 200)"
    );
    assertNoGrid();

    // (a) weniger als 28 Tage – auch mit 700 Nachrichten
    await choosePreset(view, "Letzte Woche");
    assert.equal(server.summaries().length, 2);
    assert.equal(stateOf(), "short-range");
    assert.equal(hintOf(), "Für diese Ansicht bitte mindestens 28 Tage wählen");
    assertNoGrid();

    // genug Tage und Nachrichten: Raster und Aussagen
    await choosePreset(view, "Letzte 12 Monate");
    assert.equal(stateOf(), "data");
    assert.equal(hintOf(), null);
    assert.equal(cellsOf(container).length, 168);
    assert.equal(withAttribute(container, "data-statement").length, 2);

    // Zeitraum ohne Nachrichten (AK-8)
    await choosePreset(view, "Letzter Monat");
    assert.equal(stateOf(), "empty");
    assert.equal(hintOf(), "Keine Nachrichten im gewählten Zeitraum");
    assertNoGrid();
  }
);

test(
  "Ansicht: je 100 Nachrichten 60 in der Kernzeit – die Karte nennt „40 % der Nachrichten“ (AK-4) und den stärksten Zeitabschnitt (AK-3)",
  { skip },
  async (t) => {
    // Die Woche aus AK-4, dreimal so stark – in jedem angefragten Zeitraum.
    await analyticsServer(t, () =>
      CORE_TIME_WEEK.cells.map((cell) => ({
        ...cell,
        messages: cell.messages * 3,
      }))
    );
    const { container } = await mount(
      t,
      VIEW,
      { embedsLoaded: true, embeds: [EMBED] },
      { exportName: "AnalyticsScreen" }
    );
    const [peak, outside] = withAttribute(container, "data-statement");
    assert.deepEqual(
      peak.childNodes.map((node) => node.textContent),
      ["Stärkster Zeitabschnitt", "Dienstag, 10–11 Uhr", "42 Nachrichten"]
    );
    assert.deepEqual(
      outside.childNodes.map((node) => node.textContent),
      [
        "Außerhalb von Montag–Freitag, 8–17 Uhr",
        "40 % der Nachrichten",
        "Feiertage zählen als normale Wochentage.",
      ]
    );
  }
);
