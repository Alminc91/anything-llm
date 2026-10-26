// KIE-576 Paket 3, AK-K10 (Nutzer 26.10.2026): In der Vorschau des Design
// Centers öffnet das ⓘ neben der Kursanzahl dieselbe Info-Karte wie im
// Widget: gleiche Zeilen, gleicher Wortlaut (Bezeichnung, Einzahl und
// Mehrzahl, 5-%-Hinweis, Stand), Schließen per Klick daneben und Escape
// (Fokus zurück auf den Button). D-K8: mit gültigem Kursbestand dessen Werte,
// sonst Beispielwerte (837 Kurse, 12 ausgeblendet, keine fehlenden, Stand
// jetzt) mit dem Zusatz „Beispiel“ im Kopf und in der Karte.
//
// Wortlaut: courseCountCard.js gegen courseCountTexts der Vertrags-Fixture,
// die auch das Widget prüft (tests/embed-config-contract.test.js).
// Darstellung mit eingehängter Vorschau (helpers/renderSettingsPage.mjs).
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  createRenderer,
  hasFrontendDeps,
} from "./helpers/renderSettingsPage.mjs";
import { click, elements, pressKey } from "./helpers/testDom.mjs";
import { fixClock } from "./helpers/fixedClock.mjs";
import * as card from "../src/pages/GeneralSettings/ChatEmbedWidgets/EmbedAppearance/courseCountCard.js";
import * as keys from "../src/pages/GeneralSettings/ChatEmbedWidgets/EmbedAppearance/widgetKeys.js";

const PREVIEW =
  "/src/pages/GeneralSettings/ChatEmbedWidgets/EmbedAppearance/WidgetPreview.jsx";
const skip = hasFrontendDeps
  ? false
  : "frontend/node_modules nicht installiert";

const require = createRequire(import.meta.url);
const {
  embedDefaultTexts,
} = require("../../server/utils/chats/embedDefaults.js");
const DEFAULTS = embedDefaultTexts("de");
const CONTRACT = require("../../server/__tests__/utils/chats/fixtures/embedConfigContract.json");
const { now: CONTRACT_NOW, cases: CASES } = CONTRACT.courseCountTexts;

const INVENTORY = {
  count: 812,
  offered: 837,
  hidden: 14,
  stand: "2026-10-24T08:00:00.000Z",
};
const NOW = "2026-10-24T10:30:00.000Z";
const REAL_LINES = [
  "812 Kurse im KI-Berater",
  "Enthalten sind die aktuellen Kurse aus unserem Kursprogramm.",
  "14 Kurse sind ausgeblendet, da sie voraussichtlich beendet sind.",
  "Zurzeit fehlen 25 Kurse.",
  "Stand: heute, 10:00 Uhr, stündlich aktualisiert. Verbindlich ist das Kursprogramm auf unserer Webseite.",
];
// Beispielwerte (D-K8); Stand jetzt: 10:30 UTC = 12:30 Uhr in Berlin
const SAMPLE_LINES = [
  "837 Kurse im KI-Berater",
  "Enthalten sind die aktuellen Kurse aus unserem Kursprogramm.",
  "12 Kurse sind ausgeblendet, da sie voraussichtlich beendet sind.",
  "Stand: heute, 12:30 Uhr, stündlich aktualisiert. Verbindlich ist das Kursprogramm auf unserer Webseite.",
];

// ---------------------------------------------------------------------------
// Wortlaut gegen die Vertrags-Fixture
// ---------------------------------------------------------------------------

test("Fixture courseCountTexts: jeder Fall wortgleich aus courseCountCard.js", () => {
  assert.ok(CASES.length >= 9);
  for (const c of CASES) {
    const texts = card.courseCountCardTexts(
      c.courseCount,
      c.language,
      Date.parse(CONTRACT_NOW)
    );
    assert.deepEqual(card.courseCountCardLines(texts), c.lines, c.name);
  }
});

test("Fixture: Vorschau-Logik (previewCourseCount) erzeugt die deutschen Fälle wortgleich", () => {
  for (const c of CASES.filter((x) => x.language === "de")) {
    const { word, ...inventory } = c.courseCount;
    const preview = keys.previewCourseCount(
      word === "Kurse" ? {} : { courseCountWord: word },
      inventory,
      Date.parse(CONTRACT_NOW)
    );
    assert.equal(preview.sample, false, c.name);
    assert.deepEqual(card.courseCountCardLines(preview.texts), c.lines, c.name);
  }
});

