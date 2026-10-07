import assert from "node:assert/strict";
import test from "node:test";
import { QueryClient, QueryObserver, focusManager, onlineManager } from "@tanstack/react-query";
import { fetchPublicMonitor, isMonitorNotFound, latestMonitorMetric, monitorLatencyYMax, PUBLIC_MONITOR_QUERY_PATHS, PUBLIC_MONITOR_REFRESH_OPTIONS } from "./publicMonitor";

test("monitor requests preserve payload/headers and opt out of browser caching", async () => {
  const fetcher: typeof fetch = async (_input, init) => {
    assert.equal(init?.cache, "no-store");
    assert.equal(init?.credentials, "include");
    assert.ok(init?.signal);
    return new Response('{"updated":true}', { status: 503, headers: { "content-type": "application/json", "x-test": "yes" } });
  };
  const response = await fetchPublicMonitor(fetcher, "https://panel.test", { credentials: "include" });
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("x-test"), "yes");
  assert.deepEqual(await response.json(), { updated: true });
  assert.deepEqual([...PUBLIC_MONITOR_QUERY_PATHS], ["hosts.publicMonitor", "hosts.publicMonitorHostDetail"]);
});

test("monitor deadline aborts both stalled headers and stalled response bodies; subsequent requests recover", async () => {
  const headersHang: typeof fetch = async (_input, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
  });
  await assert.rejects(fetchPublicMonitor(headersHang, "https://panel.test", undefined, 20), { name: "TimeoutError" });
  const bodyHang: typeof fetch = async (_input, init) => new Response(new ReadableStream({
    start(controller) {
      init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason), { once: true });
    },
  }));
  await assert.rejects(fetchPublicMonitor(bodyHang, "https://panel.test", undefined, 20), { name: "TimeoutError" });
  const recovered = await fetchPublicMonitor(async () => new Response("ok"), "https://panel.test");
  assert.equal(await recovered.text(), "ok");
});

test("caller cancellation is propagated without cancelling later requests", async () => {
  const caller = new AbortController();
  const fetcher: typeof fetch = async (_input, init) => new Promise((_resolve, reject) => {
    assert.ok(init?.signal);
    init.signal.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    caller.abort(new DOMException("cancelled", "AbortError"));
  });
  await assert.rejects(fetchPublicMonitor(fetcher, "https://panel.test", { signal: caller.signal }), { name: "AbortError" });
  caller.abort();
  assert.equal(await (await fetchPublicMonitor(async () => new Response("next"), "https://panel.test")).text(), "next");
  await fetchPublicMonitor(async (_input, init) => {
    assert.equal(init?.signal?.aborted, true);
    throw init?.signal?.reason;
  }, new Request("https://panel.test", { signal: caller.signal })).catch((error) => assert.equal(error.name, "AbortError"));
});

test("network/server failures are not mistaken for a disabled monitor", () => {
  for (const error of [null, new Error("Network error"), { data: { code: "SERVICE_UNAVAILABLE" } }, { data: { code: "INTERNAL_SERVER_ERROR" } }]) {
    assert.equal(isMonitorNotFound(error), false);
  }
  assert.equal(isMonitorNotFound({ data: { code: "NOT_FOUND" } }), true);
});

test("details choose the newest metric instead of freezing on the slower detail query", () => {
  const old: { recordedAt: string | Date; cpuUsage: number } = { recordedAt: "2026-10-05T01:00:00Z", cpuUsage: 10 };
  const fresh: typeof old = { recordedAt: new Date("2026-10-05T01:00:03Z"), cpuUsage: 40 };
  assert.equal(latestMonitorMetric(fresh, old), fresh);
  assert.equal(latestMonitorMetric(old, fresh), fresh);
  assert.equal(latestMonitorMetric(null, old), old);
  assert.equal(latestMonitorMetric(fresh, null), fresh);
});

test("long-running multi-service charts do not exceed the function argument limit", () => {
  const points = Array.from({ length: 20_000 }, () => ({ service_1: 50, service_2: 100 }));
  const services = Array.from({ length: 32 }, (_, i) => i + 1);
  assert.equal(monitorLatencyYMax(points, services), 120);
  assert.equal(monitorLatencyYMax([{ service_2: 201, service_3: Infinity }], services), 242);
  assert.equal(monitorLatencyYMax([], services), 120);
  assert.equal(monitorLatencyYMax(points, []), 120);
});

test("monitor preserves previous data after failure and refreshes on visibility/network recovery", async () => {
  const client = new QueryClient();
  focusManager.setFocused(true);
  onlineManager.setOnline(true);
  client.mount();
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
  let calls = 0;
  const observer = new QueryObserver(client, {
    ...PUBLIC_MONITOR_REFRESH_OPTIONS,
    queryKey: ["public-monitor-test"],
    queryFn: async () => {
      calls++;
      if (calls === 2) throw new Error("temporary timeout");
      return { refreshedAt: calls };
    },
  });
  const unsubscribe = observer.subscribe(() => {});
  try {
    await observer.refetch();
    assert.equal(observer.getCurrentResult().data?.refreshedAt, 1);
    await observer.refetch();
    assert.equal(observer.getCurrentResult().isError, true);
    assert.equal(observer.getCurrentResult().data?.refreshedAt, 1);
    focusManager.setFocused(false);
    await flush();
    assert.equal(calls, 2);
    focusManager.setFocused(true);
    await flush();
    assert.equal(observer.getCurrentResult().isError, false);
    assert.equal(observer.getCurrentResult().data?.refreshedAt, 3);
    onlineManager.setOnline(false);
    onlineManager.setOnline(true);
    await flush();
    assert.equal(observer.getCurrentResult().data?.refreshedAt, 4);
  } finally {
    unsubscribe();
    client.unmount();
    client.clear();
    focusManager.setFocused(undefined);
    onlineManager.setOnline(true);
  }
});
