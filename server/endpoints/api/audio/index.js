const { getSTTProvider, isSTTConfigured } = require("../../../utils/SpeechToText");
const multer = require("multer");
const { validApiKey } = require("../../../utils/middleware/validApiKey");

// Configure multer for file uploads (in-memory storage)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 25 * 1024 * 1024, // 25MB limit (Whisper API limit)
  },
  fileFilter: (req, file, cb) => {
    // Accept common audio formats
    const allowedMimes = [
      "audio/wav",
      "audio/mpeg",
      "audio/mp3",
      "audio/mp4",
      "audio/m4a",
      "audio/webm",
      "audio/ogg",
      "audio/flac",
      "audio/x-wav",
    ];
    if (allowedMimes.includes(file.mimetype) || file.originalname.match(/\.(wav|mp3|m4a|mp4|webm|ogg|flac)$/i)) {
      cb(null, true);
    } else {
      cb(new Error("Invalid audio file type"), false);
    }
  },
});

function audioEndpoints(app) {
  if (!app) return;

  /**
   * POST /api/audio/transcribe
   * Transcribes audio file to text using configured STT provider
   *
   * Request: multipart/form-data with "file" field containing audio
   * Response: { success: true, text: "transcribed text" }
   */
  // Kufer-Fork: Wie jede Route der Entwickler-API nur mit API-Schlüssel. Ohne ihn konnte jeder
  // anonym über den STT-Anbieter der Instanz transkribieren (Review PR #78, S1, 11.11.2026).
  app.post(
    "/api/audio/transcribe",
    [validApiKey, upload.single("file")],
    async (req, res) => {
      try {
        // Check if STT is configured
        if (!isSTTConfigured()) {
          return res.status(400).json({
            success: false,
            error: "Speech-to-Text is not configured. Please configure an STT provider in settings.",
          });
        }

        // Check if file was uploaded
        if (!req.file) {
          return res.status(400).json({
            success: false,
            error: "No audio file provided. Please upload an audio file.",
          });
        }

        // Get STT provider and transcribe
        const sttProvider = getSTTProvider();
        if (!sttProvider) {
          return res.status(500).json({
            success: false,
            error: "Failed to initialize STT provider.",
          });
        }

        const result = await sttProvider.transcribe(req.file.buffer, { filename: req.file.originalname });

        if (result.error) {
          return res.status(500).json({
            success: false,
            error: result.error,
          });
        }

        return res.status(200).json({
          success: true,
          text: result.text,
        });
      } catch (error) {
        console.error("[Audio Transcribe]", error);
        return res.status(500).json({
          success: false,
          error: error.message || "An error occurred during transcription.",
        });
      }
    }
  );

  /**
   * GET /api/audio/stt-status
   * Returns STT configuration status
   */
  app.get("/api/audio/stt-status", [validApiKey], async (req, res) => {
    try {
      const configured = isSTTConfigured();
      const provider = process.env.STT_PROVIDER || "native";

      return res.status(200).json({
        success: true,
        configured,
        provider,
      });
    } catch (error) {
      console.error("[STT Status]", error);
      return res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  });
}

module.exports = { audioEndpoints };
