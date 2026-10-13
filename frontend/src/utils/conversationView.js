// Konversationen-Ansicht: kompakte Liste nach Tagen, Seitenpanel, Suche.
// Reine Hilfsfunktionen ohne React – Tagesgruppen und Uhrzeiten in Berliner
// Zeit (unabhängig von der Zeitzone des Browsers), Suchbegriff, Hervorhebung
// der Treffer und die Kennzahlen einer geöffneten Konversation.
//
// Datumsangaben stehen immer in deutscher Schreibweise, auch bei englischer
// Oberfläche – übersetzt werden nur die Wörter darum („Heute", „begonnen
// am"). Kalendertage kommen aus formatDateForInput (Berliner Tag eines
// Zeitpunkts), Tagesnamen aus formatterOf (analyticsTimeline).

import { formatDateForInput } from "./billingDate.js";
import { addDays, formatDate, formatterOf } from "./analyticsTimeline.js";

/** Zeitzone aller Tage und Uhrzeiten der Ansicht (auch in Tooltips). */
export const BERLIN = "Europe/Berlin";
const GERMAN = "de-DE";
/**
 * Ab dieser Breite steht das Panel neben der Liste (Tailwind lg), darunter
 * ist es ein Vollbild.
 */
export const WIDE_QUERY = "(min-width: 1024px)";

/** Kürzester Suchbegriff, ab dem gesucht wird. */
export const SEARCH_MIN_LENGTH = 2;
/**
 * Längster Suchbegriff (Zeichen) – derselbe Wert wie SEARCH_MAX_LENGTH des
 * Servers (server/utils/helpers/chat/conversationSearch.js; ein Test prüft
 * die Gleichheit).
 */
export const SEARCH_MAX_LENGTH = 200;

const timeFormatter = new Intl.DateTimeFormat(GERMAN, {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: BERLIN,
});

/**
 * Berliner Uhrzeit "HH:MM"; "" ohne gültigen Zeitpunkt.
 * @param {number|string|Date} instant
 * @returns {string}
 */
export function berlinTime(instant) {
  const date = new Date(instant);
  return isNaN(date.getTime()) ? "" : timeFormatter.format(date);
}

/** Mitternacht (UTC) eines Kalendertags – formatterOf rechnet in UTC. */
const instantOf = (day) => new Date(`${day}T00:00:00Z`);

/**
 * Überschrift einer Tagesgruppe: „Heute · Dienstag, 13. Oktober",
 * „Gestern · Montag, 12. Oktober", „Sonntag, 11. Oktober"; aus einem anderen
 * Jahr als heute mit Jahreszahl. Das Datum steht immer deutsch, nur „Heute"
 * und „Gestern" folgen der Sprache der Oberfläche.
 * @param {string} day - Berliner Kalendertag "YYYY-MM-DD" ("" = unbekannt)
 * @param {string} today - heutiger Berliner Kalendertag
 * @param {{t: Function}} context
 * @returns {string}
 */
export function dayGroupLabel(day, today, { t }) {
  if (!day) return "–";
  const sameYear = day.slice(0, 4) === today.slice(0, 4);
  const date = formatterOf(GERMAN, {
    weekday: "long",
    day: "numeric",
    month: "long",
    ...(sameYear ? {} : { year: "numeric" }),
  }).format(instantOf(day));
  if (day === today) return t("embed-analytics.rows.today", { date });
  if (day === addDays(today, -1))
    return t("embed-analytics.rows.yesterday", { date });
  return date;
}

/**
 * „9. Okt." – kurzer Tag für „begonnen am …" (immer deutsch); aus einem
 * anderen Jahr als heute mit Jahreszahl.
 * @param {string} day
 * @param {string} today
 * @returns {string}
 */
export function shortDayLabel(day, today) {
  if (!day) return "–";
  return formatterOf(GERMAN, {
    day: "numeric",
    month: "short",
    ...(day.slice(0, 4) === today.slice(0, 4) ? {} : { year: "numeric" }),
  }).format(instantOf(day));
}

/**
 * „Dienstag, 13.10.2026" – Kopf des Panels, immer deutsch.
 * @param {string} day
 * @returns {string}
 */
export function longDateLabel(day) {
  if (!day) return "";
  const weekday = formatterOf(GERMAN, { weekday: "long" }).format(
    instantOf(day)
  );
  return `${weekday}, ${formatDate(day)}`;
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
    const day = formatDateForInput(conversation.last_message_at);
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
  const started = formatDateForInput(conversation.started_at);
  return !started ||
    started === formatDateForInput(conversation.last_message_at)
    ? null
    : started;
}

