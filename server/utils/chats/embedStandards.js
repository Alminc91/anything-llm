// Kufer Design Center vereinfacht (15./16.10.2026): feste Standards des
// Embed-Widgets. Die früheren Wahlmöglichkeiten (Begrüßung als Text,
// Vorschläge als Balken, Folgefragen aus, Datenschutz als Karte, KI-Hinweis
// vom Modell, Online-Punkt, Kartenstil/-layout, Inline-Optionen,
// Fenstergröße und Randabstände) entfallen. Wieder wählbar sind Kurskarten
// an/aus und ihre Reihenfolge (KIE-567) sowie die Willkommensblasen je
// Gerät (KIE-568). Gespeicherte Altwerte bleiben in
// visual_config stehen, werden aber beim Ausliefern (GET /embed/:id/config)
// und beim Prompt pro Embed (utils/chats/embed.js) ignoriert bzw. durch den
// Standard ersetzt. Das Widget setzt dieselben Werte zusätzlich selbst
// (auch ohne Server-Wert). Rangfolge im Widget nach E23 (Fixliste
// 7.22-rc17): Was das Design Center einstellt (Gruppe A), gilt nur aus dem
// Design Center (Skript-Angaben und CSS-Variablen der Seite wirken nicht);
// die festen Standards hier (Gruppe B) dürfen Entwickler per Skript-Angabe
// verfeinern, die Skript-Angabe schlägt den gelieferten festen Standard.
// Ausgenommen sind (Fixliste 7.22-rc18 F62): der KI-Hinweis (disclaimer,
// E24: auf keinem Weg abschaltbar oder änderbar), courseCardsAnswerStyle
// (liest nur der Server für den Prompt, das Widget hat dafür keine Angabe),
// onlineDot (Online-Punkt entfernt, data-online-dot ohne Wirkung).
// privacyNotice liefert der Server seit der Datenschutz-Fußzeile (Nutzer
// 23.10.2026) fest "link" (immer der Link „Datenschutz“ neben dem
// KI-Hinweis); es zählt wie im Widget zu Gruppe A: data-privacy-notice wird
// verworfen und in der Konsole gemeldet.
// greetingStyle liefert der Server fest "bubble" (Begrüßung immer als
// Blase) und es zählt seit 7.23 wie privacyNotice zu Gruppe A:
// data-greeting-style wird verworfen und in der Konsole gemeldet (D2
// gekippt, Nutzer 24.10.2026: die Form der Begrüßung kommt aus dem Design
// Center, nicht aus dem Einbau-Code). Bis 7.22.2 war es Gruppe B mit der
// Grenze E26 (7.22-rc18: "text" nur bei abgeschaltetem Datenschutz-Hinweis),
// wirkte also praktisch nie.
// Technik-Angaben am Skript (Gruppe C, etwa data-language) wirken immer.
//
// Eine Quelle für beide Wege: applyEmbedStandards (Konfiguration ans
// Widget) und courseCardsValue (Karten an/aus, Prompt-Abschnitt).
// Was sich je Altwert sichtbar ändert (Flotten-Rollout KIE-573, AK-7):
// docs/design-center-2-migration.md.
// Was überhaupt ans Widget geht, bestimmt allein die Erlaubtliste im
// Endpunkt (endpoints/embed/index.js); applyEmbedStandards setzt nur die
// abgeleiteten Texte und die festen Werte dazu.

