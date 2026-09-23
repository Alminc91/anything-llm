import { useEffect, useState, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  ArrowLeft,
  FloppyDisk,
  Trash,
  Plus,
  X,
  ChatCircleDots,
  Headset,
  Binoculars,
  MagnifyingGlass,
  MagicWand,
  DotsThreeOutlineVertical,
  PaperPlaneRight,
  Microphone,
  SpeakerHigh,
  Check,
  CaretDown,
  CaretUp,
  CopySimple,
} from "@phosphor-icons/react";
import showToast from "@/utils/toast";
import CTAButton from "@/components/lib/CTAButton";
import Embed from "@/models/embed";
import { API_BASE, EMBED_INLINE_PLACEHOLDER_SNIPPET } from "@/utils/constants";
import { baseHeaders } from "@/utils/request";

const CHAT_ICONS = [
  { id: "chatBubble", label: "Chat-Blase", Icon: ChatCircleDots },
  { id: "support", label: "Support", Icon: Headset },
  { id: "search", label: "Suche", Icon: MagnifyingGlass },
  { id: "search2", label: "Fernglas", Icon: Binoculars },
  { id: "magic", label: "Magie", Icon: MagicWand },
  { id: "plus", label: "Plus", Icon: Plus },
];

const DEFAULT_LOGO = "https://www.kufer.de/typo3conf/ext/kubuslayout/Resources/Public/Icons/augenbrauen-3.png";

const POSITION_OPTIONS = [
  { value: "bottom-left", label: "Links" },
  { value: "bottom-right", label: "Rechts" },
];

// Darstellung: Chat-Blase (Standard) oder Inline in der Webseite. Gespeichert
// wird displayMode nur, wenn der Admin aktiv gewählt hat (dann auch "bubble",
// das einen data-display-mode="inline" am Script überschreibt). Bestandskunden
// ohne Klick bekommen keinen neuen Key geschrieben.
const DISPLAY_MODE_OPTIONS = [
  { value: "bubble", label: "Chat-Blase" },
  { value: "inline", label: "Inline (in der Seite)" },
];

const INLINE_START_OPTIONS = [
  { value: "collapsed", label: "Eingeklappt" },
  { value: "expanded", label: "Aufgeklappt" },
];

const INLINE_THEME_OPTIONS = [
  { value: "light", label: "Hell" },
  { value: "dark", label: "Dunkel" },
];

const DEFAULT_INLINE_TEXT = "Jetzt mit unserem KI-Assistenten schreiben";

// Grenzen — gleich wie Server (endpoints/embed) und Widget (utils/layout)
const OFFSET_MAX_PX = 200;
const INLINE_TEXT_MAX_LEN = 120;
const INLINE_MIN_HEIGHT_PX = 400;
const INLINE_MAX_HEIGHT_PX = 1200;
const INLINE_MIN_WIDTH_PX = 280;
const PREVIEW_CONTENT_WIDTH_PX = 1100; // typische Inhaltsspalte (nur Vorschau)

// Optionale Layout-Felder (visual_config). Leer = Feld weglassen = Standard.
// Gleiche Whitelist wie Server (endpoints/embed) und Widget (utils/layout).
const CSS_LENGTH_RE = /^(\d{1,4}(?:\.\d{1,2})?)(px|%|vw|vh)?$/;
const OFFSET_RE = /^(\d{1,3})(px)?$/; // optional "px", wie Server/Widget
const LAYOUT_LENGTH_FIELDS = {
  windowWidth: {
    units: ["px", "%", "vw", "vh"],
    message: "Bitte eine Zahl mit Einheit angeben, z. B. 420px, 25% oder 30vw.",
  },
  windowHeight: {
    units: ["px", "%", "vw", "vh"],
    message: "Bitte eine Zahl mit Einheit angeben, z. B. 640px, 80% oder 70vh.",
  },
  inlineHeight: {
    units: ["px", "vh"],
    message: "Bitte px oder vh angeben, z. B. 600px oder 70vh.",
  },
  inlineMaxWidth: {
    units: ["px"],
    message: "Bitte eine Breite in px angeben, z. B. 900px.",
  },
};
const LAYOUT_OFFSET_FIELDS = ["offsetX", "offsetY"];
const LAYOUT_TEXT_FIELDS = ["inlineCollapsedText"];

// Welche Freitext-Felder zu welcher Darstellung gehören (nur die des aktiven
// Modus werden geprüft; ungültige Werte des ausgeblendeten Modus werden beim
// Speichern verworfen).
const MODE_FIELDS = {
  bubble: ["windowWidth", "windowHeight", "offsetX", "offsetY"],
  inline: ["inlineCollapsedText", "inlineHeight", "inlineMaxWidth"],
};

function normalizeCssLength(value, units) {
  if (value === undefined || value === null) return null;
  const m = CSS_LENGTH_RE.exec(String(value).trim().toLowerCase());
  if (!m || Number(m[1]) <= 0) return undefined; // undefined = ungültig
  const unit = m[2] || "px";
  return units.includes(unit) ? `${m[1]}${unit}` : undefined;
}

// Abstand -> Zahl 0–200 oder undefined (ungültig)
function normalizeOffset(value) {
  const m = OFFSET_RE.exec(String(value).trim().toLowerCase());
  if (!m) return undefined;
  const n = Number(m[1]);
  return n <= OFFSET_MAX_PX ? n : undefined;
}

// Text -> getrimmt oder undefined (zu lang)
function normalizeText(value) {
  const v = String(value).trim();
  return v.length <= INLINE_TEXT_MAX_LEN ? v : undefined;
}

function isBlank(value) {
  return value === undefined || value === null || String(value).trim() === "";
}

// Gesetzter Wert -> normalisiert; undefined = ungültig
function normalizeLayoutField(field, value) {
  if (LAYOUT_LENGTH_FIELDS[field])
    return normalizeCssLength(value, LAYOUT_LENGTH_FIELDS[field].units);
  if (LAYOUT_OFFSET_FIELDS.includes(field)) return normalizeOffset(value);
  if (LAYOUT_TEXT_FIELDS.includes(field)) return normalizeText(value);
  return value;
}

