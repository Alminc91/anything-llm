// Design Center (vereinfacht, 15./16.10.2026): Logik der Felder, die Kunden
// noch einstellen (visual_config). Alle übrigen Darstellungs-Optionen sind
// fest eingebaut; der Server erzwingt sie beim Ausliefern
// (server/utils/chats/embedStandards.js), das Widget zusätzlich selbst.
// Gespeicherte Werte entfallener Optionen bleiben beim Speichern unverändert
// stehen (kein Datenverlust), das Design Center schreibt sie nicht neu.
//
// Grenzen und Regeln wie der Server (endpoints/embed mapLayoutConfig,
// embedStandards.js): Hier nur zusätzlich, damit ungültige Werte gar nicht
// erst gespeichert werden.

import {
  SHOWN_BLACK,
  MIN_TEXT_CONTRAST,
  accessibleTextColor,
  contrastRatio,
  parseColor,
  recommendedTextColor,
} from "./contrast.js";

export const DISPLAY_MODE_OPTIONS = [
  { value: "bubble", label: "Chatblase" },
  { value: "inline", label: "Inline in der Seite" },
];
export const THEME_OPTIONS = [
  { value: "light", label: "Hell" },
  { value: "dark", label: "Dunkel" },
];
export const POSITION_OPTIONS = [
  { value: "bottom-left", label: "Links" },
  { value: "bottom-right", label: "Rechts" },
];
export const USER_TEXT_COLOR_OPTIONS = [
  { value: "#FFFFFF", label: "Weiß" },
  { value: SHOWN_BLACK, label: "Schwarz" },
];

// Antworten mit Kursen (KIE-567, Reiter Aussehen, beide Darstellungen).
// Werte wie der Server (embedStandards.js COURSE_CARDS_VALUES,
// COURSE_CARDS_POSITIONS): ohne bzw. mit ungültigem Wert gilt der Standard
// (Kurskarten, Karten zuerst).
export const COURSE_CARDS_OPTIONS = [
  { value: "auto", label: "Kurskarten" },
  { value: "off", label: "Nur Text mit Links" },
];
export const COURSE_CARDS_POSITION_OPTIONS = [
  { value: "above", label: "Karten zuerst" },
  { value: "below", label: "Text zuerst" },
];
// Willkommensblasen je Gerät (KIE-568, Reiter Inhalt, nur Chatblase), Werte
// wie der Server (WELCOME_BUBBLES_VALUES), Standard "first"
export const WELCOME_BUBBLES_OPTIONS = [
  { value: "off", label: "Aus" },
  { value: "first", label: "Beim ersten Besuch" },
  { value: "every", label: "Bei jedem Besuch" },
];
export const WELCOME_BUBBLES_DEVICES = [
  { key: "welcomeBubblesDesktop", label: "Desktop" },
  { key: "welcomeBubblesMobile", label: "Handy" },
];

// Auswahl-Schlüssel mit Standard (für choiceValue/withChoice)
export const CHOICE_DEFAULTS = {
  courseCards: { options: COURSE_CARDS_OPTIONS, fallback: "auto" },
  courseCardsPosition: {
    options: COURSE_CARDS_POSITION_OPTIONS,
    fallback: "above",
  },
  welcomeBubblesDesktop: {
    options: WELCOME_BUBBLES_OPTIONS,
    fallback: "first",
  },
  welcomeBubblesMobile: { options: WELCOME_BUBBLES_OPTIONS, fallback: "first" },
};

/**
 * Wirksamer Wert eines Auswahl-Schlüssels wie im Server (courseCardsValue,
 * courseCardsPositionValue, welcomeBubblesValue): String, getrimmt und klein
 * geschrieben einer der Werte, sonst der Standard.
 * @param {Object} config
 * @param {keyof CHOICE_DEFAULTS} key
 * @returns {string}
 */
export function choiceValue(config, key) {
  const { options, fallback } = CHOICE_DEFAULTS[key];
  const v = config?.[key];
  if (typeof v !== "string") return fallback;
  const normalized = v.trim().toLowerCase();
  return options.some((o) => o.value === normalized) ? normalized : fallback;
}

/**
 * Bearbeitungsstand nach einer Auswahl (Regel D6: nur geänderte Werte
 * speichern). Entspricht die Wahl dem wirksamen gespeicherten Wert, gilt
 * wieder der gespeicherte Stand (fehlt der Schlüssel dort, bleibt er weg;
 * so schreibt ein Klick auf den Standard nichts). Sonst wird die Wahl
 * gesetzt.
 * @param {Object} config Bearbeitungsstand
 * @param {Object} initial gespeicherter Stand
 * @param {keyof CHOICE_DEFAULTS} key
 * @param {string} value gewählte Option
 * @returns {Object}
 */
export function withChoice(config, initial = {}, key, value) {
  const next = { ...config };
  if (choiceValue(initial, key) === value) {
    if (key in initial) next[key] = initial[key];
    else delete next[key];
  } else next[key] = value;
  return next;
}

