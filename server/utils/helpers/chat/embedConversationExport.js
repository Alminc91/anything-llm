// KIE-538 — Export der Konversationen eines Widgets als CSV oder JSON.
//
// Die Auswahl (welche Konversationen, in welcher Reihenfolge, mit welcher
// Nummer) trifft EmbedChats.conversationsForExport; hier entsteht daraus die
// Datei. Sie wird Stück für Stück erzeugt und geschrieben - eine Zeile bzw.
// eine Konversation nach der anderen, nie als Ganzes im Speicher.
//
// Spalten (CSV) bzw. Felder (JSON): Konversation (laufende Nummer wie in der
// Liste) · Konversations-ID · Nachricht (laufende Nummer in der Konversation)
// · Zeitpunkt · Frage · Antwort · Bewertung · Grund der negativen Bewertung ·
// Kommentar zur negativen Bewertung. Nicht enthalten sind IP-Adresse, Host,
// die Kennung der Browser-Sitzung und die Quellen-Texte der Antwort.
//
// CSV für deutsches Excel (öffnet per Doppelklick ohne Import-Dialog):
// UTF-8 mit BOM, Semikolon als Trenner, CRLF als Zeilenende, Zeitpunkte in
// Berliner Zeit. Textzellen stehen immer in Anführungszeichen (RFC 4180:
// " wird verdoppelt; Semikolon und Zeilenumbrüche bleiben in der Zelle),
// Zahlen und leere Zellen stehen ohne.
const { berlinFields, utcMs } = require("../billingWindow");

const CSV_BOM = "\uFEFF";
const CSV_DELIMITER = ";";
const CSV_EOL = "\r\n";
const CSV_HEADERS = [
  "Konversation",
  "Konversations-ID",
  "Nachricht",
  "Zeitpunkt",
  "Frage",
  "Antwort",
  "Bewertung",
  "Grund der negativen Bewertung",
  "Kommentar zur negativen Bewertung",
];

const EXPORT_FORMATS = {
  csv: { contentType: "text/csv; charset=utf-8", extension: "csv" },
  json: { contentType: "application/json; charset=utf-8", extension: "json" },
};

/**
 * Wanduhr-Felder eines Zeitpunkts in Berliner Zeit, zweistellig (Jahr
 * vierstellig), dazu der Versatz zu UTC in Minuten - über dieselben Helfer
 * wie das Abrechnungsfenster (billingWindow: ein Formatter, Jahre 0-99
 * richtig; Fixliste 7, F22).
 * @param {Date} instant
 */
function berlinParts(instant) {
  const f = berlinFields(instant);
  const pad = (value) => String(value).padStart(2, "0");
  const wallClock = utcMs(f.year, f.month, f.day, f.hour, f.minute, f.second);
  return {
    year: String(f.year).padStart(4, "0"),
    month: pad(f.month),
    day: pad(f.day),
    hour: pad(f.hour),
    minute: pad(f.minute),
    second: pad(f.second),
    offsetMinutes: Math.round(
      (wallClock - Math.floor(instant.getTime() / 1000) * 1000) / 60000
    ),
  };
}

/**
 * Zeitpunkt in Berliner Zeit, wie Excel ihn als Datum erkennt.
 * @param {Date} instant
 * @returns {string} - "TT.MM.JJJJ HH:MM:SS"; "" für einen ungültigen Zeitpunkt
 */
function formatBerlinDateTime(instant) {
  if (!(instant instanceof Date) || isNaN(instant.getTime())) return "";
  const p = berlinParts(instant);
  return `${p.day}.${p.month}.${p.year} ${p.hour}:${p.minute}:${p.second}`;
}

/**
 * Derselbe Zeitpunkt für die JSON-Datei: Berliner Wanduhrzeit mit Versatz zu
 * UTC (ISO 8601) - maschinenlesbar und auch in der doppelten Stunde der
 * Umstellung auf Winterzeit eindeutig.
 * @param {Date} instant
 * @returns {string|null} - z. B. "2026-09-01T08:30:00+02:00"
 */
