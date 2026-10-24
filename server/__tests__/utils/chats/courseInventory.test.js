/* eslint-env jest, node */
// KIE-576 Paket 3: Kursbestand des Kursprogramms (kufer_course_inventory).
// AK-K2: Validator nach Vertrag (Form, 512 KiB, Alter 24 h), nicht über HTTP
// schreibbar (NAK-K4), ungültig = wie heute (NAK-K1). AK-K4: count = |A ∩ B|,
// offered = |A|, stale = |B \ A| aus den eigenen Kursdokumenten des
// Workspace, gemerkt höchstens 1 h je Workspace und Wert. AK-K9: Dokumente
// ohne Suchdaten zählen nicht als eingelernt. NAK-K2: nie ein Dokument ohne
// Kursnummer, nie bei leerer Liste oder ohne angebotenen Kurs.

const fs = require("fs");
const path = require("path");

jest.mock("../../../utils/prisma", () => ({
  system_settings: { upsert: jest.fn(), findFirst: jest.fn() },
}));

const prisma = require("../../../utils/prisma");
const { SystemSettings } = require("../../../models/systemSettings");
const inventoryModule = require("../../../utils/chats/courseInventory");
const {
  COURSE_INVENTORY_LABEL,
  validateCourseInventorySetting,
  loadCourseInventory,
  courseSearchExclusion,
  courseInventoryGuard,
  courseInventoryStatus,
  courseCountField,
  __test__: t,
} = inventoryModule;

const LABEL = "kufer_course_inventory";
const NOW = Date.parse("2026-10-24T10:00:00.000Z");
const value = (overrides = {}) =>
  JSON.stringify({
    version: 1,
    client: "vhs-beispiel",
    created: "2026-10-24T08:00:00Z",
    offered: ["262-100", "262-101", "262-102", "262-103"],
    ...overrides,
  });

const courseText = (number, title = "Kurs") =>
  [
    `Titel: ${title}`,
    `Kursnummer: ${number}`,
    "Kursstatus: Anmeldung möglich",
    `Kurs-Link: https://www.vhs-beispiel.de/kurs/${number}`,
    "",
    "Kursbeschreibung: Beschreibung.",
  ].join("\n");
const chunk = (text) =>
  `<document_metadata>\nsourceDocument: kurs.txt\n</document_metadata>\n\n${text}`;

// Uhr der Tests (Date.now), unabhängig von Rechner und Zeitzone
const clock = { now: NOW };
beforeEach(() => {
  jest.clearAllMocks();
  clock.now = NOW;
  jest.spyOn(Date, "now").mockImplementation(() => clock.now);
  t.reset();
  prisma.system_settings.upsert.mockResolvedValue({});
  prisma.system_settings.findFirst.mockResolvedValue(null);
});

