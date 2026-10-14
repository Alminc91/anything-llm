/* eslint-env node */
// Anfragen der Ansicht „Konversationen" (KIE-536), so wie der Browser sie
// sendet: Adresse und Rumpf. Beide Seiten prüfen gegen diese eine Stelle -
//   frontend/__tests__/embedAnalyticsInteraction.test.mjs: Die Ansicht und
//     frontend/src/models/embed.js senden genau das.
//   server/__tests__/endpoints/embedAnalyticsSummary.test.js: Die echten
//     Routen verstehen genau das.
// Benennt eine Seite ein Feld um, wird der Test der anderen rot.
//
// KIE-538: Export der Auswahl und „Konversation löschen" -
//   frontend/__tests__/conversationExportDelete.test.mjs
//   server/__tests__/endpoints/embedConversationExport.test.js
//   server/__tests__/models/embedChatsDeleteConversation.test.js

const ROUTES = {
  // Fixliste 6, N2: letzte Nachricht je sichtbarem Widget (Vorauswahl)
  lastActivity: { method: "GET", path: "/embeds/last-activity" },
  summary: { method: "POST", path: "/embed/:embedId/analytics/summary" },
  conversations: {
    method: "POST",
    path: "/embed/:embedId/analytics/conversations",
  },
  export: { method: "POST", path: "/embed/:embedId/analytics/export" },
  // Die Konversation bezeichnet der Rumpf (conversationBody) über die id
  // ihrer ersten Zeile, nicht die Adresse über ihre Kennung: Die vergibt der
  // Besucher - zwei Sitzungen können dieselbe tragen, und "." bzw. ".." löst
  // der Browser als Pfadsegmente auf.
  deletionPreview: {
    method: "POST",
    path: "/embed/:embedId/conversation/deletion-preview",
  },
  deleteConversation: {
    method: "DELETE",
    path: "/embed/:embedId/conversation",
  },
  deleteVisitor: {
    method: "DELETE",
    path: "/embed/:embedId/conversation/visitor",
  },
  // Gesprächsverlauf einer Konversation (Seitenpanel, Öffnen per Link): die
  // id einer ihrer Zeilen als einziges Pfadsegment, ohne Zeitraum.
  details: {
    method: "GET",
    path: "/embed/:embedId/conversation/:chatId",
  },
};

/**
 * Kennzahlen und Zeitreihe: die Kalendertage, die der Nutzer gewählt hat
 * ("YYYY-MM-DD", beide einschließlich). Mit eingeschaltetem Vergleich
 * (KIE-537) zusätzlich compare: true - ausgeschaltet fehlt das Feld.
 * @param {string} fromDay
 * @param {string} toDay
 * @param {{compare?: boolean}} [options]
 */
function summaryBody(fromDay, toDay, { compare = false } = {}) {
  return { fromDay, toDay, ...(compare ? { compare: true } : {}) };
}

/**
 * Eine Seite der Konversationsliste: Zeitraum der Ansicht als Kalendertage
 * (fromDay/toDay, beide einschließlich - dieselben Tage wie für Kennzahlen
 * und Diagramm, Berliner Kalendertage; Fixliste 7, F06), Feedback-Filter
 * und - nach einem Klick auf eine Säule - der Abschnitt als Kalendertage
 * (beide einschließlich). Ohne Abschnitt fehlen dessen Felder.
 *
 * Steht fromDay nicht in `request`, gehen stattdessen startDate/endDate
 * (Zeitpunkte) hinaus - so senden API-Clients, die Ansicht nicht mehr.
 *
 * Blättern: die erste Seite mit offset 0; jede weitere mit after - der
 * letzten geladenen Zeile { lastMessageAt, firstChatId } (Fixliste 7, F14)
 * und dem Stand der ersten Seite, maxId (Fixliste 8, L2).
 * @param {Object} [request]
 * @param {number} [request.offset]
 * @param {number} [request.limit]
 * @param {{lastMessageAt: number, firstChatId: number, maxId?: number}|null} [request.after]
 * @param {string|null} [request.fromDay] - "YYYY-MM-DD" (null = „Gesamt“)
 * @param {string|null} [request.toDay]
 * @param {string|null} [request.startDate] - ISO-Zeitstempel (API)
 * @param {string|null} [request.endDate]
 * @param {"all"|"negative"|"positive"} [request.feedbackFilter]
 * @param {{start: string, end: string}|null} [request.bucket]
 * @param {string|null} [request.search] - Suchbegriff; als `q` gesendet,
 *   ohne Suche fehlt das Feld
 */
function conversationsBody(request = {}) {
  const {
    offset = 0,
    limit = 20,
    after = null,
    fromDay = null,
    toDay = null,
    startDate = null,
    endDate = null,
    feedbackFilter = "all",
    bucket = null,
    search = null,
  } = request;
  return {
    offset,
    limit,
    ...(after ? { after } : {}),
    ...("fromDay" in request ? { fromDay, toDay } : { startDate, endDate }),
    feedbackFilter,
    ...(bucket
      ? { startedFromDay: bucket.start, startedToDay: bucket.end }
      : {}),
    ...(search ? { q: search } : {}),
  };
}

/**
 * Export der Auswahl: dieselben Felder wie eine Seite der Liste, ohne das
 * Blättern, dazu das Format.
 * @param {"csv"|"json"} format
 * @param {Object} [request] - Zeitraum, feedbackFilter, bucket, search wie conversationsBody
 */
function exportBody(format, request = {}) {
  const {
    offset: _offset,
    limit: _limit,
    after: _after,
    ...selection
  } = conversationsBody(request);
  return { format, ...selection };
}

/**
 * Vorschau und Löschen einer Konversation bzw. aller Konversationen ihres
 * Besuchers: die id ihrer ersten Zeile, wie die Liste sie nennt
 * (first_chat_id). Beim Löschen aller Konversationen des Besuchers
 * zusätzlich expected - die Zahlen, die die Rückfrage genannt hat (visitor
 * der Vorschau; Fixliste 7, F10); ohne Angabe fehlt das Feld.
 * @param {number} chatId
 * @param {{conversationCount: number, messageCount: number}|null} [expected]
 */
function conversationBody(chatId, expected = null) {
  return { chatId, ...(expected ? { expected } : {}) };
}

module.exports = {
  ROUTES,
  summaryBody,
  conversationsBody,
  exportBody,
  conversationBody,
};
