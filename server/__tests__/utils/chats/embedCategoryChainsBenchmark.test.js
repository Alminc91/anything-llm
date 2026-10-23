/* eslint-env jest, node */
// KIE-576 AK-16: Benchmark-Gleichheit. Die Server-Kette ergibt für echte
// Quelltexte der Benchmarkläufe (Lauf 4 F3b, Lauf 5 F3c, 16 Kunden) dieselben
// Kettenzeilen wie der Benchmark (f3_ctx), Zeile für Zeile.
// Fixture: issues/KIE-576/benchmark/server_fixture/bauen.py (Texte gekürzt auf
// Metadatenkopf und Kopfblock, Karten im Vertragsformat auf die berührten
// Knoten gekürzt). Bewusste Unterschiede:
//   - Zahlenquelle: count stammt aus dem Feed zum Bauzeitpunkt, nicht aus dem
//     Feed beim Benchmark; verglichen wird die Zeile ohne „(n Kurse)“, die Zahl
//     separat gegen die Karte.
//   - Sonderknoten nach F3c-Muster (E20) für alle 16 Kunden; Lauf 4 nutzte
//     das engere F3b-Muster (in den Fällen ohne Unterschied).
//   - courses (Webseiten-Zuordnung E21) gibt es im Benchmark nicht: leer.
//   - Fälle, deren Karte sich seit dem Benchmark geändert hat, sind nicht im
//     Fixture (bauen.py meldet sie; Messung über alle 330 Fälle: messen.js).

jest.mock("../../../utils/prisma", () => ({}));

const fixture = require("./fixtures/benchmarkChains.json");
const {
  applyCategoryChains,
  __test__,
} = require("../../../utils/chats/embedCategoryChains");

const CHAIN_LINE = /^Kategorie-Ebene \d+: .*$/gm;
const COUNT = / \((\d+) Kurse?\)( \| )/;
const withoutCount = (line) => line.replace(COUNT, "$2");

const maps = Object.fromEntries(
  Object.entries(fixture.karten).map(([client, data]) => [
    client,
    __test__.parseCategoryMap(
      JSON.stringify({ ...data, created: new Date().toISOString() })
    ),
  ])
);

describe("AK-16: Server-Kette gleich Benchmark-Kette", () => {
  test("Fixture deckt alle 16 Kunden, etwa 40 Fälle, Dortmund „Neu hinzugefügt“ und Meppen Warteliste", () => {
    const clients = new Set(fixture.faelle.map((c) => c.kunde));
    expect(clients.size).toBe(16);
    expect(fixture.faelle.length).toBeGreaterThanOrEqual(35);
    const texts = (client) =>
      fixture.faelle
        .filter((c) => c.kunde === client)
        .flatMap((c) => c.quellen);
    expect(
      texts("vhs-dortmund").some((t) =>
        /^Kategoriepfad: .*Neu hinzugefügt/m.test(t)
      )
    ).toBe(true);
    expect(
      texts("vhs-meppen").some((t) => /^Kategoriepfad: .*Warteliste/m.test(t))
    ).toBe(true);
    for (const map of Object.values(maps)) expect(map).not.toBeNull();
  });

  test.each(fixture.faelle.map((c) => [c.id, c]))(
    "%s: Kettenzeilen je Quelle gleich (ohne Zahl), Zahl aus der Karte",
    (_id, c) => {
      const map = maps[c.kunde];
      const out = applyCategoryChains(c.quellen, map);
      out.forEach((text, i) => {
        const lines = text.match(CHAIN_LINE) ?? [];
        expect(lines.map(withoutCount)).toEqual(
          c.erwartet[i].map(withoutCount)
        );
        // Zahl: die der Karte (Vertrag), nicht die des Benchmark-Feeds
        for (const line of lines) {
          const url = line.slice(line.lastIndexOf(" | ") + 3);
          const counts = [...map.nodes.values()]
            .filter((n) => n.url === url)
            .map((n) => n.count);
          const shown = COUNT.exec(line);
          expect(counts).toContain(shown ? Number(shown[1]) : null);
        }
        // Kursdokumente: Kette direkt nach Kategoriepfad, ohne die vier Zeilen
        if (/^Kategoriepfad: /m.test(text)) {
          expect(text).not.toMatch(
            /^(?:Kategorie-Link-Titel|Kategorie-Link|Bereich-Link-Titel|Bereich-Link):/m
          );
          if (lines.length > 0)
            expect(text).toContain(
              `${text.match(/^Kategoriepfad: .*$/m)[0]}\n${lines.join("\n")}\n`
            );
        } else if (lines.length > 0) {
          expect(text).toContain(`</document_metadata>\n${lines.join("\n")}\n`);
        } else {
          expect(text).toBe(c.quellen[i]);
        }
      });
    }
  );

  test("Summe: Kettenzeilen verglichen, gecrawlte Kategorieseiten dabei", () => {
    let lines = 0;
    let crawled = 0;
    for (const c of fixture.faelle)
      c.erwartet.forEach((expected, i) => {
        lines += expected.length;
        if (expected.length > 0 && !/^Kategoriepfad: /m.test(c.quellen[i]))
          crawled += 1;
      });
    expect(lines).toBeGreaterThan(300);
    expect(crawled).toBeGreaterThan(5);
  });
});