function formatBerlinIso(instant) {
  if (!(instant instanceof Date) || isNaN(instant.getTime())) return null;
  const p = berlinParts(instant);
  const sign = p.offsetMinutes < 0 ? "-" : "+";
  const offset = Math.abs(p.offsetMinutes);
  const hh = String(Math.floor(offset / 60)).padStart(2, "0");
  const mm = String(offset % 60).padStart(2, "0");
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${sign}${hh}:${mm}`;
}

// Entschärfung von Formeln (CSV Injection): Eine Tabellenkalkulation wertet
// eine Zelle als Formel aus, wenn sie mit = + - oder @ beginnt; ein führender
// Tabulator oder Wagenrücklauf wird beim Einlesen verworfen und gibt den Blick
// auf ein solches Zeichen frei. Geprüft wird deshalb das erste Zeichen NACH
// führendem Leerraum: Manche Programme (und manche Importwege) schneiden
// Leerzeichen am Zellanfang ab, " =1+1" wäre danach eine Formel. Zum Leerraum
// zählen hier auch die unsichtbaren Zeichen ohne Breite, zu den Formelzeichen
// die Vollbreiten-Formen ＝ ＋ － ＠, die Excel in ostasiatischen
// Sprachumgebungen wie die schmalen behandelt.
// Entschärft wird mit einem vorangestellten Hochkomma (Empfehlung der OWASP):
// Die Zelle ist dann Text. Beim Öffnen einer CSV zeigt Excel das Hochkomma
// mit an - das trifft auch harmlose Zellen wie "- Punkt 1" oder "+49 …" und
// ist der Preis dafür, dass keine Formel ausgeführt wird.
const FORMULA_START =
  /^[\t\r]|^[\s\u00AD\u180E\u200B-\u200D\u2060]*[=+\-@\uFF1D\uFF0B\uFF0D\uFF20]/;
const DEFUSE_PREFIX = "'";

/**
 * @param {string} text
 * @returns {string} - der Text, bei Formelverdacht mit vorangestelltem Hochkomma
 */
function defuseCell(text) {
  return FORMULA_START.test(text) ? `${DEFUSE_PREFIX}${text}` : text;
}

/**
 * Eine Zelle der CSV: Zahlen ohne, Text immer in Anführungszeichen und
 * entschärft, null/undefined/"" als leere Zelle.
 * @param {string|number|null|undefined} value
 * @returns {string}
 */
function csvCell(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "number")
    return Number.isFinite(value) ? `${value}` : "";
  const text = String(value);
  if (text === "") return "";
  return `"${defuseCell(text).replace(/"/g, '""')}"`;
}

/**
 * @param {Array<string|number|null|undefined>} cells
 * @returns {string} - eine Zeile samt Zeilenende
 */
function csvRow(cells) {
  return cells.map(csvCell).join(CSV_DELIMITER) + CSV_EOL;
}

/** @returns {"positive"|"negative"|null} */
function ratingOf(message) {
  if (message.feedbackScore === true) return "positive";
  if (message.feedbackScore === false) return "negative";
  return null;
}

const RATING_LABELS = { positive: "positiv", negative: "negativ" };

/**
 * Die neun Zellen einer Nachricht. Grund und Kommentar gibt es nur zu einer
 * negativen Bewertung.
 * @param {ExportConversation} conversation
 * @param {ExportMessage} message
 * @param {number} index - Platz der Nachricht in der Konversation (ab 0)
 */
function csvCells(conversation, message, index) {
  const rating = ratingOf(message);
  const negative = rating === "negative";
  return [
    conversation.number,
    conversation.conversationId ?? "",
    index + 1,
    formatBerlinDateTime(message.createdAt),
    message.prompt ?? "",
    message.answer ?? "",
    rating ? RATING_LABELS[rating] : "",
    negative ? message.feedbackReason ?? "" : "",
    negative ? message.feedbackText ?? "" : "",
  ];
}

/**
 * Dieselben Felder für die JSON-Datei (ohne Entschärfung: JSON wird nicht
 * von einer Tabellenkalkulation ausgewertet).
 * @param {ExportConversation} conversation
 */
function jsonConversation(conversation) {
  return {
    conversation: conversation.number,
    conversationId: conversation.conversationId ?? null,
    messages: conversation.messages.map((message, index) => {
      const rating = ratingOf(message);
      const negative = rating === "negative";
      return {
        message: index + 1,
        timestamp: formatBerlinIso(message.createdAt),
        prompt: message.prompt ?? "",
        response: message.answer ?? "",
        rating,
        ratingReason: negative ? message.feedbackReason ?? null : null,
        ratingComment: negative ? message.feedbackText ?? null : null,
      };
    }),
  };
}

