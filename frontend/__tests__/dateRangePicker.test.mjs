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
import { readFileSync } from "node:fs";
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

// ---------------------------------------------------------------------------
// Klassen und Farben
// ---------------------------------------------------------------------------
//
// Eine Klasse, für die Tailwind kein CSS erzeugt, bleibt im Browser ohne
// Wirkung – so stand „Anwenden" ohne Fläche da (bg-theme-button-primary gibt
// es in tailwind.config.js nicht): schwarze Schrift auf dem Popover, im
// dunklen Theme 1,22:1. Geprüft wird deshalb gegen das CSS, das Tailwind mit
// der Konfiguration des Projekts erzeugt, und gegen die Farbwerte der Themes
// in index.css.

const INDEX_CSS = new URL("../src/index.css", import.meta.url);
const escapeClass = (name) => name.replace(/[^a-zA-Z0-9_-]/g, "\\$&");

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

/** Deklarationen der Regel einer Klasse, z. B. { color: "…" }; leer = kein CSS. */
function declarationsOf(root, className) {
  const selector = `.${escapeClass(className)}`;
  // die Klasse selbst, nicht eine, die nur so beginnt (.flex / .flex-col)
  const names = (rule) =>
    rule.selectors.some((candidate) => {
      const at = candidate.indexOf(selector);
      return at >= 0 && !/[\w\\-]/.test(candidate[at + selector.length] ?? "");
    });
  const found = {};
  root.walkRules((rule) => {
    if (!names(rule)) return;
    rule.walkDecls((decl) => {
      found[decl.prop] = decl.value;
    });
  });
  return found;
}

/** index.css als PostCSS-Baum und die Farbwerte beider Themes. */
async function themes() {
  const { default: postcss } = await import("postcss");
  const root = postcss.parse(readFileSync(INDEX_CSS, "utf8"));
  const dark = {};
  const light = {};
  root.walkRules((rule) => {
    const tokens =
      rule.selector === ":root"
        ? dark
        : rule.selector === '[data-theme="light"]'
          ? light
          : null;
    if (!tokens) return;
    rule.walkDecls(/^--/, (decl) => {
      tokens[decl.prop] = decl.value;
    });
  });
  return { root, dark, light: { ...dark, ...light } };
}

/** "#46c8ff" oder Tailwinds "rgb(0 0 0 / var(--tw-text-opacity))" als [r, g, b]. */
function rgbOf(value) {
  const hex = value.match(/^#([0-9a-f]{6})$/i);
  if (hex) return [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16));
  const rgb = value.match(
    /^rgb\((\d+) (\d+) (\d+) \/ var\(--tw-[a-z]+-opacity\)\)$/
  );
  assert.ok(rgb, `Farbe nicht lesbar: ${value}`);
  return rgb.slice(1).map(Number);
}

/** Kontrastverhältnis nach WCAG 2.x */
function contrast(a, b) {
  const luminance = (rgb) => {
    const [r, g, b] = rgb
      .map((channel) => channel / 255)
      .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
}

test(
  "Jede Klasse der Datumsauswahl gibt es: Tailwind erzeugt mit der Konfiguration des Projekts CSS dafür – breit und schmal, Vorauswahlen aufgeklappt",
  { skip },
  async (t) => {
    const used = new Set();
    for (const width of [1440, 390]) {
      const view = windowOf(t, width);
      const picker = await mountPicker(t, { anchorLeft: 25, view });
      await picker.act(() => click(picker.trigger()));
      await picker.act(() => click(picker.buttons()[1]));
      assert.equal(picker.buttons().at(-1).textContent, "Anwenden");

      // Der Kalender selbst bringt sein Stylesheet mit (react-day-picker).
      const calendar = new Set(elements(picker.calendar()));
      for (const element of elements(picker.container))
        if (!calendar.has(element))
          for (const name of picker.classOf(element).split(/\s+/))
            if (name) used.add(name);
      await picker.unmount();
    }
    for (const expected of ["min-w-[580px]", "max-w-[calc(100vw-16px)]"])
      assert.ok(used.has(expected), expected);

    // Der Rahmen um den Kalender steht in index.css, alles andere ist Tailwind.
    assert.ok(used.delete("rdp-theme-wrapper"));
    assert.match(readFileSync(INDEX_CSS, "utf8"), /\.rdp-theme-wrapper /);
    const css = await tailwindCss([...used]);
    const missing = [...used].filter(
      (name) => Object.keys(declarationsOf(css, name)).length === 0
    );
    assert.deepEqual(missing, [], "Klassen ohne CSS");
  }
);

test(
  "„Anwenden“ ist eine primäre Schaltfläche: Fläche in --theme-button-primary, Schrift darauf mit mindestens 4,5:1 – im dunklen und im hellen Theme",
  { skip },
  async (t) => {
    const picker = await mountPicker(t, { view: windowOf(t, 1440) });
    await picker.act(() => click(picker.trigger()));
    const apply = picker.buttons().at(-1);
    assert.equal(apply.textContent, "Anwenden");

    // Grundzustand: Klassen ohne Variante (hover:, disabled:)
    const classes = picker
      .classOf(apply)
      .split(/\s+/)
      .filter((name) => name && !name.includes(":"));
    const css = await tailwindCss(classes);
    const style = Object.assign(
      {},
      ...classes.map((name) => declarationsOf(css, name))
    );
    // wie die übrigen primären Schaltflächen (bg-primary-button)
    assert.equal(style["background-color"], "var(--theme-button-primary)");
    assert.ok(style.color, "keine Schriftfarbe");

    const { root, dark, light } = await themes();
    // Kein Theme färbt Schrift oder Fläche dieser Klassen in index.css um
    // (wie es für .text-white im hellen Theme geschieht).
    const colouring = classes.filter((name) => {
      const declarations = declarationsOf(css, name);
      return "color" in declarations || "background-color" in declarations;
    });
    root.walkRules((rule) => {
      for (const name of colouring)
        assert.ok(
          !rule.selector.split(/[\s,>+~]+/).includes(`.${escapeClass(name)}`),
          `${rule.selector} überschreibt .${name}`
        );
    });
    assert.deepEqual(colouring, ["bg-primary-button", "text-black"]);

    // Dunkel: Schwarz auf #46c8ff = 10,97:1; hell: Schwarz auf #0ba5ec = 7,61:1
    // (Weiß erreichte nur 1,91:1 bzw. 2,76:1).
    const text = rgbOf(style.color);
    for (const [theme, tokens] of [
      ["dunkel", dark],
      ["hell", light],
    ]) {
      const surface = rgbOf(tokens["--theme-button-primary"]);
      const ratio = contrast(text, surface);
      assert.ok(
        ratio >= 4.5,
        `${theme}: ${ratio.toFixed(2)}:1 auf ${tokens["--theme-button-primary"]}`
      );
    }
  }
);
