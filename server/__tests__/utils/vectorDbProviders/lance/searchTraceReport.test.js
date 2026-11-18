/* eslint-env jest, node */
/**
 * Auswertung der Suchspuren (searchTraceReport.js): Die „Reranker-Wirkung“
 * rechnet gegen den Rang vor der Auswahlstufe (`rerankRank`, K-R3), nicht
 * gegen die Position nach der Stufe. Suchspuren ohne das Feld (vor 8.2)
 * rechnen wie bisher mit der Endposition.
 */
const {
  report,
} = require("../../../../utils/vectorDbProviders/lance/searchTraceReport");

const doc = (finalRank, rrfRank, rerankRank, extra = {}) => ({
  finalRank,
  id: `d${finalRank}`,
  title: `d${finalRank}.txt`,
  rrfRank,
  shift: rrfRank - finalRank,
  ...(rerankRank === undefined ? {} : { rerankRank }),
  ...extra,
});
const trace = (docs, extra = {}) => ({
  ts: "2026-11-16T10:00:00.000Z",
  mode: "hybrid_rerank",
  rerank: { provider: "generic", sent: 20, returned: 12, degraded: false },
  final: { count: docs.length, docs },
  ...extra,
});
const line = (text, start) =>
  text.split("\n").find((l) => l.startsWith(start)) ?? "";

describe("Reranker-Wirkung gegen rerankRank (K-R3)", () => {
  test("Umordnung der Stufe zählt nicht als Reranker-Wirkung", () => {
    // Der Reranker lässt die RRF-Folge stehen (rerankRank = rrfRank - 1);
    // die Stufe tauscht Platz 1 und 2 und holt einen Kurs aus dem Pool
    // (Reranker-Rang 6, RRF-Rang 9) statt Platz 4 herein.
    const text = report([
      trace([doc(1, 2, 1), doc(2, 1, 0), doc(3, 3, 2), doc(4, 9, 8)]),
    ]);
    expect(line(text, "- Top-1 durch Reranker verändert")).toMatch(
      /: 0\.0 % der Suchen/
    );
    expect(line(text, "- Ø |Rang-Verschiebung|")).toMatch(/: 0\.0 Ränge/);
    expect(line(text, "- **Reranker-Rettungen**")).toMatch(/: 0\.0 %/);
  });

  test("echte Reranker-Wirkung bleibt sichtbar", () => {
    // Der Reranker holt d2 von RRF 7 auf Rang 0 (Top-1 verändert, Rettung);
    // die Stufe setzt ihn auf Platz 2.
    const text = report([
      trace([doc(1, 1, 1), doc(2, 7, 0), doc(3, 3, 2), doc(4, 4, 3)]),
    ]);
    expect(line(text, "- Top-1 durch Reranker verändert")).toMatch(
      /: 100\.0 % der Suchen/
    );
    // Verschiebungen: 1-2, 7-1, 3-3, 4-4 → |−1|, 6, 0, 0 → Ø 1,75
    expect(line(text, "- Ø |Rang-Verschiebung|")).toMatch(
      /: 1\.8 Ränge \(max\. Aufstieg: \+6\)/
    );
    expect(line(text, "- **Reranker-Rettungen**")).toMatch(/: 25\.0 %/);
  });

  test("Treffer der Kursnummernsuche (rerankRank null) zählen nicht", () => {
    const text = report([
      trace([
        { finalRank: 1, id: "knr", title: "knr.txt", rerankRank: null },
        doc(2, 1, 0),
        doc(3, 2, 1),
        doc(4, 3, 2),
      ]),
    ]);
    expect(line(text, "- Top-1 durch Reranker verändert")).toMatch(
      /: 0\.0 % der Suchen/
    );
    expect(line(text, "- Ø |Rang-Verschiebung|")).toMatch(/: 0\.0 Ränge/);
    expect(line(text, "- **Reranker-Rettungen**")).toMatch(/: 0\.0 %/);
  });

  test("Suchspuren ohne rerankRank (vor 8.2): Endposition wie bisher", () => {
    const text = report([trace([doc(1, 2), doc(2, 1), doc(3, 3), doc(4, 9)])]);
    expect(line(text, "- Top-1 durch Reranker verändert")).toMatch(
      /: 100\.0 % der Suchen/
    );
    expect(line(text, "- Ø |Rang-Verschiebung|")).toMatch(
      /: 1\.8 Ränge \(max\. Aufstieg: \+5\)/
    );
    expect(line(text, "- **Reranker-Rettungen**")).toMatch(/: 25\.0 %/);
  });

  test("Top-1 des Rerankers von der Stufe ersetzt: zählt nicht als bekannt", () => {
    const text = report([
      // Reranker-Rang 0 fehlt unter den Quellen (z. B. Warteliste getauscht)
      trace([doc(1, 2, 1), doc(2, 3, 2), doc(3, 4, 3), doc(4, 6, 5)]),
      trace([doc(1, 1, 0), doc(2, 2, 1), doc(3, 3, 2), doc(4, 4, 3)]),
    ]);
    expect(line(text, "- Top-1 durch Reranker verändert")).toMatch(
      /: 0\.0 % der Suchen \(1 mit Top-1 des Rerankers unter den Quellen\)/
    );
  });
});