test("Texte: keine Gedankenstriche, Bedientexte wie im Widget", () => {
  for (const lang of ["de", "en"]) {
    const t = card.COURSE_COUNT_TEXTS[lang];
    const all = [
      t.word,
      t.lead,
      t.info,
      t.dialog,
      t.head("1", "x"),
      t.scope("x"),
      t.hidden("2", "x"),
      t.hiddenOne,
      t.missing("2", "x"),
      t.missingOne,
      t.gap,
      t.stand("heute, 10:00 Uhr"),
    ];
    for (const line of all) assert.doesNotMatch(line, /[–—]/, line);
  }
  assert.equal(card.COURSE_COUNT_TEXTS.de.info, "Was bedeutet die Zahl?");
  assert.equal(card.COURSE_COUNT_TEXTS.de.dialog, "Info zur Kursanzahl");
  assert.equal(card.COURSE_COUNT_TEXTS.de.word, keys.DEFAULT_COURSE_COUNT_WORD);
});

test("Stand: gestern und Datum in Europe/Berlin", () => {
  const now = Date.parse("2026-10-24T10:30:00.000Z");
  assert.equal(
    card.courseStandText("2026-10-23T08:00:00.000Z", "de", now),
    "gestern, 10:00 Uhr"
  );
  assert.equal(
    card.courseStandText("2026-10-21T22:30:00.000Z", "de", now),
    "22.10., 00:30 Uhr"
  );
});

// ---------------------------------------------------------------------------
// Werte (D-K8)
// ---------------------------------------------------------------------------

test("D-K8: echte Werte des Kursbestands, eigene Bezeichnung in der Mehrzahl", () => {
  const now = Date.parse(NOW);
  const real = keys.previewCourseCount({}, INVENTORY, now);
  assert.equal(real.sample, false);
  assert.deepEqual(card.courseCountCardLines(real.texts), REAL_LINES);
  const own = keys.previewCourseCount(
    { courseCountWord: "Seminare" },
    { ...INVENTORY, hidden: 1, offered: 813 },
    now
  );
  assert.deepEqual(card.courseCountCardLines(own.texts).slice(2, 4), [
    "1 Seminare sind ausgeblendet, da sie voraussichtlich beendet sind.",
    "Zurzeit fehlen 1 Seminare.",
  ]);
  // Lücke ab 5 %: Hinweis auf die Kurssuche
  const gap = keys.previewCourseCount(
    {},
    { ...INVENTORY, count: 790, hidden: 0 },
    now
  );
  assert.deepEqual(card.courseCountCardLines(gap.texts).slice(2, 4), [
    "Zurzeit fehlen 47 Kurse.",
    "Für eine vollständige Suche nutzen Sie bitte die Kurssuche auf unserer Webseite.",
  ]);
  // älterer Server ohne hidden: keine Zeile zu ausgeblendeten Kursen
  const { hidden, ...older } = INVENTORY;
  assert.equal(hidden, 14);
  assert.equal(keys.previewCourseCount({}, older, now).texts.hiddenLine, null);
});

test("D-K8: ohne gültigen Kursbestand Beispielwerte, Stand jetzt", () => {
  const now = Date.parse(NOW);
  for (const inventory of [
    null,
    { ...INVENTORY, count: 0 },
    { count: "812" },
  ]) {
    const sample = keys.previewCourseCount({}, inventory, now);
    assert.equal(sample.sample, true);
    assert.equal(sample.text, "aktuell 837 Kurse");
    assert.deepEqual(card.courseCountCardLines(sample.texts), SAMPLE_LINES);
  }
  assert.equal(
    keys.previewCourseCount({ courseCountWord: "Seminare" }, null, now).texts
      .head,
    "837 Seminare im KI-Berater"
  );
});

// ---------------------------------------------------------------------------
// Darstellung: Öffnen, Schließen, Escape
// ---------------------------------------------------------------------------

let renderer;
before(async () => {
  if (hasFrontendDeps) renderer = await createRenderer();
});
after(async () => {
  await renderer?.close();
});

const byPreview = (root, name) =>
  elements(root, (el) => el.getAttribute?.("data-preview") === name);

// Vorschau eingehängt; Listener am Dokument (Klick daneben) werden
// mitgeschrieben, weil das Test-Dokument keine Ereignisse auslöst
async function mountPreview(t, config, courseInventory) {
  const mounted = await renderer.mount(PREVIEW, {
    location: "/",
    props: {
      config,
      logoPreview: null,
      defaults: DEFAULTS,
      greetingKey: "greeting",
      courseInventory,
    },
  });
  t.after(() => mounted.unmount());
  const { document } = mounted;
  const listeners = [];
  const add = document.addEventListener;
  const remove = document.removeEventListener;
  document.addEventListener = (type, fn) => listeners.push({ type, fn });
  document.removeEventListener = (type, fn) => {
    const i = listeners.findIndex((l) => l.type === type && l.fn === fn);
    if (i >= 0) listeners.splice(i, 1);
  };
  t.after(() => {
    document.addEventListener = add;
    document.removeEventListener = remove;
  });
  const mousedown = (target) =>
    mounted.act(() => {
      for (const l of listeners.filter((x) => x.type === "mousedown"))
        l.fn({ target });
    });
  return { ...mounted, listeners, mousedown };
}

