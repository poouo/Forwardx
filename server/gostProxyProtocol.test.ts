import assert from "node:assert/strict";
import test from "node:test";
import { effectiveTunnelProxyProtocolOptions, gostProxyProtocolMetadata, gostTunnelProxyProtocolPlan, resolveRuleProxyProtocolOptions } from "./gostProxyProtocol";

test("serializes GOST PROXY Protocol versions as metadata strings", () => {
  assert.deepEqual(gostProxyProtocolMetadata(1), { proxyProtocol: "1" });
  assert.deepEqual(gostProxyProtocolMetadata(2), { proxyProtocol: "2" });
  assert.deepEqual(gostProxyProtocolMetadata("2"), { proxyProtocol: "2" });

  const decoded = JSON.parse(JSON.stringify(gostProxyProtocolMetadata(2)));
  assert.equal(typeof decoded.proxyProtocol, "string");
  assert.equal(decoded.proxyProtocol, "2");
});

test("falls back to PROXY Protocol v1 for unsupported versions", () => {
  for (const version of [undefined, null, 0, 3, "invalid"]) {
    assert.deepEqual(gostProxyProtocolMetadata(version), { proxyProtocol: "1" });
  }
});

test("maps tunnel switches only to the end-to-end entry and exit layers", () => {
  assert.deepEqual(gostTunnelProxyProtocolPlan({
    entryReceive: true,
    entrySend: true,
    exitReceive: true,
    exitSend: true,
    version: 2,
  }), {
    entryListener: { proxyProtocol: "2" },
    entryHandler: { proxyProtocol: "2" },
    exitBridgeReceive: { proxyProtocol: "2" },
    exitBridgeSend: { proxyProtocol: "2" },
  });

  assert.deepEqual(gostTunnelProxyProtocolPlan({
    entryReceive: false,
    entrySend: true,
    exitReceive: true,
    exitSend: false,
    version: 1,
  }), {
    entryListener: undefined,
    entryHandler: { proxyProtocol: "1" },
    exitBridgeReceive: { proxyProtocol: "1" },
    exitBridgeSend: undefined,
  });
});

test("preserves the entry source across the local exit bridge", () => {
  assert.deepEqual(effectiveTunnelProxyProtocolOptions({
    entryReceive: false,
    entrySend: true,
    exitReceive: false,
    exitSend: true,
    version: 2,
  }), {
    entryReceive: false,
    entrySend: true,
    exitReceive: true,
    exitSend: true,
    version: 2,
  });
  assert.deepEqual(gostTunnelProxyProtocolPlan({
    entryReceive: false,
    entrySend: true,
    exitReceive: false,
    exitSend: true,
    version: 1,
  }), {
    entryListener: undefined,
    entryHandler: { proxyProtocol: "1" },
    exitBridgeReceive: { proxyProtocol: "1" },
    exitBridgeSend: { proxyProtocol: "1" },
  });
});

test("uses tunnel PROXY Protocol settings over a stale tunnel-rule snapshot", () => {
  const rule = {
    id: 4,
    tunnelId: 5,
    protocol: "both",
    proxyProtocolReceive: false,
    proxyProtocolSend: false,
    proxyProtocolExitReceive: false,
    proxyProtocolExitSend: false,
    proxyProtocolVersion: 1,
  };
  const tunnel = {
    id: 5,
    mode: "tls",
    proxyProtocolReceive: false,
    proxyProtocolSend: true,
    proxyProtocolExitReceive: true,
    proxyProtocolExitSend: true,
    proxyProtocolVersion: 2,
  };

  assert.deepEqual(resolveRuleProxyProtocolOptions(rule, tunnel), {
    proxyProtocolReceive: false,
    proxyProtocolSend: true,
    proxyProtocolExitReceive: true,
    proxyProtocolExitSend: true,
    proxyProtocolVersion: 2,
  });
});

test("keeps direct rule settings and disables PROXY Protocol for unsupported tunnel paths", () => {
  assert.deepEqual(resolveRuleProxyProtocolOptions({
    protocol: "tcp",
    proxyProtocolReceive: true,
    proxyProtocolSend: true,
    proxyProtocolVersion: 2,
  }), {
    proxyProtocolReceive: true,
    proxyProtocolSend: true,
    proxyProtocolExitReceive: false,
    proxyProtocolExitSend: false,
    proxyProtocolVersion: 2,
  });

  assert.deepEqual(resolveRuleProxyProtocolOptions({ protocol: "udp", tunnelId: 8 }, {
    id: 8,
    mode: "tls",
    proxyProtocolSend: true,
    proxyProtocolExitSend: true,
    proxyProtocolVersion: 2,
  }), {
    proxyProtocolReceive: false,
    proxyProtocolSend: false,
    proxyProtocolExitReceive: false,
    proxyProtocolExitSend: false,
    proxyProtocolVersion: 1,
  });
});
