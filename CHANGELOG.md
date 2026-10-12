# Changelog - AnythingLLM (Kufer Fork)

Alle wichtigen Änderungen am AnythingLLM Server werden hier dokumentiert.

## [Unreleased]

### KIE-536 — Konversationen: Kennzahlen-Streifen und Säulendiagramm über die Zeit (2026-10-12)

- **Ansicht „Konversationen" neu aufgebaut** (`/settings/chatbot/conversations`), von oben nach unten: Kopfzeile mit Widget-Auswahl und Zeitraum, einzeilige Angabe zur Aufbewahrung, Kennzahlen-Streifen, Säulendiagramm, Konversationsliste. Die sechs farbigen Kacheln und der Kasten mit dem Verfallsdatum entfallen.
- **Neuer Endpunkt `POST /embed/:embedId/analytics/summary`** mit `{ fromDay, toDay }` (Kalendertage `YYYY-MM-DD`, beide einschließlich; der Server rechnet in Berliner Zeit, unabhängig von `TZ` und vom Browser). Antwort: `totals` (`messages`, `conversations`, `feedbackPositive`, `feedbackNegative`), `granularity` (`hour` | `day` | `week` | `month`), `buckets` (je Säule `start`, `end`, `messages`, `conversations`, `partial`; bei Stunden zusätzlich `hour`) und `firstLedgerDay`. Nur Zählwerte und Kalendertage, keine Inhalte. Prüfungen wie `analytics/overview` und die Konversationsliste: `DISABLE_VIEW_CHAT_HISTORY` (422), Nutzer mit Rolle `default` nur für Widgets ihrer Workspaces (403); dazu 404 für ein unbekanntes Widget. Ungültiger Zeitraum (kein Kalendertag, `fromDay` nach `toDay`, mehr als 92 berührte Kalendermonate – damit auch alles über 10 Jahre): 400, bevor das Zählerbuch gelesen wird.
- **Kennzahlen und Diagramm lesen das Zählerbuch** (KIE-532), beide aus derselben Antwort – die Summe der Säulen ist die Kennzahl. Die Statistik bleibt vollständig, wenn Konversationsinhalte nach der Aufbewahrungsfrist oder von Hand gelöscht wurden. **Die Zahlen können von den bisherigen Kacheln abweichen:** Das Zählerbuch zählt jede gespeicherte Nachricht (auch gelöschte und vom Besucher geleerte), „Konversationen" sind die im Zeitraum begonnenen. Ein umgehängtes Widget behält seine Zählwerte aus dem früheren Workspace.
- **Körnung nach Zeitraum:** ein einzelner Tag in 24 Stunden, sonst die feinste aus Tag, Kalenderwoche (Montag–Sonntag) und Monat mit höchstens 92 Säulen (`server/utils/helpers/ledgerTimeline.js`). Erste und letzte Woche bzw. Monat enden am Zeitraum und sind als angeschnitten gekennzeichnet („KW 42 – bis 12.10."). Monatsangaben sind in jeder Sprache gregorianisch und folgen ihrer Schreibweise („Oktober 2026", „2026年10月"). Der Monat ist die gröbste Körnung: Ein Zeitraum, der mehr als 92 Kalendermonate berührt, wird abgelehnt (400); „Gesamt“ reicht deshalb höchstens 92 Monate zurück (laufender Monat eingeschlossen).
- **Kennzahlen-Streifen** mit vier Feldern: Nachrichten (Ø je Säuleneinheit), Konversationen (Ø Nachrichten je Konversation), positiv bewertete Antworten (Anteil an den bewerteten), negativ bewertete Antworten mit „Betroffene Konversationen anzeigen" (setzt den Listenfilter 👎). Schmal 2 × 2. Die technischen Details für `admin` bleiben einklappbar, lesen weiter `analytics/overview` (jetzt erst beim Aufklappen) und nennen, dass sie nur die noch vorhandenen Inhalte auswerten.
- **Säulendiagramm** (eigenes SVG, keine neue Abhängigkeit): Schalter Nachrichten | Konversationen am Diagramm, „Als Tabelle" mit denselben Werten (markierbar, per Tastatur erreichbar), Tooltip bei Maus und Tastaturfokus („Di., 06.10.2026 — 37 Nachrichten"); es gilt die letzte Eingabe – der Mauszeiger auf einer Säule löst den Fokus ab (auch den, den ein Klick setzt), Tab und Pfeiltasten den Mauszeiger. Das Diagramm ist ein Tab-Stopp, die Pfeiltasten wechseln die Säule. Eine Akzentfarbe (`--theme-analytics-bar`: hell `#0284c7`, dunkel `#1a9bdc`), Text nie in der Säulenfarbe; gedämpfter Text über `--theme-analytics-text-muted` (hell `#5f6368`, weil `--theme-text-secondary` auf Weiß nur 4,2:1 erreicht).
- **Klick auf eine Säule filtert die Liste** auf Konversationen, deren erste vorhandene Nachricht in diesem Abschnitt liegt (Markierung „Nur <Abschnitt>" mit Schließen; nicht im Stundendiagramm). `POST /embed/:embedId/analytics/conversations` nimmt dafür optional `startedFromDay`/`startedToDay` an (Kalendertage, Berliner Zeit; ungültig → 400): Die Gruppierung läuft dann ohne Datumsfilter, die Bedingung greift auf `MIN(createdAt)` nach der Gruppierung. Ohne die beiden Felder antwortet der Endpunkt wie bisher.
- **Liste:** Kopfzeile nennt „N einsehbar" (Konversationen, deren Inhalte noch vorhanden und nicht geleert sind); reicht der betrachtete Abschnitt hinter die Aufbewahrungsfrist zurück, steht unter der Liste „Ältere Inhalte wurden gemäß Aufbewahrungsfrist gelöscht.". Filtern nach Bewertung, Blättern und Aufklappen unverändert. Bei 390 px stehen ID und Aufklapp-Symbol der Karten über dem Inhalt, die Seitenleiste scrollt in sich.
- **Standard-Zeitraum „Letzte 30 Tage"** (heute und die 29 Tage davor) statt „Diese Woche"; neue Vorauswahlen „Letzte 30 Tage" und „Letzte 12 Monate". Bei „Gesamt" beginnt das Diagramm am ersten Tag mit Zählwerten. Beginnt ein Zeitraum davor, nennt das Diagramm „Zählwerte liegen ab TT.MM.JJJJ vor".
- **Leerzustände:** kein sichtbares Widget → „Noch kein Widget vorhanden" mit Verweis auf „Widgets" (bisher blieb „Laden…" stehen); Widget ohne Zählwerte bzw. Zeitraum ohne Nachrichten → Hinweis im Diagrammrahmen, ohne Säulenplätze. Bei genau einem Widget entfällt die Widget-Auswahl.
- Keine Schemaänderung, keine Migration, keine neue Abhängigkeit. Das Zählerbuch wird nur gelesen; Schreibpfade, Kontingent und Nachtrag sind unverändert. Neue Texte in allen Sprachdateien (Deutsch und Englisch ausformuliert, sonst `null`).
- Tests: `server/__tests__/endpoints/embedAnalyticsSummary.test.js` (echte Route, echte SQLite-Datei, Löschjob), `server/__tests__/utils/helpers/ledgerTimeline.test.js`, `beginn_im_abschnitt` in `server/__tests__/models/embedChatsConversationFilter.test.js`; Frontend `frontend/__tests__/analyticsTimeline.test.mjs` (Zeitraum, Beschriftung, Kennzahlen, Geometrie), `embedAnalyticsView.test.mjs` (Diagramm, Kennzahlen-Streifen, Leerzustände, serverseitig gerendert) und `embedAnalyticsInteraction.test.mjs` (Tooltip mit Maus und Tastatur, Klick auf eine Säule, Anfragen an den Server). Der Test-Renderer rendert Komponenten jetzt auch mit Eigenschaften und hängt sie mit `mount()` in ein Dokument ohne Browser ein (Effekte laufen, Handler lassen sich aufrufen; `helpers/testDom.mjs`). Adresse und Rumpf der Anfragen stehen einmal in `server/__tests__/endpoints/support/embedAnalyticsRequests.js`; Frontend- und Server-Test prüfen beide dagegen.

### KIE-532 — Zählerbuch: Kontingent und Statistik unabhängig von Löschungen (2026-10-12)

- **Neue Tabelle `message_ledger`** (Migration `20261012150626_add_message_ledger`, dazu Index `embed_chats(embed_id, createdAt)`): eine Zeile je Workspace, Widget (`embed_id`, 0 = Workspace-Chat), Berliner Kalendertag und Berliner Stunde mit den Zählern `messages`, `copied`, `conversations_started`, `feedback_positive`, `feedback_negative`. Nur Zählspalten, keine Inhalte. Die Migration ist rein additiv (`CREATE TABLE`/`CREATE INDEX … IF NOT EXISTS`) und ändert keine bestehende Zeile.
- **Gezählt wird beim Anlegen der Chat-Zeile, in derselben Transaktion** (`MessageLedger.transaction` + `MessageLedger.record`, `server/models/messageLedger.js`). Chat-Zeile und Zähler entstehen gemeinsam oder gar nicht; scheitert die Transaktion, wird das Ereignis `message_ledger_write_failed` geschrieben. Zählregel unverändert: +1 je Chat-Zeile, auch bei `include = false`. Widget-Nachrichten zählen unter dem Workspace, dem das Widget beim Schreiben gehört.
- **Keine Löschung senkt den Verbrauch mehr:** Löschjob, „Chats löschen", einzelne Chats, Widget löschen, Nutzer löschen – das Zählerbuch bleibt. `messages` und `copied` sinken nie, es gibt keinen Codepfad dafür. **Widget umhängen verschiebt keinen Verbrauch** mehr.
- **Thread-Verzweigung zählt nicht mehr aufs Kontingent:** Kopien steigen in `copied`, nicht in `messages`. Vor dieser Änderung angelegte Kopien sind nicht erkennbar und bleiben gezählt.
- **Das Kontingent liest das Zählerbuch** (`countMessagesInDateRange`), sobald der Nachtrag als abgeschlossen markiert ist; bis dahin gilt die bisherige Live-Zählung. Danach dient die Live-Zählung nur dem Vergleich: Sind im Fenster mehr Chat-Zeilen vorhanden, als das Zählerbuch gebucht hat, wird `message_ledger_mismatch` geschrieben (höchstens einmal je Workspace und Stunde) – geliefert wird trotzdem das Zählerbuch. Bekannter Fehlalarm: ein in den Workspace umgehängtes Widget. Fenstergrenzen unverändert (`getBillingWindow`, KIE-531). Die Option `throwOnError` aus KIE-534 gilt auch für das Zählerbuch und die Markierung des Nachtrags: Sind sie nicht lesbar, wirft die Limitprüfung der Agent-Sitzung, statt 0 zu zählen oder still auf die Live-Zählung zurückzufallen; ohne die Option bleibt es bei 0 bzw. der Live-Zählung.
- **Nachtrag beim Start, vor Annahme von Anfragen** (`server/utils/boot/messageLedgerBackfill.js`): hält den höchsten Zeilenschlüssel beider Chat-Tabellen fest, trägt den Bestand bis dahin in Paketen nach und markiert den Abschluss in `system_settings` (`message_ledger_backfill`: Zustand, Wasserstand je Tabelle, Abschlusszeit). Wiederholbar und nach Abbruch fortsetzbar; der Stand jedes Workspaces ist danach exakt derselbe wie davor. Schlägt er fehl, startet der Server trotzdem (Ereignis `message_ledger_backfill_failed`, Kontingent weiter aus der Live-Zählung). Gemessen: 1,6 Mio. Chat-Zeilen (2,9 GB) in 19 s, mit kaltem Seiten-Cache 38 s. **Der Start des Containers dauert beim ersten Mal entsprechend länger.**
- **Bewertungen und Konversationen:** `updateFeedbackScore` bucht den Übergang auf die Stunde, in der die Nachricht entstand (nie unter 0, fremde Sessions ändern nichts). Stehen für Widget und Stunde Zeilen unter zwei Workspaces (in dieser Stunde umgehängt), wird eine Bewertung dort abgezogen, wo sie steht. `conversations_started` steigt, wenn es für `COALESCE(conversation_id, session_id)` im Widget noch keine Zeile gab.
- **Öffentlicher Bewertungs-Endpunkt** (`POST /embed/:embedId/:sessionId/feedback`): `chatId` muss eine positive ganze Zahl sein (sonst 400, ohne Datenbankzugriff). Die Chat-Zeile wird zuerst außerhalb der Reihe der Zählerbuch-Transaktionen gelesen; nur ein Treffer mit geänderter Bewertung öffnet eine Transaktion. Je Widget und Sitzung höchstens 30 Bewertungen je Minute, höchstens 32 Bewertungen gleichzeitig in der Reihe – darüber antwortet der Endpunkt mit **429** (`success: false`). Chat-Speicherungen werden nie abgewiesen.
- **Absicherung der Migration:** `docker-entrypoint.sh` ruft nach `prisma migrate deploy` `server/scripts/ensure-message-ledger.js` auf (führt die Anweisungen der Migration idempotent aus, braucht kein `sqlite3` im Image, nie fatal).
- **Parallele Schreibzugriffe:** `server/utils/prisma/engineThreads.js` setzt `TOKIO_WORKER_THREADS` für die Query-Engine auf mindestens 2 × Kerne + 2 (mehr Arbeits-Threads als Verbindungen; der Pool der Engine hat 2 × physische Kerne + 1); Zählerbuch-Transaktionen eines Prozesses laufen nacheinander. Ohne beides blockieren wartende Schreiber die offene Transaktion bis zum Busy-Timeout (gemessen auf 4 Kernen ab 8 parallelen Anfragen). Der Server nimmt die Variable nach dem Nachtrag wieder zurück (die Engine behält ihre Threads), damit sie nicht für LanceDB gilt, das erst mit den Anfragen lädt. Der Job `sync-watched-documents` (eigener Prozess, lädt ebenfalls LanceDB) nimmt sie nach seiner ersten Abfrage zurück. **Ein vom Betrieb gesetzter Wert gilt für die Engine nur, wenn er dieses Minimum erreicht:** Ein kleinerer oder ungültiger Wert wird für die Engine ersetzt, eine Konsolenwarnung nennt beide Werte (gemessen: mit dem Wert 2 steht der Server unter Last über 90 s still); für später ladende Module gilt danach wieder der Wert des Betriebs. Batch-Transaktionen (`prisma.$transaction([…])`) sind für Schreibpfade unzulässig und per Quelltext-Test gesperrt (Prisma 6.14 lässt mit SQLite nach einem fehlgeschlagenen COMMIT die Verbindung mit offener Transaktion zurück); die vier Aufrufe aus dem Upstream-Bestand (`workspaceUsers`, `passwordRecovery`, `vectors`) sind als Ausnahmen benannt und unverändert.
- **Selbsttest der Query-Engine beim Start** (`server/utils/boot/messageLedgerEngineCheck.js`), nach dem Nachtrag und vor Annahme von Anfragen: Die Arbeits-Threads müssen über der Poolgröße liegen, die die Engine beim Verbinden selbst nennt (`Starting a sqlite pool with N connections`, mitgelesen ohne Änderung am Logging); dazu laufen auf einer temporären SQLite-Datei so viele interaktive Transaktionen gleichzeitig, wie der Pool Verbindungen hat (höchstens 7: jeder weitere wartende Schreiber verlängert auch den bestandenen Lauf), plus 3, mit je zwei Rundläufen und einer Zeitgrenze von 1,5 s. Die Transaktionen nehmen die Schreibsperre, ändern aber keine Zeile: Der gemessene Lauf schreibt nicht auf die Platte, eine langsame Platte löst deshalb keinen Alarm aus (mit ändernden Transaktionen rund 40 `fsync` und ein Fehlalarm ab etwa 40 ms je `fsync`). Bestanden dauert das rund 0,06 s (5 Verbindungen). Nicht bestanden: Konsolenfehler und neues Ereignis `message_ledger_engine_check_failed` (`reason`: `threads_not_above_pool`, `transactions_timed_out`, `transactions_failed` oder `check_error`, wenn sich der Test nicht ausführen ließ; dazu Poolgröße und Thread-Zahl) – der Server startet trotzdem. Abhilfe: `TOKIO_WORKER_THREADS` über die Zahl der Verbindungen setzen. Ein nicht bestandener Lauf verzögert den Start um einige Sekunden (bis die stehenden Transaktionen enden, höchstens 10 s). Im Storage entsteht keine Datei, die Datenbank des Servers wird nur für das Ereignis angefasst.
- **Ereignisse für den Tagesbericht:** `message_ledger_write_failed`, `message_ledger_mismatch`, `message_ledger_backfill_failed`, `message_ledger_engine_check_failed` (Selbsttest der Query-Engine beim Start), `message_ledger_marker_recovered` (Markierung des Nachtrags fehlte bei gefülltem Zählerbuch; es wird dann nicht ein zweites Mal nachgetragen). Die Ereignisse enthalten keine Inhalte von Nachrichten. `message_ledger_write_failed` wird je Quelle, Workspace bzw. Widget und Stunde höchstens einmal geschrieben; das nächste Ereignis nennt unter `suppressed`, wie viele Fehler dazwischen nicht gemeldet wurden (in der Konsole steht jeder). Als gemeldet gilt ein Fehler erst, wenn sein Ereignis im Protokoll steht: Lässt es sich nicht schreiben (etwa bei derselben Schreibsperre), versucht es der nächste Fehler erneut, sonst der Server nach 60 s. Was in einer Stunde nach dem Ereignis noch scheitert, wird mit dem Stundenwechsel nachgereicht. Nachgereichte Ereignisse tragen `deferred: true` und `lastFailureAt` (Zeitpunkt des letzten Fehlers); offene Meldungen stehen nur im Speicher des Prozesses.
- **Für den Rollout:** `quota-snapshot.js snapshot --mode current` vor der Migration, `snapshot --mode current --source ledger` nach Migration und Nachtrag, `compare-ledger` muss für jeden Workspace „identisch" melden (sonst Status 1). Auf einem weiterlaufenden Container lässt sich der Stand der Stunde von `--now` nicht bestimmen, wenn danach in dieser Stunde ein Thread verzweigt oder eine späte Chat-Zeile gelöscht wurde („nicht auswertbar" bzw. „abweichend") – dann auf einem eingefrorenen Stand wiederholen. `quota-snapshot.js --deleted-report` listet je Workspace die im laufenden Fenster protokollierten Löschmengen als Vorschlag für eine manuelle Abbuchung (bucht nichts). `ledger-resync.js --from=<YYYY-MM-DD>` hebt nach einem Rollback auf ein älteres Image die Stunden ab dem Datum auf den Stand der vorhandenen Zeilen an (senkt nie). Ein älteres Image startet auf der migrierten Datenbank ohne Fehler (`prisma migrate deploy`: „No pending migrations"), zählt aber nicht.
- Tests gegen eine echte SQLite-Datei aus den Migrationen (`server/__tests__/helpers/sqliteTestDatabase.js`), grün in `TZ=UTC`, `Europe/Berlin` und `America/New_York`. Keine neue Abhängigkeit, keine Änderung an Rollen- oder Rechteprüfungen.

### KIE-533 — Kontingent: Umgehungen über Rollen geschlossen (2026-10-12)

- **Limit, Zyklusstart und Zyklusdauer ändert über die Oberfläche nur noch `admin`.** `POST /workspace/:slug/update` verwirft für alle anderen jetzt auch `cycleStartDate` und `cycleDurationMonths` (bisher nur `messagesLimit`); ein Manager konnte den Verbrauch über einen neuen Zyklusstart auf 0 setzen. Die Abrechnungsansicht zeigt die drei Felder für Manager gesperrt. Wie bisher schon beim Limit gilt das auch ohne Mehrbenutzermodus: Dort ändert nur die API mit Schlüssel. **Kunden mit Rolle `manager`, die den Zyklus bisher selbst gepflegt haben, wenden sich an Kufer.**
- **Workspaces legt nur noch `admin` an:** `POST /admin/workspaces/new` antwortet für `manager` mit 403 (ein neuer Workspace hat kein Limit).
- **Widget-Endpunkte sind an den Workspace gebunden.** Ändern, Löschen, Logo hochladen/entfernen, einzelnen Chat löschen und `analytics/overview`: Ein Nutzer mit Rolle `default` braucht die Mitgliedschaft im Workspace des Widgets, sonst 403 (auch für ein unbekanntes Widget). Anlegen und Umhängen (`workspace_id`) nur in einen Workspace, auf den er selbst Zugriff hat. `admin` und `manager` sind nicht eingeschränkt; ohne Mehrbenutzermodus wird nicht geprüft. `DELETE /embed-chats/clear/:embedId` bleibt `admin`/`manager` vorbehalten und antwortet für `default` jetzt mit 403 statt 401. Auch die einzelne Konversation (`GET /embed/:embedId/conversation/:sessionId`) ist so gebunden – 403 ohne Inhalte für ein fremdes Widget – und beachtet wie die Konversationsliste `DISABLE_VIEW_CHAT_HISTORY` (422).
- `POST /embed/:embedId/analytics/overview` beachtet `DISABLE_VIEW_CHAT_HISTORY` (422) und zählt wie die Konversationsliste nur `include = 1`. **Die Zahlen können dadurch kleiner ausfallen als bisher.**
- **Sammel-Export aller Widget-Chats nur für `admin`:** `GET /system/export-chats?chatType=embed` antwortet für `manager` und `default` mit 403; die Schaltfläche ist für sie ausgeblendet. Der Export der Workspace-Chats ist unverändert.
- **Ungültige Abrechnungswerte werden mit 400 abgelehnt statt umgedeutet** (`POST /v1/workspace/:slug/update`, `POST /v1/workspace/new`, Oberfläche): `messagesLimit` ganze Zahl ≥ 0 oder `null`; `cycleDurationMonths` aus 1, 2, 3, 4, 6, 12 oder `null` und nur zusammen mit einem Startdatum (gesendet oder gespeichert); `cycleStartDate` als ISO-Datum zwischen 2020-01-01 und heute + 5 Jahre oder `null`. Antwort: `{ workspace: null, message, errors: { <Feld>: <Meldung> } }`, gespeichert wird dann nichts. Bisher wurde z. B. `"abc"` oder `-1` zu unbegrenzt, `"10.000"` zu 10 und eine Dauer von 5 zu einem Monat. Gültige Aufrufe antworten wie zuvor; `null`, `""` und Zahlen als Zeichenkette (`"500"`) gelten weiter. **Wer nur das Startdatum entfernt, muss die Dauer mit auf `null` setzen.** Ebenfalls abgelehnt werden Schreibweisen, die bisher durchliefen: ein Datum ohne führende Nullen, mit Schrägstrichen oder Punkten (`2026-9-1`, `2026/09/01`, `01.09.2026`) und Zahlen mit Vorzeichen, Punkt oder Zusatz (`+500`, `500.0`, `1.000`). Bei getrennten Aufrufen zuerst das Startdatum, dann die Dauer senden.
- Bestandswerte bleiben stehen: Ein Wert, der unverändert zurückgesendet wird, wird nicht geprüft; Lesen, Chatten und das Speichern anderer Felder scheitern nicht an einem Altwert. Beim Startdatum gilt auch der reine Berliner Kalendertag des gespeicherten Werts als unverändert – der Tag, ab dem abgerechnet wird; so zeigt und sendet ihn die Abrechnungsansicht (bisher der UTC-Tag, der bei einem Zeitpunkt am späten UTC-Abend wie `2026-09-01T00:00:00+02:00` einen Tag zu früh lag). Der gespeicherte Zeitpunkt bleibt dann stehen. Jeder andere Tag ist eine Änderung des Zyklusstarts und wird geprüft und gespeichert.
- **`messagesLimit = 0` heißt überall „gesperrt", `null` „unbegrenzt"** – jetzt auch in `cycleHelpers` (`isCycleLimitReached`, `messagesRemaining`) und in der Abrechnungsansicht (bisher dort wie unbegrenzt behandelt).
- Keine Schemaänderung, keine Migration; Zählung und Fenstergrenzen unberührt.

### KIE-534 — Kontingent: Limitprüfung für `@agent` im GUI-Chat (2026-10-12)

- `@agent` umging das Nachrichtenlimit. Jetzt prüft `stream.js` das Limit vor dem Start einer Agent-Sitzung, und der Agent-WebSocket prüft es vor jeder weiteren Nutzernachricht. Am Limit erscheint dieselbe Meldung wie im normalen Chat; es entsteht keine Sitzung und keine Chat-Zeile.
- Der Workspace wird je Prüfung frisch geladen (ein geändertes Limit gilt sofort); die Prüfung wartet, bis die vorige Antwortzeile gespeichert ist.
- Kann der Verbrauch nicht gezählt werden, endet die Agent-Sitzung mit einer neutralen Meldung, statt mit Verbrauch 0 weiterzulaufen. Die Zählfunktionen kennen dafür die Option `throwOnError` (Standard `false`); normaler Chat, Embed und API verhalten sich unverändert.
- Ein Bail-Kommando (`exit`) während des Sitzungsstarts beendet die Sitzung ohne Agent-Start und ohne Verbrauch. Bisher beendete ein solcher Frame vor dem Aufbau der Agent-Laufzeit den Serverprozess.
- Keine Schemaänderung, keine neue Abhängigkeit. Weitere Absturzwege über fehlerhafte WebSocket-Frames (Bestand aus dem Upstream-Code): KIE-540.

### KIE-531 — Kontingent: ein einheitliches Zyklusfenster in Berliner Zeit (2026-10-12)

- Eine Funktion bestimmt das Abrechnungsfenster: `getBillingWindow` (`server/utils/helpers/billingWindow.js`). Fenster = `[Start 00:00 Berliner Zeit, nächster Start 00:00 Berliner Zeit)`, ausdrücklich `Europe/Berlin`, unabhängig von `TZ` des Containers. Zählung, Gutschriften/Abbuchungen, API und Abrechnungsansicht verwenden sie.
- **Keine Lücke mehr am Zykluswechsel:** Bisher zählten Nachrichten und Buchungen am Reset-Tag zwischen 00:00 Uhr und 01:00/02:00 Uhr Berliner Zeit in keinem Zyklus. Sie zählen jetzt im neuen Zyklus.
- **Der Reset-Tag wandert nicht mehr:** Start am 29.–31. fällt jeden Zyklus auf den Originaltag, soweit der Monat ihn hat (31.01. → 28.02., 31.03., 30.04. …). Bisher blieb er nach dem ersten kurzen Monat auf dem 28. hängen. **Betroffene Workspaces sehen ein anderes Reset-Datum.**
- **Zyklusstart in der Zukunft:** Bis zum Starttag gilt der Berliner Kalendermonat mit dem gesetzten Limit (bisher zählte bis dahin nichts); mit dem Starttag beginnt der erste Zyklus bei 0. `cycleInfo` der API ist bis dahin `null`.
- API-Felder unverändert in Name und Typ. `currentCycleStart`, `currentCycleEnd` (letzter Tag des Zyklus) und `nextReset` sind Tagesmarken: 00:00 UTC des Berliner Kalendertags, das ISO-Datum nennt also immer den richtigen Tag. `daysRemaining` zählt Kalendertage bis zum Reset.
- Keine Schemaänderung, keine neue Abhängigkeit. Zählquelle bleibt die Live-Zählung (Zählerbuch: KIE-532).
- **Abrechnungsansicht rechnet nicht mehr selbst:** `GET /workspace/:slug/usage` liefert zusätzlich `resetInfo` (`nextReset`, `daysRemaining`) für das laufende Fenster, auch im Kalendermonat und vor dem Zyklusstart – dieselben Werte wie die Sperrmeldung. Kunden- und Admin-Ansicht zeigen sie an; beginnt der erste Zyklus im laufenden Monat, ist der genannte Reset der Starttag. Die ungenutzte Altkomponente `CycleSettings` ist entfernt.
- Die Limit-Meldung des OpenAI-kompatiblen Pfads wird aus demselben Fenster gebildet (`getWorkspaceMessageLimitErrorText`), nicht mehr aus dem Kalendermonat des Prozesses.
- **Vor dem Rollout:** `server/scripts/quota-snapshot.js` (ohne laufenden Server gegen die SQLite-Datei) erstellt je einen Schnappschuss mit den bisherigen (`--mode legacy --legacy-tz <TZ des Containers>`) und den neuen Grenzen (`--mode current`), beide mit demselben `--now`; `compare` nennt je Abweichung die Ursache, listet Workspaces, die durch die neuen Grenzen ihr Limit erreichen, und endet bei einem unerklärten Unterschied mit Status 1. Eine eigene Liste nennt die Workspaces mit Starttag 29.–31., deren Zyklusstart oder nächster Reset wegen der bisherigen Klemmung auf einen anderen Tag fällt, auch bei unverändertem Stand. `compare` nimmt nur `legacy` → `current` mit demselben `--now` an; jede andere Paarung endet mit Status 2.
- Tests in drei Zeitzonen: `yarn test:tz` (bzw. `cd server && yarn test`) lässt Jest mit `TZ=UTC`, `Europe/Berlin` und `America/New_York` laufen; die CI verwendet diesen Aufruf.

### KIE-535 — Navigation: Obermenüpunkt „Chatbot" statt „Werkzeuge → Chat-Widgets" (2026-10-12)

- Einstellungs-Sidebar: neuer erster Block **Chatbot** mit **Widgets**, **Konversationen**, **Nachrichtentabelle** (vorher „Werkzeuge → Chat-Widgets" mit innerer Auswahlspalte „Widgets / Konversationen (neu) / Verlauf (klassisch)").
- Jede Ansicht hat eine eigene Adresse: `/settings/chatbot/widgets`, `/settings/chatbot/conversations`, `/settings/chatbot/messages`. Die alte Adresse `/settings/embed-chat-widgets` leitet auf die Widget-Liste um.
- Die Ansichten nutzen die volle Inhaltsbreite (linksbündig, höchstens 1180 px); die zweite Auswahlspalte und der mobile Zwischenschritt Liste → Vollbild entfallen. Inhalte der drei Ansichten unverändert.
- „Widgets" hängt nicht mehr am einsehbaren Chat-Verlauf (`DisableViewChatHistory`); „Konversationen" und „Nachrichtentabelle" weiterhin — ohne das Recht leiten ihre Adressen auf die Widget-Liste um.
- Kundennutzer (`default`) landen über das Einstellungssymbol auf „Konversationen" (bei abgeschaltetem Chat-Verlauf auf „Widgets").
- Das Design Center (`/settings/embed-config/:embedId/appearance`) bleibt eine Vollbildseite ohne Einstellungs-Sidebar (Einstellungen und Vorschau behalten ihre Breite); „Zurück" und der Rücksprung nach einem Ladefehler führen auf `/settings/chatbot/widgets`.
- Erste Frontend-Tests unter `frontend/__tests__/` (Node-Test-Runner, über `yarn test` mit ausgeführt): Sidebar-Zustand auf den drei Chatbot-Adressen, Design Center ohne Sidebar und mit beiden Rücksprüngen auf die Widget-Liste.
- Reines Frontend, keine Server- oder Datenbankänderung. Übersetzungen: neue Menünamen in allen Sprachdateien; die 421 Fork-Schlüssel, die in 21 Sprachdateien fehlten, stehen dort jetzt als `null` (Rückfall auf Englisch wie bisher), `verify:translations` ist grün.

