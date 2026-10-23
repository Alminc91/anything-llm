# Design Center 2.0: alte Werte und neues Verhalten (ab 7.22)

Übersicht für den Flotten-Rollout (KIE-573, AK-7 aus
`issues/design-center-vereinfachen.md`): Was ändert sich sichtbar an einem
bestehenden Widget, wenn der Container auf 7.22 geht? Gespeicherte Werte in
`visual_config` bleiben dabei unverändert stehen. Der Server
(`server/utils/chats/embedStandards.js`, `server/endpoints/embed/index.js`)
liefert beim Ausliefern (`GET /embed/:id/config`) nur noch die wählbaren
Werte und setzt alles andere auf den festen Standard; das Widget setzt
dieselben Werte zusätzlich selbst. Angaben im Einbau-Code dürfen nur feste
Standards ohne Feld im Design Center verfeinern (Gruppe B); Technik-Angaben
wie `data-embed-id` oder `data-language` wirken immer (Gruppe C). Beides
steht im Abschnitt „Angaben im Einbau-Code und CSS-Variablen der Seite“. Das
Design Center schreibt beim Speichern nur, was der Kunde ändert (Regel D6).

Bis 7.21 hat das Design Center beim ersten Speichern seine Vorbelegung
(`DEFAULT_CONFIG`) mitgeschrieben. Davon gelten nur Begrüßung und Platzhalter
als „nicht gesetzt“; Name, Willkommensblasen, Farbe und Schrift bleiben
eigene Kundenwerte (Entscheidung E2, Fixliste 7.22-rc7). Die Vorbelegung
enthielt auch `defaultMessages: []`: Jedes bis 7.21 gespeicherte Widget hat
deshalb eine leere Liste und zeigt auch ab 7.22 keine Startvorschläge. Seit
E42 (Nutzerentscheidung 22.10.2026, 7.22-rc23) ist auch der Standard leer:
Startvorschläge zeigt ein Widget nur mit einer eigenen, im Design Center
gespeicherten Liste (bis 7.22-rc22 zeigten nie gespeicherte Widgets zwei
Beispiele).

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
  Centers direkt. Verworfene Angaben im Einbau-Code meldet es in der
  Browser-Konsole; CSS-Variablen der Seite übergeht es ohne Konsolenwarnung.
  Eigenschaften (Angaben ohne Wirkung): Darstellung (`data-display-mode`),
  Farbschema (`data-theme`), Akzentfarbe (`data-button-color`,
  `data-user-bg-color`, `data-link-color`), Schrift auf der Akzentfarbe
  (`data-user-text-color`), dazu die fünf CSS-Variablen der Seite, die das
  Widget aus Akzentfarbe und Schrift auf der Akzentfarbe setzt
  (`--allm-accent`, `--allm-on-accent`, `--allm-user-bg`, `--allm-user-text`,
  `--allm-link`), Logo (`data-brand-image-url`,
  `data-assistant-icon`), Chat-Icon (`data-chat-icon`), Position
  (`data-position`), Kurse anzeigen als und Reihenfolge (`data-course-cards`,
  `data-course-cards-position`), Name (`data-brand-text`,
  `data-assistant-name`), Untertitel (`data-assistant-subtitle`), Begrüßung
  (`data-greeting`, `data-greeting-bubble-text`), Platzhalter
  (`data-send-message-text`), Startvorschläge (`data-default-messages`),
  Willkommensblasen und ihre Anzeige je Gerät
  (`data-chatbot-bubbles-messages`, `data-welcome-bubbles-desktop`,
  `data-welcome-bubbles-mobile`, `data-display-chatbot-bubbles`,
  `data-bubble-persistence`), Support-E-Mail (`data-support-email`) und die
  Texte des Datenschutz-Fensters: Überschrift, Text und Link zur
  Datenschutzerklärung (`data-privacy-title`, `data-privacy-text`,
  `data-privacy-url`). Den Datenschutz-Hinweis selbst gibt es seit 7.23
  nur noch als festen Link (Gruppe B, nicht verfeinerbar).
