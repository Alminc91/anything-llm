import {
  useState,
  useRef,
  useEffect,
  useLayoutEffect,
  useCallback,
} from "react";
import { useTranslation } from "react-i18next";
import { CalendarBlank, CaretDown, Check } from "@phosphor-icons/react";
import { DayPicker } from "react-day-picker";
import { de } from "react-day-picker/locale";
import "react-day-picker/style.css";
import { lastDaysRange, lastMonthsRange } from "@/utils/analyticsTimeline";

/**
 * Computes fixed calendar-boundary preset dates (NOT rolling windows).
 * Returns { from: Date|null, to: Date|null }
 */
/**
 * Returns a new Date with time set to 23:59:59.999 (end of day).
 * Critical: without this, API queries miss all conversations after 00:00.
 */
function endOfDay(date) {
  const d = new Date(date);
  d.setHours(23, 59, 59, 999);
  return d;
}

function getPresetRange(presetKey) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  switch (presetKey) {
    case "today":
      return { from: today, to: endOfDay(today) };
    case "yesterday": {
      const yesterday = new Date(today);
      yesterday.setDate(yesterday.getDate() - 1);
      return { from: yesterday, to: endOfDay(yesterday) };
    }
    case "this-week": {
      // German convention: week starts on Monday
      const dayOfWeek = today.getDay(); // 0=Sun, 1=Mon...
      const diff = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
      const monday = new Date(today);
      monday.setDate(today.getDate() - diff);
      return { from: monday, to: endOfDay(today) };
    }
    case "last-week": {
      // German convention: week starts on Monday
      const lwDayOfWeek = today.getDay();
      const lwDiff = lwDayOfWeek === 0 ? 6 : lwDayOfWeek - 1;
      const thisMonday = new Date(today);
      thisMonday.setDate(today.getDate() - lwDiff);
      const lastMonday = new Date(thisMonday);
      lastMonday.setDate(thisMonday.getDate() - 7);
      const lastSunday = new Date(thisMonday);
      lastSunday.setDate(thisMonday.getDate() - 1);
      return { from: lastMonday, to: endOfDay(lastSunday) };
    }
    case "last-30-days": {
      // KIE-536: heute und die 29 Tage davor (rollierend)
      const { startDate, endDate } = lastDaysRange(30, now);
      return { from: startDate, to: endDate };
    }
    case "this-month":
      return {
        from: new Date(today.getFullYear(), today.getMonth(), 1),
        to: endOfDay(today),
      };
    case "last-month": {
      const firstOfLastMonth = new Date(
        today.getFullYear(),
        today.getMonth() - 1,
        1
      );
      const lastOfLastMonth = new Date(
        today.getFullYear(),
        today.getMonth(),
        0
      );
      return { from: firstOfLastMonth, to: endOfDay(lastOfLastMonth) };
    }
    case "last-12-months": {
      // KIE-536: der Tag nach dem heutigen Datum vor 12 Monaten bis heute
      const { startDate, endDate } = lastMonthsRange(12, now);
      return { from: startDate, to: endDate };
    }
    case "all":
      return { from: null, to: null };
    default:
      return { from: null, to: null };
  }
}

/**
 * Welche Vorauswahl entspricht dem Zeitraum? Verglichen wird nur der Tag.
 * @param {Date|null} startDate
 * @param {Date|null} endDate
 * @returns {string|null} - Schlüssel der Vorauswahl oder null (eigener Zeitraum)
 */
function matchPreset(startDate, endDate) {
  const sameDay = (a, b) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();

  const matched = PRESET_KEYS.find((key) => {
    const { from, to } = getPresetRange(key);
    if (key === "all") return startDate === null && endDate === null;
    if (!from || !to || !startDate || !endDate) return false;
    return sameDay(from, startDate) && sameDay(to, endDate);
  });
  return matched || null;
}

/**
 * Format a Date as dd.MM.yyyy (German format)
 */
function formatDE(date) {
  if (!date) return "";
  const d = String(date.getDate()).padStart(2, "0");
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const y = date.getFullYear();
  return `${d}.${m}.${y}`;
}

