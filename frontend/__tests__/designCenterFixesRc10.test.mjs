// Korrekturrunde 7.22-rc10 (Fixliste fixliste-7.22-rc10.md), Fork-Teil:
// S1 Die Standard-Startvorschläge kommen vom Server (embedDefaults.js
//    DEFAULT_SUGGESTIONS, über GET /embed/defaults als defaults.defaultMessages)
//    und gelten auch live (GET /embed/:id/config ohne gespeicherte Liste); das
//    Design Center zeigt sie als Vorbelegung, die Kopie DEFAULT_SUGGESTIONS in
//    widgetKeys.js ist nur der Rückfall, solange die Standardtexte nicht
//    geladen sind (Vertrag: wörtlich gleich).
// S2 Die Skriptzeile im Reiter Einbau bricht nur noch nach „/“ um: jeder Teil
//    ein nicht umbrechendes Stück (whitespace-pre), kein <wbr> nach „.“ oder
//    „-“, die Box ohne break-all, der Text unverändert.
// S3 Hinweise im Reiter Aussehen gekürzt: Logo, Farbschema, Position und
//    Reihenfolge ohne Hinweis; „Schrift auf der Akzentfarbe“ nur Empfehlung
//    (und ggf. Warnung); „Kurse anzeigen als“ eine Zeile; Darstellung,
//    Akzentfarbe und Chat-Icon behalten ihren Hinweis.
// S4 (englische Gedankenstriche) steht in analyticsNoDashes.test.mjs.
// Maße im Browser (Reiter Aussehen bei 1440×900 ohne Scrollen, Skriptzeile bei
// 1440 und 1280): .test-storage/rc10/rc10_check.py (Playwright) mit
// .test-storage/rc10/harness.mjs.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  createRenderer,
  hasFrontendDeps,
} from "./helpers/renderSettingsPage.mjs";
import * as keys from "../src/pages/GeneralSettings/ChatEmbedWidgets/EmbedAppearance/widgetKeys.js";

const DIR = "/src/pages/GeneralSettings/ChatEmbedWidgets/EmbedAppearance";
const APPEARANCE = `${DIR}/AppearanceTab.jsx`;
const CONTENT = `${DIR}/ContentTab.jsx`;
const PREVIEW = `${DIR}/WidgetPreview.jsx`;
const EMBED = `${DIR}/EmbedTab.jsx`;
const skip = hasFrontendDeps
  ? false
  : "frontend/node_modules nicht installiert";

