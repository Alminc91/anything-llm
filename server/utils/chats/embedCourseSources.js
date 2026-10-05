// Kurskarten im Embed-Widget (opt-in über visual_config.courseCards = "auto").
//
// Das Widget bekommt die Quellen einer Antwort bewusst NICHT (sources: [] im
// Stream, Historie ohne sources) — Kontext-Schnipsel dürfen Endnutzer nie
// sehen. Für die Kurskarten wird daraus eine schmale Liste `courseSources`
// abgeleitet, die ausschließlich die Kurs-Metadaten der Whitelist enthält
// (COURSE_SOURCE_FIELDS), niemals text/pageContent/chunkSource/docSource.
//
// Datenlage der Flotte: Die Kursdokumente kommen per raw-text-Upload nur mit
// metadata.title (Datei-Slug) + den KIE-480-Spalten. Der Collector macht daraus
// url = "file://<slug>.txt" und title = "<slug>.txt" — beides taugt nicht für
// eine Karte. Die echte Kursseite und der Kurstitel stehen im Kursdokument in
// den festen Kopfzeilen "Titel: …" und "Kurs-Link: …" (Extraktor). Deshalb
// werden NUR diese zwei Zeilen serverseitig gelesen; ausgegeben werden nur
// url und title, nie der Text selbst.
//
// Kurs = Eintrag mit gültiger Kurs-URL (Kopfzeile "Kurs-Link:" oder http(s)-/
// web://…website-Metadaten) UND Titel. Datum/Wochentage/Preis usw. sind reine
// Anreicherung — Kunden ohne KIE-480-Spalten bekommen trotzdem Karten.
// Gecrawlte Info-/Kategorieseiten (nur chunkSource "link://…", kein
// "Kurs-Link:") sind keine Kurse.
//
// Folge-Issue: typisierte Metadaten course_url/course_title beim Upload
// (Collector + Pipeline) würden das Lesen der Kopfzeilen und die
// web://…website-Rückübersetzung überflüssig machen.

const path = require("path");
const {
  ISO_DATE_RX,
  WEEKDAYS_COLUMN_RX,
  LOCATION_RX,
  FORMATS,
  isValidStartMinutes,
} = require("./courseMetadataSchema");

const COURSE_SOURCE_FIELDS = Object.freeze([
  "url",
  "title",
  "start_date",
  "end_date",
  "start_minutes",
  "weekdays",
  "price",
  "bookable",
  "format",
  "location",
]);
const COURSE_SOURCES_MAX = 12;
const URL_MAX_LEN = 500;
const TITLE_MAX_LEN = 200;

const FILENAME_TITLE_RX = /\.(txt|html?|json|pdf|md|csv|docx?)$/i;
// Feste Kopfzeilen des Kursdokuments (Extraktor) — nur am Zeilenanfang, nur
// die erste Fundstelle.
const COURSE_LINK_HEADER_RX = /^Kurs-Link:[ \t]*(.+)$/m;
const TITLE_HEADER_RX = /^Titel:[ \t]*(.+)$/m;
// Collector processRawText: metadata.url (http/https) wird als
// "web://<url in Kleinbuchstaben>.website" gespeichert.
const WEB_WEBSITE_URL_RX = /^web:\/\/(https?:\/\/.+)\.website$/i;

// Typprüfung je Feld (gemeinsames Schema mit searchFilters.js / Collector):
// gültig -> normalisierter Wert, sonst undefined (Feld fällt weg).
const FIELD_VALIDATORS = {
  url: (v) => httpUrl(v),
  title: (v) => cleanTitle(v),
  start_date: (v) =>
    typeof v === "string" && ISO_DATE_RX.test(v) ? v : undefined,
  end_date: (v) =>
    typeof v === "string" && ISO_DATE_RX.test(v) ? v : undefined,
  start_minutes: (v) => {
    const n = typeof v === "bigint" ? Number(v) : v;
    return isValidStartMinutes(n) ? n : undefined;
  },
  weekdays: (v) =>
    typeof v === "string" && WEEKDAYS_COLUMN_RX.test(v) ? v : undefined,
  price: (v) =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined,
  bookable: (v) => (typeof v === "boolean" ? v : undefined),
  format: (v) => (typeof v === "string" && FORMATS.includes(v) ? v : undefined),
  location: (v) => {
    if (typeof v !== "string") return undefined;
    const normalized = v.trim().toLowerCase();
    return LOCATION_RX.test(normalized) ? normalized : undefined;
  },
};

