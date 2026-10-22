// KIE-567 (Nutzer 15.10.2026, Mockup Ansicht 6): Reiter Aussehen, beide
// Darstellungen: „Antworten mit Kursen“ mit „Kurse anzeigen als“
// (Kurskarten / Nur Text mit Links, Schlüssel courseCards "auto"|"off") und
// „Reihenfolge“ (Karten zuerst / Text zuerst, courseCardsPosition
// "above"|"below"). Ohne gespeicherten Wert gilt der Standard der
// Darstellung (R4, Fixliste 7.22-rc8: Chatfenster Nur Text mit Links, In
// der Seite Kurskarten; Reihenfolge Karten zuerst), mit „(Standard)“ am
// Button; gespeichert wird nur eine Abweichung (Regel D6). Die Vorschau
// zeigt eine Beispiel-Antwort nach der Wahl.
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

// S3 (Fixliste 7.22-rc10): unter „Kurse anzeigen als“ nur noch eine Zeile,
// unter „Reihenfolge“ kein Hinweis mehr (ORDER_HINT darf nirgends stehen)
const CARDS_HINT = "Standard hängt von der Darstellung ab.";
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

// R4 (bewusst geändert): der Standard für courseCards hängt an der
// Darstellung, wie im Server (courseCardsValue mit displayMode)
test("wirksamer Wert wie im Server, fehlend oder ungültig = Standard der Darstellung", () => {
  for (const v of VALUES) {
    for (const displayMode of [undefined, "bubble", "inline", " INLINE "])
      assert.equal(
        keys.choiceValue({ courseCards: v, displayMode }, "courseCards"),
        server.courseCardsValue(v, displayMode),
        `courseCards ${JSON.stringify(v)} ${displayMode}`
      );
    assert.equal(
      keys.choiceValue({ courseCardsPosition: v }, "courseCardsPosition"),
      server.courseCardsPositionValue(v),
      `courseCardsPosition ${JSON.stringify(v)}`
    );
  }
  assert.deepEqual(keys.COURSE_CARDS_DEFAULTS, server.COURSE_CARDS_DEFAULTS);
  assert.equal(keys.choiceValue({}, "courseCards"), "off");
  assert.equal(keys.choiceDefault({}, "courseCards"), "off");
  assert.equal(
    keys.choiceValue({ displayMode: "inline" }, "courseCards"),
    "auto"
  );
  assert.equal(
    keys.choiceDefault({ displayMode: "inline" }, "courseCards"),
    "auto"
  );
  assert.equal(keys.choiceValue({}, "courseCardsPosition"), "above");
});

