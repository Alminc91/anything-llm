import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Table } from "@phosphor-icons/react";
import {
  countsSinceDay,
  formatDate,
  formatNumber,
  valueLabel,
} from "@/utils/analyticsTimeline";
import {
  AXIS_HEIGHT,
  HOURS,
  HOUR_TICK_STEP,
  MIN_MESSAGES,
  MIN_PERIOD_DAYS,
  ROW_HEIGHT,
  WEEKDAYS,
  cellBox,
  cellTooltipPlacement,
  columnTotals,
  gridLayout,
  gridTotal,
  heatLegend,
  heatLevel,
  heatmapState,
  hoursLabel,
  outsideCoreLabel,
  outsideCoreShare,
  peakCell,
  rowLabelWidth,
  rowTotals,
  slotLabel,
  weekdayHourGrid,
  weekdayName,
} from "@/utils/weekdayHourGrid";

// KIE-539 – Karte „Wann schreiben Ihre Besucher?": Nachrichten des gewählten
// Zeitraums nach Wochentag (7 Zeilen, Montag bis Sonntag) und Uhrzeit (24
// Spalten, Berliner Stunde).
//
// Eine Farbe in fünf Stufen, dazu eine eigene, neutrale Fläche für 0
// (--theme-analytics-heat-0 … -5). Die Farbe ist nie der einzige Träger: Jedes
// Feld nennt Wochentag, Stunde und Anzahl im Tooltip (Maus, Tastatur, Touch –
// wie im Säulendiagramm entscheidet die letzte Eingabe), die Legende nennt die
// Wertebereiche der Stufen, und „Als Tabelle" zeigt alle 168 Werte mit
// Zeilen- und Spaltensummen. Text steht in den Text-Tokens, nie in der
// Datenfarbe.
//
// Raster und Aussagen erscheinen erst ab 28 Tagen und 200 Nachrichten
// (heatmapState); darunter steht, was fehlt.

const DEFAULT_WIDTH = 960;
const MUTED = "text-[color:var(--theme-analytics-text-muted)]";
const WEEKDAY_INDEXES = Array.from({ length: WEEKDAYS }, (_, i) => i);
const HOUR_INDEXES = Array.from({ length: HOURS }, (_, i) => i);
const heatColor = (level) => `var(--theme-analytics-heat-${level})`;

/**
 * @param {Object} props
 * @param {object|null} props.summary - Antwort von analytics/summary (mit weekdayHour)
 * @param {boolean} props.loading - es wird (neu) geladen
 * @param {boolean} [props.failed] - das Laden ist fehlgeschlagen
 */
export default function WeekdayHourCard({ summary, loading, failed = false }) {
  const { t, i18n } = useTranslation();
  const [showTable, setShowTable] = useState(false);
  const titleId = useId();

  const state = summary ? heatmapState(summary) : "pending";
  // Eine Antwort ohne Raster: keine Karte statt einer Karte ohne Aussage.
  if (state === "unavailable") return null;

  const context = { t, locale: i18n.language };
  const hasData = state === "data";
  const grid = hasData ? weekdayHourGrid(summary) : null;
  const peak = grid ? peakCell(grid) : null;
  const since = countsSinceDay(summary);

  const toggleBase =
    "px-3 py-1.5 text-sm transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[color:var(--theme-text-primary)]";
  const toggleOn =
    "bg-theme-settings-input-bg text-theme-text-primary font-medium";
  const toggleOff = `${MUTED} hover:text-theme-text-primary`;

  return (
    <section
      aria-labelledby={titleId}
      data-weekday-hour-card={state}
      className="mb-6 rounded-xl border border-white/10 bg-theme-bg-primary p-4 md:p-5"
    >
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3 mb-4">
        <div className="min-w-0">
          <h3
            id={titleId}
            className="text-base font-semibold text-theme-text-primary"
          >
            {t("embed-analytics.weekday-hour.title")}
          </h3>
          {summary && (
            <p className={`mt-1 text-xs ${MUTED}`}>
              {t("embed-analytics.weekday-hour.subtitle", {
                from: formatDate(summary.fromDay),
                to: formatDate(summary.toDay),
              })}
            </p>
          )}
          {since && (
            <p className={`mt-1 text-xs ${MUTED}`}>
              {t("embed-analytics.chart.counts-since", {
                date: formatDate(since),
              })}
            </p>
          )}
        </div>

        {hasData && (
          <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
            <Legend max={peak.messages} t={t} />
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
        )}
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
        ) : state === "empty" ? (
          <Frame>
            <p className="text-sm text-theme-text-primary">
              {t("embed-analytics.chart.empty.range")}
            </p>
          </Frame>
        ) : state === "short-range" ? (
          <Frame>
            <p className="text-sm text-theme-text-primary">
              {t("embed-analytics.weekday-hour.hint.short-range", {
                days: MIN_PERIOD_DAYS,
              })}
            </p>
          </Frame>
        ) : state === "few-messages" ? (
          <Frame>
            <p className="text-sm text-theme-text-primary">
              {t("embed-analytics.weekday-hour.hint.few-messages", {
                messages: formatNumber(MIN_MESSAGES),
              })}
            </p>
          </Frame>
        ) : (
          <>
            <Statements grid={grid} peak={peak} context={context} />
            {showTable ? (
              <GridTable grid={grid} context={context} />
            ) : (
              <Grid
                grid={grid}
                peak={peak}
                summary={summary}
                context={context}
              />
            )}
          </>
        )}
      </div>
    </section>
  );
}

