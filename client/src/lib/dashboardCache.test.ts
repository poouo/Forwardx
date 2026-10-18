import assert from "node:assert/strict";
import test from "node:test";
import { QueryClient } from "@tanstack/react-query";
import { getQueryKey } from "@trpc/react-query";
import superjson from "superjson";
import { trpc } from "./trpc";
import { dashboardCacheScope, installDashboardCache, readDashboardSnapshot } from "./dashboardCache";

const authKey = getQueryKey(trpc.auth.me, undefined, "query");
const statsKey = getQueryKey(trpc.dashboard.stats, undefined, "query");
const trendKey = getQueryKey(trpc.dashboard.trafficSeries, { hours: 24, bucketMinutes: 60 }, "query");
const user = { id: 4, username: "alice", createdAt: new Date("2026-01-01"), role: "user" };
const panel = "https://panel.example";
const prefix = "forwardx.dashboard.v1:";

function mockStorage() {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  } });
  return { values, restore() { if (original) Object.defineProperty(globalThis, "localStorage", original); else Reflect.deleteProperty(globalThis, "localStorage"); } };
}

test("snapshots require a matching verified account/panel; auth and settings are not hydrated", async () => {
  const store = mockStorage();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const scope = dashboardCacheScope(panel, user);
  const at = Date.now() - 60_000;
  store.values.set(prefix + scope, superjson.stringify({ version: 1, scope, entries: [
    { key: statsKey, data: { totalRules: 42 }, at },
    { key: trendKey, data: [{ bucket: new Date(at), bytesIn: 25 }], at },
    { key: getQueryKey(trpc.system.getSettings, undefined, "query"), data: { secret: "no" }, at },
    { key: authKey, data: { id: 1, role: "admin" }, at },
  ] }));
  const cache = installDashboardCache(client, () => panel);
  try {
    assert.equal(client.getQueryData(statsKey), undefined, "nothing private is restored before auth");
    client.setQueryData(authKey, user);
    assert.equal(client.getQueryData(statsKey), undefined, "a manually seeded identity is not server verification");
    await client.fetchQuery({ queryKey: authKey, queryFn: async () => user });
    assert.deepEqual(client.getQueryData(statsKey), { totalRules: 42 });
    assert.equal(client.getQueryState(statsKey)?.isInvalidated, true, "cache must always revalidate");
    assert.equal(client.getQueryState(statsKey)?.dataUpdatedAt, at);
    assert.equal((client.getQueryData(trendKey) as any[])[0].bucket instanceof Date, true);
    assert.equal((client.getQueryData(authKey) as any).role, "user");
    assert.equal(client.getQueryData(getQueryKey(trpc.system.getSettings, undefined, "query")), undefined);
    await assert.rejects(client.fetchQuery({ queryKey: statsKey, queryFn: async () => { throw Error("temporarily offline"); } }));
    assert.deepEqual(client.getQueryData(statsKey), { totalRules: 42 }, "refresh failures retain the snapshot");
    await client.fetchQuery({ queryKey: authKey, staleTime: 0, queryFn: async () => ({ ...user, id: 9 }) });
    assert.equal(client.getQueryData(statsKey), undefined, "switching accounts drops prior data");
    assert.equal(store.values.has(prefix + scope), false);
    assert.notEqual(scope, dashboardCacheScope("https://other.example", user));
    assert.notEqual(scope, dashboardCacheScope(panel, { ...user, createdAt: new Date("2026-02-02") }));
    assert.notEqual(scope, dashboardCacheScope(panel, { ...user, role: "admin" }));
  } finally { cache.dispose(); client.clear(); store.restore(); }
});

test("only allowlisted successful server results persist; logout removes snapshots and legacy text, not preferences", async () => {
  const store = mockStorage();
  const client = new QueryClient();
  const cache = installDashboardCache(client, () => panel);
  try {
    await client.fetchQuery({ queryKey: authKey, queryFn: async () => user });
    await client.fetchQuery({ queryKey: statsKey, queryFn: async () => ({ totalRules: 7 }) });
    await client.fetchQuery({ queryKey: getQueryKey(trpc.billing.me, undefined, "query"), queryFn: async () => ({ secret: "not-persisted" }) });
    await new Promise(resolve => setTimeout(resolve, 300));
    const raw = store.values.get(prefix + dashboardCacheScope(panel, user))!;
    assert.ok(raw);
    const snapshot = superjson.parse<{ entries: unknown[] }>(raw);
    assert.doesNotMatch(JSON.stringify(snapshot.entries), /alice|not-persisted|password|role/);
    assert.equal(readDashboardSnapshot(dashboardCacheScope(panel, user)).length, 1);
    store.values.set("forwardx.stat.zh-CN.home.stats.totalRules", "other user's value");
    store.values.set("forwardx-theme", "dark");
    cache.clear();
    assert.equal(store.values.size, 1);
    assert.equal(store.values.get("forwardx-theme"), "dark");
  } finally { cache.dispose(); client.clear(); store.restore(); }
});

test("expired, future, corrupt, oversized or incompatible snapshots are ignored", () => {
  const store = mockStorage();
  const scope = dashboardCacheScope(panel, user);
  const now = Date.now();
  try {
    for (const value of ["bad JSON", "x".repeat(200_001), superjson.stringify({ version: 2, scope, entries: [] }),
      superjson.stringify({ version: 1, scope: "another panel", entries: [] }),
      superjson.stringify({ version: 1, scope, entries: [{ key: trendKey, data: { broken: true }, at: now }] }),
      superjson.stringify({ version: 1, scope, entries: [{ key: statsKey, data: { totalRules: { broken: true } }, at: now }] }),
      ...[now + 1, now - 24 * 60 * 60_000].map(at => superjson.stringify({ version: 1, scope, entries: [{ key: statsKey, data: { totalRules: 1 }, at }] })),
    ]) {
      store.values.set(prefix + scope, value);
      assert.deepEqual(readDashboardSnapshot(scope, now), []);
    }
    Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { throw Error("disabled"); } });
    assert.deepEqual(readDashboardSnapshot(scope), []);
  } finally { store.restore(); }
});
