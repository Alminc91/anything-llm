/**
 * Kursnummern in Fragen (issues/kursnummer-erkennung.md): Nennt ein Besucher
 * eine Kursnummer, auch mitten im Satz, kommt der Kurs mit genau dieser
 * Nummer vorn in die Quellen. Die Volltextsuche mit der ganzen Frage findet
 * ihn mit Trigrammen (KIE-478) oft nicht unter den Kandidaten (gemessen am
 * 11.09.2026: Rang 103 bei 25 Plätzen je Arm), die Suche nur nach der
 * Nummer dagegen sicher.
 *
 * Ablauf (lance/index.js, courseNumberLookup):
 * 1. Kandidaten aus der Frage (D2): Wörter aus Buchstaben A bis Z, Ziffern
 *    und Bindestrich, 4 bis 15 Zeichen, mindestens eine Ziffer; höchstens
 *    COURSE_NUMBER_MAX_SEARCHED verschiedene je Frage (NAK-4), in der
 *    Reihenfolge der Frage. Ohne Kandidaten läuft keine Abfrage (AK-7).
 * 2. Je Kandidat eine Volltextsuche nur nach diesem Wort, mit denselben
 *    Bedingungen wie die übrige Suche (Metadatenfilter, Ausschluss
 *    veralteter Kurse). Der Kandidat geht nie in eine Filterbedingung, nur
 *    in die Volltextsuche, und besteht nur aus [A-Za-z0-9-] (HC4).
 * 3. Ein Kandidat gilt erst als Kursnummer, wenn ein Treffer ihn in der
 *    Kopfzeile „Kursnummer:“ seines Kopfblocks führt, wie der Kursbestand
 *    sie liest (embedCourseSources.courseNumberFromText). Die Daten
 *    entscheiden, nicht das Muster (HC2): Jahr, Postleitzahl oder
 *    Telefonnummer ohne passendes Kursdokument ändern nichts (AK-4).
 * 4. Gefundene Kurse stehen vor den übrigen Quellen, in der Reihenfolge der
 *    Frage, höchstens topN (D3, AK-3); die übrigen Plätze behalten die
 *    Reihenfolge der Suche ohne die gefundenen Kurse.
 */
const { courseNumberFromText } = require("../../chats/embedCourseSources");

// D2: Länge eines Kandidaten, NAK-4: höchstens so viele je Frage
const COURSE_NUMBER_MIN_LEN = 4;
const COURSE_NUMBER_MAX_LEN = 15;
const COURSE_NUMBER_MAX_SEARCHED = 5;
// Treffer je Kandidat, aus denen die Kopfzeile geprüft wird. Die Abfrage
// verlangt alle Trigramme des Kandidaten (Operator AND), es bleiben wenige
// Dokumente: der Kurs selbst, Seiten mit der Nummer im Freitext.
const COURSE_NUMBER_FTS_LIMIT = 50;

// Wort = zusammenhängende Buchstaben (jeder Schrift), Ziffern, Bindestriche;
// als Kandidat zählt es nur ganz aus A bis Z, Ziffern und Bindestrich
const WORD_RX = /[\p{L}\p{N}-]+/gu;
const CANDIDATE_RX = /^[A-Za-z0-9-]+$/;
const DIGIT_RX = /[0-9]/;
const EDGE_HYPHENS_RX = /^-+|-+$/g;

/**
 * Vergleichsform einer Kursnummer: getrimmt, klein geschrieben.
 * @param {*} value
 * @returns {string|null}
 */
function courseNumberKey(value) {
  if (typeof value !== "string") return null;
  const key = value.normalize("NFC").trim().toLowerCase();
  return key.length > 0 ? key : null;
}

/**
 * Kandidaten für Kursnummern aus einer Frage (D2), in der Reihenfolge der
 * Frage, ohne Doppel (Groß- und Kleinschreibung zählt nicht), höchstens
 * `max`. Satzzeichen um das Wort und Bindestriche am Rand zählen nicht.
 * @param {*} input - Suchtext
 * @param {number} [max]
 * @returns {string[]} Kandidaten in der Schreibweise der Frage
 */
