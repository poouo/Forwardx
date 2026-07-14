import assert from "node:assert/strict";
import test from "node:test";
import { gostProxyProtocolMetadata, gostTunnelProxyProtocolPlan } from "./gostProxyProtocol";

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
