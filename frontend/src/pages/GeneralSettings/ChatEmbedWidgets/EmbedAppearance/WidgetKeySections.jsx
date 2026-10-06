// Design Center: Abschnitte für die Widget-Schlüssel (Leiste, Panel,
// Antwort & Karten, Datenschutz & Hinweise). Enums werden erst nach aktiver
// Wahl gespeichert (vorher zeigt die Auswahl den Widget-Standard); Felder
// mit Kufer-Standardtext zeigen ihn als Wert, „Auf Standardtext
// zurücksetzen“ setzt ihn wieder ein (gespeichert wird nur eine Abweichung).
import { ArrowCounterClockwise } from "@phosphor-icons/react";
import {
  SettingsSection,
  Segmented,
  inputClass,
  GroupHeading,
  CheckboxRow,
} from "./controls";
import {
  WIDGET_ENUMS,
  WIDGET_TEXT_MAX,
  PRIVACY_POINTS_MAX,
  PRIVACY_POINT_MAX_LEN,
  PRIVACY_TEXT_MAX_LEN,
  URL_MAX_LEN,
  enumValue,
  displayedText,
} from "./widgetKeys";

// Auswahl eines Enum-Schlüssels: gespeicherter Wert oder Widget-Standard
function EnumField({ field, config, errors, onChange, title, hint }) {
  const { options, fallback } = WIDGET_ENUMS[field];
  const value = field in config ? enumValue(config[field]) : fallback;
  return (
    <SettingsSection title={title} hint={hint} error={errors[field]}>
      <Segmented
        options={options}
        value={value}
        onChange={(v) => onChange(field, v)}
        compact={options.length > 3}
      />
    </SettingsSection>
  );
}

// Optionaler Text ohne Standardtext (leer = Feld weglassen)
function OptionalTextField({
  field,
  config,
  errors,
  onChange,
  title,
  hint,
  placeholder,
  maxLength = WIDGET_TEXT_MAX[field],
}) {
  return (
    <SettingsSection title={title} hint={hint} error={errors[field]}>
      <input
        type="text"
        value={config[field] ?? ""}
        maxLength={maxLength}
        onChange={(e) => onChange(field, e.target.value)}
        placeholder={placeholder}
        className={inputClass(errors[field])}
      />
    </SettingsSection>
  );
}

// Text mit Kufer-Standard: Standard als Wert, Knopf zum Zurücksetzen.
// Kein maxLength am Feld, damit zu lange (z. B. per API gesetzte) Werte
// sichtbar bleiben und als Fehler gemeldet werden.
function DefaultTextField({
  field,
  config,
  errors,
  defaults,
  onText,
  onReset,
  title,
  hint,
  multiline = false,
  rows = 3,
}) {
  const value = displayedText(config, field, defaults);
  const standard = defaults?.[field];
  const isStandard = !(field in config) || value === standard;
  const Input = multiline ? "textarea" : "input";
  return (
    <SettingsSection
      title={title}
      hint={hint}
      error={errors[field]}
      note={
        value === ""
          ? "Leer — das Widget zeigt den Kufer-Standardtext."
          : isStandard && standard
            ? "Kufer-Standardtext — Sie können ihn ändern."
            : null
      }
    >
      <Input
        {...(multiline ? { rows } : { type: "text" })}
        value={value}
        onChange={(e) => onText(field, e.target.value)}
        placeholder={standard || ""}
        className={`${inputClass(errors[field])} ${
          multiline ? "resize-y" : ""
        }`}
      />
      {!isStandard && standard && (
        <button
          type="button"
          onClick={() => onReset(field)}
          className="mt-1.5 flex items-center gap-1.5 text-xs text-theme-text-secondary hover:text-white transition-colors"
        >
          <ArrowCounterClockwise size={13} weight="bold" />
          Auf Standardtext zurücksetzen
        </button>
      )}
    </SettingsSection>
  );
}