### Auswahlstufe hinter dem Reranker — frühester Kurs bei Gleichstand, entfernt nie einen Kurs, höchstens eine Übersichtsseite (2026-10-08)

- Neue Nachstufe `contextSelection.js` in den Modi `rerank`/`hybrid_rerank`: Reranker-Pool `topK = max(topN, 12)`; die 2 relevantesten Kurse bleiben, weitere Kursplätze gehen bei Score-Gleichstand (Band 0,1, Boden 0,3) an den früher startenden Kurs; die Stufe entfernt nie einen Kurs — gestartete Kurse mit `bookable = false` sind Wartelisten-Kurse (Kufer-Status 4), bleiben in der Auswahl, wenn der Score sie dorthin trägt, rücken aber nie als „früher“ nach; bei klaren Kursfragen höchstens 1 Übersichtsseite. Reihenfolge bleibt Reranker-Reihenfolge.
- SystemSetting `course_selection` (Standard **an**, wirkt nur mit Kursspalten), Env `COURSE_SELECTION_KEEP/BAND/FLOOR`; Search-Trace-Block `selection`.
- Schalter aus / ohne Kursspalten / ohne Reranker-Scores: Ergebnis byte-gleich zum Stand davor (Snapshot-Tests gegen master).

### 7.8 — Metadatenfilter Standard an, Ortsliste nur Pipeline, LanceDB-Versionen 1 Tag (2026-09-30)

