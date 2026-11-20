/**
 * Auswahlstufe hinter dem Reranker (Kursdaten, KIE-480-Spalten).
 *
 * Deterministische, reine Funktionen ohne I/O (nur `selectionConfig` liest
 * die Env). Die Stufe bekommt die vom Reranker bewerteten Kandidaten
 * (Reranker-Reihenfolge = Score absteigend) und entscheidet über Menge und
 * Reihenfolge der ausgelieferten Kontexte: erst Relevanz, dann Datum
 * (Stufenregel, Spezifikation issues/kursauswahl-relevanz-datum.md).
 *
 * Regeln (siehe server/HYBRID_SEARCH_RERANKER.md, Abschnitt 3f):
 * 1. Zustände eines Kurses (Zeile mit gültigem `start_date`) mit ihrer
 *    zeitlichen Priorität (kleiner = weiter vorn):
 *    - 0 `zukuenftig`: `start_date ≥ heute` und `bookable !== false`,
 *      Nähe = Tage bis Start;
 *    - 1 `laufend`: `start_date < heute` und `bookable !== false`, Nähe 0;
 *    - 2 `warteliste`: `bookable === false`, auch bei künftigem Beginn;
 *      Nähe = Tage bis Start, bei schon begonnenem Kurs null.
 *    `bookable`-Semantik der Pipeline: `false` = Kufer-Status 4
 *    („Warteliste/ausgebucht“), der Kurs läuft noch. Abgeschlossene oder
 *    abgesagte Kurse haben `bookable` NULL und werden von der Feed-Uhr der
 *    Pipeline gelöscht. „Abgelaufen“ ist aus `bookable` daher NICHT
 *    ableitbar; die Stufe entfernt nie einen Kurs aus dem Bestand, sie wählt
 *    nur unter den Kandidaten. Zeilen ohne gültiges Datum sind keine Kurse,
 *    sondern Nicht-Kurs-Dokumente (Regel 3).
 * 2. Stufenregel für die Kursplätze: Platz für Platz ist der bestbewertete
 *    noch freie Kurs der Führende. Gleich relevant sind die noch freien
 *    Kurse mit `score ≥ Führender − SPANNE` und `score ≥ BODEN`, deren
 *    Log-Odds ln(p / (1 − p)) zudem höchstens LOGIT_SPANNE unter denen des
 *    Führenden liegen (D10, weil der Reranker nahe 1 große Unterschiede in
 *    winzige Abstände staucht, etwa 0,9999 gegen 0,997). Unter
 *    ihnen gewinnt die zeitliche Priorität; innerhalb derselben Stufe
 *    gehen Kurse mit künftigem Beginn vor (früheste zuerst, D7, auch auf
 *    der Warteliste), danach die begonnenen; laufende Kurse ordnet der
 *    Score. Bei gleichem Beginn gewinnt der höhere Score, dann die
 *    Kandidatenreihenfolge. Liegt der Führende unter dem Boden, bekommt er
 *    den Platz (reine Score-Folge: bei schwachen Treffern zieht das Datum
 *    nichts vor).
 *    Garantie: Kein gewählter Kurs steht vor einem späteren oder nicht
 *    gewählten Kurs, dessen Score mehr als SPANNE oder dessen Log-Odds mehr
 *    als LOGIT_SPANNE höher sind.
 *    Wählbar sind die Kurse der heutigen Top-N und Kurse mit
 *    `score ≥ BODEN`; ein Kurs unter dem Boden kommt nie von außerhalb dazu.
 * 2b. Kursleitung (Variante „Person“, 8.2.1, Spezifikation
 *    issues/kursauswahl-kursleitung.md): Nennt die Suchanfrage den
 *    Nachnamen einer Kursleitung, die mindestens 2 Kurse im Pool hat, und
 *    hält der Führende diesen Schlüssel, sind Kurse mit demselben Schlüssel
 *    schon bis PERSON_SPANNE (Standard 1,5, wirksam mindestens LOGIT_SPANNE)
 *    unter seinen Log-Odds gleich relevant. Spanne und Boden gelten
 *    unverändert; ein Kurs ohne diesen Schlüssel unter der Schwelle
 *    LOGIT_SPANNE beendet die Suche dann nicht, er wird übersprungen.
 *    Garantie damit: Kein gewählter Kurs steht vor einem späteren oder
 *    nicht gewählten Kurs mit mehr als SPANNE höherem Score oder mehr als
 *    max(PERSON_SPANNE, LOGIT_SPANNE) höheren Log-Odds. Ohne Anfrage, ohne
 *    erkannten Schlüssel oder mit PERSON_SPANNE 0 genau Regel 2.
 * 3. Klare Kursfrage (≥ 3 Kurse mit `score ≥ BODEN`, Warteliste zählt mit):
 *    höchstens 1 Nicht-Kurs-Dokument (das bestbewertete); ersetzt wird nur
 *    durch wählbare Kurse. Fehlen solche, bleiben die Nicht-Kurs-Dokumente.
 * 4. Ausgabe: Die gewählten Nicht-Kurs-Dokumente behalten ihren Platz in der
 *    Kandidatenreihenfolge, die Kursplätze werden in der Folge der
 *    Stufenregel belegt. Mit der Prompt-Regel „earliest start first“ deckt
 *    sich das nur innerhalb einer Stufe (künftige buchbare Kurse
 *    untereinander, seit D7 auch künftige Wartelisten-Kurse untereinander).
 *    Laufende und ausgebuchte Kurse setzt die Stufe trotz früherem Beginn
 *    hinter gleich relevante künftige buchbare Kurse; bekannte Abweichung,
 *    der Prompt bleibt unverändert (HC4, K-L5).
 * 5. Ohne Reranker-Scores, mit < 2 Kursen oder ohne gültiges Datum:
 *    Ausgabe = `candidates.slice(0, topN)`.
 *
 * Kandidaten werden nie verändert; die Ausgabe enthält dieselben Objekt-
 * Referenzen wie die Eingabe.
 */

