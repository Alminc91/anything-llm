import Sidebar from "@/components/SettingsSidebar";
import { isMobile } from "react-device-detect";
import { Navigate, useLocation, useParams } from "react-router-dom";
import { FullScreenLoader } from "@/components/Preloader";
import { useCanViewChatHistory } from "@/components/CanViewChatHistory";
import paths from "@/utils/paths";
import { withWidget } from "@/utils/chatbotArea";
import EmbedConfigsView from "./EmbedConfigs";
import EmbedAnalyticsView from "./EmbedAnalytics";
import EmbedAppearance from "./EmbedAppearance";
import {
  WidgetPicker,
  useChatbotWidgets,
  useWidgetSelection,
} from "./WidgetSelection";

// Bereich „Chatbot" (KIE-535): Jede Ansicht hat eine eigene Adresse unter
// /settings/chatbot/…; die Auswahl übernimmt die Einstellungs-Sidebar. Diese
// Datei liefert nur noch den Seitenrahmen – die frühere Auswahlspalte und der
// mobile Zwischenschritt Liste → Vollbild entfallen.

/** /settings/chatbot/widgets */
export function ChatbotWidgets() {
  return (
    <ChatbotLayout>
      <EmbedConfigsView />
    </ChatbotLayout>
  );
}

/**
 * /settings/chatbot/conversations – über die volle Breite (KIE-575): Der
 * Arbeitsbereich aus Liste und Verlauf braucht sie; Kennzahlen und
 * Diagramme sind responsiv.
 */
export function ChatbotConversations() {
  return (
    <RequiresChatHistory>
      <ChatbotLayout fullWidth>
        <EmbedAnalyticsView />
      </ChatbotLayout>
    </RequiresChatHistory>
  );
}

/**
 * /settings/chatbot/status (KB-2, Platzhalter bis KB-3): Der Menüpunkt ist
 * ausgeblendet (utils/chatbotArea STATUS_PAGE_READY); die Adresse führt mit
 * demselben Widget zu „Konversationen“. KB-3 setzt hier die Statusseite ein
 * (ChatbotLayout, oben die gemeinsame Widget-Auswahl aus WidgetSelection)
 * und schaltet STATUS_PAGE_READY ein.
 */
export function ChatbotStatus() {
  const { search } = useLocation();
  return (
    <Navigate
      to={`${paths.settings.chatbot.conversations()}${search}`}
      replace
    />
  );
}

/**
 * /settings/chatbot/design?widget=<id> (KB-2): das Design Center des
 * gewählten Widgets, weiter als Vollbildseite (KIE-535, AK-7). Die
 * Widget-Auswahl steht oben rechts in der Kopfzeile; ein Wechsel lädt das
 * Design Center des anderen Widgets.
 */
export function ChatbotDesignCenter() {
  const { loaded, embeds, lastActivity } = useChatbotWidgets();
  if (!loaded)
    return (
      <div className="w-full h-full flex items-center justify-center">
        <p className="text-theme-text-secondary">Laden...</p>
      </div>
    );
  // Ohne sichtbares Widget gibt es nichts zu gestalten: zur Widget-Liste,
  // dort lässt sich eines anlegen.
  if (embeds.length === 0)
    return <Navigate to={paths.settings.chatbot.widgets()} replace />;
  return <DesignCenterOf embeds={embeds} lastActivity={lastActivity} />;
}

function DesignCenterOf({ embeds, lastActivity }) {
  const { widgetId, selectWidget } = useWidgetSelection({
    embeds,
    lastActivity,
  });
  return (
    <EmbedAppearance
      key={widgetId}
      embedId={widgetId}
      widgetPicker={
        <WidgetPicker
          embeds={embeds}
          selectedId={widgetId}
          onSelect={selectWidget}
        />
      }
    />
  );
}

/**
 * Frühere Adresse des Design Centers (/settings/embed-config/:embedId/
 * appearance): Lesezeichen führen auf die neue Adresse mit diesem Widget.
 */
export function DesignCenterRedirect() {
  const { embedId } = useParams();
  return (
    <Navigate
      to={withWidget(paths.settings.chatbot.design(), embedId)}
      replace
    />
  );
}

/**
 * „Konversationen" bleibt an den einsehbaren Chat-Verlauf gebunden. Ist er
 * abgeschaltet, wird die Ansicht gar nicht erst eingehängt (keine Abfragen)
 * und auf die Widget-Liste umgeleitet. Das gilt auch für die frühere Adresse
 * der Nachrichtentabelle (/settings/chatbot/messages, KIE-538), die auf
 * „Konversationen" umleitet.
 * @param {{children: React.ReactNode}} props
 */
function RequiresChatHistory({ children }) {
  const { loading, viewable } = useCanViewChatHistory();
  if (loading) return <FullScreenLoader />;
  if (!viewable)
    return <Navigate to={paths.settings.chatbot.widgets()} replace />;
  return <>{children}</>;
}

/**
 * @param {{children: React.ReactNode, fullWidth?: boolean}} props -
 *   fullWidth: ohne die Obergrenze von 1180 px (Konversationen, KIE-575);
 *   die Widget-Liste behält sie.
 */
function ChatbotLayout({ children, fullWidth = false }) {
  return (
    <div className="w-screen h-screen overflow-hidden bg-theme-bg-container flex">
      <Sidebar />
      <div
        style={{ height: isMobile ? "100%" : "calc(100% - 32px)" }}
        className="relative md:ml-[2px] md:mr-[16px] md:my-[16px] md:rounded-[16px] bg-theme-bg-secondary w-full min-w-0 h-full overflow-y-scroll p-4 md:p-0"
      >
        {/* Inhalt linksbündig über die volle Breite, höchstens 1180 px –
            außer die Ansicht braucht die ganze Breite (fullWidth). Der
            Abstand oben hält die Kopfzeilen der Ansichten unter dem
            Benutzermenü (oben rechts) bzw. mobil unter der Kopfleiste. */}
        <div
          data-chatbot-content={fullWidth ? "full" : "capped"}
          className={`w-full ${fullWidth ? "" : "max-w-[1180px] "}text-white py-16 md:pt-12 md:pb-6`}
        >
          {children}
        </div>
      </div>
    </div>
  );
}
