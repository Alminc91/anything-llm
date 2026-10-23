// Kurskarten v2 (Standard an, aus mit visual_config.courseCards = "off"):
// Karten-Marker.
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
//     kein Marker; Text bleibt unverändert (nichts geht verloren). Dieselbe
//     Grenze gilt für Stream-Filter und stripCardsMarker — beide entscheiden
//     immer gleich.
//   - Ein späterer "[[KARTEN: …]]" (nicht am Antwortanfang) bringt keine
//     Karten, wird aber wie die Folgefragen-Zeile überall entfernt (FF1,
//     ProtocolMarkerFilter, gleiche Fenstergrenze).
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
// Folgefragen: Die Antwort darf eine Zeile "[[FRAGEN: Frage eins? |
// Frage zwei?]]" enthalten (Vorschläge für die nächste Nutzerfrage). Der
// Prompt verlangt sie als letzte Zeile, Modelle schreiben sie aber auch vor
// den KI-Hinweis, mitten in den Text oder doppelt. Darum gilt (FF1): Ein
// Protokoll-Marker "[[FRAGEN: …]]" — und ebenso ein späteres
// "[[KARTEN: …]]" (der Karten-Marker der ersten Zeile läuft oben) — wird
// ÜBERALL im Text erkannt und entfernt (ProtocolMarkerFilter): Beginn
// "[[FRAGEN:" bzw. "[[KARTEN:" (Groß-/Kleinschreibung egal), Schluss das
// ERSTE "]]" in derselben Zeile innerhalb des Fensters (FOLLOW_UPS_LINE_MAX
// bzw. CARDS_MARKER_BUFFER_MAX Zeichen ab "[["). Kein "]]" bis zum
// Zeilenende, zur Fenstergrenze oder zum Antwortende -> kein Marker, die
// Zeichen bleiben Text (nichts geht verloren, nichts hängt). Text hinter
// dem Marker (z. B. der KI-Hinweis) bleibt normal Text. Der Leerraum um
// einen entfernten Marker wird zusammengelegt (die meisten Zeilenumbrüche
// gewinnen, ganz am Anfang/Ende entfällt er), so entsteht keine Lücke.
// Pillen kommen aus der LETZTEN "[[FRAGEN: …]]"-Zeile (auch wenn sie leer
// ist bzw. alle Einträge verworfen werden): bis zu FOLLOW_UPS_MAX gültige
// Einträge nach den Regeln von storedFollowUps (durch "|" getrennt,
// bereinigt; leere, zu lange, doppelte und der gerade gestellten
// Nutzerfrage gleiche Einträge verworfen, nicht gekürzt; Rückfragen an den
// Nutzer verworfen; "[[FRAGEN: -]]" = keine Vorschläge). Im Stream hält der
// Filter nur Leerraum am Ende und einen begonnenen möglichen Marker ab "["
// zurück, bis entschieden ist (höchstens ein Fenster) — der Stream ergibt
// dasselbe wie die ganze Antwort (parseCardsReply). Gespeichert als
// followUps (Widget-Verlauf), im LLM-Verlauf wieder als letzte Zeile.
//
// KIE-576 Absicherung: Mit gültiger Kategorie-Karte (embedCategoryChains.js)
// prüft eine letzte Stufe (OverviewLinkFilter) jeden Übersichtslink „Alle
// Kurse in …“, bevor er gesendet wird: entfernt, wenn die Adresse ein
// Kurs-Link oder nicht im Kontext ist, sonst Titel und Zahl aus der Karte.
// Stream und gespeicherter Text entscheiden gleich; ohne Karte keine Stufe.

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

// Folgefragen: Zeile "[[FRAGEN: … | …]]" (Prompt: letzte Zeile; erkannt überall)
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
 * (Karten-Marker, Teaserzeilen, Folgefragen) — gleiche Fenster-, Schluss- und
 * Zeilenende-Entscheidung. Leerraum vorn wird übersprungen. Nur das Fenster
 * der ersten maxLen Zeichen zählt: "]]" bzw. Zeilenende müssen vollständig
 * darin liegen — so ist die Entscheidung für einen Antwortanfang dieselbe
 * wie für die ganze Antwort.
 *   - beginnt nicht mit tag -> "none"
 *   - "]]" vor dem Zeilenende -> "closed"; closeAt "first": erstes "]]",
 *     sofort entschieden (Marker, Folgefragen); "last": letztes "]]" der
 *     Zeile, erst mit Zeilenende, Fenstergrenze oder final entschieden
 *     (Teaser)
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

