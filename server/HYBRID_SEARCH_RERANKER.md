# Hybrid Search & External Reranker (KIE-471)

Operator guide for the Kufer-fork hybrid search (dense vector + BM25) and the
configurable **external** reranker.

This feature is **additive and per-workspace opt-in**. When `RERANKER_PROVIDER`
is unset and no workspace changes its search mode, behavior is **identical** to
upstream AnythingLLM (pure vector search, optional built-in native reranker).
Nothing here changes existing installs until you explicitly turn it on.

---

## 1. The four search modes

The search mode is resolved per workspace with this precedence (highest first):

`workspace.vectorSearchMode` → SystemSetting `vector_search_default` →
`VECTOR_SEARCH_DEFAULT` env → `"default"`.

Only LanceDB supports hybrid/rerank modes; other vector DBs fall back to pure
vector regardless of the setting.

| Mode | What it does | Reranker used? |
|------|--------------|----------------|
| `default` | Pure dense-vector (cosine) search. Unchanged upstream behavior. | No |
| `rerank` | Vector search, then rerank the candidates. | Yes |
| `hybrid` | Runs a vector arm **and** a BM25 keyword arm, fuses them app-side with weighted Reciprocal Rank Fusion (RRF). | No |
| `hybrid_rerank` **(recommended)** | Union of both arms (up to `reranker_retrieval_topk` candidates), deduped, then the reranker decides the final order. RRF order is used only as a fallback if the reranker fails. | Yes |

**Weighted RRF** (used by `hybrid` and as the `hybrid_rerank` fallback):
`score = alpha/(k + rank_vec) + (1 - alpha)/(k + rank_fts)`, with `k = 60` and
`alpha = hybrid_weight` (default `0.7`, i.e. 70% weight on the vector arm).

> RRF `_relevance_score` values are tiny (~0.02). The `similarityThreshold`
> default (0.25) is deliberately **not** applied to fused RRF scores, so hybrid
> results are not silently dropped.

### Native vs external reranker

`rerank` and `hybrid_rerank` call `getRerankerProviderSelection()`:

- `RERANKER_PROVIDER` **unset** → built-in `NativeEmbeddingReranker`
  (on-device, CPU, mxbai-rerank-xsmall). No network. This is the default.
- `RERANKER_PROVIDER=cohere` or `=tei` → `GenericReranker` (HTTP client to your
  own reranker service).

---

## 2. German-stemming limitation (read this)

On the installed `@lancedb/lancedb` 0.15.0 binary, **the BM25 (FTS) index does
not stem German.** The FTS index is created with `lowercase: true` and
`asciiFolding: true` only:

- `"Kurs"` will **not** match `"Kurse"`, `"Kursen"`, etc. Keyword matching is on
  normalized surface forms, not lemmas.
- ASCII folding does handle umlauts (`Grüße` ≈ `Grüsse`/`Grusse`), and casing is
  normalized.

**Implication:** hybrid mode helps most for exact tokens the embedding model
tends to miss — course numbers (KNR), instructor surnames, dates, acronyms,
literal product names — not for morphological German variants. Do not promise
stemming to customers. If lemmatization becomes a requirement, it needs an
upstream LanceDB version bump or a pre-tokenization step; both are out of scope
for this feature.

---

## 3. Configuration surface

### 3a. Environment variables (GLOBAL, auto-persist)

Set from the admin GUI (**Settings → Search & Retrieval**) — writing them there
persists them via `dumpENV`, so they survive restarts. They can also be seeded
in `server/.env` before first boot.

| Env var | Meaning | Example |
|---------|---------|---------|
| `RERANKER_PROVIDER` | Wire format: `cohere` or `tei`. Unset = native. | `cohere` |
| `RERANKER_BASE_PATH` | Base URL of the reranker service. `/rerank` is appended if you do not already point at a `…/rerank` or `…/v1/rerank` path. | `http://vllm-reranker:8000/v1/rerank` |
| `RERANKER_MODEL_PREF` | Model name sent to the service (ignored by TEI). | `BAAI/bge-reranker-v2-m3` |
| `RERANKER_API_KEY` | Optional bearer token. Leave **empty** for a trusted in-cluster/shared container. | *(empty)* |
| `RERANKER_TIMEOUT_MS` | How long to wait for the reranker before continuing without reranking (graceful degradation). `500`–`60000`. | `8000` |
| `VECTOR_SEARCH_DEFAULT` | Optional global default mode. Prefer the GUI setting. | `default` |