// Antworten mit Kursen (KIE-567, Nutzer 15.10.2026, Design Center Reiter
// Aussehen, beide Darstellungen): „Kurse anzeigen als“ Kurskarten ("auto")
// oder Nur Text mit Links ("off"); „Reihenfolge“ Karten zuerst ("above",
// Standard, empfohlen) oder Text zuerst ("below"). Eine gespeicherte Wahl
// gilt für beide Darstellungen gleich (auch für ein Widget „In der Seite“,
// das ohne Platzhalter als Chatfenster erscheint).
// Ohne gespeicherte Wahl hängt der Standard an der TATSÄCHLICHEN Darstellung
// (R4, Fixliste 7.22-rc8): Chatfenster (bubble) = Nur Text mit Links, In der
// Seite (inline) = Kurskarten. Die kennt nur das Widget: Ohne passenden
// Platzhalter fällt „In der Seite“ auf das Chatfenster zurück (Review
// 7.22-rc2 F01/F02); die Darstellung selbst kommt seit E23 (Fixliste
// 7.22-rc17) nur aus dem Design Center, data-display-mode am Skript wirkt
// nicht mehr. Deshalb liefert GET /embed/:id/config courseCards NUR,
// wenn gespeichert (applyEmbedStandards), und das Widget schickt seine
// Darstellung mit jeder Chat-Anfrage mit (Feld displayMode im Body von
// stream-chat, endpoints/embed/index.js); der Prompt pro Embed nutzt es
// ausschließlich für diesen Standard (courseCardsValue; fehlt oder ungültig
// = bubble = off).
const COURSE_CARDS_VALUES = Object.freeze(["auto", "off"]);
const COURSE_CARDS_DEFAULTS = Object.freeze({ inline: "auto", bubble: "off" });
const COURSE_CARDS_POSITIONS = Object.freeze(["above", "below"]);
const DEFAULT_COURSE_CARDS_POSITION = "above";

// Willkommensblasen neben dem geschlossenen Chat-Button (KIE-568, Nutzer
// 15.10.2026, Reiter Inhalt, nur Chatblase), je Gerät (Desktop/Handy wie im
// Widget, innerWidth < 768 = Handy): "off" keine Blasen, nur der Chat-
// Button; "first" beim ersten Besuch (localStorage, wie bisher, Standard);
// "every" bei jedem Besuch (sessionStorage: je Browser-Tab einmal,
// Unterseiten im selben Tab nicht erneut).
const WELCOME_BUBBLES_VALUES = Object.freeze(["off", "first", "every"]);
const DEFAULT_WELCOME_BUBBLES = "first";
// KIE-576 Paket 3: Kursanzahl im Untertitel (visual_config.courseCountMode,
// Standard an) und ihre Bezeichnung (visual_config.courseCountWord, ein
// Wort: nach trim 1 bis 20 UTF-16-Einheiten, Buchstaben, Bindestrich nur
// zwischen Buchstaben, etwa „Seminare“ oder „Online-Kurse“; fehlt, leer
// oder ungültig: „Kurse“, englisch „courses“). Dieselben Regeln prüfen das
// Design Center (widgetKeys.js) und das Widget; Beispiele in der Fixture
// des Vertrags (embedConfigContract.json, courseCountWords).
const COURSE_COUNT_MODES = Object.freeze(["on", "off"]);
const DEFAULT_COURSE_COUNT_MODE = "on";
const COURSE_COUNT_WORD_MAX_LEN = 20;
const COURSE_COUNT_WORD_RX = /^\p{L}+(?:-\p{L}+)*$/u;
// Meldung, wenn das Design Center eine ungültige Bezeichnung speichern will
const COURSE_COUNT_WORD_ERROR =
  "Bitte ein Wort aus Buchstaben, höchstens 20 Zeichen, etwa Seminare oder Online-Kurse.";
const DEFAULT_COURSE_COUNT_WORDS = Object.freeze({
  de: "Kurse",
  en: "courses",
});

// Feste Standards für beide Darstellungen. Karten wie Demo-Variante 4
// („Suche“, chatbot-v4): kurzer Chatbot-Text, Karten als Zeilen. Ob Karten
// erscheinen und an welcher Stelle, wählt der Kunde (courseCardsValue,
// courseCardsPositionValue unten).
// Datenschutz-Hinweis (privacyNotice) fest "link" (Nutzer 23.10.2026,
// issues/datenschutz-fusszeile.md AK-7/AK-10): Der Link „Datenschutz“ steht
// immer in der Zeile des KI-Hinweises unter der Eingabe und öffnet das
// Datenschutz-Fenster; kein „Aus“ (Gruppe A: data-privacy-notice wirkt
// nicht). Die Blase beim Start ist seit AK-12 (Nutzer 24.10.2026) eine
// Option mit eigenem Schlüssel, privacyStartBubble (nur true, Erlaubtliste
// im Endpunkt, endpoints/embed/index.js mapLayoutConfig); privacyNotice
// schaltet sie nicht ein (D2). Ebenso fest
// und Gruppe A: greetingStyle "bubble" (Kopfkommentar). Widget-Kopien
// bis 7.22.2 kennen "link" nicht und zeigen dann wieder die Blase
// (Migrationsdoku, Prüfpunkt 14). Gespeicherte Altwerte ("bubble", "none", "modal") bleiben in
// visual_config stehen und wirken nicht. Bis 7.22.2 war der Hinweis eine
// zweite Blase unter der Begrüßung, im Design Center abschaltbar (KIE-565
// Nachtrag, privacyNoticeValue). Der Prompt pro Embed hängt nicht davon ab.
const EMBED_FIXED_STANDARDS = Object.freeze({
  greetingStyle: "bubble",
  suggestionStyle: "pills",
  followUps: "pills",
  disclaimer: "footer",
  privacyNotice: "link",
  onlineDot: false,
  courseCardsAnswerStyle: "short",
  courseCardsLayout: "rows",
});