function layoutErrorMessage(field) {
  if (LAYOUT_LENGTH_FIELDS[field]) return LAYOUT_LENGTH_FIELDS[field].message;
  if (LAYOUT_OFFSET_FIELDS.includes(field))
    return `Bitte eine ganze Zahl zwischen 0 und ${OFFSET_MAX_PX} angeben.`;
  return `Maximal ${INLINE_TEXT_MAX_LEN} Zeichen.`;
}

function activeDisplayMode(config) {
  return config.displayMode === "inline" ? "inline" : "bubble";
}

// Fehlermeldungen je Feld — nur für gesetzte, ungültige Werte des aktiven Modus
function validateLayout(config) {
  const errors = {};
  for (const field of MODE_FIELDS[activeDisplayMode(config)]) {
    if (isBlank(config[field])) continue;
    if (normalizeLayoutField(field, config[field]) === undefined)
      errors[field] = layoutErrorMessage(field);
  }
  return errors;
}

// Vor dem Speichern: leere Layout-Felder entfernen (nie "" speichern), Längen
// normalisieren (nackte Zahl -> px), Abstände als Zahl, Text getrimmt.
// Ungültige Werte (nur im ausgeblendeten Modus möglich) werden verworfen.
// displayMode/inheritFont nur behalten, wenn gültig (Key existiert nur nach
// aktiver Wahl). Es werden nie Keys hinzugefügt.
function cleanLayoutConfig(config) {
  const cleaned = { ...config };
  for (const field of [...MODE_FIELDS.bubble, ...MODE_FIELDS.inline]) {
    if (!(field in cleaned)) continue;
    const value = isBlank(cleaned[field])
      ? undefined
      : normalizeLayoutField(field, cleaned[field]);
    if (value === undefined) delete cleaned[field];
    else cleaned[field] = value;
  }
  const validModes = DISPLAY_MODE_OPTIONS.map((o) => o.value);
  if ("displayMode" in cleaned && !validModes.includes(cleaned.displayMode))
    delete cleaned.displayMode;
  if ("inheritFont" in cleaned && typeof cleaned.inheritFont !== "boolean")
    delete cleaned.inheritFont;
  return cleaned;
}

