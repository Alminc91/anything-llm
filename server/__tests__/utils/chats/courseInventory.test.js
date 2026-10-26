/* eslint-env jest, node */
// KIE-576 Paket 3: Kursbestand des Kursprogramms (kufer_course_inventory).
// AK-K2: Validator nach Vertrag (Form, 512 KiB, Alter 24 h), nicht über HTTP
// schreibbar (NAK-K4), ungültig = wie heute (NAK-K1). AK-K4: count = |A ∩ B|,
// offered = |A|, hidden = |B \ A| (veraltete Kursnummern, D-K5) aus den eigenen
// Kursdokumenten des Workspace, gemerkt höchstens 1 h je Workspace und Wert. AK-K9: Dokumente
// ohne Suchdaten zählen nicht als eingelernt. NAK-K2: nie ein Dokument ohne
// Kursnummer, nie bei leerer Liste. Fixliste r5: die Kursliste gehört zu
// genau einem Workspace (Pflichtfeld workspace, nur Version 2); jeder andere
// Workspace ist nicht eingerichtet und blendet nichts aus.

const fs = require("fs");
const path = require("path");

jest.mock("../../../utils/prisma", () => ({
  system_settings: { upsert: jest.fn(), findFirst: jest.fn() },
}));

const prisma = require("../../../utils/prisma");
const { SystemSettings } = require("../../../models/systemSettings");
const { Workspace } = require("../../../models/workspace");
const inventoryModule = require("../../../utils/chats/courseInventory");
const {
  COURSE_INVENTORY_LABEL,
  validateCourseInventorySetting,
  loadCourseInventory,
  courseSearchExclusion,
  courseInventoryGuard,
  courseInventoryStatus,
  courseCountField,
  courseInventoryRecord,
  __test__: t,
} = inventoryModule;

