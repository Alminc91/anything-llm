import { useLocation, useNavigationType } from "react-router-dom";
import ConversationList from "@/pages/GeneralSettings/ChatEmbedWidgets/EmbedAnalytics/ConversationList";

// Nur für Tests (KIE-575): Die Konversationsliste mit einer Sonde für die
// Adresse daneben – was steht in der Suche der Adresse (?widget=…), und war
// die letzte Navigation ein neuer Eintrag (PUSH) oder ein Ersetzen (REPLACE)?
export default function ConversationListProbe(props) {
  const location = useLocation();
  const navigationType = useNavigationType();
  return (
    <>
      <span
        data-location-search={location.search}
        data-navigation-type={navigationType}
      />
      <ConversationList {...props} />
    </>
  );
}
