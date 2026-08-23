import assert from "node:assert/strict";
import test from "node:test";
import { billingCalendarParts } from "../shared/billingTime";
import { nextHostBillingExpiry } from "./repositories/hostRepository";

test("host billing cycle advances calendar months and clamps the billing day", () => {
  const next = nextHostBillingExpiry(new Date("2026-01-31T00:00:00.000Z"), 1, 1, 31);
  assert.deepEqual(billingCalendarParts(next), {
    year: 2026,
    month: 2,
    day: 28,
    hour: 8,
    minute: 0,
    second: 0,
  });
});
test("annual host billing cycle honours the configured billing month", () => {
  const next = nextHostBillingExpiry(new Date("2026-06-18T00:00:00.000Z"), 12, 1, 15);
  assert.deepEqual(billingCalendarParts(next), {
    year: 2027,
    month: 1,
    day: 15,
    hour: 8,
    minute: 0,
    second: 0,
  });
});
