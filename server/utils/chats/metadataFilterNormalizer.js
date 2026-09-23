/**
 * KIE-480 Stufe 2 — LLM-Normalisierer für Suchfilter (Kaskade hinter dem Regel-Extraktor).
 *
 * Grundsatz „LLM klassifiziert, Code rechnet": Das Modell gibt Zeitangaben SYMBOLISCH aus
 * ("today+14d", "month:2026-10:late_start", "next_week_start"), dieser Code löst sie deterministisch
 * in ISO-Daten auf. Damit entfallen die typischen LLM-Fehler (Datumsarithmetik, Wochenzählung).
 *
 * Exporte:
 *   hasFilterSignal(query)            grobes Wortnetz: steckt vermutlich eine Filterbedingung in der Frage?
 *   isLikelyGerman(query)             Heuristik ohne Netzwerk (Stoppwörter/Schrift)
 *   buildNormalizerPrompt(opts)       Systemprompt mit vorgerechneten Ankern + Few-Shots
 *   resolveSymbolicFilters(sym, ref)  symbolische Ausgabe -> konkretes Filterobjekt (Schema wie extractFilters)
 *   normalizeWithLLM(query, opts)     ruft opts.complete(system, user) auf, parst JSON, löst auf, validiert
 *   cascade(query, opts)              Regeln -> (Signal || nicht deutsch) -> LLM; liefert {filters, stage}
 *   always(query, opts)               LLM immer, Regeln nur bei Fehler/Timeout (Produktion, siehe metadataFilterResolver)
 */
const { extractFilters } = require("./metadataFilterExtractor");

const SIGNAL = new RegExp(
  "\\b(januar|februar|märz|maerz|april|mai|juni|juli|august|september|oktober|november|dezember|" +
    "montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonnabend|sonntag|wochenend|werktag|" +
    "vormittag|nachmittag|abend|morgens|mittags|uhr|heute|morgen|übermorgen|uebermorgen|nächste|naechste|kommende|" +
    "diese woche|dieser woche|monat|jahr|quartal|semester|ferien|herbst|winter|frühling|fruehling|frühjahr|fruehjahr|sommer|" +
    "zeitraum|zwischen|bald|demnächst|demnaechst|in kürze|in kuerze|sofort|zeitnah|" +
    "feierabend|tagsüber|tagsueber|nachts|nach der arbeit|vor der arbeit|angefangen|begonnen|gestartet|läuft schon|laeuft schon|" +
    "wochentag|werktags|unter der woche|am tag|abends|früh|spät|mittag|" +
    "€|euro|preis|kost|günstig|guenstig|billig|teuer|gebühr|gebuehr|" +
    "frei|plätze|plaetze|warteliste|ausgebucht|buchbar|verfügbar|verfuegbar|" +
    "online|präsenz|praesenz|vor ort|zuhause|zu hause|webinar|livestream|" +
    "\\d{1,2}\\.\\d{1,2}\\.|\\d{1,2}:\\d{2})",
  "i"
);
const DE_STOP =
  /\b(ich|ist|und|der|die|das|ein|eine|gibt|es|für|fuer|kurs|kurse|wann|wie|wo|kann|möchte|moechte|habe|nicht|mit|auf|zu|noch|auch|oder|welche|bitte|hallo|sie|wir|bei|von|im|am|an|den|dem|des|was|hat|sind|mein|meine|suche|gerne)\b/i;

function hasFilterSignal(query, knownLocations = []) {
  const q = ` ${String(query || "").toLowerCase()} `;
  if (SIGNAL.test(q)) return true;
  return knownLocations.some(
    (loc) => loc && q.includes(` ${String(loc).toLowerCase()}`)
  );
}

