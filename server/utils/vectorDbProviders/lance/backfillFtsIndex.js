/**
 * Idempotent full-text-search (BM25) index backfill for existing LanceDB
 * workspaces (KIE-471, P3).
 *
 * Newly-ingested collections get an FTS index on the "text" column via
 * LanceDb.ensureFullTextIndex() during ingestion. Collections created before
 * KIE-471 have no such index, so hybrid / hybrid_rerank search on those
 * workspaces falls back to slow flat-scan BM25. This script walks every table
 * in the LanceDB storage directory and, for each table lacking an FTS index on
 * "text", creates one and optimizes it.
 *
 * Design guarantees:
 *   - Idempotent: a table that already has an FTS index on "text" is skipped,
 *     so a second run is a no-op.
 *   - Read-safe: creating an FTS index and optimizing does not mutate vectors
 *     or row data; the app can keep serving reads while this runs.
 *   - Non-throwing per table: a failure on one table is logged and the script
 *     moves on to the next, so one corrupt table cannot block the backfill.
 *   - Dry-run: `--dry-run` reports what would change without touching anything.
 *
 * Run it directly (from the server/ directory or with STORAGE_DIR set):
 *
 *   node utils/vectorDbProviders/lance/backfillFtsIndex.js
 *   node utils/vectorDbProviders/lance/backfillFtsIndex.js --dry-run
 *   node utils/vectorDbProviders/lance/backfillFtsIndex.js --rebuild
 *
 * `--rebuild` recreates EVERY "text" FTS index with the current shared
 * tokenizer config (replace:true) — required once when the tokenizer config
 * changes (e.g. the KIE-478 switch to n-gram), since existing indexes keep
 * the config they were created with. Still additive: vectors and row data
 * are never mutated. The index config itself lives in ftsConfig.js (single
 * source of truth, shared with LanceDb.ensureFullTextIndex).
 */

const path = require("path");
const lancedb = require("@lancedb/lancedb");
const { FTS_INDEX_CONFIG } = require("./ftsConfig");

/**
 * Resolve the LanceDB storage directory the same way LanceDb.uri does, so the
 * script always targets the collections the running server uses.
 * @returns {string} Absolute path to the lancedb storage directory.
 */
function lanceStorageUri() {
  const basePath = !!process.env.STORAGE_DIR
    ? process.env.STORAGE_DIR
    : path.resolve(__dirname, "../../../storage");
  return path.resolve(basePath, "lancedb");
}

/**
 * Determine whether a table already has a full-text-search index covering the
 * "text" column.
 * @param {import('@lancedb/lancedb').Table} table - An open LanceDB table.
 * @returns {Promise<boolean>} true when an FTS index on "text" is present.
 */
async function hasTextFtsIndex(table) {
  if (!table || typeof table.listIndices !== "function") return false;
  const indices = await table.listIndices();
  return (indices || []).some((index) =>
    (index?.columns || []).includes("text")
  );
}

/**
 * Backfill FTS indexes across every LanceDB collection.
 *
 * @param {Object} [options]
 * @param {boolean} [options.dryRun=false] - Report only; make no changes.
 * @param {boolean} [options.rebuild=false] - Recreate indexes that already
 *   exist (replace:true) so they pick up the current tokenizer config.
 * @param {(...args: any[]) => void} [options.log=console.log] - Log sink.
 * @returns {Promise<{
 *   uri: string,
 *   dryRun: boolean,
 *   rebuild: boolean,
 *   tables: number,
 *   created: string[],
 *   skipped: string[],
 *   failed: {name: string, error: string}[],
 *   stats: Object<string, {numIndexedRows: number, numUnindexedRows: number}>,
 * }>} A summary of the run.
 */