const require = createRequire(import.meta.url);
const {
  DEFAULT_SUGGESTIONS,
  embedDefaultTexts,
  defaultSuggestions,
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
    .replace(/<wbr\/?>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
const show = (modulePath, props) =>
  renderer.render(modulePath, { location: "/", props });
const appearance = (config) =>
  show(APPEARANCE, {
    config,
    updateField: noop,
    setChoice: noop,
    logoPreview: null,
  });
const contentProps = (config, defaults) => ({
  config,
  initialConfig: config,
  errors: {},
  defaults,
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

// ---------------------------------------------------------------------------
// S1 Startvorschläge: eine Quelle (Server)
// ---------------------------------------------------------------------------

test("S1: Vorbelegung der Startvorschläge wörtlich wie DEFAULT_SUGGESTIONS.de des Servers (Vertrag), englische vorhanden", () => {
  assert.deepEqual(DEFAULTS.defaultMessages, keys.DEFAULT_SUGGESTIONS);
  assert.deepEqual([...DEFAULT_SUGGESTIONS.de], keys.DEFAULT_SUGGESTIONS);
  assert.deepEqual(keys.DEFAULT_SUGGESTIONS, [
    "Ich suche einen Deutschkurs.",
    "Gibt es Excel-Kurse am Abend?",
  ]);
  assert.deepEqual(defaultSuggestions("en"), [
    "I am looking for a German course.",
    "Are there Excel courses in the evening?",
  ]);
  // kommagetrennt ans Widget: keine Kommas in den Standards
  for (const lang of Object.keys(DEFAULT_SUGGESTIONS))
    for (const s of DEFAULT_SUGGESTIONS[lang]) assert.ok(!s.includes(","), s);
});

test("S1: listDefault/listItems nehmen die Liste des Servers, ohne geladene Standardtexte die Kopie; gespeichertes [] bleibt leer", () => {
  const server = { defaultMessages: ["A?", "B?"] };
  assert.deepEqual(keys.listDefault("defaultMessages", server), ["A?", "B?"]);
  for (const defaults of [null, undefined, {}, { defaultMessages: "x" }])
    assert.deepEqual(
      keys.listDefault("defaultMessages", defaults),
      keys.DEFAULT_SUGGESTIONS
    );
  // Willkommensblasen: Standard des Widgets, nicht vom Server
  assert.deepEqual(
    keys.listDefault("chatbotBubblesMessages", server),
    keys.DEFAULT_WELCOME_BUBBLES
  );
  assert.deepEqual(keys.listItems({}, "defaultMessages", server), ["A?", "B?"]);
  assert.deepEqual(
    keys.listItems({}, "defaultMessages", DEFAULTS),
    keys.DEFAULT_SUGGESTIONS
  );
  assert.deepEqual(
    keys.listItems({}, "defaultMessages"),
    keys.DEFAULT_SUGGESTIONS
  );
  assert.deepEqual(
    keys.listItems({ defaultMessages: [] }, "defaultMessages", server),
    []
  );
  assert.deepEqual(
    keys.listItems({ defaultMessages: ["Eigene"] }, "defaultMessages", server),
    ["Eigene"]
  );
  // Kopie: Ändern der Zeilen ändert die Vorbelegung nicht
  keys.listItems({}, "defaultMessages", server).push("C?");
  assert.deepEqual(server.defaultMessages, ["A?", "B?"]);
});

test("S1: cleanConfig erkennt die Liste des Servers als Standard (Schlüssel entfällt); [] bleibt; ohne Standardtexte die Kopie", () => {
  const server = { ...DEFAULTS, defaultMessages: ["A?", "B?"] };
  const clean = (cfg, defaults) =>
    keys.cleanConfig(cfg, { initial: {}, defaults, greetingKey: "greeting" });
  assert.deepEqual(clean({ defaultMessages: [" A? ", "B?", ""] }, server), {});
  assert.deepEqual(
    clean({ defaultMessages: [...keys.DEFAULT_SUGGESTIONS] }, server),
    { defaultMessages: keys.DEFAULT_SUGGESTIONS }
  );
  assert.deepEqual(
    clean({ defaultMessages: [...keys.DEFAULT_SUGGESTIONS] }, DEFAULTS),
    {}
  );
  assert.deepEqual(
    clean({ defaultMessages: [...keys.DEFAULT_SUGGESTIONS] }, null),
    {}
  );
  assert.deepEqual(clean({ defaultMessages: [] }, server), {
    defaultMessages: [],
  });
});

test(
  "S1: Reiter Inhalt und Vorschau (Chatfenster und In der Seite) zeigen die Startvorschläge des Servers",
  { skip },
  async () => {
    const server = {
      ...DEFAULTS,
      defaultMessages: ["Welche Kurse gibt es?", "Wie melde ich mich an?"],
    };
    const content = await show(CONTENT, contentProps({}, server));
    assert.match(content, /value="Welche Kurse gibt es\?"/);
    assert.match(content, /value="Wie melde ich mich an\?"/);
    assert.doesNotMatch(content, /Ich suche einen Deutschkurs\./);
    assert.ok(
      text(content).includes(
        "Ohne eigene Liste gelten die zwei Beispiele, auch im Widget; alle gelöscht und gespeichert: keine Startvorschläge."
      )
    );
    // Standardtexte noch nicht geladen: die Kopie
    assert.match(
      await show(CONTENT, contentProps({}, null)),
      /value="Ich suche einen Deutschkurs\."/
    );
    for (const config of [{}, { displayMode: "inline" }]) {
      const preview = await show(PREVIEW, {
        config,
        logoPreview: null,
        defaults: server,
        greetingKey: "greeting",
      });
      const t = text(preview);
      assert.ok(t.includes("Welche Kurse gibt es?"), JSON.stringify(config));
      assert.ok(t.includes("Wie melde ich mich an?"), JSON.stringify(config));
      assert.ok(!t.includes("Ich suche einen Deutschkurs."));
    }
    // gespeichertes []: keine Pillen, auch mit Serverliste
    assert.doesNotMatch(
      await show(PREVIEW, {
        config: { defaultMessages: [] },
        logoPreview: null,
        defaults: server,
        greetingKey: "greeting",
      }),
      /data-preview="pill"/
    );
  }
);

// ---------------------------------------------------------------------------
// S2 Skriptzeile im Reiter Einbau
// ---------------------------------------------------------------------------

test(
  "S2: Skriptzeile bricht nur nach „/“: jeder Teil ein nicht umbrechendes Stück, kein <wbr> nach „.“ oder „-“, Box ohne break-all, Text unverändert",
  { skip },
  async () => {
    const html = await show(EMBED, { config: {}, embed: { uuid: "abc-123" } });
    const pre = html.match(/<pre[^>]*>([\s\S]*?)<\/pre>/);
    assert.ok(pre);
    assert.match(pre[0], /whitespace-pre-wrap/);
    assert.doesNotMatch(pre[0], /break-all/);
    const partRe =
      /<span class="whitespace-pre" data-snippet-part="">([\s\S]*?)<\/span>/g;
    const parts = [...pre[1].matchAll(partRe)].map((m) => m[1]);
    assert.ok(parts.length >= 5, String(parts.length));
    // zwischen den Teilen genau ein <wbr>, sonst nichts
    for (const between of pre[1]
      .split(partRe)
      .filter((s, i) => i % 2 === 0 && s))
      assert.match(between, /^<wbr\/?>$/, JSON.stringify(between));
    for (const part of parts.slice(0, -1)) assert.match(part, /\/$/, part);
    // Dateiname und Attributnamen bleiben je ein Stück
    assert.ok(
      parts.some((p) => p.includes("anythingllm-chat-widget.min.js&quot;&gt;"))
    );
    assert.ok(parts.some((p) => p.includes("data-base-api-url=&quot;http:/")));
    assert.doesNotMatch(pre[1], /\.<wbr/);
    assert.doesNotMatch(pre[1], /-<wbr/);
    assert.doesNotMatch(pre[1], /=<wbr/);
    // die Teile ergeben den Schnipsel (Kopieren liefert ihn unverändert)
    const embedTab = await renderer.load(EMBED);
    const snippet = embedTab.embedScriptSnippet(
      { uuid: "abc-123" },
      { dev: false, origin: "https://kunde.ki.kufer.de" }
    );
    const strings = embedTab
      .snippetWithBreaks(snippet)
      .filter((p) => typeof p === "string");
    assert.equal(strings.join(""), snippet);
    assert.deepEqual(strings, [
      '<script\n  data-embed-id="abc-123"\n  data-base-api-url="https:/',
      "/",
      "kunde.ki.kufer.de/",
      "api/",
      'embed"\n  src="https:/',
      "/",
      "kunde.ki.kufer.de/",
      "embed/",
      'anythingllm-chat-widget.min.js">\n</script>',
    ]);
  }
);

// ---------------------------------------------------------------------------
// S3 Hinweise im Reiter Aussehen
// ---------------------------------------------------------------------------

const GONE_HINTS = [
  "PNG, JPG, GIF, SVG oder WebP",
  "Hell oder Dunkel, für Chatfenster",
  "Unten links oder unten rechts",
  "Für Nutzer-Nachrichten, den Senden-Button",
  "Empfohlen: Karten zuerst",
  "Kurskarten zeigen Termin, Ort",
];

test(
  "S3: Reiter Aussehen ohne Hinweise unter Logo, Farbschema, Position und Reihenfolge; Schrift nur Empfehlung und Warnung; „Kurse anzeigen als“ eine Zeile",
  { skip },
  async () => {
    for (const config of [
      { accentColor: "#777777" },
      { displayMode: "inline", accentColor: "#777777" },
    ]) {
      const html = await appearance(config);
      const t = text(html);
      for (const gone of GONE_HINTS) assert.ok(!t.includes(gone), gone);
      // bleibt: Darstellung, Akzentfarbe, Empfehlung und Warnung, eine Zeile
      // unter „Kurse anzeigen als“
      assert.ok(t.includes("Chatfenster: Button unten in der Ecke"));
      assert.ok(
        t.includes("Buttons, Nutzer-Nachrichten und Links in Akzentfarbe.")
      );
      assert.ok(t.includes("Empfohlen: Weiß"));
      assert.ok(t.includes("Kontrast nur 4,4:1"));
      assert.equal(
        t.split("Standard hängt von der Darstellung ab.").length,
        2,
        "genau einmal"
      );
      // Reihenfolge (nur bei Kurskarten, also In der Seite): kein Hinweis
      if (config.displayMode === "inline") {
        const order = html.slice(
          html.indexOf(">Reihenfolge<"),
          html.indexOf('data-testid="fixed-note"')
        );
        assert.ok(order.includes("Karten zuerst (Standard)"));
        assert.doesNotMatch(order, /text-xs mt-1\.5 leading-relaxed/);
      }
    }
    const bubble = await appearance({});
    assert.ok(text(bubble).includes("Das Icon auf dem Chat-Button."));
    // die Anmerkung zum früheren Farbschema „auto“ bleibt (kein Hinweis,
    // sondern der Stand: kein Button markiert)
    assert.ok(
      text(await appearance({ theme: "auto" })).includes(
        "Bisher: automatisch nach Gerät."
      )
    );
    assert.ok(!text(bubble).includes("Bisher: automatisch nach Gerät."));
    // ohne Warnung unter der Schrift nur die Empfehlung
    const calm = text(await appearance({ accentColor: "#003366" }));
    assert.ok(calm.includes("Empfohlen: Weiß"));
    assert.ok(!calm.includes("Kontrast nur"));
    for (const gone of GONE_HINTS) assert.ok(!calm.includes(gone), gone);
    assert.equal(keys.CARDS_HINT, undefined);
  }
);
