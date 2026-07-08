/**
 * Framework-free self-test for the LanceDB FTS backfill script (KIE-471, P3).
 * Runs against a REAL temporary LanceDB storage dir so we exercise the
 * installed @lancedb/lancedb 0.15.0 binary.
 *
 * No JS test runner is configured for the server (server/package.json has no
 * "test" script and jest/vitest are not installed). Run this directly:
 *
 *   node server/__tests__/utils/vectorDbProviders/lanceFtsBackfill.manual.js
 *
 * Exits non-zero on the first failed assertion.
 *
 * Covers acceptance T12:
 *   - a legacy table (no FTS index) gets one created;
 *   - after the run the FTS index exists with numUnindexedRows ~0;
 *   - no vectors / rows are mutated (countRows + a sample vector unchanged);
 *   - a second run is a no-op (table reported as skipped, index untouched);
 *   - --dry-run reports the pending create but changes nothing.
 */

const assert = require("assert");
const os = require("os");
const path = require("path");
const fs = require("fs");

const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "lancefts-backfill-"));
process.env.STORAGE_DIR = storageDir;

const lancedb = require("@lancedb/lancedb");
const {
  backfillFtsIndex,
  hasTextFtsIndex,
  lanceStorageUri,
} = require("../../../utils/vectorDbProviders/lance/backfillFtsIndex");

let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`\x1b[32m  ✓\x1b[0m ${name}`);
}

// Silence the script's own chatter during assertions; flip to console.log when
// debugging.
const quiet = () => {};

async function main() {
  const uri = lanceStorageUri();
  const db = await lancedb.connect(uri);

  // Two legacy tables (no FTS index), plus one that already has an index so we
  // can prove idempotent skip behavior in a single pass.
  const legacyRows = [
    { id: "a", docId: "da", vector: [1, 0, 0, 0], text: "Yoga Kurs Montag" },
    {
      id: "b",
      docId: "db",
      vector: [0, 1, 0, 0],
      text: "Excel Grundlagen KNR-84213 Frau Habermann",
    },
    { id: "c", docId: "dc", vector: [0, 0, 1, 0], text: "Toepfern Keramik" },
  ];
  const legacy1 = await db.createTable("legacy-one", legacyRows);
  await db.createTable("legacy-two", legacyRows);

  const pre = await db.createTable("pre-indexed", legacyRows);
  await pre.createIndex("text", {
    config: lancedb.Index.fts({ lowercase: true, asciiFolding: true }),
    replace: false,
  });

  // Sanity: legacy tables really have no FTS index yet.
  assert.strictEqual(
    await hasTextFtsIndex(legacy1),
    false,
    "legacy table should start without an FTS index"
  );
  assert.strictEqual(
    await hasTextFtsIndex(pre),
    true,
    "pre-indexed table should start with an FTS index"
  );
  ok("T12: initial index state is correct (legacy=none, pre-indexed=present)");

  // Baseline row counts + a sample vector to detect any mutation.
  const legacy1Rows = await legacy1.countRows();
  const sampleBefore = (
    await legacy1.query().where("id = 'a'").limit(1).toArray()
  )[0];
  assert.ok(sampleBefore, "sample row should exist before backfill");

  // --- --dry-run makes no changes -----------------------------------------
  const dry = await backfillFtsIndex({ dryRun: true, log: quiet });
  assert.strictEqual(dry.dryRun, true);
  assert.strictEqual(dry.tables, 3, "dry-run should see all 3 tables");
  assert.ok(
    dry.created.includes("legacy-one") && dry.created.includes("legacy-two"),
    "dry-run should mark both legacy tables as would-create"
  );
  assert.ok(
    dry.skipped.includes("pre-indexed"),
    "dry-run should mark pre-indexed table as skipped"
  );
  assert.strictEqual(
    await hasTextFtsIndex(await db.openTable("legacy-one")),
    false,
    "dry-run must NOT create an index"
  );
  ok("T12: --dry-run reports pending creates and changes nothing");

  // --- first real run creates indexes on legacy tables ---------------------
  const run1 = await backfillFtsIndex({ dryRun: false, log: quiet });
  assert.strictEqual(run1.failed.length, 0, "first run should not fail");
  assert.ok(
    run1.created.includes("legacy-one") && run1.created.includes("legacy-two"),
    "first run should create both legacy indexes"
  );
  assert.ok(
    run1.skipped.includes("pre-indexed"),
    "first run should skip the pre-indexed table"
  );

  const legacy1After = await db.openTable("legacy-one");
  assert.strictEqual(
    await hasTextFtsIndex(legacy1After),
    true,
    "legacy table should have an FTS index after backfill"
  );
  ok("T12: first run creates FTS index on legacy tables");

  // Index is fully built (numUnindexedRows ~0).
  const stats1 = run1.stats["legacy-one"];
  assert.ok(stats1, "stats should be recorded for a created table");
  assert.strictEqual(
    stats1.numUnindexedRows,
    0,
    `FTS index should have 0 unindexed rows after optimize(), got ${stats1.numUnindexedRows}`
  );
  ok("T12: FTS index has numUnindexedRows === 0 after run");

  // No rows / vectors mutated.
  assert.strictEqual(
    await legacy1After.countRows(),
    legacy1Rows,
    "row count must be unchanged after backfill"
  );
  const sampleAfter = (
    await legacy1After.query().where("id = 'a'").limit(1).toArray()
  )[0];
  assert.deepStrictEqual(
    Array.from(sampleAfter.vector),
    Array.from(sampleBefore.vector),
    "sample vector must be byte-for-byte unchanged after backfill"
  );
  ok("T12: no vectors/rows mutated by backfill");

  // --- second run is a no-op ----------------------------------------------
  const run2 = await backfillFtsIndex({ dryRun: false, log: quiet });
  assert.strictEqual(run2.failed.length, 0, "second run should not fail");
  assert.strictEqual(
    run2.created.length,
    0,
    "second run must create nothing (idempotent no-op)"
  );
  assert.deepStrictEqual(
    run2.skipped.sort(),
    ["legacy-one", "legacy-two", "pre-indexed"].sort(),
    "second run should skip every table"
  );
  ok("T12: second run is a no-op (all tables skipped)");

  // FTS query still works after backfill (index is usable).
  const hits = await legacy1After
    .query()
    .fullTextSearch("KNR-84213", { columns: "text" })
    .limit(5)
    .toArray();
  assert.ok(
    hits.some((r) => r.id === "b"),
    "BM25 query on the backfilled index should find the KNR row"
  );
  ok("T12: backfilled FTS index is queryable (BM25 finds exact token)");

  console.log(`\n\x1b[32mAll ${passed} FTS-backfill assertions passed.\x1b[0m`);
}

main()
  .then(() => {
    fs.rmSync(storageDir, { recursive: true, force: true });
    process.exit(0);
  })
  .catch((e) => {
    console.error(`\n\x1b[31mFTS-backfill self-test FAILED:\x1b[0m`, e);
    try {
      fs.rmSync(storageDir, { recursive: true, force: true });
    } catch {}
    process.exit(1);
  });
