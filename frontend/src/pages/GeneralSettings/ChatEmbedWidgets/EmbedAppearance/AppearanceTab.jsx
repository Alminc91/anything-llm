// Design Center › Aussehen: Darstellung, Farbschema, Kundenfarbe, Schrift in
// Nutzer-Nachrichten, Logo; nur bei Chatblase Position und Chat-Icon.
// Darunter der Kasten „Fest eingebaut“ mit den festen Standards.
import { Check, LockSimple, X } from "@phosphor-icons/react";
import { SettingsSection, Segmented } from "./controls";
import { CHAT_ICONS, DEFAULT_LOGO } from "./WidgetPreview";
import {
  DISPLAY_MODE_OPTIONS,
  POSITION_OPTIONS,
  THEME_OPTIONS,
  USER_TEXT_COLOR_OPTIONS,
  DEFAULT_ACCENT_COLOR,
  displayMode,
  lookValue,
  themeChoice,
  textValue,
} from "./widgetKeys";

// Feste Standards je Darstellung (wie server/utils/chats/embedStandards.js).
// Kurskarten seit 7.22-rc3 in beiden Darstellungen (BUBBLE_COURSE_CARDS
// "auto", Entscheidung D1); bei einer Änderung dort auch diesen Text
// anpassen. Der Datenschutz-Hinweis ist nicht fest (Schalter im Reiter
// Inhalt, KIE-565 Nachtrag) und steht deshalb nicht in diesem Kasten.
export const FIXED_STANDARDS = {
  bubble: {
    title: "Fest eingebaut, für alle Chatbots gleich",
    items: [
      "Begrüßung als Blase",
      "Startvorschläge als Knöpfe",
      "Folgefragen als Knöpfe",
      "Kurskarten zuerst, dann die kurze Antwort",
      "KI-Hinweis unter der Eingabe",
      "Fenstergröße und Randabstand",
      "Kein Online-Punkt",
    ],
    note: "Den Datenschutz-Hinweis schalten Sie im Reiter „Inhalt“ ein oder aus.",
  },
  inline: {
    title: "Fest eingebaut wie in unserer Demo",
    items: [
      "Öffnet beim Klick ins Feld",
      "Effekt „Verwandeln“",
      "Leisten-Stil und Startzustand",
      "Breite und Höhe der Box",
      "Kurskarten als Zeilen, zuerst die Karten, dann die kurze Antwort",
      "Folgefragen als Knöpfe",
      "KI-Hinweis unter der Eingabe",
    ],
    note: "Keine Auswahl nötig: Position, Chat-Icon, Fenstergröße und Effekte entfallen bei Inline. Den Datenschutz-Hinweis schalten Sie im Reiter „Inhalt“ ein oder aus.",
  },
};

export function FixedStandardsBox({ mode }) {
  const { title, items, note } = FIXED_STANDARDS[mode];
  return (
    <div
      className="rounded-lg border border-white/10 bg-theme-bg-secondary p-4 space-y-3"
      data-testid="fixed-standards"
    >
      <p className="flex items-center gap-2 text-white text-sm font-semibold">
        <LockSimple size={16} weight="bold" aria-hidden="true" />
        {title}
      </p>
      <ul className="grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-1.5">
        {items.map((item) => (
          <li
            key={item}
            className="flex items-start gap-2 text-xs text-theme-text-secondary leading-snug"
          >
            <Check
              size={13}
              weight="bold"
              className="text-primary-button flex-shrink-0 mt-0.5"
              aria-hidden="true"
            />
            {item}
          </li>
        ))}
      </ul>
      {note && (
        <p className="text-theme-text-secondary text-xs leading-relaxed">
          {note}
        </p>
      )}
    </div>
  );
}

