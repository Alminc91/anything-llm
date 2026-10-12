/* eslint-env node */
// Kindprozess für utils/prisma/engineThreads.test.js (KIE-532): führt den Job
// jobs/sync-watched-documents.js so aus, wie Bree ihn startet (eigener
// Prozess mit Nachrichtenkanal), und meldet, welchen Wert
// TOKIO_WORKER_THREADS hat, wenn der Job LanceDB lädt.
//
//   fork(syncJobProcess.js, [<datei.db>])
//
// Der Client entsteht wie in utils/prisma/index.js (erst
// ensureEngineThreads, dann der Client), nur gegen die übergebene Testdatei.
// Der Collector ist ersetzt (kein Netz). @lancedb/lancedb selbst wird nicht
// geladen: Der Ladeversuch hält den Wert der Variablen fest und liefert eine
// Attrappe, an deren connect der Job endet.
//
// Nachrichten an den Elternprozess: die Protokollzeilen des Jobs (Text) und
// einmal { lanceLoad: { threads, threadsAtLoad, minimumThreads, warnings } }.
const Module = require("module");
const [file] = process.argv.slice(2);

const warnings = [];
console.log = () => {};
console.error = () => {};
console.warn = (...args) => warnings.push(args.map(String).join(" "));

const engineThreads = require("../../utils/prisma/engineThreads");
engineThreads.ensureEngineThreads();
const threadsAtLoad = process.env.TOKIO_WORKER_THREADS ?? null;

const { PrismaClient } = require("@prisma/client");
const client = new PrismaClient({
  datasources: { db: { url: `file:${file}` } },
  log: ["error", "warn"],
});

function replaceModule(request, exports) {
  const resolved = require.resolve(request);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports,
  };
}
replaceModule("../../utils/prisma", client);
replaceModule("../../utils/collectorApi", {
  CollectorApi: class {
    async online() {
      return true;
    }
    async forwardExtensionRequest() {
      return { content: "neuer Inhalt" };
    }
  },
});

const load = Module._load;
Module._load = function (request, ...rest) {
  if (request !== "@lancedb/lancedb") return load.call(this, request, ...rest);
  process.send({
    lanceLoad: {
      threads: process.env.TOKIO_WORKER_THREADS ?? null,
      threadsAtLoad,
      minimumThreads: engineThreads.minimumEngineThreads(),
      warnings,
    },
  });
  return {
    connect: async () => {
      throw new Error("LanceDB ist in diesem Test nicht geladen");
    },
  };
};

require("../../jobs/sync-watched-documents.js");
