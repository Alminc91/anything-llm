/**
 * Kursnummern in Fragen (issues/kursnummer-erkennung.md): Nennt ein Besucher
 * eine Kursnummer, auch mitten im Satz, kommt der Kurs mit genau dieser
 * Nummer vorn in die Quellen. Die Volltextsuche mit der ganzen Frage findet
 * ihn mit Trigrammen (KIE-478) oft nicht unter den Kandidaten (gemessen am
 * 11.09.2026: Rang 103 bei 25 Plätzen je Arm), die Suche nur nach der
 * Nummer dagegen sicher.
 *
 * Ablauf (lance/index.js, courseNumberLookup):
 * 1. Kandidaten aus der Frage (D2): Wörter aus Buchstaben A bis Z, Ziffern,
 *    Bindestrich und Punkt (Nachtrag 8.1.3: „BA56.25“, „26B7154.E“), 4 bis
 *    15 Zeichen, mindestens eine Ziffer; Punkte und Striche am Wortrand sind
 *    Satzzeichen. Höchstens COURSE_NUMBER_MAX_SEARCHED verschiedene je Frage
 *    (NAK-4), in der Reihenfolge der Frage. Ohne Kandidaten läuft keine
 *    Abfrage (AK-7). Weitere Kandidaten aus einem Wort, als Teile nach allen
 *    ganzen Wörtern (courseNumberSearchForms): die Nummer ohne angehängte
 *    Wörter („26B7602-Kurs“, „Kurs-262-30748“, „Nr.26B7602“; S-L3) und die
 *    Hälften an Ziffern- und Halbgeviertstrich („26B7602–26B7604“; S-L8).
 *    Ein Teil zählt nur dort, wo das ganze Wort keine Kursnummer ergibt
 *    (S-L10).
 * 2. Je Kandidat eine Volltextsuche nur nach diesem Wort, mit denselben
 *    Bedingungen wie die übrige Suche (Metadatenfilter, Ausschluss
 *    veralteter Kurse). Der Kandidat geht nie in eine Filterbedingung, nur
 *    in die Volltextsuche, und besteht nur aus [A-Za-z0-9.-] (HC4).
 * 3. Ein Kandidat gilt erst als Kursnummer, wenn ein Treffer ihn in der
 *    Kopfzeile „Kursnummer:“ seines Kopfblocks führt, wie der Kursbestand
 *    sie liest (embedCourseSources.courseNumberFromText). Die Daten
 *    entscheiden, nicht das Muster (HC2): Jahr, Postleitzahl, Telefonnummer,
 *    Datum oder Preis ohne passendes Kursdokument ändern nichts (AK-4,
 *    AK-13).
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

// Wort = zusammenhängende Buchstaben (jeder Schrift), Ziffern, Bindestriche
// und Punkte; als Kandidat zählt es nur ganz aus A bis Z, Ziffern, Bindestrich
// und Punkt (Nachtrag 8.1.3).
// Typografische Striche (U+2010 bis U+2013, aus PDF oder Online-Zeitung
// kopiert) gehören wie der Bindestrich zum Wort und werden darin zu „-“,
// das weiche Trennzeichen U+00AD entfällt (Review rc1 S-L4). Ziffern- und
// Halbgeviertstrich (U+2012, U+2013) trennen zusätzlich zwei Nummern (S-L8).
// Auf die ungekürzte Frage läuft nur WORD_RX (eine Zeichenklasse mit „+“,
// linear); jede weitere Prüfung nur auf Wörter bis COURSE_NUMBER_MAX_WORD_LEN
// (Review rc1 S-H1: „-+$“ auf einem Wort aus 100.000 Bindestrichen braucht
// quadratisch viele Schritte und hält den Server sekundenlang an; NAK-5:
// Punkte und Striche am Rand schneidet eine Indexschleife ab, keine Regex).
const WORD_RX = /[\p{L}\p{N}\u00AD\u2010-\u2013.-]+/gu;
const DASH_VARIANT_RX = /[\u2010-\u2013]/g;
const RANGE_DASH_RX = /[\u2012\u2013]/;
const SOFT_HYPHEN_RX = /\u00AD/g;
const CANDIDATE_RX = /^[A-Za-z0-9.-]+$/;
const DIGIT_RX = /[0-9]/;
// längstes Wort, das noch geprüft wird: Kandidat plus angehängte Wörter,
// Randpunkte und Randstriche („Volkshochschulkurs-26B7602“; S-L9). Danach
// läuft jede Prüfung linear über höchstens so viele Zeichen.
const COURSE_NUMBER_MAX_WORD_LEN = 64;

const isDigit = (ch) => ch >= "0" && ch <= "9";
// trennt Teile einer Nummer, nach dem Vereinheitlichen der Striche
const isSeparator = (ch) => ch === "-" || ch === ".";

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
 * Ein Wort der Frage (höchstens COURSE_NUMBER_MAX_WORD_LEN Zeichen, ohne
 * weiches Trennzeichen) in die Form eines Kandidaten: typografische Striche
 * zu „-“ (S-L4), ohne Bindestriche und Punkte am Rand (AK-12); den Rand
 * schneidet eine Indexschleife ab, keine Regex (S-H1, NAK-5).
 * @param {string} word
 * @returns {string}
 */
