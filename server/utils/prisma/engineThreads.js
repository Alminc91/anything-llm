const os = require("os");

const ENV_KEY = "TOKIO_WORKER_THREADS";
// Der Wert, den dieser Prozess selbst gesetzt (und noch nicht zurückgenommen) hat
let valueSetHere = null;

/**
 * Sorgt dafür, dass die Query-Engine mehr Arbeits-Threads hat als
 * Datenbankverbindungen (KIE-532).
 *
 * Die Engine führt SQLite-Aufrufe blockierend auf ihren Arbeits-Threads aus
 * (Standard: Anzahl der CPUs), hält aber bis zu 2 × CPUs + 1 Verbindungen.
 * Wartet auf jeder freien Verbindung ein Schreiber auf die Sperre einer
 * interaktiven Transaktion (Chat-Zeile + Zählerbuch), sind alle Threads belegt,
 * und die Transaktion selbst kommt nicht mehr an die Reihe: Stillstand bis zum
 * Busy-Timeout (5 s), danach schlagen die wartenden Schreibzugriffe fehl.
 * Gemessen auf 4 Kernen ab 4 gleichzeitig wartenden Schreibern. Mit mehr
 * Threads als Verbindungen kann das nicht eintreten; wartende Threads schlafen
 * und kosten nichts.
 *
 * Die Engine liest den Wert, wenn sie mit der ersten Abfrage lädt; er muss
 * also vorher gesetzt sein. Ein vom Betrieb gesetzter Wert bleibt erhalten.
 * Abgesichert durch __tests__/models/messageLedgerConcurrency.test.js.
 */
function ensureEngineThreads() {
  if (process.env[ENV_KEY]) return;
  const cpus = os.cpus().length || 1;
  valueSetHere = String(Math.max(2 * cpus + 2, 8));
  process.env[ENV_KEY] = valueSetHere;
}

/**
 * Nimmt den Wert zurück, den ensureEngineThreads gesetzt hat. Erst aufrufen,
 * wenn die Engine geladen ist (nach der ersten Abfrage): Sie behält ihre
 * Threads. Die Variable gilt für den ganzen Prozess und würde sonst auch die
 * Threads anderer nativer Module bestimmen, die später laden (LanceDB).
 * Ein vom Betrieb gesetzter Wert wird nicht angefasst.
 */
function releaseEngineThreads() {
  if (valueSetHere !== null && process.env[ENV_KEY] === valueSetHere)
    delete process.env[ENV_KEY];
  valueSetHere = null;
}

module.exports = { ensureEngineThreads, releaseEngineThreads };
