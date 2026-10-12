// Brücke zu den Frontend-Tests: Das Frontend ist ein ES-Modul-Paket (Vite),
// Jest läuft im Repo ohne ESM-Transform. Die eigentlichen Tests liegen deshalb
// als *.test.mjs für den Node-Test-Runner daneben; diese Datei startet sie,
// damit `yarn test` / `npx jest` sie mit ausführt. Einzeln:
//   node --test frontend/__tests__/<name>.test.mjs
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const files = fs
  .readdirSync(__dirname)
  .filter((name) => name.endsWith(".test.mjs"))
  .sort();

describe("Frontend (node --test)", () => {
  test.each(files)(
    "%s",
    (file) => {
      const { status, stdout, stderr } = spawnSync(
        process.execPath,
        ["--test", path.join(__dirname, file)],
        { cwd: path.resolve(__dirname, ".."), encoding: "utf8" }
      );
      if (status !== 0) throw new Error(`${stdout}\n${stderr}`);
      // Ein leerer Lauf (kein Test gefunden) gilt nicht als bestanden. Tests,
      // die Frontend-Pakete brauchen, überspringen sich ohne Installation.
      const count = (key) =>
        Number(stdout.match(new RegExp(`^# ${key} (\\d+)$`, "m"))?.[1]);
      expect(count("fail")).toBe(0);
      expect(count("pass") + count("skipped")).toBeGreaterThan(0);
    },
    120_000
  );
});
