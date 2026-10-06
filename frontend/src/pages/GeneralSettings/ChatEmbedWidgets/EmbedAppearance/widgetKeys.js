// Design Center: Widget-Schlüssel der Leiste, des Panels, der Kurskarten und
// der Datenschutz-/KI-Hinweise (visual_config). Grenzen und Enums wie der
// Server (server/endpoints/embed: LAYOUT_ENUMS, WIDGET_TEXT_MAX,
// validPrivacyText, validUrl) und das Widget (utils/layout.js). Der Server
// prüft beim Ausliefern selbst noch einmal (mapLayoutConfig) — hier nur
// zusätzlich, damit ungültige Werte gar nicht erst gespeichert werden.

export const COURSE_CARDS_OPTIONS = [
  { value: "off", label: "Aus" },
  { value: "auto", label: "An" },
];
export const COURSE_CARDS_POSITION_OPTIONS = [
  { value: "below", label: "Unter dem Text" },
  { value: "above", label: "Karten zuerst" },
];
export const COURSE_CARDS_ANSWER_STYLE_OPTIONS = [
  { value: "short", label: "Kurz" },
  { value: "long", label: "Ausführlich" },
];
export const FOLLOW_UPS_OPTIONS = [
  { value: "none", label: "Aus" },
  { value: "pills", label: "An" },
];
export const INLINE_OPEN_ON_OPTIONS = [
  { value: "submit", label: "Beim Absenden" },
  { value: "focus", label: "Beim Klick ins Feld" },
];
export const INLINE_LAYOUT_OPTIONS = [
  { value: "flow", label: "Im Seitenfluss" },
  { value: "overlay", label: "Schwebend" },
];
// "" = Standard (Schlüssel weglassen): im Seitenfluss ohne Animation,
// schwebend "expand" (resolveInlineEffect im Widget)
export const INLINE_EFFECT_OPTIONS = [
  { value: "", label: "Standard" },
  { value: "expand", label: "Aufklappen" },
  { value: "grow", label: "Wachsen" },
  { value: "spring", label: "Federn" },
  { value: "float", label: "Gleiten" },
  { value: "morph", label: "Verwandeln" },
];
export const SUGGESTION_STYLE_OPTIONS = [
  { value: "bars", label: "Balken" },
  { value: "pills", label: "Pillen" },
];
export const GREETING_STYLE_OPTIONS = [
  { value: "text", label: "Text" },
  { value: "bubble", label: "Blase" },
];
export const PRIVACY_NOTICE_OPTIONS = [
  { value: "none", label: "Keiner" },
  { value: "bubble", label: "In der Begrüßung" },
  { value: "modal", label: "Karte beim Öffnen" },
];
export const DISCLAIMER_OPTIONS = [
  { value: "none", label: "Vom Modell" },
  { value: "footer", label: "Fest unter der Eingabe" },
];

// Enum-Schlüssel mit Standard (= angezeigt, solange nichts gespeichert ist).
// Gespeichert wird ein Enum nur nach aktiver Wahl (wie displayMode).
export const WIDGET_ENUMS = {
  courseCards: { options: COURSE_CARDS_OPTIONS, fallback: "off" },
  courseCardsPosition: {
    options: COURSE_CARDS_POSITION_OPTIONS,
    fallback: "below",
  },
  courseCardsAnswerStyle: {
    options: COURSE_CARDS_ANSWER_STYLE_OPTIONS,
    fallback: "short",
  },
  followUps: { options: FOLLOW_UPS_OPTIONS, fallback: "none" },
  inlineOpenOn: { options: INLINE_OPEN_ON_OPTIONS, fallback: "submit" },
  inlineLayout: { options: INLINE_LAYOUT_OPTIONS, fallback: "flow" },
  inlineEffect: { options: INLINE_EFFECT_OPTIONS, fallback: "" },
  suggestionStyle: { options: SUGGESTION_STYLE_OPTIONS, fallback: "bars" },
  greetingStyle: { options: GREETING_STYLE_OPTIONS, fallback: "text" },
  privacyNotice: { options: PRIVACY_NOTICE_OPTIONS, fallback: "none" },
  disclaimer: { options: DISCLAIMER_OPTIONS, fallback: "none" },
};

