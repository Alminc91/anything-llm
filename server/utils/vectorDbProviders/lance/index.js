const lancedb = require("@lancedb/lancedb");
const {
  toChunks,
  getEmbeddingEngineSelection,
  getRerankerProviderSelection,
} = require("../../helpers");
const { TextSplitter } = require("../../TextSplitter");
const { SystemSettings } = require("../../../models/systemSettings");
const { storeVectorResult, cachedVectorInformation } = require("../../files");
const { v4: uuidv4 } = require("uuid");
const { sourceIdentifier } = require("../../chats");
const { VectorDatabase } = require("../base");
const { FTS_INDEX_CONFIG } = require("./ftsConfig");
const {
  sanitizeSearchFilters,
  filtersToWhere,
} = require("./searchFilters");
const {
  extractFilters,
  stripTimeFilters,
} = require("../../chats/metadataFilterExtractor");
const SearchTrace = require("./searchTrace");
const path = require("path");

// KIE-480: DataFusion NULL-cast types for the structured course-metadata
// columns (see searchFilters.js / collector processRawText METADATA_KEYS).
// Used by the automatic schema migration when documents carrying these
// fields are added to a table created before the columns existed.
// NOTE: type names must come from lance-datafusion's supported list
// ("string", "bigint", "double", "boolean", ... — NOT "varchar").
const COURSE_COLUMN_SQL_TYPES = Object.freeze({
  start_date: "STRING",
  end_date: "STRING",
  weekdays: "STRING",
  format: "STRING",
  location: "STRING",
  start_minutes: "BIGINT",
  price: "DOUBLE",
  bookable: "BOOLEAN",
});

/**
 * LancedDB Client connection object
 * @typedef {import('@lancedb/lancedb').Connection} LanceClient
 */

class LanceDb extends VectorDatabase {
  constructor() {
    super();
  }

  get uri() {
    const basePath = !!process.env.STORAGE_DIR
      ? process.env.STORAGE_DIR
      : path.resolve(__dirname, "../../../storage");
    return path.resolve(basePath, "lancedb");
  }

  get name() {
    return "LanceDb";
  }

  /** @returns {Promise<{client: LanceClient}>} */
  async connect() {
    const client = await lancedb.connect(this.uri);
    return { client };
  }

  distanceToSimilarity(distance = null) {
    if (distance === null || typeof distance !== "number") return 0.0;
    if (distance >= 1.0) return 1;
    if (distance < 0) return 1 - Math.abs(distance);
    return 1 - distance;
  }

  /**
   * Runs a query builder with an optional metadata where-clause (KIE-480).
   * Legacy tables ingested before the metadata columns existed would make
   * the filtered query throw ("no field named ...") — in that case we log
   * and RERUN UNFILTERED: a missing filter degrades to today's behavior,
   * an empty result would silently hide courses.
   * @param {() => import('@lancedb/lancedb').Query} buildQuery - Factory
   *   returning a FRESH query builder (must be re-callable for the retry).
   * @param {string|null} whereClause - Output of filtersToWhere().
   * @returns {Promise<object[]>} Result rows.
   */
  async filteredQueryRows(buildQuery, whereClause = null) {
    if (!whereClause) return await buildQuery().toArray();
    try {
      return await buildQuery().where(whereClause).toArray();
    } catch (e) {
      this.logger(
        `searchFilters: filtered query failed (${e.message}) — retrying unfiltered.`
      );
      return await buildQuery().toArray();
    }
  }

  async heartbeat() {
    await this.connect();
    return { heartbeat: Number(new Date()) };
  }

  async tables() {
    const { client } = await this.connect();
    return await client.tableNames();
  }

  async totalVectors() {
    const { client } = await this.connect();
    const tables = await client.tableNames();
    let count = 0;
    for (const tableName of tables) {
      const table = await client.openTable(tableName);
      count += await table.countRows();
    }
    return count;
  }

  async namespaceCount(_namespace = null) {
    const { client } = await this.connect();
    const exists = await this.namespaceExists(client, _namespace);
    if (!exists) return 0;

    const table = await client.openTable(_namespace);
    return (await table.countRows()) || 0;
  }

  /**
   * Performs a SimilaritySearch + Reranking on a namespace.
   * @param {Object} params - The parameters for the rerankedSimilarityResponse.
   * @param {Object} params.client - The vectorDB client.
   * @param {string} params.namespace - The namespace to search in.
   * @param {string} params.query - The query to search for (plain text).
   * @param {number[]} params.queryVector - The vector of the query.
   * @param {number} params.similarityThreshold - The threshold for similarity.
   * @param {number} params.topN - the number of results to return from this process.
   * @param {string[]} params.filterIdentifiers - The identifiers of the documents to filter out.
   * @returns
   */
  async rerankedSimilarityResponse({
    client,
    namespace,
    query,
    queryVector,
    topN = 4,
    similarityThreshold = 0.25,
    filterIdentifiers = [],
    whereClause = null,
    trace = null,
  }) {
    const reranker = getRerankerProviderSelection();
    const collection = await client.openTable(namespace);
    const totalEmbeddings = await this.namespaceCount(namespace);
    const result = {
      contextTexts: [],
      sourceDocuments: [],
      scores: [],
    };

    /**
     * For reranking, we want to work with a larger number of results than the topN.
     * This is because the reranker can only rerank the results it it given and we dont auto-expand the results.
     * We want to give the reranker a larger number of results to work with.
     *
     * However, we cannot make this boundless as reranking is expensive and time consuming.
     * So we limit the number of results to a maximum of 50 and a minimum of 10.
     * This is a good balance between the number of results to rerank and the cost of reranking
     * and ensures workspaces with 10K embeddings will still rerank within a reasonable timeframe on base level hardware.
     *
     * Benchmarks:
     * On Intel Mac: 2.6 GHz 6-Core Intel Core i7 - 20 docs reranked in ~5.2 sec
     */
    const searchLimit = Math.max(
      10,
      Math.min(50, Math.ceil(totalEmbeddings * 0.1))
    );
    const vectorStart = Date.now();
    const vectorSearchResults = await this.filteredQueryRows(
      () =>
        collection
          .vectorSearch(queryVector)
          .distanceType("cosine")
          .limit(searchLimit),
      whereClause
    );
    if (trace)
      trace.vectorArm = {
        ms: Date.now() - vectorStart,
        count: vectorSearchResults.length,
        error: null,
        top: SearchTrace.captureRows(vectorSearchResults, "similarity", (r) =>
          this.distanceToSimilarity(r._distance)
        ),
      };
    // Vektor-Rang je Kandidat (1-basiert) für die Shift-Metrik im Trace.
    const vectorRankById = trace
      ? new Map(vectorSearchResults.map((r, i) => [r.id, i + 1]))
      : null;

    const rerankStart = Date.now();
    await reranker
      .rerank(query, vectorSearchResults, { topK: topN })
      .then((rerankResults) => {
        rerankResults.forEach((item) => {
          if (this.distanceToSimilarity(item._distance) < similarityThreshold)
            return;
          const { vector: _, ...rest } = item;
          if (filterIdentifiers.includes(sourceIdentifier(rest))) {
            this.logger(
              "A source was filtered from context as it's parent document is pinned."
            );
            return;
          }
          const score =
            item?.rerank_score || this.distanceToSimilarity(item._distance);

          result.contextTexts.push(rest.text);
          result.sourceDocuments.push({
            ...rest,
            score,
          });
          result.scores.push(score);
        });
      })
      .catch((e) => {
        this.logger(e);
        this.logger("rerankedSimilarityResponse", e.message);
      });

    if (trace) {
      // rerank_score bleibt via ...rest auf den Docs erhalten und ist der
      // einzige verlässliche Indikator: `score` wird in diesem Pfad IMMER
      // gesetzt (Fallback distanceToSimilarity) und taugt nicht zur Erkennung.
      const degraded = !result.sourceDocuments.some(
        (d) => typeof d.rerank_score === "number"
      );
      trace.rerank = {
        provider: process.env.RERANKER_PROVIDER || "native",
        model: process.env.RERANKER_MODEL_PREF || null,
        ms: Date.now() - rerankStart,
        sent: vectorSearchResults.length,
        returned: result.sourceDocuments.length,
        degraded,
      };
      trace.final = {
        count: result.sourceDocuments.length,
        docs: result.sourceDocuments.map((d, i) => {
          const vectorRank = vectorRankById.get(d.id) ?? null;
          return {
            finalRank: i + 1,
            ...SearchTrace.docRef(d),
            rerankScore: SearchTrace.round(
              typeof d.score === "number" ? d.score : null
            ),
            vectorRank,
            shift: vectorRank !== null ? vectorRank - (i + 1) : null,
          };
        }),
      };
    }

    return result;
  }