// Inline fest wie die Demo-Seite (/var/docker/demo/site/app.js,
// loadWidgetScript): data-inline-start-state "collapsed", data-inline-height
// "520px", data-inline-layout "overlay", data-inline-effect "morph",
// data-inherit-font "true", data-inline-input "true", data-inline-open-on
// "focus" (Standard der Topbar). Keine Max. Breite (Demo setzt keine: volle
// Breite des Platzhalters). Diese Schlüssel wirken nur bei „In der Seite“
// und gehen an jedes Widget: Ob es „In der Seite“ erscheint, entscheidet das
// Widget aus der Darstellung im Design Center (displayMode, seit E23 nicht
// mehr per data-display-mode) und dem Platzhalter in der Seite, sonst
// erscheint das Chatfenster.
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
//   Frage der neuen Begrüßung („Wie kann ich Ihnen helfen?“). Dazu der
//   Standard bis 7.22.2-rc4 („Ihre Frage eingeben“ / „Enter your question“):
//   Seit der Nutzerentscheidung vom 23.10.2026 ist der Standard derselbe Text
//   wie in der eingeklappten Inline-Leiste; ein so gespeicherter alter
//   Standard (Feld im Design Center unverändert gespeichert) zeigt den neuen.
// Bewusst NICHT in diesen Listen (Entscheidung E2, Fixliste 7.22-rc7): die
// übrigen Vorbelegungen aus DEFAULT_CONFIG bis 7.21, Name „Ihr
// Online-Berater“ und die Willkommensblasen „Hallo! Ich bin Ihr
// Online-Berater!“ / „Möchten Sie mehr über unser Angebot erfahren? …“.
// Sie bleiben eigene Kundenwerte; der Nutzer will vorerst überall
// „Online-Berater“. Ebenso userTextColor "#FFFFFF" (war auch die wählbare
// Option „Weiß“).
// Diese vier Texte stehen wortgleich auch im Widget (anythingllm-embed
// src/utils/layout.js) und im Design Center (widgetKeys.js); der erste ist
// zugleich die erste Datenschutz-Vorlage in LEGACY_PRIVACY_GREETINGS (E43).
const LEGACY_DEFAULT_GREETINGS = Object.freeze([
  // früherer Widget-Standard von greeting (Datenschutzsatz, steht jetzt im
  // Datenschutz-Fenster, 7.22 bis 7.22.2 in der Datenschutz-Blase)
  "Dieser Chatbot nutzt künstliche Intelligenz (KI). Ihre Nachrichten werden nicht an Dritte weitergegeben, können aber zur Qualitätssicherung von uns eingesehen werden. Bitte geben Sie keine sensiblen personenbezogenen Daten ein.",
  "Hallo und herzlich willkommen! Ich helfe Ihnen gerne weiter und beantworte Ihre Fragen mit intelligenten, KI-gestützten Antworten.",
  "Hallo! Ich bin Ihr digitaler Berater mit künstlicher Intelligenz (KI). Beschreiben Sie einfach, was Sie suchen.",
  "Hello! I am your digital advisor powered by artificial intelligence (AI). Just describe what you are looking for.",
]);
// Alte Datenschutz-Vorlagen in der Begrüßung (E43, Nutzerentscheidung
// 22.10.2026 „Alte Vorlage als nicht gesetzt“, 7.22-rc24): Steht einer
// dieser Texte als greeting oder greetingBubbleText gespeichert, gilt die
// Begrüßung wie nicht gesetzt (Standard-Begrüßung der Sprache im Widget;
// der Datenschutz-Hinweis steht seit 7.23 im Fenster hinter dem Link
// „Datenschutz“, bis 7.22.2 als Blase darunter). Sonst stünde der Hinweis
// doppelt da. Eine
// Erlaubnisliste exakter Texte, keine Stichwortsuche: Eigene Texte der
// Kunden bleiben, auch abgewandelte Vorlagen. Verglichen wird nach
// Normalisierung von Leerraum (isLegacyGreeting). Erhebung der Flotte
// (22.10.2026, nur lesend): issues/rollout-722/datenschutz-vorlagen.md im
// Pipeline-Repo; Migrationsdoku docs/design-center-2-migration.md (E43).
// Kopie im Design Center: frontend widgetKeys.js (Test
// designCenterLegacyPrivacyGreeting.test.mjs vergleicht). Gespeichert
// bleibt alles unverändert.
const LEGACY_PRIVACY_GREETINGS = Object.freeze([
  // Juni-Rollout (Kundendaten/Chatbot/prompt_rollout/rollout_greeting.py,
  // 12.06.2026), ab 21.07.2026 auch Code-Standard des Widgets
  "Dieser Chatbot nutzt künstliche Intelligenz (KI). Ihre Nachrichten werden nicht an Dritte weitergegeben, können aber zur Qualitätssicherung von uns eingesehen werden. Bitte geben Sie keine sensiblen personenbezogenen Daten ein.",
  // früherer Standard-Datenschutztext des Widgets (06.10.2026 bis E30,
  // 7.22-rc19, noch mit „Mitarbeitende“) als ein Absatz
  "Ihre Anfragen bleiben auf Servern in Deutschland und werden nicht an Dritte weitergegeben. Mitarbeitende der Einrichtung können Gespräche zur Qualitätssicherung einsehen. Bitte teilen Sie nur Angaben, die für Ihre Anfrage nötig sind.",
]);
const LEGACY_DEFAULT_PLACEHOLDERS = Object.freeze([
  "Wie kann ich Ihnen helfen?",
  // Standard bis 7.22.2-rc4 (de/en), Nutzerentscheidung 23.10.2026
  "Ihre Frage eingeben",
  "Enter your question",
]);
// Datenschutz-Überschrift: früherer Standard mit Doppelpunkt (de/en)
const LEGACY_DEFAULT_PRIVACY_TITLES = Object.freeze([
  "Datenschutz:",
  "Privacy:",
]);

