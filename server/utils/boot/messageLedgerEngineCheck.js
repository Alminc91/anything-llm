const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  ENV_KEY,
  minimumEngineThreads,
  engineThreadsInEffect,
  enginePoolSize,
  parsePoolSize,
} = require("../prisma/engineThreads");
const { MessageLedger } = require("../../models/messageLedger");

/**
 * Selbsttest der Query-Engine beim Start (KIE-532, AK-19).
 *
 * Chat-Zeile und Zähler entstehen in einer interaktiven Transaktion. Das setzt
 * voraus, dass die Engine mehr Arbeits-Threads als Pool-Verbindungen hat
 * (utils/prisma/engineThreads.js). Sonst blockieren wartende Schreiber die
 * offene Transaktion bis zum Busy-Timeout. Geprüft wird vor dem Lauschen, auf
 * zwei Wegen:
 *
 * a) Rechnerisch: Die Arbeits-Threads, mit denen die Engine geladen hat,
 *    müssen über der Poolgröße liegen, die sie beim Verbinden selbst nennt.
 * b) Tatsächlich: Ein zweiter Client auf einer temporären SQLite-Datei (er
 *    teilt sich die Threads der Engine) führt so viele interaktive
 *    Transaktionen gleichzeitig aus, dass auf jeder Verbindung eine wartet,
 *    je zwei Rundläufe. Mit zu wenigen Threads bleibt das stehen. Die
 *    Transaktionen nehmen die Schreibsperre, ändern aber keine Zeile: Der
 *    gemessene Lauf schreibt nicht auf die Platte, eine langsame Platte
 *    führt deshalb nicht zu einem Alarm.
 *
 * Schlägt eine Prüfung fehl, steht das als Fehler in der Konsole und als
 * Ereignis message_ledger_engine_check_failed im Protokoll (nur Zahlen, keine
 * Inhalte). Der Server startet trotzdem. Die Datenbank des Servers wird nur
 * für dieses Ereignis angefasst, im Storage entsteht keine Datei.
 */

const EVENT_ENGINE_CHECK_FAILED = "message_ledger_engine_check_failed";
// Zeitgrenze für alle Transaktionen zusammen; bestanden: rund 0,06 s
const TIME_LIMIT_MS = 1_500;
// Über den Pool hinaus: Transaktionen, die auf eine Verbindung warten
const QUEUED_TRANSACTIONS = 3;
// Größter Pool, den der Lauf nachbildet. Jeder weitere wartende Schreiber
// verlängert auch den bestandenen Lauf (Wartestufen von SQLite, zuletzt je
// 0,1 s; gemessen: 5 Verbindungen 0,06 s, 7 Verbindungen 0,1 s, 9
// Verbindungen 0,18 s, 17 Verbindungen bis 0,85 s, 25 bis 1,6 s und damit über
// der Zeitgrenze). Unter starker Last beim Start (60 rechnende Prozesse auf 4
// Kernen) gemessen, noch mit ändernden Anweisungen: 5 Verbindungen bis 0,7 s,
// 7 bis 0,5 s, 9 bis 0,95 s. Die Grenze von 7 lässt auch dann Abstand zur
// Zeitgrenze. Für größere Pools gilt allein die rechnerische Prüfung.
const MAX_POOL_SIZE = 7;
// Busy-Timeout der Testdatei in Sekunden: über der Zeitgrenze, damit er einen
// bestandenen Lauf nie beendet, und unter den 5 s der Engine, damit ein
// stehender Lauf ihre Threads nicht länger belegt als nötig.
const BUSY_TIMEOUT_SECONDS = 2;
// So lange wartet der Start höchstens auf das Aufräumen eines stehenden Laufs.
const CLEANUP_LIMIT_MS = 10_000;

/** true, wenn promise innerhalb von ms endet (erfüllt oder abgelehnt). */
function settlesWithin(promise, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    const done = () => {
      clearTimeout(timer);
      resolve(true);
    };
    promise.then(done, done);
  });
}

/**
 * Prüfung b: parallele interaktive Transaktionen auf einer temporären Datei.
 * Räumt selbst auf (Client, Datei, Verzeichnis). Wirft, wenn sich die Prüfung
 * nicht ausführen lässt.
 *
 * @param {Object} params
 * @param {number|null} params.poolSize - Poolgröße der Engine des Servers, falls bekannt
 * @param {number|null} params.engineThreads
 * @returns {Promise<{ok: boolean, reason: string|null, poolSize: number|null, parallel: number, completed: number, durationMs: number, error: string|null}>}
 */
