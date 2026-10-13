import { useCallback, useEffect, useRef, useState } from "react";
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
import showToast from "@/utils/toast";
import {
  berlinDay,
  berlinTime,
  conversationKey,
  dayGroupLabel,
  effectiveSearch,
  groupByLastMessageDay,
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

const MUTED = "text-[color:var(--theme-analytics-text-muted)]";

// Umschalter „Alle / Positiv bewertet / Negativ bewertet"
const SEGMENT_CLASS =
  "flex h-9 items-center gap-1.5 whitespace-nowrap rounded-md px-3 text-sm transition-colors";
const SEGMENT_ACTIVE =
  "bg-white/10 text-theme-text-primary font-medium light:bg-black/[0.07]";
const SEGMENT_INACTIVE =
  "text-theme-text-secondary hover:text-theme-text-primary";

/**
 * Markierung eines gesetzten Filters in der Kopfzeile der Liste („Nur …",
 * „Filter: …", „Suche: …") – ✕ hebt ihn auf.
 * @param {{label: string, clearLabel: string, onClear: () => void}} props
 *   (übrige Props, z. B. data-*, gehen an die Markierung)
 */
function FilterMark({ label, clearLabel, onClear, ...rest }) {
  return (
    <span
      {...rest}
      className="inline-flex max-w-full items-center gap-1 rounded-full border border-white/10 bg-theme-settings-input-bg py-0.5 pl-3 pr-1 text-sm text-theme-text-primary"
    >
      <span className="truncate">{label}</span>
      <button
        type="button"
        onClick={onClear}
        aria-label={clearLabel}
        title={clearLabel}
        className="shrink-0 rounded-full p-1 hover:bg-white/10 light:hover:bg-black/10"
      >
        <X size={12} weight="bold" aria-hidden="true" />
      </button>
    </span>
  );
}

/** Neue Seite an die geladenen anhängen – ohne Doppelte (verschobene Seiten). */
function appendUnique(items, more) {
  const seen = new Set(items.map((item) => item.first_chat_id));
  return [...items, ...more.filter((item) => !seen.has(item.first_chat_id))];
}

/**
 * Konversationsliste der Auswertung. Sie liest embed_chats – also nur
 * Konversationen, deren Inhalte noch vorhanden und nicht vom Besucher geleert
 * sind („einsehbar"). Die Kennzahl „Konversationen" kommt dagegen aus dem
 * Zählerbuch; beide Zahlen können sich unterscheiden.
 *
 * @param {Object} props
 * @param {number} props.embedId
 * @param {string|null} props.startDate - ISO-Zeitstempel des Browsers
 * @param {string|null} props.endDate
 * @param {"all"|"negative"|"positive"} props.feedbackFilter - KIE-508/527
 * @param {(filter: "all"|"negative"|"positive") => void} props.onFeedbackFilterChange
 * @param {{start: string, end: string, label: string}|null} [props.bucket] -
 *   KIE-536: Abschnitt aus dem Diagramm (Kalendertage). Gezeigt werden nur
 *   Konversationen, deren erste vorhandene Nachricht darin liegt.
 * @param {() => void} [props.onClearBucket]
 * @param {boolean} [props.showDeletedHint] - Hinweis auf gelöschte Inhalte
 * @param {(count: number|null) => void} [props.onViewableCountChange] - Zahl
 *   der einsehbaren Konversationen für die Kopfzeile der Ansicht; null,
 *   solange die Liste lädt
 * @param {{current: object|null}} [props.headingRef] - Überschrift der Liste
 *   (Ziel des Verweises „Konversationen ansehen" in der Kopfzeile)
 */
export default function ConversationList({
  embedId,
  startDate,
  endDate,
  feedbackFilter = "all",
  onFeedbackFilterChange = () => {},
  bucket = null,
  onClearBucket = () => {},
  showDeletedHint = false,
  onViewableCountChange = () => {},
  headingRef = null,
}) {
  const { t, i18n } = useTranslation();
  const place = useConversationLocation();
  const search = effectiveSearch(place.search);
  const chatId = place.chatId;

  const bucketStart = bucket?.start ?? null;
  const bucketEnd = bucket?.end ?? null;

  // Die geladenen Konversationen gelten für genau einen Zuschnitt der Liste.
  // Ändert sich Widget, Zeitraum, Filter, Abschnitt oder Suche, beginnt sie
  // im selben Render wieder vorn → genau ein Request.
  const scope = [
    embedId,
    startDate,
    endDate,
    feedbackFilter,
    bucketStart,
    bucketEnd,
    search,
  ].join("|");
  // Anfrage: erste Seite eines Zuschnitts, nachladen (append) oder nach dem
  // Löschen neu laden (dieselbe Menge ab vorn).
  const [request, setRequest] = useState({
    id: 1,
    scope,
    offset: 0,
    limit: PAGE_SIZE,
    append: false,
  });
  if (request.scope !== scope)
    setRequest({
      id: request.id + 1,
      scope,
      offset: 0,
      limit: PAGE_SIZE,
      append: false,
    });
  // Geladener Stand: zu welchem Zuschnitt und welcher Anfrage
  const [list, setList] = useState({
    scope: null,
    requestId: 0,
    items: [],
    hasMore: false,
    total: 0,
  });

  // Einsehbare Konversationen ohne Bewertungsfilter und ohne Suche im selben
  // Zeitraum und Abschnitt – für „18 von 214 einsehbar". Jede ungefilterte
  // Antwort bringt die Zahl mit; nur wenn ein Filter gilt und sie für diesen
  // Zuschnitt fehlt, fragt die Liste sie einmal zusätzlich an.
  // KIE-538: Nach dem Löschen einer Konversation lädt die Liste neu.
  const [reloadCount, setReloadCount] = useState(0);
  const unfilteredScope = [
    embedId,
    startDate,
    endDate,
    bucketStart,
    bucketEnd,
  ].join("|");
  const [unfiltered, setUnfiltered] = useState({
    scope: null,
    total: 0,
    reload: 0,
  });
  const unfilteredRef = useRef(unfiltered);
  const filtered = feedbackFilter !== "all" || search !== "";

  useEffect(() => {
    if (!embedId || request.scope !== scope) return;
    // KIE-527: Antworten überholter Requests (z. B. Filterwechsel während ein
    // Ladevorgang läuft) dürfen den aktuellen Zustand nicht überschreiben.
    let ignore = false;

    async function loadConversations() {
      const startedBetween =
        bucketStart && bucketEnd
          ? { fromDay: bucketStart, toDay: bucketEnd }
          : null;
      const needsUnfiltered =
        filtered &&
        !request.append &&
        (unfilteredRef.current.scope !== unfilteredScope ||
          unfilteredRef.current.reload !== reloadCount);
      // Die Zählabfrage (eine Konversation, ohne Bewertungsfilter und ohne
      // Suche) startet neben der Liste, nicht danach.
      const [unfilteredAnswer, answer] = await Promise.all([
        needsUnfiltered
          ? Embed.getConversations(
              embedId,
              0,
              1,
              startDate,
              endDate,
              "all",
              startedBetween
            )
          : null,
        Embed.getConversations(
          embedId,
          request.offset,
          request.limit,
          startDate,
          endDate,
          feedbackFilter,
          startedBetween,
          search
        ),
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
        setList((previous) => ({
          scope,
          requestId: request.id,
          items:
            request.append && previous.scope === scope
              ? appendUnique(previous.items, data || [])
              : data || [],
          hasMore: !!hasMore,
          total: total || 0,
        }));
        if (!filtered) rememberUnfiltered(total);
      } else {
        showToast(t("embed-analytics.load-error"), "error");
        setList((previous) => ({
          ...previous,
          scope,
          requestId: request.id,
          items: previous.scope === scope ? previous.items : [],
        }));
      }
    }

    loadConversations();
    return () => {
      ignore = true;
    };
  }, [
    embedId,
    startDate,
    endDate,
    feedbackFilter,
    bucketStart,
    bucketEnd,
    search,
    filtered,
    scope,
    request,
    reloadCount,
    unfilteredScope,
    t,
  ]);

  const loading = list.scope !== scope;
  const loadingMore = !loading && list.requestId !== request.id;
  const items = loading ? [] : list.items;
  const hasMore = !loading && list.hasMore;
  const totalCount = loading ? 0 : list.total;

  const loadMore = useCallback(() => {
    setRequest((current) => ({
      id: current.id + 1,
      scope: current.scope,
      offset: list.items.length,
      limit: PAGE_SIZE,
      append: true,
    }));
  }, [list.items.length]);

  // Nach dem Löschen: dieselbe Auswahl ab vorn, so viele wie geladen waren.
  const reloadList = useCallback(() => {
    setReloadCount((count) => count + 1);
    setRequest((current) => ({
      id: current.id + 1,
      scope: current.scope,
      offset: 0,
      limit: Math.max(PAGE_SIZE, list.items.length),
      append: false,
    }));
  }, [list.items.length]);

  // ---------------------------------------------------------------------------
  // Geöffnete Konversation, vorherige/nächste
  // ---------------------------------------------------------------------------

  // Schlüssel der geladenen Konversation (Panel) – damit auch eine per Link
  // geöffnete Zeile in der Liste markiert ist, deren erste Zeile im Zeitraum
  // eine andere ist.
  const [loadedKey, setLoadedKey] = useState({ chatId: null, key: null });
  const handleLoaded = useCallback(
    (summary) => setLoadedKey({ chatId, key: summary?.key ?? null }),
    [chatId]
  );
  let currentIndex =
    chatId === null
      ? -1
      : items.findIndex((item) => item.first_chat_id === chatId);
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
  // Zeile; ein Klick in die Liste verschiebt sie nicht (AK-4).
  const followCurrent = useRef(false);
  // „Nächste" am Ende der geladenen Konversationen: nachladen, dann weiter.
  const [advanceAfter, setAdvanceAfter] = useState(null);
  const navigate = (direction) => {
    if (currentIndex < 0) return;
    const target = currentIndex + direction;
    followCurrent.current = true;
    if (target >= 0 && target < items.length) openRow(items[target]);
    else if (direction === 1 && hasMore && !loadingMore) {
      setAdvanceAfter(conversationKey(items[currentIndex]));
      loadMore();
    }
  };
  useEffect(() => {
    if (advanceAfter === null || loadingMore) return;
    const index = items.findIndex(
      (item) => conversationKey(item) === advanceAfter
    );
    setAdvanceAfter(null);
    if (index >= 0 && index + 1 < items.length) openRow(items[index + 1]);
  }, [advanceAfter, loadingMore, items, openRow]);

  // Die markierte Zeile bleibt im Blick, wenn das Panel blättert (nur, wenn
  // sie neben dem Panel steht: ab lg).
  const rowRefs = useRef(new Map());
  const currentKey = currentRow ? conversationKey(currentRow) : null;
  useEffect(() => {
    if (!currentKey || !followCurrent.current) return;
    followCurrent.current = false;
    const wide =
      typeof window !== "undefined" &&
      window.matchMedia?.("(min-width: 1024px)")?.matches;
    if (wide)
      rowRefs.current.get(currentKey)?.scrollIntoView?.({ block: "nearest" });
  }, [currentKey]);

  // AK-18: ↑/↓ in der Liste – nur, wenn der Fokus auf einer Zeile steht.
  const handleRowKeyDown = (event, index) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const target = index + (event.key === "ArrowDown" ? 1 : -1);
    if (target < 0 || target >= items.length) return;
    event.preventDefault();
    rowRefs.current.get(conversationKey(items[target]))?.focus?.();
    if (chatId !== null) openRow(items[target]);
  };

  const handleDeleted = ({ deleted }) => {
    if (deleted) place.closeConversation();
    reloadList();
  };

  // ---------------------------------------------------------------------------
  // Suche: Eingabe verzögert in die Adresse
  // ---------------------------------------------------------------------------

  const [draft, setDraft] = useState(place.search);
  const [seenSearch, setSeenSearch] = useState(place.search);
  // Von außen geändert (✕, Zurück-Knopf, Link): das Feld folgt.
  if (seenSearch !== place.search) {
    setSeenSearch(place.search);
    if (effectiveSearch(draft) !== place.search) setDraft(place.search);
  }
  const setPlaceSearch = place.setSearch;
  useEffect(() => {
    const term = effectiveSearch(draft);
    if (term === place.search) return;
    const timer = setTimeout(() => setPlaceSearch(term), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [draft, place.search, setPlaceSearch]);
  const clearSearch = () => {
    setDraft("");
    setPlaceSearch("");
  };

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

  // Die Kopfzeile der Ansicht nennt, wie viele Konversationen die Liste zeigt.
  const viewableCount = loading ? null : totalCount;
  useEffect(() => {
    onViewableCountChange(viewableCount);
  }, [viewableCount, onViewableCountChange]);

  const today = berlinDay(new Date());
  const groups = groupByLastMessageDay(items);
  const locale = i18n.language;

  return (
    <div>
      {/* Kopfzeile – immer sichtbar, auch im Lade- und Leer-Zustand. */}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
          <h3
            ref={headingRef}
            tabIndex={-1}
            data-list-heading=""
            className="text-base font-semibold text-theme-text-primary"
          >
            {t("embed-analytics.list.title")}
          </h3>
          {!loading && (
            <span
              data-viewable-count=""
              title={t("embed-analytics.list.viewable-hint")}
              className={`text-sm ${MUTED}`}
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
            />
          )}
          {search && (
            <FilterMark
              data-search-filter-mark=""
              label={t("embed-analytics.search.mark", { term: search })}
              clearLabel={t("embed-analytics.search.clear", { term: search })}
              onClear={clearSearch}
            />
          )}
        </div>
        <div
          data-list-tools=""
          className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:justify-end"
        >
          <label className="flex h-11 min-w-0 flex-[1_1_100%] items-center gap-2 rounded-lg border border-white/10 bg-theme-settings-input-bg px-3 text-theme-text-secondary sm:h-10 sm:w-64 sm:flex-none light:border-gray-200">
            <MagnifyingGlass
              size={16}
              aria-hidden="true"
              className="shrink-0"
            />
            <input
              type="search"
              data-search-input=""
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter")
                  setPlaceSearch(effectiveSearch(draft));
              }}
              maxLength={200}
              placeholder={t("embed-analytics.search.placeholder")}
              aria-label={t("embed-analytics.search.label")}
              className="min-w-0 flex-1 border-0 bg-transparent p-0 text-sm text-theme-text-primary outline-none placeholder:text-theme-settings-input-placeholder focus:ring-0"
            />
          </label>
          <div
            role="group"
            data-feedback-filters=""
            aria-label={t("embed-analytics.rows.filter-group")}
            className="flex min-w-0 flex-1 gap-0.5 rounded-lg border border-white/10 bg-theme-settings-input-bg p-0.5 sm:flex-none light:border-gray-200"
          >
            <button
              type="button"
              aria-pressed={feedbackFilter === "all"}
              aria-label={t("embed-analytics.rows.all-hint")}
              title={t("embed-analytics.rows.all-hint")}
              onClick={() => onFeedbackFilterChange("all")}
              className={`${SEGMENT_CLASS} flex-1 justify-center sm:flex-none ${feedbackFilter === "all" ? SEGMENT_ACTIVE : SEGMENT_INACTIVE}`}
            >
              {t("embed-analytics.rows.all")}
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
                  {/* Schmale Fenster: der kurze Text, damit alle
                      Schaltflächen in eine Zeile passen. */}
                  <span className="sm:hidden">{t(`${labelKey}-short`)}</span>
                  <span className="hidden sm:inline">{t(labelKey)}</span>
                </button>
              );
            })}
          </div>
          {/* KIE-538: Export der Auswahl, die die Liste gerade zeigt */}
          <ExportMenu
            embedId={embedId}
            startDate={startDate}
            endDate={endDate}
            feedbackFilter={feedbackFilter}
            bucket={bucket}
            search={search}
            disabled={loading || totalCount === 0}
            className="flex h-11 items-center gap-2 whitespace-nowrap rounded-lg border border-white/10 bg-theme-settings-input-bg px-3.5 text-sm text-theme-text-primary transition-colors hover:border-white/20 sm:h-10 light:border-gray-200"
          />
        </div>
      </div>

      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1">
          {loading ? (
            <div className="text-white">{t("common.loading")}</div>
          ) : items.length === 0 ? (
            search ? (
              <p
                data-empty-search=""
                className={`rounded-xl border border-white/10 px-4 py-3 text-sm ${MUTED}`}
              >
                {t("embed-analytics.search.empty", { term: search })}
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
              {groups.map((group, groupIndex) => {
                const label = dayGroupLabel(group.day, today, { t, locale });
                // Die letzte Gruppe kann auf der nächsten Seite weitergehen.
                const complete = !(groupIndex === groups.length - 1 && hasMore);
                return (
                  <section
                    key={group.day}
                    data-day-group={group.day}
                    aria-label={label}
                  >
                    <h4
                      className={`flex items-center justify-between gap-3 px-4 pb-1 pt-3 text-xs font-semibold ${MUTED} sm:px-5`}
                    >
                      <span data-day-label="">{label}</span>
                      {complete && (
                        <span data-day-count="">
                          {t("embed-analytics.rows.group-count", {
                            count: group.conversations.length,
                            formatted: formatNumber(group.conversations.length),
                          })}
                        </span>
                      )}
                    </h4>
                    <ul>
                      {group.conversations.map((conversation) => {
                        const index = items.indexOf(conversation);
                        const key = conversationKey(conversation);
                        return (
                          <li key={conversation.first_chat_id}>
                            <ConversationRow
                              conversation={conversation}
                              today={today}
                              selected={index === currentIndex}
                              onOpen={() => openRow(conversation)}
                              onKeyDown={(event) =>
                                handleRowKeyDown(event, index)
                              }
                              buttonRef={(element) => {
                                if (element) rowRefs.current.set(key, element);
                                else rowRefs.current.delete(key);
                              }}
                            />
                          </li>
                        );
                      })}
                    </ul>
                  </section>
                );
              })}
              {hasMore && (
                <div className="flex justify-center border-t border-white/5 px-4 py-3 light:border-gray-100">
                  <button
                    type="button"
                    data-load-more=""
                    onClick={loadMore}
                    disabled={loadingMore}
                    className="h-11 rounded-lg border border-white/10 px-4 text-sm text-theme-text-primary transition-colors hover:bg-white/5 disabled:opacity-60 sm:h-9 light:border-gray-200 light:hover:bg-black/5"
                  >
                    {loadingMore
                      ? t("embed-analytics.rows.loading-more")
                      : t("embed-analytics.rows.load-more")}
                  </button>
                </div>
              )}
            </div>
          )}

          {/* KIE-536: Das Diagramm zählt weiter, die Inhalte sind gelöscht. */}
          {showDeletedHint && !loading && !hasMore && (
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
            startDate={startDate}
            endDate={endDate}
            canPrevious={currentIndex > 0}
            canNext={
              currentIndex >= 0 && (currentIndex < items.length - 1 || hasMore)
            }
            onNavigate={navigate}
            onClose={place.closeConversation}
            onDeleted={handleDeleted}
            onLoaded={handleLoaded}
            linkOf={(id) => place.conversationUrl(id, embedId)}
          />
        )}
      </div>
    </div>
  );
}

