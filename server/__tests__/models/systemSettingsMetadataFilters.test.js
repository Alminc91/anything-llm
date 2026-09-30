/* eslint-env jest, node */
const { SystemSettings } = require("../../models/systemSettings");

describe("metadata_filters-Validator", () => {
  const v = SystemSettings.validations.metadata_filters;
  test.each([
    ["on", "on"], ["off", "off"], ["OFF", "off"], ["Off", "off"], [false, "off"],
    ["false", "off"], ["0", "off"], ["aus", "off"], ["ON", "on"], [true, "on"],
    [null, "on"], ["", "on"], ["quatsch", "on"],
  ])("%p → %p", (input, out) => expect(v(input)).toBe(out));
  test("Standard ist an", () => expect(SystemSettings.metadataFiltersDefault).toBe("on"));
});
