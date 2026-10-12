/* eslint-env jest, node */
// Startet den Startpfad des Servers in einem gewöhnlichen Node-Prozess
// (helpers/engineCheckProcess.js) und liefert, was dort geschah (KIE-532,
// AK-19, AK-20).
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const processFile = path.resolve(__dirname, "engineCheckProcess.js");

/**
 * @param {{file: string}} db - Testdatenbank (helpers/sqliteTestDatabase.js)
 * @param {Object} [options]
 * @param {"wirksam"|"pool_groesser"|"variable_unwirksam"} [options.scenario]
 * @param {string|null} [options.engineThreads] - TOKIO_WORKER_THREADS, wie der Betrieb sie setzt (null: nicht gesetzt, wie im Container)
 * @param {string} [options.temporaryDirectory] - TMPDIR des Prozesses (Standard: ein eigenes, leeres Verzeichnis)
 * @returns {Object} - Ausgabe des Prozesses, dazu storageEntries: was er in seinem (anfangs leeren) Storage hinterlassen hat
 */
function bootInProcess(
  db,
  { scenario = "wirksam", engineThreads = null, temporaryDirectory = null } = {}
) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "engine-check-test-"));
  const storage = path.join(sandbox, "storage");
  const temporary = temporaryDirectory ?? path.join(sandbox, "tmp");
  fs.mkdirSync(storage);
  if (!temporaryDirectory) fs.mkdirSync(temporary);

  const env = { ...process.env, STORAGE_DIR: storage, TMPDIR: temporary };
  if (engineThreads === null) delete env.TOKIO_WORKER_THREADS;
  else env.TOKIO_WORKER_THREADS = engineThreads;

  try {
    const stdout = execFileSync(
      process.execPath,
      [processFile, db.file, scenario],
      {
        env,
        encoding: "utf8",
        timeout: 100000,
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    return {
      ...JSON.parse(stdout.trim().split("\n").pop()),
      storageEntries: fs.readdirSync(storage),
    };
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

module.exports = { bootInProcess };
