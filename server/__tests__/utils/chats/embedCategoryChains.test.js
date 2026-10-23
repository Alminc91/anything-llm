/* eslint-env jest, node */
// KIE-576 Paket 2 „Kette“: Kategorie-Karte (SystemSetting kufer_category_map),
// Kette im Kontext (AK-14, NAK-6) und Prüfer der Übersichtslinks (AK-15).

jest.mock("../../../utils/prisma", () => ({
  system_settings: { findFirst: jest.fn() },
}));

const prisma = require("../../../utils/prisma");
const {
  CATEGORY_MAP_LABEL,
  validateCategoryMapSetting,
  loadCategoryMap,
  applyCategoryChains,
  createOverviewLinkGuard,
  categoryMapUpdatedAt,
  __test__,
} = require("../../../utils/chats/embedCategoryChains");

const HOST = "https://www.vhs-beispiel.de";
const NOW = Date.parse("2026-10-23T08:00:00Z");

function mapData(overrides = {}) {
  return {
    version: 1,
    client: "vhs-beispiel",
    created: "2026-10-22T21:00:00Z",
    nodes: {
      "Fitness & Gesundheit": {
        title: "Fitness & Gesundheit",
        url: `${HOST}/kursprogramm/fitness-gesundheit`,
        count: 148,
      },
      "Fitness & Gesundheit \\ Sport & Fitness": {
        title: "Sport & Fitness",
        url: `${HOST}/kursprogramm/fitness-gesundheit/sport-fitness`,
        count: 61,
      },
      "Fitness & Gesundheit \\ Sport & Fitness \\ Kraft & Ausdauer": {
        title: "Sport & Fitness · Kraft & Ausdauer",
        url: `${HOST}/kursprogramm/fitness-gesundheit/sport-fitness/kategorie/Kraft+Ausdauer/149`,
        count: 1,
      },
      "Fitness & Gesundheit \\ Warteliste": {
        title: "Warteliste",
        url: `${HOST}/kursprogramm/fitness-gesundheit/warteliste`,
        count: 35,
      },
      "Sprachen \\ Englisch": {
        title: "Englisch",
        url: `${HOST}/kursprogramm/sprachen/englisch`,
        count: null,
      },
      "Sprachen \\ Englisch \\ Konversation": {
        title: "Konversation",
        url: `${HOST}/kursprogramm/sprachen/englisch`,
        count: 3,
      },
    },
    courses: { "26294-035": "Fitness & Gesundheit \\ Sport & Fitness" },
    ...overrides,
  };
}

const parse = (data = mapData()) =>
  __test__.parseCategoryMap(JSON.stringify(data));

function courseText({
  number = "26100-001",
  path = "Fitness & Gesundheit \\ Sport & Fitness \\ Kraft & Ausdauer",
  link = `${HOST}/kurssuche/kurs/rueckenfit/26100-001`,
  numberLine = true,
} = {}) {
  return [
    "<document_metadata>",
    "sourceDocument: www-vhs-beispiel-de-kurssuche-kurs-rueckenfit.txt",
    "published: 10/22/2026, 4:41:54 AM",
    "</document_metadata>",
    "",
    "Titel: Rückenfit",
    ...(numberLine ? [`Kursnummer: ${number}`] : []),
    "Kursgebühr: 45,00",
    "Kategorie: Kraft & Ausdauer",
    `Kategoriepfad: ${path}`,
    `Kurs-Link: ${link}`,
    "Kategorie-Link-Titel: Sport & Fitness · Kraft & Ausdauer",
    `Kategorie-Link: ${HOST}/kursprogramm/alt/kraft`,
    "Bereich-Link-Titel: Fitness & Gesundheit",
    `Bereich-Link: ${HOST}/kursprogramm/alt`,
    "",
    "Kursbeschreibung: Kräftigung für den Rücken.",
    "Kategorie-Link: steht in der Beschreibung und bleibt",
  ].join("\n");
}

function pageText(source, body = "Sie befinden sich hier: Sport") {
  return [
    "<document_metadata>",
    "sourceDocument: seite.html",
    "published: 6/26/2026, 9:29:06 AM",
    `source: ${source}`,
    "</document_metadata>",
    "",
    body,
  ].join("\n");
}

