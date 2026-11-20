/* eslint-env jest, node */
/**
 * Auswahlstufe, Variante „Person“ (Release 8.2.1, Spezifikation
 * issues/kursauswahl-kursleitung.md, AK-1 bis AK-5, NAK-1 bis NAK-3): Nennt
 * die Suchanfrage den Nachnamen einer Kursleitung mit mindestens 2 Kursen im
 * Pool, gilt unter deren Kursen die Log-Odds-Spanne 1,5 statt 1,0. Spanne
 * 0,02 und Boden bleiben; ein Kurs ohne diesen Schlüssel unter der Schwelle
 * 1,0 beendet die Suche nicht, er wird übersprungen. Alles andere wie 8.2.
 */
const fs = require("fs");
const path = require("path");
const {
  selectContexts,
  selectionConfig,
} = require("../../../../utils/vectorDbProviders/lance/contextSelection");
const SearchTrace = require("../../../../utils/vectorDbProviders/lance/searchTrace");

const MODULE = "../../../../utils/vectorDbProviders/lance/contextSelection";
const TODAY = "2026-10-08";
const QUERY = "Welche Kurse gibt Anna Beispiel?";
const ids = (out) => out.selected.map((r) => r.id);
const logOdds = (p) => {
  const q = Math.min(Math.max(p, 1e-7), 1 - 1e-7);
  return Math.log(q / (1 - q));
};

/** Kurszeile im Format der Kursdokumente; `leitung` undefined = ohne Zeile. */
const kurs = (id, score, start, leitung, bookable = true) => ({
  id,
  title: `kurs-${id}.txt`,
  text: [
    `Titel: Kurs ${id}`,
    `Kursnummer: ${id}`,
    ...(leitung === undefined ? [] : [`Kursleitung: ${leitung}`]),
    "Kategorie: Sprachen",
  ].join("\n"),
  rerank_score: score,
  start_date: start,
  bookable,
});
const seite = (id, score, text = `Übersicht ${id}`) => ({
  id,
  title: `${id}.html`,
  text,
  rerank_score: score,
  start_date: null,
  bookable: null,
});

// Hauptfall (Log-Odds zum Führenden b1 mit 6,91): f1 0,69 darunter, f2 1,10,
// b2 1,39, b3 1,51. b1, b2 und b3 hält Anna Beispiel, f1 und f2 Otto Fremd.
const HAUPT = () => [
  kurs("b1", 0.999, "2027-03-01", "Anna Beispiel"),
  kurs("f1", 0.998, "2026-12-01", "Otto Fremd"),
  kurs("f2", 0.997, "2026-10-09", "Otto Fremd"),
  kurs("b2", 0.996, "2026-10-15", "Anna Beispiel"),
  kurs("b3", 0.9955, "2026-10-10", "Anna Beispiel"),
];
const HAUPT_82 = ["f1", "b1", "f2", "b3"];
const HAUPT_PERSON = ["b2", "f1", "b1", "f2"];

const run = (rows, query, settings, topN = 4) =>
  selectContexts(rows, { topN, today: TODAY, settings, query });

/** Schlüssel, die selectContexts für zwei Kurse mit diesem Text erkennt. */
const keysFor = (leitungText, query) => {
  const row = (id, score, start) => ({
    id,
    title: `${id}.txt`,
    text: leitungText,
    rerank_score: score,
    start_date: start,
    bookable: true,
  });
  const out = run(
    [row("x1", 0.9, "2026-11-01"), row("x2", 0.8, "2026-12-01")],
    query
  );
  return out.person.keys;
};