// Vorschläge für Widgets ohne gespeicherte Liste (Entscheidung D6): nur
// sichtbar als Vorschlag mit „Vorschläge übernehmen“, nie ungefragt
// gespeichert (sonst schrieb schon eine Farbänderung VHS-Fragen in jedes
// Widget, auch bei Nicht-VHS-Kunden, und der Server-Wert schlug die
// Startvorschläge aus dem Skript).
export const DEFAULT_SUGGESTIONS = [
  "Welche Sprachkurse gibt es?",
  "Wie melde ich mich an?",
  "Kurse am Wochenende",
];
export const DEFAULT_WELCOME_BUBBLES = [
  "Hallo! Ich bin Ihr KI-Berater.",
  "Möchten Sie mehr über unser Angebot erfahren? Ich helfe gerne weiter!",
];

// Aussehen ohne gespeicherten Wert: genau die Standards des Widgets
// (anythingllm-embed, hooks/useScriptAttributes.js DEFAULT_SETTINGS:
// buttonColor, chatIcon, position). Das Design Center zeigt sie an,
// speichert sie aber nur, wenn der Kunde etwas wählt. Die Schrift auf der
// Kundenfarbe hat keinen festen Standard: ohne gespeicherten Wert gilt die
// Empfehlung nach Kontrast (userTextColor, KIE-565 Nachtrag).
export const LOOK_DEFAULTS = {
  accentColor: "#01A5A9",
  chatIcon: "chatBubble",
  position: "bottom-left",
};
export const DEFAULT_ACCENT_COLOR = LOOK_DEFAULTS.accentColor;

/**
 * Wert fürs Aussehen: gespeicherter Text bzw. Standard des Widgets; bei
 * "userTextColor" ohne gespeicherten Wert die Empfehlung zur Kundenfarbe.
 * @param {Object} config
 * @param {"accentColor"|"userTextColor"|"chatIcon"|"position"} key
 * @returns {string}
 */
export function lookValue(config, key) {
  if (key === "userTextColor") return userTextColor(config);
  const v = config?.[key];
  return typeof v === "string" && v.trim() ? v : LOOK_DEFAULTS[key];
}

// ---------------------------------------------------------------------------
// Schrift auf der Kundenfarbe (KIE-565 Nachtrag, Nutzer 15.10.2026): Weiß
// oder Schwarz für Nutzer-Nachrichten und alle Flächen in Kundenfarbe
// (Senden-Button, Chat-Button, gefüllte Pillen beim Darüberfahren). Die
// Empfehlung rechnet wie das Widget (contrast.js, wortgleich mit
// anythingllm-embed src/utils/contrast.js): WCAG-2.x-Kontrast der
// Kundenfarbe zu den gezeigten Schriften #FFFFFF und #222628, der höhere
// gewinnt, Gleichstand Weiß (Entscheidung E1, Fixliste 7.22-rc7).
// Empfehlung, Markierung und Warnung rechnen alle mit der Farbe, die das
// Widget zeigt: „Schwarz“ ist #222628, auch ein früher gespeichertes
// #000000 (der Server liefert es als #222628 aus). Gespeichert wird nur,
// was der Kunde wählt (Regel D6); ein gespeicherter Altwert #000000 bleibt
// beim Speichern unverändert stehen, und ein Klick auf die schon wirksame
// Option ändert nichts (withUserTextColor).
// ---------------------------------------------------------------------------

export { MIN_TEXT_CONTRAST };

// Früher gespeicherte Werte und die Farbe, die das Widget dafür zeigt (wie
// der Server, endpoints/embed/index.js shownUserTextColor)
const LEGACY_USER_TEXT_COLORS = { "#000000": SHOWN_BLACK };

/**
 * Gespeicherte Schrift auf der Kundenfarbe als gezeigte Farbe (die beiden
 * Optionen mit einheitlicher Schreibweise, früheres #000000 als #222628)
 * oder null, wenn keine gespeichert ist.
 * @param {Object} config
 * @returns {string|null}
 */
export function storedUserTextColor(config = {}) {
  const v = config?.userTextColor;
  if (typeof v !== "string" || !v.trim()) return null;
  const key = v.trim().toLowerCase();
  const option = USER_TEXT_COLOR_OPTIONS.find(
    (o) => o.value.toLowerCase() === key
  );
  return option ? option.value : LEGACY_USER_TEXT_COLORS[key] || v;
}

/**
 * Wirksame Schrift auf der Kundenfarbe: gespeicherter Wert bzw. die
 * Empfehlung zur (wirksamen) Kundenfarbe, wie im Widget.
 * @param {Object} config
 * @returns {string}
 */
export function userTextColor(config = {}) {
  return (
    storedUserTextColor(config) ||
    recommendedTextColor(lookValue(config, "accentColor"))
  );
}

// Option (Weiß/Schwarz) zu einer Empfehlung
function optionFor(recommended) {
  return recommended === SHOWN_BLACK
    ? USER_TEXT_COLOR_OPTIONS[1]
    : USER_TEXT_COLOR_OPTIONS[0];
}

/**
 * Markierte Option im Feld: die gespeicherte bzw. die empfohlene.
 * @param {Object} config
 * @returns {string|null} Wert der Option; null bei einem gespeicherten
 *   Wert, der keine der beiden Optionen ist (keine markiert)
 */
