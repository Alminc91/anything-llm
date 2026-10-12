// KIE-536: Zeitraum, Körnungs-Beschriftung, Kennzahlen und Geometrie des
// Säulendiagramms der Ansicht „Konversationen" – die Logik ohne React
// (src/utils/analyticsTimeline.js), geprüft mit den deutschen Texten der
// Sprachdatei.
//
// Die Zeitzone des Prozesses wird nicht gesetzt: Kalendertage dürfen nicht
// von ihr abhängen (über nodeTests.test.js läuft die Datei in TZ=UTC,
// Europe/Berlin und America/New_York).
import test from "node:test";
import assert from "node:assert/strict";
import de from "../src/locales/de/common.js";
import en from "../src/locales/en/common.js";
// Die Prüfung des Servers, gegen die der Browser seinen Zeitraum bildet.
import ledgerTimeline from "../../server/utils/helpers/ledgerTimeline.js";
import {
  BAR_MAX_WIDTH,
  DEFAULT_RANGE_DAYS,
  MAX_BUCKETS,
  addDays,
  allTimeRange,
  barPath,
  bucketLabel,
  bucketTick,
  chartState,
  columnLayout,
  countsSinceDay,
  daysBetween,
  formatDate,
  formatMonth,
  formatNumber,
  isoWeek,
  kpiValues,
  lastDaysRange,
  lastMonthsRange,
  rangeFromDates,
  showsDeletedHint,
  tickLabelWidth,
  tickStep,
  toDayString,
  valueLabel,
  valueScale,
  viewState,
} from "../src/utils/analyticsTimeline.js";

/** t() über einer Sprachdatei: Punktpfade, {{Platzhalter}}, _one/_other. */
function translator(resources) {
  const lookup = (key) =>
    key.split(".").reduce((node, part) => node?.[part], resources);
  return (key, params = {}) => {
    let text = lookup(key);
    if (text === undefined && "count" in params)
      text = lookup(`${key}_${params.count === 1 ? "one" : "other"}`);
    assert.equal(typeof text, "string", `Text fehlt: ${key}`);
    return text.replace(/{{(\w+)}}/g, (_match, name) => String(params[name]));
  };
}
const t = translator(de);
const context = { t, locale: "de" };
const tooltip = (bucket, granularity, metric) =>
  t("embed-analytics.chart.tooltip", {
    period: bucketLabel(bucket, granularity, context),
    value: valueLabel(bucket[metric], metric, t),
  });

// ---------------------------------------------------------------------------
// Zeitraum
// ---------------------------------------------------------------------------

test("Standard-Zeitraum (AK-12): letzte 30 Tage = heute und die 29 Tage davor", () => {
  assert.equal(DEFAULT_RANGE_DAYS, 30);
  const now = new Date(2026, 9, 12, 15, 30);
  const { startDate, endDate } = lastDaysRange(DEFAULT_RANGE_DAYS, now);
  const range = rangeFromDates(startDate, endDate);

  assert.deepEqual(range, { fromDay: "2026-09-13", toDay: "2026-10-12" });
  assert.equal(daysBetween(range.fromDay, range.toDay) + 1, 30);
  // Die Liste bekommt dieselben Tage als Zeitstempel: 00:00 bis 23:59:59,999.
  assert.deepEqual(
    [startDate.getHours(), startDate.getMinutes(), startDate.getSeconds()],
    [0, 0, 0]
  );
  assert.deepEqual(
    [endDate.getHours(), endDate.getMinutes(), endDate.getMilliseconds()],
    [23, 59, 999]
  );
});

test("Standard-Zeitraum: über Monats- und Jahreswechsel", () => {
  const range = (now) => {
    const { startDate, endDate } = lastDaysRange(30, now);
    return rangeFromDates(startDate, endDate);
  };
  assert.deepEqual(range(new Date(2026, 0, 5, 0, 0)), {
    fromDay: "2025-12-07",
    toDay: "2026-01-05",
  });
  assert.deepEqual(range(new Date(2024, 2, 1, 23, 59)), {
    fromDay: "2024-02-01",
    toDay: "2024-03-01",
  });
});

