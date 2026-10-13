import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { CaretDown, CaretUp, Info } from "@phosphor-icons/react";
import Embed from "@/models/embed";
import useUser from "@/hooks/useUser";
import { formatNumber, kpiValues } from "@/utils/analyticsTimeline";

// KIE-536 – Kennzahlen-Streifen: vier Felder aus dem Zählerbuch
// (analytics/summary), dieselbe Quelle wie das Diagramm. Die einklappbaren
// technischen Details für Admins lesen weiterhin analytics/overview, also die
// noch vorhandenen Konversationsinhalte – deshalb steht dort, was sie zählen.

const MUTED = "text-[color:var(--theme-analytics-text-muted)]";
const NO_VALUE = "–";

/**
 * @param {Object} props
 * @param {import("@/utils/analyticsTimeline").Summary|null} props.summary
 * @param {boolean} props.loading
 * @param {() => void} props.onShowNegative - setzt den Listenfilter „negativ"
 * @param {number|null} props.embedId
 * @param {string|null} props.startDate - ISO-Zeitstempel (für die technischen Details)
 * @param {string|null} props.endDate
 */
export default function StatisticsGrid({
  summary,
  loading,
  onShowNegative,
  embedId,
  startDate,
  endDate,
}) {
  const { t } = useTranslation();
  const { user } = useUser();
  const kpi = kpiValues(summary);
  const value = (number) => (summary ? formatNumber(number) : NO_VALUE);
  const granularity = summary?.granularity ?? "day";

  const fields = [
    {
      key: "messages",
      label: t("embed-analytics.kpi.messages"),
      value: value(kpi.messages),
      detail:
        summary && kpi.averagePerBucket !== null
          ? t(`embed-analytics.kpi.avg-per.${granularity}`, {
              value: formatNumber(kpi.averagePerBucket, 1),
            })
          : NO_VALUE,
    },
    {
      key: "conversations",
      label: t("embed-analytics.kpi.conversations"),
      hint: t("embed-analytics.kpi.conversations-hint"),
      value: value(kpi.conversations),
      detail:
        kpi.averagePerConversation !== null
          ? t("embed-analytics.kpi.avg-per-conversation", {
              value: formatNumber(kpi.averagePerConversation, 1),
            })
          : NO_VALUE,
    },
    {
      key: "positive",
      label: t("embed-analytics.kpi.positive"),
      value: value(kpi.positive),
      detail:
        kpi.positiveShare !== null
          ? t("embed-analytics.kpi.positive-share", {
              value: formatNumber(kpi.positiveShare),
            })
          : summary
            ? t("embed-analytics.kpi.no-ratings")
            : NO_VALUE,
    },
    {
      key: "negative",
      label: t("embed-analytics.kpi.negative"),
      value: value(kpi.negative),
      // Der Verweis filtert die Liste auf negativ bewertete Konversationen –
      // ohne eine solche Bewertung steht dort der Nebentext.
      ...(kpi.negative > 0
        ? {
            action: {
              label: t("embed-analytics.kpi.show-negative"),
              onClick: onShowNegative,
            },
          }
        : {
            detail: !summary
              ? NO_VALUE
              : kpi.positive > 0
                ? t("embed-analytics.kpi.no-negative")
                : t("embed-analytics.kpi.no-ratings"),
          }),
    },
  ];

  // Trennlinien: schmal 2 × 2, breit vier Felder nebeneinander.
  const divider = (i) =>
    [
      "border-white/10",
      i % 2 === 0 ? "border-r" : "",
      i < 2 ? "border-b lg:border-b-0" : "",
      i < 3 ? "lg:border-r" : "",
    ].join(" ");

  return (
    <div>
      <dl
        aria-label={t("embed-analytics.kpi.aria-label")}
        aria-busy={loading}
        className={`grid grid-cols-2 lg:grid-cols-4 overflow-hidden rounded-xl border border-white/10 bg-theme-bg-primary transition-opacity ${loading && summary ? "opacity-50" : ""}`}
      >
        {fields.map((field, i) => (
          <div
            key={field.key}
            data-kpi={field.key}
            className={`min-w-0 p-4 ${divider(i)}`}
          >
            <dt className={`flex items-start gap-1 text-xs ${MUTED}`}>
              <span>{field.label}</span>
              {field.hint && (
                <span
                  role="img"
                  tabIndex={0}
                  aria-label={field.hint}
                  title={field.hint}
                  className="mt-px shrink-0 rounded-full focus-visible:outline focus-visible:outline-2 focus-visible:outline-[color:var(--theme-text-primary)]"
                >
                  <Info size={13} aria-hidden="true" />
                </span>
              )}
            </dt>
            <dd className="mt-1">
              <span className="block text-2xl md:text-3xl font-semibold text-theme-text-primary">
                {field.value}
              </span>
              {field.detail && (
                <span className={`mt-1 block text-xs ${MUTED}`}>
                  {field.detail}
                </span>
              )}
              {field.action && (
                <button
                  type="button"
                  onClick={field.action.onClick}
                  className="mt-1 block text-left text-xs text-theme-text-primary underline underline-offset-2 hover:no-underline"
                >
                  {field.action.label}
                </button>
              )}
            </dd>
          </div>
        ))}
      </dl>

      {user?.role === "admin" && (
        <TechnicalDetails
          embedId={embedId}
          startDate={startDate}
          endDate={endDate}
        />
      )}
    </div>
  );
}

