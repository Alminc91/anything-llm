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
// Kurs aus course_links, nicht im Kontext
const AQUARELL_URL = `${HOST}/kurssuche/kurs/aquarell/26100-009`;
const ABEND_URL = `${HOST}/kursprogramm/kategorie/Abendkurse/335`;
// Standort-Link aus den Kundenregeln (Meppen-Vorlage), nur im System-Prompt
const GEESTE_URL = `${HOST}/kurssuche/liste?suchesetzen=false&kfs_aussenst=Geeste`;
const SYSTEM_PROMPT = `Location links:\n▪ Geeste → \`${GEESTE_URL}\`\n[**Alle Kurse in $LOCATION_NAME**]($LOCATION_URL)`;
// Verlauf (R4-D3): bekannt sind nur Adressen aus den gespeicherten Quellen
// früherer Antworten (Feld sources), nicht aus ihrem Text; so macht ein Echo
// einer Adresse aus der Nutzerfrage sie nicht bekannt. Derselbe Verlauf
// steht zum Vergleich auch als Text (history), den der Prüfer nicht liest.
const ECHO_TEXT = `Gern, unter ${HOST}/kurse/nutzer und ${HOST}/kurse/echo finden Sie mehr, etwa ${AQUARELL_URL}.`;
const HISTORY = [
  { role: "user", content: `Was gibt es unter ${HOST}/kurse/nutzer ?` },
  { role: "assistant", content: ECHO_TEXT },
];
const STORED_CHATS = [
  {
    prompt: `Was gibt es unter ${HOST}/kurse/nutzer ?`,
    response: JSON.stringify({
      text: ECHO_TEXT,
      sources: [
        {
          text: `<document_metadata>\nsource: ${HOST}/kurse/winter\n</document_metadata>\n\nWinterkurse`,
        },
      ],
    }),
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
    course_links: {
      "26100-009": {
        title: "Aquarell",
        start: "2026-03-02",
        url: AQUARELL_URL,
      },
    },
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
  storedChats: STORED_CHATS,
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
    `Hier ist ein Kurs:\n${LIST}\n\n${DE} [Sport (40\u00a0Kurse)](${SPORT_URL})\n\nViel Spaß!`,
  ],
  [
    "neue Form mit Schmuck und fett: Zeile vom Server gesetzt, Linktext nicht fett",
    `${LIST}\n▪ **Mehr Kurse zum Thema:** [**Sport**](${SPORT_URL}) 🙂`,
    `${LIST}\n${DE} [Sport (40\u00a0Kurse)](${SPORT_URL})`,
  ],
  [
    "alte Form am Zeilenanfang: Zeile in neuer Form",
    `Hier ist ein Kurs:\n${LIST}\n\n[**Alle 3 Kurse in Sportkurse**](${SPORT_URL})\n\nViel Spaß!`,
    `Hier ist ein Kurs:\n${LIST}\n\n${DE} [Sport (40\u00a0Kurse)](${SPORT_URL})\n\nViel Spaß!`,
  ],
  [
    "n = 1: „(1 Kurs)“, Ziel ist node.url (S8)",
    `${LIST}\n👉 [Alle 2 Kurse in Yoga](${YOGA_URL}/)`,
    `${LIST}\n${DE} [Yoga (1\u00a0Kurs)](${YOGA_URL})`,
  ],
  [
    "Zahl null (NAK-7): nur der Titel",
    `${DE} [Tanzkurse (5 Kurse)](${TANZ_URL})\n[**Alle 5 Kurse in Tanz**](${TANZ_URL})`,
    `${DE} [Tanz](${TANZ_URL})\n${DE} [Tanz](${TANZ_URL})`,
  ],
  [
    "Englisch neue Form, n = 1",
    `${EN} [Sports (3 courses)](${SPORT_URL})\n${EN} [Yoga](${YOGA_URL})`,
    `${EN} [Sport (40\u00a0courses)](${SPORT_URL})\n${EN} [Yoga (1\u00a0course)](${YOGA_URL})`,
  ],
  [
    "Englisch alte Form: Zeile in neuer Form",
    `[**All 3 courses in Sports**](${SPORT_URL})`,
    `${EN} [Sport (40\u00a0courses)](${SPORT_URL})`,
  ],
  [
    "Französisch: Einleitung des Modells bleibt, Titel aus der Karte, Zahl ersetzt bzw. entfernt",
    `Plus de cours sur ce thème : [Sports (3 cours)](${SPORT_URL})\nEt aussi : [Danse (5 cours)](${TANZ_URL})`,
    `Plus de cours sur ce thème : [Sport (40\u00a0cours)](${SPORT_URL})\nEt aussi : [Tanz](${TANZ_URL})`,
  ],
  [
    "S7-1: zwei Links in einer Zeile: je Link eine eigene Zeile mit Einleitung, übriger Text entfällt",
    `${DE} [Sport](${SPORT_URL}) und [Yoga (2 Kurse)](${YOGA_URL}).\nEnde`,
    `${DE} [Sport (40\u00a0Kurse)](${SPORT_URL})\n${DE} [Yoga (1\u00a0Kurs)](${YOGA_URL})\nEnde`,
  ],
  [
    "S7-1: zwei Links mit „ · “ bzw. Komma: je eine Zeile, deutsch und englisch",
    `${DE} [Sport](${SPORT_URL}) · [Yoga](${YOGA_URL})\n${EN} [Sports](${SPORT_URL}), [Yoga](${YOGA_URL})\nEnde`,
    `${DE} [Sport (40\u00a0Kurse)](${SPORT_URL})\n${DE} [Yoga (1\u00a0Kurs)](${YOGA_URL})\n${EN} [Sport (40\u00a0courses)](${SPORT_URL})\n${EN} [Yoga (1\u00a0course)](${YOGA_URL})\nEnde`,
  ],
  [
    "S7-1: zweiter Link in der Zeile darunter, ohne Einleitung oder als Aufzählung: eigene Zeile mit Einleitung",
    `${DE} [Sport](${SPORT_URL})\n[Yoga](${YOGA_URL}) hier\n\n${EN} [Sports](${SPORT_URL})\n- **[Yoga](${YOGA_URL})**\nEnde`,
    `${DE} [Sport (40\u00a0Kurse)](${SPORT_URL})\n${DE} [Yoga (1\u00a0Kurs)](${YOGA_URL})\n\n${EN} [Sport (40\u00a0courses)](${SPORT_URL})\n${EN} [Yoga (1\u00a0course)](${YOGA_URL})\nEnde`,
  ],
  [
    "S7-1: bekannte Adresse (kein Knoten) in der Zeile darunter: eigene Zeile, Zahl weg",
    `${DE} [Sport](${SPORT_URL})\n[Sommer (3 Kurse)](${OTHER_URL})\nEnde`,
    `${DE} [Sport (40\u00a0Kurse)](${SPORT_URL})\n${DE} [Sommer](${OTHER_URL})\nEnde`,
  ],
  [
    "zwei Links in einer Zeile, der erste ungültig: nur der zweite",
    `${DE} [Pilates](${HOST}/pilates) · [Yoga](${YOGA_URL})`,
    `${DE} [Yoga (1\u00a0Kurs)](${YOGA_URL})`,
  ],
  [
    "zwei alte Links in einer Zeile: je eine Zeile in neuer Form (S7-1)",
    `👉 [Alle Kurse in Sport](${SPORT_URL}) | [Alle Kurse in Yoga](${YOGA_URL})`,
    `${DE} [Sport (40\u00a0Kurse)](${SPORT_URL})\n${DE} [Yoga (1\u00a0Kurs)](${YOGA_URL})`,
  ],
  [
    "zwei Zeilen untereinander bleiben zwei Zeilen (je neue Form)",
    `${LIST}\n${DE} [Sport](${SPORT_URL})\n- [**Alle 9 Kurse in Yoga**](${YOGA_URL})\nEnde`,
    `${LIST}\n${DE} [Sport (40\u00a0Kurse)](${SPORT_URL})\n${DE} [Yoga (1\u00a0Kurs)](${YOGA_URL})\nEnde`,
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
    `Mehr unter [Sport (40\u00a0Kurse)](${SPORT_URL}) hier.`,
  ],
  [
    "Regel 1: Knoten-Link im Fließtext: Linktext aus der Karte (Zahl nur mit Sprache de/en), Satz bleibt; anderer Linktext bleibt (R3-D4)",
    `Schauen Sie in [unsere Sportkurse](${SPORT_URL}) rein, z. B. [Yoga (7 Kurse)](${YOGA_URL}) oder [sport](${SPORT_URL}).`,
    `Schauen Sie in [unsere Sportkurse](${SPORT_URL}) rein, z. B. [Yoga (1\u00a0Kurs)](${YOGA_URL}) oder [Sport](${SPORT_URL}).`,
  ],
  [
    "Regel 1: Knoten der Karte gilt immer als geprüft, auch ohne Kontext, Zeile bleibt",
    `Auch [Kultur (3 Kurse)](${KULTUR_URL}) ist schön.\n👉 [Kultur](${KULTUR_URL})  \n[Kultur, 2 Kurse](${KULTUR_URL}) bietet viel.`,
    `Auch [Kultur (5\u00a0Kurse)](${KULTUR_URL}) ist schön.\n👉 [Kultur](${KULTUR_URL})  \n[Kultur (5\u00a0Kurse)](${KULTUR_URL}) bietet viel.`,
  ],
  [
    "Regel 1: Knoten-Link nach Schmuck: nur Linktext, Zeile bleibt",
    `👉 [Yoga (4 Kurse)](${YOGA_URL})`,
    `👉 [Yoga (1\u00a0Kurs)](${YOGA_URL})`,
  ],
  [
    "Regel 1: auch in einer Aufzählung",
    `- [Yoga (4 Kurse)](${YOGA_URL})\n2. [Kultur](${KULTUR_URL}) am Montag\n* **Tipp:** [Tanz (2 Kurse)](${TANZ_URL})`,
    `- [Yoga (1\u00a0Kurs)](${YOGA_URL})\n2. [Kultur](${KULTUR_URL}) am Montag\n* **Tipp:** [Tanz](${TANZ_URL})`,
  ],
  [
    "S8: erfundene Adresse mit richtiger Kategorienummer bekommt node.url",
    `${DE} [Abend](${HOST}/erfunden/kategorie/335)\nSiehe [Abendkurse (2 Kurse)](${HOST}/x/kategorie/Abend/335/).`,
    `${DE} [Abendkurse (7\u00a0Kurse)](${ABEND_URL})\nSiehe [Abendkurse (7\u00a0Kurse)](${ABEND_URL}).`,
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
    `${LIST}\n[**Alle Kurse in Geeste**](${GEESTE_URL})\n${DE} [Sport (40\u00a0Kurse)](${SPORT_URL})\n${DE} [Geeste](${GEESTE_URL})`,
  ],
  [
    "S10/S11: Kontextadresse mit Satzzeichen und www-Variante bleiben, in der Originalform (R4-D3)",
    `[Alle Kurse in Herbst](${HOST}/kurse/herbst)\n[Alle Kurse in Sommer](https://vhs-beispiel.de/Kurse/Sommer/#oben)`,
    `[Alle Kurse in Herbst](${HOST}/kurse/herbst)\n[Alle Kurse in Sommer](${OTHER_URL})`,
  ],
  [
    "S12: Link aus den gespeicherten Quellen der vorigen Antwort bleibt, Adresse aus der Nutzerfrage nicht",
    `${DE} [Winter](${HOST}/kurse/winter)\n[Alle Kurse in X](${HOST}/kurse/nutzer)\nEnde`,
    `${DE} [Winter](${HOST}/kurse/winter)\nEnde`,
  ],
  [
    "R4-D3 (R2-S4): Echo einer Adresse im Text der vorigen Antwort bleibt unbekannt",
    `${DE} [Echo](${HOST}/kurse/echo)\nSiehe [Alle Kurse in Echo](${HOST}/kurse/echo).\nEnde`,
    `Siehe\nEnde`,
  ],
  [
    "R4-D3 (R2-S5): Kurs-Link aus course_links (nicht im Kontext) in der Übersichtszeile fällt weg",
    `${DE} [Sport](${SPORT_URL}) · [Aquarell](${AQUARELL_URL})\n${DE} [Aquarell (3 Kurse)](${AQUARELL_URL})\nEnde`,
    `${DE} [Sport (40\u00a0Kurse)](${SPORT_URL})\nEnde`,
  ],
  [
    "R4-D3 (R2-S6): bekannte Adresse in anderer Schreibung: Originaladresse",
    `${DE} [Sommer](http://VHS-BEISPIEL.DE/Kurse/SOMMER.)\n[Alle 3 Kurse in Sommer](${HOST}/kurse/sommer/)\nEnde`,
    `${DE} [Sommer](${OTHER_URL})\n[Alle Kurse in Sommer](${OTHER_URL})\nEnde`,
  ],
  [
    "R4-D2 (R2-S8): letzte Kurszahl zählt, auch „Kursen“; Zahl vorn auf Knotenadresse mit Knotentitel",
    `Siehe [Erste Hilfe 1 Kurs (12 Kurse)](${OTHER_URL}) und [Yoga (12 Kursen)](${OTHER_URL}).\nMehr in [12 Kurse Yoga](${YOGA_URL}) und [Alphabetisierungskurs Abschnitt 4 Kurs 311](${YOGA_URL}).`,
    `Siehe [Erste Hilfe 1 Kurs](${OTHER_URL}) und [Yoga](${OTHER_URL}).\nMehr in [Yoga (1\u00a0Kurs)](${YOGA_URL}) und [Alphabetisierungskurs Abschnitt 4 Kurs 311](${YOGA_URL}).`,
  ],
  [
    "R4-D2 (R2-S3): Einleitung, Leerzeile, Liste: Block bleibt offen, erfundener Link weg",
    `${LIST}\n\n${DE}\n\n- [Sportkurse (3 Kurse)](${SPORT_URL})\n- [Sommerprogramm](${HOST}/erfunden)\n\nViel Spaß!`,
    `${LIST}\n\n${DE}\n\n- [Sport (40\u00a0Kurse)](${SPORT_URL})\n\nViel Spaß!`,
  ],
  [
    "R4-D2: Einleitung, Leerzeile, nur erfundene Links: Einleitung und Leerzeile entfallen mit",
    `Text\n**${DE}**\n\n- [Sommerprogramm](${HOST}/erfunden)\nEnde`,
    `Text\nEnde`,
  ],
  [
    "R4-D2: Einleitung mit Linkzeilen ohne Aufzählungszeichen: Block",
    `${DE}\n[Sportkurse](${SPORT_URL})\n👉 [Sommerprogramm](${HOST}/erfunden)\nEnde`,
    `${DE}\n[Sport (40\u00a0Kurse)](${SPORT_URL})\nEnde`,
  ],
  [
    "R4-D2: Text nach der Leerzeile beendet den Block",
    `${DE}\n\nFragen Sie gern.\n- [Sommerprogramm](${HOST}/erfunden)`,
    `${DE}\n\nFragen Sie gern.\n- [Sommerprogramm](${HOST}/erfunden)`,
  ],
  [
    "R5-D3 (F04): zwei und drei Leerzeilen nach der Einleitung: Block bleibt offen",
    `${DE}\n\n\n- [Sommerprogramm](${HOST}/erfunden)\nText\n${DE}\n \n\t\n\n- [Sportkurse](${SPORT_URL})\n- [Sommer](${HOST}/erfunden)\nEnde`,
    `Text\n${DE}\n \n\t\n\n- [Sport (40\u00a0Kurse)](${SPORT_URL})\nEnde`,
  ],
  [
    "R5-D3: Leerzeile mit mehr als 16 Leerzeichen zählt als Leerzeile, ihr Leerraum wird auf 16 Zeichen gekürzt (R6-D1)",
    `${DE}\n${" ".repeat(20)}\n\n- [Sommer](${HOST}/erfunden)\nEnde\n${DE}\n${" ".repeat(20)}\nText`,
    `Ende\n${DE}\n${" ".repeat(16)}\nText`,
  ],
  [
    "R3-S2: Aufzählungszeile ohne Link am Anfang direkt unter der Übersichtszeile: Fließtext",
    `${DE} [Yoga](${YOGA_URL})\n- Tipp: [Sommer](${HOST}/erfunden) mehr\n- Text ohne Link\nEnde`,
    `${DE} [Yoga (1\u00a0Kurs)](${YOGA_URL})\n- Tipp: [Sommer](${HOST}/erfunden) mehr\n- Text ohne Link\nEnde`,
  ],
  [
    "R5-D3: Leerzeilen nach der Einleitung, danach Text: alles unverändert",
    `${DE}\n\n\n\nFragen Sie gern.\n[Sommer](${HOST}/erfunden)`,
    `${DE}\n\n\n\nFragen Sie gern.\n[Sommer](${HOST}/erfunden)`,
  ],
  [
    "R5-D3 (F06), R7-D1: Zeilen mit Link am Anfang direkt unter der Übersichtszeile gehören zum Block, auch als Aufzählung; je behaltener Link eine Zeile (S7-1)",
    `${DE} [Yoga](${YOGA_URL})\n[Sommer](${HOST}/erfunden)\n- [Sommer (7)](${OTHER_URL}) hier\n[Tanz](${TANZ_URL})\nEnde`,
    `${DE} [Yoga (1\u00a0Kurs)](${YOGA_URL})\n${DE} [Sommer](${OTHER_URL})\n${DE} [Tanz](${TANZ_URL})\nEnde`,
  ],
  [
    "R7-D1 (Z04): Aufzählungszeile mit unbekannter Adresse direkt unter der Übersichtszeile fällt weg",
    `${DE} [Yoga](${YOGA_URL})\n- [Sommer](${HOST}/erfunden)\nEnde\n${EN} [Yoga](${YOGA_URL})\n2. [Summer](${HOST}/erfunden) more`,
    `${DE} [Yoga (1\u00a0Kurs)](${YOGA_URL})\nEnde\n${EN} [Yoga (1\u00a0course)](${YOGA_URL})\n`,
  ],
  [
    "R7-D1 (Z30): Kursliste unter der Übersichtszeile bleibt",
    `${DE} [Yoga](${YOGA_URL})\n1. [Hatha-Yoga am Morgen](${COURSE_URL})\n   Beginn: Mo. 02.03.2026\n2. [**Salsa**](${TANZ_COURSE_URL})\nEnde`,
    `${DE} [Yoga (1\u00a0Kurs)](${YOGA_URL})\n1. [Hatha-Yoga am Morgen](${COURSE_URL})\n   Beginn: Mo. 02.03.2026\n2. [**Salsa**](${TANZ_COURSE_URL})\nEnde`,
  ],
  [
    "R3-S2, R7-D1: Kursliste direkt unter der Übersichtszeile bleibt, unbekannte Adresse in derselben Liste fällt weg",
    `${DE} [Yoga](${YOGA_URL})\n1. [**Hatha-Yoga**](${COURSE_URL}) am Montag\n- [Sommer](${HOST}/erfunden) neu\nEnde`,
    `${DE} [Yoga (1\u00a0Kurs)](${YOGA_URL})\n1. [**Hatha-Yoga**](${COURSE_URL}) am Montag\nEnde`,
  ],
  [
    "R3-S2: „[Text]“ ohne Link direkt unter der Übersichtszeile bleibt",
    `${DE} [Yoga](${YOGA_URL})\n[Hinweis] Anmeldung bis Freitag\nEnde`,
    `${DE} [Yoga (1\u00a0Kurs)](${YOGA_URL})\n[Hinweis] Anmeldung bis Freitag\nEnde`,
  ],
  [
    "R3-S2: Kurs-Link am Anfang der Zeile direkt unter der Übersichtszeile wie im Fließtext",
    `${DE} [Yoga](${YOGA_URL})\n[**Hatha-Yoga**](${COURSE_URL}) am Montag\nEnde`,
    `${DE} [Yoga (1\u00a0Kurs)](${YOGA_URL})\n[**Hatha-Yoga**](${COURSE_URL}) am Montag\nEnde`,
  ],
  [
    "R3-S3: „\\“ vor einer Leerzeile: der weite Scan endet dort, der nächste Absatz bleibt",
    `${DE} [Alle Kurse\\\n\nText danach](${SPORT_URL})\nEnde`,
    `\nText danach](${SPORT_URL})\nEnde`,
  ],
  [
    "R3-S4: alte Form mit Kurszahl dahinter, im Fließtext und in der Übersicht",
    `Siehe [Alle Kurse in Sommer (12 Kurse)](${OTHER_URL}) hier.\n${DE} [Alle Kurse in Sommer (12 Kurse)](${OTHER_URL})\nEnde`,
    `Siehe [Alle Kurse in Sommer](${OTHER_URL}) hier.\n${DE} [Alle Kurse in Sommer](${OTHER_URL})\nEnde`,
  ],
  [
    "R3-S4: Kurszahl mitten im Linktext der Übersicht samt Klammer, Uhrzeit bleibt",
    `${DE} [Sport (12 Kurse) für Senioren](${OTHER_URL}) · [Yoga (3 Kurse) und Pilates](${OTHER_URL}) · [Yoga 18:00 Kurs](${OTHER_URL})\nEnde`,
    `${DE} [Sport für Senioren](${OTHER_URL})\n${DE} [Yoga und Pilates](${OTHER_URL})\n${DE} [Yoga 18:00 Kurs](${OTHER_URL})\nEnde`,
  ],
  [
    "R6-D3 (K6): eigene Einleitung vor Kategorie-Link am Zeilenende: Zeile vom Server",
    `${LIST}\n\nWeitere Angebote finden Sie hier: [Alle 10 Kurse in Sport](${SPORT_URL})\n\n**Tipp:** [Yoga · Abend (10 Kurse)](${YOGA_URL}).\n\nMore offers: [Sport (3 courses)](${SPORT_URL})\nEnde`,
    `${LIST}\n\n${DE} [Sport (40\u00a0Kurse)](${SPORT_URL})\n\n${DE} [Yoga (1\u00a0Kurs)](${YOGA_URL})\n\n${EN} [Sport (40\u00a0courses)](${SPORT_URL})\nEnde`,
  ],
  [
    "R6-D3: Fließtext mit Link mitten im Satz, Text nach dem Link, ohne Sprache, lange Einleitung, Liste und Folgezeile: Einleitung des Modells bleibt",
    `Sie finden alle Yogakurse [hier](${YOGA_URL}) im Programm.\n\nWeitere Angebote: [Sport (3 Kurse)](${SPORT_URL}) und mehr.\n\nMehr dazu: [Sport](${SPORT_URL})\n\n${"x".repeat(80)}: [Sport (3 Kurse)](${SPORT_URL})\n\n- Sport: [Sport (3 Kurse)](${SPORT_URL})\n\nText\nWeitere: [Sport (3 Kurse)](${SPORT_URL})`,
    `Sie finden alle Yogakurse [hier](${YOGA_URL}) im Programm.\n\nWeitere Angebote: [Sport (40\u00a0Kurse)](${SPORT_URL}) und mehr.\n\nMehr dazu: [Sport](${SPORT_URL})\n\n${"x".repeat(80)}: [Sport (40\u00a0Kurse)](${SPORT_URL})\n\n- Sport: [Sport (40\u00a0Kurse)](${SPORT_URL})\n\nText\nWeitere: [Sport (40\u00a0Kurse)](${SPORT_URL})`,
  ],
  [
    "R5-D3: Übersichtszeile ohne behaltenen Link, Folgezeile mit Link: ebenfalls geprüft",
    `${DE} [Pilates](${HOST}/pilates)\n[Sommer](${HOST}/erfunden)\n[Alle 3 Kurse in Yoga](${YOGA_URL})\nEnde`,
    `${DE} [Yoga (1\u00a0Kurs)](${YOGA_URL})\nEnde`,
  ],
  [
    "R5-D3: Leerzeile oder Text ohne Link am Anfang beendet den Block nach der Übersichtszeile",
    `${DE} [Yoga](${YOGA_URL})\n\n[Sommer](${HOST}/erfunden)\n${DE} [Yoga](${YOGA_URL})\nSiehe [Sommer](${HOST}/erfunden)\nEnde`,
    `${DE} [Yoga (1\u00a0Kurs)](${YOGA_URL})\n\n[Sommer](${HOST}/erfunden)\n${DE} [Yoga (1\u00a0Kurs)](${YOGA_URL})\nSiehe [Sommer](${HOST}/erfunden)\nEnde`,
  ],
  [
    "R5-D4 (F30, F53, F56): Zahl in der Übersichtszeile überall, Nicht-Knoten: Zahl weg",
    `${DE} [12 Yogakurse](${OTHER_URL}) · [Sommer (7)](${OTHER_URL}) · [12 Kurse im Sommer](${OTHER_URL})\nEnde`,
    `${DE} [Yogakurse](${OTHER_URL})\n${DE} [Sommer](${OTHER_URL})\n${DE} [Kurse im Sommer](${OTHER_URL})\nEnde`,
  ],
  [
    "R5-D4: Zahl im Übersichtsblock überall, auch fett, Bindestrich und englisch",
    `${DE}\n- [**12 Yoga-Kurse**](${OTHER_URL})\n- [**Sommer (7)**](${OTHER_URL})\n- [3 Sprachkurse, 12 Kurse](${OTHER_URL})\n- [12 courses in summer](${OTHER_URL})\nEnde`,
    `${DE}\n- [**Yoga-Kurse**](${OTHER_URL})\n- [**Sommer**](${OTHER_URL})\n- [Sprachkurse](${OTHER_URL})\n- [courses in summer](${OTHER_URL})\nEnde`,
  ],
  [
    "R5-D4 (F55, F30): Zahl in der Übersicht auf einem Knoten: Titel und Kartenzahl",
    `${DE} [alle 7 Kurse zum Thema Yoga](${YOGA_URL}) · [12 Sportkurse](${SPORT_URL})\nEnde`,
    `${DE} [Yoga (1\u00a0Kurs)](${YOGA_URL})\n${DE} [Sport (40\u00a0Kurse)](${SPORT_URL})\nEnde`,
  ],
  [
    "R5-D4 Gegenprobe (B4, R5-D5): außerhalb von Übersichten nur die Zahl am Ende",
    `Siehe [12 Yogakurse](${OTHER_URL}), [Sommer (7)](${OTHER_URL}), [12 Kurse im Sommer](${OTHER_URL}) und [alle 7 Kurse zum Thema Yoga](${YOGA_URL}).\n1. [**Alphabetisierungskurs Abschnitt 4 Kurs 311**](${OTHER_URL})\nEnde`,
    `Siehe [12 Yogakurse](${OTHER_URL}), [Sommer (7)](${OTHER_URL}), [12 Kurse im Sommer](${OTHER_URL}) und [alle 7 Kurse zum Thema Yoga](${YOGA_URL}).\n1. [**Alphabetisierungskurs Abschnitt 4 Kurs 311**](${OTHER_URL})\nEnde`,
  ],
  [
    "R4-D2 (R2-S7): verschachtelter Link in Übersichtszeile und -block fällt weg",
    `${DE} [x [Yoga](${HOST}/erfunden) y](${OTHER_URL}) · [Sport](${SPORT_URL})\n${DE}\n- [x [Yoga](${HOST}/erfunden) y](${OTHER_URL}) danach\nEnde`,
    `${DE} [Sport (40\u00a0Kurse)](${SPORT_URL})\nEnde`,
  ],
  [
    "R4-D2 (R2-S7): Referenzlink im Block nach Leerzeile fällt weg",
    `${DE}\n\n[Alle Kurse in Yoga][1]\n\n[1]: ${HOST}/erfunden`,
    `\n[1]: ${HOST}/erfunden`,
  ],
  [
    "R4-D2 (R2-S7): Umbruch im Linktext im Block und in der Zeile: Link samt Folgezeile weg",
    `${DE}\n- [Alle Kurse in\nYoga](${HOST}/erfunden) mehr\n- [Sportkurse](${SPORT_URL})\n${DE} [Alle Kurse\nin Yoga](\n${HOST}/erfunden) · [Sport](${SPORT_URL})\nEnde`,
    `${DE}\n- [Sport (40\u00a0Kurse)](${SPORT_URL})\n${DE} [Sport (40\u00a0Kurse)](${SPORT_URL})\nEnde`,
  ],
  [
    "R4-D2 (R2-S7): „\\“ vor dem Zeilenende: kein Link über zwei Zeilen, Zeilen bleiben getrennt",
    `Siehe [Sommer\\\n(3 Kurse)](${OTHER_URL}) hier\n- [Alle 3 Kurse in Sport](${SPORT_URL})\n${DE}\n- [Yoga\\\nneu](${HOST}/erfunden)\nEnde`,
    `Siehe [Sommer\\\n(3 Kurse)](${OTHER_URL}) hier\n${DE} [Sport (40\u00a0Kurse)](${SPORT_URL})\nEnde`,
  ],
  [
    "S2: Einleitung allein, darunter Liste: Knoten gesetzt, erfundener Link samt Zeile weg",
    `${LIST}\n\n${DE}\n- [Sportkurse (3 Kurse)](${SPORT_URL})\n- [Pilates (4 Kurse)](${HOST}/pilates)\n\nViel Spaß!`,
    `${LIST}\n\n${DE}\n- [Sport (40\u00a0Kurse)](${SPORT_URL})\n\nViel Spaß!`,
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
    `${DE} [Sport (40\u00a0Kurse)](${SPORT_URL})\n${DE} [Yoga (1\u00a0Kurs)](${YOGA_URL})`,
  ],
  [
    "S4: Link mit Titel, Adresse in <…>, HTTPS:// werden erkannt",
    `${DE} [Pilates](${HOST}/pilates "Pilates") · [Yoga]( <${YOGA_URL}> 'Yoga' )\n[**Alle 3 Kurse in Pilates**](<${HOST}/pilates>)\n[Alle 3 Kurse in Sport](HTTPS://WWW.vhs-beispiel.de/kursprogramm/sport)`,
    `${DE} [Yoga (1\u00a0Kurs)](${YOGA_URL})\n${DE} [Sport (40\u00a0Kurse)](${SPORT_URL})`,
  ],
  [
    "S4: Autolink in der Übersichtszeile wird geprüft",
    `${DE} <${HOST}/pilates>\n${DE} <${SPORT_URL}> und <info@vhs-beispiel.de>`,
    `${DE} [Sport (40\u00a0Kurse)](${SPORT_URL})`,
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
      ` [Sport (40\u00a0Kurse)](${SPORT_URL}) danach`
    );
  });

  test("Einleitung am Zeilenanfang wird bis zur Entscheidung gehalten", () => {
    const filter = new OverviewLinkFilter(GUARD);
    expect(filter.push("Absatz\n- Mehr Kur")).toBe("Absatz\n");
    expect(filter.push("se zum Thema: **[Sp")).toBe("");
    expect(filter.push(`ort](${SPORT_URL}) · [Yoga](${YOGA_URL})`)).toBe(
      `${DE} [Sport (40\u00a0Kurse)](${SPORT_URL})\n${DE} [Yoga (1\u00a0Kurs)](${YOGA_URL})`
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
      ` [Yoga (1\u00a0Kurs)](${YOGA_URL})`
    );
  });

  test("Form an einer Stelle: Einleitung und Wort kommen aus OVERVIEW_LINE, je Link eine Zeile (S7-1)", () => {
    const { OVERVIEW_LINE } = chains;
    const saved = JSON.stringify(OVERVIEW_LINE);
    try {
      OVERVIEW_LINE.de.intro = "Weitere Angebote:";
      OVERVIEW_LINE.de.many = "Angebote";
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
        `Weitere Angebote: [Sport (40\u00a0Angebote)](${SPORT_URL})\nWeitere Angebote: [Yoga (1\u00a0Kurs)](${YOGA_URL})`
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

  test("R2-S10: mehr als 16 Schmuckzeichen vor einem verworfenen Link: jede Aufteilung gleich der ganzen Antwort", () => {
    for (const lead of [
      "*".repeat(20),
      " ".repeat(17),
      `${"_".repeat(10)} ${"*".repeat(10)}`,
      ` ${"*".repeat(15)}`,
    ]) {
      const reply = `Mehr unter${lead}[Alle Kurse in X](${HOST}/erfunden) hier.\nEnde`;
      const whole = parseCardsReply(reply, { overviewLinks: GUARD }).text;
      expect(
        whole.startsWith(lead.length > 16 ? `Mehr unter${lead}` : "Mehr unter")
      ).toBe(true);
      expect([...splitEverywhere(reply)]).toEqual([whole]);
    }
  });

  test("Schmuck am Zeilenanfang wird nur bis zur Entscheidung gehalten", () => {
    const filter = new OverviewLinkFilter(GUARD);
    expect(filter.push("Absatz\n- ")).toBe("Absatz\n");
    expect(filter.push("Punkt")).toBe("- Punkt");
  });

  // ganze Antwort und jede Aufteilung mit eigenem Prüfer
  const expectGuarded = (guard, reply, expected) => {
    expect(parseCardsReply(reply, { overviewLinks: guard }).text).toBe(
      expected
    );
    expect([...splitEverywhere(reply, guard)]).toEqual([expected]);
  };

  test("R3-S2: Kurstitel auf einer Knotenadresse direkt unter der Übersichtszeile behält seinen Text (AK-21 wie im Fließtext)", () => {
    const reply = `${DE} [Yoga](${YOGA_URL})\n[Aquarell](${YOGA_URL}) ab 02.03.2026\nEnde`;
    expectGuarded(
      GUARD,
      reply,
      `${DE} [Yoga (1 Kurs)](${YOGA_URL})\n[Aquarell](${AQUARELL_URL}) ab 02.03.2026\nEnde`
    );
  });

  test("R7-D1: Kurstitel auf einer Knotenadresse als Aufzählung direkt unter der Übersichtszeile wie im Fließtext", () => {
    const reply = `${DE} [Yoga](${YOGA_URL})\n- [Aquarell](${YOGA_URL}) ab 02.03.2026\nEnde`;
    expectGuarded(
      GUARD,
      reply,
      `${DE} [Yoga (1\u00a0Kurs)](${YOGA_URL})\n- [Aquarell](${AQUARELL_URL}) ab 02.03.2026\nEnde`
    );
  });

  test("R7-D2 (AK-9): Oberkategorie im angezeigten Titel weg, wenn der Name sie enthält; Kontext unverändert", () => {
    const url = (n) => `${HOST}/kursprogramm/kategorie/${n}`;
    const map = chains.parseCategoryMap(
      JSON.stringify({
        version: 1,
        client: "vhs-beispiel",
        created: new Date().toISOString(),
        nodes: {
          "Sprachen \\ Intensivkurse \\ Intensivkurs - A 1": {
            title: "Intensivkurse · Intensivkurs - A 1",
            url: url(1),
            count: 4,
          },
          "Gesundheit \\ Entspannungstechniken \\ Qi Gong": {
            title: "Entspannungstechniken · Qi Gong",
            url: url(2),
            count: 3,
          },
        },
        courses: {},
      })
    );
    const context = applyCategoryChains(
      [
        courseDoc(
          "Qi Gong",
          "26100-010",
          "Gesundheit \\ Entspannungstechniken \\ Qi Gong",
          `${HOST}/kurssuche/kurs/qi-gong/26100-010`
        ),
      ],
      map
    );
    expect(context[0]).toContain(
      `Entspannungstechniken · Qi Gong (3 Kurse) | ${url(2)}`
    );
    const guard = createOverviewLinkGuard({ contextTexts: context, map });
    expectGuarded(
      guard,
      `${DE} [Intensivkurs A1](${url(1)}) · [Qi Gong](${url(2)})\nSiehe [Intensivkurse (2 Kurse)](${url(1)}).`,
      `${DE} [Intensivkurs - A 1 (4\u00a0Kurse)](${url(1)})\n${DE} [Entspannungstechniken · Qi Gong (3\u00a0Kurse)](${url(2)})\nSiehe [Intensivkurs - A 1 (4\u00a0Kurse)](${url(1)}).`
    );
  });

  test("R3-S5: bekannte Adresse mit 301 bis 500 Zeichen bleibt in der Übersichtszeile", () => {
    const long = `${HOST}/kurse/${"a".repeat(400)}`;
    const guard = createOverviewLinkGuard({
      contextTexts: [`Siehe ${long} für alles.`],
      map: MAP,
    });
    const reply = `${DE} [Sommer](${long})\nEnde`;
    expectGuarded(guard, reply, reply);
    expect(chains.linkKey(long)).not.toBeNull();
    expect(chains.linkKey(`${long}${"a".repeat(100)}`)).toBeNull();
  });

  test("R3-S6: unsichere oder schwächere Originalform ersetzt die Adresse des Modells nicht", () => {
    const guard = createOverviewLinkGuard({
      contextTexts: [
        `Sommer: ${HOST}/kurse/sommer\\ und Winter: http://www.vhs-beispiel.de/kurse/winter sowie ${HOST}/kurse/herbst`,
      ],
      map: MAP,
    });
    const reply = `${DE} [Sommer](${HOST}/kurse/sommer) · [Winter](${HOST}/kurse/winter) · [Herbst](http://vhs-beispiel.de/kurse/herbst/)\nEnde`;
    expectGuarded(
      guard,
      reply,
      `${DE} [Sommer](${HOST}/kurse/sommer)\n${DE} [Winter](${HOST}/kurse/winter)\n${DE} [Herbst](${HOST}/kurse/herbst)\nEnde`
    );
  });

  test("R6-D4 (G3): Zahl und Kurswort im Linktext mit geschütztem Leerzeichen, Kette im Kontext mit Leerzeichen", () => {
    expect(
      parseCardsReply(`${DE} [Sport](${SPORT_URL})`, { overviewLinks: GUARD })
        .text
    ).toBe(`${DE} [Sport (40 Kurse)](${SPORT_URL})`);
    expect(CONTEXT[0]).toContain(`: Yoga (1 Kurs) | ${YOGA_URL}`);
  });

  test("R6-D1: 100.000 Zeichen feindlicher Text je Pfad dieser Runde: ganze Antwort und Stream schnell und gleich", () => {
    const N = 100000;
    const fill = (unit) => unit.repeat(Math.ceil(N / unit.length));
    const replies = {
      // R3-S1: Leerzeile vor der Liste eines Übersichtsblocks
      leerraum: `${DE}\n${" ".repeat(N)}\n- [Sport](${SPORT_URL})\nEnde`,
      tabs: `${DE}\n${"\t ".repeat(N / 2)}\n\n- [Sport](${SPORT_URL})\nEnde`,
      // R3-S2: Zeilen unter einer Übersichtszeile
      folgezeilen: `${DE} [Yoga](${YOGA_URL})\n${fill("[Hinweis] [")}`,
      // R3-S3: weiter Scan mit „\\“ vor Zeilenenden
      maskiert: `${DE}\n- [${fill("a\\\n")}`,
      // R6-D3: eigene Einleitung, lange Zeile ohne „:“ und viele Absätze
      einleitung: `${fill("Weitere Angebote ")}\n\n${fill(`${"x".repeat(79)}: [Sport (3 Kurse)](${SPORT_URL}) x\n\n`)}`,
      // R3-S4: Kurszahlen im Linktext
      zahlen: `${DE} [${"(1 Kurs) ".repeat(60)}](${OTHER_URL})\n`.repeat(170),
    };
    for (const [name, reply] of Object.entries(replies)) {
      let start = process.hrtime.bigint();
      const whole = parseCardsReply(reply, { overviewLinks: GUARD }).text;
      const wholeMs = Number(process.hrtime.bigint() - start) / 1e6;
      start = process.hrtime.bigint();
      const stream = streamed(reply, 31);
      const streamMs = Number(process.hrtime.bigint() - start) / 1e6;
      expect({
        name,
        wholeMs: wholeMs < 1000,
        streamMs: streamMs < 2000,
      }).toEqual({ name, wholeMs: true, streamMs: true });
      expect(stream).toBe(whole);
    }
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
    // R4-D2: Link über ein Zeilenende, verschachtelt, "\" vor dem
    // Zeilenende, lange Schmuckfolge
    `[Alle Kurse in\nX](${HOST}/erfunden)`,
    `[x [Pilates](${HOST}/erfunden) y](${OTHER_URL})`,
    "\\\n",
    "*".repeat(20),
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
