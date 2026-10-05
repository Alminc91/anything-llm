// Kurskarten v2 (opt-in, visual_config.courseCards = "auto"): Karten-Marker.
//
// Im Prompt-Abschnitt "Course Cards Mode" kündigt der Bot die empfohlenen
// Kurse in der ERSTEN Zeile seiner Antwort an:
//   [[KARTEN: 0, 2, 3]]   -> Nummern der Kontextblöcke [CONTEXT n] (0-basiert)
//   [[KARTEN: -]]         -> keine Kurse
// Der Server puffert den Antwortanfang, bis die Markerzeile abgeschlossen ist
// (oder klar ist, dass keine kommt), entfernt den Marker aus dem Text an das
// Widget und aus der gespeicherten Antwort und schickt die angekündigten
// Kurse sofort als eigenen Chunk { type: "courseSources" } — so stehen die
// Karten im Widget, bevor der Text kommt.
//
// Entscheidungsregeln (parseCardsMarker):
//   - Antwort beginnt (nach Leerraum) nicht mit "[[KARTEN:" -> kein Marker,
//     Text unverändert (Entscheidung meist schon beim ersten Token).
//   - "[[KARTEN: … ]]" vor dem ersten Zeilenende -> Marker; Inhalt "-" oder
//     Zahlenliste = gültig, sonst kaputt (Marker wird trotzdem entfernt,
//     keine Karten).
//   - Zeilenende vor "]]" -> kaputte Markerzeile, wird entfernt.
//   - Marker muss innerhalb der ersten CARDS_MARKER_BUFFER_MAX Zeichen
//     (nach Leerraum) schließen bzw. die Zeile enden; sonst zu lang, gilt als
//     kein Marker; Text bleibt unverändert (nichts geht verloren, das Widget
//     entfernt einen späteren Marker zusätzlich). Dieselbe Grenze gilt für
//     Stream-Filter und stripCardsMarker — beide entscheiden immer gleich.
//
// Damit Folgefragen den Marker im Verlauf sehen (kleine Modelle lassen ihn
// sonst weg), wird die angekündigte Nummernliste als courseCardsMarker in der
// Antwort-JSON gespeichert und nur für den LLM-Verlauf wieder als erste Zeile
// vorangestellt (restoreCardsMarkers), nie in /history an das Widget.

const { writeResponseChunk } = require("../helpers/chat/responses");
const { safeJsonParse } = require("../http");

const CARDS_MARKER_TAG = "[[KARTEN:";
// Obergrenze (Zeichen ab Markeranfang) bis "]]" bzw. Zeilenende — einzige
// Quelle der Wahrheit für Puffer und Stripping.
const CARDS_MARKER_BUFFER_MAX = 120;
// Nummern 0–999 (höchstens drei Ziffern), durch Kommas getrennt
const INDEX_LIST_RX = /^\d{1,3}(?:\s*,\s*\d{1,3})*$/;

const PENDING = Object.freeze({ state: "pending" });
const NONE = Object.freeze({ state: "none" });

/**
 * Inhalt zwischen "[[KARTEN:" und "]]" -> Nummern (dedupliziert, Reihenfolge
 * bleibt), [] für "-", null für kaputt.
 * @param {string} content
 * @returns {number[]|null}
 */
