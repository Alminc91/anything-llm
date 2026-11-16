/* eslint-env jest, node */
/**
 * Auswahlstufe hinter dem Reranker: Stufenregel „erst Relevanz, dann Datum“
 * (Spezifikation issues/kursauswahl-relevanz-datum.md, AK-1 bis AK-5,
 * NAK-1 bis NAK-3). Platz für Platz ist der bestbewertete noch freie Kurs der
 * Führende; gleich relevant sind noch freie Kurse bis SPANNE darunter; unter
 * ihnen gewinnt künftig und buchbar (frühester Beginn), dann laufend, dann
 * Warteliste oder ausgebucht, bei gleichem Rang der höhere Score.
 */
const fs = require("fs");
const path = require("path");
const {
  SELECTION_TIE_SPAN,
  SELECTION_FLOOR,
  classifyRow,
  selectContexts,
  selectionConfig,
  parseIsoDay,
  berlinToday,
} = require("../../../../utils/vectorDbProviders/lance/contextSelection");
const {
  mergeCourseNumberHits,
} = require("../../../../utils/vectorDbProviders/lance/courseNumberLookup");

const MODULE = "../../../../utils/vectorDbProviders/lance/contextSelection";
const TODAY = "2026-10-08";
const SPAN = 0.02;
const FLOOR = 0.3;
const EPS = 1e-9;

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
const run = (candidates, topN = 4, settings, today = TODAY) =>
  selectContexts(candidates, { topN, today, settings });
const byScoreDesc = (rows) =>
  [...rows].sort((a, b) => b.rerank_score - a.rerank_score);

// Zeitliche Priorität unter gleich relevanten Kursen (AK-1, D7): ist a strikt
// vor b? Innerhalb einer Stufe zuerst die mit künftigem Beginn (früheste
// zuerst), dann die begonnenen (Nähe null); laufende haben alle Nähe 0.
const RANK = { zukuenftig: 0, laufend: 1, warteliste: 2 };
const strictlyBefore = (a, b) => {
  if (RANK[a.state] !== RANK[b.state]) return RANK[a.state] < RANK[b.state];
  if (a.naehe !== b.naehe) {
    if (a.naehe === null) return false;
    if (b.naehe === null) return true;
    return a.naehe < b.naehe;
  }
  return a.score > b.score;
};

/**
 * Prüft ein aktives oder inaktives Ergebnis gegen die Stufenregel, direkt an
 * der Ausgabe (ohne die Regel nachzubauen):
 * - Länge und Referenzen; inaktiv = die ersten topN Kandidaten (Rückfall);
 * - AK-2: kein gewählter Kurs vor einem späteren oder nicht gewählten Kurs
 *   mit mehr als SPANNE höherem Score;
 * - AK-1: jeder Kursplatz hat unter den gleich relevanten noch freien Kursen
 *   (Score ≥ Führender − SPANNE und ≥ Boden) keinen zeitlich vorrangigen
 *   Konkurrenten; unter dem Boden reine Score-Folge;
 * - Boden: kein Kurs unter dem Boden kommt von außerhalb der Top-N hinein;
 * - NAK-3 (Regel 3 wie bisher): Anzahl und Auswahl der Nicht-Kurs-Dokumente;
 * - Nicht-Kurs-Dokumente behalten ihren Platz in der Kandidatenreihenfolge;
 * - Tausch-Buchhaltung (`swappedIn`/`swappedOut`, `changed`, `reordered`).
 * @returns {object[]} die Kursfolge der Ausgabe
 */
function expectStepRule(
  out,
  rows,
  { topN = 4, today = TODAY, span = SPAN, floor = FLOOR } = {}
) {
  const n = Math.min(topN, rows.length);
  expect(out.selected).toHaveLength(n);
  expect(new Set(out.selected).size).toBe(n);
  for (const r of out.selected) expect(rows).toContain(r);
  if (!out.active) {
    expect(out.selected).toEqual(rows.slice(0, n));
    out.selected.forEach((r, i) => expect(r).toBe(rows[i]));
    return [];
  }
  const cls = new Map(rows.map((r) => [r, classifyRow(r, today)]));
  const isCourse = (r) => cls.get(r).course && cls.get(r).score !== null;
  const score = (r) => cls.get(r).score;
  const base = rows.slice(0, n);
  const inBase = new Set(base);
  const chosen = new Set(out.selected);
  const eligible = rows.filter(
    (r) => isCourse(r) && (inBase.has(r) || score(r) >= floor)
  );
  const seq = out.selected.filter(isCourse);
  for (const r of seq) expect(eligible).toContain(r);

  // AK-2
  const notChosen = rows.filter((r) => isCourse(r) && !chosen.has(r));
  seq.forEach((r, k) => {
    for (const x of [...seq.slice(k + 1), ...notChosen])
      expect(score(x)).toBeLessThanOrEqual(score(r) + span + EPS);
  });

  // AK-1 und Boden
  let rest = [...eligible];
  for (const pick of seq) {
    const leader = Math.max(...rest.map(score));
    if (leader < floor) {
      expect(score(pick)).toBe(leader);
    } else {
      expect(score(pick)).toBeGreaterThanOrEqual(
        Math.max(leader - span - EPS, floor)
      );
      const group = rest.filter(
        (r) => score(r) >= leader - span - EPS && score(r) >= floor
      );
      for (const x of group)
        expect(strictlyBefore(cls.get(x), cls.get(pick))).toBe(false);
    }
    rest = rest.filter((r) => r !== pick);
  }

  // NAK-3: Regel 3 unverändert
  const others = (list) => list.filter((r) => !isCourse(r));
  const baseOthers = others(base).length;
  const baseCourses = base.length - baseOthers;
  const courseQuery =
    rows.filter((r) => isCourse(r) && score(r) >= floor).length >= 3;
  expect(out.courseQuery).toBe(courseQuery);
  const expectedOthers =
    courseQuery && baseOthers > 1
      ? baseOthers - Math.min(baseOthers - 1, eligible.length - baseCourses)
      : baseOthers;
  expect(others(out.selected)).toEqual(others(base).slice(0, expectedOthers));

  // Nicht-Kurs-Dokumente auf ihrem Platz, Kursplätze in Stufenfolge
  const reference = rows.filter((r) => chosen.has(r));
  reference.forEach((r, i) => {
    if (!isCourse(r)) expect(out.selected[i]).toBe(r);
  });
  expect(out.reordered).toBe(reference.some((r, i) => out.selected[i] !== r));

  // Tausch-Buchhaltung
  const outs = base.filter((r) => !chosen.has(r));
  const ins = out.selected.filter((r) => !inBase.has(r));
  expect(out.swappedOut.map((s) => s.row)).toEqual(outs);
  expect(out.swappedIn.map((s) => s.row)).toEqual(ins);
  for (const s of out.swappedOut)
    expect(s.reason).toBe(isCourse(s.row) ? "datum" : "deckel");
  for (const reason of ["datum", "deckel"])
    expect(out.swappedIn.filter((s) => s.reason === reason).length).toBe(
      out.swappedOut.filter((s) => s.reason === reason).length
    );
  expect(out.changed).toBe(outs.length + ins.length > 0);
  return seq;
}