const CHAIN_SPORT = [
  `Kategorie-Ebene 1: Fitness & Gesundheit (148 Kurse) | ${HOST}/kursprogramm/fitness-gesundheit`,
  `Kategorie-Ebene 2: Sport & Fitness (61 Kurse) | ${HOST}/kursprogramm/fitness-gesundheit/sport-fitness`,
];
const CHAIN_KRAFT = [
  ...CHAIN_SPORT,
  `Kategorie-Ebene 3: Sport & Fitness · Kraft & Ausdauer (1 Kurs) | ${HOST}/kursprogramm/fitness-gesundheit/sport-fitness/kategorie/Kraft+Ausdauer/149`,
];

beforeEach(() => {
  jest.clearAllMocks();
  __test__.resetCache();
});

describe("Validator kufer_category_map (Whitelist)", () => {
  test("gültige Karte bleibt derselbe String", () => {
    const raw = JSON.stringify(mapData());
    expect(validateCategoryMapSetting(raw)).toBe(raw);
  });

  test.each([null, undefined, ""])("%p leert die Karte (null)", (value) => {
    expect(validateCategoryMapSetting(value)).toBeNull();
  });

  test.each([
    ["kein JSON", "{version: 1"],
    ["Zahl statt String", 42],
    ["Liste", "[]"],
    ["version 2", JSON.stringify(mapData({ version: 2 }))],
    ["version als Text", JSON.stringify(mapData({ version: "1" }))],
    ["created fehlt", JSON.stringify(mapData({ created: undefined }))],
    ["created kein Zeitpunkt", JSON.stringify(mapData({ created: "gestern" }))],
    ["nodes fehlt", JSON.stringify(mapData({ nodes: undefined }))],
    ["nodes als Liste", JSON.stringify(mapData({ nodes: [] }))],
    ["courses als Liste", JSON.stringify(mapData({ courses: [] }))],
  ])("%s -> abgelehnt (Fehler)", (_name, value) => {
    expect(() => validateCategoryMapSetting(value)).toThrow(CATEGORY_MAP_LABEL);
  });

  test("K2: optionales updated und unbekannte Felder werden akzeptiert", () => {
    const raw = JSON.stringify(
      mapData({ updated: "2026-10-23T07:00:00Z", extra: { a: 1 } })
    );
    expect(validateCategoryMapSetting(raw)).toBe(raw);
    // auch ein unbrauchbares updated lehnt die Karte nicht ab (ignoriert)
    const odd = JSON.stringify(mapData({ updated: "bald" }));
    expect(validateCategoryMapSetting(odd)).toBe(odd);
  });

  test("größer als 2 MB (UTF-8) -> abgelehnt, genau 2 MB -> gültig", () => {
    const base = JSON.stringify(mapData({ pad: "" }));
    const room = __test__.CATEGORY_MAP_MAX_BYTES - Buffer.byteLength(base);
    // „ü“ zählt in UTF-8 doppelt
    const exact = JSON.stringify(mapData({ pad: "ü".repeat(room / 2) }));
    expect(Buffer.byteLength(exact)).toBe(__test__.CATEGORY_MAP_MAX_BYTES);
    expect(validateCategoryMapSetting(exact)).toBe(exact);
    const over = JSON.stringify(mapData({ pad: "ü".repeat(room / 2) + "x" }));
    expect(() => validateCategoryMapSetting(over)).toThrow(/2 MB/);
  });
});

