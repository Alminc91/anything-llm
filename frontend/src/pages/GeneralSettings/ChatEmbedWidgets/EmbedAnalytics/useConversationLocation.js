import { useCallback, useEffect, useMemo } from "react";
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
// Widget – ersetzt den aktuellen Eintrag. Ab lg (KIE-575) ist der Verlauf
// ein Arbeitsbereich neben der Liste, der von sich aus offen ist: Dort
// ersetzt auch ein Klick aus der Liste (Option replace) – Zurück verlässt
// die Seite, statt die Konversation zu schließen. Die automatische Vorwahl
// der ersten Zeile schreibt nichts in die Adresse.

export const PARAM_WIDGET = "widget";
export const PARAM_CONVERSATION = "conversation";
export const PARAM_SEARCH = "q";

/**
 * Die zuletzt geschriebene, noch nicht angekommene Adresse (Fixliste 7,
 * F04). setSearchParams berechnet eine Änderung gegen die Parameter des
 * Renders, in dem sie aufgerufen wird – auch in der Form mit Funktion (react-
 * router-dom 6.25). Schreiben zwei Teile der Ansicht im selben Durchlauf
 * (die Liste kürzt q, die Kopfzeile entfernt ein fremdes Widget), hob die
 * zweite Änderung die erste auf. Deshalb baut jede Änderung auf der
 * Adresse auf, die zuletzt geschrieben wurde – solange die Navigation noch
 * nicht gerendert ist (gleicher Verlaufseintrag, gleiche Adresse). Eine
 * Stelle für alle Teile der Ansicht: auf Modulebene, je Fenster ein Router.
 * Der Verlaufseintrag (location.key) genügt als Merkmal: Der Router vergibt
 * bei jeder Navigation einen neuen, auch beim Ersetzen – gleicher Schlüssel
 * heißt gleiche Adresse (Fixliste 8, C5).
 * @type {{key: string, to: string}|null}
 */
let pendingSearch = null;

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
 *   openConversation: (chatId: number, options?: {widgetId?: number, replace?: boolean}) => void,
 *   closeConversation: () => void,
 *   unlinkConversation: () => void,
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

  // Ist eine geschriebene Adresse angekommen (anderer Verlaufseintrag),
  // gilt sie nicht mehr als ausstehend – auch nicht, wenn der Zurück-Knopf
  // später auf den Eintrag zurückführt, in dem sie geschrieben wurde.
  useEffect(() => {
    if (pendingSearch && pendingSearch.key !== location.key)
      pendingSearch = null;
  }, [location.key]);
  useEffect(
    () => () => {
      pendingSearch = null;
    },
    []
  );

  const update = useCallback(
    (change, { push = false, nextState = state } = {}) => {
      const base =
        pendingSearch && pendingSearch.key === location.key
          ? pendingSearch.to
          : location.search;
      const next = new URLSearchParams(base);
      change(next);
      pendingSearch = { key: location.key, to: `?${next.toString()}` };
      setParams(next, { replace: !push, state: nextState });
    },
    [setParams, state, location.key, location.search]
  );

  const openConversation = useCallback(
    (id, { widgetId: widget, replace = false } = {}) => {
      // Aus der geschlossenen Liste: neuer Eintrag (Zurück schließt). Ist
      // schon eine Konversation offen – oder soll der Eintrag ohnehin
      // ersetzt werden (Arbeitsbereich ab lg) –, wird ersetzt.
      const push = chatId === null && !replace;
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

  // Die Konversation nur aus der Adresse nehmen – ohne Schritt zurück, als
  // Ersetzen des aktuellen Eintrags (KIE-575): Nach einem Wechsel von
  // Zeitraum, Filter oder Suche steht sie nicht mehr in der Liste; die
  // Ansicht wählt dann die erste Zeile vor, und die Adresse nennt keine
  // Konversation mehr, die nicht zu sehen ist.
  const unlinkConversation = useCallback(
    () =>
      update((next) => next.delete(PARAM_CONVERSATION), {
        nextState: null,
      }),
    [update]
  );

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
      unlinkConversation,
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
      unlinkConversation,
      setSearch,
      setWidget,
      clearLink,
      conversationUrl,
    ]
  );
}