test("Letzte 12 Monate: der Tag nach dem heutigen Datum vor einem Jahr bis heute", () => {
  const { startDate, endDate } = lastMonthsRange(
    12,
    new Date(2026, 9, 12, 9, 0)
  );
  const range = rangeFromDates(startDate, endDate);
  assert.deepEqual(range, { fromDay: "2025-10-13", toDay: "2026-10-12" });
  assert.equal(daysBetween(range.fromDay, range.toDay) + 1, 365);
});

test("Der gesendete Kalendertag ist der gewählte Tag, nicht der UTC-Tag", () => {
  // Mitternacht und letzte Minute desselben lokalen Tages
  assert.equal(toDayString(new Date(2026, 9, 6, 0, 0, 0)), "2026-10-06");
  assert.equal(toDayString(new Date(2026, 9, 6, 23, 59, 59)), "2026-10-06");
  assert.equal(toDayString(new Date(2026, 0, 1, 0, 30)), "2026-01-01");
  assert.equal(toDayString(new Date(2025, 11, 31, 23, 30)), "2025-12-31");
  assert.deepEqual(
    rangeFromDates(new Date(2026, 9, 6, 0, 0), new Date(2026, 9, 6, 23, 59)),
    { fromDay: "2026-10-06", toDay: "2026-10-06" }
  );
});

test("„Gesamt“: kein Zeitraum aus der Datumsauswahl, dafür vom ersten Zählwert bis heute", () => {
  assert.equal(rangeFromDates(null, null), null);
  assert.deepEqual(allTimeRange("2026-08-03", "2026-10-12"), {
    fromDay: "2026-08-03",
    toDay: "2026-10-12",
  });
  // ohne Zählwerte: nur heute
  assert.deepEqual(allTimeRange(null, "2026-10-12"), {
    fromDay: "2026-10-12",
    toDay: "2026-10-12",
  });
  // höchstens der längste Zeitraum, den der Server annimmt: 92 Kalendermonate
  assert.deepEqual(allTimeRange("2001-05-17", "2026-10-12"), {
    fromDay: "2019-03-01",
    toDay: "2026-10-12",
  });
  assert.deepEqual(allTimeRange("2019-03-01", "2026-10-12"), {
    fromDay: "2019-03-01",
    toDay: "2026-10-12",
  });
  assert.deepEqual(allTimeRange("2019-02-28", "2026-10-12"), {
    fromDay: "2019-03-01",
    toDay: "2026-10-12",
  });
});

test("„Gesamt“ (AK-3): Der längste Zeitraum des Browsers ist für den Server gültig und ergibt genau 92 Monats-Säulen", () => {
  const {
    MAX_BUCKETS: serverMax,
    validateDayRange,
    timelineLayout,
  } = ledgerTimeline;
  assert.equal(MAX_BUCKETS, 92);
  assert.equal(MAX_BUCKETS, serverMax);

  // heute: Monatsanfang, Monatsende, Schalttag, Jahreswechsel
  for (const today of [
    "2026-10-12",
    "2026-10-01",
    "2026-10-31",
    "2028-02-29",
    "2027-01-01",
    "2026-12-31",
    "2026-03-31",
  ]) {
    const range = allTimeRange("2001-05-17", today);
    assert.equal(range.toDay, today);
    assert.equal(range.fromDay.slice(8), "01", today);
    assert.equal(
      validateDayRange(range.fromDay, range.toDay).valid,
      true,
      `${range.fromDay} bis ${today}`
    );
    const layout = timelineLayout(range.fromDay, range.toDay);
    assert.equal(layout.granularity, "month");
    assert.equal(layout.buckets.length, 92, today);
    // Ein Tag früher wäre dem Server zu lang.
    assert.equal(
      validateDayRange(addDays(range.fromDay, -1), today).valid,
      false,
      today
    );
  }
});

test("Kalendertage rechnen ohne Zeitzone – auch über die Zeitumstellung", () => {
  assert.equal(addDays("2026-03-28", 1), "2026-03-29");
  assert.equal(addDays("2026-03-29", 1), "2026-03-30");
  assert.equal(addDays("2026-10-25", 1), "2026-10-26");
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(addDays("2024-03-01", -1), "2024-02-29");
  assert.equal(daysBetween("2026-03-01", "2026-04-01"), 31);
  assert.equal(daysBetween("2026-10-01", "2026-11-01"), 31);
});

