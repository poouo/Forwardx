import assert from "node:assert/strict";
import test from "node:test";
import { forwardGroupProbeTopologyKey, tunnelProbeTopologyKey } from "./probeTopology";

test("tunnel probe topology ignores runtime timestamps and status", () => {
  const base = {
    id: 1,
    isEnabled: true,
    mode: "forwardx",
    entryHostId: 10,
    exitHostId: 20,
    listenPort: 3000,
    updatedAt: new Date(1),
    isRunning: false,
  };
  const first = tunnelProbeTopologyKey(base);
  const second = tunnelProbeTopologyKey({ ...base, updatedAt: new Date(999999), isRunning: true, lastLatencyMs: 20 });
  assert.equal(first, second);
  assert.notEqual(first, tunnelProbeTopologyKey({ ...base, listenPort: 3001 }));
});

test("tunnel probe topology follows the active exit strategy", () => {
  const base = {
    id: 2,
    isEnabled: true,
    mode: "forwardx",
    entryHostId: 10,
    exitHostId: 20,
    listenPort: 3000,
    loadBalanceEnabled: true,
  };
  const exitNodes = [{ id: 1, hostId: 21, listenPort: 3001, isEnabled: true }];
  const disabled = tunnelProbeTopologyKey({ ...base, loadBalanceStrategy: "none" }, [], exitNodes);
  assert.equal(
    disabled,
    tunnelProbeTopologyKey({ ...base, loadBalanceStrategy: "none" }, [], [{ ...exitNodes[0], listenPort: 3999 }]),
  );
  assert.notEqual(
    disabled,
    tunnelProbeTopologyKey({ ...base, loadBalanceStrategy: "round_robin" }, [], exitNodes),
  );
});

test("forward-chain topology is stable across probe ordering and changes with a target", () => {
  const probes = [
    { fromHostId: 1, hopIndex: 0, hopCount: 2, targetIp: "a.example", targetPort: 1000, method: "tcp" },
    { fromHostId: 2, hopIndex: 1, hopCount: 2, targetIp: "b.example", targetPort: 1000, method: "tcp" },
  ];
  const first = forwardGroupProbeTopologyKey(9, probes);
  assert.equal(first, forwardGroupProbeTopologyKey(9, [...probes].reverse()));
  assert.notEqual(first, forwardGroupProbeTopologyKey(9, [{ ...probes[0], targetPort: 1001 }, probes[1]]));
});