function httpUrl(value) {
  if (typeof value !== "string") return undefined;
  const v = value.trim();
  if (v.length === 0 || v.length > URL_MAX_LEN) return undefined;
  try {
    const u = new URL(v);
    if (!["http:", "https:"].includes(u.protocol)) return undefined;
    return u.toString();
  } catch {
    return undefined;
  }
}

// Kurs-URL aus den Metadaten: echte http(s)-URL oder die Collector-Form
// "web://<url>.website" (zurückübersetzt; Achtung: der Collector speichert
// die URL kleingeschrieben). file://-Slugs sind nie eine Kurs-URL.
function metadataUrl(value) {
  const direct = httpUrl(value);
  if (direct) return direct;
  if (typeof value !== "string") return undefined;
  const m = WEB_WEBSITE_URL_RX.exec(value.trim());
  return m ? httpUrl(m[1]) : undefined;
}

// Überlange Titel werden gekürzt (an einer Wortgrenze, mit "…"), nicht
// verworfen — sonst fiele der ganze Kurs weg.
function cleanTitle(value) {
  if (typeof value !== "string") return undefined;
  const v = value.replace(/\s+/g, " ").trim();
  if (v.length === 0) return undefined;
  if (v.length <= TITLE_MAX_LEN) return v;
  const cut = v.slice(0, TITLE_MAX_LEN - 1);
  const atWord = cut.replace(/\s+\S*$/, "");
  return `${(atWord.length > 0 ? atWord : cut).trimEnd()}…`;
}

/**
 * Ist die Kurskarten-Option für dieses Embed eingeschaltet?
 * visual_config ist in der DB ein JSON-String (embed_configs.visual_config).
 * @param {{visual_config?: string|object|null}} embed
 * @returns {boolean}
 */
function courseCardsEnabled(embed = {}) {
  let config = embed?.visual_config ?? null;
  if (typeof config === "string") {
    try {
      config = JSON.parse(config);
    } catch (e) {
      console.error("[courseCardsEnabled] visual_config unparsable", e.message);
      return false;
    }
  }
  const value = config?.courseCards;
  return typeof value === "string" && value.trim().toLowerCase() === "auto";
}

function headerLine(text, rx) {
  if (typeof text !== "string" || text.length === 0) return undefined;
  const m = rx.exec(text);
  return m ? m[1].trim() : undefined;
}

// Kurs-URL eines Chunks: Metadaten-URL hat Vorrang, sonst "Kurs-Link:".
function courseUrlFromChunk(source) {
  return (
    metadataUrl(source?.url) ||
    httpUrl(headerLine(source?.text, COURSE_LINK_HEADER_RX))
  );
}

function titleFromChunk(source) {
  const fromHeader = cleanTitle(headerLine(source?.text, TITLE_HEADER_RX));
  if (fromHeader) return fromHeader;
  // metadata.title nur, wenn es kein Dateiname/Slug ist
  const title = cleanTitle(source?.title);
  if (title && !FILENAME_TITLE_RX.test(title)) return title;
  return undefined;
}

// Ersatz-Schlüssel für Folge-Chunks ohne Kopfzeilen (docId entfernt Lance):
// chunkSource, sonst id, erst zuletzt title (Dateiname — mehrdeutig, wenn
// zwei Kurse denselben Dateinamen haben).
function fallbackKey(source) {
  for (const field of ["chunkSource", "id", "title"]) {
    const value = source?.[field];
    if (typeof value === "string" && value.length > 0)
      return `${field}:${value}`;
  }
  return undefined;
}

/**
 * Whitelist eines Eintrags: nur COURSE_SOURCE_FIELDS, typgeprüft.
 * Nicht-Objekte (Altdaten wie "x", 1, true) ergeben {}.
 * @param {any} entry
 * @returns {object}
 */
