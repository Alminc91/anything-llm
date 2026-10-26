// KIE-576 Paket 3, AK-K6: Design Center › Inhalt › Name und Untertitel.
// Schalter „Kursanzahl im Untertitel“ (Standard an) sperrt den Untertitel
// mit dem Hinweis „Statt des Untertitels steht die Kursanzahl.“, das Feld
// „Bezeichnung“ (Standard „Kurse“) ist frei und wird geprüft (ein Wort aus
// Buchstaben, Bindestrich nur zwischen Buchstaben, höchstens 20 Zeichen, wie
// der Server; Fixliste r2b: Meldung statt stiller Kürzung).
// Die interne Zeile zum Kursbestand unter dem Schalter entfällt (D-K5, die
// Info-Karte im Widget sagt es dem Besucher). Die Vorschau zeigt die echte
// Zahl (GET /embed/defaults?embedId=), sonst eine Beispielzahl. Gespeichert
// wird nur Abweichendes vom Standard (Regel D6); der Untertitel bleibt
// gespeichert und gilt mit Schalter aus wieder (NAK-K5).
//
// Logik gegen den Server-Code, Darstellung serverseitig gerendert, Speichern
// mit eingehängter Seite und ersetztem fetch (wie
// designCenterPrivacySwitch.test.mjs).
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  createRenderer,
  hasFrontendDeps,
} from "./helpers/renderSettingsPage.mjs";
import { click, elements, handlersOf } from "./helpers/testDom.mjs";
import * as keys from "../src/pages/GeneralSettings/ChatEmbedWidgets/EmbedAppearance/widgetKeys.js";

const DIR = "/src/pages/GeneralSettings/ChatEmbedWidgets/EmbedAppearance";
const DESIGN_CENTER = `${DIR}/index.jsx`;
const CONTENT = `${DIR}/ContentTab.jsx`;
const PREVIEW = `${DIR}/WidgetPreview.jsx`;
const skip = hasFrontendDeps
  ? false
  : "frontend/node_modules nicht installiert";

const require = createRequire(import.meta.url);
const server = require("../../server/utils/chats/embedStandards.js");
const {
  embedDefaultTexts,
} = require("../../server/utils/chats/embedDefaults.js");
const DEFAULTS = embedDefaultTexts("de");
// Vertrag der Bezeichnung (wortgleich im Widget): courseCountWords
const CONTRACT = require("../../server/__tests__/utils/chats/fixtures/embedConfigContract.json");

const SWITCH_LABEL = "Kursanzahl im Untertitel";
const LOCKED_HINT = "Statt des Untertitels steht die Kursanzahl.";
// D-K5: frühere interne Zeile („Im KI-Berater: … von … · … veraltete
// ausgeblendet · Stand …“ bzw. ohne Kursliste dieser Satz)
const NO_LIST = "Noch keine Kursliste vom Kursprogramm";
const INTERNAL_LINE =
  /Im KI-Berater:|veraltete? ausgeblendet|Noch keine Kursliste/;
const INVENTORY = {
  count: 812,
  offered: 837,
  hidden: 14,
  stand: "2026-10-24T08:00:00.000Z",
};

let renderer;
before(async () => {
  if (hasFrontendDeps) renderer = await createRenderer();
});
after(async () => {
  await renderer?.close();
});

const noop = () => {};
const text = (html) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();

// ---------------------------------------------------------------------------
// Logik
// ---------------------------------------------------------------------------

const WORDS = [
  undefined,
  null,
  42,
  "",
  "   ",
  "Kurse",
  " Seminare ",
  "Online-Kurse",
  "Kurse  vor   Ort",
  "Lehrgänge",
  "Cours",
  "Kurse 2026",
  "Kurse!",
  "<b>Kurse</b>",
  "-",
  "- -",
  "x".repeat(20),
  "x".repeat(21),
  "Kurse\u2013Angebote",
  "Kurse\nneu",
];

