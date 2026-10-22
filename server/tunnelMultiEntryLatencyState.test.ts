import assert from "node:assert/strict";
import test from "node:test";
import { clearTunnelMultiEntryLatencyState, getTunnelMultiEntryHopDetails, getTunnelMultiEntryLatency, recordTunnelMultiEntryLatency } from "./tunnelMultiEntryLatencyState";
import { tunnelMultiEntryProbeMessage } from "./tunnelMultiEntryProbeMessage";
import { AgentTcpingReportGate } from "./agentTcpingReportGate";

test("live multi-entry diagrams replace missing entries as asynchronous reports arrive", () => {
  const base = { tunnelId: 95001, expectedEntryHostIds: [11, 12], hopCount: 2, generation: "live-v1" };
  recordTunnelMultiEntryLatency({ ...base, sourceHostId: 12, toHostId: 20, hopIndex: 0, latencyMs: 6, isTimeout: false });
  recordTunnelMultiEntryLatency({ ...base, sourceHostId: 20, toHostId: 30, hopIndex: 1, latencyMs: 1, isTimeout: false });
  const partial = tunnelMultiEntryProbeMessage({ ...base, totalLatencyMs: 7 });
  assert.deepEqual(partial?.missingEntryHostIds, [11]);
  const partialMessage = JSON.parse(partial!.message);
  assert.equal(partialMessage.totalLatencyMs, 7);
  assert.deepEqual(partialMessage.details.map((detail: any) => [detail.fromHostId, detail.toHostId]), [[11, 20], [12, 20], [20, 30]]);
  assert.equal(partialMessage.details[0].message, "等待探测结果");
  assert.equal(partialMessage.details[0].pending, true);
  assert.equal(partialMessage.details[0].isTimeout, false, "absent reports are not fabricated network timeouts");
  // A later report must replace the old diagram, not leave it waiting forever.
  recordTunnelMultiEntryLatency({ ...base, sourceHostId: 11, toHostId: 20, hopIndex: 0, latencyMs: 9, isTimeout: false });
  const complete = tunnelMultiEntryProbeMessage({ ...base, totalLatencyMs: 10 });
  assert.deepEqual(complete?.missingEntryHostIds, []);
  const completeMessage = JSON.parse(complete!.message);
  assert.equal(completeMessage.details[0].latencyMs, 9);
  assert.equal(completeMessage.totalLatencyMs, 10);
  assert.equal(completeMessage.details.length, 3, "do not duplicate the shared downstream hop");
  assert.equal(tunnelMultiEntryProbeMessage({ ...base, generation: "changed-topology", totalLatencyMs: 10 }), null);
});

test("live multi-entry diagrams keep direct exit branches isolated and report failures", () => {
  const base = { tunnelId: 95002, expectedEntryHostIds: [11, 12], hopCount: 1, generation: "live-v1" };
  for (const [pathKey, toHostId] of [["primary", 20], ["exit-2", 30]] as const) {
    recordTunnelMultiEntryLatency({ ...base, pathKey, sourceHostId: 11, toHostId, hopIndex: 0, latencyMs: null, isTimeout: true });
    recordTunnelMultiEntryLatency({ ...base, pathKey, sourceHostId: 12, toHostId, hopIndex: 0, latencyMs: 6, isTimeout: false });
  }
  const snapshot = tunnelMultiEntryProbeMessage({ ...base, pathKey: "exit-2", totalLatencyMs: 6 });
  assert.deepEqual(snapshot?.missingEntryHostIds, []);
  const message = JSON.parse(snapshot!.message);
  assert.deepEqual(message.details.map((detail: any) => detail.toHostId), [30, 30]);
  assert.equal(message.details[0].success, false);
  assert.equal(message.details[0].message, "隧道跳探测超时");
});

