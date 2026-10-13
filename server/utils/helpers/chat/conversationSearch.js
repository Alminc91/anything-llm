// Suche in der Konversationsliste der Auswertung (Konversationen-Ansicht):
// Groß- und Kleinschreibung egal, auch bei Umlauten.
//
// SQLite kann das nicht allein: lower(), upper() und LIKE kennen nur die
// ASCII-Buchstaben ("Ü" LIKE "ü" ist falsch). Deshalb zwei Muster aus einem
// Begriff, beide als gebundene Werte, nie im SQL-Text:
//
// - LIKE-Muster (searchLikePattern): schnell (SQLite sucht das erste feste
//   Zeichen und vergleicht erst dort), Groß/klein egal für A–Z. Jeder Buchstabe
//   außerhalb von ASCII, der eine zweite Schreibweise hat (ü/Ü, ß/ẞ, é/É …),
//   steht dort als "_" (genau ein beliebiges Zeichen). "%", "_" und "\" sind
//   mit "\" maskiert (ESCAPE '\') und gelten wörtlich. Für Begriffe ohne
//   solche Buchstaben ist LIKE allein schon genau.
// - GLOB-Muster (searchGlobPattern): genau, aber langsam - jeder Buchstabe als
//   Zeichenklasse aus seinen Schreibweisen ("übung" → "*[üÜ][bB][uU][nN][gG]*");
//   *, ? und [ als Klasse aus sich selbst. Es prüft nur noch, was LIKE schon
//   durchgelassen hat, und nur, wenn der Begriff solche Buchstaben enthält
//   (needsGlobCheck).
//
// GLOB und LIKE vergleichen Zeichen für Zeichen (UTF-8), ohne Kollation.

/** Längster zulässiger Suchbegriff (Zeichen nach dem Trimmen). */
const SEARCH_MAX_LENGTH = 200;

/**
 * Der Suchbegriff einer Anfrage: getrimmt, in NFC (ein „ü" ist ein Zeichen,
 * wie in den gespeicherten Texten). Leer → keine Suche.
 * @param {unknown} value - Feld `q` des Rumpfs
 * @returns {{search: string|null, error: string|null}}
 */
function parseSearch(value) {
  if (value === undefined || value === null)
    return { search: null, error: null };
  if (typeof value !== "string")
    return { search: null, error: "q must be a string." };
  const search = value.normalize("NFC").trim();
  if (search === "") return { search: null, error: null };
  if ([...search].length > SEARCH_MAX_LENGTH)
    return {
      search: null,
      error: `q must not be longer than ${SEARCH_MAX_LENGTH} characters.`,
    };
  return { search, error: null };
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
 * @param {string} search - Ergebnis von parseSearch
 * @returns {string}
 */
function searchGlobPattern(search) {
  let pattern = "*";
  for (const char of search) {
    const variants = variantsOf(char);
    if (variants.length > 1) pattern += `[${variants.join("")}]`;
    else if (GLOB_SPECIAL.has(char)) pattern += `[${char}]`;
    else pattern += char;
  }
  return `${pattern}*`;
}

/** Buchstabe außerhalb von ASCII mit einer zweiten Schreibweise (ü, ß, é …)? */
function isFoldedNonAscii(char) {
  return char.codePointAt(0) > 0x7f && variantsOf(char).length > 1;
}

/**
 * LIKE-Muster „enthält den Begriff" (mit ESCAPE '\\'), Vorprüfung zu
 * {@link searchGlobPattern}: trifft alles, was das GLOB-Muster trifft.
 * @param {string} search - Ergebnis von parseSearch
 * @returns {string}
 */
function searchLikePattern(search) {
  let pattern = "%";
  for (const char of search) {
    if (char === "%" || char === "_" || char === "\\") pattern += `\\${char}`;
    else if (isFoldedNonAscii(char)) pattern += "_";
    else pattern += char;
  }
  return `${pattern}%`;
}

/**
 * Reicht LIKE allein? Nur, wenn der Begriff keinen Buchstaben außerhalb von
 * ASCII mit zweiter Schreibweise enthält - sonst prüft GLOB nach.
 * @param {string} search
 * @returns {boolean}
 */
function needsGlobCheck(search) {
  return [...search].some(isFoldedNonAscii);
}

/**
 * Darf der Treffer im gespeicherten Antwort-JSON vorgeprüft werden? Der Text
 * einer JSON-Antwort steht dort wörtlich – außer Zeichen, die JSON.stringify
 * maskiert (Anführungszeichen, Rückstrich, Steuerzeichen). Enthält der Begriff
 * keines davon, kann er im Text nur stehen, wenn er auch in der ganzen
 * Spalte steht: Die billige Prüfung der Spalte erspart dann das Auslesen des
 * JSON für fast alle Zeilen.
 * @param {string} search
 * @returns {boolean}
 */
function canPrefilterRawResponse(search) {
  // eslint-disable-next-line no-control-regex
  return !/["\\\u0000-\u001f\u007f]/.test(search);
}

module.exports = {
  SEARCH_MAX_LENGTH,
  parseSearch,
  searchGlobPattern,
  searchLikePattern,
  needsGlobCheck,
  canPrefilterRawResponse,
};