test("Bezeichnung: dieselbe Regel wie der Server (courseCountWordValue)", () => {
  for (const word of WORDS)
    assert.equal(
      keys.courseCountWordValue(word),
      server.courseCountWordValue(word),
      JSON.stringify(word)
    );
  assert.equal(
    keys.COURSE_COUNT_WORD_MAX_LEN,
    server.COURSE_COUNT_WORD_MAX_LEN
  );
  assert.equal(
    keys.DEFAULT_COURSE_COUNT_WORD,
    server.DEFAULT_COURSE_COUNT_WORDS.de
  );
  assert.equal(keys.courseCountWordValue(" Seminare "), "Seminare");
  assert.equal(keys.courseCountWordValue("Kurse  vor   Ort"), null);
});

test("Bezeichnung: Beispiele des Vertrags (courseCountWords), ungültig mit Meldung", () => {
  for (const [input, word] of CONTRACT.courseCountWords.valid) {
    assert.equal(keys.courseCountWordValue(input), word, input);
    assert.equal(keys.courseCountWordError(input), null, input);
  }
  for (const input of CONTRACT.courseCountWords.invalid) {
    assert.equal(keys.courseCountWordValue(input), null, input);
    assert.equal(
      keys.courseCountWordError(input),
      "Bitte ein Wort aus Buchstaben, höchstens 20 Zeichen, etwa Seminare oder Online-Kurse.",
      input
    );
  }
});

test("Schalter: an/aus wie der Server (courseCountModeValue), fehlend an", () => {
  for (const courseCountMode of [
    undefined,
    null,
    "",
    "on",
    "off",
    " OFF ",
    "aus",
    false,
  ])
    assert.equal(
      keys.courseCountOn({ courseCountMode }),
      server.courseCountModeValue(courseCountMode) === "on",
      String(courseCountMode)
    );
});

test("Fehlertext nur bei ungültiger, nicht leerer Bezeichnung", () => {
  assert.equal(keys.courseCountWordError(""), null);
  assert.equal(keys.courseCountWordError("Seminare"), null);
  assert.equal(
    keys.courseCountWordError("Kurse!"),
    "Bitte ein Wort aus Buchstaben, höchstens 20 Zeichen, etwa Seminare oder Online-Kurse."
  );
  assert.ok(keys.courseCountWordError("x".repeat(21)));
});

test("D6: Schalter aus schreibt off, wieder an ist keine Änderung; gespeichert aus, an entfällt beim Speichern", () => {
  const opts = (initial) => ({
    initial,
    defaults: DEFAULTS,
    greetingKey: "greeting",
  });
  const off = keys.withCourseCount({ name: "VHS" }, {}, false);
  assert.deepEqual(off, { name: "VHS", courseCountMode: "off" });
  assert.deepEqual(keys.withCourseCount(off, {}, true), { name: "VHS" });
  assert.deepEqual(keys.cleanConfig(off, opts({})), {
    name: "VHS",
    courseCountMode: "off",
  });
  // gespeichert aus, wieder an: der Standard gilt, kein Schlüssel
  const stored = { courseCountMode: "off" };
  const on = keys.withCourseCount(stored, stored, true);
  assert.deepEqual(on, { courseCountMode: "on" });
  assert.deepEqual(keys.cleanConfig(on, opts(stored)), {});
  // unverändert gespeichertes "on" bleibt stehen (F05)
  assert.deepEqual(
    keys.cleanConfig(
      { courseCountMode: "on" },
      opts({ courseCountMode: "on" })
    ),
    { courseCountMode: "on" }
  );
});

