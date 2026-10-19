// KIE-568 (Nutzer 15.10.2026, Mockup Ansicht 6): Reiter Inhalt, nur
// Chatblase: „Willkommensblasen anzeigen“, je Desktop und Handy Aus / Beim
// ersten Besuch / Bei jedem Besuch (welcomeBubblesDesktop,
// welcomeBubblesMobile "off"|"first"|"every"). Ohne gespeicherten Wert gilt
// "first" (wie bisher); gespeichert wird nur eine Abweichung (Regel D6). Die
// Vorschau zeigt bei Desktop „Aus“ keine Willkommensblasen.
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
    keys.WELCOME_BUBBLES_OPTIONS.map((o) => o.value),
    [...server.WELCOME_BUBBLES_VALUES]
  );
  assert.deepEqual(
    keys.WELCOME_BUBBLES_OPTIONS.map((o) => o.label),
    ["Aus", "Beim ersten Besuch", "Bei jedem Besuch"]
  );
  assert.deepEqual(
    keys.WELCOME_BUBBLES_DEVICES.map((d) => [d.key, d.label]),
    [
      ["welcomeBubblesDesktop", "Desktop"],
      ["welcomeBubblesMobile", "Handy"],
    ]
  );
});

test("wirksamer Wert wie im Server, fehlend oder ungültig = first", () => {
  for (const v of VALUES)
    for (const key of ["welcomeBubblesDesktop", "welcomeBubblesMobile"])
      assert.equal(
        keys.choiceValue({ [key]: v }, key),
        server.welcomeBubblesValue(v),
        `${key} ${JSON.stringify(v)}`
      );
  assert.equal(keys.choiceValue({}, "welcomeBubblesDesktop"), "first");
  assert.equal(keys.choiceValue({}, "welcomeBubblesMobile"), "first");
});

test("D6: Wahl des wirksamen gespeicherten Werts ist keine Änderung", () => {
  assert.deepEqual(
    keys.withChoice({}, {}, "welcomeBubblesMobile", "first"),
    {}
  );
  const off = keys.withChoice({}, {}, "welcomeBubblesDesktop", "off");
  assert.deepEqual(off, { welcomeBubblesDesktop: "off" });
  assert.deepEqual(
    keys.withChoice(off, {}, "welcomeBubblesDesktop", "first"),
    {}
  );
  // gespeichert ungültig (wirkt wie Standard): Standard wählen ändert nichts
  const invalid = { welcomeBubblesDesktop: "immer" };
  assert.deepEqual(
    keys.withChoice(invalid, invalid, "welcomeBubblesDesktop", "first"),
    invalid
  );
  assert.deepEqual(
    keys.withChoice(invalid, invalid, "welcomeBubblesDesktop", "every"),
    { welcomeBubblesDesktop: "every" }
  );
});