describe("Hauptfall: Kurse der genannten Kursleitung nach Datum", () => {
  test("Vorbedingung: Log-Odds-Abstände wie beschrieben", () => {
    const l = (p) => logOdds(0.999) - logOdds(p);
    expect(l(0.998)).toBeLessThan(1);
    expect(l(0.997)).toBeGreaterThan(1);
    expect(l(0.997)).toBeLessThan(1.5);
    expect(l(0.996)).toBeGreaterThan(1);
    expect(l(0.996)).toBeLessThan(1.5);
    expect(l(0.9955)).toBeGreaterThan(1.5);
  });

  test("ohne Anfrage wie 8.2", () => {
    const out = run(HAUPT());
    expect(ids(out)).toEqual(HAUPT_82);
    expect(out.person).toEqual({ keys: [], courses: 0, applied: false });
  });

  test("mit Namen: b2 (1,39 unter dem Führenden) kommt nach Datum vor, b3 (1,51) nicht", () => {
    const out = run(HAUPT(), QUERY);
    expect(ids(out)).toEqual(HAUPT_PERSON);
    expect(out.person).toEqual({
      keys: ["beispiel"],
      courses: 3,
      applied: true,
    });
    expect(out.rule).toBe("stufe-span0.02-logit1-floor0.3-deckel1-person1.5");
  });
});

