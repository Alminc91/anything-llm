/**
 * Billing Window - Enterprise Billing Feature (KIE-531)
 *
 * Die EINE Stelle, die das Abrechnungsfenster eines Workspaces bestimmt.
 * Server, API und Abrechnungsansicht leiten ihre Grenzen hieraus ab.
 *
 * Regeln:
 * - Fenster = halboffenes Intervall [Start 00:00 Berliner Zeit, nächster Start
 *   00:00 Berliner Zeit). Gerechnet wird ausdrücklich in Europe/Berlin, nie in
 *   der Zeitzone des Prozesses.
 * - Starttag = Berliner Kalendertag von cycleStartDate. Der k-te Zyklusstart
 *   ist Originalstart + k × Dauer (in Monaten), geklemmt auf den letzten Tag
 *   des Zielmonats. Es wird nie auf einem bereits geklemmten Datum
 *   weitergerechnet, der Reset-Tag wandert also nicht.
 * - Ohne cycleStartDate und solange cycleStartDate in der Zukunft liegt, gilt
 *   der Berliner Kalendermonat.
 * - Die Zyklusnummer wird aus dem Monatsabstand berechnet, nicht hochgezählt.
 *
 * Kalendertage werden als "YYYY-MM-DD" (Berliner Kalender) geführt; echte
 * Zeitpunkte als Date. Für API-Felder gibt es zusätzlich "Tagesmarken": ein
 * Date auf 00:00 UTC des jeweiligen Berliner Kalendertags, dessen ISO-Datum
 * unabhängig von der Zeitzone des Lesers den richtigen Tag nennt.
 */

const BILLING_TIME_ZONE = "Europe/Berlin";
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Einmal anlegen: Der Aufbau eines Intl-Formatters ist um Größenordnungen
// teurer als seine Benutzung, und das Fenster wird bei jeder Anfrage bestimmt.
const berlinFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: BILLING_TIME_ZONE,
  hourCycle: "h23",
  era: "short",
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  second: "numeric",
});

/**
 * @typedef {Object} CalendarDay
 * @property {number} year - Astronomisches Jahr (1 v. Chr. = 0)
 * @property {number} month - 1-12
 * @property {number} day - 1-31
 */

/**
 * Epoch-Millisekunden von 00:00 UTC eines Kalendertags (plus Uhrzeit).
 * Date.UTC bildet die Jahre 0-99 auf 1900-1999 ab, deshalb setUTCFullYear.
 * @returns {number}
 */
function utcMs(year, month, day, hour = 0, minute = 0, second = 0) {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  return date.getTime();
}

/**
 * Wanduhr-Felder eines Zeitpunkts in Berliner Zeit.
 * @param {Date} instant
 */
function berlinFields(instant) {
  const fields = {};
  for (const { type, value } of berlinFormatter.formatToParts(instant))
    fields[type] = value;
  const year = Number(fields.year);
  return {
    year: fields.era === "BC" ? 1 - year : year,
    month: Number(fields.month),
    day: Number(fields.day),
    hour: Number(fields.hour),
    minute: Number(fields.minute),
    second: Number(fields.second),
  };
}

/**
 * @param {Date|string|number|null|undefined} value
 * @returns {Date|null} - Gültiges Date oder null
 */
function toValidDate(value) {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? value : new Date(value);
  return isNaN(date.getTime()) ? null : date;
}

/**
 * @param {CalendarDay} day
 * @returns {string} - "YYYY-MM-DD" (außerhalb 0-9999 mit Vorzeichen und sechsstelligem Jahr)
 */
