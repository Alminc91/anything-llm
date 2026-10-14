const { safeJsonParse } = require("../utils/http");
const {
  sanitizeCourseSources,
  sanitizeCourseTeasers,
} = require("../utils/chats/embedCourseSources");
const {
  storedFollowUps,
  cleanStoredResponse,
  stripProtocolMarkers,
} = require("../utils/chats/embedCardsMarker");
const {
  searchForms,
  jsonEscaped,
  searchGlobPattern,
  searchLikePattern,
  needsGlobCheck,
  searchProbe,
} = require("../utils/helpers/chat/conversationSearch");
const prisma = require("../utils/prisma");
const { MessageLedger } = require("./messageLedger");

/**
 * @typedef {Object} EmbedChat
 * @property {number} id
 * @property {number} embed_id
 * @property {string} prompt
 * @property {string} response
 * @property {string} connection_information
 * @property {string} session_id
 * @property {string|null} conversation_id
 * @property {boolean} include
 */

// Bewertungen (KIE-532): Der Endpunkt ist öffentlich, und jede gebuchte
// Bewertung läuft durch die eine Reihe der Zählerbuch-Transaktionen, in der
// auch die Chat-Speicherungen stehen. Deshalb zwei Grenzen - beide greifen
// erst, nachdem die Chat-Zeile zu Widget und Sitzung gefunden wurde:
// je Widget und Sitzung höchstens FEEDBACK_MAX_PER_WINDOW Bewertungen je
// Minute, und höchstens FEEDBACK_MAX_PENDING Bewertungen gleichzeitig in der
// Reihe.
const FEEDBACK_WINDOW_MS = 60_000;
const FEEDBACK_MAX_PER_WINDOW = 30;
const FEEDBACK_MAX_PENDING = 32;
const FEEDBACK_MAX_TRACKED_SESSIONS = 5_000;

// Export (KIE-538): Die Konversationen der Auswahl werden EINMAL bestimmt -
// Kennung, Sitzung und zwei Zahlen je Konversation, rund 200 Byte im
// Speicher (Fixliste 7, F01/F09: vorher baute der Export ohne Suche je Seite
// zu 500 Konversationen die ganze Gruppierung neu, die Laufzeit wuchs
// quadratisch). Die Nachrichten werden danach in Paketen gelesen: die von
// höchstens EXPORT_BATCH_CONVERSATIONS Konversationen bzw.
// EXPORT_MESSAGE_BATCH Nachrichten (nach der Zählung der Liste) auf einmal.
//
// Mit Suche ist die Menge hart begrenzt (Fixliste 3, C10): Mehr als
// EXPORT_SEARCH_MAX_HITS Treffer lehnt der Export ab (Fehler mit code
// EXPORT_TOO_MANY_HITS, die Route antwortet 413 mit dieser Zahl) - höchstens
// rund 20 MB je laufendem Export. Ohne Suche gibt es keine Grenze, wie
// bisher: Der ganze Bestand eines Widgets lässt sich immer exportieren
// (100.000 Chat-Zeilen ergeben im Messbestand 42.858 Konversationen, rund
// 9 MB; siehe __tests__/benchmarks/conversationSearch.manual.js).
const EXPORT_MESSAGE_BATCH = 500;
const EXPORT_BATCH_CONVERSATIONS = 100;
const EXPORT_SEARCH_MAX_HITS = 100_000;

// Größter Wert einer INT4-Spalte (id, embed_id): Prisma lehnt größere Zahlen
// in einer Abfrage ab, statt nichts zu finden.
const INT4_MAX = 2147483647;

/**
 * Ein Zeitpunkt aus einer Rohabfrage ($queryRaw, SQLite) in Millisekunden -
 * eine Stelle für alle Rohwerte (Fixliste 7, F26). Prisma speichert DateTime
 * als Millisekunden (INTEGER; über $queryRaw als Zahl bzw. BigInt), MIN/MAX
 * darüber ebenso; je nach Treiber kann ein Date kommen, aus älteren oder
 * fremden Zeilen ein Text (Ziffern oder ISO).
 * @param {unknown} value
 * @returns {number|null} - Millisekunden; null ohne gültigen Zeitpunkt
 */
