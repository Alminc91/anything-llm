// KIE-576 Paket 2 „Kette“: Kategorie-Kette im Kontext und Absicherung des
// Übersichtslinks („Mehr Kurse zum Thema: …“, E29).
//
// Die Pipeline schreibt nach dem nächtlichen Kartenlauf die Karte des Kunden
// als SystemSetting kufer_category_map (Vertrag in der Spezifikation
// KIE-576, Abschnitt „Vertrag Karte“):
//   {"version": 1, "client": "<kunde>", "created": "<ISO-8601 UTC>",
//    "nodes": {"<pfad>": {"title": "…", "url": "https://…", "count": 12|null}},
//    "courses": {"<kursnummer>": "<pfad>"}}
// Pfade wie im Kursdokument („Sprachen \ Englisch“), verglichen über
// normalizePath (Kleinschreibung, Leerraum zusammengefasst, Zeichen wie
// category_common.clean_title).
//
// Kette (applyCategoryChains): Die Kursdokumente bleiben unverändert (kein
// Neueinbetten); beim Zusammenbau des Kontexts ersetzt der Server je Text die
// Zeilen „Kategorie-Link-Titel/Kategorie-Link/Bereich-Link-Titel/Bereich-Link“
// durch je eine Zeile „Kategorie-Ebene d: <title> (<count> Kurse) | <url>“
// für jede Ebene des Kategoriepfads mit Seite in der Karte, direkt nach
// „Kategoriepfad:“. Sonderknoten (E20: Warteliste, Neu …) beenden die Kette;
// steht der Kurs in courses (E21), gilt dieser Pfad statt des Feed-Pfads.
// Gecrawlte Kategorieseiten (Quellenadresse „source:“ gleich einer Knoten-
// adresse) bekommen die Kette ihres Knotens hinter den Metadatenkopf.
// Gelesen wird nur der Kopfblock (wie embedCourseSources.headerBlock):
// Freitext der Beschreibung oder gecrawlter Seiten erzeugt keine Kette.
//
// Absicherung (createOverviewLinkGuard, KIE-576 R1-D1): Der Prüfer
// entscheidet an der Adresse eines Links, nicht am Wortlaut. Eine einzige
// Entscheidung (check) für Stream, Antwort ohne Streaming und gespeicherten
// Text; der Filter dazu ist OverviewLinkFilter in embedCardsMarker.js.
//   1. Adresse ist ein Knoten der Karte und der Link sieht wie ein
//      Kategorie-Link aus: Linktext neu (Titel, Zahl nur bei de/en), Ziel
//      node.url. Kategorie-Link (R3-D4) = Link in Übersichtszeile oder
//      -block, alte Form „Alle … Kurse in …“, Linktext mit Kurszahl oder
//      Linktext gleich Knotentitel (normalisiert). Sonst, etwa bei einem
//      Kurstitel, bleibt der Linktext (Ziel wie vom Modell oder AK-21).
//   2. Kurs-Link des Kontexts als Übersichtslink: entfernen.
//   3. Übersichtslink mit unbekannter Adresse: entfernen. Übersichtslink =
//      Link in einer Übersichtszeile oder einem Übersichtsblock, Linktext in
//      alter Form („Alle [n] Kurse in …“) oder mit Kurszahl („12 Kurse“).
//      Bekannt = Adresse aus Kontext, System-Prompt (Kundenregeln) oder
//      gespeicherten Assistenten-Antworten (eine Normalisierung: linkKey).
//   4. Bekannte Adresse, kein Knoten: Link bleibt, eine Kurszahl im Linktext
//      fällt weg (NAK-7).
// Form der Übersichtszeile (E29) nur in OVERVIEW_LINE und overviewLinkText:
//   Mehr Kurse zum Thema: [<title> (<n> Kurse)](<url>) · [<title>](<url>)
// Übersichtszeile: Zeile mit der Einleitung (de/en, auch mit *, _, # drum
// herum) oder mit einem Knoten-Link in alter Form am Zeilenanfang; der
// Server setzt sie selbst. Übersichtsblock: Einleitung ohne Link und die
// direkt folgenden Listenzeilen; dort wird je Link entschieden.
//
// Kurslink nachschlagen (AK-21, E38): Optionales Feld course_links der Karte
//   {"<kursnummer>": {"title": "…", "start": "YYYY-MM-DD[THH:MM]",
//                     "place": "…", "url": "https://…"}}
// mit den eingelernten Kursen. Verlinkt das Modell außerhalb von
// Übersichtszeile und -block einen Kurstitel auf eine Adresse, die kein
// Kurs-Link ist (Kontext oder course_links), etwa eine gecrawlte
// Kategorieseite, sucht der Prüfer den Kurs über den Titel (genau, nur
// normalisiert; Schlüssel sind der volle Titel und der Haupttitel vor zwei
// Leerzeichen, R3-D2). Ersetzt wird nur mit Bestätigung (R3-D1, NAK-11 vor
// NAK-10), auch bei nur einem Kandidaten:
//   Stufe 2, sofort: Unter den Kandidaten steht genau einer mit Titel und
//     Beginndatum in einer Übersichtsseite des Kontexts, kein anderer Kurs
//     dieses Titels mit anderem Datum, sein Kurs-Link fehlt im Kontext und
//     die Adresse des Modells trägt keine andere Kursnummer.
//   Sonst Halten: Der Filter hält Link und Text danach (bis zum nächsten
//     Link, zur Leerzeile, höchstens 400 Zeichen) und ersetzt nur, wenn
//     Beginndatum oder Kursnummer dort bestätigen und nichts widerspricht
//     (Datum eines anderen Beginns, Kursnummer gleicher Form). Eine
//     Kursnummer im Text aus course_links ist zusätzlich ein Kandidat, wenn
//     sein Titel oder Haupttitel zum Linktext passt (R3-D3).
// Im Zweifel bleibt der Link unverändert. Ein kaputtes course_links lässt
// nur dieses Feld bzw. den Eintrag fallen, nie die Karte.
//
// Ohne gültige Karte (fehlt, kein JSON, version ≠ 1, älter als 36 h) gibt es
// weder Kette noch Absicherung: Kontext und Antwort bleiben exakt wie vorher.

const prisma = require("../prisma");
const { urlKey: courseUrlKey, trimUrlTail } = require("./embedCourseSources");

const CATEGORY_MAP_LABEL = "kufer_category_map";
// Vertrag: höchstens 2 MB (UTF-8), sonst schreibt die Pipeline nicht
const CATEGORY_MAP_MAX_BYTES = 2 * 1024 * 1024;
// E22: Karte höchstens 36 h alt (letzter erfolgreicher Kartenlauf)
const CATEGORY_MAP_MAX_AGE_MS = 36 * 60 * 60 * 1000;
// Uhrabweichung zwischen Pipeline und Container (created in der Zukunft)
const CATEGORY_MAP_FUTURE_MS = 60 * 60 * 1000;
const CHAIN_DEPTH_MAX = 5;
const TITLE_MAX_LEN = 200;
const URL_MAX_LEN = 300;
// E20: Sonderknoten (nach normalizePart), beenden die Kette
const SPECIAL_NODE_RX =
  /^(?:warteliste|neu|neues|neuheiten|neue kurse|neu im programm|neu hinzugefügt)$/;
