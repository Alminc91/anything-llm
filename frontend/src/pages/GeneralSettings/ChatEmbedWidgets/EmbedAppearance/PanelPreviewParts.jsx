// Vorschau-Bausteine der Panel-Optik (Mock, angelehnt an das Widget):
// Kopf mit Untertitel/Online-Punkt, Begrüßung als Text oder Blase (mit
// Datenschutz-Punkten bei privacyNotice "bubble"), Startvorschläge als
// Balken oder Pillen, fester KI-Hinweis unter der Eingabe.
// visual_config kann per API beliebige Typen enthalten: Texte nur als
// String (sonst wie leer), Listen nur mit String-Einträgen.
import {
  displayedText,
  enumValue,
  splitPrivacyPoints,
  textItems,
  textValue,
} from "./widgetKeys";

// Wirksamer Text wie im Widget: leeres Feld = Kufer-Standard
function textOrDefault(config, key, defaults) {
  return (
    displayedText(config, key, defaults).trim() || textValue(defaults?.[key])
  );
}

// Begrüßung als Blase: aktiv gewählt oder durch Datenschutz in der Blase
// erzwungen (normalizePanelSettings im Widget)
function greetingAsBubble(config) {
  return (
    enumValue(config.greetingStyle) === "bubble" ||
    enumValue(config.privacyNotice) === "bubble"
  );
}

export function PreviewIdentity({ config, logoSrc, name, logoClass }) {
  const subtitle = textValue(config.assistantSubtitle).trim();
  return (
    <div className="flex items-center flex-1 gap-3 min-w-0">
      <span className="relative flex-shrink-0">
        <img
          src={logoSrc}
          alt="Logo"
          className={`${logoClass} rounded-lg object-contain`}
        />
        {config.onlineDot === true && (
          <span className="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full bg-green-500 border-2 border-white" />
        )}
      </span>
      <span className="flex flex-col min-w-0">
        <span className="text-gray-800 font-semibold text-sm truncate">
          {name}
        </span>
        {subtitle && (
          <span className="text-gray-500 text-[11px] truncate">{subtitle}</span>
        )}
      </span>
    </div>
  );
}

// Begrüßung + Startvorschläge in der Reihenfolge des Widgets:
// Text-Begrüßung: greeting, darunter die Vorschläge (ChatHistory im Widget).
// Blase (PanelWelcome im Widget): Blase -> Vorschläge -> kleiner greeting-
// Text; der kleine Text nur mit eigenem greeting und nicht bei
// privacyNotice "bubble" (die Datenschutz-Punkte stehen dann in der Blase).
export function PreviewGreeting({
  config,
  defaults,
  greeting,
  suggestions = null,
}) {
  if (!greetingAsBubble(config))
    return (
      <>
        <div className="text-center text-gray-400 text-[13px] px-2 mb-4 leading-relaxed">
          {textValue(greeting)}
        </div>
        {suggestions}
      </>
    );
  const bubbleText = textOrDefault(config, "greetingBubbleText", defaults);
  const privacyInBubble = enumValue(config.privacyNotice) === "bubble";
  const title = textOrDefault(config, "privacyTitle", defaults);
  const points = splitPrivacyPoints(
    textOrDefault(config, "privacyText", defaults)
  );
  const smallGreeting = privacyInBubble
    ? ""
    : textValue(config.greeting).trim();
  return (
    <div className="w-full px-2 mb-4 space-y-2.5">
      <div className="bg-gray-100 text-gray-800 text-[12px] leading-relaxed rounded-2xl rounded-tl-[4px] px-3.5 py-2.5 max-w-[90%] space-y-1.5">
        {bubbleText && <p>{bubbleText}</p>}
        {privacyInBubble && (
          <div>
            {title && <p className="font-semibold">{title}</p>}
            <ul className="list-disc pl-4">
              {points.map((p, i) => (
                <li key={i}>{p}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
      {suggestions && (
        <div className="flex justify-center w-full">{suggestions}</div>
      )}
      {smallGreeting && (
        <p className="text-gray-400 text-[11px] px-1 leading-relaxed">
          {smallGreeting}
        </p>
      )}
    </div>
  );
}

export function PreviewSuggestions({ config, accentColor }) {
  const items = textItems(config.defaultMessages);
  if (items.length === 0) return null;
  const textColor = textValue(config.userTextColor) || "#FFFFFF";
  if (enumValue(config.suggestionStyle) === "pills")
    return (
      <div className="flex flex-wrap justify-center gap-1.5 w-[90%]">
        {items.map((msg, i) => (
          <span
            key={i}
            className="rounded-full px-3 py-1 text-[11px] font-medium border"
            style={{ borderColor: accentColor, color: accentColor }}
          >
            {msg}
          </span>
        ))}
      </div>
    );
  return (
    <div className="flex flex-col gap-2 w-[75%]">
      {items.map((msg, i) => (
        <div
          key={i}
          className="rounded-xl px-5 py-3 text-[13px] text-center font-medium"
          style={{ backgroundColor: accentColor, color: textColor }}
        >
          {msg}
        </div>
      ))}
    </div>
  );
}

export function PreviewDisclaimer({ config, defaults }) {
  if (enumValue(config.disclaimer) !== "footer") return null;
  const text = textOrDefault(config, "disclaimerText", defaults);
  if (!text) return null;
  return (
    <p className="text-center text-gray-400 text-[10px] leading-snug mt-1.5 px-2">
      {text}
    </p>
  );
}
