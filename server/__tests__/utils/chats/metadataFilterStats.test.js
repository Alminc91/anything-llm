/* eslint-env jest, node */
const {
  recordFilterRun,
  filterRunSummary,
  _resetForTests,
} = require("../../../utils/chats/metadataFilterStats");

beforeEach(() => _resetForTests());

test("zählt Anfragen, Median, Zeitüberschreitungen und Fehler der letzten 24 h", () => {
  [100, 200, 300, 400].forEach((ms) => recordFilterRun("llm", ms));
  recordFilterRun("llm-error", 3000, "normalizer timeout 3000ms");
  recordFilterRun("llm-error", 50, "kein JSON");
  recordFilterRun("error", 5, "settings kaputt");
  const s = filterRunSummary();
  expect(s.count).toBe(7);
  expect(s.timeouts).toBe(1);
  expect(s.errors).toBe(2);
  expect(s.medianMs).toBe(200);
});

test("Einträge älter als 24 h zählen nicht", () => {
  recordFilterRun("llm", 100);
  const s = filterRunSummary(Date.now() + 25 * 60 * 60 * 1000);
  expect(s.count).toBe(0);
  expect(s.medianMs).toBeNull();
});