/**
 * @typedef {Object} ExportMessage
 * @property {Date} createdAt
 * @property {string} prompt
 * @property {string|null} answer - Text der Antwort, ohne Quellen
 * @property {boolean|null} feedbackScore
 * @property {string|null} feedbackReason
 * @property {string|null} feedbackText
 *
 * @typedef {Object} ExportConversation
 * @property {number} number - laufende Nummer wie in der Liste
 * @property {string|null} conversationId - null, wenn die Konversation keine eigene Kennung hat
 * @property {ExportMessage[]} messages - nach Zeitpunkt
 */

/**
 * Die Datei als Folge von Textstücken. CSV: Kopfzeile, dann je Konversation
 * ein Stück mit ihren Zeilen (Fixliste 7, F29: nicht je Nachricht ein
 * eigenes write). JSON: eine Liste von Konversationen, je Konversation ein
 * Stück.
 *
 * `stats` zählt, was geschrieben ist - in beiden Formaten gleich
 * (Fixliste 7, F16): Ein Stück zählt erst, wenn `written()` nach seinem
 * write aufgerufen wird ({@link writeChunks}). Bricht der Empfänger ab,
 * nennt das Protokoll so genau die ausgelieferten Konversationen und
 * Zeilen - weder das zuletzt erzeugte, aber nicht mehr geschriebene Stück
 * noch eines zu wenig.
 * @param {"csv"|"json"} format
 * @param {AsyncIterable<ExportConversation>} conversations
 * @returns {{contentType: string, extension: string, stats: {conversations: number, rows: number}, chunks: AsyncGenerator<string>, written: () => void}}
 */
function conversationExport(format, conversations) {
  if (!Object.prototype.hasOwnProperty.call(EXPORT_FORMATS, format))
    throw new Error(`Invalid export format: ${format}`);
  const stats = { conversations: 0, rows: 0 };
  // Was das zuletzt erzeugte Stück enthält - gezählt erst nach dem write.
  let pending = null;
  const chunk = (text, conversation = null) => {
    pending = conversation
      ? { conversations: 1, rows: conversation.messages.length }
      : null;
    return text;
  };

  async function* csvChunks() {
    yield chunk(CSV_BOM + csvRow(CSV_HEADERS));
    for await (const conversation of conversations) {
      const rows = conversation.messages.map((message, index) =>
        csvRow(csvCells(conversation, message, index))
      );
      yield chunk(rows.join(""), conversation);
    }
  }

  async function* jsonChunks() {
    yield chunk("[");
    let produced = 0;
    for await (const conversation of conversations) {
      const text = JSON.stringify(jsonConversation(conversation), null, 2);
      // Eingerückt wird nur nach "\n": Ein roher Zeilenvorschub kommt in
      // einer JSON-Zeichenkette nicht vor, das Einrücken verändert also
      // keinen Wert. U+2028 und U+2029 gibt JSON.stringify dagegen
      // unmaskiert aus - für /^/m wären auch sie ein Zeilenanfang.
      yield chunk(
        `${produced === 0 ? "\n" : ",\n"}  ${text.replace(/\n/g, "\n  ")}`,
        conversation
      );
      produced += 1;
    }
    yield chunk(produced === 0 ? "]\n" : "\n]\n");
  }

  return {
    ...EXPORT_FORMATS[format],
    stats,
    chunks: format === "csv" ? csvChunks() : jsonChunks(),
    written: () => {
      if (pending) {
        stats.conversations += pending.conversations;
        stats.rows += pending.rows;
      }
      pending = null;
    },
  };
}

/**
 * Liest das erste Element eines asynchronen Iterators sofort und liefert
 * danach die ganze Folge. Scheitert schon der erste Zugriff (Datenbank), fällt
 * der Fehler hier an - bevor die Antwort begonnen hat.
 * @template T
 * @param {AsyncIterator<T>} iterator
 * @returns {Promise<AsyncGenerator<T>>}
 */
async function primed(iterator) {
  let step = await iterator.next();
  return (async function* () {
    try {
      while (!step.done) {
        yield step.value;
        step = await iterator.next();
      }
    } finally {
      await iterator.return?.();
    }
  })();
}

/**
 * Wartet, bis die Antwort wieder Daten annimmt. Endet die Verbindung vorher,
 * wird nicht weiter gewartet.
 * @param {import("http").ServerResponse} response
 * @returns {Promise<boolean>} - false, wenn die Verbindung geschlossen wurde
 */