function courseNumberCandidates(input, max = COURSE_NUMBER_MAX_SEARCHED) {
  if (typeof input !== "string" || input.length === 0) return [];
  const seen = new Set();
  const out = [];
  for (const match of input.matchAll(WORD_RX)) {
    const word = match[0].replace(EDGE_HYPHENS_RX, "");
    if (
      word.length < COURSE_NUMBER_MIN_LEN ||
      word.length > COURSE_NUMBER_MAX_LEN ||
      !CANDIDATE_RX.test(word) ||
      !DIGIT_RX.test(word)
    )
      continue;
    const key = word.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(word);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Kursnummer aus der Kopfzeile „Kursnummer:“ eines Abschnitts (Kopfblock,
 * wie im Kursbestand); kein Kursdokument -> null.
 * @param {*} text
 * @returns {string|null}
 */
function courseNumberOfText(text) {
  return courseNumberFromText(text) ?? null;
}

/**
 * Führt der Abschnitt genau diese Kursnummer in seiner Kopfzeile?
 * @param {*} text - Text des Abschnitts
 * @param {*} candidate - Kandidat aus der Frage
 * @returns {boolean}
 */
function matchesCourseNumber(text, candidate) {
  const wanted = courseNumberKey(candidate);
  if (!wanted) return false;
  return courseNumberKey(courseNumberOfText(text)) === wanted;
}

// Quelle aus einer Trefferzeile: ohne Vektor und ohne interne Felder der
// Abfrage; ohne Bewertung, weil kein Vergleichswert zur übrigen Suche
// besteht (die Quellenanzeige zeigt dann keinen Prozentwert)
function sourceOfRow(row) {
  const {
    vector: _v,
    _score: _s,
    _distance: _d,
    _relevance_score: _r,
    _rowid: _id,
    ...rest
  } = row;
  return rest;
}

/**
 * D3: Gefundene Kurse vor die Quellen der Suche, höchstens topN. Steht ein
 * gefundener Kurs schon unter den Quellen, rückt er mit seinen Angaben
 * (etwa der Reranker-Bewertung) nach vorn. Die übrigen Plätze behalten die
 * Reihenfolge der Suche. Ohne Treffer bleibt das Ergebnis dasselbe Objekt.
 * @param {{contextTexts: string[], sourceDocuments: object[], scores: number[]}} result
 * @param {{courseNumber: string, row: object}[]|null} hits
 * @param {number} topN
 * @returns {{contextTexts: string[], sourceDocuments: object[], scores: (number|null)[]}}
 */
function mergeCourseNumberHits(result, hits, topN) {
  if (!Array.isArray(hits) || hits.length === 0) return result;
  const merged = { contextTexts: [], sourceDocuments: [], scores: [] };
  const indexById = new Map(
    result.sourceDocuments.map((doc, i) => [doc?.id, i])
  );
  // IDs der vorangestellten Kurse (Trefferzeilen tragen immer eine ID)
  const placed = new Set();
  const push = (text, doc, score) => {
    merged.contextTexts.push(text);
    merged.sourceDocuments.push(doc);
    merged.scores.push(score);
  };

  for (const { row } of hits) {
    if (merged.sourceDocuments.length >= topN) break;
    if (typeof row?.id !== "string" || placed.has(row.id)) continue;
    placed.add(row.id);
    const i = indexById.get(row.id);
    if (i !== undefined)
      push(result.contextTexts[i], result.sourceDocuments[i], result.scores[i]);
    else push(row.text, sourceOfRow(row), null);
  }
  result.sourceDocuments.forEach((doc, i) => {
    if (merged.sourceDocuments.length >= topN || placed.has(doc?.id)) return;
    push(result.contextTexts[i], doc, result.scores[i]);
  });
  return merged;
}

module.exports = {
  courseNumberCandidates,
  courseNumberKey,
  courseNumberOfText,
  matchesCourseNumber,
  mergeCourseNumberHits,
  COURSE_NUMBER_MIN_LEN,
  COURSE_NUMBER_MAX_LEN,
  COURSE_NUMBER_MAX_SEARCHED,
  COURSE_NUMBER_FTS_LIMIT,
};