/** Spanne „gleich relevant“ unter dem Führenden (Env COURSE_SELECTION_TIE_SPAN). */
const SELECTION_TIE_SPAN = 0.02;
/**
 * Zweite Bedingung für „gleich relevant“ (D10): höchstens so weit unter dem
 * Führenden auf der Log-Odds-Skala (Env COURSE_SELECTION_TIE_LOGIT). Ein
 * großer Wert (etwa 100) schaltet die Bedingung praktisch ab.
 */
const SELECTION_TIE_LOGIT = 1.0;
/**
 * Log-Odds-Spanne unter den Kursen einer in der Anfrage genannten
 * Kursleitung (Regel 2b, Env COURSE_SELECTION_PERSON_LOGIT, 0 = aus).
 * Wirksam ist der größere Wert aus ihr und SELECTION_TIE_LOGIT (D1).
 */
const SELECTION_PERSON_LOGIT = 1.5;
/** Ein Schlüssel gilt erst, wenn so viele Kurse im Pool ihn tragen. */
const PERSON_MIN_COURSES = 2;
/** Mindestlänge eines Worts der Anfrage und eines Doppelnamen-Teils. */
const PERSON_MIN_WORD = 4;
/** Scores für die Log-Odds auf [LOGIT_CLAMP, 1 − LOGIT_CLAMP] begrenzt (endlich). */
const LOGIT_CLAMP = 1e-7;
/** Boden: darunter keine Datumsordnung und kein Einwechseln (Env COURSE_SELECTION_FLOOR). */
const SELECTION_FLOOR = 0.3;
/** Mindestgröße des Reranker-Pools (topK), aus dem die Stufe wählt. */
const SELECTION_POOL_MIN = 12;
/** Ab so vielen Kursen mit Score ≥ FLOOR gilt die Frage als Kursfrage. */
const COURSE_QUERY_MIN = 3;
/** Höchstzahl Nicht-Kurs-Dokumente bei einer Kursfrage. */
const MAX_NON_COURSE = 1;
/** Toleranz für Gleitkomma-Vergleiche an den Spannengrenzen (nicht am Boden). */
const SPAN_EPSILON = 1e-9;
/**
 * Zeitliche Priorität unter gleich relevanten Kursen (kleiner = weiter vorn).
 * Nicht-Kurs-Dokumente erreichen die Stufenregel nie, sie behalten ihren
 * Platz (D1/E3), deshalb hat `kein-kurs` keinen Rang.
 */
