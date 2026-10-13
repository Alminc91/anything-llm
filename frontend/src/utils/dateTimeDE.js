// Deutsche Zeitstempel „23.04.2025, 12:30:57 Uhr“ (CLAUDE.md, „Zentrale
// Funktion: formatDateTimeDE()“). Eigenes Modul ohne Abhängigkeiten (kein
// moment): So nutzen es auch Hilfsdateien, die ohne Frontend-Pakete laufen
// (utils/conversationView.js, Fixliste 5 S3). utils/directories.js
// exportiert es weiter – bestehende Importe bleiben gültig.

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
  return (
    date.toLocaleDateString("de-DE", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      ...(timeZone ? { timeZone } : {}),
    }) + " Uhr"
  );
}
