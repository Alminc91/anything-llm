/* eslint-env node */
// Kindprozess für messageLedgerConcurrency.test.js (KIE-532).
//
// Jest gibt Tests eine Kopie von process.env: Was ein Test dort setzt, erreicht
// die Query-Engine nicht. Ob utils/prisma/engineThreads.js wirkt, lässt sich
// deshalb nur in einem gewöhnlichen Node-Prozess prüfen - so wie der Server
// läuft. Dieser Prozess baut den Client wie utils/prisma/index.js (erst
// ensureEngineThreads, dann der Client), nur gegen die übergebene Testdatei,
// und lässt die Modelle des Servers parallele Anfragen verarbeiten.
//
//   node concurrentRequests.js <datei.db> <workspaceId> <embedId> <anfragen>
//
// Ausgabe: eine Zeile JSON.
const [file, workspaceId, embedId, requests] = process.argv.slice(2);

const errors = [];
console.log = () => {};
console.error = (...args) => errors.push(args.map(String).join(" "));

require("../../utils/prisma/engineThreads").ensureEngineThreads();
const { PrismaClient } = require("@prisma/client");
const client = new PrismaClient({
  datasources: { db: { url: `file:${file}` } },
});
// Die Modelle sollen diese Datenbank als utils/prisma sehen.
const prismaModule = require.resolve("../../utils/prisma");
require.cache[prismaModule] = {
  id: prismaModule,
  filename: prismaModule,
  loaded: true,
  exports: client,
};

const { WorkspaceChats } = require("../../models/workspaceChats");
const { EmbedChats } = require("../../models/embedChats");
const { EventLogs } = require("../../models/eventLogs");

(async () => {
  const startedAt = Date.now();
  // Je Anfrage wie im Server: Chat speichern, danach ein Ereignis schreiben.
  const results = await Promise.all(
    Array.from({ length: Number(requests) }, async (_, i) => {
      const saved =
        i % 2 === 0
          ? await WorkspaceChats.new({
              workspaceId: Number(workspaceId),
              prompt: `Frage ${i}`,
              response: { text: "Antwort" },
            })
          : await EmbedChats.new({
              embedId: Number(embedId),
              prompt: `Frage ${i}`,
              response: { text: "Antwort" },
              sessionId: `sitzung-${i % 5}`,
              conversationId: `konversation-${i % 5}`,
            });
      const logged = await EventLogs.logEvent("sent_chat", { request: i });
      return { saved: saved.message, logged: logged.message };
    })
  );

  // Danach gleichzeitig: Bewertungen, neue Nachrichten und Kopien
  const rated = await client.embed_chats.findMany({ take: 10 });
  const mixed = await Promise.all([
    ...rated.map((chat, i) =>
      EmbedChats.updateFeedbackScore(
        chat.embed_id,
        chat.session_id,
        chat.id,
        i % 2 === 0
      )
    ),
    ...Array.from({ length: 10 }, () =>
      WorkspaceChats.new({ workspaceId: Number(workspaceId), prompt: "neu" })
    ),
    WorkspaceChats.bulkCreate(
      Array.from({ length: 10 }, () => ({
        workspaceId: Number(workspaceId),
        prompt: "Kopie",
        response: "{}",
      }))
    ),
  ]);

  await client.$disconnect();
  process.stdout.write(
    `${JSON.stringify({
      engineThreads: process.env.TOKIO_WORKER_THREADS,
      durationMs: Date.now() - startedAt,
      failedSaves: results.filter((result) => result.saved !== null).length,
      failedEvents: results.filter((result) => result.logged !== null).length,
      ratings: mixed.slice(0, rated.length),
      newChats: mixed.slice(rated.length, -1).map((result) => result.message),
      copies: mixed[mixed.length - 1].message,
      errors,
    })}\n`
  );
})().catch((error) => {
  process.stdout.write(
    `${JSON.stringify({ crashed: error.message, errors })}\n`
  );
  process.exitCode = 1;
});
