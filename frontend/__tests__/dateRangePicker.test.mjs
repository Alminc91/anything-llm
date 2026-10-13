// KIE-536: Datumsauswahl in schmalen Fenstern. Unter 640 px Fensterbreite
// zeigt das Popover einen Kalendermonat und richtet sich am Fenster aus; ab
// 640 px bleibt es, wie es war. Die Komponente ist mit React DOM in ein
// Dokument ohne Browser eingehängt (helpers/renderSettingsPage.mjs, mount).
//
// Ohne Browser gibt es kein Layout: Geprüft werden Struktur, Klassen und die
// berechnete Lage. Ob das Popover bei 390 px tatsächlich ganz im Fenster
// steht und die Seite nicht waagerecht scrollt, zeigt der Browser-Test.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import {
  createRenderer,
  hasFrontendDeps,
} from "./helpers/renderSettingsPage.mjs";
import { click, elements } from "./helpers/testDom.mjs";

const PICKER = "/src/components/DateRangePicker/index.jsx";
const skip = hasFrontendDeps
  ? false
  : "frontend/node_modules nicht installiert";
// Popover der Datumsauswahl auf master (vor KIE-536)
const WIDE_CLASS =
  "absolute right-0 top-full mt-2 z-50 bg-theme-bg-secondary border border-white/10 rounded-xl shadow-2xl p-4 min-w-[580px]";
// Ein eigener Zeitraum (Montag bis Freitag), der an keinem künftigen Tag einer
// Vorauswahl entspricht – die Beschriftungen hängen so nicht vom Datum ab.
const START = new Date(2026, 8, 14);
const END = new Date(2026, 8, 18, 23, 59, 59, 999);

let renderer;
before(async () => {
  if (hasFrontendDeps) renderer = await createRenderer();
});
after(async () => {
  await renderer?.close();
});

/**
 * Ein Fenster mit dieser Breite: matchMedia für die Schwelle 640 px, die
 * Breite des Dokuments und die resize-Ereignisse. resize(width) ändert sie.
 */
function windowOf(t, initialWidth) {
  const original = {
    matchMedia: window.matchMedia,
    addEventListener: window.addEventListener,
    removeEventListener: window.removeEventListener,
  };
  let width = initialWidth;
  const mediaListeners = new Set();
  const resizeListeners = new Set();
  const media = {
    get matches() {
      return width >= 640;
    },
    addEventListener: (_type, listener) => mediaListeners.add(listener),
    removeEventListener: (_type, listener) => mediaListeners.delete(listener),
  };
  window.matchMedia = (query) => {
    assert.equal(query, "(min-width: 640px)");
    return media;
  };
  window.addEventListener = (type, listener) => {
    if (type === "resize") resizeListeners.add(listener);
  };
  window.removeEventListener = (type, listener) => {
    if (type === "resize") resizeListeners.delete(listener);
  };
  t.after(() => {
    Object.assign(window, original);
    if (globalThis.document) delete document.documentElement.clientWidth;
  });
  return {
    /** Erst nach dem Einhängen gibt es das Dokument. */
    apply: () => {
      document.documentElement.clientWidth = width;
    },
    resize(next) {
      const crossed = width >= 640 !== next >= 640;
      width = next;
      document.documentElement.clientWidth = width;
      if (crossed) for (const listener of [...mediaListeners]) listener(media);
      for (const listener of [...resizeListeners]) listener();
    },
    listeners: () => mediaListeners.size + resizeListeners.size,
  };
}

/** Hängt die Datumsauswahl ein; der Auslöser steht anchorLeft px vom Fensterrand. */
async function mountPicker(t, { anchorLeft = 0, view = null } = {}) {
  const changes = [];
  const mounted = await renderer.mount(PICKER, {
    location: "/settings/chatbot/conversations",
    props: {
      startDate: START,
      endDate: END,
      onChange: (range) => changes.push(range),
    },
  });
  t.after(() => mounted.unmount());
  view?.apply();
  const { container } = mounted;
  const wrapper = container.firstChild;
  wrapper.getBoundingClientRect = () => ({ left: anchorLeft, width: 240 });
  const classOf = (element) => element.getAttribute("class") ?? "";
  const withClass = (name) =>
    elements(container, (element) =>
      classOf(element).split(/\s+/).includes(name)
    );
  return {
    ...mounted,
    changes,
    classOf,
    buttons: () =>
      elements(container, (element) => element.tagName === "BUTTON"),
    trigger: () => wrapper.firstChild,
    popover: () =>
      elements(container, (element) =>
        element.hasAttribute("data-date-popover")
      )[0] ?? null,
    months: () => withClass("rdp-month"),
    captions: () => withClass("rdp-caption_label").map((e) => e.textContent),
    calendar: () => withClass("rdp-theme-wrapper")[0],
  };
}

