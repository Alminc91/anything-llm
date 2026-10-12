const fs = require("fs");
const os = require("os");

const ENV_KEY = "TOKIO_WORKER_THREADS";
// Info-Zeile der Engine beim Verbinden: so viele Verbindungen hält ihr Pool.
const POOL_SIZE_PATTERN = /Starting a sqlite pool with (\d+) connections/;

// Der Wert, den dieser Prozess selbst gesetzt (und noch nicht zurückgenommen) hat
let valueSetHere = null;
// Ein zu niedriger Wert des Betriebs, den ensureEngineThreads ersetzt hat
let replacedOperatorValue = null;
// Wert der Variablen bei der Freigabe: Mit ihm hat die Engine geladen.
let valueAtRelease;
// Verbindungen im Pool der Engine, mitgelesen aus ihrer Info-Zeile
let poolSize = null;

/** Anzahl aus der Variablen, oder null, wenn sie keine positive ganze Zahl nennt. */
function parseThreads(value) {
  return /^[1-9]\d*$/.test(String(value ?? "")) ? Number(value) : null;
}

/**
 * Physische Kerne, wie die Engine sie für die Größe ihres Pools zählt: je
 * Sockel ("physical id") die Angabe "cpu cores" aus /proc/cpuinfo. Hinter
 * lxcfs nennt diese Angabe die Kerne des Hosts, auch wenn dem Container nur
 * wenige Prozessoren gezeigt werden - der Pool ist dann größer, als die Zahl
 * der sichtbaren Prozessoren vermuten lässt. 0, wenn die Datei nichts hergibt
 * (dann zählt die Engine die Prozessoren, die der Prozess nutzen darf).
 */
function physicalCoresLikeEngine() {
  try {
    const coresBySocket = new Map();
    let socket = null;
    for (const line of fs.readFileSync("/proc/cpuinfo", "utf8").split("\n")) {
      const [key, value] = line.split(":").map((part) => part.trim());
      if (key === "physical id") socket = value;
      else if (key === "cpu cores" && socket !== null) {
        coresBySocket.set(socket, parseThreads(value) ?? 0);
        socket = null;
      }
    }
    let cores = 0;
    for (const count of coresBySocket.values()) cores += count;
    return cores;
  } catch {
    return 0;
  }
}

/**
 * Kleinste Zahl an Arbeits-Threads, mit der die Query-Engine sicher mehr
 * Threads als Verbindungen hat.
 *
 * Gemessen (Prisma 6.14, Architektur-Review vom 12.10.2026): Der Pool hat
 * 2 × physische Kerne + 1 Verbindungen; tokio nimmt ohne Vorgabe die
 * logischen Kerne, die der Prozess nutzen darf. Schon mit Hyper-Threading
 * (2 logische je physischem Kern) sind das weniger Threads als Verbindungen,
 * mit einer CPU-Begrenzung des Containers noch weniger: Die Begrenzung senkt
 * die Threads, nicht den Pool.
 *
 * Gerechnet wird deshalb mit der größten Kernzahl, die der Prozess sieht: den
 * Prozessoren des Hosts (os.cpus, in Docker unabhängig von --cpus und
 * --cpuset-cpus), den nutzbaren Prozessoren und den physischen Kernen, wie die
 * Engine sie zählt. 2 × diese Zahl + 2 liegt über jedem Pool, den die Engine
 * von sich aus anlegt.
 *
 * Nicht erfasst ist ein connection_limit in der Datenbank-URL: Es ist erst
 * mit dem Client bekannt. Das Schema setzt keines
 * (__tests__/utils/prisma/engineThreads.test.js), und der Selbsttest beim
 * Start vergleicht die Threads mit der tatsächlichen Poolgröße
 * (utils/boot/messageLedgerEngineCheck.js).
 * @returns {number}
 */
function minimumEngineThreads() {
  const cores = Math.max(
    os.cpus().length,
    os.availableParallelism?.() ?? 0,
    physicalCoresLikeEngine(),
    1
  );
  return Math.max(2 * cores + 2, 8);
}

