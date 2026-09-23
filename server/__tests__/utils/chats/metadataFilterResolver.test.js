/* eslint-env jest, node */
// KIE-480: Filter-Erkennung für die Suche (nur LLM; Timeout/Fehler → kein Filter).
jest.mock("../../../models/systemSettings", () => ({
  SystemSettings: { getValueOrFallback: jest.fn() },
}));
const { SystemSettings } = require("../../../models/systemSettings");
const {
  resolveMetadataFilters,
  startMetadataFilterResolution,
  berlinToday,
  isPlausiblePlace,
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
  jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  console.log.mockRestore();
  console.error.mockRestore();
});

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

  test("leeres LLM-Ergebnis {} bleibt {} (kein Filter)", async () => {
    settings({ metadata_filters: "on" });
    const r = await resolveMetadataFilters({
      userQuery: "Wann beginnt der Englischkurs am Montag?", // Informationsfrage
      LLMConnector: llm("{}"),
      referenceDate: REF,
    });
    expect(r).toMatchObject({ stage: "llm", filters: {} });
  });

  test("Timeout → kein Filter (ungefilterte Suche), Fehler auf stderr", async () => {
    settings({ metadata_filters: "on" });
    const r = await resolveMetadataFilters({
      userQuery: "Yogakurse am Abend",
      LLMConnector: llm('{"time_of_day":["evening"]}', 200),
      referenceDate: REF,
      timeoutMs: 50,
    });
    expect(r).toMatchObject({ stage: "llm-error", filters: {} });
    expect(r.error).toMatch(/timeout/);
    expect(console.error).toHaveBeenCalled();
  });

  test("LLM-Fehler / unparsbares JSON → kein Filter", async () => {
    settings({ metadata_filters: "on" });
    const e = await resolveMetadataFilters({ userQuery: "Kurse am Samstag", LLMConnector: llm(new Error("502")), referenceDate: REF });
    expect(e).toMatchObject({ stage: "llm-error", filters: {} });
    const j = await resolveMetadataFilters({ userQuery: "Kurse am Samstag", LLMConnector: llm("{kaputt"), referenceDate: REF });
    expect(j).toMatchObject({ stage: "llm-error", filters: {} });
  });

  test("Ort nur aus der Kundenliste; ohne Liste kein Ortsfilter", async () => {
    settings({ metadata_filters: "on", metadata_filter_locations: "leichlingen,0,en" });
    const r = await resolveMetadataFilters({
      userQuery: "Yoga in Lingen oder Leichlingen",
      LLMConnector: llm('{"location":["lingen","leichlingen"],"price_max":50}'),
      referenceDate: REF,
    });
    expect(r.filters).toEqual({ location: ["leichlingen"], priceMax: 50 });
    settings({ metadata_filters: "on" });
    const n = await resolveMetadataFilters({ userQuery: "Yoga in Berlin", LLMConnector: llm('{"location":["berlin"]}'), referenceDate: REF });
    expect(n.filters).toEqual({});
  });

  test("Ortscodes aus dem Feed kommen nicht in den Prompt", async () => {
    settings({ metadata_filters: "on", metadata_filter_locations: "0,en,ja,leichlingen" });
    const L = llm("{}");
    await resolveMetadataFilters({ userQuery: "Englisch unter 50 Euro", LLMConnector: L, referenceDate: REF });
    const system = L.getChatCompletion.mock.calls[0][0][0].content;
    expect(system).toContain(": leichlingen.");
    expect(isPlausiblePlace("0")).toBe(false);
    expect(isPlausiblePlace("online")).toBe(false);
  });

  test("Preiswerte nur aus echten Zahlen ('' / false ergeben keinen Preisfilter)", async () => {
    settings({ metadata_filters: "on" });
    for (const v of ['""', "false", "[]", "null"]) {
      const r = await resolveMetadataFilters({ userQuery: "Kurse", LLMConnector: llm(`{"price_max":${v}}`), referenceDate: REF });
      expect(r.filters).toEqual({});
    }
    const ok = await resolveMetadataFilters({ userQuery: "Kurse", LLMConnector: llm('{"price_max":"60"}'), referenceDate: REF });
    expect(ok.filters).toEqual({ priceMax: 60 });
  });

  test("Reasoning ohne öffnendes Tag wird entfernt", async () => {
    settings({ metadata_filters: "on" });
    const r = await resolveMetadataFilters({
      userQuery: "Kurse unter 50 Euro",
      LLMConnector: llm('Entwurf {"price_max": 999}</think>{"price_max":50}'),
      referenceDate: REF,
    });
    expect(r).toMatchObject({ stage: "llm", filters: { priceMax: 50 } });
  });

  test("Referenzdatum in Europe/Berlin (Container laufen in UTC)", () => {
    expect(berlinToday(new Date("2026-09-27T22:30:00Z"))).toBe("2026-09-28"); // Berlin 00:30
    expect(berlinToday(new Date("2026-12-31T23:30:00Z"))).toBe("2027-01-01");
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

  test("ohne LLM-Provider → null (kein Filter)", async () => {
    settings({ metadata_filters: "on" });
    expect(await resolveMetadataFilters({ userQuery: "Yoga am Vormittag", LLMConnector: {} })).toBeNull();
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

describe("Verlauf (Folgefragen)", () => {
  test("letzte 3 Nutzer-Nachrichten + Übernahme-Regeln gehen an den Normalisierer", async () => {
    settings({ metadata_filters: "on", metadata_filter_locations: "leichlingen" });
    const L = llm('{"time_of_day":["evening"],"location":["leichlingen"]}');
    const chatHistory = [
      { role: "user", content: "Hallo" },
      { role: "assistant", content: "Guten Tag!" },
      { role: "user", content: "Yoga?" },
      { role: "assistant", content: "Hier sind Yogakurse …" },
      { role: "user", content: "Englisch abends in Leichlingen?" },
      { role: "assistant", content: "Kurs A, Kurs B" },
      { role: "user", content: "und Spanisch?" },
    ];
    const r = await resolveMetadataFilters({ userQuery: "gibts das auch für anfänger?", chatHistory, LLMConnector: L, referenceDate: REF });
    expect(r.filters).toMatchObject({ timeOfDay: ["evening"], location: ["leichlingen"] });
    const [messages] = L.getChatCompletion.mock.calls[0];
    expect(messages[0].content).toContain("Gesprächsverlauf:");
    expect(messages[1].content).toBe(
      "Frühere Nachrichten (älteste zuerst):\n- Yoga?\n- Englisch abends in Leichlingen?\n- und Spanisch?\n\nAktuelle Nachricht: gibts das auch für anfänger?"
    );
    expect(messages[1].content).not.toContain("Kurs A"); // Assistenz-Antworten bleiben draußen
  });

  test("ohne Verlauf: Prompt exakt wie im Einzelfragen-Benchmark", async () => {
    settings({ metadata_filters: "on" });
    const L = llm("{}");
    await resolveMetadataFilters({ userQuery: "Yoga abends", chatHistory: [], LLMConnector: L, referenceDate: REF });
    const [messages] = L.getChatCompletion.mock.calls[0];
    expect(messages[0].content).not.toContain("Gesprächsverlauf:");
    expect(messages[0].content).toBe(buildNormalizerPrompt({ referenceDate: REF, knownLocations: [] }));
    expect(messages[1].content).toBe("Yoga abends");
  });

  test("Log-Zeile ohne Steuerzeichen und nur mit kurzem Anfang der Nachricht", async () => {
    settings({ metadata_filters: "on" });
    await resolveMetadataFilters({ userQuery: "\x1b[2KYoga\nabends " + "x".repeat(200), LLMConnector: llm("{}"), referenceDate: REF });
    const line = console.log.mock.calls.flat().join(" ");
    expect(line).not.toMatch(/\x1b\[2K|\n/);
    expect(line).not.toContain("x".repeat(80));
  });
});
