// Kufer Design Center vereinfacht (15./16.10.2026): feste Standards des
// Embed-Widgets. Die früheren Wahlmöglichkeiten (Begrüßung als Text,
// Vorschläge als Balken, Folgefragen aus, Datenschutz als Karte, KI-Hinweis
// vom Modell, Online-Punkt, Kartenstil/-position/-layout, Inline-Optionen,
// Fenstergröße und Randabstände) entfallen. Gespeicherte Altwerte bleiben in
// visual_config stehen, werden aber beim Ausliefern (GET /embed/:id/config)
// und beim Prompt pro Embed (utils/chats/embed.js) ignoriert bzw. durch den
// Standard ersetzt. Das Widget erzwingt dieselben Werte zusätzlich selbst
// (auch ohne Server-Wert, z. B. bei alten Script-Attributen).
//
// Eine Quelle für beide Wege: applyEmbedStandards (Konfiguration ans
// Widget) und courseCardsForDisplayMode (Karten an/aus, Prompt-Abschnitt).
// Was überhaupt ans Widget geht, bestimmt allein die Erlaubtliste im
// Endpunkt (endpoints/embed/index.js); applyEmbedStandards setzt nur die
// abgeleiteten Texte und die festen Werte dazu.

// Kurskarten in der Chatblase: an (Entscheidung D1, Fixliste 7.22-rc3,
// 15.10.2026). Beleg aus der Browser-Abnahme 7.22-rc2 (Opus K-1, Sonnet A9
// und B-B4): Inline-Widget ohne Platzhalter, also Rückfall auf die
// Chatblase; 4 bzw. 2 Karten am Desktop und 2 mobil, einspaltig (266 bzw.
// 296 px), ohne Überlauf, hell und dunkel gut lesbar, danach kurzer Text und
// Folgefragen. Mit "off" hatte die Antwort in der Chatblase weder Karten
// noch Links (Sonnet A4-links). Damit sind die Karten unabhängig von der
// gespeicherten Darstellung an: Ein Inline-Einbau nur per Script-Attribut
// (ohne gespeichertes displayMode) und ein Inline-Widget, das auf einer
// Seite ohne Platzhalter als Chatblase erscheint, bekommen dieselben Karten
// und denselben Prompt (Review F01, F02). Wer hier wieder "off" setzt, muss
// das Widget seine tatsächliche Darstellung an stream-chat melden lassen.
const BUBBLE_COURSE_CARDS = "auto";

// Feste Standards für beide Darstellungen. Karten wie Demo-Variante 4
// („Suche“, chatbot-v4): Karten zuerst, danach der kurze Chatbot-Text.
const EMBED_FIXED_STANDARDS = Object.freeze({
  greetingStyle: "bubble",
  suggestionStyle: "pills",
  followUps: "pills",
  privacyNotice: "bubble",
  disclaimer: "footer",
  onlineDot: false,
  courseCardsAnswerStyle: "short",
  courseCardsLayout: "rows",
  courseCardsPosition: "above",
});

// Inline fest wie die Demo-Seite (/var/docker/demo/site/app.js,
// loadWidgetScript): data-inline-start-state "collapsed", data-inline-height
// "520px", data-inline-layout "overlay", data-inline-effect "morph",
// data-inherit-font "true", data-inline-input "true", data-inline-open-on
// "focus" (Standard der Topbar). Keine Max. Breite (Demo setzt keine: volle
// Breite des Platzhalters). Diese Schlüssel wirken nur im Inline-Modus und
// gehen deshalb an jedes Widget (auch an Chatblasen, deren Seite den Inline-
// Modus noch per Script-Attribut verlangt).
const INLINE_FIXED_STANDARDS = Object.freeze({
  inlineInput: true,
  inlineOpenOn: "focus",
  inlineEffect: "morph",
  inlineLayout: "overlay",
  inlineStartState: "collapsed",
  inlineHeight: "520px",
  inheritFont: true,
});