const TIME_RANK = Object.freeze({
  zukuenftig: 0,
  laufend: 1,
  warteliste: 2,
});
/** Env der früheren Regel (2 feste Plätze, Band 0,1), seit der Stufenregel ohne Wirkung. */
const OBSOLETE_ENV = Object.freeze([
  "COURSE_SELECTION_KEEP",
  "COURSE_SELECTION_BAND",
]);

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
const isPositive = (n) => Number.isFinite(n) && n > 0;
const isNonNegative = (n) => Number.isFinite(n) && n >= 0;
const hasValue = (v) =>
  v !== undefined && v !== null && String(v).trim() !== "";

/**
 * Log-Odds eines Reranker-Scores: ln(p / (1 − p)), p auf
 * [LOGIT_CLAMP, 1 − LOGIT_CLAMP] begrenzt. Steigt mit p, bleibt endlich.
 * @param {number} p
 * @returns {number}
 */
function logOdds(p) {
  const q = Math.min(Math.max(p, LOGIT_CLAMP), 1 - LOGIT_CLAMP);
  return Math.log(q / (1 - q));
}

let obsoleteNoticeShown = false;

/**
 * Einmaliger Hinweis im Log, wenn noch eine Env der früheren Regel gesetzt
 * ist (COURSE_SELECTION_KEEP/BAND): Sie wirkt nicht mehr.
 * @param {Record<string, string|undefined>} [env]
 */
function noticeObsoleteEnv(env) {
  if (obsoleteNoticeShown) return;
  const set = OBSOLETE_ENV.filter((key) => hasValue(env?.[key]));
  if (set.length === 0) return;
  obsoleteNoticeShown = true;
  console.warn(
    `[Auswahlstufe] ${set.join(" und ")} ${
      set.length > 1 ? "sind" : "ist"
    } seit der Stufenregel ohne Wirkung. Stellgröße ist COURSE_SELECTION_TIE_SPAN (Standard ${SELECTION_TIE_SPAN}).`
  );
}

const UNIT_INTERVAL = [isUnitInterval, "eine Zahl von 0 bis 1"];
const POSITIVE = [isPositive, "eine Zahl größer 0"];
const NON_NEGATIVE = [isNonNegative, "eine Zahl ab 0"];

/** Stellgrößen mit Env-Override: Feld, Env-Name, Standard, [Prüfung, Erwartung]. */
const ENV_SETTINGS = Object.freeze([
  ["span", "COURSE_SELECTION_TIE_SPAN", SELECTION_TIE_SPAN, UNIT_INTERVAL],
  ["logitSpan", "COURSE_SELECTION_TIE_LOGIT", SELECTION_TIE_LOGIT, POSITIVE],
  ["floor", "COURSE_SELECTION_FLOOR", SELECTION_FLOOR, UNIT_INTERVAL],
  [
    "personLogit",
    "COURSE_SELECTION_PERSON_LOGIT",
    SELECTION_PERSON_LOGIT,
    NON_NEGATIVE,
  ],
]);

let invalidNoticeShown = false;

/**
 * Einmaliger Hinweis im Log, wenn eine Stellgröße gesetzt, aber ungültig ist
 * (K-R2): Es gilt dann der Standard, und selectionConfig läuft je Anfrage.
 * @param {string[]} invalid - Beschreibung je ungültigem Wert
 */
function noticeInvalidEnv(invalid) {
  if (invalidNoticeShown || invalid.length === 0) return;
  invalidNoticeShown = true;
  console.warn(`[Auswahlstufe] ${invalid.join("; ")}.`);
}