describe("Konstanten und Konfiguration", () => {
  test("Standardwerte: Spanne 0,02, Boden 0,3", () => {
    expect([SELECTION_TIE_SPAN, SELECTION_FLOOR]).toEqual([0.02, 0.3]);
    expect(selectionConfig({})).toEqual({ span: 0.02, floor: 0.3 });
  });

  test("Env COURSE_SELECTION_TIE_SPAN und _FLOOR, Ungültiges → Standard", () => {
    expect(
      selectionConfig({
        COURSE_SELECTION_TIE_SPAN: "0.05",
        COURSE_SELECTION_FLOOR: "0.5",
      })
    ).toEqual({ span: 0.05, floor: 0.5 });
    // Spanne 0 ist der Rückweg auf exakten Gleichstand (Entscheidung D1)
    expect(selectionConfig({ COURSE_SELECTION_TIE_SPAN: "0" }).span).toBe(0);
    expect(selectionConfig({ COURSE_SELECTION_TIE_SPAN: " 0.01 " }).span).toBe(
      0.01
    );
    expect(selectionConfig({ COURSE_SELECTION_TIE_SPAN: "1" }).span).toBe(1);
    for (const bad of [
      "zwei",
      "-0.01",
      "1.5",
      "",
      "   ",
      "0,05",
      "NaN",
      "Infinity",
      "0x10",
    ])
      expect(
        selectionConfig({
          COURSE_SELECTION_TIE_SPAN: bad,
          COURSE_SELECTION_FLOOR: bad,
        })
      ).toEqual({ span: 0.02, floor: 0.3 });
    expect(selectionConfig(undefined)).toEqual({ span: 0.02, floor: 0.3 });
  });

  test("Spanne aus den settings; ungültige settings → Standard", () => {
    const c = [
      kurs("april", 0.99, "2027-04-01"),
      kurs("morgen", 0.96, "2026-10-09"),
    ];
    expect(ids(run(c, 2).selected)).toEqual(["april", "morgen"]);
    expect(ids(run(c, 2, { span: 0.05 }).selected)).toEqual([
      "morgen",
      "april",
    ]);
    for (const bad of [-1, 2, NaN, "0.05", null])
      expect(ids(run(c, 2, { span: bad }).selected)).toEqual([
        "april",
        "morgen",
      ]);
    expect(ids(run(c, 2, { span: 0 }).selected)).toEqual(["april", "morgen"]);
    expect(run(c, 2).rule).toBe("stufe-span0.02-floor0.3-deckel1");
    expect(run(c, 2, { span: 0.05, floor: 0.4 }).rule).toBe(
      "stufe-span0.05-floor0.4-deckel1"
    );
  });

  test("COURSE_SELECTION_KEEP und _BAND sind wirkungslos, Hinweis einmal im Log", () => {
    jest.isolateModules(() => {
      const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const fresh = require(MODULE);
        const env = {
          COURSE_SELECTION_KEEP: "0",
          COURSE_SELECTION_BAND: "0.5",
        };
        expect(fresh.selectionConfig(env)).toEqual({ span: 0.02, floor: 0.3 });
        fresh.selectionConfig(env);
        fresh.selectionConfig({ COURSE_SELECTION_KEEP: "3" });
        expect(warn).toHaveBeenCalledTimes(1);
        const [message] = warn.mock.calls[0];
        expect(message).toMatch(/COURSE_SELECTION_KEEP/);
        expect(message).toMatch(/COURSE_SELECTION_BAND/);
        expect(message).toMatch(/COURSE_SELECTION_TIE_SPAN/);
        expect(message).not.toMatch(/[–—]/);
      } finally {
        warn.mockRestore();
      }
    });
    jest.isolateModules(() => {
      const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const fresh = require(MODULE);
        fresh.selectionConfig({ COURSE_SELECTION_TIE_SPAN: "0.03" });
        fresh.selectionConfig({ COURSE_SELECTION_KEEP: "" });
        expect(warn).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    });
    // auch als settings ohne Wirkung
    const c = [
      kurs("a", 0.99, "2027-06-01"),
      kurs("b", 0.98, "2027-05-01"),
      kurs("c", 0.9, "2026-10-09"),
      kurs("d", 0.85, "2026-10-10"),
      kurs("e", 0.8, "2026-10-11"),
    ];
    expect(run(c, 4, { keep: 0, band: 0.5 }).selected).toEqual(run(c).selected);
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
    expect(classifyRow(kurs("d2", 0.9, "2026-11-01", null), TODAY).state).toBe(
      "zukuenftig"
    );
    // bookable=false = Warteliste/ausgebucht (Kufer-Status 4): läuft noch
    expect(classifyRow(kurs("e", 0.9, "2026-09-01", false), TODAY)).toEqual({
      score: 0.9,
      course: true,
      state: "warteliste",
      naehe: null,
    });
    expect(classifyRow(info("g", 0.9), TODAY)).toEqual({
      score: 0.9,
      course: false,
      state: "kein-kurs",
      naehe: null,
    });
  });

  test("AK-1 (c), D7: künftiger, ausgebuchter Kurs gilt als Warteliste, mit Tagen bis Start", () => {
    expect(classifyRow(kurs("f", 0.9, "2026-11-01", false), TODAY)).toEqual({
      score: 0.9,
      course: true,
      state: "warteliste",
      naehe: 24,
    });
    expect(
      classifyRow(kurs("heute", 0.9, "2026-10-08", false), TODAY)
    ).toMatchObject({ state: "warteliste", naehe: 0 });
    // begonnen: keine Nähe (null), wie bisher
    expect(
      classifyRow(kurs("gestern", 0.9, "2026-10-07", false), TODAY)
    ).toMatchObject({ state: "warteliste", naehe: null });
  });
});

