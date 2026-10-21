// Konversationen-Ansicht: kompakte Liste nach Tagen, Seitenpanel, Suche.
// Reine Hilfsfunktionen ohne React – Tagesgruppen und Uhrzeiten in Berliner
// Zeit (unabhängig von der Zeitzone des Browsers), Suchbegriff, Hervorhebung
// der Treffer und die Kennzahlen einer geöffneten Konversation.
//
// Datumsangaben stehen immer in deutscher Schreibweise, auch bei englischer
// Oberfläche – übersetzt werden nur die Wörter darum („Heute", „begonnen
// am"). Kalendertage kommen aus formatDateForInput (Berliner Tag eines
// Zeitpunkts), Tagesnamen aus formatterOf (analyticsTimeline).

import { formatDateForInput } from "./billingDate.js";
import { addDays, formatDate, formatterOf } from "./analyticsTimeline.js";
import { formatDateTimeDE } from "./dateTimeDE.js";

/** Zeitzone aller Tage und Uhrzeiten der Ansicht (auch in Tooltips). */
export const BERLIN = "Europe/Berlin";
const GERMAN = "de-DE";
/**
 * Geräteklassen der Ansicht (Fixliste 7.22-rc13, E15, einheitlich mit Widget
 * und Design Center): Smartphone unter 768 px (Tailwind md), Tablet 768 bis
 * 1.279 px, Desktop ab 1.280 px (Tailwind xl). Nur auf dem Desktop steht
 * der Verlauf als Arbeitsbereich neben der Liste (KIE-575); auf Tablet und
 * Smartphone ist er ein Vollbild wie bisher unter lg. Die Klassen der
 * Ansicht tragen dafür das Präfix xl: (wörtlich, siehe WORKSPACE). Rückweg:
 * diese Konstante und die xl:-Klassen der Ansicht.
 */
export const WIDE_QUERY = "(min-width: 1280px)";

/**
 * Desktop (Verlauf neben der Liste, ab 1.280 px)? false ohne Fenster oder
 * ohne matchMedia.
 * @returns {boolean}
 */
export function isWide() {
  return (
    typeof window !== "undefined" && !!window.matchMedia?.(WIDE_QUERY)?.matches
  );
}

/**
 * Ist der Fokus verloren gegangen – steht er auf <body> oder auf einem
 * Element, das nicht mehr im Dokument ist (etwa weil das Panel oder ein
 * Menüeintrag verschwunden ist)? Dann darf die Ansicht ihn neu setzen, ohne
 * jemandem das Feld wegzuziehen, in dem er gerade tippt (Fixliste 7, F24:
 * eine Stelle für Liste und Panel).
 * @param {Document|undefined} [doc]
 * @returns {boolean}
 */
export function focusLost(
  doc = typeof document === "undefined" ? undefined : document
) {
  if (!doc) return false;
  const active = doc.activeElement;
  return !active || active === doc.body || !doc.body.contains(active);
}

/**
 * Gedämpfte Schrift der Ansicht: dunkel wie --theme-text-secondary, hell
 * #5f6368 (Fixliste 2, B2) – eine Stelle statt einer Konstante je Datei.
 */
export const MUTED = "text-[color:var(--theme-analytics-text-muted)]";

/**
 * Fokusring der Seite (wie Listenzeilen und Diagramm-Schalter): 2 px in der
 * Textfarbe, nach innen versetzt, nur bei Tastaturbedienung – statt des
 * Browser-Rings (Nachtrag N3).
 */
export const FOCUS_RING =
  "focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[color:var(--theme-text-primary)]";

/**
 * Hauchzarter Hintergrund einer bewerteten Antwort (Nachtrag N2 b): in den
 * Tönen der Bewertungsmarken (negativ orange, positiv sky), dunkel 8 %
 * Deckkraft, hell die 50er-Stufe. Text darauf hält mindestens 4,5:1
 * (conversationView.test.mjs rechnet nach).
 */
export const RATING_TINT = {
  negative: "bg-orange-500/[0.08] light:bg-orange-50",
  positive: "bg-sky-500/[0.08] light:bg-sky-50",
};

/**
 * Kurze Hervorhebung nach dem Sprung zu einer bewerteten Antwort (N2 a):
 * ein Umriss im Ton der Bewertung, mindestens 3:1 zum Grund.
 */
export const RATING_FLASH = {
  negative: "outline outline-2 outline-orange-400 light:outline-orange-600",
  positive: "outline outline-2 outline-sky-400 light:outline-sky-600",
};

/**
 * Kasten der negativen Bewertung (Grund und Kommentar) unter der Antwort.
 * Er liegt auf der Tönung der Antwort (RATING_TINT.negative) und hebt sich
 * davon ab: hell eine Stufe kräftiger (100 auf 50), sonst verschwände seine
 * Füllung in der gleichfarbigen Tönung (Review 7.21.1).
 */
export const RATING_BOX =
  "border border-orange-400/30 bg-orange-500/10 light:border-orange-200 light:bg-orange-100";

/**
 * Ton einer Bewertung: "positive" (👍), "negative" (👎) oder null.
 * @param {{feedbackScore?: boolean|null}} message
 * @returns {"positive"|"negative"|null}
 */
export function ratingOf(message) {
  if (message?.feedbackScore === true) return "positive";
  if (message?.feedbackScore === false) return "negative";
  return null;
}

/**
 * Ziele der Sprung-Schaltflächen im Kopf (Nachtrag N2 a): die ids der so
 * bewerteten Antworten, die der Kopf zählt. Steht die Konversation in der
 * Liste, zählt er nur Nachrichten im Zeitraum (period) – der Verlauf zeigt
 * aber die ganze Konversation; ohne Zeitraum alle (Review 7.21.1).
 * @param {Array<{id: number, feedbackScore?: boolean|null, createdAt: string}>} messages
 * @param {"positive"|"negative"} kind
 * @param {{fromDay?: string|null, toDay?: string|null}} [period]
 * @returns {number[]}
 */
export function ratingJumpIds(messages, kind, period = {}) {
  return (messages ?? [])
    .filter((message) => ratingOf(message) === kind)
    .filter((message) => inPeriod(message, period))
    .map((message) => message.id);
}

// Abstand zum schwebenden Benutzermenü oben rechts („KI“, bis 72 px unter
// dem oberen Fensterrand) – an einer Stelle (Fixliste 3, S4). Der Bereich der
// Einstellungsseiten beginnt ab md 16 px unter dem Fensterrand und endet
// 16 px über dem unteren.
export const AVATAR_CLEARANCE = {
  // Sprungziel „Liste“ (Säule, Verweis, Link). Tablet und Smartphone:
  // Überschrift und Werkzeugleiste landen unter dem Benutzermenü, der
  // Export-Knopf bleibt frei (Fixliste 3, V2; 80 px). Desktop: genau die
  // Ruhelage des Arbeitsbereichs (Review 7.22-rc12, K04) – Oberkante
  // WORKSPACE_REST_TOP unter dem Fensterrand, also WORKSPACE_REST_TOP −
  // FRAME_TOP = 8 px unter dem Rand des scrollenden Rahmens (xl:scroll-mt-2).
  // Mit 80 px stand der Bereich 56 px tiefer, und seine unteren 24 px
  // (Fußzeile des Verlaufs, „Weitere laden“) lagen unter dem Fensterrand.
  jumpTarget: "scroll-mt-20 xl:scroll-mt-2",
  // rechter Rand der Kopfzeile ab md: Widget-Auswahl und Zeitraum enden links
  // vom Benutzermenü
  headerEnd: "md:pr-12",
  // rechter Rand der Werkzeugleiste der Liste (ab sm, wo sie eine eigene
  // Leiste ist): Der Export-Knopf endet links vom Benutzermenü – auch wenn
  // der Listenkopf beim Scrollen oben am Fensterrand steht (Fixliste 4, V2).
  // Das Menü (35 px, 40 px vom rechten Fensterrand) deckt sonst die
  // rechten 35 px des Inhalts ab; 44 px lassen 9 px Luft und halten Filter
  // und Export auch bei 768 px Fensterbreite in einer Zeile (V5).
  toolbarEnd: "sm:pr-11",
  // rechter Rand der Schaltflächenzeile (‹ › ⋯ ✕) im Kopf des Verlaufs auf
  // dem Desktop (Fixliste 7.22-rc11, K12): Liegt der Arbeitsbereich oben an,
  // steht diese Zeile auf der Höhe des Menüs (Zeile 41 bis 77 px, Menü 36
  // bis 71 px), und der rechte Rand des Verlaufs fällt mit dem des Menüs
  // zusammen (beide 40 px vom Fensterrand). Mit dem Innenabstand des Kopfs
  // (xl:px-5, 20 px) und dem Rahmen (1 px) enden ✕ und ⋯ so 49 px vom Rand
  // des Verlaufs: 14 px Luft zum 35 px breiten Menü. Nur die erste Zeile
  // des Kopfs: Frage und Angaben darunter liegen unter dem Menü und nutzen
  // die Breite weiter. Als Vollbild (Tablet, Smartphone) liegt das Panel
  // über dem Menü (z-50 über z-40).
  panelHeadEnd: "xl:pr-7",
  // ✕ des Platzhalters „Keine Konversation gewählt“ (nur auf dem Desktop):
  // derselbe Abstand, absolut vom rechten Rand des Platzhalters
  emptyPanelClose: "right-12",
};

