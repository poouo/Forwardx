import assert from "node:assert/strict";
import test from "node:test";
import {
  isRuleLatencyReportMethodCompatible,
  linkProbeMethodForProtocol,
  ruleLatencyProbeMethodForProtocol,
} from "./latencyProbe";
import { normalizeAgentProbeCounts } from "./agentDtos";

test("UDP-only rules use ping while TCP-capable rules use TCPing", () => {
  assert.equal(linkProbeMethodForProtocol("udp"), "ping");
  assert.equal(ruleLatencyProbeMethodForProtocol("udp"), "ping");
  assert.equal(ruleLatencyProbeMethodForProtocol("tcp"), "tcping");
  assert.equal(ruleLatencyProbeMethodForProtocol("both"), "tcping");
});

test("UDP rules reject legacy or TCPing reports", () => {
  assert.equal(isRuleLatencyReportMethodCompatible("udp", "ping"), true);
  assert.equal(isRuleLatencyReportMethodCompatible("udp", "tcping"), false);
  assert.equal(isRuleLatencyReportMethodCompatible("udp", undefined), false);
  assert.equal(isRuleLatencyReportMethodCompatible("tcp", "tcping"), true);
  assert.equal(isRuleLatencyReportMethodCompatible("tcp", undefined), true);
});

test("probe count normalization distinguishes legacy rows from explicit zero-success reports", () => {
  assert.deepEqual(normalizeAgentProbeCounts({ isTimeout: false }), {
    probeCount: 1,
    probeSuccesses: 1,
  });
  assert.deepEqual(normalizeAgentProbeCounts({
    isTimeout: false,
    probeCount: 5,
    probeSuccesses: 0,
  }, { legacyZeroAsSuccess: false }), {
    probeCount: 5,
    probeSuccesses: 0,
  });
  assert.deepEqual(normalizeAgentProbeCounts({
    isTimeout: false,
    probeCount: 5,
    probeSuccesses: 0,
  }), {
    probeCount: 5,
    probeSuccesses: 5,
  });
});
