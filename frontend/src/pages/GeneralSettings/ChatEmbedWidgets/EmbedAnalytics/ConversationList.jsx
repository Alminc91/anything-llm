import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  CaretRight,
  MagnifyingGlass,
  ThumbsDown,
  ThumbsUp,
  X,
} from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";
import Embed from "@/models/embed";
import { formatNumber } from "@/utils/analyticsTimeline";
import { formatDateForInput } from "@/utils/billingDate";
import showToast from "@/utils/toast";
import {
  AVATAR_CLEARANCE,
  MUTED,
  SEARCH_MAX_LENGTH,
  berlinDateTime,
  berlinTime,
  conversationKey,
  dayGroupLabel,
  effectiveSearch,
  focusLost,
  groupByLastMessageDay,
  hasContentGap,
  isWide,
  searchLinkIssue,
  shortDayLabel,
  startedOnOtherDay,
} from "@/utils/conversationView";
import ConversationDetail from "./ConversationDetail";
import ExportMenu from "./ExportMenu";
import useConversationLocation from "./useConversationLocation";

// Konversationsliste der Ansicht „Konversationen": kompakte Zeilen, nach dem
// Tag der LETZTEN Nachricht gruppiert (Berliner Zeit) und danach sortiert –
// eine weitergeführte alte Konversation steht wieder oben. Ein Klick öffnet
// den Gesprächsverlauf: ab lg als Seitenpanel rechts (die Liste bleibt, wo
// sie ist), darunter als Vollbild. Geöffnete Konversation und Suche stehen in
// der Adresse (useConversationLocation).

const PAGE_SIZE = 20;
// Größte Seite, die der Server liefert (analytics/conversations)
const PAGE_MAX = 100;
// Per Link geöffnet, aber nicht unter den geladenen Konversationen: bis zu so
// vielen Zeilen lädt die Liste nach, um sie zu finden (vorherige/nächste) –
// in Seiten zu PAGE_MAX (Fixliste 3, S2).
const LINK_SEARCH_ROWS = 500;
// Höchstens so viele Anfragen stellt das automatische Nachladen (Link-Suche,
// „Nächste“ am Ende, Auffüllen nach dem Löschen) hintereinander – zusätzlich
// zum Abbruch, wenn eine Seite keine neue Zeile bringt (Fixliste 3, C1).
const AUTO_LOAD_ROUNDS = 30;
// Verzögerung der Suche nach der letzten Eingabe
const SEARCH_DELAY_MS = 300;

// KIE-508/527: die beiden exklusiven Feedback-Filter (ein Zustand:
// "all" | "negative" | "positive"), als Config statt Copy-Paste-Buttons.
const FEEDBACK_FILTERS = [
  {
    mode: "positive",
    Icon: ThumbsUp,
    labelKey: "embed-analytics.conversations.only-positive",
  },
  {
    mode: "negative",
    Icon: ThumbsDown,
    labelKey: "embed-analytics.conversations.only-negative",
  },
];

const EMPTY_STATE_KEYS = {
  all: "embed-analytics.no-conversations",
  negative: "embed-analytics.conversations.no-negative",
  positive: "embed-analytics.conversations.no-positive",
};

// Umschalter „Alle / Positiv bewertet / Negativ bewertet"
// Von sm bis xl etwas schmaler (px-2.5): Suche (≥ 240 px), Filter und Export
// passen so bei 1024 px neben dem Abstand zum Benutzermenü in eine Zeile
// (Fixliste 4, V5).
const SEGMENT_CLASS =
  "flex h-11 items-center gap-1.5 whitespace-nowrap rounded-md px-3 text-sm transition-colors sm:h-9 sm:px-2.5 xl:px-3";
const SEGMENT_ACTIVE =
  "bg-white/10 text-theme-text-primary font-medium light:bg-black/[0.07]";
// Gedämpfte Schrift wie die Kopfzeile: im hellen Theme #5f6368 statt
// --theme-text-secondary (#7a7d7e) – 5,4:1 auf dem Grund der Gruppe
// (#edf2fa) statt 3,7:1 (Fixliste 2, B2); im dunklen Theme gleich.
const SEGMENT_INACTIVE = `${MUTED} hover:text-theme-text-primary`;

/**
 * Markierung eines gesetzten Filters unter der Überschrift der Liste („Nur
 * …", „Filter: …", „Suche: …") – ✕ hebt ihn auf. Mit dem Filter verschwindet
 * die Markierung samt ✕; der Fokus geht dann an focusAfter (etwa ins
 * Suchfeld), nicht ins Leere (Fixliste 3, V9).
 * @param {{label: string, clearLabel: string, onClear: () => void, focusAfter?: () => void}} props
 *   (übrige Props, z. B. data-*, gehen an die Markierung)
 */
function FilterMark({ label, clearLabel, onClear, focusAfter, ...rest }) {
  return (
    <span
      {...rest}
      className="inline-flex max-w-full items-center rounded-full border border-white/10 bg-theme-settings-input-bg py-0.5 pl-3 text-sm text-theme-text-primary"
    >
      <span className="truncate">{label}</span>
      {/* Die Schaltfläche selbst misst 44 × 44 px (Fixliste 2, B11 – im
          Browser über getBoundingClientRect messbar); oben und unten ragt sie
          über die Markierung hinaus (negativer Rand), statt sie höher zu
          machen. Sichtbar ist nur der Kreis um das ✕. Eckig: Der Browser
          prüft Treffer innerhalb der Rundung – mit rounded-full gingen
          Tipper in die Ecken der 44 px daneben (Fixliste 6, S1). Rund nur
          der Fokusrahmen. */}
      <button
        type="button"
        onClick={() => {
          onClear();
          focusAfter?.();
        }}
        aria-label={clearLabel}
        title={clearLabel}
        data-filter-clear=""
        className="group -my-[9px] -ml-1.5 grid h-11 w-11 shrink-0 place-items-center focus-visible:rounded-full focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-4 focus-visible:outline-[color:var(--theme-text-primary)]"
      >
        <span className="grid h-5 w-5 place-items-center rounded-full group-hover:bg-white/10 light:group-hover:bg-black/10">
          <X size={12} weight="bold" aria-hidden="true" />
        </span>
      </button>
    </span>
  );
}

/**
 * Beschriftung einer Umschalt-Schaltfläche, deren Breite nicht von der
 * Schriftstärke abhängt: Ein unsichtbarer Doppelgänger in der Stärke der
 * aktiven Schaltfläche (font-medium, ::after mit demselben Text) hält die
 * Breite – wird ein Filter aktiv, wächst die Gruppe nicht (Fixliste 3, V4).
 * @param {{text: string, className?: string}} props
 */
function StableLabel({ text, className = "" }) {
  return (
    <span
      data-stable-label={text}
      className={`inline-flex flex-col items-center after:invisible after:h-0 after:overflow-hidden after:font-medium after:content-[attr(data-stable-label)] ${className}`}
    >
      {text}
    </span>
  );
}

/** Neue Seite an die geladenen anhängen – ohne Doppelte (verschobene Seiten). */
function appendUnique(items, more) {
  const seen = new Set(items.map((item) => item.first_chat_id));
  return [...items, ...more.filter((item) => !seen.has(item.first_chat_id))];
}

/**
 * Schlüssel der nächsten Seite: die letzte geladene Zeile (Fixliste 7, F14).
 * Verschwindet zwischen zwei Seiten eine Konversation (Löschen eines anderen
 * Nutzers, Aufbewahrungsfrist, vom Besucher geleert), beginnt die nächste
 * Seite trotzdem genau hinter dieser Zeile – mit offset fehlte still eine.
 * null ohne brauchbare Zeile (dann blättert die Liste über offset).
 * @param {{last_message_at: number, first_chat_id: number}|undefined} row
 * @returns {{lastMessageAt: number, firstChatId: number}|null}
 */
