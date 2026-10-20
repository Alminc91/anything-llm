// Design Center › Einbau: Schritt 1 das Skript (echte Werte dieses Widgets),
// Schritt 2 der Platzhalter nur bei Darstellung „In der Seite“, dazu eine
// kurze Anleitung für WordPress, TYPO3 und andere Systeme. Alle
// Einstellungen kommen aus dem Design Center, data-*-Attribute für die
// Darstellung sind nicht nötig.
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
 * Text in Teile, jeweils nach einem „/“, das nicht direkt nach „<“ steht
 * (das „/“ von „</script>“ ist keine Umbruchstelle). Ohne Lookbehind im
 * regulären Ausdruck (F06, Fixliste 7.22-rc13): Safari kennt Lookbehind erst ab
 * 16.4, auf älteren Geräten warf der Reiter „Einbau“ beim Zeichnen einen
 * SyntaxError.
 * @param {string} text
 * @returns {string[]} Teile, aneinandergereiht wieder der Text
 */
export function splitAfterSlashes(text) {
  const parts = [];
  let start = 0;
  for (let i = 1; i < text.length; i++) {
    if (text[i] !== "/" || text[i - 1] === "<") continue;
    parts.push(text.slice(start, i + 1));
    start = i + 1;
  }
  if (start < text.length || parts.length === 0) parts.push(text.slice(start));
  return parts;
}

/**
 * Schnipsel mit Umbruchstellen nur nach „/“ (S2, Fixliste 7.22-rc10): die
 * Teile (splitAfterSlashes) mit <wbr> dazwischen. Früher: Umbruch auch nach
 * „.“ (B-11, rc6) und nach „-“ (Restpunkt 1, rc7). Die Teile
 * aneinandergereiht ergeben den Schnipsel.
 * @param {string} snippet
 * @returns {Array<string|JSX.Element>} Teile (Strings) mit <wbr> dazwischen
 */
export function snippetWithBreaks(snippet) {
  return splitAfterSlashes(snippet).flatMap((part, i) =>
    i === 0 ? [part] : [<wbr key={i} />, part]
  );
}

// Adressen im Schnipsel: Attributwerte in Anführungszeichen mit „/“ (src,
// data-base-api-url), ohne Leerraum
const SNIPPET_URL_RE = /"([^"\s]*\/[^"\s]*)"/g;

/**
 * Schnipsel in Abschnitte für die Anzeige (F07, Fixliste 7.22-rc13): Nur die
 * Adressen sind nicht umbrechende Stücke mit Umbruchstellen nach „/“
 * (url: true), damit der Browser dort nicht am Bindestrich oder Punkt bricht
 * („anythingllm-chat-“ / „widget.min.js“, Nachprüfung rc8). Alle übrigen
 * Zeilen (z. B. data-embed-id mit der UUID) brechen normal um und bei Bedarf
 * mitten im Wort (overflow-wrap der Box), statt rechts abgeschnitten zu
 * werden. Kopiert wird der Text unverändert.
 * @param {string} snippet
 * @returns {Array<{text: string, url: boolean}>} aneinandergereiht der Schnipsel
 */
export function snippetSegments(snippet) {
  const segments = [];
  let last = 0;
  for (const match of snippet.matchAll(SNIPPET_URL_RE)) {
    const start = match.index + 1;
    if (start > last)
      segments.push({ text: snippet.slice(last, start), url: false });
    segments.push({ text: match[1], url: true });
    last = start + match[1].length;
  }
  if (last < snippet.length)
    segments.push({ text: snippet.slice(last), url: false });
  return segments;
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
      {/* Lange Zeilen brechen um, statt waagerecht zu scrollen
          (Browser-Abnahme B-07). Adressen (src, data-base-api-url) nur nach
          „/“: jeder Teil ein nicht umbrechendes Stück (whitespace-pre, kein
          Umbruch am Bindestrich oder Punkt; S2, rc10). Die übrigen Zeilen
          brechen mit overflow-wrap der Box um, auch die Zeile mit der UUID
          (F07, rc13: vorher bei 768 bis 1000 px rechts abgeschnitten).
          Zeilenumbrüche und Einrückung bleiben (whitespace-pre-wrap), ohne
          break-all. Kopieren liefert den Text unverändert. */}
      <pre className="text-xs text-white font-mono p-3.5 whitespace-pre-wrap [overflow-wrap:anywhere]">
        {snippetSegments(snippet).map((segment, s) =>
          segment.url
            ? snippetWithBreaks(segment.text).map((part, i) =>
                typeof part === "string" ? (
                  <span
                    key={`u${s}-${i}`}
                    className="whitespace-pre"
                    data-snippet-part=""
                  >
                    {part}
                  </span>
                ) : (
                  <wbr key={`w${s}-${i}`} />
                )
              )
            : segment.text
        )}
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

// badge: kleine Marke neben dem Titel (R3: „nur bei „In der Seite““)
function Step({ number, title, note = null, badge = null, children }) {
  return (
    <div className="flex gap-3">
      <span className="flex-shrink-0 w-7 h-7 rounded-full bg-primary-button text-black text-sm font-semibold flex items-center justify-center">
        {number}
      </span>
      <div className="flex-1 min-w-0 space-y-2">
        <p className="text-white text-sm font-medium leading-7 flex flex-wrap items-center gap-x-2">
          {title}
          {badge && (
            <span
              className="text-[11px] leading-5 font-medium text-theme-text-secondary border border-white/10 rounded-full px-2"
              data-testid="step-badge"
            >
              {badge}
            </span>
          )}
        </p>
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
        Beim Chatfenster genügt das Skript, bei „In der Seite“ kommt der
        Platzhalter dazu. Alle Einstellungen kommen automatisch aus dem Design
        Center und gelten auch dann, wenn am Skript noch ältere Angaben stehen
        (z. B. data-theme). Nach dem Speichern muss auf der Website nichts
        geändert werden.
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
          badge="nur bei „In der Seite“"
          note="Fehlt der Platzhalter auf einer Seite, erscheint dort automatisch das Chatfenster."
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
