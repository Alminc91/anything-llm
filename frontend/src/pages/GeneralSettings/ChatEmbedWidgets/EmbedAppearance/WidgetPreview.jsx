// Live-Vorschau des Design Centers (Mock, angelehnt an das Widget): zeigt den
// festen Standard mit den Inhalten des Kunden. Begrüßung als erste Blase,
// Datenschutz-Hinweis als eigene zweite Blase (ausgeschaltet: nur die
// Begrüßungsblase, KIE-565 Nachtrag), Startvorschläge als Pillen wie die
// Folgefragen, eine Beispiel-Nutzernachricht in Akzentfarbe (Schrift auf der
// Akzentfarbe sichtbar), darauf eine Beispiel-Antwort mit Kursen nach der
// Wahl „Antworten mit Kursen“ (Karten zuerst, Text zuerst oder Nur Text mit
// Links, KIE-567; ohne Wahl der Standard der Darstellung, R4), KI-Hinweis
// fest unter der Eingabe, kein Online-Punkt. Willkommensblasen am
// geschlossenen Chat-Button wie am Desktop (bei „Aus“ keine, KIE-568).
// Hell/Dunkel in beiden Darstellungen. Die Vorschau folgt den Feldern: ohne
// gespeicherten Wert zeigt sie die Vorbelegung (R5; Untertitel, Start-
// vorschläge, Willkommensblasen). Lange Wörter brechen um, statt über den
// Rand zu laufen (Restpunkt 5, rc7: BREAK). Chatfenster und Box „In der
// Seite“ wachsen mit dem Inhalt und hängen oben; die Vorschau scrollt, wenn
// das Fenster zu niedrig ist (B-06, R7, D12 rc11: nichts wird abgeschnitten).
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
  DEFAULT_WELCOME_BUBBLES,
  choiceValue,
  displayMode,
  listItems,
  lookValue,
  privacyBlocks,
  privacyNoticeOn,
  privacyTitleFieldValue,
  previewGreeting,
  previewInlineBar,
  previewPlaceholder,
  textItems,
  PILL_MAX_LEN,
  pillLabel,
  pillTextColor,
  subtitleFieldValue,
  textValue,
  themeChoice,
  userTextColor,
  validPrivacyUrl,
} from "./widgetKeys";

export const CHAT_ICONS = [
  { id: "chatBubble", label: "Sprechblase", Icon: ChatCircleDots },
  { id: "support", label: "Support", Icon: Headset },
  { id: "search", label: "Suche", Icon: MagnifyingGlass },
  { id: "search2", label: "Fernglas", Icon: Binoculars },
  { id: "magic", label: "Magie", Icon: MagicWand },
  { id: "plus", label: "Plus", Icon: Plus },
];

// Umbruch langer Wörter (overflow-wrap: anywhere wirkt auch in Pillen und
// Flex-Zeilen, wo break-words nicht reicht)
export const BREAK = "[overflow-wrap:anywhere]";

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
          ? "Vorschau: Eingabeleiste in Ihrer Seite"
          : "Vorschau: so sieht es auf Ihrer Website aus"}
      </p>
      {/* Scrollt, statt etwas abzuschneiden (Browser-Abnahme B-06: die
          Datenschutz-Blase im aufgeklappten Inline-Panel). Beide
          Darstellungen wachsen mit dem Inhalt und hängen deshalb oben, damit
          nichts springt, wenn Inhalt dazukommt oder wegfällt (R7; seit D12,
          rc11, auch das Chatfenster: mit fester Höhe 540 px scrollte der
          Nachrichtenbereich innen und schnitt die Beschriftung der
          Beispiel-Nutzernachricht ab). Die Spalte ist bewusst kein
          Flex-Container: als Flex-Element würde die Vorschau auf die Höhe
          der Spalte gestaucht (align-items: stretch) und schnitte bei
          1440×900 die Eingabe und den KI-Hinweis unten ab, statt dass die
          Spalte scrollt. */}
      <div className="flex-1 min-h-0 overflow-y-auto p-6">
        <div className="w-full flex justify-center">
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
  // Untertitel wie das Widget (R5): ohne gespeicherten Wert der Standard,
  // "" = kein Untertitel
  const subtitle = subtitleFieldValue(config, defaults).trim();
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
// im Widget (KIE-565 Nachtrag): Rand in Akzentfarbe, Schrift in Akzentfarbe
// mit mindestens 4,5:1 auf der Fläche (sonst abgedunkelt bzw. aufgehellt),
// Darüberfahren füllt die Pille in Akzentfarbe, die Schrift wird dann zur
// Schrift auf der Akzentfarbe (im Widget auch beim Tastaturfokus; die
// Vorschau ist nicht bedienbar und deshalb ohne Tab-Halt). Eine Komponente
// für das Chatfenster und für „In der Seite“ (Panel und Leiste).
// kind: data-preview der Pille ("pill" Startvorschlag, "follow-up-pill"
// Folgefrage der Beispiel-Antwort)
export function SuggestionPill({ config, palette, text, kind = "pill" }) {
  const accent = lookValue(config, "accentColor");
  return (
    <span
      className={`rounded-full px-3 py-1 text-[11px] font-medium border cursor-default transition-colors max-w-full ${BREAK} bg-[color:var(--pill-bg)] text-[color:var(--pill-text)] hover:bg-[color:var(--pill-accent)] hover:text-[color:var(--pill-on-accent)]`}
      style={{
        borderColor: accent,
        "--pill-bg": palette.panelBg,
        "--pill-text": pillTextColor(accent, palette.pillTextBgs, palette.text),
        "--pill-accent": accent,
        "--pill-on-accent": userTextColor(config),
      }}
      title={text.length > PILL_MAX_LEN ? text : undefined}
      data-preview={kind}
    >
      {pillLabel(text)}
    </span>
  );
}