- **Gruppe B, feste Standards ohne Feld im Design Center:** die festen
  Werte aus `EMBED_FIXED_STANDARDS` und `INLINE_FIXED_STANDARDS`
  (`server/utils/chats/embedStandards.js`) und alle Optik-Werte ohne Feld:
  Inline-Layout, Effekt, Höhe, Startzustand, Öffnen, Eingabeleiste, Texte
  der Inline-Leiste (der Platzhalter der Leiste folgt seit 23.10.2026 dem
  Feld „Platzhalter“; `data-inline-input-placeholder` verfeinert ihn
  weiterhin), Schrift der Seite übernehmen, Begrüßungs-, Vorschlags-
  und Folgefragen-Stil, Radien, Schatten, Flächen- und Textfarben,
  Kopffarben, Icon-Stil, Textgröße. Entwickler dürfen sie per Einbau-Angabe
  oder CSS-Variable verfeinern; die Einbau-Angabe schlägt den festen
  Standard, den der Server liefert. Nicht verfeinerbar sind vier Werte aus
  `EMBED_FIXED_STANDARDS`: der KI-Hinweis (`disclaimer`, gesperrt, siehe
  „KI-Hinweis (E24)“), `courseCardsAnswerStyle` (die kurze Antwort zu
  Kurskarten; den Wert liest nur der Server für den Prompt, das Widget hat
  dafür keine Angabe), `onlineDot` (den Online-Punkt gibt es nicht mehr,
  `data-online-dot` bleibt ohne Wirkung) und seit 7.23 `privacyNotice`
  (immer `link`: der Link „Datenschutz“ neben dem KI-Hinweis,
  `data-privacy-notice` bleibt ohne Wirkung, siehe „Datenschutz-Hinweis“).
  Das Datenschutz-Fenster (ab 7.23) nutzt Fläche und Schrift der
  Antwortblasen und die Rundung des Panels, wie bis 7.22.2 die
  Datenschutz-Blase (Nutzer 23.10.2026, ersetzte E25 aus 7.22-rc18 mit
  festen Farben). Die Grenze beim Begrüßungsstil (E26, 7.22-rc18:
  `data-greeting-style="text"` wirkte nur bei abgeschaltetem
  Datenschutz-Hinweis, weil die Datenschutz-Blase an der Begrüßungsblase
  hing) hat ab 7.23 keinen Anlass mehr und entfällt im Widget:
  `data-greeting-style="text"` verfeinert den Standard wie die übrigen
  Angaben dieser Gruppe. Die Tabellen unten nennen den Standard, der ohne
  solche Angabe gilt. Ob frühere Angaben
  ohne Feld wie `data-window-width`, `data-offset-x`,
  `data-inline-max-width`, `data-inline-theme` oder
  `data-course-cards-layout` als Verfeinerung wirken oder ohne Wirkung
  bleiben, legt `ATTRIBUTES.md` im Widget fest; die Tabellen unten
  beschreiben gespeicherte Werte.
- **Gruppe C, Technik und Verhalten:** wirken immer: `data-embed-id`,
  `data-base-api-url`, `data-language`, `data-mount`, `data-username`, die
  vom Server freizugebenden KI-Angaben (`data-prompt`, `data-model`,
  `data-temperature`, `data-show-thoughts`), Audio (`data-enable-stt`,
  `data-enable-tts`, `data-tts-position`), `data-open-on-load`, Menütexte und
  Sponsor-Zeile.
- **KI-Hinweis (E24):** auf keinem Weg abschaltbar oder änderbar, weder im
  Design Center noch per Einbau-Angabe (`data-disclaimer`,
  `data-disclaimer-text`) oder CSS-Variable; Variablen, die ihn unsichtbar
  machen könnten, wirken auf ihn nicht. Seit 7.23 steht in derselben Zeile
  der Link „Datenschutz“ („Unsere KI kann Fehler machen · Datenschutz“); auch
  ihn und das Datenschutz-Fenster blendet keine Angabe aus, weder
  `data-privacy-notice` noch ein Wert im Design Center (es gibt dort keinen
  Schalter mehr).

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
  Widgets nur im Skript steht. Seit E42 ist der Standard in jeder Sprache
  leer; Abfrage und Sprachwahl bleiben für den Vertrag und den Cache je
  Sprache.
