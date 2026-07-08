/**
 * SEARCH-MODE EVAL HARNESS — SKELETON ONLY (KIE-471, P5).
 *
 * ============================ DO NOT RUN YET ============================
 * This is scaffolding. It is intentionally NOT wired to a real query set or a
 * live reranker endpoint. Running it as-is will refuse and exit non-zero. Every
 * place that needs real data/config before a meaningful run is marked `TODO`.
 * Fill those in (and stand up a reranker per server/HYBRID_SEARCH_RERANKER.md)
 * before executing.
 * =======================================================================
 *
 * PURPOSE
 *   Compare retrieval quality across the four search modes on a fixed German
 *   query set (KuferSQL / VHS), so we can pick a default and tune hybrid_weight
 *   / reranker_retrieval_topk with evidence rather than by feel.
 *
 *     default        pure dense vector
 *     hybrid         weighted RRF fusion of vector + BM25
 *     rerank         vector -> reranker
 *     hybrid_rerank  union(vector, BM25) -> dedupe -> reranker   (recommended)
 *
 * WHY A SKELETON
 *   The real eval needs (a) a curated query set with known-relevant document
 *   ids and (b) a running reranker container. Neither is committed to the repo
 *   (customer data + infra). This file locks in the RUN SHAPE and the exact
 *   provider API so the eval can be finished quickly once those exist, without
 *   re-deriving how to call the LanceDB provider.
 *
 * HOW IT WILL RUN (once wired)
 *   1. Point STORAGE_DIR at a LanceDB store that already has the target
 *      workspace ingested (or ingest a fixture first).
 *   2. Provide RERANKER_* env (see server/HYBRID_SEARCH_RERANKER.md) so the
 *      rerank / hybrid_rerank modes hit a real service.
 *   3. Fill loadQuerySet() with the KuferSQL/VHS queries + relevant doc ids.
 *   4. node server/__tests__/utils/vectorDbProviders/searchModeEval.eval.js
 *
 * OUTPUT (planned)
 *   A per-mode table of aggregate metrics (Recall@k, MRR, nDCG@k) plus mean
 *   latency, so modes are comparable on the SAME queries against the SAME store.
 *
 * NOTE: no JS test runner is configured in this repo; this is a standalone node
 * script (mirrors the *.manual.js convention in this folder). It is named
 * *.eval.js — not *.test.js — because it is an offline evaluation, not a unit
 * test, and must never run in an automated test/CI pass.
 */

/* eslint-disable no-unused-vars */

const NAME = "searchModeEval";
const MODES = ["default", "hybrid", "rerank", "hybrid_rerank"];

// Retrieval depth to evaluate at (topN passed to the provider, and the k in
// Recall@k / nDCG@k). TODO: confirm against production topN.
const TOP_N = 4;

/**
 * TODO(P-later): return the real evaluation query set.
 *
 * Shape (per row):
 *   {
 *     query: "Wann startet der Yoga-Kurs für Anfänger?",   // German user query
 *     relevantDocIds: ["<docId-or-sourceIdentifier>", ...] // ground truth
 *   }
 *
 * Source it from the KuferSQL benchmark / VHS query logs (see MEMORY:
 * project_kufersql_benchmark_results, project_chatbot_quality_analysis). Keep
 * it OUT of git if it contains customer data — load from an uncommitted path
 * via an env var, e.g. EVAL_QUERYSET_PATH.
 *
 * @returns {{query: string, relevantDocIds: string[]}[]}
 */
function loadQuerySet() {
  // TODO: replace with real loader, e.g.:
  //   const path = process.env.EVAL_QUERYSET_PATH;
  //   return JSON.parse(fs.readFileSync(path, "utf8"));
  return [];
}

/**
 * TODO(P-later): identify the workspace/namespace to evaluate against.
 * This must be an already-ingested LanceDB collection reachable under
 * STORAGE_DIR. The FTS index is required for the hybrid arms — backfill it
 * first if needed (see server/HYBRID_SEARCH_RERANKER.md §6).
 *
 * @returns {string}
 */
function targetNamespace() {
  // TODO: e.g. process.env.EVAL_NAMESPACE || "vhs-lingen";
  return process.env.EVAL_NAMESPACE || "";
}

