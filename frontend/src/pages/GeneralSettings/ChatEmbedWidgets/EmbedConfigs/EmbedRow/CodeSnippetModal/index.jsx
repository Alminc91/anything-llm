import React, { useState } from "react";
import { CheckCircle, CopySimple, X } from "@phosphor-icons/react";
import showToast from "@/utils/toast";
import hljs from "highlight.js";
import "@/utils/chat/themes/github-dark.css";
import "@/utils/chat/themes/github.css";
import { useTranslation } from "react-i18next";

export default function CodeSnippetModal({ embed, closeModal }) {
  const { t } = useTranslation();
  return (
    <div className="fixed inset-0 z-50 overflow-auto bg-black bg-opacity-50 flex items-center justify-center">
      <div className="relative w-full max-w-2xl bg-theme-bg-secondary rounded-lg shadow border-2 border-theme-modal-border">
        <div className="relative p-6 border-b rounded-t border-theme-modal-border">
          <div className="w-full flex gap-x-2 items-center">
            <h3 className="text-xl font-semibold text-white overflow-hidden overflow-ellipsis whitespace-nowrap">
              {t("code-snippet-modal.title")}
            </h3>
          </div>
          <button
            onClick={closeModal}
            type="button"
            className="absolute top-4 right-4 transition-all duration-300 bg-transparent rounded-lg text-sm p-1 inline-flex items-center hover:bg-theme-modal-border hover:border-theme-modal-border hover:border-opacity-50 border-transparent border"
          >
            <X size={24} weight="bold" className="text-white" />
          </button>
        </div>
        <div className="px-7 py-6">
          <div className="space-y-6 max-h-[60vh] overflow-y-auto pr-2">
            <ScriptTag embed={embed} />
            <InlinePlaceholderTag />
          </div>
          <div className="flex justify-between items-center mt-6 pt-6 border-t border-theme-modal-border">
            <button
              onClick={closeModal}
              type="button"
              className="transition-all duration-300 text-white hover:bg-zinc-700 px-4 py-2 rounded-lg text-sm"
            >
              {t("code-snippet-modal.close")}
            </button>
            <div hidden={true} />
          </div>
        </div>
      </div>
    </div>
  );
}

// Kufer Inline-Modus: optionaler Platzhalter. Nur wirksam, wenn im Design
// Center "Darstellung: Inline" gewählt ist (oder data-display-mode="inline").
const INLINE_PLACEHOLDER_SNIPPET = '<div id="kufer-assistent"></div>';

const InlinePlaceholderTag = () => {
  const [copied, setCopied] = useState(false);
  const theme =
    window.localStorage.getItem("theme") === "light" ? "github" : "github-dark";

  const handleClick = () => {
    window.navigator.clipboard.writeText(INLINE_PLACEHOLDER_SNIPPET);
    setCopied(true);
    setTimeout(() => {
      setCopied(false);
    }, 2500);
    showToast("Platzhalter kopiert.", "success", { clear: true });
  };

  return (
    <div>
      <div className="flex flex-col mb-2">
        <label className="block text-sm font-medium text-white">
          Optional: Inline-Darstellung
        </label>
        <p className="text-theme-text-secondary text-xs">
          Ist unter „Erscheinungsbild → Aussehen → Darstellung“ „Inline“
          gewählt, fügen Sie diesen Platzhalter an der gewünschten Stelle Ihrer
          Seite ein. Ohne diesen Platzhalter erscheint weiterhin die Chat-Blase.
          Das Script-Snippet oben bleibt unverändert.
        </p>
      </div>
      <button
        disabled={copied}
        onClick={handleClick}
        className={`disabled:border disabled:border-green-300 disabled:light:border-green-600 border border-transparent relative w-full font-mono flex hljs ${theme} light:border light:border-gray-700 text-white placeholder:text-theme-settings-input-placeholder text-sm rounded-lg focus:outline-primary-button active:outline-primary-button outline-none p-2.5 m-1`}
      >
        <div
          className="flex w-full text-left flex-col gap-y-1 pr-6 pl-4 whitespace-pre-line"
          dangerouslySetInnerHTML={{
            __html: hljs.highlight(INLINE_PLACEHOLDER_SNIPPET, {
              language: "html",
              ignoreIllegals: true,
            }).value,
          }}
        />
        {copied ? (
          <CheckCircle
            size={14}
            className="text-green-300 light:text-green-600 absolute top-2 right-2"
          />
        ) : (
          <CopySimple size={14} className="absolute top-2 right-2" />
        )}
      </button>
    </div>
  );
};

function createScriptTagSnippet(embed, scriptHost, serverHost, t) {
  return `<!--
${t("code-snippet-modal.script-comment")}
-->
<script
  data-embed-id="${embed.uuid}"
  data-base-api-url="${serverHost}/api/embed"
  src="${scriptHost}/embed/anythingllm-chat-widget.min.js">
</script>
<!-- AnythingLLM (https://anythingllm.com) -->
`;
}

const ScriptTag = ({ embed }) => {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const scriptHost = import.meta.env.DEV
    ? "http://localhost:3000"
    : window.location.origin;
  const serverHost = import.meta.env.DEV
    ? "http://localhost:3001"
    : window.location.origin;
  const snippet = createScriptTagSnippet(embed, scriptHost, serverHost, t);
  const theme =
    window.localStorage.getItem("theme") === "light" ? "github" : "github-dark";

  const handleClick = () => {
    window.navigator.clipboard.writeText(snippet);
    setCopied(true);
    setTimeout(() => {
      setCopied(false);
    }, 2500);
    showToast(t("code-snippet-modal.copied"), "success", { clear: true });
  };

  return (
    <div>
      <div className="flex flex-col mb-2">
        <label className="block text-sm font-medium text-white">
          {t("code-snippet-modal.script-tag.label")}
        </label>
        <p className="text-theme-text-secondary text-xs">
          {t("code-snippet-modal.script-tag.hint")}
        </p>
        <a
          href="https://github.com/Mintplex-Labs/anythingllm-embed/blob/main/README.md"
          target="_blank"
          rel="noreferrer"
          className="text-blue-300 light:text-blue-500 hover:underline"
        >
          {t("code-snippet-modal.script-tag.view-options")}
        </a>
      </div>
      <button
        disabled={copied}
        onClick={handleClick}
        className={`disabled:border disabled:border-green-300 disabled:light:border-green-600 border border-transparent relative w-full font-mono flex hljs ${theme} light:border light:border-gray-700 text-white placeholder:text-theme-settings-input-placeholder text-sm rounded-lg focus:outline-primary-button active:outline-primary-button outline-none p-2.5 m-1`}
      >
        <div
          className="flex w-full text-left flex-col gap-y-1 pr-6 pl-4 whitespace-pre-line"
          dangerouslySetInnerHTML={{
            __html: hljs.highlight(snippet, {
              language: "html",
              ignoreIllegals: true,
            }).value,
          }}
        />
        {copied ? (
          <CheckCircle
            size={14}
            className="text-green-300 light:text-green-600 absolute top-2 right-2"
          />
        ) : (
          <CopySimple size={14} className="absolute top-2 right-2" />
        )}
      </button>
    </div>
  );
};
