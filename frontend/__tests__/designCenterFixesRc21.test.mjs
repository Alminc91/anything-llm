// Korrekturrunde 7.22-rc21 (Fixliste fixliste-7.22-rc21.md, Abschnitt
// „F · Fork“; Problem und Abhilfe je Punkt im Bericht
// review-7.22-nachreview-rc20.md):
// W91 Fork-Kopie von contrast.js wie das Widget: parseColor liest rgb()/
//     rgba() wie CSS nur mit Kommas (Alpha nach Komma) oder nur mit
//     Leerzeichen (Alpha nach „/“), Alpha als strenge Zahl. Gemischte Trenner
//     („rgb(1, 2 3)“) sind keine Farbe, das Design Center lehnt sie als
//     Akzentfarbe ab (accentColorError). Den wortgleichen Code prüft
//     designCenterTextOnAccent mit KUFER_EMBED_DIR.
// E38 (N41) Im Dialog „Einbettungscode kopieren“ steht bei „In der Seite“
//     kein „Optional“ über dem Platzhalter; beim Chatfenster bleibt es.
// N42 Migrationsdoku: „Die Farben von Text, Überschrift und Fläche der
//     Datenschutz-Blase …“.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createRenderer,
  hasFrontendDeps,
} from "./helpers/renderSettingsPage.mjs";
import { parseColor } from "../src/pages/GeneralSettings/ChatEmbedWidgets/EmbedAppearance/contrast.js";
import * as keys from "../src/pages/GeneralSettings/ChatEmbedWidgets/EmbedAppearance/widgetKeys.js";

const DIALOG =
  "/src/pages/GeneralSettings/ChatEmbedWidgets/EmbedConfigs/EmbedRow/CodeSnippetModal/index.jsx";
const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  ".."
);
const LOCALES = path.join(ROOT, "frontend/src/locales");
const MIGRATION = path.join(ROOT, "docs", "design-center-2-migration.md");
const skip = hasFrontendDeps
  ? false
  : "frontend/node_modules nicht installiert";

let renderer;
before(async () => {
  if (hasFrontendDeps) renderer = await createRenderer();
});
after(async () => {
  await renderer?.close();
});

const decode = (html) =>
  html
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&");

