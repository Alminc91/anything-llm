// Konversationen-Ansicht: Hilfsfunktionen der kompakten Liste und des
// Seitenpanels (frontend/src/utils/conversationView.js) – Tagesgruppen nach
// der letzten Nachricht in Berliner Zeit, „begonnen am …", Suchbegriff und
// Hervorhebung ohne HTML aus Nutzertext.
//
// Die Zeitzone des Prozesses wird nicht gesetzt: `yarn test:tz` lässt die
// Datei in UTC, Europe/Berlin und America/New_York laufen (AK-2).
import test from "node:test";
import assert from "node:assert/strict";
import de from "../src/locales/de/common.js";
import en from "../src/locales/en/common.js";
import {
  AVATAR_CLEARANCE,
  BUBBLE,
  BUBBLE_MAX_WIDTH,
  HOLD_SCROLL_BUSY_MAX_MS,
  HOLD_SCROLL_MAX_MS,
  HOLD_SCROLL_QUIET_MS,
  PANEL_PREFERENCE_KEY,
  RATING_BOX,
  RATING_FLASH,
  RATING_TINT,
  ROW_SCROLL_MARGIN,
  WORKSPACE,
  WORKSPACE_MIN_HEIGHT,
  WORKSPACE_PANEL_MIN_WIDTH,
  WORKSPACE_TOP_GAP,
  focusVisible,
  hasFocus,
  nearestScrollTop,
  ratingJumpIds,
  ratingOf,
  readPanelPreference,
  SEARCH_MAX_LENGTH,
  ancestorsOf,
  answerText,
  arrowNavigationAllowed,
  berlinDateTime,
  berlinTime,
  centeredScrollTop,
  conversationKey,
  conversationSummary,
  dayGroupLabel,
  effectiveSearch,
  firstElementWith,
  groupByLastMessageDay,
  hasContentGap,
  focusLost,
  hasVisibleHit,
  highlightParts,
  highlightTextNodes,
  holdScrollTarget,
  isNewConversation,
  isWide,
  longDateLabel,
  NEW_CONVERSATION_MS,
  nextNewExpiry,
  RATING_COLUMN,
  outsidePeriod,
  searchLinkIssue,
  searchPattern,
  searchVariants,
  shortDayLabel,
  shortId,
  startScrollTop,
  startedOnOtherDay,
  visibleAnswerText,
  writePanelPreference,
} from "../src/utils/conversationView.js";
// Neu seit 7.22-rc13 (E13, E15, K01, K04): über den Namensraum, damit ein
// fehlender Export nur die Tests trifft, die ihn brauchen
import * as rc13 from "../src/utils/conversationView.js";
import { formatDateForInput as berlinDay } from "../src/utils/billingDate.js";
import { formatDateTimeDE } from "../src/utils/dateTimeDE.js";
import serverSearch from "../../server/utils/helpers/chat/conversationSearch.js";
import { createDocument, elements } from "./helpers/testDom.mjs";
import { readFileSync } from "node:fs";

/** Minimales t() über eine Sprachdatei: Interpolation und _one/_other. */
function translator(resources) {
  return (key, values = {}) => {
    const lookup = (path) =>
      path.split(".").reduce((node, part) => node?.[part], resources);
    let text = lookup(key);
    if (text === undefined && typeof values.count === "number")
      text = lookup(`${key}_${values.count === 1 ? "one" : "other"}`);
    if (typeof text !== "string") throw new Error(`Kein Text: ${key}`);
    return text.replace(/\{\{(\w+)\}\}/g, (_, name) => String(values[name]));
  };
}
const tDe = translator(de);
const tEn = translator(en);

/** Zeitpunkt zu einer Berliner Wanduhrzeit (Oktober 2026: UTC+2). */
const berlin = (day, time) => Date.parse(`${day}T${time}:00+02:00`);

// ---------------------------------------------------------------------------
// AK-2: Tagesgruppen nach der letzten Nachricht, Berliner Zeit
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Nachtrag KIE-560, K2/K3: „Neu“ nach der letzten Nachricht, Spalte der Marken
// ---------------------------------------------------------------------------

test("K3: „Neu“ gilt, solange die letzte Nachricht jünger als 4 Stunden ist – genau 4 Stunden: nicht mehr; reine Dauer über Tages- und Zeitzonengrenzen", () => {
  assert.equal(NEW_CONVERSATION_MS, 4 * 60 * 60 * 1000);
  const now = Date.parse("2026-10-13T10:00:00Z");
  const at = (offsetMs) => ({ last_message_at: now - offsetMs });
  assert.equal(isNewConversation(at(0), now), true);
  assert.equal(isNewConversation(at(NEW_CONVERSATION_MS - 1), now), true);
  assert.equal(isNewConversation(at(NEW_CONVERSATION_MS), now), false);
  assert.equal(isNewConversation(at(NEW_CONVERSATION_MS + 1), now), false);
  // Uhr des Besuchers vorgestellt: Zeitpunkt in der Zukunft gilt als neu
  assert.equal(isNewConversation(at(-60_000), now), true);
  // über Mitternacht in Berlin hinweg (23:30 → 01:00): Dauer 1,5 h
  const afterMidnight = berlin("2026-10-14", "01:00");
  assert.equal(
    isNewConversation(
      { last_message_at: berlin("2026-10-13", "23:30") },
      afterMidnight
    ),
    true
  );
  // nach dem Beginn zählt nichts: früh begonnen, gerade weitergeführt
  assert.equal(
    isNewConversation(
      { started_at: now - 5 * 86_400_000, last_message_at: now - 60_000 },
      now
    ),
    true
  );
  // ohne gültigen Zeitpunkt nie neu
  for (const last of [undefined, null, NaN, "2026-10-13", Infinity])
    assert.equal(isNewConversation({ last_message_at: last }, now), false);
  assert.equal(isNewConversation(null, now), false);
});

test("Review 7.22-rc2, K01: nextNewExpiry nennt, wann das erste „Neu“ der Liste abläuft; ohne neue Konversation null", () => {
  const now = Date.parse("2026-10-13T10:00:00Z");
  const HOUR = 3_600_000;
  const rows = [
    { last_message_at: now - 1 * HOUR },
    { last_message_at: now - 3 * HOUR }, // läuft zuerst ab
    { last_message_at: now - 5 * HOUR }, // schon alt
    { last_message_at: null },
  ];
  assert.equal(nextNewExpiry(rows, now), now + 1 * HOUR);
  assert.equal(nextNewExpiry([rows[2], rows[3]], now), null);
  assert.equal(nextNewExpiry([], now), null);
  assert.equal(nextNewExpiry(undefined, now), null);
});

test("Review 7.22-rc6, K03: nextNewExpiry liegt höchstens 4 Stunden nach jetzt, auch bei Zeitpunkten in der Zukunft (Uhr geht nach)", () => {
  const now = Date.parse("2026-10-13T10:00:00Z");
  const DAY = 86_400_000;
  // 30 Tage in der Zukunft: ohne Deckel über dem Höchstwert von setTimeout
  // (2^31-1 ms), der Zeitgeber feuerte sofort und immer wieder
  const future = [{ last_message_at: now + 30 * DAY }];
  assert.equal(isNewConversation(future[0], now), true);
  const next = nextNewExpiry(future, now);
  assert.equal(next, now + NEW_CONVERSATION_MS);
  assert.ok(next - now + 200 <= 2 ** 31 - 1);
  // eine echte frühere Ablaufzeit gewinnt weiter
  const mixed = [...future, { last_message_at: now - 3_600_000 }];
  assert.equal(nextNewExpiry(mixed, now), now + 3 * 3_600_000);
  // knapp in der Zukunft: ebenfalls gedeckelt, nie später als 4 Stunden
  assert.equal(
    nextNewExpiry([{ last_message_at: now + 60_000 }], now),
    now + NEW_CONVERSATION_MS
  );
});

test("K2: Spalte der Bewertungsmarken mit fester Mindestbreite – unter sm 72 px, ab sm 106 px (zwei Marken mit zweistelliger Zahl)", () => {
  assert.equal(RATING_COLUMN, "min-w-[72px] sm:min-w-[106px]");
});

test("AK-2: K1 (Beginn 09.10., letzte Nachricht 13.10.) steht unter „Heute · Dienstag, 13. Oktober“ über K2 (12.10.) – mit „begonnen am 9. Okt.“", () => {
  const today = "2026-10-13";
  // Reihenfolge des Servers: letzte Nachricht absteigend
  const k1 = {
    conversation_id: "k1",
    session_id: "s1",
    started_at: berlin("2026-10-09", "10:00"),
    last_message_at: berlin("2026-10-13", "07:47"),
  };
  const k2 = {
    conversation_id: "k2",
    session_id: "s2",
    started_at: berlin("2026-10-12", "12:03"),
    last_message_at: berlin("2026-10-12", "12:10"),
  };
  const groups = groupByLastMessageDay([k1, k2]);
  assert.deepEqual(
    groups.map((group) => [group.day, group.conversations]),
    [
      ["2026-10-13", [k1]],
      ["2026-10-12", [k2]],
    ]
  );
  const context = { t: tDe, locale: "de" };
  assert.equal(
    dayGroupLabel("2026-10-13", today, context),
    "Heute · Dienstag, 13. Oktober"
  );
  assert.equal(
    dayGroupLabel("2026-10-12", today, context),
    "Gestern · Montag, 12. Oktober"
  );
  assert.equal(
    dayGroupLabel("2026-10-11", today, context),
    "Sonntag, 11. Oktober"
  );
  // anderes Jahr: mit Jahreszahl
  assert.equal(
    dayGroupLabel("2025-12-31", today, context),
    "Mittwoch, 31. Dezember 2025"
  );
  // Englische Oberfläche: nur „Today" übersetzt, das Datum bleibt deutsch
  // (CLAUDE.md „Deutsche Datumsformate überall", Fixliste Punkt 22).
  assert.equal(
    dayGroupLabel("2026-10-13", today, { t: tEn, locale: "en" }),
    "Today · Dienstag, 13. Oktober"
  );
  assert.equal(
    dayGroupLabel("2026-10-12", today, { t: tEn, locale: "en" }),
    "Yesterday · Montag, 12. Oktober"
  );

  assert.equal(startedOnOtherDay(k1), "2026-10-09");
  assert.equal(startedOnOtherDay(k2), null);
  assert.equal(
    tDe("embed-analytics.rows.started", {
      date: shortDayLabel(startedOnOtherDay(k1), today),
    }),
    "begonnen am 9. Okt."
  );
  assert.equal(
    tEn("embed-analytics.rows.started", {
      date: shortDayLabel(startedOnOtherDay(k1), today),
    }),
    "started on 9. Okt."
  );
  assert.equal(shortDayLabel("2025-10-09", today), "9. Okt. 2025");
  assert.equal(berlinTime(k1.last_message_at), "07:47");
});

