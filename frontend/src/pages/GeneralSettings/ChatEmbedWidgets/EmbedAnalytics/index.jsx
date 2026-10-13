import { useState, useEffect, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { CaretDown, Check } from "@phosphor-icons/react";
import Embed from "@/models/embed";
import ConversationList from "./ConversationList";
import StatisticsGrid from "./StatisticsGrid";
import TimelineChart from "./TimelineChart";
import DateRangePicker from "@/components/DateRangePicker";
import showToast from "@/utils/toast";
import paths from "@/utils/paths";
import {
  DEFAULT_RANGE_DAYS,
  allTimeRange,
  lastDaysRange,
  rangeFromDates,
  showsDeletedHint,
  toDayString,
  viewState,
} from "@/utils/analyticsTimeline";

// Ansicht „Konversationen" (KIE-536), von oben nach unten: Kopfzeile mit
// Widget-Auswahl und Zeitraum, Angabe zur Aufbewahrung, Kennzahlen-Streifen,
// Säulendiagramm, Konversationsliste.
//
// Kennzahlen und Diagramm kommen aus einem Aufruf von analytics/summary
// (Zählerbuch) und stimmen deshalb überein; sie bleiben vollständig, wenn
// Konversationsinhalte gelöscht sind. Die Liste liest weiterhin embed_chats
// und arbeitet mit den Zeitstempeln des Browsers.

const MUTED = "text-[color:var(--theme-analytics-text-muted)]";

/**
 * Convert Date|null to ISO string|null for stable useEffect deps.
 */
function toISO(date) {
  return date ? date.toISOString() : null;
}

export default function EmbedAnalyticsView() {
  const [embeds, setEmbeds] = useState([]);
  const [embedsLoaded, setEmbedsLoaded] = useState(false);

  useEffect(() => {
    let ignore = false;
    async function loadEmbeds() {
      const embedsData = (await Embed.embeds()) || [];
      if (ignore) return;
      setEmbeds(embedsData);
      // Auch ohne Widget ist das Laden beendet – sonst bliebe „Laden…" stehen.
      setEmbedsLoaded(true);
    }
    loadEmbeds();
    return () => {
      ignore = true;
    };
  }, []);

  return <AnalyticsScreen embedsLoaded={embedsLoaded} embeds={embeds} />;
}

/**
 * Die Ansicht zu einem Stand der Widget-Liste: „Laden…", der Leerzustand ohne
 * Widget oder die Auswertung.
 * @param {{embedsLoaded: boolean, embeds: Array<object>}} props
 */
export function AnalyticsScreen({ embedsLoaded, embeds }) {
  const { t } = useTranslation();
  const state = viewState({ embedsLoaded, embeds });
  if (state === "loading")
    return <div className="p-6 text-white">{t("common.loading")}</div>;
  if (state === "no-widget") return <NoWidget />;
  return <WidgetAnalytics embeds={embeds} />;
}

function WidgetAnalytics({ embeds }) {
  const { t } = useTranslation();
  const [selectedEmbed, setSelectedEmbed] = useState(embeds[0].id);
  // Zählwerte des Zeitraums: { embedId, data, loading, failed }
  const [summary, setSummary] = useState({
    embedId: null,
    data: null,
    loading: true,
    failed: false,
  });
  // KIE-508/527: Feedback-Filter der Liste – hier geführt, weil auch die
  // Kennzahl „negativ bewertet" ihn setzt.
  const [feedbackFilter, setFeedbackFilter] = useState("all");
  // Abschnitt aus dem Diagramm, auf den die Liste gefiltert ist
  const [bucketFilter, setBucketFilter] = useState({ scope: "", bucket: null });
  // KIE-537: Schalter „Vorzeitraum vergleichen" – standardmäßig aus. Er gilt
  // für die Ansicht, nicht für ein Widget oder einen Zeitraum: Beim Wechsel
  // bleibt er stehen. Nur eingeschaltet fragt die Ansicht den Vorzeitraum an.
  const [compare, setCompare] = useState(false);
  const listRef = useRef(null);

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
        });
      } else {
        setSummary({
          embedId: selectedEmbed,
          data: null,
          loading: false,
          failed: true,
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

  // Der Abschnitts-Filter gilt für genau ein Widget und einen Zeitraum.
  const scope = [selectedEmbed, startDateISO, endDateISO].join("|");
  // Mit einem Wechsel verfällt er – sonst käme er zurück, sobald das frühere
  // Widget oder der frühere Zeitraum wieder gewählt ist.
  if (bucketFilter.bucket && bucketFilter.scope !== scope)
    setBucketFilter({ scope, bucket: null });
  const bucket = bucketFilter.scope === scope ? bucketFilter.bucket : null;
  const selectBucket = (next) => setBucketFilter({ scope, bucket: next });

  const showNegative = () => {
    setFeedbackFilter("negative");
    listRef.current?.scrollIntoView?.({ behavior: "smooth", block: "start" });
  };

  return (
    <div className="flex w-full min-w-0 flex-col p-2 md:p-6">
      <Header
        embeds={embeds}
        selectedEmbed={selectedEmbed}
        onSelectEmbed={setSelectedEmbed}
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
          onShowNegative={showNegative}
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

      <div ref={listRef} className="scroll-mt-4">
        <ConversationList
          embedId={selectedEmbed}
          startDate={startDateISO}
          endDate={endDateISO}
          feedbackFilter={feedbackFilter}
          onFeedbackFilterChange={setFeedbackFilter}
          bucket={bucket}
          onClearBucket={() => selectBucket(null)}
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

/** Kopfzeile: Titel, Widget-Auswahl (nur bei mehreren Widgets) und Zeitraum. */
function Header({
  embeds,
  selectedEmbed,
  onSelectEmbed,
  startDate,
  endDate,
  onDateChange,
}) {
  const { t } = useTranslation();
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

  const embedLabel = (embed) =>
    t("embed-analytics.embed-label", {
      id: embed.id,
      workspace: embed.workspace?.name,
    });
  const current = embeds.find((e) => e.id === selectedEmbed);

  return (
    <div className="flex flex-wrap gap-3 justify-between items-center mb-6">
      <h2 className="text-white text-2xl font-bold">
        {t("embed-analytics.title")}
      </h2>

      <div className="flex flex-wrap gap-3 items-center">
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
                {embeds.map((embed) => (
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