test("D6: Bezeichnung nur gespeichert, wenn sie vom Standard abweicht; mit Schalter aus bleibt sie wie gespeichert", () => {
  const opts = (initial) => ({
    initial,
    defaults: DEFAULTS,
    greetingKey: "greeting",
  });
  assert.deepEqual(
    keys.cleanConfig({ courseCountWord: " Seminare " }, opts({})),
    { courseCountWord: "Seminare" }
  );
  assert.deepEqual(
    keys.cleanConfig({ courseCountWord: "Kurse" }, opts({})),
    {}
  );
  assert.deepEqual(keys.cleanConfig({ courseCountWord: "  " }, opts({})), {});
  const stored = { courseCountWord: "Seminare" };
  assert.deepEqual(
    keys.cleanConfig(
      { courseCountMode: "off", courseCountWord: "Neu" },
      opts(stored)
    ),
    { courseCountMode: "off", courseCountWord: "Seminare" }
  );
  assert.deepEqual(
    keys.cleanConfig(
      { courseCountMode: "off", courseCountWord: "Neu" },
      opts({})
    ),
    { courseCountMode: "off" }
  );
});

test("r3-S1: ungültige gespeicherte Bezeichnung wird beim Speichern verworfen, mit Schalter an und aus", () => {
  const old = { courseCountWord: "Kurse am Abend", accentColor: "#123456" };
  const opts = { initial: old, defaults: DEFAULTS, greetingKey: "greeting" };
  // unverändert mit Schalter an: keine Fehlermarke, beim Speichern verworfen
  assert.deepEqual(keys.validateConfig({ ...old }, old, "greeting"), {});
  assert.deepEqual(keys.cleanConfig({ ...old }, opts), {
    accentColor: "#123456",
  });
  // Schalter aus: der ungültige Wert aus initial wird nicht übernommen
  assert.deepEqual(
    keys.cleanConfig(keys.withCourseCount(old, old, false), opts),
    { accentColor: "#123456", courseCountMode: "off" }
  );
  // neu eingegeben bleibt sie stehen (Speichern-Button sichtbar),
  // validateConfig sperrt das Speichern mit Meldung
  assert.deepEqual(
    keys.cleanConfig({ ...old, courseCountWord: "Neu!" }, opts),
    { accentColor: "#123456", courseCountWord: "Neu!" }
  );
  assert.equal(
    keys.validateConfig({ ...old, courseCountWord: "Neu!" }, old, "greeting")
      .courseCountWord,
    keys.COURSE_COUNT_WORD_ERROR
  );
  // ein gültiger gespeicherter Wert bleibt mit Schalter aus erhalten
  const valid = { courseCountWord: "Seminare" };
  assert.deepEqual(
    keys.cleanConfig(keys.withCourseCount(valid, valid, false), {
      ...opts,
      initial: valid,
    }),
    { courseCountWord: "Seminare", courseCountMode: "off" }
  );
});

test("NAK-K5: der Untertitel bleibt beim Speichern mit Schalter an und aus erhalten", () => {
  const stored = { assistantSubtitle: "Ihr Kursberater" };
  const opts = { initial: stored, defaults: DEFAULTS, greetingKey: "greeting" };
  assert.deepEqual(keys.cleanConfig({ ...stored }, opts), stored);
  assert.deepEqual(
    keys.cleanConfig(keys.withCourseCount(stored, stored, false), opts),
    { ...stored, courseCountMode: "off" }
  );
});

test("Prüfung: ungültige geänderte Bezeichnung blockiert nur mit Schalter an", () => {
  const errors = keys.validateConfig(
    { courseCountWord: "Kurse!" },
    {},
    "greeting"
  );
  assert.equal(
    errors.courseCountWord,
    "Bitte ein Wort aus Buchstaben, höchstens 20 Zeichen, etwa Seminare oder Online-Kurse."
  );
  assert.equal(keys.FIELD_TAB.courseCountWord, "inhalt");
  assert.deepEqual(
    keys.validateConfig(
      { courseCountWord: "Kurse!", courseCountMode: "off" },
      {},
      "greeting"
    ),
    {}
  );
  // unverändert gespeichert (früherer Wert) blockiert nicht
  assert.deepEqual(
    keys.validateConfig(
      { courseCountWord: "Kurse!" },
      { courseCountWord: "Kurse!" },
      "greeting"
    ),
    {}
  );
});

