/**
 * Auswahlstufe hinter dem Reranker (Kursdaten, KIE-480-Spalten).
 *
 * Deterministische, reine Funktionen ohne I/O. Die Stufe bekommt die vom
 * Reranker bewerteten Kandidaten (Reranker-Reihenfolge = Score absteigend)
 * und entscheidet nur über die MENGE der ausgelieferten Kontexte — die
 * Reihenfolge der Ausgabe bleibt die Reranker-Reihenfolge.
 *
 * Regeln (siehe server/HYBRID_SEARCH_RERANKER.md, Abschnitt 3f):
 * 1. Zustände eines Kurses (Zeile mit gültigem `start_date`):
 *    - `zukuenftig`: `start_date ≥ heute`, Nähe = Tage bis Start;
 *    - `laufend`: `start_date < heute` und `bookable !== false`, Nähe 0;
 *    - `warteliste`: `start_date < heute` und `bookable === false`, Nähe null.
 *    `bookable`-Semantik der Pipeline: `false` = Kufer-Status 4
 *    („Warteliste/ausgebucht“) — der Kurs läuft noch. Abgeschlossene oder
 *    abgesagte Kurse haben `bookable` NULL und werden von der Feed-Uhr der
 *    Pipeline gelöscht. „Abgelaufen“ ist aus `bookable` daher NICHT
 *    ableitbar; die Stufe entfernt nie einen Kurs.
 * 2. Die K relevantesten Kurse bleiben fest; Wartelisten-Kurse der heutigen
 *    Top-N ebenfalls (sie sind nicht „später“ als ein anderer Kurs). Die
 *    übrigen Kursplätze bekommen die frühesten Kurse mit Nähe ≠ null und
 *    `score ≥ max(topScore − BAND; FLOOR)`, bei gleicher Nähe der höhere
 *    Score. Ein Kurs der Top-N fällt also nur heraus, wenn ein früher
 *    startender Kurs seinen Platz bekommt; `warteliste` rückt nie als
 *    „früher“ nach.
 * 3. Klare Kursfrage (≥ 3 Kurse mit `score ≥ FLOOR`, Warteliste zählt mit):
 *    höchstens 1 Nicht-Kurs-Dokument (das bestbewertete); ersetzt wird nur
 *    durch Kurse mit `score ≥ FLOOR` (zuerst die frühesten im Band, dann nach
 *    Score) — fehlen solche, bleiben die Nicht-Kurs-Dokumente.
 * 4. Ohne Reranker-Scores, mit < 2 Kursen oder ohne gültiges Datum:
 *    Ausgabe = `candidates.slice(0, topN)`.
 *
 * Kandidaten werden nie verändert; die Ausgabe enthält dieselben Objekt-
 * Referenzen wie die Eingabe.
 */

const SELECTION_KEEP = 2;
const SELECTION_BAND = 0.1;
const SELECTION_FLOOR = 0.3;
/** Mindestgröße des Reranker-Pools (topK), aus dem die Stufe wählt. */
const SELECTION_POOL_MIN = 12;
/** Ab so vielen Kursen mit Score ≥ FLOOR gilt die Frage als Kursfrage. */
const COURSE_QUERY_MIN = 3;
/** Höchstzahl Nicht-Kurs-Dokumente bei einer Kursfrage. */
const MAX_NON_COURSE = 1;
/** Toleranz für Gleitkomma-Vergleiche an der Bandgrenze (nicht am Boden). */
const BAND_EPSILON = 1e-9;

const DAY_MS = 24 * 60 * 60 * 1000;
const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})/;

/**
 * ISO-Tag ("YYYY-MM-DD", optional mit Zeitanteil) → Tagesnummer seit Epoche.
 * Ungültige Kalenderdaten (2026-02-31) und Nicht-Strings → null.
 * @param {unknown} value
 * @returns {number|null}
 */
