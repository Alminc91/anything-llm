import { useState } from "react";
import MarkdownIt from "markdown-it";
import hljs from "highlight.js";
import { CaretDown } from "@phosphor-icons/react";
import "highlight.js/styles/github-dark.css";
import DOMPurify from "@/utils/chat/purify";
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
 * Hervorgehoben wird nach dem Bereinigen in einem inaktiven Dokument
 * (DOMParser: keine Skripte, keine Ladevorgänge) und nur in Textknoten – aus
 * Nutzertext entsteht kein HTML. Das Ergebnis wird noch einmal bereinigt.
 * @param {string} html - gerendertes Markdown
 * @param {string} highlight - Suchbegriff ("" = keine Hervorhebung)
 * @returns {string}
 */
function sanitizedHtml(html, highlight) {
  const clean = DOMPurify.sanitize(html);
  if (!searchPattern(highlight) || typeof DOMParser === "undefined")
    return clean;
  const doc = new DOMParser().parseFromString(clean, "text/html");
  if (highlightTextNodes(doc.body, highlight, doc) === 0) return clean;
  return DOMPurify.sanitize(doc.body.innerHTML);
}

/**
 * @param {{content: string, highlight?: string}} props - highlight:
 *   Suchbegriff, dessen Treffer hervorgehoben werden (Konversationen-Ansicht)
 */
export default function MarkdownRenderer({ content, highlight = "" }) {
  if (!content) return null;

  const parts = parseContent(content);
  return (
    <div className="whitespace-normal">
      {parts.map((part, index) => {
        const html = md.render(part.text);
        if (part.type === "think")
          return <ThoughtBubble key={index} thought={part.text} />;
        return (
          <div
            key={index}
            dangerouslySetInnerHTML={{
              __html: sanitizedHtml(html, highlight),
            }}
          />
        );
      })}
    </div>
  );
}