test(
  "Lage im schmalen Fenster: höchstens 320 px, nie breiter als der sichtbare Bereich abzüglich Rand, immer ganz darin",
  { skip },
  async () => {
    const { narrowPopoverPlacement } = await renderer.load(PICKER);
    const place = (anchorLeft, to, from = 0) =>
      narrowPopoverPlacement({ anchorLeft, from, to });

    // 390 px, Auslöser links (wie in der Ansicht „Konversationen“)
    assert.deepEqual(place(25, 390), { left: 0, width: 320 });
    // Auslöser weiter rechts: nach links gerückt, bis der rechte Rand passt
    assert.deepEqual(place(200, 390), { left: -138, width: 320 });
    // Auslöser am Fensterrand: 8 px Abstand
    assert.deepEqual(place(0, 390), { left: 8, width: 320 });
    // 320 px: so breit wie das Fenster abzüglich Rand
    assert.deepEqual(place(25, 320), { left: -17, width: 304 });
    // Der Rahmen der Seite hat rechts eine Scrollleiste (15 px) …
    assert.deepEqual(place(200, 375), { left: -153, width: 320 });
    // … oder beginnt erst neben einer Seitenleiste.
    assert.deepEqual(place(70, 600, 64), { left: 2, width: 320 });

    for (let from = 0; from <= 64; from += 64)
      for (let to = from + 240; to < 640; to += 7)
        for (let anchorLeft = -40; anchorLeft <= to; anchorLeft += 13) {
          const { left, width } = place(anchorLeft, to, from);
          const where = `sichtbar ${from}–${to} px, Auslöser bei ${anchorLeft} px`;
          assert.ok(width <= 320 && width <= to - from - 16, where);
          assert.ok(anchorLeft + left >= from + 8, where);
          assert.ok(anchorLeft + left + width <= to - 8, where);
        }
  }
);

for (const [name, width] of [
  ["ohne matchMedia", null],
  ["bei 640 px", 640],
  ["bei 1440 px", 1440],
]) {
  test(
    `Ab 640 px wie bisher (${name}): rechtsbündig, mindestens 580 px, zwei Kalendermonate – ohne eigene Lage`,
    { skip },
    async (t) => {
      const view = width === null ? null : windowOf(t, width);
      const picker = await mountPicker(t, { anchorLeft: 900, view });
      assert.equal(picker.trigger().textContent, "14.09.2026 - 18.09.2026");
      assert.equal(picker.popover(), null);

      await picker.act(() => click(picker.trigger()));
      const popover = picker.popover();
      assert.equal(picker.classOf(popover), WIDE_CLASS);
      assert.equal(popover.getAttribute("data-date-popover"), "wide");
      for (const property of ["left", "right", "width"])
        assert.equal(popover.style[property], undefined, property);
      assert.equal(picker.months().length, 2);
      assert.deepEqual(picker.captions(), ["August 2026", "September 2026"]);
      assert.equal(picker.classOf(picker.calendar()), "rdp-theme-wrapper");
    }
  );
}