function parseMarkerIndices(content) {
  const text = String(content ?? "").trim();
  if (text === "-") return [];
  if (!INDEX_LIST_RX.test(text)) return null;
  const out = [];
  for (const part of text.split(",")) {
    const n = Number(part.trim());
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

/**
 * Marker am Antwortanfang erkennen.
 * @param {string} text - bisher empfangener Antwortanfang
 * @param {{final?: boolean}} [options] - final: Antwort ist vollständig
 * @returns {{state: "pending"|"none"|"marker", indices?: number[]|null, valid?: boolean, end?: number}}
 *   end = Position direkt hinter dem Marker (bzw. hinter der kaputten Zeile)
 */
function parseCardsMarker(text, { final = false } = {}) {
  const s = typeof text === "string" ? text : "";
  const lead = s.length - s.trimStart().length;
  const body = s.slice(lead);
  if (body.length === 0) return final ? NONE : PENDING;
  const head = body.slice(0, CARDS_MARKER_TAG.length).toUpperCase();
  if (!CARDS_MARKER_TAG.startsWith(head)) return NONE;
  if (body.length < CARDS_MARKER_TAG.length) return final ? NONE : PENDING;

  // Nur das Fenster der ersten CARDS_MARKER_BUFFER_MAX Zeichen zählt: "]]"
  // bzw. Zeilenende müssen vollständig darin liegen. So ist die Entscheidung
  // für einen Antwortanfang dieselbe wie für die ganze Antwort.
  const win = body.slice(0, CARDS_MARKER_BUFFER_MAX);
  const close = win.indexOf("]]");
  const newline = win.indexOf("\n");
  if (close !== -1 && (newline === -1 || close < newline)) {
    const indices = parseMarkerIndices(
      body.slice(CARDS_MARKER_TAG.length, close)
    );
    return {
      state: "marker",
      indices,
      valid: indices !== null,
      end: lead + close + 2,
    };
  }
  if (newline !== -1)
    return {
      state: "marker",
      indices: null,
      valid: false,
      end: lead + newline + 1,
    };
  if (body.length >= CARDS_MARKER_BUFFER_MAX) return NONE;
  return final ? NONE : PENDING;
}

/**
 * Marker (gültig oder kaputt) vom Anfang einer vollständigen Antwort
 * entfernen, inkl. des Leerraums dahinter. Sonst Text unverändert.
 * @param {string} text
 * @returns {string}
 */
function stripCardsMarker(text) {
  if (typeof text !== "string") return text;
  const result = parseCardsMarker(text, { final: true });
  return result.state === "marker" ? text.slice(result.end).trimStart() : text;
}

/**
 * Zustandsbehafteter Filter für den Token-Strom: puffert den Anfang, bis die
 * Marker-Entscheidung fällt, und entfernt danach den Leerraum hinter dem
 * Marker bis zum ersten sichtbaren Zeichen.
 */
class CardsMarkerFilter {
  constructor() {
    this.buffer = "";
    this.decided = false;
    this.stripLeading = false;
    this.marker = null; // { indices: number[], valid: boolean }
  }

  #afterMarker(text) {
    if (!this.stripLeading) return text;
    const rest = text.replace(/^\s+/, "");
    if (rest.length > 0) this.stripLeading = false;
    return rest;
  }

  /**
   * @param {string} token
   * @param {{final?: boolean}} [options]
   * @returns {{text: string, marker?: {indices: number[], valid: boolean}}}
   *   text = jetzt an das Widget zu sendender Text ("" = noch puffern)
   */
  push(token, { final = false } = {}) {
    const piece = typeof token === "string" ? token : "";
    if (this.decided) return { text: this.#afterMarker(piece) };
    this.buffer += piece;
    const result = parseCardsMarker(this.buffer, { final });
    if (result.state === "pending") return { text: "" };
    this.decided = true;
    const buffered = this.buffer;
    this.buffer = "";
    if (result.state === "none") return { text: buffered };
    this.stripLeading = true;
    this.marker = { indices: result.indices ?? [], valid: result.valid };
    return {
      text: this.#afterMarker(buffered.slice(result.end)),
      marker: this.marker,
    };
  }
}

// "data: {json}\n\n" (writeResponseChunk) -> Objekt, sonst null
function parseSseChunk(raw) {
  if (typeof raw !== "string" || !raw.startsWith("data: ")) return null;
  const data = safeJsonParse(raw.slice(6), null);
  return data && typeof data === "object" ? data : null;
}

/**
 * Response-Hülle für den Embed-Stream: Die Provider-Stream-Handler schreiben
 * unverändert per writeResponseChunk -> response.write. Text-Chunks laufen
 * durch den CardsMarkerFilter; alle Schreibvorgänge gehen in Reihenfolge
 * über eine Warteschlange, damit der (asynchrone) courseSources-Chunk vor dem
 * Text hinter dem Marker ankommt. Alles andere (on/removeListener/locals …)
 * geht direkt an die echte Response — Abbruch und Kontingent unverändert.
 * @param {import("express").Response} response
 * @param {{onMarker: (marker: {indices: number[], valid: boolean}) => (void|Promise<void>)}} options
 * @returns {{response: import("express").Response, done: () => Promise<void>, filter: CardsMarkerFilter}}
 */
function createCardsMarkerResponse(response, { onMarker } = {}) {
  const filter = new CardsMarkerFilter();
  let queue = Promise.resolve();
  const later = (fn) => {
    queue = queue.then(fn).catch((e) => {
      console.error("[cardsMarker]", e.message);
    });
  };

  const write = (raw, ...rest) => {
    const data = parseSseChunk(raw);
    if (!data || data.type !== "textResponseChunk") {
      later(() => response.write(raw, ...rest));
      return true;
    }
    const final = data.close === true;
    const { text, marker } = filter.push(data.textResponse ?? "", { final });
    if (marker && typeof onMarker === "function") later(() => onMarker(marker));
    if (text.length > 0 || final)
      later(() =>
        writeResponseChunk(response, { ...data, textResponse: text })
      );
    return true;
  };

  const proxy = new Proxy(response, {
    get(target, prop) {
      if (prop === "write") return write;
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  return { response: proxy, done: () => queue, filter };
}

/**
 * Gespeicherte Nummernliste (courseCardsMarker) einer Antwort-JSON prüfen:
 * [] = Marker war da, leer ("[[KARTEN: -]]"); Liste = nur ganze Zahlen
 * 0–999, dedupliziert; null = kein (gültiger) Marker gespeichert.
 * @param {any} value
 * @returns {number[]|null}
 */
function storedMarkerIndices(value) {
  if (!Array.isArray(value)) return null;
  if (value.length === 0) return [];
  if (!value.every((n) => Number.isInteger(n))) return null;
  return parseMarkerIndices(value.join(","));
}

/**
 * Markerzeile für eine gespeicherte Nummernliste: "[[KARTEN: 0, 2]]",
 * leere Liste -> "[[KARTEN: -]]", kein Marker -> "".
 * @param {any} indices
 * @returns {string}
 */
function cardsMarkerLine(indices) {
  const list = storedMarkerIndices(indices);
  if (list === null) return "";
  return `${CARDS_MARKER_TAG} ${list.length > 0 ? list.join(", ") : "-"}]]`;
}

/**
 * Nur für den LLM-Verlauf (recentEmbedChatHistory): stellt den Marker, den
 * der Bot in einer früheren Antwort gesendet hat (Antwort-JSON
 * courseCardsMarker), wieder als erste Zeile vor den gespeicherten Text —
 * auch "[[KARTEN: -]]" (courseCardsMarker: []), damit jede frühere Antwort
 * einen Marker zeigt. Die Datensätze werden kopiert, nie verändert; ohne
 * gespeicherten Marker (Feld fehlt/null) unverändert.
 * Nie für /history an das Widget verwenden.
 * @param {object[]} rawHistory - embed_chats-Zeilen (response = JSON-String)
 * @returns {object[]}
 */
function restoreCardsMarkers(rawHistory = []) {
  if (!Array.isArray(rawHistory)) return [];
  return rawHistory.map((record) => {
    const data = safeJsonParse(record?.response, null);
    if (!data || typeof data !== "object" || typeof data.text !== "string")
      return record;
    const line = cardsMarkerLine(data.courseCardsMarker);
    if (!line) return record;
    return {
      ...record,
      response: JSON.stringify({ ...data, text: `${line}\n${data.text}` }),
    };
  });
}

module.exports = {
  parseCardsMarker,
  stripCardsMarker,
  createCardsMarkerResponse,
  storedMarkerIndices,
  restoreCardsMarkers,
  // nur für Tests
  __test__: {
    CARDS_MARKER_TAG,
    CARDS_MARKER_BUFFER_MAX,
    parseMarkerIndices,
    cardsMarkerLine,
    CardsMarkerFilter,
  },
};
