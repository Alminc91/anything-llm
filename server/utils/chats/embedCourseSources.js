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

const DATE_RX = /^\d{4}-\d{2}-\d{2}$/;
const WEEKDAYS_RX = /^,((mon|tue|wed|thu|fri|sat|sun),)+$/;
const LOCATION_RX = /^[a-z0-9äöüß\-. ]{1,80}$/i;
const FILENAME_TITLE_RX = /\.(txt|html?|json|pdf|md|csv|docx?)$/i;

// Typprüfung je Feld (wie collector/processRawText METADATA_KEYS.course):
// gültig -> normalisierter Wert, sonst undefined (Feld fällt weg).
const FIELD_VALIDATORS = {
  url: (v) => httpUrl(v),
  title: (v) => cleanTitle(v),
  start_date: (v) => (typeof v === "string" && DATE_RX.test(v) ? v : undefined),
  end_date: (v) => (typeof v === "string" && DATE_RX.test(v) ? v : undefined),
  start_minutes: (v) => {
    const n = typeof v === "bigint" ? Number(v) : v;
    return Number.isInteger(n) && n >= 0 && n < 1440 ? n : undefined;
  },
  weekdays: (v) =>
    typeof v === "string" && WEEKDAYS_RX.test(v) ? v : undefined,
  price: (v) =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined,
  bookable: (v) => (typeof v === "boolean" ? v : undefined),
  format: (v) =>
    typeof v === "string" && ["online", "onsite", "hybrid"].includes(v)
      ? v
      : undefined,
  location: (v) =>
    typeof v === "string" && LOCATION_RX.test(v.trim()) ? v.trim() : undefined,
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

function cleanTitle(value) {
  if (typeof value !== "string") return undefined;
  const v = value.replace(/\s+/g, " ").trim();
  if (v.length === 0 || v.length > TITLE_MAX_LEN) return undefined;
  return v;
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
    } catch {
      return false;
    }
  }
  const value = config?.courseCards;
  return typeof value === "string" && value.trim().toLowerCase() === "auto";
}

// "Kurs-Link: https://…" / "Titel: …" — nur am Zeilenanfang, nur die erste.
function headerLine(text, label) {
  if (typeof text !== "string" || text.length === 0) return undefined;
  const m = new RegExp(`^${label}:[ \\t]*(.+)$`, "m").exec(text);
  return m ? m[1].trim() : undefined;
}

function urlFromSource(source) {
  const direct = httpUrl(source?.url);
  if (direct) return direct;
  const fromHeader =
    httpUrl(headerLine(source?.text, "Kurs-Link")) ||
    httpUrl(headerLine(source?.text, "Link"));
  if (fromHeader) return fromHeader;
  // Gecrawlte Seiten: chunkSource = "link://https://…"
  if (
    typeof source?.chunkSource === "string" &&
    source.chunkSource.startsWith("link://")
  )
    return httpUrl(source.chunkSource.slice("link://".length));
  return undefined;
}

function titleFromSource(source) {
  const fromHeader = cleanTitle(headerLine(source?.text, "Titel"));
  if (fromHeader) return fromHeader;
  // metadata.title nur, wenn es kein Dateiname/Slug ist
  const title = cleanTitle(source?.title);
  if (title && !FILENAME_TITLE_RX.test(title)) return title;
  return undefined;
}

// Dokument-Identität (mehrere Chunks derselben Datei teilen title/url/docId)
function documentKey(source, index) {
  return (
    (typeof source?.docId === "string" && source.docId) ||
    (typeof source?.title === "string" && source.title) ||
    (typeof source?.url === "string" && source.url) ||
    `#${index}`
  );
}

/**
 * Whitelist eines Eintrags: nur COURSE_SOURCE_FIELDS, typgeprüft.
 * @param {object} entry
 * @returns {object}
 */
function pickCourseFields(entry = {}) {
  const out = {};
  for (const key of COURSE_SOURCE_FIELDS) {
    if (!(key in (entry || {}))) continue;
    const value = FIELD_VALIDATORS[key](entry[key]);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function isCourseEntry(entry) {
  return (
    !!entry?.url && !!entry?.title && (!!entry?.start_date || !!entry?.weekdays)
  );
}

/**
 * Leitet aus den gesammelten Quellen einer Embed-Antwort die Kurskarten-
 * Metadaten ab: nur Kursdokumente (url + title + start_date oder weekdays),
 * Whitelist-Felder, Dedupe über url (erster gewinnt), höchstens 12.
 * @param {object[]} sources - sources wie in streamChatWithForEmbed (inkl. text)
 * @returns {object[]} courseSources
 */
function buildCourseSources(sources = []) {
  if (!Array.isArray(sources) || sources.length === 0) return [];

  // 1) url/title je Dokument aus irgendeinem seiner Chunks (nur der erste Chunk
  //    eines Kursdokuments trägt die Kopfzeilen "Titel:"/"Kurs-Link:").
  const docInfo = new Map();
  sources.forEach((source, index) => {
    if (!source || typeof source !== "object") return;
    const key = documentKey(source, index);
    const info = docInfo.get(key) || {};
    if (!info.url) info.url = urlFromSource(source);
    if (!info.title) info.title = titleFromSource(source);
    docInfo.set(key, info);
  });

  // 2) Einträge in Quellen-Reihenfolge (Relevanz), Whitelist, Dedupe, Limit
  const seen = new Set();
  const out = [];
  sources.forEach((source, index) => {
    if (out.length >= COURSE_SOURCES_MAX) return;
    if (!source || typeof source !== "object") return;
    const info = docInfo.get(documentKey(source, index)) || {};
    const { url: _url, title: _title, ...meta } = source;
    const entry = pickCourseFields({
      ...meta,
      url: info.url,
      title: info.title,
    });
    if (!isCourseEntry(entry)) return;
    if (seen.has(entry.url)) return;
    seen.add(entry.url);
    out.push(entry);
  });
  return out;
}

/**
 * Bereits gespeicherte courseSources (Historie) nochmals auf die Whitelist
 * reduzieren — Abwehr in der Tiefe, falls je ein Altbestand mehr enthielte.
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