- **Standard leer (E42, Nutzerentscheidung 22.10.2026, 7.22-rc23):** Ohne
  gespeicherte Liste gibt es keine Startvorschläge, in allen Sprachen.
  Begründung des Nutzers: Ob eine Einrichtung Deutsch- oder Excel-Kurse
  anbietet, muss der Kunde festlegen. Bis 7.22-rc22 lieferte der Server
  ohne Liste zwei Beispiele („Ich suche einen Deutschkurs.“, „Gibt es
  Excel-Kurse am Abend?“, englisch „I am looking for a German course.“, „Are
  there Excel courses in the evening?“). Der Vertrag bleibt: `[]` mit
  `defaultMessagesStandard: true`. Gespeicherte Listen gelten unverändert,
  ein gespeichertes `[]` bleibt „keine Startvorschläge“. Im Design Center
  ist das Feld „Fragen zum Anklicken“ ohne gespeicherte Liste leer, die
  Vorschau zeigt keine Pillen. Leert ein Kunde dort eine gespeicherte
  Liste, entfällt der Schlüssel beim Speichern (Standard, R5); live gibt es
  dann ebenso keine Startvorschläge.
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
  Standard-Startvorschläge der Sprache mit `defaultMessagesStandard: true`,
  seit E42 also `[]` mit diesem Kennzeichen.
  Willkommensblasen nur, wenn eine nicht leere Liste gespeichert ist. Die
  Kennzeichen bleiben mit 7.22-rc17 unverändert (F52), für ältere
  Widget-Kopien und einen stabilen Vertrag: Bis 7.22-rc16 ließ das Widget
  an `defaultMessagesStandard` ein `data-default-messages` vor den Standard.
  Das Widget ab 7.22-rc17 wertet `defaultMessagesStandard` nicht aus und
  entfernt beide Kennzeichen; `defaultMessagesSaved` nutzt es nur, wenn die
  Liste fehlt, was dieser Server nie liefert.
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
| `accentColor`                                                                                    | gespeichert (auch `#607D8B` aus der alten Vorbelegung) | bleibt als Hex oder `rgb()`, wie im Design Center; andere gespeicherte Werte ergeben den Standard `#007C82` (E41, Absatz unter der Tabelle, Prüfpunkt 12); neue Eingaben nur als deckender Farbcode; `data-button-color` u. a. und die Seiten-Variablen `--allm-accent`, `--allm-on-accent`, `--allm-user-bg`, `--allm-user-text`, `--allm-link` wirken nicht (E23, Prüfpunkt 10) |
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

Eine Regel für gültige Farben (E41, 7.22-rc22): Akzentfarbe und Schrift auf
der Akzentfarbe (die Farben der Gruppe A, daraus auch Nutzerblasen und Links)
gelten nur als Hex (`#rgb`, `#rrggbb`, `#rrggbbaa`) und als `rgb()`/`rgba()`
mit ganzen Zahlen bis 255, Leerraum darin nur Leerzeichen, Tab, Zeilenumbruch
und Seitenvorschub, und nur deckend, wie im Design Center. Maßgeblich ist
`parseColor`
(`frontend/src/pages/GeneralSettings/ChatEmbedWidgets/EmbedAppearance/contrast.js`,
wortgleich mit `src/utils/contrast.js` im Widget) zusammen mit der Deckkraft:
Was es liest und deckend ist, zeigt das Widget, und die Kontrastrechnung kann
es lesen; genau diese Werte nimmt das Design Center an. Andere gespeicherte
Werte (z. B. `hsl()`, Farbnamen wie `teal`, Prozent, `#rgba`, `transparent`,
`oklch()`, Systemfarben wie `Canvas`, `var()`, Wörter ohne Farbe wie „blau“,
`rgb()` mit gemischten Trennern oder mit geschützten Leerzeichen) und Werte
mit Deckkraft unter 1 (`rgba()` mit Alpha unter 1, `#rrggbbaa` unter `ff`;
E41 Ergänzung (a)) ergeben im Widget ab 7.22 den Standard: Akzentfarbe
`#007C82` (bis 7.22.1 `#01A5A9`), Schrift nach Kontrast. Das Design Center meldet sie erst, wenn das
Feld geändert wird; das Feld zeigt bis dahin den gespeicherten Wert, die
Vorschau zeigt wie das Widget den Standard (E41 Ergänzung (b)). Vor dem
Rollout zählen (Prüfpunkt 12). Rückweg: `dcColor` im Widget wieder erweitern.

### Standard-Akzentfarbe Petrol (7.22.2)

Nutzerentscheidung 23.10.2026: Die Standard-Akzentfarbe wechselt von
Würfel-Türkis `#01A5A9` auf Kufer-Petrol `#007C82` (gleicher Farbton wie der
Würfel, nur dunkler). Die Schrift nach Kontrast wird darauf Weiß (4,99:1,
vorher Schwarz auf Türkis 5,06:1); Links auf Weiß erreichen 4,99:1 statt
3,02:1. Wirkt auf alle Widgets ohne gespeicherte Akzentfarbe. Gespeicherte
Farben bleiben, auch ein gespeichertes `#01A5A9`; es gilt ab 7.22.2 als
eigene Kundenfarbe (beim Rollout einzeln entscheiden, ob es entfernt wird).
Quelle im Widget: `DEFAULT_ACCENT` in `src/utils/theme.js`; im Design Center
`LOOK_DEFAULTS.accentColor` in `widgetKeys.js`; beide gleich halten.

