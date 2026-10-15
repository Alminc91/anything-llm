// Live-Vorschau des Design Centers (Mock, angelehnt an das Widget): zeigt den
// festen Standard mit den Inhalten des Kunden. Begrüßung als erste Blase,
// Datenschutz-Hinweis als eigene zweite Blase (ausgeschaltet: nur die
// Begrüßungsblase, KIE-565 Nachtrag), Startvorschläge als Pillen wie die
// Folgefragen, eine Beispiel-Nutzernachricht in Kundenfarbe (Schrift auf der
// Kundenfarbe sichtbar), KI-Hinweis fest unter der Eingabe, kein
// Online-Punkt. Hell/Dunkel in beiden Darstellungen.
import { useState } from "react";
import {
  ChatCircleDots,
  Headset,
  Binoculars,
  MagnifyingGlass,
  MagicWand,
  Plus,
  X,
  PaperPlaneRight,
  CaretUp,
} from "@phosphor-icons/react";
import {
  displayMode,
  lookValue,
  privacyBlocks,
  privacyNoticeOn,
  privacyTitleFieldValue,
  previewGreeting,
  previewInlineBar,
  previewPlaceholder,
  textItems,
  pillTextColor,
  textValue,
  themeChoice,
  userTextColor,
  validPrivacyUrl,
} from "./widgetKeys";

export const CHAT_ICONS = [
  { id: "chatBubble", label: "Chat-Blase", Icon: ChatCircleDots },
  { id: "support", label: "Support", Icon: Headset },
  { id: "search", label: "Suche", Icon: MagnifyingGlass },
  { id: "search2", label: "Fernglas", Icon: Binoculars },
  { id: "magic", label: "Magie", Icon: MagicWand },
  { id: "plus", label: "Plus", Icon: Plus },
];

export const DEFAULT_LOGO =
  "https://www.kufer.de/typo3conf/ext/kubuslayout/Resources/Public/Icons/augenbrauen-3.png";

// Farben der Vorschau (wie im Mockup)
const PALETTES = {
  light: {
    pageBg: "#eceae6",
    siteBar: "#ffffff",
    skeleton: "#c9c6c0",
    panelBg: "#ffffff",
    text: "#1c1917",
    muted: "#57534e",
    line: "#e7e5e4",
    bubbleBg: "#f5f5f4",
    inputBg: "#ffffff",
    // Flächen, auf denen die Schrift der Pillen 4,5:1 erreichen muss (wie
    // im Widget, theme.js pillTextColor)
    pillTextBgs: ["#ffffff"],
  },
  dark: {
    pageBg: "#2b2b31",
    siteBar: "#2a2a30",
    skeleton: "#4a4a52",
    panelBg: "#1d1d21",
    text: "#f4f4f5",
    muted: "#b4b4bb",
    line: "rgba(255,255,255,.12)",
    bubbleBg: "#2a2a30",
    inputBg: "#141417",
    // Panel der Vorschau und Flächen des dunklen Widgets (DARK.bg, surface)
    pillTextBgs: ["#1d1d21", "#131316"],
  },
};

function paletteOf(config) {
  return PALETTES[themeChoice(config) === "dark" ? "dark" : "light"];
}

function ChatIcon({ config, size, color }) {
  const match = CHAT_ICONS.find((i) => i.id === lookValue(config, "chatIcon"));
  const Icon = match ? match.Icon : ChatCircleDots;
  return <Icon size={size} weight="fill" color={color} />;
}

/**
 * Vorschau rechts im Design Center.
 * @param {{config: Object, logoPreview: string|null, defaults: Object|null,
 *   greetingKey: string}} props
 */