/**
 * Stellgrößen mit Env-Override (COURSE_SELECTION_TIE_SPAN und
 * COURSE_SELECTION_FLOOR je 0 bis 1, COURSE_SELECTION_TIE_LOGIT größer 0,
 * COURSE_SELECTION_PERSON_LOGIT ab 0, mit Dezimalpunkt). Ungültige Werte
 * fallen auf den Standard zurück, ein gesetzter ungültiger Wert steht
 * einmal im Log; leer gilt als nicht gesetzt.
 * COURSE_SELECTION_KEEP/BAND sind ohne Wirkung (einmaliger Hinweis).
 * @param {Record<string, string|undefined>} [env]
 * @returns {{span:number, logitSpan:number, floor:number,
 *   personLogit:number}}
 */
function selectionConfig(env = process.env) {
  noticeObsoleteEnv(env);
  const config = {};
  const invalid = [];
  for (const [field, key, standard, [isValid, expected]] of ENV_SETTINGS) {
    const raw = env?.[key];
    const value = Number(raw);
    if (hasValue(raw) && isValid(value)) {
      config[field] = value;
      continue;
    }
    config[field] = standard;
    if (hasValue(raw))
      invalid.push(
        `${key}=${JSON.stringify(String(raw).slice(0, 40))} ist ungültig (erwartet ist ${expected} mit Dezimalpunkt), es gilt der Standard ${standard}`
      );
  }
  noticeInvalidEnv(invalid);
  return config;
}

