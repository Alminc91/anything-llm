const { EmbedChats } = require("../models/embedChats");
const { EmbedConfig } = require("../models/embedConfig");
const { EventLogs } = require("../models/eventLogs");
const { MessageLedger } = require("../models/messageLedger");
const { WorkspaceUser } = require("../models/workspaceUsers");
const prisma = require("../utils/prisma");
const { reqBody, userFromSession } = require("../utils/http");
const { validEmbedConfigId } = require("../utils/middleware/embedMiddleware");
const {
  flexUserRoleValid,
  ROLES,
} = require("../utils/middleware/multiUserProtected");
const { validatedRequest } = require("../utils/middleware/validatedRequest");
const {
  chatHistoryViewable,
} = require("../utils/middleware/chatHistoryViewable");
const { handleEmbedLogoUpload } = require("../utils/files/multer");
const { deleteOldEmbedLogo } = require("../utils/files/embedLogo");
const {
  embedDefaultsLanguage,
  embedDefaultTexts,
} = require("../utils/chats/embedDefaults");
const {
  berlinMidnight,
  berlinDayOf,
} = require("../utils/helpers/billingWindow");
const {
  parseCalendarDay,
  validateDayRange,
  nextDay,
} = require("../utils/helpers/ledgerTimeline");
const {
  EXPORT_FORMATS,
  conversationExport,
  primed,
  writeChunks,
  exportFileName,
} = require("../utils/helpers/chat/embedConversationExport");
const {
  parseSearch,
  loggableError,
} = require("../utils/helpers/chat/conversationSearch");

/**
 * KIE-533: Darf der Nutzer auf diesen Workspace zugreifen?
 * Muster des Konversations-Endpunkts (KIE-527): Geprüft wird nur die Rolle
 * default (Mitgliedschaft im Workspace). admin und manager sind nicht
 * eingeschränkt; ohne Mehrbenutzermodus gibt es kein Nutzerobjekt, dann wird
 * nicht geprüft.
 * @param {{id: number, role: string}|null} user
 * @param {number|string|null} workspaceId
 * @returns {Promise<boolean>}
 */
async function userCanAccessWorkspace(user, workspaceId) {
  if (user?.role !== ROLES.default) return true;
  const id = Number(workspaceId);
  if (!Number.isInteger(id) || id <= 0) return false;
  const membership = await WorkspaceUser.get({
    user_id: user.id,
    workspace_id: id,
  });
  return !!membership;
}

/**
 * KIE-533: Darf der Nutzer dieses Widget verwalten bzw. dessen Daten lesen?
 * Ein Default-User nur, wenn er zum Workspace des Widgets gehört - ein
 * unbekanntes Widget ist für ihn von einem fremden nicht zu unterscheiden.
 * @param {{id: number, role: string}|null} user
 * @param {number|string} embedId
 * @returns {Promise<boolean>}
 */
async function userCanAccessEmbed(user, embedId) {
  if (user?.role !== ROLES.default) return true;
  const embed = await EmbedConfig.get({ id: Number(embedId) });
  if (!embed) return false;
  return await userCanAccessWorkspace(user, embed.workspace_id);
}

/**
 * Die Widgets, deren Konversationen der Nutzer sehen darf: null = alle
 * (admin, manager, ohne Mehrbenutzermodus); ein Default-User nur die Widgets
 * seiner Workspaces (keine Mitgliedschaft: keine). Direkt über Prisma:
 * WorkspaceUser.where/EmbedConfig.where fangen Fehler ab und liefern [] -
 * ein Datenbankfehler sähe dann wie „keine Konversationen“ aus statt 500
 * (Fixliste 4, C2).
 * @param {{id: number, role: string}|null} user
 * @returns {Promise<number[]|null>}
 */
async function visibleEmbedIds(user) {
  if (user?.role !== ROLES.default) return null;
  const memberships = await prisma.workspace_users.findMany({
    where: { user_id: user.id },
    select: { workspace_id: true },
  });
  const allowed = await prisma.embed_configs.findMany({
    where: {
      workspace_id: { in: memberships.map((ws) => ws.workspace_id) },
    },
    select: { id: true },
  });
  return allowed.map((embed) => embed.id);
}

// Middleware für /:embedId-Routen: 403, wenn der Nutzer das Widget nicht
// verwalten darf. Steht vor validEmbedConfigId und vor jedem Upload.
async function validEmbedAccess(request, response, next) {
  const user = await userFromSession(request, response);
  if (!(await userCanAccessEmbed(user, request.params.embedId))) {
    response.sendStatus(403).end();
    return;
  }
  next();
}

/**
 * Der Zeitraum der Konversationsliste aus dem Rumpf - an EINER Stelle
 * geprüft (Fixliste 7, F03).
 *
 * Die Ansicht sendet die Kalendertage, die der Nutzer gewählt hat (fromDay,
 * toDay: "YYYY-MM-DD", beide einschließlich) - dieselben Tage wie für
 * Kennzahlen und Diagramm (analytics/summary). Sie gelten als Berliner
 * Kalendertage: [00:00 Berliner Zeit am ersten Tag, 00:00 nach dem letzten),
 * unabhängig von der Zeitzone des Browsers und des Servers (Fixliste 7,
 * F06). Liste, Kennzahlen, Tagesgruppen und die Zeitpunkte der Exportdatei
 * rechnen damit in denselben Tagen.
 *
 * Ohne Tage gelten wie bisher startDate/endDate (Zeitpunkte, für
 * API-Clients); ohne beides der ganze Bestand.
 * @param {object} body
 * @returns {{start: Date|null, end: Date|null, fromDay: string|null, toDay: string|null, error: string|null}}
 *   end: der letzte Zeitpunkt (einschließlich, wie `createdAt <= end`);
 *   fromDay/toDay: die Kalendertage des Zeitraums (aus den Zeitpunkten in
 *   Berliner Zeit abgeleitet, falls Zeitpunkte gesendet wurden)
 */
