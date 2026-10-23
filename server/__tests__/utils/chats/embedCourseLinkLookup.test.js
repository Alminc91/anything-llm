/* eslint-env jest, node */
// KIE-576 AK-21 (E38): Kurslink nachschlagen. Verlinkt das Modell einen
// Kurstitel auf eine Adresse, die kein Kurs-Link ist (etwa eine gecrawlte
// Kategorieseite), setzt der Prüfer den Kurs-Link aus course_links, wenn
// Titel und Merkmale danach genau einen Kurs treffen. Sonst bleibt der Link
// unverändert (NAK-11). Ersetzt wird nur mit Bestätigung (R3-D1): sofort
// über eine Übersichtsseite im Kontext (Stufe 2), sonst nach Halten über
// Beginndatum oder Kursnummer im Text danach.
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

  test("eindeutiger Titel auf erfundener Adresse im Fließtext: nur mit Bestätigung (R3-D1)", () => {
    const bare = `Probieren Sie [Yoga am Morgen](${HOST}/erfunden) aus.`;
    expectAll(bare, bare);
    const dated = `Probieren Sie [Yoga am Morgen](${HOST}/erfunden) ab dem 12.01.2026 aus.`;
    expectAll(
      dated,
      `Probieren Sie [Yoga am Morgen](${kurs("26200-010")}) ab dem 12.01.2026 aus.`
    );
  });

  test("Normalisierung: Groß/klein, Leerraum, Anführungszeichen, Striche, Nummerierung", () => {
    const text = [
      `[**  YOGA   am morgen **](${OVERVIEW_PAGE}) 12.01.2026`,
      `[1. Yoga am Morgen](${OVERVIEW_PAGE}) 12.01.2026`,
      `["Yoga - sanft" für Ältere](${OVERVIEW_PAGE}) 01.06.2026`,
    ].join("\n");
    expectAll(
      text,
      [
        `[**  YOGA   am morgen **](${kurs("26200-010")}) 12.01.2026`,
        `[1. Yoga am Morgen](${kurs("26200-010")}) 12.01.2026`,
        `["Yoga - sanft" für Ältere](${kurs("26200-060")}) 01.06.2026`,
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

  test("Karte ohne course_links: Kurstitel bleiben (R3-D4), Kategorie-Link nach Regel 1", () => {
    expect(MAP_PLAIN.courseTitles.size).toBe(0);
    const text = reply(
      entry(1, "Yoga am Morgen", YOGA_URL, { beginn: "12.01.2026" }),
      entry(2, "Pilates", OVERVIEW_PAGE, { beginn: "09.02.2026" })
    );
    // Kurstitel auf Knotenadresse: Text bleibt (früher Knotentitel „Yoga“)
    expectAll(text, text, GUARD_PLAIN);
    const category = `Mehr unter [YOGA](${YOGA_URL}).`;
    expectAll(category, `Mehr unter [Yoga](${YOGA_URL}).`, GUARD_PLAIN);
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

  test("NAK-10: Stufe 2 oder kein Kandidat sofort, sonst gehalten bis zu den Merkmalen", () => {
    // Übersichtsseite im Kontext nennt „Yoga am Morgen“ mit Beginn
    const guard = createOverviewLinkGuard({
      contextTexts: [
        ...contextFor(MAP),
        `<document_metadata>\nsource: ${OVERVIEW_PAGE}\n</document_metadata>\n\nYoga am Morgen\nMo. 12.01.2026, 09:00 Uhr`,
      ],
      map: MAP,
    });
    const filter = new OverviewLinkFilter(guard);
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
    // eindeutig, aber ohne Übersicht (Kurs-Link nur im Kursdokument):
    // gehalten, ohne Merkmale unverändert
    const single = new OverviewLinkFilter(guard);
    expect(single.push(`[**Hatha-Yoga**](${OVERVIEW_PAGE})\n`)).toBe("");
    expect(single.push("", { final: true })).toBe(
      `[**Hatha-Yoga**](${OVERVIEW_PAGE})\n`
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

// KIE-576 Runde 3 (R3-D1 bis R3-D4) mit Fällen aus der Messung AK-21
// (fixtures/courseLinkLookupR3.json, nur die nötigen Zeilen)
const R3 = require("./fixtures/courseLinkLookupR3.json");
const r3Map = (client, { links = true } = {}) =>
  chains.parseCategoryMap(
    JSON.stringify({
      version: 1,
      client: "messung",
      created: new Date().toISOString(),
      nodes: client.nodes,
      courses: {},
      ...(links ? { course_links: client.course_links } : {}),
    })
  );
const r3Guard = (client, contextTexts = [], options) => {
  const map = r3Map(client, options);
  return createOverviewLinkGuard({
    contextTexts: applyCategoryChains(contextTexts, map),
    map,
  });
};
const LIN = R3.lingen;
const ALT = R3.altoetting;
const MAR = R3.marburg;
const linUrl = (n) => LIN.course_links[n].url;
const altUrl = (n) => ALT.course_links[n].url;
const marUrl = (n) => MAR.course_links[n].url;
const linkOf = (text) => /\]\((\S+?)\)/.exec(text)[1];
const NEUE_ANGEBOTE = `${"https://www.vhs-lingen.de"}/programm/neue-angebote/kategorie/356`;
// Kursdokument im Kontext (mit Kurs-Link), wie es die Suche liefert
const ZUMBA_DOC = [
  "<document_metadata>",
  "sourceDocument: kurs.txt",
  "</document_metadata>",
  "",
  "Titel: Zumba®",
  "Kursnummer: 2026H96580",
  "Beginn: Do. 29.10.2026, 18:30 Uhr",
  "Kategoriepfad: Gesundheit \\ Bewegung",
  `Kurs-Link: ${linUrl("2026H96580")}`,
].join("\n");
// Übersichtsseite im Kontext: Titel, darunter Datum (Form der Lingen-Seiten)
const overviewDoc = (...rows) =>
  [
    "<document_metadata>",
    `source: ${NEUE_ANGEBOTE}`,
    "</document_metadata>",
    "",
    ...rows.flatMap(([title, when, nr]) => [
      title,
      " ",
      "Wann:",
      `${when} `,
      "Nr.:",
      `${nr} `,
      "Status:",
      "Plätze frei",
    ]),
  ].join("\n");

describe("R3-1 (B1, R3-D1): Bestätigung auch bei nur einem Kandidaten", () => {
  test("lin-13: Nummer und Datum widersprechen dem einzigen Kandidaten: unverändert", () => {
    const guard = r3Guard(LIN, [ZUMBA_DOC, LIN.overview]);
    for (const id of ["lin-13-2", "lin-13-knr"]) {
      const text = reply(LIN.entries[id]);
      expectAll(text, text, guard);
    }
  });

  test("lin-23: Kursnummer im Text und in der Adresse gehört zu einem anderen Kurs: unverändert", () => {
    const guard = r3Guard(LIN, [LIN.overview]);
    const text = reply(LIN.entries["lin-23-3"]);
    expectAll(text, text, guard);
    // auch ohne Kontext
    expectAll(text, text, r3Guard(LIN));
  });

  test("nur ein Merkmal widerspricht (Datum oder Nummer): unverändert", () => {
    const guard = r3Guard(LIN);
    const otherDate = reply(
      `[**Zumba®**](${NEUE_ANGEBOTE})\n**Beginn:** Do. 03.09.2026\n**Kurs:** 2026H96580`
    );
    expectAll(otherDate, otherDate, guard);
    const otherNumber = reply(
      `[**Zumba®**](${NEUE_ANGEBOTE})\n**Beginn:** Do. 29.10.2026\n**Kurs:** 2026H96570`
    );
    expectAll(otherNumber, otherNumber, guard);
  });

  test("einziger Kandidat: Bestätigung über die Nummer allein oder das Datum allein, ohne Bestätigung unverändert", () => {
    const guard = r3Guard(LIN);
    const bare = `Probieren Sie [Zumba®](${NEUE_ANGEBOTE}) aus.`;
    expectAll(bare, bare, guard);
    const byNumber = reply(
      `[**Zumba®**](${NEUE_ANGEBOTE})\n  Tanzen Sie sich fit.\n  **Kurs:** 2026H96580`
    );
    expectAll(
      byNumber,
      byNumber.replace(NEUE_ANGEBOTE, linUrl("2026H96580")),
      guard
    );
    const byDate = reply(
      `[**Zumba®**](${NEUE_ANGEBOTE})\n  **Beginn:** Do. 29.10.2026, 18:30 Uhr`
    );
    expectAll(
      byDate,
      byDate.replace(NEUE_ANGEBOTE, linUrl("2026H96580")),
      guard
    );
  });

  test("Stufe 2: Kandidat mit Titel und Beginn in einer Übersicht der Anfrage: sofort ersetzt; nicht bei anderem Datum derselben Quelle", () => {
    const overview = overviewDoc(
      [
        "Sommer-VHS: Zumba® für Kinder (8-11 Jahre)",
        "Mi. 19.08.2026, 17.00 Uhr",
        "2026H96560",
      ],
      ["Zumba®", "Do. 29.10.2026, 18.30 Uhr", "2026H96580"]
    );
    const guard = r3Guard(LIN, [overview]);
    const text = `Probieren Sie [Zumba®](${NEUE_ANGEBOTE}) aus.`;
    const expected = `Probieren Sie [Zumba®](${linUrl("2026H96580")}) aus.`;
    expectAll(text, expected, guard);
    // NAK-10: nach „)“ sofort gesendet, nichts gehalten
    const filter = new OverviewLinkFilter(guard);
    expect(filter.push(`1. [**Zumba®**](${NEUE_ANGEBOTE})`)).toBe(
      `1. [**Zumba®**](${linUrl("2026H96580")})`
    );
    // nennt die Quelle denselben Titel mit anderem Datum (lin-13: Kurs
    // fehlt in course_links), gilt Stufe 2 nicht: gehalten, unverändert
    const held = new OverviewLinkFilter(r3Guard(LIN, [LIN.overview]));
    expect(held.push(`1. [**Zumba®**](${NEUE_ANGEBOTE})\n`)).toBe("");
    expect(held.push("", { final: true })).toBe(
      `1. [**Zumba®**](${NEUE_ANGEBOTE})\n`
    );
  });

  test("Stufe 2 nicht, wenn das Kursdokument des Kandidaten im Kontext steht (Modell hatte den Kurs-Link)", () => {
    const guard = r3Guard(LIN, [ZUMBA_DOC]);
    const filter = new OverviewLinkFilter(guard);
    expect(filter.push(`1. [**Zumba®**](${NEUE_ANGEBOTE})\n`)).toBe("");
  });

  test("Stufe 2 nicht, wenn die Adresse eine andere Kursnummer trägt", () => {
    const overview = overviewDoc([
      "Zumba®",
      "Do. 29.10.2026, 18.30 Uhr",
      "2026H96580",
    ]);
    const guard = r3Guard(LIN, [overview]);
    const url = `${NEUE_ANGEBOTE}?knr=2026H96570&browse=forward`;
    const text = `Probieren Sie [Zumba®](${url}) aus.`;
    expectAll(text, text, guard);
  });
});

describe("R3-2 (B2, R3-D2): Haupttitel vor zwei Leerzeichen als zweiter Schlüssel", () => {
  test("lin-21: Antwort nennt nur den Haupttitel, Datum und Nummer entscheiden", () => {
    const text = reply(LIN.entries["lin-21-2"]);
    expectAll(
      text,
      text.replace(linkOf(text), linUrl("2026H72020")),
      r3Guard(LIN)
    );
  });

  test("mar-02: gleicher Haupttitel, anderer Untertitel: mehrere Kandidaten, Merkmale entscheiden", () => {
    const guard = r3Guard(MAR);
    const verdict = guard.check(
      "**Hatha-Yoga**",
      "https://www.vhs-marburg.de/kurse/gesundheit"
    );
    expect(verdict.course).toBeTruthy();
    const text = reply(MAR.entries["mar-02-3"]);
    expectAll(text, text.replace(linkOf(text), marUrl("262-30125")), guard);
    // nur das Datum, zwei Kurse am selben Tag: unverändert
    const ambiguous = reply(
      "[**Hatha-Yoga**](https://www.vhs-marburg.de/kurse/gesundheit)\n**Beginn:** Di. 01.09.2026"
    );
    expectAll(ambiguous, ambiguous, guard);
    // voller Titel mit Untertitel trifft weiterhin
    const full = reply(
      `[**Hatha-Yoga Einstiegs- und Vertiefungskurs 50+**](https://www.vhs-marburg.de/kurse/gesundheit)\n**Beginn:** Do. 24.09.2026, 10:30 Uhr`
    );
    expectAll(full, full.replace(linkOf(full), marUrl("262-30133")), guard);
  });
});

describe("R3-3 (R3-D3): Kursnummer im Text als Schlüssel", () => {
  test("alt-06: Titel weicht ab („in Perach“), Nummer im Text trifft", () => {
    const text = reply(ALT.entries["alt-06-1"]);
    expectAll(text, text.replace(linkOf(text), altUrl("T8240A")), r3Guard(ALT));
  });

  test("Titel weicht nur im Untertitel ab: Nummer entscheidet, Datum allein nicht", () => {
    const guard = r3Guard(MAR);
    const page = "https://www.vhs-marburg.de/kurse/gesundheit";
    const withNumber = reply(
      `[**Hatha-Yoga Vertiefung**](${page})\n**Beginn:** Do. 24.09.2026\n**Kurs:** 262-30133`
    );
    expectAll(withNumber, withNumber.replace(page, marUrl("262-30133")), guard);
    const dateOnly = reply(
      `[**Hatha-Yoga Vertiefung**](${page})\n**Beginn:** Do. 24.09.2026`
    );
    expectAll(dateOnly, dateOnly, guard);
    // Nummer eines Kurses mit anderem Titel: unverändert
    const altPage =
      "https://www.vhs-altoetting.de/programm/gesundheit/kategorie/476";
    const foreign = reply(
      `[**Hatha-Yoga am Abend**](${altPage})\n**Beginn:** Di. 22.09.2026\n**Kurs:** T3280`
    );
    expectAll(foreign, foreign, r3Guard(ALT));
  });
});

describe("R3-4 (B4, R3-D4): Regel 1 nur für Kategorie-Links", () => {
  test("alt-04: Kurstitel auf Knotenadresse bleibt (ohne und mit course_links); alt-10 bekommt den Kurs-Link", () => {
    const text = reply(ALT.entries["alt-04-2"]);
    expectAll(text, text, r3Guard(ALT, [], { links: false }));
    expectAll(text, text, r3Guard(ALT));
    const alt10 = reply(ALT.entries["alt-10-2"]);
    expectAll(
      alt10,
      alt10.replace(linkOf(alt10), altUrl("T3280")),
      r3Guard(ALT)
    );
  });

  test("Kategorie-Link bleibt Regel 1: Knotentitel, alte Form, Kurszahl, Übersicht; anderer Text nicht", () => {
    const url = ALT.nodes["Kultur und Gestalten"].url;
    const guard = r3Guard(ALT, [], { links: false });
    const text = [
      `Mehr unter [kultur UND gestalten](${url}).`,
      `Mehr unter [Alle Kurse in Kultur](${url}).`,
      `Mehr unter [Kreativkurse (12 Kurse)](${url}).`,
      `Mehr Kurse zum Thema: [Kreatives](${url})`,
    ].join("\n");
    const out = [...allPaths(text, guard)];
    expect(out).toHaveLength(1);
    expect(out[0].match(/\[Kultur und Gestalten\]/g)).toHaveLength(4);
    const free = `Schauen Sie in [unsere Kreativkurse](${url}) rein.`;
    expectAll(free, free, guard);
  });

  test("Kurszahl nur am Ende des Linktexts: Zahl mitten im Kurstitel bleibt (tue-04, koe-12)", () => {
    const node = ALT.nodes["Kultur und Gestalten"].url;
    const courseUrl =
      "https://www.vhs-altoetting.de/kurssuche/kurs/iphone/T9001";
    const doc = [
      "<document_metadata>",
      "sourceDocument: kurs.txt",
      "</document_metadata>",
      "",
      "Titel: iPhone Einführung",
      `Kurs-Link: ${courseUrl}`,
    ].join("\n");
    const guard = r3Guard(ALT, [doc], { links: false });
    const text = [
      `1. [**Alphabetisierungskurs Abschnitt 4 Kurs 311**](${node})`,
      `2. [**iPhone Einführung - Praxisworkshop für Menschen ab 60 Kurs am Nachmittag**](${courseUrl})`,
    ].join("\n");
    expectAll(text, text, guard);
    // Kurszahl am Ende: weiter Regel 1 bzw. Regel 4
    const counted = `[Kreatives, 3 Kurse](${node}) und [iPhone (2 Kurse)](${courseUrl})`;
    expectAll(
      counted,
      `[Kultur und Gestalten](${node}) und [iPhone](${courseUrl})`,
      guard
    );
  });
});

// KIE-576 Runde 4 (R4-D1): eine Widerspruchsprüfung für Stufe 2 und Halten
describe("R4-D1: Stufe 2 und Halten prüfen dieselben Widersprüche", () => {
  const pilatesOverview = [
    "<document_metadata>",
    `source: ${OVERVIEW_PAGE}`,
    "</document_metadata>",
    "",
    "Pilates",
    "Mo. 02.02.2026, 18:00 Uhr",
    "Lingen",
  ].join("\n");
  const pilatesGuard = () =>
    createOverviewLinkGuard({
      contextTexts: applyCategoryChains(
        [
          pilatesOverview,
          courseDoc("Pilates", "26200-021", "Sport", kurs("26200-021")),
        ],
        MAP
      ),
      map: MAP,
    });

  test("R2-S1: Übersicht plus Kursdokument eines anderen gleichnamigen Kurses: Halten, nicht Stufe 2", () => {
    const guard = pilatesGuard();
    // Stufe 2 hätte sofort den Kurs vom 02.02. gesetzt
    expect(guard.check("Pilates", OVERVIEW_PAGE).course).toBeTruthy();
    const dated = `Probieren Sie [Pilates](${OVERVIEW_PAGE}) ab dem 09.02.2026 aus.`;
    expectAll(dated, dated.replace(OVERVIEW_PAGE, kurs("26200-021")), guard);
    const bare = `Probieren Sie [Pilates](${OVERVIEW_PAGE}) aus.`;
    expectAll(bare, bare, guard);
  });

  test("R2-S2: lin-13-knr ohne Zeile „Kurs:“, Adresse mit anderer Kursnummer: unverändert (Abfrage und Pfad)", () => {
    const guard = r3Guard(LIN);
    for (const url of [
      `${NEUE_ANGEBOTE}?knr=2026H96570&browse=forward`,
      "https://www.vhs-lingen.de/programm/kurssuche/kurs/zumba-r/2026H96570",
    ]) {
      const text = reply(
        `2. [**Zumba®**](${url})\n  Ein energiegeladener Fitnesstanzkurs.\n  **Beginn:** Do. 29.10.2026, 18:30 Uhr\n  **Status:** Anmeldung möglich`
      );
      expectAll(text, text, guard);
    }
    // Gegenprobe: Adresse ohne Kursnummer, Datum bestätigt
    const plain = reply(
      `2. [**Zumba®**](${NEUE_ANGEBOTE})\n  **Beginn:** Do. 29.10.2026, 18:30 Uhr`
    );
    expectAll(plain, plain.replace(NEUE_ANGEBOTE, linUrl("2026H96580")), guard);
  });

  test("R2-S11: „3. Juni 10:00“ ergibt kein Scheindatum 10.6. (de und en)", () => {
    const map = chains.parseCategoryMap(
      mapJson({
        course_links: {
          ...COURSE_LINKS,
          "26200-070": {
            title: "Aquafit",
            start: "2026-06-10T18:00",
            place: "Lingen",
            url: kurs("26200-070"),
          },
        },
      })
    );
    const guard = guardFor(map);
    for (const when of ["3. Juni 10:00 Uhr", "3 June 10:00"]) {
      const text = reply(
        entry(1, "Aquafit", OVERVIEW_PAGE, { beginn: `Mi. ${when}` })
      );
      expectAll(text, text, guard);
    }
    const right = reply(
      entry(1, "Aquafit", OVERVIEW_PAGE, { beginn: "Mi. 10. Juni, 18:00 Uhr" })
    );
    expectAll(right, right.replace(OVERVIEW_PAGE, kurs("26200-070")), guard);
  });
});

// KIE-576 Runde 5 (R5-D1, R5-D2) mit Fällen aus der Messung AK-21 r4
// (fixtures/courseLinkLookupR5.json, nur die nötigen Zeilen)
const R5 = require("./fixtures/courseLinkLookupR5.json");
const LIN18 = R5.lingen;
const RENTE = LIN18.course_links["2027F16005"].url;

describe("R5-D1: Kursnummer im Text vor der Nummer in der Adresse", () => {
  test("lin-18: Adresse mit fremder bzw. nicht vorhandener Kursnummer, Text nennt die Nummer: Kurs-Link (jede Aufteilung)", () => {
    for (const guard of [r3Guard(LIN18), r3Guard(LIN18, [LIN.overview])]) {
      for (const id of ["lin-18-A_live", "lin-18-F"]) {
        const text = reply(LIN18.entries[id]);
        expectAll(text, text.replace(linkOf(text), RENTE), guard);
      }
    }
  });

  test("Adresse mit anderer Kursnummer, Text nur mit Datum: unverändert (lin-13-knr)", () => {
    const guard = r3Guard(LIN18);
    const dated = reply(
      LIN18.entries["lin-18-A_live"].replace(/\n\s*\*\*Kurs:\*\* \S+/, "")
    );
    expect(dated).not.toContain("2027F16005");
    expectAll(dated, dated, guard);
    for (const id of ["lin-13-2", "lin-13-knr"]) {
      const text = reply(LIN.entries[id]);
      expectAll(text, text, r3Guard(LIN, [ZUMBA_DOC, LIN.overview]));
    }
  });

  test("Nummer im Text, aber anderes Datum oder zweite Nummer gleicher Form im Text: unverändert", () => {
    const guard = r3Guard(LIN18);
    const entry = LIN18.entries["lin-18-A_live"];
    const otherDate = reply(entry.replace("05.04.2027", "12.04.2027"));
    expectAll(otherDate, otherDate, guard);
    const twoNumbers = reply(
      entry.replace(
        "**Kurs:** 2027F16005",
        "**Kurs:** 2027F16005, Folgekurs 2027F16006"
      )
    );
    expectAll(twoNumbers, twoNumbers, guard);
  });

  test("Nummer im Text gehört zu einem Kurs mit anderem Titel: unverändert", () => {
    const guard = r3Guard(LIN18);
    const foreign = reply(
      LIN18.entries["lin-18-A_live"].replace(
        "**Kurs:** 2027F16005",
        "**Kurs:** 2026H16105"
      )
    );
    expectAll(foreign, foreign, guard);
  });
});

describe("R5-D2: wörtlicher Treffer vor Schlüsseltreffer", () => {
  const TUT = R5.tuttlingen;
  const tutGuard = () => r3Guard(TUT, TUT.context, { links: false });
  const [first, second, third] = TUT.context.map(
    (doc) => /^source: (\S+)$/m.exec(doc)[1]
  );

  test("tut-23: drei Adressen mit gleichem Schlüssel, Modell nutzt die dritte wörtlich: sie bleibt", () => {
    const text = `Hier mehr:\n\n${TUT.entries["tut-23"]}\n\nViel Spaß!`;
    expect(linkOf(text)).toBe(third);
    expectAll(text, text, tutGuard());
    // auch die zweite, in der Übersichtszeile und als Autolink; je Link
    // eine eigene Zeile (S7-1)
    const more = `[Alle Kurse in Senioren](${second})\nMehr Kurse zum Thema: [Senioren vhs](${third}) · <${second}>\nEnde`;
    expectAll(
      more,
      `[Alle Kurse in Senioren](${second})\nMehr Kurse zum Thema: [Senioren vhs](${third})\nMehr Kurse zum Thema: <${second}>\nEnde`,
      tutGuard()
    );
  });

  test("Adresse nicht wörtlich bekannt: Originalform der ersten Fundstelle", () => {
    const text = `[**Alle 4 Kurse in Senioren vhs**](http://vhs-tuttlingen.de/Kurse/kategorie/101/)`;
    expectAll(text, `[**Alle Kurse in Senioren vhs**](${first})`, tutGuard());
  });
});
