const { v4: uuidv4 } = require("uuid");
const { reqBody, multiUserMode } = require("../../utils/http");
const { Telemetry } = require("../../models/telemetry");
const { streamChatWithForEmbed } = require("../../utils/chats/embed");
const { EmbedChats } = require("../../models/embedChats");
const {
  validEmbedConfig,
  canRespond,
  setConnectionMeta,
} = require("../../utils/middleware/embedMiddleware");
const { EmbedConfig } = require("../../models/embedConfig");
const {
  fetchEmbedLogo,
  determineEmbedLogoFilepath,
} = require("../../utils/files/embedLogo");
const {
  convertToChatHistory,
  writeResponseChunk,
} = require("../../utils/helpers/chat/responses");
const { getTTSProvider, isTTSConfigured } = require("../../utils/TextToSpeech");
const { getSTTProvider, isSTTConfigured } = require("../../utils/SpeechToText");
const multer = require("multer");
const {
  applyEmbedStandards,
  embedDisplayMode,
  courseCountModeValue,
  courseCountWord,
} = require("../../utils/chats/embedStandards");
const { courseCountField } = require("../../utils/chats/courseInventory");
const {
  embedDefaultsLanguage,
  defaultSuggestions,
} = require("../../utils/chats/embedDefaults");

// Configure multer for audio file uploads (store in memory)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 25 * 1024 * 1024, // 25MB max file size
  },
  fileFilter: (req, file, cb) => {
    // Accept common audio formats
    const allowedMimes = [
      "audio/webm",
      "audio/wav",
      "audio/wave",
      "audio/x-wav",
      "audio/mpeg",
      "audio/mp3",
      "audio/mp4",
      "audio/m4a",
      "audio/ogg",
      "audio/flac",
      "audio/x-flac",
    ];
    if (allowedMimes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(
        new Error(
          `Unsupported audio format: ${file.mimetype}. Supported formats: webm, wav, mp3, mp4, m4a, ogg, flac`
        ),
        false
      );
    }
  },
});

// Kufer Design Center: Whitelist-Validierung der visual_config-Felder, die
// noch frei wählbar sind, bevor sie ans (öffentliche) Widget gehen. Die Werte
// landen dort in style/CSS bzw. als Text — daher nur Enums, kurzer Text und
// geprüfter Link. Ungültig -> Feld weglassen (Widget nutzt dann seinen
// Default). Alle übrigen Darstellungs-Schlüssel sind seit dem vereinfachten
// Design Center (15.10.2026) fest: applyEmbedStandards
// (utils/chats/embedStandards.js) entfernt Altwerte und setzt die Standards.
const LAYOUT_ENUMS = {
  displayMode: ["bubble", "inline"],
  // Farbschema des Fensters und der Inline-Leiste (Hell/Dunkel; "auto" aus
  // älteren Konfigurationen bleibt gültig)
  theme: ["light", "dark", "auto"],
};

// Text-Schlüssel mit Höchstlänge wie im Widget (utils/layout.js). Wert wird
// getrimmt; zu lang -> weglassen (nicht kürzen). Leer ("") geht als leerer
// Wert mit: Untertitel "" = bewusst kein Untertitel (R5, Fixliste 7.22-rc8,
// wie privacyTitle), fehlender Wert = Standard des Widgets („Online-Berater
// mit künstlicher Intelligenz“). Begrüßung, Platzhalter und Datenschutz-
// Texte prüft applyEmbedStandards.
const WIDGET_TEXT_MAX = {
  assistantSubtitle: 60,
};
// privacyUrl wie safeUrl() im Widget
const URL_MAX_LEN = 512;

// Link (Datenschutz) wie safeUrl() im Widget: absolute https-URL oder Pfad
// der eigenen Seite ("/…", nicht "//…"), ohne Leer-/Steuerzeichen, höchstens
// URL_MAX_LEN Zeichen. Sonst null (-> weglassen).
function validUrl(value) {
  if (typeof value !== "string") return null;
  const v = value.trim();
  // Backslash überall verboten: Browser lesen "/\\host" wie "//host" (fremder Host)
  // eslint-disable-next-line no-control-regex
  if (!v || v.length > URL_MAX_LEN || /[\s\u0000-\u001f\u007f\\]/.test(v))
    return null;
  if (/^\/(?![\/\\])/.test(v)) return v;
  try {
    return new URL(v).protocol === "https:" ? v : null;
  } catch (e) {
    return null;
  }
}