/**
 * Runs one query in one mode against the real LanceDB provider and returns the
 * ordered list of retrieved doc identifiers.
 *
 * The provider entrypoint and its exact params are locked in here so the eval
 * matches production call-sites 1:1 (see performSimilaritySearch in
 * server/utils/vectorDbProviders/lance/index.js):
 *
 *   const { getVectorDbClass, getLLMProvider } = require("../../../utils/helpers");
 *   const VectorDb = getVectorDbClass();           // LanceDB
 *   const LLMConnector = getLLMProvider();          // for input embedding
 *   const { sources } = await VectorDb.performSimilaritySearch({
 *     namespace,
 *     input: query,
 *     LLMConnector,
 *     similarityThreshold: 0.25, // ignored by the hybrid RRF path by design
 *     topN: TOP_N,
 *     filterIdentifiers: [],
 *     searchMode,                // "default" | "hybrid" | "rerank" | "hybrid_rerank"
 *   });
 *   return sources.map((s) => s.docId ?? s.sourceIdentifier ?? s.id);
 *
 * TODO(P-later): un-stub and use the real provider. Left un-required here so
 * the skeleton does not pull in the DB/LLM stack when it is only being linted.
 *
 * @param {string} mode
 * @param {string} query
 * @param {string} namespace
 * @returns {Promise<string[]>} retrieved doc ids, best-first
 */
async function retrieve(mode, query, namespace) {
  // TODO: wire to VectorDb.performSimilaritySearch({ ..., searchMode: mode }).
  throw new Error(
    `[${NAME}] retrieve() is a TODO stub — wire performSimilaritySearch before running.`
  );
}

// --- Metrics (ready to use; operate on retrieved-id lists + ground truth) ---

/**
 * Recall@k: fraction of relevant docs that appear in the top-k retrieved.
 * @param {string[]} retrieved best-first ids
 * @param {string[]} relevant ground-truth ids
 * @param {number} k
 * @returns {number} 0..1
 */
function recallAtK(retrieved, relevant, k) {
  if (!relevant.length) return 0;
  const top = new Set(retrieved.slice(0, k));
  const hit = relevant.filter((id) => top.has(id)).length;
  return hit / relevant.length;
}

/**
 * Reciprocal Rank: 1/rank of the first relevant doc (0 if none in list).
 * @param {string[]} retrieved best-first ids
 * @param {string[]} relevant ground-truth ids
 * @returns {number} 0..1
 */
function reciprocalRank(retrieved, relevant) {
  const rel = new Set(relevant);
  for (let i = 0; i < retrieved.length; i++)
    if (rel.has(retrieved[i])) return 1 / (i + 1);
  return 0;
}

/**
 * nDCG@k with binary relevance.
 * @param {string[]} retrieved best-first ids
 * @param {string[]} relevant ground-truth ids
 * @param {number} k
 * @returns {number} 0..1
 */
function ndcgAtK(retrieved, relevant, k) {
  const rel = new Set(relevant);
  let dcg = 0;
  for (let i = 0; i < Math.min(k, retrieved.length); i++)
    if (rel.has(retrieved[i])) dcg += 1 / Math.log2(i + 2);
  let idcg = 0;
  for (let i = 0; i < Math.min(k, relevant.length); i++)
    idcg += 1 / Math.log2(i + 2);
  return idcg === 0 ? 0 : dcg / idcg;
}

async function main() {
  const querySet = loadQuerySet();
  const namespace = targetNamespace();

  // Guard: refuse to pretend we evaluated anything without real inputs.
  if (querySet.length === 0 || !namespace) {
    console.error(
      `[${NAME}] SKELETON — not wired yet.\n` +
        `  - loadQuerySet() returned ${querySet.length} queries (need > 0)\n` +
        `  - targetNamespace() returned "${namespace}" (need a real LanceDB collection)\n` +
        `  Fill the TODOs and stand up a reranker (server/HYBRID_SEARCH_RERANKER.md) first.`
    );
    process.exit(1);
  }

  const results = {}; // mode -> aggregate metrics
  for (const mode of MODES) {
    let recall = 0;
    let mrr = 0;
    let ndcg = 0;
    let latencyMs = 0;

    for (const { query, relevantDocIds } of querySet) {
      const t0 = Date.now();
      const retrieved = await retrieve(mode, query, namespace);
      latencyMs += Date.now() - t0;

      recall += recallAtK(retrieved, relevantDocIds, TOP_N);
      mrr += reciprocalRank(retrieved, relevantDocIds);
      ndcg += ndcgAtK(retrieved, relevantDocIds, TOP_N);
    }

    const n = querySet.length;
    results[mode] = {
      [`recall@${TOP_N}`]: +(recall / n).toFixed(4),
      mrr: +(mrr / n).toFixed(4),
      [`ndcg@${TOP_N}`]: +(ndcg / n).toFixed(4),
      meanLatencyMs: Math.round(latencyMs / n),
    };
  }

  console.log(
    `\n[${NAME}] ${querySet.length} queries × ${MODES.length} modes\n`
  );
  console.table(results);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(`[${NAME}] failed:`, e);
    process.exit(1);
  });
}

module.exports = { recallAtK, reciprocalRank, ndcgAtK, MODES };
