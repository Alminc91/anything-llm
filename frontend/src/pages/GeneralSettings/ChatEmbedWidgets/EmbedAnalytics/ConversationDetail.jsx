import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CaretDown,
  CaretLeft,
  CaretUp,
  Copy,
  DotsThree,
  LinkSimple,
  Robot,
  ThumbsDown,
  ThumbsUp,
  Trash,
  X,
} from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";
import Embed from "@/models/embed";
import { formatDateShort, formatNumber } from "@/utils/analyticsTimeline";
import { formatDateForInput } from "@/utils/billingDate";
import showToast from "@/utils/toast";
import {
  FOCUS_RING,
  MUTED,
  RATING_BOX,
  RATING_FLASH,
  RATING_TINT,
  WORKSPACE,
  answerText,
  berlinDateTime,
  berlinTime,
  centeredScrollTop,
  conversationSummary,
  elementsWith,
  firstElementWith,
  hasVisibleHit,
  highlightParts,
  longDateLabel,
  outsidePeriod,
  ratingJumpIds,
  ratingOf,
  shortId,
  startScrollTop,
} from "@/utils/conversationView";
import MarkdownRenderer from "./MarkdownRenderer";
import { useConversationDeletion } from "./DeleteConversation";
import { useDismiss, useWide } from "./viewHooks";

// Konversationen-Ansicht: der Gesprächsverlauf einer Konversation – auf
// breiten Bildschirmen (ab lg) als rechte Spalte des Arbeitsbereichs neben
// der Liste (KIE-575: so hoch wie der Bereich, eigene Bildlaufleiste),
// darunter als eigene Vollbildansicht mit „‹ Konversationen". Kopf (erste
// Frage, Datum, Zeitspanne, Zahl der Fragen, Bewertungen, vorherige/nächste,
// ⋯, ✕) und Fußzeile (gekürzte Kennung, Löschen) bleiben stehen; dazwischen
// scrollt der Verlauf. Fragen als Sprechblase, Antworten über den
// MarkdownRenderer wie bisher, die Bewertung direkt unter der bewerteten
// Antwort.

// Schaltflächen im Kopf: mobil 44 px hoch, ab lg kompakter.
// Bei Tastaturbedienung der Fokusring der Seite statt des Browser-Rings
// (Nachtrag N3) – für ‹ ›, ⋯, ✕ und „‹ Konversationen“ gleich.
const ICON_BUTTON = `grid h-11 w-11 shrink-0 place-items-center rounded-lg ${MUTED} transition-colors hover:bg-white/10 hover:text-theme-text-primary disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent light:hover:bg-black/5 lg:h-9 lg:w-9 ${FOCUS_RING}`;
// Wie lange eine angesprungene Antwort hervorgehoben bleibt (N2 a)
const RATING_FLASH_MS = 1500;
// Trenner „·“ in der Zeile unter der Frage: VOR jedem Teil, in einem 16 px
// breiten Kästchen. Die Zeile ist um diese 16 px nach links verschoben und
// wird am Rand abgeschnitten (META_LINE) – so verschwindet der Trenner am
// Anfang jeder Zeile, und keine Zeile endet auf „·“ (Fixliste 2 B9,
// Fixliste 3 V5).
// items-baseline: Teile unterschiedlicher Höhe stehen auf derselben
// Grundlinie. Die Sprung-Schaltflächen (N2 a) stehen seit rc3 in einer
// eigenen Zeile darunter (RATING_ROW).
const META_LINE = "-ml-4 flex flex-wrap items-baseline gap-y-0.5";
const META_ITEM =
  "whitespace-nowrap before:inline-block before:w-4 before:text-center before:text-[color:var(--theme-analytics-text-muted)] before:content-['·']";
// Die Sprung-Schaltflächen zu den Bewertungen (N2 a) in einer gemeinsamen
// eigenen Zeile unter der Meta-Zeile (rc3, Opus Low 2): Sie brechen nur
// gemeinsam um – nie bleibt eine Pille allein in einer Folgezeile –, und
// mit kurzem Text samt Daumen passen beide auch mobil (390 px) in eine
// 44 px hohe Zeile.
const RATING_ROW = "flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px]";

/**
 * Text mit hervorgehobenen Treffern der Suche – als Text, nie als HTML.
 * @param {{text: string, term: string}} props
 */
export function HighlightedText({ text, term }) {
  return highlightParts(text, term).map((part, index) =>
    part.hit ? (
      <mark key={index} data-search-hit="">
        {part.text}
      </mark>
    ) : (
      part.text
    )
  );
}

/**
 * Zeitspanne einer Konversation: „07:47–07:48 Uhr", über mehrere Tage
 * „09.10. 08:25 – 13.10. 07:48 Uhr".
 */
function timeSpan(startedAt, lastAt, t) {
  const from = berlinTime(startedAt);
  const to = berlinTime(lastAt);
  const fromDay = formatDateForInput(startedAt);
  const toDay = formatDateForInput(lastAt);
  if (fromDay === toDay)
    return from === to
      ? t("embed-analytics.panel.time", { time: from })
      : t("embed-analytics.panel.span", { from, to });
  return t("embed-analytics.panel.span-days", {
    from: `${formatDateShort(fromDay)} ${from}`,
    to: `${formatDateShort(toDay)} ${to}`,
  });
}

