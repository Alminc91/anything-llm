"""Unittest für das Messskript support/messung_tabellen.py (8.2-rc2 T2, Review R8, R23, K6).

Aufruf (System-python3; der letzte Fall braucht Playwright und Chromium):

    python3 collector/__tests__/processLink/convert/test_messung_tabellen.py -v

Geprüft wird das Lesen der Adressliste („#“ leitet nur am Zeilenanfang oder
nach Leerraum einen Kommentar ein), der Schlüssel wie ``validateURL`` im
Collector (so steht die Adresse in ``chunkSource``), dass ``dokumente_lesen``
nur die gemessenen Adressen hält und dass leere Eingaben mit Exit 1 enden.
"""

import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from urllib.parse import quote

HIER = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HIER, "support"))

import messung_tabellen  # noqa: E402
import textlesen  # noqa: E402

DELMENHORST = os.path.join(textlesen.FIXTURES, "delmenhorst")
WORKTREE = os.path.abspath(os.path.join(textlesen.COLLECTOR, ".."))


def arbeitsordner():
    """Temporärer Ordner unter TMPDIR, ohne TMPDIR unter .test-storage/tmp im Worktree."""
    basis = os.environ.get("TMPDIR") or os.path.join(WORKTREE, ".test-storage", "tmp")
    os.makedirs(basis, exist_ok=True)
    return tempfile.TemporaryDirectory(prefix="messung-unittest-", dir=basis)


def schreiben(pfad, text):
    os.makedirs(os.path.dirname(pfad), exist_ok=True)
    with open(pfad, "w", encoding="utf-8") as datei:
        datei.write(text)


def dokument(pfad, quelle, inhalt):
    schreiben(pfad, json.dumps({"chunkSource": quelle, "pageContent": inhalt}))


class AdressenLesen(unittest.TestCase):
    def setUp(self):
        self._ordner = arbeitsordner()
        self.ordner = self._ordner.name

    def tearDown(self):
        self._ordner.cleanup()

    def liste(self, text):
        pfad = os.path.join(self.ordner, "adressen.txt")
        schreiben(pfad, text)
        return messung_tabellen.adressen_lesen(pfad)

    def test_adresse_mit_fragment_bleibt_ganz(self):
        eintraege = self.liste(
            "vhs-lingen https://www.vhs-lingen.de/#kontakt-info\n"
            "https://www.vhs-lingen.de/kurse#kontakt-info\n"
        )
        self.assertEqual(
            eintraege,
            [
                {"kunde": "vhs-lingen", "url": "https://www.vhs-lingen.de/#kontakt-info"},
                {"kunde": "", "url": "https://www.vhs-lingen.de/kurse#kontakt-info"},
            ],
        )

    def test_kommentar_nur_am_zeilenanfang_oder_nach_leerraum(self):
        eintraege = self.liste(
            "# Kommentarzeile\n"
            "   # eingerückter Kommentar\n"
            "\n"
            "kunde-a https://a.example.org/seite#teil  # Kommentar nach Leerzeichen\n"
            "https://b.example.org/#x\t# Kommentar nach Tab\n"
            "https://c.example.org/a#b#c\n"
            "kunde-d https://d.example.org/#\n"
        )
        self.assertEqual(
            eintraege,
            [
                {"kunde": "kunde-a", "url": "https://a.example.org/seite#teil"},
                {"kunde": "", "url": "https://b.example.org/#x"},
                {"kunde": "", "url": "https://c.example.org/a#b#c"},
                {"kunde": "kunde-d", "url": "https://d.example.org/#"},
            ],
        )

    def test_leere_liste(self):
        self.assertEqual(self.liste("# nur Kommentar\n\n   \n"), [])


