// Design Center › Aussehen (Reihenfolge und Paarung nach R11, Fixliste
// 7.22-rc9, Mockup Ansichten 1 und 2): Darstellung einspaltig, dann kurze
// Felder paarweise nebeneinander: Akzentfarbe | Schrift auf der Akzentfarbe,
// beim Chatfenster Logo | Chat-Icon (sechs Icons in einer Reihe, ohne
// Beschriftung darunter) und Farbschema | Position des Chat-Buttons (D11,
// Fixliste 7.22-rc11: Wortlaut wie im Mockup, die Wahl gilt dem Button in
// der Ecke, das Chatfenster öffnet darüber), bei „In der Seite“
// Farbschema | Logo; für beide Darstellungen „Antworten mit Kursen“
// (KIE-567, untereinander, die Auswahl ist zu breit für die halbe Spalte).
// Am Ende eine gedämpfte Zeile mit dem, was fest vorgegeben ist (R2,
// Fixliste 7.22-rc8). Hinweise nur, wo sie etwas erklären (S3, Fixliste
// 7.22-rc10, damit der Reiter bei 1440×900 ohne Scrollen passt): unter
// Darstellung, Akzentfarbe und Chat-Icon; unter „Schrift auf der
// Akzentfarbe“ nur die Empfehlung und ggf. die Warnung; unter „Kurse
// anzeigen als“ eine Zeile; Logo, Farbschema, Position und Reihenfolge ohne.
import { Moon, Sun, Warning, X } from "@phosphor-icons/react";
import {
  FieldPair,
  GroupHeading,
  SELECTED_CLASS,
  SettingsSection,
  Segmented,
} from "./controls";
import { CHAT_ICONS, DEFAULT_LOGO } from "./WidgetPreview";
import {
  COURSE_CARDS_OPTIONS,
  COURSE_CARDS_POSITION_OPTIONS,
  DISPLAY_MODE_OPTIONS,
  POSITION_OPTIONS,
  THEME_OPTIONS,
  USER_TEXT_COLOR_OPTIONS,
  accentFieldValue,
  choiceDefault,
  choiceValue,
  displayMode,
  lookValue,
  themeChoice,
  userTextColorAdvice,
  userTextColorChoice,
} from "./widgetKeys";

// Unter „Schrift auf der Akzentfarbe“: nur die Empfehlung nach Kontrast (S3,
// Fixliste 7.22-rc10; F12, Fixliste 7.22-rc13: ohne den Zusatz, dass ohne
// Wahl die Empfehlung gilt; das zeigt die markierte Option)
function UserTextColorAdvice({ advice }) {
  if (!advice.recommendedLabel) return null;
  return (
    <div className="mt-1.5 space-y-1" data-testid="user-text-advice">
      <p className="text-theme-text-secondary text-xs leading-relaxed">
        {`Empfohlen: ${advice.recommendedLabel}`}
      </p>
    </div>
  );
}

// Warnung unter 4,5:1, über die volle Breite unter dem Paar Akzentfarbe |
// Schrift (R11: in der halben Spalte wurden es vier Zeilen, so sind es
// zwei). Bernstein im Dunkelmodus, dunkler Bernstein auf hellem Grund
// (Browser 7.22-rc6 B-02: text-amber-400 auf Weiß kaum lesbar).
function UserTextColorWarning({ advice }) {
  if (!advice.warning) return null;
  return (
    <p
      className="flex items-start gap-1.5 mt-2 text-amber-400 light:text-amber-700 text-xs leading-relaxed"
      role="alert"
      data-testid="user-text-warning"
    >
      <Warning
        size={14}
        weight="bold"
        className="flex-shrink-0 mt-0.5"
        aria-hidden="true"
      />
      {advice.warning}
    </p>
  );
}

// Hinweis unter „Darstellung“ (R3): beide Darstellungen erklärt; bei „In
// der Seite“ dazu der Hinweis auf das Handy
export const DISPLAY_MODE_HINT =
  "Chatfenster: Button unten in der Ecke, öffnet ein Chatfenster. In der Seite: Eingabeleiste direkt im Seiteninhalt, an der Stelle des Platzhalters (Reiter „Einbau“).";
export const DISPLAY_MODE_HINT_INLINE = `${DISPLAY_MODE_HINT} Auf dem Handy öffnet der Chat im Vollbild.`;

// Fest vorgegeben, je Darstellung (R2): eine gedämpfte Zeile am Ende des
// Reiters statt des Kastens
export const FIXED_NOTE = {
  bubble:
    "Fest vorgegeben: der KI-Hinweis unter der Eingabe und die Größe des Chatfensters.",
  inline:
    "Fest vorgegeben: der KI-Hinweis unter der Eingabe und die Größe der aufgeklappten Box.",
};