async function runParallelTransactions({ poolSize, engineThreads }) {
  const { PrismaClient } = require("@prisma/client");
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "anythingllm-engine-check-")
  );
  let client = null;
  let transactions = [];
  try {
    // Derselbe Pool wie der des Servers, soweit bekannt; sonst der, den die
    // Engine von sich aus anlegt.
    const limit =
      poolSize === null
        ? ""
        : `connection_limit=${Math.min(poolSize, MAX_POOL_SIZE)}&`;
    let ownPoolSize = null;
    client = new PrismaClient({
      datasources: {
        db: {
          url: `file:${path.join(directory, "check.db")}?${limit}socket_timeout=${BUSY_TIMEOUT_SECONDS}`,
        },
      },
      log: [{ emit: "event", level: "info" }],
    });
    client.$on("info", (event) => {
      ownPoolSize = parsePoolSize(event.message) ?? ownPoolSize;
    });
    // Die Tabelle bleibt leer: Die Anweisungen unten nehmen die Schreibsperre
    // und halten sie bis zum COMMIT, finden aber keine Zeile. Wartende
    // Schreiber belegen die Threads der Engine damit wie im Betrieb; es
    // entsteht aber keine geänderte Seite, also kein Journal und kein fsync.
    // Die Zeitgrenze misst so die Engine, nicht die Platte. Mit ändernden
    // Anweisungen enthielt der Lauf rund 40 fsync und meldete sich ab etwa
    // 40 ms je fsync, obwohl die Engine genug Threads hatte (nachgestellt mit
    // verzögertem fsync; ohne Änderung besteht er auch bei 1 s je fsync).
    await client.$executeRawUnsafe(
      `CREATE TABLE engine_check (id INTEGER PRIMARY KEY, rounds INTEGER NOT NULL)`
    );

    const knownPoolSize = poolSize ?? ownPoolSize;
    const outcome = {
      ok: false,
      reason: null,
      poolSize: knownPoolSize,
      parallel: 0,
      completed: 0,
      durationMs: 0,
      error: null,
    };
    // Prüfung a für den Fall, dass erst dieser Client die Poolgröße nennt.
    if (
      knownPoolSize !== null &&
      engineThreads !== null &&
      engineThreads <= knownPoolSize
    )
      return { ...outcome, reason: "threads_not_above_pool" };

    outcome.parallel =
      Math.min(knownPoolSize ?? MAX_POOL_SIZE, MAX_POOL_SIZE) +
      QUEUED_TRANSACTIONS;
    let firstError = null;
    const startedAt = Date.now();
    transactions = Array.from({ length: outcome.parallel }, () =>
      client
        .$transaction(
          async (tx) => {
            await tx.$executeRaw`UPDATE engine_check SET rounds = rounds + 1 WHERE id = 1`;
            await tx.$executeRaw`UPDATE engine_check SET rounds = rounds + 1 WHERE id = 1`;
          },
          { maxWait: TIME_LIMIT_MS, timeout: TIME_LIMIT_MS }
        )
        .then(
          () => {
            outcome.completed += 1;
          },
          (error) => {
            firstError = firstError ?? error;
          }
        )
    );
    const inTime = await settlesWithin(
      Promise.all(transactions),
      TIME_LIMIT_MS
    );
    outcome.durationMs = Date.now() - startedAt;

    if (!inTime) return { ...outcome, reason: "transactions_timed_out" };
    if (firstError)
      return {
        ...outcome,
        reason: "transactions_failed",
        error: MessageLedger.errorSummary(firstError),
      };
    return { ...outcome, ok: true };
  } finally {
    // Erst wenn keine Transaktion mehr läuft: Verbindung schließen, Datei und
    // Verzeichnis entfernen. Nach einem bestandenen Lauf ist das sofort der
    // Fall. Ein stehender Lauf endet mit den Zeitgrenzen der Transaktionen und
    // dem Busy-Timeout; dauert das zu lange, startet der Server und das
    // Aufräumen läuft zu Ende, sobald die Engine wieder frei ist.
    const cleanup = Promise.all(transactions)
      .then(() => client?.$disconnect())
      .catch((error) => console.error(error.message))
      .then(() => fs.rmSync(directory, { recursive: true, force: true }))
      .catch((error) => console.error(error.message));
    await settlesWithin(cleanup, CLEANUP_LIMIT_MS);
  }
}