class SchluesselWieCollector(unittest.TestCase):
    def test_wie_validate_url(self):
        # Erwartung aus collector/utils/url (validateURL, siehe auch
        # collector/__tests__/utils/url/index.test.js): new URL(...).toString(),
        # ohne Protokoll https://, ein Schrägstrich am Ende fällt weg.
        self.assertEqual(
            textlesen.adressen_wie_collector(
                [
                    "https://www.vhs-lingen.de#kontakt-info",
                    "https://www.vhs-lingen.de/#kontakt-info",
                    "https://www.vhs-lingen.de/",
                    "https://WWW.VHS-Lingen.de/Kurse/",
                    "www.vhs-lingen.de/kurse?id=1",
                    "  https://x.example.org/a b  ",
                    "file:///pfad/seite.html#teil",
                ]
            ),
            [
                "https://www.vhs-lingen.de/#kontakt-info",
                "https://www.vhs-lingen.de/#kontakt-info",
                "https://www.vhs-lingen.de",
                "https://www.vhs-lingen.de/Kurse",
                "https://www.vhs-lingen.de/kurse?id=1",
                "https://x.example.org/a%20b",
                "file:///pfad/seite.html#teil",
            ],
        )

    def test_leere_eingabe(self):
        self.assertEqual(textlesen.adressen_wie_collector([]), [])


class DokumenteLesen(unittest.TestCase):
    def setUp(self):
        self._ordner = arbeitsordner()
        self.ordner = self._ordner.name
        self.dokumente = os.path.join(self.ordner, "dokumente")
        dokument(
            os.path.join(self.dokumente, "a.json"),
            "link://https://www.vhs-lingen.de/#kontakt-info",
            "Text A",
        )
        dokument(os.path.join(self.dokumente, "b.json"), "link://https://andere.example.org/seite", "Text B")
        dokument(os.path.join(self.dokumente, "c.json"), "upload://datei.pdf", "Text C")
        dokument(
            os.path.join(self.dokumente, "unter", "d.json"),
            "link://https://www.vhs-lingen.de/kurse",
            "Text D",
        )
        schreiben(os.path.join(self.dokumente, "kaputt.json"), "{kein json")

    def tearDown(self):
        self._ordner.cleanup()

    def test_nur_gemessene_adressen(self):
        texte = messung_tabellen.dokumente_lesen(
            self.dokumente,
            {"https://www.vhs-lingen.de/#kontakt-info", "https://www.vhs-lingen.de/kurse"},
        )
        self.assertEqual(
            sorted(texte), ["https://www.vhs-lingen.de/#kontakt-info", "https://www.vhs-lingen.de/kurse"]
        )
        self.assertEqual(texte["https://www.vhs-lingen.de/#kontakt-info"][1], "Text A")
        self.assertEqual(texte["https://www.vhs-lingen.de/kurse"][1], "Text D")

    def test_adressliste_findet_ihr_dokument(self):
        # Fall aus Review R8: Liste ohne Schrägstrich vor dem Fragment,
        # chunkSource mit Schrägstrich (validateURL).
        liste = os.path.join(self.ordner, "adressen.txt")
        schreiben(liste, "vhs-lingen https://www.vhs-lingen.de#kontakt-info\n")
        eintraege = messung_tabellen.links_ergaenzen(messung_tabellen.adressen_lesen(liste))
        self.assertEqual(eintraege[0]["link"], "https://www.vhs-lingen.de/#kontakt-info")
        texte = messung_tabellen.dokumente_lesen(self.dokumente, {e["link"] for e in eintraege})
        self.assertEqual(list(texte), ["https://www.vhs-lingen.de/#kontakt-info"])


