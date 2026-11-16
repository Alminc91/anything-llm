/* eslint-env jest, node */
/**
 * Startvermerk zur Fragezeit (issues/kurszustand-zur-fragezeit.md): reine
 * Regel für die Kopfzeile „Beginn:“ eines Kursdokuments (AK-1, NAK-1) und
 * Kurskarten mit gesetztem Vermerk (Abschnitt 7).
 *
 * „heute“ ist hier fest der 16.11.2026 (Europe/Berlin); die Regel bekommt
 * den Tag als ISO-Tag wie die Auswahlstufe (berlinToday).
 */
const {
  startNoteText,
  withStartNotes,
} = require("../../../../utils/vectorDbProviders/lance/courseStartNote");
const {
  buildCourseSources,
  courseDocumentSummary,
} = require("../../../../utils/chats/embedCourseSources");

const TODAY = "2026-11-16";
// Wortlaut des Extraktors (Datenformat, vom Prompt erkannt)
const OPEN = " — Bereits gestartet, Einstieg möglich";
const STARTED = " — Bereits gestartet";

const HEAD = [
  "<document_metadata>",
  "sourceDocument: vhs-beispiel-de-kurssuche-kurs-tuerkisch-vegane-kueche-i821103.txt",
  "published: 9/24/2026, 8:57:03 AM",
  "</document_metadata>",
  "",
];
// Kursdokument wie vom Extraktor: Kopfblock, Leerzeile, Beschreibung. Die
// Beschreibung enthält absichtlich eine Zeile, die mit „Beginn:“ beginnt.
const courseLines = (beginnLine, { metadata = true } = {}) => [
  ...(metadata ? HEAD : []),
  "Titel: Türkisch vegane Küche",
  "Kursnummer: I821103",
  "Kursstatus: Anmeldung auf Warteliste",
  "Kursgebühr: 34,00",
  beginnLine,
  "Ende: Di. 03.11.2026, 21:00 Uhr",
  "Dauer: 1 Termin",
  "Kursort: vhs, Haus S, Kochwerkstatt",
  "Kursleitung: Meral Beispiel",
  "Kurs-Link: https://www.vhs-beispiel.de/kurssuche/kurs/kurs-tuerkisch-vegane-kueche/I821103",
  "",
  "Kursbeschreibung: Wir kochen gemeinsam.",
  "Beginn: pünktlich um 18 Uhr, bitte Schürze mitbringen.",
];
const course = (beginnLine, opts) => courseLines(beginnLine, opts).join("\n");

const PAST = "Beginn: Di. 03.11.2026, 18:00 Uhr";
const FUTURE = "Beginn: Di. 08.12.2026, 18:00 Uhr";
const row = (start_date, bookable = true) => ({ start_date, bookable });

