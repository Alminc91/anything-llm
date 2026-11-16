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

const lancedb = require("@lancedb/lancedb");
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
  // Tabelle sel_knr (NAK-1: Kursnummer auf Warteliste), alle gleich relevant
  kw: 1.0,
  kn1: 1.0,
  kn2: 1.0,
  kn3: 1.0,
  kn4: 1.0,
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
  // Warteliste-Kurs: gestartet, bookable=false (Kufer-Status 4). Text/Titel
  // stammen aus der ersten Fassung („abgelaufen“) und bleiben unverändert,
  // weil die Byte-gleich-Snapshots gegen origin/master damit aufgenommen sind.
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

// NAK-1: Yoga-Kurse mit Kursnummer im Kopf, alle mit Score 1,0. Der
// Warteliste-Kurs „kw“ steht in der Vektorsuche vorn (exakt der
// Suchvektor), die vier buchbaren beginnen in 10 bis 40 Tagen.
const knrText = (knr, status, i) =>
  [
    "<document_metadata>",
    `sourceDocument: kurs-${knr.toLowerCase()}.txt`,
    "</document_metadata>",
    "",
    "Titel: Yoga am Abend",
    `Kursnummer: ${knr}`,
    `Kursstatus: ${status}`,
    "",
    `Kursbeschreibung: Yoga am Abend ${"Entspannung ".repeat(i + 1)}`,
  ].join("\n");
async function makeKnrTable(ns, { withIndex = true } = {}) {
  const { client } = await lance.connect();
  await client.dropTable(ns).catch(() => {});
  const row = (id, knr, vector, days, bookable, i) => ({
    id,
    title: `kurs-yoga-${id}.txt`,
    text: knrText(knr, bookable ? "Anmeldung möglich" : "Warteliste", i),
    vector,
    start_date: inDays(days),
    end_date: inDays(days + 60),
    bookable,
    start_minutes: 1080,
    price: 80,
  });
  const rows = [
    row("kw", "26W1001", [1, 0, 0, 0], -20, false, 0),
    ...[1, 2, 3, 4].map((k) =>
      row(`kn${k}`, `26W100${k + 1}`, vec(k), 10 * k, true, k)
    ),
  ];
  // ohne Volltextindex: Tabelle direkt anlegen (Bestand vor KIE-471)
  if (withIndex) await lance.updateOrCreateCollection(client, rows, ns);
  else await client.createTable(ns, rows);
}

