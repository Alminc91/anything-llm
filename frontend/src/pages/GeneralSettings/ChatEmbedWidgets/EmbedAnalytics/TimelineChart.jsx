import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { Table } from "@phosphor-icons/react";
import paths from "@/utils/paths";
import {
  PREVIOUS_LINE,
  barPath,
  bucketLabel,
  bucketTick,
  chartState,
  columnLayout,
  comparisonOf,
  countsSinceDay,
  formatDate,
  formatDayRange,
  formatNumber,
  linePath,
  linePoints,
  previousBucketLabel,
  tickLabelWidth,
  tickStep,
  tooltipPlacement,
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
//
// KIE-537 – Schalter „Vorzeitraum vergleichen": Die Werte des Vorzeitraums
// liegen als gepunktete Linie über den Säulen – gerade von Wert zu Wert, in
// der Textfarbe des Themes, nicht in einer zweiten Akzentfarbe. Die Säulen
// bleiben das Hauptelement. Mit zwei Serien gibt es eine Legende; Säule und
// gepunktete Linie mit Punktmarken an ihren Werten unterscheiden sich auch
// ohne Farbe.
// Tooltip und Tabelle nennen den zweiten Wert – der Tooltip mit dem Abschnitt
// des Vorzeitraums, zu dem er gehört. Gibt es keinen Vergleich (der
// Vorzeitraum beginnt vor dem ersten Zählwert), bleibt es bei den Säulen;
// warum, steht einmal – in der Zeile unter dem Kennzahlen-Streifen, direkt
// über dieser Karte (StatisticsGrid). Hat der gewählte Zeitraum nichts zu
// zeigen („Heute" vor der ersten Nachricht), der Vorzeitraum aber schon,
// bleibt es nicht beim Leerzustand: Die Linie liegt über Plätzen ohne Säulen,
// der Hinweis des Leerzustands steht als Zeile darüber.
//
// Hat die Karte nichts zu zeichnen (keine Nachrichten im Zeitraum, Widget
// ohne Zählwerte, keine begonnene Konversation ohne Linie des Vorzeitraums,
// Ladefehler), ist sie eine einzige schmale Zeile „<Titel> – <Hinweis>" –
// ohne reservierten Diagrammraum. Daneben stehen nur die Schalter, die an der
// Lage etwas ändern können. Während des Ladens bleibt die bisherige Höhe.

const METRICS = ["messages", "conversations"];
const DEFAULT_WIDTH = 960;
const MARGIN = { top: 12, right: 8, bottom: 26, left: 44 };
const MUTED = "text-[color:var(--theme-analytics-text-muted)]";
// Üblicher Platz je Beschriftung an der Zeitachse (px)
const TICK_WIDTH = { hour: 52, day: 48, week: 52, month: 68 };

/**
 * @param {Object} props
 * @param {import("@/utils/analyticsTimeline").Summary|null} props.summary - Antwort von analytics/summary
 * @param {boolean} props.loading - es wird (neu) geladen
 * @param {boolean} [props.failed] - das Laden ist fehlgeschlagen
 * @param {{start: string, end: string}|null} [props.selectedBucket] - Abschnitt, auf den die Liste gefiltert ist
 * @param {(bucket: {start: string, end: string, label: string}|null) => void} [props.onSelectBucket]
 * @param {boolean} [props.compare] - Schalter „Vorzeitraum vergleichen" (KIE-537); der Zustand liegt bei der Ansicht
 * @param {(compare: boolean) => void} [props.onCompareChange]
 */
export default function TimelineChart({
  summary,
  loading,
  failed = false,
  selectedBucket = null,
  onSelectBucket = () => {},
  compare = false,
  onCompareChange = () => {},
}) {
  const { t, i18n } = useTranslation();
  const [metric, setMetric] = useState("messages");
  const [showTable, setShowTable] = useState(false);
  const titleId = useId();

  const granularity = summary?.granularity ?? "day";
  const state = chartState(summary, metric);
  const since = countsSinceDay(summary);
  const context = { t, locale: i18n.language };
  // KIE-537: null = Vergleich aus (oder noch nicht geladen)
  const comparison = comparisonOf(summary, compare);
  const previous = comparison?.available ? comparison : null;
  // Leerzustand des gewählten Zeitraums (keine Nachrichten bzw. keine
  // Konversation) – der Vorzeitraum kann trotzdem Werte haben. Dann gibt es
  // etwas zu zeigen: im Diagramm die Linie über Plätzen ohne Säulen (für die
  // gewählte Größe), in der Tabelle die Spalten des Vorzeitraums (beide
  // Größen). Ohne Wert im Vorzeitraum bleibt es beim Leerzustand.
  const emptyNote =
    state === "empty-range"
      ? "range"
      : state === "empty-metric"
        ? "conversations"
        : null;
  const previousHas = (key) =>
    !!previous && previous.buckets.some((bucket) => (bucket[key] ?? 0) > 0);
  const lineOnly = !!emptyNote && previousHas(metric);
  const emptyRange =
    state === "empty-range" &&
    !(showTable ? METRICS.some(previousHas) : lineOnly);
  // Die Linie gibt es nur im Diagramm, nicht in der Tabelle – mit ihr die
  // Legende.
  const showsLine = !!previous && (state === "data" || lineOnly) && !showTable;

  // Nichts zu zeichnen: eine Zeile statt des Rahmens. Laden ohne Antwort
  // behält den Rahmen (die Höhe springt nicht, solange offen ist, was kommt).
  const compactHint = !summary
    ? failed
      ? "error"
      : null
    : state === "no-data"
      ? "widget"
      : emptyRange
        ? "range"
        : state === "empty-metric" && !lineOnly && !showTable
          ? "conversations"
          : null;

  const toggleBase =
    "px-3 py-1.5 text-sm transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[color:var(--theme-text-primary)]";
  const toggleOn =
    "bg-theme-settings-input-bg text-theme-text-primary font-medium";
  const toggleOff = `${MUTED} hover:text-theme-text-primary`;

  const compareSwitch = (
    <CompareSwitch
      checked={compare}
      onChange={onCompareChange}
      label={t("embed-analytics.compare.toggle")}
    />
  );
  const metricSwitch = (
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
  );

  const tableToggle = (
    <button
      type="button"
      aria-pressed={showTable}
      onClick={() => setShowTable((current) => !current)}
      className={`inline-flex items-center gap-1.5 rounded-lg border border-white/10 ${toggleBase} ${showTable ? toggleOn : toggleOff}`}
    >
      <Table size={15} aria-hidden="true" />
      {t("embed-analytics.chart.as-table")}
    </button>
  );
  // In der schmalen Zeile nur die Schalter, die an der Lage etwas ändern:
  // der Vergleich (der Vorzeitraum kann Werte haben); die andere Größe, wenn
  // sie etwas zu zeigen hat (Konversationen → Nachrichten, oder die Linie des
  // Vorzeitraums); „Als Tabelle", wenn der Vorzeitraum Werte hat.
  const compactSwitches =
    compactHint === "range" || compactHint === "conversations"
      ? {
          metric:
            compactHint === "conversations" ||
            METRICS.some((key) => key !== metric && previousHas(key)),
          table: !showTable && METRICS.some(previousHas),
        }
      : null;

  if (compactHint)
    return (
      <section
        aria-labelledby={titleId}
        aria-busy={loading}
        data-chart-compact={compactHint}
        className={`rounded-xl border border-white/10 bg-theme-bg-primary px-4 py-3 md:px-5 transition-opacity ${loading && summary ? "opacity-50" : ""}`}
      >
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <p className={`min-w-0 text-sm ${MUTED}`}>
            <span id={titleId} className="font-medium">
              {t(`embed-analytics.chart.metric.${metric}`)}{" "}
              {t(`embed-analytics.chart.per.${granularity}`)}
            </span>
            {" – "}
            <span data-chart-frame="empty">
              {t(`embed-analytics.chart.empty.${compactHint}`)}
              {compactHint === "widget" && (
                <>
                  {" "}
                  <Link
                    to={paths.settings.chatbot.widgets()}
                    className="text-theme-text-primary underline underline-offset-2"
                  >
                    {t("embed-analytics.chart.empty.widget-link")}
                  </Link>
                </>
              )}
            </span>
            {since && (
              <span data-chart-since="">
                {" "}
                {t("embed-analytics.chart.counts-since", {
                  date: formatDate(since),
                })}
              </span>
            )}
          </p>
          {compactSwitches && (
            <div className="flex flex-wrap items-center gap-2">
              {compareSwitch}
              {compactSwitches.metric && metricSwitch}
              {compactSwitches.table && tableToggle}
            </div>
          )}
        </div>
      </section>
    );

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
          {compareSwitch}
          {metricSwitch}
          {tableToggle}
        </div>
      </div>

      <div
        className={`transition-opacity ${loading && summary ? "opacity-50" : ""}`}
        aria-busy={loading}
      >
        {/* KIE-537 – über dem Diagramm: die Legende. Die Kopfzeile mit dem
            Schalter bleibt dabei, wo sie ist. Liegt die Linie über Plätzen
            ohne Säulen, steht davor, warum es keine gibt. */}
        {showsLine && lineOnly && (
          <p
            data-chart-note=""
            className="mb-3 text-sm text-theme-text-primary"
          >
            {t(`embed-analytics.chart.empty.${emptyNote}`)}
          </p>
        )}
        {showsLine && <Legend previous={previous} t={t} />}
        {!summary ? (
          // Laden: der Rahmen in der Höhe des Diagramms
          <Frame>
            <p className={`text-sm ${MUTED}`}>{t("common.loading")}</p>
          </Frame>
        ) : showTable ? (
          <BucketTable
            summary={summary}
            granularity={granularity}
            context={context}
            previous={previous}
          />
        ) : (
          <Columns
            summary={summary}
            metric={metric}
            granularity={granularity}
            context={context}
            selectedBucket={selectedBucket}
            onSelectBucket={onSelectBucket}
            previous={previous}
          />
        )}
      </div>
    </section>
  );
}