/** Rahmen für Lade-, Leer- und Hinweiszustände – ohne Felder. */
function Frame({ children }) {
  return (
    <div
      data-heat-frame=""
      className="flex h-[160px] flex-col items-center justify-center rounded-lg border border-dashed border-white/10 px-4 text-center"
    >
      {children}
    </div>
  );
}

/**
 * Die zwei Aussagen über dem Raster: der stärkste Zeitabschnitt und der Anteil
 * der Nachrichten außerhalb der Kernzeit. Die zweite nennt die feste Grenze
 * wörtlich und sagt am Feld, dass Feiertage als normale Wochentage zählen.
 */
function Statements({ grid, peak, context }) {
  const { t } = context;
  const share = outsideCoreShare(grid);
  const label = `text-xs ${MUTED}`;
  const value = "mt-0.5 text-base font-semibold text-theme-text-primary";
  return (
    <dl className="mb-4 grid grid-cols-1 gap-x-8 gap-y-3 sm:grid-cols-2">
      <div data-statement="peak" className="min-w-0">
        <dt className={label}>
          {t("embed-analytics.weekday-hour.peak.label")}
        </dt>
        <dd className={value}>{slotLabel(peak, context)}</dd>
        <dd className={`mt-0.5 ${label}`}>
          {valueLabel(peak.messages, "messages", t)}
        </dd>
      </div>
      <div data-statement="outside" className="min-w-0">
        <dt className={label}>{outsideCoreLabel(context)}</dt>
        <dd className={value}>
          {t("embed-analytics.weekday-hour.outside.value", {
            percent: formatNumber(share.percent),
          })}
        </dd>
        <dd className={`mt-0.5 ${label}`}>
          {t("embed-analytics.weekday-hour.outside.note")}
        </dd>
      </div>
    </dl>
  );
}

/** Legende „weniger … mehr": die sechs Stufen mit ihren Wertebereichen. */
function Legend({ max, t }) {
  const rangeOf = ({ from, to }) => {
    if (from === null) return t("embed-analytics.weekday-hour.legend.unused");
    if (from === to) return formatNumber(from);
    return t("embed-analytics.weekday-hour.legend.range", {
      from: formatNumber(from),
      to: formatNumber(to),
    });
  };
  return (
    <div
      data-heat-legend=""
      className={`flex items-start gap-2 text-[11px] leading-none ${MUTED}`}
    >
      <span aria-hidden="true" className="leading-[14px]">
        {t("embed-analytics.weekday-hour.legend.less")}
      </span>
      <ul
        aria-label={t("embed-analytics.weekday-hour.legend.label")}
        className="flex gap-1"
      >
        {heatLegend(max).map((step) => (
          <li
            key={step.level}
            data-heat-step={step.level}
            className="flex min-w-[26px] flex-col items-center gap-1"
          >
            <span
              aria-hidden="true"
              className="block h-[14px] w-full rounded-[3px]"
              style={{ backgroundColor: heatColor(step.level) }}
            />
            <span className="tabular-nums whitespace-nowrap">
              {rangeOf(step)}
            </span>
          </li>
        ))}
      </ul>
      <span aria-hidden="true" className="leading-[14px]">
        {t("embed-analytics.weekday-hour.legend.more")}
      </span>
    </div>
  );
}