function conversationPeriod(body) {
  const { startDate, endDate, fromDay, toDay } = body ?? {};
  const none = { start: null, end: null, fromDay: null, toDay: null };
  if (fromDay != null || toDay != null) {
    const from = parseCalendarDay(fromDay);
    const to = parseCalendarDay(toDay);
    if (from === null || to === null)
      return {
        ...none,
        error: "fromDay and toDay must be calendar days (YYYY-MM-DD).",
      };
    if (from > to)
      return { ...none, error: "fromDay must not be after toDay." };
    return {
      start: berlinMidnight(fromDay),
      end: new Date(berlinMidnight(nextDay(toDay)).getTime() - 1),
      fromDay,
      toDay,
      error: null,
    };
  }
  const start = startDate ? new Date(startDate) : null;
  const end = endDate ? new Date(endDate) : null;
  if ((start && isNaN(start.getTime())) || (end && isNaN(end.getTime())))
    return {
      ...none,
      error: "startDate and endDate must be valid timestamps.",
    };
  return {
    start,
    end,
    fromDay: start ? berlinDayOf(start) : null,
    toDay: end ? berlinDayOf(end) : null,
    error: null,
  };
}

/**
 * KIE-538: Die Auswahl der Konversationsliste aus dem Rumpf einer Anfrage -
 * Zeitraum ({@link conversationPeriod}), Feedback-Filter, Abschnitts-Filter
 * und Suchbegriff (`q`). Die Liste (analytics/conversations) und der Export
 * (analytics/export) lesen sie über diese eine Stelle: Dieselben Parameter
 * ergeben dieselben Konversationen, und eine ungültige Angabe ist überall
 * ein 400.
 * @param {object} body
 * @returns {{filter: "all"|"negative"|"positive", start: Date|null, end: Date|null, fromDay: string|null, toDay: string|null, startedBetween: {start: Date, endExclusive: Date}|null, search: string|null, error: string|null}}
 *   error: Zeitraum oder Abschnitt ungültig, oder `q` ist kein Text bzw. zu
 *   lang (→ 400); search: getrimmter Suchbegriff, null ohne Suche (fehlt,
 *   leer oder nur Leerraum)
 */
function conversationSelection(body) {
  const {
    onlyNegative = false, // KIE-508 (Legacy-Boolean, bleibt gültig)
    feedbackFilter, // KIE-527: "all" | "negative" | "positive"
    startedFromDay, // KIE-536
    startedToDay, // KIE-536
    q, // Suche in Frage, Antworttext, Grund und Kommentar
  } = body ?? {};

  // Neuer Parameter gewinnt (auch bei "" oder ungültigem Wert → "all");
  // nur wenn er fehlt (undefined/null), greift der Legacy-Boolean.
  const filter = EmbedChats.normalizeFeedbackFilter(
    feedbackFilter ?? !!onlyNegative
  );
  const invalid = (error) => ({
    filter,
    start: null,
    end: null,
    fromDay: null,
    toDay: null,
    startedBetween: null,
    search: null,
    error,
  });
  const { error: periodError, ...period } = conversationPeriod(body);
  if (periodError) return invalid(periodError);
  const { search, error: searchError } = parseSearch(q);
  if (searchError) return invalid(searchError);

  // KIE-536: Der Abschnitt kommt als Kalendertage und wird hier zu den
  // Berliner Grenzen [00:00 des ersten Tages, 00:00 nach dem letzten).
  // Fehlt er (undefined/null), bleibt alles wie bisher.
  let startedBetween = null;
  if (startedFromDay != null || startedToDay != null) {
    const range = validateDayRange(startedFromDay, startedToDay);
    if (!range.valid) return invalid(range.error);
    startedBetween = {
      start: berlinMidnight(startedFromDay),
      endExclusive: berlinMidnight(nextDay(startedToDay)),
    };
  }
  return { filter, ...period, startedBetween, search, error: null };
}

/** Größte Seite der Konversationsliste (analytics/conversations). */
const CONVERSATION_PAGE_MAX = 100;

/**
 * Blättern in der Konversationsliste: offset und limit aus dem Rumpf. Fehlen
 * sie, gelten 0 und 20 wie bisher; sonst müssen es ganze Zahlen sein -
 * offset ab 0, limit 1 bis CONVERSATION_PAGE_MAX (Fixliste Punkt 4).
 * @param {object} body
 * @returns {{offset: number, limit: number, error: string|null}}
 */
function conversationPaging(body) {
  const { offset = 0, limit = 20 } = body ?? {};
  const valid = (value, min, max) =>
    Number.isSafeInteger(value) && value >= min && value <= max;
  if (!valid(offset ?? 0, 0, Number.MAX_SAFE_INTEGER))
    return { offset: 0, limit: 20, error: "offset must be an integer ≥ 0." };
  if (!valid(limit ?? 20, 1, CONVERSATION_PAGE_MAX))
    return {
      offset: 0,
      limit: 20,
      error: `limit must be an integer between 1 and ${CONVERSATION_PAGE_MAX}.`,
    };
  return { offset: offset ?? 0, limit: limit ?? 20, error: null };
}

/**
 * Blättern über einen Schlüssel (Fixliste 7, F14): `after` nennt die letzte
 * geladene Zeile der Liste - { lastMessageAt (Millisekunden), firstChatId }.
 * Die nächste Seite beginnt dahinter, auch wenn zwischen den Seiten
 * Konversationen verschwunden sind (mit offset fehlte dann still eine).
 * Nur mit offset 0.
 * @param {object} body
 * @param {number} offset - aus {@link conversationPaging}
 * @returns {{after: {lastMessageAt: number, firstChatId: number}|null, error: string|null}}
 */
