// Design Center › Inhalt, in der Reihenfolge des Chats (R6, Fixliste
// 7.22-rc8): Name und Untertitel, Begrüßung, Datenschutz-Hinweis
// (Schalter „Zusätzlich beim Start als Blase zeigen“ seit AK-12, dann
// Überschrift, Text, Link des Datenschutz-Fensters), Startvorschläge,
// Platzhalter im Eingabefeld, nur
// beim Chatfenster die Gruppe „Geschlossener Chat“ (Willkommensblasen und
// wann sie erscheinen, KIE-568), Support-E-Mail.
// Kompakter seit R11 (Fixliste 7.22-rc9, Mockup Ansicht 3): die Überschrift
// des Datenschutz-Hinweises schmal allein; Begrüßung und Datenschutz-Text
// wachsen mit dem Inhalt; Hinweise unter dem Feld. Name und Untertitel
// standen seit R11 paarweise nebeneinander; nach der Rückmeldung des Nutzers
// vom 20.10.2026 stehen sie untereinander, jedes über die volle Breite der
// Spalte (wie die Begrüßung), die Gruppenüberschrift „Name und Untertitel“
// und die Hinweise unter den Feldern bleiben. Willkommensblasen anzeigen
// bleibt je Gerät eine Zeile (siehe dort).
// Jedes Feld zeigt den wirksamen Wert; ohne gespeicherten Wert ist das der
// Standard als echter, bearbeitbarer Feldwert (R5, Vorbelegung). Gespeichert
// wird nur, was der Kunde ändert (Regel D6, widgetKeys.js cleanConfig);
// „Standardtext“ setzt ein Feld auf den Standard zurück.
import { ArrowCounterClockwise, Plus, Trash } from "@phosphor-icons/react";
import {
  FieldPair,
  GroupHeading,
  GrowingTextarea,
  Segmented,
  SettingsSection,
  Switch,
  inputClass,
} from "./controls";
import {
  GREETING_MAX_LEN,
  PLACEHOLDER_MAX_LEN,
  PRIVACY_TITLE_MAX_LEN,
  SUBTITLE_MAX_LEN,
  URL_MAX_LEN,
  WELCOME_BUBBLES_DEVICES,
  WELCOME_BUBBLES_OPTIONS,
  choiceValue,
  displayMode,
  greetingFieldValue,
  listItems,
  nameFieldValue,
  placeholderFieldValue,
  previewInlineBar,
  previewPlaceholder,
  privacyFieldText,
  privacyStartBubbleOn,
  privacyTitleFieldValue,
  privacyTitleStandard,
  privacyWithoutMarks,
  sameAsDefault,
  storedInlineBarPlaceholder,
  subtitleFieldValue,
  textItems,
  textValue,
} from "./widgetKeys";

const DEFAULTS_LOAD_ERROR = "Standardtexte konnten nicht geladen werden";
const PRIVACY_RULE =
  "Freier Text. Zeilen mit „•“ oder „-“ am Anfang werden zu Aufzählungspunkten, andere Zeilen bleiben Absätze.";

// Datenschutz-Hinweis (Datenschutz-Fußzeile, Nutzer 23.10.2026, 7.23): kein
// „Aus“, der Link „Datenschutz“ steht immer unter der Eingabe und öffnet das
// Datenschutz-Fenster; seit AK-12 (24.10.2026) optional zusätzlich die Blase
// beim Start (Schalter unten). Gruppenhinweis, die Zeile zum festen Teil
// und der Hinweis zum Link wie im freigegebenen Mockup
// (issues/datenschutz-fusszeile/mockup/DesignCenter.dc.html); seit F10
// (Fixliste rc2, Nachtrag 24.10.2026) mit dem Satz, was ein Klick zeigt,
// und in der ganzen Gruppe ein Begriff, „Hinweis“ (bis rc2 daneben
// „Datenschutz-Fenster“ im Hinweis zum Link).
export const PRIVACY_NOTICE_HINT =
  "Erscheint immer als Link „Datenschutz“ unter der Eingabe. Ein Klick öffnet den Hinweis über dem Chat. Für den Inhalt sind Sie als Betreiber der Website verantwortlich.";
export const PRIVACY_FIXED_NOTE =
  "Fest eingebaut: der KI-Hinweis „Unsere KI kann Fehler machen“ und daneben der Link „Datenschutz“.";
