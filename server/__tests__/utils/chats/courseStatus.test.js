/* eslint-env jest, node */
// KB-3 (issues/P-kursbestand/KB-3-status-seite.md): Ampel des Kursbestands je
// Workspace (D-KB3-1), Verlauf der Bewertungen mit zwei Läufen in Folge
// (D-KB3-2), „nicht eingerichtet“ ohne gültige Kursliste (D-KB3-3), Listen
// höchstens 500 mit Gesamtzahl (AK-1), wer handelt (AK-6), leichter Zustand
// für den Menüpunkt (AK-5), nur lesend (NAK-1, NAK-3).

jest.mock("../../../utils/prisma", () => ({
  system_settings: { upsert: jest.fn(), findFirst: jest.fn() },
}));

const prisma = require("../../../utils/prisma");
const inventoryModule = require("../../../utils/chats/courseInventory");
const statusModule = require("../../../utils/chats/courseStatus");

const {
  courseInventoryStatus,
  courseSearchExclusion,
  __test__: inv,
} = inventoryModule;
const {
  courseStatus,
  courseStatusState,
  worstState,
  HISTORY_LABEL,
  __test__: st,
} = statusModule;

const INVENTORY = "kufer_course_inventory";
const NOW = Date.parse("2026-10-26T10:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();
const WS = { slug: "ws", name: "VHS Beispiel" };

const clock = { now: NOW };
let stored; // Wert von kufer_course_inventory
let history; // Wert von kufer_course_status_history
let docs; // docpath -> Dokument

const numbers = (prefix, count) =>
  Array.from({ length: count }, (_, i) => `${prefix}-${i + 1}`);

const courseDoc = (number, title = `Kurs ${number}`, extra = {}) => ({
  pageContent: [
    `Titel: ${title}`,
    `Kursnummer: ${number}`,
    "Dauer: 6 Termine",
    `Kurs-Link: https://www.vhs-beispiel.de/kurs/${number}`,
    "",
    "Kursbeschreibung: Beschreibung.",
  ].join("\n"),
  start_date: "2026-09-02",
  ...extra,
});

/** Workspace mit eingelernten Kursdokumenten zu diesen Kursnummern. */
function workspaceWith(courseNumbers, extraDocs = {}) {
  docs = {};
  courseNumbers.forEach((number, i) => {
    docs[`custom-documents/k${i}.json`] = courseDoc(number);
  });
  Object.assign(docs, extraDocs);
}

/** Kursliste (Version 2, sonst wie angegeben). */
function setInventory(overrides = {}) {
  stored = JSON.stringify({
    version: 2,
    client: "vhs-beispiel",
    created: iso(NOW - HOUR),
    offered: numbers("262", 100),
    titles: {},
    estimatedEnd: false,
    run: { at: iso(NOW - HOUR), result: "ok", cause: null },
    ...overrides,
  });
}

const readDocument = jest.fn(async (docpath) => docs[docpath] ?? null);

beforeEach(() => {
  jest.clearAllMocks();
  clock.now = NOW;
  jest.spyOn(Date, "now").mockImplementation(() => clock.now);
  inv.reset();
  st.reset();
  stored = null;
  history = null;
  docs = {};
  prisma.system_settings.findFirst.mockImplementation(async ({ where }) =>
    where?.label === INVENTORY && stored !== null ? { value: stored } : null
  );
  inv.setDeps({
    findWorkspaceId: async (slug) => (slug === "ws" ? 7 : null),
    listDocuments: async () =>
      Object.keys(docs).map((docpath) => ({
        docId: docpath.replace(/^.*\/|\.json$/g, ""),
        docpath,
      })),
    listVectors: async (docIds) =>
      docIds.map((docId) => ({ docId, vectorId: `v-${docId}` })),
    readDocumentText: async (docpath) => docs[docpath]?.pageContent ?? null,
    readDocument,
    // kein LanceDB: eingelernt heißt Einträge in document_vectors
    tableRows: async () => null,
    rowTexts: async () => [],
  });
  st.setDeps({
    readHistory: async () => history,
    writeHistory: jest.fn(async (value) => {
      history = value;
    }),
  });
});

afterEach(() => {
  Date.now.mockRestore();
});

/** Ein neuer Lauf der Pipeline: neuer Stand, sonst wie angegeben. */
async function run(hoursAgo, overrides = {}) {
  setInventory({
    created: iso(clock.now - hoursAgo * HOUR),
    run: {
      at: iso(clock.now - hoursAgo * HOUR),
      result: "ok",
      cause: null,
    },
    ...overrides,
  });
  return await courseStatus(WS);
}

describe("Ampel (D-KB3-1)", () => {
  test("Grün: 0 fehlen, Abgleich jünger als 3 h; wer handelt: niemand", async () => {
    workspaceWith(numbers("262", 100));
    const status = await run(1);
    expect(status).toMatchObject({
      state: "gruen",
      reason: null,
      whoActs: null,
      counts: { offered: 100, count: 100, missing: 0, hidden: 0 },
      missing: [],
      hidden: [],
      lastRun: { at: iso(NOW - HOUR), result: "ok", cause: null },
      estimatedEnd: false,
    });
    expect(status.since).toBe(iso(NOW));
  });

  test("Gelb: 1 bis unter 5 % und unter 50 fehlen; Kufer handelt", async () => {
    workspaceWith(numbers("262", 96));
    const status = await run(1);
    expect(status).toMatchObject({
      state: "gelb",
      reason: "fehlen",
      whoActs: "kufer",
      counts: { offered: 100, count: 96, missing: 4 },
    });
  });

  test.each([
    ["5 von 100 (5 %)", "rot", 100, 95],
    ["50 von 2000 (2,5 %)", "rot", 2000, 1950],
    ["49 von 2000", "gelb", 2000, 1951],
  ])("%s fehlen: %s", async (_name, expected, offered, known) => {
    workspaceWith(numbers("262", known));
    const status = await run(1, { offered: numbers("262", offered) });
    expect(status.state).toBe(expected);
    expect(status.reason).toBe("fehlen");
  });

  test("Alter: ab 3 h gelb, über 24 h sofort rot, auch nach grünen Läufen", async () => {
    workspaceWith(numbers("262", 100));
    expect((await run(2.9)).state).toBe("gruen");
    expect(await run(3)).toMatchObject({ state: "gelb", reason: "alter" });
    // über 24 h: kein neuer Lauf, die Uhr läuft weiter
    clock.now += 22 * HOUR;
    expect(await courseStatus(WS)).toMatchObject({
      state: "rot",
      reason: "alter",
      whoActs: "kufer",
    });
  });

  test("Version 1: Alter aus created, letzter Lauf = created ohne Störung", async () => {
    workspaceWith(numbers("262", 100));
    setInventory({ version: 1, created: iso(NOW - 4 * HOUR) });
    const status = await courseStatus(WS);
    expect(status).toMatchObject({
      state: "gelb",
      reason: "alter",
      lastRun: { at: iso(NOW - 4 * HOUR), result: "ok", cause: null },
      estimatedEnd: false,
    });
  });

  test("Lauf mit Störung verjüngt den Stand nicht: Alter ab created", async () => {
    workspaceWith(numbers("262", 100));
    setInventory({
      created: iso(NOW - 4 * HOUR),
      run: {
        at: iso(NOW - 10 * 60 * 1000),
        result: "nicht_geschrieben",
        cause: "feed_unsicher",
      },
    });
    const status = await courseStatus(WS);
    expect(status).toMatchObject({
      state: "gelb",
      reason: "alter",
      whoActs: "kufer",
      lastRun: { result: "nicht_geschrieben", cause: "feed_unsicher" },
    });
  });
});

describe("Zwei Läufe in Folge (D-KB3-2)", () => {
  test("Gelb aus fehlenden Kursen erst, wenn auch der vorige Lauf so schlecht war", async () => {
    workspaceWith(numbers("262", 100));
    expect((await run(1)).state).toBe("gruen");
    // nächster Lauf: 4 fehlen (gelb), der vorige war grün
    workspaceWith(numbers("262", 96));
    expect((await run(0.5)).state).toBe("gruen");
    // dritter Lauf: wieder 4 fehlen
    const third = await run(0.2);
    expect(third).toMatchObject({ state: "gelb", since: iso(NOW) });
  });

  test("Rot nach gelbem Vorlauf ist zunächst gelb", async () => {
    workspaceWith(numbers("262", 96));
    expect((await run(1)).state).toBe("gelb");
    workspaceWith(numbers("262", 90));
    expect((await run(0.5)).state).toBe("gelb");
    expect((await run(0.2)).state).toBe("rot");
  });

  test("Kursprogramm nicht erreichbar: rot erst seit dem vorigen Lauf, dann handelt die Einrichtung", async () => {
    workspaceWith(numbers("262", 100));
    const created = iso(NOW - HOUR);
    await run(1);
    const unreachable = (minutesAgo) => ({
      created,
      run: {
        at: iso(NOW - minutesAgo * 60 * 1000),
        result: "nicht_geschrieben",
        cause: "feed_nicht_erreichbar",
      },
    });
    setInventory(unreachable(30));
    expect((await courseStatus(WS)).state).toBe("gruen");
    setInventory(unreachable(5));
    expect(await courseStatus(WS)).toMatchObject({
      state: "rot",
      reason: "nicht_erreichbar",
      whoActs: "einrichtung",
    });
  });

  test("Neue Bewertung nur bei geändertem run.at oder created; höchstens 5 je Workspace", async () => {
    workspaceWith(numbers("262", 100));
    await run(1);
    const writeHistory = jest.fn(async (value) => {
      history = value;
    });
    st.setDeps({ readHistory: async () => history, writeHistory });
    await courseStatus(WS);
    await courseStatus(WS);
    expect(writeHistory).not.toHaveBeenCalled();

    for (let i = 0; i < 7; i++) await run(0.9 - i * 0.1);
    const entry = JSON.parse(history).ws;
    expect(entry.runs).toHaveLength(st.HISTORY_MAX);
    expect(entry.runs[0].key).toContain(iso(NOW - 0.3 * HOUR));
    expect(entry).toMatchObject({ state: "gruen", since: iso(NOW) });
  });

  test("ohne vorigen Lauf gilt der aktuelle allein; ein kaputter Verlauf beginnt neu", async () => {
    history = "{kaputt";
    workspaceWith(numbers("262", 90));
    expect((await run(1)).state).toBe("rot");
    expect(Object.keys(JSON.parse(history))).toEqual(["ws"]);
  });
});

describe("Nicht eingerichtet (D-KB3-3)", () => {
  const NOT_SET_UP = {
    state: "nicht_eingerichtet",
    since: null,
    reason: null,
    whoActs: null,
    counts: null,
    missing: [],
    hidden: [],
    lastRun: null,
    estimatedEnd: false,
  };

  test("ohne Kursliste: nichts gelesen außer der einen Zeile, nichts gespeichert", async () => {
    workspaceWith(numbers("262", 10));
    expect(await courseStatus(WS)).toEqual(NOT_SET_UP);
    expect(history).toBeNull();
    expect(readDocument).not.toHaveBeenCalled();
  });

  test("ungültige Kursliste oder Liste ohne einen Kurs des Workspace", async () => {
    jest.spyOn(console, "error").mockImplementation(() => {});
    workspaceWith(numbers("262", 10));
    stored = "{";
    expect(await courseStatus(WS)).toEqual(NOT_SET_UP);
    setInventory({ offered: numbers("999", 5) });
    expect(await courseStatus(WS)).toEqual(NOT_SET_UP);
    expect(history).toBeNull();
    console.error.mockRestore();
  });
});

describe("Listen (AK-1)", () => {
  test("fehlend mit Titel aus der Kursliste in deren Schreibweise, ausgeblendet mit Titel, Beginn und Dauer aus dem Dokument", async () => {
    workspaceWith(["262-1"], {
      "custom-documents/alt.json": courseDoc("261-ALT", "Yoga am Morgen"),
    });
    setInventory({
      offered: ["262-1", "262-ABC", "262-3"],
      titles: { "262-ABC": "Japanisch A1.1 (Bildungsurlaub)" },
      estimatedEnd: true,
    });
    const status = await courseStatus(WS);
    expect(status.missing).toEqual([
      { knr: "262-ABC", title: "Japanisch A1.1 (Bildungsurlaub)" },
      { knr: "262-3", title: null },
    ]);
    expect(status.hidden).toEqual([
      {
        knr: "261-ALT",
        title: "Yoga am Morgen",
        start: "2026-09-02",
        duration: "6 Termine",
      },
    ]);
    expect(status.counts).toEqual({
      offered: 3,
      count: 1,
      missing: 2,
      hidden: 1,
    });
    expect(status.estimatedEnd).toBe(true);
  });

  test("Version 1: nur Kursnummern; unlesbares Dokument: nur die Kursnummer", async () => {
    workspaceWith(["262-1"], {
      "custom-documents/alt.json": courseDoc("261-9"),
    });
    setInventory({ version: 1, offered: ["262-1", "262-2"] });
    readDocument.mockRejectedValueOnce(new Error("ENOENT"));
    const status = await courseStatus(WS);
    expect(status.missing).toEqual([{ knr: "262-2", title: null }]);
    expect(status.hidden).toEqual([
      { knr: "261-9", title: null, start: null, duration: null },
    ]);
  });

  test("höchstens 500 Einträge je Liste, die Gesamtzahl steht in counts", async () => {
    const stale = {};
    numbers("261", 501).forEach((number, i) => {
      stale[`custom-documents/s${i}.json`] = courseDoc(number);
    });
    workspaceWith(numbers("262", 10), stale);
    setInventory({ offered: numbers("262", 610) });
    const status = await courseStatus(WS);
    expect(status.counts).toEqual({
      offered: 610,
      count: 10,
      missing: 600,
      hidden: 501,
    });
    expect(status.missing).toHaveLength(500);
    expect(status.hidden).toHaveLength(500);
    expect(readDocument).toHaveBeenCalledTimes(500);
  });

  test("Dokumente der ausgeblendeten Kurse werden einmal je Index gelesen", async () => {
    workspaceWith(["262-1"], {
      "custom-documents/alt.json": courseDoc("261-1"),
    });
    setInventory({ offered: ["262-1"] });
    await courseStatus(WS);
    await courseStatus(WS);
    expect(readDocument).toHaveBeenCalledTimes(1);
  });
});

describe("Menüpunkt (AK-5)", () => {
  test("nur der Zustand, ohne Listen, je Workspace 5 min gemerkt", async () => {
    workspaceWith(["262-1"], {
      "custom-documents/alt.json": courseDoc("261-1"),
    });
    setInventory({ offered: ["262-1"] });
    expect(await courseStatusState(WS)).toBe("gruen");
    expect(readDocument).not.toHaveBeenCalled();

    setInventory({ offered: ["262-1", "262-2", "262-3"] });
    clock.now += st.STATE_CACHE_MS - 1;
    expect(await courseStatusState(WS)).toBe("gruen");
    clock.now += 1;
    expect(await courseStatusState(WS)).toBe("rot");
  });

  test("der schlechteste Zustand zählt", () => {
    expect(worstState([])).toBe("nicht_eingerichtet");
    expect(worstState(["gruen", "nicht_eingerichtet"])).toBe("gruen");
    expect(worstState(["gruen", "rot", "gelb"])).toBe("rot");
    expect(worstState(["gelb", "gruen"])).toBe("gelb");
  });
});

describe("Nur lesend (NAK-1, NAK-3)", () => {
  test("über 24 h: Chat wie ohne Kursliste, die Status-Seite zeigt rot mit Zahlen", async () => {
    workspaceWith(numbers("262", 100), {
      "custom-documents/alt.json": courseDoc("261-1"),
    });
    setInventory({
      created: iso(NOW - 25 * HOUR),
      run: { at: iso(NOW - 25 * HOUR), result: "ok", cause: null },
    });
    expect(await courseInventoryStatus(WS)).toBeNull();
    expect(await courseSearchExclusion("ws")).toBeNull();
    expect(await courseStatus(WS)).toMatchObject({
      state: "rot",
      reason: "alter",
      counts: { offered: 100, count: 100, missing: 0, hidden: 1 },
    });
  });

  test("die Kursliste wird nie geschrieben, nur der eigene Verlauf", async () => {
    workspaceWith(numbers("262", 96));
    await run(1);
    expect(prisma.system_settings.upsert).not.toHaveBeenCalled();
    expect(HISTORY_LABEL).toBe("kufer_course_status_history");
  });
});