export default function AppearanceTab({
  config,
  updateField,
  logoPreview,
  onLogoUpload,
  onLogoRemove,
}) {
  const mode = displayMode(config);
  // ohne gespeicherte Farbe der Standard des Widgets (wie live)
  const accentColor = lookValue(config, "accentColor");
  const userTextColor = lookValue(config, "userTextColor");
  const position = lookValue(config, "position");
  const chatIcon = lookValue(config, "chatIcon");
  const theme = themeChoice(config);
  return (
    <>
      <SettingsSection
        title="Darstellung"
        hint={
          mode === "inline"
            ? "Die Eingabeleiste steht dort, wo Sie den Platzhalter einbauen (Reiter „Einbau“). Auf dem Handy öffnet der Chat im Vollbild."
            : "Chatblase: Knopf unten in der Ecke, öffnet ein Chatfenster. Inline: Eingabeleiste direkt im Seiteninhalt."
        }
      >
        <Segmented
          options={DISPLAY_MODE_OPTIONS}
          value={mode}
          onChange={(v) => updateField("displayMode", v)}
        />
      </SettingsSection>

      <SettingsSection
        title="Farbschema"
        hint="Hell oder Dunkel, für Chatfenster und Eingabeleiste gleich."
        note={
          theme === null
            ? "Bisher: automatisch nach Gerät. Bleibt so, bis Sie Hell oder Dunkel wählen."
            : null
        }
      >
        <Segmented
          options={THEME_OPTIONS}
          value={theme}
          onChange={(v) => updateField("theme", v)}
        />
      </SettingsSection>

      <SettingsSection
        title="Kundenfarbe"
        hint="Knöpfe, Nutzer-Nachrichten, Links."
      >
        <div className="relative flex items-center bg-theme-settings-input-bg rounded-lg border border-white/10 hover:border-white/25 transition-colors w-44 cursor-pointer">
          <div className="relative flex-shrink-0 ml-1.5">
            <div
              className="w-8 h-8 rounded-md"
              style={{ backgroundColor: accentColor }}
            />
            <input
              type="color"
              value={accentColor}
              onChange={(e) => updateField("accentColor", e.target.value)}
              className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
              aria-label="Kundenfarbe wählen"
            />
          </div>
          <input
            type="text"
            value={textValue(config.accentColor)}
            onChange={(e) => updateField("accentColor", e.target.value)}
            className="bg-transparent text-white text-sm px-2.5 py-2.5 w-full font-mono outline-none"
            placeholder={DEFAULT_ACCENT_COLOR}
            aria-label="Kundenfarbe als Farbcode"
          />
        </div>
      </SettingsSection>

      <SettingsSection
        title="Schrift in Nutzer-Nachrichten"
        hint="Lesbar auf der Kundenfarbe."
      >
        <div className="flex rounded-lg overflow-hidden border border-white/10 w-fit">
          {USER_TEXT_COLOR_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => updateField("userTextColor", opt.value)}
              className={`flex items-center gap-2 px-5 py-2 text-sm font-medium transition-all ${
                userTextColor === opt.value
                  ? "bg-primary-button text-white"
                  : "bg-theme-settings-input-bg text-theme-text-secondary hover:text-white hover:bg-theme-action-menu-item-hover"
              }`}
            >
              <span
                className="w-3.5 h-3.5 rounded-full border border-white/20"
                style={{ backgroundColor: opt.value }}
              />
              {opt.label}
            </button>
          ))}
        </div>
      </SettingsSection>

      <SettingsSection
        title="Logo"
        hint="PNG, JPG, GIF, SVG oder WebP, max. 5 MB, idealerweise quadratisch."
      >
        <div className="flex items-center gap-4">
          <div className="relative group">
            <img
              src={logoPreview || DEFAULT_LOGO}
              alt="Logo"
              className="h-12 w-12 rounded-lg object-contain bg-theme-settings-input-bg border border-white/10"
            />
            {logoPreview && (
              <button
                type="button"
                onClick={onLogoRemove}
                aria-label="Logo entfernen"
                className="absolute -top-1.5 -right-1.5 bg-theme-bg-container text-theme-text-secondary hover:text-red-400 rounded-full p-0.5 border border-white/10 transition-colors"
              >
                <X size={12} weight="bold" />
              </button>
            )}
          </div>
          <label className="cursor-pointer bg-theme-settings-input-bg text-white text-sm rounded-lg px-4 py-2 border border-white/10 hover:bg-theme-action-menu-item-hover transition-all">
            {logoPreview ? "Logo ändern" : "Hochladen"}
            <input
              type="file"
              accept="image/png,image/jpeg,image/gif,image/svg+xml,image/webp"
              onChange={onLogoUpload}
              className="hidden"
            />
          </label>
        </div>
      </SettingsSection>

      {mode === "bubble" && (
        <>
          <SettingsSection
            title="Position der Chatblase"
            hint="Unten links oder unten rechts auf der Seite."
          >
            <Segmented
              options={POSITION_OPTIONS}
              value={position}
              onChange={(v) => updateField("position", v)}
            />
          </SettingsSection>

          <SettingsSection
            title="Chat-Icon"
            hint="Das Icon auf dem Chat-Knopf."
          >
            <div className="flex gap-2.5 flex-wrap">
              {CHAT_ICONS.map(({ id, label, Icon }) => {
                const isSelected = chatIcon === id;
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => updateField("chatIcon", id)}
                    className="flex flex-col items-center gap-1.5 p-1.5 rounded-lg transition-all"
                    title={label}
                    aria-pressed={isSelected}
                  >
                    <div
                      className={`relative w-11 h-11 rounded-full flex items-center justify-center text-white shadow-md transition-all hover:scale-110 ${
                        isSelected
                          ? "ring-2 ring-white ring-offset-2 ring-offset-theme-bg-container"
                          : ""
                      }`}
                      style={{ backgroundColor: accentColor }}
                    >
                      <Icon size={22} weight="fill" color="#ffffff" />
                    </div>
                    <span
                      className={`text-[10px] transition-colors ${
                        isSelected ? "text-white" : "text-theme-text-secondary"
                      }`}
                    >
                      {label}
                    </span>
                  </button>
                );
              })}
            </div>
          </SettingsSection>
        </>
      )}

      <FixedStandardsBox mode={mode} />
    </>
  );
}