// Höchstlängen wie im Widget (utils/layout.js). Eine Begrüßung über 300
// Zeichen (alter Wert ohne Grenze) kürzt allein das Widget (shortenGreeting,
// Review 7.22-rc6 F08); der Server liefert sie ungekürzt.
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

// Gespeicherten Auswahlwert prüfen: String, getrimmt und klein geschrieben
// einer der erlaubten Werte, sonst der Standard
function oneOf(value, allowed, fallback) {
  if (typeof value !== "string") return fallback;
  const v = value.trim().toLowerCase();
  return allowed.includes(v) ? v : fallback;
}

/**
 * Gespeicherte Wahl „Kurse anzeigen als“ (visual_config.courseCards,
 * KIE-567): "auto" Kurskarten, "off" Nur Text mit Links; fehlend oder
 * ungültig -> null (keine Wahl gespeichert).
 * @param {*} value
 * @returns {"auto"|"off"|null}
 */
function storedCourseCards(value) {
  return oneOf(value, COURSE_CARDS_VALUES, null);
}

/**
 * Standard für „Kurse anzeigen als“ nach der tatsächlichen Darstellung (R4,
 * Fixliste 7.22-rc8): "inline" (In der Seite) -> Kurskarten, alles andere
 * (Chatfenster, fehlend, ungültig) -> Nur Text mit Links.
 * @param {*} displayMode tatsächliche Darstellung ("inline"|"bubble")
 * @returns {"auto"|"off"}
 */
function defaultCourseCards(displayMode) {
  return COURSE_CARDS_DEFAULTS[embedDisplayMode(displayMode)];
}

/**
 * Wirksame Wahl: Kurskarten an ("auto") oder aus ("off"). Eine gespeicherte
 * Wahl gewinnt immer; sonst der Standard nach der tatsächlichen Darstellung
 * (defaultCourseCards). Ohne Angabe der Darstellung gilt das Chatfenster
 * (-> "off").
 * @param {*} value gespeicherter visual_config.courseCards
 * @param {*} [displayMode] tatsächliche Darstellung ("inline"|"bubble")
 * @returns {"auto"|"off"}
 */
