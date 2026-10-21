# Design Center 2.0: alte Werte und neues Verhalten (ab 7.22)

Übersicht für den Flotten-Rollout (KIE-573, AK-7 aus
`issues/design-center-vereinfachen.md`): Was ändert sich sichtbar an einem
bestehenden Widget, wenn der Container auf 7.22 geht? Gespeicherte Werte in
`visual_config` bleiben dabei unverändert stehen. Der Server
(`server/utils/chats/embedStandards.js`, `server/endpoints/embed/index.js`)
liefert beim Ausliefern (`GET /embed/:id/config`) nur noch die wählbaren
Werte und setzt alles andere auf den festen Standard; das Widget setzt
dieselben Werte zusätzlich selbst. Angaben im Einbau-Code dürfen nur feste
Standards ohne Feld im Design Center verfeinern (Gruppe B, siehe Abschnitt
„Angaben im Einbau-Code und CSS-Variablen der Seite“). Das Design Center
schreibt beim Speichern nur, was der Kunde ändert (Regel D6).

Bis 7.21 hat das Design Center beim ersten Speichern seine Vorbelegung
(`DEFAULT_CONFIG`) mitgeschrieben. Davon gelten nur Begrüßung und Platzhalter
als „nicht gesetzt“; Name, Willkommensblasen, Farbe und Schrift bleiben
eigene Kundenwerte (Entscheidung E2, Fixliste 7.22-rc7). Die Vorbelegung
enthielt auch `defaultMessages: []`: Jedes bis 7.21 gespeicherte Widget hat
deshalb eine leere Liste und zeigt auch ab 7.22 keine Startvorschläge. Die
neuen Standard-Startvorschläge erscheinen praktisch nur bei Widgets, die nie
im Design Center gespeichert wurden.

Seit 7.22 bleibt ein gespeicherter Wert, der dem Standard gleicht, beim
Speichern eines anderen Feldes stehen (F05, Fixliste 7.22-rc13); entfernt
wird er nur, wenn der Kunde genau dieses Feld auf den Standard bringt.
Ebenso schreibt ein Klick auf die schon markierte Option bei Darstellung,
Farbschema, Chat-Icon und Position nichts (F11).

## Angaben im Einbau-Code und CSS-Variablen der Seite (ab 7.22-rc17)

Rangfolge nach den Entscheidungen E23 und E24 (Fixliste 7.22-rc17, Nutzer
21.10.2026). Sie ersetzt E18 (7.22-rc16: gespeicherte Werte schlagen ältere
Angaben am Skript, ohne gespeicherten Wert wirkte die Angabe weiter) und
ändert E10. Der Einbau-Code aus dem Reiter Einbau enthält nur
`data-embed-id` und `data-base-api-url`; Gestaltungs-Angaben stehen nur in
von Hand gebauten Einbau-Codes (Demo-Seite, Einbau-Paket vhs Rhein).

- **Gruppe A, im Design Center einstellbar:** Es gilt nur das Design
  Center, gespeichert oder sein Standard. Angaben im Einbau-Code und
  CSS-Variablen der Seite für diese Eigenschaften wirken nicht, auch wenn im
  Design Center nichts gespeichert ist. Das Widget setzt den Wert des Design
  Centers direkt und meldet verworfene Angaben in der Browser-Konsole.
  Eigenschaften (Angaben ohne Wirkung): Darstellung (`data-display-mode`),
  Farbschema (`data-theme`), Akzentfarbe (`data-button-color`,
  `data-user-bg-color`, `data-link-color`, auch die CSS-Variablen
  `--allm-accent` und `--allm-on-accent`), Schrift auf der Akzentfarbe
  (`data-user-text-color`), Logo (`data-brand-image-url`,
  `data-assistant-icon`), Chat-Icon (`data-chat-icon`), Position
  (`data-position`), Kurse anzeigen als und Reihenfolge (`data-course-cards`,
  `data-course-cards-position`), Name (`data-brand-text`,
  `data-assistant-name`), Untertitel (`data-assistant-subtitle`), Begrüßung
  (`data-greeting`, `data-greeting-bubble-text`), Platzhalter
  (`data-send-message-text`), Startvorschläge (`data-default-messages`),
  Willkommensblasen und ihre Anzeige je Gerät
  (`data-chatbot-bubbles-messages`, `data-welcome-bubbles-desktop`,
  `data-welcome-bubbles-mobile`, `data-display-chatbot-bubbles`,
  `data-bubble-persistence`), Support-E-Mail (`data-support-email`) und der
  Datenschutz-Hinweis mit Schalter, Überschrift, Text und Link
  (`data-privacy-notice`, `data-privacy-title`, `data-privacy-text`,
  `data-privacy-url`).
