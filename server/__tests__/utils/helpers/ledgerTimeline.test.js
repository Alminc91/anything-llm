/* eslint-env jest, node */
// KIE-536 — Zeitabschnitte der Auswertung „Konversationen": Körnung nach
// Zeitraumlänge, Kalenderwochen (Montag-Sonntag), Monate, angeschnittene
// Abschnitte und die Prüfung des Zeitraums.
//
// Gerechnet wird nur mit Kalendertagen; die Zeitzone des Prozesses wird nicht
// gesetzt und darf keine Rolle spielen (TZ=UTC, Europe/Berlin,
// America/New_York).
const {
  MAX_BUCKETS,
  parseCalendarDay,
  validateDayRange,
  timelineLayout,
  nextDay,
  previousLayout,
} = require("../../../utils/helpers/ledgerTimeline");

/** Kalendertag + n Tage, unabhängig vom geprüften Code gerechnet. */
function addDays(day, n) {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + n);
  return date.toISOString().slice(0, 10);
}

/** Wochentag eines Kalendertags, 1 = Montag … 7 = Sonntag. */
function weekday(day) {
  return new Date(`${day}T12:00:00Z`).getUTCDay() || 7;
}

/** Alle Tage eines Zeitraums. */
function daysOf(from, to) {
  const days = [];
  for (let day = from; day <= to; day = addDays(day, 1)) days.push(day);
  return days;
}

describe("parseCalendarDay", () => {
  test.each([
    "2026-10-06",
    "2024-02-29",
    "2026-12-31",
    "2026-01-01",
    "1999-05-30",
    "0001-01-01",
    "9998-12-31",
  ])("%s ist ein Kalendertag", (day) => {
    expect(parseCalendarDay(day)).toEqual(expect.any(Number));
  });

  test("aufeinanderfolgende Tage haben aufeinanderfolgende Nummern", () => {
    expect(
      parseCalendarDay("2026-03-01") - parseCalendarDay("2026-02-28")
    ).toBe(1);
    expect(
      parseCalendarDay("2024-03-01") - parseCalendarDay("2024-02-28")
    ).toBe(2);
    expect(
      parseCalendarDay("2027-01-01") - parseCalendarDay("2026-12-31")
    ).toBe(1);
    // Zeitumstellung: Der Kalendertag bleibt ein Tag.
    expect(
      parseCalendarDay("2026-03-30") - parseCalendarDay("2026-03-29")
    ).toBe(1);
    expect(
      parseCalendarDay("2026-10-26") - parseCalendarDay("2026-10-25")
    ).toBe(1);
  });

  test.each([
    ["2026-02-30"],
    ["2026-02-29"], // kein Schaltjahr
    ["2026-13-01"],
    ["2026-00-10"],
    ["2026-10-00"],
    ["2026-10-32"],
    ["2026-10-6"],
    ["2026-9-06"],
    ["06.10.2026"],
    ["2026/10/06"],
    ["2026-10-06T00:00:00Z"],
    ["2026-10-06 "],
    [" 2026-10-06"],
    ["0000-01-01"],
    ["9999-01-01"],
    ["9999-12-31"],
    ["+002026-10-06"],
    ["-2026-10-06"],
    [""],
    ["heute"],
    [null],
    [undefined],
    [20261006],
    [new Date("2026-10-06")],
    [["2026-10-06"]],
    [{ day: "2026-10-06" }],
  ])("%p ist kein Kalendertag", (value) => {
    expect(parseCalendarDay(value)).toBeNull();
  });
});

