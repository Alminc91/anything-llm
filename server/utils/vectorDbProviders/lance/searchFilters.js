/**
 * KIE-480 (P2): generic hard-constraint metadata filters for retrieval.
 *
 * Converts a structured, LLM-/extractor-produced filter object into a safe
 * LanceDB `.where()` SQL clause. Design rules (see Linear KIE-480):
 *   - NOTHING reaches the SQL string unvalidated: enums are whitelisted,
 *     numbers are Number-checked, dates must match ISO YYYY-MM-DD, free-text
 *     values (location) are character-whitelisted AND quote-escaped, ids are
 *     pattern-checked. Unknown/invalid fields are DROPPED, never guessed —
 *     a missing filter degrades to today's behavior, a wrong filter would
 *     hide courses.
 *   - The clause targets the flat metadata columns written at ingestion
 *     (P1): start_date (ISO string), start_minutes (int), weekdays
 *     (delimited token string ",mon,tue,"), price (float), bookable (bool),
 *     format (enum string), location (normalized string).
 *   - Legacy tables without these columns: the caller must fall back to an
 *     unfiltered query (see LanceDb.filteredQueryRows) — never to an empty
 *     result.
 */

const TIME_OF_DAY_RANGES = Object.freeze({
  // start_minutes = minutes since midnight of the course start time.
  morning: "(start_minutes >= 0 AND start_minutes < 720)",
  afternoon: "(start_minutes >= 720 AND start_minutes < 1020)",
  evening: "(start_minutes >= 1020 AND start_minutes < 1440)",
});
const WEEKDAYS = Object.freeze([
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat",
  "sun",
]);
const FORMATS = Object.freeze(["online", "onsite", "hybrid"]);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const SAFE_ID = /^[a-zA-Z0-9_-]{1,64}$/;
// Lowercased, trimmed location tokens: letters (incl. German), digits,
// space, dot, dash. Anything else -> the value is dropped entirely.
const SAFE_LOCATION = /^[a-z0-9äöüß\-. ]{1,80}$/;

/** Escapes a validated string literal for a single-quoted SQL string. */
function sqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * Normalizes an untrusted filter object into the validated internal shape.
 * Invalid fields/values are silently dropped (conservative: never filter on
 * anything we are not sure about). Returns null when nothing survives.
 * @param {object|null} raw
 * @returns {object|null} sanitized filters or null
 */
function sanitizeSearchFilters(raw = null) {
  if (!raw || typeof raw !== "object") return null;
  const out = {};

  if (typeof raw.dateFrom === "string" && ISO_DATE.test(raw.dateFrom))
    out.dateFrom = raw.dateFrom;
  if (typeof raw.dateTo === "string" && ISO_DATE.test(raw.dateTo))
    out.dateTo = raw.dateTo;

  if (Array.isArray(raw.timeOfDay)) {
    const buckets = raw.timeOfDay.filter(
      (b) => typeof b === "string" && TIME_OF_DAY_RANGES[b]
    );
    if (buckets.length > 0 && buckets.length < 3)
      out.timeOfDay = [...new Set(buckets)];
  }

  if (Array.isArray(raw.weekdays)) {
    const days = raw.weekdays.filter(
      (d) => typeof d === "string" && WEEKDAYS.includes(d)
    );
    if (days.length > 0 && days.length < 7) out.weekdays = [...new Set(days)];
  }

  const priceMax = Number(raw.priceMax);
  if (Number.isFinite(priceMax) && priceMax >= 0) out.priceMax = priceMax;
  if (raw.freeOnly === true) out.freeOnly = true;
  if (raw.bookable === true) out.bookable = true;

  if (Array.isArray(raw.format)) {
    const formats = raw.format.filter(
      (f) => typeof f === "string" && FORMATS.includes(f)
    );
    if (formats.length > 0 && formats.length < FORMATS.length)
      out.format = [...new Set(formats)];
  }

  if (Array.isArray(raw.location)) {
    const locations = raw.location
      .filter((l) => typeof l === "string")
      .map((l) => l.trim().toLowerCase())
      .filter((l) => SAFE_LOCATION.test(l));
    if (locations.length > 0) out.location = [...new Set(locations)];
  }

  if (Array.isArray(raw.excludeIds)) {
    const ids = raw.excludeIds.filter(
      (id) => typeof id === "string" && SAFE_ID.test(id)
    );
    if (ids.length > 0) out.excludeIds = [...new Set(ids)];
  }

  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Builds the LanceDB/DataFusion SQL where-clause from SANITIZED filters.
 * Always call sanitizeSearchFilters first — this function trusts its input.
 * @param {object|null} filters - Output of sanitizeSearchFilters.
 * @returns {string|null} SQL clause or null when there is nothing to filter.
 */
function filtersToWhere(filters = null) {
  if (!filters || typeof filters !== "object") return null;
  const parts = [];

  if (filters.dateFrom) parts.push(`start_date >= ${sqlString(filters.dateFrom)}`);
  if (filters.dateTo) parts.push(`start_date <= ${sqlString(filters.dateTo)}`);

  if (filters.timeOfDay)
    parts.push(
      `(${filters.timeOfDay.map((b) => TIME_OF_DAY_RANGES[b]).join(" OR ")})`
    );

  if (filters.weekdays)
    // weekdays column stores delimited tokens like ",mon,tue," so a LIKE on
    // ",mon," can never partial-match another token.
    parts.push(
      `(${filters.weekdays
        .map((d) => `weekdays LIKE ${sqlString(`%,${d},%`)}`)
        .join(" OR ")})`
    );

  if (typeof filters.priceMax === "number")
    parts.push(`price <= ${filters.priceMax}`);
  if (filters.freeOnly) parts.push(`price <= 0`);
  if (filters.bookable) parts.push(`bookable = true`);

  if (filters.format)
    parts.push(
      `format IN (${filters.format.map((f) => sqlString(f)).join(", ")})`
    );

  if (filters.location)
    parts.push(
      `location IN (${filters.location.map((l) => sqlString(l)).join(", ")})`
    );

  if (filters.excludeIds)
    parts.push(
      `id NOT IN (${filters.excludeIds.map((i) => sqlString(i)).join(", ")})`
    );

  return parts.length > 0 ? parts.join(" AND ") : null;
}

module.exports = {
  sanitizeSearchFilters,
  filtersToWhere,
  // exported for tests / P1 ingestion mapping
  WEEKDAYS,
  FORMATS,
};
