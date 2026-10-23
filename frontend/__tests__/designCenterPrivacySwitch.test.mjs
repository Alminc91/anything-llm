// KIE-565 Nachtrag (Nutzer 15.10.2026): Datenschutz-Hinweis im Design
// Center abschaltbar. Schalter „Datenschutz-Hinweis anzeigen“ im Reiter
// Inhalt, Standard an; gespeichert im vorhandenen Schlüssel privacyNotice
// (aus = "none", an = "bubble"), nur bei Änderung (Regel D6). Aus: Felder
// Überschrift, Link und Text ausgegraut, ihre gespeicherten Werte bleiben;
// die Vorschau zeigt nur die Begrüßungsblase.
//
// Reine Logik (widgetKeys.js) gegen den Server-Code, Darstellung
// serverseitig gerendert, Speichern mit eingehängter Seite und ersetztem
// fetch (wie designCenterStandardSave.test.mjs).
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

const SWITCH_LABEL = "Datenschutz-Hinweis anzeigen";
const RECOMMENDATION =
  "Wir empfehlen, den Hinweis anzuzeigen. Er informiert Besucher, wie mit ihren Anfragen umgegangen wird.";

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
    .replace(/\s+/g, " ")
    .trim();

// ---------------------------------------------------------------------------
// Logik
// ---------------------------------------------------------------------------

const NOTICE_VALUES = [
  undefined,
  null,
  "",
  "none",
  " NONE ",
  "bubble",
  "modal",
  "aus",
  false,
  0,
];

test("an/aus wie im Server: nur none ist aus, fehlend und Altwert modal sind an", () => {
  for (const privacyNotice of NOTICE_VALUES)
    assert.equal(
      keys.privacyNoticeOn({ privacyNotice }),
      server.privacyNoticeValue(privacyNotice) === "bubble",
      String(privacyNotice)
    );
  assert.equal(keys.privacyNoticeOn({}), true);
  assert.equal(keys.privacyNoticeOn({ privacyNotice: "modal" }), true);
  assert.equal(keys.privacyNoticeOn({ privacyNotice: "none" }), false);
  // leerer Text heißt weiter Standardtext, nicht aus
  assert.equal(
    keys.privacyNoticeOn({ privacyText: "", privacyTitle: "" }),
    true
  );
});

test("Schalter: aus schreibt none; wieder an stellt den gespeicherten Stand her (keine ungefragte Änderung)", () => {
  // ohne gespeicherten Wert
  const off = keys.withPrivacyNotice({ name: "VHS" }, {}, false);
  assert.deepEqual(off, { name: "VHS", privacyNotice: "none" });
  assert.deepEqual(keys.withPrivacyNotice(off, {}, true), { name: "VHS" });
  // gespeicherter Altwert modal bleibt beim Wieder-Einschalten stehen
  const legacy = { privacyNotice: "modal" };
  assert.deepEqual(
    keys.withPrivacyNotice(
      keys.withPrivacyNotice(legacy, legacy, false),
      legacy,
      true
    ),
    legacy
  );
  // gespeichert aus: an = bubble
  assert.deepEqual(
    keys.withPrivacyNotice(
      { privacyNotice: "none" },
      { privacyNotice: "none" },
      true
    ),
    { privacyNotice: "bubble" }
  );
});

test("Speichern bei ausgeschaltetem Hinweis: Überschrift, Text und Link bleiben wie gespeichert", () => {
  const stored = {
    name: "VHS",
    privacyTitle: "Hinweis",
    privacyText: "Punkt eins\nPunkt zwei",
    privacyUrl: "/datenschutz",
  };
  // Eingaben vor dem Ausschalten (auch ungültige) werden nicht geschrieben
  const edited = {
    ...stored,
    privacyNotice: "none",
    privacyTitle: "  Neu  ",
    privacyText: "x".repeat(2000),
    privacyUrl: "javascript:alert(1)",
  };
  const opts = { initial: stored, defaults: DEFAULTS, greetingKey: "greeting" };
  assert.deepEqual(keys.validateConfig(edited, stored, "greeting"), {});
  assert.deepEqual(keys.cleanConfig(edited, opts), {
    ...stored,
    privacyNotice: "none",
  });
  // nicht gespeicherte Felder kommen auch nicht dazu
  assert.deepEqual(
    keys.cleanConfig(
      { privacyNotice: "none", privacyText: "neu" },
      { initial: {}, defaults: DEFAULTS, greetingKey: "greeting" }
    ),
    { privacyNotice: "none" }
  );
  // an: Prüfung und Bereinigung wie bisher
  const on = { ...edited, privacyNotice: "bubble" };
  const errors = keys.validateConfig(on, stored, "greeting");
  assert.ok(errors.privacyText);
  assert.ok(errors.privacyUrl);
});

