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
//
// Kurskarten v3 — KI-Teaser: Direkt nach der Markerzeile darf je angekündig-
// tem Kurs eine Zeile "[[TEASER n: <15–20 Wörter>]]" folgen (n = Nummer aus
// dem Marker). Nach dem Marker-Abschluss (Karten gehen sofort raus) puffert
// der Filter diese Zeilen (parseTeaserLines), entfernt sie aus dem Text und
// meldet sie gesammelt (onTeasers), sobald zu jeder Marker-Nummer eine Zeile
// da ist — spätestens beim ersten Zeichen, das keine Teaserzeile beginnt.
// Grenzen: je Zeile TEASER_LINE_MAX Zeichen bis "]]" (vor dem Zeilenende),
// höchstens TEASER_LINES_MAX Zeilen. Kaputte/überlange Zeilen und alles
// danach gehen unverändert als Text durch (kein Datenverlust). Gespeichert
// werden die angenommenen Zeilen als courseTeaserLines (nur LLM-Verlauf).

const { writeResponseChunk } = require("../helpers/chat/responses");
const { safeJsonParse } = require("../http");
const { cleanTeaserText } = require("./embedCourseSources");

const CARDS_MARKER_TAG = "[[KARTEN:";
// Obergrenze (Zeichen ab Markeranfang) bis "]]" bzw. Zeilenende — einzige
// Quelle der Wahrheit für Puffer und Stripping.
const CARDS_MARKER_BUFFER_MAX = 120;
// Nummern 0–999 (höchstens drei Ziffern), durch Kommas getrennt
const INDEX_LIST_RX = /^\d{1,3}(?:\s*,\s*\d{1,3})*$/;

// Kurskarten v3: Teaserzeilen direkt nach dem Marker
const TEASER_TAG = "[[TEASER";
// Obergrenze je Teaserzeile (Zeichen ab Zeilenanfang) bis "]]"
const TEASER_LINE_MAX = 240;
// höchstens so viele Teaserzeilen; weitere gehen als Text durch
const TEASER_LINES_MAX = 5;
const TEASER_LINE_RX =
  /^\[\[TEASER[ \t]*(\d{1,3})[ \t]*:[ \t]*([^\n]*?)[ \t]*\]\]$/i;

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
 * Kurskarten v3: Teaserzeilen am Anfang des Texts hinter dem Marker
 * erkennen. Leerraum vor/zwischen den Zeilen wird übersprungen.
 *   - Zeile beginnt nicht mit "[[TEASER" -> fertig (Text ab hier).
 *   - "[[TEASER n: …]]" vor dem Zeilenende und innerhalb TEASER_LINE_MAX
 *     Zeichen -> Teaserzeile (entfernt); weiter mit der nächsten Zeile.
 *   - kaputt (Zeilenende vor "]]", zu lang, Format falsch) oder schon
 *     TEASER_LINES_MAX Zeilen -> fertig, die Zeile bleibt Text.
 * @param {string} text - Text direkt hinter dem Marker
 * @param {{final?: boolean}} [options] - final: Antwort ist vollständig
 * @returns {{state: "pending"|"done", lines: {index: number, text: string}[], end?: number}}
 *   end (nur "done") = Position, ab der normaler Text beginnt
 */
function parseTeaserLines(text, { final = false } = {}) {
  const s = typeof text === "string" ? text : "";
  const lines = [];
  const done = (end) => ({ state: "done", lines, end });
  const pending = () => ({ state: "pending", lines });
  let pos = 0;
  for (;;) {
    let p = pos;
    while (p < s.length && /\s/.test(s[p])) p++;
    const rest = s.slice(p);
    if (rest.length === 0) return final ? done(s.length) : pending();
    const head = rest.slice(0, TEASER_TAG.length).toUpperCase();
    if (!TEASER_TAG.startsWith(head)) return done(p);
    if (rest.length < TEASER_TAG.length) return final ? done(p) : pending();
    if (lines.length >= TEASER_LINES_MAX) return done(p);
    const win = rest.slice(0, TEASER_LINE_MAX);
    const close = win.indexOf("]]");
    const newline = win.indexOf("\n");
    if (close !== -1 && (newline === -1 || close < newline)) {
      const m = TEASER_LINE_RX.exec(rest.slice(0, close + 2));
      if (!m) return done(p);
      lines.push({ index: Number(m[1]), text: m[2] });
      pos = p + close + 2;
      continue;
    }
    if (newline !== -1 || rest.length >= TEASER_LINE_MAX) return done(p);
    return final ? done(p) : pending();
  }
}