- `metadata_filters` ist ohne gespeicherten Wert **an** (vorher aus). Tabellen ohne Kursspalten (`start_date`) überspringen den Normalisierer-LLM-Aufruf (Schema-Check, 10 min gecacht). Abschalten auch mit `false`/`"OFF"`/`"0"`.
- Einstellungsseite „Suche & Retrieval" zeigt `metadata_filters` und `search_trace` jetzt mit dem gespeicherten Wert (vorher immer „aus", Speichern überschrieb den Wert). Das Eingabefeld der Ortsliste ist entfernt — `metadata_filter_locations` pflegt die Crawler-Pipeline (`sync_metadata_locations.py`, nächtlich).
- LanceDB `optimize()` räumt alte Tabellenversionen nach **1 Tag** statt 7 auf (`versionRetention.js`, auch im FTS-Backfill); die vor 10 min aktuelle Version bleibt für laufende Suchen erhalten. Vorher wuchsen Tabellen mit stündlichen Kurs-Updates auf > 60 GB.

### Search-Traces — vollständige Hybrid-/Reranker-Metriken (2026-07-08)

**Opt-in** per SystemSetting `search_trace` (off | on | full; GUI: Suche & Retrieval → Erweitert). Pro Suche eine JSONL-Zeile (`storage/search-traces/`): beide Arme (Latenz/Count/Top-Scores), RRF-Fusion (α, Arm-Herkunft), Reranker (Latenz, Degradation) und finale Dokumente mit Rang-Verschiebung (RRF→final). Datenschutz: Docs nur als id/title/Scores; Query-Text nur bei `full`. Auswertung: `searchTraceReport.js` (Latenz-Perzentile, Degradations-Rate, Reranker-Rettungen, BM25-Beiträge). Non-throwing, fire-and-forget — Ergebnis-Neutralität im Manual-Test belegt.