test("multi-entry direct probe stays available when one entry succeeds", () => {
  const base = {
    tunnelId: 93001,
    expectedEntryHostIds: [10, 11],
    hopIndex: 0,
    hopCount: 1,
    generation: "direct-v1",
  };
  assert.equal(recordTunnelMultiEntryLatency({
    ...base,
    sourceHostId: 10,
    sourceLabel: "entry-a",
    latencyMs: null,
    isTimeout: true,
  }), null, "one failed source must not fail the tunnel before another source reports");
  assert.deepEqual(recordTunnelMultiEntryLatency({
    ...base,
    sourceHostId: 11,
    sourceLabel: "entry-b",
    latencyMs: 28,
    isTimeout: false,
  }), {
    success: true,
    partial: true,
    latencyMs: 28,
    details: [
      { hostId: 10, label: "entry-a", latencyMs: null, isTimeout: true },
      { hostId: 11, label: "entry-b", latencyMs: 28, isTimeout: false },
    ],
  });
});

test("multi-entry multi-hop probe combines each entry with shared hops", () => {
  const base = {
    tunnelId: 93002,
    expectedEntryHostIds: [20, 21],
    hopCount: 2,
    generation: "hops-v1",
  };
  assert.equal(recordTunnelMultiEntryLatency({
    ...base,
    sourceHostId: 20,
    sourceLabel: "entry-a",
    hopIndex: 0,
    latencyMs: 12,
    isTimeout: false,
  }), null);
  assert.equal(recordTunnelMultiEntryLatency({
    ...base,
    sourceHostId: 21,
    sourceLabel: "entry-b",
    hopIndex: 0,
    latencyMs: 18,
    isTimeout: false,
  }), null);
  assert.deepEqual(recordTunnelMultiEntryLatency({
    ...base,
    sourceHostId: 30,
    hopIndex: 1,
    latencyMs: 25,
    isTimeout: false,
  }), {
    success: true,
    partial: false,
    latencyMs: 43,
    details: [
      { hostId: 20, label: "entry-a", latencyMs: 37, isTimeout: false },
      { hostId: 21, label: "entry-b", latencyMs: 43, isTimeout: false },
    ],
  });
});

test("multi-entry probe state never mixes topology generations", () => {
  const base = {
    tunnelId: 93003,
    expectedEntryHostIds: [40, 41],
    hopIndex: 0,
    hopCount: 1,
  };
  assert.deepEqual(recordTunnelMultiEntryLatency({
    ...base,
    sourceHostId: 40,
    latencyMs: 10,
    isTimeout: false,
    generation: "old",
  })?.latencyMs, 10);
  assert.equal(recordTunnelMultiEntryLatency({
    ...base,
    sourceHostId: 41,
    latencyMs: null,
    isTimeout: true,
    generation: "new",
  }), null);
});

test("multi-entry relay candidates retain independent aggregates", () => {
  const base = {
    tunnelId: 93004,
    expectedEntryHostIds: [50, 51],
    hopCount: 2,
    generation: "relay-v1",
  };
  for (const pathKey of ["relay-1", "relay-2"]) {
    recordTunnelMultiEntryLatency({
      ...base,
      pathKey,
      sourceHostId: 50,
      hopIndex: 0,
      latencyMs: pathKey === "relay-1" ? 10 : null,
      isTimeout: pathKey !== "relay-1",
    });
    recordTunnelMultiEntryLatency({
      ...base,
      pathKey,
      sourceHostId: 51,
      hopIndex: 0,
      latencyMs: null,
      isTimeout: true,
    });
    recordTunnelMultiEntryLatency({
      ...base,
      pathKey,
      sourceHostId: pathKey === "relay-1" ? 60 : 61,
      hopIndex: 1,
      latencyMs: 20,
      isTimeout: false,
    });
  }

  assert.deepEqual(getTunnelMultiEntryLatency({ ...base, pathKey: "relay-1" }), {
    success: true,
    partial: true,
    latencyMs: 30,
    details: [
      { hostId: 50, label: "入口 50", latencyMs: 30, isTimeout: false },
      { hostId: 51, label: "入口 51", latencyMs: null, isTimeout: true },
    ],
  });
  assert.equal(getTunnelMultiEntryLatency({ ...base, pathKey: "relay-2" })?.success, false);
});