function courseCardsValue(value, displayMode) {
  return storedCourseCards(value) ?? defaultCourseCards(displayMode);
}

/**
 * Reihenfolge Karten/Text aus visual_config.courseCardsPosition (KIE-567):
 * "above" Karten zuerst (Standard), "below" Text zuerst. Fehlend oder
 * ungültig -> "above".
 * @param {*} value
 * @returns {"above"|"below"}
 */
function courseCardsPositionValue(value) {
  return oneOf(value, COURSE_CARDS_POSITIONS, DEFAULT_COURSE_CARDS_POSITION);
}

/**
 * Willkommensblasen je Gerät aus visual_config.welcomeBubblesDesktop bzw.
 * welcomeBubblesMobile (KIE-568): "off", "first" (Standard) oder "every".
 * Fehlend oder ungültig -> "first" (Verhalten wie bisher).
 * @param {*} value
 * @returns {"off"|"first"|"every"}
 */
function welcomeBubblesValue(value) {
  return oneOf(value, WELCOME_BUBBLES_VALUES, DEFAULT_WELCOME_BUBBLES);
}

/**
 * Kursanzahl im Untertitel an oder aus (visual_config.courseCountMode,
 * KIE-576 Paket 3): "on" (Standard, auch fehlend oder ungültig) oder "off".
 * @param {*} value
 * @returns {"on"|"off"}
 */
function courseCountModeValue(value) {
  return oneOf(value, COURSE_COUNT_MODES, DEFAULT_COURSE_COUNT_MODE);
}

/**
 * Gespeicherte Bezeichnung der Kursanzahl (visual_config.courseCountWord):
 * getrimmt, 1 bis 20 Zeichen (UTF-16), ein Wort aus Buchstaben, Bindestrich
 * nur zwischen Buchstaben. Sonst null (es gilt der Standard der Sprache,
 * auch für einen ungültigen Altbestand).
 * @param {*} value
 * @returns {string|null}
 */
function courseCountWordValue(value) {
  if (typeof value !== "string") return null;
  const word = value.trim();
  if (word.length === 0 || word.length > COURSE_COUNT_WORD_MAX_LEN) return null;
  return COURSE_COUNT_WORD_RX.test(word) ? word : null;
}

/**
 * Bezeichnung der Kursanzahl beim Speichern der visual_config (POST
 * /embed/update, Design Center): leer oder nur Leerzeichen -> Feld entfernt,
 * gültig -> getrimmt gespeichert, ungültig -> error (HTTP 400, nichts
 * gespeichert). Ohne Feld oder ohne lesbares JSON bleibt der Wert, wie er
 * ist.
 * @param {*} visualConfig gesendete visual_config (JSON-String oder Objekt)
 * @returns {{visualConfig: *, error: string|null}}
 */
function courseCountWordOnSave(visualConfig) {
  let config = visualConfig;
  if (typeof config === "string") {
    try {
      config = JSON.parse(config);
    } catch {
      return { visualConfig, error: null };
    }
  }
  if (
    !config ||
    typeof config !== "object" ||
    Array.isArray(config) ||
    !Object.prototype.hasOwnProperty.call(config, "courseCountWord")
  )
    return { visualConfig, error: null };
  const value = config.courseCountWord;
  const next = { ...config };
  if (value === null || (typeof value === "string" && value.trim() === ""))
    delete next.courseCountWord;
  else if (courseCountWordValue(value) !== null)
    next.courseCountWord = value.trim();
  else return { visualConfig, error: COURSE_COUNT_WORD_ERROR };
  return {
    visualConfig:
      typeof visualConfig === "string" ? JSON.stringify(next) : next,
    error: null,
  };
}

/**
 * Wirksame Bezeichnung für das Widget: die gespeicherte (courseCountWordValue)
 * oder der Standard der Sprache („Kurse“, englisch „courses“).
 * @param {*} value gespeicherter visual_config.courseCountWord
 * @param {string} [lang] "de"|"en" (embedDefaultsLanguage)
 * @returns {string}
 */
