// Korrekturrunde 7.22-rc22, Teil Fork (Fixliste fixliste-7.22-rc22.md,
// Nachtrag „Bewertung des Sicherheitsdurchgangs rc21“; Problem und Abhilfe
// je Punkt im Bericht review-7.22-rc21-security.md, F100 und F101):
// E41 Eine Regel für gültige Farben, die von parseColor (wortgleich in
//     Widget und Fork, Gleichlauf-Test in designCenterTextOnAccent mit
//     KUFER_EMBED_DIR). Leerraum in rgb()/rgba() nur [ \t\n\r\f] wie in CSS:
//     U+00A0 und andere Unicode-Leerzeichen sind kein Trenner, das Design
//     Center lehnt solche Werte als Akzentfarbe ab (F100).
// F101 Migrationsdoku: Satz zur einzigen Farbregel statt „bleibt“ und
//     Prüfpunkt 12 (gespeicherte Farbwerte zählen, die parseColor nicht
//     liest; nur melden).
// E41 Ergänzung (b) (Abschnitt „Ergebnis E41 und Ergänzung“): Die Vorschau
//     zeigt gespeicherte bzw. eingegebene Farbwerte, die die Farbregel nicht
//     annimmt (parseColor liest sie nicht oder Deckkraft unter 1, also genau
//     die, die accentColorError meldet), als Standard wie das Widget:
//     Akzentfarbe #007C82 (seit 23.10.2026, vorher #01A5A9), Schrift nach
//     Kontrast. Das Feld zeigt weiter den
//     eingegebenen Wert mit der Fehlermeldung. Gleichlauf mit dem Widget
//     (dcColor, onAccentTextColor, userTextColorFor) mit KUFER_EMBED_DIR.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createRenderer,
  hasFrontendDeps,
} from "./helpers/renderSettingsPage.mjs";
import * as contrast from "../src/pages/GeneralSettings/ChatEmbedWidgets/EmbedAppearance/contrast.js";
import * as keys from "../src/pages/GeneralSettings/ChatEmbedWidgets/EmbedAppearance/widgetKeys.js";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  ".."
);
const MIGRATION = path.join(ROOT, "docs", "design-center-2-migration.md");
const FORMAT_ERROR = "Bitte einen Farbcode wie #007C82 angeben.";