describe("AK-1: Erkennung der Kursleitung", () => {
  test("voller Name, nur Nachname, Kleinschreibung", () => {
    const t = "Kursleitung: Anna Beispiel";
    expect(keysFor(t, QUERY)).toEqual(["beispiel"]);
    expect(keysFor(t, "Kurse bei Frau Beispiel")).toEqual(["beispiel"]);
    expect(keysFor(t, "kurse von anna beispiel")).toEqual(["beispiel"]);
    expect(keysFor("Kursleitung: ANNA BEISPIEL", "beispiel?")).toEqual([
      "beispiel",
    ]);
    expect(keysFor(t, "KURSE VON BEISPIEL")).toEqual(["beispiel"]);
  });

  test("Titel mit und ohne Punkt fallen weg; danach braucht ein Name 2 Wörter", () => {
    for (const leitung of [
      "Dr. Anna Beispiel",
      "Prof. Dr. Anna Beispiel",
      "Frau Anna Beispiel",
      "Herr Anna Beispiel",
      "Herrn Anna Beispiel",
      "Mag. Anna Beispiel",
      "dipl. Anna Beispiel",
      "dr Anna Beispiel",
      "prof Anna Beispiel",
    ])
      expect(keysFor(`Kursleitung: ${leitung}`, QUERY)).toEqual(["beispiel"]);
    for (const leitung of ["Frau Beispiel", "Dr. Prof. Beispiel", "Beispiel"])
      expect(keysFor(`Kursleitung: ${leitung}`, QUERY)).toEqual([]);
  });

  test("Trenner: Komma, Semikolon, Schrägstrich, &, Wort „und“", () => {
    for (const sep of [", ", "; ", " / ", " & ", " und ", ",", "/", "&"]) {
      const t = `Kursleitung: Anna Beispiel${sep}Otto Fremd`;
      expect(keysFor(t, "Kurse von Herrn Fremd")).toEqual(["fremd"]);
      expect(keysFor(t, QUERY)).toEqual(["beispiel"]);
    }
    // „und“ nur als ganzes Wort
    expect(keysFor("Kursleitung: Rosamund Beispiel", QUERY)).toEqual([
      "beispiel",
    ]);
    expect(keysFor("Kursleitung: Anna Undine", "Kurse von Undine")).toEqual([
      "undine",
    ]);
  });

  test("Doppelname: ganz oder ein Teil ab 4 Zeichen", () => {
    const t = "Kursleitung: Anna Müller-Lüdenscheidt";
    const key = ["müller-lüdenscheidt"];
    expect(keysFor(t, "Kurse von Frau Lüdenscheidt")).toEqual(key);
    expect(keysFor(t, "Kurse von Frau Müller-Lüdenscheidt")).toEqual(key);
    expect(keysFor(t, "Kurse bei Müller")).toEqual(key);
    const kurz = "Kursleitung: Anna Li-Wagner";
    expect(keysFor(kurz, "Kurse bei Li")).toEqual([]);
    expect(keysFor(kurz, "Kurse bei Wagner")).toEqual(["li-wagner"]);
    // Bindestrich in der Frage: auch je Teil
    expect(keysFor("Kursleitung: Anna Beispiel", "Beispiel-Kurse?")).toEqual([
      "beispiel",
    ]);
  });

  test("Mindestlänge 4, nur ganze Wörter", () => {
    expect(keysFor("Kursleitung: Anna Kim", "Kurse von Anna Kim")).toEqual([]);
    expect(keysFor("Kursleitung: Anna Wolf", "Kurse von Wolf")).toEqual([
      "wolf",
    ]);
    expect(keysFor("Kursleitung: Anna Beispiel", "Beispielkurse")).toEqual([]);
    expect(keysFor("Kursleitung: Anna Beispiel", "Beispie")).toEqual([]);
  });

  test("Nachname ohne Zeichen außer Buchstaben und Bindestrich, NFKC", () => {
    expect(keysFor("Kursleitung: Anna Beispiel.", QUERY)).toEqual(["beispiel"]);
    expect(keysFor("Kursleitung: Anna Beispiel*", QUERY)).toEqual(["beispiel"]);
    expect(keysFor("Kursleitung: Anna Beispiel2", QUERY)).toEqual(["beispiel"]);
    // zerlegtes ü im Text, zusammengesetztes in der Frage
    expect(keysFor("Kursleitung: Anna Müller", "Kurse von Müller")).toEqual([
      "müller",
    ]);
    // Vollbreite Buchstaben
    expect(keysFor("Kursleitung: Anna Ｂｅｉｓｐｉｅｌ", QUERY)).toEqual([
      "beispiel",
    ]);
  });

  test("nur die erste Zeile „Kursleitung:“ zählt", () => {
    const t = "Kursleitung: Otto Fremd\nKursleitung: Anna Beispiel";
    expect(keysFor(t, QUERY)).toEqual([]);
    expect(keysFor(t, "Kurse von Fremd")).toEqual(["fremd"]);
  });

  test("nur Kurse zählen: Übersichtsseite mit derselben Kursleitung ergibt keinen zweiten Kurs", () => {
    const rows = [
      kurs("b1", 0.999, "2027-03-01", "Anna Beispiel"),
      seite("s1", 0.9985, "Kursleitung: Anna Beispiel"),
      kurs("f1", 0.998, "2026-12-01", "Otto Fremd"),
      kurs("b2", 0.996, "2026-10-15", "Andere Person"),
    ];
    expect(run(rows, QUERY).person.keys).toEqual([]);
  });

  test("Text fehlt oder ist kein String: kein Schlüssel, kein Fehler", () => {
    const rows = HAUPT().map((r) => ({ ...r, text: undefined }));
    rows[1].text = 42;
    rows[2].text = { text: "Kursleitung: Anna Beispiel" };
    expect(() => run(rows, QUERY)).not.toThrow();
    expect(run(rows, QUERY).person.keys).toEqual([]);
    expect(ids(run(rows, QUERY))).toEqual(HAUPT_82);
  });

  test("zwei genannte Kursleitungen: beide Schlüssel", () => {
    const rows = [...HAUPT(), kurs("f3", 0.9, "2026-11-11", "Otto Fremd")];
    expect(run(rows, "Kurse von Beispiel oder Fremd").person.keys).toEqual([
      "beispiel",
      "fremd",
    ]);
  });
});

