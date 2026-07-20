import assert from "node:assert/strict";
import test from "node:test";
import {
  clearRuleQuotaReservationsForTest,
  reserveRuleCreateQuota,
} from "./ruleQuotaReservations";

test("concurrent rule quota reservations cannot overrun the same user limit", async () => {
  clearRuleQuotaReservationsForTest();
  const input = {
    userId: 7,
    maxRules: 2,
    maxPorts: 0,
    getRuleCount: async () => 1,
    getPortCount: async () => 0,
  };
  const results = await Promise.allSettled([
    reserveRuleCreateQuota(input),
    reserveRuleCreateQuota(input),
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), ["fulfilled", "rejected"]);
  const reservation = results.find((result) => result.status === "fulfilled");
  if (reservation?.status === "fulfilled") await reservation.value.release();
});

test("failed creates release their pending quota for retry", async () => {
  clearRuleQuotaReservationsForTest();
  const input = {
    userId: 8,
    maxRules: 1,
    maxPorts: 1,
    getRuleCount: async () => 0,
    getPortCount: async () => 0,
  };
  const first = await reserveRuleCreateQuota(input);
  await assert.rejects(() => reserveRuleCreateQuota(input), /最大规则数量限制/);
  await first.release();
  const retry = await reserveRuleCreateQuota(input);
  await retry.release();
});
