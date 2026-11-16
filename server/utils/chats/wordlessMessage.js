// Antwortsprache bei Nachrichten ohne Wörter (sprache-nur-nummer, FE-7).
//
// Besteht die Widget-Nachricht nur aus Kursnummern, Ziffern, Satzzeichen
// oder Emojis, findet das Modell keine Sprache und rät (Flotte 16.11.2026:
// 31 % der ersten Nachrichten dieser Art englisch beantwortet). Dann legt
// der Server die Antwortsprache fest: Sprache der früheren Nachrichten des
// Besuchers, ohne solche Deutsch. Der Hinweis hängt nur am Ende des
// System-Prompts (embed.js embedSystemPrompt); Nachricht, Verlauf, Suche und
// Query Rewriter bleiben unverändert. Jede Nachricht mit Wörtern bekommt nie
// einen Hinweis, ihr System-Prompt bleibt byte-gleich.

const LETTER = /\p{L}/u;
// Ziffer = 0 bis 9 (Kursnummern der Kunden). Arabisch-indische und
// persische Ziffern zählen nicht: Sie sind selbst ein Hinweis auf die
// Sprache, eine Nachricht nur aus ihnen bekommt keinen Hinweis (wie heute).
const DIGIT = /[0-9]/;
const WHITESPACE = /\s+/u;
// Schriften ohne Wortabstände (D3, 16.11.2026): Chinesisch, Japanisch,
// Koreanisch (oft ohne Leerraum vor der Nummer), Thai, Lao, Khmer, Birmanisch.
// Dort klebt die Kursnummer am Satz („我想报名XI41050“). Kursnummern der
// Kunden enthalten solche Zeichen nie.
const SCRIPT_WITHOUT_SPACES =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;
// Mindestens 4 Buchstaben am Stück (D3): „course123“, „Kurs123“, „Курс123“.
// Kursnummern haben höchstens 3 Buchstaben am Stück (XI41050, TM3000,
// 26W1001, H350125, 4M14); „abc123“ bleibt ohne Wort.
const FOUR_LETTERS_IN_A_ROW = /\p{L}{4}/u;

/**
 * Wort (Spezifikation Abschnitt 4 mit D3): ein durch Leerraum getrenntes
 * Stück, das nach Abschneiden von Satzzeichen am Rand mindestens einen
 * Buchstaben (Unicode \p{L}, alle Schriften) enthält und für das eines gilt:
 *  1. keine Ziffer 0 bis 9,
 *  2. ein Zeichen einer Schrift ohne Wortabstände (SCRIPT_WITHOUT_SPACES),
 *  3. mindestens 4 Buchstaben am Stück.
 * 2 und 3 machen die Erkennung nur enger: Im Zweifel gilt ein Stück als
 * Wort, und die Nachricht bekommt keinen Hinweis (Verhalten von heute).
 * Geprüft wird das ganze Stück, ohne eigenes Abschneiden: Satzzeichen sind
 * weder Buchstabe noch Ziffer, und am Rand verlängern oder unterbrechen sie
 * keine Buchstabenfolge. Einzige Ausnahme sind Satzzeichen, die selbst zu
 * einer der Schriften ohne Wortabstände gehören (Khmer ។, Birmanisch ။,
 * Thai ๚): „XI41050။“ gilt als Wort, weil das Zeichen die Schrift des
 * Besuchers zeigt. Auch das macht die Erkennung nur enger.
 * @param {string} piece
 * @returns {boolean}
 */
function isWord(piece) {
  if (!LETTER.test(piece)) return false;
  return (
    !DIGIT.test(piece) ||
    SCRIPT_WITHOUT_SPACES.test(piece) ||
    FOUR_LETTERS_IN_A_ROW.test(piece)
  );
}

/**
 * Enthält die Nachricht mindestens ein Wort?
 * @param {unknown} message
 * @returns {boolean} false für alles, was kein Text ist
 */
function hasWords(message) {
  if (typeof message !== "string") return false;
  return message.split(WHITESPACE).some(isWord);
}

/**
 * Nachricht ohne Wörter (Abschnitt 4): mindestens eine Ziffer und kein Wort,
 * z. B. "XI41050", "26W1001, 26W1002", "12.12.", "😀 123". Nicht: "Kurs
 * XI41050", "Nr. 123", "课程 123" (Wörter) und "Ok", "?", "😀" (keine Ziffer).
 * @param {unknown} message
 * @returns {boolean}
 */
function isWordlessMessage(message) {
  if (typeof message !== "string") return false;
  return DIGIT.test(message) && !hasWords(message);
}

/**
 * Antwortsprache für den System-Prompt.
 * @param {unknown} message aktuelle Nachricht des Besuchers
 * @param {unknown[]} [previousMessages] frühere Nachrichten des Besuchers in
 *   dieser Unterhaltung (Verlauf, den embed.js ohnehin lädt); nur Nachrichten
 *   mit Wörtern zählen
 * @returns {"german"|"previous"|null} null: Nachricht mit Wörtern oder ohne
 *   Ziffer, kein Hinweis; "previous": Sprache der früheren Nachrichten;
 *   "german": keine frühere Nachricht mit Wörtern
 */
function wordlessResponseLanguage(message, previousMessages = []) {
  if (!isWordlessMessage(message)) return null;
  const previous = Array.isArray(previousMessages) ? previousMessages : [];
  return previous.some(hasWords) ? "previous" : "german";
}

// Feste Hinweise an das Modell, englisch wie die übrigen Hinweise in
// embed.js; Überschrift im Stil von DISCLAIMER_PROMPT_NOTE. Der Basis-Prompt
// sagt schon „Use German only if no other language is identifiable“ (v3.4,
// Short-Query Language Detection); der Hinweis setzt das durch.
const REASON =
  "The user's latest message contains no words, only numbers or symbols (e.g. a course number), so its language cannot be detected.";
const RESPONSE_LANGUAGE_NOTES = Object.freeze({
  german: `\n\n### Response Language (ACTIVE)\n${REASON} Answer in German, including the follow-up questions.`,
  previous: `\n\n### Response Language (ACTIVE)\n${REASON} Answer in the language of the user's earlier messages in this conversation, including the follow-up questions.`,
});

/**
 * Text des Hinweises. Nur die zwei festen Werte ergeben einen Text, alles
 * andere "" (kein fremder Text im System-Prompt).
 * @param {unknown} responseLanguage Ergebnis von wordlessResponseLanguage
 * @returns {string}
 */
function responseLanguageNote(responseLanguage) {
  if (responseLanguage === "german") return RESPONSE_LANGUAGE_NOTES.german;
  if (responseLanguage === "previous") return RESPONSE_LANGUAGE_NOTES.previous;
  return "";
}

module.exports = {
  hasWords,
  isWordlessMessage,
  wordlessResponseLanguage,
  responseLanguageNote,
  RESPONSE_LANGUAGE_NOTES,
};
