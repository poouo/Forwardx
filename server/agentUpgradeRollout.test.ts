import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_UPGRADE_WAVE_INTERVAL_MS,
  AGENT_UPGRADE_WAVE_SIZE,
  planAgentUpgradeWaves,
} from "./agentUpgradeRollout";

test("agent upgrades are split into persistent rolling waves", () => {
  const now = Date.UTC(2026, 6, 23, 10, 0, 0);
  const hosts = Array.from({ length: 12 }, (_, index) => index + 1);
  const rollout = planAgentUpgradeWaves(hosts, now);

  assert.deepEqual(rollout.map((item) => item.wave), [0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 2, 2]);
  assert.deepEqual(
    rollout.map((item) => item.delayMs),
    [0, 0, 0, 0, 0, 15_000, 15_000, 15_000, 15_000, 15_000, 30_000, 30_000],
  );
  assert.equal(rollout[AGENT_UPGRADE_WAVE_SIZE].requestedAt.getTime(), now + AGENT_UPGRADE_WAVE_INTERVAL_MS);
});

test("agent upgrade wave settings are bounded", () => {
  const rollout = planAgentUpgradeWaves([1, 2, 3], 1_000, 0, 10);
  assert.deepEqual(rollout.map((item) => item.delayMs), [0, 1_000, 2_000]);
});