/**
 * Eine Zeile der Liste: Uhrzeit der letzten Nachricht, erste Frage, darunter
 * „N Fragen" (mit „begonnen am …", „Grund: …") und Marken der Bewertungen.
 */
function ConversationRow({
  conversation,
  today,
  selected,
  onOpen,
  onKeyDown,
  buttonRef,
}) {
  const { t, i18n } = useTranslation();
  const time = berlinTime(conversation.last_message_at);
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
        date: shortDayLabel(startedDay, today, i18n.language),
      }),
    reason && t("embed-analytics.rows.reason", { reason }),
  ].filter(Boolean);

  return (
    <button
      type="button"
      ref={buttonRef}
      data-conversation-row={conversation.first_chat_id}
      data-conversation-id={conversation.conversation_id}
      aria-current={selected ? "true" : undefined}
      onClick={onOpen}
      onKeyDown={onKeyDown}
      className={`grid w-full grid-cols-[minmax(0,1fr)_auto_16px] items-center gap-3 border-t border-white/5 px-4 py-2 text-left transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[color:var(--theme-text-primary)] sm:grid-cols-[44px_minmax(0,1fr)_auto_16px] sm:px-5 light:border-gray-100 ${
        selected
          ? "bg-sky-500/15 light:bg-sky-50"
          : "hover:bg-white/5 light:hover:bg-black/[0.03]"
      }`}
    >
      <span
        data-row-time=""
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
        <span
          data-row-meta=""
          className={`truncate text-[13px] leading-[18px] ${MUTED}`}
        >
          <span className="sm:hidden">{time} · </span>
          {meta.join(" · ")}
        </span>
      </span>
      <span className="flex items-center gap-1.5">
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
}

// KIE-508/527: Marke „👍 n" / „👎 n" je Konversation – als Umriss-Daumen.
function RatingBadge({ count, Icon, tone, labelKey }) {
  const { t } = useTranslation();
  if (!(count > 0)) return null;
  const label = t(labelKey, { count });
  const toneClass =
    tone === "positive"
      ? "bg-sky-500/15 text-sky-300 light:bg-sky-50 light:text-sky-700"
      : "bg-orange-500/15 text-orange-300 light:bg-orange-50 light:text-orange-700";
  return (
    <span
      data-rating-badge={tone}
      title={label}
      className={`inline-flex h-6 items-center gap-1 rounded-full px-2 text-xs font-semibold ${toneClass}`}
    >
      <Icon size={13} aria-hidden="true" />
      <span aria-hidden="true">{count}</span>
      <span className="sr-only">{label}</span>
    </span>
  );
}