function conversationCursor(body, offset) {
  const { after = null } = body ?? {};
  if (after === null) return { after: null, error: null };
  const { lastMessageAt, firstChatId } =
    after && typeof after === "object" && !Array.isArray(after) ? after : {};
  if (
    !Number.isSafeInteger(lastMessageAt) ||
    !Number.isSafeInteger(firstChatId) ||
    firstChatId <= 0
  )
    return {
      after: null,
      error: "after must be { lastMessageAt, firstChatId } (integers).",
    };
  if (offset !== 0)
    return { after: null, error: "after and offset must not be combined." };
  return { after: { lastMessageAt, firstChatId }, error: null };
}

function embedManagementEndpoints(app) {
  if (!app) return;

  app.get(
    "/embeds",
    [validatedRequest, flexUserRoleValid([ROLES.admin, ROLES.manager, ROLES.default])],
    async (request, response) => {
      try {
        const user = await userFromSession(request, response);
        let embeds;

        // Default users only see embeds for their assigned workspaces
        if (user?.role === ROLES.default) {
          const userWorkspaces = await WorkspaceUser.where({ user_id: user.id });
          const workspaceIds = userWorkspaces.map(ws => ws.workspace_id);
          if (workspaceIds.length === 0) {
            return response.status(200).json({ embeds: [] });
          }
          embeds = await EmbedConfig.whereWithWorkspace(
            { workspace_id: { in: workspaceIds } },
            null,
            { createdAt: "desc" }
          );
        } else {
          embeds = await EmbedConfig.whereWithWorkspace({}, null, {
            createdAt: "desc",
          });
        }

        response.status(200).json({ embeds });
      } catch (e) {
        console.error(e);
        response.sendStatus(500).end();
      }
    }
  );

  // Design Center: Kufer-Standardtexte des Widgets (Begrüßungsblase,
  // Datenschutz, KI-Hinweis) für ?lang=de|en — gleiche Anmeldung/Rollen wie
  // die übrigen Embed-Verwaltungsendpunkte. Der öffentliche /config liefert
  // sie nicht (das Widget hat sie selbst).
  app.get(
    "/embed/defaults",
    [validatedRequest, flexUserRoleValid([ROLES.admin, ROLES.manager, ROLES.default])],
    async (request, response) => {
      try {
        const lang = embedDefaultsLanguage(request.query?.lang);
        response.status(200).json({ lang, defaults: embedDefaultTexts(lang) });
      } catch (e) {
        console.error(e);
        response.sendStatus(500).end();
      }
    }
  );

  app.post(
    "/embeds/new",
    [validatedRequest, flexUserRoleValid([ROLES.admin, ROLES.manager, ROLES.default])],
    async (request, response) => {
      try {
        const user = await userFromSession(request, response);
        const data = reqBody(request);

        // KIE-533: Default-User legen Widgets nur in ihren Workspaces an.
        if (!(await userCanAccessWorkspace(user, data?.workspace_id))) {
          response.sendStatus(403).end();
          return;
        }

        const { embed, message: error } = await EmbedConfig.new(data, user?.id);
        await EventLogs.logEvent(
          "embed_created",
          { embedId: embed.id },
          user?.id
        );
        response.status(200).json({ embed, error });
      } catch (e) {
        console.error(e);
        response.sendStatus(500).end();
      }
    }
  );

  app.post(
    "/embed/update/:embedId",
    [validatedRequest, flexUserRoleValid([ROLES.admin, ROLES.manager, ROLES.default]), validEmbedAccess, validEmbedConfigId],
    async (request, response) => {
      try {
        const user = await userFromSession(request, response);
        const { embedId } = request.params;
        const updates = reqBody(request);

        // KIE-533: Umhängen nur in einen Workspace, auf den der Nutzer selbst
        // Zugriff hat (das Widget selbst prüft validEmbedAccess).
        if (
          updates?.workspace_id !== undefined &&
          !(await userCanAccessWorkspace(user, updates.workspace_id))
        ) {
          response.sendStatus(403).end();
          return;
        }

        const { success, error } = await EmbedConfig.update(embedId, updates);
        await EventLogs.logEvent("embed_updated", { embedId }, user?.id);
        response.status(200).json({ success, error });
      } catch (e) {
        console.error(e);
        response.sendStatus(500).end();
      }
    }
  );

  app.delete(
    "/embed/:embedId",
    [validatedRequest, flexUserRoleValid([ROLES.admin, ROLES.manager, ROLES.default]), validEmbedAccess, validEmbedConfigId],
    async (request, response) => {
      try {
        const { embedId } = request.params;
        await EmbedConfig.delete({ id: Number(embedId) });
        await EventLogs.logEvent(
          "embed_deleted",
          { embedId },
          response?.locals?.user?.id
        );
        response.status(200).json({ success: true, error: null });
      } catch (e) {
        console.error(e);
        response.sendStatus(500).end();
      }
    }
  );

  // Upstream-Route (AnythingLLM): die Daten der früheren Nachrichtentabelle.
  // Seit KIE-538 ruft die Oberfläche sie nicht mehr auf. Sie bleibt für den
  // Upstream-Merge (P-KIE-35) bestehen, ist aber gehärtet (Fixliste 7, F02):
  // - nur, was die Tabelle zeigte: Frage, Text der Antwort (ohne Quellen,
  //   Kurskarten und Metadaten), Sitzung, Zeitpunkt, Workspace - keine
  //   Verbindungsdaten (connection_information: IP, Host, Benutzername);
  // - nur einsehbare Zeilen (include = 1): Vom Besucher geleerte Chats
  //   erscheinen nirgends mehr (DSGVO, wie Liste, Detail und Export);
  // - offset und limit wie die Konversationsliste geprüft
  //   (conversationPaging: ganze Zahlen, limit 1–100, sonst 400). offset
  //   zählt wie upstream Seiten: übersprungen werden offset × limit Zeilen.
  // Rechte wie bisher: chatHistoryViewable, ein Default-User sieht nur die
  // Widgets seiner Workspaces (gefiltert in der Abfrage).
  app.post(
    "/embed/chats",
    [chatHistoryViewable, validatedRequest, flexUserRoleValid([ROLES.admin, ROLES.manager, ROLES.default])],
    async (request, response) => {
      try {
        const user = await userFromSession(request, response);
        const { offset, limit, error } = conversationPaging(
          reqBody(request) ?? {}
        );
        const skip = offset * limit;
        if (error || !Number.isSafeInteger(skip)) {
          response.status(400).json({
            success: false,
            error: error ?? "offset is too large.",
          });
          return;
        }
        const embedIds = await visibleEmbedIds(user);
        if (embedIds !== null && embedIds.length === 0) {
          response
            .status(200)
            .json({ chats: [], hasPages: false, totalChats: 0 });
          return;
        }
        const { chats, totalChats } = await EmbedChats.chatTablePage({
          embedIds,
          skip,
          limit,
        });
        response.status(200).json({
          chats,
          hasPages: totalChats > skip + limit,
          totalChats,
        });
      } catch (e) {
        console.error("embed/chats error:", loggableError(e));
        response.sendStatus(500).end();
      }
    }
  );

  // KIE-538: DELETE /embed/chats/:chatId (einzelne Nachricht löschen) ist mit
  // der Nachrichtentabelle entfallen. Gelöscht wird die ganze Konversation:
  // DELETE /embed/:embedId/conversation (weiter unten).
  // Ebenso entfallen ist POST /embed/chats/conversations, die Konversationen
  // aller Widgets zugleich: Die Ansicht zeigt immer ein Widget (KIE-538 §7),
  // die Route hatte keinen Aufrufer mehr (Fixliste 7, F20).

  // Fixliste 6, N2: letzte Nachricht je Widget - die Ansicht „Konversationen“
  // wählt ohne widget= in der Adresse das Widget mit der jüngsten Aktivität
  // vor. Dieselben Rechte wie die Konversationslisten: chatHistoryViewable,
  // ein Default-User nur die Widgets seiner Workspaces. Nur Zeitpunkte
  // (Millisekunden), keine Inhalte. Ein Datenbankfehler ist 500 - die
  // Ansicht wählt dann wie bisher das erste Widget.
  app.get(
    "/embeds/last-activity",
    [
      chatHistoryViewable,
      validatedRequest,
      flexUserRoleValid([ROLES.admin, ROLES.manager, ROLES.default]),
    ],
    async (request, response) => {
      try {
        const user = await userFromSession(request, response);
        const lastActivity = await EmbedChats.lastMessageAtByEmbed(
          await visibleEmbedIds(user)
        );
        response.status(200).json({ success: true, lastActivity });
      } catch (e) {
        console.error("embeds/last-activity error:", loggableError(e));
        response.status(500).json({
          success: false,
          error: "Letzte Aktivität konnte nicht geladen werden.",
        });
      }
    }
  );

  // Analytics: Get basic statistics for an embed
  // KIE-533: wie der Konversations-Endpunkt darunter - chatHistoryViewable,
  // Default-User nur für Widgets ihrer Workspaces; gezählt wird nur
  // include = 1 (EmbedChats.getBasicStats), wie in der Liste.
  app.post(
    "/embed/:embedId/analytics/overview",
    [chatHistoryViewable, validatedRequest, flexUserRoleValid([ROLES.admin, ROLES.manager, ROLES.default]), validEmbedAccess],
    async (request, response) => {
      try {
        const { embedId } = request.params;
        const { startDate, endDate } = reqBody(request);

        const stats = await EmbedChats.getBasicStats(
          Number(embedId),
          startDate ? new Date(startDate) : null,
          endDate ? new Date(endDate) : null
        );

        response.status(200).json({ success: true, stats });
      } catch (e) {
        console.error(e);
        response.sendStatus(500).end();
      }
    }
  );

  // Analytics: Kennzahlen und Zeitreihe eines Widgets aus dem Zählerbuch
  // KIE-536: Der Zeitraum kommt als Kalendertage (fromDay, toDay im Format
  // YYYY-MM-DD, beide einschließlich); das Zählerbuch führt Berliner
  // Kalendertage, die Zeitzone des Prozesses und des Browsers spielt keine
  // Rolle. Dieselben Prüfungen wie overview und die Konversationsliste:
  // chatHistoryViewable, Default-User nur für Widgets ihrer Workspaces.
  // Die Antwort enthält nur Zählwerte und Kalendertage - keine Inhalte, keine
  // Sitzungs- oder Verbindungsdaten. Ein ungültiger Zeitraum endet mit 400,
  // bevor das Zählerbuch gelesen wird.
  // KIE-537: Mit compare: true (genau dieser Wert) kommt previous dazu - die
  // Zählwerte des Vorzeitraums desselben Widgets (totals, buckets, fromDay,
  // toDay) und available: Gibt es den Vergleich? Ohne compare bleibt die
  // Antwort, wie sie war.
  // KIE-539: weekdayHour steht in jeder Antwort, mit und ohne compare.
  app.post(
    "/embed/:embedId/analytics/summary",
    [chatHistoryViewable, validatedRequest, flexUserRoleValid([ROLES.admin, ROLES.manager, ROLES.default]), validEmbedAccess, validEmbedConfigId],
    async (request, response) => {
      try {
        // Nur eine ganze, positive Kennung meint ein Widget; embed_id 0 sind
        // im Zählerbuch die Workspace-Chats.
        const embedId = Number(request.params.embedId);
        if (!Number.isInteger(embedId) || embedId <= 0) {
          response.sendStatus(404).end();
          return;
        }

        const { fromDay, toDay, compare } = reqBody(request) ?? {};
        const range = validateDayRange(fromDay, toDay);
        if (!range.valid) {
          response.status(400).json({ success: false, error: range.error });
          return;
        }

        // KIE-539: summaryForEmbed liest mit Kennzahlen und Zeitreihe auch
        // weekdayHour - Nachrichten nach Wochentag und Stunde, 7 × 24 Felder
        // (Montag bis Sonntag, Berliner Stunde 0-23) für die Karte „Wann
        // schreiben Ihre Besucher?". Eine Anweisung, ein Lesestand: Die Summe
        // der Felder ist die Kennzahl „Nachrichten". Ebenfalls nur Zählwerte.
        const [timeline, firstLedgerDay] = await Promise.all([
          MessageLedger.summaryForEmbed(embedId, fromDay, toDay),
          MessageLedger.firstDayForEmbed(embedId),
        ]);
        // KIE-537: Der Vorzeitraum beginnt vor firstLedgerDay → available false.
        // Er wird nur mit compare gelesen, mit einer eigenen Abfrage, und hat
        // kein Raster: weekdayHour gilt allein für den gewählten Zeitraum.
        const previous =
          compare === true
            ? await MessageLedger.previousTimelineForEmbed(
                embedId,
                fromDay,
                toDay,
                firstLedgerDay
              )
            : null;

        response.status(200).json({
          success: true,
          fromDay,
          toDay,
          granularity: timeline.granularity,
          totals: timeline.totals,
          buckets: timeline.buckets,
          firstLedgerDay,
          weekdayHour: timeline.weekdayHour,
          ...(previous ? { previous } : {}),
        });
      } catch (e) {
        console.error(e);
        response.sendStatus(500).end();
      }
    }
  );

  // Analytics: Get conversations list for an embed
  // KIE-527: chatHistoryViewable wie bei den übrigen Chat-Historien-Endpoints;
  // Default-User sehen nur Embeds ihrer Workspaces (BOLA/IDOR-Härtung).
  // KIE-536: optional startedFromDay/startedToDay (Kalendertage, beide
  // einschließlich, Berliner Zeit) - nur Konversationen, deren erste
  // vorhandene Nachricht in diesem Abschnitt liegt (Klick auf eine Säule).
  // Optional q: Suchbegriff - nur Konversationen mit Treffer in Frage,
  // angezeigtem Antworttext, Grund oder Kommentar (Groß/klein egal, auch bei
  // Umlauten; Platzhalterzeichen gelten wörtlich). Die Rechteprüfung ist
  // dieselbe wie ohne q. offset (ab 0) und limit (1–100) sind ganze Zahlen,
  // sonst 400; ohne Angabe 0 und 20.
  app.post(
    "/embed/:embedId/analytics/conversations",
    [chatHistoryViewable, validatedRequest, flexUserRoleValid([ROLES.admin, ROLES.manager, ROLES.default])],
    async (request, response) => {
      try {
        const user = await userFromSession(request, response);
        const embedId = Number(request.params.embedId);
        const body = reqBody(request) ?? {};
        const { offset, limit, error: pagingError } = conversationPaging(body);
        const { after, error: cursorError } = conversationCursor(body, offset);
        if (pagingError || cursorError) {
          response
            .status(400)
            .json({ success: false, error: pagingError ?? cursorError });
          return;
        }

        if (user?.role === ROLES.default) {
          const embed = await EmbedConfig.get({ id: embedId });
          const membership = embed
            ? await WorkspaceUser.get({
                user_id: user.id,
                workspace_id: embed.workspace_id,
              })
            : null;
          if (!membership) return response.sendStatus(403).end();
        }

        // Zeitraum, Feedback-Filter und Abschnitt (KIE-508/527/536) - über
        // dieselbe Stelle wie der Export (KIE-538).
        const {
          filter,
          start,
          end,
          startedBetween,
          search,
          error: selectionError,
        } = conversationSelection(body);
        if (selectionError) {
          response.status(400).json({ success: false, error: selectionError });
          return;
        }

        // Liste und Zähler: dieselbe Auswahl (EmbedChats._conversationSelection:
        // Gruppierung, Filter, Suche), in einer Abfrage (conversationPage).
        const {
          conversations,
          totalCount: total,
          hasMore,
        } = await EmbedChats.conversationPage(embedId, {
          offset,
          limit,
          after,
          startDate: start,
          endDate: end,
          feedbackFilter: filter,
          startedBetween,
          search,
        });

        response.status(200).json({
          success: true,
          conversations,
          hasMore,
          totalCount: total,
        });
      } catch (e) {
        // Ohne Meldungstext: Er könnte die Suchmuster enthalten. Ein
        // Datenbankfehler ist keine leere Liste (Fixliste 2, R2): 500, die
        // Liste zeigt „Fehler beim Laden" mit „Erneut versuchen".
        console.error("analytics/conversations error:", loggableError(e));
        response.status(500).json({
          success: false,
          error: "Konversationen konnten nicht geladen werden.",
        });
      }
    }
  );

  // Analytics: Export der Konversationen einer Auswahl (KIE-538)
  // Dieselben Parameter wie analytics/conversations (Zeitraum,
  // Feedback-Filter, Abschnitt, Suchbegriff q) plus format ("csv" | "json"); geliefert
  // werden genau die Konversationen, die die Liste über alle Seiten zeigt.
  // Dieselben Prüfungen wie beim Einsehen: chatHistoryViewable, Default-User
  // nur für Widgets ihrer Workspaces (403 ohne Daten).
  // Die Datei enthält keine IP-Adresse, keinen Host, keine Kennung der
  // Browser-Sitzung und keine Quellen-Texte (siehe embedConversationExport).
  // Sie wird Zeile für Zeile geschrieben, die Datenbank in Paketen gelesen.
  // Jeder Export steht in event_logs: wer, welches Widget, Format, Zeitraum,
  // ob gesucht wurde, Zahl der Konversationen und Zeilen - keine Inhalte,
  // nicht der Suchbegriff.
  app.post(
    "/embed/:embedId/analytics/export",
    [
      chatHistoryViewable,
      validatedRequest,
      flexUserRoleValid([ROLES.admin, ROLES.manager, ROLES.default]),
      validEmbedAccess,
      validEmbedConfigId,
    ],
    async (request, response) => {
      let streaming = false;
      try {
        const user = await userFromSession(request, response);
        const embedId = Number(request.params.embedId);
        const body = reqBody(request) ?? {};
        const { format } = body;

        if (
          typeof format !== "string" ||
          !Object.prototype.hasOwnProperty.call(EXPORT_FORMATS, format)
        ) {
          response.status(400).json({
            success: false,
            error: "format must be one of: csv, json.",
          });
          return;
        }

        const selection = conversationSelection(body);
        if (selection.error) {
          response.status(400).json({ success: false, error: selection.error });
          return;
        }
        const { filter, start, end, startedBetween, search } = selection;

        const embed = await EmbedConfig.getWithWorkspace({ id: embedId });
        // Der Dateiname nennt den Abschnitt, wenn einer gewählt ist, sonst
        // den Zeitraum - die Berliner Kalendertage der Auswahl, wie die
        // Zeitpunkte der Datei (conversationPeriod).
        const fromDay = startedBetween
          ? body.startedFromDay
          : selection.fromDay;
        const toDay = startedBetween ? body.startedToDay : selection.toDay;

        const exported = conversationExport(
          format,
          // Die erste Abfrage läuft, bevor die Antwort beginnt: Scheitert
          // sie, gibt es eine 500 statt einer leeren Datei.
          await primed(
            EmbedChats.conversationsForExport(embedId, {
              startDate: start,
              endDate: end,
              feedbackFilter: filter,
              startedBetween,
              search,
            })
          )
        );
        const filename = exportFileName({
          embedId,
          workspaceName: embed?.workspace?.name,
          fromDay,
          toDay,
          extension: exported.extension,
        });
        const logExport = (completed) =>
          EventLogs.logEvent(
            "embed_conversations_exported",
            {
              embedId,
              format,
              fromDay,
              toDay,
              startDate: start ? start.toISOString() : null,
              endDate: end ? end.toISOString() : null,
              feedbackFilter: filter,
              startedFromDay: startedBetween ? body.startedFromDay : null,
              startedToDay: startedBetween ? body.startedToDay : null,
              // Nur ob gesucht wurde - der Begriff (oft ein Name oder eine
              // E-Mail-Adresse) gehört nicht ins Protokoll.
              searched: search !== null,
              conversationCount: exported.stats.conversations,
              rowCount: exported.stats.rows,
              completed,
            },
            user?.id
          );

        response.setHeader("Content-Type", exported.contentType);
        response.setHeader(
          "Content-Disposition",
          `attachment; filename="${filename}"`
        );
        // Der Browser liest den Dateinamen aus der Antwort (fetch).
        response.setHeader(
          "Access-Control-Expose-Headers",
          "Content-Disposition"
        );
        response.setHeader("Cache-Control", "no-store");
        response.status(200);
        streaming = true;

        let completed = false;
        try {
          completed = await writeChunks(
            response,
            exported.chunks,
            exported.written
          );
        } finally {
          // Auch ein abgebrochener Export hat Daten ausgeliefert.
          await logExport(completed);
        }
        response.end();
      } catch (e) {
        // Zu viele Treffer für den Export mit Suche (Fixliste 3, C10): Die
        // Grenze steht fest, die Ansicht nennt sie - bevor eine Datei beginnt.
        if (!streaming && e?.code === "EXPORT_TOO_MANY_HITS") {
          response.status(413).json({
            success: false,
            reason: "too-many-hits",
            max: e.max,
            error: `Zu viele Treffer für den Export (mehr als ${e.max} Konversationen). Bitte Suche, Filter oder Zeitraum eingrenzen.`,
          });
          return;
        }
        // Ohne Meldungstext: Er könnte die Suchmuster enthalten.
        console.error("analytics/export error:", loggableError(e));
        // Hat die Antwort schon begonnen, lässt sich kein Fehlerstatus mehr
        // senden: Die Verbindung wird abgebrochen, damit der Download als
        // fehlgeschlagen gilt und nicht als vollständige Datei.
        if (streaming) response.destroy(e);
        else response.sendStatus(500).end();
      }
    }
  );

  // Analytics: Get conversation details
  // KIE-533 (AK-13): wie die Konversationsliste darüber - chatHistoryViewable,
  // Default-User nur für Widgets ihrer Workspaces (sonst 403 ohne Inhalte).
  // KIE-538: :chatId ist die id einer Zeile der Konversation - die Liste
  // nennt die erste (first_chat_id). Gezeigt werden genau die Zeilen, die
  // „Konversation löschen" entfernt (EmbedChats._conversationScope).
  app.get(
    "/embed/:embedId/conversation/:chatId",
    [chatHistoryViewable, validatedRequest, flexUserRoleValid([ROLES.admin, ROLES.manager, ROLES.default]), validEmbedAccess],
    async (request, response) => {
      try {
        const { embedId, chatId } = request.params;

        const messages = await EmbedChats.getConversationDetails(
          chatId,
          Number(embedId)
        );

        response.status(200).json({ success: true, messages });
      } catch (e) {
        // Ein Datenbankfehler ist nicht „nicht gefunden" (Fixliste 2, R1):
        // 500, das Panel zeigt „konnte nicht geladen werden" mit „Erneut
        // versuchen".
        console.error("conversation details error:", loggableError(e));
        response.status(500).json({
          success: false,
          error: "Konversation konnte nicht geladen werden.",
        });
      }
    }
  );

  // Konversation löschen: Vorschau (KIE-538)
  // Was das Löschen entfernen würde - nur Zahlen: die Zeilen dieser
  // Konversation und, für „Alle Konversationen dieses Besuchers löschen",
  // Konversationen und Zeilen ihrer Browser-Sitzung in diesem Widget. Keine
  // Inhalte, keine Sitzungs-Kennung. Prüfungen wie beim Einsehen.
  //
  // Hier und in den beiden Lösch-Routen darunter bezeichnet der Rumpf die
  // Konversation: { chatId } - die id einer ihrer Zeilen, wie die Liste sie
  // nennt (first_chat_id). Nicht ihre Kennung: Die conversation_id vergibt
  // der Besucher (der öffentliche Chat-Endpunkt speichert sie ungeprüft).
  // Eine zweite Sitzung kann dieselbe Kennung senden - gelöscht würde dann
  // mit der einen Konversation die andere. Und in einer Adresse löst ein
  // Browser "." und ".." als Pfadsegmente auf, auch kodiert (%2e%2e): Aus
  // „Konversation .. löschen" würde DELETE /embed/:embedId, das Löschen des
  // ganzen Widgets. Keine Lösch-Route trägt deshalb mehr als :embedId.
  app.post(
    "/embed/:embedId/conversation/deletion-preview",
    [
      chatHistoryViewable,
      validatedRequest,
      flexUserRoleValid([ROLES.admin, ROLES.manager, ROLES.default]),
      validEmbedAccess,
      validEmbedConfigId,
    ],
    async (request, response) => {
      try {
        const { embedId } = request.params;
        const { chatId } = reqBody(request) ?? {};
        const preview = await EmbedChats.conversationDeletionPreview(
          Number(embedId),
          chatId
        );
        if (!preview) {
          response.sendStatus(500).end();
          return;
        }
        response.status(200).json({ success: true, ...preview });
      } catch (e) {
        console.error(e);
        response.sendStatus(500).end();
      }
    }
  );

  // Konversation löschen (KIE-538)
  // Löschen darf, wer die Konversationen des Widgets einsehen darf: admin und
  // manager für jedes Widget, default für die Widgets seiner Workspaces -
  // dieselben Prüfungen wie beim Einsehen (chatHistoryViewable,
  // validEmbedAccess). Gelöscht werden alle Zeilen der Konversation in diesem
  // Widget (EmbedChats.deleteConversation) - die der einen Karte der Liste,
  // nicht die einer anderen Sitzung mit derselben Kennung. Die Zeile eines
  // anderen Widgets bezeichnet hier keine Konversation (404). Das Zählerbuch
  // bleibt unberührt.
  // event_logs: wer, welches Widget, wie viele Zeilen - keine Inhalte, keine
  // Sitzungs-Kennung. { chatId } steht im Rumpf (siehe Vorschau); fehlt die
  // Angabe, trifft die Anfrage keine Zeile (404).
  app.delete(
    "/embed/:embedId/conversation",
    [
      chatHistoryViewable,
      validatedRequest,
      flexUserRoleValid([ROLES.admin, ROLES.manager, ROLES.default]),
      validEmbedAccess,
      validEmbedConfigId,
    ],
    async (request, response) => {
      try {
        const user = await userFromSession(request, response);
        const embedId = Number(request.params.embedId);
        const { chatId } = reqBody(request) ?? {};
        const deletedCount = await EmbedChats.deleteConversation(
          embedId,
          chatId
        );
        if (deletedCount === null) {
          response.sendStatus(500).end();
          return;
        }
        if (deletedCount === 0) {
          response
            .status(404)
            .json({ success: false, error: "Conversation not found." });
          return;
        }

        await EventLogs.logEvent(
          "embed_conversation_deleted",
          { embedId, deletedCount },
          user?.id
        );
        response.status(200).json({ success: true, deletedCount });
      } catch (e) {
        console.error(e);
        response.sendStatus(500).end();
      }
    }
  );

  // Alle Konversationen eines Besuchers löschen (KIE-538, AK-12)
  // Löscht in diesem Widget alle Konversationen der Browser-Sitzung, zu der
  // die genannte Konversation gehört; die Sitzung bestimmt der Server aus
  // der Zeile, sie steht weder in der Anfrage noch in der Antwort oder im
  // Protokoll. Prüfungen und Protokoll wie beim Löschen einer Konversation.
  // { chatId } steht im Rumpf (siehe Vorschau).
  app.delete(
    "/embed/:embedId/conversation/visitor",
    [
      chatHistoryViewable,
      validatedRequest,
      flexUserRoleValid([ROLES.admin, ROLES.manager, ROLES.default]),
      validEmbedAccess,
      validEmbedConfigId,
    ],
    async (request, response) => {
      try {
        const user = await userFromSession(request, response);
        const embedId = Number(request.params.embedId);
        const { chatId, expected = null } = reqBody(request) ?? {};
        // Fixliste 7, F10: die Zahlen, die die Rückfrage genannt hat
        // (visitor der Vorschau) - gelöscht wird nur dieser Stand.
        const count = (value) => Number.isSafeInteger(value) && value >= 0;
        if (
          expected !== null &&
          !(
            expected &&
            typeof expected === "object" &&
            count(expected.conversationCount) &&
            count(expected.messageCount)
          )
        ) {
          response.status(400).json({
            success: false,
            error:
              "expected must be { conversationCount, messageCount } (integers ≥ 0).",
          });
          return;
        }
        const result = await EmbedChats.deleteVisitorConversations(
          embedId,
          chatId,
          expected
            ? {
                conversationCount: expected.conversationCount,
                messageCount: expected.messageCount,
              }
            : null
        );
        if (!result) {
          response.sendStatus(500).end();
          return;
        }
        // Der Besucher hat inzwischen weiter geschrieben (oder etwas ist
        // weggefallen): nichts gelöscht, die Ansicht fragt mit dem neuen
        // Stand noch einmal.
        if (result.changed) {
          response.status(409).json({
            success: false,
            reason: "changed",
            visitor: result.changed,
            error: "The visitor's conversations have changed.",
          });
          return;
        }
        const { deletedCount, conversationCount } = result;
        if (deletedCount === 0) {
          response
            .status(404)
            .json({ success: false, error: "Conversation not found." });
          return;
        }

        await EventLogs.logEvent(
          "embed_visitor_conversations_deleted",
          { embedId, conversationCount, deletedCount },
          user?.id
        );
        response
          .status(200)
          .json({ success: true, deletedCount, conversationCount });
      } catch (e) {
        console.error(e);
        response.sendStatus(500).end();
      }
    }
  );

  // Upload logo for an embed widget
  app.post(
    "/embed/:embedId/upload-logo",
    [validatedRequest, flexUserRoleValid([ROLES.admin, ROLES.manager, ROLES.default]), validEmbedAccess, validEmbedConfigId, handleEmbedLogoUpload],
    async (request, response) => {
      try {
        const { embedId } = request.params;
        const newFilename = request.randomFileName;
        if (!newFilename) {
          return response.status(400).json({ success: false, error: "No file uploaded." });
        }

        // Get current config to delete old logo
        const embed = await EmbedConfig.get({ id: Number(embedId) });
        let currentConfig = {};
        if (embed?.visual_config) {
          try { currentConfig = JSON.parse(embed.visual_config); } catch {}
        }

        // Delete old logo file if exists
        if (currentConfig.logoFilename) {
          deleteOldEmbedLogo(currentConfig.logoFilename);
        }

        // Update visual_config with new logo filename
        currentConfig.logoFilename = newFilename;
        currentConfig.logoUrl = null; // clear URL when uploading file
        await EmbedConfig.update(embedId, {
          visual_config: JSON.stringify(currentConfig),
        });

        response.status(200).json({ success: true, logoFilename: newFilename });
      } catch (e) {
        console.error(e);
        response.sendStatus(500).end();
      }
    }
  );

  // Remove logo for an embed widget
  app.delete(
    "/embed/:embedId/remove-logo",
    [validatedRequest, flexUserRoleValid([ROLES.admin, ROLES.manager, ROLES.default]), validEmbedAccess, validEmbedConfigId],
    async (request, response) => {
      try {
        const { embedId } = request.params;
        const embed = await EmbedConfig.get({ id: Number(embedId) });
        let currentConfig = {};
        if (embed?.visual_config) {
          try { currentConfig = JSON.parse(embed.visual_config); } catch {}
        }

        // Delete logo file
        if (currentConfig.logoFilename) {
          deleteOldEmbedLogo(currentConfig.logoFilename);
        }

        // Clear logo from config
        currentConfig.logoFilename = null;
        currentConfig.logoUrl = null;
        await EmbedConfig.update(embedId, {
          visual_config: JSON.stringify(currentConfig),
        });

        response.status(200).json({ success: true });
      } catch (e) {
        console.error(e);
        response.sendStatus(500).end();
      }
    }
  );

  // DSGVO: Clear all chats (global or per-embed)
  app.delete(
    "/embed-chats/clear/:embedId",
    [validatedRequest, flexUserRoleValid([ROLES.admin, ROLES.manager, ROLES.default])],
    async (request, response) => {
      try {
        const { embedId } = request.params;
        const user = await userFromSession(request, response);

        // Leeren bleibt admin und manager vorbehalten. KIE-533: Default-User
        // erhalten wie an den übrigen Widget-Endpunkten 403 (bisher 401 aus
        // der Rollenprüfung) - für fremde wie für eigene Widgets. Ohne
        // Mehrbenutzermodus gibt es kein Nutzerobjekt.
        if (!!user && ![ROLES.admin, ROLES.manager].includes(user.role)) {
          response.sendStatus(403).end();
          return;
        }

        if (Number(embedId) === -1) {
          // Global: Delete ALL embed chats
          const count = await EmbedChats.count();
          await EmbedChats.delete({});
          await EventLogs.logEvent(
            "embed_chats_cleared_all",
            { deletedCount: count },
            user?.id
          );
          response.status(200).json({ success: true, deletedCount: count });
        } else {
          // Per Widget: Delete all chats for this embed
          const count = await EmbedChats.count({ embed_id: Number(embedId) });
          await EmbedChats.delete({ embed_id: Number(embedId) });
          await EventLogs.logEvent(
            "embed_chats_cleared",
            { embedId: Number(embedId), deletedCount: count },
            user?.id
          );
          response.status(200).json({ success: true, deletedCount: count });
        }
      } catch (e) {
        console.error(e);
        response.sendStatus(500).end();
      }
    }
  );
}

module.exports = { embedManagementEndpoints };