describe("loadCategoryMap: Wert, Alter (E22), Cache", () => {
  const stored = (value) =>
    prisma.system_settings.findFirst.mockResolvedValue(
      value === null ? null : { value }
    );

  test("liest nur den Wert des eigenen Labels", async () => {
    stored(JSON.stringify(mapData()));
    expect(await loadCategoryMap({ now: NOW })).not.toBeNull();
    expect(prisma.system_settings.findFirst).toHaveBeenCalledWith({
      where: { label: "kufer_category_map" },
      select: { value: true },
    });
  });

  test.each([
    ["kein Eintrag", null],
    ["leer", ""],
    ["kein JSON", "{"],
    ["version 2", JSON.stringify(mapData({ version: 2 }))],
    [
      "älter als 36 h",
      JSON.stringify(mapData({ created: "2026-10-21T19:59:59Z" })),
    ],
    [
      "mehr als 1 h in der Zukunft",
      JSON.stringify(mapData({ created: "2026-10-23T09:00:01Z" })),
    ],
  ])("%s -> null", async (_name, value) => {
    stored(value);
    expect(await loadCategoryMap({ now: NOW })).toBeNull();
  });

  test("K2: updated ändert das Alter nicht (E22 zählt created)", async () => {
    stored(
      JSON.stringify(
        mapData({
          created: "2026-10-21T19:59:59Z",
          updated: "2026-10-23T07:00:00Z",
        })
      )
    );
    expect(await loadCategoryMap({ now: NOW })).toBeNull();
  });

  test("K2: categoryMapUpdatedAt liefert updated, sonst created", async () => {
    stored(JSON.stringify(mapData({ updated: "2026-10-23T07:00:00Z" })));
    const map = await loadCategoryMap({ now: NOW });
    expect(categoryMapUpdatedAt(map)).toBe("2026-10-23T07:00:00.000Z");
    stored(JSON.stringify(mapData({ updated: "bald" })));
    expect(categoryMapUpdatedAt(await loadCategoryMap({ now: NOW }))).toBe(
      "2026-10-22T21:00:00.000Z"
    );
    stored(JSON.stringify(mapData()));
    expect(categoryMapUpdatedAt(await loadCategoryMap({ now: NOW }))).toBe(
      "2026-10-22T21:00:00.000Z"
    );
    expect(categoryMapUpdatedAt(null)).toBeNull();
  });

  test("genau 36 h alt -> gültig", async () => {
    stored(JSON.stringify(mapData({ created: "2026-10-21T20:00:00Z" })));
    expect(await loadCategoryMap({ now: NOW })).not.toBeNull();
  });

  test("Datenbankfehler -> null, wirft nicht", async () => {
    jest.spyOn(console, "error").mockImplementation(() => {});
    prisma.system_settings.findFirst.mockRejectedValue(new Error("db weg"));
    await expect(loadCategoryMap({ now: NOW })).resolves.toBeNull();
    console.error.mockRestore();
  });

  test("R1-D7 (SC8): verworfene Karte wird einmal je Wert gemeldet", async () => {
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      stored("{");
      expect(await loadCategoryMap({ now: NOW })).toBeNull();
      expect(await loadCategoryMap({ now: NOW })).toBeNull();
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0]).toMatch(
        /Karte verworfen: kein gültiges JSON/
      );
      stored(JSON.stringify(mapData({ version: 2 })));
      expect(await loadCategoryMap({ now: NOW })).toBeNull();
      expect(spy).toHaveBeenCalledTimes(2);
      expect(spy.mock.calls[1][0]).toMatch(/version ist nicht 1/);
      // gültige, nur abgelaufene Karte ist kein Fehler
      stored(JSON.stringify(mapData({ created: "2026-10-01T00:00:00Z" })));
      expect(await loadCategoryMap({ now: NOW })).toBeNull();
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
  });

  test("Cache: gleicher Wert -> dieselbe Karte, geänderter Wert -> neu geparst", async () => {
    stored(JSON.stringify(mapData()));
    const first = await loadCategoryMap({ now: NOW });
    const again = await loadCategoryMap({ now: NOW });
    expect(again).toBe(first);
    stored(JSON.stringify(mapData({ client: "anders" })));
    const changed = await loadCategoryMap({ now: NOW });
    expect(changed).not.toBe(first);
    expect(changed).not.toBeNull();
  });

  test("Cache: Alter wird je Aufruf geprüft (Karte läuft ab)", async () => {
    stored(JSON.stringify(mapData()));
    expect(await loadCategoryMap({ now: NOW })).not.toBeNull();
    const later = NOW + 36 * 60 * 60 * 1000;
    expect(await loadCategoryMap({ now: later })).toBeNull();
  });
});