// ---------------------------------------------------------------------------
// Arbeitsbereich „Konversationen“ auf dem Desktop (KIE-575, ab xl: E15)
// ---------------------------------------------------------------------------

/**
 * Oberkante des scrollenden Rahmens der Einstellungsseiten unter dem
 * Fensterrand (px, md:my-[16px]).
 */
export const FRAME_TOP = 16;
/**
 * Ruhelage des Bereichs: Oberkante unter dem Fensterrand, wenn die Seite zu
 * Ende gescrollt ist (px) – 8 px unter der Oberkante des Rahmens. Daraus
 * folgen die Höhe des Bereichs (WORKSPACE_TOP_GAP) und das Sprungziel
 * (AVATAR_CLEARANCE.jumpTarget, xl:scroll-mt-2 = 8 px).
 */
export const WORKSPACE_REST_TOP = 24;
/**
 * Abstand der Oberkante des Bereichs zum oberen Fensterrand, wenn die Seite
 * zu Ende gescrollt ist, plus der Platz darunter (px). Unter dem Bereich
 * liegen 48 px (Innenabstand der Ansicht 24 + Abstand des Seitenrahmens 24)
 * und der Rahmen der Einstellungsseiten endet 16 px über dem unteren
 * Fensterrand: Mit 100vh − 88 px liegt der Bereich dann WORKSPACE_REST_TOP
 * (24 px) unter dem oberen Fensterrand, 8 px unter der Oberkante des
 * Rahmens.
 */
export const WORKSPACE_TOP_GAP = WORKSPACE_REST_TOP + 48 + 16;
/**
 * So niedrig wird der Bereich nie (px); darunter scrollt die Seite weiter.
 * 480 statt 560 (Fixliste 7.22-rc11, K13): Unter dem Bereich liegen 64 px
 * (48 + Rahmen 16). Mit 560 ragte er bei 600 px Fensterhöhe 24 px über den
 * oberen Rand, das ✕ war angeschnitten. Mit 480 nimmt er bis 568 px
 * Fensterhöhe die volle Höhe 100vh − 88 (bei 600 px: 512 px, Oberkante
 * 24 px) und bleibt bis 544 px ganz im Fenster; erst darunter wird er
 * angeschnitten. 480 px reichen für Kopf (rund 100 px) und sechs bis
 * sieben Zeilen neben einem lesbaren Verlauf. Die Alternative, unter
 * 640 px Fensterhöhe die Seite wieder normal scrollen zu lassen, brächte
 * eine dritte Darstellung mit zwei Scroll-Verhalten zurück, die KIE-575
 * abgeschafft hat, samt zweiter Weiche in Code und Tests; Desktop-Fenster
 * (ab 1.280 px breit) sind in der Praxis mindestens 600 px hoch.
 */
export const WORKSPACE_MIN_HEIGHT = 480;
/** Der Verlauf ist auf dem Desktop überall mindestens so breit (px, E15). */
export const WORKSPACE_PANEL_MIN_WIDTH = 480;

/**
 * Klassen des Arbeitsbereichs auf dem Desktop (ab xl, E15): Liste links und
 * Verlauf rechts, beide so hoch wie der Bereich, je mit eigener
 * Bildlaufleiste. Auf Tablet und Smartphone wirkt keine davon
 * (Vollbild-Panel, Seite scrollt).
 * - area: feste Höhe = Fensterhöhe − WORKSPACE_TOP_GAP, mindestens
 *   WORKSPACE_MIN_HEIGHT (480: bei 600 px Fensterhöhe ganz im Fenster,
 *   K13); Spalten mit 16 px Abstand
 * - column: linke Spalte – Kopf (Suche, Filter) oben fest, darunter der
 *   scrollende Teil
 * - scroller: der scrollende Teil der linken Spalte (Zeilen, „Weitere
 *   laden“, Hinweise). Positioniert (relative): Die nur für Screenreader
 *   bestimmten Texte der Bewertungsmarken (sr-only: position absolute)
 *   gehören so zur Spalte und verlängern nicht die Seite – ohne
 *   positionierten Vorfahren zählten die der unteren Zeilen zur Seite,
 *   die dann über den Bereich hinaus scrollte.
 * - panel: rechte Spalte – einheitlich 56 % (Liste 44 %, je abzüglich des
 *   halben Spaltenabstands) und mindestens WORKSPACE_PANEL_MIN_WIDTH; kein
 *   eigener Schritt mehr bei 1.536 px und keine schmalere Zone darunter
 *   (E15). Bei 1.280 px ist der Bereich rund 920 px breit: Verlauf rund
 *   510 px, Liste rund 400 px.
 * Die Klassen stehen wörtlich (keine Vorlagen mit den Konstanten): Tailwind
 * erzeugt nur CSS für Klassen, die es im Quelltext liest. Ein Test prüft,
 * dass die Zahlen darin zu den Konstanten passen.
 */
export const WORKSPACE = {
  area: "xl:flex xl:gap-4 xl:h-[max(480px,calc(100vh-88px))]",
  column: "xl:flex xl:min-w-0 xl:flex-1 xl:flex-col",
  scroller:
    "xl:relative xl:min-h-0 xl:flex-1 xl:overflow-y-auto xl:overscroll-contain",
  panel: "xl:w-[calc(56%-8px)] xl:min-w-[480px] xl:shrink-0",
};

/**
 * Abstände, mit denen die gewählte Zeile in der Spalte in Sicht kommt
 * (nearestScrollTop, Fixliste 7.22-rc11 K11): oben die Höhe der Überschrift
 * einer Tagesgruppe (pt-3 12 + Zeile 16 + pb-1 4 = 32 px), damit sie beim
 * Blättern nach oben mitkommt; unten ein kleiner Rand.
 */
export const ROW_SCROLL_MARGIN = { marginTop: 32, marginBottom: 8 };

/**
 * Längste Zeile einer Nachrichtenblase im Verlauf (px, Fixliste 7.22-rc11,
 * K14): Bei 2.560 px war der Verlauf rund 1.230 px breit und eine Antwort
 * lief über 1.800 Zeichen je Zeile. 720 px entsprechen rund 75 bis 85
 * Zeichen bei 14 px Schrift. Kein Deckel für Kennzahlen und Diagramm
 * (Nutzerwunsch: volle Breite) und keiner für den Verlauf selbst.
 * Bewusst bei jeder Breite, auch im Vollbild auf dem Tablet (Fixliste
 * 7.22-rc13, E14): Auf schmalen Bildschirmen wirkt der Deckel nicht, auf
 * breiten Tablets begrenzt er die Zeilenlänge wie auf dem Desktop.
 */
