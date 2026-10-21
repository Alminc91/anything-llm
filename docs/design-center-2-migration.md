# Design Center 2.0: alte Werte und neues Verhalten (ab 7.22)

Übersicht für den Flotten-Rollout (KIE-573, AK-7 aus
`issues/design-center-vereinfachen.md`): Was ändert sich sichtbar an einem
bestehenden Widget, wenn der Container auf 7.22 geht? Gespeicherte Werte in
`visual_config` bleiben dabei unverändert stehen. Der Server
(`server/utils/chats/embedStandards.js`, `server/endpoints/embed/index.js`)
liefert beim Ausliefern (`GET /embed/:id/config`) nur noch die wählbaren
Werte und setzt alles andere auf den festen Standard; das Widget erzwingt
dieselben Werte zusätzlich selbst. Das Design Center schreibt beim Speichern
nur, was der Kunde ändert (Regel D6).

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

Gespeicherte Werte schlagen ältere Angaben am Skript; zugesagt ist nur das
(E18, Fixliste 7.22-rc16). Ist für Darstellung, Farbschema, Chat-Icon oder
Position kein Wert gespeichert, wirkt ein älteres `data-display-mode`,
`data-theme`, `data-chat-icon` oder `data-position` am Skript weiter, auch
wenn das Design Center den Standard markiert. Ein Klick auf die markierte
Option ändert daran nichts (F11). Abhilfe: das Attribut am Skript entfernen
oder einmal die andere Option speichern und danach die gewünschte (siehe
Prüfpunkt 10). Die alte Vorbelegung bis 7.21 schrieb nie `theme` oder
`displayMode`; Widgets mit `data-theme` oder `data-display-mode` am Skript
trifft das also auch, wenn sie schon gespeichert wurden.

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
  stattfinden?“) bleiben eine Pille bzw. eine Blase. Skript-Attribute
  (`data-default-messages`, `data-chatbot-bubbles-messages`) werden weiter
  an Kommas getrennt. Im Design Center gibt es kein Komma-Verbot.
- **Kennzeichen:** gespeicherte Liste: das Array ohne Kennzeichen;
  gespeichertes `[]` (oder nur leere Zeilen): `[]` mit
  `defaultMessagesSaved: true`; nichts gespeichert: die
  Standard-Startvorschläge der Sprache mit `defaultMessagesStandard: true`.
  Willkommensblasen nur, wenn eine nicht leere Liste gespeichert ist.