/** Übergebene Settings validieren; Fehlendes/Ungültiges → Standard. */
function normalizeSettings(settings) {
  const s = settings && typeof settings === "object" ? settings : {};
  return {
    span: isUnitInterval(s.span) ? s.span : SELECTION_TIE_SPAN,
    logitSpan: isPositive(s.logitSpan) ? s.logitSpan : SELECTION_TIE_LOGIT,
    floor: isUnitInterval(s.floor) ? s.floor : SELECTION_FLOOR,
    personLogit: isNonNegative(s.personLogit)
      ? s.personLogit
      : SELECTION_PERSON_LOGIT,
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
  // bookable=false = Warteliste/ausgebucht (Kufer-Status 4), auch wenn der
  // Kurs erst beginnt: hinter buchbaren und laufenden Kursen gleicher
  // Relevanz. Nähe nur bei künftigem Beginn (D7), begonnen: null.
  if (row.bookable === false)
    return {
      score,
      course: true,
      state: "warteliste",
      naehe: startDay >= todayDay ? startDay - todayDay : null,
    };
  if (startDay < todayDay)
    return { score, course: true, state: "laufend", naehe: 0 };
  return {
    score,
    course: true,
    state: "zukuenftig",
    naehe: startDay - todayDay,
  };
}

// Erkennung der Kursleitung (Regel 2b), wörtlich in der Wirkung wie die
// Messung vom 19.11.2026 (issues/benchmark-8.2/person/messung.js). Nur feste
// Ausdrücke, nie aus Frage- oder Dokumenttext gebaut; alle laufen linear.
/** Erste Zeile „Kursleitung:“; der Wert endet am Zeilenende. */
const LEADER_LINE = /Kursleitung:[ \t]*([^\n]*)/;
/** Trenner mehrerer Kursleitungen: Komma, Semikolon, Schrägstrich, &, „und“. */
const LEADER_SEPARATOR = /,|;|\/|&|\bund\b/;
/** Titel, die vor dem Namen wegfallen (mit oder ohne Punkt). */
const LEADER_TITLE = /^(dr|prof|dipl|mag|frau|herr|herrn)\.?$/;
const WHITESPACE = /\s+/;
/** Alles außer Buchstaben und Bindestrich (aus dem Nachnamen entfernt). */
const NOT_NAME_CHAR = /[^\p{L}-]/gu;
/** Trenner der Wörter der Anfrage: alles außer Buchstaben und Bindestrich. */
const QUERY_WORD_SEPARATOR = /[^\p{L}-]+/u;

/** Kleinschreibung, dann Unicode-Normalform NFKC. */
const normalizeName = (s) => s.toLowerCase().normalize("NFKC");

/**
 * Kursleitung aus dem Text eines Kurses: der Wert der ersten Zeile
 * „Kursleitung:“. Leer (nie die Folgezeile) oder mit Doppelpunkt → null.
 * @param {unknown} text
 * @returns {string|null}
 */
function leaderFromText(text) {
  if (typeof text !== "string") return null;
  const m = LEADER_LINE.exec(text);
  if (!m) return null;
  const value = m[1].trim();
  return value && !value.includes(":") ? value : null;
}

/**
 * Nachnamen einer Kursleitung: Namen je Trenner, Titel entfernt, danach
 * mindestens 2 Wörter; Nachname = letztes Wort, nur Buchstaben und
 * Bindestrich, klein und NFKC.
 * @param {string} leader
 * @returns {string[]}
 */
function leaderSurnames(leader) {
  return normalizeName(leader)
    .split(LEADER_SEPARATOR)
    .map((name) =>
      name
        .trim()
        .split(WHITESPACE)
        .filter((word) => word && !LEADER_TITLE.test(word))
    )
    .filter((words) => words.length >= 2)
    .map((words) => words[words.length - 1].replace(NOT_NAME_CHAR, ""))
    .filter(Boolean);
}

/**
 * Wörter der Anfrage ab PERSON_MIN_WORD Zeichen, Wörter mit Bindestrich
 * zusätzlich je Teil.
 * @param {string} query
 * @returns {Set<string>}
 */
function queryWords(query) {
  return new Set(
    normalizeName(query)
      .split(QUERY_WORD_SEPARATOR)
      .flatMap((word) => [word, ...word.split("-")])
      .filter((word) => word.length >= PERSON_MIN_WORD)
  );
}

/**
 * Schlüssel (Nachname der genannten Kursleitung) je Kandidat: nur für Kurse
 * (`classifyRow` liefert `course: true`), deren Kursleitung einen Nachnamen
 * trägt, den die Anfrage als ganzes Wort nennt (bei Doppelnamen genügt ein
 * Teil ab PERSON_MIN_WORD Zeichen). Gilt nur, wenn mindestens
 * PERSON_MIN_COURSES Kurse denselben Schlüssel tragen.
 * @param {object[]} list - Kandidaten
 * @param {object[]} info - classifyRow je Kandidat
 * @param {string} query - Suchanfrage (nicht leer)
 * @returns {(string|null)[]}
 */
function personKeys(list, info, query) {
  const words = queryWords(query);
  const keys = list.map((row, i) => {
    if (words.size === 0 || !info[i].course) return null;
    const leader = leaderFromText(row.text);
    if (leader === null) return null;
    for (const surname of leaderSurnames(leader))
      if (
        words.has(surname) ||
        surname
          .split("-")
          .some((part) => part.length >= PERSON_MIN_WORD && words.has(part))
      )
        return surname;
    return null;
  });
  const count = new Map();
  for (const key of keys) if (key) count.set(key, (count.get(key) || 0) + 1);
  return keys.map((key) =>
    key && count.get(key) >= PERSON_MIN_COURSES ? key : null
  );
}

/**
 * Nähe zweier Kurse derselben Stufe: künftiger Beginn (Zahl) vor begonnenem
 * (null), unter künftigen der früheste. Laufende haben alle Nähe 0.
 * @param {number|null} a
 * @param {number|null} b
 * @returns {number} negativ = a vor b
 */
function compareNaehe(a, b) {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a - b;
}

/**
 * Zeitliche Ordnung zweier gleich relevanter Kurse (Indizes in `info`):
 * Rang des Zustands, in derselben Stufe der früheste künftige Beginn (D7),
 * dann der höhere Score, dann die Kandidatenreihenfolge. Negativ = a vor b.
 */
function compareTime(a, b, info) {
  const ia = info[a];
  const ib = info[b];
  return (
    TIME_RANK[ia.state] - TIME_RANK[ib.state] ||
    compareNaehe(ia.naehe, ib.naehe) ||
    ib.score - ia.score ||
    a - b
  );
}

/**
 * Stufenregel: belegt bis zu `slots` Kursplätze aus `eligible` (nach Score
 * absteigend sortiert, bei Gleichstand Kandidatenreihenfolge).
 * @param {number[]} eligible
 * @param {number} slots
 * @param {object[]} info - classifyRow je Kandidat
 * @param {{span:number, logitSpan:number, floor:number,
 *   personLogit:number}} cfg
 * @param {(string|null)[]|null} [person] - Schlüssel je Kandidat (Regel 2b)
 * @returns {{picks:number[], personApplied:boolean}} gewählte Indizes in
 *   Platzfolge; `personApplied`: ein Führender trug einen Schlüssel.
 */
function stepRule(eligible, slots, info, cfg, person = null) {
  const rest = [...eligible];
  const picks = [];
  const personLogit = Math.max(cfg.personLogit, cfg.logitSpan);
  let personApplied = false;
  while (picks.length < slots && rest.length > 0) {
    const leaderScore = info[rest[0]].score;
    let best = 0;
    if (leaderScore >= cfg.floor) {
      const threshold = leaderScore - cfg.span - SPAN_EPSILON;
      const logitThreshold =
        logOdds(leaderScore) - cfg.logitSpan - SPAN_EPSILON;
      const leaderKey = person ? person[rest[0]] : null;
      const personThreshold = logOdds(leaderScore) - personLogit - SPAN_EPSILON;
      if (leaderKey !== null) personApplied = true;
      for (let k = 1; k < rest.length; k++) {
        const score = info[rest[k]].score;
        const samePerson = leaderKey !== null && person[rest[k]] === leaderKey;
        if (
          score < threshold ||
          logOdds(score) < (samePerson ? personThreshold : logitThreshold) ||
          score < cfg.floor
        ) {
          // Regel 2b: weiter unten kann noch ein Kurs derselben Kursleitung
          // gleich relevant sein, der hier gescheiterte wird übersprungen
          if (leaderKey !== null) continue;
          // `rest` ist nach Score sortiert und logOdds steigt mit dem Score:
          // ab hier ist keiner mehr gleich relevant
          break;
        }
        if (compareTime(rest[k], rest[best], info) < 0) best = k;
      }
    }
    picks.push(rest[best]);
    rest.splice(best, 1);
  }
  return { picks, personApplied };
}

const ruleLabel = (cfg) =>
  `stufe-span${cfg.span}-logit${cfg.logitSpan}-floor${cfg.floor}-deckel${MAX_NON_COURSE}-person${cfg.personLogit}`;

/** Ergebnisfeld `person`, wenn Regel 2b nicht lief oder nichts erkannte. */
const NO_PERSON = () => ({ keys: [], courses: 0, applied: false });

/**
 * Auswahlstufe: wählt höchstens topN Kontexte aus dem Reranker-Pool und
 * ordnet die Kursplätze nach der Stufenregel.
 * @param {object[]} candidates - Reranker-Pool, Reranker-Reihenfolge.
 * @param {Object} opts
 * @param {number} opts.topN - Obergrenze der Ausgabe.
 * @param {string} opts.today - ISO-Tag (Europe/Berlin).
 * @param {{span?:number, logitSpan?:number, floor?:number,
 *   personLogit?:number}} [opts.settings]
 * @param {string} [opts.query] - Suchanfrage, die auch der Reranker bekam
 *   (Regel 2b); fehlt sie, ist leer oder kein String: Regel 2b ruht.
 * @returns {{selected:object[], rerankRanks:number[], active:boolean,
 *   reason:string|null, changed:boolean, reordered:boolean,
 *   courseQuery:boolean, rule:string, swappedIn:object[],
 *   swappedOut:object[], person:{keys:string[], courses:number,
 *   applied:boolean}}}
 *   `selected` in Ausgabereihenfolge. `rerankRanks[k]`: Rang von
 *   `selected[k]` vor der Stufe, 0-basiert in der Kandidatenreihenfolge
 *   (= Reranker-Folge, K-R3); im Rückfall 0 bis topN − 1. `changed`: andere
 *   Menge als die Score-Top-N; `reordered`: andere Reihenfolge als die
 *   Kandidatenreihenfolge der gewählten Menge.
 *   `swappedIn`/`swappedOut`: {row, rerankRank, score, naehe, state, kind,
 *   reason}; reason `datum` (Kurs gegen gleich relevanten mit zeitlichem
 *   Vorrang getauscht) oder `deckel` (Nicht-Kurs-Dokument durch Kurs ersetzt).
 *   Je Grund gibt es gleich viele ein- wie ausgewechselte Dokumente;
 *   `swappedIn` in Ausgabereihenfolge, `swappedOut` in Kandidatenreihenfolge.
 *   `person` (Regel 2b): erkannte Schlüssel (Nachnamen, in
 *   Kandidatenreihenfolge), Zahl der Kurse mit Schlüssel und ob ein
 *   Führender einen Schlüssel trug. Nur für die Suchspur, die daraus keine
 *   Namen übernimmt (NAK-3).
 */
function selectContexts(candidates, { topN, today, settings, query } = {}) {
  const list = Array.isArray(candidates) ? candidates : [];
  const n = Number.isFinite(topN) && topN > 0 ? Math.floor(topN) : 0;
  const cfg = normalizeSettings(settings);
  const rule = ruleLabel(cfg);
  const identity = (reason) => ({
    selected: list.slice(0, n),
    rerankRanks: list.slice(0, n).map((_, i) => i),
    active: false,
    reason,
    changed: false,
    reordered: false,
    courseQuery: false,
    rule,
    swappedIn: [],
    swappedOut: [],
    person: NO_PERSON(),
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

  // Basis = heutige Auswahl (Score-Top-N): Sie gibt die Anzahl der Dokumente
  // und die Aufteilung in Kurs- und Nicht-Kurs-Plätze (Regel 3) vor.
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

  // Regel 2b: Schlüssel nur mit Anfrage und Stellgröße größer 0
  const person =
    cfg.personLogit > 0 && typeof query === "string" && query.trim() !== ""
      ? personKeys(list, info, query)
      : null;

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
  const { picks, personApplied } = stepRule(
    eligible,
    courseSlots,
    info,
    cfg,
    person
  );

  // Ausgabe: Nicht-Kurs-Dokumente auf ihrem Platz der Kandidatenreihenfolge,
  // die Kursplätze in der Folge der Stufenregel.
  const chosen = new Set([...picks, ...others]);
  const reference = all.filter((i) => chosen.has(i));
  let nextPick = 0;
  const ordered = reference.map((i) =>
    isScoredCourse(i) ? picks[nextPick++] : i
  );
  const reordered = ordered.some((i, k) => i !== reference[k]);

  const describe = (i, reason) => ({
    row: list[i],
    rerankRank: i,
    score: info[i].score,
    naehe: info[i].naehe,
    state: info[i].state,
    kind: info[i].course ? "kurs" : "info",
    reason,
  });
  // Ausgewechselt: Kurse nur per Stufenregel, Nicht-Kurse nur per Deckel.
  const outIdx = base.filter((i) => !chosen.has(i));
  const swappedOut = outIdx.map((i) =>
    describe(i, isScoredCourse(i) ? "datum" : "deckel")
  );
  // Eingewechselt werden nur Kurse: so viele `datum` wie Kurse ausgewechselt
  // wurden (die zuerst gewählten), der Rest ersetzt Übersichten (`deckel`).
  // Die Kursplätze der Ausgabe folgen `picks`, die neuen Kurse stehen damit
  // schon in Ausgabereihenfolge.
  const datumOut = outIdx.filter(isScoredCourse).length;
  const newPicks = picks.filter((i) => !inBase.has(i));
  const swappedIn = newPicks.map((i, k) =>
    describe(i, k < datumOut ? "datum" : "deckel")
  );

  return {
    selected: ordered.map((i) => list[i]),
    rerankRanks: ordered,
    active: true,
    reason: null,
    changed: swappedIn.length > 0 || swappedOut.length > 0,
    reordered,
    courseQuery,
    rule,
    swappedIn,
    swappedOut,
    person: person
      ? {
          keys: [...new Set(person.filter(Boolean))],
          courses: person.filter(Boolean).length,
          applied: personApplied,
        }
      : NO_PERSON(),
  };
}

module.exports = {
  SELECTION_TIE_SPAN,
  SELECTION_TIE_LOGIT,
  SELECTION_PERSON_LOGIT,
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