// Farbschema mit Symbolen (R9): Sonne bei Hell, Mond bei Dunkel
const THEME_ICONS = { light: Sun, dark: Moon };
const themeOptions = THEME_OPTIONS.map((opt) => ({
  ...opt,
  Icon: THEME_ICONS[opt.value],
}));

// Beschriftung mit „(Standard)“ am Standard-Button (R4: hängt bei den
// Kurskarten an der gewählten Darstellung)
export function withStandardLabel(options, standard) {
  return options.map((opt) =>
    opt.value === standard ? { ...opt, label: `${opt.label} (Standard)` } : opt
  );
}

// eine Zeile (S3, rc10); welcher Standard gilt, zeigt „(Standard)“ am Button
export const CARDS_HINT = "Standard hängt von der Darstellung ab.";

// „Antworten mit Kursen“ (KIE-567, beide Darstellungen): Kurskarten oder
// Nur Text mit Links; bei Kurskarten die Reihenfolge. Beide bleiben
// untereinander (R11, geprüft: „Kurskarten | Nur Text mit Links (Standard)“
// ist rund 300 px breit und bräche in der halben Spalte von 270 px um).
// Gespeichert wird nur eine Abweichung (setChoice, Regel D6). Ohne
// gespeicherte Wahl gilt der Standard der Darstellung und wechselt mit ihr
// (R4).
export function CourseAnswersSection({ config, setChoice }) {
  const cards = choiceValue(config, "courseCards");
  const position = choiceValue(config, "courseCardsPosition");
  return (
    <>
      <GroupHeading title="Antworten mit Kursen" />
      <div data-section="course-answers" className="space-y-5">
        <SettingsSection title="Kurse anzeigen als" hint={CARDS_HINT}>
          <Segmented
            options={withStandardLabel(
              COURSE_CARDS_OPTIONS,
              choiceDefault(config, "courseCards")
            )}
            value={cards}
            onChange={(v) => setChoice("courseCards", v)}
          />
        </SettingsSection>
        {cards === "auto" && (
          <SettingsSection title="Reihenfolge">
            <Segmented
              options={withStandardLabel(
                COURSE_CARDS_POSITION_OPTIONS,
                choiceDefault(config, "courseCardsPosition")
              )}
              value={position}
              onChange={(v) => setChoice("courseCardsPosition", v)}
            />
          </SettingsSection>
        )}
      </div>
    </>
  );
}

