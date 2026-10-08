/* eslint-env jest, node */
const fs = require("fs");
const path = require("path");
const {
  SELECTION_KEEP,
  SELECTION_BAND,
  SELECTION_FLOOR,
  classifyRow,
  selectContexts,
  selectionConfig,
  parseIsoDay,
  berlinToday,
} = require("../../../../utils/vectorDbProviders/lance/contextSelection");

const TODAY = "2026-10-08";
const kurs = (id, score, start, bookable = true) => ({
  id,
  title: `${id}.txt`,
  text: `Kurs ${id}`,
  rerank_score: score,
  start_date: start,
  bookable,
});
const info = (id, score) => ({
  id,
  title: `${id}.html`,
  text: `Übersicht ${id}`,
  rerank_score: score,
  start_date: null,
  bookable: null,
});
const ids = (rows) => rows.map((r) => r.id);
const run = (candidates, topN = 4, settings) =>
  selectContexts(candidates, { topN, today: TODAY, settings });

/**
 * Hard Constraint „die Stufe entfernt nie einen Kurs“: jedes Dokument der
 * heutigen Top-N, das fehlt, steht in `swappedOut` — Kurse nur mit Grund
 * `datum` (nie Warteliste), Nicht-Kurse nur mit `deckel` — und hat ein
 * eingewechseltes Gegenstück mit demselben Grund; ein per Datum
 * eingewechselter Kurs startet nie später als der ausgewechselte.
 */
const expectNoDrop = (out, baseline) => {
  const chosen = new Set(out.selected);
  const missing = baseline.filter((r) => !chosen.has(r));
  expect(out.swappedOut.map((s) => s.row)).toEqual(missing);
  for (const s of out.swappedOut) {
    expect(s.reason).toBe(s.kind === "kurs" ? "datum" : "deckel");
    expect(s.state).not.toBe("warteliste");
  }
  for (const reason of ["datum", "deckel"])
    expect(out.swappedIn.filter((s) => s.reason === reason).length).toBe(
      out.swappedOut.filter((s) => s.reason === reason).length
    );
  const naehen = (list) =>
    list
      .filter((s) => s.reason === "datum")
      .map((s) => s.naehe)
      .sort((a, b) => a - b);
  const ins = naehen(out.swappedIn);
  const outs = naehen(out.swappedOut);
  ins.forEach((n, k) => {
    expect(n).not.toBeNull();
    expect(n).toBeLessThanOrEqual(outs[k]);
  });
};

describe("Konstanten und Konfiguration", () => {
  test("Standardwerte K=2, Band=0,1, Boden=0,3", () => {
    expect([SELECTION_KEEP, SELECTION_BAND, SELECTION_FLOOR]).toEqual([
      2, 0.1, 0.3,
    ]);
    expect(selectionConfig({})).toEqual({ keep: 2, band: 0.1, floor: 0.3 });
  });

  test("Env-Override COURSE_SELECTION_KEEP/BAND/FLOOR, Ungültiges → Standard", () => {
    expect(
      selectionConfig({
        COURSE_SELECTION_KEEP: "1",
        COURSE_SELECTION_BAND: "0.2",
        COURSE_SELECTION_FLOOR: "0.5",
      })
    ).toEqual({ keep: 1, band: 0.2, floor: 0.5 });
    expect(
      selectionConfig({
        COURSE_SELECTION_KEEP: "zwei",
        COURSE_SELECTION_BAND: "-1",
        COURSE_SELECTION_FLOOR: "2",
      })
    ).toEqual({ keep: 2, band: 0.1, floor: 0.3 });
    expect(selectionConfig({ COURSE_SELECTION_KEEP: "" }).keep).toBe(2);
  });

  test("parseIsoDay prüft echte Kalenderdaten", () => {
    expect(parseIsoDay("2026-10-08")).toBe(parseIsoDay("2026-10-08T12:00:00"));
    expect(parseIsoDay("2026-02-31")).toBeNull();
    expect(parseIsoDay("08.10.2026")).toBeNull();
    expect(parseIsoDay(20261008)).toBeNull();
    expect(parseIsoDay(null)).toBeNull();
  });

  test("berlinToday nutzt Europe/Berlin (23:30 UTC = nächster Tag)", () => {
    expect(berlinToday(new Date("2026-10-07T23:30:00Z"))).toBe("2026-10-08");
    expect(berlinToday(new Date("2026-10-08T21:59:00Z"))).toBe("2026-10-08");
  });
});

