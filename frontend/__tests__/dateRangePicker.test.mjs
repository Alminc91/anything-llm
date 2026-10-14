// KIE-536: Datumsauswahl bei wenig Platz. Über das Layout des Popovers
// entscheidet der Bereich, in dem es zu sehen ist – das Fenster, eingeengt
// durch scrollende oder beschneidende Vorfahren (neben der Einstellungs-Sidebar
// bleibt nur der Inhaltsbereich): Passt das breite Popover (zwei
// Kalendermonate, 580 px) mit 8 px Rand hinein, bleibt es, wie es war; sonst
// zeigt es einen Kalendermonat und richtet sich am sichtbaren Bereich aus. Die
// Komponente ist mit React DOM in ein Dokument ohne Browser eingehängt
// (helpers/renderSettingsPage.mjs, mount).
//
// Ohne Browser gibt es kein Layout: Geprüft werden Struktur, Klassen und die
// berechnete Lage; Fensterbreite, Lage des Auslösers und der Rahmen der Seite
// sind vorgegeben. Ob das Popover tatsächlich ganz zu sehen ist und die Seite
// nicht waagerecht scrollt, zeigt der Browser-Test.
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
// Breite des Auslösers
const TRIGGER_WIDTH = 240;
// Die Einstellungs-Sidebar: Der Rahmen der Seite beginnt rechts von ihr.
const SIDEBAR = 290;
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
 * Ein Fenster mit dieser Breite: die Breite des Dokuments und die
 * resize-Ereignisse. resize(width) ändert sie. matchMedia gibt es nicht –
 * die Fensterbreite allein entscheidet nichts.
 */
function windowOf(t, initialWidth) {
  const original = {
    addEventListener: window.addEventListener,
    removeEventListener: window.removeEventListener,
  };
  assert.equal(window.matchMedia, undefined);
  let width = initialWidth;
  const resizeListeners = new Set();
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
      width = next;
      document.documentElement.clientWidth = width;
      for (const listener of [...resizeListeners]) listener();
    },
    listeners: () => resizeListeners.size,
  };
}

/**
 * Hängt die Datumsauswahl ein; der Auslöser (240 px breit) steht anchorLeft px
 * vom Fensterrand. frame: der Rahmen der Seite, { left, width } – er scrollt,
 * nur was in ihm liegt, ist zu sehen (wie neben der Einstellungs-Sidebar).
 * anchor und frame lassen sich danach ändern (mit dem Fenster wandern sie).
 */
