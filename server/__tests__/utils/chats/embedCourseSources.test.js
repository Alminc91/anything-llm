/* eslint-env jest, node */
// Kurskarten im Embed-Widget: Ableitung der courseSources aus den Quellen einer
// Antwort (reine Funktion). Fixture = echte Treffer von praesentation
// (Vektorsuche "Yoga am Abend", "Anmeldung Kontakt Öffnungszeiten", Kurs-
// dokumente Donau + Bergisch-Land-Klon, Stand 05.10.2026).

const {
  courseCardsEnabled,
  buildCourseSources,
  sanitizeCourseSources,
  __test__: { COURSE_SOURCE_FIELDS, pickCourseFields },
} = require("../../../utils/chats/embedCourseSources");
const fixtures = require("./fixtures/praesentationSources.json");

const FORBIDDEN = [
  "text",
  "pageContent",
  "chunkSource",
  "docSource",
  "docAuthor",
  "description",
  "published",
  "wordCount",
  "token_count_estimate",
  "score",
  "_distance",
  "vector",
];

const clone = (v) => JSON.parse(JSON.stringify(v));

describe("courseCardsEnabled (Gate visual_config.courseCards)", () => {
  test("nur 'auto' schaltet ein (String aus der DB und Objekt)", () => {
    expect(
      courseCardsEnabled({ visual_config: '{"courseCards":"auto"}' })
    ).toBe(true);
    expect(
      courseCardsEnabled({ visual_config: { courseCards: " Auto " } })
    ).toBe(true);
  });

  test.each([
    [undefined],
    [null],
    [""],
    ["{}"],
    ['{"courseCards":"off"}'],
    ['{"courseCards":true}'],
    ['{"courseCards":"on"}'],
    ["kein json"],
  ])("aus bei visual_config=%p", (visual_config) => {
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    expect(courseCardsEnabled({ visual_config })).toBe(false);
    spy.mockRestore();
  });

  test("unlesbares visual_config wird mit Präfix geloggt", () => {
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    expect(courseCardsEnabled({ visual_config: "{kaputt" })).toBe(false);
    expect(spy).toHaveBeenCalledWith(
      "[courseCardsEnabled] visual_config unparsable",
      expect.any(String)
    );
    spy.mockRestore();
  });

  test("ohne Embed-Objekt aus", () => {
    expect(courseCardsEnabled(undefined)).toBe(false);
    expect(courseCardsEnabled(null)).toBe(false);
  });
});