test("Kalenderwoche nach ISO 8601 (Montag–Sonntag)", () => {
  assert.deepEqual(isoWeek("2026-10-05"), { year: 2026, week: 41 });
  assert.deepEqual(isoWeek("2026-10-11"), { year: 2026, week: 41 });
  assert.deepEqual(isoWeek("2026-10-12"), { year: 2026, week: 42 });
  assert.deepEqual(isoWeek("2025-12-29"), { year: 2026, week: 1 });
  assert.deepEqual(isoWeek("2026-01-01"), { year: 2026, week: 1 });
  assert.deepEqual(isoWeek("2021-01-03"), { year: 2020, week: 53 });
  assert.deepEqual(isoWeek("2027-01-03"), { year: 2026, week: 53 });
});

// ---------------------------------------------------------------------------
// Körnung und Beschriftung
// ---------------------------------------------------------------------------

test("Beschriftung der Körnung: pro Stunde, pro Tag, pro Woche, pro Monat (AK-1, AK-9)", () => {
  assert.deepEqual(de["embed-analytics"].chart.per, {
    hour: "pro Stunde",
    day: "pro Tag",
    week: "pro Woche",
    month: "pro Monat",
  });
  assert.deepEqual(de["embed-analytics"].chart.metric, {
    messages: "Nachrichten",
    conversations: "Konversationen",
  });
  assert.equal(de["embed-analytics"].chart["as-table"], "Als Tabelle");
});

test("Tooltip am Tagesdiagramm (AK-6): Wochentag, Datum und Wert", () => {
  const bucket = {
    start: "2026-10-06",
    end: "2026-10-06",
    partial: false,
    messages: 37,
    conversations: 1,
  };
  assert.equal(bucketLabel(bucket, "day", context), "Di., 06.10.2026");
  assert.equal(
    tooltip(bucket, "day", "messages"),
    "Di., 06.10.2026 — 37 Nachrichten"
  );
  assert.equal(
    tooltip(bucket, "day", "conversations"),
    "Di., 06.10.2026 — 1 Konversation"
  );
  assert.equal(
    tooltip({ ...bucket, messages: 0 }, "day", "messages"),
    "Di., 06.10.2026 — 0 Nachrichten"
  );
});

test("Werte: Einzahl, Mehrzahl, deutsche Tausenderpunkte", () => {
  assert.equal(valueLabel(1, "messages", t), "1 Nachricht");
  assert.equal(valueLabel(2, "messages", t), "2 Nachrichten");
  assert.equal(valueLabel(1234, "messages", t), "1.234 Nachrichten");
  assert.equal(valueLabel(0, "conversations", t), "0 Konversationen");
  assert.equal(formatNumber(12.34, 1), "12,3");
  assert.equal(formatNumber(1234567), "1.234.567");
  assert.equal(formatDate("2026-08-03"), "03.08.2026");
});

test("Stunden: Tag und Stundenbereich", () => {
  const bucket = { start: "2026-10-06", end: "2026-10-06", hour: 13 };
  assert.equal(
    bucketLabel(bucket, "hour", context),
    "Di., 06.10.2026, 13–14 Uhr"
  );
  assert.equal(
    bucketLabel({ ...bucket, hour: 23 }, "hour", context),
    "Di., 06.10.2026, 23–24 Uhr"
  );
  assert.equal(bucketTick(bucket, "hour", context), "13 Uhr");
  assert.equal(bucketTick({ ...bucket, hour: 0 }, "hour", context), "0 Uhr");
});