describe("Validator (AK-K2) und Schreibweg (NAK-K4)", () => {
  test("nicht über HTTP schreibbar (supportedFields), nie öffentlich (publicFields)", async () => {
    expect(COURSE_INVENTORY_LABEL).toBe(LABEL);
    expect(SystemSettings.supportedFields).not.toContain(LABEL);
    expect(SystemSettings.publicFields).not.toContain(LABEL);
    const result = await SystemSettings.updateSettings({ [LABEL]: value() });
    expect(result).toEqual({ success: true, error: null });
    expect(prisma.system_settings.upsert).not.toHaveBeenCalled();
  });

  test("gültiger Wert wird über _updateSettings unverändert gespeichert", async () => {
    const raw = value();
    const result = await SystemSettings._updateSettings({ [LABEL]: raw });
    expect(result).toEqual({ success: true, error: null });
    expect(prisma.system_settings.upsert).toHaveBeenCalledWith({
      where: { label: LABEL },
      update: { value: raw },
      create: { label: LABEL, value: raw },
    });
  });

  test("leerer Wert leert die Einstellung (null), der Server verhält sich wie heute", async () => {
    const result = await SystemSettings._updateSettings({ [LABEL]: "" });
    expect(result).toEqual({ success: true, error: null });
    expect(prisma.system_settings.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: { value: null } })
    );
  });

  test.each([
    ["kein JSON", "{"],
    ["version 2", value({ version: 2 })],
    ["client fehlt", value({ client: "" })],
    ["created kein Zeitpunkt", value({ created: "gestern" })],
    ["offered fehlt", value({ offered: undefined })],
    ["offered leer", value({ offered: [] })],
    ["offered mit Zahl statt Text", value({ offered: [262] })],
    ["offered mit leerer Nummer", value({ offered: ["262-1", "  "] })],
    ["Nummer zu lang", value({ offered: ["x".repeat(65)] })],
    ["älter als 24 h", value({ created: "2026-10-23T09:59:00Z" })],
    ["mehr als 1 h in der Zukunft", value({ created: "2026-10-24T11:30:00Z" })],
    ["größer als 512 KiB", value({ pad: "x".repeat(512 * 1024) })],
  ])("%s: abgelehnt", (_name, raw) => {
    expect(() => validateCourseInventorySetting(raw, { now: NOW })).toThrow(
      LABEL
    );
  });

  test("abgelehnter Wert: nichts geschrieben, Fehler an den Aufrufer (docker exec)", async () => {
    jest.spyOn(console, "error").mockImplementation(() => {});
    const result = await SystemSettings._updateSettings({
      [LABEL]: value({ offered: [] }),
    });
    console.error.mockRestore();
    expect(result.success).toBe(false);
    expect(result.error).toMatch(LABEL);
    expect(prisma.system_settings.upsert).not.toHaveBeenCalled();
  });

  test("Grenze 512 KiB und 24 h: genau an der Grenze gültig, unbekannte Felder erlaubt", () => {
    const base = value({ neu: true });
    const padded = base.replace(
      '"neu":true',
      `"neu":true,"pad":"${"x".repeat(512 * 1024 - Buffer.byteLength(base) - 9)}"`
    );
    expect(Buffer.byteLength(padded)).toBe(512 * 1024);
    expect(validateCourseInventorySetting(padded, { now: NOW })).toBe(padded);
    const exactly24h = value({ created: "2026-10-23T10:00:00Z" });
    expect(validateCourseInventorySetting(exactly24h, { now: NOW })).toBe(
      exactly24h
    );
  });

  test("Label nur im Modell und im Lesemodul (kein Ausgabeweg)", () => {
    const serverRoot = path.resolve(__dirname, "../../..");
    const jsFiles = (dir) =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory())
          return ["node_modules", "__tests__", "storage"].includes(entry.name)
            ? []
            : jsFiles(full);
        return entry.name.endsWith(".js") ? [full] : [];
      });
    const users = jsFiles(serverRoot)
      .filter((file) => fs.readFileSync(file, "utf8").includes(LABEL))
      .map((file) => path.relative(serverRoot, file))
      .sort();
    expect(users).toEqual([
      path.join("models", "systemSettings.js"),
      path.join("utils", "chats", "courseInventory.js"),
    ]);
  });
});

describe("Lesen (NAK-K1)", () => {
  afterEach(() => console.error.mockRestore?.());
  test.each([
    ["fehlt", null],
    ["kein JSON", { value: "{" }],
    ["version 2", { value: value({ version: 2 }) }],
    ["leeres offered", { value: value({ offered: [] }) }],
    ["älter als 24 h", { value: value({ created: "2026-10-23T09:00:00Z" }) }],
  ])("%s: kein Kursbestand", async (_name, row) => {
    jest.spyOn(console, "error").mockImplementation(() => {});
    prisma.system_settings.findFirst.mockResolvedValue(row);
    expect(await loadCourseInventory({ now: NOW })).toBeNull();
    console.error.mockRestore();
  });

  test("Datenbankfehler: kein Kursbestand, kein Wurf", async () => {
    jest.spyOn(console, "error").mockImplementation(() => {});
    prisma.system_settings.findFirst.mockRejectedValue(new Error("busy"));
    expect(await loadCourseInventory({ now: NOW })).toBeNull();
    console.error.mockRestore();
  });

  test("gültig: Kursnummern in Vergleichsform, stand als ISO-Zeitpunkt", async () => {
    prisma.system_settings.findFirst.mockResolvedValue({
      value: value({ offered: [" 262-100 ", "A 1"] }),
    });
    const inventory = await loadCourseInventory({ now: NOW });
    expect([...inventory.offered]).toEqual(["262-100", "a 1"]);
    expect(inventory.stand).toBe("2026-10-24T08:00:00.000Z");
    expect(prisma.system_settings.findFirst).toHaveBeenCalledWith({
      where: { label: LABEL },
      select: { value: true },
    });
  });
});