function isLikelyGerman(query) {
  const q = String(query || "");
  if (/[؀-ۿЀ-ӿͰ-Ͽ一-鿿぀-ヿ]/.test(q)) return false;
  const words = q.trim().split(/\s+/).length;
  const deHits = (q.match(new RegExp(DE_STOP.source, "gi")) || []).length;
  const enHits = (
    q.match(
      /\b(the|is|are|you|do|does|have|can|course|courses|when|where|how|what|please|want|need|there|for|and|with|class|classes|learn|evening|morning|weekend|price|under|online)\b/gi
    ) || []
  ).length;
  if (words <= 2) return true; // Stichworte: im Zweifel deutsch (Regeln greifen ohnehin nur bei deutschen Mustern)
  if (enHits >= 2 && enHits > deHits) return false;
  return deHits > 0 || /[äöüß]/.test(q);
}

// ---------------------------------------------------------------- symbolische Auflösung
const pad = (n) => String(n).padStart(2, "0");
const iso = (d) =>
  `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const mk = (y, m, d) => new Date(Date.UTC(y, m - 1, d));
const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const addDays = (d, n) => new Date(d.getTime() + n * 86400000);
const SEASONS = {
  spring: [
    [3, 1],
    [5, 31],
  ],
  summer: [
    [6, 1],
    [8, 31],
  ],
  autumn: [
    [9, 1],
    [11, 30],
  ],
  winter: [
    [12, 1],
    [2, 28],
  ],
};

/** Löst einen symbolischen Datumsausdruck auf. Unbekanntes -> null (Feld wird verworfen, nie geraten). */
function resolveDateExpr(expr, ref) {
  if (expr === null || expr === undefined) return null;
  const s = String(expr).trim();
  let m;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const [y, mo, d] = s.split("-").map(Number);
    const dt = mk(y, mo, d);
    return dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d ? s : null;
  }
  if (s === "today") return iso(ref);
  if ((m = s.match(/^today([+-])(\d+)([dwm])$/))) {
    const n = parseInt(m[2], 10) * (m[1] === "-" ? -1 : 1);
    if (m[3] === "d") return iso(addDays(ref, n));
    if (m[3] === "w") return iso(addDays(ref, 7 * n));
    const total = ref.getUTCMonth() + n,
      y = ref.getUTCFullYear() + Math.floor(total / 12),
      mo = (((total % 12) + 12) % 12) + 1;
    return iso(mk(y, mo, Math.min(ref.getUTCDate(), lastDay(y, mo))));
  }
  const monday = addDays(ref, -((ref.getUTCDay() + 6) % 7));
  if (s === "this_week_start") return iso(monday);
  if (s === "this_week_end") return iso(addDays(monday, 6));
  if (s === "next_week_start") return iso(addDays(monday, 7));
  if (s === "next_week_end") return iso(addDays(monday, 13));
  if (s === "this_month_start")
    return iso(mk(ref.getUTCFullYear(), ref.getUTCMonth() + 1, 1));
  if (s === "this_month_end")
    return iso(
      mk(
        ref.getUTCFullYear(),
        ref.getUTCMonth() + 1,
        lastDay(ref.getUTCFullYear(), ref.getUTCMonth() + 1)
      )
    );
  if (
    (m = s.match(
      /^month:(\d{4})-(\d{2}):(start|end|early_end|mid_start|mid_end|late_start)$/
    ))
  ) {
    const y = +m[1],
      mo = +m[2];
    if (mo < 1 || mo > 12) return null;
    const day = {
      start: 1,
      end: lastDay(y, mo),
      early_end: 10,
      mid_start: 11,
      mid_end: 20,
      late_start: 21,
    }[m[3]];
    return iso(mk(y, mo, day));
  }
  if ((m = s.match(/^year:(\d{4}):(start|end)$/)))
    return iso(m[2] === "start" ? mk(+m[1], 1, 1) : mk(+m[1], 12, 31));
  if (
    (m = s.match(/^season:(spring|summer|autumn|winter):(\d{4}):(start|end)$/))
  ) {
    const [[fm, fd], [tm, td]] = SEASONS[m[1]];
    const y = +m[2];
    if (m[3] === "start") return iso(mk(y, fm, fd));
    const ty = tm < fm ? y + 1 : y;
    return iso(mk(ty, tm, tm === 2 ? lastDay(ty, 2) : td));
  }
  if (
    (m = s.match(
      /^school_holiday:(christmas|autumn|summer|easter):(\d{4}):(start|end)$/
    ))
  ) {
    const y = +m[1 + 1];
    const tbl = {
      christmas: [mk(y, 12, 23), mk(y + 1, 1, 6)],
      autumn: [mk(y, 10, 12), mk(y, 10, 25)],
      summer: [mk(y, 7, 15), mk(y, 8, 31)],
      easter: [mk(y, 3, 29), mk(y, 4, 10)],
    };
    return iso(tbl[m[1]][m[3] === "start" ? 0 : 1]);
  }
  if ((m = s.match(/^semester:(next|this):(start|end)$/))) {
    const y = ref.getUTCFullYear(),
      mo = ref.getUTCMonth() + 1;
    const next = mo < 2 ? mk(y, 2, 1) : mo < 9 ? mk(y, 9, 1) : mk(y + 1, 2, 1);
    const cur = mo >= 9 ? mk(y, 9, 1) : mo >= 2 ? mk(y, 2, 1) : mk(y - 1, 9, 1);
    if (m[1] === "next")
      return iso(
        m[2] === "start"
          ? next
          : addDays(
              next.getUTCMonth() === 1
                ? mk(next.getUTCFullYear(), 7, 31)
                : mk(next.getUTCFullYear() + 1, 1, 31),
              0
            )
      );
    return iso(
      m[2] === "start"
        ? cur
        : cur.getUTCMonth() === 8
          ? mk(y + 1, 1, 31)
          : mk(y, 7, 31)
    );
  }
  return null;
}

const WD = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
/** Symbolische LLM-/Gold-Angabe -> Filterobjekt im Schema von extractFilters (dateFrom/dateTo ISO, …). */
function resolveSymbolicFilters(sym, referenceDate) {
  const ref =
    typeof referenceDate === "string"
      ? new Date(`${referenceDate}T00:00:00Z`)
      : new Date(
          Date.UTC(
            referenceDate.getFullYear(),
            referenceDate.getMonth(),
            referenceDate.getDate()
          )
        );
  const out = {};
  if (!sym || typeof sym !== "object") return out;
  const df = resolveDateExpr(sym.date_from ?? sym.dateFrom, ref),
    dt = resolveDateExpr(sym.date_to ?? sym.dateTo, ref);
  if (df) out.dateFrom = df;
  if (dt) out.dateTo = dt;
  if (out.dateFrom && out.dateTo && out.dateTo < out.dateFrom) {
    delete out.dateFrom;
    delete out.dateTo;
  }
  const tod = sym.time_of_day ?? sym.timeOfDay;
  if (Array.isArray(tod)) {
    const t = [
      ...new Set(
        tod.filter((x) => ["morning", "afternoon", "evening"].includes(x))
      ),
    ];
    if (t.length && t.length < 3) out.timeOfDay = t;
  }
  if (Array.isArray(sym.weekdays)) {
    const w = [...new Set(sym.weekdays.filter((x) => WD.includes(x)))];
    if (w.length && w.length < 7) out.weekdays = w;
  }
  for (const [k, o] of [
    ["price_min", "priceMin"],
    ["priceMin", "priceMin"],
    ["price_max", "priceMax"],
    ["priceMax", "priceMax"],
  ]) {
    const v = Number(sym[k]);
    if (sym[k] !== undefined && sym[k] !== null && Number.isFinite(v) && v >= 0)
      out[o] = v;
  }
  if (
    out.priceMin !== undefined &&
    out.priceMax !== undefined &&
    out.priceMin > out.priceMax
  ) {
    delete out.priceMin;
    delete out.priceMax;
  }
  if (sym.bookable === true || sym.bookable === false)
    out.bookable = sym.bookable;
  if (Array.isArray(sym.format)) {
    const f = [
      ...new Set(
        sym.format.filter((x) => ["online", "onsite", "hybrid"].includes(x))
      ),
    ];
    if (f.length) out.format = f;
  }
  if (Array.isArray(sym.location)) {
    const l = [
      ...new Set(
        sym.location
          .map((x) => String(x).trim().toLowerCase())
          .filter((x) => /^[a-z0-9äöüß\-. ]{1,80}$/.test(x))
      ),
    ];
    if (l.length) out.location = l;
  }
  return out;
}

// ---------------------------------------------------------------- Prompt
const WD_DE = [
  "Sonntag",
  "Montag",
  "Dienstag",
  "Mittwoch",
  "Donnerstag",
  "Freitag",
  "Samstag",
];
function buildNormalizerPrompt({ referenceDate, knownLocations = [] }) {
  const ref =
    typeof referenceDate === "string"
      ? new Date(`${referenceDate}T00:00:00Z`)
      : referenceDate;
  const today = iso(ref);
  const locs = knownLocations.length ? knownLocations.join(", ") : "(keine)";
  // Few-Shots mit den Orten DIESES Kunden (ohne Liste: dieselben Beispiele ohne Ortsteil),
  // damit kein fremder Kundenort als Beispiel im Prompt steht.
  const cap = (l) => String(l).replace(/(^|[\s-])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());
  const [L1, L2] = [knownLocations[0], knownLocations[1] || knownLocations[0]].map((l) =>
    l ? String(l).toLowerCase() : null
  );
  const locLine = L1
    ? `- "location": IMMER setzen, wenn ein Name aus dieser Liste in der Frage vorkommt (auch gebeugt oder als Adjektiv, z. B. "in ${cap(L1)}", "${cap(L1)}er"): ${locs}. Andere Orte ignorieren.`
    : `- "location": nie setzen (für diese Volkshochschule ist keine Ortsliste hinterlegt).`;
  const exPriceLocation = L1
    ? `"Englischkurs unter 60 Euro in ${cap(L1)}" → {"price_max":60,"location":["${L1}"]}`
    : `"Englischkurs unter 60 Euro" → {"price_max":60}`;
  const exBookableLocation = L2
    ? `"Welche Malkurse in ${cap(L2)} haben noch freie Plätze?" → {"bookable":true,"location":["${L2}"]}`
    : `"Welche Malkurse haben noch freie Plätze?" → {"bookable":true}`;
  return `Du extrahierst aus einer Kursanfrage an eine Volkshochschule harte Suchfilter als JSON. Du RECHNEST KEINE DATEN – du gibst Zeitangaben symbolisch an, ein Programm rechnet.
