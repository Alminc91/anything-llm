/**
 * Cycle Helpers - Enterprise Billing Feature
 *
 * Provides flexible billing cycle functionality with:
 * - Custom start dates per workspace
 * - Configurable cycle durations (1, 2, 3, 4, 6, 12 months)
 * - Reset always on the original day of month (clamped to the month's length)
 * - Upgrade support (start date reset)
 *
 * Die Fenstergrenzen kommen ausschließlich aus getBillingWindow
 * (billingWindow.js, Berliner Zeit). Hier wird nichts mehr selbst gerechnet.
 */

const { countMessagesInDateRange } = require("./index");
const {
  getBillingWindow,
  berlinDayOf,
  dayToMarker,
} = require("./billingWindow");

/**
 * Adds months to a date with correct clamping.
 * Rechnet im UTC-Kalender (passend zu den Tagesmarken aus getCycleInfo) und
 * ist damit unabhängig von der Zeitzone des Prozesses.
 *
 * Nur vom Originalstart aus aufrufen, nie auf einem Ergebnis weiterrechnen:
 * Ein einmal geklemmter Tag (31. → 28.) bliebe sonst für immer geklemmt.
 *
 * @param {Date} date - Starting date
 * @param {number} months - Number of months to add (1, 2, 3, 4, 6, 12)
 * @returns {Date} - New date
 *
 * Examples:
 *   31.01 + 1 month = 28.02 (Feb has 28 days)
 *   31.01 + 2 months = 31.03 (Mar has 31)
 *   31.01 + 12 months = 31.01 (Exact!)
 */
function addMonths(date, months) {
  const inputDate = date instanceof Date ? date : new Date(date);
  const originalDay = inputDate.getUTCDate();
  const result = new Date(inputDate);
  result.setUTCMonth(result.getUTCMonth() + months);

  // If day overflowed (e.g., 31 → 3), correct to last day of target month
  if (result.getUTCDate() !== originalDay) {
    result.setUTCDate(0); // Last day of previous month
  }

  return result;
}

/**
 * Calculates all cycle information for a workspace.
 *
 * Die Datumsfelder sind Tagesmarken: 00:00 UTC des Berliner Kalendertags.
 * Ihr ISO-Datum nennt den richtigen Tag unabhängig von der Zeitzone des
 * Prozesses. Gezählt wird nicht mit ihnen, sondern mit den Zeitpunkten aus
 * getBillingWindow.
 *
 * Ohne cycleStartDate oder vor dem Starttag gilt der Kalendermonat; dann ist
 * cycleNumber 0.
 *
 * @param {Object} workspace - Workspace with cycleStartDate, cycleDurationMonths, messagesLimit
 * @param {Date|null} simulateDate - Optional: Simulated "today" for testing
 * @returns {Object} - Cycle information
 */
function getCycleInfo(workspace, simulateDate = null) {
  const now = simulateDate ? new Date(simulateDate) : new Date();
  const billingWindow = getBillingWindow(workspace, now);
  const startDate = workspace.cycleStartDate
    ? new Date(workspace.cycleStartDate)
    : null;
  const hasStartDate = !!startDate && !isNaN(startDate.getTime());

  return {
    cycleStartDate: workspace.cycleStartDate,
    cycleDurationMonths: workspace.cycleDurationMonths || 1,
    currentCycleStart: dayToMarker(billingWindow.startDay),
    // Letzter Tag des Zyklus = Tag vor dem nächsten Start
    currentCycleEnd: dayToMarker(billingWindow.endDayExclusive, -1),
    nextReset: billingWindow.nextReset,
    daysRemaining: billingWindow.daysRemaining,
    cycleNumber: billingWindow.cycleNumber,
    originalDay: hasStartDate ? Number(berlinDayOf(startDate).slice(-2)) : null,
    messagesLimit: workspace.messagesLimit,
  };
}