// Werte mit Unicode-Zeichen lesbar in der Meldung (U+00A0 statt Leerzeichen)
const show = (value) =>
  value.replace(
    /[^\x20-\x7e]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}`
  );

// ---------------------------------------------------------------------------
// E41 (F100) parseColor: Leerraum in rgb() nur wie in CSS
// ---------------------------------------------------------------------------

// Unicode-Leerraum in rgb(): CSS liest ihn nicht als Trenner, der Button
// wäre durchsichtig (dieselben Fälle wie tests/rc22-widget.test.jsx im Widget)
const UNICODE_SPACE = [
  "rgb(1, 165, 169)",
  "rgb(1 165 169)",
  "rgba(1, 165, 169, 1)",
  "rgb(1 165 169 / 1)",
  "rgb(1 165 169)",
  "rgb(　1, 165, 169)",
  "rgb(1,﻿165, 169)",
];
// Leerraum, den CSS kennt: Leerzeichen, Tab, Zeilenumbruch, Seitenvorschub
const CSS_SPACE = [
  ["rgb(0, 168, 168)", [0, 168, 168]],
  ["rgb(0 168 168)", [0, 168, 168]],
  ["rgb(0,\t168,\n168)", [0, 168, 168]],
  ["rgb(0\f168\r168)", [0, 168, 168]],
  ["rgba( 0 , 168 , 168 , 1 )", [0, 168, 168]],
  ["rgb(0 168 168 /\t100%)", [0, 168, 168]],
];

test("E41 (F100): parseColor nimmt in rgb() keinen Unicode-Leerraum an, Leerraum wie in CSS bleibt", () => {
  for (const value of UNICODE_SPACE)
    assert.equal(contrast.parseColor(value), null, show(value));
  for (const [value, rgb] of CSS_SPACE)
    assert.deepEqual(contrast.parseColor(value), rgb, show(value));
});

test("E41 (F100): Design Center lehnt Unicode-Leerraum in rgb() als Akzentfarbe ab, ohne Empfehlung", () => {
  for (const value of UNICODE_SPACE) {
    assert.equal(keys.accentColorError(value), FORMAT_ERROR, show(value));
    const errors = keys.validateConfig({ accentColor: value }, {}, "greeting");
    assert.equal(errors.accentColor, FORMAT_ERROR, show(value));
    assert.equal(
      keys.userTextColorAdvice({ accentColor: value }).recommendedLabel,
      null,
      show(value)
    );
  }
  for (const [value] of CSS_SPACE)
    assert.equal(keys.accentColorError(value), null, show(value));
});

// ---------------------------------------------------------------------------
// F101, E41 Migrationsdoku
// ---------------------------------------------------------------------------

const readDoc = () => fs.readFileSync(MIGRATION, "utf8");

// Prüfliste der Migrationsdoku: Punkt n (bis zum nächsten Punkt)
function checkpoint(doc, n) {
  const match = doc.match(
    new RegExp(`^${n}\\. ([\\s\\S]*?)(?=^\\d+\\. |$(?![\\s\\S]))`, "m")
  );
  assert.ok(match, `Prüfpunkt ${n} fehlt`);
  return match[1].replace(/\s+/g, " ");
}

// Zeile der Tabelle „Darstellung“ zu einem Schlüssel (erste Spalte)
const tableRow = (doc, key) => {
  const row = doc.split("\n").find((line) => line.startsWith(`| \`${key}\` `));
  assert.ok(row, `Zeile ${key} fehlt`);
  return row.replace(/\s+/g, " ");
};

test("F101: accentColor „bleibt“ nur als Farbcode, den parseColor liest; die eine Farbregel steht in der Doku (E41)", () => {
  const doc = readDoc();
  const row = tableRow(doc, "accentColor");
  // nicht mehr ohne Einschränkung „bleibt“
  assert.doesNotMatch(row, /\| bleibt; neue Eingaben/);
  assert.match(row, /andere gespeicherte Werte ergeben den Standard `#007C82`/);
  assert.match(row, /Prüfpunkt 12/);
  const rule = doc.replace(/\s+/g, " ");
  assert.match(rule, /Eine Regel für gültige Farben \(E41, 7\.22-rc22\)/);
  assert.match(
    rule,
    /Akzentfarbe und Schrift auf der Akzentfarbe .*nur als Hex .*und als `rgb\(\)`\/`rgba\(\)`/
  );
  assert.match(rule, /wie im Design Center/);
  assert.match(rule, /`parseColor`/);
  for (const example of [
    "`hsl()`",
    "Farbnamen",
    "Prozent",
    "`#rgba`",
    "`var()`",
  ])
    assert.ok(rule.includes(example), example);
  assert.match(rule, /Leerzeichen, Tab, Zeilenumbruch und Seitenvorschub/);
});

test("F101: Prüfpunkt 12 zählt gespeicherte Farbwerte, die parseColor nicht liest, nur melden (E41)", () => {
  const doc = readDoc();
  const point = checkpoint(doc, 12);
  assert.match(point, /`accentColor`/);
  assert.match(point, /`userTextColor`/);
  assert.match(point, /`parseColor` nicht liest/);
  assert.match(point, /je Kunde zählen/);
  assert.match(point, /\(E41, 7\.22-rc22\)/);
  assert.match(point, /nur melden/);
  assert.match(point, /gespeicherte Werte der Kunden nicht ändern/);
  // nach Prüfpunkt 12 nur noch Prüfpunkt 13 (bewusst geändert in rc24, E43;
  // Prüfung in server/__tests__/utils/chats/embedStandards.test.js)
  assert.doesNotMatch(doc, /^14\. /m);
  // Textregeln: keine Gedankenstriche
  assert.doesNotMatch(doc, /[–—]/);
});