### KIE-480 — Metadaten-Filter: Zeit, Preis, Status, Format, Ort (2026-07-07)

**Opt-in** per SystemSetting `metadata_filters` (Default aus) + `metadata_filter_locations` (Standort-Whitelist, GUI: Settings → Suche & Retrieval).

- **Deterministischer deutscher Extraktor** (P0-Eval-Sieger: 68/68 Gold-Fälle; LLM-Arme 98,6 %/95,8 % — einziger Fehler: Kalender-Arithmetik) erkennt harte Bedingungen („dieses Quartal", „unter 50 €", „noch buchbar", „nur online", Orte nur aus Whitelist) auf der umgeschriebenen Query — 0 ms, keine zusätzlichen LLM-Calls.
- **`.where()`-Vorfilter** auf beiden Hybrid-Armen und in allen 4 Suchmodi; Injection-sicher (Whitelist/Escaping); Alt-Tabellen ohne Spalten → ungefilterter Fallback.
- **Gestufter Leere-Treffer-Fallback**: Voll → ohne Zeitbedingungen → ungefiltert, mit explizitem Hinweis an das LLM (nur Kontext, nie erfundene Quelle) — „im angefragten Zeitraum nichts, aber ab Oktober …".
- **Ingestion**: Kurs-Metadaten fließen vom Crawler (Pipelines-Branch `kie-480-metadaten-extractor`) über die Collector-Whitelist als flache LanceDB-Spalten; bestehende Tabellen migrieren automatisch per `addColumns` (typisierte NULLs, kein Re-Embedding).