// Folgefragen-Richtung: Vorschläge sind Nachrichten des Nutzers an den
// Berater. Rückfragen an den Nutzer („Suchen Sie …?“) kämen als Pille
// geklickt als Nutzer-Nachricht zurück — Sicherheitsnetz zum Prompt-Hinweis
// (FOLLOW_UPS_PROMPT_NOTE). Bewusst eng, nur diese Muster, lineare Muster
// ohne verschachtelte Quantifizierer (kein ReDoS):
//  - Ausnahme vor allen Mustern: Bezug auf den Nutzer selbst („mein…“, „mir“,
//    „mich“, Groß-/Kleinschreibung egal) -> nie verwerfen („Brauchen Sie
//    meine Kontodaten?“, „Möchten Sie meine Telefonnummer?“).
//  - deutsch, irgendwo im Eintrag: eines der sechs Verben + Höflichkeits-„Sie“
//    (großgeschrieben, kein i-Flag — das Pronomen „sie“ der 3. Person trifft
//    nicht: „Kurse, die sie gemeinsam besuchen können“). Verben am Satzanfang
//    oder mittendrin („Suchen Sie …?“, „Für welches Alter suchen Sie?“).
//    Nicht in der Liste: brauchen, benötigen, planen — „Was brauchen Sie für
//    die Anmeldung?“, „Planen Sie Kurse im Sommer?“ sind Nutzerfragen an die
//    VHS. Dazu die Rückfrage „Welches Niveau/Alter … Sie“. Nutzerfragen mit
//    „Sie“ bleiben („Haben Sie …?“, „Bieten Sie …?“, „Können Sie …?“).
//  - englisch, am Anfang (Groß-/Kleinschreibung egal): Rückfrage-Anfänge
//    („Are you looking …?“, „Would you like …?“, „Do you want to …?“,
//    „Do you prefer …?“, „Do you have a preferred …?“, „Which level would
//    you like?“, „Do you have any prior experience?“,
//    „What level are you?“, „How old is your child?“), irgendwo: „your
//    child/kid/son/daughter“. Nicht: „do you need/want“ ohne „to“ („Do you
//    need my ID?“, „Do you want a deposit?“), „are you planning/open“,
//    „Which courses do you offer?“, „Do you have a yoga course?“.
const ADDRESSES_SELF_RX = /\b(?:mein|meine|meinen|meiner|meines|mir|mich)\b/i;
const ADDRESSES_USER_DE_RX =
  /\b(?:[sS]uchen|[mM]öchten|[wW]ollen|[bB]evorzugen|[iI]nteressieren|[wW]ünschen)\s+Sie\b/;
// Rückfrage \bWelche[srn]?\s+(Niveau|Alter|Vorkenntnisse|Erfahrung|Stufe)\b
// [^|]*\bSie\b — zweistufig geprüft (asksUserLevel): als ein Muster wäre es
// bei vielen „Welches Niveau“ hintereinander quadratisch (NAK-3).
const ADDRESSES_USER_DE_ASK_HEAD_RX =
  /\bWelche[srn]?\s+(?:Niveau|Alter|Vorkenntnisse|Erfahrung|Stufe)\b/;
const POLITE_SIE_RX = /\bSie\b/;
const ADDRESSES_USER_EN_RX =
  /^(?:are you (?:looking|interested|searching)|do you prefer|do you have a preferred|do you want to|do you need to|would you (?:like|prefer|rather)|which [^|]* (?:do|would) you (?:prefer|like|want to)|do you have (?:any )?(?:prior |previous )?experience|what level are you|how old (?:is|are) (?:your|you))\b/i;
const ADDRESSES_USER_EN_CHILD_RX = /\byour (?:child|kid|son|daughter)\b/i;
// Führende Aufzählungs-/Satzzeichen vor dem englischen Anfangsmuster
const LEADING_NON_LETTERS_RX = /^[^\p{L}]+/u;