function parseIsoDay(value) {
  if (typeof value !== "string") return null;
  const m = ISO_DAY.exec(value.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const ms = Date.UTC(y, mo - 1, d);
  const check = new Date(ms);
  if (
    check.getUTCFullYear() !== y ||
    check.getUTCMonth() !== mo - 1 ||
    check.getUTCDate() !== d
  )
    return null;
  return Math.round(ms / DAY_MS);
}

/**
 * Heutiges Datum in Europe/Berlin als ISO-Tag (Container laufen ggf. in UTC).
 * @param {Date} [now]
 * @returns {string} YYYY-MM-DD
 */
function berlinToday(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

const isUnitInterval = (n) => Number.isFinite(n) && n >= 0 && n <= 1;

/**
 * Konstanten mit Env-Override (COURSE_SELECTION_KEEP/BAND/FLOOR). Ungültige
 * Werte fallen auf den Standard zurück.
 * @param {Record<string, string|undefined>} [env]
 * @returns {{keep:number, band:number, floor:number}}
 */
function selectionConfig(env = process.env) {
  const keep = Number(env?.COURSE_SELECTION_KEEP);
  const band = Number(env?.COURSE_SELECTION_BAND);
  const floor = Number(env?.COURSE_SELECTION_FLOOR);
  const has = (v) => v !== undefined && v !== null && String(v).trim() !== "";
  return {
    keep:
      has(env?.COURSE_SELECTION_KEEP) &&
      Number.isInteger(keep) &&
      keep >= 0 &&
      keep <= 20
        ? keep
        : SELECTION_KEEP,
    band:
      has(env?.COURSE_SELECTION_BAND) && isUnitInterval(band)
        ? band
        : SELECTION_BAND,
    floor:
      has(env?.COURSE_SELECTION_FLOOR) && isUnitInterval(floor)
        ? floor
        : SELECTION_FLOOR,
  };
}

/** Übergebene Settings validieren; Fehlendes/Ungültiges → Standard. */
function normalizeSettings(settings) {
  const s = settings && typeof settings === "object" ? settings : {};
  return {
    keep:
      Number.isInteger(s.keep) && s.keep >= 0 && s.keep <= 20
        ? s.keep
        : SELECTION_KEEP,
    band: isUnitInterval(s.band) ? s.band : SELECTION_BAND,
    floor: isUnitInterval(s.floor) ? s.floor : SELECTION_FLOOR,
  };
}

/**
 * Ordnet eine Kandidatenzeile ein.
 * @param {object} row - Reranker-Kandidat (rerank_score, start_date, bookable)
 * @param {number|string} today - Tagesnummer (parseIsoDay) oder ISO-Tag
 * @returns {{score:number|null, course:boolean,
 *   state:"kein-kurs"|"warteliste"|"laufend"|"zukuenftig", naehe:number|null}}
 */
function classifyRow(row, today) {
  const todayDay = typeof today === "number" ? today : parseIsoDay(today);
  const rawScore = row && typeof row === "object" ? row.rerank_score : null;
  const score =
    typeof rawScore === "number" && Number.isFinite(rawScore) ? rawScore : null;
  const startDay =
    row && typeof row === "object" ? parseIsoDay(row.start_date) : null;
  if (startDay === null || !Number.isFinite(todayDay))
    return { score, course: false, state: "kein-kurs", naehe: null };
  if (startDay < todayDay) {
    // bookable=false = Warteliste/ausgebucht (Kufer-Status 4): läuft noch,
    // hat aber keine Nähe — rückt nie als „früher“ nach.
    if (row.bookable === false)
      return { score, course: true, state: "warteliste", naehe: null };
    return { score, course: true, state: "laufend", naehe: 0 };
  }
  return {
    score,
    course: true,
    state: "zukuenftig",
    naehe: startDay - todayDay,
  };
}

const ruleLabel = (cfg) =>
  `keep${cfg.keep}-band${cfg.band}-floor${cfg.floor}-deckel${MAX_NON_COURSE}-nodrop`;

/**
 * Auswahlstufe: wählt höchstens topN Kontexte aus dem Reranker-Pool.
 * @param {object[]} candidates - Reranker-Pool, Reranker-Reihenfolge.
 * @param {Object} opts
 * @param {number} opts.topN - Obergrenze der Ausgabe.
 * @param {string} opts.today - ISO-Tag (Europe/Berlin).
 * @param {{keep?:number, band?:number, floor?:number}} [opts.settings]
 * @returns {{selected:object[], active:boolean, reason:string|null,
 *   changed:boolean, courseQuery:boolean, rule:string,
 *   swappedIn:object[], swappedOut:object[]}}
 *   `swappedIn`/`swappedOut`: {row, score, naehe, state, kind, reason};
 *   reason `datum` (Kurs gegen früheren getauscht) oder `deckel`
 *   (Nicht-Kurs-Dokument durch Kurs ersetzt). Je Grund gibt es gleich viele
 *   ein- wie ausgewechselte Dokumente.
 */
function selectContexts(candidates, { topN, today, settings } = {}) {
  const list = Array.isArray(candidates) ? candidates : [];
  const n = Number.isFinite(topN) && topN > 0 ? Math.floor(topN) : 0;
  const cfg = normalizeSettings(settings);
  const rule = ruleLabel(cfg);
  const identity = (reason) => ({
    selected: list.slice(0, n),
    active: false,
    reason,
    changed: false,
    courseQuery: false,
    rule,
    swappedIn: [],
    swappedOut: [],
  });

  if (list.length === 0 || n === 0) return identity("empty");
  const todayDay = parseIsoDay(today);
  if (todayDay === null) return identity("no_today");

  const info = list.map((row) => classifyRow(row, todayDay));
  if (!info.some((i) => i.score !== null)) return identity("degraded");

  const all = list.map((_, i) => i);
  const isScoredCourse = (i) => info[i].course && info[i].score !== null;
  const courses = all.filter(isScoredCourse);
  if (courses.length < 2) return identity("few_courses");

  // Basis = heutige Auswahl (Score-Top-N). Die Stufe entfernt daraus nie
  // einen Kurs — sie tauscht nur gegen frühere bzw. ersetzt Übersichten.
  const base = all.slice(0, n);
  const inBase = new Set(base);
  const baseCourses = base.filter(isScoredCourse).length;
  const baseOthers = base.length - baseCourses;

  // Wählbare Kurse: was heute schon drin ist, plus Kurse über dem Boden.
  // Damit kann strukturell kein Kurs < FLOOR eingewechselt werden.
  const byScore = (a, b) => info[b].score - info[a].score || a - b;
  const eligible = courses
    .filter((i) => inBase.has(i) || info[i].score >= cfg.floor)
    .sort(byScore);

  const strongCourses = courses.filter(
    (i) => info[i].score >= cfg.floor
  ).length;
  const courseQuery = strongCourses >= COURSE_QUERY_MIN;

  let courseSlots = baseCourses;
  let otherSlots = baseOthers;
  if (courseQuery && baseOthers > MAX_NON_COURSE) {
    const extra = Math.min(
      baseOthers - MAX_NON_COURSE,
      eligible.length - baseCourses
    );
    if (extra > 0) {
      courseSlots += extra;
      otherSlots -= extra;
    }
  }

  // Nicht-Kurs-Dokumente: die bestplatzierten (Teilmenge der Basis).
  const others = all.filter((i) => !isScoredCourse(i)).slice(0, otherSlots);

  // Feste Kurse: die K relevantesten nach Score, dazu Wartelisten-Kurse der
  // Basis (Nähe null → nie „später“ als ein Kandidat, also nie getauscht).
  const keep = eligible.slice(0, Math.min(cfg.keep, courseSlots));
  const fixed = [
    ...keep,
    ...eligible.filter(
      (i) => inBase.has(i) && info[i].naehe === null && !keep.includes(i)
    ),
  ].slice(0, courseSlots);
  const fixedSet = new Set(fixed);
  // Übrige Kursplätze: die frühesten im Band (nur mit Nähe), Rest nach Score.
  const topScore = eligible.length > 0 ? info[eligible[0]].score : 0;
  const threshold = Math.max(topScore - cfg.band - BAND_EPSILON, cfg.floor);
  const rest = eligible.filter((i) => !fixedSet.has(i));
  const bandPicks = rest
    .filter((i) => info[i].naehe !== null && info[i].score >= threshold)
    .sort((a, b) => info[a].naehe - info[b].naehe || byScore(a, b));
  const remaining = courseSlots - fixed.length;
  const picks = bandPicks.slice(0, remaining);
  const picked = new Set(picks);
  for (const i of rest) {
    if (picks.length >= remaining) break;
    if (!picked.has(i)) {
      picks.push(i);
      picked.add(i);
    }
  }

  const chosen = new Set([...fixed, ...picks, ...others]);
  const selectedIdx = all.filter((i) => chosen.has(i));

  const describe = (i, reason) => ({
    row: list[i],
    score: info[i].score,
    naehe: info[i].naehe,
    state: info[i].state,
    kind: info[i].course ? "kurs" : "info",
    reason,
  });
  // Ausgewechselt: Kurse nur per Datumstausch, Nicht-Kurse nur per Deckel.
  const outIdx = base.filter((i) => !chosen.has(i));
  const swappedOut = outIdx.map((i) =>
    describe(i, isScoredCourse(i) ? "datum" : "deckel")
  );
  // Eingewechselt: so viele `datum` wie Kurse getauscht wurden (die
  // frühesten Band-Kandidaten), der Rest ersetzt Übersichten (`deckel`).
  const inIdx = selectedIdx.filter((i) => !inBase.has(i));
  const datumOut = outIdx.filter(isScoredCourse).length;
  const datumIn = new Set(
    bandPicks.filter((i) => inIdx.includes(i)).slice(0, datumOut)
  );
  const swappedIn = inIdx.map((i) =>
    describe(i, datumIn.has(i) ? "datum" : "deckel")
  );

  return {
    selected: selectedIdx.map((i) => list[i]),
    active: true,
    reason: null,
    changed: swappedIn.length > 0 || swappedOut.length > 0,
    courseQuery,
    rule,
    swappedIn,
    swappedOut,
  };
}

module.exports = {
  SELECTION_KEEP,
  SELECTION_BAND,
  SELECTION_FLOOR,
  SELECTION_POOL_MIN,
  COURSE_QUERY_MIN,
  MAX_NON_COURSE,
  parseIsoDay,
  berlinToday,
  selectionConfig,
  classifyRow,
  selectContexts,
};