function courseCountWord(value, lang = "de") {
  return (
    courseCountWordValue(value) ??
    DEFAULT_COURSE_COUNT_WORDS[lang === "en" ? "en" : "de"]
  );
}

// Eigener Text: String, getrimmt nicht leer und keine frühere Vorbelegung
function ownText(value, legacy = []) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (text.length === 0 || legacy.includes(text)) return null;
  return text;
}

// Leerraum vereinheitlichen (E43): Zeilenumbrüche, Tabulatoren, mehrfache
// und geschützte Leerzeichen werden ein Leerzeichen, der Rand entfällt
function collapseWhitespace(text) {
  return text.replace(/\s+/g, " ").trim();
}

// frühere Vorbelegungen und Datenschutz-Vorlagen der Begrüßung, normalisiert
const LEGACY_GREETINGS_NORMALIZED = new Set(
  [...LEGACY_DEFAULT_GREETINGS, ...LEGACY_PRIVACY_GREETINGS].map(
    collapseWhitespace
  )
);

/**
 * Ist der gespeicherte Begrüßungstext eine frühere Vorbelegung
 * (LEGACY_DEFAULT_GREETINGS) oder eine alte Datenschutz-Vorlage
 * (LEGACY_PRIVACY_GREETINGS, E43)? Verglichen wird genau, nur nach
 * Normalisierung von Leerraum (collapseWhitespace); Groß-/Kleinschreibung,
 * Satzzeichen und Wörter zählen. Kein String -> false.
 * @param {*} value
 * @returns {boolean}
 */
function isLegacyGreeting(value) {
  return (
    typeof value === "string" &&
    LEGACY_GREETINGS_NORMALIZED.has(collapseWhitespace(value))
  );
}

// Eigene Begrüßung: eigener Text (getrimmt, Leerraum innen bleibt) und keine
// frühere Vorbelegung oder Datenschutz-Vorlage
function ownGreeting(value) {
  const text = ownText(value);
  return text && !isLegacyGreeting(text) ? text : null;
}

/**
 * Stand der frühere „Text der Begrüßungsblase“ sichtbar in einer Blase? Das
 * alte Widget zeigte greetingBubbleText nur bei greetingStyle "bubble" bzw.
 * mit dem Datenschutz-Hinweis in der Blase (privacyNotice "bubble"); beim
 * früheren Standard „text“ war er unsichtbar (Review 7.22-rc6 F03).
 * Groß-/Kleinschreibung und Leerraum egal. Liest bewusst den gespeicherten
 * Altwert von privacyNotice (nicht den festen Standard "link"), damit seit
 * der Datenschutz-Fußzeile (7.23) jedes Widget dieselbe Begrüßung behält.
 * @param {Object} visualConfig
 * @returns {boolean}
 */
function greetingBubbleTextShown(visualConfig = {}) {
  const isBubble = (v) =>
    typeof v === "string" && v.trim().toLowerCase() === "bubble";
  return (
    isBubble(visualConfig?.greetingStyle) ||
    isBubble(visualConfig?.privacyNotice)
  );
}

/**
 * Begrüßungstext (Begrüßungsblase). Der frühere „Text der Begrüßungsblase“
 * (greetingBubbleText) hat Vorrang vor greeting, wenn er bisher sichtbar in
 * der Blase stand (greetingBubbleTextShown; greeting war dann nur die
 * kleine Zeile darunter bzw. gar nicht zu sehen) oder wenn es keine eigene
 * Begrüßung gibt. Beim früheren Stil „text“ gilt greeting: Das ist der Text,
 * den Besucher bisher sahen. Frühere Vorbelegungen und alte Datenschutz-
 * Vorlagen zählen nicht, auch mit anderem Leerraum (isLegacyGreeting, E43;
 * -> null = Standard). Gleiche Regel im Design Center (widgetKeys.js
 * greetingKey).
 * @param {Object} visualConfig
 * @returns {string|null}
 */
function effectiveGreeting(visualConfig = {}) {
  const bubble = ownGreeting(visualConfig?.greetingBubbleText);
  const greeting = ownGreeting(visualConfig?.greeting);
  if (bubble && (!greeting || greetingBubbleTextShown(visualConfig)))
    return bubble;
  return greeting;
}

