import assert from "node:assert/strict";
import test from "node:test";
import {
  isTunnelRelayFailover,
  normalizeTunnelRelayMode,
  tunnelRelayCandidates,
  tunnelRelayFailoverSupported,
} from "../shared/tunnelRelay";

test("tunnel relay mode defaults to the existing chain behavior", () => {
  assert.equal(normalizeTunnelRelayMode(null), "chain");
  assert.equal(normalizeTunnelRelayMode("unknown"), "chain");
  assert.equal(normalizeTunnelRelayMode("failover"), "failover");
});

test("relay failover requires a supported runtime and at least two relay candidates", () => {
  const hops = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }];
  assert.deepEqual(tunnelRelayCandidates(hops), [{ id: 2 }, { id: 3 }]);
  assert.equal(tunnelRelayFailoverSupported("forwardx"), true);
  assert.equal(tunnelRelayFailoverSupported("tls"), true);
  assert.equal(tunnelRelayFailoverSupported("nginx_stream"), false);
  assert.equal(isTunnelRelayFailover({ relayMode: "failover", mode: "forwardx" }, hops), true);
  assert.equal(isTunnelRelayFailover({ relayMode: "failover", mode: "forwardx" }, hops.slice(0, 3)), false);
  assert.equal(isTunnelRelayFailover({ relayMode: "failover", mode: "nginx_stream" }, hops), false);
});