test("D-K5: keine interne Zeile mehr, Kursbestand nur noch für die Vorschau geprüft", () => {
  assert.equal(keys.courseCountStatusLine, undefined);
  assert.equal(keys.courseCountStandText, undefined);
  assert.deepEqual(keys.courseInventoryValue(INVENTORY), {
    count: 812,
    offered: 837,
    hidden: 14,
    stand: INVENTORY.stand,
  });
  // ohne stale und missing (D-K5) gültig, ungültige Zahlen nicht
  assert.ok(
    keys.courseInventoryValue({ count: 1, offered: 1, stand: INVENTORY.stand })
  );
  for (const bad of [
    null,
    undefined,
    {},
    { ...INVENTORY, count: -1 },
    { ...INVENTORY, count: "812" },
    { ...INVENTORY, stand: "gestern" },
  ])
    assert.equal(keys.courseInventoryValue(bad), null);
});

test("Vorschau: echte Zahl, sonst Beispielzahl; Bezeichnung wie live; Schalter aus ohne Zahl", () => {
  const real = keys.previewCourseCount({}, INVENTORY);
  assert.equal(real.text, "aktuell 812 Kurse");
  assert.equal(real.sample, false);
  const sample = keys.previewCourseCount({}, null);
  assert.equal(sample.text, "aktuell 837 Kurse");
  assert.equal(sample.sample, true);
  assert.deepEqual(
    keys.previewCourseCount({}, { ...INVENTORY, count: 0 }).sample,
    true
  );
  assert.equal(
    keys.previewCourseCount({ courseCountWord: "Seminare" }, INVENTORY).text,
    "aktuell 812 Seminare"
  );
  assert.equal(
    keys.previewCourseCount({ courseCountWord: "Kurse!" }, INVENTORY).text,
    "aktuell 812 Kurse"
  );
  assert.equal(
    keys.previewCourseCount({ courseCountMode: "off" }, INVENTORY),
    null
  );
  assert.equal(
    keys.previewCourseCount({}, { ...INVENTORY, count: 1243 }).text,
    "aktuell 1.243 Kurse"
  );
});

// ---------------------------------------------------------------------------
// Darstellung
// ---------------------------------------------------------------------------

const contentProps = (config, extra = {}) => ({
  config,
  initialConfig: config,
  errors: {},
  defaults: DEFAULTS,
  defaultsError: false,
  greetingKey: "greeting",
  updateField: noop,
  updateOptionalField: noop,
  resetKeys: noop,
  setPrivacyNotice: noop,
  setCourseCount: noop,
  addListItem: noop,
  updateListItem: noop,
  removeListItem: noop,
  ...extra,
});

// Ausschnitt ab dem Element mit attr bis zum nächsten Feld (Bezeichnung
// bzw. Untertitel)
const block = (html, attr) => {
  const at = html.indexOf(attr);
  assert.ok(at > 0, `${attr} fehlt`);
  const start = html.lastIndexOf("<", at);
  const ends = ["data-course-count-word", "data-subtitle-field"]
    .map((next) => html.indexOf(next, at + attr.length))
    .filter((i) => i > 0);
  return html.slice(start, Math.min(...ends));
};
const subtitleFieldset = (html) => {
  const at = html.indexOf("data-subtitle-field");
  const fs = html.indexOf("<fieldset", at);
  return html.slice(fs, html.indexOf(">", fs) + 1);
};

