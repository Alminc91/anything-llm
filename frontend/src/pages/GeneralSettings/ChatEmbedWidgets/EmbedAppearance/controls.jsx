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

// Button-Gruppe im Stil der Positions-Auswahl; compact = kleinere Knöpfe
// (für Gruppen mit vielen Optionen, bricht bei Bedarf um)
export function Segmented({ options, value, onChange, compact = false }) {
  return (
    <div
      className={`flex rounded-lg overflow-hidden border border-white/10 w-fit ${
        compact ? "flex-wrap" : ""
      }`}
    >
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          className={`${
            compact ? "px-3 py-1.5 text-xs" : "px-5 py-2 text-sm"
          } font-medium transition-all ${
            value === opt.value
              ? "bg-primary-button text-white"
              : "bg-theme-settings-input-bg text-theme-text-secondary hover:text-white hover:bg-theme-action-menu-item-hover"
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

// Zwischenüberschrift für eine Gruppe von Einstellungen
export function GroupHeading({ title, hint = null }) {
  return (
    <div className="pt-4 border-t border-white/10">
      <h2 className="text-white text-base font-semibold">{title}</h2>
      {hint && (
        <p className="text-theme-text-secondary text-xs mt-0.5 leading-relaxed">
          {hint}
        </p>
      )}
    </div>
  );
}

export function CheckboxRow({ checked, onChange, label }) {
  return (
    <label className="flex items-center gap-2.5 cursor-pointer select-none">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="w-4 h-4 accent-primary-button cursor-pointer"
      />
      <span className="text-white text-sm">{label}</span>
    </label>
  );
}
