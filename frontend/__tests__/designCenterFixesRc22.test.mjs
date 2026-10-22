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
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as contrast from "../src/pages/GeneralSettings/ChatEmbedWidgets/EmbedAppearance/contrast.js";
import * as keys from "../src/pages/GeneralSettings/ChatEmbedWidgets/EmbedAppearance/widgetKeys.js";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  ".."
);
const MIGRATION = path.join(ROOT, "docs", "design-center-2-migration.md");
const FORMAT_ERROR = "Bitte einen Farbcode wie #01A5A9 angeben.";

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
  assert.match(row, /andere gespeicherte Werte ergeben den Standard `#01A5A9`/);
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
  // Prüfpunkt 12 ist der letzte
  assert.doesNotMatch(doc, /^13\. /m);
  // Textregeln: keine Gedankenstriche
  assert.doesNotMatch(doc, /[–—]/);
});
