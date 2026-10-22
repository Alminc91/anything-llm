import createDOMPurify from "dompurify";
import { answerPurifyConfig, hardenAnswerHtml } from "@/utils/conversationView";

// Bereinigung der Antworten im Verlauf der Konversationen (Admin-Ansicht;
// Review 7.22-rc12, K14; Fixliste 7.22-rc13, E13). Eine eigene Instanz von
// DOMPurify: Die gemeinsame (utils/chat/purify.js) hat eine feste
// Einstellung (setConfig) für den Chat, die Einstellungen eines Aufrufs
// übergeht – und sie gilt für den Chat unverändert weiter.
// Angelegt beim ersten Aufruf, nicht beim Laden des Moduls: Ohne Browser
// (Test-Renderer) gibt es kein Dokument.
// Seit Fixliste 7.22-rc22 (E39) die zweite Sicherung: Die erste ist
// html: false im MarkdownRenderer, rohes HTML der Antwort ist dort schon
// Text.

let purify = null;

/**
 * Bereinigtes HTML einer Antwort für den Verlauf: DOMPurify mit
 * answerPurifyConfig in einem inerten Dokument, danach hardenAnswerHtml
 * (Links in neuem Tab mit rel="noopener noreferrer", Bilder als Link statt
 * Abruf, Klassen nur aus Markdown). Erst das Ergebnis kommt in die Seite.
 * searchHits: true nur für den Durchgang nach der eigenen Hervorhebung –
 * dann bleibt data-search-hit an deren <mark> (Review 7.22-rc15, K41);
 * über das HTML der Antwort läuft der erste Durchgang immer ohne.
 * @param {string} html - gerendertes Markdown
 * @param {{searchHits?: boolean}} [options]
 * @returns {string}
 */
export default function sanitizeAnswerHtml(html, { searchHits = false } = {}) {
  if (!purify) {
    const created = createDOMPurify(
      typeof window === "undefined" ? undefined : window
    );
    // Ohne Dokument kein ungeprüftes HTML: lieber ein Fehler
    if (!created.isSupported)
      throw new Error("DOMPurify braucht ein Dokument (Browser).");
    purify = created;
  }
  const body = purify.sanitize(String(html ?? ""), {
    ...answerPurifyConfig({ searchHits }),
    RETURN_DOM: true,
  });
  hardenAnswerHtml(body, body.ownerDocument, { searchHits });
  return body.innerHTML;
}
