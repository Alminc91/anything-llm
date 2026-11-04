/**
 * Kufer-Fork: Thinking-Schalter für den generischen OpenAI-Provider per
 * Umgebungsvariable `GENERIC_OPEN_AI_ENABLE_THINKING`
 * (Spezifikation issues/thinking-schalter-generic-openai.md).
 *
 * Erlaubt sind genau `true` und `false` (Groß-/Kleinschreibung und Leerzeichen
 * am Rand egal). Ist die Variable gültig gesetzt, schickt der Provider bei
 * jeder Anfrage ohne eigene Thinking-Wahl `chat_template_kwargs.enable_thinking`
 * mit diesem Wert, auch für Widget, Filter, Suchschritte, Teaser und
 * Folgefragen. Bewusst kein JSON: `dumpENV()` schneidet Werte am ersten
 * Anführungszeichen ab.
 *
 * Der Aufrufer (Entwickler-API) hat Vorrang: Schickt er `reasoning_effort` oder
 * ein eigenes `chat_template_kwargs.enable_thinking` mit, ergänzt die Variable
 * nichts und seine `chat_template_kwargs` gehen unverändert in den Body
 * (Fixliste 8.1-rc2, D7).
 *
 * Ohne Variable, leer oder ungültig bleibt der Body wie bisher. Ein ungültiger
 * Wert wird höchstens einmal je Prozess gewarnt; der Wert selbst steht nicht
 * im Log.
 *
 * Bewusst ohne Abhängigkeiten, damit auch `llmRequestOptions.js` (Trennung des
 * Reasoning am OpenAI-Endpunkt) dieselbe Regel nutzen kann.
 */

const ENABLE_THINKING_ENV = "GENERIC_OPEN_AI_ENABLE_THINKING";

let warnedInvalidValue = false;

/**
 * Liest und prüft `GENERIC_OPEN_AI_ENABLE_THINKING` (je Anfrage).
 * @returns {boolean|undefined} `true`/`false`; `undefined` = nicht gesetzt,
 *   leer oder ungültig (kein Schalter)
 */
function envEnableThinking() {
  const value = (process.env[ENABLE_THINKING_ENV] ?? "").trim().toLowerCase();
  if (value === "") return undefined;
  if (value === "true") return true;
  if (value === "false") return false;

  if (!warnedInvalidValue) {
    warnedInvalidValue = true;
    console.warn(
      `[GenericOpenAiLLM] ${ENABLE_THINKING_ENV} has an invalid value and is ignored. Allowed values: true or false. Until then the variable adds no chat_template_kwargs.`
    );
  }
  return undefined;
}

/**
 * `chat_template_kwargs` für den Provider-Body: die des Aufrufers, bei gültiger
 * Variable um `enable_thinking` ergänzt. Hat der Aufrufer selbst gewählt
 * (`reasoning_effort` oder `chat_template_kwargs.enable_thinking` gesetzt),
 * bleiben seine kwargs unverändert. Das Objekt des Aufrufers wird nie verändert.
 * @param {{reasoning_effort?: string, chat_template_kwargs?: Object}|null} [requestOptions]
 *   Anfrage-Optionen, wie sie im Provider-Body landen (`parseLLMRequestOptions`)
 * @returns {Object|undefined} `chat_template_kwargs` für den Body; ohne
 *   Ergänzung genau der Wert des Aufrufers (auch `undefined`)
 */
function withEnableThinkingDefault(requestOptions) {
  const { reasoning_effort, chat_template_kwargs } = requestOptions ?? {};
  const enableThinking = envEnableThinking();
  if (
    enableThinking === undefined ||
    reasoning_effort !== undefined ||
    chat_template_kwargs?.enable_thinking !== undefined
  )
    return chat_template_kwargs;
  return { ...chat_template_kwargs, enable_thinking: enableThinking };
}

module.exports = { withEnableThinkingDefault };