test("Speichern: cleanConfig lässt die Wahl unverändert", () => {
  const config = {
    welcomeBubblesDesktop: "off",
    welcomeBubblesMobile: "every",
  };
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

const contentProps = (config) => ({
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
  setChoice: noop,
  addListItem: noop,
  updateListItem: noop,
  removeListItem: noop,
});

const deviceBlock = (html, key) => {
  const at = html.indexOf(`data-device="${key}"`);
  assert.ok(at > 0, `${key} fehlt`);
  return html.slice(at, html.indexOf("</div></div>", at));
};

test(
  "Inhalt, Chatfenster: „Willkommensblasen anzeigen“ unter den Willkommensblasen, Desktop und Handy, Standard erster Besuch, Hinweistext",
  { skip },
  async () => {
    const html = await renderer.render(CONTENT, {
      location: "/",
      props: contentProps({ chatbotBubblesMessages: ["Hallo!"] }),
    });
    const t = text(html);
    // Reihenfolge seit R6 (7.22-rc8): Startvorschläge vor der Gruppe
    // „Geschlossener Chat“ mit den Willkommensblasen
    const order = [
      "Startvorschläge",
      "Geschlossener Chat",
      "Willkommensblasen",
      "Willkommensblasen anzeigen",
      "Desktop",
      "Handy",
      "„Beim ersten Besuch“: Die Blasen erscheinen einmal",
    ];
    let pos = -1;
    for (const label of order) {
      const next = t.indexOf(label, pos + 1);
      assert.ok(next > pos, `${label} fehlt oder steht falsch`);
      pos = next;
    }
    for (const key of ["welcomeBubblesDesktop", "welcomeBubblesMobile"]) {
      const block = deviceBlock(html, key);
      for (const label of ["Aus", "Beim ersten Besuch", "Bei jedem Besuch"])
        assert.ok(block.includes(`>${label}<`), `${key} ${label}`);
      assert.deepEqual(activeLabels(block), ["Beim ersten Besuch"]);
    }
    for (const part of [
      "„Beim ersten Besuch“: Die Blasen erscheinen einmal; nach dem Schließen oder Öffnen des Chats nicht mehr (wie bisher).",
      "„Bei jedem Besuch“: bei jedem neuen Besuch wieder, also in jedem neuen Browser-Tab; beim Wechsel auf eine andere Seite im selben Tab nicht erneut.",
      "„Aus“: keine Blasen, nur der Chat-Button.",
    ])
      assert.ok(t.includes(part), part);
    assert.doesNotMatch(t, /[–—]/);
    assert.ok(!t.includes("Chat-Knopf"));
  }
);

test(
  "Inhalt: gespeicherte Wahl je Gerät markiert; bei Inline kein Abschnitt",
  { skip },
  async () => {
    const html = await renderer.render(CONTENT, {
      location: "/",
      props: contentProps({
        welcomeBubblesDesktop: "off",
        welcomeBubblesMobile: " Every ",
      }),
    });
    assert.deepEqual(activeLabels(deviceBlock(html, "welcomeBubblesDesktop")), [
      "Aus",
    ]);
    assert.deepEqual(activeLabels(deviceBlock(html, "welcomeBubblesMobile")), [
      "Bei jedem Besuch",
    ]);
    const inline = text(
      await renderer.render(CONTENT, {
        location: "/",
        props: contentProps({ displayMode: "inline" }),
      })
    );
    assert.ok(!inline.includes("Willkommensblasen anzeigen"));
    assert.ok(!inline.includes("Beim ersten Besuch"));
  }
);

// ---------------------------------------------------------------------------
// Vorschau
// ---------------------------------------------------------------------------

async function closedBubbles(t, config) {
  const mounted = await renderer.mount(PREVIEW, {
    location: "/",
    props: {
      config,
      logoPreview: null,
      defaults: DEFAULTS,
      greetingKey: "greeting",
    },
  });
  t.after(() => mounted.unmount());
  const { container, act } = mounted;
  const close = elements(
    container,
    (el) =>
      el.tagName === "BUTTON" &&
      el.getAttribute("aria-label") === "Chat schließen"
  )[0];
  await act(() => click(close));
  const bubbles = elements(
    container,
    (el) => el.getAttribute("data-preview") === "welcome-bubble"
  ).map((el) => el.textContent);
  const note = elements(
    container,
    (el) => el.getAttribute("data-preview") === "welcome-bubbles-note"
  ).length;
  return { bubbles, note };
}

test(
  "Vorschau Chatfenster geschlossen: Desktop „Aus“ = keine Willkommensblasen, sonst eigene bzw. Standardblasen",
  { skip },
  async (t) => {
    assert.deepEqual(
      (await closedBubbles(t, { welcomeBubblesDesktop: "off" })).bubbles,
      []
    );
    assert.deepEqual(
      (
        await closedBubbles(t, {
          welcomeBubblesDesktop: "off",
          chatbotBubblesMessages: ["Hallo!"],
        })
      ).bubbles,
      []
    );
    for (const welcomeBubblesDesktop of [undefined, "first", "every"])
      assert.deepEqual(
        (
          await closedBubbles(t, {
            welcomeBubblesDesktop,
            chatbotBubblesMessages: ["Hallo!", " "],
          })
        ).bubbles,
        ["Hallo!"]
      );
    // ohne eigene Texte: die Standardblasen wie im Widget
    assert.deepEqual(
      (await closedBubbles(t, {})).bubbles,
      keys.DEFAULT_WELCOME_BUBBLES
    );
    // Hinweis nur, wenn Desktop und Handy verschieden eingestellt sind
    assert.equal((await closedBubbles(t, {})).note, 0);
    assert.equal(
      (await closedBubbles(t, { welcomeBubblesMobile: "off" })).note,
      1
    );
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

test(
  "Inhalt bedienen: Desktop Aus und Handy Bei jedem Besuch speichern nur diese Schlüssel; Standard anklicken ändert nichts",
  { skip },
  async (t) => {
    const { container, act, calls } = await open(
      t,
      [widget(8, null)],
      8,
      "Inhalt"
    );
    const device = (key) =>
      elements(container, (el) => el.getAttribute("data-device") === key)[0];
    await act(() =>
      click(button(device("welcomeBubblesDesktop"), "Beim ersten Besuch"))
    );
    assert.ok(!unsaved(container));
    await act(() => click(button(device("welcomeBubblesDesktop"), "Aus")));
    await act(() =>
      click(button(device("welcomeBubblesMobile"), "Bei jedem Besuch"))
    );
    assert.ok(unsaved(container));
    await act(() => click(button(container, "Speichern")));
    assert.deepEqual(savedBody(calls), {
      welcomeBubblesDesktop: "off",
      welcomeBubblesMobile: "every",
    });
  }
);
