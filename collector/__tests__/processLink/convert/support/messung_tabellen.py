"""Messung Tabellenzeilen alt gegen neu (einlesen-tabellen-platzhalter, AK-3, AK-4, AK-5).

Liest jede Adresse einer Liste einmal mit Chromium so wie der Collector
(gesperrt: Bilder, Stylesheets, Schriften, Medien, Chatbot-Skript; Laden bis
domcontentloaded, höchstens 2 s auf readyState complete; aufklappen, Kopf,
Fuß, Navigation und Hinweise entfernen) und erzeugt aus demselben Stand der
Seite beide Texte:

- alt: ``document.body.innerText`` (heutiger Collector)
- neu: ``tableRowsToText`` aus ``collector/processLink/convert/tableRows.js``

Verglichen werden Bytes und Wortbestand (Wörter zwischen Leerraum, reine „|“
zählen nicht). Für Zeilen ``tr.kw-table-row`` (Kufer-Kursübersicht) zählt die
Messung, wie viele Kursnummern in derselben Zeile wie ihr Titel stehen, alt,
neu und optional in den über ``upload-link`` gespeicherten Dokumenten.

Nur lesend: ein GET je Adresse, nacheinander, mit Pause. Kein Schreiben außer
der Ergebnisdatei und optional der Texte.

Aufruf (System-python3 mit Playwright):

    python3 messung_tabellen.py --urls adressen.txt --aus ergebnis.json \\
        [--texte ordner] [--dokumente ordner] [--pause 2] [--nur-lokal]

``adressen.txt``: je Zeile ``<url>`` oder ``<kunde> <url>``; ``#`` am
Zeilenanfang oder nach Leerraum leitet einen Kommentar ein, ein ``#`` in der
Adresse (Fragment wie ``#kontakt-info``) gehört zur Adresse. Jede Adresse geht
wie in ``processLink`` durch ``validateURL`` des Collectors: Diese Adresse wird
geladen und mit ``chunkSource`` verglichen (Feld ``link`` im Ergebnis).
``--dokumente``: Ordner mit Dokument-JSONs des Collectors (Felder
``chunkSource`` = ``link://<link>`` und ``pageContent``), etwa aus
``storage/documents/custom-documents`` der Testinstanz kopiert; gelesen werden
nur die Dokumente der gemessenen Adressen.
``--nur-lokal`` sperrt alles außer file:, data: und about: (Selbstprobe mit
gespeicherten Seiten).

Exit 1 ohne Messung, wenn die Liste keine Adresse enthält, der Ordner von
``--dokumente`` fehlt oder darin zu keiner Adresse ein Dokument liegt.
"""

import argparse
import hashlib
import json
import os
import re
import sys
import time
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import textlesen  # noqa: E402

# Kommentar: „#“ am Zeilenanfang oder nach Leerraum. In einer Adresse steht
# „#“ ohne Leerraum davor (Fragment) und gehört zur Adresse.
_KOMMENTAR = re.compile(r"(?:^|\s)#")


def adressen_lesen(pfad):
    """Einträge ``{kunde, url}`` aus der Adressliste, ``url`` wie in der Liste."""
    eintraege = []
    with open(pfad, encoding="utf-8") as datei:
        for zeile in datei:
            zeile = _KOMMENTAR.split(zeile, maxsplit=1)[0].strip()
            if not zeile:
                continue
            teile = zeile.split()
            kunde = teile[0] if len(teile) > 1 else ""
            eintraege.append({"kunde": kunde, "url": teile[-1]})
    return eintraege


def links_ergaenzen(eintraege):
    """Ergänzt je Eintrag ``link``: die Adresse nach ``validateURL`` wie in processLink."""
    for eintrag, link in zip(
        eintraege, textlesen.adressen_wie_collector(e["url"] for e in eintraege)
    ):
        eintrag["link"] = link
    return eintraege


def dokumente_lesen(ordner, links):
    """link -> (datei, pageContent) aus Dokument-JSONs des Collectors, nur für ``links``."""
    links = set(links)
    texte = {}
    for wurzel, _, dateien in os.walk(ordner):
        for name in sorted(dateien):
            if not name.endswith(".json"):
                continue
            pfad = os.path.join(wurzel, name)
            try:
                with open(pfad, encoding="utf-8") as datei:
                    daten = json.load(datei)
            except (OSError, ValueError):
                continue
            if not isinstance(daten, dict):
                continue
            quelle = str(daten.get("chunkSource") or "")
            link = quelle[len("link://"):]
            if (
                quelle.startswith("link://")
                and link in links
                and isinstance(daten.get("pageContent"), str)
            ):
                texte[link] = (pfad, daten["pageContent"])
    return texte


