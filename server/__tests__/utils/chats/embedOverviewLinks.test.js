/* eslint-env jest, node */
// KIE-576 AK-15: Absicherung der Links als letzte Stufe des Markerfilters
// (OverviewLinkFilter, Prüfer an der Adresse nach R1-D1): Stream, ganze
// Antwort (parseCardsReply, auch fürs Speichern) und jede Aufteilung in
// Token entscheiden gleich; ohne Prüfer bleibt alles wie vorher (NAK-6,
// NAK-9).

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
const TANZ_URL = `${HOST}/kursprogramm/sport/tanz`;
const KULTUR_URL = `${HOST}/kursprogramm/kultur`;
const COURSE_URL = `${HOST}/kurssuche/kurs/hatha-yoga/26100-001`;
const TANZ_COURSE_URL = `${HOST}/kurssuche/kurs/salsa/26100-002`;
const OTHER_URL = `${HOST}/kurse/sommer`;
const ABEND_URL = `${HOST}/kursprogramm/kategorie/Abendkurse/335`;
// Standort-Link aus den Kundenregeln (Meppen-Vorlage), nur im System-Prompt
const GEESTE_URL = `${HOST}/kurssuche/liste?suchesetzen=false&kfs_aussenst=Geeste`;
const SYSTEM_PROMPT = `Location links:\n▪ Geeste → \`${GEESTE_URL}\`\n[**Alle Kurse in $LOCATION_NAME**]($LOCATION_URL)`;
// Verlauf: geprüfte Links früherer Antworten zählen, Links des Nutzers nicht
const HISTORY = [
  { role: "user", content: `Was gibt es unter ${HOST}/kurse/nutzer ?` },
  {
    role: "assistant",
    content: `Mehr Kurse zum Thema: [Winter](${HOST}/kurse/winter)`,
  },
];

const MAP = chains.parseCategoryMap(
  JSON.stringify({
    version: 1,
    client: "vhs-beispiel",
    created: new Date().toISOString(),
    nodes: {
      Sport: { title: "Sport", url: SPORT_URL, count: 40 },
      "Sport \\ Yoga": { title: "Yoga", url: YOGA_URL, count: 1 },
      "Sport \\ Tanz": { title: "Tanz", url: TANZ_URL, count: null },
      // Knoten der Karte, aber nicht im Kontext dieser Antwort
      Kultur: { title: "Kultur", url: KULTUR_URL, count: 5 },
      "Sport \\ Abendkurse": { title: "Abendkurse", url: ABEND_URL, count: 7 },
    },
    courses: {},
  })
);
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
const CONTEXT = applyCategoryChains(
  [
    courseDoc("Hatha-Yoga", "26100-001", "Sport \\ Yoga", COURSE_URL),
    courseDoc("Salsa", "26100-002", "Sport \\ Tanz", TANZ_COURSE_URL),
    `<document_metadata>\nsource: ${OTHER_URL}\n</document_metadata>\n\nSommer. Mehr unter ${HOST}/kurse/herbst.`,
  ],
  MAP
);
const GUARD = createOverviewLinkGuard({
  contextTexts: CONTEXT,
  map: MAP,
  systemPrompt: SYSTEM_PROMPT,
  history: HISTORY,
});