/**
 * Bleibt bedienbar, auch wenn das Vollbild den Rest inert macht: Meldungen
 * (ToastContainer, .Toastify) und Dialoge in Portalen (aria-modal, etwa die
 * Lösch-Rückfrage) – Fixliste 2, S3.
 * @param {Element} element
 * @returns {boolean}
 */
function keepsInteractive(element) {
  const classes = String(element.getAttribute?.("class") ?? "").split(/\s+/);
  if (classes.includes("Toastify")) return true;
  if (element.getAttribute?.("aria-modal") === "true") return true;
  return elementsWith(element, "aria-modal", "true").length > 0;
}

/**
 * Vollbild (unter lg): Alles außer dem Panel ist inert und für Screenreader
 * verborgen – die Geschwister jedes Vorfahren, außer Meldungen und Dialogen
 * (keepsInteractive). Beim Schließen wird der vorige Zustand
 * wiederhergestellt.
 * @param {{current: Element|null}} ref
 * @param {boolean} active
 */
function useInertOutside(ref, active) {
  useEffect(() => {
    if (!active || !ref.current) return;
    const changed = [];
    const body = ref.current.ownerDocument?.body;
    for (
      let node = ref.current;
      node?.parentNode && node !== body;
      node = node.parentNode
    ) {
      for (const sibling of node.parentNode.childNodes) {
        if (sibling === node || sibling.nodeType !== 1) continue;
        if (sibling.hasAttribute("inert") || keepsInteractive(sibling))
          continue;
        changed.push([sibling, sibling.getAttribute("aria-hidden")]);
        sibling.setAttribute("inert", "");
        sibling.setAttribute("aria-hidden", "true");
      }
    }
    return () => {
      for (const [element, ariaHidden] of changed) {
        element.removeAttribute("inert");
        if (ariaHidden === null) element.removeAttribute("aria-hidden");
        else element.setAttribute("aria-hidden", ariaHidden);
      }
    };
  }, [ref, active]);
}

/**
 * @param {Object} props
 * @param {number} props.embedId
 * @param {number} props.chatId - id einer Zeile der Konversation (Adresse)
 * @param {object|null} props.row - Eintrag der Liste, falls die Konversation
 *   dort steht
 * @param {string} props.search - aktiver Suchbegriff (hervorgehoben)
 * @param {string|null} props.fromDay - Zeitraum der Liste: Kalendertage
 *   (null = „Gesamt“), wie die Liste sie dem Server sendet
 * @param {string|null} props.toDay
 * @param {boolean} [props.searchWholeConversation] - Die Suche der Liste
 *   prüft die ganze Konversation (Abschnitt aus dem Diagramm), nicht nur die
 *   Nachrichten im Zeitraum
 * @param {boolean} props.canPrevious
 * @param {boolean} props.canNext
 * @param {string|null} [props.navigationHint] - Hinweis zum Blättern:
 *   warum vorherige/nächste fehlen (per Link geöffnet, nicht in der
 *   geladenen Liste) oder dass „Nächste“ am Ende der Liste nicht nachladen
 *   konnte (der Knopf versucht es erneut)
 * @param {(direction: -1|1) => void} props.onNavigate
 * @param {() => void} props.onClose
 * @param {(result: {deleted: boolean}) => void} props.onDeleted
 * @param {(summary: {key: string, outside: boolean}|null) => void} [props.onLoaded] -
 *   die geladene Konversation (Schlüssel für die Markierung in der Liste;
 *   outside: keine Nachricht im Zeitraum, sie kann dort nicht stehen)
 * @param {(chatId: number) => string} props.linkOf - Adresse der Konversation
 * @param {boolean} [props.openedByLink] - per Link geöffnet, seither keine
 *   andere Konversation: Das Vollbild setzt den Fokus dann ohne sichtbaren
 *   Ring (Fixliste 9 A4, Nachtrag N3)
 */