describe("AK-1: Regel für die Kopfzeile „Beginn:“", () => {
  test.each([
    ["begonnen ohne Vermerk → Vermerk", PAST, row("2026-11-03"), PAST + OPEN],
    [
      "künftig mit Vermerk → Vermerk entfernt",
      FUTURE + OPEN,
      row("2026-12-08"),
      FUTURE,
    ],
    [
      "begonnen, bookable false, ohne Vermerk → nur „Bereits gestartet“",
      PAST,
      row("2026-11-03", false),
      PAST + STARTED,
    ],
    [
      "begonnen, bookable false, Vermerk des Extraktors → ohne „Einstieg möglich“",
      PAST + OPEN,
      row("2026-11-03", false),
      PAST + STARTED,
    ],
    [
      "begonnen, bookable true, kurzer Vermerk → mit „Einstieg möglich“",
      PAST + STARTED,
      row("2026-11-03", true),
      PAST + OPEN,
    ],
    [
      "künftig mit kurzem Vermerk → Vermerk entfernt",
      FUTURE + STARTED,
      row("2026-12-08", false),
      FUTURE,
    ],
    [
      "Beginn heute zählt nicht als begonnen → Vermerk entfernt",
      "Beginn: Mo. 16.11.2026, 18:00 Uhr" + OPEN,
      row("2026-11-16"),
      "Beginn: Mo. 16.11.2026, 18:00 Uhr",
    ],
    [
      "Beginn gestern → Vermerk",
      "Beginn: So. 15.11.2026",
      row("2026-11-15"),
      "Beginn: So. 15.11.2026" + OPEN,
    ],
    [
      "bookable null (unbekannt) → mit „Einstieg möglich“",
      PAST,
      row("2026-11-03", null),
      PAST + OPEN,
    ],
    [
      "bookable fehlt → mit „Einstieg möglich“",
      PAST,
      { start_date: "2026-11-03" },
      PAST + OPEN,
    ],
    [
      "Datum ohne Wochentag und Uhrzeit bleibt, wie es ist",
      "Beginn: 03.11.2026",
      row("2026-11-03"),
      "Beginn: 03.11.2026" + OPEN,
    ],
    [
      "start_date mit Zeitanteil",
      PAST,
      row("2026-11-03 18:00:00"),
      PAST + OPEN,
    ],
  ])("%s", (_name, line, meta, expected) => {
    const text = course(line);
    const out = startNoteText(text, meta, TODAY);
    expect(out).toBe(course(expected));
    // Nur die Kopfzeile ändert sich, alle übrigen Zeilen bleiben gleich
    const before = text.split("\n");
    const after = out.split("\n");
    expect(after).toHaveLength(before.length);
    const changed = after
      .map((l, i) => (l === before[i] ? null : i))
      .filter((i) => i !== null);
    expect(changed).toEqual([before.indexOf(line)]);
    // Datumsteil unverändert: die neue Zeile beginnt mit der alten ohne
    // Vermerk
    const datePart = line.replace(OPEN, "").replace(STARTED, "");
    expect(after[changed[0]].startsWith(datePart)).toBe(true);
  });

  test.each([
    ["begonnen mit Vermerk", PAST + OPEN, row("2026-11-03")],
    [
      "begonnen, bookable false, kurzer Vermerk",
      PAST + STARTED,
      row("2026-11-03", false),
    ],
    ["künftig ohne Vermerk", FUTURE, row("2026-12-08")],
    ["künftig, bookable false, ohne Vermerk", FUTURE, row("2026-12-08", false)],
  ])("%s → byte-gleich (NAK-1)", (_name, line, meta) => {
    const text = course(line);
    const out = startNoteText(text, meta, TODAY);
    expect(out).toBe(text);
    expect(Buffer.from(out).equals(Buffer.from(text))).toBe(true);
  });

  test.each([
    ["ohne Metadaten", undefined],
    ["start_date fehlt", {}],
    ["start_date null", { start_date: null, bookable: true }],
    ["start_date leer", { start_date: "" }],
    ["ungültiger Kalendertag", { start_date: "2026-02-31" }],
    ["deutsches Datum statt ISO", { start_date: "03.11.2026" }],
    ["Zahl statt Text", { start_date: 20261103 }],
  ])("ohne gültiges start_date (%s) → byte-gleich", (_name, meta) => {
    // Ohne Vermerk und mit Datum in der Vergangenheit: mit gültigem
    // start_date gäbe es einen Vermerk
    for (const line of [PAST, FUTURE + OPEN]) {
      const text = course(line);
      expect(startNoteText(text, meta, TODAY)).toBe(text);
    }
  });

  test("Kursdokument ohne „Beginn:“ im Kopfblock → byte-gleich, auch wenn die Beschreibung eine solche Zeile hat", () => {
    const text = courseLines(PAST)
      .filter((l) => l !== PAST)
      .join("\n");
    expect(text).toMatch(/^Beginn: pünktlich/m);
    expect(startNoteText(text, row("2026-11-03"), TODAY)).toBe(text);
  });

  test("„Beginn:“ nach der ersten Leerzeile (Beschreibung) zählt nie", () => {
    const text = [
      ...HEAD,
      "Titel: Kochen",
      "Kursnummer: I1",
      "",
      "Beginn: Di. 03.11.2026, 18:00 Uhr",
    ].join("\n");
    expect(startNoteText(text, row("2026-11-03"), TODAY)).toBe(text);
  });

  test("NAK-1: Nicht-Kurs-Dokumente (Webseite, Folgeabschnitt) → byte-gleich, auch mit start_date", () => {
    const webpage = [
      ...HEAD,
      "Kochen und Backen an der vhs",
      "Beginn: Di. 03.11.2026, 18:00 Uhr",
      "Alle Kochkurse im Überblick.",
    ].join("\n");
    const followUp = [
      ...HEAD,
      "weiter im Text des Kurses.",
      "Beginn: Di. 03.11.2026" + OPEN,
    ].join("\n");
    const faq = "Wie melde ich mich an?\nBeginn: jederzeit online.";
    for (const text of [webpage, followUp, faq]) {
      expect(startNoteText(text, row("2026-11-03"), TODAY)).toBe(text);
      expect(startNoteText(text, row("2026-12-08"), TODAY)).toBe(text);
      expect(startNoteText(text, {}, TODAY)).toBe(text);
    }
  });

  test("Text ohne <document_metadata>-Kopf (wie angeheftete Dokumente)", () => {
    expect(
      startNoteText(course(PAST, { metadata: false }), row("2026-11-03"), TODAY)
    ).toBe(course(PAST + OPEN, { metadata: false }));
  });

  test("Zeilenenden \\r\\n bleiben erhalten", () => {
    const text = courseLines(FUTURE + OPEN).join("\r\n");
    expect(startNoteText(text, row("2026-12-08"), TODAY)).toBe(
      courseLines(FUTURE).join("\r\n")
    );
    const past = courseLines(PAST).join("\r\n");
    expect(startNoteText(past, row("2026-11-03"), TODAY)).toBe(
      courseLines(PAST + OPEN).join("\r\n")
    );
  });

  test("leere Datumsangabe „Beginn:“ → byte-gleich", () => {
    const text = course("Beginn: ");
    expect(startNoteText(text, row("2026-11-03"), TODAY)).toBe(text);
  });

  test.each([
    ["ungültiges heute", "16.11.2026"],
    ["heute fehlt", undefined],
    ["heute null", null],
  ])("%s → byte-gleich", (_name, today) => {
    const text = course(PAST);
    expect(startNoteText(text, row("2026-11-03"), today)).toBe(text);
  });

  test.each([null, undefined, 42, ""])(
    "kein Text (%p) bleibt, wie er ist",
    (value) => {
      expect(startNoteText(value, row("2026-11-03"), TODAY)).toBe(value);
    }
  );
});