test(
  "Inhalt, Standard an: Schalter an, Untertitel gesperrt mit Hinweis, Bezeichnung frei mit „Kurse“, ohne interne Zeile (D-K5)",
  { skip },
  async () => {
    const html = await renderer.render(CONTENT, {
      location: "/",
      props: contentProps({ assistantSubtitle: "Ihr Kursberater" }),
    });
    const t = text(html);
    const switchBlock = block(html, "data-course-count-switch");
    assert.ok(switchBlock.includes(`>${SWITCH_LABEL}<`));
    assert.match(
      switchBlock,
      /role="switch"[^>]*checked=""|checked=""[^>]*role="switch"/
    );
    assert.match(subtitleFieldset(html), /disabled=""/);
    assert.match(html, /data-subtitle-field="locked"/);
    // der gespeicherte Untertitel steht weiter im gesperrten Feld (NAK-K5)
    assert.match(html, /value="Ihr Kursberater"/);
    assert.ok(t.includes(LOCKED_HINT));
    assert.ok(
      !t.includes("Kleine Zeile unter dem Namen in der Titelleiste des Chats.")
    );
    const word = block(html, "data-course-count-word");
    assert.match(word, /value="Kurse"/);
    // keine stille Kürzung: zu lange Eingaben bekommen die Meldung
    assert.doesNotMatch(word, /maxLength|maxlength/);
    assert.doesNotMatch(word, /disabled/);
    // D-K5: keine interne Zeile unter dem Schalter
    assert.doesNotMatch(t, INTERNAL_LINE);
    assert.ok(!html.includes("data-course-count-status"));
    // Reihenfolge: Name, Schalter, Bezeichnung, Untertitel
    assert.ok(t.indexOf(SWITCH_LABEL) < t.indexOf("Bezeichnung"));
    assert.ok(t.indexOf("Bezeichnung") < t.indexOf("Untertitel (optional)"));
    // Textregeln: keine Gedankenstriche
    assert.doesNotMatch(t, /[–—]/);
  }
);

test(
  "Inhalt, Schalter aus: eigener Untertitel bedienbar wie heute, keine Bezeichnung",
  { skip },
  async () => {
    const html = await renderer.render(CONTENT, {
      location: "/",
      props: contentProps({
        courseCountMode: "off",
        assistantSubtitle: "Ihr Kursberater",
      }),
    });
    const t = text(html);
    assert.doesNotMatch(block(html, "data-course-count-switch"), /checked=""/);
    assert.doesNotMatch(subtitleFieldset(html), /disabled/);
    assert.match(html, /data-subtitle-field="open"/);
    assert.ok(!html.includes("data-course-count-word"));
    assert.ok(!t.includes(LOCKED_HINT));
    assert.ok(
      t.includes("Kleine Zeile unter dem Namen in der Titelleiste des Chats.")
    );
    // ohne Kursbestand keine interne Zeile (D-K5)
    assert.ok(!t.includes(NO_LIST));
  }
);

test("Inhalt: Fehler der Bezeichnung unter dem Feld", { skip }, async () => {
  const html = await renderer.render(CONTENT, {
    location: "/",
    props: contentProps(
      { courseCountWord: "Kurse!" },
      {
        errors: {
          courseCountWord: keys.COURSE_COUNT_WORD_ERROR,
        },
      }
    ),
  });
  const word = block(html, "data-course-count-word");
  assert.match(word, /aria-invalid="true"/);
  assert.ok(text(word).includes(keys.COURSE_COUNT_WORD_ERROR));
});

const preview = (config, courseInventory = null) =>
  renderer.render(PREVIEW, {
    location: "/",
    props: {
      config,
      logoPreview: null,
      defaults: DEFAULTS,
      greetingKey: "greeting",
      courseInventory,
    },
  });
// Text der Zahl im Kopf (ohne Info-Button und Zusatz „Beispiel“, AK-K10)
const headerCount = (html) => {
  const at = html.indexOf('data-preview="header-course-count"');
  if (at < 0) return null;
  const rest = html.slice(at);
  return text(rest.slice(rest.indexOf(">") + 1, rest.indexOf("<button")));
};