export default function ConversationDetail({
  embedId,
  chatId,
  row = null,
  search = "",
  fromDay = null,
  toDay = null,
  searchWholeConversation = false,
  canPrevious = false,
  canNext = false,
  navigationHint = null,
  onNavigate = () => {},
  onClose = () => {},
  onDeleted = () => {},
  onLoaded = () => {},
  linkOf = () => "",
  openedByLink = false,
}) {
  const { t } = useTranslation();
  // { chatId, reload, messages, status } – zu genau einer Konversation;
  // status "ok" | "not-found" (403/404) | "failed" (500, Netzfehler)
  const [detail, setDetail] = useState({
    chatId: null,
    reload: 0,
    messages: [],
    status: "ok",
  });
  const [reload, setReload] = useState(0);
  // Das Menü „⋯" gehört zu einer Konversation: Blättern schließt es.
  const [menuFor, setMenuFor] = useState(null);
  const menuOpen = menuFor !== null && menuFor === chatId;
  const setMenuOpen = useCallback(
    (open) => setMenuFor(open ? chatId : null),
    [chatId]
  );
  const panelRef = useRef(null);
  const bodyRef = useRef(null);
  const menuRef = useRef(null);
  const menuButtonRef = useRef(null);
  const backRef = useRef(null);
  const wide = useWide();
  // „‹ Konversationen“ ohne Fokusring nur, solange die per Link geöffnete
  // Konversation zu sehen ist und der Fokus den Knopf noch nicht verlassen
  // hat (N3) – danach der Ring der Seite. Eine Quelle für Klasse und Fokus:
  // Das Panel bleibt beim Blättern eingehängt, openedByLink wird dann false
  // (Review 7.21.1).
  const [backLeft, setBackLeft] = useState(false);
  const quietBack = openedByLink && !backLeft;
  // Für den Fokus beim Wechsel ins Vollbild (unten): der aktuelle Stand,
  // ohne dass ein Wechsel ihn neu setzt. Vor jenem Effekt aktualisiert.
  const quietBackRef = useRef(quietBack);
  useEffect(() => {
    quietBackRef.current = quietBack;
  }, [quietBack]);

  useEffect(() => {
    let ignore = false;
    async function load() {
      const answer = await Embed.getConversationDetails(embedId, chatId);
      if (ignore) return;
      setDetail({
        chatId,
        reload,
        messages:
          answer?.success && Array.isArray(answer.messages)
            ? answer.messages
            : [],
        status: answer?.success
          ? "ok"
          : answer?.status === 403 || answer?.status === 404
            ? "not-found"
            : "failed",
      });
    }
    load();
    return () => {
      ignore = true;
    };
  }, [embedId, chatId, reload]);

  const loaded = detail.chatId === chatId && detail.reload === reload;
  const messages = loaded ? detail.messages : [];
  const summary =
    loaded && detail.status === "ok" ? conversationSummary(messages) : null;
  const failed = loaded && detail.status === "failed";
  const notFound =
    loaded &&
    (detail.status === "not-found" ||
      (detail.status === "ok" && !summary && !row));
  const ready = loaded && detail.status === "ok" && !notFound;
  const outside = ready && outsidePeriod(messages, { fromDay, toDay });

  const summaryKey = summary?.key ?? null;
  useEffect(() => {
    if (loaded) onLoaded(summaryKey ? { key: summaryKey, outside } : null);
  }, [loaded, summaryKey, outside, onLoaded]);

  // Kopf: Steht die Konversation in der Liste, zählt er dieselben Zeilen wie
  // ihre Zeile (im Zeitraum, einsehbar). Sonst (per Link, außerhalb des
  // Zeitraums) die angezeigten Nachrichten.
  const firstListed = row
    ? messages.find((message) => message.id === row.first_chat_id)
    : null;
  const head = notFound
    ? null
    : row
      ? {
          firstQuestion: firstListed?.prompt ?? row.preview ?? "",
          startedAt: row.started_at,
          lastAt: row.last_message_at,
          questions: row.message_count,
          positive: row.positive_count,
          negative: row.negative_count,
          conversationId: row.conversation_id,
        }
      : summary;
  const deletable =
    head && ready
      ? {
          first_chat_id: row?.first_chat_id ?? chatId,
          preview: head.firstQuestion,
          message_count: head.questions,
        }
      : null;

  // Bei einem Ladefehler bleibt „⋯" bedienbar: Link (und, steht die
  // Konversation in der Liste, Kennung) lassen sich kopieren – Löschen nicht
  // (Fixliste 2, S4).
  const menuAvailable = !!deletable || failed;

  const deletion = useConversationDeletion({
    embedId,
    // Vorschau im Hintergrund, schon während der Verlauf lädt (N1)
    previewChatId: chatId,
    conversation: deletable,
    onDeleted: (result) => {
      if (!result.deleted) setReload((count) => count + 1);
      onDeleted(result);
    },
  });

  // Treffer der Suche: zum ersten scrollen; sonst beim Wechsel nach oben.
  // Nur der Verlauf scrollt – nicht die Seite mit der Liste (AK-4).
  useEffect(() => {
    if (!loaded) return;
    const body = bodyRef.current;
    if (!body) return;
    const hit = firstElementWith(body, "data-search-hit");
    body.scrollTop = hit ? centeredScrollTop(body, hit) : 0;
  }, [loaded, chatId, search]);

  // Sprung zur nächsten bewerteten Antwort (Nachtrag N2 a): Die Schaltflächen
  // „N negativ/positiv bewertet“ im Kopf scrollen den Verlauf nacheinander
  // zu jeder Antwort dieses Tons (nach der letzten wieder zur ersten), setzen
  // den Fokus darauf (ohne zweites Scrollen) und heben sie kurz hervor. Nur
  // der Verlauf scrollt, nicht die Seite (AK-4).
  // Ziele sind die Antworten, die auch die Liste zählt: Steht die
  // Konversation in der Liste, nur die im Zeitraum – der Verlauf zeigt die
  // ganze Konversation (Review 7.21.1). Mit gewählter Säule zählt der Server
  // die ganze Konversation (startedBetween), dann alle (rc3 F02) – wie die
  // Suche (hiddenHit).
  const periodOnly = !!row && !searchWholeConversation;
  const jumpIds = useMemo(() => {
    const period = periodOnly ? { fromDay, toDay } : {};
    return {
      negative: ratingJumpIds(messages, "negative", period),
      positive: ratingJumpIds(messages, "positive", period),
    };
  }, [messages, periodOnly, fromDay, toDay]);
  // Zahl und Sichtbarkeit der Schaltflächen aus EINER Quelle (rc3 F06):
  // Sobald der Verlauf geladen ist, aus den Sprungzielen – so springt jeder
  // Klick zu einer der gezählten Antworten, auch wenn sich Bewertungen seit
  // dem Laden der Liste geändert haben. Vorher die Zahl aus der Listenzeile
  // (bzw. dem Kopf), damit nichts umspringt, solange der Verlauf lädt.
  const ratingCounts = ready
    ? { negative: jumpIds.negative.length, positive: jumpIds.positive.length }
    : { negative: head?.negative ?? 0, positive: head?.positive ?? 0 };
  const jumps = useRef({ chatId: null, negative: -1, positive: -1 });
  const [flash, setFlash] = useState(null); // { chatId, id } | null
  useEffect(() => {
    if (!flash) return;
    const timer = setTimeout(() => setFlash(null), RATING_FLASH_MS);
    return () => clearTimeout(timer);
  }, [flash]);
  const jumpTo = (kind) => {
    const body = bodyRef.current;
    const ids = jumpIds[kind];
    const targets = elementsWith(body, "data-rated", kind).filter((element) =>
      ids.includes(Number(element.getAttribute("data-message-id")))
    );
    if (!body || targets.length === 0) return;
    if (jumps.current.chatId !== chatId)
      jumps.current = { chatId, negative: -1, positive: -1 };
    const index = (jumps.current[kind] + 1) % targets.length;
    jumps.current[kind] = index;
    const target = targets[index];
    body.scrollTop = startScrollTop(body, target);
    firstElementWith(target, "data-answer-row")?.focus?.({
      preventScroll: true,
    });
    setFlash({
      chatId,
      id: Number(target.getAttribute("data-message-id")),
    });
  };
  const flashId = flash?.chatId === chatId ? flash.id : null;

  // Escape schließt das Vollbild (unter lg) – nicht, wenn ein Menü oder eine
  // Rückfrage es schon für sich genommen hat (defaultPrevented: Sie lauschen
  // am Dokument, das Panel am Fenster, also danach) oder in einem
  // Eingabefeld getippt wird. Ab lg ist der Verlauf eine Spalte des
  // Arbeitsbereichs, die nur ✕ schließt (KIE-575, NAK-3): Escape tut dort
  // nichts.
  useEffect(() => {
    if (wide) return;
    function handleKeyDown(event) {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const tag = String(event.target?.tagName ?? "").toUpperCase();
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      onClose();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, wide]);

  // Vollbild (unter lg): Fokus in den Kopf, der Hintergrund ist inert. Den
  // Fokus zurück auf die Zeile setzt die Liste.
  // Ohne sichtbaren Ring nur beim Öffnen per Link (Fixliste 9 A4, finale
  // Kontrolle L1, Nachtrag N3): Dann gab es noch keine Eingabe – der Browser
  // zählte den Fokus als Tastaturfokus (:focus-visible) und zeichnete seinen
  // orangen Ring um „‹ Konversationen". Browser ohne focusVisible-Option
  // zeigen dann die dezente Tönung des Knopfs (quietBack). Aus der Liste
  // geöffnet (Klick, Enter) bleibt der Fokus so sichtbar, wie der Browser
  // ihn zeigt – bei Tastaturbedienung mit dem Fokusring der Seite.
  useEffect(() => {
    if (wide) return;
    if (quietBackRef.current) backRef.current?.focus?.({ focusVisible: false });
    else backRef.current?.focus?.();
  }, [wide]);
  useInertOutside(panelRef, !wide);
  // Ab lg füllt das Panel die rechte Spalte des Arbeitsbereichs (KIE-575):
  // keine angepasste Höhe, kein Kleben, kein Holen nach oben – die Seite
  // bewegt sich beim Öffnen nicht (NAK-1).

  // Menü „⋯": Klick außerhalb oder Escape schließt (Escape gibt den Fokus an
  // die Schaltfläche zurück – useDismiss, wie Exportmenü und
  // Widget-Auswahl); beim Öffnen steht der Fokus auf dem ersten Eintrag,
  // ↑/↓, Pos1/Ende wechseln (Fixliste Punkt 26).
  const closeMenu = useCallback(() => setMenuOpen(false), [setMenuOpen]);
  const menuItemsOf = useCallback(
    () => elementsWith(menuRef.current, "role", "menuitem"),
    []
  );
  useDismiss(menuRef, menuOpen, closeMenu, { focusRef: menuButtonRef });
  useEffect(() => {
    if (menuOpen) menuItemsOf()[0]?.focus?.();
  }, [menuOpen, menuItemsOf]);
  const handleMenuKeyDown = (event) => {
    const items = menuItemsOf();
    const index = items.indexOf(event.target);
    const focus = (next) => {
      event.preventDefault();
      items[(next + items.length) % items.length]?.focus?.();
    };
    if (event.key === "ArrowDown") focus(index + 1);
    else if (event.key === "ArrowUp") focus(index - 1);
    else if (event.key === "Home") focus(0);
    else if (event.key === "End") focus(items.length - 1);
    else if (event.key === "Tab") closeMenu();
  };
  // Beim Öffnen frischt das Menü die Lösch-Vorschau im Hintergrund auf
  // (Review 7.21.1): Hat der Besucher inzwischen eine weitere Konversation
  // begonnen, kommt „Alle Konversationen dieses Besuchers löschen“ unten
  // hinzu (N1).
  const toggleMenu = () => {
    if (!menuOpen) deletion.refreshPreview();
    setMenuOpen(!menuOpen);
  };

  const conversationId = head?.conversationId ?? null;
  const copy = useCallback(
    async (text, successKey) => {
      // Erfolg erst melden, wenn der Text in der Zwischenablage ist – der
      // Browser kann das Kopieren ablehnen, ohne HTTPS fehlt
      // navigator.clipboard.
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        showToast(t("code-snippet-modal.copy-failed"), "error");
        return;
      }
      showToast(t(successKey), "success");
    },
    [t]
  );
  const copyId = () => {
    setMenuOpen(false);
    if (conversationId) copy(conversationId, "embed-analytics.panel.id-copied");
  };
  const copyLink = () => {
    setMenuOpen(false);
    copy(linkOf(chatId), "embed-analytics.panel.link-copied");
  };
  const openDelete = (kind) => {
    setMenuOpen(false);
    deletion.openDialog(kind);
  };

  // Der Begriff trifft nur Unsichtbares (Link-Adresse, HTML, <think>) –
  // die Suche des Servers liest den Antworttext, wie er gespeichert ist.
  // Geprüft werden die Nachrichten, die auch der Server durchsucht hat (im
  // Zeitraum bzw. mit Abschnitt die ganze Konversation); memoisiert – das
  // Lesen der Antworten (JSON) läuft nicht bei jedem Rendern (S7).
  const hiddenHit = useMemo(
    () =>
      ready &&
      !!search &&
      !!row &&
      !hasVisibleHit(
        messages,
        search,
        searchWholeConversation ? {} : { fromDay, toDay }
      ),
    [ready, search, row, messages, searchWholeConversation, fromDay, toDay]
  );

  // Feste Reihenfolge (Fixliste 2, R8): „Konversation löschen" immer vor
  // „Alle Konversationen dieses Besuchers löschen". Der zweite Eintrag steht
  // nur da, wenn die Vorschau weitere Konversationen kennt (Nachtrag N1):
  // Sie lädt beim Öffnen des Panels, das Menü erscheint so gleich im
  // Endzustand. Lädt sie beim Öffnen des Menüs noch (oder kennt das
  // Auffrischen eine neue Konversation), kommt der Eintrag danach als
  // letzter hinzu – kein Platzhalter, der kurz aufblitzt; nichts schiebt
  // sich vor einen anderen Eintrag, der Fokus bleibt, wo er ist. Einmal im
  // offenen Menü gezeigt, bleibt er bis zum Schließen (nie angezeigt und
  // wieder entfernt); das Löschen prüft den Stand ohnehin (Fixliste 7, F10).
  const [visitorShownFor, setVisitorShownFor] = useState(null);
  const visitorEntry =
    !!deletable &&
    (deletion.offerVisitor || (menuOpen && visitorShownFor === chatId));
  if (menuOpen && visitorEntry && visitorShownFor !== chatId)
    setVisitorShownFor(chatId);
  else if (!menuOpen && visitorShownFor !== null) setVisitorShownFor(null);
  const menuItems = [
    conversationId && {
      id: "data-menu-copy-id",
      Icon: Copy,
      onClick: copyId,
      label: t("embed-analytics.panel.copy-id"),
    },
    {
      id: "data-menu-copy-link",
      Icon: LinkSimple,
      onClick: copyLink,
      label: t("embed-analytics.panel.copy-link"),
    },
    deletable && {
      id: "data-menu-delete",
      Icon: Trash,
      danger: true,
      onClick: () => openDelete("conversation"),
      label: t("embed-analytics.delete.conversation"),
    },
    visitorEntry && {
      id: "data-delete-visitor",
      Icon: Trash,
      danger: true,
      onClick: () => openDelete("visitor"),
      label: t("embed-analytics.delete.visitor"),
    },
  ].filter(Boolean);

  const headDay = head ? formatDateForInput(head.startedAt) : "";

  return (
    <aside
      ref={panelRef}
      data-conversation-panel=""
      aria-label={t("embed-analytics.panel.label")}
      aria-modal={wide ? undefined : "true"}
      role={wide ? undefined : "dialog"}
      // Ab lg die rechte Spalte des Arbeitsbereichs (KIE-575): im Fluss
      // statt klebend (relative: Bezug für absolut positionierte Teile
      // darin, etwa das Menü „⋯“ und Screenreader-Texte, die so im Panel
      // bleiben und die Seite nicht verlängern), so hoch wie der Bereich (der
      // Flex-Elternteil streckt sie), Breite nach WORKSPACE.panel; nur der
      // Verlauf darin scrollt.
      className={`fixed inset-0 z-50 flex flex-col bg-theme-bg-secondary lg:relative lg:inset-auto lg:z-auto ${WORKSPACE.panel} lg:overflow-hidden lg:rounded-xl lg:border lg:border-white/10 lg:bg-theme-bg-primary`}
    >
      {/* Kopf – bleibt beim Scrollen stehen */}
      <header
        data-panel-head=""
        className="flex shrink-0 flex-col gap-2 border-b border-white/10 px-2 pb-3 pt-2 light:border-gray-200 lg:px-5 lg:pt-4"
      >
        <div className="flex items-center justify-between gap-2">
          {/* mobil: zurück zur Liste */}
          <button
            type="button"
            ref={backRef}
            data-panel-back=""
            onClick={onClose}
            onBlur={() => setBackLeft(true)}
            className={`flex h-11 items-center gap-1 rounded-lg px-2 text-[15px] text-theme-text-primary hover:bg-white/10 light:hover:bg-black/5 lg:hidden ${
              quietBack
                ? "focus-visible:outline-none focus-visible:bg-white/10 light:focus-visible:bg-black/5"
                : FOCUS_RING
            }`}
          >
            <CaretLeft size={20} aria-hidden="true" />
            {t("embed-analytics.panel.back")}
          </button>
          {/* Datum neben den Schaltflächen erst ab xl: Von lg bis xl ist das
              Panel schmal (bei 1024 px 321 px) – dort brach „Dienstag,“ /
              „13.10.2026“ um. Das Datum steht dann (wie mobil) einzeilig in
              der Zeile unter der Frage (Fixliste 5, S5). */}
          <span
            data-panel-date=""
            className={`hidden whitespace-nowrap text-sm ${MUTED} xl:block`}
          >
            {longDateLabel(headDay)}
          </span>
          <span className="ml-auto flex items-center gap-1">
            <button
              type="button"
              data-panel-previous=""
              aria-label={t("embed-analytics.panel.previous")}
              title={t("embed-analytics.panel.previous")}
              disabled={!canPrevious}
              onClick={() => onNavigate(-1)}
              className={ICON_BUTTON}
            >
              <CaretUp size={18} aria-hidden="true" />
            </button>
            <button
              type="button"
              data-panel-next=""
              aria-label={t("embed-analytics.panel.next")}
              title={t("embed-analytics.panel.next")}
              disabled={!canNext}
              onClick={() => onNavigate(1)}
              className={ICON_BUTTON}
            >
              <CaretDown size={18} aria-hidden="true" />
            </button>
            <span className="relative" ref={menuRef}>
              <button
                type="button"
                ref={menuButtonRef}
                data-panel-menu-button=""
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                aria-label={t("embed-analytics.panel.more")}
                title={t("embed-analytics.panel.more")}
                disabled={!menuAvailable}
                onClick={toggleMenu}
                className={ICON_BUTTON}
              >
                <DotsThree size={20} weight="bold" aria-hidden="true" />
              </button>
              {menuOpen && menuAvailable && (
                <div
                  role="menu"
                  data-panel-menu=""
                  aria-label={t("embed-analytics.panel.more")}
                  onKeyDown={handleMenuKeyDown}
                  className="absolute right-0 top-full z-50 mt-1 min-w-[240px] overflow-hidden rounded-lg border border-white/10 bg-theme-bg-secondary py-1 shadow-xl light:border-gray-200"
                >
                  {menuItems.map(({ id, ...item }) => (
                    <MenuItem key={id} {...{ [id]: "" }} {...item} />
                  ))}
                </div>
              )}
            </span>
            <button
              type="button"
              data-panel-close=""
              aria-label={t("embed-analytics.panel.close")}
              title={t("embed-analytics.panel.close")}
              onClick={onClose}
              className={`${ICON_BUTTON} hidden lg:grid`}
            >
              <X size={18} aria-hidden="true" />
            </button>
          </span>
        </div>

        {head && (
          <div className="flex flex-col gap-1.5 px-2 lg:px-0">
            {/* Höchstens drei Zeilen (Fixliste 9, A5): Die erste Frage steht
                darunter ohnehin ganz in der Sprechblase; voll als title. */}
            <h3
              data-panel-question=""
              title={head.firstQuestion}
              className="line-clamp-3 break-words text-[17px] font-semibold leading-snug text-theme-text-primary lg:text-lg"
            >
              <HighlightedText text={head.firstQuestion} term={search} />
            </h3>
            {/* Teile mit dem Trenner davor (META_ITEM); der Rahmen schneidet
                ihn am Zeilenanfang ab – keine Zeile beginnt oder endet mit
                „·“ (B9, V5). */}
            <div className="overflow-hidden">
              <p
                data-panel-meta=""
                className={`${META_LINE} text-[13px] ${MUTED}`}
              >
                <span
                  data-meta-item=""
                  data-meta-date=""
                  className={`${META_ITEM} xl:hidden`}
                >
                  {longDateLabel(headDay)}
                </span>
                <span
                  data-meta-item=""
                  className={META_ITEM}
                  title={`${berlinDateTime(head.startedAt)} – ${berlinDateTime(head.lastAt)}`}
                >
                  {t("embed-analytics.rows.questions", {
                    count: head.questions,
                    formatted: formatNumber(head.questions),
                  })}
                </span>
                <span data-meta-item="" className={META_ITEM}>
                  {timeSpan(head.startedAt, head.lastAt, t)}
                </span>
              </p>
            </div>
            {/* Schaltflächen: zur nächsten so bewerteten Antwort (Nachtrag
                N2 a) – gemeinsam in einer eigenen Zeile (RATING_ROW, rc3);
                im Ton und mit dem Hintergrund der bewerteten Antworten.
                Mobil 44 px hoch (AK-9). */}
            {(ratingCounts.negative > 0 || ratingCounts.positive > 0) && (
              <div data-panel-ratings="" className={RATING_ROW}>
                {ratingCounts.negative > 0 && (
                  <RatingJump
                    kind="negative"
                    onJump={jumpTo}
                    title={t("embed-analytics.panel.jump-negative")}
                  >
                    {t("embed-analytics.panel.negative-count", {
                      count: ratingCounts.negative,
                      formatted: formatNumber(ratingCounts.negative),
                    })}
                  </RatingJump>
                )}
                {ratingCounts.positive > 0 && (
                  <RatingJump
                    kind="positive"
                    onJump={jumpTo}
                    title={t("embed-analytics.panel.jump-positive")}
                  >
                    {t("embed-analytics.panel.positive-count", {
                      count: ratingCounts.positive,
                      formatted: formatNumber(ratingCounts.positive),
                    })}
                  </RatingJump>
                )}
              </div>
            )}
            {outside && (
              <p
                data-panel-outside=""
                className="text-[13px] text-theme-text-primary"
              >
                {t("embed-analytics.panel.outside")}
              </p>
            )}
            {navigationHint && !outside && (
              <p
                data-panel-navigation-hint=""
                role="status"
                className={`text-[13px] ${MUTED}`}
              >
                {navigationHint}
              </p>
            )}
            {hiddenHit && (
              <p
                data-panel-hidden-hit=""
                className="text-[13px] text-theme-text-primary"
              >
                {t("embed-analytics.panel.hidden-hit", { term: search })}
              </p>
            )}
          </div>
        )}
      </header>

      {/* Verlauf – scrollt */}
      {/* Der Browser macht den scrollbaren Verlauf per Tab erreichbar:
          derselbe Fokusring wie im Kopf statt des Browser-Rings (rc3). */}
      <div
        ref={bodyRef}
        data-panel-body=""
        className={`min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 lg:px-5 ${FOCUS_RING}`}
      >
        {!loaded ? (
          <p className={`py-4 text-center text-sm ${MUTED}`}>
            {t("embed-analytics.loading")}
          </p>
        ) : failed ? (
          <div
            data-panel-load-error=""
            role="alert"
            className="flex flex-col items-start gap-3 py-4 text-sm text-theme-text-primary"
          >
            <p>{t("embed-analytics.panel.load-error")}</p>
            <button
              type="button"
              data-panel-retry=""
              onClick={() => setReload((count) => count + 1)}
              className="h-11 rounded-lg border border-white/10 px-4 text-sm text-theme-text-primary transition-colors hover:bg-white/5 light:border-gray-200 light:hover:bg-black/5 lg:h-9"
            >
              {t("embed-analytics.panel.retry")}
            </button>
          </div>
        ) : notFound ? (
          <p data-panel-not-found="" className={`py-4 text-sm ${MUTED}`}>
            {t("embed-analytics.panel.not-found")}
          </p>
        ) : messages.length === 0 ? (
          <p className={`py-4 text-center text-sm ${MUTED}`}>
            {t("embed-analytics.conversations.no-messages")}
          </p>
        ) : (
          <ol className="flex flex-col gap-5">
            {messages.map((message) => (
              <Message
                key={message.id}
                message={message}
                search={search}
                flash={flashId === message.id}
              />
            ))}
          </ol>
        )}
      </div>

      {/* Fußzeile: gekürzte Kennung (kopieren) und Löschen – immer eine
          Zeile: Reicht die Breite nicht (Panel bei 1024 px), wird die
          Kennung weiter gekürzt, „Konversation löschen“ bleibt ganz
          (Fixliste 5, S5). */}
      {deletable && (
        <footer
          data-conversation-actions=""
          className="flex shrink-0 items-center justify-between gap-2 border-t border-white/10 px-3 py-2 light:border-gray-200 lg:px-4"
        >
          <button
            type="button"
            data-panel-id=""
            onClick={copyId}
            title={t("embed-analytics.panel.copy-id")}
            className={`flex h-11 min-w-0 items-center gap-1.5 rounded-md px-2 text-xs ${MUTED} hover:bg-white/10 hover:text-theme-text-primary light:hover:bg-black/5 lg:h-8 ${FOCUS_RING}`}
          >
            <Copy size={13} aria-hidden="true" className="shrink-0" />
            <span className="truncate font-mono">
              {t("embed-analytics.panel.id", { id: shortId(conversationId) })}
            </span>
          </button>
          <button
            type="button"
            data-delete-conversation=""
            onClick={() => openDelete("conversation")}
            className={`flex h-11 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2 text-[13px] ${MUTED} transition-colors hover:bg-theme-button-delete-hover-bg hover:text-theme-button-delete-hover-text lg:h-8 ${FOCUS_RING}`}
          >
            <Trash size={14} aria-hidden="true" />
            {t("embed-analytics.delete.conversation")}
          </button>
        </footer>
      )}
      {deletion.dialog}
    </aside>
  );
}

