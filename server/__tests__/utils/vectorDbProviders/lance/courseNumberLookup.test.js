/* eslint-env jest, node */
/**
 * Kursnummern-Erkennung (issues/kursnummer-erkennung.md): reine Logik des
 * Moduls courseNumberLookup.js, ohne Datenbank. Kandidaten aus der Frage
 * (D2), Prüfung gegen die Kopfzeile „Kursnummer:“ (HC2) und das Voranstellen
 * gefundener Kurse (D3). Die Suche gegen eine echte LanceDB-Tabelle prüft
 * courseNumberSearch.test.js.
 */
const {
  courseNumberCandidates,
  courseNumberSearchPlan,
  courseNumberMatchesInOrder,
  courseNumberOfText,
  matchesCourseNumber,
  mergeCourseNumberHits,
  COURSE_NUMBER_MAX_SEARCHED,
  COURSE_NUMBER_MIN_LEN,
  COURSE_NUMBER_MAX_LEN,
} = require("../../../../utils/vectorDbProviders/lance/courseNumberLookup");

// Formate aus der Flotte (Spezifikation Abschnitt 1, Feeds vom 11.11.2026)
const FLEET_FORMATS = [
  "26B7602",
  "262-30748",
  "XI57261",
  "27S445311",
  "NTU40616R",
  "F320241",
  "261-G-071",
  "27-83520A",
  "T7411A",
  "26C008508",
  "NSP10601C",
  "26H43362",
];

const header = (knr, title = "Spanisch A1.2") =>
  [
    "<document_metadata>",
    `sourceDocument: kurs-${String(knr).toLowerCase()}.txt`,
    "published: 9/24/2026, 8:57:03 AM",
    "</document_metadata>",
    "",
    `Titel: ${title}`,
    `Kursnummer: ${knr}`,
    "Kursstatus: Anmeldung möglich",
    "Kursgebühr: 130,90",
    "Beginn: Di. 25.08.2026, 18:15 Uhr",
    `Kurs-Link: https://www.vhs-beispiel.de/kurssuche/kurs/spanisch/${knr}`,
    "",
    "Kursbeschreibung: Teilnehmer können sich nach diesem Niveau verständigen.",
  ].join("\n");