// Schrift auf der Kundenfarbe (Entscheidung E1, Fixliste 7.22-rc7):
// „Schwarz“ wird als #222628 gespeichert und ausgeliefert. Ein früher
// gespeichertes reines Schwarz (#000000) liefert der Server ebenfalls als
// #222628 aus, passend zur Schrift der Antworten; gespeichert bleibt es
// unverändert. Empfehlung und Warnung im Design Center und im Widget rechnen
// mit dieser gezeigten Farbe (contrast.js SHOWN_BLACK, widgetKeys.js
// LEGACY_USER_TEXT_COLORS).
const SHOWN_BLACK = "#222628";
const LEGACY_USER_TEXT_COLORS = Object.freeze({ "#000000": SHOWN_BLACK });
function shownUserTextColor(value) {
  if (typeof value !== "string") return value;
  // nur eigene Schlüssel (C1, Fixliste 7.22-rc13): „__proto__“ oder
  // „constructor“ als gespeicherter Wert liefern nicht Object.prototype
  const key = value.trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(LEGACY_USER_TEXT_COLORS, key)
    ? LEGACY_USER_TEXT_COLORS[key]
    : value;
}

/**
 * Gespeicherte Liste (Startvorschläge, Willkommensblasen) für /config:
 * getrimmte, nicht leere Strings, Kommas bleiben im Eintrag (E11, Fixliste
 * 7.22-rc13: die Listen gehen als JSON-Array ans Widget, nicht mehr
 * kommagetrennt). Kein Array = nichts gespeichert (null).
 * @param {*} value
 * @returns {string[]|null}
 */
function savedList(value) {
  if (!Array.isArray(value)) return null;
  return value
    .filter((m) => typeof m === "string" && m.trim().length > 0)
    .map((m) => m.trim());
}

function mapLayoutConfig(visualConfig = {}) {
  const out = {};
  for (const [key, allowed] of Object.entries(LAYOUT_ENUMS)) {
    const v = visualConfig[key];
    if (typeof v !== "string") continue;
    const normalized = v.trim().toLowerCase(); // wie Widget: case-insensitiv
    if (allowed.includes(normalized)) out[key] = normalized;
  }
  for (const [key, maxLen] of Object.entries(WIDGET_TEXT_MAX)) {
    const v = visualConfig[key];
    if (typeof v !== "string") continue;
    const text = v.trim();
    if (text.length <= maxLen) out[key] = text;
  }
  const privacyUrl = validUrl(visualConfig.privacyUrl);
  if (privacyUrl !== null) out.privacyUrl = privacyUrl;
  return out;
}

/**
 * Gespeicherte visual_config für GET /embed/:id/config. Die Middleware hat
 * die Zeile schon geladen (response.locals.embedConfig); ihr Wert wird
 * gelesen, statt die Datenbank ein zweites Mal zu fragen. Nur wenn die Zeile
 * keinen visual_config-Eintrag mitbringt, fragt EmbedConfig.getVisualConfig.
 * ok false: gespeicherter Wert nicht lesbar (kein JSON-Objekt); die Antwort
 * enthält dann nur die Standards und darf nicht zwischengespeichert werden
 * (Review F06: sonst gälte ein vorübergehender Fehler 5 Minuten lang).
 * @param {{uuid: string, visual_config?: string|object|null}} embed
 * @returns {Promise<{config: Object, ok: boolean}>}
 */
