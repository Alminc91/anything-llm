/**
 * Tabellenzeilen als Textzeilen beim Einlesen von Website-Seiten
 * (einlesen-tabellen-platzhalter, Teil T).
 *
 * `document.body.innerText` setzt Tabs zwischen die Zellen einer Tabelle und
 * Zeilenumbrüche innerhalb einer Zelle. Bei Kursübersichten steht dadurch die
 * Kursnummer einer Zeile direkt vor dem Titel der nächsten. Hier wird jede
 * Tabellenzeile eine Textzeile, die Zellen durch " | " getrennt.
 *
 * `tableRowsToText` läuft im Browser: generic.js gibt die Funktion an
 * `page.evaluate`, und Puppeteer schickt nur ihren Quelltext. Sie darf deshalb
 * nichts außerhalb ihres eigenen Rumpfs verwenden (keine Modulvariablen,
 * kein require) und hat keine Abhängigkeiten.
 */

/**
 * Liest den Seitentext wie `document.body.innerText`, aber mit jeder
 * Tabellenzeile als eigener Textzeile.
 *
 * - Umgewandelt werden Zeilen (`tr`) mit mindestens zwei sichtbaren Zellen
 *   (`td`, `th`). Zellen werden durch " | " verbunden, Leerraum in einer Zelle
 *   wird ein Leerzeichen, leere Zellen fallen weg.
 * - Die äußere Zeile einer verschachtelten Tabelle bleibt, wie sie ist; die
 *   Zeilen der inneren Tabelle werden umgewandelt.
 * - Unsichtbare Zellen und Zeilen bleiben unverändert (sie stehen auch heute
 *   nicht im Text).
 * - Ohne umwandelbare Zeile kommt der innerText unverändert zurück.
 * - Rückfall auf den unveränderten innerText, wenn das Umwandeln wirft oder
 *   sich der Wortbestand ändert (Wörter zwischen Leerraum, ohne "|").
 *
 * @returns {{text: string, rows: number, fallback: (null|"fehler"|"woerter"), error?: string}}
 *   `rows`: Zahl der umgewandelten Zeilen; `fallback`: Grund für den Rückfall.
 */
function tableRowsToText() {
  const original = document.body.innerText;
  const SEPARATOR = " | ";

  const wordCounts = (text) => {
    const counts = new Map();
    for (const word of text.split(/\s+/)) {
      if (!word || /^\|+$/.test(word)) continue;
      counts.set(word, (counts.get(word) || 0) + 1);
    }
    return counts;
  };
  const sameWords = (a, b) => {
    if (a.size !== b.size) return false;
    for (const [word, count] of a) if (b.get(word) !== count) return false;
    return true;
  };
  const isRendered = (element) =>
    typeof element.checkVisibility === "function"
      ? element.checkVisibility()
      : element.getClientRects().length > 0;

  try {
    // Erst alle Zeilen lesen, dann ändern: Lesen nach einer Änderung erzwänge
    // je Zeile ein neues Layout.
    const plans = [];
    for (const row of document.querySelectorAll("tr")) {
      if (row.cells.length < 2) continue;
      if (row.querySelector("table")) continue;
      const cells = Array.from(row.cells).filter(isRendered);
      if (cells.length < 2) continue;
      const parts = cells
        .map((cell) => cell.innerText.replace(/\s+/g, " ").trim())
        .filter((part) => part.length > 0);
      if (parts.length === 0) continue;
      plans.push({ row, cells, line: parts.join(SEPARATOR) });
    }
    if (plans.length === 0) return { text: original, rows: 0, fallback: null };

    for (const { row, cells, line } of plans) {
      const cell = document.createElement("td");
      // Der gelesene Text ist schon so geschrieben, wie er angezeigt wurde.
      cell.style.textTransform = "none";
      cell.textContent = line;
      row.insertBefore(cell, cells[0]);
      for (const old of cells) old.remove();
    }

    const text = document.body.innerText;
    if (!sameWords(wordCounts(original), wordCounts(text)))
      return { text: original, rows: 0, fallback: "woerter" };
    return { text, rows: plans.length, fallback: null };
  } catch (error) {
    return {
      text: original,
      rows: 0,
      fallback: "fehler",
      error: String((error && error.message) || error),
    };
  }
}

module.exports = { tableRowsToText };
