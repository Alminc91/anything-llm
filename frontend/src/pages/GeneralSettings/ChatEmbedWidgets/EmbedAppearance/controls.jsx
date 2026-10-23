// Gemeinsame Bedienelemente des Design Centers (Erscheinungsbild)
import { useEffect, useLayoutEffect, useRef } from "react";

// Ein Feld: Beschriftung, Bedienelement, darunter der Hinweis (R11, Fixliste
// 7.22-rc9: Hinweise stehen unter dem jeweiligen Feld, wie im Mockup), dann
// Fehler oder Anmerkung.
export function SettingsSection({
  title,
  hint,
  children,
  error = null,
  note = null,
}) {
  return (
    <div data-field="">
      <label className="block text-white text-sm font-medium mb-1.5">
        {title}
      </label>
      {children}
      {hint && (
        <p className="text-theme-text-secondary text-xs mt-1.5 leading-relaxed">
          {hint}
        </p>
      )}
      {error ? (
        <p className="text-red-400 text-xs mt-1.5 leading-relaxed">{error}</p>
      ) : (
        note && (
          <p className="text-theme-text-secondary text-xs mt-1.5 leading-relaxed">
            {note}
          </p>
        )
      )}
    </div>
  );
}

// Zweispaltiges Raster für kurze, zusammengehörige Felder (R11): ab Desktop
// (Tailwind xl, 1.280 px Fensterbreite) nebeneinander, auf Tablet und
// Smartphone untereinander (E15, Fixliste 7.22-rc13: einheitliche
// Geräteklassen Smartphone unter 768 px, Tablet 768 bis 1.279 px, Desktop ab
// 1.280 px; vorher ab 1.100 px). Ein einzelnes Kind nimmt die halbe Breite
// (schmales Feld allein, z. B. die Überschrift des Datenschutz-Hinweises).
// Lange Inhalte (Textfelder mit mehreren Zeilen, Listen, Codeblöcke) gehören
// nicht hinein.
export const FIELD_PAIR_CLASS =
  "grid grid-cols-1 xl:grid-cols-2 gap-5 items-start";

export function FieldPair({ children }) {
  return (
    <div className={FIELD_PAIR_CLASS} data-pair="">
      {children}
    </div>
  );
}

export function inputClass(hasError) {
  return `bg-theme-settings-input-bg text-white text-sm rounded-lg px-3 py-2 w-full border ${
    hasError
      ? "border-red-400/70 focus:border-red-400"
      : "border-white/10 focus:border-white/25"
  } focus:outline-none transition-colors`;
}

/**
 * Höhe eines Textfelds an seinen Inhalt anpassen (R11: Begrüßung und
 * Datenschutz-Text wachsen mit dem Text, keine innere Bildlaufleiste).
 * Gemessen wird die Inhaltshöhe (scrollHeight) plus Rahmen; ohne Maße (kein
 * Browser) bleibt die Höhe frei und es gelten die Mindestzeilen (rows).
 * @param {HTMLTextAreaElement|null} el
 */
export function fitTextareaHeight(el) {
  if (!el || !el.style) return;
  el.style.height = "auto";
  const content = el.scrollHeight;
  if (typeof content !== "number" || content <= 0) {
    el.style.height = "";
    return;
  }
  const frame =
    typeof el.offsetHeight === "number" && typeof el.clientHeight === "number"
      ? Math.max(0, el.offsetHeight - el.clientHeight)
      : 0;
  el.style.height = `${content + frame}px`;
}

// Vor dem Zeichnen messen, wo es ein Dokument gibt; beim serverseitigen
// Rendern (Tests) läuft kein Layout-Effekt und React soll nicht warnen.
const useBeforePaint =
  typeof document !== "undefined" ? useLayoutEffect : useEffect;

// Textfeld, das mit dem Inhalt wächst: Mindesthöhe minRows Zeilen, Höhe folgt
// dem Text beim Tippen und bei geänderter Breite (Fenstergröße); keine
// Bildlaufleiste im Feld, kein Ziehgriff.
export function GrowingTextarea({ value, minRows, className = "", ...rest }) {
  const ref = useRef(null);
  useBeforePaint(() => {
    fitTextareaHeight(ref.current);
  }, [value]);
  useEffect(() => {
    if (typeof window === "undefined" || !window.addEventListener) return;
    const onResize = () => fitTextareaHeight(ref.current);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return (
    <textarea
      ref={ref}
      rows={minRows}
      value={value}
      className={`${className} resize-none overflow-hidden`}
      data-autogrow=""
      {...rest}
    />
  );
}

// Markierte Option: Fläche in der Akzentfarbe der App, Schrift wie beim
// Button „Speichern“ von AnythingLLM (Nutzerentscheidung 21.10.2026, „die
// AnythingLLM Farben anwenden konsistent“): im hellen Modus weiß auf dem
// Blau (#0ba5ec), im Dunkelmodus schwarz auf dem hellen Blau (#46c8ff), weil
// Weiß dort nur etwa 1,9:1 erreicht (Browser 7.22-rc6 B-05).
export const SELECTED_CLASS = "bg-primary-button text-black light:text-white";

// Button-Gruppe im Stil der Positions-Auswahl; compact = kleinere Buttons
// (für Gruppen mit vielen Optionen, bricht bei Bedarf um). placeholder: vorn
// ein nicht wählbares, markiertes Feld (z. B. „bitte wählen“ bei einem
// ungültigen gespeicherten Wert, dann ist keine Option aktiv).
export function Segmented({
  options,
  value,
  onChange,
  compact = false,
  placeholder = null,
}) {
  const size = compact ? "px-3 py-1.5 text-xs" : "px-5 py-2 text-sm";
  return (
    <div
      // bricht auf schmalen Bildschirmen um statt waagerecht zu überlaufen
      className={`flex flex-wrap rounded-lg overflow-hidden border w-fit ${
        placeholder ? "border-red-400/70" : "border-white/10"
      }`}
      data-segmented=""
    >
      {placeholder && (
        <span
          className={`${size} font-medium bg-red-400/15 text-red-300 select-none`}
        >
          {placeholder}
        </span>
      )}
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          // markierte Option auch für Screenreader (Browser 7.22-rc6 B-06)
          aria-pressed={value === opt.value}
          className={`${size} font-medium transition-all flex items-center gap-1.5 ${
            value === opt.value
              ? SELECTED_CLASS
              : "bg-theme-settings-input-bg text-theme-text-secondary hover:text-white hover:bg-theme-action-menu-item-hover"
          }`}
        >
          {/* optionales Symbol vor dem Text (R9: Sonne/Mond beim
              Farbschema), nur Schmuck */}
          {opt.Icon && <opt.Icon size={16} aria-hidden="true" />}
          {opt.label}
        </button>
      ))}
    </div>
  );
}

// Zwischenüberschrift für eine Gruppe von Einstellungen; first = erste
// Gruppe des Reiters (ohne Trennlinie darüber)
export function GroupHeading({ title, hint = null, first = false }) {
  return (
    <div className={first ? "" : "pt-4 border-t border-white/10"}>
      <h2 className="text-white text-base font-semibold">{title}</h2>
      {hint && (
        <p className="text-theme-text-secondary text-xs mt-0.5 leading-relaxed">
          {hint}
        </p>
      )}
    </div>
  );
}
