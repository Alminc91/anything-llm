/* eslint-env jest, node */
// KIE-576 AK-21 (E38): Kurslink nachschlagen. Verlinkt das Modell einen
// Kurstitel auf eine Adresse, die kein Kurs-Link ist (etwa eine gecrawlte
// Kategorieseite), setzt der Prüfer den Kurs-Link aus course_links, wenn
// Titel und Merkmale danach genau einen Kurs treffen. Sonst bleibt der Link
// unverändert (NAK-11). Gehalten wird nur bei mehreren Kandidaten (NAK-10).
// Stream (jede Aufteilung), Antwort ohne Streaming und Speichern
// (parseCardsReply) entscheiden gleich.

jest.mock("../../../utils/prisma", () => ({}));

const { performance } = require("node:perf_hooks");
const {
  parseCardsReply,
  __test__: {
    CardsMarkerFilter,
    OverviewLinkFilter,
    COURSE_WINDOW,
    courseWindowEnd,
  },
} = require("../../../utils/chats/embedCardsMarker");
const {
  applyCategoryChains,
  createOverviewLinkGuard,
  buildChainedContext,
  validateCategoryMapSetting,
  __test__: chains,
} = require("../../../utils/chats/embedCategoryChains");

const HOST = "https://www.vhs-beispiel.de";
const SPORT_URL = `${HOST}/kursprogramm/sport`;
const YOGA_URL = `${HOST}/kursprogramm/sport/yoga`;
const OVERVIEW_PAGE = `${HOST}/kursprogramm/sport/uebersicht`;
const CONTEXT_COURSE_URL = `${HOST}/kurssuche/kurs/hatha-yoga/26100-001`;
const kurs = (n) => `${HOST}/kurssuche/kurs/k/${n}`;

const NODES = {
  Sport: { title: "Sport", url: SPORT_URL, count: 40 },
  "Sport \\ Yoga": { title: "Yoga", url: YOGA_URL, count: 3 },
};
const COURSE_LINKS = {
  "26100-001": {
    title: "Hatha-Yoga",
    start: "2026-01-05T18:00",
    place: "Lingen",
    url: CONTEXT_COURSE_URL,
  },
  "26200-010": {
    title: "Yoga am Morgen",
    start: "2026-01-12T09:00",
    place: "Lingen",
    url: kurs("26200-010"),
  },
  // gleicher Titel, anderes Datum
  "26200-020": {
    title: "Pilates",
    start: "2026-02-02T18:00",
    place: "Lingen",
    url: kurs("26200-020"),
  },
  "26200-021": {
    title: "Pilates",
    start: "2026-02-09T18:00",
    place: "Lingen",
    url: kurs("26200-021"),
  },
  // gleicher Titel und Tag, andere Zeit
  "26200-025": {
    title: "Faszientraining",
    start: "2026-02-10T09:00",
    place: "Lingen",
    url: kurs("26200-025"),
  },
  "26200-026": {
    title: "Faszientraining",
    start: "2026-02-10T18:30",
    place: "Lingen",
    url: kurs("26200-026"),
  },
  // gleicher Tag, einmal ohne Beginnzeit
  "26200-027": {
    title: "Kräuterkunde",
    start: "2026-07-01T18:00",
    place: "Lingen",
    url: kurs("26200-027"),
  },
  "26200-028": {
    title: "Kräuterkunde",
    start: "2026-07-01",
    place: "Lingen",
    url: kurs("26200-028"),
  },
  // gleicher Titel und Beginn, anderer Ort
  "26200-030": {
    title: "Zumba®",
    start: "2026-03-03T19:00",
    place: "Lingen",
    url: kurs("26200-030"),
  },
  "26200-031": {
    title: "Zumba®",
    start: "2026-03-03T19:00",
    place: "Meppen",
    url: kurs("26200-031"),
  },
  // gleicher Titel, Beginn und Ort
  "26200-040": {
    title: "Qigong",
    start: "2026-04-01T10:00",
    place: "Lingen",
    url: kurs("26200-040"),
  },
  "26200-041": {
    title: "Qigong",
    start: "2026-04-01T10:00",
    place: "Lingen",
    url: kurs("26200-041"),
  },
  // Nulldatum 1899 kommt laut Vertrag nicht, hier zur Sicherheit
  "26200-050": {
    title: "Rückenfit",
    start: "1899-12-30T18:30",
    place: "Lingen",
    url: kurs("26200-050"),
  },
  "26200-051": {
    title: "Rückenfit",
    start: "2026-05-11",
    place: "Lingen",
    url: kurs("26200-051"),
  },
  // Anführungszeichen und Striche im Titel
  "26200-060": {
    title: "„Yoga – sanft“ für Ältere",
    start: "2026-06-01",
    url: kurs("26200-060"),
  },
};

