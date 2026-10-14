import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { CaretDown, Check } from "@phosphor-icons/react";
import Embed from "@/models/embed";
import ConversationList from "./ConversationList";
import StatisticsGrid from "./StatisticsGrid";
import TimelineChart from "./TimelineChart";
import WeekdayHourCard from "./WeekdayHourCard";
import DateRangePicker from "@/components/DateRangePicker";
import showToast from "@/utils/toast";
import paths from "@/utils/paths";
import {
  DEFAULT_RANGE_DAYS,
  allTimeRange,
  formatNumber,
  lastDaysRange,
  rangeFromDates,
  showsDeletedHint,
  toDayString,
  viewState,
} from "@/utils/analyticsTimeline";
import {
  embedLabels,
  mostRecentlyActiveEmbedId,
  sortEmbedsByLabel,
} from "@/utils/embedLabel";
import {
  AVATAR_CLEARANCE,
  MUTED,
  effectiveSearch,
  holdScrollTarget,
  isWide,
  revealMarkedRow,
  sameBerlinDays,
} from "@/utils/conversationView";
import useConversationLocation from "./useConversationLocation";

// Ansicht „Konversationen" (KIE-536), von oben nach unten: Kopfzeile mit
// Widget-Auswahl und Zeitraum, Angabe zur Aufbewahrung, Kennzahlen-Streifen,
// Säulendiagramm, Karte „Wann schreiben Ihre Besucher?" (KIE-539),
// Konversationsliste mit Seitenpanel.
//
// Widget, geöffnete Konversation und Suche stehen in der Adresse
// (useConversationLocation): Ein Link auf eine Konversation lässt sich
// teilen, der Zurück-Knopf schließt sie wieder. Kennzahlen, Diagramm und
// Uhrzeit-Karte hängen nur von Widget und Zeitraum ab – Suche und geöffnete
// Konversation ändern sie nicht.
//
// Kennzahlen und Diagramm kommen aus einem Aufruf von analytics/summary
// (Zählerbuch) und stimmen deshalb überein; sie bleiben vollständig, wenn
// Konversationsinhalte gelöscht sind. Die Liste liest weiterhin embed_chats
// und arbeitet mit den Zeitstempeln des Browsers.

/**
 * Convert Date|null to ISO string|null for stable useEffect deps.
 */
function toISO(date) {
  return date ? date.toISOString() : null;
}

/** Der gewählte Zeitraum als ein Wert zum Vergleichen (null = „Gesamt"). */
const periodOf = (fromDay, toDay) => `${fromDay}|${toDay}`;

export default function EmbedAnalyticsView() {
  const [embeds, setEmbeds] = useState([]);
  const [lastActivity, setLastActivity] = useState(null);
  const [embedsLoaded, setEmbedsLoaded] = useState(false);

  useEffect(() => {
    let ignore = false;
    async function loadEmbeds() {
      // Widgets und ihre letzte Nachricht nebeneinander (Fixliste 6, N2):
      // Die Vorauswahl steht fest, bevor die Ansicht etwas lädt.
      const [embedsData, activity] = await Promise.all([
        Embed.embeds(),
        Embed.lastActivity(),
      ]);
      if (ignore) return;
      setEmbeds(embedsData || []);
      setLastActivity(activity);
      // Auch ohne Widget ist das Laden beendet – sonst bliebe „Laden…" stehen.
      setEmbedsLoaded(true);
    }
    loadEmbeds();
    return () => {
      ignore = true;
    };
  }, []);

  return (
    <AnalyticsScreen
      embedsLoaded={embedsLoaded}
      embeds={embeds}
      lastActivity={lastActivity}
    />
  );
}

/**
 * Die Ansicht zu einem Stand der Widget-Liste: „Laden…", der Leerzustand ohne
 * Widget oder die Auswertung.
 * @param {{embedsLoaded: boolean, embeds: Array<object>, lastActivity?: Array<{embedId: number, lastMessageAt: number|null}>|null}} props
 *   lastActivity: letzte Nachricht je Widget (Vorauswahl); null ohne Angabe
 */
