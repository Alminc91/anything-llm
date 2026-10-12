/**
 * Zeitabschnitte der Auswertung „Konversationen" (KIE-536)
 *
 * Die EINE Stelle, die aus einem Zeitraum die Säulen des Diagramms bildet.
 * Gerechnet wird nur mit Kalendertagen ("YYYY-MM-DD", beide Grenzen
 * einschließlich) - so, wie das Zählerbuch sie führt (Berliner Kalendertag).
 * Hier gibt es keine Zeitpunkte und keine Zeitzone: Ein Tag ist eine laufende
 * Nummer, die Zeitzone des Prozesses spielt keine Rolle.
 *
 * Regeln:
 * - Ein einzelner Tag: 24 Stunden-Abschnitte (0-23, Berliner Stunde).
 * - Sonst die feinste Körnung aus Tag, Kalenderwoche (Montag-Sonntag) und
 *   Monat, die höchstens MAX_BUCKETS Abschnitte ergibt. Gezählt werden die
 *   Abschnitte, die der Zeitraum berührt: 644 Tage ab einem Montag sind 92
 *   Kalenderwochen, 644 Tage ab einem Mittwoch berühren 93 und fallen auf
 *   Monate.
 * - Der Monat ist die gröbste Körnung. Ein Zeitraum, der mehr als
 *   MAX_BUCKETS Kalendermonate berührt, ist deshalb ungültig
 *   (validateDayRange): Kein Diagramm hat mehr als MAX_BUCKETS Säulen.
 * - Erster und letzter Abschnitt enden am Zeitraum, nicht am Kalender: Umfasst
 *   der Zeitraum die Kalenderwoche bzw. den Monat nur teilweise, ist der
 *   Abschnitt „angeschnitten" (partial).
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MAX_BUCKETS = 92;

/**
 * @typedef {Object} TimelineBucket
 * @property {string} start - erster Tag des Abschnitts "YYYY-MM-DD" (im Zeitraum)
 * @property {string} end - letzter Tag des Abschnitts "YYYY-MM-DD" (im Zeitraum)
 * @property {boolean} partial - angeschnitten: Woche bzw. Monat nur teilweise im Zeitraum
 * @property {number} [hour] - nur bei Stunden: Berliner Stunde 0-23
 */

/**
 * @typedef {Object} TimelineLayout
 * @property {"hour"|"day"|"week"|"month"} granularity
 * @property {TimelineBucket[]} buckets
 * @property {(cell: {day?: string, hour?: number}) => number} indexOf - Abschnitt einer Zählerbuch-Zeile, -1 außerhalb
 */

/** Laufende Tagesnummer (Tage seit 1970-01-01) eines Kalendertags. */
function serialOf(year, month, day) {
  // Date.UTC bildet die Jahre 0-99 auf 1900-1999 ab, deshalb setUTCFullYear.
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  return Math.round(date.getTime() / MS_PER_DAY);
}

/**
 * @param {number} serial
 * @returns {{year: number, month: number, day: number}}
 */