test("Wochen: ganze Kalenderwoche mit Bereich, angeschnittene mit dem tatsächlichen Bereich", () => {
  assert.equal(
    bucketLabel(
      { start: "2026-10-05", end: "2026-10-11", partial: false },
      "week",
      context
    ),
    "KW 41 (05.10.–11.10.2026)"
  );
  // Der Zeitraum endet am Montag der KW 42.
  assert.equal(
    bucketLabel(
      { start: "2026-10-12", end: "2026-10-12", partial: true },
      "week",
      context
    ),
    "KW 42 – bis 12.10."
  );
  // Der Zeitraum beginnt am Mittwoch der KW 27.
  assert.equal(
    bucketLabel(
      { start: "2026-07-01", end: "2026-07-05", partial: true },
      "week",
      context
    ),
    "KW 27 – ab 01.07."
  );
  // Beginn und Ende in derselben Kalenderwoche angeschnitten
  assert.equal(
    bucketLabel(
      { start: "2026-10-13", end: "2026-10-15", partial: true },
      "week",
      context
    ),
    "KW 42 – 13.10. bis 15.10."
  );
  // Jahreswechsel: Die Woche 29.12.2025–04.01.2026 ist die KW 1.
  assert.equal(
    bucketLabel(
      { start: "2025-12-29", end: "2026-01-04", partial: false },
      "week",
      context
    ),
    "KW 1 (29.12.–04.01.2026)"
  );
  assert.equal(
    bucketTick({ start: "2026-10-05", end: "2026-10-11" }, "week", context),
    "KW 41"
  );
});

test("Monate: ganzer Monat mit Namen, angeschnittener mit dem tatsächlichen Bereich", () => {
  assert.equal(
    bucketLabel(
      { start: "2026-09-01", end: "2026-09-30", partial: false },
      "month",
      context
    ),
    "September 2026"
  );
  assert.equal(
    bucketLabel(
      { start: "2024-02-01", end: "2024-02-29", partial: false },
      "month",
      context
    ),
    "Februar 2024"
  );
  assert.equal(
    bucketLabel(
      { start: "2026-10-01", end: "2026-10-12", partial: true },
      "month",
      context
    ),
    "Oktober 2026 – bis 12.10."
  );
  assert.equal(
    bucketLabel(
      { start: "2023-10-09", end: "2023-10-31", partial: true },
      "month",
      context
    ),
    "Oktober 2023 – ab 09.10."
  );
  assert.equal(
    bucketTick({ start: "2026-10-01", end: "2026-10-12" }, "month", context),
    "Okt. 2026"
  );
  assert.equal(
    bucketTick({ start: "2026-10-06", end: "2026-10-06" }, "day", context),
    "06.10."
  );
});

test("Englische Oberfläche: Namen englisch, Datumsangaben in deutscher Schreibweise", () => {
  const english = { t: translator(en), locale: "en" };
  assert.equal(
    bucketLabel({ start: "2026-10-06", end: "2026-10-06" }, "day", english),
    "Tue, 06.10.2026"
  );
  assert.equal(
    bucketLabel(
      { start: "2026-10-01", end: "2026-10-12", partial: true },
      "month",
      english
    ),
    "October 2026 – until 12.10."
  );
  assert.equal(valueLabel(1, "messages", english.t), "1 message");
});

test("Monate in Sprachen mit anderem Kalender (fa, ar-SA): der gregorianische Monat zum gregorianischen Jahr", () => {
  // Der Oktober 2026 liegt im persischen Monat Mehr 1405 und im
  // Hidschra-Monat Rabīʿ ath-thānī 1448 – beide Namen wären hier falsch.
  const october = new Date("2026-10-01T00:00:00Z");
  const monthIn = (tag) =>
    new Intl.DateTimeFormat(tag, { month: "long", timeZone: "UTC" }).format(
      october
    );
  for (const [locale, foreign] of [
    ["fa", "persian"],
    ["ar-sa", "islamic-umalqura"],
    ["ar", "islamic-umalqura"],
  ]) {
    const gregorian = monthIn(`${locale}-u-ca-gregory`);
    const other = monthIn(`${locale}-u-ca-${foreign}`);
    assert.notEqual(gregorian, other, locale);

    const label = formatMonth("2026-10-01", locale);
    assert.ok(label.includes(gregorian), `${locale}: ${label}`);
    assert.ok(!label.includes(other), `${locale}: ${label}`);
    // Das Jahr in denselben Ziffern wie die Datumsangaben daneben
    assert.ok(label.includes("2026"), `${locale}: ${label}`);
    assert.doesNotMatch(label, /1405|1448|[٠-٩۰-۹]/, locale);

    const tick = bucketTick(
      { start: "2026-10-01", end: "2026-10-31" },
      "month",
      { t, locale }
    );
    assert.ok(tick.includes("2026") && !tick.includes(other), tick);
    assert.equal(
      bucketLabel(
        { start: "2026-10-01", end: "2026-10-12", partial: true },
        "month",
        { t, locale }
      ),
      `${label} – bis 12.10.`
    );
  }
});