export const BUBBLE_MAX_WIDTH = 720;
/**
 * Klassen der Blasen (wörtlich, siehe WORKSPACE): die Antwortzeile (Avatar
 * und Text, linksbündig) höchstens BUBBLE_MAX_WIDTH; die Nutzerblase rechts
 * wie bisher höchstens 85 % und ebenfalls höchstens BUBBLE_MAX_WIDTH.
 */
export const BUBBLE = {
  question: "max-w-[min(85%,720px)]",
  answer: "max-w-[720px]",
};

/** Schlüssel im Browser-Speicher: Verlauf offen ("open") oder zu ("closed"). */
export const PANEL_PREFERENCE_KEY = "kie.conversations.panel";

/**
 * Der Speicher des Browsers – erst im try aufgelöst: Bei gesperrten
 * Website-Daten wirft schon der Zugriff auf localStorage (SecurityError),
 * nicht erst getItem (Review 7.22-rc12, C4). undefined: der des Fensters.
 * @param {{getItem?: Function, setItem?: Function}|null|undefined} storage
 * @returns {{getItem?: Function, setItem?: Function}|null|undefined}
 */
const browserStorage = (storage) =>
  storage === undefined ? globalThis.localStorage : storage;

/**
 * Gemerkter Zustand des Verlaufs auf dem Desktop: true (offen), solange
 * nicht "closed" gespeichert ist – auch ohne Speicher oder wenn er nicht
 * lesbar ist (privates Fenster, gesperrte Website-Daten).
 * @param {{getItem: Function}|null} [storage] - ohne Angabe localStorage
 * @returns {boolean}
 */
export function readPanelPreference(storage) {
  try {
    return (
      browserStorage(storage)?.getItem?.(PANEL_PREFERENCE_KEY) !== "closed"
    );
  } catch {
    return true;
  }
}

/**
 * Merkt sich, ob der Verlauf offen oder zu ist. Ein nicht schreibbarer
 * Speicher ändert nichts an der Ansicht.
 * @param {boolean} open
 * @param {{setItem: Function}|null} [storage] - ohne Angabe localStorage
 */
export function writePanelPreference(open, storage) {
  try {
    browserStorage(storage)?.setItem?.(
      PANEL_PREFERENCE_KEY,
      open ? "open" : "closed"
    );
  } catch {
    // kein Speicher: der Zustand gilt für diese Seite
  }
}

/**
 * Richtung einer Pfeiltaste für das Blättern in der Liste: 1 (↓), −1 (↑),
 * sonst 0 – auch mit Umschalt-, Alt-, Strg- oder Befehlstaste: Umschalt+↓
 * erweitert eine Textauswahl, Alt/Strg/Befehl+↓ gehören dem Browser oder
 * dem System (Review 7.22-rc12, K01).
 * @param {{key?: string, shiftKey?: boolean, altKey?: boolean, ctrlKey?: boolean, metaKey?: boolean}} event
 * @returns {-1|0|1}
 */
export function arrowStep(event) {
  if (
    !event ||
    event.shiftKey ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey
  )
    return 0;
  if (event.key === "ArrowDown") return 1;
  if (event.key === "ArrowUp") return -1;
  return 0;
}

/**
 * Steht ein modaler Dialog (aria-modal="true", etwa die Lösch-Rückfrage)
 * im Dokument?
 * @param {Document} doc
 * @returns {boolean}
 */
function modalOpen(doc) {
  if (typeof doc.querySelector === "function")
    return !!doc.querySelector('[aria-modal="true"]');
  return elementsWith(doc.body, "aria-modal", "true").length > 0;
}

/**
 * Dürfen ↑/↓ am Fenster die Liste blättern (AK-6)? Ja, wenn der Fokus
 * niemandem gehört (auf <body>, Seite gerade geöffnet) oder im Kopf des
 * Panels steht (‹ › ⋯ ✕, Sprung-Schaltflächen) – dort tun die Pfeiltasten
 * sonst nichts. Nicht im Menü „⋯“ (eigene Pfeiltasten), nicht in Eingaben,
 * auf Listenzeilen (eigener Handler) oder im scrollenden Verlauf: Der ist
 * fokussierbar (tabIndex 0), ein Klick in seinen Text setzt den Fokus also
 * dorthin, und ↓ scrollt ihn (Review 7.22-rc12, K01). Nie, solange ein
 * modaler Dialog offen ist – auch wenn dessen Fokus auf <body> gefallen ist
 * (K05: sonst wechselte ↓ die Konversation hinter der Lösch-Rückfrage).
 * @param {Document|undefined} [doc]
 * @returns {boolean}
 */
export function arrowNavigationAllowed(
  doc = typeof document === "undefined" ? undefined : document
) {
  if (!doc) return false;
  if (modalOpen(doc)) return false;
  if (focusLost(doc)) return true;
  let inHead = false;
  for (let node = doc.activeElement; node && node !== doc.body; ) {
    if (node.getAttribute?.("role") === "menu") return false;
    if (node.hasAttribute?.("data-panel-head")) inHead = true;
    node = node.parentNode;
  }
  return inHead;
}

/**
 * Hat das Element den Fokus des Dokuments? Eine Stelle statt
 * document.activeElement in der Liste (Fixliste 7, F24) – für „Weitere
 * laden“ beim Nachladen (Fixliste 7.22-rc11, K15).
 * @param {Element|null|undefined} element
 * @param {Document|undefined} [doc]
 * @returns {boolean}
 */
export function hasFocus(
  element,
  doc = typeof document === "undefined" ? undefined : document
) {
  return !!element && !!doc && doc.activeElement === element;
}

/**
 * Zeigt der Browser für das Element den Fokusring, weil es per Tastatur
 * fokussiert wurde (:focus-visible)? Ohne Auskunft (kein matches, Browser
 * ohne :focus-visible, kein Element) gilt Tastatur – dann bekommt der Fokus
 * nach dem Nachladen die erste neue Zeile (Fixliste 7.22-rc11, K15).
 * @param {Element|null|undefined} element
 * @returns {boolean}
 */
export function focusVisible(element) {
  try {
    return typeof element?.matches === "function"
      ? element.matches(":focus-visible")
      : true;
  } catch {
    return true;
  }
}

/** Elternelemente eines Knotens bis unter <body> (nur Elemente). */
export function ancestorsOf(node) {
  const found = [];
  const body = node?.ownerDocument?.body;
  for (
    let current = node?.parentNode;
    current && current !== body && current.nodeType === 1;
    current = current.parentNode
  )
    found.push(current);
  return found;
}

/** Eingaben, mit denen der Nutzer selbst scrollt oder etwas tut. */
const USER_INPUT_EVENTS = [
  "wheel",
  "touchstart",
  "pointerdown",
  "mousedown",
  "keydown",
];
/** So lange hält holdScrollTarget höchstens, auch ohne Eingabe. */
export const HOLD_SCROLL_MAX_MS = 10000;
/**
 * Ruhezeit des Layouts: So lange nach der letzten Größenänderung über dem
 * Ziel (bzw. dem Ende des Ladens) hält holdScrollTarget noch – danach ist
 * der Sprung erledigt (Fixliste 7, F15). Verschiebt in dieser Zeit ein
 * Scrollen das Ziel, gilt es nur bis zum Ende des Ladens als fremd.
 */
export const HOLD_SCROLL_QUIET_MS = 1500;
/**
 * Harte Obergrenze, solange das Ziel noch nicht fertig ist (Option busy von
 * holdScrollTarget – etwa die Link-Suche lädt noch Seiten nach, Fixliste 8,
 * M1): länger hält der Sprung nie, auch wenn die Suche weiterläuft.
 */
export const HOLD_SCROLL_BUSY_MAX_MS = 30000;

