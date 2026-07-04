/**
 * GenericReranker — an HTTP client for external/self-hosted reranking services.
 *
 * This class implements the SAME public interface as NativeEmbeddingReranker
 * (see ../native/index.js):
 *   rerank(query, documents: {text: string}[], { topK }) ->
 *     Promise<Array<{...doc, rerank_score: number}>> sorted desc + sliced to topK.
 *
 * It is used by the hybrid-search / rerank vector-search modes (KIE-471) when
 * the global env var RERANKER_PROVIDER is set. When it is unset, the system
 * uses the NativeEmbeddingReranker and this class is never instantiated.
 *
 * Supported wire formats (selected via RERANKER_PROVIDER):
 *   - "cohere": Cohere-compatible /rerank or /v1/rerank endpoints. This covers
 *     LiteLLM, vLLM, Cohere, Jina, Infinity and Voyage. Request body:
 *       { model, query, documents: string[], top_n }
 *     (Voyage uses `top_k` instead of `top_n` — controlled via `topKField`.)
 *     Response body: { results: [{ index, relevance_score }, ...] }
 *   - "tei": HuggingFace Text-Embeddings-Inference /rerank. Request body:
 *       { query, texts: string[], raw_scores: false }
 *     Response body: BARE ARRAY [{ index, score }, ...] (no `results` wrapper,
 *     `score` not `relevance_score`, and NO `model` field in the request).
 *
 * GRACEFUL DEGRADATION: any failure (timeout, non-200, malformed body) returns
 * the input `documents` UNMODIFIED (preserving upstream vector/RRF order) with
 * a warning logged. This method NEVER throws into the RAG path.
 */
class GenericReranker {
  /**
   * @param {object} config
   * @param {string} [config.provider] - Wire format: "cohere" (default) or "tei".
   *   Defaults to process.env.RERANKER_PROVIDER.
   * @param {string} [config.basePath] - Base URL of the reranker endpoint.
   *   Defaults to process.env.RERANKER_BASE_PATH.
   * @param {string} [config.model] - Model preference passed to the service
   *   (ignored by TEI). Defaults to process.env.RERANKER_MODEL_PREF.
   * @param {string} [config.apiKey] - Bearer token. Defaults to
   *   process.env.RERANKER_API_KEY.
   * @param {string} [config.instruction] - Optional instruction prepended to
   *   the query. Defaults to the reranker_instruction SystemSetting (resolved
   *   lazily by the caller and passed in) — here it defaults to "".
   * @param {number} [config.timeoutMs] - Abort timeout in ms. Defaults to the
   *   RERANKER_TIMEOUT_MS env value, or 8000 when unset.
   */
  constructor(config = {}) {
    this.provider = (
      config.provider ||
      process.env.RERANKER_PROVIDER ||
      "cohere"
    )
      .toString()
      .toLowerCase();
    this.basePath = config.basePath || process.env.RERANKER_BASE_PATH || null;
    this.model = config.model || process.env.RERANKER_MODEL_PREF || null;
    this.apiKey = config.apiKey || process.env.RERANKER_API_KEY || null;
    this.instruction =
      typeof config.instruction === "string" ? config.instruction : "";
    const envTimeoutMs = Number(process.env.RERANKER_TIMEOUT_MS);
    this.timeoutMs =
      Number.isFinite(config.timeoutMs) && config.timeoutMs > 0
        ? config.timeoutMs
        : Number.isFinite(envTimeoutMs) && envTimeoutMs > 0
          ? envTimeoutMs
          : 8000;

    // Voyage uses `top_k` rather than `top_n` in the Cohere-style body.
    // Detected by base path or explicit config flag.
    this.topKField =
      config.topKField ||
      (this.basePath && /voyage/i.test(this.basePath) ? "top_k" : "top_n");

    this.log("Initialized", {
      provider: this.provider,
      basePath: this.basePath,
      model: this.model,
      hasApiKey: !!this.apiKey,
    });
  }

  log(text, ...args) {
    console.log(`\x1b[36m[GenericReranker]\x1b[0m ${text}`, ...args);
  }

  warn(text, ...args) {
    console.warn(`\x1b[33m[GenericReranker]\x1b[0m ${text}`, ...args);
  }