/**
 * Gets cycle info with message count for API responses.
 *
 * @param {Object} workspace - Workspace object
 * @param {Date|null} simulateDate - Optional: Simulated date for testing
 * @returns {Promise<Object>} - Cycle info with message count
 */
async function getCycleInfoWithMessageCount(workspace, simulateDate = null) {
  const cycleInfo = getCycleInfo(workspace, simulateDate);
  const countBreakdown = await countMessagesForCurrentCycle(
    workspace,
    simulateDate
  );
  const messageCount = countBreakdown.total;

  return {
    ...cycleInfo,
    messageCount,
    adjustmentsTotal: countBreakdown.adjustmentsTotal,
    messagesRemaining: workspace.messagesLimit
      ? Math.max(0, workspace.messagesLimit - messageCount)
      : null,
    contingent: `${messageCount}/${workspace.messagesLimit ?? "Unlimited"}`,
  };
}

/**
 * Counts messages in the current billing window: the active cycle, or the
 * calendar month when no cycle is set or it has not started yet.
 * Includes manual quota adjustments (see countMessagesInDateRange).
 *
 * @param {Object} workspace - Workspace object
 * @param {Date|null} simulateDate - Optional: Simulated date for testing
 * @returns {Promise<import("./index").MessageCountBreakdown>} - Message count breakdown
 */
async function countMessagesForCurrentCycle(workspace, simulateDate = null) {
  const now = simulateDate ? new Date(simulateDate) : new Date();
  const billingWindow = getBillingWindow(workspace, now);
  return await countMessagesInDateRange(
    workspace,
    billingWindow.start,
    billingWindow.endExclusive
  );
}

/**
 * Checks if a workspace has reached its message limit for the current cycle.
 *
 * @param {Object} workspace - Workspace object
 * @param {Date|null} simulateDate - Optional: Simulated date for testing
 * @returns {Promise<boolean>} - True if limit reached
 */
async function isCycleLimitReached(workspace, simulateDate = null) {
  if (!workspace.messagesLimit) {
    return false; // No limit set
  }

  const { total } = await countMessagesForCurrentCycle(workspace, simulateDate);
  return total >= workspace.messagesLimit;
}

/**
 * Formats the next reset date for display.
 *
 * @param {Object} workspace - Workspace object
 * @param {string} locale - Locale for formatting (default: 'de-DE')
 * @param {Date|null} simulateDate - Optional: Simulated date for testing
 * @returns {string} - Formatted date string
 */
function formatNextResetDate(workspace, locale = "de-DE", simulateDate = null) {
  // nextReset ist eine Tagesmarke (00:00 UTC), deshalb in UTC formatieren.
  // Ohne Zyklus liefert getCycleInfo den Beginn des nächsten Kalendermonats.
  return getCycleInfo(workspace, simulateDate).nextReset.toLocaleDateString(
    locale,
    {
      day: "numeric",
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    }
  );
}

/**
 * Validates cycle duration is a divisor of 12 (guarantees yearly consistency).
 *
 * @param {number} months - Proposed cycle duration
 * @returns {boolean} - True if valid
 */
function isValidCycleDuration(months) {
  const validDurations = [1, 2, 3, 4, 6, 12];
  return validDurations.includes(months);
}

/**
 * Gets available cycle duration options for UI.
 *
 * @returns {Array<Object>} - Array of {value, label} objects
 */
function getCycleDurationOptions() {
  return [
    { value: 1, label: "1 Monat" },
    { value: 2, label: "2 Monate" },
    { value: 3, label: "3 Monate (Quartal)" },
    { value: 4, label: "4 Monate" },
    { value: 6, label: "6 Monate (Halbjahr)" },
    { value: 12, label: "12 Monate (Jahr)" },
  ];
}

module.exports = {
  addMonths,
  getCycleInfo,
  getCycleInfoWithMessageCount,
  countMessagesForCurrentCycle,
  isCycleLimitReached,
  formatNextResetDate,
  isValidCycleDuration,
  getCycleDurationOptions,
};
