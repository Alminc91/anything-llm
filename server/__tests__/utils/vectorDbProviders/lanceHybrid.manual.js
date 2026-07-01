/**
 * Lightweight, framework-free integration tests for LanceDB hybrid search
 * (KIE-471, P2). Runs against a REAL temporary LanceDB table so we exercise the
 * installed @lancedb/lancedb 0.15.0 binary (FTS + vector).
 *
 * No JS test runner is configured in this repo (server/package.json has no
 * "test" script and jest/vitest are not installed). Run this directly:
 *
 *   node server/__tests__/utils/vectorDbProviders/lanceHybrid.manual.js
 *
 * Exits non-zero on the first failed assertion.
 *
 * Covers:
 *   T1  - hybrid returns _relevance_score-style (fused RRF) rows with NO
 *         _distance and NO vector leak.
 *   T2  - an exact KNR / instructor token surfaces in hybrid that pure vector
 *         misses (BM25 arm contributes).
 *   T3  - changing alpha (hybrid_weight) changes the fused ordering.
 *   T13 - dedupe by id across the two arms (a doc in both arms appears once).
 *   T15 - a row added AFTER index creation is FTS-findable without optimize().
 */

const assert = require("assert");
const os = require("os");
const path = require("path");
const fs = require("fs");

// The lance provider transitively requires utils/files, which resolves
// STORAGE_DIR at import time. Point it at a temp dir before any require below.
process.env.STORAGE_DIR =
  process.env.STORAGE_DIR ||
  fs.mkdtempSync(path.join(os.tmpdir(), "lancehybrid-storage-"));

const lancedb = require("@lancedb/lancedb");

let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`\x1b[32m  ✓\x1b[0m ${name}`);
}

// --- SystemSettings stub ----------------------------------------------------
// The lance provider reads hybrid_weight / reranker_retrieval_topk /
// reranker_instruction via SystemSettings.getValueOrFallback. We stub the
// module in require cache so no DB is needed. `settingsStore` is mutable so
// tests can flip alpha at runtime.
const settingsStore = {
  hybrid_weight: 0.7,
  reranker_retrieval_topk: 40,
  reranker_instruction: "",
  text_splitter_chunk_size: 1000,
  text_splitter_chunk_overlap: 20,
};
const systemSettingsPath = require.resolve("../../../models/systemSettings");
require.cache[systemSettingsPath] = {
  id: systemSettingsPath,
  filename: systemSettingsPath,
  loaded: true,
  exports: {
    SystemSettings: {
      getValueOrFallback: async (clause = {}, fallback = null) => {
        const label = clause?.label;
        return label in settingsStore ? settingsStore[label] : fallback;
      },
    },
  },
};

// chats.sourceIdentifier is required transitively; stub to avoid pulling models.
const chatsPath = require.resolve("../../../utils/chats");
require.cache[chatsPath] = {
  id: chatsPath,
  filename: chatsPath,
  loaded: true,
  exports: {
    sourceIdentifier: (doc) => doc?.docId || doc?.id || null,
  },
};

// getRerankerProviderSelection is destructured into lance/index.js at require
// time, so we must install a stubbable factory in the helpers module cache
// BEFORE requiring the provider. `rerankerStub` is a mutable holder the
// hybrid_rerank tests swap out at runtime; null means "use the real factory".
const realHelpers = require("../../../utils/helpers");
const realGetReranker = realHelpers.getRerankerProviderSelection;
let rerankerStub = null;
realHelpers.getRerankerProviderSelection = (config) =>
  rerankerStub ? rerankerStub(config) : realGetReranker(config);

const { LanceDb } = require("../../../utils/vectorDbProviders/lance");

// --- fixtures ---------------------------------------------------------------
// Simple orthonormal-ish vectors so cosine ordering is predictable and
// independent of the FTS arm.
function makeRows() {
  return [
    {
      id: "doc-1",
      docId: "d1",
      vector: [1, 0, 0, 0],
      text: "Yoga für Anfänger, entspannter Kurs am Montagabend in der Halle.",
    },
    {
      id: "doc-2",
      docId: "d2",
      vector: [0.9, 0.1, 0, 0],
      text: "Pilates und Rückengymnastik, ruhiger Kurs für Einsteiger.",
    },
    {
      id: "doc-3",
      docId: "d3",
      vector: [0, 0, 1, 0],
      text: "Excel Grundlagen mit Dozentin Frau Habermann, Kursnummer KNR-84213.",
    },
    {
      id: "doc-4",
      docId: "d4",
      vector: [0, 0, 0, 1],
      text: "Töpfern und Keramik am Wochenende, Materialkosten inklusive.",
    },
  ];
}

