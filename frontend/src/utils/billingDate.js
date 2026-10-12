// Der Zyklus eines Workspaces wird in Berliner Zeit abgerechnet: Starttag ist
// der Berliner Kalendertag von cycleStartDate (server/utils/helpers/billingWindow.js).
const BILLING_TIME_ZONE = "Europe/Berlin";

const berlinDayFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: BILLING_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/**
 * Starttag des Zyklus für ein Datumsfeld (YYYY-MM-DD): der Berliner
 * Kalendertag des gespeicherten Zeitpunkts, unabhängig von der Zeitzone des
 * Browsers. Nicht der UTC-Tag: "2026-09-01T00:00:00+02:00" ist als
 * 2026-08-31T22:00Z gespeichert, abgerechnet wird ab dem 01.09. Der Server
 * erkennt genau diesen Tag als unverändert (sameBillingDate), wenn das
 * Formular ihn zurücksendet.
 * @param {string|Date|null|undefined} dateValue
 * @returns {string} - "YYYY-MM-DD" oder "" ohne gültiges Datum
 */
export function formatDateForInput(dateValue) {
  if (!dateValue) return "";
  const date = new Date(dateValue);
  if (isNaN(date.getTime())) return "";
  const parts = {};
  for (const { type, value } of berlinDayFormatter.formatToParts(date))
    parts[type] = value;
  return `${parts.year.padStart(4, "0")}-${parts.month}-${parts.day}`;
}