// ---------------------------------------------------------------------------
// E41 Ergänzung (b): Vorschau gleich Gegenstelle
// ---------------------------------------------------------------------------

const DIR = "/src/pages/GeneralSettings/ChatEmbedWidgets/EmbedAppearance";
const PREVIEW = `${DIR}/WidgetPreview.jsx`;
const APPEARANCE = `${DIR}/AppearanceTab.jsx`;
const PREVIEW_SOURCE = path.join(ROOT, "frontend", PREVIEW);
const OPACITY_ERROR = "Bitte eine deckende Farbe ohne Transparenz angeben.";
// Standard Petrol (Nutzerentscheidung 23.10.2026), Empfehlung darauf Weiß
// (4,99:1 gegen 3,06:1 mit #222628)
const DEFAULT_ACCENT = "#007C82";
const WHITE = "#FFFFFF";
// „Schwarz“, wie es gezeigt wird (E1, Fixliste 7.22-rc7); Empfehlung zu
// hellen Akzentfarben wie dem früheren Standard #01A5A9 (5,06:1)
const BLACK = "#222628";
// früherer Standard, jetzt eine Kundenfarbe mit Empfehlung Schwarz
const OLD_TURQUOISE = "#01A5A9";
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

// Werte, die die Farbregel ablehnt: andere Formate (wie OTHER_FORMATS in
// tests/rc22-widget.test.jsx im Widget), Unicode-Leerraum (oben) und
// Deckkraft unter 1 (E41 Ergänzung (a))
const OTHER_FORMATS = [
  "hsl(180, 100%, 33%)",
  "hsla(180, 100%, 33%, 1)",
  "teal",
  "transparent",
  "rgb(80%, 40%, 0%)",
  "rgb(1.5, 2, 3)",
  "rgb(1, 2 3)",
  "#abcd",
  "#01A5A",
  "Canvas",
  "currentcolor",
  "var(--allm-accent)",
  "blau",
];
const TRANSLUCENT = [
  "rgba(0, 51, 102, 0.5)",
  "#00336680",
  "#003366fe",
  "rgb(0 51 102 / 50%)",
  "rgba(0, 51, 102, 0)",
  "  rgba(0, 51, 102, .99)\n",
];
const REJECTED = [...OTHER_FORMATS, ...UNICODE_SPACE, ...TRANSLUCENT];
// Werte, die sie annimmt (Dunkelblau: Empfehlung Weiß wie beim Standard;
// Gegenprobe mit Schwarz über OLD_TURQUOISE); die Vorschau zeigt sie
// getrimmt wie das Widget
const ACCEPTED = [
  "#003366",
  "#036",
  "#003366ff",
  "rgb(0, 51, 102)",
  "rgb(0 51 102)",
  "rgba(0, 51, 102, 1)",
  "rgb(0 51 102 / 100%)",
  "  #003366\n",
];
// gespeicherte Schrift auf der Akzentfarbe, die die Regel ablehnt
const REJECTED_TEXT = [
  "black",
  "white",
  "rgba(255, 255, 255, 0.5)",
  "#ffffff80",
  "hsl(0, 0%, 100%)",
  "transparent",
  "var(--allm-user-text)",
];

test("E41 (b): previewAccentColor zeigt abgelehnte Werte als Standard #007C82, angenommene getrimmt; dieselbe Regel wie accentColorError", () => {
  assert.equal(keys.DEFAULT_ACCENT_COLOR, DEFAULT_ACCENT);
  for (const value of REJECTED) {
    assert.notEqual(keys.accentColorError(value), null, show(value));
    assert.equal(
      keys.previewAccentColor({ accentColor: value }),
      DEFAULT_ACCENT,
      show(value)
    );
    // das Feld zeigt weiter den eingegebenen Wert
    assert.equal(keys.accentFieldValue({ accentColor: value }), value);
  }
  for (const value of ACCEPTED) {
    assert.equal(keys.accentColorError(value), null, show(value));
    assert.equal(
      keys.previewAccentColor({ accentColor: value }),
      value.trim(),
      show(value)
    );
  }
  // ohne Wert, leer, nur Leerraum oder kein Text: der Standard
  for (const config of [
    {},
    { accentColor: "" },
    { accentColor: "  " },
    { accentColor: 123 },
    { accentColor: null },
  ])
    assert.equal(
      keys.previewAccentColor(config),
      DEFAULT_ACCENT,
      JSON.stringify(config)
    );
});