function normalizeWord(word) {
  const text = word.replace(DASH_VARIANT_RX, "-");
  let start = 0;
  let end = text.length;
  while (start < end && isSeparator(text[start])) start++;
  while (end > start && isSeparator(text[end - 1])) end--;
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
 * S-L3: Nummer ohne per Bindestrich oder Punkt angehängte Wörter. Vorn fällt
 * jeder Teil ohne Ziffer weg („Kurs-262-30748“, „Kurs-Nr.262-30748“ und
 * „Nr.26B7602“ zur Nummer), hinten jeder Teil ohne Ziffer aus mindestens
 * zwei Zeichen („26B7602-Kurs“ zu „26B7602“). Ein einzelner Buchstabe am
 * Ende gehört zur Nummer („X41.501-S“, „26B7154.E“ aus der Flotte) und
 * bleibt, ebenso Teile mitten in der Nummer („261-G-071“). Die Trenner
 * bleiben, wie sie sind („Kurs-X41.100“ zu „X41.100“). Indexschleifen, keine
 * Regex.
 * @param {string} word - normalisiertes Wort, höchstens
 *   COURSE_NUMBER_MAX_WORD_LEN Zeichen
 * @returns {string|null} null, wenn kein Wort angehängt ist
 */
function withoutAttachedWords(word) {
  // vorn: Teile bis zu dem mit der ersten Ziffer
  let start = 0;
  let first = 0;
  for (; first < word.length && !isDigit(word[first]); first++)
    if (isSeparator(word[first])) start = first + 1;
  if (first === word.length) return null;
  // hinten: Teile ohne Ziffer, außer einem einzelnen Zeichen (leere Teile
  // zwischen zwei Trennern fallen mit weg)
  let end = word.length;
  for (let i = end - 1, digitless = true; i > first; i--) {
    if (isDigit(word[i])) digitless = false;
    if (!isSeparator(word[i])) continue;
    if (!digitless || end - i - 1 === 1) break;
    end = i;
  }
  if (start === 0 && end === word.length) return null;
  return word.slice(start, end);
}

/**
 * Alle Suchformen eines Worts der Frage (Review rc2, Fehlerklasse K3): das
 * ganze Wort und als Teile die Nummer ohne angehängte Wörter (S-L3) sowie
 * die Hälften an Ziffern- und Halbgeviertstrich mit ihren Nummern ohne
 * angehängte Wörter (S-L8: „26B7602–26B7604“, „262-30748–262-30749“).
 * @param {string} raw - Wort aus WORD_RX, höchstens
 *   COURSE_NUMBER_MAX_WORD_LEN Zeichen
 * @returns {{whole: string|null, parts: string[]}} whole nur in
 *   Kandidatenform; parts in der Reihenfolge im Wort, ohne Doppel und ohne
 *   das ganze Wort
 */
function courseNumberSearchForms(raw) {
  const text = raw.replace(SOFT_HYPHEN_RX, "");
  const whole = normalizeWord(text);
  const keys = new Set([whole.toLowerCase()]);
  const parts = [];
  const add = (form) => {
    if (form === null || !isCandidateForm(form)) return;
    const key = form.toLowerCase();
    if (keys.has(key)) return;
    keys.add(key);
    parts.push(form);
  };
  add(withoutAttachedWords(whole));
  if (RANGE_DASH_RX.test(text))
    for (const piece of text.split(RANGE_DASH_RX)) {
      const half = normalizeWord(piece);
      add(half);
      add(withoutAttachedWords(half));
    }
  return { whole: isCandidateForm(whole) ? whole : null, parts };
}

/**
 * Suchplan für Kursnummern aus einer Frage (D2): ganze Wörter in der
 * Reihenfolge der Frage, danach die Teile (courseNumberSearchForms), je
 * Schreibweise einmal (Groß- und Kleinschreibung zählt nicht), gesamt
 * höchstens `max` (NAK-4). Satzzeichen um das Wort, Bindestriche und Punkte
 * am Rand zählen nicht, typografische Striche gelten als Bindestrich (S-L4);
 * Wörter über COURSE_NUMBER_MAX_WORD_LEN Zeichen werden übersprungen (S-H1).
 * S-L10: Kommt eine Schreibweise als Teil mehrerer Wörter vor oder als Teil
 * und als ganzes Wort, wird sie einmal gesucht; alsoPartAt nennt die Stellen
 * der weiteren Wörter, zu denen sie als Teil gehört.
 * @param {*} input - Suchtext
 * @param {number} [max]
 * @returns {{candidate: string, position: number, part: boolean, alsoPartAt?: number[]}[]}
 *   candidate in der Schreibweise der Frage (Striche als „-“); position ist
 *   die Stelle des Worts in der Frage (ein Teil hat die seines ersten
 *   Worts); part kennzeichnet einen Teil; alsoPartAt nur, wenn es weitere
 *   Stellen gibt, aufsteigend
 */
function courseNumberSearchPlan(input, max = COURSE_NUMBER_MAX_SEARCHED) {
  if (typeof input !== "string" || input.length === 0) return [];
  const whole = [];
  const wholeByKey = new Map();
  // Teile je Schreibweise mit den Stellen ihrer Wörter: höchstens max
  // verschiedene, mehr kann der Plan nie aufnehmen (jedes ganze Wort
  // verdrängt höchstens einen Teil gleicher Schreibweise); weitere Stellen
  // bekannter Schreibweisen zählen immer (S-L10), aber höchstens max + 1:
  // nur an den Stellen der höchstens max ganzen Wörter fällt ein Teil weg
  const parts = new Map();
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
    const position = match.index;
    const forms = courseNumberSearchForms(raw);
    if (forms.whole !== null) {
      const key = forms.whole.toLowerCase();
      if (!wholeByKey.has(key)) {
        const entry = { candidate: forms.whole, position, part: false };
        wholeByKey.set(key, entry);
        whole.push(entry);
        if (whole.length >= max) break;
      }
    }
    for (const form of forms.parts) {
      const key = form.toLowerCase();
      const known = parts.get(key);
      if (known) {
        if (known.positions.length <= max) known.positions.push(position);
      } else if (parts.size < max || wholeByKey.has(key))
        parts.set(key, { candidate: form, positions: [position] });
    }
  }
  const rest = [];
  for (const [key, { candidate, positions }] of parts) {
    const owner = wholeByKey.get(key);
    if (owner) owner.alsoPartAt = positions;
    else
      rest.push({
        candidate,
        position: positions[0],
        part: true,
        ...(positions.length > 1 ? { alsoPartAt: positions.slice(1) } : {}),
      });
  }
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
 * Teil). Ergibt das ganze Wort eine Kursnummer, zählt sein Teil an dieser
 * Stelle nicht; an jeder weiteren Stelle seines Vorkommens (alsoPartAt) zählt
 * er, wenn das ganze Wort dort nichts traf, und steht an der ersten
 * solchen Stelle (S-L10). Ein Eintrag ohne zählende Stelle fällt weg.
 * @param {{position: number, part: boolean, alsoPartAt?: number[]}[]} plan -
 *   courseNumberSearchPlan
 * @param {object[][]} rowsPerCandidate - geprüfte Treffer je Eintrag des Plans
 * @returns {object[][]} Treffer je verbleibendem Eintrag, in dieser Reihenfolge
 */