function fieldsOf(serial) {
  const date = new Date(serial * MS_PER_DAY);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

/**
 * @param {number} serial
 * @returns {string} - "YYYY-MM-DD"
 */
function dayOf(serial) {
  const { year, month, day } = fieldsOf(serial);
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * Liest einen Kalendertag. Angenommen wird nur die Schreibweise "YYYY-MM-DD"
 * eines Tages, den es gibt (kein 30.02., kein 13. Monat), in den Jahren 0001
 * bis 9998: So bleibt auch der Folgetag (nextDay) ein Tag in dieser
 * Schreibweise.
 * @param {*} value
 * @returns {number|null} - laufende Tagesnummer oder null
 */
function parseCalendarDay(value) {
  if (typeof value !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  if (year < 1 || year > 9998) return null;
  const serial = serialOf(year, Number(match[2]), Number(match[3]));
  return dayOf(serial) === value ? serial : null;
}

/** Montag der Kalenderwoche eines Tages (1970-01-01 war ein Donnerstag). */
function weekStartOf(serial) {
  return serial - ((((serial + 3) % 7) + 7) % 7);
}

/** Laufende Monatsnummer eines Tages. */
function monthIndexOf(serial) {
  const { year, month } = fieldsOf(serial);
  return year * 12 + (month - 1);
}

/**
 * Prüft einen Zeitraum aus zwei Kalendertagen.
 * Ungültig: ein Wert, der kein Kalendertag ist; fromDay nach toDay; ein
 * Zeitraum, der mehr als MAX_BUCKETS Kalendermonate berührt - für ihn gäbe es
 * keine Körnung mit höchstens MAX_BUCKETS Abschnitten (01.03.2019-12.10.2026
 * berühren 92 Monate und gelten, 28.02.2019-12.10.2026 berühren 93). Der
 * längste Zeitraum hat damit keine 7 Jahre und 8 Monate; mehr als 10 Jahre
 * sind immer ungültig.
 * @param {*} fromDay
 * @param {*} toDay
 * @returns {{valid: true, from: number, to: number}|{valid: false, error: string}}
 */
function validateDayRange(fromDay, toDay) {
  const from = parseCalendarDay(fromDay);
  const to = parseCalendarDay(toDay);
  if (from === null || to === null)
    return {
      valid: false,
      error: "fromDay and toDay must be calendar days (YYYY-MM-DD).",
    };
  if (from > to)
    return { valid: false, error: "fromDay must not be after toDay." };

  if (monthIndexOf(to) - monthIndexOf(from) + 1 > MAX_BUCKETS)
    return {
      valid: false,
      error: `The period must not span more than ${MAX_BUCKETS} calendar months.`,
    };
  return { valid: true, from, to };
}

/**
 * Bildet die Abschnitte eines Zeitraums.
 * @param {string} fromDay - "YYYY-MM-DD", einschließlich
 * @param {string} toDay - "YYYY-MM-DD", einschließlich
 * @returns {TimelineLayout}
 * @throws {Error} - bei einem ungültigen Zeitraum (siehe validateDayRange)
 */
function timelineLayout(fromDay, toDay) {
  const range = validateDayRange(fromDay, toDay);
  if (!range.valid) throw new Error(`timelineLayout: ${range.error}`);
  const { from, to } = range;

  if (from === to) {
    const day = dayOf(from);
    return {
      granularity: "hour",
      buckets: Array.from({ length: 24 }, (_, hour) => ({
        start: day,
        end: day,
        partial: false,
        hour,
      })),
      indexOf: (cell) =>
        Number.isInteger(cell.hour) && cell.hour >= 0 && cell.hour <= 23
          ? cell.hour
          : -1,
    };
  }

  const inRange = (serial, index) =>
    serial === null || serial < from || serial > to ? -1 : index(serial);

  if (to - from + 1 <= MAX_BUCKETS)
    return {
      granularity: "day",
      buckets: Array.from({ length: to - from + 1 }, (_, i) => ({
        start: dayOf(from + i),
        end: dayOf(from + i),
        partial: false,
      })),
      indexOf: (cell) =>
        inRange(parseCalendarDay(cell.day), (serial) => serial - from),
    };

  const firstWeek = weekStartOf(from);
  const weeks = (weekStartOf(to) - firstWeek) / 7 + 1;
  if (weeks <= MAX_BUCKETS)
    return {
      granularity: "week",
      buckets: Array.from({ length: weeks }, (_, i) => {
        const monday = firstWeek + i * 7;
        const start = Math.max(monday, from);
        const end = Math.min(monday + 6, to);
        return {
          start: dayOf(start),
          end: dayOf(end),
          partial: start !== monday || end !== monday + 6,
        };
      }),
      indexOf: (cell) =>
        inRange(
          parseCalendarDay(cell.day),
          (serial) => (weekStartOf(serial) - firstWeek) / 7
        ),
    };

  // Höchstens MAX_BUCKETS Monate: Mehr lässt validateDayRange nicht zu.
  const firstMonth = monthIndexOf(from);
  const months = monthIndexOf(to) - firstMonth + 1;
  return {
    granularity: "month",
    buckets: Array.from({ length: months }, (_, i) => {
      const year = Math.floor((firstMonth + i) / 12);
      const month = firstMonth + i - year * 12 + 1;
      const first = serialOf(year, month, 1);
      const last = serialOf(year, month + 1, 0);
      const start = Math.max(first, from);
      const end = Math.min(last, to);
      return {
        start: dayOf(start),
        end: dayOf(end),
        partial: start !== first || end !== last,
      };
    }),
    indexOf: (cell) =>
      inRange(
        parseCalendarDay(cell.day),
        (serial) => monthIndexOf(serial) - firstMonth
      ),
  };
}

/**
 * Der Kalendertag nach einem Kalendertag.
 * @param {string} day - "YYYY-MM-DD"
 * @returns {string}
 */
function nextDay(day) {
  const serial = parseCalendarDay(day);
  if (serial === null) throw new Error(`nextDay: invalid calendar day ${day}`);
  return dayOf(serial + 1);
}

module.exports = {
  MAX_BUCKETS,
  parseCalendarDay,
  validateDayRange,
  timelineLayout,
  nextDay,
};