/**
 * Teaserzeilen vom Anfang eines Texts (hinter dem bereits entfernten Marker)
 * entfernen — dieselbe Entscheidung wie der Stream-Filter. Nur aufrufen,
 * wenn die Antwort einen Marker hatte.
 * @param {string} text
 * @returns {string}
 */
function stripTeasers(text) {
  if (typeof text !== "string") return text;
  const result = parseTeaserLines(text, { final: true });
  return result.lines.length > 0 ? text.slice(result.end) : text;
}

/**
 * Vollständige Antwort zerlegen: Marker, Teaserzeilen, Rest-Text (ohne
 * beides). Ohne Marker bleibt der Text unverändert (auch "[[TEASER"-Zeilen).
 * @param {string} text
 * @returns {{marker: object, teasers: {index: number, text: string}[], text: string}}
 */
function parseCardsReply(text) {
  const marker = parseCardsMarker(text, { final: true });
  if (marker.state !== "marker") return { marker, teasers: [], text };
  const afterMarker = text.slice(marker.end).trimStart();
  const teasers = parseTeaserLines(afterMarker, { final: true });
  return {
    marker,
    teasers: teasers.lines,
    text: afterMarker.slice(teasers.end),
  };
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
 * Marker-Entscheidung fällt; danach (Kurskarten v3) die Teaserzeilen bis zum
 * ersten Zeichen, das keine Teaserzeile beginnt — Leerraum hinter Marker und
 * Teasern wird bis zum ersten sichtbaren Zeichen entfernt.
 * Phasen: "marker" -> "teasers" (nur nach einem Marker) -> "text".
 */
class CardsMarkerFilter {
  constructor() {
    this.buffer = "";
    this.phase = "marker";
    this.marker = null; // { indices: number[], valid: boolean }
    this.teaserLines = []; // angenommene Teaserzeilen ({index, text})
    this.teasersReported = false;
  }

  get decided() {
    return this.phase !== "marker";
  }

  // Zu jeder Marker-Nummer eine Teaserzeile da (oder Höchstzahl erreicht)?
  #teasersComplete(lines) {
    if (lines.length >= TEASER_LINES_MAX) return true;
    const wanted = this.marker?.valid ? this.marker.indices : [];
    if (wanted.length === 0) return false;
    return wanted.every((n) => lines.some((line) => line.index === n));
  }

  #teaserStep(final) {
    const result = parseTeaserLines(this.buffer, { final });
    this.teaserLines = result.lines;
    const out = { text: "" };
    const report =
      !this.teasersReported &&
      result.lines.length > 0 &&
      (result.state === "done" || this.#teasersComplete(result.lines));
    if (report) {
      this.teasersReported = true;
      out.teasers = result.lines.slice();
    }
    if (result.state === "pending") return out;
    this.phase = "text";
    out.text = this.buffer.slice(result.end);
    this.buffer = "";
    return out;
  }

  /**
   * @param {string} token
   * @param {{final?: boolean}} [options]
   * @returns {{text: string, marker?: {indices: number[], valid: boolean}, teasers?: {index: number, text: string}[]}}
   *   text = jetzt an das Widget zu sendender Text ("" = noch puffern);
   *   teasers = einmalig, sobald die Teaserzeilen vollständig sind
   */
  push(token, { final = false } = {}) {
    const piece = typeof token === "string" ? token : "";
    if (this.phase === "text") return { text: piece };
    this.buffer += piece;
    if (this.phase === "teasers") return this.#teaserStep(final);

    const result = parseCardsMarker(this.buffer, { final });
    if (result.state === "pending") return { text: "" };
    const buffered = this.buffer;
    if (result.state === "none") {
      this.phase = "text";
      this.buffer = "";
      return { text: buffered };
    }
    this.marker = { indices: result.indices ?? [], valid: result.valid };
    this.phase = "teasers";
    this.buffer = buffered.slice(result.end);
    return { ...this.#teaserStep(final), marker: this.marker };
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
 * Kurskarten v3: onTeasers bekommt die Teaserzeilen einmalig, eingereiht
 * HINTER onMarker (Karten zuerst) und VOR dem Text dahinter.
 * @param {import("express").Response} response
 * @param {{onMarker: (marker: {indices: number[], valid: boolean}) => (void|Promise<void>), onTeasers?: (lines: {index: number, text: string}[]) => (void|Promise<void>)}} options
 * @returns {{response: import("express").Response, done: () => Promise<void>, filter: CardsMarkerFilter}}
 */
function createCardsMarkerResponse(response, { onMarker, onTeasers } = {}) {
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
    const { text, marker, teasers } = filter.push(data.textResponse ?? "", {
      final,
    });
    if (marker && typeof onMarker === "function") later(() => onMarker(marker));
    if (teasers && typeof onTeasers === "function")
      later(() => onTeasers(teasers));
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
 * Kurskarten v3: gespeicherte Teaserzeilen (courseTeaserLines) einer
 * Antwort-JSON prüfen: nur {index: 0–999, text: string}, Text bereinigt
 * (≤ 200 Zeichen), höchstens TEASER_LINES_MAX, erste Zeile je Nummer.
 * @param {any} value
 * @returns {{index: number, text: string}[]}
 */
function storedTeaserLines(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    if (out.length >= TEASER_LINES_MAX) break;
    const index = item?.index;
    if (!Number.isInteger(index) || index < 0 || index > 999) continue;
    if (out.some((line) => line.index === index)) continue;
    const text = cleanTeaserText(item?.text);
    if (text) out.push({ index, text });
  }
  return out;
}

/**
 * Teaserzeilen für den LLM-Verlauf: "[[TEASER 0: …]]" je Zeile.
 * @param {any} lines
 * @returns {string[]}
 */
function teaserLinesText(lines) {
  return storedTeaserLines(lines).map(
    ({ index, text }) => `${TEASER_TAG} ${index}: ${text}]]`
  );
}

/**
 * Nur für den LLM-Verlauf (recentEmbedChatHistory): stellt den Marker, den
 * der Bot in einer früheren Antwort gesendet hat (Antwort-JSON
 * courseCardsMarker), wieder als erste Zeile vor den gespeicherten Text —
 * auch "[[KARTEN: -]]" (courseCardsMarker: []), damit jede frühere Antwort
 * einen Marker zeigt. Kurskarten v3: gespeicherte Teaserzeilen
 * (courseTeaserLines) folgen direkt nach dem Marker. Die Datensätze werden
 * kopiert, nie verändert; ohne gespeicherten Marker (Feld fehlt/null)
 * unverändert.
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
    const prefix = [line, ...teaserLinesText(data.courseTeaserLines)];
    return {
      ...record,
      response: JSON.stringify({
        ...data,
        text: `${prefix.join("\n")}\n${data.text}`,
      }),
    };
  });
}

module.exports = {
  parseCardsMarker,
  stripCardsMarker,
  parseTeaserLines,
  stripTeasers,
  parseCardsReply,
  createCardsMarkerResponse,
  storedMarkerIndices,
  storedTeaserLines,
  restoreCardsMarkers,
  // nur für Tests
  __test__: {
    CARDS_MARKER_TAG,
    CARDS_MARKER_BUFFER_MAX,
    TEASER_LINE_MAX,
    TEASER_LINES_MAX,
    parseMarkerIndices,
    cardsMarkerLine,
    teaserLinesText,
    CardsMarkerFilter,
  },
};
