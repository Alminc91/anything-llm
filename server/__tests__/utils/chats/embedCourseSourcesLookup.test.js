/* eslint-env jest, node */
// Kurskarten v2: verlinkte Kurse ohne Treffer-Dokument nachschlagen
// (completeCourseSourcesFromReply) und Marker-Nummern auflösen
// (resolveMarkerCourses). Dokumente = echte Kursdokumente von demo-inline
// (05.10.2026, Text gekürzt); Dateizugriffe laufen über injizierte Spies.

const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  buildCourseSources,
  completeCourseSourcesFromReply,
  resolveMarkerCourses,
  createCourseLookup,
  __test__: {
    COURSE_SOURCE_FIELDS,
    COURSE_LOOKUPS_MAX,
    courseEntryFromDocument,
    extractReplyLinks,
    findDocpathCandidates,
    findDocpathForChunk,
    findDocpathForUrl,
    safeDocumentFile,
    urlSlugify,
  },
} = require("../../../utils/chats/embedCourseSources");
const { documents } = require("./fixtures/demoInlineCourseDocuments.json");
const sourcesFixture = require("./fixtures/praesentationSources.json");

const clone = (v) => JSON.parse(JSON.stringify(v));
const BASE = "https://aw.donau.kufer.de/kurssuche/kurs";
const DOCS_ROOT = path.resolve("/srv/storage/documents");
const AEROBIC_URL = `${BASE}/aerobic/262-3208`;
const GYM_URL = `${BASE}/spielerische-gymnastik-fuer-eltern-und-kind/262-3204`;
const SPORT_URL = `${BASE}/sport-am-familienwochenende/262-3217`;
const docpathOf = (needle) =>
  Object.keys(documents).find((dp) => dp.includes(needle));

// Bereits vorhandene courseSources (aus den Treffern): Gymnastik + Sport
const PRESENT = [
  {
    url: GYM_URL,
    title: "Spielerische Gymnastik für Eltern und Kind",
    start_date: "2026-10-09",
  },
  {
    url: SPORT_URL,
    title: "Sport am Familienwochenende",
    start_date: "2027-01-23",
  },
];

const REPLY_SPORT = [
  "Ja, es gibt passende Sportkurse:",
  `1. [**Aerobic**](${AEROBIC_URL}) – vormittags`,
  `2. [**Spielerische Gymnastik für Eltern und Kind**](${GYM_URL})`,
  `3. [**Sport am Familienwochenende**](${SPORT_URL})`,
  "Mehr unter [**Gesundheit**](https://aw.donau.kufer.de/programm/gesundheit).",
].join("\n");

// Spies: Dokumentliste + Dateizugriff; Inhalte aus der Fixture
function makeDeps({ docs = documents, extraDocpaths = [] } = {}) {
  const byFile = new Map(
    Object.entries(docs).map(([dp, doc]) => [
      path.resolve(DOCS_ROOT, dp),
      JSON.stringify(doc),
    ])
  );
  return {
    documentsPath: DOCS_ROOT,
    listDocpaths: jest.fn(async () => [...Object.keys(docs), ...extraDocpaths]),
    readFile: jest.fn(async (full) => {
      if (!byFile.has(full)) throw new Error(`ENOENT ${full}`);
      return byFile.get(full);
    }),
  };
}

describe("urlSlugify (Nachbau python-slugify 8, manifest.py)", () => {
  // Referenzwerte: python-slugify 8.0.4, slugify(url, max_length=150),
  // danach removeprefix("https-")
  test.each([
    [AEROBIC_URL, "aw-donau-kufer-de-kurssuche-kurs-aerobic-262-3208"],
    [
      "https://www.vhs-x.de/kurs/Töpfern für Anfänger/26A-1001?x=1&y=ß",
      "www-vhs-x-de-kurs-topfern-fur-anfanger-26a-1001-x-1-y-ss",
    ],
    ["https://vhs.de/kurs/éte_l'été/26-1", "vhs-de-kurs-ete-l-ete-26-1"],
    ["https://vhs.de/a,b/1,5/Ærø/€uro/&amp;x", "vhs-de-a-b-15-aero-eururo-x"],
  ])("%s", (url, slug) => {
    expect(urlSlugify(url)).toBe(slug);
  });

  test("kürzt auf 150 Zeichen inklusive 'https-'", () => {
    const slug = urlSlugify(`https://vhs.de/kurs/${"a".repeat(200)}/1`);
    expect(slug).toHaveLength(144);
    expect(slug).toMatch(/^vhs-de-kurs-a+$/);
  });
});