/**
 * Hält ein Sprungziel an seiner Stelle, solange das Layout darüber noch
 * unruhig ist (Fixliste 4, V7). Ein einmaliger Sprung (scrollIntoView) gilt
 * nur für das Layout dieses Augenblicks: Wird danach etwas über dem Ziel
 * höher oder niedriger (nachgeladene Inhalte, Schriften, Diagramme) oder
 * setzt der Browser die Scrollposition selbst (Scroll-Anker, Wiederherstellen
 * beim Laden), stünde das Ziel woanders – beim Öffnen per Link bliebe die
 * Seite scheinbar ungescrollt. Deshalb: springen, dann bei jeder
 * Größenänderung eines Vorfahren (ResizeObserver) erneut springen, ebenso
 * bei fremdem Scrollen, das das Ziel verschiebt.
 *
 * Nur so lange wie nötig (Fixliste 7, F15): Das Halten endet von selbst,
 * sobald die Seite fertig geladen ist (readyState „complete“) und das Layout
 * über dem Ziel HOLD_SCROLL_QUIET_MS ruhig war – spätestens nach
 * HOLD_SCROLL_MAX_MS, und sofort bei der ersten Eingabe (Rad, Tippen,
 * Zeiger, Taste). Die Ursachen sind dafür an der Quelle behoben: Die Ansicht
 * stellt die Scrollposition selbst ein (history.scrollRestoration „manual“
 * auf der Seite), und der Sprung kommt erst, wenn Kennzahlen, Diagramm,
 * Uhrzeit-Karte und Liste geladen sind. Was dann noch bleibt (Schriften,
 * Messung der Diagrammbreite), fällt in die kurze Ruhezeit.
 *
 * Ein Scrollen, das das Ziel verschiebt, ohne dass vorher eine Eingabe kam
 * (Scrollbalken ziehen, Screenreader, Sprachsteuerung, „Im Seitentext
 * suchen“), gilt nach dem Ende des Ladens und außerhalb der Ruhezeit als
 * Absicht des Nutzers und beendet das Halten (Fixliste 5, S2). Bekannte,
 * jetzt kurze Grenze: Kommt ein solches Scrollen innerhalb der Ruhezeit nach
 * einer Layoutänderung, springt die Seite einmal zurück.
 *
 * realign() am Rückgabewert springt noch einmal, solange das Halten läuft –
 * für Änderungen, die das Ziel selbst nicht verschieben (die per Link
 * geöffnete Zeile ist nachgeladen, Fixliste 6, K5); die Ruhezeit beginnt
 * dann neu. Nach dem Ende tut es nichts.
 *
 * Ist das Ziel noch nicht fertig (busy() liefert true – die Link-Suche lädt
 * Folgeseiten, die gesuchte Zeile steht noch nicht in der Liste), endet das
 * Halten nicht durch Ruhe: Eine langsame Folgeseite ändert am Layout über
 * dem Ziel nichts, und ohne Halten bliebe die später gefundene Zeile unter
 * dem Fensterrand (Fixliste 8, M1). Es endet dann erst, wenn busy() false
 * ist und danach die Ruhezeit verstrichen ist (realign beginnt sie neu),
 * spätestens nach busyMaxMs – eine Eingabe beendet es weiterhin sofort.
 * @param {Element|null} target
 * @param {() => void} jump - der Sprung (etwa scrollIntoView)
 * @param {{maxMs?: number, quietMs?: number, busy?: () => boolean, busyMaxMs?: number, now?: () => number, setTimer?: Function, clearTimer?: Function}} [options]
 * @returns {(() => void) & {realign: () => void}} - beendet das Halten
 */
