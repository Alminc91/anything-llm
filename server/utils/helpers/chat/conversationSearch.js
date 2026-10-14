// Suche in der Konversationsliste der Auswertung (Konversationen-Ansicht):
// Groß- und Kleinschreibung egal, auch bei Umlauten.
//
// SQLite kann das nicht allein: lower(), upper() und LIKE kennen nur die
// ASCII-Buchstaben ("Ü" LIKE "ü" ist falsch). Deshalb je Begriff zwei Stufen,
// alle Muster als gebundene Werte, nie im SQL-Text:
//
// - Vorprüfung (searchProbe): billig und möglichst wählerisch. Ohne
//   Buchstaben außerhalb von ASCII, die eine zweite Schreibweise haben
//   (ü/Ü, ß/ẞ, к/К …), ist das ein LIKE über den ganzen Begriff – Groß/klein
//   egal für A–Z, und schon genau. Sonst ein Teil des Begriffs: der längste
//   Abschnitt ohne solche Buchstaben (ab drei Buchstaben/Ziffern), oder ein
//   kurzes Fenster, dessen Schreibweisen ausgeschrieben werden – höchstens
//   vier (LIKE '%üb%' OR LIKE '%Üb%'; ohne ASCII-Buchstaben im Fenster
//   instr(), das noch schneller ist). Gemessen (Fixliste Punkt 6): Ein
//   Zeichen „_" je Umlaut ließe fast jede Zeile durch, die Genauprüfung
//   dahinter läse dann alle Antworten.
// - Genauprüfung (searchGlobPattern): GLOB mit Zeichenklassen aus den
//   Schreibweisen ("übung" → "*[üÜ][bB][uU][nN][gG]*"); *, ? und [ als
//   Klasse aus sich selbst. Sie läuft nur auf Zeilen, die die Vorprüfung
//   durchlässt.
//
// Zerlegte Umlaute (NFD, „u" + Trema – etwa aus macOS oder PDF kopiert)
// gelten wie zusammengesetzte: searchForms liefert beide Formen, gesucht wird
// nach jeder (Punkt 24).
//
// GLOB, LIKE und instr vergleichen Zeichen für Zeichen (UTF-8), ohne
// Kollation.

/** Längster zulässiger Suchbegriff (Zeichen nach dem Trimmen). */
const SEARCH_MAX_LENGTH = 200;
/**
 * Längster Rohwert von `q` (UTF-16-Einheiten) – geprüft, bevor der Wert
 * normalisiert oder in Zeichen zerlegt wird: Ein riesiger Rumpf soll keinen
 * Speicher binden (Punkt 1). Vier Einheiten je Zeichen lassen Leerraum und
 * zerlegte Zeichen zu.
 */
const SEARCH_MAX_RAW_LENGTH = SEARCH_MAX_LENGTH * 4;

// Steuerzeichen: SQLite schneidet ein Muster am NUL ab (trifft dann alles),
// Tabulator und Zeilenumbruch stehen in keinem sichtbaren Begriff (Punkt 2).
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
// Mit dem u-Flag trifft die Klasse nur Hälften eines Ersatzpaars, die allein
// stehen – ein vollständiges Paar ist ein Zeichen außerhalb der Klasse.
const LONE_SURROGATE = /[\uD800-\uDFFF]/u;

/**
 * Der Suchbegriff einer Anfrage: getrimmt, in NFC (ein „ü" ist ein Zeichen).
 * Leer → keine Suche. Abgelehnt (→ 400): kein Text, Rohwert über
 * SEARCH_MAX_RAW_LENGTH, allein stehende Ersatzhälften (kein gültiges
 * Unicode), Steuerzeichen, mehr als SEARCH_MAX_LENGTH Zeichen.
 * @param {unknown} value - Feld `q` des Rumpfs
 * @returns {{search: string|null, error: string|null}}
 */
function parseSearch(value) {
  if (value === undefined || value === null)
    return { search: null, error: null };
  if (typeof value !== "string")
    return { search: null, error: "q must be a string." };
  const tooLong = {
    search: null,
    error: `q must not be longer than ${SEARCH_MAX_LENGTH} characters.`,
  };
  if (value.length > SEARCH_MAX_RAW_LENGTH) return tooLong;
  if (LONE_SURROGATE.test(value))
    return { search: null, error: "q must be well-formed Unicode." };
  const search = value.normalize("NFC").trim();
  if (search === "") return { search: null, error: null };
  if (CONTROL_CHARACTERS.test(search))
    return { search: null, error: "q must not contain control characters." };
  if ([...search].length > SEARCH_MAX_LENGTH) return tooLong;
  return { search, error: null };
}