// ---------------------------------------------------------------------------
// Darstellung
// ---------------------------------------------------------------------------

const contentProps = (config, initialConfig = config) => ({
  config,
  initialConfig,
  errors: {},
  defaults: DEFAULTS,
  defaultsError: false,
  greetingKey: "greeting",
  updateField: noop,
  updateOptionalField: noop,
  resetKeys: noop,
  setPrivacyNotice: noop,
  addListItem: noop,
  updateListItem: noop,
  removeListItem: noop,
});

// Kontrollkästchen des Schalters (Toggle) im gerenderten HTML: das einzige
// <input> im Block data-privacy-switch
const switchInput = (html) => {
  const at = html.indexOf("data-privacy-switch");
  assert.ok(at > 0, "Schalter fehlt");
  const block = html.slice(at, html.indexOf("</label>", at));
  assert.ok(block.includes(`>${SWITCH_LABEL}<`), "Beschriftung fehlt");
  const input = block.slice(block.indexOf("<input"));
  return input.slice(0, input.indexOf(">") + 1);
};
const fieldset = (html) => {
  const m = html.match(/<fieldset[^>]*data-privacy-fields="[^"]*"[^>]*>/);
  assert.ok(m, "Feldgruppe fehlt");
  return m[0];
};

test(
  "Inhalt: Schalter mit Empfehlung, Standard an; Felder bedienbar",
  { skip },
  async () => {
    for (const config of [
      {},
      { privacyNotice: "bubble" },
      { privacyNotice: "modal" },
    ]) {
      const html = await renderer.render(CONTENT, {
        location: "/",
        props: contentProps(config),
      });
      const t = text(html);
      assert.ok(t.includes(SWITCH_LABEL));
      assert.ok(t.includes(RECOMMENDATION));
      assert.match(switchInput(html), /type="checkbox"/);
      assert.match(switchInput(html), /checked=""/);
      assert.doesNotMatch(fieldset(html), /disabled=""/);
      assert.match(fieldset(html), /data-privacy-fields="on"/);
      // Schalter steht über den Feldern des Hinweises
      assert.ok(
        t.indexOf(SWITCH_LABEL) < t.indexOf("Link zur Datenschutzerklärung")
      );
      assert.ok(
        t.includes("Der Datenschutz-Hinweis folgt als eigene, zweite Blase.")
      );
      assert.ok(!t.includes("Immer sichtbar"));
    }
  }
);

test(
  "Inhalt: Hinweis aus -> Schalter aus, Felder ausgegraut und gesperrt, gespeicherte Werte stehen weiter darin",
  { skip },
  async () => {
    const html = await renderer.render(CONTENT, {
      location: "/",
      props: contentProps({
        privacyNotice: "none",
        privacyTitle: "Hinweis",
        privacyUrl: "/datenschutz",
        privacyText: "• Eigener Punkt",
      }),
    });
    const t = text(html);
    assert.doesNotMatch(switchInput(html), /checked/);
    assert.match(fieldset(html), /disabled=""/);
    assert.match(fieldset(html), /opacity-40/);
    assert.match(fieldset(html), /data-privacy-fields="off"/);
    assert.match(html, /value="Hinweis"/);
    assert.match(html, /value="\/datenschutz"/);
    assert.ok(t.includes("• Eigener Punkt"));
    assert.ok(t.includes("bleiben gespeichert"));
    assert.ok(
      !t.includes("Der Datenschutz-Hinweis folgt als eigene, zweite Blase.")
    );
    // keine Gedankenstriche in den neuen Texten
    assert.doesNotMatch(t, /[–—]/);
  }
);

test(
  "Vorschau: aus -> nur die Begrüßungsblase, an oder fehlend oder modal -> beide Blasen",
  { skip },
  async () => {
    const preview = (config) =>
      renderer.render(PREVIEW, {
        location: "/",
        props: {
          config,
          logoPreview: null,
          defaults: DEFAULTS,
          greetingKey: "greeting",
        },
      });
    const off = await preview({
      privacyNotice: "none",
      privacyUrl: "/datenschutz",
    });
    assert.match(off, /data-preview="greeting-bubble"/);
    assert.doesNotMatch(off, /data-preview="privacy-bubble"/);
    assert.ok(!text(off).includes("Datenschutzerklärung"));
    for (const config of [
      {},
      { privacyNotice: "bubble" },
      { privacyNotice: "modal" },
    ])
      assert.match(await preview(config), /data-preview="privacy-bubble"/);
  }
);

