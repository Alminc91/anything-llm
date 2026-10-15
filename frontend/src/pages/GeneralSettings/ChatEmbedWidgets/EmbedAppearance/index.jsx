import { useEffect, useState, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ArrowLeft } from "@phosphor-icons/react";
import showToast from "@/utils/toast";
import CTAButton from "@/components/lib/CTAButton";
import Embed from "@/models/embed";
import paths from "@/utils/paths";
import { API_BASE } from "@/utils/constants";
import { embedLabels } from "@/utils/embedLabel";
import AppearanceTab from "./AppearanceTab";
import ContentTab from "./ContentTab";
import EmbedTab from "./EmbedTab";
import WidgetPreview from "./WidgetPreview";
import {
  FIELD_TAB,
  cleanConfig,
  greetingKey as storedGreetingKey,
  validateConfig,
  withChoice,
  withPrivacyNotice,
  withUserTextColor,
} from "./widgetKeys";

// Design Center (vereinfacht, 15./16.10.2026): Kunden stellen nur noch
// Aussehen und Inhalte ein; alle übrigen Darstellungs-Optionen sind fest
// eingebaut (Server: utils/chats/embedStandards.js). Gespeicherte Werte
// entfallener Optionen bleiben beim Speichern unverändert stehen.

// Bearbeitet wird genau die gespeicherte visual_config (Entscheidung D6):
// Fehlende Schlüssel zeigen die Reiter mit dem Standard des Widgets
// (widgetKeys.js LOOK_DEFAULTS, Kufer-Standardtexte aus GET /embed/defaults)
// bzw. als Vorschlag (Startvorschläge, Willkommensblasen, Untertitel), ohne
// sie in den Bearbeitungsstand zu schreiben. Gespeichert wird so nur, was
// der Kunde ändert oder als Vorschlag übernimmt; ein neues Widget ist beim
// Öffnen nicht „ungespeichert“.

const TABS = [
  { id: "aussehen", label: "Aussehen" },
  { id: "inhalt", label: "Inhalt" },
  { id: "einbau", label: "Einbau" },
];
const TAB_LABELS = Object.fromEntries(TABS.map((t) => [t.id, t.label]));

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

