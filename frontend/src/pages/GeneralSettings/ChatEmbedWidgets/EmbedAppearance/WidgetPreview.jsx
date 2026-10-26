// Live-Vorschau des Design Centers (Mock, angelehnt an das Widget): zeigt den
// festen Standard mit den Inhalten des Kunden. Begrüßung als erste Blase
// (darunter die Datenschutz-Blase nur mit dem Schalter „Zusätzlich beim
// Start als Blase zeigen“, AK-12; sonst seit 7.23 keine), Startvorschläge
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
// nehmen), jede andere Änderung schließt es wieder. Beide hängen oben; die
// Vorschau-Spalte scrollt nur, wenn das Fenster zu niedrig ist (B-06, R7).
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
  PRIVACY_FIELD_KEYS,
  PRIVACY_TITLE_STANDARD,
  privacyBlocks,
  privacyStartBubbleOn,
  privacyTitleFieldValue,
  privacyTitleStandard,
  previewAccentColor,
  previewGreeting,
  previewInlineBar,
  previewPlaceholder,
  previewUserTextColor,
  textItems,
  PILL_MAX_LEN,
  pillLabel,
  pillTextColor,
  previewCourseCount,
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

// Breite des Chatfensters in der Vorschau: fest 370 px (seit 03/2026, schmal
// und hoch wie das Widget), in einem schmalen Design Center nie schmaler als
// 360 px. Live ist das Fenster ab 768 px Bildschirmbreite mindestens 360 px
// breit (Widget src/App.jsx, Nutzer 24.10.2026, W12/F9 der Fixliste
// datenschutz-fusszeile rc2); vorher schrumpfte die Vorschau mit der Spalte,
// unter 360 px bei einem Design Center unter 816 px Breite (768 px: 336 px).
// min-width geht vor max-width; das Fenster ragt dann höchstens in den
// Innenabstand der Vorschaufläche, ohne waagerechten Bildlauf.
export const PREVIEW_WINDOW_WIDTH_PX = 370;
export const PREVIEW_WINDOW_MIN_WIDTH_PX = 360;

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

// Rückruf nach einer Änderung der Signatur, eine Regel für alle Blöcke der
// Vorschau (C2, Fixliste datenschutz-fusszeile rc1): nicht beim ersten
// Zeichnen und nicht, wenn die Standardtexte (GET /embed/defaults) erst
// nach dem Zeichnen ankommen (signature null = noch nicht geladen; nach
// einem Ladefehler gilt die Signatur, F42 Fixliste 7.22-rc16). Der Rückruf
// liegt in einem Ref: Er darf Props und State lesen, ohne den Effekt bei
// jedem Zeichnen auszulösen.
function useOnSignatureChange(signature, onChange) {
  const last = useRef(signature);
  const callback = useRef(onChange);
  useLayoutEffect(() => {
    callback.current = onChange;
  });
  useLayoutEffect(() => {
    if (last.current === signature) return;
    const loaded = last.current !== null;
    last.current = signature;
    if (loaded && signature !== null) callback.current();
  }, [signature]);
}

// Signatur erst, wenn die Standardtexte da sind oder nicht mehr kommen
// (Ladefehler, F42 Fixliste 7.22-rc16: sonst bliebe sie immer null und
// nichts käme ins Bild), vorher null (useOnSignatureChange). Eine Regel für
// alle Signaturen der Vorschau (C4, Fixliste datenschutz-fusszeile rc3).
function loadedSignature(defaults, defaultsError, signature) {
  return defaults || defaultsError ? signature : null;
}