const cardLines = (el) =>
  el.childNodes
    .filter(
      (c) =>
        c.nodeType === 1 &&
        !String(c.getAttribute("data-preview") || "").startsWith(
          "course-count-card-sample"
        )
    )
    .map((c) => c.textContent);

for (const displayMode of [undefined, "inline"]) {
  const label = displayMode === "inline" ? "In der Seite" : "Chatfenster";

  test(
    `${label}: ⓘ öffnet die Info-Karte mit den echten Werten, Klick daneben schließt`,
    { skip },
    async (t) => {
      fixClock(t, NOW);
      const { container, document, act, mousedown, listeners } =
        await mountPreview(t, { displayMode }, INVENTORY);
      const [button] = byPreview(container, "course-count-button");
      assert.ok(button, "Info-Button fehlt");
      assert.equal(button.getAttribute("type"), "button");
      assert.equal(button.getAttribute("aria-label"), "Was bedeutet die Zahl?");
      assert.equal(button.getAttribute("aria-expanded"), "false");
      assert.equal(byPreview(container, "course-count-card").length, 0);
      assert.equal(
        byPreview(container, "header-course-count-sample").length,
        0
      );

      await act(() => click(button));
      const [cardEl] = byPreview(container, "course-count-card");
      assert.ok(cardEl, "Karte fehlt nach Klick");
      assert.equal(cardEl.getAttribute("role"), "dialog");
      assert.equal(cardEl.getAttribute("aria-label"), "Info zur Kursanzahl");
      assert.equal(button.getAttribute("aria-expanded"), "true");
      assert.equal(
        button.getAttribute("aria-controls"),
        cardEl.getAttribute("id")
      );
      assert.equal(document.activeElement, cardEl);
      assert.deepEqual(cardLines(cardEl), REAL_LINES);
      assert.equal(byPreview(cardEl, "course-count-card-sample").length, 0);

      // Klick in die Karte lässt sie offen, Klick daneben schließt
      await mousedown(cardEl.childNodes[0]);
      assert.equal(byPreview(container, "course-count-card").length, 1);
      const [name] = byPreview(container, "header-name");
      await mousedown(name);
      assert.equal(byPreview(container, "course-count-card").length, 0);
      assert.equal(button.getAttribute("aria-expanded"), "false");
      assert.equal(listeners.length, 0, "Listener nach dem Schließen entfernt");

      // erneuter Klick auf ⓘ öffnet und schließt
      await act(() => click(button));
      assert.equal(byPreview(container, "course-count-card").length, 1);
      await act(() => click(button));
      assert.equal(byPreview(container, "course-count-card").length, 0);
    }
  );

  test(
    `${label}: Escape schließt die Karte, der Fokus kehrt auf den Button zurück`,
    { skip },
    async (t) => {
      fixClock(t, NOW);
      const { container, document, act } = await mountPreview(
        t,
        { displayMode },
        INVENTORY
      );
      const [button] = byPreview(container, "course-count-button");
      await act(() => click(button));
      assert.equal(
        document.activeElement,
        byPreview(container, "course-count-card")[0]
      );
      await act(() => pressKey(document, "Escape"));
      assert.equal(byPreview(container, "course-count-card").length, 0);
      assert.equal(document.activeElement, button);
      // andere Tasten lassen die Karte offen
      await act(() => click(button));
      await act(() => pressKey(document, "Enter"));
      assert.equal(byPreview(container, "course-count-card").length, 1);
    }
  );

  test(
    `${label}: ohne Kursbestand Beispielwerte mit dem Zusatz „Beispiel“ in Kopf und Karte`,
    { skip },
    async (t) => {
      fixClock(t, NOW);
      const { container, act } = await mountPreview(
        t,
        { displayMode, courseCountWord: "Kurse" },
        null
      );
      const [count] = byPreview(container, "header-course-count");
      assert.equal(count.getAttribute("data-sample"), "true");
      assert.equal(
        byPreview(container, "header-course-count-sample")[0]?.textContent,
        "Beispiel"
      );
      await act(() => click(byPreview(container, "course-count-button")[0]));
      const [cardEl] = byPreview(container, "course-count-card");
      assert.deepEqual(cardLines(cardEl), SAMPLE_LINES);
      assert.equal(
        byPreview(cardEl, "course-count-card-sample")[0]?.textContent,
        "Beispiel"
      );
      assert.equal(
        byPreview(cardEl, "course-count-card-sample-hint")[0]?.textContent,
        "Die Zahl erscheint, sobald die Kursliste vom Kursprogramm übertragen ist."
      );
    }
  );
}

test("Schalter aus: kein Info-Button, keine Karte", { skip }, async (t) => {
  const { container } = await mountPreview(
    t,
    { courseCountMode: "off" },
    INVENTORY
  );
  assert.equal(byPreview(container, "course-count-button").length, 0);
  assert.equal(byPreview(container, "header-course-count").length, 0);
});
