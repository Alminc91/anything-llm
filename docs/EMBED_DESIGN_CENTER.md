# Embed: Design Center und Kurskarten-Prompt

Kurzreferenz für die Widget-Schlüssel, die das Design Center
(`frontend/src/pages/GeneralSettings/ChatEmbedWidgets/EmbedAppearance/`) in
`visual_config` schreibt, und für den Karten-Abschnitt im System-Prompt.

## Karten-Abschnitt hängt der Server an

Bei `courseCards = "auto"` hängt der Server den Karten-Abschnitt
(„Course Cards Mode …“) selbst ans **Ende** des System-Prompts
(`server/utils/chats/embed.js` → `embedSystemPrompt`, Texte in
`server/utils/chats/embedDefaults.js`). **Workspace-Prompts brauchen ihn nicht
mehr** — ein Prompt-Rollout für Karten entfällt.

Reihenfolge am Prompt-Ende: Karten-Abschnitt → Disclaimer-Hinweis
(`disclaimer = "footer"`) → Folgefragen-Hinweis (`followUps = "pills"`).
Ohne diese Schlüssel bleibt der Workspace-Prompt unverändert.

Antwortstil `courseCardsAnswerStyle`:

| Wert                               | Abschnitt                    | Antwort                                                                                               |
| ---------------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------- |
| `short` (Standard, auch ohne Wert) | „Course Cards Mode — Search“ | ein, zwei Sätze, keine Links — die Karten sind der Link                                               |
| `long`                             | „Course Cards Mode“          | kurze Einleitung + nummerierte Liste mit Kurs-Links                                                   |
| `classic`                          | **keiner**                   | Karten nur aus den Kurs-Links der Antwort bzw. einem Marker, den der Workspace-Prompt selbst verlangt |

Der Server besitzt den Abschnitt: Enthält der Workspace-Prompt noch einen
Abschnitt, der mit `### Course Cards Mode` beginnt (Groß-/Kleinschreibung und
Leerraum egal), wird er bei `short`/`long` bis zur nächsten Zeile `▪▪▪` bzw.
`### `-Überschrift entfernt und der aktuelle Server-Abschnitt angehängt (genau
einer). Bei `classic` bleibt der Workspace-Prompt unangetastet — Bestands-
Prompts mit eigenem Abschnitt funktionieren dann wie bisher.

Bei `disclaimer = "footer"` steht im Beispiel des Abschnitts keine
KI-Hinweis-Zeile (der Widget-Fuß zeigt sie, der Footer Override verbietet sie).

### Teaser-Regel

Beide Abschnitte (`short`, `long`) verlangen je empfohlenem Kurs eine Zeile
`[[TEASER n: …]]`: ein Satz mit **„15–20 words — never more than 20“** (vorher
„never fewer than 15“). Die Obergrenze hält den Teaser in der Zeilen-Karte
(`courseCardsLayout = "rows"`, Textbreite ≥ 500 px auf Desktop/Tablet) bei
höchstens zwei Zeilen. Die Beispiel-Teaser im Abschnitt liegen im Bereich.

## Folgefragen: Richtung und Filter

Bei `followUps = "pills"` hängt der Server den Hinweis
„### Follow-up Suggestions (ACTIVE)“ als **letzten** Abschnitt an
(`FOLLOW_UPS_PROMPT_NOTE` in `server/utils/chats/embedCourseSources.js`). Er
verlangt als letzte Zeile `[[FRAGEN: q1 | q2]]` mit zwei Vorschlägen **in den
Worten des Nutzers an den Berater** („Gibt es auch Kurse am Wochenende?“), nie
Fragen an den Nutzer („Suchen Sie …?“, „Möchten Sie …?“). Statt einer
Rückfrage (Basis-Prompt, „Intelligent Follow-up Questions“) bietet das Modell
deren wahrscheinliche Antworten als Vorschläge an
(`[[FRAGEN: Kurse für Babys | Kurse für Schulkinder]]`). Rückfragen im
Antworttext bleiben verboten.

Sicherheitsnetz im Server: `parseFollowUpItems` verwirft vor den übrigen
Regeln (`storedFollowUps`: ≤ 60 Zeichen, höchstens 3, ohne Dubletten) jeden
Eintrag, für den `addressesUser()` (`server/utils/chats/embedCardsMarker.js`)
zutrifft. Bewusst eng, lineare Muster, Einträge werden nicht verändert.
Geprüft wird in dieser Reihenfolge:

