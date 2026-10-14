// Deutsche Zeitstempel „23.04.2025, 12:30:57 Uhr“ (CLAUDE.md, „Zentrale
// Funktion: formatDateTimeDE()“). Eigenes Modul ohne Abhängigkeiten (kein
// moment): So nutzen es auch Hilfsdateien, die ohne Frontend-Pakete laufen
// (utils/conversationView.js, Fixliste 5 S3). utils/directories.js
// exportiert es weiter – bestehende Importe bleiben gültig.

// Ein Formatierer je Zeitzone (Fixliste 6, K2): toLocaleDateString mit
// Optionen baut bei jedem Aufruf einen neuen – rund 80 µs statt 3 µs, und
// die Liste formatiert je Zeile und Rendern einen Zeitstempel. Schlüssel ""
// = Zeitzone des Browsers.
const formatters = new Map();
function formatterFor(timeZone) {
  const key = timeZone ?? "";
  let formatter = formatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("de-DE", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      ...(timeZone ? { timeZone } : {}),
    });
    formatters.set(key, formatter);
  }
  return formatter;
}

/**
 * Formatiert einen ISO-Zeitstempel in ein deutsches Datumsformat mit Uhrzeit
 * @param {string|number|Date} isoString - Zeitpunkt (z.B. "2025-04-23T12:30:57.634Z")
 * @param {{timeZone?: string}} [options] - timeZone: feste Zeitzone (z. B.
 *   "Europe/Berlin"); ohne Angabe die des Browsers wie bisher
 * @returns {string} Formatiertes Datum (z.B. "23.04.2025, 12:30:57 Uhr");
 *   "-" ohne gültigen Zeitpunkt
 */
export function formatDateTimeDE(isoString, { timeZone } = {}) {
  if (!isoString) return "-";
  const date = new Date(isoString);
  if (isNaN(date.getTime())) return "-";
  return formatterFor(timeZone).format(date) + " Uhr";
}