test("D6: Wahl des wirksamen gespeicherten Werts ist keine Änderung", () => {
  // nichts gespeichert: den Standard der Darstellung wählen schreibt nichts
  // (Chatfenster: Nur Text mit Links; In der Seite: Kurskarten)
  assert.deepEqual(keys.withChoice({ name: "VHS" }, {}, "courseCards", "off"), {
    name: "VHS",
  });
  assert.deepEqual(
    keys.withChoice(
      { name: "VHS", displayMode: "inline" },
      {},
      "courseCards",
      "auto"
    ),
    { name: "VHS", displayMode: "inline" }
  );
  // Abweichung wird gesetzt, zurück zum Standard entfernt sie wieder
  const auto = keys.withChoice({ name: "VHS" }, {}, "courseCards", "auto");
  assert.deepEqual(auto, { name: "VHS", courseCards: "auto" });
  assert.deepEqual(keys.withChoice(auto, {}, "courseCards", "off"), {
    name: "VHS",
  });
  // Darstellung ungespeichert gewechselt: der Standard folgt der gewählten
  // Darstellung, eine Abweichung davon wird gesetzt
  const inline = { name: "VHS", displayMode: "inline" };
  assert.deepEqual(keys.withChoice(inline, {}, "courseCards", "off"), {
    ...inline,
    courseCards: "off",
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
    keys.withChoice(invalid, invalid, "courseCards", "off"),
    invalid
  );
  assert.deepEqual(keys.withChoice(invalid, invalid, "courseCards", "auto"), {
    courseCards: "auto",
  });
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

// R4 (bewusst geändert): im Chatfenster ist „Nur Text mit Links“ der
// Standard (ohne Reihenfolge), in der Seite „Kurskarten“ mit „Karten
// zuerst“; der Standard-Button trägt „(Standard)“
test(
  "Aussehen: „Antworten mit Kursen“ in beiden Darstellungen mit dem Standard der Darstellung, vor der Zeile „Fest vorgegeben“",
  { skip },
  async () => {
    const bubble = await appearance({});
    let t = text(bubble);
    for (const label of [
      "Antworten mit Kursen",
      "Kurse anzeigen als",
      "Kurskarten",
      "Nur Text mit Links (Standard)",
      CARDS_HINT,
    ])
      assert.ok(t.includes(label), label);
    assert.ok(activeLabels(bubble).includes("Nur Text mit Links (Standard)"));
    assert.ok(!activeLabels(bubble).includes("Kurskarten"));
    assert.ok(!bubble.includes(">Reihenfolge<"));
    assert.ok(!t.includes(ORDER_HINT));
    assert.ok(t.indexOf("Antworten mit Kursen") < t.indexOf("Fest vorgegeben"));
    assert.doesNotMatch(t, /[–—]/);
    assert.ok(!t.includes("Knopf"));

    const inline = await appearance({ displayMode: "inline" });
    t = text(inline);
    for (const label of [
      "Kurskarten (Standard)",
      "Nur Text mit Links",
      "Reihenfolge",
      "Karten zuerst (Standard)",
      "Text zuerst",
      CARDS_HINT,
    ])
      assert.ok(t.includes(label), label);
    // S3 (rc10): kein Hinweis unter „Reihenfolge“
    assert.ok(!t.includes(ORDER_HINT));
    assert.ok(activeLabels(inline).includes("Kurskarten (Standard)"));
    assert.ok(activeLabels(inline).includes("Karten zuerst (Standard)"));
    assert.ok(!activeLabels(inline).includes("Nur Text mit Links"));
    assert.ok(!activeLabels(inline).includes("Text zuerst"));
    assert.ok(t.indexOf("Antworten mit Kursen") < t.indexOf("Fest vorgegeben"));
    assert.doesNotMatch(t, /[–—]/);
  }
);

test(
  "Aussehen: gespeicherte Wahl ist markiert; bei „Nur Text mit Links“ keine Reihenfolge",
  { skip },
  async () => {
    const below = await appearance({
      courseCards: "auto",
      courseCardsPosition: " BELOW ",
    });
    assert.ok(activeLabels(below).includes("Text zuerst"));
    assert.ok(activeLabels(below).includes("Kurskarten"));
    assert.ok(text(below).includes("Karten zuerst (Standard)"));

    const off = await appearance({
      displayMode: "inline",
      courseCards: "off",
      courseCardsPosition: "below",
    });
    const t = text(off);
    assert.ok(activeLabels(off).includes("Nur Text mit Links"));
    assert.ok(t.includes("Kurskarten (Standard)"));
    assert.ok(!off.includes(">Reihenfolge<"));
    assert.ok(!t.includes("Karten zuerst"));
    assert.ok(!t.includes(ORDER_HINT));
    // ungültig gespeichert: Standard der Darstellung markiert
    const invalid = await appearance({ courseCards: "kaputt" });
    assert.ok(activeLabels(invalid).includes("Nur Text mit Links (Standard)"));
    const invalidInline = await appearance({
      displayMode: "inline",
      courseCards: "kaputt",
    });
    assert.ok(activeLabels(invalidInline).includes("Kurskarten (Standard)"));
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

// R4 (bewusst geändert): ohne Wahl folgt die Vorschau dem Standard der
// Darstellung (Chatfenster Nur Text mit Links, In der Seite Karten zuerst)
test(
  "Vorschau (Bewusste Änderung E42: ohne gespeicherte Startvorschläge keine Pillen): Beispiel-Antwort folgt der Wahl (Karten zuerst, Text zuerst, Nur Text mit Links), Chatfenster und In der Seite",
  { skip },
  async () => {
    // Chatfenster ohne Wahl: Nur Text mit Links
    const bubble = await previewHtml({});
    assert.match(bubble, /data-course-cards="off"/);
    assert.equal((bubble.match(/data-preview="course-link"/g) || []).length, 2);
    // Standard der Vorbelegung ohne gespeicherte Startvorschläge (R5).
    // Bewusste Änderung E42 (7.22-rc23): der Standard ist leer, also keine
    // Pillen (bis 7.22-rc22 die zwei Beispiele); die Folgefrage ist kein
    // Startvorschlag und bleibt
    assert.equal((bubble.match(/data-preview="pill"/g) || []).length, 0);
    assert.match(bubble, /data-preview="follow-up-pill"/);
    assert.doesNotMatch(
      await previewHtml({ defaultMessages: [] }),
      /data-preview="pill"/
    );
    // eigene Liste: ihre Pillen
    assert.equal(
      (
        (await previewHtml({ defaultMessages: ["A?", "B?"] })).match(
          /data-preview="pill"/g
        ) || []
      ).length,
      2
    );

    // Kurskarten gewählt: Karten zuerst (In der Seite ohne Wahl ebenso, im
    // aufgeklappten Panel, siehe Test unten)
    const std = await previewHtml({ courseCards: "auto" });
    assert.match(std, /data-course-cards="auto"/);
    assert.match(std, /data-cards-position="above"/);
    assert.equal((std.match(/data-preview="course-card"/g) || []).length, 2);
    assert.ok(at(std, "course-cards") < at(std, "answer-text"));
    assert.ok(at(std, "answer-text") < at(std, "follow-ups"));
    assert.match(std, /data-preview="follow-up-pill"/);

    const below = await previewHtml({
      courseCards: "auto",
      courseCardsPosition: "below",
    });
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
    // R4: In der Seite ohne gespeicherte Wahl Kurskarten
    assert.equal(answer.getAttribute("data-course-cards"), "auto");
    assert.equal(answer.getAttribute("data-cards-position"), "below");
    const kinds = elements(answer, (el) =>
      ["answer-text", "course-cards"].includes(el.getAttribute("data-preview"))
    ).map((el) => el.getAttribute("data-preview"));
    assert.deepEqual(kinds, ["answer-text", "course-cards"]);
  }
);

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
  "Aussehen bedienen (Chatfenster): Standard anklicken ändert nichts; Kurskarten und Text zuerst speichern nur courseCards bzw. courseCardsPosition; Vorschau folgt",
  { skip },
  async (t) => {
    const stored = { accentColor: "#FFA102", name: "VHS" };
    const { container, act, calls } = await open(t, [widget(3, stored)], 3);
    // R4: im Chatfenster ohne Wahl Nur Text mit Links
    assert.equal(previewAttr(container, "data-course-cards"), "off");
    await act(() => click(button(container, "Nur Text mit Links (Standard)")));
    assert.ok(!unsaved(container), "Standard gewählt ist keine Änderung");

    await act(() => click(button(container, "Kurskarten")));
    assert.ok(unsaved(container));
    assert.equal(previewAttr(container, "data-course-cards"), "auto");
    assert.equal(previewAttr(container, "data-cards-position"), "above");
    await act(() => click(button(container, "Karten zuerst (Standard)")));
    assert.equal(previewAttr(container, "data-cards-position"), "above");
    await act(() => click(button(container, "Text zuerst")));
    assert.equal(previewAttr(container, "data-cards-position"), "below");
    await act(() => click(button(container, "Speichern")));
    assert.deepEqual(savedBody(calls), {
      ...stored,
      courseCards: "auto",
      courseCardsPosition: "below",
    });
    // zurück auf den Standard: gespeichert ist jetzt "auto", also wird
    // "off" als bewusste Wahl geschrieben (D6: Abweichung vom gespeicherten
    // Stand); die Reihenfolge verschwindet aus dem Reiter, bleibt gespeichert
    calls.length = 0;
    await act(() => click(button(container, "Nur Text mit Links (Standard)")));
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
  "Aussehen bedienen (R4): „(Standard)“ und Vorschau wechseln mit der Darstellung, solange nichts gespeichert ist",
  { skip },
  async (t) => {
    const { container, act, calls } = await open(t, [widget(7, null)], 7);
    assert.ok(button(container, "Nur Text mit Links (Standard)"));
    assert.equal(previewAttr(container, "data-course-cards"), "off");
    await act(() => click(button(container, "In der Seite")));
    assert.ok(button(container, "Kurskarten (Standard)"));
    assert.ok(button(container, "Nur Text mit Links"));
    // Vorschau „In der Seite“: Box aufklappen, dann die Beispiel-Antwort
    const expand = () =>
      elements(
        container,
        (el) => el.getAttribute("data-preview") === "inline-bar"
      )[0];
    await act(() =>
      click(elements(expand(), (el) => el.tagName === "BUTTON")[0])
    );
    assert.equal(previewAttr(container, "data-course-cards"), "auto");
    // In der Seite den Standard wählen: keine Wahl gespeichert
    await act(() => click(button(container, "Kurskarten (Standard)")));
    await act(() => click(button(container, "Speichern")));
    assert.deepEqual(savedBody(calls), { displayMode: "inline" });
    // Abweichung in der Seite: Nur Text mit Links wird gespeichert
    calls.length = 0;
    await act(() => click(button(container, "Nur Text mit Links")));
    assert.equal(previewAttr(container, "data-course-cards"), "off");
    await act(() => click(button(container, "Speichern")));
    assert.deepEqual(savedBody(calls), {
      displayMode: "inline",
      courseCards: "off",
    });
    // gespeicherte Wahl bleibt beim Wechsel der Darstellung
    await act(() => click(button(container, "Chatfenster")));
    assert.ok(button(container, "Nur Text mit Links (Standard)"));
    assert.equal(previewAttr(container, "data-course-cards"), "off");
    assert.ok(unsaved(container), "Darstellung geändert");
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