  /**
   * Performs a SimilaritySearch on a give LanceDB namespace.
   * @param {Object} params
   * @param {LanceClient} params.client
   * @param {string} params.namespace
   * @param {number[]} params.queryVector
   * @param {number} params.similarityThreshold
   * @param {number} params.topN
   * @param {string[]} params.filterIdentifiers
   * @returns
   */
  async similarityResponse({
    client,
    namespace,
    queryVector,
    similarityThreshold = 0.25,
    topN = 4,
    filterIdentifiers = [],
    whereClause = null,
    trace = null,
  }) {
    const collection = await client.openTable(namespace);
    const result = {
      contextTexts: [],
      sourceDocuments: [],
      scores: [],
    };

    const vectorStart = Date.now();
    const response = await this.filteredQueryRows(
      () =>
        collection.vectorSearch(queryVector).distanceType("cosine").limit(topN),
      whereClause
    );
    if (trace)
      trace.vectorArm = {
        ms: Date.now() - vectorStart,
        count: response.length,
        error: null,
        top: SearchTrace.captureRows(response, "similarity", (r) =>
          this.distanceToSimilarity(r._distance)
        ),
      };

    response.forEach((item) => {
      if (this.distanceToSimilarity(item._distance) < similarityThreshold)
        return;
      const { vector: _, ...rest } = item;
      if (filterIdentifiers.includes(sourceIdentifier(rest))) {
        this.logger(
          "A source was filtered from context as it's parent document is pinned."
        );
        return;
      }

      result.contextTexts.push(rest.text);
      result.sourceDocuments.push({
        ...rest,
        score: this.distanceToSimilarity(item._distance),
      });
      result.scores.push(this.distanceToSimilarity(item._distance));
    });

    if (trace)
      trace.final = {
        count: result.sourceDocuments.length,
        docs: result.sourceDocuments.map((d, i) => ({
          finalRank: i + 1,
          ...SearchTrace.docRef(d),
          similarity: SearchTrace.round(d.score),
        })),
      };

    return result;
  }

  /**
   * Resolves the hybrid-search knobs from SystemSettings with hard fallbacks.
   * Kept here (not inline) so hybrid + hybrid_rerank read identical config.
   * @returns {Promise<{hybridWeight:number, retrievalTopK:number, armSplit:number, instruction:string}>}
   */
  async hybridSettings() {
    const splitClamp = SystemSettings.hybridArmSplitClamp;
    // Independent reads — fetch in parallel, this sits on the per-message
    // retrieval hot path.
    const [rawWeight, rawTopK, rawSplit, instruction] = await Promise.all([
      SystemSettings.getValueOrFallback({ label: "hybrid_weight" }, 0.7),
      SystemSettings.getValueOrFallback({ label: "reranker_retrieval_topk" }, 40),
      SystemSettings.getValueOrFallback(
        { label: "hybrid_arm_split" },
        splitClamp.DEFAULT
      ),
      SystemSettings.getValueOrFallback({ label: "reranker_instruction" }, ""),
    ]);

    let hybridWeight = parseFloat(rawWeight);
    if (!Number.isFinite(hybridWeight)) hybridWeight = 0.7;
    hybridWeight = Math.min(1, Math.max(0, hybridWeight));

    let retrievalTopK = parseInt(rawTopK, 10);
    if (!Number.isFinite(retrievalTopK)) retrievalTopK = 40;
    // Keep in sync with the systemSettings validator clamp (1..500).
    retrievalTopK = Math.min(500, Math.max(1, retrievalTopK));

    // Vector share of the reranker nomination budget in hybrid_rerank
    // (Qdrant-prefetch-style per-arm quota). 0.5 = neutral halves; raise for
    // semantics-heavy corpora, lower for keyword-heavy ones. Clamp shared
    // with the systemSettings validator via hybridArmSplitClamp.
    let armSplit = parseFloat(rawSplit);
    if (!Number.isFinite(armSplit)) armSplit = splitClamp.DEFAULT;
    armSplit = Math.min(splitClamp.MAX, Math.max(splitClamp.MIN, armSplit));

    return {
      hybridWeight,
      retrievalTopK,
      armSplit,
      instruction: typeof instruction === "string" ? instruction : "",
    };
  }