// Reihenfolge-unabhängiger Vergleich (Keys sortiert) für den Dirty-Check
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .filter((k) => value[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

// Hinweis, wenn der Wert im Widget geklemmt wird (kein Fehler)
function inlineHeightHint(value) {
  const v = normalizeCssLength(value, ["px", "vh"]);
  if (!v || !v.endsWith("px")) return null;
  const n = parseFloat(v);
  if (n < INLINE_MIN_HEIGHT_PX)
    return `Wird im Widget auf mindestens ${INLINE_MIN_HEIGHT_PX}px gesetzt.`;
  if (n > INLINE_MAX_HEIGHT_PX)
    return `Wird im Widget auf höchstens ${INLINE_MAX_HEIGHT_PX}px begrenzt.`;
  return null;
}

const USER_TEXT_COLOR_OPTIONS = [
  { value: "#FFFFFF", label: "Weiß" },
  { value: "#222628", label: "Schwarz" },
];

const DEFAULT_CONFIG = {
  accentColor: "#607D8B",
  userTextColor: "#FFFFFF",
  chatIcon: "chatBubble",
  position: "bottom-left",
  name: "Ihr Online-Berater",
  greeting:
    "Hallo und herzlich willkommen! Ich helfe Ihnen gerne weiter und beantworte Ihre Fragen mit intelligenten, KI-gestützten Antworten.",
  sendMessageText: "Wie kann ich Ihnen helfen?",
  supportEmail: "",
  defaultMessages: [],
  chatbotBubblesMessages: [
    "Hallo! Ich bin Ihr Online-Berater!",
    "Möchten Sie mehr über unser Angebot erfahren? Ich helfe gerne weiter!",
  ],
  logoFilename: null,
  logoUrl: null,
};

export default function EmbedAppearance() {
  const { embedId } = useParams();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [embed, setEmbed] = useState(null);
  const [config, setConfig] = useState({ ...DEFAULT_CONFIG });
  const [initialConfig, setInitialConfig] = useState({ ...DEFAULT_CONFIG });
  const [activeTab, setActiveTab] = useState("inhalt");
  const [logoPreview, setLogoPreview] = useState(null);

  const hasChanges = stableStringify(config) !== stableStringify(initialConfig);

  useEffect(() => {
    async function load() {
      const embedData = await Embed.getEmbed(embedId);
      if (!embedData) {
        showToast("Einbettung nicht gefunden.", "error");
        navigate("/settings/embed-chat-widgets");
        return;
      }
      setEmbed(embedData);

      let visualConfig = {};
      if (embedData.visual_config) {
        try {
          visualConfig = JSON.parse(embedData.visual_config);
        } catch {}
      }
      const loadedConfig = { ...DEFAULT_CONFIG, ...visualConfig };
      // Migrate legacy pure black to the softer charcoal that pairs better
      // with warm accent colors and matches the assistant text color in the live widget.
      if (loadedConfig.userTextColor === "#000000") {
        loadedConfig.userTextColor = "#222628";
      }
      setConfig(loadedConfig);
      setInitialConfig(loadedConfig);

      if (visualConfig.logoFilename) {
        setLogoPreview(
          `${API_BASE}/embed/${embedData.uuid}/logo?t=${Date.now()}`
        );
      } else if (visualConfig.logoUrl) {
        setLogoPreview(visualConfig.logoUrl);
      }

      setLoading(false);
    }
    load();
  }, [embedId]);

  const updateField = useCallback((field, value) => {
    setConfig((prev) => ({ ...prev, [field]: value }));
  }, []);

  // Optionale Felder: leer/null -> Feld entfernen (nicht als "" speichern)
  const updateOptionalField = useCallback((field, value) => {
    setConfig((prev) => {
      const next = { ...prev };
      if (value === undefined || value === null || value === "")
        delete next[field];
      else next[field] = value;
      return next;
    });
  }, []);

  const layoutErrors = validateLayout(config);
  const isInline = config.displayMode === "inline";

  const handleSave = async () => {
    const savedConfig = config;
    if (Object.keys(layoutErrors).length > 0) {
      showToast(
        "Bitte die markierten Felder unter „Aussehen“ korrigieren.",
        "error"
      );
      setActiveTab("design");
      return;
    }
    const cleanedConfig = cleanLayoutConfig(savedConfig);
    setSaving(true);
    const { success, error } = await Embed.updateVisualConfig(
      embedId,
      cleanedConfig
    );
    setSaving(false);
    if (success) {
      // Funktional: wurde während des Requests weiter editiert, bleiben diese
      // Eingaben erhalten (und als ungespeichert markiert).
      setConfig((prev) => (prev === savedConfig ? cleanedConfig : prev));
      setInitialConfig({ ...cleanedConfig });
      showToast("Erscheinungsbild gespeichert.", "success");
    } else {
      showToast(error || "Fehler beim Speichern.", "error");
    }
  };

  const handleLogoUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const formData = new FormData();
    formData.append("logo", file);

    const result = await Embed.uploadEmbedLogo(embedId, formData);
    if (result.success) {
      setLogoPreview(URL.createObjectURL(file));
      setConfig((prev) => ({
        ...prev,
        logoFilename: result.logoFilename,
        logoUrl: null,
      }));
      showToast("Logo hochgeladen.", "success");
    } else {
      showToast(result.error || "Fehler beim Hochladen.", "error");
    }
  };

  const handleLogoRemove = async () => {
    const result = await Embed.removeEmbedLogo(embedId);
    if (result.success) {
      setLogoPreview(null);
      setConfig((prev) => ({
        ...prev,
        logoFilename: null,
        logoUrl: null,
      }));
      showToast("Logo entfernt.", "success");
    }
  };

  const addListItem = (field) => {
    setConfig((prev) => ({
      ...prev,
      [field]: [...(prev[field] || []), ""],
    }));
  };

  const updateListItem = (field, index, value) => {
    setConfig((prev) => {
      const updated = [...(prev[field] || [])];
      updated[index] = value;
      return { ...prev, [field]: updated };
    });
  };

  const removeListItem = (field, index) => {
    setConfig((prev) => ({
      ...prev,
      [field]: (prev[field] || []).filter((_, i) => i !== index),
    }));
  };

  if (loading) {
    return (
      <div className="w-full h-full flex items-center justify-center">
        <p className="text-theme-text-secondary">Laden...</p>
      </div>
    );
  }

  return (
    <div className="w-screen h-screen flex flex-col bg-theme-bg-container overflow-hidden">
      {/* Header */}
      <div className="flex items-center px-6 pr-16 md:pr-24 pt-[2.25rem] pb-5 border-b border-white/10">
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate("/settings/embed-chat-widgets")}
            className="text-theme-text-secondary hover:text-white p-1.5 rounded-lg hover:bg-white/5 transition-colors"
          >
            <ArrowLeft size={20} />
          </button>
          <div>
            <h1 className="text-lg leading-6 font-bold text-white">
              Erscheinungsbild
            </h1>
            <p className="text-xs leading-[18px] font-base text-white text-opacity-60">
              {embed?.workspace?.name || "Embed"}
            </p>
          </div>
        </div>
      </div>

      {/* Content: Settings left, Preview right */}
      <div className="flex flex-1 overflow-hidden">
        {/* Settings Panel */}
        <div className="w-1/2 max-w-[600px] flex flex-col border-r border-white/10">
          {/* Tabs */}
          <div className="flex border-b border-white/10 px-5 pt-3">
            {[
              { id: "inhalt", label: "Inhalt" },
              { id: "design", label: "Aussehen" },
            ].map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`px-4 py-2.5 text-sm font-semibold transition-all relative ${
                  activeTab === tab.id
                    ? "text-primary-button"
                    : "text-theme-text-secondary hover:text-primary-button/70"
                }`}
              >
                {tab.label}
                {activeTab === tab.id && (
                  <div className="absolute bottom-0 left-2 right-2 h-[2px] bg-primary-button rounded-full" />
                )}
              </button>
            ))}
          </div>

          {/* Tab Content */}
          <div className="flex-1 overflow-y-auto p-5 space-y-5">
            {activeTab === "design" && (
              <>
                <SettingsSection title="Logo" hint="PNG, JPG, GIF, SVG oder WebP — max. 5 MB, idealerweise quadratisch.">
                  <div className="flex items-center gap-4">
                    <div className="relative group">
                      <img
                        src={logoPreview || DEFAULT_LOGO}
                        alt="Logo"
                        className="h-12 w-12 rounded-lg object-contain bg-white/5 border border-white/10"
                      />
                      {logoPreview && (
                        <button
                          onClick={handleLogoRemove}
                          className="absolute -top-1.5 -right-1.5 bg-theme-bg-container text-theme-text-secondary hover:text-red-400 rounded-full p-0.5 border border-white/10 transition-colors"
                        >
                          <X size={12} weight="bold" />
                        </button>
                      )}
                    </div>
                    <label className="cursor-pointer bg-theme-settings-input-bg text-white text-sm rounded-lg px-4 py-2 border border-white/10 hover:bg-theme-action-menu-item-hover transition-all">
                      {logoPreview ? "Logo ändern" : "Logo hochladen"}
                      <input
                        type="file"
                        accept="image/png,image/jpeg,image/gif,image/svg+xml,image/webp"
                        onChange={handleLogoUpload}
                        className="hidden"
                      />
                    </label>
                  </div>
                </SettingsSection>

                <SettingsSection title="Kundenfarbe (Akzentfarbe)" hint="Wird für Buttons, Benutzer-Nachrichten und Links verwendet.">
                  <div className="relative flex items-center bg-theme-settings-input-bg rounded-lg border border-white/10 hover:border-white/25 transition-colors w-44 cursor-pointer">
                    <div className="relative flex-shrink-0 ml-1.5">
                      <div
                        className="w-8 h-8 rounded-md"
                        style={{ backgroundColor: config.accentColor }}
                      />
                      <input
                        type="color"
                        value={config.accentColor}
                        onChange={(e) => updateField("accentColor", e.target.value)}
                        className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                      />
                    </div>
                    <input
                      type="text"
                      value={config.accentColor}
                      onChange={(e) => updateField("accentColor", e.target.value)}
                      className="bg-transparent text-white text-sm px-2.5 py-2.5 w-full font-mono outline-none"
                      placeholder="#607D8B"
                    />
                  </div>
                </SettingsSection>

                <SettingsSection title="Schriftfarbe Nutzer-Sprechblase" hint="Farbe des Texts in den Sprechblasen des Nutzers (auf der Akzentfarbe).">
                  <div className="flex rounded-lg overflow-hidden border border-white/10 w-fit">
                    {USER_TEXT_COLOR_OPTIONS.map((opt) => (
                      <button
                        key={opt.value}
                        onClick={() => updateField("userTextColor", opt.value)}
                        className={`flex items-center gap-2 px-5 py-2 text-sm font-medium transition-all ${
                          (config.userTextColor || "#FFFFFF") === opt.value
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

                <SettingsSection title="Chat-Icon" hint="Das Icon auf dem Chat-Button.">
                  <div className="flex gap-2.5 flex-wrap">
                    {CHAT_ICONS.map(({ id, label, Icon }) => {
                      const isSelected = config.chatIcon === id;
                      return (
                        <button
                          key={id}
                          onClick={() => updateField("chatIcon", id)}
                          className="flex flex-col items-center gap-1.5 p-1.5 rounded-lg transition-all"
                          title={label}
                        >
                          <div
                            className={`relative w-11 h-11 rounded-full flex items-center justify-center text-white shadow-md transition-all hover:scale-110 ${
                              isSelected ? "ring-2 ring-white ring-offset-2 ring-offset-theme-bg-container" : ""
                            }`}
                            style={{ backgroundColor: config.accentColor || "#607D8B" }}
                          >
                            <Icon size={22} weight="fill" color="#ffffff" />
                          </div>
                          <span className={`text-[10px] transition-colors ${isSelected ? "text-white" : "text-theme-text-secondary"}`}>
                            {label}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </SettingsSection>

                <SettingsSection
                  title="Darstellung"
                  hint="Chat-Blase am Bildschirmrand oder als Chat-Fläche direkt in Ihrer Webseite."
                >
                  <Segmented
                    options={DISPLAY_MODE_OPTIONS}
                    value={isInline ? "inline" : "bubble"}
                    onChange={(v) => updateField("displayMode", v)}
                  />
                </SettingsSection>

                {isInline ? (
                  <>
                    <InlinePlaceholderHint />

                    <SettingsSection
                      title="Leistentext"
                      hint={`Text der eingeklappten Leiste (max. ${INLINE_TEXT_MAX_LEN} Zeichen).`}
                      error={layoutErrors.inlineCollapsedText}
                    >
                      <input
                        type="text"
                        maxLength={INLINE_TEXT_MAX_LEN}
                        value={config.inlineCollapsedText ?? ""}
                        onChange={(e) =>
                          updateOptionalField(
                            "inlineCollapsedText",
                            e.target.value
                          )
                        }
                        placeholder={DEFAULT_INLINE_TEXT}
                        className={inputClass(layoutErrors.inlineCollapsedText)}
                      />
                    </SettingsSection>

                    <div className="grid grid-cols-2 gap-4">
                      <SettingsSection
                        title="Höhe aufgeklappt"
                        hint="px oder vh — leer = 600px."
                        error={layoutErrors.inlineHeight}
                        note={inlineHeightHint(config.inlineHeight)}
                      >
                        <input
                          type="text"
                          value={config.inlineHeight ?? ""}
                          onChange={(e) =>
                            updateOptionalField("inlineHeight", e.target.value)
                          }
                          placeholder="z. B. 600px oder 70vh"
                          className={inputClass(layoutErrors.inlineHeight)}
                        />
                      </SettingsSection>
                      <SettingsSection
                        title="Max. Breite"
                        hint="px — leer = volle Breite."
                        error={layoutErrors.inlineMaxWidth}
                      >
                        <input
                          type="text"
                          value={config.inlineMaxWidth ?? ""}
                          onChange={(e) =>
                            updateOptionalField("inlineMaxWidth", e.target.value)
                          }
                          placeholder="z. B. 900px"
                          className={inputClass(layoutErrors.inlineMaxWidth)}
                        />
                      </SettingsSection>
                    </div>

                    <SettingsSection
                      title="Startzustand"
                      hint="Wie der Chat beim Laden der Seite erscheint. Aufgeklappt gilt ab 768px Breite — mobil erscheint immer die Leiste."
                    >
                      <Segmented
                        options={INLINE_START_OPTIONS}
                        value={config.inlineStartState || "collapsed"}
                        onChange={(v) => updateField("inlineStartState", v)}
                      />
                    </SettingsSection>

                    <SettingsSection
                      title="Leisten-Stil"
                      hint="Hell (weiß mit grauem Rand) oder dunkel (für dunkle Seitenbereiche)."
                    >
                      <Segmented
                        options={INLINE_THEME_OPTIONS}
                        value={config.inlineTheme || "light"}
                        onChange={(v) => updateField("inlineTheme", v)}
                      />
                    </SettingsSection>

                    <label className="flex items-center gap-2.5 cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={config.inheritFont === true}
                        onChange={(e) =>
                          updateField("inheritFont", e.target.checked)
                        }
                        className="w-4 h-4 accent-primary-button cursor-pointer"
                      />
                      <span className="text-white text-sm">
                        Schrift der Webseite übernehmen
                      </span>
                    </label>
                  </>
                ) : (
                  <>
                    <div className="grid grid-cols-2 gap-4">
                      <SettingsSection
                        title="Fensterbreite"
                        hint="Tablet/Desktop — leer = Standard."
                        error={layoutErrors.windowWidth}
                      >
                        <input
                          type="text"
                          value={config.windowWidth ?? ""}
                          onChange={(e) =>
                            updateOptionalField("windowWidth", e.target.value)
                          }
                          placeholder="z. B. 420px oder 25%"
                          className={inputClass(layoutErrors.windowWidth)}
                        />
                      </SettingsSection>
                      <SettingsSection
                        title="Fensterhöhe"
                        hint="Tablet/Desktop — leer = Standard."
                        error={layoutErrors.windowHeight}
                      >
                        <input
                          type="text"
                          value={config.windowHeight ?? ""}
                          onChange={(e) =>
                            updateOptionalField("windowHeight", e.target.value)
                          }
                          placeholder="z. B. 640px oder 80%"
                          className={inputClass(layoutErrors.windowHeight)}
                        />
                      </SettingsSection>
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <SettingsSection
                        title="Abstand zum Rand X"
                        hint={`In px (0–${OFFSET_MAX_PX}) — leer = 16px.`}
                        error={layoutErrors.offsetX}
                      >
                        <input
                          type="number"
                          min={0}
                          max={OFFSET_MAX_PX}
                          step={1}
                          value={config.offsetX ?? ""}
                          onChange={(e) =>
                            updateOptionalField("offsetX", e.target.value)
                          }
                          placeholder="16"
                          className={inputClass(layoutErrors.offsetX)}
                        />
                      </SettingsSection>
                      <SettingsSection
                        title="Abstand zum Rand Y"
                        hint={`In px (0–${OFFSET_MAX_PX}) — leer = 16px.`}
                        error={layoutErrors.offsetY}
                      >
                        <input
                          type="number"
                          min={0}
                          max={OFFSET_MAX_PX}
                          step={1}
                          value={config.offsetY ?? ""}
                          onChange={(e) =>
                            updateOptionalField("offsetY", e.target.value)
                          }
                          placeholder="16"
                          className={inputClass(layoutErrors.offsetY)}
                        />
                      </SettingsSection>
                    </div>
                  </>
                )}

                <SettingsSection
                  title="Position"
                  hint={
                    isInline
                      ? "Position der Chat-Blase — gilt auf Seiten ohne Platzhalter."
                      : "Position des Chat-Widgets auf der Webseite."
                  }
                >
                  <Segmented
                    options={POSITION_OPTIONS}
                    value={config.position}
                    onChange={(v) => updateField("position", v)}
                  />
                </SettingsSection>
              </>
            )}

            {activeTab === "inhalt" && (
              <>
                <SettingsSection title="Name" hint="Name des Chatbots (wird im Header und als Assistenten-Name angezeigt).">
                  <input
                    type="text"
                    value={config.name}
                    onChange={(e) => updateField("name", e.target.value)}
                    placeholder="Ihr Online-Berater"
                    className="bg-theme-settings-input-bg text-white text-sm rounded-lg px-3 py-2 w-full border border-white/10 focus:border-white/25 focus:outline-none transition-colors"
                  />
                </SettingsSection>

                <SettingsSection title="Begrüßung" hint="Zentrierter Text beim ersten Öffnen des Chats, bevor eine Unterhaltung beginnt.">
                  <textarea
                    value={config.greeting}
                    onChange={(e) => updateField("greeting", e.target.value)}
                    placeholder="Hallo und herzlich willkommen! Wie kann ich Ihnen helfen?"
                    rows={5}
                    className="bg-theme-settings-input-bg text-white text-sm rounded-lg px-3 py-2 w-full border border-white/10 focus:border-white/25 focus:outline-none resize-none transition-colors"
                  />
                </SettingsSection>

                <SettingsSection title="Platzhalter" hint="Grauer Text im Eingabefeld, bevor der Nutzer tippt.">
                  <input
                    type="text"
                    value={config.sendMessageText}
                    onChange={(e) => updateField("sendMessageText", e.target.value)}
                    placeholder="Wie kann ich Ihnen helfen?"
                    className="bg-theme-settings-input-bg text-white text-sm rounded-lg px-3 py-2 w-full border border-white/10 focus:border-white/25 focus:outline-none transition-colors"
                  />
                </SettingsSection>

                <SettingsSection title="Startvorschläge" hint="Klickbare Nachrichtenblöcke in der Akzentfarbe, die vor dem ersten Chat angezeigt werden.">
                  <MessageList
                    items={config.defaultMessages || []}
                    onAdd={() => addListItem("defaultMessages")}
                    onUpdate={(i, v) => updateListItem("defaultMessages", i, v)}
                    onRemove={(i) => removeListItem("defaultMessages", i)}
                    placeholder="z.B. Was sind Ihre Öffnungszeiten?"
                  />
                </SettingsSection>

                <SettingsSection title="Willkommensblasen" hint="Sprechblasen neben dem Chat-Button, bevor der Chat geöffnet wird.">
                  <MessageList
                    items={config.chatbotBubblesMessages || []}
                    onAdd={() => addListItem("chatbotBubblesMessages")}
                    onUpdate={(i, v) => updateListItem("chatbotBubblesMessages", i, v)}
                    onRemove={(i) => removeListItem("chatbotBubblesMessages", i)}
                    placeholder="z.B. Hallo! Kann ich Ihnen helfen?"
                  />
                </SettingsSection>

                <SettingsSection title="Support-E-Mail" hint="E-Mail-Adresse für den Support-Link im Chat.">
                  <input
                    type="email"
                    value={config.supportEmail}
                    onChange={(e) => updateField("supportEmail", e.target.value)}
                    placeholder="support@firma.de"
                    className="bg-theme-settings-input-bg text-white text-sm rounded-lg px-3 py-2 w-full border border-white/10 focus:border-white/25 focus:outline-none transition-colors"
                  />
                </SettingsSection>
              </>
            )}
          </div>
          {/* Save Footer — nur bei Änderungen */}
          {hasChanges && (
            <div className="flex items-center justify-between px-5 py-4 border-t border-white/10 bg-theme-bg-container">
              <p className="text-xs font-semibold text-theme-text-secondary">
                Ungespeicherte Änderungen
              </p>
              <div className="flex items-center gap-3">
                <button
                  onClick={() => {
                    setConfig({ ...initialConfig });
                  }}
                  className="text-xs px-4 py-1 font-medium rounded-lg border border-white/10 text-theme-text-secondary hover:text-white hover:bg-white/5 h-[34px] whitespace-nowrap transition-all"
                >
                  Verwerfen
                </button>
                <CTAButton
                  onClick={handleSave}
                  disabled={saving}
                  className="!-mr-0"
                >
                  {saving ? "Speichern..." : "Speichern"}
                </CTAButton>
              </div>
            </div>
          )}
        </div>

        {/* Live Preview Panel — fixed, no scroll */}
        <div className="flex-1 overflow-hidden flex items-center justify-center relative"
          style={{
            background: "linear-gradient(135deg, #f0f2f5 0%, #e4e8ec 50%, #dde1e6 100%)",
            backgroundImage: `
              linear-gradient(135deg, #f0f2f5 0%, #e4e8ec 50%, #dde1e6 100%),
              radial-gradient(circle at 20% 80%, rgba(0,0,0,0.02) 0%, transparent 50%),
              radial-gradient(circle at 80% 20%, rgba(0,0,0,0.02) 0%, transparent 50%)
            `,
          }}
        >
          <WidgetPreview config={config} logoPreview={logoPreview} />
        </div>
      </div>
    </div>
  );
}

function SettingsSection({ title, hint, children, error = null, note = null }) {
  return (
    <div>
      <label className="block text-white text-sm font-medium mb-0.5">{title}</label>
      {hint && (
        <p className="text-theme-text-secondary text-xs mb-2.5 leading-relaxed">{hint}</p>
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

function inputClass(hasError) {
  return `bg-theme-settings-input-bg text-white text-sm rounded-lg px-3 py-2 w-full border ${
    hasError
      ? "border-red-400/70 focus:border-red-400"
      : "border-white/10 focus:border-white/25"
  } focus:outline-none transition-colors`;
}

// Button-Gruppe im Stil der Positions-Auswahl
function Segmented({ options, value, onChange }) {
  return (
    <div className="flex rounded-lg overflow-hidden border border-white/10 w-fit">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          className={`px-5 py-2 text-sm font-medium transition-all ${
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

// Hinweis + Kopieren des Platzhalters für den Inline-Modus
function InlinePlaceholderHint() {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await window.navigator.clipboard.writeText(
        EMBED_INLINE_PLACEHOLDER_SNIPPET
      );
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      showToast("Platzhalter kopiert.", "success", { clear: true });
    } catch {
      showToast("Kopieren nicht möglich — bitte manuell markieren.", "error");
    }
  };
  return (
    <div className="rounded-lg border border-primary-button/40 bg-primary-button/10 p-3.5 space-y-2.5">
      <p className="text-white text-xs leading-relaxed">
        Fügen Sie an der gewünschten Stelle Ihrer Seite{" "}
        <code className="font-mono bg-black/30 rounded px-1 py-0.5">
          {EMBED_INLINE_PLACEHOLDER_SNIPPET}
        </code>{" "}
        ein. Ohne diesen Platzhalter erscheint weiterhin die Chat-Blase. Das
        Script-Snippet bleibt unverändert.
      </p>
      <button
        type="button"
        onClick={copy}
        className="flex items-center gap-1.5 text-xs font-medium text-white bg-theme-settings-input-bg border border-white/10 hover:bg-theme-action-menu-item-hover rounded-lg px-3 py-1.5 transition-all"
      >
        {copied ? <Check size={14} weight="bold" /> : <CopySimple size={14} />}
        {copied ? "Kopiert" : "Platzhalter kopieren"}
      </button>
    </div>
  );
}

function MessageList({ items, onAdd, onUpdate, onRemove, placeholder }) {
  return (
    <div className="space-y-2">
      {items.map((item, index) => (
        <div key={index} className="flex items-center gap-2 group">
          <input
            type="text"
            value={item}
            onChange={(e) => onUpdate(index, e.target.value)}
            placeholder={placeholder}
            className="bg-theme-settings-input-bg text-white text-sm rounded-lg px-3 py-2 flex-1 border border-white/10 focus:border-white/25 focus:outline-none transition-colors"
          />
          <button
            onClick={() => onRemove(index)}
            className="text-theme-text-secondary hover:text-red-400 p-1 opacity-0 group-hover:opacity-100 transition-all"
          >
            <Trash size={15} />
          </button>
        </div>
      ))}
      <button
        onClick={onAdd}
        className="flex items-center gap-1.5 text-theme-text-secondary hover:text-white text-xs px-1 py-1 transition-colors"
      >
        <Plus size={13} weight="bold" />
        Hinzufügen
      </button>
    </div>
  );
}

function WidgetPreview({ config, logoPreview }) {
  // key: Startzustand geändert -> Vorschau neu mit diesem Zustand
  if (config.displayMode === "inline")
    return (
      <InlinePreview
        key={config.inlineStartState || "collapsed"}
        config={config}
        logoPreview={logoPreview}
      />
    );
  return <BubblePreview config={config} logoPreview={logoPreview} />;
}

// Mock-Vorschau Inline-Modus: angedeutete Webseite, darin die Leiste
// (eingeklappt) bzw. die aufgeklappte Chat-Box. Klick schaltet um.
function InlinePreview({ config, logoPreview }) {
  const [expanded, setExpanded] = useState(
    config.inlineStartState === "expanded"
  );

  const accentColor = config.accentColor || "#607D8B";
  const name = config.name || "Ihr Online-Berater";
  const logoSrc = logoPreview || DEFAULT_LOGO;
  const greeting =
    config.greeting ||
    "Hallo und herzlich willkommen! Wie kann ich Ihnen helfen?";
  const placeholder = config.sendMessageText || "Wie kann ich Ihnen helfen?";
  const barText =
    (config.inlineCollapsedText || "").trim() || DEFAULT_INLINE_TEXT;
  const dark = config.inlineTheme === "dark";
  const match = CHAT_ICONS.find((i) => i.id === config.chatIcon);
  const BarIcon = match ? match.Icon : ChatCircleDots;
  // Schrift der (Mock-)Webseite: Serif, damit "übernehmen" sichtbar wird
  const pageFont = "Georgia, 'Times New Roman', serif";
  const widgetFont = config.inheritFont === true ? pageFont : undefined;
  const maxWidth = normalizeCssLength(config.inlineMaxWidth, ["px"]);

  return (
    <div className="relative h-full w-full flex items-center justify-center p-8">
      <div
        className="w-full max-w-[640px] bg-white rounded-xl shadow-[0_8px_40px_rgba(0,0,0,0.10)] px-8 py-7 flex flex-col"
        style={{ fontFamily: pageFont, maxHeight: "calc(100vh - 200px)" }}
      >
        {/* angedeuteter Seiteninhalt */}
        <div className="text-[22px] text-gray-800 font-bold mb-2">
          Beratung &amp; Kontakt
        </div>
        <div className="space-y-1.5 mb-5">
          <div className="h-2.5 rounded bg-gray-200 w-11/12" />
          <div className="h-2.5 rounded bg-gray-200 w-9/12" />
        </div>

        <div
          className="w-full mx-auto"
          style={{
            // Max. Breite relativ zu einer typischen Inhaltsspalte
            maxWidth: maxWidth
              ? `${Math.min(
                  100,
                  (Math.max(INLINE_MIN_WIDTH_PX, parseFloat(maxWidth)) /
                    PREVIEW_CONTENT_WIDTH_PX) *
                    100
                )}%`
              : undefined,
          }}
        >
          {expanded ? (
            <div
              className="w-full rounded-2xl flex flex-col overflow-hidden bg-white border border-gray-300"
              style={{
                height: "380px",
                maxHeight: "calc(100vh - 360px)",
                boxShadow: "0 4px 14px rgba(0,0,0,0.12)",
                fontFamily: widgetFont,
              }}
            >
              <div
                className="flex items-center px-4 h-[56px] flex-shrink-0"
                style={{ borderBottom: "1px solid #E9E9E9" }}
              >
                <div className="flex items-center flex-1 gap-3 min-w-0">
                  <img
                    src={logoSrc}
                    alt="Logo"
                    className="h-9 w-9 rounded-lg object-contain flex-shrink-0"
                  />
                  <span className="text-gray-800 font-semibold text-sm truncate">
                    {name}
                  </span>
                </div>
                <div className="flex items-center gap-1.5 flex-shrink-0">
                  <DotsThreeOutlineVertical
                    size={18}
                    weight="fill"
                    className="text-slate-400"
                  />
                  <button
                    onClick={() => setExpanded(false)}
                    className="text-slate-400 hover:text-slate-600 transition-colors"
                    title="Einklappen"
                  >
                    <CaretUp size={18} weight="bold" />
                  </button>
                </div>
              </div>
              <div className="flex-1 flex flex-col items-center justify-center px-6 text-center text-gray-400 text-[13px] leading-relaxed">
                {greeting}
              </div>
              <div className="bg-white px-4 pb-3 pt-1 flex-shrink-0">
                <div
                  className="flex items-center w-full rounded-2xl"
                  style={{ border: "1.5px solid #22262833" }}
                >
                  <input
                    type="text"
                    placeholder={placeholder}
                    disabled
                    className="flex-1 bg-transparent text-[13px] text-black placeholder:text-slate-800/50 outline-none py-2.5 px-3.5"
                  />
                  <PaperPlaneRight
                    size={18}
                    weight="fill"
                    className="text-[#222628]/35 mr-3 flex-shrink-0"
                  />
                </div>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="w-full flex items-center gap-3.5 rounded-2xl px-4 py-3 text-left transition-opacity hover:opacity-95"
              style={{
                fontFamily: widgetFont,
                ...(dark
                  ? {
                      backgroundColor: "rgba(17, 24, 39, 0.78)",
                      color: "#FFFFFF",
                      border: "1px solid rgba(255,255,255,0.16)",
                      boxShadow: "0 4px 16px rgba(0,0,0,0.18)",
                    }
                  : {
                      backgroundColor: "#FFFFFF",
                      color: "#1f2937",
                      border: "1px solid #d1d5db",
                      boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
                    }),
              }}
            >
              <span
                className="w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0"
                style={{
                  backgroundColor: accentColor,
                  boxShadow: dark
                    ? "0 0 0 2px rgba(255,255,255,0.28)"
                    : undefined,
                }}
              >
                <BarIcon size={20} weight="fill" color="#ffffff" />
              </span>
              <span className="flex-1 min-w-0 text-[15px] font-semibold break-words">
                {barText}
              </span>
              <CaretDown size={16} weight="bold" className="opacity-60" />
            </button>
          )}
        </div>

        <div className="space-y-1.5 mt-5">
          <div className="h-2.5 rounded bg-gray-200 w-10/12" />
          <div className="h-2.5 rounded bg-gray-200 w-7/12" />
        </div>
        <p
          className="text-[11px] text-gray-400 mt-4 select-none"
          style={{ fontFamily: "inherit" }}
        >
          Vorschau — Klicken zum {expanded ? "Einklappen" : "Aufklappen"}. Mobil
          (unter 768px) öffnet die Leiste den Chat immer im Vollbild.
        </p>
      </div>
    </div>
  );
}

function BubblePreview({ config, logoPreview }) {
  const [previewOpen, setPreviewOpen] = useState(true);
  const accentColor = config.accentColor || "#607D8B";
  const name = config.name || "Ihr Online-Berater";
  const logoSrc = logoPreview || DEFAULT_LOGO;
  const greeting =
    config.greeting ||
    "Hallo und herzlich willkommen! Wie kann ich Ihnen helfen?";
  const placeholder = config.sendMessageText || "Wie kann ich Ihnen helfen?";

  const isLeft = config.position?.includes("left");
  const bubbles = config.chatbotBubblesMessages?.filter((m) => m.trim()) || [];
  const btnAlign = isLeft ? "self-start" : "self-end";

  return (
    <div className="relative h-full w-full flex items-center justify-center">
      <div className="w-[370px] flex flex-col items-stretch">
      {/* Chat Window Area — fixed height container so button doesn't shift */}
      <div className="flex flex-col justify-end" style={{ height: "540px", maxHeight: "calc(100vh - 200px)" }}>
      {previewOpen ? (
        <div
          className="w-full h-full rounded-2xl flex flex-col overflow-hidden bg-white"
          style={{
            boxShadow: "0 8px 40px rgba(0,0,0,0.12), 0 2px 8px rgba(0,0,0,0.08)",
          }}
        >
          {/* Header */}
          <div
            className="flex items-center px-4 h-[64px] flex-shrink-0"
            style={{ borderBottom: "1px solid #E9E9E9" }}
          >
            <div className="flex items-center flex-1 gap-3 min-w-0">
              <img
                src={logoSrc}
                alt="Logo"
                className="h-10 w-10 rounded-lg object-contain flex-shrink-0"
              />
              <span className="text-gray-800 font-semibold text-sm truncate">{name}</span>
            </div>
            <div className="flex items-center gap-1.5 flex-shrink-0">
              <DotsThreeOutlineVertical size={18} weight="fill" className="text-slate-400" />
              <button onClick={() => setPreviewOpen(false)} className="text-slate-400 hover:text-slate-600 transition-colors">
                <X size={18} weight="bold" />
              </button>
            </div>
          </div>

          {/* Sample user bubble — fester Vorschau-Streifen unter dem Header */}
          <div className="flex justify-end px-2 py-2 bg-white flex-shrink-0">
            <div
              className="py-1.5 px-3 rounded-t-[18px] rounded-bl-[18px] rounded-br-[4px] mr-[20px] text-xs font-sans shadow-[0_2px_8px_rgba(0,0,0,0.1)]"
              style={{ backgroundColor: accentColor, color: config.userTextColor || "#FFFFFF" }}
            >
              Hallo
            </div>
          </div>

          {/* Chat Area — scrollable, hidden scrollbar (matches embed widget) */}
          <div className="flex-1 flex flex-col px-2 bg-white overflow-y-auto no-scroll py-4">
            <div className="flex flex-col items-center my-auto">
              <div className="text-center text-gray-400 text-[13px] px-2 mb-4 leading-relaxed">
                {greeting}
              </div>
              {config.defaultMessages?.length > 0 && (
                <div className="flex flex-col gap-2 w-[75%]">
                  {config.defaultMessages
                    .filter((m) => m.trim())
                    .map((msg, i) => (
                      <div
                        key={i}
                        className="rounded-xl px-5 py-3 text-[13px] text-center font-medium"
                        style={{ backgroundColor: accentColor, color: config.userTextColor || "#FFFFFF" }}
                      >
                        {msg}
                      </div>
                    ))}
                </div>
              )}
            </div>
          </div>

          {/* Input */}
          <div className="bg-white px-4 pb-3 pt-1 flex-shrink-0">
            <div
              className="flex items-center w-full rounded-2xl"
              style={{ border: "1.5px solid #22262833" }}
            >
              <input
                type="text"
                placeholder={placeholder}
                disabled
                className="flex-1 bg-transparent text-[13px] text-black placeholder:text-slate-800/50 outline-none py-3 px-3.5"
              />
              <Microphone size={20} weight="fill" className="text-[#222628]/35 mr-1.5 flex-shrink-0" />
              <PaperPlaneRight size={20} weight="fill" className="text-[#222628]/35 mr-3 flex-shrink-0" />
            </div>
          </div>
        </div>
      ) : (
        /* Willkommensblasen — only when closed, inside same fixed-height container */
        bubbles.length > 0 ? (
          <div className={`w-[300px] flex flex-col gap-2 mt-auto ${isLeft ? "self-start" : "self-end"}`}>
            {bubbles.map((msg, i) => (
              <div
                key={i}
                className="bg-white rounded-2xl px-4 py-2.5 text-[13px] text-gray-700 w-full"
                style={{ boxShadow: "0 2px 12px rgba(0,0,0,0.1)" }}
              >
                {msg}
              </div>
            ))}
          </div>
        ) : null
      )}
      </div>

      {/* Chat Button + Hint — directly below chat window, respects position */}
      <div className={`flex items-center gap-3 mt-4 ${isLeft ? "self-start" : "self-end flex-row-reverse"}`}>
        <div
          className="w-12 h-12 rounded-full flex items-center justify-center text-white cursor-pointer transition-transform hover:scale-110 flex-shrink-0"
          style={{
            backgroundColor: accentColor,
            boxShadow: `0 4px 14px ${accentColor}40`,
          }}
          onClick={() => setPreviewOpen(!previewOpen)}
        >
          {(() => {
            const match = CHAT_ICONS.find((i) => i.id === config.chatIcon);
            const BtnIcon = match ? match.Icon : ChatCircleDots;
            return <BtnIcon size={24} weight="fill" color="#ffffff" />;
          })()}
        </div>
        <span
          className="text-xs text-gray-500 select-none whitespace-nowrap cursor-pointer hover:text-gray-700 transition-colors"
          onClick={() => setPreviewOpen(!previewOpen)}
        >
          Klicken zum {previewOpen ? "Schließen" : "Öffnen"}
        </span>
      </div>
      </div>
    </div>
  );
}
