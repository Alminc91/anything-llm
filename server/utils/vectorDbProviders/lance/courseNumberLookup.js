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
 *    Hängt am Wort per Bindestrich ein Wort ohne Ziffer („26B7602-Kurs“,
 *    „Kurs-262-30748“), ist die Nummer ohne dieses Wort ein weiterer
 *    Kandidat (S-L3), nach allen ganzen Wörtern; er zählt nur, wenn das
 *    ganze Wort keine Kursnummer ergibt.
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
// als Kandidat zählt es nur ganz aus A bis Z, Ziffern und Bindestrich.
// Typografische Striche (U+2010 bis U+2013, aus PDF oder Online-Zeitung
// kopiert) gehören wie der Bindestrich zum Wort und werden darin zu „-“,
// das weiche Trennzeichen U+00AD entfällt (Review rc1 S-L4).
// Auf die ungekürzte Frage läuft nur WORD_RX (eine Zeichenklasse mit „+“,
// linear); jede weitere Prüfung nur auf Wörter bis COURSE_NUMBER_MAX_WORD_LEN
// (Review rc1 S-H1: „-+$“ auf einem Wort aus 100.000 Bindestrichen braucht
// quadratisch viele Schritte und hält den Server sekundenlang an).
const WORD_RX = /[\p{L}\p{N}\u00AD\u2010-\u2013-]+/gu;
const DASH_VARIANT_RX = /[\u2010-\u2013]/g;
const SOFT_HYPHEN_RX = /\u00AD/g;
const CANDIDATE_RX = /^[A-Za-z0-9-]+$/;
const DIGIT_RX = /[0-9]/;
// längstes Wort, das noch geprüft wird: Kandidat plus Rand für Randstriche
const COURSE_NUMBER_MAX_WORD_LEN = COURSE_NUMBER_MAX_LEN + 8;

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
 * Ein Wort der Frage (höchstens COURSE_NUMBER_MAX_WORD_LEN Zeichen) in die
 * Form eines Kandidaten: typografische Striche zu „-“, ohne weiches
 * Trennzeichen (S-L4), ohne Bindestriche am Rand; die Randstriche schneidet
 * eine Indexschleife ab, keine Regex (S-H1).
 * @param {string} word
 * @returns {string}
 */
function normalizeWord(word) {
  const text = word.replace(DASH_VARIANT_RX, "-").replace(SOFT_HYPHEN_RX, "");
  let start = 0;
  let end = text.length;
  while (start < end && text[start] === "-") start++;
  while (end > start && text[end - 1] === "-") end--;
  return text.slice(start, end);
}

/**
 * Hat ein normalisiertes Wort die Form eines Kandidaten (D2)?
 * @param {string} word - höchstens COURSE_NUMBER_MAX_WORD_LEN Zeichen
 * @returns {boolean}
 */
function isCandidateForm(word) {
  return (
    word.length >= COURSE_NUMBER_MIN_LEN &&
    word.length <= COURSE_NUMBER_MAX_LEN &&
    CANDIDATE_RX.test(word) &&
    DIGIT_RX.test(word)
  );
}

/**
 * S-L3: Nummer ohne per Bindestrich angehängte Wörter. Teile am Bindestrich
 * ohne Ziffer am Anfang und am Ende fallen weg („26B7602-Kurs“ zu „26B7602“,
 * „Kurs-262-30748“ zu „262-30748“); Teile mitten in der Nummer bleiben
 * („261-G-071“). Alle Formate der Flotte haben an beiden Enden eine Ziffer.
 * @param {string} word - normalisiertes Wort, höchstens
 *   COURSE_NUMBER_MAX_WORD_LEN Zeichen
 * @returns {string|null} null, wenn kein Wort angehängt ist
 */
function withoutAttachedWords(word) {
  if (!word.includes("-")) return null;
  const segments = word.split("-");
  let start = 0;
  let end = segments.length;
  while (start < end && !DIGIT_RX.test(segments[start])) start++;
  while (end > start && !DIGIT_RX.test(segments[end - 1])) end--;
  if (start === 0 && end === segments.length) return null;
  return segments.slice(start, end).join("-");
}

/**
 * Suchplan für Kursnummern aus einer Frage (D2): ganze Wörter in der
 * Reihenfolge der Frage, danach Nummern ohne angehängtes Wort (S-L3), ohne
 * Doppel (Groß- und Kleinschreibung zählt nicht), gesamt höchstens `max`
 * (NAK-4). Satzzeichen um das Wort und Bindestriche am Rand zählen nicht,
 * typografische Striche gelten als Bindestrich (S-L4); Wörter über
 * COURSE_NUMBER_MAX_WORD_LEN Zeichen werden übersprungen (S-H1).
 * @param {*} input - Suchtext
 * @param {number} [max]
 * @returns {{candidate: string, position: number, part: boolean}[]}
 *   candidate in der Schreibweise der Frage (Striche als „-“); position ist
 *   die Stelle des Worts in der Frage (ein Teil hat die seines Worts); part
 *   kennzeichnet die Nummer ohne angehängtes Wort
 */
