/* eslint-env jest, node */
/**
 * Auswahlstufe in den Reranker-Pfaden von lance/index.js — gegen eine echte,
 * temporäre LanceDB-Tabelle, mit gemocktem Reranker und gestubbten
 * SystemSettings.
 *
 * Die Snapshot-Tests (schalter-aus, degradiert, ohne-metadaten, wenige-kurse,
 * threshold-pin schalter-aus) wurden gegen den UNVERÄNDERTEN Stand origin/master 4662ddfe aufgenommen —
 * sie belegen, dass das Ergebnis in diesen Fällen byte-gleich zu heute bleibt.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.STORAGE_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), "lance-selection-")
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

// Feste Kalenderdaten relativ zu "heute" (Europe/Berlin), damit die Tests an
// jedem Tag dieselbe Auswahl treffen.
const TODAY = berlinToday();
const inDays = (n) => {
  const d = new Date(`${TODAY}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

const QUERY = "Intensivkurs Französisch";
const QUERY_VECTOR = [1, 0, 0, 0];
const vec = (i) => [1, 0.02 * (i + 1), 0.01 * i, 0];

// Reranker-Scores je Dokument-id (Französisch-Fall aus der Messung).
const SCORES = {
  k1: 1.0,
  k2: 1.0,
  k3: 1.0,
  k4: 1.0,
  k5: 1.0,
  k6: 0.95,
  alt: 1.0,
  u1: 0.97,
  u2: 0.6,
  fern: 0.98,
  // Tabelle sel_pin (Threshold/Pin im rerank-Pfad)
  tief: 0.99,
  pin: 0.985,
  p1: 0.97,
  p2: 0.96,
  p3: 0.95,
  p4: 0.94,
  pu1: 0.5,
};
const COURSES = [
  ["k1", 88],
  ["k2", 48],
  ["k3", 26],
  ["k4", 53],
  ["k5", 18],
  ["k6", 68],
];

const infoRows = () => [
  {
    id: "u1",
    title: "programm_sprachen_kategorie.html",
    text: "Intensivkurs Französisch Übersicht Sprachen Kategorie Seite eins",
    vector: vec(10),
  },
  {
    id: "u2",
    title: "programm_kultur_kategorie.html",
    text: "Französisch Kultur Programm",
    vector: vec(11),
  },
  // Kosinus-Ähnlichkeit ≈ 0,2 < 0,25 → im rerank-Pfad am similarityThreshold
  // verworfen, obwohl der Reranker ihn hoch bewertet
  {
    id: "fern",
    title: "fern.html",
    text: "Intensivkurs Französisch ganz anderes Thema",
    vector: [0.2, 1, 0, 0],
  },
];
const courseRows = () => [
  ...COURSES.map(([id, days], i) => ({
    id,
    title: `kurs-franzoesisch-${id}.txt`,
    // unterschiedliche Längen → keine BM25-Gleichstände (deterministische
    // RRF-Reihenfolge; LanceDB ordnet FTS-Gleichstände beliebig)
    text: `Intensivkurs Französisch ${"Termin ".repeat(i + 1)}${id}`,
    vector: vec(i),
    start_date: inDays(days),
    end_date: inDays(days),
    bookable: true,
    start_minutes: 1080,
    price: 120.5,
  })),
  {
    id: "alt",
    title: "kurs-franzoesisch-alt.txt",
    text: "Intensivkurs Französisch abgelaufen Termin Termin Termin Termin Termin Termin Termin Termin",
    // exakt der Query-Vektor → steht bei Score-Gleichstand vorn (heute: Top-4)
    vector: [1, 0, 0, 0],
    start_date: inDays(-30),
    end_date: inDays(-30),
    bookable: false,
    start_minutes: 600,
    price: 99,
  },
];

const scoredRerank = async (query, docs, { topK }) =>
  docs
    .map((d, i) => ({
      ...d,
      rerank_corpus_id: i,
      rerank_score: SCORES[d.id] ?? 0.01,
    }))
    .sort((a, b) => b.rerank_score - a.rerank_score)
    .slice(0, topK);
// Graceful-Degradation-Vertrag des GenericReranker: unverändert, ohne Score.
const degradedRerank = async (query, docs, { topK }) => docs.slice(0, topK);

const lance = new LanceDb();
const mockLLM = { embedTextInput: async () => QUERY_VECTOR };

async function makeTable(ns, { withCourses = true, onlyOneCourse = false }) {
  const { client } = await lance.connect();
  await client.dropTable(ns).catch(() => {});
  // Bestandsfall: Tabelle ohne Kursspalten, Kurse kommen per Migration dazu.
  await lance.updateOrCreateCollection(client, infoRows(), ns);
  if (withCourses) {
    const courses = onlyOneCourse ? courseRows().slice(0, 1) : courseRows();
    await lance.updateOrCreateCollection(client, courses, ns);
  }
}

const search = (ns, searchMode, extra = {}) =>
  lance.performSimilaritySearch({
    namespace: ns,
    input: QUERY,
    LLMConnector: mockLLM,
    topN: 4,
    searchMode,
    ...extra,
  });
const ids = (result) => result.sources.map((s) => s.id);

// 40 Kurs-Kandidaten für den Reranker-Pool (AK-7)
async function makeManyTable(ns) {
  const { client } = await lance.connect();
  await client.dropTable(ns).catch(() => {});
  const rows = Array.from({ length: 40 }, (_, i) => ({
    id: `m${i}`,
    title: `kurs-m${i}.txt`,
    text: `Intensivkurs Französisch ${"Termin ".repeat(i + 1)}m${i}`,
    vector: [1, 0.01 * (i + 1), 0, 0],
    start_date: inDays(10 + i),
    end_date: inDays(10 + i),
    bookable: true,
    start_minutes: 600,
    price: 50,
  }));
  await lance.updateOrCreateCollection(client, rows, ns);
}

// Threshold/Pin im rerank-Pfad: in den Reranker-Top-4 stehen ein Kurs unter
// dem similarityThreshold („tief“, Start morgen) und ein Kurs aus einem
// gepinnten Dokument („pin“) — beide dürfen nie ausgeliefert werden.
// `published` ohne ISO-Datum, damit die Snapshot-Normalisierung es nicht als
// Termin umschreibt.
const PUBLISHED = "1/1/2026, 10:00:00 AM";
const PIN_TITLE = "kurs-franzoesisch-pin.txt";
const PIN_IDENTIFIER = `title:${PIN_TITLE}-timestamp:${PUBLISHED}`;
async function makePinTable(ns) {
  const { client } = await lance.connect();
  await client.dropTable(ns).catch(() => {});
  await lance.updateOrCreateCollection(
    client,
    [
      {
        id: "pu1",
        title: "programm_sprachen_pin.html",
        text: "Intensivkurs Französisch Übersicht",
        vector: vec(10),
        published: PUBLISHED,
      },
    ],
    ns
  );
  const course = (id, title, vector, days, i) => ({
    id,
    title,
    text: `Intensivkurs Französisch ${"Termin ".repeat(i + 1)}${id}`,
    vector,
    published: PUBLISHED,
    start_date: inDays(days),
    end_date: inDays(days),
    bookable: true,
    start_minutes: 600,
    price: 80,
  });
  await lance.updateOrCreateCollection(
    client,
    [
      // Kosinus-Ähnlichkeit ≈ 0,2 < 0,25
      course("tief", "kurs-franzoesisch-tief.txt", [0.2, 1, 0, 0], 1, 0),
      course("pin", PIN_TITLE, vec(1), 2, 1),
      course("p1", "kurs-franzoesisch-p1.txt", vec(2), 60, 2),
      course("p2", "kurs-franzoesisch-p2.txt", vec(3), 50, 3),
      course("p3", "kurs-franzoesisch-p3.txt", vec(4), 3, 4),
      course("p4", "kurs-franzoesisch-p4.txt", vec(5), 4, 5),
    ],
    ns
  );
}

beforeAll(async () => {
  await makeManyTable("sel_viele");
  await makePinTable("sel_pin");
  await makeTable("sel_kurse", {});
  await makeTable("sel_ohne_meta", { withCourses: false });
  await makeTable("sel_ein_kurs", { onlyOneCourse: true });
}, 60000);

afterAll(() => {
  // Temp-Speicher des Tests wieder entfernen
  fs.rmSync(process.env.STORAGE_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  settings = {};
  mockRerank.mockReset();
  mockRerank.mockImplementation(scoredRerank);
});

const MODES = ["rerank", "hybrid_rerank"];

describe("Byte-gleich zu heute (Snapshots aus origin/master)", () => {
  // Die Snapshots enthalten Termine relativ zu heute — für den Vergleich
  // werden sie auf Tagesabstände normalisiert.
  const normalize = (result) =>
    JSON.parse(
      JSON.stringify(result).replace(/\d{4}-\d{2}-\d{2}/g, (d) => {
        const diff = Math.round(
          (Date.parse(`${d}T00:00:00Z`) - Date.parse(`${TODAY}T00:00:00Z`)) /
            86400000
        );
        return `heute${diff >= 0 ? "+" : ""}${diff}`;
      })
    );

  for (const mode of MODES) {
    test(`schalter-aus (${mode})`, async () => {
      settings = { course_selection: "off" };
      const result = await search("sel_kurse", mode);
      expect(normalize(result)).toMatchSnapshot();
      expect(mockRerank.mock.calls.map((c) => c[2])).toEqual([{ topK: 4 }]);
    });

    test(`degradiert (${mode})`, async () => {
      settings = { course_selection: "on" };
      mockRerank.mockImplementation(degradedRerank);
      const result = await search("sel_kurse", mode);
      expect(normalize(result)).toMatchSnapshot();
      // abgelaufener Kurs bleibt drin, wenn er heute drin war (keine Stufe)
    });

    test(`ohne-metadaten (${mode})`, async () => {
      settings = { course_selection: "on" };
      const result = await search("sel_ohne_meta", mode);
      expect(normalize(result)).toMatchSnapshot();
      expect(mockRerank.mock.calls.map((c) => c[2])).toEqual([{ topK: 4 }]);
    });

    test(`wenige-kurse (${mode})`, async () => {
      settings = { course_selection: "on" };
      const result = await search("sel_ein_kurs", mode);
      expect(normalize(result)).toMatchSnapshot();
    });
  }

  test("threshold-pin schalter-aus (rerank)", async () => {
    settings = { course_selection: "off" };
    const result = await search("sel_pin", "rerank", {
      filterIdentifiers: [PIN_IDENTIFIER],
    });
    expect(normalize(result)).toMatchSnapshot();
    expect(mockRerank.mock.calls.map((c) => c[2])).toEqual([{ topK: 4 }]);
  });
});

describe("rerank-Pfad: similarityThreshold und gepinnte Dokumente", () => {
  const PIN_EXTRA = { filterIdentifiers: [PIN_IDENTIFIER] };

  test("Reranker-Top-4 mit Kurs unter Threshold + gepinntem Kurs → beide fehlen, Anzahl wie heute", async () => {
    settings = { course_selection: "off" };
    const today = await search("sel_pin", "rerank", PIN_EXTRA);
    // Vorbedingung: beide stehen in den Reranker-Top-4
    const [, docs, opts] = mockRerank.mock.calls[0];
    const top4 = (await scoredRerank(QUERY, docs, opts)).map((d) => d.id);
    expect(top4).toEqual(["tief", "pin", "p1", "p2"]);
    expect(ids(today)).toEqual(["p1", "p2"]);

    mockRerank.mockClear();
    settings = { course_selection: "on" };
    const result = await search("sel_pin", "rerank", PIN_EXTRA);
    expect(mockRerank.mock.calls.map((c) => c[2])).toEqual([{ topK: 12 }]);
    const got = ids(result);
    expect(got).not.toContain("tief");
    expect(got).not.toContain("pin");
    // todaysCount: 2 der ersten 4 sind zulässig → genau 2 Dokumente, auch
    // wenn im Pool weitere frühe Kurse (p3, p4) bereitstehen
    expect(result.sources).toHaveLength(today.sources.length);
    expect(got).toEqual(["p1", "p2"]);
    expect(result).toEqual(today);
  });

  test("ohne Pin zählt nur der Threshold-Ausfall → 3 Dokumente wie heute", async () => {
    settings = { course_selection: "off" };
    const today = await search("sel_pin", "rerank");
    expect(ids(today)).toEqual(["pin", "p1", "p2"]);
    settings = { course_selection: "on" };
    const result = await search("sel_pin", "rerank");
    expect(ids(result)).not.toContain("tief");
    expect(result.sources).toHaveLength(3);
  });
});

describe("Kandidaten-Zeilen tragen die KIE-480-Spalten", () => {
  for (const mode of MODES) {
    test(`Reranker sieht start_date/bookable (${mode})`, async () => {
      await search("sel_kurse", mode);
      const docs = mockRerank.mock.calls[0][1];
      const k5 = docs.find((d) => d.id === "k5");
      expect(k5).toMatchObject({ start_date: inDays(18), bookable: true });
      const u1 = docs.find((d) => d.id === "u1");
      expect(u1.start_date).toBeNull();
      if (mode === "hybrid_rerank")
        expect(docs.every((d) => !("vector" in d))).toBe(true);
    });
  }
});

describe("Auswahlstufe aktiv (course_selection = on, Kursmetadaten)", () => {
  for (const mode of MODES) {
    test(`franzoesisch-pfad (${mode})`, async () => {
      settings = { course_selection: "on" };
      const result = await search("sel_kurse", mode);
      // heute: abgelaufener Kurs + k1..k3; jetzt: alt raus, k1/k2 fest,
      // dazu die frühesten im Band (k5 in 18 Tagen, k3 in 26 Tagen)
      expect(ids(result)).toEqual(["k1", "k2", "k3", "k5"]);
      expect(result.sources.every((s) => s.bookable !== false)).toBe(true);
      expect(result.sources.every((s) => !("vector" in s))).toBe(true);
      expect(result.sources.map((s) => s.score)).toEqual([1, 1, 1, 1]);
      expect(result.contextTexts).toEqual(result.sources.map((s) => s.text));
      expect(mockRerank.mock.calls.map((c) => c[2])).toEqual([{ topK: 12 }]);
    });

    test(`reranker-pool topK ≥ 12 bei 40 Kandidaten (${mode})`, async () => {
      settings = { course_selection: "on" };
      const result = await search("sel_viele", mode);
      expect(mockRerank).toHaveBeenCalledTimes(1);
      const [, docs, opts] = mockRerank.mock.calls[0];
      expect(opts.topK).toBeGreaterThanOrEqual(12);
      if (mode === "hybrid_rerank") expect(docs).toHaveLength(40);
      expect(result.sources.length).toBeLessThanOrEqual(4);
      expect(result.sources).toHaveLength(4);
    });
  }

  test("ohne gespeicherten Wert ist die Stufe an (courseSelectionDefault)", async () => {
    settings = {};
    const result = await search("sel_kurse", "hybrid_rerank");
    expect(ids(result)).toEqual(["k1", "k2", "k3", "k5"]);
  });

  test("Default- und hybrid-Modus lösen die Stufe nicht auf", async () => {
    settings = { course_selection: "on" };
    SystemSettings.getValueOrFallback.mockClear();
    for (const mode of ["default", "hybrid"]) await search("sel_kurse", mode);
    const labels = SystemSettings.getValueOrFallback.mock.calls.map(
      (c) => c[0]?.label
    );
    expect(labels).not.toContain("course_selection");
    expect(mockRerank).not.toHaveBeenCalled();
  });
});

describe("Search-Trace: trace.selection (AK-8)", () => {
  let traces = [];
  beforeEach(() => {
    traces = [];
    jest
      .spyOn(SearchTrace, "writeTrace")
      .mockImplementation((t) => traces.push(JSON.parse(JSON.stringify(t))));
  });
  afterEach(() => SearchTrace.writeTrace.mockRestore());

  for (const mode of MODES) {
    test(`searchTrace-selection (${mode})`, async () => {
      settings = { course_selection: "on", search_trace: "on" };
      await search("sel_kurse", mode);
      expect(traces).toHaveLength(1);
      const sel = traces[0].selection;
      expect(sel).toMatchObject({
        active: true,
        reason: null,
        courseQuery: true,
        changed: true,
        rule: "keep2-band0.1-floor0.3-deckel1",
        today: TODAY,
        poolTopK: 12,
      });
      expect(sel.swappedIn).toEqual([
        {
          id: "k5",
          title: "kurs-franzoesisch-k5.txt",
          score: 1,
          naehe: 18,
          state: "zukuenftig",
          kind: "kurs",
          reason: "datum",
        },
      ]);
      expect(sel.swappedOut).toEqual([
        {
          id: "alt",
          title: "kurs-franzoesisch-alt.txt",
          score: 1,
          naehe: null,
          state: "vorbei",
          kind: "kurs",
          reason: "vorbei",
        },
      ]);
      // final = ausgelieferte Dokumente, keine Chunk-Volltexte im Trace
      expect(traces[0].final.count).toBe(4);
      expect(JSON.stringify(traces[0])).not.toContain("Termin Termin");
    });

    test(`searchTrace-selection Stichtag Europe/Berlin (${mode})`, async () => {
      // 23:30 UTC am 07.10. ist in Berlin schon der 08.10. — nur die Uhr
      // (Date) wird festgesetzt, Timer/Microtasks bleiben echt (Lance-I/O).
      jest.useFakeTimers({
        now: new Date("2026-10-07T23:30:00Z"),
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
      try {
        settings = { course_selection: "on", search_trace: "on" };
        await search("sel_kurse", mode);
      } finally {
        jest.useRealTimers();
      }
      expect(traces).toHaveLength(1);
      expect(traces[0].selection.active).toBe(true);
      expect(traces[0].selection.today).toBe("2026-10-08");
    });

    test(`searchTrace-selection aus/ohne Metadaten (${mode})`, async () => {
      settings = { course_selection: "off", search_trace: "on" };
      await search("sel_kurse", mode);
      settings = { course_selection: "on", search_trace: "on" };
      await search("sel_ohne_meta", mode);
      expect(traces.map((t) => t.selection)).toEqual([
        { active: false, reason: "off", poolTopK: 4 },
        { active: false, reason: "no_metadata", poolTopK: 4 },
      ]);
    });
  }
});
