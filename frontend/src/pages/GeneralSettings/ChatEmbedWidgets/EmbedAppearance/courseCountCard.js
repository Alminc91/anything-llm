// Info-Karte der Kursanzahl in der Vorschau des Design Centers (KIE-576
// Paket 3, AK-K10): dieselben Zeilen und derselbe Wortlaut wie im Widget
// (Widget src/utils/courseCount.js courseCountTexts, Texte in
// src/utils/layout.js UI_TEXTS). Einzige Ablage dieser Texte im Fork; der
// Test designCenterCourseCountCard.test.mjs prüft sie gegen
// courseCountTexts der Vertrags-Fixture
// (server/__tests__/utils/chats/fixtures/embedConfigContract.json), die
// auch das Widget prüft. Bei einer Änderung des Wortlauts Widget, Fixture
// und diese Datei gemeinsam ändern.
//
// Zeilen (D-K5, Wortlaut B vom 26.10.2026, „da“ statt „weil“): head, scope, hiddenLine nur bei
// s > 0, missingLine nur bei m = b − n > 0, ab 5 % Lücke gapHint, stand.
// Einzahl (s = 1, m = 1) nur mit der Standardbezeichnung der Sprache, eine
// eigene Bezeichnung bleibt in der Mehrzahl. Zeit in Europe/Berlin.

export const COURSE_COUNT_GAP_HINT = 0.05;
const TIME_ZONE = "Europe/Berlin";
const LOCALES = { de: "de-DE", en: "en-US" };

export const COURSE_COUNT_TEXTS = {
  de: {
    word: "Kurse",
    lead: "aktuell",
    info: "Was bedeutet die Zahl?",
    dialog: "Info zur Kursanzahl",
    head: (n, w) => `${n} ${w} im KI-Berater`,
    scope: (w) => `Enthalten sind die aktuellen ${w} aus unserem Kursprogramm.`,
    hidden: (s, w) =>
      `${s} ${w} sind ausgeblendet, da sie voraussichtlich beendet sind.`,
    hiddenOne: "1 Kurs ist ausgeblendet, da er voraussichtlich beendet ist.",
    missing: (m, w) => `Zurzeit fehlen ${m} ${w}.`,
    missingOne: "Zurzeit fehlt 1 Kurs.",
    gap: "Für eine vollständige Suche nutzen Sie bitte die Kurssuche auf unserer Webseite.",
    stand: (when) =>
      `Stand: ${when}, stündlich aktualisiert. Verbindlich ist das Kursprogramm auf unserer Webseite.`,
    today: "heute",
    yesterday: "gestern",
  },
  en: {
    word: "courses",
    lead: "currently",
    info: "What does this number mean?",
    dialog: "About the number of courses",
    head: (n, w) => `${n} ${w} in the AI advisor`,
    scope: (w) => `This includes the current ${w} from our course program.`,
    hidden: (s, w) => `${s} ${w} are hidden because they have probably ended.`,
    hiddenOne: "1 course is hidden because it has probably ended.",
    missing: (m, w) => `${m} ${w} are currently missing.`,
    missingOne: "1 course is currently missing.",
    gap: "For a complete search, please use the course search on our website.",
    stand: (when) =>
      `Status: ${when}, updated hourly. The course program on our website is binding.`,
    today: "today",
    yesterday: "yesterday",
  },
};

function language(lang) {
  return lang === "en" ? "en" : "de";
}

export function formatCourseNumber(n, lang = "de") {
  return new Intl.NumberFormat(LOCALES[language(lang)]).format(n);
}

// Kalendertag in Europe/Berlin als Zahl der Tage seit 1970 (für heute,
// gestern), dazu Tag und Monat
function berlinDay(ms) {
  const parts = {};
  for (const p of new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(ms)))
    parts[p.type] = p.value;
  const index =
    Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)) /
    86400000;
  return { index, day: parts.day, month: parts.month };
}

// „heute, 10:00 Uhr“, „gestern, 10:00 Uhr“ oder „22.10., 10:00 Uhr“ in
// Europe/Berlin; englisch „today, 10:00 AM“, „yesterday, …“, „Oct 22, …“
export function courseStandText(stand, lang = "de", now = Date.now()) {
  const ms = Date.parse(stand);
  if (!Number.isFinite(ms)) return "";
  const l = language(lang);
  const t = COURSE_COUNT_TEXTS[l];
  const date = new Date(ms);
  const then = berlinDay(ms);
  const diff = berlinDay(now).index - then.index;
  let day;
  if (diff <= 0) day = t.today;
  else if (diff === 1) day = t.yesterday;
  else if (l === "de") day = `${then.day}.${then.month}.`;
  else
    day = new Intl.DateTimeFormat("en-US", {
      timeZone: TIME_ZONE,
      month: "short",
      day: "numeric",
    }).format(date);
  const time =
    l === "de"
      ? `${new Intl.DateTimeFormat("de-DE", {
          timeZone: TIME_ZONE,
          hour: "2-digit",
          minute: "2-digit",
          hourCycle: "h23",
        }).format(date)} Uhr`
      : new Intl.DateTimeFormat("en-US", {
          timeZone: TIME_ZONE,
          hour: "numeric",
          minute: "2-digit",
          hour12: true,
        }).format(date);
  return `${day}, ${time}`;
}

/**
 * Texte für Kopf und Info-Karte wie im Widget.
 * @param {{count: number, offered: number, hidden?: number, stand: string, word?: string|null}} value
 *   geprüfte Kursanzahl; word: gültige Bezeichnung oder leer (Standard der Sprache)
 * @param {"de"|"en"} [lang]
 * @param {number} [now] Uhrzeit in ms (Stand „heute“, „gestern“)
 */
export function courseCountCardTexts(value, lang = "de", now = Date.now()) {
  const l = language(lang);
  const t = COURSE_COUNT_TEXTS[l];
  const word = value.word || t.word;
  const standardWord = word === t.word;
  const n = formatCourseNumber(value.count, l);
  const hidden = value.hidden > 0 ? value.hidden : 0;
  const missing = Math.max(0, value.offered - value.count);
  const gap = missing / value.offered;
  return {
    lead: t.lead,
    number: n,
    word,
    subtitle: `${t.lead} ${n} ${word}`,
    info: t.info,
    dialog: t.dialog,
    head: t.head(n, word),
    scope: t.scope(word),
    hiddenLine:
      hidden === 0
        ? null
        : hidden === 1 && standardWord
          ? t.hiddenOne
          : t.hidden(formatCourseNumber(hidden, l), word),
    missingLine:
      missing === 0
        ? null
        : missing === 1 && standardWord
          ? t.missingOne
          : t.missing(formatCourseNumber(missing, l), word),
    gapHint: missing > 0 && gap >= COURSE_COUNT_GAP_HINT ? t.gap : null,
    stand: t.stand(courseStandText(value.stand, l, now)),
  };
}

/** Zeilen der Karte in der Reihenfolge des Widgets (ohne leere). */
export function courseCountCardLines(texts) {
  return [
    texts.head,
    texts.scope,
    texts.hiddenLine,
    texts.missingLine,
    texts.gapHint,
    texts.stand,
  ].filter(Boolean);
}