function formatDay({ year, month, day }) {
  const yyyy =
    year >= 0 && year <= 9999
      ? String(year).padStart(4, "0")
      : `${year < 0 ? "-" : "+"}${String(Math.abs(year)).padStart(6, "0")}`;
  return `${yyyy}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * @param {string} day - "YYYY-MM-DD"
 * @returns {CalendarDay}
 */
function parseDay(day) {
  const match = /^([+-]\d{6}|\d{4})-(\d{2})-(\d{2})$/.exec(String(day));
  if (!match) throw new Error(`Invalid calendar day: ${day}`);
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  };
}

/** @returns {number} - <0, 0, >0 wie a - b */
function compareDays(a, b) {
  return a.year - b.year || a.month - b.month || a.day - b.day;
}

function daysInMonth(year, month) {
  return new Date(utcMs(year, month + 1, 0)).getUTCDate();
}

/**
 * Kalendertag + Monate, geklemmt auf den letzten Tag des Zielmonats.
 * Immer vom Ausgangstag aus rechnen, nie auf dem Ergebnis weiterrechnen:
 * 31.01. + 1 = 28.02., 31.01. + 2 = 31.03. (nicht 28.03.).
 * @param {CalendarDay} origin
 * @param {number} months
 * @returns {CalendarDay}
 */
function addMonthsClamped(origin, months) {
  const monthIndex = origin.year * 12 + (origin.month - 1) + months;
  const year = Math.floor(monthIndex / 12);
  const month = monthIndex - year * 12 + 1;
  return { year, month, day: Math.min(origin.day, daysInMonth(year, month)) };
}

function berlinCalendarDay(instant) {
  const { year, month, day } = berlinFields(instant);
  return { year, month, day };
}

/**
 * Zeitpunkt von 00:00 Uhr Berliner Zeit an einem Kalendertag.
 * Mitternacht existiert in Berlin immer genau einmal (die Umstellung liegt
 * bei 02:00/03:00 Uhr), der zweite Durchlauf fängt nur den Fall ab, dass der
 * Versatz am Schätzwert ein anderer ist als am Ergebnis.
 * @param {CalendarDay} day
 * @returns {Date}
 */
function berlinMidnightOf(day) {
  const wallClock = utcMs(day.year, day.month, day.day);
  const offsetAt = (ms) => {
    const f = berlinFields(new Date(ms));
    return (
      utcMs(f.year, f.month, f.day, f.hour, f.minute, f.second) -
      Math.floor(ms / 1000) * 1000
    );
  };
  const guess = wallClock - offsetAt(wallClock);
  return new Date(wallClock - offsetAt(guess));
}

/**
 * Tagesmarke: 00:00 UTC des Kalendertags (für API-Felder und Anzeige).
 * @param {CalendarDay} day
 * @returns {Date}
 */
function dayMarker(day) {
  return new Date(utcMs(day.year, day.month, day.day));
}

/**
 * Berliner Kalendertag eines Zeitpunkts.
 * @param {Date|string|number} instant
 * @returns {string} - "YYYY-MM-DD"
 */
function berlinDayOf(instant) {
  const date = toValidDate(instant);
  if (!date) throw new Error("berlinDayOf: invalid date");
  return formatDay(berlinCalendarDay(date));
}

/**
 * Zeitpunkt von 00:00 Uhr Berliner Zeit an einem Kalendertag.
 * @param {string} day - "YYYY-MM-DD"
 * @returns {Date}
 */
function berlinMidnight(day) {
  return berlinMidnightOf(parseDay(day));
}

/**
 * Dauer eines Zyklus in Monaten; alles Unbrauchbare fällt wie bisher auf 1.
 * @param {*} value
 * @returns {number}
 */
function normalizeCycleDuration(value) {
  const months = Number(value);
  return Number.isInteger(months) && months > 0 ? months : 1;
}

/**
 * Starttag des k-ten Zyklus (k = 0 ist der Originalstart).
 * @param {string} startDay - Originalstart "YYYY-MM-DD"
 * @param {number} durationMonths
 * @param {number} index - k
 * @returns {string} - "YYYY-MM-DD"
 */
function cycleStartDay(startDay, durationMonths, index) {
  return formatDay(
    addMonthsClamped(
      parseDay(startDay),
      index * normalizeCycleDuration(durationMonths)
    )
  );
}

/**
 * @typedef {Object} BillingWindow
 * @property {Date} start - Zeitpunkt des Fensterbeginns (00:00 Berliner Zeit, inklusiv)
 * @property {Date} endExclusive - Zeitpunkt des nächsten Fensterbeginns (00:00 Berliner Zeit, exklusiv)
 * @property {string} startDay - Berliner Kalendertag des Beginns "YYYY-MM-DD"
 * @property {string} endDayExclusive - Berliner Kalendertag des nächsten Beginns "YYYY-MM-DD"
 * @property {number} cycleNumber - 1, 2, 3 … im Zyklus; 0 solange der Kalendermonat gilt
 * @property {Date} nextReset - Tagesmarke (00:00 UTC) des nächsten Fensterbeginns
 * @property {number} daysRemaining - Kalendertage von heute (Berlin) bis zum nächsten Fensterbeginn, mindestens 1
 */

/**
 * Bestimmt das Abrechnungsfenster eines Workspaces zu einem Zeitpunkt.
 *
 * Mit cycleStartDate, das erreicht ist: der laufende Zyklus. Ohne
 * cycleStartDate oder vor dem Starttag: der Berliner Kalendermonat. Beginnt
 * der erste Zyklus noch im laufenden Monat, endet das Monatsfenster am
 * Starttag, damit sich die Fenster nicht überschneiden und der genannte
 * Reset stimmt (der erste Zyklus startet bei 0).
 *
 * @param {{cycleStartDate?: Date|string|null, cycleDurationMonths?: number|null}} workspace
 * @param {Date|string|number} [now] - Bezugszeitpunkt, Standard: jetzt
 * @returns {BillingWindow}
 */
function getBillingWindow(workspace, now = new Date()) {
  const today = berlinCalendarDay(toValidDate(now) ?? new Date());
  const cycleStart = toValidDate(workspace?.cycleStartDate);
  const originDay = cycleStart ? berlinCalendarDay(cycleStart) : null;

  let cycleNumber = 0;
  let startDay;
  let endDay;

  if (originDay && compareDays(today, originDay) >= 0) {
    const duration = normalizeCycleDuration(workspace?.cycleDurationMonths);
    const monthsSinceStart =
      (today.year - originDay.year) * 12 + (today.month - originDay.month);
    // Der Kandidat liegt im laufenden Monat oder davor. Liegt sein Starttag
    // noch vor uns, läuft der Zyklus davor.
    let index = Math.floor(monthsSinceStart / duration);
    if (compareDays(addMonthsClamped(originDay, index * duration), today) > 0)
      index -= 1;

    startDay = addMonthsClamped(originDay, index * duration);
    endDay = addMonthsClamped(originDay, (index + 1) * duration);
    cycleNumber = index + 1;
  } else {
    startDay = { year: today.year, month: today.month, day: 1 };
    endDay = addMonthsClamped(startDay, 1);
    if (originDay && compareDays(originDay, endDay) < 0) endDay = originDay;
  }

  const todayMs = utcMs(today.year, today.month, today.day);
  const endMs = utcMs(endDay.year, endDay.month, endDay.day);

  return {
    start: berlinMidnightOf(startDay),
    endExclusive: berlinMidnightOf(endDay),
    startDay: formatDay(startDay),
    endDayExclusive: formatDay(endDay),
    cycleNumber,
    nextReset: dayMarker(endDay),
    daysRemaining: Math.round((endMs - todayMs) / MS_PER_DAY),
  };
}

/**
 * Tagesmarke (00:00 UTC) zu einem Kalendertag, optional um Tage verschoben.
 * @param {string} day - "YYYY-MM-DD"
 * @param {number} [offsetDays]
 * @returns {Date}
 */
function dayToMarker(day, offsetDays = 0) {
  return new Date(dayMarker(parseDay(day)).getTime() + offsetDays * MS_PER_DAY);
}

module.exports = {
  BILLING_TIME_ZONE,
  // Wanduhr in Berliner Zeit und UTC-Millisekunden eines Kalendertags - auch
  // für den Export der Konversationen (Fixliste 7, F22)
  berlinFields,
  utcMs,
  getBillingWindow,
  berlinDayOf,
  berlinMidnight,
  cycleStartDay,
  dayToMarker,
};
