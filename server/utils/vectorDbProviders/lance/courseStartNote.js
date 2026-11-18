/**
 * Startvermerk zur Fragezeit (issues/kurszustand-zur-fragezeit.md).
 *
 * Der Kurs-Extraktor der Pipeline hängt beim Einlesen an die Kopfzeile
 * „Beginn:“ eines laufenden Kurses den Vermerk START_NOTE_OPEN an. Zwischen
 * Einlesen und Frage veraltet er: ein inzwischen begonnener Kurs hat keinen,
 * ein verschobener behält ihn. Diese reinen Funktionen setzen ihn bei jeder
 * Anfrage aus den Metadaten der Zeile (`start_date`, `bookable`) und dem
 * heutigen Kalendertag (Europe/Berlin, berlinToday wie die Auswahlstufe):
 *
 * - `start_date` vor heute: Vermerk START_NOTE_OPEN, bei `bookable === false`
 *   (Warteliste oder ausgebucht) START_NOTE_STARTED;
 * - `start_date` heute oder später: kein Vermerk.
 *
 * Geändert wird nur die erste Zeile „Beginn:“ im Kopfblock eines Kurs-
 * dokuments: Text nach einem führenden <document_metadata>-Block bis zur
 * ersten Leerzeile bzw. „Kursbeschreibung:“, beginnend mit „Titel:“ (wie
 * headerBlock und courseNumberFromText in embedCourseSources.js). Der
 * Datumsteil und alle übrigen Zeichen bleiben gleich. Ohne gültiges
 * `start_date`, ohne Kopfzeile oder mit richtigem Vermerk kommt derselbe
 * Text zurück. Der Wortlaut ist der des Extraktors, den der Prompt erkennt.
 */
const { parseIsoDay } = require("./contextSelection");

const START_NOTE_OPEN = " — Bereits gestartet, Einstieg möglich";
const START_NOTE_STARTED = " — Bereits gestartet";

const DOC_METADATA_OPEN = "<document_metadata>";
const DOC_METADATA_CLOSE = "</document_metadata>";
const LEADING_BLANK_LINES_RX = /^(?:[ \t]*\r?\n)+/;
const DESCRIPTION_HEADER_RX = /^Kursbeschreibung:/m;
const BLANK_LINE_RX = /\n[ \t]*\r?\n/;
// Kopfzeile mit Datumsangabe; Zeilenende \r gehört nicht zur Zeile
const START_LINE_RX = /^Beginn:[ \t]*[^\s][^\n]*/m;

/**
 * Lage des Kopfblocks im Text (Start und Ende als Index).
 * @param {string} text
 * @returns {{start:number, end:number}|null}
 */
function headerRange(text) {
  let start = 0;
  if (text.trimStart().startsWith(DOC_METADATA_OPEN)) {
    const close = text.indexOf(DOC_METADATA_CLOSE);
    if (close === -1) return null;
    start = close + DOC_METADATA_CLOSE.length;
  }
  const lead = LEADING_BLANK_LINES_RX.exec(text.slice(start));
  if (lead) start += lead[0].length;
  let head = text.slice(start);
  const desc = head.search(DESCRIPTION_HEADER_RX);
  if (desc !== -1) head = head.slice(0, desc);
  const blank = head.search(BLANK_LINE_RX);
  if (blank !== -1) head = head.slice(0, blank);
  return { start, end: start + head.length };
}

/**
 * Kopfzeile „Beginn:“ eines Kontexttexts nach der Regel zur Fragezeit.
 * @param {unknown} text - Text des Treffers (Chunk)
 * @param {{start_date?: unknown, bookable?: unknown}|null|undefined} row -
 *   Metadaten der Zeile
 * @param {string|number} today - ISO-Tag Europe/Berlin (berlinToday) oder
 *   Tagesnummer (parseIsoDay)
 * @returns {unknown} angepasster Text oder unverändert derselbe Wert
 */
function startNoteText(text, row, today) {
  if (typeof text !== "string" || text.length === 0) return text;
  const todayDay = typeof today === "number" ? today : parseIsoDay(today);
  const startDay =
    row && typeof row === "object" ? parseIsoDay(row.start_date) : null;
  if (startDay === null || !Number.isFinite(todayDay)) return text;

  const range = headerRange(text);
  if (!range) return text;
  const block = text.slice(range.start, range.end);
  if (!block.startsWith("Titel:")) return text;
  const match = START_LINE_RX.exec(block);
  if (!match) return text;

  let line = match[0];
  if (line.endsWith("\r")) line = line.slice(0, -1);
  let current = "";
  for (const note of [START_NOTE_OPEN, START_NOTE_STARTED]) {
    if (line.endsWith(note)) {
      current = note;
      break;
    }
  }
  const wanted =
    startDay < todayDay
      ? row.bookable === false
        ? START_NOTE_STARTED
        : START_NOTE_OPEN
      : "";
  if (current === wanted) return text;

  const from = range.start + match.index;
  const datePart = line.slice(0, line.length - current.length);
  return (
    text.slice(0, from) + datePart + wanted + text.slice(from + line.length)
  );
}

/**
 * Regel für alle Kontexttexte einer Suche; `rows[i]` sind die Metadaten zu
 * `contextTexts[i]`. Ohne Änderung kommt dieselbe Liste zurück.
 * @param {string[]} contextTexts
 * @param {object[]} rows - sourceDocuments der Suche (gleiche Reihenfolge)
 * @param {string} today - ISO-Tag Europe/Berlin
 * @returns {string[]}
 */
function withStartNotes(contextTexts, rows, today) {
  if (!Array.isArray(contextTexts) || !Array.isArray(rows)) return contextTexts;
  const todayDay = parseIsoDay(today);
  if (todayDay === null) return contextTexts;
  let changed = false;
  const out = contextTexts.map((text, i) => {
    const next = startNoteText(text, rows[i], todayDay);
    if (next !== text) changed = true;
    return next;
  });
  return changed ? out : contextTexts;
}

module.exports = {
  START_NOTE_OPEN,
  START_NOTE_STARTED,
  startNoteText,
  withStartNotes,
};