test(
  "Vorschau: echte Zahl statt des Untertitels, sonst Beispielzahl; Schalter aus zeigt den Untertitel",
  { skip },
  async () => {
    for (const displayMode of [undefined, "inline"]) {
      const real = await preview(
        { displayMode, assistantSubtitle: "Ihr Kursberater" },
        INVENTORY
      );
      assert.equal(headerCount(real), "aktuell 812 Kurse");
      assert.match(real, /data-sample="false"/);
      assert.doesNotMatch(real, /data-preview="header-subtitle"/);
      const sample = await preview({ displayMode });
      assert.equal(headerCount(sample), "aktuell 837 Kurse");
      assert.match(sample, /data-sample="true"/);
      const own = await preview(
        { displayMode, courseCountWord: "Seminare" },
        INVENTORY
      );
      assert.equal(headerCount(own), "aktuell 812 Seminare");
      const off = await preview(
        {
          displayMode,
          courseCountMode: "off",
          assistantSubtitle: "Ihr Kursberater",
        },
        INVENTORY
      );
      assert.equal(headerCount(off), null);
      assert.match(off, /data-preview="header-subtitle"[^>]*>Ihr Kursberater</);
    }
  }
);

// ---------------------------------------------------------------------------
// Speichern (Seite eingehängt)
// ---------------------------------------------------------------------------

const widget = (id, visualConfig) => ({
  id,
  uuid: `uuid-${id}`,
  enabled: true,
  chat_mode: "query",
  allowlist_domains: null,
  chat_retention_days: null,
  visual_config: visualConfig === null ? null : JSON.stringify(visualConfig),
  createdAt: "2026-10-01T08:00:00.000Z",
  workspace: { id: 100 + id, name: `Workspace ${id}`, slug: `ws-${id}` },
  _count: { embed_chats: 0 },
});

function stubServer(t, embeds, courseInventory = INVENTORY) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const body = init.body === undefined ? undefined : JSON.parse(init.body);
    calls.push({ url, method: init.method, body });
    let answer = {};
    if (url.endsWith("/embeds")) answer = { embeds };
    else if (url.includes("/embed/defaults"))
      answer = url.includes("embedId=")
        ? { lang: "de", defaults: DEFAULTS, courseInventory }
        : { lang: "de", defaults: DEFAULTS };
    else if (url.includes("/embed/update/"))
      answer = { success: true, error: null };
    return { ok: true, status: 200, json: async () => answer };
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return calls;
}

async function open(t, embeds, id, courseInventory) {
  const calls = stubServer(t, embeds, courseInventory);
  const mounted = await renderer.mount(DESIGN_CENTER, {
    location: `/settings/embed-config/${id}/appearance`,
    route: "/settings/embed-config/:embedId/appearance",
  });
  t.after(() => mounted.unmount());
  await mounted.act();
  const { container, act } = mounted;
  await act(() =>
    click(
      elements(
        container,
        (el) => el.tagName === "BUTTON" && el.textContent.trim() === "Inhalt"
      )[0]
    )
  );
  return { ...mounted, calls };
}

const button = (container, label) =>
  elements(
    container,
    (el) => el.tagName === "BUTTON" && el.textContent.trim() === label
  )[0];
const countSwitch = (container) => {
  const root = elements(container, (el) =>
    el.hasAttribute?.("data-course-count-switch")
  )[0];
  if (!root || !root.textContent.includes(SWITCH_LABEL)) return undefined;
  return elements(
    root,
    (el) => el.tagName === "INPUT" && el.getAttribute("type") === "checkbox"
  )[0];
};
const wordInput = (container) =>
  elements(
    container,
    (el) => el.getAttribute?.("aria-label") === "Bezeichnung der Kursanzahl"
  )[0];
const toggle = (container, checked) =>
  handlersOf(countSwitch(container)).onChange({ target: { checked } });
const type = (input, value) =>
  handlersOf(input).onChange({ target: { value } });
const savedBody = (calls) => {
  const call = calls.find((c) => c.url.includes("/embed/update/"));
  return call ? JSON.parse(call.body.visual_config) : null;
};
const statusLine = (container) =>
  elements(container, (el) => el.hasAttribute?.("data-course-count-status"))[0]
    ?.textContent;
const switchText = (container) =>
  elements(container, (el) => el.hasAttribute?.("data-course-count-switch"))[0]
    ?.textContent;

