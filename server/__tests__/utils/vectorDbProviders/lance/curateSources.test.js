/* eslint-env jest, node */
const { LanceDb } = require("../../../../utils/vectorDbProviders/lance");

test("curateSources wandelt BigInt (start_minutes) in Number — JSON-serialisierbar", () => {
  const out = new LanceDb().curateSources([
    { text: "Yoga", vector: [1, 2], _distance: 0.1, title: "Yoga", start_minutes: 1080n, price: 45.5 },
  ]);
  expect(out[0]).toEqual({ title: "Yoga", start_minutes: 1080, price: 45.5, text: "Yoga" });
  expect(() => JSON.stringify(out)).not.toThrow();
});