Heute: ${WD_DE[ref.getUTCDay()]}, ${today}.

Ausgabe: NUR ein JSON-Objekt, keine Erklärung. Nur Felder setzen, die in der Frage ausdrücklich vorkommen. Kein Filter erkennbar → {}.
Felder:
- "date_from"/"date_to": Kursbeginn-Zeitraum. Werte: "today", "today+14d", "today+3w", "today+2m", "next_week_start", "next_week_end", "this_month_end", "month:YYYY-MM:start|end|early_end|mid_start|mid_end|late_start", "year:YYYY:start|end", "season:spring|summer|autumn|winter:YYYY:start|end", "semester:next:start", "school_holiday:christmas|autumn:YYYY:end", oder ein explizit genanntes Datum "YYYY-MM-DD".
  Konventionen: "nächste Woche" = next_week_start..next_week_end; "in den nächsten 2 Wochen" = today..today+2w; "im Dezember" ohne Jahr = nächstes Vorkommen; "Anfang/Ende <Monat>" = start..early_end / late_start..end; "nächstes Jahr" = year:${ref.getUTCFullYear() + 1}:start..end; "demnächst/bald/der nächste Kurs/in nächster Zeit" = nur date_from "today"; "noch dieses Jahr" = today..year:${ref.getUTCFullYear()}:end.
