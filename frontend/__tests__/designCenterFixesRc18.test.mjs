// Korrekturrunde 7.22-rc18 (Fixliste fixliste-7.22-rc18.md, Abschnitt
// „F · Fork“, Nachreview rc17; Entscheidungen E26 und E28 vom 21.10.2026):
// F60 Migrationsdoku: alle fünf Seiten-Variablen der Gruppe A, Seiten-CSS
//     ohne Konsolenwarnung, Prüfpunkt 10 sucht im Seiten-CSS.
// F61 Reiter Einbau nach E28: „Was Sie hier im Design Center einstellen,
//     ändern Angaben im Einbau-Code nicht.“ (Gruppe-B-Angaben wirken weiter.)
// F62 Gruppe B eingegrenzt (courseCardsAnswerStyle nur Prompt, onlineDot
//     entfernt, KI-Hinweis gesperrt), Gruppe C in der Einleitung.
// E26 Datenschutz-Hinweis an erzwingt die Begrüßungsblase, auch gegen
//     data-greeting-style="text" (Doku). Seit 7.23 Stand bis 7.22.2:
//     data-greeting-style wirkt nicht mehr (Gruppe A, D2 gekippt am
//     24.10.2026, Fixliste datenschutz-fusszeile rc2 F8).
// C20 Kommentare zu data-display-mode nach E23.
// C21 Begründung des Kennzeichens defaultMessagesStandard.
// Server-Seite (F60 Gruppe A, F62 Gruppe B gegen EMBED_FIXED_STANDARDS):
// Jest-Test embedConfigEndpoint („E23“).
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createRenderer,
  hasFrontendDeps,
} from "./helpers/renderSettingsPage.mjs";

const EMBED =
  "/src/pages/GeneralSettings/ChatEmbedWidgets/EmbedAppearance/EmbedTab.jsx";
const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  ".."
);
const MIGRATION = path.join(ROOT, "docs", "design-center-2-migration.md");
const STANDARDS = path.join(ROOT, "server/utils/chats/embedStandards.js");
const skip = hasFrontendDeps
  ? false
  : "frontend/node_modules nicht installiert";

// Die fünf CSS-Variablen, die das Widget aus dem Design Center setzt
// (Widget src/utils/theme.js, Einträge mit dc: true)
const PAGE_VARS = [
  "--allm-accent",
  "--allm-on-accent",
  "--allm-user-bg",
  "--allm-user-text",
  "--allm-link",
];

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

const readDoc = () => fs.readFileSync(MIGRATION, "utf8");

// Prüfliste der Migrationsdoku: Punkt n (bis zum nächsten Punkt)
function checkpoint(doc, n) {
  const match = doc.match(
    new RegExp(`^${n}\\. ([\\s\\S]*?)(?=^\\d+\\. |$(?![\\s\\S]))`, "m")
  );
  assert.ok(match, `Prüfpunkt ${n} fehlt`);
  return match[1].replace(/\s+/g, " ");
}

// Punkt einer Gruppe: vom fett gesetzten Namen bis zum nächsten Punkt
function bullet(doc, name) {
  const start = doc.indexOf(`- **${name}`);
  assert.ok(start >= 0, `Punkt ${name} fehlt`);
  const end = doc.indexOf("\n- **", start + 1);
  const stop = doc.indexOf("\n\n", start);
  const until = [end, stop].filter((i) => i >= 0);
  return doc
    .slice(start, until.length ? Math.min(...until) : undefined)
    .replace(/\s+/g, " ");
}

// Tabellenzeile, deren erste Spalte genau diesen Schlüssel nennt
function tableRow(doc, key, contains = "") {
  const rows = doc
    .split("\n")
    .filter(
      (line) =>
        line.startsWith("|") &&
        line.split("|")[1].trim() === `\`${key}\`` &&
        line.includes(contains)
    );
  assert.equal(rows.length, 1, `Tabellenzeile ${key} (${contains})`);
  return rows[0].replace(/\s+/g, " ");
}

