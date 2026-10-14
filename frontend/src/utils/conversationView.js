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
 * Ab dieser Breite steht das Panel neben der Liste (Tailwind lg), darunter
 * ist es ein Vollbild.
 */
export const WIDE_QUERY = "(min-width: 1024px)";

/**
 * Breiter Bildschirm (Panel neben der Liste)? false ohne Fenster oder ohne
 * matchMedia.
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

// Abstand zum schwebenden Benutzermenü oben rechts („KI“, bis 72 px unter
// dem oberen Fensterrand) – an einer Stelle (Fixliste 3, S4). Der Bereich der
// Einstellungsseiten beginnt ab md 16 px unter dem Fensterrand und endet
// 16 px über dem unteren; das Panel klebt ab lg 64 px unter seinem oberen
// Rand (Fixliste 2, B4).
export const AVATAR_CLEARANCE = {
  // Seitenpanel ab lg: klebt unter dem Benutzermenü; scroll-mt: so weit
  // bringt scrollIntoView es nach oben (V8)
  panel: "lg:sticky lg:top-16 lg:scroll-mt-16 lg:max-h-[calc(100vh-112px)]",
  // Sprungziel „Liste“ (Säule, Verweis, Link): Überschrift und Werkzeugleiste
  // landen unter dem Benutzermenü, der Export-Knopf bleibt frei (Fixliste 3,
  // V2)
  jumpTarget: "scroll-mt-20",
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
};
/** Oberkante des klebenden Panels im Fenster (16 px Rand + lg:top-16). */
export const PANEL_STUCK_TOP = 80;
/** Abstand der Unterkante des Panels zum Fensterrand (16 + 16 px). */
export const PANEL_BOTTOM_GAP = 32;
/** So niedrig wird das Panel nie, auch wenn es weit unten steht. */
export const PANEL_MIN_HEIGHT = 240;
/**
 * Sichtbar müssen beim Öffnen mindestens so viele Pixel des Panels sein –
 * sonst holt die Ansicht es nach oben (Fixliste 3, V8).
 */
export const PANEL_MIN_VISIBLE = 320;
/**
 * So viel Verlauf bleibt mindestens zwischen Kopf und Fußzeile sichtbar,
 * auch wenn das Panel dafür über die Mindesthöhe wächst (Fixliste 5, S5).
 */
export const PANEL_MIN_BODY = 64;

/**
 * Mindesthöhe des Panels aus Kopf und Fußzeile: Kopf + Fußzeile +
 * PANEL_MIN_BODY + Rahmen (2 px). Die Fußzeile bleibt so in jeder Höhe
 * innerhalb des Panelrahmens – nur der Verlauf dazwischen scrollt
 * (Fixliste 5, S5). 0 ohne gemessenen Kopf.
 * @param {number} [headHeight] - Höhe des Kopfs (px)
 * @param {number} [footerHeight] - Höhe der Fußzeile (px; fehlt sie, 0)
 * @returns {number}
 */
export function panelChromeHeight(headHeight, footerHeight) {
  if (!Number.isFinite(headHeight) || headHeight <= 0) return 0;
  const footer = Number.isFinite(footerHeight) ? footerHeight : 0;
  return Math.ceil(headHeight + footer + PANEL_MIN_BODY + 2);
}