export function holdScrollTarget(target, jump, options = {}) {
  const {
    maxMs = HOLD_SCROLL_MAX_MS,
    quietMs = HOLD_SCROLL_QUIET_MS,
    busy = () => false,
    busyMaxMs = HOLD_SCROLL_BUSY_MAX_MS,
    now = () => Date.now(),
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = options;
  if (!target) return Object.assign(() => {}, { realign: () => {} });
  const topOf = () => target.getBoundingClientRect?.().top;
  let held = topOf();
  const align = () => {
    jump();
    held = topOf();
  };
  align();

  const doc = target.ownerDocument;
  let stopped = false;
  let observer = null;
  let timer = null;
  let quietTimer = null;
  const loading = () =>
    doc?.readyState !== undefined && doc.readyState !== "complete";
  // Zuletzt unruhig: Start, Größenänderung eines Vorfahren, Ende des Ladens
  const started = now();
  let lastLayout = started;
  const settling = () => loading() || now() - lastLayout <= quietMs;
  // Ruhezeit um: Ist die Seite geladen und das Ziel fertig, endet das
  // Halten. Lädt die Seite noch, beginnt sie mit dem Ende des Ladens neu;
  // ist das Ziel noch nicht fertig (busy), wird nach einer weiteren
  // Ruhezeit erneut geprüft (Fixliste 8, M1).
  const quietOver = () => {
    if (loading()) return;
    if (busy()) quietTimer = setTimer(quietOver, quietMs);
    else stop();
  };
  // Unruhe: die Ruhezeit beginnt neu
  const unrest = () => {
    lastLayout = now();
    clearTimer(quietTimer);
    quietTimer = setTimer(quietOver, quietMs);
  };
  // Höchstdauer um: Schluss – außer das Ziel ist noch nicht fertig, dann
  // bis zur harten Obergrenze busyMaxMs (gerechnet ab dem Start)
  const maxOver = () => {
    const left = busyMaxMs - (now() - started);
    if (busy() && left > 0) timer = setTimer(stop, left);
    else stop();
  };
  const onScroll = () => {
    const top = topOf();
    if (stopped || !Number.isFinite(top) || Math.abs(top - held) <= 1) return;
    if (settling()) align();
    else stop();
  };
  const onReady = () => {
    if (!stopped) unrest();
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    observer?.disconnect?.();
    clearTimer(timer);
    clearTimer(quietTimer);
    doc?.removeEventListener?.("scroll", onScroll, true);
    doc?.removeEventListener?.("readystatechange", onReady);
    for (const type of USER_INPUT_EVENTS)
      doc?.removeEventListener?.(type, stop, true);
  };
  if (typeof ResizeObserver !== "undefined") {
    observer = new ResizeObserver(() => {
      if (stopped) return;
      unrest();
      align();
    });
    for (const element of ancestorsOf(target)) observer.observe(element);
  }
  doc?.addEventListener?.("scroll", onScroll, true);
  doc?.addEventListener?.("readystatechange", onReady);
  for (const type of USER_INPUT_EVENTS)
    doc?.addEventListener?.(type, stop, { capture: true, passive: true });
  timer = setTimer(maxOver, maxMs);
  unrest();
  return Object.assign(stop, {
    realign: () => {
      if (stopped) return;
      unrest();
      align();
    },
  });
}

/** Kürzester Suchbegriff, ab dem gesucht wird. */
export const SEARCH_MIN_LENGTH = 2;
/**
 * Längster Suchbegriff (Zeichen) – derselbe Wert wie SEARCH_MAX_LENGTH des
 * Servers (server/utils/helpers/chat/conversationSearch.js; ein Test prüft
 * die Gleichheit).
 */
export const SEARCH_MAX_LENGTH = 200;

const timeFormatter = new Intl.DateTimeFormat(GERMAN, {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: BERLIN,
});

/**
 * Berliner Uhrzeit "HH:MM"; "" ohne gültigen Zeitpunkt.
 * @param {number|string|Date} instant
 * @returns {string}
 */
export function berlinTime(instant) {
  const date = new Date(instant);
  return isNaN(date.getTime()) ? "" : timeFormatter.format(date);
}

/**
 * Zeitpunkt mit Datum in Berliner Zeit, „12.10.2026, 12:05:00 Uhr“ – für
 * Tooltips der Liste und des Panels, wie die sichtbaren Uhrzeiten (Fixliste
 * 2, S1). Die zentrale formatDateTimeDE (utils/dateTimeDE.js, ohne moment)
 * mit fester Zeitzone – keine zweite Formatierung (Fixliste 5, S3). "-"
 * ohne gültigen Zeitpunkt.
 * @param {number|string|Date} instant
 * @returns {string}
 */
export function berlinDateTime(instant) {
  return formatDateTimeDE(instant, { timeZone: BERLIN });
}

/**
 * Fehlen Inhalte gezählter Konversationen (Fixliste 6, N1)? Die Kennzahl
 * „Konversationen“ (Zählerbuch) zählt je Widget die Zeilen, für deren
 * Schlüssel COALESCE(conversation_id, session_id) es noch keine frühere
 * Zeile gab (EmbedChats._startsConversation). Die Liste zeigt je
 * (Schlüssel, session_id) eine Zeile, sobald eine vorhandene Nachricht
 * (include = 1) im Zeitraum liegt. Jede gezählte Konversation hat ihre
 * erste Nachricht im Zeitraum, und zwei gezählte fallen nie in dieselbe
 * Zeile der Liste – ist alles vorhanden, zeigt die Liste also mindestens so
 * viele (mehr bei weitergeführten älteren Konversationen und bei einer
 * Kennung aus zwei Sitzungen). Weniger einsehbar als gezählt heißt deshalb:
 * Inhalte fehlen (Aufbewahrungsfrist, vom Besucher geleert, gelöscht).
 * Umgekehrt kann eine Lücke unerkannt bleiben, wenn weitergeführte
 * Konversationen sie auffüllen – der Hinweis erscheint nie zu Unrecht.
 * Voraussetzung: dieselben Tage (die Liste begrenzt den Zeitraum seit
 * Fixliste 7, F06 in denselben Berliner Kalendertagen wie das Zählerbuch –
 * in jeder Zeitzone des Browsers), kein Filter.
 * @param {number|null} counted - Kennzahl „Konversationen“ des Zeitraums
 * @param {number|null} viewable - Konversationen der Liste ohne Filter
 * @returns {boolean}
 */
export function hasContentGap(counted, viewable) {
  return (
    Number.isFinite(counted) && Number.isFinite(viewable) && viewable < counted
  );
}

/** Mitternacht (UTC) eines Kalendertags – formatterOf rechnet in UTC. */
const instantOf = (day) => new Date(`${day}T00:00:00Z`);

/**
 * Überschrift einer Tagesgruppe: „Heute · Dienstag, 13. Oktober",
 * „Gestern · Montag, 12. Oktober", „Sonntag, 11. Oktober"; aus einem anderen
 * Jahr als heute mit Jahreszahl. Das Datum steht immer deutsch, nur „Heute"
 * und „Gestern" folgen der Sprache der Oberfläche.
 * @param {string} day - Berliner Kalendertag "YYYY-MM-DD" ("" = unbekannt)
 * @param {string} today - heutiger Berliner Kalendertag
 * @param {{t: Function}} context
 * @returns {string}
 */
export function dayGroupLabel(day, today, { t }) {
  if (!day) return "–";
  const sameYear = day.slice(0, 4) === today.slice(0, 4);
  const date = formatterOf(GERMAN, {
    weekday: "long",
    day: "numeric",
    month: "long",
    ...(sameYear ? {} : { year: "numeric" }),
  }).format(instantOf(day));
  if (day === today) return t("embed-analytics.rows.today", { date });
  if (day === addDays(today, -1))
    return t("embed-analytics.rows.yesterday", { date });
  return date;
}

/**
 * „9. Okt." – kurzer Tag für „begonnen am …" (immer deutsch); aus einem
 * anderen Jahr als heute mit Jahreszahl.
 * @param {string} day
 * @param {string} today
 * @returns {string}
 */
export function shortDayLabel(day, today) {
  if (!day) return "–";
  return formatterOf(GERMAN, {
    day: "numeric",
    month: "short",
    ...(day.slice(0, 4) === today.slice(0, 4) ? {} : { year: "numeric" }),
  }).format(instantOf(day));
}

/**
 * „Dienstag, 13.10.2026" – Kopf des Panels, immer deutsch.
 * @param {string} day
 * @returns {string}
 */
export function longDateLabel(day) {
  if (!day) return "";
  const weekday = formatterOf(GERMAN, { weekday: "long" }).format(
    instantOf(day)
  );
  return `${weekday}, ${formatDate(day)}`;
}

/**
 * Konversationen der Liste nach dem Berliner Tag ihrer LETZTEN Nachricht –
 * in der Reihenfolge der Liste (letzte Nachricht absteigend). Eine
 * weitergeführte alte Konversation steht so unter „Heute".
 * @param {Array<{last_message_at: number}>} conversations
 * @returns {Array<{day: string, conversations: Array}>}
 */
export function groupByLastMessageDay(conversations) {
  const groups = [];
  for (const conversation of conversations) {
    const day = formatDateForInput(conversation.last_message_at);
    const last = groups.at(-1);
    if (last && last.day === day) last.conversations.push(conversation);
    else groups.push({ day, conversations: [conversation] });
  }
  return groups;
}

/**
 * Wie lange eine Konversation nach ihrer letzten Nachricht als „Neu" gilt
 * (Nachtrag KIE-560, K3): eine reine Dauer, unabhängig von Zeitzone und
 * Tagesgrenze.
 */
export const NEW_CONVERSATION_MS = 4 * 60 * 60 * 1000;

/**
 * „Neu“: Die letzte Nachricht ist jünger als NEW_CONVERSATION_MS (genau
 * vier Stunden alt: nicht mehr neu). Ohne gültigen Zeitpunkt nie neu.
 * Maßgeblich ist last_message_at der Liste, also die letzte Nachricht in der
 * Auswahl (Zeitraum, Stand der ersten Seite), nicht eine spätere außerhalb
 * davon (Review 7.22-rc2, N06).
 * @param {{last_message_at: number}} conversation
 * @param {number} [now] - jetzt (ms seit 1970)
 * @returns {boolean}
 */
export function isNewConversation(conversation, now = Date.now()) {
  const last = conversation?.last_message_at;
  return (
    typeof last === "number" &&
    Number.isFinite(last) &&
    now - last < NEW_CONVERSATION_MS
  );
}

/**
 * Wann endet das nächste „Neu“ der Liste? Der früheste Zeitpunkt, an dem eine
 * jetzt neue Konversation vier Stunden alt wird; null, wenn keine neu ist.
 * Die Liste rechnet „Neu“ dann erneut aus, auch wenn die Seite offen bleibt
 * (Review 7.22-rc2, K01). Höchstens vier Stunden nach now: Ein Zeitpunkt in
 * der Zukunft (Uhr des Rechners geht nach) ergäbe sonst eine Wartezeit über
 * dem Höchstwert von setTimeout (etwa 24,8 Tage), der Zeitgeber feuerte sofort
 * und die Liste rechnete ohne Pause neu (Review 7.22-rc6, K03).
 * @param {Array<{last_message_at: number}>} conversations
 * @param {number} now - jetzt (ms seit 1970)
 * @returns {number|null} - Zeitpunkt (ms seit 1970)
 */
export function nextNewExpiry(conversations, now) {
  let next = null;
  for (const conversation of conversations ?? []) {
    if (!isNewConversation(conversation, now)) continue;
    const ends = Math.min(
      conversation.last_message_at + NEW_CONVERSATION_MS,
      now + NEW_CONVERSATION_MS
    );
    if (next === null || ends < next) next = ends;
  }
  return next;
}

/**
 * Mindestbreite der Spalte mit den Bewertungsmarken (Nachtrag KIE-560, K2):
 * so breit wie beide Marken mit zweistelliger Zahl, damit die Frage in allen
 * Zeilen an derselben Stelle endet (vorher war die Spalte je Zeile so breit
 * wie ihre Marken). Gerechnet mit Plus Jakarta Sans 12 px, Stärke 600: die
 * breiteste zweistellige Zahl („40“) misst 16,34 px.
 * - ab sm (Pille): 8 + Daumen 13 + 4 + 16,34 + 8 = 49,34 px je Marke, zwei
 *   Marken mit 6 px Abstand 104,7 px → 106 px
 * - unter sm (ohne Pille): 13 + 2 + 16,34 = 31,34 px je Marke, zwei Marken
 *   mit 8 px Abstand 70,7 px → 72 px
 * Dreistellige Zahlen dürfen die Spalte ihrer Zeile verbreitern.
 */
export const RATING_COLUMN = "min-w-[72px] sm:min-w-[106px]";

/**
 * Beginn an einem anderen Tag als die letzte Nachricht? Dann der Tag des
 * Beginns, sonst null.
 * @param {{started_at: number, last_message_at: number}} conversation
 * @returns {string|null} - Berliner Kalendertag des Beginns
 */
export function startedOnOtherDay(conversation) {
  const started = formatDateForInput(conversation.started_at);
  return !started ||
    started === formatDateForInput(conversation.last_message_at)
    ? null
    : started;
}

// Steuerzeichen und allein stehende Ersatzhälften lehnt der Server ab (400).
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const LONE_SURROGATE = /[\uD800-\uDFFF]/u;

/** getrimmt, NFC; null, wenn der Server den Begriff ablehnen würde */
function cleanTerm(value) {
  const raw = String(value ?? "");
  if (LONE_SURROGATE.test(raw)) return null;
  const term = raw.normalize("NFC").trim();
  return CONTROL_CHARACTERS.test(term) ? null : term;
}

/**
 * Suchbegriff der Liste: getrimmt, in NFC, auf SEARCH_MAX_LENGTH Zeichen
 * gekürzt; kürzer als SEARCH_MIN_LENGTH oder für den Server ungültig
 * (Steuerzeichen, kaputtes Unicode) = keine Suche.
 * @param {string|null|undefined} value
 * @returns {string} - "" ohne Suche
 */
export function effectiveSearch(value) {
  const term = cleanTerm(value);
  if (term === null) return "";
  const chars = [...term];
  const cut =
    chars.length > SEARCH_MAX_LENGTH
      ? chars.slice(0, SEARCH_MAX_LENGTH).join("").trim()
      : term;
  return [...cut].length >= SEARCH_MIN_LENGTH ? cut : "";
}

/**
 * Ein Suchbegriff aus der Adresse (Link), den die Ansicht nicht unverändert
 * übernehmen kann: zu lang (wird gekürzt) oder ungültig (wird verworfen).
 * @param {string|null|undefined} value
 * @returns {"too-long"|"invalid"|null}
 */
export function searchLinkIssue(value) {
  if (!value) return null;
  const term = cleanTerm(value);
  if (term === null) return "invalid";
  return [...term].length > SEARCH_MAX_LENGTH ? "too-long" : null;
}

/**
 * Schlüssel einer Konversation der Liste: Kennung und Browser-Sitzung – eine
 * zweite Sitzung kann dieselbe Kennung tragen (KIE-538).
 * @param {{conversation_id: string, session_id: string}} conversation
 * @returns {string}
 */
export function conversationKey({ conversation_id, session_id }) {
  return `${conversation_id}\u0000${session_id}`;
}

/**
 * Die Kennung gekürzt für die Fußzeile: die ersten 8 Zeichen und „…".
 * @param {string|null|undefined} id
 * @returns {string}
 */
export function shortId(id) {
  const chars = [...String(id ?? "")];
  return chars.length > 9 ? `${chars.slice(0, 8).join("")}…` : chars.join("");
}

/**
 * Text einer gespeicherten Antwort, wie die Ansicht ihn zeigt: bei JSON das
 * Feld text, sonst die Antwort selbst.
 * @param {string|null} response
 * @returns {string}
 */
export function answerText(response) {
  if (typeof response !== "string") return "";
  try {
    const parsed = JSON.parse(response);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      return typeof parsed.text === "string" ? parsed.text : "";
  } catch {
    // keine JSON-Antwort: wörtlich
  }
  return response;
}

// Markdown-Autolinks: <https://…>, <mailto:…>, <info@vhs.de> – der
// MarkdownRenderer zeigt die Adresse als Linktext (Fixliste 2, S2).
const AUTOLINK =
  /<((?:[a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s<>]*)|(?:[^\s<>@]+@[^\s<>@]+))>/g;

/**
 * Was von einem Antworttext sichtbar ist (ungefähr wie der MarkdownRenderer
 * ihn zeigt): ohne <think>-Blöcke (eingeklappt), ohne Ziele von Links und
 * Bildern ("[Text](https://…)" → "Text"), ohne HTML-Tags und Attribute.
 * Autolinks (<https://…>, <info@…>) bleiben als ihr sichtbarer Text.
 * @param {string} text
 * @returns {string}
 */
export function visibleAnswerText(text) {
  return String(text ?? "")
    .replace(/<think>[^]*?<\/think>/g, " ")
    .replace(/\]\([^)]*\)/g, "]")
    .replace(AUTOLINK, " $1 ")
    .replace(/<\/?[a-zA-Z][^>]*>/g, " ");
}

