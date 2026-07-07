/**
 * Manual integration test for KIE-480 P2 — hard-constraint metadata filters
 * (.where() prefilter) across the LanceDB retrieval paths.
 *
 * Covers (Testkriterien-Matrix KIE-480):
 *   TR1  filter applies to BOTH hybrid arms (vector + FTS) before fusion
 *   TR2  empty/invalid filters -> byte-identical to today's behavior
 *   TE10 injection/unknown values are sanitized away (never reach SQL)
 *   Legacy tables without metadata columns -> graceful UNFILTERED fallback
 *   default mode (similarityResponse) honors the filter too
 *   plus unit checks of sanitizeSearchFilters/filtersToWhere
 *
 * Framework-free on purpose (jest ignores *.manual.js): run with
 *   node __tests__/utils/vectorDbProviders/lanceSearchFilters.manual.js
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.STORAGE_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), "lance-filters-")
);

const { LanceDb } = require("../../../utils/vectorDbProviders/lance");
const {
  sanitizeSearchFilters,
  filtersToWhere,
} = require("../../../utils/vectorDbProviders/lance/searchFilters");

const ok = (msg) => console.log(`\x1b[32m  ✓\x1b[0m ${msg}`);

// Vier Kurse mit vollem Metadaten-Schema. Vektoren so gewählt, dass die
// reine Vektorsuche für [1,0,0,0] die teuren Kurse bevorzugt — der
// Preisfilter muss sie trotzdem verlässlich aussortieren.
const ROWS = [
  {
    id: "teuer-abend",
    text: "Yogakurs Y100 am Abend in Lingen",
    vector: [1, 0, 0, 0],
    start_date: "2026-09-01",
    start_minutes: 18 * 60,
    weekdays: ",mon,wed,",
    price: 120.0,
    bookable: true,
    format: "onsite",
    location: "lingen",
  },
  {
    id: "guenstig-abend",
    text: "Yogakurs Y200 am Abend in Lingen",
    vector: [0.9, 0.1, 0, 0],
    start_date: "2026-10-15",
    start_minutes: 19 * 60,
    weekdays: ",tue,",
    price: 39.0,
    bookable: true,
    format: "onsite",
    location: "lingen",
  },
  {
    id: "guenstig-morgen",
    text: "Yogakurs Y300 am Vormittag in Meppen",
    vector: [0.8, 0.2, 0, 0],
    start_date: "2026-09-20",
    start_minutes: 9 * 60,
    weekdays: ",sat,",
    price: 25.0,
    bookable: false,
    format: "online",
    location: "meppen",
  },
  {
    id: "knr-treffer",
    text: "Spezialkurs KNR-77441 guenstig am Abend",
    vector: [0, 0, 0, 1], // vektor-fern: nur über BM25/FTS erreichbar
    start_date: "2026-11-05",
    start_minutes: 20 * 60,
    weekdays: ",thu,",
    price: 150.0,
    bookable: true,
    format: "onsite",
    location: "lingen",
  },
];

async function run() {
  // ---- Unit: sanitize + SQL-Bau -------------------------------------------
  assert.strictEqual(sanitizeSearchFilters(null), null);
  assert.strictEqual(sanitizeSearchFilters({}), null);
  assert.strictEqual(
    sanitizeSearchFilters({ dateFrom: "bald", priceMax: "teuer" }),
    null,
    "invalid-only input sanitizes to null"
  );
  const sane = sanitizeSearchFilters({
    dateFrom: "2026-09-01",
    priceMax: 50,
    weekdays: ["tue", "quatschtag"],
    location: ["Lingen ", "böse'; DROP TABLE x;--"],
    excludeIds: ["abc-123", "…klammer('injektion')"],
    timeOfDay: ["evening"],
    format: ["online", "hologramm"],
  });
  assert.deepStrictEqual(sane.weekdays, ["tue"]);
  assert.deepStrictEqual(sane.location, ["lingen"], "injection value dropped");
  assert.deepStrictEqual(sane.excludeIds, ["abc-123"]);
  assert.deepStrictEqual(sane.format, ["online"]);
  const where = filtersToWhere(sane);
  assert.ok(where.includes("start_date >= '2026-09-01'"), where);
  assert.ok(where.includes("price <= 50"), where);
  assert.ok(where.includes("weekdays LIKE '%,tue,%'"), where);
  assert.ok(where.includes("location IN ('lingen')"), where);
  assert.ok(where.includes("start_minutes >= 1020"), where);
  assert.ok(!where.includes("DROP TABLE"), "no injection in SQL");
  // Quote-Escaping: validiertes ' im Wert wird verdoppelt
  assert.ok(
    filtersToWhere({ location: ["st. o'hara"] }).includes("'st. o''hara'"),
    "single quotes escaped"
  );
  ok("Unit: sanitize + filtersToWhere (Whitelist, Escaping, Injection-Drop)");

  // ---- Setup: Tabelle MIT Metadaten-Spalten --------------------------------
  const lance = new LanceDb();
  const { client } = await lance.connect();
  const ns = "filters_probe";
  await client.dropTable(ns).catch(() => {});
  const collection = await client.createTable(ns, ROWS);
  await lance.ensureFullTextIndex(collection);

  const hybrid = (filtersRaw) =>
    lance.hybridSimilarityResponse({
      client,
      namespace: ns,
      query: "Yogakurs KNR-77441 Abend",
      queryVector: [1, 0, 0, 0],
      topN: 4,
      similarityThreshold: 0,
      filterIdentifiers: [],
      whereClause: filtersToWhere(sanitizeSearchFilters(filtersRaw)),
    });

  // ---- TR2: leere/ungültige Filter = identisches Verhalten -----------------
  const unfiltered = await hybrid(null);
  const emptyFiltered = await hybrid({});
  const invalidFiltered = await hybrid({ priceMax: "teuer", weekdays: [42] });
  assert.deepStrictEqual(emptyFiltered, unfiltered, "empty == unfiltered");
  assert.deepStrictEqual(invalidFiltered, unfiltered, "invalid == unfiltered");
  assert.ok(
    unfiltered.sourceDocuments.some((d) => d.id === "knr-treffer"),
    "FTS arm surfaces the vector-distant KNR course when unfiltered"
  );
  ok("TR2: leere/ungültige Filter -> byte-identisch zu heute");

  // ---- TR1: Preisfilter wirkt auf BEIDE Arme -------------------------------
  const cheap = await hybrid({ priceMax: 50 });
  const cheapIds = cheap.sourceDocuments.map((d) => d.id).sort();
  assert.deepStrictEqual(
    cheapIds,
    ["guenstig-abend", "guenstig-morgen"],
    `nur günstige Kurse, beide Arme gefiltert — got ${cheapIds}`
  );
  // Gegenprobe: der teure KNR-Kurs käme NUR über den FTS-Arm — sein Fehlen
  // beweist, dass auch der FTS-Arm den Preisfilter trägt.
  assert.ok(!cheapIds.includes("knr-treffer"), "FTS arm filtered too");
  ok("TR1: Preisfilter wirkt auf Vektor- UND FTS-Arm vor der Fusion");

  // ---- Kombination: Zeitbucket + Datum + Buchbarkeit -----------------------
  const eveningAutumn = await hybrid({
    timeOfDay: ["evening"],
    dateFrom: "2026-10-01",
    dateTo: "2026-12-31",
    bookable: true,
  });
  const eveIds = eveningAutumn.sourceDocuments.map((d) => d.id).sort();
  assert.deepStrictEqual(
    eveIds,
    ["guenstig-abend", "knr-treffer"],
    `Abend + Q4 + buchbar — got ${eveIds}`
  );
  ok("Kombi-Filter: Datum-Range + Tageszeit + bookable");

  // ---- excludeIds (Follow-up „noch mehr davon") ----------------------------
  const more = await hybrid({ excludeIds: ["teuer-abend", "guenstig-abend"] });
  const moreIds = more.sourceDocuments.map((d) => d.id);
  assert.ok(
    !moreIds.includes("teuer-abend") && !moreIds.includes("guenstig-abend"),
    `excluded ids absent — got ${moreIds}`
  );
  assert.ok(moreIds.length > 0, "other courses still returned");
  ok("excludeIds: bereits zitierte Kurse werden ausgeschlossen");

  // ---- default-Modus (similarityResponse) trägt den Filter -----------------
  const plain = await lance.similarityResponse({
    client,
    namespace: ns,
    queryVector: [1, 0, 0, 0],
    topN: 4,
    similarityThreshold: 0,
    filterIdentifiers: [],
    whereClause: filtersToWhere(sanitizeSearchFilters({ priceMax: 50 })),
  });
  const plainIds = plain.sourceDocuments.map((d) => d.id).sort();
  assert.deepStrictEqual(plainIds, ["guenstig-abend", "guenstig-morgen"]);
  ok("default-Modus: similarityResponse respektiert den Filter");

  // ---- Legacy-Tabelle OHNE Metadaten-Spalten -> unfiltered fallback --------
  const legacyNs = "filters_probe_legacy";
  await client.dropTable(legacyNs).catch(() => {});
  const legacy = await client.createTable(
    legacyNs,
    ROWS.map(({ id, text, vector }) => ({ id, text, vector }))
  );
  await lance.ensureFullTextIndex(legacy);
  const legacyResult = await lance.hybridSimilarityResponse({
    client,
    namespace: legacyNs,
    query: "Yogakurs Abend",
    queryVector: [1, 0, 0, 0],
    topN: 4,
    similarityThreshold: 0,
    filterIdentifiers: [],
    whereClause: filtersToWhere(sanitizeSearchFilters({ priceMax: 50 })),
  });
  assert.ok(
    legacyResult.sourceDocuments.length > 0,
    "legacy table falls back to UNFILTERED results (never empty)"
  );
  ok("Legacy-Tabelle ohne Spalten: Fallback auf ungefilterte Suche");

  // ---- Auto-Migration (KIE-480 "Weg 2"): Alt-Tabelle bekommt Spalten ------
  const migNs = "filters_probe_migration";
  await client.dropTable(migNs).catch(() => {});
  // 1) Bestands-Workspace: Zeilen OHNE Metadaten-Spalten
  await client.createTable(
    migNs,
    ROWS.slice(0, 2).map(({ id, text, vector }) => ({
      id: `alt-${id}`,
      text,
      vector,
    }))
  );
  // 2) Update-Zyklus liefert jetzt Kurs-Metadaten -> addColumns + add
  await lance.updateOrCreateCollection(client, ROWS.slice(1), migNs);
  const migTable = await client.openTable(migNs);
  const migSchema = (await migTable.schema()).fields.map((f) => f.name);
  for (const col of ["start_date", "price", "bookable", "location"])
    assert.ok(migSchema.includes(col), `migrated schema has ${col}`);
  assert.strictEqual(await migTable.countRows(), 5, "2 alte + 3 neue Zeilen");
  // Alte Zeilen tragen null, Filter greift nur auf neue passende Zeilen
  await lance.ensureFullTextIndex(migTable);
  const migFiltered = await lance.hybridSimilarityResponse({
    client,
    namespace: migNs,
    query: "Yogakurs",
    queryVector: [1, 0, 0, 0],
    topN: 5,
    similarityThreshold: 0,
    filterIdentifiers: [],
    whereClause: filtersToWhere(sanitizeSearchFilters({ priceMax: 50 })),
  });
  const migIds = migFiltered.sourceDocuments.map((d) => d.id).sort();
  assert.deepStrictEqual(
    migIds,
    ["guenstig-abend", "guenstig-morgen"],
    `nur neue günstige Kurse, Alt-Zeilen (null-price) gefiltert — got ${migIds}`
  );
  // 3) Gegenrichtung: Zeilen OHNE Metadaten in migrierte Tabelle -> null-fill
  await lance.updateOrCreateCollection(
    client,
    [{ id: "spaeter-ohne-meta", text: "Infoseite Anmeldung", vector: [0, 1, 1, 0] }],
    migNs
  );
  // Frisches Handle: Lance-Handles lesen einen Versions-Snapshot, das alte
  // migTable-Handle sieht den Add einer anderen Verbindung nicht.
  const migTableFresh = await client.openTable(migNs);
  assert.strictEqual(
    await migTableFresh.countRows(),
    6,
    "Zeile ohne Metadaten wurde null-gefüllt hinzugefügt"
  );
  ok("Auto-Migration: addColumns auf Alt-Tabelle + Null-Fill in beide Richtungen");

  console.log("\n\x1b[32mAll 8 search-filter assertions passed.\x1b[0m");
}

run()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("\x1b[31mFAILED:\x1b[0m", e.message);
    process.exit(1);
  });
