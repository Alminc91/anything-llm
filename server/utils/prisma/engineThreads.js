const os = require("os");

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
 * Muss vor dem ersten Laden der Engine laufen. Ein vom Betrieb gesetzter Wert
 * bleibt erhalten. Abgesichert durch
 * __tests__/models/messageLedgerConcurrency.test.js.
 */
function ensureEngineThreads() {
  if (process.env.TOKIO_WORKER_THREADS) return;
  const cpus = os.cpus().length || 1;
  process.env.TOKIO_WORKER_THREADS = String(Math.max(2 * cpus + 2, 8));
}

module.exports = { ensureEngineThreads };