- **Gruppe B, feste Standards ohne Feld im Design Center:** die festen
  Werte aus `EMBED_FIXED_STANDARDS` (ohne den KI-Hinweis, E24) und
  `INLINE_FIXED_STANDARDS` (`server/utils/chats/embedStandards.js`) und alle
  Optik-Werte ohne Feld:
  Inline-Layout, Effekt, Höhe, Startzustand, Öffnen, Eingabeleiste, Texte
  der Inline-Leiste, Schrift der Seite übernehmen, Begrüßungs-, Vorschlags-
  und Folgefragen-Stil, Radien, Schatten, Flächen- und Textfarben,
  Kopffarben, Icon-Stil, Textgröße. Entwickler dürfen sie per Einbau-Angabe
  oder CSS-Variable verfeinern; die Einbau-Angabe schlägt den festen
  Standard, den der Server liefert. Die Tabellen unten nennen den Standard,
  der ohne solche Angabe gilt. Ob frühere Angaben ohne Feld wie
  `data-window-width`, `data-offset-x`, `data-inline-max-width`,
  `data-inline-theme`, `data-course-cards-layout` oder `data-online-dot` als
  Verfeinerung wirken oder ohne Wirkung bleiben, legt `ATTRIBUTES.md` im
  Widget fest; die Tabellen unten beschreiben gespeicherte Werte.
- **Gruppe C, Technik und Verhalten:** wirken immer: `data-embed-id`,
  `data-base-api-url`, `data-language`, `data-mount`, `data-username`, die
  vom Server freizugebenden KI-Angaben (`data-prompt`, `data-model`,
  `data-temperature`, `data-show-thoughts`), Audio (`data-enable-stt`,
  `data-enable-tts`, `data-tts-position`), `data-open-on-load`, Menütexte und
  Sponsor-Zeile.
- **KI-Hinweis (E24):** auf keinem Weg abschaltbar oder änderbar, weder im
  Design Center noch per Einbau-Angabe (`data-disclaimer`,
  `data-disclaimer-text`) oder CSS-Variable; Variablen, die ihn unsichtbar
  machen könnten, wirken auf ihn nicht. Den Datenschutz-Hinweis schaltet nur
  der Schalter im Design Center ein oder aus (Gruppe A).

Die vollständige Liste je Gruppe steht im Widget-Repo in `ATTRIBUTES.md`.
Unverändert bleibt die Schnittstelle zur Seite: der Platzhalter, das Signal
`data-allm-expanded` und die CSS-Variablen für Übergänge. Ein Klick auf die
schon markierte Option schreibt weiterhin nichts (F11); seit E23 hat das
keine Folge mehr für Angaben im Einbau-Code. Folge für den Rollout:
Kundenseiten mit Gruppe-A-Angaben im Einbau-Code zeigen ab 7.22 die Werte
aus dem Design Center (gespeichert oder Standard), nicht mehr die aus dem
Einbau-Code (Prüfpunkte 8 bis 10).

## Startvorschläge und Willkommensblasen in `GET /embed/:id/config` (ab 7.22-rc13)