test("multi-entry aggregate retains partial counters for the available entry", () => {
  const base = {
    tunnelId: 93008,
    expectedEntryHostIds: [10, 11],
    hopIndex: 0,
    hopCount: 1,
    generation: "partial-direct-v1",
  };
  assert.deepEqual(recordTunnelMultiEntryLatency({
    ...base,
    sourceHostId: 10,
    sourceLabel: "entry-a",
    latencyMs: 24,
    isTimeout: false,
    probeCount: 5,
    probeSuccesses: 4,
  }), {
    success: true,
    partial: true,
    latencyMs: 24,
    details: [
      { hostId: 10, label: "entry-a", latencyMs: 24, isTimeout: false, probeCount: 5, probeSuccesses: 4 },
    ],
    probeCount: 5,
    probeSuccesses: 4,
  });
  assert.deepEqual(recordTunnelMultiEntryLatency({
    ...base,
    sourceHostId: 11,
    sourceLabel: "entry-b",
    latencyMs: null,
    isTimeout: true,
    probeCount: 5,
    probeSuccesses: 0,
  }), {
    success: true,
    partial: true,
    latencyMs: 24,
    details: [
      { hostId: 10, label: "entry-a", latencyMs: 24, isTimeout: false, probeCount: 5, probeSuccesses: 4 },
      { hostId: 11, label: "entry-b", latencyMs: null, isTimeout: true, probeCount: 5, probeSuccesses: 0 },
    ],
    probeCount: 5,
    probeSuccesses: 4,
  });
});

test("multi-entry aggregation preserves partial packet loss on an entry path", () => {
  const base = {
    tunnelId: 93010,
    expectedEntryHostIds: [10, 11],
    hopIndex: 0,
    hopCount: 1,
    generation: "partial-entry-v1",
  };
  const first = recordTunnelMultiEntryLatency({
    ...base,
    sourceHostId: 10,
    sourceLabel: "entry-a",
    latencyMs: 20,
    isTimeout: false,
    probeCount: 3,
    probeSuccesses: 2,
  });
  assert.equal(first?.success, true);
  assert.equal(first?.probeSuccesses, 2);
  const aggregate = recordTunnelMultiEntryLatency({
    ...base,
    sourceHostId: 11,
    sourceLabel: "entry-b",
    latencyMs: 24,
    isTimeout: false,
    probeCount: 3,
    probeSuccesses: 3,
  });
  assert.equal(aggregate?.success, true);
  assert.equal(aggregate?.probeCount, 3);
  assert.equal(aggregate?.probeSuccesses, 3);
  assert.equal(aggregate?.details.find((detail) => detail.hostId === 10)?.probeSuccesses, 2);
});

test("multi-entry state exposes entry and shared hop samples for the rule test", () => {
  const base = {
    tunnelId: 94003,
    expectedEntryHostIds: [60, 61],
    hopCount: 2,
    generation: "details-v1",
  };
  recordTunnelMultiEntryLatency({
    ...base,
    sourceHostId: 60,
    sourceLabel: "entry-a",
    hopIndex: 0,
    toHostId: 70,
    latencyMs: 9,
    isTimeout: false,
  });
  recordTunnelMultiEntryLatency({
    ...base,
    sourceHostId: 61,
    sourceLabel: "entry-b",
    hopIndex: 0,
    toHostId: 70,
    latencyMs: 13,
    isTimeout: false,
  });
  recordTunnelMultiEntryLatency({
    ...base,
    sourceHostId: 70,
    hopIndex: 1,
    toHostId: 80,
    latencyMs: 24,
    isTimeout: false,
  });

  const details = getTunnelMultiEntryHopDetails(base);
  assert.ok(details);
  assert.deepEqual(details.map(({ recordedAt: _recordedAt, ...detail }) => detail), [
    { hopIndex: 0, hopCount: 2, fromHostId: 60, toHostId: 70, latencyMs: 9, isTimeout: false },
    { hopIndex: 0, hopCount: 2, fromHostId: 61, toHostId: 70, latencyMs: 13, isTimeout: false },
    { hopIndex: 1, hopCount: 2, fromHostId: 70, toHostId: 80, latencyMs: 24, isTimeout: false },
  ]);
  const newestRecordedAt = Math.max(...details.map((detail) => detail.recordedAt));
  assert.equal(getTunnelMultiEntryHopDetails({
    ...base,
    referenceAt: newestRecordedAt + 6 * 60_000 + 1,
  }), null);
});

