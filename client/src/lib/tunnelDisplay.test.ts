import assert from "node:assert/strict";
import test from "node:test";
import { getTunnelExitNames, getTunnelRouteText } from "./tunnelDisplay";

const hosts = [
  { id: 1, name: "广州 01" },
  { id: 2, name: "香港 07" },
  { id: 3, name: "香港 23" },
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

test("does not append an exit summary to single-exit tunnels", () => {
  const tunnel = {
    entryHostId: 1,
    exitHostId: 2,
    hopHostIds: [1, 2],
    loadBalanceExits: [],
  };

  assert.equal(getTunnelRouteText(tunnel, hosts), "广州 01 -> 香港 07");
});