describe("AK-2: leere Zeile und Doppelpunkt", () => {
  test("leere Zeile liefert keinen Namen und nie die Folgezeile", () => {
    expect(keysFor("Kursleitung:\nAnna Beispiel", QUERY)).toEqual([]);
    expect(keysFor("Kursleitung:  \t\nAnna Beispiel", QUERY)).toEqual([]);
    expect(keysFor("Kursleitung: \nKategorie: Anna Beispiel", QUERY)).toEqual(
      []
    );
  });

  test("ein Wert mit Doppelpunkt gilt als kein Name", () => {
    expect(keysFor("Kursleitung: Termin: Anna Beispiel", QUERY)).toEqual([]);
    expect(keysFor("Kursleitung: Anna Beispiel 18:00", QUERY)).toEqual([]);
  });

  test("Zeilenende \\r\\n: Name ohne \\r", () => {
    expect(
      keysFor("Kursleitung: Anna Beispiel\r\nKategorie: Sprachen", QUERY)
    ).toEqual(["beispiel"]);
  });
});

describe("NAK-1: nur 1 Kurs der Person im Pool: keine Änderung", () => {
  test("Wort der Frage gleicht einem Nachnamen, nur ein Kurs", () => {
    const rows = HAUPT();
    rows[3] = kurs("b2", 0.996, "2026-10-15", "Eva Dritte");
    rows[4] = kurs("b3", 0.9955, "2026-10-10", "Eva Dritte");
    const ohne = run(rows);
    const mit = run(rows, QUERY);
    expect(ids(mit)).toEqual(ids(ohne));
    expect(mit.person).toEqual({ keys: [], courses: 0, applied: false });
  });
});

describe("AK-3: Stufenregel mit Schlüssel", () => {
  test("Kurs einer anderen Person dazwischen wird übersprungen, nicht vorgezogen", () => {
    // f2 beginnt am frühesten, liegt aber 1,10 unter dem Führenden b1 und hält
    // nicht dessen Schlüssel: Er beendet die Suche nicht und kommt nicht vor.
    const out = run(HAUPT(), QUERY, undefined, 1);
    expect(ids(out)).toEqual(["b2"]);
    expect(
      run(HAUPT(), undefined, undefined, 1).selected.map((r) => r.id)
    ).toEqual(["f1"]);
  });

  test("Kurs ohne Schlüssel innerhalb 1,0 bleibt Konkurrent", () => {
    const rows = HAUPT();
    rows[1] = kurs("f1", 0.998, "2026-10-12", "Otto Fremd");
    expect(ids(run(rows, QUERY, undefined, 1))).toEqual(["f1"]);
  });

  test("Spanne 0,02 gilt weiter", () => {
    // 0,9 gegen 0,87: Log-Odds nur 0,30 auseinander, Score 0,03
    const rows = [
      kurs("a1", 0.9, "2027-03-01", "Anna Beispiel"),
      kurs("a2", 0.87, "2026-10-10", "Anna Beispiel"),
      kurs("o1", 0.5, "2026-10-09", "Otto Fremd"),
    ];
    expect(ids(run(rows, QUERY))).toEqual(["a1", "a2", "o1"]);
    expect(ids(run(rows, QUERY))).toEqual(ids(run(rows)));
    // mit größerer Spanne zieht das Datum vor, mit und ohne Namen
    expect(ids(run(rows, QUERY, { span: 0.05 }))).toEqual(["a2", "a1", "o1"]);
  });

  test("Boden 0,3 gilt weiter", () => {
    const rows = [
      kurs("a1", 0.31, "2027-03-01", "Anna Beispiel"),
      kurs("a2", 0.295, "2026-10-10", "Anna Beispiel"),
      kurs("a3", 0.29, "2026-10-09", "Anna Beispiel"),
    ];
    expect(ids(run(rows, QUERY))).toEqual(["a1", "a2", "a3"]);
    expect(ids(run(rows, QUERY))).toEqual(ids(run(rows)));
  });

  test("ohne Schlüssel beim Führenden genau 8.2", () => {
    const rows = [kurs("f0", 0.9999, "2027-05-01", "Otto Fremd"), ...HAUPT()];
    const ohne = run(rows, undefined, undefined, 1);
    const mit = run(rows, QUERY, undefined, 1);
    expect(ids(mit)).toEqual(ids(ohne));
    expect(mit.person).toEqual({
      keys: ["beispiel"],
      courses: 3,
      applied: false,
    });
  });

  test("Garantie über zufällige Pools: Spanne immer, Log-Odds bis 1,5", () => {
    // deterministischer Zufall (LCG), damit der Test reproduzierbar ist
    let seed = 20261120;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const NAMEN = ["Anna Beispiel", "Otto Fremd", "Eva Dritte", "Kai Vogel"];
    for (let n = 0; n < 300; n++) {
      const size = 3 + Math.floor(rnd() * 10);
      const rows = Array.from({ length: size }, (_, i) => {
        const day = 1 + Math.floor(rnd() * 200);
        const d = new Date(Date.UTC(2026, 9, 8 + day));
        const score =
          rnd() < 0.7 ? 1 - Math.pow(10, -1 - rnd() * 4) : rnd() * 0.9;
        return kurs(
          `k${i}`,
          score,
          d.toISOString().slice(0, 10),
          NAMEN[Math.floor(rnd() * NAMEN.length)],
          rnd() < 0.85
        );
      }).sort((a, b) => b.rerank_score - a.rerank_score);
      const out = run(rows, "Kurse von Frau Beispiel");
      const sel = out.selected;
      for (let a = 0; a < sel.length; a++)
        for (const later of [
          ...sel.slice(a + 1),
          ...rows.filter((r) => !sel.includes(r)),
        ]) {
          expect(later.rerank_score - sel[a].rerank_score).toBeLessThanOrEqual(
            0.02 + 1e-9
          );
          expect(
            logOdds(later.rerank_score) - logOdds(sel[a].rerank_score)
          ).toBeLessThanOrEqual(1.5 + 1e-9);
        }
      // Frage ohne bekannten Nachnamen: genau 8.2
      expect(ids(run(rows, "Kurse von Frau Niemand"))).toEqual(ids(run(rows)));
    }
  });
});