// Workspace „ws“: Dokumente mit Kursnummern 262-100..102 (angeboten), 262-900
// und 262-901 (veraltet), eine Webseite und eine FAQ ohne Kursnummer, 262-103
// angeboten, aber ohne Suchdaten (AK-K9), 262-102 doppelt hochgeladen.
const DOCS = {
  "custom-documents/k100.json": courseText("262-100"),
  "custom-documents/k101.json": courseText("262-101"),
  "custom-documents/k102.json": courseText("262-102"),
  "custom-documents/k102b.json": courseText("262-102"),
  "custom-documents/k103.json": courseText("262-103"),
  "custom-documents/k900.json": courseText("262-900", "Alter Kurs"),
  "custom-documents/k901.json": courseText("262-901", "Noch älter"),
  "custom-documents/seite.json":
    "Kursnummer: 262-999\nWebseite ohne Titelzeile am Anfang",
  "custom-documents/faq.json": "Titel: FAQ\nWie melde ich mich an?",
};
const VECTORS = {
  k100: ["v100a", "v100b"],
  k101: ["v101"],
  k102: ["v102"],
  k102b: ["v102b"],
  k900: ["v900a", "v900b"],
  k901: ["v901"],
  seite: ["vs"],
  faq: ["vf"],
};

function installDeps({ present = undefined, reads = [] } = {}) {
  const deps = {
    findWorkspaceId: jest.fn(async (slug) => (slug === "ws" ? 7 : null)),
    listDocuments: jest.fn(async () =>
      Object.keys(DOCS).map((docpath) => ({
        docId: path.basename(docpath, ".json"),
        docpath,
      }))
    ),
    listVectors: jest.fn(async (docIds) =>
      docIds.flatMap((docId) =>
        (VECTORS[docId] || []).map((vectorId) => ({ docId, vectorId }))
      )
    ),
    readDocumentText: jest.fn(async (docpath) => {
      reads.push(docpath);
      return DOCS[docpath] ?? null;
    }),
    existingVectorIds: jest.fn(async (_slug, ids) =>
      present === undefined ? new Set(ids) : present
    ),
  };
  t.setDeps(deps);
  return deps;
}