class LeereEingabenExit1(unittest.TestCase):
    """Ohne Adresse oder ohne passendes Dokument endet die Messung mit Exit 1, vor dem Browser."""

    def setUp(self):
        self._ordner = arbeitsordner()
        self.ordner = self._ordner.name
        self.aus = os.path.join(self.ordner, "ergebnis.json")

    def tearDown(self):
        self._ordner.cleanup()

    def lauf(self, adressen, *weitere):
        liste = os.path.join(self.ordner, "adressen.txt")
        schreiben(liste, adressen)
        return subprocess.run(
            [
                sys.executable,
                os.path.join(textlesen.HIER, "messung_tabellen.py"),
                "--urls", liste, "--aus", self.aus, "--pause", "0", "--nur-lokal", *weitere,
            ],
            capture_output=True, text=True, timeout=120,
        )

    def test_ohne_adresse(self):
        lauf = self.lauf("# nur Kommentar\n")
        self.assertEqual(lauf.returncode, 1, lauf.stdout[-500:] + lauf.stderr[-500:])
        self.assertIn("keine Adresse", lauf.stderr)
        self.assertFalse(os.path.exists(self.aus))

    def test_dokumente_ordner_fehlt(self):
        lauf = self.lauf(
            "https://www.vhs-lingen.de/\n", "--dokumente", os.path.join(self.ordner, "fehlt")
        )
        self.assertEqual(lauf.returncode, 1, lauf.stdout[-500:] + lauf.stderr[-500:])
        self.assertIn("Ordner fehlt", lauf.stderr)
        self.assertFalse(os.path.exists(self.aus))

    def test_kein_dokument_zu_den_adressen(self):
        dokumente = os.path.join(self.ordner, "dokumente")
        dokument(os.path.join(dokumente, "b.json"), "link://https://andere.example.org/seite", "Text B")
        lauf = self.lauf("https://www.vhs-lingen.de/#kontakt-info\n", "--dokumente", dokumente)
        self.assertEqual(lauf.returncode, 1, lauf.stdout[-500:] + lauf.stderr[-500:])
        self.assertIn("kein Dokument", lauf.stderr)
        self.assertFalse(os.path.exists(self.aus))


@unittest.skipUnless(importlib.util.find_spec("playwright"), "Playwright fehlt")
class MessungMitDokument(unittest.TestCase):
    """Ende zu Ende mit Chromium: Adresse mit Fragment, Dokument unter dem Schlüssel des Collectors."""

    def test_uebersicht_mit_fragment_findet_dokument(self):
        uebersicht = "file://" + quote(os.path.join(DELMENHORST, "seite_vortraege.html"))
        with arbeitsordner() as ordner:
            liste = os.path.join(ordner, "adressen.txt")
            schreiben(liste, "vhs-delmenhorst %s#kontakt-info  # Fragment bleibt\n" % uebersicht)
            dokumente = os.path.join(ordner, "dokumente")
            # Inhalt: je Kurs eine Zeile mit Titel und Nummer, wie upload-link ab 8.2.
            zeilen = [
                "Deine Rente. Deine Zukunft. Jetzt Klarheit schaffen! - Für Frauen"
                " Status: Kurs abgeschlossen | Mi. 07.10.2026, 9.30 Uhr"
                " | Am Turbinenhaus 11, 27749 Delmenhorst, | 26B6734"
            ]
            dokument(
                os.path.join(dokumente, "url-vortraege.json"),
                "link://%s#kontakt-info" % uebersicht,
                "\n".join(zeilen),
            )
            aus = os.path.join(ordner, "ergebnis.json")
            lauf = subprocess.run(
                [
                    sys.executable,
                    os.path.join(textlesen.HIER, "messung_tabellen.py"),
                    "--urls", liste, "--aus", aus, "--dokumente", dokumente,
                    "--pause", "0", "--nur-lokal",
                ],
                capture_output=True, text=True, timeout=180,
            )
            self.assertEqual(lauf.returncode, 0, lauf.stderr[-2000:])
            with open(aus, encoding="utf-8") as datei:
                bericht = json.load(datei)
        seite = bericht["seiten"][0]
        self.assertEqual(seite["url"], uebersicht + "#kontakt-info")
        self.assertEqual(seite["link"], uebersicht + "#kontakt-info")
        self.assertIsNotNone(seite["dokument"], "Dokument unter link://<Adresse mit Fragment>")
        self.assertEqual(seite["dokument"]["gleiche_zeile"], 1)
        self.assertEqual(bericht["zusammenfassung"]["ak5_kursnummern"]["seiten_mit_dokument"], 1)


if __name__ == "__main__":
    unittest.main()
