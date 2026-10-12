/* eslint-env jest, node */
// KIE-531 — ein einheitliches Zyklusfenster in Berliner Zeit.
//
// Die Tests setzen die Zeitzone des Prozesses nicht selbst. Alle Zeitpunkte
// sind mit Versatz oder in UTC angegeben, die Erwartungen ebenfalls; die Datei
// muss mit TZ=UTC, TZ=Europe/Berlin und TZ=America/New_York dieselben
// Ergebnisse liefern (NAK-3).
//
// Gezählt wird über die echten Modelle gegen einen Prisma-Ersatz im Speicher,
// der gte/gt/lt/lte wie die Datenbank auswertet. So ist auch die Klausel der
// Modelle Teil der Prüfung, nicht nur die Fensterberechnung.

jest.mock("../../../utils/prisma", () => {
  const rows = {
    workspace_chats: [],
    embed_chats: [],
    workspace_message_adjustments: [],
  };
  const inRange = (createdAt, range = {}) =>
    (range.gte === undefined || createdAt >= range.gte) &&
    (range.gt === undefined || createdAt > range.gt) &&
    (range.lt === undefined || createdAt < range.lt) &&
    (range.lte === undefined || createdAt <= range.lte);
  return {
    __rows: rows,
    workspace_chats: {
      count: async ({ where }) =>
        rows.workspace_chats.filter(
          (row) =>
            row.workspaceId === where.workspaceId &&
            inRange(row.createdAt, where.createdAt)
        ).length,
    },
    embed_chats: {
      count: async ({ where }) =>
        rows.embed_chats.filter(
          (row) =>
            row.workspaceId === where.embed_config.workspace_id &&
            inRange(row.createdAt, where.createdAt)
        ).length,
    },
    workspace_message_adjustments: {
      aggregate: async ({ where }) => ({
        _sum: {
          amount: rows.workspace_message_adjustments
            .filter(
              (row) =>
                row.workspaceId === where.workspaceId &&
                inRange(row.createdAt, where.createdAt)
            )
            .reduce((sum, row) => sum + row.amount, 0),
        },
      }),
    },
  };
});

// embedChats.js braucht aus utils/http nur safeJsonParse; der Rest des
// http/auth-Modulgraphen wird hier nicht gebraucht.
jest.mock("../../../utils/http", () => ({
  safeJsonParse: (value, fallback = {}) => {
    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  },
}));

const prisma = require("../../../utils/prisma");
const {
  BILLING_TIME_ZONE,
  getBillingWindow,
  berlinDayOf,
  berlinMidnight,
  cycleStartDay,
} = require("../../../utils/helpers/billingWindow");
const { getMessageLimitInfo } = require("../../../utils/helpers");
const {
  getCycleInfo,
  countMessagesForCurrentCycle,
} = require("../../../utils/helpers/cycleHelpers");

const WORKSPACE_ID = 7;

function resetRows() {
  for (const table of Object.values(prisma.__rows)) table.length = 0;
}

function addChat(iso, table = "workspace_chats") {
  prisma.__rows[table].push({
    workspaceId: WORKSPACE_ID,
    createdAt: new Date(iso),
  });
}

/** Wanduhrzeit eines Zeitpunkts in Berlin, unabhängig vom geprüften Code. */
const wallClockFormatter = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Europe/Berlin",
  dateStyle: "short",
  timeStyle: "medium",
});
function berlinWallClock(instant) {
  return wallClockFormatter.format(instant);
}

