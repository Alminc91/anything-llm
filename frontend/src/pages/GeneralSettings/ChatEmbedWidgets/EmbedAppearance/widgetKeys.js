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
  { value: "#222628", label: "Schwarz" },
];

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
// buttonColor, userTextColor, chatIcon, position). Das Design Center zeigt
// sie an, speichert sie aber nur, wenn der Kunde etwas wählt.
export const LOOK_DEFAULTS = {
  accentColor: "#01A5A9",
  userTextColor: "#FFFFFF",
  chatIcon: "chatBubble",
  position: "bottom-left",
};
export const DEFAULT_ACCENT_COLOR = LOOK_DEFAULTS.accentColor;

/**
 * Wert fürs Aussehen: gespeicherter Text bzw. Standard des Widgets.
 * @param {Object} config
 * @param {"accentColor"|"userTextColor"|"chatIcon"|"position"} key
 * @returns {string}
 */
export function lookValue(config, key) {
  const v = config?.[key];
  return typeof v === "string" && v.trim() ? v : LOOK_DEFAULTS[key];
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
// (greetingBubbleText). Wie im Server hat ein gespeicherter Blasentext
// Vorrang: Er stand bisher in der Blase. Bearbeitet wird deshalb der
// Schlüssel, der gerade gilt (aus dem gespeicherten Stand bestimmt).
// ---------------------------------------------------------------------------

/**
 * Schlüssel, in den das Feld „Begrüßungstext“ schreibt.
 * @param {Object} stored gespeicherte visual_config (beim Laden)
 * @returns {"greetingBubbleText"|"greeting"}
 */
export function greetingKey(stored = {}) {
  return ownText(stored.greetingBubbleText, LEGACY_DEFAULT_GREETINGS)
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
 * Wörtlich wie greetingBubbleText() im Server (embedStandards.js).
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
 * Platzhalter und Knopf der eingeklappten Inline-Leiste in der Vorschau:
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
 * Zeilen; 1 bis 12 Zeilen mit je höchstens 500 Zeichen, Rohtext höchstens
 * 1000. Ungültig -> null.
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
  return (
    !marked && lines.length > 1 ? lines.map((l) => `• ${l}`) : lines
  ).join("\n");
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
 * - Begrüßung: leer oder Standardtext -> Schlüssel entfernen (beim früheren
 *   Blasentext auch eine eigene greeting, sonst würde sie sichtbar);
 *   unveränderte frühere Vorbelegung bleibt stehen.
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
        drop(gKey);
        if (
          gKey === "greetingBubbleText" &&
          ownText(out.greeting, LEGACY_DEFAULT_GREETINGS)
        )
          drop("greeting");
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

// Listen (Startvorschläge, Willkommensblasen) für die Vorschau: nur
// nicht-leere Strings
export function textItems(list) {
  return Array.isArray(list)
    ? list.filter((m) => typeof m === "string" && m.trim())
    : [];
}
