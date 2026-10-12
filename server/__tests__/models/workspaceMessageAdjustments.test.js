/* eslint-env jest, node */
const prisma = require("../../utils/prisma");
const {
  WorkspaceMessageAdjustments,
} = require("../../models/workspaceMessageAdjustments");
const { getBillingWindow } = require("../../utils/helpers/billingWindow");

jest.mock("../../utils/prisma", () => ({
  workspace_message_adjustments: {
    create: jest.fn(),
    aggregate: jest.fn(),
    findMany: jest.fn(),
    count: jest.fn(),
  },
}));

describe("WorkspaceMessageAdjustments.new - validation", () => {
  beforeEach(() => jest.clearAllMocks());

  test("rejects non-integer amounts", async () => {
    for (const amount of [1.5, "10", NaN, Infinity, null, undefined]) {
      const { adjustment, message } = await WorkspaceMessageAdjustments.new({
        workspaceId: 1,
        amount,
      });
      expect(adjustment).toBeNull();
      expect(message).toMatch(/integer/);
    }
    expect(prisma.workspace_message_adjustments.create).not.toHaveBeenCalled();
  });

  test("rejects amount of 0", async () => {
    const { adjustment, message } = await WorkspaceMessageAdjustments.new({
      workspaceId: 1,
      amount: 0,
    });
    expect(adjustment).toBeNull();
    expect(message).toMatch(/non-zero/);
  });

  test("rejects amounts beyond the sanity cap in both directions", async () => {
    for (const amount of [1_000_001, -1_000_001]) {
      const { adjustment, message } = await WorkspaceMessageAdjustments.new({
        workspaceId: 1,
        amount,
      });
      expect(adjustment).toBeNull();
      expect(message).toMatch(/between/);
    }
  });

  test("accepts amounts exactly at the cap", async () => {
    prisma.workspace_message_adjustments.create.mockResolvedValue({
      id: 1,
      workspaceId: 1,
      amount: 1_000_000,
      reason: null,
      createdAt: new Date(),
    });
    const { adjustment, message } = await WorkspaceMessageAdjustments.new({
      workspaceId: 1,
      amount: 1_000_000,
    });
    expect(message).toBeNull();
    expect(adjustment).not.toBeNull();
  });

  test("rejects non-string reasons and over-long reasons", async () => {
    const nonString = await WorkspaceMessageAdjustments.new({
      workspaceId: 1,
      amount: 10,
      reason: { note: "x" },
    });
    expect(nonString.adjustment).toBeNull();
    expect(nonString.message).toMatch(/string/);

    const tooLong = await WorkspaceMessageAdjustments.new({
      workspaceId: 1,
      amount: 10,
      reason: "x".repeat(501),
    });
    expect(tooLong.adjustment).toBeNull();
    expect(tooLong.message).toMatch(/500/);
  });

  test("creates a deduction with coerced workspaceId and null reason fallback", async () => {
    prisma.workspace_message_adjustments.create.mockResolvedValue({
      id: 7,
      workspaceId: 3,
      amount: 250,
      reason: null,
      createdAt: new Date(),
    });
    const { adjustment } = await WorkspaceMessageAdjustments.new({
      workspaceId: "3",
      amount: 250,
      reason: "",
    });
    expect(adjustment.id).toBe(7);
    expect(prisma.workspace_message_adjustments.create).toHaveBeenCalledWith({
      data: { workspaceId: 3, amount: 250, reason: null },
    });
  });

  test("negative amounts (credits) are accepted", async () => {
    prisma.workspace_message_adjustments.create.mockResolvedValue({
      id: 8,
      workspaceId: 3,
      amount: -50,
      reason: "Storno",
      createdAt: new Date(),
    });
    const { adjustment, message } = await WorkspaceMessageAdjustments.new({
      workspaceId: 3,
      amount: -50,
      reason: "Storno",
    });
    expect(message).toBeNull();
    expect(adjustment.amount).toBe(-50);
  });

  test("returns error message instead of throwing on DB failure", async () => {
    prisma.workspace_message_adjustments.create.mockRejectedValue(
      new Error("db locked")
    );
    const { adjustment, message } = await WorkspaceMessageAdjustments.new({
      workspaceId: 1,
      amount: 10,
    });
    expect(adjustment).toBeNull();
    expect(message).toBe("db locked");
  });
});

