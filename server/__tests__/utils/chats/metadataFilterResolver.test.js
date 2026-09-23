/* eslint-env jest, node */
// KIE-480: Filter-Erkennung für die Suche (LLM immer, Regeln als Timeout-/Fehler-Rückfall).
jest.mock("../../../models/systemSettings", () => ({
  SystemSettings: { getValueOrFallback: jest.fn() },
}));
const { SystemSettings } = require("../../../models/systemSettings");
const {
  resolveMetadataFilters,
  startMetadataFilterResolution,
} = require("../../../utils/chats/metadataFilterResolver");
const {
  buildNormalizerPrompt,
} = require("../../../utils/chats/metadataFilterNormalizer");

const REF = new Date("2026-09-23T10:00:00Z"); // Mittwoch

function settings(values) {
  SystemSettings.getValueOrFallback.mockImplementation(async ({ label }, fallback) =>
    label in values ? values[label] : fallback
  );
}
function llm(reply, delayMs = 0) {
  return {
    getChatCompletion: jest.fn(async () => {
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      if (reply instanceof Error) throw reply;
      return { textResponse: reply };
    }),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => console.log.mockRestore());

describe("metadataFilterResolver", () => {
  test("Setting aus → null, kein LLM-Aufruf", async () => {
    settings({ metadata_filters: "off" });
    const L = llm("{}");
    expect(await resolveMetadataFilters({ userQuery: "Yoga abends", LLMConnector: L })).toBeNull();
    expect(L.getChatCompletion).not.toHaveBeenCalled();
  });

  test("LLM-Ausgabe (symbolisch) wird aufgelöst und validiert", async () => {
    settings({ metadata_filters: "on", metadata_filter_locations: "wermelskirchen,leichlingen" });
    const L = llm('{"date_from":"today","date_to":"today+2w","time_of_day":["evening"],"location":["leichlingen"]}');
    const r = await resolveMetadataFilters({
      userQuery: "Gibt es abends Yogakurse in Leichlingen in den nächsten 2 Wochen?",
      LLMConnector: L,
      referenceDate: REF,
    });
    expect(r.stage).toBe("llm");
    expect(r.filters).toMatchObject({
      dateFrom: "2026-09-23",
      dateTo: "2026-10-07",
      timeOfDay: ["evening"],
      location: ["leichlingen"],
    });
    // Aufruf über den Workspace-Provider mit Temperatur 0 und Kunden-Ortsliste im Prompt
    const [messages, opts] = L.getChatCompletion.mock.calls[0];
    expect(opts).toEqual({ temperature: 0 });
    expect(messages[0].content).toContain("wermelskirchen, leichlingen");
    expect(messages[1].content).toBe("Gibt es abends Yogakurse in Leichlingen in den nächsten 2 Wochen?");
  });

  test("leeres LLM-Ergebnis {} wird NICHT von den Regeln überstimmt", async () => {
    settings({ metadata_filters: "on" });
    const r = await resolveMetadataFilters({
      userQuery: "Wann beginnt der Englischkurs am Montag?", // Informationsfrage
      LLMConnector: llm("{}"),
      referenceDate: REF,
    });
    expect(r).toMatchObject({ stage: "llm", filters: {} });
  });

  test("Timeout → Regel-Rückfall (nie leer, wenn die Regeln etwas finden)", async () => {
    settings({ metadata_filters: "on" });
    const r = await resolveMetadataFilters({
      userQuery: "Yogakurse am Abend",
      LLMConnector: llm('{"time_of_day":["evening"]}', 200),
      referenceDate: REF,
      timeoutMs: 50,
    });
    expect(r.stage).toBe("rules-fallback");
    expect(r.error).toMatch(/timeout/);
    expect(r.filters.timeOfDay).toEqual(["evening"]);
  });

  test("LLM-Fehler / unparsbares JSON → Regel-Rückfall", async () => {
    settings({ metadata_filters: "on" });
    const e = await resolveMetadataFilters({ userQuery: "Kurse am Samstag", LLMConnector: llm(new Error("502")), referenceDate: REF });
    expect(e.stage).toBe("rules-fallback");
    expect(e.filters.weekdays).toEqual(["sat"]);
    const j = await resolveMetadataFilters({ userQuery: "Kurse am Samstag", LLMConnector: llm("{kaputt"), referenceDate: REF });
    expect(j.stage).toBe("rules-fallback");
  });

  test("<think>-Blöcke werden vor dem JSON-Parsing entfernt", async () => {
    settings({ metadata_filters: "on" });
    const r = await resolveMetadataFilters({
      userQuery: "Kurse unter 50 Euro",
      LLMConnector: llm('<think>{"price_max": 999}</think>{"price_max":50}'),
      referenceDate: REF,
    });
    expect(r).toMatchObject({ stage: "llm", filters: { priceMax: 50 } });
  });

  test("metadata_filter_mode=rules → kein LLM-Aufruf", async () => {
    settings({ metadata_filters: "on", metadata_filter_mode: "rules" });
    const L = llm("{}");
    const r = await resolveMetadataFilters({ userQuery: "Yoga am Vormittag", LLMConnector: L, referenceDate: REF });
    expect(r.stage).toBe("rules");
    expect(r.filters.timeOfDay).toEqual(["morning"]);
    expect(L.getChatCompletion).not.toHaveBeenCalled();
  });

  test("Settings-Fehler → Promise wird nie verworfen", async () => {
    SystemSettings.getValueOrFallback.mockRejectedValue(new Error("db down"));
    const r = await startMetadataFilterResolution({ userQuery: "Yoga", LLMConnector: llm("{}") });
    expect(r).toMatchObject({ stage: "error", filters: {} });
  });

  test("leere Frage → null", async () => {
    settings({ metadata_filters: "on" });
    expect(await resolveMetadataFilters({ userQuery: "  ", LLMConnector: llm("{}") })).toBeNull();
  });

  test("Log-Zeile je Stufe", async () => {
    settings({ metadata_filters: "on" });
    await resolveMetadataFilters({ userQuery: "Yoga abends", LLMConnector: llm('{"time_of_day":["evening"]}'), referenceDate: REF });
    expect(console.log.mock.calls.flat().join(" ")).toMatch(/\[MetadataFilter\].*stage=llm \d+ms "Yoga abends"/);
  });
});

describe("Normalisierer-Prompt", () => {
  test("Few-Shots nutzen die Orte des Kunden, keine fremden Kundenorte", () => {
    const p = buildNormalizerPrompt({ referenceDate: "2026-09-23", knownLocations: ["innenstadt", "nippes"] });
    expect(p).toContain('"location":["innenstadt"]');
    expect(p).toContain('"location":["nippes"]');
    expect(p).not.toMatch(/leichlingen|burscheid|wermelskirchen/i);
  });
  test("ohne Ortsliste: kein Orts-Beispiel, location nie setzen", () => {
    const p = buildNormalizerPrompt({ referenceDate: "2026-09-23", knownLocations: [] });
    expect(p).toContain("location\": nie setzen");
    expect(p).not.toContain('"location":[');
  });
});
