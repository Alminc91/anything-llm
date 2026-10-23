// Live-Vorschau des Design Centers (Mock, angelehnt an das Widget): zeigt den
// festen Standard mit den Inhalten des Kunden. Begrüßung als erste Blase
// (keine Datenschutz-Blase mehr, Datenschutz-Fußzeile 7.23), Startvorschläge
// als Pillen wie die Folgefragen, eine Beispiel-Nutzernachricht in
// Akzentfarbe (Schrift auf der Akzentfarbe sichtbar), darauf eine
// Beispiel-Antwort mit Kursen nach der Wahl „Antworten mit Kursen“ (Karten
// zuerst, Text zuerst oder Nur Text mit Links, KIE-567; ohne Wahl der
// Standard der Darstellung, R4), unter der Eingabe fest die Zeile „Unsere
// KI kann Fehler machen · Datenschutz“; der Link öffnet das
// Datenschutz-Fenster über dem Chat (Nutzer 23.10.2026,
// issues/datenschutz-fusszeile.md AK-9), kein Online-Punkt.
// Willkommensblasen am geschlossenen Chat-Button wie am Desktop (bei „Aus“
// keine, KIE-568). Hell/Dunkel in beiden Darstellungen. Die Vorschau folgt
// den Feldern: ohne gespeicherten Wert zeigt sie die Vorbelegung (R5;
// Untertitel, Startvorschläge, Willkommensblasen). Farben wie im Widget:
// einen Wert, den die Farbregel nicht annimmt (accentColorError meldet ihn),
// zeigt sie als Standard (previewAccentColor, previewUserTextColor; Fixliste
// 7.22-rc22 E41 Ergänzung (b)), das Feld zeigt weiter den eingegebenen Wert.
// Lange Wörter brechen um, statt über den Rand zu laufen (Restpunkt 5, rc7:
// BREAK). Chatfenster und Box „In der Seite“ haben eine feste Höhe wie live
// im Widget (Rückmeldung des Nutzers vom 20.10.2026: 77 % der
// Vorschaufläche bzw. 520 px); der Nachrichtenbereich scrollt innen mit
// sichtbarer Bildlaufleiste, beim Öffnen steht der Verlauf oben, nichts wird
// abgeschnitten (D12 rc11). Ändern sich Begrüßung oder Startvorschläge,
// scrollt der Verlauf den Block ins Bild (F10, Fixliste 7.22-rc13); ändern
// sich Überschrift, Text oder Link des Datenschutz-Hinweises, öffnet sich
// das Datenschutz-Fenster mit der Änderung (ohne dem Feld den Fokus zu
// nehmen). Beide hängen oben; die Vorschau-Spalte scrollt nur, wenn das
// Fenster zu niedrig ist (B-06, R7).
import { useId, useLayoutEffect, useRef, useState } from "react";
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
  DEFAULT_ACCENT_COLOR,
  DEFAULT_WELCOME_BUBBLES,
  choiceValue,
  displayMode,
  listItems,
  lookValue,
  privacyBlocks,
  privacyTitleFieldValue,
  previewAccentColor,
  previewGreeting,
  previewInlineBar,
  previewPlaceholder,
  previewUserTextColor,
  textItems,
  PILL_MAX_LEN,
  pillLabel,
  pillTextColor,
  subtitleFieldValue,
  textValue,
  themeChoice,
  validPrivacyUrl,
} from "./widgetKeys";
import { parseColor } from "./contrast";

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

// Fensterhöhe des Chatfensters in der Vorschau (Rückmeldung des Nutzers vom
// 20.10.2026): dieselbe Rechnung wie live im Widget am Desktop, bezogen auf
// die Höhe der Vorschaufläche statt auf 100vh. Live ist das Fenster
// allm-h-full mit md:allm-max-h-[77%] (Widget src/App.jsx responsiveClasses),
// also 77 % der Seitenhöhe. Ein fester Wert windowHeight käme nur aus den
// Serverstandards (Widget src/utils/layout.js bubbleWindowCss: min(max(400 px,
// windowHeight), 100vh minus Randabstand)); der Server setzt keinen
// (server/utils/chats/embedStandards.js), deshalb gilt die 77-%-Klasse. Nie
// unter WINDOW_MIN_HEIGHT_PX (Widget src/utils/layout.js). Ohne Maß
// (serverseitiges Rendern, vor der ersten Messung) die Mindesthöhe.
export const WINDOW_MIN_HEIGHT_PX = 400;
export const WINDOW_HEIGHT_SHARE = 0.77;
export function previewWindowHeight(areaHeight) {
  if (!(areaHeight > 0)) return WINDOW_MIN_HEIGHT_PX;
  return Math.max(
    WINDOW_MIN_HEIGHT_PX,
    Math.round(areaHeight * WINDOW_HEIGHT_SHARE)
  );
}