const mapJson = (extra = { course_links: COURSE_LINKS }) =>
  JSON.stringify({
    version: 1,
    client: "vhs-beispiel",
    created: new Date().toISOString(),
    nodes: NODES,
    courses: {},
    ...extra,
  });
const MAP = chains.parseCategoryMap(mapJson());
const MAP_PLAIN = chains.parseCategoryMap(mapJson({}));

const courseDoc = (title, number, path, link) =>
  [
    "<document_metadata>",
    "sourceDocument: kurs.txt",
    "</document_metadata>",
    "",
    `Titel: ${title}`,
    `Kursnummer: ${number}`,
    `Kategoriepfad: ${path}`,
    `Kurs-Link: ${link}`,
  ].join("\n");
const contextFor = (map) =>
  applyCategoryChains(
    [
      courseDoc("Hatha-Yoga", "26100-001", "Sport \\ Yoga", CONTEXT_COURSE_URL),
      `<document_metadata>\nsource: ${OVERVIEW_PAGE}\n</document_metadata>\n\nYoga am Morgen, Pilates, Qigong`,
    ],
    map
  );
const guardFor = (map) =>
  createOverviewLinkGuard({ contextTexts: contextFor(map), map });
const GUARD = guardFor(MAP);
const GUARD_PLAIN = guardFor(MAP_PLAIN);

// Eintrag nach dem Kursschema des Prompts
const entry = (n, title, url, { beginn, ort, kurs: number } = {}) =>
  [
    `**${n}.** [**${title}**](${url})`,
    "  Ein schöner Kurs für alle.",
    ...(beginn ? [`  **Beginn:** ${beginn} | 10x`] : []),
    ...(ort ? [`  **Ort:** ${ort} | Leitung: Anna Muster`] : []),
    ...(number ? [`  **Preis:** 85,00 € | **Kurs:** ${number}`] : []),
    "  **Status:** Anmeldung möglich",
  ].join("\n");
const reply = (...entries) =>
  [
    "Hier sind passende Kurse:",
    "",
    entries.join("\n\n"),
    "",
    "Viel Spaß!",
  ].join("\n");

function streamed(text, size, overviewLinks = GUARD) {
  const filter = new CardsMarkerFilter({ overviewLinks });
  let out = "";
  for (let i = 0; i < text.length; i += size)
    out += filter.push(text.slice(i, i + size)).text;
  return out + filter.push("", { final: true }).text;
}

// Stream mit jeder Schnittstelle, mehreren Stückgrößen, ohne Streaming und
// gespeichert: genau ein Ergebnis
function allPaths(text, overviewLinks = GUARD) {
  const outs = new Set();
  for (let cut = 0; cut <= text.length; cut++) {
    const filter = new CardsMarkerFilter({ overviewLinks });
    const a = filter.push(text.slice(0, cut)).text;
    const b = filter.push(text.slice(cut), { final: true }).text;
    outs.add(a + b);
  }
  for (const size of [1, 2, 3, 5, 7, 13, 64])
    outs.add(streamed(text, size, overviewLinks));
  outs.add(parseCardsReply(text, { overviewLinks }).text);
  return outs;
}