const PRESET_KEYS = [
  "today",
  "yesterday",
  "this-week",
  "last-week",
  "last-30-days",
  "this-month",
  "last-month",
  "last-12-months",
  "all",
];

// Breites Popover (wie bisher): zwei Kalendermonate, rechtsbündig am Auslöser,
// so breit wie seine Mindestbreite (min-w-[580px]) – der Inhalt ist schmaler.
const WIDE_POPOVER_WIDTH = 580;
// Schmales Popover (KIE-536): ein Kalendermonat (7 × 36 px) mit Innenabstand
// und Rand, höchstens so breit wie der sichtbare Bereich.
const NARROW_POPOVER_WIDTH = 320;
// Abstand des Popovers zum Rand des sichtbaren Bereichs
const POPOVER_MARGIN = 8;

/**
 * Lage des schmalen Popovers: höchstens so breit wie der sichtbare Bereich
 * abzüglich Rand, linksbündig am Auslöser – und so weit verschoben, dass es
 * ganz im sichtbaren Bereich bleibt.
 * @param {{anchorLeft: number, from: number, to: number}} params - linke Kante
 *   des Auslösers und sichtbarer Bereich (visibleRange), in px ab dem
 *   linken Fensterrand
 * @returns {{left: number, width: number}} - left ab der linken Kante des Auslösers
 */
export function narrowPopoverPlacement({ anchorLeft, from, to }) {
  const width = Math.max(
    0,
    Math.min(NARROW_POPOVER_WIDTH, to - from - 2 * POPOVER_MARGIN)
  );
  const left = Math.max(
    from + POPOVER_MARGIN,
    Math.min(anchorLeft, to - POPOVER_MARGIN - width)
  );
  return { left: left - anchorLeft, width };
}

/**
 * Breit oder schmal? Es entscheidet der Bereich, in dem das Popover zu sehen
 * ist (visibleRange), nicht die Fensterbreite: Neben der Einstellungs-Sidebar
 * bleibt vom Fenster nur der Inhaltsbereich. Passt das breite Popover mit
 * Rand hinein, steht es wie bisher rechtsbündig am Auslöser (ohne eigene
 * Lage); ragte es dabei links aus dem Bereich, rückt es so weit nach rechts,
 * dass es ganz darin steht. Sonst gilt das schmale Popover.
 * Ohne messbaren Bereich (kein Layout) bleibt es beim breiten Popover.
 * @param {{anchorLeft: number, anchorRight: number, from: number, to: number}} params -
 *   linke und rechte Kante des Auslösers und sichtbarer Bereich, in px ab
 *   dem linken Fensterrand
 * @returns {{narrow: boolean, style: object|undefined}} - style: Lage des
 *   Popovers, soweit sie von seinen Klassen abweicht
 */
export function popoverLayout({ anchorLeft, anchorRight, from, to }) {
  if (to - from < WIDE_POPOVER_WIDTH + 2 * POPOVER_MARGIN)
    return {
      narrow: true,
      style: {
        ...narrowPopoverPlacement({ anchorLeft, from, to }),
        right: "auto",
      },
    };
  const overhang = from + POPOVER_MARGIN - (anchorRight - WIDE_POPOVER_WIDTH);
  return {
    narrow: false,
    style: overhang > 0 ? { right: -overhang } : undefined,
  };
}

/**
 * Waagerechter Bereich, in dem ein Element zu sehen ist: das Fenster,
 * eingeengt durch Vorfahren, die ihren Inhalt beschneiden oder scrollen (die
 * Einstellungsseiten scrollen in einem Rahmen, dessen Scrollleiste Platz
 * braucht). Was darüber hinausragt, ließe den Rahmen waagerecht scrollen.
 * @param {Element} element
 * @returns {{from: number, to: number}} - px ab dem linken Fensterrand
 */
function visibleRange(element) {
  let from = 0;
  let to = document.documentElement.clientWidth || window.innerWidth;
  for (let node = element.parentElement; node; node = node.parentElement) {
    if (window.getComputedStyle(node).overflowX === "visible") continue;
    const left = node.getBoundingClientRect().left + node.clientLeft;
    from = Math.max(from, left);
    to = Math.min(to, left + node.clientWidth);
  }
  return { from, to };
}