function Grid({ grid, peak, summary, context }) {
  const { t, locale } = context;
  const wrapperRef = useRef(null);
  const cellRefs = useRef([]);
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  // So weit ist das Raster in einer schmalen Karte nach links geschoben.
  const [scrollLeft, setScrollLeft] = useState(0);
  // Feld unter dem Mauszeiger bzw. mit Tastaturfokus (Index = Wochentag × 24
  // + Stunde); wie im Säulendiagramm entscheidet die letzte Eingabe (lead),
  // welches der beiden Tooltip und Hervorhebung trägt. Ein Mausklick setzt
  // den Fokus, zählt aber nicht als Tastaturfokus: kein Rahmen – und verlässt
  // der Zeiger das Raster, verschwindet der Tooltip.
  const [hovered, setHovered] = useState(null);
  const [focused, setFocused] = useState(null);
  const [lead, setLead] = useState("pointer");
  // Maus oder Stift ist auf einem Feld gedrückt: Der Fokus, der jetzt folgt,
  // kommt vom Klick. Ein Tippen (Touch) zählt wie die Tastatur – ohne Zeiger
  // zeigt nur der Fokus den Tooltip.
  const mouseDown = useRef(false);
  // Das Fenster hat den Fokus verloren; kehrt es zurück, bekommt das Feld
  // erneut ein focus-Ereignis – das ist keine neue Eingabe.
  const windowLeft = useRef(false);
  // Zuletzt fokussiertes Feld (Tab-Stopp des Rasters)
  const [tabStop, setTabStop] = useState(null);

  // Das Raster wird in echten Pixeln gezeichnet, die Breite kommt vom
  // umgebenden Element.
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

  const rowLabels = WEEKDAY_INDEXES.map((weekday) =>
    weekdayName(weekday, locale, "short")
  );
  const layout = gridLayout({ width, labelWidth: rowLabelWidth(rowLabels) });
  const max = peak.messages;

  const slotOf = (index) => ({
    weekday: Math.floor(index / HOURS),
    hour: index % HOURS,
  });
  const indexOf = ({ weekday, hour }) => weekday * HOURS + hour;
  const valueOf = (index) => grid[slotOf(index).weekday][slotOf(index).hour];
  const valueText = (index) => valueLabel(valueOf(index), "messages", t);
  const tooltipOf = (index) =>
    t("embed-analytics.weekday-hour.tooltip", {
      slot: slotLabel(slotOf(index), context),
      value: valueText(index),
    });

  // Ein Tab-Stopp für das ganze Raster: das zuletzt fokussierte Feld, sonst
  // das stärkste.
  const currentTabStop = tabStop ?? indexOf(peak);

  const showFocus = (index) => {
    setFocused(index);
    setLead("focus");
  };
  const moveFocus = (weekday, hour) => {
    const next = indexOf({
      weekday: Math.max(0, Math.min(WEEKDAYS - 1, weekday)),
      hour: Math.max(0, Math.min(HOURS - 1, hour)),
    });
    setTabStop(next);
    // Am Rand bleibt der Fokus, wo er ist – kam er vom Klick, gilt er ab jetzt.
    if (focused !== next) showFocus(next);
    cellRefs.current[next]?.focus();
  };
  const onKeyDown = (event, index) => {
    const { weekday, hour } = slotOf(index);
    if (event.key === "ArrowRight") moveFocus(weekday, hour + 1);
    else if (event.key === "ArrowLeft") moveFocus(weekday, hour - 1);
    else if (event.key === "ArrowDown") moveFocus(weekday + 1, hour);
    else if (event.key === "ArrowUp") moveFocus(weekday - 1, hour);
    else if (event.key === "Home") moveFocus(weekday, 0);
    else if (event.key === "End") moveFocus(weekday, HOURS - 1);
    else return;
    event.preventDefault();
  };

  // Der Mauszeiger auf einem Feld löst den Fokus ab, ein neuer Fokus (Tab,
  // Pfeiltasten) den Mauszeiger; fällt der eine weg, gilt wieder der andere.
  const pointAt = (index) => {
    setHovered(index);
    setLead("pointer");
  };
  const releaseMouse = () => {
    mouseDown.current = false;
  };
  const [leading, other] =
    lead === "focus" ? [focused, hovered] : [hovered, focused];
  const active = leading ?? other;
  const tooltip =
    active !== null
      ? cellTooltipPlacement({
          layout,
          slot: slotOf(active),
          scrollLeft,
          text: tooltipOf(active),
        })
      : null;
  // Der Tooltip nennt dasselbe wie das aria-label des Feldes; die Anzahl ist
  // hervorgehoben.
  const [beforeValue, afterValue] = (
    active !== null
      ? t("embed-analytics.weekday-hour.tooltip", {
          slot: slotLabel(slotOf(active), context),
          value: "\u0000",
        })
      : "\u0000"
  ).split("\u0000");

  return (
    <div ref={wrapperRef} data-heat-grid="" className="relative w-full">
      <div className="flex">
        {/* Wochentage: stehen fest, auch wenn das Raster verschoben ist */}
        <div
          aria-hidden="true"
          className={`shrink-0 text-xs ${MUTED}`}
          style={{ width: layout.labelWidth }}
        >
          {rowLabels.map((label, weekday) => (
            <div
              key={weekday}
              data-heat-row-label=""
              className="truncate"
              style={{ height: ROW_HEIGHT, lineHeight: `${ROW_HEIGHT}px` }}
            >
              {label}
            </div>
          ))}
        </div>

        {/* Schmale Karte: Das Raster lässt sich hier waagerecht schieben. */}
        <div
          data-heat-scroller=""
          className="min-w-0 flex-1 overflow-x-auto"
          onScroll={(event) => setScrollLeft(event.currentTarget.scrollLeft)}
        >
          <svg
            width={layout.plotWidth}
            height={layout.height + AXIS_HEIGHT}
            viewBox={`0 0 ${layout.plotWidth} ${layout.height + AXIS_HEIGHT}`}
            role="group"
            aria-label={[
              t("embed-analytics.weekday-hour.summary", {
                from: formatDate(summary.fromDay),
                to: formatDate(summary.toDay),
                total: formatNumber(gridTotal(grid)),
                peak: slotLabel(peak, context),
                max: formatNumber(max),
              }),
              t("embed-analytics.weekday-hour.keyboard-hint"),
            ].join(" ")}
            className="block"
          >
            {WEEKDAY_INDEXES.map((weekday) =>
              HOUR_INDEXES.map((hour) => {
                const index = indexOf({ weekday, hour });
                const box = cellBox(layout, { weekday, hour });
                const level = heatLevel(grid[weekday][hour], max);
                return (
                  <g
                    key={index}
                    ref={(element) => {
                      cellRefs.current[index] = element;
                    }}
                    data-heat-cell=""
                    data-level={level}
                    role="img"
                    aria-label={tooltipOf(index)}
                    tabIndex={index === currentTabStop ? 0 : -1}
                    onPointerEnter={() => pointAt(index)}
                    onPointerMove={() => pointAt(index)}
                    onPointerDown={(event) => {
                      mouseDown.current = event.pointerType !== "touch";
                    }}
                    onPointerUp={releaseMouse}
                    onPointerCancel={releaseMouse}
                    onPointerLeave={() => {
                      releaseMouse();
                      setHovered((current) =>
                        current === index ? null : current
                      );
                    }}
                    onFocus={() => {
                      const byMouse = mouseDown.current;
                      const returned = windowLeft.current;
                      mouseDown.current = false;
                      windowLeft.current = false;
                      if (returned) return;
                      setTabStop(index);
                      if (!byMouse) showFocus(index);
                    }}
                    onBlur={(event) => {
                      // Nicht das Feld, das Fenster hat den Fokus verloren:
                      // Das Feld bleibt das aktive Element, und das Dokument
                      // hat keinen Fokus mehr (wie im Säulendiagramm).
                      const place = event.currentTarget;
                      const owner = place.ownerDocument;
                      windowLeft.current =
                        owner?.activeElement === place &&
                        owner.hasFocus?.() !== true;
                      if (windowLeft.current) return;
                      setFocused((current) =>
                        current === index ? null : current
                      );
                    }}
                    onKeyDown={(event) => onKeyDown(event, index)}
                    style={{ outline: "none" }}
                  >
                    {/* Trefferfläche: der ganze Platz samt Lücke */}
                    <rect
                      x={box.x}
                      y={box.y}
                      width={box.width}
                      height={box.height}
                      fill="transparent"
                    />
                    <rect
                      data-heat-tile=""
                      x={box.tile.x}
                      y={box.tile.y}
                      width={box.tile.width}
                      height={box.tile.height}
                      rx={3}
                      fill={heatColor(level)}
                      stroke={
                        active === index || focused === index
                          ? "var(--theme-text-primary)"
                          : "none"
                      }
                      strokeWidth={focused === index ? 2 : 1.5}
                      strokeOpacity={focused === index ? 1 : 0.6}
                    />
                  </g>
                );
              })
            )}

            {/* Stundenachse: Die Beschriftung beginnt am Anfang ihrer Stunde. */}
            <g aria-hidden="true">
              {HOUR_INDEXES.filter((hour) => hour % HOUR_TICK_STEP === 0).map(
                (hour) => (
                  <text
                    key={hour}
                    data-heat-tick=""
                    x={cellBox(layout, { weekday: 0, hour }).tile.x}
                    y={layout.height + 15}
                    fontSize={11}
                    fill="var(--theme-analytics-text-muted)"
                  >
                    {t("embed-analytics.weekday-hour.hour-tick", { hour })}
                  </text>
                )
              )}
            </g>
          </svg>
        </div>
      </div>

      {/* Tooltip – außerhalb des verschiebbaren Bereichs, damit er nicht
          abgeschnitten wird: so breit wie sein Text (w-max), höchstens bis an
          den Rand der Karte (maxWidth) – ein längerer Text bricht um. */}
      {tooltip && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute z-10 w-max break-words rounded-md border border-white/10 bg-theme-bg-secondary px-2.5 py-1.5 text-xs text-theme-text-primary shadow-lg"
          style={{ top: tooltip.y, ...tooltipStyle(tooltip) }}
        >
          {beforeValue}
          <span className="font-semibold">{valueText(active)}</span>
          {afterValue}
        </div>
      )}
    </div>
  );
}