/**
 * Die Formen, in denen der Begriff gesucht wird: NFC (wie parseSearch ihn
 * liefert) und, falls verschieden, NFD – gespeicherte Texte können zerlegte
 * Umlaute enthalten.
 *
 * Bewusst so belassen (Kontroll-Review, Low): In einem NFD-Text trifft auch
 * der Basisbuchstabe allein – „mu" findet „Müller" (zerlegt „Mu" + Trema),
 * und die Hervorhebung im Panel trennt dann das Trema ab. Das kommt nur bei
 * zerlegt gespeicherten Texten vor und liefert höchstens einen Treffer zu
 * viel, nie einen zu wenig.
 * @param {string} search - Ergebnis von parseSearch
 * @returns {string[]}
 */
function searchForms(search) {
  const decomposed = search.normalize("NFD");
  return decomposed === search ? [search] : [search, decomposed];
}

/**
 * Der Begriff, wie er in einem JSON-Text gespeichert steht: Anführungszeichen
 * und Rückstrich maskiert (JSON.stringify ohne die äußeren Anführungszeichen).
 * Steuerzeichen und Ersatzhälften lehnt parseSearch vorher ab; andere
 * Zeichen schreibt JSON.stringify wörtlich.
 * @param {string} text
 * @returns {string}
 */
function jsonEscaped(text) {
  return JSON.stringify(text).slice(1, -1);
}

// Platzhalter von GLOB: als Klasse mit nur diesem Zeichen wörtlich.
const GLOB_SPECIAL = new Set(["*", "?", "["]);

/**
 * Die Schreibweisen eines Zeichens, die als dasselbe gelten: es selbst, klein
 * und groß – nur wenn diese wieder genau ein Zeichen sind („ß" wird groß zu
 * „SS", zwei Zeichen; dafür gehört das große „ẞ" dazu).
 * @param {string} char - ein Zeichen (Codepoint)
 * @returns {string[]}
 */
function variantsOf(char) {
  const variants = new Set([char]);
  for (const other of [char.toLowerCase(), char.toUpperCase()])
    if ([...other].length === 1) variants.add(other);
  if (char === "ß" || char === "ẞ") {
    variants.add("ß");
    variants.add("ẞ");
  }
  return [...variants];
}

/**
 * GLOB-Muster „enthält den Begriff", Groß/klein egal.
 * Zeichen mit mehreren Schreibweisen werden zur Klasse ("[üÜ]"), Platzhalter
 * zur Klasse aus sich selbst ("[*]"). „]" und „^" stehen nie in einer Klasse
 * und gelten außerhalb wörtlich, „-" ebenso.
 * @param {string} text - eine Form des Begriffs (searchForms)
 * @returns {string}
 */
function searchGlobPattern(text) {
  let pattern = "*";
  for (const char of text) {
    const variants = variantsOf(char);
    if (variants.length > 1) pattern += `[${variants.join("")}]`;
    else if (GLOB_SPECIAL.has(char)) pattern += `[${char}]`;
    else pattern += char;
  }
  return `${pattern}*`;
}

/** Buchstabe außerhalb von ASCII mit einer zweiten Schreibweise (ü, ß, к …)? */
function isFoldedNonAscii(char) {
  return char.codePointAt(0) > 0x7f && variantsOf(char).length > 1;
}

/** Zeichen für LIKE ... ESCAPE '\' maskieren: %, _ und \ gelten wörtlich. */
function likeEscaped(text) {
  return text.replace(/[%_\\]/g, (char) => `\\${char}`);
}

/**
 * LIKE-Muster „enthält den Begriff" (ESCAPE '\'). Groß/klein egal nur für
 * A–Z; für Begriffe ohne Buchstaben außerhalb von ASCII mit zweiter
 * Schreibweise ist es genau.
 * @param {string} text
 * @returns {string}
 */
function searchLikePattern(text) {
  return `%${likeEscaped(text)}%`;
}

/**
 * Braucht der Begriff die Genauprüfung mit GLOB? Ja, sobald er einen
 * Buchstaben außerhalb von ASCII mit zweiter Schreibweise enthält.
 * @param {string} text
 * @returns {boolean}
 */
function needsGlobCheck(text) {
  return [...text].some(isFoldedNonAscii);
}