Vertrag zwischen Server und Widget (Entscheidungen E10 bis E12, Fixliste
7.22-rc13; Fälle in
`server/__tests__/utils/chats/fixtures/embedConfigContract.json`, Kopie im
Widget-Repo unter `tests/fixtures/embedConfigContract.json`; Server-Test
`server/__tests__/endpoints/embedConfigContract.test.js`, Widget-Test
`tests/embed-config-contract.test.js`):

- **Sprache (E12):** Das Widget ruft `GET /embed/:id/config?language=<Sprache
  des Widgets>` auf (aus `data-language`); fehlend oder unbekannt heißt `de`.
  Der Server wählt damit nur die Standard-Startvorschläge. Design Center und
  Vorschau zeigen weiter die deutschen Standards, weil die Sprache des
  Widgets nur im Skript steht.
- **Listen als JSON-Array (E11):** `defaultMessages` und
  `chatbotBubblesMessages` kommen als Array von Strings, nicht mehr
  kommagetrennt. Einträge mit Komma („Gibt es Kurse, die abends
  stattfinden?“) bleiben eine Pille bzw. eine Blase. Die Skript-Attribute
  `data-default-messages` und `data-chatbot-bubbles-messages` wirken seit
  7.22-rc17 nicht mehr (Gruppe A, E23). Im Design Center gibt es kein
  Komma-Verbot.
- **Kennzeichen:** gespeicherte Liste: das Array ohne Kennzeichen;
  gespeichertes `[]` (oder nur leere Zeilen): `[]` mit
  `defaultMessagesSaved: true`; nichts gespeichert: die
  Standard-Startvorschläge der Sprache mit `defaultMessagesStandard: true`.
  Willkommensblasen nur, wenn eine nicht leere Liste gespeichert ist. Die
  Kennzeichen bleiben mit 7.22-rc17 unverändert: Das Widget erkennt daran
  den Standard bzw. die leer gespeicherte Liste (F52).
- **Vorrang im Widget (E10 neu, E23, 7.22-rc17):** gespeicherte Liste (auch
  leer) vor dem Standard. Ein gespeichertes `[]` heißt „keine
  Startvorschläge“. `data-default-messages` am Skript wirkt nicht, auch wenn
  nichts gespeichert ist; liefert ein älterer Server keine Liste, zeigt das
  Widget keine Startvorschläge. Willkommensblasen ebenso: gespeicherte
  Liste, sonst die Standardblasen des Widgets; `data-chatbot-bubbles-messages`
  wirkt nicht. Bis 7.22-rc16 galt das Skript-Attribut vor dem Standard.
- **Ältere Widget-Kopien:** Ein Widget vor 7.22-rc13 kann die Listen als
  Array nicht lesen und zeigt dann keine Startvorschläge und die
  Standard-Willkommensblasen. Seiten mit eigener Kopie des Widgets (z. B. die
  Demo unter `/widget/anythingllm-chat-widget.min.js`) brauchen das neue
  Widget.

## Darstellung