  /**
   * Builds the request URL, honoring an explicit path in basePath or appending
   * the conventional endpoint segment for the selected provider.
   * @returns {string|null}
   */
  #endpoint() {
    if (!this.basePath) return null;
    const trimmed = this.basePath.replace(/\/+$/, "");
    // If the user already pointed at a concrete rerank path, respect it.
    if (/\/(v1\/)?rerank$/i.test(trimmed)) return trimmed;
    return `${trimmed}/rerank`;
  }

  /**
   * Applies the optional instruction to the query text.
   * @param {string} query
   * @returns {string}
   */
  #decoratedQuery(query) {
    if (this.instruction && this.instruction.length > 0)
      return `${this.instruction}\n\n${query}`;
    return query;
  }

  /**
   * Encodes the request body for the selected wire format.
   * @param {string} query
   * @param {string[]} texts
   * @param {number} topK
   * @returns {object}
   */
  #encodeBody(query, texts, topK) {
    const decorated = this.#decoratedQuery(query);
    if (this.provider === "tei") {
      // TEI: bare-array response, no model field, `texts`, `raw_scores:false`.
      const body = { query: decorated, texts, raw_scores: false };
      if (this.instruction && this.instruction.length > 0)
        body.instruction = this.instruction;
      return body;
    }

    // Cohere-compatible (default). Voyage swaps top_n -> top_k.
    const body = {
      query: decorated,
      documents: texts,
      [this.topKField]: topK,
    };
    if (this.model) body.model = this.model;
    if (this.instruction && this.instruction.length > 0)
      body.instruction = this.instruction;
    return body;
  }

  /**
   * Parses the response body into a normalized [{ index, score }] array.
   * Maps scores back by the service-provided `index`, NEVER by position.
   * @param {any} json
   * @returns {{index: number, score: number}[]|null} null if unparseable.
   */
  #parseResponse(json) {
    // TEI: bare array of { index, score }.
    if (Array.isArray(json)) {
      const out = [];
      for (const row of json) {
        if (!row || typeof row.index !== "number") return null;
        out.push({ index: row.index, score: Number(row.score) });
      }
      return out;
    }

    // Cohere-compatible: { results: [{ index, relevance_score }] }.
    if (json && Array.isArray(json.results)) {
      const out = [];
      for (const row of json.results) {
        if (!row || typeof row.index !== "number") return null;
        const score =
          row.relevance_score !== undefined ? row.relevance_score : row.score; // tolerate services that use `score`
        out.push({ index: row.index, score: Number(score) });
      }
      return out;
    }

    return null;
  }

  /**
   * Reranks documents against the query via the external service.
   * On ANY failure, returns the input documents UNMODIFIED (never throws).
   * @param {string} query
   * @param {{text: string}[]} documents - Output from a vector/hybrid search.
   * @param {object} options
   * @param {number} [options.topK=4]
   * @returns {Promise<Array<{text: string, rerank_score?: number}>>}
   */
  async rerank(query, documents, options = { topK: 4 }) {
    const topK = Number.isFinite(options?.topK) ? options.topK : 4;

    if (!Array.isArray(documents) || documents.length === 0) return [];
    const endpoint = this.#endpoint();
    if (!endpoint) {
      this.warn(
        "No RERANKER_BASE_PATH configured; returning documents unmodified."
      );
      return documents.slice(0, topK);
    }

    const texts = documents.map((doc) => (doc && doc.text ? doc.text : ""));
    const body = this.#encodeBody(query, texts, topK);

    const headers = { "Content-Type": "application/json" };
    if (this.apiKey) headers["Authorization"] = `Bearer ${this.apiKey}`;

    const start = Date.now();
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if (!response.ok) {
        this.warn(
          `Reranker returned HTTP ${response.status}; returning documents unmodified.`
        );
        return documents.slice(0, topK);
      }

      const json = await response.json();
      const parsed = this.#parseResponse(json);
      if (!parsed) {
        this.warn(
          "Reranker response was malformed; returning documents unmodified."
        );
        return documents.slice(0, topK);
      }

      const reranked = parsed
        // Guard against out-of-range indices from a misbehaving service.
        .filter((r) => r.index >= 0 && r.index < documents.length)
        .map((r) => ({
          ...documents[r.index],
          rerank_corpus_id: r.index,
          rerank_score: Number.isFinite(r.score) ? r.score : 0,
        }))
        .sort((a, b) => b.rerank_score - a.rerank_score)
        .slice(0, topK);

      // If filtering removed everything (all indices invalid), degrade safely.
      if (reranked.length === 0) {
        this.warn(
          "Reranker returned no usable rows; returning documents unmodified."
        );
        return documents.slice(0, topK);
      }

      this.log(
        `Reranked ${documents.length} documents to top ${topK} via ${this.provider} in ${Date.now() - start}ms`
      );
      return reranked;
    } catch (error) {
      // Timeout (AbortError), network failure, JSON parse error, etc.
      this.warn(
        `Rerank request failed (${error?.name || "Error"}: ${error?.message}); returning documents unmodified.`
      );
      return documents.slice(0, topK);
    }
  }
}

module.exports = {
  GenericReranker,
};