test("Monate in Sprachen, die den Monat als Zahl schreiben (ja, zh, zh-tw, ko): Monat und Jahr in der Schreibweise der Sprache", () => {
  for (const [locale, long] of [
    ["ja", "2026年10月"],
    ["zh", "2026年10月"],
    ["zh-tw", "2026年10月"],
    ["ko", "2026년 10월"],
  ]) {
    assert.equal(formatMonth("2026-10-01", locale), long, locale);
    assert.equal(
      bucketTick({ start: "2026-10-01", end: "2026-10-31" }, "month", {
        t,
        locale,
      }),
      long,
      locale
    );
  }
  // Wo der Monat einen Namen hat, bleibt es bei Name und Jahr.
  assert.equal(formatMonth("2026-10-01", "de"), "Oktober 2026");
  assert.equal(formatMonth("2026-10-01", "de", "short"), "Okt. 2026");
  assert.equal(formatMonth("2026-10-01", "en"), "October 2026");
  assert.equal(formatMonth("2026-03-01", "fr"), "mars 2026");
});

test("Wochentag in Sprachen mit anderem Kalender: Name der Sprache, Datum in deutscher Schreibweise", () => {
  const tuesday = new Intl.DateTimeFormat("fa", {
    weekday: "short",
    timeZone: "UTC",
  }).format(new Date("2026-10-06T00:00:00Z"));
  assert.equal(
    bucketLabel({ start: "2026-10-06", end: "2026-10-06" }, "day", {
      t,
      locale: "fa",
    }),
    `${tuesday}, 06.10.2026`
  );
});

test("Unbekannte Sprache der Oberfläche: Beschriftung fällt nicht aus", () => {
  const label = bucketLabel({ start: "2026-10-06", end: "2026-10-06" }, "day", {
    t,
    locale: "keine_sprache!",
  });
  assert.match(label, /06\.10\.2026$/);
});

// ---------------------------------------------------------------------------
// Zustände
// ---------------------------------------------------------------------------

const summaryOf = (overrides = {}) => ({
  granularity: "day",
  fromDay: "2026-10-01",
  toDay: "2026-10-03",
  firstLedgerDay: "2026-09-01",
  totals: {
    messages: 12,
    conversations: 5,
    feedbackPositive: 3,
    feedbackNegative: 1,
  },
  buckets: [
    {
      start: "2026-10-01",
      end: "2026-10-01",
      partial: false,
      messages: 4,
      conversations: 2,
    },
    {
      start: "2026-10-02",
      end: "2026-10-02",
      partial: false,
      messages: 0,
      conversations: 0,
    },
    {
      start: "2026-10-03",
      end: "2026-10-03",
      partial: false,
      messages: 8,
      conversations: 3,
    },
  ],
  ...overrides,
});
const NO_TOTALS = {
  messages: 0,
  conversations: 0,
  feedbackPositive: 0,
  feedbackNegative: 0,
};

test("Leerzustände des Diagramms (AK-10 a/b)", () => {
  assert.equal(chartState(summaryOf(), "messages"), "data");
  assert.equal(chartState(summaryOf(), "conversations"), "data");
  // (a) Zeitraum ohne Nachrichten
  assert.equal(
    chartState(summaryOf({ totals: NO_TOTALS }), "messages"),
    "empty-range"
  );
  assert.equal(
    chartState(summaryOf({ totals: NO_TOTALS }), "conversations"),
    "empty-range"
  );
  // (b) Widget ohne jede Nachricht
  assert.equal(
    chartState(
      summaryOf({ totals: NO_TOTALS, firstLedgerDay: null }),
      "messages"
    ),
    "no-data"
  );
  assert.equal(chartState(null, "messages"), "no-data");
  // Nachrichten ja, aber keine im Zeitraum begonnene Konversation
  const continued = summaryOf({
    totals: { ...summaryOf().totals, conversations: 0 },
  });
  assert.equal(chartState(continued, "messages"), "data");
  assert.equal(chartState(continued, "conversations"), "empty-metric");
});

