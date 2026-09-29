/**
 * Optionale LLM-Optionen pro API-Anfrage (Kufer-Fork).
 *
 * Aufrufer der Entwickler-API können pro Anfrage einige wenige, streng
 * validierte Generierungsoptionen mitschicken (z. B. Thinking bei Gemma-4 per
 * `chat_template_kwargs` einschalten oder die Ausgabelänge setzen). Die
 * Optionen werden hier validiert und direkt in der Form zurückgegeben, in der
 * sie im Provider-Body landen (snake_case). Nur der generische
 * OpenAI-Provider wertet sie aus; alle anderen Provider destrukturieren aus
 * dem Options-Objekt nur `temperature` (und `user`) und ignorieren den Rest.
 *
 * Grundsätze:
 * - Whitelist: nur die unten aufgeführten Felder werden gelesen, alle anderen
 *   Felder im Input werden ignoriert (wie bisher im Request-Body).
 * - `undefined` und `null` gelten als "nicht gesetzt" (OpenAI-Clients schicken
 *   teils explizit `null`).
 * - Ungültige Werte werden NICHT stillschweigend verworfen, sondern führen zu
 *   `{ ok: false, error }`, damit der Endpunkt mit HTTP 400 antworten kann.
 * - Standardmäßig keine Typumwandlung. Nur mit `coerce: true` (OpenAI-
 *   kompatibler Endpunkt, Rücksicht auf Altclients) werden Zahlen als String
 *   ("4096", "0.5") umgewandelt und `max_tokens: 0` als "nicht gesetzt"
 *   behandelt.
 * - `chat_template_kwargs` nur mit Schlüsseln aus einer Whitelist: vLLM
 *   übernimmt die kwargs NACH seinen eigenen Template-Argumenten
 *   (`chat_template`, `add_generation_prompt`, `tools`, `documents`, …) –
 *   freie Schlüssel könnten diese überschreiben oder per Namenskollision einen
 *   Serverfehler auslösen.
 */

const REASONING_EFFORT_VALUES = ["none", "minimal", "low", "medium", "high"];
// Absolute Obergrenze, falls der Aufrufer keine (kleinere) Grenze übergibt.
const MAX_TOKENS_LIMIT = 1_000_000;
const MAX_TOKENS_CEILING_ENV = "LLM_REQUEST_MAX_TOKENS_CEILING";
const CHAT_TEMPLATE_KWARGS_MAX_KEYS = 10;
const CHAT_TEMPLATE_KWARGS_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const CHAT_TEMPLATE_KWARGS_MAX_STRING_LENGTH = 256;
const DEFAULT_CHAT_TEMPLATE_KWARGS_ALLOWLIST = ["enable_thinking"];
const CHAT_TEMPLATE_KWARGS_ALLOWLIST_ENV = "LLM_CHAT_TEMPLATE_KWARGS_ALLOWLIST";
// Schlüssel, die beim Kopieren in ein normales Objekt dessen Prototyp
// verändern könnten – werden grundsätzlich abgelehnt.
const FORBIDDEN_KWARGS_KEYS = ["__proto__", "constructor", "prototype"];
const TEMPERATURE_MIN = 0;
const TEMPERATURE_MAX = 2;
// Dezimalzahl als String (nur im coerce-Modus), z. B. "4096", "0.5", "1e3".
const NUMERIC_STRING_PATTERN = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/**
 * Provider-fertige Optionen (snake_case, nur gesetzte Felder als Schlüssel).
 * @typedef {Object} LLMRequestOptions
 * @property {number} [max_tokens] - Ganzzahl 1…Obergrenze
 * @property {number} [top_p] - 0 < x ≤ 1
 * @property {"none"|"minimal"|"low"|"medium"|"high"} [reasoning_effort]
 * @property {Object<string, boolean|number|string>} [chat_template_kwargs]
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

function isValidKwargsKey(key) {
  return (
    CHAT_TEMPLATE_KWARGS_KEY_PATTERN.test(key) &&
    !FORBIDDEN_KWARGS_KEYS.includes(key)
  );
}

/**
 * Wandelt im coerce-Modus Zahlen-Strings in Zahlen um; alles andere bleibt,
 * wie es ist (und wird danach normal validiert).
 */
function coerceNumber(value, coerce) {
  if (!coerce || typeof value !== "string") return value;
  const trimmed = value.trim();
  return NUMERIC_STRING_PATTERN.test(trimmed) ? Number(trimmed) : value;
}

/**
 * Erlaubte Schlüssel für `chat_template_kwargs`: Standard `enable_thinking`,
 * erweiterbar per ENV `LLM_CHAT_TEMPLATE_KWARGS_ALLOWLIST` (kommagetrennte
 * Schlüsselnamen, gleiche Syntaxregel wie für die Schlüssel selbst; ungültige
 * Einträge werden ignoriert).
 * @param {string|undefined} [envValue]
 * @returns {string[]}
 */