## Begrüßung, Texte, Hinweise

| Schlüssel                               | Alter Wert                                                                       | Neues Verhalten                                                                                                                                                                              |
| --------------------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `greetingStyle`                         | `text` (alter Standard), `bubble`                                                | immer Begrüßung als erste Blase (gespeicherter Wert ohne Wirkung); `data-greeting-style="text"` am Skript wirkte 7.22 bis 7.22.2 nur bei abgeschaltetem Datenschutz-Hinweis (Gruppe B, E26, 7.22-rc18); ab 7.23 gibt es keine Datenschutz-Blase mehr, die Ausnahme entfällt, die Angabe verfeinert wie jede Gruppe-B-Angabe |
| `greeting`                              | eigener Text                                                                     | wird die Begrüßungsblase; über 300 Zeichen kürzt das Widget auf ein Wortende mit „…“                                                                                                         |
| `greeting`                              | alte Vorbelegung („Hallo und herzlich willkommen! …“), alter Widget-Standard oder alte Datenschutz-Vorlage (E43), auch mit anderem Leerraum | gilt als nicht gesetzt: neuer Standard „Hallo! Ich bin Ihr KI-Berater. Wie kann ich Ihnen helfen?“; der Datenschutz-Hinweis steht ab 7.23 im Fenster hinter dem Link „Datenschutz“ (bis 7.22.2 als Blase darunter; Abschnitt „Alte Datenschutz-Vorlagen in der Begrüßung“) |
| `greetingBubbleText`                    | eigener Text bei `greetingStyle` oder `privacyNotice` `bubble`                   | gewinnt gegen `greeting` (stand bisher in der Blase)                                                                                                                                         |
| `greetingBubbleText`                    | eigener Text bei Stil `text`                                                     | ignoriert, solange eine eigene `greeting` gesetzt ist (war nie sichtbar)                                                                                                                     |
| `greeting` und `greetingBubbleText`     | beide eigener Text                                                               | bis 7.22.2: schaltete der Kunde den Datenschutz-Hinweis um, blieb beim Speichern der Text aus dem Feld „Begrüßungstext“, der andere, bisher unsichtbare Text wurde entfernt (F04, 7.22-rc13; bewusste Ausnahme zum Negativfall „Texte bleiben“, E20, 7.22-rc16); ab 7.23 gibt es den Schalter nicht mehr, das Design Center ändert `privacyNotice` nie, beide Texte bleiben stehen |
| `sendMessageText`                       | „Wie kann ich Ihnen helfen?“ (alte Vorbelegung), „Ihre Frage eingeben“ / „Enter your question“ (Standard bis 7.22.2-rc4) | gilt als nicht gesetzt: Standard „Stellen Sie hier Ihre Frage …“ (en „Ask your question here …“), seit der Nutzerentscheidung vom 23.10.2026 derselbe Text wie in der eingeklappten Leiste |
| `sendMessageText`                       | eigener Text                                                                     | gilt im Eingabefeld des Chats (Chatfenster und aufgeklapptes „In der Seite“) und seit 23.10.2026 auch in der eingeklappten Leiste, wenn er höchstens 120 Zeichen hat (sonst dort der Standard) |
| `inlineInputPlaceholder`                | eigener Leistentext bis 120 Zeichen                                              | bleibt wirksam und geht in der eingeklappten Leiste dem eigenen Platzhalter vor                                                                                                             |
| `inlineSendText`, `inlineCollapsedText` | eigener Text                                                                     | nicht mehr ausgeliefert: Demo-Texte („Stellen Sie hier Ihre Frage …“, „Chatten“); Einbau-Angaben verfeinern sie (Gruppe B, E23)                                                              |
| `name`                                  | „Ihr Online-Berater“ (alte Vorbelegung)                                          | bleibt eigener Kundenwert (E2)                                                                                                                                                               |
| `assistantSubtitle`                     | fehlt                                                                            | Standard-Untertitel „Online-Berater mit künstlicher Intelligenz“ (en „Online advisor powered by artificial intelligence“), auch live im Widget (R5, 7.22-rc8; vorher kein Untertitel)        |
| `assistantSubtitle`                     | `""` (im Design Center geleert)                                                  | bewusst kein Untertitel; der Server liefert `assistantSubtitle: ""`                                                                                                                          |
| `name`, `assistantSubtitle`             | lang (mehr als eine Zeile in der Titelleiste)                                    | nie gekürzt: Name und Untertitel brechen in der Titelleiste um, der Kopf wird höher, ⋮ und ✕ bleiben frei (N3, Nutzerentscheidung 20.10.2026, ersetzt die Ellipse aus 7.22-rc10); die Vorschau im Design Center ebenso |
| `chatbotBubblesMessages`                | „Hallo! Ich bin Ihr Online-Berater!“ … (alte Vorbelegung)                        | bleibt eigener Kundenwert (E2)                                                                                                                                                               |
| `chatbotBubblesMessages`                | fehlt oder leer                                                                  | Standard-Willkommensblasen des Widgets in der Sprache des Widgets; `data-chatbot-bubbles-messages` am Skript wirkt nicht (E23)                                                               |
| `chatbotBubblesMessages`                | eigene Liste                                                                     | bleibt; ausgeliefert als Array, eine Blase mit Komma bleibt eine Blase (E11)                                                                                                                 |
| `defaultMessages`                       | fehlt                                                                            | keine Startvorschläge, in jeder Sprache (Standard leer, E42, Nutzerentscheidung 22.10.2026, 7.22-rc23; bis 7.22-rc22 zwei Beispiele, S1); ein `data-default-messages` am Skript wirkt nicht (E10 neu, E23, 7.22-rc17); im Design Center ist das Feld leer, die Vorschau ohne Pillen |
| `defaultMessages`                       | `[]` (alle gelöscht und gespeichert, auch die Vorbelegung bis 7.21)              | bewusst keine Startvorschläge, auch wenn am Skript `data-default-messages` steht (E10)                                                                                                       |
| `defaultMessages`                       | eigene Liste                                                                     | bleibt; ausgeliefert als Array, Einträge mit Komma bleiben ganz (E11)                                                                                                                        |
| `suggestionStyle`                       | `bars` u. a.                                                                     | Startvorschläge als Buttons wie die Folgefragen                                                                                                                                              |
| `followUps`                             | `none` (alter Standard)                                                          | Folgefragen als Buttons an                                                                                                                                                                   |
| `disclaimer`                            | `none` (alter Standard)                                                          | KI-Hinweis fest einzeilig unter der Eingabe, ab 7.23 „Unsere KI kann Fehler machen“ und in derselben Zeile der Link „Datenschutz“ (en „Our AI can make mistakes · Privacy“; Nutzer 23.10.2026). Die Bitte, Antworten zu prüfen, steht als Punkt „Hinweis zur KI“ im Datenschutz-Fenster. 7.22 bis 7.22.2: „Unsere KI kann Fehler machen. Bitte prüfen Sie die Antworten.“ (R1, 7.22-rc8). Auf keinem Weg abschaltbar oder änderbar, auch nicht per `data-disclaimer` oder CSS-Variable (E24) |
| `disclaimerText`                        | eigener Text                                                                     | ignoriert, ebenso `data-disclaimer-text` am Skript (E24)                                                                                                                                     |