- **Vorrang im Widget (E10):** gespeicherte Liste (auch leer) vor
  `data-default-messages` am Skript vor dem Standard. Ein gespeichertes `[]`
  heißt „keine Startvorschläge“, auch wenn das Skript-Attribut gesetzt ist.
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
| `inlineTheme`                                                                                    | `light`, `dark`                                        | ignoriert, die Leiste folgt `theme`; ein `data-inline-theme` am Skript wirkt nicht mehr                                       |
| `accentColor`                                                                                    | gespeichert (auch `#607D8B` aus der alten Vorbelegung) | bleibt; neue Eingaben nur als deckender Farbcode                                                                              |
| `userTextColor`                                                                                  | fehlt                                                  | Empfehlung nach Kontrast zur Akzentfarbe: Weiß oder Schwarz `#222628` (vorher immer Weiß); beim Standard-Türkis jetzt Schwarz |
| `userTextColor`                                                                                  | `#FFFFFF` (auch aus der alten Vorbelegung)             | bleibt Weiß (bewusste Wahl, nicht von der Vorbelegung zu unterscheiden)                                                       |
| `userTextColor`                                                                                  | `#000000`                                              | bleibt gespeichert, ausgeliefert und angezeigt als „Schwarz“ `#222628` (E1)                                                   |
| `position`, `chatIcon`, Logo                                                                     | gespeichert                                            | unverändert; gelten bei „In der Seite“ nur für das Chatfenster ohne Platzhalter                                               |
| `windowWidth`, `windowHeight`, `offsetX`, `offsetY`                                              | gespeichert oder per `data-*`                          | ignoriert: Standardfenster, Randabstand 16 px                                                                                 |
| `inlineMaxWidth`                                                                                 | gespeichert oder per `data-*`                          | ignoriert: volle Breite des Platzhalters                                                                                      |
| `inlineHeight`                                                                                   | z. B. `600px`                                          | fest `520px`                                                                                                                  |
| `inlineOpenOn`, `inlineEffect`, `inlineLayout`, `inlineStartState`, `inlineInput`, `inheritFont` | gespeichert                                            | fest wie die Demo: `focus`, `morph`, `overlay`, `collapsed`, `true`, `true`                                                   |
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
| `inlineSendText`, `inlineCollapsedText` | eigener Text                                                                     | nicht mehr ausgeliefert: Demo-Texte („Stellen Sie hier Ihre Frage …“, „Chatten“)                                                                                                             |
| `name`                                  | „Ihr Online-Berater“ (alte Vorbelegung)                                          | bleibt eigener Kundenwert (E2)                                                                                                                                                               |
| `assistantSubtitle`                     | fehlt                                                                            | Standard-Untertitel „Online-Berater mit künstlicher Intelligenz“ (en „Online advisor powered by artificial intelligence“), auch live im Widget (R5, 7.22-rc8; vorher kein Untertitel)        |
| `assistantSubtitle`                     | `""` (im Design Center geleert)                                                  | bewusst kein Untertitel; der Server liefert `assistantSubtitle: ""`                                                                                                                          |
| `name`, `assistantSubtitle`             | lang (mehr als eine Zeile in der Titelleiste)                                    | nie gekürzt: Name und Untertitel brechen in der Titelleiste um, der Kopf wird höher, ⋮ und ✕ bleiben frei (N3, Nutzerentscheidung 20.10.2026, ersetzt die Ellipse aus 7.22-rc10); die Vorschau im Design Center ebenso |
| `chatbotBubblesMessages`                | „Hallo! Ich bin Ihr Online-Berater!“ … (alte Vorbelegung)                        | bleibt eigener Kundenwert (E2)                                                                                                                                                               |
| `chatbotBubblesMessages`                | fehlt oder leer                                                                  | Standard-Willkommensblasen des Widgets in der Sprache des Widgets                                                                                                                            |
| `chatbotBubblesMessages`                | eigene Liste                                                                     | bleibt; ausgeliefert als Array, eine Blase mit Komma bleibt eine Blase (E11)                                                                                                                 |
| `defaultMessages`                       | fehlt                                                                            | Standard-Startvorschläge der Sprache des Widgets, auch live (S1, 7.22-rc10; Sprache per `?language=`, E12): „Ich suche einen Deutschkurs.“, „Gibt es Excel-Kurse am Abend?“ (en „I am looking for a German course.“, „Are there Excel courses in the evening?“), auch bei Doku- und Info-Bots; ein `data-default-messages` am Skript hat Vorrang (E10); das Design Center zeigt sie als Vorbelegung und schreibt sie erst nach einer Änderung (R5) |
| `defaultMessages`                       | `[]` (alle gelöscht und gespeichert, auch die Vorbelegung bis 7.21)              | bewusst keine Startvorschläge, auch wenn am Skript `data-default-messages` steht (E10)                                                                                                       |
| `defaultMessages`                       | eigene Liste                                                                     | bleibt; ausgeliefert als Array, Einträge mit Komma bleiben ganz (E11)                                                                                                                        |
| `suggestionStyle`                       | `bars` u. a.                                                                     | Startvorschläge als Buttons wie die Folgefragen                                                                                                                                              |
| `followUps`                             | `none` (alter Standard)                                                          | Folgefragen als Buttons an                                                                                                                                                                   |
| `disclaimer`                            | `none` (alter Standard)                                                          | KI-Hinweis fest einzeilig unter der Eingabe: „Unsere KI kann Fehler machen. Bitte prüfen Sie die Antworten.“ (R1, 7.22-rc8, Kurzform nach der Messung des Widgets; en „Our AI can make mistakes. Please double-check the answers.“) |
| `disclaimerText`                        | eigener Text                                                                     | ignoriert                                                                                                                                                                                    |

