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
// Ausgabe: eine Zeile JSON. Neben den Ergebnissen der Anfragen steht darin,
// - wie lange zwischen zwei abgeschlossenen Speicherungen höchstens nichts
//   voranging (longestPauseMs; für die parallelen Anfragen allein
//   longestParallelPauseMs): das Maß für den Stillstand, den der Test
//   ausschließt. Die Gesamtdauer (durationMs, davon parallelMs für die
//   parallelen Anfragen) hängt dagegen an der Platte - jede Speicherung wartet
//   auf fsync;
// - wie viele Transaktionen zugleich in der Engine anstanden
//   (mostOpenTransactions): mit der Reihe in MessageLedger.transaction eine.
const { performance } = require("perf_hooks");

const [file, workspaceId, embedId, requests] = process.argv.slice(2);

const errors = [];
console.log = () => {};
console.error = (...args) => errors.push(args.map(String).join(" "));

require("../../utils/prisma/engineThreads").ensureEngineThreads();
const { PrismaClient } = require("@prisma/client");
const client = new PrismaClient({
  datasources: { db: { url: `file:${file}` } },
});
// Transaktionen, die gerade offen sind oder in der Engine auf ihren Beginn
// warten - und wie viele es zugleich höchstens waren.
let openTransactions = 0;
let mostOpenTransactions = 0;
async function countedTransaction(...args) {
  openTransactions += 1;
  mostOpenTransactions = Math.max(mostOpenTransactions, openTransactions);
  try {
    return await client.$transaction(...args);
  } finally {
    openTransactions -= 1;
  }
}

// Die Modelle sollen diese Datenbank als utils/prisma sehen.
const prismaModule = require.resolve("../../utils/prisma");
require.cache[prismaModule] = {
  id: prismaModule,
  filename: prismaModule,
  loaded: true,
  exports: new Proxy(client, {
    get(target, property) {
      if (property === "$transaction") return countedTransaction;
      const value = target[property];
      return typeof value === "function" ? value.bind(target) : value;
    },
  }),
};

const { WorkspaceChats } = require("../../models/workspaceChats");
const { EmbedChats } = require("../../models/embedChats");
const { EventLogs } = require("../../models/eventLogs");

// Zeitpunkte (monoton), zu denen eine Speicherung gelungen ist
const completedAt = [];

/**
 * Merkt den Zeitpunkt, wenn die Speicherung gelungen ist. Eine gescheiterte
 * zählt nicht als Fortschritt: Nach einem Stillstand scheitern die wartenden
 * Schreibzugriffe gemeinsam.
 * @template T
 * @param {Promise<T>} saving
 * @param {(result: T) => boolean} succeeded
 * @returns {Promise<T>}
 */
async function tracked(saving, succeeded) {
  const result = await saving;
  if (succeeded(result)) completedAt.push(performance.now());
  return result;
}

/**
 * Längste Zeit zwischen from und to, in der keine Speicherung abgeschlossen
 * wurde - Beginn und Ende des Abschnitts zählen als Grenzen mit. Ohne eine
 * einzige gelungene Speicherung ist das der ganze Abschnitt.
 * @param {number} from
 * @param {number} to
 * @returns {number} - Millisekunden, gerundet
 */
function longestPause(from, to) {
  const marks = completedAt
    .filter((mark) => mark >= from && mark <= to)
    .sort((a, b) => a - b);
  let longest = 0;
  let previous = from;
  for (const mark of [...marks, to]) {
    longest = Math.max(longest, mark - previous);
    previous = mark;
  }
  return Math.round(longest);
}

(async () => {
  const startedAt = performance.now();
  // Je Anfrage wie im Server: Chat speichern, danach ein Ereignis schreiben.
  const results = await Promise.all(
    Array.from({ length: Number(requests) }, async (_, i) => {
      const saved = await tracked(
        i % 2 === 0
          ? WorkspaceChats.new({
              workspaceId: Number(workspaceId),
              prompt: `Frage ${i}`,
              response: { text: "Antwort" },
            })
          : EmbedChats.new({
              embedId: Number(embedId),
              prompt: `Frage ${i}`,
              response: { text: "Antwort" },
              sessionId: `sitzung-${i % 5}`,
              conversationId: `konversation-${i % 5}`,
            }),
        (result) => result.message === null
      );
      const logged = await EventLogs.logEvent("sent_chat", { request: i });
      return { saved: saved.message, logged: logged.message };
    })
  );
  const parallelDoneAt = performance.now();

  // Danach gleichzeitig: Bewertungen, neue Nachrichten und Kopien
  const rated = await client.embed_chats.findMany({ take: 10 });
  const mixed = await Promise.all([
    ...rated.map((chat, i) =>
      tracked(
        EmbedChats.updateFeedbackScore(
          chat.embed_id,
          chat.session_id,
          chat.id,
          i % 2 === 0
        ),
        (result) => result === true
      )
    ),
    ...Array.from({ length: 10 }, () =>
      tracked(
        WorkspaceChats.new({ workspaceId: Number(workspaceId), prompt: "neu" }),
        (result) => result.message === null
      )
    ),
    tracked(
      WorkspaceChats.bulkCreate(
        Array.from({ length: 10 }, () => ({
          workspaceId: Number(workspaceId),
          prompt: "Kopie",
          response: "{}",
        }))
      ),
      (result) => result.message === null
    ),
  ]);
  const finishedAt = performance.now();

  await client.$disconnect();
  process.stdout.write(
    `${JSON.stringify({
      engineThreads: process.env.TOKIO_WORKER_THREADS,
      durationMs: Math.round(finishedAt - startedAt),
      parallelMs: Math.round(parallelDoneAt - startedAt),
      longestPauseMs: longestPause(startedAt, finishedAt),
      longestParallelPauseMs: longestPause(startedAt, parallelDoneAt),
      mostOpenTransactions,
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