describe("classifyRow", () => {
  test("Zustände und Nähe", () => {
    expect(classifyRow(kurs("a", 0.9, "2026-10-08"), TODAY)).toMatchObject({
      course: true,
      state: "zukuenftig",
      naehe: 0,
    });
    expect(classifyRow(kurs("b", 0.9, "2026-10-15"), TODAY).naehe).toBe(7);
    expect(classifyRow(kurs("c", 0.9, "2026-09-01", true), TODAY)).toEqual({
      score: 0.9,
      course: true,
      state: "laufend",
      naehe: 0,
    });
    expect(classifyRow(kurs("d", 0.9, "2026-09-01", null), TODAY).state).toBe(
      "laufend"
    );
    // bookable=false = Warteliste/ausgebucht (Kufer-Status 4): läuft noch,
    // ohne Nähe (rückt nie als „früher“ nach)
    expect(classifyRow(kurs("e", 0.9, "2026-09-01", false), TODAY)).toEqual({
      score: 0.9,
      course: true,
      state: "warteliste",
      naehe: null,
    });
    // zukünftig bleibt zukünftig, auch wenn nicht buchbar (Definition Issue §2.2)
    expect(classifyRow(kurs("f", 0.9, "2026-11-01", false), TODAY).state).toBe(
      "zukuenftig"
    );
    expect(classifyRow(info("g", 0.9), TODAY)).toEqual({
      score: 0.9,
      course: false,
      state: "kein-kurs",
      naehe: null,
    });
  });
});