### KIE-478 — LanceDB 0.31 + N-Gram-FTS für Deutsch (2026-07-07)

- **`@lancedb/lancedb` 0.15.0 → 0.31.0** (apache-arrow 19 → 18.1 wegen Peer-Range); alle drei Manual-Harnesse (9/9, 10/10, 7/7) und Jest-Baseline (191/195) grün gegen die neue Binary.
- **FTS-Tokenizer auf N-Gram (Trigramme)** umgestellt — „Yogakurs" findet „Yogakurse" (Komposita!), „Kurs" findet Flexionsformen, Kursnummern bleiben Top-Treffer. Zentrale Config in `ftsConfig.js` (geteilt von Ingestion + Backfill). Gemessen: 5000 Chunks ≈ 8,7 MB, FTS-Query ≈ 3 ms.
- **`backfillFtsIndex.js --rebuild`**: einmalige Tokenizer-Migration bestehender Indexe (replace, additiv — Vektoren/Zeilen unangetastet). Nach dem Deploy einmal pro Container ausführen.



### 🔍 Hybrid Search (Vektor + BM25) & konfigurierbarer externer Reranker (KIE-471)

**Additiv und per-Workspace opt-in.** Wenn `RERANKER_PROVIDER` nicht gesetzt ist und kein Workspace seinen Suchmodus ändert, bleibt das Verhalten identisch zum Upstream (reine Vektorsuche, optionaler eingebauter Native-Reranker). Bestehende Installationen ändern sich erst, wenn das Feature explizit aktiviert wird. Keine Prisma-Migration (die Spalte `vectorSearchMode` existiert bereits).