async function mountPicker(
  t,
  { anchorLeft = 0, view = null, frame, startDate = START, endDate = END } = {}
) {
  const changes = [];
  const mounted = await renderer.mount(PICKER, {
    location: "/settings/chatbot/conversations",
    props: {
      startDate,
      endDate,
      onChange: (range) => changes.push(range),
    },
  });
  t.after(() => mounted.unmount());
  view?.apply();
  const { container } = mounted;
  const wrapper = container.firstChild;
  const anchor = { left: anchorLeft };
  wrapper.getBoundingClientRect = () => ({
    left: anchor.left,
    right: anchor.left + TRIGGER_WIDTH,
    width: TRIGGER_WIDTH,
  });
  if (frame) {
    wrapper.parentElement = {
      parentElement: null,
      clientLeft: 0,
      get clientWidth() {
        return frame.width;
      },
      getBoundingClientRect: () => ({ left: frame.left }),
    };
    window.getComputedStyle = () => ({ overflowX: "auto" });
    t.after(() => delete window.getComputedStyle);
  }
  const classOf = (element) => element.getAttribute("class") ?? "";
  const withClass = (name) =>
    elements(container, (element) =>
      classOf(element).split(/\s+/).includes(name)
    );
  return {
    ...mounted,
    changes,
    anchor,
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

/** Das breite Popover, wie es auf master war: Klassen, zwei Monate. */
function assertWide(picker) {
  const popover = picker.popover();
  assert.equal(picker.classOf(popover), WIDE_CLASS);
  assert.equal(popover.getAttribute("data-date-popover"), "wide");
  for (const property of ["left", "width"])
    assert.equal(popover.style[property] ?? "", "", property);
  assert.equal(picker.months().length, 2);
  assert.deepEqual(picker.captions(), ["August 2026", "September 2026"]);
  assert.equal(picker.classOf(picker.calendar()), "rdp-theme-wrapper");
}

/** Das schmale Popover: ein Monat, keine Mindestbreite, eigene Lage. */
function assertNarrow(picker, { left, width }) {
  const popover = picker.popover();
  assert.equal(popover.getAttribute("data-date-popover"), "narrow");
  assert.doesNotMatch(picker.classOf(popover), /min-w-/);
  assert.match(picker.classOf(popover), /max-w-\[calc\(100vw-16px\)\]/);
  assert.equal(popover.style.left, left);
  assert.equal(popover.style.width, width);
  assert.equal(popover.style.right, "auto");
  assert.equal(picker.months().length, 1);
  assert.match(picker.classOf(picker.calendar()), /flex justify-center/);
}

test(
  "Lage des schmalen Popovers: höchstens 320 px, nie breiter als der sichtbare Bereich abzüglich Rand, immer ganz darin",
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

test(
  "Breit oder schmal entscheidet der sichtbare Bereich: breit, wenn 580 px mit 8 px Rand hineinpassen – sonst schmal",
  { skip },
  async () => {
    const { popoverLayout } = await renderer.load(PICKER);
    const layout = (anchorLeft, from, to) =>
      popoverLayout({
        anchorLeft,
        anchorRight: anchorLeft + TRIGGER_WIDTH,
        from,
        to,
      });
    const wide = { narrow: false, style: undefined };

    // Fenster 640 px mit Sidebar: 350 px sichtbar – schmal, ganz im Bereich
    // (312–632 px)
    assert.deepEqual(layout(315, SIDEBAR, 640), {
      narrow: true,
      style: { left: -3, width: 320, right: "auto" },
    });
    // Fenster 1440 px mit Sidebar: 1130 px sichtbar, Auslöser rechts – wie bisher
    assert.deepEqual(layout(1160, SIDEBAR, 1420), wide);
    // Fenster 900 px mit Sidebar: 610 px sichtbar. Auslöser rechts im Bereich:
    // Das Popover (300–880 px) passt gerade, wie bisher.
    assert.deepEqual(layout(640, SIDEBAR, 900), wide);
    // 20 px weiter links ragte es links hinaus (280 px): nach rechts gerückt,
    // bis der Rand von 8 px stimmt (298–878 px).
    assert.deepEqual(layout(620, SIDEBAR, 900), {
      narrow: false,
      style: { right: -18 },
    });
    // 580 px sichtbar: Mit Rand passt es nicht mehr.
    assert.deepEqual(layout(630, SIDEBAR, 870), {
      narrow: true,
      style: { left: -88, width: 320, right: "auto" },
    });
    // Die Grenze: 580 px und zweimal 8 px Rand
    assert.equal(layout(300, 0, 596).narrow, false);
    assert.equal(layout(300, 0, 595).narrow, true);
    // Ohne Sidebar entscheidet dieselbe Regel (640 px: breit, 390 px: schmal).
    assert.equal(layout(392, 0, 640).narrow, false);
    assert.equal(layout(25, 0, 390).narrow, true);
    // Ohne messbaren Bereich (kein Layout): wie bisher
    assert.deepEqual(
      popoverLayout({
        anchorLeft: 0,
        anchorRight: undefined,
        from: 0,
        to: undefined,
      }),
      wide
    );

    for (const from of [0, 64, SIDEBAR])
      for (let available = 240; available <= 1200; available += 7)
        for (
          let anchorLeft = from;
          anchorLeft <= from + available - TRIGGER_WIDTH;
          anchorLeft += 13
        ) {
          const to = from + available;
          const where = `sichtbar ${from}–${to} px, Auslöser bei ${anchorLeft} px`;
          const { narrow, style } = layout(anchorLeft, from, to);
          assert.equal(narrow, available < 596, where);
          // linke und rechte Kante des Popovers im Fenster
          const right = narrow
            ? anchorLeft + style.left + style.width
            : anchorLeft + TRIGGER_WIDTH - (style?.right ?? 0);
          const left = narrow ? anchorLeft + style.left : right - 580;
          assert.ok(left >= from + 8, where);
          // Am Auslöser rechtsbündig steht es, wo der Auslöser steht.
          assert.ok(right <= (narrow || style ? to - 8 : to), where);
          if (!narrow && style) assert.equal(left, from + 8, where);
        }
  }
);

for (const [name, { width, anchorLeft, frame }] of [
  ["ohne messbare Fensterbreite", { width: null, anchorLeft: 900 }],
  [
    "Fenster 1440 px mit Sidebar, 1130 px sichtbar",
    { width: 1440, anchorLeft: 1160, frame: { left: SIDEBAR, width: 1130 } },
  ],
  [
    "Fenster 900 px mit Sidebar, 610 px sichtbar – das Popover passt gerade",
    { width: 900, anchorLeft: 640, frame: { left: SIDEBAR, width: 610 } },
  ],
  ["Fenster 640 px ohne Sidebar", { width: 640, anchorLeft: 392 }],
]) {
  test(
    `Passt das breite Popover in den sichtbaren Bereich, bleibt es wie bisher (${name}): rechtsbündig, mindestens 580 px, zwei Kalendermonate – ohne eigene Lage`,
    { skip },
    async (t) => {
      const view = width === null ? null : windowOf(t, width);
      const picker = await mountPicker(t, { anchorLeft, view, frame });
      assert.equal(picker.trigger().textContent, "14.09.2026 - 18.09.2026");
      assert.equal(picker.popover(), null);

      await picker.act(() => click(picker.trigger()));
      assertWide(picker);
      assert.equal(picker.popover().style.right, undefined);
    }
  );
}

test(
  "Fenster 640 px mit offener Sidebar (350 px sichtbar): schmal – ein Kalendermonat, ganz im sichtbaren Bereich statt unter der Sidebar",
  { skip },
  async (t) => {
    const view = windowOf(t, 640);
    const picker = await mountPicker(t, {
      anchorLeft: 315,
      view,
      frame: { left: SIDEBAR, width: 350 },
    });

    await picker.act(() => click(picker.trigger()));
    // 315 px − 3 px = 312 px vom linken Rand, 320 px breit: endet bei 632 px.
    assertNarrow(picker, { left: "-3px", width: "320px" });
    assert.deepEqual(picker.captions(), ["September 2026"]);
  }
);

test(
  "580 px sichtbar: Mit 8 px Rand passt das breite Popover nicht – schmal",
  { skip },
  async (t) => {
    const view = windowOf(t, 870);
    const picker = await mountPicker(t, {
      anchorLeft: 630,
      view,
      frame: { left: SIDEBAR, width: 580 },
    });

    await picker.act(() => click(picker.trigger()));
    // 630 px − 88 px = 542 px, 320 px breit: endet bei 862 px.
    assertNarrow(picker, { left: "-88px", width: "320px" });
  }
);

test(
  "Fenster 900 px mit Sidebar, Auslöser weiter links: Das breite Popover rückt in den sichtbaren Bereich, statt unter der Sidebar zu liegen",
  { skip },
  async (t) => {
    const view = windowOf(t, 900);
    const picker = await mountPicker(t, {
      anchorLeft: 315,
      view,
      frame: { left: SIDEBAR, width: 610 },
    });

    await picker.act(() => click(picker.trigger()));
    // Rechtsbündig am Auslöser (555 px) begänne es bei −25 px; 323 px nach
    // rechts gerückt steht es bei 298–878 px.
    assertWide(picker);
    assert.equal(picker.popover().style.right, "-323px");
  }
);

test(
  "Fenster 390 px: ein Kalendermonat, keine Mindestbreite, am Fenster ausgerichtet; Vorauswahlen über dem Kalender, „Anwenden“ darunter",
  { skip },
  async (t) => {
    const view = windowOf(t, 390);
    const picker = await mountPicker(t, { anchorLeft: 200, view });

    await picker.act(() => click(picker.trigger()));
    const popover = picker.popover();
    // 200 px + (−138 px) = 62 px vom linken Rand, 320 px breit: endet bei 382 px.
    assertNarrow(picker, { left: "-138px", width: "320px" });
    // der Monat, in dem der Zeitraum beginnt
    assert.deepEqual(picker.captions(), ["September 2026"]);

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
  "Layout und Lage folgen dem sichtbaren Bereich – beim Öffnen und bei jeder Größenänderung: Fenster, Rahmen der Seite, breit und zurück",
  { skip },
  async (t) => {
    const view = windowOf(t, 320);
    const frame = { left: 0, width: 320 };
    const picker = await mountPicker(t, { anchorLeft: 25, view, frame });
    const resize = (width, frameWidth = width - frame.left) =>
      picker.act(() => {
        frame.width = frameWidth;
        view.resize(width);
      });
    // Geschlossen lauscht nichts.
    assert.equal(view.listeners(), 0);

    await picker.act(() => click(picker.trigger()));
    assert.equal(view.listeners(), 1);
    assertNarrow(picker, { left: "-17px", width: "304px" });

    await resize(500);
    // linksbündig am Auslöser (React schreibt 0 ohne Einheit)
    assertNarrow(picker, { left: "0", width: "320px" });
    assert.deepEqual(picker.captions(), ["September 2026"]);

    // Das Fenster ist breit genug, der Rahmen der Seite (Scrollleiste) lässt
    // aber nur 595 px: weiter schmal.
    await resize(610, 595);
    assertNarrow(picker, { left: "0", width: "320px" });

    // 596 px: breit – mit den Monaten, die es frisch geöffnet zeigt (nicht
    // September und der noch gesperrte Oktober). Rechtsbündig am Auslöser
    // (265 px) ragte es links hinaus: Es rückt in den sichtbaren Bereich
    // (8–588 px).
    await resize(611, 596);
    assertWide(picker);
    assert.equal(picker.popover().style.right, "-323px");

    // Mit dem Fenster wandert der Auslöser nach rechts: wie bisher.
    picker.anchor.left = 1160;
    await resize(1440);
    assertWide(picker);
    assert.equal(picker.popover().style.right, "");

    // Die Sidebar nimmt dem Rahmen den Platz (Fenster 640 px, 350 px sichtbar).
    frame.left = SIDEBAR;
    picker.anchor.left = 315;
    await resize(640);
    assertNarrow(picker, { left: "-3px", width: "320px" });
    assert.deepEqual(picker.captions(), ["September 2026"]);

    // Geschlossen und wieder geöffnet wird neu vermessen.
    await picker.act(() => click(picker.trigger()));
    assert.equal(picker.popover(), null);
    assert.equal(view.listeners(), 0);
    frame.left = 0;
    frame.width = 1440;
    view.resize(1440);
    picker.anchor.left = 1160;
    await picker.act(() => click(picker.trigger()));
    assertWide(picker);
    assert.equal(picker.popover().style.right, undefined);
    assert.deepEqual(picker.captions(), ["August 2026", "September 2026"]);

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

test(
  "Fixliste 7, B6: Beim Öffnen steht rechts der Monat, in dem der Zeitraum endet – „Letzte 30 Tage“ bis zum 14.10. zeigt September/Oktober (vorher August/September); schmal der Monat des Endes",
  { skip },
  async (t) => {
    const startDate = new Date(2026, 8, 15);
    const endDate = new Date(2026, 9, 14, 23, 59, 59, 999);
    const wide = windowOf(t, 1440);
    const picker = await mountPicker(t, {
      anchorLeft: 1160,
      view: wide,
      startDate,
      endDate,
    });
    await picker.act(() => click(picker.trigger()));
    assert.deepEqual(picker.captions(), ["September 2026", "Oktober 2026"]);
    await picker.unmount();

    const narrow = windowOf(t, 390);
    const small = await mountPicker(t, {
      anchorLeft: 200,
      view: narrow,
      startDate,
      endDate,
    });
    await small.act(() => click(small.trigger()));
    assert.deepEqual(small.captions(), ["Oktober 2026"]);
  }
);