describe("selectContexts — Akzeptanzkriterien AK-1 bis AK-6", () => {
  test("franzoesisch-gleichstand", () => {
    const c = [
      kurs("k1", 1.0, "2027-01-05"),
      kurs("k2", 1.0, "2026-11-25"),
      kurs("k3", 1.0, "2026-11-03"),
      kurs("k4", 1.0, "2026-11-30"),
      kurs("k5", 1.0, "2026-10-26"),
      kurs("k6", 0.95, "2026-12-15"),
    ];
    const out = run(c);
    // k1/k2 fest, dazu 03.11. und 26.10. — Ausgabe in Score-/Pool-Reihenfolge
    expect(ids(out.selected)).toEqual(["k1", "k2", "k3", "k5"]);
    expect(out.active).toBe(true);
    expect(ids(out.swappedIn.map((s) => s.row))).toEqual(["k5"]);
    expect(out.swappedIn[0]).toMatchObject({ score: 1.0, naehe: 18 });
    expect(ids(out.swappedOut.map((s) => s.row))).toEqual(["k4"]);
    expect(out.swappedOut[0].reason).toBe("datum");
  });

  test("kein-verwaessern", () => {
    const c = [
      kurs("k1", 0.13, "2026-11-02"),
      kurs("k2", 0.02, "2027-01-23"),
      kurs("k3", 0.01, "2026-09-14"),
      kurs("k4", 0.01, "2026-10-05"),
      kurs("k5", 0.009, "2026-10-09"),
      kurs("k6", 0.008, "2026-10-08"),
    ];
    // k5/k6 starten früher (k6 heute), liegen aber unter dem Boden → nie einwechseln.
    const sorted = [...c].sort((a, b) => b.rerank_score - a.rerank_score);
    const out = run(sorted);
    expect(ids(out.selected)).toEqual(ids(sorted.slice(0, 4)));
    expect(out.swappedIn).toEqual([]);
    expect(out.changed).toBe(false);
  });

  test("boden-im-band: Top-Score 0,35 → Kurs mit 0,29 (Start morgen) bleibt draußen", () => {
    // Band reicht bis 0,25, der Boden 0,3 schneidet darüber ab — der
    // morgen startende Kurs (0,29) liegt im Band, aber unter dem Boden.
    const c = [
      kurs("k1", 0.35, "2027-03-01"),
      kurs("k2", 0.34, "2027-02-01"),
      kurs("k3", 0.33, "2027-01-15"),
      kurs("k4", 0.32, "2026-12-20"),
      kurs("morgen", 0.29, "2026-10-09"),
    ];
    const out = run(c);
    expect(out.active).toBe(true);
    expect(ids(out.selected)).toEqual(["k1", "k2", "k3", "k4"]);
    expect(out.swappedIn).toEqual([]);
    expect(out.changed).toBe(false);
  });

  test("boden-im-band: Top-Score 0,25 (alles unter dem Boden) → unverändert", () => {
    // Band reicht bis 0,15 und enthält alle Kurse — trotzdem wird kein Kurs
    // < 0,3 eingewechselt, auch nicht der morgen startende (0,20).
    const c = [
      kurs("k1", 0.25, "2027-03-01"),
      kurs("k2", 0.24, "2027-02-01"),
      kurs("k3", 0.23, "2027-01-15"),
      kurs("k4", 0.22, "2026-12-20"),
      kurs("morgen", 0.2, "2026-10-09"),
    ];
    const out = run(c);
    expect(out.active).toBe(true);
    expect(ids(out.selected)).toEqual(["k1", "k2", "k3", "k4"]);
    expect(out.swappedIn).toEqual([]);
    expect(out.changed).toBe(false);
  });

  test("laufend-und-vorbei", () => {
    // AK-3 (Fassung 08.10.): B läuft und ist buchbar (Nähe 0), C läuft mit
    // Warteliste (bookable=false, Nähe null) — C bleibt auf Score-Platz 3.
    const c = [
      kurs("A", 0.9, "2026-11-20"),
      kurs("B", 0.88, "2026-09-01", true),
      kurs("C", 0.87, "2026-09-01", false),
      kurs("D", 0.86, "2026-10-15"),
      kurs("E", 0.85, "2026-12-01"),
    ];
    const out = run(c);
    expect(ids(out.selected)).toEqual(["A", "B", "C", "D"]);
    expect(classifyRow(c[1], TODAY)).toMatchObject({
      state: "laufend",
      naehe: 0,
    });
    expect(classifyRow(c[2], TODAY)).toMatchObject({
      state: "warteliste",
      naehe: null,
    });
    expect(out.swappedOut).toEqual([]);
    expect(out.changed).toBe(false);
  });

  test("laufend-und-vorbei Gegenprobe: Warteliste auf Platz 6 wird nicht eingewechselt", () => {
    // Mit Nähe 0 stünde C vor allen anderen im Band und würde E verdrängen —
    // als Warteliste (Nähe null) rückt C nie als „früher“ nach.
    const c = [
      kurs("A", 0.9, "2026-11-20"),
      kurs("B", 0.88, "2026-09-01", true),
      kurs("D", 0.86, "2026-10-15"),
      kurs("E", 0.85, "2026-12-01"),
      kurs("F", 0.845, "2026-12-10"),
      kurs("C", 0.84, "2026-09-01", false),
    ];
    const out = run(c);
    expect(ids(out.selected)).toEqual(["A", "B", "D", "E"]);
    expect(out.swappedIn).toEqual([]);
    expect(out.changed).toBe(false);
  });

  test("Warteliste-Kurs der Top-N wird nie gegen einen früheren getauscht", () => {
    // Messfall demo-next 08.10.: Warteliste-Kurs (Score 0,997, gestartet)
    // blieb draußen, ein Firmenkurs (0,995, Start in 26 Tagen) kam rein.
    const c = [
      kurs("K1", 0.999, "2026-12-01"),
      kurs("K2", 0.998, "2026-12-02"),
      kurs("excel-warteliste", 0.997, "2026-09-20", false),
      kurs("K3", 0.996, "2026-12-03"),
      kurs("firmenkurs", 0.995, "2026-11-03"),
      kurs("K4", 0.994, "2026-10-20"),
    ];
    const out = run(c);
    // Warteliste bleibt; K3 (später) wird gegen K4 (12 Tage) getauscht
    expect(ids(out.selected)).toEqual(["K1", "K2", "excel-warteliste", "K4"]);
    expect(out.swappedOut.map((s) => [s.row.id, s.reason])).toEqual([
      ["K3", "datum"],
    ]);
    expect(out.swappedIn.map((s) => [s.row.id, s.reason])).toEqual([
      ["K4", "datum"],
    ]);
  });

  test("Warteliste bleibt in der Top-N — auch bei Infofragen und < 3 Kursen", () => {
    const c = [
      info("i1", 0.9),
      kurs("w1", 0.85, "2026-09-01", false),
      info("i2", 0.8),
      kurs("w2", 0.7, "2026-08-01", false),
      info("i3", 0.6),
      info("i4", 0.5),
    ];
    const out = run(c);
    expect(out.active).toBe(true);
    expect(out.courseQuery).toBe(false);
    expect(ids(out.selected)).toEqual(["i1", "w1", "i2", "w2"]);
    expect(out.changed).toBe(false);
  });

  test("Warteliste zählt für die Kursfrage mit", () => {
    // 1 buchbarer + 2 Warteliste-Kurse ≥ Boden → Kursfrage, Deckel greift
    const c = [
      kurs("K1", 0.9, "2026-11-01"),
      info("U1", 0.85),
      info("U2", 0.8),
      kurs("w1", 0.75, "2026-09-01", false),
      kurs("w2", 0.5, "2026-09-02", false),
    ];
    const out = run(c);
    expect(out.courseQuery).toBe(true);
    expect(ids(out.selected)).toEqual(["K1", "U1", "w1", "w2"]);
    expect(out.swappedOut.map((s) => [s.row.id, s.reason])).toEqual([
      ["U2", "deckel"],
    ]);
    expect(out.swappedIn.map((s) => [s.row.id, s.reason])).toEqual([
      ["w2", "deckel"],
    ]);
  });

  test("deckel-kursfrage", () => {
    const c = [
      kurs("K1", 0.98, "2026-11-01"),
      kurs("K2", 0.96, "2026-11-01"),
      info("U1", 0.96),
      info("U2", 0.95),
      kurs("K3", 0.94, "2026-11-01"),
      kurs("K4", 0.93, "2026-11-01"),
    ];
    const out = run(c);
    expect(ids(out.selected)).toEqual(["K1", "K2", "U1", "K3"]);
    expect(out.courseQuery).toBe(true);
    expect(out.swappedOut).toEqual([
      expect.objectContaining({ kind: "info", reason: "deckel" }),
    ]);
    expect(out.swappedIn[0]).toMatchObject({ kind: "kurs", score: 0.94 });
  });

  test("Deckel ersetzt nur durch Kurse ≥ Boden — sonst bleiben Übersichten", () => {
    const c = [
      kurs("K1", 0.9, "2026-11-01"),
      info("U1", 0.85),
      info("U2", 0.8),
      info("U3", 0.7),
      kurs("K2", 0.6, "2026-11-01"),
      kurs("K3", 0.5, "2026-11-01"),
      kurs("K4", 0.29, "2026-10-09"),
    ];
    const out = run(c);
    // 3 Kurse ≥ 0,3 → Kursfrage; nur K2, K3 sind ersetzbar, K4 (< Boden) nicht
    expect(ids(out.selected)).toEqual(["K1", "U1", "K2", "K3"]);
    // topN 5, nur EIN ersetzbarer Kurs ≥ Boden → zwei Übersichten bleiben
    const few = [
      kurs("K1", 0.95, "2026-11-01"),
      kurs("K2", 0.94, "2026-11-01"),
      info("U1", 0.9),
      info("U2", 0.85),
      info("U3", 0.8),
      kurs("K3", 0.5, "2026-11-01"),
      kurs("K4", 0.2, "2026-10-09"),
    ];
    expect(ids(run(few, 5).selected)).toEqual(["K1", "K2", "U1", "U2", "K3"]);
  });

  test("kursfrage-grenze: genau 2 Kurse ≥ Boden → keine Kursfrage, Übersichten bleiben", () => {
    // K2 (0,5) läge als Ersatz bereit — ohne Kursfrage greift der Deckel nicht.
    const c = [
      kurs("K1", 0.9, "2026-11-01"),
      info("U1", 0.85),
      info("U2", 0.8),
      info("U3", 0.75),
      kurs("K2", 0.5, "2026-11-01"),
      kurs("K3", 0.29, "2026-10-09"),
    ];
    const out = run(c);
    expect(out.active).toBe(true);
    expect(out.courseQuery).toBe(false);
    expect(ids(out.selected)).toEqual(["K1", "U1", "U2", "U3"]);
    expect(out.changed).toBe(false);
  });

  test("kursfrage-grenze: genau 3 Kurse ≥ Boden → Deckel greift", () => {
    const c = [
      kurs("K1", 0.9, "2026-11-01"),
      info("U1", 0.85),
      info("U2", 0.8),
      info("U3", 0.75),
      kurs("K2", 0.5, "2026-11-01"),
      kurs("K3", 0.3, "2026-11-01"), // genau auf dem Boden
    ];
    const out = run(c);
    expect(out.courseQuery).toBe(true);
    expect(ids(out.selected)).toEqual(["K1", "U1", "K2", "K3"]);
    expect(out.swappedOut.map((s) => [s.row.id, s.reason])).toEqual([
      ["U2", "deckel"],
      ["U3", "deckel"],
    ]);
  });

  test("kein-deckel-infofrage", () => {
    const c = [
      info("I1", 0.9),
      info("I2", 0.85),
      kurs("K1", 0.4, "2026-11-01"),
      info("I3", 0.3),
      kurs("K2", 0.2, "2026-10-09"),
    ];
    const out = run(c);
    expect(ids(out.selected)).toEqual(["I1", "I2", "K1", "I3"]);
    expect(out.courseQuery).toBe(false);
    expect(out.changed).toBe(false);
  });

  test("degradiert: ohne Scores identisch (inkl. Reihenfolge, Referenzen)", () => {
    const c = [
      kurs("k1", undefined, "2027-01-05"),
      kurs("k2", undefined, "2026-11-25", false),
      kurs("k3", undefined, "2026-10-09"),
      info("i1", undefined),
      kurs("k4", undefined, "2026-10-10"),
    ];
    const out = run(c);
    expect(out.active).toBe(false);
    expect(out.reason).toBe("degraded");
    expect(out.selected).toEqual(c.slice(0, 4));
    out.selected.forEach((r, i) => expect(r).toBe(c[i]));
  });

  test("ohne Metadaten / < 2 Kurse: identisch", () => {
    const plain = [0.9, 0.8, 0.7, 0.6, 0.5].map((s, i) => ({
      id: `d${i}`,
      rerank_score: s,
      text: "x",
    }));
    const out = run(plain);
    expect(out.reason).toBe("few_courses");
    expect(out.selected).toEqual(plain.slice(0, 4));
    const one = [info("i1", 0.9), kurs("k1", 0.9, "2026-12-01")].concat(plain);
    expect(run(one).selected).toEqual(one.slice(0, 4));
  });
});