  /**
   * Weighted Reciprocal-Rank-Fusion of a vector-arm and an FTS-arm by RANK.
   *
   * score(doc) = alpha/(k + rank_vec) + (1 - alpha)/(k + rank_fts), k = 60.
   * alpha is the vector-arm weight (hybrid_weight, default 0.7). A document that
   * appears in only one arm simply omits the other term. Ranks are 1-based on the
   * order returned by each arm (best = rank 1).
   *
   * NOTE: RRF scores are tiny (~0.02) and are NOT comparable to cosine
   * similarity, so the 0.25 similarityThreshold MUST NOT be applied to them.
   * @param {Array<object>} vectorRows - Vector-arm rows (best-first).
   * @param {Array<object>} ftsRows - FTS-arm rows (best-first).
   * @param {number} alpha - Vector-arm weight in [0,1].
   * @param {number} [k=60] - RRF dampening constant.
   * @returns {Array<{row: object, score: number}>} Fused rows, best-first.
   */
  weightedRRF(vectorRows = [], ftsRows = [], alpha = 0.7, k = 60) {
    const fused = new Map(); // id -> { row, score }

    const accumulate = (rows, weight) => {
      rows.forEach((row, i) => {
        const rank = i + 1;
        const contribution = weight / (k + rank);
        const id = row?.id ?? `__norank_${weight}_${i}`;
        if (fused.has(id)) {
          const existing = fused.get(id);
          existing.score += contribution;
        } else {
          fused.set(id, { row, score: contribution });
        }
      });
    };

    accumulate(vectorRows, alpha);
    accumulate(ftsRows, 1 - alpha);

    return Array.from(fused.values()).sort((a, b) => b.score - a.score);
  }

  /**
   * Applies the workspace similarityThreshold to the vector arm BEFORE fusion
   * (same cosine semantics as similarityResponse). Keeps hybrid modes honest
   * for query-mode refusal: if neither a relevant vector hit nor any BM25 hit
   * exists, the fused result is empty. FTS rows are never passed through here —
   * they have no cosine similarity to threshold.
   * @param {Array<object>} vectorRows - Vector-arm rows (with _distance).
   * @param {number} similarityThreshold - Minimum cosine similarity in [0,1].
   * @returns {Array<object>} Rows meeting the threshold, original order.
   */
  thresholdVectorArm(vectorRows = [], similarityThreshold = 0.25) {
    return vectorRows.filter(
      (row) => this.distanceToSimilarity(row._distance) >= similarityThreshold
    );
  }

  /**
   * Performs a Hybrid (dense vector + BM25) search on a LanceDB namespace and
   * fuses the two arms with weighted RRF (KIE-471).
   *
   * Runs two independent queries — a cosine vector search and a BM25 full-text
   * search over the "text" column — then fuses by RANK (see weightedRRF). The
   * emitted score is the fused RRF score. The vector field is stripped. The
   * similarityThreshold filters the VECTOR arm (cosine) before fusion — same
   * semantics as similarityResponse — so query-mode refusal keeps working;
   * BM25-only hits carry no cosine similarity and are deliberately not
   * thresholded, and neither are the (tiny) fused RRF scores.
   * filterIdentifiers / sourceIdentifier / pinned-doc filtering is identical
   * to similarityResponse.
   * @param {Object} params
   * @param {LanceClient} params.client
   * @param {string} params.namespace
   * @param {string} params.query - Plain-text query for BM25.
   * @param {number[]} params.queryVector - Embedding for the vector arm.
   * @param {number} [params.topN=4]
   * @param {number} [params.similarityThreshold=0.25] - Applied to the vector
   *   arm before fusion; NOT applied to FTS hits or RRF scores.
   * @param {string[]} [params.filterIdentifiers=[]]
   * @returns {Promise<{contextTexts:string[], sourceDocuments:object[], scores:number[]}>}
   */
  async hybridSimilarityResponse({
    client,
    namespace,
    query,
    queryVector,
    topN = 4,
    similarityThreshold = 0.25,
    filterIdentifiers = [],
    whereClause = null,
    trace = null,
  }) {
    const collection = await client.openTable(namespace);
    const { hybridWeight, retrievalTopK } = await this.hybridSettings();
    const totalEmbeddings = await this.namespaceCount(namespace);

    const result = {
      contextTexts: [],
      sourceDocuments: [],
      scores: [],
    };

    // Retrieve a candidate pool per arm large enough to fuse meaningfully, but
    // bounded by retrievalTopK and the collection size.
    const armLimit = Math.max(
      topN,
      Math.min(retrievalTopK, totalEmbeddings || retrievalTopK)
    );

    const { vectorRows, ftsRows } = await this.hybridArms({
      collection,
      query,
      queryVector,
      armLimit,
      whereClause,
      trace,
    });

    const fused = this.weightedRRF(
      this.thresholdVectorArm(vectorRows, similarityThreshold),
      ftsRows,
      hybridWeight
    );

    // Trace: Fusion mit Arm-Herkunft je Kandidat (inVector/inFts).
    const vectorIds = trace ? new Set(vectorRows.map((r) => r.id)) : null;
    const ftsIds = trace ? new Set(ftsRows.map((r) => r.id)) : null;
    if (trace) {
      trace.fusion = {
        alpha: hybridWeight,
        armLimit,
        candidates: fused.length,
        top: fused.slice(0, SearchTrace.CAPTURE_TOP_N).map((f, i) => ({
          rank: i + 1,
          ...SearchTrace.docRef(f.row),
          rrf: SearchTrace.round(f.score),
          inVector: vectorIds.has(f.row.id),
          inFts: ftsIds.has(f.row.id),
        })),
      };
    }

    for (const { row, score } of fused) {
      if (result.sourceDocuments.length >= topN) break;
      const { vector: _v, _distance: _d, _score: _s, ...rest } = row;
      if (filterIdentifiers.includes(sourceIdentifier(rest))) {
        this.logger(
          "A source was filtered from context as it's parent document is pinned."
        );
        continue;
      }
      result.contextTexts.push(rest.text);
      // No `score` on the source documents here: raw RRF scores max out at
      // 1/(k+1) ≈ 0.016 and the citation UI would render them as "2% match".
      // Omitting the field triggers the UI's !!score guard (no percentage
      // shown); the fused scores stay available via result.scores.
      result.sourceDocuments.push({ ...rest });
      result.scores.push(score);
    }

    if (trace)
      trace.final = {
        count: result.sourceDocuments.length,
        docs: result.sourceDocuments.map((d, i) => ({
          finalRank: i + 1,
          ...SearchTrace.docRef(d),
          rrf: SearchTrace.round(result.scores[i]),
          inVector: vectorIds.has(d.id),
          inFts: ftsIds.has(d.id),
        })),
      };

    return result;
  }

