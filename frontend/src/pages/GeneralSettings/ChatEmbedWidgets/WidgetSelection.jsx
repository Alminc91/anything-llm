import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";
import { CaretDown, Check } from "@phosphor-icons/react";
import Embed from "@/models/embed";
import useUser from "@/hooks/useUser";
import showToast from "@/utils/toast";
import {
  embedLabels,
  mostRecentlyActiveEmbedId,
  sortEmbedsByLabel,
} from "@/utils/embedLabel";
import {
  PARAM_WIDGET,
  positiveId,
  rememberWidget,
  rememberedWidget,
} from "@/utils/chatbotArea";
import { MUTED } from "@/utils/conversationView";
import { useDismiss } from "./EmbedAnalytics/viewHooks";

// Gemeinsame Widget-Auswahl des Bereichs „Chatbot“ (KB-2) für Status,
// Konversationen und Design Center: Widgets laden, das gezeigte Widget
// bestimmen (Merkregel in utils/chatbotArea) und die Auswahl oben auf der
// Seite. Bei genau einem Widget gibt es nichts zu wählen.

/**
 * Die Widgets, die der Nutzer sehen darf (der Server filtert nach seinen
 * Rechten), und ihre letzte Nachricht für die Vorauswahl. Beides
 * nebeneinander (Fixliste 6, N2): Die Vorauswahl steht fest, bevor die
 * Ansicht etwas lädt.
 * @returns {{loaded: boolean, embeds: Array<object>, lastActivity: Array<{embedId: number, lastMessageAt: number|null}>|null}}
 */
export function useChatbotWidgets() {
  const [state, setState] = useState({
    loaded: false,
    embeds: [],
    lastActivity: null,
  });
  useEffect(() => {
    let ignore = false;
    Promise.all([Embed.embeds(), Embed.lastActivity()]).then(
      ([embeds, lastActivity]) => {
        if (ignore) return;
        // Auch ohne Widget ist das Laden beendet, sonst bliebe „Laden…“ stehen.
        setState({ loaded: true, embeds: embeds || [], lastActivity });
      }
    );
    return () => {
      ignore = true;
    };
  }, []);
  return state;
}

/**
 * Das gezeigte Widget: widget= aus der Adresse, sonst das zuletzt gewählte,
 * sonst das mit der jüngsten Nachricht. Ein Widget in der Adresse, das der
 * Nutzer nicht sieht (fremd, gelöscht), meldet einen Hinweis und wird aus
 * der Adresse genommen; gezeigt wird dann die Vorauswahl.
 * @param {object} options
 * @param {Array<{id: number}>} options.embeds - sichtbare Widgets
 * @param {Array<object>|null} [options.lastActivity]
 * @param {(id: number) => void} [options.setWidget] - schreibt widget= (die
 *   Konversationen nehmen dabei auch die geöffnete Konversation heraus)
 * @param {() => void} [options.clearWidget] - nimmt widget= heraus
 * @param {string} [options.notFoundText] - Hinweis bei fremdem Widget
 * @returns {{widgetId: number|null, unknownLink: boolean, selectWidget: (id: number) => void}}
 */