export function userTextColorChoice(config = {}) {
  const stored = storedUserTextColor(config);
  if (stored)
    return USER_TEXT_COLOR_OPTIONS.some((o) => o.value === stored)
      ? stored
      : null;
  return optionFor(recommendedTextColor(lookValue(config, "accentColor")))
    .value;
}

/**
 * Bearbeitungsstand nach einem Klick auf Weiß oder Schwarz (E1, Regel D6):
 * Zeigt der gespeicherte Wert (bzw. ohne gespeicherten Wert die Empfehlung
 * zur aktuellen Kundenfarbe) schon die gewählte Option, gilt wieder der
 * gespeicherte Stand (fehlt der Schlüssel dort, bleibt er weg; ein
 * gespeichertes #000000 bleibt #000000). Sonst wird die Option gesetzt.
 * @param {Object} config Bearbeitungsstand
 * @param {Object} initial gespeicherter Stand
 * @param {string} value Wert der Option
 * @returns {Object}
 */
export function withUserTextColor(config, initial = {}, value) {
  const restored = { ...config };
  if ("userTextColor" in initial)
    restored.userTextColor = initial.userTextColor;
  else delete restored.userTextColor;
  if (userTextColorChoice(restored) === value) return restored;
  return { ...config, userTextColor: value };
}

/**
 * Fehlermeldung zum Farbcode der Kundenfarbe oder null (Review 7.22-rc6
 * F06). Leer ist kein Fehler (es gilt der Standard). Empfehlung und Warnung
 * rechnen mit einer deckenden Farbe; eine durchscheinende (#rrggbbaa,
 * rgba() mit Alpha unter 1) würde auf der Seite heller erscheinen, als
 * gerechnet. Deshalb nur deckende Farbcodes.
 * @param {*} value
 * @returns {string|null}
 */
export function accentColorError(value) {
  const text = textValue(value).trim();
  if (!text) return null;
  if (parseColor(text) === null)
    return "Bitte einen Farbcode wie #01A5A9 angeben.";
  if (colorAlpha(text) < 1)
    return "Bitte eine deckende Farbe ohne Transparenz angeben.";
  return null;
}

// Alphawert eines (gültigen) Farbcodes, 0 … 1; ohne Angabe 1
function colorAlpha(color) {
  const hex = /^#[0-9a-f]{6}([0-9a-f]{2})$/i.exec(color);
  if (hex) return parseInt(hex[1], 16) / 255;
  const fn = /[,/]\s*([\d.]+)(%?)\s*\)$/.exec(color);
  if (!fn) return 1;
  const value = Number(fn[1]);
  if (!Number.isFinite(value)) return 0;
  return fn[2] ? value / 100 : value;
}

/** Kontrast für Texte: eine Nachkommastelle, abgerundet, z. B. "4,4:1" */
export function contrastLabel(ratio) {
  const value = Math.floor(ratio * 10) / 10;
  return `${value.toLocaleString("de-DE", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })}:1`;
}

/**
 * Empfehlung und Warnung unter dem Feld „Schrift auf der Kundenfarbe“.
 * @param {Object} config
 * @returns {{recommendedLabel: string|null, stored: boolean,
 *   ratio: number|null, warning: string|null}}
 *   recommendedLabel null: Kundenfarbe ist kein gültiger Farbcode
 */
export function userTextColorAdvice(config = {}) {
  const accent = lookValue(config, "accentColor");
  const stored = storedUserTextColor(config) !== null;
  if (parseColor(accent) === null)
    return { recommendedLabel: null, stored, ratio: null, warning: null };
  // Gerechnet mit der gezeigten Schrift (#FFFFFF bzw. #222628, E1). Auf
  // mittleren Kundenfarben erreicht auch die Empfehlung 4,5:1 nicht; dann
  // hilft nur eine hellere oder dunklere Kundenfarbe.
  const shown = userTextColor(config);
  const recommended = recommendedTextColor(accent);
  const ratio = contrastRatio(accent, shown);
  let warning = null;
  if (ratio !== null && ratio < MIN_TEXT_CONTRAST)
    warning =
      shown === recommended
        ? `Kontrast nur ${contrastLabel(ratio)}: Weder Weiß noch Schwarz erreicht auf dieser Kundenfarbe 4,5:1. Eine hellere oder dunklere Kundenfarbe ist besser lesbar.`
        : `Kontrast nur ${contrastLabel(ratio)}: Unter 4,5:1 ist die Schrift auf der Kundenfarbe schwer lesbar.`;
  return {
    recommendedLabel: optionFor(recommended).label,
    stored,
    ratio,
    warning,
  };
}

/**
 * Schrift der Pillen (Startvorschläge in der Vorschau, wie die Folgefragen
 * im Widget, theme.js pillTextColor): die Kundenfarbe, wenn sie auf allen
 * Flächen mindestens 4,5:1 erreicht, sonst abgedunkelt (helle Fläche) bzw.
 * aufgehellt (dunkle Fläche). Nicht auswertbare Kundenfarbe: fallback.
 * @param {string} accent Kundenfarbe
 * @param {string[]} backgrounds Flächen
 * @param {string} fallback
 * @returns {string}
 */
