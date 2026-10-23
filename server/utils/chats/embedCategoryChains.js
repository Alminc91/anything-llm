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
// Absicherung (createOverviewLinkGuard, Port von guard v2 aus dem Benchmark
// f3_parallel.py): Ein Übersichtslink wird entfernt, wenn seine Adresse ein
// Kurs-Link des Kontexts ist oder nirgends im Kontext steht; zeigt er auf
// einen Knoten der Karte, setzt der Server Titel und Zahl selbst ein. Der
// Stream-Filter dazu ist OverviewLinkFilter in embedCardsMarker.js.
// Form der Übersichtszeile (E29) nur in OVERVIEW_LINE und overviewLinkText:
//   Mehr Kurse zum Thema: [<title> (<n> Kurse)](<url>) · [<title>](<url>)
// Übersichtslink ist ein Markdown-Link (a) in einer Zeile, die mit der
// Einleitung beginnt (Schmuck davor zählt nicht), (b) mit dem alten Linktext
// „Alle [n] Kurse in …“/„All [n] courses in …“ oder (c) mit einem Knoten der
// Karte als Adresse außerhalb einer Aufzählung. Bei (a) und bei (b) am
// Zeilenanfang setzt der Server die ganze Zeile, bei (c) und (b) mitten im
// Text nur den Linktext.
//
// Ohne gültige Karte (fehlt, kein JSON, version ≠ 1, älter als 36 h) gibt es
// weder Kette noch Absicherung: Kontext und Antwort bleiben exakt wie vorher.

const prisma = require("../prisma");

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

// Absicherung: Übersichtslink und Adressen im Kontext (guard v2)
// (b) alte Form des Linktexts (Prompt bis v3.5)
const OVERVIEW_TEXT_RX = /^(alle|all)(\s+\d+)?\s+(kurse|courses)\s+in\b/i;
// Zahl in Klammern am Ende des Linktexts („Sport (12 Kurse)“, „Sport (12 cours)“)
const COUNT_PAREN_RX = /^(.*?)\s*\(\s*(\d+)\s*([^()\d]*?)\s*\)$/su;
const CONTEXT_URL_RX = /https?:\/\/[^\s)\]|"<>]+/g;
const CONTEXT_COURSE_LINK_RX = /^Kurs-Link:[ \t]*(\S+)/gm;

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
 * Vergleichsschlüssel einer Adresse: ohne Schrägstrich am Ende; Kategorie-
 * seiten „…/kategorie/<Name>/<Nr>“ und „…/kategorie/<Nr>“ gelten als gleich
 * (wie url_key im Benchmark).
 * @param {string} url
 * @returns {string}
 */
function urlKey(url) {
  const u = String(url ?? "").replace(/\/+$/, "");
  const m = /^(https?:\/\/[^/]+)(?:\/.*)?\/kategorie\/(?:[^/]+\/)?(\d+)$/.exec(
    u
  );
  return m ? `${m[1]}#kat${m[2]}` : u;
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
 * @returns {{createdMs: number, nodes: Map<string, object>, byUrl: Map<string, object[]>, courses: Map<string, string[]>}|null}
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
    const k = urlKey(node.url);
    if (!byUrl.has(k)) byUrl.set(k, []);
    byUrl.get(k).push(entry);
  }

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
  return { createdMs, updatedMs, nodes, byUrl, courses };
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

