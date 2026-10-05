// KIE-480: gemeinsames Schema der Kurs-Metadaten-Spalten (start_date,
// start_minutes, weekdays, format, location, …) für den Server.
//
// Verwendet von:
//   - server/utils/vectorDbProviders/lance/searchFilters.js (Filter -> SQL)
//   - server/utils/chats/embedCourseSources.js (Kurskarten-Whitelist)
// Der Collector (collector/processRawText/index.js, METADATA_KEYS.course) ist
// ein eigenes Paket und prüft beim Upload mit denselben Regeln; Änderungen
// hier müssen dort nachgezogen werden (und umgekehrt).

const WEEKDAYS = Object.freeze([
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat",
  "sun",
]);
const FORMATS = Object.freeze(["online", "onsite", "hybrid"]);

// ISO-Datum YYYY-MM-DD (start_date, end_date)
const ISO_DATE_RX = /^\d{4}-\d{2}-\d{2}$/;
// Spalte weekdays: begrenzte Token-Liste ",mon,tue,"
const WEEKDAYS_COLUMN_RX = new RegExp(`^,((${WEEKDAYS.join("|")}),)+$`);
// Normalisierter Ort (klein, getrimmt): Buchstaben inkl. Umlaute, Ziffern,
// Leerzeichen, Punkt, Bindestrich; max. 80 Zeichen.
const LOCATION_RX = /^[a-z0-9äöüß\-. ]{1,80}$/;

// start_minutes = Minuten seit Mitternacht, [0, 1440)
const START_MINUTES_MIN = 0;
const START_MINUTES_MAX = 1440;

/** @param {any} n @returns {boolean} */
function isValidStartMinutes(n) {
  return Number.isInteger(n) && n >= START_MINUTES_MIN && n < START_MINUTES_MAX;
}

module.exports = {
  WEEKDAYS,
  FORMATS,
  ISO_DATE_RX,
  WEEKDAYS_COLUMN_RX,
  LOCATION_RX,
  START_MINUTES_MIN,
  START_MINUTES_MAX,
  isValidStartMinutes,
};
