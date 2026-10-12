/* eslint-env jest, node */
// Testaufbau mit echter SQLite-Datei (KIE-532).
//
// Erzeugt je Test eine frische Datenbank aus den Migrationen: `prisma migrate
// deploy` läuft je Jest-Prozess einmal in eine Vorlage, jeder Test bekommt
// eine Kopie davon. Transaktionen, Fremdschlüssel, Kaskaden, Migration und
// Nachtrag sind damit gegen die echte Datenbank prüfbar, nicht gegen Attrappen.
//
// Verwendung in einer Testdatei:
//
//   jest.mock("../../utils/prisma", () =>
//     require("../helpers/sqliteTestDatabase").testPrisma
//   );
//   const { createTestDatabase } = require("../helpers/sqliteTestDatabase");
//
//   let db;
//   beforeEach(async () => { db = await createTestDatabase(); });
//   afterEach(async () => { await db.close(); });
//
// testPrisma steht anstelle von utils/prisma und leitet an die zuletzt
// erzeugte (bzw. mit db.activate() gewählte) Datenbank weiter. Die Modelle des
// Servers arbeiten so ohne Änderung gegen die Testdatei.
//
// Die Dateien liegen unter os.tmpdir() und werden beim Schließen entfernt.
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const serverRoot = path.resolve(__dirname, "../..");
const prismaRoot = path.join(serverRoot, "prisma");
const prismaCli = require.resolve("prisma/build/index.js", {
  paths: [serverRoot],
});

const LEDGER_MIGRATION = "20261012150626_add_message_ledger";

// Der Zustand liegt am globalen Objekt: Mit jest.isolateModules wird diese
// Datei erneut geladen und muss dieselbe Datenbank sehen.
const state = (globalThis.__sqliteTestDatabase ??= {
  root: null,
  templates: new Map(),
  current: null,
  counter: 0,
});

function root() {
  if (!state.root)
    state.root = fs.mkdtempSync(path.join(os.tmpdir(), "anythingllm-test-db-"));
  return state.root;
}