describe("validateDayRange", () => {
  test("gültig: ein Tag, mehrere Tage, genau 92 Kalendermonate", () => {
    expect(validateDayRange("2026-10-06", "2026-10-06").valid).toBe(true);
    expect(validateDayRange("2026-09-13", "2026-10-12").valid).toBe(true);
    // März 2019 bis Oktober 2026 sind 92 Kalendermonate - ganz oder berührt.
    expect(validateDayRange("2019-03-01", "2026-10-31").valid).toBe(true);
    expect(validateDayRange("2019-03-01", "2026-10-12").valid).toBe(true);
    expect(validateDayRange("2019-03-31", "2026-10-01").valid).toBe(true);
    // über den Jahreswechsel und den 29. Februar
    expect(validateDayRange("2016-05-01", "2023-12-31").valid).toBe(true);
    expect(validateDayRange("2016-07-15", "2024-02-29").valid).toBe(true);
  });

  test("ungültig: fromDay nach toDay", () => {
    expect(validateDayRange("2026-10-07", "2026-10-06")).toEqual({
      valid: false,
      error: expect.any(String),
    });
    expect(validateDayRange("2027-01-01", "2026-12-31").valid).toBe(false);
  });

  test("ungültig: mehr als 92 Kalendermonate - auch nur um einen Tag", () => {
    expect(validateDayRange("2019-02-28", "2026-10-12")).toEqual({
      valid: false,
      error: expect.stringContaining(`${MAX_BUCKETS} calendar months`),
    });
    expect(validateDayRange("2019-03-31", "2026-11-01").valid).toBe(false);
    expect(validateDayRange("2016-04-30", "2023-12-31").valid).toBe(false);
    expect(validateDayRange("2016-06-30", "2024-02-29").valid).toBe(false);
  });

  test("ungültig: mehr als 10 Jahre (NAK-6)", () => {
    // 13.10.2016 bis 12.10.2026 sind genau 10 Jahre: 121 Kalendermonate.
    expect(validateDayRange("2016-10-13", "2026-10-12").valid).toBe(false);
    expect(validateDayRange("2016-10-12", "2026-10-12").valid).toBe(false);
    expect(validateDayRange("2016-02-29", "2026-03-01").valid).toBe(false);
    expect(validateDayRange("1990-01-01", "2026-10-12").valid).toBe(false);
    expect(validateDayRange("0001-01-01", "9998-12-31").valid).toBe(false);
  });

  test("ungültig: ein Wert ist kein Kalendertag", () => {
    for (const [from, to] of [
      ["2026-02-30", "2026-03-05"],
      ["2026-10-01", "2026-10-32"],
      [undefined, "2026-10-06"],
      ["2026-10-06", undefined],
      [null, null],
      ["", ""],
      [20261006, 20261006],
      ["2026-10-06T00:00:00.000Z", "2026-10-06T23:59:59.999Z"],
    ])
      expect([from, to, validateDayRange(from, to).valid]).toEqual([
        from,
        to,
        false,
      ]);
  });
});

describe("koernung (AK-3)", () => {
  // 644 Tage sind 92 Wochen: Als Kalenderwochen (Montag-Sonntag) gehen sie
  // nur auf, wenn der Zeitraum an einem Montag beginnt.
  test.each([
    [1, "2026-10-12", "hour", 24],
    [2, "2026-10-11", "day", 2],
    [30, "2026-09-13", "day", 30],
    [92, "2026-07-13", "day", 92],
    [93, "2026-07-12", "week", 15],
    [365, "2025-10-13", "week", 53],
    [644, "2025-01-06", "week", 92],
    [645, "2025-01-06", "month", 22],
    [1100, "2023-10-09", "month", 37],
  ])(
    "koernung: %i Tage ab %s → %s, %i Abschnitte",
    (days, fromDay, granularity, count) => {
      const layout = timelineLayout(fromDay, addDays(fromDay, days - 1));
      expect(layout.granularity).toBe(granularity);
      expect(layout.buckets).toHaveLength(count);
      expect(layout.buckets.length).toBeLessThanOrEqual(
        granularity === "hour" ? 24 : MAX_BUCKETS
      );
    }
  );

  test("koernung: höchstens 92 Abschnitte für jeden gültigen Zeitraum, an jedem Wochentag begonnen", () => {
    const seen = new Set();
    for (const start of daysOf("2025-01-06", "2025-01-12"))
      for (const days of [
        1, 2, 3, 7, 30, 31, 91, 92, 93, 94, 100, 364, 365, 366, 637, 638, 639,
        643, 644, 645, 646, 700, 1100, 2000, 2780,
      ]) {
        expect(validateDayRange(start, addDays(start, days - 1)).valid).toBe(
          true
        );
        const layout = timelineLayout(start, addDays(start, days - 1));
        seen.add(layout.granularity);
        expect([
          start,
          days,
          layout.buckets.length <=
            (layout.granularity === "hour" ? 24 : MAX_BUCKETS),
        ]).toEqual([start, days, true]);
        // Die feinste Körnung, die passt: Tage bis 92, darüber nie Tage.
        if (days > 1 && days <= 92) expect(layout.granularity).toBe("day");
        if (days > 92) expect(layout.granularity).not.toBe("day");
        // Bis 638 Tage berührt ein Zeitraum höchstens 92 Kalenderwochen.
        if (days > 92 && days <= 638) expect(layout.granularity).toBe("week");
        if (days > 644) expect(layout.granularity).toBe("month");
      }
    expect([...seen].sort()).toEqual(["day", "hour", "month", "week"]);
  });

  test("koernung: 644 Tage ab einem Mittwoch berühren 93 Kalenderwochen → Monate", () => {
    expect(weekday("2025-01-08")).toBe(3);
    const layout = timelineLayout("2025-01-08", addDays("2025-01-08", 643));
    expect(layout.granularity).toBe("month");
    expect(layout.buckets).toHaveLength(22);
  });

  test("koernung: Der Monat ist die gröbste Körnung - 92 Monate sind der längste Zeitraum, 93 gibt es nicht", () => {
    for (const [fromDay, toDay] of [
      ["2019-03-01", "2026-10-31"],
      ["2019-03-31", "2026-10-01"],
    ]) {
      const layout = timelineLayout(fromDay, toDay);
      expect(layout.granularity).toBe("month");
      expect(layout.buckets).toHaveLength(MAX_BUCKETS);
      expect(layout.buckets[0].start).toBe(fromDay);
      expect(layout.buckets.at(-1).end).toBe(toDay);
    }
    // Ein Tag mehr an einem der beiden Enden berührt den 93. Monat.
    for (const [fromDay, toDay] of [
      ["2019-02-28", "2026-10-31"],
      ["2019-03-01", "2026-11-01"],
      ["2016-10-13", "2026-10-12"],
    ])
      expect(() => timelineLayout(fromDay, toDay)).toThrow(
        /timelineLayout: The period must not span more than 92 calendar months/
      );
  });

  test("koernung: kein Zeitraum ergibt mehr als 92 Abschnitte - er ist gültig mit höchstens 92 oder ungültig", () => {
    // Zeiträume um die Grenze von 92 Monaten, von jedem Tag eines Monats aus
    // und mit jedem Ende im Grenzmonat und in dessen Nachbarn.
    let valid = 0;
    let invalid = 0;
    for (const fromDay of daysOf("2019-02-01", "2019-03-31"))
      for (const toDay of daysOf("2026-09-28", "2026-11-03")) {
        const range = validateDayRange(fromDay, toDay);
        if (!range.valid) {
          invalid++;
          expect(() => timelineLayout(fromDay, toDay)).toThrow();
          continue;
        }
        valid++;
        const layout = timelineLayout(fromDay, toDay);
        expect([fromDay, toDay, layout.buckets.length <= MAX_BUCKETS]).toEqual([
          fromDay,
          toDay,
          true,
        ]);
      }
    expect(valid).toBeGreaterThan(100);
    expect(invalid).toBeGreaterThan(100);
  });
});