export function pillTextColor(accent, backgrounds, fallback = accent) {
  return accessibleTextColor(accent, backgrounds) || fallback;
}

// Eingeklappte Inline-Leiste (Entscheidung D2): Demo-Texte des Widgets
// (PANEL_TEXTS.de inlineBarPlaceholder/inlineSendText), nicht der Platzhalter
// des Chat-Eingabefelds. Ohne geladene Standardtexte diese deutschen Werte.
const INLINE_BAR_PLACEHOLDER = "Stellen Sie hier Ihre Frage …";
const INLINE_SEND_TEXT = "Chatten";

// Frühere Vorbelegungen (wie LEGACY_DEFAULT_GREETINGS/-PLACEHOLDERS im
// Server): so gespeicherte Texte gelten als „kein eigener Text“, das Feld
// zeigt den neuen Standard. Der alte Wert bleibt gespeichert, bis der Kunde
// das Feld ändert.
export const LEGACY_DEFAULT_GREETINGS = [
  "Dieser Chatbot nutzt künstliche Intelligenz (KI). Ihre Nachrichten werden nicht an Dritte weitergegeben, können aber zur Qualitätssicherung von uns eingesehen werden. Bitte geben Sie keine sensiblen personenbezogenen Daten ein.",
  "Hallo und herzlich willkommen! Ich helfe Ihnen gerne weiter und beantworte Ihre Fragen mit intelligenten, KI-gestützten Antworten.",
  "Hallo! Ich bin Ihr digitaler Berater mit künstlicher Intelligenz (KI). Beschreiben Sie einfach, was Sie suchen.",
  "Hello! I am your digital advisor powered by artificial intelligence (AI). Just describe what you are looking for.",
];
export const LEGACY_DEFAULT_PLACEHOLDERS = ["Wie kann ich Ihnen helfen?"];
export const LEGACY_DEFAULT_PRIVACY_TITLES = ["Datenschutz:", "Privacy:"];

export const GREETING_MAX_LEN = 300;
// Gekürzte Begrüßung: bis zu diesem Zeichen auf ein Wortende, davor hart
const GREETING_WORD_CUT_MIN = 200;
export const SUBTITLE_MAX_LEN = 60;
export const PLACEHOLDER_MAX_LEN = 120;
export const PRIVACY_TITLE_MAX_LEN = 120;
export const PRIVACY_TEXT_MAX_LEN = 1000;
export const PRIVACY_LINES_MAX = 12;
export const PRIVACY_LINE_MAX_LEN = 500;
export const URL_MAX_LEN = 512;
const PRIVACY_MARK_RE = /^[•\-–]\s*/;

// Nur Strings zählen als Text; alles andere (Zahl, Objekt, Liste aus einer
// per API gesetzten visual_config) wird wie ein leeres Feld behandelt.
export function textValue(value) {
  return typeof value === "string" ? value : "";
}

export function isBlank(value) {
  return textValue(value).trim() === "";
}

/**
 * Eigener Text: String, getrimmt nicht leer und keine frühere Vorbelegung.
 * @param {*} value
 * @param {string[]} [legacy]
 * @returns {string|null}
 */
export function ownText(value, legacy = []) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || legacy.includes(text)) return null;
  return text;
}

/** @returns {"inline"|"bubble"} wirksame Darstellung wie im Server */
export function displayMode(config = {}) {
  return typeof config.displayMode === "string" &&
    config.displayMode.trim().toLowerCase() === "inline"
    ? "inline"
    : "bubble";
}

/**
 * Farbschema für die Auswahl: "light"/"dark"; ein älteres "auto" (folgt dem
 * Gerät) bleibt gespeichert, bis Hell oder Dunkel gewählt wird (null = keine
 * Option aktiv).
 * @returns {"light"|"dark"|null}
 */
export function themeChoice(config = {}) {
  const theme = textValue(config.theme).trim().toLowerCase();
  if (theme === "dark") return "dark";
  if (theme === "auto") return null;
  return "light";
}

// ---------------------------------------------------------------------------
// Begrüßung: ein Feld „Begrüßungstext“ (die Begrüßung ist immer die Blase).
// Früher gab es zusätzlich den „Text der Begrüßungsblase“
// (greetingBubbleText). Wie im Server (embedStandards.js effectiveGreeting)
// hat ein gespeicherter Blasentext Vorrang, wenn er bisher sichtbar in der
// Blase stand (greetingStyle oder privacyNotice "bubble") oder es keine
// eigene Begrüßung gibt (Review 7.22-rc6 F03). Bearbeitet wird der
// Schlüssel, der gerade gilt (aus dem gespeicherten Stand bestimmt).
// ---------------------------------------------------------------------------

// Wie greetingBubbleTextShown() im Server
function greetingBubbleTextShown(stored = {}) {
  const isBubble = (v) =>
    typeof v === "string" && v.trim().toLowerCase() === "bubble";
  return isBubble(stored.greetingStyle) || isBubble(stored.privacyNotice);
}

/**
 * Schlüssel, in den das Feld „Begrüßungstext“ schreibt.
 * @param {Object} stored gespeicherte visual_config (beim Laden)
 * @returns {"greetingBubbleText"|"greeting"}
 */