// Beispiel einer Nutzer-Nachricht: Akzentfarbe mit der Schrift auf der
// Akzentfarbe, darunter die Beschriftung, beide rechtsbündig in einem Block
// (D12: die Beschriftung bleibt eine Zeile und wird nicht gekürzt)
function PreviewUserMessage({ config, palette }) {
  return (
    <div
      className="flex flex-col items-end gap-1 pt-1"
      data-preview="user-message-block"
    >
      <div
        className={`text-[12.5px] leading-relaxed rounded-[18px] rounded-tr-[4px] px-3.5 py-2.5 max-w-[80%] ${BREAK}`}
        style={{
          backgroundColor: lookValue(config, "accentColor"),
          color: userTextColor(config),
        }}
        data-preview="user-message"
      >
        {SAMPLE_USER_MESSAGE}
      </div>
      <span
        className="text-[10px] leading-snug whitespace-nowrap"
        style={{ color: palette.muted }}
        data-preview="user-message-caption"
      >
        Beispiel-Nutzernachricht
      </span>
    </div>
  );
}

// Beispiel-Antwort mit Kursen (passend zur Beispiel-Nutzernachricht)
export const SAMPLE_COURSES = [
  { title: "Yoga am Wochenende", meta: "Sa 10:00 Uhr · Plätze frei" },
  { title: "Aquarellmalen", meta: "So 14:00 Uhr · Wenige Plätze" },
];
export const SAMPLE_ANSWER_TEXT =
  "Am Wochenende passen zwei Kurse: einer für Bewegung, einer zum Malen.";
export const SAMPLE_TEXT_ONLY_INTRO = "Am Wochenende passen zwei Kurse:";
export const SAMPLE_FOLLOW_UP = "Gibt es auch Online-Kurse?";

// Kurskarte als Zeile (fest „rows“ wie im Widget): Titel, darunter Zeit und
// Status
function PreviewCourseCard({ course, palette, accent }) {
  return (
    <div
      className="rounded-xl px-3 py-2 flex flex-col gap-0.5"
      style={{
        border: `1px solid ${palette.line}`,
        backgroundColor: palette.panelBg,
        borderLeft: `3px solid ${accent}`,
      }}
      data-preview="course-card"
    >
      <span
        className={`text-[12px] font-semibold leading-snug ${BREAK}`}
        style={{ color: palette.text }}
      >
        {course.title}
      </span>
      <span className="text-[10.5px]" style={{ color: palette.muted }}>
        {course.meta}
      </span>
    </div>
  );
}