describe("AK-5: Stellgröße COURSE_SELECTION_PERSON_LOGIT", () => {
  test("Standard 1.5; gültige Werte werden übernommen, leer gilt als nicht gesetzt", () => {
    jest.isolateModules(() => {
      const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const fresh = require(MODULE);
        const person = (raw) =>
          fresh.selectionConfig({ COURSE_SELECTION_PERSON_LOGIT: raw })
            .personLogit;
        expect(fresh.selectionConfig({}).personLogit).toBe(1.5);
        expect(person("2")).toBe(2);
        expect(person(" 0.5 ")).toBe(0.5);
        expect(person("0")).toBe(0);
        expect(person("0.0")).toBe(0);
        expect(person("")).toBe(1.5);
        expect(person("   ")).toBe(1.5);
        expect(person(undefined)).toBe(1.5);
        expect(warn).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    });
  });

  test("ungültig (negativ, Text) → Standard, einmal ein Hinweis [Auswahlstufe]", () => {
    jest.isolateModules(() => {
      const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const fresh = require(MODULE);
        const person = (raw) =>
          fresh.selectionConfig({ COURSE_SELECTION_PERSON_LOGIT: raw })
            .personLogit;
        for (const bad of ["-1", "-0.5", "abc", "1,5", "NaN", "Infinity"])
          expect(person(bad)).toBe(1.5);
        expect(warn).toHaveBeenCalledTimes(1);
        const [message] = warn.mock.calls[0];
        expect(message).toMatch(/\[Auswahlstufe\]/);
        expect(message).toMatch(/COURSE_SELECTION_PERSON_LOGIT="-1"/);
        expect(message).toMatch(/Standard 1\.5/);
        expect(message).not.toMatch(/COURSE_SELECTION_TIE_SPAN/);
        expect(message).not.toMatch(/[–—]/);
      } finally {
        warn.mockRestore();
      }
    });
  });

  test("0 schaltet die Regel ganz ab (keine Erkennung, Ergebnis wie 8.2)", () => {
    const settings = selectionConfig({ COURSE_SELECTION_PERSON_LOGIT: "0" });
    const out = run(HAUPT(), QUERY, settings);
    expect(ids(out)).toEqual(HAUPT_82);
    expect(out.person).toEqual({ keys: [], courses: 0, applied: false });
    expect(out.rule).toBe("stufe-span0.02-logit1-floor0.3-deckel1-person0");
  });

  test("Wert unter der Log-Odds-Spanne wirkt wie diese (D1)", () => {
    const settings = selectionConfig({ COURSE_SELECTION_PERSON_LOGIT: "0.5" });
    const out = run(HAUPT(), QUERY, settings);
    expect(ids(out)).toEqual(HAUPT_82);
    expect(out.rule).toBe("stufe-span0.02-logit1-floor0.3-deckel1-person0.5");
    // mit Log-Odds-Spanne 2 wirkt Person 1,5 wie 2: b3 (1,51) kommt vor
    const breit = run(HAUPT(), QUERY, { logitSpan: 2, personLogit: 1.5 });
    expect(ids(breit)).toEqual(ids(run(HAUPT(), undefined, { logitSpan: 2 })));
  });

  test("größerer Wert erweitert nur die Kurse der Person (2: auch b3)", () => {
    const out = run(HAUPT(), QUERY, { personLogit: 2 });
    expect(ids(out)).toEqual(["b3", "b2", "f1", "b1"]);
    expect(out.rule).toBe("stufe-span0.02-logit1-floor0.3-deckel1-person2");
  });

  test("ungültige settings.personLogit → Standard 1.5", () => {
    for (const bad of [-1, NaN, Infinity, "2", null])
      expect(run(HAUPT(), QUERY, { personLogit: bad })).toMatchObject({
        rule: "stufe-span0.02-logit1-floor0.3-deckel1-person1.5",
      });
    for (const bad of [-1, NaN, Infinity, "2", null])
      expect(ids(run(HAUPT(), QUERY, { personLogit: bad }))).toEqual(
        HAUPT_PERSON
      );
  });
});

