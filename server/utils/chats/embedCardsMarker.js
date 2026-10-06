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
// Grenzen: je Zeile höchstens TEASER_LINE_MAX Zeichen; Schluss ist das
// LETZTE "]]" vor dem Zeilenende (der Teaser darf selbst "]]" enthalten),
// daher fällt die Entscheidung je Zeile erst mit dem Zeilenende, der
// Fenstergrenze oder dem Antwortende. Gesammelt wird höchstens eine Zeile je
// Marker-Nummer, also höchstens so viele wie der Marker Nummern hat (max.
// TEASER_LINES_MAX = COURSE_SOURCES_MAX).
// Wohlgeformte Teaserzeilen sind Protokoll, kein Nutztext: auch die nicht
// gesammelten (fremde Nummer, Dublette, über der Grenze, nach "[[KARTEN: -]]"
// oder nach einem ungültigen Marker) werden entfernt und nirgends gespeichert
// oder gesendet. "Kein Datenverlust" gilt nur für kaputte Zeilen (Zeilenende
// bzw. Grenze ohne "]]", falsches Format): sie und alles danach gehen
// unverändert als Text durch. Gespeichert werden die gesammelten Zeilen als
// courseTeaserLines (nur LLM-Verlauf).
//
// Folgefragen: Die LETZTE Zeile der Antwort darf "[[FRAGEN: Frage eins? |
// Frage zwei?]]" sein (Vorschläge für die nächste Nutzerfrage). Erkannt wird
// sie nur am Antwortende (danach höchstens Leerraum, davor Zeilenanfang);
// die Zeile ist höchstens FOLLOW_UPS_LINE_MAX Zeichen lang, enthält 1 bis
// FOLLOW_UPS_MAX Einträge (durch "|" getrennt), je nach dem Bereinigen
// (Markdown/HTML raus, Trim) höchstens FOLLOW_UP_MAX_LEN Zeichen. "-" bzw.
// leer = Protokoll ohne Vorschläge (entfernt). Sonst kaputt: die Zeile bleibt
// unverändert Text, nichts gesammelt. Im Stream hält der Filter dazu den
// Leerraum am Ende und eine mögliche Endzeile zurück (höchstens eine Zeile
// ≤ FOLLOW_UPS_LINE_MAX Zeichen) und entscheidet mit dem Antwortende —
// gleiche Regeln wie parseFollowUps über die ganze Antwort. Gespeichert als
// followUps (Widget-Verlauf), im LLM-Verlauf wieder als letzte Zeile.

const { writeResponseChunk } = require("../helpers/chat/responses");
const { safeJsonParse } = require("../http");
const { cleanTeaserText, COURSE_SOURCES_MAX } = require("./embedCourseSources");

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
// höchstens so viele Teaserzeilen werden gesammelt (eine je Karte); weitere
// wohlgeformte Zeilen werden nur entfernt
const TEASER_LINES_MAX = COURSE_SOURCES_MAX;
const TEASER_LINE_RX =
  /^\[\[TEASER[ \t]*(\d{1,3})[ \t]*:[ \t]*([^\n]*?)[ \t]*\]\]$/i;

// Folgefragen: Endzeile "[[FRAGEN: … | …]]"
const FOLLOW_UPS_TAG = "[[FRAGEN:";
// Obergrenze der Zeile (Zeichen ab "[[FRAGEN:" bis einschließlich "]]")
const FOLLOW_UPS_LINE_MAX = 300;
const FOLLOW_UPS_MAX = 3;
const FOLLOW_UP_MAX_LEN = 60;

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
  const line = scanBracketLine(
    s,
    CARDS_MARKER_TAG,
    CARDS_MARKER_BUFFER_MAX,
    final
  );
  if (line.state === "pending") return PENDING;
  if (line.state === "none") return NONE;
  if (line.state === "broken")
    return { state: "marker", indices: null, valid: false, end: line.end };
  const indices = parseMarkerIndices(
    s.slice(line.start + CARDS_MARKER_TAG.length, line.close)
  );
  return { state: "marker", indices, valid: indices !== null, end: line.end };
}

