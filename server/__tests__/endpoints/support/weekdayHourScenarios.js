/* eslint-env node */
// Bestände für die Karte „Wann schreiben Ihre Besucher?" (KIE-539): welche
// Nachrichten es gibt und was die Karte dazu sagen muss. Beide Seiten prüfen
// gegen diese eine Stelle -
//   server/__tests__/endpoints/embedAnalyticsSummary.test.js: Die echte Route
//     liefert zu diesen Nachrichten genau dieses Raster (weekdayHour).
//   frontend/__tests__/weekdayHour*.test.mjs: Aus genau diesem Raster
//     entstehen die Aussagen, die Stufen und die Tooltips der Karte.
// Der Wochentag ist hier unabhängig vom geprüften Code gerechnet.

/** Kalendertag + n Tage. */
function addDays(day, n) {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + n);
  return date.toISOString().slice(0, 10);
}

/** Wochentag eines Kalendertags, 0 = Montag … 6 = Sonntag. */
function weekdayOf(day) {
  return (new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7;
}

/**
 * Das Raster, das zu Zählwerten gehört: 7 Zeilen (Montag bis Sonntag) mit je
 * 24 Stunden.
 * @param {Array<{day: string, hour: number, messages: number}>} cells
 * @returns {number[][]}
 */
function gridOf(cells) {
  const grid = Array.from({ length: 7 }, () => new Array(24).fill(0));
  for (const { day, hour, messages } of cells)
    grid[weekdayOf(day)][hour] += messages;
  return grid;
}

const totalOf = (cells) =>
  cells.reduce((total, cell) => total + cell.messages, 0);

// „Letzte 30 Tage" am 12.10.2026: Sonntag, 13.09., bis Montag, 12.10.2026.
const PERIOD = { fromDay: "2026-09-13", toDay: "2026-10-12" };

/**
 * AK-1, AK-3, AK-5: 252 Nachrichten in 30 Tagen. Geschrieben wird täglich
 * zwischen 8 und 20 Uhr, in je zwei von drei Stunden eine Nachricht; nachts
 * nie. Der Höchstwert liegt dienstags zwischen 10 und 11 Uhr: 14 Nachrichten.
 */
const DISTRIBUTION = (() => {
  const cells = [];
  for (let i = 0; i < 30; i++) {
    const day = addDays(PERIOD.fromDay, i);
    for (let hour = 8; hour <= 19; hour++)
      if ((i + hour) % 3 !== 0) cells.push({ day, hour, messages: 1 });
  }
  // Dienstag, 06.10.2026, 10–11 Uhr: zusammen mit den zwei Nachrichten oben 14.
  cells.push({ day: "2026-10-06", hour: 10, messages: 12 });
  return {
    ...PERIOD,
    cells,
    total: 252,
    peak: { weekday: 1, hour: 10, messages: 14 },
  };
})();

/**
 * AK-4: 100 Nachrichten in der Woche vom 05.10. bis 11.10.2026, davon 60
 * Montag bis Freitag zwischen 8:00 und 16:59 Uhr. minute nennt die Uhrzeit
 * einer Nachricht an der Grenze der Kernzeit.
 */
const CORE_TIME_WEEK = {
  ...PERIOD,
  cells: [
    // innerhalb: 60
    { day: "2026-10-05", hour: 8, messages: 10, minute: 0 }, // Mo 08:00
    { day: "2026-10-06", hour: 10, messages: 14 }, // Di
    { day: "2026-10-07", hour: 12, messages: 12 }, // Mi
    { day: "2026-10-08", hour: 14, messages: 12 }, // Do
    { day: "2026-10-09", hour: 16, messages: 12, minute: 59 }, // Fr 16:59
    // außerhalb: 40
    { day: "2026-10-05", hour: 7, messages: 5, minute: 59 }, // Mo 07:59
    { day: "2026-10-05", hour: 17, messages: 5, minute: 0 }, // Mo 17:00
    { day: "2026-10-09", hour: 17, messages: 4, minute: 0 }, // Fr 17:00
    { day: "2026-10-10", hour: 10, messages: 10 }, // Sa, mitten am Tag
    { day: "2026-10-11", hour: 12, messages: 8 }, // So
    { day: "2026-10-07", hour: 0, messages: 3, minute: 0 }, // Mi 00:00
    { day: "2026-10-08", hour: 23, messages: 5, minute: 59 }, // Do 23:59
  ],
  total: 100,
  insideCore: 60,
  outsidePercent: 40,
  peak: { weekday: 1, hour: 10, messages: 14 },
};

/**
 * AK-6: die Tage der Zeitumstellung 2026 als Zeitpunkte. Am 29.03. gibt es
 * die Berliner Stunde 2 nicht, am 25.10. gibt es sie zweimal. Beide Tage sind
 * Sonntage.
 */
const DST = {
  spring: {
    day: "2026-03-29",
    instants: ["2026-03-29T00:30:00Z", "2026-03-29T01:30:00Z"], // 01:30, 03:30
    weekday: 6,
    hours: [1, 3],
  },
  autumn: {
    day: "2026-10-25",
    instants: ["2026-10-25T00:30:00Z", "2026-10-25T01:30:00Z"], // 02:30, 02:30
    weekday: 6,
    hours: [2, 2],
  },
};

module.exports = {
  PERIOD,
  DISTRIBUTION,
  CORE_TIME_WEEK,
  DST,
  addDays,
  weekdayOf,
  gridOf,
  totalOf,
};
