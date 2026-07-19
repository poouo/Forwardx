import assert from "node:assert/strict";
import test from "node:test";
import { getTunnelExitNames, getTunnelRouteText } from "./tunnelDisplay";

const hosts = [
  { id: 1, name: "广州 01" },
  { id: 2, name: "香港 07" },
  { id: 3, name: "香港 23" },
  { id: 4, name: "东京 09" },
];

test("keeps multi-exit names in the route without a redundant mode label", () => {
  const tunnel = {
    entryHostId: 1,
    exitHostId: 2,
    hopHostIds: [1, 2],
    loadBalanceExits: [{ hostId: 3 }],
  };

  assert.deepEqual(getTunnelExitNames(tunnel, hosts), ["香港 07", "香港 23"]);
  assert.equal(getTunnelRouteText(tunnel, hosts), "广州 01 -> 香港 07；出口：香港 07 / 香港 23");
  assert.equal(getTunnelRouteText(tunnel, hosts).includes("多出口"), false);
});

test("uses the exit group name as the route endpoint and keeps member names in the exit summary", () => {
  const tunnel = {
    entryHostId: 1,
    exitHostId: 2,
    hopHostIds: [1, 2],
    loadBalanceExits: [{ hostId: 3 }],
  };

  assert.equal(
    getTunnelRouteText(tunnel, hosts, "18.02"),
    "\u5E7F\u5DDE 01 -> 18.02\uFF1B\u51FA\u53E3\uFF1A\u9999\u6E2F 07 / \u9999\u6E2F 23",
  );
});

test("does not append an exit summary to single-exit tunnels", () => {
  const tunnel = {
    entryHostId: 1,
    exitHostId: 2,
    hopHostIds: [1, 2],
    loadBalanceExits: [],
  };

  assert.equal(getTunnelRouteText(tunnel, hosts), "广州 01 -> 香港 07");
});

test("does not display unused backup exits for the none strategy", () => {
  const tunnel = {
    entryHostId: 1,
    exitHostId: 2,
    hopHostIds: [1, 2],
    loadBalanceStrategy: "none",
    loadBalanceExits: [{ hostId: 3 }],
  };

  assert.deepEqual(getTunnelExitNames(tunnel, hosts), ["香港 07"]);
  assert.equal(getTunnelRouteText(tunnel, hosts, "18.02"), "广州 01 -> 18.02；出口：香港 07");
});

test("renders relay failover candidates as alternatives instead of a serial chain", () => {
  const tunnel = {
    entryHostId: 1,
    exitHostId: 4,
    hopHostIds: [1, 2, 3, 4],
    relayMode: "failover",
    loadBalanceExits: [],
  };

  assert.equal(getTunnelRouteText(tunnel, hosts), "广州 01 -> 中转：香港 07 / 香港 23 -> 东京 09");
});