describe("parseCategoryMap: nur brauchbare Knoten", () => {
  test("unsichere Adressen, leere Titel, Ebene > 5 und Sonderknoten samt Teilbaum entfallen; count nur ganze Zahl >= 0", () => {
    const map = parse(
      mapData({
        nodes: {
          A: { title: "A", url: "javascript:alert(1)", count: 1 },
          B: { title: "B", url: `${HOST}/b)x`, count: 1 },
          C: { title: "  ", url: `${HOST}/c`, count: 1 },
          "D \\ E \\ F \\ G \\ H \\ I": {
            title: "I",
            url: `${HOST}/i`,
            count: 1,
          },
          "Kurse \\ Neu im Programm": {
            title: "Neu",
            url: `${HOST}/n`,
            count: 1,
          },
          "Kurse \\ Neu hinzugefügt \\ Yoga": {
            title: "Yoga",
            url: `${HOST}/y`,
            count: 1,
          },
          K: { title: "K [x](y)\nZeile", url: `${HOST}/k`, count: -1 },
          L: { title: "L", url: `${HOST}/l`, count: 2.5 },
        },
      })
    );
    expect([...map.nodes.keys()]).toEqual(["k", "l"]);
    expect(map.nodes.get("k")).toMatchObject({
      title: "K x y Zeile",
      count: null,
    });
    expect(map.nodes.get("l").count).toBeNull();
  });

  test("S15: Titel über 200 Zeichen wird nach Codepunkten gekürzt (kein halbes Emoji)", () => {
    const data = mapData();
    data.nodes["Fitness & Gesundheit"].title = `${"a".repeat(199)}😀😀`;
    const node = parse(data).nodes.get("fitness & gesundheit");
    expect(node.title).toBe(`${"a".repeat(199)}😀`);
    expect(node.title).not.toMatch(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
    );
  });

  test("Pfade werden wie category_common verglichen: klein, Leerraum, ohne []()<>", () => {
    expect(__test__.pathParts("  Sprachen  \\ Englisch (B1)\\\\ ")).toEqual([
      "sprachen",
      "englisch b1",
    ]);
    expect(__test__.normalizePart("NEU HINZUGEFÜGT")).toBe("neu hinzugefügt");
  });

  test("urlKey: Schrägstrich am Ende und /kategorie/<Name>/<Nr> gleich /kategorie/<Nr>", () => {
    const { urlKey } = __test__;
    expect(urlKey(`${HOST}/a/`)).toBe(urlKey(`${HOST}/a`));
    expect(urlKey(`${HOST}/x/kategorie/Yoga/335`)).toBe(
      urlKey(`${HOST}/x/kategorie/335`)
    );
  });
});