describe("Stufenregel: AK-1 Gruppe der gleich relevanten", () => {
  test("Reihenfolge künftig (frühester zuerst), laufend, Warteliste; bei gleichem Rang der höhere Score", () => {
    const c = byScoreDesc([
      kurs("wl-alt", 0.99, "2026-09-01", false), // läuft, Warteliste
      kurs("lfd", 0.99, "2026-09-15"), // läuft, Einstieg möglich
      kurs("dez", 0.99, "2026-12-01"),
      kurs("wl-neu", 0.995, "2026-10-20", false), // künftig, ausgebucht
      kurs("nov", 0.98, "2026-11-01"),
      kurs("lfd-null", 0.985, "2026-09-20", null), // läuft, Status unbekannt
    ]);
    const out = run(c, 6);
    expect(ids(out.selected)).toEqual([
      "nov",
      "dez",
      "lfd",
      "lfd-null",
      "wl-neu",
      "wl-alt",
    ]);
    expectStepRule(out, c, { topN: 6 });
    // Platz für Platz: die ersten Plätze sind ein Präfix der längeren Liste
    for (const topN of [1, 2, 3, 4, 5])
      expect(ids(run(c, topN).selected)).toEqual(
        ids(out.selected).slice(0, topN)
      );
  });

  test("franzoesisch-gleichstand: vier Kurse mit Score 1,0 nach Beginn", () => {
    const c = [
      kurs("k1", 1.0, "2027-01-05"),
      kurs("k2", 1.0, "2026-11-25"),
      kurs("k3", 1.0, "2026-11-03"),
      kurs("k4", 1.0, "2026-11-30"),
      kurs("k5", 1.0, "2026-10-26"),
      kurs("k6", 0.95, "2026-12-15"),
    ];
    const out = run(c);
    expect(ids(out.selected)).toEqual(["k5", "k3", "k2", "k4"]);
    expect(out.active).toBe(true);
    expect(out.changed).toBe(true);
    expect(out.reordered).toBe(true);
    expect(out.swappedIn).toEqual([
      expect.objectContaining({ score: 1.0, naehe: 18, reason: "datum" }),
    ]);
    expect(out.swappedIn[0].row.id).toBe("k5");
    expect(ids(out.swappedOut.map((s) => s.row))).toEqual(["k1"]);
    expect(out.swappedOut[0].reason).toBe("datum");
    expectStepRule(out, c);
  });

  test("gleiche Nähe, gleicher Rang: der höhere Score gewinnt (unabhängig von der Pool-Reihenfolge)", () => {
    const c = [
      kurs("k1", 0.9, "2027-06-01"),
      kurs("k2", 0.89, "2027-05-01"),
      kurs("niedrig", 0.84, "2026-10-13"),
      kurs("hoch", 0.85, "2026-10-13"),
    ];
    const out = run(c, 3);
    // k2 (Mai) und k1 (Juni) sind gleich relevant; 0,84/0,85 liegen 0,05 tiefer
    expect(ids(out.selected)).toEqual(["k2", "k1", "hoch"]);
    expect(ids(out.swappedOut.map((s) => s.row))).toEqual(["niedrig"]);
    // exakter Gleichstand in allem: Kandidatenreihenfolge entscheidet
    const tie = [
      kurs("x", 0.9, "2026-11-01"),
      kurs("y", 0.9, "2026-11-01"),
      kurs("z", 0.9, "2026-11-01"),
    ];
    expect(ids(run(tie, 3).selected)).toEqual(["x", "y", "z"]);
    expect(run(tie, 3).reordered).toBe(false);
  });

  test("Grenze der Spanne: genau 0,02 gilt als gleich relevant, 0,0201 nicht", () => {
    const at = [
      kurs("vorn", 0.9, "2027-03-01"),
      kurs("frueh", 0.88, "2026-10-09"),
    ];
    expect(ids(run(at, 2).selected)).toEqual(["frueh", "vorn"]);
    const over = [
      kurs("vorn", 0.9, "2027-03-01"),
      kurs("frueh", 0.8799, "2026-10-09"),
    ];
    expect(ids(run(over, 2).selected)).toEqual(["vorn", "frueh"]);
  });

  test("laufend-und-warteliste: Warteliste weicht einem gleich relevanten künftigen Kurs", () => {
    const c = [
      kurs("A", 0.9, "2026-11-20"),
      kurs("B", 0.88, "2026-09-01", true),
      kurs("C", 0.87, "2026-09-01", false),
      kurs("D", 0.86, "2026-10-15"),
      kurs("E", 0.85, "2026-12-01"),
    ];
    const out = run(c);
    // A führt (0,88 ist laufend); dann D vor B (künftig vor laufend), B vor C;
    // für den letzten Platz führt C (0,87), E (0,85) ist künftig und gleich relevant
    expect(ids(out.selected)).toEqual(["A", "D", "B", "E"]);
    expect(out.swappedOut.map((s) => [s.row.id, s.state, s.reason])).toEqual([
      ["C", "warteliste", "datum"],
    ]);
    expectStepRule(out, c);
  });

  test("Warteliste rückt nicht vor; mit klar höherem Score bleibt sie Platz 1", () => {
    const c = [
      kurs("A", 0.9, "2026-11-20"),
      kurs("B", 0.88, "2026-09-01", true),
      kurs("D", 0.86, "2026-10-15"),
      kurs("E", 0.85, "2026-12-01"),
      kurs("F", 0.845, "2026-12-10"),
      kurs("C", 0.84, "2026-09-01", false),
    ];
    const out = run(c);
    expect(ids(out.selected)).toEqual(["A", "D", "B", "E"]);
    expect(out.changed).toBe(false);
    // Warteliste mit klar höherem Score bleibt auf Platz 1
    const top = [
      kurs("wl", 0.97, "2026-09-01", false),
      kurs("k1", 0.9, "2026-10-09"),
      kurs("k2", 0.89, "2026-10-10"),
    ];
    expect(ids(run(top, 2).selected)).toEqual(["wl", "k1"]);
  });

  test("Warteliste bleibt bei Infofragen und < 3 Kursen auf ihrem Platz", () => {
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
    expect(out.reordered).toBe(false);
  });
});

