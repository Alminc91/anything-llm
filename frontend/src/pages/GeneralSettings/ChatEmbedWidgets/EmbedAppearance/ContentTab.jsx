// Design Center › Inhalt: Kopf (Name, Untertitel), Begrüßungstext,
// Startvorschläge, nur bei Chatblase die Willkommensblasen, Datenschutz-
// Hinweis (Überschrift, Link, Text), Platzhalter und Support-E-Mail.
// Texte mit Kufer-Standard zeigen ihn als Wert; „Standardtext“ setzt ihn
// wieder ein (gespeichert wird nur eine Abweichung). Vorschläge
// (Startvorschläge, Willkommensblasen, Untertitel) stehen nur sichtbar da
// und werden erst mit „übernehmen“ Teil des Bearbeitungsstands (D6).
import { ArrowCounterClockwise, Plus, Trash } from "@phosphor-icons/react";
import { SettingsSection, GroupHeading, inputClass } from "./controls";
import {
  DEFAULT_SUGGESTIONS,
  DEFAULT_WELCOME_BUBBLES,
  GREETING_MAX_LEN,
  PLACEHOLDER_MAX_LEN,
  PRIVACY_TITLE_MAX_LEN,
  SUBTITLE_MAX_LEN,
  URL_MAX_LEN,
  displayMode,
  greetingFieldValue,
  placeholderFieldValue,
  previewInlineBar,
  privacyFieldText,
  privacyTitleFieldValue,
  privacyWithoutMarks,
  sameAsDefault,
  storedInlineBarPlaceholder,
  textValue,
} from "./widgetKeys";

const DEFAULTS_LOAD_ERROR = "Standardtexte konnten nicht geladen werden";
const PRIVACY_RULE =
  "Freier Text. Zeilen mit „•“ oder „-“ am Anfang werden zu Aufzählungspunkten, andere Zeilen bleiben Absätze.";

// Knopf „Standardtext“ neben einem Feld mit Kufer-Standard
function StandardTextButton({ isStandard, defaultsError, onReset }) {
  if (defaultsError)
    return (
      <button
        type="button"
        disabled
        title={DEFAULTS_LOAD_ERROR}
        className="flex items-center gap-1.5 text-xs text-theme-text-secondary opacity-50 cursor-not-allowed"
      >
        <ArrowCounterClockwise size={13} weight="bold" />
        Standardtext
      </button>
    );
  return (
    <button
      type="button"
      onClick={onReset}
      disabled={isStandard}
      className="flex items-center gap-1.5 text-xs text-theme-text-secondary hover:text-white disabled:opacity-50 disabled:hover:text-theme-text-secondary disabled:cursor-default transition-colors"
    >
      <ArrowCounterClockwise size={13} weight="bold" />
      Standardtext
    </button>
  );
}

// Kleiner Knopf neben einem Feld bzw. unter einem Vorschlag
function SuggestionButton({ label, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-1.5 text-xs text-theme-text-secondary hover:text-white transition-colors"
    >
      <Plus size={13} weight="bold" />
      {label}
    </button>
  );
}

// Vorschlag für eine leere Liste: grau sichtbar, gespeichert wird er erst
// nach „übernehmen“ (Entscheidung D6)
function ListSuggestion({ items, onApply, label }) {
  return (
    <div
      className="rounded-lg border border-dashed border-white/20 px-3 py-2.5 space-y-1.5"
      data-suggestion=""
    >
      <p className="text-xs text-theme-text-secondary">
        Noch keine gespeichert. Vorschlag:
      </p>
      <ul className="space-y-0.5">
        {items.map((item) => (
          <li
            key={item}
            className="text-xs text-theme-text-secondary opacity-80"
          >
            {item}
          </li>
        ))}
      </ul>
      <SuggestionButton label={label} onClick={onApply} />
    </div>
  );
}

function FieldTitle({ title, optional = false, action = null }) {
  return (
    <div className="flex items-center justify-between gap-3 mb-0.5">
      <span className="text-white text-sm font-medium">
        {title}
        {optional && (
          <span className="text-theme-text-secondary font-normal">
            {" "}
            (optional)
          </span>
        )}
      </span>
      {action}
    </div>
  );
}