test("AK-2: Die Tagesgrenze ist Mitternacht in Berlin – unabhängig von der Zeitzone des Browsers, auch an der Zeitumstellung", () => {
  // 12.10. 23:59 Berlin = 21:59 UTC; 13.10. 00:30 Berlin = 22:30 UTC am 12.10.
  assert.equal(berlinDay(Date.parse("2026-10-12T21:59:00Z")), "2026-10-12");
  assert.equal(berlinDay(Date.parse("2026-10-12T22:30:00Z")), "2026-10-13");
  assert.equal(berlinTime(Date.parse("2026-10-12T22:30:00Z")), "00:30");
  // 25.10.2026: Rückstellung auf Winterzeit (UTC+1)
  assert.equal(berlinDay(Date.parse("2026-10-25T22:59:00Z")), "2026-10-25");
  assert.equal(berlinDay(Date.parse("2026-10-25T23:00:00Z")), "2026-10-26");
  assert.equal(berlinTime(Date.parse("2026-10-25T23:00:00Z")), "00:00");
  // Gruppen folgen der Reihenfolge der Liste; derselbe Tag bleibt eine Gruppe.
  const at = (iso) => ({ last_message_at: Date.parse(iso) });
  const groups = groupByLastMessageDay([
    at("2026-10-12T22:30:00Z"),
    at("2026-10-12T22:05:00Z"),
    at("2026-10-12T21:59:00Z"),
  ]);
  assert.deepEqual(
    groups.map((group) => [group.day, group.conversations.length]),
    [
      ["2026-10-13", 2],
      ["2026-10-12", 1],
    ]
  );
  // Beginn kurz vor, letzte Nachricht kurz nach Mitternacht: „begonnen am"
  assert.equal(
    startedOnOtherDay({
      started_at: Date.parse("2026-10-12T21:50:00Z"),
      last_message_at: Date.parse("2026-10-12T22:10:00Z"),
    }),
    "2026-10-12"
  );
});

test("Datum im Kopf des Panels: deutsch, auch bei englischer Oberfläche", () => {
  assert.equal(longDateLabel("2026-10-13"), "Dienstag, 13.10.2026");
  assert.equal(longDateLabel("2026-10-09"), "Freitag, 09.10.2026");
});

test("Ungültiger Zeitpunkt (NaN): nichts wirft – leerer Tag, „–“ als Gruppe, keine Uhrzeit (Fixliste Punkt 22)", () => {
  assert.equal(berlinDay(NaN), "");
  assert.equal(berlinTime(NaN), "");
  const groups = groupByLastMessageDay([
    { last_message_at: NaN },
    { last_message_at: Date.parse("2026-10-12T10:00:00Z") },
  ]);
  assert.deepEqual(
    groups.map((group) => group.day),
    ["", "2026-10-12"]
  );
  assert.equal(dayGroupLabel("", "2026-10-13", { t: tDe }), "–");
  assert.equal(shortDayLabel("", "2026-10-13"), "–");
  assert.equal(longDateLabel(""), "");
  assert.equal(
    startedOnOtherDay({ started_at: NaN, last_message_at: Date.now() }),
    null
  );
});

// ---------------------------------------------------------------------------
// Suche: Begriff und Hervorhebung (AK-10, AK-11, AK-13, NAK-5)
// ---------------------------------------------------------------------------

test("Suchbegriff: getrimmt, ab 2 Zeichen, zerlegte Umlaute zusammengesetzt", () => {
  assert.equal(effectiveSearch(" spanisch "), "spanisch");
  assert.equal(effectiveSearch("s"), "");
  assert.equal(effectiveSearch("  a  "), "");
  assert.equal(effectiveSearch(null), "");
  assert.equal(effectiveSearch("u\u0308b"), "üb");
});

test("Suchbegriff aus einem Link: auf 200 Zeichen gekürzt, ungültiger verworfen – nie eine 400 des Servers (Fixliste Punkt 18)", () => {
  // dieselbe Grenze wie der Server
  assert.equal(SEARCH_MAX_LENGTH, serverSearch.SEARCH_MAX_LENGTH);
  const long = "ä".repeat(150) + "b".repeat(100);
  assert.equal([...effectiveSearch(long)].length, SEARCH_MAX_LENGTH);
  assert.equal(searchLinkIssue(long), "too-long");
  assert.equal(serverSearch.parseSearch(effectiveSearch(long)).error, null);
  // Emoji zählen als ein Zeichen (Codepoints)
  assert.equal(effectiveSearch("😀".repeat(250)), "😀".repeat(200));
  for (const raw of ["ab\u0000cd", "\ud800ab", "a\tb", "x\u007fy"]) {
    assert.equal(effectiveSearch(raw), "", raw);
    assert.equal(searchLinkIssue(raw), "invalid", raw);
  }
  assert.equal(searchLinkIssue("spanisch"), null);
  assert.equal(searchLinkIssue(""), null);
  assert.equal(searchLinkIssue(null), null);
});

test("Hervorhebung: Groß/klein egal, auch bei Umlauten; Sonderzeichen wörtlich", () => {
  const hits = (text, term) =>
    highlightParts(text, term)
      .filter((part) => part.hit)
      .map((part) => part.text);
  assert.deepEqual(hits("Die Übung und die ÜBUNG", "übung"), [
    "Übung",
    "ÜBUNG",
  ]);
  assert.deepEqual(hits("Welche GRÖßE?", "größe"), ["GRÖßE"]);
  assert.deepEqual(hits("Spanischkurs und spanisch", "SPANISCH"), [
    "Spanisch",
    "spanisch",
  ]);
  assert.deepEqual(hits("(a+b)* und ab", "(a+b)*"), ["(a+b)*"]);
  assert.deepEqual(hits("100 % und 100", "0 %"), ["0 %"]);
  assert.deepEqual(hits("Pfad C:\\Kurse", "c:\\k"), ["C:\\K"]);
  // Teile ergeben zusammen wieder den Text
  const parts = highlightParts("Übung macht den Meister – übung!", "übung");
  assert.equal(
    parts.map((part) => part.text).join(""),
    "Übung macht den Meister – übung!"
  );
  // ohne Begriff: ein Teil ohne Treffer
  assert.deepEqual(highlightParts("Text", ""), [{ text: "Text", hit: false }]);
});

test("NAK-5: Hervorhebung im DOM teilt nur Textknoten – aus Nutzertext entsteht kein Element", () => {
  const document = createDocument();
  const root = document.createElement("div");
  const paragraph = root.appendChild(document.createElement("p"));
  paragraph.appendChild(
    document.createTextNode("Frage: <img src=x onerror=alert(1)> und Spanisch")
  );
  const strong = paragraph.appendChild(document.createElement("strong"));
  strong.appendChild(document.createTextNode("SPANISCH"));
  const before = root.textContent;

  assert.equal(highlightTextNodes(root, "spanisch", document), 2);
  assert.equal(highlightTextNodes(root, "<img src=x", document), 1);

  const tags = elements(root).map((element) => element.tagName);
  assert.deepEqual(tags.filter((tag) => tag !== "MARK").sort(), [
    "P",
    "STRONG",
  ]);
  assert.equal(elements(root, (e) => e.tagName === "IMG").length, 0);
  const marks = elements(root, (e) => e.tagName === "MARK");
  assert.deepEqual(
    marks.map((mark) => [
      mark.getAttribute("data-search-hit"),
      mark.textContent,
      mark.childNodes.every((child) => child.nodeType === 3),
    ]),
    [
      ["", "<img src=x", true],
      ["", "Spanisch", true],
      ["", "SPANISCH", true],
    ]
  );
  // Der Text ist unverändert.
  assert.equal(root.textContent, before);
  // Markierungen werden nicht erneut markiert.
  assert.equal(highlightTextNodes(root, "spanisch", document), 0);
});

// ---------------------------------------------------------------------------
// Panel: Kopf aus den Nachrichten, Zeitraum, Antworttext
// ---------------------------------------------------------------------------

test("Kopf des Panels aus den Nachrichten; Alt-Chats ohne conversation_id heißen nach der Sitzung (NAK-8)", () => {
  const messages = [
    {
      prompt: "Gibt es Sportkurse?",
      createdAt: "2026-10-11T15:54:00.000Z",
      feedbackScore: true,
      conversation_id: null,
      session_id: "sitzung-1",
    },
    {
      prompt: "Und am Abend?",
      createdAt: "2026-10-11T15:55:00.000Z",
      feedbackScore: false,
      conversation_id: null,
      session_id: "sitzung-1",
    },
    {
      prompt: "Danke",
      createdAt: "2026-10-11T15:56:00.000Z",
      feedbackScore: null,
      conversation_id: null,
      session_id: "sitzung-1",
    },
  ];
  assert.deepEqual(conversationSummary(messages), {
    key: conversationKey({
      conversation_id: "sitzung-1",
      session_id: "sitzung-1",
    }),
    conversationId: "sitzung-1",
    firstQuestion: "Gibt es Sportkurse?",
    startedAt: Date.parse("2026-10-11T15:54:00.000Z"),
    lastAt: Date.parse("2026-10-11T15:56:00.000Z"),
    questions: 3,
    positive: 1,
    negative: 1,
  });
  assert.equal(conversationSummary([]), null);
});

test("Außerhalb des Zeitraums: keine Nachricht in den Berliner Kalendertagen (Grenzen eingeschlossen, Fixliste 7 F06); „Gesamt“ nie", () => {
  const messages = [{ createdAt: "2026-08-01T10:00:00.000Z" }];
  const september = { fromDay: "2026-09-01", toDay: "2026-09-30" };
  assert.equal(outsidePeriod(messages, september), true);
  // 30.09., 23:59:59,999 Uhr Berliner Zeit: noch drin
  assert.equal(
    outsidePeriod(
      [...messages, { createdAt: "2026-09-30T21:59:59.999Z" }],
      september
    ),
    false
  );
  // 01.10., 00:15 Uhr Berliner Zeit (UTC noch der 30.09.): nicht mehr
  assert.equal(
    outsidePeriod([{ createdAt: "2026-09-30T22:15:00.000Z" }], september),
    true
  );
  // 01.09., 00:30 Uhr Berliner Zeit (UTC noch der 31.08.): drin
  assert.equal(
    outsidePeriod([{ createdAt: "2026-08-31T22:30:00.000Z" }], september),
    false
  );
  assert.equal(outsidePeriod(messages, {}), false);
  assert.equal(outsidePeriod(messages, { fromDay: null, toDay: null }), false);
  assert.equal(outsidePeriod([], september), false);
});

test("Antworttext: bei JSON das Feld text (nicht Quellen), sonst wörtlich; Kennung gekürzt", () => {
  assert.equal(
    answerText(JSON.stringify({ text: "Hallo", sources: [{ text: "Q" }] })),
    "Hallo"
  );
  assert.equal(answerText(JSON.stringify({ sources: [{ text: "Q" }] })), "");
  assert.equal(answerText("Alte Antwort"), "Alte Antwort");
  assert.equal(answerText("42"), "42");
  assert.equal(answerText(null), "");
  assert.equal(shortId("3f311a2b-e8cd-4b30-9627-2758deb20006"), "3f311a2b…");
  assert.equal(shortId("kurz"), "kurz");
});

