// Fixliste 7.22-rc3, D8 (Browser G-1): keine Gedankenstriche in sichtbaren
// Texten der Konversations- und Statistikseite. Ein Gedankenstrich ist ein
// „–“ oder „—“ mit Leerraum davor oder danach bzw. allein als Wert; der
// Bis-Strich ohne Leerraum („10–11 Uhr“, „{{from}}–{{to}}“) bleibt erlaubt.
// Fehlende Zahlenwerte stehen als „k. A.“ da.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import de from "../src/locales/de/common.js";
import en from "../src/locales/en/common.js";
import { dayGroupLabel, shortDayLabel } from "../src/utils/conversationView.js";

const DASH = /(^|\s| )[–—]|[–—](\s| |$)/;

function strings(value, path = []) {
  if (typeof value === "string") return [[path.join("."), value]];
  if (value && typeof value === "object")
    return Object.entries(value).flatMap(([key, v]) =>
      strings(v, [...path, key])
    );
  return [];
}

test("D8: deutsche Texte der Statistik- und Konversationsseite ohne Gedankenstrich", () => {
  const found = strings(de["embed-analytics"], ["embed-analytics"]).filter(
    ([, text]) => DASH.test(text)
  );
  assert.deepEqual(found, []);
});

test("D8: unbekannter Tag in der Konversationsliste als „k. A.“", () => {
  const t = (key) => key;
  assert.equal(dayGroupLabel("", "2026-10-13", { t }), "k. A.");
  assert.equal(shortDayLabel("", "2026-10-13"), "k. A.");
});

// Review 7.22-rc6 F09: der Platzhalter folgt der Sprache der Oberfläche
// (de „k. A.“, en „n/a“), kein fester Text mehr im Code
test("F09: Platzhalter für fehlende Werte je Sprache", () => {
  const tOf = (lang) => (key) =>
    key.split(".").reduce((o, k) => o?.[k], lang) ?? key;
  assert.equal(de["embed-analytics"]["no-value"], "k. A.");
  assert.equal(en["embed-analytics"]["no-value"], "n/a");
  assert.equal(en["embed-analytics"]["weekday-hour"].legend.unused, "n/a");
  assert.equal(dayGroupLabel("", "2026-10-13", { t: tOf(en) }), "n/a");
  assert.equal(shortDayLabel("", "2026-10-13", { t: tOf(en) }), "n/a");
  assert.equal(shortDayLabel("", "2026-10-13", { t: tOf(de) }), "k. A.");
  const grid = readFileSync(
    new URL(
      "../src/pages/GeneralSettings/ChatEmbedWidgets/EmbedAnalytics/StatisticsGrid.jsx",
      import.meta.url
    ),
    "utf8"
  );
  assert.doesNotMatch(grid, /"k\. A\."/);
  assert.match(grid, /t\("embed-analytics\.no-value"\)/);
});

// Review 7.22-rc6 F04: neue Schlüssel stehen in allen Sprachdateien (sonst
// schlägt die Übersetzungsprüfung der CI fehl)
test("F04: Übersetzungsprüfung (verifyTranslations) besteht", () => {
  const dir = fileURLToPath(new URL("../src/locales/", import.meta.url));
  const { status, stdout, stderr } = spawnSync(
    process.execPath,
    ["verifyTranslations.mjs"],
    { cwd: dir, encoding: "utf8" }
  );
  assert.equal(status, 0, `${stdout}\n${stderr}`.slice(-2000));
});