export function AnalyticsScreen({ embedsLoaded, embeds, lastActivity = null }) {
  const { t } = useTranslation();
  const state = viewState({ embedsLoaded, embeds });
  if (state === "loading")
    return <div className="p-6 text-white">{t("common.loading")}</div>;
  if (state === "no-widget") return <NoWidget />;
  return <WidgetAnalytics embeds={embeds} lastActivity={lastActivity} />;
}

function WidgetAnalytics({ embeds, lastActivity }) {
  const { t } = useTranslation();
  const place = useConversationLocation();
  // Das Widget aus der Adresse – nur eines, das der Nutzer sehen darf (die
  // Liste der Widgets kommt vom Server, gefiltert nach seinen Rechten).
  // Vorauswahl ohne widget= (Fixliste 6, N2): das Widget mit der jüngsten
  // Nachricht; ohne Nachrichten bzw. ohne Angabe das erste in der
  // Reihenfolge des Servers (das zuletzt angelegte) – unabhängig davon, wie
  // die Auswahl ihre Einträge ordnet.
  const preferredEmbed = useMemo(
    () => mostRecentlyActiveEmbedId(embeds, lastActivity),
    [embeds, lastActivity]
  );
  const linkedEmbed = embeds.find((embed) => embed.id === place.widgetId);
  const selectedEmbed = linkedEmbed ? linkedEmbed.id : preferredEmbed;
  const setSelectedEmbed = place.setWidget;
  // Ein Link auf ein Widget, das es für diesen Nutzer nicht gibt (fremd,
  // gelöscht): Hinweis, die Ansicht zeigt das vorausgewählte Widget ohne
  // Konversation.
  const unknownLink = place.widgetId !== null && !linkedEmbed;
  const clearLink = place.clearLink;
  useEffect(() => {
    if (!unknownLink) return;
    showToast(t("embed-analytics.panel.not-found"), "error");
    clearLink();
  }, [unknownLink, clearLink, t]);
  // Zählwerte des Zeitraums: { embedId, data, loading, failed, period } –
  // period ist der gewählte Zeitraum, zu dem data gehört.
  const [summary, setSummary] = useState({
    embedId: null,
    data: null,
    loading: true,
    failed: false,
    period: null,
  });
  // KIE-508/527: Feedback-Filter der Liste – hier geführt, weil auch die
  // Verweise „N positiv"/„N negativ" im Feld „Bewertungen" ihn setzen.
  const [feedbackFilter, setFeedbackFilter] = useState("all");
  // Abschnitt aus dem Diagramm, auf den die Liste gefiltert ist
  const [bucketFilter, setBucketFilter] = useState({ scope: "", bucket: null });
  // KIE-537: Schalter „Vorzeitraum vergleichen" – standardmäßig aus. Er gilt
  // für die Ansicht, nicht für ein Widget oder einen Zeitraum: Beim Wechsel
  // bleibt er stehen. Nur eingeschaltet fragt die Ansicht den Vorzeitraum an.
  const [compare, setCompare] = useState(false);
  const listRef = useRef(null);
  const listHeadingRef = useRef(null);
  // Einsehbare Konversationen der Liste (null, solange sie lädt) – für den
  // Verweis in der Kopfzeile.
  const [viewableCount, setViewableCount] = useState(null);

  // Date range as Date objects (null = "all time"). Standard: letzte 30 Tage.
  const [startDate, setStartDate] = useState(
    () => lastDaysRange(DEFAULT_RANGE_DAYS).startDate
  );
  const [endDate, setEndDate] = useState(
    () => lastDaysRange(DEFAULT_RANGE_DAYS).endDate
  );

  // ISO strings for stable useEffect dependencies
  const startDateISO = toISO(startDate);
  const endDateISO = toISO(endDate);
  // Die Kalendertage, die der Nutzer gewählt hat (null = „Gesamt")
  const range = rangeFromDates(startDate, endDate);
  const fromDay = range?.fromDay ?? null;
  const toDay = range?.toDay ?? null;

  useEffect(() => {
    if (!selectedEmbed) return;
    let ignore = false;

    async function loadSummary() {
      setSummary((current) => ({
        embedId: selectedEmbed,
        // Beim Wechsel des Zeitraums bleibt die bisherige Darstellung stehen,
        // beim Wechsel des Widgets nicht.
        data: current.embedId === selectedEmbed ? current.data : null,
        loading: true,
        failed: false,
        period: current.period,
      }));

      let days = fromDay && toDay ? { fromDay, toDay } : null;
      if (!days) {
        // „Gesamt": Der Endpunkt nimmt nur Kalendertage an. Der erste Tag mit
        // Zählwerten steht in jeder Antwort – also erst nach heute fragen.
        const today = toDayString(new Date());
        const probe = await Embed.getAnalyticsSummary(
          selectedEmbed,
          today,
          today
        );
        if (ignore) return;
        days = probe?.success
          ? allTimeRange(probe.firstLedgerDay, today)
          : null;
      }

      const data = days
        ? await Embed.getAnalyticsSummary(
            selectedEmbed,
            days.fromDay,
            days.toDay,
            { compare }
          )
        : null;
      if (ignore) return;

      if (data?.success) {
        setSummary({
          embedId: selectedEmbed,
          data,
          loading: false,
          failed: false,
          period: periodOf(fromDay, toDay),
        });
      } else {
        setSummary({
          embedId: selectedEmbed,
          data: null,
          loading: false,
          failed: true,
          period: null,
        });
        showToast(t("embed-analytics.load-error"), "error");
      }
    }

    loadSummary();
    return () => {
      ignore = true;
    };
  }, [selectedEmbed, fromDay, toDay, compare, t]);

  const handleDateChange = useCallback(
    ({ startDate: newStart, endDate: newEnd }) => {
      setStartDate(newStart);
      setEndDate(newEnd);
    },
    []
  );

  const currentEmbed = embeds.find((e) => e.id === selectedEmbed);
  const retentionDays = currentEmbed?.chat_retention_days || null;
  const summaryData = summary.embedId === selectedEmbed ? summary.data : null;
  // KIE-539: Die Karte „Wann schreiben Ihre Besucher?" zeigt nur den gewählten
  // Zeitraum, nie den Vorzeitraum. Lädt die Ansicht denselben Zeitraum noch
  // einmal – das ist der Schalter „Vorzeitraum vergleichen" (KIE-537) –,
  // bleibt die Karte stehen, wie sie ist: Ihr Inhalt ändert sich nicht.
  const cardLoading =
    summary.loading &&
    !(summaryData && summary.period === periodOf(fromDay, toDay));

  // Kennzahl „Konversationen“ für den Hinweis der Liste auf fehlende
  // Inhalte (Fixliste 6, N1) – nur, wenn sie zu genau diesem Widget und
  // Zeitraum gehört und die Liste dieselben Berliner Tage zeigt; sonst null
  // (kein Hinweis). Beim Neuladen desselben Zeitraums (Vergleich an/aus)
  // bleibt sie stehen.
  const countedConversations =
    summaryData &&
    summary.period === periodOf(fromDay, toDay) &&
    sameBerlinDays(startDateISO, endDateISO, fromDay, toDay)
      ? (summaryData.totals?.conversations ?? null)
      : null;

  // Der Abschnitts-Filter gilt für genau ein Widget und einen Zeitraum.
  const scope = [selectedEmbed, startDateISO, endDateISO].join("|");
  // Mit einem Wechsel verfällt er – sonst käme er zurück, sobald das frühere
  // Widget oder der frühere Zeitraum wieder gewählt ist.
  if (bucketFilter.bucket && bucketFilter.scope !== scope)
    setBucketFilter({ scope, bucket: null });
  const bucket = bucketFilter.scope === scope ? bucketFilter.bucket : null;
  const scrollToList = () =>
    listRef.current?.scrollIntoView?.({ behavior: "smooth", block: "start" });
  // Klick auf eine Säule filtert die Liste und springt zu ihr – wie „N
  // negativ" und der Verweis in der Kopfzeile (AK-17, Fixliste 2 B3). Der
  // zweite Klick (Filter aufheben) springt nicht.
  const selectBucket = (next) => {
    setBucketFilter({ scope, bucket: next });
    if (next) scrollToList();
  };
  const clearBucket = () => selectBucket(null);

  const showRated = (mode) => {
    setFeedbackFilter(mode);
    scrollToList();
  };
  // Verweis in der Kopfzeile: weich zur Liste, der Fokus auf ihre Überschrift
  // (ohne zweites, hartes Scrollen).
  const jumpToList = () => {
    scrollToList();
    listHeadingRef.current?.focus?.({ preventScroll: true });
  };

  // Per Link oder nach dem Neuladen mit geöffneter Konversation: einmal zur
  // Liste springen, sobald Kennzahlen und Liste stehen – sonst läge das
  // Panel unter dem sichtbaren Bereich (Fixliste 2, B5). Nur ab lg: darunter
  // öffnet die Konversation ohnehin als Vollbild. Ein Merker: true, solange
  // der Sprung aussteht (Fixliste 3, S4).
  // Der Sprung hält, bis der Nutzer selbst scrollt oder etwas tut: Ändert
  // sich danach das Layout über der Liste oder setzt der Browser die
  // Scrollposition, springt die Ansicht erneut (holdScrollTarget) – ein
  // einmaliger Sprung ließ die Seite manchmal ungescrollt (Fixliste 4, V7).
  const [linkJumpPending, setLinkJumpPending] = useState(
    () => place.chatId !== null
  );
  const listReady = viewableCount !== null && !summary.loading;
  const releaseLinkJump = useRef(null);
  useEffect(() => {
    if (!linkJumpPending || !listReady) return;
    setLinkJumpPending(false);
    if (!isWide()) return;
    // Zur Überschrift der Liste; steht die geöffnete Zeile dann unter dem
    // Fensterrand (Zeile 45), weiter bis zu ihr – das Panel klebt oben und
    // bleibt sichtbar (Fixliste 6, K5).
    releaseLinkJump.current = holdScrollTarget(listRef.current, () => {
      listRef.current?.scrollIntoView?.({ block: "start" });
      revealMarkedRow(listRef.current);
    });
  }, [linkJumpPending, listReady]);
  useEffect(() => () => releaseLinkJump.current?.(), []);
  // Die per Link geöffnete Zeile ist (nach)geladen und markiert: noch einmal
  // ausrichten, solange der Sprung hält.
  const revealLinkedRow = useCallback(
    () => releaseLinkJump.current?.realign?.(),
    []
  );

  return (
    <div className="flex w-full min-w-0 flex-col p-2 md:p-6">
      <Header
        embeds={embeds}
        selectedEmbed={selectedEmbed}
        onSelectEmbed={setSelectedEmbed}
        viewableCount={viewableCount}
        feedbackFilter={feedbackFilter}
        bucket={bucket}
        search={effectiveSearch(place.search)}
        onJumpToList={jumpToList}
        startDate={startDate}
        endDate={endDate}
        onDateChange={handleDateChange}
      />

      {/* Aufbewahrung: eine Zeile statt des bisherigen Kastens */}
      {retentionDays > 0 && (
        <p data-retention-line="" className={`-mt-2 mb-4 text-sm ${MUTED}`}>
          {t("embed-analytics.retention-line", { count: retentionDays })}
        </p>
      )}

      <div className="mb-4">
        <StatisticsGrid
          summary={summaryData}
          loading={summary.loading}
          compare={compare}
          onShowRated={showRated}
          embedId={selectedEmbed}
          startDate={startDateISO}
          endDate={endDateISO}
        />
      </div>

      <div className="mb-6">
        <TimelineChart
          summary={summaryData}
          loading={summary.loading}
          failed={summary.failed}
          selectedBucket={bucket}
          onSelectBucket={selectBucket}
          compare={compare}
          onCompareChange={setCompare}
        />
      </div>

      {/* KIE-539: Nachrichten nach Wochentag und Uhrzeit – aus derselben
          Antwort wie Kennzahlen und Diagramm; ohne den Vergleich (KIE-537) */}
      <WeekdayHourCard
        summary={summaryData}
        loading={cardLoading}
        failed={summary.failed}
      />

      {/* Sprungziel: Überschrift und Werkzeugleiste landen unter dem
          Benutzermenü oben rechts (Fixliste 3, V2) */}
      <div ref={listRef} className={AVATAR_CLEARANCE.jumpTarget}>
        <ConversationList
          embedId={unknownLink ? null : selectedEmbed}
          startDate={startDateISO}
          endDate={endDateISO}
          feedbackFilter={feedbackFilter}
          onFeedbackFilterChange={setFeedbackFilter}
          bucket={bucket}
          onClearBucket={clearBucket}
          onViewableCountChange={setViewableCount}
          countedConversations={countedConversations}
          onLinkedRowShown={revealLinkedRow}
          headingRef={listHeadingRef}
          showDeletedHint={showsDeletedHint({
            retentionDays,
            startDay: bucket?.start ?? summaryData?.fromDay ?? fromDay,
            today: toDayString(new Date()),
          })}
        />
      </div>
    </div>
  );
}