describe("selectContexts — Negativfälle", () => {
  test("NAK-1: genau topN, wenn der Pool reicht", () => {
    const c = [
      kurs("K1", 0.98, "2026-11-01"),
      info("U1", 0.97),
      info("U2", 0.96),
      info("U3", 0.95),
      kurs("K2", 0.9, "2026-10-09"),
      kurs("K3", 0.9, "2026-10-10"),
      kurs("K4", 0.9, "2026-10-11"),
      kurs("K5", 0.9, "2026-10-12"),
    ];
    for (const topN of [1, 2, 3, 4, 6, 8, 10]) {
      expect(run(c, topN).selected).toHaveLength(Math.min(topN, c.length));
    }
    expect(ids(run(c).selected)).toEqual(["K1", "U1", "K2", "K3"]);
  });

  test("NAK-2: Laufzeit < 2 ms für 50 Kandidaten (Mittel aus 100 Läufen)", () => {
    const c = Array.from({ length: 50 }, (_, i) =>
      i % 3 === 0
        ? info(`i${i}`, 1 - i / 100)
        : kurs(
            `k${i}`,
            1 - i / 100,
            `2026-${String(10 + (i % 3)).padStart(2, "0")}-${String(
              1 + (i % 28)
            ).padStart(2, "0")}`,
            i % 7 === 0 ? false : true
          )
    );
    for (let i = 0; i < 10; i++) run(c); // Aufwärmen
    const start = process.hrtime.bigint();
    for (let i = 0; i < 100; i++) run(c);
    const meanMs = Number(process.hrtime.bigint() - start) / 1e6 / 100;
    expect(meanMs).toBeLessThan(2);
  });

  test("NAK-3: keine Mutation, keine Ausnahme bei kaputten Daten", () => {
    const c = [
      kurs("k1", 0.9, "2026-11-01"),
      { id: "x1", rerank_score: NaN, start_date: "", bookable: null },
      { id: "x2", rerank_score: 0.85, start_date: "kaputt", bookable: "ja" },
      kurs("k2", 0.8, "2026-02-31"),
      null,
      "string",
      kurs("k3", 0.85, "2026-10-09"),
      kurs("k4", 0.84, "2026-10-10"),
      JSON.parse(
        '{"__proto__":{"polluted":1},"id":"p","rerank_score":0.83,"start_date":"2026-10-10"}'
      ),
    ];
    const frozen = JSON.stringify(c);
    let out;
    expect(() => (out = run(c))).not.toThrow();
    expect(JSON.stringify(c)).toBe(frozen);
    expect(out.selected).toHaveLength(4);
    expect(classifyRow(c[1], TODAY)).toMatchObject({
      score: null,
      course: false,
    });
    expect(classifyRow(c[3], TODAY).course).toBe(false); // 31.02. ungültig
    expect(() => selectContexts(null, { topN: 4, today: TODAY })).not.toThrow();
    expect(selectContexts(undefined, {}).selected).toEqual([]);
    expect(run(c, NaN).selected).toEqual([]);
    expect(selectContexts(c, { topN: 4, today: "gestern" }).selected).toEqual(
      c.slice(0, 4)
    );
    expect({}.polluted).toBeUndefined();
  });

  test("NAK-4: Zeitfenster ohne Band-Gleichstand → Menge unverändert", () => {
    const c = [
      kurs("k1", 0.95, "2026-12-01"),
      kurs("k2", 0.8, "2026-11-01"),
      kurs("k3", 0.7, "2026-10-20"),
      kurs("k4", 0.6, "2026-10-12"),
      kurs("k5", 0.5, "2026-10-09"),
    ];
    const out = run(c);
    expect(ids(out.selected)).toEqual(["k1", "k2", "k3", "k4"]);
    expect(out.changed).toBe(false);
  });

  test("Band: gleiche Nähe → der höhere Score gewinnt (unabhängig von der Pool-Reihenfolge)", () => {
    const c = [
      kurs("k1", 0.9, "2027-06-01"),
      kurs("k2", 0.89, "2027-05-01"),
      kurs("niedrig", 0.84, "2026-10-13"),
      kurs("hoch", 0.85, "2026-10-13"),
    ];
    const out = run(c, 3);
    expect(ids(out.selected)).toEqual(["k1", "k2", "hoch"]);
    expect(ids(out.swappedOut.map((s) => s.row))).toEqual(["niedrig"]);
  });

  test("Hard Constraint: kein Kurs fällt ohne früheren Ersatz heraus (2000 Zufallspools)", () => {
    // deterministischer Pseudo-Zufall (LCG), Pools in Reranker-Reihenfolge
    let seed = 20261008;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const day = (offset) => {
      const d = new Date(`${TODAY}T12:00:00Z`);
      d.setUTCDate(d.getUTCDate() + offset);
      return d.toISOString().slice(0, 10);
    };
    for (let t = 0; t < 2000; t++) {
      const size = 2 + Math.floor(rnd() * 14);
      const rows = Array.from({ length: size }, (_, i) => {
        const score = Math.round(rnd() * 20) / 20; // viele Gleichstände
        const r = rnd();
        if (r < 0.25) return info(`i${i}`, score);
        const offset = Math.floor(rnd() * 120) - 40;
        const bookable = rnd() < 0.3 ? false : rnd() < 0.5 ? null : true;
        return kurs(`k${i}`, score, day(offset), bookable);
      }).sort((a, b) => b.rerank_score - a.rerank_score);
      const topN = 1 + Math.floor(rnd() * 6);
      const out = run(rows, topN);
      const baseline = rows.slice(0, topN);
      expect(out.selected).toHaveLength(baseline.length);
      if (!out.active) {
        expect(out.selected).toEqual(baseline);
        continue;
      }
      expectNoDrop(out, baseline);
      // Warteliste der Top-N bleibt immer drin
      for (const r of baseline)
        if (classifyRow(r, TODAY).state === "warteliste")
          expect(out.selected).toContain(r);
    }
  });

  test("Die K relevantesten bleiben auch bei späterem Start fest", () => {
    const c = [
      kurs("spaet1", 0.99, "2027-06-01"),
      kurs("spaet2", 0.98, "2027-05-01"),
      kurs("frueh1", 0.97, "2026-10-09"),
      kurs("frueh2", 0.96, "2026-10-10"),
      kurs("frueh3", 0.95, "2026-10-08"),
    ];
    const out = run(c);
    // fest: spaet1/spaet2; Band: frueh3 (heute) und frueh1 (morgen)
    expect(ids(out.selected)).toEqual(["spaet1", "spaet2", "frueh1", "frueh3"]);
  });
});

