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
  test("gültig: ein Tag, mehrere Tage, genau 10 Jahre", () => {
    expect(validateDayRange("2026-10-06", "2026-10-06").valid).toBe(true);
    expect(validateDayRange("2026-09-13", "2026-10-12").valid).toBe(true);
    // 13.10.2016 bis 12.10.2026 sind genau 10 Jahre.
    expect(validateDayRange("2016-10-13", "2026-10-12").valid).toBe(true);
    expect(validateDayRange("2016-02-29", "2026-02-28").valid).toBe(true);
  });

  test("ungültig: fromDay nach toDay", () => {
    expect(validateDayRange("2026-10-07", "2026-10-06")).toEqual({
      valid: false,
      error: expect.any(String),
    });
    expect(validateDayRange("2027-01-01", "2026-12-31").valid).toBe(false);
  });

  test("ungültig: mehr als 10 Jahre", () => {
    expect(validateDayRange("2016-10-12", "2026-10-12").valid).toBe(false);
    expect(validateDayRange("2016-02-29", "2026-03-01").valid).toBe(false);
    expect(validateDayRange("1990-01-01", "2026-10-12").valid).toBe(false);
    expect(validateDayRange("0001-01-01", "9999-12-31").valid).toBe(false);
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

  test("koernung: höchstens 92 Abschnitte für jeden Zeitraum bis 92 Monate, an jedem Wochentag begonnen", () => {
    const seen = new Set();
    for (const start of daysOf("2025-01-06", "2025-01-12"))
      for (const days of [
        1, 2, 3, 7, 30, 31, 91, 92, 93, 94, 100, 364, 365, 366, 637, 638, 639,
        643, 644, 645, 646, 700, 1100, 2000, 2780,
      ]) {
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

  test("koernung: Der Monat ist die gröbste Körnung - 10 Jahre ergeben bis zu 121 Abschnitte", () => {
    expect(timelineLayout("2016-11-01", "2026-10-31").buckets).toHaveLength(
      120
    );
    const layout = timelineLayout("2016-10-13", "2026-10-12");
    expect(layout.granularity).toBe("month");
    expect(layout.buckets).toHaveLength(121);
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
    expect(() => nextDay("2026-02-30")).toThrow();
  });
});