test("Leerzustand ohne Widget (AK-10 c): nach dem Laden nie „Laden…“", () => {
  assert.equal(viewState({ embedsLoaded: false, embeds: [] }), "loading");
  assert.equal(viewState({ embedsLoaded: true, embeds: [] }), "no-widget");
  assert.equal(viewState({ embedsLoaded: true, embeds: null }), "no-widget");
  assert.equal(viewState({ embedsLoaded: true, embeds: [{ id: 1 }] }), "ready");
});

test("Beginn der Zählung (AK-14): nur wenn der Zeitraum davor beginnt", () => {
  assert.equal(
    countsSinceDay(
      summaryOf({ fromDay: "2026-07-01", firstLedgerDay: "2026-08-03" })
    ),
    "2026-08-03"
  );
  assert.equal(
    t("embed-analytics.chart.counts-since", { date: formatDate("2026-08-03") }),
    "Zählwerte liegen ab 03.08.2026 vor"
  );
  assert.equal(
    countsSinceDay(
      summaryOf({ fromDay: "2026-08-03", firstLedgerDay: "2026-08-03" })
    ),
    null
  );
  assert.equal(
    countsSinceDay(
      summaryOf({ fromDay: "2026-10-01", firstLedgerDay: "2026-08-03" })
    ),
    null
  );
  assert.equal(countsSinceDay(summaryOf({ firstLedgerDay: null })), null);
  assert.equal(countsSinceDay(null), null);
});

test("Hinweis auf gelöschte Inhalte (AK-4): Frist gesetzt und der Abschnitt reicht weiter zurück", () => {
  const today = "2026-10-12";
  // 30 Tage Frist, Zeitraum umfasst den Tag vor 45 Tagen
  assert.equal(
    showsDeletedHint({
      retentionDays: 30,
      startDay: addDays(today, -45),
      today,
    }),
    true
  );
  assert.equal(
    showsDeletedHint({
      retentionDays: 30,
      startDay: addDays(today, -30),
      today,
    }),
    true
  );
  assert.equal(
    showsDeletedHint({
      retentionDays: 30,
      startDay: addDays(today, -29),
      today,
    }),
    false
  );
  assert.equal(
    showsDeletedHint({ retentionDays: 30, startDay: today, today }),
    false
  );
  // ohne Aufbewahrungsfrist nie
  for (const retentionDays of [null, undefined, 0])
    assert.equal(
      showsDeletedHint({ retentionDays, startDay: "2020-01-01", today }),
      false
    );
  assert.equal(
    showsDeletedHint({ retentionDays: 30, startDay: null, today }),
    false
  );
  assert.equal(
    de["embed-analytics"].list["deleted-hint"],
    "Ältere Inhalte wurden gemäß Aufbewahrungsfrist gelöscht."
  );
});

test("Aufbewahrung als eine Zeile (AK-13)", () => {
  assert.equal(
    t("embed-analytics.retention-line", { count: 30 }),
    "Konversationsinhalte werden nach 30 Tagen gelöscht. Die Zählwerte bleiben erhalten."
  );
  assert.equal(
    t("embed-analytics.retention-line", { count: 1 }),
    "Konversationsinhalte werden nach 1 Tag gelöscht. Die Zählwerte bleiben erhalten."
  );
});

// ---------------------------------------------------------------------------
// Kennzahlen
// ---------------------------------------------------------------------------