describe("WorkspaceMessageAdjustments.sumAmount / sumForWorkspaceInDateRange", () => {
  beforeEach(() => jest.clearAllMocks());

  test("coalesces empty result set (null sum) to 0", async () => {
    prisma.workspace_message_adjustments.aggregate.mockResolvedValue({
      _sum: { amount: null },
    });
    expect(await WorkspaceMessageAdjustments.sumAmount({})).toBe(0);
  });

  test("returns the aggregated sum", async () => {
    prisma.workspace_message_adjustments.aggregate.mockResolvedValue({
      _sum: { amount: 230 },
    });
    expect(
      await WorkspaceMessageAdjustments.sumForWorkspaceInDateRange(
        5,
        new Date("2026-06-01"),
        new Date("2026-06-30")
      )
    ).toBe(230);
    expect(prisma.workspace_message_adjustments.aggregate).toHaveBeenCalledWith(
      {
        _sum: { amount: true },
        where: {
          workspaceId: 5,
          createdAt: {
            gte: new Date("2026-06-01"),
            lt: new Date("2026-06-30"),
          },
        },
      }
    );
  });

  test("degrades gracefully to 0 on DB failure (missing table must never break chats)", async () => {
    prisma.workspace_message_adjustments.aggregate.mockRejectedValue(
      new Error("no such table: workspace_message_adjustments")
    );
    expect(
      await WorkspaceMessageAdjustments.sumForWorkspaceInDateRange(
        5,
        new Date(),
        new Date()
      )
    ).toBe(0);
  });

  // KIE-534: strict counting for the agent session's limit check
  test("throwOnError passes a DB failure on instead of counting 0", async () => {
    prisma.workspace_message_adjustments.aggregate.mockRejectedValue(
      new Error("SQLITE_BUSY: database is locked")
    );
    await expect(
      WorkspaceMessageAdjustments.sumForWorkspaceInDateRange(
        5,
        new Date(),
        new Date(),
        { throwOnError: true }
      )
    ).rejects.toThrow("SQLITE_BUSY");
    await expect(
      WorkspaceMessageAdjustments.sumAmount({}, { throwOnError: true })
    ).rejects.toThrow("SQLITE_BUSY");
  });

  test("throwOnError still degrades to 0 when the table is missing (no table, no bookings)", async () => {
    prisma.workspace_message_adjustments.aggregate.mockRejectedValue(
      Object.assign(
        new Error(
          "The table `main.workspace_message_adjustments` does not exist in the current database."
        ),
        { code: "P2021" }
      )
    );
    expect(
      await WorkspaceMessageAdjustments.sumForWorkspaceInDateRange(
        5,
        new Date(),
        new Date(),
        { throwOnError: true }
      )
    ).toBe(0);
  });

  test("throwOnError does not change the sum when the query succeeds", async () => {
    prisma.workspace_message_adjustments.aggregate.mockResolvedValue({
      _sum: { amount: 12 },
    });
    expect(
      await WorkspaceMessageAdjustments.sumAmount({}, { throwOnError: true })
    ).toBe(12);
  });
});

