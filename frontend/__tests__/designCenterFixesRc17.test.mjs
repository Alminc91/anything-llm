// Korrekturrunde 7.22-rc17 (Fixliste fixliste-7.22-rc17.md, Abschnitt
// „F · Fork“, Rangfolge E23 und E24, Nutzer 21.10.2026; ersetzt E18 aus
// rc16 und ändert E10):
// F50 Reiter Einbau: Der Einbau-Code braucht nur die Angaben aus dem
//     Schnipsel; Angaben im Einbau-Code ändern nicht, was das Design Center
//     einstellt (statt der Zusage aus E18, rc16; Wortlaut seit rc18 nach
//     E28, F61).
// F51 Migrationsdoku: Abschnitt zu Angaben im Einbau-Code und CSS-Variablen
//     nach E23 und E24, Prüfpunkte 8 bis 10, Vertrag der Startvorschläge nach
//     E10 neu (gespeichert vor Standard, Skript-Attribut ohne Wirkung).
// Server-Seite (F52, Gruppen gegen die Antwort von /config): Jest-Tests
// embedConfigContract und embedConfigEndpoint („E23“).
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
// F50 Einbau-Text nach E23
// ---------------------------------------------------------------------------

test(
  "F50 (E23, Wortlaut seit rc18 nach E28): Einbau-Text sagt, dass der Einbau-Code nur diese Angaben braucht und Angaben darin nicht ändern, was das Design Center einstellt",
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
          "Der Einbau-Code braucht nur diese Angaben. Was Sie hier im Design Center einstellen, ändern Angaben im Einbau-Code nicht."
        ),
        shown
      );
      // E18 (rc16) ist überholt: keine Zusage mehr, dass eine Angabe ohne
      // gespeicherten Wert weiter wirkt, und kein Beispiel data-theme
      assert.ok(!shown.includes("wirkt eine solche Angabe weiter"), shown);
      assert.ok(!shown.includes("Gespeicherte Einstellungen gelten"), shown);
      assert.doesNotMatch(shown, /data-theme/);
      // „nur diese Angaben“ stimmt: der Schnipsel hat genau die zwei
      // Pflichtangaben
      const pre = text(html.match(/<pre[^>]*>([\s\S]*?)<\/pre>/)[1]);
      assert.deepEqual(
        [...pre.matchAll(/\b(data-[a-z-]+)=/g)].map((m) => m[1]),
        ["data-embed-id", "data-base-api-url"]
      );
      // Textregeln: keine Gedankenstriche
      assert.doesNotMatch(shown, /[–—]/);
    }
  }
);

// ---------------------------------------------------------------------------
// F51 Migrationsdoku nach E23 und E24
// ---------------------------------------------------------------------------

// Prüfliste der Migrationsdoku: Punkt n (bis zum nächsten Punkt)
function checkpoint(doc, n) {
  const match = doc.match(
    new RegExp(`^${n}\\. ([\\s\\S]*?)(?=^\\d+\\. |$(?![\\s\\S]))`, "m")
  );
  assert.ok(match, `Prüfpunkt ${n} fehlt`);
  return match[1].replace(/\s+/g, " ");
}

// Abschnitt ab einer Überschrift bis zur nächsten Überschrift gleicher Ebene
function section(doc, heading) {
  const start = doc.indexOf(heading);
  assert.ok(start >= 0, `Abschnitt ${heading} fehlt`);
  const end = doc.indexOf("\n## ", start + heading.length);
  return doc.slice(start, end < 0 ? undefined : end).replace(/\s+/g, " ");
}

test("F51 (E23, E24): Abschnitt zu Angaben im Einbau-Code und CSS-Variablen", () => {
  const doc = fs.readFileSync(MIGRATION, "utf8");
  const part = section(
    doc,
    "## Angaben im Einbau-Code und CSS-Variablen der Seite"
  );
  assert.match(part, /ersetzt E18/);
  // drei Gruppen und der KI-Hinweis
  for (const name of [
    "Gruppe A, im Design Center einstellbar",
    "Gruppe B, feste Standards ohne Feld im Design Center",
    "Gruppe C, Technik und Verhalten",
    "KI-Hinweis (E24)",
  ])
    assert.ok(part.includes(`**${name}`), name);
  assert.match(
    part,
    /wirken nicht, auch wenn im Design Center nichts gespeichert ist/
  );
  assert.match(part, /Einbau-Angabe schlägt den festen Standard/);
  assert.match(
    part,
    /Datenschutz-Hinweis schaltet nur der Schalter im Design Center/
  );
  // E18 nicht mehr als geltende Regel
  assert.doesNotMatch(
    doc,
    /Gespeicherte Werte schlagen ältere Angaben am Skript/
  );
  assert.doesNotMatch(doc, /wirkt ein älteres `data-display-mode`/);
});