  /**
   * Runs the two hybrid arms (cosine vector + BM25 FTS) and returns their raw
   * result rows (best-first). Shared by hybrid and hybrid_rerank paths.
   * The FTS arm degrades gracefully to [] if BM25 fails (e.g. empty query).
   * @param {Object} params
   * @param {import('@lancedb/lancedb').Table} params.collection
   * @param {string} params.query
   * @param {number[]} params.queryVector
   * @param {number} params.armLimit - Per-arm retrieval limit.
   * @returns {Promise<{vectorRows: object[], ftsRows: object[]}>}
   */
  async hybridArms({
    collection,
    query,
    queryVector,
    armLimit,
    whereClause = null,
    trace = null,
  }) {
    let vectorError = null;
    const vectorStart = Date.now();
    const vectorRows = await this.filteredQueryRows(
      () =>
        collection
          .query()
          .nearestTo(queryVector)
          .distanceType("cosine")
          .limit(armLimit),
      whereClause
    ).catch((e) => {
      this.logger("hybridArms:vector", e.message);
      vectorError = e.message;
      return [];
    });
    if (trace)
      trace.vectorArm = {
        ms: Date.now() - vectorStart,
        count: vectorRows.length,
        error: vectorError,
        top: SearchTrace.captureRows(vectorRows, "similarity", (r) =>
          this.distanceToSimilarity(r._distance)
        ),
      };

    let ftsRows = [];
    let ftsError = null;
    const ftsStart = Date.now();
    if (typeof query === "string" && query.trim().length > 0) {
      ftsRows = await this.filteredQueryRows(
        () =>
          collection
            .query()
            .fullTextSearch(query, { columns: "text" })
            .limit(armLimit),
        whereClause
      ).catch((e) => {
        this.logger("hybridArms:fts", e.message);
        ftsError = e.message;
        return [];
      });
    }
    if (trace)
      trace.ftsArm = {
        ms: Date.now() - ftsStart,
        count: ftsRows.length,
        error: ftsError,
        top: SearchTrace.captureRows(ftsRows, "bm25", (r) => r._score),
      };

    return { vectorRows, ftsRows };
  }

  /**
   * Hybrid retrieval followed by an external/native reranker (KIE-471).
   *
   * The reranker nomination budget (retrievalTopK) is split between the arms
   * via hybrid_arm_split (default 0.5, Qdrant-prefetch-style quotas whose
   * shares sum to the budget exactly); slots freed by overlap, an
   * under-delivering arm or a failed arm are backfilled from the other arm,
   * so the reranker always receives min(budget, available candidates)
   * documents and no candidate is dropped by RRF order before the reranker
   * has seen it. This mirrors how production hybrid+rerank stacks behave
   * (e.g. Open WebUI's ensemble → cross-encoder): fusion weights must not
   * gate what the reranker may judge, because a weighted RRF cut
   * systematically starves the lower-weighted arm's tail (empirically:
   * BM25-only hits beyond rank ~α·k never reached the reranker).
   * hybridWeight/α therefore only orders the graceful-degradation fallback
   * here; it ranks for real only in the pure `hybrid` mode.
   * If the reranker returns the candidates UNMODIFIED (its
   * graceful-degradation contract on failure), we fall back to the
   * weighted-RRF order so hybrid_rerank never regresses below hybrid.
   * @param {Object} params
   * @param {LanceClient} params.client
   * @param {string} params.namespace
   * @param {string} params.query
   * @param {number[]} params.queryVector
   * @param {number} [params.topN=4]
   * @param {number} [params.similarityThreshold=0.25] - Applied to the vector
   *   arm before fusion (see thresholdVectorArm); NOT applied to FTS hits,
   *   RRF scores or rerank scores.
   * @param {string[]} [params.filterIdentifiers=[]]
   * @returns {Promise<{contextTexts:string[], sourceDocuments:object[], scores:number[]}>}
   */
  async hybridRerankedSimilarityResponse({
    client,
    namespace,
    query,
    queryVector,
    topN = 4,
    similarityThreshold = 0.25,
    filterIdentifiers = [],
    whereClause = null,
    trace = null,
  }) {
    const collection = await client.openTable(namespace);
    const { hybridWeight, retrievalTopK, armSplit, instruction } =
      await this.hybridSettings();
    const totalEmbeddings = await this.namespaceCount(namespace);
    const reranker = getRerankerProviderSelection({ instruction });

    const result = {
      contextTexts: [],
      sourceDocuments: [],
      scores: [],
    };

    // Nomination budget = documents sent to the reranker. At least topN so a
    // tiny budget can still fill the final context. Both arms FETCH the full
    // budget (like plain rerank mode did) so the quota selection below can
    // backfill from either arm when the other under-delivers or fails.
    const budget = Math.max(topN, retrievalTopK);
    const armFetch = Math.min(budget, totalEmbeddings || budget);

    const { vectorRows, ftsRows } = await this.hybridArms({
      collection,
      query,
      queryVector,
      armLimit: armFetch,
      whereClause,
      trace,
    });

    // Fuse for (a) dedupe + candidate pool and (b) a deterministic fallback order.
    const fused = this.weightedRRF(
      this.thresholdVectorArm(vectorRows, similarityThreshold),
      ftsRows,
      hybridWeight
    );

    // Pinned-doc filtering must happen BEFORE quota selection and the
    // reranker call: the reranker slices to topN, so filtering afterwards
    // could drain the final context below topN with no way to backfill —
    // and a pinned doc must not consume a nomination slot either.
    const notPinned = (docLike) => {
      if (!filterIdentifiers.includes(sourceIdentifier(docLike))) return true;
      this.logger(
        "A source was filtered from context as it's parent document is pinned."
      );
      return false;
    };
    const eligibleFused = fused.filter(({ row }) => notPinned(row));

    // Quota selection (Qdrant-prefetch-style): the vector arm nominates its
    // top round(armSplit·budget) hits by its OWN rank, BM25 the remaining
    // slots — the shares sum to the budget exactly, so no candidate is ever
    // dropped by weighted-RRF order before the reranker has judged it.
    // Slots freed by overlap (a doc nominated by both arms), by an arm that
    // under-delivered, or by a failed arm are backfilled from the remaining
    // fused candidates, so the reranker always receives
    // min(budget, eligible candidates) documents. hybridWeight/α only
    // determines the backfill/fallback ORDER, never membership of the quota
    // picks.
    const vectorQuota = Math.round(budget * armSplit);
    const ftsQuota = budget - vectorQuota;
    const nominated = new Set();
    for (const row of vectorRows.filter(notPinned).slice(0, vectorQuota))
      nominated.add(row.id);
    for (const row of ftsRows.filter(notPinned).slice(0, ftsQuota))
      nominated.add(row.id);
    for (const { row } of eligibleFused) {
      if (nominated.size >= budget) break;
      nominated.add(row.id);
    }

    // Trace: Fusion mit Arm-Herkunft (inVector/inFts) je Kandidat.
    const vectorIds = trace ? new Set(vectorRows.map((r) => r.id)) : null;
    const ftsIds = trace ? new Set(ftsRows.map((r) => r.id)) : null;
    if (trace)
      trace.fusion = {
        alpha: hybridWeight,
        armSplit,
        budget,
        vectorQuota,
        ftsQuota,
        candidates: fused.length,
        top: fused.slice(0, SearchTrace.CAPTURE_TOP_N).map((f, i) => ({
          rank: i + 1,
          ...SearchTrace.docRef(f.row),
          rrf: SearchTrace.round(f.score),
          inVector: vectorIds.has(f.row.id),
          inFts: ftsIds.has(f.row.id),
        })),
      };
    if (fused.length === 0) return result;

    // Build the reranker candidate list in RRF order (deterministic fallback
    // order), stripping the raw vector so we never leak embeddings into the
    // reranker payload or the final sources. By construction |nominated| ≤
    // budget, so the slice is a pure safety clamp.
    const candidates = eligibleFused
      .filter(({ row }) => nominated.has(row.id))
      .map(({ row, score }) => {
        const { vector: _v, _distance: _d, _score: _s, ...rest } = row;
        return { ...rest, rrf_score: score };
      })
      .slice(0, budget);
    if (candidates.length === 0) return result;

    // RRF-Rang je Kandidat (1-basiert) — Basis für die Shift-Metrik im Trace.
    const rrfRankById = trace
      ? new Map(candidates.map((c, i) => [c.id, i + 1]))
      : null;

    let ordered = candidates;
    const rerankStart = Date.now();
    await reranker
      .rerank(query, candidates, { topK: topN })
      .then((rerankResults) => {
        if (Array.isArray(rerankResults) && rerankResults.length > 0)
          ordered = rerankResults;
      })
      .catch((e) => {
        // Belt-and-suspenders: the reranker contract is non-throwing, but if a
        // provider ever violates it we still degrade to the RRF order.
        this.logger("hybridRerankedSimilarityResponse", e.message);
        ordered = candidates.slice(0, topN);
      });
    const rerankMs = Date.now() - rerankStart;

    for (const item of ordered) {
      if (result.sourceDocuments.length >= topN) break;
      const { rrf_score, rerank_score, rerank_corpus_id, ...rest } = item;
      const score = typeof rerank_score === "number" ? rerank_score : rrf_score;
      result.contextTexts.push(rest.text);
      // Only real reranker relevance scores ([0,1]) are meaningful in the
      // citation UI; on RRF fallback the tiny fused score is omitted so the
      // UI's !!score guard hides the misleading "2% match" percentage.
      result.sourceDocuments.push({
        ...rest,
        ...(typeof rerank_score === "number" ? { score: rerank_score } : {}),
      });
      result.scores.push(score);
    }

    if (trace) {
      // Degradation erkennbar am fehlenden rerank_score (Graceful-Fallback
      // des Rerankers liefert die Kandidaten unverändert zurück).
      const degraded = !ordered.some(
        (item) => typeof item.rerank_score === "number"
      );
      trace.rerank = {
        provider: process.env.RERANKER_PROVIDER || "native",
        model: process.env.RERANKER_MODEL_PREF || null,
        ms: rerankMs,
        sent: candidates.length,
        returned: ordered.length,
        degraded,
      };
      // Finale Dokumente mit voller Herkunft: Rerank-Score, RRF-Rang →
      // Final-Rang (shift > 0 = vom Reranker nach oben geholt), Arm-Herkunft.
      trace.final = {
        count: result.sourceDocuments.length,
        docs: result.sourceDocuments.map((d, i) => {
          const rrfRank = rrfRankById.get(d.id) ?? null;
          return {
            finalRank: i + 1,
            ...SearchTrace.docRef(d),
            rerankScore: SearchTrace.round(
              typeof d.score === "number" ? d.score : null
            ),
            rrfRank,
            shift: rrfRank !== null ? rrfRank - (i + 1) : null,
            inVector: vectorIds.has(d.id),
            inFts: ftsIds.has(d.id),
          };
        }),
      };
    }

    return result;
  }