describe("buildCourseSources", () => {
  test("whitelist: nur die zehn Kursfelder, niemals text/pageContent/chunkSource/docSource", () => {
    const result = buildCourseSources(
      clone(fixtures.donauYogaCategoryAndCourses)
    );
    expect(result.length).toBeGreaterThan(0);
    for (const entry of result) {
      for (const key of Object.keys(entry))
        expect(COURSE_SOURCE_FIELDS).toContain(key);
      for (const key of FORBIDDEN) expect(entry).not.toHaveProperty(key);
    }
    // Kein Fragment des Kontexttexts im serialisierten Ergebnis
    const json = JSON.stringify(result);
    expect(json).not.toMatch(/Kursbeschreibung|document_metadata|Kursleitung/);
  });

  test("echte Kursdokumente: url/title aus 'Kurs-Link:'/'Titel:' statt file://-Slug", () => {
    const result = buildCourseSources(
      clone(fixtures.donauYogaCategoryAndCourses)
    );
    expect(result).toEqual([
      {
        url: "https://aw.donau.kufer.de/kurssuche/kurs/yoga-aufbaukurs/262-3103",
        title: "Yoga (Aufbaukurs)",
        start_date: "2026-09-14",
        end_date: "2026-12-28",
        start_minutes: 1080,
        weekdays: ",mon,",
        price: 60,
        bookable: true,
        format: "onsite",
      },
      {
        url: "https://aw.donau.kufer.de/kurssuche/kurs/yoga-fuer-anfaenger-innen-und-teilnehmer-innen-mit-etwas-vorerfahrung/262-3102",
        title: "Yoga",
        start_date: "2026-11-03",
        end_date: "2027-01-19",
        start_minutes: 990,
        weekdays: ",tue,",
        price: 40,
        bookable: true,
        format: "onsite",
      },
    ]);
  });

  test("Info- und Kategorieseiten ohne Kursdaten ergeben keine Einträge", () => {
    expect(buildCourseSources(clone(fixtures.infoPagesOnly))).toEqual([]);
    const categoryOnly = fixtures.donauYogaCategoryAndCourses.filter(
      (s) => !s.start_date
    );
    expect(categoryOnly.length).toBeGreaterThan(0);
    expect(buildCourseSources(clone(categoryOnly))).toEqual([]);
  });

  test("Kurs = Kurs-URL + Titel; Datum/Wochentage sind nur Anreicherung", () => {
    const [course] = clone(fixtures.donauEnglish);
    // Kunde ohne KIE-480-Spalten: keine Datums-/Wochentagsfelder
    const noDate = { ...course, start_date: undefined, weekdays: undefined };
    const weekdaysOnly = {
      ...clone(fixtures.donauEnglish[1]),
      start_date: undefined,
    };
    const noLink = {
      ...clone(fixtures.donauEnglish[2]),
      text: "Titel: Englisch 1\nKursnummer: 262-4601C",
    };
    const noTitle = {
      ...clone(fixtures.donauEnglish[3]),
      text: "Kurs-Link: https://aw.donau.kufer.de/kurssuche/kurs/english-i/262-4605",
    };
    const result = buildCourseSources([noDate, weekdaysOnly, noLink, noTitle]);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      url: "https://aw.donau.kufer.de/kurssuche/kurs/englisch-1/262-4601A",
      title: "Englisch 1",
    });
    expect(result[0]).not.toHaveProperty("start_date");
    expect(result[0]).not.toHaveProperty("weekdays");
    expect(result[1].url).toMatch(/262-4601B$/);
    expect(result[1].weekdays).toBe(",mon,");
    expect(result[1]).not.toHaveProperty("start_date");
  });

  test("Kurs ganz ohne KIE-480-Spalten (nur Kopfzeilen) ergibt einen Eintrag", () => {
    const result = buildCourseSources([
      {
        url: "file://vhs-x-kurs-englisch-a2.txt",
        title: "vhs-x-kurs-englisch-a2.txt",
        chunkSource: "vhs-x-kurs-englisch-a2.txt",
        text: "Titel: Englisch A2\nKurs-Link: https://www.vhs-x.de/kurse/26H-40124-englisch-a2\nKursbeschreibung: …",
      },
    ]);
    expect(result).toEqual([
      {
        url: "https://www.vhs-x.de/kurse/26H-40124-englisch-a2",
        title: "Englisch A2",
      },
    ]);
  });

  test("gleicher Dateiname, verschiedene Kurs-Links -> zwei Einträge mit jeweils eigenen Feldern", () => {
    const shared = {
      url: "file://kurs-yoga.txt",
      title: "kurs-yoga.txt",
      chunkSource: "kurs-yoga.txt",
    };
    const a = {
      ...shared,
      text: "Titel: Yoga am Morgen\nKurs-Link: https://www.vhs-x.de/kurs/yoga/100",
      start_date: "2026-10-01",
      start_minutes: 540,
      price: 50,
    };
    const b = {
      ...shared,
      text: "Titel: Yoga am Abend\nKurs-Link: https://www.vhs-x.de/kurs/yoga/200",
      start_date: "2026-11-01",
      start_minutes: 1110,
      price: 70,
    };
    // Folge-Chunk ohne Kopfzeilen: Ersatz-Schlüssel ist mehrdeutig -> verworfen
    const follow = { ...shared, text: "… zweiter Abschnitt …", price: 999 };
    expect(buildCourseSources([a, follow, b])).toEqual([
      {
        url: "https://www.vhs-x.de/kurs/yoga/100",
        title: "Yoga am Morgen",
        start_date: "2026-10-01",
        start_minutes: 540,
        price: 50,
      },
      {
        url: "https://www.vhs-x.de/kurs/yoga/200",
        title: "Yoga am Abend",
        start_date: "2026-11-01",
        start_minutes: 1110,
        price: 70,
      },
    ]);
  });

  test("Folge-Chunk vor dem Kopf-Chunk erbt die URL über eindeutigen chunkSource", () => {
    const [course] = clone(fixtures.donauEnglish);
    const follow = { ...course, text: "… ohne Kopfzeilen …" };
    const result = buildCourseSources([follow, course]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      url: "https://aw.donau.kufer.de/kurssuche/kurs/englisch-1/262-4601A",
      title: "Englisch 1",
    });
  });

  test("Titel über 200 Zeichen wird gekürzt statt verworfen", () => {
    const longTitle = `Orthopädische Yoga-Therapie ${"für reifere Erwachsene ".repeat(12)}Ende`;
    expect(longTitle.length).toBeGreaterThan(200);
    const [entry] = buildCourseSources([
      {
        chunkSource: "lang.txt",
        text: `Titel: ${longTitle}\nKurs-Link: https://www.vhs-x.de/kurs/lang/1`,
      },
    ]);
    expect(entry.url).toBe("https://www.vhs-x.de/kurs/lang/1");
    expect(entry.title.length).toBeLessThanOrEqual(200);
    expect(entry.title.endsWith("…")).toBe(true);
    expect(longTitle.startsWith(entry.title.slice(0, -1))).toBe(true);
  });

  test("Collector-Form web://<url>.website wird zur https-URL", () => {
    const [entry] = buildCourseSources([
      {
        url: "web://https://www.vhs-x.de/kurssuche/kurs/hatha-yoga/123.website",
        title: "Hatha Yoga",
        text: "",
        start_date: "2026-10-01",
      },
    ]);
    expect(entry).toEqual({
      url: "https://www.vhs-x.de/kurssuche/kurs/hatha-yoga/123",
      title: "Hatha Yoga",
      start_date: "2026-10-01",
    });
    expect(
      buildCourseSources([
        { url: "web://javascript:alert(1).website", title: "X", text: "" },
      ])
    ).toEqual([]);
  });

  test("gecrawlte Seiten (nur chunkSource link://, kein Kurs-Link:) sind keine Kurse", () => {
    expect(
      buildCourseSources([
        {
          url: "file://www.vhs-x.de_kurse_sprachen.html",
          title: "Sprachen",
          chunkSource: "link://https://www.vhs-x.de/kurse/sprachen",
          text: "Sprachen – alle Kurse",
        },
      ])
    ).toEqual([]);
  });

  test("Dedupe über url: mehrere Chunks derselben Kursseite -> ein Eintrag (erster gewinnt)", () => {
    const [course] = clone(fixtures.donauEnglish);
    // Folge-Chunk derselben Datei ohne Kopfzeilen (url/title kommen vom ersten)
    const followChunk = {
      ...course,
      price: 999,
      text: "Kursbeschreibung: … zweiter Abschnitt ohne Kopfzeilen …",
    };
    const result = buildCourseSources([course, followChunk, clone(course)]);
    expect(result).toHaveLength(1);
    expect(result[0].price).toBe(60);
  });

  test("höchstens 12 Einträge", () => {
    const base = clone(fixtures.bergischYoga[0]);
    const many = Array.from({ length: 20 }, (_, i) => ({
      ...base,
      title: `datei-${i}.txt`,
      text: `Titel: Kurs ${i}\nKurs-Link: https://www.vhs-bergisch-land.de/kurssuche/kurs/kurs-${i}/${1000 + i}`,
    }));
    const result = buildCourseSources(many);
    expect(result).toHaveLength(12);
    expect(result[0].title).toBe("Kurs 0");
    expect(result[11].title).toBe("Kurs 11");
  });

  test("ungültige Feldwerte fallen weg statt durchgereicht zu werden", () => {
    const [course] = clone(fixtures.donauEnglish);
    const result = buildCourseSources([
      {
        ...course,
        price: "60,00",
        start_minutes: 99999,
        format: "irgendwo",
        location: "<script>",
        bookable: "ja",
        end_date: "16.12.2026",
      },
    ]);
    expect(Object.keys(result[0]).sort()).toEqual(
      ["start_date", "title", "url", "weekdays"].sort()
    );
  });

  test("BigInt aus LanceDB (start_minutes) wird zur Zahl", () => {
    const [course] = clone(fixtures.donauEnglish);
    const result = buildCourseSources([
      { ...course, start_minutes: BigInt(990) },
    ]);
    expect(result[0].start_minutes).toBe(990);
    expect(() => JSON.stringify(result)).not.toThrow();
  });

  test("http(s)-url aus den Metadaten hat Vorrang, file:// nie", () => {
    const [course] = clone(fixtures.donauEnglish);
    const withUrl = {
      ...course,
      url: "https://www.example-vhs.de/kurs/123",
      title: "Englisch 1 kompakt",
      text: "",
    };
    expect(buildCourseSources([withUrl])[0]).toMatchObject({
      url: "https://www.example-vhs.de/kurs/123",
      title: "Englisch 1 kompakt",
    });
    const fileOnly = { ...course, text: "" };
    expect(buildCourseSources([fileOnly])).toEqual([]);
  });

  test("leere/ungültige Eingaben", () => {
    expect(buildCourseSources()).toEqual([]);
    expect(buildCourseSources(null)).toEqual([]);
    expect(buildCourseSources([null, 1, "x"])).toEqual([]);
  });
});

