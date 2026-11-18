/* eslint-env jest, node */
/**
 * Startvermerk zur Fragezeit (issues/kurszustand-zur-fragezeit.md) in der
 * Suche: gegen eine echte, temporäre LanceDB-Tabelle, mit Reranker-
 * Testdouble und gestubbten SystemSettings (wie selectionPaths.test.js).
 *
 * AK-2: performSimilaritySearch liefert in allen Suchmodi, mit
 * Kursnummernsuche, Metadatenfilter und gelockerten Filtern Kontexttexte
 * und Quellen mit dem Vermerk nach `start_date` und heute (Europe/Berlin).
 * NAK-1: Nicht-Kurs-Dokumente und richtige Vermerke byte-gleich.
 * NAK-3: Mit und ohne Regel sind Auswahl, Reihenfolge, Scores, Metadaten,
 * Reranker-Eingaben und Suchspur gleich; die Regel ändert nur Text danach.
 * Der Schalter `mockRule.on` ersetzt withStartNotes durch die Identität
 * (= Stand vor der Regel).
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.STORAGE_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), "lance-startvermerk-")
);

const mockRerank = jest.fn();
jest.mock("../../../../utils/helpers", () => {
  const actual = jest.requireActual("../../../../utils/helpers");
  return {
    ...actual,
    getRerankerProviderSelection: () => ({
      rerank: (...args) => mockRerank(...args),
    }),
  };
});
jest.mock("../../../../utils/prisma", () => ({
  system_settings: { findFirst: jest.fn(async () => null) },
}));
jest.mock("../../../../utils/chats/courseInventory", () => {
  const actual = jest.requireActual("../../../../utils/chats/courseInventory");
  return { ...actual, courseSearchExclusion: async () => null };
});
const mockRule = { on: true };
jest.mock("../../../../utils/vectorDbProviders/lance/courseStartNote", () => {
  const actual = jest.requireActual(
    "../../../../utils/vectorDbProviders/lance/courseStartNote"
  );
  return {
    ...actual,
    withStartNotes: (texts, rows, today) =>
      mockRule.on ? actual.withStartNotes(texts, rows, today) : texts,
  };
});

const { LanceDb } = require("../../../../utils/vectorDbProviders/lance");
const { SystemSettings } = require("../../../../models/systemSettings");
const SearchTrace = require("../../../../utils/vectorDbProviders/lance/searchTrace");
const {
  berlinToday,
} = require("../../../../utils/vectorDbProviders/lance/contextSelection");

let settings = {};
jest
  .spyOn(SystemSettings, "getValueOrFallback")
  .mockImplementation(async ({ label } = {}, fallback) =>
    Object.prototype.hasOwnProperty.call(settings, label)
      ? settings[label]
      : fallback
  );

const OPEN = " — Bereits gestartet, Einstieg möglich";
const STARTED = " — Bereits gestartet";

const TODAY = berlinToday();
const inDays = (n) => {
  const d = new Date(`${TODAY}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
// ISO-Tag → Datumsteil wie der Extraktor (format_date_de, ohne Wochentag)
const de = (iso) => iso.split("-").reverse().join(".");

const NS = "startvermerk";
const NS_MIDNIGHT = "startvermerk_mitternacht";
const QUERY = "Türkische Küche Kochkurs";
const QUERY_VECTOR = [1, 0, 0, 0];
const MODES = ["default", "rerank", "hybrid", "hybrid_rerank"];
const near = (i) => [1, 0.01 * (i + 1), 0.003 * i, 0];

const HEAD = (file) =>
  `<document_metadata>\nsourceDocument: ${file}\npublished: 9/24/2026, 8:57:03 AM\n</document_metadata>\n\n`;
const courseText = (knr, title, beginn, i) =>
  HEAD(`kurs-${knr.toLowerCase()}.txt`) +
  [
    `Titel: ${title}`,
    `Kursnummer: ${knr}`,
    "Kursstatus: Anmeldung möglich",
    "Kursgebühr: 34,00",
    beginn,
    "Dauer: 1 Termin",
    "Kursort: vhs, Haus S, Kochwerkstatt",
    `Kurs-Link: https://www.vhs-beispiel.de/kurssuche/kurs/x/${knr}`,
    "",
    `Kursbeschreibung: ${title} ${"Kochen ".repeat(i + 1)}`,
  ].join("\n");

// [id, Kursnummer, Tage bis Start, bookable, Vermerk im Text, Vektor]
const COURSES = [
  ["lauf", "I821103", -13, true, "", [0.6, 0, 1, 0]],
  ["warte", "I821104", -13, false, OPEN, near(2)],
  ["verschoben", "I821105", 22, true, OPEN, near(3)],
  ["richtig", "I821106", -60, true, OPEN, near(4)],
  ["kommt", "I821107", 5, true, "", near(5)],
];
const beginnLine = (days, note) => `Beginn: ${de(inDays(days))}${note}`;
const courseRows = () =>
  COURSES.map(([id, knr, days, bookable, note, vector], i) => ({
    id,
    title: `kurs-${knr.toLowerCase()}.txt`,
    text: courseText(knr, `Kochkurs ${id}`, beginnLine(days, note), i),
    vector,
    start_date: inDays(days),
    end_date: inDays(days),
    bookable,
    start_minutes: 1080,
    price: 34,
  }));
// Nicht-Kurs-Dokumente ohne Kursspalten (Tabelle wie im Bestand: Kurse kommen
// per Schema-Migration dazu); beide tragen eine Zeile „Beginn:“
const infoRows = () => [
  {
    id: "seite",
    title: "programm_kochen.html",
    text: `${HEAD("programm_kochen.html")}Türkische Küche Kochkurs Übersicht\nBeginn: ${de(inDays(-13))}\nAlle Kochkurse.`,
    vector: near(0),
  },
  {
    id: "zusatz",
    title: "zusatzwissen.txt",
    text: `Titel: Hinweise Kochkurse\nBeginn: ${de(inDays(-13))}\n\nKochkurs Türkische Küche: Schürze mitbringen.`,
    vector: near(1),
  },
];

// Erwarteter Text je Dokument nach der Regel (heute = TODAY)
const ORIGINAL = Object.fromEntries(
  [...infoRows(), ...courseRows()].map((r) => [r.id, r.text])
);
const withLine = (id, line) => {
  const [, , days, , note] = COURSES.find((c) => c[0] === id);
  return ORIGINAL[id].replace(beginnLine(days, note), line);
};
const EXPECTED = {
  seite: ORIGINAL.seite,
  zusatz: ORIGINAL.zusatz,
  lauf: withLine("lauf", beginnLine(-13, OPEN)),
  warte: withLine("warte", beginnLine(-13, STARTED)),
  verschoben: withLine("verschoben", beginnLine(22, "")),
  richtig: ORIGINAL.richtig,
  kommt: ORIGINAL.kommt,
};

const SCORES = {
  lauf: 0.99,
  warte: 0.97,
  verschoben: 0.96,
  seite: 0.95,
  richtig: 0.94,
  kommt: 0.93,
  zusatz: 0.9,
};
const scoredRerank = async (_query, docs, { topK }) =>
  docs
    .map((d, i) => ({
      ...d,
      rerank_corpus_id: i,
      rerank_score: SCORES[d.id] ?? 0.5,
    }))
    .sort((a, b) => b.rerank_score - a.rerank_score)
    .slice(0, topK);

const lance = new LanceDb();
const mockLLM = { embedTextInput: async () => QUERY_VECTOR };
const search = (searchMode, extra = {}) =>
  lance.performSimilaritySearch({
    namespace: NS,
    input: QUERY,
    LLMConnector: mockLLM,
    topN: 8,
    searchMode,
    ...extra,
  });
const ids = (result) => result.sources.map((s) => s.id);

// Fakes nur für Date (Lance-I/O braucht echte Timer und Microtasks)
const fakeClock = (iso) =>
  jest.useFakeTimers({
    now: new Date(iso),
    doNotFake: [
      "hrtime",
      "nextTick",
      "performance",
      "queueMicrotask",
      "requestAnimationFrame",
      "cancelAnimationFrame",
      "requestIdleCallback",
      "cancelIdleCallback",
      "setImmediate",
      "clearImmediate",
      "setInterval",
      "clearInterval",
      "setTimeout",
      "clearTimeout",
    ],
  });

beforeAll(async () => {
  const { client } = await lance.connect();
  await client.dropTable(NS).catch(() => {});
  await lance.updateOrCreateCollection(client, infoRows(), NS);
  await lance.updateOrCreateCollection(client, courseRows(), NS);
  // Kurse in den Volltextindex aufnehmen (Kursnummernsuche, Stichwortarm)
  await lance.optimizeFtsIfStale(await client.openTable(NS), 1);
  // Stichtag Europe/Berlin: Kurs am 03.11.2026 ohne Vermerk
  await client.dropTable(NS_MIDNIGHT).catch(() => {});
  await lance.updateOrCreateCollection(
    client,
    [
      {
        id: "mitternacht",
        title: "kurs-m1.txt",
        text: courseText(
          "M1",
          "Kochkurs Mitternacht",
          "Beginn: Di. 03.11.2026, 18:00 Uhr",
          0
        ),
        vector: near(0),
        start_date: "2026-11-03",
        end_date: "2026-11-03",
        bookable: true,
        start_minutes: 1080,
        price: 34,
      },
      {
        id: "spaeter",
        title: "kurs-m2.txt",
        text: courseText("M2", "Kochkurs später", "Beginn: Di. 08.12.2026", 1),
        vector: near(1),
        start_date: "2026-12-08",
        end_date: "2026-12-08",
        bookable: true,
        start_minutes: 1080,
        price: 34,
      },
    ],
    NS_MIDNIGHT
  );
}, 120000);

afterAll(() => {
  fs.rmSync(process.env.STORAGE_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  settings = {};
  mockRule.on = true;
  mockRerank.mockReset();
  mockRerank.mockImplementation(scoredRerank);
  jest.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  jest.useRealTimers();
  console.log.mockRestore();
});

test("Vorbedingung: Tabelle trägt Kursspalten, Nicht-Kurs-Dokumente ohne start_date", async () => {
  mockRule.on = false;
  const result = await search("default");
  expect(ids(result).sort()).toEqual(Object.keys(SCORES).sort());
  const byId = Object.fromEntries(result.sources.map((s) => [s.id, s]));
  expect(byId.seite.start_date).toBeNull();
  expect(byId.zusatz.start_date).toBeNull();
  expect(byId.warte).toMatchObject({
    start_date: inDays(-13),
    bookable: false,
  });
  // ohne Regel: Text wie eingelesen
  for (const s of result.sources) expect(s.text).toBe(ORIGINAL[s.id]);
});

describe("AK-2: Kontexttexte und Quellen tragen den Vermerk zur Fragezeit", () => {
  test.each(MODES)("Suchmodus %s", async (mode) => {
    const result = await search(mode);
    expect(ids(result).sort()).toEqual(Object.keys(SCORES).sort());
    for (const source of result.sources)
      expect([source.id, source.text]).toEqual([
        source.id,
        EXPECTED[source.id],
      ]);
    // Modell und Quellen sehen denselben Text, gleich ausgerichtet
    expect(result.contextTexts).toEqual(result.sources.map((s) => s.text));
  });

  test.each(MODES)(
    "Kursnummernsuche: gefundener Kurs vorn mit Vermerk (%s)",
    async (mode) => {
      const result = await lance.performSimilaritySearch({
        namespace: NS,
        input: "Was ist der Kurs I821103?",
        LLMConnector: mockLLM,
        topN: 2,
        searchMode: mode,
      });
      expect(ids(result)[0]).toBe("lauf");
      expect(result.sources[0].text).toBe(EXPECTED.lauf);
      expect(result.contextTexts).toEqual(result.sources.map((s) => s.text));
    }
  );

  test.each(MODES)("Metadatenfilter bookable=false (%s)", async (mode) => {
    const result = await search(mode, { filters: { bookable: false } });
    expect(ids(result)).toEqual(["warte"]);
    expect(result.contextTexts).toEqual([EXPECTED.warte]);
    expect(result.sources[0].text).toBe(EXPECTED.warte);
  });

  test.each(MODES)(
    "gelockerte Filter: Hinweis vorn, Treffer mit Vermerk (%s)",
    async (mode) => {
      const result = await search(mode, { filters: { priceMax: 1 } });
      expect(result.contextTexts[0]).toMatch(/^\[Hinweis an den Assistenten/);
      expect(result.contextTexts.slice(1)).toEqual(
        result.sources.map((s) => s.text)
      );
      for (const source of result.sources)
        expect(source.text).toBe(EXPECTED[source.id]);
      expect(result.sources.length).toBeGreaterThan(0);
    }
  );
});

describe("„heute“ = Kalendertag Europe/Berlin (wie die Auswahlstufe)", () => {
  const searchAt = async (iso, mode) => {
    fakeClock(iso);
    try {
      const result = await lance.performSimilaritySearch({
        namespace: NS_MIDNIGHT,
        input: QUERY,
        LLMConnector: mockLLM,
        topN: 4,
        searchMode: mode,
      });
      return result.sources.find((s) => s.id === "mitternacht").text;
    } finally {
      jest.useRealTimers();
    }
  };

  test.each(["default", "rerank", "hybrid_rerank"])(
    "Kurs am 03.11.: 23:59 in Berlin ohne, 00:01 am 04.11. mit Vermerk (%s)",
    async (mode) => {
      // 22:59 UTC = 23:59 Berlin am 03.11.: Beginn heute, kein Vermerk
      expect(await searchAt("2026-11-03T22:59:00Z", mode)).toMatch(
        /^Beginn: Di\. 03\.11\.2026, 18:00 Uhr$/m
      );
      // 23:01 UTC = 00:01 Berlin am 04.11. (in UTC noch der 03.11.)
      expect(await searchAt("2026-11-03T23:01:00Z", mode)).toMatch(
        /^Beginn: Di\. 03\.11\.2026, 18:00 Uhr — Bereits gestartet, Einstieg möglich$/m
      );
    }
  );
});

describe("NAK-3: Suche, Filter, Kursnummernsuche und Auswahlstufe unverändert", () => {
  let traces = [];
  beforeEach(() => {
    traces = [];
    jest
      .spyOn(SearchTrace, "writeTrace")
      .mockImplementation((t) => traces.push(JSON.parse(JSON.stringify(t))));
  });
  afterEach(() => SearchTrace.writeTrace.mockRestore());

  // Zeiten aus der Suchspur entfernen (je Lauf verschieden)
  const TIME_KEYS = new Set(["ts", "ms", "totalMs", "filterMs"]);
  const timeless = (value) =>
    JSON.parse(
      JSON.stringify(value, (key, v) => (TIME_KEYS.has(key) ? undefined : v))
    );
  const withoutText = (result) => ({
    count: result.contextTexts.length,
    sources: result.sources.map(({ text: _t, ...rest }) => rest),
    message: result.message,
  });

  const CASES = [
    ["Frage ohne Filter", {}],
    ["Metadatenfilter", { filters: { bookable: true } }],
    ["gelockerte Filter", { filters: { priceMax: 1 } }],
    ["Kursnummer", { input: "Was ist der Kurs I821103?", topN: 2 }],
  ];
  for (const mode of MODES)
    test.each(CASES)(`${mode}: %s`, async (_name, extra) => {
      settings = { search_trace: "on" };
      const run = async (on) => {
        mockRule.on = on;
        mockRerank.mockClear();
        traces = [];
        const result = await search(mode, extra);
        return {
          result,
          rerankCalls: JSON.parse(
            JSON.stringify(mockRerank.mock.calls, (_key, v) =>
              typeof v === "bigint" ? `${v}n` : v
            )
          ),
          trace: timeless(traces),
        };
      };
      const before = await run(false);
      const after = await run(true);

      expect(withoutText(after.result)).toEqual(withoutText(before.result));
      expect(after.rerankCalls).toEqual(before.rerankCalls);
      expect(after.trace).toEqual(before.trace);
      expect(after.trace).toHaveLength(1);
      // Der Reranker sah die eingelesenen Texte (Regel erst danach)
      for (const call of after.rerankCalls)
        for (const doc of call[1]) expect(doc.text).toBe(ORIGINAL[doc.id]);
      // Einziger Unterschied: die Kopfzeile nach der Regel
      after.result.sources.forEach((source, i) => {
        expect(before.result.sources[i].text).toBe(ORIGINAL[source.id]);
        expect(source.text).toBe(EXPECTED[source.id]);
      });
      const offset =
        after.result.contextTexts.length - after.result.sources.length;
      expect(after.result.contextTexts.slice(0, offset)).toEqual(
        before.result.contextTexts.slice(0, offset)
      );
    });

  test("Auswahlstufe und Schalter unverändert: Stufe aus wie an liefert dieselbe Menge mit und ohne Regel", async () => {
    for (const value of ["off", "on"]) {
      settings = { course_selection: value };
      mockRule.on = false;
      const before = await search("rerank", { topN: 3 });
      mockRule.on = true;
      const after = await search("rerank", { topN: 3 });
      expect(ids(after)).toEqual(ids(before));
      expect(after.sources.map((s) => s.score)).toEqual(
        before.sources.map((s) => s.score)
      );
    }
  });
});
