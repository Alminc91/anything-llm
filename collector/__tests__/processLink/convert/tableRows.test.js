/* eslint-env jest */
// tableRowsToText (einlesen-tabellen-platzhalter, Teil T): Puppeteer gibt nur
// den Quelltext der Funktion an den Browser. Diese Tests führen deshalb den
// Quelltext in einem leeren Kontext aus (ohne module, require oder sonstige
// Werte aus der Datei) gegen ein kleines Ersatz-DOM. Das echte Verhalten in
// Chromium prüft test_table_rows_chromium.py im selben Ordner.
const vm = require("vm");
const { tableRowsToText } = require("../../../processLink/convert/tableRows");

// Ersatz-DOM: innerText der Seite = Zeilen mit Tabs zwischen sichtbaren Zellen,
// wie Chromium es für einfache Tabellen liefert.
function fakeDocument(rowSpecs, { bodyText } = {}) {
  const created = [];
  const makeCell = (spec) => {
    const cell =
      typeof spec === "string"
        ? { text: spec, rendered: true }
        : { rendered: true, ...spec };
    return {
      tagName: "TD",
      get innerText() {
        if (cell.throws) throw new Error("Zelle kaputt");
        return cell.rendered ? cell.text : "";
      },
      getClientRects: () => (cell.rendered ? [{}] : []),
      checkVisibility: () => cell.rendered,
      rendered: cell.rendered,
      rawText: cell.text,
      parent: null,
      remove() {
        this.parent.children = this.parent.children.filter((c) => c !== this);
      },
    };
  };
  const rows = rowSpecs.map((spec) => {
    const row = {
      nested: Boolean(spec.nested),
      children: [],
      get cells() {
        return this.children.filter((c) => c.tagName === "TD");
      },
      querySelector: (sel) => (sel === "table" && spec.nested ? {} : null),
      insertBefore(node, ref) {
        node.parent = this;
        const i = this.children.indexOf(ref);
        this.children.splice(i, 0, node);
      },
    };
    for (const c of spec.cells || spec) {
      const cell = makeCell(c);
      cell.parent = row;
      row.children.push(cell);
    }
    return row;
  });
  const lineOf = (row) =>
    row.children
      .filter((c) => c.rendered)
      .map((c) => (c.rawText !== undefined ? c.rawText : c.innerText))
      .join("\t");
  return {
    created,
    rows,
    querySelectorAll: (sel) => (sel === "tr" ? rows : []),
    createElement: (tag) => {
      const node = {
        tagName: tag.toUpperCase(),
        textContent: "",
        style: {},
        rendered: true,
        get innerText() {
          return this.textContent;
        },
      };
      created.push(node);
      return node;
    },
    body: {
      get innerText() {
        if (bodyText) return bodyText(rows.map(lineOf).join("\n"));
        return rows.map(lineOf).join("\n");
      },
    },
  };
}

// Wie Puppeteer: `(${fn})()` im Browserkontext, hier ein frischer vm-Kontext.
function runInPage(document) {
  return vm.runInNewContext(`(${tableRowsToText.toString()})()`, { document });
}

describe("tableRowsToText", () => {
  test("ist eine Funktion, die ohne Modulumgebung läuft", () => {
    expect(typeof tableRowsToText).toBe("function");
    const doc = fakeDocument([]);
    const result = runInPage(doc);
    expect(result.text).toBe("");
    expect(result.rows).toBe(0);
    expect(result.fallback).toBeNull();
  });

  test("ohne umwandelbare Zeile: Text byte-gleich, DOM unverändert", () => {
    const doc = fakeDocument([["Nur eine Zelle"], ["Noch eine"]]);
    const before = doc.body.innerText;
    const result = runInPage(doc);
    expect(result.text).toBe(before);
    expect(result.rows).toBe(0);
    expect(doc.created).toHaveLength(0);
  });

  test("Zellen mit ' | ' verbunden, Leerraum zu einem Leerzeichen, leere Zellen weg", () => {
    const doc = fakeDocument([
      [
        "Titel\nStatus: offen",
        "Mi. 07.10.2026,\n9.30 Uhr",
        "",
        "  \n ",
        "26B6734",
      ],
      ["\u00a0", "Mitte", "Ende\t"],
    ]);
    const result = runInPage(doc);
    expect(result.fallback).toBeNull();
    expect(result.rows).toBe(2);
    expect(result.text).toBe(
      "Titel Status: offen | Mi. 07.10.2026, 9.30 Uhr | 26B6734\nMitte | Ende"
    );
  });

  test("unsichtbare Zellen zählen nicht und bleiben stehen", () => {
    const doc = fakeDocument([
      ["A", { text: "versteckt", rendered: false }, "B"],
      ["Allein", { text: "versteckt", rendered: false }],
    ]);
    const result = runInPage(doc);
    expect(result.text).toBe("A | B\nAllein");
    expect(result.rows).toBe(1);
    expect(doc.rows[0].children.map((c) => c.innerText)).toEqual(["A | B", ""]);
  });

  test("äußere Zeile mit verschachtelter Tabelle bleibt unverändert", () => {
    const doc = fakeDocument([
      { cells: ["Links", "Innen"], nested: true },
      ["Kurs A", "26X0001"],
    ]);
    const result = runInPage(doc);
    expect(result.rows).toBe(1);
    expect(result.text).toBe("Links\tInnen\nKurs A | 26X0001");
  });

  test("Fehler beim Lesen einer Zelle: heutiger innerText", () => {
    const doc = fakeDocument([["A", { text: "B", throws: true }]]);
    const before = doc.body.innerText;
    const result = runInPage(doc);
    expect(result.fallback).toBe("fehler");
    expect(result.rows).toBe(0);
    expect(result.text).toBe(before);
    expect(result.error).toContain("Zelle kaputt");
  });

  test("Fehler beim Ändern des DOM: heutiger innerText", () => {
    const doc = fakeDocument([["A", "B"]]);
    doc.createElement = () => {
      throw new Error("kaputt");
    };
    const before = doc.body.innerText;
    const result = runInPage(doc);
    expect(result.fallback).toBe("fehler");
    expect(result.text).toBe(before);
  });

  test("abweichender Wortbestand: heutiger innerText", () => {
    let reads = 0;
    const doc = fakeDocument([["A", "B"]], {
      bodyText: (text) => (reads++ === 0 ? text : `${text} Fremd`),
    });
    const result = runInPage(doc);
    expect(result.fallback).toBe("woerter");
    expect(result.rows).toBe(0);
    expect(result.text).toBe("A\tB");
  });

  test("Trennzeichen aus der Seite zählen nicht als Wort", () => {
    const doc = fakeDocument([["Start | Kontakt", "B"]]);
    const result = runInPage(doc);
    expect(result.fallback).toBeNull();
    expect(result.text).toBe("Start | Kontakt | B");
  });
});