// Steuerzeichen und allein stehende Ersatzhälften lehnt der Server ab (400).
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const LONE_SURROGATE = /[\uD800-\uDFFF]/u;

/** getrimmt, NFC; null, wenn der Server den Begriff ablehnen würde */
function cleanTerm(value) {
  const raw = String(value ?? "");
  if (LONE_SURROGATE.test(raw)) return null;
  const term = raw.normalize("NFC").trim();
  return CONTROL_CHARACTERS.test(term) ? null : term;
}

/**
 * Suchbegriff der Liste: getrimmt, in NFC, auf SEARCH_MAX_LENGTH Zeichen
 * gekürzt; kürzer als SEARCH_MIN_LENGTH oder für den Server ungültig
 * (Steuerzeichen, kaputtes Unicode) = keine Suche.
 * @param {string|null|undefined} value
 * @returns {string} - "" ohne Suche
 */
export function effectiveSearch(value) {
  const term = cleanTerm(value);
  if (term === null) return "";
  const chars = [...term];
  const cut =
    chars.length > SEARCH_MAX_LENGTH
      ? chars.slice(0, SEARCH_MAX_LENGTH).join("").trim()
      : term;
  return [...cut].length >= SEARCH_MIN_LENGTH ? cut : "";
}

/**
 * Ein Suchbegriff aus der Adresse (Link), den die Ansicht nicht unverändert
 * übernehmen kann: zu lang (wird gekürzt) oder ungültig (wird verworfen).
 * @param {string|null|undefined} value
 * @returns {"too-long"|"invalid"|null}
 */
export function searchLinkIssue(value) {
  if (!value) return null;
  const term = cleanTerm(value);
  if (term === null) return "invalid";
  return [...term].length > SEARCH_MAX_LENGTH ? "too-long" : null;
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

// Markdown-Autolinks: <https://…>, <mailto:…>, <info@vhs.de> – der
// MarkdownRenderer zeigt die Adresse als Linktext (Fixliste 2, S2).
const AUTOLINK =
  /<((?:[a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s<>]*)|(?:[^\s<>@]+@[^\s<>@]+))>/g;

/**
 * Was von einem Antworttext sichtbar ist (ungefähr wie der MarkdownRenderer
 * ihn zeigt): ohne <think>-Blöcke (eingeklappt), ohne Ziele von Links und
 * Bildern ("[Text](https://…)" → "Text"), ohne HTML-Tags und Attribute.
 * Autolinks (<https://…>, <info@…>) bleiben als ihr sichtbarer Text.
 * @param {string} text
 * @returns {string}
 */
export function visibleAnswerText(text) {
  return String(text ?? "")
    .replace(/<think>[^]*?<\/think>/g, " ")
    .replace(/\]\([^)]*\)/g, "]")
    .replace(AUTOLINK, " $1 ")
    .replace(/<\/?[a-zA-Z][^>]*>/g, " ");
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
const escapeRegExp = (text) => text.replace(REGEXP_SPECIAL, "\\$&");

/**
 * Regulärer Ausdruck für den Suchbegriff: wörtlich, Groß/klein egal (auch
 * bei Umlauten), in NFC und NFD – ein zerlegtes „ü" im Text trifft wie ein
 * zusammengesetztes. null ohne Begriff. Bewusst belassen: In zerlegtem Text
 * trifft auch der Basisbuchstabe allein („mu" in „Müller"), wie auf dem
 * Server (searchForms in server/utils/helpers/chat/conversationSearch.js).
 * @param {string} term
 * @returns {RegExp|null}
 */
export function searchPattern(term) {
  const search = effectiveSearch(term);
  if (!search) return null;
  const forms = [...new Set([search, search.normalize("NFD")])];
  return new RegExp(forms.map(escapeRegExp).join("|"), "giu");
}

/**
 * Teilt einen Text in Abschnitte mit und ohne Treffer – für die Hervorhebung
 * in React (der Text bleibt Text, kein HTML).
 * @param {string} text
 * @param {string|RegExp|null} term - Suchbegriff oder schon gebautes Muster
 * @returns {Array<{text: string, hit: boolean}>}
 */