// ---------------------------------------------------------------------------
// Fixliste nach den Reviews (13.10.2026)
// ---------------------------------------------------------------------------

test("NFD: Ein zerlegtes „ü“ im Text wird hervorgehoben wie ein zusammengesetztes – auch mit zerlegtem Begriff (Fixliste Punkt 24)", () => {
  const nfd = (text) => text.normalize("NFD");
  const hits = (text, term) =>
    highlightParts(text, term)
      .filter((part) => part.hit)
      .map((part) => part.text);
  assert.deepEqual(hits(nfd("Die Übung und die ÜBUNG"), "übung"), [
    nfd("Übung"),
    nfd("ÜBUNG"),
  ]);
  assert.deepEqual(hits("Die Übung", nfd("übung")), ["Übung"]);
  assert.deepEqual(hits(`${nfd("Größe")} und Größe`, "GRÖßE"), [
    nfd("Größe"),
    "Größe",
  ]);
  // Das Muster wird einmal gebaut und für viele Texte benutzt (g-Flag).
  const pattern = searchPattern("kurs");
  assert.equal(highlightParts("Kurs A", pattern).length, 2);
  assert.equal(highlightParts("Kurs B", pattern).length, 2);
});

test("Sichtbarer Treffer: Link-Adressen, HTML und <think> zählen nicht; Frage, Grund, Kommentar und Linktext schon (Fixliste Punkt 11)", () => {
  const answer = (text) => JSON.stringify({ text, sources: [{ text: "Q" }] });
  const message = (extra) => ({
    prompt: "Wo melde ich mich an?",
    response: answer(
      'Hier: [Anmeldung](https://vhs-lingen.example/anmeldung) <span data-x="geheimattribut">ok</span><think>Gedanke zu Yoga</think>'
    ),
    feedbackReason: null,
    feedbackText: null,
    ...extra,
  });
  assert.equal(
    visibleAnswerText(
      '[Kurs](https://a.example/b) <b class="x">fett</b><think>still</think>'
    ),
    "[Kurs]  fett  "
  );
  assert.equal(hasVisibleHit([message()], "vhs-lingen"), false);
  assert.equal(hasVisibleHit([message()], "geheimattribut"), false);
  assert.equal(hasVisibleHit([message()], "yoga"), false);
  assert.equal(hasVisibleHit([message()], "anmeldung"), true);
  assert.equal(hasVisibleHit([message()], "melde ich"), true);
  assert.equal(
    hasVisibleHit(
      [message({ feedbackScore: false, feedbackText: "vhs-lingen ist toll" })],
      "vhs-lingen"
    ),
    true
  );
  // Grund und Kommentar zeigt das Panel nur bei negativer Bewertung
  assert.equal(
    hasVisibleHit(
      [message({ feedbackScore: null, feedbackText: "vhs-lingen ist toll" })],
      "vhs-lingen"
    ),
    false
  );
  // ohne Suche: kein Hinweis
  assert.equal(hasVisibleHit([message()], ""), true);
});

test("Sichtbarer Treffer: Autolinks <https://…> und <info@…> zeigt die Antwort als Text – sie zählen (Fixliste 2, S2)", () => {
  const answer = (text) => JSON.stringify({ text, sources: [] });
  assert.equal(
    visibleAnswerText(
      "Siehe <https://kurs.example/a1> oder <info@vhs.example>."
    ),
    "Siehe  https://kurs.example/a1  oder  info@vhs.example ."
  );
  for (const term of ["kurs.example", "info@vhs", "https://kurs"])
    assert.equal(
      hasVisibleHit(
        [
          {
            prompt: "Frage",
            response: answer(
              "Siehe <https://kurs.example/a1> oder <info@vhs.example>."
            ),
          },
        ],
        term
      ),
      true,
      term
    );
  // echte Tags und ihre Attribute weiter nicht
  assert.equal(
    visibleAnswerText('<a href="https://kurs.example">Link</a>'),
    " Link "
  );
});

test("Sichtbarer Treffer: nur in den Nachrichten, die der Server durchsucht hat – im Zeitraum, mit Abschnitt die ganze Konversation (Fixliste 2, S7)", () => {
  const messages = [
    {
      prompt: "Spanisch im Juli",
      response: "{}",
      createdAt: "2026-07-01T10:00:00.000Z",
    },
    {
      prompt: "Nur im Link",
      response: JSON.stringify({ text: "[hier](https://spanisch.example)" }),
      createdAt: "2026-10-05T10:00:00.000Z",
    },
  ];
  const october = { fromDay: "2026-10-01", toDay: "2026-10-31" };
  // Im Oktober trifft „spanisch" nur die Link-Adresse – die sichtbare Frage
  // aus dem Juli hat der Server nicht durchsucht: Hinweis.
  assert.equal(hasVisibleHit(messages, "spanisch", october), false);
  // ganze Konversation (Abschnitt) oder ohne Zeitraum: sichtbar
  assert.equal(hasVisibleHit(messages, "spanisch", {}), true);
  assert.equal(hasVisibleHit(messages, "spanisch"), true);
  assert.equal(
    hasVisibleHit(messages, "spanisch", { fromDay: null, toDay: null }),
    true
  );
});

test("Sprung zum Treffer: Nur der Verlauf scrollt – die Position steht mittig, nie negativ (Fixliste Punkt 13)", () => {
  const container = {
    scrollTop: 100,
    clientHeight: 400,
    getBoundingClientRect: () => ({ top: 50, height: 400 }),
  };
  const element = { getBoundingClientRect: () => ({ top: 650, height: 20 }) };
  // 650 - 50 + 100 = 700 vom Anfang; mittig: 700 - (400 - 20) / 2
  assert.equal(centeredScrollTop(container, element), 510);
  const near = { getBoundingClientRect: () => ({ top: 60, height: 20 }) };
  assert.equal(centeredScrollTop({ ...container, scrollTop: 0 }, near), 0);

  const document = createDocument();
  const root = document.createElement("div");
  const inner = root.appendChild(document.createElement("p"));
  const mark = inner.appendChild(document.createElement("mark"));
  mark.setAttribute("data-search-hit", "");
  assert.equal(firstElementWith(root, "data-search-hit"), mark);
  assert.equal(firstElementWith(root, "data-nichts"), null);
  assert.equal(firstElementWith(null, "data-search-hit"), null);
});

test("Fixliste 3, S4: isWide – eine Stelle für die Breitenprüfung, auch ohne matchMedia", () => {
  const original = globalThis.window;
  try {
    globalThis.window = undefined;
    assert.equal(isWide(), false);
    globalThis.window = {};
    assert.equal(isWide(), false);
    globalThis.window = {
      matchMedia: (query) => ({ matches: query === "(min-width: 1280px)" }),
    };
    assert.equal(isWide(), true);
    globalThis.window = { matchMedia: () => ({ matches: false }) };
    assert.equal(isWide(), false);
  } finally {
    globalThis.window = original;
  }
});

test("Fixliste 4, S2: berlinDateTime – voller Zeitpunkt in Berliner Zeit im Format von formatDateTimeDE, unabhängig von der Zeitzone des Prozesses", () => {
  // Sommerzeit (UTC+2) und Winterzeit (UTC+1), Tageswechsel in Berlin
  assert.equal(
    berlinDateTime(Date.parse("2026-10-13T05:48:00Z")),
    "13.10.2026, 07:48:00 Uhr"
  );
  assert.equal(
    berlinDateTime("2026-12-31T23:30:05.000Z"),
    "01.01.2027, 00:30:05 Uhr"
  );
  assert.equal(
    berlinDateTime(new Date("2026-03-01T12:00:00Z")),
    "01.03.2026, 13:00:00 Uhr"
  );
  // ohne gültigen Zeitpunkt wie formatDateTimeDE: "-"
  for (const value of [null, undefined, "", "kein Datum", NaN])
    assert.equal(berlinDateTime(value), "-", String(value));
});

test("Fixliste 4, V7: holdScrollTarget – springt, hält das Ziel bei jeder Größenänderung eines Vorfahren und bei fremdem Scrollen, bis zur ersten Eingabe", () => {
  const doc = createDocument();
  const outer = doc.body.appendChild(doc.createElement("div"));
  const middle = outer.appendChild(doc.createElement("div"));
  const target = middle.appendChild(doc.createElement("div"));
  assert.deepEqual(ancestorsOf(target), [middle, outer]);
  assert.deepEqual(ancestorsOf(null), []);

  // Lage des Ziels im Fenster: Der Sprung bringt es auf 96
  let top = 640;
  target.getBoundingClientRect = () => ({ top });
  let jumps = 0;
  const jump = () => {
    jumps += 1;
    top = 96;
  };
  // Ereignisse am Dokument
  const listeners = new Map();
  doc.addEventListener = (type, listener, options) =>
    listeners.set(type, { listener, options });
  doc.removeEventListener = (type) => listeners.delete(type);
  const fire = (type) => listeners.get(type)?.listener({ type });
  // ResizeObserver
  const observers = [];
  const original = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class {
    constructor(callback) {
      this.callback = callback;
      this.observed = [];
      this.disconnected = false;
      observers.push(this);
    }
    observe(element) {
      this.observed.push(element);
    }
    disconnect() {
      this.disconnected = true;
    }
  };
  const timers = [];
  try {
    holdScrollTarget(target, jump, {
      setTimer: (callback, ms) => timers.push({ callback, ms }),
      clearTimer: () => {},
    });
    assert.equal(jumps, 1);
    assert.deepEqual(observers[0].observed, [middle, outer]);
    // Höchstdauer und Ruhezeit (Fixliste 7, F15)
    assert.deepEqual(
      timers.map((timer) => timer.ms),
      [HOLD_SCROLL_MAX_MS, HOLD_SCROLL_QUIET_MS]
    );
    // Eingaben des Nutzers lauschen passiv (kein preventDefault)
    for (const type of [
      "wheel",
      "touchstart",
      "pointerdown",
      "mousedown",
      "keydown",
    ])
      assert.deepEqual(listeners.get(type)?.options, {
        capture: true,
        passive: true,
      });

    // Etwas über dem Ziel wird höher: erneut springen
    top = 680;
    observers[0].callback([]);
    assert.equal(jumps, 2);
    assert.equal(top, 96);
    // Scrollen, das das Ziel nicht verschiebt (eigener Sprung, Verlauf im
    // Panel): nichts
    fire("scroll");
    assert.equal(jumps, 2);
    // Der Browser setzt die Scrollposition (Wiederherstellen): zurück
    top = 0;
    fire("scroll");
    assert.equal(jumps, 3);

    // erste Eingabe: Schluss – kein Sprung mehr, Beobachter getrennt,
    // keine Lauscher mehr
    fire("wheel");
    assert.equal(observers[0].disconnected, true);
    assert.equal(listeners.size, 0);
    top = 500;
    observers[0].callback([]);
    assert.equal(jumps, 3);
  } finally {
    globalThis.ResizeObserver = original;
  }

  // Ohne ResizeObserver: einmal springen; nach HOLD_SCROLL_MAX_MS Schluss
  const later = [];
  let once = 0;
  const stop = holdScrollTarget(target, () => (once += 1), {
    setTimer: (callback) => later.push(callback),
    clearTimer: () => {},
  });
  assert.equal(once, 1);
  later[0]();
  assert.equal(listeners.size, 0);
  stop();
  // ohne Ziel: nichts
  assert.equal(typeof holdScrollTarget(null, () => assert.fail()), "function");
});