describe("WorkspaceMessageAdjustments.sumForWorkspaceInDateRange - Abrechnungsfenster (KIE-531)", () => {
  const workspace = {
    id: 5,
    cycleStartDate: "2026-01-15",
    cycleDurationMonths: 3,
  };
  let bookings;

  // aggregate wertet die Klausel wie die Datenbank aus, damit die Grenzen des
  // Modells geprüft werden und nicht nur der Aufruf.
  beforeEach(() => {
    jest.clearAllMocks();
    bookings = [];
    prisma.workspace_message_adjustments.aggregate.mockImplementation(
      async ({ where }) => {
        const { gte, gt, lt, lte } = where.createdAt ?? {};
        const matching = bookings.filter(
          (row) =>
            row.workspaceId === where.workspaceId &&
            (gte === undefined || row.createdAt >= gte) &&
            (gt === undefined || row.createdAt > gt) &&
            (lt === undefined || row.createdAt < lt) &&
            (lte === undefined || row.createdAt <= lte)
        );
        // Wie SQL: SUM über keine Zeile ist NULL
        const amount = matching.length
          ? matching.reduce((sum, row) => sum + row.amount, 0)
          : null;
        return { _sum: { amount } };
      }
    );
  });

  function book(iso, amount) {
    bookings.push({ workspaceId: 5, createdAt: new Date(iso), amount });
  }

  async function sumIn(window) {
    return await WorkspaceMessageAdjustments.sumForWorkspaceInDateRange(
      workspace.id,
      window.start,
      window.endExclusive
    );
  }

  test("fenster: Abbuchung am 15.04. um 00:30 Berliner Zeit zählt im zweiten Zyklus, nicht im ersten (AK-7)", async () => {
    book("2026-04-15T00:30:00+02:00", 10);

    const first = getBillingWindow(
      workspace,
      new Date("2026-04-14T23:59:59.999+02:00")
    );
    const second = getBillingWindow(
      workspace,
      new Date("2026-04-15T00:00:00+02:00")
    );
    expect(first.cycleNumber).toBe(1);
    expect(second.cycleNumber).toBe(2);

    expect(await sumIn(first)).toBe(0);
    expect(await sumIn(second)).toBe(10);
  });

  test("fenster: jede Buchung um den Zykluswechsel zählt in genau einem Fenster, Vorzeichen bleiben", async () => {
    book("2026-04-14T23:59:59.999+02:00", 7); // letzter Augenblick des ersten Zyklus
    book("2026-04-15T00:00:00+02:00", 100); // erster Augenblick des zweiten
    book("2026-04-15T01:59:00+02:00", -30); // Gutschrift in der bisherigen Lücke
    book("2026-07-14T23:59:59.999+02:00", 5); // letzter Augenblick des zweiten
    book("2026-07-15T00:00:00+02:00", 1000); // gehört schon zum dritten

    const first = getBillingWindow(
      workspace,
      new Date("2026-03-01T12:00:00+01:00")
    );
    const second = getBillingWindow(
      workspace,
      new Date("2026-06-01T12:00:00+02:00")
    );
    const third = getBillingWindow(
      workspace,
      new Date("2026-08-01T12:00:00+02:00")
    );

    expect(await sumIn(first)).toBe(7);
    expect(await sumIn(second)).toBe(75);
    expect(await sumIn(third)).toBe(1000);
  });

  test("fenster: Klausel ist halboffen (gte Start, lt nächster Start)", async () => {
    const window = getBillingWindow(
      workspace,
      new Date("2026-06-01T12:00:00+02:00")
    );
    await sumIn(window);
    expect(prisma.workspace_message_adjustments.aggregate).toHaveBeenCalledWith(
      {
        _sum: { amount: true },
        where: {
          workspaceId: 5,
          createdAt: {
            gte: new Date("2026-04-14T22:00:00.000Z"),
            lt: new Date("2026-07-14T22:00:00.000Z"),
          },
        },
      }
    );
  });
});

describe("WorkspaceMessageAdjustments.where / count", () => {
  beforeEach(() => jest.clearAllMocks());

  test("lists newest first with pagination", async () => {
    prisma.workspace_message_adjustments.findMany.mockResolvedValue([]);
    await WorkspaceMessageAdjustments.where({ workspaceId: 1 }, 100, 20);
    expect(prisma.workspace_message_adjustments.findMany).toHaveBeenCalledWith({
      where: { workspaceId: 1 },
      take: 100,
      skip: 20,
      orderBy: { createdAt: "desc" },
    });
  });

  test("returns [] / 0 on DB failure", async () => {
    prisma.workspace_message_adjustments.findMany.mockRejectedValue(
      new Error("boom")
    );
    prisma.workspace_message_adjustments.count.mockRejectedValue(
      new Error("boom")
    );
    expect(await WorkspaceMessageAdjustments.where({})).toEqual([]);
    expect(await WorkspaceMessageAdjustments.count({})).toBe(0);
  });
});