test("staggered steady tunnel snapshots survive delivery jitter without losing an entry", (t) => {
  let now = Date.parse("2026-10-22T00:00:00Z");
  t.mock.method(Date, "now", () => now);
  const start = now;
  const base = { tunnelId: 96001, expectedEntryHostIds: [11, 12], hopCount: 2, generation: "steady" };
  const gate = new AgentTcpingReportGate();
  const report = (hostId: number, hopIndex: number, latencyMs: number, force = false) => {
    const wire = { tunnelId: base.tunnelId, hopIndex, hopCount: 2, topologyKey: "steady", latencyMs, isTimeout: false };
    const plan = gate.plan({ hostId, tunnels: [wire], results: [], forwardGroups: [], services: [], force });
    assert.equal(plan.tunnels.length, 1);
    recordTunnelMultiEntryLatency({ ...base, sourceHostId: hostId, hopIndex, latencyMs, isTimeout: false });
    plan.commit();
  };
  report(11, 0, 6);
  report(12, 0, 8);
  report(20, 1, 1);
  now = start + 1_000;
  report(12, 0, 8, true);
  for (let minute = 1; minute <= 6; minute++) {
    now = start + minute * 60_000;
    report(11, 0, 6);
    report(20, 1, 1);
    // Drop one full report and delay the following one by five seconds.
    if (minute !== 5) {
      now += 5_000;
      report(12, 0, 8);
    }
  }
  const snapshot = tunnelMultiEntryProbeMessage({ ...base, totalLatencyMs: 9 });
  assert.deepEqual(snapshot?.missingEntryHostIds, []);
  assert.equal(getTunnelMultiEntryLatency(base)?.latencyMs, 9);
});

test("asynchronous details keep each valid hop rather than discarding the entire diagram", (t) => {
  let now = Date.parse("2026-10-22T01:00:00Z");
  t.mock.method(Date, "now", () => now);
  const base = { tunnelId: 96002, expectedEntryHostIds: [11, 12], hopCount: 2, generation: "async" };
  const start = now;
  recordTunnelMultiEntryLatency({ ...base, sourceHostId: 11, hopIndex: 0, latencyMs: 6, isTimeout: false });
  now += 40_000;
  recordTunnelMultiEntryLatency({ ...base, sourceHostId: 12, hopIndex: 0, latencyMs: 8, isTimeout: false });
  now += 260_000;
  recordTunnelMultiEntryLatency({ ...base, sourceHostId: 20, hopIndex: 1, latencyMs: 1, isTimeout: false });
  assert.equal(getTunnelMultiEntryHopDetails({ ...base, referenceAt: now })?.length, 3,
    "independent Agents are not a synchronized 30-second probe batch");
  const limited = getTunnelMultiEntryHopDetails({ ...base, referenceAt: now, maxAgeMs: 270_000 });
  assert.deepEqual(limited?.map(detail => detail.fromHostId), [12, 20]);
  now = start + 360_001;
  assert.deepEqual(getTunnelMultiEntryHopDetails(base)?.map(detail => detail.fromHostId), [12, 20],
    "an actually expired entry is removed, but other samples remain");
  now = start + 700_000;
  assert.equal(getTunnelMultiEntryHopDetails(base), null);
});

