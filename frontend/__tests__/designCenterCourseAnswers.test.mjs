// KIE-567 (Nutzer 15.10.2026, Mockup Ansicht 6): Reiter Aussehen, beide
// Darstellungen: „Antworten mit Kursen“ mit „Kurse anzeigen als“
// (Kurskarten / Nur Text mit Links, Schlüssel courseCards "auto"|"off") und
// „Reihenfolge“ (Karten zuerst / Text zuerst, courseCardsPosition
// "above"|"below"). Ohne gespeicherten Wert gilt der Standard (Kurskarten,
// Karten zuerst); gespeichert wird nur eine Abweichung (Regel D6). Die
// Vorschau zeigt eine Beispiel-Antwort nach der Wahl.
//
// Logik gegen den Server-Code (embedStandards.js), Darstellung serverseitig
// gerendert, Bedienung und Speichern mit eingehängter Seite und ersetztem
// fetch (wie designCenterPrivacySwitch.test.mjs).
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  createRenderer,
  hasFrontendDeps,
} from "./helpers/renderSettingsPage.mjs";
import { click, elements } from "./helpers/testDom.mjs";
import * as keys from "../src/pages/GeneralSettings/ChatEmbedWidgets/EmbedAppearance/widgetKeys.js";

const DIR = "/src/pages/GeneralSettings/ChatEmbedWidgets/EmbedAppearance";
const DESIGN_CENTER = `${DIR}/index.jsx`;
const APPEARANCE = `${DIR}/AppearanceTab.jsx`;
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

const CARDS_HINT =
  "Kurskarten zeigen Termin, Ort und freie Plätze auf einen Blick. „Nur Text“ ist die klassische Antwort mit Kurs-Links im Text.";
const ORDER_HINT =
  "Empfohlen: Karten zuerst. Sie erscheinen sofort, während der Text noch geschrieben wird; die Folgefragen stehen dann direkt unter dem Text am Ende.";

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
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ")
    .trim();

// Aktive Option einer Button-Gruppe (Segmented) im gerenderten HTML
const activeLabels = (html) =>
  [
    ...html.matchAll(
      /<button[^>]*class="[^"]*bg-primary-button text-black[^"]*"[^>]*>([^<]*)<\/button>/g
    ),
  ].map((m) => m[1]);

// ---------------------------------------------------------------------------
// Logik
// ---------------------------------------------------------------------------

const VALUES = [
  undefined,
  null,
  "",
  "auto",
  "off",
  " OFF ",
  "Auto",
  "above",
  "below",
  " Below ",
  "first",
  "every",
  " EVERY ",
  "aus",
  "immer",
  false,
  0,
  1,
  ["off"],
  { v: "off" },
];

test("Optionen wörtlich wie im Server (Vertrag)", () => {
  assert.deepEqual(
    keys.COURSE_CARDS_OPTIONS.map((o) => o.value),
    [...server.COURSE_CARDS_VALUES]
  );
  assert.deepEqual(
    keys.COURSE_CARDS_POSITION_OPTIONS.map((o) => o.value),
    [...server.COURSE_CARDS_POSITIONS]
  );
  assert.deepEqual(
    keys.COURSE_CARDS_OPTIONS.map((o) => o.label),
    ["Kurskarten", "Nur Text mit Links"]
  );
  assert.deepEqual(
    keys.COURSE_CARDS_POSITION_OPTIONS.map((o) => o.label),
    ["Karten zuerst", "Text zuerst"]
  );
});

test("wirksamer Wert wie im Server, fehlend oder ungültig = Standard", () => {
  for (const v of VALUES) {
    assert.equal(
      keys.choiceValue({ courseCards: v }, "courseCards"),
      server.courseCardsValue(v),
      `courseCards ${JSON.stringify(v)}`
    );
    assert.equal(
      keys.choiceValue({ courseCardsPosition: v }, "courseCardsPosition"),
      server.courseCardsPositionValue(v),
      `courseCardsPosition ${JSON.stringify(v)}`
    );
  }
  assert.equal(keys.choiceValue({}, "courseCards"), "auto");
  assert.equal(keys.choiceValue({}, "courseCardsPosition"), "above");
});

test("D6: Wahl des wirksamen gespeicherten Werts ist keine Änderung", () => {
  // nichts gespeichert: Standard wählen schreibt nichts
  assert.deepEqual(
    keys.withChoice({ name: "VHS" }, {}, "courseCards", "auto"),
    { name: "VHS" }
  );
  // Abweichung wird gesetzt, zurück zum Standard entfernt sie wieder
  const off = keys.withChoice({ name: "VHS" }, {}, "courseCards", "off");
  assert.deepEqual(off, { name: "VHS", courseCards: "off" });
  assert.deepEqual(keys.withChoice(off, {}, "courseCards", "auto"), {
    name: "VHS",
  });
  // gespeicherter Wert (auch in anderer Schreibweise) bleibt wörtlich stehen
  const stored = { courseCardsPosition: " Below " };
  const above = keys.withChoice(stored, stored, "courseCardsPosition", "above");
  assert.deepEqual(above, { courseCardsPosition: "above" });
  assert.deepEqual(
    keys.withChoice(above, stored, "courseCardsPosition", "below"),
    stored
  );
  // gespeichert ungültig (wirkt wie Standard): Standard wählen ändert nichts
  const invalid = { courseCards: "kaputt" };
  assert.deepEqual(
    keys.withChoice(invalid, invalid, "courseCards", "auto"),
    invalid
  );
});