describe("Dateiname-Match (Slug + Kursnummer-Segment)", () => {
  const DPS = Object.keys(documents);

  test("exakter Treffer inkl. Inhalts-Hash und UUID", () => {
    expect(findDocpathForUrl(AEROBIC_URL, DPS)).toBe(docpathOf("aerobic"));
    // Modelle schreiben URLs gern mit "www." oder Schluss-Slash
    expect(
      findDocpathForUrl(
        "https://www.aw.donau.kufer.de/kurssuche/kurs/aerobic/262-3208/",
        DPS
      )
    ).toBe(docpathOf("aerobic"));
  });

  test("ähnlicher Slug, andere Kursnummer -> kein Treffer", () => {
    expect(findDocpathForUrl(`${BASE}/aerobic/262-3207`, DPS)).toBeNull();
    expect(
      findDocpathForUrl(`${BASE}/leichtes-aerobic/262-3208`, DPS)
    ).toBeNull();
    // Präfix eines längeren Slugs ist kein Treffer
    expect(
      findDocpathForUrl(`${BASE}/aerobic/262-3208`, [
        "custom-documents/raw-aw-donau-kufer-de-kurssuche-kurs-aerobic-262-3208-1-19300e4d19e4c2b3-0e87c26e-5b24-428f-8a7b-f6fc044bc9d7.json",
      ])
    ).toBeNull();
  });

  test("Dateiname ohne 'www-' (Pipeline entfernt es nach dem Kürzen)", () => {
    const url =
      "https://www.vhs-bergisch-land.de/kurssuche/kurs/aktuelles-zur-einkommensteuererklaerung-2026-und-die-steuererklaerung-in-elster-vortrag-mit-diskussion/27125504S";
    const dp =
      "custom-documents/raw-vhs-bergisch-land-de-kurssuche-kurs-aktuelles-zur-einkommensteuererklaerung-2026-und-die-steuererklaerung-in-elster-vortrag-mit-diskussion-2-e0382c7b6abefc50-dbdd9c9c-175b-45e3-bde5-73cf81926e18.json";
    // gekürzter Slug: Kursnummer fehlt im Dateinamen -> nur Kandidat
    expect(findDocpathCandidates(url, [dp])).toEqual([dp]);
  });

  test("Kursnummer nicht im letzten Segment (Wolfsburg)", () => {
    const url =
      "https://www.bildungshaus-wolfsburg.de/vhs-kurse/kw/bereich/kursdetails/kurs/261305028/kursname/wild-verliebt";
    const dp =
      "custom-documents/raw-bildungshaus-wolfsburg-de-vhs-kurse-kw-bereich-kursdetails-kurs-261305028-kursname-wild-verliebt-49d646b671b8a1b2-1a0a8a8a-0000-4000-8000-000000000001.json";
    expect(findDocpathForUrl(url, [dp])).toBe(dp);
  });

  test("Dateiname ohne Inhalts-Hash (älteres Format)", () => {
    const dp =
      "custom-documents/raw-www-vhs-bergisch-land-de-kurssuche-kurs-hatha-yoga-26266236w-1fd47cf3-64b5-4602-b1bb-a147926011d0.json";
    expect(
      findDocpathForUrl(
        "https://www.vhs-bergisch-land.de/kurssuche/kurs/hatha-yoga/26266236W",
        [dp]
      )
    ).toBe(dp);
  });
});

