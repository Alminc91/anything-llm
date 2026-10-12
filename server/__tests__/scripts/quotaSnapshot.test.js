/* eslint-env jest, node */
// KIE-531 — Schnappschuss und Vergleich für den Rollout des Zyklusfensters.
//
// Die Datenbank ist hier eine Zeilenliste im Speicher; buildSnapshot bekommt
// dafür eine Zählfunktion, die das halboffene Fenster wie die Datenbank
// auswertet. Die Zeitzone des bisherigen Serverprozesses wird dem Skript
// ausdrücklich genannt, die Tests hängen nicht an der Zeitzone des Testlaufs.
//
// Der Befehl snapshot läuft zusätzlich über seinen echten Weg (Workspace-
// Auswahl, Zählklauseln, Embed-Relation) gegen einen Prisma-Ersatz im
// Speicher, der select, gte/gt/lt/lte und die Relation wie die Datenbank
// auswertet.
jest.mock("../../utils/prisma", () => {
  const tables = {
    workspaces: [],
    workspace_chats: [],
    embed_configs: [],
    embed_chats: [],
    workspace_message_adjustments: [],
  };
  const inRange = (createdAt, range = {}) =>
    (range.gte === undefined || createdAt >= range.gte) &&
    (range.gt === undefined || createdAt > range.gt) &&
    (range.lt === undefined || createdAt < range.lt) &&
    (range.lte === undefined || createdAt <= range.lte);
  // Ein fehlender Filter schränkt wie in der Datenbank nicht ein.
  const matches = (value, expected) =>
    expected === undefined || value === expected;
  return {
    __tables: tables,
    __clientOptions: [],
    $disconnect: jest.fn(async () => {}),
    workspaces: {
      findMany: async ({ select, orderBy } = {}) =>
        [...tables.workspaces]
          .sort((a, b) => (orderBy?.id === "asc" ? a.id - b.id : 0))
          .map((row) =>
            select
              ? Object.fromEntries(
                  Object.keys(select)
                    .filter((key) => select[key])
                    .map((key) => [key, row[key]])
                )
              : { ...row }
          ),
    },
    workspace_chats: {
      count: async ({ where = {} }) =>
        tables.workspace_chats.filter(
          (row) =>
            matches(row.workspaceId, where.workspaceId) &&
            inRange(row.createdAt, where.createdAt)
        ).length,
    },
    embed_chats: {
      count: async ({ where = {} }) =>
        tables.embed_chats.filter((row) => {
          const config = tables.embed_configs.find(
            (entry) => entry.id === row.embed_id
          );
          return (
            matches(config?.workspace_id, where.embed_config?.workspace_id) &&
            inRange(row.createdAt, where.createdAt)
          );
        }).length,
    },
    workspace_message_adjustments: {
      aggregate: async ({ where = {} }) => {
        const rows = tables.workspace_message_adjustments.filter(
          (row) =>
            matches(row.workspaceId, where.workspaceId) &&
            inRange(row.createdAt, where.createdAt)
        );
        // Wie Prisma: ohne Zeilen ist die Summe null, nicht 0.
        return {
          _sum: {
            amount: rows.length
              ? rows.reduce((sum, row) => sum + row.amount, 0)
              : null,
          },
        };
      },
    },
  };
});
// Mit --db öffnet das Skript die Datei über einen eigenen PrismaClient.
jest.mock("@prisma/client", () => ({
  PrismaClient: function PrismaClient(options) {
    const prisma = require("../../utils/prisma");
    prisma.__clientOptions.push(options);
    return prisma;
  },
}));

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
const prisma = require("../../utils/prisma");

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