describe("sanitizeCourseSources (Historie, Abwehr in der Tiefe)", () => {
  test("entfernt Fremdfelder und Einträge ohne Kursdaten", () => {
    const stored = [
      {
        url: "https://aw.donau.kufer.de/kurssuche/kurs/englisch-1/262-4601A",
        title: "Englisch 1",
        start_date: "2026-09-09",
        text: "geheimer Kontext",
        chunkSource: "x.txt",
      },
      // ohne Titel bzw. ohne http-URL: kein Kurs
      { url: "https://aw.donau.kufer.de/kontakt" },
      { url: "file://kontakt.txt", title: "Kontakt" },
    ];
    expect(sanitizeCourseSources(stored)).toEqual([
      {
        url: "https://aw.donau.kufer.de/kurssuche/kurs/englisch-1/262-4601A",
        title: "Englisch 1",
        start_date: "2026-09-09",
      },
    ]);
    expect(sanitizeCourseSources(undefined)).toEqual([]);
    expect(sanitizeCourseSources("x")).toEqual([]);
  });

  test.each([[["x"]], [[1]], [[true]], [[null]], [[["verschachtelt"]]]])(
    "Altdaten mit Primitiven werfen nicht: %p",
    (stored) => {
      expect(() => sanitizeCourseSources(stored)).not.toThrow();
      expect(sanitizeCourseSources(stored)).toEqual([]);
    }
  );

  test("pickCourseFields mit Nicht-Objekten -> {}", () => {
    for (const value of ["x", 1, true, null, undefined])
      expect(pickCourseFields(value)).toEqual({});
  });
});