#### Hinzugefügt

- **Vier Suchmodi pro Workspace** (`vectorSearchMode`, nur LanceDB):
  - `default` — reine Vektorsuche (unverändert)
  - `hybrid` — gewichtete RRF-Fusion aus Vektor- und BM25-Keyword-Arm (`score = alpha/(k+rank_vec) + (1-alpha)/(k+rank_fts)`, `k=60`, `alpha=hybrid_weight`, Default 0.7)
  - `rerank` — Vektorsuche, dann Reranking
  - `hybrid_rerank` **(empfohlen)** — Union beider Arme, dedupe, dann entscheidet der Reranker; RRF nur als Fallback bei Reranker-Ausfall
- **Externer Reranker** (`server/utils/EmbeddingRerankers/generic/index.js`): HTTP-Client mit zwei Wire-Formaten — Cohere-kompatibel (LiteLLM, vLLM `/rerank`, Cohere, Jina, Infinity, Voyage) und TEI (HuggingFace Text-Embeddings-Inference, Bare-Array-Antwort). Factory `getRerankerProviderSelection()` schaltet über `RERANKER_PROVIDER`; ohne Wert wird der `NativeEmbeddingReranker` verwendet.
- **Graceful Degradation**: Bei jedem Fehler (8s-Timeout, Non-200, Malformed) werden die Dokumente unverändert (Vektor-/RRF-Reihenfolge) zurückgegeben — der Reranker wirft nie in den RAG-Pfad.
- **Globale ENV-Vars** (`RERANKER_PROVIDER`, `RERANKER_BASE_PATH`, `RERANKER_MODEL_PREF`, `RERANKER_API_KEY`) — auto-persistiert über die Admin-GUI; `RERANKER_API_KEY` wird in `currentSettings()` nur als Boolean maskiert.
- **Globale SystemSettings**: `vector_search_default`, `hybrid_weight` (0–1), `reranker_retrieval_topk` (1–100, Default 40), `reranker_instruction`.
- **Admin-GUI** (Settings → Search & Retrieval): globales Hybrid-/Reranker-Formular mit Progressive Disclosure; Workspace-Dropdown mit allen vier Modi (LanceDB-Guard). Hinweis: Workspace-Wert `default` bedeutet „folgt dem globalen Modus" — ein Opt-out auf reine Vektorsuche bei aktivem globalen Nicht-Default-Modus ist ohne Migration nicht möglich.
- **FTS-Index-Backfill** für bestehende LanceDB-Collections: `node server/utils/vectorDbProviders/lance/backfillFtsIndex.js [--dry-run]` (idempotent, read-safe).
- **Operator-Dokumentation**: `server/HYBRID_SEARCH_RERANKER.md` (4 Modi, RERANKER_*-Vars, Reranker-Container-Setup für vLLM/TEI, Shared-Container, deutsche Stemming-Grenze).
- **Eval-Harness-Skeleton** (TODO): `server/__tests__/utils/vectorDbProviders/searchModeEval.eval.js` — vergleicht default/hybrid/rerank/hybrid_rerank auf einem Query-Set (Query-Set + Reranker-Endpoint noch zu verdrahten, läuft absichtlich noch nicht).

#### Bekannte Einschränkung

- **Deutsches Stemming ist auf `@lancedb/lancedb` 0.15.0 ein No-Op.** Der BM25-Index nutzt nur `lowercase` + `asciiFolding`; `"Kurs"` matcht nicht `"Kurse"`. Hybrid hilft daher v.a. bei exakten Tokens (Kursnummern, Dozenten-Namen, Daten, Akronyme), nicht bei morphologischen Varianten. Details in `server/HYBRID_SEARCH_RERANKER.md`.

## [4.1.0] - 2026-02-23

### 📅 DateRange-Picker für Analytics Dashboard

