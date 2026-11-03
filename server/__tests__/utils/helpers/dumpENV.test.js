/* eslint-env jest, node */
// dumpENV() schreibt die geschützten Schlüssel neu in server/.env. Geprüft
// wird der geschriebene Inhalt; fs.writeFileSync ist gemockt, es entsteht
// keine Datei. process.env ist je Test ein kleines, festes Objekt, damit
// keine Werte der Umgebung in den Test oder seine Ausgabe gelangen.
// AK-7 (issues/thinking-schalter-generic-openai.md):
// GENERIC_OPEN_AI_ENABLE_THINKING übersteht das Neuschreiben.

jest.mock("../../../models/telemetry", () => ({
  Telemetry: { sendTelemetry: jest.fn() },
}));
jest.mock("../../../utils/vectorStore/resetAllVectorStores", () => ({
  resetAllVectorStores: jest.fn(),
}));

const fs = require("fs");
const dotenv = require("dotenv");
const { dumpENV } = require("../../../utils/helpers/updateENV");

const originalEnv = process.env;
let writeSpy;

/** Ruft dumpENV() mit genau diesen Variablen auf und liefert den .env-Text. */
function dumpWith(env) {
  process.env = { ...env };
  expect(dumpENV()).toBe(true);
  expect(writeSpy).toHaveBeenCalledTimes(1);
  const [, content] = writeSpy.mock.calls[0];
  return content;
}

function lineFor(content, key) {
  return (
    content.split("\n").find((line) => line.startsWith(`${key}=`)) ?? null
  );
}

beforeEach(() => {
  writeSpy = jest.spyOn(fs, "writeFileSync").mockImplementation(() => {});
});

afterEach(() => {
  process.env = originalEnv;
  writeSpy.mockRestore();
});

describe("dumpENV: GENERIC_OPEN_AI_ENABLE_THINKING", () => {
  test.each(["false", "true"])(
    "AK-7: Wert %j steht unverändert in der .env",
    (value) => {
      const content = dumpWith({
        LLM_PROVIDER: "generic-openai",
        GENERIC_OPEN_AI_ENABLE_THINKING: value,
      });
      expect(lineFor(content, "GENERIC_OPEN_AI_ENABLE_THINKING")).toBe(
        `GENERIC_OPEN_AI_ENABLE_THINKING='${value}'`
      );
      // Nach dem Neustart liest dotenv denselben Wert wieder ein
      expect(dotenv.parse(content).GENERIC_OPEN_AI_ENABLE_THINKING).toBe(
        value
      );
    }
  );

  test("ohne Variable keine Zeile", () => {
    const content = dumpWith({ LLM_PROVIDER: "generic-openai" });
    expect(lineFor(content, "GENERIC_OPEN_AI_ENABLE_THINKING")).toBeNull();
  });

  test("übrige Schlüssel unverändert (Custom-Header, Provider)", () => {
    const content = dumpWith({
      LLM_PROVIDER: "generic-openai",
      GENERIC_OPEN_AI_CUSTOM_HEADERS: "X-Test:wert",
      GENERIC_OPEN_AI_ENABLE_THINKING: "false",
      NICHT_GESCHUETZT: "x",
    });
    expect(lineFor(content, "LLM_PROVIDER")).toBe(
      "LLM_PROVIDER='generic-openai'"
    );
    expect(lineFor(content, "GENERIC_OPEN_AI_CUSTOM_HEADERS")).toBe(
      "GENERIC_OPEN_AI_CUSTOM_HEADERS='X-Test:wert'"
    );
    expect(lineFor(content, "NICHT_GESCHUETZT")).toBeNull();
  });
});