test("Kennzahlen-Streifen (AK-8): Summen aus totals, Ø je Säuleneinheit, Ø je Konversation, Anteil positiv", () => {
  const kpi = kpiValues(summaryOf());
  assert.deepEqual(kpi, {
    messages: 12,
    conversations: 5,
    positive: 3,
    negative: 1,
    averagePerBucket: 4, // 12 Nachrichten in 3 Tagen
    averagePerConversation: 2.4,
    positiveShare: 75, // 3 von 4 bewerteten
  });
  assert.equal(
    t("embed-analytics.kpi.avg-per.day", {
      value: formatNumber(kpi.averagePerBucket, 1),
    }),
    "Ø 4,0 pro Tag"
  );
  assert.equal(
    t("embed-analytics.kpi.avg-per-conversation", {
      value: formatNumber(kpi.averagePerConversation, 1),
    }),
    "Ø 2,4 Nachrichten je Konversation"
  );
  assert.equal(
    t("embed-analytics.kpi.positive-share", { value: kpi.positiveShare }),
    "75 % der bewerteten Antworten"
  );
  assert.equal(
    de["embed-analytics"].kpi["show-negative"],
    "Betroffene Konversationen anzeigen"
  );
});

test("Kennzahlen: Die Summe der Säulen ist die Kennzahl (AK-2)", () => {
  const summary = summaryOf();
  const kpi = kpiValues(summary);
  const sum = (key) =>
    summary.buckets.reduce((total, bucket) => total + bucket[key], 0);
  assert.equal(sum("messages"), kpi.messages);
  assert.equal(sum("conversations"), kpi.conversations);
});

test("Kennzahlen ohne Werte: keine Division durch 0", () => {
  assert.deepEqual(kpiValues(summaryOf({ totals: NO_TOTALS })), {
    messages: 0,
    conversations: 0,
    positive: 0,
    negative: 0,
    averagePerBucket: 0,
    averagePerConversation: null,
    positiveShare: null,
  });
  assert.deepEqual(kpiValues(null), {
    messages: 0,
    conversations: 0,
    positive: 0,
    negative: 0,
    averagePerBucket: null,
    averagePerConversation: null,
    positiveShare: null,
  });
  // Ø je Säuleneinheit bei Stunden: geteilt durch 24
  const hours = summaryOf({
    granularity: "hour",
    buckets: Array.from({ length: 24 }, (_, hour) => ({
      start: "2026-10-06",
      end: "2026-10-06",
      partial: false,
      hour,
      messages: hour === 9 ? 12 : 0,
      conversations: 0,
    })),
  });
  assert.equal(kpiValues(hours).averagePerBucket, 0.5);
  assert.equal(
    t("embed-analytics.kpi.avg-per.hour", { value: formatNumber(0.5, 1) }),
    "Ø 0,5 pro Stunde"
  );
});

// ---------------------------------------------------------------------------
// Geometrie
// ---------------------------------------------------------------------------

test("Wertachse: ganze, runde Schritte von 0 bis über den größten Wert", () => {
  assert.deepEqual(valueScale(37), { max: 40, ticks: [0, 10, 20, 30, 40] });
  assert.deepEqual(valueScale(3), { max: 3, ticks: [0, 1, 2, 3] });
  assert.deepEqual(valueScale(1), { max: 1, ticks: [0, 1] });
  assert.deepEqual(valueScale(0), { max: 1, ticks: [0, 1] });
  assert.deepEqual(valueScale(1234), {
    max: 1500,
    ticks: [0, 500, 1000, 1500],
  });
  for (const value of [1, 2, 5, 9, 11, 49, 51, 99, 101, 999, 12345, 987654]) {
    const { max, ticks } = valueScale(value);
    assert.ok(max >= value, `${value}: Achse endet bei ${max}`);
    assert.equal(ticks[0], 0);
    assert.equal(ticks.at(-1), max);
    assert.ok(ticks.every(Number.isInteger), `${value}: ${ticks}`);
    assert.ok(ticks.length >= 2 && ticks.length <= 6, `${value}: ${ticks}`);
  }
});

test("Säulenplätze (AK-1): 30 Tage, 10 ohne Wert – 30 Plätze, 20 Säulen", () => {
  const values = Array.from({ length: 30 }, (_, i) =>
    i % 3 === 2 ? 0 : i + 1
  );
  const columns = columnLayout({ values, width: 900, height: 200, max: 40 });

  assert.equal(columns.length, 30);
  assert.equal(columns.filter((column) => column.bar).length, 20);
  for (const [i, column] of columns.entries()) {
    assert.equal(column.width, 30);
    assert.equal(column.x, i * 30);
    assert.equal(!!column.bar, values[i] > 0);
    if (!column.bar) continue;
    // dünn, mittig, an der Grundlinie verankert, in der Zeichenfläche
    assert.ok(column.bar.width <= BAR_MAX_WIDTH);
    assert.ok(column.bar.width < column.width);
    assert.equal(column.bar.x + column.bar.width / 2, column.center);
    assert.equal(column.bar.y + column.bar.height, 200);
    assert.ok(column.bar.y >= 0);
  }
  // Höhe proportional zum Wert
  assert.equal(columns[19].bar.height, (20 / 40) * 200);
});

