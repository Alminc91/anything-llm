"""Textlesen wie im Collector, für den Chromium-Test und die Messung.

einlesen-tabellen-platzhalter, Teil T. Spiegelt den Ablauf in
``collector/processLink/convert/generic.js`` (``evaluate``): Textlänge messen,
aufklappbare Elemente öffnen, bis 1 s auf neuen Text warten, Kopf, Fuß,
Navigation und Hinweise entfernen, dann den Text lesen.

- Die beiden Selektoren kommen aus generic.js selbst; ändert sich dort die
  Schreibweise so, dass sie nicht mehr zu finden sind, bricht der Test ab.
- Die Umwandlung kommt aus ``tableRows.js``: ``node`` liefert den Quelltext
  der Funktion, so wie Puppeteer ihn mit ``page.evaluate`` an den Browser gibt.
- Die Adresse, die der Collector lädt und als ``chunkSource`` speichert,
  kommt aus ``validateURL`` in ``utils/url`` (über ``node``).

Nur Standardbibliothek und Playwright (System-``python3``).
"""

import json
import os
import re
import subprocess
from collections import Counter

HIER = os.path.dirname(os.path.abspath(__file__))
COLLECTOR = os.path.abspath(os.path.join(HIER, "..", "..", "..", ".."))
GENERIC_JS = os.path.join(COLLECTOR, "processLink", "convert", "generic.js")
TABLE_ROWS_JS = os.path.join(COLLECTOR, "processLink", "convert", "tableRows.js")
URL_JS = os.path.join(COLLECTOR, "utils", "url", "index.js")
FIXTURES = os.path.join(HIER, "fixtures")

# utils/url lädt RuntimeSettings und darüber dotenv; validateURL braucht davon
# nichts. Wie in collector/__tests__/utils/url/index.test.js ersetzt eine leere
# Fassung das Modul, damit node ohne die Pakete des Collectors auskommt. Jedes
# andere require bricht laut ab, statt still eine andere Regel zu messen.
_VALIDATE_URL_JS = r"""
const fs = require("fs");
const vm = require("vm");
const datei = process.argv[1];
const ersatz = { "../runtimeSettings": class { get() { return undefined; } set() {} } };
const laden = (name) => {
  if (Object.prototype.hasOwnProperty.call(ersatz, name)) return ersatz[name];
  throw new Error("unerwartetes require in " + datei + ": " + name);
};
const modul = { exports: {} };
vm.runInThisContext(
  "(function (require, module, exports) {" + fs.readFileSync(datei, "utf8") + "\n})",
  { filename: datei }
)(laden, modul, modul.exports);
const adressen = JSON.parse(fs.readFileSync(0, "utf8"));
process.stdout.write(JSON.stringify(adressen.map((a) => modul.exports.validateURL(a))));
"""

# Leerraum wie /\s/ in JavaScript: so trennt auch tableRowsToText die Wörter.
_JS_LEERRAUM = re.compile(
    r"[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+"
)
_NUR_TRENNER = re.compile(r"\|+")

# Kursnummern der Kufer-Webseiten, etwa 26B6734 oder 26B7154E.
KURSNUMMER = re.compile(r"^\d{2}[A-Z]\d{3,5}[A-Z]?$")


def browser_starten(pw, **optionen):
    """Volles Chromium wie Puppeteer mit headless "new" (zeigt auch die Fehlerseite).

    Chromium legt den Socket seiner Einzelinstanz-Sperre unter TMPDIR an, ein
    Unix-Socket-Pfad hat höchstens 107 Zeichen. Ist TMPDIR dafür zu lang (etwa
    ``.test-storage/tmp`` im Worktree), bekommt nur der Browserprozess
    ``/dev/shm``; Playwright legt das Profil weiter unter TMPDIR an.
    """
    umgebung = dict(os.environ)
    if len(umgebung.get("TMPDIR", "")) > 60 and os.path.isdir("/dev/shm"):
        umgebung["TMPDIR"] = "/dev/shm"
    return pw.chromium.launch(channel="chromium", env=umgebung, **optionen)


def tabellen_funktion():
    """Quelltext von ``tableRowsToText`` aus tableRows.js (über node)."""
    lauf = subprocess.run(
        [
            "node",
            "-e",
            "process.stdout.write(require(process.argv[1]).tableRowsToText.toString())",
            TABLE_ROWS_JS,
        ],
        capture_output=True,
        text=True,
        timeout=60,
    )
    if lauf.returncode != 0 or not lauf.stdout.strip():
        raise RuntimeError(
            "tableRowsToText nicht ladbar aus %s: %s" % (TABLE_ROWS_JS, lauf.stderr.strip())
        )
    return lauf.stdout


def adressen_wie_collector(adressen):
    """Adressen so, wie ``processLink`` sie mit ``validateURL`` prüft, lädt und speichert.

    ``chunkSource`` eines Dokuments aus upload-link ist ``link://`` plus dieser
    Adresse, etwa ``https://www.vhs-lingen.de/#kontakt-info`` (Schrägstrich vor
    dem Fragment) oder ``https://www.vhs-lingen.de`` (ohne Schrägstrich am Ende).
    """
    adressen = list(adressen)
    if not adressen:
        return []
    lauf = subprocess.run(
        ["node", "-e", _VALIDATE_URL_JS, URL_JS],
        input=json.dumps(adressen),
        capture_output=True,
        text=True,
        timeout=60,
    )
    if lauf.returncode != 0:
        raise RuntimeError("validateURL nicht ladbar aus %s: %s" % (URL_JS, lauf.stderr.strip()))
    ergebnis = json.loads(lauf.stdout)
    if not isinstance(ergebnis, list) or len(ergebnis) != len(adressen):
        raise RuntimeError("validateURL lieferte %r für %d Adressen" % (ergebnis, len(adressen)))
    return ergebnis


