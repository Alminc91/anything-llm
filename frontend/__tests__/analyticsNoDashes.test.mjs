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

// Restpunkt 2 (rc7): die englische Konversationsseite nannte „– the key
// figures keep counting“ mit Gedankenstrich; Gegenstück zu de content-gap.
// Die übrigen englischen Texte der Statistikseite (Entscheidung D8 galt den
// deutschen Texten) bleiben hier außen vor.
test("Restpunkt 2: englischer Hinweis zu fehlenden Inhalten ohne Gedankenstrich", () => {
  for (const key of ["content-gap_one", "content-gap_other"]) {
    const text = en["embed-analytics"].list[key];
    assert.doesNotMatch(text, DASH, key);
    assert.ok(
      text.endsWith("deleted here). The key figures keep counting."),
      key
    );
  }
});

// S4 (Fixliste 7.22-rc10): auch die englischen Texte der Statistik- und
// Konversationsseite ohne Gedankenstrich, einschließlich der Texte, die nur
// als title oder aria-label erscheinen (Säulen-Tooltip „{{period}} · {{value}}“,
// „{{value}} negative: …“, Export-Hinweis). Der Bis-Strich ohne Leerraum
// („{{from}}–{{to}}“) bleibt auch hier erlaubt.
test("S4: englische Texte der Statistik- und Konversationsseite ohne Gedankenstrich (sichtbar, title, aria-label)", () => {
  const found = strings(en["embed-analytics"], ["embed-analytics"]).filter(
    ([, text]) => DASH.test(text)
  );
  assert.deepEqual(found, []);
  const a = en["embed-analytics"];
  // die drei beanstandeten Stellen wörtlich
  assert.equal(
    a.kpi["conversations-hint"],
    "Conversations started in the period. The list below only shows conversations whose contents still exist. The numbers may therefore differ."
  );
  assert.equal(a.chart.tooltip, "{{period}} · {{value}}");
  assert.equal(
    a.export.hint,
    "Exports the conversations of the current selection (widget, period and filter)."
  );
  // zusammengesetztes aria-label einer Säule wie in der Nachprüfung rc8
  const aria = a.chart.tooltip
    .replace("{{period}}", "Mon, 19.10.2026")
    .replace(
      "{{value}}",
      a.chart.value.messages_other.replace("{{formatted}}", "8")
    );
  assert.equal(aria, "Mon, 19.10.2026 · 8 messages");
  assert.doesNotMatch(aria, DASH);
});
