// Lässt die Jest-Suite nacheinander in drei Zeitzonen laufen (KIE-531, NAK-3).
//
// Kontingent und Abrechnungsfenster dürfen nicht von der Zeitzone des
// Prozesses abhängen. Die Tests setzen TZ deshalb bewusst nicht selbst, und
// ein Rückfall zeigt sich je nach Fehler nur in einer der drei Zonen: Ein
// einzelner Lauf reicht nicht.
//
//   yarn test:tz                                 gesamte Suite
//   yarn test:tz server/__tests__/utils/helpers  Argumente gehen an Jest
//
// Alle drei Läufe finden immer statt; Status 1, wenn einer davon fehlschlägt.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const TIME_ZONES = ["UTC", "Europe/Berlin", "America/New_York"];

// Jest und seine Konfiguration liegen im Wurzelverzeichnis des Repos.
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const jestBin = createRequire(import.meta.url).resolve("jest/bin/jest");

const failed = [];
for (const timeZone of TIME_ZONES) {
  console.log(`\n=== Jest mit TZ=${timeZone} ===`);
  const { status } = spawnSync(
    process.execPath,
    [jestBin, ...process.argv.slice(2)],
    { cwd: repoRoot, stdio: "inherit", env: { ...process.env, TZ: timeZone } }
  );
  if (status !== 0) failed.push(timeZone);
}

if (failed.length > 0) {
  console.log(`\nFehlgeschlagen mit TZ=${failed.join(", TZ=")}`);
  process.exit(1);
}
console.log(`\nGrün in allen Zeitzonen: ${TIME_ZONES.join(", ")}`);
