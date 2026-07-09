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
| `hybrid_rerank` **(recommended)** | The arms share the `reranker_retrieval_topk` nomination budget (`hybrid_arm_split`, default 50/50); the deduped union (≤ `reranker_retrieval_topk`) goes to the reranker **in full** — no candidate is dropped by RRF before the reranker has judged it. RRF order is used only as a fallback if the reranker fails; `hybrid_weight` has no effect on which candidates the reranker sees. | Yes |

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

## 2. German tokenization: n-gram (KIE-478)

Since the `@lancedb/lancedb` 0.31.x upgrade (KIE-478) the FTS index uses an
**n-gram tokenizer** (trigrams, `lowercase` + `asciiFolding`; single source of
truth: `utils/vectorDbProviders/lance/ftsConfig.js`). Empirically verified with
German course data:

- **Compounds match:** `"Yogakurs"` finds `"Yogakurse"` as the top hit — this
  is impossible for any stemmer and was the main German gap before.
- **Inflection matches:** `"Kurs"` finds `"Kurse"`, `"Kursen"`, etc.
- **Exact tokens stay dominant:** course numbers (KNR) score far above
  n-gram partial overlaps; BM25 keeps true hits on top.
- Trade-offs: the index stores trigrams (~5-7x more entries — megabytes at our
  table sizes; measured: 5000 chunks ≈ 8.7 MB total, FTS query ≈ 3 ms) and
  partial overlaps add slight noise, which the weighted RRF fusion (vector arm
  alpha 0.7) and the reranker absorb.

The German **stemmer** on 0.31 was evaluated and rejected: it clusters
`"Kurse"`/`"Kursen"` but keeps `"Kurs"` separate and never splits compounds.
Do not promise lemmatization to customers — n-gram is surface-form overlap,
not linguistic analysis; the vector arm continues to carry semantics.

**Migration note:** existing indexes keep the tokenizer they were created
with. After deploying this version, run the backfill once with `--rebuild`
(section 6) to recreate all `"text"` indexes with the n-gram config.

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
| `hybrid_weight` | `0.7` | `0.0`–`1.0` | Vector-arm weight (alpha) in RRF. Higher favors semantic, lower favors keyword. Ranks for real only in `hybrid` mode; in `hybrid_rerank` it merely orders the degradation fallback. |
| `reranker_retrieval_topk` | `40` | `1`–`500` | **Total** documents sent to the reranker. In `hybrid_rerank` the arms share this nomination budget (see `hybrid_arm_split`), so the full deduped union reaches the reranker (nothing is cut by RRF order). Also bounds the native CPU reranker's workload. |
| `hybrid_arm_split` | `0.5` | `0.1`–`0.9` | Vector share of the `hybrid_rerank` nomination budget (Qdrant-prefetch-style per-arm depth). `0.5` = equal halves; raise for semantics-heavy corpora, lower for keyword-heavy ones. Does **not** weight results — the reranker judges all nominees purely by relevance. |
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

## 3d. Metadata filters (KIE-480, opt-in)

With the SystemSetting `metadata_filters = on` (Settings → Search & Retrieval)
a **deterministic German extractor** (`server/utils/chats/metadataFilterExtractor.js`,
P0 eval winner: 68/68 gold cases; LLM arms lose exactly on calendar
arithmetic) parses hard constraints from the — already rewritten — query and
pre-filters retrieval via `.where()` on the flat metadata columns
(`start_date`, `start_minutes`, `weekdays`, `price`, `bookable`, `format`,
`location`) in ALL search modes and BOTH hybrid arms:

- time: "dieses Quartal", "nächste Woche", "ab Oktober", "abends", "dienstags"
- price: "unter 50 €", "kostenlos" — status: "noch buchbar", "freie Plätze"
- format: "nur online", "kein Onlinekurs" (negation) — location: only values
  from the `metadata_filter_locations` whitelist (comma-separated, per
  customer) ever become filters.

Rules: ambiguous → NO filter (a missing filter degrades to today's behavior);
nothing reaches the SQL unvalidated; legacy tables without the columns fall
back to unfiltered queries. **Empty-result fallback** is staged: (1) full
filters, (2) time constraints dropped, (3) unfiltered — on relaxation the LLM
receives an explicit German note (context only, never a fabricated citation)
so the answer says "nothing in the requested period — but from October…".

Data path: the course crawler (Pipelines repo, branch
`kie-480-metadaten-extractor`) sends the structured fields with each upload;
the collector whitelist validates them; ingestion auto-migrates existing
tables via `addColumns` (typed NULLs — no re-embedding needed).

---

## 3e. Search-Traces: Monitoring & Bewertung (opt-in)

SystemSetting `search_trace` (Settings → Suche & Retrieval → Erweitert):

| Wert | Verhalten |
|---|---|
| `off` | Default — nichts wird geschrieben |
| `on` | Voller Trace, Query nur als SHA1-Hash + Länge |
| `full` | Zusätzlich der Query-Text — **nur auf Test-Containern** |

Pro Suche entsteht eine JSONL-Zeile unter `STORAGE_DIR/search-traces/traces-YYYY-MM-DD.jsonl` mit: beiden Retrieval-Armen (Latenz, Trefferzahl, Top-20 mit Scores), RRF-Fusion (α, Kandidaten, Arm-Herkunft je Dokument), Reranker (Provider/Modell, Latenz, Degradations-Flag) und den finalen Dokumenten inkl. **Rang-Verschiebung** (RRF-Rang → Final-Rang; `shift > 0` = vom Reranker nach oben geholt). Dokumente erscheinen nur als id/title/Scores — keine Chunk-Volltexte. Tracing ist non-throwing und fire-and-forget (verändert weder Ergebnis noch Latenz messbar; im Manual-Test per Ergebnisvergleich belegt).

Auswertung zu einem Markdown-Bericht (Latenz-Perzentile, Degradations-/Fehlerraten, Ø-Rang-Verschiebung, „Reranker-Rettungen" jenseits topN, BM25- vs. Vektor-Beiträge der finalen Treffer, Relax-Statistik):

```bash
docker exec <container> node /app/server/utils/vectorDbProviders/lance/searchTraceReport.js
# oder gezielt eine Datei:
docker exec <container> node /app/server/utils/vectorDbProviders/lance/searchTraceReport.js /app/server/storage/search-traces/traces-2026-07-08.jsonl
```

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

# Tokenizer migration (once after the KIE-478 n-gram upgrade): recreate ALL
# existing "text" indexes with the current shared config (replace, additive,
# vectors/rows untouched):
docker exec <container> node /app/server/utils/vectorDbProviders/lance/backfillFtsIndex.js --rebuild

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