describe("withStartNotes: Kontexttexte und Zeilen gleich ausgerichtet", () => {
  const info = "Webseite: Anmeldung und Ermäßigungen";
  test("ändert je Index nur den Text mit seiner Zeile", () => {
    const texts = [info, course(PAST), course(FUTURE + OPEN), course(PAST)];
    const rows = [
      { start_date: null },
      row("2026-11-03"),
      row("2026-12-08"),
      row("2026-11-03", false),
    ];
    expect(withStartNotes(texts, rows, TODAY)).toEqual([
      info,
      course(PAST + OPEN),
      course(FUTURE),
      course(PAST + STARTED),
    ]);
    // Eingabe unverändert
    expect(texts[1]).toBe(course(PAST));
  });

  test("NAK-1: ohne Änderung dieselbe Liste (Referenz)", () => {
    const texts = [info, course(PAST + OPEN), course(FUTURE)];
    const rows = [{}, row("2026-11-03"), row("2026-12-08")];
    expect(withStartNotes(texts, rows, TODAY)).toBe(texts);
  });

  test("fehlende Zeilen oder ungültiges heute → dieselbe Liste", () => {
    const texts = [course(PAST)];
    expect(withStartNotes(texts, [], TODAY)).toBe(texts);
    expect(withStartNotes(texts, undefined, TODAY)).toBe(texts);
    expect(withStartNotes(texts, [row("2026-11-03")], "x")).toBe(texts);
    expect(withStartNotes([], [], TODAY)).toEqual([]);
  });
});

describe("Abschnitt 7: Kurskarten mit gesetztem Vermerk", () => {
  const source = (text, meta) => ({
    id: "c1",
    url: "file://vhs-beispiel-de-kurssuche-kurs-tuerkisch-vegane-kueche-i821103.txt",
    title: "vhs-beispiel-de-kurssuche-kurs-tuerkisch-vegane-kueche-i821103.txt",
    chunkSource:
      "vhs-beispiel-de-kurssuche-kurs-tuerkisch-vegane-kueche-i821103.txt",
    text,
    score: 0.98,
    end_date: "2026-11-03",
    start_minutes: 1080,
    weekdays: ",tue,",
    price: 34,
    format: "onsite",
    ...meta,
  });

  test.each([
    ["Warteliste: „Bereits gestartet“", row("2026-11-03", false)],
    ["buchbar: „Bereits gestartet, Einstieg möglich“", row("2026-11-03", true)],
  ])("%s: Karte mit Datum und Zustand wie ohne Vermerk", (_name, meta) => {
    const plain = source(course(PAST), meta);
    const noted = source(startNoteText(plain.text, meta, TODAY), meta);
    expect(noted.text).not.toBe(plain.text);
    expect(noted.text).toMatch(/^Beginn: .* — Bereits gestartet/m);
    const [card] = buildCourseSources([noted]);
    expect(card).toEqual(buildCourseSources([plain])[0]);
    expect(card).toMatchObject({
      url: "https://www.vhs-beispiel.de/kurssuche/kurs/kurs-tuerkisch-vegane-kueche/I821103",
      title: "Türkisch vegane Küche",
      start_date: "2026-11-03",
      bookable: meta.bookable,
      sessions: "1 Termin",
    });
  });

  test("KB-10: Beginn aus der Kopfzeile auch mit kurzem Vermerk", () => {
    const text = startNoteText(course(PAST), row("2026-11-03", false), TODAY);
    expect(courseDocumentSummary({ pageContent: text })).toMatchObject({
      knr: "I821103",
      start: "2026-11-03",
    });
  });
});
