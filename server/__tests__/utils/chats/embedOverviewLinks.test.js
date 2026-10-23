/* eslint-env jest, node */
// KIE-576 AK-15: Absicherung der Übersichtslinks („Alle Kurse in …“) als
// letzte Stufe des Markerfilters (OverviewLinkFilter): Stream, ganze Antwort
// (parseCardsReply, auch fürs Speichern) und jede Aufteilung in Token
// entscheiden gleich; ohne Prüfer bleibt alles wie vorher (NAK-6, NAK-9).

jest.mock("../../../utils/prisma", () => ({}));

const {
  parseCardsReply,
  __test__: { CardsMarkerFilter, OverviewLinkFilter, LINK_WINDOW },
} = require("../../../utils/chats/embedCardsMarker");
const {
  applyCategoryChains,
  createOverviewLinkGuard,
  __test__: chains,
} = require("../../../utils/chats/embedCategoryChains");

const HOST = "https://www.vhs-beispiel.de";
const SPORT_URL = `${HOST}/kursprogramm/sport`;
const YOGA_URL = `${HOST}/kursprogramm/sport/yoga`;
const COURSE_URL = `${HOST}/kurssuche/kurs/hatha-yoga/26100-001`;
const OTHER_URL = `${HOST}/kurse/sommer`;

const MAP = chains.parseCategoryMap(
  JSON.stringify({
    version: 1,
    client: "vhs-beispiel",
    created: new Date().toISOString(),
    nodes: {
      Sport: { title: "Sport", url: SPORT_URL, count: 40 },
      "Sport \\ Yoga": { title: "Yoga", url: YOGA_URL, count: 1 },
    },
    courses: {},
  })
);
const CONTEXT = applyCategoryChains(
  [
    [
      "<document_metadata>",
      "sourceDocument: kurs.txt",
      "</document_metadata>",
      "",
      "Titel: Hatha-Yoga",
      "Kursnummer: 26100-001",
      "Kategoriepfad: Sport \\ Yoga",
      `Kurs-Link: ${COURSE_URL}`,
    ].join("\n"),
    `<document_metadata>\nsource: ${OTHER_URL}\n</document_metadata>\n\nSommer`,
  ],
  MAP
);
const GUARD = createOverviewLinkGuard({ contextTexts: CONTEXT, map: MAP });

const LIST = `1. [**Hatha-Yoga**](${COURSE_URL}) am Montag`;

// Ganze Antwort in Stücken durch den Stream-Filter
function streamed(reply, size, overviewLinks = GUARD) {
  const filter = new CardsMarkerFilter({ overviewLinks });
  let out = "";
  for (let i = 0; i < reply.length; i += size)
    out += filter.push(reply.slice(i, i + size)).text;
  return out + filter.push("", { final: true }).text;
}

function splitEverywhere(reply, overviewLinks = GUARD) {
  const outs = new Set();
  for (let cut = 0; cut <= reply.length; cut++) {
    const filter = new CardsMarkerFilter({ overviewLinks });
    const a = filter.push(reply.slice(0, cut)).text;
    const b = filter.push(reply.slice(cut), { final: true }).text;
    outs.add(a + b);
  }
  for (const size of [1, 2, 3, 5, 7, 13])
    outs.add(streamed(reply, size, overviewLinks));
  return outs;
}

const CASES = [
  [
    "Zahl und Titel aus der Karte",
    `Hier ist ein Kurs:\n${LIST}\n\n[**Alle 3 Kurse in Sportkurse**](${SPORT_URL})\n\nViel Spaß!`,
    `Hier ist ein Kurs:\n${LIST}\n\n[**Alle 40 Kurse in Sport**](${SPORT_URL})\n\nViel Spaß!`,
  ],
  [
    "n = 1: ohne Zahl",
    `${LIST}\n👉 [Alle 2 Kurse in Yoga](${YOGA_URL}/)`,
    `${LIST}\n👉 [**Alle Kurse in Yoga**](${YOGA_URL}/)`,
  ],
  [
    "Kurs-Link als Übersichtslink: ganze Zeile weg (nur Schmuck davor)",
    `${LIST}\n\n➡️ [**Alle Kurse in Hatha-Yoga**](${COURSE_URL})\nNoch Fragen?`,
    `${LIST}\n\nNoch Fragen?`,
  ],
  [
    "Emoji davor (Token-Grenze mitten im Emoji): ganze Zeile weg",
    `${LIST}\n👉 [**Alle Kurse in Pilates**](${HOST}/pilates)\nNoch Fragen?`,
    `${LIST}\nNoch Fragen?`,
  ],
  [
    "erfundene Adresse: ganze Zeile weg, auch am Antwortende",
    `${LIST}\n- [Alle Kurse in Pilates](${HOST}/pilates)`,
    `${LIST}\n`,
  ],
  [
    "Text vor dem Link bleibt, Link und Rest der Zeile weg",
    `${LIST}\nMehr unter [Alle Kurse in Pilates](${HOST}/pilates) hier.\nEnde`,
    `${LIST}\nMehr unter \nEnde`,
  ],
  [
    "Englisch: nur die Zahl",
    `[**All 3 courses in Sports**](${SPORT_URL})`,
    `[**All 40 courses in Sports**](${SPORT_URL})`,
  ],
  [
    "im Kontext, kein Knoten: unverändert",
    `[**Alle Kurse in Sommer**](${OTHER_URL})`,
    `[**Alle Kurse in Sommer**](${OTHER_URL})`,
  ],
  [
    "andere Links und Klammern unverändert",
    `Siehe [Anmeldung](${HOST}/anmeldung), [1] und [Alle Infos](${HOST}/x) oder [Alle Kurse in X](mailto:a@b.de).`,
    `Siehe [Anmeldung](${HOST}/anmeldung), [1] und [Alle Infos](${HOST}/x) oder [Alle Kurse in X](mailto:a@b.de).`,
  ],
  [
    "mit Karten-Marker, Teaser und Folgefragen",
    `[[KARTEN: 0]]\n[[TEASER 0: Sanft starten.]]\nText\n[**Alle Kurse in Yoga**](${HOST}/falsch)\n[[FRAGEN: Gibt es Pilates? | Was kostet das?]]`,
    `Text\n`,
  ],
];

