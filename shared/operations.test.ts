import assert from "node:assert/strict";
import test from "node:test";
import { operationsDay, operationsDate, operationsRange, chinaProvince } from "./operations";

test("operations calendar days use Beijing time and reject invalid/out-of-retention ranges", () => {
  const now = Date.parse("2026-10-16T17:00:00Z") / 1000;
  assert.equal(operationsDate(now), "2026-10-17");
  assert.equal(operationsDay(now), Date.parse("2026-10-16T16:00:00Z") / 1000);
  assert.deepEqual(operationsRange("2026-10-17", "2026-10-17", now), { start: operationsDay(now), end: operationsDay(now) + 86400 });
  assert.equal(operationsRange("2026-09-18", "2026-10-17", now).end - operationsRange("2026-09-18", "2026-10-17", now).start, 30 * 86400);
  for (const [from, to] of [["2026-02-31", "2026-10-17"], ["2026-09-17", "2026-10-17"], ["2026-10-17", "2026-10-18"], ["2026-10-17", "2026-10-16"]]) assert.throws(() => operationsRange(from, to, now));
});
test("province normalization does not confuse Shanxi with Shaanxi or infer China from foreign regions", () => {
  assert.equal(chinaProvince("CN", "Shaanxi"), "陕西");
  assert.equal(chinaProvince("CN", "Shanxi"), "山西");
  assert.equal(chinaProvince("CN", "Guangdong Province"), "广东");
  assert.equal(chinaProvince("CN", "内蒙古自治区"), "内蒙古");
  assert.equal(chinaProvince("HK", ""), "香港");
  assert.equal(chinaProvince("US", "Guangdong"), null);
  assert.equal(chinaProvince("CN", "unrecognized"), null);
});
