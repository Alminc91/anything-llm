/* eslint-env jest, node */
// Spracheingabe über die ASR-Schnittstelle von WhisperX (Spezifikation
// issues/stt-whisperx.md, AK-1 bis AK-5, NAK-1 bis NAK-3). fetch wird gemockt;
// geprüft wird genau die Anfrage, die den Server verlässt.

const {
  GenericOpenAiSTT,
} = require("../../../utils/SpeechToText/openAiGeneric");

const ENV_KEYS = [
  "STT_OPEN_AI_COMPATIBLE_ENDPOINT",
  "STT_OPEN_AI_COMPATIBLE_KEY",
  "STT_OPEN_AI_COMPATIBLE_MODEL",
  "STT_OPEN_AI_COMPATIBLE_LANGUAGE",
  "STT_OPEN_AI_COMPATIBLE_FORMAT",
  "STT_OPEN_AI_COMPATIBLE_USERNAME",
];
const savedEnv = {};
const savedFetch = global.fetch;
const AUDIO = Buffer.from("audio");
const KEY = "geheimer-schluessel";

function antwort(body, status = 200) {
  global.fetch = jest.fn().mockResolvedValue({
    ok: status < 400,
    status,
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  });
}

function whisperx() {
  process.env.STT_OPEN_AI_COMPATIBLE_ENDPOINT =
    "https://ki.example.test/whisperx/asr";
  process.env.STT_OPEN_AI_COMPATIBLE_KEY = KEY;
  process.env.STT_OPEN_AI_COMPATIBLE_FORMAT = "whisperx";
  process.env.STT_OPEN_AI_COMPATIBLE_USERNAME = "kuf-chatbot";
}

function gesendet() {
  const [url, init] = global.fetch.mock.calls[0];
  return { url: new URL(url), headers: init.headers, form: init.body };
}

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  jest.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  global.fetch = savedFetch;
  jest.restoreAllMocks();
});

describe("GenericOpenAiSTT: OpenAI-Format bleibt unverändert", () => {
  beforeEach(() => {
    process.env.STT_OPEN_AI_COMPATIBLE_ENDPOINT =
      "https://stt.example.test/v1/audio/transcriptions?x=1";
    process.env.STT_OPEN_AI_COMPATIBLE_KEY = KEY;
    process.env.STT_OPEN_AI_COMPATIBLE_MODEL = "whisper-large-v3";
    antwort({ text: "Hallo Welt" });
  });

  test("NAK-1: gleiche Adresse, Felder und Bearer-Anmeldung, Text aus text", async () => {
    const result = await new GenericOpenAiSTT().transcribe(AUDIO, {
      language: "de",
      filename: "recording.webm",
    });

    const { url, headers, form } = gesendet();
    expect(url.toString()).toBe(
      "https://stt.example.test/v1/audio/transcriptions?x=1"
    );
    expect(headers).toEqual({ Authorization: `Bearer ${KEY}` });
    expect(form.get("file").name).toBe("recording.webm");
    expect(form.get("model")).toBe("whisper-large-v3");
    expect(form.get("language")).toBe("de");
    expect(form.get("audio_file")).toBeNull();
    expect(result).toEqual({ text: "Hallo Welt" });
  });

  test("NAK-3: Der erkannte Text landet nicht im Log", async () => {
    await new GenericOpenAiSTT().transcribe(AUDIO);
    const log = console.log.mock.calls.flat().join(" ");
    expect(log).toContain("Transcription completed (10 characters)");
    expect(log).not.toContain("Hallo Welt");
  });

  test("Ohne Schlüssel keine Anmeldung, auch nicht mit Benutzername", async () => {
    delete process.env.STT_OPEN_AI_COMPATIBLE_KEY;
    process.env.STT_OPEN_AI_COMPATIBLE_USERNAME = "kuf-chatbot";
    await new GenericOpenAiSTT().transcribe(AUDIO);
    expect(gesendet().headers).toEqual({});
  });
});