// Aussehen › Leiste (nur Inline-Modus)
export function LeisteSection({
  config,
  errors,
  updateField,
  updateOptionalField,
}) {
  const inputBar = config.inlineInput === true;
  return (
    <>
      <GroupHeading
        title="Leiste"
        hint="Eingeklappte Leiste im Inline-Modus und wie sie sich öffnet."
      />
      <CheckboxRow
        checked={inputBar}
        onChange={(v) => updateField("inlineInput", v)}
        label="Leiste als Eingabefeld (Frage direkt in der Leiste tippen)"
      />
      {inputBar && (
        <>
          <EnumField
            field="inlineOpenOn"
            title="Chat öffnen"
            hint="Standard: beim Absenden der ersten Frage. Alternativ schon beim Klick ins Eingabefeld."
            config={config}
            errors={errors}
            onChange={updateField}
          />
          <div className="grid grid-cols-2 gap-4">
            <OptionalTextField
              field="inlineInputPlaceholder"
              title="Platzhalter"
              hint={`Max. ${WIDGET_TEXT_MAX.inlineInputPlaceholder} Zeichen — leer = Standard.`}
              placeholder="Stellen Sie hier Ihre Frage …"
              config={config}
              errors={errors}
              onChange={updateOptionalField}
            />
            <OptionalTextField
              field="inlineSendText"
              title="Knopftext"
              hint={`Max. ${WIDGET_TEXT_MAX.inlineSendText} Zeichen — leer = Standard.`}
              placeholder="Chatten"
              config={config}
              errors={errors}
              onChange={updateOptionalField}
            />
          </div>
        </>
      )}
      <EnumField
        field="inlineLayout"
        title="Aufgeklappte Box"
        hint="Im Seitenfluss (schiebt den Inhalt darunter nach unten, Standard) oder schwebend über dem nachfolgenden Inhalt."
        config={config}
        errors={errors}
        onChange={updateField}
      />
      <EnumField
        field="inlineEffect"
        title="Effekt beim Aufklappen"
        hint="Standard: im Seitenfluss ohne Animation, schwebend „Aufklappen“. „Verwandeln“ lässt die Leiste zum Chat wachsen."
        config={config}
        errors={errors}
        onChange={(field, v) =>
          v === "" ? updateOptionalField(field, null) : updateField(field, v)
        }
      />
    </>
  );
}

// Inhalt › Panel
export function PanelSection({
  config,
  errors,
  defaults,
  updateField,
  updateOptionalField,
  setDefaultText,
  resetDefaultText,
}) {
  return (
    <>
      <GroupHeading
        title="Panel"
        hint="Darstellung des geöffneten Chats vor der ersten Frage."
      />
      <EnumField
        field="suggestionStyle"
        title="Startvorschläge als"
        hint="Breite Balken (Standard) oder kleine Pillen."
        config={config}
        errors={errors}
        onChange={updateField}
      />
      <EnumField
        field="greetingStyle"
        title="Begrüßung als"
        hint="Zentrierter Text (Standard) oder als Sprechblase des Assistenten. Datenschutz „In der Begrüßung“ zeigt immer die Blase."
        config={config}
        errors={errors}
        onChange={updateField}
      />
      <DefaultTextField
        field="greetingBubbleText"
        title="Text der Begrüßungsblase"
        hint={`Gilt bei „Begrüßung als Blase“. Max. ${WIDGET_TEXT_MAX.greetingBubbleText} Zeichen.`}
        multiline
        rows={4}
        config={config}
        errors={errors}
        defaults={defaults}
        onText={setDefaultText}
        onReset={resetDefaultText}
      />
      <OptionalTextField
        field="assistantSubtitle"
        title="Untertitel im Kopf"
        hint={`Kleine Zeile unter dem Namen, z. B. „KI-Assistent“. Max. ${WIDGET_TEXT_MAX.assistantSubtitle} Zeichen — leer = keiner.`}
        placeholder="z. B. KI-Assistent"
        config={config}
        errors={errors}
        onChange={updateOptionalField}
      />
      <CheckboxRow
        checked={config.onlineDot === true}
        onChange={(v) => updateField("onlineDot", v)}
        label="Grünen Online-Punkt am Logo zeigen"
      />
    </>
  );
}

