// KIE-532: vor dem Laden der Engine, siehe engineThreads.js
const { ensureEngineThreads, notePoolSize } = require("./engineThreads");
ensureEngineThreads();
const { PrismaClient } = require("@prisma/client");

// npx prisma introspect
// npx prisma generate
// npx prisma migrate dev --name init -> ensures that db is in sync with schema
// npx prisma migrate reset -> resets the db

const logLevels = ["error", "info", "warn"]; // add "query" to debug query logs
const prisma = new PrismaClient({
  log: logLevels,
});
// KIE-532: Die Engine nennt beim Verbinden die Größe ihres Pools. Der Selbsttest
// beim Start (utils/boot/messageLedgerEngineCheck.js) vergleicht sie mit den
// Arbeits-Threads. Ein weiterer Zuhörer - die Ausgabe auf der Konsole bleibt.
// Ohne ihn liest der Selbsttest die Poolgröße an seinem eigenen Client ab.
try {
  prisma.$on("info", (event) => notePoolSize(event.message));
} catch (error) {
  console.error(error.message);
}

module.exports = prisma;