/** Workspace mit Monatszyklus ab dem genannten Tag. */
function monthly(id, slug, cycleStartDate) {
  return {
    id,
    slug,
    name: slug,
    messagesLimit: 600,
    cycleStartDate: new Date(cycleStartDate),
    cycleDurationMonths: 1,
  };
}

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
      {
        id: 3,
        slug: "monatsende",
        name: "Monatsende",
        fromDay: 28,
        toDay: 31,
        nextResetBefore: "2026-04-28",
        nextResetAfter: "2026-04-30",
      },
    ]);

    const text = formatComparison(comparison);
    expect(text).toContain("Geänderter Reset-Tag (Starttag 29.–31.):");
    expect(text).toContain(
      "  [3] monatsende: Zyklusstart vom 28. auf den 31., nächster Reset am 30.04.2026 statt am 28.04.2026"
    );
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

  test("reset_tag: der nächste Reset verschiebt sich auch, wenn das laufende Fenster am selben Tag begann", async () => {
    // Stand 12.10.2026. Start 31.03. und 31.08.: Das laufende Fenster begann
    // bisher wie neu am 30.09.; der nächste Reset war bisher der 30.10., neu
    // ist es der 31.10. Start 31.01.: zusätzlich ein anderer Starttag. Start
    // 30.01. und 29.01. blieben bisher seit dem Februar ebenfalls auf dem 28.
    // hängen; Start 28.01. ist die Grenze, ab der sich nichts ändert.
    const workspaces = [
      monthly(1, "start-31-03", "2026-03-31"),
      monthly(2, "start-31-08", "2026-08-31"),
      monthly(3, "start-31-01", "2026-01-31"),
      monthly(4, "start-15-01", "2026-01-15"),
      monthly(5, "start-30-01", "2026-01-30"),
      monthly(6, "start-29-01", "2026-01-29"),
      monthly(7, "start-28-01", "2026-01-28"),
    ];
    const { before, after } = await snapshotPair({
      workspaces,
      rows: workspaces.flatMap((workspace) =>
        many(workspace.id, 5, "2026-10-05T10:00:00+02:00")
      ),
      now: "2026-10-12T10:00:00+02:00",
    });
    expect(before.workspaces[0].window).toMatchObject({
      startDay: "2026-09-30",
      endDayExclusive: "2026-10-30",
    });
    expect(after.workspaces[0].window).toMatchObject({
      startDay: "2026-09-30",
      endDayExclusive: "2026-10-31",
    });

    const comparison = compareSnapshots(before, after);
    // Der Stand ist überall gleich – gelistet wird trotzdem.
    expect(comparison.ok).toBe(true);
    expect(comparison.workspaces.map((result) => result.status)).toEqual(
      workspaces.map(() => "identical")
    );
    expect(comparison.resetDayChanged).toEqual([
      {
        id: 1,
        slug: "start-31-03",
        name: "start-31-03",
        fromDay: null,
        toDay: null,
        nextResetBefore: "2026-10-30",
        nextResetAfter: "2026-10-31",
      },
      {
        id: 2,
        slug: "start-31-08",
        name: "start-31-08",
        fromDay: null,
        toDay: null,
        nextResetBefore: "2026-10-30",
        nextResetAfter: "2026-10-31",
      },
      {
        id: 3,
        slug: "start-31-01",
        name: "start-31-01",
        fromDay: 28,
        toDay: 30,
        nextResetBefore: "2026-10-28",
        nextResetAfter: "2026-10-31",
      },
      {
        id: 5,
        slug: "start-30-01",
        name: "start-30-01",
        fromDay: 28,
        toDay: 30,
        nextResetBefore: "2026-10-28",
        nextResetAfter: "2026-10-30",
      },
      {
        id: 6,
        slug: "start-29-01",
        name: "start-29-01",
        fromDay: 28,
        toDay: 29,
        nextResetBefore: "2026-10-28",
        nextResetAfter: "2026-10-29",
      },
    ]);
    expect(comparison.workspaces[0].notes).toEqual([
      "Nächster Reset am 31.10.2026 statt am 30.10.2026 (ohne Auswirkung auf den Stand)",
    ]);
    expect(comparison.workspaces[3].notes).toEqual([]);
    expect(comparison.workspaces[6].notes).toEqual([]);

    const text = formatComparison(comparison);
    expect(text).toContain(
      "  [1] start-31-03: nächster Reset am 31.10.2026 statt am 30.10.2026"
    );
    expect(text).toContain(
      "  [2] start-31-08: nächster Reset am 31.10.2026 statt am 30.10.2026"
    );
    expect(text).toContain(
      "  [3] start-31-01: Zyklusstart vom 28. auf den 30., nächster Reset am 31.10.2026 statt am 28.10.2026"
    );
    expect(text).toContain(
      "  [5] start-30-01: Zyklusstart vom 28. auf den 30., nächster Reset am 30.10.2026 statt am 28.10.2026"
    );
    expect(text).toContain(
      "  [6] start-29-01: Zyklusstart vom 28. auf den 29., nächster Reset am 29.10.2026 statt am 28.10.2026"
    );
    // Starttag 15. und 28.: nichts geändert, also nicht in der Liste.
    const list = text.slice(text.indexOf("Geänderter Reset-Tag"));
    expect(list).not.toContain("[4] start-15-01");
    expect(list).not.toContain("[7] start-28-01");
  });

  test("ursachen: Starttag 29. und 30. blieben bisher ebenfalls auf dem 28. hängen", async () => {
    // Stand 12.10.2026: bisher begann das Fenster überall am 28.09., neu am
    // 30.09. bzw. 29.09. Die Nachrichten dazwischen fallen heraus. Starttag
    // 28.: Der 28.09. zählt bisher wie neu.
    const workspaces = [
      monthly(5, "start-30-01", "2026-01-30"),
      monthly(6, "start-29-01", "2026-01-29"),
      monthly(7, "start-28-01", "2026-01-28"),
    ];
    const { before, after } = await snapshotPair({
      workspaces,
      rows: workspaces.flatMap((workspace) => [
        ...many(workspace.id, 2, "2026-09-28T10:00:00+02:00"),
        ...many(workspace.id, 3, "2026-09-29T10:00:00+02:00"),
        ...many(workspace.id, 5, "2026-10-05T10:00:00+02:00"),
      ]),
      now: "2026-10-12T10:00:00+02:00",
    });
    const comparison = compareSnapshots(before, after);
    expect(comparison.ok).toBe(true);
    expect(comparison.workspaces.map((result) => result.message)).toEqual([
      "[5] start-30-01: 10 → 5, -5, Ursache: Zyklusstart verschoben vom 28. auf den 30.",
      "[6] start-29-01: 10 → 8, -2, Ursache: Zyklusstart verschoben vom 28. auf den 29.",
      "[7] start-28-01: identisch (10)",
    ]);
    expect(comparison.workspaces[2].causes).toEqual([]);
    expect(comparison.resetDayChanged.map((entry) => entry.id)).toEqual([5, 6]);
  });

  test("reset_tag: verschobener Zyklusstart, dessen nächster Reset auf denselben Tag fällt", async () => {
    // 10.02.2027, Start 31.01.2026: bisher 28.01. → 28.02., neu 31.01. → 28.02.
    const { before, after } = await snapshotPair({
      workspaces: [endOfMonth],
      rows: many(3, 4, "2027-02-05T10:00:00+01:00"),
      now: "2027-02-10T10:00:00+01:00",
    });
    const comparison = compareSnapshots(before, after);
    expect(comparison.workspaces[0].status).toBe("identical");
    expect(comparison.resetDayChanged).toEqual([
      {
        id: 3,
        slug: "monatsende",
        name: "Monatsende",
        fromDay: 28,
        toDay: 31,
        nextResetBefore: null,
        nextResetAfter: null,
      },
    ]);
    expect(formatComparison(comparison)).toContain(
      "  [3] monatsende: Zyklusstart vom 28. auf den 31.\n"
    );
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

  test("unerklaert_bricht_ab: nicht auswertbarer Workspace gilt als unerklärt und stoppt den Rollout (NAK-1)", async () => {
    // Die Zählung scheitert für genau einen Workspace.
    const failingCounter = (rows) => {
      const count = memoryCounter(rows);
      return async (workspace, start, endExclusive) => {
        if (workspace.id === withGap.id)
          throw new Error("no such table: embed_chats");
        return count(workspace, start, endExclusive);
      };
    };
    const build = (countInWindow, mode) =>
      buildSnapshot({
        workspaces: [plain, withGap],
        countInWindow,
        now: new Date(NOW),
        mode,
        legacyTimeZone: mode === "legacy" ? LEGACY_TZ : null,
      });
    const rows = ak10Rows().filter((entry) => entry.workspaceId === 1);
    const before = await build(memoryCounter(rows), "legacy");
    const after = await build(failingCounter(rows), "current");

    // Der Workspace bleibt im Schnappschuss sichtbar, ohne Stand.
    expect(after.workspaces[1]).toMatchObject({
      id: 2,
      slug: "luecke",
      error: "no such table: embed_chats",
    });
    expect(after.workspaces[1].messageCount).toBeUndefined();
    expect(after.workspaces[0].error).toBeUndefined();

    for (const [old, now] of [
      [before, after],
      [await build(failingCounter(rows), "legacy"), after],
      [
        await build(failingCounter(rows), "legacy"),
        await build(memoryCounter(rows), "current"),
      ],
    ]) {
      const comparison = compareSnapshots(old, now);
      expect(comparison.ok).toBe(false);
      expect(comparison.unexplained.map((result) => result.id)).toEqual([2]);
      expect(comparison.workspaces[0].status).toBe("identical");
      expect(comparison.workspaces[1]).toMatchObject({
        status: "unexplained",
        delta: null,
        message:
          "[2] luecke: nicht auswertbar (no such table: embed_chats), unerklärt",
      });
    }

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "quota-snapshot-"));
    try {
      const beforeFile = path.join(dir, "vorher.json");
      const afterFile = path.join(dir, "nachher.json");
      fs.writeFileSync(beforeFile, JSON.stringify(before));
      fs.writeFileSync(afterFile, JSON.stringify(after));
      const output = [];
      expect(
        await main(["compare", beforeFile, afterFile], {
          stdout: { write: (text) => output.push(text) },
          stderr: { write: () => {} },
        })
      ).toBe(1);
      expect(output.join("")).toContain(
        "[2] luecke: nicht auswertbar (no such table: embed_chats), unerklärt"
      );
      expect(output.join("")).toContain(
        "Unerklärter Unterschied: Der Rollout darf nicht fortgesetzt werden."
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("unerklaert_bricht_ab: ohne Angaben zum bisherigen Fenster bleibt ein Workspace unerklärt", async () => {
    const { before, after } = await snapshotPair({
      workspaces: [plain],
      rows: ak10Rows(),
      now: NOW,
    });
    delete before.workspaces[0].transition;
    const comparison = compareSnapshots(before, after);
    expect(comparison.ok).toBe(false);
    expect(comparison.workspaces[0].message).toBe(
      "[1] ohne-besonderheit: Angaben zum bisherigen Fenster fehlen im Schnappschuss vorher, unerklärt"
    );
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

  test("unerklaert_bricht_ab: abweichender Starttag ohne Starttag 29.–31. ist keine benannte Ursache", async () => {
    // Serverprozess in New York: Der gespeicherte Start (01.03. 00:00 UTC) ist
    // dort der 28.02. 19:00 Uhr, die bisherigen Zyklen begannen deshalb in
    // Berliner Zeit am 29. – ein Tageswechsel der Zeitzone, kein geklemmter
    // Reset-Tag.
    const firstOfMonth = {
      id: 7,
      slug: "monatserster",
      name: "Monatserster",
      messagesLimit: 600,
      cycleStartDate: new Date("2026-03-01"),
      cycleDurationMonths: 1,
    };
    const { before, after } = await snapshotPair({
      workspaces: [firstOfMonth],
      rows: [
        ...many(7, 3, "2026-03-30T10:00:00+02:00"),
        ...many(7, 10, "2026-04-02T10:00:00+02:00"),
      ],
      now: NOW,
      legacyTimeZone: "America/New_York",
    });
    expect(before.workspaces[0].window.startDay).toBe("2026-03-29");
    expect(after.workspaces[0].window.startDay).toBe("2026-04-01");
    expect(before.workspaces[0].transition).toMatchObject({
      shiftUnits: 0,
      shiftFromDay: null,
      shiftToDay: null,
      nextResetBefore: null,
      nextResetAfter: null,
    });

    const comparison = compareSnapshots(before, after);
    expect(comparison.ok).toBe(false);
    expect(comparison.resetDayChanged).toEqual([]);
    expect(comparison.workspaces[0]).toMatchObject({
      status: "unexplained",
      causes: [],
      message:
        "[7] monatserster: 13 → 10, -3, unerklärt: keine der benannten Ursachen",
    });
  });

  test("klemmung: Gutschriften über dem Verbrauch halten den Stand bei 0, die Lücke bleibt als Ursache benannt", async () => {
    const credited = { ...withGap, id: 6, slug: "gutschrift" };
    const rows = [
      row(6, "2026-04-15T00:20:00+02:00"),
      row(6, "2026-04-15T00:40:00+02:00", "embed"),
      ...many(6, 5, "2026-04-15T01:00:00+02:00"),
      row(6, "2026-04-16T09:00:00+02:00", "adjustment", -20),
    ];
    const { before, after } = await snapshotPair({
      workspaces: [credited],
      rows,
      now: NOW,
    });
    // Wie der Server: nie unter 0, auch wenn die Summe negativ ist.
    expect(before.workspaces[0]).toMatchObject({
      messageCount: 0,
      workspaceChatCount: 5,
      embedChatCount: 0,
      adjustmentsTotal: -20,
      limitReached: false,
    });
    expect(after.workspaces[0]).toMatchObject({
      messageCount: 0,
      workspaceChatCount: 6,
      embedChatCount: 1,
      adjustmentsTotal: -20,
      limitReached: false,
    });

    // Der Stand ist gleich, in den Fenstern liegt aber anderes: Das gilt
    // nicht als identisch, sondern braucht eine Ursache.
    const comparison = compareSnapshots(before, after);
    expect(comparison.ok).toBe(true);
    expect(comparison.workspaces[0]).toMatchObject({
      status: "explained",
      before: 0,
      after: 0,
      delta: 0,
      unexplainedUnits: 0,
      causes: [
        {
          code: "legacy_gap",
          units: 2,
          text: "Nachrichten in der bisherigen Lücke",
        },
      ],
      message:
        "[6] gutschrift: 0 → 0, 0, Ursache: Nachrichten in der bisherigen Lücke",
      notes: [
        "Stand unverändert, weil Gutschriften überwiegen: Summe vor der Klemmung auf 0 bisher -15, neu -13.",
      ],
    });

    // Ohne Ursache bleibt derselbe verdeckte Unterschied unerklärt.
    after.workspaces[0].workspaceChatCount += 1;
    const tampered = compareSnapshots(before, after);
    expect(tampered.ok).toBe(false);
    expect(tampered.workspaces[0].message).toBe(
      "[6] gutschrift: 0 → 0, 0, unerklärt: +1 neben Nachrichten in der bisherigen Lücke"
    );
  });

  test("klemmung: Gutschriften über dem Verbrauch ohne Unterschied in den Fenstern sind identisch", async () => {
    const credited = { ...withGap, id: 6, slug: "gutschrift" };
    const { before, after } = await snapshotPair({
      workspaces: [credited],
      rows: [
        ...many(6, 5, "2026-04-15T01:00:00+02:00"),
        row(6, "2026-04-16T09:00:00+02:00", "adjustment", -20),
      ],
      now: NOW,
    });
    const [result] = compareSnapshots(before, after).workspaces;
    expect(result.status).toBe("identical");
    expect(result.message).toBe("[6] gutschrift: identisch (0)");
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

describe("quota-snapshot: Vergleich nur legacy → current mit demselben Bezugszeitpunkt", () => {
  // Limit 100, Start 15.07., 3 Monate: 4 Nachrichten am 15.10. um 00:30 Uhr
  // Berliner Zeit (bisherige Lücke), 98 danach. Bisher 98, neu 102.
  const customer = {
    id: 1,
    slug: "kunde",
    name: "Kunde",
    messagesLimit: 100,
    cycleStartDate: new Date("2026-07-15"),
    cycleDurationMonths: 3,
  };
  const rows = [
    ...many(1, 4, "2026-10-15T00:30:00+02:00"),
    ...many(1, 98, "2026-10-15T09:00:00+02:00"),
  ];
  const now = "2026-10-20T08:00:00Z";

  let dir;
  let files;
  beforeEach(async () => {
    const { before, after } = await snapshotPair({
      workspaces: [customer],
      rows,
      now,
    });
    const later = await buildSnapshot({
      workspaces: [customer],
      countInWindow: memoryCounter(rows),
      now: new Date("2026-10-20T08:05:00Z"),
      mode: "current",
    });
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "quota-snapshot-"));
    files = {};
    for (const [name, snapshot] of Object.entries({
      legacy: before,
      current: after,
      later,
    })) {
      files[name] = path.join(dir, `${name}.json`);
      fs.writeFileSync(files[name], JSON.stringify(snapshot));
    }
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  async function compare(beforeName, afterName) {
    const output = [];
    const errors = [];
    const status = await main(
      ["compare", files[beforeName], files[afterName]],
      {
        stdout: { write: (text) => output.push(text) },
        stderr: { write: (text) => errors.push(text) },
      }
    );
    return { status, output: output.join(""), errors: errors.join("") };
  }

  test("legacy → current: der Vergleich läuft und listet den Workspace am Limit", async () => {
    const { status, output } = await compare("legacy", "current");
    expect(status).toBe(0);
    expect(output).toContain(
      "[1] kunde: 98 → 102, +4, Ursache: Nachrichten in der bisherigen Lücke"
    );
    expect(output).toContain("  [1] kunde: 98 → 102 bei Limit 100");
  });

  test.each([
    ["current", "current"],
    ["legacy", "legacy"],
    ["current", "legacy"],
  ])(
    "unerklaert_bricht_ab: %s → %s ist ein Aufruffehler, kein bestandener Vergleich",
    async (beforeName, afterName) => {
      const { status, output, errors } = await compare(beforeName, afterName);
      expect(status).toBe(2);
      expect(errors).toContain(
        `Nicht vergleichbar: erwartet wird vorher = legacy (mit --legacy-tz) und nachher = current (ist: ${beforeName} und ${afterName}).`
      );
      // Keine Entwarnung, wenn nichts verglichen wurde.
      expect(output).toBe("");
    }
  );

  test("unerklaert_bricht_ab: unterschiedliche Bezugszeitpunkte sind nicht vergleichbar, auch bei gleichem Stand", async () => {
    const later = JSON.parse(fs.readFileSync(files.later, "utf8"));
    const current = JSON.parse(fs.readFileSync(files.current, "utf8"));
    // Der Stand ist derselbe wie zum richtigen Bezugszeitpunkt.
    expect(later.workspaces[0].messageCount).toBe(
      current.workspaces[0].messageCount
    );

    const { status, output, errors } = await compare("legacy", "later");
    expect(status).toBe(2);
    expect(errors).toContain(
      "Nicht vergleichbar: unterschiedliche Bezugszeitpunkte (vorher 2026-10-20T08:00:00.000Z, nachher 2026-10-20T08:05:00.000Z)."
    );
    expect(output).toBe("");
  });

  test("unerklaert_bricht_ab: compareSnapshots wirft bei falscher Paarung und bei legacy ohne Zeitzone", async () => {
    const legacy = JSON.parse(fs.readFileSync(files.legacy, "utf8"));
    const current = JSON.parse(fs.readFileSync(files.current, "utf8"));
    expect(() => compareSnapshots(current, current)).toThrow(
      /Nicht vergleichbar/
    );
    expect(() => compareSnapshots(legacy, legacy)).toThrow(
      /Nicht vergleichbar/
    );
    expect(() =>
      compareSnapshots({ ...legacy, legacyTimeZone: null }, current)
    ).toThrow(/Nicht vergleichbar/);
    // Auch ein current-Schnappschuss mit --legacy-tz ist kein Vorher.
    const currentWithTimeZone = await buildSnapshot({
      workspaces: [customer],
      countInWindow: memoryCounter(rows),
      now: new Date(now),
      mode: "current",
      legacyTimeZone: LEGACY_TZ,
    });
    expect(() => compareSnapshots(currentWithTimeZone, current)).toThrow(
      /Nicht vergleichbar/
    );
    expect(() =>
      compareSnapshots(legacy, { ...current, now: "2026-10-20T08:00:01.000Z" })
    ).toThrow(/unterschiedliche Bezugszeitpunkte/);
    expect(compareSnapshots(legacy, current).ok).toBe(true);
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
    // Der bisherige nächste Reset: 15.04. 01:00 Uhr MESZ.
    expect(quarter.nextStart.toISOString()).toBe("2026-04-14T23:00:00.000Z");
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
    expect(first.nextStart.toISOString()).toBe("2026-04-15T00:00:00.000Z");
    expect(second.start.toISOString()).toBe("2026-04-15T00:00:00.000Z");

    // Ohne Zyklus ist der nächste Start der Beginn des Folgemonats.
    const month = legacyWindow({}, new Date("2026-04-14T12:00:00Z"), "UTC");
    expect(month.endExclusive.toISOString()).toBe("2026-05-01T00:00:00.000Z");
    expect(month.nextStart.toISOString()).toBe("2026-05-01T00:00:00.000Z");
  });
});

describe("quota-snapshot: Befehl snapshot gegen die Datenbank", () => {
  const silent = { write: () => {} };
  let dir;
  let dbFile;

  function fillDatabase(workspaces, rows) {
    const tables = prisma.__tables;
    for (const table of Object.values(tables)) table.length = 0;
    // Absichtlich nicht nach id sortiert und mit einer Spalte mehr, als der
    // Schnappschuss braucht.
    tables.workspaces.push(
      ...[...workspaces]
        .reverse()
        .map((workspace) => ({ ...workspace, openAiPrompt: "nicht gefragt" }))
    );
    for (const workspace of workspaces)
      tables.embed_configs.push({
        id: workspace.id * 10,
        workspace_id: workspace.id,
      });
    for (const entry of rows) {
      if (entry.kind === "chat")
        tables.workspace_chats.push({
          workspaceId: entry.workspaceId,
          createdAt: entry.at,
        });
      else if (entry.kind === "embed")
        tables.embed_chats.push({
          embed_id: entry.workspaceId * 10,
          createdAt: entry.at,
        });
      else
        tables.workspace_message_adjustments.push({
          workspaceId: entry.workspaceId,
          amount: entry.amount,
          createdAt: entry.at,
        });
    }
  }

  const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

  beforeEach(() => {
    prisma.__clientOptions.length = 0;
    prisma.$disconnect.mockClear();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "quota-snapshot-"));
    dbFile = path.join(dir, "anythingllm.db");
    fs.writeFileSync(dbFile, "");
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  test("ursachen: snapshot in beiden Modi und compare melden die drei Fälle aus AK-10", async () => {
    fillDatabase(
      [plain, withGap, endOfMonth],
      [
        ...ak10Rows(),
        // Eine Millisekunde nach dem Bezugszeitpunkt eingegangen, in allen
        // drei Tabellen: zählt in keinem der beiden Schnappschüsse.
        row(1, "2026-04-20T10:00:00.001+02:00"),
        row(1, "2026-04-20T10:00:00.001+02:00", "embed"),
        row(1, "2026-04-20T10:00:00.001+02:00", "adjustment", 100),
      ]
    );
    const beforeFile = path.join(dir, "vorher.json");
    const afterFile = path.join(dir, "nachher.json");
    const run = (args) => main(args, { stdout: silent, stderr: silent });

    expect(
      await run([
        "snapshot",
        "--mode",
        "legacy",
        "--legacy-tz",
        LEGACY_TZ,
        "--db",
        dbFile,
        "--now",
        NOW,
        "--out",
        beforeFile,
      ])
    ).toBe(0);
    expect(
      await run([
        "snapshot",
        "--mode",
        "current",
        "--db",
        dbFile,
        "--now",
        NOW,
        "--out",
        afterFile,
      ])
    ).toBe(0);

    // Genau die genannte Datei wird geöffnet und wieder geschlossen.
    expect(prisma.__clientOptions).toEqual([
      { datasources: { db: { url: `file:${dbFile}` } } },
      { datasources: { db: { url: `file:${dbFile}` } } },
    ]);
    expect(prisma.$disconnect).toHaveBeenCalledTimes(2);

    const before = readJson(beforeFile);
    const after = readJson(afterFile);
    expect(before).toMatchObject({
      schema: SNAPSHOT_SCHEMA,
      mode: "legacy",
      legacyTimeZone: LEGACY_TZ,
      now: "2026-04-20T08:00:00.000Z",
      database: dbFile,
    });
    expect(after).toMatchObject({
      schema: SNAPSHOT_SCHEMA,
      mode: "current",
      legacyTimeZone: null,
      now: "2026-04-20T08:00:00.000Z",
      database: dbFile,
    });

    // Bisherige Grenzen: 30+5 Chats und Embed-Chats plus Buchung, 50 ohne die
    // Lücke, 60 seit dem 28.03.
    expect(
      before.workspaces.map((workspace) => [
        workspace.id,
        workspace.slug,
        workspace.messagesLimit,
        workspace.messageCount,
      ])
    ).toEqual([
      [1, "ohne-besonderheit", 600, 35],
      [2, "luecke", 600, 50],
      [3, "monatsende", 600, 60],
    ]);
    expect(before.workspaces[1].window.start).toBe("2026-04-14T23:00:00.000Z");
    expect(before.workspaces[2].window.startDay).toBe("2026-03-28");
    // Neue Grenzen: die Lücke zählt mit, der Zyklus beginnt am 31.03.
    expect(
      after.workspaces.map((workspace) => [
        workspace.id,
        workspace.messageCount,
        workspace.workspaceChatCount,
        workspace.embedChatCount,
        workspace.adjustmentsTotal,
      ])
    ).toEqual([
      [1, 35, 20, 5, 10],
      [2, 54, 52, 2, 0],
      [3, 40, 40, 0, 0],
    ]);
    expect(after.workspaces[1].window).toEqual({
      start: "2026-04-14T22:00:00.000Z",
      endExclusive: "2026-07-14T22:00:00.000Z",
      startDay: "2026-04-15",
      endDayExclusive: "2026-07-15",
      cycleNumber: 2,
    });
    expect(after.workspaces[0].openAiPrompt).toBeUndefined();

    const output = [];
    expect(
      await main(["compare", beforeFile, afterFile], {
        stdout: { write: (text) => output.push(text) },
        stderr: silent,
      })
    ).toBe(0);
    const text = output.join("");
    expect(text).toContain("[1] ohne-besonderheit: identisch (35)");
    expect(text).toContain(
      "[2] luecke: 50 → 54, +4, Ursache: Nachrichten in der bisherigen Lücke"
    );
    expect(text).toContain(
      "[3] monatsende: 60 → 40, -20, Ursache: Zyklusstart verschoben vom 28. auf den 31."
    );
    expect(text).toContain("Ergebnis: 1 identisch, 2 erklärt, 0 unerklärt.");
  });

  test("limit_erreicht_gelistet: ohne --db gilt die Prisma-Konfiguration des Servers, das Limit kommt aus der Datenbank", async () => {
    fillDatabase([plain, { ...withGap, messagesLimit: 54 }], ak10Rows());
    const snapshot = async (args) => {
      const output = [];
      const status = await main(["snapshot", "--now", NOW, ...args], {
        stdout: { write: (text) => output.push(text) },
        stderr: silent,
      });
      expect(status).toBe(0);
      return JSON.parse(output.join(""));
    };

    // Ohne --out geht der Schnappschuss auf die Standardausgabe.
    const before = await snapshot([
      "--mode",
      "legacy",
      "--legacy-tz",
      LEGACY_TZ,
    ]);
    const after = await snapshot(["--mode", "current"]);
    expect(prisma.__clientOptions).toEqual([]);
    expect(prisma.$disconnect).toHaveBeenCalledTimes(2);
    expect(before.database).toBeNull();
    expect(before.workspaces[1]).toMatchObject({
      messagesLimit: 54,
      messageCount: 50,
      limitReached: false,
    });
    expect(after.workspaces[1]).toMatchObject({
      messagesLimit: 54,
      messageCount: 54,
      limitReached: true,
    });
    expect(compareSnapshots(before, after).limitReached).toEqual([
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
  });

  test("unerklaert_bricht_ab: Datenbankfehler beim Zählen werden nicht verschluckt (NAK-1)", async () => {
    fillDatabase([plain, withGap], ak10Rows());
    const beforeFile = path.join(dir, "vorher.json");
    const afterFile = path.join(dir, "nachher.json");
    const run = (args) => main(args, { stdout: silent, stderr: silent });
    expect(
      await run([
        "snapshot",
        "--mode",
        "legacy",
        "--legacy-tz",
        LEGACY_TZ,
        "--db",
        dbFile,
        "--now",
        NOW,
        "--out",
        beforeFile,
      ])
    ).toBe(0);

    const count = prisma.embed_chats.count;
    prisma.embed_chats.count = async (args) => {
      if (args.where.embed_config.workspace_id === withGap.id)
        throw new Error("no such table: embed_chats");
      return count(args);
    };
    try {
      expect(
        await run([
          "snapshot",
          "--mode",
          "current",
          "--db",
          dbFile,
          "--now",
          NOW,
          "--out",
          afterFile,
        ])
      ).toBe(0);
    } finally {
      prisma.embed_chats.count = count;
    }
    expect(readJson(afterFile).workspaces[1]).toMatchObject({
      id: 2,
      error: "no such table: embed_chats",
    });

    const output = [];
    expect(
      await main(["compare", beforeFile, afterFile], {
        stdout: { write: (text) => output.push(text) },
        stderr: silent,
      })
    ).toBe(1);
    expect(output.join("")).toContain(
      "[2] luecke: nicht auswertbar (no such table: embed_chats), unerklärt"
    );
  });

  test("die Datenbank wird auch nach einem Fehler geschlossen", async () => {
    fillDatabase([plain], []);
    const findMany = prisma.workspaces.findMany;
    prisma.workspaces.findMany = async () => {
      throw new Error("no such table: workspaces");
    };
    const errors = [];
    try {
      expect(
        await main(
          ["snapshot", "--mode", "current", "--db", dbFile, "--now", NOW],
          { stdout: silent, stderr: { write: (text) => errors.push(text) } }
        )
      ).toBe(2);
    } finally {
      prisma.workspaces.findMany = findMany;
    }
    expect(errors.join("")).toContain("no such table: workspaces");
    expect(prisma.$disconnect).toHaveBeenCalledTimes(1);
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
