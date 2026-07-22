import assert from "node:assert/strict";
import test from "node:test";

import { createTunnelHopBatch, recordTunnelHopTestResult, registerTunnelHopTest } from "./tunnelHopTestState";
import { createHopTestBatch, recordHopTestResult, registerHopTest } from "./hopTestState";

test("kernel NAT chain probes convert remaining-path latency into per-hop latency", () => {
  const batchId = createHopTestBatch("fgr", 24);
  registerHopTest(batchId, 1);
  registerHopTest(batchId, 2);
  registerHopTest(batchId, 3);

  const options = {
    successPrefix: "chain success",
    failurePrefix: "chain failed",
    latencyMode: "remaining-path" as const,
  };
  assert.equal(recordHopTestResult(1, {
    success: true,
    latencyMs: 130,
    message: null,
    hopLabel: "1/3",
    routeLabel: "entry -> relay",
  }, options), null);
  assert.equal(recordHopTestResult(2, {
    success: true,
    latencyMs: 125,
    message: null,
    hopLabel: "2/3",
    routeLabel: "relay -> exit",
  }, options), null);
  const aggregate = recordHopTestResult(3, {
    success: true,
    latencyMs: 7,
    message: null,
    hopLabel: "3/3",
    routeLabel: "exit -> target",
  }, options);

  assert.ok(aggregate);
  assert.equal(aggregate.latencyMs, 130);
  assert.deepEqual(aggregate.details.map((detail) => detail.latencyMs), [5, 118, 7]);
});

test("remaining-path aggregation keeps the entry total when probe samples jitter", () => {
  const batchId = createHopTestBatch("fgr", 25);
  registerHopTest(batchId, 11);
  registerHopTest(batchId, 12);
  registerHopTest(batchId, 13);
  const options = {
    successPrefix: "chain success",
    failurePrefix: "chain failed",
    latencyMode: "remaining-path" as const,
  };

  assert.equal(recordHopTestResult(11, { success: true, latencyMs: 120, message: null, hopLabel: "1/3" }, options), null);
  assert.equal(recordHopTestResult(12, { success: true, latencyMs: 125, message: null, hopLabel: "2/3" }, options), null);
  const aggregate = recordHopTestResult(13, { success: true, latencyMs: 7, message: null, hopLabel: "3/3" }, options);

  assert.ok(aggregate);
  assert.equal(aggregate.latencyMs, 120);
  assert.deepEqual(aggregate.details.map((detail) => detail.latencyMs), [0, 118, 7]);
});

test("multi-entry NAT chain keeps parallel entries separate from shared remaining latency", () => {
  const batchId = createHopTestBatch("fgr", 26);
  for (const id of [21, 22, 23, 24]) registerHopTest(batchId, id);
  const options = {
    successPrefix: "chain success",
    failurePrefix: "chain failed",
    latencyMode: "multi-source-remaining-path" as const,
  };

  assert.equal(recordHopTestResult(21, { success: true, latencyMs: 130, message: null, hopLabel: "entry 1/2", routeLabel: "entry-a -> relay" }, options), null);
  assert.equal(recordHopTestResult(22, { success: true, latencyMs: 135, message: null, hopLabel: "entry 2/2", routeLabel: "entry-b -> relay" }, options), null);
  assert.equal(recordHopTestResult(23, { success: true, latencyMs: 125, message: null, hopLabel: "2/3", routeLabel: "relay -> exit" }, options), null);
  const aggregate = recordHopTestResult(24, { success: true, latencyMs: 7, message: null, hopLabel: "3/3", routeLabel: "exit -> target" }, options);

  assert.ok(aggregate);
  assert.equal(aggregate.success, true);
  assert.equal(aggregate.latencyMs, 135);
  assert.deepEqual(aggregate.details.map((detail) => detail.latencyMs), [5, 10, 118, 7]);
});

