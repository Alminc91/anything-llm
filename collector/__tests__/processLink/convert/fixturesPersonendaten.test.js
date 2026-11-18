// Gespeicherte Seiten unter support/fixtures/ ohne Personendaten
// (einlesen-tabellen-platzhalter, 8.2-rc2 T1, Review R13, D7).
//
// Die Seiten liegen im Fork-Repo. Namen, Durchwahlen, persönliche E-Mail-
// Adressen und Fotos von Mitarbeitern und Kursleitungen sind durch Platzhalter
// ersetzt; allgemeine Adressen und Nummern der Einrichtung dürfen bleiben.
// Tabellen und Kurszeilen sind unverändert (AK-1 bis AK-4 im Chromium-Test).
//
// Wer eine neue Seite speichert, ersetzt diese Daten vorher durch die
// Platzhalter unten. Eine allgemeine Adresse oder Nummer (Funktionspostfach,
// Zentrale) kommt bewusst in die Listen.
const fs = require("fs");
const path = require("path");

const FIXTURES = path.join(__dirname, "support", "fixtures");

const ALLGEMEINE_ADRESSEN = new Set([
  "info@vhs-delmenhorst.de",
  "anmeldung@vhs-delmenhorst.de",
  "info@kufer.de", // Support-Adresse im Chatbot-Skript der Seite
]);
const PLATZHALTER_DOMAIN = "@example.org";

// Nur Ziffern: Zentrale der vhs Delmenhorst und der Platzhalter 04221 000-000.
const ALLGEMEINE_NUMMERN = new Set(["04221981800", "04221000000"]);

const PLATZHALTER_ANSPRECHPARTNER = new Set([
  "Mitarbeiter Beispiel",
  "Team Anmeldung",
]);
const PLATZHALTER_DOZENT = "Dozent Beispiel";
const PLATZHALTER_DOZENT_LINK = "/dozierende/dozent/Beispiel-Dozent/0000";
const PLATZHALTER_FOTO = "B_000_1";

const E_MAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// Vorwahl mit 0, dann mindestens fünf weitere Ziffern mit Leerzeichen,
// Schrägstrich oder Bindestrich dazwischen (04221 - 98180 1234, 04221981800).
const TELEFON = /(?<![\w.])0\d{2,5}(?:[ \t/-]*\d){5,}/g;

function htmlDateien(ordner) {
  return fs
    .readdirSync(ordner, { withFileTypes: true })
    .flatMap((eintrag) => {
      const pfad = path.join(ordner, eintrag.name);
      if (eintrag.isDirectory()) return htmlDateien(pfad);
      return eintrag.name.endsWith(".html") ? [pfad] : [];
    })
    .sort();
}

const seiten = htmlDateien(FIXTURES).map((datei) => [
  path.relative(FIXTURES, datei),
  fs.readFileSync(datei, "utf8"),
]);

function eindeutig(werte) {
  return [...new Set(werte)].sort();
}

// Block .kw-details-ansprechpartner bis zum nächsten Skript (JSON-LD).
function ansprechpartnerBloecke(html) {
  return html
    .split('class="kw-details-ansprechpartner"')
    .slice(1)
    .map((rest) => rest.split("<script")[0]);
}

describe("Fixtures ohne Personendaten", () => {
  test("es gibt gespeicherte Seiten", () => {
    expect(seiten.length).toBeGreaterThan(0);
  });

  test.each(seiten)("%s: nur allgemeine E-Mail-Adressen", (_, html) => {
    const persoenlich = eindeutig(html.match(E_MAIL) || []).filter(
      (adresse) =>
        !ALLGEMEINE_ADRESSEN.has(adresse.toLowerCase()) &&
        !adresse.toLowerCase().endsWith(PLATZHALTER_DOMAIN)
    );
    expect(persoenlich).toEqual([]);
  });

  test.each(seiten)("%s: nur allgemeine Telefonnummern", (_, html) => {
    const durchwahlen = eindeutig(html.match(TELEFON) || []).filter(
      (nummer) => !ALLGEMEINE_NUMMERN.has(nummer.replace(/\D/g, ""))
    );
    expect(durchwahlen).toEqual([]);
  });

  test.each(seiten)("%s: Ansprechpartner nur als Platzhalter", (_, html) => {
    const namen = ansprechpartnerBloecke(html).flatMap((block) =>
      Array.from(block.matchAll(/>\s*([^<>]+?)\s*<br>\s*Tel\.?:/g), (t) =>
        t[1].trim()
      )
    );
    expect(
      eindeutig(namen).filter((name) => !PLATZHALTER_ANSPRECHPARTNER.has(name))
    ).toEqual([]);
    const fotos = Array.from(
      html.matchAll(/bilder\/ben\/(B_\d+_\d+)\.\w+/g),
      (t) => t[1]
    );
    expect(
      eindeutig(fotos).filter((foto) => foto !== PLATZHALTER_FOTO)
    ).toEqual([]);
  });

  test.each(seiten)("%s: Kursleitung nur als Platzhalter", (_, html) => {
    const links = Array.from(
      html.matchAll(/href="(\/dozierende\/dozent\/[^"]*)"/g),
      (t) => t[1]
    );
    expect(
      eindeutig(links).filter((link) => link !== PLATZHALTER_DOZENT_LINK)
    ).toEqual([]);
    const anker = Array.from(
      html.matchAll(
        /<a href="\/dozierende\/dozent\/[^"]*"[^>]*aria-label="([^"]*)"[^>]*>\s*([^<]*?)\s*<\/a>/g
      ),
      (t) => ({ label: t[1].replace(/\s+/g, " "), text: t[2] })
    );
    expect(anker).toHaveLength(links.length);
    for (const { label, text } of anker) {
      expect(text).toBe(PLATZHALTER_DOZENT);
      expect(label).toContain(` ${PLATZHALTER_DOZENT} `);
    }
  });
});