/** Konsolenfehler und Ereignis - ohne zu werfen. */
async function reportFailure(result) {
  const threads = result.engineThreads ?? "nicht gesetzt";
  let detail;
  if (result.reason === "threads_not_above_pool")
    detail = `${result.engineThreads} Arbeits-Threads bei ${result.poolSize} Verbindungen. Abhilfe: ${ENV_KEY} auf mindestens ${Math.max(result.minimumThreads, result.poolSize + 1)} setzen`;
  else if (result.reason === "check_error")
    detail = `nicht ausführbar: ${result.error}. Ob die Engine mehr Arbeits-Threads als Verbindungen hat, ist damit ungeprüft`;
  else
    detail = `${result.completed} von ${result.parallel} parallelen Transaktionen in ${result.durationMs} ms, Grenze ${result.timeLimitMs} ms${result.error ? `, ${result.error}` : ""}. ${ENV_KEY} beim Laden der Engine: ${threads}, Verbindungen: ${result.poolSize ?? "unbekannt"}`;
  console.error(
    `\x1b[31m[MessageLedger]\x1b[0m Selbsttest der Query-Engine nicht bestanden (${detail}). Hat die Engine nicht mehr Arbeits-Threads als Datenbankverbindungen, bleiben parallele Schreibzugriffe bis zum Busy-Timeout stehen.`
  );
  try {
    const { EventLogs } = require("../../models/eventLogs");
    await EventLogs.logEvent(EVENT_ENGINE_CHECK_FAILED, {
      reason: result.reason,
      poolSize: result.poolSize,
      engineThreads: result.engineThreads,
      minimumThreads: result.minimumThreads,
      parallel: result.parallel,
      completed: result.completed,
      durationMs: result.durationMs,
      timeLimitMs: result.timeLimitMs,
      error: result.error,
    });
  } catch (error) {
    console.error(error.message);
  }
}

/**
 * Führt den Selbsttest aus. Wirft nie; ein Fehler im Selbsttest selbst gilt
 * als nicht bestanden (reason "check_error"), weil die Voraussetzung dann
 * ungeprüft ist.
 *
 * reason: "threads_not_above_pool" (Prüfung a), "transactions_timed_out" oder
 * "transactions_failed" (Prüfung b), "check_error".
 *
 * @returns {Promise<{ok: boolean, reason: string|null, poolSize: number|null, engineThreads: number|null, minimumThreads: number, parallel: number, completed: number, durationMs: number, timeLimitMs: number, error: string|null}>}
 */
async function runMessageLedgerEngineCheck() {
  let result = {
    ok: false,
    reason: null,
    poolSize: null,
    engineThreads: null,
    minimumThreads: null,
    parallel: 0,
    completed: 0,
    durationMs: 0,
    timeLimitMs: TIME_LIMIT_MS,
    error: null,
  };
  try {
    result.minimumThreads = minimumEngineThreads();
    result.poolSize = enginePoolSize();
    result.engineThreads = engineThreadsInEffect();

    // Prüfung a. Steht sie schon fest, entfällt Prüfung b: Der Lauf würde die
    // Threads der Engine bis zum Busy-Timeout belegen, ohne Neues zu zeigen.
    if (
      result.poolSize !== null &&
      result.engineThreads !== null &&
      result.engineThreads <= result.poolSize
    )
      result.reason = "threads_not_above_pool";
    else
      result = {
        ...result,
        ...(await runParallelTransactions({
          poolSize: result.poolSize,
          engineThreads: result.engineThreads,
        })),
      };
  } catch (error) {
    result = {
      ...result,
      ok: false,
      reason: "check_error",
      error: MessageLedger.errorSummary(error),
    };
  }

  if (!result.ok) await reportFailure(result);
  return result;
}

module.exports = {
  EVENT_ENGINE_CHECK_FAILED,
  TIME_LIMIT_MS,
  MAX_POOL_SIZE,
  runMessageLedgerEngineCheck,
};
