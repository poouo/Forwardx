import assert from "node:assert/strict";
import test from "node:test";
import { operationsRefreshInterval, operationsRefreshOptions } from "./operationsRefresh";

test("query timers stop on off, hidden, navigation and unmount, and follow a changed interval", async () => {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  (globalThis as any).window = new EventTarget();
  (globalThis as any).document = { visibilityState: "visible" };
  const { QueryClient, QueryObserver } = await import("@tanstack/react-query");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  let requests = 0;
  const base = { queryKey: ["operations-refresh-test"], queryFn: async () => ++requests };
  // Short real intervals exercise QueryObserver's scheduler without depending
  // on Node's experimental mocked interval cancellation behavior.
  const observer = new QueryObserver(client, { ...base, ...operationsRefreshOptions(20) });
  const unsubscribe = observer.subscribe(() => {});
  const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  const waitForRequest = async (after: number) => {
    const deadline = Date.now() + 2000;
    while (requests <= after && Date.now() < deadline) await wait(5);
    assert.ok(requests > after);
  };
  try {
    await waitForRequest(1);
    for (const interval of [operationsRefreshInterval(0, true, "/operations"), operationsRefreshInterval(5, false, "/operations"), operationsRefreshInterval(5, true, "/rules")]) {
      observer.setOptions({ ...base, ...operationsRefreshOptions(interval) });
      const before = requests;
      await wait(60);
      assert.equal(requests, before);
    }
    const before = requests;
    observer.setOptions({ ...base, ...operationsRefreshOptions(30) });
    await waitForRequest(before);
    unsubscribe();
    const afterUnmount = requests;
    await wait(60);
    assert.equal(requests, afterUnmount);
  } finally {
    unsubscribe();
    client.clear();
    (globalThis as any).window = previousWindow;
    (globalThis as any).document = previousDocument;
  }
});