/**
 * Chatbase-inspired DateRange picker with preset dropdown + dual calendar.
 *
 * Props:
 * - startDate: Date|null - current start
 * - endDate: Date|null - current end
 * - onChange: ({ startDate: Date|null, endDate: Date|null }) => void
 */
export default function DateRangePicker({ startDate, endDate, onChange }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  // Layout und Lage des offenen Popovers (popoverLayout); null, solange es
  // geschlossen oder noch nicht vermessen ist.
  const [layout, setLayout] = useState(null);
  const narrow = layout?.narrow ?? false;
  const wrapperRef = useRef(null);
  const [presetDropdownOpen, setPresetDropdownOpen] = useState(false);
  const [calendarRange, setCalendarRange] = useState({
    from: startDate,
    to: endDate,
  });
  const [activePreset, setActivePreset] = useState(() =>
    matchPreset(startDate, endDate)
  );
  const popoverRef = useRef(null);
  const triggerRef = useRef(null);

  // Detect which preset matches current dates (compare date part only)
  useEffect(() => {
    setActivePreset(matchPreset(startDate, endDate));
  }, [startDate, endDate]);

  // Sync calendarRange when popover opens
  useEffect(() => {
    if (open) {
      setCalendarRange({ from: startDate, to: endDate });
    }
  }, [open, startDate, endDate]);

  // Beim Öffnen und bei jeder Größenänderung des Fensters wird der sichtbare
  // Bereich vermessen: Er entscheidet über ein oder zwei Kalendermonate und
  // über die Lage. Das Popover erscheint erst vermessen – der Kalender zeigt
  // so von Anfang an den richtigen Monat.
  useLayoutEffect(() => {
    if (!open) return;
    function place() {
      const wrapper = wrapperRef.current;
      if (!wrapper) return;
      const { left, right } = wrapper.getBoundingClientRect();
      setLayout(
        popoverLayout({
          anchorLeft: left,
          anchorRight: right,
          ...visibleRange(wrapper),
        })
      );
    }
    place();
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("resize", place);
      setLayout(null);
    };
  }, [open]);

  // Click outside to close
  useEffect(() => {
    if (!open) return;
    function handleMouseDown(e) {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(e.target) &&
        triggerRef.current &&
        !triggerRef.current.contains(e.target)
      ) {
        setOpen(false);
        setPresetDropdownOpen(false);
      }
    }
    document.addEventListener("mousedown", handleMouseDown);
    return () => document.removeEventListener("mousedown", handleMouseDown);
  }, [open]);

  const handlePresetSelect = useCallback(
    (key) => {
      const { from, to } = getPresetRange(key);
      setActivePreset(key);
      setPresetDropdownOpen(false);
      setOpen(false);
      onChange({ startDate: from, endDate: to });
    },
    [onChange]
  );

  const handleCalendarSelect = useCallback((range) => {
    if (!range) return;
    setCalendarRange({ from: range.from || null, to: range.to || null });
    setActivePreset(null);
  }, []);

  const handleApply = useCallback(() => {
    if (calendarRange.from) {
      const end = calendarRange.to || calendarRange.from;
      onChange({
        startDate: calendarRange.from,
        endDate: endOfDay(end),
      });
      setOpen(false);
      setPresetDropdownOpen(false);
    }
  }, [calendarRange, onChange]);

  // Display text for trigger button
  const displayText =
    startDate === null && endDate === null
      ? t("date-picker.all")
      : `${formatDE(startDate)} - ${formatDE(endDate)}`;

  // Beim Öffnen sichtbar: der Monat, in dem der gewählte Zeitraum endet –
  // im breiten Popover rechts, davor der Vormonat; ohne Zeitraum („Gesamt")
  // der laufende Monat. Vorher war es der Monat des Beginns rechts: „Letzte
  // 30 Tage" bis zum 14.10. zeigte August/September statt September/Oktober
  // (Fixliste 7, B6).
  const defaultMonth = endDate || startDate || new Date();
  // For dual calendar, show previous month + default month
  const calendarMonth = new Date(
    defaultMonth.getFullYear(),
    defaultMonth.getMonth() - 1,
    1
  );

  return (
    <div ref={wrapperRef} className="relative">
      {/* Trigger Button */}
      <button
        ref={triggerRef}
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 bg-theme-settings-input-bg text-theme-text-primary rounded-lg px-4 py-2 text-sm border border-white/10 cursor-pointer"
      >
        <CalendarBlank size={16} className="text-theme-text-secondary" />
        <span>{displayText}</span>
        <CaretDown
          size={12}
          className={`text-theme-text-primary ml-1 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {/* Popover */}
      {open && layout && (
        <div
          ref={popoverRef}
          data-date-popover={narrow ? "narrow" : "wide"}
          className={`absolute right-0 top-full mt-2 z-50 bg-theme-bg-secondary border border-white/10 rounded-xl shadow-2xl p-4 ${narrow ? "max-w-[calc(100vw-16px)]" : "min-w-[580px]"}`}
          style={layout.style}
        >
          {/* Preset Dropdown */}
          <div className="relative mb-3">
            <button
              onClick={() => setPresetDropdownOpen(!presetDropdownOpen)}
              className="flex items-center justify-between w-full bg-theme-settings-input-bg text-theme-text-primary rounded-lg px-3 py-2 text-sm border border-white/10 cursor-pointer"
            >
              <span>
                {activePreset
                  ? t(`date-picker.${activePreset}`)
                  : t("date-picker.custom-range")}
              </span>
              <CaretDown
                size={12}
                className={`text-theme-text-secondary transition-transform ${presetDropdownOpen ? "rotate-180" : ""}`}
              />
            </button>

            {presetDropdownOpen && (
              <div className="absolute left-0 top-full mt-1 w-full bg-theme-bg-secondary border border-white/10 rounded-lg shadow-xl z-50 overflow-hidden">
                {PRESET_KEYS.map((key) => (
                  <button
                    key={key}
                    onClick={() => handlePresetSelect(key)}
                    className={`flex items-center justify-between w-full px-3 py-2 text-sm text-left transition-all cursor-pointer
                      ${activePreset === key ? "bg-white/10 text-theme-text-primary font-medium" : "text-theme-text-secondary hover:bg-white/5 hover:text-theme-text-primary"}`}
                  >
                    <span>{t(`date-picker.${key}`)}</span>
                    {activePreset === key && (
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

          {/* Divider */}
          <div className="h-px bg-white/10 mb-3" />

          {/* Dual Calendar – im schmalen Popover ein Monat, mittig */}
          <div
            className={`rdp-theme-wrapper${narrow ? " flex justify-center" : ""}`}
          >
            {/* key: Wechselt das Layout bei offenem Popover, beginnt der
                Kalender wie frisch geöffnet (defaultMonth gilt nur anfangs). */}
            <DayPicker
              key={narrow ? "narrow" : "wide"}
              mode="range"
              locale={de}
              weekStartsOn={1}
              numberOfMonths={narrow ? 1 : 2}
              defaultMonth={narrow ? defaultMonth : calendarMonth}
              selected={
                calendarRange.from
                  ? { from: calendarRange.from, to: calendarRange.to }
                  : undefined
              }
              onSelect={handleCalendarSelect}
              disabled={{ after: new Date() }}
            />
          </div>

          {/* Apply Button – primäre Schaltfläche (bg-primary-button =
              --theme-button-primary). Schwarze Schrift in beiden Themes:
              10,97:1 auf #46c8ff (dunkel), 7,61:1 auf #0ba5ec (hell); Weiß
              erreichte dort nur 1,91:1 bzw. 2,76:1. */}
          <div className="flex justify-end mt-3 pt-3 border-t border-white/10">
            <button
              onClick={handleApply}
              disabled={!calendarRange.from}
              className="px-4 py-2 text-sm font-medium rounded-lg transition-all cursor-pointer
                bg-primary-button text-black hover:opacity-90
                disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {t("date-picker.apply")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
