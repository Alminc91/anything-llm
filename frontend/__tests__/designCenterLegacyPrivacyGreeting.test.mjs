// E43 (Nutzerentscheidung 22.10.2026, „Alte Vorlage als nicht gesetzt“,
// 7.22-rc24): Eine gespeicherte Begrüßung, die nach Normalisierung von
// Leerraum genau einer unserer alten Datenschutz-Vorlagen entspricht
// (server/utils/chats/embedStandards.js LEGACY_PRIVACY_GREETINGS), gilt im
// Design Center wie nicht gesetzt: Der Reiter Inhalt zeigt den Standard
// vorbelegt, die Vorschau ebenso, und gespeichert wird nur bei Änderung.
// Gleiche Regel wie im Server (Vergleich gegen den Server-Code), sonst
// zeigte das Design Center etwas anderes als das Widget.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import * as keys from "../src/pages/GeneralSettings/ChatEmbedWidgets/EmbedAppearance/widgetKeys.js";
import {
  createRenderer,
  hasFrontendDeps,
} from "./helpers/renderSettingsPage.mjs";
import { click, elements, handlersOf } from "./helpers/testDom.mjs";

const require = createRequire(import.meta.url);
const server = require("../../server/utils/chats/embedStandards.js");
const {
  embedDefaultTexts,
} = require("../../server/utils/chats/embedDefaults.js");
const DE = embedDefaultTexts("de");
const EN = embedDefaultTexts("en");
const NBSP = String.fromCharCode(0xa0);

const JUNE =
  "Dieser Chatbot nutzt künstliche Intelligenz (KI). Ihre Nachrichten werden nicht an Dritte weitergegeben, können aber zur Qualitätssicherung von uns eingesehen werden. Bitte geben Sie keine sensiblen personenbezogenen Daten ein.";
const PRE_E30 =
  "Ihre Anfragen bleiben auf Servern in Deutschland und werden nicht an Dritte weitergegeben. Mitarbeitende der Einrichtung können Gespräche zur Qualitätssicherung einsehen. Bitte teilen Sie nur Angaben, die für Ihre Anfrage nötig sind.";
const OLD_BUBBLE =
  "Hallo! Ich bin Ihr digitaler Berater mit künstlicher Intelligenz (KI). Beschreiben Sie einfach, was Sie suchen.";

const variants = (text) => [
  text,
  text.replace(/([.!?]) /g, "$1\n"),
  `  ${text.replace(/ /g, "  ")}\n`,
  text.replace(/ /g, NBSP),
  `\t${text.replace(/([.!?]) /g, "$1\r\n\r\n")} `,
];

// gespeicherte Stände mit einer Vorlage (wie in der Flotte, dazu
// Leerraum-Varianten); der Demo-Fall mit altem Blasentext und Datenschutz
// in der Blase
const STORED_LEGACY = [
  ...[JUNE, PRE_E30].flatMap((text) =>
    variants(text).flatMap((v) => [
      { greeting: v },
      { greeting: v, privacyNotice: "bubble" },
      { greetingBubbleText: v, privacyNotice: "bubble" },
      { greeting: v, greetingBubbleText: OLD_BUBBLE, privacyNotice: "bubble" },
      { greeting: v, greetingStyle: "text", privacyNotice: "none" },
    ])
  ),
  {
    displayMode: "inline",
    privacyNotice: "bubble",
    privacyText: PRE_E30.replace(/\. /g, ".\n"),
    greeting: PRE_E30,
    greetingBubbleText: OLD_BUBBLE,
  },
];

const OWN = [
  "Willkommen bei der VHS!",
  `${JUNE} Willkommen bei der VHS!`,
  JUNE.replace("von uns", "von der VHS"),
  PRE_E30.replace("Mitarbeitende", "Mitarbeiter"),
  "Dieser Chatbot nutzt künstliche Intelligenz (KI). Bitte geben Sie keine sensiblen Daten ein.",
  DE.greeting,
  EN.greeting,
];