describe("AK-6: ohne gültige Anfrage wie 8.2", () => {
  test.each([
    ["fehlt", undefined],
    ["null", null],
    ["leer", ""],
    ["nur Leerraum", "   "],
    ["Zahl", 42],
    ["Liste", ["Beispiel"]],
    ["Objekt", { toString: () => "Beispiel" }],
  ])("Anfrage %s", (_, query) => {
    const out = run(HAUPT(), query);
    expect(ids(out)).toEqual(HAUPT_82);
    expect(out.person).toEqual({ keys: [], courses: 0, applied: false });
  });
});

describe("NAK-2: Sonderzeichen und sehr lange Zeilen", () => {
  const SONDER = "(Kurs)* [a-z]+ \\d{2} $^.|?{} \\ 😀🧘‍♀️ ä ö ü ß ﬁ";
  const lang = (s, n = 10000) => s.repeat(Math.ceil(n / s.length)).slice(0, n);

  test("Frage und Kurstext je 10.000 Zeichen: kein Fehler, unter 50 ms", () => {
    const query = lang(`${SONDER} Beispiel `);
    const leitung = lang(`Anna Beispiel, ${SONDER} / und & ; `);
    const rows = Array.from({ length: 12 }, (_, i) =>
      kurs(
        `k${i}`,
        0.999 - i * 0.0005,
        `2026-1${i % 3}-1${i % 9}`,
        i % 3 === 0 ? leitung : lang(SONDER)
      )
    );
    rows.push(seite("s1", 0.5, lang(`Kursleitung: ${SONDER}`)));
    rows.push(kurs("leer", 0.4, "2026-11-01", lang(" ")));
    rows.push(kurs("nl", 0.39, "2026-11-01", lang("\n")));
    expect(() => run(rows, query)).not.toThrow();
    // aufgewärmt messen, schnellster von 3 Läufen
    const times = [];
    for (let r = 0; r < 3; r++) {
      const start = process.hrtime.bigint();
      run(rows, query);
      times.push(Number(process.hrtime.bigint() - start) / 1e6);
    }
    expect(Math.min(...times)).toBeLessThan(50);
    expect(run(rows, query).selected).toHaveLength(4);
  });

  test("Anfrage aus Sonderzeichen und Emojis: kein Schlüssel, wie 8.2", () => {
    const out = run(HAUPT(), `${SONDER} ${lang("*", 10000)}`);
    expect(ids(out)).toEqual(HAUPT_82);
  });
});