| Schlüssel                                                                                        | Alter Wert                                             | Neues Verhalten                                                                                                               |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `displayMode`                                                                                    | `bubble`, `inline`, fehlt                              | unverändert wählbar (Chatfenster / In der Seite), fehlt = Chatfenster                                                         |
| `theme`                                                                                          | `light`, `dark`                                        | unverändert wählbar, gilt jetzt für Chatfenster und Eingabeleiste                                                             |
| `theme`                                                                                          | `auto`                                                 | bleibt (folgt dem Gerät), bis Hell oder Dunkel gewählt wird                                                                   |
| `inlineTheme`                                                                                    | `light`, `dark`                                        | ignoriert, die Leiste folgt `theme` (Einbau-Angabe siehe Abschnitt „Angaben im Einbau-Code“)                                  |
| `accentColor`                                                                                    | gespeichert (auch `#607D8B` aus der alten Vorbelegung) | bleibt; neue Eingaben nur als deckender Farbcode; `data-button-color` u. a. und `--allm-accent`, `--allm-on-accent` der Seite wirken nicht (E23) |
| `userTextColor`                                                                                  | fehlt                                                  | Empfehlung nach Kontrast zur Akzentfarbe: Weiß oder Schwarz `#222628` (vorher immer Weiß); beim Standard-Türkis jetzt Schwarz |
| `userTextColor`                                                                                  | `#FFFFFF` (auch aus der alten Vorbelegung)             | bleibt Weiß (bewusste Wahl, nicht von der Vorbelegung zu unterscheiden)                                                       |
| `userTextColor`                                                                                  | `#000000`                                              | bleibt gespeichert, ausgeliefert und angezeigt als „Schwarz“ `#222628` (E1)                                                   |
| `position`, `chatIcon`, Logo                                                                     | gespeichert                                            | unverändert; gelten bei „In der Seite“ nur für das Chatfenster ohne Platzhalter                                               |
| `windowWidth`, `windowHeight`, `offsetX`, `offsetY`                                              | gespeichert                                            | ignoriert: Standardfenster, Randabstand 16 px (Einbau-Angabe siehe Abschnitt „Angaben im Einbau-Code“)                       |
| `inlineMaxWidth`                                                                                 | gespeichert                                            | ignoriert: volle Breite des Platzhalters (Einbau-Angabe siehe Abschnitt „Angaben im Einbau-Code“)                            |
| `inlineHeight`                                                                                   | z. B. `600px`                                          | fest `520px`                                                                                                                  |
| `inlineOpenOn`, `inlineEffect`, `inlineLayout`, `inlineStartState`, `inlineInput`, `inheritFont` | gespeichert                                            | Standard wie die Demo: `focus`, `morph`, `overlay`, `collapsed`, `true`, `true`; Einbau-Angaben (`data-inline-*`, `data-inherit-font`) verfeinern ihn (Gruppe B, E23) |
| Rundungen „In der Seite“                                                                         | folgten `--allm-radius`                                | fest 18 / 14 / 999 px (Blasen, Karten, Leiste); wer eckig will, setzt die Inline-Variablen selbst                             |
| `onlineDot`                                                                                      | `true`                                                 | kein Online-Punkt                                                                                                             |

## Begrüßung, Texte, Hinweise