test("E43: Erlaubnisliste und Erkennung wortgleich mit dem Server", () => {
  assert.deepEqual(keys.LEGACY_PRIVACY_GREETINGS, [
    ...server.LEGACY_PRIVACY_GREETINGS,
  ]);
  assert.equal(keys.LEGACY_PRIVACY_GREETINGS.length, 2);
  const cases = [
    ...server.LEGACY_PRIVACY_GREETINGS.flatMap(variants),
    ...server.LEGACY_DEFAULT_GREETINGS.flatMap(variants),
    ...OWN,
    "",
    "   ",
    undefined,
    null,
    7,
    ["x"],
  ];
  for (const value of cases)
    assert.equal(
      keys.isLegacyGreeting(value),
      server.isLegacyGreeting(value),
      String(value).slice(0, 30)
    );
  // Feld und Vorschau zeigen, was das Widget zeigt: ohne eigene Begrüßung
  // vom Server den Standard, sonst den Text des Servers
  for (const stored of [
    ...STORED_LEGACY,
    ...OWN.map((greeting) => ({ greeting })),
    ...OWN.map((own) => ({
      greeting: JUNE.replace(/\. /g, ".\n"),
      greetingBubbleText: own,
      privacyNotice: "bubble",
    })),
  ]) {
    const live = server.effectiveGreeting(stored);
    const field = keys.greetingFieldValue(stored, keys.greetingKey(stored), DE);
    assert.equal(field.trim(), live ?? DE.greeting, JSON.stringify(stored));
  }
});

test("E43: Reiter Inhalt zeigt bei einer Vorlage den Standard der Sprache vorbelegt (de und en), auch in der Vorschau", () => {
  for (const stored of STORED_LEGACY) {
    const key = keys.greetingKey(stored);
    assert.equal(key, "greeting", JSON.stringify(stored));
    for (const defaults of [DE, EN]) {
      assert.equal(
        keys.greetingFieldValue(stored, key, defaults),
        defaults.greeting
      );
      assert.equal(
        keys.previewGreeting(stored, key, defaults),
        defaults.greeting
      );
    }
  }
  // eigene Texte bleiben im Feld (wie gespeichert)
  for (const own of OWN)
    for (const defaults of [DE, EN])
      assert.equal(
        keys.greetingFieldValue({ greeting: own }, "greeting", defaults),
        own
      );
  // Vorlage neben eigenem Blasentext: der eigene Text gilt und steht im Feld
  const mixed = {
    greeting: JUNE.replace(/ /g, "  "),
    greetingBubbleText: "Eigene Blase",
    greetingStyle: "text",
  };
  assert.equal(keys.greetingKey(mixed), "greetingBubbleText");
  assert.equal(
    keys.greetingFieldValue(mixed, "greetingBubbleText", DE),
    "Eigene Blase"
  );
});

test("E43: Speichern nur bei Änderung; die gespeicherte Vorlage bleibt wörtlich, bis der Kunde das Feld ändert", () => {
  for (const stored of STORED_LEGACY) {
    const greetingKey = keys.greetingKey(stored);
    const opts = { initial: stored, defaults: DE, greetingKey };
    // unverändert: alles bleibt wörtlich (auch Leerraum der Vorlage), also
    // keine „Ungespeicherten Änderungen“
    assert.deepEqual(keys.cleanConfig({ ...stored }, opts), stored);
    // eigener Text: wird getrimmt gespeichert, die Vorlage im anderen Feld
    // bleibt (sie gilt nicht)
    const own = keys.cleanConfig(
      { ...stored, [greetingKey]: "  Willkommen bei der VHS!  " },
      opts
    );
    assert.equal(own[greetingKey], "Willkommen bei der VHS!");
    assert.equal(server.effectiveGreeting(own), "Willkommen bei der VHS!");
    // auf den Standard gebracht oder geleert: Schlüssel entfällt, live der
    // Standard
    for (const value of [DE.greeting, "", "  "]) {
      const reset = keys.cleanConfig({ ...stored, [greetingKey]: value }, opts);
      assert.ok(!(greetingKey in reset), JSON.stringify(stored));
      assert.equal(server.effectiveGreeting(reset), null);
    }
  }
});

// Ansicht und Speichern mit der echten Seite (ohne Browser)
const skip = hasFrontendDeps
  ? false
  : "frontend/node_modules nicht installiert";
const DIR = "/src/pages/GeneralSettings/ChatEmbedWidgets/EmbedAppearance";
const CONTENT = `${DIR}/ContentTab.jsx`;
const DESIGN_CENTER = `${DIR}/index.jsx`;

let renderer;
before(async () => {
  if (hasFrontendDeps) renderer = await createRenderer();
});
after(async () => {
  await renderer?.close();
});

const noop = () => {};
const unescape = (s) =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&");
const greetingFieldHtml = (html) => {
  const m =
    /<textarea[^>]*aria-label="Begrüßungstext"[^>]*>([\s\S]*?)<\/textarea>/.exec(
      html
    );
  assert.ok(m, "Feld Begrüßungstext");
  return unescape(m[1]);
};