/** Eintrag im Menü „⋯". */
function MenuItem({ Icon, label, onClick, danger = false, ...rest }) {
  return (
    <button
      type="button"
      role="menuitem"
      {...rest}
      onClick={onClick}
      className={`flex min-h-[44px] w-full items-center gap-2 px-3 py-2 text-left text-sm ${MUTED} transition-colors focus-visible:outline-none focus-visible:bg-white/10 light:focus-visible:bg-black/5 lg:min-h-0 ${
        danger
          ? "hover:bg-theme-button-delete-hover-bg hover:text-theme-button-delete-hover-text"
          : "hover:bg-white/5 hover:text-theme-text-primary light:hover:bg-black/5"
      }`}
    >
      <Icon size={15} aria-hidden="true" className="shrink-0" />
      {label}
    </button>
  );
}

/**
 * Eine Frage des Besuchers und die Antwort darauf, mit ihrer Bewertung.
 * memo: Tippen im Suchfeld rendert den Verlauf nicht neu, solange der
 * (verzögerte) Suchbegriff gleich bleibt.
 */
const Message = memo(function Message({ message, search, flash = false }) {
  const { t } = useTranslation();
  const answer = answerText(message.response);
  const rating = ratingOf(message);
  return (
    <li
      data-message=""
      data-message-id={message.id}
      data-rated={rating ?? undefined}
      className="flex flex-col gap-2.5"
    >
      <div className="flex flex-col items-end gap-1">
        <span
          className={`text-xs ${MUTED}`}
          title={berlinDateTime(message.createdAt)}
        >
          {t("embed-analytics.panel.visitor", {
            time: berlinTime(message.createdAt),
          })}
        </span>
        <div
          data-question=""
          className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-sm bg-theme-bg-chat-input px-3.5 py-2.5 text-sm leading-relaxed text-theme-text-primary"
        >
          <HighlightedText text={message.prompt} term={search} />
        </div>
      </div>
      {/* Antwort mit Bewertung: Bewertete Antworten tragen einen hauchzarten
          Hintergrund im Ton der Bewertung (Nachtrag N2 b). Er ragt über den
          Text hinaus (negativer Rand + Innenabstand, bei allen Antworten
          gleich) – der Verlauf verschiebt sich nicht. Ziel des Sprungs aus
          dem Kopf (tabIndex -1: per Programm fokussierbar, nicht per Tab).
          Während der kurzen Hervorhebung statt des Fokusrings: Beide setzen
          die Umrissfarbe, der Ring (:focus-visible nach Tastaturbedienung)
          überdeckte sonst den Ton der Bewertung (Review 7.21.1). */}
      <div
        data-answer-row=""
        tabIndex={rating ? -1 : undefined}
        data-rating-flash={flash ? "" : undefined}
        className={`-mx-2 -my-1.5 flex items-start gap-2.5 rounded-xl px-2 py-1.5 ${
          rating
            ? `${RATING_TINT[rating]} ${flash ? RATING_FLASH[rating] : FOCUS_RING}`
            : ""
        }`}
      >
        <span
          aria-hidden="true"
          className={`mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full bg-white/10 ${MUTED} light:bg-black/5`}
        >
          <Robot size={15} />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div
            data-answer=""
            className="analytics-bot-response prose prose-sm max-w-none break-words text-sm leading-relaxed text-theme-text-primary"
          >
            <MarkdownRenderer content={answer} highlight={search} />
          </div>
          <Rating message={message} search={search} />
        </div>
      </div>
    </li>
  );
});