test(
  "Unter 640 px (390 px): ein Kalendermonat, keine Mindestbreite, am Fenster ausgerichtet; Vorauswahlen über dem Kalender, „Anwenden“ darunter",
  { skip },
  async (t) => {
    const view = windowOf(t, 390);
    const picker = await mountPicker(t, { anchorLeft: 200, view });

    await picker.act(() => click(picker.trigger()));
    const popover = picker.popover();
    assert.equal(popover.getAttribute("data-date-popover"), "narrow");
    assert.doesNotMatch(picker.classOf(popover), /min-w-/);
    assert.match(picker.classOf(popover), /max-w-\[calc\(100vw-16px\)\]/);
    // 200 px + (−138 px) = 62 px vom linken Rand, 320 px breit: endet bei 382 px.
    assert.equal(popover.style.left, "-138px");
    assert.equal(popover.style.width, "320px");
    assert.equal(popover.style.right, "auto");

    assert.equal(picker.months().length, 1);
    // der Monat, in dem der Zeitraum beginnt
    assert.deepEqual(picker.captions(), ["September 2026"]);
    assert.match(picker.classOf(picker.calendar()), /flex justify-center/);

    // Reihenfolge im Popover: Vorauswahlen, Kalender, „Anwenden“
    const inPopover = elements(popover);
    const presets = picker.buttons()[1];
    assert.equal(presets.textContent, "Zeitraum wählen");
    const apply = picker.buttons().at(-1);
    assert.equal(apply.textContent, "Anwenden");
    assert.ok(
      inPopover.indexOf(presets) < inPopover.indexOf(picker.calendar())
    );
    assert.ok(inPopover.indexOf(picker.calendar()) < inPopover.indexOf(apply));

    // Die Vorauswahlen stehen als Liste im Popover und lassen sich wählen.
    await picker.act(() => click(presets));
    const options = elements(
      presets.parentNode.lastChild,
      (element) => element.tagName === "BUTTON"
    ).map((button) => button.textContent);
    assert.deepEqual(options, [
      "Heute",
      "Gestern",
      "Diese Woche",
      "Letzte Woche",
      "Letzte 30 Tage",
      "Dieser Monat",
      "Letzter Monat",
      "Letzte 12 Monate",
      "Gesamt",
    ]);
    const all = picker
      .buttons()
      .find((button) => button.textContent === "Gesamt");
    await picker.act(() => click(all));
    assert.deepEqual(picker.changes, [{ startDate: null, endDate: null }]);
    assert.equal(picker.popover(), null);
  }
);

test(
  "Unter 640 px: Die Lage folgt dem Fenster – 320 px, Größenänderung, über die Schwelle und zurück",
  { skip },
  async (t) => {
    const view = windowOf(t, 320);
    const picker = await mountPicker(t, { anchorLeft: 25, view });

    await picker.act(() => click(picker.trigger()));
    assert.equal(picker.popover().style.left, "-17px");
    assert.equal(picker.popover().style.width, "304px");
    assert.equal(picker.months().length, 1);

    await picker.act(() => view.resize(500));
    // linksbündig am Auslöser (React schreibt 0 ohne Einheit)
    assert.equal(picker.popover().style.left, "0");
    assert.equal(picker.popover().style.width, "320px");

    // über die Schwelle: wie bisher
    await picker.act(() => view.resize(800));
    assert.equal(picker.classOf(picker.popover()), WIDE_CLASS);
    assert.equal(picker.popover().style.width, "");
    assert.equal(picker.popover().style.left, "");
    assert.equal(picker.months().length, 2);

    // und zurück
    await picker.act(() => view.resize(390));
    assert.equal(picker.popover().style.width, "320px");
    assert.equal(picker.months().length, 1);

    // Der Rahmen der Seite scrollt und ist schmaler als das Fenster
    // (Scrollleiste): Das Popover richtet sich nach ihm.
    const frame = {
      parentElement: null,
      clientLeft: 0,
      clientWidth: 300,
      getBoundingClientRect: () => ({ left: 0 }),
    };
    picker.container.firstChild.parentElement = frame;
    window.getComputedStyle = () => ({ overflowX: "auto" });
    t.after(() => delete window.getComputedStyle);
    await picker.act(() => view.resize(330));
    assert.equal(picker.popover().style.left, "-17px");
    assert.equal(picker.popover().style.width, "284px");

    // Geschlossen lauscht nur noch die Schwelle.
    await picker.act(() => click(picker.trigger()));
    assert.equal(picker.popover(), null);
    assert.equal(view.listeners(), 1);
    await picker.unmount();
    assert.equal(view.listeners(), 0);
  }
);
