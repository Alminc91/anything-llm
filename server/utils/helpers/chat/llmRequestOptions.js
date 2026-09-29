/**
 * Optionale LLM-Optionen pro API-Anfrage (Kufer-Fork).
 *
 * Aufrufer der Entwickler-API können pro Anfrage einige wenige, streng
 * validierte Generierungsoptionen mitschicken (z. B. Thinking bei Gemma-4 per
 * `chat_template_kwargs` einschalten oder die Ausgabelänge setzen). Die
 * Optionen werden hier validiert und in camelCase normalisiert; nur der
 * generische OpenAI-Provider wertet sie aus, alle anderen Provider ignorieren
 * die zusätzlichen Felder.
 *
 * Grundsätze:
 * - Whitelist: nur die unten aufgeführten Felder werden gelesen, alle anderen
 *   Felder im Input werden ignoriert (wie bisher im Request-Body).
 * - `undefined` und `null` gelten als "nicht gesetzt" (OpenAI-Clients schicken
 *   teils explizit `null`).
 * - Ungültige Werte werden NICHT stillschweigend korrigiert oder verworfen,
 *   sondern führen zu `{ ok: false, error }`, damit der Endpunkt mit HTTP 400
 *   antworten kann. Es gibt keine Typumwandlung (z. B. "4096" -> 4096).
 */

const REASONING_EFFORT_VALUES = ["none", "minimal", "low", "medium", "high"];
const MAX_TOKENS_LIMIT = 1_000_000;
const CHAT_TEMPLATE_KWARGS_MAX_KEYS = 10;
const CHAT_TEMPLATE_KWARGS_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const CHAT_TEMPLATE_KWARGS_MAX_STRING_LENGTH = 256;
// Schlüssel, die beim Kopieren in ein normales Objekt dessen Prototyp
// verändern könnten – werden grundsätzlich abgelehnt.
const FORBIDDEN_KWARGS_KEYS = ["__proto__", "constructor", "prototype"];
const TEMPERATURE_MIN = 0;
const TEMPERATURE_MAX = 2;

/**
 * @typedef {Object} LLMRequestOptions
 * @property {number} [maxTokens] - Ganzzahl 1…1.000.000 -> `max_tokens`
 * @property {number} [topP] - 0 < x ≤ 1 -> `top_p`
 * @property {"none"|"minimal"|"low"|"medium"|"high"} [reasoningEffort] -> `reasoning_effort`
 * @property {Object<string, boolean|number|string>} [chatTemplateKwargs] -> `chat_template_kwargs`
 * @property {number} [temperature] - 0…2, nur wenn `allowTemperature` gesetzt ist
 */