describe("GenericOpenAiSTT: Format whisperx", () => {
  beforeEach(() => {
    whisperx();
    antwort({
      language: "de",
      segments: [{ text: " Guten Tag." }, { text: " Wann beginnt der Kurs? " }],
      word_segments: [],
    });
  });

  test("AK-1: Audio als audio_file, kein Modellfeld, Parameter in der URL", async () => {
    await new GenericOpenAiSTT().transcribe(AUDIO, {
      language: "de",
      filename: "recording.webm",
    });

    const { url, form } = gesendet();
    expect(url.origin + url.pathname).toBe(
      "https://ki.example.test/whisperx/asr"
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      output: "json",
      task: "transcribe",
      language: "de",
    });
    expect(form.get("audio_file").name).toBe("recording.webm");
    expect(form.get("audio_file").type).toBe("audio/webm");
    expect(form.get("file")).toBeNull();
    expect(form.get("model")).toBeNull();
    expect(form.get("language")).toBeNull();
  });

  test("AK-2: Basic Auth aus Benutzername und Schlüssel", async () => {
    await new GenericOpenAiSTT().transcribe(AUDIO);
    const { headers } = gesendet();
    const [art, wert] = headers.Authorization.split(" ");
    expect(art).toBe("Basic");
    expect(Buffer.from(wert, "base64").toString("utf8")).toBe(
      `kuf-chatbot:${KEY}`
    );
  });

  test("AK-3: Text aus segments, sauber verbunden", async () => {
    const result = await new GenericOpenAiSTT().transcribe(AUDIO);
    expect(result).toEqual({ text: "Guten Tag. Wann beginnt der Kurs?" });
  });

  test("AK-3: Stille ergibt leeren Text statt Fehler", async () => {
    antwort({ language: "de", segments: [] });
    expect(await new GenericOpenAiSTT().transcribe(AUDIO)).toEqual({
      text: "",
    });
    antwort({});
    expect(await new GenericOpenAiSTT().transcribe(AUDIO)).toEqual({
      text: "",
    });
  });

  test("AK-4: Ohne Sprache entscheidet WhisperX, Vorgabe aus der Umgebung gilt", async () => {
    await new GenericOpenAiSTT().transcribe(AUDIO);
    expect(gesendet().url.searchParams.has("language")).toBe(false);

    process.env.STT_OPEN_AI_COMPATIBLE_LANGUAGE = "en";
    global.fetch.mockClear();
    await new GenericOpenAiSTT().transcribe(AUDIO);
    expect(gesendet().url.searchParams.get("language")).toBe("en");
  });

  test("AK-5: Schreibweise des Formats ist egal", async () => {
    process.env.STT_OPEN_AI_COMPATIBLE_FORMAT = "WhisperX";
    await new GenericOpenAiSTT().transcribe(AUDIO);
    expect(gesendet().form.get("audio_file")).not.toBeNull();
  });

  test("NAK-2: Sprache aus der Anfrage kann keine Parameter einschleusen", async () => {
    await new GenericOpenAiSTT().transcribe(AUDIO, {
      language: "de&output=txt&task=translate",
    });
    const { url } = gesendet();
    expect(url.searchParams.getAll("output")).toEqual(["json"]);
    expect(url.searchParams.getAll("task")).toEqual(["transcribe"]);
    expect(url.searchParams.get("language")).toBe(
      "de&output=txt&task=translate"
    );
  });

  test("NAK-3: Fehler nennt den Status, Schlüssel und Text landen nie im Log", async () => {
    await new GenericOpenAiSTT().transcribe(AUDIO);
    antwort("Internal Server Error", 500);
    await expect(new GenericOpenAiSTT().transcribe(AUDIO)).rejects.toThrow(
      "STT request failed (500)"
    );

    const log = console.log.mock.calls.flat().join(" ");
    const basis64 = Buffer.from(`kuf-chatbot:${KEY}`).toString("base64");
    expect(log).toContain("Transcription completed");
    expect(log).not.toContain(KEY);
    expect(log).not.toContain(basis64);
    expect(log).not.toContain("Guten Tag");
  });
});
