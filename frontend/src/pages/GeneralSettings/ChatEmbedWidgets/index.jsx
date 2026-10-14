import Sidebar from "@/components/SettingsSidebar";
import { isMobile } from "react-device-detect";
import { Navigate } from "react-router-dom";
import { FullScreenLoader } from "@/components/Preloader";
import { useCanViewChatHistory } from "@/components/CanViewChatHistory";
import paths from "@/utils/paths";
import EmbedConfigsView from "./EmbedConfigs";
import EmbedAnalyticsView from "./EmbedAnalytics";

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

/** /settings/chatbot/conversations */
export function ChatbotConversations() {
  return (
    <RequiresChatHistory>
      <ChatbotLayout>
        <EmbedAnalyticsView />
      </ChatbotLayout>
    </RequiresChatHistory>
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

function ChatbotLayout({ children }) {
  return (
    <div className="w-screen h-screen overflow-hidden bg-theme-bg-container flex">
      <Sidebar />
      <div
        style={{ height: isMobile ? "100%" : "calc(100% - 32px)" }}
        className="relative md:ml-[2px] md:mr-[16px] md:my-[16px] md:rounded-[16px] bg-theme-bg-secondary w-full min-w-0 h-full overflow-y-scroll p-4 md:p-0"
      >
        {/* Inhalt linksbündig über die volle Breite, höchstens 1180 px. Der
            Abstand oben hält die Kopfzeilen der Ansichten unter dem
            Benutzermenü (oben rechts) bzw. mobil unter der Kopfleiste. */}
        <div className="w-full max-w-[1180px] text-white py-16 md:pt-12 md:pb-6">
          {children}
        </div>
      </div>
    </div>
  );
}