test(
  "Seite: Kursbestand des Widgets geladen (embedId), keine interne Zeile, Vorschau mit echter Zahl",
  { skip },
  async (t) => {
    const { container, calls } = await open(t, [widget(4, {})], 4);
    const defaultsCall = calls.find((c) => c.url.includes("/embed/defaults"));
    assert.match(defaultsCall.url, /[?&]embedId=4(&|$)/);
    assert.equal(statusLine(container), undefined);
    assert.ok(switchText(container).includes(SWITCH_LABEL));
    assert.doesNotMatch(switchText(container), INTERNAL_LINE);
    const counts = elements(
      container,
      (el) => el.getAttribute?.("data-preview") === "header-course-count"
    );
    assert.equal(counts[0]?.textContent.trim(), "aktuell 812 Kurse");
  }
);

test(
  "Seite ohne Kursbestand: keine interne Zeile (D-K5), Vorschau mit Beispielzahl",
  { skip },
  async (t) => {
    const { container } = await open(t, [widget(4, {})], 4, null);
    assert.equal(statusLine(container), undefined);
    assert.ok(!container.textContent.includes(NO_LIST));
    const counts = elements(
      container,
      (el) => el.getAttribute?.("data-preview") === "header-course-count"
    );
    assert.equal(counts[0]?.getAttribute("data-sample"), "true");
  }
);

test(
  "D6: neues Widget ohne Änderung; aus und wieder an keine Änderung; aus speichert nur courseCountMode off",
  { skip },
  async (t) => {
    const { container, act, calls } = await open(t, [widget(9, null)], 9);
    assert.ok(countSwitch(container), "Schalter fehlt");
    assert.ok(wordInput(container), "Bezeichnung fehlt");
    assert.ok(!container.textContent.includes("Ungespeicherte Änderungen"));
    await act(() => toggle(container, false));
    assert.ok(container.textContent.includes("Ungespeicherte Änderungen"));
    assert.equal(wordInput(container), undefined);
    await act(() => toggle(container, true));
    assert.ok(!container.textContent.includes("Ungespeicherte Änderungen"));
    await act(() => toggle(container, false));
    await act(() => click(button(container, "Speichern")));
    assert.deepEqual(savedBody(calls), { courseCountMode: "off" });
  }
);

test(
  "Bezeichnung: eigenes Wort gespeichert, „Kurse“ wieder entfernt, ungültig blockiert das Speichern",
  { skip },
  async (t) => {
    const stored = { name: "VHS", assistantSubtitle: "Ihr Kursberater" };
    const { container, act, calls } = await open(t, [widget(5, stored)], 5);
    await act(() => type(wordInput(container), "Seminare!"));
    await act(() => click(button(container, "Speichern")));
    assert.equal(savedBody(calls), null);
    assert.ok(
      container.textContent.includes(keys.COURSE_COUNT_WORD_ERROR),
      "Fehler fehlt"
    );
    await act(() => type(wordInput(container), " Seminare "));
    await act(() => click(button(container, "Speichern")));
    assert.deepEqual(savedBody(calls), {
      ...stored,
      courseCountWord: "Seminare",
    });
    const counts = elements(
      container,
      (el) => el.getAttribute?.("data-preview") === "header-course-count"
    );
    assert.equal(counts[0]?.textContent.trim(), "aktuell 812 Seminare");
  }
);

test(
  "NAK-K5: gespeichert aus mit Untertitel; Einschalten entfernt nur courseCountMode, der Untertitel bleibt",
  { skip },
  async (t) => {
    const stored = {
      assistantSubtitle: "Ihr Kursberater",
      courseCountMode: "off",
    };
    const { container, act, calls } = await open(t, [widget(6, stored)], 6);
    const subtitles = elements(
      container,
      (el) => el.getAttribute?.("data-preview") === "header-subtitle"
    );
    assert.equal(subtitles[0]?.textContent.trim(), "Ihr Kursberater");
    await act(() => toggle(container, true));
    await act(() => click(button(container, "Speichern")));
    assert.deepEqual(savedBody(calls), {
      assistantSubtitle: "Ihr Kursberater",
    });
  }
);
