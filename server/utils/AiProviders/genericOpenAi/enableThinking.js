/**
 * Kufer-Fork: Thinking-Schalter für den generischen OpenAI-Provider per
 * Umgebungsvariable `GENERIC_OPEN_AI_ENABLE_THINKING`
 * (Spezifikation issues/thinking-schalter-generic-openai.md).
 *
 * Erlaubt sind genau `true` und `false` (Groß-/Kleinschreibung und Leerzeichen
 * am Rand egal). Ist die Variable gültig gesetzt, schickt der Provider bei
 * jeder Anfrage `chat_template_kwargs.enable_thinking` mit diesem Wert, auch
 * für Widget, Filter, Suchschritte, Teaser und Folgefragen. Bewusst kein JSON:
 * `dumpENV()` schneidet Werte am ersten Anführungszeichen ab.
 *
 * Ohne Variable, leer oder ungültig bleibt der Body wie bisher (kein
 * `chat_template_kwargs`). Ein ungültiger Wert wird höchstens einmal je
 * Prozess gewarnt; der Wert selbst steht nicht im Log.
 *
 * Bewusst ohne Abhängigkeiten, damit auch `llmRequestOptions.js` den Wert
 * über dieselbe Funktion auswerten kann.
 */

const ENABLE_THINKING_ENV = "GENERIC_OPEN_AI_ENABLE_THINKING";

let warnedInvalidValue = false;

/**
 * Liest und prüft `GENERIC_OPEN_AI_ENABLE_THINKING`. Einzige Stelle, an der
 * der Wert ausgewertet wird.
 * @param {string|undefined} [envValue] - Standard: aktueller Wert der Variablen
 * @returns {boolean|undefined} `true`/`false`; `undefined` = nicht gesetzt,
 *   leer oder ungültig (kein Schalter)
 */
function envEnableThinking(envValue = process.env[ENABLE_THINKING_ENV]) {
  if (envValue === undefined || envValue === null) return undefined;
  const normalized = String(envValue).trim().toLowerCase();
  if (normalized === "") return undefined;
  if (normalized === "true") return true;
  if (normalized === "false") return false;

  if (!warnedInvalidValue) {
    warnedInvalidValue = true;
    console.warn(
      `[GenericOpenAiLLM] ${ENABLE_THINKING_ENV} has an invalid value and is ignored. Allowed values: true or false. Requests are sent without chat_template_kwargs.`
    );
  }
  return undefined;
}

/**
 * Führt den Standard aus `GENERIC_OPEN_AI_ENABLE_THINKING` mit den
 * `chat_template_kwargs` des Aufrufers (Entwickler-API) zusammen. Ein
 * `enable_thinking` des Aufrufers hat Vorrang; das Objekt des Aufrufers wird
 * nicht verändert.
 * @param {Object|undefined} callerKwargs - `chat_template_kwargs` der Anfrage
 * @returns {Object|undefined} `chat_template_kwargs` für den Body; ohne
 *   gültige Variable genau der Wert des Aufrufers (auch `undefined`)
 */
function withEnableThinkingDefault(callerKwargs) {
  const enableThinking = envEnableThinking();
  if (enableThinking === undefined) return callerKwargs;
  if (
    callerKwargs &&
    Object.prototype.hasOwnProperty.call(callerKwargs, "enable_thinking") &&
    callerKwargs.enable_thinking !== undefined
  )
    return callerKwargs;
  return { ...(callerKwargs ?? {}), enable_thinking: enableThinking };
}

module.exports = {
  ENABLE_THINKING_ENV,
  envEnableThinking,
  withEnableThinkingDefault,
};