function rawInstant(value) {
  let ms = NaN;
  if (typeof value === "number" || typeof value === "bigint")
    ms = Number(value);
  else if (value instanceof Date) ms = value.getTime();
  else if (typeof value === "string")
    ms = /^-?\d+$/.test(value.trim()) ? Number(value) : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Der angezeigte Text einer gespeicherten Antwort, in SQL aus der Spalte
 * response gelesen: bei einem JSON-Objekt das Feld text (ohne Quellen,
 * Kurskarten und Metadaten; NULL, wenn text kein Text ist), sonst die
 * Antwort wörtlich. Eine Regel für Suche, Export und POST /embed/chats
 * (Fixliste 8, C2/L3) - wie answerText im Panel (frontend
 * utils/conversationView.js).
 *
 * Protokoll-Marker alter Antworten („[[FRAGEN: …]]", „[[KARTEN: …]]") bleiben
 * hier stehen, bewusst (Fixliste 9, A6): Entfernt der Lesepfad sie (Branch
 * fix/folgefragen-frageform, withoutProtocolMarkers), findet die Suche einen
 * Begriff, der nur im Marker eines Altdatensatzes steht, noch - die Liste
 * zeigt dann eine Konversation zu viel, das Panel den Hinweis auf
 * unsichtbare Treffer (F13). Nie zu wenig. Eine Bereinigung in SQL wäre
 * nicht trivial: Die Marker-Regeln (Zeilenlage, Längengrenzen, mehrere
 * Gruppen) kennt nur der Parser in JS; ein grobes Abschneiden ab dem
 * ersten „[[" kürzte auch Antworten, in denen „[[" Text ist (Treffer
 * fehlten), und kostete je Zeile im Suchpfad von NAK-7. Betroffen sind nur
 * Antworten von vor FF1, und nur, wenn der Begriff allein im Marker steht.
 * @returns {import("@prisma/client").Prisma.Sql}
 */
function visibleAnswerSql() {
  const { Prisma } = require("@prisma/client");
  return Prisma.sql`(CASE
      WHEN json_valid(response) AND json_type(response) = 'object'
      THEN CASE WHEN json_type(response, '$.text') = 'text' THEN json_extract(response, '$.text') END
      ELSE response
    END)`;
}

// Index (embed_id, session_id) aus der Migration
// 20260722014551_add_embed_session_index_to_embed_chats (KIE-503).
const SESSION_INDEX = "embed_chats_embed_id_session_id_idx";
// Name → Promise<boolean>: gibt es den Index in dieser Datenbank?
const knownIndexes = new Map();

/**
 * Gibt es den Index auf embed_chats? Einmal je Prozess nachgesehen
 * (sqlite_master); ein Fehler beim Nachsehen gilt als „nein" und wird beim
 * nächsten Aufruf wiederholt.
 * @param {string} name
 * @returns {Promise<boolean>}
 */
function indexExists(name) {
  if (!knownIndexes.has(name)) {
    const check = Promise.resolve()
      .then(() =>
        prisma.$queryRawUnsafe(
          "SELECT 1 AS present FROM sqlite_master WHERE type = 'index' AND tbl_name = 'embed_chats' AND name = ?",
          name
        )
      )
      .then((rows) => Array.isArray(rows) && rows.length > 0)
      .catch(() => {
        knownIndexes.delete(name);
        return false;
      });
    knownIndexes.set(name, check);
  }
  return knownIndexes.get(name);
}

/**
 * Führt eine Abfrage mit dem Hinweis `INDEXED BY <name>` aus - nur, wenn es
 * den Index gibt (Fixliste 9, A1/A3). Ohne Statistiken (sqlite_stat1; in
 * Produktion läuft weder ANALYZE noch PRAGMA optimize) nimmt SQLite bei
 * ORDER BY createdAt den Index (embed_id, createdAt) und liest alle Zeilen
 * des Widgets statt der einer Sitzung. Garantiert ist der Index nicht: Die
 * Migration legt ihn ohne IF NOT EXISTS an, und schlägt sie fehl, markiert
 * docker/docker-entrypoint.sh sie als angewendet, ohne ihre Anweisung
 * auszuführen. Fehlt er, läuft die Abfrage ohne Hinweis - langsamer, aber
 * nie mit „no such index" (500). Verschwindet er während des Betriebs,
 * wiederholt die Abfrage einmal ohne Hinweis.
 * @template T
 * @param {string} name - Name des Index
 * @param {(hint: import("@prisma/client").Prisma.Sql) => Promise<T>} run -
 *   baut die Abfrage mit `FROM embed_chats ${hint}`
 * @returns {Promise<T>}
 */
async function withIndexHint(name, run) {
  const { Prisma } = require("@prisma/client");
  if (!(await indexExists(name))) return await run(Prisma.empty);
  try {
    return await run(Prisma.raw(`INDEXED BY ${name}`));
  } catch (error) {
    if (!/no such index/i.test(String(error?.message ?? ""))) throw error;
    knownIndexes.set(name, Promise.resolve(false));
    return await run(Prisma.empty);
  }
}

// Widget|Sitzung → { startedAt, count } des laufenden Zeitfensters
const feedbackWindows = new Map();
let pendingFeedback = 0;

/**
 * Zählt eine Bewertung im Zeitfenster von Widget und Sitzung.
 * @returns {boolean} - false, wenn die Grenze je Sitzung überschritten ist
 */
function takeFeedbackSlot(embedId, sessionId) {
  const now = Date.now();
  const key = `${embedId}|${sessionId}`;
  const current = feedbackWindows.get(key);
  if (current && now - current.startedAt < FEEDBACK_WINDOW_MS) {
    current.count += 1;
    return current.count <= FEEDBACK_MAX_PER_WINDOW;
  }

  if (feedbackWindows.size >= FEEDBACK_MAX_TRACKED_SESSIONS)
    for (const [tracked, window] of feedbackWindows)
      if (now - window.startedAt >= FEEDBACK_WINDOW_MS)
        feedbackWindows.delete(tracked);
  feedbackWindows.set(key, { startedAt: now, count: 1 });
  return true;
}

const EmbedChats = {
  /**
   * Nur für Tests: vergisst, welche Indizes es gibt (withIndexHint) - die
   * nächste Abfrage sieht wieder in sqlite_master nach.
   */
  _forgetIndexes: function () {
    knownIndexes.clear();
  },

  FEEDBACK_MAX_PER_WINDOW,
  FEEDBACK_MAX_PENDING,
  EXPORT_MESSAGE_BATCH,
  EXPORT_BATCH_CONVERSATIONS,
  EXPORT_SEARCH_MAX_HITS,

  /**
   * Legt eine Widget-Chat-Zeile an und zählt sie im Zählerbuch (KIE-532): +1
   * messages in der Zeile des Widgets für den Berliner Tag und die Berliner
   * Stunde, unter dem Workspace, dem das Widget in diesem Moment gehört.
   * conversations_started steigt, wenn es für COALESCE(conversation_id,
   * session_id) in diesem Widget noch keine Zeile gab. Zeile und Zähler
   * entstehen in einer Transaktion - gemeinsam oder gar nicht.
   *
   * Scheitert die Transaktion an einer Sperre, wird sie wiederholt (KIE-542).
   * Die angelegte Zeile ist dafür gemeldet (attempt.created): Hat ein früherer
   * Versuch sie trotz Fehlermeldung gespeichert, legt die Wiederholung sie
   * nicht noch einmal an.
   */
  new: async function ({
    embedId,
    prompt,
    response = {},
    connection_information = {},
    sessionId,
    conversationId = null,
  }) {
    try {
      const chat = await MessageLedger.transaction(
        { source: "embed_chat", embedId: Number(embedId) },
        async (tx, attempt) => {
          const created = attempt.created(
            "embed_chats",
            await tx.embed_chats.create({
              data: {
                prompt,
                embed_id: Number(embedId),
                response: JSON.stringify(response),
                connection_information: JSON.stringify(connection_information),
                session_id: String(sessionId),
                conversation_id: conversationId ? String(conversationId) : null,
              },
            })
          );
          const embed = await tx.embed_configs.findUnique({
            where: { id: created.embed_id },
            select: { workspace_id: true },
          });
          await MessageLedger.record(tx, {
            workspaceId: embed.workspace_id,
            embedId: created.embed_id,
            at: created.createdAt,
            messages: 1,
            conversationStarted: await EmbedChats._startsConversation(
              tx,
              created
            ),
          });
          return created;
        },
        { retry: { createdRows: true } }
      );
      return { chat, message: null };
    } catch (error) {
      console.error(error.message);
      return { chat: null, message: error.message };
    }
  },

  /**
   * Beginnt diese Zeile eine Konversation? Ja, wenn es für
   * COALESCE(conversation_id, session_id) in diesem Widget keine frühere Zeile
   * gibt. Wurden frühere Zeilen derselben Konversation gelöscht, zählt sie
   * erneut. Dieselbe Regel wendet der Nachtrag an
   * (utils/boot/messageLedgerBackfill.js, STARTS_CONVERSATION_SQL).
   * Das vorangestellte + nimmt eine Spalte aus der Indexwahl: Gesucht wird über
   * conversation_id bzw. (embed_id, session_id), nie über alle Zeilen des Widgets.
   * @param {import("@prisma/client").Prisma.TransactionClient} tx
   * @param {EmbedChat} chat - die eben angelegte Zeile
   * @returns {Promise<boolean>}
   */
  _startsConversation: async function (tx, chat) {
    const key = chat.conversation_id ?? chat.session_id;
    const [row] = await tx.$queryRaw`
      SELECT (
        EXISTS (
          SELECT 1 FROM embed_chats p
          WHERE p.conversation_id = ${key} AND +p.embed_id = ${chat.embed_id}
            AND p.id < ${chat.id}
        )
        OR EXISTS (
          SELECT 1 FROM embed_chats p
          WHERE p.embed_id = ${chat.embed_id} AND p.session_id = ${key}
            AND +p.conversation_id IS NULL AND p.id < ${chat.id}
        )
      ) AS continued`;
    return Number(row.continued) === 0;
  },

  /**
   * L4 (FF1): die eine Bereinigung beim Lesen gespeicherter Antworten -
   * Protokoll-Marker ("[[FRAGEN: …]]", "[[KARTEN: …]]"), die Altdatensätze
   * vor FF1 noch im Text tragen, kommen bei keinem Leser an: LLM- und
   * Widget-Verlauf (forEmbedByUser), Admin-Konversation
   * (getConversationDetails), Admin-Chatliste (whereWithEmbedAndWorkspace,
   * chatTablePage), Export (_exportMessages) und
   * Entwickler-API GET /v1/embed/:embedUuid/chats[/:sessionUuid] (where).
   * Nur response wird ersetzt (cleanStoredResponse), Zeilen ohne Marker
   * bleiben dieselben Objekte; die Zeilen selbst werden nie verändert.
   * @param {object[]} chats - embed_chats-Zeilen (response = JSON-String)
   * @returns {object[]}
   */
  withoutProtocolMarkers: function (chats) {
    if (!Array.isArray(chats)) return [];
    return chats.map((chat) => {
      const response = cleanStoredResponse(chat?.response);
      return response === chat?.response ? chat : { ...chat, response };
    });
  },

  /**
   * Loops through each chat and filters out the sources from the response object.
   * We do this when returning /history of an embed to the frontend to prevent inadvertent leaking
   * of private sources the user may not have intended to share with users.
   * Kurskarten: `courseSources` (nur Kurs-Metadaten, nie text) bleibt erhalten,
   * wird aber nochmals auf die Whitelist reduziert. Kurskarten v3:
   * `courseTeasers` (URL -> Teaser) nur für URLs dieser Karten, Text bereinigt;
   * `courseTeaserLines` (LLM-Verlauf) nie ans Widget. Folgefragen:
   * `followUps` nur bereinigt (storedFollowUps).
   * @param {EmbedChat[]} chats
   * @returns {EmbedChat[]} Returns a new array of chats with the sources filtered out of responses
   */
  filterSources: function (chats) {
    return chats.map((chat) => {
      const { response, ...rest } = chat;
      const parsed = safeJsonParse(response, {});
      const {
        sources: _sources,
        courseSources,
        courseCardsAnnounced,
        // Kurskarten v2: Marker-Nummern nur für den LLM-Verlauf, nie ans Widget
        courseCardsMarker: _courseCardsMarker,
        // Kurskarten v3: Teaser je Karte (Widget) / Teaserzeilen (nur LLM)
        courseTeasers,
        courseTeaserLines: _courseTeaserLines,
        // Folgefragen: nur bereinigt (Strings ≤ 60 Zeichen, höchstens 3)
        followUps,
        ...responseRest
      } = parsed && typeof parsed === "object" ? parsed : {};
      const safeFollowUps = storedFollowUps(followUps, {
        userMessage: rest.prompt,
      });
      if (safeFollowUps.length > 0) responseRest.followUps = safeFollowUps;
      const safeCourseSources = sanitizeCourseSources(courseSources);
      if (safeCourseSources.length > 0) {
        responseRest.courseSources = safeCourseSources;
        // Kurskarten v2: Anzahl der vorab angekündigten Kurse am Listenanfang
        if (Number.isInteger(courseCardsAnnounced) && courseCardsAnnounced > 0)
          responseRest.courseCardsAnnounced = Math.min(
            courseCardsAnnounced,
            safeCourseSources.length
          );
        const safeTeasers = sanitizeCourseTeasers(
          courseTeasers,
          safeCourseSources
        );
        if (Object.keys(safeTeasers).length > 0)
          responseRest.courseTeasers = safeTeasers;
      }
      return { ...rest, response: JSON.stringify(responseRest) };
    });
  },

  /**
   * Fetches chats for a given embed and identifier (session_id or conversation_id).
   * @param {number} embedId the id of the embed to fetch chats for
   * @param {string} identifierId the id of the session or conversation to fetch chats for
   * @param {number|null} limit the maximum number of chats to fetch
   * @param {string|null} orderBy the order to fetch chats in
   * @param {string|boolean} identifierType 'session_id' or 'conversation_id' (default: 'session_id' for backwards compatibility), or boolean for filterSources (legacy)
   * @param {string|null} boundSessionId when identifierType is 'conversation_id', additionally binds the conversation to its owning session (BOLA/IDOR hardening, KIE-505)
   * @returns {Promise<EmbedChat[]>} Returns an array of chats for the given embed and identifier
   */
  forEmbedByUser: async function (
    embedId = null,
    identifierId = null,
    limit = null,
    orderBy = null,
    identifierType = "session_id",
    boundSessionId = null
  ) {
    if (!embedId || !identifierId) return [];

    // Legacy support: If identifierType is boolean, it's the old filterSources parameter
    let filterSources = false;
    if (typeof identifierType === "boolean") {
      filterSources = identifierType;
      identifierType = "session_id";
    }

    try {
      // Build WHERE clause dynamically based on identifier type
      const whereClause = {
        embed_id: Number(embedId),
        include: true,
      };

      if (identifierType === "conversation_id") {
        if (boundSessionId && String(identifierId) === String(boundSessionId)) {
          // KIE-503: Legacy-Zeilen (vor KIE-502) haben conversation_id NULL und
          // werden in Konversations-Listen via COALESCE unter der session_id
          // gruppiert. Wählt das Widget diesen Bucket (identifierId ===
          // boundSessionId), müssen die NULL-Zeilen mitgeladen werden — sonst
          // verspricht die Liste N Nachrichten, die Auswahl lädt aber leer.
          // Session-Bindung bleibt strikt (BOLA, KIE-505).
          whereClause.session_id = String(boundSessionId);
          whereClause.OR = [
            { conversation_id: String(identifierId) },
            { conversation_id: null },
          ];
        } else {
          whereClause.conversation_id = String(identifierId);
          // BOLA/IDOR hardening (KIE-505): bind the conversation to its owning
          // session so a leaked conversationId alone cannot load foreign history.
          if (boundSessionId) whereClause.session_id = String(boundSessionId);
        }
      } else {
        whereClause.session_id = String(identifierId);
      }

      const chats = await prisma.embed_chats.findMany({
        where: whereClause,
        ...(limit !== null ? { take: limit } : {}),
        ...(orderBy !== null ? { orderBy } : { orderBy: { id: "asc" } }),
      });
      const readable = this.withoutProtocolMarkers(chats);
      return filterSources ? this.filterSources(readable) : readable;
    } catch (error) {
      console.error(error.message);
      return [];
    }
  },

  markHistoryInvalid: async function (
    embedId = null,
    identifierId = null,
    identifierType = "session_id",
    boundSessionId = null
  ) {
    if (!embedId || !identifierId) return [];

    try {
      // Build WHERE clause dynamically
      const whereClause = {
        embed_id: Number(embedId),
      };

      if (identifierType === "conversation_id") {
        if (boundSessionId && String(identifierId) === String(boundSessionId)) {
          // KIE-503: Spiegel des Legacy-NULL-Zweigs aus forEmbedByUser — Lesen
          // und Invalidieren müssen denselben Session-Bucket meinen, sonst
          // tauchen "gelöschte" Legacy-Zeilen nach Reload wieder auf.
          whereClause.session_id = String(boundSessionId);
          whereClause.OR = [
            { conversation_id: String(identifierId) },
            { conversation_id: null },
          ];
        } else {
          whereClause.conversation_id = String(identifierId);
          // BOLA/IDOR hardening (KIE-505): only invalidate history that belongs
          // to the requesting session, not any session sharing the conversationId.
          if (boundSessionId) whereClause.session_id = String(boundSessionId);
        }
      } else {
        whereClause.session_id = String(identifierId);
      }

      await prisma.embed_chats.updateMany({
        where: whereClause,
        data: {
          include: false,
        },
      });
      return;
    } catch (error) {
      console.error(error.message);
    }
  },

  /**
   * Zeilenschlüssel einer Chat-Zeile aus einer Eingabe von außen: eine positive
   * ganze Zahl, als Zahl oder als Ziffernfolge. Alles andere ist keine chatId.
   * @param {*} value
   * @returns {number|null}
   */
  parseChatId: function (value) {
    const id =
      typeof value === "string" && /^[1-9]\d{0,15}$/.test(value)
        ? Number(value)
        : value;
    return typeof id === "number" && Number.isSafeInteger(id) && id > 0
      ? id
      : null;
  },

  /**
   * Setzt oder entfernt den Feedback-Score (👍/👎) für eine Embed-Antwort (KIE-504).
   * BOLA/IDOR-Härtung (analog KIE-505): die chatId wird zusätzlich an embed_id UND
   * session_id gebunden, damit eine geratene/geleakte chatId keine fremde Antwort
   * bewerten kann. Verwendet updateMany, sodass ein Nicht-Treffer keinen Fehler wirft.
   * Zählerbuch (KIE-532): Der alte Wert wird gelesen und der Übergang in derselben
   * Transaktion auf die Stunde gebucht, in der die Nachricht entstand. Ohne Treffer
   * (fremde Session, fremdes Widget) ändert sich weder die Zeile noch das Zählerbuch.
   * @param {number|null} embedId the embed config id (scope)
   * @param {string|null} sessionId the owning browser session
   * @param {number|null} chatId the embed_chats row id
   * @param {boolean|number|null} feedbackScore 1/true = 👍, 0/false = 👎, null = keine Bewertung
   * @param {{feedbackText?: string|null, feedbackReason?: string|null}} [opts] optionaler
   *   Freitext-Kommentar + 1-Klick-Grund bei 👎 (KIE-507). Nur gesetzte Felder werden
   *   geschrieben; wird die Bewertung entfernt (feedbackScore null), werden beide geleert.
   * @returns {Promise<boolean>} true, wenn die Bewertung der Zeile jetzt dem Wunsch entspricht
   */
  updateFeedbackScore: async function (
    embedId = null,
    sessionId = null,
    chatId = null,
    feedbackScore = null,
    opts = {}
  ) {
    const outcome = await EmbedChats.applyFeedback(
      embedId,
      sessionId,
      chatId,
      feedbackScore,
      opts
    );
    return outcome === "updated";
  },

  /**
   * Wie updateFeedbackScore, nennt aber den Ausgang - der Endpunkt
   * unterscheidet damit "nichts gefunden" von "zu viele Anfragen".
   *
   * Der Endpunkt ist öffentlich. Bevor eine Zählerbuch-Transaktion entsteht
   * (und damit die Reihe belegt, in der auch die Chat-Speicherungen stehen):
   * - muss chatId eine positive ganze Zahl sein (sonst kein Datenbankzugriff),
   * - wird die Zeile außerhalb der Reihe gelesen; ohne Treffer endet der Aufruf,
   * - gelten die Grenzen je Sitzung und für die Reihe (siehe oben).
   * Ändert sich die Bewertung nicht, gibt es nichts zu buchen: Kommentar und
   * Grund werden dann ohne Transaktion geschrieben.
   *
   * Parameter wie updateFeedbackScore.
   * @returns {Promise<"updated"|"not_found"|"rate_limited"|"busy"|"error">}
   *   not_found: keine Chat-Zeile zu chatId, Widget und Sitzung (oder keine
   *   gültige chatId); rate_limited: Grenze je Sitzung; busy: Reihe voll;
   *   error: Schreibfehler
   */
  applyFeedback: async function (
    embedId = null,
    sessionId = null,
    chatId = null,
    feedbackScore = null,
    { feedbackText, feedbackReason } = {}
  ) {
    const id = EmbedChats.parseChatId(chatId);
    if (!embedId || !sessionId || id === null) return "not_found";
    try {
      const resolvedScore =
        feedbackScore === null ? null : Number(feedbackScore) === 1;
      const data = { feedbackScore: resolvedScore };
      if (resolvedScore === false) {
        // 👎: nur explizit übergebene Kommentar/Grund-Felder schreiben
        // (undefined = unangetastet).
        if (feedbackText !== undefined)
          data.feedbackText =
            feedbackText === null ? null : String(feedbackText).slice(0, 2000);
        if (feedbackReason !== undefined)
          data.feedbackReason =
            feedbackReason === null
              ? null
              : String(feedbackReason).slice(0, 100);
      } else {
        // 👍 oder Bewertung entfernt (null): Kommentar/Grund konsistent leeren,
        // damit keine verwaisten negativen Kommentare an einer 👍-Zeile hängen.
        data.feedbackText = null;
        data.feedbackReason = null;
      }
      const where = {
        id,
        embed_id: Number(embedId),
        session_id: String(sessionId),
      };

      // Außerhalb der Reihe: Anfragen ohne Treffer (geratene chatId, fremde
      // Session) kosten einen Lesezugriff und halten keine Speicherung auf.
      const current = await prisma.embed_chats.findFirst({
        where,
        select: {
          feedbackScore: true,
          feedbackText: true,
          feedbackReason: true,
        },
      });
      if (!current) return "not_found";
      if (!takeFeedbackSlot(where.embed_id, where.session_id))
        return "rate_limited";

      if (current.feedbackScore === resolvedScore) {
        // Kein Übergang, nichts zu buchen. Die Bedingung auf feedbackScore
        // hält eine gleichzeitig geänderte Bewertung heraus - die läuft dann
        // unten durch die Transaktion.
        const { feedbackScore: _unchanged, ...comment } = data;
        if (Object.keys(comment).every((key) => comment[key] === current[key]))
          return "updated";
        const written = await prisma.embed_chats.updateMany({
          where: { ...where, feedbackScore: resolvedScore },
          data: comment,
        });
        if (written.count === 1) return "updated";
      }

      if (pendingFeedback >= FEEDBACK_MAX_PENDING) return "busy";
      pendingFeedback += 1;
      try {
        const updated = await MessageLedger.transaction(
          { source: "embed_feedback", embedId: where.embed_id },
          async (tx) => {
            const before = await tx.embed_chats.findFirst({
              where,
              select: {
                id: true,
                createdAt: true,
                feedbackScore: true,
                embed_config: { select: { workspace_id: true } },
              },
            });
            if (!before) return false;

            const result = await tx.embed_chats.updateMany({ where, data });
            if (result.count !== 1) return false;

            if (
              before.feedbackScore !== resolvedScore &&
              (await MessageLedger.isRowCounted(tx, "embed_chats", before.id))
            )
              await MessageLedger.adjustFeedback(tx, {
                workspaceId: before.embed_config.workspace_id,
                embedId: where.embed_id,
                at: before.createdAt,
                from: before.feedbackScore,
                to: resolvedScore,
              });
            return true;
          },
          // KIE-542: wiederholbar. Gebucht wird nur der Übergang von der
          // gelesenen zur neuen Bewertung. Hat ein früherer Versuch trotz
          // Fehlermeldung geschrieben, liest die Wiederholung schon die neue
          // Bewertung und bucht nichts mehr.
          { retry: { idempotent: true } }
        );
        return updated ? "updated" : "not_found";
      } finally {
        pendingFeedback -= 1;
      }
    } catch (error) {
      console.error("updateFeedbackScore error:", error.message);
      return "error";
    }
  },

  /** Nur für Tests: vergisst die Zeitfenster der Bewertungen. */
  _resetFeedbackLimits: function () {
    feedbackWindows.clear();
  },

  get: async function (clause = {}, limit = null, orderBy = null) {
    try {
      const chat = await prisma.embed_chats.findFirst({
        where: clause,
        ...(limit !== null ? { take: limit } : {}),
        ...(orderBy !== null ? { orderBy } : {}),
      });
      return chat || null;
    } catch (error) {
      console.error(error.message);
      return null;
    }
  },

  delete: async function (clause = {}) {
    try {
      await prisma.embed_chats.deleteMany({
        where: clause,
      });
      return true;
    } catch (error) {
      console.error(error.message);
      return false;
    }
  },

  where: async function (
    clause = {},
    limit = null,
    orderBy = null,
    offset = null
  ) {
    try {
      const chats = await prisma.embed_chats.findMany({
        where: clause,
        ...(limit !== null ? { take: limit } : {}),
        ...(offset !== null ? { skip: offset } : {}),
        ...(orderBy !== null ? { orderBy } : {}),
      });
      return EmbedChats.withoutProtocolMarkers(chats);
    } catch (error) {
      console.error(error.message);
      return [];
    }
  },

  whereWithEmbedAndWorkspace: async function (
    clause = {},
    limit = null,
    orderBy = null,
    offset = null
  ) {
    try {
      const chats = await prisma.embed_chats.findMany({
        where: clause,
        include: {
          embed_config: {
            select: {
              workspace: {
                select: {
                  name: true,
                },
              },
            },
          },
        },
        ...(limit !== null ? { take: limit } : {}),
        ...(offset !== null ? { skip: offset } : {}),
        ...(orderBy !== null ? { orderBy } : {}),
      });
      return EmbedChats.withoutProtocolMarkers(chats);
    } catch (error) {
      console.error(error.message);
      return [];
    }
  },

  count: async function (clause = {}) {
    try {
      const count = await prisma.embed_chats.count({
        where: clause,
      });
      return count;
    } catch (error) {
      console.error(error.message);
      return 0;
    }
  },

  /**
   * Zählt die Embed-Chats eines Workspaces im halboffenen Fenster
   * [start, endExclusive), passend zu getBillingWindow.
   * @param {number} workspaceId
   * @param {Date} start - inclusive
   * @param {Date} endExclusive - exclusive
   * @param {{throwOnError?: boolean}} [options] - KIE-534: true reicht einen
   * Datenbankfehler weiter, statt ihn als 0 zu zählen (Limitprüfung der Agent-Sitzung).
   * @returns {Promise<number>}
   */
  countForWorkspaceInDateRange: async function (
    workspaceId,
    start,
    endExclusive,
    { throwOnError = false } = {}
  ) {
    try {
      const count = await prisma.embed_chats.count({
        where: {
          embed_config: {
            workspace_id: workspaceId,
          },
          createdAt: {
            gte: start,
            lt: endExclusive,
          },
        },
      });
      return count;
    } catch (error) {
      console.error(error.message);
      if (throwOnError) throw error;
      return 0;
    }
  },

  /**
   * KIE-508/527: Normalisiert den Feedback-Filter der Analytics-Konversationsliste.
   * Akzeptiert die neuen Strings sowie den Legacy-Boolean `onlyNegative`.
   * Alles Unbekannte fällt auf "all" zurück — es gelangt nie User-Input in SQL.
   * @param {string|boolean|null|undefined} value
   * @returns {"all"|"negative"|"positive"}
   */
  normalizeFeedbackFilter: function (value) {
    if (value === true) return "negative"; // Legacy onlyNegative=true
    if (value === "negative" || value === "positive") return value;
    return "all";
  },

  /**
   * KIE-508/527: Filterbedingung auf die aggregierten Konversationszeilen aus
   * {@link EmbedChats._conversationGroupsSql} (Spalten positive_count /
   * negative_count). Wird von Liste UND Zähl-Query benutzt. Der Filter greift
   * NACH der Gruppierung, damit conversation_number über die ungefilterte
   * Menge vergeben bleibt. Ausschließlich Konstanten — kein User-Input im SQL.
   * @param {string|boolean} feedbackFilter
   * @returns {import("@prisma/client").Prisma.Sql}
   */
  feedbackFilterCondition: function (feedbackFilter) {
    const { Prisma } = require("@prisma/client");
    switch (EmbedChats.normalizeFeedbackFilter(feedbackFilter)) {
      case "negative":
        return Prisma.sql`WHERE negative_count > 0`;
      case "positive":
        return Prisma.sql`WHERE positive_count > 0`;
      default:
        return Prisma.empty;
    }
  },

  /**
   * KIE-536: Normalisiert den Abschnitts-Filter der Konversationsliste
   * („erste vorhandene Nachricht der Konversation liegt im Abschnitt").
   * @param {{start: Date, endExclusive: Date}|null|undefined} value
   * @returns {{start: Date, endExclusive: Date}|null} - null = kein Filter
   */
  normalizeStartedBetween: function (value) {
    const valid = (date) => date instanceof Date && !isNaN(date.getTime());
    if (!value || !valid(value.start) || !valid(value.endExclusive))
      return null;
    return { start: value.start, endExclusive: value.endExclusive };
  },

  /**
   * KIE-536: Filterbedingung der äußeren Ebene für Liste UND Zähl-Query -
   * der Feedback-Filter ({@link EmbedChats.feedbackFilterCondition}) und,
   * falls gesetzt, der Abschnitts-Filter auf started_at (= MIN(createdAt) der
   * Gruppe). Beide greifen NACH der Gruppierung. Ohne Abschnitts-Filter ist
   * das Ergebnis genau die Feedback-Bedingung. Die Suche kommt über
   * {@link EmbedChats._conversationSelection} dazu.
   * @param {string|boolean} feedbackFilter
   * @param {{start: Date, endExclusive: Date}|null} [startedBetween] - halboffen [start, endExclusive)
   * @returns {import("@prisma/client").Prisma.Sql}
   */
  conversationFilterCondition: function (
    feedbackFilter,
    startedBetween = null
  ) {
    const { Prisma } = require("@prisma/client");
    const feedback = EmbedChats.feedbackFilterCondition(feedbackFilter);
    const between = EmbedChats.normalizeStartedBetween(startedBetween);
    if (!between) return feedback;

    const started = Prisma.sql`started_at >= ${between.start} AND started_at < ${between.endExclusive}`;
    return feedback === Prisma.empty
      ? Prisma.sql`WHERE ${started}`
      : Prisma.sql`${feedback} AND ${started}`;
  },

  /**
   * Eine WHERE-Bedingung um eine weitere erweitern (beide Prisma.Sql; die
   * erste ist leer oder beginnt mit WHERE).
   * @returns {import("@prisma/client").Prisma.Sql}
   */
  _whereAnd: function (where, condition) {
    const { Prisma } = require("@prisma/client");
    return where === Prisma.empty
      ? Prisma.sql`WHERE ${condition}`
      : Prisma.sql`${where} AND ${condition}`;
  },

  /**
   * Suche: Trifft der Begriff eine Zeile? Durchsucht wird nur, was die
   * Ansicht zeigt - die Frage, der angezeigte Antworttext, Grund und
   * Kommentar der Bewertung. Bei einer JSON-Antwort ist das allein das Feld
   * `text` (json_extract), nicht Quellen, Kurskarten oder Metadaten; eine
   * Antwort, die kein JSON-Objekt ist, zeigt die Ansicht wörtlich.
   *
   * Groß/klein egal, auch bei Umlauten, für den Begriff in NFC und NFD: je
   * Spalte eine billige Vorprüfung und, wo nötig, ein genaues GLOB dahinter
   * (utils/helpers/chat/conversationSearch). Alle Muster sind gebundene
   * Werte.
   *
   * Die Antwort: Die Antworten des Widgets beginnen mit dem Text
   * ({"text":"…","type":…, "sources":…}); in einem JSON-Text steht jedes
   * Anführungszeichen maskiert (\"). Die erste Folge "," (Anführungszeichen,
   * Komma, Anführungszeichen) steht deshalb am Ende des Texts - genau dort
   * oder, wenn der Text selbst auf Anführungszeichen und Komma endet (\","),
   * zwei Zeichen davor. Der Anfang (Spalte answer_head,
   * {@link EmbedChats._searchRowsSql}; NULL bei jeder anderen Antwort)
   * reicht deshalb bis einschließlich der beiden Zeichen ", dahinter: So
   * enthält er immer den ganzen Text (Fixliste 3, C9 - vorher fehlten im
   * zweiten Fall die letzten beiden Zeichen, und die Vorprüfung schloss
   * echte Treffer aus). Die zwei Zeichen zu viel (", ohne Rückstrich davor)
   * zählen nur für die Vorprüfung; der genaue Vergleich läuft gegen den
   * Anfang ohne sie (Fixliste 4, C1). Die Vorprüfung sucht dort den Begriff in
   * seiner JSON-Schreibweise (" als \", \ als \\) - Quellen und Metadaten
   * treffen sie so nicht. Steht im Anfang kein Rückstrich, ist er der Text
   * selbst. Fast jede echte Antwort ist mehrzeiliges Markdown (\n): Diese
   * Maskierung wird im Anfang direkt aufgelöst (answerPlain) - bleibt danach
   * kein Rückstrich übrig, ist das der Text (Fixliste 2, R6). Ein falsch
   * aufgelöstes Paar (etwa \\n, ein maskierter Rückstrich vor „n") lässt
   * immer einen Rückstrich stehen und fällt deshalb in den letzten Fall. Nur
   * sonst (\", \u…, \\, \t …) wird der Text für diese Zeile aus dem JSON
   * gelesen. Die ganze Antwort (response, mehrere KB mit Quellen) wird nicht
   * durch die Unterabfrage gereicht: Das kostete je Durchlauf rund eine
   * halbe Sekunde auf 100.000 Zeilen (Fixliste Punkt 6); gelesen wird sie
   * nur für die Zeilen, die es brauchen, über ihre id.
   *
   * Link-Ziele, HTML-Attribute und <think>-Blöcke im Antworttext durchsucht
   * die Abfrage mit (SQLite kennt keine regulären Ausdrücke). Bewusst so
   * belassen (Fixliste 7, F13, Variante b): Sie nachträglich in JS
   * auszusortieren hieße für eine richtige Zählung („N von M einsehbar“) und
   * ein lückenloses Blättern, JEDE Treffer-Zeile samt Antworttext zu lesen -
   * gemessen 3,1-3,2 s bei 100.000 Zeilen für „kurs“ bzw. „vhs.example“
   * (benchmarks/conversationSearch.manual.js), mehr als das Doppelte der
   * Grenze von NAK-7 (1,5 s). Die Suche liefert so nie zu wenige Treffer,
   * höchstens zu viele; das Panel sagt es dann („steht nur in
   * Link-Adressen, HTML oder <think>“, hasVisibleHit im Frontend).
   * @param {string} search - getrimmter Suchbegriff (parseSearch)
   * @param {string} rows - Name der Unterabfrage mit den Spalten id, prompt,
   *   feedbackReason, feedbackText und answer_head
   * @returns {import("@prisma/client").Prisma.Sql} - boolescher Ausdruck über eine Zeile
   */
  _searchMatchSql: function (search, rows = "search_rows") {
    const { Prisma } = require("@prisma/client");
    const forms = searchForms(search);
    const probeSql = (expression, text) => {
      const probe = searchProbe(text);
      const tests = probe.values.map((value) =>
        probe.op === "instr"
          ? Prisma.sql`instr(${expression}, ${value}) > 0`
          : Prisma.sql`${expression} LIKE ${value} ESCAPE '\\'`
      );
      return { probe, sql: Prisma.sql`(${Prisma.join(tests, " OR ")})` };
    };
    // Genau: GLOB, wenn es Buchstaben außerhalb von ASCII mit zweiter
    // Schreibweise gibt, sonst LIKE (Groß/klein egal für A–Z).
    const exactSql = (expression, text) =>
      needsGlobCheck(text)
        ? Prisma.sql`${expression} GLOB ${searchGlobPattern(text)}`
        : Prisma.sql`${expression} LIKE ${searchLikePattern(text)} ESCAPE '\\'`;
    const matches = (expression) =>
      Prisma.sql`(${Prisma.join(
        forms.map((text) => {
          const { probe, sql } = probeSql(expression, text);
          return probe.exact
            ? sql
            : Prisma.sql`(${sql} AND ${exactSql(expression, text)})`;
        }),
        " OR "
      )})`;
    const anyExact = (expression) =>
      Prisma.sql`(${Prisma.join(
        forms.map((text) => exactSql(expression, text)),
        " OR "
      )})`;
    const head = Prisma.raw("answer_head");
    const headProbe = Prisma.join(
      forms.map((text) => probeSql(head, jsonEscaped(text)).sql),
      " OR "
    );
    // Der angezeigte Text der Antwort, aus der Zeile selbst gelesen.
    const visibleAnswer = visibleAnswerSql();
    const fromRow = (test) =>
      Prisma.sql`(SELECT ${test} FROM embed_chats AS search_source WHERE search_source.id = ${Prisma.raw(rows)}.id)`;
    // Der Anfang mit aufgelöstem \n (SQL-Literal: '\n' sind die beiden
    // Zeichen Rückstrich und n). Nur diese eine Maskierung: Ein zweites
    // replace (\") kostete je Zeile mehr, als es spart (Messung Fixliste 2,
    // R6: „kurs" 891 statt 1049 ms für das Prädikat allein über 100.000
    // Zeilen; Zeiten der ganzen Route: benchmarks/conversationSearch.manual.js).
    //
    // Genau verglichen wird nur der Text OHNE die beiden Zeichen ", am Ende
    // des Anfangs (headText): Sie gehören nur zur Vorprüfung. Sonst träfe
    // ein Begriff, der auf " endet und dessen Vorprüfung das Zeichen nicht
    // enthält (bei Umlauten prüft searchProbe nur einen ASCII-Abschnitt),
    // das Textende - „Kurs für"“ fände „… Kurs für“ (Fixliste 4, C1). In
    // beiden schnellen Zweigen ist der Anfang der Text plus ",: Endet der
    // Text selbst auf \", bleibt immer ein Rückstrich, und die Zeile wird
    // aus dem JSON gelesen.
    //
    // Das Kürzen kostet je Zeile (substr/length, bei mehrzeiligen Antworten
    // zusätzlich im replace) und lohnt nur, wenn ein Begriff die beiden
    // Zeichen überhaupt treffen kann: Ein Treffer, der über das Textende
    // hinausreicht, enthält immer das " – oder er ist das , allein. Ohne "
    // und , in allen Formen des Begriffs vergleicht die Suche deshalb gegen
    // den ganzen Anfang (Fixliste 5, S1; einmal je Anfrage entschieden).
    const tailSafe = forms.every((text) => !/[",]/.test(text));
    const headText = tailSafe
      ? head
      : Prisma.raw("substr(answer_head, 1, length(answer_head) - 2)");
    // Die Bedingung darf den ganzen Anfang lesen (", enthält keinen
    // Rückstrich), der Vergleich nur den Text.
    const answerPlain = Prisma.raw(`replace(answer_head, '\\n', char(10))`);
    const answerPlainText = tailSafe
      ? answerPlain
      : Prisma.raw(
          `replace(substr(answer_head, 1, length(answer_head) - 2), '\\n', char(10))`
        );
    return Prisma.sql`(${matches(Prisma.raw("prompt"))}
      OR ${matches(Prisma.raw("feedbackReason"))}
      OR ${matches(Prisma.raw("feedbackText"))}
      OR (CASE
        WHEN answer_head IS NULL THEN ${fromRow(matches(visibleAnswer))}
        WHEN NOT (${headProbe}) THEN 0
        WHEN instr(answer_head, '\\') = 0 THEN ${anyExact(headText)}
        WHEN instr(${answerPlain}, '\\') = 0 THEN ${anyExact(answerPlainText)}
        ELSE ${fromRow(anyExact(visibleAnswer))}
      END))`;
  },

  /**
   * Die Zeilen von embed_chats mit den Spalten, die die Suche liest
   * ({@link EmbedChats._searchMatchSql}) - answer_head einmal je Zeile
   * berechnet, ohne die ganze Antwort. LIMIT -1 (kein Limit) hält SQLite
   * davon ab, die Unterabfrage in die umgebende einzufalten (sonst stünde
   * answer_head an jeder Stelle neu).
   * @param {import("@prisma/client").Prisma.Sql} where - WHERE … über embed_chats
   * @param {string} [alias] - Name der Tabelle in der Bedingung
   * @returns {import("@prisma/client").Prisma.Sql} - "(…) AS search_rows"
   */
  _searchRowsSql: function (where, alias = "embed_chats") {
    const { Prisma } = require("@prisma/client");
    return Prisma.sql`(
      SELECT id, session_id, conversation_id, embed_id, createdAt, feedbackScore,
        prompt, feedbackReason, feedbackText,
        CASE
          WHEN substr(response, 1, 9) = '{"text":"' AND instr(response, '","') > 0
          THEN substr(response, 10, instr(response, '","') - 8)
        END as answer_head
      FROM embed_chats AS ${Prisma.raw(alias)}
      ${where}
      LIMIT -1
    ) AS search_rows`;
  },

  /**
   * Gruppierung der Konversationsliste (KIE-508/527): eine Zeile je
   * Konversation, mit Zählern für Feedback-Filter UND Badges.
   * Kanonische Quelle für Liste (conversationPage), Zähler
   * (countConversations) und Export - alle MÜSSEN dieselbe Gruppierung
   * verwenden, sonst driften Pagination-Zähler und Liste auseinander. Filter (Feedback, Abschnitt, Suche) greifen danach
   * ({@link EmbedChats._conversationSelection}), damit conversation_number
   * über die ungefilterte Menge vergeben bleibt.
   *
   * DSGVO (KIE-533): Nur Zeilen mit include = 1 - per markHistoryInvalid
   * zurückgesetzte Chats erscheinen nicht in der Liste.
   *
   * @param {number|null} embedId - NULL = alle Widgets ({@link EmbedChats._rowConditions})
   * @param {Date|null} startDate
   * @param {Date|null} endDate
   * @param {{maxId?: number|null, search?: string|null}} [options] - maxId
   *   (KIE-538): nur Zeilen bis zu dieser id (der Export hält damit seinen
   *   Stand fest, während er läuft); search: Suchbegriff - die Gruppe trägt
   *   dann search_hit (1, wenn eine ihrer Zeilen trifft, siehe
   *   {@link EmbedChats._searchMatchSql}). Der Begriff wird so für jede Zeile
   *   geprüft - nur ohne Feedback- und Abschnitts-Filter sinnvoll, siehe
   *   {@link EmbedChats._conversationSelection}.
   * @returns {import("@prisma/client").Prisma.Sql}
   */
  _conversationGroupsSql: function (
    embedId = null,
    startDate = null,
    endDate = null,
    { maxId = null, search = null } = {}
  ) {
    const { Prisma } = require("@prisma/client");
    const where = Prisma.join(
      EmbedChats._rowConditions({ embedId, startDate, endDate, maxId }),
      " "
    );
    // Suche: Die Konversation trifft, wenn eine ihrer gezählten Zeilen
    // trifft (MAX über den Treffer je Zeile). Der Treffer wird je Zeile in
    // einer Unterabfrage bestimmt, bevor gruppiert wird: Sonst trüge SQLite
    // Fragen und Antworten aller Zeilen durch die Sortierung der Gruppierung.
    // LIMIT -1 hält SQLite davon ab, die Unterabfrage in die Gruppierung
    // einzufalten. Ein Durchlauf über die Zeilen.
    const rows = search
      ? Prisma.sql`(
          SELECT id, session_id, conversation_id, embed_id, createdAt, feedbackScore,
            CASE WHEN ${EmbedChats._searchMatchSql(search)} THEN 1 ELSE 0 END as row_search_hit
          FROM ${EmbedChats._searchRowsSql(where)}
          LIMIT -1
        )`
      : Prisma.sql`embed_chats
      ${where}`;
    const searchHit = search
      ? Prisma.sql`,
        MAX(row_search_hit) as search_hit`
      : Prisma.empty;

    return Prisma.sql`
      SELECT
        COALESCE(conversation_id, session_id) as conversation_id,
        session_id,
        embed_id,
        MIN(id) as first_chat_id,
        MIN(createdAt) as started_at,
        MAX(createdAt) as last_message_at,
        COUNT(*) as message_count,
        SUM(CASE WHEN feedbackScore = 0 THEN 1 ELSE 0 END) as negative_count,
        SUM(CASE WHEN feedbackScore = 1 THEN 1 ELSE 0 END) as positive_count,
        ROW_NUMBER() OVER (ORDER BY MIN(createdAt) DESC, MIN(id) DESC) as conversation_number
        ${searchHit}
      FROM ${rows}
      GROUP BY COALESCE(conversation_id, session_id), session_id, embed_id`;
  },

  /**
   * Die Zeilen, die die Liste zählt: include = 1 (DSGVO), Widget, Zeitraum,
   * Stand des Exports - als WHERE-Teile über embed_chats. Die eine
   * Definition für Liste, Zähler und Export (auch _exportMessages,
   * Fixliste 7, F21). embedId null: alle Widgets (nur intern, etwa in
   * Tests; jede Route nennt ein Widget).
   * @param {{embedId: number|null, startDate: Date|null, endDate: Date|null, maxId: number|null}} params
   * @param {string|null} [alias] - Tabellenname vor den Spalten (EXISTS)
   * @returns {import("@prisma/client").Prisma.Sql[]}
   */
  _rowConditions: function (
    { embedId = null, startDate = null, endDate = null, maxId = null },
    alias = null
  ) {
    const { Prisma } = require("@prisma/client");
    const column = (name) => Prisma.raw(alias ? `${alias}.${name}` : name);
    const where = [Prisma.sql`WHERE ${column("include")} = 1`];
    if (embedId !== null)
      where.push(Prisma.sql`AND ${column("embed_id")} = ${embedId}`);
    if (startDate)
      where.push(Prisma.sql`AND ${column("createdAt")} >= ${startDate}`);
    if (endDate)
      where.push(Prisma.sql`AND ${column("createdAt")} <= ${endDate}`);
    if (maxId !== null) where.push(Prisma.sql`AND ${column("id")} <= ${maxId}`);
    return where;
  },

  /**
   * Die Auswahl der Konversationsliste - Gruppierung und Filter an einer
   * Stelle, für Liste, Zähler und Export: `FROM ${source} ${where}`.
   *
   * Ohne Suche: die Gruppierung ({@link EmbedChats._conversationGroupsSql})
   * und dahinter Feedback- und Abschnitts-Filter
   * ({@link EmbedChats.conversationFilterCondition}).
   *
   * Mit Suche wird der Begriff erst auf die Zeilen angewandt, die die anderen
   * Filter übrig lassen (Fixliste Punkt 7):
   * - ohne Feedback- und Abschnitts-Filter: ein Durchlauf über die Zeilen des
   *   Zeitraums, search_hit je Gruppe;
   * - mit einem dieser Filter: erst die Gruppen filtern, dann je
   *   verbliebener Konversation ihre gezählten Zeilen prüfen (EXISTS über
   *   den Index embed_id + session_id). Mit Abschnitt (Säulenklick) zählt
   *   die ganze Konversation - durchsucht werden dann nur die Konversationen
   *   des Abschnitts, nicht die ganze Historie.
   * @param {Object} params
   * @param {number|null} params.embedId
   * @param {Date|null} [params.startDate] - nur ohne startedBetween
   * @param {Date|null} [params.endDate]
   * @param {number|null} [params.maxId]
   * @param {"all"|"negative"|"positive"|boolean} [params.feedbackFilter]
   * @param {{start: Date, endExclusive: Date}|null} [params.startedBetween]
   * @param {string|null} [params.search]
   * @returns {{source: import("@prisma/client").Prisma.Sql, where: import("@prisma/client").Prisma.Sql}}
   */
  _conversationSelection: function ({
    embedId = null,
    startDate = null,
    endDate = null,
    maxId = null,
    feedbackFilter = "all",
    startedBetween = null,
    search = null,
  }) {
    const { Prisma } = require("@prisma/client");
    const between = EmbedChats.normalizeStartedBetween(startedBetween);
    // KIE-536: Mit Abschnitt zählt die ganze Konversation - ohne Zeitraum.
    const rows = {
      embedId,
      startDate: between ? null : startDate,
      endDate: between ? null : endDate,
      maxId,
    };
    const filter = EmbedChats.conversationFilterCondition(
      feedbackFilter,
      between
    );
    // Die Gruppierung dieser Zeilen (Fixliste 7, F27: eine Stelle statt
    // dreier Aufrufe mit kleinen Abweichungen)
    const groups = (extra = {}) =>
      EmbedChats._conversationGroupsSql(
        rows.embedId,
        rows.startDate,
        rows.endDate,
        { maxId, ...extra }
      );
    if (!search) return { source: Prisma.sql`(${groups()})`, where: filter };

    if (filter === Prisma.empty)
      return {
        source: Prisma.sql`(${groups({ search })})`,
        where: Prisma.sql`WHERE search_hit = 1`,
      };

    const conditions = Prisma.join(EmbedChats._rowConditions(rows, "c"), " ");
    const own = Prisma.sql`${conditions}
      AND c.embed_id = conversation_groups.embed_id
      AND c.session_id = conversation_groups.session_id
      AND COALESCE(c.conversation_id, c.session_id) = conversation_groups.conversation_id`;
    return {
      source: Prisma.sql`(${groups()}) AS conversation_groups`,
      where: EmbedChats._whereAnd(
        filter,
        Prisma.sql`EXISTS (
          SELECT 1 FROM ${EmbedChats._searchRowsSql(own, "c")}
          WHERE ${EmbedChats._searchMatchSql(search)}
        )`
      ),
    };
  },

  /**
   * Analytics: Anzahl Konversationen (für Pagination) — exakt dieselbe
   * Auswahl wie {@link EmbedChats.conversationPage}.
   * @param {number|null} embedId - NULL = alle Embeds
   * @param {Date|null} startDate
   * @param {Date|null} endDate
   * @param {"all"|"negative"|"positive"|boolean} feedbackFilter
   * @param {{start: Date, endExclusive: Date}|null} [startedBetween] - KIE-536, siehe conversationPage
   * @param {string|null} [search] - Suchbegriff, siehe conversationPage
   * @param {number|null} [maxId] - Stand der Liste, siehe conversationPage
   * @returns {Promise<number>}
   * @throws bei einem Datenbankfehler - eine 0 sähe aus wie „keine
   *   Konversationen" (Fixliste 2, R2); einziger Aufrufer ist
   *   {@link EmbedChats.conversationPage}
   */
  countConversations: async function (
    embedId = null,
    startDate = null,
    endDate = null,
    feedbackFilter = "all",
    startedBetween = null,
    search = null,
    maxId = null
  ) {
    const { source, where } = EmbedChats._conversationSelection({
      embedId,
      startDate,
      endDate,
      maxId,
      feedbackFilter,
      startedBetween,
      search,
    });
    const rows = await prisma.$queryRaw`
      SELECT COUNT(*) as count FROM ${source}
      ${where}
    `;
    return Number(rows[0]?.count || 0);
  },

  /**
   * Eine Seite der Konversationsliste samt Gesamtzahl - für
   * analytics/conversations. Liste und Zahl kommen aus EINER Abfrage
   * (COUNT(*) OVER () über die gefilterte Menge): Mit Suche ist jeder
   * Durchlauf über die Zeilen teuer (NAK-7). Nur wenn die Seite leer ist
   * und hinter dem Anfang geblättert wurde, zählt
   * {@link EmbedChats.countConversations} noch einmal.
   *
   * DSGVO: nur Zeilen mit include = 1 (KIE-533) - vom Besucher geleerte
   * Chats erscheinen nicht.
   * @param {number} embedId
   * @param {Object} options
   * @param {number} [options.offset]
   * @param {number} [options.limit]
   * @param {{lastMessageAt: number, firstChatId: number, maxId?: number|null}|null} [options.after] -
   *   Blättern über einen Schlüssel (Fixliste 7, F14): die Konversationen
   *   NACH dieser Zeile der Liste (letzte Nachricht absteigend, bei
   *   Gleichstand first_chat_id absteigend). Verschwindet zwischen zwei
   *   Seiten eine Konversation (Löschen, Aufbewahrungsfrist, vom Besucher
   *   geleert), rückt so keine andere über die Seitengrenze und fehlt.
   *   Nur zusammen mit offset 0. after.maxId: der Stand der ersten Seite
   *   (Fixliste 8, L2) - alle Seiten lesen nur Zeilen bis zu dieser id.
   *   Schreibt ein Besucher zwischen zwei Seiten weiter, rückte seine
   *   Konversation sonst (jüngere letzte Nachricht) vor den Schlüssel und
   *   fehlte still; so steht sie an ihrer Stelle des ersten Stands. Ohne
   *   after (erste Seite) wird der Stand jetzt festgehalten und mit der
   *   Seite geliefert.
   * @param {Date|null} [options.startDate]
   * @param {Date|null} [options.endDate]
   * @param {"all"|"negative"|"positive"|boolean} [options.feedbackFilter] -
   *   KIE-508/527: "negative" = nur Konversationen mit ≥1 👎, "positive" =
   *   nur mit ≥1 👍, sonst ungefiltert (Legacy true = "negative")
   * @param {{start: Date, endExclusive: Date}|null} [options.startedBetween] -
   *   KIE-536: nur Konversationen, deren erste vorhandene Nachricht
   *   (started_at) im halboffenen Intervall liegt; startDate und endDate
   *   bleiben dann unbeachtet ({@link EmbedChats._conversationSelection})
   * @param {string|null} [options.search] - Suchbegriff (getrimmt,
   *   parseSearch): nur Konversationen, von deren gezählten Zeilen
   *   mindestens eine ihn in Frage, angezeigtem Antworttext, Grund oder
   *   Kommentar enthält ({@link EmbedChats._searchMatchSql}); null = keine
   *   Suche
   * @returns {Promise<{conversations: Array, totalCount: number, hasMore: boolean, maxId: number|null}>}
   *   maxId: der Stand dieser Liste (höchste id des Widgets beim Laden der
   *   ersten Seite, Fixliste 9, A2); weitere Seiten nennen ihn in
   *   after.maxId
   * @throws bei einem Datenbankfehler: Die Route antwortet 500, die Liste
   *   zeigt „Fehler beim Laden" mit „Erneut versuchen" statt einer leeren
   *   Liste (Fixliste 2, R2). Protokolliert wird in der Route, ohne
   *   Meldungstext (Suchmuster).
   */
  conversationPage: async function (
    embedId,
    {
      offset = 0,
      limit = 20,
      after = null,
      startDate = null,
      endDate = null,
      feedbackFilter = "all",
      startedBetween = null,
      search = null,
    } = {}
  ) {
    // Stand der Liste (Fixliste 8, L2): weitere Seiten bringen ihn mit, die
    // erste hält ihn fest - die höchste id des Widgets (Fixliste 9, A2).
    const maxId = after
      ? after.maxId ?? null
      : await EmbedChats._currentMaxId(embedId);
    const { conversations, total, rest } = await EmbedChats._conversationList({
      embedId,
      offset,
      limit,
      after,
      maxId,
      startDate,
      endDate,
      feedbackFilter,
      startedBetween,
      search,
    });
    // Leere Seite: am Anfang gibt es nichts, dahinter muss gezählt werden.
    const totalCount =
      total ??
      (offset > 0 || after
        ? await EmbedChats.countConversations(
            embedId,
            startDate,
            endDate,
            feedbackFilter,
            startedBetween,
            search,
            maxId
          )
        : 0);
    return {
      conversations,
      totalCount,
      hasMore: rest > conversations.length,
      maxId,
    };
  },

  /**
   * Höchste id der Zeilen eines Widgets (0 ohne Zeile) - der Stand einer
   * Konversationsliste (Fixliste 8, L2) und des Exports. Je Widget, nicht
   * über die ganze Instanz (Fixliste 9, A2): Sonst läse ein Default-User an
   * der Liste seines Widgets ab, wie viele Chat-Zeilen in fremden Workspaces
   * entstehen. Ein Gang durch den Index des Widgets (embed_id, …; die id
   * steht in jedem Index), ohne Sortierung.
   * @param {number|null} [embedId] - null: alle Widgets (nur intern, wie
   *   {@link EmbedChats._rowConditions})
   * @returns {Promise<number|null>} - null, wenn die Datenbank keine Zahl
   *   liefert
   */
  _currentMaxId: async function (embedId = null) {
    const { Prisma } = require("@prisma/client");
    const [row] = await prisma.$queryRaw`
      SELECT MAX(id) AS max_id FROM embed_chats
      ${embedId === null ? Prisma.empty : Prisma.sql`WHERE embed_id = ${embedId}`}
    `;
    const value = Number(row?.max_id ?? 0);
    return Number.isSafeInteger(value) ? value : null;
  },

  /**
   * Kern von {@link EmbedChats.conversationPage}: eine Seite der gruppierten
   * Konversationen, sortiert nach letzter Nachricht (bei Gleichstand die
   * jüngere erste Zeile zuerst - feste Reihenfolge fürs Blättern), mit
   * Vorschau (erste Frage), Workspace und dem ersten Grund einer negativen
   * Bewertung. Wirft bei Datenbankfehlern.
   *
   * Die Zähler kommen aus derselben Abfrage: total (COUNT(*) OVER () vor
   * dem Schlüssel - alle Konversationen der Auswahl) und rest (nach dem
   * Schlüssel, ab dem Anfang dieser Seite - gibt es mehr als diese Seite?).
   * @param {Object} params - siehe conversationPage
   * @returns {Promise<{conversations: Array, total: number|null, rest: number}>} -
   *   total: Zahl der Konversationen über alle Seiten; null, wenn die Seite
   *   leer ist
   */
  _conversationList: async function ({
    embedId = null,
    offset = 0,
    limit = 20,
    after = null,
    maxId = null,
    startDate = null,
    endDate = null,
    feedbackFilter = "all",
    startedBetween = null,
    search = null,
  }) {
    const { Prisma } = require("@prisma/client");
    const between = EmbedChats.normalizeStartedBetween(startedBetween);
    // KIE-508/527: Gruppierung, Filter und Suche kommen aus der gemeinsamen
    // Auswahl (auch von countConversations und dem Export benutzt) - so
    // bleiben Liste, Pagination und conversation_number konsistent.
    // include = 1 (DSGVO) ist Teil der Gruppierung.
    const { source, where } = EmbedChats._conversationSelection({
      embedId,
      startDate,
      endDate,
      maxId,
      feedbackFilter,
      startedBetween: between,
      search,
    });
    const columns = Prisma.sql`conversation_id,
        session_id,
        embed_id,
        first_chat_id,
        started_at,
        last_message_at,
        message_count,
        negative_count,
        positive_count,
        conversation_number`;
    // Ohne Schlüssel (erste Seite, Nachladen nach dem Löschen) ist rest die
    // ganze Auswahl ab offset - ein Fenster genügt. Mit Schlüssel greift er
    // außen: total zählt die ganze Auswahl, rest nur, was danach kommt
    // (Fixliste 7, F14; das zweite Fenster kostet rund 2 %, deshalb nur
    // hier).
    const conversations = after
      ? await prisma.$queryRaw`
          SELECT ${columns}, total_count, COUNT(*) OVER () as rest_count
          FROM (
            SELECT ${columns}, COUNT(*) OVER () as total_count
            FROM ${source}
            ${where}
          ) AS listed
          WHERE last_message_at < ${after.lastMessageAt}
            OR (last_message_at = ${after.lastMessageAt} AND first_chat_id < ${after.firstChatId})
          ORDER BY last_message_at DESC, first_chat_id DESC
          LIMIT ${limit}
          OFFSET ${offset}
        `
      : await prisma.$queryRaw`
          SELECT ${columns}, COUNT(*) OVER () as total_count
          FROM ${source}
          ${where}
          ORDER BY last_message_at DESC, first_chat_id DESC
          LIMIT ${limit}
          OFFSET ${offset}
        `;

    // Convert BigInt to Number for JSON serialization
    const conversationsNormalized = conversations.map((conv) => ({
      conversation_id: conv.conversation_id,
      session_id: conv.session_id,
      embed_id: Number(conv.embed_id),
      first_chat_id: Number(conv.first_chat_id),
      started_at: rawInstant(conv.started_at),
      last_message_at: rawInstant(conv.last_message_at),
      message_count: Number(conv.message_count),
      negative_count: Number(conv.negative_count) || 0, // KIE-508
      positive_count: Number(conv.positive_count) || 0, // KIE-527
      conversation_number: Number(conv.conversation_number),
    }));
    const total =
      conversations.length > 0 ? Number(conversations[0].total_count) : null;
    // Was ab dem Anfang dieser Seite noch kommt (OFFSET liegt darin)
    const rest =
      conversations.length > 0
        ? Number(conversations[0].rest_count ?? conversations[0].total_count) -
          offset
        : 0;

    // Get preview texts and embed info for all conversations in one query (performance optimization)
    if (conversationsNormalized.length > 0) {
      const firstChatIds = conversationsNormalized.map((c) => c.first_chat_id);
      // Vorschau/Workspace und der erste Grund hängen nur von der Seite ab:
      // nebeneinander (Fixliste 7, F30).
      const [firstChats, reasons] = await Promise.all([
        prisma.embed_chats.findMany({
          where: { id: { in: firstChatIds } },
          select: {
            id: true,
            prompt: true,
            embed_config: {
              select: {
                workspace: {
                  select: {
                    name: true,
                  },
                },
              },
            },
          },
        }),
        EmbedChats._firstNegativeReasons(
          conversationsNormalized,
          between ? null : startDate,
          between ? null : endDate
        ),
      ]);

      // Map previews and embed info to conversations
      const dataMap = new Map(
        firstChats.map((chat) => [
          chat.id,
          {
            preview:
              chat.prompt.substring(0, 100) +
              (chat.prompt.length > 100 ? "..." : ""),
            workspace: chat.embed_config?.workspace?.name || null,
          },
        ])
      );

      for (const conv of conversationsNormalized) {
        const data = dataMap.get(conv.first_chat_id);
        conv.preview = data?.preview || "";
        conv.workspace = data?.workspace || null;
        conv.first_negative_reason =
          reasons.get(EmbedChats._widgetGroupKey(conv)) ?? null;
      }
    }

    return { conversations: conversationsNormalized, total, rest };
  },

  /**
   * Schlüssel einer Konversation über Widgets hinweg: Widget, Kennung und
   * Browser-Sitzung - in der globalen Sicht (embedId null) können zwei
   * Widgets dieselbe Kennung und Sitzung tragen.
   * @param {{embed_id: number, conversation_id: string, session_id: string}} conversation
   * @returns {string}
   */
  _widgetGroupKey: function ({ embed_id, conversation_id, session_id }) {
    return `${Number(embed_id)}\u0000${EmbedChats._exportGroupKey({
      conversation_id,
      session_id,
    })}`;
  },

  /**
   * Erster Grund einer negativen Bewertung je Konversation der Seite - für
   * die Zeile der Liste („Grund: Unvollständig"). Eine Abfrage für die ganze
   * Seite, gebunden an die Widgets der Konversationen; dieselben Zeilen wie
   * die Liste (include = 1, im Zeitraum).
   * @param {Array<{conversation_id: string, session_id: string, embed_id: number, negative_count: number}>} conversations
   * @param {Date|null} startDate
   * @param {Date|null} endDate
   * @returns {Promise<Map<string, string>>} - Schlüssel: {@link EmbedChats._widgetGroupKey}
   */
  _firstNegativeReasons: async function (conversations, startDate, endDate) {
    const rated = conversations.filter((conv) => conv.negative_count > 0);
    const reasons = new Map();
    if (rated.length === 0) return reasons;
    const wanted = new Set(rated.map(EmbedChats._widgetGroupKey));
    const { Prisma } = require("@prisma/client");
    const embedIds = [...new Set(rated.map((conv) => Number(conv.embed_id)))];
    const sessions = [...new Set(rated.map((conv) => conv.session_id))];
    // Die Zeilen der Liste (include = 1, im Zeitraum; _rowConditions) der
    // Sitzungen dieser Seite - über den Index (embed_id, session_id),
    // erzwungen, sofern es ihn gibt (withIndexHint, Fixliste 9, A3): Ohne
    // Statistiken nahm SQLite für ORDER BY createdAt bzw. den Zeitraum den
    // Index (embed_id, createdAt) und las je Listenseite alle Zeilen des
    // Widgets im Zeitraum. Sortiert werden danach nur die negativ
    // bewerteten Zeilen dieser Sitzungen.
    const rows = await withIndexHint(
      SESSION_INDEX,
      (hint) => prisma.$queryRaw`
        SELECT embed_id, session_id, conversation_id, feedbackReason
        FROM embed_chats ${hint}
        ${Prisma.join(EmbedChats._rowConditions({ startDate, endDate }), " ")}
          AND embed_id IN (${Prisma.join(embedIds)})
          AND session_id IN (${Prisma.join(sessions)})
          AND feedbackScore = 0
          AND feedbackReason IS NOT NULL
        ORDER BY createdAt ASC, id ASC
      `
    );
    for (const row of rows) {
      const key = EmbedChats._widgetGroupKey({
        embed_id: Number(row.embed_id),
        conversation_id: row.conversation_id ?? row.session_id,
        session_id: row.session_id,
      });
      if (!wanted.has(key) || reasons.has(key)) continue;
      if (String(row.feedbackReason).trim() === "") continue;
      reasons.set(key, row.feedbackReason);
    }
    return reasons;
  },

  /**
   * KIE-503: Listet die Konversationen einer Widget-Session für den öffentlichen
   * Embed-Endpoint ("Frühere Chats"). BOLA/IDOR-Härtung analog KIE-505: die Liste
   * ist strikt an embed_id UND session_id gebunden — es werden ausschließlich
   * Konversationen der anfragenden Session geliefert. DSGVO/Reset-invalidierte
   * Chats (include = 0, via markHistoryInvalid) werden nicht mitgezählt.
   * @param {number} embedId - The embed config ID (scope)
   * @param {string} sessionId - The owning browser session
   * @param {number} [limit=50] - Maximum number of conversations to return
   * @returns {Promise<Array<{conversationId: string, title: string, startedAt: number, lastMessageAt: number, messageCount: number}>>}
   *   Conversation summaries sorted by lastMessageAt DESC. Title is the first
   *   prompt truncated to 80 characters.
   */
  listConversationsForSession: async function (
    embedId = null,
    sessionId = null,
    limit = 50
  ) {
    if (!embedId || !sessionId) return [];

    try {
      // Group chats of THIS session into conversations. Legacy rows without a
      // conversation_id fall back to the session_id bucket (KIE-502 pattern).
      const rows = await prisma.$queryRaw`
        SELECT
          COALESCE(conversation_id, session_id) as conversation_id,
          MIN(id) as first_chat_id,
          MIN(createdAt) as started_at,
          MAX(createdAt) as last_message_at,
          COUNT(*) as message_count
        FROM embed_chats
        WHERE embed_id = ${Number(embedId)}
          AND session_id = ${String(sessionId)}
          AND include = 1
        GROUP BY COALESCE(conversation_id, session_id)
        ORDER BY last_message_at DESC
        LIMIT ${Number(limit)}
      `;

      // Convert BigInt to Number for JSON serialization
      const conversations = rows.map((row) => ({
        conversationId: row.conversation_id,
        first_chat_id: Number(row.first_chat_id),
        startedAt: rawInstant(row.started_at),
        lastMessageAt: rawInstant(row.last_message_at),
        messageCount: Number(row.message_count),
      }));
      if (conversations.length === 0) return [];

      // Load all titles (first prompt per conversation) in ONE query — no N+1.
      // embed_id + session_id zusätzlich zum id-Filter (Defense-in-Depth): die
      // ids stammen zwar aus der bereits scope-gebundenen Raw-Query, aber so
      // bleibt der Lookup auch bei künftigen Änderungen dort session-gebunden.
      const firstChats = await prisma.embed_chats.findMany({
        where: {
          id: { in: conversations.map((c) => c.first_chat_id) },
          embed_id: Number(embedId),
          session_id: String(sessionId),
        },
        select: { id: true, prompt: true },
      });
      const titleMap = new Map(
        firstChats.map((chat) => [
          chat.id,
          String(chat.prompt || "").slice(0, 80),
        ])
      );

      return conversations.map(({ first_chat_id, ...conv }) => ({
        ...conv,
        title: titleMap.get(first_chat_id) || "",
      }));
    } catch (error) {
      console.error("listConversationsForSession error:", error.message);
      return [];
    }
  },

  /**
   * Analytics: Get all messages for a specific conversation
   * KIE-538: derselbe Begriff von „Konversation" wie Liste, Export und
   * Löschen ({@link EmbedChats._conversationScope}) - die Konversation der
   * Zeile, nicht alle Konversationen der Browser-Sitzung und nicht die Zeilen
   * einer anderen Sitzung mit derselben Kennung. Angezeigt werden nur Zeilen
   * mit include = 1, wie in der Liste; ohne Zeitraum (Öffnen per Link).
   * @param {number|string} chatId - id einer Zeile der Konversation; die Liste nennt die erste (first_chat_id)
   * @param {number} embedId - The embed config ID
   * @returns {Promise<Array>} Array of chat messages - leer, wenn die Angaben
   *   keine Konversation des Widgets bezeichnen
   * @throws bei einem Datenbankfehler: Die Route antwortet dann 500, das
   *   Panel zeigt „konnte nicht geladen werden" mit „Erneut versuchen" - nicht
   *   „nicht gefunden" (Fixliste 2, R1)
   */
  getConversationDetails: async function (chatId, embedId) {
    const scope = await EmbedChats._conversationScope(embedId, chatId);
    if (!scope) return [];
    // Angezeigt wird nur, was die Liste zählt: Vom Besucher geleerte Zeilen
    // (include = 0, markHistoryInvalid) bleiben verborgen. Löschen und
    // Lösch-Vorschau meinen dagegen alle Zeilen (_conversationScope).
    // Erst die ids in ihrer Reihenfolge (_conversationRowIds), dann die
    // Zeilen selbst über den Primärschlüssel.
    const ids = await EmbedChats._conversationRowIds(scope);
    if (ids.length === 0) return [];
    const rows = await prisma.embed_chats.findMany({
      where: { id: { in: ids }, embed_id: scope.id },
      select: {
        id: true,
        prompt: true,
        response: true,
        createdAt: true,
        conversation_id: true,
        session_id: true,
        feedbackScore: true, // KIE-504: 👍/👎-Anzeige im Admin
        feedbackText: true, // KIE-507: Freitext bei 👎
        feedbackReason: true, // KIE-507: 1-Klick-Grund bei 👎
      },
    });
    const byId = new Map(rows.map((row) => [row.id, row]));
    return EmbedChats.withoutProtocolMarkers(
      ids.map((id) => byId.get(id)).filter(Boolean)
    );
  },

  /**
   * Die ids der angezeigten Zeilen (include = 1) einer Konversation, nach
   * Zeitpunkt - über den Index (embed_id, session_id), erzwungen, sofern es
   * ihn gibt (withIndexHint, Fixliste 9, A3): Ohne Statistiken nahm SQLite
   * für ORDER BY createdAt den Index (embed_id, createdAt) und las bei
   * jedem Öffnen alle Zeilen des Widgets (100.000 Zeilen: 189 ms statt
   * 2 ms).
   * @param {{sql: import("@prisma/client").Prisma.Sql}} scope - aus
   *   {@link EmbedChats._conversationScope}
   * @returns {Promise<number[]>}
   */
  _conversationRowIds: async function (scope) {
    const rows = await withIndexHint(
      SESSION_INDEX,
      (hint) => prisma.$queryRaw`
        SELECT id FROM embed_chats ${hint}
        WHERE ${scope.sql} AND include = 1
        ORDER BY createdAt ASC, id ASC
      `
    );
    return rows.map((row) => Number(row.id));
  },

  /**
   * KIE-538: Die Zeilen EINER Konversation eines Widgets - derselbe Begriff
   * wie in der Liste ({@link EmbedChats._conversationGroupsSql}): dieselbe
   * Browser-Sitzung UND dieselbe Kennung COALESCE(conversation_id,
   * session_id). Andere Konversationen derselben Sitzung gehören nicht dazu.
   *
   * Bezeichnet wird die Konversation über die id einer ihrer Zeilen (die
   * Liste nennt die erste, first_chat_id), nicht über ihre Kennung: Die
   * conversation_id vergibt der Besucher (der öffentliche Chat-Endpunkt
   * speichert sie ungeprüft). Sendet eine zweite Sitzung dieselbe Kennung,
   * sind das in der Liste zwei Konversationen - und hier auch; über die
   * Kennung allein würde mit der einen die andere gelöscht.
   *
   * Ohne include-Filter: Gemeint sind alle Zeilen, auch die vom Besucher
   * geleerten.
   * @param {number|string} embedId
   * @param {number|string} chatId - Zahl oder Ziffernfolge (Pfadabschnitt)
   * @param {object} [client] - prisma oder eine Transaktion
   * @returns {Promise<{id: number, sessionId: string, where: object, sql: import("@prisma/client").Prisma.Sql}|null>} -
   *   where für Prisma, sql dieselben Bedingungen für eine Raw-Abfrage über
   *   embed_chats (ohne WHERE); null, wenn die Angaben kein Widget und keine
   *   seiner Zeilen bezeichnen
   */
  _conversationScope: async function (embedId, chatId, client = prisma) {
    const id = Number(embedId);
    const rowId =
      typeof chatId === "string" && /^[1-9]\d*$/.test(chatId)
        ? Number(chatId)
        : chatId;
    // Die Spalten sind INT4: Eine größere Zahl bezeichnet keine Zeile - und
    // Prisma lehnte sie mit einem Validierungsfehler ab (500 statt „nicht
    // gefunden", Fixliste 3, C3).
    if (!Number.isInteger(id) || id <= 0 || id > INT4_MAX) return null;
    if (!Number.isSafeInteger(rowId) || rowId <= 0 || rowId > INT4_MAX)
      return null;

    const row = await client.embed_chats.findFirst({
      where: { id: rowId, embed_id: id },
      select: { conversation_id: true, session_id: true },
    });
    if (!row) return null;
    const key = row.conversation_id ?? row.session_id;
    const { Prisma } = require("@prisma/client");
    return {
      id,
      sessionId: row.session_id,
      where: {
        embed_id: id,
        session_id: row.session_id,
        OR: [
          { conversation_id: key },
          { conversation_id: null, session_id: key },
        ],
      },
      sql: Prisma.sql`embed_id = ${id} AND session_id = ${row.session_id}
        AND (conversation_id = ${key} OR (conversation_id IS NULL AND session_id = ${key}))`,
    };
  },

  /**
   * KIE-538: Löscht eine Konversation eines Widgets - alle ihre Zeilen, auch
   * die mit include = 0: Wer die Löschung einer Konversation verlangt, meint
   * auch das, was der Besucher im Widget bereits geleert hat.
   * Eine einzige Löschanweisung, gebunden an embed_id, Sitzung UND Kennung
   * ({@link EmbedChats._conversationScope}); die Zeile eines anderen Widgets
   * bezeichnet hier keine Konversation. Das Zählerbuch (message_ledger) wird
   * nicht angefasst - Kennzahlen, Diagramm und Kontingent bleiben, wie sie
   * sind (KIE-532).
   * @param {number|string} embedId
   * @param {number|string} chatId - id einer Zeile der Konversation (first_chat_id der Liste)
   * @returns {Promise<number|null>} - Zahl der gelöschten Zeilen; null bei einem Datenbankfehler
   */
  deleteConversation: async function (embedId, chatId) {
    try {
      const scope = await EmbedChats._conversationScope(embedId, chatId);
      if (!scope) return 0;
      const { count } = await prisma.embed_chats.deleteMany({
        where: scope.where,
      });
      return count;
    } catch (error) {
      console.error("deleteConversation error:", error.message);
      return null;
    }
  },

  /**
   * KIE-538: Konversationen und Zeilen einer Browser-Sitzung in einem Widget
   * (alle Zeilen, auch include = 0) - in einer Abfrage. maxId: die höchste
   * id dieser Zeilen (0 ohne Zeile) - bindet die Rückfrage an genau diese
   * Zeilen (Fixliste 8, L1).
   * @param {number} id - Widget
   * @param {string} sessionId
   * @param {object} [client] - prisma oder eine Transaktion
   * @returns {Promise<{conversationCount: number, messageCount: number, maxId: number}>}
   */
  _sessionTotals: async function (id, sessionId, client = prisma) {
    const [row] = await client.$queryRaw`
      SELECT
        COUNT(*) as messages,
        COUNT(DISTINCT COALESCE(conversation_id, session_id)) as conversations,
        MAX(id) as max_id
      FROM embed_chats
      WHERE embed_id = ${id} AND session_id = ${sessionId}
    `;
    return {
      conversationCount: Number(row?.conversations || 0),
      messageCount: Number(row?.messages || 0),
      maxId: Number(row?.max_id || 0),
    };
  },

  /**
   * KIE-538: Was das Löschen einer Konversation entfernen würde - nur Zahlen,
   * keine Inhalte und keine Sitzungs-Kennung. `visitor` nennt, was die
   * Browser-Sitzung dieser Konversation im selben Widget insgesamt hat
   * (einschließlich dieser Konversation); null, wenn es die Konversation
   * nicht (mehr) gibt. Beide Zählungen hängen nur von der Konversation ab
   * und laufen nebeneinander (Fixliste 7, F31).
   * @param {number|string} embedId
   * @param {number|string} chatId - id einer Zeile der Konversation (first_chat_id der Liste)
   * @returns {Promise<{messageCount: number, visitor: {conversationCount: number, messageCount: number, maxId: number}|null}|null>}
   *   null bei einem Datenbankfehler
   */
  conversationDeletionPreview: async function (embedId, chatId) {
    try {
      const scope = await EmbedChats._conversationScope(embedId, chatId);
      if (!scope) return { messageCount: 0, visitor: null };
      const [messageCount, visitor] = await Promise.all([
        prisma.embed_chats.count({ where: scope.where }),
        EmbedChats._sessionTotals(scope.id, scope.sessionId),
      ]);
      return { messageCount, visitor };
    } catch (error) {
      console.error("conversationDeletionPreview error:", error.message);
      return null;
    }
  },

  /**
   * KIE-538 (AK-12): Löscht alle Konversationen der Browser-Sitzung, zu der
   * diese Konversation gehört - in diesem Widget, alle Zeilen (auch
   * include = 0). Konversationen anderer Sitzungen und anderer Widgets
   * bleiben, auch wenn sie dieselbe Kennung tragen. Die Sitzung bestimmt der
   * Server aus der Zeile ({@link EmbedChats._conversationScope}); das
   * Zählerbuch wird nicht angefasst.
   *
   * Gelöscht wird nur, was die Rückfrage bestätigt hat (Fixliste 7, F10):
   * Nennt `expected` die Zahlen der Vorschau, prüft eine Transaktion -
   * zählen und löschen gemeinsam oder gar nicht -, ob die Sitzung noch genau
   * so viele Konversationen und Nachrichten hat und - mit `expected.maxId`
   * - ob ihre jüngste Zeile noch dieselbe ist (Fixliste 8, L1: Fällt eine
   * alte Zeile weg und kommt zugleich eine neue hinzu, stimmen die Zahlen
   * wieder, die Zeilen aber nicht). Hat sich etwas geändert (der Besucher
   * hat weiter geschrieben, die Aufbewahrungsfrist oder jemand anderes hat
   * gelöscht), wird nichts gelöscht: Ergebnis `changed` mit dem neuen
   * Stand, die Ansicht fragt mit diesen Zahlen neu. Gelöscht werden
   * zusätzlich nur Zeilen bis einschließlich dieser maxId - nie eine Zeile,
   * die nach dem Zählen hinzukam.
   * Ohne `expected` (API) löscht die Transaktion den Stand, den sie zählt -
   * Antwort und Protokoll nennen dieselben Zahlen wie die Löschung.
   * @param {number|string} embedId
   * @param {number|string} chatId - id einer Zeile der Konversation (first_chat_id der Liste)
   * @param {{conversationCount: number, messageCount: number, maxId?: number}|null} [expected] -
   *   was die Rückfrage genannt hat (visitor der Vorschau); maxId fehlt nur
   *   bei Aufrufern vor Fixliste 8
   * @returns {Promise<{deletedCount: number, conversationCount: number, changed?: {conversationCount: number, messageCount: number, maxId: number}}|null>}
   *   null bei einem Datenbankfehler
   */
  deleteVisitorConversations: async function (
    embedId,
    chatId,
    expected = null
  ) {
    try {
      return await prisma.$transaction(async (tx) => {
        const scope = await EmbedChats._conversationScope(embedId, chatId, tx);
        if (!scope) return { deletedCount: 0, conversationCount: 0 };
        const totals = await EmbedChats._sessionTotals(
          scope.id,
          scope.sessionId,
          tx
        );
        if (
          expected &&
          (expected.conversationCount !== totals.conversationCount ||
            expected.messageCount !== totals.messageCount ||
            (expected.maxId !== undefined && expected.maxId !== totals.maxId))
        )
          return { deletedCount: 0, conversationCount: 0, changed: totals };
        const { count } = await tx.embed_chats.deleteMany({
          where: {
            embed_id: scope.id,
            session_id: scope.sessionId,
            id: { lte: totals.maxId },
          },
        });
        return {
          deletedCount: count,
          conversationCount: totals.conversationCount,
        };
      });
    } catch (error) {
      console.error("deleteVisitorConversations error:", error.message);
      return null;
    }
  },

  /**
   * KIE-538: Die Konversationen einer Auswahl für den Export, EINMAL
   * bestimmt - mit und ohne Suche (Fixliste 7, F01/F09; vorher blätterte der
   * Export ohne Suche über einen Schlüssel und baute dafür je Seite die ganze
   * Gruppierung neu: quadratisch in der Größe des Widgets, und Nummern
   * konnten sich zwischen den Seiten verschieben). Dieselbe Gruppierung,
   * dieselbe Nummer und dieselben Filter wie die Liste
   * ({@link EmbedChats._conversationSelection}), in der Reihenfolge der
   * laufenden Nummer (Beginn absteigend, bei Gleichstand first_chat_id
   * absteigend).
   *
   * Je Konversation nur Kennung, Sitzung und zwei Zahlen (rund 200 Byte im
   * Speicher). Kennung und Sitzung stammen aus der Gruppierung selbst, nicht
   * aus ihrer ersten Zeile: Wird diese während des Exports gelöscht
   * (Aufbewahrungsfrist), bleiben die übrigen Zeilen im Export (Fixliste 3,
   * C2). Mit Suche ist die Menge hart begrenzt (Fixliste 3, C10).
   * @param {Object} selection
   * @param {number} selection.embedId
   * @param {Date|null} selection.startDate
   * @param {Date|null} selection.endDate
   * @param {"all"|"negative"|"positive"|boolean} selection.feedbackFilter
   * @param {{start: Date, endExclusive: Date}|null} selection.startedBetween - bereits normalisiert
   * @param {number} selection.maxId
   * @param {string|null} [selection.search]
   * @returns {Promise<Array<{conversation_id: string, session_id: string, message_count: number, conversation_number: number}>>}
   * @throws {Error} code EXPORT_TOO_MANY_HITS (mit max), wenn es mit Suche
   *   mehr als EXPORT_SEARCH_MAX_HITS Treffer gibt - und bei einem
   *   Datenbankfehler
   */
  _exportConversations: async function ({
    embedId,
    startDate,
    endDate,
    feedbackFilter,
    startedBetween,
    maxId,
    search = null,
  }) {
    const { Prisma } = require("@prisma/client");
    const { source, where } = EmbedChats._conversationSelection({
      embedId,
      startDate,
      endDate,
      maxId,
      feedbackFilter,
      startedBetween,
      search,
    });
    // über das Objekt gelesen: Tests setzen eine kleinere Grenze
    const max = EmbedChats.EXPORT_SEARCH_MAX_HITS;
    const rows = await prisma.$queryRaw`
      SELECT conversation_id, session_id, message_count, conversation_number
      FROM ${source}
      ${where}
      ORDER BY started_at DESC, first_chat_id DESC
      ${search ? Prisma.sql`LIMIT ${max + 1}` : Prisma.empty}
    `;
    if (search && rows.length > max)
      throw Object.assign(
        new Error(`Export mit Suche: mehr als ${max} Treffer-Konversationen`),
        { code: "EXPORT_TOO_MANY_HITS", max }
      );
    return rows.map((row) => ({
      conversation_id: row.conversation_id,
      session_id: row.session_id,
      message_count: Number(row.message_count),
      conversation_number: Number(row.conversation_number),
    }));
  },

  /**
   * KIE-538: Die Nachrichten eines Pakets von Konversationen - genau die
   * Zeilen, die die Liste für diese Konversationen zählt (dieselben
   * Bedingungen: {@link EmbedChats._rowConditions}, Fixliste 7, F21). Von der
   * Antwort wird nur der angezeigte Text gelesen: bei einem JSON-Objekt das
   * Feld text, sonst die Antwort wörtlich - wie Liste, Suche und Panel
   * (Fixliste 7, F17). Quellen-Texte, Kurskarten und alles Übrige aus
   * `response` verlassen die Datenbank nicht; ebenso wenig
   * connection_information.
   *
   * Gelesen werden nur die Zeilen der Paare (Kennung, Sitzung) des Pakets
   * (Fixliste 7, F11): Dieselbe, vom Besucher gewählte Kennung in anderen
   * Sitzungen kommt nicht aus der Datenbank - die Paketgrenze gilt so auch
   * für die gelesene Menge.
   * @param {Object} batch
   * @param {number} batch.embedId
   * @param {Array<{conversation_id: string, session_id: string}>} batch.groups
   * @param {Date|null} batch.startDate
   * @param {Date|null} batch.endDate
   * @param {{start: Date, endExclusive: Date}|null} batch.startedBetween
   * @param {number} batch.maxId
   * @returns {Promise<Map<string, Array<import("../utils/helpers/chat/embedConversationExport").ExportMessage>>>}
   *   Schlüssel: {@link EmbedChats._exportGroupKey}
   */
  _exportMessages: async function ({
    embedId,
    groups,
    startDate,
    endDate,
    startedBetween,
    maxId,
  }) {
    const { Prisma } = require("@prisma/client");
    // Wie in der Liste: Mit Abschnitts-Filter zählt die ganze Konversation.
    const where = EmbedChats._rowConditions({
      embedId,
      startDate: startedBetween ? null : startDate,
      endDate: startedBetween ? null : endDate,
      maxId,
    });
    const sessions = [...new Set(groups.map((group) => group.session_id))];
    // session_id IN (…) über den Index (embed_id, session_id); das Paar
    // bindet jede Zeile an genau eine Konversation des Pakets. Der Index ist
    // erzwungen (INDEXED BY, Fixliste 8, M2), sofern es ihn gibt
    // (withIndexHint, Fixliste 9, A1): Ohne Statistiken (sqlite_stat1 - in
    // Produktion läuft weder ANALYZE noch PRAGMA optimize) wählte SQLite
    // wegen ORDER BY createdAt bzw. des Zeitraums den Index (embed_id,
    // createdAt) und las je Paket alle Zeilen des Widgets im Zeitraum - der
    // Export wuchs quadratisch (100.000 Zeilen: 121 s statt rund 5 s).
    // Sortiert werden danach höchstens die Zeilen von
    // EXPORT_BATCH_CONVERSATIONS Konversationen.
    const pairs = Prisma.join(
      groups.map(
        (group) => Prisma.sql`(${group.conversation_id}, ${group.session_id})`
      )
    );

    const rows = await withIndexHint(
      SESSION_INDEX,
      (hint) => prisma.$queryRaw`
      SELECT
        id,
        session_id,
        conversation_id,
        createdAt,
        prompt,
        ${visibleAnswerSql()} AS answer,
        feedbackScore,
        feedbackText,
        feedbackReason
      FROM embed_chats ${hint}
      ${Prisma.join(where, " ")}
        AND session_id IN (${Prisma.join(sessions)})
        AND (COALESCE(conversation_id, session_id), session_id) IN (VALUES ${pairs})
      ORDER BY createdAt ASC, id ASC
    `
    );

    const byGroup = new Map();
    for (const row of rows) {
      const key = EmbedChats._exportGroupKey({
        conversation_id: row.conversation_id ?? row.session_id,
        session_id: row.session_id,
      });
      if (!byGroup.has(key)) byGroup.set(key, []);
      const at = rawInstant(row.createdAt);
      byGroup.get(key).push({
        createdAt: new Date(at ?? NaN),
        prompt: row.prompt,
        answer:
          typeof row.answer === "string"
            ? stripProtocolMarkers(row.answer)
            : null,
        // SQLite kennt nur 0/1; je nach Treiber kommt die Spalte als Zahl
        // oder als Wahrheitswert zurück.
        feedbackScore:
          row.feedbackScore === null || row.feedbackScore === undefined
            ? null
            : Number(row.feedbackScore) === 1,
        feedbackText: row.feedbackText ?? null,
        feedbackReason: row.feedbackReason ?? null,
      });
    }
    return byGroup;
  },

  /** Schlüssel einer Konversation der Liste: Kennung und Browser-Sitzung. */
  _exportGroupKey: function ({ conversation_id, session_id }) {
    return `${conversation_id}\u0000${session_id}`;
  },

  /**
   * KIE-538: Die Konversationen einer Auswahl samt ihren Nachrichten, für den
   * Export. Dieselben Parameter und dieselbe Menge wie die Liste
   * ({@link EmbedChats.conversationPage} über alle Seiten): Gruppierung,
   * Zeitraum, Feedback-Filter, Abschnitts-Filter, Suche, include = 1 - was
   * die Liste nicht zeigt, kommt hier nicht vor. Je Konversation die Zeilen,
   * die die Liste zählt (message_count), nach Zeitpunkt.
   *
   * Reihenfolge: nach der laufenden Nummer der Liste (jüngster Beginn
   * zuerst), darin nach Zeitpunkt.
   *
   * `conversationId` ist die conversation_id. Hat eine Konversation keine
   * eigene (Alt-Zeilen; die Liste zeigt dann die session_id), ist sie null:
   * Die Kennung der Browser-Sitzung gehört nicht in den Export.
   *
   * Die Konversationen (ohne Inhalte) werden EINMAL bestimmt
   * ({@link EmbedChats._exportConversations}) - Menge, Reihenfolge und
   * Nummern stehen damit für den ganzen Export fest, auch wenn währenddessen
   * Zeilen gelöscht oder vom Besucher geleert werden (Fixliste 7, F09). Die
   * Nachrichten werden danach paketweise gelesen (siehe EXPORT_* oben).
   * Zu Beginn wird die höchste id des Widgets festgehalten: Nachrichten, die
   * während des Exports entstehen, kommen nicht hinein. Datenbankfehler
   * werden nicht geschluckt - eine abgeschnittene Datei darf nicht wie eine
   * vollständige aussehen.
   *
   * @param {number} embedId
   * @param {Object} [selection]
   * @param {Date|null} [selection.startDate]
   * @param {Date|null} [selection.endDate]
   * @param {"all"|"negative"|"positive"|boolean} [selection.feedbackFilter]
   * @param {{start: Date, endExclusive: Date}|null} [selection.startedBetween]
   * @param {string|null} [selection.search] - Suchbegriff wie in der Liste:
   *   exportiert werden die Konversationen mit Treffer, jeweils vollständig
   * @returns {AsyncGenerator<import("../utils/helpers/chat/embedConversationExport").ExportConversation>}
   */
  conversationsForExport: async function* (
    embedId,
    {
      startDate = null,
      endDate = null,
      feedbackFilter = "all",
      startedBetween = null,
      search = null,
    } = {}
  ) {
    const id = Number(embedId);
    if (!Number.isInteger(id) || id <= 0) return;
    const between = EmbedChats.normalizeStartedBetween(startedBetween);

    // Stand des Exports: derselbe wie der einer Liste (Fixliste 9, A2).
    const maxId = await EmbedChats._currentMaxId(id);
    if (!maxId) return;
    const selection = {
      embedId: id,
      startDate,
      endDate,
      startedBetween: between,
      maxId,
    };

    const conversations = await EmbedChats._exportConversations({
      ...selection,
      feedbackFilter,
      search,
    });
    yield* EmbedChats._exportBatches(selection, conversations);
  },

  /**
   * Die Konversationen des Exports samt ihren Nachrichten - in Paketen
   * ({@link EmbedChats._exportMessages}): so viele Konversationen, bis ihre
   * Nachrichten (nach der Zählung der Liste) das Paket füllen, mindestens
   * eine.
   * @param {{embedId: number, startDate: Date|null, endDate: Date|null, startedBetween: object|null, maxId: number}} selection
   * @param {Array<{conversation_id: string, session_id: string, message_count: number, conversation_number: number}>} conversations
   * @returns {AsyncGenerator<import("../utils/helpers/chat/embedConversationExport").ExportConversation>}
   */
  _exportBatches: async function* (selection, conversations) {
    for (let from = 0; from < conversations.length; ) {
      let to = from;
      let messages = 0;
      do {
        messages += conversations[to].message_count;
        to += 1;
      } while (
        to < conversations.length &&
        to - from < EXPORT_BATCH_CONVERSATIONS &&
        messages + conversations[to].message_count <= EXPORT_MESSAGE_BATCH
      );
      const groups = conversations.slice(from, to);
      from = to;

      const byGroup = await EmbedChats._exportMessages({
        ...selection,
        groups,
      });
      for (const group of groups) {
        const rows = byGroup.get(EmbedChats._exportGroupKey(group));
        // Inzwischen gelöscht (Aufbewahrungsfrist, Löschung): keine Zeile.
        if (!rows || rows.length === 0) continue;
        yield {
          number: group.conversation_number,
          conversationId:
            group.conversation_id === group.session_id
              ? null
              : group.conversation_id,
          messages: rows,
        };
      }
    }
  },

  /**
   * Fixliste 6, N2: Zeitpunkt der letzten Nachricht je Widget - für die
   * Vorauswahl der Ansicht „Konversationen“ (das Widget mit der jüngsten
   * Aktivität). Je Widget ein Gang rückwärts durch den Index (embed_id,
   * createdAt) bis zur ersten einsehbaren Zeile - kein Durchlauf über alle
   * Zeilen (MAX() mit der Bedingung include = 1 läse jede Zeile des
   * Widgets). Gezählt werden wie überall in der Ansicht nur
   * einsehbare Nachrichten (include = 1, DSGVO-Regel des Repos; Fixliste 7,
   * F12): Hat ein Besucher seinen Verlauf geleert, macht ihn das nicht zum
   * jüngsten Widget. Nur Zeitpunkte, keine Inhalte.
   * @param {number[]|null} embedIds - diese Widgets; null = alle
   * @returns {Promise<Array<{embedId: number, lastMessageAt: number|null}>>} -
   *   lastMessageAt in Millisekunden, null ohne Nachricht
   * @throws bei einem Datenbankfehler (kein leeres Ergebnis)
   */
  lastMessageAtByEmbed: async function (embedIds = null) {
    const { Prisma } = require("@prisma/client");
    if (Array.isArray(embedIds) && embedIds.length === 0) return [];
    const where = Array.isArray(embedIds)
      ? Prisma.sql`WHERE e.id IN (${Prisma.join(embedIds.map(Number))})`
      : Prisma.empty;
    const rows = await prisma.$queryRaw`
      SELECT
        e.id AS embed_id,
        (SELECT c.createdAt FROM embed_chats c
          WHERE c.embed_id = e.id AND c.include = 1
          ORDER BY c.createdAt DESC LIMIT 1)
          AS last_message_at
      FROM embed_configs e
      ${where}
      ORDER BY e.id`;
    return rows.map((row) => ({
      embedId: Number(row.embed_id),
      lastMessageAt: rawInstant(row.last_message_at),
    }));
  },

  /**
   * Upstream-Route POST /embed/chats (frühere Nachrichtentabelle, Fixliste 7,
   * F02): eine Seite einzelner Nachrichten, neueste zuerst - nur einsehbare
   * Zeilen (include = 1) und nur die Felder der Tabelle. Die Antwort enthält
   * nur ihren Text (als {"text": …} wie gespeichert, ohne Quellen, Kurskarten
   * und Metadaten), keine Verbindungsdaten. Gelesen wird auch nur der Text
   * (visibleAnswerSql, Fixliste 8, L3) - nicht das volle Antwort-JSON.
   * @param {{embedIds: number[]|null, skip: number, limit: number}} page -
   *   embedIds: diese Widgets; null = alle
   * @returns {Promise<{chats: Array<object>, totalChats: number}>}
   * @throws bei einem Datenbankfehler
   */
  chatTablePage: async function ({ embedIds = null, skip = 0, limit = 20 }) {
    const where = {
      include: true,
      ...(Array.isArray(embedIds) ? { embed_id: { in: embedIds } } : {}),
    };
    const [rows, totalChats] = await Promise.all([
      prisma.embed_chats.findMany({
        where,
        orderBy: { id: "desc" },
        skip,
        take: limit,
        select: {
          id: true,
          embed_id: true,
          session_id: true,
          prompt: true,
          createdAt: true,
          embed_config: {
            select: { workspace: { select: { name: true } } },
          },
        },
      }),
      prisma.embed_chats.count({ where }),
    ]);
    // Der Text der Antworten dieser Seite (höchstens 100 Zeilen, über den
    // Primärschlüssel)
    const texts = new Map();
    if (rows.length > 0) {
      const { Prisma } = require("@prisma/client");
      const answers = await prisma.$queryRaw`
        SELECT id, ${visibleAnswerSql()} AS answer
        FROM embed_chats
        WHERE id IN (${Prisma.join(rows.map((row) => row.id))})`;
      for (const answer of answers)
        if (typeof answer.answer === "string")
          texts.set(Number(answer.id), stripProtocolMarkers(answer.answer));
    }
    return {
      chats: rows.map((row) => ({
        ...row,
        response: JSON.stringify({ text: texts.get(row.id) ?? "" }),
      })),
      totalChats,
    };
  },

  /**
   * Analytics: Get basic statistics for an embed
   * KIE-533: Zählt wie die Konversationsliste nur Zeilen mit include = 1
   * (ohne die per markHistoryInvalid zurückgesetzten).
   * @param {number} embedId - The embed config ID
   * @param {Date|null} startDate - Optional start date filter
   * @param {Date|null} endDate - Optional end date filter
   * @returns {Promise<Object>} Statistics object
   */
  getBasicStats: async function (embedId, startDate = null, endDate = null) {
    try {
      const { Prisma } = require("@prisma/client");

      // Build WHERE clause
      const where = { embed_id: Number(embedId), include: true };
      if (startDate && endDate) {
        where.createdAt = { gte: startDate, lte: endDate };
      }

      // Build date conditions for raw queries
      const dateConditions = [];
      if (startDate) {
        dateConditions.push(Prisma.sql`AND createdAt >= ${startDate}`);
      }
      if (endDate) {
        dateConditions.push(Prisma.sql`AND createdAt <= ${endDate}`);
      }

      // Get total chats
      const totalChats = await prisma.embed_chats.count({ where });

      // KIE-504: Feedback-Zähler (👍/👎) — NULL zählt nicht als Bewertung
      const feedbackPositive = await prisma.embed_chats.count({
        where: { ...where, feedbackScore: true },
      });
      const feedbackNegative = await prisma.embed_chats.count({
        where: { ...where, feedbackScore: false },
      });
      const feedbackTotal = feedbackPositive + feedbackNegative;

      // Get unique conversations count (using conversation_id, fallback to session_id)
      const uniqueConversations = await prisma.$queryRaw`
        SELECT COUNT(DISTINCT COALESCE(conversation_id, session_id)) as count
        FROM embed_chats
        WHERE embed_id = ${embedId}
          AND include = 1
          ${dateConditions.length > 0 ? Prisma.join(dateConditions, " ") : Prisma.empty}
      `;

      // Calculate word counts (SQLite string functions)
      const wordCounts = await prisma.$queryRaw`
        SELECT
          SUM(LENGTH(prompt) - LENGTH(REPLACE(prompt, ' ', '')) + 1) as total_words_prompt,
          SUM(LENGTH(response) - LENGTH(REPLACE(response, ' ', '')) + 1) as total_words_response,
          AVG(LENGTH(prompt) - LENGTH(REPLACE(prompt, ' ', '')) + 1) as avg_words_prompt,
          AVG(LENGTH(response) - LENGTH(REPLACE(response, ' ', '')) + 1) as avg_words_response,
          MAX(LENGTH(prompt) - LENGTH(REPLACE(prompt, ' ', '')) + 1) as max_words_prompt,
          MAX(LENGTH(response) - LENGTH(REPLACE(response, ' ', '')) + 1) as max_words_response
        FROM embed_chats
        WHERE embed_id = ${embedId}
          AND include = 1
          ${dateConditions.length > 0 ? Prisma.join(dateConditions, " ") : Prisma.empty}
      `;

      // Calculate days in range if dates provided
      const days =
        startDate && endDate
          ? Math.ceil((endDate - startDate) / (1000 * 60 * 60 * 24))
          : null;

      const conversationCount = Number(uniqueConversations[0]?.count) || 0;
      const wordsPrompt = Number(wordCounts[0]?.total_words_prompt) || 0;
      const wordsResponse = Number(wordCounts[0]?.total_words_response) || 0;
      const avgWordsPrompt = Number(wordCounts[0]?.avg_words_prompt) || 0;
      const avgWordsResponse = Number(wordCounts[0]?.avg_words_response) || 0;
      const maxWordsPrompt = Number(wordCounts[0]?.max_words_prompt) || 0;
      const maxWordsResponse = Number(wordCounts[0]?.max_words_response) || 0;

      return {
        total_chats: totalChats,
        unique_conversations: conversationCount, // Updated to use conversation_id
        unique_sessions: conversationCount, // Deprecated, kept for backwards compatibility
        total_words_prompt: wordsPrompt,
        total_words_response: wordsResponse,
        avg_words_prompt: Math.round(avgWordsPrompt),
        avg_words_response: Math.round(avgWordsResponse),
        max_words_prompt: maxWordsPrompt,
        max_words_response: maxWordsResponse,
        avg_chats_per_conversation:
          conversationCount > 0 ? totalChats / conversationCount : 0,
        avg_chats_per_day: days ? totalChats / days : null,
        // KIE-504: Bewertungen
        feedback_positive: feedbackPositive,
        feedback_negative: feedbackNegative,
        feedback_total: feedbackTotal,
        feedback_satisfaction:
          feedbackTotal > 0
            ? Math.round((feedbackPositive / feedbackTotal) * 100)
            : null,
      };
    } catch (error) {
      console.error("getBasicStats error:", error.message);
      return {
        total_chats: 0,
        unique_conversations: 0,
        unique_sessions: 0, // Deprecated, kept for backwards compatibility
        total_words_prompt: 0,
        total_words_response: 0,
        avg_words_prompt: 0,
        avg_words_response: 0,
        max_words_prompt: 0,
        max_words_response: 0,
        avg_chats_per_conversation: 0,
        avg_chats_per_day: null,
        feedback_positive: 0,
        feedback_negative: 0,
        feedback_total: 0,
        feedback_satisfaction: null,
      };
    }
  },
};

module.exports = { EmbedChats };