/**
 * Rückfrage „Welches Niveau/Alter … Sie“: wie das Muster
 * \bWelche[srn]?\s+(Niveau|…)\b[^|]*\bSie\b, aber linear — je Abschnitt
 * zwischen "|" nur der erste Anfang (hat den längsten Rest), dahinter „Sie“.
 * @param {string} text
 * @returns {boolean}
 */
function asksUserLevel(text) {
  for (const part of text.split("|")) {
    const head = ADDRESSES_USER_DE_ASK_HEAD_RX.exec(part);
    if (head && POLITE_SIE_RX.test(part.slice(head.index + head[0].length)))
      return true;
  }
  return false;
}

/**
 * Richtet sich ein Folgefragen-Vorschlag an den Nutzer (Rückfrage des
 * Beraters) statt an den Berater? Verändert nichts, nur die Entscheidung.
 * @param {any} text
 * @returns {boolean}
 */
function addressesUser(text) {
  if (typeof text !== "string" || text.length === 0) return false;
  if (ADDRESSES_SELF_RX.test(text)) return false;
  if (ADDRESSES_USER_DE_RX.test(text)) return true;
  if (asksUserLevel(text)) return true;
  if (ADDRESSES_USER_EN_CHILD_RX.test(text)) return true;
  return ADDRESSES_USER_EN_RX.test(text.replace(LEADING_NON_LETTERS_RX, ""));
}

/**
 * Folgefragen: Inhalt zwischen "[[FRAGEN:" und "]]" -> Vorschläge, nach den
 * Regeln von storedFollowUps (Einträge durch "|" getrennt). "-" bzw. leer
 * -> [] (keine Vorschläge); kaputte Einträge werden verworfen, nie die Zeile.
 * Einträge, die den Nutzer adressieren (addressesUser), werden vorher
 * verworfen (nicht verändert) — sie zählen nicht gegen FOLLOW_UPS_MAX.
 * Einträge gleich der gerade gestellten Nutzerfrage (userMessage,
 * normalisiert verglichen, followUpKey) und Dubletten werden verworfen.
 * Frageform (Prompt: jede Pille eine Frage mit „?“): Einträge ohne
 * Fragezeichen bleiben bewusst unverändert — kein angehängtes „?“ (aus
 * „Kurse für Babys“ würde keine Frage, nur ein falsches Satzzeichen; das
 * Fragezeichen der Nutzersprache ist nicht immer „?“) und kein Verwerfen
 * (ein Stichwort ist als Pille noch brauchbar, ein Ausfall des Hinweises
 * ließe sonst alle Pillen verschwinden). Die Quote misst das Messskript
 * (demo_site/prompt/folgefragen_frageform_*.json).
 * @param {string} content
 * @param {{userMessage?: string}} [options] - userMessage: gerade gestellte
 *   Frage des Nutzers
 * @returns {string[]}
 */
function parseFollowUpItems(content, { userMessage } = {}) {
  const raw = String(content ?? "").trim();
  if (raw === "") return [];
  return storedFollowUps(
    raw.split("|").filter((item) => !addressesUser(item)),
    { userMessage }
  );
}