/**
 * Schalter „Vorzeitraum vergleichen" (KIE-537): aus = leere Bahn, an =
 * gefüllte Bahn mit dem Knopf rechts – in den Textfarben des Themes, der
 * Zustand hängt nicht an einer Farbe.
 * @param {{checked: boolean, onChange: (checked: boolean) => void, label: string}} props
 */
function CompareSwitch({ checked, onChange, label }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      data-compare-switch=""
      onClick={() => onChange(!checked)}
      className="mr-1 inline-flex items-center gap-2 rounded-lg py-1.5 text-left text-sm text-theme-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--theme-text-primary)]"
    >
      <span
        aria-hidden="true"
        className={`relative inline-block h-[18px] w-[32px] shrink-0 rounded-full border transition-colors ${checked ? "border-theme-text-primary bg-theme-text-primary" : "border-[color:var(--theme-analytics-text-muted)] bg-transparent"}`}
      >
        <span
          className={`absolute left-[2px] top-[2px] h-[12px] w-[12px] rounded-full transition-transform ${checked ? "translate-x-[14px] bg-theme-bg-primary" : "bg-[color:var(--theme-analytics-text-muted)]"}`}
        />
      </span>
      {label}
    </button>
  );
}

/**
 * Legende für zwei Serien (KIE-537): Säule = gewählter Zeitraum, gepunktete
 * Linie mit Punktmarke = Vorzeitraum mit den Tagen, die die Linie zeigt.
 * @param {{previous: {lineFromDay: string, lineToDay: string}, t: Function}} props
 */