describe("OverviewLinkFilter: Stream gleich ganze Antwort (AK-15)", () => {
  test.each(CASES)("%s", (_name, reply, expected) => {
    expect(parseCardsReply(reply, { overviewLinks: GUARD }).text).toBe(
      expected
    );
    expect([...splitEverywhere(reply)]).toEqual([expected]);
  });

  test("NAK-8: kein ungeprüfter Übersichtslink in irgendeinem Stream-Stück", () => {
    const reply = `${LIST}\n[**Alle 3 Kurse in Pilates**](${HOST}/pilates)\n`;
    for (const size of [1, 2, 4, 9]) {
      const filter = new CardsMarkerFilter({ overviewLinks: GUARD });
      const pieces = [];
      for (let i = 0; i < reply.length; i += size)
        pieces.push(filter.push(reply.slice(i, i + size)).text);
      pieces.push(filter.push("", { final: true }).text);
      expect(pieces.join("")).not.toMatch(/pilates|Pilates/);
      expect(pieces.every((p) => !p.includes("Alle 3"))).toBe(true);
    }
  });

  test("Link wird erst nach der Prüfung gesendet (bis „)“ zurückgehalten)", () => {
    const filter = new OverviewLinkFilter(GUARD);
    expect(
      filter.push("Text [**Alle 3 Kurse in Sport**](https://www.vhs")
    ).toBe("Text ");
    expect(filter.push("-beispiel.de/kursprogramm/sport) danach")).toBe(
      `[**Alle 40 Kurse in Sport**](${SPORT_URL}) danach`
    );
  });

  test("Zurückhalten ist begrenzt: Fenster, Zeilenende, Antwortende", () => {
    const long = `[${"x".repeat(LINK_WINDOW)}`;
    const filter = new OverviewLinkFilter(GUARD);
    expect(filter.push(long)).toBe(long);
    const line = new OverviewLinkFilter(GUARD);
    expect(line.push("[Alle Kurse in\nX")).toBe("[Alle Kurse in\nX");
    const end = new OverviewLinkFilter(GUARD);
    expect(end.push("[Alle Kurse in X](https://")).toBe("");
    expect(end.push("", { final: true })).toBe("[Alle Kurse in X](https://");
    const notLink = new OverviewLinkFilter(GUARD);
    expect(notLink.push("[Hinweis] weiter")).toBe("[Hinweis] weiter");
  });

  test("Schmuck am Zeilenanfang wird nur bis zur Entscheidung gehalten", () => {
    const filter = new OverviewLinkFilter(GUARD);
    expect(filter.push("Absatz\n- ")).toBe("Absatz\n");
    expect(filter.push("Punkt")).toBe("- Punkt");
  });
});

describe("ohne Prüfer (keine gültige Karte): alles wie vorher", () => {
  test.each(CASES)("NAK-6: %s", (_name, reply) => {
    const before = parseCardsReply(reply);
    expect(parseCardsReply(reply, { overviewLinks: null })).toEqual(before);
    expect([...splitEverywhere(reply, null)]).toEqual([before.text]);
  });

  test("NAK-9: Kurskarten-Antwort ohne Übersichtslink: Marker, Teaser, Folgefragen und Text gleich mit und ohne Prüfer", () => {
    const reply = `[[KARTEN: 0, 1]]\n[[TEASER 0: Sanft starten.]]\n[[TEASER 1: Für alle.]]\nZwei passende Kurse.\n${LIST}\n[[FRAGEN: Gibt es Pilates? | Was kostet das?]]`;
    expect(parseCardsReply(reply, { overviewLinks: GUARD })).toEqual(
      parseCardsReply(reply)
    );
    // Marker, Teaser und Folgefragen kommen beim selben Token; der Text ist
    // gleich (Links werden nur bis zur Prüfung gehalten)
    for (const size of [1, 4, 11]) {
      const run = (overviewLinks) => {
        const filter = new CardsMarkerFilter({ overviewLinks });
        const events = [];
        let text = "";
        const take = (out, at) => {
          text += out.text;
          for (const key of ["marker", "teasers", "followUps"])
            if (out[key]) events.push([at, key, out[key]]);
        };
        for (let i = 0; i < reply.length; i += size)
          take(filter.push(reply.slice(i, i + size)), i);
        take(filter.push("", { final: true }), "final");
        return { events, text };
      };
      expect(run(GUARD)).toEqual(run(null));
    }
  });
});