**Problem gelöst:** Die bisherigen Zeitfilter ("Letzte Woche", "Letzter Monat", "Gesamt") waren **rollende Zeitfenster** - "Letzter Monat" änderte sich buchstäblich jede Stunde. Systematisches Abarbeiten (z.B. alle Konversationen vom Januar) war damit unmöglich.

#### Hinzugefügt

- **📅 DateRangePicker-Komponente** (`frontend/src/components/DateRangePicker/index.jsx`)
  - Chatbase-inspiriertes Design: Trigger-Button mit Kalender-Icon + Datumsbereich-Text
  - Popover mit Preset-Dropdown + Dual-Kalender (2 Monate nebeneinander)
  - "Anwenden"-Button für manuelle Kalenderauswahl
  - Click-outside schließt Popover ohne Änderung
  - Library: `react-day-picker` v9 mit deutscher Locale

- **🗓️ Feste Kalender-Presets** (keine rollenden Fenster mehr!):
  - Heute, Gestern, Diese Woche (ab Montag!), Dieser Monat, Letzter Monat, Gesamt
  - "Dieser Monat" = 1. bis heute, "Letzter Monat" = voller Vormonat

- **🎨 Theme-Overrides** für react-day-picker (Dark + Light Mode)
  - CSS-Variablen nutzen bestehende `--theme-*` Farben
  - Ausgewählte Range in Theme-Akzentfarbe

- **🌍 Translations**: Neue `date-picker.*` Keys (DE + EN)

- **📋 Browser-Testanweisung** (`BROWSER-TEST-DATEPICKER.md`): 15 GUI-Testfälle

#### Geändert

- **EmbedAnalyticsView**: State von `dateRange: "week"|"month"|"all"` auf `startDate/endDate` (Date-Objekte) umgebaut
  - `getDateRange()` Funktion entfernt
  - ISO-Strings als stabile useEffect-Dependencies
  - Default: "Dieser Monat" statt "Letzte Woche"

- **ConversationList**: Props von `dateRange`/`getDateRange` auf `startDate`/`endDate` (ISO-Strings) umgestellt
  - Pagination resettet auf Seite 1 bei Datumswechsel

- **CLAUDE.md**: Screenshot-Referenz-Pfade und Excalidraw-Export-Konventionen hinzugefügt

#### Entfernt

- Alte Translation-Keys `embed-analytics.last-week` und `embed-analytics.last-month`
- `getDateRange()` Funktion (ersetzt durch DateRangePicker-Presets)

#### Geänderte Dateien

| Datei | Aktion |
|-------|--------|
| `frontend/src/components/DateRangePicker/index.jsx` | **NEU** |
| `frontend/src/pages/.../EmbedAnalytics/index.jsx` | State-Umbau |
| `frontend/src/pages/.../EmbedAnalytics/ConversationList.jsx` | Props-Anpassung |
| `frontend/src/locales/de/common.js` | Translations |
| `frontend/src/locales/en/common.js` | Translations |
| `frontend/src/index.css` | CSS-Overrides |
| `frontend/package.json` | react-day-picker |
| `CLAUDE.md` | Konventionen |

---

## [4.0.0] - 2026-02-22

### 📊 Analytics Edition - Enhanced Metrics & Pagination

---

## [2.9.0] - 2026-02-22

### 🎯 Conversation ID Tracking & RAG Context Fix (Major Feature)

**Problem gelöst:** RAG Context enthielt vorher ALLE Nachrichten einer Session (auch aus alten Besuchen). Jetzt enthält der Context nur noch Nachrichten der AKTUELLEN Konversation.

#### Hinzugefügt

**Backend:**
- **📊 Conversation ID System**: Neues Feld `conversation_id` in `embed_chats` (UUID v4)
  - Database Migration: Automatische Backfill aller 27 bestehenden Chats mit `conversation_id = session_id`
  - Index auf `conversation_id` für Performance
  - Backwards kompatibel: Alte Chats ohne `conversation_id` funktionieren weiter

- **🎯 RAG Context Fix**: Backend nutzt jetzt `conversation_id` statt `session_id` für History-Retrieval
  - `recentEmbedChatHistory()` filtert nach Konversation statt Session
  - `forEmbedByUser()` unterstützt beide Identifier-Typen ('session_id' / 'conversation_id')
  - **Resultat:** Alte, irrelevante Nachrichten erscheinen nicht mehr im RAG Context!

- **🔌 Neue API-Endpunkte**:
  - `POST /embed/chats/conversations` - Globale Konversations-Liste (gruppiert nach conversation_id)
  - Workspace-Filtering für Rollen-basierte Zugriffskontrolle
  - Pagination Support (offset, limit)

**Frontend (Admin-UI):**
- **🗂️ Konversations-Gruppierung**: Neue Karten-Ansicht statt Flat-Liste
  - Jede Konversation als eigene Karte mit Preview-Text (erste Nachricht, 100 Zeichen)
  - Workspace-Name prominent angezeigt
  - Nachrichtenanzahl pro Konversation

- **🆕 "NEU" Badge**: Grüner Badge für Konversationen mit letzter Nachricht <1 Stunde
  - Badge-Style: `🆕 NEU` mit grünem Hintergrund & Border
  - Automatische Anzeige basierend auf `last_message_at` Timestamp

- **📅 Beide Zeitstempel**:
  - "Erstellt: DD.MM.YYYY, HH:MM:SS Uhr" (absolutes Datum)
  - "Letzte Nachricht: vor X Minuten/Stunden/Tagen" (relative Zeit)
  - Deutsche Formatierung: `formatDateTimeDE()` + `timeAgo()` Funktion

- **🔽 Expandable Details**: Klick auf Karte lädt alle Nachrichten der Konversation
  - User-Prompts & AI-Antworten chronologisch
  - Zeitstempel pro Nachricht
  - Collapse beim 2. Klick

**Widget (Embed):**
- **🎲 UUID v4 Generation**: Widget generiert conversation_id client-seitig
  - Hook: `useConversationId()` mit LocalStorage-Persistenz
  - Format: RFC 4122 UUID v4 (z.B. `f47ac10b-58cc-4372-a567-0e02b2c3d479`)
  - Nicht mehr: `Date.now() + Math.random()` (collision-unsafe)

- **🔄 Reset-Funktionalität**: "Clear Chat" generiert neue conversation_id
  - `resetConversationId()` löscht alte ID aus LocalStorage
  - Neue UUID wird generiert und gespeichert
  - Nächste Nachricht startet neue Konversation (eigener RAG Context!)

- **📤 Backend-Integration**: conversation_id wird an Backend gesendet
  - `ChatService.streamChat()` sendet `conversationId` Parameter
  - `ChatService.resetEmbedChatSession()` nutzt `conversationId` Query-Param
  - Fallback: Wenn Widget keine `conversationId` sendet → `conversationId = sessionId`

#### Geändert