test("Speichern: cleanConfig lässt die Wahl unverändert", () => {
  const config = { courseCards: "off", courseCardsPosition: "below" };
  assert.deepEqual(
    keys.cleanConfig(config, {
      initial: {},
      defaults: DEFAULTS,
      greetingKey: "greeting",
    }),
    config
  );
});

// ---------------------------------------------------------------------------
// Darstellung
// ---------------------------------------------------------------------------

const appearance = (config) =>
  renderer.render(APPEARANCE, {
    location: "/",
    props: { config, updateField: noop, setChoice: noop, logoPreview: null },
  });

test(
  "Aussehen: „Antworten mit Kursen“ in beiden Darstellungen, Standard Kurskarten und Karten zuerst, über dem Kasten „Fest eingebaut“",
  { skip },
  async () => {
    for (const config of [{}, { displayMode: "inline" }]) {
      const html = await appearance(config);
      const t = text(html);
      for (const label of [
        "Antworten mit Kursen",
        "Kurse anzeigen als",
        "Kurskarten",
        "Nur Text mit Links",
        CARDS_HINT,
        "Reihenfolge",
        "Karten zuerst",
        "Text zuerst",
        ORDER_HINT,
      ])
        assert.ok(t.includes(label), `${label} ${JSON.stringify(config)}`);
      const active = activeLabels(html);
      assert.ok(active.includes("Kurskarten"));
      assert.ok(active.includes("Karten zuerst"));
      assert.ok(!active.includes("Nur Text mit Links"));
      assert.ok(!active.includes("Text zuerst"));
      assert.ok(
        t.indexOf("Antworten mit Kursen") < t.indexOf("Fest eingebaut")
      );
      assert.doesNotMatch(t, /[–—]/);
      assert.ok(!t.includes("Knopf"));
    }
  }
);

test(
  "Aussehen: gespeicherte Wahl ist markiert; bei „Nur Text mit Links“ keine Reihenfolge",
  { skip },
  async () => {
    const below = await appearance({ courseCardsPosition: " BELOW " });
    assert.ok(activeLabels(below).includes("Text zuerst"));
    assert.ok(activeLabels(below).includes("Kurskarten"));

    const off = await appearance({
      displayMode: "inline",
      courseCards: "off",
      courseCardsPosition: "below",
    });
    const t = text(off);
    assert.ok(activeLabels(off).includes("Nur Text mit Links"));
    assert.ok(!off.includes(">Reihenfolge<"));
    assert.ok(!t.includes("Karten zuerst"));
    assert.ok(!t.includes(ORDER_HINT));
    // ungültig gespeichert: Standard markiert
    const invalid = await appearance({ courseCards: "kaputt" });
    assert.ok(activeLabels(invalid).includes("Kurskarten"));
  }
);

// ---------------------------------------------------------------------------
// Vorschau
// ---------------------------------------------------------------------------

const previewHtml = (config) =>
  renderer.render(PREVIEW, {
    location: "/",
    props: {
      config,
      logoPreview: null,
      defaults: DEFAULTS,
      greetingKey: "greeting",
    },
  });
const at = (html, marker) => html.indexOf(`data-preview="${marker}"`);

test(
  "Vorschau: Beispiel-Antwort folgt der Wahl (Karten zuerst, Text zuerst, Nur Text mit Links), Chatblase und Inline",
  { skip },
  async () => {
    // Standard: Karten zuerst
    const std = await previewHtml({});
    assert.match(std, /data-course-cards="auto"/);
    assert.match(std, /data-cards-position="above"/);
    assert.equal((std.match(/data-preview="course-card"/g) || []).length, 2);
    assert.ok(at(std, "course-cards") < at(std, "answer-text"));
    assert.ok(at(std, "answer-text") < at(std, "follow-ups"));
    assert.match(std, /data-preview="follow-up-pill"/);
    // Folgefrage ist kein Startvorschlag
    assert.doesNotMatch(std, /data-preview="pill"/);

    const below = await previewHtml({ courseCardsPosition: "below" });
    assert.match(below, /data-cards-position="below"/);
    assert.ok(at(below, "answer-text") < at(below, "course-cards"));
    assert.ok(at(below, "course-cards") < at(below, "follow-ups"));

    const off = await previewHtml({
      courseCards: "off",
      courseCardsPosition: "below",
    });
    assert.match(off, /data-course-cards="off"/);
    assert.doesNotMatch(off, /data-cards-position/);
    assert.doesNotMatch(off, /data-preview="course-card"/);
    assert.equal((off.match(/data-preview="course-link"/g) || []).length, 2);
    assert.ok(text(off).includes("Am Wochenende passen zwei Kurse:"));
    assert.doesNotMatch(text(off), /[–—]/);
  }
);