function MessageList({
  items,
  onAdd,
  onUpdate,
  onRemove,
  placeholder,
  addLabel,
}) {
  return (
    <div className="space-y-2">
      {items.map((item, index) => (
        <div key={index} className="flex items-center gap-2 group">
          <input
            type="text"
            value={textValue(item)}
            onChange={(e) => onUpdate(index, e.target.value)}
            placeholder={placeholder}
            className={inputClass(false)}
          />
          <button
            type="button"
            onClick={() => onRemove(index)}
            aria-label="Eintrag entfernen"
            className="text-theme-text-secondary hover:text-red-400 p-1 opacity-60 group-hover:opacity-100 transition-all"
          >
            <Trash size={15} />
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={onAdd}
        className="flex items-center gap-1.5 text-theme-text-secondary hover:text-white text-xs px-1 py-1 transition-colors"
      >
        <Plus size={13} weight="bold" />
        {addLabel}
      </button>
    </div>
  );
}

export default function ContentTab({
  config,
  initialConfig,
  errors,
  defaults,
  defaultsError,
  greetingKey,
  updateField,
  updateOptionalField,
  resetKeys,
  applySuggestion,
  addListItem,
  updateListItem,
  removeListItem,
}) {
  const bubble = displayMode(config) === "bubble";

  const greeting = greetingFieldValue(config, greetingKey, defaults);
  const greetingIsStandard =
    !defaults || sameAsDefault("greeting", greeting, defaults);
  // Begrüßung von früher ohne Längengrenze: unverändert erlaubt, im Chat
  // aber gekürzt (Review F07)
  const greetingTooLongStored =
    greeting.trim().length > GREETING_MAX_LEN &&
    config[greetingKey] === initialConfig[greetingKey];
  // Vorschlag nur, solange die Liste keine Einträge (auch keine leeren
  // Eingabefelder) hat
  const listLength = (key) =>
    Array.isArray(config[key]) ? config[key].length : 0;
  const subtitleSuggestion = textValue(defaults?.assistantSubtitle);
  const inlineBar = previewInlineBar(config, defaults);
  const storedBarText = storedInlineBarPlaceholder(config);

  const privacyTitle = privacyTitleFieldValue(config, defaults);

  // Gespeicherter Text im Altformat (ein Punkt je Zeile ohne Zeichen) wird
  // als „• “-Zeilen gezeigt, gleiche Darstellung wie im Widget
  const privacyText =
    typeof config.privacyText === "string"
      ? config.privacyText === initialConfig.privacyText
        ? privacyFieldText(config.privacyText)
        : config.privacyText
      : textValue(defaults?.privacyText);
  const privacyIsStandard =
    !defaults || sameAsDefault("privacyText", privacyText, defaults);
  // Altformat mit mehreren Zeilen (ohne „•“/„-“): das Widget zeigt Punkte
  const legacyPoints = privacyWithoutMarks(privacyText);

  return (
    <>
      <GroupHeading title="Kopf" first />
      <SettingsSection title="Name" hint="Name des Chatbots im Kopf des Chats.">
        <input
          type="text"
          value={textValue(config.name)}
          onChange={(e) => updateField("name", e.target.value)}
          placeholder={textValue(defaults?.name) || "KI-Berater"}
          className={inputClass(false)}
        />
      </SettingsSection>
      <div>
        <FieldTitle
          title="Untertitel"
          optional
          action={
            subtitleSuggestion &&
            !textValue(config.assistantSubtitle).trim() && (
              <SuggestionButton
                label="Vorschlag übernehmen"
                onClick={() =>
                  applySuggestion("assistantSubtitle", subtitleSuggestion)
                }
              />
            )
          }
        />
        <p className="text-theme-text-secondary text-xs mb-2.5 leading-relaxed">
          Kleine Zeile unter dem Namen. Leer = kein Untertitel, der Vorschlag
          steht grau im Feld.
        </p>
        <input
          type="text"
          value={textValue(config.assistantSubtitle)}
          maxLength={SUBTITLE_MAX_LEN}
          onChange={(e) =>
            updateOptionalField("assistantSubtitle", e.target.value)
          }
          placeholder={
            textValue(defaults?.assistantSubtitle) ||
            "Online-Berater mit künstlicher Intelligenz"
          }
          className={inputClass(errors.assistantSubtitle)}
        />
        {errors.assistantSubtitle && (
          <p className="text-red-400 text-xs mt-1.5">
            {errors.assistantSubtitle}
          </p>
        )}
      </div>

      <GroupHeading title="Begrüßung" />
      <div>
        <FieldTitle
          title="Begrüßungstext"
          action={
            <StandardTextButton
              isStandard={greetingIsStandard}
              defaultsError={defaultsError}
              onReset={() => resetKeys(["greetingBubbleText", "greeting"])}
            />
          }
        />
        <textarea
          rows={3}
          value={greeting}
          onChange={(e) => updateField(greetingKey, e.target.value)}
          placeholder={textValue(defaults?.greeting)}
          className={`${inputClass(errors[greetingKey])} resize-y`}
          aria-label="Begrüßungstext"
        />
        {errors[greetingKey] ? (
          <p className="text-red-400 text-xs mt-1.5">{errors[greetingKey]}</p>
        ) : (
          <p className="text-theme-text-secondary text-xs mt-1.5 leading-relaxed">
            {greeting.trim() === ""
              ? "Leer: es gilt der Standardtext."
              : greetingTooLongStored
                ? `Der gespeicherte Text ist länger als ${GREETING_MAX_LEN} Zeichen. Im Chat erscheint er gekürzt (wie in der Vorschau).`
                : `Erste Blase im Chat, max. ${GREETING_MAX_LEN} Zeichen. Der Datenschutz-Hinweis folgt als eigene, zweite Blase.`}
          </p>
        )}
      </div>

      {bubble && (
        <SettingsSection
          title="Willkommensblasen"
          hint="Kleine Sprechblasen neben dem geschlossenen Chat-Knopf. Solange keine eigenen gespeichert sind, erscheinen die Standardblasen aus dem Vorschlag."
        >
          <div className="space-y-2">
            {listLength("chatbotBubblesMessages") === 0 && (
              <ListSuggestion
                items={DEFAULT_WELCOME_BUBBLES}
                label="Vorschläge übernehmen"
                onApply={() =>
                  applySuggestion(
                    "chatbotBubblesMessages",
                    DEFAULT_WELCOME_BUBBLES
                  )
                }
              />
            )}
            <MessageList
              items={
                Array.isArray(config.chatbotBubblesMessages)
                  ? config.chatbotBubblesMessages
                  : []
              }
              onAdd={() => addListItem("chatbotBubblesMessages")}
              onUpdate={(i, v) =>
                updateListItem("chatbotBubblesMessages", i, v)
              }
              onRemove={(i) => removeListItem("chatbotBubblesMessages", i)}
              placeholder="z. B. Hallo! Kann ich Ihnen helfen?"
              addLabel="Blase hinzufügen"
            />
          </div>
        </SettingsSection>
      )}

      <SettingsSection
        title="Startvorschläge"
        hint="Knöpfe mit Fragen, die Besucher mit einem Klick stellen können."
      >
        <div className="space-y-2">
          {listLength("defaultMessages") === 0 && (
            <ListSuggestion
              items={DEFAULT_SUGGESTIONS}
              label="Vorschläge übernehmen"
              onApply={() =>
                applySuggestion("defaultMessages", DEFAULT_SUGGESTIONS)
              }
            />
          )}
          <MessageList
            items={
              Array.isArray(config.defaultMessages)
                ? config.defaultMessages
                : []
            }
            onAdd={() => addListItem("defaultMessages")}
            onUpdate={(i, v) => updateListItem("defaultMessages", i, v)}
            onRemove={(i) => removeListItem("defaultMessages", i)}
            placeholder="z. B. Wie melde ich mich an?"
            addLabel="Vorschlag hinzufügen"
          />
        </div>
      </SettingsSection>

      <GroupHeading
        title="Datenschutz-Hinweis"
        hint="Immer sichtbar, Text frei anpassbar."
      />
      <div>
        <FieldTitle title="Überschrift" optional />
        <p className="text-theme-text-secondary text-xs mb-2.5 leading-relaxed">
          Leer = keine Überschrift.
        </p>
        <input
          type="text"
          value={privacyTitle}
          maxLength={PRIVACY_TITLE_MAX_LEN}
          onChange={(e) => updateField("privacyTitle", e.target.value)}
          className={inputClass(errors.privacyTitle)}
          aria-label="Überschrift des Datenschutz-Hinweises"
        />
        {errors.privacyTitle && (
          <p className="text-red-400 text-xs mt-1.5">{errors.privacyTitle}</p>
        )}
      </div>
      <SettingsSection
        title="Link zur Datenschutzerklärung"
        hint="https://… oder ein Pfad Ihrer Seite wie /datenschutz. Leer = kein Link."
        error={errors.privacyUrl}
      >
        <input
          type="text"
          value={textValue(config.privacyUrl)}
          maxLength={URL_MAX_LEN}
          onChange={(e) => updateOptionalField("privacyUrl", e.target.value)}
          placeholder="https://www.ihre-seite.de/datenschutz"
          className={inputClass(errors.privacyUrl)}
        />
      </SettingsSection>
      <div>
        <FieldTitle
          title="Text"
          action={
            <StandardTextButton
              isStandard={privacyIsStandard}
              defaultsError={defaultsError}
              onReset={() => resetKeys(["privacyText"])}
            />
          }
        />
        <textarea
          rows={6}
          value={privacyText}
          onChange={(e) => updateField("privacyText", e.target.value)}
          placeholder={textValue(defaults?.privacyText)}
          className={`${inputClass(errors.privacyText)} resize-y`}
          aria-label="Text des Datenschutz-Hinweises"
        />
        {errors.privacyText ? (
          <p className="text-red-400 text-xs mt-1.5">{errors.privacyText}</p>
        ) : (
          <p className="text-theme-text-secondary text-xs mt-1.5 leading-relaxed">
            {privacyText.trim() === ""
              ? "Leer: es gilt der Standardtext."
              : legacyPoints
                ? `${PRIVACY_RULE} Ohne eine Zeile mit „•“ oder „-“ werden mehrere Zeilen als Punkte gezeigt (wie bisher) und so gespeichert.`
                : PRIVACY_RULE}
          </p>
        )}
      </div>

      <GroupHeading title="Eingabe" />
      <SettingsSection
        title="Platzhalter im Eingabefeld"
        hint={
          bubble
            ? "Grauer Text im Eingabefeld des Chats. Leer = Standard."
            : storedBarText
              ? `Grauer Text im Eingabefeld des Chats. Leer = Standard. Die eingeklappte Leiste zeigt Ihren früher gespeicherten Text „${storedBarText}“.`
              : `Grauer Text im Eingabefeld des Chats. Leer = Standard. Die eingeklappte Leiste zeigt fest „${inlineBar.placeholder}“.`
        }
        error={errors.sendMessageText}
      >
        <input
          type="text"
          value={placeholderFieldValue(config)}
          maxLength={PLACEHOLDER_MAX_LEN}
          onChange={(e) => updateField("sendMessageText", e.target.value)}
          placeholder={
            textValue(defaults?.sendMessageText) || "Ihre Frage eingeben"
          }
          className={inputClass(errors.sendMessageText)}
        />
      </SettingsSection>
      <div>
        <FieldTitle title="Support-E-Mail" optional />
        <p className="text-theme-text-secondary text-xs mb-2.5 leading-relaxed">
          E-Mail-Adresse für den Support-Link im Chat.
        </p>
        <input
          type="email"
          value={textValue(config.supportEmail)}
          onChange={(e) => updateField("supportEmail", e.target.value)}
          placeholder="support@ihre-seite.de"
          className={inputClass(false)}
        />
      </div>
    </>
  );
}