// Antwort des Chatbots auf die Beispiel-Nutzernachricht: Kurskarten zuerst
// oder Text zuerst, bei „Nur Text mit Links“ die klassische Antwort mit
// verlinkten Kurstiteln; darunter eine Folgefrage
export function PreviewSampleAnswer({ config, palette }) {
  const accent = lookValue(config, "accentColor");
  const cardsOn = choiceValue(config, "courseCards") === "auto";
  const position = choiceValue(config, "courseCardsPosition");
  const textStyle = { color: palette.text };
  const text = (
    <p
      className={`text-[12.5px] leading-relaxed ${BREAK}`}
      style={textStyle}
      data-preview="answer-text"
    >
      {SAMPLE_ANSWER_TEXT}
    </p>
  );
  const cards = (
    <div className="space-y-1.5" data-preview="course-cards">
      {SAMPLE_COURSES.map((course) => (
        <PreviewCourseCard
          key={course.title}
          course={course}
          palette={palette}
          accent={accent}
        />
      ))}
    </div>
  );
  return (
    <div
      className="w-full space-y-2 pt-1"
      data-preview="sample-answer"
      data-course-cards={cardsOn ? "auto" : "off"}
      data-cards-position={cardsOn ? position : undefined}
    >
      {cardsOn ? (
        position === "below" ? (
          <>
            {text}
            {cards}
          </>
        ) : (
          <>
            {cards}
            {text}
          </>
        )
      ) : (
        <div
          className={`text-[12.5px] leading-relaxed space-y-1 ${BREAK}`}
          style={textStyle}
          data-preview="answer-text"
        >
          <p>{SAMPLE_TEXT_ONLY_INTRO}</p>
          {SAMPLE_COURSES.map((course, i) => (
            <p key={course.title} data-preview="course-link">
              {i + 1}.{" "}
              <span
                className="underline font-semibold"
                style={{ color: accent }}
              >
                {course.title}
              </span>
              <span style={{ color: palette.muted }}>, {course.meta}</span>
            </p>
          ))}
        </div>
      )}
      <div className="flex flex-wrap gap-1.5 pt-0.5" data-preview="follow-ups">
        <SuggestionPill
          config={config}
          palette={palette}
          text={SAMPLE_FOLLOW_UP}
          kind="follow-up-pill"
        />
      </div>
      <span
        className="block text-[10px] leading-snug"
        style={{ color: palette.muted }}
        data-preview="answer-caption"
      >
        Beispiel-Antwort
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
  // ohne gespeicherte Liste die Standard-Startvorschläge des Servers (S1,
  // wie live im Widget; R5)
  const pills = textItems(listItems(config, "defaultMessages", defaults)).slice(
    0,
    6
  );
  const bubble = {
    backgroundColor: palette.bubbleBg,
    color: palette.text,
  };
  return (
    <div className="w-full space-y-2.5" data-preview="welcome">
      <div
        className={`text-[12.5px] leading-relaxed rounded-[18px] rounded-tl-[4px] px-3.5 py-2.5 max-w-[88%] ${BREAK}`}
        style={bubble}
        data-preview="greeting-bubble"
      >
        {greeting}
      </div>
      {showPrivacy && (
        <div
          className={`text-[11.5px] leading-relaxed rounded-[18px] rounded-tl-[4px] px-3.5 py-2.5 max-w-[88%] space-y-1 ${BREAK}`}
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
      <PreviewSampleAnswer config={config} palette={palette} />
    </div>
  );
}

// Eingabe mit fester KI-Zeile darunter (eine Zeile, dezent)
function PreviewInput({ config, defaults, palette }) {
  const placeholder = previewPlaceholder(config, defaults);
  return (
    <div className="px-4 pb-2.5 pt-1 flex-shrink-0" data-preview="input">
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
          "Unsere KI kann Fehler machen. Bitte prüfen Sie die Antworten."}
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
  // Willkommensblasen wie am Desktop (KIE-568): „Aus“ = keine; ohne eigene
  // Texte die Standardblasen wie im Widget (im Feld als Vorbelegung, R5)
  const desktopBubbles = choiceValue(config, "welcomeBubblesDesktop");
  const ownBubbles = textItems(listItems(config, "chatbotBubblesMessages"));
  const bubbles =
    desktopBubbles === "off"
      ? []
      : ownBubbles.length > 0
        ? ownBubbles
        : DEFAULT_WELCOME_BUBBLES;
  const devicesDiffer =
    desktopBubbles !== choiceValue(config, "welcomeBubblesMobile");
  return (
    <div className="w-[370px] max-w-full flex flex-col items-stretch">
      {/* Mindesthöhe 540 px wie das Widget; geöffnet wächst das Fenster mit
          dem Inhalt (D12, rc11: mit fester Höhe scrollte der Nachrichten-
          bereich innen bei versteckter Bildlaufleiste und schnitt unten die
          Beschriftung „Beispiel-Nutzernachricht“ und die Beispiel-Antwort
          ab). Geschlossen bleiben die Willkommensblasen unten in der
          540-px-Fläche. */}
      <div
        className="flex flex-col justify-end"
        style={{ minHeight: "540px" }}
        data-preview="chat-window"
      >
        {open ? (
          <div
            className="w-full grow rounded-2xl flex flex-col overflow-hidden"
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
            <div className="flex-1 px-4 py-4" data-preview="chat-messages">
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
                  data-preview="welcome-bubble"
                  className={`rounded-2xl px-4 py-2.5 text-[13px] w-full ${BREAK}`}
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
      {!open && devicesDiffer && (
        <p
          className={`text-[11px] mt-2 ${isLeft ? "self-start" : "self-end"}`}
          style={{ color: palette.muted }}
          data-preview="welcome-bubbles-note"
        >
          Willkommensblasen in der Vorschau wie am Desktop.
        </p>
      )}
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
  const chips = textItems(listItems(config, "defaultMessages", defaults)).slice(
    0,
    6
  );
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