function pickCourseFields(entry) {
  if (!entry || typeof entry !== "object") return {};
  const out = {};
  for (const key of COURSE_SOURCE_FIELDS) {
    if (!(key in entry)) continue;
    const value = FIELD_VALIDATORS[key](entry[key]);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

// Kurs = gültige Kurs-URL + Titel; Datum/Wochentage sind Anreicherung.
function isCourseEntry(entry) {
  return !!entry?.url && !!entry?.title;
}

/**
 * Kurs-Eintrag je Quelle (gleiche Reihenfolge wie `sources`): nur Kurs-
 * dokumente (Kurs-URL + Titel), Whitelist-Felder; sonst undefined. Folge-
 * Chunks ohne Kopfzeilen erben die Kurs-URL über den Ersatz-Schlüssel, aber
 * nur, wenn er eindeutig auf genau eine Kurs-URL zeigt.
 * @param {object[]} sources - sources wie in streamChatWithForEmbed (inkl. text)
 * @returns {(object|undefined)[]}
 */
function courseEntriesBySource(sources = []) {
  if (!Array.isArray(sources) || sources.length === 0) return [];
  const isChunk = (s) => !!s && typeof s === "object";

  // 1) Gruppierung über die Kurs-URL (nur der erste Chunk eines Kurs-
  //    dokuments trägt "Titel:"/"Kurs-Link:").
  const titleByUrl = new Map();
  const urlsByFallback = new Map();
  const chunkUrls = sources.map((source) => {
    if (!isChunk(source)) return undefined;
    const url = courseUrlFromChunk(source);
    if (!url) return undefined;
    const title = titleFromChunk(source);
    if (title && !titleByUrl.has(url)) titleByUrl.set(url, title);
    const key = fallbackKey(source);
    if (key) {
      if (!urlsByFallback.has(key)) urlsByFallback.set(key, new Set());
      urlsByFallback.get(key).add(url);
    }
    return url;
  });

  // 2) Eintrag je Quelle, Whitelist
  return sources.map((source, index) => {
    if (!isChunk(source)) return undefined;
    let url = chunkUrls[index];
    if (!url) {
      const candidates = urlsByFallback.get(fallbackKey(source));
      if (candidates?.size === 1) [url] = candidates;
    }
    if (!url) return undefined;
    const { url: _url, title: _title, ...meta } = source;
    const entry = pickCourseFields({
      ...meta,
      url,
      title: titleByUrl.get(url) || titleFromChunk(source),
    });
    return isCourseEntry(entry) ? entry : undefined;
  });
}

/**
 * Leitet aus den gesammelten Quellen einer Embed-Antwort die Kurskarten-
 * Metadaten ab: nur Kursdokumente (Kurs-URL + Titel), Whitelist-Felder,
 * Dedupe über url (erster gewinnt), höchstens 12.
 * @param {object[]} sources - sources wie in streamChatWithForEmbed (inkl. text)
 * @returns {object[]} courseSources
 */
function buildCourseSources(sources = []) {
  return mergeCourseSources(courseEntriesBySource(sources));
}

/**
 * Listen von Kurs-Einträgen zusammenführen: Reihenfolge bleibt, Dedupe über
 * die normalisierte URL (erster gewinnt), höchstens 12. Nie zwei Karten für
 * dieselbe URL.
 * @param {...(object|undefined)[]} lists
 * @returns {object[]}
 */
function mergeCourseSources(...lists) {
  const seen = new Set();
  const out = [];
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      if (out.length >= COURSE_SOURCES_MAX) return out;
      if (!isCourseEntry(entry)) continue;
      const key = urlKey(entry.url);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(entry);
    }
  }
  return out;
}

/**
 * Bereits gespeicherte courseSources (Historie) nochmals auf die Whitelist
 * reduzieren — Abwehr in der Tiefe, falls je ein Altbestand mehr enthielte.
 * Gespeichert wurden nur Einträge, die beim Erzeugen als Kurs galten.
 * @param {any} list
 * @returns {object[]}
 */