// ---------------------------------------------------------------------------
// Fixliste 5 (Browser-Nachprüfung rc17, Kontroll-Review 4)
// ---------------------------------------------------------------------------

test("Fixliste 5, S2: holdScrollTarget – fremdes Scrollen springt nur zurück, solange das Layout unruhig ist; danach gilt es als Absicht des Nutzers und beendet das Halten", () => {
  const doc = createDocument();
  const parent = doc.body.appendChild(doc.createElement("div"));
  const target = parent.appendChild(doc.createElement("div"));
  let top = 640;
  target.getBoundingClientRect = () => ({ top });
  let jumps = 0;
  const jump = () => {
    jumps += 1;
    top = 96;
  };
  const listeners = new Map();
  doc.addEventListener = (type, listener) => listeners.set(type, listener);
  doc.removeEventListener = (type) => listeners.delete(type);
  const fire = (type) => listeners.get(type)?.({ type });
  const observers = [];
  const original = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class {
    constructor(callback) {
      this.callback = callback;
      this.disconnected = false;
      observers.push(this);
    }
    observe() {}
    disconnect() {
      this.disconnected = true;
    }
  };
  let clock = 1000;
  const options = {
    now: () => clock,
    setTimer: () => 1,
    clearTimer: () => {},
  };
  try {
    // Die Seite lädt noch: Jedes fremde Scrollen springt zurück, auch nach
    // der Ruhezeit (Wiederherstellen der Scrollposition beim Laden)
    doc.readyState = "interactive";
    holdScrollTarget(target, jump, options);
    assert.equal(jumps, 1);
    clock += HOLD_SCROLL_QUIET_MS + 500;
    top = 0;
    fire("scroll");
    assert.equal(jumps, 2);
    // fertig geladen: Das Ende des Ladens zählt als Unruhe
    doc.readyState = "complete";
    fire("readystatechange");
    clock += 200;
    top = 300;
    fire("scroll");
    assert.equal(jumps, 3);
    // Größenänderung über dem Ziel: springen, die Ruhezeit beginnt neu
    clock += HOLD_SCROLL_QUIET_MS + 100;
    top = 700;
    observers[0].callback([]);
    assert.equal(jumps, 4);
    clock += HOLD_SCROLL_QUIET_MS - 100;
    top = 50;
    fire("scroll");
    assert.equal(jumps, 5);

    // Ruhe: Ein Scrollen ohne Rad, Zeiger oder Taste (Scrollbalken,
    // Screenreader, „Im Seitentext suchen“) beendet das Halten – kein Sprung
    clock += HOLD_SCROLL_QUIET_MS + 1;
    top = 1500;
    fire("scroll");
    assert.equal(jumps, 5);
    assert.equal(observers[0].disconnected, true);
    assert.equal(listeners.size, 0);
    // danach nichts mehr
    observers[0].callback([]);
    assert.equal(jumps, 5);
  } finally {
    globalThis.ResizeObserver = original;
  }
});

test("Fixliste 5, S3: berlinDateTime ist formatDateTimeDE (utils/dateTimeDE.js) mit Berliner Zeit – keine zweite Formatierung", () => {
  for (const instant of [
    berlin("2026-10-13", "07:48"),
    "2026-12-31T23:30:05.000Z",
    new Date("2026-03-29T01:30:00Z"),
    null,
    0,
    "kein Datum",
  ])
    assert.equal(
      berlinDateTime(instant),
      formatDateTimeDE(instant, { timeZone: "Europe/Berlin" }),
      String(instant)
    );
  assert.equal(
    berlinDateTime("2026-12-31T23:30:05.000Z"),
    "01.01.2027, 00:30:05 Uhr"
  );
});

test("Fixliste 6, K2: formatDateTimeDE legt je Zeitzone einen Formatierer einmal an – Ausgabe wie bisher (toLocaleDateString)", () => {
  const options = {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  };
  const instants = [
    berlin("2026-10-13", "07:48"),
    "2026-12-31T23:30:05.000Z",
    new Date("2026-03-29T01:30:00Z"),
    "2025-04-23T12:30:57.634Z",
  ];
  for (const instant of instants) {
    const date = new Date(instant);
    assert.equal(
      formatDateTimeDE(instant, { timeZone: "Europe/Berlin" }),
      date.toLocaleDateString("de-DE", {
        ...options,
        timeZone: "Europe/Berlin",
      }) + " Uhr"
    );
    assert.equal(
      formatDateTimeDE(instant),
      date.toLocaleDateString("de-DE", options) + " Uhr"
    );
  }
  // Danach entsteht kein neuer Formatierer mehr – weder mit noch ohne Zone –,
  // formatiert wird über die angelegten (format statt toLocaleDateString).
  const original = Intl.DateTimeFormat;
  const formatGetter = Object.getOwnPropertyDescriptor(
    original.prototype,
    "format"
  );
  let created = 0;
  let formatted = 0;
  Intl.DateTimeFormat = function (...args) {
    created += 1;
    return new original(...args);
  };
  Object.defineProperty(original.prototype, "format", {
    ...formatGetter,
    get() {
      formatted += 1;
      return formatGetter.get.call(this);
    },
  });
  try {
    for (let i = 0; i < 100; i += 1) {
      formatDateTimeDE(instants[i % instants.length], {
        timeZone: "Europe/Berlin",
      });
      formatDateTimeDE(instants[i % instants.length]);
    }
  } finally {
    Intl.DateTimeFormat = original;
    Object.defineProperty(original.prototype, "format", formatGetter);
  }
  assert.equal(created, 0);
  assert.equal(formatted, 200);
  assert.equal(formatDateTimeDE(null), "-");
  assert.equal(formatDateTimeDE("kein Datum"), "-");
});

test("Fixliste 6, K1: zwei Hinweise zum Blättern – Link-Fall ohne Aufforderung, „Nächste“-Fall mit „erneut versuchen“ (de + en)", () => {
  for (const [locale, retry] of [
    [de, /erneut versuchen/],
    [en, /try again/],
  ]) {
    const panel = locale["embed-analytics"].panel;
    assert.ok(panel["not-loaded"] && panel["next-not-loaded"]);
    assert.notEqual(panel["not-loaded"], panel["next-not-loaded"]);
    // Link-Fall: vorherige/nächste gesperrt, kein „erneut versuchen“
    assert.doesNotMatch(panel["not-loaded"], retry);
    assert.match(
      panel["not-loaded"],
      /vorherige und nächste|previous and next/
    );
    assert.match(panel["next-not-loaded"], retry);
  }
});

test("Fixliste 6, N1: hasContentGap – nur „einsehbar < gezählt“ ist eine Lücke; gleich oder mehr nicht", () => {
  assert.equal(hasContentGap(916, 0), true);
  assert.equal(hasContentGap(10, 9), true);
  assert.equal(hasContentGap(10, 10), false);
  // weitergeführte ältere Konversationen, eine Kennung aus zwei Sitzungen
  assert.equal(hasContentGap(10, 12), false);
  assert.equal(hasContentGap(0, 0), false);
  for (const [counted, viewable] of [
    [null, 0],
    [5, null],
    [undefined, 0],
    [NaN, 0],
  ])
    assert.equal(hasContentGap(counted, viewable), false);
});

test("Fixliste 6, K5: holdScrollTarget().realign – springt erneut, solange das Halten läuft; danach nicht mehr", () => {
  const doc = createDocument();
  const target = doc.body
    .appendChild(doc.createElement("div"))
    .appendChild(doc.createElement("div"));
  target.getBoundingClientRect = () => ({ top: 96 });
  doc.addEventListener = () => {};
  doc.removeEventListener = () => {};
  let jumps = 0;
  const timers = [];
  const hold = holdScrollTarget(target, () => (jumps += 1), {
    setTimer: (callback) => timers.push(callback),
    clearTimer: () => {},
  });
  assert.equal(jumps, 1);
  hold.realign();
  assert.equal(jumps, 2);
  hold();
  hold.realign();
  assert.equal(jumps, 2);
  // auch nach Ablauf der Zeit nicht
  const timed = holdScrollTarget(target, () => (jumps += 1), {
    setTimer: (callback) => timers.push(callback),
    clearTimer: () => {},
  });
  assert.equal(jumps, 3);
  timers.at(-1)();
  timed.realign();
  assert.equal(jumps, 3);
  // ohne Ziel: vorhanden, tut nichts
  holdScrollTarget(null, () => assert.fail()).realign();
});

// ---------------------------------------------------------------------------
// Fixliste 7 (volles Review, Abnahme entwicklung)
// ---------------------------------------------------------------------------

test("Fixliste 7, F05: Hervorhebung nach derselben Regel wie die Suche des Servers – türkisches ı/I/İ/i, ß/ẞ, Kelvin und langes s", () => {
  // Dieselben Schreibweisen je Zeichen wie variantsOf des Servers (dort
  // als Zeichenklasse im GLOB-Muster)
  const serverClass = (char) => {
    const pattern = serverSearch.searchGlobPattern(char).slice(1, -1);
    return pattern.startsWith("[") ? [...pattern.slice(1, -1)] : [char];
  };
  for (const char of [
    "ı",
    "I",
    "İ",
    "i",
    "ß",
    "ẞ",
    "ü",
    "Ü",
    "K",
    "k",
    "\u212A", // Kelvin
    "ſ", // langes s
    "s",
    "Σ",
    "ς",
    "σ",
    "ǅ",
    "1",
    "-",
  ])
    assert.deepEqual(
      [char, searchVariants(char).sort()],
      [char, serverClass(char).sort()]
    );

  const hits = (text, term) =>
    highlightParts(text, term)
      .filter((part) => part.hit)
      .map((part) => part.text);
  // Der Server findet „KISA“ mit „kısa“ ([ıI]) – das Panel hebt es hervor.
  assert.deepEqual(hits("KISA ve kısa", "kısa"), ["KISA", "kısa"]);
  // „KISA“ (ASCII) sucht wie LIKE: K/k, I/i … – kein ı
  assert.deepEqual(hits("KISA kisa kısa", "KISA"), ["KISA", "kisa"]);
  // „i“ trifft I und i, nicht İ und nicht ı – wie der Server
  assert.deepEqual(hits("İstanbul Istanbul istanbul ıstanbul", "istanbul"), [
    "Istanbul",
    "istanbul",
  ]);
  // İ hat keine einfache Kleinschreibung: nur sich selbst
  assert.deepEqual(hits("İstanbul istanbul", "İstanbul"), ["İstanbul"]);
  // ß und ẞ gelten gleich, „SS“ nicht (dokumentiert, AK-11)
  assert.deepEqual(hits("GRÖẞE größe GRÖSSE", "größe"), ["GRÖẞE", "größe"]);
  // kein Faltungs-Sonderweg des u-Flags: Kelvin-Zeichen und langes s nur,
  // wenn auch der Server sie findet
  assert.deepEqual(hits("\u212Aurs kurſ Kurs", "kurs"), ["Kurs"]);
  // Sonderzeichen wörtlich
  assert.deepEqual(hits("vhs-lingen.de und vhsXlingen", "vhs-lingen.de"), [
    "vhs-lingen.de",
  ]);
  assert.deepEqual(hits("a.b*c", "a.b*c"), ["a.b*c"]);
  // sichtbarer Treffer derselben Regel: kein falscher Hinweis
  // „steht nur in Link-Adressen …“
  assert.equal(
    hasVisibleHit(
      [{ prompt: "?", response: JSON.stringify({ text: "KISA" }) }],
      "kısa"
    ),
    true
  );
});