/**
 * Höhe des Seitenpanels ab lg (Fixliste 3, V3/V8): Es endet über dem unteren
 * Fensterrand, wo immer es gerade steht – oben klebend (PANEL_STUCK_TOP) oder
 * tiefer, solange die Seite noch nicht so weit gescrollt ist (etwa direkt
 * nach dem Sprung zur Liste). reveal: Beim Öffnen ist zu wenig davon zu
 * sehen.
 *
 * containerBottom: Unterkante des Bereichs, in dem das Panel klebt (Liste
 * und Panel). Ein klebendes Element verlässt ihn nie – reicht er nicht bis
 * PANEL_STUCK_TOP + Höhe, schiebt der Browser das Panel nach oben unter das
 * Benutzermenü. Das geschieht am Seitenende: Unter dem Bereich liegen dann
 * noch 64 px Rand (24 + 24 + 16), nicht 32. Das Panel endet deshalb auch
 * über dieser Kante und bleibt bei PANEL_STUCK_TOP (Fixliste 4, V3).
 *
 * minHeight: Kopf und Fußzeile mit einem Rest Verlauf (panelChromeHeight) –
 * darunter wird das Panel nie, auch nicht an der Mindesthöhe; sonst läge die
 * Fußzeile außerhalb des Panelrahmens (Fixliste 5, S5).
 * @param {number} top - Oberkante des Panels im Fenster (px)
 * @param {number} viewportHeight - Höhe des Fensters (px)
 * @param {number} [containerBottom] - Unterkante des Bereichs im Fenster
 *   (px); ohne gültigen Wert ohne diese Grenze
 * @param {number} [minHeight] - Mindesthöhe aus Kopf und Fußzeile (px)
 * @returns {{maxHeight: number, reveal: boolean}|null} - null ohne gültige Maße
 */
export function panelFit(top, viewportHeight, containerBottom, minHeight = 0) {
  if (!Number.isFinite(top) || !Number.isFinite(viewportHeight)) return null;
  const visibleTop = Math.max(top, PANEL_STUCK_TOP);
  const bottom = Math.min(
    viewportHeight - PANEL_BOTTOM_GAP,
    Number.isFinite(containerBottom) ? containerBottom : Infinity
  );
  return {
    maxHeight: Math.max(
      PANEL_MIN_HEIGHT,
      Number.isFinite(minHeight) ? minHeight : 0,
      Math.round(bottom - visibleTop)
    ),
    reveal: viewportHeight - top < PANEL_MIN_VISIBLE,
  };
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

/**
 * Per Link geöffnete Zeile in Sicht (Fixliste 6, K5): Liegt die markierte
 * Zeile der Liste (aria-current) nach dem Sprung zur Überschrift außerhalb
 * des freien Bereichs – unter dem Fensterrand (abzüglich PANEL_BOTTOM_GAP)
 * oder über PANEL_STUCK_TOP –, scrollt die Seite gerade so weit, dass sie
 * sichtbar ist (block „nearest“; Abstand über scroll-margin der Zeile). Die
 * Liste hat keinen eigenen Scrollbereich, das Panel klebt ab lg oben
 * (lg:sticky) und bleibt so ganz zu sehen; nur die Überschrift wandert aus
 * dem Fenster. Steht die Zeile schon im Bild, bleibt alles, wie es ist.
 * @param {Element|null} root - Bereich der Liste
 * @param {number} [viewportHeight] - Höhe des Fensters (px)
 * @returns {boolean} - true, wenn gescrollt wurde
 */
export function revealMarkedRow(root, viewportHeight) {
  const height =
    viewportHeight ??
    (typeof window !== "undefined" ? window.innerHeight : undefined);
  if (!root || !Number.isFinite(height)) return false;
  const row = elementsWith(root, "aria-current", "true").find((element) =>
    element.hasAttribute?.("data-conversation-row")
  );
  const rect = row?.getBoundingClientRect?.();
  if (!rect || !Number.isFinite(rect.top) || !Number.isFinite(rect.bottom))
    return false;
  if (rect.top >= PANEL_STUCK_TOP && rect.bottom <= height - PANEL_BOTTOM_GAP)
    return false;
  row.scrollIntoView?.({ block: "nearest" });
  return true;
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
 * Scrollposition eines Bereichs, bei der ein Element darin mittig steht –
 * nur der Bereich scrollt, nicht die Seite (anders als scrollIntoView).
 * @param {{scrollTop: number, clientHeight: number, getBoundingClientRect: Function}} container
 * @param {{getBoundingClientRect: Function}} element
 * @returns {number}
 */
export function centeredScrollTop(container, element) {
  const box = container.getBoundingClientRect();
  const target = element.getBoundingClientRect();
  const offset = target.top - box.top + (container.scrollTop || 0);
  const centered = offset - ((container.clientHeight || 0) - target.height) / 2;
  return Number.isFinite(centered) ? Math.max(0, Math.round(centered)) : 0;
}