def selektoren():
    """(aufklappen, entfernen): die Selektoren aus generic.js, wörtlich zusammengesetzt."""
    with open(GENERIC_JS, encoding="utf-8") as datei:
        quelle = datei.read()
    gefunden = []
    for treffer in re.finditer(
        r"document\.querySelectorAll\(\s*((?:'[^']*'\s*\+?\s*)+)\)", quelle
    ):
        gefunden.append("".join(re.findall(r"'([^']*)'", treffer.group(1))))
    aufklappen = [s for s in gefunden if 'aria-expanded="false"' in s]
    entfernen = [s for s in gefunden if s.startswith("header, footer, nav")]
    if len(aufklappen) != 1 or len(entfernen) != 1:
        raise RuntimeError(
            "Selektoren in generic.js nicht eindeutig gefunden: %r" % (gefunden,)
        )
    return aufklappen[0], entfernen[0]


def woerter(text):
    """Wortbestand als Zähler: Wörter zwischen Leerraum, reine „|“ zählen nicht."""
    return Counter(
        wort for wort in _JS_LEERRAUM.split(text) if wort and not _NUR_TRENNER.fullmatch(wort)
    )


def wortabweichung(alt, neu, grenze=20):
    """(fehlt, dazu): Wörter, die neu fehlen oder neu dazukommen, je höchstens ``grenze``."""
    a, n = woerter(alt), woerter(neu)
    fehlt = sorted((a - n).elements())[:grenze]
    dazu = sorted((n - a).elements())[:grenze]
    return fehlt, dazu


def vorbereiten(page, aufklappen, entfernen):
    """Schritte aus generic.js vor dem Auslesen: aufklappen, warten, Störendes entfernen."""
    from playwright.sync_api import TimeoutError as PlaywrightTimeout

    vorher = page.evaluate("() => document.body.innerText.length")
    geklickt = page.evaluate(
        "(sel) => { const els = document.querySelectorAll(sel);"
        " els.forEach(el => el.click()); return els.length; }",
        aufklappen,
    )
    if geklickt > 0:
        try:
            page.wait_for_function(
                "(b) => document.body.innerText.length > b", arg=vorher, timeout=1000
            )
        except PlaywrightTimeout:
            pass
    page.evaluate(
        "(sel) => { document.querySelectorAll(sel).forEach(el => el.remove()); }",
        entfernen,
    )
    return geklickt


def kurszeilen(page):
    """Kursnummer und Titel je Zeile ``tr.kw-table-row`` (Kufer-Kursübersicht), vor dem Umwandeln.

    Titel = Text des ersten Links der Zeile, Nummer = letzte nicht leere Zelle,
    wenn sie wie eine Kursnummer aussieht. Leerraum wird zu einem Leerzeichen.
    """
    paare = page.evaluate(
        """() => Array.from(document.querySelectorAll('tr.kw-table-row')).map(row => {
             const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
             const link = row.querySelector('a');
             const zellen = Array.from(row.cells).map(c => norm(c.innerText)).filter(Boolean);
             return { titel: link ? norm(link.innerText) : '', nummer: zellen.length ? zellen[zellen.length - 1] : '' };
           })"""
    )
    return [p for p in paare if p["titel"] and KURSNUMMER.match(p["nummer"])]


def enthaelt_nummer(zeile, nummer):
    """Steht ``nummer`` als ganzes Wort in ``zeile`` (26B8903 nicht in 26B8903A)?"""
    return re.search(r"(?<!\w)" + re.escape(nummer) + r"(?!\w)", zeile) is not None


def gleiche_zeile(text, paare):
    """Anzahl der Paare, deren Nummer und Titel in derselben Textzeile stehen."""
    zeilen = text.split("\n")
    treffer = 0
    for paar in paare:
        if any(
            enthaelt_nummer(zeile, paar["nummer"]) and paar["titel"] in _norm(zeile)
            for zeile in zeilen
        ):
            treffer += 1
    return treffer


def _norm(text):
    return _JS_LEERRAUM.sub(" ", text).strip()


def lesen(page, funktion, aufklappen, entfernen):
    """(alt, ergebnis): ``alt`` = innerText wie heute, ``ergebnis`` = Rückgabe von tableRowsToText.

    Beide aus demselben Stand der Seite nach den Vorbereitungsschritten.
    """
    vorbereiten(page, aufklappen, entfernen)
    alt = page.evaluate("() => document.body.innerText")
    ergebnis = page.evaluate("(" + funktion + ")()")
    return alt, ergebnis


def anfragen_sperren(route, nur_lokal):
    """Wie generic.js: Bilder, Stylesheets, Schriften, Medien und das Chatbot-Skript sperren.

    ``nur_lokal``: zusätzlich alles außer file:, data: und about: sperren (Tests, Selbstprobe).
    """
    anfrage = route.request
    adresse = anfrage.url
    if nur_lokal and not adresse.startswith(("file:", "data:", "about:")):
        return route.abort()
    if anfrage.resource_type in ("image", "stylesheet", "font", "media"):
        return route.abort()
    if anfrage.resource_type == "script" and re.search(r"\.ki\.kufer(-test)?\.de/", adresse):
        return route.abort()
    return route.continue_()
