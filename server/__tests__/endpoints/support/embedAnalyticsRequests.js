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
  summary: { method: "POST", path: "/embed/:embedId/analytics/summary" },
  conversations: {
    method: "POST",
    path: "/embed/:embedId/analytics/conversations",
  },
  export: { method: "POST", path: "/embed/:embedId/analytics/export" },
  deletionPreview: {
    method: "GET",
    path: "/embed/:embedId/conversation/:conversationId/deletion-preview",
  },
  deleteConversation: {
    method: "DELETE",
    path: "/embed/:embedId/conversation/:conversationId",
  },
  deleteVisitor: {
    method: "DELETE",
    path: "/embed/:embedId/conversation/:conversationId/visitor",
  },
};

/**
 * Kennzahlen und Zeitreihe: die Kalendertage, die der Nutzer gewählt hat
 * ("YYYY-MM-DD", beide einschließlich).
 * @param {string} fromDay
 * @param {string} toDay
 */
function summaryBody(fromDay, toDay) {
  return { fromDay, toDay };
}

/**
 * Eine Seite der Konversationsliste: Zeitraum der Ansicht als Zeitstempel des
 * Browsers, Feedback-Filter und - nach einem Klick auf eine Säule - der
 * Abschnitt als Kalendertage (beide einschließlich). Ohne Abschnitt fehlen
 * die beiden Felder.
 * @param {Object} [request]
 * @param {number} [request.offset]
 * @param {number} [request.limit]
 * @param {string|null} [request.startDate] - ISO-Zeitstempel
 * @param {string|null} [request.endDate]
 * @param {"all"|"negative"|"positive"} [request.feedbackFilter]
 * @param {{start: string, end: string}|null} [request.bucket]
 */
function conversationsBody({
  offset = 0,
  limit = 20,
  startDate = null,
  endDate = null,
  feedbackFilter = "all",
  bucket = null,
} = {}) {
  return {
    offset,
    limit,
    startDate,
    endDate,
    feedbackFilter,
    ...(bucket
      ? { startedFromDay: bucket.start, startedToDay: bucket.end }
      : {}),
  };
}

/**
 * Export der Auswahl: dieselben Felder wie eine Seite der Liste, ohne das
 * Blättern, dazu das Format.
 * @param {"csv"|"json"} format
 * @param {Object} [request] - startDate, endDate, feedbackFilter, bucket wie conversationsBody
 */
function exportBody(format, request = {}) {
  const {
    offset: _offset,
    limit: _limit,
    ...selection
  } = conversationsBody(request);
  return { format, ...selection };
}

module.exports = { ROUTES, summaryBody, conversationsBody, exportBody };
