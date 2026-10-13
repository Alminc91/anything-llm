import { useEffect, useRef, useState } from "react";
import { CaretDown, DownloadSimple } from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";
import { saveAs } from "file-saver";
import Embed from "@/models/embed";
import showToast from "@/utils/toast";

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
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const containerRef = useRef(null);

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
    const { success, blob, filename } = await Embed.exportConversations(
      embedId,
      format,
      {
        startDate,
        endDate,
        feedbackFilter,
        startedBetween: bucket
          ? { fromDay: bucket.start, toDay: bucket.end }
          : null,
        search,
      }
    );
    setRunning(false);

    if (!success) {
      showToast(t("embed-analytics.export.error"), "error");
      return;
    }
    saveAs(blob, filename);
    showToast(t("embed-analytics.export.success", { filename }), "success");
  };

  return (
    <div className="relative" ref={containerRef} data-export-menu="">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled || running}
        title={t("embed-analytics.export.hint")}
        onClick={() => setOpen(!open)}
        className={`${className} disabled:cursor-not-allowed disabled:opacity-50`}
      >
        <DownloadSimple size={15} aria-hidden="true" />
        {running
          ? t("embed-analytics.export.running")
          : t("embed-analytics.export.button")}
        <CaretDown
          size={12}
          aria-hidden="true"
          className={`transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && (
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
              className="block w-full whitespace-nowrap px-3 py-2 text-left text-sm text-theme-text-secondary transition-colors hover:bg-white/5 hover:text-theme-text-primary light:hover:bg-black/5"
            >
              {t(labelKey)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
