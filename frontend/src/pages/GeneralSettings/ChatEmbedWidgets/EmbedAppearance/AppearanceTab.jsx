// Design Center › Aussehen: Darstellung, Farbschema, Kundenfarbe, Schrift auf
// der Kundenfarbe, Logo; nur bei Chatblase Position und Chat-Icon; für
// beide Darstellungen „Antworten mit Kursen“ (KIE-567). Darunter der Kasten
// „Fest eingebaut“ mit den festen Standards.
import { Check, LockSimple, Warning, X } from "@phosphor-icons/react";
import {
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
  DEFAULT_ACCENT_COLOR,
  choiceValue,
  displayMode,
  lookValue,
  themeChoice,
  textValue,
  userTextColorAdvice,
  userTextColorChoice,
} from "./widgetKeys";

// Unter „Schrift auf der Kundenfarbe“: Empfehlung nach Kontrast, Hinweis
// ohne gespeicherten Wert, Warnung unter 4,5:1
function UserTextColorAdvice({ advice }) {
  if (!advice.recommendedLabel) return null;
  return (
    <div className="mt-1.5 space-y-1" data-testid="user-text-advice">
      <p className="text-theme-text-secondary text-xs leading-relaxed">
        {advice.stored
          ? `Empfohlen: ${advice.recommendedLabel}`
          : `Empfohlen: ${advice.recommendedLabel}. Solange Sie nichts wählen, gilt automatisch die Empfehlung.`}
      </p>
      {advice.warning && (
        // Bernstein im Dunkelmodus, dunkler Bernstein auf hellem Grund
        // (Browser 7.22-rc6 B-02: text-amber-400 auf Weiß kaum lesbar)
        <p
          className="flex items-start gap-1.5 text-amber-400 light:text-amber-700 text-xs leading-relaxed"
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
      )}
    </div>
  );
}

// Feste Standards je Darstellung (wie server/utils/chats/embedStandards.js).
// Kurskarten an/aus und ihre Reihenfolge sind wählbar („Antworten mit
// Kursen“, KIE-567) und stehen deshalb nicht in diesem Kasten; fest sind
// nur Zeilenlayout und kurze Antwort, genannt nur, solange Kurskarten
// gewählt sind (Browser 7.22-rc6 B-03). Der Datenschutz-Hinweis ist nicht
// fest (Schalter im Reiter Inhalt, KIE-565 Nachtrag).
const NOTE_CHOICES =
  "Kurskarten und ihre Reihenfolge wählen Sie oben unter „Antworten mit Kursen“. Den Datenschutz-Hinweis schalten Sie im Reiter „Inhalt“ ein oder aus.";
export const COURSE_CARDS_ITEM = "Kurskarten als Zeilen mit kurzer Antwort";
export const FIXED_STANDARDS = {
  bubble: {
    title: "Fest eingebaut, für alle Chatbots gleich",
    items: [
      "Begrüßung als Blase",
      "Startvorschläge als Buttons",
      "Folgefragen als Buttons",
      COURSE_CARDS_ITEM,
      "KI-Hinweis unter der Eingabe",
      "Fenstergröße und Randabstand",
      "Kein Online-Punkt",
    ],
    note: NOTE_CHOICES,
  },
  inline: {
    title: "Fest eingebaut wie in unserer Demo",
    items: [
      "Öffnet beim Klick ins Feld",
      "Effekt „Verwandeln“",
      "Startet als schmale Eingabeleiste",
      "Breite und Höhe der Box",
      COURSE_CARDS_ITEM,
      "Folgefragen als Buttons",
      "KI-Hinweis unter der Eingabe",
    ],
    // Review 7.22-rc6 F10: Position und Chat-Icon gelten weiter für die
    // Chatblase, die ohne Platzhalter erscheint; der Effekt ist fest
    note: `Position und Chat-Icon gelten nur für die Chatblase. Sie erscheint, wenn der Platzhalter auf einer Seite fehlt. ${NOTE_CHOICES}`,
  },
};