// Höhe der aufgeklappten Box „In der Seite“: fest wie live (Serverstandard
// inlineHeight in server/utils/chats/embedStandards.js, im Widget
// DEFAULT_INLINE_HEIGHT)
export const INLINE_PANEL_HEIGHT_PX = 520;

// Schatten des aufgeklappten Panels „In der Seite“ wie im Widget (theme.js,
// Standard seit 7.22.2, Nutzer 23.10.2026 nach der rhein-Demo): hell weich
// und tief, leicht in der Akzentfarbe getönt (Akzent × 0,33), dunkel schwarz
// mit feinem Rand in der Akzentfarbe. Maße wegen der kleineren Vorschau
// etwas kürzer als live (30/70 statt 40/90 px).
export function inlinePanelShadow(accent, scheme) {
  const rgb = parseColor(accent) || parseColor(DEFAULT_ACCENT_COLOR);
  if (scheme === "dark")
    return `0 30px 70px -30px rgba(0,0,0,.8), 0 0 0 1px rgba(${rgb.join(",")},.1)`;
  const [r, g, b] = rgb.map((c) => Math.round(c * 0.33));
  return `0 30px 70px -30px rgba(${r},${g},${b},.45), 0 4px 14px rgba(23,24,27,.06)`;
}

// Verlauf an den Anfang scrollen: beim Öffnen und Aufklappen zeigt die
// Vorschau wie beim ersten Besuch zuerst Kopf und Begrüßung (bis 7.22.2 mit
// der Datenschutz-Blase); die Beispiel-Antwort ist durch Runterscrollen
// erreichbar und kommt ins Bild, sobald sich eine Einstellung unter
// „Antworten mit Kursen“ ändert (Nutzer 23.10.2026; bis 7.22.1 stand der
// Verlauf unten wie ein wieder geladener Verlauf, Rückmeldung 20.10.).
export function scrollToStart(el) {
  if (!el) return;
  el.scrollTop = 0;
}

// Abstand eines ins Bild gescrollten Blocks zum Rand des Verlaufs (px)
export const REVEAL_MARGIN_PX = 8;

/**
 * Neue Bildlaufposition, damit ein Block im Verlauf zu sehen ist (F10,
 * Fixliste 7.22-rc13): steht er oben außerhalb, so weit hoch, dass seine
 * Oberkante mit Abstand sichtbar ist; steht er unten außerhalb, so weit
 * runter, dass seine Unterkante sichtbar ist, aber nie so weit, dass die
 * Oberkante oben herausfällt. Sichtbar: unverändert.
 * @param {{scrollTop: number, viewTop: number, viewBottom: number,
 *   top: number, bottom: number}} m Maße (getBoundingClientRect)
 * @returns {number}
 */
export function revealScrollTop({
  scrollTop,
  viewTop,
  viewBottom,
  top,
  bottom,
}) {
  const minTop = viewTop + REVEAL_MARGIN_PX;
  const maxBottom = viewBottom - REVEAL_MARGIN_PX;
  if (top < minTop) return Math.max(0, scrollTop - (minTop - top));
  if (bottom > maxBottom)
    return scrollTop + Math.max(0, Math.min(bottom - maxBottom, top - minTop));
  return scrollTop;
}

// Verläufe der Vorschau, die innen scrollen
const PREVIEW_SCROLLERS = ["chat-messages", "inline-messages"];

/**
 * Block im Verlauf der Vorschau ins Bild scrollen (nur der Verlauf scrollt,
 * nicht die Seite). Ohne Maße (kein Browser) passiert nichts.
 * @param {Element|null} el
 */
export function revealInPreview(el) {
  if (!el || typeof el.getBoundingClientRect !== "function") return;
  let scroller = el.parentNode;
  while (
    scroller &&
    !(
      typeof scroller.getAttribute === "function" &&
      PREVIEW_SCROLLERS.includes(scroller.getAttribute("data-preview"))
    )
  )
    scroller = scroller.parentNode;
  if (!scroller || typeof scroller.scrollTop !== "number") return;
  const view = scroller.getBoundingClientRect();
  const box = el.getBoundingClientRect();
  const next = revealScrollTop({
    scrollTop: scroller.scrollTop,
    viewTop: view.top,
    viewBottom: view.bottom,
    top: box.top,
    bottom: box.bottom,
  });
  if (next !== scroller.scrollTop) scroller.scrollTop = next;
}

// Block nach einer Änderung seines Inhalts ins Bild holen. Nicht beim
// ersten Zeichnen und nicht, wenn die Standardtexte (GET /embed/defaults)
// erst nach dem Zeichnen ankommen: dann bleibt der Verlauf, wo er beim
// Öffnen stand (oben). signature null = Standardtexte noch nicht
// geladen (nach einem Ladefehler gilt die Signatur, F42 Fixliste
// 7.22-rc16).
function useRevealOnChange(ref, signature) {
  const last = useRef(signature);
  useLayoutEffect(() => {
    if (last.current === signature) return;
    const loaded = last.current !== null;
    last.current = signature;
    if (loaded && signature !== null) revealInPreview(ref.current);
  }, [signature]);
}