- "time_of_day": ["morning"] (Beginn vor 12 Uhr), ["afternoon"] (12–17), ["evening"] (ab 17 Uhr). Uhrzeiten entsprechend einordnen ("um 18 Uhr" → evening, "nach der Arbeit" → evening).
- "weekdays": aus mon,tue,wed,thu,fri,sat,sun ("am Wochenende" → ["sat","sun"], "unter der Woche" → mon–fri).
- "price_min"/"price_max": Zahlen in Euro, nur bei genannten Beträgen ("unter 50 €" → price_max 50; "zwischen 20 und 60 €" → 20/60).
- "bookable": true bei "freie Plätze/buchbar/noch anmelden", false bei "Warteliste/ausgebucht".
- "format": ["online"] oder ["onsite"] ("vor Ort", "in Präsenz", "nicht online" → onsite).
${locLine}
Nicht setzen: Thema, Sprachniveau, Zielgruppe, Dozent, Kursnummer (das übernimmt die Suche). Fragen nach einem Termin ("Wann beginnt der Kurs X?") sind Informationsfragen → {} (außer "der nächste …" → date_from today).
Andere Sprachen genauso behandeln.

Beispiele:
"Gibt es abends Yogakurse in den nächsten 2 Wochen?" → {"date_from":"today","date_to":"today+2w","time_of_day":["evening"]}
"Welche Kurse fangen Ende Oktober an?" → {"date_from":"month:${ref.getUTCFullYear()}-10:late_start","date_to":"month:${ref.getUTCFullYear()}-10:end"}
${exPriceLocation}
"Wann beginnt der Spanischkurs A1?" → {}
"Ich möchte Excel lernen." → {}
"Are there any English classes on Saturday mornings?" → {"weekdays":["sat"],"time_of_day":["morning"]}
"Welche Kurse haben nur noch Warteliste?" → {"bookable":false}
${exBookableLocation}
"Kurse vormittags im VHS-Gebäude" → {"time_of_day":["morning"]}  (Gebäude ist kein Format und kein Listenort)`;
}

// ---------------------------------------------------------------- LLM-Aufruf + Kaskade
/**
 * @param {string} query
 * @param {{referenceDate:string|Date, knownLocations?:string[], previousMessages?:string[], complete:(system:string,user:string)=>Promise<string>, timeoutMs?:number}} opts
 * @returns {Promise<{filters:object, raw:string|null, error:string|null}>}
 */
// Nur mit Verlauf angehängt — Einzelfragen sehen exakt den gemessenen Prompt (315/320).
const CARRY_RULES = `

