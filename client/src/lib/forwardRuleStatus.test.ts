import assert from "node:assert/strict";
import test from "node:test";
import { LINK_PROBE_FRESH_MS } from "@shared/linkProbePolicy";
import {
  preferLastKnownForwardRuleVisualStatus,
  resolveForwardRuleVisualStatus,
} from "./forwardRuleStatus";

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

test("revoked resource access overrides cached running and probe state", () => {
  const result = resolveForwardRuleVisualStatus({
    ...base,
    ruleRunning: true,
    resourceAccessAllowed: false,
    runtimeStatus: "running",
    latestLatencyMs: 10,
    latestLatencyIsTimeout: false,
    latestLatencyAt: now - 10_000,
  }, now);
  assert.deepEqual(result, { state: "error", title: "资源授权失效" });
});

test("revoked resource access remains explicit after the rule is stopped", () => {
  const result = resolveForwardRuleVisualStatus({
    ...base,
    ruleEnabled: false,
    resourceAccessAllowed: false,
  }, now);
  assert.deepEqual(result, { state: "error", title: "资源授权失效" });
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

test("a probe remains authoritative through the five minute report boundary", () => {
  const result = resolveForwardRuleVisualStatus({
    ...base,
    latestLatencyMs: 41,
    latestLatencyIsTimeout: false,
    latestLatencyAt: now - 5 * 60_000 - 10_000,
  }, now);
  assert.equal(result.state, "running");
});

test("a probe older than the shared freshness window falls back to runtime state", () => {
  const result = resolveForwardRuleVisualStatus({
    ...base,
    latestLatencyMs: 41,
    latestLatencyIsTimeout: false,
    latestLatencyAt: now - LINK_PROBE_FRESH_MS - 1,
  }, now);
  assert.equal(result.state, "pending");
});

test("an explicitly unavailable group overrides an older successful probe", () => {
  const result = resolveForwardRuleVisualStatus({
    ...base,
    groupConfigStatus: "unavailable",
    latestLatencyMs: 41,
    latestLatencyIsTimeout: false,
    latestLatencyAt: now - 30_000,
  }, now);
  assert.equal(result.state, "error");
});

test("a successful probe remains visible while group data is still loading", () => {
  const result = resolveForwardRuleVisualStatus({
    ...base,
    groupConfigStatus: "pending",
    runtimeStatus: "pending",
    latestLatencyMs: 41,
    latestLatencyIsTimeout: false,
    latestLatencyAt: now - 30_000,
  }, now);
  assert.equal(result.state, "running");
});

test("an explicitly disabled runtime overrides an older successful probe", () => {
  const result = resolveForwardRuleVisualStatus({
    ...base,
    runtimeStatus: "disabled",
    latestLatencyMs: null,
    latestLatencyIsTimeout: true,
    latestLatencyAt: now - 30_000,
  }, now);
  assert.equal(result.state, "disabled");
});

test("a recent timeout overrides the direct rule running flag", () => {
  const result = resolveForwardRuleVisualStatus({
    ruleEnabled: true,
    ruleRunning: true,
    groupEnabled: true,
    groupConfigStatus: "available",
    latestLatencyMs: null,
    latestLatencyIsTimeout: true,
    latestLatencyAt: now - 30_000,
  }, now);
  assert.equal(result.state, "error");
});

test("last confirmed state is used while a new status is pending", () => {
  const result = preferLastKnownForwardRuleVisualStatus(
    { state: "pending", title: "等待 Agent 上报运行状态" },
    { state: "running", title: "Agent 已确认规则运行" },
  );
  assert.equal(result.state, "running");
  assert.match(result.title, /上次状态/);
});

test("an explicit current result is never replaced by the cache", () => {
  const cases = [
    {
      current: { state: "error" as const, title: "转发资源配置不可用" },
      cached: { state: "running" as const, title: "旧状态" },
    },
    {
      current: { state: "disabled" as const, title: "规则已停用" },
      cached: { state: "running" as const, title: "旧状态" },
    },
    {
      current: { state: "running" as const, title: "Agent 已确认规则运行" },
      cached: { state: "error" as const, title: "旧故障" },
    },
  ];
  for (const { current, cached } of cases) {
    assert.deepEqual(preferLastKnownForwardRuleVisualStatus(current, cached), current);
  }
});