function drained(response) {
  return new Promise((resolve) => {
    const settle = (open) => () => {
      response.off("drain", onDrain);
      response.off("close", onClose);
      response.off("error", onClose);
      resolve(open);
    };
    const onDrain = settle(true);
    const onClose = settle(false);
    response.once("drain", onDrain);
    response.once("close", onClose);
    response.once("error", onClose);
  });
}

/**
 * Schreibt die Stücke nacheinander in die Antwort und wartet, wenn der
 * Empfänger nicht nachkommt - der Server puffert so höchstens ein Stück mehr,
 * als die Verbindung gerade abnimmt.
 * @param {import("http").ServerResponse} response
 * @param {AsyncIterable<string>} chunks
 * @param {() => void} [onWritten] - nach jedem geschriebenen Stück (Zählung
 *   des Exports, `written` aus {@link conversationExport})
 * @returns {Promise<boolean>} - true, wenn alles geschrieben wurde; false, wenn der Empfänger die Verbindung vorher beendet hat
 */
async function writeChunks(response, chunks, onWritten = () => {}) {
  const closed = () => response.destroyed || response.writableEnded;
  const iterator = chunks[Symbol.asyncIterator]();
  try {
    for (;;) {
      // Vor dem Lesen: Nach einem Abbruch entsteht kein weiteres Stück (und
      // keine weitere Abfrage an die Datenbank) …
      if (closed()) return false;
      const step = await iterator.next();
      // … und danach noch einmal: Die Verbindung kann während des Lesens
      // geendet haben, auf „drain" würde dann vergeblich gewartet.
      if (closed()) return false;
      if (step.done) return true;
      const accepted = response.write(step.value);
      // Übergeben ist übergeben: Auch wenn der Puffer voll ist, liefert die
      // Verbindung das Stück noch aus.
      onWritten();
      if (accepted === false && !(await drained(response))) return false;
    }
  } finally {
    await iterator.return?.();
  }
}

/**
 * Macht einen Namen dateinamenssicher: Umlaute ausgeschrieben, Akzente
 * entfernt, alles außer Buchstaben und Ziffern wird zu einem Bindestrich.
 * @param {*} name
 * @param {number} [maxLength]
 * @returns {string} - nur a-z, 0-9 und "-"; "" wenn nichts übrig bleibt
 */
function fileNameSlug(name, maxLength = 60) {
  return String(name ?? "")
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/Ä/g, "Ae")
    .replace(/Ö/g, "Oe")
    .replace(/Ü/g, "Ue")
    .replace(/ß/g, "ss")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, maxLength)
    .replace(/^-+|-+$/g, "");
}

/**
 * Dateiname eines Exports: konversationen_<widget>_<von>_<bis>.<endung>,
 * z. B. konversationen_vhs-musterstadt-3_2026-09-01_2026-09-30.csv.
 * <widget> ist der Name des Workspaces und die Nummer des Widgets; ohne
 * Zeitraum steht "gesamt", mit nur einer Grenze "ab-<tag>" bzw. "bis-<tag>".
 * Das Ergebnis enthält nur a-z, 0-9, "-", "_" und "." - es kann unverändert
 * in den Content-Disposition-Header.
 * @param {Object} file
 * @param {number} file.embedId
 * @param {string|null} [file.workspaceName]
 * @param {string|null} [file.fromDay] - "YYYY-MM-DD"
 * @param {string|null} [file.toDay] - "YYYY-MM-DD"
 * @param {string} file.extension
 * @returns {string}
 */
function exportFileName({
  embedId,
  workspaceName = null,
  fromDay = null,
  toDay = null,
  extension,
}) {
  const id = fileNameSlug(embedId);
  const widget = [fileNameSlug(workspaceName) || "widget", id]
    .filter(Boolean)
    .join("-");
  const day = (value) => fileNameSlug(value, 10);
  const period =
    fromDay && toDay
      ? `${day(fromDay)}_${day(toDay)}`
      : fromDay
        ? `ab-${day(fromDay)}`
        : toDay
          ? `bis-${day(toDay)}`
          : "gesamt";
  return `konversationen_${widget}_${period}.${fileNameSlug(extension)}`;
}

module.exports = {
  CSV_BOM,
  CSV_DELIMITER,
  CSV_EOL,
  CSV_HEADERS,
  EXPORT_FORMATS,
  formatBerlinDateTime,
  formatBerlinIso,
  defuseCell,
  csvCell,
  csvRow,
  conversationExport,
  primed,
  writeChunks,
  fileNameSlug,
  exportFileName,
};