function cursorAfter(row) {
  return row &&
    Number.isSafeInteger(row.last_message_at) &&
    Number.isSafeInteger(row.first_chat_id)
    ? { lastMessageAt: row.last_message_at, firstChatId: row.first_chat_id }
    : null;
}

/**
 * Konversationsliste der Auswertung. Sie liest embed_chats – also nur
 * Konversationen, deren Inhalte noch vorhanden und nicht vom Besucher geleert
 * sind („einsehbar"). Die Kennzahl „Konversationen" kommt dagegen aus dem
 * Zählerbuch; beide Zahlen können sich unterscheiden.
 *
 * @param {Object} props
 * @param {number} props.embedId
 * @param {string|null} props.fromDay - erster Kalendertag des Zeitraums
 *   ("YYYY-MM-DD"; null = „Gesamt") – dieselben Tage wie Kennzahlen und
 *   Diagramm; der Server begrenzt sie in Berliner Zeit (Fixliste 7, F06)
 * @param {string|null} props.toDay - letzter Kalendertag (einschließlich)
 * @param {"all"|"negative"|"positive"} props.feedbackFilter - KIE-508/527
 * @param {(filter: "all"|"negative"|"positive") => void} props.onFeedbackFilterChange
 * @param {{start: string, end: string, label: string}|null} [props.bucket] -
 *   KIE-536: Abschnitt aus dem Diagramm (Kalendertage). Gezeigt werden nur
 *   Konversationen, deren erste vorhandene Nachricht darin liegt.
 * @param {() => void} [props.onClearBucket]
 * @param {boolean} [props.showDeletedHint] - Hinweis auf gelöschte Inhalte
 * @param {number|null} [props.countedConversations] - Kennzahl
 *   „Konversationen“ (Zählerbuch) für Widget und Zeitraum der Liste; null,
 *   solange sie nicht zu ihnen passt. Zeigt die Liste ohne Filter weniger,
 *   sagt sie es (Fixliste 6, N1).
 * @param {(count: number|null) => void} [props.onViewableCountChange] - Zahl
 *   der einsehbaren Konversationen für die Kopfzeile der Ansicht; null,
 *   solange die Liste lädt
 * @param {() => void} [props.onLinkedRowShown] - die per Link geöffnete
 *   Konversation steht jetzt markiert in der Liste (Fixliste 6, K5)
 * @param {{current: object|null}} [props.headingRef] - Überschrift der Liste
 *   (Ziel des Verweises „Konversationen ansehen" in der Kopfzeile)
 */
