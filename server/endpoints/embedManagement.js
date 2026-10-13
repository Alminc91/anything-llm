const { EmbedChats } = require("../models/embedChats");
const { EmbedConfig } = require("../models/embedConfig");
const { EventLogs } = require("../models/eventLogs");
const { MessageLedger } = require("../models/messageLedger");
const { WorkspaceUser } = require("../models/workspaceUsers");
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
 * KIE-538: Die Auswahl der Konversationsliste aus dem Rumpf einer Anfrage -
 * Zeitraum, Feedback-Filter und Abschnitts-Filter. Die Liste
 * (analytics/conversations) und der Export (analytics/export) lesen sie über
 * diese eine Stelle: Dieselben Parameter ergeben dieselben Konversationen.
 * @param {object} body
 * @returns {{filter: "all"|"negative"|"positive", start: Date|null, end: Date|null, startedBetween: {start: Date, endExclusive: Date}|null, error: string|null}}
 *   error: der Abschnitt besteht nicht aus gültigen Kalendertagen (→ 400)
 */
function conversationSelection(body) {
  const {
    startDate,
    endDate,
    onlyNegative = false, // KIE-508 (Legacy-Boolean, bleibt gültig)
    feedbackFilter, // KIE-527: "all" | "negative" | "positive"
    startedFromDay, // KIE-536
    startedToDay, // KIE-536
  } = body ?? {};

  // Neuer Parameter gewinnt (auch bei "" oder ungültigem Wert → "all");
  // nur wenn er fehlt (undefined/null), greift der Legacy-Boolean.
  const filter = EmbedChats.normalizeFeedbackFilter(
    feedbackFilter ?? !!onlyNegative
  );
  const start = startDate ? new Date(startDate) : null;
  const end = endDate ? new Date(endDate) : null;

  // KIE-536: Der Abschnitt kommt als Kalendertage und wird hier zu den
  // Berliner Grenzen [00:00 des ersten Tages, 00:00 nach dem letzten).
  // Fehlt er (undefined/null), bleibt alles wie bisher.
  let startedBetween = null;
  if (startedFromDay != null || startedToDay != null) {
    const range = validateDayRange(startedFromDay, startedToDay);
    if (!range.valid)
      return { filter, start, end, startedBetween, error: range.error };
    startedBetween = {
      start: berlinMidnight(startedFromDay),
      endExclusive: berlinMidnight(nextDay(startedToDay)),
    };
  }
  return { filter, start, end, startedBetween, error: null };
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

  app.post(
    "/embed/chats",
    [chatHistoryViewable, validatedRequest, flexUserRoleValid([ROLES.admin, ROLES.manager, ROLES.default])],
    async (request, response) => {
      try {
        const user = await userFromSession(request, response);
        const { offset = 0, limit = 20 } = reqBody(request);
        let embedChats;
        let totalChats;

        // Default users only see chats for embeds in their assigned workspaces
        if (user?.role === ROLES.default) {
          const userWorkspaces = await WorkspaceUser.where({ user_id: user.id });
          const workspaceIds = userWorkspaces.map(ws => ws.workspace_id);
          if (workspaceIds.length === 0) {
            return response.status(200).json({ chats: [], hasPages: false, totalChats: 0 });
          }
          embedChats = await EmbedChats.whereWithEmbedAndWorkspace(
            { embed_config: { workspace_id: { in: workspaceIds } } },
            limit,
            { id: "desc" },
            offset * limit
          );
          totalChats = await EmbedChats.count({ embed_config: { workspace_id: { in: workspaceIds } } });
        } else {
          embedChats = await EmbedChats.whereWithEmbedAndWorkspace(
            {},
            limit,
            { id: "desc" },
            offset * limit
          );
          totalChats = await EmbedChats.count();
        }

        const hasPages = totalChats > (offset + 1) * limit;
        response.status(200).json({ chats: embedChats, hasPages, totalChats });
      } catch (e) {
        console.error(e);
        response.sendStatus(500).end();
      }
    }
  );

  // KIE-538: DELETE /embed/chats/:chatId (einzelne Nachricht löschen) ist mit
  // der Nachrichtentabelle entfallen. Gelöscht wird die ganze Konversation:
  // DELETE /embed/:embedId/conversation (weiter unten).

  // Get conversations (global view, grouped by conversation_id)
  app.post(
    "/embed/chats/conversations",
    [chatHistoryViewable, validatedRequest, flexUserRoleValid([ROLES.admin, ROLES.manager, ROLES.default])],
    async (request, response) => {
      try {
        const user = await userFromSession(request, response);
        const { offset = 0, limit = 20, startDate, endDate } = reqBody(request);

        // Get all conversations (global view)
        const conversations = await EmbedChats.getConversations(
          null,  // NULL = global across all embeds
          offset,
          limit,
          startDate ? new Date(startDate) : null,
          endDate ? new Date(endDate) : null
        );

        // Filter by workspace permissions for default users
        let filteredConversations = conversations;
        if (user?.role === ROLES.default) {
          const userWorkspaces = await WorkspaceUser.where({ user_id: user.id });
          const workspaceIds = userWorkspaces.map(ws => ws.workspace_id);

          // Get embed configs for user's workspaces
          const allowedEmbeds = await EmbedConfig.where({
            workspace_id: { in: workspaceIds }
          });
          const allowedEmbedIds = allowedEmbeds.map(e => e.id);

          // Filter conversations
          filteredConversations = conversations.filter(conv =>
            allowedEmbedIds.includes(conv.embed_id)
          );
        }

        // Count total conversations for pagination
        const { Prisma } = require("@prisma/client");
        const prisma = require("../utils/prisma");

        const dateConditions = [];
        if (startDate) {
          dateConditions.push(Prisma.sql`AND createdAt >= ${new Date(startDate)}`);
        }
        if (endDate) {
          dateConditions.push(Prisma.sql`AND createdAt <= ${new Date(endDate)}`);
        }

        const totalCount = await prisma.$queryRaw`
          SELECT COUNT(DISTINCT COALESCE(conversation_id, session_id)) as count
          FROM embed_chats
          WHERE 1=1
            ${dateConditions.length > 0 ? Prisma.join(dateConditions, " ") : Prisma.empty}
            AND include = 1
        `;

        const hasMore = (offset + limit) < Number(totalCount[0]?.count || 0);
        const total = Number(totalCount[0]?.count || 0);

        response.status(200).json({
          success: true,
          conversations: filteredConversations,
          hasMore,
          totalCount: total,
        });
      } catch (e) {
        console.error(e);
        response.sendStatus(500).end();
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

        const { fromDay, toDay } = reqBody(request) ?? {};
        const range = validateDayRange(fromDay, toDay);
        if (!range.valid) {
          response.status(400).json({ success: false, error: range.error });
          return;
        }

        const [timeline, firstLedgerDay] = await Promise.all([
          MessageLedger.timelineForEmbed(embedId, fromDay, toDay),
          MessageLedger.firstDayForEmbed(embedId),
        ]);

        response.status(200).json({
          success: true,
          fromDay,
          toDay,
          granularity: timeline.granularity,
          totals: timeline.totals,
          buckets: timeline.buckets,
          firstLedgerDay,
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
  app.post(
    "/embed/:embedId/analytics/conversations",
    [chatHistoryViewable, validatedRequest, flexUserRoleValid([ROLES.admin, ROLES.manager, ROLES.default])],
    async (request, response) => {
      try {
        const user = await userFromSession(request, response);
        const embedId = Number(request.params.embedId);
        const body = reqBody(request);
        const { offset = 0, limit = 20 } = body;

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
          error: selectionError,
        } = conversationSelection(body);
        if (selectionError) {
          response.status(400).json({ success: false, error: selectionError });
          return;
        }

        // Liste und Zähler benutzen dieselbe Gruppierung + denselben Filter
        // (EmbedChats._conversationGroupsSql / conversationFilterCondition).
        const [conversations, total] = await Promise.all([
          EmbedChats.getConversations(embedId, offset, limit, start, end, filter, startedBetween),
          EmbedChats.countConversations(embedId, start, end, filter, startedBetween),
        ]);
        const hasMore = offset + limit < total;

        response.status(200).json({
          success: true,
          conversations,
          hasMore,
          totalCount: total,
        });
      } catch (e) {
        console.error(e);
        response.sendStatus(500).end();
      }
    }
  );

  // Analytics: Export der Konversationen einer Auswahl (KIE-538)
  // Dieselben Parameter wie analytics/conversations (Zeitraum,
  // Feedback-Filter, Abschnitt) plus format ("csv" | "json"); geliefert
  // werden genau die Konversationen, die die Liste über alle Seiten zeigt.
  // Dieselben Prüfungen wie beim Einsehen: chatHistoryViewable, Default-User
  // nur für Widgets ihrer Workspaces (403 ohne Daten).
  // Die Datei enthält keine IP-Adresse, keinen Host, keine Kennung der
  // Browser-Sitzung und keine Quellen-Texte (siehe embedConversationExport).
  // Sie wird Zeile für Zeile geschrieben, die Datenbank in Paketen gelesen.
  // Jeder Export steht in event_logs: wer, welches Widget, Format, Zeitraum,
  // Zahl der Konversationen und Zeilen - keine Inhalte.
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
        const { filter, start, end, startedBetween } = selection;
        // Anders als die Liste (leeres Ergebnis) lehnt der Export einen
        // unlesbaren Zeitpunkt ab - eine leere Datei sähe aus wie „keine
        // Konversationen".
        if (
          (start && isNaN(start.getTime())) ||
          (end && isNaN(end.getTime()))
        ) {
          response.status(400).json({
            success: false,
            error: "startDate and endDate must be valid timestamps.",
          });
          return;
        }

        const embed = await EmbedConfig.getWithWorkspace({ id: embedId });
        // Exportiert wird der Abschnitt, wenn einer gewählt ist, sonst der
        // Zeitraum - als Berliner Kalendertage, wie die Zeitpunkte der Datei.
        const fromDay = startedBetween
          ? body.startedFromDay
          : start
            ? berlinDayOf(start)
            : null;
        const toDay = startedBetween
          ? body.startedToDay
          : end
            ? berlinDayOf(end)
            : null;

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
          completed = await writeChunks(response, exported.chunks);
        } finally {
          // Auch ein abgebrochener Export hat Daten ausgeliefert.
          await logExport(completed);
        }
        response.end();
      } catch (e) {
        console.error(e);
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
        console.error(e);
        response.sendStatus(500).end();
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
        const { chatId } = reqBody(request) ?? {};
        const result = await EmbedChats.deleteVisitorConversations(
          embedId,
          chatId
        );
        if (!result) {
          response.sendStatus(500).end();
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
