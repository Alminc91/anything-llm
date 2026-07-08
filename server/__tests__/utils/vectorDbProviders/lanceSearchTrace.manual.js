/**
 * Manual integration test — Search-Trace (searchTrace.js + Instrumentierung).
 *
 * Prüft gegen die echte LanceDB-Binary:
 *   1. hybrid_rerank mit search_trace=full → vollständige JSONL-Zeile
 *      (Arme mit Latenz/Count/Top, Fusion mit α + Arm-Herkunft, Reranker mit
 *      Latenz/degraded, finale Docs mit rrfRank→finalRank-Shift, Query-Text).
 *   2. Datenschutz: level=on → KEIN Query-Text, nur Hash; nie Chunk-Volltexte.
 *   3. level=off → es wird NICHTS geschrieben.
 *   4. default-Modus → vectorArm + final werden erfasst.
 *   5. Suchergebnis bleibt unverändert (Tracing ist reine Diagnostik).
 *
 * Framework-frei (jest ignoriert *.manual.js):
 *   node __tests__/utils/vectorDbProviders/lanceSearchTrace.manual.js
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.STORAGE_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), "lance-trace-")
);
const TRACE_DIR = path.join(process.env.STORAGE_DIR, "search-traces");

const { LanceDb } = require("../../../utils/vectorDbProviders/lance");
const { SystemSettings } = require("../../../models/systemSettings");

const ok = (msg) => console.log(`\x1b[32m  ✓\x1b[0m ${msg}`);

// SystemSettings stubben: search_trace steuerbar, alles andere = Fallback
// (keine Schreibzugriffe auf die Dev-DB aus diesem Test).
let traceLevel = "off";
SystemSettings.getValueOrFallback = async ({ label } = {}, fallback) =>
  label === "search_trace" ? traceLevel : fallback;

const ROWS = [
  { id: "yoga-1", title: "yogakurs-y100.txt", text: "Yogakurs Y100 am Abend in Lingen fuer Anfaenger", vector: [1, 0, 0, 0] },
  { id: "yoga-2", title: "yogakurs-y200.txt", text: "Yogakurse Y200 Rueckenschule und Entspannung", vector: [0.9, 0.1, 0, 0] },
  { id: "schwimm", title: "schwimmkurs-s300.txt", text: "Schwimmkurs S300 fuer Kinder in Meppen", vector: [0, 1, 0, 0] },
  { id: "knr", title: "spezial-knr-77441.txt", text: "Spezialkurs KNR-77441 Toepfern am Wochenende", vector: [0, 0, 0, 1] },
];

const readTraces = () => {
  if (!fs.existsSync(TRACE_DIR)) return [];
  return fs
    .readdirSync(TRACE_DIR)
    .filter((f) => f.endsWith(".jsonl"))
    .flatMap((f) =>
      fs
        .readFileSync(path.join(TRACE_DIR, f), "utf-8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    );
};
// writeTrace ist fire-and-forget → kurz auf die erwartete Zeilenzahl pollen.
const waitForTraces = async (expected, timeoutMs = 3000) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (readTraces().length >= expected) return readTraces();
    await new Promise((r) => setTimeout(r, 100));
  }
  return readTraces();
};

async function run() {
  const lance = new LanceDb();
  const { client } = await lance.connect();
  const ns = "trace_probe";
  await client.dropTable(ns).catch(() => {});
  await lance.updateOrCreateCollection(client, ROWS, ns);
  const mockLLM = { embedTextInput: async () => [1, 0, 0, 0] };

  // ---- 1) hybrid_rerank mit level=full --------------------------------------
  traceLevel = "full";
  const QUERY = "Yogakurs am Abend KNR-77441";
  const result = await lance.performSimilaritySearch({
    namespace: ns,
    input: QUERY,
    LLMConnector: mockLLM,
    topN: 3,
    similarityThreshold: 0,
    searchMode: "hybrid_rerank",
  });
  assert.ok(result.sources.length > 0, "Suche liefert Ergebnisse");

  let traces = await waitForTraces(1);
  assert.strictEqual(traces.length, 1, "genau eine Trace-Zeile geschrieben");
  const t = traces[0];
  assert.strictEqual(t.mode, "hybrid_rerank");
  assert.strictEqual(t.namespace, ns);
  assert.strictEqual(t.query, QUERY, "full: Query-Text enthalten");
  assert.ok(t.queryHash?.length === 12 && t.queryChars === QUERY.length);
  // Arme
  assert.ok(t.vectorArm.count > 0 && Number.isFinite(t.vectorArm.ms), "vectorArm erfasst");
  assert.ok(Number.isFinite(t.ftsArm.ms) && t.ftsArm.error === null, "ftsArm erfasst");
  assert.ok(t.vectorArm.top[0].similarity > 0 && t.vectorArm.top[0].id, "Arm-Top mit Score+id");
  // Fusion
  assert.ok(t.fusion.candidates > 0 && t.fusion.alpha === 0.7, "Fusion mit α erfasst");
  const fusedTop = t.fusion.top[0];
  assert.ok(
    Number.isFinite(fusedTop.rrf) && typeof fusedTop.inVector === "boolean" && typeof fusedTop.inFts === "boolean",
    "Fusion-Top mit rrf + Arm-Herkunft"
  );
  // Reranker
  assert.ok(t.rerank.sent > 0 && Number.isFinite(t.rerank.ms), "Reranker-Latenz + sent erfasst");
  assert.strictEqual(typeof t.rerank.degraded, "boolean");
  assert.strictEqual(t.rerank.provider, "native", "ohne ENV: native Provider");
  // Finale Docs mit Shift
  assert.strictEqual(t.final.docs[0].finalRank, 1);
  for (const d of t.final.docs) {
    assert.ok(d.id && d.title, "finale Docs mit id+title");
    assert.ok(Number.isFinite(d.rrfRank), "rrfRank vorhanden");
    assert.strictEqual(d.shift, d.rrfRank - d.finalRank, "shift = rrfRank - finalRank");
    assert.strictEqual(typeof d.inVector, "boolean");
  }
  assert.ok(Number.isFinite(t.totalMs) && t.relaxStage === 0 && t.relaxed === false);
  // Datenschutz: keine Chunk-Volltexte in der Zeile
  const raw = JSON.stringify(t);
  assert.ok(!raw.includes("fuer Anfaenger"), "keine Chunk-Volltexte im Trace");
  ok("hybrid_rerank/full: Arme, Fusion(α+Herkunft), Reranker, Shifts, totalMs — vollständig");

  // ---- 2) level=on → kein Query-Text ----------------------------------------
  traceLevel = "on";
  await lance.performSimilaritySearch({
    namespace: ns,
    input: QUERY,
    LLMConnector: mockLLM,
    topN: 3,
    similarityThreshold: 0,
    searchMode: "hybrid",
  });
  traces = await waitForTraces(2);
  const t2 = traces[1];
  assert.strictEqual(t2.mode, "hybrid");
  assert.ok(!("query" in t2), "on: KEIN Query-Text");
  assert.ok(t2.queryHash?.length === 12, "on: Hash vorhanden");
  assert.ok(t2.fusion.candidates > 0 && t2.final.docs[0].rrf !== undefined, "hybrid: Fusion+final erfasst");
  ok("hybrid/on: Query nur als Hash — Datenschutz-Stufen greifen");

  // ---- 3) level=off → nichts geschrieben ------------------------------------
  traceLevel = "off";
  await lance.performSimilaritySearch({
    namespace: ns,
    input: QUERY,
    LLMConnector: mockLLM,
    topN: 3,
    similarityThreshold: 0,
    searchMode: "hybrid_rerank",
  });
  await new Promise((r) => setTimeout(r, 400));
  assert.strictEqual(readTraces().length, 2, "off: keine neue Trace-Zeile");
  ok("off: kein Schreibzugriff (Default-Verhalten unverändert)");

  // ---- 4) default-Modus ------------------------------------------------------
  traceLevel = "on";
  await lance.performSimilaritySearch({
    namespace: ns,
    input: QUERY,
    LLMConnector: mockLLM,
    topN: 2,
    similarityThreshold: 0,
    searchMode: "default",
  });
  traces = await waitForTraces(3);
  const t4 = traces[2];
  assert.strictEqual(t4.mode, "default");
  assert.ok(t4.vectorArm.count > 0 && t4.final.docs[0].similarity > 0, "default: vectorArm+final erfasst");
  ok("default-Modus: vectorArm + finale Similarities erfasst");

  // ---- 5) Ergebnis-Neutralität ------------------------------------------------
  traceLevel = "off";
  const off = await lance.performSimilaritySearch({
    namespace: ns, input: QUERY, LLMConnector: mockLLM, topN: 3, similarityThreshold: 0, searchMode: "hybrid_rerank",
  });
  traceLevel = "full";
  const on = await lance.performSimilaritySearch({
    namespace: ns, input: QUERY, LLMConnector: mockLLM, topN: 3, similarityThreshold: 0, searchMode: "hybrid_rerank",
  });
  assert.deepStrictEqual(
    on.sources.map((s) => s.id ?? s.title),
    off.sources.map((s) => s.id ?? s.title),
    "Tracing verändert das Suchergebnis nicht"
  );
  ok("Neutralität: identische Ergebnisse mit und ohne Tracing");

  console.log("\n\x1b[32mAll 5 search-trace assertions passed.\x1b[0m");
}

run()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("\x1b[31mFAILED:\x1b[0m", e.message);
    process.exit(1);
  });
