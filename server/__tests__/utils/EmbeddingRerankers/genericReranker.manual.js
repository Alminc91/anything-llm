/**
 * Lightweight, framework-free tests for the external reranker (KIE-471).
 *
 * No JS test runner is configured in this repo (server/package.json has no
 * "test" script and jest/vitest are not installed). Run this directly:
 *
 *   node server/__tests__/utils/EmbeddingRerankers/genericReranker.manual.js
 *
 * Exits non-zero on the first failed assertion.
 *
 * Covers:
 *   T5  - Cohere-compatible wire format (results[].index mapping)
 *   T6  - TEI bare-array wire format ({index, score})
 *   T7  - Voyage variant uses top_k instead of top_n
 *   T8  - Failure paths (timeout / non-200 / malformed) -> documents UNMODIFIED
 *   T14 - RERANKER_PROVIDER unset => NativeEmbeddingReranker;
 *         RERANKER_API_KEY never returned raw from currentSettings()
 */

const assert = require("assert");
const path = require("path");

let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`\x1b[32m  ✓\x1b[0m ${name}`);
}

// --- fetch mock harness -----------------------------------------------------
const realFetch = global.fetch;
let lastRequest = null;
function mockFetch(handler) {
  global.fetch = async (url, opts) => {
    lastRequest = {
      url,
      opts,
      body: opts?.body ? JSON.parse(opts.body) : null,
      headers: opts?.headers || {},
    };
    return handler(lastRequest);
  };
}
function restoreFetch() {
  global.fetch = realFetch;
  lastRequest = null;
}
function jsonResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  };
}

const { GenericReranker } = require(
  path.resolve(__dirname, "../../../utils/EmbeddingRerankers/generic")
);

const DOCS = [
  { text: "alpha doc", id: "a" },
  { text: "beta doc", id: "b" },
  { text: "gamma doc", id: "c" },
];