## Alte Datenschutz-Vorlagen in der Begrüßung (E43, 7.22-rc24)

Nutzerentscheidung 22.10.2026 („Alte Vorlage als nicht gesetzt“): Steht in
`greeting` oder `greetingBubbleText` genau eine unserer alten
Datenschutz-Vorlagen, gilt die Begrüßung wie nicht gesetzt. Es gilt die
Standard-Begrüßung der Sprache des Widgets („Hallo! Ich bin Ihr KI-Berater.
Wie kann ich Ihnen helfen?“, en „Hello! I am your AI advisor. How can I help
you?“) wie bei jedem Widget ohne eigene Begrüßung. Sonst stünde der Hinweis
doppelt da (Begrüßung und Datenschutz-Blase, ab 7.23 Begrüßung und
Datenschutz-Fenster). Gespeichert bleibt alles unverändert, die Datenbank wird
nicht geändert.

- **Erlaubnisliste:** `LEGACY_PRIVACY_GREETINGS` in
  `server/utils/chats/embedStandards.js` (Kopie im Design Center
  `widgetKeys.js`, ein Test vergleicht beide), genaue Texte, keine
  Stichwortsuche. Verglichen wird nach Normalisierung von Leerraum
  (Zeilenumbrüche, Tabulatoren, mehrfache und geschützte Leerzeichen, Rand);
  dieser Vergleich gilt seit E43 auch für die übrigen früheren Vorbelegungen
  der Begrüßung (`LEGACY_DEFAULT_GREETINGS`).
