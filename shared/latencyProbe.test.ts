import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  isRuleLatencyReportMethodCompatible,
  linkProbeMethodForProtocol,
  ruleLatencyProbeMethodForProtocol,
} from "./latencyProbe";
import { normalizeAgentProbeCounts } from "./agentDtos";
import { buildRuleAgentSelfTestPayload, buildMetaAgentSelfTestPayload } from "../server/agentRouteUtils";

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

test("direct Realm UDP and entry-group self-tests dispatch ICMP even with a TCP-looking target port", () => {
  const rule = { id: 1, hostId: 1, forwardType: "realm", protocol: "udp", sourcePort: 10002, targetIp: "hy2.example.test", targetPort: 30817 };
  const payload = buildRuleAgentSelfTestPayload({ id: 20, ruleId: 1 }, rule);
  assert.equal(payload.method, "ping");
  assert.equal(payload.protocol, "ping");
  const entry = buildMetaAgentSelfTestPayload({ id: 21, ruleId: 1 }, {
    kind: "forward-group", groupId: 2, memberId: 3, runtimeRuleId: 4,
    forwardType: "realm", sourcePort: 10002, targetIp: rule.targetIp, targetPort: rule.targetPort, method: "ping",
  });
  assert.ok(entry && "method" in entry);
  assert.equal(entry.method, "ping");
  assert.equal(entry?.protocol, "ping");
});

test("rule self-test dialog identifies ICMP and exposes real failure details", () => {
  const source = readFileSync("client/src/pages/Rules.tsx", "utf8");
  const dialog = source.slice(source.indexOf("function SelfTestDialog("));
  assert.match(dialog, /probeMethod === "ping"/);
  assert.match(dialog, /UDP 规则使用 ICMP Ping 探测目标主机，不检测 UDP 端口或 HY2 握手。/);
  assert.match(dialog, /!isTesting && !isSuccess && parsedMessage\.message/);
  assert.match(dialog, /role="status"[^>]*>\{parsedMessage\.message\}/);
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
