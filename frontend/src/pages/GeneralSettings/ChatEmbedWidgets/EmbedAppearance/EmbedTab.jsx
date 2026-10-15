// Design Center › Einbau: Schritt 1 das Skript (echte Werte dieses Widgets),
// Schritt 2 der Platzhalter nur bei Darstellung „Inline“, dazu eine kurze
// Anleitung für WordPress, TYPO3 und andere Systeme. Alle Einstellungen
// kommen aus dem Design Center, data-*-Attribute für die Darstellung sind
// nicht nötig.
import { useState } from "react";
import { Check, CopySimple } from "@phosphor-icons/react";
import showToast from "@/utils/toast";
import { EMBED_INLINE_PLACEHOLDER_SNIPPET } from "@/utils/constants";
import { displayMode } from "./widgetKeys";

/**
 * Skript-Schnipsel mit den echten Werten des Widgets (wie der Dialog
 * „Einbettungscode“, ohne Kommentarzeilen). Im Entwicklungsmodus zeigen
 * Skript und API auf die lokalen Server.
 * @param {{uuid: string}} embed
 * @param {{dev?: boolean, origin?: string}} [env]
 * @returns {string}
 */
export function embedScriptSnippet(
  embed,
  {
    dev = import.meta.env.DEV,
    origin = typeof window !== "undefined" ? window.location?.origin : "",
  } = {}
) {
  const scriptHost = dev ? "http://localhost:3000" : origin;
  const serverHost = dev ? "http://localhost:3001" : origin;
  return `<script
  data-embed-id="${embed?.uuid ?? ""}"
  data-base-api-url="${serverHost}/api/embed"
  src="${scriptHost}/embed/anythingllm-chat-widget.min.js">
</script>`;
}

const SYSTEM_GUIDES = [
  {
    name: "WordPress",
    text: "Platzhalter: Block „Individuelles HTML“ an die gewünschte Stelle. Skript: Footer-Widget oder Plugin für Kopf-/Fußzeilen-Code.",
    bubbleText: "Skript: Footer-Widget oder Plugin für Kopf-/Fußzeilen-Code.",
  },
  {
    name: "TYPO3",
    text: "Platzhalter: Inhaltselement „HTML“. Skript: im Seiten-Template bzw. per TypoScript im Footer.",
    bubbleText: "Skript: im Seiten-Template bzw. per TypoScript im Footer.",
  },
  {
    name: "Andere",
    text: "Beide Schnipsel als HTML einfügen. Das Skript darf überall auf der Seite stehen.",
    bubbleText:
      "Das Skript als HTML einfügen. Es darf überall auf der Seite stehen.",
  },
];

/**
 * Schnipsel für die Anzeige mit Umbruchstellen nach „/“, „.“, „-“ und „=“:
 * lange Adressen brechen dort um statt mitten im Wort (Browser 7.22-rc6
 * B-11, „…chat-widge / t.min.js“). Kopiert wird der Text unverändert.
 * @param {string} snippet
 * @returns {Array<string|JSX.Element>}
 */
export function snippetWithBreaks(snippet) {
  return snippet
    .split(/(?<=[/.=-])/)
    .flatMap((part, i) => (i === 0 ? [part] : [<wbr key={i} />, part]));
}

function CopyBlock({ snippet, copiedToast, label }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await window.navigator.clipboard.writeText(snippet);
    } catch {
      showToast("Kopieren nicht möglich, bitte manuell markieren.", "error");
      return;
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
    showToast(copiedToast, "success", { clear: true });
  };
  return (
    <div className="rounded-lg border border-white/10 bg-theme-settings-input-bg overflow-hidden">
      {/* Lange Zeilen (src mit Adresse) brechen um, statt waagerecht zu
          scrollen (Browser-Abnahme B-07), bevorzugt nach „/“ oder „.“
          (snippetWithBreaks); nur ein Teil ohne solche Stelle bricht
          notfalls im Wort. Kopieren liefert den Text unverändert. */}
      <pre className="text-xs text-white font-mono p-3.5 whitespace-pre-wrap [overflow-wrap:anywhere]">
        {snippetWithBreaks(snippet)}
      </pre>
      <div className="flex justify-end px-3 pb-3">
        <button
          type="button"
          onClick={copy}
          aria-label={label}
          className="flex items-center gap-1.5 text-xs font-medium text-white bg-theme-settings-input-bg border border-white/10 hover:bg-theme-action-menu-item-hover rounded-lg px-3 py-1.5 transition-all"
        >
          {copied ? (
            <Check size={14} weight="bold" />
          ) : (
            <CopySimple size={14} />
          )}
          {copied ? "Kopiert" : "Kopieren"}
        </button>
      </div>
    </div>
  );
}

