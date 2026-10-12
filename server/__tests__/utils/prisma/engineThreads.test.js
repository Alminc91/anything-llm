/* eslint-env jest, node */
// KIE-532 / AK-20 — Arbeits-Threads der Query-Engine: das berechnete Minimum
// und der Umgang mit einem Wert, den der Betrieb gesetzt hat.
//
// Die Regeln prüft Jest an seiner Kopie von process.env. Dass die Engine
// wirklich mit dem Minimum lädt, zeigt der Startpfad in einem gewöhnlichen
// Node-Prozess (helpers/engineCheckProcess.js): Dort besteht der Selbsttest
// nur, wenn die Engine mehr Arbeits-Threads als Verbindungen hat.
jest.mock(
  "../../../utils/prisma",
  () => require("../../helpers/sqliteTestDatabase").testPrisma
);

const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  createTestDatabase,
  removeTestDatabases,
  eventsOf,
} = require("../../helpers/sqliteTestDatabase");
const { bootInProcess } = require("../../helpers/engineCheckBoot");

const serverRoot = path.resolve(__dirname, "../../..");
const ENV_KEY = "TOKIO_WORKER_THREADS";

// Der erste Test jeder Datei erzeugt die Vorlage mit `prisma migrate deploy`.
jest.setTimeout(120000);

