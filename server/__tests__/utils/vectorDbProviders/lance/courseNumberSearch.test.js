/* eslint-env jest, node */
/**
 * Kursnummern-Erkennung (issues/kursnummer-erkennung.md) in der Suche, gegen
 * eine echte, temporäre LanceDB-Tabelle wie courseInventoryExclusion.test.js,
 * mit Reranker-Testdouble und gestubbten SystemSettings.
 *
 * Aufbau der Tabelle: Seiten nahe am Suchvektor, die die Wörter der Frage
 * tragen (Zeitung, Kursnummer, Kurs …), und Kursdokumente fern vom
 * Suchvektor. Damit findet die Suche mit der ganzen Frage den Kurs mit der
 * genannten Nummer nicht (wie live in Delmenhorst am 11.11.2026, Vorbedingung
 * unten), erst die gezielte Suche nach der Nummer bringt ihn nach vorn.
 *
 * Die Snapshot-Tests (Fragen ohne Kursnummer, Zahlen ohne Kursdokument,
 * unbekannte Kursnummer, Tabelle ohne Volltextindex) wurden gegen den
 * UNVERÄNDERTEN Stand origin/master 202092427 aufgenommen: Sie belegen, dass
 * das Ergebnis in diesen Fällen gleich bleibt (NAK-1, AK-4, AK-5, AK-6).
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.STORAGE_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), "lance-kursnummer-")
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
// Ausschluss veralteter Kurse (Kursbestand): je Test gesetzt, sonst null
const mockExclusion = jest.fn(async () => null);
jest.mock("../../../../utils/chats/courseInventory", () => {
  const actual = jest.requireActual("../../../../utils/chats/courseInventory");
  return {
    ...actual,
    courseSearchExclusion: (...args) => mockExclusion(...args),
  };
});

const lancedb = require("@lancedb/lancedb");
const { LanceDb } = require("../../../../utils/vectorDbProviders/lance");
const { SystemSettings } = require("../../../../models/systemSettings");
const SearchTrace = require("../../../../utils/vectorDbProviders/lance/searchTrace");
const { fillSourceWindow } = require("../../../../utils/helpers/chat");
const {
  courseNumberSearchPlan,
} = require("../../../../utils/vectorDbProviders/lance/courseNumberLookup");

let settings = {};
jest
  .spyOn(SystemSettings, "getValueOrFallback")
  .mockImplementation(async ({ label } = {}, fallback) =>
    Object.prototype.hasOwnProperty.call(settings, label)
      ? settings[label]
      : fallback
  );

const NS = "kursnummern";
const NS_NOINDEX = "kursnummern_ohne_index";
const NS_PIN = "kursnummern_angeheftet";
const NS_PARTS = "kursnummern_teile";
const QUERY_VECTOR = [1, 0, 0, 0];
const MODES = ["default", "rerank", "hybrid", "hybrid_rerank"];
const QUESTION =
  "Ich habe in der Zeitung die Kursnummer 26B7602 gesehen. Was ist das für ein Kurs?";

// nahe am Suchvektor, alle verschieden
const near = (i) => [1, 0.01 * (i + 1), 0.003 * i, 0];
// fern vom Suchvektor (Kosinus klein, aber positiv), alle verschieden
const far = (i) => [0.05, 0.002 * i, 1, 0.01 * i];

const header = (knr, title, { description = "", price = "130,90" } = {}) =>
  [
    "<document_metadata>",
    `sourceDocument: kurs-${knr.toLowerCase()}.txt`,
    "</document_metadata>",
    "",
    `Titel: ${title}`,
    `Kursnummer: ${knr}`,
    "Kursstatus: Anmeldung möglich",
    `Kursgebühr: ${price}`,
    "Beginn: Mo. 14.09.2026, 18:15 Uhr",
    `Kurs-Link: https://www.vhs-beispiel.de/kurssuche/kurs/x/${knr}`,
    "",
    `Kursbeschreibung: ${title}. ${description}`,
  ].join("\n");

// Formate aus der Flotte (Spezifikation Abschnitt 1)
const FORMATS = [
  "26B7602",
  "262-30748",
  "XI57261",
  "27S445311",
  "NTU40616R",
  "F320241",
  "261-G-071",
  "27-83520A",
  "T7411A",
  "26C008508",
  "NSP10601C",
  "26H43362",
];
const courseId = (knr) => `c-${knr.toLowerCase()}`;

const COURSES = FORMATS.map((knr, i) => ({
  id: courseId(knr),
  title: `Kurs ${knr}`,
  text: header(knr, `Kurs Nummer ${i} Thema ${"Inhalt ".repeat(i + 1)}`),
  vector: far(i),
  price: 130.9,
}));

// ähnliche Nummern und Nummern nur im Freitext: dürfen nie als Treffer zählen
const LOOKALIKES = [
  ["26B7603", "Spanisch A2"],
  ["26B760", "Spanisch A1.1"],
  ["26B76021", "Spanisch A1.3"],
  ["262-30749", "Englisch B1"],
  ["27749A", "Delmenhorster Geschichte"],
  ["T7411", "Töpfern"],
].map(([knr, title], i) => ({
  id: `ähnlich-${i}`,
  title: `Kurs ${knr}`,
  text: header(knr, title, { description: "Weitere Angaben ".repeat(i + 1) }),
  vector: far(20 + i),
  price: 99,
}));
const FREE_TEXT = [
  {
    id: "frei-beschreibung",
    title: "Kurs 26B7699",
    text: header("26B7699", "Spanisch A1.2 Folgekurs", {
      description:
        "Fortsetzung des Kurses mit der Kursnummer: 26B7602 aus dem Frühjahr.",
    }),
    vector: far(30),
    price: 99,
  },
  {
    id: "frei-uebersicht",
    title: "programm_sprachen.html",
    text: "Sprachen im Programmheft\nSpanisch A1.2 26B7602\nSpanisch A2 26B7603\nEnglisch B1 262-30749",
    vector: far(31),
    price: 0,
  },
  {
    id: "frei-kontakt",
    title: "kontakt.html",
    text: "Kontakt: vhs, Am Turbinenhaus 11, 27749 Delmenhorst, Telefon 04221 9923-0, Programm 2026",
    vector: far(32),
    price: 0,
  },
];
// Altdokument: dieselbe Nummer in zwei Dokumenten (Risiko in der Spezifikation)
const DUPLICATES = [
  {
    id: "dup-neu",
    title: "Kurs DUP4711 neu",
    text: header("DUP4711", "Aquarell neu"),
    vector: far(40),
    price: 50,
  },
  {
    id: "dup-alt",
    title: "Kurs DUP4711 alt",
    text: header("DUP4711", "Aquarell alt", {
      description: "Alte Fassung mit längerem Text ".repeat(3),
    }),
    vector: far(41),
    price: 50,
  },
];
// Seiten nahe am Suchvektor, mit den Wörtern der Frage
const PAGES = Array.from({ length: 14 }, (_, i) => ({
  id: `seite-${i}`,
  title: `seite-${i}.html`,
  text: `Zeitung ${i}: Was ist das für ein Kurs? Ich habe in der Zeitung die Kursnummer gesehen. ${"Kurs Zeitung gesehen ".repeat(1 + (i % 4))}${"Hinweis ".repeat(i)}`,
  vector: near(i),
  price: 10,
}));

const ROWS = [...PAGES, ...COURSES, ...LOOKALIKES, ...FREE_TEXT, ...DUPLICATES];

const lance = new LanceDb();
const mockLLM = { embedTextInput: async () => QUERY_VECTOR };

const scoredRerank = async (_query, docs, { topK }) =>
  docs
    .map((d, i) => ({ ...d, rerank_corpus_id: i, rerank_score: 1 - i * 0.01 }))
    .sort((a, b) => b.rerank_score - a.rerank_score)
    .slice(0, topK);

const search = (searchMode, input, extra = {}) =>
  lance.performSimilaritySearch({
    namespace: NS,
    input,
    LLMConnector: mockLLM,
    topN: 4,
    searchMode,
    ...extra,
  });
const ids = (result) => result.sources.map((s) => s.id);
const shape = (result) => ({
  ids: ids(result),
  contextTexts: result.contextTexts.length,
});

// Abfragen an LanceDB beobachten: Bedingungen (where) und Volltextsuchen
const queryProto = Object.getPrototypeOf(lancedb.Query.prototype);
let whereSpy;
let ftsSpy;

beforeAll(async () => {
  const { client } = await lance.connect();
  await client.dropTable(NS).catch(() => {});
  await lance.updateOrCreateCollection(client, ROWS, NS);
  // Tabelle ohne Volltextindex (Bestand vor KIE-471, kein Backfill)
  await client.dropTable(NS_NOINDEX).catch(() => {});
  await client.createTable(NS_NOINDEX, ROWS);
}, 120000);

afterAll(() => {
  fs.rmSync(process.env.STORAGE_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  settings = { reranker_retrieval_topk: 10 };
  mockRerank.mockReset();
  mockRerank.mockImplementation(scoredRerank);
  mockExclusion.mockReset();
  mockExclusion.mockImplementation(async () => null);
  whereSpy = jest.spyOn(queryProto, "where");
  ftsSpy = jest.spyOn(queryProto, "fullTextSearch");
  jest.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  whereSpy.mockRestore();
  ftsSpy.mockRestore();
  console.log.mockRestore();
});

test("Tabelle mit Volltextindex, Vergleichstabelle ohne", async () => {
  const { client } = await lance.connect();
  const withIndex = await (await client.openTable(NS)).listIndices();
  const without = await (await client.openTable(NS_NOINDEX)).listIndices();
  expect(withIndex.some((i) => i.columns.includes("text"))).toBe(true);
  expect(without).toEqual([]);
});

test("Vorbedingung: Vektor- und Stichwortsuche mit der ganzen Frage finden den Kurs nicht", async () => {
  const { client } = await lance.connect();
  const collection = await client.openTable(NS);
  const { vectorRows, ftsRows } = await lance.hybridArms({
    collection,
    query: QUESTION,
    queryVector: QUERY_VECTOR,
    armLimit: 10,
  });
  expect(ftsRows).toHaveLength(10);
  expect([...vectorRows, ...ftsRows].map((r) => r.id)).not.toContain(
    courseId("26B7602")
  );
  // nur die Nummer: die Volltextsuche findet ihn sofort
  const onlyNumber = await lance.hybridArms({
    collection,
    query: "26B7602",
    queryVector: QUERY_VECTOR,
    armLimit: 10,
  });
  expect(onlyNumber.ftsRows.map((r) => r.id)).toContain(courseId("26B7602"));
});

// Review rc1 S-L6: „2026“ trifft über die Trigramme fast jedes Kursdokument,
// je Kandidat kommen bis zu 50 Zeilen zurück; der Vektor wird nie gebraucht
test("S-L6: die Volltextsuche je Kandidat lädt keinen Vektor, aber alle übrigen Spalten", async () => {
  const { client } = await lance.connect();
  const loaded = [];
  const original = lance.filteredQueryRows.bind(lance);
  const spy = jest
    .spyOn(lance, "filteredQueryRows")
    .mockImplementation(async (...args) => {
      const rows = await original(...args);
      loaded.push(...rows);
      return rows;
    });
  const hits = await lance.courseNumberLookup({
    client,
    namespace: NS,
    candidates: courseNumberSearchPlan("Gibt es 26B7602 auch 2026?"),
    topN: 4,
  });
  spy.mockRestore();
  expect(hits.map((h) => h.row.id)).toEqual([courseId("26B7602")]);
  expect(loaded.length).toBeGreaterThan(COURSES.length);
  for (const row of loaded) {
    expect(row).not.toHaveProperty("vector");
    expect(row).toEqual(
      expect.objectContaining({
        id: expect.any(String),
        title: expect.any(String),
        text: expect.any(String),
        price: expect.any(Number),
      })
    );
  }
});

describe.each(MODES)("Modus %s", (mode) => {
  test("AK-1: Kursnummer im Satz: der Kurs steht an erster Stelle, die übrigen Plätze wie bisher", async () => {
    const result = await search(mode, QUESTION);
    expect(ids(result)[0]).toBe(courseId("26B7602"));
    expect(result.sources).toHaveLength(4);
    expect(result.contextTexts).toHaveLength(4);
    expect(result.contextTexts[0]).toContain("Kursnummer: 26B7602");
    expect(result.sources[0].text).toContain("Kursnummer: 26B7602");
    // kein Vektor und keine internen Felder in den Quellen
    expect(result.sources[0]).not.toHaveProperty("vector");
    expect(result.sources[0]).not.toHaveProperty("_score");
    // übrige Plätze: Reihenfolge der Suche ohne Nachschlagen (D3)
    jest.spyOn(lance, "courseNumberLookup").mockResolvedValue([]);
    const before = await search(mode, QUESTION);
    lance.courseNumberLookup.mockRestore();
    expect(ids(before)).not.toContain(courseId("26B7602"));
    expect(ids(result).slice(1)).toEqual(ids(before).slice(0, 3));
  });

  // Review rc1 S-L1: fillSourceWindow nimmt aus dem Verlauf nur Quellen mit
  // Feld score (alle anderen gelten als früher angeheftete Dokumente)
  test("S-L1: Folgefrage: der über die Nummer gefundene Kurs kommt aus dem Verlauf zurück", async () => {
    const first = await search(mode, QUESTION);
    expect(first.sources[0]).toMatchObject({
      id: courseId("26B7602"),
      score: null,
    });
    // gespeicherte Antwort wie in embed.js, Folgefrage ohne eigene Treffer
    const history = [
      { response: JSON.stringify({ text: "Antwort", sources: first.sources }) },
    ];
    const followUp = fillSourceWindow({ nDocs: 4, searchResults: [], history });
    expect(followUp.sources.map((s) => s.id)).toContain(courseId("26B7602"));
    expect(followUp.contextTexts.join("\n")).toContain("Kursnummer: 26B7602");
  });

  test("AK-2: alle Formate der Flotte, in jeder Schreibweise und mit Satzzeichen", async () => {
    const templates = [
      (k) =>
        `Ich habe in der Zeitung die Kursnummer ${k} gesehen. Was ist das?`,
      (k) => `Was ist das für ein Kurs (${k})?`,
      (k) => `Kurs-Nr. ${k}, wann beginnt der?`,
      (k) => `${k}?`,
    ];
    for (const [i, knr] of FORMATS.entries()) {
      const typed = i % 2 === 0 ? knr.toLowerCase() : knr;
      const result = await search(mode, templates[i % templates.length](typed));
      expect([knr, ids(result)[0]]).toEqual([knr, courseId(knr)]);
    }
  });

  test("S-L4: Nummer mit typografischem Strich oder weichem Trennzeichen findet den Kurs", async () => {
    for (const [question, knr] of [
      ["Kurs-Nr. 262\u201130748, wann beginnt der?", "262-30748"],
      ["Was ist 261\u2013G\u2013071 für ein Kurs?", "261-G-071"],
      ["Ich habe 26B\u00AD7602 in der Zeitung gesehen.", "26B7602"],
    ]) {
      const result = await search(mode, question);
      expect([knr, ids(result)[0]]).toEqual([knr, courseId(knr)]);
    }
  });

  // Review rc1 S-L3: Nummer per Bindestrich an ein Wort gehängt
  test("S-L3: Nummer per Bindestrich an ein Wort gehängt findet den Kurs", async () => {
    for (const [question, knr] of [
      ["Ist der 26B7602-Kurs noch frei?", "26B7602"],
      ["Kurs-26B7602?", "26B7602"],
      ["Kurs-Nr.262-30748", "262-30748"],
      ["Wann beginnt Kurs-262-30748?", "262-30748"],
      ["Ist der Spanischkurs-T7411A abends?", "T7411A"],
    ]) {
      const result = await search(mode, question);
      expect([question, ids(result)[0]]).toEqual([question, courseId(knr)]);
    }
  });

  test("S-L3/AK-3: über einen Teil gefundener Kurs steht an der Stelle seines Worts", async () => {
    const result = await search(
      mode,
      "Was unterscheidet Kurs-26B7602 von T7411A?"
    );
    expect(ids(result).slice(0, 2)).toEqual([
      courseId("26B7602"),
      courseId("T7411A"),
    ]);
  });

  test("S-L3: ergibt das ganze Wort eine Kursnummer, zählt sein Teil nicht", async () => {
    const { client } = await lance.connect();
    await client.dropTable(NS_PARTS).catch(() => {});
    await lance.updateOrCreateCollection(
      client,
      [
        {
          id: "online",
          title: "Kurs 26B7602-ONLINE",
          text: header("26B7602-ONLINE", "Spanisch A1.2 online"),
          vector: far(0),
        },
        {
          id: "praesenz",
          title: "Kurs 26B7602",
          text: header("26B7602", "Spanisch A1.2"),
          vector: far(1),
        },
        ...PAGES.slice(0, 5),
      ],
      NS_PARTS
    );
    settings = { ...settings, search_trace: "on" };
    const traces = [];
    jest
      .spyOn(SearchTrace, "writeTrace")
      .mockImplementation((t) => traces.push(JSON.parse(JSON.stringify(t))));
    const whole = await search(mode, "Ist 26B7602-Online noch frei?", {
      namespace: NS_PARTS,
    });
    const part = await search(mode, "Ist 26B7602-Kurs noch frei?", {
      namespace: NS_PARTS,
    });
    SearchTrace.writeTrace.mockRestore();
    expect(ids(whole)[0]).toBe("online");
    expect(ids(part)[0]).toBe("praesenz");
    expect(traces.map((t) => t.courseNumbers)).toEqual([
      expect.objectContaining({
        candidates: 2,
        recognized: ["26B7602-ONLINE"],
        found: [expect.objectContaining({ id: "online" })],
      }),
      expect.objectContaining({
        candidates: 2,
        recognized: ["26B7602"],
        found: [expect.objectContaining({ id: "praesenz" })],
      }),
    ]);
  });

  test("AK-3: mehrere Kursnummern: alle vorn, in der Reihenfolge der Frage", async () => {
    const result = await search(
      mode,
      "Was unterscheidet T7411A von 26B7602 und (XI57261)?"
    );
    expect(ids(result).slice(0, 3)).toEqual([
      courseId("T7411A"),
      courseId("26B7602"),
      courseId("XI57261"),
    ]);
    expect(result.sources).toHaveLength(4);
  });

  test("AK-3: höchstens topN, auch bei mehr gefundenen Kursen", async () => {
    const question = "Kurse F320241, 26H43362, NSP10601C, T7411A und 26B7602?";
    const four = await search(mode, question);
    expect(ids(four)).toEqual(
      ["F320241", "26H43362", "NSP10601C", "T7411A"].map(courseId)
    );
    const two = await search(mode, question, { topN: 2 });
    expect(ids(two)).toEqual(["F320241", "26H43362"].map(courseId));
  });

  test("AK-3 (Altdokument): gleiche Nummer in zwei Dokumenten, beide vorn", async () => {
    const result = await search(mode, "Was ist der Kurs DUP4711?");
    expect(ids(result).slice(0, 2).sort()).toEqual(["dup-alt", "dup-neu"]);
  });

  test("NAK-2: Sonderzeichen und Einschleusung: kein Fehler, keine Bedingung aus der Eingabe", async () => {
    const inputs = [
      "' OR 1=1",
      '"',
      "\\",
      "26B7602' OR '1'='1",
      '26B7602"; DROP TABLE kursnummern; --',
      "%26B7602%_ id IS NULL",
      "a".repeat(20000),
      "1-".repeat(10000),
      `26B7602 ${"x".repeat(20000)}`,
    ];
    for (const input of inputs) {
      const result = await search(mode, input);
      expect(Array.isArray(result.sources)).toBe(true);
      if (input.includes("26B7602"))
        expect(ids(result)[0]).toBe(courseId("26B7602"));
    }
    // ohne Filter und ohne Ausschluss gibt es keine Bedingung in der Anfrage
    expect(whereSpy).not.toHaveBeenCalled();
  });

  test("NAK-2: mit Ausschluss stehen nur dessen Bedingungen in der Anfrage", async () => {
    const clauses = ["id NOT IN ('seite-0')", "(id NOT IN ('seite-0'))"];
    mockExclusion.mockImplementation(async () => ({
      clauses,
      form: { accepted: 0 },
      excludedIds: 1,
      staleDocs: 1,
      headBlockIds: 0,
      stats: { failClosed: 0 },
    }));
    const result = await search(mode, "26B7602' OR '1'='1");
    expect(ids(result)[0]).toBe(courseId("26B7602"));
    expect(ids(result)).not.toContain("seite-0");
    const predicates = whereSpy.mock.calls.map(([p]) => p);
    expect(predicates.length).toBeGreaterThan(0);
    for (const p of predicates) expect([clauses[0], "id IS NULL"]).toContain(p);
  });

  test("NAK-3: ausgeschlossener Kurs (Kursbestand) kommt über die Nummer nicht zurück", async () => {
    const stale = courseId("26B7602");
    mockExclusion.mockImplementation(async () => ({
      clauses: [`id NOT IN ('${stale}')`, `(id NOT IN ('${stale}'))`],
      form: { accepted: 0 },
      excludedIds: 1,
      staleDocs: 1,
      headBlockIds: 0,
      stats: { failClosed: 0 },
    }));
    const result = await search(mode, "Kurse 26B7602 und T7411A?");
    expect(ids(result)).not.toContain(stale);
    expect(ids(result)[0]).toBe(courseId("T7411A"));
    for (const text of result.contextTexts)
      expect(text).not.toContain("Kursnummer: 26B7602");
    for (const [, docs] of mockRerank.mock.calls)
      expect(docs.map((d) => d.id)).not.toContain(stale);
  });

  test("NAK-3: Metadatenfilter gilt auch für den Kurs mit der Nummer", async () => {
    // Preis bis 50: der Kurs 26B7602 (130,90) fällt heraus, DUP4711 (50) bleibt
    const filters = { priceMax: 50 };
    const result = await search(mode, "Kurse 26B7602 und DUP4711?", {
      filters,
    });
    expect(ids(result)).not.toContain(courseId("26B7602"));
    expect(ids(result).slice(0, 2).sort()).toEqual(["dup-alt", "dup-neu"]);
    expect(result.contextTexts.join("\n")).not.toContain("Hinweis an den");
    const predicates = whereSpy.mock.calls.map(([p]) => p);
    for (const p of predicates) expect(p).toBe("price <= 50");
  });

  test("NAK-4: höchstens 5 Nummern werden gesucht, weitere ignoriert", async () => {
    settings = { ...settings, search_trace: "on" };
    const traces = [];
    jest
      .spyOn(SearchTrace, "writeTrace")
      .mockImplementation((t) => traces.push(JSON.parse(JSON.stringify(t))));
    const seven = FORMATS.slice(0, 7);
    const result = await search(mode, `Kurse ${seven.join(", ")}?`, {
      topN: 10,
    });
    SearchTrace.writeTrace.mockRestore();
    expect(ids(result).slice(0, 5)).toEqual(seven.slice(0, 5).map(courseId));
    expect(traces[0].courseNumbers.candidates).toBe(5);
    expect(traces[0].courseNumbers.found.map((f) => f.id)).toEqual(
      seven.slice(0, 5).map(courseId)
    );
  });

  test("AK-9: Suchspur zeigt erkannte Nummern und gefundene Dokumente", async () => {
    settings = { ...settings, search_trace: "on" };
    const traces = [];
    jest
      .spyOn(SearchTrace, "writeTrace")
      .mockImplementation((t) => traces.push(JSON.parse(JSON.stringify(t))));
    await search(mode, `${QUESTION} Telefon 04221 9923-0`);
    settings = { ...settings, search_trace: "full" };
    await search(mode, `${QUESTION} Telefon 04221 9923-0`);
    SearchTrace.writeTrace.mockRestore();
    expect(traces).toHaveLength(2);
    const [on, full] = traces;
    expect(on.courseNumbers).toMatchObject({
      candidates: 3,
      recognized: ["26B7602"],
      found: [
        {
          id: courseId("26B7602"),
          title: "Kurs 26B7602",
          courseNumber: "26B7602",
        },
      ],
      skipped: null,
      error: null,
    });
    expect(typeof on.courseNumbers.ms).toBe("number");
    expect(on.final.docs[0]).toMatchObject({
      finalRank: 1,
      id: courseId("26B7602"),
      courseNumber: "26B7602",
    });
    expect(on.final.count).toBe(4);
    expect(on.final.docs.map((d) => d.finalRank)).toEqual([1, 2, 3, 4]);
    // Stufe „on“: Kandidaten der Frage (etwa Telefonnummern) nur als Anzahl
    expect(on.courseNumbers).not.toHaveProperty("searched");
    expect(JSON.stringify(on)).not.toContain("9923-0");
    expect(JSON.stringify(on)).not.toContain("04221");
    // Plan nach E16: Formen mit Buchstabe oder Bindestrich zuerst
    expect(full.courseNumbers.searched).toEqual(["26B7602", "9923-0", "04221"]);
  });

  test("AK-6: ohne Volltextindex keine Nachschlage-Abfrage und kein Fehler", async () => {
    settings = { ...settings, search_trace: "on" };
    const traces = [];
    jest
      .spyOn(SearchTrace, "writeTrace")
      .mockImplementation((t) => traces.push(JSON.parse(JSON.stringify(t))));
    const result = await search(mode, QUESTION, { namespace: NS_NOINDEX });
    SearchTrace.writeTrace.mockRestore();
    expect(result.sources.length).toBeGreaterThan(0);
    expect(traces[0].courseNumbers).toMatchObject({
      candidates: 1,
      recognized: [],
      found: [],
      skipped: "no_fts_index",
    });
    // nur die Volltextsuche der Hybrid-Arme, keine eigene
    expect(ftsSpy).toHaveBeenCalledTimes(mode.startsWith("hybrid") ? 1 : 0);
  });

  test("AK-4/AK-5: Nummern ohne Kursdokument werden geprüft, aber nicht erkannt", async () => {
    settings = { ...settings, search_trace: "on" };
    const traces = [];
    jest
      .spyOn(SearchTrace, "writeTrace")
      .mockImplementation((t) => traces.push(JSON.parse(JSON.stringify(t))));
    await search(mode, "Gibt es 2026 in 27749 Kurse? Telefon 04221 9923-0");
    await search(mode, "Was ist Kurs 26B9999 und 26B760X?");
    SearchTrace.writeTrace.mockRestore();
    expect(traces.map((t) => t.courseNumbers)).toEqual([
      expect.objectContaining({ candidates: 4, recognized: [], found: [] }),
      expect.objectContaining({ candidates: 2, recognized: [], found: [] }),
    ]);
  });

  test("angeheftetes Dokument kommt über die Nummer nicht doppelt in die Quellen", async () => {
    const published = "01.11.2026, 08:00:00";
    const { client } = await lance.connect();
    await client.dropTable(NS_PIN).catch(() => {});
    await lance.updateOrCreateCollection(
      client,
      [
        {
          id: "pin-kurs",
          title: "Kurs PIN4711.txt",
          published,
          text: header("PIN4711", "Angehefteter Kurs"),
          vector: far(0),
        },
        ...PAGES.slice(0, 5).map((p) => ({ ...p, published })),
      ],
      NS_PIN
    );
    const question = "Was ist mit Kurs PIN4711?";
    const open = await search(mode, question, { namespace: NS_PIN });
    expect(ids(open)[0]).toBe("pin-kurs");
    const pinned = await search(mode, question, {
      namespace: NS_PIN,
      filterIdentifiers: [`title:Kurs PIN4711.txt-timestamp:${published}`],
    });
    expect(ids(pinned)).not.toContain("pin-kurs");
    expect(pinned.sources).toHaveLength(4);
  });

  test("NAK-1: ohne Kandidaten läuft keine zusätzliche Abfrage", async () => {
    await search(mode, "Welche Spanischkurse gibt es am Abend?");
    expect(ftsSpy).toHaveBeenCalledTimes(mode.startsWith("hybrid") ? 1 : 0);
  });
});

// Nachtrag 8.1.3 (Spezifikation Abschnitt 11, 11.11.2026): Kursnummern mit
// Punkt im Inneren, ein Beispiel je Form aus den Feeds der Flotte. Eigene
// Tabelle, damit die Snapshots der Tabelle NS unverändert bleiben.
const NS_DOT = "kursnummern_punkt";
const DOT_FORMATS = [
  "X41.100",
  "X43.414",
  "X17.117-1",
  "X41.501-S",
  "BA56.25",
  "BAMF77.040",
  "BA65.06A",
  "BA427.00A",
  "BA213.11",
  "BA77.032",
  "262.302200",
  "26B7154.E",
];
// Nummern ohne Punkt für Striche und angehängte Wörter (S-L8 bis S-L10) und
// Kurse, die einer Nummer mit Punkt bis auf Punkt oder Endung gleichen
const DOT_TABLE_PLAIN = [
  "26B7602",
  "26B7604",
  "26B7602-ONLINE",
  "T7411A",
  "262-30748",
  "262-30749",
  "27S445311",
  "NTU40616R",
  "X41.501",
  "26B7154",
  "BA56.250",
  "BA5625",
];
const DOT_ROWS = [
  ...PAGES,
  // Seiten nahe am Suchvektor mit Datum, Preis und Version im Freitext
  ...["14.09.2026", "1.200 Euro", "Version v3.5"].map((words, i) => ({
    id: `punkt-seite-${i}`,
    title: `punkt-seite-${i}.html`,
    text: `Hinweis: ${words}. Was ist das für ein Kurs? Kurs Zeitung gesehen.`,
    vector: near(20 + i),
    price: 10,
  })),
  // Übersicht mit Nummern mit Punkt im Freitext: nie ein Treffer
  {
    id: "punkt-uebersicht",
    title: "programm_punkt.html",
    text: "Programm\nX41.100 Tastschreiben\nBA56.25 Englisch\n26B7154.E Spanisch",
    vector: near(30),
    price: 0,
  },
  ...[...DOT_FORMATS, ...DOT_TABLE_PLAIN].map((knr, i) => ({
    id: courseId(knr),
    title: `Kurs ${knr}`,
    text: header(knr, `Kurs Nummer ${i} Thema ${"Inhalt ".repeat(i + 1)}`, {
      description: i === 0 ? "Kosten 1.200 Euro, ab Version v3.5." : "",
    }),
    vector: far(i),
    price: 130.9,
  })),
];

describe("Nachtrag 8.1.3: Kursnummern mit Punkt", () => {
  beforeAll(async () => {
    const { client } = await lance.connect();
    await client.dropTable(NS_DOT).catch(() => {});
    await lance.updateOrCreateCollection(client, DOT_ROWS, NS_DOT);
  }, 120000);

  const searchDot = (mode, input, extra = {}) =>
    search(mode, input, { namespace: NS_DOT, ...extra });
  // Ergebnis derselben Frage ohne Nachschlagen nach der Nummer
  const withoutLookup = async (mode, input, extra = {}) => {
    const spy = jest.spyOn(lance, "courseNumberLookup").mockResolvedValue([]);
    const result = await searchDot(mode, input, extra);
    spy.mockRestore();
    return result;
  };
  const traced = async (level, run) => {
    settings = { ...settings, search_trace: level };
    const traces = [];
    const spy = jest
      .spyOn(SearchTrace, "writeTrace")
      .mockImplementation((t) => traces.push(JSON.parse(JSON.stringify(t))));
    try {
      await run();
    } finally {
      spy.mockRestore();
    }
    return traces;
  };

  describe.each(MODES)("Modus %s", (mode) => {
    test("AK-11: Kursnummer mit Punkt im Satz: der Kurs steht an erster Stelle, die übrigen Plätze wie bisher", async () => {
      for (const [question, knr] of [
        ["Ich interessiere mich für BA56.25.", "BA56.25"],
        ["Kurs (26B7154.E)?", "26B7154.E"],
        ["bamf77.040 noch frei?", "BAMF77.040"],
      ]) {
        const result = await searchDot(mode, question);
        expect([question, ids(result)[0]]).toEqual([question, courseId(knr)]);
        expect(result.sources).toHaveLength(4);
        expect(result.contextTexts[0]).toContain(`Kursnummer: ${knr}`);
        expect(result.sources[0]).not.toHaveProperty("vector");
        // übrige Plätze: Reihenfolge der Suche ohne Nachschlagen (D3)
        const before = await withoutLookup(mode, question);
        expect(ids(result).slice(1)).toEqual(
          ids(before)
            .filter((id) => id !== courseId(knr))
            .slice(0, 3)
        );
      }
    });

    test("AK-11: alle Formate mit Punkt, in jeder Schreibweise und mit Satzzeichen danach", async () => {
      const templates = [
        (k) => `Ich habe in der Zeitung die Kursnummer ${k} gesehen.`,
        (k) => `Was ist das für ein Kurs (${k})?`,
        (k) => `Ist ${k} noch frei?`,
        (k) => `Kurs-Nr. ${k}.`,
      ];
      for (const [i, knr] of DOT_FORMATS.entries()) {
        const typed = i % 2 === 0 ? knr.toLowerCase() : knr;
        const question = templates[i % templates.length](typed);
        const result = await searchDot(mode, question);
        expect([question, ids(result)[0]]).toEqual([question, courseId(knr)]);
      }
    });

    test("AK-11/AK-3: mehrere Nummern mit und ohne Punkt: alle vorn, in der Reihenfolge der Frage", async () => {
      const result = await searchDot(
        mode,
        "Was unterscheidet X41.100 von BA56.25 und 26B7602?"
      );
      expect(ids(result).slice(0, 3)).toEqual(
        ["X41.100", "BA56.25", "26B7602"].map(courseId)
      );
    });

    test("AK-11: genaue Nummer zählt: mit Endung, ohne Endung, ohne Punkt", async () => {
      for (const [question, knr] of [
        ["Kurs 26B7154.E?", "26B7154.E"],
        ["Kurs 26B7154?", "26B7154"],
        ["Kurs X41.501-S?", "X41.501-S"],
        ["Kurs X41.501?", "X41.501"],
        ["Kurs BA56.25?", "BA56.25"],
        ["Kurs BA5625?", "BA5625"],
        ["Kurs BA56.250?", "BA56.250"],
      ]) {
        const traces = await traced("on", () => searchDot(mode, question));
        expect([question, traces[0].courseNumbers.recognized]).toEqual([
          question,
          [knr],
        ]);
      }
    });

    test("AK-12: Punkte am Wortende sind Satzzeichen", async () => {
      for (const [question, knr] of [
        ["Kurs BA56.25.", "BA56.25"],
        ["Kurs BA56.25...", "BA56.25"],
        ["Gibt es noch Plätze (262.302200.)?", "262.302200"],
        ["Kurs .X43.414.-", "X43.414"],
        ["Ich habe 26B7602. gesehen", "26B7602"],
        ["Ist Nr.26B7602 frei?", "26B7602"],
        ["Ich suche 26B7602.Was ist das?", "26B7602"],
      ]) {
        const result = await searchDot(mode, question);
        expect([question, ids(result)[0]]).toEqual([question, courseId(knr)]);
      }
    });

    test("AK-13: Datum, Preis und Version mit Punkt werden geprüft, heften aber keinen Kurs an", async () => {
      for (const [question, searched] of [
        ["Beginnt der Kurs am 14.09.2026?", ["14.09.2026"]],
        ["Kostet der Kurs 1.200 Euro?", ["1.200"]],
        ["Gibt es das ab Version v3.5?", ["v3.5"]],
        // Plan nach E16: die Version mit Buchstabe zuerst
        [
          "Beginn 14.09.2026, Preis 1.200, Version v3.5?",
          ["v3.5", "14.09.2026", "1.200"],
        ],
      ]) {
        let result;
        const traces = await traced("full", async () => {
          result = await searchDot(mode, question);
        });
        expect([question, traces[0].courseNumbers]).toEqual([
          question,
          expect.objectContaining({
            searched,
            recognized: [],
            found: [],
            error: null,
          }),
        ]);
        const before = await withoutLookup(mode, question);
        expect([question, ids(result)]).toEqual([question, ids(before)]);
      }
    });

    // Review 8.1.3 S-L11 (K8), Entscheidung E16
    test("E16 (S-L11): Datum, Uhrzeit, Preis und „Nr.“ vor der Kursnummer verdrängen sie nicht", async () => {
      for (const [question, expected] of [
        [
          "Welcher der Kurse am 14.09., 21.09., 28.09., 05.10. oder 12.10. ist 26B7602?",
          ["26B7602"],
        ],
        [
          "Spanisch A1.2 vom 14.09. bis 30.11., Raum 1.05, mittwochs 18.30 Uhr, Kursnummer 26B7602",
          ["26B7602"],
        ],
        [
          "Gibt es 2026 in 27749 Delmenhorst Kurse? Telefon 04221 9923-0, Beginn 14.09.2026, Kurs 26B7602?",
          ["26B7602"],
        ],
        [
          "Ist Nr.26B7602 am 14.09.2026 oder Nr.T7411A am 21.09.2026 frei?",
          ["26B7602", "T7411A"],
        ],
        [
          "Kurs von 18.00–19.30 Uhr und 19.45–21.15 Uhr, Nr.26B7602?",
          ["26B7602"],
        ],
        ["262.302200 am 14.09.", ["262.302200"]],
      ]) {
        const result = await searchDot(mode, question);
        expect([question, ids(result).slice(0, expected.length)]).toEqual([
          question,
          expected.map(courseId),
        ]);
      }
    });

    test("E16 (S-L11)/AK-3: Nummern mit und ohne Buchstaben: alle vorn, in der Reihenfolge der Frage", async () => {
      const result = await searchDot(
        mode,
        "Ist 262.302200 am 14.09. günstiger als 26B7602 oder BA56.25?"
      );
      expect(ids(result).slice(0, 3)).toEqual(
        ["262.302200", "26B7602", "BA56.25"].map(courseId)
      );
    });

    // Nachreview rc2 S-L8
    test("AK-14 (S-L8): zwei Nummern mit Halbgeviert- oder Ziffernstrich ohne Leerzeichen", async () => {
      for (const [question, expected] of [
        ["Was kosten die Kurse 26B7602\u201326B7604?", ["26B7602", "26B7604"]],
        ["Kurse 26B7602\u2013T7411A?", ["26B7602", "T7411A"]],
        ["Kurse 262-30748\u2013262-30749?", ["262-30748", "262-30749"]],
        ["Kurse 27S445311\u2012NTU40616R?", ["27S445311", "NTU40616R"]],
        ["Kurse X41.100\u2013X43.414?", ["X41.100", "X43.414"]],
        ["Spanisch 26B7602\u2013A1?", ["26B7602"]],
      ]) {
        const result = await searchDot(mode, question);
        expect([question, ids(result).slice(0, expected.length)]).toEqual([
          question,
          expected.map(courseId),
        ]);
      }
    });

    // Nachreview rc2 S-L9
    test("AK-14 (S-L9): Nummer an einem langen Wort findet den Kurs", async () => {
      for (const [question, knr] of [
        ["Ist der Volkshochschulkurs-26B7602 noch frei?", "26B7602"],
        ["Wann ist Italienischkurs-262-30748?", "262-30748"],
        ["Bildungsurlaub-NTU40616R?", "NTU40616R"],
        ["Wirbelsäulengymnastik-26B7602?", "26B7602"],
        ["Wochenendseminar\u201326B7602?", "26B7602"],
        ["Online-Kurs-X41.100?", "X41.100"],
      ]) {
        const result = await searchDot(mode, question);
        expect([question, ids(result)[0]]).toEqual([question, courseId(knr)]);
      }
    });

    // Nachreview rc2 S-L10
    test("AK-14 (S-L10): dieselbe Nummer als Teil zweier Wörter: beide Kurse vorn, in der Reihenfolge der Frage", async () => {
      const online = courseId("26B7602-ONLINE");
      const praesenz = courseId("26B7602");
      const forward = await searchDot(
        mode,
        "Ist 26B7602-Online oder der Kurs-26B7602 günstiger?"
      );
      expect(ids(forward).slice(0, 2)).toEqual([online, praesenz]);
      const reversed = await searchDot(
        mode,
        "Ist der Kurs-26B7602 oder 26B7602-Online günstiger?"
      );
      expect(ids(reversed).slice(0, 2)).toEqual([praesenz, online]);
      const early = await searchDot(
        mode,
        "Ist 26B7602-Kurs teurer als T7411A oder 26B7602?"
      );
      expect(ids(early).slice(0, 2)).toEqual([praesenz, courseId("T7411A")]);
    });

    test("NAK-3/AK-5: ausgeschlossener Kurs mit Punkt kommt nicht zurück, ein Kurs ohne seine Endung rückt nicht nach", async () => {
      for (const knr of ["26B7154.E", "X41.501-S"]) {
        const stale = courseId(knr);
        mockExclusion.mockImplementation(async () => ({
          clauses: [`id NOT IN ('${stale}')`, `(id NOT IN ('${stale}'))`],
          form: { accepted: 0 },
          excludedIds: 1,
          staleDocs: 1,
          headBlockIds: 0,
          stats: { failClosed: 0 },
        }));
        const question = `Was ist der Kurs ${knr}?`;
        const traces = await traced("on", () => searchDot(mode, question));
        const result = await searchDot(mode, question);
        expect(ids(result)).not.toContain(stale);
        expect(traces[0].courseNumbers).toMatchObject({
          recognized: [],
          found: [],
        });
        const before = await withoutLookup(mode, question);
        expect(ids(result)).toEqual(ids(before));
      }
    });

    test("NAK-2/NAK-5: lange Folgen aus Punkten und Strichen: kein Fehler, keine Bedingung, Nummer danach zählt", async () => {
      for (const input of [
        ".".repeat(20000),
        `1${".-".repeat(10000)}1`,
        `a${".\u2013".repeat(10000)}a BA56.25.`,
        `BA56.25' OR '1'='1.`,
      ]) {
        const result = await searchDot(mode, input);
        expect(Array.isArray(result.sources)).toBe(true);
        if (input.includes("BA56.25"))
          expect(ids(result)[0]).toBe(courseId("BA56.25"));
      }
      expect(whereSpy).not.toHaveBeenCalled();
    });
  });
});

// Gleich wie vorher: gegen origin/master 202092427 aufgenommen
const WIDE = { topN: 10, similarityThreshold: 0 };
const UNCHANGED = {
  // NAK-1: ohne Kursnummer
  "ohne-nummer-zeitung":
    "Ich habe in der Zeitung einen Kurs gesehen. Was ist das für ein Kurs?",
  "ohne-nummer-spanisch": "Welche Spanischkurse gibt es am Abend?",
  "ohne-nummer-programm": "Wo finde ich das Programmheft mit allen Kursen?",
  "ohne-nummer-kurs-nr": "Kurs-Nr. bitte, was kostet der Kurs 130,90 Euro?",
  // AK-4: Zahlen ohne Kursdokument mit genau dieser Nummer
  "zahl-jahr": "Gibt es 2026 noch Kurse?",
  "zahl-plz": "Ich wohne in 27749 Delmenhorst, welche Kurse gibt es?",
  "zahl-preis": "Kostet der Kurs 130,90 Euro?",
  "zahl-telefon": "Ist die Telefonnummer 04221 9923-0 richtig?",
  "zahl-datum": "Beginnt der Kurs am 14.09.2026?",
  "zahl-aehnlich": "Gibt es den Kurs 26B76 oder 7602?",
  // AK-5: unbekannte Kursnummer
  "unbekannt-zeitung":
    "Ich habe in der Zeitung die Kursnummer 26B9999 gesehen. Was ist das für ein Kurs?",
  "unbekannt-kurz": "Was ist Kurs 262-99999?",
};

describe.each(MODES)("Unverändert, Modus %s", (mode) => {
  test.each(Object.keys(UNCHANGED))("%s", async (name) => {
    // topN 10: auch Treffer der Stichwortsuche (ähnliche Nummern, Seiten
    // mit der Nummer im Freitext) stehen in den Quellen
    const result = await search(mode, UNCHANGED[name], WIDE);
    expect(shape(result)).toMatchSnapshot();
  });

  test("AK-6: Tabelle ohne Volltextindex, Frage mit Kursnummer", async () => {
    const result = await search(mode, QUESTION, {
      ...WIDE,
      namespace: NS_NOINDEX,
    });
    expect(shape(result)).toMatchSnapshot();
  });
});
