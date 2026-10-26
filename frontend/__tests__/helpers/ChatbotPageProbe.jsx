import { useLocation } from "react-router-dom";
import { ChatbotDesignCenter } from "@/pages/GeneralSettings/ChatEmbedWidgets";

// Nur für Tests (KB-2): eine Sonde für die Adresse, allein (Ziel einer
// Umleitung) oder neben einer Seite des Bereichs „Chatbot“.

/** Zeigt Pfad und Suche der aufgerufenen Adresse. */
export function LocationProbe() {
  const location = useLocation();
  return <span data-location={`${location.pathname}${location.search}`} />;
}

/** Das Design Center mit der Sonde daneben. */
export default function DesignCenterProbe() {
  return (
    <>
      <LocationProbe />
      <ChatbotDesignCenter />
    </>
  );
}
