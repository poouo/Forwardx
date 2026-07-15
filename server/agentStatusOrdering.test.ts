import assert from "node:assert/strict";
import test from "node:test";
import { AgentStatusOrderGuard, normalizeAgentStatusIssuedAt } from "./agentStatusOrdering";

test("Agent status ordering accepts equal/new epochs and rejects older results", () => {
  const guard = new AgentStatusOrderGuard();
  const now = 2_000_000;
  assert.equal(guard.accept("host:1:rule:7", 100, now), true);
  assert.equal(guard.accept("host:1:rule:7", 200, now), true);
  assert.equal(guard.accept("host:1:rule:7", 100, now), false);
  assert.equal(guard.accept("host:1:rule:7", 200, now), true);
  assert.equal(guard.accept("host:2:rule:7", 100, now), true);
});

test("Agent status ordering rejects an old ACK after a newer action is dispatched", () => {
  const guard = new AgentStatusOrderGuard();
  const now = 2_000_000;
  guard.expect("host:1:rule:9", 300, now);
  assert.equal(guard.accept("host:1:rule:9", 200, now), false);
  assert.equal(guard.accept("host:1:rule:9", 300, now), true);
});

test("Agent status ordering keeps legacy and invalid timestamps compatible", () => {
  const guard = new AgentStatusOrderGuard();
  const now = 2_000_000;
  assert.equal(guard.accept("host:1:rule:8", undefined, now), true);
  assert.equal(guard.accept("host:1:rule:8", 100, now), true);
  assert.equal(guard.accept("host:1:rule:8", now + 10 * 60 * 1000, now), true);
  assert.equal(normalizeAgentStatusIssuedAt(now + 10 * 60 * 1000, now), 0);
});