describe("applyCategoryChains (AK-14)", () => {
  test("NAK-6: ohne Karte dasselbe Array, jeder Text bytegleich", () => {
    const texts = [
      courseText(),
      pageText(`${HOST}/kursprogramm/fitness-gesundheit`),
    ];
    const copy = [...texts];
    expect(applyCategoryChains(texts, null)).toBe(texts);
    expect(texts).toEqual(copy);
  });

  test("Kursdokument: Kette direkt nach Kategoriepfad, die vier Zeilen ersetzt, Rest bytegleich", () => {
    const [out] = applyCategoryChains([courseText()], parse());
    const expected = courseText()
      .replace(
        /^(?:Kategorie-Link-Titel|Kategorie-Link|Bereich-Link-Titel|Bereich-Link): .*\n(?=[\s\S]*\nKursbeschreibung)/gm,
        ""
      )
      .replace(/^(Kategoriepfad: .*\n)/m, `$1${CHAIN_KRAFT.join("\n")}\n`);
    expect(out).toBe(expected);
    // Kategorie, Kategoriepfad und Kurs-Link bleiben; Beschreibung unverändert
    expect(out).toMatch(/^Kategorie: Kraft & Ausdauer$/m);
    expect(out).toMatch(/^Kurs-Link: /m);
    expect(out).toMatch(
      /Kategorie-Link: steht in der Beschreibung und bleibt$/
    );
    expect(out).not.toMatch(/alt\/kraft/);
  });

  test("ohne Änderung dasselbe Array; Eingabe wird nie verändert", () => {
    const texts = [pageText(`${HOST}/impressum`)];
    expect(applyCategoryChains(texts, parse())).toBe(texts);
    const course = [courseText()];
    const before = course[0];
    const out = applyCategoryChains(course, parse());
    expect(out).not.toBe(course);
    expect(course[0]).toBe(before);
  });

  test("Zahl: 1 -> „(1 Kurs)“, null -> ohne Klammer, 0 -> „(0 Kurse)“", () => {
    const data = mapData();
    data.nodes["Sprachen"] = {
      title: "Sprachen",
      url: `${HOST}/sprachen`,
      count: 0,
    };
    const [out] = applyCategoryChains(
      [courseText({ path: "Sprachen \\ Englisch" })],
      parse(data)
    );
    expect(out).toMatch(/^Kategorie-Ebene 1: Sprachen \(0 Kurse\) \| /m);
    expect(out).toMatch(
      /^Kategorie-Ebene 2: Englisch \| https:\/\/\S+englisch$/m
    );
  });

  test("Ebenen ohne Knoten fehlen, die Nummer bleibt die Ebene des Pfads", () => {
    const data = mapData();
    delete data.nodes["Fitness & Gesundheit \\ Sport & Fitness"];
    const [out] = applyCategoryChains([courseText()], parse(data));
    expect(out.match(/^Kategorie-Ebene .*$/gm)).toEqual([
      CHAIN_KRAFT[0],
      CHAIN_KRAFT[2],
    ]);
  });

  test.each([
    "Fitness & Gesundheit \\ Warteliste \\ Kraft & Ausdauer",
    "Fitness & Gesundheit \\ NEU im Programm",
    "Fitness & Gesundheit \\ Neu hinzugefügt \\ Sport & Fitness",
    "Fitness & Gesundheit \\  neue   kurse ",
  ])("E20: Kette endet vor dem Sonderknoten (%s)", (path) => {
    const [out] = applyCategoryChains([courseText({ path })], parse());
    expect(out.match(/^Kategorie-Ebene .*$/gm)).toEqual([CHAIN_SPORT[0]]);
  });

  test("K3: gültige Karte, Kategoriepfad ohne Treffer: keine Kette, die vier Zeilen fallen weg (gewollt)", () => {
    const [out] = applyCategoryChains(
      [courseText({ path: "Kochen \\ Backen" })],
      parse()
    );
    const head = out.split("Kursbeschreibung:")[0];
    expect(head).not.toMatch(/^Kategorie-Ebene/m);
    expect(head).not.toMatch(
      /^(?:Kategorie-Link-Titel|Kategorie-Link|Bereich-Link-Titel|Bereich-Link):/m
    );
    expect(out).toContain("Kategoriepfad: Kochen \\ Backen\nKurs-Link: ");
  });

  test.each([
    ["fehlt", null],
    ["kaputt", "{"],
    [
      "älter als 36 h",
      JSON.stringify(mapData({ created: "2026-10-21T19:59:59Z" })),
    ],
  ])(
    "K3/NAK-6: Karte %s -> Kursdokument ohne Treffer bytegleich",
    async (_name, value) => {
      prisma.system_settings.findFirst.mockResolvedValue(
        value === null ? null : { value }
      );
      const map = await loadCategoryMap({ now: NOW });
      const texts = [courseText({ path: "Kochen \\ Backen" }), courseText()];
      expect(map).toBeNull();
      expect(applyCategoryChains(texts, map)).toBe(texts);
      expect(createOverviewLinkGuard({ contextTexts: texts, map })).toBeNull();
    }
  );

  test("Sonderpfad ohne Knoten davor: keine Kette, die vier Zeilen fallen trotzdem weg", () => {
    const [out] = applyCategoryChains(
      [courseText({ path: "Neu \\ Sport & Fitness" })],
      parse()
    );
    expect(out).not.toMatch(/^Kategorie-Ebene/m);
    expect(out).not.toMatch(/^(?:Kategorie-Link-Titel|Bereich-Link):/m);
  });

  test("E21: Kurs aus courses (Kursnummer) bekommt den Pfad der Webseite statt der Sonderkategorie", () => {
    const [out] = applyCategoryChains(
      [
        courseText({
          number: "26294-035",
          path: "Fitness & Gesundheit \\ Neu",
        }),
      ],
      parse()
    );
    expect(out.match(/^Kategorie-Ebene .*$/gm)).toEqual(CHAIN_SPORT);
    expect(out).toMatch(/^Kategoriepfad: Fitness & Gesundheit \\ Neu$/m);
  });

  test("E21: ohne Kursnummer-Zeile zählt das Ende der Kurs-Link-Adresse", () => {
    const [out] = applyCategoryChains(
      [
        courseText({
          numberLine: false,
          path: "Fitness & Gesundheit \\ Neu",
          link: `${HOST}/kurssuche/kurs/impuls/26294-035/`,
        }),
      ],
      parse()
    );
    expect(out.match(/^Kategorie-Ebene .*$/gm)).toEqual(CHAIN_SPORT);
  });

  test("Pfadvergleich normalisiert (Groß/klein, Leerraum)", () => {
    const [out] = applyCategoryChains(
      [courseText({ path: "fitness  &  GESUNDHEIT\\sport & fitness" })],
      parse()
    );
    expect(out.match(/^Kategorie-Ebene .*$/gm)).toEqual(CHAIN_SPORT);
  });

  test("gecrawlte Kategorieseite: Kette ihres Knotens direkt hinter dem Metadatenkopf", () => {
    const text = pageText(
      `${HOST}/kursprogramm/fitness-gesundheit/sport-fitness/`
    );
    const [out] = applyCategoryChains([text], parse());
    expect(out).toBe(
      text.replace(
        "</document_metadata>\n",
        `</document_metadata>\n${CHAIN_SPORT.join("\n")}\n`
      )
    );
  });

  test("gecrawlte Seite unter /kategorie/<Nr> findet den Knoten /kategorie/<Name>/<Nr>", () => {
    const [out] = applyCategoryChains(
      [
        pageText(
          `${HOST}/kursprogramm/fitness-gesundheit/sport-fitness/kategorie/149`
        ),
      ],
      parse()
    );
    expect(out.match(/^Kategorie-Ebene .*$/gm)).toEqual(CHAIN_KRAFT);
  });

  test("gecrawlte Seite mit mehreren Knoten gleicher Adresse: der kürzeste Pfad", () => {
    const [out] = applyCategoryChains(
      [pageText(`${HOST}/kursprogramm/sprachen/englisch`)],
      parse()
    );
    expect(out.match(/^Kategorie-Ebene .*$/gm)).toEqual([
      `Kategorie-Ebene 2: Englisch | ${HOST}/kursprogramm/sprachen/englisch`,
    ]);
  });

  test("Kopfzeilen nur aus dem Kopfblock: Kategoriepfad im Seitentext bewirkt nichts", () => {
    const text = pageText(
      `${HOST}/blog`,
      "Text\n\nKategoriepfad: Fitness & Gesundheit\nKategorie-Link: x"
    );
    expect(applyCategoryChains([text], parse())[0]).toBe(text);
  });

  test("source außerhalb des Metadatenkopfs zählt nicht", () => {
    const text = [
      "<document_metadata>",
      "sourceDocument: seite.html",
      "</document_metadata>",
      "",
      `source: ${HOST}/kursprogramm/fitness-gesundheit`,
    ].join("\n");
    expect(applyCategoryChains([text], parse())[0]).toBe(text);
  });

  test("geteilter Kopfblock: Teil ohne Kategoriepfad verliert nur die vier Zeilen", () => {
    const text = [
      "<document_metadata>",
      "sourceDocument: kurs.txt",
      "</document_metadata>",
      "",
      `Kategorie-Link: ${HOST}/alt`,
      `Bereich-Link: ${HOST}/alt-bereich`,
      "",
      "Kursbeschreibung: …",
    ].join("\n");
    expect(applyCategoryChains([text], parse())[0]).toBe(
      [
        "<document_metadata>",
        "sourceDocument: kurs.txt",
        "</document_metadata>",
        "",
        "",
        "Kursbeschreibung: …",
      ].join("\n")
    );
  });

  test("Text endet mitten im Kopfblock (letzte Zeile ohne Zeilenende): auch diese Zeile fällt weg", () => {
    const text = courseText().split("\n\nKursbeschreibung")[0];
    const [out] = applyCategoryChains([text], parse());
    expect(out.endsWith("/26100-001")).toBe(true);
    expect(out).not.toMatch(/Bereich-Link/);
  });

  test("Kursdokument ohne Metadatenkopf und Nicht-Strings bleiben robust", () => {
    const bare = courseText().replace(
      /^<document_metadata>[\s\S]*?<\/document_metadata>\n\n/,
      ""
    );
    const [out, other, empty] = applyCategoryChains([bare, null, ""], parse());
    expect(out.match(/^Kategorie-Ebene .*$/gm)).toEqual(CHAIN_KRAFT);
    expect(other).toBeNull();
    expect(empty).toBe("");
  });

  test("unvollständiger Metadatenkopf: unverändert", () => {
    const text =
      "<document_metadata>\nsource: x\nKategoriepfad: Fitness & Gesundheit";
    expect(applyCategoryChains([text], parse())[0]).toBe(text);
  });
});