async function storedVisualConfig(embed) {
  if (!embed || !("visual_config" in embed))
    return {
      config: (await EmbedConfig.getVisualConfig(embed?.uuid)) || {},
      ok: true,
    };
  let value = embed.visual_config;
  if (value === null || value === undefined || value === "")
    return { config: {}, ok: true };
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch (e) {
      console.error("[Embed Config] visual_config unparsable", e.message);
      return { config: {}, ok: false };
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    return { config: {}, ok: false };
  return { config: value, ok: true };
}

function embeddedEndpoints(app) {
  if (!app) return;

  // Public endpoint: Get visual configuration for an embed widget
  app.get(
    "/embed/:embedId/config",
    [validEmbedConfig],
    async (request, response) => {
      try {
        const embed = response.locals.embedConfig;
        const { config: visualConfig, ok } = await storedVisualConfig(embed);

        // Map simplified fields to widget data-attributes
        const mapped = {};
        if (visualConfig.accentColor) {
          mapped.buttonColor = visualConfig.accentColor;
          mapped.userBgColor = visualConfig.accentColor;
          mapped.linkColor = visualConfig.accentColor;
        }
        if (visualConfig.userTextColor)
          mapped.userTextColor = shownUserTextColor(visualConfig.userTextColor);
        if (visualConfig.name) {
          mapped.brandText = visualConfig.name;
          mapped.assistantName = visualConfig.name;
        }
        if (visualConfig.chatIcon) mapped.chatIcon = visualConfig.chatIcon;
        if (visualConfig.position) mapped.position = visualConfig.position;
        // greeting/sendMessageText: applyEmbedStandards (Begrüßung und
        // Platzhalter ohne frühere Vorbelegungen)
        if (visualConfig.supportEmail)
          mapped.supportEmail = visualConfig.supportEmail;
        // KIE-503: "Frühere Chats" pro Embed abschaltbar (Widget-Einstellungen,
        // Spalte embed_configs.history_enabled). NULL = an (Bestands-Embeds),
        // nur explizites false wird ans Widget gemeldet.
        if (embed.history_enabled === false) mapped.historyEnabled = false;

        // Startvorschläge (S1 Fixliste 7.22-rc10, Vertrag mit dem Widget
        // nach E10 bis E12 der Fixliste 7.22-rc13, Vorrang nach E10 neu und
        // E23 der Fixliste 7.22-rc17), immer als JSON-Array:
        // - gespeicherte Liste: bereinigt (savedList), Einträge mit Komma
        //   bleiben ganz (E11);
        // - gespeichertes [] (oder nur leere Zeilen): [] mit
        //   defaultMessagesSaved: true, das Widget zeigt dann keine Pillen;
        // - nichts gespeichert (kein Array): die Standard-Startvorschläge der
        //   Sprache mit defaultMessagesStandard: true; seit E42 (7.22-rc23,
        //   Nutzerentscheidung 22.10.2026) ist der Standard in jeder Sprache
        //   leer, also [] mit dem Kennzeichen (Widget ohne Pillen). Widgets bis
        //   7.22-rc16 ließen an diesem Kennzeichen data-default-messages vor
        //   den Standard; das Widget ab 7.22-rc17 wertet es nicht aus und
        //   entfernt es. Es bleibt für ältere Widget-Kopien und einen
        //   stabilen Vertrag (F52, Fixliste 7.22-rc18 C21). Die Sprache
        //   schickt das Widget als ?language= mit (seine Sprache aus
        //   data-language, E12); fehlend oder unbekannt -> de.
        // Vorrang im Widget: gespeichert (auch leer) vor Standard. Die
        // Startvorschläge stellt das Design Center ein (Gruppe A, E23): ein
        // data-default-messages am Skript wirkt nicht, auch wenn nichts
        // gespeichert ist.
        // Fixture des Vertrags: __tests__/utils/chats/fixtures/
        // embedConfigContract.json, Test __tests__/endpoints/
        // embedConfigContract.test.js (Gegenprobe mit KUFER_EMBED_DIR).
        const suggestions = savedList(visualConfig.defaultMessages);
        if (suggestions === null) {
          mapped.defaultMessages = defaultSuggestions(
            embedDefaultsLanguage(request.query?.language)
          );
          mapped.defaultMessagesStandard = true;
        } else {
          mapped.defaultMessages = suggestions;
          if (suggestions.length === 0) mapped.defaultMessagesSaved = true;
        }
        // Willkommensblasen: nur eine gespeicherte, nicht leere Liste (leer
        // = Standardblasen des Widgets, wie im Design Center), als Array
        const bubbles = savedList(visualConfig.chatbotBubblesMessages);
        if (bubbles !== null && bubbles.length > 0)
          mapped.chatbotBubblesMessages = bubbles;

        // Darstellung (Blase/Inline), Farbschema, Untertitel, Datenschutz-
        // Link — nur validierte Werte ausliefern, ungültige Felder weglassen.
        Object.assign(mapped, mapLayoutConfig(visualConfig));

        // KIE-576 Paket 3: Kursanzahl im Untertitel nach Vertrag
        // (issues/KIE-576/KIE-576-kursanzahl.md): courseCount {count,
        // offered, stand, word} nur mit Anzeige an (courseCountMode, Standard
        // an), gültigem Kursbestand der Pipeline (courseInventory.js) und
        // count ≥ 1; count = Kurse im Feed und im Workspace (nie mehr,
        // NAK-K3). Sonst fehlt das Feld ganz. Der Untertitel geht unverändert mit (NAK-K5):
        // Das Widget zeigt ihn, sobald courseCount fehlt oder stand älter als
        // 24 h ist.
        const courseCount = await courseCountField(embed.workspace, {
          mode: courseCountModeValue(visualConfig.courseCountMode),
          word: courseCountWord(
            visualConfig.courseCountWord,
            embedDefaultsLanguage(request.query?.language)
          ),
        });
        if (courseCount) mapped.courseCount = courseCount;

        // Logo: serve from upload endpoint or use URL
        if (visualConfig.logoFilename) {
          const { embedId } = request.params;
          const baseUrl = `${request.protocol}://${request.get("host")}`;
          const logoUrl = `${baseUrl}/api/embed/${embedId}/logo`;
          mapped.brandImageUrl = logoUrl;
          mapped.assistantIcon = logoUrl;
        } else if (visualConfig.logoUrl) {
          mapped.brandImageUrl = visualConfig.logoUrl;
          mapped.assistantIcon = visualConfig.logoUrl;
        }

        // Feste Standards (Design Center vereinfacht): Altwerte entfallener
        // Optionen ignorieren, Begrüßung/Platzhalter/Datenschutz-Text aus den
        // gespeicherten Texten, feste Werte erzwingen.
        response.setHeader(
          "Cache-Control",
          ok ? "public, max-age=300" : "no-store"
        );
        response.status(200).json(applyEmbedStandards(mapped, visualConfig));
      } catch (e) {
        console.error("[Embed Config]", e.message);
        // auch im Fehlerfall die festen Standards (kein Widget ohne
        // KI-Hinweis, keine alten Optionen), aber nicht zwischenspeichern:
        // Der nächste Aufruf soll wieder die gespeicherten Werte liefern.
        response.setHeader("Cache-Control", "no-store");
        response.status(200).json(applyEmbedStandards({}, {}));
      }
    }
  );

  // Public endpoint: Serve embed logo image
  app.get(
    "/embed/:embedId/logo",
    [validEmbedConfig],
    async (request, response) => {
      try {
        const embed = response.locals.embedConfig;
        const logoPath = await determineEmbedLogoFilepath(embed.id);
        if (!logoPath) {
          response.sendStatus(404).end();
          return;
        }

        const { found, buffer, size, mime } = fetchEmbedLogo(logoPath);
        if (!found) {
          response.sendStatus(404).end();
          return;
        }

        response.writeHead(200, {
          "Content-Type": mime,
          "Content-Length": size,
          "Cache-Control": "public, max-age=3600",
        });
        response.end(buffer);
      } catch (e) {
        console.error("[Embed Logo]", e.message);
        response.sendStatus(500).end();
      }
    }
  );

  app.post(
    "/embed/:embedId/stream-chat",
    [validEmbedConfig, setConnectionMeta, canRespond],
    async (request, response) => {
      try {
        const embed = response.locals.embedConfig;
        const {
          sessionId,
          message,
          conversationId = null, // NEW: Conversation ID from widget
          // optional keys for override of defaults if enabled.
          prompt = null,
          model = null,
          temperature = null,
          username = null,
          // Tatsächliche Darstellung des Widgets ("inline"|"bubble"), vom
          // Widget mit jeder Anfrage geschickt. Nur für den Standard von
          // „Antworten mit Kursen“ ohne gespeicherte Wahl (R4, Fixliste
          // 7.22-rc8); ungültig oder fehlend zählt als Chatfenster.
          displayMode = null,
        } = reqBody(request);

        // Fallback: If no conversationId, use sessionId for backwards compatibility
        const effectiveConversationId = conversationId || sessionId;

        response.setHeader("Cache-Control", "no-cache");
        response.setHeader("Content-Type", "text/event-stream");
        response.setHeader("Access-Control-Allow-Origin", "*");
        response.setHeader("Connection", "keep-alive");
        response.flushHeaders();

        await streamChatWithForEmbed(response, embed, message, sessionId, {
          conversationId: effectiveConversationId, // Pass conversation ID
          promptOverride: prompt,
          modelOverride: model,
          temperatureOverride: temperature,
          username,
          displayMode: embedDisplayMode(displayMode),
        });
        await Telemetry.sendTelemetry("embed_sent_chat", {
          multiUserMode: multiUserMode(response),
          LLMSelection: process.env.LLM_PROVIDER || "openai",
          Embedder: process.env.EMBEDDING_ENGINE || "inherit",
          VectorDbSelection: process.env.VECTOR_DB || "lancedb",
        });
        response.end();
      } catch (e) {
        console.error(e);
        writeResponseChunk(response, {
          id: uuidv4(),
          type: "abort",
          sources: [],
          textResponse: null,
          close: true,
          error: e.message,
        });
        response.end();
      }
    }
  );

  // Endpoint to check if embed is enabled (for widget hide/show)
  app.get(
    "/embed/:embedId/status",
    [validEmbedConfig],
    async (request, response) => {
      try {
        const embed = response.locals.embedConfig;
        response.status(200).json({ enabled: embed.enabled });
      } catch (e) {
        console.error(e.message, e);
        // On error, return enabled=true so widget still shows
        response.status(200).json({ enabled: true });
      }
    }
  );

  // KIE-503: Konversationsliste einer Widget-Session ("Frühere Chats").
  // BOLA/IDOR-Härtung (analog KIE-505): das Model bindet die Liste an embed_id
  // UND die sessionId aus dem Pfad — es sind nur eigene Konversationen sichtbar.
  // Hinweis zur Platzierung: diese 3-Segment-Route kollidiert NICHT mit der
  // generischen 2-Segment-Route GET /embed/:embedId/:sessionId (Express matcht
  // strikt nach Segmentanzahl) — sie steht nur der Lesbarkeit halber davor.
  app.get(
    "/embed/:embedId/:sessionId/conversations",
    [validEmbedConfig],
    async (request, response) => {
      try {
        const { sessionId } = request.params;
        const embed = response.locals.embedConfig;

        const conversations = await EmbedChats.listConversationsForSession(
          embed.id,
          sessionId
        );
        response.status(200).json({ conversations });
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500).end();
      }
    }
  );

  app.get(
    "/embed/:embedId/:sessionId",
    [validEmbedConfig],
    async (request, response) => {
      try {
        const { sessionId } = request.params;
        const { conversationId } = request.query; // Optional query param for conversation_id
        const embed = response.locals.embedConfig;

        // Use conversationId if provided, otherwise fallback to sessionId
        const identifier = conversationId || sessionId;
        const identifierType = conversationId
          ? "conversation_id"
          : "session_id";

        const history = await EmbedChats.forEmbedByUser(
          embed.id,
          identifier,
          null,
          null,
          identifierType,
          sessionId // BOLA/IDOR hardening (KIE-505): bind conversation to owning session
        );

        // Kontext-Schnipsel (sources) nie an Endnutzer: vor der Ausgabe
        // entfernen; courseSources (nur Kurs-Metadaten) bleibt für die
        // Kurskarten erhalten.
        response.status(200).json({
          history: convertToChatHistory(EmbedChats.filterSources(history)),
        });
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500).end();
      }
    }
  );

  app.delete(
    "/embed/:embedId/:sessionId",
    [validEmbedConfig],
    async (request, response) => {
      try {
        const { sessionId } = request.params;
        const { conversationId } = request.query; // Optional query param for conversation_id
        const embed = response.locals.embedConfig;

        // Use conversationId if provided, otherwise fallback to sessionId
        const identifier = conversationId || sessionId;
        const identifierType = conversationId
          ? "conversation_id"
          : "session_id";

        await EmbedChats.markHistoryInvalid(
          embed.id,
          identifier,
          identifierType,
          sessionId // BOLA/IDOR hardening (KIE-505): bind conversation to owning session
        );
        response.status(200).end();
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500).end();
      }
    }
  );

  // KIE-504: Bewertung (👍/👎) einer einzelnen Bot-Antwort setzen/entfernen.
  // feedback: true = 👍, false = 👎, null = Bewertung entfernen (Toggle).
  // BOLA/IDOR-Härtung (analog KIE-505): die chatId wird im Model an embed_id UND
  // die sessionId aus dem Pfad gebunden — eine geleakte chatId reicht nicht.
  // KIE-532: Der Endpunkt ist öffentlich und jede gebuchte Bewertung belegt die
  // Reihe der Zählerbuch-Transaktionen. chatId muss deshalb eine positive ganze
  // Zahl sein (sonst 400, ohne Datenbankzugriff). Zu viele Bewertungen einer
  // Sitzung bzw. eine volle Reihe meldet das Model; die Antwort ist dann 429.
  app.post(
    "/embed/:embedId/:sessionId/feedback",
    [validEmbedConfig],
    async (request, response) => {
      try {
        const { sessionId } = request.params;
        // KIE-507: comment (Freitext) + reason (1-Klick-Grund) sind optional.
        const { chatId, feedback = null, comment, reason } = reqBody(request);
        const embed = response.locals.embedConfig;

        if (chatId === undefined || chatId === null) {
          return response
            .status(400)
            .json({ success: false, error: "chatId is required." });
        }
        if (EmbedChats.parseChatId(chatId) === null) {
          return response.status(400).json({
            success: false,
            error: "chatId must be a positive integer.",
          });
        }
        // feedback muss true (👍), false (👎) oder null (entfernen) sein.
        if (feedback !== null && typeof feedback !== "boolean") {
          return response.status(400).json({
            success: false,
            error: "feedback must be true, false, or null.",
          });
        }
        // comment/reason (falls übergeben) müssen String oder null sein.
        for (const [key, val] of [
          ["comment", comment],
          ["reason", reason],
        ]) {
          if (val !== undefined && val !== null && typeof val !== "string") {
            return response.status(400).json({
              success: false,
              error: `${key} must be a string or null.`,
            });
          }
        }

        const outcome = await EmbedChats.applyFeedback(
          embed.id,
          sessionId,
          chatId,
          feedback,
          { feedbackText: comment, feedbackReason: reason }
        );
        if (outcome === "rate_limited" || outcome === "busy") {
          return response.status(429).json({
            success: false,
            error: "Too many feedback requests - try again later.",
          });
        }
        response.status(200).json({ success: outcome === "updated" });
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500).end();
      }
    }
  );

  // ============================================
  // Audio Endpoints for Embed Widget (STT/TTS)
  // ============================================

  /**
   * GET /embed/:embedId/audio/status
   * Returns whether STT and TTS are configured on the server
   */
  app.get(
    "/embed/:embedId/audio/status",
    [validEmbedConfig],
    async (request, response) => {
      try {
        response.status(200).json({
          stt: isSTTConfigured(),
          tts: isTTSConfigured(),
          sttProvider: process.env.STT_PROVIDER || "native",
          ttsProvider: process.env.TTS_PROVIDER || "native",
        });
      } catch (e) {
        console.error("[Embed Audio Status]", e.message);
        response.status(200).json({ stt: false, tts: false });
      }
    }
  );

  /**
   * POST /embed/:embedId/audio/tts
   * Converts text to speech using the configured TTS provider
   *
   * Request body: { text: "Text to speak" }
   * Response: Audio buffer (audio/mpeg)
   */
  app.post(
    "/embed/:embedId/audio/tts",
    [validEmbedConfig],
    async (request, response) => {
      try {
        const { text } = reqBody(request);

        if (!text || typeof text !== "string" || text.trim().length === 0) {
          return response.status(400).json({
            success: false,
            error: "No text provided for TTS.",
          });
        }

        if (!isTTSConfigured()) {
          return response.status(400).json({
            success: false,
            error: "TTS is not configured on this server.",
          });
        }

        const TTSProvider = getTTSProvider();
        if (!TTSProvider) {
          return response.status(500).json({
            success: false,
            error: "Failed to initialize TTS provider.",
          });
        }

        const audioBuffer = await TTSProvider.ttsBuffer(text);
        if (!audioBuffer) {
          return response.status(204).end(); // No content
        }

        // Detect audio format from buffer header
        let contentType = "audio/mpeg"; // default
        if (audioBuffer.length >= 4) {
          const header = audioBuffer.slice(0, 4).toString("hex");
          if (header.startsWith("52494646")) {
            // "RIFF" = WAV
            contentType = "audio/wav";
          } else if (header.startsWith("4f676753")) {
            // "OggS" = OGG
            contentType = "audio/ogg";
          } else if (header.startsWith("664c6143")) {
            // "fLaC" = FLAC
            contentType = "audio/flac";
          }
          // MP3 starts with FF FB, FF FA, FF F3, or ID3
        }

        response.writeHead(200, {
          "Content-Type": contentType,
          "Content-Length": audioBuffer.length,
        });
        response.end(audioBuffer);
      } catch (e) {
        console.error("[Embed TTS]", e.message);
        response.status(500).json({
          success: false,
          error: "TTS generation failed.",
        });
      }
    }
  );

  /**
   * POST /embed/:embedId/audio/tts-stream
   * Streams TTS audio as chunks for reduced latency
   *
   * Request body: { text: "Text to speak" }
   * Response: Streaming audio (chunked transfer encoding)
   */
  app.post(
    "/embed/:embedId/audio/tts-stream",
    [validEmbedConfig],
    async (request, response) => {
      try {
        const { text } = reqBody(request);

        if (!text || typeof text !== "string" || text.trim().length === 0) {
          return response.status(400).json({
            success: false,
            error: "No text provided for TTS.",
          });
        }

        if (!isTTSConfigured()) {
          return response.status(400).json({
            success: false,
            error: "TTS is not configured on this server.",
          });
        }

        const TTSProvider = getTTSProvider();
        if (!TTSProvider) {
          return response.status(500).json({
            success: false,
            error: "Failed to initialize TTS provider.",
          });
        }

        // Check if provider supports streaming
        if (typeof TTSProvider.ttsStream === "function") {
          // Get requested format from query param (mp3 default, webm for Firefox)
          const format = request.query.format === "webm" ? "webm" : "mp3";
          const contentType = format === "webm" ? "audio/webm" : "audio/mpeg";

          response.writeHead(200, {
            "Content-Type": contentType,
            "Transfer-Encoding": "chunked",
            "Cache-Control": "no-cache",
          });

          await TTSProvider.ttsStream(text, response, format);
          response.end();
        } else {
          // Fallback to non-streaming
          const audioBuffer = await TTSProvider.ttsBuffer(text);
          if (!audioBuffer) {
            return response.status(204).end();
          }

          response.writeHead(200, {
            "Content-Type": "audio/wav",
          });
          response.end(audioBuffer);
        }
      } catch (e) {
        console.error("[Embed TTS Stream]", e.message);
        if (!response.headersSent) {
          response.status(500).json({
            success: false,
            error: "TTS streaming failed.",
          });
        }
      }
    }
  );

  /**
   * POST /embed/:embedId/audio/stt
   * Transcribes audio to text using the configured STT provider
   *
   * Request: multipart/form-data with 'file' field containing audio
   * Optional query param: language (e.g., 'de', 'en')
   * Response: { success: true, text: "transcribed text" }
   */
  app.post(
    "/embed/:embedId/audio/stt",
    [validEmbedConfig, upload.single("file")],
    async (request, response) => {
      try {
        if (!isSTTConfigured()) {
          return response.status(400).json({
            success: false,
            error: "STT is not configured on this server.",
          });
        }

        if (!request.file) {
          return response.status(400).json({
            success: false,
            error: "No audio file provided.",
          });
        }

        const sttProvider = getSTTProvider();
        if (!sttProvider) {
          return response.status(500).json({
            success: false,
            error: "Failed to initialize STT provider.",
          });
        }

        // Get optional language hint from query params
        const language = request.query.language || null;

        // Derive filename from mimetype for proper content-type handling
        const mimeToExt = {
          "audio/webm": "webm",
          "audio/wav": "wav",
          "audio/wave": "wav",
          "audio/mpeg": "mp3",
          "audio/mp3": "mp3",
          "audio/mp4": "mp4",
          "audio/m4a": "m4a",
          "audio/ogg": "ogg",
          "audio/flac": "flac",
        };
        const ext = mimeToExt[request.file.mimetype] || "webm";
        const filename = `recording.${ext}`;

        console.log("[Embed STT] Processing audio:", {
          originalName: request.file.originalname,
          mimetype: request.file.mimetype,
          size: request.file.buffer?.length,
          filename,
        });

        // Transcribe the audio
        const result = await sttProvider.transcribe(request.file.buffer, {
          language,
          filename,
        });

        const text = result?.text || "";

        response.status(200).json({
          success: true,
          text: text.trim(),
        });
      } catch (e) {
        console.error("[Embed STT]", e.message);
        response.status(500).json({
          success: false,
          error: "Transcription failed.",
        });
      }
    }
  );
}

module.exports = { embeddedEndpoints };