// Text-Schlüssel mit Höchstlänge wie der Server (WIDGET_TEXT_MAX)
export const WIDGET_TEXT_MAX = {
  inlineInputPlaceholder: 120,
  inlineSendText: 40,
  greetingBubbleText: 300,
  assistantSubtitle: 60,
  privacyTitle: 120,
  privacyButtonText: 40,
  disclaimerText: 160,
};
export const PRIVACY_POINTS_MAX = 5;
export const PRIVACY_POINT_MAX_LEN = 160;
export const PRIVACY_TEXT_MAX_LEN = 1000;
export const URL_MAX_LEN = 512;
export const WIDGET_BOOLEAN_KEYS = ["inlineInput", "onlineDot"];

// Felder mit Kufer-Standardtext (GET /embed/defaults): stehen als Wert im
// Feld, solange nichts gespeichert ist; gespeichert wird nur eine Abweichung.
export const DEFAULT_TEXT_KEYS = [
  "greetingBubbleText",
  "privacyTitle",
  "privacyText",
  "privacyButtonText",
  "disclaimerText",
];

// Felder, die beim aktuellen Stand ausgeblendet sind (Leiste nur im Inline-
// Modus, Unterfelder nur bei passender Wahl). Ausgeblendete Felder werden
// nicht geprüft (der Admin könnte sie nicht korrigieren); ungültige Werte
// darin verwirft cleanWidgetKeys beim Speichern.
export function hiddenWidgetKeys(config, { inline }) {
  const hidden = new Set();
  const inputBar = config.inlineInput === true;
  if (!inline || !inputBar)
    ["inlineOpenOn", "inlineInputPlaceholder", "inlineSendText"].forEach((k) =>
      hidden.add(k)
    );
  if (!inline) ["inlineLayout", "inlineEffect"].forEach((k) => hidden.add(k));
  if (enumValue(config.courseCards) !== "auto")
    ["courseCardsPosition", "courseCardsAnswerStyle"].forEach((k) =>
      hidden.add(k)
    );
  const notice = enumValue(config.privacyNotice);
  if (notice !== "bubble" && notice !== "modal")
    ["privacyTitle", "privacyText", "privacyUrl", "privacyButtonText"].forEach(
      (k) => hidden.add(k)
    );
  if (notice !== "modal") hidden.add("privacyButtonText");
  if (enumValue(config.disclaimer) !== "footer") hidden.add("disclaimerText");
  return hidden;
}

// Reiter, in dem ein Feld steht (für „Fehler korrigieren“ beim Speichern)
export const FIELD_TAB = {
  inlineOpenOn: "design",
  inlineLayout: "design",
  inlineEffect: "design",
  inlineInputPlaceholder: "design",
  inlineSendText: "design",
  suggestionStyle: "inhalt",
  greetingStyle: "inhalt",
  greetingBubbleText: "inhalt",
  assistantSubtitle: "inhalt",
  courseCards: "antworten",
  courseCardsPosition: "antworten",
  courseCardsAnswerStyle: "antworten",
  followUps: "antworten",
  privacyNotice: "antworten",
  privacyTitle: "antworten",
  privacyText: "antworten",
  privacyUrl: "antworten",
  privacyButtonText: "antworten",
  disclaimer: "antworten",
  disclaimerText: "antworten",
};

function isBlank(value) {
  return value === undefined || value === null || String(value).trim() === "";
}

export function enumValue(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : value;
}