describe("completeCourseSourcesFromReply", () => {
  test("AK-1: dritter verlinkter Kurs (aus einer Kategorieseite) wird nachgeschlagen", async () => {
    const deps = makeDeps();
    const out = await completeCourseSourcesFromReply({
      replyText: REPLY_SPORT,
      courseSources: clone(PRESENT),
      workspace: { id: 7 },
      deps,
    });
    expect(out.map((c) => c.url)).toEqual([GYM_URL, SPORT_URL, AEROBIC_URL]);
    expect(out[2]).toEqual({
      url: AEROBIC_URL,
      title: "Aerobic",
      start_date: "2026-10-05",
      start_minutes: 690,
      weekdays: ",mon,",
      price: 35,
      bookable: true,
      format: "onsite",
      // Kurskarten v3: aus "Dauer:"/"Kursort:" des gelesenen Dokuments
      sessions: "4 vorm.",
      venue: "Realschule",
    });
    expect(deps.listDocpaths).toHaveBeenCalledWith({ id: 7 });
    expect(deps.readFile).toHaveBeenCalledTimes(1);
    expect(deps.readFile).toHaveBeenCalledWith(
      path.resolve(DOCS_ROOT, docpathOf("aerobic"))
    );
  });

  test("NAK-1: Eintrag enthält nur Whitelist-Felder, nie text/pageContent", async () => {
    const docs = clone(documents);
    const dp = docpathOf("aerobic");
    Object.assign(docs[dp], {
      text: "geheimer Kontext",
      vector: [1, 2],
      score: 0.9,
    });
    const out = await completeCourseSourcesFromReply({
      replyText: REPLY_SPORT,
      courseSources: clone(PRESENT),
      deps: makeDeps({ docs }),
    });
    const added = out[2];
    for (const key of Object.keys(added))
      expect(COURSE_SOURCE_FIELDS).toContain(key);
    expect(JSON.stringify(out)).not.toMatch(
      /Kursbeschreibung|geheimer Kontext|Kursleitung|chunkSource|docSource|file:\/\//
    );
  });

  test("kein Dokument zum Link -> keine Karte, kein Dateizugriff", async () => {
    const deps = makeDeps();
    const reply = `Siehe [Töpfern](${BASE}/toepfern/262-9999) und [Gymnastik](${GYM_URL}).`;
    const out = await completeCourseSourcesFromReply({
      replyText: reply,
      courseSources: clone(PRESENT),
      deps,
    });
    expect(out).toEqual(PRESENT);
    expect(deps.listDocpaths).toHaveBeenCalledTimes(1);
    expect(deps.readFile).not.toHaveBeenCalled();
  });

  test("fremde Domain mit gleichem Slug: Dokument wird gelesen, Kurs-Link passt nicht -> keine Karte", async () => {
    const deps = makeDeps();
    // aw-donau.kufer.de ergibt denselben Slug wie aw.donau.kufer.de; ohne
    // Host-Filter (Multi-Site) schützt der exakte Kurs-Link-Vergleich
    const reply = `[Aerobic](https://aw-donau.kufer.de/kurssuche/kurs/aerobic/262-3208)`;
    const out = await completeCourseSourcesFromReply({
      replyText: reply,
      courseSources: clone(PRESENT),
      deps,
    });
    expect(out).toEqual(PRESENT);
    expect(deps.readFile).toHaveBeenCalledTimes(1);
  });

  test("ohne courseSources: Kundendomain = Kurs-Link des Workspace-Dokuments", async () => {
    const deps = makeDeps();
    const ok = await completeCourseSourcesFromReply({
      replyText: `[Aerobic](${AEROBIC_URL})`,
      courseSources: [],
      deps,
    });
    expect(ok.map((c) => c.title)).toEqual(["Aerobic"]);

    // gleicher Slug auf anderer Domain: Dokument wird gelesen, aber sein
    // Kurs-Link passt nicht -> verworfen
    const deps2 = makeDeps();
    const foreign = await completeCourseSourcesFromReply({
      replyText:
        "[Aerobic](https://aw-donau.kufer.de/kurssuche/kurs/aerobic/262-3208)",
      courseSources: [],
      deps: deps2,
    });
    expect(foreign).toEqual([]);
  });

  test("AK-5 lookup-limit-and-domain: 7 Kurslinks, 1 fremd -> höchstens 5 Nachschläge", async () => {
    const docs = {};
    const links = [];
    for (let i = 1; i <= 7; i++) {
      const num = `262-90${i}0`;
      const url = `${BASE}/kurs-nummer-${i}/${num}`;
      const dp = `custom-documents/raw-aw-donau-kufer-de-kurssuche-kurs-kurs-nummer-${i}-${num}-0123456789abcde${i}-0e87c26e-5b24-428f-8a7b-f6fc044bc9d${i}.json`;
      docs[dp] = {
        title: "x.txt",
        start_date: "2026-11-0" + i,
        pageContent: `Titel: Kurs ${i}\nKurs-Link: ${url}\nKursbeschreibung: …`,
      };
      links.push(
        i === 4 ? url.replace("aw.donau.kufer.de", "vhs-fremd.de") : url
      );
    }
    const deps = makeDeps({ docs });
    const reply = links
      .map((u, i) => `${i + 1}. [Kurs ${i + 1}](${u})`)
      .join("\n");
    const out = await completeCourseSourcesFromReply({
      replyText: reply,
      courseSources: clone(PRESENT),
      deps,
    });
    expect(deps.readFile).toHaveBeenCalledTimes(COURSE_LOOKUPS_MAX);
    const read = deps.readFile.mock.calls.map(([p]) => p).join("\n");
    expect(read).not.toMatch(/kurs-nummer-4-/);
    expect(out.map((c) => c.title)).toEqual([
      "Spielerische Gymnastik für Eltern und Kind",
      "Sport am Familienwochenende",
      "Kurs 1",
      "Kurs 2",
      "Kurs 3",
      "Kurs 5",
      "Kurs 6",
    ]);

    // Gesamtlimit 12: bei 9 vorhandenen Einträgen kommen höchstens 3 dazu
    const nine = Array.from({ length: 9 }, (_, i) => ({
      url: `${BASE}/vorhanden-${i}/262-80${i}0`,
      title: `Vorhanden ${i}`,
    }));
    const deps2 = makeDeps({ docs });
    const capped = await completeCourseSourcesFromReply({
      replyText: reply,
      courseSources: nine,
      deps: deps2,
    });
    expect(capped).toHaveLength(12);
    expect(deps2.readFile).toHaveBeenCalledTimes(3);
  });

  test("Cache je Antwort: derselbe Kurs zweimal verlinkt + Marker -> ein Dateizugriff", async () => {
    const deps = makeDeps();
    const lookup = createCourseLookup({ deps });
    // Folge-Chunk des Aerobic-Dokuments ohne Kopfzeilen
    const chunk = {
      title:
        "aw-donau-kufer-de-kurssuche-kurs-aerobic-262-3208-19300e4d19e4c2b3.txt",
      chunkSource:
        "aw-donau-kufer-de-kurssuche-kurs-aerobic-262-3208-19300e4d19e4c2b3.txt",
      text: "…zweiter Teil der Kursbeschreibung…",
    };
    const { courseSources: announced } = await resolveMarkerCourses({
      indices: [0],
      contextSources: [chunk],
      lookup,
    });
    expect(announced.map((c) => c.title)).toEqual(["Aerobic"]);
    const out = await completeCourseSourcesFromReply({
      replyText: `[Aerobic](${AEROBIC_URL}) … nochmal ${AEROBIC_URL}`,
      courseSources: announced,
      lookup,
    });
    expect(out).toEqual(announced);
    expect(deps.readFile).toHaveBeenCalledTimes(1);
    expect(deps.listDocpaths).toHaveBeenCalledTimes(1);

    // gleiche URL zweimal ohne vorhandenen Eintrag -> ein Zugriff
    const deps2 = makeDeps();
    const lookup2 = createCourseLookup({ deps: deps2 });
    await completeCourseSourcesFromReply({
      replyText: `${AEROBIC_URL} und [Aerobic](${AEROBIC_URL}/)`,
      courseSources: [],
      lookup: lookup2,
    });
    await completeCourseSourcesFromReply({
      replyText: `[Aerobic](${AEROBIC_URL})`,
      courseSources: [],
      lookup: lookup2,
    });
    expect(deps2.readFile).toHaveBeenCalledTimes(1);
    expect(lookup2.stats.cacheHits).toBe(1);
  });

  test("AK-6: alle verlinkten Kurse vorhanden -> 0 Zugriffe (Liste und Datei)", async () => {
    const deps = makeDeps();
    const all = [...clone(PRESENT), { url: AEROBIC_URL, title: "Aerobic" }];
    const started = process.hrtime.bigint();
    const out = await completeCourseSourcesFromReply({
      replyText: REPLY_SPORT,
      courseSources: all,
      deps,
    });
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    expect(out).toEqual(all);
    expect(deps.listDocpaths).not.toHaveBeenCalled();
    expect(deps.readFile).not.toHaveBeenCalled();
    expect(ms).toBeLessThan(50);
  });

  test("Dokument unlesbar/kaputt -> kein Eintrag, kein Fehler", async () => {
    const deps = makeDeps();
    deps.readFile.mockImplementation(async () => "{kein json");
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    const out = await completeCourseSourcesFromReply({
      replyText: REPLY_SPORT,
      courseSources: clone(PRESENT),
      deps,
    });
    spy.mockRestore();
    expect(out).toEqual(PRESENT);
  });
});