test("Fixliste 7, F15: holdScrollTarget endet von selbst, sobald die Seite geladen ist und das Layout HOLD_SCROLL_QUIET_MS ruhig war – jede Unruhe und realign beginnen die Ruhezeit neu", () => {
  const doc = createDocument();
  const target = doc.body
    .appendChild(doc.createElement("div"))
    .appendChild(doc.createElement("div"));
  let top = 640;
  target.getBoundingClientRect = () => ({ top });
  let jumps = 0;
  const jump = () => {
    jumps += 1;
    top = 96;
  };
  const listeners = new Map();
  doc.addEventListener = (type, listener) => listeners.set(type, listener);
  doc.removeEventListener = (type) => listeners.delete(type);
  const fire = (type) => listeners.get(type)?.({ type });
  const observers = [];
  const original = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class {
    constructor(callback) {
      this.callback = callback;
      this.disconnected = false;
      observers.push(this);
    }
    observe() {}
    disconnect() {
      this.disconnected = true;
    }
  };
  // Zeitgeber von Hand: id → { callback, ms }
  let nextId = 0;
  const timers = new Map();
  const options = {
    setTimer: (callback, ms) => {
      timers.set(++nextId, { callback, ms });
      return nextId;
    },
    clearTimer: (id) => timers.delete(id),
  };
  const quiet = () =>
    [...timers.values()].filter((t) => t.ms === HOLD_SCROLL_QUIET_MS);
  try {
    doc.readyState = "loading";
    const hold = holdScrollTarget(target, jump, options);
    assert.equal(jumps, 1);
    assert.equal(quiet().length, 1);
    // Ruhezeit um, die Seite lädt aber noch: hält weiter
    quiet()[0].callback();
    assert.equal(observers[0].disconnected, false);
    // Ende des Ladens: neue Ruhezeit
    doc.readyState = "complete";
    fire("readystatechange");
    assert.equal(quiet().length, 1);
    // eine Größenänderung darüber: springen, Ruhezeit neu (nur eine)
    top = 700;
    observers[0].callback([]);
    assert.equal(jumps, 2);
    assert.equal(quiet().length, 1);
    // realign (die Zeile ist nachgeladen): springen, Ruhezeit neu
    hold.realign();
    assert.equal(jumps, 3);
    assert.equal(quiet().length, 1);
    // Ruhe: Schluss – ohne Eingabe, keine Lauscher, kein Beobachter mehr
    quiet()[0].callback();
    assert.equal(observers[0].disconnected, true);
    assert.equal(listeners.size, 0);
    assert.equal(timers.size, 0);
    top = 1500;
    observers[0].callback([]);
    hold.realign();
    assert.equal(jumps, 3);
  } finally {
    globalThis.ResizeObserver = original;
  }
});

test("Fixliste 7, F24: focusLost – verloren, wenn der Fokus auf <body> steht oder sein Element nicht mehr im Dokument ist; nicht, solange jemand in einem Feld steht", () => {
  const doc = createDocument();
  const input = doc.body.appendChild(doc.createElement("input"));
  doc.activeElement = doc.body;
  assert.equal(focusLost(doc), true);
  doc.activeElement = null;
  assert.equal(focusLost(doc), true);
  doc.activeElement = input;
  assert.equal(focusLost(doc), false);
  doc.body.removeChild(input);
  assert.equal(focusLost(doc), true);
  assert.equal(focusLost(undefined), false);
});

