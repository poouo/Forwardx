import assert from "node:assert/strict";
import test from "node:test";

import { createTunnelHopBatch, recordTunnelHopTestResult, registerTunnelHopTest } from "./tunnelHopTestState";

test("dual-entry tunnel tests wait for both entry results before aggregation", () => {
  const batchId = createTunnelHopBatch(42);
  registerTunnelHopTest(batchId, 101);
  registerTunnelHopTest(batchId, 102);

  const fastEntry = recordTunnelHopTestResult(101, {
    success: true,
    latencyMs: 12,
    message: null,
    hopLabel: "entry 1/2",
    routeLabel: "entry-a -> exit",
  }, { latencyMode: "multi-source" });
  assert.equal(fastEntry, null);

  const aggregate = recordTunnelHopTestResult(102, {
    success: true,
    latencyMs: 35,
    message: null,
    hopLabel: "entry 2/2",
    routeLabel: "entry-b -> exit",
  }, { latencyMode: "multi-source" });

  assert.ok(aggregate);
  assert.equal(aggregate.tunnelId, 42);
  assert.equal(aggregate.success, true);
  assert.equal(aggregate.latencyMs, 35);
  assert.equal(aggregate.details.length, 2);
});

test("dual-entry tunnel aggregation records a slow entry failure", () => {
  const batchId = createTunnelHopBatch(43);
  registerTunnelHopTest(batchId, 201);
  registerTunnelHopTest(batchId, 202);

  assert.equal(recordTunnelHopTestResult(201, {
    success: true,
    latencyMs: 8,
    message: null,
    hopLabel: "entry 1/2",
  }), null);

  const aggregate = recordTunnelHopTestResult(202, {
    success: false,
    latencyMs: null,
    message: "timeout",
    hopLabel: "entry 2/2",
  });

  assert.ok(aggregate);
  assert.equal(aggregate.success, false);
  assert.equal(aggregate.latencyMs, null);
  assert.equal(aggregate.details[1]?.message, "timeout");
});