// category_common: Pfadtrenner „ \ “, Zeichen, die in Titeln zu Leerzeichen werden
const PATH_SEP = "\\";
const UNSAFE_TITLE_RX = /[[\]()<>]/g;
const CONTROL_RX = /[\p{Cc}\u2028\u2029]/gu;
const CONTROL_CHAR_RX = /[\p{Cc}\u2028\u2029]/u;
// category_common.is_safe_url: keine Leer-, Steuer- und Markdown-Zeichen
const UNSAFE_URL_RX = /[\x00-\x20\x7f()[\]<>"'`\\{}|^\u0085\u00a0\u3000]/;

// Kopfblock wie embedCourseSources.headerBlock
const HEADER_SCAN_LEN = 4000;
const DOC_METADATA_OPEN = "<document_metadata>";
const DOC_METADATA_CLOSE = "</document_metadata>\n";
const REPLACED_LINE_RX =
  /^(?:Kategorie-Link-Titel|Kategorie-Link|Bereich-Link-Titel|Bereich-Link):/;
const CATEGORY_PATH_LINE_RX = /^Kategoriepfad:[ \t]*(.*)$/;
const COURSE_NUMBER_LINE_RX = /^Kursnummer:[ \t]*(.+)$/;
const COURSE_LINK_LINE_RX = /^Kurs-Link:[ \t]*(\S+)/;
const SOURCE_LINE_RX = /^source:[ \t]*(\S+)/m;

// KIE-576 E29: Form der Übersichtszeile, nur hier ändern. Einleitung je
// Sprache, Wort zur Zahl (n = 1 / sonst) und Trenner zwischen zwei Links in
// derselben Zeile. Ohne gezählte Zahl (null oder < 1) steht nur der Titel.
const OVERVIEW_LINE = {
  separator: " · ",
  de: { intro: "Mehr Kurse zum Thema:", one: "Kurs", many: "Kurse" },
  en: { intro: "More courses on this topic:", one: "course", many: "courses" },
};
const OVERVIEW_LANGS = ["de", "en"];

// Absicherung. Security (ReDoS, S1): Linktexte werden vor jeder Regex auf
// einen Leerraum je Lücke zusammengefasst und auf LABEL_MAX_LEN Codepunkte
// gekürzt (linkLabel); die Muster haben keine überlappenden Quantoren.
const LABEL_MAX_LEN = 200;
// alte Form des Linktexts (Prompt bis v3.5), auf linkLabel
const OVERVIEW_TEXT_RX =
  /^(alle|all)(?: (\d+(?:[.,]\d{3})*))? (kurse|courses) in(?![\p{L}\p{N}])/iu;
// Kurszahl im Linktext („12 Kurse“, „(1.250 courses)“, „3 cours“), auf
// linkLabel; Wort in den häufigsten Sprachen der Besucher (R1-D2)
const COURSE_COUNT_RX =
  /(?<![\p{L}\p{N}.,])(\d+(?:[.,]\d{3})*) ?(kurse?|courses?|cours|cursos?|corsi|corso|cursus(?:sen)?|kursy|kursów|kurzy|kurzů|kurslar|kursu|курс(?:а|ов|ы|и|ів)?)(?![\p{L}\p{N}])/iu;
// Kurszahl zählt nur am Ende des Linktexts, danach höchstens Klammer,
// Satzzeichen oder Schmuck („Sport (3 Kurse)“, „Kultur, 2 Kurse“). In einem
// Kurstitel („… ab 60 Kurs am Nachmittag“, „Abschnitt 4 Kurs 311“) ist sie
// keine Kurszahl und bleibt stehen.
const COUNT_TAIL_RX = /^[\s)\]*_.,;:!]*$/u;
// Zahl in Klammern am Ende („Sport (3)“): bei einem Knoten-Link ebenfalls
// eine Kurszahl (R3-D4), damit keine falsche Zahl stehen bleibt (NAK-7)
const BARE_COUNT_RX = /\(\s*\d+(?:[.,]\d{3})*\s*\)$/u;
const COUNT_WORD_LANG = {
  kurs: "de",
  kurse: "de",
  course: "en",
  courses: "en",
};
// Adressen in Kontext, Prompt und Verlauf (Satzzeichen am Ende schneidet
// trimUrlTail ab)
const CONTEXT_URL_RX = /https?:\/\/[^\s)\]|"'<>`]+/gi;
const CONTEXT_COURSE_LINK_RX = /^Kurs-Link:[ \t]*(\S+)/gm;
// Kategorieseiten „…/kategorie/<Name>/<Nr>“ = „…/kategorie/<Nr>“ (auf dem
// Schlüssel von courseUrlKey: Host und Pfad klein, ohne Schema)
const CATEGORY_KEY_RX = /^([^/]+)(?:\/[^?]*)?\/kategorie\/(?:[^/?]+\/)?(\d+)$/;