| Schlüssel                               | Alter Wert                                                                       | Neues Verhalten                                                                                                                                                                              |
| --------------------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `greetingStyle`                         | `text` (alter Standard), `bubble`                                                | immer Begrüßung als erste Blase                                                                                                                                                              |
| `greeting`                              | eigener Text                                                                     | wird die Begrüßungsblase; über 300 Zeichen kürzt das Widget auf ein Wortende mit „…“                                                                                                         |
| `greeting`                              | alte Vorbelegung („Hallo und herzlich willkommen! …“) oder alter Widget-Standard | gilt als nicht gesetzt: neuer Standard „Hallo! Ich bin Ihr KI-Berater. Wie kann ich Ihnen helfen?“                                                                                           |
| `greetingBubbleText`                    | eigener Text bei `greetingStyle` oder `privacyNotice` `bubble`                   | gewinnt gegen `greeting` (stand bisher in der Blase)                                                                                                                                         |
| `greetingBubbleText`                    | eigener Text bei Stil `text`                                                     | ignoriert, solange eine eigene `greeting` gesetzt ist (war nie sichtbar)                                                                                                                     |
| `greeting` und `greetingBubbleText`     | beide eigener Text                                                               | schaltet der Kunde den Datenschutz-Hinweis um, bleibt beim Speichern der Text aus dem Feld „Begrüßungstext“; der andere, bisher unsichtbare Text wird entfernt (F04, 7.22-rc13; bewusste Ausnahme zum Negativfall „Texte bleiben“, E20, 7.22-rc16) |
| `sendMessageText`                       | „Wie kann ich Ihnen helfen?“ (alte Vorbelegung)                                  | gilt als nicht gesetzt: Standard „Ihre Frage eingeben“                                                                                                                                       |
| `inlineInputPlaceholder`                | eigener Leistentext bis 120 Zeichen                                              | bleibt wirksam                                                                                                                                                                               |
| `inlineSendText`, `inlineCollapsedText` | eigener Text                                                                     | nicht mehr ausgeliefert: Demo-Texte („Stellen Sie hier Ihre Frage …“, „Chatten“); Einbau-Angaben verfeinern sie (Gruppe B, E23)                                                              |
| `name`                                  | „Ihr Online-Berater“ (alte Vorbelegung)                                          | bleibt eigener Kundenwert (E2)                                                                                                                                                               |
| `assistantSubtitle`                     | fehlt                                                                            | Standard-Untertitel „Online-Berater mit künstlicher Intelligenz“ (en „Online advisor powered by artificial intelligence“), auch live im Widget (R5, 7.22-rc8; vorher kein Untertitel)        |
| `assistantSubtitle`                     | `""` (im Design Center geleert)                                                  | bewusst kein Untertitel; der Server liefert `assistantSubtitle: ""`                                                                                                                          |
| `name`, `assistantSubtitle`             | lang (mehr als eine Zeile in der Titelleiste)                                    | nie gekürzt: Name und Untertitel brechen in der Titelleiste um, der Kopf wird höher, ⋮ und ✕ bleiben frei (N3, Nutzerentscheidung 20.10.2026, ersetzt die Ellipse aus 7.22-rc10); die Vorschau im Design Center ebenso |
| `chatbotBubblesMessages`                | „Hallo! Ich bin Ihr Online-Berater!“ … (alte Vorbelegung)                        | bleibt eigener Kundenwert (E2)                                                                                                                                                               |
| `chatbotBubblesMessages`                | fehlt oder leer                                                                  | Standard-Willkommensblasen des Widgets in der Sprache des Widgets; `data-chatbot-bubbles-messages` am Skript wirkt nicht (E23)                                                               |
| `chatbotBubblesMessages`                | eigene Liste                                                                     | bleibt; ausgeliefert als Array, eine Blase mit Komma bleibt eine Blase (E11)                                                                                                                 |
| `defaultMessages`                       | fehlt                                                                            | Standard-Startvorschläge der Sprache des Widgets, auch live (S1, 7.22-rc10; Sprache per `?language=`, E12): „Ich suche einen Deutschkurs.“, „Gibt es Excel-Kurse am Abend?“ (en „I am looking for a German course.“, „Are there Excel courses in the evening?“), auch bei Doku- und Info-Bots; ein `data-default-messages` am Skript wirkt nicht (E10 neu, E23, 7.22-rc17); das Design Center zeigt sie als Vorbelegung und schreibt sie erst nach einer Änderung (R5) |
| `defaultMessages`                       | `[]` (alle gelöscht und gespeichert, auch die Vorbelegung bis 7.21)              | bewusst keine Startvorschläge, auch wenn am Skript `data-default-messages` steht (E10)                                                                                                       |
| `defaultMessages`                       | eigene Liste                                                                     | bleibt; ausgeliefert als Array, Einträge mit Komma bleiben ganz (E11)                                                                                                                        |
| `suggestionStyle`                       | `bars` u. a.                                                                     | Startvorschläge als Buttons wie die Folgefragen                                                                                                                                              |
| `followUps`                             | `none` (alter Standard)                                                          | Folgefragen als Buttons an                                                                                                                                                                   |
| `disclaimer`                            | `none` (alter Standard)                                                          | KI-Hinweis fest einzeilig unter der Eingabe: „Unsere KI kann Fehler machen. Bitte prüfen Sie die Antworten.“ (R1, 7.22-rc8, Kurzform nach der Messung des Widgets; en „Our AI can make mistakes. Please double-check the answers.“); auf keinem Weg abschaltbar oder änderbar, auch nicht per `data-disclaimer` oder CSS-Variable (E24) |
| `disclaimerText`                        | eigener Text                                                                     | ignoriert, ebenso `data-disclaimer-text` am Skript (E24)                                                                                                                                     |

## Datenschutz-Hinweis

