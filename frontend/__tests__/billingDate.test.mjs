// KIE-533: Das Datumsfeld „Zyklusstart“ der Abrechnungsansicht zeigt den Tag,
// ab dem abgerechnet wird: den Berliner Kalendertag von cycleStartDate, nicht
// den UTC-Tag. Der Server erkennt genau diesen Tag als unverändert, wenn das
// Formular ihn zurücksendet (server/models/workspace.js, sameBillingDate).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { formatDateForInput } from "../src/utils/billingDate.js";

const BILLING_ADMIN_VIEW =
  "../src/pages/WorkspaceSettings/BillingSettings/BillingAdminView.jsx";
// Die Fensterlogik des Servers; die Datei hat keine Abhängigkeiten.
const { berlinDayOf } = createRequire(import.meta.url)(
  "../../server/utils/helpers/billingWindow.js"
);

test("reiner Tageswert (00:00 UTC): derselbe Tag", () => {
  assert.equal(formatDateForInput("2026-01-15T00:00:00.000Z"), "2026-01-15");
  assert.equal(formatDateForInput("2026-07-15T00:00:00.000Z"), "2026-07-15");
  assert.equal(formatDateForInput(new Date("2026-01-15")), "2026-01-15");
});

test("Zeitpunkt am späten UTC-Abend: der Berliner Tag, nicht der UTC-Tag", () => {
  // "2026-09-01T00:00:00+02:00" - abgerechnet wird ab dem 01.09.
  assert.equal(formatDateForInput("2026-08-31T22:00:00.000Z"), "2026-09-01");
  assert.equal(formatDateForInput("2026-09-30T22:00:00.000Z"), "2026-10-01");
  // Winterzeit: Berlin = UTC + 1
  assert.equal(formatDateForInput("2026-01-31T23:00:00.000Z"), "2026-02-01");
  assert.equal(formatDateForInput("2026-01-31T22:59:59.999Z"), "2026-01-31");
  assert.equal(formatDateForInput("2025-12-31T23:30:00.000Z"), "2026-01-01");
  // letzte Millisekunde des Berliner 31.08.
  assert.equal(formatDateForInput("2026-08-31T21:59:59.999Z"), "2026-08-31");
});

test("ohne gültiges Datum bleibt das Feld leer", () => {
  for (const value of [null, undefined, "", "abc", new Date(NaN)])
    assert.equal(formatDateForInput(value), "");
});

test("derselbe Tag wie das Abrechnungsfenster des Servers (berlinDayOf)", () => {
  // stündlich über Jahreswechsel und beide Zeitumstellungen 2026
  const HOUR = 60 * 60 * 1000;
  for (const from of ["2025-12-30", "2026-03-27", "2026-10-23", "1999-05-30"]) {
    const start = new Date(`${from}T00:00:00.000Z`).getTime();
    for (let hour = 0; hour < 96; hour++) {
      const instant = new Date(start + hour * HOUR);
      assert.equal(
        formatDateForInput(instant.toISOString()),
        berlinDayOf(instant),
        instant.toISOString()
      );
    }
  }
});

test("die Abrechnungsansicht füllt das Feld mit formatDateForInput aus billingDate", () => {
  const source = readFileSync(
    new URL(BILLING_ADMIN_VIEW, import.meta.url),
    "utf8"
  );
  assert.match(
    source,
    /import \{ formatDateForInput \} from "@\/utils\/billingDate";/
  );
  assert.match(
    source,
    /useState\(\s*formatDateForInput\(workspace\?\.cycleStartDate\)\s*\)/
  );
  // kein eigener UTC-Tag mehr in der Ansicht
  assert.doesNotMatch(source, /toISOString\(\)/);
});