test(
  "E43: Reiter Inhalt (gerendert) zeigt den Standard statt der Vorlage, in de und en",
  { skip },
  async () => {
    for (const stored of STORED_LEGACY.filter((_, i) => i % 3 === 0))
      for (const defaults of [DE, EN]) {
        const html = await renderer.render(CONTENT, {
          location: "/",
          props: {
            config: stored,
            initialConfig: stored,
            errors: {},
            defaults,
            defaultsError: false,
            greetingKey: keys.greetingKey(stored),
            updateField: noop,
            updateOptionalField: noop,
            resetKeys: noop,
            setPrivacyNotice: noop,
            addListItem: noop,
            updateListItem: noop,
            removeListItem: noop,
          },
        });
        assert.equal(greetingFieldHtml(html), defaults.greeting);
      }
  }
);

const widget = (id, visualConfig) => ({
  id,
  uuid: `uuid-${id}`,
  enabled: true,
  chat_mode: "query",
  allowlist_domains: null,
  chat_retention_days: null,
  visual_config: JSON.stringify(visualConfig),
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
      answer = { lang: "de", defaults: DE };
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
  return { ...mounted, calls };
}
const buttons = (container, label) =>
  elements(
    container,
    (el) => el.tagName === "BUTTON" && el.textContent.trim() === label
  );
const byLabel = (container, label) =>
  elements(container, (el) => el.getAttribute("aria-label") === label)[0];
const savedBody = (calls) => {
  const call = calls.find((c) => c.url.includes("/embed/update/"));
  return call ? JSON.parse(call.body.visual_config) : null;
};

for (const [name, stored] of [
  [
    "Juni-Vorlage mit Zeilenumbrüchen",
    { accentColor: "#FFA102", greeting: `${JUNE.replace(/\. /g, ".\n")}\n` },
  ],
  [
    "Demo-Fall (früherer Datenschutztext, alter Blasentext, Datenschutz in der Blase)",
    {
      accentColor: "#FFA102",
      displayMode: "inline",
      privacyNotice: "bubble",
      privacyText: PRE_E30.replace(/\. /g, ".\n"),
      greeting: PRE_E30,
      greetingBubbleText: OLD_BUBBLE,
    },
  ],
])
  test(
    `E43: Design Center mit ${name}: Standard vorbelegt, nicht ungespeichert, Speichern schreibt die Begrüßung nur nach Änderung`,
    { skip },
    async (t) => {
      const { container, act, calls } = await open(t, [widget(7, stored)], 7);
      assert.ok(!container.textContent.includes("Ungespeicherte Änderungen"));
      await act(() => click(buttons(container, "Inhalt")[0]));
      const field = () => byLabel(container, "Begrüßungstext");
      assert.equal(field().textContent || field().value, DE.greeting);
      // Vorschau: im Chatfenster die Begrüßungsblase mit dem Standard (die
      // eingeklappte Inline-Leiste zeigt keine Begrüßung, dort prüft der
      // Logik-Test previewGreeting)
      const bubbles = elements(
        container,
        (el) => el.getAttribute("data-preview") === "greeting-bubble"
      );
      if (stored.displayMode !== "inline") assert.ok(bubbles.length > 0);
      for (const bubble of bubbles)
        assert.equal(bubble.textContent.trim(), DE.greeting);
      assert.ok(!container.textContent.includes("Ungespeicherte Änderungen"));

      // anderes Feld ändern: die gespeicherte Vorlage bleibt wörtlich
      const nameField = byLabel(container, "Name des Chatbots");
      await act(() =>
        handlersOf(nameField).onChange({ target: { value: "VHS Rhein" } })
      );
      await act(() => click(buttons(container, "Speichern")[0]));
      assert.deepEqual(savedBody(calls), { ...stored, name: "VHS Rhein" });

      // Begrüßung ändern: erst dann wird sie geschrieben
      calls.length = 0;
      await act(() =>
        handlersOf(field()).onChange({
          target: { value: " Willkommen bei der VHS! " },
        })
      );
      assert.ok(container.textContent.includes("Ungespeicherte Änderungen"));
      await act(() => click(buttons(container, "Speichern")[0]));
      const body = savedBody(calls);
      assert.equal(body.greeting, "Willkommen bei der VHS!");
      assert.equal(server.effectiveGreeting(body), "Willkommen bei der VHS!");
    }
  );