| Schlüssel           | Alter Wert                                                        | Neues Verhalten                                                          |
| ------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `privacyNotice`     | `none`                                                            | Hinweis aus (Schalter „Datenschutz-Hinweis anzeigen“); nur dieser Schalter schaltet ihn, `data-privacy-notice` am Skript wirkt nicht (E24) |
| `privacyNotice`     | `bubble`, `modal`, fehlt                                          | Hinweis als zweite Blase unter der Begrüßung; der Einmal-Dialog entfällt |
| `privacyButtonText` | eigener Text                                                      | wirkungslos (kein Dialog mehr)                                           |
| `privacyTitle`      | „Datenschutz:“ / „Privacy:“                                       | gilt als nicht gesetzt: Standard ohne Doppelpunkt                        |
| `privacyTitle`      | `""`                                                              | bewusst keine Überschrift                                                |
| `privacyText`       | Altformat (Zeilen bzw. „\|“-Teile ohne „•“ oder „-“)              | mehrere Teile als Aufzählung („• “-Zeilen), ein Teil als Absatz          |
| `privacyText`       | länger als 1000 Zeichen, auch erst nach dem Voranstellen von „• “ | nicht ausgeliefert: Standardtext; im Design Center Fehler beim Ändern    |

## Antworten mit Kursen (KIE-567)

| Schlüssel                                     | Alter Wert                                     | Neues Verhalten                                                                                                                                                                                                                                                                                                                |
| --------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `courseCards`                                 | fehlt oder ungültig (bisher opt-in mit `auto`) | Standard nach der tatsächlichen Darstellung (R4, 7.22-rc8): Chatfenster „Nur Text mit Links“, In der Seite „Kurskarten“. `GET /embed/:id/config` liefert den Schlüssel dann nicht; das Widget entscheidet selbst und schickt seine Darstellung mit jeder Chat-Anfrage (`displayMode` im Body von `stream-chat`) für den Prompt |
| `courseCards`                                 | `auto`                                         | Kurskarten, in beiden Darstellungen (auch bei Doku- und Info-Bots)                                                                                                                                                                                                                                                             |
| `courseCards`                                 | `off`                                          | Nur Text mit Links, in beiden Darstellungen                                                                                                                                                                                                                                                                                    |
| `courseCardsPosition`                         | fehlt                                          | Karten zuerst (bisher ohne Wert unten)                                                                                                                                                                                                                                                                                         |
| `courseCardsPosition`                         | `below`                                        | Text zuerst                                                                                                                                                                                                                                                                                                                    |
| `courseCardsAnswerStyle`, `courseCardsLayout` | `long`, `classic`, `grid` u. a.                | fest: kurze Antwort, Karten als Zeilen                                                                                                                                                                                                                                                                                         |

Hinweis N2 (Review 7.22-rc6): Mit Kurskarten (gespeichert `auto` oder ohne
Wahl „In der Seite“) gehen bei jeder Antwort die Metadaten der
Website-Treffer (Titel, Adresse, Termin, Ort) als Karten an das Widget. Wer
das bei einem Doku- oder Info-Bot nicht will, stellt im Design Center „Nur
Text mit Links“ ein.

## Willkommensblasen je Gerät (KIE-568)

| Schlüssel                                            | Alter Wert    | Neues Verhalten                                                                                           |
| ---------------------------------------------------- | ------------- | --------------------------------------------------------------------------------------------------------- |
| `welcomeBubblesDesktop`, `welcomeBubblesMobile`      | fehlt         | „Beim ersten Besuch“ (wie bisher)                                                                         |
| `data-bubble-persistence="sessionStorage"` am Skript | einmal je Tab | wirkungslos (Gruppe A, E23); Ersatz: „Bei jedem Besuch“ im Design Center                                 |

## Prüfliste für den Rollout je Container