describe("courseNumberCandidates (D2)", () => {
  test("Grenzen wie in D2: 4 bis 15 Zeichen, höchstens 5 Nummern", () => {
    expect(COURSE_NUMBER_MIN_LEN).toBe(4);
    expect(COURSE_NUMBER_MAX_LEN).toBe(15);
    expect(COURSE_NUMBER_MAX_SEARCHED).toBe(5);
  });

  test.each(FLEET_FORMATS)(
    "AK-2: Format %s mitten im Satz, mit Satzzeichen, in jeder Schreibweise",
    (knr) => {
      const variants = [knr, knr.toLowerCase(), knr.toUpperCase()];
      for (const v of variants) {
        for (const sentence of [
          `Ich habe in der Zeitung die Kursnummer ${v} gesehen. Was ist das für ein Kurs?`,
          `Was ist das für ein Kurs (${v})?`,
          `Kurs ${v}?`,
          `Kurs-Nr. ${v}, wann beginnt er?`,
          `Kursnummer:${v}!`,
          `„${v}“ steht im Programmheft.`,
          `-${v}-`,
        ])
          expect(courseNumberCandidates(sentence)).toEqual([v]);
      }
    }
  );

  test("AK-2: Beispiele aus der Spezifikation", () => {
    expect(courseNumberCandidates("(26B7602)")).toEqual(["26B7602"]);
    expect(courseNumberCandidates("26B7602?")).toEqual(["26B7602"]);
    expect(courseNumberCandidates("Kurs-Nr. 262-30748")).toEqual(["262-30748"]);
  });

  // Review rc1 S-L4: aus PDF oder Online-Zeitung kopiert stehen statt des
  // Bindestrichs oft typografische Striche oder weiche Trennzeichen
  test("S-L4: typografische Striche gelten als Bindestrich, weiches Trennzeichen zählt nicht", () => {
    expect(courseNumberCandidates("Kurs-Nr. 262\u201130748?")).toEqual([
      "262-30748",
    ]);
    expect(courseNumberCandidates("Was ist 261\u2013G\u2013071?")).toEqual([
      "261-G-071",
    ]);
    expect(courseNumberCandidates("Kurs 27\u201083520A")).toEqual([
      "27-83520A",
    ]);
    expect(courseNumberCandidates("Kurs 262\u201230748")).toEqual([
      "262-30748",
    ]);
    expect(courseNumberCandidates("Kurs 26B\u00AD7602 (Zeitung)")).toEqual([
      "26B7602",
    ]);
    // als Satzzeichen zwischen Wörtern bleibt der Strich ein Trenner
    expect(courseNumberCandidates("Spanisch \u2013 26B7602 \u2011")).toEqual([
      "26B7602",
    ]);
    expect(courseNumberCandidates("\u201326B7602\u2013")).toEqual(["26B7602"]);
  });

  // Review rc1 S-L3: per Bindestrich angehängtes Wort („26B7602-Kurs“)
  test("S-L3: Nummer per Bindestrich an ein Wort gehängt: erst das ganze Wort, danach die Nummer ohne das angehängte Wort", () => {
    expect(courseNumberCandidates("Ist der 26B7602-Kurs noch frei?")).toEqual([
      "26B7602-Kurs",
      "26B7602",
    ]);
    expect(courseNumberCandidates("Kurs-26B7602?")).toEqual([
      "Kurs-26B7602",
      "26B7602",
    ]);
    // Nummer mit eigenem Bindestrich, angehängtes Wort auf einer oder auf
    // beiden Seiten (das ganze Wort ist dann zu lang)
    expect(courseNumberCandidates("Wann beginnt Kurs-262-30748?")).toEqual([
      "Kurs-262-30748",
      "262-30748",
    ]);
    expect(courseNumberCandidates("Kurs-Nr-261-G-071-Info")).toEqual([
      "261-G-071",
    ]);
    // ganzes Wort zu lang oder mit Umlaut: nur die Nummer
    expect(
      courseNumberCandidates("Spanischkurs-26B7602 bei Müller-T7411A")
    ).toEqual(["26B7602", "T7411A"]);
    // Punkt trennt schon: ganzes Wort wie bisher
    expect(courseNumberCandidates("Kurs-Nr.262-30748")).toEqual(["262-30748"]);
  });

  test("S-L3: Nummern mit Bindestrich bleiben ganz, ohne Teile", () => {
    for (const knr of ["262-30748", "261-G-071", "27-83520A", "9923-0"])
      expect(courseNumberCandidates(`Kurs ${knr}?`)).toEqual([knr]);
    expect(courseNumberCandidates("am 2026-09-14")).toEqual(["2026-09-14"]);
  });

  test("S-L3/NAK-4: ganze Wörter zuerst, Teile danach, gesamt höchstens 5", () => {
    expect(
      courseNumberCandidates("Kurs-T7411A, F320241, XI57261 und 27S445311?")
    ).toEqual(["Kurs-T7411A", "F320241", "XI57261", "27S445311", "T7411A"]);
    // Teile belegen keinen Platz eines späteren ganzen Worts
    expect(
      courseNumberCandidates(
        "Kurs-T7411A, Kurs-F320241, XI57261, 27S445311, NTU40616R, 26H43362"
      )
    ).toEqual([
      "Kurs-T7411A",
      "Kurs-F320241",
      "XI57261",
      "27S445311",
      "NTU40616R",
    ]);
    // ein Teil, der als ganzes Wort vorkommt, zählt nur einmal, als ganzes Wort
    expect(courseNumberCandidates("26B7602-Kurs oder 26B7602?")).toEqual([
      "26B7602-Kurs",
      "26B7602",
    ]);
    expect(
      courseNumberSearchPlan("26B7602-Kurs oder 26B7602?").map((e) => e.part)
    ).toEqual([false, false]);
  });

  test("S-L3: Plan mit Stelle in der Frage, Teil und ganzes Wort an derselben Stelle", () => {
    expect(
      courseNumberSearchPlan("Ist Kurs-26B7602 oder T7411A frei?")
    ).toEqual([
      { candidate: "Kurs-26B7602", position: 4, part: false },
      { candidate: "T7411A", position: 22, part: false },
      { candidate: "26B7602", position: 4, part: true },
    ]);
  });

  test("Wörter ohne Ziffer, zu kurz, zu lang oder mit anderen Zeichen sind keine Kandidaten", () => {
    expect(courseNumberCandidates("Kurs-Nr. Spanisch Yoga am Abend")).toEqual(
      []
    );
    expect(courseNumberCandidates("Kostet der Kurs 130,90 Euro?")).toEqual([]);
    expect(courseNumberCandidates("Raum 145 im 1. Stock")).toEqual([]);
    expect(courseNumberCandidates("A1B2C3D4E5F6G7H8")).toEqual([]);
    // Buchstaben außerhalb von A bis Z gehören zum Wort, das Wort zählt nicht
    expect(courseNumberCandidates("Straße12345 und Müller2026")).toEqual([]);
    expect(courseNumberCandidates("")).toEqual([]);
    expect(courseNumberCandidates(null)).toEqual([]);
    expect(courseNumberCandidates(42)).toEqual([]);
  });

  test("AK-4: Jahr, Postleitzahl, Telefonnummer und Datum sind nur Kandidaten, die Daten entscheiden", () => {
    expect(
      courseNumberCandidates(
        "Gibt es 2026 in 27749 Delmenhorst Kurse? Telefon 04221 9923-0, Beginn 14.09.2026"
      )
    ).toEqual(["2026", "27749", "04221", "9923-0"]);
  });

  test("NAK-4: höchstens 5 verschiedene Nummern in der Reihenfolge der Frage, doppelte zählen einmal", () => {
    const question =
      "26B7602 und 26b7602, dann T7411A, F320241, XI57261, 262-30748, NTU40616R und 26H43362";
    expect(courseNumberCandidates(question)).toEqual([
      "26B7602",
      "T7411A",
      "F320241",
      "XI57261",
      "262-30748",
    ]);
  });

  test("NAK-2: Einschleusungsversuche liefern nur saubere Kandidaten", () => {
    const inputs = [
      "' OR 1=1",
      '"',
      "\\",
      "26B7602' OR '1'='1",
      '26B7602"; DROP TABLE kurse; --',
      "id IS NULL OR 1=1 -- 26B7602",
      "%26B7602%_",
      "26B7602\u0000\u2028",
    ];
    for (const input of inputs)
      for (const c of courseNumberCandidates(input))
        expect(c).toMatch(/^[A-Za-z0-9-]{4,15}$/);
    expect(courseNumberCandidates("26B7602' OR '1'='1")).toEqual(["26B7602"]);
    expect(courseNumberCandidates("' OR 1=1")).toEqual([]);
  });

  test("NAK-2/NAK-4: sehr lange Eingaben bleiben schnell und liefern höchstens 5 Kandidaten", () => {
    const inputs = [
      "a".repeat(1_000_000),
      "1-".repeat(500_000),
      "26B7602 ".repeat(200_000),
      Array.from({ length: 100_000 }, (_, i) => `K${1000 + i}`).join(" "),
    ];
    const start = Date.now();
    for (const input of inputs) {
      const result = courseNumberCandidates(input);
      expect(result.length).toBeLessThanOrEqual(5);
    }
    expect(Date.now() - start).toBeLessThan(2000);
    expect(courseNumberCandidates(inputs[3])).toEqual([
      "K1000",
      "K1001",
      "K1002",
      "K1003",
      "K1004",
    ]);
  });

  // Review rc1 S-H1: Randstriche per Regex auf einem ungekürzten Wort brauchen
  // bei langen Bindestrich-Folgen quadratisch viele Schritte (ReDoS über den
  // öffentlichen Widget-Endpunkt)
  test("NAK-2/NAK-4 (S-H1): lange Bindestrich-Folgen in einem Wort laufen je unter 50 ms, ohne Kandidaten", () => {
    const inputs = [
      "1" + "-".repeat(100_000) + "1",
      "a" + "-".repeat(100_000) + "a",
      `Kurs 1${"-".repeat(50_000)}a b${"-".repeat(50_000)}9 Ende`,
    ];
    for (const input of inputs) {
      const start = performance.now();
      const result = courseNumberCandidates(input);
      const ms = performance.now() - start;
      expect({ length: input.length, result, fast: ms < 50 }).toEqual({
        length: input.length,
        result: [],
        fast: true,
      });
    }
    // ein Wort danach zählt weiter
    expect(courseNumberCandidates(`a${"-".repeat(100_000)}a 26B7602?`)).toEqual(
      ["26B7602"]
    );
  });
});

