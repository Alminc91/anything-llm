// Korrekturrunde 7.22-rc16 (Fixliste fixliste-7.22-rc16.md, Abschnitt
// „F · Fork“, Funde aus review-7.22-nachreview-rc15.md), Teil Design Center
// ohne eingehängte Seite (Logik, serverseitig gerendertes HTML, Doku):
// F41 Einbau-Text sagt nur noch zu, dass gespeicherte Werte ältere Angaben
//     am Skript schlagen (Entscheidung E18).
// F44 Prüfpunkt 8 der Migrationsdoku: bis 7.21 gespeicherte Widgets haben [].
// W41 Prüfpunkt 9 (Fork-Teil): Demo-Kopien vergleichen /config ohne Query.
// E20 F04 bleibt, als bewusste Ausnahme zum Negativfall „Texte bleiben“.
// C7  Ein Begriff „bearbeitet“ für cleanConfig und validateConfig, Test über
//     alle Felder statt über eine feste Liste.
// C8  CopyBlock nutzt splitAfterSlashes direkt, snippetWithBreaks entfällt.
// C13 userTextColorAdvice ohne totes Feld „stored“.
// Mit eingehängter Seite (Vorschau F42, F43): designCenterFixesRc16Save.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  createRenderer,
  hasFrontendDeps,
} from "./helpers/renderSettingsPage.mjs";
import * as keys from "../src/pages/GeneralSettings/ChatEmbedWidgets/EmbedAppearance/widgetKeys.js";

const EMBED =
  "/src/pages/GeneralSettings/ChatEmbedWidgets/EmbedAppearance/EmbedTab.jsx";
const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  ".."
);
const MIGRATION = path.join(ROOT, "docs", "design-center-2-migration.md");
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

// ---------------------------------------------------------------------------
// C7 Ein Begriff „bearbeitet“, Test über alle Felder
// ---------------------------------------------------------------------------

// Alle Felder, die das Design Center bearbeitet oder für die der Server einen
// Standardtext hat: abgeleitet aus den Standardtexten des Servers, den
// Feldern mit Fehlermeldung und den Datenschutz-Feldern, nicht als feste
// Liste (ein neues Feld kommt so von selbst in den Test)
const FIELDS = [
  ...new Set([
    ...Object.keys(DEFAULTS),
    ...Object.keys(keys.FIELD_TAB),
    ...keys.PRIVACY_FIELD_KEYS,
    "name",
    "chatbotBubblesMessages",
  ]),
].sort();

// Standardwert je Feld (wie gespeichert von früheren Versionen) und ein
// eigener Wert in Normalform
const STANDARD = {
  ...DEFAULTS,
  accentColor: keys.DEFAULT_ACCENT_COLOR,
  greetingBubbleText: DEFAULTS.greeting,
  chatbotBubblesMessages: [...keys.DEFAULT_WELCOME_BUBBLES],
};
const OWN = {
  accentColor: "#123456",
  name: "VHS Beispielstadt",
  assistantSubtitle: "Ihr Kursberater",
  greeting: "Willkommen bei der VHS X",
  greetingBubbleText: "Hallo aus der Blase",
  sendMessageText: "Was suchen Sie?",
  privacyTitle: "Hinweis",
  privacyText: "• Erste Zeile\n• Zweite Zeile",
  privacyUrl: "https://example.org/datenschutz",
  disclaimerText: "Eigener KI-Hinweis",
  inlineInputPlaceholder: "Eigener Leistentext",
  inlineSendText: "Los",
  defaultMessages: ["Yoga am Abend?", "Gibt es Kurse, die abends stattfinden?"],
  chatbotBubblesMessages: ["Eigene Blase"],
};