/**
 * Text des Verweises zur Liste. Er nennt die Zahl der Liste und, was sie
 * filtert: „18 negativ bewertete Konversationen ansehen", „4 Konversationen
 * aus „Di., 06.10.2026" ansehen"; mit Bewertungsfilter und Abschnitt kurz
 * „3 gefilterte Konversationen ansehen" – die Liste zeigt beide Markierungen.
 * @param {Function} t
 * @param {number|null} count - null, solange die Liste lädt
 * @param {"all"|"negative"|"positive"} feedbackFilter
 * @param {{label: string}|null} bucket
 * @param {string} [search] - Suchbegriff der Liste: allein „3 Konversationen
 *   mit „spanisch" ansehen", mit weiteren Filtern „gefilterte"
 */
function jumpText(t, count, feedbackFilter, bucket, search = "") {
  if (count === null) return t("embed-analytics.list.jump-pending");
  const values = { count, formatted: formatNumber(count) };
  const rated = feedbackFilter === "negative" || feedbackFilter === "positive";
  if (search && !rated && !bucket)
    return t("embed-analytics.search.jump", { ...values, term: search });
  if ((rated && bucket) || search)
    return t("embed-analytics.list.jump-filtered", values);
  if (rated) return t(`embed-analytics.list.jump-${feedbackFilter}`, values);
  if (bucket)
    return t("embed-analytics.list.jump-bucket", {
      ...values,
      period: bucket.label,
    });
  return t("embed-analytics.list.jump", values);
}

