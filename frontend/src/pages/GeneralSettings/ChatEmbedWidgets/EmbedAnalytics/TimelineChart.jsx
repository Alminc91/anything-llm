import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { Table } from "@phosphor-icons/react";
import paths from "@/utils/paths";
import {
  barPath,
  bucketLabel,
  bucketTick,
  chartState,
  columnLayout,
  countsSinceDay,
  formatDate,
  formatNumber,
  tickStep,
  valueLabel,
  valueScale,
} from "@/utils/analyticsTimeline";

// KIE-536 – Säulendiagramm über die Zeit.
//
// Immer Säulen, eine Serie, eine Akzentfarbe (--theme-analytics-bar); der
// Schalter Nachrichten | Konversationen gehört zum Diagramm und ändert nur
// die Säulen. Text steht in den Text-Tokens, nie in der Säulenfarbe. Jeder
// Wert ist auch ohne Maus erreichbar: Die Säulenplätze sind fokussierbar (ein
// Tab-Stopp, Pfeiltasten wechseln den Platz), und „Als Tabelle" zeigt
// dieselben Werte als Tabelle.

const METRICS = ["messages", "conversations"];
const DEFAULT_WIDTH = 960;
const MARGIN = { top: 12, right: 8, bottom: 26, left: 44 };
const MUTED = "text-[color:var(--theme-analytics-text-muted)]";
// Platz je Beschriftung an der Zeitachse (px)
const TICK_WIDTH = { hour: 52, day: 48, week: 52, month: 68 };

/**
 * @param {Object} props
 * @param {import("@/utils/analyticsTimeline").Summary|null} props.summary - Antwort von analytics/summary
 * @param {boolean} props.loading - es wird (neu) geladen
 * @param {boolean} [props.failed] - das Laden ist fehlgeschlagen
 * @param {{start: string, end: string}|null} [props.selectedBucket] - Abschnitt, auf den die Liste gefiltert ist
 * @param {(bucket: {start: string, end: string, label: string}|null) => void} [props.onSelectBucket]
 */