test("E41 (b): previewUserTextColor: Schrift wie das Widget, abgelehnte Werte ergeben die Empfehlung zur gezeigten Akzentfarbe", () => {
  // abgelehnte Akzentfarbe: Empfehlung zu #007C82 (Weiß)
  for (const value of REJECTED)
    assert.equal(
      keys.previewUserTextColor({ accentColor: value }),
      WHITE,
      show(value)
    );
  // Gegenprobe zum Rohwert: hell und durchscheinend ergäbe roh Schwarz,
  // die Vorschau rechnet mit dem gezeigten Petrol
  assert.equal(
    keys.previewUserTextColor({ accentColor: "rgba(1, 165, 169, 0.5)" }),
    WHITE
  );
  for (const value of ACCEPTED)
    assert.equal(
      keys.previewUserTextColor({ accentColor: value }),
      WHITE,
      show(value)
    );
  // angenommene helle Kundenfarbe: eigene Empfehlung, anders als beim Standard
  assert.equal(
    keys.previewUserTextColor({ accentColor: OLD_TURQUOISE }),
    BLACK
  );
  // abgelehnte gespeicherte Schrift: die Empfehlung
  for (const value of REJECTED_TEXT) {
    assert.equal(keys.previewUserTextColor({ userTextColor: value }), WHITE);
    assert.equal(
      keys.previewUserTextColor({
        accentColor: "#003366",
        userTextColor: value,
      }),
      WHITE,
      value
    );
    assert.equal(
      keys.previewUserTextColor({
        accentColor: OLD_TURQUOISE,
        userTextColor: value,
      }),
      BLACK,
      value
    );
  }
  // angenommene gespeicherte Schrift gilt, auch bei schlechtem Kontrast;
  // früheres #000000 als #222628 (E1)
  assert.equal(keys.previewUserTextColor({ userTextColor: WHITE }), WHITE);
  assert.equal(keys.previewUserTextColor({ userTextColor: "#000000" }), BLACK);
  assert.equal(keys.previewUserTextColor({ userTextColor: "#fff" }), "#fff");
  assert.equal(
    keys.previewUserTextColor({
      accentColor: "teal",
      userTextColor: "rgb(255, 255, 255)",
    }),
    "rgb(255, 255, 255)"
  );
});

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

// Chatfenster und In der Seite, hell und dunkel, Kurskarten und Nur Text mit
// Links, mit Datenschutz-Link (Link in Akzentfarbe)
const LOOKS = [
  {},
  { theme: "dark" },
  { courseCards: "off", privacyUrl: "/datenschutz" },
  { displayMode: "inline" },
  { displayMode: "inline", theme: "dark", courseCards: "off" },
];