  /**
   *
   * @param {LanceClient} client
   * @param {string} namespace
   * @returns
   */
  async namespace(client, namespace = null) {
    if (!namespace) throw new Error("No namespace value provided.");
    const collection = await client.openTable(namespace).catch(() => false);
    if (!collection) return null;

    return {
      ...collection,
    };
  }

  /**
   * Ensures a full-text-search (BM25) index exists on the "text" column of a
   * collection so hybrid/hybrid_rerank modes can run BM25 queries (KIE-471).
   *
   * This is idempotent: if an FTS index already covers "text" we do nothing.
   * The index uses the shared n-gram tokenizer config (see ftsConfig.js for
   * the empirical rationale: German compounds + inflection, KIE-478).
   *
   * NOTE: a table WITHOUT this index cannot serve fullTextSearch at all —
   * lancedb throws "Column text has no inverted index" and hybridArms
   * degrades that query to vector-only. The flat-scan fallback only covers
   * rows added AFTER index creation that optimize() has not folded in yet
   * (see optimizeFtsIfStale).
   *
   * Failures are swallowed (logged) so indexing problems never break ingestion
   * or the default/vector path.
   * @param {import('@lancedb/lancedb').Table} collection - An open LanceDB table.
   * @returns {Promise<boolean>} true if the index exists/was created.
   */
  async ensureFullTextIndex(collection) {
    try {
      if (!collection || typeof collection.listIndices !== "function")
        return false;
      const indices = await collection.listIndices();
      const hasTextIndex = (indices || []).some((index) =>
        (index?.columns || []).includes("text")
      );
      if (hasTextIndex) return true;

      await collection.createIndex("text", {
        config: lancedb.Index.fts(FTS_INDEX_CONFIG),
        replace: false,
      });
      this.logger("Created FTS index on 'text' column (n-gram tokenizer).");
      return true;
    } catch (e) {
      this.logger("ensureFullTextIndex", e.message);
      return false;
    }
  }