export default function TimelineChart({
  summary,
  loading,
  failed = false,
  selectedBucket = null,
  onSelectBucket = () => {},
}) {
  const { t, i18n } = useTranslation();
  const [metric, setMetric] = useState("messages");
  const [showTable, setShowTable] = useState(false);
  const titleId = useId();

  const granularity = summary?.granularity ?? "day";
  const state = chartState(summary, metric);
  const since = countsSinceDay(summary);
  const context = { t, locale: i18n.language };

  const toggleBase =
    "px-3 py-1.5 text-sm transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[color:var(--theme-text-primary)]";
  const toggleOn =
    "bg-theme-settings-input-bg text-theme-text-primary font-medium";
  const toggleOff = `${MUTED} hover:text-theme-text-primary`;

  return (
    <section
      aria-labelledby={titleId}
      className="rounded-xl border border-white/10 bg-theme-bg-primary p-4 md:p-5"
    >
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3 mb-4">
        <div className="min-w-0">
          <h3
            id={titleId}
            className="text-base font-semibold text-theme-text-primary"
          >
            {t(`embed-analytics.chart.metric.${metric}`)}{" "}
            <span className={`font-normal ${MUTED}`}>
              {t(`embed-analytics.chart.per.${granularity}`)}
            </span>
          </h3>
          {since && (
            <p className={`mt-1 text-xs ${MUTED}`}>
              {t("embed-analytics.chart.counts-since", {
                date: formatDate(since),
              })}
            </p>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div
            role="group"
            aria-label={t("embed-analytics.chart.metric-switch")}
            className="inline-flex overflow-hidden rounded-lg border border-white/10"
          >
            {METRICS.map((key) => (
              <button
                key={key}
                type="button"
                aria-pressed={metric === key}
                onClick={() => setMetric(key)}
                className={`${toggleBase} ${metric === key ? toggleOn : toggleOff}`}
              >
                {t(`embed-analytics.chart.metric.${key}`)}
              </button>
            ))}
          </div>
          <button
            type="button"
            aria-pressed={showTable}
            onClick={() => setShowTable((current) => !current)}
            className={`inline-flex items-center gap-1.5 rounded-lg border border-white/10 ${toggleBase} ${showTable ? toggleOn : toggleOff}`}
          >
            <Table size={15} aria-hidden="true" />
            {t("embed-analytics.chart.as-table")}
          </button>
        </div>
      </div>

      <div
        className={`transition-opacity ${loading && summary ? "opacity-50" : ""}`}
        aria-busy={loading}
      >
        {!summary ? (
          <Frame>
            <p className={`text-sm ${MUTED}`}>
              {failed
                ? t("embed-analytics.chart.empty.error")
                : t("common.loading")}
            </p>
          </Frame>
        ) : state === "no-data" ? (
          <Frame>
            <p className="text-sm text-theme-text-primary max-w-md">
              {t("embed-analytics.chart.empty.widget")}
            </p>
            <Link
              to={paths.settings.chatbot.widgets()}
              className="mt-2 text-sm text-theme-text-primary underline underline-offset-2"
            >
              {t("embed-analytics.chart.empty.widget-link")}
            </Link>
          </Frame>
        ) : state === "empty-range" ? (
          <Frame>
            <p className="text-sm text-theme-text-primary">
              {t("embed-analytics.chart.empty.range")}
            </p>
          </Frame>
        ) : showTable ? (
          <BucketTable
            summary={summary}
            granularity={granularity}
            context={context}
          />
        ) : state === "empty-metric" ? (
          <Frame>
            <p className="text-sm text-theme-text-primary">
              {t("embed-analytics.chart.empty.conversations")}
            </p>
          </Frame>
        ) : (
          <Columns
            summary={summary}
            metric={metric}
            granularity={granularity}
            context={context}
            selectedBucket={selectedBucket}
            onSelectBucket={onSelectBucket}
          />
        )}
      </div>
    </section>
  );
}

/** Rahmen in der Höhe des Diagramms für Lade- und Leerzustände – ohne Säulenplätze. */
function Frame({ children }) {
  return (
    <div
      data-chart-frame="empty"
      className="flex h-[240px] flex-col items-center justify-center rounded-lg border border-dashed border-white/10 px-4 text-center"
    >
      {children}
    </div>
  );
}

function Columns({
  summary,
  metric,
  granularity,
  context,
  selectedBucket,
  onSelectBucket,
}) {
  const { t } = context;
  const wrapperRef = useRef(null);
  const columnRefs = useRef([]);
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  // Platz unter dem Mauszeiger bzw. mit Tastaturfokus
  const [hovered, setHovered] = useState(null);
  const [focused, setFocused] = useState(null);
  // Zuletzt fokussierter Platz (Tab-Stopp des Diagramms)
  const [tabStop, setTabStop] = useState(null);

  // Das Diagramm wird in echten Pixeln gezeichnet (Schrift und Säulen
  // skalieren nicht mit), die Breite kommt vom umgebenden Element.
  useEffect(() => {
    const element = wrapperRef.current;
    if (!element) return;
    const measure = () => {
      const next = Math.round(element.getBoundingClientRect().width);
      if (next > 0) setWidth(next);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const buckets = summary.buckets;
  const values = useMemo(
    () => buckets.map((bucket) => bucket[metric] ?? 0),
    [buckets, metric]
  );
  const height = width < 520 ? 200 : 240;
  const plotWidth = Math.max(40, width - MARGIN.left - MARGIN.right);
  const plotHeight = height - MARGIN.top - MARGIN.bottom;
  const scale = valueScale(Math.max(...values, 0));
  const columns = columnLayout({
    values,
    width: plotWidth,
    height: plotHeight,
    max: scale.max,
  });
  const step = tickStep(buckets.length, plotWidth, TICK_WIDTH[granularity]);

  const clickable = granularity !== "hour";
  const isSelected = (bucket) =>
    !!selectedBucket &&
    selectedBucket.start === bucket.start &&
    selectedBucket.end === bucket.end;
  const hasSelection = clickable && buckets.some(isSelected);

  // Ein Tab-Stopp für das ganze Diagramm: der zuletzt fokussierte Platz,
  // sonst die letzte Säule mit Wert.
  const lastWithValue = values.reduce(
    (last, value, i) => (value > 0 ? i : last),
    values.length - 1
  );
  const currentTabStop =
    tabStop !== null && tabStop < buckets.length ? tabStop : lastWithValue;

  const labelOf = (i) => bucketLabel(buckets[i], granularity, context);
  const tooltipOf = (i) =>
    t("embed-analytics.chart.tooltip", {
      period: labelOf(i),
      value: valueLabel(values[i], metric, t),
    });

  const select = (i) => {
    if (!clickable || !(values[i] > 0)) return;
    const bucket = buckets[i];
    onSelectBucket(
      isSelected(bucket)
        ? null
        : { start: bucket.start, end: bucket.end, label: labelOf(i) }
    );
  };

  const moveFocus = (i) => {
    const next = Math.max(0, Math.min(buckets.length - 1, i));
    setTabStop(next);
    columnRefs.current[next]?.focus();
  };
  const onKeyDown = (event, i) => {
    if (event.key === "ArrowRight") moveFocus(i + 1);
    else if (event.key === "ArrowLeft") moveFocus(i - 1);
    else if (event.key === "Home") moveFocus(0);
    else if (event.key === "End") moveFocus(buckets.length - 1);
    else if (event.key === "Enter" || event.key === " ") select(i);
    else return;
    event.preventDefault();
  };

  const active = focused ?? hovered;
  const activeColumn = active !== null ? columns[active] : null;

  return (
    <div ref={wrapperRef} className="relative w-full">
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="group"
        aria-label={[
          t("embed-analytics.chart.summary", {
            metric: t(`embed-analytics.chart.metric.${metric}`),
            per: t(`embed-analytics.chart.per.${granularity}`),
            from: formatDate(summary.fromDay),
            to: formatDate(summary.toDay),
            total: formatNumber(summary.totals[metric]),
            max: formatNumber(Math.max(...values, 0)),
          }),
          t("embed-analytics.chart.keyboard-hint"),
        ].join(" ")}
        className="block max-w-full"
      >
        <g transform={`translate(${MARGIN.left},${MARGIN.top})`}>
          {/* Wertachse: Gitterlinien und Beschriftung */}
          <g aria-hidden="true">
            {scale.ticks.map((tick) => {
              const y = plotHeight - (tick / scale.max) * plotHeight;
              return (
                <g key={tick}>
                  <line
                    x1={0}
                    x2={plotWidth}
                    y1={y}
                    y2={y}
                    stroke="var(--theme-analytics-grid)"
                    strokeWidth={1}
                  />
                  <text
                    x={-8}
                    y={y}
                    dy="0.32em"
                    textAnchor="end"
                    fontSize={11}
                    fill="var(--theme-analytics-text-muted)"
                    style={{ fontVariantNumeric: "tabular-nums" }}
                  >
                    {formatNumber(tick)}
                  </text>
                </g>
              );
            })}
          </g>

          {/* Säulenplätze */}
          {columns.map((column, i) => {
            const bucket = buckets[i];
            const selected = clickable && isSelected(bucket);
            const actionable = clickable && values[i] > 0;
            return (
              <g
                key={`${bucket.start}-${bucket.hour ?? ""}`}
                ref={(element) => {
                  columnRefs.current[i] = element;
                }}
                data-column=""
                role={actionable ? "button" : "img"}
                aria-pressed={actionable ? selected : undefined}
                aria-label={
                  actionable
                    ? `${tooltipOf(i)}. ${t("embed-analytics.chart.filter-hint")}`
                    : tooltipOf(i)
                }
                tabIndex={i === currentTabStop ? 0 : -1}
                onPointerEnter={() => setHovered(i)}
                onPointerLeave={() =>
                  setHovered((current) => (current === i ? null : current))
                }
                onFocus={() => {
                  setFocused(i);
                  setTabStop(i);
                }}
                onBlur={() =>
                  setFocused((current) => (current === i ? null : current))
                }
                onKeyDown={(event) => onKeyDown(event, i)}
                onClick={() => select(i)}
                style={{
                  outline: "none",
                  cursor: actionable ? "pointer" : "default",
                }}
              >
                {/* Trefferfläche über die ganze Höhe des Platzes */}
                <rect
                  x={column.x}
                  y={0}
                  width={column.width}
                  height={plotHeight}
                  fill="var(--theme-text-primary)"
                  fillOpacity={active === i ? 0.07 : 0}
                  stroke={focused === i ? "var(--theme-text-primary)" : "none"}
                  strokeWidth={1.5}
                  rx={2}
                />
                {column.bar && (
                  <path
                    data-bar=""
                    d={barPath(column.bar)}
                    fill="var(--theme-analytics-bar)"
                    fillOpacity={hasSelection && !selected ? 0.4 : 1}
                  />
                )}
              </g>
            );
          })}

          {/* Grundlinie und Zeitachse */}
          <g aria-hidden="true">
            <line
              x1={0}
              x2={plotWidth}
              y1={plotHeight}
              y2={plotHeight}
              stroke="var(--theme-analytics-text-muted)"
              strokeOpacity={0.5}
              strokeWidth={1}
            />
            {columns.map((column, i) =>
              i % step === 0 ? (
                <text
                  key={i}
                  data-tick=""
                  x={column.center}
                  y={plotHeight + 17}
                  textAnchor="middle"
                  fontSize={11}
                  fill="var(--theme-analytics-text-muted)"
                >
                  {bucketTick(buckets[i], granularity, context)}
                </text>
              ) : null
            )}
          </g>
        </g>
      </svg>

      {/* Tooltip – dieselbe Angabe wie das aria-label des Platzes */}
      {activeColumn && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute z-10 whitespace-nowrap rounded-md border border-white/10 bg-theme-bg-secondary px-2.5 py-1.5 text-xs text-theme-text-primary shadow-lg"
          style={{
            top:
              MARGIN.top +
              (activeColumn.bar ? activeColumn.bar.y : plotHeight) -
              8,
            ...tooltipPosition(MARGIN.left + activeColumn.center, width),
          }}
        >
          {labelOf(active)}
          {" — "}
          <span className="font-semibold">
            {valueLabel(values[active], metric, t)}
          </span>
        </div>
      )}
    </div>
  );
}

/**
 * Der Tooltip steht über der Säule; an den Rändern bleibt er im Diagramm.
 * @param {number} center - Mitte des Säulenplatzes in px
 * @param {number} width - Breite des Diagramms in px
 */
function tooltipPosition(center, width) {
  if (center < width * 0.3)
    return { left: Math.max(0, center - 16), transform: "translateY(-100%)" };
  if (center > width * 0.7)
    return {
      right: Math.max(0, width - center - 16),
      transform: "translateY(-100%)",
    };
  return { left: center, transform: "translate(-50%, -100%)" };
}

/** Dieselben Werte als Tabelle: markierbar, per Tastatur erreichbar. */
function BucketTable({ summary, granularity, context }) {
  const { t } = context;
  const cell = "px-3 py-1.5 text-right tabular-nums";
  return (
    <div
      tabIndex={0}
      role="region"
      aria-label={t("embed-analytics.chart.table.caption", {
        per: t(`embed-analytics.chart.per.${granularity}`),
      })}
      className="max-h-[320px] overflow-auto rounded-lg border border-white/10 select-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-[color:var(--theme-text-primary)]"
    >
      <table className="w-full border-collapse text-sm text-theme-text-primary">
        <caption className="sr-only">
          {t("embed-analytics.chart.table.caption", {
            per: t(`embed-analytics.chart.per.${granularity}`),
          })}
        </caption>
        <thead className="sticky top-0 bg-theme-bg-primary">
          <tr className={`text-xs ${MUTED}`}>
            <th scope="col" className="px-3 py-2 text-left font-medium">
              {t("embed-analytics.chart.table.period")}
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium">
              {t("embed-analytics.chart.table.messages")}
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium">
              {t("embed-analytics.chart.table.conversations")}
            </th>
          </tr>
        </thead>
        <tbody>
          {summary.buckets.map((bucket) => (
            <tr
              key={`${bucket.start}-${bucket.hour ?? ""}`}
              className="border-t border-white/10"
            >
              <th scope="row" className="px-3 py-1.5 text-left font-normal">
                {bucketLabel(bucket, granularity, context)}
              </th>
              <td className={cell}>{formatNumber(bucket.messages)}</td>
              <td className={cell}>{formatNumber(bucket.conversations)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t border-white/10 font-semibold">
            <th scope="row" className="px-3 py-2 text-left">
              {t("embed-analytics.chart.table.total")}
            </th>
            <td className={cell}>{formatNumber(summary.totals.messages)}</td>
            <td className={cell}>
              {formatNumber(summary.totals.conversations)}
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