function countLabel(count) {
  if (count === null) return "";
  return count === 1 ? " (1 Kurs)" : ` (${count} Kurse)`;
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
  const candidates = source ? map.byUrl.get(urlKey(source[1])) : null;
  if (!candidates) return text;
  const node = candidates.reduce((best, n) =>
    n.parts.length < best.parts.length ? n : best
  );
  const chain = chainLines(node.parts, map);
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
 * Linktext eines Übersichtslinks auf einen Knoten (E29): „<title> (<n> Kurse)“,
 * n = 1 „(1 Kurs)“, ohne gezählte Zahl nur „<title>“. Nicht fett.
 * @param {{title: string, count: number|null}} node
 * @param {"de"|"en"} lang
 * @returns {string}
 */
function overviewLinkText(node, lang) {
  const form = OVERVIEW_LINE[lang];
  const n = node.count;
  if (n === null || n < 1) return node.title;
  return `${node.title} (${n} ${n === 1 ? form.one : form.many})`;
}

// Sprache der Zahl in Klammern („12 Kurse“ -> de, „12 courses“ -> en)
function langOfCountWord(word) {
  const w = word.toLowerCase();
  return OVERVIEW_LANGS.find(
    (lang) =>
      w === OVERVIEW_LINE[lang].one.toLowerCase() ||
      w === OVERVIEW_LINE[lang].many.toLowerCase()
  );
}

/**
 * (c) Linktext eines Knoten-Links ohne Einleitung: nur mit Zahl in Klammern
 * am Ende neu gesetzt (Titel aus der Karte, Zahl ersetzt oder entfernt; Wort
 * einer anderen Sprache bleibt), sonst unverändert (Fließtext bleibt heil).
 * @returns {string}
 */
function nodeLinkText(text, label, node) {
  const paren = COUNT_PAREN_RX.exec(label);
  if (!paren) return text;
  const lang = langOfCountWord(paren[3]);
  if (lang) return overviewLinkText(node, lang);
  if (node.count === null || node.count < 1) return node.title;
  return `${node.title} (${node.count}${paren[3] ? ` ${paren[3]}` : ""})`;
}

// Erkennen der Einleitung am Zeilenanfang: Treffer, noch offen (Text endet
// mitten in der Einleitung) oder nichts
const INTRO_PENDING = { pending: true };
function matchOverviewIntro(head, final) {
  const lower = String(head ?? "").toLowerCase();
  for (const lang of OVERVIEW_LANGS) {
    const intro = OVERVIEW_LINE[lang].intro.toLowerCase();
    if (lower.startsWith(intro)) return { lang, length: intro.length };
  }
  if (final) return null;
  for (const lang of OVERVIEW_LANGS) {
    const intro = OVERVIEW_LINE[lang].intro.toLowerCase();
    if (lower.length < intro.length && intro.startsWith(lower))
      return INTRO_PENDING;
  }
  return null;
}

/**
 * Prüfer für Übersichtslinks einer Antwort (guard v2, Form E29). Eingaben:
 * die Kontexttexte, wie das Modell sie bekam (mit Kette), und die Karte. Ohne
 * Karte null (keine Absicherung, Antwort unverändert).
 *
 * check(text, url, where) mit where = {lang, lineStart, enumeration}:
 *   lang: Sprache der Einleitung, wenn der Link in einer Zeile „Mehr Kurse
 *     zum Thema: …“ steht (a); lineStart: vor dem Link nur Schmuck;
 *   enumeration: Zeile ist ein Aufzählungspunkt („1. “, „- “, „• “ …).
 * Ergebnis:
 *   null: kein Übersichtslink, unverändert;
 *   {remove: true}: Link (am Zeilenanfang samt Zeile) entfernen;
 *   {remove: true, plain}: (c) nur den Link durch plain ersetzen (steht
 *     er allein in seiner Zeile, entfällt die Zeile);
 *   {remove: false, text, line}: Linktext text; line = Sprache, wenn der
 *     Server die ganze Zeile setzt ((b) am Zeilenanfang).
 * intro(lang), separator und matchIntro dienen dem Stream-Filter zum Setzen
 * der Zeile (Form nur in OVERVIEW_LINE).
 * @param {{contextTexts: string[], map: object|null}} input
 * @returns {object|null}
 */
function createOverviewLinkGuard({ contextTexts, map } = {}) {
  if (!map) return null;
  const context = (Array.isArray(contextTexts) ? contextTexts : [])
    .filter((t) => typeof t === "string")
    .join("\n");
  const seen = new Set(
    (context.match(CONTEXT_URL_RX) ?? []).map((u) => urlKey(u))
  );
  const courseLinks = new Set(
    [...context.matchAll(CONTEXT_COURSE_LINK_RX)].map((m) => urlKey(m[1]))
  );

  // Knoten zu einer Adresse: der, dessen Kettenzeile im Kontext steht (erste
  // Fundstelle), sonst der mit dem kürzesten Pfad
  const nodeOf = (url) => {
    const candidates = map.byUrl.get(urlKey(url));
    if (!candidates) return null;
    let best = null;
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
    return (
      best ??
      candidates.reduce((a, n) => (n.parts.length < a.parts.length ? n : a))
    );
  };

  return {
    separator: OVERVIEW_LINE.separator,
    intro: (lang) => OVERVIEW_LINE[lang].intro,
    matchIntro: matchOverviewIntro,
    check(
      text,
      url,
      { lang = null, lineStart = false, enumeration = false } = {}
    ) {
      const label = String(text ?? "").replace(/^[*\s]+|[*\s]+$/g, "");
      const old = OVERVIEW_TEXT_RX.exec(label);
      const key = urlKey(url);
      const isNode = map.byUrl.has(key);
      const kind = lang
        ? "line"
        : old
          ? "old"
          : isNode && !enumeration
            ? "node"
            : null;
      if (!kind) return null;
      if (courseLinks.has(key) || !seen.has(key)) {
        if (kind !== "node") return { remove: true };
        const plain = COUNT_PAREN_RX.exec(label)?.[1] ?? label;
        return { remove: true, plain };
      }
      const node = isNode ? nodeOf(url) : null;
      if (!node) return { remove: false, text, line: null };
      if (kind === "node")
        return {
          remove: false,
          text: nodeLinkText(text, label, node),
          line: null,
        };
      const textLang = lang ?? (old[1].toLowerCase() === "alle" ? "de" : "en");
      return {
        remove: false,
        text: overviewLinkText(node, textLang),
        line: kind === "old" && lineStart ? textLang : null,
      };
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
    urlKey,
    chainText,
    resetCache: () => {
      cached = { raw: null, map: null };
    },
  },
};