test("restarted/topology-reset state warms up without hiding actual failures", (t) => {
  let now = Date.parse("2026-10-22T02:00:00Z");
  t.mock.method(Date, "now", () => now);
  const base = { tunnelId: 96003, expectedEntryHostIds: [11, 12], hopCount: 1, generation: "before" };
  const record = (hostId: number, generation = base.generation, isTimeout = false) =>
    recordTunnelMultiEntryLatency({ ...base, generation, sourceHostId: hostId, hopIndex: 0,
      latencyMs: isTimeout ? null : 8, isTimeout });
  record(11); record(12);
  clearTunnelMultiEntryLatencyState(base.tunnelId);
  record(11, "after", true);
  const input = { ...base, generation: "after", totalLatencyMs: null };
  let snapshot = tunnelMultiEntryProbeMessage(input)!;
  let details = JSON.parse(snapshot.message).details;
  assert.equal(snapshot.warmingUp, true);
  assert.equal(details[0].message, "隧道跳探测超时");
  assert.equal(details[0].pending, false);
  assert.equal(details[1].pending, true);
  now += 120_001;
  snapshot = tunnelMultiEntryProbeMessage(input)!;
  details = JSON.parse(snapshot.message).details;
  assert.equal(snapshot.warmingUp, false);
  assert.equal(details[1].message, "未收到探测结果");
  assert.equal(details[1].isTimeout, false);
  record(12, "after");
  assert.deepEqual(tunnelMultiEntryProbeMessage(input)?.missingEntryHostIds, []);
  record(11, "changed");
  assert.equal(tunnelMultiEntryProbeMessage({ ...input, generation: "after" }), null);
  assert.deepEqual(tunnelMultiEntryProbeMessage({ ...input, generation: "changed" })?.missingEntryHostIds, [12]);
});

test("multi-entry details do not turn an entry that has not reported into a timeout", () => {
  const base = {
    tunnelId: 94005,
    expectedEntryHostIds: [60, 61],
    hopCount: 1,
    generation: "partial-details-v1",
  };
  recordTunnelMultiEntryLatency({
    ...base,
    sourceHostId: 60,
    sourceLabel: "entry-a",
    hopIndex: 0,
    toHostId: 70,
    latencyMs: 9,
    isTimeout: false,
  });

  const details = getTunnelMultiEntryHopDetails(base);
  assert.ok(details);
  assert.deepEqual(details.map(({ recordedAt: _recordedAt, ...detail }) => detail), [
    { hopIndex: 0, hopCount: 1, fromHostId: 60, toHostId: 70, latencyMs: 9, isTimeout: false },
  ]);
});

test("multi-entry details read only the requested relay branch", () => {
  const base = {
    tunnelId: 94007,
    expectedEntryHostIds: [80, 81],
    hopCount: 1,
    generation: "relay-details-v1",
  };
  for (const [pathKey, toHostId, latencyMs] of [["relay-1", 90, 11], ["relay-2", 91, 22]] as const) {
    recordTunnelMultiEntryLatency({
      ...base,
      pathKey,
      sourceHostId: 80,
      hopIndex: 0,
      toHostId,
      latencyMs,
      isTimeout: false,
    });
  }

  assert.equal(getTunnelMultiEntryHopDetails(base), null);
  assert.deepEqual(
    getTunnelMultiEntryHopDetails({ ...base, pathKey: "relay-2" })?.map(({ recordedAt: _recordedAt, ...detail }) => detail),
    [{ hopIndex: 0, hopCount: 1, fromHostId: 80, toHostId: 91, latencyMs: 22, isTimeout: false }],
  );
});

test("a forced multi-entry test clears every cached path for its tunnel", () => {
  const base = {
    tunnelId: 94009,
    expectedEntryHostIds: [80, 81],
    hopCount: 1,
    generation: "clear-details-v1",
  };
  recordTunnelMultiEntryLatency({
    ...base,
    pathKey: "primary",
    sourceHostId: 80,
    hopIndex: 0,
    toHostId: 90,
    latencyMs: 10,
    isTimeout: false,
  });
  clearTunnelMultiEntryLatencyState(base.tunnelId);
  assert.equal(getTunnelMultiEntryHopDetails({ ...base, pathKey: "primary" }), null);
});