// Vorprüfung: höchstens so viele ausgeschriebene Schreibweisen (Durchläufe
// über den Text) …
const MAX_PROBE_VARIANTS = 4;
// … es sei denn, ein Abschnitt ohne solche Buchstaben hat mindestens so
// viele Buchstaben/Ziffern: Dann reicht ein LIKE über ihn.
const MIN_PLAIN_RUN = 3;
const ALPHANUMERIC = /[\p{L}\p{N}]/u;
const ASCII_LETTER = /[A-Za-z]/;

/** Alle Schreibweisen einer Zeichenfolge (Kreuzprodukt). */
function spellings(chars) {
  let all = [""];
  for (const char of chars) {
    const variants = isFoldedNonAscii(char) ? variantsOf(char) : [char];
    all = all.flatMap((prefix) => variants.map((v) => prefix + v));
  }
  return all;
}

/**
 * Vorprüfung „kann den Begriff enthalten" – trifft alles, was
 * {@link searchGlobPattern} trifft, aber nur durch billige Vergleiche:
 * - `like`: ein oder mehrere LIKE-Muster (ESCAPE '\'), verbunden mit OR;
 * - `instr`: eine oder mehrere Zeichenfolgen für instr(), verbunden mit OR.
 * `exact`: die Vorprüfung ist schon die ganze Prüfung (Begriff ohne
 * Buchstaben außerhalb von ASCII mit zweiter Schreibweise).
 * @param {string} text - eine Form des Begriffs (bzw. ihre JSON-Schreibweise)
 * @returns {{op: "like"|"instr", values: string[], exact: boolean}}
 */
function searchProbe(text) {
  const chars = [...text];
  if (!chars.some(isFoldedNonAscii))
    return { op: "like", values: [searchLikePattern(text)], exact: true };

  // Längster Abschnitt ohne Buchstaben mit zweiter Schreibweise außerhalb
  // von ASCII („Übung" → "bung").
  let run = [];
  let best = [];
  for (const char of [...chars, null]) {
    if (char !== null && !isFoldedNonAscii(char)) {
      run.push(char);
      continue;
    }
    const letters = (part) => part.filter((c) => ALPHANUMERIC.test(c)).length;
    if (letters(run) > letters(best)) best = run;
    run = [];
  }
  if (best.filter((c) => ALPHANUMERIC.test(c)).length >= MIN_PLAIN_RUN)
    return {
      op: "like",
      values: [searchLikePattern(best.join(""))],
      exact: false,
    };

  // Sonst das längste Fenster mit höchstens MAX_PROBE_VARIANTS
  // Schreibweisen; bei gleicher Länge das mit weniger Schreibweisen, dann
  // das vordere.
  const count = (char) =>
    isFoldedNonAscii(char) ? variantsOf(char).length : 1;
  let window = { start: 0, end: 1, product: count(chars[0]) };
  for (let start = 0; start < chars.length; start++) {
    let product = 1;
    for (let end = start; end < chars.length; end++) {
      product *= count(chars[end]);
      if (product > MAX_PROBE_VARIANTS) break;
      const length = end + 1 - start;
      const bestLength = window.end - window.start;
      if (
        length > bestLength ||
        (length === bestLength && product < window.product)
      )
        window = { start, end: end + 1, product };
    }
  }
  const part = chars.slice(window.start, window.end);
  // ASCII-Buchstaben: LIKE vergleicht sie ohne Groß/klein; instr() nicht.
  if (part.some((c) => ASCII_LETTER.test(c)))
    return {
      op: "like",
      values: spellings(part).map(searchLikePattern),
      exact: false,
    };
  return { op: "instr", values: spellings(part), exact: false };
}

/**
 * Ein Datenbankfehler für das Protokoll – ohne Meldungstext: Prisma nennt in
 * der Meldung die Abfrage, darin stehen die Suchmuster (Punkt 3).
 * @param {unknown} error
 * @returns {{name: string|null, code: string|null, dbCode: string|null}}
 */
function loggableError(error) {
  return {
    name: error?.name ?? null,
    code: error?.code ?? null,
    dbCode: error?.meta?.code ?? null,
  };
}

module.exports = {
  SEARCH_MAX_LENGTH,
  SEARCH_MAX_RAW_LENGTH,
  parseSearch,
  searchForms,
  jsonEscaped,
  searchGlobPattern,
  searchLikePattern,
  needsGlobCheck,
  searchProbe,
  loggableError,
};
