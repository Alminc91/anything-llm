/**
 * KIE-480: Laufzähler des Kursdaten-Filters für die Statusanzeige (nur im Prozessspeicher,
 * nach Neustart leer). Keine Nachrichtentexte — nur Zeitpunkt, Dauer und Ausgang.
 */

const WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_EVENTS = 20000;
const events = []; // {t, ms, outcome: "ok"|"timeout"|"error"}
const startedAt = Date.now();

/**
 * @param {string} stage - "llm" | "llm-error" | "error"
 * @param {number} ms
 * @param {string|null} [error]
 */
function recordFilterRun(stage, ms, error = null) {
  const outcome =
    stage === "llm" ? "ok" : /timeout/i.test(String(error || "")) ? "timeout" : "error";
  events.push({ t: Date.now(), ms: Number(ms) || 0, outcome });
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

/**
 * @param {number} [now]
 * @returns {{count:number, medianMs:number|null, p90Ms:number|null, timeouts:number, errors:number, sinceMs:number}}
 */
function filterRunSummary(now = Date.now()) {
  const recent = events.filter((e) => now - e.t <= WINDOW_MS);
  const sorted = recent.map((e) => e.ms).sort((a, b) => a - b);
  return {
    count: recent.length,
    medianMs: percentile(sorted, 0.5),
    p90Ms: percentile(sorted, 0.9),
    timeouts: recent.filter((e) => e.outcome === "timeout").length,
    errors: recent.filter((e) => e.outcome === "error").length,
    // Zählfenster beginnt frühestens beim Prozessstart
    sinceMs: Math.min(WINDOW_MS, now - startedAt),
  };
}

function _resetForTests() {
  events.length = 0;
}

module.exports = { recordFilterRun, filterRunSummary, _resetForTests };
