/* eslint-env jest, node */
// KB-3 (issues/P-kursbestand/KB-3-status-seite.md, Nutzerentscheidung Ampel
// vom 26.10.2026, fixliste-kb3-r1.md): Ampel des Kursbestands je Workspace
// (D-KB3-1) nach Anteil der fehlenden Kurse und Alter des letzten
// erfolgreichen Abgleichs, die schlechtere Bewertung zählt; „nicht
// eingerichtet“ ohne gültige Kursliste und in jedem anderen Workspace als dem
// der Kursliste (D-KB3-3, Fixliste r5); Listen höchstens 500 mit
// Gesamtzahl (AK-1); leichter Zustand für den Menüpunkt (AK-5); nur lesend
// (NAK-1, NAK-3).

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
  courseMenuState,
  worstState,
  __test__: st,
} = statusModule;

const INVENTORY = "kufer_course_inventory";
const NOW = Date.parse("2026-10-26T10:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();
const WS = { slug: "ws", name: "VHS Beispiel" };

const clock = { now: NOW };
let stored; // Wert von kufer_course_inventory
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

/** Kursliste (Version 2 für den Workspace „ws“, sonst wie angegeben). */
function setInventory(overrides = {}) {
  stored = JSON.stringify({
    version: 2,
    workspace: "ws",
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

describe("Ampel nach Anteil der fehlenden Kurse (Nutzer 26.10.2026)", () => {
  test.each([
    ["0 von 1000", 0, "gruen", []],
    ["4,9 % (49 von 1000)", 49, "gruen", []],
    ["5 % (50 von 1000)", 50, "gelb", ["fehlen"]],
    ["10 % (100 von 1000)", 100, "gelb", ["fehlen"]],
    ["10,1 % (101 von 1000)", 101, "rot", ["fehlen"]],
  ])("%s fehlen: %s", async (_name, missing, state, reasons) => {
    workspaceWith(numbers("262", 1000 - missing));
    const status = await run(1, { offered: numbers("262", 1000) });
    expect(status.state).toBe(state);
    expect(status.reasons).toEqual(reasons);
    expect(status.counts).toEqual({
      offered: 1000,
      count: 1000 - missing,
      missing,
      hidden: 0,
    });
  });

  test("nur der Anteil zählt, keine feste Kursanzahl: 60 von 2000 (3 %) bleiben grün", async () => {
    workspaceWith(numbers("262", 1940));
    const status = await run(1, { offered: numbers("262", 2000) });
    expect(status).toMatchObject({ state: "gruen", reasons: [] });
    expect(status.missing).toHaveLength(60);
  });
});

describe("Ampel nach Alter des letzten erfolgreichen Abgleichs", () => {
  test.each([
    [23, "gruen", []],
    [24, "gelb", ["alter"]],
    [25, "gelb", ["alter"]],
    [71, "gelb", ["alter"]],
    [72, "gelb", ["alter"]],
    [73, "rot", ["alter"]],
  ])("%s h alt: %s", async (hours, state, reasons) => {
    workspaceWith(numbers("262", 100));
    const status = await run(hours);
    expect(status).toMatchObject({
      state,
      reasons,
      syncedAt: iso(NOW - hours * HOUR),
    });
  });

  test("ohne neuen Lauf läuft die Uhr weiter", async () => {
    workspaceWith(numbers("262", 100));
    expect((await run(1)).state).toBe("gruen");
    clock.now += 23 * HOUR;
    expect((await courseStatus(WS)).state).toBe("gelb");
    clock.now += 49 * HOUR;
    expect((await courseStatus(WS)).state).toBe("rot");
  });

  test("Lauf mit Störung verjüngt den Stand nicht: Alter ab created", async () => {
    workspaceWith(numbers("262", 100));
    setInventory({
      created: iso(NOW - 25 * HOUR),
      run: {
        at: iso(NOW - 10 * 60 * 1000),
        result: "nicht_geschrieben",
        cause: "feed_unsicher",
      },
    });
    expect(await courseStatus(WS)).toMatchObject({
      state: "gelb",
      reasons: ["alter"],
      syncedAt: iso(NOW - 25 * HOUR),
      lastRun: {
        at: iso(NOW - 10 * 60 * 1000),
        result: "nicht_geschrieben",
        cause: "feed_unsicher",
      },
    });
  });

  test("erfolgreicher Lauf nach älterem created zählt als Abgleich", async () => {
    workspaceWith(numbers("262", 100));
    setInventory({
      created: iso(NOW - 30 * HOUR),
      run: { at: iso(NOW - HOUR), result: "ok", cause: null },
    });
    expect(await courseStatus(WS)).toMatchObject({
      state: "gruen",
      syncedAt: iso(NOW - HOUR),
    });
  });

  test("ohne gültiges run: Alter aus created, letzter Lauf = created ohne Störung", async () => {
    workspaceWith(numbers("262", 100));
    setInventory({ run: null, created: iso(NOW - 30 * HOUR) });
    expect(await courseStatus(WS)).toMatchObject({
      state: "gelb",
      reasons: ["alter"],
      lastRun: { at: iso(NOW - 30 * HOUR), result: "ok", cause: null },
      syncedAt: iso(NOW - 30 * HOUR),
      estimatedEnd: false,
    });
  });
});

describe("Die schlechtere der beiden Bewertungen zählt", () => {
  test.each([
    ["fehlen gelb, Alter rot", 50, 73, "rot", ["fehlen", "alter"]],
    ["fehlen rot, Alter gelb", 101, 25, "rot", ["fehlen", "alter"]],
    ["fehlen gelb, Alter gelb", 50, 25, "gelb", ["fehlen", "alter"]],
    ["fehlen rot, Alter grün", 101, 1, "rot", ["fehlen"]],
    ["fehlen grün, Alter rot", 49, 73, "rot", ["alter"]],
  ])("%s: %s", async (_name, missing, hours, state, reasons) => {
    workspaceWith(numbers("262", 1000 - missing));
    const status = await run(hours, { offered: numbers("262", 1000) });
    expect(status).toMatchObject({ state, reasons });
  });
});

describe("Kursprogramm nicht erreichbar", () => {
  test("ändert die Ampel nicht selbst: grün, solange der Stand jung genug ist", async () => {
    workspaceWith(numbers("262", 100));
    setInventory({
      created: iso(NOW - 2 * HOUR),
      run: {
        at: iso(NOW - 5 * 60 * 1000),
        result: "nicht_geschrieben",
        cause: "feed_nicht_erreichbar",
      },
    });
    expect(await courseStatus(WS)).toMatchObject({
      state: "gruen",
      reasons: [],
      lastRun: { cause: "feed_nicht_erreichbar" },
    });
  });

  test("nach 25 h ohne erfolgreichen Abgleich gelb, die Ursache steht im letzten Lauf", async () => {
    workspaceWith(numbers("262", 100));
    setInventory({
      created: iso(NOW - 25 * HOUR),
      run: {
        at: iso(NOW - 5 * 60 * 1000),
        result: "nicht_geschrieben",
        cause: "feed_nicht_erreichbar",
      },
    });
    expect(await courseStatus(WS)).toMatchObject({
      state: "gelb",
      reasons: ["alter"],
      lastRun: { result: "nicht_geschrieben", cause: "feed_nicht_erreichbar" },
    });
  });
});

describe("Antwortform", () => {
  test("Grün: Zustand, Gründe, Zahlen, Listen, Lauf, Abgleich; ohne Verlauf, seit wann und wer handelt", async () => {
    workspaceWith(numbers("262", 100));
    const status = await run(1);
    expect(status).toEqual({
      state: "gruen",
      headline: "aktuell",
      details: [],
      reasons: [],
      counts: { offered: 100, count: 100, missing: 0, hidden: 0 },
      missingPercent: 0,
      missing: [],
      hidden: [],
      lastRun: { at: iso(NOW - HOUR), result: "ok", cause: null },
      syncedAt: iso(NOW - HOUR),
      listApplied: true,
      estimatedEnd: false,
    });
  });
});

// Vertrag r4 (fixliste-kb-r4.md): Überschrift, Zeilen und Anteil rechnet
// nur der Server, Seite und Mail lesen sie ab (Nr. 1, NF2, NF3)
describe("Vertrag r4: headline, details, missingPercent", () => {
  test.each([
    ["29 von 100", 100, 29, "rot", 29],
    ["57 von 100", 100, 57, "rot", 57],
    ["58 von 200", 200, 58, "rot", 29],
    ["100 von 1000 (Gelb)", 1000, 100, "gelb", 10],
    ["105 von 1000 (Rot)", 1000, 105, "rot", 10],
    ["9 von 1000", 1000, 9, "gruen", 0],
  ])("Anteil %s", async (_name, offered, missing, state, percent) => {
    workspaceWith(numbers("262", offered - missing));
    const status = await run(1, { offered: numbers("262", offered) });
    expect(status).toMatchObject({ state, missingPercent: percent });
  });

  const unreachable = {
    result: "nicht_geschrieben",
    cause: "feed_nicht_erreichbar",
  };
  test.each([
    ["Grün", 0, 1, null, "aktuell", []],
    ["Grün, Website nicht erreicht", 0, 1, unreachable, "aktuell", []],
    ["fehlen", 60, 1, null, "unvollstaendig", ["unvollstaendig"]],
    [
      "fehlen, Website nicht erreicht",
      60,
      1,
      unreachable,
      "unvollstaendig",
      ["unvollstaendig"],
    ],
    ["Alter", 0, 25, null, "nicht_aktualisiert", ["nicht_aktualisiert"]],
    [
      "Alter, Website nicht erreicht",
      0,
      25,
      unreachable,
      "nicht_abrufbar",
      ["nicht_abrufbar"],
    ],
    [
      "fehlen und Alter",
      60,
      80,
      null,
      "nicht_aktualisiert",
      ["nicht_aktualisiert", "unvollstaendig"],
    ],
    [
      "fehlen und Alter, Website nicht erreicht",
      60,
      30,
      unreachable,
      "nicht_abrufbar",
      ["nicht_abrufbar", "unvollstaendig"],
    ],
  ])(
    "Überschrift und Zeilen: %s",
    async (_name, missing, hours, lastRun, headline, details) => {
      workspaceWith(numbers("262", 1000 - missing));
      setInventory({
        offered: numbers("262", 1000),
        created: iso(NOW - hours * HOUR),
        run: lastRun
          ? { at: iso(NOW - 5 * 60 * 1000), ...lastRun }
          : { at: iso(NOW - hours * HOUR), result: "ok", cause: null },
      });
      expect(await courseStatus(WS)).toMatchObject({ headline, details });
    }
  );
});

// Fixliste r4 Nr. 2 (NF1): listApplied folgt derselben Prüfung wie der
// Chatpfad (created höchstens 24 h), damit die Seite keine Kurse
// „ausgeblendet“ nennt, die der KI-Berater wieder nennt
describe("Vertrag r4: listApplied", () => {
  test("frisch: der Chat wendet die Kursliste an", async () => {
    workspaceWith(numbers("262", 100));
    expect((await run(1)).listApplied).toBe(true);
    expect(await courseInventoryStatus(WS)).not.toBeNull();
  });

  test("25 h ohne neuen Stand: Gelb, die Kursliste gilt im Chat nicht mehr", async () => {
    workspaceWith(numbers("262", 100), {
      "custom-documents/alt.json": courseDoc("261-1"),
    });
    const status = await run(25);
    expect(status).toMatchObject({ state: "gelb", listApplied: false });
    expect(await courseSearchExclusion("ws")).toBeNull();
  });

  test("run.at frisch, created 30 h: Grün, der Chat wendet die Kursliste trotzdem nicht an", async () => {
    workspaceWith(numbers("262", 100), {
      "custom-documents/alt.json": courseDoc("261-1"),
    });
    setInventory({
      created: iso(NOW - 30 * HOUR),
      run: { at: iso(NOW - HOUR), result: "ok", cause: null },
    });
    expect(await courseStatus(WS)).toMatchObject({
      state: "gruen",
      listApplied: false,
      counts: { hidden: 1 },
    });
    expect(await courseSearchExclusion("ws")).toBeNull();
    expect(await courseInventoryStatus(WS)).toBeNull();
  });

  test("Menüpunkt ohne Listen: dieselbe Prüfung", async () => {
    workspaceWith(numbers("262", 100));
    setInventory({ created: iso(NOW - 30 * HOUR) });
    expect(
      (await inventoryModule.courseInventoryDetails(WS, { lists: false }))
        .listApplied
    ).toBe(false);
  });
});

describe("Nicht eingerichtet (D-KB3-3)", () => {
  const NOT_SET_UP = {
    state: "nicht_eingerichtet",
    headline: null,
    details: [],
    reasons: [],
    counts: null,
    missingPercent: 0,
    missing: [],
    hidden: [],
    lastRun: null,
    syncedAt: null,
    listApplied: false,
    estimatedEnd: false,
  };

  test("ohne Kursliste: nichts gelesen außer der einen Zeile", async () => {
    workspaceWith(numbers("262", 10));
    expect(await courseStatus(WS)).toEqual(NOT_SET_UP);
    expect(readDocument).not.toHaveBeenCalled();
  });

  test("ungültige Kursliste: kein JSON, Version 1, ohne workspace (r5)", async () => {
    jest.spyOn(console, "error").mockImplementation(() => {});
    workspaceWith(numbers("262", 10));
    stored = "{";
    expect(await courseStatus(WS)).toEqual(NOT_SET_UP);
    setInventory({ version: 1 });
    expect(await courseStatus(WS)).toEqual(NOT_SET_UP);
    setInventory({ workspace: undefined });
    expect(await courseStatus(WS)).toEqual(NOT_SET_UP);
    console.error.mockRestore();
  });

  // Fixliste r5: zwei Workspaces mit Kursen, nur der genannte wird bewertet
  test("r5: Kursliste eines anderen Workspace: nicht eingerichtet, kein Dokument gelesen", async () => {
    workspaceWith(numbers("262", 10));
    setInventory({ workspace: "kurse", offered: numbers("262", 10) });
    expect(await courseStatus(WS)).toEqual(NOT_SET_UP);
    expect(await courseStatusState(WS)).toBe("nicht_eingerichtet");
    expect(readDocument).not.toHaveBeenCalled();
  });
});

// Fixliste r5 (ersetzt E-KB3-4): Im Workspace der Kursliste wird immer
// bewertet, auch wenn dort kein angebotener Kurs eingelernt ist
describe("Workspace der Kursliste ohne angebotenen Kurs (r5)", () => {
  test("alles fehlt: Rot mit 100 %, die eingelernten Kurse sind ausgeblendet", async () => {
    workspaceWith(numbers("262", 10));
    setInventory({ offered: numbers("999", 5) });
    expect(await courseStatus(WS)).toMatchObject({
      state: "rot",
      headline: "unvollstaendig",
      reasons: ["fehlen"],
      counts: { offered: 5, count: 0, missing: 5, hidden: 10 },
      missingPercent: 100,
      listApplied: true,
    });
  });

  test("Workspace ohne ein einziges Dokument: Rot, alles fehlt", async () => {
    workspaceWith([]);
    setInventory({ offered: numbers("262", 3) });
    expect(await courseStatus(WS)).toMatchObject({
      state: "rot",
      counts: { offered: 3, count: 0, missing: 3, hidden: 0 },
    });
  });
});

// Fixliste r2 Nr. 6 (F8): Ein Lesefehler ist kein „nicht eingerichtet“. Die
// Bewertung wirft, die Endpunkte antworten mit 500; der Chatpfad bleibt wie
// ohne Kursliste.
describe("Lesefehler (Fixliste r2 Nr. 6)", () => {
  beforeEach(() => {
    jest.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    console.error.mockRestore();
  });

  test("Datenbank nicht lesbar: courseStatus wirft, der Chatpfad nicht", async () => {
    workspaceWith(numbers("262", 100));
    setInventory();
    prisma.system_settings.findFirst.mockRejectedValue(new Error("busy"));
    await expect(courseStatus(WS)).rejects.toThrow("busy");
    await expect(courseStatusState(WS)).rejects.toThrow("busy");
    expect(await courseInventoryStatus(WS)).toBeNull();
    expect(await courseSearchExclusion("ws")).toBeNull();
  });

  test("Aufbau des Index scheitert: courseStatus wirft, nicht gemerkt, der nächste Aufruf baut neu (Fixliste r4 Nr. 4)", async () => {
    workspaceWith(numbers("262", 100));
    setInventory();
    const listDocuments = jest.fn(async () => {
      throw new Error("Dokumente nicht lesbar");
    });
    inv.setDeps({
      findWorkspaceId: async () => 7,
      listDocuments,
      listVectors: async () => [],
      readDocumentText: async () => null,
      readDocument,
      tableRows: async () => null,
      rowTexts: async () => [],
    });
    await expect(courseStatus(WS)).rejects.toThrow("Dokumente nicht lesbar");
    expect(listDocuments).toHaveBeenCalledTimes(1);
    expect(await courseInventoryStatus(WS)).toBeNull();
    expect(listDocuments).toHaveBeenCalledTimes(2);
    await expect(courseStatus(WS)).rejects.toThrow("Dokumente nicht lesbar");
    expect(listDocuments).toHaveBeenCalledTimes(3);
  });

  // Fixliste r4 Nr. 5 (NF6): Sind alle Dokumente mit Suchdaten unlesbar
  // (Rechte nach einem Umzug), ist das kein „nicht eingerichtet“
  test("alle Kursdokumente unlesbar (EACCES): courseStatus wirft, der Chatpfad nicht", async () => {
    workspaceWith(numbers("262", 100));
    setInventory();
    inv.setDeps({
      findWorkspaceId: async () => 7,
      listDocuments: async () =>
        Object.keys(docs).map((docpath) => ({
          docId: docpath.replace(/^.*\/|\.json$/g, ""),
          docpath,
        })),
      listVectors: async (docIds) =>
        docIds.map((docId) => ({ docId, vectorId: `v-${docId}` })),
      readDocumentText: async () => {
        throw Object.assign(new Error("EACCES: permission denied"), {
          code: "EACCES",
        });
      },
      readDocument,
      tableRows: async () => null,
      rowTexts: async () => [],
    });
    await expect(courseStatus(WS)).rejects.toThrow("nicht lesbar");
    await expect(courseStatusState(WS)).rejects.toThrow("nicht lesbar");
    expect(await courseInventoryStatus(WS)).toBeNull();
    expect(await courseSearchExclusion("ws")).toBeNull();

    // ein unlesbares Dokument neben einem lesbaren ohne Kurs ist kein
    // Lesefehler: bewertet wird trotzdem (r5: alles fehlt, Rot)
    inv.reset();
    workspaceWith([], {
      "custom-documents/faq.json": { pageContent: "Häufige Fragen" },
      "custom-documents/kaputt.json": null,
    });
    setInventory();
    inv.setDeps({
      findWorkspaceId: async () => 7,
      listDocuments: async () =>
        Object.keys(docs).map((docpath) => ({
          docId: docpath.replace(/^.*\/|\.json$/g, ""),
          docpath,
        })),
      listVectors: async (docIds) =>
        docIds.map((docId) => ({ docId, vectorId: `v-${docId}` })),
      readDocumentText: async (docpath) => {
        if (docs[docpath] === null) throw new Error("ENOENT");
        return docs[docpath].pageContent;
      },
      readDocument,
      tableRows: async () => null,
      rowTexts: async () => [],
    });
    expect(await courseStatus(WS)).toMatchObject({
      state: "rot",
      counts: { offered: 100, count: 0, missing: 100, hidden: 0 },
    });
  });

  test("Menüpunkt: ein Fehler wird nicht gemerkt", async () => {
    workspaceWith(numbers("262", 94));
    setInventory();
    prisma.system_settings.findFirst.mockRejectedValueOnce(new Error("busy"));
    await expect(courseStatusState(WS)).rejects.toThrow("busy");
    expect(await courseStatusState(WS)).toBe("gelb");
  });

  // Fixliste r5 (ersetzt r4 Nr. 4): bewertet wird nur der Workspace der
  // Kursliste, sein Lesefehler verschwindet nicht hinter „nicht
  // eingerichtet“ der übrigen
  test("Menüpunkt: Lesefehler im Workspace der Kursliste wirft, andere Workspaces werden nicht gelesen", async () => {
    workspaceWith(numbers("262", 94));
    setInventory({ workspace: "kaputt" });
    inv.setDeps({
      findWorkspaceId: async (slug) => ({ ws: 7, kaputt: 8 })[slug] ?? null,
      listDocuments: async (workspaceId) => {
        if (workspaceId === 8) throw new Error("SQLITE_BUSY");
        return Object.keys(docs).map((docpath) => ({
          docId: docpath.replace(/^.*\/|\.json$/g, ""),
          docpath,
        }));
      },
      listVectors: async (docIds) =>
        docIds.map((docId) => ({ docId, vectorId: `v-${docId}` })),
      readDocumentText: async (docpath) => docs[docpath]?.pageContent ?? null,
      readDocument,
      tableRows: async () => null,
      rowTexts: async () => [],
    });
    const broken = { slug: "kaputt" };
    await expect(courseMenuState([WS, broken])).rejects.toThrow("SQLITE_BUSY");
    await expect(courseMenuState([broken])).rejects.toThrow("SQLITE_BUSY");
    expect(await courseMenuState([WS])).toBe("nicht_eingerichtet");
    expect(await courseMenuState([])).toBe("nicht_eingerichtet");
    // derselbe Workspace lesbar: sein Zustand zählt
    setInventory();
    st.reset();
    expect(await courseMenuState([broken, WS])).toBe("gelb");
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

  test("ohne Titel: nur Kursnummern; unlesbares Dokument: nur die Kursnummer", async () => {
    workspaceWith(["262-1"], {
      "custom-documents/alt.json": courseDoc("261-9"),
    });
    setInventory({ titles: undefined, offered: ["262-1", "262-2"] });
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
  test("über 24 h: Chat wie ohne Kursliste, die Status-Seite bewertet weiter mit Zahlen", async () => {
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
      state: "gelb",
      reasons: ["alter"],
      counts: { offered: 100, count: 100, missing: 0, hidden: 1 },
      listApplied: false,
    });
  });

  test("schreibt nichts, auch keinen Verlauf; ein alter Verlauf wird nicht gelesen", async () => {
    workspaceWith(numbers("262", 96));
    await run(1);
    await run(0.5);
    expect(prisma.system_settings.upsert).not.toHaveBeenCalled();
    const labels = prisma.system_settings.findFirst.mock.calls.map(
      ([args]) => args?.where?.label
    );
    expect(labels).not.toContain("kufer_course_status_history");
    expect(statusModule).not.toHaveProperty("HISTORY_LABEL");
  });
});
