// Konversationen-Ansicht: kompakte Liste nach Tagen, Seitenpanel, Suche.
// Reine Hilfsfunktionen ohne React – Tagesgruppen und Uhrzeiten in Berliner
// Zeit (unabhängig von der Zeitzone des Browsers), Suchbegriff, Hervorhebung
// der Treffer und die Kennzahlen einer geöffneten Konversation.

const BERLIN = "Europe/Berlin";

/** Kürzester Suchbegriff, ab dem gesucht wird. */
export const SEARCH_MIN_LENGTH = 2;

const formatters = new Map();
function berlinFormatter(locale, options) {
  const key = `${locale}|${JSON.stringify(options)}`;
  if (!formatters.has(key)) {
    const fixed = {
      ...options,
      calendar: "gregory",
      numberingSystem: "latn",
      timeZone: BERLIN,
    };
    let formatter;
    try {
      formatter = new Intl.DateTimeFormat(locale, fixed);
    } catch {
      formatter = new Intl.DateTimeFormat("de-DE", fixed);
    }
    formatters.set(key, formatter);
  }
  return formatters.get(key);
}

/**
 * Berliner Kalendertag eines Zeitpunkts.
 * @param {number|string|Date} instant - Millisekunden, ISO-Zeitstempel oder Date
 * @returns {string} - "YYYY-MM-DD"
 */
