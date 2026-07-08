/**
 * KIE-471/480 — Search-Trace: vollständige Hybrid-/Reranker-Metriken pro
 * Suche als JSONL (ein JSON-Objekt pro Zeile) unter
 *   ${STORAGE_DIR}/search-traces/traces-YYYY-MM-DD.jsonl
 *
 * Erfasst pro Suche: Modus, beide Retrieval-Arme (Latenz, Trefferzahl,
 * Top-Dokumente mit Scores), RRF-Fusion (α, Kandidaten, Arm-Herkunft),
 * Reranker (Provider/Modell, Latenz, Degradation, Score je Dokument) und
 * die Rang-Verschiebung jedes finalen Dokuments (RRF-Rang → Final-Rang).
 *
 * Datenschutz (bewusste Entscheidung, 2026-07-08): Dokumente erscheinen nur
 * als id + title (Kurs-Slugs) + Scores — KEINE Chunk-Volltexte. Der
 * Query-Text wird nur bei Stufe "full" mitgeschrieben; bei "on" nur
 * Hash + Länge. Steuerung über SystemSetting `search_trace` (off|on|full),
 * Default off.
 *
 * Fehler-Kontrakt: Tracing ist reine Diagnostik — jede Funktion hier ist
 * non-throwing und darf die Suche niemals verlangsamen (Write ist
 * fire-and-forget) oder brechen.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { SystemSettings } = require("../../../models/systemSettings");

const CAPTURE_TOP_N = 20; // Deckel je Liste, hält die Zeilen kompakt

/** @returns {Promise<"off"|"on"|"full">} */
async function resolveTraceLevel() {
  try {
    const value = await SystemSettings.getValueOrFallback(
      { label: "search_trace" },
      "off"
    );
    return ["on", "full"].includes(value) ? value : "off";
  } catch {
    return "off";
  }
}

const round = (n, digits = 6) =>
  typeof n === "number" && Number.isFinite(n)
    ? Number(n.toFixed(digits))
    : null;

/** Kompakte Dokument-Referenz: nur id + title (keine Volltexte). */
function docRef(row) {
  return {
    id: row?.id ?? null,
    title: row?.title ?? null,
  };
}

/** Top-Ausschnitt einer Arm-Ergebnisliste mit Score-Extraktor. */
function captureRows(rows = [], scoreKey, scoreFn, cap = CAPTURE_TOP_N) {
  return rows.slice(0, cap).map((row, i) => ({
    rank: i + 1,
    ...docRef(row),
    [scoreKey]: round(scoreFn(row)),
  }));
}

/**
 * Startet einen Trace für eine Suche.
 * @param {Object} params
 * @param {string} params.namespace
 * @param {string} params.mode - default|rerank|hybrid|hybrid_rerank
 * @param {string} params.query
 * @param {"on"|"full"} params.level
 * @returns {object} Mutierbares Trace-Objekt (von den Suchpfaden befüllt).
 */
function beginTrace({ namespace, mode, query, level }) {
  return {
    ts: new Date().toISOString(),
    namespace,
    mode,
    queryChars: typeof query === "string" ? query.length : 0,
    queryHash: crypto
      .createHash("sha1")
      .update(String(query || ""))
      .digest("hex")
      .slice(0, 12),
    ...(level === "full" ? { query: String(query || "") } : {}),
    relaxStage: 0,
    whereClause: null,
    totalMs: null,
  };
}

/**
 * Schreibt den Trace als JSONL-Zeile — fire-and-forget, non-throwing.
 * @param {object} trace
 */
function writeTrace(trace) {
  try {
    const base = process.env.STORAGE_DIR
      ? path.resolve(process.env.STORAGE_DIR)
      : path.resolve(__dirname, "../../../storage");
    const dir = path.resolve(base, "search-traces");
    const file = path.resolve(
      dir,
      `traces-${trace.ts.slice(0, 10)}.jsonl`
    );
    fs.promises
      .mkdir(dir, { recursive: true })
      .then(() => fs.promises.appendFile(file, JSON.stringify(trace) + "\n"))
      .catch(() => {});
  } catch {
    /* Diagnostik darf nie stören */
  }
}

module.exports = {
  resolveTraceLevel,
  beginTrace,
  writeTrace,
  captureRows,
  docRef,
  round,
  CAPTURE_TOP_N,
};