export default function WidgetPreview({
  config,
  logoPreview,
  defaults,
  greetingKey,
}) {
  const palette = paletteOf(config);
  const inline = displayMode(config) === "inline";
  return (
    <div
      className="flex-1 overflow-hidden flex flex-col relative"
      style={{ background: palette.pageBg }}
      data-preview-theme={themeChoice(config) || "auto"}
    >
      <p
        className="text-xs font-semibold px-6 pt-5"
        style={{ color: palette.muted }}
      >
        {inline
          ? "Vorschau: Inline in Ihrer Seite"
          : "Vorschau: so sieht es auf Ihrer Website aus"}
      </p>
      {/* Scrollt, statt etwas abzuschneiden (Browser-Abnahme B-06: die
          Datenschutz-Blase im aufgeklappten Inline-Panel); m-auto zentriert,
          solange alles hineinpasst. */}
      <div className="flex-1 min-h-0 overflow-y-auto flex p-6">
        <div className="m-auto w-full flex justify-center">
          {inline ? (
            <InlinePreview
              config={config}
              logoPreview={logoPreview}
              defaults={defaults}
              greetingKey={greetingKey}
              palette={palette}
            />
          ) : (
            <BubblePreview
              config={config}
              logoPreview={logoPreview}
              defaults={defaults}
              greetingKey={greetingKey}
              palette={palette}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// Kopf: Logo, Name, optionaler Untertitel; kein Online-Punkt
function PreviewHeader({ config, logoPreview, defaults, palette, action }) {
  const name =
    textValue(config.name).trim() || textValue(defaults?.name) || "KI-Berater";
  const subtitle = textValue(config.assistantSubtitle).trim();
  return (
    <div
      className="flex items-center gap-3 px-4 h-[60px] flex-shrink-0"
      style={{ borderBottom: `1px solid ${palette.line}` }}
    >
      <img
        src={logoPreview || DEFAULT_LOGO}
        alt="Logo"
        className="h-9 w-9 rounded-lg object-contain flex-shrink-0"
      />
      <span className="flex flex-col min-w-0 flex-1">
        <span
          className="font-semibold text-sm truncate"
          style={{ color: palette.text }}
        >
          {name}
        </span>
        {subtitle && (
          <span
            className="text-[11px] truncate"
            style={{ color: palette.muted }}
          >
            {subtitle}
          </span>
        )}
      </span>
      {action}
    </div>
  );
}

// Text der Beispiel-Nutzernachricht in der Vorschau
export const SAMPLE_USER_MESSAGE = "Gibt es Kurse am Wochenende?";

// Startvorschlag als Pille, aussehend und reagierend wie die Folgefragen
// im Widget (KIE-565 Nachtrag): Rand in Kundenfarbe, Schrift in Kundenfarbe
// mit mindestens 4,5:1 auf der Fläche (sonst abgedunkelt bzw. aufgehellt),
// Darüberfahren füllt die Pille in Kundenfarbe, die Schrift wird dann zur
// Schrift auf der Kundenfarbe (im Widget auch beim Tastaturfokus; die
// Vorschau ist nicht bedienbar und deshalb ohne Tab-Halt). Eine Komponente
// für die Chatblase und für Inline (Panel und Leiste).
export function SuggestionPill({ config, palette, text }) {
  const accent = lookValue(config, "accentColor");
  return (
    <span
      className="rounded-full px-3 py-1 text-[11px] font-medium border cursor-default transition-colors bg-[color:var(--pill-bg)] text-[color:var(--pill-text)] hover:bg-[color:var(--pill-accent)] hover:text-[color:var(--pill-on-accent)]"
      style={{
        borderColor: accent,
        "--pill-bg": palette.panelBg,
        "--pill-text": pillTextColor(accent, palette.pillTextBgs, palette.text),
        "--pill-accent": accent,
        "--pill-on-accent": userTextColor(config),
      }}
      title={text.length > 60 ? text : undefined}
      data-preview="pill"
    >
      {text.length > 60 ? `${text.slice(0, 59).trimEnd()}…` : text}
    </span>
  );
}

// Beispiel einer Nutzer-Nachricht: Kundenfarbe mit der Schrift auf der
// Kundenfarbe, darunter die Beschriftung
function PreviewUserMessage({ config, palette }) {
  return (
    <div className="flex flex-col items-end gap-1 pt-1">
      <div
        className="text-[12.5px] leading-relaxed rounded-[18px] rounded-tr-[4px] px-3.5 py-2.5 max-w-[80%]"
        style={{
          backgroundColor: lookValue(config, "accentColor"),
          color: userTextColor(config),
        }}
        data-preview="user-message"
      >
        {SAMPLE_USER_MESSAGE}
      </div>
      <span
        className="text-[10px] leading-snug"
        style={{ color: palette.muted }}
        data-preview="user-message-caption"
      >
        Beispiel-Nutzernachricht
      </span>
    </div>
  );
}

// Startzustand des Chats: Begrüßungsblase, Datenschutz-Blase (falls an),
// Pillen, Beispiel-Nutzernachricht
export function PreviewWelcome({ config, defaults, greetingKey, palette }) {
  const accentColor = lookValue(config, "accentColor");
  const greeting = previewGreeting(config, greetingKey, defaults);
  // Schalter „Datenschutz-Hinweis anzeigen“ aus: nur die Begrüßungsblase
  const showPrivacy = privacyNoticeOn(config);
  const title = privacyTitleFieldValue(config, defaults).trim();
  const privacyText = textValue(config.privacyText).trim()
    ? config.privacyText
    : textValue(defaults?.privacyText);
  const blocks = privacyBlocks(privacyText);
  const url = validPrivacyUrl(config.privacyUrl);
  const pills = textItems(config.defaultMessages).slice(0, 6);
  const bubble = {
    backgroundColor: palette.bubbleBg,
    color: palette.text,
  };
  return (
    <div className="w-full space-y-2.5" data-preview="welcome">
      <div
        className="text-[12.5px] leading-relaxed rounded-[18px] rounded-tl-[4px] px-3.5 py-2.5 max-w-[88%]"
        style={bubble}
        data-preview="greeting-bubble"
      >
        {greeting}
      </div>
      {showPrivacy && (
        <div
          className="text-[11.5px] leading-relaxed rounded-[18px] rounded-tl-[4px] px-3.5 py-2.5 max-w-[88%] space-y-1"
          style={bubble}
          data-preview="privacy-bubble"
        >
          {title && <p className="font-semibold">{title}</p>}
          {blocks.map((block, i) =>
            block.type === "bullet" ? (
              <p key={i} className="flex gap-1.5">
                <span aria-hidden="true">•</span>
                <span>{block.text}</span>
              </p>
            ) : (
              <p key={i}>{block.text}</p>
            )
          )}
          {url && (
            <p>
              <span className="underline" style={{ color: accentColor }}>
                Datenschutzerklärung
              </span>
            </p>
          )}
        </div>
      )}
      {pills.length > 0 && (
        <div className="flex flex-wrap gap-1.5 pt-1" data-preview="pills">
          {pills.map((msg, i) => (
            <SuggestionPill
              key={i}
              config={config}
              palette={palette}
              text={msg}
            />
          ))}
        </div>
      )}
      <PreviewUserMessage config={config} palette={palette} />
    </div>
  );
}

// Eingabe mit fester KI-Zeile darunter (eine Zeile, dezent)
function PreviewInput({ config, defaults, palette }) {
  const placeholder = previewPlaceholder(config, defaults);
  return (
    <div className="px-4 pb-2.5 pt-1 flex-shrink-0">
      <div
        className="flex items-center w-full rounded-2xl"
        style={{
          border: `1.5px solid ${palette.line}`,
          backgroundColor: palette.inputBg,
        }}
      >
        <span
          className="flex-1 text-[13px] py-2.5 px-3.5 truncate"
          style={{ color: palette.muted }}
        >
          {placeholder}
        </span>
        <PaperPlaneRight
          size={18}
          weight="fill"
          className="mr-3 flex-shrink-0"
          color={palette.muted}
        />
      </div>
      <p
        className="text-center text-[10px] leading-snug mt-1.5 truncate"
        style={{ color: palette.muted }}
        data-preview="disclaimer"
      >
        {textValue(defaults?.disclaimerText) ||
          "KI kann Fehler machen. Bitte überprüfen Sie die Antworten."}
      </p>
    </div>
  );
}

function BubblePreview({
  config,
  logoPreview,
  defaults,
  greetingKey,
  palette,
}) {
  const [open, setOpen] = useState(true);
  const accentColor = lookValue(config, "accentColor");
  const isLeft = lookValue(config, "position").includes("left");
  const bubbles = textItems(config.chatbotBubblesMessages);
  return (
    <div className="w-[370px] max-w-full flex flex-col items-stretch">
      <div
        className="flex flex-col justify-end"
        style={{ height: "540px", maxHeight: "calc(100vh - 220px)" }}
      >
        {open ? (
          <div
            className="w-full h-full rounded-2xl flex flex-col overflow-hidden"
            style={{
              backgroundColor: palette.panelBg,
              boxShadow:
                "0 8px 40px rgba(0,0,0,0.12), 0 2px 8px rgba(0,0,0,0.08)",
            }}
          >
            <PreviewHeader
              config={config}
              logoPreview={logoPreview}
              defaults={defaults}
              palette={palette}
              action={
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  aria-label="Chat schließen"
                  style={{ color: palette.muted }}
                >
                  <X size={18} weight="bold" />
                </button>
              }
            />
            <div className="flex-1 overflow-y-auto no-scroll px-4 py-4">
              <PreviewWelcome
                config={config}
                defaults={defaults}
                greetingKey={greetingKey}
                palette={palette}
              />
            </div>
            <PreviewInput
              config={config}
              defaults={defaults}
              palette={palette}
            />
          </div>
        ) : (
          bubbles.length > 0 && (
            <div
              className={`w-[300px] flex flex-col gap-2 mt-auto ${
                isLeft ? "self-start" : "self-end"
              }`}
            >
              {bubbles.map((msg, i) => (
                <div
                  key={i}
                  className="rounded-2xl px-4 py-2.5 text-[13px] w-full"
                  style={{
                    backgroundColor: palette.panelBg,
                    color: palette.text,
                    boxShadow: "0 2px 12px rgba(0,0,0,0.1)",
                  }}
                >
                  {msg}
                </div>
              ))}
            </div>
          )
        )}
      </div>
      <div
        className={`flex items-center gap-3 mt-4 ${
          isLeft ? "self-start" : "self-end flex-row-reverse"
        }`}
      >
        <button
          type="button"
          className="w-12 h-12 rounded-full flex items-center justify-center transition-transform hover:scale-110 flex-shrink-0"
          style={{
            backgroundColor: accentColor,
            boxShadow: `0 4px 14px ${accentColor}40`,
          }}
          onClick={() => setOpen(!open)}
          aria-label={open ? "Chat schließen" : "Chat öffnen"}
        >
          <ChatIcon config={config} size={24} color={userTextColor(config)} />
        </button>
        <span
          className="text-xs select-none whitespace-nowrap"
          style={{ color: palette.muted }}
        >
          Klicken zum {open ? "Schließen" : "Öffnen"}
        </span>
      </div>
    </div>
  );
}

function InlinePreview({
  config,
  logoPreview,
  defaults,
  greetingKey,
  palette,
}) {
  const [expanded, setExpanded] = useState(false);
  const accentColor = lookValue(config, "accentColor");
  // Eingeklappte Leiste: Demo-Texte bzw. früher gespeicherter Leistentext,
  // nicht der Platzhalter des Chat-Eingabefelds (Entscheidung D2)
  const { placeholder, sendText } = previewInlineBar(config, defaults);
  const chips = textItems(config.defaultMessages).slice(0, 6);
  return (
    <div
      className="w-full max-w-[640px] rounded-xl overflow-hidden flex flex-col"
      style={{
        backgroundColor: palette.pageBg,
        border: `1px solid ${palette.line}`,
      }}
    >
      <div
        className="flex items-center gap-4 px-5 h-11 text-xs flex-shrink-0"
        style={{ backgroundColor: palette.siteBar, color: palette.muted }}
      >
        <span className="font-semibold" style={{ color: palette.text }}>
          [Ihre Website]
        </span>
        <span>Programm</span>
        <span>Anmeldung</span>
        <span>Kontakt</span>
      </div>
      <div className="px-8 py-6 flex flex-col gap-4 min-h-0">
        <div className="space-y-1.5">
          <div
            className="h-3.5 rounded w-6/12"
            style={{ backgroundColor: palette.skeleton }}
          />
          <div
            className="h-2.5 rounded w-9/12"
            style={{ backgroundColor: palette.skeleton, opacity: 0.6 }}
          />
        </div>
        {expanded ? (
          <div
            className="w-full rounded-[40px] flex flex-col overflow-hidden"
            style={{
              backgroundColor: palette.panelBg,
              // wächst mit dem Inhalt (nichts abgeschnitten); die Vorschau
              // scrollt, wenn das Fenster zu niedrig ist
              minHeight: "380px",
              boxShadow: "0 30px 70px -30px rgba(64,36,8,.45)",
            }}
            data-preview="inline-panel"
          >
            <div className="px-3 pt-2">
              <PreviewHeader
                config={config}
                logoPreview={logoPreview}
                defaults={defaults}
                palette={palette}
                action={
                  <button
                    type="button"
                    onClick={() => setExpanded(false)}
                    aria-label="Einklappen"
                    style={{ color: palette.muted }}
                  >
                    <CaretUp size={18} weight="bold" />
                  </button>
                }
              />
            </div>
            <div className="flex-1 px-6 py-4" data-preview="inline-messages">
              <PreviewWelcome
                config={config}
                defaults={defaults}
                greetingKey={greetingKey}
                palette={palette}
              />
            </div>
            <div className="px-3 pb-2">
              <PreviewInput
                config={config}
                defaults={defaults}
                palette={palette}
              />
            </div>
          </div>
        ) : (
          <div className="space-y-2.5" data-preview="inline-bar">
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="w-full flex items-center gap-3 rounded-full pl-5 pr-1.5 py-1.5 text-left"
              style={{
                backgroundColor: palette.panelBg,
                border: `1px solid ${palette.line}`,
                boxShadow: "0 18px 40px -22px rgba(23,24,27,.45)",
              }}
            >
              <span
                className="flex-1 min-w-0 text-[14px] truncate"
                style={{ color: palette.muted }}
              >
                {placeholder}
              </span>
              <span
                className="rounded-full px-4 py-2 text-[13px] font-semibold flex-shrink-0"
                style={{
                  backgroundColor: accentColor,
                  color: userTextColor(config),
                }}
              >
                {sendText}
              </span>
            </button>
            {chips.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {chips.map((msg, i) => (
                  <SuggestionPill
                    key={i}
                    config={config}
                    palette={palette}
                    text={msg}
                  />
                ))}
              </div>
            )}
          </div>
        )}
        <p className="text-[11px] select-none" style={{ color: palette.muted }}>
          Vorschau: Klicken zum {expanded ? "Einklappen" : "Aufklappen"}. Auf
          dem Handy öffnet der Chat im Vollbild.
        </p>
      </div>
    </div>
  );
}