// Protokoll-Marker im Fließtext (FF1): Folgefragen und späte Karten-Marker
const FOLLOW_UPS_MARKER = Object.freeze({
  tag: FOLLOW_UPS_TAG,
  max: FOLLOW_UPS_LINE_MAX,
});
const INLINE_MARKERS = Object.freeze([
  FOLLOW_UPS_MARKER,
  Object.freeze({ tag: CARDS_MARKER_TAG, max: CARDS_MARKER_BUFFER_MAX }),
]);
const WS_RUN_RX = /\s+/y;
const TEXT_RUN_RX = /[^\s[]+/y;

/**
 * Protokoll-Marker ab Position i (dort steht "[") erkennen — mit dem
 * gemeinsamen Scanner scanBracketLine (dieselbe Fenster-, Schluss- und
 * Zeilenende-Entscheidung wie Karten-Marker und Teaserzeilen) auf dem
 * Fenster der def.max Zeichen ab i.
 *   - "marker": "[[FRAGEN:"/"[[KARTEN:" mit dem ersten "]]" in derselben
 *     Zeile, vollständig im Fenster; end = hinter "]]", content = Inhalt
 *     zwischen Tag und "]]".
 *   - "pending": könnte noch einer werden (Anfang eines Tags, oder Tag ohne
 *     "]]", ohne Zeilenende, Fenster noch nicht voll) — nur ohne final.
 *   - "none": sonst (auch kaputte Zeile); die Zeichen sind Text.
 * @param {string} s
 * @param {number} i
 * @param {boolean} final - Antwort ist vollständig
 * @returns {{state: "pending"|"none"|"marker", def?: object, end?: number, content?: string}}
 */
function scanInlineMarker(s, i, final) {
  let pending = false;
  for (const def of INLINE_MARKERS) {
    const line = scanBracketLine(
      s.slice(i, i + def.max),
      def.tag,
      def.max,
      final
    );
    if (line.state === "closed")
      return {
        state: "marker",
        def,
        end: i + line.end,
        content: s.slice(i + def.tag.length, i + line.close),
      };
    if (line.state === "pending") pending = true;
  }
  return pending ? PENDING : NONE;
}

/**
 * Leerraum um entfernte Marker zusammenlegen: gaps = Leerraum-Abschnitte
 * (vor, zwischen, hinter den Markern). Die meisten Zeilenumbrüche gewinnen
 * (Absatz bleibt Absatz), Einrückung der nächsten Zeile aus dem letzten
 * Abschnitt; ohne Zeilenumbruch ein Leerzeichen (bzw. nichts, wenn gar kein
 * Leerraum da war).
 * @param {string[]} gaps
 * @returns {string}
 */
function mergeGaps(gaps) {
  const newlines = Math.max(...gaps.map((g) => g.split("\n").length - 1));
  if (newlines === 0) return gaps.some((g) => g.length > 0) ? " " : "";
  const last = gaps[gaps.length - 1];
  const indent = last.includes("\n")
    ? last.slice(last.lastIndexOf("\n") + 1)
    : "";
  return "\n".repeat(newlines) + indent;
}

/**
 * FF1: Zustandsbehafteter Filter, der Protokoll-Marker "[[FRAGEN: …]]" und
 * "[[KARTEN: …]]" überall im Text entfernt (Stream und ganze Antwort
 * teilen ihn — gleiche Entscheidung bei jeder Aufteilung in Token).
 * Zurückgehalten werden nur Leerraum am Ende (bis sichtbarer Text folgt;
 * so kann er um einen Marker zusammengelegt werden) und ein möglicher
 * Marker ab "[" bis zur Entscheidung (Zeilenende, "]]", Fenstergrenze oder
 * Antwortende — nie länger). Ohne Marker bleibt der Text unverändert.
 * this.followUps = Einträge der LETZTEN Folgefragen-Zeile (null = keine).
 */
class ProtocolMarkerFilter {
  /**
   * @param {{userMessage?: string}} [options] - gerade gestellte Nutzerfrage
   */
  constructor({ userMessage } = {}) {
    this.userMessage = userMessage;
    this.rest = ""; // unentschiedener Rest ab einem möglichen Marker ("[")
    this.gaps = [""]; // gehaltener Leerraum; je entferntem Marker ein Abschnitt
    this.textSent = false; // schon sichtbarer Text ausgegeben
    this.followUps = null;
  }

  // Leerraum vor dem nächsten sichtbaren Text
  #takeGap() {
    const gaps = this.gaps;
    const sent = this.textSent;
    this.gaps = [""];
    this.textSent = true;
    if (gaps.length === 1) return gaps[0];
    // Marker ganz am Anfang: Leerraum entfällt
    return sent ? mergeGaps(gaps) : "";
  }

  /**
   * @param {string} piece
   * @param {{final?: boolean}} [options]
   * @returns {string} jetzt auszugebender Text
   */
  push(piece, { final = false } = {}) {
    const s = this.rest + (typeof piece === "string" ? piece : "");
    this.rest = "";
    let out = "";
    let i = 0;
    while (i < s.length) {
      WS_RUN_RX.lastIndex = i;
      const ws = WS_RUN_RX.exec(s);
      if (ws) {
        this.gaps[this.gaps.length - 1] += ws[0];
        i += ws[0].length;
        continue;
      }
      if (s[i] === "[") {
        const found = scanInlineMarker(s, i, final);
        if (found.state === "pending") {
          this.rest = s.slice(i);
          break;
        }
        if (found.state === "marker") {
          if (found.def === FOLLOW_UPS_MARKER)
            this.followUps = parseFollowUpItems(found.content, {
              userMessage: this.userMessage,
            });
          this.gaps.push("");
          i = found.end;
          continue;
        }
        out += this.#takeGap() + "[";
        i += 1;
        continue;
      }
      TEXT_RUN_RX.lastIndex = i;
      const run = TEXT_RUN_RX.exec(s)[0];
      out += this.#takeGap() + run;
      i += run.length;
    }
    if (final) {
      // Marker ganz am Ende: Leerraum davor/dahinter entfällt
      if (this.gaps.length === 1) out += this.gaps[0];
      this.gaps = [""];
    }
    return out;
  }
}