const LIST = `1. [**Hatha-Yoga**](${COURSE_URL}) am Montag`;
const DE = "Mehr Kurse zum Thema:";
const EN = "More courses on this topic:";

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
    "E29 neue Form: Titel und Zahl aus der Karte",
    `Hier ist ein Kurs:\n${LIST}\n\n${DE} [Sportkurse (3 Kurse)](${SPORT_URL})\n\nViel Spaß!`,
    `Hier ist ein Kurs:\n${LIST}\n\n${DE} [Sport (40 Kurse)](${SPORT_URL})\n\nViel Spaß!`,
  ],
  [
    "neue Form mit Schmuck und fett: Zeile vom Server gesetzt, Linktext nicht fett",
    `${LIST}\n▪ **Mehr Kurse zum Thema:** [**Sport**](${SPORT_URL}) 🙂`,
    `${LIST}\n${DE} [Sport (40 Kurse)](${SPORT_URL})`,
  ],
  [
    "alte Form am Zeilenanfang: Zeile in neuer Form",
    `Hier ist ein Kurs:\n${LIST}\n\n[**Alle 3 Kurse in Sportkurse**](${SPORT_URL})\n\nViel Spaß!`,
    `Hier ist ein Kurs:\n${LIST}\n\n${DE} [Sport (40 Kurse)](${SPORT_URL})\n\nViel Spaß!`,
  ],
  [
    "n = 1: „(1 Kurs)“, Ziel ist node.url (S8)",
    `${LIST}\n👉 [Alle 2 Kurse in Yoga](${YOGA_URL}/)`,
    `${LIST}\n${DE} [Yoga (1 Kurs)](${YOGA_URL})`,
  ],
  [
    "Zahl null (NAK-7): nur der Titel",
    `${DE} [Tanzkurse (5 Kurse)](${TANZ_URL})\n[**Alle 5 Kurse in Tanz**](${TANZ_URL})`,
    `${DE} [Tanz](${TANZ_URL})\n${DE} [Tanz](${TANZ_URL})`,
  ],
  [
    "Englisch neue Form, n = 1",
    `${EN} [Sports (3 courses)](${SPORT_URL})\n${EN} [Yoga](${YOGA_URL})`,
    `${EN} [Sport (40 courses)](${SPORT_URL})\n${EN} [Yoga (1 course)](${YOGA_URL})`,
  ],
  [
    "Englisch alte Form: Zeile in neuer Form",
    `[**All 3 courses in Sports**](${SPORT_URL})`,
    `${EN} [Sport (40 courses)](${SPORT_URL})`,
  ],
  [
    "Französisch: Einleitung des Modells bleibt, Titel aus der Karte, Zahl ersetzt bzw. entfernt",
    `Plus de cours sur ce thème : [Sports (3 cours)](${SPORT_URL})\nEt aussi : [Danse (5 cours)](${TANZ_URL})`,
    `Plus de cours sur ce thème : [Sport (40 cours)](${SPORT_URL})\nEt aussi : [Tanz](${TANZ_URL})`,
  ],
  [
    "zwei Links in einer Zeile: mit „ · “, übriger Text entfällt",
    `${DE} [Sport](${SPORT_URL}) und [Yoga (2 Kurse)](${YOGA_URL}).\nEnde`,
    `${DE} [Sport (40 Kurse)](${SPORT_URL}) · [Yoga (1 Kurs)](${YOGA_URL})\nEnde`,
  ],
  [
    "zwei Links in einer Zeile, der erste ungültig: nur der zweite",
    `${DE} [Pilates](${HOST}/pilates) · [Yoga](${YOGA_URL})`,
    `${DE} [Yoga (1 Kurs)](${YOGA_URL})`,
  ],
  [
    "zwei alte Links in einer Zeile: eine Zeile in neuer Form",
    `👉 [Alle Kurse in Sport](${SPORT_URL}) | [Alle Kurse in Yoga](${YOGA_URL})`,
    `${DE} [Sport (40 Kurse)](${SPORT_URL}) · [Yoga (1 Kurs)](${YOGA_URL})`,
  ],
  [
    "zwei Zeilen untereinander bleiben zwei Zeilen (je neue Form)",
    `${LIST}\n${DE} [Sport](${SPORT_URL})\n- [**Alle 9 Kurse in Yoga**](${YOGA_URL})\nEnde`,
    `${LIST}\n${DE} [Sport (40 Kurse)](${SPORT_URL})\n${DE} [Yoga (1 Kurs)](${YOGA_URL})\nEnde`,
  ],
  [
    "Übersichtszeile ohne gültigen Link: ganze Zeile weg",
    `${LIST}\n${DE} [Pilates](${HOST}/pilates) · [Hatha-Yoga](${COURSE_URL})\nNoch Fragen?`,
    `${LIST}\nNoch Fragen?`,
  ],
  [
    "Einleitung ohne Link: Zeile unverändert",
    `${DE} fragen Sie gern nach.\nMehr Kurse zum Thema Yoga gibt es [hier](${OTHER_URL}).`,
    `${DE} fragen Sie gern nach.\nMehr Kurse zum Thema Yoga gibt es [hier](${OTHER_URL}).`,
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
    "R1-D3: Text vor dem Link bleibt, Leerraum davor, Link und Rest der Zeile weg",
    `${LIST}\nMehr unter [Alle Kurse in Pilates](${HOST}/pilates) hier.\nEnde`,
    `${LIST}\nMehr unter\nEnde`,
  ],
  [
    "R1-D3 (S7): Fettdruck direkt vor dem Link entfällt mit ihm",
    `Weitere Angebote: **[Alle Kurse in Yoga](${HOST}/erfunden)** und Pilates.\nEnde`,
    `Weitere Angebote:\nEnde`,
  ],
  [
    "R1-D3 (S7): offener Fettdruck und Kursiv werden geschlossen",
    `**Tipp: [Alle Kurse in Yoga](${HOST}/erfunden) hier**\n- _Auch [Pilates (3 Kurse)](${HOST}/p) und_\nEnde`,
    `**Tipp:**\n- _Auch_\nEnde`,
  ],
  [
    "alte Form mitten im Text: nur der Linktext, Zeile bleibt",
    `Mehr unter [Alle 3 Kurse in Sport](${SPORT_URL}) hier.`,
    `Mehr unter [Sport (40 Kurse)](${SPORT_URL}) hier.`,
  ],
  [
    "Regel 1: Knoten-Link im Fließtext: Linktext aus der Karte (Zahl nur mit Sprache de/en), Satz bleibt",
    `Schauen Sie in [unsere Sportkurse](${SPORT_URL}) rein, z. B. [Yoga (7 Kurse)](${YOGA_URL}).`,
    `Schauen Sie in [Sport](${SPORT_URL}) rein, z. B. [Yoga (1 Kurs)](${YOGA_URL}).`,
  ],
  [
    "Regel 1: Knoten der Karte gilt immer als geprüft, auch ohne Kontext, Zeile bleibt",
    `Auch [Kultur (3 Kurse)](${KULTUR_URL}) ist schön.\n👉 [Kultur](${KULTUR_URL})  \n[Kultur, 2 Kurse](${KULTUR_URL}) bietet viel.`,
    `Auch [Kultur (5 Kurse)](${KULTUR_URL}) ist schön.\n👉 [Kultur](${KULTUR_URL})  \n[Kultur (5 Kurse)](${KULTUR_URL}) bietet viel.`,
  ],
  [
    "Regel 1: Knoten-Link nach Schmuck: nur Linktext, Zeile bleibt",
    `👉 [Yoga (4 Kurse)](${YOGA_URL})`,
    `👉 [Yoga (1 Kurs)](${YOGA_URL})`,
  ],
  [
    "Regel 1: auch in einer Aufzählung",
    `- [Yoga (4 Kurse)](${YOGA_URL})\n2. [Kultur](${KULTUR_URL}) am Montag\n* **Tipp:** [Tanz (2 Kurse)](${TANZ_URL})`,
    `- [Yoga (1 Kurs)](${YOGA_URL})\n2. [Kultur](${KULTUR_URL}) am Montag\n* **Tipp:** [Tanz](${TANZ_URL})`,
  ],
  [
    "S8: erfundene Adresse mit richtiger Kategorienummer bekommt node.url",
    `${DE} [Abend](${HOST}/erfunden/kategorie/335)\nSiehe [Abendkurse (2 Kurse)](${HOST}/x/kategorie/Abend/335/).`,
    `${DE} [Abendkurse (7 Kurse)](${ABEND_URL})\nSiehe [Abendkurse (7 Kurse)](${ABEND_URL}).`,
  ],
  [
    "im Kontext, kein Knoten, ohne Zahl: unverändert (auch in der Übersichtszeile)",
    `[**Alle Kurse in Sommer**](${OTHER_URL})\n${DE} [Sommer](${OTHER_URL})`,
    `[**Alle Kurse in Sommer**](${OTHER_URL})\n${DE} [Sommer](${OTHER_URL})`,
  ],
  [
    "Regel 4 (S17): bekannte Adresse, kein Knoten: Kurszahl im Linktext entfällt",
    `[**Alle 9 Kurse in Sommer**](${OTHER_URL})\n${DE} [Sommer (25 Kurse)](${OTHER_URL})\nSiehe [Sommerprogramm, 12 Kurse](${OTHER_URL}) und [Hatha-Yoga (3 Kurse)](${COURSE_URL}).`,
    `[**Alle Kurse in Sommer**](${OTHER_URL})\n${DE} [Sommer](${OTHER_URL})\nSiehe [Sommerprogramm](${OTHER_URL}) und [Hatha-Yoga](${COURSE_URL}).`,
  ],
  [
    "normale Kurs-Links und andere Links im Fließtext bleiben unangetastet",
    `Siehe [Anmeldung](${HOST}/anmeldung), [1] und [Alle Infos](${HOST}/x), [Hatha-Yoga](${COURSE_URL}) oder <${HOST}/pilates>.`,
    `Siehe [Anmeldung](${HOST}/anmeldung), [1] und [Alle Infos](${HOST}/x), [Hatha-Yoga](${COURSE_URL}) oder <${HOST}/pilates>.`,
  ],
  [
    "Regel 3: alte Form mit fremdem Schema (mailto) oder relativer Adresse: unbekannt, entfernt",
    `Siehe [Anmeldung](${HOST}/anmeldung) oder [Alle Kurse in X](mailto:a@b.de).\n[Alle Kurse in Y](/kurse/y)\nEnde`,
    `Siehe [Anmeldung](${HOST}/anmeldung) oder\nEnde`,
  ],
  [
    "S3: Standort-Link aus dem System-Prompt (Kundenregel) bleibt",
    `${LIST}\n[**Alle Kurse in Geeste**](${GEESTE_URL})\n${DE} [Sport](${SPORT_URL}) · [Geeste](${GEESTE_URL})`,
    `${LIST}\n[**Alle Kurse in Geeste**](${GEESTE_URL})\n${DE} [Sport (40 Kurse)](${SPORT_URL}) · [Geeste](${GEESTE_URL})`,
  ],
  [
    "S10/S11: Kontextadresse mit Satzzeichen und www-Variante bleiben",
    `[Alle Kurse in Herbst](${HOST}/kurse/herbst)\n[Alle Kurse in Sommer](https://vhs-beispiel.de/Kurse/Sommer/#oben)`,
    `[Alle Kurse in Herbst](${HOST}/kurse/herbst)\n[Alle Kurse in Sommer](https://vhs-beispiel.de/Kurse/Sommer/#oben)`,
  ],
  [
    "S12: Link aus der gespeicherten vorigen Antwort bleibt, Adresse aus der Nutzerfrage nicht",
    `${DE} [Winter](${HOST}/kurse/winter)\n[Alle Kurse in X](${HOST}/kurse/nutzer)\nEnde`,
    `${DE} [Winter](${HOST}/kurse/winter)\nEnde`,
  ],
  [
    "S2: Einleitung allein, darunter Liste: Knoten gesetzt, erfundener Link samt Zeile weg",
    `${LIST}\n\n${DE}\n- [Sportkurse (3 Kurse)](${SPORT_URL})\n- [Pilates (4 Kurse)](${HOST}/pilates)\n\nViel Spaß!`,
    `${LIST}\n\n${DE}\n- [Sport (40 Kurse)](${SPORT_URL})\n\nViel Spaß!`,
  ],
  [
    "S2: Übersichtsblock ohne gültigen Link: Einleitung entfällt mit; Kurs-Link im Block weg (Regel 2)",
    `Text\n**${DE}**\n1. [Pilates](${HOST}/pilates)\n2. [Hatha-Yoga](${COURSE_URL})\nEnde`,
    `Text\nEnde`,
  ],
  [
    "S2: Einleitung ohne Link, danach keine Liste oder Liste ohne Link: unverändert",
    `${DE}\nFragen Sie gern nach.\n${DE}\n- Yoga am Montag\n${DE}`,
    `${DE}\nFragen Sie gern nach.\n${DE}\n- Yoga am Montag\n${DE}`,
  ],
  [
    "S5: Einleitung mit Schmuck (**, ###, _) wird erkannt",
    `**Mehr Kurse zum Thema**: [Sportkurse](${SPORT_URL}) · [Pilates](${HOST}/pilates)\n### Mehr Kurse zum Thema: [Pilates (3 Kurse)](${HOST}/pilates)\n_Mehr Kurse zum Thema:_ [Yoga](${YOGA_URL})`,
    `${DE} [Sport (40 Kurse)](${SPORT_URL})\n${DE} [Yoga (1 Kurs)](${YOGA_URL})`,
  ],
  [
    "S4: Link mit Titel, Adresse in <…>, HTTPS:// werden erkannt",
    `${DE} [Pilates](${HOST}/pilates "Pilates") · [Yoga]( <${YOGA_URL}> 'Yoga' )\n[**Alle 3 Kurse in Pilates**](<${HOST}/pilates>)\n[Alle 3 Kurse in Sport](HTTPS://WWW.vhs-beispiel.de/kursprogramm/sport)`,
    `${DE} [Yoga (1 Kurs)](${YOGA_URL})\n${DE} [Sport (40 Kurse)](${SPORT_URL})`,
  ],
  [
    "S4: Autolink in der Übersichtszeile wird geprüft",
    `${DE} <${HOST}/pilates>\n${DE} <${SPORT_URL}> und <info@vhs-beispiel.de>`,
    `${DE} [Sport (40 Kurse)](${SPORT_URL})`,
  ],
  [
    "R1-D1 Regel 6: nicht erkannte Linkform in Übersichtszeile und -block: verworfen (fail-closed)",
    `${DE} [Pilates][1]\n${DE}\n- [Pilates]\n\n[1]: ${HOST}/pilates`,
    `\n[1]: ${HOST}/pilates`,
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

  test("S1: Linktexte mit 550 Leerzeichen bzw. Müll: ganze Antwort und Stream unter 5 ms je Link", () => {
    parseCardsReply(`[Sport (3 Kurse)](${SPORT_URL})`, {
      overviewLinks: GUARD,
    });
    const labels = [
      `Sport (1${" ".repeat(550)}x`,
      `Alle${" ".repeat(550)}x`,
      Array.from({ length: 590 }, (_, i) => "(*_ 1.,K"[i % 8]).join(""),
    ];
    for (const label of labels) {
      for (const url of [SPORT_URL, `${HOST}/erfunden`]) {
        const links = 20;
        const reply = `${DE} [${label}](${url})\n`.repeat(links);
        let start = process.hrtime.bigint();
        parseCardsReply(reply, { overviewLinks: GUARD });
        expect(
          Number(process.hrtime.bigint() - start) / 1e6 / links
        ).toBeLessThan(5);
        start = process.hrtime.bigint();
        streamed(reply, 4);
        expect(
          Number(process.hrtime.bigint() - start) / 1e6 / links
        ).toBeLessThan(5);
      }
    }
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
    // Leerraum direkt vor dem Link wird mit ihm gehalten (R1-D3)
    expect(
      filter.push("Text [**Alle 3 Kurse in Sport**](https://www.vhs")
    ).toBe("Text");
    expect(filter.push("-beispiel.de/kursprogramm/sport) danach")).toBe(
      ` [Sport (40 Kurse)](${SPORT_URL}) danach`
    );
  });

  test("Einleitung am Zeilenanfang wird bis zur Entscheidung gehalten", () => {
    const filter = new OverviewLinkFilter(GUARD);
    expect(filter.push("Absatz\n- Mehr Kur")).toBe("Absatz\n");
    expect(filter.push("se zum Thema: **[Sp")).toBe("");
    expect(filter.push(`ort](${SPORT_URL}) · [Yoga](${YOGA_URL})`)).toBe(
      `${DE} [Sport (40 Kurse)](${SPORT_URL}) · [Yoga (1 Kurs)](${YOGA_URL})`
    );
    const other = new OverviewLinkFilter(GUARD);
    expect(other.push("Mehr Kur")).toBe("");
    expect(other.push("se gibt es bald.")).toBe("Mehr Kurse gibt es bald.");
  });

  test("Übersichtszeile ohne Link wird höchstens ein Fenster lang gehalten", () => {
    const filter = new OverviewLinkFilter(GUARD);
    const long = `${DE} ${"x".repeat(LINK_WINDOW)}`;
    expect(filter.push(long)).toBe(long);
    expect(filter.push(` [Yoga (3 Kurse)](${YOGA_URL})`)).toBe(
      ` [Yoga (1 Kurs)](${YOGA_URL})`
    );
  });

  test("Form an einer Stelle: Einleitung, Wort und Trenner kommen aus OVERVIEW_LINE", () => {
    const { OVERVIEW_LINE } = chains;
    const saved = JSON.stringify(OVERVIEW_LINE);
    try {
      OVERVIEW_LINE.de.intro = "Weitere Angebote:";
      OVERVIEW_LINE.de.many = "Angebote";
      OVERVIEW_LINE.separator = " | ";
      const guard = createOverviewLinkGuard({
        contextTexts: CONTEXT,
        map: MAP,
      });
      expect(
        parseCardsReply(
          `[Alle Kurse in Sport](${SPORT_URL}) [Yoga](${YOGA_URL})`,
          { overviewLinks: guard }
        ).text
      ).toBe(
        `Weitere Angebote: [Sport (40 Angebote)](${SPORT_URL}) | [Yoga (1 Kurs)](${YOGA_URL})`
      );
    } finally {
      Object.assign(OVERVIEW_LINE, JSON.parse(saved));
    }
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

describe("eine Entscheidung für Stream und ganze Antwort (Zufallsantworten, fester Startwert)", () => {
  // kleine Bausteine echter Antworten; jede Zusammensetzung muss im Stream
  // (zufällige Token-Grenzen) genauso aussehen wie ganz geprüft, und keine
  // Übersichtszeile und kein Link in alter Form zeigt auf eine unbekannte
  // Adresse oder einen Kurs-Link (NAK-8)
  const PARTS = [
    DE,
    `**${DE.slice(0, -1)}**:`,
    `### ${EN}`,
    "\n",
    "\n",
    "\n",
    "- ",
    "1. ",
    "👉 ",
    " ",
    "**",
    "_",
    "Text ",
    "und ",
    " · ",
    "(a)",
    "[1]",
    "[x][y]",
    `[Sport (3 Kurse)](${SPORT_URL})`,
    `[Alle 3 Kurse in Yoga](${YOGA_URL}/)`,
    `[Pilates](${HOST}/erfunden)`,
    `[Alle Kurse in X](${HOST}/erfunden)`,
    `[Hatha](${COURSE_URL})`,
    `[Alle Kurse in Hatha](${COURSE_URL})`,
    `[Sommer (2 Kurse)](${OTHER_URL})`,
    `[Geeste](${GEESTE_URL} "Ort")`,
    `<${SPORT_URL}>`,
    `<${HOST}/erfunden>`,
  ];
  let seed = 576;
  const rand = (n) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };
  const badTarget = (text) =>
    [`](${HOST}/erfunden)`, `](${COURSE_URL})`, `<${HOST}/erfunden>`].some(
      (t) => text.includes(t)
    );

  test("2.000 Antworten: Stream gleich ganze Antwort, kein ungeprüfter Übersichtslink", () => {
    for (let n = 0; n < 2000; n++) {
      let reply = "";
      for (let k = 1 + rand(12); k > 0; k--) reply += PARTS[rand(PARTS.length)];
      const whole = parseCardsReply(reply, { overviewLinks: GUARD }).text;
      const filter = new CardsMarkerFilter({ overviewLinks: GUARD });
      let out = "";
      for (let i = 0; i < reply.length; ) {
        const size = 1 + rand(6);
        out += filter.push(reply.slice(i, i + size)).text;
        i += size;
      }
      out += filter.push("", { final: true }).text;
      expect(out).toBe(whole);
      for (const line of whole.split("\n")) {
        const body = line.replace(/^[\s>*+\-\d.)👉#_]*/u, "");
        if (/^(Mehr Kurse zum Thema|More courses on this topic)/.test(body))
          expect(badTarget(line)).toBe(false);
        for (const m of line.matchAll(/\[Alle [^\]]*\]\([^)]*\)/g))
          expect(badTarget(m[0])).toBe(false);
      }
    }
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