/** Deterministischer Zufall, damit ein Fehlschlag reproduzierbar ist. */
function mulberry32(seed) {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function lastDayOfMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

beforeEach(resetRows);

describe("getBillingWindow", () => {
  test("keine_luecke: Nachrichten um den Zykluswechsel zählen in genau einem Zyklus (AK-1)", async () => {
    const workspace = {
      id: WORKSPACE_ID,
      cycleStartDate: "2026-01-15",
      cycleDurationMonths: 3,
    };
    addChat("2026-04-14T23:30:00+02:00");
    addChat("2026-04-15T00:30:00+02:00", "embed_chats");
    addChat("2026-04-15T01:30:00+02:00");

    const lastMomentOfFirst = new Date("2026-04-14T23:59:59.999+02:00");
    const firstMomentOfSecond = new Date("2026-04-15T00:00:00+02:00");

    const first = await countMessagesForCurrentCycle(
      workspace,
      lastMomentOfFirst
    );
    const second = await countMessagesForCurrentCycle(
      workspace,
      firstMomentOfSecond
    );
    expect(first.total).toBe(1);
    expect(second.total).toBe(2);

    // Die beiden Fenster grenzen aneinander: Ende des ersten = Start des zweiten.
    const firstWindow = getBillingWindow(workspace, lastMomentOfFirst);
    const secondWindow = getBillingWindow(workspace, firstMomentOfSecond);
    expect(firstWindow.cycleNumber).toBe(1);
    expect(secondWindow.cycleNumber).toBe(2);
    expect(firstWindow.endExclusive.toISOString()).toBe(
      "2026-04-14T22:00:00.000Z"
    );
    expect(secondWindow.start.toISOString()).toBe("2026-04-14T22:00:00.000Z");
  });

  test("keine_luecke: im Sommer gesetzter Start, Wechsel im Winter (bisher 2 Stunden Lücke)", async () => {
    const workspace = {
      id: WORKSPACE_ID,
      cycleStartDate: "2026-07-15",
      cycleDurationMonths: 6,
    };
    addChat("2027-01-14T23:59:59.999+01:00");
    // Genau auf der Grenze: gehört zum neuen Zyklus, in beiden Chat-Tabellen.
    addChat("2027-01-15T00:00:00+01:00");
    addChat("2027-01-15T00:00:00+01:00", "embed_chats");
    addChat("2027-01-15T01:59:00+01:00");

    const first = await countMessagesForCurrentCycle(
      workspace,
      new Date("2027-01-14T12:00:00+01:00")
    );
    const second = await countMessagesForCurrentCycle(
      workspace,
      new Date("2027-01-15T00:30:00+01:00")
    );
    expect(first.total).toBe(1);
    expect(second.total).toBe(3);
  });

  test("lueckenlos: jeder Zeitpunkt liegt in genau einem Fenster, Fenster schließen aneinander an (AK-2)", () => {
    const random = mulberry32(531);
    const threeYears = 3 * 366 * 24 * 60 * 60 * 1000;

    for (const cycleStartDate of ["2024-01-15", "2024-01-31", "2024-02-29"]) {
      const originalDay = Number(cycleStartDate.slice(-2));
      for (const cycleDurationMonths of [1, 3, 12]) {
        const workspace = { cycleStartDate, cycleDurationMonths };
        const firstStart = berlinMidnight(cycleStartDate).getTime();

        for (let i = 0; i < 1000; i++) {
          const instant = new Date(
            firstStart + Math.floor(random() * threeYears)
          );
          const current = getBillingWindow(workspace, instant);

          // Der Zeitpunkt liegt in seinem Fenster.
          expect(current.start.getTime()).toBeLessThanOrEqual(
            instant.getTime()
          );
          expect(instant.getTime()).toBeLessThan(
            current.endExclusive.getTime()
          );

          // Grenzen sind Berliner Mitternacht des genannten Kalendertags.
          expect(berlinWallClock(current.start)).toBe(
            `${current.startDay} 00:00:00`
          );
          expect(berlinWallClock(current.endExclusive)).toBe(
            `${current.endDayExclusive} 00:00:00`
          );

          // Der Reset-Tag ist der Originaltag, soweit der Monat ihn hat.
          const [year, month, day] = current.startDay.split("-").map(Number);
          expect(day).toBe(Math.min(originalDay, lastDayOfMonth(year, month)));

          // Das Folgefenster beginnt exakt am Ende, das Vorfenster endet exakt
          // am Start: keine Lücke, keine Überschneidung.
          const next = getBillingWindow(workspace, current.endExclusive);
          expect(next.start.getTime()).toBe(current.endExclusive.getTime());
          expect(next.cycleNumber).toBe(current.cycleNumber + 1);

          const lastMomentBefore = new Date(current.start.getTime() - 1);
          const previous = getBillingWindow(workspace, lastMomentBefore);
          expect(previous.endExclusive.getTime()).toBe(current.start.getTime());
          expect(previous.cycleNumber).toBe(current.cycleNumber - 1);
        }
      }
    }
  });

  test("kein_drift: Start 31.01., Monatszyklus – der Reset bleibt am Originaltag (AK-3)", () => {
    const workspace = { cycleStartDate: "2026-01-31", cycleDurationMonths: 1 };
    const expected = [
      "2026-02-28",
      "2026-03-31",
      "2026-04-30",
      "2026-05-31",
      "2026-06-30",
      "2026-07-31",
      "2026-08-31",
      "2026-09-30",
      "2026-10-31",
      "2026-11-30",
      "2026-12-31",
      "2027-01-31",
      "2027-02-28",
      "2027-03-31",
    ];

    // Von Fenster zu Fenster gehen, wie es der Betrieb über 14 Monate tut.
    const starts = [];
    let current = getBillingWindow(
      workspace,
      new Date("2026-01-31T12:00:00+01:00")
    );
    expect(current.startDay).toBe("2026-01-31");
    for (let i = 0; i < expected.length; i++) {
      current = getBillingWindow(workspace, current.endExclusive);
      starts.push(current.startDay);
    }
    expect(starts).toEqual(expected);

    // Dieselben Tage direkt aus dem Originalstart berechnet.
    expect(
      expected.map((_, index) => cycleStartDay("2026-01-31", 1, index + 1))
    ).toEqual(expected);

    // getCycleInfo nennt denselben Reset (Tagesmarke) und den letzten Tag davor.
    const march = getCycleInfo(
      workspace,
      new Date("2026-03-15T12:00:00+01:00")
    );
    expect(march.currentCycleStart.toISOString()).toBe(
      "2026-02-28T00:00:00.000Z"
    );
    expect(march.currentCycleEnd.toISOString()).toBe(
      "2026-03-30T00:00:00.000Z"
    );
    expect(march.nextReset.toISOString()).toBe("2026-03-31T00:00:00.000Z");
    expect(march.originalDay).toBe(31);
  });

  test("kein_drift: Start 29.02.2024, Jahreszyklus – nur im Schaltjahr der 29.", () => {
    const starts = [0, 1, 2, 3, 4].map((index) =>
      cycleStartDay("2024-02-29", 12, index)
    );
    expect(starts).toEqual([
      "2024-02-29",
      "2025-02-28",
      "2026-02-28",
      "2027-02-28",
      "2028-02-29",
    ]);
  });

  test("neuer_zyklus_null: der neue Zyklus beginnt bei 0 (AK-4)", async () => {
    const workspace = {
      id: WORKSPACE_ID,
      messagesLimit: 600,
      cycleStartDate: "2026-01-15",
      cycleDurationMonths: 3,
    };
    // 550 Nachrichten zwischen 15.01. und 14.04., einschließlich des ersten
    // und des letzten Augenblicks des ersten Zyklus.
    addChat("2026-01-15T00:00:00+01:00");
    addChat("2026-04-14T23:59:59.999+02:00", "embed_chats");
    const firstMs = new Date("2026-01-15T08:00:00+01:00").getTime();
    const lastMs = new Date("2026-04-14T20:00:00+02:00").getTime();
    for (let i = 0; i < 548; i++) {
      const createdAt = new Date(firstMs + ((lastMs - firstMs) * i) / 547);
      addChat(createdAt.toISOString(), i % 2 ? "embed_chats" : undefined);
    }

    const before = await getMessageLimitInfo(
      workspace,
      new Date("2026-04-14T23:59:00+02:00")
    );
    expect(before.messageCount).toBe(550);
    expect(before.cycleInfo.cycleNumber).toBe(1);

    for (const now of [
      "2026-04-15T00:05:00+02:00",
      "2026-04-15T09:00:00+02:00",
    ]) {
      const info = await getMessageLimitInfo(workspace, new Date(now));
      expect(info.messageCount).toBe(0);
      expect(info.contingent).toBe("0/600");
      expect(info.cycleInfo.cycleNumber).toBe(2);
    }
  });

  test("sommerzeit: Fenster beginnt und endet um 00:00 Uhr Berliner Zeit (AK-5)", () => {
    // 29.03.2026: Umstellung auf Sommerzeit, der Tag hat 23 Stunden.
    const spring = getBillingWindow(
      { cycleStartDate: "2026-03-29", cycleDurationMonths: 1 },
      new Date("2026-03-29T12:00:00+02:00")
    );
    expect(spring.start.toISOString()).toBe("2026-03-28T23:00:00.000Z"); // 00:00 MEZ
    expect(spring.endExclusive.toISOString()).toBe("2026-04-28T22:00:00.000Z"); // 00:00 MESZ
    expect(spring.startDay).toBe("2026-03-29");
    expect(spring.endDayExclusive).toBe("2026-04-29");

    // 25.10.2026: Umstellung auf Winterzeit, der Tag hat 25 Stunden.
    const autumn = getBillingWindow(
      { cycleStartDate: "2026-10-25", cycleDurationMonths: 1 },
      new Date("2026-10-25T12:00:00+01:00")
    );
    expect(autumn.start.toISOString()).toBe("2026-10-24T22:00:00.000Z"); // 00:00 MESZ
    expect(autumn.endExclusive.toISOString()).toBe("2026-11-24T23:00:00.000Z"); // 00:00 MEZ
    expect(autumn.startDay).toBe("2026-10-25");
    expect(autumn.endDayExclusive).toBe("2026-11-25");

    for (const window of [spring, autumn]) {
      expect(berlinWallClock(window.start)).toBe(`${window.startDay} 00:00:00`);
      expect(berlinWallClock(window.endExclusive)).toBe(
        `${window.endDayExclusive} 00:00:00`
      );
    }

    // Die Stunde, die es am Umstellungstag doppelt gibt, gehört zum selben Fenster.
    const workspace = { cycleStartDate: "2026-10-25", cycleDurationMonths: 1 };
    for (const instant of [
      "2026-10-25T00:30:00Z", // 02:30 MESZ
      "2026-10-25T01:30:00Z", // 02:30 MEZ
    ]) {
      expect(getBillingWindow(workspace, new Date(instant)).startDay).toBe(
        "2026-10-25"
      );
    }
    // Eine Sekunde vor Mitternacht läuft noch der Kalendermonat davor.
    expect(
      getBillingWindow(workspace, new Date("2026-10-24T21:59:59Z")).cycleNumber
    ).toBe(0);
  });

  test("kalendermonat: ohne cycleStartDate und vor dem Zyklusstart gilt der Berliner Kalendermonat (AK-6)", async () => {
    const now = new Date("2026-10-12T10:00:00+02:00");

    for (const workspace of [
      { id: WORKSPACE_ID, messagesLimit: 100 },
      { id: WORKSPACE_ID, messagesLimit: 100, cycleStartDate: null },
      {
        id: WORKSPACE_ID,
        messagesLimit: 100,
        cycleStartDate: "2026-12-01",
        cycleDurationMonths: 3,
      },
      {
        id: WORKSPACE_ID,
        messagesLimit: 100,
        cycleStartDate: new Date("2026-12-01"),
        cycleDurationMonths: 1,
      },
    ]) {
      const window = getBillingWindow(workspace, now);
      expect(window.start.toISOString()).toBe("2026-09-30T22:00:00.000Z"); // 01.10. 00:00 MESZ
      expect(window.endExclusive.toISOString()).toBe(
        "2026-10-31T23:00:00.000Z" // 01.11. 00:00 MEZ
      );
      expect(window.startDay).toBe("2026-10-01");
      expect(window.endDayExclusive).toBe("2026-11-01");
      expect(window.cycleNumber).toBe(0);
      expect(window.nextReset.toISOString()).toBe("2026-11-01T00:00:00.000Z");
      expect(window.daysRemaining).toBe(20);
    }

    // Mit dem gesetzten Limit wird im Kalendermonat gezählt; Zyklusangaben
    // gibt es erst, wenn der Zyklus läuft.
    addChat("2026-09-30T23:59:59+02:00");
    addChat("2026-10-01T00:00:00+02:00");
    addChat("2026-10-11T15:00:00+02:00", "embed_chats");
    const info = await getMessageLimitInfo(
      {
        id: WORKSPACE_ID,
        messagesLimit: 100,
        cycleStartDate: "2026-12-01",
        cycleDurationMonths: 3,
      },
      now
    );
    expect(info.messageCount).toBe(2);
    expect(info.messagesLimit).toBe(100);
    expect(info.cycleInfo).toBeNull();
  });

  test("kalendermonat: mit Vertragsbeginn startet der erste Zyklus bei 0", async () => {
    const workspace = {
      id: WORKSPACE_ID,
      messagesLimit: 100,
      cycleStartDate: "2026-12-01",
      cycleDurationMonths: 3,
    };
    addChat("2026-11-05T10:00:00+01:00");
    addChat("2026-11-30T23:59:59.999+01:00");

    const testPhase = await getMessageLimitInfo(
      workspace,
      new Date("2026-11-30T23:59:59.999+01:00")
    );
    expect(testPhase.messageCount).toBe(2);
    expect(testPhase.cycleInfo).toBeNull();

    const firstCycle = await getMessageLimitInfo(
      workspace,
      new Date("2026-12-01T00:00:00+01:00")
    );
    expect(firstCycle.messageCount).toBe(0);
    expect(firstCycle.cycleInfo.cycleNumber).toBe(1);
    expect(firstCycle.billingWindow.startDay).toBe("2026-12-01");
    expect(firstCycle.billingWindow.endDayExclusive).toBe("2027-03-01");
  });

  test("kalendermonat: beginnt der erste Zyklus mitten im Monat, endet das Monatsfenster am Starttag", () => {
    const workspace = { cycleStartDate: "2026-10-20", cycleDurationMonths: 3 };
    const before = getBillingWindow(
      workspace,
      new Date("2026-10-12T10:00:00+02:00")
    );
    expect(before.cycleNumber).toBe(0);
    expect(before.startDay).toBe("2026-10-01");
    expect(before.endDayExclusive).toBe("2026-10-20");
    expect(before.daysRemaining).toBe(8);

    const first = getBillingWindow(workspace, before.endExclusive);
    expect(first.cycleNumber).toBe(1);
    expect(first.start.getTime()).toBe(before.endExclusive.getTime());
  });

  test("kalendermonat: unbrauchbares cycleStartDate fällt auf den Kalendermonat zurück", () => {
    const now = new Date("2026-10-12T10:00:00+02:00");
    for (const cycleStartDate of ["kein Datum", "", undefined, NaN]) {
      const window = getBillingWindow({ cycleStartDate }, now);
      expect(window.cycleNumber).toBe(0);
      expect(window.startDay).toBe("2026-10-01");
    }
  });

  test("rechnerisch: extremes Startdatum wird ohne Hochzählen bestimmt (AK-11)", () => {
    const now = new Date("2026-10-12T10:00:00+02:00");
    const workspace = { cycleStartDate: "1900-01-31", cycleDurationMonths: 1 };

    const startedAt = process.hrtime.bigint();
    const window = getBillingWindow(workspace, now);
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

    expect(elapsedMs).toBeLessThan(5);
    // Januar 1900 ist Zyklus 1, September 2026 also 126 Jahre × 12 + 8 + 1.
    expect(window.cycleNumber).toBe(126 * 12 + 8 + 1);
    expect(window.startDay).toBe("2026-09-30");
    expect(window.endDayExclusive).toBe("2026-10-31");

    // Auch ein Start im Jahr 1 (rund 24.000 Monatszyklen) bleibt eine Rechnung.
    const ancientStartedAt = process.hrtime.bigint();
    const ancient = getBillingWindow(
      { cycleStartDate: "0001-01-01T12:00:00Z", cycleDurationMonths: 1 },
      now
    );
    expect(
      Number(process.hrtime.bigint() - ancientStartedAt) / 1e6
    ).toBeLessThan(5);
    expect(ancient.cycleNumber).toBe(2025 * 12 + 9 + 1);
    expect(ancient.startDay).toBe("2026-10-01");
  });

  test("cycleDurationMonths: unbrauchbare Werte zählen wie bisher als 1 Monat", () => {
    const now = new Date("2026-03-20T12:00:00+01:00");
    for (const cycleDurationMonths of [null, undefined, 0, -3, 1.5, "abc"]) {
      const window = getBillingWindow(
        { cycleStartDate: "2026-01-15", cycleDurationMonths },
        now
      );
      expect(window.startDay).toBe("2026-03-15");
      expect(window.endDayExclusive).toBe("2026-04-15");
      expect(window.cycleNumber).toBe(3);
    }
  });

  test("Starttag ist der Berliner Kalendertag von cycleStartDate, nicht der UTC-Tag", () => {
    // 14.01. 23:30 UTC ist in Berlin bereits der 15.01.
    const window = getBillingWindow(
      { cycleStartDate: "2026-01-14T23:30:00Z", cycleDurationMonths: 1 },
      new Date("2026-01-20T12:00:00+01:00")
    );
    expect(window.startDay).toBe("2026-01-15");
    expect(window.start.toISOString()).toBe("2026-01-14T23:00:00.000Z");
  });

  test("daysRemaining zählt Kalendertage bis zum Reset und ist am letzten Tag 1", () => {
    const workspace = { cycleStartDate: "2026-01-15", cycleDurationMonths: 3 };
    const cases = [
      ["2026-04-14T00:00:00+02:00", 1],
      ["2026-04-14T23:59:59+02:00", 1],
      ["2026-04-13T23:59:59+02:00", 2],
      ["2026-04-15T00:00:00+02:00", 91],
      ["2026-01-15T00:00:00+01:00", 90],
    ];
    for (const [now, expected] of cases) {
      expect(getBillingWindow(workspace, new Date(now)).daysRemaining).toBe(
        expected
      );
    }
  });
});

describe("Berliner Kalender-Hilfsfunktionen", () => {
  test("Zeitzone ist ausdrücklich Europe/Berlin", () => {
    expect(BILLING_TIME_ZONE).toBe("Europe/Berlin");
  });

  test("berlinDayOf: Berliner Kalendertag eines Zeitpunkts", () => {
    expect(berlinDayOf(new Date("2026-04-14T21:59:59.999Z"))).toBe(
      "2026-04-14"
    );
    expect(berlinDayOf(new Date("2026-04-14T22:00:00Z"))).toBe("2026-04-15");
    expect(berlinDayOf(new Date("2026-12-31T23:00:00Z"))).toBe("2027-01-01");
    expect(berlinDayOf("2026-01-15")).toBe("2026-01-15");
    expect(() => berlinDayOf("kein Datum")).toThrow();
  });

  test("berlinMidnight: Zeitpunkt von 00:00 Uhr Berliner Zeit an einem Kalendertag", () => {
    expect(berlinMidnight("2026-01-15").toISOString()).toBe(
      "2026-01-14T23:00:00.000Z"
    );
    expect(berlinMidnight("2026-07-15").toISOString()).toBe(
      "2026-07-14T22:00:00.000Z"
    );
    expect(berlinMidnight("2026-03-29").toISOString()).toBe(
      "2026-03-28T23:00:00.000Z"
    );
    expect(berlinMidnight("2026-03-30").toISOString()).toBe(
      "2026-03-29T22:00:00.000Z"
    );
    expect(berlinMidnight("2026-10-25").toISOString()).toBe(
      "2026-10-24T22:00:00.000Z"
    );
    expect(berlinMidnight("2026-10-26").toISOString()).toBe(
      "2026-10-25T23:00:00.000Z"
    );
    expect(() => berlinMidnight("15.01.2026")).toThrow();
  });

  test("berlinMidnight und berlinDayOf passen für jeden Tag über vier Jahre zusammen", () => {
    let day = new Date(Date.UTC(2024, 0, 1));
    const end = Date.UTC(2028, 0, 1);
    while (day.getTime() < end) {
      const isoDay = day.toISOString().slice(0, 10);
      const midnight = berlinMidnight(isoDay);
      expect(berlinWallClock(midnight)).toBe(`${isoDay} 00:00:00`);
      expect(berlinDayOf(midnight)).toBe(isoDay);
      expect(berlinDayOf(new Date(midnight.getTime() - 1))).not.toBe(isoDay);
      day = new Date(day.getTime() + 24 * 60 * 60 * 1000);
    }
  });
});