describe("Parität mit der gemessenen Variante p1.5 (Fixture aus messung.js)", () => {
  const fixture = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, "fixtures", "kursleitung_paritaet.json"),
      "utf8"
    )
  );
  const pick = (fall, opts) =>
    selectContexts(
      fall.rows.map((r) => ({ ...r })),
      { topN: 4, today: fall.heute, ...opts }
    ).selected.map((r) => r.id);

  test("Fixture vollständig", () => {
    expect(fixture.faelle).toHaveLength(61);
    expect(fixture.faelle.filter((f) => f.greift)).toHaveLength(43);
    expect(
      fixture.faelle
        .filter((f) => f.p15.join() !== f.d10.join())
        .map((f) => f.id)
    ).toEqual([
      "T-K5_leitung-05",
      "T-K5_leitung-14",
      "T-K5_leitung-15",
      "N-P04",
      "N-P07",
    ]);
  });

  test("mit Frage gleich p1.5, ohne Frage und mit personLogit 0 gleich d10", () => {
    const abweichung = { p15: [], ohne: [], aus: [], greift: [] };
    for (const fall of fixture.faelle) {
      if (pick(fall, { query: fall.frage }).join() !== fall.p15.join())
        abweichung.p15.push(fall.id);
      if (pick(fall, {}).join() !== fall.d10.join())
        abweichung.ohne.push(fall.id);
      if (
        pick(fall, {
          query: fall.frage,
          settings: { personLogit: 0 },
        }).join() !== fall.d10.join()
      )
        abweichung.aus.push(fall.id);
      const out = selectContexts(
        fall.rows.map((r) => ({ ...r })),
        { topN: 4, today: fall.heute, query: fall.frage }
      );
      if (out.person.keys.length > 0 !== fall.greift)
        abweichung.greift.push(fall.id);
    }
    expect(abweichung).toEqual({ p15: [], ohne: [], aus: [], greift: [] });
  });
});

describe("NAK-3: Suchspur ohne Namen und Fragetext", () => {
  test("selectionBlock zeigt nur, ob die Regel griff", () => {
    const out = run(HAUPT(), QUERY);
    const block = SearchTrace.selectionBlock(
      { enabled: true, today: TODAY },
      out,
      12
    );
    expect(block.person).toEqual({ matched: true, courses: 3, applied: true });
    expect(block.rule).toBe("stufe-span0.02-logit1-floor0.3-deckel1-person1.5");
    const json = JSON.stringify(block).toLowerCase();
    expect(json).not.toContain("beispiel");
    expect(json).not.toContain("anna");
    const ohne = SearchTrace.selectionBlock(
      { enabled: true, today: TODAY },
      run(HAUPT()),
      12
    );
    expect(ohne.person).toEqual({ matched: false, courses: 0, applied: false });
  });

  test("Rückfall-Ergebnisse tragen ein leeres person-Feld", () => {
    for (const out of [
      run([], QUERY),
      selectContexts(HAUPT(), { topN: 4, today: "kein Datum", query: QUERY }),
      run(
        HAUPT().map((r) => ({ ...r, rerank_score: null })),
        QUERY
      ),
      run(HAUPT().slice(0, 1), QUERY),
    ])
      expect(out.person).toEqual({ keys: [], courses: 0, applied: false });
  });
});
