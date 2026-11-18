"""Chromium-Test für tableRowsToText (einlesen-tabellen-platzhalter, Teil T).

Aufruf (System-python3 mit Playwright, Chromium aus dem Cache, kein Netz):

    python3 collector/__tests__/processLink/convert/test_table_rows_chromium.py -v

Jeder Fall lädt eine Seite (gespeicherte Delmenhorst-Seite oder eigener kleiner
Fall), führt die Schritte aus generic.js aus (aufklappen, Störendes entfernen)
und vergleicht ``document.body.innerText`` (heute) mit dem Ergebnis von
``tableRowsToText`` (neu). Alle Anfragen außer file:, data: und about: sind
gesperrt; die gespeicherten Seiten laden also nichts von der Website nach.
"""

import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from urllib.parse import quote

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "support"))

import textlesen  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

DELMENHORST = os.path.join(textlesen.FIXTURES, "delmenhorst")
TRENNER = " | "


def seite(body, head=""):
    return (
        "<!DOCTYPE html><html lang='de'><head><meta charset='utf-8'>%s</head><body>%s</body></html>"
        % (head, body)
    )


class TabellenzeilenChromium(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.funktion = textlesen.tabellen_funktion()
        cls.aufklappen, cls.entfernen = textlesen.selektoren()
        cls.pw = sync_playwright().start()
        cls.browser = textlesen.browser_starten(cls.pw)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def setUp(self):
        # Fenstergröße wie Puppeteer mit defaultViewport null im Container (800 x 600).
        self.context = self.browser.new_context(viewport={"width": 800, "height": 600})
        self.context.route("**/*", lambda route: textlesen.anfragen_sperren(route, nur_lokal=True))
        self.page = self.context.new_page()

    def tearDown(self):
        self.context.close()

    # Hilfen -------------------------------------------------------------

    def html(self, inhalt):
        self.page.set_content(inhalt)
        return textlesen.lesen(self.page, self.funktion, self.aufklappen, self.entfernen)

    def datei(self, pfad):
        self.page.goto("file://" + quote(pfad), wait_until="domcontentloaded")
        return textlesen.lesen(self.page, self.funktion, self.aufklappen, self.entfernen)

    def assertGleicheWoerter(self, alt, neu):
        fehlt, dazu = textlesen.wortabweichung(alt, neu)
        self.assertEqual((fehlt, dazu), ([], []), "Wortbestand vorher und nachher verschieden")

    def zeilen(self, text):
        return [z for z in text.split("\n")]

    # AK-1 · Delmenhorst-Übersicht ---------------------------------------

    def test_ak1_delmenhorst_uebersicht_je_kurs_eine_zeile(self):
        self.page.goto(
            "file://" + quote(os.path.join(DELMENHORST, "seite_vortraege.html")),
            wait_until="domcontentloaded",
        )
        textlesen.vorbereiten(self.page, self.aufklappen, self.entfernen)
        paare = textlesen.kurszeilen(self.page)
        self.assertEqual(len(paare), 25, "25 Kurszeilen auf der gespeicherten Übersicht")
        alt = self.page.evaluate("() => document.body.innerText")
        ergebnis = self.page.evaluate("(" + self.funktion + ")()")
        neu = ergebnis["text"]
        self.assertIsNone(ergebnis["fallback"])
        self.assertEqual(ergebnis["rows"], 26, "25 Kurszeilen und die Kopfzeile")
        # Heute steht keine Nummer in der Zeile ihres Titels, neu jede.
        self.assertEqual(textlesen.gleiche_zeile(alt, paare), 0)
        self.assertEqual(textlesen.gleiche_zeile(neu, paare), 25)
        zeilen = self.zeilen(neu)
        self.assertIn(
            "Deine Rente. Deine Zukunft. Jetzt Klarheit schaffen! - Für Frauen"
            " Status: Kurs abgeschlossen | Mi. 07.10.2026, 9.30 Uhr"
            " | Am Turbinenhaus 11, 27749 Delmenhorst, | 26B6734",
            zeilen,
        )
        self.assertIn("Titel | Beginn | Ort | Nr.", zeilen)
        # Jede Kursnummer genau einmal, nie allein vor dem nächsten Titel.
        for paar in paare:
            mit_nummer = [z for z in zeilen if textlesen.enthaelt_nummer(z, paar["nummer"])]
            self.assertEqual(len(mit_nummer), 1, paar["nummer"])
            self.assertTrue(mit_nummer[0].endswith(TRENNER + paar["nummer"]), mit_nummer[0])
        self.assertGleicheWoerter(alt, neu)

    def test_ak1_delmenhorst_kursseiten(self):
        alt, ergebnis = self.datei(os.path.join(DELMENHORST, "seite_26B6734.html"))
        zeilen = self.zeilen(ergebnis["text"])
        self.assertIsNone(ergebnis["fallback"])
        self.assertIn("Kursnummer | 26B6734", zeilen)
        self.assertIn("Beginn | Mi., 07.10.2026, um 09:30 Uhr", zeilen)
        self.assertIn("Preis | 10,00 €", zeilen)
        self.assertIn("1 | Mittwoch • 07.10.2026 • 09:30 - 12:00 Uhr | vhs / Raum 11", zeilen)
        self.assertGleicheWoerter(alt, ergebnis["text"])

    def test_ak4_alle_delmenhorst_seiten_gleiche_woerter(self):
        dateien = sorted(f for f in os.listdir(DELMENHORST) if f.endswith(".html"))
        self.assertEqual(len(dateien), 5)
        for name in dateien:
            with self.subTest(name):
                alt, ergebnis = self.datei(os.path.join(DELMENHORST, name))
                self.assertIsNone(ergebnis["fallback"])
                self.assertGreater(ergebnis["rows"], 0)
                self.assertNotEqual(alt, ergebnis["text"])
                self.assertGleicheWoerter(alt, ergebnis["text"])
                self.assertNotIn("\t", ergebnis["text"], "keine Tabs mehr aus Tabellen")

    # AK-2 · Zeilenumbrüche und leere Zellen ------------------------------

    def test_ak2_umbrueche_werden_leerzeichen_leere_zellen_ohne_doppelten_trenner(self):
        alt, ergebnis = self.html(
            seite(
                "<table>"
                "<tr><td>Zeile 1<br>Zeile 2\n      Zeile 3</td><td><p>Absatz A</p><p>Absatz B</p></td></tr>"
                "<tr><td></td><td>Mitte</td><td>   </td><td>&nbsp;</td><td><br></td><td>Ende</td></tr>"
                "<tr><td>   </td><td></td></tr>"
                "<tr><td>Nur eine</td><td></td></tr>"
                "</table>"
            )
        )
        zeilen = self.zeilen(ergebnis["text"])
        self.assertIn("Zeile 1 Zeile 2 Zeile 3 | Absatz A Absatz B", zeilen)
        self.assertIn("Mitte | Ende", zeilen)
        self.assertIn("Nur eine", zeilen)
        self.assertNotIn("|  |", ergebnis["text"])
        self.assertNotIn("| |", ergebnis["text"])
        for zeile in zeilen:
            self.assertFalse(zeile.startswith("|") or zeile.endswith("|"), repr(zeile))
            self.assertFalse(zeile.startswith(TRENNER) or zeile.endswith(TRENNER.rstrip()), repr(zeile))
        self.assertGleicheWoerter(alt, ergebnis["text"])

    def test_ak2_kopfzeile_mit_th(self):
        alt, ergebnis = self.html(
            seite(
                "<table><caption>Termine</caption>"
                "<thead><tr><th>Kurs</th><th>Beginn</th><th>Ort</th></tr></thead>"
                "<tbody><tr><th scope='row'>Yoga</th><td>Mo. 05.01.2026,<br>18.00 Uhr</td><td>Raum 2</td></tr></tbody>"
                "<tfoot><tr><td colspan='3'>Stand: Januar</td></tr></tfoot>"
                "</table>"
            )
        )
        self.assertEqual(
            ergebnis["text"],
            "Termine\nKurs | Beginn | Ort\nYoga | Mo. 05.01.2026, 18.00 Uhr | Raum 2\nStand: Januar",
        )
        self.assertEqual(ergebnis["rows"], 2)
        self.assertGleicheWoerter(alt, ergebnis["text"])

    # AK-3 · Seiten ohne Tabelle byte-gleich ------------------------------

    def test_ak3_seiten_ohne_tabelle_byte_gleich(self):
        faelle = {
            "artikel": seite(
                "<main><h1>Kurse im Herbst</h1><p>Text mit&nbsp;Leerzeichen\n und  Umbruch.<br>Neue Zeile</p>"
                "<ul><li>Punkt 1</li><li>Punkt 2</li></ul><a href='#'>Mehr</a> | <a href='#'>Kontakt</a>"
                "<pre>  vor\tformatiert  </pre><div style='display:none'>versteckt</div></main>"
            ),
            "div-raster": seite(
                "<div style='display:table'><div style='display:table-row'>"
                "<div style='display:table-cell'>Titel</div><div style='display:table-cell'>26B0001</div>"
                "</div></div>"
            ),
            "nur-einspaltig": seite(
                "<table><tr><td>Einzelne Zelle</td></tr><tr><th>Kopf</th></tr>"
                "<tr><td colspan='2'>Breite Zelle<br>zweite Zeile</td></tr></table>"
            ),
            "leer": seite(""),
        }
        for name, inhalt in faelle.items():
            with self.subTest(name):
                alt, ergebnis = self.html(inhalt)
                self.assertEqual(ergebnis["rows"], 0)
                self.assertIsNone(ergebnis["fallback"])
                self.assertEqual(ergebnis["text"], alt)

    def test_ak3_bestand_kb13_browser_fehlerseite_bleibt_byte_gleich(self):
        # Die Fehlerseite von Chromium (KB-13 erkennt sie am Netzfehlercode) hat keine
        # Tabelle; ihr Text muss byte-gleich bleiben. Playwright zeigt sie nur über CDP.
        frei = socket.socket()
        frei.bind(("127.0.0.1", 0))
        port = frei.getsockname()[1]
        frei.close()
        # Eigener Kontext ohne Sperrliste: die Anfrage soll wirklich abgelehnt werden.
        self.context.close()
        self.context = self.browser.new_context(viewport={"width": 800, "height": 600})
        self.page = self.context.new_page()
        cdp = self.context.new_cdp_session(self.page)
        cdp.send("Page.enable")
        cdp.send("Page.navigate", {"url": "http://127.0.0.1:%d/" % port})

        def auswerten(ausdruck):
            return cdp.send(
                "Runtime.evaluate", {"expression": ausdruck, "returnByValue": True}
            )["result"].get("value")

        alt = ""
        for _ in range(50):
            time.sleep(0.1)
            alt = auswerten("document.body ? document.body.innerText : ''") or ""
            if "ERR_CONNECTION_REFUSED" in alt:
                break
        self.assertIn("ERR_CONNECTION_REFUSED", alt)
        ergebnis = auswerten("(" + self.funktion + ")()")
        self.assertEqual(ergebnis["rows"], 0)
        self.assertEqual(ergebnis["text"], alt)

    # NAK-1 · Verschachtelte Tabellen, Layout-Tabellen, Fehler ------------

    def test_nak1_verschachtelte_tabelle(self):
        alt, ergebnis = self.html(
            seite(
                "<table><tr><td>Menü links</td><td>"
                "<h2>Kurse</h2><table><tr><th>Kurs</th><th>Nr.</th></tr>"
                "<tr><td>Kurs A<br>Status: offen</td><td>26X0001</td></tr>"
                "<tr><td>Kurs B</td><td>26X0002</td></tr></table>"
                "</td></tr></table>"
            )
        )
        zeilen = self.zeilen(ergebnis["text"])
        self.assertIsNone(ergebnis["fallback"])
        self.assertEqual(ergebnis["rows"], 3, "nur die inneren Zeilen")
        self.assertIn("Kurs | Nr.", zeilen)
        self.assertIn("Kurs A Status: offen | 26X0001", zeilen)
        self.assertIn("Kurs B | 26X0002", zeilen)
        self.assertIn("Menü links", ergebnis["text"])
        self.assertGleicheWoerter(alt, ergebnis["text"])

    def test_nak1_layout_tabelle_verliert_keinen_text(self):
        alt, ergebnis = self.html(
            seite(
                "<table role='presentation' width='100%'><tr>"
                "<td width='200'><ul><li><a href='#'>Start</a></li><li><a href='#'>Programm</a></li></ul></td>"
                "<td><h1>Willkommen</h1><p>Erster Absatz mit Text.</p><p>Zweiter Absatz.</p>"
                "<ol><li>Eins</li><li>Zwei</li></ol></td>"
                "</tr></table>"
            )
        )
        self.assertIsNone(ergebnis["fallback"])
        self.assertEqual(ergebnis["rows"], 1)
        self.assertEqual(
            ergebnis["text"],
            "Start Programm | Willkommen Erster Absatz mit Text. Zweiter Absatz. Eins Zwei",
        )
        self.assertGleicheWoerter(alt, ergebnis["text"])

    def test_nak1_unsichtbare_zellen_und_zeilen_bleiben_unsichtbar(self):
        alt, ergebnis = self.html(
            seite(
                "<table>"
                "<tr><td>Sichtbar A</td><td style='display:none'>Versteckt 1</td><td>Sichtbar B</td></tr>"
                "<tr style='display:none'><td>Versteckt 2</td><td>Versteckt 3</td></tr>"
                "<tr><td>Allein</td><td style='display:none'>Versteckt 4</td></tr>"
                "<tr><td style='visibility:hidden'>Versteckt 5</td><td>Rest</td></tr>"
                "</table>"
                "<div style='display:none'><table><tr><td>Versteckt 6</td><td>Versteckt 7</td></tr></table></div>"
            )
        )
        self.assertIsNone(ergebnis["fallback"])
        self.assertNotIn("Versteckt", ergebnis["text"])
        self.assertIn("Sichtbar A | Sichtbar B", self.zeilen(ergebnis["text"]))
        self.assertIn("Rest", self.zeilen(ergebnis["text"]))
        self.assertGleicheWoerter(alt, ergebnis["text"])

    def test_nak1_fehler_beim_umwandeln_ergibt_heutigen_text(self):
        inhalt = seite("<table><tr><td>A</td><td>B</td></tr><tr><td>C</td><td>D</td></tr></table>")
        self.page.set_content(inhalt)
        textlesen.vorbereiten(self.page, self.aufklappen, self.entfernen)
        alt = self.page.evaluate("() => document.body.innerText")
        self.page.evaluate(
            "() => { document.createElement = () => { throw new Error('kaputt'); }; }"
        )
        ergebnis = self.page.evaluate("(" + self.funktion + ")()")
        self.assertEqual(ergebnis["fallback"], "fehler")
        self.assertEqual(ergebnis["rows"], 0)
        self.assertEqual(ergebnis["text"], alt)
        self.assertIn("kaputt", ergebnis.get("error", ""))

    def test_nak1_abweichender_wortbestand_ergibt_heutigen_text(self):
        inhalt = seite("<table><tr><td>A</td><td>B</td></tr></table>")
        self.page.set_content(inhalt)
        alt = self.page.evaluate("() => document.body.innerText")
        # Zellen lesen sich anders als im Seitentext: der Abgleich muss das merken.
        self.page.evaluate(
            "() => Object.defineProperty(HTMLTableCellElement.prototype, 'innerText',"
            " { get() { return 'Fremd ' + this.textContent; } })"
        )
        ergebnis = self.page.evaluate("(" + self.funktion + ")()")
        self.assertEqual(ergebnis["fallback"], "woerter")
        self.assertEqual(ergebnis["text"], alt)

    # §7 · Bestand: Störendes entfernen, Nachladen ------------------------

    def test_bestand_kopf_fuss_navigation_hinweise_bleiben_entfernt(self):
        alt, ergebnis = self.html(
            seite(
                "<header><table><tr><td>Kopf A</td><td>Kopf B</td></tr></table></header>"
                "<nav>Navi</nav><aside>Seitenleiste</aside>"
                "<div class='cookie-hint'>Cookie</div><div id='consent-box'>Einwilligung</div>"
                "<div class='top-banner'>Werbung</div><div class='kw-highlight-box'>Zufallskurs</div>"
                "<main><table><tr><td>Kurs</td><td>26B0001</td></tr></table></main>"
                "<footer><table><tr><td>Fuß A</td><td>Fuß B</td></tr></table></footer>"
            )
        )
        self.assertEqual(ergebnis["text"], "Kurs | 26B0001")
        for wort in ("Kopf", "Navi", "Seitenleiste", "Cookie", "Einwilligung", "Werbung", "Zufallskurs", "Fuß"):
            self.assertNotIn(wort, alt)
            self.assertNotIn(wort, ergebnis["text"])

    def test_bestand_nachladen_aufgeklappte_tabellen_werden_umgewandelt(self):
        # Ein Klick auf <details> selbst öffnet es nicht (Bestand): sein Inhalt fehlt
        # heute wie neu. Nachgeladener Inhalt nach dem Klick auf den Knopf kommt dazu.
        alt, ergebnis = self.html(
            seite(
                "<details><summary>Termine</summary>"
                "<table><tr><td>Mo.</td><td>18 Uhr</td></tr></table></details>"
                "<button aria-expanded='false' onclick=\"setTimeout(() => {"
                " document.getElementById('mehr').innerHTML ="
                " '<table><tr><td>Kursort</td><td>Raum 3</td></tr></table>'; }, 200)\">Mehr</button>"
                "<div id='mehr'></div>"
            )
        )
        self.assertIsNone(ergebnis["fallback"])
        self.assertEqual(ergebnis["rows"], 1)
        self.assertEqual(ergebnis["text"], "Termine\nMehr\nKursort | Raum 3")
        self.assertNotIn("Mo.", alt)
        self.assertIn("Kursort\tRaum 3", alt, "nachgeladener Inhalt kommt vor dem Auslesen")
        self.assertGleicheWoerter(alt, ergebnis["text"])

    def test_bestand_offene_details_werden_umgewandelt(self):
        alt, ergebnis = self.html(
            seite(
                "<details open><summary>Termine</summary>"
                "<table><tr><td>Mo.</td><td>18 Uhr</td></tr></table></details>"
            )
        )
        self.assertEqual(ergebnis["text"], "Termine\nMo. | 18 Uhr")
        self.assertGleicheWoerter(alt, ergebnis["text"])

    # Laufzeit ------------------------------------------------------------

    def test_grosse_tabelle_in_kurzer_zeit(self):
        zeilen = "".join(
            "<tr><td>Kurs %d<br>Status: offen</td><td>Mo. 05.01.2026,<br>18.00 Uhr</td>"
            "<td>Raum %d</td><td>26B%04d</td></tr>" % (i, i % 9, i)
            for i in range(2000)
        )
        self.page.set_content(seite("<table>%s</table>" % zeilen))
        alt = self.page.evaluate("() => document.body.innerText")
        start = time.monotonic()
        ergebnis = self.page.evaluate("(" + self.funktion + ")()")
        dauer = time.monotonic() - start
        self.assertEqual(ergebnis["rows"], 2000)
        self.assertLess(dauer, 5.0, "2000 Zeilen in %.2f s" % dauer)
        self.assertIn("Kurs 7 Status: offen | Mo. 05.01.2026, 18.00 Uhr | Raum 7 | 26B0007", ergebnis["text"].split("\n"))
        self.assertGleicheWoerter(alt, ergebnis["text"])



class MessungSelbstprobe(unittest.TestCase):
    """Messskript support/messung_tabellen.py gegen gespeicherte Seiten (nur lokal)."""

    def test_messung_nur_lokal(self):
        with tempfile.TemporaryDirectory(prefix="messung-") as ordner:
            ohne = os.path.join(ordner, "ohne_tabelle.html")
            with open(ohne, "w", encoding="utf-8") as datei:
                datei.write(seite("<main><h1>Ohne Tabelle</h1><p>Text\n mit  Leerraum.</p></main>"))
            uebersicht = os.path.join(DELMENHORST, "seite_vortraege.html")
            adressen = os.path.join(ordner, "adressen.txt")
            with open(adressen, "w", encoding="utf-8") as datei:
                datei.write("# Selbstprobe\n")
                datei.write("vhs-delmenhorst file://%s\n" % quote(uebersicht))
                datei.write("file://%s\n" % quote(ohne))
            aus = os.path.join(ordner, "ergebnis.json")
            lauf = subprocess.run(
                [
                    sys.executable,
                    os.path.join(textlesen.HIER, "messung_tabellen.py"),
                    "--urls", adressen, "--aus", aus, "--texte", os.path.join(ordner, "texte"),
                    "--pause", "0", "--nur-lokal",
                ],
                capture_output=True, text=True, timeout=180,
            )
            self.assertEqual(lauf.returncode, 0, lauf.stderr[-2000:])
            with open(aus, encoding="utf-8") as datei:
                bericht = json.load(datei)
        zusammen = bericht["zusammenfassung"]
        self.assertEqual(zusammen["gelesen"], 2)
        self.assertEqual(zusammen["ak3_ohne_tabelle"], {"seiten": 1, "byte_gleich": 1, "abweichend": []})
        self.assertEqual(zusammen["ak4_mit_tabelle"]["woerter_gleich"], 1)
        self.assertEqual(zusammen["ak5_kursnummern"]["kurszeilen"], 25)
        self.assertEqual(zusammen["ak5_kursnummern"]["gleiche_zeile_alt"], 0)
        self.assertEqual(zusammen["ak5_kursnummern"]["gleiche_zeile_neu"], 25)
        self.assertEqual(zusammen["rueckfall"], [])
        self.assertEqual(bericht["seiten"][0]["kunde"], "vhs-delmenhorst")


if __name__ == "__main__":
    unittest.main()