describe("Index je Workspace (AK-K4, AK-K9)", () => {
  beforeEach(() => {
    prisma.system_settings.findFirst.mockResolvedValue({ value: value() });
  });

  test("count = |A ∩ B|, offered = |A|, stale = |B \\ A|, missing = |A \\ B|", async () => {
    installDeps();
    const status = await courseInventoryStatus({ slug: "ws" });
    // A = 100..103, B (eingelernt) = 100, 101, 102, 900, 901 (103 ohne
    // document_vectors), Dokumente ohne Kursnummer zählen nie
    expect(status).toEqual({
      count: 3,
      offered: 4,
      stale: 2,
      missing: 1,
      stand: "2026-10-24T08:00:00.000Z",
    });
  });

  test("AK-K9: ohne Zeilen im Vektorspeicher zählt ein Dokument nicht als eingelernt", async () => {
    installDeps({ present: new Set(["v100b", "v900a", "vs"]) });
    const status = await courseInventoryStatus({ slug: "ws" });
    expect(status).toMatchObject({ count: 1, stale: 1, missing: 3 });
    // ausgeschlossen werden trotzdem alle veralteten Abschnitte
    const exclusion = await courseSearchExclusion("ws");
    expect(exclusion.where).toBe("id NOT IN ('v900a','v900b','v901')");
  });

  test("AK-K9: Vektorspeicher nicht prüfbar (null): es zählt document_vectors", async () => {
    installDeps({ present: null });
    expect(await courseInventoryStatus({ slug: "ws" })).toMatchObject({
      count: 3,
      stale: 2,
    });
  });

  test("gemerkt je Workspace und Wert, höchstens 1 h; neuer Wert rechnet neu, Dateien nur einmal gelesen", async () => {
    const reads = [];
    const deps = installDeps({ reads });
    await courseInventoryStatus({ slug: "ws" });
    await courseInventoryStatus({ slug: "ws" });
    clock.now += t.INDEX_MAX_AGE_MS - 1;
    await courseSearchExclusion("ws");
    expect(deps.listDocuments).toHaveBeenCalledTimes(1);
    clock.now += 2;
    await courseInventoryStatus({ slug: "ws" });
    expect(deps.listDocuments).toHaveBeenCalledTimes(2);
    // anderer Wert (stündlicher Lauf): sofort neu
    prisma.system_settings.findFirst.mockResolvedValue({
      value: value({ created: new Date(clock.now).toISOString() }),
    });
    await courseInventoryStatus({ slug: "ws" });
    expect(deps.listDocuments).toHaveBeenCalledTimes(3);
    // Dokumentdateien ändern sich nicht: jede nur einmal gelesen
    expect(reads.sort()).toEqual(Object.keys(DOCS).sort());
  });

  test("Fehler beim Aufbau: null ohne Merken, der nächste Aufruf versucht es neu", async () => {
    jest.spyOn(console, "error").mockImplementation(() => {});
    const deps = installDeps();
    deps.listDocuments.mockRejectedValueOnce(new Error("busy"));
    expect(await courseInventoryStatus({ slug: "ws" })).toBeNull();
    expect(await courseInventoryStatus({ slug: "ws" })).toMatchObject({
      count: 3,
    });
    console.error.mockRestore();
  });

  test("NAK-K2: kein angebotener Kurs im Workspace (Liste eines anderen Kunden): nichts ausgeblendet, keine Zahl", async () => {
    installDeps();
    prisma.system_settings.findFirst.mockResolvedValue({
      value: value({ offered: ["999-1", "999-2"] }),
    });
    expect(await courseInventoryStatus({ slug: "ws" })).toBeNull();
    expect(await courseSearchExclusion("ws")).toBeNull();
    expect(await courseInventoryGuard({ slug: "ws" })).toBeNull();
  });

  test("NAK-K1: ohne gültigen Wert weder Zahl noch Ausschluss, kein Dokument gelesen", async () => {
    const deps = installDeps();
    prisma.system_settings.findFirst.mockResolvedValue(null);
    expect(await courseInventoryStatus({ slug: "ws" })).toBeNull();
    expect(await courseSearchExclusion("ws")).toBeNull();
    expect(await courseInventoryGuard({ slug: "ws" })).toBeNull();
    expect(deps.listDocuments).not.toHaveBeenCalled();
  });

  test("unbekannter Workspace: null", async () => {
    installDeps();
    expect(await courseInventoryStatus({ slug: "anders" })).toBeNull();
    expect(await courseInventoryStatus(null)).toBeNull();
  });
});