// Frühere Vorbelegungen des Design Centers bzw. frühere Widget-Standards:
// ein so gespeicherter Text gilt als „kein eigener Text“, damit diese
// Widgets den neuen Standard zeigen (der alte Text bleibt gespeichert).
// - Begrüßung: DEFAULT_CONFIG.greeting des Design Centers bis 7.21 (beim
//   ersten Speichern mitgeschrieben) und die frühere Standard-Begrüßungsblase
//   des Widgets (de/en, „einfach“ wirkte zu locker).
// - Platzhalter: DEFAULT_CONFIG.sendMessageText bis 7.21; er wiederholte die
//   Frage der neuen Begrüßung („Wie kann ich Ihnen helfen?“).
const LEGACY_DEFAULT_GREETINGS = Object.freeze([
  // früherer Widget-Standard von greeting (Datenschutzsatz, steht jetzt in
  // der eigenen Datenschutz-Blase)
  "Dieser Chatbot nutzt künstliche Intelligenz (KI). Ihre Nachrichten werden nicht an Dritte weitergegeben, können aber zur Qualitätssicherung von uns eingesehen werden. Bitte geben Sie keine sensiblen personenbezogenen Daten ein.",
  "Hallo und herzlich willkommen! Ich helfe Ihnen gerne weiter und beantworte Ihre Fragen mit intelligenten, KI-gestützten Antworten.",
  "Hallo! Ich bin Ihr digitaler Berater mit künstlicher Intelligenz (KI). Beschreiben Sie einfach, was Sie suchen.",
  "Hello! I am your digital advisor powered by artificial intelligence (AI). Just describe what you are looking for.",
]);
const LEGACY_DEFAULT_PLACEHOLDERS = Object.freeze([
  "Wie kann ich Ihnen helfen?",
]);
// Datenschutz-Überschrift: früherer Standard mit Doppelpunkt (de/en)
const LEGACY_DEFAULT_PRIVACY_TITLES = Object.freeze([
  "Datenschutz:",
  "Privacy:",
]);

// Höchstlängen wie im Widget (utils/layout.js)
const GREETING_BUBBLE_TEXT_MAX_LEN = 300;
// Gekürzte Begrüßung: bis zu diesem Zeichen wird auf ein Wortende gekürzt,
// davor hart (sehr lange Wörter)
const GREETING_WORD_CUT_MIN = 200;
const INLINE_TEXT_MAX_LEN = 120;
const PRIVACY_TITLE_MAX_LEN = 120;

// Datenschutz-Text (privacyText), freies Format wie parsePrivacyText() im
// Widget (utils/layout.js): Zeilen mit „•“, „-“ oder „–“ am Anfang sind
// Aufzählungspunkte, andere Zeilen Absätze. Altformat (keine Zeile mit
// Zeichen, so bisher gespeichert): Zeilen bzw. „|“-Teile; mehrere sind wie
// bisher Punkte, eine einzelne ein Absatz.
const PRIVACY_TEXT_MAX_LEN = 1000;
const PRIVACY_LINES_MAX = 12;
const PRIVACY_LINE_MAX_LEN = 500;
const PRIVACY_MARK_RE = /^[•\-–]\s*/;
const PRIVACY_BULLET_PREFIX = "• ";

/**
 * Wirksame Darstellung eines Embeds: "inline" nur bei gespeichertem
 * displayMode "inline" (Groß-/Kleinschreibung und Leerraum egal), sonst
 * "bubble" (Standard, auch ohne Wert).
 * @param {*} displayMode
 * @returns {"inline"|"bubble"}
 */
function embedDisplayMode(displayMode) {
  return typeof displayMode === "string" &&
    displayMode.trim().toLowerCase() === "inline"
    ? "inline"
    : "bubble";
}

/**
 * Kurskarten für eine Darstellung: Inline immer "auto" (Demo-Standard),
 * Chatblase BUBBLE_COURSE_CARDS.
 * @param {*} displayMode gespeicherter visual_config.displayMode
 * @returns {"auto"|"off"}
 */
function courseCardsForDisplayMode(displayMode) {
  return embedDisplayMode(displayMode) === "inline"
    ? "auto"
    : BUBBLE_COURSE_CARDS;
}

// Eigener Text: String, getrimmt nicht leer und keine frühere Vorbelegung
function ownText(value, legacy = []) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (text.length === 0 || legacy.includes(text)) return null;
  return text;
}

