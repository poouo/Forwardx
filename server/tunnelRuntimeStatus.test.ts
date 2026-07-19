import assert from "node:assert/strict";
import test from "node:test";
import {
  clearTunnelRuntimeStatus,
  clearTunnelRuntimeStatusForHost,
  getTunnelRuntimeTopologyStatus,
  recordTunnelRuntimeHostStatus,
} from "./tunnelRuntimeStatus";

test("runtime topology distinguishes chain and relay failover", () => {
  const tunnelId = 91;
  clearTunnelRuntimeStatus(tunnelId);
  recordTunnelRuntimeHostStatus(tunnelId, 1, true);
  recordTunnelRuntimeHostStatus(tunnelId, 2, true);
  recordTunnelRuntimeHostStatus(tunnelId, 3, false);
  recordTunnelRuntimeHostStatus(tunnelId, 4, true);
  const topology = { hopHostIds: [1, 2, 3, 4], primaryExitHostId: 4 };
  assert.equal(getTunnelRuntimeTopologyStatus(tunnelId, { ...topology, relayMode: "chain" }).running, false);
  assert.equal(getTunnelRuntimeTopologyStatus(tunnelId, { ...topology, relayMode: "failover" }).running, true);
});

test("runtime topology accepts a healthy extra exit and clears offline hosts", () => {
  const tunnelId = 92;
  clearTunnelRuntimeStatus(tunnelId);
  recordTunnelRuntimeHostStatus(tunnelId, 10, false);
  recordTunnelRuntimeHostStatus(tunnelId, 11, true);
  const status = getTunnelRuntimeTopologyStatus(tunnelId, {
    primaryExitHostId: 10,
    extraExitHostIds: [11],
    loadBalanceEnabled: true,
    loadBalanceStrategy: "fallback",
  });
  assert.equal(status.running, true);
  assert.deepEqual(clearTunnelRuntimeStatusForHost(11), [tunnelId]);
  assert.equal(getTunnelRuntimeTopologyStatus(tunnelId, {
    primaryExitHostId: 10,
    extraExitHostIds: [11],
    loadBalanceEnabled: true,
    loadBalanceStrategy: "fallback",
  }).running, false);
});