function Legend({ previous, t }) {
  const { width, dash, markerRadius } = PREVIOUS_LINE;
  return (
    <ul
      data-chart-legend=""
      aria-label={t("embed-analytics.compare.legend.label")}
      className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-theme-text-primary"
    >
      <li className="inline-flex items-center gap-1.5">
        <svg width={12} height={12} viewBox="0 0 12 12" aria-hidden="true">
          <path
            d={barPath({ x: 2, y: 0, width: 8, height: 12 })}
            fill="var(--theme-analytics-bar)"
          />
        </svg>
        {t("embed-analytics.compare.legend.current")}
      </li>
      <li className="inline-flex flex-wrap items-center gap-x-1.5">
        <svg width={28} height={12} viewBox="0 0 28 12" aria-hidden="true">
          <line
            x1={1}
            x2={27}
            y1={6}
            y2={6}
            stroke="var(--theme-text-primary)"
            strokeWidth={width}
            strokeDasharray={dash}
            strokeLinecap="round"
          />
          <circle
            cx={14}
            cy={6}
            r={markerRadius}
            fill="var(--theme-text-primary)"
          />
        </svg>
        {t("embed-analytics.compare.legend.previous")}
        <span className={MUTED}>
          {formatDayRange(previous.lineFromDay, previous.lineToDay, t)}
        </span>
      </li>
    </ul>
  );
}