describe("Abschnitte", () => {
  test("Stunden: 24 Abschnitte 0-23 am selben Tag, auch an den Tagen der Zeitumstellung", () => {
    for (const day of ["2026-10-06", "2026-03-29", "2026-10-25"]) {
      const layout = timelineLayout(day, day);
      expect(layout.buckets).toEqual(
        Array.from({ length: 24 }, (_, hour) => ({
          start: day,
          end: day,
          partial: false,
          hour,
        }))
      );
      expect(layout.indexOf({ hour: 0 })).toBe(0);
      expect(layout.indexOf({ hour: 23 })).toBe(23);
      expect(layout.indexOf({ hour: 24 })).toBe(-1);
      expect(layout.indexOf({ hour: -1 })).toBe(-1);
      expect(layout.indexOf({ day })).toBe(-1);
    }
  });

  test("Tage: lückenlos, jeder Tag sein eigener Abschnitt, nie angeschnitten", () => {
    const layout = timelineLayout("2026-02-20", "2026-03-10");
    expect(layout.buckets.map((bucket) => bucket.start)).toEqual(
      daysOf("2026-02-20", "2026-03-10")
    );
    for (const bucket of layout.buckets) {
      expect(bucket.end).toBe(bucket.start);
      expect(bucket.partial).toBe(false);
      expect(bucket).not.toHaveProperty("hour");
    }
    expect(layout.indexOf({ day: "2026-02-20" })).toBe(0);
    expect(layout.indexOf({ day: "2026-03-01" })).toBe(9);
    expect(layout.indexOf({ day: "2026-03-10" })).toBe(18);
    expect(layout.indexOf({ day: "2026-02-19" })).toBe(-1);
    expect(layout.indexOf({ day: "2026-03-11" })).toBe(-1);
    expect(layout.indexOf({ day: "kein Tag" })).toBe(-1);
  });

  test("Wochen: Montag bis Sonntag, erste und letzte Woche enden am Zeitraum", () => {
    // Mittwoch 01.07.2026 bis Montag 12.10.2026 (104 Tage)
    expect(weekday("2026-07-01")).toBe(3);
    expect(weekday("2026-10-12")).toBe(1);
    const layout = timelineLayout("2026-07-01", "2026-10-12");
    expect(layout.granularity).toBe("week");

    expect(layout.buckets[0]).toEqual({
      start: "2026-07-01",
      end: "2026-07-05",
      partial: true,
    });
    expect(layout.buckets[1]).toEqual({
      start: "2026-07-06",
      end: "2026-07-12",
      partial: false,
    });
    expect(layout.buckets.at(-1)).toEqual({
      start: "2026-10-12",
      end: "2026-10-12",
      partial: true,
    });
    for (const bucket of layout.buckets.slice(1, -1)) {
      expect(weekday(bucket.start)).toBe(1);
      expect(weekday(bucket.end)).toBe(7);
      expect(bucket.end).toBe(addDays(bucket.start, 6));
      expect(bucket.partial).toBe(false);
    }
  });

  test("Wochen: Ein Zeitraum aus ganzen Kalenderwochen hat keinen angeschnittenen Abschnitt", () => {
    // Montag 06.07.2026 bis Sonntag 11.10.2026
    const layout = timelineLayout("2026-07-06", "2026-10-11");
    expect(layout.granularity).toBe("week");
    expect(layout.buckets).toHaveLength(14);
    expect(layout.buckets.some((bucket) => bucket.partial)).toBe(false);
  });

  test("Wochen über den Jahreswechsel: Die Woche 29.12.2025-04.01.2026 ist ein Abschnitt", () => {
    const layout = timelineLayout("2025-10-01", "2026-02-28");
    expect(layout.granularity).toBe("week");
    expect(layout.buckets).toContainEqual({
      start: "2025-12-29",
      end: "2026-01-04",
      partial: false,
    });
    expect(layout.indexOf({ day: "2025-12-31" })).toBe(
      layout.indexOf({ day: "2026-01-01" })
    );
  });

  test("Monate: Kalendermonate, erster und letzter enden am Zeitraum, Schaltjahr", () => {
    const layout = timelineLayout("2023-10-09", "2026-10-12");
    expect(layout.granularity).toBe("month");
    expect(layout.buckets[0]).toEqual({
      start: "2023-10-09",
      end: "2023-10-31",
      partial: true,
    });
    expect(layout.buckets[1]).toEqual({
      start: "2023-11-01",
      end: "2023-11-30",
      partial: false,
    });
    expect(layout.buckets).toContainEqual({
      start: "2024-02-01",
      end: "2024-02-29",
      partial: false,
    });
    expect(layout.buckets).toContainEqual({
      start: "2025-02-01",
      end: "2025-02-28",
      partial: false,
    });
    expect(layout.buckets).toContainEqual({
      start: "2025-12-01",
      end: "2025-12-31",
      partial: false,
    });
    expect(layout.buckets.at(-1)).toEqual({
      start: "2026-10-01",
      end: "2026-10-12",
      partial: true,
    });
  });

  test("Jeder Tag des Zeitraums liegt in genau einem Abschnitt - in dem, den indexOf nennt", () => {
    for (const [from, to] of [
      ["2026-09-13", "2026-10-12"], // Tage
      ["2026-07-01", "2026-10-12"], // Wochen
      ["2025-12-20", "2026-12-31"], // Wochen über den Jahreswechsel
      ["2023-10-09", "2026-10-12"], // Monate
    ]) {
      const layout = timelineLayout(from, to);
      const days = daysOf(from, to);
      const covered = layout.buckets.flatMap((bucket) =>
        daysOf(bucket.start, bucket.end)
      );
      expect(covered).toEqual(days);
      for (const day of days) {
        const bucket = layout.buckets[layout.indexOf({ day })];
        expect(bucket.start <= day && day <= bucket.end).toBe(true);
      }
    }
  });

  test("ungültiger Zeitraum wirft, statt Abschnitte zu erfinden", () => {
    expect(() => timelineLayout("2026-10-07", "2026-10-06")).toThrow();
    expect(() => timelineLayout("2026-02-30", "2026-03-05")).toThrow();
    expect(() => timelineLayout("2016-10-12", "2026-10-12")).toThrow();
    expect(() => timelineLayout(undefined, "2026-10-12")).toThrow();
  });
});

