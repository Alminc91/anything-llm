/* eslint-env jest, node */
// KIE-531 — Schnappschuss und Vergleich für den Rollout des Zyklusfensters.
//
// Die Datenbank ist hier eine Zeilenliste im Speicher; buildSnapshot bekommt
// dafür eine Zählfunktion, die das halboffene Fenster wie die Datenbank
// auswertet. Die Zeitzone des bisherigen Serverprozesses wird dem Skript
// ausdrücklich genannt, die Tests hängen nicht an der Zeitzone des Testlaufs.
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  SNAPSHOT_SCHEMA,
  legacyWindow,
  buildSnapshot,
  compareSnapshots,
  formatComparison,
  main,
} = require("../../scripts/quota-snapshot");

const LEGACY_TZ = "Europe/Berlin";

/** Zeilen: { workspaceId, at, kind: "chat" | "embed" | "adjustment", amount? } */
function memoryCounter(rows) {
  return async (workspace, start, endExclusive) => {
    const inWindow = rows.filter(
      (row) =>
        row.workspaceId === workspace.id &&
        row.at >= start &&
        row.at < endExclusive
    );
    return {
      workspaceChatCount: inWindow.filter((row) => row.kind === "chat").length,
      embedChatCount: inWindow.filter((row) => row.kind === "embed").length,
      adjustmentsTotal: inWindow
        .filter((row) => row.kind === "adjustment")
        .reduce((sum, row) => sum + row.amount, 0),
    };
  };
}

function row(workspaceId, iso, kind = "chat", amount = undefined) {
  return { workspaceId, at: new Date(iso), kind, amount };
}

function many(workspaceId, count, iso, kind = "chat") {
  const first = new Date(iso).getTime();
  return Array.from({ length: count }, (_, index) => ({
    workspaceId,
    at: new Date(first + index * 60 * 1000),
    kind,
  }));
}

async function snapshotPair({
  workspaces,
  rows,
  now,
  legacyTimeZone = LEGACY_TZ,
}) {
  const countInWindow = memoryCounter(rows);
  const before = await buildSnapshot({
    workspaces,
    countInWindow,
    now: new Date(now),
    mode: "legacy",
    legacyTimeZone,
  });
  const after = await buildSnapshot({
    workspaces,
    countInWindow,
    now: new Date(now),
    mode: "current",
  });
  return { before, after };
}

// Drei Workspaces wie in AK-10, Stand 20.04.2026 10:00 Uhr Berliner Zeit.
const NOW = "2026-04-20T10:00:00+02:00";
const plain = {
  id: 1,
  slug: "ohne-besonderheit",
  name: "Ohne Besonderheit",
  messagesLimit: 600,
  cycleStartDate: new Date("2026-01-15"),
  cycleDurationMonths: 3,
};
const withGap = {
  id: 2,
  slug: "luecke",
  name: "Lücke",
  messagesLimit: 600,
  cycleStartDate: new Date("2026-01-15"),
  cycleDurationMonths: 3,
};
const endOfMonth = {
  id: 3,
  slug: "monatsende",
  name: "Monatsende",
  messagesLimit: 600,
  cycleStartDate: new Date("2026-01-31"),
  cycleDurationMonths: 1,
};

function ak10Rows() {
  return [
    // 1: alter Zyklus, dann Nachrichten klar im laufenden Zyklus
    ...many(1, 30, "2026-03-10T09:00:00+01:00"),
    ...many(1, 20, "2026-04-16T09:00:00+02:00"),
    ...many(1, 5, "2026-04-17T09:00:00+02:00", "embed"),
    row(1, "2026-04-18T12:00:00+02:00", "adjustment", 10),
    // 2: vier Nachrichten am 15.04. zwischen 00:00 und 01:00 Uhr Berliner Zeit
    row(2, "2026-04-14T23:59:59+02:00"),
    row(2, "2026-04-15T00:00:00+02:00"),
    row(2, "2026-04-15T00:20:00+02:00", "embed"),
    row(2, "2026-04-15T00:40:00+02:00"),
    row(2, "2026-04-15T00:59:59.999+02:00", "embed"),
    ...many(2, 50, "2026-04-15T01:00:00+02:00"),
    // 3: Start 31.01.; bisher begann der Zyklus am 28.03., jetzt am 31.03.
    ...many(3, 12, "2026-03-28T10:00:00+01:00"),
    ...many(3, 8, "2026-03-30T10:00:00+02:00", "embed"),
    ...many(3, 40, "2026-04-02T10:00:00+02:00"),
  ];
}