// AK-21 Kurslink nachschlagen. Grenzen je Eintrag von course_links; Texte
// werden vor jeder Regex auf diese Längen geprüft (Security wie S1).
const COURSE_TITLE_MAX_LEN = 300;
const COURSE_TEXT_SCAN_MAX = 1000;
const COURSE_PLACE_MAX_LEN = 200;
const COURSE_NUMBER_MAX_LEN = 64;
// kürzere Kursnummern („12“) taugen nicht als Merkmal im Text (Preis, Dauer)
const COURSE_NUMBER_MIN_LEN = 4;
// Beginn laut Vertrag: Ortszeit ohne Zone; Jahre vor 1950 (Nulldatum 1899)
// gelten als fehlend
const COURSE_START_RX = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/;
const COURSE_START_MIN_YEAR = 1950;
// Titelvergleich: Anführungszeichen und Striche vereinheitlicht, Markdown-
// Maskierung und * weg, Nummerierung „1. “ im Linktext (zweiter Versuch)
const QUOTE_DOUBLE_RX = /[\u201c\u201d\u201e\u201f\u00ab\u00bb\u2033"]/g;
const QUOTE_SINGLE_RX = /[\u2018\u2019\u201a\u201b\u2039\u203a\u00b4`']/g;
const DASH_RX = /[\u2010-\u2015\u2212]/g;
const MD_ESCAPE_RX = /\\([!-/:-@[-`{-~])/g;
const NUMBERING_RX = /^\d{1,3}[.)] ?/;
// Haupttitel (R3-D2): Teil eines Feed-Titels vor zwei oder mehr
// Leerraumzeichen („Hatha-Yoga  Einstiegskurs“ -> „Hatha-Yoga“)
const MAIN_TITLE_SPLIT_RX = /\s{2,}/;
// R3-D3: Ein Titel oder Haupttitel, mit dem der Linktext beginnt (bis zu
// einem Leerzeichen), macht den Link zum Kandidaten für das Nachschlagen
// über die Kursnummer. Kürzere Anfänge zählen nicht; Trenner am Ende des
// Anfangs („Hatha-Yoga: …“) fallen weg.
const COURSE_PREFIX_MIN_LEN = 5;
const PREFIX_TAIL_CHARS = " -:,;(\u00b7|/";
// Kursnummern im Text: Buchstaben und Ziffern, dazwischen - . / _
const NUMBER_TOKEN_RX = /[\p{L}\p{N}]+(?:[-./_][\p{L}\p{N}]+)*/gu;
// Stufe 2 (R3-D1): Beginndatum einer Titelzeile im Kontext steht in den
// folgenden SOURCE_DATE_SCAN Zeichen (Übersichtsseiten: Titel, „Wann:“,
// Datum); Anfang einer Titelzeile: Aufzählung, Überschrift, „Titel:“
const SOURCE_DATE_SCAN = 300;
const SOURCE_LINE_HEAD_RX =
  /^[ \t]*(?:#{1,6}[ \t]*|[-*+\u2022][ \t]+|\d{1,3}[.)][ \t]*)?(?:titel:[ \t]*)?/iu;
// Kursdokument im Kontext (hat eine Zeile „Kurs-Link:“)
const COURSE_DOC_RX = /^Kurs-Link:/m;
// Merkmale im Text nach dem Link (höchstens COURSE_WINDOW Zeichen, siehe
// embedCardsMarker.courseWindowEnd): Datum als T.M.[JJ]JJ, „5. März 2026“,
// „March 5, 2026“ oder ISO; Zeit als HH:MM, HH.MM, „18 Uhr“, „6 pm“ und
// Anfang eines Bereichs „18 bis 19.30 Uhr“
const MONTHS = {
  januar: 1,
  jan: 1,
  january: 1,
  februar: 2,
  feb: 2,
  february: 2,
  märz: 3,
  maerz: 3,
  mär: 3,
  mrz: 3,
  march: 3,
  mar: 3,
  april: 4,
  apr: 4,
  mai: 5,
  may: 5,
  juni: 6,
  jun: 6,
  june: 6,
  juli: 7,
  jul: 7,
  july: 7,
  august: 8,
  aug: 8,
  september: 9,
  sept: 9,
  sep: 9,
  oktober: 10,
  okt: 10,
  october: 10,
  oct: 10,
  november: 11,
  nov: 11,
  dezember: 12,
  dez: 12,
  december: 12,
  dec: 12,
};
const MONTH_ALT = Object.keys(MONTHS)
  .sort((a, b) => b.length - a.length)
  .join("|");
const DATE_DMY_RX =
  /(?<![\p{N}.,])(\d{1,2})\.[ \u00a0]?(\d{1,2})\.(?:[ \u00a0]?(\d{4})|(\d{2}))?(?!\p{N})/gu;
const DATE_DAY_MONTH_RX = new RegExp(
  `(?<![\\p{N}.,])(\\d{1,2})\\.?[ \\u00a0]+(${MONTH_ALT})\\.?(?:[ \\u00a0]+(\\d{4}))?(?![\\p{L}\\p{N}])`,
  "giu"
);
const DATE_MONTH_DAY_RX = new RegExp(
  `(?<![\\p{L}])(${MONTH_ALT})\\.?[ \\u00a0]+(\\d{1,2})(?:st|nd|rd|th)?,?(?:[ \\u00a0]+(\\d{4}))?(?![\\p{L}\\p{N}])`,
  "giu"
);
const DATE_ISO_RX = /(?<!\p{N})(\d{4})-(\d{2})-(\d{2})(?!\p{N})/gu;
const TIME_RX =
  /(?<![\p{N}.,:])([01]?\d|2[0-3])[:.]([0-5]\d)(?!\p{N})(?:[ \u00a0]?([ap])\.?m\b\.?)?/giu;
const TIME_HOUR_RX =
  /(?<![\p{N}.,:])([01]?\d|2[0-3])[ \u00a0]?(?:uhr|h|([ap])\.?m\.?)(?![\p{L}])/giu;
const TIME_RANGE_START_RX =
  /(?<![\p{N}.,:])([01]?\d|2[0-3])(?=[ \u00a0]?(?:[-\u2010-\u2015]|bis|to)[ \u00a0]?(?:[01]?\d|2[0-3])(?:[:.][0-5]\d)?[ \u00a0]?(?:uhr|h|[ap]\.?m))/giu;

/**
 * Eine Ebene eines Kategoriepfads zum Vergleich: wie category_common.
 * clean_title (einzeilig, ohne []()<>, Leerraum zusammengefasst), dazu
 * Unicode NFC und klein.
 * @param {any} part
 * @returns {string}
 */
function normalizePart(part) {
  return cleanText(String(part ?? "").normalize("NFC")).toLowerCase();
}

// Wie category_common.clean_title: einzeilig, ohne []()<>, Leerraum
// zusammengefasst (Grundlage von normalizePart und cleanTitle)
function cleanText(text) {
  return text
    .replace(CONTROL_RX, " ")
    .replace(UNSAFE_TITLE_RX, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Höchstens max Codepunkte (kein halbes Surrogatpaar, S15)
function truncateCodePoints(text, max) {
  if (text.length <= max) return text;
  let out = "";
  let n = 0;
  for (const char of text) {
    if (n === max) break;
    out += char;
    n += 1;
  }
  return out;
}

/**
 * Ebenen eines Kategoriepfads (Trenner „\“, leere Ebenen entfallen) wie
 * category_common.parts, normalisiert.
 * @param {any} path
 * @returns {string[]}
 */
function pathParts(path) {
  return String(path ?? "")
    .split(PATH_SEP)
    .map(normalizePart)
    .filter(Boolean);
}

function pathKey(parts) {
  return parts.join(` ${PATH_SEP} `);
}

function cleanTitle(title) {
  if (typeof title !== "string") return "";
  return truncateCodePoints(cleanText(title), TITLE_MAX_LEN).trim();
}

function isSafeUrl(url) {
  return (
    typeof url === "string" &&
    url.length <= URL_MAX_LEN &&
    /^https?:\/\//.test(url) &&
    !UNSAFE_URL_RX.test(url)
  );
}

/**
 * Gemeinsamer Vergleichsschlüssel einer Adresse (K6) für Knoten, Kontext,
 * Prompt, Verlauf und Modell-Links: Satzzeichen am Ende ab (trimUrlTail),
 * dann wie die Kurskarten (embedCourseSources.urlKey: Schema, „www.“,
 * Fragment, Schrägstrich am Ende, Groß/klein egal), dann Kategorieseiten
 * „…/kategorie/<Name>/<Nr>“ gleich „…/kategorie/<Nr>“ (url_key im
 * Benchmark). Keine http(s)-Adresse -> null.
 * @param {any} url
 * @returns {string|null}
 */
function linkKey(url) {
  if (typeof url !== "string") return null;
  const key = courseUrlKey(trimUrlTail(url.trim()));
  if (!key) return null;
  const m = CATEGORY_KEY_RX.exec(key);
  return m ? `${m[1]}#kat${m[2]}` : key;
}

// Host einer Adresse zum Vergleich (klein, ohne „www.“), sonst null
function hostKey(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

// Freitext zum Vergleich (AK-21): NFC, Anführungszeichen und Striche
// vereinheitlicht, Leerraum zusammengefasst, klein
function normalizeFree(text) {
  return String(text ?? "")
    .normalize("NFC")
    .replace(QUOTE_DOUBLE_RX, '"')
    .replace(QUOTE_SINGLE_RX, "'")
    .replace(DASH_RX, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Vergleichsschlüssel eines Kurstitels bzw. Linktexts (AK-21): ohne * und
 * Markdown-Maskierung, _ an den Enden weg, wie cleanText (ohne []()<>,
 * Leerraum zusammengefasst), Anführungszeichen und Striche vereinheitlicht,
 * NFC, klein. Keine unscharfe Ähnlichkeit. Zu lang oder leer -> null.
 * @param {any} text
 * @returns {string|null}
 */
function courseTitleKey(text) {
  if (typeof text !== "string" || text.length > COURSE_TEXT_SCAN_MAX)
    return null;
  let key = normalizeFree(
    cleanText(text.replace(MD_ESCAPE_RX, "$1").replace(/\*/g, ""))
  );
  let a = 0;
  let b = key.length;
  while (a < b && (key[a] === "_" || key[a] === " ")) a += 1;
  while (b > a && (key[b - 1] === "_" || key[b - 1] === " ")) b -= 1;
  key = key.slice(a, b);
  if (!key || [...key].length > COURSE_TITLE_MAX_LEN) return null;
  return key;
}

// Beginn nach Vertrag („YYYY-MM-DD“ oder „YYYY-MM-DDTHH:MM“), sonst null
function parseCourseStart(start) {
  const m = typeof start === "string" ? COURSE_START_RX.exec(start) : null;
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < COURSE_START_MIN_YEAR || mo < 1 || mo > 12 || d < 1 || d > 31)
    return null;
  let time = null;
  if (m[4] !== undefined) {
    if (Number(m[4]) > 23 || Number(m[5]) > 59) return null;
    time = `${m[4]}:${m[5]}`;
  }
  return { y, m: mo, d, time };
}

/**
 * Ein Eintrag von course_links (Vertrag Serverkarte) in Laufzeitform, sonst
 * null (nur dieser Eintrag entfällt). url: sicher wie Knotenadressen und auf
 * dem Host des Kunden (Host eines Knotens der Karte).
 * @returns {{titleKey: string, mainKey: string|null, number: string, shape: string, url: string, date: {y: number, m: number, d: number}|null, time: string|null, place: string|null, placeHead: string|null}|null}
 */
function courseEntry(number, entry, hosts) {
  const id = String(number).trim();
  if (!id || id.length > COURSE_NUMBER_MAX_LEN || CONTROL_CHAR_RX.test(id))
    return null;
  if (!isPlainObject(entry)) return null;
  const titleKey = courseTitleKey(entry.title);
  if (!titleKey || !isSafeUrl(entry.url) || !hosts.has(hostKey(entry.url)))
    return null;
  // R3-D2: Haupttitel als zweiter Schlüssel, wenn er sich vom Titel
  // unterscheidet
  const head = entry.title.trim().split(MAIN_TITLE_SPLIT_RX)[0];
  const mainKey = courseTitleKey(head);
  const start = parseCourseStart(entry.start);
  let place = null;
  let placeHead = null;
  if (
    typeof entry.place === "string" &&
    entry.place.length <= COURSE_TEXT_SCAN_MAX
  ) {
    place = normalizeFree(cleanText(entry.place)) || null;
    if (place && [...place].length > COURSE_PLACE_MAX_LEN) place = null;
    // erster Teil vor dem Komma („VHS-Haus, Raum 3“ -> „vhs-haus“)
    const head = place ? place.split(",")[0].trim() : "";
    placeHead = head.length >= 3 && head !== place ? head : null;
  }
  return {
    titleKey,
    mainKey: mainKey && mainKey !== titleKey ? mainKey : null,
    number: id.toLowerCase(),
    shape: numberShape(id.toLowerCase()),
    url: entry.url,
    date: start ? { y: start.y, m: start.m, d: start.d } : null,
    time: start?.time ?? null,
    place,
    placeHead,
  };
}

/**
 * Index der Kurse aus course_links (einmal je Karte): Titel- und
 * Haupttitelschlüssel -> Kurse, Kursnummer (klein) -> Kurs, dazu die
 * Vergleichsschlüssel aller Kurs-Links. Kein Objekt -> leer (die Karte
 * bleibt gültig).
 * @param {any} raw - data.course_links
 * @param {Map<string, object>} nodes
 * @returns {{courseTitles: Map<string, object[]>, courseNumbers: Map<string, object>, courseUrls: Set<string>}}
 */
function buildCourseLinks(raw, nodes) {
  const courseTitles = new Map();
  const courseNumbers = new Map();
  const courseUrls = new Set();
  if (!isPlainObject(raw)) return { courseTitles, courseNumbers, courseUrls };
  const hosts = new Set();
  for (const node of nodes.values()) {
    const host = hostKey(node.url);
    if (host) hosts.add(host);
  }
  for (const [number, entry] of Object.entries(raw)) {
    const course = courseEntry(number, entry, hosts);
    if (!course) continue;
    for (const titleKey of [course.titleKey, course.mainKey]) {
      if (!titleKey) continue;
      if (!courseTitles.has(titleKey)) courseTitles.set(titleKey, []);
      courseTitles.get(titleKey).push(course);
    }
    if (!courseNumbers.has(course.number))
      courseNumbers.set(course.number, course);
    const key = linkKey(course.url);
    if (key) courseUrls.add(key);
  }
  return { courseTitles, courseNumbers, courseUrls };
}

// Beginnt der Linktext (Schlüssel) mit einem Titel oder Haupttitel aus
// course_links, bis zu einem Leerzeichen (R3-D3)?
function hasTitlePrefix(map, key) {
  for (let p = key.indexOf(" "); p !== -1; p = key.indexOf(" ", p + 1)) {
    let end = p;
    while (end > 0 && PREFIX_TAIL_CHARS.includes(key[end - 1])) end -= 1;
    if (end >= COURSE_PREFIX_MIN_LEN && map.courseTitles.has(key.slice(0, end)))
      return true;
  }
  return false;
}

/**
 * Kandidaten zum Linktext (AK-21): Kurse mit gleichem Titel- oder
 * Haupttitelschlüssel (exact); ohne Treffer ein zweiter Versuch ohne
 * Nummerierung am Anfang („1. Yoga“). Ohne exakten Treffer nur dann ein
 * Ergebnis (exact leer), wenn der Linktext mit einem Titel oder Haupttitel
 * beginnt: Dann kann eine Kursnummer im Text den Kurs bestimmen (R3-D3).
 * key: Schlüssel des Linktexts für titleFits.
 * @param {object} map
 * @param {string} text - Linktext des Modells
 * @returns {{exact: object[], key: string}|null}
 */
function courseCandidates(map, text) {
  if (!map.courseTitles || map.courseTitles.size === 0) return null;
  const full = courseTitleKey(text);
  if (!full) return null;
  const numbering = NUMBERING_RX.exec(full);
  const plain = numbering ? full.slice(numbering[0].length) : null;
  const key = map.courseTitles.has(full) || !plain ? full : plain;
  const exact = map.courseTitles.get(key);
  if (exact) return { exact: [...new Set(exact)], key };
  return hasTitlePrefix(map, key) ? { exact: [], key } : null;
}

// Wörter (durch Leerzeichen getrennt) von a alle in b?
function wordsIn(a, b) {
  const words = new Set(b.split(" "));
  return a.split(" ").every((w) => words.has(w));
}

/**
 * Passt ein Kurs (über die Kursnummer gefunden) zum Linktext (R3-D3)? Ja,
 * wenn alle Wörter seines Titels oder Haupttitels im Linktext stehen oder
 * alle Wörter des Linktexts im Titel (Modell ergänzt „in Perach“ oder lässt
 * „NEU:“ weg). Die Kursnummer bestätigt, der Titel schließt Fremde aus.
 * @param {object} course
 * @param {string} key - courseCandidates().key
 * @returns {boolean}
 */
function titleFits(course, key) {
  return [course.titleKey, course.mainKey].some(
    (title) => !!title && (wordsIn(title, key) || wordsIn(key, title))
  );
}

// Form einer Kursnummer: Ziffer -> 9, Buchstabe -> a, Rest bleibt
// („2026h96580“ -> „9999a99999“)
function numberShape(number) {
  return number.replace(/\p{N}/gu, "9").replace(/\p{L}/gu, "a");
}

/**
 * Widerspricht eine Nummer im Text dem Kurs (R3-D1)? Ja, wenn ein Token
 * dieselbe Form wie seine Kursnummer hat, aber eine andere Nummer ist. Nur
 * bei Formen mit Buchstaben oder Trennern: reine Ziffern wären auch
 * Postleitzahlen oder Jahre.
 * @param {object} course
 * @param {string[]} tokens - Kleinbuchstaben, NUMBER_TOKEN_RX
 * @returns {boolean}
 */
function numberContradicts(course, tokens) {
  if (!/[^9]/.test(course.shape)) return false;
  return tokens.some(
    (t) =>
      t.length === course.number.length &&
      t !== course.number &&
      numberShape(t) === course.shape
  );
}

// Datum aus dem Text ({y|null, m, d}) gleich dem Beginndatum des Kurses?
function sameDay(d, date) {
  return d.m === date.m && d.d === date.d && (d.y === null || d.y === date.y);
}

// Gemeinsame Adresse aller Kandidaten, sonst null
function sameUrl(candidates) {
  const url = candidates[0]?.url ?? null;
  return url && candidates.every((c) => c.url === url) ? url : null;
}

function validDate(d, m) {
  return d >= 1 && d <= 31 && m >= 1 && m <= 12;
}

// Daten im Text nach dem Link ({y|null, m, d, at}); masked: Text mit
// Leerzeichen an Stelle der Daten (für die Zeiten)
function windowDates(text) {
  const dates = [];
  const spans = [];
  const add = (match, y, m, d) => {
    if (!validDate(d, m)) return;
    dates.push({ y, m, d, at: match.index });
    spans.push([match.index, match.index + match[0].length]);
  };
  for (const m of text.matchAll(DATE_ISO_RX))
    add(m, Number(m[1]), Number(m[2]), Number(m[3]));
  for (const m of text.matchAll(DATE_DMY_RX)) {
    const y = m[3] ? Number(m[3]) : m[4] ? 2000 + Number(m[4]) : null;
    add(m, y, Number(m[2]), Number(m[1]));
  }
  for (const m of text.matchAll(DATE_DAY_MONTH_RX))
    add(
      m,
      m[3] ? Number(m[3]) : null,
      MONTHS[m[2].toLowerCase()],
      Number(m[1])
    );
  for (const m of text.matchAll(DATE_MONTH_DAY_RX))
    add(
      m,
      m[3] ? Number(m[3]) : null,
      MONTHS[m[1].toLowerCase()],
      Number(m[2])
    );
  let masked = text;
  for (const [a, b] of spans)
    masked = masked.slice(0, a) + " ".repeat(b - a) + masked.slice(b);
  return { dates, masked };
}

// Zeiten im Text nach dem Link als „HH:MM“ (am/pm umgerechnet)
function windowTimes(masked) {
  const times = new Set();
  const add = (h, min, ampm) => {
    let hour = Number(h);
    const half = ampm ? ampm.toLowerCase() : null;
    if (half === "p" && hour < 12) hour += 12;
    if (half === "a" && hour === 12) hour = 0;
    if (hour > 23) return;
    times.add(`${String(hour).padStart(2, "0")}:${min}`);
  };
  for (const m of masked.matchAll(TIME_RX)) add(m[1], m[2], m[3]);
  for (const m of masked.matchAll(TIME_HOUR_RX)) add(m[1], "00", m[2]);
  for (const m of masked.matchAll(TIME_RANGE_START_RX)) add(m[1], "00", null);
  return times;
}

// needle als eigenes Wort in hay (Nachbarn keine Buchstaben/Ziffern)
const WORD_CHAR_RX = /[\p{L}\p{N}]/u;
function containsWord(hay, needle) {
  if (!needle) return false;
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + 1)) {
    const before = i > 0 ? hay[i - 1] : "";
    const after = hay[i + needle.length] ?? "";
    if (!WORD_CHAR_RX.test(before) && !WORD_CHAR_RX.test(after)) return true;
  }
  return false;
}

/**
 * Kurs zum gehaltenen Link (AK-21, R3-D1) aus dem Text direkt nach dem
 * Link. Kandidaten: die exakten zum Linktext, dazu Kurse aus course_links,
 * deren Kursnummer im Text steht und deren Titel zum Linktext passt
 * (R3-D3). Merkmale schließen nur aus, wenn der Text sie hergibt:
 *   Kursnummer (ab 4 Zeichen): steht die Nummer eines Kandidaten im Text,
 *     nur diese; ohne Nummer im Text nur die exakten Kandidaten. Eine
 *     andere Nummer gleicher Form im Text widerspricht (numberContradicts);
 *   Datum: Kandidaten mit anderem Beginndatum entfallen; ohne Beginndatum
 *     entfallen sie nur, wenn ein anderer Kandidat das Datum trifft (NAK-11);
 *   Zeit: steht die Beginnzeit eines Kandidaten im Text, entfallen
 *     Kandidaten mit anderer Beginnzeit (eine Zahl wie „Raum 1.01“ allein
 *     schließt niemanden aus);
 *   Ort: steht der Ort eines Kandidaten im Text, entfallen Kandidaten mit
 *     anderem Ort.
 * Bleibt genau eine Adresse und haben Kursnummer oder Beginndatum sie
 * bestätigt, deren Kurs-Link, sonst null (Link unverändert).
 * @param {{exact: object[], key: string}|object[]} candidates
 * @param {string} windowText
 * @param {object|null} [map] - Karte (Kursnummern aus course_links)
 * @returns {string|null}
 */
function pickCourseUrl(candidates, windowText, map = null) {
  const exact = Array.isArray(candidates) ? candidates : candidates?.exact;
  const fitKey = Array.isArray(candidates) ? null : candidates?.key;
  const text = String(windowText ?? "").normalize("NFC");
  const hay = normalizeFree(text);
  const tokens = hay.match(NUMBER_TOKEN_RX) ?? [];
  const { dates, masked } = windowDates(text);
  const times = windowTimes(masked);
  const numberIn = (c) =>
    c.number.length >= COURSE_NUMBER_MIN_LEN && containsWord(hay, c.number);
  const byNumber = new Set((exact ?? []).filter(numberIn));
  if (map?.courseNumbers && fitKey) {
    for (const t of tokens) {
      const c = t.length >= COURSE_NUMBER_MIN_LEN && map.courseNumbers.get(t);
      if (c && titleFits(c, fitKey)) byNumber.add(c);
    }
  }
  const confirmed = new Set(byNumber);
  let rest = byNumber.size > 0 ? [...byNumber] : exact ?? [];
  rest = rest.filter((c) => !numberContradicts(c, tokens));
  if (dates.length > 0) {
    const dateIn = (c) => !!c.date && dates.some((d) => sameDay(d, c.date));
    const anyDate = rest.some(dateIn);
    rest = rest.filter((c) => {
      if (dateIn(c)) {
        confirmed.add(c);
        return true;
      }
      return !c.date && !anyDate;
    });
  }
  const timeIn = (c) => !!c.time && times.has(c.time);
  if (rest.some(timeIn)) rest = rest.filter((c) => !c.time || timeIn(c));
  const placeIn = (c) =>
    !!c.place && (containsWord(hay, c.place) || containsWord(hay, c.placeHead));
  if (rest.some(placeIn)) rest = rest.filter((c) => !c.place || placeIn(c));
  const url = sameUrl(rest);
  return url && rest.some((c) => confirmed.has(c)) ? url : null;
}

/**
 * Wert des SystemSettings prüfen (Whitelist-Validator): leer -> null (Karte
 * entfernt); gültig -> derselbe String; sonst Fehler (das Update wird
 * abgelehnt, der alte Wert bleibt).
 * @param {any} update
 * @returns {string|null}
 */
function validateCategoryMapSetting(update) {
  if (update === null || update === undefined || update === "") return null;
  const { problem } = readContract(update);
  if (problem) throw new Error(`${CATEGORY_MAP_LABEL}: ${problem}`);
  return update;
}

/**
 * Gespeicherten Wert nach Vertrag lesen (gemeinsam für Validator und Leser).
 * @param {any} raw
 * @returns {{data: object, problem?: undefined}|{problem: string, data?: undefined}}
 */
function readContract(raw) {
  if (typeof raw !== "string") return { problem: "Wert ist kein JSON-String" };
  if (Buffer.byteLength(raw, "utf8") > CATEGORY_MAP_MAX_BYTES)
    return { problem: "größer als 2 MB" };
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return { problem: "kein gültiges JSON" };
  }
  const problem = contractProblem(data);
  return problem ? { problem } : { data };
}

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

// Grobe Vertragsprüfung (Form); einzelne unbrauchbare Knoten verwirft erst
// parseCategoryMap.
function contractProblem(data) {
  if (!isPlainObject(data)) return "kein JSON-Objekt";
  if (data.version !== 1) return "version ist nicht 1";
  if (!Number.isFinite(Date.parse(data.created)))
    return "created ist kein Zeitpunkt";
  if (!isPlainObject(data.nodes)) return "nodes fehlt";
  if (data.courses !== undefined && !isPlainObject(data.courses))
    return "courses ist kein Objekt";
  return null;
}

/**
 * Gespeicherten Wert in die Laufzeitform bringen. Knoten ohne sichere
 * Adresse, ohne Titel, tiefer als Ebene 5 oder unter einem Sonderknoten
 * entfallen; count nur als ganze Zahl ≥ 0, sonst null.
 * @param {string} raw
 * @returns {{createdMs: number, nodes: Map<string, object>, byUrl: Map<string, object[]>, courses: Map<string, string[]>, courseTitles: Map<string, object[]>, courseNumbers: Map<string, object>, courseUrls: Set<string>}|null}
 */
function parseCategoryMap(raw) {
  if (typeof raw !== "string" || raw.length === 0) return null;
  const { data } = readContract(raw);
  return data ? buildCategoryMap(data) : null;
}

function buildCategoryMap(data) {
  const nodes = new Map();
  const byUrl = new Map();
  for (const [path, node] of Object.entries(data.nodes)) {
    const parts = pathParts(path);
    if (parts.length === 0 || parts.length > CHAIN_DEPTH_MAX) continue;
    if (parts.some((part) => SPECIAL_NODE_RX.test(part))) continue;
    const title = cleanTitle(node?.title);
    if (!title || !isSafeUrl(node?.url)) continue;
    const key = pathKey(parts);
    if (nodes.has(key)) continue;
    const count =
      Number.isSafeInteger(node.count) && node.count >= 0 ? node.count : null;
    const entry = { parts, title, url: node.url, count };
    nodes.set(key, entry);
    const k = linkKey(node.url);
    if (!k) continue;
    if (!byUrl.has(k)) byUrl.set(k, []);
    byUrl.get(k).push(entry);
  }
  // je Adresse kürzester Pfad zuerst (stabil: bei Gleichstand Kartenreihenfolge)
  for (const list of byUrl.values())
    list.sort((a, b) => a.parts.length - b.parts.length);

  const courses = new Map();
  for (const [number, path] of Object.entries(data.courses ?? {})) {
    const parts = typeof path === "string" ? pathParts(path) : [];
    const id = String(number).trim();
    if (id && parts.length > 0) courses.set(id, parts);
  }
  // Optionales Feld updated (stündlicher Nachtrag der Zahlen, E28): wird
  // akzeptiert, ändert weder Gültigkeit noch Alter (E22 zählt created)
  const createdMs = Date.parse(data.created);
  const updatedMs =
    typeof data.updated === "string" &&
    Number.isFinite(Date.parse(data.updated))
      ? Date.parse(data.updated)
      : null;
  // AK-21: Kurse aus course_links (optional; kaputt -> leer, Karte bleibt)
  const { courseTitles, courseNumbers, courseUrls } = buildCourseLinks(
    data.course_links,
    nodes
  );
  return {
    createdMs,
    updatedMs,
    nodes,
    byUrl,
    courses,
    courseTitles,
    courseNumbers,
    courseUrls,
  };
}

/**
 * Stand der Zahlen einer gültigen Karte: updated, falls vorhanden und ein
 * Zeitpunkt, sonst created. Für das Folgepaket „Kursanzahl im Untertitel“;
 * nur intern (keine öffentliche Ausgabe).
 * @param {object|null} map - loadCategoryMap()
 * @returns {string|null} ISO-8601 UTC
 */
function categoryMapUpdatedAt(map) {
  const ms = map?.updatedMs ?? map?.createdMs;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

// Zuletzt gelesener Wert und seine Laufzeitform: neu geparst wird nur, wenn
// sich der gespeicherte Wert ändert (die Pipeline schreibt aus einem anderen
// Prozess, deshalb wird der Wert je Anfrage gelesen, eine Zeile per Label).
let cached = { raw: null, map: null };

async function readStoredMap() {
  try {
    const row = await prisma.system_settings.findFirst({
      where: { label: CATEGORY_MAP_LABEL },
      select: { value: true },
    });
    return row?.value ?? null;
  } catch (error) {
    console.error(`[categoryChains] ${error.message}`);
    return null;
  }
}

/**
 * Karte des Containers, falls gültig und höchstens 36 h alt (E22), sonst
 * null. Wirft nie.
 * @param {{now?: number}} [options]
 * @returns {Promise<object|null>}
 */
async function loadCategoryMap({ now = Date.now() } = {}) {
  const raw = await readStoredMap();
  if (typeof raw !== "string" || raw.length === 0) return null;
  if (raw !== cached.raw) {
    const { data, problem } = readContract(raw);
    // verworfene Karte melden (R1-D7), dank Cache einmal je Wert
    if (problem) console.error(`[categoryChains] Karte verworfen: ${problem}`);
    cached = { raw, map: data ? buildCategoryMap(data) : null };
  }
  const map = cached.map;
  if (!map) return null;
  const age = now - map.createdMs;
  if (age > CATEGORY_MAP_MAX_AGE_MS || age < -CATEGORY_MAP_FUTURE_MS)
    return null;
  return map;
}

// Kursanzahl als Text (deutsches bzw. englisches Zahlformat, S14)
function formatCount(n, lang = "de") {
  return n.toLocaleString(lang === "en" ? "en-US" : "de-DE");
}

// Zahl im Kontext (Kettenzeile): null ohne Klammer, sonst auch 0
function countLabel(count) {
  if (count === null) return "";
  return count === 1 ? " (1 Kurs)" : ` (${formatCount(count)} Kurse)`;
}

// Zahl im Linktext nur, wenn gezählt und mindestens 1 (NAK-7)
function hasCount(node) {
  return node.count !== null && node.count >= 1;
}

/**
 * Kettenzeilen eines Pfads: je Ebene mit Knoten eine Zeile, bis vor den
 * ersten Sonderknoten, höchstens Ebene 5.
 * @param {string[]} parts - normalisierte Ebenen
 * @param {object} map
 * @returns {string[]}
 */
function chainLines(parts, map) {
  const lines = [];
  for (let d = 1; d <= Math.min(parts.length, CHAIN_DEPTH_MAX); d++) {
    if (SPECIAL_NODE_RX.test(parts[d - 1])) break;
    const node = map.nodes.get(pathKey(parts.slice(0, d)));
    if (node)
      lines.push(
        `Kategorie-Ebene ${d}: ${node.title}${countLabel(node.count)} | ${node.url}`
      );
  }
  return lines;
}

// Letzte Ebene der Kurs-Link-Adresse („…/kurs/<name>/26294-035“)
function courseNumberFromLink(link) {
  try {
    const segments = new URL(link).pathname.split("/").filter(Boolean);
    return segments.length > 0
      ? decodeURIComponent(segments[segments.length - 1]).trim()
      : null;
  } catch {
    return null;
  }
}

/**
 * Grenzen von Metadatenkopf und Kopfblock eines Kontexttexts.
 * metaEnd = Position hinter "</document_metadata>\n" (0 ohne Kopf, -1 bei
 * unvollständigem Kopf); [start, end) = Kopfblock: nach Leerzeilen bis vor
 * „Kursbeschreibung:“ bzw. die erste Leerzeile, höchstens HEADER_SCAN_LEN.
 * @param {string} text
 * @returns {{metaEnd: number, start: number, end: number}}
 */
function headerBounds(text) {
  let metaEnd = 0;
  const lead = text.length - text.trimStart().length;
  if (text.startsWith(DOC_METADATA_OPEN, lead)) {
    const close = text.indexOf(DOC_METADATA_CLOSE, lead);
    if (close === -1) return { metaEnd: -1, start: 0, end: 0 };
    metaEnd = close + DOC_METADATA_CLOSE.length;
  }
  let start = metaEnd;
  const blank = /^(?:[ \t]*\r?\n)+/.exec(text.slice(start));
  if (blank) start += blank[0].length;
  // Ende inklusive des Zeilenendes der letzten Kopfzeile: entfernte Zeilen
  // gehen samt Zeilenende (wie im Benchmark), die Leerzeile bleibt
  const scan = text.slice(start, start + HEADER_SCAN_LEN);
  const stop = /^Kursbeschreibung:|\n[ \t]*\r?\n/m.exec(scan);
  if (!stop) return { metaEnd, start, end: start + scan.length };
  const lineEnd = stop[0].startsWith("\n") ? 1 : 0;
  return { metaEnd, start, end: start + stop.index + lineEnd };
}

/**
 * Kette für einen Kontexttext (siehe Kopfkommentar). Ohne Änderung derselbe
 * String.
 * @param {any} text
 * @param {object} map
 * @returns {any}
 */
function chainText(text, map) {
  if (typeof text !== "string" || text.length === 0) return text;
  const { metaEnd, start, end } = headerBounds(text);
  if (metaEnd === -1) return text;
  const lines = text.slice(start, end).split("\n");

  let pathLine = -1;
  let courseNumber = null;
  let courseLink = null;
  for (let i = 0; i < lines.length; i++) {
    if (pathLine === -1 && CATEGORY_PATH_LINE_RX.test(lines[i])) pathLine = i;
    const number = COURSE_NUMBER_LINE_RX.exec(lines[i]);
    if (number && courseNumber === null) courseNumber = number[1].trim();
    const link = COURSE_LINK_LINE_RX.exec(lines[i]);
    if (link && courseLink === null) courseLink = link[1];
  }

  const hasReplaced = lines.some((line) => REPLACED_LINE_RX.test(line));
  if (pathLine !== -1 || hasReplaced) {
    // Kursdokument (bzw. Teil seines Kopfblocks): die vier Zeilen ersetzt
    // die Kette; ohne Kategoriepfad (geteilter Kopfblock) keine Kette.
    let chain = [];
    if (pathLine !== -1) {
      const number = courseNumber || courseNumberFromLink(courseLink);
      const parts =
        (number && map.courses.get(number)) ||
        pathParts(CATEGORY_PATH_LINE_RX.exec(lines[pathLine])[1]);
      chain = chainLines(parts, map);
    }
    const out = [];
    lines.forEach((line, i) => {
      if (!REPLACED_LINE_RX.test(line)) out.push(line);
      if (i === pathLine) out.push(...chain);
    });
    const head = out.join("\n");
    return head === text.slice(start, end)
      ? text
      : text.slice(0, start) + head + text.slice(end);
  }

  // Gecrawlte Kategorieseite: Quellenadresse im Metadatenkopf
  if (metaEnd === 0) return text;
  const source = SOURCE_LINE_RX.exec(text.slice(0, metaEnd));
  const candidates = source ? map.byUrl.get(linkKey(source[1])) : null;
  if (!candidates) return text;
  const chain = chainLines(candidates[0].parts, map);
  if (chain.length === 0) return text;
  return `${text.slice(0, metaEnd)}${chain.join("\n")}\n${text.slice(metaEnd)}`;
}

/**
 * Kontexttexte mit Kette (nur contextTexts, nie sources). Ohne gültige Karte
 * oder ohne Änderung dasselbe Array (NAK-6).
 * @param {string[]} contextTexts
 * @param {object|null} map - loadCategoryMap()
 * @returns {string[]}
 */
function applyCategoryChains(contextTexts, map) {
  if (!map || !Array.isArray(contextTexts)) return contextTexts;
  let changed = false;
  const out = contextTexts.map((text) => {
    const next = chainText(text, map);
    if (next !== text) changed = true;
    return next;
  });
  return changed ? out : contextTexts;
}

/**
 * Kontext eines Chatpfads (SC7): angeheftete Texte und Treffer, mit Kette,
 * falls eine gültige Karte vorliegt. enabled = false (Kurskarten-Modus,
 * R1-D4): keine Karte, Kontext unverändert.
 * @param {string[]} contextTexts
 * @param {{contextTexts: string[]}} filledSources - fillSourceWindow()
 * @param {{enabled?: boolean}} [options]
 * @returns {Promise<{contextTexts: string[], map: object|null}>}
 */
async function buildChainedContext(
  contextTexts,
  filledSources,
  { enabled = true } = {}
) {
  const map = enabled ? await loadCategoryMap() : null;
  return {
    contextTexts: applyCategoryChains(
      [...contextTexts, ...filledSources.contextTexts],
      map
    ),
    map,
  };
}

/**
 * Linktext eines Links auf einen Knoten (E29): „<title> (<n> Kurse)“,
 * n = 1 „(1 Kurs)“, ohne gezählte Zahl nur „<title>“. Nicht fett.
 * @param {{title: string, count: number|null}} node
 * @param {"de"|"en"} lang
 * @returns {string}
 */
function overviewLinkText(node, lang) {
  const form = OVERVIEW_LINE[lang];
  if (!hasCount(node)) return node.title;
  const n = node.count;
  return `${node.title} (${formatCount(n, lang)} ${n === 1 ? form.one : form.many})`;
}

/**
 * Linktext zum Prüfen (S1): Leerraum zusammengefasst, höchstens
 * LABEL_MAX_LEN Codepunkte, ohne * und _ und Leerraum an den Enden.
 * @param {any} text
 * @returns {string}
 */
function linkLabel(text) {
  const flat = truncateCodePoints(
    String(text ?? "").replace(/\s+/g, " "),
    LABEL_MAX_LEN
  );
  let a = 0;
  let b = flat.length;
  while (a < b && "*_ ".includes(flat[a])) a += 1;
  while (b > a && "*_ ".includes(flat[b - 1])) b -= 1;
  return flat.slice(a, b);
}

/**
 * Kurszahl im Linktext entfernen (Regel 4): alte Form nur die Zahl („Alle 3
 * Kurse in X“ -> „Alle Kurse in X“), sonst die Angabe samt Klammer bzw.
 * Trenner davor. Ohne Zahl derselbe Text; bleibt nichts übrig, null.
 * @param {string} text - Linktext des Modells
 * @returns {string|null}
 */
function stripCourseCount(text) {
  const flat = String(text).replace(/\s+/g, " ");
  if ([...flat].length > LABEL_MAX_LEN) return text; // nie ein Übersichtstext
  const old = OVERVIEW_TEXT_RX.exec(linkLabel(flat));
  if (old) {
    if (!old[2]) return text;
    return flat.replace(` ${old[2]} `, " ");
  }
  const m = courseCount(flat);
  if (!m) return text;
  let from = m.index;
  let to = m.index + m[0].length;
  while (from > 0 && flat[from - 1] === " ") from -= 1;
  let after = to;
  while (after < flat.length && flat[after] === " ") after += 1;
  if (flat[from - 1] === "(" && flat[after] === ")") {
    from -= 1;
    to = after + 1;
  } else if (from > 0 && ",;:\u00b7\u2013\u2014-".includes(flat[from - 1])) {
    from -= 1;
  }
  while (from > 0 && flat[from - 1] === " ") from -= 1;
  const out = `${flat.slice(0, from)}${flat.slice(to)}`.replace(/ {2,}/g, " ");
  return linkLabel(out) ? out.trim() : null;
}

/**
 * Kurszahl im Linktext (COURSE_COUNT_RX), nur am Ende (COUNT_TAIL_RX).
 * @param {string} text
 * @returns {RegExpExecArray|null}
 */
function courseCount(text) {
  const m = COURSE_COUNT_RX.exec(text);
  return m && COUNT_TAIL_RX.test(text.slice(m.index + m[0].length)) ? m : null;
}

// Sprache der Zahl im Linktext: Wort der Kurszahl, sonst null
function countLang(count) {
  return count ? COUNT_WORD_LANG[count[2].toLowerCase()] ?? null : null;
}

/**
 * Linktext eines Knoten-Links (Regel 1): Titel aus der Karte; mit Sprache
 * de/en die Zahl nach E29; schreibt das Modell die Zahl mit einem Wort einer
 * anderen Sprache, bleibt dieses Wort (K1-D2), sonst nur der Titel.
 * @returns {string}
 */
function nodeLinkText(node, lang, count) {
  if (lang) return overviewLinkText(node, lang);
  if (count && hasCount(node))
    return `${node.title} (${node.count} ${count[2]})`;
  return node.title;
}

/**
 * Linktext gleich Titel des Knotens (R3-D4), normalisiert wie Kurstitel;
 * bei einem Titel mit Kette („Sport & Fitness · Kraft & Ausdauer“) zählt
 * auch die letzte Ebene.
 * @param {{title: string}} node
 * @param {string} text - Linktext des Modells
 * @returns {boolean}
 */
function isNodeTitle(node, text) {
  const key = courseTitleKey(text);
  if (!key) return false;
  if (courseTitleKey(node.title) === key) return true;
  const parts = node.title.split(" \u00b7 ");
  return parts.length > 1 && courseTitleKey(parts[parts.length - 1]) === key;
}

// Einleitung am Zeilenanfang (E29, de/en): Schmuck * _ # davor, * _ vor und
// nach dem Doppelpunkt (S5), je höchstens INTRO_DECOR_MAX Zeichen (die
// Einleitung passt so immer in INTRO_SCAN des Filters). Treffer
// {lang, length}, offen (Text endet mittendrin) oder null
const INTRO_PENDING = { pending: true };
const INTRO_DECOR_MAX = 8;
function matchOverviewIntro(head, final) {
  const s = String(head ?? "");
  let i = 0;
  while (i < s.length && i < INTRO_DECOR_MAX && "#*_ \t".includes(s[i])) i += 1;
  let pending = false;
  for (const lang of OVERVIEW_LANGS) {
    const intro = OVERVIEW_LINE[lang].intro.toLowerCase();
    const phrase = intro.endsWith(":") ? intro.slice(0, -1) : intro;
    let k = i;
    let j = 0;
    while (
      j < phrase.length &&
      k < s.length &&
      s[k].toLowerCase() === phrase[j]
    ) {
      j += 1;
      k += 1;
    }
    if (j < phrase.length) {
      if (k === s.length) pending = true;
      continue;
    }
    const gap = k + INTRO_DECOR_MAX;
    while (k < s.length && k < gap && "*_ \t".includes(s[k])) k += 1;
    if (k === s.length) {
      pending = true;
      continue;
    }
    if (s[k] !== ":") continue;
    k += 1;
    const close = k + INTRO_DECOR_MAX;
    while (k < s.length && k < close && "*_".includes(s[k])) k += 1;
    if (k === s.length && !final) return INTRO_PENDING;
    return { lang, length: k };
  }
  return pending && !final ? INTRO_PENDING : null;
}

/**
 * Prüfer für Links einer Antwort (R1-D1, Form E29). Eingaben: Kontexttexte,
 * wie das Modell sie bekam (mit Kette), System-Prompt, Verlauf (nur die
 * gespeicherten Assistenten-Antworten zählen) und Karte. Ohne Karte null
 * (keine Absicherung, Antwort unverändert).
 *
 * check(text, url, where) mit where = {overview, lineStart, autolink}:
 *   overview: Sprache der Übersichtszeile bzw. des Übersichtsblocks, in dem
 *     der Link steht, sonst null; lineStart: vor dem Link nur Schmuck;
 *   autolink: Link der Form <https://…> (Text = Adresse).
 * Ergebnis (dieselbe Entscheidung für Stream, Antwort und Speichern):
 *   null: unverändert;
 *   {remove: true}: entfernen;
 *   {remove: false, text, url, line}: Link „[text](url)“; url null = Ziel
 *     des Modells behalten; line = Sprache, wenn der Server die ganze Zeile
 *     setzt (Knoten-Link in alter Form am Zeilenanfang);
 *   {course: Kandidaten}: AK-21 ohne Bestätigung aus den Quellen (Stufe 2);
 *     der Filter hält den Link samt Text danach und fragt
 *     pickCourse(Kandidaten, Text nach dem Link) -> Kurs-Link oder null
 *     (Link unverändert).
 * intro(lang), separator und matchIntro dienen dem Stream-Filter zum Setzen
 * der Zeile (Form nur in OVERVIEW_LINE).
 * @param {{contextTexts?: string[], map: object|null, systemPrompt?: string, history?: {role: string, content: any}[]}} input
 * @returns {object|null}
 */
function createOverviewLinkGuard({
  contextTexts,
  map,
  systemPrompt = "",
  history = [],
} = {}) {
  if (!map) return null;
  const contextList = (Array.isArray(contextTexts) ? contextTexts : []).filter(
    (t) => typeof t === "string"
  );
  const context = contextList.join("\n");
  const known = new Set();
  const learn = (text) => {
    if (typeof text !== "string") return;
    for (const m of text.matchAll(CONTEXT_URL_RX)) {
      const key = linkKey(m[0]);
      if (key) known.add(key);
    }
  };
  learn(context);
  learn(systemPrompt);
  for (const entry of Array.isArray(history) ? history : [])
    if (entry?.role === "assistant") learn(entry.content);
  const courseLinks = new Set(
    [...context.matchAll(CONTEXT_COURSE_LINK_RX)]
      .map((m) => linkKey(m[1]))
      .filter(Boolean)
  );

  // Knoten zu einer Adresse: der, dessen Kettenzeile im Kontext zuerst
  // steht, sonst der mit dem kürzesten Pfad
  const nodeOf = (key) => {
    const candidates = key ? map.byUrl.get(key) : null;
    if (!candidates) return null;
    let best = candidates[0];
    let bestPos = Infinity;
    for (const node of candidates) {
      const pos = context.indexOf(
        `: ${node.title}${countLabel(node.count)} | ${node.url}`
      );
      if (pos !== -1 && pos < bestPos) {
        best = node;
        bestPos = pos;
      }
    }
    return best;
  };

  // Stufe 2 (R3-D1): Zeilen der Übersichtsseiten im Kontext (Texte ohne
  // „Kurs-Link:“), deren Text ein Titel oder Haupttitel aus course_links
  // ist; einmal je Prüfer, erst beim ersten Kandidaten
  let titleLines = null;
  const sourceTitleLines = () => {
    if (titleLines) return titleLines;
    titleLines = [];
    for (const doc of contextList) {
      if (COURSE_DOC_RX.test(doc)) continue;
      let start = 0;
      for (const line of doc.split("\n")) {
        const end = start + line.length;
        const key =
          line.length <= COURSE_TEXT_SCAN_MAX
            ? courseTitleKey(line.replace(SOURCE_LINE_HEAD_RX, ""))
            : null;
        if (key && map.courseTitles.has(key))
          titleLines.push({ doc, key, start, end });
        start = end + 1;
      }
    }
    return titleLines;
  };

  /**
   * Stufe 2 (R3-D1): Kurs-Link, wenn unter den exakten Kandidaten genau
   * einer mit Titel und Beginndatum in einer Übersichtsseite des Kontexts
   * steht. Beginndatum einer Titelzeile: erstes Datum danach (höchstens
   * SOURCE_DATE_SCAN Zeichen, nicht über die nächste solche Zeile). Nennt
   * eine Übersicht den Titel mit einem Datum keines Kandidaten (Kurs fehlt
   * in course_links), oder mehrere Kandidaten, gilt Stufe 2 nicht. Ebenso
   * nicht, wenn der Kurs-Link des Kandidaten im Kontext steht (das Modell
   * hatte ihn und verlinkt anders) oder die Adresse des Modells eine andere
   * Kursnummer gleicher Form trägt.
   * @returns {string|null}
   */
  const sourceConfirmed = (exact, url) => {
    if (exact.length === 0) return null;
    const keys = new Set(exact.flatMap((c) => [c.titleKey, c.mainKey]));
    const lines = sourceTitleLines().filter((l) => keys.has(l.key));
    let hit = null;
    for (const [i, line] of lines.entries()) {
      const next = lines.find((l, j) => j > i && l.doc === line.doc);
      const to = Math.min(
        line.end + SOURCE_DATE_SCAN,
        next ? next.start : line.doc.length
      );
      const { dates } = windowDates(line.doc.slice(line.end, to));
      if (dates.length === 0) continue;
      const first = dates.reduce((a, b) => (b.at < a.at ? b : a));
      const named = exact.filter(
        (c) =>
          (c.titleKey === line.key || c.mainKey === line.key) &&
          !!c.date &&
          sameDay(first, c.date)
      );
      const found = sameUrl(named);
      if (!found || (hit && hit.url !== found)) return null;
      hit = named[0];
    }
    if (!hit || courseLinks.has(linkKey(hit.url))) return null;
    const tokens = String(url).toLowerCase().match(NUMBER_TOKEN_RX) ?? [];
    return numberContradicts(hit, tokens) ? null : hit.url;
  };

  // AK-21: Kurstitel verlinkt auf eine Adresse, die kein Kurs-Link ist.
  // Nicht bei einem Knoten, dessen Titel der Linktext ist (Kategorie-Link,
  // Regel 1). Ergebnis: Link mit Kurs-Link (Stufe 2), {course} (der Filter
  // hält und entscheidet mit dem Text danach, pickCourse) oder null (kein
  // Kandidat).
  const courseVerdict = (text, url, key, node) => {
    if (key && (courseLinks.has(key) || map.courseUrls?.has(key))) return null;
    const candidates = courseCandidates(map, text);
    if (!candidates) return null;
    if (node && isNodeTitle(node, text)) return null;
    const sure = sourceConfirmed(candidates.exact, url);
    if (sure) return { remove: false, text, url: sure, line: null };
    return { course: candidates };
  };

  return {
    separator: OVERVIEW_LINE.separator,
    intro: (lang) => OVERVIEW_LINE[lang].intro,
    matchIntro: matchOverviewIntro,
    pickCourse: (candidates, windowText) =>
      pickCourseUrl(candidates, windowText, map),
    check(
      text,
      url,
      { overview = null, lineStart = false, autolink = false } = {}
    ) {
      const label = autolink ? "" : linkLabel(text);
      const old = OVERVIEW_TEXT_RX.exec(label);
      const count = old ? null : courseCount(label);
      const key = linkKey(url);
      const node = nodeOf(key);
      if (!overview && !autolink && !old && !count) {
        const course = courseVerdict(text, url, key, node);
        if (course) return course;
      }
      // Regel 1 nur für Kategorie-Links (R3-D4): Übersicht, alte Form,
      // Kurszahl oder Knotentitel; ein Kurstitel auf einer Knotenadresse
      // behält seinen Text (unten: ohne Übersicht und Zahl null)
      const categoryLike =
        overview || old || count || BARE_COUNT_RX.test(label);
      if (node && (categoryLike || isNodeTitle(node, text))) {
        const oldLang = old
          ? old[1].toLowerCase() === "alle"
            ? "de"
            : "en"
          : null;
        const lang = overview ?? oldLang ?? countLang(count);
        return {
          remove: false,
          text: nodeLinkText(node, lang, count),
          url: node.url,
          line: !overview && old && lineStart ? lang : null,
        };
      }
      if (!overview && !old && !count) return null;
      if (!key || !known.has(key)) return { remove: true };
      if (courseLinks.has(key) && (overview || old)) return { remove: true };
      if (autolink) return null;
      const stripped = stripCourseCount(text);
      if (stripped === null) return { remove: true };
      return stripped === text
        ? null
        : { remove: false, text: stripped, url: null, line: null };
    },
  };
}

module.exports = {
  CATEGORY_MAP_LABEL,
  validateCategoryMapSetting,
  loadCategoryMap,
  applyCategoryChains,
  buildChainedContext,
  createOverviewLinkGuard,
  categoryMapUpdatedAt,
  // nur für Tests
  __test__: {
    OVERVIEW_LINE,
    overviewLinkText,
    CATEGORY_MAP_MAX_BYTES,
    CATEGORY_MAP_MAX_AGE_MS,
    parseCategoryMap,
    normalizePart,
    pathParts,
    linkKey,
    linkLabel,
    stripCourseCount,
    matchOverviewIntro,
    chainText,
    courseTitleKey,
    pickCourseUrl,
    resetCache: () => {
      cached = { raw: null, map: null };
    },
  },
};