/**
 * Die Angaben zum Kopf des Panels aus den Nachrichten einer Konversation.
 * @param {Array<{prompt: string, createdAt: string, feedbackScore: boolean|null, conversation_id: string|null, session_id: string}>} messages
 * @returns {{key: string, conversationId: string, firstQuestion: string, startedAt: number, lastAt: number, questions: number, positive: number, negative: number}|null}
 */
export function conversationSummary(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return null;
  const first = messages[0];
  const times = messages.map((m) => new Date(m.createdAt).getTime());
  const conversationId = first.conversation_id ?? first.session_id;
  return {
    key: conversationKey({
      conversation_id: conversationId,
      session_id: first.session_id,
    }),
    conversationId,
    firstQuestion: first.prompt ?? "",
    startedAt: Math.min(...times),
    lastAt: Math.max(...times),
    questions: messages.length,
    positive: messages.filter((m) => m.feedbackScore === true).length,
    negative: messages.filter((m) => m.feedbackScore === false).length,
  };
}

/**
 * Liegt eine Nachricht im gewählten Zeitraum – in den Berliner
 * Kalendertagen fromDay … toDay (beide einschließlich), wie die Liste sie
 * dem Server sendet (Fixliste 7, F06)? Ohne Tage („Gesamt“) immer.
 * @param {{createdAt: string}} message
 * @param {{fromDay?: string|null, toDay?: string|null}} [period]
 * @returns {boolean}
 */
export function inPeriod(message, { fromDay = null, toDay = null } = {}) {
  if (!fromDay && !toDay) return true;
  const day = formatDateForInput(message?.createdAt);
  if (!day) return false;
  return (!fromDay || day >= fromDay) && (!toDay || day <= toDay);
}

/**
 * Liegt keine Nachricht im gewählten Zeitraum? Dann zeigt die Liste die
 * Konversation nicht (geöffnet per Link).
 * @param {Array<{createdAt: string}>} messages
 * @param {{fromDay?: string|null, toDay?: string|null}} [period] -
 *   Kalendertage der Liste (null = „Gesamt")
 * @returns {boolean}
 */
export function outsidePeriod(messages, period = {}) {
  if (!Array.isArray(messages) || messages.length === 0) return false;
  if (!period.fromDay && !period.toDay) return false;
  return !messages.some((message) => inPeriod(message, period));
}

const REGEXP_SPECIAL = /[.*+?^${}()|[\]\\/]/g;
const escapeRegExp = (text) => text.replace(REGEXP_SPECIAL, "\\$&");

/**
 * Die Schreibweisen eines Zeichens, die die Suche als dasselbe Zeichen
 * ansieht: es selbst, klein und groß – nur wenn diese wieder genau ein
 * Zeichen sind („ß" wird groß zu „SS"; dafür gehört das große „ẞ" dazu).
 * Dieselbe Regel wie variantsOf des Servers
 * (server/utils/helpers/chat/conversationSearch.js; ein Test vergleicht
 * beide): So hebt das Panel genau hervor, was der Server gefunden hat
 * (Fixliste 7, F05) – auch beim türkischen ı (groß I) und İ (klein i +
 * Punkt, zwei Zeichen), für die das u-Flag von JavaScript anders faltet.
 * @param {string} char - ein Zeichen (Codepoint)
 * @returns {string[]}
 */
