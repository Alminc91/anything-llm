process.env.STORAGE_DIR = "test-storage";
const fs = require("fs");
const path = require("path");

// Mock fix-path as a noop to prevent SIGSEGV (segfault)
// Returns ESM-style default export for dynamic import()
// virtual: Jest muss das Paket dafür nicht auflösen können. Ohne installierte
// Abhängigkeiten des Collectors (collector/node_modules) lud die Suite sonst
// gar nicht erst ("Cannot find module 'fix-path'").
jest.mock("fix-path", () => ({ default: jest.fn() }), { virtual: true });

const { execSync } = require("child_process");
const { FFMPEGWrapper } = require("../../../../utils/WhisperProviders/ffmpeg");

const describeRunner = process.env.GITHUB_ACTIONS ? describe.skip : describe;

// Drei der Tests brauchen ein echtes ffmpeg im PATH. Wo keines installiert
// ist, werden genau diese übersprungen (sichtbar als "skipped") statt rot zu
// sein; die übrigen laufen überall. Gesucht wird wie in ffmpegPath().
const hasFFMPEG = (() => {
  try {
    const which = process.platform === "win32" ? "where" : "which";
    execSync(`${which} ffmpeg`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();
const itWithFFMPEG = hasFFMPEG ? it : it.skip;

describeRunner("FFMPEGWrapper", () => {
  /** @type { import("../../../../utils/WhisperProviders/ffmpeg/index").FFMPEGWrapper } */
  let ffmpeg;
  const testDir = path.resolve(__dirname, "../../../../storage/tmp");
  const inputPath = path.resolve(testDir, "test-input.wav");
  const outputPath = path.resolve(testDir, "test-output.wav");

  beforeEach(() => {
    ffmpeg = new FFMPEGWrapper();
  });

  afterEach(() => {
    if (fs.existsSync(inputPath)) fs.rmSync(inputPath);
    if (fs.existsSync(outputPath)) fs.rmSync(outputPath);
  });

  itWithFFMPEG("should find ffmpeg executable", async () => {
    const knownPath = await ffmpeg.ffmpegPath();
    expect(knownPath).toBeDefined();
    expect(typeof knownPath).toBe("string");
    expect(knownPath.length).toBeGreaterThan(0);
  });

  itWithFFMPEG("should validate ffmpeg executable", async () => {
    const knownPath = await ffmpeg.ffmpegPath();
    expect(ffmpeg.isValidFFMPEG(knownPath)).toBe(true);
  });

  it("should return false for invalid ffmpeg path", () => {
    expect(ffmpeg.isValidFFMPEG("/invalid/path/to/ffmpeg")).toBe(false);
  });

  itWithFFMPEG(
    "should convert audio file to wav format",
    async () => {
      if (!fs.existsSync(testDir)) fs.mkdirSync(testDir, { recursive: true });

      const sampleUrl =
        "https://github.com/ringcentral/ringcentral-api-docs/blob/main/resources/sample1.wav?raw=true";

      const response = await fetch(sampleUrl);
      if (!response.ok)
        throw new Error(
          `Failed to download sample file: ${response.statusText}`
        );

      const buffer = await response.arrayBuffer();
      fs.writeFileSync(inputPath, Buffer.from(buffer));

      const result = await ffmpeg.convertAudioToWav(inputPath, outputPath);

      expect(result).toBe(true);
      expect(fs.existsSync(outputPath)).toBe(true);

      const stats = fs.statSync(outputPath);
      expect(stats.size).toBeGreaterThan(0);
    },
    30000
  );

  it("should throw error when conversion fails", async () => {
    const nonExistentFile = path.resolve(testDir, "non-existent-file.wav");
    const outputPath = path.resolve(testDir, "test-output-fail.wav");

    // Mit await: Ohne es endete der Test, bevor die Erwartung geprüft war.
    await expect(async () => {
      return await ffmpeg.convertAudioToWav(nonExistentFile, outputPath);
    }).rejects.toThrow(`Input file ${nonExistentFile} does not exist.`);
  });
});