// „Antworten mit Kursen“ (KIE-567, beide Darstellungen): Kurskarten oder
// Nur Text mit Links; bei Kurskarten die Reihenfolge. Gespeichert wird nur
// eine Abweichung (setChoice, Regel D6).
export function CourseAnswersSection({ config, setChoice }) {
  const cards = choiceValue(config, "courseCards");
  const position = choiceValue(config, "courseCardsPosition");
  return (
    <>
      <GroupHeading title="Antworten mit Kursen" />
      <div data-section="course-answers" className="space-y-5">
        <SettingsSection
          title="Kurse anzeigen als"
          hint="Kurskarten zeigen Termin, Ort und freie Plätze auf einen Blick. „Nur Text“ ist die klassische Antwort mit Kurs-Links im Text."
        >
          <Segmented
            options={COURSE_CARDS_OPTIONS}
            value={cards}
            onChange={(v) => setChoice("courseCards", v)}
          />
        </SettingsSection>
        {cards === "auto" && (
          <SettingsSection
            title="Reihenfolge"
            hint="Empfohlen: Karten zuerst. Sie erscheinen sofort, während der Text noch geschrieben wird; die Folgefragen stehen dann direkt unter dem Text am Ende."
          >
            <Segmented
              options={COURSE_CARDS_POSITION_OPTIONS}
              value={position}
              onChange={(v) => setChoice("courseCardsPosition", v)}
            />
          </SettingsSection>
        )}
      </div>
    </>
  );
}

export function FixedStandardsBox({ mode, cards = "auto" }) {
  const { title, items: all, note } = FIXED_STANDARDS[mode];
  const items =
    cards === "auto" ? all : all.filter((item) => item !== COURSE_CARDS_ITEM);
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
  errors = {},
  setChoice = () => {},
  setUserTextColor = (value) => updateField("userTextColor", value),
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
  return (
    <>
      <SettingsSection
        title="Darstellung"
        hint={
          mode === "inline"
            ? "Die Eingabeleiste steht dort, wo Sie den Platzhalter einbauen (Reiter „Einbau“). Auf dem Handy öffnet der Chat im Vollbild."
            : "Chatblase: Button unten in der Ecke, öffnet ein Chatfenster. Inline: Eingabeleiste direkt im Seiteninhalt."
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
        hint="Buttons, Nutzer-Nachrichten, Links."
        error={errors.accentColor}
      >
        <div
          className={`relative flex items-center bg-theme-settings-input-bg rounded-lg border transition-colors w-44 cursor-pointer ${
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
        title="Schrift auf der Kundenfarbe"
        hint="Für Nutzer-Nachrichten, den Senden-Button und Buttons in Kundenfarbe."
      >
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
            hint="Das Icon auf dem Chat-Button."
          >
            <div className="flex gap-2.5 flex-wrap">
              {CHAT_ICONS.map(({ id, label, Icon }) => {
                const isSelected = chatIcon === id;
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => updateField("chatIcon", id)}
                    // gewähltes Icon deutlich: Rahmen in der Akzentfarbe des
                    // Design Centers und getönte Fläche (KIE-565 Nachtrag)
                    className={`flex flex-col items-center gap-1.5 px-2 py-1.5 rounded-lg border-2 transition-all ${
                      isSelected
                        ? "border-primary-button bg-primary-button/15"
                        : "border-transparent hover:border-white/20"
                    }`}
                    title={label}
                    aria-pressed={isSelected}
                  >
                    <div
                      className="relative w-11 h-11 rounded-full flex items-center justify-center shadow-md transition-all hover:scale-110"
                      style={{ backgroundColor: accentColor }}
                    >
                      <Icon size={22} weight="fill" color={userTextColor} />
                    </div>
                    <span
                      className={`text-[10px] transition-colors ${
                        isSelected
                          ? "text-white font-semibold"
                          : "text-theme-text-secondary"
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

      <CourseAnswersSection config={config} setChoice={setChoice} />

      <FixedStandardsBox
        mode={mode}
        cards={choiceValue(config, "courseCards")}
      />
    </>
  );
}