describe("nextDay", () => {
  test("über Monats-, Jahres- und Schalttagsgrenzen", () => {
    expect(nextDay("2026-10-06")).toBe("2026-10-07");
    expect(nextDay("2026-10-31")).toBe("2026-11-01");
    expect(nextDay("2026-12-31")).toBe("2027-01-01");
    expect(nextDay("2024-02-28")).toBe("2024-02-29");
    expect(nextDay("2026-02-28")).toBe("2026-03-01");
    // Der Folgetag jedes gültigen Tages bleibt ein vierstelliges Datum.
    expect(nextDay("9998-12-31")).toBe("9999-01-01");
    expect(() => nextDay("2026-02-30")).toThrow();
    expect(() => nextDay("9999-12-31")).toThrow();
  });
});

// ============================================================================
// KIE-537 — Vorzeitraum: gleich viele Kalendertage vor fromDay (Kennzahlen),
// je Säule der Abschnitt an derselben Stelle davor (Linie)
// ============================================================================
describe("previousLayout (KIE-537)", () => {
  /** Tage eines Zeitraums, beide Grenzen einschließlich. */
  const dayCount = (from, to) => daysOf(from, to).length;

  test("Tage: 13.09.-12.10.2026 → 14.08.-12.09.2026, 30 Tagesabschnitte in zeitlicher Reihenfolge", () => {
    const previous = previousLayout("2026-09-13", "2026-10-12");
    expect(previous.granularity).toBe("day");
    expect(previous.fromDay).toBe("2026-08-14");
    expect(previous.toDay).toBe("2026-09-12");
    expect(previous.readFromDay).toBe("2026-08-14");
    expect(previous.buckets).toEqual(
      daysOf("2026-08-14", "2026-09-12").map((day) => ({
        start: day,
        end: day,
        partial: false,
      }))
    );
    expect(previous.buckets).toHaveLength(30);

    // Säule i des Zeitraums und Abschnitt i der Linie liegen 30 Tage auseinander.
    const current = timelineLayout("2026-09-13", "2026-10-12");
    for (const [i, bucket] of current.buckets.entries())
      expect(previous.buckets[i].start).toBe(addDays(bucket.start, -30));
    expect(previous.indexOf({ day: "2026-08-14" })).toBe(0);
    expect(previous.indexOf({ day: "2026-09-12" })).toBe(29);
    expect(previous.indexOf({ day: "2026-08-13" })).toBe(-1);
    expect(previous.indexOf({ day: "2026-09-13" })).toBe(-1);
    expect(previous.inTotals({ day: "2026-08-14" })).toBe(true);
    expect(previous.inTotals({ day: "2026-09-12" })).toBe(true);
    expect(previous.inTotals({ day: "2026-08-13" })).toBe(false);
    expect(previous.inTotals({ day: "2026-09-13" })).toBe(false);
  });

  test("Tage über Monats-, Jahres- und Schalttagsgrenzen: immer gleich viele Tage, lückenlos bis zum Tag davor", () => {
    for (const [from, to] of [
      ["2026-03-01", "2026-03-31"], // davor liegt der Februar mit 28 Tagen
      ["2024-03-01", "2024-03-31"], // Schaltjahr
      ["2026-01-01", "2026-01-02"],
      ["2026-01-01", "2026-04-02"], // 92 Tage
      ["2026-10-25", "2026-10-26"], // Zeitumstellung
    ]) {
      const previous = previousLayout(from, to);
      expect(previous.granularity).toBe("day");
      expect(previous.toDay).toBe(addDays(from, -1));
      expect(dayCount(previous.fromDay, previous.toDay)).toBe(
        dayCount(from, to)
      );
      expect(previous.buckets.map((bucket) => bucket.start)).toEqual(
        daysOf(previous.fromDay, previous.toDay)
      );
    }
    expect(previousLayout("2026-03-01", "2026-03-31").fromDay).toBe(
      "2026-01-29"
    );
    expect(previousLayout("2024-03-01", "2024-03-31").fromDay).toBe(
      "2024-01-30"
    );
  });

  test("Stunden: ein einzelner Tag → die 24 Stunden des Vortags", () => {
    const previous = previousLayout("2026-10-12", "2026-10-12");
    expect(previous.granularity).toBe("hour");
    expect(previous.fromDay).toBe("2026-10-11");
    expect(previous.toDay).toBe("2026-10-11");
    expect(previous.readFromDay).toBe("2026-10-11");
    expect(previous.buckets).toEqual(
      Array.from({ length: 24 }, (_, hour) => ({
        start: "2026-10-11",
        end: "2026-10-11",
        partial: false,
        hour,
      }))
    );
    for (const hour of [0, 13, 23]) {
      expect(previous.indexOf({ hour })).toBe(hour);
      expect(previous.inTotals({ hour })).toBe(true);
    }
    for (const hour of [-1, 24, 1.5, "7", undefined]) {
      expect(previous.indexOf({ hour })).toBe(-1);
      expect(previous.inTotals({ hour })).toBe(false);
    }
    // über den Jahreswechsel
    expect(previousLayout("2026-01-01", "2026-01-01").fromDay).toBe(
      "2025-12-31"
    );
  });

  test("Wochen: 52 ganze Kalenderwochen → die 52 Kalenderwochen unmittelbar davor; Linie und Kennzahlen decken sich", () => {
    // Montag 13.10.2025 bis Sonntag 11.10.2026
    const current = timelineLayout("2025-10-13", "2026-10-11");
    expect(current.granularity).toBe("week");
    expect(current.buckets).toHaveLength(52);

    const previous = previousLayout("2025-10-13", "2026-10-11");
    expect(previous.granularity).toBe("week");
    expect(previous.buckets).toHaveLength(52);
    expect(previous.buckets[0]).toEqual({
      start: "2024-10-14",
      end: "2024-10-20",
      partial: false,
    });
    expect(previous.buckets.at(-1)).toEqual({
      start: "2025-10-06",
      end: "2025-10-12",
      partial: false,
    });
    expect(previous.fromDay).toBe("2024-10-14");
    expect(previous.toDay).toBe("2025-10-12");
    expect(previous.readFromDay).toBe("2024-10-14");
  });

  test("Wochen, erste Säule angeschnitten: ganze Kalenderwochen vor der Woche der ersten Säule - die Kennzahlen zählen andere Tage", () => {
    // Mittwoch 15.10.2025 bis Montag 12.10.2026: 363 Tage, 53 berührte Wochen
    const current = timelineLayout("2025-10-15", "2026-10-12");
    expect(current.granularity).toBe("week");
    expect(current.buckets).toHaveLength(53);
    expect(current.buckets[0]).toEqual({
      start: "2025-10-15",
      end: "2025-10-19",
      partial: true,
    });

    const previous = previousLayout("2025-10-15", "2026-10-12");
    expect(previous.buckets).toHaveLength(53);
    for (const bucket of previous.buckets) {
      expect(weekday(bucket.start)).toBe(1);
      expect(bucket.end).toBe(addDays(bucket.start, 6));
      expect(bucket.partial).toBe(false);
    }
    // Die Linie endet am Sonntag vor der Kalenderwoche der ersten Säule …
    expect(previous.buckets.at(-1).end).toBe("2025-10-12");
    expect(previous.buckets[0].start).toBe("2024-10-07");
    // … die Kennzahlen am Tag vor dem Zeitraum, 363 Tage lang.
    expect(previous.toDay).toBe("2025-10-14");
    expect(previous.fromDay).toBe("2024-10-17");
    expect(dayCount(previous.fromDay, previous.toDay)).toBe(363);
    expect(previous.readFromDay).toBe("2024-10-07");

    // Montag und Dienstag vor dem Zeitraum: Kennzahlen ja, Linie nein.
    expect(previous.inTotals({ day: "2025-10-13" })).toBe(true);
    expect(previous.indexOf({ day: "2025-10-13" })).toBe(-1);
    // Die ersten Tage der Linie: Linie ja, Kennzahlen nein.
    expect(previous.indexOf({ day: "2024-10-07" })).toBe(0);
    expect(previous.inTotals({ day: "2024-10-16" })).toBe(false);
    expect(previous.indexOf({ day: "2024-10-16" })).toBe(1);
    expect(previous.inTotals({ day: "2024-10-17" })).toBe(true);
  });

  test("Monate: 24 Monatssäulen → die 24 ganzen Monate unmittelbar davor; die Kennzahlen zählen gleich viele Tage", () => {
    const current = timelineLayout("2024-11-01", "2026-10-31");
    expect(current.granularity).toBe("month");
    expect(current.buckets).toHaveLength(24);

    const previous = previousLayout("2024-11-01", "2026-10-31");
    expect(previous.granularity).toBe("month");
    expect(previous.buckets).toHaveLength(24);
    expect(previous.buckets[0]).toEqual({
      start: "2022-11-01",
      end: "2022-11-30",
      partial: false,
    });
    expect(previous.buckets).toContainEqual({
      start: "2024-02-01",
      end: "2024-02-29",
      partial: false,
    });
    expect(previous.buckets.at(-1)).toEqual({
      start: "2024-10-01",
      end: "2024-10-31",
      partial: false,
    });
    // 730 Tage im Zeitraum, 731 in den 24 Monaten davor (29.02.2024).
    expect(dayCount("2024-11-01", "2026-10-31")).toBe(730);
    expect(previous.fromDay).toBe("2022-11-02");
    expect(previous.toDay).toBe("2024-10-31");
    expect(previous.readFromDay).toBe("2022-11-01");
    expect(previous.indexOf({ day: "2022-11-01" })).toBe(0);
    expect(previous.inTotals({ day: "2022-11-01" })).toBe(false);
  });

  test("Monate, der Zeitraum hat mehr Tage als die 24 Monate davor: Die Kennzahlen beginnen vor der Linie - gelesen wird ab ihrem ersten Tag", () => {
    // 731 Tage im Zeitraum (29.02.2024), 730 in den 24 Monaten davor.
    const current = timelineLayout("2023-11-01", "2025-10-31");
    expect(current.granularity).toBe("month");
    expect(current.buckets).toHaveLength(24);
    expect(dayCount("2023-11-01", "2025-10-31")).toBe(731);
    expect(dayCount("2021-11-01", "2023-10-31")).toBe(730);

    const previous = previousLayout("2023-11-01", "2025-10-31");
    expect(previous.granularity).toBe("month");
    expect(previous.buckets).toHaveLength(24);
    expect(previous.buckets[0]).toEqual({
      start: "2021-11-01",
      end: "2021-11-30",
      partial: false,
    });
    expect(previous.buckets.at(-1)).toEqual({
      start: "2023-10-01",
      end: "2023-10-31",
      partial: false,
    });
    expect(previous.fromDay).toBe("2021-10-31");
    expect(previous.toDay).toBe("2023-10-31");
    expect(dayCount(previous.fromDay, previous.toDay)).toBe(731);
    // Der frühere der beiden Bereiche: hier die Kennzahlen, nicht die Linie.
    expect(previous.readFromDay).toBe("2021-10-31");
    // Der 31.10.2021: Kennzahlen ja, Linie nein.
    expect(previous.inTotals({ day: "2021-10-31" })).toBe(true);
    expect(previous.indexOf({ day: "2021-10-31" })).toBe(-1);
    expect(previous.inTotals({ day: "2021-10-30" })).toBe(false);
    expect(previous.indexOf({ day: "2021-10-30" })).toBe(-1);
    expect(previous.inTotals({ day: "2021-11-01" })).toBe(true);
    expect(previous.indexOf({ day: "2021-11-01" })).toBe(0);
  });

  test("Monate, erste Säule angeschnitten: ganze Monate vor dem Monat der ersten Säule", () => {
    const current = timelineLayout("2023-10-09", "2026-10-12");
    expect(current.buckets).toHaveLength(37);
    const previous = previousLayout("2023-10-09", "2026-10-12");
    expect(previous.buckets).toHaveLength(37);
    expect(previous.buckets[0]).toEqual({
      start: "2020-09-01",
      end: "2020-09-30",
      partial: false,
    });
    expect(previous.buckets.at(-1)).toEqual({
      start: "2023-09-01",
      end: "2023-09-30",
      partial: false,
    });
    expect(previous.toDay).toBe("2023-10-08");
    expect(dayCount(previous.fromDay, previous.toDay)).toBe(
      dayCount("2023-10-09", "2026-10-12")
    );
    // Die Tage 01.10.-08.10.2023 zählen zu den Kennzahlen, nicht zur Linie.
    expect(previous.inTotals({ day: "2023-10-01" })).toBe(true);
    expect(previous.indexOf({ day: "2023-10-01" })).toBe(-1);
  });

  test("Jede Körnung: so viele Abschnitte wie der Zeitraum, lückenlos, bis unmittelbar vor die erste Säule - jeder Tag in dem Abschnitt, den indexOf nennt", () => {
    for (const [from, to] of [
      ["2026-09-13", "2026-10-12"], // Tage
      ["2026-07-01", "2026-10-12"], // Wochen
      ["2025-12-20", "2026-12-31"], // Wochen über den Jahreswechsel
      ["2025-01-01", "2026-10-04"], // 92 Wochen
      ["2023-10-09", "2026-10-12"], // Monate
      ["2024-03-31", "2026-03-01"], // Monate, beide Ränder angeschnitten
      ["2024-11-01", "2026-10-31"], // Monate, die Linie beginnt einen Tag früher
      ["2023-11-01", "2025-10-31"], // Monate, die Kennzahlen beginnen einen Tag früher
    ]) {
      const current = timelineLayout(from, to);
      const previous = previousLayout(from, to);
      expect(previous.granularity).toBe(current.granularity);
      expect(previous.buckets).toHaveLength(current.buckets.length);
      expect(previous.buckets.length).toBeLessThanOrEqual(MAX_BUCKETS);

      const first = previous.buckets[0].start;
      const last = previous.buckets.at(-1).end;
      expect(
        previous.buckets.flatMap((bucket) => daysOf(bucket.start, bucket.end))
      ).toEqual(daysOf(first, last));
      for (const day of daysOf(first, last)) {
        const bucket = previous.buckets[previous.indexOf({ day })];
        expect(bucket.start <= day && day <= bucket.end).toBe(true);
      }
      expect(previous.indexOf({ day: addDays(first, -1) })).toBe(-1);
      expect(previous.indexOf({ day: addDays(last, 1) })).toBe(-1);
      // Die Linie endet vor dem Zeitraum; gelesen wird nie ein Tag des Zeitraums.
      expect(last < from).toBe(true);
      expect(previous.toDay).toBe(addDays(from, -1));
      expect(previous.readFromDay).toBe(
        first < previous.fromDay ? first : previous.fromDay
      );
      // Der Tag davor gehört zu keinem der beiden Bereiche.
      const before = addDays(previous.readFromDay, -1);
      expect(previous.indexOf({ day: before })).toBe(-1);
      expect(previous.inTotals({ day: before })).toBe(false);
      // Kennzahlen: genau die Tage fromDay bis toDay.
      for (const day of daysOf(previous.readFromDay, addDays(from, 3)))
        expect([day, previous.inTotals({ day })]).toEqual([
          day,
          previous.fromDay <= day && day <= previous.toDay,
        ]);
    }
  });

  test("Der längste Zeitraum (92 Kalendermonate): 92 Monate davor - für den Vorzeitraum gilt die Prüfung des Zeitraums nicht", () => {
    const previous = previousLayout("2019-03-01", "2026-10-12");
    expect(previous.granularity).toBe("month");
    expect(previous.buckets).toHaveLength(MAX_BUCKETS);
    expect(previous.buckets[0].start).toBe("2011-07-01");
    expect(previous.buckets.at(-1).end).toBe("2019-02-28");
    expect(previous.toDay).toBe("2019-02-28");
    expect(dayCount(previous.fromDay, previous.toDay)).toBe(
      dayCount("2019-03-01", "2026-10-12")
    );
    // Beide Bereiche zusammen berühren mehr als 92 Kalendermonate.
    expect(validateDayRange(previous.readFromDay, previous.toDay).valid).toBe(
      true
    );
    expect(validateDayRange("2011-07-01", "2019-03-14").valid).toBe(false);
    const cut = previousLayout("2019-03-15", "2026-10-12");
    expect(cut.buckets).toHaveLength(MAX_BUCKETS);
    expect(cut.buckets[0].start).toBe("2011-07-01");
    expect(cut.toDay).toBe("2019-03-14");
  });

  test("Vor dem 01.01.0001 gibt es keinen Kalendertag: kein Vorzeitraum (null) statt eines erfundenen Tages", () => {
    expect(previousLayout("0001-01-01", "0001-01-01")).toBeNull();
    expect(previousLayout("0001-01-05", "0001-02-01")).toBeNull();
    expect(previousLayout("0001-06-01", "0002-06-01")).toBeNull();
    expect(previousLayout("0003-01-01", "0008-01-01")).toBeNull();
    // Der früheste Vorzeitraum beginnt am 01.01.0001.
    const earliest = previousLayout("0001-01-02", "0001-01-02");
    expect(earliest.fromDay).toBe("0001-01-01");
    expect(earliest.buckets).toHaveLength(24);
    const days = previousLayout("0001-01-11", "0001-01-20");
    expect(days.fromDay).toBe("0001-01-01");
    expect(days.buckets[0].start).toBe("0001-01-01");
    expect(previousLayout("0001-01-10", "0001-01-19")).toBeNull();
  });

  test("ungültiger Zeitraum wirft wie timelineLayout", () => {
    expect(() => previousLayout("2026-10-07", "2026-10-06")).toThrow(
      /timelineLayout/
    );
    expect(() => previousLayout("2026-02-30", "2026-03-05")).toThrow();
    expect(() => previousLayout("2019-02-28", "2026-10-12")).toThrow();
    expect(() => previousLayout(undefined, undefined)).toThrow();
  });
});