/**
 * Protokoll-Marker einer vollständigen Antwort (bzw. des Texts hinter Karten-
 * Marker und Teasern) entfernen und die Folgefragen der letzten
 * "[[FRAGEN: …]]"-Zeile lesen (ProtocolMarkerFilter in einem Durchgang).
 *   - "followUps": mindestens eine Folgefragen-Zeile (followUps evtl. [])
 *   - "none": keine; followUps fehlt
 * text ist in beiden Fällen ohne Marker (ohne Marker unverändert).
 * @param {string} text
 * @param {{userMessage?: string}} [options]
 * @returns {{state: "none"|"followUps", text: string, followUps?: string[]}}
 */
function parseFollowUps(text, { userMessage } = {}) {
  const filter = new ProtocolMarkerFilter({ userMessage });
  const out = filter.push(typeof text === "string" ? text : "", {
    final: true,
  });
  return filter.followUps
    ? { state: "followUps", text: out, followUps: filter.followUps }
    : { state: "none", text: out };
}

/**
 * Protokoll-Marker ("[[FRAGEN: …]]", "[[KARTEN: …]]") aus einem gespeicher-
 * ten Antworttext entfernen — für jeden Leser des gespeicherten Texts (auch
 * alte Datensätze, in denen die Zeile vor dem Fix vor dem KI-Hinweis stand).
 * Kein String -> unverändert.
 * @param {any} text
 * @returns {any}
 */
function stripProtocolMarkers(text) {
  if (typeof text !== "string" || !text.includes("[[")) return text;
  return parseFollowUps(text).text;
}

/**
 * L4: Gespeicherte Antwort (Spalte embed_chats.response) ohne Protokoll-
 * Marker im Text — die eine Bereinigung beim Lesen (EmbedChats.
 * withoutProtocolMarkers). Antwort-JSON (Objekt mit text): nur text
 * bereinigt, alle anderen Felder bleiben; Klartext (Zeilen ohne JSON):
 * bereinigt. Ohne Marker, kein String oder JSON ohne text (anderes Objekt,
 * Liste): dieselbe Zeichenkette.
 * @param {any} response
 * @returns {any}
 */
function cleanStoredResponse(response) {
  if (typeof response !== "string" || !response.includes("[[")) return response;
  let data;
  try {
    data = JSON.parse(response);
  } catch {
    return stripProtocolMarkers(response);
  }
  if (!data || typeof data !== "object" || typeof data.text !== "string")
    return response;
  const text = stripProtocolMarkers(data.text);
  return text === data.text ? response : JSON.stringify({ ...data, text });
}

// KIE-576: Übersichtslinks („Alle Kurse in …“) prüfen, bevor sie das Widget
// erreichen. Fenster ab "[" bis ")" (Linktext + Adresse); höchstens so viele
// Zeichen Aufzählungs-/Schmuckzeichen am Zeilenanfang werden mitgehalten.
const LINK_WINDOW = 600;
const LINE_PREFIX_MAX = 16;
const MARKDOWN_LINK_RX = /^\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/;
// Anfang eines möglichen Links: "[text", "[text]", "[text](" + Adressanfang
const PARTIAL_LINK_RX = /^\[[^\]\n]*(?:\](?:\(([^)\s]*))?)?$/;
const LINE_PREFIX_RX =
  /^[ \t>*\u2022\u00b7\-\u2013\u2014\d.)\p{Extended_Pictographic}\uFE0F\u200D]$/u;