/**
 * Gemeinsamer Scanner für eine Protokollzeile "[[TAG … ]]" am Textanfang
 * (Karten-Marker und Teaserzeilen) — gleiche Fenster-, Schluss- und
 * Zeilenende-Entscheidung. Leerraum vorn wird übersprungen. Nur das Fenster
 * der ersten maxLen Zeichen zählt: "]]" bzw. Zeilenende müssen vollständig
 * darin liegen — so ist die Entscheidung für einen Antwortanfang dieselbe
 * wie für die ganze Antwort.
 *   - beginnt nicht mit tag -> "none"
 *   - "]]" vor dem Zeilenende -> "closed"; closeAt "first": erstes "]]",
 *     sofort entschieden (Marker); "last": letztes "]]" der Zeile, erst mit
 *     Zeilenende, Fenstergrenze oder final entschieden (Teaser)
 *   - Zeilenende ohne "]]" -> "broken" (kaputte Zeile)
 *   - Fenster voll ohne "]]"/Zeilenende, oder final -> "none"
 *   - sonst "pending" (weiter puffern)
 * @param {string} text
 * @param {string} tag - in Großbuchstaben, z. B. "[[KARTEN:"
 * @param {number} maxLen - Fenster ab Zeilenanfang
 * @param {boolean} final - Antwort ist vollständig
 * @param {"first"|"last"} [closeAt="first"]
 * @returns {{state: "pending"|"none"|"closed"|"broken", start: number, close?: number, end?: number}}
 *   start = Zeilenanfang (hinter dem Leerraum); close = Position von "]]";
 *   end = hinter "]]" ("closed") bzw. hinter dem Zeilenende ("broken")
 */
function scanBracketLine(text, tag, maxLen, final, closeAt = "first") {
  const start = text.length - text.trimStart().length;
  const body = text.slice(start);
  const result = (state, extra = {}) => ({ state, start, ...extra });
  if (body.length === 0) return result(final ? "none" : "pending");
  if (!tag.startsWith(body.slice(0, tag.length).toUpperCase()))
    return result("none");
  if (body.length < tag.length) return result(final ? "none" : "pending");
  const win = body.slice(0, maxLen);
  const newline = win.indexOf("\n");
  const line = newline === -1 ? win : win.slice(0, newline);
  const settled = newline !== -1 || body.length >= maxLen || final;
  if (closeAt === "last" && !settled) return result("pending");
  const close =
    closeAt === "last" ? line.lastIndexOf("]]") : line.indexOf("]]");
  if (close !== -1)
    return result("closed", { close: start + close, end: start + close + 2 });
  if (newline !== -1) return result("broken", { end: start + newline + 1 });
  return result(settled ? "none" : "pending");
}

/**
 * Marker-Nummern, für die Teaserzeilen gesammelt werden: nur bei gültigem
 * Marker, höchstens TEASER_LINES_MAX (so viele Karten gibt es höchstens).
 * @param {{indices?: number[]|null, valid?: boolean}|null} marker
 * @returns {number[]}
 */
function teaserIndices(marker) {
  if (!marker?.valid || !Array.isArray(marker.indices)) return [];
  return marker.indices.slice(0, TEASER_LINES_MAX);
}

/**
 * Kurskarten v3: Teaserzeilen am Anfang des Texts hinter dem Marker
 * erkennen. Leerraum vor/zwischen den Zeilen wird übersprungen.
 *   - Zeile beginnt nicht mit "[[TEASER" -> fertig (Text ab hier).
 *   - "[[TEASER n: …]]" mit dem letzten "]]" vor dem Zeilenende, innerhalb
 *     TEASER_LINE_MAX Zeichen -> Teaserzeile (entfernt); gesammelt nur für
 *     Nummern aus indices (erste Zeile je Nummer); weiter mit der nächsten
 *     Zeile. Entschieden wird erst mit Zeilenende, Fenstergrenze oder final.
 *   - kaputt (Zeilenende bzw. Grenze ohne "]]", Format falsch) -> fertig,
 *     die Zeile bleibt Text.
 * Neu aufsetzbar: ab end mit den noch fehlenden Nummern weiterparsen ergibt
 * dasselbe wie ein Durchlauf über den ganzen Text (Stream-Filter).
 * @param {string} text - Text direkt hinter dem Marker
 * @param {{final?: boolean, indices?: number[]}} [options] - final: Antwort
 *   ist vollständig; indices: Nummern, deren Zeilen gesammelt werden
 * @returns {{state: "pending"|"done", lines: {index: number, text: string}[], end: number}}
 *   end = alles davor ist entschieden (entfernte Teaserzeilen + Leerraum);
 *   bei "done" beginnt hier der normale Text
 */