describe("selectContexts — Replay der Messdaten (AK-9)", () => {
  const FIXTURES = path.join(__dirname, "fixtures");
  // Kandidaten der Messung → Reranker-Zeilen (Kurs = kurs:true mit Beginn).
  const toRows = (kandidaten) =>
    kandidaten.map((k) => ({
      id: `${k.rang}:${k.titel}`,
      title: k.titel,
      rerank_score: k.score,
      start_date: k.kurs && k.beginn ? k.beginn : null,
      bookable: k.kurs && k.beginn ? k.buchbar : null,
    }));
  const load = (file) =>
    fs
      .readFileSync(path.join(FIXTURES, file), "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));

  const POOL = 12;
  const summary = (stats) => {
    const by = (list, reason) => list.filter((s) => s.reason === reason).length;
    return (
      `gültig ${stats.valid}/${stats.lists} (degradiert ${stats.degraded}), ` +
      `geändert ${stats.changed}, ` +
      `Tausch datum ${by(stats.swappedOut, "datum")}, ` +
      `deckel ${by(stats.swappedOut, "deckel")}, ` +
      `Top-1/Top-2 behalten ${stats.top12kept}/${stats.valid}, ` +
      `Tausch-Lesart ${stats.earlierSwap}/${stats.valid}, ` +
      `streng (frühester gezeigter Kurs früher) ${stats.earlier}/${stats.valid}`
    );
  };
  const replay = (file) => {
    const stats = {
      lists: 0,
      valid: 0,
      earlier: 0,
      earlierSwap: 0,
      degraded: 0,
      changed: 0,
      top12kept: 0,
      swappedIn: [],
      swappedOut: [],
    };
    for (const entry of load(file)) {
      stats.lists += 1;
      // Produktionspool: der Reranker liefert topK = max(topN, 12) Zeilen.
      const rows = toRows(entry.kandidaten).slice(0, POOL);
      const out = selectContexts(rows, { topN: 4, today: TODAY });
      const info = rows.map((r) => classifyRow(r, TODAY));
      if (!info.some((i) => i.score !== null)) {
        // degradierte Liste (Parallel-Lauf ohne Scores) → identisch
        expect(out.selected).toEqual(rows.slice(0, 4));
        stats.degraded += 1;
        continue;
      }
      stats.valid += 1;
      if (out.changed) stats.changed += 1;
      const chosen = new Set(out.selected);
      const baseline = rows.slice(0, 4);
      // Top-1/Top-2-Kurs (nach Score) aus den Top-4 bleiben
      const liveCourses = rows
        .map((r, i) => ({ r, i: info[i] }))
        .filter(({ i }) => i.course && i.score !== null)
        .sort((a, b) => b.i.score - a.i.score);
      let kept = true;
      for (const { r } of liveCourses.slice(0, 2))
        if (baseline.includes(r)) {
          expect(chosen.has(r)).toBe(true);
          kept = kept && chosen.has(r);
        }
      if (kept) stats.top12kept += 1;
      // nie ein eingewechselter Kurs unter dem Boden, nie Warteliste per Datum
      for (const s of out.swappedIn) {
        if (s.kind === "kurs") expect(s.score).toBeGreaterThanOrEqual(0.3);
        if (s.reason === "datum") expect(s.naehe).not.toBeNull();
        stats.swappedIn.push(s);
      }
      for (const s of out.swappedOut) stats.swappedOut.push(s);
      expectNoDrop(out, baseline);
      expect(out.selected).toHaveLength(Math.min(4, rows.length));
      // früherer Kurs als in der Score-Top-4?
      const nearest = (list) => {
        const n = list
          .map((r) => classifyRow(r, TODAY))
          .filter((c) => c.course && c.naehe !== null)
          .map((c) => c.naehe);
        return n.length ? Math.min(...n) : null;
      };
      const before = nearest(baseline);
      const after = nearest(out.selected);
      if (before !== null && after !== null && after < before)
        stats.earlier += 1;
      // Tausch-Lesart (AK-9): ein später startender Kurs der Score-Top-4 wird
      // durch einen früher startenden aus dem Pool ersetzt.
      const outDates = out.swappedOut
        .filter((s) => s.reason === "datum")
        .map((s) => s.naehe);
      if (
        outDates.length > 0 &&
        out.swappedIn.some(
          (s) => s.kind === "kurs" && s.naehe < Math.max(...outDates)
        )
      )
        stats.earlierSwap += 1;
    }
    return stats;
  };

  test("replay-intern", () => {
    const stats = replay("kandidaten_intern_20261008_0657.jsonl");
    expect(stats.lists).toBe(40);
    expect(stats.valid).toBe(40);
    // AK-9 (Tausch-Lesart): in ≥ 2 Listen ersetzt ein früher startender Kurs
    // aus dem Pool einen später startenden der Score-Top-4.
    expect(stats.earlierSwap).toBeGreaterThanOrEqual(2);
    // Strengere Lesart „frühester gezeigter Kurs startet früher“ — nur als
    // Info, kein Kriterium (trifft auf diesen Daten 1/40, weil die Regeln aus
    // §2 dort keinen weiteren Tausch zulassen).
    console.info(`replay-intern: ${summary(stats)}`);
  });

  test("replay-intern-degradiert", () => {
    const stats = replay("kandidaten_intern_20261008.jsonl");
    expect(stats.lists).toBe(40);
    expect(stats.valid).toBe(17);
    console.info(`replay-intern-degradiert: ${summary(stats)}`);
  });

  test("Hard Constraint: die Stufe entfernt nie einen Kurs aus der Score-Top-N (beide Fixtures)", () => {
    for (const file of [
      "kandidaten_intern_20261008_0657.jsonl",
      "kandidaten_intern_20261008.jsonl",
    ]) {
      const stats = replay(file);
      // jedes ausgewechselte Dokument hat ein eingewechseltes Gegenstück
      // mit demselben Grund (datum oder deckel); kein Grund „vorbei“ mehr
      expect(stats.swappedOut.length).toBe(stats.swappedIn.length);
      for (const reason of ["datum", "deckel"])
        expect(stats.swappedOut.filter((s) => s.reason === reason).length).toBe(
          stats.swappedIn.filter((s) => s.reason === reason).length
        );
      for (const s of [...stats.swappedOut, ...stats.swappedIn])
        expect(["datum", "deckel"]).toContain(s.reason);
      expect(stats.top12kept).toBe(stats.valid);
    }
  });
});