export function greetingKey(stored = {}) {
  const bubble = ownText(stored.greetingBubbleText, LEGACY_DEFAULT_GREETINGS);
  const greeting = ownText(stored.greeting, LEGACY_DEFAULT_GREETINGS);
  return bubble && (!greeting || greetingBubbleTextShown(stored))
    ? "greetingBubbleText"
    : "greeting";
}

/**
 * Wert im Feld: eigener Text bzw. "" beim Leeren; frühere Vorbelegung oder
 * fehlender Wert zeigen den Standardtext.
 */
export function greetingFieldValue(config, key, defaults) {
  const v = config[key];
  if (typeof v === "string" && !LEGACY_DEFAULT_GREETINGS.includes(v.trim()))
    return v;
  return textValue(defaults?.greeting);
}

/**
 * Text in der Begrüßungsblase des Widgets: eine Begrüßung über 300 Zeichen
 * (alter Wert ohne Grenze) erscheint auf ein Wortende gekürzt mit „…“.
 * Wörtlich wie shortenGreeting() im Widget (anythingllm-embed
 * src/utils/layout.js): Seit Review 7.22-rc6 F08 kürzt allein das Widget,
 * der Server liefert die Begrüßung ungekürzt. Gegenprobe mit
 * KUFER_EMBED_DIR im Test designCenterStandardLogic.
 * @param {string} text getrimmter Text
 * @returns {string}
 */
export function bubbleGreetingText(text) {
  if (text.length <= GREETING_MAX_LEN) return text;
  let cut = text.slice(0, GREETING_MAX_LEN - 1);
  const space = cut.search(/\s\S*$/);
  if (space >= GREETING_WORD_CUT_MIN) cut = cut.slice(0, space);
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return `${cut.replace(/[\s.,;:!?]+$/u, "")}…`;
}

/** Text der Begrüßungsblase in der Vorschau (leer = Standardtext). */
export function previewGreeting(config, key, defaults) {
  return bubbleGreetingText(
    greetingFieldValue(config, key, defaults).trim() ||
      textValue(defaults?.greeting)
  );
}

/**
 * Wert im Feld „Platzhalter“ (Chat-Eingabefeld, Entscheidung D2): eigener
 * Text, sonst "" (Standard grau).
 */
export function placeholderFieldValue(config = {}) {
  const v = config.sendMessageText;
  return typeof v === "string" &&
    !LEGACY_DEFAULT_PLACEHOLDERS.includes(v.trim())
    ? v
    : "";
}

/** Platzhalter in der Vorschau: eigener Text, sonst Standardtext. */
export function previewPlaceholder(config, defaults) {
  return (
    ownText(config.sendMessageText, LEGACY_DEFAULT_PLACEHOLDERS) ||
    textValue(defaults?.sendMessageText) ||
    "Ihre Frage eingeben"
  );
}

/**
 * Früher im alten Design Center eigens gespeicherter Text der Inline-
 * Leiste (inlineInputPlaceholder, höchstens 120 Zeichen): bleibt wirksam
 * (Review F04), sonst null. Wie inlineBarPlaceholder() im Server.
 * @param {Object} config
 * @returns {string|null}
 */
export function storedInlineBarPlaceholder(config = {}) {
  const text = ownText(config.inlineInputPlaceholder);
  return text && text.length <= PLACEHOLDER_MAX_LEN ? text : null;
}

/**
 * Platzhalter und Button der eingeklappten Inline-Leiste in der Vorschau:
 * gespeicherter Leistentext bzw. die Demo-Texte (Entscheidung D2).
 * @returns {{placeholder: string, sendText: string}}
 */
export function previewInlineBar(config, defaults) {
  return {
    placeholder:
      storedInlineBarPlaceholder(config) ||
      textValue(defaults?.inlineInputPlaceholder) ||
      INLINE_BAR_PLACEHOLDER,
    sendText: textValue(defaults?.inlineSendText) || INLINE_SEND_TEXT,
  };
}

/**
 * Wert im Feld „Überschrift“ des Datenschutz-Hinweises: eigener Text, ""
 * (bewusst keine Überschrift) bzw. der Standard, wenn nichts oder der
 * frühere Standard mit Doppelpunkt gespeichert ist.
 */
export function privacyTitleFieldValue(config, defaults) {
  const v = config.privacyTitle;
  if (
    typeof v === "string" &&
    !LEGACY_DEFAULT_PRIVACY_TITLES.includes(v.trim())
  )
    return v;
  return textValue(defaults?.privacyTitle);
}

// ---------------------------------------------------------------------------
// Datenschutz-Hinweis an/aus (KIE-565 Nachtrag, Nutzer 15.10.2026): Schalter
// „Datenschutz-Hinweis anzeigen“, gespeichert im vorhandenen Schlüssel
// privacyNotice. Aus = "none"; an = "bubble" bzw. jeder andere oder kein
// Wert (wie privacyNoticeValue() im Server, auch das frühere "modal"). Ein
// leerer Text bedeutet weiter „Standardtext“, nicht „aus“.
// ---------------------------------------------------------------------------

