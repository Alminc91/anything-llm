/* eslint-env jest */
// Kufer-Fork: Die Audio-Routen der Entwickler-API verlangen einen API-Schlüssel
// (Review PR #78, S1, 11.11.2026). Vorher konnte jeder anonym über den
// STT-Anbieter der Instanz transkribieren.

jest.mock("../../utils/prisma", () =>
  require("./support/routeHarness").createFakePrisma()
);

const mockTranscribe = jest.fn(async () => ({ text: "Hallo" }));
jest.mock("../../utils/SpeechToText", () => ({
  isSTTConfigured: () => true,
  getSTTProvider: () => ({ transcribe: mockTranscribe }),
}));

const prisma = require("../../utils/prisma");
const { audioEndpoints } = require("../../endpoints/api/audio");
const { collectRoutes, invoke } = require("./support/routeHarness");

const routes = collectRoutes(audioEndpoints);
const TRANSCRIBE = "POST /api/audio/transcribe";
const STATUS = "GET /api/audio/stt-status";

beforeEach(() => {
  mockTranscribe.mockClear();
  prisma.api_keys.deleteMany();
});

describe("Audio-Routen der Entwickler-API", () => {
  it.each([TRANSCRIBE, STATUS])(
    "%s lehnt Anfragen ohne Schlüssel mit 403 ab",
    async (route) => {
      const result = await invoke(routes[route]);
      expect(result.statusCode).toBe(403);
      expect(mockTranscribe).not.toHaveBeenCalled();
    }
  );

  it.each([TRANSCRIBE, STATUS])(
    "%s lehnt einen unbekannten Schlüssel mit 403 ab",
    async (route) => {
      const result = await invoke(routes[route], { token: "falsch" });
      expect(result.statusCode).toBe(403);
      expect(mockTranscribe).not.toHaveBeenCalled();
    }
  );

  it("lässt mit gültigem Schlüssel bis zum Upload durch", async () => {
    await prisma.api_keys.create({ data: { secret: "gueltig" } });
    const chain = routes[TRANSCRIBE];
    // Erstes Glied ist die Schlüsselprüfung, danach folgt der Upload.
    const first = await invoke(chain.slice(0, 1), { token: "gueltig" });
    expect(first.sent).toBe(0);
    const status = await invoke(routes[STATUS], { token: "gueltig" });
    expect(status.statusCode).toBe(200);
    expect(status.body).toMatchObject({ success: true, configured: true });
  });
});
