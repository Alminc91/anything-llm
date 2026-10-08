/* eslint-env jest, node */
const { SystemSettings } = require("../../models/systemSettings");

describe("course_selection-Validator", () => {
  const v = SystemSettings.validations.course_selection;
  test.each([
    ["on", "on"],
    ["off", "off"],
    ["OFF", "off"],
    [false, "off"],
    ["0", "off"],
    ["aus", "off"],
    ["ON", "on"],
    [true, "on"],
    ["an", "on"],
    [null, "on"],
    ["", "on"],
    ["quatsch", "on"],
  ])("%p → %p", (input, out) => expect(v(input)).toBe(out));

  test("Standard ist an", () =>
    expect(SystemSettings.courseSelectionDefault).toBe("on"));

  test("als unterstütztes und öffentliches Setting registriert", () => {
    expect(SystemSettings.supportedFields).toContain("course_selection");
    expect(SystemSettings.publicFields).toContain("course_selection");
  });
});
