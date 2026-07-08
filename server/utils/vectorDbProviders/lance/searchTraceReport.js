/**
 * KIE-471/480 — Auswertung der Search-Traces (searchTrace.js).
 *
 * Aggregiert die JSONL-Traces zu einem Markdown-Bericht: Latenzen (p50/p95),
 * Reranker-Wirkung (Rang-Verschiebungen, "Rettungen" jenseits topN),
 * Arm-Beiträge (BM25- vs. Vektor-Herkunft der finalen Treffer),
 * Degradations-/Fehlerraten und Relax-Statistik.
 *
 * Nutzung (im Container oder mit STORAGE_DIR):
 *   node utils/vectorDbProviders/lance/searchTraceReport.js
 *   node utils/vectorDbProviders/lance/searchTraceReport.js /pfad/zu/traces-2026-07-08.jsonl
 */
const fs = require("fs");
const path = require("path");

function loadTraces(target) {
  const files = [];
  if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
    for (const f of fs.readdirSync(target))
      if (f.endsWith(".jsonl")) files.push(path.join(target, f));
  } else if (fs.existsSync(target)) {
    files.push(target);
  }
  const traces = [];
  for (const file of files.sort()) {
    for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      try {
        traces.push(JSON.parse(line));
      } catch {
        /* halbe Zeile beim Live-Schreiben — überspringen */
      }
    }
  }
  return traces;
}

const pct = (list, p) => {
  const sorted = [...list].sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
};
const fmtMs = (v) => (v === null ? "—" : `${v} ms`);
const fmtPct = (num, den) =>
  den > 0 ? `${((100 * num) / den).toFixed(1)} %` : "—";
const avg = (list) =>
  list.length ? list.reduce((a, b) => a + b, 0) / list.length : null;

function latencyRow(label, values) {
  return `| ${label} | ${values.length} | ${fmtMs(pct(values, 50))} | ${fmtMs(pct(values, 95))} | ${fmtMs(values.length ? Math.max(...values) : null)} |`;
}