test("Säulen: nie breiter als 24 px, auch bei wenigen Plätzen; kleinste Werte bleiben sichtbar", () => {
  const few = columnLayout({ values: [5, 0], width: 900, height: 200, max: 5 });
  assert.equal(few[0].bar.width, BAR_MAX_WIDTH);
  assert.equal(few[1].bar, null);

  const many = columnLayout({
    values: Array.from({ length: 92 }, () => 1),
    width: 280,
    height: 200,
    max: 1000,
  });
  assert.equal(many.length, 92);
  for (const column of many) {
    assert.ok(column.bar.width >= 1 && column.bar.width < column.width);
    assert.ok(column.bar.height >= 2);
  }
  assert.deepEqual(
    columnLayout({ values: [], width: 900, height: 200, max: 1 }),
    []
  );
});

test("Säulenform: oben abgerundet, an der Grundlinie eckig", () => {
  const path = barPath({ x: 10, y: 50, width: 20, height: 150 });
  assert.equal(path, "M10,200 V54 Q10,50 14,50 H26 Q30,50 30,54 V200 Z");
  // Eine sehr niedrige Säule rundet nicht über ihre Höhe hinaus.
  assert.equal(
    barPath({ x: 0, y: 198, width: 20, height: 2 }),
    "M0,200 V200 Q0,198 2,198 H18 Q20,198 20,200 V200 Z"
  );
  // Eine sehr schmale Säule rundet höchstens bis zur Mitte.
  assert.equal(
    barPath({ x: 0, y: 100, width: 2, height: 100 }),
    "M0,200 V101 Q0,100 1,100 H1 Q2,100 2,101 V200 Z"
  );
});

test("Zeitachse: nur so viele Beschriftungen, wie nebeneinander passen", () => {
  assert.equal(tickStep(30, 900, 48), 2);
  assert.equal(tickStep(7, 900, 48), 1);
  assert.equal(tickStep(24, 272, 52), 6);
  for (const [count, width, label] of [
    [30, 272, 48],
    [92, 272, 48],
    [92, 1000, 48],
    [53, 600, 52],
    [92, 300, 68],
    [24, 900, 52],
  ]) {
    const step = tickStep(count, width, label);
    assert.ok(Number.isInteger(step) && step >= 1);
    assert.ok(
      Math.ceil(count / step) * label <= width + label,
      `${count} Plätze auf ${width} px: Schritt ${step}`
    );
  }
  assert.equal(tickStep(0, 900, 48), 1);
  assert.equal(tickStep(30, 0, 48), 1);
});

test("Zeitachse: Lange Beschriftungen (Monat und Jahr in manchen Sprachen) bekommen mehr Platz, kurze den üblichen", () => {
  assert.equal(tickLabelWidth(["Aug. 2026", "Sept. 2026"], 68), 68);
  assert.equal(tickLabelWidth(["2026年9月", "2026年10月"], 68), 68);
  assert.equal(tickLabelWidth(["06.10.", "07.10."], 48), 48);
  assert.equal(tickLabelWidth([], 52), 52);
  // lettisch und russisch: "2026. g. sept.", "сент. 2026 г."
  for (const locale of ["lv", "ru", "pt"]) {
    const ticks = ["2026-08-01", "2026-09-01"].map((start) =>
      bucketTick({ start, end: start }, "month", { t, locale })
    );
    const longest = Math.max(...ticks.map((tick) => tick.length));
    assert.ok(longest > 10, `${locale}: ${ticks}`);
    assert.ok(tickLabelWidth(ticks, 68) >= longest * 6, locale);
    assert.ok(tickLabelWidth(ticks, 68) > 68, locale);
  }
});
