// Use native FormData (Node 18+) instead of form-data package
// form-data package doesn't work well with native fetch()

class GenericOpenAiSTT {
  constructor() {
    if (!process.env.STT_OPEN_AI_COMPATIBLE_ENDPOINT)
      throw new Error(
        "No OpenAI compatible STT endpoint was set. Please set STT_OPEN_AI_COMPATIBLE_ENDPOINT to use this provider."
      );

    this.endpoint = process.env.STT_OPEN_AI_COMPATIBLE_ENDPOINT;
    this.apiKey = process.env.STT_OPEN_AI_COMPATIBLE_KEY || null;
    this.model = process.env.STT_OPEN_AI_COMPATIBLE_MODEL || "whisper-1";
    this.language = process.env.STT_OPEN_AI_COMPATIBLE_LANGUAGE || null;
    // "whisperx" for the WhisperX /asr API, anything else is the OpenAI format
    this.format = (
      process.env.STT_OPEN_AI_COMPATIBLE_FORMAT || "openai"
    ).toLowerCase();
    // With a username the key is sent as Basic Auth password instead of Bearer
    this.username = process.env.STT_OPEN_AI_COMPATIBLE_USERNAME || null;

    this.#log(
      `Initialized with endpoint: ${this.endpoint}, model: ${this.model}`
    );
  }

  #log(text, ...args) {
    console.log(`\x1b[32m[OpenAiGenericSTT]\x1b[0m ${text}`, ...args);
  }

  /**
   * Transcribes audio buffer to text using OpenAI-compatible API
   * @param {Buffer} audioBuffer - The audio data to transcribe
   * @param {Object} options - Optional parameters
   * @param {string} options.language - Language code (e.g., 'de', 'en')
   * @param {string} options.filename - Original filename with extension
   * @returns {Promise<{text: string}>} The transcription result
   */
  async transcribe(audioBuffer, options = {}) {
    try {
      // Determine content type from filename, mimetype, or default to webm
      let contentType = "audio/webm";
      let filename = "audio.webm";

      if (options.mimetype) {
        contentType = options.mimetype;
        const ext = this.#getExtension(options.mimetype);
        filename = options.filename || `audio.${ext}`;
      } else if (options.filename) {
        filename = options.filename;
        contentType = this.#getContentType(filename);
      }

      // Use native FormData + Blob (works with native fetch in Node 18+)
      const blob = new Blob([audioBuffer], { type: contentType });

      // Add language if specified (in options or env)
      const language = options.language || this.language;
      const { url, formData } = this.#buildRequest(blob, filename, language);

      const headers = {};
      if (this.apiKey) {
        headers["Authorization"] = this.#authorization();
      }

      const response = await fetch(url, {
        method: "POST",
        headers: headers,
        body: formData,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `STT request failed (${response.status}): ${errorText}`
        );
      }

      const text = this.#extractText(await response.json());
      this.#log(`Transcription completed (${text.length} characters)`);

      return { text };
    } catch (error) {
      this.#log(`Error during transcription: ${error.message}`);
      throw error;
    }
  }

  #buildRequest(blob, filename, language) {
    const formData = new FormData();

    if (this.format === "whisperx") {
      formData.append("audio_file", blob, filename);

      const url = new URL(this.endpoint);
      url.searchParams.set("output", "json");
      url.searchParams.set("task", "transcribe");
      if (language) url.searchParams.set("language", language);
      return { url: url.toString(), formData };
    }

    formData.append("file", blob, filename);
    formData.append("model", this.model);
    if (language) formData.append("language", language);
    return { url: this.endpoint, formData };
  }

  #authorization() {
    if (!this.username) return `Bearer ${this.apiKey}`;
    const credentials = Buffer.from(`${this.username}:${this.apiKey}`);
    return `Basic ${credentials.toString("base64")}`;
  }

  #extractText(result) {
    if (this.format !== "whisperx") return result.text || "";
    return (result.segments || [])
      .map((segment) => segment.text?.trim())
      .filter(Boolean)
      .join(" ");
  }

  #getContentType(filename) {
    const ext = filename.split(".").pop()?.toLowerCase();
    const mimeTypes = {
      webm: "audio/webm",
      mp3: "audio/mpeg",
      mp4: "audio/mp4",
      m4a: "audio/mp4",
      wav: "audio/wav",
      ogg: "audio/ogg",
      flac: "audio/flac",
    };
    return mimeTypes[ext] || "audio/webm";
  }

  #getExtension(mimetype) {
    const extMap = {
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
    return extMap[mimetype] || "webm";
  }

  static isConfigured() {
    return !!process.env.STT_OPEN_AI_COMPATIBLE_ENDPOINT;
  }
}

module.exports = {
  GenericOpenAiSTT,
};