function resolveChatTemplateKwargsAllowlist(
  envValue = process.env[CHAT_TEMPLATE_KWARGS_ALLOWLIST_ENV]
) {
  const extra = String(envValue ?? "")
    .split(",")
    .map((key) => key.trim())
    .filter((key) => key.length > 0 && isValidKwargsKey(key));
  return [...new Set([...DEFAULT_CHAT_TEMPLATE_KWARGS_ALLOWLIST, ...extra])];
}

/**
 * Serverseitige Obergrenze für `max_tokens`:
 * ENV `LLM_REQUEST_MAX_TOKENS_CEILING` (Ganzzahl ≥ 1), sonst das
 * Kontextfenster des Providers (`promptWindowLimit()`, beim generischen
 * OpenAI-Provider GENERIC_OPEN_AI_MODEL_TOKEN_LIMIT), sonst 1.000.000.
 * @param {Object|(() => Object)|null} connector - LLMConnector oder eine
 *   Funktion, die ihn liefert (wird nur aufgerufen, wenn die ENV fehlt).
 * @returns {number}
 */
function resolveMaxTokensCeiling(connector = null) {
  const envValue = process.env[MAX_TOKENS_CEILING_ENV];
  if (isSet(envValue) && String(envValue).trim() !== "") {
    const parsed = Number(String(envValue).trim());
    if (Number.isInteger(parsed) && parsed >= 1) return parsed;
    console.warn(
      `[llmRequestOptions] ${MAX_TOKENS_CEILING_ENV}="${envValue}" is not a positive integer and is ignored.`
    );
  }
  try {
    const LLMConnector =
      typeof connector === "function" ? connector() : connector;
    const limit = Number(LLMConnector?.promptWindowLimit?.());
    if (Number.isFinite(limit) && limit >= 1) return Math.floor(limit);
  } catch (e) {
    console.warn(
      `[llmRequestOptions] Could not determine promptWindowLimit: ${e.message}`
    );
  }
  return MAX_TOKENS_LIMIT;
}