async function backfillFtsIndex({
  dryRun = false,
  rebuild = false,
  log = console.log,
} = {}) {
  const uri = lanceStorageUri();
  const summary = {
    uri,
    dryRun,
    rebuild,
    tables: 0,
    created: [],
    skipped: [],
    failed: [],
    stats: {},
  };

  log(
    `[fts-backfill] Connecting to LanceDB at ${uri}${
      dryRun ? " (dry-run)" : ""
    }`
  );

  const client = await lancedb.connect(uri);
  const tableNames = await client.tableNames();
  summary.tables = tableNames.length;
  log(`[fts-backfill] Found ${tableNames.length} collection(s).`);

  for (const name of tableNames) {
    try {
      const table = await client.openTable(name);
      const alreadyIndexed = await hasTextFtsIndex(table);

      if (alreadyIndexed && !rebuild) {
        summary.skipped.push(name);
        log(`[fts-backfill] SKIP  ${name} (FTS index already present)`);
        // Still surface stats so a re-run can confirm health.
        await recordStats(table, name, summary, log);
        continue;
      }

      if (dryRun) {
        summary.created.push(name);
        log(
          `[fts-backfill] WOULD ${
            alreadyIndexed ? "REBUILD" : "CREATE"
          } FTS index on "text" for ${name}`
        );
        continue;
      }

      await table.createIndex("text", {
        config: lancedb.Index.fts(FTS_INDEX_CONFIG),
        replace: alreadyIndexed && rebuild,
      });
      // optimize() folds the newly-written index fragments in; it does not
      // mutate vectors or row data.
      if (typeof table.optimize === "function") await table.optimize();

      summary.created.push(name);
      log(
        `[fts-backfill] ${alreadyIndexed ? "REBUILD" : "CREATE"} ${name} — ` +
          `FTS index on "text" ${alreadyIndexed ? "rebuilt" : "created"}`
      );
      await recordStats(table, name, summary, log);
    } catch (e) {
      summary.failed.push({ name, error: e?.message || String(e) });
      console.error(`[fts-backfill] FAIL  ${name}: ${e?.message || e}`);
    }
  }

  log(
    `[fts-backfill] Done. tables=${summary.tables} ` +
      `${dryRun ? "would-create" : "created"}=${summary.created.length} ` +
      `skipped=${summary.skipped.length} failed=${summary.failed.length}`
  );
  return summary;
}

/**
 * Read and log FTS index stats for a table, recording numUnindexedRows so the
 * caller/operator can confirm the index is fully built (~0 unindexed rows).
 * Never throws — stats are diagnostic only.
 * @param {import('@lancedb/lancedb').Table} table
 * @param {string} name - Table/collection name.
 * @param {Object} summary - Mutated in place with a stats entry.
 * @param {(...args: any[]) => void} log
 * @returns {Promise<void>}
 */
async function recordStats(table, name, summary, log) {
  try {
    if (typeof table.indexStats !== "function") return;
    const stats = await table.indexStats("text_idx");
    if (!stats) return;
    summary.stats[name] = {
      numIndexedRows: stats.numIndexedRows ?? null,
      numUnindexedRows: stats.numUnindexedRows ?? null,
    };
    log(
      `[fts-backfill]   stats ${name}: indexed=${stats.numIndexedRows} ` +
        `unindexed=${stats.numUnindexedRows}`
    );
  } catch (e) {
    log(`[fts-backfill]   stats ${name}: unavailable (${e?.message || e})`);
  }
}

// Runnable as a standalone script.
if (require.main === module) {
  const dryRun =
    process.argv.includes("--dry-run") || process.argv.includes("--dryRun");
  const rebuild = process.argv.includes("--rebuild");
  backfillFtsIndex({ dryRun, rebuild })
    .then((summary) => {
      process.exit(summary.failed.length > 0 ? 1 : 0);
    })
    .catch((e) => {
      console.error("[fts-backfill] Fatal error:", e);
      process.exit(1);
    });
}

module.exports = { backfillFtsIndex, lanceStorageUri, hasTextFtsIndex };
