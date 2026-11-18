const {
  KUFER_FILTER_SELECTOR,
  stripKuferFilter,
} = require("../../../utils/kuferFilter");

// Reduced copy of a webbasys category page (vhs-tuttlingen, Kategorie 134):
// filter box with location, weekday and instructor lists next to the course table.
const CATEGORY_PAGE = `<html><body>
<h1>Berufssprachkurse</h1>
<div id="kw-filter" class="kw-filter">
  <div class="kw-kataslist kw-filtercontainer"><b>Ort</b><ul><li>Spaichingen</li><li>Trossingen</li></ul></div>
  <div class="kw-katwotage kw-filtercontainer"><b>Wochentage</b><ul><li>Montag</li><li>Dienstag</li></ul></div>
  <div class="kw-katdozent kw-filtercontainer"><b>Kursleitende</b><ul><li>Fomin, Nune</li><li>Wöhrstein, Anna</li></ul></div>
  <a href="/integration/berufssprachkurse/kategorie/134?clearallkatfilter=true">Filter leeren</a>
</div>
<table class="kw-table">
  <tr><td><a href="/kurse/kurs/BSK-59">Berufssprachkurs Nr. 59</a></td><td>Mo, 14.09.2026</td><td>Trossingen</td></tr>
  <tr><td><a href="/kurse/kurs/BSK-60">Berufssprachkurs Nr. 60</a></td><td>Di, 15.09.2026</td><td>Spaichingen</td></tr>
</table>
</body></html>`;

describe("stripKuferFilter", () => {
  test("removes the filter box and keeps the course table", () => {
    const out = stripKuferFilter(CATEGORY_PAGE);
    expect(out).not.toContain("kw-filter");
    expect(out).not.toContain("Kursleitende");
    expect(out).not.toContain("Wöhrstein");
    expect(out).not.toContain("Filter leeren");
    expect(out).toContain("<h1>Berufssprachkurse</h1>");
    expect(out).toContain("Berufssprachkurs Nr. 59");
    expect(out).toContain("Berufssprachkurs Nr. 60");
    // Locations still reach the chatbot via the course rows themselves
    expect(out).toContain("<td>Trossingen</td>");
  });

  test("removes standalone filter containers without the outer box", () => {
    const html =
      '<div class="kw-katdozent kw-filtercontainer">Kursleitende: A, B</div><p>Inhalt</p>';
    expect(stripKuferFilter(html)).toBe("<p>Inhalt</p>");
  });

  test("returns pages without a filter box unchanged (byte-identical)", () => {
    const html = '<html><body><p class="kw-filterless">Text &amp; mehr</p></body></html>';
    expect(stripKuferFilter(html)).toBe(html);
    const plain = "<p>Keine Kufer-Seite</p>";
    expect(stripKuferFilter(plain)).toBe(plain);
  });

  test("passes non-string input through", () => {
    expect(stripKuferFilter(null)).toBeNull();
    expect(stripKuferFilter(undefined)).toBeUndefined();
  });

  test("selector covers exactly the Kufer filter box", () => {
    expect(KUFER_FILTER_SELECTOR).toBe("#kw-filter, .kw-filter, .kw-filtercontainer");
  });
});