// Block nach einer Änderung seines Inhalts ins Bild holen; sonst bleibt der
// Verlauf, wo er beim Öffnen stand (oben)
function useRevealOnChange(ref, signature) {
  useOnSignatureChange(signature, () => revealInPreview(ref.current));
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
    // Blasen von Begrüßung und Antworten wie im Widget:
    // weiß mit Schatten (theme.js assistant-bg, bubble-shadow; bis 7.22.1
    // zeigte die Vorschau sie grau, Nutzer 23.10.2026). Das
    // Datenschutz-Fenster hat feste Farben (PREVIEW_PRIVACY_DIALOG_COLORS).
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
 * @param {{config: Object, cleanedConfig?: Object, logoPreview: string|null,
 *   defaults: Object|null, defaultsError?: boolean, greetingKey: string}} props
 *   cleanedConfig: der bereinigte Stand (cleanConfig, wie er gespeichert
 *   würde); daran erkennt das Datenschutz-Fenster andere Änderungen (F15).
 *   Ohne ihn (Vorschau allein) gilt config.
 *   defaultsError: Laden der Standardtexte fehlgeschlagen (sie kommen nicht
 *   mehr; bearbeitete Blöcke werden trotzdem ins Bild geholt, F42)
 */
export default function WidgetPreview({
  config,
  cleanedConfig = config,
  logoPreview,
  defaults,
  defaultsError = false,
  greetingKey,
  courseInventory = null,
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
              cleanedConfig={cleanedConfig}
              logoPreview={logoPreview}
              defaults={defaults}
              defaultsError={defaultsError}
              greetingKey={greetingKey}
              palette={palette}
              courseInventory={courseInventory}
            />
          ) : (
            <BubblePreview
              config={config}
              cleanedConfig={cleanedConfig}
              logoPreview={logoPreview}
              defaults={defaults}
              defaultsError={defaultsError}
              greetingKey={greetingKey}
              palette={palette}
              areaHeight={areaHeight}
              courseInventory={courseInventory}
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
// KIE-576 Paket 3: mit Schalter „Kursanzahl im Untertitel“ an steht statt des
// Untertitels „aktuell 812 Kurse“ wie im Widget (Zahl fett, ohne Info-Button
// und ohne Karte, Fixliste r4 Nr. 3), mit der echten Zahl des Kursbestands,
// sonst der Beispielzahl mit dem Zusatz „Beispiel“ (PreviewCourseCount).
function PreviewHeader({
  config,
  logoPreview,
  defaults,
  palette,
  action,
  courseInventory = null,
}) {
  const name =
    textValue(config.name).trim() || textValue(defaults?.name) || "KI-Berater";
  const courseCount = previewCourseCount(config, courseInventory);
  // Untertitel wie das Widget (R5): ohne gespeicherten Wert der Standard,
  // "" = kein Untertitel
  const subtitle = courseCount
    ? ""
    : subtitleFieldValue(config, defaults).trim();
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
        {courseCount && (
          <PreviewCourseCount courseCount={courseCount} palette={palette} />
        )}
      </span>
      <span className="flex-shrink-0 flex items-center">{action}</span>
    </div>
  );
}

// Zusatz zur Beispielzahl ohne Kursliste vom Kursprogramm (K-D6)
export const COURSE_COUNT_SAMPLE_LABEL = "Beispiel";

/**
 * Kursanzahl im Kopf der Vorschau wie im Widget (KIE-576, Fixliste r4 Nr. 3;
 * Widget src/components/ChatWindow/Header/CourseCount.jsx): „aktuell <Zahl
 * fett> <Bezeichnung>“ in einer Zeile, ohne Info-Button und ohne Karte. Mit
 * der Beispielzahl (sample) dahinter der Zusatz „Beispiel“.
 * @param {{courseCount: {lead: string, number: string, word: string, sample: boolean}, palette: Object}} props
 */
function PreviewCourseCount({ courseCount, palette }) {
  const { lead, number, word, sample } = courseCount;
  return (
    <span
      className="flex items-center gap-0.5 min-w-0 text-[11px] leading-snug whitespace-nowrap"
      style={{ color: palette.muted }}
      data-preview="header-course-count"
      data-sample={sample ? "true" : "false"}
    >
      <span className="min-w-0 overflow-hidden text-ellipsis">
        {lead}{" "}
        <span className="font-semibold" style={{ color: palette.text }}>
          {number}
        </span>{" "}
        {word}
      </span>
      {sample && (
        <span
          className="flex-shrink-0 ml-1 px-1.5 rounded-full text-[10px] font-semibold"
          style={{ border: `1px solid ${palette.line}` }}
          data-preview="header-course-count-sample"
        >
          {COURSE_COUNT_SAMPLE_LABEL}
        </span>
      )}
    </span>
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

// Startvorschläge der Vorschau (höchstens sechs): ohne gespeicherte Liste
// die Standard-Startvorschläge des Servers (S1, wie live im Widget; R5),
// seit E42 leer, also keine Pillen. Eine Stelle für den Verlauf, die
// eingeklappte Leiste und die Signatur der Startansicht (A1).
function previewPills(config, defaults) {
  return textItems(listItems(config, "defaultMessages", defaults)).slice(0, 6);
}

// Blasen von Begrüßung und Datenschutz-Hinweis: Schriftgröße, Zeilenhöhe,
// Rundung, Innenabstand und Breite gleich (wie im Widget seit 7.22.2,
// Nutzer 23.10.2026; D4 zu AK-12)
const WELCOME_BUBBLE_CLASS = `text-[12.5px] leading-relaxed rounded-[18px] rounded-tl-[4px] px-3.5 py-2.5 max-w-[88%] ${BREAK}`;

// Startzustand des Chats: Begrüßungsblase, Datenschutz-Blase (nur mit dem
// Schalter „Zusätzlich beim Start als Blase zeigen“, AK-12), Pillen,
// Beispiel-Nutzernachricht. Ohne den Schalter keine Datenschutz-Blase (seit
// 7.23, AK-1): Der Hinweis steht im Fenster hinter dem Link unter der
// Eingabe; der Link bleibt auch mit Blase (D1).
export function PreviewWelcome({
  config,
  defaults,
  defaultsError = false,
  greetingKey,
  palette,
}) {
  const greeting = previewGreeting(config, greetingKey, defaults);
  // Datenschutz-Blase wie in 7.22.2 (D4): Überschrift (gespeichert, sonst
  // und bei leerem Feld der Standard), Text als Punkte und Absätze, Link zur
  // Datenschutzerklärung nur mit gültiger Adresse, ohne den Punkt „Hinweis
  // zur KI“ (der steht im Fenster); dieselben Werte wie das Fenster
  // (previewPrivacy), alles als Text
  const showPrivacy = privacyStartBubbleOn(config);
  const privacy = previewPrivacy(config, defaults);
  const pills = previewPills(config, defaults);
  // F10 (Fixliste 7.22-rc13): Wer im Reiter Inhalt Begrüßung, Datenschutz-
  // Blase oder Startvorschläge ändert, sieht den Block in der Vorschau, auch
  // wenn der Verlauf woanders steht (Felder des Datenschutz-Hinweises öffnen
  // zusätzlich das Fenster, usePrivacyWindow)
  const greetingRef = useRef(null);
  const privacyRef = useRef(null);
  const pillsRef = useRef(null);
  const loaded = (signature) =>
    loadedSignature(defaults, defaultsError, signature);
  useRevealOnChange(greetingRef, loaded(greeting));
  useRevealOnChange(
    privacyRef,
    loaded(
      showPrivacy
        ? JSON.stringify([privacy.title, privacy.blocks, privacy.url])
        : ""
    )
  );
  // getrimmt wie gespeichert (cleanConfig): Speichern ist keine Bearbeitung,
  // die Vorschau springt danach nicht zu den Pillen (F43 Fixliste 7.22-rc16)
  useRevealOnChange(
    pillsRef,
    loaded(JSON.stringify(pills.map((pill) => pill.trim())))
  );
  // Begrüßung und Datenschutz-Blase wie im Widget seit 7.22.2: Fläche,
  // Schatten, Schrift (Nutzer 23.10.2026); dieselbe Fläche hat das
  // Datenschutz-Fenster (PREVIEW_PRIVACY_DIALOG_COLORS). Der Link in der
  // Blase hat die Farbe aller Datenschutz-Links (previewPrivacyLinkColor, L1)
  const bubble = {
    backgroundColor: palette.bubbleBg,
    boxShadow: palette.bubbleShadow,
    color: palette.text,
  };
  return (
    <div className="w-full space-y-2.5" data-preview="welcome">
      <div
        ref={greetingRef}
        className={WELCOME_BUBBLE_CLASS}
        style={bubble}
        data-preview="greeting-bubble"
      >
        {greeting}
      </div>
      {showPrivacy && (
        <div
          ref={privacyRef}
          className={`${WELCOME_BUBBLE_CLASS} space-y-1`}
          style={bubble}
          data-preview="privacy-bubble"
        >
          <p className="font-bold">{privacy.title}</p>
          <PrivacyBlockList blocks={privacy.blocks} />
          {privacy.url && (
            <p>
              <PrivacyStatementLink
                url={privacy.url}
                color={previewPrivacyLinkColor(config, palette)}
              />
            </p>
          )}
        </div>
      )}
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
  privacyTitle: PRIVACY_TITLE_STANDARD,
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
  return {
    ...privacyFixedTexts(defaults),
    title:
      privacyTitleFieldValue(config, defaults).trim() ||
      privacyTitleStandard(defaults),
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

// Farbe aller Datenschutz-Links der Vorschau, eine Quelle (L1, Hinweis O1
// zu AK-12): der Link „Datenschutz“ in der Fußzeile, der Link zur
// Datenschutzerklärung und alle Fokusrahmen im Datenschutz-Fenster und der
// Link zur Datenschutzerklärung in der Datenschutz-Blase beim Start. Eine
// Farbe wie im Widget (theme.js privacyLinkColor, R1-D1 Fixliste rc1, L1):
// hell die Akzentfarbe (der Server liefert sie als linkColor), dunkel fest
// DARK.link, je mit mindestens 4,5:1 zur Fläche der Fußzeile, des Fensters
// und der Blase (Fläche der Begrüßungsblase, palette.bubbleBg; abgedunkelt
// bzw. aufgehellt, wenn nötig; Fokusrahmen brauchen 3:1). Bis rc5 nahm die
// Blase die rohe Linkfarbe (hell #FFA102 auf Weiß rund 2,0:1). Gegenprobe
// gegen das Widget in den Tests designCenterPrivacyLink und
// designCenterPrivacyStartBubble (KUFER_EMBED_DIR).
const DARK_LINK_COLOR = "#5CC8CB";
export function previewPrivacyLinkColor(config, palette = paletteOf(config)) {
  const link = rawLinkColor(config, palette);
  return pillTextColor(
    link,
    [
      palette.panelBg,
      PREVIEW_PRIVACY_DIALOG_COLORS[palette.scheme].bg,
      palette.bubbleBg,
    ],
    palette.text
  );
}

// Linkfarbe des Widgets ohne Kontrastausgleich (theme.js --allmi-link): hell
// die Akzentfarbe, dunkel fest DARK.link. Nur Grundlage für
// previewPrivacyLinkColor; kein Datenschutz-Link nutzt sie direkt (L1).
function rawLinkColor(config, palette) {
  return palette.scheme === "dark"
    ? DARK_LINK_COLOR
    : previewAccentColor(config);
}

// Farben des Datenschutz-Fensters, dieselben Werte wie im Widget (theme.js
// PRIVACY_DIALOG_COLORS, R1-D1 Fixliste rc1): fest je Farbschema, keine
// Einstellung wirkt darauf. Fläche und Schrift wie die Standard-Antwortblase
// des Widgets, Trennlinien wie dort die Linie unter dem Kopf (F13, Fixliste
// rc2; bis rc2 aus der Palette der Vorschau, hell Schrift #1c1917 und Linien
// #e7e5e4, dunkel #f4f4f5 und rgba(255,255,255,.12)). Das Schließen-Symbol
// hat die Schrift des Fensters (im Widget color: inherit). Gegenprobe gegen
// das Widget im Test designCenterPrivacyLink.
export const PREVIEW_PRIVACY_DIALOG_COLORS = Object.freeze({
  light: Object.freeze({ text: "#222628", bg: "#FFFFFF", line: "#E9E9E9" }),
  dark: Object.freeze({ text: "#F4F2EF", bg: "#2A2A2F", line: "#787B82" }),
});

// Zustand des Datenschutz-Fensters der Vorschau. Es ist nie modal (R3-D1,
// Fixliste rc3); focus heißt nur „Fokus beim Öffnen auf die Überschrift“.
const PRIVACY_CLOSED = Object.freeze({ isOpen: false, focus: false });
// beim Bearbeiten geöffnet: der Fokus bleibt im Feld (E3)
const PRIVACY_SHOWN = Object.freeze({ isOpen: true, focus: false });
// per Link geöffnet: Fokus auf der Überschrift
const PRIVACY_CLICKED = Object.freeze({ isOpen: true, focus: true });

/**
 * Datenschutz-Fenster der Vorschau offen oder zu (AK-9), nie modal (R3-D1,
 * Fixliste rc3: kein aria-modal, keine Tab-Falle; bis rc3 nach einem Klick
 * modal, beim Bearbeiten nicht, und jede Runde fand einen neuen Wechsel
 * zwischen beiden). Klick auf den Link öffnet es und setzt den Fokus auf
 * die Überschrift. Schließen (Button, Symbol, Esc) gibt den Fokus an den
 * Link zurück, wenn er im Fenster lag (close(true); erst wenn das Fenster
 * zu ist: solange es offen ist, sind Link und Kopf inert). Ändert sich der
 * Inhalt (Überschrift, Text oder Link im Reiter Inhalt), öffnet es sich
 * ohne Fokuswechsel, damit die Änderung zu sehen ist (E3, wie F10 bei der
 * Begrüßung); onReveal öffnet dazu den Chat. Ändert sich irgendetwas anderes
 * (Begrüßung, Startvorschläge, Beispielantwort, Optik), schließt das
 * Fenster, damit die Änderung nicht dahinter verborgen bleibt (F-4, F10);
 * Speichern ändert nichts davon (F15). Den Chat öffnet zusätzlich eine
 * Änderung der Startansicht (useOpenOnStartViewChange, A1).
 * Rückweg zu modal: aria-modal und Tab-Falle an focusOnOpen hängen.
 * @param {{signature: string|null, others: string|null,
 *   onReveal?: () => void}} args
 *   signature: Inhalt des Fensters (privacySignature), others: alle übrigen
 *   Einstellungen, bereinigt (othersSignature); null = Standardtexte noch
 *   nicht geladen
 */
function usePrivacyWindow({ signature, others, onReveal }) {
  const [state, setState] = useState(PRIVACY_CLOSED);
  const linkRef = useRef(null);
  const restoreFocus = useRef(false);
  // zuerst die übrigen Einstellungen: ändern sich beide, gilt die Änderung
  // am Datenschutz (das Fenster zeigt sie)
  useOnSignatureChange(others, () => {
    restoreFocus.current = false;
    setState(PRIVACY_CLOSED);
  });
  useOnSignatureChange(signature, () => {
    setState(PRIVACY_SHOWN);
    onReveal?.();
  });
  useLayoutEffect(() => {
    if (state.isOpen || !restoreFocus.current) return;
    restoreFocus.current = false;
    linkRef.current?.focus();
  }, [state.isOpen]);
  return {
    ...state,
    linkRef,
    show: () => setState(PRIVACY_CLICKED),
    // focusInside: der Fokus lag beim Schließen im Fenster
    close: (focusInside) => {
      restoreFocus.current = !!focusInside;
      setState(PRIVACY_CLOSED);
    },
    // beim Schließen bzw. Einklappen des Chats, ohne Fokuswechsel
    reset: () => {
      restoreFocus.current = false;
      setState(PRIVACY_CLOSED);
    },
  };
}

// Signatur des Fensterinhalts für usePrivacyWindow
function privacySignature(config, defaults, defaultsError) {
  const { title, blocks, url } = previewPrivacy(config, defaults);
  return loadedSignature(
    defaults,
    defaultsError,
    JSON.stringify([title, blocks, url])
  );
}

// Signatur aller übrigen Einstellungen (alles außer Überschrift, Text und
// Link des Datenschutz-Hinweises), unabhängig von der Reihenfolge der
// Schlüssel, aus dem bereinigten Stand (cleanConfig, F15 Fixliste rc3,
// NF-3): Speichern bereinigt auch andere Felder (eine geleerte Begrüßung
// entfällt, Leerzeichen am Ende), die Vorschau ändert sich dadurch nicht,
// das Fenster bleibt offen (Speichern ist keine Bearbeitung, wie F43). Bis
// rc3 aus den rohen Werten. Der bereinigte Stand vergleicht mit den
// Standardtexten, deshalb erst ab geladenen Standardtexten (C4).
function othersSignature(cleanedConfig, defaults, defaultsError) {
  return loadedSignature(
    defaults,
    defaultsError,
    JSON.stringify(
      Object.keys(cleanedConfig)
        .filter(
          (key) =>
            !PRIVACY_FIELD_KEYS.includes(key) &&
            cleanedConfig[key] !== undefined
        )
        .sort()
        .map((key) => [key, cleanedConfig[key]])
    )
  );
}

// Signatur der Startansicht (Review AF-1, Fixliste AK-12 A1): Begrüßung,
// Datenschutz-Blase (Schalter „Zusätzlich beim Start als Blase zeigen“) und,
// mit pills, die Startvorschläge. Diese Blöcke zeichnet die Vorschau nur im
// offenen Chat (PreviewWelcome); ändert sich einer bei geschlossenem bzw.
// eingeklapptem Chat, öffnet useOpenOnStartViewChange ihn, damit die
// Änderung zu sehen ist (wie onReveal bei Überschrift, Text und Link, E3).
// Bis rc5 öffnete nur der Inhalt des Datenschutz-Fensters den Chat, alles
// andere schloss nur das Fenster (others), und der Schalter blieb bei
// geschlossener Vorschau ohne sichtbare Wirkung. Aus dem bereinigten Stand
// wie othersSignature: Speichern öffnet nichts (F15, F43).
function startViewSignature(
  cleanedConfig,
  { greetingKey, defaults, defaultsError, pills }
) {
  const parts = [
    previewGreeting(cleanedConfig, greetingKey, defaults),
    privacyStartBubbleOn(cleanedConfig),
  ];
  if (pills)
    parts.push(previewPills(cleanedConfig, defaults).map((p) => p.trim()));
  return loadedSignature(defaults, defaultsError, JSON.stringify(parts));
}

// Chat der Vorschau öffnen, wenn sich die Startansicht ändert (A1); offen
// ändert sich nichts, PreviewWelcome holt den Block dann ins Bild (F10).
// Das Datenschutz-Fenster schließt dabei wie bei jeder anderen Einstellung
// (others in usePrivacyWindow, F-4, R3-D1).
function useOpenOnStartViewChange(signature, openChat) {
  useOnSignatureChange(signature, openChat);
}

// Hülle um Kopf, Verlauf und Eingabe, je Darstellung eine (C6, Fixliste
// rc3): Unter dem offenen Datenschutz-Fenster ist alles darin weder per Tab
// noch per Maus oder Screenreader erreichbar (F-3). display: contents, die
// Teile bleiben im Flex-Layout des Panels; inert wirkt trotzdem auf alles
// darin. React 18 kennt inert nicht als Schalter: der leere Text setzt das
// Attribut (ab React 19 inert={true}).
function PrivacyCovered({ covered, children }) {
  return (
    <div className="contents" {...(covered ? { inert: "" } : {})}>
      {children}
    </div>
  );
}

// Abstände des Datenschutz-Fensters: im Chatfenster wie die Blasen, im Panel
// „In der Seite“ weiter innen wegen der Rundung von 40 px. Dort ist die
// Textspalte höchstens etwa 70 Zeichen breit und linksbündig (R1-D2,
// Fixliste rc1: das breite Panel ergab sonst Zeilen bis 150 Zeichen);
// Kopfzeile, Button-Zeile und Bildlauf bleiben über die ganze Breite.
// Rückweg: column weglassen.
// Das Schließen-Symbol steht in beiden Darstellungen gleich hoch, mittig
// zur ersten Zeile der Überschrift wie im Widget (F13, Fixliste rc2; bis rc2
// bei „In der Seite“ top-3.5, 6 px tiefer): Kopf pt-3.5 (14 px) plus halbe
// Zeile der Überschrift (15 px × 1,375 / 2 = 10,3 px) = 24,3 px, Symbol
// h-8 (32 px) mit top-2 (8 px) = 24 px. Nur der Abstand nach rechts folgt
// der Rundung des Panels.
const PRIVACY_CLOSE_TOP = "top-2";
const PRIVACY_TEXT_MAX_WIDTH = "70ch";
const PRIVACY_DIALOG_INSETS = {
  bubble: { x: "px-4", close: "right-2", title: "pr-11" },
  inline: {
    x: "px-8",
    close: "right-5",
    title: "pr-14",
    column: { maxWidth: PRIVACY_TEXT_MAX_WIDTH },
  },
};

// Datenschutz-Text als Punkte und Absätze (privacyBlocks), nur als Text, nie
// als HTML; im Fenster und in der Datenschutz-Blase (AK-12) gleich
function PrivacyBlockList({ blocks }) {
  if (blocks.length === 0) return null;
  return (
    <div className="space-y-1">
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
    </div>
  );
}

// Link zur Datenschutzerklärung in Fenster und Blase, in der Vorschau nicht
// bedienbar (ein Pfad wie /datenschutz gehört zur Seite des Kunden); die
// Adresse steht im Tooltip. Nur mit gültiger Adresse (previewPrivacy).
function PrivacyStatementLink({ url, color }) {
  return (
    <span
      className="underline underline-offset-2 font-medium"
      style={{ color }}
      title={url}
      data-preview="privacy-statement-link"
    >
      {PRIVACY_STATEMENT_LINK}
    </span>
  );
}

/**
 * Datenschutz-Fenster über dem ganzen Chat (Panel des Chatfensters bzw. das
 * aufgeklappte Panel „In der Seite“), wie im Widget (PrivacyNotice):
 * Überschrift (gespeichert, sonst und bei leerem Feld der Standard), Text,
 * Punkt „Hinweis zur KI“, Link zur Datenschutzerklärung (falls gesetzt),
 * Button „Schließen“, das Schließen-Symbol oben rechts (im Dokument zuletzt).
 * Fläche, Schrift und Trennlinien fest je Farbschema mit den Werten des
 * Widgets (PREVIEW_PRIVACY_DIALOG_COLORS; R1-D1 im Widget: keine Variable
 * der Seite wirkt darauf), Rundung des Panels; Link zur Datenschutzerklärung und alle Fokusrahmen in der
 * Linkfarbe (previewPrivacyLinkColor). Kopf, Verlauf und Eingabe darunter
 * sind inert (PrivacyCovered).
 * role="dialog", aria-labelledby auf die Überschrift, nie aria-modal und
 * keine Tab-Falle (R3-D1, Fixliste rc3): Das Design Center daneben bleibt
 * für Tastatur und Screenreader erreichbar, Tab läuft nach dem
 * Schließen-Symbol normal weiter. Im Widget bleibt das Fenster modal (AK-5).
 * Nach einem Klick auf den Link (focusOnOpen) liegt der Fokus auf der
 * Überschrift, Tab-Reihenfolge Text, Schließen, Schließen-Symbol; öffnet es
 * sich beim Bearbeiten eines Felds, bleibt der Fokus im Feld (E3). Esc
 * schließt. onClose(focusInside): ob der Fokus beim Schließen im Fenster
 * lag. Der Link zur Datenschutzerklärung ist in der Vorschau nicht
 * bedienbar (ein Pfad wie /datenschutz gehört zur Seite des Kunden, nicht
 * zum Design Center).
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
  const privacy = previewPrivacy(config, defaults);
  const inset = PRIVACY_DIALOG_INSETS[inline ? "inline" : "bubble"];
  const colors = PREVIEW_PRIVACY_DIALOG_COLORS[palette.scheme];
  const line = `1px solid ${colors.line}`;
  const link = previewPrivacyLinkColor(config, palette);
  // beim Öffnen per Link und wenn der Link ein beim Bearbeiten geöffnetes
  // Fenster bedient (F-3)
  useLayoutEffect(() => {
    if (focusOnOpen) headingRef.current?.focus();
  }, [focusOnOpen]);
  const close = () => {
    const dialog = dialogRef.current;
    onClose(!!dialog?.contains(dialog.ownerDocument.activeElement));
  };
  // nur Esc; Tab bewegt der Browser (keine Tab-Falle, R3-D1)
  const onKeyDown = (e) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    close();
  };
  const focusRing =
    "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2";
  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-labelledby={titleId}
      onKeyDown={onKeyDown}
      className="absolute inset-0 z-20 flex flex-col"
      style={{ backgroundColor: colors.bg, color: colors.text }}
      data-preview="privacy-dialog"
    >
      <div
        className={`${inset.x} ${inset.title} pt-3.5 pb-2.5 flex-shrink-0`}
        style={{ borderBottom: line }}
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
        tabIndex={0}
        className={`flex-1 min-h-0 overflow-y-auto preview-scrollbar ${inset.x} py-3 text-[12.5px] leading-relaxed focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 ${BREAK}`}
        style={{ ...scrollbarStyle(palette), outlineColor: link }}
        data-preview="privacy-dialog-body"
      >
        <div
          className="space-y-3"
          style={inset.column}
          data-preview="privacy-dialog-text"
        >
          <PrivacyBlockList blocks={privacy.blocks} />
          <div className="space-y-0.5" data-preview="privacy-ai">
            <p className="font-semibold">{privacy.aiTitle}</p>
            <p>{privacy.aiText}</p>
          </div>
          {privacy.url && (
            <p>
              <PrivacyStatementLink url={privacy.url} color={link} />
            </p>
          )}
        </div>
      </div>
      <div
        className={`flex justify-end ${inset.x} pt-2.5 pb-3.5 flex-shrink-0`}
        style={{ borderTop: line }}
      >
        <button
          type="button"
          onClick={close}
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
        onClick={close}
        aria-label={PRIVACY_CLOSE_LABEL}
        title={PRIVACY_CLOSE_LABEL}
        className={`absolute ${PRIVACY_CLOSE_TOP} ${inset.close} w-8 h-8 rounded-lg flex items-center justify-center ${focusRing}`}
        style={{ color: "inherit", outlineColor: link }}
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
  const link = previewPrivacyLinkColor(config, palette);
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
  cleanedConfig = config,
  logoPreview,
  defaults,
  defaultsError = false,
  greetingKey,
  palette,
  areaHeight = null,
  courseInventory = null,
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
  const privacyWindow = usePrivacyWindow({
    signature: privacySignature(config, defaults, defaultsError),
    others: othersSignature(cleanedConfig, defaults, defaultsError),
    onReveal: () => setOpen(true),
  });
  // Startvorschläge stehen nur im offenen Chat (geschlossen zeigt die
  // Vorschau die Willkommensblasen), sie zählen zur Startansicht
  useOpenOnStartViewChange(
    startViewSignature(cleanedConfig, {
      greetingKey,
      defaults,
      defaultsError,
      pills: true,
    }),
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
    <div
      className="max-w-full flex flex-col items-stretch"
      style={{
        width: `${PREVIEW_WINDOW_WIDTH_PX}px`,
        minWidth: `${PREVIEW_WINDOW_MIN_WIDTH_PX}px`,
      }}
      data-preview="chat-column"
    >
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
            <PrivacyCovered covered={privacyWindow.isOpen}>
              <PreviewHeader
                config={config}
                logoPreview={logoPreview}
                defaults={defaults}
                palette={palette}
                courseInventory={courseInventory}
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
            </PrivacyCovered>
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
  cleanedConfig = config,
  logoPreview,
  defaults,
  defaultsError = false,
  greetingKey,
  palette,
  courseInventory = null,
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
  const privacyWindow = usePrivacyWindow({
    signature: privacySignature(config, defaults, defaultsError),
    others: othersSignature(cleanedConfig, defaults, defaultsError),
    onReveal: () => setExpanded(true),
  });
  // Startvorschläge stehen eingeklappt unter der Leiste, ihre Änderung ist
  // dort zu sehen; sie klappen nicht auf (E1, Fixliste AK-12 A1)
  useOpenOnStartViewChange(
    startViewSignature(cleanedConfig, {
      greetingKey,
      defaults,
      defaultsError,
      pills: false,
    }),
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
  const chips = previewPills(config, defaults);
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
            <PrivacyCovered covered={privacyWindow.isOpen}>
              <div className="px-3 pt-2 flex-shrink-0">
                <PreviewHeader
                  config={config}
                  logoPreview={logoPreview}
                  defaults={defaults}
                  palette={palette}
                  courseInventory={courseInventory}
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
            </PrivacyCovered>
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
