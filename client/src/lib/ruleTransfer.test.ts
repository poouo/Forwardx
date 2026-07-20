import assert from "node:assert/strict";
import test from "node:test";
import {
  RULE_TRANSFER_FILE_KIND,
  RULE_TRANSFER_FILE_VERSION,
  findRuleTransferPortConflict,
  parseRuleTransferFile,
  type RuleTransferFileRule,
} from "./ruleTransfer";

function validRule(overrides: Partial<RuleTransferFileRule> = {}) {
  return {
    name: "test",
    forwardType: "gost",
    protocol: "tcp",
    sourcePort: 10001,
    targetIp: "example.com",
    targetPort: 443,
    isEnabled: true,
    telegramErrorNotifyEnabled: false,
    proxyProtocolReceive: false,
    proxyProtocolSend: false,
    proxyProtocolExitReceive: false,
    proxyProtocolExitSend: false,
    proxyProtocolVersion: 1,
    tcpFastOpen: false,
    zeroCopy: false,
    udpOverTcp: false,
    udpOverTcpPort: 0,
    failoverEnabled: false,
    failoverStrategy: "fallback",
    failoverTargets: [],
    failoverSeconds: 60,
    recoverSeconds: 120,
    autoFailback: true,
    ...overrides,
  } satisfies RuleTransferFileRule;
}

function transferFile(rule: unknown) {
  return {
    kind: RULE_TRANSFER_FILE_KIND,
    version: RULE_TRANSFER_FILE_VERSION,
    rules: [rule],
  };
}

test("rule transfer parser preserves a valid exported rule", () => {
  const rule = validRule({ protocol: "both", failoverEnabled: true, isEnabled: false });
  const parsed = parseRuleTransferFile(transferFile(rule));
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.ok ? parsed.file.rules : [], [rule]);
});

test("rule transfer parser rejects coercible booleans and unknown enums", () => {
  const stringBoolean = parseRuleTransferFile(transferFile({ ...validRule(), tcpFastOpen: "false" }));
  assert.equal(stringBoolean.ok, false);
  assert.match(stringBoolean.ok ? "" : stringBoolean.error, /tcpFastOpen/);

  const unknownProtocol = parseRuleTransferFile(transferFile({ ...validRule(), protocol: "quic" }));
  assert.equal(unknownProtocol.ok, false);
  assert.match(unknownProtocol.ok ? "" : unknownProtocol.error, /protocol/);

  const unknownForwardType = parseRuleTransferFile(transferFile({ ...validRule(), forwardType: "unknown" }));
  assert.equal(unknownForwardType.ok, false);
  assert.match(unknownForwardType.ok ? "" : unknownForwardType.error, /forwardType/);
});

test("rule transfer parser enforces server-side timing and target constraints", () => {
  const shortFailover = parseRuleTransferFile(transferFile({ ...validRule(), failoverSeconds: 1 }));
  assert.equal(shortFailover.ok, false);
  assert.match(shortFailover.ok ? "" : shortFailover.error, /failoverSeconds/);

  const badTarget = parseRuleTransferFile(transferFile({ ...validRule(), targetIp: "bad host" }));
  assert.equal(badTarget.ok, false);
  assert.match(badTarget.ok ? "" : badTarget.error, /targetIp/);
});

test("rule transfer parser enforces the import count limit", () => {
  const parsed = parseRuleTransferFile({
    kind: RULE_TRANSFER_FILE_KIND,
    version: RULE_TRANSFER_FILE_VERSION,
    rules: Array.from({ length: 501 }, () => validRule()),
  });
  assert.equal(parsed.ok, false);
  assert.match(parsed.ok ? "" : parsed.error, /500/);
});

test("rule transfer conflict detection follows TCP and UDP listener overlap", () => {
  assert.deepEqual(
    findRuleTransferPortConflict([validRule(), validRule({ protocol: "both" })]),
    { port: 10001, firstIndex: 0, secondIndex: 1 },
  );
  assert.equal(
    findRuleTransferPortConflict([validRule({ protocol: "tcp" }), validRule({ protocol: "udp" })]),
    null,
  );
  assert.equal(
    findRuleTransferPortConflict([validRule({ sourcePort: 0 }), validRule({ sourcePort: 0 })]),
    null,
  );
});
