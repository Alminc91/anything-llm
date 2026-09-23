const {
  extractFilters,
} = require("../../../utils/chats/metadataFilterExtractor");
const ref = "2026-09-22"; // Dienstag
const ex = (q, ks = []) =>
  extractFilters(q, { referenceDate: ref, knownLocations: ks });

describe("KIE-480 Extraktor — relative Fenster, Monatsdrittel, Datum nach Wochentag", () => {
  test("in den nächsten N Wochen/Tagen/Monaten (Ziffern und Zahlwörter)", () => {
    expect(ex("Was startet in den nächsten 2 Wochen?")).toEqual({
      dateFrom: "2026-09-22",
      dateTo: "2026-10-06",
    });
    expect(ex("Welche Kurse beginnen in den nächsten vier Wochen?")).toEqual({
      dateFrom: "2026-09-22",
      dateTo: "2026-10-20",
    });
    expect(ex("Gibt es in den nächsten 10 Tagen etwas?")).toEqual({
      dateFrom: "2026-09-22",
      dateTo: "2026-10-02",
    });
    expect(ex("Gibt es in den nächsten 2 Monaten neue Kurse?")).toEqual({
      dateFrom: "2026-09-22",
      dateTo: "2026-11-22",
    });
    expect(ex("Was startet in den kommenden drei Monaten?")).toEqual({
      dateFrom: "2026-09-22",
      dateTo: "2026-12-22",
    });
    expect(ex("Kurse innerhalb der nächsten 3 Wochen")).toEqual({
      dateFrom: "2026-09-22",
      dateTo: "2026-10-13",
    });
    expect(ex("Was gibt es die nächsten zwei Wochen?")).toEqual({
      dateFrom: "2026-09-22",
      dateTo: "2026-10-06",
    });
    expect(ex("Ich suche in 2 Wochen einen Yogakurs")).toEqual({
      dateFrom: "2026-09-22",
      dateTo: "2026-10-06",
    });
  });
  test("Monatswechsel bei Monaten wird korrekt gerechnet", () => {
    expect(
      extractFilters("in den nächsten 4 Monaten", {
        referenceDate: "2026-11-30",
      })
    ).toEqual({ dateFrom: "2026-11-30", dateTo: "2027-03-30" });
    expect(
      extractFilters("in den nächsten 3 Monaten", {
        referenceDate: "2026-11-30",
      })
    ).toEqual({ dateFrom: "2026-11-30", dateTo: "2027-02-28" });
  });
  test("Anfang / Mitte / Ende <Monat>", () => {
    expect(ex("Welche Kurse fangen Ende Oktober an?")).toEqual({
      dateFrom: "2026-10-21",
      dateTo: "2026-10-31",
    });
    expect(ex("Was startet Anfang November?")).toEqual({
      dateFrom: "2026-11-01",
      dateTo: "2026-11-10",
    });
    expect(ex("Gibt es Mitte Januar einen Spanischkurs?")).toEqual({
      dateFrom: "2027-01-11",
      dateTo: "2027-01-20",
    });
    expect(ex("Kurse Ende Februar 2027")).toEqual({
      dateFrom: "2027-02-21",
      dateTo: "2027-02-28",
    });
  });
  test("Datum nach Wochentag: 'am Freitag, den 09.10.2026' ist ein Tag, kein Wochentagsfilter", () => {
    expect(ex("Was startet am Freitag, den 09.10.2026?")).toEqual({
      dateFrom: "2026-10-09",
      dateTo: "2026-10-09",
      weekdays: ["fri"],
    });
    expect(ex("Welche Kurse beginnen am 08.12.2026?")).toEqual({
      dateFrom: "2026-12-08",
      dateTo: "2026-12-08",
    });
    expect(ex("Ich habe den 24.09. Zeit")).toEqual({
      dateFrom: "2026-09-24",
      dateTo: "2026-09-24",
    });
  });
  test("bestehendes Verhalten unverändert", () => {
    expect(ex("Welche Kurse beginnen nächste Woche?")).toEqual({
      dateFrom: "2026-09-28",
      dateTo: "2026-10-04",
    });
    expect(
      ex("Gibt es im Dezember Kurse für Seniorinnen und Senioren?")
    ).toEqual({ dateFrom: "2026-12-01", dateTo: "2026-12-31" });
    expect(ex("Welche Gesundheitskurse finden nachmittags statt?")).toEqual({
      timeOfDay: ["afternoon"],
    });
    expect(ex("Ich suche einen Englischkurs am Vormittag.")).toEqual({
      timeOfDay: ["morning"],
    });
    expect(ex("Was kostet der Kurs 262-3202?")).toEqual({});
    expect(ex("Kurse seit 3 Wochen")).toEqual({});
    expect(ex("Was gibt es in Solingen?", ["solingen"])).toEqual({
      location: ["solingen"],
    });
  });
  test("kombiniert: Fenster + Tageszeit", () => {
    expect(
      ex("Ich suche in den nächsten 4 Wochen einen Englischkurs am Abend.")
    ).toEqual({
      dateFrom: "2026-09-22",
      dateTo: "2026-10-20",
      timeOfDay: ["evening"],
    });
  });
});