describe("quota-snapshot: Schnappschuss", () => {
  test("gibt je Workspace Limit, Fenster und Verbrauch aus", async () => {
    const { before, after } = await snapshotPair({
      workspaces: [plain, withGap, endOfMonth],
      rows: ak10Rows(),
      now: NOW,
    });

    expect(after.schema).toBe(SNAPSHOT_SCHEMA);
    expect(after.mode).toBe("current");
    expect(after.now).toBe("2026-04-20T08:00:00.000Z");
    expect(before.mode).toBe("legacy");
    expect(before.legacyTimeZone).toBe(LEGACY_TZ);

    expect(after.workspaces[0]).toMatchObject({
      id: 1,
      slug: "ohne-besonderheit",
      messagesLimit: 600,
      cycleStartDate: "2026-01-15T00:00:00.000Z",
      cycleDurationMonths: 3,
      window: {
        start: "2026-04-14T22:00:00.000Z",
        endExclusive: "2026-07-14T22:00:00.000Z",
        startDay: "2026-04-15",
        endDayExclusive: "2026-07-15",
        cycleNumber: 2,
      },
      messageCount: 35,
      workspaceChatCount: 20,
      embedChatCount: 5,
      adjustmentsTotal: 10,
      limitReached: false,
    });

    // Bisheriges Fenster: Start 01:00 Uhr Berliner Zeit, Ende am Vortag des
    // nächsten Starts um 23:59:59,999 (hier als exklusives Ende).
    expect(before.workspaces[1].window).toEqual({
      start: "2026-04-14T23:00:00.000Z",
      endExclusive: "2026-07-14T22:00:00.000Z",
      startDay: "2026-04-15",
      endDayExclusive: "2026-07-15",
      cycleNumber: 2,
    });
    expect(before.workspaces[1].messageCount).toBe(50);
    expect(after.workspaces[1].messageCount).toBe(54);

    // Start 31.01.: bisher der 28.03., neu der 31.03.
    expect(before.workspaces[2].window.startDay).toBe("2026-03-28");
    expect(after.workspaces[2].window.startDay).toBe("2026-03-31");
    expect(after.workspaces[2].window.endDayExclusive).toBe("2026-04-30");
  });

  test("zählt nur bis zum Bezugszeitpunkt", async () => {
    const rows = [
      row(1, "2026-04-16T09:00:00+02:00"),
      row(1, "2026-04-20T10:00:00+02:00"), // genau der Bezugszeitpunkt
      row(1, "2026-04-20T10:00:00.001+02:00"), // danach eingegangen
    ];
    const { before, after } = await snapshotPair({
      workspaces: [plain],
      rows,
      now: NOW,
    });
    expect(before.workspaces[0].messageCount).toBe(2);
    expect(after.workspaces[0].messageCount).toBe(2);
  });

  test("legacy braucht die Zeitzone des bisherigen Serverprozesses", async () => {
    await expect(
      buildSnapshot({
        workspaces: [plain],
        countInWindow: memoryCounter([]),
        now: new Date(NOW),
        mode: "legacy",
      })
    ).rejects.toThrow(/legacyTimeZone/);
    await expect(
      buildSnapshot({
        workspaces: [plain],
        countInWindow: memoryCounter([]),
        now: new Date(NOW),
        mode: "legacy",
        legacyTimeZone: "Mars/Olympus",
      })
    ).rejects.toThrow();
  });
});

