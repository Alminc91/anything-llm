/* eslint-env node */
// NAK-7 (Konversationen-Ansicht): Dauer der Suche in einem Widget mit
// 100.000 Chat-Zeilen – und des Exports mit Suche (Fixliste Punkt 6 und 8).
//
// Kein Jest-Test (Endung .manual.js, siehe testPathIgnorePatterns): Der
// Aufbau der Datei dauert rund eine Minute und braucht ~0,6 GB Platz.
//
// Aufruf aus dem Repo-Wurzelverzeichnis:
//   TMPDIR=/pfad/mit/platz node server/__tests__/benchmarks/conversationSearch.manual.js \
//     [--rows 100000] [--db /pfad/datei.db] [--keep] [--runs 5] [--no-export]
//
//   --rows   Zahl der Chat-Zeilen (ein Widget)            Vorgabe 100000
//   --db     Datei der Messdatenbank                        Vorgabe $TMPDIR/conversation-search-<rows>.db
//   --keep   Datei behalten und beim nächsten Lauf wiederverwenden
//   --runs   Messläufe je Fall (nach einem Aufwärmlauf)     Vorgabe 5
//   --no-export  Export nicht messen
//
// Gemessen wird die echte Route POST /embed/:embedId/analytics/conversations
// (Liste + Zähler in einer Antwort, wie der Server sie beantwortet) über die
// Route-Kette aus support/routeHarness.invoke, je Fall der Median. Grenze
// NAK-7: 1,5 s je Begriff über den ganzen Bestand. Die Zeilen sind
// realistisch groß (Antwort-JSON mit Text, drei Quellen und Metadaten,
// ~5 KB), mit Umlauten, etwas Kyrillisch, Anführungszeichen und Rückstrichen.
// Die Antworttexte sind wie im Widget mehrzeiliges Markdown (Absätze, Liste,
// Fettdruck, Kurslinks) - im JSON also mit \n und teils \" (Fixliste 2, R6).
// Gemessen werden auch Säulenklicks (Abschnitt) mit und ohne Suche.
const path = require("path");
const fs = require("fs");
const os = require("os");

const SERVER = path.resolve(__dirname, "../..");
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const ROWS = Number(option("--rows", 100000)) || 100000;
const RUNS = Number(option("--runs", 5)) || 5;
const KEEP = args.includes("--keep");
const EXPORT = !args.includes("--no-export");
const DB_FILE = path.resolve(
  option("--db", path.join(os.tmpdir(), `conversation-search-${ROWS}.db`))
);

process.env.NODE_ENV = "test";
// Einige Module lesen STORAGE_DIR beim Laden; die Messung schreibt dort nichts.
process.env.STORAGE_DIR ??= path.join(
  os.tmpdir(),
  "conversation-search-storage"
);
process.chdir(SERVER);

const { migrateDeploy, allMigrations } = require(
  path.join(SERVER, "__tests__/helpers/sqliteTestDatabase.js")
);

// Fälle der Fixliste (Punkt 6) – jeweils über den ganzen Bestand.
const TERMS = [
  "kurs",
  "spanisch",
  "für",
  "üb",
  "äa",
  "Übung",
  "курс",
  "äöü",
  '"',
  "\\",
  "xyzkeintreffer",
  "zehntausend",
];

function removeDatabase() {
  for (const suffix of ["", "-journal", "-wal", "-shm"])
    fs.rmSync(`${DB_FILE}${suffix}`, { force: true });
}