export default function ConversationList({
  embedId,
  fromDay = null,
  toDay = null,
  feedbackFilter = "all",
  onFeedbackFilterChange = () => {},
  bucket = null,
  onClearBucket = () => {},
  showDeletedHint = false,
  countedConversations = null,
  onViewableCountChange = () => {},
  onLinkedRowShown = () => {},
  headingRef = null,
}) {
  const { t } = useTranslation();
  const place = useConversationLocation();
  const search = effectiveSearch(place.search);
  const chatId = place.chatId;

  const bucketStart = bucket?.start ?? null;
  const bucketEnd = bucket?.end ?? null;
  // Die Auswahl der Liste – eine Seite und der Export lesen dieselbe
  // (conversationSelectionBody, Fixliste 7, F25).
  const startedBetween = useMemo(
    () =>
      bucketStart && bucketEnd
        ? { fromDay: bucketStart, toDay: bucketEnd }
        : null,
    [bucketStart, bucketEnd]
  );
  const selection = useMemo(
    () => ({ fromDay, toDay, feedbackFilter, startedBetween, search }),
    [fromDay, toDay, feedbackFilter, startedBetween, search]
  );

  // Ein Suchbegriff aus einem Link, den der Server ablehnen würde (zu lang,
  // Steuerzeichen): gekürzt bzw. verworfen, mit Hinweis – die Adresse folgt.
  const linkIssue = searchLinkIssue(place.search);
  const setPlaceSearch = place.setSearch;
  useEffect(() => {
    if (!linkIssue) return;
    showToast(
      t(`embed-analytics.search.link-${linkIssue}`, {
        max: SEARCH_MAX_LENGTH,
      }),
      "info"
    );
    setPlaceSearch(search);
  }, [linkIssue, search, setPlaceSearch, t]);

  // Die geladenen Konversationen gelten für genau einen Zuschnitt der Liste.
  // Ändert sich Widget, Zeitraum, Filter, Abschnitt oder Suche, beginnt sie
  // im selben Render wieder vorn → genau ein Request.
  const scope = [
    embedId,
    fromDay,
    toDay,
    feedbackFilter,
    bucketStart,
    bucketEnd,
    search,
  ].join("|");
  // Anfrage: erste Seite eines Zuschnitts, nachladen (append: hinter der
  // letzten geladenen Zeile, after) oder nach dem Löschen neu laden
  // (dieselbe Menge ab vorn).
  const [request, setRequest] = useState({
    id: 1,
    scope,
    offset: 0,
    after: null,
    limit: PAGE_SIZE,
    append: false,
  });
  if (request.scope !== scope)
    setRequest({
      id: request.id + 1,
      scope,
      offset: 0,
      after: null,
      limit: PAGE_SIZE,
      append: false,
    });
  // Geladener Stand: zu welchem Zuschnitt und welcher Anfrage. failed: Die
  // erste Seite ließ sich nicht laden – dann gibt es keine Zählung (kein
  // alter Stand eines anderen Zuschnitts) und keinen Export.
  // moreFailed: Das letzte Nachladen (append) scheiterte – der bisherige
  // Stand bleibt; das automatische Nachladen hält an, bis ein Nachladen
  // wieder gelingt. added: neue Zeilen des letzten Nachladens (null nach
  // der ersten Seite) – 0 heißt, die Seite brachte nur Doppelte.
  const [list, setList] = useState({
    scope: null,
    requestId: 0,
    items: [],
    hasMore: false,
    total: 0,
    failed: false,
    moreFailed: false,
    added: null,
  });

  // Einsehbare Konversationen des Zeitraums ohne jeden Filter (Bewertung,
  // Säule, Suche) – für „18 von 214 einsehbar". Jede ungefilterte Antwort
  // bringt die Zahl mit; nur wenn ein Filter gilt und sie für diesen
  // Zeitraum fehlt, fragt die Liste sie einmal zusätzlich an. Mit jedem
  // Filter steht so „X von Y“ – auch mit einer Säule allein und auch, wenn
  // sie alle Zeilen umfasst („11 von 11“, Fixliste 7, B7).
  // KIE-538: Nach dem Löschen einer Konversation lädt die Liste neu.
  const [reloadCount, setReloadCount] = useState(0);
  const unfilteredScope = [embedId, fromDay, toDay].join("|");
  const [unfiltered, setUnfiltered] = useState({
    scope: null,
    total: 0,
    reload: 0,
  });
  const unfilteredRef = useRef(unfiltered);
  const filtered = feedbackFilter !== "all" || search !== "" || !!bucket;

  useEffect(() => {
    if (!embedId || request.scope !== scope) return;
    // KIE-527: Antworten überholter Requests (z. B. Filterwechsel während ein
    // Ladevorgang läuft) dürfen den aktuellen Zustand nicht überschreiben.
    let ignore = false;

    async function loadConversations() {
      const needsUnfiltered =
        filtered &&
        !request.append &&
        (unfilteredRef.current.scope !== unfilteredScope ||
          unfilteredRef.current.reload !== reloadCount);
      // Die Zählabfrage (eine Konversation des Zeitraums, ohne Filter)
      // startet neben der Liste, nicht danach.
      const [unfilteredAnswer, answer] = await Promise.all([
        needsUnfiltered
          ? Embed.getConversations(embedId, {
              offset: 0,
              limit: 1,
              fromDay,
              toDay,
            })
          : null,
        Embed.getConversations(embedId, {
          offset: request.offset,
          after: request.after,
          limit: request.limit,
          ...selection,
        }),
      ]);
      if (ignore) return;

      const rememberUnfiltered = (total) => {
        const next = {
          scope: unfilteredScope,
          total: total || 0,
          reload: reloadCount,
        };
        unfilteredRef.current = next;
        setUnfiltered(next);
      };
      if (unfilteredAnswer?.success)
        rememberUnfiltered(unfilteredAnswer.totalCount);

      const {
        success,
        conversations: data,
        hasMore,
        totalCount: total,
      } = answer;
      if (success) {
        setList((previous) => {
          const append = request.append && previous.scope === scope;
          const items = append
            ? appendUnique(previous.items, data || [])
            : data || [];
          return {
            scope,
            requestId: request.id,
            items,
            hasMore: !!hasMore,
            total: total || 0,
            failed: false,
            moreFailed: false,
            added: append ? items.length - previous.items.length : null,
          };
        });
        if (!filtered) rememberUnfiltered(total);
      } else {
        // Kein Toast (Fixliste 4, V6): Beide Fälle melden sich in der Liste
        // selbst – die erste Seite mit „Erneut versuchen“, das Nachladen
        // (auch das automatische: Link-Suche, „Nächste“, Auffüllen) am
        // Knopf „Weitere Konversationen laden“. Ein Toast stünde doppelt
        // daneben und verdeckte unten den Knopf.
        // Nachladen gescheitert: der bisherige Stand bleibt vollständig
        // (Zeilen, Zählung, „Weitere laden"). Erste Seite gescheitert: kein
        // Stand – nicht die Zählung eines anderen Zuschnitts stehen lassen.
        setList((previous) =>
          request.append && previous.scope === scope
            ? { ...previous, requestId: request.id, moreFailed: true }
            : {
                scope,
                requestId: request.id,
                items: [],
                hasMore: false,
                total: 0,
                failed: true,
                moreFailed: false,
                added: null,
              }
        );
      }
    }

    loadConversations();
    return () => {
      ignore = true;
    };
  }, [
    embedId,
    fromDay,
    toDay,
    selection,
    filtered,
    scope,
    request,
    reloadCount,
    unfilteredScope,
  ]);

  const loading = list.scope !== scope;
  const failed = !loading && list.failed;
  const loadingMore = !loading && list.requestId !== request.id;
  const items = loading ? [] : list.items;
  const hasMore = !loading && list.hasMore;
  const moreFailed = !loading && list.moreFailed;
  const totalCount = loading ? 0 : list.total;

  /**
   * Weitere Konversationen anhängen (höchstens PAGE_MAX je Anfrage) – hinter
   * der letzten geladenen Zeile (Fixliste 7, F14).
   */
  const lastItem = list.items.at(-1);
  const loadMore = useCallback(
    (limit = PAGE_SIZE) => {
      const after = cursorAfter(lastItem);
      setRequest((current) => ({
        id: current.id + 1,
        scope: current.scope,
        offset: after ? 0 : list.items.length,
        after,
        limit,
        append: true,
      }));
    },
    [lastItem, list.items.length]
  );

  // Nach dem Löschen: dieselbe Auswahl ab vorn, so viele Zeilen wie geladen
  // waren – die erste Seite des Servers (höchstens PAGE_MAX) sofort, den
  // Rest danach über das automatische Nachladen (Fixliste 2, S6). Der Wunsch
  // gilt nur für seinen Zuschnitt: Ein Wechsel verwirft ihn – er lebt auch
  // nicht wieder auf, wenn der Zuschnitt zurückkehrt (Fixliste 3, C5).
  const [refill, setRefill] = useState(null);
  if (refill && refill.scope !== scope) setRefill(null);
  const reloadList = useCallback(() => {
    setReloadCount((count) => count + 1);
    setRefill({ scope, rows: list.items.length });
    setRequest((current) => ({
      id: current.id + 1,
      scope: current.scope,
      offset: 0,
      after: null,
      limit: Math.min(PAGE_MAX, Math.max(PAGE_SIZE, list.items.length)),
      append: false,
    }));
  }, [list.items.length, scope]);

  // Nach einem Ladefehler: dieselbe Auswahl noch einmal.
  const retry = () =>
    setRequest((current) => ({
      id: current.id + 1,
      scope: current.scope,
      offset: 0,
      after: null,
      limit: PAGE_SIZE,
      append: false,
    }));

  // ---------------------------------------------------------------------------
  // Geöffnete Konversation, vorherige/nächste
  // ---------------------------------------------------------------------------

  // Position jeder Zeile (statt indexOf je Zeile beim Rendern)
  const positions = useMemo(
    () => new Map(items.map((item, index) => [item.first_chat_id, index])),
    [items]
  );

  // Schlüssel der geladenen Konversation (Panel) – damit auch eine per Link
  // geöffnete Zeile in der Liste markiert ist, deren erste Zeile im Zeitraum
  // eine andere ist. outside: keine Nachricht im Zeitraum.
  const [loadedKey, setLoadedKey] = useState({
    chatId: null,
    key: null,
    outside: false,
  });
  const handleLoaded = useCallback(
    (summary) =>
      setLoadedKey({
        chatId,
        key: summary?.key ?? null,
        outside: !!summary?.outside,
      }),
    [chatId]
  );
  let currentIndex = chatId === null ? -1 : (positions.get(chatId) ?? -1);
  if (currentIndex < 0 && chatId !== null && loadedKey.chatId === chatId)
    currentIndex = items.findIndex(
      (item) => conversationKey(item) === loadedKey.key
    );
  const currentRow = currentIndex >= 0 ? items[currentIndex] : null;

  const openRow = useCallback(
    (row) => place.openConversation(row.first_chat_id, { widgetId: embedId }),
    [place, embedId]
  );

  // Blättert das Panel (vorherige/nächste), folgt die Liste der markierten
  // Zeile; ein Klick in die Liste verschiebt sie nicht (AK-4). Gesetzt nur,
  // wenn wirklich eine andere Konversation geöffnet wird.
  const followCurrent = useRef(false);
  const openFollowing = useCallback(
    (row) => {
      followCurrent.current = true;
      openRow(row);
    },
    [openRow]
  );
  // „Nächste" am Ende der geladenen Konversationen: nachladen, dann weiter –
  // nur, solange dieselbe Konversation offen ist (ein Klick auf eine andere
  // Zeile oder Schließen hebt es auf).
  // Ein anderer Zuschnitt, eine andere oder keine Konversation (Schließen,
  // Escape): Der Wunsch verfällt – auch wenn dieselbe Zeile später wieder
  // geöffnet wird (Fixliste 2, R3).
  const [advanceAfter, setAdvanceAfter] = useState(null);
  if (
    advanceAfter &&
    (advanceAfter.chatId !== chatId || advanceAfter.scope !== scope)
  )
    setAdvanceAfter(null);
  const navigate = (direction) => {
    if (currentIndex < 0) return;
    const target = currentIndex + direction;
    if (target >= 0 && target < items.length) openFollowing(items[target]);
    else if (direction === 1 && hasMore && !advanceAfter) {
      setAdvanceAfter({
        chatId,
        scope,
        key: conversationKey(items[currentIndex]),
        rows: items.length + PAGE_SIZE,
      });
      // Der Klick lädt sofort nach; läuft gerade ein automatisches
      // Nachladen, übernimmt das gemeinsame Nachladen unten den Wunsch.
      if (!loading && !loadingMore) loadMore();
    }
  };

  // Per Link (Adresse beim Öffnen der Seite) geöffnet und (noch) nicht unter
  // den geladenen Konversationen: nachladen, bis sie gefunden ist – bis zu
  // LINK_SEARCH_ROWS Zeilen. Nur im Zuschnitt, mit dem die Seite geöffnet
  // wurde: Wechselt bei offenem Panel Filter oder Suche, lädt die Liste
  // nichts nach, der Hinweis erscheint gleich (Fixliste 2, R5). Liegt die
  // Konversation außerhalb des Zeitraums, steht sie nie in der Liste. Der
  // Stand der Suche folgt allein aus der Liste (Fixliste 3, C4): Scheitert
  // ein Nachladen, hält sie an und der Hinweis sagt es; gelingt später ein
  // Nachladen (etwa „Weitere laden“), verschwindet er wieder.
  const [linkScope] = useState(() =>
    chatId !== null ? { chatId, scope } : null
  );
  const fromLink =
    linkScope !== null &&
    linkScope.chatId === chatId &&
    linkScope.scope === scope;
  const notListed =
    chatId !== null &&
    currentIndex < 0 &&
    loadedKey.chatId === chatId &&
    !!loadedKey.key &&
    !loadedKey.outside &&
    !loading &&
    !failed;
  const linkRows =
    fromLink && notListed && items.length < LINK_SEARCH_ROWS
      ? Math.min(LINK_SEARCH_ROWS, items.length + PAGE_MAX)
      : 0;

  // Gemeinsames Nachladen (Fixliste 3, S3): „Nächste“ am Ende, Link-Suche
  // und Auffüllen nach dem Löschen sagen nur, wie viele Zeilen sie brauchen;
  // ein Effekt stellt die Anfragen – eine nach der anderen, keiner
  // überschreibt die eines anderen. Es hält an, wenn eine Seite keine neue
  // Zeile bringt (nur Doppelte, etwa nach Verschiebungen), ein Nachladen
  // scheitert oder AUTO_LOAD_ROUNDS Anfragen gestellt sind (Fixliste 3, C1).
  const wantedRows = Math.max(
    refill?.rows ?? 0,
    advanceAfter?.rows ?? 0,
    linkRows
  );
  const [autoRounds, setAutoRounds] = useState({ scope: null, count: 0 });
  const rounds = autoRounds.scope === scope ? autoRounds.count : 0;
  const idle = !loading && !loadingMore;
  const stuck =
    failed ||
    moreFailed ||
    !hasMore ||
    list.added === 0 ||
    rounds >= AUTO_LOAD_ROUNDS;
  const autoLoad = idle && !stuck && items.length < wantedRows;
  useEffect(() => {
    if (!autoLoad) return;
    setAutoRounds({ scope, count: rounds + 1 });
    loadMore(Math.min(PAGE_MAX, wantedRows - items.length));
  }, [autoLoad, scope, rounds, wantedRows, items.length, loadMore]);
  // Ohne Wunsch beginnt die Zählung der Anfragen von vorn.
  useEffect(() => {
    if (wantedRows === 0 && rounds > 0) setAutoRounds({ scope, count: 0 });
  }, [wantedRows, rounds, scope]);

  // Erfüllt oder nicht erfüllbar: Auffüllen und „Nächste“ sind erledigt.
  const settled = (wish) =>
    !!wish && idle && (items.length >= wish.rows || stuck);
  if (settled(refill)) setRefill(null);
  // „Nächste“ am Ende, und das Nachladen scheiterte: Das Panel sagt es
  // (Fixliste 5, C2) – die Meldung am Knopf „Weitere Konversationen laden“
  // liegt nach dem Blättern oft unter dem Fensterrand. Ein erneuter Klick auf
  // „Nächste“ lädt wieder nach. Der Hinweis gilt für diese Konversation in
  // diesem Zuschnitt, solange das Nachladen gescheitert ist: Er verschwindet
  // nach gelungenem Nachladen, beim Zeilenwechsel und beim Schließen.
  const [advanceFailed, setAdvanceFailed] = useState(null);
  if (
    advanceFailed &&
    (advanceFailed.chatId !== chatId ||
      advanceFailed.scope !== scope ||
      !moreFailed)
  )
    setAdvanceFailed(null);
  const advanceSettled = settled(advanceAfter);
  useEffect(() => {
    if (!advanceSettled) return;
    const index = items.findIndex(
      (item) => conversationKey(item) === advanceAfter.key
    );
    setAdvanceAfter(null);
    if (index >= 0 && index + 1 < items.length) openFollowing(items[index + 1]);
    else if (moreFailed)
      setAdvanceFailed({ chatId: advanceAfter.chatId, scope });
  }, [advanceSettled, advanceAfter, items, openFollowing, moreFailed, scope]);

  // Zwei Lagen, zwei Texte (Fixliste 6, K1): Per Link geöffnet und nicht in
  // der Liste sind vorherige/nächste gesperrt – der Hinweis erklärt das und
  // fordert zu nichts auf, was das Panel nicht anbietet. Nach „Nächste“ am
  // Ende bleibt der Knopf bedienbar: „bitte erneut versuchen“.
  const searchingLink = linkRows > 0 && !stuck;
  const navigationHint =
    notListed && !searchingLink && !loadingMore
      ? t(
          moreFailed
            ? "embed-analytics.panel.not-loaded"
            : "embed-analytics.panel.not-in-list"
        )
      : advanceFailed && !loadingMore
        ? t("embed-analytics.panel.next-not-loaded")
        : null;

  // Die markierte Zeile bleibt im Blick, wenn das Panel blättert (nur, wenn
  // sie neben dem Panel steht: ab lg).
  const rowRefs = useRef(new Map());
  const currentKey = currentRow ? conversationKey(currentRow) : null;
  useEffect(() => {
    if (!currentKey || !followCurrent.current) return;
    followCurrent.current = false;
    if (isWide())
      rowRefs.current.get(currentKey)?.scrollIntoView?.({ block: "nearest" });
  }, [currentKey]);

  // Per Link geöffnet: Sobald die Zeile in der Liste markiert ist – auch
  // erst nach dem Nachladen der Link-Suche –, sagt die Liste es der Ansicht.
  // Die bringt sie in Sicht, solange ihr Sprung zur Liste hält (Fixliste 6,
  // K5).
  useEffect(() => {
    if (fromLink && currentKey) onLinkedRowShown();
  }, [fromLink, currentKey, onLinkedRowShown]);

  // Schließt das Panel, kehrt der Fokus auf die Zeile zurück (statt im
  // Nichts zu stehen) – ohne die Liste zu verschieben.
  const lastOpenKey = useRef(null);
  useEffect(() => {
    if (currentKey) lastOpenKey.current = currentKey;
  }, [currentKey]);
  useEffect(() => {
    if (chatId !== null) return;
    const key = lastOpenKey.current;
    lastOpenKey.current = null;
    if (!key || typeof document === "undefined") return;
    // Nur, wenn der Fokus mit dem Panel verschwunden ist – nicht aus einem
    // Feld wegziehen, in dem gerade jemand tippt.
    if (!focusLost(document)) return;
    rowRefs.current.get(key)?.focus?.({ preventScroll: true });
  }, [chatId]);

  // AK-18: ↑/↓ in der Liste – nur, wenn der Fokus auf einer Zeile steht.
  const handleRowKeyDown = (event, row) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const index = positions.get(row.first_chat_id) ?? -1;
    const target = index + (event.key === "ArrowDown" ? 1 : -1);
    if (index < 0 || target < 0 || target >= items.length) return;
    event.preventDefault();
    rowRefs.current.get(conversationKey(items[target]))?.focus?.();
    if (chatId !== null) openRow(items[target]);
  };
  // Stabile Handler für die Zeilen (Fixliste 7, F32): ConversationRow ist
  // memoisiert – Öffnen, Blättern und Nachladen rendern nur die Zeilen neu,
  // deren Angaben sich ändern, nicht alle geladenen. Die Handler lesen den
  // aktuellen Stand über eine Referenz (gesetzt nach jedem Rendern).
  const rowHandlers = useRef({ open: openRow, keyDown: handleRowKeyDown });
  useLayoutEffect(() => {
    rowHandlers.current = { open: openRow, keyDown: handleRowKeyDown };
  });
  const onRowOpen = useCallback((row) => rowHandlers.current.open(row), []);
  const onRowKeyDown = useCallback(
    (event, row) => rowHandlers.current.keyDown(event, row),
    []
  );
  const setRowRef = useCallback((key, element) => {
    if (element) rowRefs.current.set(key, element);
    else rowRefs.current.delete(key);
  }, []);

  const handleDeleted = ({ deleted }) => {
    if (deleted) place.closeConversation();
    reloadList();
  };

  const clearSearch = () => setPlaceSearch("");
  // Ziele des Fokus, wenn eine Filtermarkierung verschwindet (V9)
  const searchInputRef = useRef(null);
  const allFilterRef = useRef(null);

  // ---------------------------------------------------------------------------
  // Kopfzeile
  // ---------------------------------------------------------------------------

  // KIE-508/527: erneuter Klick hebt den Filter auf.
  const toggleFilter = (mode) =>
    onFeedbackFilterChange(feedbackFilter === mode ? "all" : mode);

  // Mit Filter oder Suche: „18 von 214 einsehbar" – sobald die Zahl ohne
  // Filter für diesen Zuschnitt bekannt ist.
  const feedbackActive = feedbackFilter !== "all";
  const outOf =
    filtered && unfiltered.scope === unfilteredScope ? unfiltered.total : null;
  const feedbackLabel = feedbackActive
    ? t(`embed-analytics.conversations.only-${feedbackFilter}`)
    : null;

  // Die Kopfzeile der Ansicht nennt, wie viele Konversationen die Liste
  // zeigt – nichts, solange sie lädt oder das Laden scheiterte.
  const viewableCount = loading || failed ? null : totalCount;
  useEffect(() => {
    onViewableCountChange(viewableCount);
  }, [viewableCount, onViewableCountChange]);

  // Fixliste 6, N1: weniger einsehbar als gezählt – nur ohne Bewertungs-,
  // Säulen- und Suchfilter (dort gilt „X von Y einsehbar“). Bei leerer Liste
  // statt „Keine Konversationen vorhanden.“, sonst als Zeile unter der Liste;
  // der Hinweis auf die Aufbewahrungsfrist (KIE-536) geht darin auf.
  const contentGap =
    !loading &&
    !failed &&
    !filtered &&
    !bucket &&
    hasContentGap(countedConversations, totalCount);
  const contentGapText = contentGap
    ? t("embed-analytics.list.content-gap", {
        count: countedConversations,
        counted: formatNumber(countedConversations),
        viewable: formatNumber(totalCount),
      })
    : null;

  const today = formatDateForInput(new Date());
  const groups = useMemo(() => groupByLastMessageDay(items), [items]);

  // Leerzustand mit Suche: nennt auch die übrigen Filter (Bewertung, Säule).
  const otherFilters = [feedbackLabel, bucket?.label]
    .filter(Boolean)
    .map((text) => t("embed-analytics.search.quoted", { text }));
  const emptySearchText =
    otherFilters.length > 0
      ? t("embed-analytics.search.empty-filtered", {
          term: search,
          filters: otherFilters.join(", "),
        })
      : t("embed-analytics.search.empty", { term: search });

  return (
    <div>
      {/* Kopfzeile – immer sichtbar, auch im Lade- und Leer-Zustand.
          Überschrift mit „N einsehbar“ bzw. „X von Y einsehbar“ daneben
          (Fixliste 3, V1); reicht der Platz nicht, bricht die Zahl unter
          die Überschrift, nicht die Werkzeugleiste um. Die Werkzeugleiste
          steht fest neben (schmaler: unter) der Überschrift; ob sie dorthin
          passt, hängt nicht an der Zahl (basis-40) – sie springt nicht, wenn
          ein Filter die Zahl verlängert (Fixliste 2, B7). Die Überschrift
          hat eine feste Zeile so hoch wie die Leiste (min-h-10), der
          Titelblock wächst nur nach unten (content-start): Bricht die Zahl
          um, bleiben Überschrift und Leiste, wo sie waren (Fixliste 4, V1).
          Darunter eine Zeile mit den Filtermarkierungen, nur wenn ein
          Filter gesetzt ist. Unter sm: „Exportieren“ als Symbol neben der
          Überschrift, Suche und Bewertungsfilter je in voller Breite
          darunter – nichts überlappt (B1). */}
      <div data-list-header="" className="mb-3 flex flex-col gap-3">
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
          {/* Ab xl teilen sich Titelblock und Leiste den freien Platz einer
              gemeinsamen Zeile fast ganz zugunsten des Titels (grow 999 zu 1):
              Die Suche bleibt dort 240 px, „N einsehbar“ neben der
              Überschrift. Bricht die Leiste unter die Überschrift (1280 px),
              ist sie allein in ihrer Zeile und füllt sie – wie von sm bis xl
              (Fixliste 5, S4). */}
          <div
            data-list-title=""
            className="order-1 flex min-w-0 flex-1 basis-40 flex-wrap content-start items-center gap-x-3 gap-y-0.5 xl:grow-[999]"
          >
            <h3
              ref={headingRef}
              tabIndex={-1}
              data-list-heading=""
              className="flex min-h-11 items-center text-base font-semibold text-theme-text-primary sm:min-h-10"
            >
              {t("embed-analytics.list.title")}
            </h3>
            {!loading && !failed && (
              <span
                data-viewable-count=""
                title={t("embed-analytics.list.viewable-hint")}
                className={`whitespace-nowrap text-sm ${MUTED}`}
              >
                {outOf === null
                  ? t("embed-analytics.list.viewable", {
                      count: totalCount,
                      formatted: formatNumber(totalCount),
                    })
                  : t("embed-analytics.list.viewable-of", {
                      count: totalCount,
                      formatted: formatNumber(totalCount),
                      total: formatNumber(outOf),
                    })}
              </span>
            )}
          </div>
          {/* unter sm „contents“: Die Teile ordnen sich in die Kopfzeile ein.
              Von sm bis xl steht die Leiste in einer eigenen Zeile: Suche so
              breit wie möglich (mindestens 240 px, Basis 0 – nicht die volle
              Zeile, Fixliste 4 V5), Bewertungsfilter mit kurzen Namen und
              Export ohne Pfeil daneben, sobald sie hineinpassen; Filter und
              Export brechen nur gemeinsam um – „Exportieren“ steht nie allein
              in einer Zeile (Fixliste 3, V7). Rechts hält die Leiste Abstand
              zum schwebenden Benutzermenü: Der Export-Knopf bleibt in jeder
              Scrollstellung frei (Fixliste 4, V2).
              Ab xl ist die Basis der Suche fest 240 px (xl:w-60 mit Basis
              auto): Ob die Leiste neben die Überschrift passt, hängt so nicht
              an der Breite des Fensters. Neben der Überschrift bekommt sie
              keinen nennenswerten Zuwachs (Titel grow 999); bricht sie um,
              füllt sie ihre Zeile (xl:grow), und die Suche wächst – links
              bündig wie von sm bis xl (Fixliste 5, S4). */}
          <div
            data-list-tools=""
            className={`contents sm:order-2 sm:ml-auto sm:flex sm:basis-full sm:flex-wrap sm:items-center sm:justify-end sm:gap-2 xl:grow xl:basis-auto ${AVATAR_CLEARANCE.toolbarEnd}`}
          >
            <SearchField
              value={place.search}
              onSearch={setPlaceSearch}
              inputRef={searchInputRef}
              className="order-3 basis-full sm:order-none sm:min-w-[240px] sm:flex-1 xl:w-60 xl:flex-auto"
            />
            <div
              data-list-actions=""
              className="contents sm:flex sm:items-center sm:gap-2"
            >
              <div
                role="group"
                data-feedback-filters=""
                aria-label={t("embed-analytics.rows.filter-group")}
                className="order-4 flex min-w-0 basis-full gap-0.5 rounded-lg border border-white/10 bg-theme-settings-input-bg p-0.5 sm:order-none sm:basis-auto light:border-gray-200"
              >
                <button
                  type="button"
                  ref={allFilterRef}
                  aria-pressed={feedbackFilter === "all"}
                  aria-label={t("embed-analytics.rows.all-hint")}
                  title={t("embed-analytics.rows.all-hint")}
                  onClick={() => onFeedbackFilterChange("all")}
                  className={`${SEGMENT_CLASS} flex-1 justify-center sm:flex-none ${feedbackFilter === "all" ? SEGMENT_ACTIVE : SEGMENT_INACTIVE}`}
                >
                  <StableLabel text={t("embed-analytics.rows.all")} />
                </button>
                {FEEDBACK_FILTERS.map(({ mode, Icon, labelKey }) => {
                  const active = feedbackFilter === mode;
                  return (
                    <button
                      key={mode}
                      type="button"
                      aria-pressed={active}
                      // Texte neben labelKey: …-hint (Tooltip, Name für
                      // Screenreader) und …-short (schmale Fenster).
                      aria-label={t(`${labelKey}-hint`)}
                      title={t(`${labelKey}-hint`)}
                      onClick={() => toggleFilter(mode)}
                      className={`${SEGMENT_CLASS} flex-1 justify-center sm:flex-none ${active ? SEGMENT_ACTIVE : SEGMENT_INACTIVE}`}
                    >
                      {/* Ein Daumen je Schaltfläche, in der Textfarbe; gefüllt,
                          wenn der Filter gesetzt ist – wie in der
                          Chat-Oberfläche. */}
                      <Icon
                        size={15}
                        weight={active ? "fill" : "regular"}
                        aria-hidden="true"
                      />
                      {/* Bis xl der kurze Text, damit Suche, Filter und
                          Export in eine Zeile passen (V7). */}
                      <StableLabel
                        text={t(`${labelKey}-short`)}
                        className="xl:hidden"
                      />
                      <StableLabel
                        text={t(labelKey)}
                        className="hidden xl:inline-flex"
                      />
                    </button>
                  );
                })}
              </div>
              {/* KIE-538: Export der Auswahl, die die Liste gerade zeigt */}
              <ExportMenu
                embedId={embedId}
                selection={selection}
                disabled={loading || failed || totalCount === 0}
                wrapperClassName="order-2 sm:order-none"
                className="flex h-11 w-11 items-center justify-center gap-2 whitespace-nowrap rounded-lg border border-white/10 bg-theme-settings-input-bg text-sm text-theme-text-primary transition-colors hover:border-white/20 sm:h-10 sm:w-auto sm:px-2.5 xl:px-3.5 light:border-gray-200"
              />
            </div>
          </div>
        </div>
        {/* Filtermarkierungen – eine eigene Zeile nur, wenn ein Filter
            gesetzt ist. gap-y 18 px: Die 44-px-Trefferflächen der ✕ ragen je
            9 px über ihre Markierung hinaus und überlappen sich so auch bei
            umbrochenen Markierungen nicht (Fixliste 3, S1). */}
        {(feedbackActive || bucket || search) && (
          <div
            data-list-status=""
            className="flex flex-wrap items-center gap-x-3 gap-y-[18px]"
          >
            {feedbackActive && (
              <FilterMark
                data-feedback-filter-mark={feedbackFilter}
                label={t("embed-analytics.list.only-feedback", {
                  filter: feedbackLabel,
                })}
                clearLabel={t("embed-analytics.list.clear-feedback", {
                  filter: feedbackLabel,
                })}
                onClear={() => onFeedbackFilterChange("all")}
                focusAfter={() => allFilterRef.current?.focus?.()}
              />
            )}
            {bucket && (
              <FilterMark
                data-bucket-filter=""
                label={t("embed-analytics.list.only-bucket", {
                  period: bucket.label,
                })}
                clearLabel={t("embed-analytics.list.clear-bucket", {
                  period: bucket.label,
                })}
                onClear={onClearBucket}
                focusAfter={() =>
                  headingRef?.current?.focus?.({ preventScroll: true })
                }
              />
            )}
            {search && (
              <FilterMark
                data-search-filter-mark=""
                label={t("embed-analytics.search.mark", { term: search })}
                clearLabel={t("embed-analytics.search.clear", { term: search })}
                onClear={clearSearch}
                focusAfter={() => searchInputRef.current?.focus?.()}
              />
            )}
          </div>
        )}
      </div>

      {/* Ab lg mindestens so hoch wie das Panel werden kann: So lässt sich
          die Seite immer so weit scrollen, dass das Panel ganz zu sehen ist –
          auch bei wenigen Treffern (Fixliste 3, V8) –, und die Seite
          schrumpft nicht, wenn eine Suche die Liste verkürzt. */}
      <div className="flex items-start gap-4 lg:min-h-[calc(100vh-112px)]">
        <div className="min-w-0 flex-1">
          {loading ? (
            <div className="text-white">{t("embed-analytics.loading")}</div>
          ) : failed ? (
            <div
              data-list-load-error=""
              role="alert"
              className={`flex flex-wrap items-center gap-3 rounded-xl border border-white/10 px-4 py-3 text-sm ${MUTED} light:border-gray-200`}
            >
              <span>{t("embed-analytics.load-error")}</span>
              <button
                type="button"
                data-list-retry=""
                onClick={retry}
                className="h-11 rounded-lg border border-white/10 px-4 text-sm text-theme-text-primary transition-colors hover:bg-white/5 sm:h-9 light:border-gray-200 light:hover:bg-black/5"
              >
                {t("embed-analytics.panel.retry")}
              </button>
            </div>
          ) : items.length === 0 ? (
            search ? (
              <p
                data-empty-search=""
                className={`rounded-xl border border-white/10 px-4 py-3 text-sm ${MUTED}`}
              >
                {emptySearchText}
              </p>
            ) : contentGap ? (
              // Höchstens rund 70 Zeichen je Zeile: Über die volle Breite
              // (1.080 px) bliebe in der zweiten Zeile nur ein Rest stehen
              // (Fixliste 7, B2).
              <p
                data-content-gap=""
                className={`mx-auto max-w-[70ch] px-4 py-8 text-center text-sm ${MUTED}`}
              >
                {contentGapText}
              </p>
            ) : (
              <div className="text-white/60 text-center py-8">
                {t(EMPTY_STATE_KEYS[feedbackFilter])}
              </div>
            )
          ) : (
            <div
              data-conversation-list=""
              className="overflow-hidden rounded-xl border border-white/10 bg-theme-bg-primary"
            >
              {groups.map((group) => {
                const label = dayGroupLabel(group.day, today, { t });
                // Ohne Anzahl: Die letzte Gruppe kann auf der nächsten Seite
                // weitergehen – einheitlich und ruhiger (Fixliste 2, B10).
                return (
                  <section
                    key={group.day}
                    data-day-group={group.day}
                    aria-label={label}
                  >
                    <h4
                      className={`px-4 pb-1 pt-3 text-xs font-semibold ${MUTED} sm:px-5`}
                    >
                      <span data-day-label="">{label}</span>
                    </h4>
                    <ul>
                      {group.conversations.map((conversation) => (
                        <li key={conversation.first_chat_id}>
                          <ConversationRow
                            conversation={conversation}
                            today={today}
                            selected={
                              positions.get(conversation.first_chat_id) ===
                              currentIndex
                            }
                            onOpen={onRowOpen}
                            onKeyDown={onRowKeyDown}
                            setRowRef={setRowRef}
                          />
                        </li>
                      ))}
                    </ul>
                  </section>
                );
              })}
              {hasMore && (
                <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-2 border-t border-white/5 px-4 py-3 light:border-gray-100">
                  {/* Nachladen gescheitert: die Meldung hier am Knopf, der
                      Knopf versucht es erneut (Fixliste 4, V6) */}
                  {moreFailed && !loadingMore && (
                    <span
                      data-load-more-error=""
                      role="alert"
                      className={`text-sm ${MUTED}`}
                    >
                      {t("embed-analytics.rows.load-more-failed")}
                    </span>
                  )}
                  <button
                    type="button"
                    data-load-more=""
                    onClick={() => loadMore()}
                    disabled={loadingMore}
                    className="h-11 rounded-lg border border-white/10 px-4 text-sm text-theme-text-primary transition-colors hover:bg-white/5 disabled:opacity-60 sm:h-9 light:border-gray-200 light:hover:bg-black/5"
                  >
                    {loadingMore
                      ? t("embed-analytics.rows.loading-more")
                      : moreFailed
                        ? t("embed-analytics.panel.retry")
                        : t("embed-analytics.rows.load-more")}
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Fixliste 6, N1: Ein Teil der gezählten Konversationen ist
              nicht einsehbar – eine Zeile unter der Liste (bei leerer Liste
              steht der Text oben statt des Leerzustands). */}
          {contentGap && items.length > 0 && (
            <p
              data-content-gap=""
              className={`mx-auto mt-4 max-w-[70ch] text-center text-xs ${MUTED}`}
            >
              {contentGapText}
            </p>
          )}
          {/* KIE-536: Das Diagramm zählt weiter, die Inhalte sind gelöscht.
              Steht der Hinweis auf die Lücke da, nennt er das schon. */}
          {showDeletedHint &&
            !contentGap &&
            !loading &&
            !failed &&
            !hasMore && (
              <p
                data-deleted-hint=""
                className={`mt-4 text-center text-xs ${MUTED}`}
              >
                {t("embed-analytics.list.deleted-hint")}
              </p>
            )}
        </div>

        {chatId !== null && embedId && (
          <ConversationDetail
            embedId={embedId}
            chatId={chatId}
            row={currentRow}
            search={search}
            fromDay={fromDay}
            toDay={toDay}
            // Die Suche prüft die Zeilen im Zeitraum – mit Abschnitt
            // (Säulenklick) die ganze Konversation (Fixliste 2, S7).
            searchWholeConversation={!!bucket}
            canPrevious={currentIndex > 0}
            canNext={
              currentIndex >= 0 && (currentIndex < items.length - 1 || hasMore)
            }
            navigationHint={navigationHint}
            onNavigate={navigate}
            onClose={place.closeConversation}
            onDeleted={handleDeleted}
            onLoaded={handleLoaded}
            linkOf={(id) => place.conversationUrl(id, embedId)}
            reveal={!fromLink}
          />
        )}
      </div>
    </div>
  );
}

/**
 * Suchfeld der Liste: Die Eingabe geht verzögert (SEARCH_DELAY_MS) bzw. mit
 * Enter in die Adresse. Ändert sich die Adresse von außen (✕ der Markierung,
 * Zurück-Knopf, Link), folgt das Feld – nicht nach der eigenen
 * Aktualisierung: Sonst ginge ein Zeichen verloren, das zwischen Verzögerung
 * und Antwort der Adresse getippt wurde (Fixliste Punkt 21).
 * @param {{value: string, onSearch: (term: string) => void, inputRef?: {current: object|null}, className?: string}} props -
 *   value: Suchbegriff der Adresse (roh); inputRef: das Eingabefeld (für die
 *   Liste, die den Fokus nach ✕ einer Markierung hierher gibt)
 */
function SearchField({ value, onSearch, inputRef: outerRef, className = "" }) {
  const { t } = useTranslation();
  const ownRef = useRef(null);
  const inputRef = outerRef ?? ownRef;
  const clearRef = useRef(null);
  const [draft, setDraft] = useState(value);
  // Der Begriff, den das Feld zuletzt selbst in die Adresse geschrieben hat
  const [own, setOwn] = useState(value);
  const [seen, setSeen] = useState(value);
  if (seen !== value) {
    setSeen(value);
    if (value !== own) {
      setOwn(value);
      setDraft(value);
    }
  }
  const submit = useCallback(
    (term) => {
      setOwn(term);
      onSearch(term);
    },
    [onSearch]
  );
  useEffect(() => {
    const term = effectiveSearch(draft);
    if (term === effectiveSearch(value)) return;
    const timer = setTimeout(() => submit(term), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [draft, value, submit]);
  // Eigenes ✕ statt des blauen des Browsers (Fixliste 2, B8): leert das Feld
  // und die Suche sofort; der Fokus bleibt im Feld (Fixliste 3, V9). Der
  // Fokus geht schon beim Drücken nicht auf das ✕ (preventDefault): Es
  // verschwindet mit dem leeren Feld – der Fokus bliebe sonst im Leeren.
  const clear = () => {
    setDraft("");
    submit("");
    inputRef.current?.focus?.();
  };
  // Klick auf die Lupe oder den Rand des Rahmens: ins Feld (Fixliste 3, V11)
  const focusField = (event) => {
    if (event.target === inputRef.current) return;
    if (clearRef.current?.contains?.(event.target)) return;
    inputRef.current?.focus?.();
  };

  // Kein <label> um Feld und ✕: Eine Schaltfläche darf darin nicht stehen.
  // Den Namen trägt das Feld (aria-label); ein Klick in den Rahmen fokussiert
  // es wie ein <label>.
  // Platzhalter in voller Länge (Fixliste 2 B6, Fixliste 5 V1): Der Rahmen
  // ist ab sm mindestens 240 px breit (ab xl neben der Überschrift genau
  // 240 px, bei 1024 px 253 px), darunter volle Breite (≥ 328 px). Davon
  // gehen 44 px ab – Rahmen 2, pl-2.5 10, Lupe 16, zwei Lücken gap-1.5 je 6,
  // Platzhalter-Ersatz w-1 4 –, dem Feld bleiben mindestens 196 px. Der
  // Platzhalter (Plus Jakarta Sans 14 px) misst „Fragen & Antworten suchen“
  // 181 px, „Search questions & answers“ 185 px; der frühere Text „In
  // Fragen und Antworten suchen“ (210 px) passte nicht. Den vollen Namen
  // trägt aria-label.
  return (
    <div
      data-search-field=""
      onClick={focusField}
      className={`flex h-11 w-full min-w-0 cursor-text items-center gap-1.5 rounded-lg border border-white/10 bg-theme-settings-input-bg pl-2.5 ${MUTED} sm:h-10 light:border-gray-200 ${className}`}
    >
      <MagnifyingGlass size={16} aria-hidden="true" className="shrink-0" />
      <input
        ref={inputRef}
        type="search"
        data-search-input=""
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          // Enter bestätigt bei japanischer, chinesischer oder koreanischer
          // Eingabe erst die Umwandlung – gesucht wird dann noch nicht,
          // sonst ginge der unfertige Entwurf (Kana, Pinyin) an den Server
          // (Fixliste 7, F18).
          if (event.nativeEvent?.isComposing || event.keyCode === 229) return;
          submit(effectiveSearch(draft));
        }}
        maxLength={SEARCH_MAX_LENGTH}
        placeholder={t("embed-analytics.search.placeholder")}
        aria-label={t("embed-analytics.search.label")}
        // Platzhalter: hell #5f6368 auf #edf2fa = 5,4:1 statt 3,9:1 (B2);
        // dunkel wie bisher.
        className="h-full min-w-0 flex-1 border-0 bg-transparent p-0 text-sm text-theme-text-primary outline-none placeholder:text-theme-settings-input-placeholder focus:ring-0 light:placeholder:text-[color:var(--theme-analytics-text-muted)] [&::-webkit-search-cancel-button]:hidden [&::-webkit-search-decoration]:hidden"
      />
      {draft !== "" ? (
        <button
          type="button"
          ref={clearRef}
          data-search-clear=""
          onMouseDown={(event) => event.preventDefault()}
          onClick={clear}
          aria-label={t("embed-analytics.search.clear-input")}
          title={t("embed-analytics.search.clear-input")}
          className="grid h-11 w-11 shrink-0 place-items-center rounded-lg transition-colors hover:text-theme-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-4 focus-visible:outline-[color:var(--theme-text-primary)] sm:h-10 sm:w-10"
        >
          <X size={14} weight="bold" aria-hidden="true" />
        </button>
      ) : (
        <span aria-hidden="true" className="w-1 shrink-0" />
      )}
    </div>
  );
}

/**
 * Eine Zeile der Liste: Uhrzeit der letzten Nachricht, erste Frage, darunter
 * „N Fragen" (mit „begonnen am …", „Grund: …") und Marken der Bewertungen.
 * memo (Fixliste 7, F32): Die Handler sind stabil und bekommen die Zeile
 * mit; neu gerendert wird nur, was sich ändert (etwa die Markierung).
 * @param {{conversation: object, today: string, selected: boolean, onOpen: (row: object) => void, onKeyDown: (event: object, row: object) => void, setRowRef: (key: string, element: HTMLElement|null) => void}} props
 */
const ConversationRow = memo(function ConversationRow({
  conversation,
  today,
  selected,
  onOpen,
  onKeyDown,
  setRowRef,
}) {
  const { t } = useTranslation();
  const key = conversationKey(conversation);
  const buttonRef = useCallback(
    (element) => setRowRef(key, element),
    [setRowRef, key]
  );
  const time = berlinTime(conversation.last_message_at);
  // Uhrzeit wie im Entwurf (AK-1), der volle Zeitpunkt im Tooltip – in
  // Berliner Zeit wie Uhrzeit und Tagesgruppe (Fixliste 2, S1)
  const fullTime = berlinDateTime(conversation.last_message_at);
  const startedDay = startedOnOtherDay(conversation);
  const reason =
    conversation.negative_count > 0 && conversation.first_negative_reason
      ? conversation.first_negative_reason
      : null;
  const meta = [
    t("embed-analytics.rows.questions", {
      count: conversation.message_count,
      formatted: formatNumber(conversation.message_count),
    }),
    startedDay &&
      t("embed-analytics.rows.started", {
        date: shortDayLabel(startedDay, today),
      }),
  ].filter(Boolean);
  const reasonText = reason && t("embed-analytics.rows.reason", { reason });
  // Der Grund wird in schmaler Liste (1024 px mit Panel) gekürzt – der
  // Tooltip nennt ihn ganz (Fixliste 6, S2).
  const metaTitle = reasonText ? [...meta, reasonText].join(" · ") : undefined;

  return (
    <button
      type="button"
      ref={buttonRef}
      data-conversation-row={conversation.first_chat_id}
      data-conversation-id={conversation.conversation_id}
      aria-current={selected ? "true" : undefined}
      onClick={() => onOpen(conversation)}
      onKeyDown={(event) => onKeyDown(event, conversation)}
      className={`grid w-full grid-cols-[minmax(0,1fr)_auto_16px] lg:scroll-mb-8 lg:scroll-mt-20 items-center gap-3 border-t border-white/5 px-4 py-2 text-left transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[color:var(--theme-text-primary)] sm:grid-cols-[44px_minmax(0,1fr)_auto_16px] sm:px-5 light:border-gray-100 ${
        selected
          ? "bg-sky-500/15 light:bg-sky-50"
          : "hover:bg-white/5 light:hover:bg-black/[0.03]"
      }`}
    >
      <span
        data-row-time=""
        title={fullTime}
        className={`hidden text-[13px] tabular-nums ${MUTED} sm:block`}
      >
        {time}
      </span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span
          data-row-question=""
          className="truncate text-[15px] font-medium leading-5 text-theme-text-primary"
        >
          {conversation.preview ||
            t("embed-analytics.conversations.no-preview")}
        </span>
        {/* Ab sm steht „Grund: …“ am Ende dieser Zeile (AK-1). Unter sm
            hat er eine eigene Zeile: Neben Uhrzeit, „N Fragen“ und Marken
            blieb davon bei 360 px nichts lesbar (Fixliste 5, V2). */}
        <span
          data-row-meta=""
          title={metaTitle}
          className={`truncate text-[13px] leading-[18px] ${MUTED}`}
        >
          <span className="sm:hidden">{time} · </span>
          {meta.join(" · ")}
          {reasonText && (
            <span className="hidden sm:inline"> · {reasonText}</span>
          )}
        </span>
        {reasonText && (
          <span
            data-row-reason=""
            title={reasonText}
            className={`truncate text-[13px] leading-[18px] ${MUTED} sm:hidden`}
          >
            {reasonText}
          </span>
        )}
      </span>
      <span className="flex items-center gap-2 sm:gap-1.5">
        <RatingBadge
          count={conversation.positive_count}
          Icon={ThumbsUp}
          tone="positive"
          labelKey="embed-analytics.conversations.positive-count"
        />
        <RatingBadge
          count={conversation.negative_count}
          Icon={ThumbsDown}
          tone="negative"
          labelKey="embed-analytics.conversations.negative-count"
        />
      </span>
      <CaretRight size={16} aria-hidden="true" className={MUTED} />
    </button>
  );
});

// KIE-508/527: Marke „👍 n" / „👎 n" je Konversation – als Umriss-Daumen.
// Unter sm kompakt – nur Daumen und Zahl in der Farbe der Marke, ohne Pille
// und Innenabstand (Fixliste 5, V2): Zwei Pillen nahmen bei 360 px der
// Frage und dem Grund rund 80 px; kompakt sind es rund 50.
function RatingBadge({ count, Icon, tone, labelKey }) {
  const { t } = useTranslation();
  if (!(count > 0)) return null;
  const label = t(labelKey, { count });
  const toneClass =
    tone === "positive"
      ? "text-sky-300 sm:bg-sky-500/15 light:text-sky-700 light:sm:bg-sky-50"
      : "text-orange-300 sm:bg-orange-500/15 light:text-orange-700 light:sm:bg-orange-50";
  return (
    <span
      data-rating-badge={tone}
      title={label}
      className={`inline-flex h-6 items-center gap-0.5 rounded-full text-xs font-semibold sm:gap-1 sm:px-2 ${toneClass}`}
    >
      <Icon size={13} aria-hidden="true" />
      <span aria-hidden="true">{count}</span>
      <span className="sr-only">{label}</span>
    </span>
  );
}