const saved = process.env[ENV_KEY];
let engineThreads;
let warnSpy;
beforeEach(() => {
  // Das Modul merkt sich, was es gesetzt hat: je Test ein frisches.
  jest.resetModules();
  engineThreads = require("../../../utils/prisma/engineThreads");
  warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
  delete process.env[ENV_KEY];
});
afterEach(() => {
  jest.restoreAllMocks();
  if (saved === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = saved;
});
afterAll(() => removeTestDatabases());

/** /proc/cpuinfo mit einem Eintrag je Prozessor. */
function cpuinfo(processors) {
  return processors
    .map(
      ({ socket, cores }, index) =>
        `processor\t: ${index}\nmodel name\t: Test\nphysical id\t: ${socket}\nsiblings\t: ${cores * 2}\ncore id\t\t: ${index}\ncpu cores\t: ${cores}\n`
    )
    .join("\n");
}

function mockCpus({ visible, usable = visible, procCpuinfo = null }) {
  jest.spyOn(os, "cpus").mockReturnValue(Array(visible).fill({}));
  jest.spyOn(os, "availableParallelism").mockReturnValue(usable);
  const readFileSync = fs.readFileSync;
  jest.spyOn(fs, "readFileSync").mockImplementation((file, ...rest) => {
    if (file !== "/proc/cpuinfo") return readFileSync(file, ...rest);
    if (procCpuinfo === null) throw new Error("ENOENT");
    return procCpuinfo;
  });
}

describe("minimumEngineThreads", () => {
  test("liegt auf dieser Maschine über dem Pool der Engine (höchstens 2 × Kerne + 1), mindestens bei 8", () => {
    const minimum = engineThreads.minimumEngineThreads();
    expect(minimum).toBeGreaterThan(2 * os.cpus().length + 1);
    expect(minimum).toBeGreaterThanOrEqual(8);
  });

  test.each([
    // [Fall, sichtbare Prozessoren, nutzbare, /proc/cpuinfo, Pool der Engine, erwartetes Minimum]
    [
      "4 logische auf 2 physischen Kernen",
      {
        visible: 4,
        procCpuinfo: cpuinfo(Array(4).fill({ socket: 0, cores: 2 })),
      },
      5,
      10,
    ],
    [
      "8 Kerne ohne Hyper-Threading",
      {
        visible: 8,
        procCpuinfo: cpuinfo(Array(8).fill({ socket: 0, cores: 8 })),
      },
      17,
      18,
    ],
    [
      "zwei Sockel mit je 8 Kernen",
      {
        visible: 32,
        procCpuinfo: cpuinfo([
          ...Array(16).fill({ socket: 0, cores: 8 }),
          ...Array(16).fill({ socket: 1, cores: 8 }),
        ]),
      },
      33,
      66,
    ],
    [
      "Container mit CPU-Begrenzung (Docker --cpus=1): alle Prozessoren des Hosts sichtbar, einer nutzbar",
      {
        visible: 16,
        usable: 1,
        procCpuinfo: cpuinfo(Array(16).fill({ socket: 0, cores: 8 })),
      },
      17,
      34,
    ],
    [
      "Container hinter lxcfs: 2 Prozessoren sichtbar, cpu cores nennt die 16 Kerne des Hosts",
      {
        visible: 2,
        procCpuinfo: cpuinfo(Array(2).fill({ socket: 0, cores: 16 })),
      },
      33,
      34,
    ],
    [
      "/proc/cpuinfo ohne Kernangaben: Die Engine zählt die nutzbaren Prozessoren",
      {
        visible: 0,
        usable: 6,
        procCpuinfo: "processor\t: 0\nBogoMIPS\t: 50\n",
      },
      13,
      14,
    ],
    [
      "/proc/cpuinfo nicht lesbar",
      { visible: 2, usable: 2, procCpuinfo: null },
      5,
      8,
    ],
  ])("%s", (_name, cpus, enginePool, expected) => {
    mockCpus(cpus);
    expect(engineThreads.minimumEngineThreads()).toBe(expected);
    expect(expected).toBeGreaterThan(enginePool);
  });
});

describe("betriebswert_unter_minimum (AK-20)", () => {
  test("betriebswert_unter_minimum: ohne Wert des Betriebs setzt der Server das Minimum und nimmt es nach dem Laden der Engine zurück", () => {
    const minimum = engineThreads.minimumEngineThreads();
    engineThreads.ensureEngineThreads();
    expect(process.env[ENV_KEY]).toBe(String(minimum));
    expect(engineThreads.engineThreadsInEffect()).toBe(minimum);

    engineThreads.releaseEngineThreads();
    expect(process.env[ENV_KEY]).toBeUndefined();
    // Die Engine behält, womit sie geladen hat.
    expect(engineThreads.engineThreadsInEffect()).toBe(minimum);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test.each(["2", "1", String(8 - 1)])(
    "betriebswert_unter_minimum: der Betriebswert %s wird für die Engine durch das Minimum ersetzt, eine Konsolenwarnung nennt beide Werte",
    (operatorValue) => {
      const minimum = engineThreads.minimumEngineThreads();
      process.env[ENV_KEY] = operatorValue;

      engineThreads.ensureEngineThreads();

      expect(process.env[ENV_KEY]).toBe(String(minimum));
      expect(engineThreads.engineThreadsInEffect()).toBe(minimum);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const [warning] = warnSpy.mock.calls[0];
      expect(warning).toContain(`${ENV_KEY}=${operatorValue} `);
      expect(warning).toContain(`Minimum von ${minimum} `);

      // Ein zweiter Aufruf (weiterer Client) meldet und ändert nichts mehr.
      engineThreads.ensureEngineThreads();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(process.env[ENV_KEY]).toBe(String(minimum));

      // Nach dem Laden der Engine gilt für alles Weitere wieder der Wert des
      // Betriebs (LanceDB liest die Variable beim Laden).
      engineThreads.releaseEngineThreads();
      expect(process.env[ENV_KEY]).toBe(operatorValue);
      expect(engineThreads.engineThreadsInEffect()).toBe(minimum);
    }
  );

  test("betriebswert_unter_minimum: genau ein Thread unter dem Minimum wird ersetzt, das Minimum selbst und jeder Wert darüber bleiben unverändert", () => {
    const minimum = engineThreads.minimumEngineThreads();

    process.env[ENV_KEY] = String(minimum - 1);
    engineThreads.ensureEngineThreads();
    expect(process.env[ENV_KEY]).toBe(String(minimum));
    expect(warnSpy).toHaveBeenCalledTimes(1);
    engineThreads.releaseEngineThreads();

    for (const operatorValue of [String(minimum), String(minimum + 1), "512"]) {
      process.env[ENV_KEY] = operatorValue;
      engineThreads.ensureEngineThreads();
      expect(process.env[ENV_KEY]).toBe(operatorValue);
      expect(engineThreads.engineThreadsInEffect()).toBe(Number(operatorValue));
      engineThreads.releaseEngineThreads();
      expect(process.env[ENV_KEY]).toBe(operatorValue);
      expect(engineThreads.engineThreadsInEffect()).toBe(Number(operatorValue));
    }
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  test.each(["0", "-4", "3.5", "viele", " 64", "64 "])(
    "betriebswert_unter_minimum: der ungültige Betriebswert %j wird für die Engine ersetzt",
    (operatorValue) => {
      const minimum = engineThreads.minimumEngineThreads();
      process.env[ENV_KEY] = operatorValue;
      engineThreads.ensureEngineThreads();
      expect(process.env[ENV_KEY]).toBe(String(minimum));
      expect(warnSpy).toHaveBeenCalledTimes(1);
      engineThreads.releaseEngineThreads();
      expect(process.env[ENV_KEY]).toBe(operatorValue);
    }
  );

  test("betriebswert_unter_minimum: ein leerer Wert gilt als nicht gesetzt", () => {
    process.env[ENV_KEY] = "";
    engineThreads.ensureEngineThreads();
    expect(process.env[ENV_KEY]).toBe(
      String(engineThreads.minimumEngineThreads())
    );
    expect(warnSpy).not.toHaveBeenCalled();
    engineThreads.releaseEngineThreads();
    expect(process.env[ENV_KEY]).toBeUndefined();
  });

  test("betriebswert_unter_minimum: ändert jemand den Wert nach dem Setzen, nimmt die Freigabe ihn nicht zurück", () => {
    engineThreads.ensureEngineThreads();
    process.env[ENV_KEY] = "77";
    engineThreads.releaseEngineThreads();
    expect(process.env[ENV_KEY]).toBe("77");
    expect(engineThreads.engineThreadsInEffect()).toBe(77);
  });

  describe("im Serverprozess", () => {
    let db;
    beforeEach(async () => {
      db = await createTestDatabase();
    });
    afterEach(async () => db.close());

    test("betriebswert_unter_minimum: mit TOKIO_WORKER_THREADS=2 lädt die Query-Engine mit dem Minimum - der Selbsttest besteht, die Warnung nennt beide Werte, danach gilt wieder 2", async () => {
      const boot = bootInProcess(db, { engineThreads: "2" });

      expect(boot.crashed).toBeUndefined();
      // Die Engine lädt mit dem Minimum …
      expect(boot.threadsAtLoad).toBe(String(boot.minimumThreads));
      expect(boot.warnings).toHaveLength(1);
      expect(boot.warnings[0]).toContain(`${ENV_KEY}=2 `);
      expect(boot.warnings[0]).toContain(`Minimum von ${boot.minimumThreads} `);
      // … und hat damit tatsächlich mehr Threads als Verbindungen: Mit 2
      // Threads bleiben die parallelen Transaktionen des Selbsttests stehen
      // (boot/messageLedgerEngineCheck.test.js).
      expect(boot.check).toEqual(
        expect.objectContaining({
          ok: true,
          engineThreads: boot.minimumThreads,
          completed: boot.check.parallel,
        })
      );
      expect(boot.check.engineThreads).toBeGreaterThan(boot.check.poolSize);
      expect(boot.errors).toEqual([]);
      expect(
        await eventsOf(db.client, "message_ledger_engine_check_failed")
      ).toEqual([]);
      // Beim Lauschen steht wieder der Wert des Betriebs.
      expect(boot.listening).toEqual({ port: 3999, threadsAtListen: "2" });
    });

    test("betriebswert_unter_minimum: ein Betriebswert ab dem Minimum bleibt unverändert, für die Engine und danach", async () => {
      const operatorValue = String(engineThreads.minimumEngineThreads() + 5);
      const boot = bootInProcess(db, { engineThreads: operatorValue });

      expect(boot.crashed).toBeUndefined();
      expect(boot.threadsAtLoad).toBe(operatorValue);
      expect(boot.warnings).toEqual([]);
      expect(boot.check).toEqual(
        expect.objectContaining({
          ok: true,
          engineThreads: Number(operatorValue),
        })
      );
      expect(boot.listening).toEqual({
        port: 3999,
        threadsAtListen: operatorValue,
      });
    });
  });
});

describe("Poolgröße der Engine", () => {
  test("wird aus der Info-Zeile der Engine mitgelesen", () => {
    expect(engineThreads.enginePoolSize()).toBeNull();
    expect(engineThreads.notePoolSize("Etwas anderes.")).toBeNull();
    expect(engineThreads.enginePoolSize()).toBeNull();
    expect(
      engineThreads.notePoolSize("Starting a sqlite pool with 5 connections.")
    ).toBe(5);
    expect(engineThreads.enginePoolSize()).toBe(5);
    // Spätere Zeilen ohne Poolgröße ändern nichts.
    engineThreads.notePoolSize("Etwas anderes.");
    expect(engineThreads.enginePoolSize()).toBe(5);
  });

  test("utils/prisma setzt die Thread-Zahl vor dem Laden der Engine und liest die Poolgröße mit, ohne die Ausgabe der Engine zu ändern", () => {
    const source = fs.readFileSync(
      path.join(serverRoot, "utils/prisma/index.js"),
      "utf8"
    );
    expect(source.indexOf("ensureEngineThreads();")).toBeGreaterThan(-1);
    expect(source.indexOf("ensureEngineThreads();")).toBeLessThan(
      source.indexOf('require("@prisma/client")')
    );
    expect(source).toContain(
      'prisma.$on("info", (event) => notePoolSize(event.message));'
    );
    // Der Zuhörer ist eine Zugabe: Scheitert er, lädt der Client trotzdem.
    expect(source).toMatch(/try \{\s*prisma\.\$on\("info"/);
    // Die Stufe info geht weiter auf die Konsole (kein emit: "event").
    expect(source).toContain('const logLevels = ["error", "info", "warn"];');
  });

  test("das Schema setzt kein connection_limit: Die Poolgröße bleibt die, mit der das Minimum rechnet", () => {
    const schema = fs.readFileSync(
      path.join(serverRoot, "prisma/schema.prisma"),
      "utf8"
    );
    const urls = [...schema.matchAll(/^\s*url\s*=\s*(.+)$/gm)].map((match) =>
      match[1].trim()
    );
    // Ein größerer Pool bräuchte mehr Arbeits-Threads, als engineThreads.js
    // vor dem Laden der Engine wissen kann. Wer hier ein connection_limit
    // setzt, muss minimumEngineThreads() mitziehen; der Selbsttest beim Start
    // meldet es sonst als message_ledger_engine_check_failed.
    expect(urls).toEqual(['"file:../storage/anythingllm.db"']);
  });
});