/**
 * Platzhalter im Eingabefeld des Chats (Chatblase und aufgeklappte Inline-
 * Box; Feld „Platzhalter“ im Design Center): sendMessageText, sonst null
 * (Standard des Widgets). Frühere Vorbelegungen und frühere Standards
 * zählen nicht. Die eingeklappte Inline-Leiste zeigt ihn ebenfalls, wenn er
 * kurz genug ist (inlineBarPlaceholder, Nutzerentscheidung 23.10.2026).
 * @param {Object} visualConfig
 * @returns {string|null}
 */
function effectivePlaceholder(visualConfig = {}) {
  return ownText(visualConfig?.sendMessageText, LEGACY_DEFAULT_PLACEHOLDERS);
}

/**
 * Platzhalter der eingeklappten Inline-Leiste. Eingeklappt und aufgeklappt
 * zeigen denselben Text (Nutzerentscheidung 23.10.2026, ersetzt den festen
 * Demo-Text der Leiste aus Entscheidung D2, 7.22-rc3). Rangfolge, je
 * getrimmt und nur mit höchstens INLINE_TEXT_MAX_LEN Zeichen wie im Widget:
 * 1. ein früher im alten Design Center eigens gespeicherter Leistentext
 *    (inlineInputPlaceholder, Review F04),
 * 2. sonst der eigene Platzhalter des Chats (effectivePlaceholder),
 * 3. sonst null: Das Widget zeigt den Standard seiner Sprache („Stellen Sie
 *    hier Ihre Frage …“ bzw. „Ask your question here …“), der gleich dem
 *    Standard des Chat-Eingabefelds ist.
 * Ein längerer eigener Platzhalter gilt nur im Eingabefeld des Chats.
 * @param {Object} visualConfig
 * @returns {string|null}
 */
function inlineBarPlaceholder(visualConfig = {}) {
  const fits = (text) =>
    text && text.length <= INLINE_TEXT_MAX_LEN ? text : null;
  return (
    fits(ownText(visualConfig?.inlineInputPlaceholder)) ||
    fits(effectivePlaceholder(visualConfig))
  );
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
 * kürzen; das Widget zeigt dann den Standardtext). Die Grenze von
 * PRIVACY_TEXT_MAX_LEN gilt für den Rohtext und für die Normalform.
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
  // Grenze auch nach dem Voranstellen der „• “ (Review 7.22-rc6 F05): das
  // Widget verwirft einen längeren Text still und zeigt den Standardtext
  const text = lines.join("\n");
  return text.length <= PRIVACY_TEXT_MAX_LEN ? text : null;
}

/**
 * Überschrift des Datenschutz-Hinweises: eigener Text (getrimmt, höchstens
 * 120 Zeichen). undefined = nicht gesetzt, leer, ungültig oder früherer
 * Standard mit Doppelpunkt: Das Widget zeigt im Datenschutz-Fenster dann
 * seinen Standard „Datenschutz“. Leer gilt seit 7.23 wie nicht gesetzt (F5,
 * Fixliste rc1); bis 7.22.2 lieferte der Server "" für eine Blase ohne
 * Überschrift.
 * @param {*} value
 * @returns {string|undefined}
 */
function privacyTitleValue(value) {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!text || LEGACY_DEFAULT_PRIVACY_TITLES.includes(text)) return undefined;
  return text.length <= PRIVACY_TITLE_MAX_LEN ? text : undefined;
}

/**
 * Feste Standards auf die (bereits validierte) Konfiguration für das Widget
 * anwenden: Begrüßung, Platzhalter, Leistentext und Datenschutz-Texte aus
 * den gespeicherten Texten setzen, Reihenfolge der Karten (KIE-567) sowie
 * Willkommensblasen je Gerät (KIE-568) immer mit gültigem Wert, feste Werte
 * erzwingen (darunter privacyNotice "link" und greetingStyle "bubble",
 * beide Gruppe A seit 7.23).
 * courseCards geht NUR mit, wenn eine Wahl gespeichert ist (R4, Fixliste
 * 7.22-rc8); sonst entscheidet das Widget nach seiner tatsächlichen
 * Darstellung (In der Seite Kurskarten, Chatfenster Nur Text mit Links).
 * Was sonst ans Widget geht, legt allein die Erlaubtliste des Endpunkts
 * fest (`mapped`).
 * Verändert `mapped` nicht, gibt ein neues Objekt zurück.
 * @param {Object} mapped Antwort von /config vor den Standards
 * @param {Object} visualConfig gespeicherte visual_config (Rohwerte)
 * @returns {Object}
 */