1. Widgets mit `courseCards` ohne Wert: Chatfenster bekommt „Nur Text mit Links“, „In der Seite“ Kurskarten. Soll es anders sein, im Design Center wählen.
2. Widgets mit `data-bubble-persistence` am Skript: auf „Bei jedem Besuch“ umstellen.
3. Seiten mit Eingabeleiste und eigenem `--allm-radius`: Rundungen prüfen.
4. Widgets mit eigenem `inlineSendText` oder `inlineCollapsedText`: Kunde informieren (Demo-Texte).
5. Widgets mit `userTextColor` `#FFFFFF` auf heller Akzentfarbe: das Design Center warnt unter 4,5:1; ggf. „Schwarz“ wählen.
6. Widgets ohne `assistantSubtitle`: zeigen ab 7.22 den Standard-Untertitel; wer keinen will, leert das Feld im Design Center.
7. Widgets ohne gespeicherte `defaultMessages` (nie im Design Center gespeichert): zeigen ab 7.22 die zwei Standard-Startvorschläge, auch Doku- und Info-Bots (Bethel, Nazareth, Dokubot); passen die Beispiele nicht, im Design Center eigene eintragen oder alle löschen und speichern. Bis 7.21 gespeicherte Widgets haben `[]` und zeigen keine.
8. Snippets mit `data-default-messages` am Skript: Das Attribut wirkt ab 7.22 nicht mehr, auch wenn im Design Center keine Liste gespeichert ist (E10 neu, E23, 7.22-rc17); es gilt die gespeicherte Liste, sonst die Standard-Startvorschläge. Bis 7.21 gespeicherte Widgets haben `[]` (alte Vorbelegung) und zeigen keine Startvorschläge. Vor dem Flotten-Rollout zählen, welche Kundenseiten das Attribut nutzen (F44, 7.22-rc16), und deren Liste im Design Center eintragen; erst danach auf 7.22 stellen.
9. Seiten mit eigener Kopie des Widgets (z. B. Demo `/widget/anythingllm-chat-widget.min.js`): auf das Widget ab 7.22-rc17 bringen, sonst fehlen die Startvorschläge (Listen als Array, E11), ohne gespeicherte Kurskarten-Wahl auch `displayMode` im Chat (R4), und Angaben der Gruppe A im Einbau-Code wirken dort weiter. Ab 7.22-rc13 ruft das Widget `/config?language=<Sprache>` auf: Eigene Demo-Kopien, die die `/config`-Antwort abfangen (z. B. die Topbar-Schalter der Demo in `app.js` und `next/app.js`), müssen die Adresse ohne Query vergleichen, sonst greifen ihre Schalter still nicht mehr (W41, 7.22-rc16). Seit E23 (7.22-rc17): Demo-Seite und Einbau-Paket vhs Rhein (`Kundendaten/Chatbot/demo_site/einbau_rhein/`) auf Pflicht- und Entwickler-Angaben kürzen; Gruppe-A-Angaben entfernen, Effekte und Inline-Feinheiten (Gruppe B) dürfen bleiben. Topbar-Schalter, die Design-Center-Optionen nachstellen, schreiben ihre Werte in die `/config`-Antwort statt in Attribute. Gilt auch für `praesentation` und `demo-inline`, die das Widget direkt vom Container laden: erst die Demo anpassen, dann auf 7.22 stellen.
10. Snippets mit Gruppe-A-Angaben am Skript (z. B. `data-theme`, `data-display-mode`, `data-position`, `data-chat-icon`, `data-button-color`, `data-greeting`, `data-privacy-notice`) und Seiten, die `--allm-accent` oder `--allm-on-accent` setzen: Diese Angaben wirken ab 7.22 nicht mehr, auch wenn im Design Center dafür nichts gespeichert ist (E23, 7.22-rc17; ersetzt E18 aus 7.22-rc16). Es gilt das Design Center, gespeichert oder sein Standard. Vor dem Rollout je Kundenseite die Werte aus dem Einbau-Code mit dem Design Center vergleichen und, wo der Kunde sie behalten will, im Design Center eintragen. Das Widget meldet verworfene Angaben in der Browser-Konsole. Gruppe-B-Angaben (z. B. `data-inline-effect`, `--allm-radius`) wirken weiter.