  /**
   * Folds newly added rows into the FTS index once the unindexed remainder
   * exceeds a small threshold. Rows added after index creation stay findable
   * via flat-scan (correctness is never at risk), but without optimize() the
   * unindexed remainder grows monotonically with every (hourly) re-ingestion
   * and BM25 gradually degrades to a brute-force scan. The threshold keeps
   * per-document ingestion cheap while bounding the flat-scan cost.
   *
   * Failures are swallowed (logged) — same contract as ensureFullTextIndex.
   * @param {import('@lancedb/lancedb').Table} collection - An open LanceDB table.
   * @param {number} [threshold=100] - Unindexed-row count that triggers optimize().
   * @returns {Promise<void>}
   */
  async optimizeFtsIfStale(collection, threshold = 100) {
    try {
      const stats = await collection.indexStats("text_idx");
      const unindexed = stats?.numUnindexedRows ?? 0;
      if (unindexed < threshold) return;
      await collection.optimize();
      this.logger(
        `Optimized FTS index (${unindexed} unindexed rows folded in).`
      );
    } catch (e) {
      this.logger("optimizeFtsIfStale", e.message);
    }
  }

  /**
   * Infers a DataFusion SQL type for a generic (non-course) field from the
   * first non-null value in the batch. Returns null when no value allows a
   * safe inference — the field is then skipped by the schema migration.
   * @param {object[]} data - Row batch about to be added.
   * @param {string} fieldName
   * @returns {string|null}
   */
  inferSqlTypeForField(data = [], fieldName) {
    for (const row of data) {
      const value = row?.[fieldName];
      if (value === null || value === undefined) continue;
      if (typeof value === "string") return "STRING";
      if (typeof value === "number") return "DOUBLE";
      if (typeof value === "boolean") return "BOOLEAN";
      return null; // arrays/objects: never auto-migrated
    }
    return null;
  }

  /**
   * Aligns an incoming row batch with the table schema before add() —
   * LanceDB requires schema equality (KIE-480 auto-migration, "Weg 2"):
   *   1. Columns the DATA carries but the TABLE lacks are added via
   *      addColumns() with typed NULL defaults (existing rows get null),
   *      so workspaces ingested before the metadata columns existed migrate
   *      in place — no re-embedding required.
   *   2. Fields the TABLE has but a ROW lacks are null-filled (e.g. info
   *      pages without course metadata in a course workspace).
   * Failures are swallowed (logged) and the original batch is returned —
   * add() then surfaces any real problem itself.
   * @param {import('@lancedb/lancedb').Table} collection - Open table.
   * @param {object[]} data - Row batch about to be added.
   * @returns {Promise<object[]>} Schema-aligned row batch.
   */
  async alignSchemaForAdd(collection, data = []) {
    try {
      if (!collection || typeof collection.schema !== "function") return data;
      const schema = await collection.schema();
      const existing = new Set(schema.fields.map((field) => field.name));
      const incoming = new Set();
      for (const row of data)
        for (const key of Object.keys(row || {})) incoming.add(key);

      const missingInTable = [...incoming].filter((key) => !existing.has(key));
      if (missingInTable.length > 0) {
        const additions = missingInTable
          .map((name) => {
            const sqlType =
              COURSE_COLUMN_SQL_TYPES[name] ||
              this.inferSqlTypeForField(data, name);
            return sqlType
              ? { name, valueSql: `CAST(NULL AS ${sqlType})` }
              : null;
          })
          .filter(Boolean);
        if (additions.length > 0) {
          await collection.addColumns(additions);
          this.logger(
            `Schema migration: added column(s) ${additions
              .map((a) => a.name)
              .join(", ")} to existing collection.`
          );
        }
      }

      const finalSchema = await collection.schema();
      // Boolean columns are filled with `false` instead of null: apache-arrow
      // JS serializes an all-null Boolean vector with an empty data buffer
      // that lance rejects ("Need at least 1 bytes for bitmap"), and for our
      // hard-constraint filters false and null are equivalent (a
      // `bookable = true` filter excludes both).
      const fillValues = finalSchema.fields.map((field) => ({
        name: field.name,
        fill: String(field.type).toLowerCase().includes("bool") ? false : null,
      }));
      return data.map((row) => {
        const filled = { ...row };
        for (const { name, fill } of fillValues)
          if (!(name in filled)) filled[name] = fill;
        return filled;
      });
    } catch (e) {
      this.logger("alignSchemaForAdd", e.message);
      return data;
    }
  }

  /**
   *
   * @param {LanceClient} client
   * @param {number[]} data
   * @param {string} namespace
   * @returns
   */
  async updateOrCreateCollection(client, data = [], namespace) {
    const hasNamespace = await this.hasNamespace(namespace);
    if (hasNamespace) {
      const collection = await client.openTable(namespace);
      const aligned = await this.alignSchemaForAdd(collection, data);
      await collection.add(aligned);
      await this.ensureFullTextIndex(collection);
      await this.optimizeFtsIfStale(collection);
      return true;
    }

    const collection = await client.createTable(namespace, data);
    await this.ensureFullTextIndex(collection);
    return true;
  }

  async hasNamespace(namespace = null) {
    if (!namespace) return false;
    const { client } = await this.connect();
    const exists = await this.namespaceExists(client, namespace);
    return exists;
  }

  /**
   *
   * @param {LanceClient} client
   * @param {string} namespace
   * @returns
   */
  async namespaceExists(client, namespace = null) {
    if (!namespace) throw new Error("No namespace value provided.");
    const collections = await client.tableNames();
    return collections.includes(namespace);
  }

  /**
   *
   * @param {LanceClient} client
   * @param {string} namespace
   * @returns
   */
  async deleteVectorsInNamespace(client, namespace = null) {
    await client.dropTable(namespace);
    return true;
  }

  async deleteDocumentFromNamespace(namespace, docId) {
    const { client } = await this.connect();
    const exists = await this.namespaceExists(client, namespace);
    if (!exists) {
      this.logger(
        `deleteDocumentFromNamespace - namespace ${namespace} does not exist.`
      );
      return;
    }

    const { DocumentVectors } = require("../../../models/vectors");
    const table = await client.openTable(namespace);
    const vectorIds = (await DocumentVectors.where({ docId })).map(
      (record) => record.vectorId
    );

    if (vectorIds.length === 0) return;
    await table.delete(`id IN (${vectorIds.map((v) => `'${v}'`).join(",")})`);
    return true;
  }

  async deleteBatchFromNamespace(namespace, vectorIds = []) {
    if (!vectorIds || vectorIds.length === 0) {
      console.log("LanceDB:deleteBatchFromNamespace - No vectorIds provided");
      return true;
    }

    const { client } = await this.connect();
    const exists = await this.namespaceExists(client, namespace);
    if (!exists) {
      console.error(
        `LanceDB:deleteBatchFromNamespace - namespace ${namespace} does not exist.`
      );
      return true;
    }

    const table = await client.openTable(namespace);

    // Delete all vectors in a single transaction
    // This is much faster than individual deletions and prevents commit conflicts
    const idList = vectorIds.map((v) => `'${v}'`).join(",");
    console.log(
      `LanceDB:deleteBatchFromNamespace - Deleting ${vectorIds.length} vectors from ${namespace}`
    );

    await table.delete(`id IN (${idList})`);
    return true;
  }