export const PRIVACY_URL_HINT =
  "https://… oder ein Pfad Ihrer Seite wie /datenschutz. Steht im Hinweis unter dem Text. Empfohlen: Ohne Link fehlt im Hinweis der Verweis auf Ihre Datenschutzerklärung.";
// Datenschutz zusätzlich beim Start als Blase (AK-12, Nutzer 24.10.2026,
// Wortlaut D3): Standard aus, der Link bleibt in jedem Fall (D1). Der
// Hinweis seit 25.10.2026 ohne den Satz zum Standard, den der
// Gruppenhinweis direkt darüber schon nennt (Fixliste AK-12 A2)
export const PRIVACY_START_BUBBLE_LABEL =
  "Zusätzlich beim Start als Blase zeigen";
export const PRIVACY_START_BUBBLE_HINT =
  "Mit Blase steht der Hinweis zusätzlich gleich beim Öffnen unter der Begrüßung und braucht mehr Platz.";

// Mindesthöhe der wachsenden Textfelder in Zeilen (R11)
export const GREETING_MIN_ROWS = 2;
export const PRIVACY_TEXT_MIN_ROWS = 5;

// Button „Standardtext“ neben einem Feld mit Kufer-Standard
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

// Hinweis unter „Willkommensblasen anzeigen“ (Mockup Ansicht 6; „Jeder
// Besuch“ nach der Entscheidung des Nutzers: einmal je Browser-Tab).
// Beschriftungen seit R11 kurz: Aus / Erster Besuch / Jeder Besuch.
export const WELCOME_BUBBLES_HINT =
  "„Erster Besuch“: Die Blasen erscheinen einmal; nach dem Schließen oder Öffnen des Chats nicht mehr (wie bisher). „Jeder Besuch“: bei jedem neuen Besuch wieder, also in jedem neuen Browser-Tab; beim Wechsel auf eine andere Seite im selben Tab nicht erneut. „Aus“: keine Blasen, nur der Chat-Button.";

// Hinweis unter leeren Listen (R5)
export const EMPTY_SUGGESTIONS_HINT = "Leer: keine Startvorschläge.";
export const EMPTY_WELCOME_BUBBLES_HINT =
  "Leer: es gelten die Standardblasen. Abschalten über „Willkommensblasen anzeigen“.";

// „Willkommensblasen anzeigen“ (KIE-568, nur Chatfenster): je Gerät Aus /
// Erster Besuch (Standard) / Jeder Besuch, je Gerät eine Zeile mit der
// Beschriftung links. Desktop und Handy nebeneinander (R11) passen nicht:
// die Auswahl ist in der Größe der übrigen Gruppen (Browser 7.22-rc6 B-02)
// rund 315 px breit, zwei davon brauchen mehr als die 560 px der Spalte.
// Gespeichert wird nur eine Abweichung (setChoice, Regel D6).
export function WelcomeBubblesDisplay({ config, setChoice }) {
  return (
    <div data-section="welcome-bubbles-display">
      <span className="block text-white text-sm font-medium mb-2.5">
        Willkommensblasen anzeigen
      </span>
      <div className="space-y-2.5">
        {WELCOME_BUBBLES_DEVICES.map(({ key, label }) => (
          <div
            key={key}
            className="flex flex-wrap items-center gap-x-4 gap-y-1.5"
            data-device={key}
          >
            <span className="text-theme-text-secondary text-xs font-medium w-16">
              {label}
            </span>
            <Segmented
              options={WELCOME_BUBBLES_OPTIONS}
              value={choiceValue(config, key)}
              onChange={(v) => setChoice(key, v)}
            />
          </div>
        ))}
      </div>
      <p className="text-theme-text-secondary text-xs mt-2.5 leading-relaxed">
        {WELCOME_BUBBLES_HINT}
      </p>
    </div>
  );
}