## Datenschutz-Hinweis

| Schlüssel           | Alter Wert                                                        | Neues Verhalten                                                          |
| ------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `privacyNotice`     | `none`                                                            | Hinweis aus (Schalter „Datenschutz-Hinweis anzeigen“)                    |
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
| `data-bubble-persistence="sessionStorage"` am Skript | einmal je Tab | wirkungslos, sobald der Server Werte liefert (immer ab 7.22); Ersatz: „Bei jedem Besuch“ im Design Center |

## Prüfliste für den Rollout je Container

1. Widgets mit `courseCards` ohne Wert: Chatfenster bekommt „Nur Text mit Links“, „In der Seite“ Kurskarten. Soll es anders sein, im Design Center wählen.
2. Widgets mit `data-bubble-persistence` am Skript: auf „Bei jedem Besuch“ umstellen.
3. Seiten mit Eingabeleiste und eigenem `--allm-radius`: Rundungen prüfen.
4. Widgets mit eigenem `inlineSendText` oder `inlineCollapsedText`: Kunde informieren (Demo-Texte).
5. Widgets mit `userTextColor` `#FFFFFF` auf heller Akzentfarbe: das Design Center warnt unter 4,5:1; ggf. „Schwarz“ wählen.
6. Widgets ohne `assistantSubtitle`: zeigen ab 7.22 den Standard-Untertitel; wer keinen will, leert das Feld im Design Center.
7. Widgets ohne gespeicherte `defaultMessages` (nie im Design Center gespeichert): zeigen ab 7.22 die zwei Standard-Startvorschläge, auch Doku- und Info-Bots (Bethel, Nazareth, Dokubot); passen die Beispiele nicht, im Design Center eigene eintragen oder alle löschen und speichern. Bis 7.21 gespeicherte Widgets haben `[]` und zeigen keine.
8. Snippets mit `data-default-messages` am Skript: wirken weiter, solange im Design Center keine Liste gespeichert ist; eine gespeicherte Liste, auch eine leere, hat Vorrang (E10). Bis 7.21 gespeicherte Widgets haben `[]` (alte Vorbelegung): Dort wirkt das Attribut ab 7.22 nicht mehr, und das Widget zeigt keine Startvorschläge; die Liste im Design Center eintragen. Vor dem Flotten-Rollout zählen, welche Kundenseiten das Attribut nutzen (F44, 7.22-rc16).
9. Seiten mit eigener Kopie des Widgets (z. B. Demo `/widget/anythingllm-chat-widget.min.js`): auf das Widget ab 7.22-rc13 bringen, sonst fehlen die Startvorschläge (Listen als Array, E11) und ohne gespeicherte Kurskarten-Wahl auch `displayMode` im Chat (R4). Ab 7.22-rc13 ruft das Widget `/config?language=<Sprache>` auf: Eigene Demo-Kopien, die die `/config`-Antwort abfangen (z. B. die Topbar-Schalter der Demo in `app.js` und `next/app.js`), müssen die Adresse ohne Query vergleichen, sonst greifen ihre Schalter still nicht mehr (W41, 7.22-rc16). Gilt auch für `praesentation` und `demo-inline`, die das Widget direkt vom Container laden: erst die Demo anpassen, dann auf 7.22 stellen.
10. Snippets mit `data-theme`, `data-display-mode`, `data-position` oder `data-chat-icon` am Skript: wirken weiter, solange im Design Center dafür kein Wert gespeichert ist; ein gespeicherter Wert hat Vorrang (E18). Ein Klick auf die markierte Standard-Option speichert nichts (F11). Soll das Design Center gelten: Attribut am Skript entfernen oder einmal die andere Option speichern und danach die gewünschte.
