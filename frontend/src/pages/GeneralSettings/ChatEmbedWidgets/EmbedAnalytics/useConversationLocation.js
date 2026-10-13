import { useCallback, useMemo } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";

// Zustand der Ansicht „Konversationen" in der Adresse – eine Quelle der
// Wahrheit für Widget, geöffnete Konversation und Suche:
//
//   /settings/chatbot/conversations?widget=3&conversation=1234&q=spanisch
//
// - widget: id des Widgets (fehlt = das erste in der Reihenfolge des Servers)
// - conversation: id einer Zeile der Konversation (first_chat_id der Liste) –
//   eine Zahl des Servers, nicht die Kennung des Besuchers (KIE-538).
// - q: Suchbegriff der Liste
//
// Öffnen einer Konversation aus der geschlossenen Liste legt einen Eintrag im
// Verlauf an: Der Zurück-Knopf des Browsers schließt sie wieder. Alles andere
// – eine andere Konversation bei offenem Panel, vorherige/nächste, Suche,
// Widget – ersetzt den aktuellen Eintrag.

export const PARAM_WIDGET = "widget";
export const PARAM_CONVERSATION = "conversation";
export const PARAM_SEARCH = "q";

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
 * @returns {{
 *   widgetId: number|null,
 *   chatId: number|null,
 *   search: string,
 *   openConversation: (chatId: number, options?: {widgetId?: number}) => void,
 *   closeConversation: () => void,
 *   setSearch: (term: string) => void,
 *   setWidget: (widgetId: number) => void,
 *   clearLink: () => void,
 *   conversationUrl: (chatId: number, widgetId: number) => string,
 * }}
 */
export default function useConversationLocation() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();

  const widgetId = positiveId(params.get(PARAM_WIDGET));
  const chatId = positiveId(params.get(PARAM_CONVERSATION));
  const search = params.get(PARAM_SEARCH) ?? "";
  const state = location.state;

  const update = useCallback(
    (change, { push = false, nextState = state } = {}) =>
      setParams(
        (current) => {
          const next = new URLSearchParams(current);
          change(next);
          return next;
        },
        { replace: !push, state: nextState }
      ),
    [setParams, state]
  );

  const openConversation = useCallback(
    (id, { widgetId: widget } = {}) => {
      // Aus der geschlossenen Liste: neuer Eintrag (Zurück schließt). Ist
      // schon eine Konversation offen, wird ersetzt.
      const push = chatId === null;
      update(
        (next) => {
          if (widget) next.set(PARAM_WIDGET, String(widget));
          next.set(PARAM_CONVERSATION, String(id));
        },
        push
          ? {
              push: true,
              nextState: {
                ...(state ?? {}),
                conversationOpened: true,
                searchWhenOpened: search,
              },
            }
          : {}
      );
    },
    [chatId, update, state, search]
  );

  const closeConversation = useCallback(() => {
    // Selbst geöffnet und seither nicht gesucht: einen Schritt zurück – der
    // Eintrag davor ist die Liste. Sonst (Link, geänderte Suche) entfernen.
    if (
      state?.conversationOpened &&
      state.searchWhenOpened === search &&
      typeof window !== "undefined" &&
      window.history?.length > 1
    ) {
      navigate(-1);
      return;
    }
    update((next) => next.delete(PARAM_CONVERSATION), {
      nextState: null,
    });
  }, [state, search, navigate, update]);

  const setSearch = useCallback(
    (term) =>
      update((next) => {
        if (term) next.set(PARAM_SEARCH, term);
        else next.delete(PARAM_SEARCH);
      }),
    [update]
  );

  const setWidget = useCallback(
    (id) =>
      update(
        (next) => {
          next.set(PARAM_WIDGET, String(id));
          next.delete(PARAM_CONVERSATION);
        },
        { nextState: null }
      ),
    [update]
  );

  const clearLink = useCallback(
    () =>
      update(
        (next) => {
          next.delete(PARAM_WIDGET);
          next.delete(PARAM_CONVERSATION);
        },
        { nextState: null }
      ),
    [update]
  );

  // Der Link zum Kopieren nennt nur Widget und Konversation – nicht den
  // Suchbegriff: Er ist oft ein Name oder eine E-Mail-Adresse und landete so
  // in Mails, Tickets und Protokollen (Datenminimierung). In der Adressleiste
  // bleibt q (AK-14).
  const conversationUrl = useCallback(
    (id, widget) => {
      const next = new URLSearchParams();
      next.set(PARAM_WIDGET, String(widget));
      next.set(PARAM_CONVERSATION, String(id));
      const origin =
        typeof window !== "undefined" ? (window.location?.origin ?? "") : "";
      return `${origin}${location.pathname}?${next.toString()}`;
    },
    [location.pathname]
  );

  return useMemo(
    () => ({
      widgetId,
      chatId,
      search,
      openConversation,
      closeConversation,
      setSearch,
      setWidget,
      clearLink,
      conversationUrl,
    }),
    [
      widgetId,
      chatId,
      search,
      openConversation,
      closeConversation,
      setSearch,
      setWidget,
      clearLink,
      conversationUrl,
    ]
  );
}