| Regel                                                                          | Muster                                                                                                                                                                                                                                                                                                                | Beispiele                                                                                                                                                                                      |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ausnahme: Bezug auf den Nutzer selbst → **nie** verwerfen (Groß/klein egal)    | `\b(mein\|meine\|meinen\|meiner\|meines\|mir\|mich)\b`                                                                                                                                                                                                                                                                | bleibt: „Brauchen Sie meine Kontodaten?“, „Möchten Sie meine Telefonnummer?“                                                                                                                   |
| deutsch, irgendwo: Verb + Höflichkeits-„Sie“ (großgeschrieben, kein i-Flag)    | `\b([sS]uchen\|[mM]öchten\|[wW]ollen\|[bB]evorzugen\|[iI]nteressieren\|[wW]ünschen)\s+Sie\b`                                                                                                                                                                                                                          | verworfen: „Suchen Sie einen Anfängerkurs?“, „Für welches Alter suchen Sie?“, „Welche Sprache möchten Sie lernen?“                                                                             |
| deutsch, irgendwo: Rückfrage nach Niveau/Alter                                 | `\bWelche[srn]?\s+(Niveau\|Alter\|Vorkenntnisse\|Erfahrung\|Stufe)\b[^\|]*\bSie\b` (linear zweistufig geprüft)                                                                                                                                                                                                        | verworfen: „Welches Niveau haben Sie?“, „Welche Vorkenntnisse haben Sie?“                                                                                                                      |
| englisch, irgendwo (Groß/klein egal)                                           | `\byour (child\|kid\|son\|daughter)\b`                                                                                                                                                                                                                                                                                | verworfen: „How old is your child?“, „Is your child already at school?“                                                                                                                        |
| englisch, am Anfang (nach führenden Satz-/Aufzählungszeichen, Groß/klein egal) | `^(are you (looking\|interested\|searching)\|do you prefer\|do you have a preferred\|do you want to\|do you need to\|would you (like\|prefer\|rather)\|which [^\|]* (do\|would) you (prefer\|like\|want to)\|do you have (any )?(prior \|previous )?experience\|what level are you\|how old (is\|are) (your\|you))\b` | verworfen: „Are you looking for beginner courses?“, „Would you like evening classes?“, „Do you prefer morning or evening classes?“, „Do you have any prior experience?“, „What level are you?“ |

Nicht in der deutschen Verbliste: brauchen, benötigen, planen — so bleiben
Nutzerfragen an die VHS erhalten („Was brauchen Sie für die Anmeldung?“,
„Planen Sie Kurse im Sommer?“). Das kleingeschriebene Pronomen
der 3. Person trifft nicht („Gibt es Kurse, die sie gemeinsam besuchen
können?“). Englisch bleiben „do you need/want“ ohne „to“ („Do you need my
ID?“, „Do you want a deposit?“), „are you planning/open“, „Which courses do you
offer?“, „Do you have a yoga course?“. Ebenso bleiben „Haben Sie Kurse am
Wochenende?“, „Bieten Sie Online-Kurse an?“, „Können Sie mir Anfängerkurse
zeigen?“, „Welche Kurse haben Sie am Abend?“.
Verworfene Einträge zählen nicht gegen die Höchstzahl.
Bleibt kein Eintrag, sendet der Server keinen `followUps`-Chunk; die Zeile wird
trotzdem aus dem Text entfernt, gespeichert wird wie bei `[[FRAGEN: -]]` kein
`followUps`-Feld (= keine Vorschläge). Bereits gespeicherte Vorschläge
(`/history`, LLM-Verlauf) laufen nur durch `storedFollowUps`, ohne Filter.

## Kartenlayout `courseCardsLayout`

| Wert                                         | Darstellung im Widget                                                   |
| -------------------------------------------- | ----------------------------------------------------------------------- |
| `grid` (Standard, auch ohne/ungültigen Wert) | Raster: zwei Karten nebeneinander                                       |
| `rows`                                       | Zeilen: eine Karte je Zeile, Zeit links, Status rechts (wie im Entwurf) |

`/embed/:id/config` liefert den Schlüssel nur mit gültigem Wert
(Groß-/Kleinschreibung egal, `LAYOUT_ENUMS` in `server/endpoints/embed`,
Quelle `COURSE_CARDS_LAYOUTS` in `embedDefaults.js`); sonst fehlt er und das
Widget nimmt das Raster bzw. sein Script-Attribut `data-course-cards-layout`.
Der Schlüssel ist reine Darstellung und kommt nie in den System-Prompt.

Design Center, Reiter „Antworten & Hinweise“ › „Antwort & Karten“: Feld
„Kartenlayout“ (Raster / Zeilen), nur sichtbar bei Kurskarten an. „Zeilen“
speichert `courseCardsLayout: "rows"`; „Raster“ bzw. unberührt speichert
nichts (Standard). Bei Karten aus ist das Feld ausgeblendet und ein
vorhandener Wert bleibt unangetastet. Die Vorschau zeigt keine Karten und
bleibt unverändert.

## Standardtexte

Begrüßungsblase, Datenschutz-Titel/-Punkte/-Knopf und KI-Hinweis haben
Kufer-Standardtexte (de/en, wörtlich wie `PANEL_TEXTS` im Embed-Repo). Das
Design Center lädt sie über `GET /api/embed/defaults?lang=de|en` (angemeldet,
Rollen wie die übrigen Embed-Verwaltungsendpunkte), zeigt sie als Feldwert und
speichert nur Abweichungen. Der öffentliche `/embed/:id/config` liefert sie
nicht aus. Bei Textänderungen im Widget `EMBED_DEFAULT_TEXTS` und die Kopie
`server/__tests__/utils/chats/fixtures/embedPanelTexts.json` nachziehen (sonst
setzt „Auf Standardtext zurücksetzen“ den alten Text). Stand Begrüßungsblase:
„Hallo! Ich bin Ihr digitaler Berater mit künstlicher Intelligenz (KI).
Beschreiben Sie einfach, was Sie suchen.“ (en: „Hello! I am your digital
advisor powered by artificial intelligence (AI). Just describe what you are
looking for.“).
