/**
 * Aufbewahrung alter LanceDB-Tabellenversionen.
 *
 * optimize() ohne Stichtag behält Versionen 7 Tage (LanceDB-Standard). Jede Compaction und
 * jeder Index-Neubau schreibt Daten neu; bei stündlichen Kurs-Updates wuchs eine Tabelle so
 * auf >60 GB. Wir behalten 1 Tag — die Suche liest immer nur die aktuelle Version.
 *
 * Schutz laufender Leser: Eine Suche öffnet die Tabelle auf der gerade aktuellen Version.
 * War die Tabelle >1 Tag unverändert, ist diese Version selbst älter als der Stichtag und würde
 * beim nächsten delete → add → optimize gelöscht, während die Suche noch liest. Deshalb liegt
 * der Stichtag nie nach dem Zeitstempel der Version, die vor READER_GRACE_MS aktuell war
 * (LanceDB löscht nur Versionen STRIKT älter als der Stichtag).
 * Dateien ohne Manifest (laufende Transaktionen) schützt deleteUnverified=false weiter 7 Tage.
 */

const LANCE_VERSION_RETENTION_MS = 24 * 60 * 60 * 1000;
const READER_GRACE_MS = 10 * 60 * 1000;

/**
 * @param {{listVersions?: () => Promise<{version:number,timestamp:Date}[]>}} table
 * @param {number} [now]
 * @returns {Promise<Date>}
 */
async function retentionCutoff(table, now = Date.now()) {
  const byAge = now - LANCE_VERSION_RETENTION_MS;
  try {
    const versions = (await table.listVersions()) || [];
    let protect = null;
    for (const v of versions) {
      const ts = new Date(v.timestamp).getTime();
      if (Number.isFinite(ts) && ts < now - READER_GRACE_MS && (protect === null || ts > protect))
        protect = ts;
    }
    return new Date(protect === null ? byAge : Math.min(byAge, protect));
  } catch {
    return new Date(byAge);
  }
}

/**
 * optimize() mit 1-Tag-Aufbewahrung (Compaction + Index + Aufräumen).
 * @param {import('@lancedb/lancedb').Table} table
 */
async function optimizeWithRetention(table) {
  return table.optimize({ cleanupOlderThan: await retentionCutoff(table) });
}

module.exports = {
  LANCE_VERSION_RETENTION_MS,
  READER_GRACE_MS,
  retentionCutoff,
  optimizeWithRetention,
};
