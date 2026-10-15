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

// Kurskarten in der Chatblase: aus. Begründung (Umsetzung 15./16.10.2026):
// im Browser noch nicht geprüft (Nutzerentscheidung 14.10.: „Chatblase:
// Karten derzeit nicht getestet → aus, bis eigens geprüft“). Das Chatfenster
// ist am Desktop höchstens 25 % (ab 1280 px) bzw. 40 % breit; das
// Standardlayout „Zeilen“ braucht 480 px Kartenbreite (ROW_CARD_MIN_PX im
// Widget) und fiele dort immer auf zwei schmale Rasterkarten zurück. Ohne
// Karten antwortet der Chatbot klassisch mit Kurs-Links. Nach bestandener
// Browser-Abnahme genügt hier "auto".
const BUBBLE_COURSE_CARDS = "off";

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

// Entfallene Schlüssel: nie mehr ausliefern (das Widget nutzt seine festen
// Werte). Fenster: Breite/Höhe/Randabstände der Chatblase. Inline: Max.
// Breite, Leisten-Stil (die Leiste folgt dem Farbschema „theme“), Leistentext
// und Knopftext. Texte: fester KI-Hinweis (nicht änderbar), Knopf der
// entfallenen Datenschutz-Karte. greetingBubbleText und
// inlineInputPlaceholder werden aus Begrüßung bzw. Platzhalter neu gesetzt.
const EMBED_IGNORED_KEYS = Object.freeze([
  "windowWidth",
  "windowHeight",
  "offsetX",
  "offsetY",
  "inlineMaxWidth",
  "inlineTheme",
  "inlineCollapsedText",
  "inlineSendText",
  "inlineInputPlaceholder",
  "greetingBubbleText",
  "disclaimerText",
  "privacyButtonText",
]);

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
const INLINE_TEXT_MAX_LEN = 120;
const PRIVACY_TITLE_MAX_LEN = 120;

// Datenschutz-Text (privacyText), freies Format, genau wie privacyTextValue()
// im Widget (utils/layout.js): Zeilen mit „•“, „-“ oder „–“ am Anfang sind
// Aufzählungspunkte, andere Zeilen Absätze. Altformat (keine Zeile mit
// Zeichen, so bisher gespeichert): Zeilen bzw. „|“-Teile; mehrere werden im
// Widget wie bisher Punkte, eine einzelne ein Absatz.
const PRIVACY_TEXT_MAX_LEN = 1000;
const PRIVACY_LINES_MAX = 12;
const PRIVACY_LINE_MAX_LEN = 500;
const PRIVACY_MARK_RE = /^[•\-–]\s*/;

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
 * Platzhalter im Eingabefeld (Chatblase und Inline-Leiste): sendMessageText,
 * sonst null (Standard des Widgets). Frühere Vorbelegung zählt nicht.
 * @param {Object} visualConfig
 * @returns {string|null}
 */
function effectivePlaceholder(visualConfig = {}) {
  return ownText(visualConfig?.sendMessageText, LEGACY_DEFAULT_PLACEHOLDERS);
}

/**
 * Datenschutz-Text prüfen und normalisieren wie privacyTextValue() im
 * Widget: Rohtext getrimmt, höchstens PRIVACY_TEXT_MAX_LEN Zeichen; Zeilen
 * getrimmt, leere verworfen; Altformat (keine Zeile mit „•“/„-“/„–“) auch
 * an „|“ getrennt; 1 bis PRIVACY_LINES_MAX Zeilen mit je höchstens
 * PRIVACY_LINE_MAX_LEN Zeichen. Rückgabe: Zeilen mit "\n" (Zeichen bleiben
 * stehen, das Widget macht daraus Punkte). Verletzt -> null (weglassen,
 * nicht kürzen; das Widget zeigt dann den Standardtext).
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
  if (!lines.some((l) => PRIVACY_MARK_RE.test(l)))
    lines = clean(raw.split(/\r?\n|\|/));
  if (
    lines.length === 0 ||
    lines.length > PRIVACY_LINES_MAX ||
    lines.some((l) => l.length > PRIVACY_LINE_MAX_LEN)
  )
    return null;
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
 * anwenden: entfallene Schlüssel entfernen, Begrüßung/Platzhalter/
 * Datenschutz aus den gespeicherten Texten setzen, feste Werte erzwingen.
 * Verändert `mapped` nicht, gibt ein neues Objekt zurück.
 * @param {Object} mapped Antwort von /config vor den Standards
 * @param {Object} visualConfig gespeicherte visual_config (Rohwerte)
 * @returns {Object}
 */
function applyEmbedStandards(mapped = {}, visualConfig = {}) {
  const vc =
    visualConfig && typeof visualConfig === "object" ? visualConfig : {};
  const out = { ...mapped };
  for (const key of EMBED_IGNORED_KEYS) delete out[key];
  delete out.greeting;
  delete out.sendMessageText;
  delete out.privacyTitle;
  delete out.privacyText;

  const greeting = effectiveGreeting(vc);
  if (greeting) {
    out.greeting = greeting;
    // ältere Widget-Stände lesen die Blase aus greetingBubbleText
    if (greeting.length <= GREETING_BUBBLE_TEXT_MAX_LEN)
      out.greetingBubbleText = greeting;
  }
  const placeholder = effectivePlaceholder(vc);
  if (placeholder) {
    out.sendMessageText = placeholder;
    if (placeholder.length <= INLINE_TEXT_MAX_LEN)
      out.inlineInputPlaceholder = placeholder;
  }
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
  EMBED_IGNORED_KEYS,
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
  normalizePrivacyText,
  privacyTitleValue,
  applyEmbedStandards,
};