describe("quota-snapshot: Vergleich", () => {
  test("ursachen: identisch, Lücke und verschobener Zyklusstart werden benannt (AK-10)", async () => {
    const { before, after } = await snapshotPair({
      workspaces: [plain, withGap, endOfMonth],
      rows: ak10Rows(),
      now: NOW,
    });
    const comparison = compareSnapshots(before, after);
    const [first, second, third] = comparison.workspaces;

    expect(first.status).toBe("identical");
    expect(first.message).toBe("[1] ohne-besonderheit: identisch (35)");

    expect(second.status).toBe("explained");
    expect(second.delta).toBe(4);
    expect(second.causes).toEqual([
      {
        code: "legacy_gap",
        units: 4,
        text: "Nachrichten in der bisherigen Lücke",
      },
    ]);
    expect(second.message).toBe(
      "[2] luecke: 50 → 54, +4, Ursache: Nachrichten in der bisherigen Lücke"
    );

    expect(third.status).toBe("explained");
    expect(third.delta).toBe(-20);
    expect(third.causes).toEqual([
      {
        code: "cycle_start_shifted",
        units: -20,
        text: "Zyklusstart verschoben vom 28. auf den 31.",
      },
    ]);
    expect(third.message).toBe(
      "[3] monatsende: 60 → 40, -20, Ursache: Zyklusstart verschoben vom 28. auf den 31."
    );

    expect(comparison.ok).toBe(true);
    expect(comparison.unexplained).toEqual([]);
    expect(comparison.limitReached).toEqual([]);
    expect(comparison.resetDayChanged).toEqual([
      { id: 3, slug: "monatsende", name: "Monatsende", fromDay: 28, toDay: 31 },
    ]);

    const text = formatComparison(comparison);
    expect(text).toContain("identisch");
    expect(text).toContain("+4, Ursache: Nachrichten in der bisherigen Lücke");
    expect(text).toContain(
      "Ursache: Zyklusstart verschoben vom 28. auf den 31."
    );
    expect(text).toContain("Ergebnis: 1 identisch, 2 erklärt, 0 unerklärt.");
  });

  test("ursachen: Gutschrift und Abbuchung in der Lücke zählen mit ihrem Betrag", async () => {
    const rows = [
      ...many(2, 50, "2026-04-15T01:00:00+02:00"),
      row(2, "2026-04-15T00:10:00+02:00", "adjustment", 10),
      row(2, "2026-04-15T00:30:00+02:00", "adjustment", -3),
      row(2, "2026-04-15T00:45:00+02:00"),
    ];
    const { before, after } = await snapshotPair({
      workspaces: [withGap],
      rows,
      now: NOW,
    });
    const [result] = compareSnapshots(before, after).workspaces;
    expect(result.status).toBe("explained");
    expect(result.message).toBe(
      "[2] luecke: 50 → 58, +8, Ursache: Nachrichten in der bisherigen Lücke"
    );
  });

  test("ursachen: im Sommer gesetzter Start hat im Winter eine Lücke von 2 Stunden", async () => {
    const workspace = {
      ...withGap,
      cycleStartDate: new Date("2026-07-15"),
      cycleDurationMonths: 6,
    };
    const rows = [
      row(2, "2027-01-14T23:59:59+01:00"), // voriger Zyklus
      row(2, "2027-01-15T00:00:00+01:00"),
      row(2, "2027-01-15T01:59:59+01:00"),
      row(2, "2027-01-15T02:00:00+01:00"), // bisheriger Start
      row(2, "2027-01-16T09:00:00+01:00"),
    ];
    const { before, after } = await snapshotPair({
      workspaces: [workspace],
      rows,
      now: "2027-01-20T10:00:00+01:00",
    });
    expect(before.workspaces[0].window.start).toBe("2027-01-15T01:00:00.000Z");
    const [result] = compareSnapshots(before, after).workspaces;
    expect(result.message).toBe(
      "[2] luecke: 2 → 4, +2, Ursache: Nachrichten in der bisherigen Lücke"
    );
  });

  test("ursachen: neuer Zyklus läuft noch bis zum Originaltag, bisher begann er schon am 28.", async () => {
    // 29.03.: bisher seit dem 28.03. ein neuer Zyklus, neu erst ab dem 31.03.
    const rows = [
      ...many(3, 90, "2026-03-05T10:00:00+01:00"),
      ...many(3, 3, "2026-03-28T12:00:00+01:00"),
    ];
    const { before, after } = await snapshotPair({
      workspaces: [{ ...endOfMonth, messagesLimit: 90 }],
      rows,
      now: "2026-03-29T12:00:00+02:00",
    });
    const comparison = compareSnapshots(before, after);
    const [result] = comparison.workspaces;
    expect(result.status).toBe("explained");
    expect(result.message).toBe(
      "[3] monatsende: 3 → 93, +90, Ursache: Zyklusstart verschoben vom 28. auf den 31."
    );
    // Genau der Fall, der am Rollout-Tag sperren würde.
    expect(comparison.limitReached).toEqual([
      {
        id: 3,
        slug: "monatsende",
        name: "Monatsende",
        messagesLimit: 90,
        before: 3,
        after: 93,
        status: "explained",
      },
    ]);
  });

  test("ursachen: verschobener Zyklusstart ohne Nachrichten dazwischen bleibt identisch, wird aber gelistet", async () => {
    const { before, after } = await snapshotPair({
      workspaces: [endOfMonth],
      rows: many(3, 40, "2026-04-02T10:00:00+02:00"),
      now: NOW,
    });
    const comparison = compareSnapshots(before, after);
    expect(comparison.workspaces[0].status).toBe("identical");
    expect(comparison.workspaces[0].notes).toEqual([
      "Zyklusstart verschoben vom 28. auf den 31. (ohne Auswirkung auf den Stand)",
    ]);
    expect(comparison.resetDayChanged).toHaveLength(1);
    expect(comparison.ok).toBe(true);
  });

  test("unerklaert_bricht_ab: Unterschied ohne benannte Ursache beendet den Vergleich mit Fehlerstatus (NAK-1)", async () => {
    const { before, after } = await snapshotPair({
      workspaces: [plain, withGap],
      rows: ak10Rows(),
      now: NOW,
    });
    // Eine Nachricht mehr, die keine der beiden Ursachen erklärt.
    after.workspaces[0].workspaceChatCount += 1;
    after.workspaces[0].messageCount += 1;

    const comparison = compareSnapshots(before, after);
    expect(comparison.ok).toBe(false);
    expect(comparison.unexplained.map((result) => result.id)).toEqual([1]);
    expect(comparison.workspaces[0].status).toBe("unexplained");
    expect(comparison.workspaces[0].message).toBe(
      "[1] ohne-besonderheit: 35 → 36, +1, unerklärt: keine der benannten Ursachen"
    );
    // Der erklärte Workspace bleibt erklärt.
    expect(comparison.workspaces[1].status).toBe("explained");
    expect(formatComparison(comparison)).toContain(
      "Unerklärter Unterschied: Der Rollout darf nicht fortgesetzt werden."
    );

    // Das Skript selbst endet mit Fehlerstatus, bei erklärten Unterschieden mit 0.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "quota-snapshot-"));
    try {
      const beforeFile = path.join(dir, "vorher.json");
      const afterFile = path.join(dir, "nachher.json");
      fs.writeFileSync(beforeFile, JSON.stringify(before));
      fs.writeFileSync(afterFile, JSON.stringify(after));
      const output = [];
      const stdout = { write: (text) => output.push(text) };
      const stderr = { write: () => {} };

      expect(
        await main(["compare", beforeFile, afterFile], { stdout, stderr })
      ).toBe(1);
      expect(output.join("")).toContain("unerklärt");

      after.workspaces[0].workspaceChatCount -= 1;
      after.workspaces[0].messageCount -= 1;
      fs.writeFileSync(afterFile, JSON.stringify(after));
      expect(
        await main(["compare", beforeFile, afterFile], { stdout, stderr })
      ).toBe(0);

      output.length = 0;
      expect(
        await main(["compare", beforeFile, afterFile, "--json"], {
          stdout,
          stderr,
        })
      ).toBe(0);
      expect(JSON.parse(output.join("")).ok).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("unerklaert_bricht_ab: teilweise erklärter Unterschied bleibt unerklärt", async () => {
    const { before, after } = await snapshotPair({
      workspaces: [withGap],
      rows: ak10Rows(),
      now: NOW,
    });
    after.workspaces[0].embedChatCount += 2;
    after.workspaces[0].messageCount += 2;

    const comparison = compareSnapshots(before, after);
    expect(comparison.ok).toBe(false);
    expect(comparison.workspaces[0].unexplainedUnits).toBe(2);
    expect(comparison.workspaces[0].message).toBe(
      "[2] luecke: 50 → 56, +6, unerklärt: +2 neben Nachrichten in der bisherigen Lücke"
    );
  });

  test("unerklaert_bricht_ab: unterschiedliche Bezugszeitpunkte erklären nichts", async () => {
    const workspaces = [withGap];
    const rows = ak10Rows();
    const before = await buildSnapshot({
      workspaces,
      countInWindow: memoryCounter(rows),
      now: new Date(NOW),
      mode: "legacy",
      legacyTimeZone: LEGACY_TZ,
    });
    const after = await buildSnapshot({
      workspaces,
      countInWindow: memoryCounter(rows),
      now: new Date("2026-04-20T10:05:00+02:00"),
      mode: "current",
    });
    const comparison = compareSnapshots(before, after);
    expect(comparison.ok).toBe(false);
    expect(comparison.warnings[0]).toMatch(/Unterschiedliche Bezugszeitpunkte/);
    expect(comparison.workspaces[0].status).toBe("unexplained");
  });

  test("unerklaert_bricht_ab: Serverprozess lief in UTC – verschobene Grenze ist keine Lücke", async () => {
    // Mit TZ=UTC gab es keine Lücke: Nachrichten zwischen 00:00 Uhr Berliner
    // Zeit und 00:00 UTC zählten im vorigen Zyklus und wandern jetzt in den
    // neuen. Das ist keine der beiden benannten Ursachen.
    const { before, after } = await snapshotPair({
      workspaces: [withGap],
      rows: ak10Rows(),
      now: NOW,
      legacyTimeZone: "UTC",
    });
    expect(before.workspaces[0].window.start).toBe("2026-04-15T00:00:00.000Z");
    const comparison = compareSnapshots(before, after);
    expect(comparison.ok).toBe(false);
    expect(comparison.workspaces[0].causes).toEqual([]);
    expect(comparison.workspaces[0].status).toBe("unexplained");
  });

  test("unerklaert_bricht_ab: Zyklusstart in der Zukunft zählt jetzt den Kalendermonat", async () => {
    const future = {
      ...plain,
      cycleStartDate: new Date("2026-06-01"),
    };
    const { before, after } = await snapshotPair({
      workspaces: [future],
      rows: many(1, 7, "2026-04-10T09:00:00+02:00"),
      now: NOW,
    });
    expect(before.workspaces[0].messageCount).toBe(0);
    expect(after.workspaces[0].messageCount).toBe(7);
    expect(after.workspaces[0].window).toMatchObject({
      startDay: "2026-04-01",
      endDayExclusive: "2026-05-01",
      cycleNumber: 0,
    });

    const comparison = compareSnapshots(before, after);
    expect(comparison.ok).toBe(false);
    expect(comparison.workspaces[0].status).toBe("unexplained");
    expect(comparison.workspaces[0].notes).toEqual([
      "Zyklusstart in der Zukunft: bisher zählte bis dahin nichts, jetzt gilt der Kalendermonat.",
    ]);
  });

  test("unerklaert_bricht_ab: Workspace fehlt in einem der Schnappschüsse", async () => {
    const { before, after } = await snapshotPair({
      workspaces: [plain, withGap],
      rows: [],
      now: NOW,
    });
    after.workspaces.pop();
    const comparison = compareSnapshots(before, after);
    expect(comparison.ok).toBe(false);
    expect(comparison.workspaces[1].message).toBe(
      "[2] luecke: nur im Schnappschuss vorher enthalten, unerklärt"
    );
  });

  test("limit_erreicht_gelistet: Workspaces, die durch die neuen Grenzen ihr Limit erreichen, stehen gesondert (NAK-2)", async () => {
    const nearLimit = { ...withGap, messagesLimit: 54 };
    const stillBelow = {
      ...withGap,
      id: 4,
      slug: "darunter",
      messagesLimit: 55,
    };
    const alreadyLocked = {
      ...withGap,
      id: 5,
      slug: "schon-gesperrt",
      messagesLimit: 50,
    };
    const rows = [
      ...ak10Rows(),
      ...ak10Rows()
        .filter((entry) => entry.workspaceId === 2)
        .flatMap((entry) => [
          { ...entry, workspaceId: 4 },
          { ...entry, workspaceId: 5 },
        ]),
    ];
    const { before, after } = await snapshotPair({
      workspaces: [plain, nearLimit, stillBelow, alreadyLocked],
      rows,
      now: NOW,
    });
    expect(before.workspaces[1].limitReached).toBe(false);
    expect(after.workspaces[1].limitReached).toBe(true);

    const comparison = compareSnapshots(before, after);
    // Erklärt, also kein Abbruch – aber ausdrücklich gelistet.
    expect(comparison.ok).toBe(true);
    expect(comparison.limitReached).toEqual([
      {
        id: 2,
        slug: "luecke",
        name: "Lücke",
        messagesLimit: 54,
        before: 50,
        after: 54,
        status: "explained",
      },
    ]);

    const text = formatComparison(comparison);
    expect(text).toContain(
      "Limit durch die neuen Grenzen erreicht oder überschritten"
    );
    expect(text).toContain("  [2] luecke: 50 → 54 bei Limit 54");
    expect(text).not.toContain("  [4] darunter: 50 → 54 bei Limit");
    expect(text).not.toContain("  [5] schon-gesperrt: 50 → 54 bei Limit");
  });

  test("limit_erreicht_gelistet: ohne Betroffene sagt die Ausgabe das ausdrücklich", async () => {
    const { before, after } = await snapshotPair({
      workspaces: [plain],
      rows: ak10Rows(),
      now: NOW,
    });
    expect(formatComparison(compareSnapshots(before, after))).toContain(
      "Kein Workspace erreicht durch die neuen Grenzen sein Limit."
    );
  });

  test("lehnt Dateien ab, die keine Schnappschüsse sind", () => {
    expect(() => compareSnapshots({}, {})).toThrow(/Format/);
  });
});

describe("quota-snapshot: bisherige Fensterlogik", () => {
  // Wörtlich der Stand vor KIE-531 (cycleHelpers.js und helpers/index.js),
  // der in der Zeitzone des Prozesses rechnet.
  function referenceWindow(workspace, now) {
    function addMonths(date, months) {
      const inputDate = date instanceof Date ? date : new Date(date);
      const originalDay = inputDate.getDate();
      const result = new Date(inputDate);
      result.setMonth(result.getMonth() + months);
      if (result.getDate() !== originalDay) result.setDate(0);
      return result;
    }
    let startDate;
    let endDate;
    let cycleNumber = null;
    if (workspace.cycleStartDate) {
      const durationMonths = workspace.cycleDurationMonths || 1;
      let cycleStart = new Date(workspace.cycleStartDate);
      cycleNumber = 1;
      while (addMonths(cycleStart, durationMonths) <= now) {
        cycleStart = addMonths(cycleStart, durationMonths);
        cycleNumber++;
      }
      const cycleEnd = new Date(addMonths(cycleStart, durationMonths));
      cycleEnd.setDate(cycleEnd.getDate() - 1);
      startDate = cycleStart;
      endDate = cycleEnd;
    } else {
      startDate = new Date(now.getFullYear(), now.getMonth(), 1);
      endDate = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    }
    const adjustedEndDate = new Date(endDate);
    adjustedEndDate.setHours(23, 59, 59, 999);
    return {
      start: startDate,
      endExclusive: new Date(adjustedEndDate.getTime() + 1),
      cycleNumber,
    };
  }

  test("die Nachbildung entspricht dem alten Code in der Zeitzone dieses Testlaufs", () => {
    const processTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    let seed = 531;
    const random = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    const day = 24 * 60 * 60 * 1000;
    const epoch = Date.UTC(2022, 0, 1);

    for (let i = 0; i < 1500; i++) {
      const startMs = epoch + Math.floor(random() * 4 * 365 * day);
      const workspace = {
        cycleStartDate:
          random() < 0.1
            ? null
            : new Date(
                random() < 0.7 ? Math.floor(startMs / day) * day : startMs
              ),
        cycleDurationMonths: [1, 2, 3, 4, 6, 12, null][
          Math.floor(random() * 7)
        ],
      };
      const now = new Date(epoch + Math.floor(random() * 6 * 365 * day));
      const expected = referenceWindow(workspace, now);
      const actual = legacyWindow(workspace, now, processTimeZone);
      expect({
        start: actual.start.toISOString(),
        endExclusive: actual.endExclusive.toISOString(),
        cycleNumber: actual.cycleNumber,
      }).toEqual({
        start: expected.start.toISOString(),
        endExclusive: expected.endExclusive.toISOString(),
        cycleNumber: expected.cycleNumber,
      });
    }
  });

  test("Berlin: Lücke von 1 Stunde am Zykluswechsel, Reset-Tag wandert auf den 28.", () => {
    const quarter = legacyWindow(
      { cycleStartDate: "2026-01-15", cycleDurationMonths: 3 },
      new Date("2026-04-14T12:00:00+02:00"),
      "Europe/Berlin"
    );
    // Ende 14.04. 23:59:59,999 MESZ, der nächste Zyklus beginnt aber erst 01:00.
    expect(quarter.endExclusive.toISOString()).toBe("2026-04-14T22:00:00.000Z");
    const next = legacyWindow(
      { cycleStartDate: "2026-01-15", cycleDurationMonths: 3 },
      new Date("2026-04-15T01:00:00+02:00"),
      "Europe/Berlin"
    );
    expect(next.start.toISOString()).toBe("2026-04-14T23:00:00.000Z");

    const monthly = { cycleStartDate: "2026-01-31", cycleDurationMonths: 1 };
    const starts = ["2026-03-15", "2026-04-15", "2026-05-15"].map((day) =>
      legacyWindow(
        monthly,
        new Date(`${day}T12:00:00Z`),
        "Europe/Berlin"
      ).start.toISOString()
    );
    // Jeweils 01:00 Uhr Berliner Zeit am 28.: Februar, März, April.
    expect(starts).toEqual([
      "2026-02-28T00:00:00.000Z",
      "2026-03-28T00:00:00.000Z",
      "2026-04-27T23:00:00.000Z",
    ]);
  });

  test("UTC: keine Lücke", () => {
    const workspace = { cycleStartDate: "2026-01-15", cycleDurationMonths: 3 };
    const first = legacyWindow(
      workspace,
      new Date("2026-04-14T12:00:00Z"),
      "UTC"
    );
    const second = legacyWindow(
      workspace,
      new Date("2026-04-15T12:00:00Z"),
      "UTC"
    );
    expect(first.endExclusive.toISOString()).toBe("2026-04-15T00:00:00.000Z");
    expect(second.start.toISOString()).toBe("2026-04-15T00:00:00.000Z");
  });
});

describe("quota-snapshot: Aufruf", () => {
  const silent = { write: () => {} };

  test("ohne oder mit unbekanntem Befehl: Status 2", async () => {
    expect(await main([], { stdout: silent, stderr: silent })).toBe(2);
    expect(await main(["foo"], { stdout: silent, stderr: silent })).toBe(2);
    expect(await main(["--help"], { stdout: silent, stderr: silent })).toBe(0);
  });

  test("snapshot prüft Modus, Zeitzone, Zeitpunkt und Datei vor dem Öffnen der Datenbank", async () => {
    const errors = [];
    const stderr = { write: (text) => errors.push(text) };
    const run = (args) => main(args, { stdout: silent, stderr });

    expect(await run(["snapshot"])).toBe(2);
    expect(await run(["snapshot", "--mode", "legacy"])).toBe(2);
    expect(
      await run(["snapshot", "--mode", "current", "--now", "kein Datum"])
    ).toBe(2);
    expect(
      await run([
        "snapshot",
        "--mode",
        "current",
        "--db",
        path.join(os.tmpdir(), "quota-snapshot-gibt-es-nicht.db"),
      ])
    ).toBe(2);
    expect(errors.join("")).toContain("--legacy-tz angeben");
    expect(errors.join("")).toContain("Datenbank nicht gefunden");
  });

  test("compare braucht zwei Dateien", async () => {
    expect(await main(["compare"], { stdout: silent, stderr: silent })).toBe(2);
  });
});