describe("courseNumberMatchesInOrder (S-L3, AK-3)", () => {
  const plan = courseNumberSearchPlan("Ist Kurs-26B7602 oder T7411A frei?");
  const row = (id) => ({ id });

  test("Treffer in der Reihenfolge der Frage, ein Teil an der Stelle seines Worts", () => {
    // Suche: ganzes Wort ohne Treffer, T7411A und der Teil 26B7602 mit Treffer
    expect(
      courseNumberMatchesInOrder(plan, [[], [row("t")], [row("b")]])
    ).toEqual([[], [row("b")], [row("t")]]);
  });

  test("ergibt das ganze Wort eine Kursnummer, zählen seine Teile nicht", () => {
    expect(
      courseNumberMatchesInOrder(plan, [[row("ganz")], [row("t")], [row("b")]])
    ).toEqual([[row("ganz")], [row("t")]]);
  });

  test("fehlende Ergebnisse zählen als leer", () => {
    expect(courseNumberMatchesInOrder(plan, [])).toEqual([[], [], []]);
    expect(courseNumberMatchesInOrder([], [])).toEqual([]);
  });
});

describe("Prüfung gegen die Zeile „Kursnummer:“ (HC2)", () => {
  test("Kursnummer aus der Kopfzeile, sonst null", () => {
    expect(courseNumberOfText(header("26B7602"))).toBe("26B7602");
    expect(courseNumberOfText("Übersicht Sprachen 26B7602 Spanisch")).toBe(
      null
    );
    expect(courseNumberOfText(null)).toBe(null);
  });

  test("genau diese Nummer, ohne Rücksicht auf Groß- und Kleinschreibung", () => {
    expect(matchesCourseNumber(header("26B7602"), "26b7602")).toBe(true);
    expect(matchesCourseNumber(header("26B7602"), "26B7602")).toBe(true);
    expect(matchesCourseNumber(header("261-G-071"), "261-g-071")).toBe(true);
    // ähnliche Nummern zählen nicht
    expect(matchesCourseNumber(header("26B7602"), "26B760")).toBe(false);
    expect(matchesCourseNumber(header("26B7602"), "26B76021")).toBe(false);
    expect(matchesCourseNumber(header("26B7603"), "26B7602")).toBe(false);
    expect(matchesCourseNumber(header("27749A"), "27749")).toBe(false);
  });

  test("Nummer nur im Freitext (Beschreibung, Übersicht, Link) zählt nicht", () => {
    const describedElsewhere = header("26B7699").replace(
      "verständigen.",
      "verständigen.\nKursnummer: 26B7602"
    );
    expect(matchesCourseNumber(describedElsewhere, "26B7602")).toBe(false);
    expect(
      matchesCourseNumber(
        "Sprachen\nKursnummer: 26B7602\nSpanisch A1.2 26B7602",
        "26B7602"
      )
    ).toBe(false);
    expect(matchesCourseNumber(header("26B7699"), "26B7699")).toBe(true);
    expect(matchesCourseNumber("", "26B7602")).toBe(false);
    expect(matchesCourseNumber(header("26B7602"), "")).toBe(false);
  });
});