test("multi-entry NAT chain derives segments when one entry is unavailable", () => {
  const batchId = createHopTestBatch("fgr", 27);
  for (const id of [31, 32, 33, 34]) registerHopTest(batchId, id);
  const options = {
    successPrefix: "chain success",
    failurePrefix: "chain failed",
    latencyMode: "multi-source-remaining-path" as const,
  };

  assert.equal(recordHopTestResult(31, { success: false, latencyMs: null, message: "timeout", hopLabel: "entry 1/2", routeLabel: "entry-a -> relay" }, options), null);
  assert.equal(recordHopTestResult(32, { success: true, latencyMs: 135, message: null, hopLabel: "entry 2/2", routeLabel: "entry-b -> relay" }, options), null);
  assert.equal(recordHopTestResult(33, { success: true, latencyMs: 125, message: null, hopLabel: "2/3", routeLabel: "relay -> exit" }, options), null);
  const aggregate = recordHopTestResult(34, { success: true, latencyMs: 7, message: null, hopLabel: "3/3", routeLabel: "exit -> target" }, options);

  assert.ok(aggregate);
  assert.equal(aggregate.success, true);
  assert.equal(aggregate.latencyMs, 135);
  assert.deepEqual(aggregate.details.map((detail) => detail.latencyMs), [null, 10, 118, 7]);
});

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

test("multi-exit tunnel remains available when a backup exit succeeds", () => {
  const batchId = createTunnelHopBatch(44);
  registerTunnelHopTest(batchId, 301);
  registerTunnelHopTest(batchId, 302);

  assert.equal(recordTunnelHopTestResult(301, {
    success: false,
    latencyMs: null,
    message: "primary timeout",
    hopLabel: "exit 1/2",
    routeLabel: "entry -> primary",
  }, { latencyMode: "max" }), null);

  const aggregate = recordTunnelHopTestResult(302, {
    success: true,
    latencyMs: 105,
    message: null,
    hopLabel: "exit 2/2",
    routeLabel: "entry -> backup",
  }, { latencyMode: "max" });

  assert.ok(aggregate);
  assert.equal(aggregate.success, true);
  assert.equal(aggregate.latencyMs, 105);
  assert.match(aggregate.message, /1\/2/);
  assert.equal(aggregate.details[0]?.success, false);
  assert.equal(aggregate.details[1]?.success, true);
});

test("multi-entry tunnel remains available when one entry and all shared hops succeed", () => {
  const batchId = createTunnelHopBatch(45);
  registerTunnelHopTest(batchId, 401);
  registerTunnelHopTest(batchId, 402);
  registerTunnelHopTest(batchId, 403);

  assert.equal(recordTunnelHopTestResult(401, {
    success: false,
    latencyMs: null,
    message: "entry-a timeout",
    hopLabel: "entry 1/2",
    routeLabel: "entry-a -> relay",
  }, { latencyMode: "multi-source" }), null);
  assert.equal(recordTunnelHopTestResult(402, {
    success: true,
    latencyMs: 6,
    message: null,
    hopLabel: "entry 2/2",
    routeLabel: "entry-b -> relay",
  }, { latencyMode: "multi-source" }), null);

  const aggregate = recordTunnelHopTestResult(403, {
    success: true,
    latencyMs: 126,
    message: null,
    hopLabel: "2/2",
    routeLabel: "relay -> exit",
  }, { latencyMode: "multi-source" });

  assert.ok(aggregate);
  assert.equal(aggregate.success, true);
  assert.equal(aggregate.latencyMs, 132);
  assert.match(aggregate.message, /1\/2 个入口可用/);
});

test("multi-entry tunnel fails when a shared hop fails", () => {
  const batchId = createTunnelHopBatch(46);
  registerTunnelHopTest(batchId, 501);
  registerTunnelHopTest(batchId, 502);
  registerTunnelHopTest(batchId, 503);

  assert.equal(recordTunnelHopTestResult(501, {
    success: false,
    latencyMs: null,
    message: "entry-a timeout",
    hopLabel: "entry 1/2",
    routeLabel: "entry-a -> relay",
  }, { latencyMode: "multi-source" }), null);
  assert.equal(recordTunnelHopTestResult(502, {
    success: true,
    latencyMs: 6,
    message: null,
    hopLabel: "entry 2/2",
    routeLabel: "entry-b -> relay",
  }, { latencyMode: "multi-source" }), null);

  const aggregate = recordTunnelHopTestResult(503, {
    success: false,
    latencyMs: null,
    message: "shared timeout",
    hopLabel: "2/2",
    routeLabel: "relay -> exit",
  }, { latencyMode: "multi-source" });

  assert.ok(aggregate);
  assert.equal(aggregate.success, false);
  assert.equal(aggregate.latencyMs, null);
});
