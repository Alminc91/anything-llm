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
eigene Kundenwerte (Entscheidung E2, Fixliste 7.22-rc7).

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
| `sendMessageText`                       | „Wie kann ich Ihnen helfen?“ (alte Vorbelegung)                                  | gilt als nicht gesetzt: Standard „Ihre Frage eingeben“                                                                                                                                       |
| `inlineInputPlaceholder`                | eigener Leistentext bis 120 Zeichen                                              | bleibt wirksam                                                                                                                                                                               |
| `inlineSendText`, `inlineCollapsedText` | eigener Text                                                                     | nicht mehr ausgeliefert: Demo-Texte („Stellen Sie hier Ihre Frage …“, „Chatten“)                                                                                                             |
| `name`                                  | „Ihr Online-Berater“ (alte Vorbelegung)                                          | bleibt eigener Kundenwert (E2)                                                                                                                                                               |
| `assistantSubtitle`                     | fehlt                                                                            | Standard-Untertitel „Online-Berater mit künstlicher Intelligenz“ (en „Online advisor powered by artificial intelligence“), auch live im Widget (R5, 7.22-rc8; vorher kein Untertitel)        |
| `assistantSubtitle`                     | `""` (im Design Center geleert)                                                  | bewusst kein Untertitel; der Server liefert `assistantSubtitle: ""`                                                                                                                          |
| `chatbotBubblesMessages`                | „Hallo! Ich bin Ihr Online-Berater!“ … (alte Vorbelegung)                        | bleibt eigener Kundenwert (E2)                                                                                                                                                               |
| `chatbotBubblesMessages`                | fehlt oder leer                                                                  | Standard-Willkommensblasen des Widgets in der Sprache des Widgets                                                                                                                            |
| `defaultMessages`                       | fehlt                                                                            | keine Startvorschläge; das Design Center belegt das Feld mit „Ich suche einen Deutschkurs.“ und „Gibt es Excel-Kurse am Abend?“ vor, wirksam erst nach einer Änderung und dem Speichern (R5) |
| `defaultMessages`                       | `[]` (alle gelöscht und gespeichert)                                             | bewusst keine Startvorschläge                                                                                                                                                                |
| `suggestionStyle`                       | `bars` u. a.                                                                     | Startvorschläge als Buttons wie die Folgefragen                                                                                                                                              |
| `followUps`                             | `none` (alter Standard)                                                          | Folgefragen als Buttons an                                                                                                                                                                   |
| `disclaimer`                            | `none` (alter Standard)                                                          | KI-Hinweis fest einzeilig unter der Eingabe: „Unsere KI kann Fehler machen. Bitte überprüfen Sie die Antworten.“ (R1, 7.22-rc8)                                                              |
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
