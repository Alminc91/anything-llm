/**
 * Self-test gegen eine ECHTE temporäre LanceDB (installiertes @lancedb/lancedb):
 *  1. optimizeFtsIfStale läuft wirklich (ungeindexte Zeilen = 0) und löscht junge Versionen nicht.
 *  2. Aufräumen mit Stichtag in der Zukunft (= „alles Alte") behält die aktuelle Version:
 *     Zeilen, Volltext- und Vektorsuche nach Neuöffnen intakt. (Die 1-Tag-Grenze selbst prüft
 *     versionRetention.test.js — LanceDB rechnet intern mit new Date(), nicht mit Date.now.)
 *  3. hasCourseMetadata erkennt Tabellen ohne / mit Kursspalten.
 *
 *   node server/__tests__/utils/vectorDbProviders/lanceVersionCleanup.manual.js
 */

const assert = require("assert");
const os = require("os");
const path = require("path");
const fs = require("fs");

const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "lance-cleanup-"));
process.env.STORAGE_DIR = storageDir;

const { LanceDb } = require("../../../utils/vectorDbProviders/lance");

let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`\x1b[32m  ✓\x1b[0m ${name}`);
}

const DIM = 8;
const row = (i) => ({
  id: `row-${i}`,
  vector: Array.from({ length: DIM }, (_, k) => Math.sin(i + k)),
  text: i === 7 ? "Yoga am Vormittag in Kreuzau" : `Kurs Nummer ${i} Allgemein`,
});

(async () => {
  const lance = new LanceDb();
  const { client } = await lance.connect();
  const tbl = await client.createTable("chatbot", [row(0)]);
  for (let i = 1; i < 40; i++) await tbl.add([row(i)]);
  await lance.ensureFullTextIndex(tbl);
  for (let i = 40; i < 160; i++) await tbl.add([row(i)]); // >100 ungeindexte Zeilen
  const versionsBefore = (await tbl.listVersions()).length;
  ok(`Ausgangslage: ${versionsBefore} Versionen, 160 Zeilen`);

  // 1) optimize läuft wirklich; junge Versionen bleiben
  await lance.optimizeFtsIfStale(tbl);
  const stats = await tbl.indexStats("text_idx");
  assert.strictEqual(stats.numUnindexedRows, 0, "optimize lief nicht (ungeindexte Zeilen)");
  const versionsToday = (await tbl.listVersions()).length;
  assert(versionsToday > versionsBefore, `junge Versionen gelöscht (${versionsToday})`);
  ok(`optimize lief, junge Versionen erhalten (${versionsBefore} → ${versionsToday})`);

  // 2) alles Alte aufräumen → aktuelle Version bleibt, Daten intakt
  for (let i = 160; i < 270; i++) await tbl.add([row(i)]);
  await tbl.optimize({ cleanupOlderThan: new Date(Date.now() + 60 * 1000) });
  const versionsAfter = (await tbl.listVersions()).length;
  assert(versionsAfter <= 2, `alte Versionen nicht aufgeräumt (${versionsAfter})`);
  const manifests = fs
    .readdirSync(path.join(storageDir, "lancedb", "chatbot.lance", "_versions"))
    .filter((f) => f.endsWith(".manifest"));
  assert(manifests.length >= 1, "kein Manifest mehr übrig");
  ok(`aufgeräumt: ${versionsAfter} Version(en), ${manifests.length} Manifest(e) übrig`);

  const { client: c2 } = await lance.connect(); // wie nach Container-Neustart
  const t2 = await c2.openTable("chatbot");
  assert.strictEqual(await t2.countRows(), 270);
  const fts = await t2.search("Kreuzau", "fts").limit(3).toArray();
  assert(fts.some((r) => r.id === "row-7"), "FTS findet row-7 nicht");
  const vec = await t2.vectorSearch(row(123).vector).limit(1).toArray();
  assert.strictEqual(vec[0].id, "row-123");
  ok("nach Neuöffnen: 270 Zeilen, Volltext- und Vektorsuche treffen");

  // 3) Kursspalten-Erkennung
  assert.strictEqual(await lance.hasCourseMetadata("chatbot"), false);
  await c2.createTable("kurse", [{ ...row(1), start_date: "2026-10-01" }]);
  assert.strictEqual(await lance.hasCourseMetadata("kurse"), true);
  assert.strictEqual(await lance.hasCourseMetadata("gibtsnicht"), false);
  ok("hasCourseMetadata: ohne Spalten false, mit start_date true, fehlende Tabelle false");

  console.log(`\n${passed} Prüfungen bestanden.`);
})()
  .catch((e) => {
    console.error("\x1b[31mFEHLER:\x1b[0m", e);
    process.exitCode = 1;
  })
  .finally(() => fs.rmSync(storageDir, { recursive: true, force: true }));
