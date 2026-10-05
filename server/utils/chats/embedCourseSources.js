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
 * Leitet aus den gesammelten Quellen einer Embed-Antwort die Kurskarten-
 * Metadaten ab: nur Kursdokumente (Kurs-URL + Titel), Whitelist-Felder,
 * Dedupe über url (erster gewinnt), höchstens 12.
 * @param {object[]} sources - sources wie in streamChatWithForEmbed (inkl. text)
 * @returns {object[]} courseSources
 */
function buildCourseSources(sources = []) {
  if (!Array.isArray(sources) || sources.length === 0) return [];
  const chunks = sources.filter((s) => s && typeof s === "object");

  // 1) Gruppierung über die Kurs-URL (nur der erste Chunk eines Kurs-
  //    dokuments trägt "Titel:"/"Kurs-Link:"). Folge-Chunks erben die URL
  //    über den Ersatz-Schlüssel — aber nur, wenn er eindeutig auf genau
  //    eine Kurs-URL zeigt.
  const titleByUrl = new Map();
  const urlsByFallback = new Map();
  const chunkUrls = chunks.map((source) => {
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

  // 2) Einträge in Quellen-Reihenfolge (Relevanz), Whitelist, Dedupe, Limit
  const seen = new Set();
  const out = [];
  chunks.forEach((source, index) => {
    if (out.length >= COURSE_SOURCES_MAX) return;
    let url = chunkUrls[index];
    if (!url) {
      const candidates = urlsByFallback.get(fallbackKey(source));
      if (candidates?.size === 1) [url] = candidates;
    }
    if (!url || seen.has(url)) return;
    const { url: _url, title: _title, ...meta } = source;
    const entry = pickCourseFields({
      ...meta,
      url,
      title: titleByUrl.get(url) || titleFromChunk(source),
    });
    if (!isCourseEntry(entry)) return;
    seen.add(entry.url);
    out.push(entry);
  });
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

module.exports = {
  COURSE_SOURCE_FIELDS,
  COURSE_SOURCES_MAX,
  courseCardsEnabled,
  buildCourseSources,
  sanitizeCourseSources,
  pickCourseFields,
};
