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
  HOLD_SCROLL_MAX_MS,
  HOLD_SCROLL_QUIET_MS,
  PANEL_MIN_BODY,
  PANEL_MIN_HEIGHT,
  SEARCH_MAX_LENGTH,
  ancestorsOf,
  answerText,
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
  hasVisibleHit,
  highlightParts,
  highlightTextNodes,
  holdScrollTarget,
  isWide,
  longDateLabel,
  outsidePeriod,
  panelChromeHeight,
  panelFit,
  revealMarkedRow,
  sameBerlinDays,
  searchLinkIssue,
  searchPattern,
  shortDayLabel,
  shortId,
  startedOnOtherDay,
  visibleAnswerText,
} from "../src/utils/conversationView.js";
import { formatDateForInput as berlinDay } from "../src/utils/billingDate.js";
import { formatDateTimeDE } from "../src/utils/dateTimeDE.js";
import serverSearch from "../../server/utils/helpers/chat/conversationSearch.js";
import { createDocument, elements } from "./helpers/testDom.mjs";

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

test("Außerhalb des Zeitraums: keine Nachricht darin (Grenzen eingeschlossen); „Gesamt“ nie", () => {
  const messages = [{ createdAt: "2026-08-01T10:00:00.000Z" }];
  const period = ["2026-09-01T00:00:00.000Z", "2026-09-30T23:59:59.999Z"];
  assert.equal(outsidePeriod(messages, ...period), true);
  assert.equal(
    outsidePeriod(
      [...messages, { createdAt: "2026-09-30T23:59:59.999Z" }],
      ...period
    ),
    false
  );
  assert.equal(outsidePeriod(messages, null, null), false);
  assert.equal(outsidePeriod([], ...period), false);
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
  const october = {
    startDate: "2026-09-30T22:00:00.000Z",
    endDate: "2026-10-31T22:59:59.999Z",
  };
  // Im Oktober trifft „spanisch" nur die Link-Adresse – die sichtbare Frage
  // aus dem Juli hat der Server nicht durchsucht: Hinweis.
  assert.equal(hasVisibleHit(messages, "spanisch", october), false);
  // ganze Konversation (Abschnitt) oder ohne Zeitraum: sichtbar
  assert.equal(hasVisibleHit(messages, "spanisch", {}), true);
  assert.equal(hasVisibleHit(messages, "spanisch"), true);
  assert.equal(
    hasVisibleHit(messages, "spanisch", { startDate: null, endDate: null }),
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

test("Fixliste 3, V3/V8: Höhe des Seitenpanels – es endet über dem unteren Fensterrand, wo immer es steht; steht es zu tief, wird es beim Öffnen geholt", () => {
  // oben klebend (80 px): wie bisher 100vh - 112 px
  assert.deepEqual(panelFit(80, 900), { maxHeight: 788, reveal: false });
  // nach dem Sprung zur Liste tiefer (B5: 124 px) – die Fußzeile bleibt im
  // Fenster (vorher 788 px, Unterkante bei 912)
  assert.deepEqual(panelFit(124, 900), { maxHeight: 744, reveal: false });
  assert.ok(124 + panelFit(124, 900).maxHeight <= 900 - 32);
  // höher als die Klebekante gibt es nicht (beim Scrollen): wie oben
  assert.deepEqual(panelFit(10, 900), { maxHeight: 788, reveal: false });
  // weit unten (wenige Treffer): nie niedriger als 240 px, und beim Öffnen
  // sind weniger als 320 px zu sehen – holen
  assert.deepEqual(panelFit(700, 900), { maxHeight: 240, reveal: true });
  assert.equal(panelFit(580, 900).reveal, false);
  assert.equal(panelFit(581, 900).reveal, true);
  // ohne Maße (kein Layout): nichts
  assert.equal(panelFit(undefined, 900), null);
  assert.equal(panelFit(100, undefined), null);
});

test("Fixliste 3, S4: isWide – eine Stelle für die Breitenprüfung, auch ohne matchMedia", () => {
  const original = globalThis.window;
  try {
    globalThis.window = undefined;
    assert.equal(isWide(), false);
    globalThis.window = {};
    assert.equal(isWide(), false);
    globalThis.window = {
      matchMedia: (query) => ({ matches: query === "(min-width: 1024px)" }),
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

test("Fixliste 4, V3: panelFit – am Seitenende endet das Panel über der Unterkante seines Bereichs und bleibt so unter dem Benutzermenü", () => {
  // Bereich reicht weit nach unten: wie bisher (32 px über dem Fensterrand)
  assert.deepEqual(panelFit(80, 900, 2000), { maxHeight: 788, reveal: false });
  // ganz unten gescrollt, kurze Liste: Unter dem Bereich liegen 64 px Rand –
  // das Panel endet an seiner Unterkante (836) und steht bei 80, nicht bei
  // 47 unter dem Benutzermenü
  const fit = panelFit(47, 900, 836);
  assert.deepEqual(fit, { maxHeight: 756, reveal: false });
  assert.ok(80 + fit.maxHeight <= 836);
  // noch nicht klebend: Die Unterkante des Fensters bleibt maßgeblich
  assert.deepEqual(panelFit(300, 900, 1088), { maxHeight: 568, reveal: false });
  // ohne gültige Unterkante: ohne diese Grenze
  for (const bottom of [undefined, NaN, null])
    assert.deepEqual(panelFit(80, 900, bottom), {
      maxHeight: 788,
      reveal: false,
    });
  // nie niedriger als 240 px
  assert.equal(panelFit(80, 900, 200).maxHeight, 240);
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
    assert.deepEqual(
      timers.map((timer) => timer.ms),
      [HOLD_SCROLL_MAX_MS]
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

test("Fixliste 5, S5: panelFit – nie niedriger als Kopf und Fußzeile mit einem Rest Verlauf; die Fußzeile bleibt im Panelrahmen", () => {
  // Kopf 196 px (schmales Panel, Frage über zwei Zeilen), Fußzeile 49 px
  const min = panelChromeHeight(196, 49);
  assert.equal(min, 196 + 49 + PANEL_MIN_BODY + 2);
  // Panel weit unten (Mindesthöhe 240 reichte nicht): so hoch wie nötig
  assert.equal(panelFit(700, 900, undefined, min).maxHeight, min);
  assert.ok(min > PANEL_MIN_HEIGHT);
  // sonst wie bisher
  assert.equal(panelFit(300, 900, undefined, min).maxHeight, 568);
  assert.equal(panelFit(700, 900).maxHeight, PANEL_MIN_HEIGHT);
  // ohne Fußzeile (Konversation lädt) und ohne gemessenen Kopf
  assert.equal(panelChromeHeight(120, undefined), 120 + PANEL_MIN_BODY + 2);
  assert.equal(panelChromeHeight(0, 49), 0);
  assert.equal(panelChromeHeight(undefined, 49), 0);
  assert.equal(panelFit(700, 900, undefined, NaN).maxHeight, PANEL_MIN_HEIGHT);
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

test("Fixliste 6, N1: sameBerlinDays – Liste und Zählerbuch decken dieselben Berliner Tage nur bei Berliner Tagesgrenzen; „Gesamt“ immer", () => {
  // Browser in Berlin: 00:00 bis 23:59:59,999 Uhr Berliner Zeit
  assert.equal(
    sameBerlinDays(
      "2026-09-12T22:00:00.000Z",
      "2026-10-13T21:59:59.999Z",
      "2026-09-13",
      "2026-10-13"
    ),
    true
  );
  // über die Zeitumstellung (29.03.2026: Beginn UTC+1, Ende UTC+2)
  assert.equal(
    sameBerlinDays(
      "2026-03-27T23:00:00.000Z",
      "2026-03-29T21:59:59.999Z",
      "2026-03-28",
      "2026-03-29"
    ),
    true
  );
  // Browser in UTC bzw. New York: Grenzen um Stunden verschoben
  assert.equal(
    sameBerlinDays(
      "2026-09-13T00:00:00.000Z",
      "2026-10-13T23:59:59.999Z",
      "2026-09-13",
      "2026-10-13"
    ),
    false
  );
  assert.equal(
    sameBerlinDays(
      "2026-09-13T04:00:00.000Z",
      "2026-10-14T03:59:59.999Z",
      "2026-09-13",
      "2026-10-13"
    ),
    false
  );
  // andere Tage, fehlende Millisekunden, halbe Angaben
  assert.equal(
    sameBerlinDays(
      "2026-09-12T22:00:00.000Z",
      "2026-10-13T21:59:59.999Z",
      "2026-09-14",
      "2026-10-13"
    ),
    false
  );
  assert.equal(
    sameBerlinDays(
      "2026-09-12T22:00:00.000Z",
      "2026-10-13T21:59:59.000Z",
      "2026-09-13",
      "2026-10-13"
    ),
    false
  );
  assert.equal(
    sameBerlinDays("2026-09-12T22:00:00.000Z", null, "2026-09-13", null),
    false
  );
  assert.equal(
    sameBerlinDays("kein Datum", "2026-10-13T21:59:59.999Z", "a", "b"),
    false
  );
  // „Gesamt“: Die Liste hat keine Grenzen, reicht also mindestens so weit
  assert.equal(sameBerlinDays(null, null, null, null), true);
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

test("Fixliste 6, K5: revealMarkedRow – die markierte Zeile unter dem Fensterrand (Zeile 45) kommt mit „nearest“ in Sicht; im Bild bleibt alles stehen", () => {
  const doc = createDocument();
  const root = doc.body.appendChild(doc.createElement("div"));
  const makeRow = (id, top, current = false) => {
    const row = root.appendChild(doc.createElement("button"));
    row.setAttribute("data-conversation-row", String(id));
    if (current) row.setAttribute("aria-current", "true");
    row.getBoundingClientRect = () => ({ top, bottom: top + 54 });
    row.scrolls = [];
    row.scrollIntoView = (options) => row.scrolls.push(options);
    return row;
  };
  // Ein anderes Element mit aria-current zählt nicht.
  const other = root.appendChild(doc.createElement("a"));
  other.setAttribute("aria-current", "true");
  other.getBoundingClientRect = () => ({ top: 5000, bottom: 5020 });
  other.scrollIntoView = () => assert.fail("kein Sprung zu anderen Elementen");

  makeRow(1, 300);
  const deep = makeRow(45, 2941, true);
  assert.equal(revealMarkedRow(root, 900), true);
  assert.deepEqual(deep.scrolls, [{ block: "nearest" }]);

  // im freien Bereich: nichts (Zeile 3 nach dem Sprung zur Überschrift)
  deep.removeAttribute("aria-current");
  const near = makeRow(3, 387, true);
  assert.equal(revealMarkedRow(root, 900), false);
  assert.deepEqual(near.scrolls, []);
  // knapp unter der Grenze (Fenster − 32 px) bzw. über PANEL_STUCK_TOP (80)
  near.getBoundingClientRect = () => ({ top: 820, bottom: 874 });
  assert.equal(revealMarkedRow(root, 900), true);
  near.getBoundingClientRect = () => ({ top: 60, bottom: 114 });
  assert.equal(revealMarkedRow(root, 900), true);
  assert.equal(near.scrolls.length, 2);

  // ohne markierte Zeile, ohne Bereich, ohne Fensterhöhe: nichts
  near.removeAttribute("aria-current");
  assert.equal(revealMarkedRow(root, 900), false);
  assert.equal(revealMarkedRow(null, 900), false);
  assert.equal(revealMarkedRow(root, NaN), false);
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
