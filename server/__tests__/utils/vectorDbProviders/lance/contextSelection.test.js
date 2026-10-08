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
    expect(classifyRow(kurs("e", 0.9, "2026-09-01", false), TODAY).state).toBe(
      "vorbei"
    );
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

  test("laufend-und-vorbei", () => {
    const c = [
      kurs("A", 0.9, "2026-11-20"),
      kurs("B", 0.88, "2026-09-01", true),
      kurs("C", 0.87, "2026-09-01", false),
      kurs("D", 0.86, "2026-10-15"),
    ];
    const out = run(c);
    expect(ids(out.selected)).toEqual(["A", "B", "D"]);
    expect(classifyRow(c[1], TODAY).naehe).toBe(0);
    expect(out.swappedOut).toEqual([
      expect.objectContaining({ state: "vorbei", reason: "vorbei" }),
    ]);
  });

  test("vorbei nie ausgeliefert — auch nicht als Ersatz, auch bei < 2 Kursen", () => {
    const c = [
      info("i1", 0.9),
      kurs("alt", 0.85, "2026-09-01", false),
      info("i2", 0.8),
      kurs("alt2", 0.7, "2026-08-01", false),
      info("i3", 0.6),
      info("i4", 0.5),
    ];
    const out = run(c);
    expect(ids(out.selected)).toEqual(["i1", "i2", "i3", "i4"]);
    expect(out.selected.some((r) => r.bookable === false)).toBe(false);
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

  const replay = (file) => {
    const stats = {
      lists: 0,
      valid: 0,
      earlier: 0,
      earlierSwap: 0,
      changed: 0,
      swappedIn: [],
    };
    for (const entry of load(file)) {
      stats.lists += 1;
      const rows = toRows(entry.kandidaten);
      const out = selectContexts(rows, { topN: 4, today: TODAY });
      const info = rows.map((r) => classifyRow(r, TODAY));
      if (!info.some((i) => i.score !== null)) {
        // degradierte Liste (Parallel-Lauf ohne Scores) → identisch
        expect(out.selected).toEqual(rows.slice(0, 4));
        continue;
      }
      stats.valid += 1;
      if (out.changed) stats.changed += 1;
      const chosen = new Set(out.selected);
      const baseline = rows.slice(0, 4);
      // Top-1/Top-2-Kurs (nach Score, nicht vorbei) aus den Top-4 bleiben
      const liveCourses = rows
        .map((r, i) => ({ r, i: info[i] }))
        .filter(({ i }) => i.course && i.state !== "vorbei" && i.score !== null)
        .sort((a, b) => b.i.score - a.i.score);
      for (const { r } of liveCourses.slice(0, 2))
        if (baseline.includes(r)) expect(chosen.has(r)).toBe(true);
      // nie ein eingewechselter Kurs unter dem Boden, nie vorbei
      for (const s of out.swappedIn) {
        if (s.kind === "kurs") expect(s.score).toBeGreaterThanOrEqual(0.3);
        stats.swappedIn.push(s);
      }
      expect(
        out.selected.some((r) => classifyRow(r, TODAY).state === "vorbei")
      ).toBe(false);
      expect(out.selected).toHaveLength(Math.min(4, rows.length));
      // früherer Kurs als in der Score-Top-4?
      const nearest = (list) => {
        const n = list
          .map((r) => classifyRow(r, TODAY))
          .filter((c) => c.course && c.state !== "vorbei")
          .map((c) => c.naehe);
        return n.length ? Math.min(...n) : null;
      };
      const before = nearest(baseline);
      const after = nearest(out.selected);
      if (before !== null && after !== null && after < before)
        stats.earlier += 1;
      // Tausch: ein eingewechselter Kurs startet früher als ein ausgewechselter
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
    // AK-9: in ≥ 2 Listen ersetzt ein früherer Kurs einen späteren aus der
    // Score-Top-4 (gemessen: 5 — Fragen 4, 12, 17, 26, 37).
    expect(stats.earlierSwap).toBeGreaterThanOrEqual(2);
    // Strengere Lesart „frühester gezeigter Kurs startet früher“: 1 Liste
    // (Frage 4: 27 → 4 Tage). Die Analyse (2/37) zählte zusätzlich Frage 27,
    // deren zweiter Kurs (0,56) nach §2.4 keine Übersicht verdrängen darf.
    expect(stats.earlier).toBeGreaterThanOrEqual(1);
  });

  test("replay-intern-degradiert", () => {
    const stats = replay("kandidaten_intern_20261008.jsonl");
    expect(stats.lists).toBe(40);
    expect(stats.valid).toBe(17);
  });
});
