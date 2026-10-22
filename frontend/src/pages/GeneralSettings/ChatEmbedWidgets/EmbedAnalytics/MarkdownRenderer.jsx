import { memo, useMemo, useState } from "react";
import MarkdownIt from "markdown-it";
import hljs from "highlight.js";
import { CaretDown } from "@phosphor-icons/react";
import "highlight.js/styles/github-dark.css";
import sanitizeAnswerHtml from "@/utils/chat/purifyConversation";
import { useTranslation } from "react-i18next";
import {
  highlightTextNodes,
  searchPattern,
  tableAlignAttributes,
} from "@/utils/conversationView";

// tableAlignAttributes: Ausrichtung der Tabellenspalten als align statt
// style (style ist im Verlauf verboten; Review 7.22-rc15, K43)
const md = new MarkdownIt({
  html: true,
  breaks: true,
  highlight: function (str, lang) {
    if (lang && hljs.getLanguage(lang)) {
      try {
        return hljs.highlight(str, { language: lang }).value;
      } catch {}
    }
    return ""; // use external default escaping
  },
}).use(tableAlignAttributes);

const ThoughtBubble = ({ thought }) => {
  const { t } = useTranslation();
  const [isExpanded, setIsExpanded] = useState(false);

  if (!thought) return null;

  const cleanThought = thought.replace(/<\/?think>/g, "").trim();
  if (!cleanThought) return null;

  return (
    <div className="mb-3">
      <div
        onClick={() => setIsExpanded(!isExpanded)}
        className="cursor-pointer flex items-center gap-x-2 text-theme-text-secondary hover:text-theme-text-primary transition-colors mb-2"
      >
        <CaretDown
          size={14}
          weight="bold"
          className={`transition-transform ${isExpanded ? "rotate-180" : ""}`}
        />
        <span className="text-xs font-medium">
          {t("chat-row.view-thoughts")}
        </span>
      </div>
      {isExpanded && (
        <div className="bg-theme-bg-chat-input rounded-md p-3 border-l-2 border-theme-text-secondary/30">
          <div className="text-xs text-theme-text-secondary font-mono whitespace-pre-wrap">
            {cleanThought}
          </div>
        </div>
      )}
    </div>
  );
};

function parseContent(content) {
  const parts = [];
  let lastIndex = 0;
  content.replace(/<think>([^]*?)<\/think>/g, (match, thinkContent, offset) => {
    if (offset > lastIndex) {
      parts.push({ type: "normal", text: content.slice(lastIndex, offset) });
    }
    parts.push({ type: "think", text: thinkContent });
    lastIndex = offset + match.length;
  });
  if (lastIndex < content.length) {
    parts.push({ type: "normal", text: content.slice(lastIndex) });
  }
  return parts;
}

/**
 * Bereinigtes HTML einer Antwort, die Treffer der Suche als <mark> markiert.
 * Bereinigt wird strenger als im Chat (sanitizeAnswerHtml, Fixliste
 * 7.22-rc13 E13): kein style, Links in neuem Tab mit rel="noopener
 * noreferrer", Bilder als Link statt Abruf – der Verlauf öffnet sich auf dem
 * Desktop von selbst. Hervorgehoben wird nach dem Bereinigen in einem
 * inaktiven Dokument (DOMParser: keine Skripte, keine Ladevorgänge) und nur
 * in Textknoten – aus Nutzertext entsteht kein HTML. Das Ergebnis wird noch
 * einmal bereinigt. Erst dieser zweite Durchgang lässt data-search-hit an
 * den eigenen <mark> stehen; der erste verwirft es, damit die Antwort keine
 * eigenen „Treffer“ mitbringt (Review 7.22-rc15, K41).
 * @param {string} html - gerendertes Markdown
 * @param {string} highlight - Suchbegriff ("" = keine Hervorhebung)
 * @returns {string}
 */
function sanitizedHtml(html, highlight) {
  const clean = sanitizeAnswerHtml(html);
  if (!searchPattern(highlight) || typeof DOMParser === "undefined")
    return clean;
  const doc = new DOMParser().parseFromString(clean, "text/html");
  if (highlightTextNodes(doc.body, highlight, doc) === 0) return clean;
  return sanitizeAnswerHtml(doc.body.innerHTML, { searchHits: true });
}

/**
 * Zeigt der Verlauf in dieser Antwort einen Treffer der Suche? Dieselbe
 * Darstellung wie MarkdownRenderer: ohne <think>-Blöcke (eingeklappt),
 * Markdown, sanitizeAnswerHtml, dann highlightTextNodes. Sichtbar ist, was
 * der Verlauf hervorhebt; ein Begriff nur in Link-Adressen, im Quelltext,
 * in verworfenem HTML oder in ausgeblendeten Gedanken ist es nicht
 * (hasVisibleHit, Hinweis im Kopf des Verlaufs; Nachreview 7.22-rc19, K81
 * bis K86). Dazu der Text des bereinigten Körpers: Ein Begriff über die
 * Grenzen von Textknoten, etwa über die Token der Syntaxhervorhebung im
 * Code („Kurs 4711“ in <span>Kurs</span> <span>4711</span>), steht sichtbar
 * da, auch wenn highlightTextNodes ihn nicht markiert (Nachreview
 * 7.22-rc20, K103). Ohne DOMParser (kein Browser) gilt ein Treffer als
 * sichtbar: dann kein Hinweis.
 * @param {string} content - Text der Antwort (answerText)
 * @param {string} highlight - Suchbegriff
 * @returns {boolean}
 */
export function answerShowsHit(content, highlight) {
  return parseContent(String(content ?? "")).some((part) => {
    if (part.type === "think") return false;
    if (typeof DOMParser === "undefined") return true;
    const doc = new DOMParser().parseFromString(
      sanitizeAnswerHtml(md.render(part.text)),
      "text/html"
    );
    if (highlightTextNodes(doc.body, highlight, doc) > 0) return true;
    return !!searchPattern(highlight)?.test(doc.body.textContent);
  });
}

/**
 * Gerendert wird nur neu, wenn sich Antwort oder Suchbegriff ändern (memo):
 * Markdown, DOMPurify und Hervorhebung kosten je Antwort – sonst liefen sie
 * bei jedem Tastendruck im Suchfeld für den ganzen Verlauf.
 * @param {{content: string, highlight?: string}} props - highlight:
 *   Suchbegriff, dessen Treffer hervorgehoben werden (Konversationen-Ansicht)
 */
function MarkdownRenderer({ content, highlight = "" }) {
  const parts = useMemo(
    () =>
      content
        ? parseContent(content).map((part) =>
            part.type === "think"
              ? part
              : {
                  ...part,
                  html: sanitizedHtml(md.render(part.text), highlight),
                }
          )
        : [],
    [content, highlight]
  );
  if (!content) return null;

  return (
    <div className="whitespace-normal">
      {parts.map((part, index) =>
        part.type === "think" ? (
          <ThoughtBubble key={index} thought={part.text} />
        ) : (
          <div key={index} dangerouslySetInnerHTML={{ __html: part.html }} />
        )
      )}
    </div>
  );
}

export default memo(MarkdownRenderer);
