// Gemeinsame Bedienelemente des Design Centers (Erscheinungsbild)

export function SettingsSection({
  title,
  hint,
  children,
  error = null,
  note = null,
}) {
  return (
    <div>
      <label className="block text-white text-sm font-medium mb-0.5">
        {title}
      </label>
      {hint && (
        <p className="text-theme-text-secondary text-xs mb-2.5 leading-relaxed">
          {hint}
        </p>
      )}
      {children}
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

export function inputClass(hasError) {
  return `bg-theme-settings-input-bg text-white text-sm rounded-lg px-3 py-2 w-full border ${
    hasError
      ? "border-red-400/70 focus:border-red-400"
      : "border-white/10 focus:border-white/25"
  } focus:outline-none transition-colors`;
}

// Markierte Option: Fläche in der Akzentfarbe der App, Schrift schwarz.
// Weiß auf dem hellen Blau des Dunkelmodus (#46c8ff) erreichte nur etwa
// 1,9:1 (Browser 7.22-rc6 B-05); Schwarz hat auf beiden Blautönen über 7:1.
export const SELECTED_CLASS = "bg-primary-button text-black";

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
          className={`${size} font-medium transition-all ${
            value === opt.value
              ? SELECTED_CLASS
              : "bg-theme-settings-input-bg text-theme-text-secondary hover:text-white hover:bg-theme-action-menu-item-hover"
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

// Schalter mit Beschriftung (Datenschutz-Hinweis anzeigen). An: Fläche in
// der Akzentfarbe der App wie die markierten Optionen; aus: graue Fläche
// mit sichtbarem Rand, daneben „An“ bzw. „Aus“ (Browser 7.22-rc6 B-02: der
// allgemeine Toggle war im Aus-Zustand kaum als Schalter zu erkennen und
// im An-Zustand grün statt in der Akzentfarbe).
export function Switch({ label, checked, onChange }) {
  return (
    <label className="flex items-center justify-between gap-4 cursor-pointer">
      <span className="text-white text-sm font-medium">{label}</span>
      <span className="flex items-center gap-2 shrink-0">
        <span
          className="text-xs font-medium text-theme-text-secondary"
          data-switch-state=""
        >
          {checked ? "An" : "Aus"}
        </span>
        <input
          type="checkbox"
          role="switch"
          className="peer sr-only"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span
          aria-hidden="true"
          className="relative w-9 h-5 rounded-full border transition-colors bg-zinc-600 border-zinc-400 light:bg-zinc-300 light:border-zinc-500 peer-checked:bg-primary-button peer-checked:border-primary-button peer-focus-visible:ring-2 peer-focus-visible:ring-primary-button/60 after:absolute after:top-[2px] after:left-[2px] after:w-3.5 after:h-3.5 after:rounded-full after:bg-white after:shadow after:transition-transform after:content-[''] peer-checked:after:translate-x-4"
        />
      </span>
    </label>
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