function FieldTitle({ title, optional = false, action = null }) {
  return (
    <div className="flex items-center justify-between gap-3 mb-1.5">
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

// Hinweis oder Fehler unter einem Feld
function FieldNote({ error = null, hint = null }) {
  if (error) return <p className="text-red-400 text-xs mt-1.5">{error}</p>;
  if (!hint) return null;
  return (
    <p className="text-theme-text-secondary text-xs mt-1.5 leading-relaxed">
      {hint}
    </p>
  );
}

// Liste (Startvorschläge, Willkommensblasen): Zeilen bearbeiten, löschen,
// hinzufügen; emptyHint unter einer leeren Liste
function MessageList({
  items,
  onAdd,
  onUpdate,
  onRemove,
  placeholder,
  addLabel,
  emptyHint,
  testId,
}) {
  return (
    <div className="space-y-2" data-list={testId}>
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
      {textItems(items).length === 0 && (
        <p className="text-theme-text-secondary text-xs leading-relaxed">
          {emptyHint}
        </p>
      )}
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
  setChoice = () => {},
  addListItem,
  updateListItem,
  removeListItem,
}) {
  const bubble = displayMode(config) === "bubble";

  const name = nameFieldValue(config, defaults);
  const subtitle = subtitleFieldValue(config, defaults);
  const subtitleIsStandard =
    !defaults ||
    !("assistantSubtitle" in config) ||
    sameAsDefault("assistantSubtitle", subtitle, defaults);

  const greeting = greetingFieldValue(config, greetingKey, defaults);
  const greetingIsStandard =
    !defaults || sameAsDefault("greeting", greeting, defaults);
  // Begrüßung von früher ohne Längengrenze: unverändert erlaubt, im Chat
  // aber gekürzt (Review F07)
  const greetingTooLongStored =
    greeting.trim().length > GREETING_MAX_LEN &&
    config[greetingKey] === initialConfig[greetingKey];

  const placeholder = placeholderFieldValue(config, defaults);
  const placeholderIsStandard =
    !defaults || sameAsDefault("sendMessageText", placeholder, defaults);
  const inlineBar = previewInlineBar(config, defaults);
  const storedBarText = storedInlineBarPlaceholder(config);
  // Eingeklappte Leiste und Eingabefeld zeigen denselben Text
  // (Nutzerentscheidung 23.10.2026); anders nur bei früher gespeichertem
  // Leistentext oder einem gespeicherten Platzhalter über 120 Zeichen
  const barSameAsInput =
    inlineBar.placeholder === previewPlaceholder(config, defaults);

  // Leeres Feld mit dem Standard als Platzhalter wie das Textfeld (F11,
  // Fixliste rc2); leer oder nur Leerzeichen gilt wie der Standard
  // (privacyTitleFieldValue, F18 Fixliste rc3)
  const privacyTitle = privacyTitleFieldValue(config, defaults);
  const privacyTitleDefault = privacyTitleStandard(defaults);
  const privacyTitleIsStandard =
    !defaults || sameAsDefault("privacyTitle", privacyTitle, defaults);

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

  // ohne gespeicherte Liste die Standard-Startvorschläge des Servers (S1:
  // dieselben, die das Widget ohne Liste zeigt); seit E42 leer, das Feld
  // zeigt dann nur „Leer: keine Startvorschläge.“
  const suggestions = listItems(config, "defaultMessages", defaults);
  const welcomeBubbles = listItems(config, "chatbotBubblesMessages");

  return (
    <>
      <GroupHeading title="Name und Untertitel" first />
      {/* Untereinander über die volle Spaltenbreite (Rückmeldung 20.10.2026),
          nicht mehr paarweise im Raster */}
      <SettingsSection
        title="Name"
        hint="Name des Chatbots in der Titelleiste des Chats. Leer: es gilt „KI-Berater“."
      >
        <input
          type="text"
          value={name}
          onChange={(e) => updateField("name", e.target.value)}
          className={inputClass(false)}
          aria-label="Name des Chatbots"
        />
      </SettingsSection>
      <div data-field="">
        <FieldTitle
          title="Untertitel"
          optional
          action={
            <StandardTextButton
              isStandard={subtitleIsStandard}
              defaultsError={defaultsError}
              onReset={() => resetKeys(["assistantSubtitle"])}
            />
          }
        />
        <input
          type="text"
          value={subtitle}
          maxLength={SUBTITLE_MAX_LEN}
          onChange={(e) => updateField("assistantSubtitle", e.target.value)}
          className={inputClass(errors.assistantSubtitle)}
          aria-label="Untertitel"
        />
        <FieldNote
          error={errors.assistantSubtitle}
          hint="Kleine Zeile unter dem Namen in der Titelleiste des Chats. Leer: kein Untertitel."
        />
      </div>

      <GroupHeading title="Begrüßung" />
      <div data-field="">
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
        <GrowingTextarea
          minRows={GREETING_MIN_ROWS}
          value={greeting}
          onChange={(e) => updateField(greetingKey, e.target.value)}
          placeholder={textValue(defaults?.greeting)}
          className={inputClass(errors[greetingKey])}
          aria-label="Begrüßungstext"
        />
        <FieldNote
          error={errors[greetingKey]}
          hint={
            greeting.trim() === ""
              ? "Leer: es gilt der Standardtext."
              : greetingTooLongStored
                ? `Der gespeicherte Text ist länger als ${GREETING_MAX_LEN} Zeichen. Im Chat erscheint er gekürzt (wie in der Vorschau).`
                : `Erste Blase im Chat, max. ${GREETING_MAX_LEN} Zeichen.`
          }
        />
      </div>

      <GroupHeading title="Datenschutz-Hinweis" hint={PRIVACY_NOTICE_HINT} />
      {/* AK-12: direkt unter dem Gruppenhinweis, vor den Feldern. An
          speichert privacyStartBubble: true, aus entfernt den Schlüssel
          (cleanConfig); die Felder darunter gelten für Fenster und Blase */}
      <div data-privacy-start-bubble="">
        <Switch
          label={PRIVACY_START_BUBBLE_LABEL}
          checked={privacyStartBubbleOn(config)}
          onChange={(checked) =>
            updateOptionalField("privacyStartBubble", checked ? true : null)
          }
        />
        <p className="text-theme-text-secondary text-xs mt-1.5 leading-relaxed">
          {PRIVACY_START_BUBBLE_HINT}
        </p>
      </div>
      {/* Felder des Datenschutz-Fensters, immer bearbeitbar, auch bei
          ausgeschalteter Blase (bis 7.22.2 gesperrt, wenn der Schalter
          „Datenschutz-Hinweis anzeigen“ aus war) */}
      <div className="space-y-5 min-w-0" data-privacy-fields="">
        {/* Überschrift schmal allein (halbe Breite), der Link darunter über
            die volle Breite, weil Links lang werden können (R11) */}
        {/* ohne „(optional)“ wie im Mockup (F12, Fixliste rc2): Text und
            Link sind ebenso freiwillig, leer gilt jeweils der Hinweis
            unter dem Feld */}
        <FieldPair>
          <div data-field="">
            <FieldTitle
              title="Überschrift"
              action={
                <StandardTextButton
                  isStandard={privacyTitleIsStandard}
                  defaultsError={defaultsError}
                  onReset={() => resetKeys(["privacyTitle"])}
                />
              }
            />
            <input
              type="text"
              value={privacyTitle}
              maxLength={PRIVACY_TITLE_MAX_LEN}
              onChange={(e) => updateField("privacyTitle", e.target.value)}
              placeholder={privacyTitleDefault}
              className={inputClass(errors.privacyTitle)}
              aria-label="Überschrift des Datenschutz-Hinweises"
            />
            {/* leer: das Fenster zeigt den Standard (Widget
                privacyDialogTitle); bis 7.22.2 hatte die Blase dann keine
                Überschrift */}
            <FieldNote
              error={errors.privacyTitle}
              hint={`Leer: es gilt „${privacyTitleDefault}“.`}
            />
          </div>
        </FieldPair>
        <div data-field="">
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
          <GrowingTextarea
            minRows={PRIVACY_TEXT_MIN_ROWS}
            value={privacyText}
            onChange={(e) => updateField("privacyText", e.target.value)}
            placeholder={textValue(defaults?.privacyText)}
            className={inputClass(errors.privacyText)}
            aria-label="Text des Datenschutz-Hinweises"
          />
          <FieldNote
            error={errors.privacyText}
            hint={
              privacyText.trim() === ""
                ? "Leer: es gilt der Standardtext."
                : legacyPoints
                  ? `${PRIVACY_RULE} Ohne eine Zeile mit „•“ oder „-“ werden mehrere Zeilen als Punkte gezeigt (wie bisher) und so gespeichert.`
                  : PRIVACY_RULE
            }
          />
        </div>
        <SettingsSection
          title="Link zur Datenschutzerklärung"
          hint={PRIVACY_URL_HINT}
          error={errors.privacyUrl}
        >
          <input
            type="text"
            value={textValue(config.privacyUrl)}
            maxLength={URL_MAX_LEN}
            onChange={(e) => updateOptionalField("privacyUrl", e.target.value)}
            placeholder="https://www.ihre-seite.de/datenschutz"
            className={inputClass(errors.privacyUrl)}
            aria-label="Link zur Datenschutzerklärung"
          />
        </SettingsSection>
        <p className="text-theme-text-secondary text-xs leading-relaxed">
          {PRIVACY_FIXED_NOTE}
        </p>
      </div>

      <GroupHeading title="Startvorschläge" />
      <SettingsSection
        title="Fragen zum Anklicken"
        hint="Buttons mit Fragen, die Besucher mit einem Klick stellen können. Ohne eigene Liste zeigt das Widget keine Startvorschläge."
      >
        <MessageList
          items={suggestions}
          onAdd={() => addListItem("defaultMessages")}
          onUpdate={(i, v) => updateListItem("defaultMessages", i, v)}
          onRemove={(i) => removeListItem("defaultMessages", i)}
          placeholder="z. B. Wie melde ich mich an?"
          addLabel="Vorschlag hinzufügen"
          emptyHint={EMPTY_SUGGESTIONS_HINT}
          testId="suggestions"
        />
      </SettingsSection>

      <GroupHeading title="Eingabe" />
      <div data-field="">
        <FieldTitle
          title="Platzhalter im Eingabefeld"
          action={
            <StandardTextButton
              isStandard={placeholderIsStandard}
              defaultsError={defaultsError}
              onReset={() => resetKeys(["sendMessageText"])}
            />
          }
        />
        <input
          type="text"
          value={placeholder}
          maxLength={PLACEHOLDER_MAX_LEN}
          onChange={(e) => updateField("sendMessageText", e.target.value)}
          className={inputClass(errors.sendMessageText)}
          aria-label="Platzhalter im Eingabefeld"
        />
        <FieldNote
          error={errors.sendMessageText}
          hint={
            bubble
              ? "Grauer Text im Eingabefeld des Chats. Leer: es gilt der Standardtext."
              : storedBarText
                ? `Grauer Text im Eingabefeld des Chats. Leer: es gilt der Standardtext. Die eingeklappte Leiste zeigt Ihren früher gespeicherten Text „${storedBarText}“.`
                : barSameAsInput
                  ? "Grauer Text im Eingabefeld des Chats. Leer: es gilt der Standardtext. Die eingeklappte Leiste zeigt denselben Text."
                  : `Grauer Text im Eingabefeld des Chats. Leer: es gilt der Standardtext. Die eingeklappte Leiste zeigt „${inlineBar.placeholder}“.`
          }
        />
      </div>

      {bubble && (
        <>
          <GroupHeading
            title="Geschlossener Chat"
            hint="Solange der Chat geschlossen ist, erscheinen neben dem Chat-Button kleine Sprechblasen."
          />
          <SettingsSection
            title="Willkommensblasen"
            hint="Texte der Sprechblasen neben dem geschlossenen Chat-Button. Vorbelegt mit den Standardblasen."
          >
            <MessageList
              items={welcomeBubbles}
              onAdd={() => addListItem("chatbotBubblesMessages")}
              onUpdate={(i, v) =>
                updateListItem("chatbotBubblesMessages", i, v)
              }
              onRemove={(i) => removeListItem("chatbotBubblesMessages", i)}
              placeholder="z. B. Hallo! Kann ich Ihnen helfen?"
              addLabel="Blase hinzufügen"
              emptyHint={EMPTY_WELCOME_BUBBLES_HINT}
              testId="welcome-bubbles"
            />
          </SettingsSection>
          <WelcomeBubblesDisplay config={config} setChoice={setChoice} />
        </>
      )}

      <GroupHeading title="Support" />
      <div data-field="">
        <FieldTitle title="Support-E-Mail" optional />
        <input
          type="email"
          value={textValue(config.supportEmail)}
          onChange={(e) => updateField("supportEmail", e.target.value)}
          placeholder="support@ihre-seite.de"
          className={inputClass(false)}
        />
        <FieldNote hint="E-Mail-Adresse für den Support-Link im Chat." />
      </div>
    </>
  );
}