// Felder des Hinweises; bei ausgeschaltetem Hinweis bleiben sie gespeichert,
// wie sie sind
export const PRIVACY_FIELD_KEYS = ["privacyTitle", "privacyText", "privacyUrl"];

/** @returns {boolean} Datenschutz-Hinweis wird angezeigt */
export function privacyNoticeOn(config = {}) {
  const v = config?.privacyNotice;
  return !(typeof v === "string" && v.trim().toLowerCase() === "none");
}

/**
 * Bearbeitungsstand nach dem Schalter: aus -> "none". An -> der gespeicherte
 * Stand, wenn der Hinweis dort an war (auch ohne Schlüssel oder mit einem
 * Altwert wie "modal"; so entsteht kein ungefragter Schreibvorgang, Regel
 * D6), sonst "bubble".
 * @param {Object} config Bearbeitungsstand
 * @param {Object} initial gespeicherter Stand
 * @param {boolean} on
 * @returns {Object}
 */
export function withPrivacyNotice(config, initial = {}, on = true) {
  const next = { ...config };
  if (!on) next.privacyNotice = "none";
  else if (!privacyNoticeOn(initial)) next.privacyNotice = "bubble";
  else if ("privacyNotice" in initial)
    next.privacyNotice = initial.privacyNotice;
  else delete next.privacyNotice;
  return next;
}

// ---------------------------------------------------------------------------
// Datenschutz-Text, freies Format, genau wie im Widget (utils/layout.js
// parsePrivacyText) und im Server (normalizePrivacyText): Zeilen mit „•“,
// „-“ oder „–“ am Anfang sind Aufzählungspunkte, andere Zeilen Absätze.
// Altformat (keine Zeile mit Zeichen, so bis 7.21 gespeichert): Zeilen bzw.
// „|“-Teile, mehrere als Punkte, eine einzelne als Absatz. Gespeichert wird
// immer im neuen Format (Review F10): Altformat mit mehreren Teilen als
// „• “-Zeilen, damit die Bedeutung beim nächsten Lesen gleich bleibt (F08).
// ---------------------------------------------------------------------------

function cleanLines(parts) {
  return parts.map((l) => l.trim()).filter((l) => l.length > 0);
}

function privacyLines(text) {
  const lines = cleanLines(text.split(/\r?\n/));
  if (lines.some((l) => PRIVACY_MARK_RE.test(l)))
    return { marked: true, lines };
  return { marked: false, lines: cleanLines(text.split(/\r?\n|\|/)) };
}

/**
 * Altformat mit mehreren Teilen (keine Zeile mit „•“, „-“ oder „–“, aber
 * mehrere Zeilen bzw. „|“-Teile): Das Widget zeigt alle als Punkte. Dieselbe
 * Regel wie der Parser (getrimmte Zeilen, auch NBSP vor dem Zeichen; Review
 * F09).
 * @param {*} value
 * @returns {boolean}
 */
export function privacyWithoutMarks(value) {
  if (typeof value !== "string") return false;
  const { marked, lines } = privacyLines(value);
  return !marked && lines.length > 1;
}

/**
 * Text für das Feld: Altformat mit mehreren Zeilen als „• “-Zeilen (gleiche
 * Darstellung wie im Widget), sonst unverändert.
 * @param {*} value
 * @returns {string}
 */
export function privacyFieldText(value) {
  const text = textValue(value);
  if (!text.trim()) return text;
  const { marked, lines } = privacyLines(text);
  if (marked || lines.length < 2) return text;
  return lines.map((l) => `• ${l}`).join("\n");
}

/**
 * Normalform wie normalizePrivacyText() im Server: getrimmte Zeilen, leere
 * weg, Altformat auch an „|“ getrennt und bei mehreren Teilen als „• “-
 * Zeilen; 1 bis 12 Zeilen mit je höchstens 500 Zeichen, Rohtext und
 * Normalform höchstens 1000 (Review 7.22-rc6 F05). Ungültig -> null.
 * @param {*} value
 * @returns {string|null}
 */
export function normalizePrivacyText(value) {
  const text = textValue(value).trim();
  if (!text || text.length > PRIVACY_TEXT_MAX_LEN) return null;
  const { marked, lines } = privacyLines(text);
  if (
    lines.length === 0 ||
    lines.length > PRIVACY_LINES_MAX ||
    lines.some((l) => l.length > PRIVACY_LINE_MAX_LEN)
  )
    return null;
  const normalized = (
    !marked && lines.length > 1 ? lines.map((l) => `• ${l}`) : lines
  ).join("\n");
  return normalized.length <= PRIVACY_TEXT_MAX_LEN ? normalized : null;
}

/**
 * Fehlermeldung zum Datenschutz-Text oder null. Leer ist kein Fehler (es
 * gilt der Standardtext).
 * @param {*} value
 * @returns {string|null}
 */