/**
 * Der Tooltip steht mit seiner Unterkante über der Zeile des Feldes (mit zwei
 * Zeilen wächst er nach oben); waagerecht bleibt er in der Karte.
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
 * Dieselben 168 Werte als Tabelle: Wochentage als Zeilen, Stunden als Spalten,
 * mit Zeilen- und Spaltensummen – markierbar, per Tastatur erreichbar. In
 * einer schmalen Karte lässt sie sich waagerecht schieben; die Wochentage
 * bleiben stehen.
 */
function GridTable({ grid, context }) {
  const { t, locale } = context;
  const caption = t("embed-analytics.weekday-hour.table.caption");
  const rows = rowTotals(grid);
  const columns = columnTotals(grid);
  const cell = "px-2 py-1.5 text-right tabular-nums";
  const sticky = "sticky left-0 bg-theme-bg-primary";
  return (
    <div
      tabIndex={0}
      role="region"
      aria-label={caption}
      data-heat-table=""
      className="overflow-x-auto rounded-lg border border-white/10 select-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-[color:var(--theme-text-primary)]"
    >
      <table className="w-full border-collapse text-sm text-theme-text-primary">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className={`text-xs ${MUTED}`}>
            <th
              scope="col"
              rowSpan={2}
              className={`${sticky} px-3 py-2 text-left align-bottom font-medium`}
            >
              {t("embed-analytics.weekday-hour.table.weekday")}
            </th>
            <th
              scope="colgroup"
              colSpan={HOURS}
              className="px-2 pt-2 text-left font-medium"
            >
              {t("embed-analytics.weekday-hour.table.hours")}
            </th>
            <th
              scope="col"
              rowSpan={2}
              className="px-3 py-2 text-right align-bottom font-medium"
            >
              {t("embed-analytics.weekday-hour.table.total")}
            </th>
          </tr>
          <tr className={`text-xs ${MUTED}`}>
            {HOUR_INDEXES.map((hour) => (
              <th
                key={hour}
                scope="col"
                aria-label={hoursLabel(hour, hour + 1, t)}
                className={`${cell} font-medium`}
              >
                {hour}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {grid.map((row, weekday) => (
            <tr key={weekday} className="border-t border-white/10">
              <th
                scope="row"
                className={`${sticky} px-3 py-1.5 text-left font-normal whitespace-nowrap`}
              >
                {weekdayName(weekday, locale)}
              </th>
              {row.map((value, hour) => (
                <td
                  key={hour}
                  className={value > 0 ? cell : `${cell} ${MUTED}`}
                >
                  {formatNumber(value)}
                </td>
              ))}
              <td className="px-3 py-1.5 text-right tabular-nums font-semibold">
                {formatNumber(rows[weekday])}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t border-white/10 font-semibold">
            <th scope="row" className={`${sticky} px-3 py-2 text-left`}>
              {t("embed-analytics.weekday-hour.table.total")}
            </th>
            {columns.map((value, hour) => (
              <td key={hour} className={cell}>
                {formatNumber(value)}
              </td>
            ))}
            <td className="px-3 py-2 text-right tabular-nums">
              {formatNumber(gridTotal(grid))}
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