const LINE_TEXT_RX = /[^\n[]+/y;

/**
 * Markdown-Link ab Position i (dort steht "[") im Fenster LINK_WINDOW.
 *   - "link": "[text](http…)" vollständig; end = hinter ")"
 *   - "pending": könnte noch einer werden (nur ohne final)
 *   - "none": sonst; "[" ist Text
 * @param {string} s
 * @param {number} i
 * @param {boolean} final
 * @returns {{state: "pending"|"none"|"link", text?: string, url?: string, end?: number}}
 */
function scanMarkdownLink(s, i, final) {
  const win = s.slice(i, i + LINK_WINDOW);
  const m = MARKDOWN_LINK_RX.exec(win);
  if (m) return { state: "link", text: m[1], url: m[2], end: i + m[0].length };
  if (final || win.length >= LINK_WINDOW) return NONE;
  const partial = PARTIAL_LINK_RX.exec(win);
  if (!partial) return NONE;
  const url = partial[1];
  if (
    url === undefined ||
    "https://".startsWith(url) ||
    "http://".startsWith(url) ||
    /^https?:\/\//.test(url)
  )
    return PENDING;
  return NONE;
}

/**
 * KIE-576 Absicherung: Zustandsbehafteter Filter, der Übersichtslinks mit
 * dem Prüfer aus embedCategoryChains (createOverviewLinkGuard) entscheidet —
 * Stream und ganze Antwort teilen ihn (gleiche Entscheidung bei jeder
 * Aufteilung in Token). Läuft hinter dem ProtocolMarkerFilter.
 * Zurückgehalten werden ein möglicher Link ab "[" bis ")" (Zeilenende,
 * Fenstergrenze oder Antwortende entscheiden dagegen) und Aufzählungs-/
 * Schmuckzeichen am Zeilenanfang davor. Entfernt wird ein Übersichtslink
 * mit dem Rest seiner Zeile; stand davor nur Schmuck, die ganze Zeile samt
 * Zeilenende (wie guard v2), sonst bleibt der schon gesendete Zeilenanfang.
 * Neu gesetzt wird nur der Linktext; alle anderen Links bleiben unverändert.
 */
class OverviewLinkFilter {
  /**
   * @param {{check: (text: string, url: string) => (null|{remove: boolean, text?: string})}} guard
   */
  constructor(guard) {
    this.guard = guard;
    this.rest = ""; // unentschiedener Rest ab einem möglichen Link ("[")
    this.prefix = ""; // gehaltener Zeilenanfang (nur Schmuckzeichen)
    this.lineStart = true; // in dieser Zeile noch kein Text gesendet
    this.drop = null; // Rest der Zeile verwerfen: "line" (samt "\n") | "rest"
  }

  #text(out, text) {
    const sent = out + this.prefix + text;
    this.prefix = "";
    this.lineStart = false;
    return sent;
  }

  /**
   * @param {string} piece
   * @param {{final?: boolean}} [options]
   * @returns {string} jetzt auszugebender Text
   */
  push(piece, { final = false } = {}) {
    const s = this.rest + (typeof piece === "string" ? piece : "");
    this.rest = "";
    let out = "";
    let i = 0;
    while (i < s.length) {
      if (this.drop) {
        const newline = s.indexOf("\n", i);
        if (newline === -1) {
          i = s.length;
          break;
        }
        i = this.drop === "line" ? newline + 1 : newline;
        this.drop = null;
        this.lineStart = true;
        continue;
      }
      if (s[i] === "\n") {
        out += `${this.prefix}\n`;
        this.prefix = "";
        this.lineStart = true;
        i += 1;
        continue;
      }
      if (s[i] === "[") {
        const found = scanMarkdownLink(s, i, final);
        if (found.state === "pending") {
          this.rest = s.slice(i);
          break;
        }
        if (found.state === "none") {
          out = this.#text(out, "[");
          i += 1;
          continue;
        }
        const verdict = this.guard.check(found.text, found.url);
        if (verdict?.remove) {
          this.drop = this.lineStart ? "line" : "rest";
          this.prefix = "";
        } else {
          out = this.#text(
            out,
            verdict ? `[${verdict.text}](${found.url})` : s.slice(i, found.end)
          );
        }
        i = found.end;
        continue;
      }
      if (this.lineStart) {
        // Token-Grenze mitten in einem Zeichen (Emoji): auf den Rest warten
        const code = s.charCodeAt(i);
        if (code >= 0xd800 && code <= 0xdbff && i + 1 === s.length && !final) {
          this.rest = s.slice(i);
          break;
        }
        const char = String.fromCodePoint(s.codePointAt(i));
        if (
          LINE_PREFIX_RX.test(char) &&
          this.prefix.length + char.length <= LINE_PREFIX_MAX
        ) {
          this.prefix += char;
          i += char.length;
          continue;
        }
      }
      LINE_TEXT_RX.lastIndex = i;
      const run = LINE_TEXT_RX.exec(s)[0];
      out = this.#text(out, run);
      i += run.length;
    }
    if (final) {
      out += this.prefix;
      this.prefix = "";
      this.drop = null;
    }
    return out;
  }
}