describe("Ausschluss und Prüfer (E35, NAK-K2)", () => {
  beforeEach(() => {
    prisma.system_settings.findFirst.mockResolvedValue({ value: value() });
    installDeps();
  });

  test("Filterbedingung nur mit den Abschnitten veralteter Kursdokumente", async () => {
    const exclusion = await courseSearchExclusion("ws");
    expect(exclusion.where).toBe("id NOT IN ('v900a','v900b','v901')");
    expect(exclusion.staleDocs).toBe(2);
    expect(exclusion.extra).toBe(3);
    // Treffer: über die Vektor-ID oder den eigenen Kopfblock
    expect(exclusion.hides({ id: "v900b", text: "Folgeabschnitt" })).toBe(true);
    expect(
      exclusion.hides({ id: "fremd", text: chunk(courseText("262-777")) })
    ).toBe(true);
    expect(
      exclusion.hides({ id: "v100a", text: chunk(courseText("262-100")) })
    ).toBe(false);
    // Dokumente ohne Kursnummer nie
    expect(
      exclusion.hides({ id: "vs", text: DOCS["custom-documents/seite.json"] })
    ).toBe(false);
    expect(exclusion.hides({ id: "vf", text: "Titel: FAQ\nText" })).toBe(false);
    expect(
      exclusion.hides({
        id: "x",
        text: "Kursbeschreibung: Kursnummer: 262-777",
      })
    ).toBe(false);
  });

  test("zu viele Abschnitte: kein Vorfilter, nur der Rückfall", async () => {
    t.reset();
    prisma.system_settings.findFirst.mockResolvedValue({ value: value() });
    const many = Array.from(
      { length: t.EXCLUSION_WHERE_MAX_IDS + 1 },
      (_, i) => `id-${i}`
    );
    installDeps();
    const deps = installDeps();
    deps.listVectors.mockImplementation(async (docIds) =>
      docIds.flatMap((docId) =>
        (docId === "k900" ? many : VECTORS[docId] || []).map((vectorId) => ({
          docId,
          vectorId,
        }))
      )
    );
    const exclusion = await courseSearchExclusion("ws");
    expect(exclusion.where).toBeNull();
    expect(exclusion.hides({ id: "id-17" })).toBe(true);
    expect(exclusion.extra).toBe(500);
  });

  test("Vektor-IDs mit fremden Zeichen kommen nie in die Bedingung", async () => {
    const deps = installDeps();
    deps.listVectors.mockImplementation(async (docIds) =>
      docIds.includes("k900")
        ? [
            { docId: "k900", vectorId: "ok-1" },
            { docId: "k900", vectorId: "x') OR (1=1" },
            { docId: "k100", vectorId: "v100a" },
          ]
        : []
    );
    const exclusion = await courseSearchExclusion("ws");
    expect(exclusion.where).toBe("id NOT IN ('ok-1')");
    expect(exclusion.hides({ id: "x') OR (1=1" })).toBe(true);
  });

  test("Prüfer: angeheftete Dokumente, gespeicherte Quellen, Kurskarten-Dokumente", async () => {
    const log = jest.spyOn(console, "log").mockImplementation(() => {});
    const guard = await courseInventoryGuard({ slug: "ws" });
    const pinned = [
      { pageContent: courseText("262-100") },
      { pageContent: courseText("262-900") },
      { pageContent: "Zusatzwissen ohne Kursnummer" },
    ];
    expect(guard.filterPinned(pinned)).toEqual([pinned[0], pinned[2]]);
    expect(guard.hidesSource({ id: "v901", text: "Folgeabschnitt" })).toBe(
      true
    );
    expect(
      guard.hidesSource({ id: "alt", text: chunk(courseText("262-555")) })
    ).toBe(true);
    expect(
      guard.hidesSource({ id: "v101", text: chunk(courseText("262-101")) })
    ).toBe(false);
    expect(guard.hidesDocument({ pageContent: courseText("262-901") })).toBe(
      true
    );
    expect(guard.hidesDocument({ pageContent: courseText("262-101") })).toBe(
      false
    );
    guard.report();
    // nur Zahlen und Workspace
    expect(log).toHaveBeenCalledWith(
      "[courseInventory] ws: ausgeblendet 1 angeheftete Dokumente, 2 Quellen aus dem Verlauf"
    );
    log.mockRestore();
  });
});

describe("courseCount für /config (Vertrag)", () => {
  beforeEach(() => {
    prisma.system_settings.findFirst.mockResolvedValue({ value: value() });
    installDeps();
  });

  test("Anzeige an: count, offered, stand, word", async () => {
    expect(
      await courseCountField({ slug: "ws" }, { mode: "on", word: "Kurse" })
    ).toEqual({
      count: 3,
      offered: 4,
      stand: "2026-10-24T08:00:00.000Z",
      word: "Kurse",
    });
  });

  test("Anzeige aus: kein Feld, nichts berechnet", async () => {
    const deps = installDeps();
    expect(
      await courseCountField({ slug: "ws" }, { mode: "off", word: "Kurse" })
    ).toBeNull();
    expect(deps.listDocuments).not.toHaveBeenCalled();
  });

  test("count 0 (kein angebotener Kurs eingelernt): kein Feld", async () => {
    installDeps({ present: new Set(["v900a"]) });
    expect(
      await courseCountField({ slug: "ws" }, { mode: "on", word: "Kurse" })
    ).toBeNull();
  });
});

describe("Kursnummer aus dem Kopfblock", () => {
  test.each([
    [courseText("262-4912"), "262-4912"],
    [chunk(courseText("262-4912")), "262-4912"],
    ["Titel: X\nKursnummer:   A123456-B  \n", "a123456-b"],
    // Kursbeschreibung vor der Kursnummer (alter Extraktor): kein Kopfblock
    ["Titel: X\nKursbeschreibung: Text\nKursnummer: 1", null],
    ["Kursnummer: 1\nTitel: X", null],
    ["Titel: X\n\nKursnummer: 1", null],
    ["", null],
    [undefined, null],
  ])("%j -> %j", (text, expected) => {
    expect(t.courseKeyOfText(text)).toBe(expected);
  });
});
