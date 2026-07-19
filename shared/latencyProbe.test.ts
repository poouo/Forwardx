import assert from "node:assert/strict";
import test from "node:test";
import {
  isRuleLatencyReportMethodCompatible,
  linkProbeMethodForProtocol,
  ruleLatencyProbeMethodForProtocol,
} from "./latencyProbe";

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
