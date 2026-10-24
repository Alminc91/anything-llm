/* eslint-env jest, node */
/**
 * KIE-576 Paket 3 (E35, AK-K3): veraltete Kursdokumente (Kursnummer nicht im
 * Feed) gehen in keinen Schritt der Suche. Der Ausschluss sitzt als
 * Filterbedingung in der Anfrage an LanceDB: Vektor- und Stichwortsuche und
 * der Reranker (Testdouble) bekommen nachweislich kein altes Kursdokument,
 * die Zahl der Quellen bleibt gleich, Dokumente ohne Kursnummer bleiben.
 * Ohne gültigen Kursbestand ist das Ergebnis gleich wie vorher (NAK-K1).
 * KR-1: kein Rückfall mit nachträglichem Verwerfen, auch nicht bei über
 * 5.000 Abschnitten, bei verwaisten Abschnitten oder bei abgelehnter
 * Bedingung (dann fail-closed).
 * Gegen eine echte, temporäre LanceDB-Tabelle wie selectionPaths.test.js.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.STORAGE_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), "lance-course-inventory-")
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
  system_settings: { findFirst: jest.fn() },
}));

const prisma = require("../../../../utils/prisma");
const { LanceDb } = require("../../../../utils/vectorDbProviders/lance");
const { SystemSettings } = require("../../../../models/systemSettings");
const {
  __test__: inventory,
} = require("../../../../utils/chats/courseInventory");

let settings = {};
jest
  .spyOn(SystemSettings, "getValueOrFallback")
  .mockImplementation(async ({ label } = {}, fallback) =>
    Object.prototype.hasOwnProperty.call(settings, label)
      ? settings[label]
      : fallback
  );

const NS = "kursbestand";
const QUERY = "Yoga am Abend";
const QUERY_VECTOR = [1, 0, 0, 0];
const vec = (i) => [1, 0.02 * (i + 1), 0.01 * i, 0];

const header = (number, title) =>
  [
    "<document_metadata>",
    `sourceDocument: ${title}.txt`,
    "</document_metadata>",
    "",
    `Titel: ${title}`,
    `Kursnummer: ${number}`,
    `Kurs-Link: https://www.vhs-beispiel.de/kurs/${number}`,
    "",
    `Kursbeschreibung: ${QUERY} ${title}`,
  ].join("\n");

// Veraltete Kurse liegen dem Suchvektor am nächsten (vorn in jeder Suche)
const ROWS = [
  {
    id: "alt1",
    doc: "d-alt1",
    title: "Yoga alt eins",
    number: "262-900",
    v: [1, 0, 0, 0],
  },
  {
    id: "alt1b",
    doc: "d-alt1",
    text: `${QUERY} Folgeabschnitt alt eins`,
    v: [1, 0.001, 0, 0],
  },
  {
    id: "alt2",
    doc: "d-alt2",
    title: "Yoga alt zwei",
    number: "262-901",
    v: [1, 0.002, 0, 0],
  },
  { id: "k1", doc: "d-k1", title: "Yoga eins", number: "262-100", v: vec(0) },
  { id: "k2", doc: "d-k2", title: "Yoga zwei", number: "262-101", v: vec(1) },
  { id: "k3", doc: "d-k3", title: "Yoga drei", number: "262-102", v: vec(2) },
  { id: "k4", doc: "d-k4", title: "Yoga vier", number: "262-103", v: vec(3) },
  {
    id: "info",
    doc: "d-info",
    text: `${QUERY} Übersicht Gesundheit ohne Kursnummer`,
    v: vec(4),
  },
  { id: "k5", doc: "d-k5", title: "Yoga fünf", number: "262-104", v: vec(5) },
].map((r) => ({
  ...r,
  text: r.text ?? header(r.number, r.title),
}));
const STALE = new Set(["alt1", "alt1b", "alt2"]);
const OFFERED = ["262-100", "262-101", "262-102", "262-103", "262-104"];

// KR-1: über 5.000 Abschnitte eines veralteten Kurses, alle dem Suchvektor
// am nächsten; dazu angebotene Kurse und eine Seite ohne Kursnummer
const NS_BIG = "kursbestand_gross";
const BIG_STALE = 6200;
const BIG_ROWS = [
  ...Array.from({ length: BIG_STALE }, (_, i) => ({
    id: `viel-${i}`,
    doc: "d-viel",
    title: i === 0 ? "Yoga viel" : undefined,
    number: i === 0 ? "262-950" : undefined,
    text: i === 0 ? undefined : `${QUERY} Folgeabschnitt viel ${i}`,
    v: [1, 0.00001 * i, 0, 0],
  })),
  ...ROWS.filter((r) => !STALE.has(r.id)),
].map((r) => ({ ...r, text: r.text ?? header(r.number, r.title) }));

// KR-1: verwaiste Abschnitte (in der Tabelle, Dokument dem Workspace
// unbekannt): ein veralteter Kurs mit Folgeabschnitt desselben Uploads, ein
// angebotener Kurs und eine Seite ohne Kursnummer
const NS_ORPHAN = "kursbestand_verwaist";
const ORPHAN_ROWS = [
  {
    id: "waise1",
    orphan: true,
    title: "Yoga verwaist",
    number: "262-960",
    published: "1.10.2026, 08:00:00",
    v: [1, 0, 0, 0],
  },
  {
    id: "waise1b",
    orphan: true,
    title: "Yoga verwaist",
    text: `${QUERY} Folgeabschnitt verwaist`,
    published: "1.10.2026, 08:00:00",
    v: [1, 0.001, 0, 0],
  },
  {
    id: "waise2",
    orphan: true,
    title: "Yoga angeboten verwaist",
    number: "262-100",
    published: "2.10.2026, 08:00:00",
    v: [1, 0.002, 0, 0],
  },
  ...ROWS.filter((r) => !STALE.has(r.id) && r.id !== "k1"),
].map((r) => ({ ...r, text: r.text ?? header(r.number, r.title) }));
const ORPHAN_STALE = new Set(["waise1", "waise1b"]);

// fail-closed: eine Abschnitt-ID, die nie in die Anfrage darf
const NS_BAD = "kursbestand_fremd";
const BAD_ROWS = [
  {
    id: "alt'fremd",
    doc: "d-fremd",
    title: "Yoga fremd",
    number: "262-970",
    v: [1, 0, 0, 0],
  },
  ...ROWS.filter((r) => !STALE.has(r.id)),
].map((r) => ({ ...r, text: r.text ?? header(r.number, r.title) }));

const WORKSPACES = {
  [NS]: ROWS,
  [NS_BIG]: BIG_ROWS,
  [NS_ORPHAN]: ORPHAN_ROWS,
  [NS_BAD]: BAD_ROWS,
};

const lance = new LanceDb();
const mockLLM = { embedTextInput: async () => QUERY_VECTOR };

const inventoryValue = () =>
  JSON.stringify({
    version: 1,
    client: "vhs-beispiel",
    created: new Date(Date.now() - 60 * 1000).toISOString(),
    offered: OFFERED,
  });

function useInventory(on) {
  prisma.system_settings.findFirst.mockImplementation(async ({ where }) =>
    on && where.label === "kufer_course_inventory"
      ? { value: inventoryValue() }
      : null
  );
}

// Dokument-IDs je Workspace eindeutig (Präfix), verwaiste Zeilen ohne
// Dokument
const docOf = (ns, row) => (row.orphan ? null : `${ns}/${row.doc}`);
const slugs = Object.keys(WORKSPACES);

function installWorkspace() {
  const known = Object.entries(WORKSPACES).flatMap(([ns, rows]) =>
    rows
      .filter((r) => !r.orphan)
      .map((r) => ({ ns, docId: docOf(ns, r), row: r }))
  );
  inventory.setDeps({
    findWorkspaceId: async (slug) =>
      slugs.includes(slug) ? slugs.indexOf(slug) + 1 : null,
    listDocuments: async (workspaceId) => {
      const ns = slugs[workspaceId - 1];
      return [
        ...new Set(known.filter((k) => k.ns === ns).map((k) => k.docId)),
      ].map((docId) => ({
        docId,
        docpath: `custom-documents/${encodeURIComponent(docId)}.json`,
      }));
    },
    listVectors: async (docIds) =>
      known
        .filter((k) => docIds.includes(k.docId))
        .map((k) => ({ docId: k.docId, vectorId: k.row.id })),
    readDocumentText: async (docpath) => {
      const docId = decodeURIComponent(path.basename(docpath, ".json"));
      const rows = known.filter((k) => k.docId === docId).map((k) => k.row);
      return (rows.find((r) => r.number) ?? rows[0]).text;
    },
    existingVectorIds: (slug, ids) => lance.existingVectorIds(slug, ids),
    orphanRows: (slug, knownIds) => lance.orphanRows(slug, knownIds),
    rowTexts: (slug, ids) => lance.rowTexts(slug, ids),
  });
}

const scoredRerank = async (_query, docs, { topK }) =>
  docs
    .map((d, i) => ({ ...d, rerank_corpus_id: i, rerank_score: 1 - i * 0.01 }))
    .sort((a, b) => b.rerank_score - a.rerank_score)
    .slice(0, topK);

const search = (searchMode, extra = {}) =>
  lance.performSimilaritySearch({
    namespace: NS,
    input: QUERY,
    LLMConnector: mockLLM,
    topN: 4,
    similarityThreshold: 0,
    searchMode,
    ...extra,
  });
const ids = (result) => result.sources.map((s) => s.id);

beforeAll(async () => {
  const { client } = await lance.connect();
  for (const [ns, rows] of Object.entries(WORKSPACES)) {
    await client.dropTable(ns).catch(() => {});
    await lance.updateOrCreateCollection(
      client,
      rows.map(({ id, title, text, v, published }) => ({
        id,
        title: `${title ?? id}.txt`,
        published: published ?? "24.10.2026, 08:00:00",
        text,
        vector: v,
      })),
      ns
    );
  }
}, 120000);

afterAll(() => {
  fs.rmSync(process.env.STORAGE_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  settings = {};
  inventory.reset();
  installWorkspace();
  mockRerank.mockReset();
  mockRerank.mockImplementation(scoredRerank);
  jest.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => console.log.mockRestore());

const MODES = ["default", "rerank", "hybrid", "hybrid_rerank"];

describe.each(MODES)("Modus %s", (mode) => {
  test("ohne Kursbestand: veraltete Kurse wie heute vorn (Vorbedingung, NAK-K1)", async () => {
    useInventory(false);
    const result = await search(mode);
    expect(ids(result).some((id) => STALE.has(id))).toBe(true);
    expect(result.sources).toHaveLength(4);
  });

  test("mit Kursbestand: kein altes Kursdokument in Suche, Reranker und Quellen; Anzahl gleich", async () => {
    useInventory(true);
    const result = await search(mode);
    expect(result.sources).toHaveLength(4);
    expect(ids(result).filter((id) => STALE.has(id))).toEqual([]);
    expect(result.contextTexts).toHaveLength(4);
    for (const text of result.contextTexts)
      expect(text).not.toMatch(/262-90[01]|alt eins|alt zwei/);
    // Reranker-Testdouble: kein veraltetes Dokument unter den Kandidaten
    for (const [, docs] of mockRerank.mock.calls)
      expect(docs.map((d) => d.id).filter((id) => STALE.has(id))).toEqual([]);
    if (mode.includes("rerank")) expect(mockRerank).toHaveBeenCalled();
  });
});

test("Stichwortsuche (BM25) und Vektorarm tragen den Ausschluss selbst", async () => {
  useInventory(true);
  const {
    courseSearchExclusion,
  } = require("../../../../utils/chats/courseInventory");
  const exclusion = await courseSearchExclusion(NS);
  const { client } = await lance.connect();
  const collection = await client.openTable(NS);
  const arms = await lance.hybridArms({
    collection,
    query: "alt",
    queryVector: QUERY_VECTOR,
    armLimit: 20,
    exclusion,
  });
  // ohne Ausschluss findet BM25 die alten Kurse („alt eins“, „alt zwei“)
  const open = await lance.hybridArms({
    collection,
    query: "alt",
    queryVector: QUERY_VECTOR,
    armLimit: 20,
  });
  expect(open.ftsRows.some((r) => STALE.has(r.id))).toBe(true);
  expect(arms.ftsRows.filter((r) => STALE.has(r.id))).toEqual([]);
  expect(arms.vectorRows.filter((r) => STALE.has(r.id))).toEqual([]);
  expect(arms.vectorRows.length).toBe(ROWS.length - STALE.size);
  // die Bedingung stand in der Anfrage, keine Anfrage ohne Treffer
  expect(exclusion.stats.failClosed).toBe(0);
});

const staleIn = (rows, stale) =>
  rows.map((r) => r.id).filter((id) => stale.has(id));

describe.each(MODES)("KR-1, Modus %s", (mode) => {
  const run = (namespace) =>
    lance.performSimilaritySearch({
      namespace,
      input: QUERY,
      LLMConnector: mockLLM,
      topN: 4,
      similarityThreshold: 0,
      searchMode: mode,
    });
  const rerankCandidates = () =>
    mockRerank.mock.calls.flatMap(([, docs]) => docs);

  test("über 5.000 Abschnitte: alle in der Anfrage ausgeschlossen, Reranker ohne altes Dokument", async () => {
    useInventory(true);
    const bigStale = new Set(
      BIG_ROWS.filter((r) => r.doc === "d-viel").map((r) => r.id)
    );
    expect(bigStale.size).toBeGreaterThan(5000);
    const result = await run(NS_BIG);
    expect(result.sources).toHaveLength(4);
    expect(staleIn(result.sources, bigStale)).toEqual([]);
    expect(staleIn(rerankCandidates(), bigStale)).toEqual([]);
    if (mode.includes("rerank")) expect(mockRerank).toHaveBeenCalled();
  });

  test("verwaiste Abschnitte: veralteter Kurs samt Folgeabschnitt ausgeschlossen, angebotener bleibt", async () => {
    useInventory(true);
    const result = await lance.performSimilaritySearch({
      namespace: NS_ORPHAN,
      input: QUERY,
      LLMConnector: mockLLM,
      topN: 6,
      similarityThreshold: 0,
      searchMode: mode,
    });
    expect(staleIn(result.sources, ORPHAN_STALE)).toEqual([]);
    expect(staleIn(rerankCandidates(), ORPHAN_STALE)).toEqual([]);
    expect(result.sources.map((s) => s.id)).toContain("waise2");
    expect(result.sources).toHaveLength(6);
  });

  test("Bedingung nicht möglich: fail-closed, keine Treffer, Reranker ohne altes Dokument, Fehler geloggt", async () => {
    useInventory(true);
    const error = jest.spyOn(console, "error").mockImplementation(() => {});
    const result = await run(NS_BAD);
    expect(result.sources).toEqual([]);
    expect(staleIn(rerankCandidates(), new Set(["alt'fremd"]))).toEqual([]);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("Suche ohne Treffer")
    );
    error.mockRestore();
  });
});

test("Dokument ohne Kursnummer bleibt, auch wenn veraltete Kurse ausgeschlossen sind", async () => {
  useInventory(true);
  const result = await lance.performSimilaritySearch({
    namespace: NS,
    input: QUERY,
    LLMConnector: mockLLM,
    topN: 6,
    similarityThreshold: 0,
    searchMode: "default",
  });
  expect(ids(result)).toEqual(["k1", "k2", "k3", "k4", "info", "k5"]);
});

test("ohne Kursbestand bytegleich wie ohne Ausschluss (NAK-K1)", async () => {
  useInventory(false);
  const before = await search("rerank");
  const calls = mockRerank.mock.calls.map(([, docs]) => docs.map((d) => d.id));
  mockRerank.mockClear();
  // Gegenprobe: Kursbestand eines anderen Kunden (kein angebotener Kurs)
  prisma.system_settings.findFirst.mockImplementation(async ({ where }) =>
    where.label === "kufer_course_inventory"
      ? {
          value: JSON.stringify({
            version: 1,
            client: "anders",
            created: new Date().toISOString(),
            offered: ["999-1"],
          }),
        }
      : null
  );
  const other = await search("rerank");
  expect(other).toEqual(before);
  expect(
    mockRerank.mock.calls.map(([, docs]) => docs.map((d) => d.id))
  ).toEqual(calls);
});

test("AK-K9: existingVectorIds findet die Zeilen der Tabelle, fehlende Tabelle -> leer", async () => {
  expect(
    [
      ...(await lance.existingVectorIds(NS, ["k1", "gibtsnicht", "alt2"])),
    ].sort()
  ).toEqual(["alt2", "k1"]);
  expect((await lance.existingVectorIds("keine_tabelle", ["k1"])).size).toBe(0);
});

describe("filteredQueryRows: Bedingung in der Anfrage, ohne Rückfall (KR-1)", () => {
  // Abfrage-Attrappe: zeichnet Bedingung und Grenze auf, scheitert auf Wunsch
  const fakeQuery =
    (rows, fails = () => false, log = []) =>
    (limit) => {
      const q = {
        clause: null,
        where(clause) {
          q.clause = clause;
          return q;
        },
        async toArray() {
          log.push({ clause: q.clause, limit });
          if (q.clause && fails(q.clause)) throw new Error("no field named x");
          return rows.slice(0, limit);
        },
      };
      return q;
    };
  const rows = [
    { id: "alt", text: "a" },
    { id: "k1", text: "b" },
    { id: "k2", text: "c" },
    { id: "k3", text: "d" },
  ];
  const FORMS = ["id NOT IN ('alt')", "(id NOT IN ('alt'))"];
  const exclusion = (clauses = FORMS) => ({
    clauses,
    stats: { failClosed: 0 },
  });

  test("Metadatenfilter und Ausschluss per AND in einer Anfrage", async () => {
    const log = [];
    await lance.filteredQueryRows(
      fakeQuery(rows, () => false, log),
      "price < 10",
      {
        limit: 2,
        exclusion: exclusion(),
      }
    );
    expect(log).toEqual([
      { clause: "(price < 10) AND (id NOT IN ('alt'))", limit: 2 },
    ]);
  });

  test("Altspalten: ohne Metadatenfilter, aber weiter mit Ausschluss", async () => {
    const log = [];
    await lance.filteredQueryRows(
      fakeQuery(rows, (c) => c.includes("price"), log),
      "price < 10",
      { limit: 2, exclusion: exclusion() }
    );
    expect(log.map((l) => l.clause)).toEqual([
      "(price < 10) AND (id NOT IN ('alt'))",
      "id NOT IN ('alt')",
    ]);
  });

  test("erste Form abgelehnt: einmal die zweite Form, Ergebnis unverändert übernommen", async () => {
    const log = [];
    const result = await lance.filteredQueryRows(
      fakeQuery(rows, (c) => c === FORMS[0], log),
      null,
      { limit: 2, exclusion: exclusion() }
    );
    expect(log).toEqual([
      { clause: FORMS[0], limit: 2 },
      { clause: FORMS[1], limit: 2 },
    ]);
    // Attrappe liefert ungefiltert: es wird nichts nachträglich verworfen
    expect(result.map((r) => r.id)).toEqual(["alt", "k1"]);
  });

  test("mit Metadatenfilter: erst mit, dann ohne Filter, je Form", async () => {
    const log = [];
    await lance.filteredQueryRows(
      fakeQuery(rows, (c) => c.includes(FORMS[0]) && !c.includes("(("), log),
      "price < 10",
      { limit: 2, exclusion: exclusion() }
    );
    expect(log.map((l) => l.clause)).toEqual([
      `(price < 10) AND (${FORMS[0]})`,
      FORMS[0],
      `(price < 10) AND (${FORMS[1]})`,
    ]);
  });

  test("beide Formen abgelehnt: fail-closed, keine Treffer, nie eine Anfrage ohne Bedingung", async () => {
    const error = jest.spyOn(console, "error").mockImplementation(() => {});
    const log = [];
    const ex = exclusion();
    const result = await lance.filteredQueryRows(
      fakeQuery(rows, () => true, log),
      "price < 10",
      { limit: 2, exclusion: ex }
    );
    expect(result).toEqual([]);
    expect(log).toHaveLength(4);
    expect(log.every((l) => l.clause && l.clause.includes("NOT IN"))).toBe(
      true
    );
    expect(log.every((l) => l.limit === 2)).toBe(true);
    expect(ex.stats.failClosed).toBe(1);
    expect(error).toHaveBeenCalledWith(
      "[courseInventory] Ausschluss veralteter Kurse nicht in der Anfrage möglich (4 Bedingungen abgelehnt), Suche ohne Treffer."
    );
    error.mockRestore();
  });

  test("keine zulässige Form (unzulässige ID): fail-closed ohne Anfrage", async () => {
    const error = jest.spyOn(console, "error").mockImplementation(() => {});
    const log = [];
    const ex = exclusion([]);
    expect(
      await lance.filteredQueryRows(
        fakeQuery(rows, () => false, log),
        null,
        {
          limit: 2,
          exclusion: ex,
        }
      )
    ).toEqual([]);
    expect(log).toEqual([]);
    expect(ex.stats.failClosed).toBe(1);
    error.mockRestore();
  });

  test("ohne Ausschluss genau wie bisher (KIE-480: Fehler -> ungefiltert)", async () => {
    const log = [];
    const result = await lance.filteredQueryRows(
      fakeQuery(rows, () => true, log),
      "price < 10",
      { limit: 2 }
    );
    expect(log.map((l) => l.clause)).toEqual(["price < 10", null]);
    expect(result.map((r) => r.id)).toEqual(["alt", "k1"]);
  });
});