`RERANKER_API_KEY` is never returned by the API in cleartext — `currentSettings()`
exposes it only as a boolean `!!process.env.RERANKER_API_KEY`, and the GUI shows
a masked placeholder that is **not** written back over the real key on save.

### 3b. SystemSettings (GLOBAL tuning, not env vars)

Edited from the same GUI page; stored in the DB (no Prisma migration — the
`vectorSearchMode` workspace column already existed).

| Setting | Default | Range | Meaning |
|---------|---------|-------|---------|
| `vector_search_default` | `default` | one of the 4 modes | Global default mode; invalid values coerce to `default`. |
| `hybrid_weight` | `0.7` | `0.0`–`1.0` | Vector-arm weight (alpha) in RRF. Higher favors semantic, lower favors keyword. |
| `reranker_retrieval_topk` | `40` | `1`–`500` | **Total** candidate pool sent to the reranker (each arm retrieves up to this many; the deduped union is capped at this value by RRF order). Also bounds the native CPU reranker's workload. |
| `reranker_instruction` | `""` | free text | Optional instruction prepended to the query for instruction-tuned rerankers. Empty clears it. |

### 3c. Per-workspace override

Each workspace has a **Search Mode** dropdown (Workspace Settings → Vector
Database) offering all four modes. A workspace value **other than `default`**
overrides the global default; the value `default` means "follow the global
setting" (the column is non-null with schema default `"default"`, so an unset
workspace is indistinguishable from an explicit `default` — a workspace
therefore cannot pin itself to pure vector search while a non-default global
mode is active; this trade-off avoids a Prisma migration across ~40 client
databases). The dropdown is guarded to LanceDB workspaces only and shows this
hint on the `default` option.

---

## 4. Two supported wire formats

The external `GenericReranker` speaks two HTTP shapes. Scores are always mapped
back by the service-provided `index`, never by array position.

### A) Cohere-compatible (`RERANKER_PROVIDER=cohere`)

Covers **LiteLLM, vLLM (`/rerank` or `/v1/rerank`), Cohere, Jina, Infinity, and
Voyage**.

```
POST {basePath}/rerank
{ "model": "<RERANKER_MODEL_PREF>", "query": "…", "documents": ["…", "…"], "top_n": 40 }
->
{ "results": [ { "index": 2, "relevance_score": 0.91 }, … ] }
```

Voyage uses `top_k` instead of `top_n`; this is auto-detected when `voyage`
appears in the base path.

### B) TEI (`RERANKER_PROVIDER=tei`)

HuggingFace Text-Embeddings-Inference. **Special case:** bare-array response, no
`results` wrapper, `score` not `relevance_score`, and no `model` field in the
request.

```
POST {basePath}/rerank
{ "query": "…", "texts": ["…", "…"], "raw_scores": false }
->
[ { "index": 2, "score": 0.91 }, … ]
```

### Graceful degradation (guaranteed)

On **any** failure — 8000 ms timeout (`AbortSignal.timeout`), non-200, malformed
body, unreachable host — the reranker returns the input documents **unmodified**
(preserving vector/RRF order), logs a warning, and **never throws into the RAG
path**. A misconfigured reranker degrades chat quality to plain vector order; it
does not break chat.

---

## 5. Standing up a reranker container

### Option 1 — vLLM `/rerank` (recommended, Cohere-compatible)

```bash
docker run --gpus all -p 8000:8000 \
  vllm/vllm-openai:latest \
  --model BAAI/bge-reranker-v2-m3 \
  --task score
```

Then in the GUI (or `server/.env`):