export function highlightParts(text, term) {
  const value = String(text ?? "");
  const pattern = term instanceof RegExp ? term : searchPattern(term);
  if (!pattern || value === "") return [{ text: value, hit: false }];
  const parts = [];
  let last = 0;
  // Der Begriff hat mindestens SEARCH_MIN_LENGTH Zeichen: kein leerer Treffer.
  for (const match of value.matchAll(pattern)) {
    if (match.index > last)
      parts.push({ text: value.slice(last, match.index), hit: false });
    parts.push({ text: match[0], hit: true });
    last = match.index + match[0].length;
  }
  if (last < value.length) parts.push({ text: value.slice(last), hit: false });
  return parts;
}

/**
 * Steht der Suchbegriff irgendwo SICHTBAR in der Konversation – in einer
 * Frage, im sichtbaren Antworttext, in Grund oder Kommentar? Die Suche des
 * Servers liest auch Link-Adressen, HTML und <think>-Blöcke der Antwort; nur
 * dort getroffen, weist das Panel darauf hin (Fixliste Punkt 11).
 *
 * Geprüft werden nur die Nachrichten, die auch der Server durchsucht hat:
 * die im Zeitraum (Fixliste 2, S7) – mit Abschnitt (Säulenklick) die ganze
 * Konversation, dann ohne Zeitraum. Grund und Kommentar zeigt das Panel nur
 * bei negativer Bewertung.
 * @param {Array<{prompt: string, response: string, createdAt?: string, feedbackScore?: boolean|null, feedbackReason?: string|null, feedbackText?: string|null}>} messages
 * @param {string} term
 * @param {{startDate?: string|null, endDate?: string|null}} [period] -
 *   ISO-Zeitstempel; ohne Angabe alle Nachrichten
 * @returns {boolean} - true auch ohne Suche
 */
export function hasVisibleHit(messages, term, period = {}) {
  const pattern = searchPattern(term);
  if (!pattern) return true;
  const hit = (text) => {
    pattern.lastIndex = 0;
    return pattern.test(String(text ?? ""));
  };
  const from = period.startDate ? Date.parse(period.startDate) : -Infinity;
  const to = period.endDate ? Date.parse(period.endDate) : Infinity;
  const searched = (message) => {
    if (from === -Infinity && to === Infinity) return true;
    const at = Date.parse(message.createdAt);
    return at >= from && at <= to;
  };
  return (messages ?? [])
    .filter(searched)
    .some(
      (message) =>
        hit(message.prompt) ||
        (message.feedbackScore === false &&
          (hit(message.feedbackReason) || hit(message.feedbackText))) ||
        hit(visibleAnswerText(answerText(message.response)))
    );
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
  const pattern = searchPattern(term);
  if (!root || !doc || !pattern) return 0;
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
    const parts = highlightParts(node.nodeValue, pattern);
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

/**
 * Das erste Element mit einem Attribut unter einem Knoten (Dokumentreihenfolge).
 * @param {Node|null} root
 * @param {string} attribute
 * @returns {Element|null}
 */
export function firstElementWith(root, attribute) {
  for (const child of root?.childNodes ?? []) {
    if (child.nodeType !== ELEMENT_NODE) continue;
    if (child.hasAttribute?.(attribute)) return child;
    const found = firstElementWith(child, attribute);
    if (found) return found;
  }
  return null;
}

/**
 * Alle Elemente unter einem Knoten mit einem Attributwert
 * (Dokumentreihenfolge), etwa die Einträge eines Menüs (role="menuitem").
 * @param {Node|null} root
 * @param {string} attribute
 * @param {string} value
 * @returns {Element[]}
 */
export function elementsWith(root, attribute, value, found = []) {
  for (const child of root?.childNodes ?? []) {
    if (child.nodeType !== ELEMENT_NODE) continue;
    if (child.getAttribute?.(attribute) === value) found.push(child);
    elementsWith(child, attribute, value, found);
  }
  return found;
}

/**
 * Scrollposition eines Bereichs, bei der ein Element darin mittig steht –
 * nur der Bereich scrollt, nicht die Seite (anders als scrollIntoView).
 * @param {{scrollTop: number, clientHeight: number, getBoundingClientRect: Function}} container
 * @param {{getBoundingClientRect: Function}} element
 * @returns {number}
 */
export function centeredScrollTop(container, element) {
  const box = container.getBoundingClientRect();
  const target = element.getBoundingClientRect();
  const offset = target.top - box.top + (container.scrollTop || 0);
  const centered = offset - ((container.clientHeight || 0) - target.height) / 2;
  return Number.isFinite(centered) ? Math.max(0, Math.round(centered)) : 0;
}