describe("AK-1 (c): künftiger ausgebuchter Kurs nach hinten", () => {
  test("ausgebucht ab 18.10. steht hinter buchbarem (Dezember) und laufendem Kurs", () => {
    const c = [
      kurs("ausgebucht", 0.99, "2026-10-18", false),
      kurs("frei", 0.985, "2026-12-07"),
      kurs("laufend", 0.98, "2026-09-01"),
    ];
    expect(ids(run(c, 2).selected)).toEqual(["frei", "laufend"]);
    const out = run(c, 3);
    expect(ids(out.selected)).toEqual(["frei", "laufend", "ausgebucht"]);
    expectStepRule(out, c, { topN: 3 });
  });

  test("ausgebuchter Kurs mit klar höherem Score bleibt vorn", () => {
    const c = [
      kurs("ausgebucht", 0.99, "2026-10-18", false),
      kurs("frei", 0.95, "2026-10-10"),
    ];
    expect(ids(run(c, 2).selected)).toEqual(["ausgebucht", "frei"]);
  });
});

describe("D7 (K-R1): innerhalb der Stufe Warteliste der früheste künftige Beginn zuerst", () => {
  // Live-Probe 8.2-rc6 auf entwicklung (Düsseldorf-Daten, 16.11.2026): „Wann
  // ist der nächste Einbürgerungstest?“ Zwölf Termine 21.01. bis 24.06.2027,
  // alle „Keine Anmeldung möglich“ (bookable false), Scores innerhalb 0,02,
  // höchster Score am 24.06. Quellen auf rc6: 24.06., 24.06., 21.01., 18.02.
  const STICHTAG = "2026-11-16";
  const TERMINE = [
    ["J414930", "2027-06-24", 0.999], // 10 Uhr
    ["J414931", "2027-06-24", 0.9985], // 12 Uhr
    ["J414912", "2027-01-21", 0.998], // 12 Uhr
    ["J414914", "2027-02-18", 0.9975], // 12 Uhr
    ["J414916", "2027-03-18", 0.994],
    ["J414917", "2027-03-18", 0.9935],
    ["J414920", "2027-04-15", 0.99],
    ["J414921", "2027-04-15", 0.989],
    ["J414924", "2027-05-20", 0.985],
    ["J414925", "2027-05-20", 0.984],
    ["J414913", "2027-02-18", 0.982], // 10 Uhr
    ["J414911", "2027-01-21", 0.98], // 10 Uhr, fehlte auf rc6
  ];
  const ERWARTET = ["2027-01-21", "2027-01-21", "2027-02-18", "2027-02-18"];
  const termin = (knr, start, score) => ({
    ...kurs(knr, score, start, false),
    title: `einbuergerungstest-${knr.toLowerCase()}.txt`,
  });

  test("Einbürgerungstest (rc6): Ausgabe beginnt mit dem 21.01., beide Januar-Termine vor Februar", () => {
    const rows = TERMINE.map(([knr, start, score]) =>
      termin(knr, start, score)
    );
    const out = selectContexts(rows, { topN: 4, today: STICHTAG });
    expect(out.selected.map((r) => r.start_date)).toEqual(ERWARTET);
    // bei gleichem Beginn der höhere Score (12 Uhr vor 10 Uhr)
    expect(ids(out.selected)).toEqual([
      "J414912",
      "J414911",
      "J414914",
      "J414913",
    ]);
    expect(out.reordered).toBe(true);
    expectStepRule(out, rows, { today: STICHTAG });
  });

  test("Einbürgerungstest: jede Verteilung der Scores innerhalb der Spanne ergibt Januar, Januar, Februar, Februar", () => {
    const scores = TERMINE.map(([, , score]) => score);
    let seed = 7;
    for (let t = 0; t < 200; t++) {
      // deterministisches Mischen der Scores über die Termine (Fisher-Yates)
      const mixed = [...scores];
      for (let i = mixed.length - 1; i > 0; i--) {
        seed = (Math.imul(seed, 48271) + 1) & 0x7fffffff;
        const j = seed % (i + 1);
        [mixed[i], mixed[j]] = [mixed[j], mixed[i]];
      }
      const rows = byScoreDesc(
        TERMINE.map(([knr, start], i) => termin(knr, start, mixed[i]))
      );
      const out = selectContexts(rows, { topN: 4, today: STICHTAG });
      expect(out.selected.map((r) => r.start_date)).toEqual(ERWARTET);
      expectStepRule(out, rows, { today: STICHTAG });
    }
  });

  test("Stufenfolge bleibt: künftig buchbar, laufend, Warteliste mit künftigem Beginn (früheste zuerst), begonnene Warteliste nach Score", () => {
    const c = [
      kurs("wl-lfd-hoch", 0.999, "2026-09-01", false), // begonnen, Warteliste
      kurs("wl-mai", 0.998, "2027-05-01", false),
      kurs("wl-lfd-tief", 0.997, "2026-08-01", false),
      kurs("wl-jan", 0.996, "2027-01-10", false),
      kurs("lfd-alt", 0.99, "2026-08-01"), // laufend: nach Score, nicht nach Beginn
      kurs("lfd-neu", 0.985, "2026-10-01"),
      kurs("dez", 0.981, "2026-12-01"),
    ];
    const out = run(c, 7);
    expect(ids(out.selected)).toEqual([
      "dez",
      "lfd-alt",
      "lfd-neu",
      "wl-jan",
      "wl-mai",
      "wl-lfd-hoch",
      "wl-lfd-tief",
    ]);
    expectStepRule(out, c, { topN: 7 });
    // Platz für Platz: die ersten Plätze sind ein Präfix der längeren Liste
    for (const topN of [1, 2, 3, 4, 5, 6])
      expect(ids(run(c, topN).selected)).toEqual(
        ids(out.selected).slice(0, topN)
      );
  });

  test("AK-2 bleibt: ein früherer Wartelisten-Kurs zieht nicht vor einen mit mehr als SPANNE besserem Score", () => {
    const c = [
      kurs("wl-spaet", 0.95, "2027-06-01", false),
      kurs("wl-frueh", 0.929, "2026-10-09", false),
    ];
    expect(ids(run(c, 2).selected)).toEqual(["wl-spaet", "wl-frueh"]);
    const within = [
      kurs("wl-spaet", 0.95, "2027-06-01", false),
      kurs("wl-frueh", 0.93, "2026-10-09", false),
    ];
    expect(ids(run(within, 2).selected)).toEqual(["wl-frueh", "wl-spaet"]);
  });
});

