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
