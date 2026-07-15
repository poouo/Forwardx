import assert from "node:assert/strict";
import test from "node:test";
import { summarizeTunnelBranches } from "./agentReportRoutes";
import { recordForwardGroupAutoHopLatency } from "./forwardGroupAutoLatencyState";
import { recordTunnelAutoHopLatency } from "./tunnelAutoLatencyState";

test("multi-exit tunnel stays available when at least one exit succeeds", () => {
  const summary = summarizeTunnelBranches([
    { latencyMs: 35, isTimeout: false },
    { latencyMs: null, isTimeout: true },
  ]);
  assert.deepEqual(summary, { unavailable: false, partial: true, latencyMs: 35 });
});

test("multi-exit tunnel is unavailable only when every exit fails", () => {
  const summary = summarizeTunnelBranches([
    { latencyMs: null, isTimeout: true },
    { latencyMs: 0, isTimeout: true },
  ]);
  assert.deepEqual(summary, { unavailable: true, partial: false, latencyMs: null });
});

test("tunnel hop aggregation never mixes topology generations", () => {
  assert.equal(recordTunnelAutoHopLatency({
    tunnelId: 91001,
    hopIndex: 0,
    hopCount: 2,
    latencyMs: 10,
    isTimeout: false,
    generation: "old",
  }), null);
  assert.equal(recordTunnelAutoHopLatency({
    tunnelId: 91001,
    hopIndex: 1,
    hopCount: 2,
    latencyMs: 20,
    isTimeout: false,
    generation: "new",
  }), null);
  assert.deepEqual(recordTunnelAutoHopLatency({
    tunnelId: 91001,
    hopIndex: 0,
    hopCount: 2,
    latencyMs: 12,
    isTimeout: false,
    generation: "new",
  }), { success: true, latencyMs: 32 });
});

test("forward-chain hop aggregation never mixes topology generations", () => {
  assert.equal(recordForwardGroupAutoHopLatency({
    groupId: 92001,
    hopIndex: 0,
    hopCount: 2,
    latencyMs: 8,
    isTimeout: false,
    generation: "old",
  }), null);
  assert.equal(recordForwardGroupAutoHopLatency({
    groupId: 92001,
    hopIndex: 1,
    hopCount: 2,
    latencyMs: 16,
    isTimeout: false,
    generation: "new",
  }), null);
  assert.deepEqual(recordForwardGroupAutoHopLatency({
    groupId: 92001,
    hopIndex: 0,
    hopCount: 2,
    latencyMs: 9,
    isTimeout: false,
    generation: "new",
  }), { success: true, latencyMs: 25 });
});