/**
 * Kopfzeile: Titel mit dem Verweis zur Liste, Widget-Auswahl (nur bei
 * mehreren Widgets) und Zeitraum.
 */
function Header({
  embeds,
  selectedEmbed,
  onSelectEmbed,
  viewableCount,
  feedbackFilter,
  bucket,
  search,
  onJumpToList,
  startDate,
  endDate,
  onDateChange,
}) {
  const { t, i18n } = useTranslation();
  const [embedDropdownOpen, setEmbedDropdownOpen] = useState(false);
  const embedDropdownRef = useRef(null);

  // Close embed dropdown on outside click
  useEffect(() => {
    if (!embedDropdownOpen) return;
    function handleMouseDown(e) {
      if (
        embedDropdownRef.current &&
        !embedDropdownRef.current.contains(e.target)
      ) {
        setEmbedDropdownOpen(false);
      }
    }
    document.addEventListener("mousedown", handleMouseDown);
    return () => document.removeEventListener("mousedown", handleMouseDown);
  }, [embedDropdownOpen]);

  // Ein Widget heißt wie sein Workspace; die Widget-Nummer kommt nur dazu, wo
  // die Bezeichnung in dieser Liste mehrfach vorkommt (utils/embedLabel).
  const labels = useMemo(() => embedLabels(embeds, t), [embeds, t]);
  const options = useMemo(
    () => sortEmbedsByLabel(embeds, labels, i18n.language),
    [embeds, labels, i18n.language]
  );
  const embedLabel = (embed) => labels.get(embed.id)?.label;
  const current = embeds.find((e) => e.id === selectedEmbed);

  return (
    <div className="flex flex-wrap gap-3 justify-between items-center mb-6">
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-white text-2xl font-bold">
          {t("embed-analytics.title")}
        </h2>
        {/* Sprung zur Liste. Ohne einsehbare Konversation entfällt er: Die
            Liste sagt es selbst, und „keine Konversationen“ stünde neben der
            Kennzahl „Konversationen“ aus dem Zählerbuch, die mehr zählt. */}
        {viewableCount !== 0 && (
          <button
            type="button"
            data-jump-to-list=""
            onClick={onJumpToList}
            className={`text-sm ${MUTED} underline underline-offset-2 hover:text-theme-text-primary`}
          >
            {jumpText(t, viewableCount, feedbackFilter, bucket, search)}
            <span aria-hidden="true"> ↓</span>
          </button>
        )}
      </div>

      {/* md:pr-12: Widget-Auswahl und Zeitraum enden links vom schwebenden
          Benutzermenü oben rechts („KI") – es läge sonst auf ihrem Rand
          (Fixliste 2, B4). */}
      <div
        className={`flex flex-wrap gap-3 items-center ${AVATAR_CLEARANCE.headerEnd}`}
      >
        {/* Widget-Auswahl – bei genau einem Widget gibt es nichts zu wählen. */}
        {embeds.length > 1 && (
          <div className="relative" ref={embedDropdownRef}>
            <button
              type="button"
              aria-haspopup="listbox"
              aria-expanded={embedDropdownOpen}
              aria-label={t("embed-analytics.widget-label")}
              onClick={() => setEmbedDropdownOpen(!embedDropdownOpen)}
              className="flex items-center gap-2 bg-theme-settings-input-bg text-theme-text-primary rounded-lg px-4 py-2 text-sm border border-white/10 cursor-pointer"
            >
              <span>
                {current
                  ? embedLabel(current)
                  : t("embed-analytics.select-embed")}
              </span>
              <CaretDown
                size={12}
                className={`text-theme-text-primary ml-1 transition-transform ${embedDropdownOpen ? "rotate-180" : ""}`}
              />
            </button>

            {embedDropdownOpen && (
              <div
                role="listbox"
                aria-label={t("embed-analytics.widget-label")}
                className="absolute left-0 top-full mt-1 w-full bg-theme-bg-secondary border border-white/10 rounded-lg shadow-xl z-50 overflow-hidden"
              >
                {options.map((embed) => (
                  <button
                    key={embed.id}
                    type="button"
                    role="option"
                    aria-selected={selectedEmbed === embed.id}
                    onClick={() => {
                      onSelectEmbed(embed.id);
                      setEmbedDropdownOpen(false);
                    }}
                    className={`flex items-center justify-between w-full px-3 py-2 text-sm text-left transition-all cursor-pointer
                      ${selectedEmbed === embed.id ? "bg-white/10 text-theme-text-primary font-medium" : "text-theme-text-secondary hover:bg-white/5 hover:text-theme-text-primary"}`}
                  >
                    <span>{embedLabel(embed)}</span>
                    {selectedEmbed === embed.id && (
                      <Check
                        size={14}
                        className="text-theme-text-primary"
                        weight="bold"
                      />
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Date Range Picker */}
        <DateRangePicker
          startDate={startDate}
          endDate={endDate}
          onChange={onDateChange}
        />
      </div>
    </div>
  );
}

/** Leerzustand: Der Nutzer kann kein einziges Widget sehen. */
function NoWidget() {
  const { t } = useTranslation();
  return (
    <div className="flex w-full min-w-0 flex-col p-2 md:p-6">
      <h2 className="text-white text-2xl font-bold mb-6">
        {t("embed-analytics.title")}
      </h2>
      <div
        data-empty-state="no-widget"
        className="flex flex-col items-center rounded-xl border border-dashed border-white/10 px-4 py-12 text-center"
      >
        <p className="text-base font-semibold text-theme-text-primary">
          {t("embed-analytics.no-widget.title")}
        </p>
        <p className={`mt-2 max-w-md text-sm ${MUTED}`}>
          {t("embed-analytics.no-widget.description")}
        </p>
        <Link
          to={paths.settings.chatbot.widgets()}
          className="mt-4 text-sm text-theme-text-primary underline underline-offset-2"
        >
          {t("embed-analytics.no-widget.link")}
        </Link>
      </div>
    </div>
  );
}