describe("createOverviewLinkGuard (AK-15, guard v2)", () => {
  const KRAFT_URL = `${HOST}/kursprogramm/fitness-gesundheit/sport-fitness/kategorie/Kraft+Ausdauer/149`;
  const SPORT_URL = `${HOST}/kursprogramm/fitness-gesundheit/sport-fitness`;
  const COURSE_URL = `${HOST}/kurssuche/kurs/rueckenfit/26100-001`;
  const guardFor = (texts = [courseText()], map = parse()) =>
    createOverviewLinkGuard({
      contextTexts: applyCategoryChains(texts, map),
      map,
    });

  test("ohne Karte kein Prüfer", () => {
    expect(
      createOverviewLinkGuard({ contextTexts: [courseText()], map: null })
    ).toBeNull();
  });

  test("kein Übersichtslink -> null (unverändert)", () => {
    const guard = guardFor();
    expect(guard.check("**Rückenfit**", COURSE_URL)).toBeNull();
    expect(guard.check("Alle Infos zur Anmeldung", `${HOST}/x`)).toBeNull();
    expect(guard.check("Tous les cours", `${HOST}/x`)).toBeNull();
  });

  test("Kurs-Link als Übersichtslink -> entfernen", () => {
    expect(guardFor().check("**Alle Kurse in Rückenfit**", COURSE_URL)).toEqual(
      { remove: true }
    );
  });

  test("Adresse nirgends im Kontext -> entfernen (auch wenn sie ein Knoten der Karte ist)", () => {
    const guard = guardFor();
    expect(guard.check("**Alle Kurse in Yoga**", `${HOST}/erfunden`)).toEqual({
      remove: true,
    });
    expect(
      guard.check(
        "Alle Kurse in Englisch",
        `${HOST}/kursprogramm/sprachen/englisch`
      )
    ).toEqual({ remove: true });
  });

  test("Knoten im Kontext, alte Form am Zeilenanfang: Linktext E29, Zeile vom Server", () => {
    expect(
      guardFor().check("**Alle 5 Kurse in Sport**", `${SPORT_URL}/`, {
        lineStart: true,
      })
    ).toEqual({
      remove: false,
      text: "Sport & Fitness (61 Kurse)",
      line: "de",
    });
    // mitten im Text: nur der Linktext
    expect(
      guardFor().check("**Alle 5 Kurse in Sport**", `${SPORT_URL}/`)
    ).toEqual({
      remove: false,
      text: "Sport & Fitness (61 Kurse)",
      line: null,
    });
  });

  test("Übersichtszeile (lang): jeder Link ist Übersichtslink, Text nach E29", () => {
    const guard = guardFor();
    expect(guard.check("Sport", SPORT_URL, { lang: "de" })).toEqual({
      remove: false,
      text: "Sport & Fitness (61 Kurse)",
      line: null,
    });
    expect(guard.check("Rückenfit", COURSE_URL, { lang: "de" })).toEqual({
      remove: true,
    });
    expect(guard.check("Sports", SPORT_URL, { lang: "en" }).text).toBe(
      "Sport & Fitness (61 courses)"
    );
  });

  test("NAK-7: n = 1 -> „(1 Kurs)“, null -> nur Titel", () => {
    const guard = guardFor([
      courseText(),
      pageText(`${HOST}/kursprogramm/sprachen/englisch`),
    ]);
    expect(guard.check("Alle 7 Kurse in Kraft", KRAFT_URL).text).toBe(
      "Sport & Fitness · Kraft & Ausdauer (1 Kurs)"
    );
    expect(guard.check("Kraft", KRAFT_URL, { lang: "en" }).text).toBe(
      "Sport & Fitness · Kraft & Ausdauer (1 course)"
    );
    expect(
      guard.check(
        "**Alle 3 Kurse in Englisch**",
        `${HOST}/kursprogramm/sprachen/englisch`
      ).text
    ).toBe("Englisch");
  });

  test("Zahl < 1 -> nur Titel", () => {
    const data = mapData();
    data.nodes["Fitness & Gesundheit \\ Sport & Fitness"].count = 0;
    const guard = guardFor([courseText()], parse(data));
    expect(guard.check("Sport (4 Kurse)", SPORT_URL, { lang: "de" }).text).toBe(
      "Sport & Fitness"
    );
  });

  test("Englisch alte Form: Linktext E29 englisch", () => {
    const guard = guardFor();
    expect(guard.check("**All 5 courses in Sports**", SPORT_URL).text).toBe(
      "Sport & Fitness (61 courses)"
    );
    expect(guard.check("**all 4 Courses in strength**", KRAFT_URL).text).toBe(
      "Sport & Fitness · Kraft & Ausdauer (1 course)"
    );
  });

  test("(c) Knoten-Link ohne Einleitung: Titel und Zahl nur bei Zahl in Klammern", () => {
    const guard = guardFor();
    expect(guard.check("Sport (3 Kurse)", SPORT_URL).text).toBe(
      "Sport & Fitness (61 Kurse)"
    );
    expect(guard.check("Sports (3 courses)", SPORT_URL).text).toBe(
      "Sport & Fitness (61 courses)"
    );
    expect(guard.check("Sport (3 cours)", SPORT_URL).text).toBe(
      "Sport & Fitness (61 cours)"
    );
    expect(guard.check("unsere Sportkurse", SPORT_URL).text).toBe(
      "unsere Sportkurse"
    );
    // Aufzählung: kein Übersichtslink
    expect(
      guard.check("Sport (3 Kurse)", SPORT_URL, { enumeration: true })
    ).toBeNull();
    // nicht im Kontext: nur noch Text (ohne Zahl); ob die Zeile entfällt,
    // entscheidet der Filter
    const english = `${HOST}/kursprogramm/sprachen/englisch`;
    expect(guard.check("Englisch (3 Kurse)", english)).toEqual({
      remove: true,
      plain: "Englisch",
    });
    expect(guard.check("**Englisch**", english, { lineStart: true })).toEqual({
      remove: true,
      plain: "Englisch",
    });
  });

  test("Einleitung erkennen: Treffer, offen, nichts", () => {
    const guard = guardFor();
    expect(guard.matchIntro("Mehr Kurse zum Thema: [x]", false)).toEqual({
      lang: "de",
      length: "Mehr Kurse zum Thema:".length,
    });
    expect(guard.matchIntro("more courses on this topic:", true)).toEqual({
      lang: "en",
      length: "More courses on this topic:".length,
    });
    expect(guard.matchIntro("Mehr Ku", false)).toEqual({ pending: true });
    expect(guard.matchIntro("Mehr Ku", true)).toBeNull();
    expect(guard.matchIntro("Mehr Kurse zum Thema Yoga", false)).toBeNull();
  });

  test("im Kontext, aber kein Knoten der Karte (z. B. gecrawlte Seite) -> Linktext unverändert", () => {
    const guard = guardFor([courseText(), pageText(`${HOST}/kurse/sommer`)]);
    expect(
      guard.check("**Alle 9 Kurse im Sommer in X**", `${HOST}/kurse/sommer`)
    ).toBeNull();
    expect(
      guard.check("**Alle 9 Kurse in Sommer**", `${HOST}/kurse/sommer`, {
        lineStart: true,
      })
    ).toEqual({
      remove: false,
      text: "**Alle 9 Kurse in Sommer**",
      line: null,
    });
  });

  test("mehrere Knoten mit gleicher Adresse: der, dessen Kettenzeile im Kontext steht", () => {
    const data = mapData();
    data.nodes["Sprachen \\ Englisch"].count = 9;
    const map = parse(data);
    const texts = [
      courseText({ path: "Sprachen \\ Englisch \\ Konversation" }),
    ];
    const guard = createOverviewLinkGuard({
      contextTexts: applyCategoryChains(texts, map),
      map,
    });
    // Kette: Ebene 2 „Englisch (9 Kurse)“ zuerst, dann Ebene 3 „Konversation“
    expect(
      guard.check(
        "Alle Kurse in Englisch",
        `${HOST}/kursprogramm/sprachen/englisch`
      ).text
    ).toBe("Englisch (9 Kurse)");
  });
});