export function berlinDay(instant) {
  const parts = berlinFormatter("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(instant));
  const part = (type) => parts.find((p) => p.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/**
 * Berliner Uhrzeit "HH:MM".
 * @param {number|string|Date} instant
 * @returns {string}
 */
export function berlinTime(instant) {
  return berlinFormatter("de-DE", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(instant));
}

/** Mittag (Berlin) eines Kalendertags – zum Formatieren von Namen. */
function noonOf(day) {
  return new Date(`${day}T10:00:00Z`);
}

/** Der Tag vor einem Kalendertag. */
function previousDay(day) {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

/**
 * Überschrift einer Tagesgruppe: „Heute · Dienstag, 13. Oktober",
 * „Gestern · Montag, 12. Oktober", „Sonntag, 11. Oktober"; aus einem anderen
 * Jahr als heute mit Jahreszahl.
 * @param {string} day - Berliner Kalendertag "YYYY-MM-DD"
 * @param {string} today - heutiger Berliner Kalendertag
 * @param {{t: Function, locale: string}} context
 * @returns {string}
 */
export function dayGroupLabel(day, today, { t, locale }) {
  const sameYear = day.slice(0, 4) === today.slice(0, 4);
  const date = berlinFormatter(locale, {
    weekday: "long",
    day: "numeric",
    month: "long",
    ...(sameYear ? {} : { year: "numeric" }),
  }).format(noonOf(day));
  if (day === today) return t("embed-analytics.rows.today", { date });
  if (day === previousDay(today))
    return t("embed-analytics.rows.yesterday", { date });
  return date;
}

/**
 * „9. Okt." – kurzer Tag für „begonnen am …"; aus einem anderen Jahr als
 * heute mit Jahreszahl.
 * @param {string} day
 * @param {string} today
 * @param {string} locale
 * @returns {string}
 */
export function shortDayLabel(day, today, locale) {
  return berlinFormatter(locale, {
    day: "numeric",
    month: "short",
    ...(day.slice(0, 4) === today.slice(0, 4) ? {} : { year: "numeric" }),
  }).format(noonOf(day));
}

/**
 * „Dienstag, 13.10.2026" – Wochentag in der Sprache der Oberfläche, Datum in
 * deutscher Schreibweise.
 * @param {string} day
 * @param {string} locale
 * @returns {string}
 */
export function longDateLabel(day, locale) {
  const weekday = berlinFormatter(locale, { weekday: "long" }).format(
    noonOf(day)
  );
  const [year, month, date] = day.split("-");
  return `${weekday}, ${date}.${month}.${year}`;
}

/**
 * Konversationen der Liste nach dem Berliner Tag ihrer LETZTEN Nachricht –
 * in der Reihenfolge der Liste (letzte Nachricht absteigend). Eine
 * weitergeführte alte Konversation steht so unter „Heute".
 * @param {Array<{last_message_at: number}>} conversations
 * @returns {Array<{day: string, conversations: Array}>}
 */
export function groupByLastMessageDay(conversations) {
  const groups = [];
  for (const conversation of conversations) {
    const day = berlinDay(conversation.last_message_at);
    const last = groups.at(-1);
    if (last && last.day === day) last.conversations.push(conversation);
    else groups.push({ day, conversations: [conversation] });
  }
  return groups;
}

/**
 * Beginn an einem anderen Tag als die letzte Nachricht? Dann der Tag des
 * Beginns, sonst null.
 * @param {{started_at: number, last_message_at: number}} conversation
 * @returns {string|null} - Berliner Kalendertag des Beginns
 */
export function startedOnOtherDay(conversation) {
  const started = berlinDay(conversation.started_at);
  return started === berlinDay(conversation.last_message_at) ? null : started;
}

/**
 * Suchbegriff der Liste: getrimmt; kürzer als SEARCH_MIN_LENGTH = keine Suche.
 * @param {string|null|undefined} value
 * @returns {string} - "" ohne Suche
 */
export function effectiveSearch(value) {
  const term = String(value ?? "")
    .normalize("NFC")
    .trim();
  return [...term].length >= SEARCH_MIN_LENGTH ? term : "";
}

/**
 * Schlüssel einer Konversation der Liste: Kennung und Browser-Sitzung – eine
 * zweite Sitzung kann dieselbe Kennung tragen (KIE-538).
 * @param {{conversation_id: string, session_id: string}} conversation
 * @returns {string}
 */
export function conversationKey({ conversation_id, session_id }) {
  return `${conversation_id}\u0000${session_id}`;
}

/**
 * Die Kennung gekürzt für die Fußzeile: die ersten 8 Zeichen und „…".
 * @param {string|null|undefined} id
 * @returns {string}
 */
export function shortId(id) {
  const chars = [...String(id ?? "")];
  return chars.length > 9 ? `${chars.slice(0, 8).join("")}…` : chars.join("");
}

/**
 * Text einer gespeicherten Antwort, wie die Ansicht ihn zeigt: bei JSON das
 * Feld text, sonst die Antwort selbst.
 * @param {string|null} response
 * @returns {string}
 */
export function answerText(response) {
  if (typeof response !== "string") return "";
  try {
    const parsed = JSON.parse(response);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      return typeof parsed.text === "string" ? parsed.text : "";
  } catch {
    // keine JSON-Antwort: wörtlich
  }
  return response;
}

/**
 * Die Angaben zum Kopf des Panels aus den Nachrichten einer Konversation.
 * @param {Array<{prompt: string, createdAt: string, feedbackScore: boolean|null, conversation_id: string|null, session_id: string}>} messages
 * @returns {{key: string, conversationId: string, firstQuestion: string, startedAt: number, lastAt: number, questions: number, positive: number, negative: number}|null}
 */
export function conversationSummary(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return null;
  const first = messages[0];
  const times = messages.map((m) => new Date(m.createdAt).getTime());
  const conversationId = first.conversation_id ?? first.session_id;
  return {
    key: conversationKey({
      conversation_id: conversationId,
      session_id: first.session_id,
    }),
    conversationId,
    firstQuestion: first.prompt ?? "",
    startedAt: Math.min(...times),
    lastAt: Math.max(...times),
    questions: messages.length,
    positive: messages.filter((m) => m.feedbackScore === true).length,
    negative: messages.filter((m) => m.feedbackScore === false).length,
  };
}

/**
 * Liegt keine Nachricht im gewählten Zeitraum? Dann zeigt die Liste die
 * Konversation nicht (geöffnet per Link).
 * @param {Array<{createdAt: string}>} messages
 * @param {string|null} startDate - ISO-Zeitstempel (null = „Gesamt")
 * @param {string|null} endDate
 * @returns {boolean}
 */
export function outsidePeriod(messages, startDate, endDate) {
  if (!Array.isArray(messages) || messages.length === 0) return false;
  if (!startDate && !endDate) return false;
  const from = startDate ? Date.parse(startDate) : -Infinity;
  const to = endDate ? Date.parse(endDate) : Infinity;
  return !messages.some((m) => {
    const at = Date.parse(m.createdAt);
    return at >= from && at <= to;
  });
}

const REGEXP_SPECIAL = /[.*+?^${}()|[\]\\/]/g;

/**
 * Regulärer Ausdruck für den Suchbegriff: wörtlich, Groß/klein egal (auch
 * bei Umlauten). null ohne Begriff.
 * @param {string} term
 * @returns {RegExp|null}
 */
export function searchPattern(term) {
  const search = effectiveSearch(term);
  if (!search) return null;
  return new RegExp(search.replace(REGEXP_SPECIAL, "\\$&"), "giu");
}

/**
 * Teilt einen Text in Abschnitte mit und ohne Treffer – für die Hervorhebung
 * in React (der Text bleibt Text, kein HTML).
 * @param {string} text
 * @param {string} term
 * @returns {Array<{text: string, hit: boolean}>}
 */
export function highlightParts(text, term) {
  const value = String(text ?? "");
  const pattern = searchPattern(term);
  if (!pattern || value === "") return [{ text: value, hit: false }];
  const parts = [];
  let last = 0;
  for (const match of value.matchAll(pattern)) {
    if (match[0] === "") continue;
    if (match.index > last)
      parts.push({ text: value.slice(last, match.index), hit: false });
    parts.push({ text: match[0], hit: true });
    last = match.index + match[0].length;
  }
  if (last < value.length) parts.push({ text: value.slice(last), hit: false });
  return parts.length > 0 ? parts : [{ text: value, hit: false }];
}

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;
// In diesen Elementen wird nichts hervorgehoben.
const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "TEXTAREA", "MARK"]);

/**
 * Hebt die Treffer in den Textknoten eines (bereits bereinigten) DOM-Baums
 * hervor: Jeder Treffer wird ein <mark data-search-hit>, dessen Inhalt ein
 * Textknoten ist. Aus dem Nutzertext entsteht nie HTML – es werden nur
 * Textknoten geteilt.
 * @param {Node} root
 * @param {string} term
 * @param {Document} doc - Dokument, das die Knoten erzeugt
 * @returns {number} - Zahl der Treffer
 */
export function highlightTextNodes(root, term, doc) {
  if (!root || !doc || !searchPattern(term)) return 0;
  const textNodes = [];
  const walk = (node) => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === TEXT_NODE) textNodes.push(child);
      else if (
        child.nodeType === ELEMENT_NODE &&
        !SKIP_TAGS.has(String(child.nodeName).toUpperCase())
      )
        walk(child);
    }
  };
  walk(root);

  let hits = 0;
  for (const node of textNodes) {
    const parts = highlightParts(node.nodeValue, term);
    if (!parts.some((part) => part.hit)) continue;
    const parent = node.parentNode;
    for (const part of parts) {
      if (part.hit) {
        const mark = doc.createElement("mark");
        mark.setAttribute("data-search-hit", "");
        mark.appendChild(doc.createTextNode(part.text));
        parent.insertBefore(mark, node);
        hits += 1;
      } else {
        parent.insertBefore(doc.createTextNode(part.text), node);
      }
    }
    parent.removeChild(node);
  }
  return hits;
}
