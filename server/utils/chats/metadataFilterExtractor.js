/**
 * KIE-480 — deterministischer deutscher Filter-Extraktor (P0-Sieger "Arm C",
 * Eval: 68/68 auf dem Gold-Standard, siehe
 * Pipelines/Chat/Auswertung/Metadatenfilter/P0_FAZIT.md; das Eval-Repo hält
 * die Ursprungs-Kopie — Änderungen in beiden spiegeln).
 *
 * Regelbasierter Parser für das geschlossene Vokabular deutscher
 * Kursanfragen (Zeit, Tageszeit, Wochentage, Preis, Status, Format, Ort).
 * Entstanden, nachdem @microsoft/recognizers-text-suite für Deutsch
 * empirisch ausfiel (nicht einmal "morgen"/"nächste Woche" werden erkannt;
 * nur Währungen und Monatsnamen funktionieren — verifiziert 07.07.2026).
 *
 * Design-Regeln (KIE-480):
 *   - LLM klassifiziert höchstens, Code rechnet: dieser Parser läuft auf der
 *     bereits umgeschriebenen Query, komplett ohne LLM.
 *   - Im Zweifel NICHT filtern: unbekannte Ausdrücke, ungültige Daten und
 *     unbekannte Orte werden verworfen, nie geraten.
 *   - Ausgabe entspricht dem sanitizeSearchFilters-Schema des Forks
 *     (dateFrom/dateTo ISO, timeOfDay[], weekdays[], priceMin/priceMax, freeOnly,
 *     bookable, format[], location[]).
 *
 * Konventionen (mit Gold-Standard abgestimmt):
 *   - "dieses Jahr" = ab Referenzdatum bis 31.12. (vergangene Kurse sind
 *     für Suchende sinnlos); "dieses Quartal"/"diese Woche"/"dieser Monat"
 *     = voller Zeitraum.
 *   - Jahreszeiten meteorologisch (Herbst = 01.09.–30.11.).
 *   - "am Wochenende"/"dienstags" = weekdays-Filter, kein Datumsbereich.
 *   - Negation von online -> format [onsite, hybrid].
 *   - Monat/Datum ohne Jahr = nächstes Vorkommen ab Referenzdatum.
 */

const WEEKDAY_MAP = {
  montag: "mon",
  dienstag: "tue",
  mittwoch: "wed",
  donnerstag: "thu",
  freitag: "fri",
  samstag: "sat",
  sonnabend: "sat",
  sonntag: "sun",
};
const MONTHS = {
  januar: 1,
  februar: 2,
  märz: 3,
  maerz: 3,
  april: 4,
  mai: 5,
  juni: 6,
  juli: 7,
  august: 8,
  september: 9,
  oktober: 10,
  november: 11,
  dezember: 12,
};
const SEASONS = {
  frühling: [
    [3, 1],
    [5, 31],
  ],
  fruehling: [
    [3, 1],
    [5, 31],
  ],
  sommer: [
    [6, 1],
    [8, 31],
  ],
  herbst: [
    [9, 1],
    [11, 30],
  ],
  winter: [
    [12, 1],
    [2, 28],
  ], // über den Jahreswechsel
};

const iso = (d) => d.toISOString().slice(0, 10);
const mkDate = (y, m, day) => {
  const d = new Date(Date.UTC(y, m - 1, day));
  // Validitätscheck: JS normalisiert 45.13. still weiter — ablehnen.
  if (
    d.getUTCFullYear() !== y ||
    d.getUTCMonth() !== m - 1 ||
    d.getUTCDate() !== day
  )
    return null;
  return d;
};
const lastDayOfMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/**
 * @param {string} query - Bereits kontext-aufgelöste (umgeschriebene) Anfrage.
 * @param {object} opts
 * @param {string|Date} opts.referenceDate - "Heute" für relative Ausdrücke.
 * @param {string[]} [opts.knownLocations=[]] - Standortliste des Kunden
 *   (lowercase) — Ortsfilter entstehen NUR aus dieser Whitelist.
 * @returns {object} Filter-Objekt (leer, wenn nichts sicher erkennbar).
 */