/**
 * Sorgt dafür, dass die Query-Engine mehr Arbeits-Threads hat als
 * Datenbankverbindungen (KIE-532).
 *
 * Die Engine führt SQLite-Aufrufe blockierend auf ihren Arbeits-Threads aus.
 * Wartet auf jeder freien Verbindung ein Schreiber auf die Sperre einer
 * interaktiven Transaktion (Chat-Zeile + Zählerbuch), sind alle Threads belegt,
 * und die Transaktion selbst kommt nicht mehr an die Reihe: Stillstand bis zum
 * Busy-Timeout (5 s), danach schlagen die wartenden Schreibzugriffe fehl.
 * Gemessen auf 4 Kernen ab 4 gleichzeitig wartenden Schreibern. Mit mehr
 * Threads als Verbindungen kann das nicht eintreten; wartende Threads schlafen
 * und kosten nichts.
 *
 * Ein vom Betrieb gesetzter Wert gilt nur, wenn er mindestens das Minimum
 * erreicht. Ein kleinerer (oder ungültiger) Wert wird für die Engine ersetzt
 * und mit beiden Werten gemeldet: Gemessen steht der Server mit dem Wert 2
 * unter Last über 90 s still.
 *
 * Reihenfolge, auf die sich das stützt (gemessen, siehe oben):
 * 1. Die Engine liest die Variable mit der ERSTEN ABFRAGE des Prozesses, nicht
 *    beim Laden von @prisma/client und nicht je Client. utils/prisma ruft
 *    diese Funktion beim Laden auf, also vor jeder Abfrage.
 * 2. Die Variable gilt für den ganzen Prozess. LanceDB liest sie beim
 *    require; im Server geschieht das erst mit den Anfragen. Vor dem Lauschen
 *    nimmt utils/boot den Wert deshalb wieder zurück (releaseEngineThreads).
 * 3. Jeder weitere PrismaClient des Prozesses teilt sich die Threads der
 *    Engine; ein späterer Wert der Variablen ändert an ihnen nichts mehr.
 * Ob die Engine tatsächlich mehr Threads als Verbindungen hat, prüft der
 * Selbsttest beim Start. Abgesichert durch
 * __tests__/models/messageLedgerConcurrency.test.js,
 * __tests__/utils/prisma/engineThreads.test.js und
 * __tests__/boot/messageLedgerEngineCheck.test.js.
 */
function ensureEngineThreads() {
  const current = process.env[ENV_KEY];
  if (valueSetHere !== null && current === valueSetHere) return;

  const minimum = minimumEngineThreads();
  valueAtRelease = undefined;
  replacedOperatorValue = null;
  if (current) {
    if ((parseThreads(current) ?? 0) >= minimum) return;
    console.warn(
      `\x1b[33m[Prisma]\x1b[0m ${ENV_KEY}=${current} liegt unter dem Minimum von ${minimum} Arbeits-Threads der Query-Engine (mehr Threads als Datenbankverbindungen, KIE-532). Die Engine lädt mit ${minimum}; für später ladende Module gilt wieder ${current}.`
    );
    replacedOperatorValue = current;
  }
  valueSetHere = String(minimum);
  process.env[ENV_KEY] = valueSetHere;
}

/**
 * Nimmt den Wert zurück, den ensureEngineThreads gesetzt hat. Erst aufrufen,
 * wenn die Engine geladen ist (nach der ersten Abfrage): Sie behält ihre
 * Threads. Die Variable gilt für den ganzen Prozess und würde sonst auch die
 * Threads anderer nativer Module bestimmen, die später laden (LanceDB).
 * Ein vom Betrieb gesetzter Wert steht danach wieder so da, wie er war - auch
 * ein zu niedriger, den ensureEngineThreads für die Engine ersetzt hatte.
 */
function releaseEngineThreads() {
  if (valueAtRelease === undefined) valueAtRelease = process.env[ENV_KEY] ?? "";
  if (valueSetHere !== null && process.env[ENV_KEY] === valueSetHere) {
    if (replacedOperatorValue !== null)
      process.env[ENV_KEY] = replacedOperatorValue;
    else delete process.env[ENV_KEY];
  }
  valueSetHere = null;
  replacedOperatorValue = null;
}

/**
 * Arbeits-Threads, mit denen die Engine geladen hat: der Wert der Variablen
 * bei der Freigabe, davor ihr aktueller Wert. null, wenn sie keine Zahl
 * nannte - dann nimmt tokio die logischen Kerne, die der Prozess nutzen darf.
 * @returns {number|null}
 */
function engineThreadsInEffect() {
  return parseThreads(valueAtRelease ?? process.env[ENV_KEY]);
}

/**
 * Liest die Poolgröße aus einer Info-Zeile der Engine mit. utils/prisma hängt
 * diese Funktion an den Client; die Ausgabe der Zeile auf der Konsole bleibt.
 * @param {string} message
 * @returns {number|null} - die Poolgröße, wenn die Zeile sie nennt
 */
function notePoolSize(message) {
  const size = parsePoolSize(message);
  if (size !== null) poolSize = size;
  return size;
}

/** @returns {number|null} */
function parsePoolSize(message) {
  const match = POOL_SIZE_PATTERN.exec(String(message ?? ""));
  return match ? Number(match[1]) : null;
}

/**
 * Verbindungen im Pool der Engine des Servers; null, solange sie nicht
 * verbunden ist.
 * @returns {number|null}
 */
function enginePoolSize() {
  return poolSize;
}

module.exports = {
  ENV_KEY,
  minimumEngineThreads,
  ensureEngineThreads,
  releaseEngineThreads,
  engineThreadsInEffect,
  notePoolSize,
  parsePoolSize,
  enginePoolSize,
};