test("C7: unverändert gespeicherte Werte bleiben beim Speichern eines anderen Feldes, für jedes Feld, auch als inhaltsgleiche Kopie (Datenschutz-Text wie die anderen Felder)", () => {
  // jedes Feld hat einen eigenen Wert im Test (sonst wäre es still nicht
  // geprüft)
  for (const field of FIELDS) assert.ok(field in OWN, `OWN.${field} fehlt`);
  for (const field of FIELDS)
    for (const value of [STANDARD[field], OWN[field]]) {
      if (value === undefined) continue;
      for (const privacyNotice of [undefined, "bubble", "none"]) {
        const stored = { [field]: value };
        if (privacyNotice) stored.privacyNotice = privacyNotice;
        const opts = {
          initial: stored,
          defaults: DEFAULTS,
          greetingKey: keys.greetingKey(stored),
        };
        const label = `${field}=${JSON.stringify(value)} ${privacyNotice}`;
        // derselbe Wert
        assert.deepEqual(
          keys.cleanConfig({ ...stored, theme: "dark" }, opts),
          { ...stored, theme: "dark" },
          label
        );
        // inhaltsgleiche Kopie (neue Objekte, z. B. nach Bearbeiten und
        // Zurücksetzen): ebenso unverändert
        const copy = JSON.parse(JSON.stringify(stored));
        assert.deepEqual(
          keys.cleanConfig({ ...copy, theme: "dark" }, opts),
          { ...stored, theme: "dark" },
          `${label} (Kopie)`
        );
        // und kein Fehler, der das Speichern blockiert
        assert.deepEqual(
          keys.validateConfig(
            { ...copy, theme: "dark" },
            stored,
            opts.greetingKey
          ),
          {},
          label
        );
      }
    }

  // Datenschutz-Text vergleicht wie die anderen Felder inhaltlich: ein Wert,
  // der kein String ist (z. B. von Hand per API gespeichert), galt als
  // inhaltsgleiche Kopie bisher als geändert (!==) und wurde entfernt
  const stored = { privacyText: ["• Erste Zeile", "• Zweite Zeile"] };
  const copy = { privacyText: [...stored.privacyText], theme: "dark" };
  assert.deepEqual(
    keys.cleanConfig(copy, { initial: stored, defaults: DEFAULTS }),
    { ...stored, theme: "dark" }
  );
  // wirklich geändert: wie bisher bereinigt (leer -> Standard)
  assert.deepEqual(
    keys.cleanConfig(
      { privacyText: "  " },
      { initial: { privacyText: "• Alt" }, defaults: DEFAULTS }
    ),
    {}
  );
});