// Sichtbare, zum Farbschema passende Bildlaufleiste des Verlaufs
// (index.css .preview-scrollbar; color-scheme für die Leiste des Systems)
function scrollbarStyle(palette) {
  return {
    colorScheme: palette.scheme,
    "--preview-scrollbar-thumb": palette.scrollbar,
  };
}

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
    // Blasen von Begrüßung und Antworten und das Datenschutz-Fenster wie im
    // Widget:
    // weiß mit Schatten (theme.js assistant-bg, bubble-shadow; bis 7.22.1
    // zeigte die Vorschau sie grau, Nutzer 23.10.2026)
    bubbleBg: "#ffffff",
    bubbleShadow: "0 4px 14px rgba(0, 0, 0, 0.25)",
    inputBg: "#ffffff",
    // Flächen, auf denen die Schrift der Pillen 4,5:1 erreichen muss (wie
    // im Widget, theme.js pillTextColor)
    pillTextBgs: ["#ffffff"],
    scheme: "light",
    scrollbar: "rgba(0,0,0,0.3)",
  },
  dark: {
    pageBg: "#2b2b31",
    siteBar: "#2a2a30",
    skeleton: "#4a4a52",
    panelBg: "#1d1d21",
    text: "#f4f4f5",
    muted: "#b4b4bb",
    line: "rgba(255,255,255,.12)",
    // wie im Widget (DARK.assistantBg, DARK.bubbleShadow)
    bubbleBg: "#2a2a2f",
    bubbleShadow: "0 4px 14px rgba(0, 0, 0, 0.35)",
    inputBg: "#141417",
    // Panel der Vorschau und Flächen des dunklen Widgets (DARK.bg, surface)
    pillTextBgs: ["#1d1d21", "#131316"],
    scheme: "dark",
    scrollbar: "rgba(255,255,255,0.3)",
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
 *   defaultsError?: boolean, greetingKey: string}} props
 *   defaultsError: Laden der Standardtexte fehlgeschlagen (sie kommen nicht
 *   mehr; bearbeitete Blöcke werden trotzdem ins Bild geholt, F42)
 */
