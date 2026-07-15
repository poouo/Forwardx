import assert from "node:assert/strict";
import test from "node:test";
import { resolveForwardRuleVisualStatus } from "./forwardRuleStatus";

const now = Date.UTC(2026, 6, 16, 12, 0, 0);
const base = {
  ruleEnabled: true,
  groupEnabled: true,
  groupConfigStatus: "available" as const,
  runtimeStatus: "degraded",
  runningCount: 1,
  expectedCount: 3,
};

test("recent successful reachability overrides incomplete child status", () => {
  const result = resolveForwardRuleVisualStatus({
    ...base,
    latestLatencyMs: 88,
    latestLatencyIsTimeout: false,
    latestLatencyAt: now - 30_000,
  }, now);
  assert.equal(result.state, "running");
  assert.match(result.title, /88ms/);
});

test("partial child reports are pending rather than a hard failure", () => {
  const result = resolveForwardRuleVisualStatus(base, now);
  assert.equal(result.state, "pending");
  assert.match(result.title, /1 \/ 3/);
});

test("a recent timeout remains an explicit failure", () => {
  const result = resolveForwardRuleVisualStatus({
    ...base,
    runtimeStatus: "running",
    latestLatencyMs: null,
    latestLatencyIsTimeout: true,
    latestLatencyAt: now - 30_000,
  }, now);
  assert.equal(result.state, "error");
});

test("a timestamp without a latency value is not treated as reachable", () => {
  const result = resolveForwardRuleVisualStatus({
    ...base,
    runtimeStatus: "pending",
    latestLatencyMs: null,
    latestLatencyIsTimeout: false,
    latestLatencyAt: now - 30_000,
  }, now);
  assert.equal(result.state, "pending");
});

test("disabled rules remain disabled even with a successful probe", () => {
  const result = resolveForwardRuleVisualStatus({
    ...base,
    ruleEnabled: false,
    latestLatencyMs: 10,
    latestLatencyAt: now - 10_000,
  }, now);
  assert.equal(result.state, "disabled");
});

test("an available link alone does not claim that an unconfirmed rule is running", () => {
  const result = resolveForwardRuleVisualStatus({
    ruleEnabled: true,
    ruleRunning: false,
    groupEnabled: true,
    groupConfigStatus: "available",
  }, now);
  assert.equal(result.state, "pending");
});