/** Rahmen in der Höhe des Diagramms für den Ladezustand – ohne Säulenplätze. */
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
  previous,
}) {
  const { t } = context;
  const wrapperRef = useRef(null);
  const columnRefs = useRef([]);
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  // Platz unter dem Mauszeiger bzw. mit Tastaturfokus; die letzte Eingabe
  // (lead) entscheidet, welcher der beiden Tooltip und Hervorhebung trägt.
  // Auch ein Mausklick setzt den Fokus, er zählt aber nicht als Tastaturfokus
  // (wie :focus-visible): kein Rahmen – und verlässt der Zeiger das Diagramm,
  // verschwinden Tooltip und Hervorhebung.
  const [hovered, setHovered] = useState(null);
  const [focused, setFocused] = useState(null);
  const [lead, setLead] = useState("pointer");
  // Die Maustaste ist auf einem Platz gedrückt: Der Fokus, der jetzt folgt,
  // kommt vom Klick. Ein Stift zählt wie die Maus – auch er hat einen Zeiger,
  // der über den Plätzen schwebt und das Diagramm verlässt. Ein Tippen
  // (Touch) zählt wie die Tastatur – ohne Zeiger zeigt nur der Fokus den
  // Tooltip.
  const mouseDown = useRef(false);
  // Das Fenster hat den Fokus verloren; kehrt es zurück, bekommt der Platz
  // erneut ein focus-Ereignis – das ist keine neue Eingabe.
  const windowLeft = useRef(false);
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
  // KIE-537: Werte des Vorzeitraums, je Säule der Abschnitt an derselben
  // Stelle – null ohne Vergleich.
  const previousBuckets = previous?.buckets ?? null;
  const previousValues = useMemo(
    () => previousBuckets?.map((bucket) => bucket[metric] ?? 0) ?? null,
    [previousBuckets, metric]
  );
  const height = width < 520 ? 200 : 240;
  const plotWidth = Math.max(40, width - MARGIN.left - MARGIN.right);
  const plotHeight = height - MARGIN.top - MARGIN.bottom;
  // Die Wertachse reicht bis zum höheren der beiden Höchstwerte.
  const scale = valueScale(Math.max(...values, ...(previousValues ?? []), 0));
  const columns = columnLayout({
    values,
    width: plotWidth,
    height: plotHeight,
    max: scale.max,
  });
  const line = previousValues
    ? linePoints({
        values: previousValues,
        columns,
        height: plotHeight,
        max: scale.max,
      })
    : null;
  // Punktmarken nur, solange sie einander nicht berühren – und nur an Plätzen
  // mit einem Wert im Vorzeitraum: Durch die Nullwerte läuft die gepunktete
  // Linie ohne Marke weiter. Sonst stünde auf der Grundlinie eine dichte
  // Punktreihe (24 Stunden, die meisten ohne Nachricht).
  const showMarkers =
    !!line && (columns[0]?.width ?? 0) >= PREVIOUS_LINE.markerMinSlot;
  const hasMarker = (i) => showMarkers && previousValues[i] > 0;
  const ticks = buckets.map((bucket) =>
    bucketTick(bucket, granularity, context)
  );
  const step = tickStep(
    buckets.length,
    plotWidth,
    tickLabelWidth(ticks, TICK_WIDTH[granularity])
  );

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
  // KIE-537: zweite Zeile des Tooltips – der Abschnitt des Vorzeitraums an
  // dieser Stelle und sein Wert, „Vorzeitraum: Fr., 09.10.2026 — 12
  // Nachrichten"; null ohne Vergleich
  const previousOf = (i) =>
    previousBuckets
      ? previousBucketLabel(previousBuckets[i], metric, granularity, context)
      : null;
  // Angabe eines Platzes für Screenreader: Wert, Vorzeitraum, Hinweis.
  const describe = (i, actionable) =>
    [
      tooltipOf(i),
      previousOf(i),
      actionable ? t("embed-analytics.chart.filter-hint") : null,
    ]
      .filter(Boolean)
      .join(". ");

  const select = (i) => {
    if (!clickable || !(values[i] > 0)) return;
    const bucket = buckets[i];
    onSelectBucket(
      isSelected(bucket)
        ? null
        : { start: bucket.start, end: bucket.end, label: labelOf(i) }
    );
  };

  const showFocus = (i) => {
    setFocused(i);
    setLead("focus");
  };
  const moveFocus = (i) => {
    const next = Math.max(0, Math.min(buckets.length - 1, i));
    setTabStop(next);
    // Am Rand bleibt der Fokus, wo er ist – kam er vom Klick, gilt er ab jetzt.
    if (focused !== next) showFocus(next);
    columnRefs.current[next]?.focus();
  };
  const onKeyDown = (event, i) => {
    if (event.key === "ArrowRight") moveFocus(i + 1);
    else if (event.key === "ArrowLeft") moveFocus(i - 1);
    else if (event.key === "Home") moveFocus(0);
    else if (event.key === "End") moveFocus(buckets.length - 1);
    else if (event.key === "Enter" || event.key === " ") {
      if (focused !== i) showFocus(i);
      select(i);
    } else return;
    event.preventDefault();
  };

  // Der Mauszeiger auf einem Platz löst den Fokus ab, ein neuer Fokus (Tab,
  // Pfeiltasten) den Mauszeiger; fällt der eine weg, gilt wieder der andere.
  const pointAt = (i) => {
    setHovered(i);
    setLead("pointer");
  };
  const releaseMouse = () => {
    mouseDown.current = false;
  };
  const [leading, other] =
    lead === "focus" ? [focused, hovered] : [hovered, focused];
  const active = leading ?? other;
  const tooltip =
    active !== null && columns[active]
      ? tooltipPlacement({
          columns,
          active,
          // Die längere der beiden Zeilen bestimmt die Breite.
          text: [tooltipOf(active), previousOf(active) ?? ""].reduce(
            (longest, text) => (text.length > longest.length ? text : longest)
          ),
          width,
          plotLeft: MARGIN.left,
          plotHeight,
          line,
        })
      : null;

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
          ...(previousValues
            ? [
                t("embed-analytics.compare.summary", {
                  range: formatDayRange(
                    previous.lineFromDay,
                    previous.lineToDay,
                    t
                  ),
                  total: formatNumber(
                    previousValues.reduce((total, value) => total + value, 0)
                  ),
                  max: formatNumber(Math.max(...previousValues, 0)),
                }),
              ]
            : []),
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
                aria-label={describe(i, actionable)}
                tabIndex={i === currentTabStop ? 0 : -1}
                onPointerEnter={() => pointAt(i)}
                onPointerMove={() => pointAt(i)}
                onPointerDown={(event) => {
                  mouseDown.current = event.pointerType !== "touch";
                }}
                onPointerUp={releaseMouse}
                onPointerCancel={releaseMouse}
                onPointerLeave={() => {
                  releaseMouse();
                  setHovered((current) => (current === i ? null : current));
                }}
                onFocus={() => {
                  const byMouse = mouseDown.current;
                  const returned = windowLeft.current;
                  mouseDown.current = false;
                  windowLeft.current = false;
                  if (returned) return;
                  setTabStop(i);
                  if (!byMouse) showFocus(i);
                }}
                onBlur={(event) => {
                  // Nicht der Platz, das Fenster hat den Fokus verloren: Der
                  // Platz bleibt das aktive Element, und das Dokument hat
                  // keinen Fokus mehr. Beides muss gelten – behält das
                  // Dokument den Fokus, ist der Platz ihn los (Tab, Klick
                  // daneben), was auch immer im Ereignis noch als aktives
                  // Element gilt.
                  const place = event.currentTarget;
                  const owner = place.ownerDocument;
                  windowLeft.current =
                    owner?.activeElement === place &&
                    owner.hasFocus?.() !== true;
                  if (windowLeft.current) return;
                  setFocused((current) => (current === i ? null : current));
                }}
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

          {/* KIE-537 – Linie des Vorzeitraums: über den Säulen, gerade von
              Wert zu Wert. Sie nimmt keine Eingaben an (die Säulenplätze
              darunter bleiben erreichbar) und ist für Screenreader kein
              eigenes Element – jeder Platz nennt seinen Vorzeitraumwert. */}
          {line && (
            <g data-previous-line="" aria-hidden="true" pointerEvents="none">
              <path
                d={linePath(line)}
                fill="none"
                stroke="var(--theme-text-primary)"
                strokeWidth={PREVIOUS_LINE.width}
                strokeDasharray={PREVIOUS_LINE.dash}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              {/* Der angesteuerte Platz zeigt seine Marke immer – auch
                  bei 0 und zwischen dicht stehenden Plätzen. */}
              {line.map((point, i) =>
                hasMarker(i) || i === active ? (
                  <circle
                    key={i}
                    data-previous-marker=""
                    cx={point.x}
                    cy={point.y}
                    r={PREVIOUS_LINE.markerRadius + (i === active ? 1 : 0)}
                    fill="var(--theme-text-primary)"
                    stroke="var(--theme-bg-primary)"
                    strokeWidth={1}
                  />
                ) : null
              )}
            </g>
          )}

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
                  {ticks[i]}
                </text>
              ) : null
            )}
          </g>
        </g>
      </svg>

      {/* Tooltip – dieselbe Angabe wie das aria-label des Platzes. So breit
          wie sein Text (w-max), höchstens bis an den Rand des Diagramms
          (maxWidth) – ein längerer Text bricht um, statt hinauszuragen. */}
      {tooltip && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute z-10 w-max break-words rounded-md border border-white/10 bg-theme-bg-secondary px-2.5 py-1.5 text-xs text-theme-text-primary shadow-lg"
          style={{ top: MARGIN.top + tooltip.y, ...tooltipStyle(tooltip) }}
        >
          {labelOf(active)}
          {" — "}
          <span className="font-semibold">
            {valueLabel(values[active], metric, t)}
          </span>
          {previousValues && (
            <span data-tooltip-previous="" className="block">
              {previousOf(active)}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Der Tooltip steht mit seiner Unterkante über den Säulen (mit zwei Zeilen
 * wächst er nach oben); waagerecht bleibt er im Diagramm (tooltipPlacement).
 * @param {{align: "start"|"center"|"end", x: number, maxWidth: number}} placement
 */
function tooltipStyle({ align, x, maxWidth }) {
  if (align === "start")
    return { left: x, maxWidth, transform: "translateY(-100%)" };
  if (align === "end")
    return { right: x, maxWidth, transform: "translateY(-100%)" };
  return { left: x, maxWidth, transform: "translate(-50%, -100%)" };
}

/**
 * Dieselben Werte als Tabelle: markierbar, per Tastatur erreichbar. Mit
 * Vergleich (KIE-537) hat jede Größe eine zweite Spalte mit dem Wert des
 * Vorzeitraums – dem Abschnitt an derselben Stelle, wie ihn die Linie zeigt;
 * die Summe darunter ist die dieser Spalte. Welcher Abschnitt das ist, steht
 * in jeder Zeile in einer eigenen Spalte vor dem ersten Vorzeitraumwert –
 * sichtbar, nicht als Tooltip: Der wäre mit Finger und Tastatur nicht zu
 * erreichen. Die Legende des Diagramms gibt es hier nicht; die Tage, aus
 * denen die Spalten stammen, stehen deshalb über der Tabelle und in ihrer
 * Beschriftung.
 */
function BucketTable({ summary, granularity, context, previous }) {
  const { t } = context;
  const cell = "px-3 py-1.5 text-right tabular-nums";
  const previousCell = `${cell} ${MUTED}`;
  const previousPeriodCell = `px-3 py-1.5 text-left text-xs ${MUTED}`;
  const previousSum = (key) =>
    previous.buckets.reduce((total, bucket) => total + (bucket[key] ?? 0), 0);
  // Die Tage der Spalten des Vorzeitraums – dieselben wie in der Legende.
  const previousDays = previous
    ? formatDayRange(previous.lineFromDay, previous.lineToDay, t)
    : null;
  const previousRange = previous
    ? t("embed-analytics.compare.previous-range", { range: previousDays })
    : null;
  const caption = [
    t("embed-analytics.chart.table.caption", {
      per: t(`embed-analytics.chart.per.${granularity}`),
    }),
    previousRange,
  ]
    .filter(Boolean)
    .join(". ");
  return (
    <>
      {previousRange && (
        <p data-table-previous-range="" className={`mb-3 text-xs ${MUTED}`}>
          {previousRange}
        </p>
      )}
      <div
        tabIndex={0}
        role="region"
        aria-label={caption}
        className="max-h-[320px] overflow-auto rounded-lg border border-white/10 select-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-[color:var(--theme-text-primary)]"
      >
        <table className="w-full border-collapse text-sm text-theme-text-primary">
          <caption className="sr-only">{caption}</caption>
          <thead className="sticky top-0 bg-theme-bg-primary">
            <tr className={`text-xs ${MUTED}`}>
              <th scope="col" className="px-3 py-2 text-left font-medium">
                {t("embed-analytics.chart.table.period")}
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                {t("embed-analytics.chart.table.messages")}
              </th>
              {previous && (
                <>
                  <th scope="col" className="px-3 py-2 text-left font-medium">
                    {t("embed-analytics.compare.table.period")}
                  </th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">
                    {t("embed-analytics.compare.table.messages")}
                  </th>
                </>
              )}
              <th scope="col" className="px-3 py-2 text-right font-medium">
                {t("embed-analytics.chart.table.conversations")}
              </th>
              {previous && (
                <th scope="col" className="px-3 py-2 text-right font-medium">
                  {t("embed-analytics.compare.table.conversations")}
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {summary.buckets.map((bucket, i) => (
              <tr
                key={`${bucket.start}-${bucket.hour ?? ""}`}
                className="border-t border-white/10"
              >
                <th scope="row" className="px-3 py-1.5 text-left font-normal">
                  {bucketLabel(bucket, granularity, context)}
                </th>
                <td className={cell}>{formatNumber(bucket.messages)}</td>
                {previous && (
                  <>
                    <td data-previous-period="" className={previousPeriodCell}>
                      {bucketLabel(previous.buckets[i], granularity, context)}
                    </td>
                    <td className={previousCell}>
                      {formatNumber(previous.buckets[i].messages)}
                    </td>
                  </>
                )}
                <td className={cell}>{formatNumber(bucket.conversations)}</td>
                {previous && (
                  <td className={previousCell}>
                    {formatNumber(previous.buckets[i].conversations)}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-white/10 font-semibold">
              <th scope="row" className="px-3 py-2 text-left">
                {t("embed-analytics.chart.table.total")}
              </th>
              <td className={cell}>{formatNumber(summary.totals.messages)}</td>
              {previous && (
                <>
                  <td
                    data-previous-period=""
                    className={`${previousPeriodCell} font-normal`}
                  >
                    {previousDays}
                  </td>
                  <td className={previousCell}>
                    {formatNumber(previousSum("messages"))}
                  </td>
                </>
              )}
              <td className={cell}>
                {formatNumber(summary.totals.conversations)}
              </td>
              {previous && (
                <td className={previousCell}>
                  {formatNumber(previousSum("conversations"))}
                </td>
              )}
            </tr>
          </tfoot>
        </table>
      </div>
    </>
  );
}