beforeAll(async () => {
  await makeKnrTable("sel_knr");
  await makeKnrTable("sel_knr_ohne_index", { withIndex: false });
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
      // Warteliste-Kurs bleibt drin, wenn er heute drin war (keine Stufe)
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
    // wenn im Pool weitere frühe Kurse (p3, p4) bereitstehen. Die
    // Stufenregel wählt sie aus den zulässigen: p3 (0,95, in 3 Tagen) ist
    // gleich relevant zu p1 (0,97), danach p2 (50 Tage) vor p1 (60 Tage).
    expect(result.sources).toHaveLength(today.sources.length);
    expect(got).toEqual(["p3", "p2"]);
    expect(result.sources.map((s) => s.start_date)).toEqual([
      inDays(3),
      inDays(50),
    ]);
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

// Heutige Top-4 (Snapshots „schalter-aus“): rerank alt,k1,k2,k3 —
// hybrid_rerank k1,k2,alt,k3 (alle Score 1,0). Stufenregel: alle Kurse mit
// Score 1,0 sind gleich relevant (k6 mit 0,95 nicht); die künftigen,
// buchbaren kommen nach Beginn (k5 in 18, k3 in 26, k2 in 48, k4 in 53
// Tagen), der Warteliste-Kurs „alt“ und k1 (88 Tage) weichen ihnen. Die
// Ausgabe folgt dieser Ordnung (AK-5); `out` in der Reihenfolge der
// heutigen Top-4.
const FRANZ = {
  rerank: { ids: ["k5", "k3", "k2", "k4"], out: ["alt", "k1"] },
  hybrid_rerank: { ids: ["k5", "k3", "k2", "k4"], out: ["k1", "alt"] },
};
const FRANZ_DAYS = [18, 26, 48, 53];

describe("Auswahlstufe aktiv (course_selection = on, Kursmetadaten)", () => {
  for (const mode of MODES) {
    test(`franzoesisch-pfad (${mode})`, async () => {
      settings = { course_selection: "off" };
      const today = await search("sel_kurse", mode);
      expect(ids(today)).toContain("alt");
      mockRerank.mockClear();
      settings = { course_selection: "on" };
      const result = await search("sel_kurse", mode);
      expect(ids(result)).toEqual(FRANZ[mode].ids);
      // AK-5: Quellen und Kontexte in der Ordnung der Stufenregel
      expect(result.sources.map((s) => s.start_date)).toEqual(
        FRANZ_DAYS.map(inDays)
      );
      // aus den heutigen Top-4 fallen nur der Warteliste-Kurs und k1 heraus
      expect(ids(today).filter((id) => !ids(result).includes(id))).toEqual(
        FRANZ[mode].out
      );
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
    expect(ids(result)).toEqual(FRANZ.hybrid_rerank.ids);
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

describe("NAK-1: Kursnummer-Treffer stehen vor der Auswahl", () => {
  for (const mode of MODES) {
    test(`gefragter Warteliste-Kurs steht vorn (${mode})`, async () => {
      settings = { course_selection: "on" };
      // Vorbedingung: ohne Kursnummer weicht der Warteliste-Kurs den vier
      // gleich relevanten buchbaren Kursen
      const plain = await search("sel_knr", mode, { input: "Yoga am Abend" });
      expect(ids(plain)).toEqual(["kn1", "kn2", "kn3", "kn4"]);
      const asked = await search("sel_knr", mode, {
        input: "Ist der Kurs 26W1001 noch frei?",
      });
      expect(ids(asked)).toEqual(["kw", "kn1", "kn2", "kn3"]);
      expect(asked.sources[0].bookable).toBe(false);
      expect(asked.contextTexts[0]).toContain("Kursnummer: 26W1001");
    });
  }
});

describe("K-R2 und D8: Kursnummernsuche ohne Treffer", () => {
  // Die Stufe schützt einen per Kursnummer gefragten Kurs nicht selbst (D8);
  // bleibt die Kursnummernsuche still ohne Treffer, fällt der gefragte
  // Warteliste-Kurs bei vier gleich relevanten buchbaren Kursen heraus. Der
  // Rückfall steht einmal je Tabelle und Prozess im Log.
  const ASKED = "Ist der Kurs 26W1001 noch frei?";
  const lookupWarnings = (warn) =>
    warn.mock.calls
      .map(([message]) => String(message))
      .filter((message) => message.startsWith("[Kursnummernsuche]"));
  let traces = [];
  let warn;
  beforeEach(() => {
    traces = [];
    jest
      .spyOn(SearchTrace, "writeTrace")
      .mockImplementation((t) => traces.push(JSON.parse(JSON.stringify(t))));
    warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    SearchTrace.writeTrace.mockRestore();
    warn.mockRestore();
  });

  test("ohne Volltextindex: gefragter Warteliste-Kurs fehlt, Hinweis einmal im Log", async () => {
    settings = { course_selection: "on", search_trace: "on" };
    for (const mode of MODES) {
      const result = await search("sel_knr_ohne_index", mode, {
        input: ASKED,
      });
      expect(ids(result)).toEqual(["kn1", "kn2", "kn3", "kn4"]);
    }
    expect(traces.map((t) => t.courseNumbers.skipped)).toEqual([
      "no_fts_index",
      "no_fts_index",
    ]);
    const messages = lookupWarnings(warn);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/"sel_knr_ohne_index"/);
    expect(messages[0]).toMatch(/Volltextindex/);
  });

  test("Abfrage wirft: gefragter Warteliste-Kurs fehlt, Hinweis einmal im Log", async () => {
    settings = { course_selection: "on", search_trace: "on" };
    // im Modus rerank läuft die Volltextsuche nur in der Kursnummernsuche
    const queryProto = Object.getPrototypeOf(lancedb.Query.prototype);
    const fts = jest
      .spyOn(queryProto, "fullTextSearch")
      .mockImplementation(() => {
        throw new Error("Volltextsuche nicht verfügbar");
      });
    const log = jest.spyOn(console, "log").mockImplementation(() => {});
    try {
      for (let run = 0; run < 2; run++) {
        const result = await search("sel_knr", "rerank", { input: ASKED });
        expect(ids(result)).toEqual(["kn1", "kn2", "kn3", "kn4"]);
      }
    } finally {
      fts.mockRestore();
      log.mockRestore();
    }
    expect(traces.map((t) => t.courseNumbers.error)).toEqual([
      "Volltextsuche nicht verfügbar",
      "Volltextsuche nicht verfügbar",
    ]);
    const messages = lookupWarnings(warn);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/"sel_knr"/);
    expect(messages[0]).toMatch(/fehlgeschlagen/);
    expect(messages[0]).not.toMatch(/Volltextsuche nicht verfügbar/);
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
        reordered: true,
        rule: "stufe-span0.02-floor0.3-deckel1",
        today: TODAY,
        poolTopK: 12,
      });
      const swap = (id, naehe, state = "zukuenftig") => ({
        id,
        title: `kurs-franzoesisch-${id}.txt`,
        score: 1,
        naehe,
        state,
        kind: "kurs",
        reason: "datum",
        rerankRank: expect.any(Number),
      });
      // eingewechselt in Ausgabereihenfolge, ausgewechselt in der Reihenfolge
      // der heutigen Top-4; der Warteliste-Kurs „alt“ weicht gleich
      // relevanten buchbaren Kursen
      expect(sel.swappedIn).toEqual([swap("k5", 18), swap("k4", 53)]);
      const outs = {
        alt: swap("alt", null, "warteliste"),
        k1: swap("k1", 88),
      };
      expect(sel.swappedOut).toEqual(FRANZ[mode].out.map((id) => outs[id]));
      // final = ausgelieferte Dokumente, keine Chunk-Volltexte im Trace
      expect(traces[0].final.count).toBe(4);
      expect(JSON.stringify(traces[0])).not.toContain("Termin Termin");
    });

    test(`K-R3: trace.final.rerankRank ist der Rang vor der Stufe (${mode})`, async () => {
      // Liste des Rerankers mitschneiden; im Modus rerank sieht die Stufe nur
      // die zulässigen Zeilen („fern“ liegt unter der Ähnlichkeitsschwelle)
      let pool = [];
      mockRerank.mockImplementation(
        async (...args) => (pool = await scoredRerank(...args))
      );
      const visible = () =>
        (mode === "rerank" ? pool.filter((r) => r.id !== "fern") : pool).map(
          (r) => r.id
        );
      settings = { course_selection: "on", search_trace: "on" };
      await search("sel_kurse", mode);
      const on = traces[0].final.docs;
      expect(on.map((d) => d.id)).toEqual(FRANZ[mode].ids);
      expect(on.map((d) => d.rerankRank)).toEqual(
        on.map((d) => visible().indexOf(d.id))
      );
      // die Stufe hat umgeordnet: Rang vor der Stufe ≠ Endposition
      expect(on.some((d) => d.rerankRank !== d.finalRank - 1)).toBe(true);
      expect(on.every((d) => Number.isInteger(d.rerankRank))).toBe(true);

      // Stufe aus: Rang vor der Stufe = Endposition
      settings = { course_selection: "off", search_trace: "on" };
      await search("sel_kurse", mode);
      const off = traces[1].final.docs;
      expect(off.map((d) => d.rerankRank)).toEqual(
        off.map((d) => d.finalRank - 1)
      );
      expect(off.map((d) => d.rerankRank)).toEqual(
        off.map((d) => visible().indexOf(d.id))
      );

      // Treffer der Kursnummernsuche, den die Stufe nicht gewählt hatte:
      // kein Rang des Rerankers (null); die übrigen behalten ihren Rang
      settings = { course_selection: "on", search_trace: "on" };
      await search("sel_knr", mode, {
        input: "Ist der Kurs 26W1001 noch frei?",
      });
      const knr = traces[2].final.docs;
      expect(knr.map((d) => d.id)).toEqual(["kw", "kn1", "kn2", "kn3"]);
      expect(knr[0].rerankRank).toBeNull();
      expect(knr.slice(1).map((d) => d.rerankRank)).toEqual(
        knr.slice(1).map((d) => pool.map((r) => r.id).indexOf(d.id))
      );
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