/**
 * Begrüßungstext (Begrüßungsblase). Der frühere „Text der Begrüßungsblase“
 * (greetingBubbleText) hat Vorrang vor greeting: Er stand bei Widgets mit
 * neuer Optik in der Blase, greeting nur als kleine Zeile darunter bzw. gar
 * nicht (Datenschutz in der Blase). So bleibt der Text, den Besucher bisher
 * in der Blase sahen. Frühere Vorbelegungen zählen nicht (-> null = Standard).
 * @param {Object} visualConfig
 * @returns {string|null}
 */
function effectiveGreeting(visualConfig = {}) {
  return (
    ownText(visualConfig?.greetingBubbleText, LEGACY_DEFAULT_GREETINGS) ??
    ownText(visualConfig?.greeting, LEGACY_DEFAULT_GREETINGS)
  );
}

/**
 * Platzhalter im Eingabefeld des Chats (Chatblase und aufgeklappte Inline-
 * Box; Feld „Platzhalter“ im Design Center): sendMessageText, sonst null
 * (Standard des Widgets). Frühere Vorbelegung zählt nicht. Die eingeklappte
 * Inline-Leiste hat eigene Texte (inlineBarPlaceholder).
 * @param {Object} visualConfig
 * @returns {string|null}
 */
function effectivePlaceholder(visualConfig = {}) {
  return ownText(visualConfig?.sendMessageText, LEGACY_DEFAULT_PLACEHOLDERS);
}

/**
 * Platzhalter der eingeklappten Inline-Leiste (Entscheidung D2): Standard
 * ist der Demo-Text des Widgets („Stellen Sie hier Ihre Frage …“, je nach
 * Sprache), nicht der Platzhalter des Chat-Eingabefelds. Nur ein früher im
 * alten Design Center eigens gespeicherter Leistentext (inlineInputPlaceholder,
 * höchstens 120 Zeichen wie im Widget) bleibt wirksam; sonst null.
 * @param {Object} visualConfig
 * @returns {string|null}
 */
function inlineBarPlaceholder(visualConfig = {}) {
  const text = ownText(visualConfig?.inlineInputPlaceholder);
  return text && text.length <= INLINE_TEXT_MAX_LEN ? text : null;
}

/**
 * Text für die Begrüßungsblase (greetingBubbleText, im Widget höchstens 300
 * Zeichen): bis 300 Zeichen unverändert, länger (alte Begrüßung ohne
 * Längengrenze) auf ein Wortende gekürzt mit „…“. So gewinnt die Begrüßung
 * aus dem Design Center auch dann gegen ein data-greeting-bubble-text am
 * Skript. Wörtlich gleich previewGreetingBubble() im Design Center
 * (widgetKeys.js, ein Test vergleicht beide).
 * @param {string} text getrimmter Begrüßungstext
 * @returns {string}
 */
function greetingBubbleText(text) {
  if (text.length <= GREETING_BUBBLE_TEXT_MAX_LEN) return text;
  let cut = text.slice(0, GREETING_BUBBLE_TEXT_MAX_LEN - 1);
  const space = cut.search(/\s\S*$/);
  if (space >= GREETING_WORD_CUT_MIN) cut = cut.slice(0, space);
  // kein halbes Ersatzpaar (Emoji) am Ende
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return `${cut.replace(/[\s.,;:!?]+$/u, "")}…`;
}

/**
 * Datenschutz-Text prüfen und normalisieren wie privacyTextValue() im
 * Widget: Rohtext getrimmt, höchstens PRIVACY_TEXT_MAX_LEN Zeichen; Zeilen
 * getrimmt, leere verworfen; Altformat (keine Zeile mit „•“/„-“/„–“) auch
 * an „|“ getrennt; 1 bis PRIVACY_LINES_MAX Zeilen mit je höchstens
 * PRIVACY_LINE_MAX_LEN Zeichen. Rückgabe: Zeilen mit "\n" (Zeichen bleiben
 * stehen, das Widget macht daraus Punkte). Altformat mit mehreren Teilen
 * kommt als „• “-Zeilen zurück (Review F08): sonst würde ein Teil, der mit
 * „-“ beginnt („-10 % Rabatt“), beim nächsten Lesen zum einzigen Zeichen
 * und alle übrigen Teile zu Absätzen. Eine Normalform bleibt so beim
 * wiederholten Normalisieren gleich. Verletzt -> null (weglassen, nicht
 * kürzen; das Widget zeigt dann den Standardtext).
 * @param {*} value
 * @returns {string|null}
 */
