// Bereich „Chatbot“ der Einstellungen (KB-2): Status, Konversationen, Design
// Center und Widgets. Status, Konversationen und Design Center zeigen ein
// Widget; die Wahl gilt für alle drei:
//
// 1. widget=<id> in der Adresse (Menülinks und Abkürzungen der Widget-Zeile
//    tragen sie mit),
// 2. sonst das zuletzt gewählte Widget dieses Nutzers (Browser-Speicher),
// 3. sonst die Vorauswahl: das Widget mit der jüngsten Nachricht
//    (utils/embedLabel mostRecentlyActiveEmbedId).
//
// Auflösen und Wählen: pages/GeneralSettings/ChatEmbedWidgets/WidgetSelection.

export const PARAM_WIDGET = "widget";

/**
 * Positive ganze Zahl aus einem Parameter, sonst null.
 * @param {string|null} value
 * @returns {number|null}
 */
export function positiveId(value) {
  if (typeof value !== "string" || !/^[1-9]\d{0,15}$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : null;
}

/**
 * Das Widget aus dem Suchteil einer Adresse („?widget=3“), sonst null.
 * @param {string} search
 * @returns {number|null}
 */
export function widgetFromSearch(search) {
  return positiveId(new URLSearchParams(search ?? "").get(PARAM_WIDGET));
}

/**
 * Adresse einer Ansicht mit gesetztem Widget; ohne Widget unverändert.
 * @param {string} href - z. B. paths.settings.chatbot.design()
 * @param {number|string|null} widgetId
 * @returns {string}
 */
export function withWidget(href, widgetId) {
  if (widgetId === null || widgetId === undefined || widgetId === "")
    return href;
  return `${href}?${PARAM_WIDGET}=${encodeURIComponent(widgetId)}`;
}

const storageKey = (userId) =>
  userId ? `kie.chatbot.widget.${userId}` : "kie.chatbot.widget";

/**
 * Das zuletzt gewählte Widget dieses Nutzers. Ohne Browser-Speicher (privates
 * Fenster, gesperrt) null.
 * @param {number|string|null} userId
 * @returns {number|null}
 */
export function rememberedWidget(userId) {
  try {
    return positiveId(window.localStorage.getItem(storageKey(userId)));
  } catch {
    return null;
  }
}

/**
 * Merkt sich das gewählte Widget für den nächsten Aufruf ohne widget=.
 * @param {number|string|null} userId
 * @param {number} widgetId
 */
export function rememberWidget(userId, widgetId) {
  try {
    window.localStorage.setItem(storageKey(userId), String(widgetId));
  } catch {
    // ohne Browser-Speicher gilt beim nächsten Mal die Vorauswahl
  }
}
