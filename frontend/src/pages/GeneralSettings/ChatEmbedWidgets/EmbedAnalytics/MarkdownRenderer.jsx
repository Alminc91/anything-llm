import { memo, useMemo, useState } from "react";
import MarkdownIt from "markdown-it";
import hljs from "highlight.js";
import { CaretDown } from "@phosphor-icons/react";
import "highlight.js/styles/github-dark.css";
import sanitizeAnswerHtml from "@/utils/chat/purifyConversation";
import { useTranslation } from "react-i18next";
import { highlightTextNodes, searchPattern } from "@/utils/conversationView";

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
});

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
 * einmal bereinigt.
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
  return sanitizeAnswerHtml(doc.body.innerHTML);
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
