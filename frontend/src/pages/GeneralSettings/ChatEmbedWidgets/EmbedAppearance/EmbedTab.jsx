// Design Center › Einbau: Schritt 1 das Skript (echte Werte dieses Widgets),
// Schritt 2 der Platzhalter nur bei Darstellung „In der Seite“ mit der
// Warnung vor verlinkten Bereichen (F70, Fixliste 7.22-rc19), dazu eine
// kurze Anleitung für WordPress, TYPO3 und andere Systeme. Alle
// Einstellungen kommen aus dem Design Center; data-*-Attribute für das, was
// das Design Center einstellt, wirken nicht (E23, Fixliste 7.22-rc17).
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, CopySimple, Warning } from "@phosphor-icons/react";
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
          „/“: jeder Teil (splitAfterSlashes) ein nicht umbrechendes Stück
          (whitespace-pre, kein Umbruch am Bindestrich oder Punkt; S2, rc10),
          dazwischen <wbr>. Die übrigen Zeilen brechen mit overflow-wrap der
          Box um, auch die Zeile mit der UUID (F07, rc13: vorher bei 768 bis
          1000 px rechts abgeschnitten).
          Zeilenumbrüche und Einrückung bleiben (whitespace-pre-wrap), ohne
          break-all. Kopieren liefert den Text unverändert. */}
      <pre className="text-xs text-white font-mono p-3.5 whitespace-pre-wrap [overflow-wrap:anywhere]">
        {snippetSegments(snippet).map((segment, s) =>
          segment.url
            ? splitAfterSlashes(segment.text).flatMap((part, i) => {
                const piece = (
                  <span
                    key={`u${s}-${i}`}
                    className="whitespace-pre"
                    data-snippet-part=""
                  >
                    {part}
                  </span>
                );
                return i === 0 ? [piece] : [<wbr key={`w${s}-${i}`} />, piece];
              })
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

// Marke im übersetzten Satz, an der der Platzhalter als Code steht
// ({{code}} in den Sprachdateien). Kein <Trans>: Der Code hat selbst spitze
// Klammern und würde dort als HTML gelesen.
const CODE_MARK = "\u0000";

// Code im Warnblock: im Satz als Stück der Zeile, bei den Beispielen als
// eigene Zeile unter „Richtig:“ bzw. „Falsch:“ (bricht nur bei Platzmangel)
function InlineCode({ children, block = false }) {
  const layout = block
    ? "block w-fit max-w-full mt-1 px-1.5 py-0.5"
    : "px-1 py-px box-decoration-clone";
  return (
    <code
      className={`${layout} font-mono text-[12px] rounded border border-red-400/40 bg-black/40 text-red-50 light:border-red-200 light:bg-white light:text-red-950 [overflow-wrap:anywhere]`}
    >
      {children}
    </code>
  );
}

/**
 * Satz mit dem Code an jeder Marke (CODE_MARK).
 * @param {string} text übersetzter Satz, {{code}} durch CODE_MARK ersetzt
 * @param {string} code
 * @returns {Array<string|JSX.Element>}
 */
export function withInlineCode(text, code) {
  const [first, ...rest] = String(text).split(CODE_MARK);
  return [
    first,
    ...rest.flatMap((after, i) => [
      <InlineCode key={i}>{code}</InlineCode>,
      after,
    ]),
  ];
}

/**
 * Warnung im Reiter „Einbau“ bei „In der Seite“ (F70, Fixliste 7.22-rc19;
 * AK-7 aus issues/inline-platzhalter-in-link.md): Der Platzhalter darf nicht
 * in einem verlinkten Block stehen, sonst öffnet ein Klick die verlinkte
 * Seite statt der Eingabeleiste. Text vom Nutzer am 21.10.2026 wörtlich
 * freigegeben (design-center-vereinfachen.md, Eintrag „Warnung im Reiter
 * Einbau“), de und en in den Sprachdateien (embed-appearance.
 * inline-link-warning); das ⚠ der Überschrift ist das Warndreieck vorn. Der
 * Platzhalter kommt aus derselben Konstante wie der Schnipsel. Rot in hell
 * und dunkel, Text mindestens 4,5:1 auf der Fläche des Blocks (Messung
 * .test-storage/rc19).
 */
export function InlineLinkWarning() {
  const { t } = useTranslation();
  const text = (key) =>
    t(`embed-appearance.inline-link-warning.${key}`, { code: CODE_MARK });
  const placeholder = EMBED_INLINE_PLACEHOLDER_SNIPPET;
  const examples = [
    {
      key: "right",
      sign: "✓",
      code: `<section> … ${placeholder} … </section>`,
    },
    {
      key: "wrong",
      sign: "✗",
      code: `<a href="/kurse"> … ${placeholder} … </a>`,
    },
  ];
  return (
    <div
      className="rounded-lg border-2 border-red-500 bg-red-950/60 light:border-red-600 light:bg-red-50 p-4 space-y-2.5 text-[13px] leading-relaxed text-red-100 light:text-red-900"
      data-testid="inline-link-warning"
    >
      <p className="flex items-start gap-2 text-sm font-bold text-red-200 light:text-red-800">
        <Warning
          size={20}
          weight="fill"
          className="flex-shrink-0 text-red-400 light:text-red-600"
          aria-hidden="true"
          data-testid="inline-link-warning-icon"
        />
        <span>{text("title")}</span>
      </p>
      <p>{withInlineCode(text("placement"), placeholder)}</p>
      <p>{text("check")}</p>
      <ul className="space-y-1.5">
        {examples.map(({ key, sign, code }) => (
          <li key={key} data-testid={`inline-link-warning-${key}`}>
            <strong className="font-bold">
              <span aria-hidden="true">{sign}</span> {text(key)}
            </strong>{" "}
            <InlineCode block>{code}</InlineCode>
          </li>
        ))}
      </ul>
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
      {/* E23 (Fixliste 7.22-rc17, ersetzt E18 aus rc16): Was das Design
          Center einstellt (Gruppe A), gilt nur aus dem Design Center,
          gespeichert oder als Standard; Angaben dazu im Einbau-Code (etwa
          data-theme) wirken nicht, auch ohne gespeicherten Wert. Wortlaut
          nach E28 (Fixliste 7.22-rc18 F61): Feste Standards ohne Feld
          (Gruppe B) dürfen Entwickler weiter per Einbau-Angabe verfeinern,
          der Text sagt deshalb nichts über Aussehen und Texte insgesamt */}
      <p className="text-theme-text-secondary text-xs leading-relaxed">
        Beim Chatfenster genügt das Skript, bei „In der Seite“ kommt der
        Platzhalter dazu. Der Einbau-Code braucht nur diese Angaben. Was Sie
        hier im Design Center einstellen, ändern Angaben im Einbau-Code nicht.
        Nach dem Speichern muss auf der Website nichts geändert werden.
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
          {/* F70: vor dem Schnipsel, damit die Warnung vor dem Kopieren
              gelesen wird */}
          <InlineLinkWarning />
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