// Ton der Sprung-Schaltflächen: wie die Bewertung unter der Antwort
const RATING_TEXT = {
  negative: "text-orange-300 light:text-orange-700",
  positive: "text-sky-300 light:text-sky-700",
};

/**
 * Schaltfläche im Kopf: „N negativ/positiv bewertet“ mit Daumen – springt
 * zur nächsten so bewerteten Antwort (Nachtrag N2 a). Der Text bleibt der
 * Name der Schaltfläche, title beschreibt den Sprung. Mobil 44 px hoch
 * (AK-9), ab lg kompakt; Ton und Hintergrund wie die bewerteten Antworten.
 * Zu sehen nur mit mindestens einem Ziel (rc3 F06) – deshalb nie gesperrt.
 */
function RatingJump({ kind, onJump, title, children }) {
  const Icon = kind === "negative" ? ThumbsDown : ThumbsUp;
  return (
    <button
      type="button"
      data-rating-jump={kind}
      title={title}
      onClick={() => onJump(kind)}
      className={`group inline-flex min-h-11 items-center whitespace-nowrap rounded-md lg:min-h-0 ${RATING_TEXT[kind]} ${FOCUS_RING}`}
    >
      <span
        className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 ${RATING_TINT[kind]}`}
      >
        <Icon size={13} aria-hidden="true" className="shrink-0" />
        <span className="underline decoration-dotted underline-offset-2 transition-colors group-hover:decoration-solid">
          {children}
        </span>
      </span>
    </button>
  );
}

/** Bewertung direkt unter der bewerteten Antwort (KIE-504/507). */
function Rating({ message, search }) {
  const { t } = useTranslation();
  const rating = ratingOf(message);
  if (rating === "positive")
    return (
      <span
        data-rating="positive"
        className="inline-flex items-center gap-1.5 self-start text-[13px] font-semibold text-sky-300 light:text-sky-700"
      >
        <ThumbsUp size={14} aria-hidden="true" />
        {t("embed-analytics.panel.positive")}
      </span>
    );
  if (rating !== "negative") return null;
  return (
    <div
      data-rating="negative"
      className={`flex flex-col gap-1.5 rounded-lg px-3 py-2.5 ${RATING_BOX}`}
    >
      <span className="flex items-center gap-1.5 text-[13px] font-semibold text-orange-300 light:text-orange-800">
        <ThumbsDown size={14} aria-hidden="true" />
        <span>
          {t("embed-analytics.panel.negative")}
          {message.feedbackReason && (
            <>
              {" · "}
              <HighlightedText text={message.feedbackReason} term={search} />
            </>
          )}
        </span>
      </span>
      {message.feedbackText && (
        <p
          data-rating-comment=""
          className="whitespace-pre-wrap break-words text-[13px] text-theme-text-primary"
        >
          {t("embed-analytics.panel.quote-open")}
          <HighlightedText text={message.feedbackText} term={search} />
          {t("embed-analytics.panel.quote-close")}
        </p>
      )}
    </div>
  );
}