function extractFilters(query, { referenceDate, knownLocations = [] } = {}) {
  const filters = {};
  if (typeof query !== "string" || !query.trim()) return filters;
  const q = ` ${query.toLowerCase().replace(/\s+/g, " ").trim()} `;
  const ref = new Date(
    typeof referenceDate === "string"
      ? `${referenceDate}T00:00:00Z`
      : Date.UTC(
          referenceDate.getFullYear(),
          referenceDate.getMonth(),
          referenceDate.getDate()
        )
  );
  const refY = ref.getUTCFullYear();
  const refM = ref.getUTCMonth() + 1;

  // --- Zeitraum (Datum) ----------------------------------------------------
  const addDays = (base, n) => new Date(base.getTime() + n * 86400000);
  const setRange = (from, to) => {
    if (from) filters.dateFrom = iso(from);
    if (to) filters.dateTo = iso(to);
  };
  // Nächstes Vorkommen eines Monats (voller Monat)
  const nextMonthOccurrence = (monthNum) => {
    const year = monthNum >= refM ? refY : refY + 1;
    return [
      mkDate(year, monthNum, 1),
      mkDate(year, monthNum, lastDayOfMonth(year, monthNum)),
    ];
  };
  // dd.mm.(yyyy)? -> nächstes Vorkommen; null bei ungültigem Datum
  const parseDayMonth = (dd, mm, yyyy) => {
    const day = parseInt(dd, 10),
      mon = parseInt(mm, 10);
    let year = yyyy ? parseInt(yyyy, 10) : refY;
    let d = mkDate(year, mon, day);
    if (!d) return null;
    if (!yyyy && d < ref) d = mkDate(year + 1, mon, day);
    return d;
  };

  const monthAlt = Object.keys(MONTHS).join("|");
  // Zahlwörter für relative Fenster ("in den nächsten zwei Wochen")
  const NUMWORDS = {
    ein: 1,
    eine: 1,
    einer: 1,
    einem: 1,
    zwei: 2,
    drei: 3,
    vier: 4,
    fünf: 5,
    fuenf: 5,
    sechs: 6,
    sieben: 7,
    acht: 8,
    neun: 9,
    zehn: 10,
    elf: 11,
    zwölf: 12,
    zwoelf: 12,
  };
  const numAlt = `\\d{1,2}|${Object.keys(NUMWORDS).join("|")}`;
  const toNum = (t) => (/^\d+$/.test(t) ? parseInt(t, 10) : NUMWORDS[t]);
  let matched = false;

  // "zwischen dem 01.08. und 15.08." / "vom X bis Y"
  let m = q.match(
    /(?:zwischen|vom)\s+(?:dem\s+)?(\d{1,2})\.(\d{1,2})\.(\d{4})?\s*(?:und|bis)\s+(?:zum\s+)?(\d{1,2})\.(\d{1,2})\.(\d{4})?/
  );
  if (m) {
    const from = parseDayMonth(m[1], m[2], m[3]);
    const to = parseDayMonth(m[4], m[5], m[6]);
    if (from && to) {
      setRange(from, to);
      matched = true;
    }
  }
  // "ab dem 15.09." / "ab 15.09.2026"
  // "in den nächsten / kommenden N Tagen|Wochen|Monaten", "in N Wochen", "innerhalb der nächsten N Wochen",
  // "die nächsten N Wochen" -> heute bis heute + N (Kursbeginn im Fenster). Bewusst NICHT: "seit N Wochen".
  if (
    !matched &&
    (m = q.match(
      new RegExp(
        `\\b(?:in(?:nerhalb)?|die)\\s+(?:(?:der|den)\\s+)?(?:(?:nächsten|naechsten|kommenden)\\s+)?(${numAlt})\\s+(tagen?|wochen?|monaten?)\\b`
      )
    ))
  ) {
    const n = toNum(m[1]);
    if (n && n > 0) {
      const unit = m[2].startsWith("tag")
        ? 1
        : m[2].startsWith("woch")
          ? 7
          : null;
      let to;
      if (unit) to = addDays(ref, n * unit);
      else {
        const total = refM - 1 + n,
          y = refY + Math.floor(total / 12),
          mo = (total % 12) + 1;
        const day = Math.min(ref.getUTCDate(), lastDayOfMonth(y, mo));
        to = mkDate(y, mo, day);
      }
      if (to) {
        setRange(ref, to);
        matched = true;
      }
    }
  }
  // "Anfang / Mitte / Ende <Monat> [Jahr]" -> Drittel des Monats (1–10 / 11–20 / 21–Ende)
  if (
    !matched &&
    (m = q.match(
      new RegExp(`\\b(anfang|mitte|ende)\\s+(${monthAlt})(?:\\s+(\\d{4}))?\\b`)
    ))
  ) {
    const mon = MONTHS[m[2]];
    const year = m[3] ? parseInt(m[3], 10) : mon >= refM ? refY : refY + 1;
    const last = lastDayOfMonth(year, mon);
    const [d1, d2] =
      m[1] === "anfang" ? [1, 10] : m[1] === "mitte" ? [11, 20] : [21, last];
    const from = mkDate(year, mon, d1),
      to = mkDate(year, mon, d2);
    if (from && to) {
      setRange(from, to);
      matched = true;
    }
  }
  if (
    !matched &&
    (m = q.match(/\bab\s+(?:dem\s+)?(\d{1,2})\.(\d{1,2})\.(\d{4})?/))
  ) {
    const from = parseDayMonth(m[1], m[2], m[3]);
    if (from) {
      setRange(from, null);
      matched = true;
    }
  }
  // "ab Oktober"
  if (!matched && (m = q.match(new RegExp(`\\bab\\s+(${monthAlt})\\b`)))) {
    const [from] = nextMonthOccurrence(MONTHS[m[1]]);
    if (from) {
      setRange(from, null);
      matched = true;
    }
  }
  // "bis (Ende) August" / "bis zum 15.09."
  if (
    !matched &&
    (m = q.match(new RegExp(`\\bbis\\s+(?:ende\\s+)?(${monthAlt})\\b`)))
  ) {
    const [, to] = nextMonthOccurrence(MONTHS[m[1]]);
    if (to) {
      setRange(null, to);
      matched = true;
    }
  }
  if (
    !matched &&
    (m = q.match(/\bbis\s+(?:zum\s+)?(\d{1,2})\.(\d{1,2})\.(\d{4})?/))
  ) {
    const to = parseDayMonth(m[1], m[2], m[3]);
    if (to) {
      setRange(null, to);
      matched = true;
    }
  }
  // Einzeldatum "am 12.09." (nur mit Präposition, sonst Kursnummern-Gefahr)
  if (
    !matched &&
    (m = q.match(/\b(?:am|den)\s+(\d{1,2})\.(\d{1,2})\.(\d{4})?(?![.\d])/))
  ) {
    const day = parseDayMonth(m[1], m[2], m[3]);
    if (day) {
      setRange(day, day);
      matched = true;
    } else matched = false; // ungültiges Datum -> kein Filter (TE10)
  }
  // Relative Ausdrücke
  if (!matched) {
    // Kein \b vor Umlauten (JS-\b ist ASCII-basiert und matcht vor "ü" nie)
    if (/übermorgen/.test(q)) {
      const d = addDays(ref, 2);
      setRange(d, d);
      matched = true;
    } else if (
      /\bmorgen\b/.test(q) &&
      !/\bvormittags?\b|\bmorgens\b|frühen morgen/.test(q)
    ) {
      const d = addDays(ref, 1);
      setRange(d, d);
      matched = true;
    } else if (/\bheute\b/.test(q)) {
      setRange(ref, ref);
      matched = true;
    } else if (/\bdiese woche\b/.test(q)) {
      const monday = addDays(ref, -((ref.getUTCDay() + 6) % 7));
      setRange(monday, addDays(monday, 6));
      matched = true;
    } else if (/\bnächste woche\b|\bnaechste woche\b/.test(q)) {
      const monday = addDays(ref, -((ref.getUTCDay() + 6) % 7) + 7);
      setRange(monday, addDays(monday, 6));
      matched = true;
    } else if (/\bdiesen monat\b|\bdieser monat\b|\bdiesem monat\b/.test(q)) {
      setRange(
        mkDate(refY, refM, 1),
        mkDate(refY, refM, lastDayOfMonth(refY, refM))
      );
      matched = true;
    } else if (/\bnächsten monat\b|\bnaechsten monat\b/.test(q)) {
      const y = refM === 12 ? refY + 1 : refY,
        mo = refM === 12 ? 1 : refM + 1;
      setRange(mkDate(y, mo, 1), mkDate(y, mo, lastDayOfMonth(y, mo)));
      matched = true;
    } else if (/\bdiesem quartal\b|\bdieses quartal\b/.test(q)) {
      const qStart = Math.floor((refM - 1) / 3) * 3 + 1;
      setRange(
        mkDate(refY, qStart, 1),
        mkDate(refY, qStart + 2, lastDayOfMonth(refY, qStart + 2))
      );
      matched = true;
    } else if (
      /\bnächsten quartal\b|\bnaechsten quartal\b|\bnächstes quartal\b/.test(q)
    ) {
      let qStart = Math.floor((refM - 1) / 3) * 3 + 4,
        y = refY;
      if (qStart > 12) {
        qStart = 1;
        y += 1;
      }
      setRange(
        mkDate(y, qStart, 1),
        mkDate(y, qStart + 2, lastDayOfMonth(y, qStart + 2))
      );
      matched = true;
    } else if (/\bdieses jahr\b|\bdiesem jahr\b/.test(q)) {
      setRange(ref, mkDate(refY, 12, 31));
      matched = true;
    }
  }
  // Jahreszeiten
  if (!matched) {
    for (const [season, [[fm, fd], [tm, td]]] of Object.entries(SEASONS)) {
      if (new RegExp(`\\bim ${season}\\b|\\b${season}kurse\\b`).test(q)) {
        const fromYear = fm >= refM ? refY : refY + 1;
        const toYear = tm < fm ? fromYear + 1 : fromYear; // Winter kreuzt Jahr
        const lastDay = tm === 2 ? lastDayOfMonth(toYear, 2) : td;
        setRange(mkDate(fromYear, fm, fd), mkDate(toYear, tm, lastDay));
        matched = true;
        break;
      }
    }
  }
  // "im September" (voller Monat, nächstes Vorkommen)
  if (!matched && (m = q.match(new RegExp(`\\bim\\s+(${monthAlt})\\b`)))) {
    const [from, to] = nextMonthOccurrence(MONTHS[m[1]]);
    if (from && to) setRange(from, to);
  }

  // --- Tageszeit -------------------------------------------------------------
  // --- Aus echten Beta-Fragen (23.09.2026, 2.229 Zeit-Kandidaten) ergänzte Formen ---------------------
  if (
    !filters.dateFrom &&
    !filters.dateTo &&
    (m = q.match(/(?<![\d.])(\d{1,2})\.(\d{1,2})\.(\d{4})(?![.\d])/))
  ) {
    const d = parseDayMonth(m[1], m[2], m[3]); // nacktes Datum "Erziehung Beziehung 10.03.2026"
    if (d) setRange(d, d);
  }
  if (!filters.dateFrom && !filters.dateTo) {
    // "<Tag>. <Monat> [Jahr]" / "am 1 September 2026" -> konkreter Tag
    if (
      (m = q.match(
        new RegExp(`\\b(\\d{1,2})\\.?\\s+(${monthAlt})(?:\\s+(\\d{4}))?\\b`)
      ))
    ) {
      const mon = MONTHS[m[2]],
        day = parseInt(m[1], 10);
      let year = m[3] ? parseInt(m[3], 10) : refY;
      let d = mkDate(year, mon, day);
      if (d && !m[3] && d < ref) d = mkDate(year + 1, mon, day);
      if (d) setRange(d, d);
    }
    // "Februar oder März", "März/April", "Februar bis März" -> Fenster über beide Monate
    else if (
      (m = q.match(
        new RegExp(
          `\\b(${monthAlt})\\s*(?:oder|/|bis|und|-|–)\\s*(${monthAlt})(?:\\s+(\\d{4}))?\\b`
        )
      ))
    ) {
      const m1 = MONTHS[m[1]],
        m2 = MONTHS[m[2]];
      const y1 = m[3] ? parseInt(m[3], 10) : m1 >= refM ? refY : refY + 1;
      const y2 = m2 >= m1 ? y1 : y1 + 1;
      setRange(mkDate(y1, m1, 1), mkDate(y2, m2, lastDayOfMonth(y2, m2)));
    }
    // nackter Monatsname, auch "in november", "für Mai", "Pilates Februar 2026"
    else if (
      (m = q.match(new RegExp(`\\b(${monthAlt})(?:\\s+(\\d{4}))?\\b`)))
    ) {
      const mon = MONTHS[m[1]];
      const year = m[2] ? parseInt(m[2], 10) : mon >= refM ? refY : refY + 1;
      // "seit <Monat>" ist Vergangenheit -> nicht filtern
      if (!new RegExp(`\\bseit\\s+${m[1]}`).test(q))
        setRange(
          mkDate(year, mon, 1),
          mkDate(year, mon, lastDayOfMonth(year, mon))
        );
    }
    // "nächstes Jahr" / "im Jahr 2027" / "für 2027"
    else if (
      /\bnächstes jahr\b|\bnaechstes jahr\b|\bkommendes jahr\b|\bim nächsten jahr\b/.test(
        q
      )
    ) {
      setRange(mkDate(refY + 1, 1, 1), mkDate(refY + 1, 12, 31));
    } else if (
      (m = q.match(/\b(?:im jahr|für|fuer|ab)\s+(20\d{2})\b/)) &&
      parseInt(m[1], 10) >= refY
    ) {
      const y = parseInt(m[1], 10);
      setRange(y === refY ? ref : mkDate(y, 1, 1), mkDate(y, 12, 31));
    }
    // "<Jahreszeit> <Jahr>" ("Sommer 2026", "Herbstprogramm") -> Jahreszeit meteorologisch
    else if (
      (m = q.match(
        /\b(frühling|fruehling|frühjahr|fruehjahr|sommer|herbst|winter)(?:programm|semester|kurse|halbjahr)?\b(?:\s+(\d{4}))?/
      ))
    ) {
      const key =
        m[1].startsWith("frühj") || m[1].startsWith("fruehj")
          ? "frühling"
          : m[1];
      const [[fm, fd], [tm, td]] = SEASONS[key] || SEASONS["frühling"];
      const fromYear = m[2] ? parseInt(m[2], 10) : fm >= refM ? refY : refY + 1;
      const toYear = tm < fm ? fromYear + 1 : fromYear;
      setRange(
        mkDate(fromYear, fm, fd),
        mkDate(toYear, tm, tm === 2 ? lastDayOfMonth(toYear, 2) : td)
      );
    }
    // "nächstes/neues/kommendes Semester" -> ab nächstem VHS-Semesterstart (1. Feb. / 1. Sep.), offenes Ende
    else if (
      /\b(?:nächste[sn]?|naechste[sn]?|neue[sn]?|kommende[sn]?)\s+semester\b/.test(
        q
      )
    ) {
      const start =
        refM < 2
          ? mkDate(refY, 2, 1)
          : refM < 9
            ? mkDate(refY, 9, 1)
            : mkDate(refY + 1, 2, 1);
      setRange(start, null);
    }
    // "der nächste Kurs", "wann startet/beginnt der nächste …", "demnächst", "bald", "in nächster Zeit", "in Kürze",
    // "ab sofort" -> nur zukünftige/laufende Kurse: Beginn ab heute (kein enges Fenster, im Zweifel weit)
    else if (
      /\b(?:nächste[rns]?|naechste[rns]?|kommende[rns]?)\s+(?:[\wäöüß-]+\s+){0,3}?(?:kurs|kurse|prüfung|pruefung|termin|termine|gruppe|start|durchgang|runde|möglichkeit|moeglichkeit|mal)\b|\bwann\s+(?:startet|beginnt|fängt|faengt|ist|findet|läuft|laeuft|geht)\b.*\bnächste|\bdemnächst\b|\bdemnaechst\b|\bbald\b|\bin kürze\b|\bin kuerze\b|\bin (?:der )?nächste[rn] zeit\b|\bab sofort\b|\bzeitnah\b/.test(
        q
      )
    ) {
      setRange(ref, null);
    }
  }
  // Uhrzeiten -> Tageszeit-Bucket: "um 18:00 Uhr", "ab 18 Uhr", "von 13.00-14.45 Uhr", "nach 17 Uhr"; nicht bei Öffnungszeiten-Fragen
  if (
    !/\böffnungszeit|\boeffnungszeit|\berreichbar\b|\btelefonisch\b|\bwie viel uhr ist\b|\bwieviel uhr ist\b/.test(
      q
    )
  ) {
    const hm = q.match(
      /\b(?:um|ab|von|nach|gegen)\s+(\d{1,2})(?:[:.]\d{2})?(?:\s*(?:-|–|bis)\s*\d{1,2}(?:[:.]\d{2})?)?\s*(?:uhr|h\b)/
    );
    if (hm) {
      const h = parseInt(hm[1], 10);
      if (h >= 0 && h < 24) filters.__hour = h;
    }
  }
  const buckets = new Set();
  if (
    /\babends?\b|\bam abend\b|\bspätnachmittag|abendkurs|abendveranstaltung|abendtermin|abendangebot/.test(
      q
    )
  )
    buckets.add("evening");
  if (
    /\bvormittags?\b|\bmorgens\b|frühen morgen|\bam vormittag\b|vormittagskurs|morgenkurs/.test(
      q
    )
  )
    buckets.add("morning");
  if (/\bnachmittags?\b|\bam nachmittag\b|\bmittags\b|nachmittagskurs/.test(q))
    buckets.add("afternoon");
  if (typeof filters.__hour === "number") {
    buckets.add(
      filters.__hour < 12
        ? "morning"
        : filters.__hour < 17
          ? "afternoon"
          : "evening"
    );
    delete filters.__hour;
  }
  if (buckets.size > 0 && buckets.size < 3) filters.timeOfDay = [...buckets];

  // --- Wochentage --------------------------------------------------------------
  const days = new Set();
  if (
    /\b(?:am|im|jedes|jeden|dieses|nächstes|kommendes|übernächstes)?\s*(?:kommenden|nächsten|naechsten)?\s*wochenende\b|\bwochenendkurs|\bwochenendseminar/.test(
      q
    )
  ) {
    days.add("sat");
    days.add("sun");
  }
  if (/\bunter der woche\b|\bwerktags\b|\bwochentags\b/.test(q))
    for (const d of ["mon", "tue", "wed", "thu", "fri"]) days.add(d);
  for (const [name, token] of Object.entries(WEEKDAY_MAP)) {
    if (new RegExp(`\\b${name}s\\b|\\bam ${name}\\b`).test(q)) days.add(token);
  }
  if (days.size > 0 && days.size < 7) filters.weekdays = [...days];

  // --- Preis -------------------------------------------------------------------
  if (
    /\bkostenlos|\bkostenfrei|\bgebührenfrei|\bgebuehrenfrei|\bgratis\b|\bumsonst\b|\bentgeltfrei/.test(
      q
    )
  ) {
    filters.freeOnly = true;
  }
  // Preisspanne: "zwischen 20 und 60 €", "von 50 bis 100 Euro", "20 bis 60 €", "20-60 €" -> priceMin + priceMax
  m = q.match(
    /(?:\b(?:zwischen|von)\s+)?\b(\d+(?:[.,]\d+)?)\s*(?:€|euros?|euro)?\s*(?:und|bis|-|–)\s*(\d+(?:[.,]\d+)?)\s*(?:€|euros?|euro)(?![a-z0-9])/
  );
  if (m) {
    const lo = parseFloat(m[1].replace(",", ".")),
      hi = parseFloat(m[2].replace(",", "."));
    if (Number.isFinite(lo) && Number.isFinite(hi) && lo >= 0 && hi >= lo) {
      filters.priceMin = lo;
      filters.priceMax = hi;
    }
  }
  // Kein \b NACH "€" (Nicht-Wort-Zeichen) — stattdessen negativer Lookahead.
  m =
    filters.priceMax !== undefined
      ? null
      : q.match(
          /\b(?:unter|maximal|max\.?|höchstens|hoechstens|weniger als|bis(?:\s+zu)?|für unter|fuer unter)\s+(\d+(?:[.,]\d+)?)\s*(?:€|euros?|euro)(?![a-z0-9])/
        );
  if (m) {
    const value = parseFloat(m[1].replace(",", "."));
    // "unter minus 20" o.ä.: Minus steht VOR der Zahl -> ablehnen
    const negated = new RegExp(`minus\\s+${m[1].replace(".", "\\.")}`).test(q);
    if (Number.isFinite(value) && value >= 0 && !negated)
      filters.priceMax = value;
  }

  // --- Status / Buchbarkeit ------------------------------------------------------
  // "nur noch Warteliste" / "ausgebucht" = nicht buchbar; "fast ausgebucht" zählt als noch buchbar.
  if (
    /\bwarteliste\b|\bausgebucht(?:e|en)?\b/.test(q) &&
    !/\bfast ausgebucht\b|\bohne warteliste\b|\bkeine warteliste\b|\bnicht ausgebucht\b/.test(
      q
    )
  ) {
    filters.bookable = false;
  } else if (
    /freien? plätzen?\b|freien? plaetzen?\b|\bnoch buchbar|\bbuchbare\b|\bnoch verfügbar|\bnoch verfuegbar|\bverfügbare\b|\bverfuegbare\b|\bnoch anmelden\b|anmeldung (noch )?möglich|\bfast ausgebucht\b|\bsind (?:noch )?frei\b|\bnoch frei\b|\bplätze frei\b|\bplaetze frei\b/.test(
      q
    )
  ) {
    filters.bookable = true;
  }

  // --- Format --------------------------------------------------------------------
  const onlineNegated = /\b(?:kein(?:e|en)?|nicht)\s+(?:\w+\s+)?online/.test(q);
  if (onlineNegated) {
    filters.format = ["onsite", "hybrid"];
  } else if (
    /\bonline\b|\bonlinekurs|\bonline-|von zuhause|von zu hause|\bwebinar\b|\blivestream\b/.test(
      q
    )
  ) {
    filters.format = ["online"];
  } else if (
    /\bin präsenz\b|\bin praesenz\b|\bpräsenzkurs|\bpraesenzkurs|\bvor ort\b/.test(
      q
    )
  ) {
    filters.format = ["onsite"];
  }

  // --- Ort (nur Whitelist!) ---------------------------------------------------------
  const locations = [];
  for (const loc of knownLocations) {
    if (new RegExp(`(^|[^a-zäöüß])${loc}([^a-zäöüß]|$)`).test(q))
      locations.push(loc);
  }
  if (locations.length > 0) filters.location = locations;

  return filters;
}

/**
 * Entfernt die Zeit-Bedingungen aus einem Filter-Objekt (Stufe 1 des
 * Leere-Treffer-Fallbacks: "in diesem Quartal nichts, aber ab Oktober ...").
 * @param {object} filters
 * @returns {object} Kopie ohne dateFrom/dateTo/timeOfDay/weekdays.
 */
function stripTimeFilters(filters = {}) {
  const { dateFrom, dateTo, timeOfDay, weekdays, ...rest } = filters;
  return rest;
}

module.exports = { extractFilters, stripTimeFilters };