```
RERANKER_PROVIDER=cohere
RERANKER_BASE_PATH=http://vllm-reranker:8000/v1/rerank
RERANKER_MODEL_PREF=BAAI/bge-reranker-v2-m3
RERANKER_API_KEY=            # empty — shared/trusted container
```

If AnythingLLM and vLLM run in the same Docker network, use the **service name**
(`http://vllm-reranker:8000/...`), not `localhost`. The base-URL validator
accepts dockerized hostnames.

### Option 2 — HuggingFace TEI

```bash
docker run --gpus all -p 8080:80 \
  ghcr.io/huggingface/text-embeddings-inference:latest \
  --model-id BAAI/bge-reranker-v2-m3
```

```
RERANKER_PROVIDER=tei
RERANKER_BASE_PATH=http://tei-reranker:8080
RERANKER_MODEL_PREF=            # ignored by TEI
```

### Option 3 — shared reranker for many tenants

A single reranker container can serve every AnythingLLM workspace/tenant:
reranking is stateless (query + candidate texts in, scores out) and carries no
per-workspace state. Point all instances at the same `RERANKER_BASE_PATH`. Size
the container for peak concurrent chat load, not per-workspace. Leave
`RERANKER_API_KEY` empty when the container is only reachable inside a trusted
network; set a token if it is exposed.

### Enabling it

1. Start the reranker container and confirm it answers a manual `curl` `/rerank`.
2. In **Settings → Search & Retrieval**, set the provider, base URL, model, and
   (optionally) the default mode to `hybrid_rerank`.
3. Save. `RERANKER_*` are persisted; SystemSettings are written to the DB.
4. Existing LanceDB workspaces get their FTS index created lazily on the next
   ingestion, or backfill immediately (next section).
5. Optionally set individual high-value workspaces to `hybrid_rerank` via the
   workspace dropdown.

---

## 6. FTS index backfill for existing workspaces

Hybrid needs a BM25 FTS index on the `text` column. New collections and any
collection touched by ingestion get it automatically. To backfill **all**
existing LanceDB collections without waiting for ingestion:

```bash
# IMPORTANT (Docker deployments): run INSIDE the container so the script sees
# the real STORAGE_DIR / named volume — running it on the host silently
# targets <repo>/server/storage instead and becomes a no-op:
docker exec <container> node /app/server/utils/vectorDbProviders/lance/backfillFtsIndex.js --dry-run
docker exec <container> node /app/server/utils/vectorDbProviders/lance/backfillFtsIndex.js

# Bare-metal (non-Docker) equivalent, from the repo root:
STORAGE_DIR=/path/to/server/storage node server/utils/vectorDbProviders/lance/backfillFtsIndex.js --dry-run
STORAGE_DIR=/path/to/server/storage node server/utils/vectorDbProviders/lance/backfillFtsIndex.js
```

Idempotent (skips collections that already have the index) and non-throwing per
table.

At runtime the ingestion path keeps the index fresh on its own: after adds it
folds newly written rows into the index via `optimize()` once more than ~100
rows are unindexed (`optimizeFtsIfStale`). Unindexed rows remain findable via
flat-scan in the meantime, so results are always current — the threshold only
bounds the brute-force scan cost. Note that a table **without** any FTS index
cannot serve BM25 at all (lancedb 0.15.0 throws; hybrid degrades to
vector-only for that query) — hence this backfill for pre-existing
collections.

---

## 7. Verifying without a reranker

The framework-free manual tests (no runner is configured in this repo) exercise
the wire encoders/parsers with mocked fetch and the LanceDB hybrid path against
a real temp table:

```bash
node server/__tests__/utils/EmbeddingRerankers/genericReranker.manual.js
node server/__tests__/utils/vectorDbProviders/lanceHybrid.manual.js
node server/__tests__/utils/vectorDbProviders/lanceFtsBackfill.manual.js
```

To compare retrieval quality across the four modes on a real query set, see the
eval-harness **skeleton** at
`server/__tests__/utils/vectorDbProviders/searchModeEval.eval.js` (marked TODO —
wire in the KuferSQL/VHS query set and a live reranker endpoint before running).
