// Vorschau-Bausteine der Panel-Optik (Mock, angelehnt an das Widget):
// Kopf mit Untertitel/Online-Punkt, Begrüßung als Text oder Blase (mit
// Datenschutz-Punkten bei privacyNotice "bubble"), Startvorschläge als
// Balken oder Pillen, fester KI-Hinweis unter der Eingabe.
import { displayedText, enumValue, splitPrivacyPoints } from "./widgetKeys";

// Wirksamer Text wie im Widget: leeres Feld = Kufer-Standard
function textOrDefault(config, key, defaults) {
  return displayedText(config, key, defaults).trim() || defaults?.[key] || "";
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
  const subtitle = (config.assistantSubtitle || "").trim();
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

export function PreviewGreeting({ config, defaults, greeting }) {
  if (!greetingAsBubble(config))
    return (
      <div className="text-center text-gray-400 text-[13px] px-2 mb-4 leading-relaxed">
        {greeting}
      </div>
    );
  const bubbleText = textOrDefault(config, "greetingBubbleText", defaults);
  const privacyInBubble = enumValue(config.privacyNotice) === "bubble";
  const title = textOrDefault(config, "privacyTitle", defaults);
  const points = splitPrivacyPoints(
    textOrDefault(config, "privacyText", defaults)
  );
  return (
    <div className="w-full px-2 mb-4 space-y-1.5">
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
      {greeting && (
        <p className="text-gray-400 text-[11px] px-1 leading-relaxed">
          {greeting}
        </p>
      )}
    </div>
  );
}

export function PreviewSuggestions({ config, accentColor }) {
  const items = (config.defaultMessages || []).filter((m) => m.trim());
  if (items.length === 0) return null;
  const textColor = config.userTextColor || "#FFFFFF";
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
