// Korrekturrunde 7.22-rc7 (Fixliste fixliste-7.22-rc7.md, Teil Fork Design
// Center): Review 7.22-rc6 F06, F07, F10 und Browser B-02, B-03, B-05, B-06,
// B-11. Logik als reine Funktionen, Darstellung serverseitig gerendert.
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
const EMBED = `${DIR}/EmbedTab.jsx`;
const PREVIEW = `${DIR}/WidgetPreview.jsx`;
const skip = hasFrontendDeps
  ? false
  : "frontend/node_modules nicht installiert";

const require = createRequire(import.meta.url);
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
    .replace(/<wbr\/?>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
const show = (modulePath, props) =>
  renderer.render(modulePath, { location: "/", props });
const appearance = (config, extra = {}) =>
  show(APPEARANCE, { config, updateField: noop, logoPreview: null, ...extra });

// <button …>Beschriftung</button> einer Auswahlgruppe
function buttonTag(html, label) {
  // Beschriftung auch hinter einem Symbol (R9: Sonne/Mond vor Hell/Dunkel)
  return [
    ...html.matchAll(/<button[^>]*>(?:<svg[\s\S]*?<\/svg>)?([^<]*)<\/button>/g),
  ].find((m) => m[1] === label)?.[0];
}

// ---------------------------------------------------------------------------
// F06: Kundenfarbe nur als deckender Farbcode
// ---------------------------------------------------------------------------

test("F06: durchscheinende oder ungültige Kundenfarbe wird abgelehnt", () => {
  for (const value of [
    "rgba(0,0,0,0.15)",
    "rgba(0, 0, 0, 15%)",
    "rgb(0 0 0 / 0.5)",
    "#01A5A980",
    "#01a5a900",
  ])
    assert.equal(
      keys.accentColorError(value),
      "Bitte eine deckende Farbe ohne Transparenz angeben.",
      value
    );
  for (const value of ["red", "#01A5", "01A5A9", "rgb(300,0,0)"])
    assert.equal(
      keys.accentColorError(value),
      "Bitte einen Farbcode wie #01A5A9 angeben.",
      value
    );
  for (const value of [
    "",
    "  ",
    undefined,
    "#01A5A9",
    "#fff",
    "#01A5A9ff",
    "rgb(1, 165, 169)",
    "rgba(1,165,169,1)",
    "rgba(1,165,169,100%)",
  ])
    assert.equal(keys.accentColorError(value), null, String(value));
  // nur ein geänderter Wert blockiert das Speichern (Reiter Aussehen)
  assert.equal(keys.FIELD_TAB.accentColor, "aussehen");
  assert.equal(
    keys.validateConfig(
      { accentColor: "rgba(0,0,0,0.15)" },
      { accentColor: "#01A5A9" },
      "greeting"
    ).accentColor,
    "Bitte eine deckende Farbe ohne Transparenz angeben."
  );
  assert.equal(
    keys.validateConfig(
      { accentColor: "red" },
      { accentColor: "red" },
      "greeting"
    ).accentColor,
    undefined
  );
});

test("F06: Fehler steht unter dem Feld Kundenfarbe", { skip }, async () => {
  const message = "Bitte eine deckende Farbe ohne Transparenz angeben.";
  const html = await appearance(
    { accentColor: "rgba(0,0,0,0.15)" },
    { errors: { accentColor: message } }
  );
  assert.ok(text(html).includes(message));
  assert.match(html, /border-red-400\/70/);
  assert.ok(!text(await appearance({})).includes(message));
});

// ---------------------------------------------------------------------------
// F07: Kürzung der Pillen zerschneidet kein Emoji
// ---------------------------------------------------------------------------

test("F07: lange Startvorschläge werden gekürzt, ohne ein Emoji zu zerschneiden", () => {
  const emoji = `${"a".repeat(58)}\u{1F600}${"b".repeat(10)}`;
  const label = keys.pillLabel(emoji);
  assert.equal(label, `${"a".repeat(58)}…`);
  assert.doesNotMatch(label, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  assert.equal(keys.pillLabel("x".repeat(60)), "x".repeat(60));
  assert.equal(keys.pillLabel("x".repeat(61)), `${"x".repeat(59)}…`);
  assert.equal(
    keys.pillLabel(`${"y".repeat(57)}  z${"q".repeat(9)}`),
    `${"y".repeat(57)}…`
  );
});

test(
  "F07: Vorschau zeigt den Startvorschlag ohne halbes Emoji",
  { skip },
  async () => {
    const emoji = `${"a".repeat(58)}\u{1F600}${"b".repeat(10)}`;
    const html = await show(PREVIEW, {
      config: { defaultMessages: [emoji] },
      logoPreview: null,
      defaults: DEFAULTS,
      greetingKey: "greeting",
    });
    assert.ok(html.includes(`${"a".repeat(58)}…`));
    assert.doesNotMatch(html, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    assert.doesNotMatch(html, /�/);
  }
);

// ---------------------------------------------------------------------------
// F10 und B-03: Kasten „Fest eingebaut“. Seit R2 (Fixliste 7.22-rc8) gibt es
// den Kasten nicht mehr, nur eine Zeile „Fest vorgegeben: …“ (Test
// designCenterFixesRc8); hier bleibt die Prüfung, dass die beanstandeten
// Texte nicht wiederkommen.
// ---------------------------------------------------------------------------

test(
  "F10/B-03/R2: kein Kasten mehr, keine Fachsprache, kein Widerspruch",
  { skip },
  async () => {
    for (const displayMode of ["bubble", "inline"]) {
      const t = text(await appearance({ displayMode }));
      assert.ok(!t.includes("Keine Auswahl nötig"));
      assert.ok(!t.includes("Effekte entfallen"));
      assert.ok(!t.includes("Leisten-Stil"));
      assert.ok(!t.includes("Fest eingebaut"));
      assert.ok(!t.includes("Kurskarten als Zeilen mit kurzer Antwort"));
      assert.ok(t.includes("Antworten mit Kursen"));
    }
  }
);

// ---------------------------------------------------------------------------
// B-05 und B-06: markierte Optionen
// ---------------------------------------------------------------------------

test(
  "B-05/B-06: markierte Option mit schwarzer Schrift auf der Akzentfläche und aria-pressed",
  { skip },
  async () => {
    const html = await appearance({ courseCards: "auto" });
    // Beschriftungen seit 7.22-rc8: R3 (Chatfenster / In der Seite), R4
    // („(Standard)“ am Standard-Button, im Chatfenster Nur Text mit Links)
    for (const [label, pressed] of [
      ["Kurskarten", "true"],
      ["Nur Text mit Links (Standard)", "false"],
      ["Karten zuerst (Standard)", "true"],
      ["Text zuerst", "false"],
      ["Chatfenster", "true"],
      ["In der Seite", "false"],
      ["Hell", "true"],
      ["Links", "true"],
      ["Rechts", "false"],
    ]) {
      const tag = buttonTag(html, label);
      assert.ok(tag, label);
      assert.match(tag, new RegExp(`aria-pressed="${pressed}"`), label);
      if (pressed === "true") {
        assert.match(tag, /bg-primary-button text-black/, label);
        assert.doesNotMatch(tag, /bg-primary-button text-white/, label);
      }
    }
    // Schrift auf der Kundenfarbe: markierte Option ebenso
    const black = html.match(
      /<button[^>]*aria-pressed="true"[^>]*>(?:(?!<\/button>).)*Schwarz<\/button>/s
    )?.[0];
    assert.ok(black, "Schwarz markiert");
    assert.match(black, /bg-primary-button text-black/);
    // Schritt-Nummern im Reiter Einbau
    const embed = await show(EMBED, {
      config: { displayMode: "inline" },
      embed: { uuid: "abc" },
    });
    assert.doesNotMatch(embed, /bg-primary-button text-white/);
  }
);

// ---------------------------------------------------------------------------
// B-02: Warnung, Datenschutz-Schalter, Größe der Auswahlgruppen
// ---------------------------------------------------------------------------

test(
  "B-02: Kontrastwarnung im hellen Modus dunkler Bernstein",
  { skip },
  async () => {
    const html = await appearance({ userTextColor: "#FFFFFF" });
    const warning = html.match(
      /<p[^>]*data-testid="user-text-warning"[^>]*>/
    )?.[0];
    assert.ok(warning);
    assert.match(warning, /light:text-amber-700/);
  }
);

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

test(
  "B-02: Datenschutz-Schalter in der Akzentfarbe, aus deutlich erkennbar mit „Aus“",
  { skip },
  async () => {
    for (const [config, state] of [
      [{}, "An"],
      [{ privacyNotice: "none" }, "Aus"],
    ]) {
      const html = await show(CONTENT, contentProps(config));
      const at = html.indexOf("data-privacy-switch");
      const block = html.slice(at, html.indexOf("</label>", at));
      assert.match(block, /role="switch"/);
      assert.match(block, /peer-checked:bg-primary-button/);
      assert.doesNotMatch(block, /green-/);
      assert.match(block, /border-zinc-400/);
      assert.ok(text(block).includes(state), state);
    }
  }
);

test(
  "B-02: Auswahl der Willkommensblasen so groß wie die übrigen Auswahlgruppen",
  { skip },
  async () => {
    const html = await show(CONTENT, contentProps({}));
    const desktop = buttonTag(html, "Beim ersten Besuch");
    assert.match(desktop, /px-5 py-2 text-sm/);
    assert.doesNotMatch(desktop, /px-3 py-1\.5 text-xs/);
  }
);

// ---------------------------------------------------------------------------
// B-11: Skriptzeile bricht nicht mitten im Wort um
// ---------------------------------------------------------------------------

test(
  "B-11: Skript-Schnipsel mit Umbruchstellen nach „/“ und „.“, Text unverändert",
  { skip },
  async () => {
    const html = await show(EMBED, { config: {}, embed: { uuid: "abc-123" } });
    const pre = html.match(/<pre[^>]*>([\s\S]*?)<\/pre>/);
    assert.ok(pre);
    assert.match(pre[0], /<wbr\/?>/);
    // Restpunkt 1 (rc7, bewusst geändert): nur nach „/“ und „.“, nicht
    // mehr nach „-“ („chat-widget“ bleibt zusammen)
    assert.match(pre[1], /chat-widget\.<wbr\/?>min\.<wbr\/?>js/);
    assert.doesNotMatch(pre[1], /-<wbr/);
    assert.doesNotMatch(pre[1], /=<wbr/);
    assert.doesNotMatch(pre[0], /break-all/);
    // der Text (und damit das Kopieren) bleibt gleich
    const embedTab = await renderer.load(EMBED);
    const snippet = embedTab.embedScriptSnippet(
      { uuid: "abc-123" },
      { dev: false, origin: "https://kunde.ki.kufer.de" }
    );
    const parts = embedTab
      .snippetWithBreaks(snippet)
      .filter((p) => typeof p === "string");
    assert.equal(parts.join(""), snippet);
  }
);
