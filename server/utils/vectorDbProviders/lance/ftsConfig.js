/**
 * Single source of truth for the LanceDB FTS (BM25) index configuration
 * (KIE-478). Shared by LanceDb.ensureFullTextIndex (ingestion) and
 * backfillFtsIndex.js (fleet backfill) so the two can never drift.
 *
 * Tokenizer choice — n-gram (trigrams) instead of word tokenizer + stemmer:
 * verified empirically against @lancedb/lancedb 0.31.0 with German course
 * data (2026-07-04, KIE-478):
 *   - "Yogakurs" finds "Yogakurse" as the top hit (compounds — impossible
 *     for any stemmer),
 *   - "Kurs" finds all inflected forms,
 *   - exact tokens like course codes ("A123") still score highest by far,
 *   - no false positives for unrelated terms.
 * The German Snowball stemmer on 0.31.0 was measurably weaker: it clusters
 * "Kurse"/"Kursen" but keeps "Kurs" separate and never splits compounds.
 * Trade-offs of n-gram (index ~5-7x larger, slight partial-overlap noise)
 * are absorbed by the weighted RRF fusion (vector arm alpha 0.7) and the
 * reranker; at our table sizes the index growth is megabytes.
 *
 * NOTE: changing this config does NOT retroactively rewrite existing
 * indexes — run backfillFtsIndex.js with --rebuild to migrate a deployment
 * (drops + recreates each "text" index in place; additive, vectors and rows
 * are never mutated).
 */
const FTS_INDEX_CONFIG = Object.freeze({
  lowercase: true,
  asciiFolding: true,
  baseTokenizer: "ngram",
  ngramMinLength: 3,
  ngramMaxLength: 3,
  prefixOnly: false,
});

module.exports = { FTS_INDEX_CONFIG };