export function searchVariants(char) {
  const variants = new Set([char]);
  for (const other of [char.toLowerCase(), char.toUpperCase()])
    if ([...other].length === 1) variants.add(other);
  if (char === "ß" || char === "ẞ") {
    variants.add("ß");
    variants.add("ẞ");
  }
  return [...variants];
}

/** Ein Zeichen als Teil des Musters: eine Klasse seiner Schreibweisen. */
function charPattern(char) {
  const variants = searchVariants(char);
  return variants.length > 1
    ? `[${variants.map(escapeRegExp).join("")}]`
    : escapeRegExp(char);
}

/**
 * Regulärer Ausdruck für den Suchbegriff: wörtlich, Groß/klein egal nach
 * derselben Regel wie der Server (searchVariants – keine Faltung des
 * i-Flags), in NFC und NFD – ein zerlegtes „ü" im Text trifft wie ein
 * zusammengesetztes. null ohne Begriff. Bewusst belassen: In zerlegtem Text
 * trifft auch der Basisbuchstabe allein („mu" in „Müller"), wie auf dem
 * Server (searchForms in server/utils/helpers/chat/conversationSearch.js).
 * @param {string} term
 * @returns {RegExp|null}
 */
export function searchPattern(term) {
  const search = effectiveSearch(term);
  if (!search) return null;
  const forms = [...new Set([search, search.normalize("NFD")])];
  return new RegExp(
    forms.map((form) => [...form].map(charPattern).join("")).join("|"),
    "gu"
  );
}

/**
 * Teilt einen Text in Abschnitte mit und ohne Treffer – für die Hervorhebung
 * in React (der Text bleibt Text, kein HTML).
 * @param {string} text
 * @param {string|RegExp|null} term - Suchbegriff oder schon gebautes Muster
 * @returns {Array<{text: string, hit: boolean}>}
 */
export function highlightParts(text, term) {
  const value = String(text ?? "");
  const pattern = term instanceof RegExp ? term : searchPattern(term);
  if (!pattern || value === "") return [{ text: value, hit: false }];
  const parts = [];
  let last = 0;
  // Der Begriff hat mindestens SEARCH_MIN_LENGTH Zeichen: kein leerer Treffer.
  for (const match of value.matchAll(pattern)) {
    if (match.index > last)
      parts.push({ text: value.slice(last, match.index), hit: false });
    parts.push({ text: match[0], hit: true });
    last = match.index + match[0].length;
  }
  if (last < value.length) parts.push({ text: value.slice(last), hit: false });
  return parts;
}

/**
 * Steht der Suchbegriff irgendwo SICHTBAR in der Konversation – in einer
 * Frage, im sichtbaren Antworttext, in Grund oder Kommentar? Die Suche des
 * Servers liest auch Link-Adressen, HTML und <think>-Blöcke der Antwort; nur
 * dort getroffen, weist das Panel darauf hin (Fixliste Punkt 11; bewusst so
 * belassen, Fixliste 7 F13: siehe benchmarks/conversationSearch.manual.js).
 *
 * Geprüft werden nur die Nachrichten, die auch der Server durchsucht hat:
 * die im Zeitraum (Fixliste 2, S7) – mit Abschnitt (Säulenklick) die ganze
 * Konversation, dann ohne Zeitraum. Grund und Kommentar zeigt das Panel nur
 * bei negativer Bewertung.
 * @param {Array<{prompt: string, response: string, createdAt?: string, feedbackScore?: boolean|null, feedbackReason?: string|null, feedbackText?: string|null}>} messages
 * @param {string} term
 * @param {{fromDay?: string|null, toDay?: string|null}} [period] -
 *   Kalendertage der Liste; ohne Angabe alle Nachrichten
 * @returns {boolean} - true auch ohne Suche
 */
export function hasVisibleHit(messages, term, period = {}) {
  const pattern = searchPattern(term);
  if (!pattern) return true;
  const hit = (text) => {
    pattern.lastIndex = 0;
    return pattern.test(String(text ?? ""));
  };
  return (messages ?? [])
    .filter((message) => inPeriod(message, period))
    .some(
      (message) =>
        hit(message.prompt) ||
        (message.feedbackScore === false &&
          (hit(message.feedbackReason) || hit(message.feedbackText))) ||
        hit(visibleAnswerText(answerText(message.response)))
    );
}

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;
// In diesen Elementen wird nichts hervorgehoben.
const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "TEXTAREA", "MARK"]);

/**
 * Hebt die Treffer in den Textknoten eines (bereits bereinigten) DOM-Baums
 * hervor: Jeder Treffer wird ein <mark data-search-hit>, dessen Inhalt ein
 * Textknoten ist. Aus dem Nutzertext entsteht nie HTML – es werden nur
 * Textknoten geteilt.
 * @param {Node} root
 * @param {string} term
 * @param {Document} doc - Dokument, das die Knoten erzeugt
 * @returns {number} - Zahl der Treffer
 */
export function highlightTextNodes(root, term, doc) {
  const pattern = searchPattern(term);
  if (!root || !doc || !pattern) return 0;
  const textNodes = [];
  const walk = (node) => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === TEXT_NODE) textNodes.push(child);
      else if (
        child.nodeType === ELEMENT_NODE &&
        !SKIP_TAGS.has(String(child.nodeName).toUpperCase())
      )
        walk(child);
    }
  };
  walk(root);

  let hits = 0;
  for (const node of textNodes) {
    const parts = highlightParts(node.nodeValue, pattern);
    if (!parts.some((part) => part.hit)) continue;
    const parent = node.parentNode;
    for (const part of parts) {
      if (part.hit) {
        const mark = doc.createElement("mark");
        mark.setAttribute("data-search-hit", "");
        mark.appendChild(doc.createTextNode(part.text));
        parent.insertBefore(mark, node);
        hits += 1;
      } else {
        parent.insertBefore(doc.createTextNode(part.text), node);
      }
    }
    parent.removeChild(node);
  }
  return hits;
}

// ---------------------------------------------------------------------------
// HTML der Antworten im Verlauf (Admin-Ansicht; Review 7.22-rc12, K14;
// Fixliste 7.22-rc13, E13)
// ---------------------------------------------------------------------------

/**
 * DOMPurify für die Antworten im Verlauf der Konversationen. Antworten sind
 * Ausgaben des Sprachmodells, die anonyme Besucher des Widgets beeinflussen
 * können – und der Verlauf öffnet sich auf dem Desktop von selbst (AK-3),
 * ohne Klick. Darum strenger als im Chat:
 * - nur HTML (kein SVG, kein MathML: dort laden <image> und <use> fremde
 *   Inhalte),
 * - kein style (ein Link über der ganzen Seite, position:fixed) und kein
 *   <style>; keine Formulare und Eingabefelder (abgefragte Kennwörter),
 *   keine Medien, die von selbst laden (<video poster>, <audio>, <source>,
 *   <picture>, srcset, background), keine Popover, keine Dialoge,
 * - keine id, name und role sowie keine aria- und data-Attribute aus der
 *   Antwort: Die Ansicht sucht nach eigenen Kennzeichen (aria-modal,
 *   role="menu", data-rated); nur data-search-hit der Hervorhebung bleibt.
 * Klassen, Links und Bilder ordnet hardenAnswerHtml danach.
 */
export const ANSWER_PURIFY_CONFIG = Object.freeze({
  USE_PROFILES: { html: true },
  FORBID_TAGS: [
    "style",
    "form",
    "input",
    "button",
    "textarea",
    "select",
    "option",
    "dialog",
    "video",
    "audio",
    "source",
    "track",
    "picture",
  ],
  FORBID_ATTR: [
    "style",
    "id",
    "name",
    "role",
    "srcset",
    "background",
    "poster",
    "popover",
    "popovertarget",
    "popovertargetaction",
  ],
  ALLOW_ARIA_ATTR: false,
  ALLOW_DATA_ATTR: false,
  ADD_ATTR: ["data-search-hit"],
});

