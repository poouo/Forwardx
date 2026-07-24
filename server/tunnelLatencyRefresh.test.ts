import assert from "node:assert/strict";
import test from "node:test";
import {
  TunnelLatencyRefreshSignals,
  waitForTunnelLatencyRefresh,
} from "./tunnelLatencyRefresh";

test("tunnel latency wait returns an already refreshed sample with one query", async () => {
  const signals = new TunnelLatencyRefreshSignals();
  let queries = 0;
  const result = await waitForTunnelLatencyRefresh({
    tunnelId: 7,
    baselineId: 10,
    waitMs: 50,
    signals,
    loadLatest: async () => {
      queries += 1;
      return { id: 11 };
    },
  });

  assert.equal(result.id, 11);
  assert.equal(queries, 1);
});

test("tunnel latency wait wakes on a process-local insert signal", async () => {
  const signals = new TunnelLatencyRefreshSignals();
  let queries = 0;
  let latest = { id: 20 };
  const waiting = waitForTunnelLatencyRefresh({
    tunnelId: 8,
    baselineId: 20,
    waitMs: 200,
    signals,
    loadLatest: async () => {
      queries += 1;
      return latest;
    },
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(signals.pendingWaiterCount(8), 1);
  latest = { id: 21 };
  signals.notify(8);

  assert.equal((await waiting).id, 21);
  assert.equal(queries, 2);
  assert.equal(signals.pendingWaiterCount(8), 0);
});

test("tunnel latency wait does not miss a signal during its initial query", async () => {
  const signals = new TunnelLatencyRefreshSignals();
  let releaseInitial: (() => void) | undefined;
  let queries = 0;
  let latest = { id: 30 };
  const waiting = waitForTunnelLatencyRefresh({
    tunnelId: 9,
    baselineId: 30,
    waitMs: 200,
    signals,
    loadLatest: async () => {
      queries += 1;
      const snapshot = latest;
      if (queries === 1) await new Promise<void>((resolve) => { releaseInitial = resolve; });
      return snapshot;
    },
  });

  await new Promise((resolve) => setImmediate(resolve));
  signals.notify(9);
  latest = { id: 31 };
  releaseInitial?.();

  assert.equal((await waiting).id, 31);
  assert.equal(queries, 2);
});

test("tunnel latency wait performs one final query after an empty timeout", async () => {
  const signals = new TunnelLatencyRefreshSignals();
  let queries = 0;
  const result = await waitForTunnelLatencyRefresh({
    tunnelId: 10,
    baselineId: 40,
    waitMs: 20,
    signals,
    loadLatest: async () => {
      queries += 1;
      return { id: 40 };
    },
  });

  assert.equal(result.id, 40);
  assert.equal(queries, 2);
  assert.equal(signals.pendingWaiterCount(10), 0);
});

test("tunnel latency wait discovers a cross-process refresh on a sparse poll", async () => {
  const signals = new TunnelLatencyRefreshSignals();
  let queries = 0;
  const result = await waitForTunnelLatencyRefresh({
    tunnelId: 11,
    baselineId: 50,
    waitMs: 100,
    crossProcessPollMs: 10,
    signals,
    loadLatest: async () => {
      queries += 1;
      return { id: queries === 1 ? 50 : 51 };
    },
  });

  assert.equal(result.id, 51);
  assert.equal(queries, 2);
  assert.equal(signals.pendingWaiterCount(11), 0);
});

test("tunnel latency wait rechecks after a signal precedes transaction visibility", async () => {
  const signals = new TunnelLatencyRefreshSignals();
  let queries = 0;
  let latest = { id: 60 };
  let secondQueryComplete: (() => void) | undefined;
  const secondQueryDone = new Promise<void>((resolve) => { secondQueryComplete = resolve; });
  const waiting = waitForTunnelLatencyRefresh({
    tunnelId: 12,
    baselineId: 60,
    waitMs: 100,
    crossProcessPollMs: 10,
    signals,
    loadLatest: async () => {
      queries += 1;
      if (queries === 2) secondQueryComplete?.();
      return latest;
    },
  });

  await new Promise((resolve) => setImmediate(resolve));
  signals.notify(12);
  await secondQueryDone;
  latest = { id: 61 };

  assert.equal((await waiting).id, 61);
  assert.equal(queries, 3);
  assert.equal(signals.pendingWaiterCount(12), 0);
});