- **Erkannte Vorlagen** (Erhebung der Flotte am 22.10.2026, nur lesend, 82
  Container auf 7.8 und 7.21.1, 86 Embeds):
  1. Juni-Rollout (12.06.2026, ab 21.07.2026 auch Code-Standard des
     Widgets), bei 58 Embeds in 51 Containern gespeichert (55 eingeschaltet),
     überall wortgleich: „Dieser Chatbot nutzt künstliche Intelligenz (KI). Ihre Nachrichten werden nicht an Dritte weitergegeben, können aber zur Qualitätssicherung von uns eingesehen werden. Bitte geben Sie keine sensiblen personenbezogenen Daten ein.“
     Dieser Wortlaut galt schon seit dem Design Center 2.0 als frühere
     Vorbelegung (Vergleich nach `trim()`); für diese Widgets ändert E43
     nichts Sichtbares.
  2. Früherer Standard-Datenschutztext des Widgets (06.10.2026 bis E30,
     7.22-rc19, noch mit „Mitarbeitende“) als ein Absatz, bei 3 Embeds eines
     Demo-Containers; dort stand der Hinweis mit 7.22-rc23 doppelt:
     „Ihre Anfragen bleiben auf Servern in Deutschland und werden nicht an Dritte weitergegeben. Mitarbeitende der Einrichtung können Gespräche zur Qualitätssicherung einsehen. Bitte teilen Sie nur Angaben, die für Ihre Anfrage nötig sind.“
- **Bleiben eigene Texte:** vom Kunden abgewandelte Vorlagen (umgestellt,
  ergänzt, gekürzt, andere Wörter), die Vorlage mit eigenem Satz davor oder
  dahinter, eigene Datenschutz- oder Einwilligungssätze. Solche Widgets
  zeigten in 7.22 Begrüßung und Datenschutz-Blase nacheinander, ab 7.23 die
  Begrüßung und hinter dem Link „Datenschutz“ das Fenster (Prüfpunkt 13).
  Ist `greeting` eine Vorlage und `greetingBubbleText` ein eigener Text (oder
  umgekehrt), gilt der eigene Text.
- **Design Center:** Der Reiter Inhalt zeigt bei einer Vorlage im Feld
  „Begrüßungstext“ den Standard (wie ohne gespeicherten Text), die Vorschau
  ebenso. Gespeichert wird die Begrüßung erst, wenn der Kunde das Feld
  ändert; beim Speichern anderer Felder bleibt die Vorlage wörtlich stehen.
- **Widget:** unverändert. Die Begrüßung kommt allein vom Server (Gruppe A,
  E23: `data-greeting` und `data-greeting-bubble-text` am Skript wirken
  nicht); liefert er keine, zeigt das Widget den Standard seiner Sprache.

## Datenschutz-Hinweis

Ab 7.23 (Nutzerentscheidung 23.10.2026, `issues/datenschutz-fusszeile.md`)
steht der Datenschutz-Hinweis nicht mehr als Blase im Verlauf. Unter der
Eingabe steht immer genau eine Zeile „Unsere KI kann Fehler machen ·
Datenschutz“ (en „Our AI can make mistakes · Privacy“); nur „Datenschutz“ ist
der Link. Er öffnet das Datenschutz-Fenster über dem Chat mit der Überschrift
(`privacyTitle`, sonst „Datenschutz“), dem Text (`privacyText`, sonst die drei
Standardpunkte), dem festen Punkt „Hinweis zur KI“ („Unser KI-Berater ist auf
richtige Auskünfte aus unserem Kursangebot optimiert. Wie jede KI kann er sich
dennoch einmal irren. Wichtige Angaben wie Termine und Preise finden Sie zur
Sicherheit immer auch auf der Kursseite.“), dem Link zur Datenschutzerklärung
(`privacyUrl`, falls gesetzt) und dem Button „Schließen“. Es gibt keine Wahl
mehr: kein Schalter im Design Center, keine Blase beim Start, kein „Aus“, kein
Pop-up mit Bestätigung. `GET /embed/:id/config` liefert fest
`privacyNotice: "link"` (`EMBED_FIXED_STANDARDS`); das Design Center schreibt
`privacyNotice` beim Speichern nicht, ein gespeicherter Altwert bleibt
unverändert stehen. Keine Migration, keine neuen Schlüssel in `visual_config`.
Bestand laut Scan vom 23.10.2026 (94 Widgets, nur lesend): 91 ohne
`privacyNotice`, 3 mit `bubble`, keines mit `none`, keines mit `privacyUrl`, 2
mit eigenem Datenschutz-Text.