  async addDocumentToNamespace(
    namespace,
    documentData = {},
    fullFilePath = null,
    skipCache = false
  ) {
    const { DocumentVectors } = require("../../../models/vectors");
    try {
      const { pageContent, docId, ...metadata } = documentData;
      if (!pageContent || pageContent.length == 0) return false;

      this.logger("Adding new vectorized document into namespace", namespace);
      if (!skipCache) {
        const cacheResult = await cachedVectorInformation(fullFilePath);
        if (cacheResult.exists) {
          const { client } = await this.connect();
          const { chunks } = cacheResult;
          const documentVectors = [];
          const submissions = [];

          for (const chunk of chunks) {
            chunk.forEach((chunk) => {
              const id = uuidv4();
              const { id: _id, ...metadata } = chunk.metadata;
              documentVectors.push({ docId, vectorId: id });
              submissions.push({ id: id, vector: chunk.values, ...metadata });
            });
          }

          await this.updateOrCreateCollection(client, submissions, namespace);
          await DocumentVectors.bulkInsert(documentVectors);
          return { vectorized: true, error: null };
        }
      }

      // If we are here then we are going to embed and store a novel document.
      // We have to do this manually as opposed to using LangChains `xyz.fromDocuments`
      // because we then cannot atomically control our namespace to granularly find/remove documents
      // from vectordb.
      const EmbedderEngine = getEmbeddingEngineSelection();
      const textSplitter = new TextSplitter({
        chunkSize: TextSplitter.determineMaxChunkSize(
          await SystemSettings.getValueOrFallback({
            label: "text_splitter_chunk_size",
          }),
          EmbedderEngine?.embeddingMaxChunkLength
        ),
        chunkOverlap: await SystemSettings.getValueOrFallback(
          { label: "text_splitter_chunk_overlap" },
          20
        ),
        chunkHeaderMeta: TextSplitter.buildHeaderMeta(metadata),
        chunkPrefix: EmbedderEngine?.embeddingPrefix,
      });
      const textChunks = await textSplitter.splitText(pageContent);

      this.logger("Snippets created from document:", textChunks.length);
      const documentVectors = [];
      const vectors = [];
      const submissions = [];
      const vectorValues = await EmbedderEngine.embedChunks(textChunks);

      if (!!vectorValues && vectorValues.length > 0) {
        for (const [i, vector] of vectorValues.entries()) {
          const vectorRecord = {
            id: uuidv4(),
            values: vector,
            // [DO NOT REMOVE]
            // LangChain will be unable to find your text if you embed manually and dont include the `text` key.
            // https://github.com/hwchase17/langchainjs/blob/2def486af734c0ca87285a48f1a04c057ab74bdf/langchain/src/vectorstores/pinecone.ts#L64
            metadata: { ...metadata, text: textChunks[i] },
          };

          vectors.push(vectorRecord);
          submissions.push({
            ...vectorRecord.metadata,
            id: vectorRecord.id,
            vector: vectorRecord.values,
          });
          documentVectors.push({ docId, vectorId: vectorRecord.id });
        }
      } else {
        throw new Error(
          "Could not embed document chunks! This document will not be recorded."
        );
      }

      if (vectors.length > 0) {
        const chunks = [];
        for (const chunk of toChunks(vectors, 500)) chunks.push(chunk);

        this.logger("Inserting vectorized chunks into LanceDB collection.");
        const { client } = await this.connect();
        await this.updateOrCreateCollection(client, submissions, namespace);
        await storeVectorResult(chunks, fullFilePath);
      }

      await DocumentVectors.bulkInsert(documentVectors);
      return { vectorized: true, error: null };
    } catch (e) {
      this.logger("addDocumentToNamespace", e.message);
      return { vectorized: false, error: e.message };
    }
  }