describe("AK-2: Garantie über zufällige Pools", () => {
  const lcg = (seed) => () =>
    (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  const day = (offset) => {
    const d = new Date(`${TODAY}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + offset);
    return d.toISOString().slice(0, 10);
  };

  test("AK-1, AK-2, NAK-3 und Boden auf 3000 Zufallspools (fester Seed)", () => {
    const rnd = lcg(20261116);
    const spans = [undefined, 0, 0.01, 0.05];
    let reordered = 0;
    let changed = 0;
    for (let t = 0; t < 3000; t++) {
      const size = 2 + Math.floor(rnd() * 16);
      const mode = t % 3; // 0: grobe Stufen (viele Gleichstände), 1: nahe 1, 2: breit
      const rows = Array.from({ length: size }, (_, i) => {
        const raw = rnd();
        const score =
          mode === 0
            ? Math.round(raw * 40) / 40
            : mode === 1
              ? Math.round((1 - raw * 0.08) * 10000) / 10000
              : Math.round(raw * 1000) / 1000;
        const r = rnd();
        if (r < 0.2) return info(`i${i}`, score);
        if (r < 0.24) return kurs(`x${i}`, score, "2026-02-31"); // ungültig
        const offset = Math.floor(rnd() * 240) - 60;
        const b = rnd();
        const bookable = b < 0.25 ? false : b < 0.5 ? null : true;
        return kurs(`k${i}`, score, day(offset), bookable);
      });
      const sorted = byScoreDesc(rows);
      const topN = 1 + Math.floor(rnd() * 6);
      const span = spans[t % spans.length];
      const floor = t % 7 === 0 ? 0.5 : undefined;
      const out = run(sorted, topN, { span, floor });
      expect(out.rule).toBe(
        `stufe-span${span ?? SPAN}-floor${floor ?? FLOOR}-deckel1`
      );
      const seq = expectStepRule(out, sorted, {
        topN,
        span: span ?? SPAN,
        floor: floor ?? FLOOR,
      });
      // kein Nicht-Kurs-Dokument vor einem Kurs mit mehr als SPANNE höherem Score
      out.selected.forEach((r, i) => {
        const c = classifyRow(r, TODAY);
        if (c.course || c.score === null) return;
        for (const later of out.selected.slice(i + 1))
          if (seq.includes(later))
            expect(later.rerank_score).toBeLessThanOrEqual(
              c.score + (span ?? SPAN) + EPS
            );
      });
      if (out.reordered) reordered += 1;
      if (out.changed) changed += 1;
    }
    // der Test trifft beide Arten der Änderung
    expect(reordered).toBeGreaterThan(300);
    expect(changed).toBeGreaterThan(300);
  });
});

describe("AK-3: Yoga-Fall vhs-mainz (Stichtag 16.11.2026)", () => {
  const STICHTAG = "2026-11-16";
  // „Yoga für den Rücken“, sechsmal mit gleichem Text (Spezifikation Abschnitt 1)
  const YOGA = [
    ["XI81369", "2026-10-27"],
    ["XI81373", "2026-10-27"],
    ["XI81370", "2027-01-26"],
    ["XI81374", "2027-01-26"],
    ["XI81371", "2027-04-06"],
    ["XI81375", "2027-04-06"],
  ];
  const EXPECTED = ["2027-01-26", "2027-01-26", "2027-04-06", "2027-04-06"];
  const permutations = (arr) =>
    arr.length <= 1
      ? [arr]
      : arr.flatMap((x, i) =>
          permutations([...arr.slice(0, i), ...arr.slice(i + 1)]).map((p) => [
            x,
            ...p,
          ])
        );
  const yoga = (id, score, start) => ({
    ...kurs(id, score, start),
    title: `yoga-fuer-den-ruecken-${id.toLowerCase()}.txt`,
  });

  test("alle 720 Reihenfolgen, Score 0,999: Januar, Januar, April, April", () => {
    const perms = permutations(YOGA);
    expect(perms).toHaveLength(720);
    for (const perm of perms) {
      const rows = perm.map(([id, start]) => yoga(id, 0.999, start));
      const out = selectContexts(rows, { topN: 4, today: STICHTAG });
      expect(out.selected.map((r) => r.start_date)).toEqual(EXPECTED);
      expectStepRule(out, rows, { today: STICHTAG });
    }
  });

  test("alle 720 Reihenfolgen, Score 0,999 bis 1,0, mit anderen Kursen im Pool", () => {
    const JITTER = [0.999, 0.9993, 0.9996, 1.0];
    const fueller = [
      kurs("hatha", 0.975, "2026-12-03"), // anderes Yoga, mehr als 0,02 unter dem Bestwert
      kurs("pilates", 0.93, "2026-11-30"),
      ...[0, 1, 2, 3].map((i) => kurs(`f${i}`, 0.8 - 0.1 * i, "2026-12-10")),
    ];
    permutations(YOGA).forEach((perm, p) => {
      const rows = byScoreDesc([
        ...perm.map(([id, start], i) => yoga(id, JITTER[(p + i) % 4], start)),
        ...fueller,
      ]);
      const out = selectContexts(rows, { topN: 4, today: STICHTAG });
      expect(out.selected.map((r) => r.start_date)).toEqual(EXPECTED);
      expect(out.selected.every((r) => r.title.startsWith("yoga-"))).toBe(true);
      expectStepRule(out, rows, { today: STICHTAG });
      // mit 6 Plätzen folgen die laufenden Oktober-Kurse (künftig vor laufend)
      const six = selectContexts(rows, { topN: 6, today: STICHTAG });
      expect(six.selected.map((r) => r.start_date)).toEqual([
        ...EXPECTED,
        "2026-10-27",
        "2026-10-27",
      ]);
    });
  });
});

describe("AK-4: deutlich relevanterer Kurs bleibt vorn", () => {
  test("späterer Kurs mit mehr als SPANNE höherem Score bleibt Platz 1", () => {
    const c = [
      kurs("relevant", 0.95, "2027-06-01"),
      kurs("frueh1", 0.92, "2026-10-09"),
      kurs("frueh2", 0.915, "2026-10-12"),
      kurs("frueh3", 0.91, "2026-10-10"),
      kurs("frueh4", 0.905, "2026-10-08"),
    ];
    const out = run(c);
    // Platz 1 bleibt; die übrigen sind untereinander gleich relevant
    expect(ids(out.selected)).toEqual([
      "relevant",
      "frueh4",
      "frueh1",
      "frueh3",
    ]);
    expect(ids(run(c, 1).selected)).toEqual(["relevant"]);
    expectStepRule(out, c);
  });

  test("Grenze: 0,0211 höher bleibt vorn, 0,019 höher weicht dem früheren", () => {
    const over = [
      kurs("relevant", 0.9411, "2027-06-01"),
      kurs("frueh", 0.92, "2026-10-09"),
    ];
    expect(ids(run(over, 2).selected)).toEqual(["relevant", "frueh"]);
    const within = [
      kurs("relevant", 0.939, "2027-06-01"),
      kurs("frueh", 0.92, "2026-10-09"),
    ];
    expect(ids(run(within, 2).selected)).toEqual(["frueh", "relevant"]);
  });

  test("laufender Kurs mit klar höherem Score bleibt vor künftigen", () => {
    const c = [
      kurs("lfd", 0.98, "2026-09-01"),
      kurs("k1", 0.95, "2026-10-09"),
      kurs("k2", 0.94, "2026-10-10"),
    ];
    expect(ids(run(c, 3).selected)).toEqual(["lfd", "k1", "k2"]);
  });
});

describe("AK-5: Reihenfolge der Ausgabe", () => {
  test("Ausgabe in der Ordnung der Stufenregel, nicht in Reranker-Reihenfolge", () => {
    const c = [
      kurs("april", 0.99, "2027-04-06"),
      kurs("januar", 0.985, "2027-01-26"),
      kurs("laufend", 0.98, "2026-09-01"),
      kurs("spaeter", 0.5, "2026-10-09"),
    ];
    const out = run(c);
    expect(ids(out.selected)).toEqual([
      "januar",
      "april",
      "laufend",
      "spaeter",
    ]);
    expect(out.reordered).toBe(true);
    expect(out.changed).toBe(false); // gleiche Menge, andere Reihenfolge
    expect(out.swappedIn).toEqual([]);
    out.selected.forEach((r) => expect(c).toContain(r)); // dieselben Referenzen
  });

  test("Nicht-Kurs-Dokumente behalten ihren Platz, die Kursplätze folgen der Stufenregel", () => {
    const c = [
      info("team", 1.0),
      kurs("april", 0.999, "2027-04-06"),
      kurs("januar", 0.999, "2027-01-26"),
      info("faq", 0.5),
      kurs("x", 0.2, "2026-10-09"),
    ];
    const out = run(c);
    expect(out.courseQuery).toBe(false);
    expect(ids(out.selected)).toEqual(["team", "januar", "april", "faq"]);
    expect(out.reordered).toBe(true);
    expectStepRule(out, c);
  });

  test("ohne zeitlichen Vorrang bleibt die Reranker-Reihenfolge", () => {
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
    expect(out.reordered).toBe(false);
  });
});

describe("Boden: unter 0,3 keine Datumsordnung", () => {
  test("kein-verwaessern (Messung 08.10.: „Erste Hilfe“ → „Englisch 1“ mit 0,01)", () => {
    const c = [
      kurs("k1", 0.13, "2026-11-02"),
      kurs("k2", 0.02, "2027-01-23"),
      kurs("k3", 0.01, "2026-09-14"),
      kurs("k4", 0.01, "2026-10-05"),
      kurs("k5", 0.009, "2026-10-09"),
      kurs("k6", 0.008, "2026-10-08"),
    ];
    // k5/k6 starten früher (k6 heute) und liegen in der Spanne, aber unter dem Boden
    const sorted = byScoreDesc(c);
    const out = run(sorted);
    expect(ids(out.selected)).toEqual(ids(sorted.slice(0, 4)));
    expect(out.swappedIn).toEqual([]);
    expect(out.changed).toBe(false);
    expect(out.reordered).toBe(false);
  });

  test("Führender über dem Boden: gleich relevanter Kurs unter dem Boden zieht nicht vor", () => {
    const c = [
      kurs("k1", 0.31, "2027-03-01"),
      kurs("morgen", 0.295, "2026-10-09"),
      kurs("k3", 0.29, "2026-10-10"),
    ];
    expect(ids(run(c, 3).selected)).toEqual(["k1", "morgen", "k3"]);
    // über dem Boden gilt die Spanne wie sonst
    const above = [
      kurs("k1", 0.32, "2027-03-01"),
      kurs("morgen", 0.305, "2026-10-09"),
    ];
    expect(ids(run(above, 2).selected)).toEqual(["morgen", "k1"]);
  });

  test("boden-im-band: Top-Score 0,35 → Kurs mit 0,29 (Start morgen) bleibt draußen", () => {
    const c = [
      kurs("k1", 0.35, "2027-03-01"),
      kurs("k2", 0.34, "2027-02-01"),
      kurs("k3", 0.33, "2027-01-15"),
      kurs("k4", 0.32, "2026-12-20"),
      kurs("morgen", 0.29, "2026-10-09"),
    ];
    const out = run(c);
    expect(out.active).toBe(true);
    // gleiche Menge wie die Score-Top-4, innerhalb der Spanne nach Beginn
    expect(ids(out.selected)).toEqual(["k3", "k2", "k1", "k4"]);
    expect(out.swappedIn).toEqual([]);
    expect(out.changed).toBe(false);
    expectStepRule(out, c);
  });

  test("Top-Score 0,25 (alles unter dem Boden) → reine Score-Folge", () => {
    const c = [
      kurs("k1", 0.25, "2027-03-01"),
      kurs("k2", 0.245, "2027-02-01"),
      kurs("k3", 0.24, "2027-01-15"),
      kurs("k4", 0.235, "2026-12-20"),
      kurs("morgen", 0.23, "2026-10-09"),
    ];
    const out = run(c);
    expect(out.active).toBe(true);
    expect(ids(out.selected)).toEqual(["k1", "k2", "k3", "k4"]);
    expect(out.changed).toBe(false);
    expect(out.reordered).toBe(false);
  });
});

describe("NAK-1: Kursnummer-Treffer stehen nach der Auswahl vorn", () => {
  const asResult = (rows) => ({
    contextTexts: rows.map((r) => r.text),
    sourceDocuments: rows,
    scores: rows.map((r) => r.rerank_score),
  });

  test("gefragter Warteliste-Kurs, den die Stufe verdrängt, steht nach mergeCourseNumberHits vorn", () => {
    const wl = kurs("26W1001", 0.999, "2026-09-01", false);
    const c = [
      wl,
      kurs("k1", 0.999, "2026-11-01"),
      kurs("k2", 0.998, "2026-11-02"),
      kurs("k3", 0.997, "2026-11-03"),
      kurs("k4", 0.996, "2026-11-04"),
    ];
    const out = run(c);
    // Vorbedingung: die Stufenregel nimmt die vier buchbaren Kurse
    expect(ids(out.selected)).toEqual(["k1", "k2", "k3", "k4"]);
    const merged = mergeCourseNumberHits(
      asResult(out.selected),
      [{ courseNumber: "26W1001", row: wl }],
      4
    );
    expect(ids(merged.sourceDocuments)).toEqual(["26W1001", "k1", "k2", "k3"]);
    expect(merged.sourceDocuments[0]).toMatchObject({ bookable: false });
  });

  test("gefragter Kurs in der Auswahl rückt nach vorn, Rest in Stufenfolge", () => {
    const asked = kurs("26A2002", 0.99, "2027-04-06");
    const c = [
      asked,
      kurs("jan", 0.985, "2027-01-26"),
      kurs("lfd", 0.98, "2026-09-01"),
    ];
    const out = run(c, 3);
    expect(ids(out.selected)).toEqual(["jan", "26A2002", "lfd"]);
    const merged = mergeCourseNumberHits(
      asResult(out.selected),
      [{ courseNumber: "26A2002", row: asked }],
      3
    );
    expect(ids(merged.sourceDocuments)).toEqual(["26A2002", "jan", "lfd"]);
  });
});

describe("NAK-2: laufender Kurs, der als einziger passt, bleibt", () => {
  test("laufend mit klar höherem Score bleibt Platz 1", () => {
    const c = [
      kurs("lfd", 0.93, "2026-09-01"),
      kurs("k1", 0.6, "2026-10-09"),
      kurs("k2", 0.55, "2026-10-10"),
      kurs("k3", 0.5, "2026-10-11"),
      kurs("k4", 0.45, "2026-10-12"),
    ];
    const out = run(c);
    expect(ids(out.selected)).toEqual(["lfd", "k1", "k2", "k3"]);
    expectStepRule(out, c);
  });

  test("Grenze: künftige Kurse 0,021 tiefer verdrängen ihn nicht, auch auf Warteliste nicht", () => {
    for (const bookable of [true, null, false]) {
      const c = [
        kurs("lfd", 0.95, "2026-09-01", bookable),
        kurs("k1", 0.929, "2026-10-09"),
        kurs("k2", 0.929, "2026-10-10"),
        kurs("k3", 0.929, "2026-10-11"),
        kurs("k4", 0.929, "2026-10-12"),
      ];
      const out = run(c);
      expect(ids(out.selected)[0]).toBe("lfd");
      expectStepRule(out, c);
    }
  });

  test("einziger Kurs zwischen Übersichten und schwachen Kursen", () => {
    const c = [
      info("i1", 0.95),
      kurs("lfd", 0.93, "2026-09-01"),
      info("i2", 0.9),
      info("i3", 0.8),
      kurs("schwach", 0.2, "2026-10-09"),
    ];
    const out = run(c);
    expect(ids(out.selected)).toEqual(["i1", "lfd", "i2", "i3"]);
    // einziger Kurs überhaupt: Rückfall, Kurs bleibt
    const only = [
      info("i1", 0.95),
      kurs("lfd", 0.93, "2026-09-01"),
      info("i2", 0.9),
    ];
    expect(run(only).reason).toBe("few_courses");
    expect(ids(run(only).selected)).toContain("lfd");
  });
});

describe("NAK-3: Regel 3 (höchstens 1 Nicht-Kurs-Dokument bei Kursfrage) unverändert", () => {
  test("Warteliste zählt für die Kursfrage mit", () => {
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

  test("Deckel mit Gleichstand: Kurse nach Stufenregel, Übersicht auf ihrem Platz", () => {
    const c = [
      kurs("april", 1.0, "2027-04-06"),
      info("team", 0.995),
      info("U2", 0.99),
      kurs("januar", 0.99, "2027-01-26"),
      kurs("lfd", 0.985, "2026-09-01"),
    ];
    const out = run(c);
    expect(out.courseQuery).toBe(true);
    expect(ids(out.selected)).toEqual(["januar", "team", "april", "lfd"]);
    expectStepRule(out, c);
  });

  test("Deckel ersetzt nur durch Kurse ≥ Boden, sonst bleiben Übersichten", () => {
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
    expect(ids(out.selected)).toEqual(["K1", "U1", "K2", "K3"]);
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
});

describe("Rückfall und Robustheit (Bestand)", () => {
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
    expect(out.reordered).toBe(false);
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

  test("genau topN, wenn der Pool reicht", () => {
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

  test("Laufzeit < 2 ms für 50 Kandidaten (Mittel aus 100 Läufen)", () => {
    const c = Array.from({ length: 50 }, (_, i) =>
      i % 3 === 0
        ? info(`i${i}`, 1 - i / 100)
        : kurs(
            `k${i}`,
            1 - i / 200,
            `2026-${String(10 + (i % 3)).padStart(2, "0")}-${String(
              1 + (i % 28)
            ).padStart(2, "0")}`,
            i % 7 === 0 ? false : true
          )
    );
    for (let i = 0; i < 10; i++) run(c, 12); // Aufwärmen
    const start = process.hrtime.bigint();
    for (let i = 0; i < 100; i++) run(c, 12);
    const meanMs = Number(process.hrtime.bigint() - start) / 1e6 / 100;
    expect(meanMs).toBeLessThan(2);
  });

  test("keine Mutation, keine Ausnahme bei kaputten Daten", () => {
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
});

describe("selectContexts: Replay der Messdaten 08.10.2026", () => {
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
  const replay = (file) => {
    const stats = {
      lists: 0,
      valid: 0,
      degraded: 0,
      changed: 0,
      reordered: 0,
      datum: 0,
      deckel: 0,
      nextFirst: 0,
      withNext: 0,
    };
    for (const entry of load(file)) {
      stats.lists += 1;
      // Produktionspool: der Reranker liefert topK = max(topN, 12) Zeilen.
      const rows = toRows(entry.kandidaten).slice(0, POOL);
      const out = selectContexts(rows, { topN: 4, today: TODAY });
      const cls = rows.map((r) => classifyRow(r, TODAY));
      if (!cls.some((c) => c.score !== null)) {
        // degradierte Liste (Parallel-Lauf ohne Scores) → identisch
        expect(out.selected).toEqual(rows.slice(0, 4));
        stats.degraded += 1;
        continue;
      }
      stats.valid += 1;
      expectStepRule(out, rows);
      if (out.changed) stats.changed += 1;
      if (out.reordered) stats.reordered += 1;
      for (const s of out.swappedOut) stats[s.reason] += 1;
      // nächster künftiger, buchbarer Kurs unter den gleich relevanten zum
      // Bestwert (≥ Boden) steht als erster Kurs in der Ausgabe
      if (!out.active) continue;
      const courses = rows
        .map((r, i) => ({ r, c: cls[i] }))
        .filter(({ c }) => c.course && c.score !== null);
      const best = Math.max(...courses.map(({ c }) => c.score));
      const next = courses
        .filter(
          ({ c }) =>
            c.state === "zukuenftig" &&
            c.score >= Math.max(best - SPAN - EPS, FLOOR)
        )
        .sort((a, b) => a.c.naehe - b.c.naehe || b.c.score - a.c.score)[0];
      const first = out.selected.find((r) => {
        const c = classifyRow(r, TODAY);
        return c.course && c.score !== null;
      });
      if (next && first) {
        stats.withNext += 1;
        if (classifyRow(first, TODAY).naehe === next.c.naehe)
          stats.nextFirst += 1;
      }
    }
    return stats;
  };
  const summary = (s) =>
    `gültig ${s.valid}/${s.lists} (degradiert ${s.degraded}), Menge geändert ${s.changed}, ` +
    `umgeordnet ${s.reordered}, Tausch datum ${s.datum}, deckel ${s.deckel}, ` +
    `nächster künftiger Kurs vorn ${s.nextFirst}/${s.withNext}`;

  test("replay-intern", () => {
    const stats = replay("kandidaten_intern_20261008_0657.jsonl");
    expect(stats.lists).toBe(40);
    expect(stats.valid).toBe(40);
    expect(stats.nextFirst).toBe(stats.withNext);
    expect(stats.withNext).toBeGreaterThan(0);
    console.info(`replay-intern: ${summary(stats)}`);
  });

  test("replay-intern-degradiert", () => {
    const stats = replay("kandidaten_intern_20261008.jsonl");
    expect(stats.lists).toBe(40);
    expect(stats.valid).toBe(17);
    expect(stats.nextFirst).toBe(stats.withNext);
    console.info(`replay-intern-degradiert: ${summary(stats)}`);
  });
});