test(
  "Vorschau Inline aufgeklappt: aus -> keine Datenschutz-Blase",
  { skip },
  async (t) => {
    const mounted = await renderer.mount(PREVIEW, {
      location: "/",
      props: {
        config: { displayMode: "inline", privacyNotice: "none" },
        logoPreview: null,
        defaults: DEFAULTS,
        greetingKey: "greeting",
      },
    });
    t.after(() => mounted.unmount());
    const { container } = mounted;
    // startet aufgeklappt (7.22.1, Spezifikation §12 Eintrag 12)
    assert.equal(
      elements(
        container,
        (el) => el.getAttribute("data-preview") === "inline-bar"
      ).length,
      0
    );
    const panel = elements(
      container,
      (el) => el.getAttribute("data-preview") === "inline-panel"
    )[0];
    assert.ok(panel);
    assert.equal(
      elements(
        panel,
        (el) => el.getAttribute("data-preview") === "greeting-bubble"
      ).length,
      1
    );
    assert.equal(
      elements(
        panel,
        (el) => el.getAttribute("data-preview") === "privacy-bubble"
      ).length,
      0
    );
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

async function open(t, embeds, id) {
  const calls = stubServer(t, embeds);
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
const privacySwitch = (container) => {
  const block = elements(container, (el) =>
    el.hasAttribute?.("data-privacy-switch")
  )[0];
  if (!block || !block.textContent.includes(SWITCH_LABEL)) return undefined;
  return elements(
    block,
    (el) => el.tagName === "INPUT" && el.getAttribute("type") === "checkbox"
  )[0];
};
const savedBody = (calls) => {
  const call = calls.find((c) => c.url.includes("/embed/update/"));
  return call ? JSON.parse(call.body.visual_config) : null;
};
const previewBubbles = (container, kind) =>
  elements(container, (el) => el.getAttribute("data-preview") === kind).length;
const toggle = (container, checked) =>
  handlersOf(privacySwitch(container)).onChange({ target: { checked } });

// Bestandskunde mit eigenem Datenschutz-Text und dem Altwert "modal"
const STORED = {
  accentColor: "#FFA102",
  name: "VHS",
  privacyNotice: "modal",
  privacyTitle: "Hinweis",
  privacyText: "Punkt eins\nPunkt zwei",
  privacyUrl: "/datenschutz",
  privacyButtonText: "OK",
};

test(
  "Ausschalten: Vorschau ohne Datenschutz-Blase, Speichern schreibt nur privacyNotice none",
  { skip },
  async (t) => {
    const { container, act, calls } = await open(t, [widget(4, STORED)], 4);
    assert.ok(privacySwitch(container), "Schalter fehlt");
    assert.equal(previewBubbles(container, "privacy-bubble"), 1);
    await act(() => toggle(container, false));
    assert.equal(previewBubbles(container, "privacy-bubble"), 0);
    assert.equal(previewBubbles(container, "greeting-bubble"), 1);
    assert.ok(container.textContent.includes("Ungespeicherte Änderungen"));
    await act(() => click(button(container, "Speichern")));
    assert.deepEqual(savedBody(calls), { ...STORED, privacyNotice: "none" });
  }
);

test(
  "D6: neues Widget öffnet ohne Änderung; aus und wieder an ist keine Änderung; aus speichert nur privacyNotice",
  { skip },
  async (t) => {
    const { container, act, calls } = await open(t, [widget(9, null)], 9);
    assert.ok(!container.textContent.includes("Ungespeicherte Änderungen"));
    await act(() => toggle(container, false));
    assert.ok(container.textContent.includes("Ungespeicherte Änderungen"));
    await act(() => toggle(container, true));
    assert.ok(!container.textContent.includes("Ungespeicherte Änderungen"));
    await act(() => toggle(container, false));
    await act(() => click(button(container, "Speichern")));
    assert.deepEqual(savedBody(calls), { privacyNotice: "none" });
  }
);

test(
  "gespeichert aus: Einschalten speichert bubble, sonst nichts",
  { skip },
  async (t) => {
    const stored = { ...STORED, privacyNotice: "none" };
    const { container, act, calls } = await open(t, [widget(5, stored)], 5);
    assert.equal(previewBubbles(container, "privacy-bubble"), 0);
    await act(() => toggle(container, true));
    assert.equal(previewBubbles(container, "privacy-bubble"), 1);
    await act(() => click(button(container, "Speichern")));
    assert.deepEqual(savedBody(calls), { ...STORED, privacyNotice: "bubble" });
  }
);

test(
  "Eingabe im Text, dann ausgeschaltet: gespeichert bleibt der alte Text, nur privacyNotice ändert sich",
  { skip },
  async (t) => {
    const { container, act, calls } = await open(t, [widget(4, STORED)], 4);
    const textarea = elements(
      container,
      (el) => el.getAttribute("aria-label") === "Text des Datenschutz-Hinweises"
    )[0];
    await act(() =>
      handlersOf(textarea).onChange({ target: { value: "x".repeat(2000) } })
    );
    await act(() => toggle(container, false));
    await act(() => click(button(container, "Speichern")));
    assert.deepEqual(savedBody(calls), { ...STORED, privacyNotice: "none" });
  }
);