// Datenschutz-Punkte wie validPrivacyText() im Server
export function splitPrivacyPoints(text) {
  if (typeof text !== "string") return [];
  return text
    .split(/\r?\n|\|/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

export function privacyTextError(value) {
  const v = String(value).trim();
  if (v.length > PRIVACY_TEXT_MAX_LEN)
    return `Maximal ${PRIVACY_TEXT_MAX_LEN} Zeichen insgesamt.`;
  const points = splitPrivacyPoints(v);
  if (points.length > PRIVACY_POINTS_MAX)
    return `Höchstens ${PRIVACY_POINTS_MAX} Punkte (ein Punkt je Zeile).`;
  const tooLong = points.findIndex((p) => p.length > PRIVACY_POINT_MAX_LEN);
  if (tooLong >= 0)
    return `Punkt ${tooLong + 1} ist zu lang (maximal ${PRIVACY_POINT_MAX_LEN} Zeichen je Punkt).`;
  return null;
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
 * Fehlermeldungen je Feld für gesetzte, ungültige Werte.
 * @param {Object} config aktuelle visual_config (Bearbeitungsstand)
 * @param {{inline: boolean}} opts Inline-Modus aktiv (Leisten-Felder sichtbar)
 * @returns {Object<string,string>}
 */
export function validateWidgetKeys(config, { inline }) {
  const errors = {};
  const hidden = hiddenWidgetKeys(config, { inline });
  const skip = (key) => hidden.has(key);
  for (const [key, { options }] of Object.entries(WIDGET_ENUMS)) {
    if (skip(key) || isBlank(config[key])) continue;
    const allowed = options.map((o) => o.value).filter(Boolean);
    if (!allowed.includes(enumValue(config[key])))
      errors[key] = "Ungültiger Wert — bitte eine Option wählen.";
  }
  for (const [key, max] of Object.entries(WIDGET_TEXT_MAX)) {
    if (skip(key) || isBlank(config[key])) continue;
    if (String(config[key]).trim().length > max)
      errors[key] = `Maximal ${max} Zeichen.`;
  }
  if (!skip("privacyText") && !isBlank(config.privacyText)) {
    const error = privacyTextError(config.privacyText);
    if (error) errors.privacyText = error;
  }
  if (
    !skip("privacyUrl") &&
    !isBlank(config.privacyUrl) &&
    !validPrivacyUrl(config.privacyUrl)
  )
    errors.privacyUrl =
      "Bitte eine https://-Adresse oder einen Pfad Ihrer Seite (z. B. /datenschutz) angeben.";
  return errors;
}

function sameAsDefault(key, value, defaults) {
  const standard = defaults?.[key];
  if (typeof standard !== "string") return false;
  if (key === "privacyText")
    return (
      splitPrivacyPoints(value).join("\n") ===
      splitPrivacyPoints(standard).join("\n")
    );
  return String(value).trim() === standard.trim();
}

/**
 * Vor dem Speichern: leere Felder entfernen (nie "" speichern), Texte
 * trimmen, Datenschutz-Punkte als „ein Punkt je Zeile“ normalisieren,
 * Standardtexte weglassen (leer = Widget-Standard), Enums klein schreiben.
 * Ungültige Werte (nur in ausgeblendeten Leisten-Feldern möglich) werden
 * verworfen. Es werden nie Schlüssel hinzugefügt.
 * @param {Object} config
 * @param {Object|null} defaults Standardtexte (GET /embed/defaults) oder null
 * @returns {Object}
 */
export function cleanWidgetKeys(config, defaults = null) {
  const cleaned = { ...config };
  const drop = (key) => delete cleaned[key];
  for (const [key, { options }] of Object.entries(WIDGET_ENUMS)) {
    if (!(key in cleaned)) continue;
    const v = enumValue(cleaned[key]);
    const allowed = options.map((o) => o.value).filter(Boolean);
    if (allowed.includes(v)) cleaned[key] = v;
    else drop(key);
  }
  for (const [key, max] of Object.entries(WIDGET_TEXT_MAX)) {
    if (!(key in cleaned)) continue;
    const v = isBlank(cleaned[key]) ? "" : String(cleaned[key]).trim();
    if (!v || v.length > max || sameAsDefault(key, v, defaults)) drop(key);
    else cleaned[key] = v;
  }
  if ("privacyText" in cleaned) {
    const v = isBlank(cleaned.privacyText) ? "" : String(cleaned.privacyText);
    if (!v || privacyTextError(v) || sameAsDefault("privacyText", v, defaults))
      drop("privacyText");
    else cleaned.privacyText = splitPrivacyPoints(v).join("\n");
  }
  if ("privacyUrl" in cleaned) {
    if (validPrivacyUrl(cleaned.privacyUrl))
      cleaned.privacyUrl = cleaned.privacyUrl.trim();
    else drop("privacyUrl");
  }
  for (const key of WIDGET_BOOLEAN_KEYS)
    if (key in cleaned && typeof cleaned[key] !== "boolean") drop(key);
  return cleaned;
}

// Wert für die Anzeige: gespeicherter/bearbeiteter Wert, sonst Standardtext
export function displayedText(config, key, defaults) {
  if (key in config && config[key] !== undefined && config[key] !== null)
    return String(config[key]);
  return defaults?.[key] ?? "";
}