export default function EmbedAppearance() {
  const { embedId } = useParams();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [embed, setEmbed] = useState(null);
  // Alle Widgets, die der Nutzer sieht – nur für die Bezeichnung in der
  // Kopfzeile: Ob sie die Widget-Nummer braucht, hängt von den übrigen ab.
  const [embeds, setEmbeds] = useState([]);
  const [config, setConfig] = useState({});
  const [initialConfig, setInitialConfig] = useState({});
  const [activeTab, setActiveTab] = useState("aussehen");
  const [logoPreview, setLogoPreview] = useState(null);
  // Schlüssel des Begrüßungstexts (früherer Blasentext hat Vorrang), aus
  // dem gespeicherten Stand bestimmt
  const [greetingKey, setGreetingKey] = useState("greeting");
  // Kufer-Standardtexte (GET /embed/defaults); null = nicht (oder noch
  // nicht) geladen. defaultsError: Laden fehlgeschlagen -> nichts gilt als
  // Standard, „Standardtext“ ist deaktiviert.
  const [defaults, setDefaults] = useState(null);
  const [defaultsError, setDefaultsError] = useState(false);

  const hasChanges = stableStringify(config) !== stableStringify(initialConfig);

  useEffect(() => {
    async function load() {
      // Dieselbe Anfrage wie Embed.getEmbed() – die Liste wird hier behalten.
      const allEmbeds = (await Embed.embeds()) || [];
      const embedData = allEmbeds.find((e) => e.id === Number(embedId)) || null;
      if (!embedData) {
        showToast("Einbettung nicht gefunden.", "error");
        navigate(paths.settings.chatbot.widgets());
        return;
      }
      setEmbed(embedData);
      setEmbeds(allEmbeds);

      let visualConfig = {};
      if (embedData.visual_config) {
        try {
          const parsed = JSON.parse(embedData.visual_config);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
            visualConfig = parsed;
        } catch {}
      }
      // Gespeicherte Werte bleiben, wie sie sind; auch ein früheres #000000
      // als Schrift auf der Kundenfarbe wird nicht umgeschrieben (E1,
      // Fixliste 7.22-rc7). Es gilt als „Schwarz“ (#222628, wie der Server
      // es ausliefert), siehe widgetKeys.js storedUserTextColor.
      const loadedConfig = { ...visualConfig };
      setGreetingKey(storedGreetingKey(visualConfig));
      setInitialConfig(loadedConfig);
      setConfig(loadedConfig);

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

  // Standardtexte laden. Bis sie da sind bzw. bei Fehler bleiben Felder ohne
  // eigenen Text leer (Platzhalter) und nichts wird als Standard erkannt
  // (kein Text geht beim Speichern verloren).
  useEffect(() => {
    let cancelled = false;
    Embed.getDefaults("de").then(({ defaults, error }) => {
      if (cancelled) return;
      setDefaults(defaults);
      setDefaultsError(!!error);
      if (error)
        showToast(
          `Standardtexte konnten nicht geladen werden (${error}). Eigene Texte bleiben erhalten; „Standardtext“ ist deaktiviert.`,
          "error"
        );
    });
    return () => {
      cancelled = true;
    };
  }, []);

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

  // „Standardtext“: Schlüssel entfernen (der Standard gilt wieder)
  const resetKeys = useCallback((keys) => {
    setConfig((prev) => {
      const next = { ...prev };
      for (const key of keys) delete next[key];
      return next;
    });
  }, []);

  // Schalter „Datenschutz-Hinweis anzeigen“: aus = "none", wieder an = der
  // gespeicherte Stand bzw. "bubble" (widgetKeys.js withPrivacyNotice)
  const setPrivacyNotice = useCallback(
    (on) => setConfig((prev) => withPrivacyNotice(prev, initialConfig, on)),
    [initialConfig]
  );

  // Auswahl „Antworten mit Kursen“ (KIE-567) und „Willkommensblasen
  // anzeigen“ (KIE-568): gespeichert wird nur eine Abweichung vom
  // gespeicherten Stand (Regel D6, widgetKeys.js withChoice)
  const setChoice = useCallback(
    (key, value) =>
      setConfig((prev) => withChoice(prev, initialConfig, key, value)),
    [initialConfig]
  );

  // Schrift auf der Kundenfarbe: ein Klick auf die schon wirksame Option
  // (gespeichert oder empfohlen) ändert nichts (E1, widgetKeys.js
  // withUserTextColor)
  const setUserTextColor = useCallback(
    (value) =>
      setConfig((prev) => withUserTextColor(prev, initialConfig, value)),
    [initialConfig]
  );

  // Vorschlag übernehmen (Startvorschläge, Willkommensblasen, Untertitel):
  // erst damit wird er Teil des Bearbeitungsstands und beim Speichern
  // geschrieben
  const applySuggestion = (field, value) => {
    setConfig((prev) => ({
      ...prev,
      [field]: Array.isArray(value) ? [...value] : value,
    }));
  };

  const addListItem = (field) => {
    setConfig((prev) => ({
      ...prev,
      [field]: [...(Array.isArray(prev[field]) ? prev[field] : []), ""],
    }));
  };

  const updateListItem = (field, index, value) => {
    setConfig((prev) => {
      const updated = [...(Array.isArray(prev[field]) ? prev[field] : [])];
      updated[index] = value;
      return { ...prev, [field]: updated };
    });
  };

  const removeListItem = (field, index) => {
    setConfig((prev) => ({
      ...prev,
      [field]: (Array.isArray(prev[field]) ? prev[field] : []).filter(
        (_, i) => i !== index
      ),
    }));
  };

  const errors = validateConfig(config, initialConfig, greetingKey);

  const handleSave = async () => {
    const savedConfig = config;
    const firstError = Object.keys(errors)[0];
    if (firstError) {
      const tab = FIELD_TAB[firstError] || "inhalt";
      showToast(
        `Bitte die markierten Felder unter „${TAB_LABELS[tab]}“ korrigieren.`,
        "error"
      );
      setActiveTab(tab);
      return;
    }
    const cleanedConfig = cleanConfig(savedConfig, {
      initial: initialConfig,
      defaults,
      greetingKey,
    });
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
      setGreetingKey(storedGreetingKey(cleanedConfig));
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
            onClick={() => navigate(paths.settings.chatbot.widgets())}
            className="text-theme-text-secondary hover:text-white p-1.5 rounded-lg hover:bg-white/5 transition-colors"
          >
            <ArrowLeft size={20} />
          </button>
          <div>
            <h1 className="text-lg leading-6 font-bold text-white">
              Erscheinungsbild
            </h1>
            <p className="text-xs leading-[18px] font-base text-white text-opacity-60">
              {embedLabels(embeds, t).get(embed?.id)?.label}
            </p>
          </div>
        </div>
      </div>

      {/* Content: Settings left, Preview right */}
      <div className="flex flex-1 overflow-hidden flex-col md:flex-row">
        {/* Settings Panel */}
        <div className="w-full md:w-1/2 md:max-w-[600px] flex flex-col border-r border-white/10 min-h-0 flex-1 md:flex-none">
          {/* Tabs */}
          <div
            className="flex border-b border-white/10 px-5 pt-3"
            role="tablist"
          >
            {TABS.map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={activeTab === tab.id}
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
            {activeTab === "aussehen" && (
              <AppearanceTab
                config={config}
                updateField={updateField}
                setChoice={setChoice}
                setUserTextColor={setUserTextColor}
                logoPreview={logoPreview}
                onLogoUpload={handleLogoUpload}
                onLogoRemove={handleLogoRemove}
              />
            )}
            {activeTab === "inhalt" && (
              <ContentTab
                config={config}
                initialConfig={initialConfig}
                errors={errors}
                defaults={defaults}
                defaultsError={defaultsError}
                greetingKey={greetingKey}
                updateField={updateField}
                updateOptionalField={updateOptionalField}
                resetKeys={resetKeys}
                setPrivacyNotice={setPrivacyNotice}
                setChoice={setChoice}
                applySuggestion={applySuggestion}
                addListItem={addListItem}
                updateListItem={updateListItem}
                removeListItem={removeListItem}
              />
            )}
            {activeTab === "einbau" && (
              <EmbedTab config={config} embed={embed} />
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
                  type="button"
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

        {/* Live-Vorschau */}
        <div className="hidden md:flex flex-1 min-w-0">
          <WidgetPreview
            config={config}
            logoPreview={logoPreview}
            defaults={defaults}
            greetingKey={greetingKey}
          />
        </div>
      </div>
    </div>
  );
}