// Antworten › Antwort & Karten
export function AnswerCardsSection({ config, errors, updateField }) {
  const cardsOn = enumValue(config.courseCards) === "auto";
  return (
    <>
      <GroupHeading
        title="Antwort & Karten"
        hint="Kurskarten und Vorschläge für die nächste Frage unter den Antworten."
      />
      <EnumField
        field="courseCards"
        title="Kurskarten"
        hint="Empfohlene Kurse erscheinen als Karten mit Termin, Ort, Preis und Link. Der Server ergänzt dafür automatisch die nötigen Prompt-Regeln (nur auf Deutsch; in anderen Sprachen antwortet der Chatbot klassisch)."
        config={config}
        errors={errors}
        onChange={updateField}
      />
      {cardsOn && (
        <>
          <EnumField
            field="courseCardsPosition"
            title="Position der Karten"
            hint="Unter dem Antworttext (Standard) oder zuerst die Karten."
            config={config}
            errors={errors}
            onChange={updateField}
          />
          <EnumField
            field="courseCardsAnswerStyle"
            title="Antwortstil bei Karten"
            hint="Kurz (Standard): ein, zwei Sätze, die Karten sind der Link. Ausführlich: Text mit nummerierter Liste und Kurs-Links."
            config={config}
            errors={errors}
            onChange={updateField}
          />
        </>
      )}
      <EnumField
        field="followUps"
        title="Folgefragen"
        hint="Zwei Vorschläge für die nächste Frage als Knöpfe unter der letzten Antwort."
        config={config}
        errors={errors}
        onChange={updateField}
      />
    </>
  );
}

// Antworten › Datenschutz & Hinweise
export function PrivacySection({
  config,
  errors,
  defaults,
  updateField,
  updateOptionalField,
  setDefaultText,
  resetDefaultText,
}) {
  const notice = enumValue(config.privacyNotice) || "none";
  const disclaimerFooter = enumValue(config.disclaimer) === "footer";
  const textProps = {
    config,
    errors,
    defaults,
    onText: setDefaultText,
    onReset: resetDefaultText,
  };
  return (
    <>
      <GroupHeading
        title="Datenschutz & Hinweise"
        hint="Verlinken Sie Ihre eigene Datenschutzerklärung und nennen Sie bei Bedarf Ihre Speicherdauer."
      />
      <EnumField
        field="privacyNotice"
        title="Datenschutz-Hinweis"
        hint="Keiner (Standard), als Absätze in der Begrüßungsblase oder einmalig als Karte beim ersten Öffnen (mit Bestätigungsknopf)."
        config={config}
        errors={errors}
        onChange={updateField}
      />
      {notice !== "none" && (
        <>
          <DefaultTextField
            field="privacyTitle"
            title="Überschrift"
            hint={`Max. ${WIDGET_TEXT_MAX.privacyTitle} Zeichen.`}
            {...textProps}
          />
          <DefaultTextField
            field="privacyText"
            title="Hinweise"
            hint={`Ein Punkt je Zeile — höchstens ${PRIVACY_POINTS_MAX} Punkte mit je ${PRIVACY_POINT_MAX_LEN} Zeichen (insgesamt ${PRIVACY_TEXT_MAX_LEN}).`}
            multiline
            rows={5}
            {...textProps}
          />
          <OptionalTextField
            field="privacyUrl"
            title="Link zur Datenschutzerklärung"
            hint="https://… oder ein Pfad Ihrer Seite wie /datenschutz — leer = kein Link."
            placeholder="https://www.ihre-seite.de/datenschutz"
            maxLength={URL_MAX_LEN}
            config={config}
            errors={errors}
            onChange={updateOptionalField}
          />
          {notice === "modal" && (
            <DefaultTextField
              field="privacyButtonText"
              title="Knopftext"
              hint={`Bestätigung der Karte. Max. ${WIDGET_TEXT_MAX.privacyButtonText} Zeichen.`}
              {...textProps}
            />
          )}
        </>
      )}
      <EnumField
        field="disclaimer"
        title="KI-Hinweis"
        hint="Vom Modell am Ende jeder Antwort (Standard) oder fest unter dem Eingabefeld — dann schreibt das Modell ihn nicht mehr."
        config={config}
        errors={errors}
        onChange={updateField}
      />
      {disclaimerFooter && (
        <DefaultTextField
          field="disclaimerText"
          title="Text des KI-Hinweises"
          hint={`Max. ${WIDGET_TEXT_MAX.disclaimerText} Zeichen.`}
          {...textProps}
        />
      )}
    </>
  );
}