/**
 * Übersichtslinks einer vollständigen Antwort prüfen (OverviewLinkFilter in
 * einem Durchgang). Ohne Prüfer (keine gültige Karte) unverändert.
 * @param {any} text
 * @param {object|null} overviewLinks - createOverviewLinkGuard()
 * @returns {any}
 */
function guardOverviewLinks(text, overviewLinks) {
  if (!overviewLinks || typeof text !== "string") return text;
  return new OverviewLinkFilter(overviewLinks).push(text, { final: true });
}

/**
 * Vollständige Antwort zerlegen: Marker, Teaserzeilen, Folgefragen, Rest-
 * Text (ohne Marker, Teaserzeilen und Protokoll-Marker). Ohne Marker bleibt
 * der Text bis auf Protokoll-Marker unverändert (auch "[[TEASER"-Zeilen).
 * KIE-576: mit overviewLinks (Prüfer aus createOverviewLinkGuard) laufen die
 * Übersichtslinks des Rest-Texts zuletzt durch den OverviewLinkFilter —
 * dieselbe Entscheidung wie im Stream.
 * @param {string} text
 * @param {{userMessage?: string, overviewLinks?: object|null}} [options] -
 *   gerade gestellte Nutzerfrage (Pillen gleich dieser Frage werden
 *   verworfen); Prüfer der Übersichtslinks
 * @returns {{marker: object, teasers: {index: number, text: string}[], followUps: string[], text: string}}
 */
