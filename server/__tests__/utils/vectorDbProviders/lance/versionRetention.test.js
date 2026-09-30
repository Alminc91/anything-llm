/* eslint-env jest, node */
const {
  retentionCutoff,
  optimizeWithRetention,
  LANCE_VERSION_RETENTION_MS,
  READER_GRACE_MS,
} = require("../../../../utils/vectorDbProviders/lance/versionRetention");

const NOW = Date.parse("2026-09-30T12:00:00Z");
const H = 60 * 60 * 1000;
const table = (tsList) => ({
  listVersions: async () => tsList.map((t, i) => ({ version: i + 1, timestamp: new Date(t) })),
});

describe("versionRetention", () => {
  test("Aufbewahrung ist 1 Tag", () => {
    expect(LANCE_VERSION_RETENTION_MS).toBe(24 * H);
  });

  test("aktive Tabelle: Stichtag = jetzt − 1 Tag", async () => {
    const t = table([NOW - 3 * 24 * H, NOW - 2 * H, NOW - 1 * H, NOW - 60 * 1000]);
    expect((await retentionCutoff(t, NOW)).getTime()).toBe(NOW - 24 * H);
  });

  test("Tabelle >1 Tag unverändert: die zuletzt vor 10 min aktuelle Version bleibt (Leser-Schutz)", async () => {
    const old = NOW - 5 * 24 * H; // aktuelle Version seit 5 Tagen
    const t = table([NOW - 9 * 24 * H, old, NOW - 30 * 1000]); // gerade delete/add
    expect((await retentionCutoff(t, NOW)).getTime()).toBe(old); // strikt älter → old bleibt
  });

  test("nur ganz junge Versionen → Stichtag nach Alter", async () => {
    const t = table([NOW - READER_GRACE_MS / 2]);
    expect((await retentionCutoff(t, NOW)).getTime()).toBe(NOW - 24 * H);
  });

  test("listVersions wirft → Stichtag nach Alter, kein Fehler", async () => {
    const t = { listVersions: async () => { throw new Error("io"); } };
    expect((await retentionCutoff(t, NOW)).getTime()).toBe(NOW - 24 * H);
  });

  test("optimizeWithRetention übergibt cleanupOlderThan, deleteUnverified bleibt unberührt", async () => {
    const calls = [];
    const t = { ...table([Date.now() - 2 * H]), optimize: async (o) => calls.push(o) };
    await optimizeWithRetention(t);
    expect(Object.keys(calls[0])).toEqual(["cleanupOlderThan"]);
    const age = Date.now() - calls[0].cleanupOlderThan.getTime();
    expect(Math.abs(age - 24 * H)).toBeLessThan(5000);
  });
});