def kennzahlen_vorher(page):
    return page.evaluate(
        """() => ({
             tabellen: document.querySelectorAll('table').length,
             tr: document.querySelectorAll('tr').length,
             tr_mehrzellig: Array.from(document.querySelectorAll('tr')).filter(r => r.cells.length >= 2).length,
           })"""
    )


def sha(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def laengste(text):
    return max((len(z) for z in text.split("\n")), default=0)


def messen(context, eintrag, funktion, aufklappen, entfernen, dokumente, texte_ordner, nummer):
    from playwright.sync_api import TimeoutError as PlaywrightTimeout

    ergebnis = {
        "kunde": eintrag["kunde"],
        "url": eintrag["url"],
        "link": eintrag["link"],
        "fehler": None,
    }
    page = context.new_page()
    try:
        try:
            # Wie processLink: geladen wird die Adresse nach validateURL.
            page.goto(eintrag["link"], timeout=30000, wait_until="domcontentloaded")
        except Exception as fehler:  # Collector: goto(...).catch(() => {})
            ergebnis["ladefehler"] = str(fehler).splitlines()[0][:200]
        try:
            page.wait_for_function("() => document.readyState === 'complete'", timeout=2000)
        except PlaywrightTimeout:
            pass
        textlesen.vorbereiten(page, aufklappen, entfernen)
        ergebnis.update(kennzahlen_vorher(page))
        paare = textlesen.kurszeilen(page)
        alt = page.evaluate("() => document.body.innerText")
        neu_roh = page.evaluate("(" + funktion + ")()")
        neu = neu_roh["text"]
        fehlt, dazu = textlesen.wortabweichung(alt, neu)
        ergebnis.update(
            {
                "tabellenzeilen": neu_roh["rows"],
                "rueckfall": neu_roh["fallback"],
                "rueckfall_grund": neu_roh.get("error"),
                "byte_gleich": alt == neu,
                "woerter_gleich": not fehlt and not dazu,
                "fehlt": fehlt,
                "dazu": dazu,
                "woerter": sum(textlesen.woerter(alt).values()),
                "zeichen_alt": len(alt),
                "zeichen_neu": len(neu),
                "zeilen_alt": alt.count("\n") + 1,
                "zeilen_neu": neu.count("\n") + 1,
                "laengste_zeile_alt": laengste(alt),
                "laengste_zeile_neu": laengste(neu),
                "sha256_alt": sha(alt),
                "sha256_neu": sha(neu),
                "kurszeilen": len(paare),
                "gleiche_zeile_alt": textlesen.gleiche_zeile(alt, paare),
                "gleiche_zeile_neu": textlesen.gleiche_zeile(neu, paare),
                "dokument": None,
            }
        )
        if eintrag["link"] in dokumente:
            pfad, inhalt = dokumente[eintrag["link"]]
            ergebnis["dokument"] = {
                "datei": pfad,
                "gleiche_zeile": textlesen.gleiche_zeile(inhalt, paare),
                "gleich_neu": inhalt == neu,
                "woerter_gleich_neu": textlesen.woerter(inhalt) == textlesen.woerter(neu),
            }
        if texte_ordner:
            basis = os.path.join(texte_ordner, "%03d" % nummer)
            with open(basis + ".alt.txt", "w", encoding="utf-8") as datei:
                datei.write(alt)
            with open(basis + ".neu.txt", "w", encoding="utf-8") as datei:
                datei.write(neu)
            ergebnis["texte"] = basis + ".{alt,neu}.txt"
    except Exception as fehler:
        ergebnis["fehler"] = "%s: %s" % (type(fehler).__name__, str(fehler).splitlines()[0][:200])
    finally:
        page.close()
    return ergebnis


def zusammenfassen(ergebnisse):
    gelesen = [e for e in ergebnisse if not e["fehler"]]
    ohne = [e for e in gelesen if e["tabellen"] == 0]
    mit = [e for e in gelesen if e["tabellen"] > 0]
    kurs = [e for e in gelesen if e["kurszeilen"] > 0]
    mit_dok = [e for e in kurs if e["dokument"]]
    return {
        "adressen": len(ergebnisse),
        "gelesen": len(gelesen),
        "fehler": [e["url"] for e in ergebnisse if e["fehler"]],
        "ak3_ohne_tabelle": {
            "seiten": len(ohne),
            "byte_gleich": sum(e["byte_gleich"] for e in ohne),
            "abweichend": [e["url"] for e in ohne if not e["byte_gleich"]],
        },
        "ak4_mit_tabelle": {
            "seiten": len(mit),
            "umgewandelt": sum(1 for e in mit if e["tabellenzeilen"] > 0),
            "woerter_gleich": sum(e["woerter_gleich"] for e in mit),
            "abweichend": [e["url"] for e in mit if not e["woerter_gleich"]],
        },
        "ak5_kursnummern": {
            "seiten": len(kurs),
            "kurszeilen": sum(e["kurszeilen"] for e in kurs),
            "gleiche_zeile_alt": sum(e["gleiche_zeile_alt"] for e in kurs),
            "gleiche_zeile_neu": sum(e["gleiche_zeile_neu"] for e in kurs),
            "seiten_mit_dokument": len(mit_dok),
            "kurszeilen_mit_dokument": sum(e["kurszeilen"] for e in mit_dok),
            "gleiche_zeile_dokument": sum(e["dokument"]["gleiche_zeile"] for e in mit_dok),
            "seiten_ohne_dokument": [e["url"] for e in kurs if not e["dokument"]],
        },
        "rueckfall": [
            {"url": e["url"], "grund": e["rueckfall"], "fehler": e.get("rueckfall_grund")}
            for e in gelesen
            if e["rueckfall"]
        ],
        "laengste_zeile_neu": max((e["laengste_zeile_neu"] for e in gelesen), default=0),
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--urls", required=True, help="Datei mit Adressen")
    parser.add_argument("--aus", required=True, help="Ergebnisdatei (JSON)")
    parser.add_argument("--texte", help="Ordner für alt/neu-Texte je Adresse")
    parser.add_argument("--dokumente", help="Ordner mit Dokument-JSONs aus upload-link")
    parser.add_argument("--pause", type=float, default=2.0, help="Sekunden zwischen zwei Adressen")
    parser.add_argument("--nur-lokal", action="store_true", help="nur file:, data:, about: laden")
    args = parser.parse_args(argv)

    eintraege = adressen_lesen(args.urls)
    if not eintraege:
        print("Messung abgebrochen: keine Adresse in %s" % args.urls, file=sys.stderr)
        return 1
    links_ergaenzen(eintraege)
    dokumente = {}
    if args.dokumente:
        if not os.path.isdir(args.dokumente):
            print("Messung abgebrochen: Ordner fehlt: %s" % args.dokumente, file=sys.stderr)
            return 1
        dokumente = dokumente_lesen(args.dokumente, {e["link"] for e in eintraege})
        if not dokumente:
            print(
                "Messung abgebrochen: kein Dokument mit chunkSource link://<link> zu den "
                "%d Adressen in %s (erste: link://%s)"
                % (len(eintraege), args.dokumente, eintraege[0]["link"]),
                file=sys.stderr,
            )
            return 1

    from playwright.sync_api import sync_playwright

    if args.texte:
        os.makedirs(args.texte, exist_ok=True)
    funktion = textlesen.tabellen_funktion()
    aufklappen, entfernen = textlesen.selektoren()

    ergebnisse = []
    with sync_playwright() as pw:
        browser = textlesen.browser_starten(pw)
        try:
            for nummer, eintrag in enumerate(eintraege, 1):
                if nummer > 1 and args.pause > 0:
                    time.sleep(args.pause)
                # Wie generic.js: Zertifikatsfehler ignorieren, Fenster 800 x 600.
                context = browser.new_context(
                    viewport={"width": 800, "height": 600}, ignore_https_errors=True
                )
                context.route(
                    "**/*", lambda route: textlesen.anfragen_sperren(route, args.nur_lokal)
                )
                try:
                    ergebnis = messen(
                        context, eintrag, funktion, aufklappen, entfernen,
                        dokumente, args.texte, nummer,
                    )
                finally:
                    context.close()
                ergebnisse.append(ergebnis)
                print(
                    "%3d/%d %s tabellenzeilen=%s byte_gleich=%s woerter_gleich=%s kurs=%s/%s%s"
                    % (
                        nummer, len(eintraege), eintrag["url"],
                        ergebnis.get("tabellenzeilen"), ergebnis.get("byte_gleich"),
                        ergebnis.get("woerter_gleich"), ergebnis.get("gleiche_zeile_neu"),
                        ergebnis.get("kurszeilen"),
                        "  FEHLER " + ergebnis["fehler"] if ergebnis["fehler"] else "",
                    ),
                    flush=True,
                )
        finally:
            browser.close()

    bericht = {
        "erstellt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "chromium": "Playwright, channel chromium, 800 x 600",
        "zusammenfassung": zusammenfassen(ergebnisse),
        "seiten": ergebnisse,
    }
    with open(args.aus, "w", encoding="utf-8") as datei:
        json.dump(bericht, datei, ensure_ascii=False, indent=2)
    print(json.dumps(bericht["zusammenfassung"], ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