test("Fixliste 7, B3: Such-Markierung – im dunklen Theme ruhiger als das kräftige Gelb, in beiden Themes Kontrast ≥ 4,5:1", () => {
  const css = readFileSync(
    new URL("../src/index.css", import.meta.url),
    "utf8"
  );
  const block = (selector) => {
    const start = css.indexOf(`${selector} {\n  --konversationen-hit-bg`);
    assert.ok(start >= 0, `kein Block ${selector}`);
    return css.slice(start, css.indexOf("}", start));
  };
  const value = (text, name) =>
    new RegExp(`--konversationen-hit-${name}:\\s*(#[0-9a-f]{6})`, "i").exec(
      text
    )[1];
  const luminance = (hex) => {
    const [r, g, b] = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (a, b) => {
    const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (high + 0.05) / (low + 0.05);
  };
  const dark = block(":root");
  const light = block('[data-theme="light"]');
  for (const theme of [dark, light])
    assert.ok(contrast(value(theme, "bg"), value(theme, "text")) >= 4.5);
  // dunkel nicht mehr das grelle Gelb des hellen Themes
  assert.notEqual(value(dark, "bg").toLowerCase(), "#fde047");
  assert.ok(luminance(value(dark, "bg")) < 0.2);
  // die Regel nutzt die Variablen
  assert.match(
    css,
    /mark\[data-search-hit\] \{\s*background-color: var\(--konversationen-hit-bg\);\s*color: var\(--konversationen-hit-text\) !important;/
  );
});

test("Fixliste 7, B1: Absätze und Blöcke einer Antwort im Panel haben Abstand zueinander (wie im Widget)", () => {
  const css = readFileSync(
    new URL("../src/index.css", import.meta.url),
    "utf8"
  );
  const rule =
    /\.analytics-bot-response\s*:where\(p, ul, ol, pre, blockquote, table, h1, h2, h3, h4, h5, h6, hr\)\s*\+ :where\(p, ul, ol, pre, blockquote, table, h1, h2, h3, h4, h5, h6, hr\) \{\s*margin-top: 0\.75em;/;
  assert.match(css, rule);
  // Fixliste 8 (Hinweis Browser): mehrzeilige Listeneinträge (Kursblöcke)
  // mit Abstand zueinander, einzeilige bleiben kompakt
  assert.match(
    css,
    /\.analytics-bot-response li:where\(:has\(br, p, ul, ol\)\) \+ li,\s*\.analytics-bot-response li \+ li:where\(:has\(br, p, ul, ol\)\) \{\s*margin-top: 0\.5em;/
  );
});

test("Fixliste 7, F23/F24: eine Stelle für „breit?“, „außerhalb/Escape schließen“ und „Fokus verloren?“ – keine Kopien in Liste, Panel, Exportmenü und Kopfzeile", () => {
  const source = (file) =>
    readFileSync(
      new URL(
        `../src/pages/GeneralSettings/ChatEmbedWidgets/EmbedAnalytics/${file}`,
        import.meta.url
      ),
      "utf8"
    );
  const files = [
    "ConversationList.jsx",
    "ConversationDetail.jsx",
    "ExportMenu.jsx",
    "index.jsx",
  ];
  for (const file of files) {
    const text = source(file);
    assert.doesNotMatch(text, /addEventListener\("mousedown"/, file);
    assert.doesNotMatch(text, /function useWide|matchMedia\(/, file);
    assert.doesNotMatch(text, /document\.activeElement/, file);
  }
  for (const file of ["ConversationDetail.jsx", "ExportMenu.jsx", "index.jsx"])
    assert.match(source(file), /useDismiss\(/, file);
  assert.match(source("ConversationDetail.jsx"), /useWide\(\)/);
  // useWide beginnt mit isWide() – derselbe Wert ohne matchMedia (false)
  assert.match(source("viewHooks.js"), /useState\(isWide\)/);
});

// ---------------------------------------------------------------------------
// Fixliste 8 (Kontrolle rc20)
// ---------------------------------------------------------------------------

test("Fixliste 8, M1: holdScrollTarget mit busy – solange das Ziel nicht fertig ist (Link-Suche lädt), endet das Halten nicht durch Ruhe; danach nach der Ruhezeit, spätestens nach HOLD_SCROLL_BUSY_MAX_MS; eine Eingabe beendet es sofort", () => {
  const doc = createDocument();
  const target = doc.body
    .appendChild(doc.createElement("div"))
    .appendChild(doc.createElement("div"));
  let top = 640;
  target.getBoundingClientRect = () => ({ top });
  let jumps = 0;
  const jump = () => {
    jumps += 1;
    top = 96;
  };
  const listeners = new Map();
  doc.addEventListener = (type, listener) => listeners.set(type, listener);
  doc.removeEventListener = (type) => listeners.delete(type);
  const fire = (type) => listeners.get(type)?.({ type });
  doc.readyState = "complete";
  // Zeitgeber von Hand: id → { callback, ms }; Uhr von Hand
  let clock = 0;
  let nextId = 0;
  const timers = new Map();
  let busy = true;
  const options = {
    busy: () => busy,
    now: () => clock,
    setTimer: (callback, ms) => {
      timers.set(++nextId, { callback, ms });
      return nextId;
    },
    clearTimer: (id) => timers.delete(id),
  };
  // den ältesten Zeitgeber mit dieser Dauer ablaufen lassen
  const run = (ms) => {
    const entry = [...timers.entries()].find(([, t]) => t.ms === ms);
    assert.ok(entry, `kein Zeitgeber mit ${ms} ms`);
    timers.delete(entry[0]);
    clock += ms;
    entry[1].callback();
  };

  // 1. Langsame Folgeseite: Ruhezeit um, Ziel nicht fertig → hält weiter,
  //    mehrmals hintereinander
  const hold = holdScrollTarget(target, jump, options);
  assert.equal(jumps, 1);
  run(HOLD_SCROLL_QUIET_MS);
  run(HOLD_SCROLL_QUIET_MS);
  assert.ok(listeners.size > 0, "hält, solange die Suche läuft");
  // Die Zeile ist da: realign springt noch
  busy = false;
  hold.realign();
  assert.equal(jumps, 2);
  // danach Ruhe: Schluss
  run(HOLD_SCROLL_QUIET_MS);
  assert.equal(listeners.size, 0);
  assert.equal(timers.size, 0);
  hold.realign();
  assert.equal(jumps, 2);

  // 2. Höchstdauer um, Ziel nicht fertig: weiter bis zur harten Grenze
  busy = true;
  clock = 0;
  holdScrollTarget(target, jump, options);
  run(HOLD_SCROLL_MAX_MS);
  assert.ok(listeners.size > 0, "hält über HOLD_SCROLL_MAX_MS hinaus");
  const hard = [...timers.values()].find(
    (t) => t.ms === HOLD_SCROLL_BUSY_MAX_MS - HOLD_SCROLL_MAX_MS
  );
  assert.ok(hard, "harte Obergrenze ab dem Start gerechnet");
  hard.callback();
  assert.equal(listeners.size, 0, "spätestens nach HOLD_SCROLL_BUSY_MAX_MS");
  for (const id of [...timers.keys()]) timers.delete(id);

  // 3. Eine Eingabe beendet es sofort, auch während der Suche
  holdScrollTarget(target, jump, options);
  fire("wheel");
  assert.equal(listeners.size, 0);
  for (const id of [...timers.keys()]) timers.delete(id);

  // 4. Ohne busy wie bisher: Höchstdauer um → Schluss
  busy = false;
  holdScrollTarget(target, jump, options);
  run(HOLD_SCROLL_MAX_MS);
  assert.equal(listeners.size, 0);
  assert.ok(HOLD_SCROLL_BUSY_MAX_MS > HOLD_SCROLL_MAX_MS);
});

// ---------------------------------------------------------------------------
// Nachtrag N2 (7.21.1): Sprung zur bewerteten Antwort, dezente Kennzeichnung
// ---------------------------------------------------------------------------

test("Nachtrag N2: startScrollTop – der Anfang des Elements steht mit Abstand oben im Bereich; nie unter 0", () => {
  const container = {
    scrollTop: 200,
    clientHeight: 400,
    getBoundingClientRect: () => ({ top: 100, height: 400 }),
  };
  const at = (top) => ({ getBoundingClientRect: () => ({ top, height: 50 }) });
  // 300 px unter dem Anfang des sichtbaren Bereichs, 200 px gescrollt
  assert.equal(startScrollTop(container, at(400)), 200 + 300 - 16);
  assert.equal(startScrollTop(container, at(400), 0), 500);
  // schon über dem Anfang: zurück, aber nicht unter 0
  assert.equal(startScrollTop(container, at(50)), 200 - 50 - 16);
  assert.equal(startScrollTop({ ...container, scrollTop: 0 }, at(100)), 0);
  assert.equal(
    startScrollTop(container, { getBoundingClientRect: () => ({}) }),
    0
  );
});

// Kontrast (WCAG 2.x): relative Leuchtdichte und Verhältnis
const channel = (value) => {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const hexRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const luminance = ([r, g, b]) =>
  0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
/** Farbe mit Deckkraft über einem Grund. */
const over = (rgb, alpha, base) =>
  rgb.map((value, i) => value * alpha + base[i] * (1 - alpha));

/**
 * Tailwind-Farbe aus einer Klasse wie „bg-orange-500/[0.08]“ oder
 * „light:bg-sky-50“: { rgb, alpha }.
 */
function tailwindColor(className, palette) {
  const match = className.match(
    /^(?:light:)?(?:bg|text|outline)-([a-z]+)-(\d+)(?:\/(?:\[([\d.]+)\]|(\d+)))?$/
  );
  assert.ok(match, className);
  const [, name, shade, arbitrary, percent] = match;
  const hex = palette[name]?.[shade];
  assert.ok(hex, className);
  const alpha = arbitrary
    ? Number(arbitrary)
    : percent
      ? Number(percent) / 100
      : 1;
  return { rgb: hexRgb(hex), alpha };
}

test("Nachtrag N2 (b): Der Hintergrund bewerteter Antworten ist hauchzart; Text darauf hält in hell und dunkel mindestens 4,5:1, die kurze Hervorhebung nach dem Sprung mindestens 3:1", async () => {
  const { createRequire } = await import("node:module");
  const palette = createRequire(import.meta.url)("tailwindcss/colors");
  const css = readFileSync(
    new URL("../src/index.css", import.meta.url),
    "utf8"
  );
  const variable = (block, name) => {
    const start = css.indexOf(block);
    const match = css
      .slice(start)
      .match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`));
    return hexRgb(match[1]);
  };
  const dark = {
    // mobil (Vollbild) und ab lg (Seitenpanel)
    grounds: [
      variable(":root {", "theme-bg-secondary"),
      variable(":root {", "theme-bg-primary"),
    ],
    text: variable(":root {", "theme-text-primary"),
  };
  const light = {
    grounds: [
      variable('[data-theme="light"] {', "theme-bg-secondary"),
      variable('[data-theme="light"] {', "theme-bg-primary"),
    ],
    text: variable('[data-theme="light"] {', "theme-text-primary"),
  };
  const color = (name) => tailwindColor(name, palette);
  // Text auf der Antwort: Antworttext (Textfarbe des Themes), Marke
  // „Positiv bewertet“ / „Negativ bewertet“ (Rating), Kopf-Schaltfläche;
  // die negative Bewertung steht zusätzlich in ihrem Kasten (RATING_BOX).
  const boxClasses = RATING_BOX.split(/\s+/);
  const tones = {
    negative: {
      dark: ["text-orange-300"],
      light: ["text-orange-800", "text-orange-700"],
      box: {
        dark: boxClasses.find((c) => c.startsWith("bg-")),
        light: boxClasses.find((c) => c.startsWith("light:bg-")),
      },
    },
    positive: {
      dark: ["text-sky-300"],
      light: ["text-sky-700"],
      box: null,
    },
  };
  const report = [];
  for (const kind of ["negative", "positive"]) {
    const classes = RATING_TINT[kind].split(/\s+/);
    const darkTint = color(classes.find((c) => c.startsWith("bg-")));
    const lightTint = color(classes.find((c) => c.startsWith("light:bg-")));
    // hauchzart: dunkel höchstens 10 % Deckkraft, hell eine 50er-Stufe
    assert.ok(darkTint.alpha <= 0.1, `${kind}: ${darkTint.alpha}`);
    assert.match(
      classes.find((c) => c.startsWith("light:bg-")),
      /-50$/
    );
    for (const [theme, tint, setup, labels] of [
      ["dunkel", darkTint, dark, tones[kind].dark],
      ["hell", lightTint, light, tones[kind].light],
    ])
      for (const ground of setup.grounds) {
        const tinted = over(tint.rgb, tint.alpha, ground);
        const grounds = [tinted];
        const box = tones[kind].box?.[theme === "dunkel" ? "dark" : "light"];
        if (box) {
          const boxColor = color(box);
          const boxed = over(boxColor.rgb, boxColor.alpha, tinted);
          grounds.push(boxed);
          // Der Kasten hebt sich von der getönten Antwort ab (Review
          // 7.21.1: hell lag er in derselben Farbe darauf und verschwand)
          const apart = contrast(boxed, tinted);
          report.push(`${kind} ${theme} Kasten/Tönung: ${apart.toFixed(3)}`);
          assert.ok(apart >= 1.04, `${kind} ${theme} Kasten/Tönung: ${apart}`);
        }
        for (const bg of grounds) {
          const ratios = [
            ["Text", contrast(setup.text, bg)],
            ...labels.map((label) => {
              const { rgb } = color(label);
              return [label, contrast(rgb, bg)];
            }),
          ];
          for (const [what, ratio] of ratios) {
            report.push(`${kind} ${theme} ${what}: ${ratio.toFixed(2)}`);
            assert.ok(ratio >= 4.5, `${kind} ${theme} ${what}: ${ratio}`);
          }
        }
        // Hervorhebung nach dem Sprung: Umriss außen, gegen den Grund
        const flash = RATING_FLASH[kind].split(/\s+/);
        const outline = color(
          flash.find((c) =>
            theme === "dunkel"
              ? /^outline-[a-z]+-\d+$/.test(c)
              : /^light:outline-[a-z]+-\d+$/.test(c)
          )
        );
        const ratio = contrast(outline.rgb, ground);
        report.push(`${kind} ${theme} Hervorhebung: ${ratio.toFixed(2)}`);
        assert.ok(ratio >= 3, `${kind} ${theme} Hervorhebung: ${ratio}`);
      }
  }
  assert.ok(report.length > 0);
});

test("Review 7.21.1 (N2 a): ratingJumpIds – die so bewerteten Antworten im Zeitraum (ohne Zeitraum alle); ratingOf liest feedbackScore", () => {
  const at = (day) => new Date(`${day}T10:00:00Z`).toISOString();
  const messages = [
    { id: 1, feedbackScore: false, createdAt: at("2026-09-10") },
    { id: 2, feedbackScore: false, createdAt: at("2026-10-01") },
    { id: 3, feedbackScore: true, createdAt: at("2026-10-02") },
    { id: 4, feedbackScore: null, createdAt: at("2026-10-03") },
    { id: 5, createdAt: at("2026-10-04") },
  ];
  const period = { fromDay: "2026-09-13", toDay: "2026-10-13" };
  assert.deepEqual(ratingJumpIds(messages, "negative", period), [2]);
  assert.deepEqual(ratingJumpIds(messages, "negative"), [1, 2]);
  assert.deepEqual(ratingJumpIds(messages, "positive", period), [3]);
  assert.deepEqual(ratingJumpIds([], "positive", period), []);
  assert.deepEqual(ratingJumpIds(null, "positive"), []);
  assert.deepEqual(messages.map(ratingOf), [
    "negative",
    "negative",
    "positive",
    null,
    null,
  ]);
});

// ---------------------------------------------------------------------------
// KIE-575: Arbeitsbereich ab lg – Konstanten, gemerkter Verlauf, Pfeiltasten
// ---------------------------------------------------------------------------

test("KIE-575, AK-2 / rc11 K13 / rc13 E15: WORKSPACE – Bereich mit fester Höhe (100vh − 88 px, mindestens 480 px: bei 600 px Fensterhöhe ganz im Fenster), Liste scrollt selbst, Verlauf einheitlich 56 % und mindestens 480 px; alles nur auf dem Desktop (xl, 1.280 px), nichts ab lg oder 2xl", () => {
  assert.equal(WORKSPACE_TOP_GAP, 88);
  assert.equal(WORKSPACE_MIN_HEIGHT, 480);
  // K13: Unter dem Bereich liegen 64 px (48 Innenabstand + 16 Rahmen). Bei
  // 600 px Fensterhöhe (das niedrigste übliche Fenster ab lg) nimmt er
  // 100vh − 88 = 512 px und steht 24 px unter dem oberen Rand; die
  // Mindesthöhe greift erst unter 568 px und bleibt bis 544 px ohne
  // Anschnitt (vorher 560: bei 600 px ragte er 24 px über den Rand).
  assert.ok(Math.max(WORKSPACE_MIN_HEIGHT, 600 - WORKSPACE_TOP_GAP) + 64 <= 600);
  assert.equal(WORKSPACE_MIN_HEIGHT + 64, 544);
  assert.equal(WORKSPACE_PANEL_MIN_WIDTH, 480);
  const classes = (value) => value.split(/\s+/).filter(Boolean);
  const has = (value, names) =>
    names.every((name) => classes(value).includes(name));
  assert.ok(
    has(WORKSPACE.area, [
      "xl:flex",
      "xl:gap-4",
      "xl:h-[max(480px,calc(100vh-88px))]",
    ]),
    WORKSPACE.area
  );
  assert.ok(
    has(WORKSPACE.column, ["xl:flex", "xl:min-w-0", "xl:flex-1", "xl:flex-col"])
  );
  assert.ok(
    has(WORKSPACE.scroller, ["xl:min-h-0", "xl:flex-1", "xl:overflow-y-auto"])
  );
  // E15: einheitlich Liste 44 % und Verlauf 56 % (kein Schritt bei
  // 1.536 px), der Verlauf überall mindestens 480 px
  assert.deepEqual(classes(WORKSPACE.panel), [
    "xl:w-[calc(56%-8px)]",
    "xl:min-w-[480px]",
    "xl:shrink-0",
  ]);
  // Die Zahlen in den Klassen sind die Konstanten – wörtlich, damit Tailwind
  // das CSS erzeugt (keine Vorlagen)
  assert.ok(
    WORKSPACE.area.includes(
      `max(${WORKSPACE_MIN_HEIGHT}px,calc(100vh-${WORKSPACE_TOP_GAP}px))`
    )
  );
  assert.ok(WORKSPACE.panel.includes(`min-w-[${WORKSPACE_PANEL_MIN_WIDTH}px]`));
  const source = readFileSync(
    new URL("../src/utils/conversationView.js", import.meta.url),
    "utf8"
  );
  assert.ok(source.includes('"xl:flex xl:gap-4 xl:h-[max(480px,calc(100vh-88px))]"'));
  assert.ok(source.includes("xl:min-w-[480px]"));
  // Tablet und Smartphone wie bisher unter lg: nur Präfixe xl (Desktop)
  for (const value of Object.values(WORKSPACE))
    for (const name of classes(value)) assert.match(name, /^xl:/, name);
});

test("rc13, E15: Geräteklassen – der Verlauf steht ab 1.280 px (Tailwind xl, Desktop) neben der Liste; darunter (Tablet 768 bis 1.279 px, Smartphone) ist er ein Vollbild", () => {
  assert.equal(rc13.WIDE_QUERY, "(min-width: 1280px)");
  const original = globalThis.window;
  try {
    for (const [width, desktop] of [
      [390, false],
      [768, false],
      [1024, false],
      [1279, false],
      [1280, true],
      [1440, true],
      [1920, true],
    ]) {
      globalThis.window = {
        matchMedia: (query) => ({
          matches: Number(query.match(/min-width: (\d+)px/)?.[1]) <= width,
        }),
      };
      assert.equal(isWide(), desktop, `${width} px`);
    }
  } finally {
    globalThis.window = original;
  }
});

test("Review 7.22-rc12, K04: Sprungziel „Liste“ – auf dem Desktop die Ruhelage des Arbeitsbereichs (Oberkante 24 px unter dem Fensterrand: 8 px unter dem Rahmen, xl:scroll-mt-2), auf Tablet und Smartphone weiter unter dem Benutzermenü (scroll-mt-20); Höhe und Sprungziel aus derselben Ruhelage", () => {
  const { FRAME_TOP, WORKSPACE_REST_TOP } = rc13;
  assert.equal(AVATAR_CLEARANCE.jumpTarget, "scroll-mt-20 xl:scroll-mt-2");
  assert.equal(FRAME_TOP, 16);
  assert.equal(WORKSPACE_REST_TOP, 24);
  // xl:scroll-mt-2 = 2 · 4 px = Ruhelage minus Rahmen
  const margin = Number(
    AVATAR_CLEARANCE.jumpTarget.match(/xl:scroll-mt-(\d+)/)?.[1]
  );
  assert.equal(margin * 4, WORKSPACE_REST_TOP - FRAME_TOP);
  // Höhe des Bereichs: Ruhelage oben, darunter 48 px Abstand und 16 px Rahmen
  assert.equal(WORKSPACE_TOP_GAP, WORKSPACE_REST_TOP + 48 + 16);
  // Nach dem Sprung endet der Bereich bei 1920×1080 im Fenster (vorher bei
  // 96 + 992 = 1088 px, 24 px darunter)
  for (const height of [1080, 900, 600]) {
    const area = Math.max(WORKSPACE_MIN_HEIGHT, height - WORKSPACE_TOP_GAP);
    const top = FRAME_TOP + margin * 4;
    assert.ok(top + area <= height - 64, `${height}: ${top + area}`);
  }
});

test("KIE-575, AK-4: readPanelPreference/writePanelPreference – Standard offen, „closed“ gemerkt, Fehler des Speichers ändern nichts", () => {
  const store = new Map();
  const storage = {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, String(value)),
  };
  assert.equal(PANEL_PREFERENCE_KEY, "kie.conversations.panel");
  assert.equal(readPanelPreference(storage), true);
  writePanelPreference(false, storage);
  assert.equal(store.get(PANEL_PREFERENCE_KEY), "closed");
  assert.equal(readPanelPreference(storage), false);
  writePanelPreference(true, storage);
  assert.equal(store.get(PANEL_PREFERENCE_KEY), "open");
  assert.equal(readPanelPreference(storage), true);
  // Unbekannter Wert: offen
  store.set(PANEL_PREFERENCE_KEY, "irgendwas");
  assert.equal(readPanelPreference(storage), true);
  // Speicher gesperrt (privates Fenster): offen, Schreiben wirft nicht
  const locked = {
    getItem() {
      throw new Error("gesperrt");
    },
    setItem() {
      throw new Error("gesperrt");
    },
  };
  assert.equal(readPanelPreference(locked), true);
  assert.doesNotThrow(() => writePanelPreference(false, locked));
  // kein Speicher
  assert.equal(readPanelPreference(null), true);
  assert.doesNotThrow(() => writePanelPreference(true, null));
});

test("KIE-575, AK-6: arrowNavigationAllowed – ↑/↓ blättern bei Fokus auf <body> oder im Kopf des Panels; nicht in Eingaben, auf Zeilen, im Menü „⋯“ oder im Verlauf", () => {
  const doc = createDocument();
  assert.equal(arrowNavigationAllowed(doc), true, "Seite gerade geöffnet");
  const input = doc.body.appendChild(doc.createElement("input"));
  input.focus();
  assert.equal(arrowNavigationAllowed(doc), false, "Suchfeld");

  const panel = doc.body.appendChild(doc.createElement("aside"));
  const head = panel.appendChild(doc.createElement("header"));
  head.setAttribute("data-panel-head", "");
  const close = head.appendChild(doc.createElement("button"));
  close.focus();
  assert.equal(arrowNavigationAllowed(doc), true, "✕ im Kopf");
  const menu = head.appendChild(doc.createElement("div"));
  menu.setAttribute("role", "menu");
  const item = menu.appendChild(doc.createElement("button"));
  item.focus();
  assert.equal(arrowNavigationAllowed(doc), false, "Menü „⋯“");
  const body = panel.appendChild(doc.createElement("div"));
  body.setAttribute("data-panel-body", "");
  body.setAttribute("tabindex", "0");
  body.focus();
  assert.equal(arrowNavigationAllowed(doc), false, "scrollender Verlauf");

  const row = doc.body.appendChild(doc.createElement("button"));
  row.setAttribute("data-conversation-row", "1");
  row.focus();
  assert.equal(arrowNavigationAllowed(doc), false, "Zeile (eigener Handler)");
  // Fokus auf einem Element, das nicht mehr im Dokument ist: wie <body>
  doc.activeElement = doc.createElement("button");
  assert.equal(arrowNavigationAllowed(doc), true);
  assert.equal(arrowNavigationAllowed(undefined), false);
});

// ---------------------------------------------------------------------------
// Fixliste 7.22-rc11 (Abnahme rc9): K11, K12, K14, K15
// ---------------------------------------------------------------------------

test("rc11, K11: nearestScrollTop – Scrollposition, bei der ein Element im Bereich ganz zu sehen ist, mit möglichst wenig Bewegung und nur für diesen Bereich (die Seite bleibt); ROW_SCROLL_MARGIN 32 oben (Tagesüberschrift), 8 unten", () => {
  assert.deepEqual(ROW_SCROLL_MARGIN, { marginTop: 32, marginBottom: 8 });
  // Bereich 300 px hoch ab y 100 mit Scrollposition scrollTop; Element bei
  // offset (vom Anfang des Inhalts) mit Höhe height
  const container = (scrollTop) => ({
    scrollTop,
    clientHeight: 300,
    getBoundingClientRect: () => ({ top: 100 }),
  });
  const element = (offset, scrollTop, height = 54) => ({
    getBoundingClientRect: () => ({ top: 100 + offset - scrollTop, height }),
  });
  // ganz im Bild: die Position bleibt
  assert.equal(nearestScrollTop(container(0), element(100, 0)), 0);
  assert.equal(nearestScrollTop(container(120), element(200, 120)), 120);
  // genau am unteren Rand (Unterkante = Rand): bleibt
  assert.equal(nearestScrollTop(container(0), element(246, 0)), 0);
  // unten angeschnitten: die Unterkante an den unteren Rand, mit Rand
  assert.equal(nearestScrollTop(container(0), element(270, 0)), 24);
  assert.equal(
    nearestScrollTop(container(0), element(270, 0), { marginBottom: 8 }),
    32
  );
  // oben angeschnitten oder darüber: der Anfang nach oben, mit Rand
  assert.equal(nearestScrollTop(container(200), element(150, 200)), 150);
  assert.equal(
    nearestScrollTop(container(200), element(150, 200), { marginTop: 32 }),
    118
  );
  // höher als der Bereich: der Anfang nach oben
  assert.equal(nearestScrollTop(container(50), element(80, 50, 400)), 80);
  // nie unter 0; ohne Maße 0
  assert.equal(
    nearestScrollTop(container(10), element(0, 10), { marginTop: 32 }),
    0
  );
  assert.equal(
    nearestScrollTop(
      { getBoundingClientRect: () => ({ top: 0 }) },
      { getBoundingClientRect: () => ({ top: 0, height: 0 }) }
    ),
    0
  );
  // gerundet
  assert.equal(nearestScrollTop(container(0), element(270.4, 0)), 24);
});

test("rc11, K12 / K14: AVATAR_CLEARANCE.panelHeadEnd (xl:pr-7, nur auf dem Desktop: mit dem Innenabstand des Kopfs 48 px rechts, ✕ und ⋯ links vom Benutzermenü) und emptyPanelClose (right-12); BUBBLE: Blasen höchstens 720 px bei jeder Breite (E14), Nutzerblasen weiter höchstens 85 %", () => {
  assert.equal(AVATAR_CLEARANCE.panelHeadEnd, "xl:pr-7");
  assert.equal(AVATAR_CLEARANCE.emptyPanelClose, "right-12");
  assert.equal(BUBBLE_MAX_WIDTH, 720);
  assert.deepEqual(BUBBLE, {
    question: "max-w-[min(85%,720px)]",
    answer: "max-w-[720px]",
  });
  for (const value of Object.values(BUBBLE))
    assert.ok(value.includes(`${BUBBLE_MAX_WIDTH}px`), value);
});

test("rc11, K15: hasFocus – hat das Element den Fokus des Dokuments? (eine Stelle statt document.activeElement in der Liste, Fixliste 7 F24)", () => {
  const doc = createDocument();
  const button = doc.body.appendChild(doc.createElement("button"));
  assert.equal(hasFocus(button, doc), false);
  button.focus();
  assert.equal(hasFocus(button, doc), true);
  assert.equal(hasFocus(null, doc), false);
  assert.equal(hasFocus(button, undefined), false);
  button.blur();
  assert.equal(hasFocus(button, doc), false);
});

test("rc11, K15: focusVisible – fragt :focus-visible ab (Tastaturfokus); ohne Auskunft (kein matches, unbekannte Pseudoklasse, kein Element) gilt Tastatur", () => {
  assert.equal(focusVisible({ matches: (s) => s === ":focus-visible" }), true);
  assert.equal(focusVisible({ matches: () => false }), false);
  assert.equal(
    focusVisible({
      matches() {
        throw new Error("unbekannte Pseudoklasse");
      },
    }),
    true
  );
  assert.equal(focusVisible({}), true);
  assert.equal(focusVisible(null), true);
});

// ---------------------------------------------------------------------------
// Fixliste 7.22-rc13 (Nachreview rc12): K01, K05, C4, K14 (E13)
// ---------------------------------------------------------------------------

test("rc12, K01: arrowStep – ↓ 1, ↑ −1; mit Umschalt- (Textauswahl), Alt-, Strg- oder Befehlstaste 0, ebenso andere Tasten", () => {
  const { arrowStep } = rc13;
  assert.equal(arrowStep({ key: "ArrowDown" }), 1);
  assert.equal(arrowStep({ key: "ArrowUp" }), -1);
  for (const modifier of ["shiftKey", "altKey", "ctrlKey", "metaKey"]) {
    assert.equal(arrowStep({ key: "ArrowDown", [modifier]: true }), 0, modifier);
    assert.equal(arrowStep({ key: "ArrowUp", [modifier]: true }), 0, modifier);
  }
  assert.equal(arrowStep({ key: "ArrowLeft" }), 0);
  assert.equal(arrowStep({ key: "Enter" }), 0);
  assert.equal(arrowStep(null), 0);
});

test("rc12, K05: arrowNavigationAllowed – nie, solange ein modaler Dialog (aria-modal) offen ist, auch bei Fokus auf <body>; danach wieder", () => {
  const doc = createDocument();
  assert.equal(arrowNavigationAllowed(doc), true);
  const dialog = doc.body.appendChild(doc.createElement("div"));
  dialog.setAttribute("aria-modal", "true");
  assert.equal(arrowNavigationAllowed(doc), false, "Rückfrage offen, <body>");
  const head = doc.body.appendChild(doc.createElement("header"));
  head.setAttribute("data-panel-head", "");
  const close = head.appendChild(doc.createElement("button"));
  close.focus();
  assert.equal(arrowNavigationAllowed(doc), false, "Rückfrage offen, Kopf");
  doc.body.removeChild(dialog);
  assert.equal(arrowNavigationAllowed(doc), true, "Rückfrage zu");
  // auch mit querySelector (Browser)
  const browserLike = {
    ...doc,
    body: doc.body,
    activeElement: doc.body,
    querySelector: (selector) =>
      selector === '[aria-modal="true"]' ? {} : null,
  };
  assert.equal(arrowNavigationAllowed(browserLike), false);
});

test("rc12, C4: readPanelPreference/writePanelPreference ohne Angabe – localStorage erst im try: Wirft schon der Zugriff (gesperrte Website-Daten), gilt offen und Schreiben wirft nicht; sonst der Speicher des Fensters", () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const restore = () => {
    if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
    else delete globalThis.localStorage;
  };
  try {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new Error("SecurityError: Zugriff verweigert");
      },
    });
    assert.equal(readPanelPreference(), true);
    assert.doesNotThrow(() => writePanelPreference(false));

    const store = new Map();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key) => store.get(key) ?? null,
        setItem: (key, value) => store.set(key, String(value)),
      },
    });
    writePanelPreference(false);
    assert.equal(store.get(PANEL_PREFERENCE_KEY), "closed");
    assert.equal(readPanelPreference(), false);
    // null: ausdrücklich ohne Speicher
    assert.equal(readPanelPreference(null), true);
  } finally {
    restore();
  }
});

test("rc12, K14 / rc13 E13: ANSWER_PURIFY_CONFIG – nur HTML, kein style (Attribut und Element), keine Formulare, Medien, Popover oder Dialoge, keine id/name/role, keine aria- und data-Attribute außer data-search-hit", () => {
  const config = rc13.ANSWER_PURIFY_CONFIG;
  assert.ok(config, "ANSWER_PURIFY_CONFIG fehlt");
  assert.deepEqual(config.USE_PROFILES, { html: true });
  for (const tag of ["style", "form", "input", "button", "textarea", "select", "dialog", "video", "audio", "source", "picture"])
    assert.ok(config.FORBID_TAGS.includes(tag), tag);
  for (const attribute of ["style", "id", "name", "role", "srcset", "background", "poster", "popover", "popovertarget"])
    assert.ok(config.FORBID_ATTR.includes(attribute), attribute);
  assert.equal(config.ALLOW_ARIA_ATTR, false);
  assert.equal(config.ALLOW_DATA_ATTR, false);
  assert.deepEqual(config.ADD_ATTR, ["data-search-hit"]);
  // Die Hervorhebung der Suche setzt genau dieses Attribut
  const doc = createDocument();
  const p = doc.body.appendChild(doc.createElement("p"));
  p.appendChild(doc.createTextNode("Yoga"));
  highlightTextNodes(doc.body, "yoga", doc);
  assert.ok(firstElementWith(doc.body, "data-search-hit"));
});

test("rc12, K14 / rc13 E13: hardenAnswerHtml – Links in neuem Tab mit rel=noopener noreferrer, Bilder laden nicht (im Netz: Link mit Alt-Text, sonst nur der Alt-Text), Klassen nur aus Markdown und Syntaxhervorhebung", () => {
  const { hardenAnswerHtml, ANSWER_LINK_REL } = rc13;
  assert.equal(ANSWER_LINK_REL, "noopener noreferrer");
  const doc = createDocument();
  const root = doc.createElement("body");
  const p = root.appendChild(doc.createElement("p"));
  const link = p.appendChild(doc.createElement("a"));
  link.setAttribute("href", "https://vhs.example/kurs");
  link.setAttribute("target", "_self");
  link.setAttribute("class", "fixed inset-0 z-50");
  link.appendChild(doc.createTextNode("Kursseite"));
  const anchor = p.appendChild(doc.createElement("a"));
  anchor.setAttribute("target", "_top");
  anchor.appendChild(doc.createTextNode("ohne Adresse"));
  const tracker = p.appendChild(doc.createElement("img"));
  tracker.setAttribute("src", "https://tracker.example/pixel.png?admin=1");
  tracker.setAttribute("alt", "Logo der VHS");
  const noAlt = p.appendChild(doc.createElement("img"));
  noAlt.setAttribute("src", "http://bilder.example/a.png");
  const inline = p.appendChild(doc.createElement("img"));
  inline.setAttribute("src", "data:image/png;base64,AAAA");
  inline.setAttribute("alt", "Diagramm");
  const silent = p.appendChild(doc.createElement("img"));
  silent.setAttribute("src", "/relativ.png");
  const pre = root.appendChild(doc.createElement("pre"));
  const code = pre.appendChild(doc.createElement("code"));
  code.setAttribute("class", "language-js hljs absolute");
  const keyword = code.appendChild(doc.createElement("span"));
  keyword.setAttribute("class", "hljs-keyword");

  hardenAnswerHtml(root, doc);

  // keine Bilder mehr
  assert.equal(elements(root, (e) => e.tagName === "IMG").length, 0);
  const links = elements(root, (e) => e.tagName === "A");
  const byText = (text) => links.find((a) => a.textContent === text);
  const kurs = byText("Kursseite");
  assert.equal(kurs.getAttribute("target"), "_blank");
  assert.equal(kurs.getAttribute("rel"), "noopener noreferrer");
  assert.equal(kurs.getAttribute("class"), null, "Seitenklassen entfernt");
  const plain = byText("ohne Adresse");
  assert.equal(plain.getAttribute("target"), null);
  assert.equal(plain.getAttribute("rel"), null);
  const image = byText("Logo der VHS");
  assert.ok(image, "Bild als Link mit Alt-Text");
  assert.equal(image.getAttribute("href"), "https://tracker.example/pixel.png?admin=1");
  assert.equal(image.getAttribute("target"), "_blank");
  assert.equal(image.getAttribute("rel"), "noopener noreferrer");
  assert.ok(byText("http://bilder.example/a.png"), "ohne Alt-Text: die Adresse");
  // eingebettet oder relativ: kein Link, nur der Alt-Text (ohne: nichts)
  assert.ok(!links.some((a) => (a.getAttribute("href") ?? "").startsWith("data:")));
  assert.ok(!links.some((a) => a.getAttribute("href") === "/relativ.png"));
  assert.match(p.textContent, /Diagramm/);
  // Klassen aus Markdown und highlight.js bleiben
  assert.equal(code.getAttribute("class"), "language-js hljs");
  assert.equal(keyword.getAttribute("class"), "hljs-keyword");
});

test("rc12, K14 / rc13 E13: Der Verlauf der Konversationen bereinigt Antworten mit sanitizeAnswerHtml (eigene DOMPurify-Instanz mit ANSWER_PURIFY_CONFIG und hardenAnswerHtml) – nicht mit der gemeinsamen Einstellung des Chats", () => {
  const renderer = readFileSync(
    new URL(
      "../src/pages/GeneralSettings/ChatEmbedWidgets/EmbedAnalytics/MarkdownRenderer.jsx",
      import.meta.url
    ),
    "utf8"
  );
  assert.ok(renderer.includes('from "@/utils/chat/purifyConversation"'));
  assert.ok(!renderer.includes('from "@/utils/chat/purify"'));
  assert.ok(!/DOMPurify\.sanitize/.test(renderer));
  const sanitizer = readFileSync(
    new URL("../src/utils/chat/purifyConversation.js", import.meta.url),
    "utf8"
  );
  assert.ok(sanitizer.includes("createDOMPurify("));
  assert.ok(sanitizer.includes("...ANSWER_PURIFY_CONFIG"));
  assert.ok(sanitizer.includes("RETURN_DOM: true"));
  assert.ok(sanitizer.includes("hardenAnswerHtml(body, body.ownerDocument)"));
  // Die gemeinsame Einstellung des Chats bleibt unverändert
  const shared = readFileSync(
    new URL("../src/utils/chat/purify.js", import.meta.url),
    "utf8"
  );
  assert.match(shared, /ADD_ATTR: \["target", "rel"\]/);
});