describe("KIE-480 Extraktor — Preisspanne und Warteliste", () => {
  const ex = (q) =>
    extractFilters(q, { referenceDate: "2026-09-22", knownLocations: [] });
  test("Preisspanne setzt Minimum und Maximum", () => {
    expect(ex("Welche Kurse kosten zwischen 20 und 60 Euro?")).toEqual({
      priceMin: 20,
      priceMax: 60,
    });
    expect(ex("Kurse von 50 bis 100 €")).toEqual({
      priceMin: 50,
      priceMax: 100,
    });
    expect(ex("Gibt es Gesundheitskurse zwischen 20 und 60 €?")).toEqual({
      priceMin: 20,
      priceMax: 60,
    });
    expect(ex("Yoga für 30-80 Euro")).toEqual({ priceMin: 30, priceMax: 80 });
    expect(ex("Ich suche einen Kurs für unter 30 €.")).toEqual({
      priceMax: 30,
    });
  });
  test("Warteliste / ausgebucht = nicht buchbar, freie Plätze = buchbar", () => {
    expect(ex("Bei welchen Kursen gibt es nur noch eine Warteliste?")).toEqual({
      bookable: false,
    });
    expect(ex("Welche Englischkurse stehen auf Warteliste?")).toEqual({
      bookable: false,
    });
    expect(ex("Welche Kurse haben noch freie Plätze?")).toEqual({
      bookable: true,
    });
    expect(ex("Welche Kurse sind fast ausgebucht?")).toEqual({
      bookable: true,
    });
  });
});

describe("KIE-480 Extraktor — Formen aus echten Beta-Fragen", () => {
  const ex = (q) =>
    extractFilters(q, { referenceDate: "2026-09-23", knownLocations: [] });
  test("Monatsname ohne 'im', mit Jahr, Tag+Monat, zwei Monate", () => {
    expect(ex("Pilates Februar 2026")).toEqual({
      dateFrom: "2026-02-01",
      dateTo: "2026-02-28",
    });
    expect(ex("gibt es noch platz B1 in november")).toEqual({
      dateFrom: "2026-11-01",
      dateTo: "2026-11-30",
    });
    expect(ex("Ich suche eine deutsche Kurs am 1 September 2026")).toEqual({
      dateFrom: "2026-09-01",
      dateTo: "2026-09-01",
    });
    expect(ex("Gibt es was für Februar oder März")).toEqual({
      dateFrom: "2027-02-01",
      dateTo: "2027-03-31",
    });
    expect(ex("Kurse seit März")).toEqual({});
  });
  test("nächster Kurs / demnächst / bald -> ab heute", () => {
    expect(ex("Wann startet der nächste Spanischkurs A1?")).toEqual({
      dateFrom: "2026-09-23",
    });
    expect(ex("Gibt es demnächst einen Kochkurs?")).toEqual({
      dateFrom: "2026-09-23",
    });
    expect(ex("Ich hätte gerne einen Kochkurs in der nächsten Zeit")).toEqual({
      dateFrom: "2026-09-23",
    });
  });
  test("Jahr, Jahreszeit, Semester", () => {
    expect(ex("Ich suche einen Bildungsurlaub für nächstes Jahr")).toEqual({
      dateFrom: "2027-01-01",
      dateTo: "2027-12-31",
    });
    expect(ex("Prüfungstermin Lohn und Gehalt Sommer 2027")).toEqual({
      dateFrom: "2027-06-01",
      dateTo: "2027-08-31",
    });
    expect(ex("gibt es schon herbstprogramm?")).toEqual({
      dateFrom: "2026-09-01",
      dateTo: "2026-11-30",
    });
    expect(ex("Wann beginnt das neue Semester?")).toEqual({
      dateFrom: "2027-02-01",
    });
  });
  test("Komposita und Uhrzeiten -> Tageszeit", () => {
    expect(ex("Suche Abendkurs in Wolfsburg Deutsch A2")).toEqual({
      timeOfDay: ["evening"],
    });
    expect(ex("Welche Abendkurse sind frei?")).toEqual({
      timeOfDay: ["evening"],
      bookable: true,
    });
    expect(ex("Der Unterricht soll um 18:00 Uhr beginnen")).toEqual({
      timeOfDay: ["evening"],
    });
    expect(ex("in der zeit von 13.00-14.45 uhr könnte ich immer")).toEqual({
      timeOfDay: ["afternoon"],
    });
    expect(ex("Wann haben Sie in den Ferien geöffnet?")).toEqual({});
    expect(ex("wie viel uhr ist es?")).toEqual({});
  });
});