test(
  "E41 (b): Vorschau mit abgelehnter Akzentfarbe gleicht der Vorschau mit dem Standard (Chatfenster, In der Seite, hell, dunkel), angenommene zeigt sie",
  { skip },
  async () => {
    for (const look of LOOKS) {
      const standard = await preview(look);
      assert.match(standard, /background-color:#007C82/i);
      for (const value of REJECTED)
        assert.equal(
          await preview({ ...look, accentColor: value }),
          standard,
          `${show(value)} ${JSON.stringify(look)}`
        );
    }
    // Datenschutz-Link und Links der Kurse sind dabei (Akzentfarbe)
    const links = await preview(LOOKS[2]);
    assert.ok(links.includes("Datenschutzerklärung"));
    assert.match(links, /data-preview="course-link"/);
    // Gegenprobe: angenommene Werte zeigt die Vorschau (getrimmt) mit der
    // Schrift nach Kontrast, in der Nutzerblase und am Senden-Button der
    // Leiste
    for (const value of ACCEPTED) {
      const html = await preview({ accentColor: value });
      const tag = html.match(/<div[^>]*data-preview="user-message"[^>]*>/)[0];
      assert.ok(
        tag.includes(`background-color:${value.trim()};color:${WHITE}`),
        `${show(value)}: ${tag}`
      );
      const inline = await preview({
        displayMode: "inline",
        accentColor: value,
      });
      assert.ok(
        inline.includes(`background-color:${value.trim()};color:${WHITE}`),
        show(value)
      );
    }
  }
);

test(
  "E41 (b): Vorschau mit abgelehnter Schrift auf der Akzentfarbe zeigt die Empfehlung wie das Widget",
  { skip },
  async () => {
    for (const look of LOOKS) {
      const standard = await preview(look);
      const blue = await preview({ ...look, accentColor: "#003366" });
      for (const value of REJECTED_TEXT) {
        assert.equal(
          await preview({ ...look, userTextColor: value }),
          standard
        );
        assert.equal(
          await preview({
            ...look,
            accentColor: "#003366",
            userTextColor: value,
          }),
          blue,
          `${value} ${JSON.stringify(look)}`
        );
      }
    }
  }
);

test(
  "E41 (b): Das Feld zeigt weiter den eingegebenen Wert mit der Fehlermeldung, nur die Vorschau zeigt den Standard",
  { skip },
  async () => {
    for (const [value, message] of [
      ["hsl(180, 100%, 33%)", FORMAT_ERROR],
      ["rgba(0, 51, 102, 0.5)", OPACITY_ERROR],
    ]) {
      const config = { accentColor: value };
      const errors = keys.validateConfig(config, {}, "greeting");
      assert.equal(errors.accentColor, message);
      const field = await renderer.render(APPEARANCE, {
        location: "/",
        props: { config, errors, updateField: () => {}, logoPreview: null },
      });
      const input = field.match(
        /<input[^>]*aria-label="Akzentfarbe als Farbcode"[^>]*>/
      )[0];
      assert.ok(input.includes(`value="${value}"`), input);
      assert.ok(field.includes(message));
      const tag = (await preview(config)).match(
        /<div[^>]*data-preview="user-message"[^>]*>/
      )[0];
      // Standard Petrol mit der Empfehlung Weiß
      assert.ok(
        tag.includes(`background-color:${DEFAULT_ACCENT};color:${WHITE}`),
        tag
      );
    }
  }
);

// Zustände, die serverseitig nicht gerendert werden (geschlossenes
// Chatfenster, aufgeklappte Leiste): auch dort nur die Farben der Vorschau
test("E41 (b): WidgetPreview nimmt Akzentfarbe und Schrift nur aus previewAccentColor und previewUserTextColor", () => {
  const source = fs.readFileSync(PREVIEW_SOURCE, "utf8");
  assert.doesNotMatch(source, /lookValue\(config, "accentColor"\)/);
  assert.doesNotMatch(source, /\buserTextColor\(/);
  assert.doesNotMatch(source, /config\.(?:accentColor|userTextColor)\b/);
  assert.match(source, /previewAccentColor\(config\)/);
  assert.match(source, /previewUserTextColor\(config\)/);
});

// Gegenprobe gegen das Widget (KUFER_EMBED_DIR, Checkout von
// anythingllm-embed): die Vorschau zeigt Akzentfarbe, Nutzerblase, Link und
// Schrift auf der Akzentfarbe genau wie das Widget für dieselben
// gespeicherten Werte, so wie der Server sie ausliefert
// (endpoints/embed/index.js: accentColor als buttonColor, userBgColor und
// linkColor; früheres #000000 als #222628)
const WIDGET_THEME = process.env.KUFER_EMBED_DIR
  ? path.join(process.env.KUFER_EMBED_DIR, "src/utils/theme.js")
  : null;

function served(config) {
  const settings = {};
  if (config.accentColor) {
    settings.buttonColor = config.accentColor;
    settings.userBgColor = config.accentColor;
    settings.linkColor = config.accentColor;
  }
  if (config.userTextColor)
    settings.userTextColor =
      config.userTextColor.trim().toLowerCase() === "#000000"
        ? BLACK
        : config.userTextColor;
  return settings;
}

test(
  "E41 (b) Gleichlauf: Vorschau zeigt Akzentfarbe und Schrift wie das Widget (KUFER_EMBED_DIR)",
  {
    skip:
      WIDGET_THEME && fs.existsSync(WIDGET_THEME)
        ? false
        : "KUFER_EMBED_DIR nicht gesetzt",
  },
  async () => {
    const theme = await import(pathToFileURL(WIDGET_THEME).href);
    const variable = (name) =>
      theme.THEME_VARIABLES.find((v) => v.name === name).light;
    const hexAlphas = [...Array(256).keys()].map(
      (i) => `#003366${i.toString(16).padStart(2, "0")}`
    );
    const rgbAlphas = [
      "0",
      ".5",
      "0.99",
      "0.999",
      "1",
      "1.0",
      "1.5",
      "0%",
      "50%",
      "99.9%",
      "100%",
      "150%",
    ].flatMap((a) => [`rgba(0, 51, 102, ${a})`, `rgb(0 51 102 / ${a})`]);
    const accents = [
      undefined,
      "",
      "  ",
      DEFAULT_ACCENT,
      "#FFD700",
      ...REJECTED,
      ...ACCEPTED,
      ...hexAlphas,
      ...rgbAlphas,
    ];
    const texts = [
      undefined,
      WHITE,
      BLACK,
      "#000000",
      "#fff",
      "rgb(255, 255, 255)",
      ...REJECTED_TEXT,
    ];
    let compared = 0;
    for (const accentColor of accents) {
      const config = accentColor === undefined ? {} : { accentColor };
      const shown = keys.previewAccentColor(config).toLowerCase();
      for (const name of ["accent", "user-bg", "link"])
        assert.equal(
          variable(name)(served(config)).toLowerCase(),
          shown,
          `${name} ${show(String(accentColor))}`
        );
      for (const userTextColor of texts) {
        const withText =
          userTextColor === undefined ? config : { ...config, userTextColor };
        const text = keys.previewUserTextColor(withText).toLowerCase();
        const label = `${show(String(accentColor))} / ${userTextColor}`;
        assert.equal(
          theme.onAccentTextColor(served(withText)).toLowerCase(),
          text,
          label
        );
        assert.equal(
          theme.userTextColorFor(served(withText)).toLowerCase(),
          text,
          label
        );
        compared++;
      }
    }
    assert.ok(compared > 3000, String(compared));
  }
);

test("E41 (b): Migrationsdoku: Feld zeigt den gespeicherten Wert, Vorschau wie das Widget den Standard; Deckkraft unter 1 im Absatz und in Prüfpunkt 12 (Ergänzung (a))", () => {
  const doc = readDoc();
  const rule = doc.replace(/\s+/g, " ");
  assert.doesNotMatch(
    rule,
    /die Vorschau zeigt bis dahin den gespeicherten Wert/
  );
  assert.match(
    rule,
    /das Feld zeigt bis dahin den gespeicherten Wert, die Vorschau zeigt wie das Widget den Standard \(E41 Ergänzung \(b\)\)/
  );
  assert.match(rule, /Was es liest und deckend ist, zeigt das Widget/);
  assert.match(
    rule,
    /Werte mit Deckkraft unter 1 \(`rgba\(\)` mit Alpha unter 1, `#rrggbbaa` unter `ff`; E41 Ergänzung \(a\)\)/
  );
  const point = checkpoint(doc, 12);
  assert.match(
    point,
    /die `parseColor` nicht liest oder die nicht deckend sind/
  );
  assert.match(point, /auf Deckkraft unter 1 prüfen/);
  assert.doesNotMatch(doc, /[–—]/);
});