test("F51: Vertrag der Startvorschläge nach E10 neu (gespeichert vor Standard, Skript-Attribut ohne Wirkung)", () => {
  const doc = fs.readFileSync(MIGRATION, "utf8");
  const part = section(
    doc,
    "## Startvorschläge und Willkommensblasen in `GET /embed/:id/config`"
  );
  assert.match(
    part,
    /\*\*Vorrang im Widget \(E10 neu, E23, 7\.22-rc17\):\*\* gespeicherte Liste \(auch leer\) vor dem Standard\./
  );
  assert.match(
    part,
    /`data-default-messages` am Skript wirkt nicht, auch wenn nichts gespeichert ist/
  );
  assert.match(part, /`data-chatbot-bubbles-messages` wirkt nicht/);
  // Kennzeichen bleiben (für ältere Widget-Kopien und den Vertrag, C21)
  assert.match(part, /`defaultMessagesStandard: true`/);
  assert.match(part, /Kennzeichen bleiben/);
  // alte Reihenfolge Skript vor Standard und das Komma-Trennen der
  // Skript-Attribute sind weg
  assert.doesNotMatch(
    part,
    /vor\s+`data-default-messages` am Skript vor dem Standard/
  );
  assert.doesNotMatch(part, /werden weiter\s+an Kommas getrennt/);
  // Tabelle: data-default-messages hat keinen Vorrang mehr
  assert.doesNotMatch(doc, /`data-default-messages` am Skript hat Vorrang/);
});

test("F51: Prüfpunkte 8 bis 10 nach E23", () => {
  const doc = fs.readFileSync(MIGRATION, "utf8");
  const p8 = checkpoint(doc, 8);
  assert.match(
    p8,
    /Das Attribut wirkt ab 7\.22 nicht mehr, auch wenn im Design Center keine Liste gespeichert ist/
  );
  assert.doesNotMatch(p8, /wirken weiter, solange/);
  // F44 bleibt
  assert.match(p8, /Bis 7\.21 gespeicherte Widgets haben `\[\]`/);
  assert.match(p8, /zählen, welche Kundenseiten das Attribut nutzen/);

  const p9 = checkpoint(doc, 9);
  // W41 bleibt
  assert.match(p9, /ohne Query vergleichen/);
  // Demo und Einbau-Paket vhs Rhein: Gruppe A raus, Gruppe B darf bleiben,
  // Topbar-Schalter über die /config-Antwort
  assert.match(p9, /Einbau-Paket vhs Rhein/);
  assert.match(p9, /Gruppe-A-Angaben entfernen/);
  assert.match(p9, /Inline-Feinheiten \(Gruppe B\) dürfen bleiben/);
  assert.match(p9, /in die `\/config`-Antwort statt in Attribute/);

  const p10 = checkpoint(doc, 10);
  for (const name of [
    "data-theme",
    "data-display-mode",
    "data-position",
    "data-chat-icon",
    "data-button-color",
    "--allm-accent",
    "--allm-on-accent",
  ])
    assert.ok(p10.includes(`\`${name}\``), name);
  assert.match(
    p10,
    /wirken ab 7\.22 nicht mehr, auch wenn im Design Center dafür nichts gespeichert ist/
  );
  assert.match(p10, /ersetzt E18/);
  assert.doesNotMatch(
    p10,
    /solange im Design Center dafür kein Wert gespeichert ist/
  );
  assert.match(p10, /Gruppe-B-Angaben .* wirken weiter/);
  // nach 10 nur noch Prüfpunkt 11 (E30, Fixliste 7.22-rc20 F84, Prüfung in
  // designCenterFixesRc20.test.mjs) und, bewusst geändert in rc22 (E41,
  // F101), Prüfpunkt 12 (Prüfung in designCenterFixesRc22.test.mjs)
  assert.doesNotMatch(doc, /^13\. /m);
  // Textregeln: keine Gedankenstriche
  assert.doesNotMatch(doc, /[–—]/);
});