function applyEmbedStandards(mapped = {}, visualConfig = {}) {
  const vc =
    visualConfig && typeof visualConfig === "object" ? visualConfig : {};
  const out = { ...mapped };

  // Begrüßung nur als greeting (Review 7.22-rc6 F08): Ein eigener
  // greetingBubbleText geht nicht mehr ans Widget; welcher gespeicherte Text
  // gilt, entscheidet effectiveGreeting (alte Datenschutz-Vorlagen gelten
  // dort als nicht gesetzt, E43). Das Widget kürzt eine zu lange
  // Begrüßung selbst. Der Text gehört zu Gruppe A (E23, Fixliste
  // 7.22-rc17): data-greeting und data-greeting-bubble-text am Skript wirken
  // nie, auch ohne gespeicherten Text (dann gilt der Standard der Sprache im
  // Widget). Die Form der Begrüßung (greetingStyle, fest "bubble" in
  // EMBED_FIXED_STANDARDS) gehört seit 7.23 ebenfalls zu Gruppe A:
  // data-greeting-style am Skript wirkt nie (D2 gekippt, Nutzer 24.10.2026;
  // bis 7.22.2 Gruppe B mit der Grenze E26, Fixliste 7.22-rc18).
  const greeting = effectiveGreeting(vc);
  if (greeting) out.greeting = greeting;
  const placeholder = effectivePlaceholder(vc);
  if (placeholder) out.sendMessageText = placeholder;
  const barPlaceholder = inlineBarPlaceholder(vc);
  if (barPlaceholder) out.inlineInputPlaceholder = barPlaceholder;
  const privacyTitle = privacyTitleValue(vc.privacyTitle);
  if (privacyTitle !== undefined) out.privacyTitle = privacyTitle;
  const privacyText = normalizePrivacyText(vc.privacyText);
  if (privacyText !== null) out.privacyText = privacyText;

  Object.assign(out, EMBED_FIXED_STANDARDS, INLINE_FIXED_STANDARDS, {
    courseCardsPosition: courseCardsPositionValue(vc.courseCardsPosition),
    welcomeBubblesDesktop: welcomeBubblesValue(vc.welcomeBubblesDesktop),
    welcomeBubblesMobile: welcomeBubblesValue(vc.welcomeBubblesMobile),
  });
  // nur eine gespeicherte Wahl; ein Wert aus mapped zählt nicht (der
  // Endpunkt reicht courseCards nicht durch, der Server bestimmt den Schlüssel)
  const courseCards = storedCourseCards(vc.courseCards);
  if (courseCards) out.courseCards = courseCards;
  else delete out.courseCards;
  return out;
}

module.exports = {
  COURSE_CARDS_VALUES,
  COURSE_CARDS_DEFAULTS,
  COURSE_CARDS_POSITIONS,
  WELCOME_BUBBLES_VALUES,
  COURSE_COUNT_MODES,
  COURSE_COUNT_WORD_MAX_LEN,
  COURSE_COUNT_WORD_ERROR,
  DEFAULT_COURSE_COUNT_WORDS,
  EMBED_FIXED_STANDARDS,
  INLINE_FIXED_STANDARDS,
  LEGACY_DEFAULT_GREETINGS,
  LEGACY_PRIVACY_GREETINGS,
  LEGACY_DEFAULT_PLACEHOLDERS,
  LEGACY_DEFAULT_PRIVACY_TITLES,
  PRIVACY_TEXT_MAX_LEN,
  PRIVACY_LINES_MAX,
  PRIVACY_LINE_MAX_LEN,
  embedDisplayMode,
  storedCourseCards,
  defaultCourseCards,
  courseCardsValue,
  courseCardsPositionValue,
  welcomeBubblesValue,
  courseCountModeValue,
  courseCountWordValue,
  courseCountWordOnSave,
  courseCountWord,
  greetingBubbleTextShown,
  isLegacyGreeting,
  effectiveGreeting,
  effectivePlaceholder,
  inlineBarPlaceholder,
  normalizePrivacyText,
  privacyTitleValue,
  applyEmbedStandards,
};