const text = (html) =>
  decode(html.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();

async function withLanguage(lang, run) {
  const { default: i18next } = await import("i18next");
  await i18next.changeLanguage(lang);
  try {
    return await run();
  } finally {
    await i18next.changeLanguage("de");
  }
}

// ---------------------------------------------------------------------------
// W91 parseColor (Fork-Kopie) und Akzentfarbe im Design Center
// ---------------------------------------------------------------------------

const MIXED_SEPARATORS = [
  "rgb(1, 2 3)",
  "rgb(1 2, 3)",
  "rgb(1 2 3, 1)",
  "rgba(1, 2, 3 / 1)",
  "rgb(1,2,3,1.2.3)",
  "rgba(1, 2, 3, .)",
  "rgba(1, 2, 3, 1.)",
  "rgb(1 2 3 /)",
];

test("W91: parseColor liest rgb()/rgba() nur mit Kommas oder nur mit Leerzeichen, Alpha als strenge Zahl", () => {
  for (const [value, rgb] of [
    ["rgb(1, 2, 3)", [1, 2, 3]],
    ["rgb(1,2,3)", [1, 2, 3]],
    ["RGB( 1 , 2 , 3 )", [1, 2, 3]],
    ["rgba(1, 2, 3, 0.5)", [1, 2, 3]],
    ["rgba(1, 2, 3, .5)", [1, 2, 3]],
    ["rgba(1, 2, 3, 50%)", [1, 2, 3]],
    ["rgb(1 2 3)", [1, 2, 3]],
    ["rgb(1 2 3 / 0.5)", [1, 2, 3]],
    ["rgb(1 2 3/50%)", [1, 2, 3]],
    ["#01a5a9", [1, 165, 169]],
    ["#fff", [255, 255, 255]],
  ])
    assert.deepEqual(parseColor(value), rgb, value);
  for (const value of MIXED_SEPARATORS)
    assert.equal(parseColor(value), null, value);
});

test("W91: Design Center lehnt gemischte Trenner als Akzentfarbe ab, gültige Schreibweisen bleiben", () => {
  const CODE = "Bitte einen Farbcode wie #007C82 angeben.";
  for (const value of MIXED_SEPARATORS) {
    assert.equal(keys.accentColorError(value), CODE, value);
    const errors = keys.validateConfig({ accentColor: value }, {}, "greeting");
    assert.equal(errors.accentColor, CODE, value);
    // keine Empfehlung mit einem Wert, den CSS nicht liest
    assert.equal(
      keys.userTextColorAdvice({ accentColor: value }).recommendedLabel,
      null,
      value
    );
  }
  for (const value of ["rgb(1, 2, 3)", "rgb(1 2 3)", "rgb(1 2 3 / 100%)"])
    assert.equal(keys.accentColorError(value), null, value);
  assert.equal(
    keys.accentColorError("rgb(1 2 3 / 50%)"),
    "Bitte eine deckende Farbe ohne Transparenz angeben."
  );
});

// ---------------------------------------------------------------------------
// E38 (N41) Beschriftung des Platzhalters im Dialog
// ---------------------------------------------------------------------------

const renderDialog = (visualConfig) =>
  renderer.render(DIALOG, {
    location: "/",
    props: {
      embed: { uuid: "abc-123", visual_config: visualConfig },
      closeModal: () => {},
    },
  });

// Beschriftungen der beiden Schnipsel (Skript, Platzhalter)
const labels = (html) =>
  [...html.matchAll(/<label\b[^>]*>([\s\S]*?)<\/label>/g)].map((m) =>
    text(m[1])
  );

test(
  "E38: Dialog beschriftet den Platzhalter bei „In der Seite“ ohne „Optional“, beim Chatfenster wie bisher",
  { skip },
  async () => {
    const INLINE = [
      JSON.stringify({ displayMode: "inline" }),
      JSON.stringify({ displayMode: " Inline " }),
    ];
    const BUBBLE = [
      JSON.stringify({ displayMode: "bubble" }),
      "{}",
      null,
      "{kaputt",
    ];
    for (const [lang, inlineLabel, bubbleLabel] of [
      [
        "de",
        "Darstellung „In der Seite“",
        "Optional: Darstellung „In der Seite“",
      ],
      [
        "en",
        "Display “In der Seite” (in the page)",
        "Optional: display “In der Seite” (in the page)",
      ],
    ]) {
      await withLanguage(lang, async () => {
        for (const visualConfig of INLINE) {
          const html = await renderDialog(visualConfig);
          const found = labels(html);
          assert.equal(found.length, 2, `${lang} ${visualConfig}`);
          assert.equal(found[1], inlineLabel, `${lang} ${visualConfig}`);
          assert.doesNotMatch(text(html), /Optional/i, visualConfig);
          // Warnblock bleibt (E32)
          assert.match(html, /data-testid="inline-link-warning"/);
        }
        for (const visualConfig of BUBBLE) {
          const found = labels(await renderDialog(visualConfig));
          assert.equal(found[1], bubbleLabel, `${lang} ${visualConfig}`);
        }
      });
    }
  }
);

test("E38: Sprachdateien: Beschriftung bei „In der Seite“ de und en, übrige Sprachen null", async () => {
  const langs = fs
    .readdirSync(LOCALES, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  assert.ok(langs.length > 20, langs.join(","));
  for (const lang of langs) {
    const { default: locale } = await import(
      `../src/locales/${lang}/common.js`
    );
    const tag = locale["code-snippet-modal"]?.["inline-tag"];
    assert.ok(tag && "label-inline" in tag, `${lang}: label-inline fehlt`);
    if (lang === "de")
      assert.equal(tag["label-inline"], "Darstellung „In der Seite“");
    else if (lang === "en")
      assert.equal(tag["label-inline"], "Display “In der Seite” (in the page)");
    else assert.equal(tag["label-inline"], null, lang);
  }
});

// ---------------------------------------------------------------------------
// N42 Migrationsdoku
// ---------------------------------------------------------------------------

// Bewusste Änderung (Datenschutz-Fußzeile, 7.23): statt der Blase das
// Datenschutz-Fenster mit Fläche und Schrift der Antwortblasen (D2)
test("N42 (seit 7.23): Gruppe B spricht vom Datenschutz-Fenster wie den Antwortblasen", () => {
  const doc = fs.readFileSync(MIGRATION, "utf8").replace(/\s+/g, " ");
  assert.match(doc, /nutzt Fläche und Schrift der Antwortblasen/);
});
