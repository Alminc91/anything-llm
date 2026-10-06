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

| Wert | Abschnitt | Antwort |
|---|---|---|
| `short` (Standard, auch ohne Wert) | „Course Cards Mode — Search“ | ein, zwei Sätze, keine Links — die Karten sind der Link |
| `long` | „Course Cards Mode“ | kurze Einleitung + nummerierte Liste mit Kurs-Links |
| `classic` | **keiner** | Karten nur aus den Kurs-Links der Antwort bzw. einem Marker, den der Workspace-Prompt selbst verlangt |

Der Server besitzt den Abschnitt: Enthält der Workspace-Prompt noch einen
Abschnitt, der mit `### Course Cards Mode` beginnt (Groß-/Kleinschreibung und
Leerraum egal), wird er bei `short`/`long` bis zur nächsten Zeile `▪▪▪` bzw.
`### `-Überschrift entfernt und der aktuelle Server-Abschnitt angehängt (genau
einer). Bei `classic` bleibt der Workspace-Prompt unangetastet — Bestands-
Prompts mit eigenem Abschnitt funktionieren dann wie bisher.

Bei `disclaimer = "footer"` steht im Beispiel des Abschnitts keine
KI-Hinweis-Zeile (der Widget-Fuß zeigt sie, der Footer Override verbietet sie).

## Standardtexte

Begrüßungsblase, Datenschutz-Titel/-Punkte/-Knopf und KI-Hinweis haben
Kufer-Standardtexte (de/en, wörtlich wie `PANEL_TEXTS` im Embed-Repo). Das
Design Center lädt sie über `GET /api/embed/defaults?lang=de|en` (angemeldet,
Rollen wie die übrigen Embed-Verwaltungsendpunkte), zeigt sie als Feldwert und
speichert nur Abweichungen. Der öffentliche `/embed/:id/config` liefert sie
nicht aus.