- **Admin-UI**: Tab "Verlauf" zeigt jetzt gruppierte Konversationen (vorher: Flat-Liste aller Chats)
- **Database Query**: RAG Context Query nutzt `WHERE conversation_id = ?` statt `WHERE session_id = ?`
- **Widget Build**: Neu gebaut mit conversation_id Support (70% rewrite des minified JS)

#### Behoben

- **🐛 JSON-Parse-Fehler**: `safeJsonParse()` statt `JSON.parse()` in Konversations-Details
  - Problem: Alte Test-Daten hatten Plain-Text statt JSON im `response` Feld
  - Lösung: Fallback zu Plain-Text wenn JSON-Parse fehlschlägt

- **RAG Context Pollution**: Alte Nachrichten aus früheren Besuchen erscheinen nicht mehr im Context
  - Beispiel vorher: User besucht Seite am 01.01. ("Kontoeröffnung", 3 Nachrichten) + am 01.06. ("Öffnungszeiten", 2 Nachrichten) → RAG Context für 2. Frage enthielt ALLE 5 Nachrichten
  - Beispiel nachher: RAG Context für 2. Frage enthält nur 2 relevante Nachrichten

#### Technische Details

**Geänderte/Neue Dateien:**
- Backend: 4 Dateien (`schema.prisma`, `embedChats.js`, `embedManagement.js`, `embed.js`)
- Frontend: 4 Dateien (`embed.js`, `EmbedChats/index.jsx`, Translations)
- Widget: 8 Dateien (`useConversationId.js`, `chatService.js`, `App.jsx`, Header, ChatContainer, etc.)

**Database Migration:**
```sql
-- 20260222024816_add_conversation_id_to_embed_chats
ALTER TABLE embed_chats ADD COLUMN conversation_id TEXT;
UPDATE embed_chats SET conversation_id = session_id WHERE conversation_id IS NULL;
CREATE INDEX idx_embed_chats_conversation_id ON embed_chats(conversation_id);
```

**Tests:**
- ✅ E2E-Test: Widget → Backend → Database → Admin-UI
- ✅ RAG Context verifiziert: Konversationen getrennt (nur aktuelle Nachrichten im Context)
- ✅ UI-Tests: Karten, Badge, Expand, Zeitstempel (19/19 Features funktionieren)
- ✅ Browser-Test mit Claude Browser Tool (alle Checks bestanden)

#### Roadmap

- **Phase 1** (✅ ABGESCHLOSSEN): Conversation ID Tracking & RAG Context Fix
- **Phase 2** (📋 GEPLANT Q2 2026): LLM-basierte Analytics
  - Häufigste Fragen (Embeddings + Clustering)
  - Sentiment-Analyse pro Konversation
  - Problematische Nachrichten (Moderation API)
- **Phase 3** (🔮 ZUKUNFT Q3 2026): Advanced Features
  - Automatische FAQ-Generierung
  - Response-Quality-Scoring
  - Predictive Analytics (Lead Scoring, Churn-Risk)

Siehe `ROADMAP.md` für Details.

---

## [2.8.2] - 2025-01-30

### Verbessert
- **📅 Einheitliche deutsche Datumsformatierung**: Alle Zeitstempel werden jetzt im Format "DD.MM.YYYY, HH:MM:SS Uhr" angezeigt
  - Neue zentrale Funktion `formatDateTimeDE()` in `utils/directories.js`
  - Angewendet auf: Instance Workspaces, Users, Invitations, API Keys, Chats, Embed Chat History
  - Vorher: `2025-04-23T12:30:57.634Z` → Nachher: `23.04.2025, 12:30:57 Uhr`

---

## [2.8.1] - 2025-12-13

### Verbessert
- **🔒 Passwort-Bestätigung im Admin-Panel**: EditUserModal verlangt jetzt Bestätigung des neuen Passworts
  - Neues "Confirm Password" Feld verhindert Tippfehler beim Setzen von Kundenpasswörtern
  - Fehlermeldung "Passwords do not match" bei unterschiedlichen Eingaben
  - Submit wird blockiert bis beide Passwörter übereinstimmen

---

## [2.8.0] - 2024-12-11

### Hinzugefügt
- **🌍 Unicode-Spracherkennung**: Erkennt Arabisch, Hebräisch, Chinesisch, Japanisch, Koreanisch, Russisch, Griechisch, Thai, Hindi, Bengali direkt via Unicode-Ranges
  - `franc-min` versagt bei nicht-lateinischen Schriften
  - Unicode-Erkennung ist deterministisch und schneller
  - Fallback zu `franc-min` nur für lateinische Sprachen

- **🎵 Audio-Format Auto-Detection**: TTS-Endpoint erkennt Format via Magic Bytes
  - RIFF → WAV, OggS → OGG, fLaC → FLAC, sonst MP3
  - Korrekter Content-Type Header für alle Formate

### Geändert
- **STT Native FormData**: `form-data` Package durch native `FormData + Blob` ersetzt
  - `form-data` funktionierte nicht mit native `fetch()`
  - Behebt "multipart: NextPart: EOF" Fehler bei Groq

### Behoben
- **STT Endpoint**: Korrekte Filename-Ableitung aus Mimetype für Groq Whisper

---

## [2.7.0] - 2024-12-10

### Hinzugefügt
- **🎤 Embed Audio Endpoints**: Neue Server-Endpoints für Embed Widget STT/TTS
  - `GET /embed/:embedId/audio/status` - Prüft ob STT/TTS konfiguriert
  - `POST /embed/:embedId/audio/tts` - Text-to-Speech für Embed
  - Validiert embedId, keine User-Auth nötig

- **Frontend STT Verbesserungen**:
  - Server-STT Provider-Erkennung
  - Tooltip zeigt `[Server]` statt `[Groq]` an

### Geändert
- **TTS Normalizer**: Jetzt für ALLE TTS-Provider aktiv (OpenAI, ElevenLabs, Generic)
- **Kursnummern-Erkennung**: Universelles Pattern `[A-Z]{1,2}\d{4,5}[A-Z]?` für alle Sprachen

### Behoben
- **isTTSConfigured()**: Fehlende Funktion für Embed Audio Status Endpoint hinzugefügt

---

## [2.6.0] - 2024-12-09

### Hinzugefügt
- **TTS Text Normalizer**: Multilingualer Normalizer für bessere Sprachausgabe
  - Deutsche Zahlen (Tausender, Dezimal, Uhrzeiten)
  - Englische AM/PM Zeiten
  - Abkürzungen, Währungen, Einheiten
  - URL-Cleaning und Whitespace-Normalisierung

- **Stimmen für openedai-speech/Piper**:
  - 30+ Sprachen mit hochwertigen ONNX-Voices
  - Absolute Pfade in voice_to_speaker.yaml

### Behoben
- Ukrainische Stimme funktioniert jetzt korrekt (Pfad-Problem)
- Broken Voice Downloads (nl, pl, pt, kk, ml, sw, ne)

---

## [2.5.0] - 2024-12-XX

### Bestehende Features
- AnythingLLM Server mit Workspace-Chat
- RAG (Retrieval Augmented Generation)
- Multi-User Support
- Embed Widget Support
- TTS/STT Provider Integration