function isPlainObject(value) {
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isSet(value) {
  return value !== undefined && value !== null;
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function validateChatTemplateKwargs(value, fieldName) {
  if (!isPlainObject(value))
    return {
      error: `${fieldName} must be a flat JSON object with boolean, number or string values.`,
    };

  const keys = Object.keys(value);
  if (keys.length > CHAT_TEMPLATE_KWARGS_MAX_KEYS)
    return {
      error: `${fieldName} may contain at most ${CHAT_TEMPLATE_KWARGS_MAX_KEYS} keys (got ${keys.length}).`,
    };

  const result = {};
  for (const key of keys) {
    if (
      !CHAT_TEMPLATE_KWARGS_KEY_PATTERN.test(key) ||
      FORBIDDEN_KWARGS_KEYS.includes(key)
    )
      return {
        error: `${fieldName} contains an invalid key "${String(key).slice(0, 80)}". Keys must match ${CHAT_TEMPLATE_KWARGS_KEY_PATTERN} and must not be one of: ${FORBIDDEN_KWARGS_KEYS.join(", ")}.`,
      };

    const entry = value[key];
    if (typeof entry === "boolean") {
      result[key] = entry;
      continue;
    }
    if (isFiniteNumber(entry)) {
      result[key] = entry;
      continue;
    }
    if (typeof entry === "string") {
      if (entry.length > CHAT_TEMPLATE_KWARGS_MAX_STRING_LENGTH)
        return {
          error: `${fieldName}.${key} must be at most ${CHAT_TEMPLATE_KWARGS_MAX_STRING_LENGTH} characters long.`,
        };
      result[key] = entry;
      continue;
    }
    return {
      error: `${fieldName}.${key} must be a boolean, a finite number or a string (nested objects, arrays and null are not allowed).`,
    };
  }
  return { value: result };
}

/**
 * Validiert und normalisiert optionale LLM-Optionen einer API-Anfrage.
 * Reine Funktion ohne Seiteneffekte; der Input wird nicht verändert.
 *
 * @param {Object|undefined|null} input - Objekt mit snake_case-Feldern
 *   (`max_tokens`, `top_p`, `reasoning_effort`, `chat_template_kwargs`,
 *   optional `temperature`). Unbekannte Felder werden ignoriert.
 * @param {Object} [config]
 * @param {boolean} [config.allowTemperature=false] - `temperature` mit auswerten (0…2).
 *   Ist es `false`, wird ein `temperature`-Feld wie ein unbekanntes Feld ignoriert.
 * @param {string} [config.fieldPrefix=""] - Präfix für Fehlermeldungen, z. B. "llmOptions."
 * @returns {{ok: true, options: LLMRequestOptions} | {ok: false, error: string}}
 */
function parseLLMRequestOptions(
  input,
  { allowTemperature = false, fieldPrefix = "" } = {}
) {
  if (!isSet(input)) return { ok: true, options: {} };

  const container = fieldPrefix ? fieldPrefix.replace(/\.$/, "") : "options";
  if (!isPlainObject(input))
    return { ok: false, error: `${container} must be a JSON object.` };

  const name = (field) => `${fieldPrefix}${field}`;
  const options = {};

  if (isSet(input.max_tokens)) {
    const value = input.max_tokens;
    if (!Number.isInteger(value) || value < 1 || value > MAX_TOKENS_LIMIT)
      return {
        ok: false,
        error: `${name("max_tokens")} must be an integer between 1 and ${MAX_TOKENS_LIMIT}.`,
      };
    options.maxTokens = value;
  }

  if (isSet(input.top_p)) {
    const value = input.top_p;
    if (!isFiniteNumber(value) || value <= 0 || value > 1)
      return {
        ok: false,
        error: `${name("top_p")} must be a number greater than 0 and at most 1.`,
      };
    options.topP = value;
  }

  if (isSet(input.reasoning_effort)) {
    const value = input.reasoning_effort;
    if (typeof value !== "string" || !REASONING_EFFORT_VALUES.includes(value))
      return {
        ok: false,
        error: `${name("reasoning_effort")} must be one of: ${REASONING_EFFORT_VALUES.join(", ")}.`,
      };
    options.reasoningEffort = value;
  }

  if (isSet(input.chat_template_kwargs)) {
    const { value, error } = validateChatTemplateKwargs(
      input.chat_template_kwargs,
      name("chat_template_kwargs")
    );
    if (error) return { ok: false, error };
    options.chatTemplateKwargs = value;
  }

  if (allowTemperature && isSet(input.temperature)) {
    const value = input.temperature;
    if (
      !isFiniteNumber(value) ||
      value < TEMPERATURE_MIN ||
      value > TEMPERATURE_MAX
    )
      return {
        ok: false,
        error: `${name("temperature")} must be a number between ${TEMPERATURE_MIN} and ${TEMPERATURE_MAX}.`,
      };
    options.temperature = value;
  }

  return { ok: true, options };
}

/**
 * Ergänzt die Optionen für `LLMConnector.getChatCompletion` bzw.
 * `streamGetChatCompletion` um die gesetzten Anfrage-Optionen (ohne
 * `temperature` – die löst der Aufrufer selbst nach seiner Priorität auf).
 * Nicht gesetzte Optionen erscheinen NICHT als Schlüssel, damit das Ergebnis
 * ohne Anfrage-Optionen identisch zum bisherigen Options-Objekt ist.
 *
 * @param {Object} connectorOptions - z. B. `{ temperature, user }`
 * @param {LLMRequestOptions} [llmRequestOptions]
 * @returns {Object} neues Objekt
 */
function withLLMRequestOptions(connectorOptions = {}, llmRequestOptions = {}) {
  const result = { ...connectorOptions };
  const { maxTokens, topP, reasoningEffort, chatTemplateKwargs } =
    llmRequestOptions || {};
  if (maxTokens !== undefined) result.maxTokens = maxTokens;
  if (topP !== undefined) result.topP = topP;
  if (reasoningEffort !== undefined) result.reasoningEffort = reasoningEffort;
  if (chatTemplateKwargs !== undefined)
    result.chatTemplateKwargs = chatTemplateKwargs;
  return result;
}

/**
 * Soll am OpenAI-kompatiblen Endpunkt das Reasoning (`<think>…</think>`) in
 * ein eigenes Feld `reasoning_content` ausgelagert werden?
 * Nur wenn der Aufrufer Reasoning-bezogene Optionen explizit mitgeschickt hat –
 * ohne diese Optionen bleibt die Antwort exakt wie bisher.
 * @param {LLMRequestOptions} [llmRequestOptions]
 * @returns {boolean}
 */
function shouldSeparateReasoning(llmRequestOptions = {}) {
  return (
    llmRequestOptions?.reasoningEffort !== undefined ||
    llmRequestOptions?.chatTemplateKwargs !== undefined
  );
}

const THINK_OPEN = "<think>";
const THINK_CLOSE = "</think>";

function partialSuffixLength(text, tag) {
  const max = Math.min(text.length, tag.length - 1);
  for (let len = max; len > 0; len--) {
    if (tag.startsWith(text.slice(text.length - len))) return len;
  }
  return 0;
}

/**
 * Trennt einen FÜHRENDEN `<think>…</think>`-Block vom restlichen Text –
 * auch wenn der Text in beliebigen Stücken (Stream-Chunks) ankommt und die
 * Tags über Chunk-Grenzen verteilt sind.
 * Nur ein Block ganz am Anfang (optional nach Leerraum) wird als Reasoning
 * behandelt; alles danach ist regulärer Inhalt, auch spätere "<think>"-Texte.
 */
class ThinkBlockSplitter {
  constructor() {
    this.state = "start"; // "start" | "think" | "content"
    this.buffer = "";
  }

  /**
   * @param {string} text
   * @returns {{reasoning: string, content: string}}
   */
  push(text = "") {
    const out = { reasoning: "", content: "" };
    this.buffer += typeof text === "string" ? text : "";

    while (true) {
      if (this.state === "start") {
        const trimmed = this.buffer.trimStart();
        if (trimmed.startsWith(THINK_OPEN)) {
          this.state = "think";
          this.buffer = trimmed.slice(THINK_OPEN.length);
          continue;
        }
        // Noch unentschieden (nur Leerraum oder angefangenes "<think>"): warten.
        if (trimmed.length === 0 || THINK_OPEN.startsWith(trimmed)) return out;
        this.state = "content";
        continue;
      }

      if (this.state === "think") {
        const closeAt = this.buffer.indexOf(THINK_CLOSE);
        if (closeAt >= 0) {
          out.reasoning += this.buffer.slice(0, closeAt);
          this.buffer = this.buffer.slice(closeAt + THINK_CLOSE.length);
          this.state = "content";
          continue;
        }
        const keep = partialSuffixLength(this.buffer, THINK_CLOSE);
        out.reasoning += this.buffer.slice(0, this.buffer.length - keep);
        this.buffer = this.buffer.slice(this.buffer.length - keep);
        return out;
      }

      // state === "content"
      out.content += this.buffer;
      this.buffer = "";
      return out;
    }
  }

  /**
   * Gibt noch gepufferten Text aus (Ende des Streams).
   * @returns {{reasoning: string, content: string}}
   */
  flush() {
    const out = { reasoning: "", content: "" };
    if (this.state === "think") out.reasoning = this.buffer;
    else out.content = this.buffer;
    this.buffer = "";
    return out;
  }
}

/**
 * Trennt einen vollständigen Text in Reasoning und Inhalt.
 * @param {string|null} text
 * @returns {{reasoning: string, content: string|null}}
 */
function splitThinkBlock(text) {
  if (typeof text !== "string") return { reasoning: "", content: text };
  const splitter = new ThinkBlockSplitter();
  const first = splitter.push(text);
  const rest = splitter.flush();
  return {
    reasoning: first.reasoning + rest.reasoning,
    content: first.content + rest.content,
  };
}

module.exports = {
  parseLLMRequestOptions,
  withLLMRequestOptions,
  shouldSeparateReasoning,
  splitThinkBlock,
  ThinkBlockSplitter,
  REASONING_EFFORT_VALUES,
};