// Kommentartext einer Quelldatei ohne Kommentarzeichen, Leerraum gefaltet
function commentText(file) {
  return fs
    .readFileSync(path.join(ROOT, file), "utf8")
    .replace(/^\s*(\/\/|\/?\*+\/?|\{\/\*)/gm, " ")
    .replace(/\s+/g, " ");
}

// ---------------------------------------------------------------------------
// F61 (E28) Einbau-Text
// ---------------------------------------------------------------------------

test(
  "F61 (E28): Einbau-Text sagt, dass Angaben im Einbau-Code nicht ändern, was das Design Center einstellt",
  { skip },
  async () => {
    for (const config of [{}, { displayMode: "inline" }, { theme: "dark" }]) {
      const html = await renderer.render(EMBED, {
        location: "/",
        props: { config, embed: { uuid: "abc-123" } },
      });
      const shown = text(html);
      assert.ok(
        shown.includes(
          "Der Einbau-Code braucht nur diese Angaben. Was Sie hier im Design Center einstellen, ändern Angaben im Einbau-Code nicht. Nach dem Speichern muss auf der Website nichts geändert werden."
        ),
        shown
      );
      // der Wortlaut aus rc17 sagte zu viel zu: Gruppe-B-Angaben wirken
      assert.ok(!shown.includes("Aussehen und Texte stellen Sie"), shown);
      assert.ok(!shown.includes("Angaben dazu im Einbau-Code wirken"), shown);
      assert.doesNotMatch(shown, /[–—]/);
    }
  }
);

// ---------------------------------------------------------------------------
// F60 Seiten-Variablen der Gruppe A
// ---------------------------------------------------------------------------

test("F60: Gruppe A nennt alle fünf Seiten-Variablen, Konsole nur für Einbau-Angaben", () => {
  const doc = readDoc();
  const groupA = bullet(doc, "Gruppe A");
  for (const name of PAGE_VARS) assert.ok(groupA.includes(`\`${name}\``), name);
  // Seiten-CSS übergeht das Widget still; die Konsole meldet nur Angaben
  // im Einbau-Code
  assert.match(
    groupA,
    /CSS-Variablen der Seite übergeht es ohne Konsolenwarnung/
  );
  assert.match(
    groupA,
    /Verworfene Angaben im Einbau-Code meldet es in der Browser-Konsole/
  );
  assert.doesNotMatch(
    groupA,
    /meldet verworfene Angaben in der Browser-Konsole/
  );
  // Tabellenzeile Akzentfarbe
  const row = tableRow(doc, "accentColor", "gespeichert");
  for (const name of PAGE_VARS) assert.ok(row.includes(`\`${name}\``), name);
});

test("F60: Prüfpunkt 10 lässt das Seiten-CSS nach den fünf Variablen durchsuchen", () => {
  const p10 = checkpoint(readDoc(), 10);
  for (const name of PAGE_VARS) assert.ok(p10.includes(`\`${name}\``), name);
  assert.match(p10, /im Seiten-CSS .* nach diesen fünf Variablen suchen/);
  assert.match(p10, /Seiten-CSS übergeht es ohne Konsolenwarnung/);
  // der Satz ohne Eingrenzung ist weg
  assert.doesNotMatch(
    p10,
    /Das Widget meldet verworfene Angaben in der Browser-Konsole\./
  );
  // rc17 bleibt
  assert.match(
    p10,
    /wirken ab 7\.22 nicht mehr, auch wenn im Design Center dafür nichts gespeichert ist/
  );
  assert.match(p10, /Gruppe-B-Angaben .* wirken weiter/);
});

// ---------------------------------------------------------------------------
// F62 Gruppe B eingegrenzt, Gruppe C in der Einleitung
// ---------------------------------------------------------------------------

test("F62: Gruppe B nennt die festen Standards, die sich nicht verfeinern lassen", () => {
  const doc = readDoc();
  const groupB = bullet(doc, "Gruppe B");
  assert.match(groupB, /Einbau-Angabe schlägt den festen Standard/);
  assert.match(groupB, /Nicht verfeinerbar sind/);
  assert.match(
    groupB,
    /`courseCardsAnswerStyle` \([^)]*nur der Server für den Prompt/
  );
  assert.match(
    groupB,
    /`onlineDot` \([^)]*`data-online-dot` bleibt ohne Wirkung/
  );
  assert.match(groupB, /KI-Hinweis \(`disclaimer`, gesperrt/);
  // Einleitung: Gruppe B und Gruppe C
  const intro = doc.slice(doc.indexOf("Übersicht für den Flotten-Rollout"));
  const para = intro.slice(0, intro.indexOf("\n\n")).replace(/\s+/g, " ");
  assert.match(para, /\(Gruppe B\)/);
  assert.match(para, /wirken immer \(Gruppe C\)/);
  assert.doesNotMatch(doc, /[–—]/);
});

test("F62: Kopfkommentar von embedStandards.js grenzt die Verfeinerung ein", () => {
  const source = fs.readFileSync(STANDARDS, "utf8");
  const head = source
    .slice(0, source.indexOf("\nconst "))
    .replace(/^\/\/ ?/gm, "")
    .replace(/\s+/g, " ");
  assert.match(head, /Ausgenommen sind/);
  for (const part of [
    /KI-Hinweis \(disclaimer, E24/,
    /courseCardsAnswerStyle \(liest nur der Server für den Prompt/,
    /onlineDot \(Online-Punkt entfernt, data-online-dot ohne Wirkung\)/,
    /E26/,
    /Gruppe C/,
  ])
    assert.match(head, part);
});

// ---------------------------------------------------------------------------
// E26 Datenschutz-Hinweis erzwingt die Begrüßungsblase (bis 7.22.2), ab
// 7.23 Begrüßung immer als Blase
// ---------------------------------------------------------------------------

// Bewusste Änderung (Datenschutz-Fußzeile, 7.23): Es gibt keine
// Datenschutz-Blase mehr, an der die Begrüßungsblase hing. Seit D2 gekippt
// ist (Nutzer 24.10.2026, Fixliste datenschutz-fusszeile rc2 F8, Gegenstück
// W13 im Widget) ist die Form der Begrüßung keine Einbau-Angabe mehr: Die
// Begrüßung ist immer eine Blase, data-greeting-style wirkt nicht (Gruppe A
// wie data-privacy-notice, das Widget meldet die Angabe in der Konsole).
// E26 bleibt als Stand bis 7.22.2 genannt (Gruppe B, „text“ wirkte nur bei
// abgeschaltetem Datenschutz-Hinweis, also praktisch nie). In 7.23-rc1/rc2
// stand hier noch „verfeinert wie jede Gruppe-B-Angabe“ (D2).
test("E26: Migrationsdoku und Kopfkommentar: data-greeting-style ab 7.23 ohne Wirkung (Gruppe A), E26 als Stand bis 7.22.2", () => {
  const doc = readDoc();
  const groupA = bullet(doc, "Gruppe A");
  const groupB = bullet(doc, "Gruppe B");
  assert.match(groupA, /`data-greeting-style`/);
  assert.match(groupA, /`greetingStyle: "bubble"`/);
  assert.doesNotMatch(groupB, /data-greeting-style/);
  assert.doesNotMatch(groupB, /Begrüßungs-, Vorschlags-/);
  assert.doesNotMatch(groupB, /hat ab 7\.23 keinen Anlass mehr/);
  const row = tableRow(doc, "greetingStyle");
  assert.match(row, /`data-greeting-style` am Skript ab 7\.23 ohne Wirkung/);
  assert.match(row, /Gruppe A/);
  assert.match(row, /Konsole/);
  assert.match(row, /E26/);
  assert.match(row, /7\.22 bis 7\.22\.2/);
  assert.doesNotMatch(row, /verfeinert wie jede Gruppe-B-Angabe/);
  assert.match(tableRow(doc, "privacyNotice", "`bubble`, `modal`"), /E26/);
  assert.match(
    tableRow(doc, "privacyNotice", "`bubble`, `modal`"),
    /keine Datenschutz-Blase beim Start mehr/
  );
  // Prüfpunkt 10: kein Abgleich nötig, sichtbar ändert sich nichts
  assert.match(
    checkpoint(doc, 10),
    /`data-greeting-style` braucht ebenfalls keinen Abgleich/
  );
  // Kopfkommentar von embedStandards.js wie die Doku
  const source = fs.readFileSync(STANDARDS, "utf8");
  const head = source
    .slice(0, source.indexOf("\nconst "))
    .replace(/^\/\/ ?/gm, "")
    .replace(/\s+/g, " ");
  assert.doesNotMatch(head, /wie jede Gruppe-B-Angabe gelten/);
  assert.match(
    head,
    /greetingStyle liefert der Server fest "bubble" .* zählt seit 7\.23 wie privacyNotice zu Gruppe A: data-greeting-style wird verworfen und in der Konsole gemeldet/
  );
});

// ---------------------------------------------------------------------------
// C20 Kommentare zu data-display-mode, C21 Kennzeichen defaultMessagesStandard
// ---------------------------------------------------------------------------

test("C20: Kommentare beschreiben keinen Inline-Modus per Skript-Angabe mehr", () => {
  for (const file of [
    "server/utils/chats/embedStandards.js",
    "server/utils/chats/embedCourseSources.js",
    "frontend/src/pages/GeneralSettings/ChatEmbedWidgets/EmbedConfigs/EmbedRow/CodeSnippetModal/index.jsx",
  ]) {
    const comments = commentText(file);
    assert.doesNotMatch(comments, /Inline nur per Script-Attribut/, file);
    assert.doesNotMatch(
      comments,
      /Modus noch per Script-Attribut verlangt/,
      file
    );
    assert.doesNotMatch(comments, /nur per Script-Attribut in der Seite/, file);
    assert.doesNotMatch(comments, /oder data-display-mode="inline"/, file);
  }
});

test("C21: Kennzeichen defaultMessagesStandard bleibt für ältere Widgets, das Widget ab rc17 wertet es nicht aus", () => {
  const doc = readDoc();
  assert.doesNotMatch(doc, /Das Widget erkennt daran/);
  assert.match(
    doc.replace(/\s+/g, " "),
    /Das Widget ab 7\.22-rc17 wertet `defaultMessagesStandard` nicht aus/
  );
  const endpoint = commentText("server/endpoints/embed/index.js");
  assert.doesNotMatch(endpoint, /damit das Widget den Standard erkennt/);
  assert.match(endpoint, /das Widget ab 7\.22-rc17 wertet es nicht aus/);
});