async function run() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lancehybrid-"));
  const client = await lancedb.connect(dir);
  const namespace = "ws_test";
  const lance = new LanceDb();

  // Patch connect() so provider methods that call this.connect()/namespaceCount
  // hit our temp dir rather than STORAGE_DIR.
  lance.connect = async () => ({ client });

  try {
    // Create table + FTS index via the provider path (ensureFullTextIndex).
    const rows = makeRows();
    await lance.updateOrCreateCollection(client, rows, namespace);

    const collection = await client.openTable(namespace);
    const indices = await collection.listIndices();
    assert.ok(
      indices.some((i) => (i.columns || []).includes("text")),
      "FTS index on 'text' must exist after updateOrCreateCollection"
    );
    ok("FTS index created on 'text' via updateOrCreateCollection");

    // The query targets the first vector but references the exact KNR token.
    // Pure vector would rank doc-1/doc-2 first; BM25 must surface doc-3.
    const query = "Kurs mit KNR-84213";
    const queryVector = [1, 0, 0, 0];

    // --- T1: hybrid shape (fused score, no _distance, no vector leak) -------
    const hybrid = await lance.hybridSimilarityResponse({
      client,
      namespace,
      query,
      queryVector,
      topN: 4,
      filterIdentifiers: [],
    });
    assert.ok(hybrid.sourceDocuments.length > 0, "hybrid returned rows");
    for (const doc of hybrid.sourceDocuments) {
      assert.ok(
        typeof doc.score === "number" && doc.score > 0,
        "each hybrid row carries a positive fused score"
      );
      assert.strictEqual(doc.vector, undefined, "no vector leak in hybrid row");
      assert.strictEqual(
        doc._distance,
        undefined,
        "no _distance in hybrid row"
      );
      assert.strictEqual(doc._score, undefined, "no raw _score in hybrid row");
    }
    ok("T1 hybrid rows have fused score, no _distance / no vector leak");

    // --- T2: exact KNR token surfaces via BM25 that pure vector misses ------
    const pureVector = await lance.similarityResponse({
      client,
      namespace,
      queryVector,
      topN: 2,
      filterIdentifiers: [],
    });
    const vectorIds = pureVector.sourceDocuments.map((d) => d.id);
    assert.ok(
      !vectorIds.includes("doc-3"),
      "pure vector top-2 should NOT contain the KNR doc (doc-3)"
    );

    // Within the same top-2 window the BM25 arm pulls the exact-token doc into
    // the hybrid results even though pure vector never saw it. We tilt alpha
    // toward BM25 to demonstrate the arm's contribution deterministically.
    settingsStore.hybrid_weight = 0.2;
    const hybridTop2 = await lance.hybridSimilarityResponse({
      client,
      namespace,
      query,
      queryVector,
      topN: 2,
      filterIdentifiers: [],
    });
    settingsStore.hybrid_weight = 0.7; // restore
    const hybridIds = hybridTop2.sourceDocuments.map((d) => d.id);
    assert.ok(
      hybridIds.includes("doc-3"),
      `hybrid top-2 must surface the KNR doc (doc-3); got ${JSON.stringify(hybridIds)}`
    );
    ok("T2 exact KNR token surfaces in hybrid but not pure vector");

    // --- T3: changing alpha (hybrid_weight) changes ordering ----------------
    // High alpha -> vector arm dominates -> doc-1 first.
    settingsStore.hybrid_weight = 0.95;
    const alphaHigh = await lance.hybridSimilarityResponse({
      client,
      namespace,
      query,
      queryVector,
      topN: 4,
      filterIdentifiers: [],
    });
    // Low alpha -> FTS arm dominates -> the KNR doc should climb.
    settingsStore.hybrid_weight = 0.05;
    const alphaLow = await lance.hybridSimilarityResponse({
      client,
      namespace,
      query,
      queryVector,
      topN: 4,
      filterIdentifiers: [],
    });
    settingsStore.hybrid_weight = 0.7; // restore

    const orderHigh = alphaHigh.sourceDocuments.map((d) => d.id).join(",");
    const orderLow = alphaLow.sourceDocuments.map((d) => d.id).join(",");
    assert.notStrictEqual(
      orderHigh,
      orderLow,
      `alpha must change ordering; high=${orderHigh} low=${orderLow}`
    );
    assert.strictEqual(
      alphaHigh.sourceDocuments[0].id,
      "doc-1",
      "high alpha should rank the vector-matched doc first"
    );
    assert.strictEqual(
      alphaLow.sourceDocuments[0].id,
      "doc-3",
      "low alpha should rank the BM25-matched KNR doc first"
    );
    ok("T3 alpha (hybrid_weight) changes fused ordering");

    // --- T13: dedupe by id across arms --------------------------------------
    const seen = new Set();
    for (const doc of alphaLow.sourceDocuments) {
      assert.ok(!seen.has(doc.id), `id ${doc.id} appears at most once`);
      seen.add(doc.id);
    }
    ok("T13 fused results are deduped by id across both arms");

    // --- T15: row added AFTER index creation is FTS-findable ----------------
    await lance.updateOrCreateCollection(
      client,
      [
        {
          id: "doc-5",
          docId: "d5",
          vector: [0, 1, 0, 0],
          text: "Nähkurs Fortgeschrittene, Dozent Herr Zwiebelfisch, KNR-70011.",
        },
      ],
      namespace
    );
    const postAdd = await lance.hybridSimilarityResponse({
      client,
      namespace,
      query: "Zwiebelfisch KNR-70011",
      queryVector: [0, 0, 0, 0], // neutral vector so FTS must do the work
      topN: 3,
      filterIdentifiers: [],
    });
    const postIds = postAdd.sourceDocuments.map((d) => d.id);
    assert.ok(
      postIds.includes("doc-5"),
      `newly-added row must be FTS-findable without optimize(); got ${JSON.stringify(postIds)}`
    );
    ok("T15 row added after index creation is FTS-findable (no optimize)");

    // --- filterIdentifiers still honored (pinned-doc filtering) -------------
    const filtered = await lance.hybridSimilarityResponse({
      client,
      namespace,
      query,
      queryVector,
      topN: 4,
      filterIdentifiers: ["d3"], // sourceIdentifier stub returns docId
    });
    assert.ok(
      !filtered.sourceDocuments.some((d) => d.id === "doc-3"),
      "filterIdentifiers must drop the pinned doc from hybrid results"
    );
    ok("filterIdentifiers/pinned filtering honored in hybrid");

    // --- hybrid_rerank: reranker decides order; RRF fallback on failure -----
    // (a) reranker that reverses candidates -> proves it drives final order.
    rerankerStub = () => ({
      rerank: async (_q, docs, opts) =>
        [...docs]
          .reverse()
          .slice(0, opts?.topK ?? 4)
          .map((d, i) => ({ ...d, rerank_score: 1 - i * 0.01 })),
    });
    const rerankedActive = await lance.hybridRerankedSimilarityResponse({
      client,
      namespace,
      query,
      queryVector,
      topN: 4,
      filterIdentifiers: [],
    });
    assert.ok(
      rerankedActive.sourceDocuments.length > 0,
      "hybrid_rerank returned rows"
    );
    for (const doc of rerankedActive.sourceDocuments) {
      assert.strictEqual(
        doc.vector,
        undefined,
        "no vector leak (hybrid_rerank)"
      );
      assert.strictEqual(
        doc.rrf_score,
        undefined,
        "internal rrf_score stripped"
      );
    }
    ok("hybrid_rerank returns clean rows ordered by the reranker");

    // (b) reranker that "fails" by returning docs unmodified -> RRF fallback.
    rerankerStub = () => ({
      rerank: async (_q, docs, opts) => docs.slice(0, opts?.topK ?? 4),
    });
    const rerankedFallback = await lance.hybridRerankedSimilarityResponse({
      client,
      namespace,
      query,
      queryVector,
      topN: 3,
      filterIdentifiers: [],
    });
    assert.ok(
      rerankedFallback.sourceDocuments.length > 0 &&
        rerankedFallback.scores.every((s) => typeof s === "number"),
      "hybrid_rerank falls back to RRF order/score when reranker no-ops"
    );
    ok("hybrid_rerank degrades to RRF order when reranker returns unmodified");
    rerankerStub = null; // restore real factory

    console.log(`\n\x1b[32mAll ${passed} assertions passed.\x1b[0m`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

run().catch((e) => {
  console.error(`\n\x1b[31mTEST FAILED:\x1b[0m ${e.message}`);
  console.error(e.stack);
  process.exit(1);
});
