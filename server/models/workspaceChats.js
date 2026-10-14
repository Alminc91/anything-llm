const prisma = require("../utils/prisma");
const { safeJSONStringify } = require("../utils/helpers/chat/responses");
const { MessageLedger } = require("./messageLedger");

const WorkspaceChats = {
  /**
   * Legt eine Chat-Zeile an und zählt sie im Zählerbuch (KIE-532): +1 messages
   * in der Zeile des Workspaces (embed_id 0) für den Berliner Tag und die
   * Berliner Stunde, auch bei include = false. Zeile und Zähler entstehen in
   * einer Transaktion - gemeinsam oder gar nicht.
   *
   * Scheitert die Transaktion an einer Sperre, wird sie wiederholt (KIE-542).
   * createdAt wird dafür vor dem ersten Versuch festgelegt: Eine Wiederholung
   * erkennt daran eine Zeile, die ein früherer Versuch trotz Fehlermeldung
   * geschrieben hat, und legt sie nicht noch einmal an.
   */
  new: async function ({
    workspaceId,
    prompt,
    response = {},
    user = null,
    threadId = null,
    include = true,
    apiSessionId = null,
  }) {
    try {
      const data = {
        workspaceId,
        prompt,
        response: safeJSONStringify(response),
        user_id: user?.id || null,
        thread_id: threadId,
        api_session_id: apiSessionId,
        include,
        createdAt: new Date(),
      };
      const chat = await MessageLedger.transaction(
        { source: "workspace_chat", workspaceId },
        async (tx) => {
          const created = await tx.workspace_chats.create({ data });
          await MessageLedger.record(tx, {
            workspaceId: created.workspaceId,
            at: created.createdAt,
            messages: 1,
          });
          return created;
        },
        {
          retry: {
            // Zeitpunkt, Herkunft und Inhalt machen die Zeile eindeutig.
            findExisting: (tx) =>
              tx.workspace_chats.findFirst({
                where: {
                  workspaceId: data.workspaceId,
                  createdAt: data.createdAt,
                  user_id: data.user_id,
                  thread_id: data.thread_id,
                  api_session_id: data.api_session_id,
                  prompt: data.prompt,
                  response: data.response,
                },
              }),
          },
        }
      );
      return { chat, message: null };
    } catch (error) {
      console.error(error.message);
      return { chat: null, message: error.message };
    }
  },

  forWorkspaceByUser: async function (
    workspaceId = null,
    userId = null,
    limit = null,
    orderBy = null
  ) {
    if (!workspaceId || !userId) return [];
    try {
      const chats = await prisma.workspace_chats.findMany({
        where: {
          workspaceId,
          user_id: userId,
          thread_id: null, // this function is now only used for the default thread on workspaces and users
          api_session_id: null, // do not include api-session chats in the frontend for anyone.
          include: true,
        },
        ...(limit !== null ? { take: limit } : {}),
        ...(orderBy !== null ? { orderBy } : { orderBy: { id: "asc" } }),
      });
      return chats;
    } catch (error) {
      console.error(error.message);
      return [];
    }
  },

  forWorkspaceByApiSessionId: async function (
    workspaceId = null,
    apiSessionId = null,
    limit = null,
    orderBy = null
  ) {
    if (!workspaceId || !apiSessionId) return [];
    try {
      const chats = await prisma.workspace_chats.findMany({
        where: {
          workspaceId,
          user_id: null,
          api_session_id: String(apiSessionId),
          thread_id: null,
        },
        ...(limit !== null ? { take: limit } : {}),
        ...(orderBy !== null ? { orderBy } : { orderBy: { id: "asc" } }),
      });
      return chats;
    } catch (error) {
      console.error(error.message);
      return [];
    }
  },

  forWorkspace: async function (
    workspaceId = null,
    limit = null,
    orderBy = null
  ) {
    if (!workspaceId) return [];
    try {
      const chats = await prisma.workspace_chats.findMany({
        where: {
          workspaceId,
          thread_id: null, // this function is now only used for the default thread on workspaces
          api_session_id: null, // do not include api-session chats in the frontend for anyone.
          include: true,
        },
        ...(limit !== null ? { take: limit } : {}),
        ...(orderBy !== null ? { orderBy } : { orderBy: { id: "asc" } }),
      });
      return chats;
    } catch (error) {
      console.error(error.message);
      return [];
    }
  },

  /**
   * @deprecated Use markThreadHistoryInvalidV2 instead.
   */
  markHistoryInvalid: async function (workspaceId = null, user = null) {
    if (!workspaceId) return;
    try {
      await prisma.workspace_chats.updateMany({
        where: {
          workspaceId,
          user_id: user?.id,
          thread_id: null, // this function is now only used for the default thread on workspaces
        },
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
   * @deprecated Use markThreadHistoryInvalidV2 instead.
   */
  markThreadHistoryInvalid: async function (
    workspaceId = null,
    user = null,
    threadId = null
  ) {
    if (!workspaceId || !threadId) return;
    try {
      await prisma.workspace_chats.updateMany({
        where: {
          workspaceId,
          thread_id: threadId,
          user_id: user?.id,
        },
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
   * @description This function is used to mark a thread's history as invalid.
   * and works with an arbitrary where clause.
   * @param {Object} whereClause - The where clause to update the chats.
   * @param {Object} data - The data to update the chats with.
   * @returns {Promise<void>}
   */
  markThreadHistoryInvalidV2: async function (whereClause = {}) {
    if (!whereClause) return;
    try {
      await prisma.workspace_chats.updateMany({
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

  get: async function (clause = {}, limit = null, orderBy = null) {
    try {
      const chat = await prisma.workspace_chats.findFirst({
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
      await prisma.workspace_chats.deleteMany({
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
      const chats = await prisma.workspace_chats.findMany({
        where: clause,
        ...(limit !== null ? { take: limit } : {}),
        ...(offset !== null ? { skip: offset } : {}),
        ...(orderBy !== null ? { orderBy } : {}),
      });
      return chats;
    } catch (error) {
      console.error(error.message);
      return [];
    }
  },

  /**
   * @param {Object} clause - Prisma where clause
   * @param {{throwOnError?: boolean}} [options] - KIE-534: true reicht einen
   * Datenbankfehler weiter, statt ihn als 0 zu zählen (Limitprüfung der Agent-Sitzung).
   * @returns {Promise<number>}
   */
  count: async function (clause = {}, { throwOnError = false } = {}) {
    try {
      const count = await prisma.workspace_chats.count({
        where: clause,
      });
      return count;
    } catch (error) {
      console.error(error.message);
      if (throwOnError) throw error;
      return 0;
    }
  },

  whereWithData: async function (
    clause = {},
    limit = null,
    offset = null,
    orderBy = null
  ) {
    const { Workspace } = require("./workspace");
    const { User } = require("./user");

    try {
      const results = await this.where(clause, limit, orderBy, offset);

      for (const res of results) {
        const workspace = await Workspace.get({ id: res.workspaceId });
        res.workspace = workspace
          ? { name: workspace.name, slug: workspace.slug }
          : { name: "deleted workspace", slug: null };

        const user = res.user_id ? await User.get({ id: res.user_id }) : null;
        res.user = user
          ? { username: user.username }
          : { username: res.api_session_id !== null ? "API" : "unknown user" };
      }

      return results;
    } catch (error) {
      console.error(error.message);
      return [];
    }
  },
  updateFeedbackScore: async function (chatId = null, feedbackScore = null) {
    if (!chatId) return;
    try {
      await prisma.workspace_chats.update({
        where: {
          id: Number(chatId),
        },
        data: {
          feedbackScore:
            feedbackScore === null ? null : Number(feedbackScore) === 1,
        },
      });
      return;
    } catch (error) {
      console.error(error.message);
    }
  },

  // Explicit update of settings + key validations.
  // Only use this method when directly setting a key value
  // that takes no user input for the keys being modified.
  _update: async function (id = null, data = {}) {
    if (!id) throw new Error("No workspace chat id provided for update");

    try {
      await prisma.workspace_chats.update({
        where: { id },
        data,
      });
      return true;
    } catch (error) {
      console.error(error.message);
      return false;
    }
  },
  /**
   * Legt Kopien vorhandener Chats an (Thread-Verzweigung). Kopien zählen nicht
   * aufs Kontingent (KIE-532): Im Zählerbuch steigt copied, nicht messages.
   * Alle Kopien und ihre Zähler entstehen in einer Transaktion.
   * Nicht für neue Nachrichten verwenden - dafür gibt es new.
   */
  bulkCreate: async function (chatsData = []) {
    // TODO: Replace with createMany when we update prisma to latest version
    // The version of prisma that we are currently using does not support createMany with SQLite
    try {
      if (chatsData.length === 0) return { chats: [], message: null };
      // Alle Kopien gehen in denselben Thread (Thread-Verzweigung)
      const threadIds = new Set(chatsData.map((chat) => chat.thread_id));
      const [onlyThreadId] = threadIds;
      const forkThreadId =
        threadIds.size === 1 && Number.isInteger(onlyThreadId)
          ? onlyThreadId
          : null;
      const createdChats = await MessageLedger.transaction(
        { source: "thread_fork", workspaceId: chatsData[0]?.workspaceId },
        async (tx) => {
          const chats = [];
          // Kopien je Workspace und Berliner Stunde zusammengefasst buchen
          const copies = new Map();
          for (const chatData of chatsData) {
            const chat = await tx.workspace_chats.create({
              data: chatData,
            });
            chats.push(chat);

            const { day, hour } = MessageLedger.berlinDayHour(chat.createdAt);
            const key = `${chat.workspaceId}|${day}|${hour}`;
            const entry = copies.get(key) ?? {
              workspaceId: chat.workspaceId,
              at: chat.createdAt,
              copied: 0,
            };
            entry.copied += 1;
            copies.set(key, entry);
          }
          for (const entry of copies.values())
            await MessageLedger.record(tx, entry);
          return chats;
        },
        // Eine Anweisung je Kopie: lange Threads brauchen mehr als die
        // Zeitgrenze einer einzelnen Nachricht.
        {
          timeout:
            MessageLedger.TRANSACTION_OPTIONS.timeout + 20 * chatsData.length,
          // KIE-542: Wiederholt wird nur die Verzweigung in einen Thread. Er
          // ist eben erst angelegt; stehen dort schon Zeilen, hat ein früherer
          // Versuch trotz Fehlermeldung gespeichert.
          ...(forkThreadId !== null
            ? {
                retry: {
                  findExisting: async (tx) => {
                    const chats = await tx.workspace_chats.findMany({
                      where: { thread_id: forkThreadId },
                      orderBy: { id: "asc" },
                    });
                    return chats.length > 0 ? chats : null;
                  },
                },
              }
            : {}),
        }
      );
      return { chats: createdChats, message: null };
    } catch (error) {
      console.error(error.message);
      return { chats: null, message: error.message };
    }
  },
};

module.exports = { WorkspaceChats };