function Step({ number, title, note = null, children }) {
  return (
    <div className="flex gap-3">
      <span className="flex-shrink-0 w-7 h-7 rounded-full bg-primary-button text-black text-sm font-semibold flex items-center justify-center">
        {number}
      </span>
      <div className="flex-1 min-w-0 space-y-2">
        <p className="text-white text-sm font-medium leading-7">{title}</p>
        {children}
        {note && (
          <p className="text-theme-text-secondary text-xs leading-relaxed">
            {note}
          </p>
        )}
      </div>
    </div>
  );
}

// Aufbau der Kundenseite: wo Platzhalter und Skript stehen
function PageSketch({ inline }) {
  return (
    <div
      className="rounded-lg border border-white/10 bg-theme-bg-secondary p-3 space-y-2 text-[11px] text-theme-text-secondary"
      aria-hidden="true"
    >
      <div className="flex gap-3 border-b border-white/10 pb-2">
        <span className="font-semibold text-white">[Ihre Website]</span>
        <span>Programm</span>
        <span>Anmeldung</span>
        <span>Kontakt</span>
      </div>
      {inline && (
        <div className="flex items-center gap-2 rounded-full border border-primary-button/60 px-3 py-1.5">
          <span className="w-5 h-5 rounded-full bg-primary-button text-black text-[10px] font-semibold flex items-center justify-center">
            2
          </span>
          <span className="flex-1">Platzhalter: hier erscheint die Leiste</span>
        </div>
      )}
      <div className="h-2 rounded bg-theme-sidebar-border w-10/12" />
      <div className="h-2 rounded bg-theme-sidebar-border w-7/12" />
      <div className="flex items-center gap-2 border-t border-white/10 pt-2">
        <span className="font-semibold">Footer</span>
        <span className="w-5 h-5 rounded-full bg-primary-button text-black text-[10px] font-semibold flex items-center justify-center">
          1
        </span>
        <span>Skript</span>
      </div>
    </div>
  );
}

export default function EmbedTab({ config, embed }) {
  const inline = displayMode(config) === "inline";
  return (
    <>
      <p className="text-theme-text-secondary text-xs leading-relaxed">
        Bei der Chatblase genügt das Skript, bei Inline kommt der Platzhalter
        dazu. Alle Einstellungen kommen automatisch aus dem Design Center und
        gelten auch dann, wenn am Skript noch ältere Angaben stehen (z. B.
        data-theme). Nach dem Speichern muss auf der Website nichts geändert
        werden.
      </p>

      <Step
        number={1}
        title="Skript einmal einbauen, am besten im Footer"
        note="Auf jeder Seite, auf der der Chatbot erscheinen soll, z. B. im Footer-Bereich des Themes."
      >
        <CopyBlock
          snippet={embedScriptSnippet(embed)}
          copiedToast="Skript kopiert."
          label="Skript kopieren"
        />
      </Step>

      {inline && (
        <Step
          number={2}
          title="Platzhalter dort einfügen, wo die Leiste erscheinen soll"
          note="Fehlt der Platzhalter auf einer Seite, erscheint dort automatisch die Chatblase."
        >
          <CopyBlock
            snippet={EMBED_INLINE_PLACEHOLDER_SNIPPET}
            copiedToast="Platzhalter kopiert."
            label="Platzhalter kopieren"
          />
        </Step>
      )}

      <div className="space-y-2.5">
        <p className="text-white text-sm font-medium">
          So geht es in Ihrem System
        </p>
        <dl className="space-y-2">
          {SYSTEM_GUIDES.map(({ name, text, bubbleText }) => (
            <div key={name} className="text-xs leading-relaxed">
              <dt className="text-white font-semibold">{name}</dt>
              <dd className="text-theme-text-secondary">
                {inline ? text : bubbleText}
              </dd>
            </div>
          ))}
        </dl>
      </div>

      <div className="space-y-2">
        <p className="text-white text-sm font-medium">
          Wo was hingehört: Aufbau Ihrer Seite
        </p>
        <PageSketch inline={inline} />
      </div>
    </>
  );
}