function courseNumberSearchPlan(input, max = COURSE_NUMBER_MAX_SEARCHED) {
  if (typeof input !== "string" || input.length === 0) return [];
  const whole = [];
  const wholeKeys = new Set();
  // Teile: höchstens max verschiedene, mehr kann der Plan nie aufnehmen
  // (jedes ganze Wort verdrängt höchstens einen Teil gleicher Schreibweise)
  const parts = [];
  const partKeys = new Set();
  // dasselbe Wort noch einmal ergibt nichts Neues
  const seenWords = new Set();
  for (const match of input.matchAll(WORD_RX)) {
    // zu lange Wörter vor jeder weiteren Prüfung überspringen (S-H1); zu
    // kurze und solche ohne Ziffer ergeben weder als Ganzes noch als Teil
    // einen Kandidaten (das Normalisieren macht ein Wort nur kürzer)
    const raw = match[0];
    if (
      raw.length < COURSE_NUMBER_MIN_LEN ||
      raw.length > COURSE_NUMBER_MAX_WORD_LEN ||
      !DIGIT_RX.test(raw) ||
      seenWords.has(raw)
    )
      continue;
    seenWords.add(raw);
    const word = normalizeWord(raw);
    const position = match.index;
    if (isCandidateForm(word)) {
      const key = word.toLowerCase();
      if (!wholeKeys.has(key)) {
        wholeKeys.add(key);
        whole.push({ candidate: word, position, part: false });
        if (whole.length >= max) break;
      }
    }
    if (parts.length >= max) continue;
    const core = withoutAttachedWords(word);
    if (core === null || !isCandidateForm(core)) continue;
    const coreKey = core.toLowerCase();
    if (partKeys.has(coreKey)) continue;
    partKeys.add(coreKey);
    parts.push({ candidate: core, position, part: true });
  }
  const rest = parts.filter((p) => !wholeKeys.has(p.candidate.toLowerCase()));
  return [...whole, ...rest].slice(0, max);
}

/**
 * Kandidaten für Kursnummern aus einer Frage, wie courseNumberSearchPlan
 * sie sucht.
 * @param {*} input - Suchtext
 * @param {number} [max]
 * @returns {string[]}
 */
function courseNumberCandidates(input, max = COURSE_NUMBER_MAX_SEARCHED) {
  return courseNumberSearchPlan(input, max).map((entry) => entry.candidate);
}

/**
 * S-L3, AK-3: Treffer je Kandidat des Suchplans in die Reihenfolge der
 * Frage (Stelle des Worts, bei gleicher Stelle das ganze Wort vor seinem
 * Teil). Ergibt das ganze Wort eine Kursnummer, zählt sein Teil nicht.
 * @param {{position: number, part: boolean}[]} plan - courseNumberSearchPlan
 * @param {object[][]} rowsPerCandidate - geprüfte Treffer je Eintrag des Plans
 * @returns {object[][]} Treffer je verbleibendem Eintrag, in dieser Reihenfolge
 */
function courseNumberMatchesInOrder(plan, rowsPerCandidate) {
  const rowsOf = (i) =>
    Array.isArray(rowsPerCandidate?.[i]) ? rowsPerCandidate[i] : [];
  const wholeFound = new Set(
    plan
      .map((entry, i) => (!entry.part && rowsOf(i).length > 0 ? entry : null))
      .filter(Boolean)
      .map((entry) => entry.position)
  );
  return plan
    .map((entry, i) => ({ entry, i }))
    .filter(({ entry }) => !(entry.part && wholeFound.has(entry.position)))
    .sort(
      (a, b) =>
        a.entry.position - b.entry.position ||
        Number(a.entry.part) - Number(b.entry.part) ||
        a.i - b.i
    )
    .map(({ i }) => rowsOf(i));
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
  courseNumberSearchPlan,
  courseNumberMatchesInOrder,
  courseNumberKey,
  courseNumberOfText,
  matchesCourseNumber,
  mergeCourseNumberHits,
  COURSE_NUMBER_MIN_LEN,
  COURSE_NUMBER_MAX_LEN,
  COURSE_NUMBER_MAX_WORD_LEN,
  COURSE_NUMBER_MAX_SEARCHED,
  COURSE_NUMBER_FTS_LIMIT,
};
