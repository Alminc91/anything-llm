import { useEffect, useRef, useState } from "react";
import { CaretDown, DownloadSimple } from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";
import { saveAs } from "file-saver";
import Embed from "@/models/embed";
import { formatNumber } from "@/utils/analyticsTimeline";
import showToast from "@/utils/toast";
import { MUTED } from "@/utils/conversationView";

// KIE-538: „Exportieren" in der Kopfzeile der Konversationsliste. Exportiert
// wird, was die Liste gerade zeigt – Widget, Zeitraum, Feedback-Filter, der
// Abschnitt aus dem Diagramm und der Suchbegriff –, über alle Seiten.

const FORMATS = [
  { format: "csv", labelKey: "embed-analytics.export.csv" },
  { format: "json", labelKey: "embed-analytics.export.json" },
];

/**
 * @param {Object} props
 * @param {number} props.embedId
 * @param {string|null} props.startDate - ISO-Zeitstempel des Browsers
 * @param {string|null} props.endDate
 * @param {"all"|"negative"|"positive"} props.feedbackFilter
 * @param {{start: string, end: string}|null} [props.bucket] - Abschnitt aus dem Diagramm
 * @param {string} [props.search] - Suchbegriff der Liste ("" = keine Suche)
 * @param {boolean} [props.disabled] - nichts zu exportieren (Liste leer oder lädt)
 * @param {string} [props.className] - Aussehen der Schaltfläche (wie die Filter daneben)
 * @param {string} [props.wrapperClassName] - Platz in der Kopfzeile (order …)
 *
 * Unter sm zeigt die Schaltfläche nur das Symbol; ihr Name „Exportieren"
 * bleibt für Screenreader (Fixliste 2, B1). Der Pfeil erst ab xl – bis dahin
 * steht sie kompakt neben Suche und Filtern (Fixliste 3, V7).
 */
export default function ExportMenu({
  embedId,
  startDate,
  endDate,
  feedbackFilter = "all",
  bucket = null,
  search = "",
  disabled = false,
  className = "",
  wrapperClassName = "",
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const containerRef = useRef(null);
  // Wird die Schaltfläche gesperrt (Liste lädt neu, scheitert, ist leer),
  // schließt die offene Auswahl – sie bliebe sonst bedienbar (Fixliste 2, R9).
  if (open && disabled) setOpen(false);

  // Klick außerhalb oder Escape schließt die Auswahl.
  useEffect(() => {
    if (!open) return;
    function handleMouseDown(e) {
      if (containerRef.current && !containerRef.current.contains(e.target))
        setOpen(false);
    }
    function handleKeyDown(e) {
      if (e.key !== "Escape") return;
      // Escape schließt nur die Auswahl, nicht auch das Seitenpanel
      // (ConversationDetail achtet auf defaultPrevented).
      e.preventDefault();
      setOpen(false);
    }
    document.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  const runExport = async (format) => {
    setOpen(false);
    setRunning(true);
    const { success, blob, filename, reason, max } =
      await Embed.exportConversations(embedId, format, {
        startDate,
        endDate,
        feedbackFilter,
        startedBetween: bucket
          ? { fromDay: bucket.start, toDay: bucket.end }
          : null,
        search,
      });
    setRunning(false);

    if (!success) {
      // Mit Suche ist die Treffermenge begrenzt (Fixliste 3, C10): Die
      // Meldung nennt die Grenze und was zu tun ist.
      showToast(
        reason === "too-many-hits" && max !== null
          ? t("embed-analytics.export.too-many", { max: formatNumber(max) })
          : t("embed-analytics.export.error"),
        "error"
      );
      return;
    }
    saveAs(blob, filename);
    showToast(t("embed-analytics.export.success", { filename }), "success");
  };

  return (
    <div
      className={`relative ${wrapperClassName}`}
      ref={containerRef}
      data-export-menu=""
    >
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled || running}
        title={t("embed-analytics.export.hint")}
        onClick={() => setOpen(!open)}
        className={`${className} disabled:cursor-not-allowed disabled:opacity-50`}
      >
        <DownloadSimple size={16} aria-hidden="true" className="shrink-0" />
        <span className="sr-only sm:not-sr-only">
          {running
            ? t("embed-analytics.export.running")
            : t("embed-analytics.export.button")}
        </span>
        <CaretDown
          size={12}
          aria-hidden="true"
          className={`hidden transition-transform xl:block ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && !disabled && (
        <div
          role="menu"
          aria-label={t("embed-analytics.export.menu-label")}
          className="absolute right-0 top-full z-50 mt-1 min-w-full overflow-hidden rounded-lg border border-white/10 bg-theme-bg-secondary shadow-xl light:border-gray-200"
        >
          {FORMATS.map(({ format, labelKey }) => (
            <button
              key={format}
              type="button"
              role="menuitem"
              data-export-format={format}
              onClick={() => runExport(format)}
              // gedämpft wie die übrigen Menüs: hell #5f6368, 6,1:1 (B2)
              className={`block min-h-[44px] w-full whitespace-nowrap px-3 py-2 text-left text-sm ${MUTED} transition-colors hover:bg-white/5 hover:text-theme-text-primary sm:min-h-0 light:hover:bg-black/5`}
            >
              {t(labelKey)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