function expectAll(text, expected, overviewLinks = GUARD) {
  expect([...allPaths(text, overviewLinks)]).toEqual([expected]);
}

describe("AK-21 Kurslink nachschlagen", () => {
  test("eindeutiger Titel auf Kategorieseite: Kurs-Link, Linktext bleibt", () => {
    const text = reply(
      entry(1, "Yoga am Morgen", YOGA_URL, { beginn: "Mo. 12.01.2026, 09:00" })
    );
    expectAll(text, text.replace(YOGA_URL, kurs("26200-010")));
  });

  test("eindeutiger Titel auf erfundener Adresse und im Fließtext", () => {
    const text = `Probieren Sie [Yoga am Morgen](${HOST}/erfunden) aus.`;
    expectAll(
      text,
      `Probieren Sie [Yoga am Morgen](${kurs("26200-010")}) aus.`
    );
  });

  test("Normalisierung: Groß/klein, Leerraum, Anführungszeichen, Striche, Nummerierung", () => {
    const text = [
      `[**  YOGA   am morgen **](${OVERVIEW_PAGE})`,
      `[1. Yoga am Morgen](${OVERVIEW_PAGE})`,
      `["Yoga - sanft" für Ältere](${OVERVIEW_PAGE})`,
    ].join("\n");
    expectAll(
      text,
      [
        `[**  YOGA   am morgen **](${kurs("26200-010")})`,
        `[1. Yoga am Morgen](${kurs("26200-010")})`,
        `["Yoga - sanft" für Ältere](${kurs("26200-060")})`,
      ].join("\n")
    );
  });

  test("zwei gleiche Titel, verschiedenes Datum: Datum entscheidet (jede Aufteilung)", () => {
    const text = reply(
      entry(1, "Pilates", OVERVIEW_PAGE, {
        beginn: "Mo. 09.02.2026, 18:00 - 19:30 Uhr",
        ort: "Lingen",
      }),
      entry(2, "Pilates", OVERVIEW_PAGE, {
        beginn: "Mo. 02.02.26, 18.00 Uhr",
      })
    );
    const expected = text
      .replace(OVERVIEW_PAGE, kurs("26200-021"))
      .replace(OVERVIEW_PAGE, kurs("26200-020"));
    expectAll(text, expected);
  });

  test("Datum mit Monatsnamen und ohne Jahr", () => {
    const text = [
      entry(1, "Pilates", OVERVIEW_PAGE, { beginn: "Montag, 9. Februar 2026" }),
      "",
      entry(2, "Pilates", OVERVIEW_PAGE, { beginn: "Mo., 02.02." }),
    ].join("\n");
    const expected = text
      .replace(OVERVIEW_PAGE, kurs("26200-021"))
      .replace(OVERVIEW_PAGE, kurs("26200-020"));
    expectAll(text, expected);
  });

  test("gleicher Tag, verschiedene Beginnzeit: Zeit entscheidet", () => {
    const text = reply(
      entry(1, "Faszientraining", OVERVIEW_PAGE, {
        beginn: "Di. 10.02.2026, 18:30 - 20:00 Uhr",
      })
    );
    expectAll(text, text.replace(OVERVIEW_PAGE, kurs("26200-026")));
  });

  test("NAK-11: Zahl wie Raum 1.01 schließt keinen Kandidaten aus, Kandidat ohne Zeit bleibt im Zweifel", () => {
    const room = reply(
      entry(1, "Kräuterkunde", OVERVIEW_PAGE, {
        beginn: "Mi. 01.07.2026",
        ort: "Raum 1.01",
      })
    );
    expectAll(room, room);
    const timed = reply(
      entry(1, "Kräuterkunde", OVERVIEW_PAGE, {
        beginn: "Mi. 01.07.2026, 18:00 Uhr",
      })
    );
    expectAll(timed, timed);
  });

  test("gleicher Titel und Beginn, verschiedener Ort: Ort entscheidet", () => {
    const text = reply(
      entry(1, "Zumba®", OVERVIEW_PAGE, {
        beginn: "Di. 03.03.2026, 19:00 Uhr",
        ort: "VHS-Haus, Meppen",
      })
    );
    expectAll(text, text.replace(OVERVIEW_PAGE, kurs("26200-031")));
  });

  test("gleicher Titel, Beginn und Ort: unverändert; mit Kursnummer eindeutig", () => {
    const without = reply(
      entry(1, "Qigong", OVERVIEW_PAGE, {
        beginn: "Mi. 01.04.2026, 10:00 Uhr",
        ort: "Lingen",
      })
    );
    expectAll(without, without);
    const withNumber = reply(
      entry(1, "Qigong", OVERVIEW_PAGE, {
        beginn: "Mi. 01.04.2026, 10:00 Uhr",
        ort: "Lingen",
        kurs: "26200-041",
      })
    );
    expectAll(withNumber, withNumber.replace(OVERVIEW_PAGE, kurs("26200-041")));
  });

  test("NAK-11: Datum keines Kandidaten oder keine Merkmale: unverändert", () => {
    const otherDate = reply(
      entry(1, "Pilates", OVERVIEW_PAGE, { beginn: "Mo. 16.03.2026, 18:00" })
    );
    expectAll(otherDate, otherDate);
    const noFeatures = reply(entry(1, "Pilates", OVERVIEW_PAGE));
    expectAll(noFeatures, noFeatures);
  });

  test("NAK-11: Kandidat ohne Beginndatum gilt bei genanntem Datum nicht als Treffer", () => {
    // Kurs aus einer alten Übersicht, den der Feed nicht mehr hat
    const text = reply(
      entry(1, "Rückenfit", OVERVIEW_PAGE, { beginn: "Mo. 16.03.2026" })
    );
    expectAll(text, text);
    const dated = reply(
      entry(1, "Rückenfit", OVERVIEW_PAGE, { beginn: "Mo. 11.05.2026" })
    );
    expectAll(dated, dated.replace(OVERVIEW_PAGE, kurs("26200-051")));
  });

  test("Merkmale nur bis zum nächsten Link bzw. zur Leerzeile", () => {
    // Eintrag 1 ohne Datum, das Datum von Eintrag 2 zählt nicht für ihn
    const text = [
      `1. [**Pilates**](${OVERVIEW_PAGE})`,
      `2. [**Pilates**](${OVERVIEW_PAGE}) **Beginn:** 09.02.2026`,
      "",
      `3. [**Pilates**](${OVERVIEW_PAGE})`,
      "",
      "**Beginn:** 02.02.2026",
    ].join("\n");
    const expected = text.replace(
      `2. [**Pilates**](${OVERVIEW_PAGE})`,
      `2. [**Pilates**](${kurs("26200-021")})`
    );
    expectAll(text, expected);
  });

  test("Merkmale höchstens COURSE_WINDOW Zeichen nach dem Link", () => {
    const long = "x".repeat(COURSE_WINDOW);
    const text = `[Pilates](${OVERVIEW_PAGE}) ${long} 09.02.2026`;
    expectAll(text, text);
    expect(courseWindowEnd(`ab${long}`, 2, false)).toBe(2 + COURSE_WINDOW);
    expect(courseWindowEnd("ab\n  ", 2, false)).toBe(-1);
    expect(courseWindowEnd("ab\n  \nc", 2, false)).toBe(2);
    expect(courseWindowEnd("ab\n  x", 2, false)).toBe(-1);
    expect(courseWindowEnd("ab\n  x", 2, true)).toBe(6);
  });

  test("kein Treffer und übersetzter Titel: unverändert", () => {
    const text = [
      `1. [**Aquarellmalen**](${OVERVIEW_PAGE})`,
      `2. [**Morning Yoga**](${OVERVIEW_PAGE})`,
      `3. [**Yoga am Morgen für Fortgeschrittene**](${OVERVIEW_PAGE})`,
    ].join("\n");
    expectAll(text, text);
  });

  test("Link ist schon ein Kurs-Link (Kontext oder course_links): unverändert", () => {
    const text = [
      `1. [**Yoga am Morgen**](${CONTEXT_COURSE_URL})`,
      `2. [**Pilates**](${kurs("26200-020")}) **Beginn:** 09.02.2026`,
      `3. [**Yoga am Morgen**](${kurs("26200-041").toUpperCase()})`,
    ].join("\n");
    expectAll(text, text);
  });

  test("Kategorie-Link mit Knotentitel bleibt Regel 1, nicht AK-21", () => {
    const map = chains.parseCategoryMap(
      mapJson({
        course_links: {
          "26300-001": { title: "Yoga", url: kurs("26300-001") },
        },
      })
    );
    const text = `Mehr unter [Yoga](${YOGA_URL}).`;
    expectAll(text, text, guardFor(map));
  });

  test("Link in Übersichtszeile und -block: nie AK-21, wie ohne course_links", () => {
    const text = [
      `Mehr Kurse zum Thema: [Yoga am Morgen](${YOGA_URL})`,
      "",
      "Mehr Kurse zum Thema:",
      `- [Yoga am Morgen](${OVERVIEW_PAGE})`,
      `- [Pilates](${SPORT_URL})`,
      "",
      `[**Alle Kurse in Yoga am Morgen**](${YOGA_URL})`,
    ].join("\n");
    const plain = [...allPaths(text, GUARD_PLAIN)];
    expect(plain).toHaveLength(1);
    expect(plain[0]).not.toContain("/kurssuche/");
    expectAll(text, plain[0]);
  });

  test("Karte ohne course_links: Ergebnis wie vorher (Regel 1 bzw. unverändert)", () => {
    expect(MAP_PLAIN.courseTitles.size).toBe(0);
    const text = reply(
      entry(1, "Yoga am Morgen", YOGA_URL, { beginn: "12.01.2026" }),
      entry(2, "Pilates", OVERVIEW_PAGE, { beginn: "09.02.2026" })
    );
    // vorher: Knoten-Link bekommt Titel der Karte (R1-D1 Regel 1), sonst
    // bleibt alles
    expectAll(
      text,
      text.replace(`[**Yoga am Morgen**](${YOGA_URL})`, `[Yoga](${YOGA_URL})`),
      GUARD_PLAIN
    );
  });

  test("Kurskarten-Modus (R1-D4): keine Karte, kein Prüfer, Antwort unverändert", async () => {
    const chained = await buildChainedContext(
      ["a"],
      { contextTexts: ["b"] },
      { enabled: false }
    );
    expect(chained.map).toBeNull();
    const guard = createOverviewLinkGuard({
      contextTexts: chained.contextTexts,
      map: chained.map,
    });
    expect(guard).toBeNull();
    const text = reply(entry(1, "Yoga am Morgen", YOGA_URL));
    expect(streamed(text, 3, guard)).toBe(text);
    expect(parseCardsReply(text, { overviewLinks: guard }).text).toBe(text);
  });

  test("NAK-10: eindeutiger oder kein Kandidat sofort, mehrere gehalten bis zu den Merkmalen", () => {
    const filter = new OverviewLinkFilter(GUARD);
    const unique = filter.push(`1. [**Yoga am Morgen**](${YOGA_URL})\n`);
    expect(unique).toBe(`1. [**Yoga am Morgen**](${kurs("26200-010")})\n`);
    const none = filter.push(`2. [**Aquarell**](${OVERVIEW_PAGE})\n`);
    expect(none).toBe(`2. [**Aquarell**](${OVERVIEW_PAGE})\n`);
    const held = filter.push(`3. [**Pilates**](${OVERVIEW_PAGE})\n  Text\n`);
    expect(held).toBe("");
    const more = filter.push("  **Beginn:** 09.02.2026\n");
    expect(more).toBe("");
    const done = filter.push("\n4. Ende");
    expect(done).toBe(
      `3. [**Pilates**](${kurs("26200-021")})\n  Text\n  **Beginn:** 09.02.2026\n\n4. Ende`
    );
  });
});