function validateChatTemplateKwargs(value, fieldName, allowlist) {
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
    if (!isValidKwargsKey(key))
      return {
        error: `${fieldName} contains an invalid key "${String(key).slice(0, 80)}". Keys must match ${CHAT_TEMPLATE_KWARGS_KEY_PATTERN} and must not be one of: ${FORBIDDEN_KWARGS_KEYS.join(", ")}.`,
      };
    if (!allowlist.includes(key))
      return {
        error: `${fieldName} contains the key "${key}", which is not allowed. Allowed keys: ${allowlist.join(", ")}.`,
      };

    const entry = value[key];
    if (typeof entry === "boolean" || isFiniteNumber(entry)) {
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
 * Validiert optionale LLM-Optionen einer API-Anfrage und liefert sie
 * provider-fertig (snake_case, nur gesetzte Felder).
 * Reine Funktion ohne Seiteneffekte; der Input wird nicht verändert.
 *
 * @param {Object|undefined|null} input - Objekt mit snake_case-Feldern
 *   (`max_tokens`, `top_p`, `reasoning_effort`, `chat_template_kwargs`,
 *   optional `temperature`). Unbekannte Felder werden ignoriert.
 * @param {Object} [config]
 * @param {boolean} [config.allowTemperature=false] - `temperature` mit auswerten (0…2).
 *   Ist es `false`, wird ein `temperature`-Feld wie ein unbekanntes Feld ignoriert.
 * @param {boolean} [config.coerce=false] - Zahlen-Strings umwandeln und
 *   `max_tokens: 0` als "nicht gesetzt" behandeln (OpenAI-Altclients).
 * @param {number} [config.maxTokensCeiling=1000000] - Obergrenze für `max_tokens`
 *   (siehe `resolveMaxTokensCeiling`).
 * @param {string[]} [config.chatTemplateKwargsAllowlist] - erlaubte Schlüssel
 *   für `chat_template_kwargs` (Default: `resolveChatTemplateKwargsAllowlist()`).
 * @param {string} [config.fieldPrefix=""] - Präfix für Fehlermeldungen, z. B. "llmOptions."
 * @returns {{ok: true, options: LLMRequestOptions} | {ok: false, error: string}}
 */
function parseLLMRequestOptions(
  input,
  {
    allowTemperature = false,
    coerce = false,
    maxTokensCeiling = MAX_TOKENS_LIMIT,
    chatTemplateKwargsAllowlist = resolveChatTemplateKwargsAllowlist(),
    fieldPrefix = "",
  } = {}
) {
  if (!isSet(input)) return { ok: true, options: {} };

  const container = fieldPrefix ? fieldPrefix.replace(/\.$/, "") : "options";
  if (!isPlainObject(input))
    return { ok: false, error: `${container} must be a JSON object.` };

  const name = (field) => `${fieldPrefix}${field}`;
  const options = {};

  const maxTokens = coerceNumber(input.max_tokens, coerce);
  if (isSet(maxTokens) && !(coerce && maxTokens === 0)) {
    if (
      !Number.isInteger(maxTokens) ||
      maxTokens < 1 ||
      maxTokens > maxTokensCeiling
    )
      return {
        ok: false,
        error: `${name("max_tokens")} must be an integer between 1 and ${maxTokensCeiling}.`,
      };
    options.max_tokens = maxTokens;
  }

  const topP = coerceNumber(input.top_p, coerce);
  if (isSet(topP)) {
    if (!isFiniteNumber(topP) || topP <= 0 || topP > 1)
      return {
        ok: false,
        error: `${name("top_p")} must be a number greater than 0 and at most 1.`,
      };
    options.top_p = topP;
  }

  if (isSet(input.reasoning_effort)) {
    const value = input.reasoning_effort;
    if (typeof value !== "string" || !REASONING_EFFORT_VALUES.includes(value))
      return {
        ok: false,
        error: `${name("reasoning_effort")} must be one of: ${REASONING_EFFORT_VALUES.join(", ")}.`,
      };
    options.reasoning_effort = value;
  }

  if (isSet(input.chat_template_kwargs)) {
    const { value, error } = validateChatTemplateKwargs(
      input.chat_template_kwargs,
      name("chat_template_kwargs"),
      chatTemplateKwargsAllowlist
    );
    if (error) return { ok: false, error };
    options.chat_template_kwargs = value;
  }

  const temperature = allowTemperature
    ? coerceNumber(input.temperature, coerce)
    : undefined;
  if (isSet(temperature)) {
    if (
      !isFiniteNumber(temperature) ||
      temperature < TEMPERATURE_MIN ||
      temperature > TEMPERATURE_MAX
    )
      return {
        ok: false,
        error: `${name("temperature")} must be a number between ${TEMPERATURE_MIN} and ${TEMPERATURE_MAX}.`,
      };
    options.temperature = temperature;
  }

  return { ok: true, options };
}

/**
 * Wie `parseLLMRequestOptions`, ermittelt aber die `max_tokens`-Obergrenze
 * aus dem LLMConnector des Workspaces (siehe `resolveMaxTokensCeiling`).
 * Der Connector wird nur erzeugt, wenn `max_tokens` überhaupt gesetzt ist und
 * keine ENV-Obergrenze existiert.
 * @param {Object|undefined|null} input
 * @param {Object|null} workspace - `{ chatProvider, chatModel }`
 * @param {Object} [config] - wie bei `parseLLMRequestOptions` (ohne maxTokensCeiling)
 */
function parseLLMRequestOptionsForWorkspace(input, workspace, config = {}) {
  const needsCeiling = isPlainObject(input) && isSet(input.max_tokens);
  const maxTokensCeiling = needsCeiling
    ? resolveMaxTokensCeiling(() => {
        // Lazy require: vermeidet Zirkelbezüge beim Laden der Helfer.
        const { getLLMProvider } = require("../index");
        return getLLMProvider({
          provider: workspace?.chatProvider,
          model: workspace?.chatModel,
        });
      })
    : MAX_TOKENS_LIMIT;
  return parseLLMRequestOptions(input, { ...config, maxTokensCeiling });
}

/**
 * Soll am OpenAI-kompatiblen Endpunkt das Reasoning (`<think>…</think>`) in
 * ein eigenes Feld `reasoning_content` ausgelagert werden?
 * Nur wenn der Aufrufer Thinking tatsächlich angefordert hat
 * (`chat_template_kwargs.enable_thinking === true` oder `reasoning_effort`
 * ≠ `none`). Sonst bleibt die Antwortform exakt wie bisher.
 * @param {LLMRequestOptions} [llmRequestOptions]
 * @returns {boolean}
 */
function shouldSeparateReasoning(llmRequestOptions = {}) {
  if (llmRequestOptions?.chat_template_kwargs?.enable_thinking === true)
    return true;
  const effort = llmRequestOptions?.reasoning_effort;
  return effort !== undefined && effort !== "none";
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
  parseLLMRequestOptionsForWorkspace,
  resolveMaxTokensCeiling,
  resolveChatTemplateKwargsAllowlist,
  shouldSeparateReasoning,
  splitThinkBlock,
  ThinkBlockSplitter,
  REASONING_EFFORT_VALUES,
};