describe("mergeCourseNumberHits (D3)", () => {
  const result = () => ({
    contextTexts: ["t-a", "t-b", "t-c", "t-d"],
    sourceDocuments: [
      { id: "a", title: "a.txt", score: 0.9 },
      { id: "b", title: "b.txt", score: 0.8 },
      { id: "c", title: "c.txt", score: 0.7 },
      { id: "d", title: "d.txt", score: 0.6 },
    ],
    scores: [0.9, 0.8, 0.7, 0.6],
  });
  const hit = (id, courseNumber, extra = {}) => ({
    courseNumber,
    row: {
      id,
      title: `${id}.txt`,
      text: `t-${id}`,
      vector: [1, 2, 3],
      _score: 12.5,
      _distance: 0.4,
      ...extra,
    },
  });

  test("ohne Treffer bleibt das Ergebnis dasselbe Objekt (NAK-1)", () => {
    const r = result();
    expect(mergeCourseNumberHits(r, [], 4)).toBe(r);
    expect(mergeCourseNumberHits(r, null, 4)).toBe(r);
  });

  test("gefundene Kurse vorn, die übrigen Plätze in der bisherigen Reihenfolge, höchstens topN", () => {
    const merged = mergeCourseNumberHits(result(), [hit("x", "26B7602")], 4);
    expect(merged.sourceDocuments.map((d) => d.id)).toEqual([
      "x",
      "a",
      "b",
      "c",
    ]);
    expect(merged.contextTexts).toEqual(["t-x", "t-a", "t-b", "t-c"]);
    // kein Vektor, keine internen Felder, keine erfundene Bewertung; score
    // ist null, damit der Verlauf ihn als Suchtreffer erkennt (S-L1)
    expect(merged.sourceDocuments[0]).toEqual({
      id: "x",
      title: "x.txt",
      text: "t-x",
      score: null,
    });
    expect(merged.scores).toEqual([null, 0.9, 0.8, 0.7]);
  });

  test("Treffer, der schon in den Quellen steht, rückt mit seinen Angaben nach vorn (kein Doppel)", () => {
    const merged = mergeCourseNumberHits(result(), [hit("c", "26B7602")], 4);
    expect(merged.sourceDocuments.map((d) => d.id)).toEqual([
      "c",
      "a",
      "b",
      "d",
    ]);
    expect(merged.sourceDocuments[0]).toEqual({
      id: "c",
      title: "c.txt",
      score: 0.7,
    });
    expect(merged.contextTexts).toEqual(["t-c", "t-a", "t-b", "t-d"]);
    expect(merged.scores).toEqual([0.7, 0.9, 0.8, 0.6]);
  });

  test("AK-3: mehrere Treffer in ihrer Reihenfolge, höchstens topN, doppelte IDs einmal", () => {
    const merged = mergeCourseNumberHits(
      result(),
      [
        hit("x", "T7411A"),
        hit("y", "26B7602"),
        hit("x", "T7411A"),
        hit("z", "F320241"),
      ],
      2
    );
    expect(merged.sourceDocuments.map((d) => d.id)).toEqual(["x", "y"]);
    expect(merged.contextTexts).toEqual(["t-x", "t-y"]);
  });

  test("weniger Quellen als topN: alle Treffer plus alle bisherigen", () => {
    const short = {
      contextTexts: ["t-a"],
      sourceDocuments: [{ id: "a" }],
      scores: [0.5],
    };
    const merged = mergeCourseNumberHits(short, [hit("x", "26B7602")], 4);
    expect(merged.sourceDocuments.map((d) => d.id)).toEqual(["x", "a"]);
  });
});
