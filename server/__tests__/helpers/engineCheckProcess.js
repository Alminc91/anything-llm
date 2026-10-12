/* eslint-env node */
// Kindprozess für boot/messageLedgerEngineCheck.test.js und
// utils/prisma/engineThreads.test.js (KIE-532, AK-19, AK-20).
//
// Mit wie vielen Arbeits-Threads die Query-Engine lädt, entscheidet sich an
// der Umgebung des Prozesses bei der ersten Abfrage. Jest gibt Tests nur eine
// Kopie von process.env, die die Engine nicht erreicht - prüfbar ist das nur
// in einem gewöhnlichen Node-Prozess, so wie der Server läuft.
//
// Dieser Prozess baut den Client wie utils/prisma/index.js (erst
// ensureEngineThreads, dann der Client mit dem Zuhörer für die Poolgröße), nur
// gegen die übergebene Testdatei, und durchläuft dann den echten Startpfad
// (bootHTTP) mit einer App, die nur das Lauschen festhält.
//
//   node engineCheckProcess.js <datei.db> <szenario>
//
// Szenarien:
//   wirksam            wie im Container
//   pool_groesser      die Datenbank-URL verlangt mehr Verbindungen, als die
//                      Engine Arbeits-Threads hat (connection_limit)
//   variable_unwirksam die Engine lädt mit 2 Arbeits-Threads, obwohl die
//                      Variable den Sollwert nennt (als hätte die Engine sie
//                      nicht gelesen)
//
// Ausgabe: eine Zeile JSON.
const fs = require("fs");
const os = require("os");
const path = require("path");
const [file, scenario = "wirksam"] = process.argv.slice(2);

const output = { errors: [], warnings: [] };
const text = (args) => args.map(String).join(" ");
console.log = () => {};
console.error = (...args) => output.errors.push(text(args));
console.warn = (...args) => output.warnings.push(text(args));

const engineThreads = require("../../utils/prisma/engineThreads");
engineThreads.ensureEngineThreads();
output.minimumThreads = engineThreads.minimumEngineThreads();
output.threadsAtLoad = process.env.TOKIO_WORKER_THREADS;

const { PrismaClient } = require("@prisma/client");
const url =
  scenario === "pool_groesser"
    ? `file:${file}?connection_limit=${Number(output.threadsAtLoad) + 1}`
    : `file:${file}`;
const client = new PrismaClient({
  datasources: { db: { url } },
  log: ["error", "info", "warn"],
});
client.$on("info", (event) => engineThreads.notePoolSize(event.message));

// Der Server soll diese Datenbank als utils/prisma sehen; was erst nach dem
// Lauschen geschieht, wird nicht geladen.
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
replaceModule("../../models/telemetry", { Telemetry: { flush() {} } });
replaceModule("../../utils/BackgroundWorkers", { BackgroundService: class {} });
replaceModule("../../utils/EncryptionManager", { EncryptionManager: class {} });
replaceModule("../../utils/comKey", { CommunicationKey: class {} });
replaceModule("../../utils/telemetry", () => {});
replaceModule("../../utils/boot/eagerLoadContextWindows", () => {});
replaceModule("../../utils/boot/markOnboarded", () => {});
replaceModule("../../utils/PushNotifications", { PushNotifications: {} });

// Was der Selbsttest in seine Testdatei geschrieben hat, kurz bevor er sie
// entfernt: SQLite zählt im Kopf der Datei (Byte 24 bis 27) jede Transaktion,
// die etwas geändert hat.
const rmSync = fs.rmSync;
fs.rmSync = (target, ...rest) => {
  const checkFile = path.join(String(target), "check.db");
  if (fs.existsSync(checkFile))
    output.checkFileChanges = fs.readFileSync(checkFile).readUInt32BE(24);
  return rmSync(target, ...rest);
};

// Ergebnis und Dauer des Selbsttests mitschreiben, ohne ihn zu verändern.
const engineCheck = require("../../utils/boot/messageLedgerEngineCheck");
const runEngineCheck = engineCheck.runMessageLedgerEngineCheck;
engineCheck.runMessageLedgerEngineCheck = async (...args) => {
  const startedAt = Date.now();
  output.threadsAtCheck = process.env.TOKIO_WORKER_THREADS ?? null;
  output.check = await runEngineCheck(...args);
  output.checkMs = Date.now() - startedAt;
  return output.check;
};

(async () => {
  if (scenario === "variable_unwirksam") {
    const expected = process.env.TOKIO_WORKER_THREADS;
    process.env.TOKIO_WORKER_THREADS = "2";
    await client.$queryRaw`SELECT 1`;
    process.env.TOKIO_WORKER_THREADS = expected;
  }

  const { bootHTTP } = require("../../utils/boot");
  const listening = new Promise((resolve) => {
    const app = {
      listen: (port) => {
        resolve({
          port,
          threadsAtListen: process.env.TOKIO_WORKER_THREADS ?? null,
        });
        return { on() {} };
      },
    };
    bootHTTP(app, 3999);
  });
  output.listening = await listening;
  // Was der Selbsttest im temporären Verzeichnis hinterlassen hat
  output.temporaryEntries = fs.existsSync(os.tmpdir())
    ? fs.readdirSync(os.tmpdir())
    : null;

  await client.$disconnect();
  process.stdout.write(`${JSON.stringify(output)}\n`);
})().catch((error) => {
  process.stdout.write(
    `${JSON.stringify({ ...output, crashed: error.message })}\n`
  );
  process.exitCode = 1;
});
