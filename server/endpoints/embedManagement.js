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
const { berlinMidnight } = require("../utils/helpers/billingWindow");
const {
  validateDayRange,
  nextDay,
} = require("../utils/helpers/ledgerTimeline");

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

  app.delete(
    "/embed/chats/:chatId",
    [validatedRequest, flexUserRoleValid([ROLES.admin, ROLES.manager, ROLES.default])],
    async (request, response) => {
      try {
        const user = await userFromSession(request, response);
        const { chatId } = request.params;

        // KIE-533: Default-User löschen nur Chats von Widgets ihrer Workspaces.
        if (user?.role === ROLES.default) {
          const chat = await EmbedChats.get({ id: Number(chatId) });
          if (!chat || !(await userCanAccessEmbed(user, chat.embed_id))) {
            response.sendStatus(403).end();
            return;
          }
        }

        await EmbedChats.delete({ id: Number(chatId) });
        response.status(200).json({ success: true, error: null });
      } catch (e) {
        console.error(e);
        response.sendStatus(500).end();
      }
    }
  );

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
  app.post(
    "/embed/:embedId/analytics/conversations",
    [chatHistoryViewable, validatedRequest, flexUserRoleValid([ROLES.admin, ROLES.manager, ROLES.default])],
    async (request, response) => {
      try {
        const user = await userFromSession(request, response);
        const embedId = Number(request.params.embedId);
        const {
          offset = 0,
          limit = 20,
          startDate,
          endDate,
          onlyNegative = false, // KIE-508 (Legacy-Boolean, bleibt gültig)
          feedbackFilter, // KIE-527: "all" | "negative" | "positive"
          startedFromDay, // KIE-536
          startedToDay, // KIE-536
        } = reqBody(request);

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
          if (!range.valid) {
            response.status(400).json({ success: false, error: range.error });
            return;
          }
          startedBetween = {
            start: berlinMidnight(startedFromDay),
            endExclusive: berlinMidnight(nextDay(startedToDay)),
          };
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

  // Analytics: Get conversation details
  // KIE-533 (AK-13): wie die Konversationsliste darüber - chatHistoryViewable,
  // Default-User nur für Widgets ihrer Workspaces (sonst 403 ohne Inhalte).
  app.get(
    "/embed/:embedId/conversation/:sessionId",
    [chatHistoryViewable, validatedRequest, flexUserRoleValid([ROLES.admin, ROLES.manager, ROLES.default]), validEmbedAccess],
    async (request, response) => {
      try {
        const { embedId, sessionId } = request.params;

        const messages = await EmbedChats.getConversationDetails(
          sessionId,
          Number(embedId)
        );

        response.status(200).json({ success: true, messages });
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