function parseCardsReply(text, { userMessage, overviewLinks = null } = {}) {
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
  const followUps = parseFollowUps(body, { userMessage });
  return {
    marker,
    teasers,
    followUps: followUps.followUps ?? [],
    text: guardOverviewLinks(followUps.text, overviewLinks),
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
 * Folgefragen (FF1): Der Text aller Phasen läuft zusätzlich durch den
 * ProtocolMarkerFilter, der "[[FRAGEN: …]]"/"[[KARTEN: …]]" überall entfernt
 * (Leerraum am Ende und ein begonnener Marker werden bis zur Entscheidung
 * gehalten); Folgefragen der letzten Zeile -> beim Antwortende.
 * KIE-576: danach (nur mit Prüfer) der OverviewLinkFilter.
 */
class CardsMarkerFilter {
  /**
   * @param {{userMessage?: string, overviewLinks?: object|null}} [options] -
   *   gerade gestellte Nutzerfrage; KIE-576: Prüfer der Übersichtslinks
   *   (ohne: keine Prüfung, Text wie bisher)
   */
  constructor({ userMessage, overviewLinks = null } = {}) {
    this.buffer = "";
    this.phase = "marker";
    this.marker = null; // { indices: number[], valid: boolean }
    this.teasers = []; // gesammelte Teaserzeilen ({index, text})
    this.teasersReported = false;
    this.protocol = new ProtocolMarkerFilter({ userMessage });
    this.links = overviewLinks ? new OverviewLinkFilter(overviewLinks) : null;
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
   *   followUps = nur beim Antwortende (final), wenn eine Folgefragen-Zeile
   *   kam (Einträge der letzten, evtl. [])
   */
  push(token, { final = false } = {}) {
    const out = this.#cardsStep(token, final);
    out.text = this.protocol.push(out.text, { final });
    if (this.links) out.text = this.links.push(out.text, { final });
    if (final && this.protocol.followUps)
      out.followUps = this.protocol.followUps.slice();
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
 * userMessage: gerade gestellte Nutzerfrage (Folgefragen-Regeln wie
 * parseCardsReply). overviewLinks: KIE-576 Prüfer der Übersichtslinks (wie
 * parseCardsReply), ohne: Text wie bisher.
 * @param {{onMarker: (marker: {indices: number[], valid: boolean}) => (void|Promise<void>), onTeasers?: (lines: {index: number, text: string}[]) => (void|Promise<void>), userMessage?: string, overviewLinks?: object|null}} options
 * @returns {{response: import("express").Response, done: () => Promise<void>, filter: CardsMarkerFilter}}
 */
function createCardsMarkerResponse(
  response,
  { onMarker, onTeasers, userMessage, overviewLinks = null } = {}
) {
  const filter = new CardsMarkerFilter({ userMessage, overviewLinks });
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

const NOT_LETTER_OR_DIGIT_RX = /[^\p{L}\p{N}]+/gu;

/**
 * Vergleichsschlüssel einer Pille (FF2): Unicode-normalisiert (NFKC),
 * klein, nur Buchstaben/Ziffern, Wörter durch ein Leerzeichen getrennt —
 * „Gibt es Yoga am Abend?“, „gibt es yoga  am abend“ und „Gibt es Yoga am
 * Abend ?“ sind gleich. "" = kein Inhalt.
 * @param {any} text
 * @returns {string}
 */
function followUpKey(text) {
  if (typeof text !== "string") return "";
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(NOT_LETTER_OR_DIGIT_RX, " ")
    .trim();
}

/**
 * Folgefragen: gespeicherte Vorschläge (followUps) einer Antwort-JSON prüfen
 * (Widget-Verlauf /history und LLM-Verlauf) — dieselben Regeln gelten beim
 * Erkennen der Folgefragen-Zeile (parseFollowUpItems) — Sicherheitsnetz
 * (FF2): nur Strings, bereinigt; leere bzw. nur aus Satzzeichen/Strichen/
 * Symbolen bestehende verworfen; höchstens FOLLOW_UP_MAX_LEN Zeichen
 * (längere verworfen, nicht gekürzt — der Prompt verlangt ≤ 60, das Widget
 * verwirft ebenfalls ab 61, damit erst recht alles > 80); ohne Dubletten
 * und ohne Einträge gleich der gerade gestellten Nutzerfrage (userMessage)
 * — beides normalisiert verglichen (followUpKey); die ersten
 * FOLLOW_UPS_MAX.
 * @param {any} value
 * @param {{userMessage?: string}} [options] - gerade gestellte Nutzerfrage
 * @returns {string[]}
 */
function storedFollowUps(value, { userMessage } = {}) {
  if (!Array.isArray(value)) return [];
  const asked = followUpKey(userMessage);
  const out = [];
  const keys = [];
  for (const item of value) {
    if (out.length >= FOLLOW_UPS_MAX) break;
    const text = cleanTeaserText(item);
    if (!text || text.length > FOLLOW_UP_MAX_LEN) continue;
    // Schlüssel "" = ohne Inhalt: nur Satzzeichen/Striche/Aufzählungszeichen
    // ("-", "–", "—", "•", "·", "*", ".", "…") und Leerraum
    const key = followUpKey(text);
    if (!key || key === asked || keys.includes(key)) continue;
    keys.push(key);
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
 * "[[FRAGEN: … | …]]" (auch ohne Marker). Protokoll-Marker, die noch im
 * gespeicherten Text stehen (Altdatensätze vor FF1), werden entfernt (L4).
 * Die Datensätze werden kopiert, nie verändert; ohne gespeicherten Marker
 * (Feld fehlt/null) und ohne Marker im Text unverändert.
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
    // L4: Altdatensätze (vor FF1) tragen Marker noch im Text — nie als
    // Vorbild ans Modell; wieder eingesetzt wird nur, was gespeichert ist.
    const body = stripProtocolMarkers(data.text);
    if (prefix.length === 0 && !suffix && body === data.text) return record;
    let text = body;
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
  stripProtocolMarkers,
  cleanStoredResponse,
  addressesUser,
  restoreCardsMarkers,
  // nur für Tests
  __test__: {
    FOLLOW_UPS_TAG,
    FOLLOW_UPS_LINE_MAX,
    FOLLOW_UPS_MAX,
    FOLLOW_UP_MAX_LEN,
    parseFollowUpItems,
    followUpKey,
    followUpsLine,
    ProtocolMarkerFilter,
    OverviewLinkFilter,
    LINK_WINDOW,
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