export function useWidgetSelection({
  embeds,
  lastActivity = null,
  setWidget = null,
  clearWidget = null,
  notFoundText = null,
}) {
  const { t } = useTranslation();
  const { user } = useUser();
  const userId = user?.id ?? null;
  const [params, setParams] = useSearchParams();

  const linkedId = positiveId(params.get(PARAM_WIDGET));
  const linked = embeds.some((embed) => embed.id === linkedId);
  const unknownLink = linkedId !== null && !linked;
  const remembered = rememberedWidget(userId);
  const preferred = useMemo(
    () =>
      embeds.some((embed) => embed.id === remembered)
        ? remembered
        : mostRecentlyActiveEmbedId(embeds, lastActivity),
    [embeds, lastActivity, remembered]
  );
  const widgetId = linked ? linkedId : preferred;

  // Ein Widget aus der Adresse (Menülink, Abkürzung, Lesezeichen) gilt als
  // gewählt: Ohne widget= zeigt der Bereich es beim nächsten Mal wieder.
  useEffect(() => {
    if (linked) rememberWidget(userId, linkedId);
  }, [linked, linkedId, userId]);

  // widget= in der Adresse setzen (id) oder herausnehmen (null)
  const updateWidgetParam = useCallback(
    (id) => {
      if (id !== null && setWidget) return setWidget(id);
      if (id === null && clearWidget) return clearWidget();
      setParams(
        (current) => {
          const next = new URLSearchParams(current);
          if (id === null) next.delete(PARAM_WIDGET);
          else next.set(PARAM_WIDGET, String(id));
          return next;
        },
        { replace: true }
      );
    },
    [setWidget, clearWidget, setParams]
  );

  const hint = notFoundText ?? t("embed-analytics.widget-not-found");
  useEffect(() => {
    if (!unknownLink) return;
    showToast(hint, "error");
    updateWidgetParam(null);
  }, [unknownLink, updateWidgetParam, hint]);

  const selectWidget = useCallback(
    (id) => {
      rememberWidget(userId, id);
      updateWidgetParam(id);
    },
    [userId, updateWidgetParam]
  );

  return { widgetId, unknownLink, selectWidget };
}

/**
 * Auswahl des Widgets oben auf der Seite. Bei höchstens einem Widget gibt es
 * nichts zu wählen: keine Auswahl.
 * @param {{embeds: Array<object>, selectedId: number|null, onSelect: (id: number) => void}} props
 */
export function WidgetPicker({ embeds, selectedId, onSelect }) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const dropdownRef = useRef(null);
  const buttonRef = useRef(null);

  // Klick außerhalb oder Escape schließt die Auswahl, der Fokus geht auf die
  // Schaltfläche zurück, wie Exportmenü und Menü „⋯“ (Fixliste 7, B5).
  const close = useCallback(() => setOpen(false), []);
  useDismiss(dropdownRef, open, close, { focusRef: buttonRef });

  // Ein Widget heißt wie sein Workspace; die Widget-Nummer kommt nur dazu, wo
  // die Bezeichnung in dieser Liste mehrfach vorkommt (utils/embedLabel).
  const labels = useMemo(() => embedLabels(embeds, t), [embeds, t]);
  const options = useMemo(
    () => sortEmbedsByLabel(embeds, labels, i18n.language),
    [embeds, labels, i18n.language]
  );
  if (embeds.length <= 1) return null;

  const embedLabel = (embed) => labels.get(embed.id)?.label;
  const current = embeds.find((e) => e.id === selectedId);

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        type="button"
        ref={buttonRef}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={t("embed-analytics.widget-label")}
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 bg-theme-settings-input-bg text-theme-text-primary rounded-lg px-4 py-2 text-sm border border-white/10 cursor-pointer"
      >
        <span>
          {current ? embedLabel(current) : t("embed-analytics.select-embed")}
        </span>
        <CaretDown
          size={12}
          className={`text-theme-text-primary ml-1 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {/* Nicht gewählte Optionen gedämpft wie die übrige Ansicht
          (MUTED: hell #5f6368, 6:1 auf Weiß statt 4,15:1 mit
          --theme-text-secondary, Fixliste 8, Opus Low 2). */}
      {open && (
        <div
          role="listbox"
          aria-label={t("embed-analytics.widget-label")}
          className="absolute left-0 top-full mt-1 w-full bg-theme-bg-secondary border border-white/10 rounded-lg shadow-xl z-50 overflow-hidden"
        >
          {options.map((embed) => (
            <button
              key={embed.id}
              type="button"
              role="option"
              aria-selected={selectedId === embed.id}
              onClick={() => {
                onSelect(embed.id);
                setOpen(false);
              }}
              className={`flex items-center justify-between w-full px-3 py-2 text-sm text-left transition-all cursor-pointer
                ${selectedId === embed.id ? "bg-white/10 text-theme-text-primary font-medium" : `${MUTED} hover:bg-white/5 hover:text-theme-text-primary`}`}
            >
              <span>{embedLabel(embed)}</span>
              {selectedId === embed.id && (
                <Check
                  size={14}
                  className="text-theme-text-primary"
                  weight="bold"
                />
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
