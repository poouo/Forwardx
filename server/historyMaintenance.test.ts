import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { runHistoryMaintenance } from "./historyMaintenance";
import { LATENCY_HISTORY_DAYS, LATENCY_HISTORY_HOURS } from "../shared/latencyHistory";

test("all latency and availability histories use scheduled 30-day retention", () => {
  assert.equal(LATENCY_HISTORY_DAYS, 30);
  assert.equal(LATENCY_HISTORY_HOURS, 720);
  const scheduler = fs.readFileSync(new URL("./scheduler.ts", import.meta.url), "utf8");
  for (const name of ["cleanOldTcpingStats", "cleanOldTunnelLatencyStats", "cleanOldHostProbeServiceStats"]) {
    assert.ok(scheduler.includes(`db.${name}(LATENCY_HISTORY_HOURS)`), name);
  }
  assert.match(scheduler, /\["host-availability", cleanOldHostAvailability\]/);
  const availability = fs.readFileSync(new URL("./repositories/hostAvailabilityRepository.ts", import.meta.url), "utf8");
  assert.match(availability, /deleteExpiredHistoryRows\("host_availability_intervals", "endAt",[^;]*LATENCY_HISTORY_HOURS \* 3600/);
  const metrics = fs.readFileSync(new URL("./repositories/metricsRepository.ts", import.meta.url), "utf8");
  for (const table of ["tcping_stats", "tunnel_latency_stats", "forward_group_latency_stats", "probe_counter_snapshots"]) {
    assert.ok(metrics.includes(`deleteExpiredHistoryRows("${table}", "recordedAt", cutoff)`), table);
  }
});

test("history cleanup is serial and a failed table does not skip later jobs", async () => {
  const calls: string[] = [];
  const errors: string[] = [];
  let running = 0;
  let maxRunning = 0;
  await runHistoryMaintenance(["traffic", "buckets", "latency"].map(name => [name, async () => {
    running++;
    maxRunning = Math.max(maxRunning, running);
    try {
      calls.push(name);
      await new Promise<void>(resolve => setImmediate(resolve));
      if (name === "buckets") throw new Error("simulated lock failure");
    } finally { running--; }
  }] as const), { logger: { error: message => errors.push(message) } });
  assert.equal(maxRunning, 1);
  assert.deepEqual(calls, ["traffic", "buckets", "latency"]);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /task=buckets.*lock failure/);
});

test("maintenance stops submitting work after the database becomes unavailable", async () => {
  let healthy = true;
  const calls: string[] = [];
  await runHistoryMaintenance([
    ["traffic", async () => { calls.push("traffic"); healthy = false; }],
    ["buckets", async () => { calls.push("buckets"); }],
  ], { shouldContinue: () => healthy });
  assert.deepEqual(calls, ["traffic"]);
});

test("startup leaves history retention to staggered, bounded background maintenance", () => {
  const startup = fs.readFileSync(new URL("./db.ts", import.meta.url), "utf8");
  assert.doesNotMatch(startup, /await[^;]*\bcleanOldTraffic(?:Stats|StatBuckets)\(/);
  const scheduler = fs.readFileSync(new URL("./scheduler.ts", import.meta.url), "utf8");
  assert.match(scheduler, /repeatAfter\(historyCleanup, 5 \* 60_000, 2 \* 60_000\)/);
  assert.match(scheduler, /runHistoryMaintenance\(/);
  for (const file of ["./repositories/forwardTestRepository.ts", "./repositories/forwardGroupRepository.ts", "./hostGeo.ts"]) {
    assert.match(fs.readFileSync(new URL(file, import.meta.url), "utf8"), /await deleteExpiredHistoryRows\(/);
  }
});