| Schlüssel           | Alter Wert                                                        | Neues Verhalten                                                          |
| ------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `privacyNotice`     | `bubble`, `modal`, fehlt                                          | ab 7.23 keine Datenschutz-Blase beim Start mehr, der Link „Datenschutz“ steht in der Fußzeile; Begrüßung, Startvorschläge und Folgefragen bleiben. 7.22 bis 7.22.2: zweite Blase unter der Begrüßung, die Begrüßung blieb dafür eine Blase, auch gegen `data-greeting-style="text"` (E26, 7.22-rc18); der Einmal-Dialog `modal` entfiel schon mit 7.22 |
| `privacyNotice`     | `none`                                                            | ab 7.23 ohne Wirkung: der Link steht trotzdem in der Fußzeile (kein „Aus“ mehr). 7.22 bis 7.22.2: Hinweis aus (Schalter „Datenschutz-Hinweis anzeigen“) |
| `privacyNotice`     | `data-privacy-notice` am Skript                                   | ohne Wirkung, wie seit 7.22-rc17 (Gruppe A, E23); ab 7.23 fester Standard ohne Verfeinerung |
| `privacyButtonText` | eigener Text                                                      | wirkungslos (kein Dialog mehr)                                           |
| `privacyUrl`        | fehlt                                                             | kein Link zur Datenschutzerklärung im Fenster; das Design Center empfiehlt, ihn einzutragen |
| `privacyUrl`        | `https://…` oder `/pfad`                                          | ab 7.23 als Link zur Datenschutzerklärung im Datenschutz-Fenster (bis 7.22.2 am Ende der Blase), neuer Tab |
| `privacyTitle`      | „Datenschutz:“ / „Privacy:“                                       | gilt als nicht gesetzt: Standard ohne Doppelpunkt                        |
| `privacyTitle`      | `""`                                                              | ab 7.23 zeigt das Datenschutz-Fenster den Standard „Datenschutz“ (en „Privacy“), das Fenster hat immer eine Überschrift; 7.22 bis 7.22.2 bewusst keine Überschrift in der Blase |
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
7. Widgets ohne gespeicherte `defaultMessages` (nie im Design Center gespeichert): zeigen ab 7.22 keine Startvorschläge, der Standard ist leer (E42, Nutzerentscheidung 22.10.2026, 7.22-rc23; bis 7.22-rc22 waren es zwei Beispiele). Wer Startvorschläge will, trägt sie im Design Center ein. Gespeicherte Listen gelten unverändert, ein gespeichertes `[]` bleibt „keine“. Bis 7.21 gespeicherte Widgets haben `[]` und zeigen keine. Nichts zu zählen oder zu ändern.
8. Snippets mit `data-default-messages` am Skript: Das Attribut wirkt ab 7.22 nicht mehr, auch wenn im Design Center keine Liste gespeichert ist (E10 neu, E23, 7.22-rc17); es gilt die gespeicherte Liste, sonst gibt es keine Startvorschläge (Standard leer, E42). Bis 7.21 gespeicherte Widgets haben `[]` (alte Vorbelegung) und zeigen keine Startvorschläge. Vor dem Flotten-Rollout zählen, welche Kundenseiten das Attribut nutzen (F44, 7.22-rc16), und deren Liste im Design Center eintragen; erst danach auf 7.22 stellen.
9. Seiten mit eigener Kopie des Widgets (z. B. Demo `/widget/anythingllm-chat-widget.min.js`): auf das Widget ab 7.22-rc17 bringen, sonst fehlen die Startvorschläge (Listen als Array, E11), ohne gespeicherte Kurskarten-Wahl auch `displayMode` im Chat (R4), und Angaben der Gruppe A im Einbau-Code wirken dort weiter. Ab 7.22-rc13 ruft das Widget `/config?language=<Sprache>` auf: Eigene Demo-Kopien, die die `/config`-Antwort abfangen (z. B. die Topbar-Schalter der Demo in `app.js` und `next/app.js`), müssen die Adresse ohne Query vergleichen, sonst greifen ihre Schalter still nicht mehr (W41, 7.22-rc16). Seit E23 (7.22-rc17): Demo-Seite und Einbau-Paket vhs Rhein (`Kundendaten/Chatbot/demo_site/einbau_rhein/`) auf Pflicht- und Entwickler-Angaben kürzen; Gruppe-A-Angaben entfernen, Effekte und Inline-Feinheiten (Gruppe B) dürfen bleiben. Topbar-Schalter, die Design-Center-Optionen nachstellen, schreiben ihre Werte in die `/config`-Antwort statt in Attribute. Gilt auch für `praesentation` und `demo-inline`, die das Widget direkt vom Container laden: erst die Demo anpassen, dann auf 7.22 stellen.
10. Snippets mit Gruppe-A-Angaben am Skript (z. B. `data-theme`, `data-display-mode`, `data-position`, `data-chat-icon`, `data-button-color`, `data-greeting`, `data-privacy-notice`) und Seiten, deren CSS eine der fünf Variablen `--allm-accent`, `--allm-on-accent`, `--allm-user-bg`, `--allm-user-text` oder `--allm-link` setzt: Diese Angaben wirken ab 7.22 nicht mehr, auch wenn im Design Center dafür nichts gespeichert ist (E23, 7.22-rc17; ersetzt E18 aus 7.22-rc16). Es gilt das Design Center, gespeichert oder sein Standard. Vor dem Rollout je Kundenseite die Werte aus dem Einbau-Code mit dem Design Center vergleichen, im Seiten-CSS (eigene Stylesheets und `style`-Angaben der Seite) nach diesen fünf Variablen suchen und, wo der Kunde die Werte behalten will, im Design Center eintragen. Die Browser-Konsole hilft nur beim Einbau-Code: Verworfene Angaben dort meldet das Widget, Seiten-CSS übergeht es ohne Konsolenwarnung. Gruppe-B-Angaben (z. B. `data-inline-effect`, `--allm-radius`) wirken weiter.
11. Nur auf den Containern, die 7.16 bis 7.21.1 liefen (ki-helfer, intern, demo-inline, praesentation, entwicklung): gespeicherte `privacyText` nach dem Wort „Mitarbeitende“ durchsuchen und die Treffer je Container zählen (E30, 7.22-rc19). Bis 7.21.1 zeigte das Feld den Standardtext als Wert; wer ihn dort bearbeitet hat, hat ihn samt dem alten Standardpunkt gespeichert, und dieser Text bleibt nach 7.22 stehen. Der Standardtext lautet seit E30 „Mitarbeiter der Einrichtung können Gespräche zur Qualitätssicherung einsehen.“ Treffer nur melden; gespeicherte Texte der Kunden nicht ändern. Die Flotte (7.8) hatte diesen Standardtext nie.
12. Gespeicherte Farbwerte, die `parseColor` nicht liest oder die nicht deckend sind (E41, 7.22-rc22): je Container in `visual_config` die Werte von `accentColor` und `userTextColor` mit `parseColor` und auf Deckkraft unter 1 prüfen und die Treffer je Kunde zählen, z. B. `hsl()`, Farbnamen, Prozent, `#rgba`, `oklch()`, Systemfarben, `rgb()` mit gemischten Trennern oder geschützten Leerzeichen, `rgba()` mit Alpha unter 1 oder `#rrggbbaa` unter `ff`. Diese Widgets zeigen ab 7.22 die Standardfarbe (ab 7.22.2 `#007C82`, vorher `#01A5A9`) bzw. die Schrift nach Kontrast (Absatz unter der Tabelle „Darstellung“). Erwartet sind wenige oder keine Treffer, das Design Center hatte immer einen Farbwähler. Treffer nur melden; gespeicherte Werte der Kunden nicht ändern.
13. Begrüßungen mit eigenem Datenschutzinhalt, die keiner Vorlage aus `LEGACY_PRIVACY_GREETINGS` wortgleich entsprechen (E43, 7.22-rc24): Sie bleiben eigene Kundentexte. In 7.22 folgte ihnen die Datenschutz-Blase, ab 7.23 steht der Hinweis zusätzlich im Datenschutz-Fenster hinter dem Link „Datenschutz“. Je Container `greeting` und `greetingBubbleText` lesen und die Treffer je Kunde melden (Stand 22.10.2026: zwei Kunden, einer mit einer abgewandelten Juni-Vorlage, einer mit eigenen Einwilligungssätzen). Gespeicherte Texte der Kunden nicht ändern; der Kunde kürzt die Begrüßung im Design Center (abschalten lässt sich der Link ab 7.23 nicht). Wortgleiche Vorlagen (auch mit anderem Leerraum) brauchen nichts.
14. Datenschutz als Link in der Fußzeile (7.23, Nutzerentscheidung 23.10.2026): Nichts zu migrieren, gespeicherte Werte bleiben. Widgets mit `privacyNotice` `bubble` (Scan 23.10.2026: 3) zeigen statt der Blase den Link; Widgets mit eigenem `privacyText` (2) zeigen ihn im Fenster, dort einmal öffnen und prüfen. Einen Link zur Datenschutzerklärung (`privacyUrl`) hat kein Widget: Kunden auf das Feld „Link zur Datenschutzerklärung“ im Reiter Inhalt hinweisen. Seiten mit eigener Kopie des Widgets (Demo) brauchen das Widget ab 7.23, sonst zeigen sie den langen KI-Hinweis ohne Link.