/** Rel jedes Links im Verlauf: kein Zugriff auf die Ansicht, kein Referrer. */
export const ANSWER_LINK_REL = "noopener noreferrer";
// Klassen aus Markdown und Syntaxhervorhebung (markdown-it, highlight.js) –
// alle anderen kämen aus dem HTML der Antwort und könnten Klassen der Seite
// nutzen (etwa „fixed inset-0 z-50“ als unsichtbare Fläche).
const ANSWER_CLASS = /^(?:hljs(?:-[\w-]+)?|language-[\w-]+)$/;
// Bilder werden nur als Link angeboten, wenn sie im Netz liegen
const ANSWER_IMAGE_URL = /^https?:\/\//i;

/**
 * Ordnet das von DOMPurify bereinigte HTML einer Antwort (in einem inerten
 * Dokument, vor dem Einsetzen in die Seite):
 * - Links mit Adresse öffnen in einem neuen Tab (target="_blank") mit
 *   rel="noopener noreferrer"; ohne Adresse kein target.
 * - Bilder laden nicht von selbst (kein Abruf beim Öffnen des Verlaufs:
 *   Zeitpunkt, IP-Adresse und Browser des Admins blieben sonst beim
 *   Absender): Ein Bild im Netz wird ein Link mit dem Alt-Text (ohne
 *   Alt-Text der Adresse), sonst bleibt nur der Alt-Text.
 * - Klassen nur aus Markdown und Syntaxhervorhebung (ANSWER_CLASS).
 * @param {Node|null} root - Wurzel des bereinigten HTML
 * @param {Document} doc - Dokument der Wurzel (für neue Knoten)
 */
export function hardenAnswerHtml(root, doc) {
  for (const node of [...(root?.childNodes ?? [])]) {
    if (node.nodeType !== ELEMENT_NODE) continue;
    hardenAnswerHtml(node, doc);
    const classes = node.getAttribute?.("class");
    if (classes !== null && classes !== undefined) {
      const kept = classes
        .split(/\s+/)
        .filter((name) => ANSWER_CLASS.test(name));
      if (kept.length > 0) node.setAttribute("class", kept.join(" "));
      else node.removeAttribute("class");
    }
    const tag = String(node.tagName ?? node.nodeName).toUpperCase();
    if (tag === "A") {
      if (node.hasAttribute("href")) {
        node.setAttribute("target", "_blank");
        node.setAttribute("rel", ANSWER_LINK_REL);
      } else {
        node.removeAttribute("target");
        node.removeAttribute("rel");
      }
    } else if (tag === "IMG") {
      const src = (node.getAttribute("src") ?? "").trim();
      const alt = (node.getAttribute("alt") ?? "").trim();
      let replacement = null;
      if (ANSWER_IMAGE_URL.test(src)) {
        replacement = doc.createElement("a");
        replacement.setAttribute("href", src);
        replacement.setAttribute("target", "_blank");
        replacement.setAttribute("rel", ANSWER_LINK_REL);
        replacement.appendChild(doc.createTextNode(alt || src));
      } else if (alt) {
        replacement = doc.createTextNode(alt);
      }
      if (replacement) node.parentNode.insertBefore(replacement, node);
      node.parentNode.removeChild(node);
    }
  }
}

/**
 * Das erste Element mit einem Attribut unter einem Knoten (Dokumentreihenfolge).
 * @param {Node|null} root
 * @param {string} attribute
 * @returns {Element|null}
 */
export function firstElementWith(root, attribute) {
  for (const child of root?.childNodes ?? []) {
    if (child.nodeType !== ELEMENT_NODE) continue;
    if (child.hasAttribute?.(attribute)) return child;
    const found = firstElementWith(child, attribute);
    if (found) return found;
  }
  return null;
}

/**
 * Alle Elemente unter einem Knoten mit einem Attributwert
 * (Dokumentreihenfolge), etwa die Einträge eines Menüs (role="menuitem").
 * @param {Node|null} root
 * @param {string} attribute
 * @param {string} value
 * @returns {Element[]}
 */
export function elementsWith(root, attribute, value, found = []) {
  for (const child of root?.childNodes ?? []) {
    if (child.nodeType !== ELEMENT_NODE) continue;
    if (child.getAttribute?.(attribute) === value) found.push(child);
    elementsWith(child, attribute, value, found);
  }
  return found;
}

/**
 * Lage eines Elements im Inhalt eines scrollenden Bereichs: Abstand seines
 * Anfangs zum Anfang des Inhalts (nicht des sichtbaren Ausschnitts) und
 * seine Höhe.
 * @param {{scrollTop: number, getBoundingClientRect: Function}} container
 * @param {{getBoundingClientRect: Function}} element
 * @returns {{offset: number, height: number}}
 */
function offsetInScroller(container, element) {
  const box = container.getBoundingClientRect();
  const target = element.getBoundingClientRect();
  return {
    offset: target.top - box.top + (container.scrollTop || 0),
    height: target.height,
  };
}

/** Scrollposition: gerundet, nie unter 0, 0 ohne messbare Lage. */
const scrollPosition = (value) =>
  Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;

/**
 * Scrollposition eines Bereichs, bei der der Anfang eines Elements darin
 * oben steht, mit etwas Abstand – nur der Bereich scrollt, nicht die Seite
 * (Sprung zur bewerteten Antwort, Nachtrag N2).
 * @param {{scrollTop: number, getBoundingClientRect: Function}} container
 * @param {{getBoundingClientRect: Function}} element
 * @param {number} [margin]
 * @returns {number}
 */
export function startScrollTop(container, element, margin = 16) {
  return scrollPosition(offsetInScroller(container, element).offset - margin);
}

/**
 * Scrollposition eines Bereichs, bei der ein Element darin ganz zu sehen
 * ist, mit möglichst wenig Bewegung – wie scrollIntoView „nearest“, aber nur
 * für diesen Bereich: Die Seite und andere scrollende Vorfahren bleiben
 * stehen (Fixliste 7.22-rc11, K11: scrollIntoView scrollte beim Blättern
 * die Seite mit, solange der Arbeitsbereich noch nicht oben anlag). Steht
 * das Element schon ganz im Ausschnitt, bleibt die Position. Liegt es
 * darüber (oder ist es höher als der Ausschnitt), kommt sein Anfang mit
 * marginTop Abstand nach oben; liegt es darunter, sein Ende mit
 * marginBottom Abstand nach unten.
 * @param {{scrollTop: number, clientHeight: number, getBoundingClientRect: Function}} container
 * @param {{getBoundingClientRect: Function}} element
 * @param {{marginTop?: number, marginBottom?: number}} [margins]
 * @returns {number}
 */
export function nearestScrollTop(
  container,
  element,
  { marginTop = 0, marginBottom = 0 } = {}
) {
  const { offset, height } = offsetInScroller(container, element);
  const current = container.scrollTop || 0;
  const view = container.clientHeight || 0;
  const start = offset - marginTop;
  const end = offset + height + marginBottom;
  if (start < current || end - start > view) return scrollPosition(start);
  if (end > current + view) return scrollPosition(end - view);
  return scrollPosition(current);
}

/**
 * Scrollposition eines Bereichs, bei der ein Element darin mittig steht –
 * nur der Bereich scrollt, nicht die Seite (anders als scrollIntoView).
 * @param {{scrollTop: number, clientHeight: number, getBoundingClientRect: Function}} container
 * @param {{getBoundingClientRect: Function}} element
 * @returns {number}
 */
export function centeredScrollTop(container, element) {
  const { offset, height } = offsetInScroller(container, element);
  return scrollPosition(offset - ((container.clientHeight || 0) - height) / 2);
}