const LABEL = "kufer_course_inventory";
const NOW = Date.parse("2026-10-24T10:00:00.000Z");
const value = (overrides = {}) =>
  JSON.stringify({
    version: 2,
    workspace: "ws",
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
    ["version 1 (r5: entfällt)", value({ version: 1 })],
    ["version 3", value({ version: 3 })],
    ["workspace fehlt (r5)", value({ workspace: undefined })],
    ["workspace leer", value({ workspace: "" })],
    ["workspace kein Text", value({ workspace: 7 })],
    ["workspace mit Großbuchstaben", value({ workspace: "VHS-Beispiel" })],
    ["workspace mit Leerzeichen", value({ workspace: "vhs beispiel" })],
    ["workspace mit Schrägstrich", value({ workspace: "../ws" })],
    ["workspace länger als 255 Zeichen", value({ workspace: "w".repeat(256) })],
    ["client fehlt", value({ client: "" })],
    ["created kein Zeitpunkt", value({ created: "gestern" })],
    ["offered fehlt", value({ offered: undefined })],
    ["offered leer", value({ offered: [] })],
    ["offered mit Zahl statt Text", value({ offered: [262] })],
    ["offered nur mit leeren Nummern", value({ offered: ["  ", ""] })],
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

  test("r5: workspace nimmt jeden Slug an, den AnythingLLM erzeugt", () => {
    const names = [
      "VHS Köln",
      "Kursprogramm 2026",
      "  __ Kurs_Programm -- 2 ",
      "x.y+z!@*",
      "a$b%c&d<e>f|g",
      "™©®",
      "Привет",
      "Ünïcödé €uro",
      ...Array.from({ length: 0x250 - 0x20 }, (_, i) =>
        String.fromCodePoint(0x20 + i)
      ).map((char) => `a${char}b`),
    ];
    const slugs = [
      ...names.map((name) => Workspace.slugify(name, { lower: true })),
      "3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e",
      "w".repeat(255),
    ].filter((slug) => slug.length > 0);
    for (const slug of slugs) {
      const raw = value({ workspace: slug });
      expect(validateCourseInventorySetting(raw, { now: NOW })).toBe(raw);
    }
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
    ["version 1", { value: value({ version: 1 }) }],
    ["version 3", { value: value({ version: 3 }) }],
    ["ohne workspace", { value: value({ workspace: undefined }) }],
    ["leeres offered", { value: value({ offered: [] }) }],
    ["älter als 24 h", { value: value({ created: "2026-10-23T09:00:00Z" }) }],
  ])("%s: kein Kursbestand", async (_name, row) => {
    jest.spyOn(console, "error").mockImplementation(() => {});
    prisma.system_settings.findFirst.mockResolvedValue(row);
    expect(await loadCourseInventory({ now: NOW })).toBeNull();
    console.error.mockRestore();
  });

  test("J: ungültige Einträge in offered werden übersprungen, der Wert gilt (einmal je Wert geloggt)", async () => {
    const error = jest.spyOn(console, "error").mockImplementation(() => {});
    const raw = value({
      offered: ["262-100", "  ", 262, "x".repeat(65), "262-\u0007", "262-101"],
    });
    expect(validateCourseInventorySetting(raw, { now: NOW })).toBe(raw);
    prisma.system_settings.findFirst.mockResolvedValue({ value: raw });
    const inventory = await loadCourseInventory({ now: NOW });
    expect([...inventory.offered]).toEqual(["262-100", "262-101"]);
    await loadCourseInventory({ now: NOW });
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(
      "[courseInventory] Kursliste: 4 ungültige Kursnummern übersprungen"
    );
  });

  // Fixliste r4 Nr. 6 (NC3): abgefangen wird nur noch an einer Stelle
  // (workspaceInventory), der Chat bleibt wie ohne Kursliste
  test("Datenbankfehler: loadCourseInventory wirft, der Chatpfad nicht", async () => {
    const error = jest.spyOn(console, "error").mockImplementation(() => {});
    prisma.system_settings.findFirst.mockRejectedValue(new Error("busy"));
    await expect(loadCourseInventory({ now: NOW })).rejects.toThrow("busy");
    expect(await courseInventoryStatus({ slug: "ws" })).toBeNull();
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(
      "[courseInventory] Index nicht gebaut: busy"
    );
    console.error.mockRestore();
  });

  test("gültig: Kursnummern in Vergleichsform, stand als ISO-Zeitpunkt", async () => {
    prisma.system_settings.findFirst.mockResolvedValue({
      value: value({ offered: [" 262-100 ", "A 1"] }),
    });
    const inventory = await loadCourseInventory({ now: NOW });
    expect([...inventory.offered]).toEqual(["262-100", "a 1"]);
    expect(inventory.stand).toBe("2026-10-24T08:00:00.000Z");
    expect(inventory.workspace).toBe("ws");
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

// Zeilen der Tabelle: die Abschnitte der Dokumente mit title und published
// ihres Uploads
const PUBLISHED = "24.10.2026, 08:00:00";
const DOC_ROWS = Object.entries(VECTORS).flatMap(([docId, ids]) =>
  ids.map((id) => ({ id, title: `${docId}.txt`, published: PUBLISHED }))
);

// present: nur diese Abschnitte stehen in der Tabelle (null: nicht
// prüfbar), orphans: verwaiste Zeilen der Tabelle {id, text, title,
// published}, texts: Text weiterer Abschnitte
function installDeps({
  present = undefined,
  reads = [],
  orphans = [],
  texts = [],
} = {}) {
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
    tableRows: jest.fn(async () =>
      present === null
        ? null
        : [
            ...DOC_ROWS.filter(
              (row) => present === undefined || present.has(row.id)
            ),
            ...orphans.map(({ id, title, published }) => ({
              id,
              title,
              published,
            })),
          ]
    ),
    rowTexts: jest.fn(async (_slug, ids) =>
      [...texts, ...orphans]
        .filter((row) => ids.includes(row.id))
        .map(({ id, text }) => ({ id, text }))
    ),
  };
  t.setDeps(deps);
  return deps;
}

describe("Index je Workspace (AK-K4, AK-K9)", () => {
  beforeEach(() => {
    prisma.system_settings.findFirst.mockResolvedValue({ value: value() });
  });

  test("count = |A ∩ B|, offered = |A|, hidden = |B \\ A| (D-K5)", async () => {
    installDeps();
    const status = await courseInventoryStatus({ slug: "ws" });
    // A = 100..103, B (eingelernt) = 100, 101, 102, 900, 901 (103 ohne
    // document_vectors), Dokumente ohne Kursnummer zählen nie; ausgeblendet
    // die Dokumente zu 900 und 901
    expect(status).toEqual({
      count: 3,
      offered: 4,
      hidden: 2,
      stand: "2026-10-24T08:00:00.000Z",
    });
    // Fixliste r2 Nr. 8 (F-C4): der Index führt den Wert nur als inventory
    const index = await t.workspaceInventory("ws");
    expect(index.inventory.stand).toBe("2026-10-24T08:00:00.000Z");
    expect(index).not.toHaveProperty("raw");
    expect(index).not.toHaveProperty("stand");
  });

  test("AK-K9: ohne Zeilen im Vektorspeicher zählt ein Dokument nicht als eingelernt", async () => {
    installDeps({ present: new Set(["v100b", "v900a", "vs"]) });
    const status = await courseInventoryStatus({ slug: "ws" });
    // hidden wie count (r3-S4): nur eingelernte veraltete Kursnummern (900;
    // 901 hat keine Zeile im Vektorspeicher)
    expect(status).toMatchObject({ count: 1, offered: 4, hidden: 1 });
    // ausgeschlossen werden trotzdem alle veralteten Abschnitte
    const exclusion = await courseSearchExclusion("ws");
    expect(exclusion.clauses[0]).toBe("id NOT IN ('v900a','v900b','v901')");
  });

  test("r3-S4: hidden zählt verschiedene Kursnummern, ohne Dokumente ohne document_vectors", async () => {
    const deps = installDeps();
    // zweites Dokument zu 262-900 (eingelernt) und eines zu 262-902 ohne
    // document_vectors
    const extra = {
      "custom-documents/k900b.json": courseText("262-900", "Alter Kurs"),
      "custom-documents/k902.json": courseText("262-902", "Ohne Suchdaten"),
    };
    const vectors = { ...VECTORS, k900b: ["v900c"] };
    deps.listDocuments.mockImplementation(async () =>
      [...Object.keys(DOCS), ...Object.keys(extra)].map((docpath) => ({
        docId: path.basename(docpath, ".json"),
        docpath,
      }))
    );
    deps.readDocumentText.mockImplementation(
      async (docpath) => DOCS[docpath] ?? extra[docpath] ?? null
    );
    deps.listVectors.mockImplementation(async (docIds) =>
      docIds.flatMap((docId) =>
        (vectors[docId] || []).map((vectorId) => ({ docId, vectorId }))
      )
    );
    deps.tableRows.mockImplementation(async () => [
      ...DOC_ROWS,
      { id: "v900c", title: "k900b.txt", published: PUBLISHED },
    ]);
    expect(await courseInventoryStatus({ slug: "ws" })).toMatchObject({
      count: 3,
      hidden: 2,
    });
    // ausgeschlossen werden weiter alle Abschnitte veralteter Dokumente
    expect((await courseSearchExclusion("ws")).clauses[0]).toBe(
      "id NOT IN ('v900a','v900b','v900c','v901')"
    );
  });

  test("AK-K9: Vektorspeicher nicht prüfbar (null): es zählt document_vectors", async () => {
    installDeps({ present: null });
    expect(await courseInventoryStatus({ slug: "ws" })).toMatchObject({
      count: 3,
      hidden: 2,
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

  test("S4, r3-S3 a: Vektorspeicher nicht lesbar: Index gilt, wird aber nur 2 min gemerkt", async () => {
    const error = jest.spyOn(console, "error").mockImplementation(() => {});
    const deps = installDeps();
    deps.tableRows.mockRejectedValueOnce(new Error("busy"));
    // ohne Tabelle zählt document_vectors, der Ausschluss der bekannten
    // veralteten Abschnitte gilt trotzdem
    expect(await courseInventoryStatus({ slug: "ws" })).toMatchObject({
      count: 3,
      offered: 4,
    });
    expect(error).toHaveBeenCalledWith(
      "[courseInventory] Suchdaten nicht prüfbar: busy"
    );
    expect((await courseSearchExclusion("ws")).clauses[0]).toBe(
      "id NOT IN ('v900a','v900b','v901')"
    );
    // innerhalb von 2 min gemerkt, danach neu gebaut; der vollständige
    // Index gilt wieder 1 h
    expect(deps.listDocuments).toHaveBeenCalledTimes(1);
    clock.now += t.INCOMPLETE_INDEX_MAX_AGE_MS - 1;
    await courseInventoryStatus({ slug: "ws" });
    expect(deps.listDocuments).toHaveBeenCalledTimes(1);
    clock.now += 1;
    expect(await courseInventoryStatus({ slug: "ws" })).toMatchObject({
      count: 3,
    });
    expect(deps.listDocuments).toHaveBeenCalledTimes(2);
    clock.now += t.INCOMPLETE_INDEX_MAX_AGE_MS;
    await courseInventoryStatus({ slug: "ws" });
    expect(deps.listDocuments).toHaveBeenCalledTimes(2);
    error.mockRestore();
  });

  test("G: Tabelle je Aufbau einmal gelesen, auch mit verwaisten und unlesbaren Abschnitten", async () => {
    const deps = installDeps({
      orphans: [{ id: "o1", text: chunk(courseText("262-777")) }],
    });
    await courseInventoryStatus({ slug: "ws" });
    await courseSearchExclusion("ws");
    await courseInventoryGuard({ slug: "ws" });
    expect(deps.tableRows).toHaveBeenCalledTimes(1);
    expect(deps.rowTexts).toHaveBeenCalledTimes(1);
    expect(deps.rowTexts).toHaveBeenCalledWith("ws", ["o1"]);
  });

  // Fixliste r4 Nr. 4 (NF5): ein gescheiterter Aufbau wird nicht gemerkt,
  // der nächste Aufruf versucht es neu; je Fehlschlag eine Logzeile
  test("Fehler beim Aufbau: null, nicht gemerkt, der nächste Aufruf baut neu", async () => {
    const error = jest.spyOn(console, "error").mockImplementation(() => {});
    const deps = installDeps();
    deps.listDocuments.mockRejectedValueOnce(new Error("busy"));
    expect(await courseInventoryStatus({ slug: "ws" })).toBeNull();
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(
      "[courseInventory] Index nicht gebaut: busy"
    );
    expect(await courseInventoryStatus({ slug: "ws" })).toMatchObject({
      count: 3,
    });
    expect(deps.listDocuments).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledTimes(1);
    // der neue Index gilt wieder 1 h
    await courseInventoryStatus({ slug: "ws" });
    expect(deps.listDocuments).toHaveBeenCalledTimes(2);
    console.error.mockRestore();
  });

  // Fixliste r5: die Kursliste gilt nur im Workspace aus workspace; ein
  // anderer Workspace (Dokubot, zweites Kursprogramm) ist nicht eingerichtet
  test("r5: anderer Workspace als der der Kursliste: keine Zahl, nichts ausgeblendet, nichts gelesen", async () => {
    const deps = installDeps();
    prisma.system_settings.findFirst.mockResolvedValue({
      value: value({ workspace: "kurse" }),
    });
    expect(await courseInventoryStatus({ slug: "ws" })).toBeNull();
    expect(await courseSearchExclusion("ws")).toBeNull();
    expect(await courseInventoryGuard({ slug: "ws" })).toBeNull();
    expect(
      await courseCountField({ slug: "ws" }, { mode: "on", word: "Kurse" })
    ).toBeNull();
    for (const fn of Object.values(deps)) expect(fn).not.toHaveBeenCalled();
  });

  // Fixliste r5 (ersetzt NAK-K2 alt, E-KB3-4): im Workspace der Kursliste
  // wird auch ohne einen einzigen angebotenen Kurs bewertet, alle
  // Kursdokumente sind dann veraltet
  test("r5: Workspace der Kursliste ohne angebotenen Kurs: count 0, alle Kursdokumente ausgeblendet", async () => {
    installDeps();
    prisma.system_settings.findFirst.mockResolvedValue({
      value: value({ offered: ["999-1", "999-2"] }),
    });
    expect(await courseInventoryStatus({ slug: "ws" })).toEqual({
      count: 0,
      offered: 2,
      hidden: 5,
      stand: "2026-10-24T08:00:00.000Z",
    });
    expect((await courseSearchExclusion("ws")).clauses[0]).toBe(
      "id NOT IN ('v100a','v100b','v101','v102','v102b','v900a','v900b','v901')"
    );
    const guard = await courseInventoryGuard({ slug: "ws" });
    expect(guard.hidesDocument({ pageContent: courseText("262-100") })).toBe(
      true
    );
    expect(
      await courseCountField({ slug: "ws" }, { mode: "on", word: "Kurse" })
    ).toBeNull();
  });

  test("NAK-K1: ohne gültigen Wert weder Zahl noch Ausschluss, kein Dokument gelesen", async () => {
    const deps = installDeps();
    prisma.system_settings.findFirst.mockResolvedValue(null);
    expect(await courseInventoryStatus({ slug: "ws" })).toBeNull();
    expect(await courseSearchExclusion("ws")).toBeNull();
    expect(await courseInventoryGuard({ slug: "ws" })).toBeNull();
    expect(deps.listDocuments).not.toHaveBeenCalled();
  });

  test.each([
    ["kein Wert", null],
    ["älter als 24 h", { value: value({ created: "2026-10-23T09:00:00Z" }) }],
  ])(
    "G, NAK-K1 (%s): je Aufruf nur das Lesen der Zeile, geparst einmal je Wert, sonst nichts",
    async (_name, row) => {
      const deps = installDeps();
      prisma.system_settings.findFirst.mockResolvedValue(row);
      const parse = jest.spyOn(JSON, "parse");
      for (let i = 0; i < 3; i++) {
        expect(await courseSearchExclusion("ws")).toBeNull();
        expect(await courseInventoryGuard({ slug: "ws" })).toBeNull();
      }
      expect(prisma.system_settings.findFirst).toHaveBeenCalledTimes(6);
      expect(parse).toHaveBeenCalledTimes(row ? 1 : 0);
      parse.mockRestore();
      for (const fn of Object.values(deps)) expect(fn).not.toHaveBeenCalled();
    }
  );

  test("Workspace der Kursliste gibt es nicht: null", async () => {
    const deps = installDeps();
    prisma.system_settings.findFirst.mockResolvedValue({
      value: value({ workspace: "weg" }),
    });
    expect(await courseInventoryStatus({ slug: "weg" })).toBeNull();
    expect(deps.findWorkspaceId).toHaveBeenCalledWith("weg");
    expect(deps.listDocuments).not.toHaveBeenCalled();
    expect(await courseInventoryStatus(null)).toBeNull();
  });
});

describe("Ausschluss und Prüfer (E35, NAK-K2)", () => {
  beforeEach(() => {
    prisma.system_settings.findFirst.mockResolvedValue({ value: value() });
    installDeps();
  });

  test("Filterbedingung nur mit den Abschnitten veralteter Kursdokumente, kein Nachfilter", async () => {
    const exclusion = await courseSearchExclusion("ws");
    expect(exclusion.clauses).toEqual([
      "id NOT IN ('v900a','v900b','v901')",
      "(id NOT IN ('v900a','v900b','v901'))",
    ]);
    expect(exclusion).toMatchObject({
      staleDocs: 2,
      excludedIds: 3,
      headBlockIds: 0,
      stats: { failClosed: 0 },
    });
    // KR-1: kein Prüfer für Treffer nach der Suche, kein Rückfall
    expect(exclusion).not.toHaveProperty("hides");
    expect(exclusion).not.toHaveProperty("extra");
    expect(exclusion).not.toHaveProperty("where");
  });

  test("KR-1: über 5.000 Abschnitte stehen alle in der Bedingung, zweite Form in Blöcken per AND", async () => {
    const many = Array.from({ length: 12345 }, (_, i) => `id-${i}`);
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
    expect(exclusion.excludedIds).toBe(12346);
    const [one, blocks] = exclusion.clauses;
    const listed = (clause) =>
      clause.match(/'[^']*'/g).map((q) => q.slice(1, -1));
    expect(one.startsWith("id NOT IN (")).toBe(true);
    expect(new Set(listed(one))).toEqual(new Set([...many, "v901"]));
    const parts = blocks.split(" AND ");
    expect(parts).toHaveLength(Math.ceil(12346 / t.EXCLUSION_BLOCK));
    for (const part of parts)
      expect(part).toMatch(/^\(id NOT IN \('[^)]*\)\)$/);
    expect(new Set(listed(blocks))).toEqual(new Set([...many, "v901"]));
  });

  test("KR-1: kein veralteter Abschnitt -> kein Ausschluss (Suche wie vorher)", async () => {
    prisma.system_settings.findFirst.mockResolvedValue({
      value: value({
        offered: ["262-100", "262-101", "262-102", "262-900", "262-901"],
      }),
    });
    expect(await courseSearchExclusion("ws")).toBeNull();
  });

  test("KR-1: verwaiste Abschnitte mit veraltetem Kopfblock stehen in der Bedingung, samt ihrem Upload", async () => {
    const deps = installDeps({
      orphans: [
        // veralteter Kurs, Dokument dem Workspace unbekannt
        {
          id: "o1",
          text: chunk(courseText("262-777")),
          title: "alt.txt",
          published: "1.1.2026, 10:00:00",
        },
        // Folgeabschnitt desselben Uploads (ohne Kursnummer)
        {
          id: "o1b",
          text: "Folgeabschnitt",
          title: "alt.txt",
          published: "1.1.2026, 10:00:00",
        },
        // anderer Upload mit gleichem Titel, ohne Kursnummer: bleibt
        {
          id: "o2",
          text: "Folgeabschnitt",
          title: "alt.txt",
          published: "2.1.2026, 10:00:00",
        },
        // verwaist, aber angeboten: bleibt
        { id: "o3", text: chunk(courseText("262-100")), title: "k.txt" },
        // verwaist, ohne Kursnummer: bleibt
        { id: "o4", text: "Titel: FAQ\nText" },
      ],
    });
    const exclusion = await courseSearchExclusion("ws");
    expect(exclusion.clauses[0]).toBe(
      "id NOT IN ('o1','o1b','v900a','v900b','v901')"
    );
    expect(exclusion.headBlockIds).toBe(2);
    // bekannt sind die Abschnitte aller Dokumente, nicht nur der Kurse:
    // gelesen werden nur die Texte der verwaisten
    expect(deps.rowTexts).toHaveBeenCalledWith("ws", [
      "o1",
      "o1b",
      "o2",
      "o3",
      "o4",
    ]);
    // die Prüfer der Chatpfade kennen sie ebenso
    const guard = await courseInventoryGuard({ slug: "ws" });
    expect(guard.hidesSource({ id: "o1b", text: "Folgeabschnitt" })).toBe(true);
    expect(guard.hidesSource({ id: "o2", text: "Folgeabschnitt" })).toBe(false);
  });

  test("KR-1: Dokument mit unlesbarer Datei: Kopfblock aus dem Vektorspeicher, alle seine Abschnitte ausgeschlossen, Datei nicht gemerkt", async () => {
    const deps = installDeps({
      texts: [
        { id: "v100a", text: chunk(courseText("262-555")) },
        { id: "v100b", text: "Folgeabschnitt" },
      ],
    });
    deps.readDocumentText.mockImplementation(async (docpath) => {
      if (docpath.endsWith("k100.json")) throw new Error("ENOENT");
      return DOCS[docpath] ?? null;
    });
    const exclusion = await courseSearchExclusion("ws");
    expect(exclusion.clauses[0]).toBe(
      "id NOT IN ('v100a','v100b','v900a','v900b','v901')"
    );
    expect(deps.rowTexts).toHaveBeenCalledWith("ws", ["v100a", "v100b"]);
    // nach einer Stunde wird die Datei erneut gelesen
    clock.now += t.INDEX_MAX_AGE_MS;
    deps.readDocumentText.mockClear();
    await courseSearchExclusion("ws");
    expect(deps.readDocumentText).toHaveBeenCalledTimes(1);
    expect(deps.readDocumentText).toHaveBeenCalledWith(
      "custom-documents/k100.json"
    );
  });

  test("KR-1, S4: Prüfung der verwaisten Abschnitte scheitert: geloggt, Ausschluss der bekannten bleibt, Index nur 2 min gemerkt", async () => {
    const error = jest.spyOn(console, "error").mockImplementation(() => {});
    const deps = installDeps({
      orphans: [{ id: "o1", text: chunk(courseText("262-777")) }],
    });
    deps.rowTexts.mockRejectedValueOnce(new Error("busy"));
    const exclusion = await courseSearchExclusion("ws");
    expect(exclusion.clauses[0]).toBe("id NOT IN ('v900a','v900b','v901')");
    expect(error).toHaveBeenCalledWith(
      "[courseInventory] Abschnitte ohne lesbares Dokument nicht prüfbar: busy"
    );
    // nach 2 min baut der nächste Aufruf neu und findet den verwaisten
    // Abschnitt
    clock.now += t.INCOMPLETE_INDEX_MAX_AGE_MS;
    expect((await courseSearchExclusion("ws")).clauses[0]).toBe(
      "id NOT IN ('o1','v900a','v900b','v901')"
    );
    expect(deps.listDocuments).toHaveBeenCalledTimes(2);
    error.mockRestore();
  });

  test("Vektor-IDs mit fremden Zeichen kommen nie in die Bedingung, dann fail-closed", async () => {
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
    expect(exclusion.clauses).toEqual([]);
    expect(exclusion.excludedIds).toBe(2);
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

describe("I (S6): gespeicherte Quellen ohne Kopfblock", () => {
  beforeEach(() => {
    prisma.system_settings.findFirst.mockResolvedValue({ value: value() });
  });
  const source = (id, title, published = PUBLISHED) => ({
    id,
    text: "Folgeabschnitt ohne Kopfzeile",
    title,
    published,
  });

  test("über title und published dem Upload zugeordnet: nur ein eindeutig veralteter Upload blendet aus", async () => {
    installDeps({
      orphans: [
        // verwaister Abschnitt ohne Kursnummer mit gleichem title und
        // published wie k901 (veraltet)
        { id: "o5", text: "Text", title: "k901.txt", published: PUBLISHED },
      ],
    });
    const guard = await courseInventoryGuard({ slug: "ws" });
    // ID nicht mehr in der Tabelle (neu eingebettet), Upload veraltet
    expect(guard.hidesSource(source("weg-1", "k900.txt"))).toBe(true);
    // angebotener Upload, auch mit unbekannter ID
    expect(guard.hidesSource(source("weg-3", "k100.txt"))).toBe(false);
    // ohne bekanntes Dokument: bleibt wie heute
    expect(guard.hidesSource(source("weg-4", "gibtsnicht.txt"))).toBe(false);
    expect(guard.hidesSource(source("weg-5", "k900.txt", "1.1.2020"))).toBe(
      false
    );
    expect(guard.hidesSource({ id: "weg-6", text: "ohne title" })).toBe(false);
    // Upload ohne Kursnummer (FAQ) bleibt
    expect(guard.hidesSource(source("weg-7", "faq.txt"))).toBe(false);
    // nicht eindeutig (unter gleichem Upload auch ein Abschnitt, der nicht
    // ausgeschlossen ist): bleibt
    expect(guard.hidesSource(source("weg-8", "k901.txt"))).toBe(false);
  });

  test("Vektorspeicher nicht prüfbar: Quellen ohne Kopfblock bleiben wie heute", async () => {
    installDeps({ present: null });
    const guard = await courseInventoryGuard({ slug: "ws" });
    expect(guard.hidesSource(source("weg-1", "k900.txt"))).toBe(false);
    expect(guard.hidesSource({ id: "v900b", text: "Folgeabschnitt" })).toBe(
      true
    );
  });
});

describe("courseCount für /config (Vertrag)", () => {
  beforeEach(() => {
    prisma.system_settings.findFirst.mockResolvedValue({ value: value() });
    installDeps();
  });

  // Fixliste r4 Nr. 2: öffentlich nur count und word; offered, hidden und
  // stand berechnet courseInventoryStatus weiter intern (Betreiber-Info)
  test("Anzeige an: nur count und word, die übrigen Zahlen bleiben intern", async () => {
    expect(
      await courseCountField({ slug: "ws" }, { mode: "on", word: "Kurse" })
    ).toEqual({ count: 3, word: "Kurse" });
    expect(await courseInventoryStatus({ slug: "ws" })).toEqual({
      count: 3,
      offered: 4,
      hidden: 2,
      stand: "2026-10-24T08:00:00.000Z",
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

describe("Version 2 mit Titeln und Laufmeldung (KB-4, AK-4)", () => {
  const CONTRACT = require("./fixtures/courseInventoryContract.json");
  // im Workspace „ws“ der Tests
  const v2 = (overrides = {}) =>
    JSON.stringify({
      ...JSON.parse(CONTRACT.v2),
      workspace: "ws",
      ...overrides,
    });
  afterEach(() => console.error.mockRestore?.());

  test("Vertrags-Fixture (r5): Version 2 mit workspace gilt, Version 1 und Version 2 ohne gültigen workspace nicht", async () => {
    for (const raw of [CONTRACT.v2, CONTRACT.v2Laufmeldung])
      expect(validateCourseInventorySetting(raw, { now: NOW })).toBe(raw);
    expect(Object.keys(CONTRACT.abgelehnt)).toEqual(
      expect.arrayContaining(["v1", "v2OhneWorkspace"])
    );
    jest.spyOn(console, "error").mockImplementation(() => {});
    for (const raw of Object.values(CONTRACT.abgelehnt)) {
      expect(() => validateCourseInventorySetting(raw, { now: NOW })).toThrow(
        LABEL
      );
      // auch ein vorhandener alter Wert wird nicht gelesen
      prisma.system_settings.findFirst.mockResolvedValue({ value: raw });
      expect(await courseInventoryRecord()).toBeNull();
    }
    console.error.mockRestore();
    prisma.system_settings.findFirst.mockResolvedValue({ value: CONTRACT.v2 });
    const record = await courseInventoryRecord();
    expect(record).toMatchObject({
      workspace: "vhs-beispiel",
      stand: "2026-10-24T08:00:00.000Z",
      estimatedEnd: true,
      run: { at: "2026-10-24T08:00:00.000Z", result: "ok", cause: null },
    });
    expect([...record.offered]).toEqual(["262-100", "262-101"]);
    expect(Object.fromEntries(record.titles)).toEqual({
      "262-100": "Yoga am Morgen",
      "262-101": "Englisch für Anfänger",
    });
    expect(await loadCourseInventory({ now: NOW })).toBe(record);
  });

  test.each([
    ["offered leer", { offered: [] }],
    ["offered nur ungültig", { offered: ["  ", 7] }],
    ["client fehlt", { client: "" }],
    ["created kein Zeitpunkt", { created: "gestern" }],
    [
      "älter als 24 h ohne Laufmeldung",
      { created: "2026-10-23T09:00:00Z", run: null },
    ],
    [
      "Laufmeldung älter als 24 h",
      {
        created: "2026-10-23T08:00:00Z",
        run: { at: "2026-10-23T09:00:00Z", result: "ok", cause: null },
      },
    ],
    [
      "Laufmeldung mehr als 1 h in der Zukunft",
      { run: { at: "2026-10-24T11:30:00Z", result: "ok", cause: null } },
    ],
  ])("Prüfungen: %s abgelehnt", (_name, overrides) => {
    expect(() =>
      validateCourseInventorySetting(v2(overrides), { now: NOW })
    ).toThrow(LABEL);
  });

  test("ungültige Titel werden übersprungen, 200 Zeichen gelten", async () => {
    jest.spyOn(console, "error").mockImplementation(() => {});
    const raw = v2({
      offered: ["262-100", "262-101", "262-102", "262-103", "262-104", "A 1"],
      titles: {
        " 262-100 ": "x".repeat(200),
        "262-101": "x".repeat(201),
        "262-102": "",
        "262-103": "Kurs\u0007",
        "262-104": 42,
        "262-999": "nicht angeboten",
        "a 1": "Vergleichsform",
        ["__proto__"]: "kein Kurs",
      },
    });
    expect(validateCourseInventorySetting(raw, { now: NOW })).toBe(raw);
    prisma.system_settings.findFirst.mockResolvedValue({ value: raw });
    const { titles } = await courseInventoryRecord();
    expect(Object.fromEntries(titles)).toEqual({
      "262-100": "x".repeat(200),
      "a 1": "Vergleichsform",
    });
    expect(t.TITLE_MAX_LEN).toBe(200);
  });

  test.each([
    [
      "result unbekannt",
      { at: "2026-10-24T08:00:00Z", result: "gut", cause: null },
    ],
    [
      "cause unbekannt",
      { at: "2026-10-24T08:00:00Z", result: "fehler", cause: "x" },
    ],
    ["cause fehlt", { at: "2026-10-24T08:00:00Z", result: "ok" }],
    ["at kein Zeitpunkt", { at: "gestern", result: "ok", cause: null }],
    ["keine Form", ["ok"]],
  ])(
    "ungültiges run (%s) wird verworfen, der Wert gilt",
    async (_name, run) => {
      const raw = v2({ run, estimatedEnd: "ja" });
      expect(validateCourseInventorySetting(raw, { now: NOW })).toBe(raw);
      prisma.system_settings.findFirst.mockResolvedValue({ value: raw });
      const record = await courseInventoryRecord();
      expect(record.run).toBeNull();
      expect(record.estimatedEnd).toBe(false);
      expect(record.offered.size).toBe(2);
    }
  );

  test("D-KB4-2: Laufmeldung mit altem created wird angenommen, die 24-h-Regel hängt an created", async () => {
    const result = await SystemSettings._updateSettings({
      [LABEL]: CONTRACT.v2Laufmeldung,
    });
    expect(result).toEqual({ success: true, error: null });
    // dieselbe Laufmeldung im Workspace „ws“ der Tests
    const raw = JSON.stringify({
      ...JSON.parse(CONTRACT.v2Laufmeldung),
      workspace: "ws",
    });
    expect(validateCourseInventorySetting(raw, { now: NOW })).toBe(raw);
    prisma.system_settings.findFirst.mockResolvedValue({ value: raw });
    // kein Ausblenden, keine Zahl (created 26 h alt), Laufmeldung intern lesbar
    expect(await loadCourseInventory({ now: NOW })).toBeNull();
    installDeps();
    expect(await courseInventoryStatus({ slug: "ws" })).toBeNull();
    expect((await courseInventoryRecord()).run).toEqual({
      at: "2026-10-24T09:00:00.000Z",
      atMs: Date.parse("2026-10-24T09:00:00Z"),
      result: "nicht_geschrieben",
      cause: "feed_nicht_erreichbar",
    });
  });

  test("Titel kommen nie in Zahl, Status oder /config-Feld", async () => {
    const secret = "Geheimer Titel nur intern";
    prisma.system_settings.findFirst.mockResolvedValue({
      value: v2({
        offered: ["262-100", "262-101", "262-102", "262-103"],
        titles: { "262-100": secret, "262-103": secret },
      }),
    });
    installDeps();
    const status = await courseInventoryStatus({ slug: "ws" });
    expect(status).toEqual({
      count: 3,
      offered: 4,
      hidden: 2,
      stand: "2026-10-24T08:00:00.000Z",
    });
    const field = await courseCountField(
      { slug: "ws" },
      { mode: "on", word: "Kurse" }
    );
    expect(field).toEqual({ count: 3, word: "Kurse" });
    const index = await t.workspaceInventory("ws");
    expect(Object.keys(index)).not.toContain("titles");
    expect(JSON.stringify([status, field])).not.toContain(secret);
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