test(
  "Vorschau Inline aufgeklappt: Beispiel-Antwort mit Text zuerst",
  { skip },
  async (t) => {
    const mounted = await renderer.mount(PREVIEW, {
      location: "/",
      props: {
        config: { displayMode: "inline", courseCardsPosition: "below" },
        logoPreview: null,
        defaults: DEFAULTS,
        greetingKey: "greeting",
      },
    });
    t.after(() => mounted.unmount());
    const { container, act } = mounted;
    const bar = elements(
      container,
      (el) => el.getAttribute("data-preview") === "inline-bar"
    )[0];
    await act(() => click(elements(bar, (el) => el.tagName === "BUTTON")[0]));
    const answer = elements(
      container,
      (el) => el.getAttribute("data-preview") === "sample-answer"
    )[0];
    assert.ok(answer, "Beispiel-Antwort im Panel");
    assert.equal(answer.getAttribute("data-cards-position"), "below");
    const kinds = elements(answer, (el) =>
      ["answer-text", "course-cards"].includes(el.getAttribute("data-preview"))
    ).map((el) => el.getAttribute("data-preview"));
    assert.deepEqual(kinds, ["answer-text", "course-cards"]);
  }
);

// Chatblase der Vorschau schließen und die Willkommensblasen zählen

// ---------------------------------------------------------------------------
// Bedienung und Speichern (Seite eingehängt)
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

function stubServer(t, embeds) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const body = init.body === undefined ? undefined : JSON.parse(init.body);
    calls.push({ url, method: init.method, body });
    let answer = {};
    if (url.endsWith("/embeds")) answer = { embeds };
    else if (url.includes("/embed/defaults"))
      answer = { lang: "de", defaults: DEFAULTS };
    else if (url.includes("/embed/update/"))
      answer = { success: true, error: null };
    return { ok: true, status: 200, json: async () => answer };
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return calls;
}

const button = (root, label) =>
  elements(
    root,
    (el) => el.tagName === "BUTTON" && el.textContent.trim() === label
  )[0];

async function open(t, embeds, id, tab = null) {
  const calls = stubServer(t, embeds);
  const mounted = await renderer.mount(DESIGN_CENTER, {
    location: `/settings/embed-config/${id}/appearance`,
    route: "/settings/embed-config/:embedId/appearance",
  });
  t.after(() => mounted.unmount());
  await mounted.act();
  if (tab) await mounted.act(() => click(button(mounted.container, tab)));
  return { ...mounted, calls };
}

const savedBody = (calls) => {
  const call = calls.find((c) => c.url.includes("/embed/update/"));
  return call ? JSON.parse(call.body.visual_config) : null;
};
const unsaved = (container) =>
  container.textContent.includes("Ungespeicherte Änderungen");
const previewAttr = (container, attr) =>
  elements(
    container,
    (el) => el.getAttribute("data-preview") === "sample-answer"
  )[0]?.getAttribute(attr);

test(
  "Aussehen bedienen: Standard anklicken ändert nichts; Text zuerst und Nur Text mit Links speichern nur courseCardsPosition bzw. courseCards; Vorschau folgt",
  { skip },
  async (t) => {
    const stored = { accentColor: "#FFA102", name: "VHS" };
    const { container, act, calls } = await open(t, [widget(3, stored)], 3);
    assert.equal(previewAttr(container, "data-cards-position"), "above");
    await act(() => click(button(container, "Kurskarten")));
    await act(() => click(button(container, "Karten zuerst")));
    assert.ok(!unsaved(container), "Standard gewählt ist keine Änderung");

    await act(() => click(button(container, "Text zuerst")));
    assert.ok(unsaved(container));
    assert.equal(previewAttr(container, "data-cards-position"), "below");
    await act(() => click(button(container, "Nur Text mit Links")));
    assert.equal(previewAttr(container, "data-course-cards"), "off");
    assert.equal(button(container, "Text zuerst"), undefined);
    await act(() => click(button(container, "Speichern")));
    assert.deepEqual(savedBody(calls), {
      ...stored,
      courseCards: "off",
      courseCardsPosition: "below",
    });
  }
);

test(
  "Aussehen bedienen: zurück auf Kurskarten nach gespeichertem off schreibt auto",
  { skip },
  async (t) => {
    const stored = { courseCards: "off" };
    const { container, act, calls } = await open(t, [widget(6, stored)], 6);
    assert.equal(previewAttr(container, "data-course-cards"), "off");
    await act(() => click(button(container, "Kurskarten")));
    assert.equal(previewAttr(container, "data-course-cards"), "auto");
    await act(() => click(button(container, "Speichern")));
    assert.deepEqual(savedBody(calls), { courseCards: "auto" });
  }
);