function courseNumberMatchesInOrder(plan, rowsPerCandidate) {
  const rowsOf = (i) =>
    Array.isArray(rowsPerCandidate?.[i]) ? rowsPerCandidate[i] : [];
  // Stellen der Wörter, deren ganzes Wort eine Kursnummer ergab
  const wholeFound = new Set(
    plan
      .map((entry, i) => (!entry.part && rowsOf(i).length > 0 ? entry : null))
      .filter(Boolean)
      .map((entry) => entry.position)
  );
  const counts = (position, part) => !(part && wholeFound.has(position));
  return plan
    .map((entry, i) => {
      // erste zählende Stelle: die eigene, sonst die erste weitere als Teil
      const own = counts(entry.position, entry.part)
        ? { position: entry.position, part: entry.part }
        : null;
      const other = (entry.alsoPartAt ?? []).find((p) => counts(p, true));
      const at =
        other === undefined || (own && own.position <= other)
          ? own
          : { position: other, part: true };
      return at ? { ...at, i } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.position - b.position || a.part - b.part || a.i - b.i)
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
// Abfrage. score ist null: kein Vergleichswert zur übrigen Suche (die
// Quellenanzeige zeigt dann keinen Prozentwert), aber das Feld kennzeichnet
// einen Suchtreffer. fillSourceWindow (helpers/chat) nimmt bei Folgefragen
// aus dem Verlauf nur Quellen mit score, alle anderen gelten als früher
// angeheftete Dokumente (Review rc1 S-L1).
function sourceOfRow(row) {
  const {
    vector: _v,
    _score: _s,
    _distance: _d,
    _relevance_score: _r,
    _rowid: _id,
    ...rest
  } = row;
  return { ...rest, score: null };
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
  courseNumberSearchForms,
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