  /**
   * Performs a similarity search on a namespace, dispatching by search mode.
   *
   * Modes (KIE-471):
   *   - "default"       : pure cosine vector search (unchanged behavior).
   *   - "rerank"        : vector search -> external/native reranker.
   *   - "hybrid"        : weighted-RRF fusion of vector + BM25.
   *   - "hybrid_rerank" : union of both arms -> external/native reranker.
   *
   * The legacy boolean `rerank` param is accepted as a DEPRECATED alias for
   * searchMode "rerank" (kept for one release while call-sites migrate).
   * @param {Object} params
   * @param {string} params.namespace
   * @param {string} params.input - Plain-text query.
   * @param {object} params.LLMConnector
   * @param {number} [params.similarityThreshold=0.25]
   * @param {number} [params.topN=4]
   * @param {string[]} [params.filterIdentifiers=[]]
   * @param {("default"|"rerank"|"hybrid"|"hybrid_rerank")} [params.searchMode]
   * @param {boolean} [params.rerank=false] - Deprecated alias for searchMode "rerank".
   * @param {object|null} [params.filters=null] - Hard-constraint metadata
   *   filters (KIE-480), validated via sanitizeSearchFilters and applied as
   *   a .where() prefilter in ALL modes. Invalid fields are dropped; legacy
   *   tables without the metadata columns fall back to unfiltered queries.
   * @returns {Promise<{contextTexts:string[], sources:object[], message:(string|false)}>}
   */
  async performSimilaritySearch({
    namespace = null,
    input = "",
    LLMConnector = null,
    similarityThreshold = 0.25,
    topN = 4,
    filterIdentifiers = [],
    searchMode = null,
    rerank = false,
    filters = null,
  }) {
    if (!namespace || !input || !LLMConnector)
      throw new Error("Invalid request to performSimilaritySearch.");

    const { client } = await this.connect();
    if (!(await this.namespaceExists(client, namespace))) {
      return {
        contextTexts: [],
        sources: [],
        message: "Invalid query - no documents found for workspace!",
      };
    }

    // Resolve the effective mode. Explicit searchMode wins; otherwise the
    // deprecated boolean `rerank` maps to "rerank"; else "default".
    const validModes = ["default", "rerank", "hybrid", "hybrid_rerank"];
    let mode = validModes.includes(searchMode)
      ? searchMode
      : rerank === true
        ? "rerank"
        : "default";

    // KIE-480: resolve the metadata filters. Explicit `filters` from the
    // caller win; otherwise — when the metadata_filters SystemSetting is
    // "on" — the deterministic German extractor derives them from the
    // (already rewritten) query. Off/invalid compiles to null clause
    // (= today's unfiltered behavior).
    let activeFilters = sanitizeSearchFilters(filters);
    if (!activeFilters) {
      try {
        const enabled = await SystemSettings.getValueOrFallback(
          { label: "metadata_filters" },
          "off"
        );
        if (enabled === "on") {
          const locationSetting = await SystemSettings.getValueOrFallback(
            { label: "metadata_filter_locations" },
            ""
          );
          const knownLocations = String(locationSetting || "")
            .split(",")
            .map((loc) => loc.trim())
            .filter(Boolean);
          activeFilters = sanitizeSearchFilters(
            extractFilters(input, { referenceDate: new Date(), knownLocations })
          );
        }
      } catch (e) {
        this.logger("metadata_filters resolution failed", e.message);
      }
    }

    // Search-Trace (Opt-in via SystemSetting search_trace): vollständige
    // Hybrid-/Reranker-Metriken pro Suche als JSONL — siehe searchTrace.js.
    const traceLevel = await SearchTrace.resolveTraceLevel();
    const trace =
      traceLevel === "off"
        ? null
        : SearchTrace.beginTrace({
            namespace,
            mode,
            query: input,
            level: traceLevel,
          });
    const traceStart = Date.now();

    const queryVector = await LLMConnector.embedTextInput(input);
    const runSearch = async (whereClause, relaxStage = 0) => {
      if (trace) {
        trace.relaxStage = relaxStage;
        trace.whereClause = whereClause || null;
      }
      switch (mode) {
        case "rerank":
          return await this.rerankedSimilarityResponse({
            client,
            namespace,
            query: input,
            queryVector,
            similarityThreshold,
            topN,
            filterIdentifiers,
            whereClause,
            trace,
          });
        case "hybrid":
          return await this.hybridSimilarityResponse({
            client,
            namespace,
            query: input,
            queryVector,
            similarityThreshold,
            topN,
            filterIdentifiers,
            whereClause,
            trace,
          });
        case "hybrid_rerank":
          return await this.hybridRerankedSimilarityResponse({
            client,
            namespace,
            query: input,
            queryVector,
            similarityThreshold,
            topN,
            filterIdentifiers,
            whereClause,
            trace,
          });
        default:
          return await this.similarityResponse({
            client,
            namespace,
            queryVector,
            similarityThreshold,
            topN,
            filterIdentifiers,
            whereClause,
            trace,
          });
      }
    };

    // Staged empty-result fallback (KIE-480): (1) full filters, (2) without
    // the time constraints ("nichts in diesem Quartal — aber ab Oktober…"),
    // (3) unfiltered. When we relax, the LLM gets an explicit German note so
    // the answer stays transparent instead of silently ignoring the ask.
    // Bei Relax spiegeln die Arm-/Fusion-Felder im Trace den ZULETZT
    // ausgeführten Suchlauf (dessen Ergebnis der Nutzer bekam); relaxStage
    // dokumentiert die Stufe.
    let result = await runSearch(filtersToWhere(activeFilters), 0);
    let relaxNote = null;
    if (activeFilters && result.sourceDocuments.length === 0) {
      const withoutTime = sanitizeSearchFilters(stripTimeFilters(activeFilters));
      const hadTime = filtersToWhere(withoutTime) !== filtersToWhere(activeFilters);
      if (hadTime) {
        result = await runSearch(filtersToWhere(withoutTime), 1);
        if (result.sourceDocuments.length > 0)
          relaxNote =
            "[Hinweis an den Assistenten: Für den angefragten Zeitraum wurden KEINE passenden Kurse gefunden. Die folgenden Treffer erfüllen die übrigen Kriterien, liegen aber außerhalb des angefragten Zeitraums — weise die Nutzerin/den Nutzer transparent darauf hin und nenne die tatsächlichen Termine.]";
      }
      if (result.sourceDocuments.length === 0) {
        result = await runSearch(null, 2);
        if (result.sourceDocuments.length > 0)
          relaxNote =
            "[Hinweis an den Assistenten: Für die angefragten Kriterien (z. B. Zeitraum, Preis, Ort oder Verfügbarkeit) wurden KEINE passenden Kurse gefunden. Die folgenden Treffer sind thematisch ähnlich, erfüllen die Kriterien aber NICHT — sage das der Nutzerin/dem Nutzer klar und nenne die tatsächlichen Konditionen.]";
      }
      if (relaxNote)
        this.logger(
          "metadata_filters: empty result — relaxed filters, note injected."
        );
    }

    if (trace) {
      trace.totalMs = Date.now() - traceStart;
      trace.relaxed = relaxNote !== null;
      SearchTrace.writeTrace(trace);
    }

    const { contextTexts, sourceDocuments } = result;
    const sources = sourceDocuments.map((metadata, i) => {
      return { metadata: { ...metadata, text: contextTexts[i] } };
    });
    return {
      // The relax note goes to the LLM context ONLY — after the sources
      // mapping above, so contextTexts[i] <-> sourceDocuments[i] stays
      // aligned and no citation is fabricated for the note.
      contextTexts: relaxNote ? [relaxNote, ...contextTexts] : contextTexts,
      sources: this.curateSources(sources),
      message: false,
    };
  }

  async "namespace-stats"(reqBody = {}) {
    const { namespace = null } = reqBody;
    if (!namespace) throw new Error("namespace required");
    const { client } = await this.connect();
    if (!(await this.namespaceExists(client, namespace)))
      throw new Error("Namespace by that name does not exist.");
    const stats = await this.namespace(client, namespace);
    return stats
      ? stats
      : { message: "No stats were able to be fetched from DB for namespace" };
  }

  async "delete-namespace"(reqBody = {}) {
    const { namespace = null } = reqBody;
    const { client } = await this.connect();
    if (!(await this.namespaceExists(client, namespace)))
      throw new Error("Namespace by that name does not exist.");

    await this.deleteVectorsInNamespace(client, namespace);
    return {
      message: `Namespace ${namespace} was deleted.`,
    };
  }

  async reset() {
    const { client } = await this.connect();
    const fs = require("fs");
    fs.rm(`${client.uri}`, { recursive: true }, () => null);
    return { reset: true };
  }

  curateSources(sources = []) {
    const documents = [];
    for (const source of sources) {
      const { text, vector: _v, _distance: _d, ...rest } = source;
      const metadata = rest.hasOwnProperty("metadata") ? rest.metadata : rest;
      if (Object.keys(metadata).length > 0) {
        documents.push({
          ...metadata,
          ...(text ? { text } : {}),
        });
      }
    }

    return documents;
  }
}

module.exports.LanceDb = LanceDb;