function parseTeaserLines(text, { final = false, indices = [] } = {}) {
  const s = typeof text === "string" ? text : "";
  const wanted = Array.isArray(indices) ? indices : [];
  const lines = [];
  const done = (end) => ({ state: "done", lines, end });
  const pending = (end) => ({ state: "pending", lines, end });
  let pos = 0;
  for (;;) {
    // Schluss = letztes "]]" der Zeile (der Teaser darf "]]" enthalten)
    const line = scanBracketLine(
      s.slice(pos),
      TEASER_TAG,
      TEASER_LINE_MAX,
      final,
      "last"
    );
    const at = pos + line.start;
    if (line.state === "pending") return pending(at);
    if (line.state !== "closed") return done(at);
    const m = TEASER_LINE_RX.exec(s.slice(at, pos + line.end));
    if (!m) return done(at);
    const index = Number(m[1]);
    if (wanted.includes(index) && !lines.some((l) => l.index === index))
      lines.push({ index, text: m[2] });
    pos += line.end;
  }
}

/**
 * Folgefragen: Inhalt zwischen "[[FRAGEN:" und "]]" -> Vorschläge. Einträge
 * durch "|" getrennt, bereinigt wie Teaser (Markdown/HTML raus, Trim), leere
 * verworfen, Dubletten (Groß-/Kleinschreibung egal) einmal.
 * "-" bzw. leer -> [] (Protokoll ohne Vorschläge); mehr als FOLLOW_UPS_MAX
 * Einträge oder einer über FOLLOW_UP_MAX_LEN Zeichen -> null (kaputt).
 * @param {string} content
 * @returns {string[]|null}
 */
function parseFollowUpItems(content) {
  const raw = String(content ?? "").trim();
  if (raw === "" || raw === "-") return [];
  const items = [];
  for (const part of raw.split("|")) {
    const text = cleanTeaserText(part);
    if (!text) continue;
    if (text.length > FOLLOW_UP_MAX_LEN) return null;
    if (!items.some((i) => i.toLowerCase() === text.toLowerCase()))
      items.push(text);
  }
  if (items.length === 0 || items.length > FOLLOW_UPS_MAX) return null;
  return items;
}

/**
 * Folgefragen-Zeile am Ende eines Texts erkennen. Betrachtet wird die letzte
 * Zeile vor dem abschließenden Leerraum (scanBracketLine, Schluss = letztes
 * "]]", Fenster FOLLOW_UPS_LINE_MAX); gültig nur, wenn "]]" die Zeile
 * beendet und die Einträge gültig sind (parseFollowUpItems).
 *   - final: "followUps" (text = alles vor der Zeile, ohne den Leerraum
 *     davor) oder "none" (text unverändert).
 *   - sonst (Stream): hold = ab hier zurückhalten — vor einer möglichen
 *     Endzeile (inkl. Leerraum davor; "pending") bzw. den Leerraum am Ende
 *     ("none"). Was davor liegt, ist endgültig Text.
 * @param {string} text
 * @param {{final?: boolean, atLineStart?: boolean}} [options] - atLineStart:
 *   Textanfang ist ein Zeilenanfang (im Stream nur, solange noch nichts
 *   gesendet wurde)
 * @returns {{state: "pending"|"none"|"followUps", hold: number, text?: string, followUps?: string[]}}
 */
function parseFollowUps(text, { final = false, atLineStart = true } = {}) {
  const s = typeof text === "string" ? text : "";
  const content = s.trimEnd();
  const newline = content.lastIndexOf("\n");
  const lineStart = newline + 1;
  const line = newline === -1 && !atLineStart ? "" : content.slice(lineStart);
  const holdFrom = s.slice(0, lineStart).trimEnd().length;
  const scan =
    line.length > 0
      ? scanBracketLine(
          line,
          FOLLOW_UPS_TAG,
          FOLLOW_UPS_LINE_MAX,
          final,
          "last"
        )
      : { state: "none" };
  const atEnd = scan.state === "closed" && scan.end === line.length;
  if (!final) {
    if (scan.state === "pending" || atEnd)
      return { state: "pending", hold: holdFrom };
    return { state: "none", hold: content.length };
  }
  const items = atEnd
    ? parseFollowUpItems(
        line.slice(scan.start + FOLLOW_UPS_TAG.length, scan.close)
      )
    : null;
  if (items === null) return { state: "none", hold: s.length, text: s };
  return {
    state: "followUps",
    hold: holdFrom,
    text: s.slice(0, holdFrom),
    followUps: items,
  };
}

