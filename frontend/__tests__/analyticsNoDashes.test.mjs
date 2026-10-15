// Fixliste 7.22-rc3, D8 (Browser G-1): keine Gedankenstriche in sichtbaren
// Texten der Konversations- und Statistikseite. Ein Gedankenstrich ist ein
// „–“ oder „—“ mit Leerraum davor oder danach bzw. allein als Wert; der
// Bis-Strich ohne Leerraum („10–11 Uhr“, „{{from}}–{{to}}“) bleibt erlaubt.
// Fehlende Zahlenwerte stehen als „k. A.“ da.
import test from "node:test";
import assert from "node:assert/strict";
import de from "../src/locales/de/common.js";
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