function allMigrations() {
  return fs
    .readdirSync(path.join(prismaRoot, "migrations"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/**
 * `prisma migrate deploy` gegen eine SQLite-Datei. Das Schema nennt die
 * Datenbank fest; deshalb läuft der Befehl über eine Kopie von Schema und
 * Migrationen, in der nur die Datenquelle auf die Zieldatei zeigt.
 * @param {string} file - Zieldatei
 * @param {string[]} migrations - Namen der anzuwendenden Migrationen
 */
function migrateDeploy(file, migrations) {
  const workDir = fs.mkdtempSync(path.join(root(), "prisma-"));
  const schema = fs
    .readFileSync(path.join(prismaRoot, "schema.prisma"), "utf8")
    .replace(
      /url\s*=\s*"file:\.\.\/storage\/anythingllm\.db"/,
      `url = "file:${file}"`
    );
  if (!schema.includes(`url = "file:${file}"`))
    throw new Error("Datenquelle im Schema nicht gefunden.");
  fs.writeFileSync(path.join(workDir, "schema.prisma"), schema);

  const target = path.join(workDir, "migrations");
  fs.mkdirSync(target);
  fs.copyFileSync(
    path.join(prismaRoot, "migrations", "migration_lock.toml"),
    path.join(target, "migration_lock.toml")
  );
  for (const name of migrations)
    fs.cpSync(
      path.join(prismaRoot, "migrations", name),
      path.join(target, name),
      { recursive: true }
    );

  try {
    return execFileSync(
      process.execPath,
      [
        prismaCli,
        "migrate",
        "deploy",
        "--schema",
        path.join(workDir, "schema.prisma"),
      ],
      {
        cwd: workDir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          CHECKPOINT_DISABLE: "1",
          PRISMA_HIDE_UPDATE_MESSAGE: "1",
        },
      }
    );
  } catch (error) {
    throw new Error(
      `prisma migrate deploy fehlgeschlagen:\n${error.stdout ?? ""}\n${error.stderr ?? ""}`
    );
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

/**
 * Weicht die Datenbank vom Prisma-Schema ab? `prisma migrate diff` von der
 * Datei zum Schema; leer heißt: kein Unterschied.
 * @param {string} file
 * @returns {string} - SQL, das den Unterschied beheben würde ("" = keiner)
 */
function schemaDrift(file) {
  try {
    execFileSync(
      process.execPath,
      [
        prismaCli,
        "migrate",
        "diff",
        "--from-url",
        `file:${file}`,
        "--to-schema-datamodel",
        path.join(prismaRoot, "schema.prisma"),
        "--script",
        "--exit-code",
      ],
      {
        cwd: root(),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          CHECKPOINT_DISABLE: "1",
          PRISMA_HIDE_UPDATE_MESSAGE: "1",
        },
      }
    );
    return "";
  } catch (error) {
    // Status 2: Es gibt einen Unterschied, das SQL steht in der Ausgabe.
    if (error.status === 2) return String(error.stdout);
    throw new Error(
      `prisma migrate diff fehlgeschlagen:\n${error.stdout ?? ""}\n${error.stderr ?? ""}`
    );
  }
}

function templateFor(migrations) {
  const key = migrations.join(",");
  if (!state.templates.has(key)) {
    const file = path.join(root(), `template-${state.templates.size}.db`);
    migrateDeploy(file, migrations);
    state.templates.set(key, file);
  }
  return state.templates.get(key);
}

function openClient(file) {
  require("../../utils/prisma/engineThreads").ensureEngineThreads();
  const { PrismaClient } = require("@prisma/client");
  return new PrismaClient({ datasources: { db: { url: `file:${file}` } } });
}

/**
 * Frische Datenbank aus den Migrationen.
 * @param {Object} [options]
 * @param {boolean} [options.withoutLedger] - Stand vor KIE-532: ohne die Migration des Zählerbuchs (nachholen mit db.migrate())
 * @param {boolean} [options.activate] - als Datenbank des Servers setzen (Standard: ja)
 */
async function createTestDatabase({
  withoutLedger = false,
  activate = true,
} = {}) {
  const migrations = allMigrations().filter(
    (name) => !withoutLedger || name !== LEDGER_MIGRATION
  );
  const file = path.join(root(), `test-${++state.counter}.db`);
  fs.copyFileSync(templateFor(migrations), file);

  const db = {
    file,
    client: openClient(file),
    /** Leitet utils/prisma (testPrisma) auf diese Datenbank. */
    activate() {
      state.current = db.client;
      return db;
    },
    /** Wendet die noch fehlenden Migrationen an (wie beim Start des Containers). */
    async migrate() {
      const wasActive = state.current === db.client;
      await db.client.$disconnect();
      const output = migrateDeploy(file, allMigrations());
      db.client = openClient(file);
      if (wasActive) state.current = db.client;
      return output;
    },
    async close() {
      if (state.current === db.client) state.current = null;
      await db.client.$disconnect();
      for (const suffix of ["", "-journal", "-wal", "-shm"])
        fs.rmSync(`${file}${suffix}`, { force: true });
    },
  };
  if (activate) db.activate();
  return db;
}

/**
 * Ersatz für utils/prisma: leitet jeden Zugriff an die aktive Testdatenbank
 * weiter. Ohne aktive Datenbank schlägt der Zugriff fehl, statt still die
 * Datenbank des Servers zu öffnen.
 */
const testPrisma = new Proxy(
  {},
  {
    get(_target, property) {
      if (property === "then") return undefined;
      if (!state.current)
        throw new Error(
          `Keine Testdatenbank aktiv (Zugriff auf prisma.${String(property)}).`
        );
      const value = state.current[property];
      return typeof value === "function" ? value.bind(state.current) : value;
    },
  }
);

/** Entfernt Vorlagen und Arbeitsverzeichnis dieses Jest-Prozesses. */
function removeTestDatabases() {
  if (!state.root) return;
  fs.rmSync(state.root, { recursive: true, force: true });
  state.root = null;
  state.templates.clear();
}

// ---------------------------------------------------------------------------
// Bestand anlegen
// ---------------------------------------------------------------------------

let slugCounter = 0;

async function createWorkspace(client, data = {}) {
  const n = ++slugCounter;
  return await client.workspaces.create({
    data: { name: `Workspace ${n}`, slug: `workspace-${n}`, ...data },
  });
}

async function createEmbed(client, workspace, data = {}) {
  return await client.embed_configs.create({
    data: {
      uuid: `embed-${++slugCounter}`,
      enabled: true,
      workspace_id: workspace.id,
      ...data,
    },
  });
}

/**
 * Bestandszeilen in workspace_chats, wie sie vor KIE-532 entstanden sind:
 * ohne Zählerbuch, mit vorgegebenem createdAt.
 * @param {import("@prisma/client").PrismaClient} client
 * @param {Array<{workspaceId: number, createdAt: Date, include?: boolean, thread_id?: number|null, user_id?: number|null}>} rows
 */
async function seedWorkspaceChats(client, rows) {
  for (let i = 0; i < rows.length; i += 200)
    await client.$transaction(
      rows.slice(i, i + 200).map((row) =>
        client.workspace_chats.create({
          data: { prompt: "Frage", response: "{}", ...row },
        })
      )
    );
}

/**
 * Bestandszeilen in embed_chats, wie sie vor KIE-532 entstanden sind.
 * @param {import("@prisma/client").PrismaClient} client
 * @param {Array<{embed_id: number, createdAt: Date, session_id?: string, conversation_id?: string|null, feedbackScore?: boolean|null}>} rows
 */
async function seedEmbedChats(client, rows) {
  for (let i = 0; i < rows.length; i += 200)
    await client.$transaction(
      rows.slice(i, i + 200).map((row) =>
        client.embed_chats.create({
          data: {
            prompt: "Frage",
            response: "{}",
            session_id: "sitzung",
            ...row,
          },
        })
      )
    );
}

/**
 * Inhalt des Zählerbuchs, sortiert, ohne den technischen Schlüssel.
 * @param {import("@prisma/client").PrismaClient} client
 * @param {Object} [where]
 */
async function ledgerRows(client, where = {}) {
  const rows = await client.message_ledger.findMany({
    where,
    orderBy: [
      { workspace_id: "asc" },
      { embed_id: "asc" },
      { day: "asc" },
      { hour: "asc" },
    ],
  });
  return rows.map(({ id: _id, ...row }) => row);
}

/** Berliner Tag und Stunde, unabhängig vom geprüften Code bestimmt. */
function berlinCell(instant) {
  const text = new Date(instant).toLocaleString("sv-SE", {
    timeZone: "Europe/Berlin",
    hourCycle: "h23",
  });
  return { day: text.slice(0, 10), hour: Number(text.slice(11, 13)) };
}

/**
 * Zeitpunkt zu einer Berliner Wanduhrzeit. Gibt es die Uhrzeit zweimal
 * (Rückstellung auf Winterzeit), gilt der erste Durchlauf.
 * @param {string} day - "YYYY-MM-DD"
 * @param {number} hour
 * @param {number} [minute]
 * @returns {Date}
 */
function berlinInstant(day, hour, minute = 0) {
  const wallClock =
    Date.parse(`${day}T00:00:00Z`) + (hour * 60 + minute) * 60000;
  // Berlin liegt 1 oder 2 Stunden vor UTC.
  for (const offsetHours of [2, 1]) {
    const candidate = new Date(wallClock - offsetHours * 3600000);
    const cell = berlinCell(candidate);
    if (cell.day === day && cell.hour === hour) return candidate;
  }
  throw new Error(
    `Diese Uhrzeit gibt es in Berlin nicht: ${day} ${hour}:${minute}`
  );
}

/** Ereignisse eines Typs mit ausgelesenen Metadaten, älteste zuerst. */
async function eventsOf(client, event) {
  const logs = await client.event_logs.findMany({
    where: { event },
    orderBy: { id: "asc" },
  });
  return logs.map((log) => ({
    ...log,
    metadata: log.metadata ? JSON.parse(log.metadata) : null,
  }));
}

/**
 * Zeilenzahl und Prüfsumme über alle Spalten aller Zeilen einer Tabelle.
 * @param {import("@prisma/client").PrismaClient} client
 * @param {string} table - fester Tabellenname, nie Eingabe von außen
 * @returns {Promise<{rows: number, sha256: string}>}
 */
async function tableChecksum(client, table) {
  const rows = await client.$queryRawUnsafe(
    `SELECT * FROM "${table}" ORDER BY id`
  );
  const text = JSON.stringify(rows, (_key, value) =>
    typeof value === "bigint" ? value.toString() : value
  );
  return {
    rows: rows.length,
    sha256: crypto.createHash("sha256").update(text).digest("hex"),
  };
}

/**
 * Registriert Endpunkte an einer Fake-App und liefert je Route den letzten
 * Handler (ohne Middleware), wie in llmRequestOptionsEndpoints.test.js.
 */
function collectRoutes(register) {
  const routes = {};
  const app = new Proxy(
    {},
    {
      get:
        (_target, method) =>
        (route, ...handlers) => {
          routes[`${String(method).toUpperCase()} ${route}`] =
            handlers[handlers.length - 1];
        },
    }
  );
  register(app);
  return routes;
}

function mockRequest({ params = {}, body = {}, query = {} } = {}) {
  return { params, body, query, header: () => null };
}

function mockResponse(locals = {}) {
  const res = {
    locals,
    statusCode: 200,
    body: undefined,
    status(code) {
      res.statusCode = code;
      return res;
    },
    sendStatus(code) {
      res.statusCode = code;
      return res;
    },
    json(body) {
      res.body = body;
      return res;
    },
    end() {
      return res;
    },
  };
  return res;
}

module.exports = {
  LEDGER_MIGRATION,
  testPrisma,
  createTestDatabase,
  removeTestDatabases,
  migrateDeploy,
  schemaDrift,
  allMigrations,
  createWorkspace,
  createEmbed,
  seedWorkspaceChats,
  seedEmbedChats,
  ledgerRows,
  berlinCell,
  berlinInstant,
  eventsOf,
  tableChecksum,
  collectRoutes,
  mockRequest,
  mockResponse,
};
