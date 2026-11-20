/* eslint-env jest, node */
/**
 * Variante „Person“ in den Reranker-Pfaden von lance/index.js (AK-6, D2,
 * NAK-3 der Spezifikation issues/kursauswahl-kursleitung.md): Beide Aufrufe
 * von selectContexts bekommen die Suchanfrage, die auch der Reranker bekommt.
 * Gegen eine echte, temporäre LanceDB-Tabelle, mit gemocktem Reranker und
 * gestubbten SystemSettings (Muster wie selectionPaths.test.js).
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.STORAGE_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), "lance-selection-person-")
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
// selectContexts mitschneiden, Verhalten unverändert
jest.mock("../../../../utils/vectorDbProviders/lance/contextSelection", () => {
  const actual = jest.requireActual(
    "../../../../utils/vectorDbProviders/lance/contextSelection"
  );
  return { ...actual, selectContexts: jest.fn(actual.selectContexts) };
});

const { LanceDb } = require("../../../../utils/vectorDbProviders/lance");
const { SystemSettings } = require("../../../../models/systemSettings");
const SearchTrace = require("../../../../utils/vectorDbProviders/lance/searchTrace");
const {
  berlinToday,
  selectContexts,
} = require("../../../../utils/vectorDbProviders/lance/contextSelection");

let settings = {};
jest
  .spyOn(SystemSettings, "getValueOrFallback")
  .mockImplementation(async ({ label } = {}, fallback) =>
    Object.prototype.hasOwnProperty.call(settings, label)
      ? settings[label]
      : fallback
  );

const TODAY = berlinToday();
const inDays = (n) => {
  const d = new Date(`${TODAY}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

const QUERY_VECTOR = [1, 0, 0, 0];
const vec = (i) => [1, 0.02 * (i + 1), 0.01 * i, 0];
const PERSON_QUERY = "Welche Kurse gibt Anna Beispiel?";
const THEMA_QUERY = "Welche Sprachkurse gibt es?";

// Log-Odds zum Führenden b1: f1 0,69 darunter, f2 1,10, b2 1,39, b3 1,51
// (wie der Hauptfall in contextSelectionPerson.test.js)
const SCORES = { b1: 0.999, f1: 0.998, f2: 0.997, b2: 0.996, b3: 0.9955 };
const COURSES = [
  ["b1", 144, "Anna Beispiel"],
  ["f1", 54, "Otto Fremd"],
  ["f2", 1, "Otto Fremd"],
  ["b2", 7, "Anna Beispiel"],
  ["b3", 2, "Anna Beispiel"],
];
const LIST_82 = ["f1", "b1", "f2", "b3"];
const LIST_PERSON = ["b2", "f1", "b1", "f2"];

const scoredRerank = async (query, docs, { topK }) =>
  docs
    .map((d, i) => ({
      ...d,
      rerank_corpus_id: i,
      rerank_score: SCORES[d.id] ?? 0.01,
    }))
    .sort((a, b) => b.rerank_score - a.rerank_score)
    .slice(0, topK);

const lance = new LanceDb();
const mockLLM = { embedTextInput: async () => QUERY_VECTOR };

beforeAll(async () => {
  const { client } = await lance.connect();
  await client.dropTable("sel_person").catch(() => {});
  const rows = COURSES.map(([id, days, leitung], i) => ({
    id,
    // Titel ohne Namen, damit die Suchspur-Prüfung (NAK-3) aussagekräftig ist
    title: `kurs-sprachen-${id}.txt`,
    text: [
      `Titel: Sprachkurs ${"Stufe ".repeat(i + 1)}${id}`,
      `Kursnummer: 26W20${i}`,
      `Kursleitung: ${leitung}`,
      "Kategorie: Sprachen",
    ].join("\n"),
    vector: vec(i),
    start_date: inDays(days),
    end_date: inDays(days + 30),
    bookable: true,
    start_minutes: 1080,
    price: 80,
  }));
  await lance.updateOrCreateCollection(client, rows, "sel_person");
}, 60000);

afterAll(() => {
  fs.rmSync(process.env.STORAGE_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  settings = {};
  mockRerank.mockReset();
  mockRerank.mockImplementation(scoredRerank);
  selectContexts.mockClear();
});

const MODES = ["rerank", "hybrid_rerank"];
const search = (input, searchMode) =>
  lance.performSimilaritySearch({
    namespace: "sel_person",
    input,
    LLMConnector: mockLLM,
    topN: 4,
    searchMode,
  });
const ids = (result) => result.sources.map((s) => s.id);

describe("AK-6: beide Aufrufe von selectContexts reichen die Suchanfrage durch", () => {
  for (const mode of MODES) {
    test(`Frage mit Namen: Kurse der Kursleitung nach Datum (${mode})`, async () => {
      settings = { course_selection: "on" };
      const result = await search(PERSON_QUERY, mode);
      expect(ids(result)).toEqual(LIST_PERSON);
      expect(result.sources.map((s) => s.start_date)).toEqual(
        [7, 54, 144, 1].map(inDays)
      );
      // dieselbe Anfrage wie der Reranker (D2)
      expect(mockRerank).toHaveBeenCalledTimes(1);
      expect(mockRerank.mock.calls[0][0]).toBe(PERSON_QUERY);
      expect(selectContexts).toHaveBeenCalledTimes(1);
      expect(selectContexts.mock.calls[0][1].query).toBe(
        mockRerank.mock.calls[0][0]
      );
    });

    test(`Themenfrage ohne Namen: Liste wie 8.2 (${mode})`, async () => {
      settings = { course_selection: "on" };
      const result = await search(THEMA_QUERY, mode);
      expect(ids(result)).toEqual(LIST_82);
      expect(selectContexts.mock.calls[0][1].query).toBe(THEMA_QUERY);
    });

    test(`Stellgröße 0 über die Env: Liste wie 8.2 (${mode})`, async () => {
      settings = { course_selection: "on" };
      const before = process.env.COURSE_SELECTION_PERSON_LOGIT;
      process.env.COURSE_SELECTION_PERSON_LOGIT = "0";
      try {
        const result = await search(PERSON_QUERY, mode);
        expect(ids(result)).toEqual(LIST_82);
      } finally {
        if (before === undefined)
          delete process.env.COURSE_SELECTION_PERSON_LOGIT;
        else process.env.COURSE_SELECTION_PERSON_LOGIT = before;
      }
    });
  }
});

describe("NAK-3: Suchspur ohne Namen und Fragetext", () => {
  let traces = [];
  beforeEach(() => {
    traces = [];
    jest
      .spyOn(SearchTrace, "writeTrace")
      .mockImplementation((t) => traces.push(JSON.parse(JSON.stringify(t))));
  });
  afterEach(() => SearchTrace.writeTrace.mockRestore());

  for (const mode of MODES) {
    test(`trace.selection.person nur mit Zahlen und Wahrheitswerten (${mode})`, async () => {
      settings = { course_selection: "on", search_trace: "on" };
      const log = jest.spyOn(console, "log");
      const warn = jest.spyOn(console, "warn");
      try {
        await search(PERSON_QUERY, mode);
        await search(THEMA_QUERY, mode);
        expect(traces.map((t) => t.selection.person)).toEqual([
          { matched: true, courses: 3, applied: true },
          { matched: false, courses: 0, applied: false },
        ]);
        expect(traces[0].selection.rule).toBe(
          "stufe-span0.02-logit1-floor0.3-deckel1-person1.5"
        );
        const json = JSON.stringify(traces).toLowerCase();
        expect(json).not.toContain("beispiel");
        expect(json).not.toContain("welche kurse");
        // kein Log-Eintrag mit Namen oder Fragetext
        const logged = [...log.mock.calls, ...warn.mock.calls]
          .flat()
          .map((x) => String(x).toLowerCase())
          .join("\n");
        expect(logged).not.toContain("beispiel");
      } finally {
        log.mockRestore();
        warn.mockRestore();
      }
    });
  }
});
