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
  COURSE_NUMBER_MAX_WORD_LEN,
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
    // Nachreview rc2 S-L8: am Ziffernstrich zusätzlich die Hälften als Teile
    // (zählen nur, wenn das ganze Wort keine Kursnummer ergibt)
    expect(courseNumberCandidates("Kurs 262\u201230748")).toEqual([
      "262-30748",
      "30748",
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
      // Nachtrag 8.1.3: das Datum ist ein Wort mit Punkten, ein Kandidat (AK-13)
    ).toEqual(["2026", "27749", "04221", "9923-0", "14.09.2026"]);
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

// Nachtrag 8.1.3 (Spezifikation Abschnitt 11, 11.11.2026): Kursnummern mit
// Punkt im Inneren, ein Beispiel je Form aus den Feeds der Flotte (vhs-brilon,
// vhs-henstedt-ulzburg, vhs-umkirch, vhs-delmenhorst)
const DOT_FORMATS = [
  "X41.100",
  "X43.414",
  "X17.117-1",
  "X41.501-S",
  "BA56.25",
  "BAMF77.040",
  "BA65.06A",
  "BA427.00A",
  "BA213.11",
  "BA77.032",
  "262.302200",
  "26B7154.E",
];

describe("Nachtrag 8.1.3: Kursnummern mit Punkt", () => {
  test.each(DOT_FORMATS)(
    "AK-11: Format %s mitten im Satz, mit Satzzeichen danach, in jeder Schreibweise",
    (knr) => {
      for (const v of [knr, knr.toLowerCase(), knr.toUpperCase()]) {
        for (const sentence of [
          `Ich interessiere mich für ${v}.`,
          `Kurs (${v})?`,
          `${v} noch frei?`,
          `Ich habe in der Zeitung die Kursnummer ${v} gesehen. Was ist das für ein Kurs?`,
          `Kurs-Nr. ${v}, wann beginnt er?`,
          `Kursnummer:${v}!`,
          `„${v}“ steht im Programmheft.`,
          `Kurs ${v}...`,
          `(${v}).`,
        ])
          expect([sentence, courseNumberCandidates(sentence)]).toEqual([
            sentence,
            [v],
          ]);
      }
    }
  );

  test("AK-11: Beispiele aus der Spezifikation", () => {
    expect(
      courseNumberCandidates("Ich interessiere mich für BA56.25.")
    ).toEqual(["BA56.25"]);
    expect(courseNumberCandidates("Kurs (26B7154.E)?")).toEqual(["26B7154.E"]);
    expect(courseNumberCandidates("bamf77.040 noch frei?")).toEqual([
      "bamf77.040",
    ]);
  });

  test("AK-12: Punkte am Wortrand sind Satzzeichen und fallen weg, wie Bindestriche am Rand", () => {
    expect(courseNumberCandidates("Kurs 26B7602.")).toEqual(["26B7602"]);
    expect(courseNumberCandidates("Kurs BA56.25.")).toEqual(["BA56.25"]);
    expect(courseNumberCandidates("Kurs BA56.25...")).toEqual(["BA56.25"]);
    expect(courseNumberCandidates("Kurs .BA56.25.-")).toEqual(["BA56.25"]);
    expect(courseNumberCandidates("Kurs -.262.302200.-.")).toEqual([
      "262.302200",
    ]);
    expect(courseNumberCandidates("Kurse X41.100. Und X43.414.")).toEqual([
      "X41.100",
      "X43.414",
    ]);
    // Randpunkte zählen nicht zur Länge: 15 Zeichen plus Punkt bleiben ein
    // Kandidat, ein einzelner Punkt mit Ziffern ist zu kurz
    expect(courseNumberCandidates("Kurs ABCDEFGHIJ12345.")).toEqual([
      "ABCDEFGHIJ12345",
    ]);
    expect(courseNumberCandidates("Kurs 1.2.")).toEqual([]);
  });

  test("AK-12: Wort per Punkt angehängt (Abkürzung, Satzende ohne Leerzeichen): erst das ganze Wort, danach die Nummer", () => {
    expect(courseNumberCandidates("Kurs Nr.26B7602?")).toEqual([
      "Nr.26B7602",
      "26B7602",
    ]);
    expect(courseNumberCandidates("Gesehen: 26B7602.Was ist das?")).toEqual([
      "26B7602.Was",
      "26B7602",
    ]);
    expect(courseNumberCandidates("Kurs-Nr.BAMF77.040")).toEqual([
      "BAMF77.040",
    ]);
    // ein einzelner Buchstabe am Ende gehört zur Nummer (X41.501-S, 26B7154.E):
    // kein Teil ohne ihn
    expect(courseNumberSearchPlan("Kurs X41.501-S und 26B7154.E")).toEqual([
      { candidate: "X41.501-S", position: 5, part: false },
      { candidate: "26B7154.E", position: 19, part: false },
    ]);
  });

  test("AK-13: Datum, Preis und Versionsnummer mit Punkt sind nur Kandidaten, die Kopfzeile entscheidet", () => {
    expect(courseNumberCandidates("Beginnt der Kurs am 14.09.2026?")).toEqual([
      "14.09.2026",
    ]);
    expect(courseNumberCandidates("Kostet der Kurs 1.200 Euro?")).toEqual([
      "1.200",
    ]);
    expect(courseNumberCandidates("Gilt das für Version v3.5?")).toEqual([
      "v3.5",
    ]);
    expect(matchesCourseNumber(header("BA56.25"), "BA56.25")).toBe(true);
    expect(matchesCourseNumber(header("BA56.25"), "ba56.25")).toBe(true);
    expect(matchesCourseNumber(header("26B7154.E"), "26b7154.e")).toBe(true);
    // ähnliche Nummern mit und ohne Punkt zählen nicht
    expect(matchesCourseNumber(header("BA56.25"), "BA5625")).toBe(false);
    expect(matchesCourseNumber(header("BA56.25"), "BA56.2")).toBe(false);
    expect(matchesCourseNumber(header("BA56.25"), "BA56.250")).toBe(false);
    expect(matchesCourseNumber(header("26B7154.E"), "26B7154")).toBe(false);
    expect(matchesCourseNumber(header("26B7154"), "26B7154.E")).toBe(false);
    for (const value of ["14.09.2026", "25.08.2026", "1.200", "v3.5"])
      expect(matchesCourseNumber(header("X41.100"), value)).toBe(false);
  });

  // Nachreview rc2 S-L8: zwei Nummern mit Ziffern- oder Halbgeviertstrich
  // ohne Leerzeichen
  test("AK-14 (S-L8): am Ziffern- und Halbgeviertstrich zusätzlich die Hälften als Teile", () => {
    expect(
      courseNumberCandidates("Was kosten die Kurse 26B7602\u201326B7604?")
    ).toEqual(["26B7602-26B7604", "26B7602", "26B7604"]);
    expect(courseNumberCandidates("Kurse 26B7602\u2013T7411A")).toEqual([
      "26B7602-T7411A",
      "26B7602",
      "T7411A",
    ]);
    expect(courseNumberCandidates("Kurse 262-30748\u2013262-30749")).toEqual([
      "262-30748",
      "262-30749",
    ]);
    expect(courseNumberCandidates("Kurse 27S445311\u2012NTU40616R")).toEqual([
      "27S445311",
      "NTU40616R",
    ]);
    expect(courseNumberCandidates("Spanisch 26B7602\u2013A1")).toEqual([
      "26B7602-A1",
      "26B7602",
    ]);
    expect(courseNumberCandidates("Kurs 26B7602\u201304")).toEqual([
      "26B7602-04",
      "26B7602",
    ]);
    expect(courseNumberCandidates("Kurse X41.100\u2013X43.414?")).toEqual([
      "X41.100-X43.414",
      "X41.100",
      "X43.414",
    ]);
    // die Hälften zählen als Teile ihres Worts, nach allen ganzen Wörtern
    expect(
      courseNumberSearchPlan("Kurse 26B7602\u201326B7604 und F320241")
    ).toEqual([
      { candidate: "26B7602-26B7604", position: 6, part: false },
      { candidate: "F320241", position: 26, part: false },
      { candidate: "26B7602", position: 6, part: true },
      { candidate: "26B7604", position: 6, part: true },
    ]);
  });

  // Nachreview rc2 S-L9: Grenze für das Rohwort war nur für Randstriche bemessen
  test("AK-14 (S-L9): Nummer an einem langen Wort wird geprüft, Wörter bis 64 Zeichen", () => {
    expect(COURSE_NUMBER_MAX_WORD_LEN).toBe(64);
    for (const [question, expected] of [
      ["Volkshochschulkurs-26B7602?", ["26B7602"]],
      ["Wann ist Italienischkurs-262-30748?", ["262-30748"]],
      ["Bildungsurlaub-NTU40616R", ["NTU40616R"]],
      ["Wirbelsäulengymnastik-26B7602", ["26B7602"]],
      ["Wochenendseminar\u201326B7602", ["26B7602"]],
      ["Online-Kurs-X41.100?", ["X41.100"]],
    ])
      expect([question, courseNumberCandidates(question)]).toEqual([
        question,
        expected,
      ]);
    expect(courseNumberCandidates(`${"x".repeat(56)}-26B7602`)).toEqual([
      "26B7602",
    ]);
    expect(courseNumberCandidates(`${"x".repeat(57)}-26B7602`)).toEqual([]);
  });

  // Nachreview rc2 S-L10: ein Teil gilt für jedes Wort, zu dem er gehört
  test("AK-14 (S-L10): Teil verweist auf alle Wörter, zu denen er gehört; gesucht wird er einmal", () => {
    expect(
      courseNumberSearchPlan(
        "Ist 26B7602-Online oder der Kurs-26B7602 günstiger?"
      )
    ).toEqual([
      { candidate: "26B7602-Online", position: 4, part: false },
      { candidate: "Kurs-26B7602", position: 28, part: false },
      { candidate: "26B7602", position: 4, part: true, alsoPartAt: [28] },
    ]);
    // ein Teil, der auch als ganzes Wort vorkommt, wird mit diesem gesucht
    expect(courseNumberSearchPlan("Ist 26B7602-Kurs oder 26B7602?")).toEqual([
      { candidate: "26B7602-Kurs", position: 4, part: false },
      { candidate: "26B7602", position: 22, part: false, alsoPartAt: [4] },
    ]);
  });

  test("AK-14 (S-L10)/NAK-4: höchstens 6 Stellen je Teil, auch bei sehr vielen Wörtern", () => {
    // verschiedene Wörter über 15 Zeichen ohne Ziffer vor dem Bindestrich:
    // nur der Teil 26B7602 ist ein Kandidat
    const letters = (i) =>
      [...i.toString(26)]
        .map((c) => String.fromCharCode(97 + parseInt(c, 26)))
        .join("");
    const words = Array.from(
      { length: 100_000 },
      (_, i) => `Volkshochschulkurs${letters(i)}-26B7602`
    );
    const start = Date.now();
    const plan = courseNumberSearchPlan(words.join(" "));
    expect(Date.now() - start).toBeLessThan(2000);
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({ candidate: "26B7602", part: true });
    expect(plan[0].alsoPartAt).toHaveLength(COURSE_NUMBER_MAX_SEARCHED);
  });

  test("NAK-5: 100.000 Punkte oder Striche in einem Wort laufen je unter 50 ms, ohne Kandidaten", () => {
    const inputs = [
      "1" + ".".repeat(100_000) + "1",
      "a" + ".".repeat(100_000) + "a",
      ".".repeat(100_000),
      "1" + ".-".repeat(50_000) + "1",
      "1" + "-.".repeat(50_000) + "a",
      "1" + ".\u2013".repeat(50_000) + "1",
      "1" + "\u2012.\u00AD".repeat(34_000) + "1",
      `Kurs 1${".".repeat(50_000)}a b${"-.".repeat(25_000)}9 Ende`,
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
    // ein Wort danach zählt weiter, auch mit Punkt
    expect(courseNumberCandidates(`a${".-".repeat(50_000)}a BA56.25.`)).toEqual(
      ["BA56.25"]
    );
  });

  test("NAK-4/NAK-5: viele Wörter mit Punkten bleiben schnell und liefern höchstens 5 Kandidaten", () => {
    const inputs = [
      "1.".repeat(500_000),
      "X41.100. ".repeat(100_000),
      "a.1 ".repeat(250_000),
      Array.from({ length: 50_000 }, (_, i) => `BA${10 + (i % 90)}.${i}`).join(
        "\u2013"
      ),
      Array.from({ length: 50_000 }, (_, i) => `Kurs-X${i}.1`).join(" "),
    ];
    const start = Date.now();
    for (const input of inputs)
      expect(courseNumberCandidates(input).length).toBeLessThanOrEqual(5);
    expect(Date.now() - start).toBeLessThan(2000);
    expect(courseNumberCandidates(inputs[1])).toEqual(["X41.100"]);
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

  // Nachreview rc2 S-L10 (K7): gestrichen wird ein Teil nur an der Stelle,
  // deren ganzes Wort traf; an jeder anderen Stelle seines Vorkommens zählt er
  test("AK-14 (S-L10): Teil zählt an jedem Wort, dessen ganzes Wort nichts traf", () => {
    const twice = courseNumberSearchPlan(
      "Ist 26B7602-Online oder der Kurs-26B7602 günstiger?"
    );
    expect(
      courseNumberMatchesInOrder(twice, [[row("online")], [], [row("b")]])
    ).toEqual([[row("online")], [], [row("b")]]);
    // beide ganzen Wörter treffen: der Teil zählt nirgends
    expect(
      courseNumberMatchesInOrder(twice, [
        [row("online")],
        [row("k")],
        [row("b")],
      ])
    ).toEqual([[row("online")], [row("k")]]);
    // umgekehrte Reihenfolge: der Teil steht an der Stelle seines ersten Worts
    const reversed = courseNumberSearchPlan(
      "Ist der Kurs-26B7602 oder 26B7602-Online günstiger?"
    );
    expect(
      courseNumberMatchesInOrder(reversed, [[], [row("online")], [row("b")]])
    ).toEqual([[], [row("b")], [row("online")]]);
    // ganzes Wort, das vorher schon als Teil vorkam: zählt an der ersten Stelle
    const early = courseNumberSearchPlan(
      "Ist 26B7602-Kurs teurer als T7411A oder 26B7602?"
    );
    expect(early.map((e) => e.candidate)).toEqual([
      "26B7602-Kurs",
      "T7411A",
      "26B7602",
    ]);
    expect(
      courseNumberMatchesInOrder(early, [[], [row("t")], [row("b")]])
    ).toEqual([[], [row("b")], [row("t")]]);
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