async function fill(client) {
  const now = Date.parse("2026-10-13T10:00:00Z");
  const step = Math.floor((90 * 86400000) / ROWS);
  // Wörter für Fragen und Antworten; Umlaute sind häufig, wie im Bestand.
  const words = [
    "Kurs",
    "Anmeldung",
    "Termin",
    "Gebühr",
    "Ermäßigung",
    "Raum",
    "Dozentin",
    "Englisch",
    "Französisch",
    "Yoga",
    "Pilates",
    "Töpfern",
    "Excel",
    "Word",
    "Malen",
    "Fotografie",
    "Kochen",
    "Rücken",
    "Übung",
    "Größe",
    "Abend",
    "Wochenende",
    "Volkshochschule",
    "beginnt",
    "kostet",
    "für",
    "statt",
    "online",
    "Präsenz",
    "Anfänger",
    "Fortgeschrittene",
    "Zertifikat",
  ];
  const quoted = (text) => `'${text.replace(/'/g, "''")}'`;
  const source =
    "Lorem ipsum Kursprogramm Herbstsemester Volkshochschule ".repeat(28);
  await client.$queryRawUnsafe("PRAGMA journal_mode = OFF");
  await client.$executeRawUnsafe("PRAGMA synchronous = OFF");
  await client.$executeRawUnsafe(
    "INSERT INTO workspaces (id, name, slug) VALUES (1, 'VHS Messstadt', 'vhs-messstadt')"
  );
  await client.$executeRawUnsafe(
    "INSERT INTO embed_configs (id, uuid, enabled, workspace_id) VALUES (1, 'messung', 1, 1)"
  );
  await client.$executeRawUnsafe(
    "CREATE TEMP TABLE w(i INTEGER PRIMARY KEY, word TEXT)"
  );
  await client.$executeRawUnsafe(
    `INSERT INTO w VALUES ${words.map((w, i) => `(${i}, ${quoted(w)})`).join(",")}`
  );
  // Antwort wie das Widget sie speichert: {"text": …, "type", "sources", "metrics"}.
  await client.$executeRawUnsafe(`
    WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${ROWS})
    INSERT INTO embed_chats (prompt, response, session_id, conversation_id, include,
                             embed_id, createdAt, feedbackScore, feedbackReason, feedbackText)
    SELECT
      (SELECT group_concat(word, ' ') FROM w WHERE i IN (n.i % 32, (n.i * 7) % 32, (n.i * 13) % 32, (n.i * 17) % 32, (n.i * 19) % 32, (n.i * 23) % 32))
        || CASE WHEN n.i % 200 = 0 THEN ' Spanischkurs am Abend?'
                WHEN n.i % 97 = 0 THEN ' Есть ли курс английского?'
                WHEN n.i % 89 = 0 THEN ' Kurs "Yoga" im Raum C:\\Kurse?'
                ELSE ' – geht das?' END,
      json_object(
        'text', 'Gern helfe ich Ihnen weiter.' || char(10) || char(10) ||
          '**' || (SELECT group_concat(word, ' ') FROM w WHERE i IN (n.i % 31, (n.i * 3) % 31, (n.i * 5) % 31, (n.i * 11) % 31)) || '**' ||
          char(10) || char(10) ||
          '- [' || (SELECT word FROM w WHERE i = (n.i * 29) % 32) || ' ' || (n.i % 90) || '](https://vhs.example/kurse/' || (n.i % 5000) || '-' || lower((SELECT word FROM w WHERE i = (n.i * 29) % 32)) || ')' || char(10) ||
          '- ' || (SELECT group_concat(word, ' ') FROM w WHERE i IN ((n.i * 7) % 31, (n.i * 13) % 31)) || ' am Abend' || char(10) || char(10) ||
          substr(${quoted(source)}, 1 + (n.i % 400), 700) ||
          CASE WHEN n.i % 7 = 0 THEN char(10) || 'Der Kurs "' || (SELECT word FROM w WHERE i = n.i % 32) || '" ist beliebt.' ELSE '' END ||
          CASE WHEN n.i % 333 = 0 THEN char(10) || 'Wir bieten auch SPANISCH an.' ELSE '' END ||
          CASE WHEN n.i % 10 = 0 THEN ' Zehntausend Plätze.' ELSE '' END ||
          CASE WHEN n.i % 61 = 0 THEN ' Siehe [Programm](https://vhs.example/kurs?a="b") und \\ Pfad.' ELSE '' END,
        'type', 'chat',
        'sources', json_array(
          json_object('title', 'kursprogramm.pdf', 'text', ${quoted(source)} || ' spanisch-in-quelle курс äöü'),
          json_object('title', 'agb.pdf', 'text', ${quoted(source)}),
          json_object('title', 'anmeldung.html', 'text', ${quoted(source)})
        ),
        'metrics', json_object('model', 'gemma', 'tokens', n.i % 900)
      ),
      'sitzung-' || (n.i / 7),
      'konv-' || (n.i / 3),
      1,
      1,
      ${now} - (n.i * ${step}),
      CASE WHEN n.i % 50 = 0 THEN 0 WHEN n.i % 30 = 0 THEN 1 ELSE NULL END,
      CASE WHEN n.i % 50 = 0 THEN 'Unvollständig' ELSE NULL END,
      CASE WHEN n.i % 100 = 0 THEN 'Das war nicht hilfreich, Übung fehlt' ELSE NULL END
    FROM n
  `);
  await client.$executeRawUnsafe("ANALYZE");
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

async function main() {
  require(
    path.join(SERVER, "utils/prisma/engineThreads")
  ).ensureEngineThreads();
  const { PrismaClient } = require(
    path.join(SERVER, "node_modules/@prisma/client")
  );

  const reuse = KEEP && fs.existsSync(DB_FILE);
  const t0 = Date.now();
  if (!reuse) {
    removeDatabase();
    migrateDeploy(DB_FILE, allMigrations());
  }
  const client = new PrismaClient({
    datasources: { db: { url: `file:${DB_FILE}` } },
  });
  if (!reuse) await fill(client);
  const built = Date.now() - t0;

  // utils/prisma auf die Messdatei umlenken (wie testPrisma in den Tests).
  const prismaPath = require.resolve(path.join(SERVER, "utils/prisma"));
  require.cache[prismaPath] = {
    id: prismaPath,
    filename: prismaPath,
    loaded: true,
    exports: client,
  };
  const { collectRoutes, invoke } = require(
    path.join(SERVER, "__tests__/endpoints/support/routeHarness.js")
  );
  const { embedManagementEndpoints } = require(
    path.join(SERVER, "endpoints/embedManagement")
  );
  const routes = collectRoutes(embedManagementEndpoints);
  const LIST = routes["POST /embed/:embedId/analytics/conversations"];
  const EXPORT_ROUTE = routes["POST /embed/:embedId/analytics/export"];

  const [{ count }] = await client.$queryRawUnsafe(
    "SELECT COUNT(*) AS count FROM embed_chats WHERE embed_id = 1"
  );
  console.log(
    `Datei ${DB_FILE}: ${(fs.statSync(DB_FILE).size / 1e6).toFixed(0)} MB, ` +
      `${Number(count)} Zeilen, Aufbau ${(built / 1000).toFixed(1)} s` +
      (reuse ? " (wiederverwendet)" : "")
  );

  const results = [];
  const measure = async (label, body) => {
    const runs = [];
    let total = null;
    for (let run = 0; run <= RUNS; run++) {
      const started = process.hrtime.bigint();
      const result = await invoke(LIST, {
        params: { embedId: "1" },
        body: { offset: 0, limit: 20, feedbackFilter: "all", ...body },
      });
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      if (result.statusCode !== 200)
        throw new Error(`${label}: Status ${result.statusCode}`);
      total = result.body.totalCount;
      if (run > 0) runs.push(ms); // Lauf 0 = Aufwärmen
    }
    const entry = { label, total, median: median(runs), runs };
    results.push(entry);
    console.log(
      `${label.padEnd(36)} Treffer ${String(total).padStart(6)}  Median ${median(
        runs
      )
        .toFixed(0)
        .padStart(5)} ms  (${runs.map((r) => r.toFixed(0)).join(", ")})`
    );
    return entry;
  };

  await measure("ohne Suche, Gesamt", {});
  for (const q of TERMS) await measure(`q=${JSON.stringify(q)}, Gesamt`, { q });
  await measure('q="spanisch" + negativ, Gesamt', {
    q: "spanisch",
    feedbackFilter: "negative",
  });
  // Säulenklick: eine Woche aus der Mitte des Bestands (Fixliste 2, R6)
  const BUCKET = { startedFromDay: "2026-09-01", startedToDay: "2026-09-07" };
  await measure("Säule (Woche), ohne Suche", BUCKET);
  for (const q of ["kurs", "für", "Übung", "xyzkeintreffer"])
    await measure(`q=${JSON.stringify(q)} + Säule (Woche)`, { q, ...BUCKET });

  let exported = null;
  if (EXPORT) {
    for (const q of ["zehntausend", "kurs", null]) {
      const started = process.hrtime.bigint();
      const result = await invoke(EXPORT_ROUTE, {
        params: { embedId: "1" },
        body: { format: "csv", feedbackFilter: "all", ...(q ? { q } : {}) },
      });
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      const lines = String(result.body).split("\n").length - 1;
      exported = { q, status: result.statusCode, lines, ms };
      console.log(
        `Export CSV ${q ? `q=${q}` : "ohne Suche"}, Gesamt: Status ${result.statusCode}, ` +
          `${lines} Zeilen, ${ms.toFixed(0)} ms`
      );
    }
  }

  await client.$disconnect();
  if (!KEEP) removeDatabase();
  const slowest = Math.max(...results.map((r) => r.median));
  console.log(
    `\nLangsamster Fall: ${slowest.toFixed(0)} ms (Grenze NAK-7: 1500 ms) – ${
      slowest <= 1500 ? "eingehalten" : "ÜBERSCHRITTEN"
    }`
  );
  return { results, exported };
}

main().catch((error) => {
  console.error(error);
  if (!KEEP) removeDatabase();
  process.exit(1);
});