test("C7: validateConfig prüft wie cleanConfig nur bearbeitete Felder", () => {
  // Gespeicherte Texte über den Grenzen blockieren erst nach einer Änderung
  const long = "x".repeat(400);
  const stored = {
    accentColor: "red",
    greeting: long,
    sendMessageText: long,
    privacyText: "y".repeat(1200),
  };
  assert.deepEqual(keys.validateConfig({ ...stored }, stored, "greeting"), {});
  const errors = keys.validateConfig(
    {
      accentColor: "blue",
      greeting: `${long}!`,
      sendMessageText: `${long}!`,
      privacyText: `${stored.privacyText}!`,
    },
    stored,
    "greeting"
  );
  assert.deepEqual(Object.keys(errors).sort(), [
    "accentColor",
    "greeting",
    "privacyText",
    "sendMessageText",
  ]);
  // im Modul gibt es nur noch eine Hilfe dafür
  const source = fs.readFileSync(
    path.join(
      ROOT,
      "frontend/src/pages/GeneralSettings/ChatEmbedWidgets/EmbedAppearance/widgetKeys.js"
    ),
    "utf8"
  );
  assert.doesNotMatch(source, /\bchanged\(/);
});

// ---------------------------------------------------------------------------
// C13 userTextColorAdvice ohne „stored“
// ---------------------------------------------------------------------------

test("C13: userTextColorAdvice liefert nur Empfehlung, Kontrast und Warnung", () => {
  for (const config of [
    {},
    { userTextColor: "#FFFFFF" },
    { accentColor: "#777777", userTextColor: "#222628" },
    { accentColor: "#01A5" },
  ]) {
    const advice = keys.userTextColorAdvice(config);
    assert.deepEqual(
      Object.keys(advice).sort(),
      ["ratio", "recommendedLabel", "warning"],
      JSON.stringify(config)
    );
  }
});

// ---------------------------------------------------------------------------
// C8 CopyBlock mit splitAfterSlashes
// ---------------------------------------------------------------------------

test(
  "C8: snippetWithBreaks entfällt; CopyBlock setzt die Teile aus splitAfterSlashes mit <wbr> dazwischen",
  { skip },
  async () => {
    const embedTab = await renderer.load(EMBED);
    assert.ok(!("snippetWithBreaks" in embedTab));
    const uuid = "0d6c1f3e-5a4b-4c2d-9e8f-123456789abc";
    for (const config of [{}, { displayMode: "inline" }]) {
      const html = await renderer.render(EMBED, {
        location: "/",
        props: { config, embed: { uuid } },
      });
      const pre = html.match(/<pre[^>]*>([\s\S]*?)<\/pre>/)[1];
      // je Adresse: Teil (<wbr> Teil)* genau wie splitAfterSlashes
      const runs = [
        ...pre.matchAll(
          /(?:<span class="whitespace-pre" data-snippet-part="">[^<]*<\/span>(?:<wbr\/?>)?)+/g
        ),
      ].map((m) => m[0]);
      assert.equal(runs.length, 2, pre);
      for (const run of runs) {
        const parts = [
          ...run.matchAll(
            /<span class="whitespace-pre" data-snippet-part="">([^<]*)<\/span>/g
          ),
        ].map((m) => m[1]);
        const url = parts.join("");
        assert.deepEqual(parts, embedTab.splitAfterSlashes(url));
        assert.equal(
          (run.match(/<wbr\/?>/g) || []).length,
          parts.length - 1,
          run
        );
        assert.doesNotMatch(run, /<wbr\/?>$/);
      }
    }
  }
);

// ---------------------------------------------------------------------------
// F41 (E18) Einbau-Text und Migrationsdoku
// ---------------------------------------------------------------------------

test(
  "F41 (E18): Einbau-Text verspricht den Vorrang nur für gespeicherte Einstellungen",
  { skip },
  async () => {
    for (const config of [{}, { displayMode: "inline" }]) {
      const html = await renderer.render(EMBED, {
        location: "/",
        props: { config, embed: { uuid: "abc-123" } },
      });
      const shown = text(html);
      assert.ok(
        !shown.includes(
          "Alle Einstellungen kommen automatisch aus dem Design Center und gelten auch dann"
        ),
        shown
      );
      assert.ok(
        shown.includes(
          "Gespeicherte Einstellungen gelten auch dann, wenn am Skript noch ältere Angaben stehen (z. B. data-theme); ist eine Einstellung nicht gespeichert, wirkt eine solche Angabe weiter."
        ),
        shown
      );
      // Textregeln: keine Gedankenstriche
      assert.doesNotMatch(shown, /[–—]/);
    }
  }
);

// Prüfliste der Migrationsdoku: Punkt n (bis zum nächsten Punkt)
function checkpoint(doc, n) {
  const match = doc.match(
    new RegExp(`^${n}\\. ([\\s\\S]*?)(?=^\\d+\\. |$(?![\\s\\S]))`, "m")
  );
  assert.ok(match, `Prüfpunkt ${n} fehlt`);
  return match[1].replace(/\s+/g, " ");
}

test("F41 (E18), F44, W41, E20: Migrationsdoku", () => {
  const doc = fs.readFileSync(MIGRATION, "utf8");
  // E18: Folge von F11 für ältere Darstellungs-Attribute am Skript
  const p10 = checkpoint(doc, 10);
  for (const attr of [
    "data-theme",
    "data-display-mode",
    "data-position",
    "data-chat-icon",
  ])
    assert.ok(p10.includes(`\`${attr}\``), attr);
  assert.match(p10, /solange im Design Center dafür kein Wert gespeichert ist/);
  assert.match(doc, /Gespeicherte Werte schlagen ältere Angaben am Skript/);
  // F44: Prüfpunkt 8 nennt das [] der bis 7.21 gespeicherten Widgets
  const p8 = checkpoint(doc, 8);
  assert.match(p8, /Bis 7\.21 gespeicherte Widgets haben `\[\]`/);
  assert.match(p8, /zählen, welche Kundenseiten das Attribut nutzen/);
  // W41: Prüfpunkt 9 verlangt den Vergleich ohne Query
  const p9 = checkpoint(doc, 9);
  assert.match(p9, /`\/config\?language=<Sprache>`/);
  assert.match(p9, /ohne Query vergleichen/);
  // E20: F04 als bewusste Ausnahme vermerkt
  assert.match(
    doc,
    /F04, 7\.22-rc13; bewusste Ausnahme zum Negativfall „Texte bleiben“, E20/
  );
  // Textregeln: keine Gedankenstriche
  assert.doesNotMatch(doc, /[–—]/);
});