/**
 * Vollständige Antwort zerlegen: Marker, Teaserzeilen, Folgefragen-Endzeile,
 * Rest-Text (ohne alles drei). Ohne Marker bleibt der Text bis auf eine
 * gültige Folgefragen-Endzeile unverändert (auch "[[TEASER"-Zeilen).
 * @param {string} text
 * @returns {{marker: object, teasers: {index: number, text: string}[], followUps: string[], text: string}}
 */
function parseCardsReply(text) {
  const marker = parseCardsMarker(text, { final: true });
  if (typeof text !== "string")
    return { marker, teasers: [], followUps: [], text };
  let teasers = [];
  let body = text;
  if (marker.state === "marker") {
    const afterMarker = text.slice(marker.end).trimStart();
    const parsed = parseTeaserLines(afterMarker, {
      final: true,
      indices: teaserIndices(marker),
    });
    teasers = parsed.lines;
    body = afterMarker.slice(parsed.end);
  }
  const followUps = parseFollowUps(body, { final: true });
  return {
    marker,
    teasers,
    followUps: followUps.followUps ?? [],
    text: followUps.text,
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
 * In der Teaser-Phase hält der Puffer nur den noch unentschiedenen Rest;
 * fertige Teaserzeilen werden sofort verworfen bzw. gesammelt (this.teasers).
 * Folgefragen: Der Text aller Phasen läuft zusätzlich durch einen Endpuffer
 * (this.tail), der Leerraum am Ende und eine mögliche "[[FRAGEN: …]]"-Zeile
 * bis zum Antwortende zurückhält (parseFollowUps); gefunden -> this.followUps.
 */
class CardsMarkerFilter {
  constructor() {
    this.buffer = "";
    this.phase = "marker";
    this.marker = null; // { indices: number[], valid: boolean }
    this.teasers = []; // gesammelte Teaserzeilen ({index, text})
    this.teasersReported = false;
    this.tail = ""; // zurückgehaltenes Textende (Folgefragen)
    this.textSent = false; // schon Text gesendet (Zeilenanfang-Regel)
    this.followUps = null; // gültige Folgefragen (erst beim Antwortende)
  }

  // Text nach Marker/Teasern: Endzeile "[[FRAGEN: …]]" zurückhalten
  #followUpsStep(text, final) {
    this.tail += text;
    const result = parseFollowUps(this.tail, {
      final,
      atLineStart: !this.textSent,
    });
    let out;
    if (final) {
      out = result.text;
      this.tail = "";
      if (result.state === "followUps") this.followUps = result.followUps;
    } else {
      out = this.tail.slice(0, result.hold);
      this.tail = this.tail.slice(result.hold);
    }
    if (out.length > 0) this.textSent = true;
    return out;
  }

  #teaserStep(final) {
    const wanted = teaserIndices(this.marker);
    const result = parseTeaserLines(this.buffer, {
      final,
      indices: wanted.filter((n) => !this.teasers.some((t) => t.index === n)),
    });
    this.teasers.push(...result.lines);
    this.buffer = this.buffer.slice(result.end);
    const out = { text: "" };
    // Meldung, sobald zu jeder gesuchten Nummer eine Zeile da ist (Grenze
    // erreicht) — unabhängig davon, ob dahinter noch etwas offen ist —,
    // spätestens wenn die Teaser-Phase endet
    const report =
      !this.teasersReported &&
      this.teasers.length > 0 &&
      (result.state === "done" || this.teasers.length >= wanted.length);
    if (report) {
      this.teasersReported = true;
      out.teasers = this.teasers.slice();
    }
    if (result.state === "pending") return out;
    this.phase = "text";
    out.text = this.buffer;
    this.buffer = "";
    return out;
  }

  /**
   * @param {string} token
   * @param {{final?: boolean}} [options]
   * @returns {{text: string, marker?: {indices: number[], valid: boolean}, teasers?: {index: number, text: string}[], followUps?: string[]}}
   *   text = jetzt an das Widget zu sendender Text ("" = noch puffern);
   *   teasers = einmalig, sobald die Teaserzeilen vollständig sind;
   *   followUps = nur beim Antwortende (final), wenn die Endzeile gültig ist
   */
  push(token, { final = false } = {}) {
    const out = this.#cardsStep(token, final);
    out.text = this.#followUpsStep(out.text, final);
    if (final && this.followUps) out.followUps = this.followUps.slice();
    return out;
  }

  #cardsStep(token, final) {
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
 * (≤ 200 Zeichen), höchstens TEASER_LINES_MAX (12), erste Zeile je Nummer.
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
 * Folgefragen: gespeicherte Vorschläge (followUps) einer Antwort-JSON prüfen
 * (Widget-Verlauf /history und LLM-Verlauf): nur Strings, bereinigt wie beim
 * Erkennen, höchstens FOLLOW_UP_MAX_LEN Zeichen (längere verworfen), ohne
 * Dubletten, höchstens FOLLOW_UPS_MAX.
 * @param {any} value
 * @returns {string[]}
 */
function storedFollowUps(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    if (out.length >= FOLLOW_UPS_MAX) break;
    const text = cleanTeaserText(item);
    if (!text || text.length > FOLLOW_UP_MAX_LEN) continue;
    if (out.some((t) => t.toLowerCase() === text.toLowerCase())) continue;
    out.push(text);
  }
  return out;
}