describe("NAK-3: kein Zugriff außerhalb von documents/<ordner>/", () => {
  test.each([
    ["../../etc/passwd.json"],
    ["custom-documents/../../etc/passwd.json"],
    ["/etc/passwd.json"],
    ["custom-documents/sub/x.json"],
    ["../custom-documents/x.json"],
    [".hidden/x.json"],
    ["custom-documents/..json"],
    ["custom-documents/x.txt"],
    ["custom-documents\\..\\x.json"],
    ["custom-documents/x%2F..%2Fy.json"],
    [""],
    [null],
  ])("safeDocumentFile(%p) -> null", (docpath) => {
    expect(safeDocumentFile(docpath, DOCS_ROOT)).toBeNull();
  });

  test("gültiger Pfad bleibt innerhalb des Dokumentordners", () => {
    expect(safeDocumentFile("custom-documents/raw-a-1.json", DOCS_ROOT)).toBe(
      path.join(DOCS_ROOT, "custom-documents", "raw-a-1.json")
    );
  });

  test("Links mit '..', '/' oder Sonderzeichen führen nie zu einem Zugriff außerhalb", async () => {
    const evil = [
      "../../etc/passwd.json",
      "custom-documents/../../../etc/raw-aw-donau-kufer-de-etc-passwd-0e87c26e-5b24-428f-8a7b-f6fc044bc9d7.json",
    ];
    const deps = makeDeps({ extraDocpaths: evil });
    const reply = [
      `[a](${BASE}/../../../../etc/passwd)`,
      `[b](${BASE}/%2e%2e%2f%2e%2e%2fetc/passwd)`,
      `[c](${BASE}/aerobic/..%2F..%2F262-3208)`,
      `[d](https://aw.donau.kufer.de/etc/passwd)`,
    ].join(" ");
    const out = await completeCourseSourcesFromReply({
      replyText: reply,
      courseSources: clone(PRESENT),
      deps,
    });
    expect(out).toEqual(PRESENT);
    for (const [full] of deps.readFile.mock.calls)
      expect(
        full.startsWith(path.join(DOCS_ROOT, "custom-documents") + path.sep)
      ).toBe(true);
  });

  test("echter Dateizugriff (Standard-readFile) nur im Dokumentordner", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-lookup-"));
    try {
      const folder = path.join(root, "documents", "custom-documents");
      fs.mkdirSync(folder, { recursive: true });
      const dp = docpathOf("aerobic");
      fs.writeFileSync(
        path.join(root, "documents", dp),
        JSON.stringify(documents[dp])
      );
      // Datei außerhalb des Dokumentordners mit passendem Namen
      fs.writeFileSync(
        path.join(root, path.basename(dp)),
        JSON.stringify({
          pageContent: "Titel: Falle\nKurs-Link: " + AEROBIC_URL,
        })
      );
      const readSpy = jest.spyOn(fs.promises, "readFile");
      const out = await completeCourseSourcesFromReply({
        replyText: `[Aerobic](${AEROBIC_URL})`,
        courseSources: clone(PRESENT),
        deps: {
          documentsPath: path.join(root, "documents"),
          listDocpaths: async () => [`../${path.basename(dp)}`, dp],
        },
      });
      expect(out[2].title).toBe("Aerobic");
      expect(readSpy).toHaveBeenCalledTimes(1);
      expect(readSpy.mock.calls[0][0]).toBe(path.join(root, "documents", dp));
      readSpy.mockRestore();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("resolveMarkerCourses (Nummern = [CONTEXT n], 0-basiert)", () => {
  const SOURCES = sourcesFixture.donauYogaCategoryAndCourses;
  const entries = buildCourseSources(clone(SOURCES));

  test("Nummern in Marker-Reihenfolge, Nicht-Kurse und ungültige Nummern fallen weg", async () => {
    const deps = makeDeps();
    const courseIdx = SOURCES.map((s, i) =>
      /Kurs-Link:/.test(s.text || "") ? i : -1
    ).filter((i) => i >= 0);
    const infoIdx = SOURCES.findIndex(
      (s) =>
        !/Kurs-Link:/.test(s.text || "") &&
        /link:\/\//.test(s.chunkSource || "")
    );
    const indices = [courseIdx[1], 99, infoIdx, courseIdx[0], courseIdx[1]];
    const { courseSources: out } = await resolveMarkerCourses({
      indices,
      contextSources: clone(SOURCES),
      deps,
    });
    expect(out.map((c) => c.url)).toEqual(
      [courseIdx[1], courseIdx[0]].map(
        (i) => buildCourseSources([clone(SOURCES[i])])[0].url
      )
    );
    expect(entries.length).toBeGreaterThanOrEqual(2);
    // Kopfzeilen reichen: kein Dateizugriff; Kategorieseite (link://) ohne
    // Slug-Dateinamen: auch kein Zugriff
    expect(deps.readFile).not.toHaveBeenCalled();
  });

  test("leere Liste / '-' -> keine Einträge, kein Zugriff", async () => {
    const deps = makeDeps();
    const { courseSources, urlByIndex } = await resolveMarkerCourses({
      indices: [],
      contextSources: SOURCES,
      deps,
    });
    expect(courseSources).toEqual([]);
    expect(urlByIndex.size).toBe(0);
    expect(deps.listDocpaths).not.toHaveBeenCalled();
  });
});

describe("Hilfsfunktionen", () => {
  test("extractReplyLinks: Markdown, <a href>, nackte URLs, ohne Dubletten", () => {
    const text = `[**A**](${AEROBIC_URL}). <a href="${GYM_URL}">G</a> ${SPORT_URL}, ${AEROBIC_URL}/`;
    expect(extractReplyLinks(text)).toEqual([AEROBIC_URL, GYM_URL, SPORT_URL]);
  });

  test("courseEntryFromDocument: ohne Kurs-Link (Info-Seite) -> null", () => {
    expect(
      courseEntryFromDocument({ pageContent: "Titel: Kontakt\nTelefon: 123" })
    ).toBeNull();
    expect(courseEntryFromDocument(null)).toBeNull();
  });
});

// Review-Befunde Kurskarten v2 (05.10.2026)
describe("Review: Dateinamen-Formen, Query-Kursnummern, Multi-Site", () => {
  const UUID = "0e87c26e-5b24-428f-8a7b-f6fc044bc9d7";
  const courseDoc = (title, url) => ({
    title: "x.txt",
    pageContent: `Titel: ${title}\nKurs-Link: ${url}\nKursbeschreibung: …`,
  });

  test("Befund 1: Folge-Chunk mit 'www-'-Titel findet Datei ohne 'www-' (Collector)", () => {
    const dp = `custom-documents/raw-vhs-lingen-de-kurse-262-3208-19300e4d19e4c2b3-${UUID}.json`;
    expect(
      findDocpathForChunk(
        { title: "www-vhs-lingen-de-kurse-262-3208-19300e4d19e4c2b3.txt" },
        [dp]
      )
    ).toBe(dp);
    // ältere Dateien behalten "www-"
    const old = `custom-documents/raw-www-vhs-lingen-de-kurse-262-3208-${UUID}.json`;
    expect(
      findDocpathForChunk({ title: "www-vhs-lingen-de-kurse-262-3208.txt" }, [
        old,
      ])
    ).toBe(old);
    // anderer Kurs -> kein Treffer
    expect(
      findDocpathForChunk({ title: "www-vhs-lingen-de-kurse-262-3209.txt" }, [
        dp,
      ])
    ).toBeNull();
  });

  test("Befund 2: webbasys-Link mit ?knr= wird als Kursseite nachgeschlagen", async () => {
    const url =
      "https://www.vhs-x.de/webbasys/index.php?kathaupt=11&knr=262-3209";
    // python-slugify 8.0.4: www-vhs-x-de-webbasys-index-php-kathaupt-11-knr-262-3209
    const dp = `custom-documents/raw-vhs-x-de-webbasys-index-php-kathaupt-11-knr-262-3209-19300e4d19e4c2b3-${UUID}.json`;
    const other = `custom-documents/raw-vhs-x-de-webbasys-index-php-kathaupt-11-knr-262-3210-19300e4d19e4c2b3-${UUID}.json`;
    const deps = makeDeps({
      docs: {
        [dp]: courseDoc("Englisch A1", url),
        [other]: courseDoc("Englisch A2", url.replace("3209", "3210")),
      },
    });
    const out = await completeCourseSourcesFromReply({
      replyText: `Passend: [Englisch A1](${url})`,
      courseSources: [],
      deps,
    });
    expect(out).toEqual([{ url, title: "Englisch A1" }]);
    expect(deps.readFile).toHaveBeenCalledTimes(1);
    expect(deps.readFile).toHaveBeenCalledWith(path.resolve(DOCS_ROOT, dp));

    // Query ohne Kursnummer (Kategorie) -> kein Zugriff
    const deps2 = makeDeps({ docs: { [dp]: courseDoc("Englisch A1", url) } });
    await completeCourseSourcesFromReply({
      replyText:
        "[Sprachen](https://www.vhs-x.de/webbasys/index.php?kathaupt=11)",
      courseSources: [],
      deps: deps2,
    });
    expect(deps2.listDocpaths).not.toHaveBeenCalled();
  });

  test("Befund 3: Multi-Site — Kurs auf zweitem Host wird nachgeschlagen und ergibt Karte", async () => {
    const primary =
      "https://veranstaltungen.bildung-beratung-bethel.de/kurs/yoga/26-1001";
    const second =
      "https://www.bildung-beratung-bethel.de/kurs/pilates/26-2002";
    const dp = `custom-documents/raw-bildung-beratung-bethel-de-kurs-pilates-26-2002-19300e4d19e4c2b3-${UUID}.json`;
    const deps = makeDeps({ docs: { [dp]: courseDoc("Pilates", second) } });
    const out = await completeCourseSourcesFromReply({
      replyText: `[Yoga](${primary}) und [Pilates](${second})`,
      courseSources: [{ url: primary, title: "Yoga" }],
      deps,
    });
    expect(out.map((c) => c.title)).toEqual(["Yoga", "Pilates"]);
    expect(out[1].url).toBe(second);
  });

  test("Befund 7: ungekappter Slug mit 160 Zeichen (Pipeline-Titel bis 200) wird gefunden", () => {
    const url =
      "https://www.vhs-bergisch-land.de/kurssuche/kurs/gesundheitsbildung-entspannung-und-achtsamkeit-im-alltag-praxisworkshop-fuer-berufstaetige-am-abend-mit-uebung/27125505S";
    // python-slugify 8.0.4, run_pipeline.py: 160 Zeichen, ungekappt
    const slug =
      "www-vhs-bergisch-land-de-kurssuche-kurs-gesundheitsbildung-entspannung-und-achtsamkeit-im-alltag-praxisworkshop-fuer-berufstaetige-am-abend-mit-uebung-27125505s";
    expect(slug).toHaveLength(160);
    expect(urlSlugify(url, { maxLength: Infinity })).toBe(slug);
    const dpNew = `custom-documents/raw-${slug.slice(4)}-${UUID}.json`;
    const dpOld = `custom-documents/raw-${slug}-${UUID}.json`;
    expect(findDocpathForUrl(url, [dpNew])).toBe(dpNew);
    expect(findDocpathForUrl(url, [dpOld])).toBe(dpOld);
  });

  test("Befund 8: Index einmal je Nachschlag-Kontext, Treffer wie zuvor", async () => {
    const deps = makeDeps();
    const lookup = createCourseLookup({ deps });
    const [a, b] = await Promise.all([lookup.docIndex(), lookup.docIndex()]);
    expect(a).toBe(b);
    expect(a.count).toBe(Object.keys(documents).length);
    expect(findDocpathForUrl(AEROBIC_URL, a)).toBe(docpathOf("aerobic"));
    expect(deps.listDocpaths).toHaveBeenCalledTimes(1);
  });

  test("Befund 7: Slug über 200 Zeichen -> Pipeline-Kürzung mit '-<course_id>'", () => {
    const url =
      "https://www.vhs-bergisch-land.de/kurssuche/kurs/gesundheitsbildung-entspannung-und-achtsamkeit-im-alltag-praxisworkshop-fuer-berufstaetige-am-abend-mit-anschliessender-gespraechsrunde-uebungen-und-material-zum-mitnehmen/27125507S";
    // python: title[:190] + "-27125507S", Collector: Kleinbuchstaben, ohne "www-"
    const stem =
      "vhs-bergisch-land-de-kurssuche-kurs-gesundheitsbildung-entspannung-und-achtsamkeit-im-alltag-praxisworkshop-fuer-berufstaetige-am-abend-mit-anschliessender-gespraechsrunde-uebungen-und-m-27125507s";
    const dp = `custom-documents/raw-${stem}-${UUID}.json`;
    expect(findDocpathForUrl(url, [dp])).toBe(dp);
  });
});

describe("Security-Sweep: ReDoS, Kopfzeilen nur aus dem Kopfblock, Entities", () => {
  const timed = (fn) => {
    const start = process.hrtime.bigint();
    const result = fn();
    return { result, ms: Number(process.hrtime.bigint() - start) / 1e6 };
  };

  test("ReDoS: 100.000 '[' und 30.000 '<a ' ohne Abschluss laufen linear", () => {
    extractReplyLinks("[x](https://a.de/1)"); // JIT aufwärmen
    // gemessen vorher: 100k '[' ≈ 17 s, 30k '<a ' ≈ 5,6 s; nachher < 50 ms
    const brackets = timed(() => extractReplyLinks("[".repeat(100000)));
    expect(brackets.result).toEqual([]);
    expect(brackets.ms).toBeLessThan(500);
    const anchors = timed(() => extractReplyLinks("<a ".repeat(30000)));
    expect(anchors.result).toEqual([]);
    expect(anchors.ms).toBeLessThan(500);
    // gutartige Links davor/dahinter werden weiter gefunden (bis 20.000 Zeichen)
    const mixed = `[Aerobic](${AEROBIC_URL}) ${"[".repeat(5000)} <a href="${GYM_URL}">Gym</a> ${"<a ".repeat(3000)}`;
    const found = timed(() => extractReplyLinks(mixed));
    expect(found.result).toEqual([AEROBIC_URL, GYM_URL]);
    expect(found.ms).toBeLessThan(500);
  });

  test("ReDoS: nur die ersten 20.000 Zeichen der Antwort werden durchsucht", () => {
    const pad = "x".repeat(20000);
    expect(
      extractReplyLinks(`[A](${AEROBIC_URL}) ${pad} [G](${GYM_URL})`)
    ).toEqual([AEROBIC_URL]);
    // Linktext über 300 Zeichen ist kein Markdown-Link mehr, die URL wird
    // trotzdem als nackte URL gefunden
    expect(extractReplyLinks(`[${"t".repeat(400)}](${AEROBIC_URL})`)).toEqual([
      AEROBIC_URL,
    ]);
  });

  test("Kurs-Link/Titel nur in der Kursbeschreibung -> keine Karte", () => {
    const evil = "https://evil.example/kurs/fake/262-0001";
    const doc = {
      pageContent: [
        "Kursnummer: 262-0001",
        "Kursstatus: Anmeldung möglich",
        "",
        "Kursbeschreibung: Gecrawlter Text …",
        "Titel: Gratis-Gutschein",
        `Kurs-Link: ${evil}`,
      ].join("\n"),
    };
    expect(courseEntryFromDocument(doc)).toBeNull();
    // auch ohne "Kursbeschreibung:": Kopfblock endet an der ersten Leerzeile
    expect(
      courseEntryFromDocument({
        pageContent: `Kursnummer: 1\n\nText\nTitel: X\nKurs-Link: ${evil}`,
      })
    ).toBeNull();
    // Treffer-Chunk mit <document_metadata>-Präfix, Kopfzeilen nur in der
    // Beschreibung
    const chunkText = `<document_metadata>\nsourceDocument: x.txt\n</document_metadata>\n\n${doc.pageContent}`;
    expect(
      buildCourseSources([
        { title: "x.txt", chunkSource: "x.txt", text: chunkText },
      ])
    ).toEqual([]);
    // gültiger Kopfblock mit Präfix funktioniert weiter
    const good = `<document_metadata>\nsourceDocument: x.txt\n</document_metadata>\n\nTitel: Aerobic\nKurs-Link: ${AEROBIC_URL}\n\nKursbeschreibung: …\nKurs-Link: ${evil}`;
    expect(
      buildCourseSources([{ title: "x.txt", chunkSource: "x.txt", text: good }])
    ).toEqual([{ url: AEROBIC_URL, title: "Aerobic" }]);
  });

  test("Lookup: Dokument mit Kurs-Link nur in der Beschreibung -> keine Karte", async () => {
    const docs = clone(documents);
    const dp = docpathOf("aerobic");
    docs[dp].pageContent =
      `Kursnummer: 262-3208\n\nKursbeschreibung: …\nTitel: Aerobic\nKurs-Link: ${AEROBIC_URL}`;
    const out = await completeCourseSourcesFromReply({
      replyText: `[Aerobic](${AEROBIC_URL})`,
      courseSources: [],
      deps: makeDeps({ docs }),
    });
    expect(out).toEqual([]);
  });

  test("Marker-Pfad: Kopfzeile + abweichende Metadaten-URL -> Metadaten-URL gewinnt", async () => {
    const metaUrl = "https://www.vhs-x.de/kurssuche/kurs/hatha-yoga/123";
    const chunk = {
      url: `web://${metaUrl.toLowerCase()}.website`,
      title: "Hatha Yoga",
      text: "Titel: Gratis-Gutschein\nKurs-Link: https://evil.example/kurs/123\nDauer: 1 x\n\nKursbeschreibung: …",
      start_date: "2026-10-01",
    };
    const { courseSources, urlByIndex } = await resolveMarkerCourses({
      indices: [0],
      contextSources: [chunk],
      deps: makeDeps({ docs: {} }),
    });
    // Kopfblock verworfen: URL, Titel und Dauer nicht aus der Kopfzeile
    expect(courseSources).toEqual([
      { url: metaUrl, title: "Hatha Yoga", start_date: "2026-10-01" },
    ]);
    expect(urlByIndex.get(0)).toBe(metaUrl);

    // gleiche Seite (Host + Pfad, Schreibweise egal): Kopfzeile gilt
    const HeaderUrl = "https://www.vhs-x.de/Kurssuche/Kurs/Hatha-Yoga/123";
    const same = await resolveMarkerCourses({
      indices: [0],
      contextSources: [
        {
          ...chunk,
          text: `Titel: Hatha Yoga am Abend\nKurs-Link: ${HeaderUrl}\nDauer: 8 Abende`,
        },
      ],
      deps: makeDeps({ docs: {} }),
    });
    expect(same.courseSources).toEqual([
      {
        url: HeaderUrl,
        title: "Hatha Yoga am Abend",
        start_date: "2026-10-01",
        sessions: "8 Abende",
      },
    ]);
  });

  test("urlSlugify: ungültige Entity '&#99999999;' wirft nicht, Zeichen fällt weg", () => {
    expect(() => urlSlugify("https://x.de/kurs?knr=&#99999999;")).not.toThrow();
    expect(urlSlugify("a&#99999999;b&#x110000;c")).toBe("abc");
    expect(urlSlugify("a&#98;c&#x64;e&amp;f")).toBe("abcde-f");
  });

  test("completeCourseSourcesFromReply: ungültige Entity in Query/Pfad -> übrige Kurse bleiben", async () => {
    for (const bad of [
      "https://aw.donau.kufer.de/kurssuche?knr=%26%2399999999%3B",
      `${BASE}/boese/%26%2399999999%3B`,
    ]) {
      const out = await completeCourseSourcesFromReply({
        replyText: `[Böse](${bad}) und [Aerobic](${AEROBIC_URL})`,
        courseSources: clone(PRESENT),
        deps: makeDeps(),
      });
      expect(out.map((c) => c.url)).toEqual([GYM_URL, SPORT_URL, AEROBIC_URL]);
    }
  });
});