function report(traces) {
  const lines = [];
  lines.push(`# Search-Trace-Bericht`);
  lines.push("");
  if (traces.length === 0) {
    lines.push("Keine Traces gefunden. Setting `search_trace` auf `on` stellen und Suchen ausführen.");
    return lines.join("\n");
  }
  const byMode = {};
  for (const t of traces) (byMode[t.mode] = byMode[t.mode] || []).push(t);
  lines.push(
    `Zeitraum: ${traces[0].ts} … ${traces[traces.length - 1].ts} · **${traces.length} Suchen** (${Object.entries(byMode)
      .map(([m, l]) => `${m}: ${l.length}`)
      .join(", ")})`
  );

  // --- Latenzen -------------------------------------------------------------
  lines.push("", `## Latenzen`, "");
  lines.push(`| Stufe | n | p50 | p95 | max |`, `|---|---|---|---|---|`);
  lines.push(latencyRow("Vektor-Arm", traces.map((t) => t.vectorArm?.ms).filter(Number.isFinite)));
  lines.push(latencyRow("BM25-Arm", traces.map((t) => t.ftsArm?.ms).filter(Number.isFinite)));
  lines.push(latencyRow("Reranker", traces.map((t) => t.rerank?.ms).filter(Number.isFinite)));
  lines.push(latencyRow("Gesamt (Retrieval)", traces.map((t) => t.totalMs).filter(Number.isFinite)));

  // --- Reranker-Wirkung -------------------------------------------------------
  const rr = traces.filter((t) => t.rerank);
  if (rr.length > 0) {
    const degraded = rr.filter((t) => t.rerank.degraded);
    const providers = [...new Set(rr.map((t) => `${t.rerank.provider}${t.rerank.model ? `/${t.rerank.model}` : ""}`))];
    lines.push("", `## Reranker-Wirkung`, "");
    lines.push(`- Provider: ${providers.join(", ")}`);
    lines.push(`- Ø Kandidaten an Reranker: ${Math.round(avg(rr.map((t) => t.rerank.sent)) ?? 0)}`);
    lines.push(`- **Degradations-Rate (Fallback auf RRF/Vektor): ${fmtPct(degraded.length, rr.length)}** (${degraded.length}/${rr.length})`);

    const finals = rr.flatMap((t) => t.final?.docs || []);
    const shifted = finals.filter((d) => Number.isFinite(d.shift));
    if (shifted.length > 0) {
      const absShifts = shifted.map((d) => Math.abs(d.shift));
      const upshifts = shifted.map((d) => d.shift).filter((s) => s > 0);
      const top1Changed = rr.filter((t) => {
        const first = t.final?.docs?.[0];
        return first && Number.isFinite(first.rrfRank ?? first.vectorRank) && (first.rrfRank ?? first.vectorRank) !== 1;
      });
      // "Rettungen": finale Treffer, die OHNE Reranker (reines topN der
      // Vor-Reihenfolge) nicht gezeigt worden wären.
      const rescued = rr.flatMap((t) =>
        (t.final?.docs || []).filter((d) => {
          const preRank = d.rrfRank ?? d.vectorRank;
          return Number.isFinite(preRank) && preRank > (t.final?.count || 0);
        })
      );
      lines.push(`- Ø |Rang-Verschiebung| der finalen Treffer: ${avg(absShifts).toFixed(1)} Ränge (max. Aufstieg: +${upshifts.length ? Math.max(...upshifts) : 0})`);
      lines.push(`- Top-1 durch Reranker verändert: ${fmtPct(top1Changed.length, rr.length)} der Suchen`);
      lines.push(`- **Reranker-Rettungen** (finale Treffer von jenseits topN geholt): ${fmtPct(rescued.length, finals.length)} der finalen Treffer`);
    }
  }

  // --- Arm-Beiträge (Hybrid-Modi) ---------------------------------------------
  const hybridTraces = traces.filter((t) => ["hybrid", "hybrid_rerank"].includes(t.mode));
  const hybridFinals = hybridTraces.flatMap((t) => t.final?.docs || []).filter((d) => "inVector" in d);
  if (hybridFinals.length > 0) {
    const onlyFts = hybridFinals.filter((d) => d.inFts && !d.inVector);
    const onlyVec = hybridFinals.filter((d) => d.inVector && !d.inFts);
    const both = hybridFinals.filter((d) => d.inVector && d.inFts);
    lines.push("", `## Arm-Beiträge (finale Treffer, Hybrid-Modi)`, "");
    lines.push(`| Herkunft | Anteil | Bedeutung |`, `|---|---|---|`);
    lines.push(`| nur BM25-Arm | **${fmtPct(onlyFts.length, hybridFinals.length)}** | „BM25-Rettungen" — hätte reine Vektorsuche verfehlt |`);
    lines.push(`| nur Vektor-Arm | ${fmtPct(onlyVec.length, hybridFinals.length)} | semantische Treffer ohne Wortüberlappung |`);
    lines.push(`| beide Arme | ${fmtPct(both.length, hybridFinals.length)} | von beiden Verfahren bestätigt |`);
  }

  // --- Zuverlässigkeit ----------------------------------------------------------
  const fts = traces.filter((t) => t.ftsArm);
  const ftsErrors = fts.filter((t) => t.ftsArm.error);
  const ftsEmpty = fts.filter((t) => !t.ftsArm.error && t.ftsArm.count === 0);
  const relaxed = traces.filter((t) => t.relaxed);
  lines.push("", `## Zuverlässigkeit`, "");
  lines.push(`- BM25-Arm-Fehlerrate: ${fmtPct(ftsErrors.length, fts.length)}${ftsErrors.length ? ` — häufigster Fehler: ${ftsErrors[0].ftsArm.error.slice(0, 80)}` : ""}`);
  lines.push(`- BM25-Arm leer (0 Treffer): ${fmtPct(ftsEmpty.length, fts.length)}`);
  lines.push(`- Metadaten-Filter-Relax ausgelöst: ${fmtPct(relaxed.length, traces.length)} (Stufe 1: ${traces.filter((t) => t.relaxStage === 1).length}, Stufe 2: ${traces.filter((t) => t.relaxStage === 2).length})`);
  lines.push(`- Suchen ohne finale Treffer: ${fmtPct(traces.filter((t) => (t.final?.count ?? 0) === 0).length, traces.length)}`);

  return lines.join("\n");
}

if (require.main === module) {
  const base = process.env.STORAGE_DIR
    ? path.resolve(process.env.STORAGE_DIR)
    : path.resolve(__dirname, "../../../storage");
  const target = process.argv[2] || path.resolve(base, "search-traces");
  console.log(report(loadTraces(target)));
}

module.exports = { loadTraces, report };