/**
 * Folgefragen-Zeile für den LLM-Verlauf: "[[FRAGEN: a | b]]", keine -> "".
 * @param {any} followUps
 * @returns {string}
 */
function followUpsLine(followUps) {
  const list = storedFollowUps(followUps);
  return list.length > 0 ? `${FOLLOW_UPS_TAG} ${list.join(" | ")}]]` : "";
}

/**
 * Nur für den LLM-Verlauf (recentEmbedChatHistory): stellt den Marker, den
 * der Bot in einer früheren Antwort gesendet hat (Antwort-JSON
 * courseCardsMarker), wieder als erste Zeile vor den gespeicherten Text —
 * auch "[[KARTEN: -]]" (courseCardsMarker: []), damit jede frühere Antwort
 * einen Marker zeigt. Kurskarten v3: gespeicherte Teaserzeilen
 * (courseTeaserLines) folgen direkt nach dem Marker. Folgefragen: gespei-
 * cherte Vorschläge (followUps) stehen wieder als letzte Zeile
 * "[[FRAGEN: … | …]]" (auch ohne Marker). Die Datensätze werden
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
    const prefix = line
      ? [line, ...teaserLinesText(data.courseTeaserLines)]
      : [];
    // Folgefragen: gespeicherte Vorschläge wieder als letzte Zeile
    const suffix = followUpsLine(data.followUps);
    if (prefix.length === 0 && !suffix) return record;
    let text = data.text;
    if (prefix.length > 0) text = `${prefix.join("\n")}\n${text}`;
    if (suffix) text = `${text}\n${suffix}`;
    return {
      ...record,
      response: JSON.stringify({ ...data, text }),
    };
  });
}

module.exports = {
  parseCardsMarker,
  stripCardsMarker,
  parseTeaserLines,
  parseCardsReply,
  createCardsMarkerResponse,
  storedMarkerIndices,
  storedTeaserLines,
  parseFollowUps,
  storedFollowUps,
  restoreCardsMarkers,
  // nur für Tests
  __test__: {
    FOLLOW_UPS_TAG,
    FOLLOW_UPS_LINE_MAX,
    FOLLOW_UPS_MAX,
    FOLLOW_UP_MAX_LEN,
    parseFollowUpItems,
    followUpsLine,
    CARDS_MARKER_TAG,
    CARDS_MARKER_BUFFER_MAX,
    scanBracketLine,
    TEASER_LINE_MAX,
    TEASER_LINES_MAX,
    parseMarkerIndices,
    cardsMarkerLine,
    teaserLinesText,
    CardsMarkerFilter,
  },
};