/**
 * Technische Details (nur admin): Wortzahlen aus analytics/overview. Geladen
 * wird erst beim Aufklappen.
 */
function TechnicalDetails({ embedId, startDate, endDate }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [stats, setStats] = useState(null);

  useEffect(() => {
    if (!open || !embedId) return;
    let ignore = false;
    setStats(null);
    async function loadStats() {
      const { success, stats: data } = await Embed.getAnalyticsOverview(
        embedId,
        startDate,
        endDate
      );
      if (!ignore) setStats(success ? data : {});
    }
    loadStats();
    return () => {
      ignore = true;
    };
  }, [open, embedId, startDate, endDate]);

  const technicalStats = [
    {
      label: t("embed-analytics.stats.avg-words-prompt-label"),
      value: stats?.avg_words_prompt,
      description: t("embed-analytics.stats.avg-words-prompt-desc"),
    },
    {
      label: t("embed-analytics.stats.avg-words-response-label"),
      value: stats?.avg_words_response,
      description: t("embed-analytics.stats.avg-words-response-desc"),
    },
    {
      label: t("embed-analytics.stats.max-words-prompt-label"),
      value: stats?.max_words_prompt,
      description: t("embed-analytics.stats.max-words-prompt-desc"),
    },
  ];

  return (
    <div className="mt-3">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className={`flex items-center gap-2 text-sm ${MUTED} hover:text-theme-text-primary transition-colors`}
      >
        {open ? (
          <CaretUp size={16} weight="bold" aria-hidden="true" />
        ) : (
          <CaretDown size={16} weight="bold" aria-hidden="true" />
        )}
        <span className="font-medium">
          {t("embed-analytics.stats.show-technical")}
        </span>
      </button>

      {open && (
        <div className="mt-3 rounded-xl border border-white/10 bg-theme-bg-primary p-4">
          <p className={`mb-3 text-xs ${MUTED}`}>
            {t("embed-analytics.stats.technical-note")}
          </p>
          <dl className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {technicalStats.map((stat) => (
              <div key={stat.label} className="min-w-0">
                <dt className={`text-xs ${MUTED}`}>{stat.label}</dt>
                <dd className="mt-1">
                  <span className="block text-xl font-semibold text-theme-text-primary">
                    {stats ? formatNumber(stat.value) : t("common.loading")}
                  </span>
                  <span className={`mt-1 block text-xs ${MUTED}`}>
                    {stat.description}
                  </span>
                </dd>
              </div>
            ))}
          </dl>
        </div>
      )}
    </div>
  );
}
