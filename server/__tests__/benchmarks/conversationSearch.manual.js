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
//   --no-visible Nachfilter im sichtbaren Text (Fixliste 7, F13) nicht messen
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
//
// Messwerte - Stand 14.10.2026, Branch feat/konversationen-ansicht nach
// Fixliste 7. Intel Xeon Gold 6354 (4 Kerne der VM), Node 18.19, Prisma
// 6.14, SQLite; 100.000 Zeilen (623 MB), --runs 5: je Fall ein Aufwärmlauf
// und 5 Messläufe, Median in ms. Route analytics/conversations (Liste +
// Zähler, limit 20). „vorher": derselbe Bestand, unmittelbar davor mit dem
// Stand vor Fixliste 7 (9d6a1ddda) gemessen - die erste Seite ist dieselbe
// Abfrage, die Abweichungen (±4 %) sind Rauschen der VM.
//
//   Fall                                Treffer  Median  vorher  Läufe
//   ohne Suche, Gesamt                    42858     366     366  366 366 369 369 357
//   q="kurs", Gesamt                      42858    1198    1237  1212 1244 1171 1198 1197
//   q="spanisch", Gesamt                    796     892     890  894 892 867 898 878
//   q="für", Gesamt                       28723    1025    1060  1020 1119 1075 1025 1004
//   q="üb", Gesamt                        24283    1343    1387  1331 1334 1343 1345 1364
//   q="äa", Gesamt                            0    1238    1256  1289 1240 1215 1220 1238
//   q="Übung", Gesamt                     24283    1021    1012  1007 997 1022 1028 1021
//   q="курс", Gesamt                       1025    1155    1156  1154 1155 1143 1157 1161
//   q="äöü", Gesamt                           0    1240    1219  1242 1240 1233 1234 1241
//   q="\"", Gesamt                        16211     921     895  907 937 929 921 918
//   q="\\", Gesamt                         2697     808     791  799 813 824 807 808
//   q="xyzkeintreffer", Gesamt                0     755     741  753 755 737 787 823
//   q="zehntausend", Gesamt               10000     851     830  868 876 851 842 823
//   q="spanisch" + negativ, Gesamt          512     396     393  401 396 392 398 395
//   Säule (Woche), ohne Suche              3334     356     335  332 356 363 366 347
//   q="kurs" + Säule (Woche)               3334     385     390  386 385 385 385 396
//   q="für" + Säule (Woche)                2231     399     398  399 393 394 399 400
//   q="Übung" + Säule (Woche)              1906     394     406  394 394 399 392 396
//   q="xyzkeintreffer" + Säule (Woche)        0     384     386  384 382 382 390 389
//
//   Langsamster Fall 1343 ms - Grenze NAK-7 (1500 ms) eingehalten.
//
//   Export CSV (ein Lauf, Fixliste 7 F01): ohne Suche 814.586 Zeilen
//   5,1 s (vorher 34,4 s: je Seite zu 500 Konversationen die ganze
//   Gruppierung neu); q=kurs 814.586 Zeilen 6,2 s (vorher 5,5 s);
//   q=zehntausend 212.463 Zeilen 2,3 s (vorher 2,1 s).
//
//   Blättern (Fixliste 7, F14), Seite 21 (Zeilen 401-420): über den
//   Schlüssel der Zeile 400 ohne Suche 423 ms (offset 400: 395 ms), mit
//   q=kurs 1325 ms (offset: 1307 ms) - der Schlüssel kostet ein zweites
//   Fenster (rund 2 %), nur auf den Seiten hinter der ersten.
//
//   Nachfilter im sichtbaren Text (Fixliste 7, F13): alle Treffer-Zeilen
//   samt Antworttext lesen und in JS prüfen (die Voraussetzung für eine
//   richtige Zählung ohne Treffer in Link-Zielen, HTML und <think>):
//   q=kurs 3,2 s (42.858 Treffer, sichtbar 42.858), q=vhs.example 3,1 s
//   (42.858 SQL-Treffer, sichtbar 0), q=spanisch 0,8 s - mehr als das
//   Doppelte von NAK-7. Deshalb bleibt es beim Hinweis im Panel.
//
//   Verworfene Variante für C9 (Anfang, der auf einen Rückstrich endet, aus
//   dem JSON lesen: substr(answer_head, -1) je Zeile): rund 13 % langsamer
//   (q="üb" 1401 statt 1291 ms, q="kurs" 1358 statt 1193 ms im selben
//   Bestand); der Anfang bis einschließlich ", kostet nichts messbar.
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
const VISIBLE = !args.includes("--no-visible");
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

  // Fixliste 7, F14: „Weitere laden“ tief in der Liste – Seite 21 (Zeilen
  // 401–420) über offset und über den Schlüssel der Zeile 400.
  const page = async (body) => {
    const result = await invoke(LIST, {
      params: { embedId: "1" },
      body: { feedbackFilter: "all", ...body },
    });
    if (result.statusCode !== 200)
      throw new Error(`Seite: Status ${result.statusCode}`);
    return result.body;
  };
  for (const q of [null, "kurs"]) {
    const search = q ? { q } : {};
    const before = await page({ offset: 380, limit: 20, ...search });
    const last = before.conversations.at(-1);
    const after = {
      lastMessageAt: last.last_message_at,
      firstChatId: last.first_chat_id,
    };
    for (const [label, body] of [
      ["offset 400", { offset: 400, limit: 20, ...search }],
      ["Schlüssel nach Zeile 400", { offset: 0, limit: 20, after, ...search }],
    ]) {
      const runs = [];
      for (let run = 0; run <= RUNS; run++) {
        const started = process.hrtime.bigint();
        await page(body);
        const ms = Number(process.hrtime.bigint() - started) / 1e6;
        if (run > 0) runs.push(ms);
      }
      console.log(
        `Seite 21 ${q ? `q=${q}` : "ohne Suche"}, ${label}`.padEnd(48) +
          `Median ${median(runs).toFixed(0).padStart(5)} ms  (${runs
            .map((r) => r.toFixed(0))
            .join(", ")})`
      );
    }
  }

  // Fixliste 7, F13: Was kostete es, Treffer, die nur in Link-Zielen, HTML
  // oder <think> stehen, nach der SQL-Vorauswahl in JS auszusortieren? Für
  // eine richtige Zählung („N von M einsehbar“) und richtiges Blättern
  // müsste jede Treffer-Zeile des Zeitraums gelesen und ihr sichtbarer Text
  // geprüft werden - gemessen wird genau das: die Treffer-Zeilen samt
  // Antworttext lesen (dieselbe Bedingung wie die Liste) und in JS prüfen
  // (dieselbe Regel wie visibleAnswerText im Frontend).
  if (VISIBLE) {
    const { Prisma } = require(
      path.join(SERVER, "node_modules/@prisma/client")
    );
    const { EmbedChats } = require(path.join(SERVER, "models/embedChats"));
    const AUTOLINK =
      /<((?:[a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s<>]*)|(?:[^\s<>@]+@[^\s<>@]+))>/g;
    const visibleAnswerText = (text) =>
      String(text ?? "")
        .replace(/<think>[^]*?<\/think>/g, " ")
        .replace(/\]\([^)]*\)/g, "]")
        .replace(AUTOLINK, " $1 ")
        .replace(/<\/?[a-zA-Z][^>]*>/g, " ");
    for (const q of ["kurs", "vhs.example", "spanisch"]) {
      const runs = [];
      let visible = 0;
      let sqlHits = 0;
      for (let run = 0; run <= RUNS; run++) {
        const started = process.hrtime.bigint();
        const where = Prisma.sql`WHERE include = 1 AND embed_id = 1`;
        const rows = await client.$queryRaw`
          SELECT session_id, COALESCE(conversation_id, session_id) AS conversation,
            prompt, feedbackReason, feedbackText, feedbackScore,
            (SELECT CASE WHEN json_valid(response) AND json_type(response) = 'object'
               THEN json_extract(response, '$.text') ELSE response END
             FROM embed_chats AS source WHERE source.id = search_rows.id) AS answer
          FROM ${EmbedChats._searchRowsSql(where)}
          WHERE ${EmbedChats._searchMatchSql(q)}`;
        const pattern = new RegExp(
          q.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&"),
          "iu"
        );
        const all = new Set();
        const seen = new Set();
        for (const row of rows) {
          const key = `${row.conversation}\u0000${row.session_id}`;
          all.add(key);
          if (
            pattern.test(row.prompt ?? "") ||
            (Number(row.feedbackScore) === 0 &&
              (pattern.test(row.feedbackReason ?? "") ||
                pattern.test(row.feedbackText ?? ""))) ||
            pattern.test(visibleAnswerText(row.answer))
          )
            seen.add(key);
        }
        visible = seen.size;
        sqlHits = all.size;
        const ms = Number(process.hrtime.bigint() - started) / 1e6;
        if (run > 0) runs.push(ms);
      }
      console.log(
        `F13 Nachfilter q=${q}`.padEnd(30) +
          `SQL-Treffer ${String(sqlHits).padStart(6)}  sichtbar ${String(
            visible
          ).padStart(6)}  Median ${median(runs).toFixed(0).padStart(5)} ms`
      );
    }
  }

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