describe("Vertrag course_links", () => {
  const BROKEN = [
    ["Text", "kaputt"],
    ["Liste", [{ title: "Pilates", url: kurs("1") }]],
    ["Zahl", 3],
    ["null", null],
  ];
  test.each(BROKEN)(
    "course_links als %s: Validator nimmt die Karte, nur das Feld fällt",
    (_name, value) => {
      const raw = mapJson({ course_links: value });
      expect(validateCategoryMapSetting(raw)).toBe(raw);
      const map = chains.parseCategoryMap(raw);
      expect([...map.nodes.keys()]).toEqual([...MAP_PLAIN.nodes.keys()]);
      expect(map.courseTitles.size).toBe(0);
      const text = reply(entry(1, "Yoga am Morgen", YOGA_URL));
      expect(streamed(text, 5, guardFor(map))).toBe(
        streamed(text, 5, GUARD_PLAIN)
      );
    }
  );

  test("ungültige Einträge fallen einzeln, die übrigen bleiben", () => {
    const map = chains.parseCategoryMap(
      mapJson({
        course_links: {
          ok: { title: "Gut", url: kurs("ok"), start: "1899-12-30" },
          js: { title: "Js", url: "javascript:alert(1)" },
          fremd: { title: "Fremd", url: "https://boese.example/kurs/1" },
          leer: { title: "", url: kurs("leer") },
          klammer: { title: "Klammer", url: `${kurs("k")})` },
          text: "kein Objekt",
          zeit: { title: "Zeit", url: kurs("z"), start: "2026-13-01T25:00" },
        },
      })
    );
    expect([...map.courseTitles.keys()].sort()).toEqual(["gut", "zeit"]);
    expect(map.courseTitles.get("gut")[0].date).toBeNull();
    expect(map.courseTitles.get("zeit")[0].date).toBeNull();
    expect(map.courseUrls.has(chains.linkKey(kurs("ok")))).toBe(true);
  });

  test("Host des Kunden: auch ohne www., andere Hosts nicht", () => {
    const map = chains.parseCategoryMap(
      mapJson({
        course_links: {
          a: { title: "A", url: "https://vhs-beispiel.de/kurs/a" },
          b: { title: "B", url: "https://anmeldung.vhs-beispiel.de/kurs/b" },
        },
      })
    );
    expect([...map.courseTitles.keys()]).toEqual(["a"]);
  });

  test("Laufzeit: Nachschlagen unter 1 ms bei 3.000 Kursen", () => {
    const many = {};
    for (let i = 0; i < 3000; i++) {
      const n = `27${String(i).padStart(3, "0")}-001`;
      many[n] = {
        title: `Kurs ${i % 1500}`,
        start: `2026-${String((i % 12) + 1).padStart(2, "0")}-${String((i % 28) + 1).padStart(2, "0")}T18:00`,
        place: i % 2 ? "Lingen" : "Meppen",
        url: kurs(n),
      };
    }
    const map = chains.parseCategoryMap(mapJson({ course_links: many }));
    expect(map.courseTitles.size).toBe(1500);
    const guard = guardFor(map);
    const window =
      "\n  **Beginn:** Di. 14.02.2026, 18:00 Uhr | 10x\n  **Ort:** Lingen\n";
    const runs = 2000;
    let found = 0;
    const t0 = performance.now();
    for (let r = 0; r < runs; r++) {
      const verdict = guard.check(`**Kurs ${r % 1500}**`, OVERVIEW_PAGE);
      if (verdict?.course && guard.pickCourse(verdict.course, window))
        found += 1;
    }
    const perLink = (performance.now() - t0) / runs;
    expect(found).toBeGreaterThan(0);
    expect(perLink).toBeLessThan(1);
  });
});
