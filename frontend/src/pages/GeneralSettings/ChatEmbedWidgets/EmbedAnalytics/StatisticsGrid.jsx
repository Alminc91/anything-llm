import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { CaretDown, CaretUp, Info } from "@phosphor-icons/react";
import Embed from "@/models/embed";
import useUser from "@/hooks/useUser";
import {
  changeLabel,
  comparisonOf,
  formatDate,
  formatDayRange,
  formatNumber,
  isRunningRange,
  kpiValues,
} from "@/utils/analyticsTimeline";

// KIE-536 – Kennzahlen-Streifen: vier Felder aus dem Zählerbuch
// (analytics/summary), dieselbe Quelle wie das Diagramm. Die einklappbaren
// technischen Details für Admins lesen weiterhin analytics/overview, also die
// noch vorhandenen Konversationsinhalte – deshalb steht dort, was sie zählen.
//
// KIE-537 – Mit eingeschaltetem Vergleich hat jedes Feld eine weitere Zeile:
// die Veränderung gegenüber dem Vorzeitraum (gleich viele Kalendertage
// unmittelbar davor). Die großen Zahlen und die übrigen Nebenwerte bleiben,
// wie sie sind. Mit welchen Tagen verglichen wird, steht einmal sichtbar in
// einer Zeile direkt unter dem Streifen – ein Tooltip allein wäre mit Finger
// und Tastatur nicht zu erreichen. Enthält der Zeitraum den heutigen Tag,
// sagt die Zeile auch das: Verglichen wird dann ein laufender Zeitraum mit
// einem abgeschlossenen.
//
// Gibt es keinen Vergleich (der Vorzeitraum beginnt vor dem ersten Zählwert),
// steht an derselben Stelle einmal, warum – mit dem Tag, ab dem Zählwerte
// vorliegen. Die Zeile gehört zum Streifen und steht direkt über dem
// Diagramm mit dem Schalter: eine Angabe für beide, statt derselben Worte in
// allen vier Feldern und noch einmal am Diagramm. Die Felder selbst bekommen
// dann keine sichtbare Zeile (ihre Höhe ist dieselbe wie ohne Vergleich);
// für Screenreader nennt jedes Feld „Kein Vergleich verfügbar".

const MUTED = "text-[color:var(--theme-analytics-text-muted)]";
const NO_VALUE = "–";

/**
 * @param {Object} props
 * @param {import("@/utils/analyticsTimeline").Summary|null} props.summary
 * @param {boolean} props.loading
 * @param {boolean} [props.compare] - Schalter „Vorzeitraum vergleichen" (KIE-537)
 * @param {() => void} props.onShowNegative - setzt den Listenfilter „negativ"
 * @param {number|null} props.embedId
 * @param {string|null} props.startDate - ISO-Zeitstempel (für die technischen Details)
 * @param {string|null} props.endDate
 */
export default function StatisticsGrid({
  summary,
  loading,
  compare = false,
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

  // KIE-537: Zeile der Veränderung je Feld – null, solange der Vergleich aus
  // ist oder die Antwort noch keinen Vorzeitraum nennt. Der Tooltip nennt die
  // Tage, mit denen verglichen wird.
  const comparison = comparisonOf(summary, compare);
  // Kein Vergleich: warum – mit dem ersten Tag der Zählwerte, wenn es einen
  // gibt. Steht einmal, in der Zeile unter dem Streifen.
  const unavailableReason =
    comparison && !comparison.available
      ? comparison.since
        ? t("embed-analytics.compare.unavailable-since", {
            date: formatDate(comparison.since),
          })
        : t("embed-analytics.compare.unavailable-no-counts")
      : null;
  // Die Tage des Vorzeitraums der Kennzahlen (gleich viele Kalendertage
  // unmittelbar davor). Bei Wochen und Monaten sind das andere Tage als die
  // der Linie, die die Legende am Diagramm nennt.
  const comparedDays = comparison?.available
    ? formatDayRange(comparison.fromDay, comparison.toDay, t)
    : null;
  // Der Zeitraum läuft noch („Heute", „Letzte 30 Tage"): Er ist unvollständig,
  // der Vorzeitraum vollständig – „−100 % ggü. Vorzeitraum" am Vormittag ist
  // kein Einbruch. Heute = der Berliner Kalendertag des Zählerbuchs.
  const running =
    !!comparedDays && isRunningRange(summary.fromDay, summary.toDay);
  const change = (current, key) => {
    if (!comparison) return null;
    if (!comparison.available)
      return {
        available: false,
        text: t("embed-analytics.compare.unavailable"),
      };
    return {
      available: true,
      text: changeLabel(current, comparison.totals[key] ?? 0, t),
      title: t("embed-analytics.compare.previous-range", {
        range: comparedDays,
      }),
    };
  };

  const fields = [
    {
      key: "messages",
      label: t("embed-analytics.kpi.messages"),
      value: value(kpi.messages),
      change: change(kpi.messages, "messages"),
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
      change: change(kpi.conversations, "conversations"),
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
      change: change(kpi.positive, "feedbackPositive"),
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
      change: change(kpi.negative, "feedbackNegative"),
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
              {field.change?.available && (
                <span
                  data-kpi-change=""
                  title={field.change.title}
                  className="mt-1 block text-xs text-theme-text-primary"
                >
                  {field.change.text}
                  {/* Der Tooltip ist nur mit der Maus erreichbar: Die Tage
                      des Vergleichs stehen deshalb auch im Text. */}
                  <span className="sr-only">{` (${field.change.title})`}</span>
                </span>
              )}
              {/* Kein Vergleich: sichtbar steht es einmal unter dem Streifen.
                  Das Feld bekommt keine Zeile – nur den Text für
                  Screenreader, der keinen Platz einnimmt. */}
              {field.change && !field.change.available && (
                <span data-kpi-change="" className="sr-only">
                  {field.change.text}
                </span>
              )}
            </dd>
          </div>
        ))}
      </dl>

      {/* KIE-537 – womit die Felder vergleichen: eine Zeile für alle vier,
          sichtbar und im Lesefluss direkt nach dem Streifen. */}
      {comparedDays && (
        <p
          data-compare-line=""
          className={`mt-2 text-xs ${MUTED} transition-opacity ${loading ? "opacity-50" : ""}`}
        >
          {t("embed-analytics.compare.change-range", { range: comparedDays })}
          {running && (
            <>
              {" "}
              <span data-compare-running="">
                {t("embed-analytics.compare.running")}
              </span>
            </>
          )}
        </p>
      )}

      {unavailableReason && (
        <p
          data-compare-note=""
          className={`mt-2 text-xs ${MUTED} transition-opacity ${loading ? "opacity-50" : ""}`}
        >
          {unavailableReason}
        </p>
      )}

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
