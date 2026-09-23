/**
 * KIE-480: Filter-Erkennung für die Suche — parallel zu Query-Rewrite und Einbettung.
 *
 * startMetadataFilterResolution() wird in den Chat-Handlern VOR dem Query-Rewrite gestartet
 * (mit der Roh-Nachricht) und das Promise an performSimilaritySearch übergeben, das es
 * zusammen mit der Query-Einbettung abwartet. Netto kostet der LLM-Aufruf (~300 ms) damit
 * nur die Differenz zur ohnehin laufenden Rewrite-/Einbettungszeit.
 *
 * Eingabe: die Roh-Nachricht PLUS die letzten Nutzer-Nachrichten (chatHistory). Der
 * Normalisierer entscheidet selbst, welche früheren Bedingungen weiter gelten, ersetzt oder
 * aufgehoben werden (Übernahme-Regeln nur im Prompt, wenn es einen Verlauf gibt). Gemessen an
 * unabhängigen Folgefragen-Sätzen: nur Roh-Nachricht 34/69 · 42/91, Roh + Verlauf 68/69 · 81/91.
 *
 * Nur LLM (kein Regel-Extraktor): Timeout/Fehler → kein Filter, die Suche läuft wie ohne KIE-480.
 * Das Promise wird NIE verworfen; Setting aus → null.
 */
const { SystemSettings } = require("../../models/systemSettings");
const { always, completeWith } = require("./metadataFilterNormalizer");

const DEFAULT_TIMEOUT_MS = 1500;
const HISTORY_USER_TURNS = 3;

/**
 * Ortsliste-Einträge, die als Ortsname taugen: mind. 3 Zeichen, mind. ein Buchstabe, nicht
 * "online" — Feed-Werte wie "0" (vhs-magdeburg) oder Sprachkürzel ("en", "ja") fallen raus.
 * @param {string} loc
 * @returns {boolean}
 */
function isPlausiblePlace(loc) {
  const l = String(loc || "").trim().toLowerCase();
  return l.length >= 3 && /[a-zäöüß]/.test(l) && l !== "online";
}

/**
 * Liest die Filter-Settings des Containers.
 * @returns {Promise<{knownLocations:string[]}|null>} null = metadata_filters aus
 */
async function readFilterSettings() {
  const enabled = await SystemSettings.getValueOrFallback(
    { label: "metadata_filters" },
    "off"
  );
  if (enabled !== "on") return null;
  const locationSetting = await SystemSettings.getValueOrFallback(
    { label: "metadata_filter_locations" },
    ""
  );
  const knownLocations = String(locationSetting || "")
    .split(",")
    .map((loc) => loc.trim().toLowerCase())
    .filter(isPlausiblePlace);
  return { knownLocations };
}

/**
 * Heutiges Datum in Europe/Berlin als ISO-Tag (Container laufen in UTC; sonst wäre
 * zwischen 0 und 2 Uhr "morgen" Berlin-heute).
 * @param {Date} [now]
 * @returns {string} YYYY-MM-DD
 */
function berlinToday(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/**
 * Letzte Nutzer-Nachrichten aus dem Prompt-Verlauf (Assistenz-Antworten bleiben draußen).
 * @param {{role:string,content:string}[]} chatHistory
 * @returns {string[]}
 */
function recentUserMessages(chatHistory = []) {
  if (!Array.isArray(chatHistory)) return [];
  return chatHistory
    .filter((m) => m?.role === "user" && typeof m.content === "string" && m.content.trim())
    .slice(-HISTORY_USER_TURNS)
    .map((m) => m.content.trim().slice(0, 500));
}

/**
 * Ortsfilter nur aus der Kundenliste (Vertrag von metadata_filter_locations): das LLM darf
 * keinen Ort erfinden; ohne Liste gibt es keinen Ortsfilter.
 * @param {object} filters
 * @param {string[]} knownLocations
 * @returns {object}
 */
function restrictLocations(filters, knownLocations) {
  if (!filters?.location) return filters;
  const allowed = new Set(knownLocations);
  const location = filters.location.filter((l) => allowed.has(l));
  const { location: _drop, ...rest } = filters;
  return location.length ? { ...rest, location } : rest;
}

function logLine(stage, ms, query, filters, error) {
  // Steuerzeichen raus (Log-Injection), nur ein kurzer Anfang der Nachricht (Datensparsamkeit)
  const q = String(query)
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .slice(0, 60);
  const line = `\x1b[36m[MetadataFilter]\x1b[0m stage=${stage} ${ms}ms "${q}" → ${JSON.stringify(filters || {})}`;
  if (error)
    console.error(`${line} (${String(error).replace(/[\u0000-\u001f]/g, " ").slice(0, 120)})`);
  else console.log(line);
}

/**
 * @param {{userQuery:string, chatHistory?:{role:string,content:string}[], LLMConnector?:object, referenceDate?:string|Date, timeoutMs?:number}} params
 * @returns {Promise<{filters:object, stage:string, ms:number, error?:string}|null>}
 *          null = Filter aus (Setting), kein LLM-Provider oder leere Frage.
 */
async function resolveMetadataFilters({
  userQuery,
  chatHistory = [],
  LLMConnector = null,
  referenceDate = null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  const t0 = Date.now();
  try {
    if (!userQuery || !String(userQuery).trim()) return null;
    if (typeof LLMConnector?.getChatCompletion !== "function") return null;
    const settings = await readFilterSettings();
    if (!settings) return null;
    const out = await always(userQuery, {
      referenceDate: referenceDate || berlinToday(),
      knownLocations: settings.knownLocations,
      previousMessages: recentUserMessages(chatHistory),
      complete: completeWith(LLMConnector),
      timeoutMs,
    });
    out.filters = restrictLocations(out.filters, settings.knownLocations);
    out.ms = Date.now() - t0;
    logLine(out.stage, out.ms, userQuery, out.filters, out.error);
    return out;
  } catch (e) {
    // Settings-Fehler dürfen die Suche nie verhindern.
    logLine("error", Date.now() - t0, userQuery, {}, e.message);
    return { filters: {}, stage: "error", ms: Date.now() - t0, error: e.message };
  }
}

module.exports = {
  // Start im Chat-Handler vor dem Rewrite; der Alias hält die Aufrufstellen sprechend.
  startMetadataFilterResolution: resolveMetadataFilters,
  resolveMetadataFilters,
  readFilterSettings,
  recentUserMessages,
  restrictLocations,
  isPlausiblePlace,
  berlinToday,
  DEFAULT_TIMEOUT_MS,
};