Gesprächsverlauf: Wenn frühere Nachrichten der Nutzerin/des Nutzers mitgeschickt werden, gib die Filter an, die für die AKTUELLE Suche gelten:
- Bedingungen aus früheren Nachrichten gelten weiter, solange die aktuelle Nachricht dasselbe Anliegen weiterführt (Nachfrage, Ergänzung, "und …?", "gibt's das auch …").
- Eine neue Angabe zur selben Bedingung ERSETZT die alte ("lieber vormittags", "und in <Ort>?").
- "egal", "ist mir egal", "auch … ist ok", "geht auch" HEBT die betreffende Bedingung auf (nicht setzen; "online geht auch" = kein Format-Filter).
- Neues Thema ohne Bezug ("ganz was anderes", anderer Kurswunsch ohne "auch/und") → nur Bedingungen der aktuellen Nachricht.`;

/** Nutzer-Nachricht für den Normalisierer; mit Verlauf als Liste früherer Nachrichten. */
function normalizerUserMessage(query, previousMessages = []) {
  const prev = (previousMessages || []).filter((m) => typeof m === "string" && m.trim());
  if (!prev.length) return String(query);
  return `Frühere Nachrichten (älteste zuerst):\n${prev.map((m) => `- ${m}`).join("\n")}\n\nAktuelle Nachricht: ${query}`;
}

async function normalizeWithLLM(query, opts) {
  const hasHistory = (opts.previousMessages || []).some((m) => typeof m === "string" && m.trim());
  const system = buildNormalizerPrompt(opts) + (hasHistory ? CARRY_RULES : "");
  const timeoutMs = opts.timeoutMs ?? 1500;
  let raw = null;
  let timer = null;
  try {
    raw = await Promise.race([
      opts.complete(system, normalizerUserMessage(query, opts.previousMessages)),
      new Promise((_, rej) => {
        timer = setTimeout(
          () => rej(new Error(`normalizer timeout ${timeoutMs}ms`)),
          timeoutMs
        );
      }),
    ]);
    const m = String(raw ?? "").match(/\{[\s\S]*\}/);
    // Keine JSON-Antwort ist ein Fehler (→ Regel-Rückfall), nicht "kein Filter".
    if (!m) throw new Error("normalizer: no JSON object in LLM output");
    const sym = JSON.parse(m[0]);
    return {
      filters: resolveSymbolicFilters(sym, opts.referenceDate),
      raw,
      error: null,
    };
  } catch (e) {
    return { filters: {}, raw, error: e.message }; // im Zweifel nicht filtern
  } finally {
    clearTimeout(timer);
  }
}

const TIME_KEYS = ["dateFrom", "dateTo", "timeOfDay", "weekdays"];
const hasAny = (f) => f && Object.keys(f).length > 0;

/** Kaskade: Regeln zuerst; LLM nur bei Signal ohne Regeltreffer oder nicht-deutscher Frage. */
async function cascade(query, opts) {
  const rules = extractFilters(query, {
    referenceDate: opts.referenceDate,
    knownLocations: opts.knownLocations || [],
  });
  const german = isLikelyGerman(query);
  const signal = hasFilterSignal(query, opts.knownLocations || []);
  if (hasAny(rules) && german) return { filters: rules, stage: "rules" };
  if (!german || signal) {
    const r = await normalizeWithLLM(query, opts);
    if (hasAny(r.filters))
      return { filters: r.filters, stage: "llm", error: r.error };
    return {
      filters: rules,
      stage: hasAny(rules) ? "rules" : "none",
      error: r.error,
    };
  }
  return { filters: rules, stage: hasAny(rules) ? "rules" : "none" };
}

/** LLM-zuerst-Variante: Signal oder Fremdsprache -> LLM; bei Fehler/Timeout Regeln; ohne Signal kein Filter. */
async function gated(query, opts) {
  const german = isLikelyGerman(query);
  const signal = hasFilterSignal(query, opts.knownLocations || []);
  if (german && !signal) return { filters: {}, stage: "none" };
  const r = await normalizeWithLLM(query, opts);
  if (!r.error) return { filters: r.filters, stage: "llm" };
  const rules = extractFilters(query, {
    referenceDate: opts.referenceDate,
    knownLocations: opts.knownLocations || [],
  });
  return { filters: rules, stage: "rules-fallback", error: r.error };
}

/**
 * Verfahren der Wahl (unabhängiger Testsatz 23.09.2026: 315/320, Median 286 ms): LLM IMMER;
 * nur wenn der Aufruf scheitert (Timeout, Netz, unparsbares JSON), greift der Regel-Extraktor.
 * Ein leeres LLM-Ergebnis ({}) ist eine gültige Antwort ("kein Filter") und wird NICHT durch
 * Regeln überstimmt — die Regeln machen gerade dort ihre selbstbewussten Fehlfilter.
 */
async function always(query, opts) {
  const r = await normalizeWithLLM(query, opts);
  if (!r.error) return { filters: r.filters, stage: "llm" };
  const rules = extractFilters(query, {
    referenceDate: opts.referenceDate,
    knownLocations: opts.knownLocations || [],
  });
  return { filters: rules, stage: "rules-fallback", error: r.error };
}

/** opts.complete für einen AnythingLLM-LLM-Provider (getChatCompletion, Temperatur 0). */
function completeWith(LLMConnector) {
  return async (system, user) => {
    const res = await LLMConnector.getChatCompletion(
      [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      { temperature: 0 }
    );
    return String(res?.textResponse || "").replace(/<think>[\s\S]*?<\/think>/g, "");
  };
}

module.exports = {
  CARRY_RULES,
  normalizerUserMessage,
  always,
  completeWith,
  gated,
  hasFilterSignal,
  isLikelyGerman,
  buildNormalizerPrompt,
  resolveDateExpr,
  resolveSymbolicFilters,
  normalizeWithLLM,
  cascade,
  TIME_KEYS,
};