export default function AppearanceTab({
  config,
  updateField,
  errors = {},
  setChoice = () => {},
  setUserTextColor = (value) => updateField("userTextColor", value),
  // Darstellung, Farbschema, Chat-Icon, Position: ein Klick auf die schon
  // markierte Option schreibt nichts (F11, Fixliste 7.22-rc13; index.jsx
  // mit widgetKeys.js withLook)
  setLook = (key, value) => updateField(key, value),
  logoPreview,
  onLogoUpload,
  onLogoRemove,
}) {
  const mode = displayMode(config);
  // ohne gespeicherte Farbe der Standard des Widgets (wie live)
  const accentColor = lookValue(config, "accentColor");
  // ohne gespeicherten Wert die Empfehlung (Regel D6: nur angezeigt)
  const userTextColor = lookValue(config, "userTextColor");
  const textChoice = userTextColorChoice(config);
  const textAdvice = userTextColorAdvice(config);
  const position = lookValue(config, "position");
  const chatIcon = lookValue(config, "chatIcon");
  const theme = themeChoice(config);

  const logoField = (
    <SettingsSection title="Logo">
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
  );

  const themeField = (
    <SettingsSection
      title="Farbschema"
      note={
        theme === null
          ? "Bisher: automatisch nach Gerät. Bleibt so, bis Sie Hell oder Dunkel wählen."
          : null
      }
    >
      <Segmented
        options={themeOptions}
        value={theme}
        onChange={(v) => setLook("theme", v)}
      />
    </SettingsSection>
  );

  return (
    <>
      <SettingsSection
        title="Darstellung"
        hint={mode === "inline" ? DISPLAY_MODE_HINT_INLINE : DISPLAY_MODE_HINT}
      >
        <Segmented
          options={DISPLAY_MODE_OPTIONS}
          value={mode}
          onChange={(v) => setLook("displayMode", v)}
        />
      </SettingsSection>

      <div>
        <FieldPair>
          <SettingsSection
            title="Akzentfarbe"
            hint="Buttons, Nutzer-Nachrichten und Links in Akzentfarbe."
            error={errors.accentColor}
          >
            {/* breit genug für rgb()/rgba()-Eingaben (Restpunkt 5, rc7: w-44
              schnitt lange Eingaben ab) */}
            <div
              className={`relative flex items-center bg-theme-settings-input-bg rounded-lg border transition-colors w-full max-w-xs cursor-pointer ${
                errors.accentColor
                  ? "border-red-400/70"
                  : "border-white/10 hover:border-white/25"
              }`}
            >
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
                  aria-label="Akzentfarbe wählen"
                />
              </div>
              <input
                type="text"
                value={accentFieldValue(config)}
                onChange={(e) => updateField("accentColor", e.target.value)}
                className="bg-transparent text-white text-sm px-2.5 py-2.5 w-full font-mono outline-none"
                aria-label="Akzentfarbe als Farbcode"
              />
            </div>
          </SettingsSection>

          <SettingsSection title="Schrift auf der Akzentfarbe">
            <div className="flex rounded-lg overflow-hidden border border-white/10 w-fit">
              {USER_TEXT_COLOR_OPTIONS.map((opt) => {
                const active = textChoice === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setUserTextColor(opt.value)}
                    aria-pressed={active}
                    className={`flex items-center gap-2 px-5 py-2 text-sm font-medium transition-all ${
                      active
                        ? SELECTED_CLASS
                        : "bg-theme-settings-input-bg text-theme-text-secondary hover:text-white hover:bg-theme-action-menu-item-hover"
                    }`}
                  >
                    <span
                      className="w-3.5 h-3.5 rounded-full border border-white/20"
                      style={{ backgroundColor: opt.value }}
                    />
                    {opt.label}
                  </button>
                );
              })}
            </div>
            <UserTextColorAdvice advice={textAdvice} />
          </SettingsSection>
        </FieldPair>
        <UserTextColorWarning advice={textAdvice} />
      </div>

      {mode === "bubble" ? (
        <>
          <FieldPair>
            {logoField}
            <SettingsSection
              title="Chat-Icon"
              hint="Das Icon auf dem Chat-Button."
            >
              {/* sechs Icons in einer Reihe wie im Mockup (Ansicht 1, R11):
                  runde Buttons ohne Beschriftung darunter, der Name als
                  Tooltip (title) und für Screenreader (aria-label). Mit
                  Beschriftung brauchten die sechs Icons in der halben Spalte
                  zwei Reihen (rund 75 px mehr). Die Reihe ist 6 × 40 px +
                  5 × 4 px = 260 px breit; in einer schmaleren Spalte
                  (Fenster unter etwa 1.130 px) bricht sie um. */}
              <div className="flex gap-1 flex-wrap" data-chat-icons="">
                {CHAT_ICONS.map(({ id, label, Icon }) => {
                  const isSelected = chatIcon === id;
                  return (
                    <button
                      key={id}
                      type="button"
                      onClick={() => setLook("chatIcon", id)}
                      // gewähltes Icon deutlich: Rahmen in der Akzentfarbe des
                      // Design Centers und getönte Fläche (KIE-565 Nachtrag)
                      className={`flex items-center justify-center w-10 h-10 rounded-lg border-2 transition-all ${
                        isSelected
                          ? "border-primary-button bg-primary-button/15"
                          : "border-transparent hover:border-white/20"
                      }`}
                      title={label}
                      aria-label={label}
                      aria-pressed={isSelected}
                    >
                      <span
                        className="w-8 h-8 rounded-full flex items-center justify-center shadow-md transition-transform hover:scale-110"
                        style={{ backgroundColor: accentColor }}
                      >
                        <Icon size={18} weight="fill" color={userTextColor} />
                      </span>
                    </button>
                  );
                })}
              </div>
            </SettingsSection>
          </FieldPair>

          <FieldPair>
            {themeField}
            <SettingsSection title="Position des Chat-Buttons">
              <Segmented
                options={POSITION_OPTIONS}
                value={position}
                onChange={(v) => setLook("position", v)}
              />
            </SettingsSection>
          </FieldPair>
        </>
      ) : (
        <FieldPair>
          {themeField}
          {logoField}
        </FieldPair>
      )}

      <CourseAnswersSection config={config} setChoice={setChoice} />

      <p
        className="text-theme-text-secondary text-xs leading-relaxed pt-4 border-t border-white/10"
        data-testid="fixed-note"
      >
        {FIXED_NOTE[mode]}
      </p>
    </>
  );
}