export function privacyTextError(value) {
  const text = textValue(value).trim();
  if (!text) return null;
  if (text.length > PRIVACY_TEXT_MAX_LEN)
    return `Maximal ${PRIVACY_TEXT_MAX_LEN} Zeichen insgesamt.`;
  const { lines } = privacyLines(text);
  if (lines.length > PRIVACY_LINES_MAX)
    return `Höchstens ${PRIVACY_LINES_MAX} Zeilen.`;
  const tooLong = lines.findIndex((l) => l.length > PRIVACY_LINE_MAX_LEN);
  if (tooLong >= 0)
    return `Zeile ${tooLong + 1} ist zu lang (maximal ${PRIVACY_LINE_MAX_LEN} Zeichen je Zeile).`;
  // gespeichert wird mit „• “ vor jeder Zeile (Altformat), auch das zählt
  if (normalizePrivacyText(text) === null)
    return `Maximal ${PRIVACY_TEXT_MAX_LEN} Zeichen insgesamt, mit den Zeichen „• “ am Zeilenanfang.`;
  return null;
}

/**
 * Datenschutz-Text in Blöcke wie parsePrivacyText() im Widget.
 * @param {*} text
 * @returns {{type: "bullet"|"paragraph", text: string}[]}
 */
export function privacyBlocks(text) {
  if (typeof text !== "string") return [];
  const { marked, lines } = privacyLines(text);
  if (lines.length === 0) return [];
  if (!marked)
    return lines.length === 1
      ? [{ type: "paragraph", text: lines[0] }]
      : lines.map((t) => ({ type: "bullet", text: t }));
  return lines
    .map((l) =>
      PRIVACY_MARK_RE.test(l)
        ? { type: "bullet", text: l.replace(PRIVACY_MARK_RE, "").trim() }
        : { type: "paragraph", text: l }
    )
    .filter((block) => block.text.length > 0);
}

