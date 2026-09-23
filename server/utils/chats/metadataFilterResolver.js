/**
 * KIE-480: Filter-Erkennung für die Suche — parallel zu Query-Rewrite und Einbettung.
 *
 * startMetadataFilterResolution() wird in den Chat-Handlern VOR dem Query-Rewrite gestartet
 * (mit der Roh-Nachricht) und das Promise an performSimilaritySearch übergeben, das es
 * zusammen mit der Query-Einbettung abwartet. Netto kostet der LLM-Aufruf (~300 ms) damit
 * nur die Differenz zur ohnehin laufenden Rewrite-/Einbettungszeit.
 *
 * Bewusst die Roh-Nachricht, nicht der umgeschriebene Text: ein Filter aus einer früheren
 * Frage wird NICHT stillschweigend übernommen („…und für Anfänger?“ filtert nicht erneut auf
 * „abends“). Ein fehlender Filter fällt auf die ungefilterte Suche zurück (heutiges Verhalten),
 * ein falsch übernommener würde passende Kurse hart ausblenden.
 *
 * Das Promise wird NIE verworfen: Fehler/Timeout → Regel-Extraktor; Setting aus → null.
 */
const { SystemSettings } = require("../../models/systemSettings");
const { extractFilters } = require("./metadataFilterExtractor");
const { always, completeWith } = require("./metadataFilterNormalizer");

const DEFAULT_TIMEOUT_MS = 1500;

async function readFilterSettings() {
  const enabled = await SystemSettings.getValueOrFallback(
    { label: "metadata_filters" },
    "off"
  );
  if (enabled !== "on") return null;
  const [locationSetting, mode] = await Promise.all([
    SystemSettings.getValueOrFallback({ label: "metadata_filter_locations" }, ""),
    SystemSettings.getValueOrFallback({ label: "metadata_filter_mode" }, "llm"),
  ]);
  const knownLocations = String(locationSetting || "")
    .split(",")
    .map((loc) => loc.trim())
    .filter(Boolean);
  return { knownLocations, mode: mode === "rules" ? "rules" : "llm" };
}

function logLine(stage, ms, query, filters, error) {
  const q = String(query).slice(0, 80).replace(/\s+/g, " ");
  console.log(
    `\x1b[36m[MetadataFilter]\x1b[0m stage=${stage} ${ms}ms "${q}" → ${JSON.stringify(filters || {})}${error ? ` (${error})` : ""}`
  );
}

/**
 * @param {{userQuery:string, LLMConnector?:object, referenceDate?:Date, timeoutMs?:number}} params
 * @returns {Promise<{filters:object, stage:string, ms:number, error?:string}|null>}
 *          null = Filter aus (Setting) oder keine Frage.
 */
async function resolveMetadataFilters({
  userQuery,
  LLMConnector = null,
  referenceDate = new Date(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  const t0 = Date.now();
  try {
    if (!userQuery || !String(userQuery).trim()) return null;
    const settings = await readFilterSettings();
    if (!settings) return null;
    const opts = { referenceDate, knownLocations: settings.knownLocations };
    let out;
    if (settings.mode === "rules" || typeof LLMConnector?.getChatCompletion !== "function") {
      out = { filters: extractFilters(userQuery, opts), stage: "rules" };
    } else {
      out = await always(userQuery, {
        ...opts,
        complete: completeWith(LLMConnector),
        timeoutMs,
      });
    }
    out.ms = Date.now() - t0;
    logLine(out.stage, out.ms, userQuery, out.filters, out.error);
    return out;
  } catch (e) {
    // Settings-/Regelfehler dürfen die Suche nie verhindern.
    logLine("error", Date.now() - t0, userQuery, {}, e.message);
    return { filters: {}, stage: "error", ms: Date.now() - t0, error: e.message };
  }
}

/** Startet die Erkennung sofort und gibt das (nie verworfene) Promise zurück. */
function startMetadataFilterResolution(params) {
  return resolveMetadataFilters(params);
}

module.exports = {
  resolveMetadataFilters,
  startMetadataFilterResolution,
  readFilterSettings,
  DEFAULT_TIMEOUT_MS,
};