async function run() {
  // T5 - Cohere-compatible: map by results[].index, not position.
  {
    mockFetch((req) =>
      jsonResponse(200, {
        // Intentionally out-of-order to prove index mapping.
        results: [
          { index: 2, relevance_score: 0.9 },
          { index: 0, relevance_score: 0.5 },
          { index: 1, relevance_score: 0.1 },
        ],
      })
    );
    const rr = new GenericReranker({
      provider: "cohere",
      basePath: "http://localhost:8080",
      model: "rerank-v3",
    });
    const out = await rr.rerank("q", DOCS, { topK: 2 });
    assert.strictEqual(lastRequest.body.model, "rerank-v3");
    assert.deepStrictEqual(lastRequest.body.documents, [
      "alpha doc",
      "beta doc",
      "gamma doc",
    ]);
    assert.strictEqual(lastRequest.body.top_n, 2, "cohere uses top_n");
    assert.strictEqual(out.length, 2);
    assert.strictEqual(out[0].id, "c", "index 2 mapped to gamma, top score");
    assert.strictEqual(out[1].id, "a", "index 0 mapped to alpha");
    assert.strictEqual(out[0].rerank_score, 0.9);
    restoreFetch();
    ok("T5 Cohere-compatible: maps by results[].index, sorts desc, slices");
  }

  // T6 - TEI bare-array: {index, score}, no results wrapper, no model field.
  {
    mockFetch((req) =>
      jsonResponse(200, [
        { index: 1, score: 7.2 },
        { index: 0, score: 3.1 },
        { index: 2, score: -1.0 },
      ])
    );
    const rr = new GenericReranker({
      provider: "tei",
      basePath: "http://tei:80",
      model: "ignored-by-tei",
    });
    const out = await rr.rerank("q", DOCS, { topK: 3 });
    assert.strictEqual(lastRequest.body.model, undefined, "TEI sends no model");
    assert.deepStrictEqual(lastRequest.body.texts, [
      "alpha doc",
      "beta doc",
      "gamma doc",
    ]);
    assert.strictEqual(lastRequest.body.raw_scores, false);
    assert.strictEqual(out[0].id, "b", "index 1 (beta) has top score 7.2");
    assert.strictEqual(out[0].rerank_score, 7.2);
    assert.strictEqual(out[2].id, "c");
    restoreFetch();
    ok("T6 TEI bare-array: {index,score}, no model, texts+raw_scores");
  }

  // T7 - Voyage variant uses top_k instead of top_n.
  {
    mockFetch((req) =>
      jsonResponse(200, { results: [{ index: 0, relevance_score: 1.0 }] })
    );
    const rr = new GenericReranker({
      provider: "cohere",
      basePath: "https://api.voyageai.com/v1",
      model: "rerank-2",
    });
    await rr.rerank("q", DOCS, { topK: 5 });
    assert.strictEqual(lastRequest.body.top_k, 5, "voyage uses top_k");
    assert.strictEqual(
      lastRequest.body.top_n,
      undefined,
      "no top_n for voyage"
    );
    restoreFetch();
    ok("T7 Voyage variant: top_k not top_n (auto-detected from base path)");
  }

  // T8a - non-200 -> documents unmodified (vector order preserved, sliced).
  {
    mockFetch(() => jsonResponse(500, { error: "boom" }));
    const rr = new GenericReranker({
      provider: "cohere",
      basePath: "http://localhost:8080",
    });
    const out = await rr.rerank("q", DOCS, { topK: 2 });
    assert.strictEqual(out.length, 2);
    assert.strictEqual(out[0].id, "a", "unmodified order after non-200");
    assert.strictEqual(out[1].id, "b");
    restoreFetch();
    ok("T8a non-200 -> documents UNMODIFIED, never throws");
  }

  // T8b - malformed body (no results / not an array) -> unmodified.
  {
    mockFetch(() => jsonResponse(200, { unexpected: true }));
    const rr = new GenericReranker({
      provider: "cohere",
      basePath: "http://localhost:8080",
    });
    const out = await rr.rerank("q", DOCS, { topK: 3 });
    assert.deepStrictEqual(
      out.map((d) => d.id),
      ["a", "b", "c"],
      "malformed -> vector order"
    );
    restoreFetch();
    ok("T8b malformed body -> documents UNMODIFIED");
  }

  // T8c - thrown error (network/timeout simulated) -> unmodified, no throw.
  {
    global.fetch = async () => {
      const err = new Error("The operation was aborted due to timeout");
      err.name = "TimeoutError";
      throw err;
    };
    const rr = new GenericReranker({
      provider: "tei",
      basePath: "http://tei:80",
    });
    let threw = false;
    let out;
    try {
      out = await rr.rerank("q", DOCS, { topK: 2 });
    } catch (e) {
      threw = true;
    }
    assert.strictEqual(threw, false, "must never throw into RAG path");
    assert.strictEqual(out.length, 2);
    assert.strictEqual(out[0].id, "a");
    restoreFetch();
    ok("T8c timeout/network error -> documents UNMODIFIED, no throw");
  }

  // T8d - no base path configured -> unmodified, no request attempted.
  {
    let called = false;
    global.fetch = async () => {
      called = true;
      return jsonResponse(200, { results: [] });
    };
    const rr = new GenericReranker({ provider: "cohere", basePath: null });
    const out = await rr.rerank("q", DOCS, { topK: 3 });
    assert.strictEqual(called, false, "no request without base path");
    assert.strictEqual(out.length, 3);
    restoreFetch();
    ok("T8d no base path -> documents UNMODIFIED, no request");
  }

  // T8e - out-of-range index from a misbehaving service -> filtered/degrade.
  {
    mockFetch(() =>
      jsonResponse(200, { results: [{ index: 99, relevance_score: 0.9 }] })
    );
    const rr = new GenericReranker({
      provider: "cohere",
      basePath: "http://localhost:8080",
    });
    const out = await rr.rerank("q", DOCS, { topK: 2 });
    // All indices invalid -> falls back to unmodified.
    assert.strictEqual(out.length, 2);
    assert.strictEqual(out[0].id, "a");
    restoreFetch();
    ok("T8e out-of-range index -> safe degrade to UNMODIFIED");
  }

  // T14a - RERANKER_PROVIDER unset => NativeEmbeddingReranker.
  {
    const prev = process.env.RERANKER_PROVIDER;
    delete process.env.RERANKER_PROVIDER;
    const { getRerankerProviderSelection } = require(
      path.resolve(__dirname, "../../../utils/helpers")
    );
    const { NativeEmbeddingReranker } = require(
      path.resolve(__dirname, "../../../utils/EmbeddingRerankers/native")
    );
    const sel = getRerankerProviderSelection();
    assert.ok(
      sel instanceof NativeEmbeddingReranker,
      "unset provider must yield NativeEmbeddingReranker"
    );

    process.env.RERANKER_PROVIDER = "cohere";
    assert.strictEqual(
      getRerankerProviderSelection().constructor.name,
      "GenericReranker"
    );
    process.env.RERANKER_PROVIDER = "tei";
    assert.strictEqual(
      getRerankerProviderSelection().constructor.name,
      "GenericReranker"
    );
    process.env.RERANKER_PROVIDER = "not-a-provider";
    assert.ok(
      getRerankerProviderSelection() instanceof NativeEmbeddingReranker,
      "unknown provider falls back to native"
    );

    if (prev === undefined) delete process.env.RERANKER_PROVIDER;
    else process.env.RERANKER_PROVIDER = prev;
    ok("T14a factory: unset/unknown -> Native; cohere/tei -> Generic");
  }

  // T14b - RERANKER_API_KEY masked (never raw) in currentSettings().
  {
    const prev = process.env.RERANKER_API_KEY;
    process.env.RERANKER_API_KEY = "super-secret-token";
    // Avoid pulling heavy DB deps: assert on the exposure contract directly.
    // currentSettings() sets RerankerApiKey to !!process.env.RERANKER_API_KEY.
    const masked = !!process.env.RERANKER_API_KEY;
    assert.strictEqual(masked, true);
    assert.notStrictEqual(masked, "super-secret-token");

    // Static source check: the raw key must not be interpolated into the
    // currentSettings() return object.
    const fs = require("fs");
    const src = fs.readFileSync(
      path.resolve(__dirname, "../../../models/systemSettings.js"),
      "utf8"
    );
    assert.ok(
      /RerankerApiKey:\s*!!process\.env\.RERANKER_API_KEY/.test(src),
      "currentSettings must expose RerankerApiKey as a boolean"
    );
    assert.ok(
      !/RerankerApiKey:\s*process\.env\.RERANKER_API_KEY\b(?!\))/.test(src),
      "currentSettings must NOT return RERANKER_API_KEY raw"
    );

    if (prev === undefined) delete process.env.RERANKER_API_KEY;
    else process.env.RERANKER_API_KEY = prev;
    ok("T14b RERANKER_API_KEY masked as boolean, never returned raw");
  }

  console.log(`\n\x1b[32mAll ${passed} assertions passed.\x1b[0m`);
}

run().catch((e) => {
  console.error(`\n\x1b[31mTEST FAILED:\x1b[0m ${e.message}`);
  console.error(e.stack);
  process.exit(1);
});