function sanitizeCourseSources(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const item of list) {
    if (out.length >= COURSE_SOURCES_MAX) break;
    const entry = pickCourseFields(item);
    if (!isCourseEntry(entry) || seen.has(entry.url)) continue;
    seen.add(entry.url);
    out.push(entry);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Kurskarten v2: verlinkte Kurse ohne Treffer-Dokument nachschlagen
// ---------------------------------------------------------------------------
// Der Bot verlinkt oft Kurse, deren Kursdokument nicht unter den Treffern war
// (Link stammt z. B. aus einer Kategorieseite). Für solche Links wird das
// Kursdokument über die Dokumentliste des Workspaces gefunden (Dateiname =
// "raw-" + url_slugify(Kurs-URL) [+ "-" + Inhalts-Hash] + "-" + UUID + ".json",
// Pipeline manifest.py make_filename) und nur seine Metadaten + Kopfzeilen
// "Titel:"/"Kurs-Link:" gelesen. Keine Vektorsuche, keine LLM-Anfrage.
// Grenzen: höchstens COURSE_LOOKUPS_MAX Dateizugriffe je Antwort (Cache je
// Antwort), Gesamtliste höchstens COURSE_SOURCES_MAX, nur Dateien innerhalb
// von documents/<ordner>/, Eintrag nur mit der Whitelist (nie text).

const COURSE_LOOKUPS_MAX = 5;
const SLUG_MAX_LEN = 150; // manifest.py: url_slugify(url, max_length=150)
const SLUG_RX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DOC_SEGMENT_RX = /^[A-Za-z0-9._-]+$/;
const UUID_PART =
  "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const HEADER_SCAN_LEN = 4000; // Kopfzeilen stehen am Dokumentanfang

// Links der Antwort (wie das Widget, src/utils/courseCards.js extractLinks):
// [Text](url), <a href="url">, nackte URLs.
const MD_LINK_RX =
  /\[([^\]]*)\]\(\s*<?(https?:\/\/(?:[^\s()<>]|\([^\s()<>]*\))+)>?(?:\s+"[^"]*")?\s*\)/g;
const ANCHOR_RX = /<a\s[^>]*href=["'](https?:\/\/[^"']+)["'][^>]*>/gi;
const BARE_URL_RX = /<?(https?:\/\/[^\s<>"'\]]+)>?/g;

// Satzzeichen am URL-Ende abschneiden; ")" nur, wenn sie keine "(" in der
// URL schließt.
function trimUrlTail(url) {
  let u = url.replace(/[.,;:!?*_]+$/, "");
  const count = (ch) => u.split(ch).length - 1;
  while (u.endsWith(")") && count(")") > count("("))
    u = u.slice(0, -1).replace(/[.,;:!?*_]+$/, "");
  return u;
}

/**
 * http(s)-Links einer Antwort in Reihenfolge ihres Vorkommens (ohne Dubletten).
 * @param {string} replyText
 * @returns {string[]}
 */
function extractReplyLinks(replyText = "") {
  const text = typeof replyText === "string" ? replyText : "";
  const found = [];
  const push = (url, index) => {
    const clean = trimUrlTail(url);
    if (httpUrl(clean)) found.push({ url: clean, index });
  };
  for (const m of text.matchAll(MD_LINK_RX)) push(m[2], m.index);
  for (const m of text.matchAll(ANCHOR_RX)) push(m[1], m.index);
  const blank = (m) => " ".repeat(m.length);
  const rest = text.replace(MD_LINK_RX, blank).replace(ANCHOR_RX, blank);
  for (const m of rest.matchAll(BARE_URL_RX)) push(m[1], m.index);
  const seen = new Set();
  return found
    .sort((a, b) => a.index - b.index)
    .map((l) => l.url)
    .filter((url) => {
      const key = urlKey(url);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

// Vergleichsschlüssel einer URL (wie das Widget): Schema, "www.", Fragment,
// Schluss-Slash und Groß-/Kleinschreibung egal.
function urlKey(value) {
  const url = httpUrl(value);
  if (!url) return null;
  const u = new URL(url);
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  return `${host}${u.pathname.replace(/\/+$/, "")}${u.search}`.toLowerCase();
}

function hostKey(value) {
  const url = httpUrl(value);
  return url ? new URL(url).hostname.toLowerCase().replace(/^www\./, "") : null;
}

// Transliteration wie unidecode für die Zeichen, die NFKD nicht zerlegt
const TRANSLIT = {
  ß: "ss",
  ẞ: "SS",
  æ: "ae",
  Æ: "AE",
  ø: "o",
  Ø: "O",
  œ: "oe",
  Œ: "OE",
  ł: "l",
  Ł: "L",
  đ: "d",
  Đ: "D",
  ð: "d",
  Ð: "D",
  þ: "th",
  Þ: "TH",
  ı: "i",
  "€": "EUR",
};
const HTML_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/**
 * Nachbau von python-slugify 8 (`slugify(url, max_length=150)`, Pipeline
 * manifest.py make_filename) inkl. removeprefix("https-"/"http-").
 * @param {string} url
 * @returns {string} Slug aus [a-z0-9-] (leer, wenn nichts übrig bleibt)
 */
function urlSlugify(url, { maxLength = SLUG_MAX_LEN } = {}) {
  if (typeof url !== "string") return "";
  let text = url
    .replace(/[^\x00-\x7F]/g, (ch) => TRANSLIT[ch] ?? ch)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/'+/g, "-")
    .toLowerCase()
    .replace(/(\d),(?=\d)/g, "$1")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/g, (m, ent) => {
      if (ent.startsWith("#x"))
        return String.fromCodePoint(parseInt(ent.slice(2), 16) || 32);
      if (ent.startsWith("#"))
        return String.fromCodePoint(Number(ent.slice(1)) || 32);
      return HTML_ENTITIES[ent] ?? m;
    })
    .replace(/[^-a-z0-9]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  text = text.slice(0, maxLength).replace(/^-+|-+$/g, "");
  for (const prefix of ["https-", "http-"])
    if (text.startsWith(prefix)) return text.slice(prefix.length);
  return text;
}

function escapeRx(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Sicherer Dateipfad eines Workspace-Dokuments: nur "<ordner>/<datei>.json"
 * aus [A-Za-z0-9._-], kein "..", Ergebnis liegt innerhalb von
 * documents/<ordner>/. Sonst null.
 * @param {string} docpath
 * @param {string} documentsPath
 * @returns {string|null}
 */
function safeDocumentFile(docpath, documentsPath) {
  if (typeof docpath !== "string" || typeof documentsPath !== "string")
    return null;
  const parts = docpath.split("/");
  if (parts.length !== 2) return null;
  const [folder, file] = parts;
  if (!DOC_SEGMENT_RX.test(folder) || !DOC_SEGMENT_RX.test(file)) return null;
  if (folder.startsWith(".") || file.startsWith(".") || !file.endsWith(".json"))
    return null;
  const folderPath = path.resolve(documentsPath, folder);
  const full = path.resolve(folderPath, file);
  if (path.dirname(full) !== folderPath) return null;
  if (!folderPath.startsWith(path.resolve(documentsPath) + path.sep))
    return null;
  return full;
}

function docFileName(docpath) {
  return typeof docpath === "string" ? docpath.split("/").pop() : "";
}

/**
 * Kurs-Eintrag aus einer gelesenen Dokument-JSON: Metadaten-Spalten + die
 * Kopfzeilen "Titel:"/"Kurs-Link:" (nur aus dem Dokumentanfang), Whitelist.
 * Kein Kurs (keine Kurs-URL oder kein Titel) -> null.
 * @param {object} doc
 * @returns {object|null}
 */
function courseEntryFromDocument(doc) {
  if (!doc || typeof doc !== "object") return null;
  const head =
    typeof doc.pageContent === "string"
      ? doc.pageContent.slice(0, HEADER_SCAN_LEN)
      : "";
  const url = httpUrl(headerLine(head, COURSE_LINK_HEADER_RX));
  const title = cleanTitle(headerLine(head, TITLE_HEADER_RX));
  if (!url || !title) return null;
  const { url: _u, title: _t, pageContent: _p, ...meta } = doc;
  const entry = pickCourseFields({ ...meta, url, title });
  return isCourseEntry(entry) ? entry : null;
}

function defaultLookupDeps() {
  const fs = require("fs");
  return {
    // nur die Dateipfade der Workspace-Dokumente (keine Metadaten-Spalten)
    listDocpaths: async (workspace) => {
      if (!workspace?.id) return [];
      const { Document } = require("../../models/documents");
      const rows = await Document.where(
        { workspaceId: workspace.id },
        null,
        null,
        null,
        { docpath: true }
      );
      return (rows || []).map((row) => row.docpath);
    },
    readFile: (fullPath) => fs.promises.readFile(fullPath, "utf8"),
    documentsPath: () => require("../files").documentsPath,
  };
}

/**
 * Nachschlag-Kontext einer Antwort: Dokumentliste (einmal, erst bei Bedarf),
 * Cache je Dokument, Zähler der Dateizugriffe (höchstens COURSE_LOOKUPS_MAX).
 * Wird für Marker-Auflösung und Antwort-Links gemeinsam benutzt.
 * @param {{workspace?: object, deps?: object}} options
 */
function createCourseLookup({ workspace = null, deps = {} } = {}) {
  const d = { ...defaultLookupDeps(), ...deps };
  let docpathsPromise = null;
  const cache = new Map(); // docpath -> Promise<entry|null>
  const stats = { reads: 0, cacheHits: 0, listed: false };

  const docpaths = () => {
    if (!docpathsPromise) {
      stats.listed = true;
      docpathsPromise = Promise.resolve(d.listDocpaths(workspace))
        .then((list) => (Array.isArray(list) ? list : []))
        .catch((e) => {
          console.error("[courseLookup] Dokumentliste:", e.message);
          return [];
        });
    }
    return docpathsPromise;
  };

  // Dokument lesen (gecacht); null = kein Kurs/unlesbar, undefined = Limit
  const read = (docpath) => {
    if (cache.has(docpath)) {
      stats.cacheHits++;
      return cache.get(docpath);
    }
    if (stats.reads >= COURSE_LOOKUPS_MAX) return Promise.resolve(undefined);
    const base =
      typeof d.documentsPath === "function"
        ? d.documentsPath()
        : d.documentsPath;
    const full = safeDocumentFile(docpath, base);
    if (!full) {
      cache.set(docpath, Promise.resolve(null));
      return cache.get(docpath);
    }
    stats.reads++;
    const promise = Promise.resolve()
      .then(() => d.readFile(full))
      .then((raw) => courseEntryFromDocument(JSON.parse(raw)))
      .catch((e) => {
        console.error("[courseLookup] Dokument nicht lesbar:", e.message);
        return null;
      });
    cache.set(docpath, promise);
    return promise;
  };

  return {
    stats,
    exhausted: () => stats.reads >= COURSE_LOOKUPS_MAX,
    docpaths,
    read,
  };
}

// Kursnummer-Segment einer Kurs-URL: das letzte Pfadsegment, das mindestens
// so viele Ziffern wie Buchstaben hat ("262-3208", "26225121S", "XI91137",
// Wolfsburg ".../kurs/261305028/kursname/<titel>"); sonst das letzte Segment.
function courseNumberSegment(pathname) {
  const segs = pathname.split("/").filter(Boolean);
  if (segs.length === 0) return null;
  const decode = (seg) => {
    try {
      return decodeURIComponent(seg);
    } catch {
      return seg;
    }
  };
  const numeric = segs.filter((seg) => {
    const digits = (seg.match(/\d/g) || []).length;
    const letters = (seg.match(/[a-z]/gi) || []).length;
    return digits > 0 && digits >= letters;
  });
  return urlSlugify(decode(numeric.length ? numeric.pop() : segs.pop()));
}

function pathSegments(url) {
  const clean = httpUrl(url);
  if (!clean) return [];
  return new URL(clean).pathname.toLowerCase().split("/").filter(Boolean);
}

// Kurs-Pfadpräfix aus vorhandenen Kurs-URLs: gemeinsamer Pfadanfang der
// URLs ohne ihre letzten zwei Segmente (Slug + Kursnummer), mindestens das
// erste Segment (wie das Widget, src/utils/courseCards.js).
function knownCoursePrefix(courseUrls = []) {
  let prefix = null;
  for (const url of courseUrls) {
    const segs = pathSegments(url).slice(0, -2);
    if (segs.length === 0) continue;
    if (prefix === null) prefix = segs;
    else {
      let i = 0;
      while (i < prefix.length && i < segs.length && prefix[i] === segs[i]) i++;
      prefix = prefix.slice(0, i);
    }
  }
  return prefix && prefix.length > 0 ? prefix : null;
}

// Sieht der Link wie eine Kursseite aus? Unter dem bekannten Kurs-Pfad oder
// mit einem kursnummerartigen Segment (Ziffern >= Buchstaben). Kategorie-
// und Info-Seiten ("/programm/gesundheit") verursachen so keinen Zugriff.
function looksLikeCoursePage(url, prefix) {
  const segs = pathSegments(url);
  if (
    prefix &&
    segs.length > prefix.length &&
    prefix.every((seg, i) => segs[i] === seg)
  )
    return true;
  return segs.some((seg) => {
    const digits = (seg.match(/\d/g) || []).length;
    const letters = (seg.match(/[a-z]/g) || []).length;
    return digits > 0 && digits >= letters;
  });
}

// Schreibweisen der URL, unter denen die Pipeline den Dateinamen gebildet
// haben kann: roh, URI-dekodiert, jeweils mit und ohne "www."
function urlVariants(url) {
  const raw = url.trim().split("#")[0];
  const variants = [raw];
  try {
    variants.push(decodeURI(raw));
  } catch {
    /* ungültige Prozent-Kodierung: nur Rohform */
  }
  for (const v of [...variants])
    variants.push(v.replace(/^(https?:\/\/)www\./i, "$1"));
  return [...new Set(variants)];
}

/**
 * Kandidaten-Dokumente zu einer Kurs-URL. Dateiname =
 * [raw-]<slug>[-<hash16>]-<uuid>.json, wobei <slug> = url_slugify(URL) und
 * das Kursnummer-Segment enthalten sein muss. Ist der Slug länger als 150
 * Zeichen, kürzt die Pipeline ihn (Kursnummer fällt weg) — dann sind alle
 * Dokumente mit dem gekürzten Slug Kandidaten; der Aufrufer prüft nach dem
 * Lesen, dass "Kurs-Link:" genau diese URL ist.
 * @param {string} url
 * @param {string[]} docpaths
 * @returns {string[]} Kandidaten (exakte zuerst), leer = kein Treffer
 */
function findDocpathCandidates(url, docpaths = []) {
  const clean = httpUrl(url);
  if (!clean || !Array.isArray(docpaths)) return [];
  const numberSlug = courseNumberSegment(new URL(clean).pathname);
  if (!numberSlug || !SLUG_RX.test(numberSlug)) return [];
  // Slug-Formen: url_slugify der Schreibweise (gekürzt auf 150 inkl.
  // "https-"), zusätzlich ohne führendes "www-" (die Pipeline entfernt es
  // erst nach dem Kürzen).
  const slugForms = [];
  for (const variant of urlVariants(url)) {
    const slug = urlSlugify(variant);
    const truncated =
      urlSlugify(variant, { maxLength: Infinity }).length > slug.length;
    slugForms.push({ slug, truncated });
    if (slug.startsWith("www-"))
      slugForms.push({ slug: slug.slice(4), truncated });
  }
  const exact = [];
  const truncated = [];
  for (const form of slugForms) {
    if (!form.slug || !SLUG_RX.test(form.slug)) continue;
    const rx = new RegExp(
      `^(?:raw-)?${escapeRx(form.slug)}(?:-[0-9a-f]{16})?-${UUID_PART}\\.json$`
    );
    for (const dp of docpaths) {
      const file = docFileName(dp);
      if (!rx.test(file)) continue;
      if (file.includes(numberSlug)) exact.push(dp);
      else if (form.truncated) truncated.push(dp);
    }
  }
  return [...new Set([...exact, ...truncated])];
}

/** Erstes Kandidaten-Dokument zu einer Kurs-URL (siehe findDocpathCandidates). */
function findDocpathForUrl(url, docpaths = []) {
  return findDocpathCandidates(url, docpaths)[0] || null;
}

/**
 * Dokument zu einem Treffer-Chunk ohne Kopfzeilen (Folge-Chunk eines Kurs-
 * dokuments): metadata.title ist der Upload-Dateiname "<slug>.txt".
 * @param {object} source
 * @param {string[]} docpaths
 * @returns {string|null}
 */
function findDocpathForChunk(source, docpaths = []) {
  const title = typeof source?.title === "string" ? source.title.trim() : "";
  const base = title.replace(/\.txt$/i, "").toLowerCase();
  if (!base || !SLUG_RX.test(base)) return null;
  const rx = new RegExp(`^(?:raw-)?${escapeRx(base)}-${UUID_PART}\\.json$`);
  return docpaths.find((dp) => rx.test(docFileName(dp))) || null;
}

/**
 * Ergänzt courseSources um Kurse, die die Antwort verlinkt, deren Kurs-
 * dokument aber nicht unter den Treffern war. Nur Links auf der Kunden-
 * domain (Host der vorhandenen courseSources; ohne courseSources muss die
 * Kopfzeile "Kurs-Link:" des gefundenen Workspace-Dokuments genau dieser
 * Link sein), deren Pfad wie eine Kursseite aussieht (bekannter Kurs-Pfad
 * oder kursnummerartiges Segment) und deren Slug ein Workspace-Dokument
 * trifft; höchstens COURSE_LOOKUPS_MAX Dateizugriffe, Gesamtliste
 * höchstens COURSE_SOURCES_MAX. Sind alle verlinkten Kurse schon enthalten,
 * gibt es keinen Zugriff (weder Dokumentliste noch Datei).
 * @param {{replyText: string, courseSources?: object[], workspace?: object, lookup?: object, deps?: object}} args
 * @returns {Promise<object[]>} vorhandene Einträge + neue (in Link-Reihenfolge)
 */
async function completeCourseSourcesFromReply({
  replyText,
  courseSources = [],
  workspace = null,
  lookup = null,
  deps = {},
} = {}) {
  const base = mergeCourseSources(courseSources);
  try {
    if (base.length >= COURSE_SOURCES_MAX) return base;
    const known = new Set(base.map((e) => urlKey(e.url)));
    const hosts = new Set(base.map((e) => hostKey(e.url)).filter(Boolean));
    const prefix = knownCoursePrefix(base.map((e) => e.url));
    const candidates = extractReplyLinks(replyText).filter((link) => {
      if (known.has(urlKey(link))) return false;
      if (hosts.size > 0 && !hosts.has(hostKey(link))) return false;
      return looksLikeCoursePage(link, prefix);
    });
    if (candidates.length === 0) return base;

    const ctx = lookup || createCourseLookup({ workspace, deps });
    const docpaths = await ctx.docpaths();
    if (docpaths.length === 0) return base;

    const out = [...base];
    for (const link of candidates) {
      if (out.length >= COURSE_SOURCES_MAX || ctx.exhausted()) break;
      for (const docpath of findDocpathCandidates(link, docpaths)) {
        const entry = await ctx.read(docpath);
        if (entry === undefined) break; // Limit erreicht
        // Das Dokument muss genau dieser Kurs sein (schützt vor Slug-
        // Kollisionen/gekürzten Slugs und legt ohne courseSources die
        // Kundendomain fest).
        if (!entry || urlKey(entry.url) !== urlKey(link)) continue;
        if (!known.has(urlKey(entry.url))) {
          known.add(urlKey(entry.url));
          out.push(entry);
        }
        break;
      }
    }
    return out;
  } catch (e) {
    console.error("[completeCourseSourcesFromReply]", e.message);
    return base;
  }
}

/**
 * courseSources aus dem Karten-Marker der Antwort ("[[KARTEN: 0, 2]]"): die
 * Nummern sind die Kontextblöcke [CONTEXT n] (0-basiert, Reihenfolge wie
 * contextTexts). Kurs-Einträge aus den Kopfzeilen der Treffer; Folge-Chunks
 * ohne Kopfzeilen werden über ihren Dateinamen nachgeschlagen (gleiches
 * Limit/Cache wie completeCourseSourcesFromReply). Nicht-Kurse und ungültige
 * Nummern fallen weg, Dedupe über die URL, höchstens COURSE_SOURCES_MAX.
 * @param {{indices: number[], contextSources: object[], workspace?: object, lookup?: object, deps?: object}} args
 * @returns {Promise<object[]>}
 */
async function courseSourcesFromMarker({
  indices = [],
  contextSources = [],
  workspace = null,
  lookup = null,
  deps = {},
} = {}) {
  try {
    if (!Array.isArray(indices) || indices.length === 0) return [];
    const entries = courseEntriesBySource(contextSources);
    const picked = [];
    let ctx = lookup;
    for (const index of indices) {
      if (
        !Number.isInteger(index) ||
        index < 0 ||
        index >= contextSources.length
      )
        continue;
      let entry = entries[index];
      if (!entry) {
        ctx = ctx || createCourseLookup({ workspace, deps });
        if (ctx.exhausted()) continue;
        const docpaths = await ctx.docpaths();
        const docpath = findDocpathForChunk(contextSources[index], docpaths);
        entry = docpath ? await ctx.read(docpath) : null;
      }
      if (entry) picked.push(entry);
    }
    return mergeCourseSources(picked);
  } catch (e) {
    console.error("[courseSourcesFromMarker]", e.message);
    return [];
  }
}

module.exports = {
  COURSE_SOURCE_FIELDS,
  COURSE_SOURCES_MAX,
  COURSE_LOOKUPS_MAX,
  courseCardsEnabled,
  buildCourseSources,
  courseEntriesBySource,
  mergeCourseSources,
  completeCourseSourcesFromReply,
  courseSourcesFromMarker,
  createCourseLookup,
  courseEntryFromDocument,
  extractReplyLinks,
  findDocpathForUrl,
  findDocpathCandidates,
  findDocpathForChunk,
  safeDocumentFile,
  urlSlugify,
  urlKey,
  sanitizeCourseSources,
  pickCourseFields,
};