// Link wie validUrl() im Server: https://… oder Pfad der eigenen Seite
// ("/…", nicht "//…"), ohne Leer-/Steuerzeichen und Backslash
export function validPrivacyUrl(value) {
  if (typeof value !== "string") return false;
  const v = value.trim();
  // eslint-disable-next-line no-control-regex
  if (!v || v.length > URL_MAX_LEN || /[\s\u0000-\u001f\u007f\\]/.test(v))
    return false;
  if (/^\/(?![/\\])/.test(v)) return true;
  try {
    return new URL(v).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Entspricht der Text dem Standard? Ohne geladene Standardtexte nie (damit
 * ein eigener Text beim Speichern nicht versehentlich verloren geht).
 * @param {"greeting"|"privacyTitle"|"privacyText"} defaultKey
 * @param {*} value
 * @param {Object|null} defaults
 * @returns {boolean}
 */
export function sameAsDefault(defaultKey, value, defaults) {
  const standard = defaults?.[defaultKey];
  if (typeof standard !== "string" || typeof value !== "string") return false;
  if (defaultKey === "privacyText") {
    if (normalizePrivacyText(value) === null) return false;
    return (
      JSON.stringify(privacyBlocks(value)) ===
      JSON.stringify(privacyBlocks(standard))
    );
  }
  return value.trim() === standard.trim();
}

/**
 * Wurde das Feld gegenüber dem gespeicherten Stand geändert?
 */
function changed(config, initial, key) {
  return config[key] !== initial[key];
}

// Reiter, in dem ein Feld steht (für „Fehler korrigieren“ beim Speichern)
export const FIELD_TAB = {
  accentColor: "aussehen",
  assistantSubtitle: "inhalt",
  greeting: "inhalt",
  greetingBubbleText: "inhalt",
  sendMessageText: "inhalt",
  privacyTitle: "inhalt",
  privacyText: "inhalt",
  privacyUrl: "inhalt",
};

/**
 * Fehlermeldungen je Feld. Texte mit Grenzen, die schon gespeichert waren
 * (z. B. eine lange Begrüßung von früher), blockieren das Speichern erst,
 * wenn sie geändert werden.
 * @param {Object} config Bearbeitungsstand
 * @param {Object} initial gespeicherter Stand
 * @param {"greeting"|"greetingBubbleText"} gKey Schlüssel der Begrüßung
 * @returns {Object<string,string>}
 */
export function validateConfig(config, initial, gKey) {
  const errors = {};
  // Kundenfarbe: nur ein geänderter Wert wird geprüft (ein früher
  // gespeicherter Farbname bleibt speicherbar)
  if (changed(config, initial, "accentColor")) {
    const error = accentColorError(config.accentColor);
    if (error) errors.accentColor = error;
  }
  if (textValue(config.assistantSubtitle).trim().length > SUBTITLE_MAX_LEN)
    errors.assistantSubtitle = `Maximal ${SUBTITLE_MAX_LEN} Zeichen.`;
  if (
    changed(config, initial, gKey) &&
    textValue(config[gKey]).trim().length > GREETING_MAX_LEN
  )
    errors[gKey] = `Maximal ${GREETING_MAX_LEN} Zeichen.`;
  if (
    changed(config, initial, "sendMessageText") &&
    textValue(config.sendMessageText).trim().length > PLACEHOLDER_MAX_LEN
  )
    errors.sendMessageText = `Maximal ${PLACEHOLDER_MAX_LEN} Zeichen.`;
  // Hinweis aus: die ausgegrauten Felder werden nicht gespeichert und
  // deshalb auch nicht geprüft
  if (!privacyNoticeOn(config)) return errors;
  if (textValue(config.privacyTitle).trim().length > PRIVACY_TITLE_MAX_LEN)
    errors.privacyTitle = `Maximal ${PRIVACY_TITLE_MAX_LEN} Zeichen.`;
  if (changed(config, initial, "privacyText")) {
    const error = privacyTextError(config.privacyText);
    if (error) errors.privacyText = error;
  }
  if (!isBlank(config.privacyUrl) && !validPrivacyUrl(config.privacyUrl))
    errors.privacyUrl =
      "Bitte eine https://-Adresse oder einen Pfad Ihrer Seite (z. B. /datenschutz) angeben.";
  return errors;
}

/**
 * Vor dem Speichern: nur die bearbeitbaren Felder bereinigen. Schlüssel
 * entfallener Optionen bleiben, wie sie gespeichert sind; es werden keine
 * neuen Darstellungs-Schlüssel geschrieben.
 * - Begrüßung: leer oder Standardtext -> Schlüssel entfernen, dazu den
 *   anderen eigenen Text (greeting bzw. greetingBubbleText), sonst würde
 *   er sichtbar; unveränderte frühere Vorbelegung bleibt stehen.
 * - Platzhalter: leer -> entfernen (Standard), frühere Vorbelegung bleibt.
 * - Untertitel, Link: leer -> entfernen; Untertitel getrimmt.
 * - Datenschutz-Überschrift: Standard -> entfernen, leer -> "" (bewusst
 *   keine Überschrift), sonst getrimmt.
 * - Datenschutz-Text: unverändert bleibt er, wie er ist; geändert: leer oder
 *   Standard -> entfernen, sonst Normalform.
 * - Datenschutz-Hinweis aus (privacyNotice "none"): Überschrift, Text und
 *   Link bleiben genau wie gespeichert (Eingaben in den ausgegrauten Feldern
 *   werden nicht geschrieben).
 * @param {Object} config
 * @param {{initial: Object, defaults: Object|null, greetingKey: string}} opts
 * @returns {Object}
 */
export function cleanConfig(
  config,
  { initial = {}, defaults = null, greetingKey: gKey = "greeting" } = {}
) {
  const out = { ...config };
  const drop = (key) => delete out[key];

  if (typeof out[gKey] === "string") {
    const v = out[gKey].trim();
    if (!LEGACY_DEFAULT_GREETINGS.includes(v)) {
      if (!v || sameAsDefault("greeting", v, defaults)) {
        // Standard: auch den anderen eigenen Text entfernen, sonst würde er
        // sichtbar (früherer Blasentext bei Stil „text“ bzw. eine eigene
        // greeting hinter dem Blasentext)
        const other =
          gKey === "greetingBubbleText" ? "greeting" : "greetingBubbleText";
        drop(gKey);
        if (ownText(out[other], LEGACY_DEFAULT_GREETINGS)) drop(other);
      } else out[gKey] = v;
    }
  }

  if (typeof out.sendMessageText === "string") {
    const v = out.sendMessageText.trim();
    if (!LEGACY_DEFAULT_PLACEHOLDERS.includes(v)) {
      if (!v) drop("sendMessageText");
      else out.sendMessageText = v;
    }
  }

  if ("assistantSubtitle" in out) {
    const v = textValue(out.assistantSubtitle).trim();
    if (!v) drop("assistantSubtitle");
    else out.assistantSubtitle = v;
  }

  if (!privacyNoticeOn(out)) {
    for (const key of PRIVACY_FIELD_KEYS) {
      if (key in initial) out[key] = initial[key];
      else drop(key);
    }
    return out;
  }

  if (typeof out.privacyTitle === "string") {
    const v = out.privacyTitle.trim();
    if (sameAsDefault("privacyTitle", v, defaults)) drop("privacyTitle");
    else out.privacyTitle = v;
  }

  if ("privacyText" in out && changed(out, initial, "privacyText")) {
    const v = textValue(out.privacyText);
    const normalized = normalizePrivacyText(v);
    if (
      !v.trim() ||
      normalized === null ||
      sameAsDefault("privacyText", v, defaults)
    )
      drop("privacyText");
    else out.privacyText = normalized;
  }

  if ("privacyUrl" in out) {
    if (validPrivacyUrl(out.privacyUrl)) out.privacyUrl = out.privacyUrl.trim();
    else drop("privacyUrl");
  }
  return out;
}

// Pillen der Vorschau: über 60 Zeichen auf 59 gekürzt mit „…“, ohne ein
// Emoji (Ersatzpaar) zu zerschneiden (Review 7.22-rc6 F07)
export const PILL_MAX_LEN = 60;
export function pillLabel(text) {
  if (text.length <= PILL_MAX_LEN) return text;
  let cut = text.slice(0, PILL_MAX_LEN - 1);
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return `${cut.trimEnd()}…`;
}

// Listen (Startvorschläge, Willkommensblasen) für die Vorschau: nur
// nicht-leere Strings
export function textItems(list) {
  return Array.isArray(list)
    ? list.filter((m) => typeof m === "string" && m.trim())
    : [];
}