function normalizePrivacyText(value) {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (raw.length === 0 || raw.length > PRIVACY_TEXT_MAX_LEN) return null;
  const clean = (parts) =>
    parts.map((l) => l.trim()).filter((l) => l.length > 0);
  let lines = clean(raw.split(/\r?\n/));
  const marked = lines.some((l) => PRIVACY_MARK_RE.test(l));
  if (!marked) lines = clean(raw.split(/\r?\n|\|/));
  if (
    lines.length === 0 ||
    lines.length > PRIVACY_LINES_MAX ||
    lines.some((l) => l.length > PRIVACY_LINE_MAX_LEN)
  )
    return null;
  if (!marked && lines.length > 1)
    lines = lines.map((l) => PRIVACY_BULLET_PREFIX + l);
  return lines.join("\n");
}

/**
 * Überschrift des Datenschutz-Hinweises: eigener Text (getrimmt, höchstens
 * 120 Zeichen) oder "" = bewusst keine Überschrift (im Design Center
 * geleert). undefined = nicht gesetzt/ungültig oder früherer Standard mit
 * Doppelpunkt (Widget-Standard „Datenschutz“).
 * @param {*} value
 * @returns {string|undefined}
 */
function privacyTitleValue(value) {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (LEGACY_DEFAULT_PRIVACY_TITLES.includes(text)) return undefined;
  return text.length <= PRIVACY_TITLE_MAX_LEN ? text : undefined;
}

/**
 * Feste Standards auf die (bereits validierte) Konfiguration für das Widget
 * anwenden: Begrüßung, Platzhalter, Leistentext und Datenschutz aus den
 * gespeicherten Texten setzen, feste Werte erzwingen. Was sonst ans Widget
 * geht, legt allein die Erlaubtliste des Endpunkts fest (`mapped`).
 * Verändert `mapped` nicht, gibt ein neues Objekt zurück.
 * @param {Object} mapped Antwort von /config vor den Standards
 * @param {Object} visualConfig gespeicherte visual_config (Rohwerte)
 * @returns {Object}
 */
function applyEmbedStandards(mapped = {}, visualConfig = {}) {
  const vc =
    visualConfig && typeof visualConfig === "object" ? visualConfig : {};
  const out = { ...mapped };

  const greeting = effectiveGreeting(vc);
  if (greeting) {
    out.greeting = greeting;
    // Das Widget liest die Blase zuerst aus greetingBubbleText (höchstens
    // 300 Zeichen); ohne diesen Wert gewänne ein data-greeting-bubble-text.
    out.greetingBubbleText = greetingBubbleText(greeting);
  }
  const placeholder = effectivePlaceholder(vc);
  if (placeholder) out.sendMessageText = placeholder;
  const barPlaceholder = inlineBarPlaceholder(vc);
  if (barPlaceholder) out.inlineInputPlaceholder = barPlaceholder;
  const privacyTitle = privacyTitleValue(vc.privacyTitle);
  if (privacyTitle !== undefined) out.privacyTitle = privacyTitle;
  const privacyText = normalizePrivacyText(vc.privacyText);
  if (privacyText !== null) out.privacyText = privacyText;

  Object.assign(out, EMBED_FIXED_STANDARDS, INLINE_FIXED_STANDARDS, {
    courseCards: courseCardsForDisplayMode(vc.displayMode),
  });
  return out;
}

module.exports = {
  BUBBLE_COURSE_CARDS,
  EMBED_FIXED_STANDARDS,
  INLINE_FIXED_STANDARDS,
  LEGACY_DEFAULT_GREETINGS,
  LEGACY_DEFAULT_PLACEHOLDERS,
  LEGACY_DEFAULT_PRIVACY_TITLES,
  PRIVACY_TEXT_MAX_LEN,
  PRIVACY_LINES_MAX,
  PRIVACY_LINE_MAX_LEN,
  embedDisplayMode,
  courseCardsForDisplayMode,
  effectiveGreeting,
  effectivePlaceholder,
  inlineBarPlaceholder,
  greetingBubbleText,
  normalizePrivacyText,
  privacyTitleValue,
  applyEmbedStandards,
};