export default function WidgetPreview({
  config,
  logoPreview,
  defaults,
  defaultsError = false,
  greetingKey,
}) {
  const palette = paletteOf(config);
  const inline = displayMode(config) === "inline";
  // Höhe der Vorschaufläche (die scrollende Spalte) für die Fensterhöhe des
  // Chatfensters, nachgeführt bei Größenänderung; ohne Browser kein Maß
  const areaRef = useRef(null);
  const [areaHeight, setAreaHeight] = useState(null);
  useLayoutEffect(() => {
    const el = areaRef.current;
    if (!el) return undefined;
    const measure = () => setAreaHeight(el.clientHeight || null);
    measure();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
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
      {/* Die Vorschaufläche: scrollt, statt etwas abzuschneiden, wenn
          Fenster bzw. Box samt Chat-Button höher sind als die Spalte (B-06).
          Beide Darstellungen hängen oben, damit nichts springt, wenn Inhalt
          dazukommt oder wegfällt (R7). Seit der Rückmeldung vom 20.10.2026
          haben Chatfenster und Box eine feste Höhe wie live (D12 rc11 ließ
          sie mit dem Inhalt wachsen, die Vorschau war dadurch deutlich höher
          als das Widget); der Verlauf scrollt innen mit sichtbarer
          Bildlaufleiste. Die Spalte ist bewusst kein Flex-Container: als
          Flex-Element würde die Vorschau auf die Höhe der Spalte gestaucht
          (align-items: stretch), statt dass die Spalte scrollt. */}
      <div
        ref={areaRef}
        className="flex-1 min-h-0 overflow-y-auto p-6"
        data-preview="area"
      >
        <div className="w-full flex justify-center">
          {inline ? (
            <InlinePreview
              config={config}
              logoPreview={logoPreview}
              defaults={defaults}
              defaultsError={defaultsError}
              greetingKey={greetingKey}
              palette={palette}
            />
          ) : (
            <BubblePreview
              config={config}
              logoPreview={logoPreview}
              defaults={defaults}
              defaultsError={defaultsError}
              greetingKey={greetingKey}
              palette={palette}
              areaHeight={areaHeight}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// Kopf: Logo, Name, optionaler Untertitel; kein Online-Punkt. Name und
// Untertitel werden nie gekürzt, sondern brechen um, der Kopf wird dann
// höher (mindestens 60 px); der Button rechts bleibt frei (gap-3, 12 px),
// wie im Widget (N3, Nutzerentscheidung 20.10.2026, Fixliste 7.22-rc13:
// „Es muss immer ausgeschrieben sein“; ersetzt die Ellipse aus rc10 W1).
function PreviewHeader({ config, logoPreview, defaults, palette, action }) {
  const name =
    textValue(config.name).trim() || textValue(defaults?.name) || "KI-Berater";
  // Untertitel wie das Widget (R5): ohne gespeicherten Wert der Standard,
  // "" = kein Untertitel
  const subtitle = subtitleFieldValue(config, defaults).trim();
  return (
    <div
      className="flex items-center gap-3 px-4 py-2.5 min-h-[60px] flex-shrink-0"
      style={{ borderBottom: `1px solid ${palette.line}` }}
      data-preview="header"
    >
      <img
        src={logoPreview || DEFAULT_LOGO}
        alt="Logo"
        className="h-9 w-9 rounded-lg object-contain flex-shrink-0"
      />
      <span className="flex flex-col min-w-0 flex-1">
        <span
          className={`font-semibold text-sm leading-snug ${BREAK}`}
          style={{ color: palette.text }}
          data-preview="header-name"
        >
          {name}
        </span>
        {subtitle && (
          <span
            className={`text-[11px] leading-snug ${BREAK}`}
            style={{ color: palette.muted }}
            data-preview="header-subtitle"
          >
            {subtitle}
          </span>
        )}
      </span>
      <span className="flex-shrink-0 flex items-center">{action}</span>
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
  const accent = previewAccentColor(config);
  return (
    <span
      className={`rounded-full px-3 py-1 text-[11px] font-medium border cursor-default transition-colors max-w-full ${BREAK} bg-[color:var(--pill-bg)] text-[color:var(--pill-text)] hover:bg-[color:var(--pill-accent)] hover:text-[color:var(--pill-on-accent)]`}
      style={{
        borderColor: accent,
        "--pill-bg": palette.panelBg,
        "--pill-text": pillTextColor(accent, palette.pillTextBgs, palette.text),
        "--pill-accent": accent,
        "--pill-on-accent": previewUserTextColor(config),
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
          backgroundColor: previewAccentColor(config),
          color: previewUserTextColor(config),
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
  const accent = previewAccentColor(config);
  const cardsOn = choiceValue(config, "courseCards") === "auto";
  const position = choiceValue(config, "courseCardsPosition");
  // Änderung unter „Antworten mit Kursen“ (Kurse anzeigen als, Reihenfolge):
  // die Beispiel-Antwort kommt ins Bild, weil der Verlauf oben beginnt
  // (Nutzer 23.10.2026); nicht beim ersten Zeichnen
  const answerRef = useRef(null);
  useRevealOnChange(
    answerRef,
    JSON.stringify([cardsOn, cardsOn ? position : null])
  );
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
      ref={answerRef}
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

// Startzustand des Chats: Begrüßungsblase, Pillen, Beispiel-Nutzernachricht.
// Die Datenschutz-Blase entfällt seit 7.23 (Datenschutz-Fußzeile, AK-1): Der
// Hinweis steht im Fenster hinter dem Link unter der Eingabe.
export function PreviewWelcome({
  config,
  defaults,
  defaultsError = false,
  greetingKey,
  palette,
}) {
  const greeting = previewGreeting(config, greetingKey, defaults);
  // ohne gespeicherte Liste die Standard-Startvorschläge des Servers (S1,
  // wie live im Widget; R5); seit E42 leer, also keine Pillen
  const pills = textItems(listItems(config, "defaultMessages", defaults)).slice(
    0,
    6
  );
  // F10 (Fixliste 7.22-rc13): Wer im Reiter Inhalt Begrüßung oder
  // Startvorschläge ändert, sieht den Block in der Vorschau, auch wenn der
  // Verlauf woanders steht (Datenschutz: usePrivacyWindow öffnet das Fenster)
  const greetingRef = useRef(null);
  const pillsRef = useRef(null);
  // Signaturen erst, wenn die Standardtexte da sind oder nicht mehr kommen
  // (Ladefehler, F42 Fixliste 7.22-rc16: sonst blieben sie immer null und
  // nichts käme ins Bild)
  const loaded = (signature) => (defaults || defaultsError ? signature : null);
  useRevealOnChange(greetingRef, loaded(greeting));
  // getrimmt wie gespeichert (cleanConfig): Speichern ist keine Bearbeitung,
  // die Vorschau springt danach nicht zu den Pillen (F43 Fixliste 7.22-rc16)
  useRevealOnChange(
    pillsRef,
    loaded(JSON.stringify(pills.map((pill) => pill.trim())))
  );
  // Begrüßung wie im Widget seit 7.22.2: Fläche, Schatten, Schrift (Nutzer
  // 23.10.2026); dieselbe Fläche und Schrift hat das Datenschutz-Fenster
  const bubble = {
    backgroundColor: palette.bubbleBg,
    boxShadow: palette.bubbleShadow,
    color: palette.text,
  };
  return (
    <div className="w-full space-y-2.5" data-preview="welcome">
      <div
        ref={greetingRef}
        className={`text-[12.5px] leading-relaxed rounded-[18px] rounded-tl-[4px] px-3.5 py-2.5 max-w-[88%] ${BREAK}`}
        style={bubble}
        data-preview="greeting-bubble"
      >
        {greeting}
      </div>
      {pills.length > 0 && (
        <div
          ref={pillsRef}
          className="flex flex-wrap gap-1.5 pt-1"
          data-preview="pills"
        >
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

// Feste Texte von Fußzeile und Datenschutz-Fenster, solange die
// Standardtexte (GET /embed/defaults, Sprache de) nicht geladen sind; gleich
// embedDefaultTexts("de") im Server (Test designCenterPrivacyLink).
export const PRIVACY_PREVIEW_TEXTS = Object.freeze({
  disclaimerText: "Unsere KI kann Fehler machen",
  privacyLinkText: "Datenschutz",
  privacyTitle: "Datenschutz",
  privacyAiTitle: "Hinweis zur KI",
  privacyAiText:
    "Unser KI-Berater ist auf richtige Auskünfte optimiert. Wie jede KI kann er sich dennoch einmal irren. Wichtige Angaben wie Termine und Preise finden Sie zur Kontrolle immer auf unserer Website.",
  privacyCloseText: "Schließen",
});
// Beschriftung des Schließen-Symbols im Fenster (wie im Widget, de) und
// Linktext zur Datenschutzerklärung (Widget PANEL_TEXTS.privacyBubbleLink)
export const PRIVACY_CLOSE_LABEL = "Datenschutz schließen";
export const PRIVACY_STATEMENT_LINK = "Datenschutzerklärung";

/**
 * Inhalt von Fußzeile und Datenschutz-Fenster der Vorschau: feste Texte aus
 * den Standardtexten (sonst PRIVACY_PREVIEW_TEXTS), Überschrift wie das Feld
 * (gespeichert, sonst Standard; leer gilt wie der Standard, wie im Widget
 * und beim Speichern, F5), Text als
 * Absätze und Punkte (gespeichert, sonst Standard; nie als HTML), Link zur
 * Datenschutzerklärung nur als gültige https-Adresse oder Pfad.
 * @param {Object} config
 * @param {Object|null} defaults
 */
export function previewPrivacy(config, defaults) {
  const text = textValue(config.privacyText).trim()
    ? config.privacyText
    : textValue(defaults?.privacyText);
  const standard = defaults || PRIVACY_PREVIEW_TEXTS;
  return {
    ...privacyFixedTexts(defaults),
    title:
      privacyTitleFieldValue(config, standard).trim() ||
      textValue(standard.privacyTitle).trim() ||
      PRIVACY_PREVIEW_TEXTS.privacyTitle,
    blocks: privacyBlocks(text),
    url: validPrivacyUrl(config.privacyUrl) ? config.privacyUrl.trim() : "",
  };
}

// Feste Texte (nicht im Design Center änderbar) aus den Standardtexten
function privacyFixedTexts(defaults) {
  const fixed = (key) =>
    textValue(defaults?.[key]).trim() || PRIVACY_PREVIEW_TEXTS[key];
  return {
    disclaimer: fixed("disclaimerText"),
    linkText: fixed("privacyLinkText"),
    aiTitle: fixed("privacyAiTitle"),
    aiText: fixed("privacyAiText"),
    closeText: fixed("privacyCloseText"),
  };
}

// Linkfarbe auf einer Fläche: die Akzentfarbe mit mindestens 4,5:1, sonst
// abgedunkelt bzw. aufgehellt (wie die Pillen, AK-2)
function linkColor(config, palette, backgrounds) {
  return pillTextColor(previewAccentColor(config), backgrounds, palette.text);
}

const PRIVACY_CLOSED = Object.freeze({ isOpen: false, focus: false });

/**
 * Datenschutz-Fenster der Vorschau offen oder zu (AK-9). Klick auf den Link
 * öffnet es und setzt den Fokus hinein; Schließen setzt den Fokus zurück auf
 * den Link. Ändert sich der Inhalt (Überschrift, Text oder Link im Reiter
 * Inhalt), öffnet es sich ohne Fokuswechsel, damit die Änderung zu sehen ist
 * (wie F10 bei der Begrüßung); onReveal öffnet dazu den Chat. Nicht beim
 * ersten Zeichnen und nicht, wenn die Standardtexte erst danach ankommen
 * (signature null = noch nicht geladen, wie useRevealOnChange).
 * @param {string|null} signature
 * @param {() => void} [onReveal]
 */
function usePrivacyWindow(signature, onReveal) {
  const [state, setState] = useState(PRIVACY_CLOSED);
  const linkRef = useRef(null);
  const last = useRef(signature);
  useLayoutEffect(() => {
    if (last.current === signature) return;
    const loaded = last.current !== null;
    last.current = signature;
    if (!loaded || signature === null) return;
    setState((prev) => (prev.isOpen ? prev : { isOpen: true, focus: false }));
    onReveal?.();
  }, [signature]);
  return {
    ...state,
    linkRef,
    show: () => setState({ isOpen: true, focus: true }),
    close: () => {
      setState(PRIVACY_CLOSED);
      linkRef.current?.focus();
    },
    // beim Schließen bzw. Einklappen des Chats, ohne Fokuswechsel
    reset: () => setState(PRIVACY_CLOSED),
  };
}

// Signatur des Fensterinhalts für usePrivacyWindow
function privacySignature(config, defaults, defaultsError) {
  if (!defaults && !defaultsError) return null;
  const { title, blocks, url } = previewPrivacy(config, defaults);
  return JSON.stringify([title, blocks, url]);
}

// Abstände des Datenschutz-Fensters: im Chatfenster wie die Blasen, im Panel
// „In der Seite“ weiter innen wegen der Rundung von 40 px
const PRIVACY_DIALOG_INSETS = {
  bubble: { x: "px-4", close: "top-2 right-2", title: "pr-11" },
  inline: { x: "px-8", close: "top-3.5 right-5", title: "pr-14" },
};

/**
 * Datenschutz-Fenster über dem ganzen Chat (Panel des Chatfensters bzw. das
 * aufgeklappte Panel „In der Seite“), wie im Widget (PrivacyNotice):
 * Überschrift (gespeichert, sonst und bei leerem Feld der Standard), Text,
 * Punkt „Hinweis zur KI“, Link zur Datenschutzerklärung (falls gesetzt),
 * Button „Schließen“, das Schließen-Symbol oben rechts (im Dokument zuletzt).
 * Fläche und Schrift der Antwortblasen, Rundung des Panels (D2).
 * role="dialog", aria-labelledby auf die Überschrift; nach einem Klick auf
 * den Link aria-modal und Fokus auf der Überschrift, Tab-Reihenfolge Text,
 * Schließen, Schließen-Symbol, Tab bleibt im Fenster; Esc schließt. Öffnet
 * es sich beim Bearbeiten eines Felds (focusOnOpen false), bleibt der Fokus
 * im Feld und das Fenster ohne aria-modal: Das Design Center daneben bleibt
 * für Screenreader erreichbar. Der Link
 * zur Datenschutzerklärung ist in der Vorschau nicht bedienbar (ein Pfad
 * wie /datenschutz gehört zur Seite des Kunden, nicht zum Design Center).
 */
function PreviewPrivacyDialog({
  config,
  defaults,
  palette,
  focusOnOpen = false,
  onClose,
  inline = false,
}) {
  const titleId = useId();
  const dialogRef = useRef(null);
  const headingRef = useRef(null);
  const bodyRef = useRef(null);
  const iconRef = useRef(null);
  const privacy = previewPrivacy(config, defaults);
  const inset = PRIVACY_DIALOG_INSETS[inline ? "inline" : "bubble"];
  const link = linkColor(config, palette, [palette.bubbleBg]);
  useLayoutEffect(() => {
    if (focusOnOpen) headingRef.current?.focus();
  }, []);
  const onKeyDown = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== "Tab") return;
    // Tab-Falle: Text, Schließen, Schließen-Symbol, dann wieder der Text
    const active = dialogRef.current?.ownerDocument?.activeElement;
    const first = bodyRef.current;
    const last = iconRef.current;
    if (e.shiftKey && (active === first || active === headingRef.current)) {
      e.preventDefault();
      last?.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first?.focus();
    }
  };
  const focusRing =
    "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2";
  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal={focusOnOpen ? "true" : undefined}
      aria-labelledby={titleId}
      onKeyDown={onKeyDown}
      className="absolute inset-0 z-20 flex flex-col"
      style={{ backgroundColor: palette.bubbleBg, color: palette.text }}
      data-preview="privacy-dialog"
    >
      <div
        className={`${inset.x} ${inset.title} pt-3.5 pb-2.5 flex-shrink-0`}
        style={{ borderBottom: `1px solid ${palette.line}` }}
      >
        <h3
          id={titleId}
          ref={headingRef}
          tabIndex={-1}
          className={`text-[15px] font-bold leading-snug outline-none ${BREAK}`}
        >
          {privacy.title}
        </h3>
      </div>
      <div
        ref={bodyRef}
        tabIndex={0}
        className={`flex-1 min-h-0 overflow-y-auto preview-scrollbar ${inset.x} py-3 space-y-3 text-[12.5px] leading-relaxed focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 ${BREAK}`}
        style={{ ...scrollbarStyle(palette), outlineColor: link }}
        data-preview="privacy-dialog-body"
      >
        {privacy.blocks.length > 0 && (
          <div className="space-y-1">
            {privacy.blocks.map((block, i) =>
              block.type === "bullet" ? (
                <p key={i} className="flex gap-1.5">
                  <span aria-hidden="true">•</span>
                  <span>{block.text}</span>
                </p>
              ) : (
                <p key={i}>{block.text}</p>
              )
            )}
          </div>
        )}
        <div className="space-y-0.5" data-preview="privacy-ai">
          <p className="font-semibold">{privacy.aiTitle}</p>
          <p>{privacy.aiText}</p>
        </div>
        {privacy.url && (
          <p>
            <span
              className="underline underline-offset-2 font-medium"
              style={{ color: link }}
              title={privacy.url}
              data-preview="privacy-statement-link"
            >
              {PRIVACY_STATEMENT_LINK}
            </span>
          </p>
        )}
      </div>
      <div
        className={`flex justify-end ${inset.x} pt-2.5 pb-3.5 flex-shrink-0`}
        style={{ borderTop: `1px solid ${palette.line}` }}
      >
        <button
          type="button"
          onClick={onClose}
          className={`h-10 px-5 rounded-xl text-[13px] font-semibold ${focusRing}`}
          style={{
            backgroundColor: previewAccentColor(config),
            color: previewUserTextColor(config),
            outlineColor: link,
          }}
        >
          {privacy.closeText}
        </button>
      </div>
      <button
        type="button"
        ref={iconRef}
        onClick={onClose}
        aria-label={PRIVACY_CLOSE_LABEL}
        title={PRIVACY_CLOSE_LABEL}
        className={`absolute ${inset.close} w-8 h-8 rounded-lg flex items-center justify-center ${focusRing}`}
        style={{ color: palette.muted, outlineColor: link }}
      >
        <X size={16} weight="bold" aria-hidden="true" />
      </button>
    </div>
  );
}

// Eingabe mit fester Zeile darunter: KI-Hinweis und Link „Datenschutz“ in
// einer Zeile, dezent; nur der Linktext ist klickbar (Nutzer 23.10.2026).
// Bei Platzmangel kürzt sich der KI-Hinweis, nie der Link.
function PreviewInput({
  config,
  defaults,
  palette,
  privacyLinkRef,
  privacyOpen = false,
  onOpenPrivacy,
}) {
  const placeholder = previewPlaceholder(config, defaults);
  const { disclaimer, linkText } = privacyFixedTexts(defaults);
  const link = linkColor(config, palette, [palette.panelBg]);
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
        className="flex items-baseline justify-center min-w-0 whitespace-nowrap text-[10px] leading-snug mt-1.5"
        style={{ color: palette.muted }}
        data-preview="disclaimer"
      >
        <span className="truncate min-w-0" data-preview="disclaimer-text">
          {disclaimer}
        </span>
        <span className="whitespace-pre flex-shrink-0" aria-hidden="true">
          {" · "}
        </span>
        <button
          type="button"
          ref={privacyLinkRef}
          onClick={onOpenPrivacy}
          aria-haspopup="dialog"
          aria-expanded={privacyOpen ? "true" : "false"}
          className="flex-shrink-0 underline underline-offset-2 -my-1 py-1 rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1"
          style={{ color: link, outlineColor: link }}
          data-preview="privacy-link"
        >
          {linkText}
        </button>
      </p>
    </div>
  );
}

function BubblePreview({
  config,
  logoPreview,
  defaults,
  defaultsError = false,
  greetingKey,
  palette,
  areaHeight = null,
}) {
  const [open, setOpen] = useState(true);
  const height = previewWindowHeight(areaHeight);
  // beim Öffnen steht der Verlauf oben (scrollToStart); eine Änderung der
  // Fensterhöhe verschiebt ihn nicht
  const messagesRef = useRef(null);
  useLayoutEffect(() => {
    if (open) scrollToStart(messagesRef.current);
  }, [open]);
  // Datenschutz-Fenster (AK-9); eine Änderung im Reiter Inhalt öffnet auch
  // den Chat, beim Schließen des Chats schließt es mit
  const privacyWindow = usePrivacyWindow(
    privacySignature(config, defaults, defaultsError),
    () => setOpen(true)
  );
  const setChatOpen = (next) => {
    setOpen(next);
    if (!next) privacyWindow.reset();
  };
  const accentColor = previewAccentColor(config);
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
      {/* Feste Höhe wie live (previewWindowHeight: 77 % der Vorschaufläche,
          mindestens 400 px); der Nachrichtenbereich scrollt innen mit
          sichtbarer Bildlaufleiste (vor rc11 war sie versteckt und schnitt
          die Beschriftung „Beispiel-Nutzernachricht“ ab, D12 ließ das
          Fenster deshalb wachsen). Geschlossen bleiben die Willkommensblasen
          unten in derselben Fläche, der Chat-Button springt nicht. */}
      <div
        className="flex flex-col justify-end"
        style={{ height: `${height}px` }}
        data-preview="chat-window"
      >
        {open ? (
          <div
            className="relative w-full flex-1 min-h-0 rounded-2xl flex flex-col overflow-hidden"
            style={{
              backgroundColor: palette.panelBg,
              boxShadow:
                "0 8px 40px rgba(0,0,0,0.12), 0 2px 8px rgba(0,0,0,0.08)",
            }}
            data-preview="chat-panel"
          >
            <PreviewHeader
              config={config}
              logoPreview={logoPreview}
              defaults={defaults}
              palette={palette}
              action={
                <button
                  type="button"
                  onClick={() => setChatOpen(false)}
                  aria-label="Chat schließen"
                  style={{ color: palette.muted }}
                >
                  <X size={18} weight="bold" />
                </button>
              }
            />
            <div
              ref={messagesRef}
              className="flex-1 min-h-0 overflow-y-auto preview-scrollbar px-4 py-4"
              style={scrollbarStyle(palette)}
              data-preview="chat-messages"
            >
              <PreviewWelcome
                config={config}
                defaults={defaults}
                defaultsError={defaultsError}
                greetingKey={greetingKey}
                palette={palette}
              />
            </div>
            <PreviewInput
              config={config}
              defaults={defaults}
              palette={palette}
              privacyLinkRef={privacyWindow.linkRef}
              privacyOpen={privacyWindow.isOpen}
              onOpenPrivacy={privacyWindow.show}
            />
            {privacyWindow.isOpen && (
              <PreviewPrivacyDialog
                config={config}
                defaults={defaults}
                palette={palette}
                focusOnOpen={privacyWindow.focus}
                onClose={privacyWindow.close}
              />
            )}
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
          onClick={() => setChatOpen(!open)}
          aria-label={open ? "Chat schließen" : "Chat öffnen"}
        >
          <ChatIcon
            config={config}
            size={24}
            color={previewUserTextColor(config)}
          />
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
  defaultsError = false,
  greetingKey,
  palette,
}) {
  // startet aufgeklappt wie die Vorschau des Chatfensters, Einklappen per
  // Button bleibt möglich (Spezifikation §12 Eintrag 12, Nutzer 21.10.2026:
  // „im aufgeklappten Modus als Standard!“)
  const [expanded, setExpanded] = useState(true);
  // aufgeklappt steht der Verlauf oben (scrollToStart)
  const messagesRef = useRef(null);
  useLayoutEffect(() => {
    if (expanded) scrollToStart(messagesRef.current);
  }, [expanded]);
  // Datenschutz-Fenster über dem aufgeklappten Panel (AK-9); eine Änderung
  // im Reiter Inhalt klappt auf, beim Einklappen schließt es mit
  const privacyWindow = usePrivacyWindow(
    privacySignature(config, defaults, defaultsError),
    () => setExpanded(true)
  );
  const setPanelExpanded = (next) => {
    setExpanded(next);
    if (!next) privacyWindow.reset();
  };
  const accentColor = previewAccentColor(config);
  // Eingeklappte Leiste: derselbe Platzhalter wie im Eingabefeld (eigener
  // Text bis 120 Zeichen oder Standard), ein früher gespeicherter
  // Leistentext geht vor (Nutzerentscheidung 23.10.2026, ersetzt D2)
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
            className="relative w-full rounded-[40px] flex flex-col overflow-hidden"
            style={{
              backgroundColor: palette.panelBg,
              // feste Höhe wie live (Serverstandard inlineHeight); der
              // Verlauf scrollt innen mit sichtbarer Bildlaufleiste
              height: `${INLINE_PANEL_HEIGHT_PX}px`,
              boxShadow: inlinePanelShadow(accentColor, palette.scheme),
            }}
            data-preview="inline-panel"
          >
            <div className="px-3 pt-2 flex-shrink-0">
              <PreviewHeader
                config={config}
                logoPreview={logoPreview}
                defaults={defaults}
                palette={palette}
                action={
                  <button
                    type="button"
                    onClick={() => setPanelExpanded(false)}
                    aria-label="Einklappen"
                    style={{ color: palette.muted }}
                  >
                    <CaretUp size={18} weight="bold" />
                  </button>
                }
              />
            </div>
            <div
              ref={messagesRef}
              className="flex-1 min-h-0 overflow-y-auto preview-scrollbar px-6 py-4"
              style={scrollbarStyle(palette)}
              data-preview="inline-messages"
            >
              <PreviewWelcome
                config={config}
                defaults={defaults}
                defaultsError={defaultsError}
                greetingKey={greetingKey}
                palette={palette}
              />
            </div>
            <div className="px-3 pb-2 flex-shrink-0">
              <PreviewInput
                config={config}
                defaults={defaults}
                palette={palette}
                privacyLinkRef={privacyWindow.linkRef}
                privacyOpen={privacyWindow.isOpen}
                onOpenPrivacy={privacyWindow.show}
              />
            </div>
            {privacyWindow.isOpen && (
              <PreviewPrivacyDialog
                config={config}
                defaults={defaults}
                palette={palette}
                focusOnOpen={privacyWindow.focus}
                onClose={privacyWindow.close}
                inline
              />
            )}
          </div>
        ) : (
          <div className="space-y-2.5" data-preview="inline-bar">
            <button
              type="button"
              onClick={() => setPanelExpanded(true)}
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
                  color: previewUserTextColor(config),
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
