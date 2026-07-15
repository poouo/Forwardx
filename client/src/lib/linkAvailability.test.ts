import assert from "node:assert/strict";
import test from "node:test";
import {
  buildLinkAvailabilityIndex,
  LINK_PROBE_FRESH_MS,
  resolveLinkAvailability,
} from "./linkAvailability";

const now = Date.UTC(2026, 6, 16, 12, 0, 0);

test("a fresh successful probe owns availability even when cached host state is offline", () => {
  const state = resolveLinkAvailability({
    label: "隧道",
    enabled: true,
    hostsLoaded: true,
    probe: {
      latestLatencyMs: 42,
      latestLatencyIsTimeout: false,
      latestLatencyAt: now - 30_000,
    },
    requiredNodes: [{ id: 1, available: false }],
  }, now);

  assert.equal(state.status, "available");
  assert.equal(state.source, "probe");
});

test("a fresh timeout owns availability even when every host is online", () => {
  const state = resolveLinkAvailability({
    label: "转发链",
    enabled: true,
    hostsLoaded: true,
    probe: {
      latestLatencyMs: null,
      latestLatencyIsTimeout: true,
      latestLatencyAt: now - 30_000,
    },
    requiredNodes: [{ id: 1, available: true }, { id: 2, available: true }],
  }, now);

  assert.equal(state.status, "unavailable");
  assert.equal(state.source, "probe");
});

test("a stale probe falls back to current host state", () => {
  const state = resolveLinkAvailability({
    label: "隧道",
    enabled: true,
    hostsLoaded: true,
    probe: {
      latestLatencyMs: null,
      latestLatencyIsTimeout: true,
      latestLatencyAt: now - LINK_PROBE_FRESH_MS - 1,
    },
    requiredNodes: [{ id: 1, available: true }, { id: 2, available: true }],
  }, now);

  assert.equal(state.status, "available");
  assert.equal(state.source, "hosts");
});

test("a multi-exit tunnel remains usable when one exit is online", () => {
  const { tunnelAvailabilityById } = buildLinkAvailabilityIndex({
    now,
    hosts: [
      { id: 1, isOnline: true },
      { id: 2, isOnline: true },
      { id: 3, isOnline: false },
    ],
    groups: [],
    tunnels: [{
      id: 10,
      isEnabled: true,
      entryHostId: 1,
      exitHostId: 2,
      hopHostIds: [1, 2],
      loadBalanceEnabled: true,
      loadBalanceExits: [{ hostId: 3, isEnabled: true }],
    }],
  });

  assert.equal(tunnelAvailabilityById.get(10)?.status, "degraded");
  assert.equal(tunnelAvailabilityById.get(10)?.available, true);
});

test("a port forward without an independent probe follows its host", () => {
  const groups = [{
    id: 20,
    groupMode: "port",
    isEnabled: true,
    members: [{ id: 201, memberType: "host", hostId: 7, isEnabled: true }],
  }];
  const offline = buildLinkAvailabilityIndex({ hosts: [{ id: 7, isOnline: false }], groups, tunnels: [], now });
  const online = buildLinkAvailabilityIndex({ hosts: [{ id: 7, isOnline: true }], groups, tunnels: [], now });

  assert.equal(offline.groupAvailabilityById.get(20)?.status, "unavailable");
  assert.equal(online.groupAvailabilityById.get(20)?.status, "available");
});

test("forward-chain availability is independent from referenced rule runtime fields", () => {
  const groups = [{
    id: 30,
    groupMode: "chain",
    isEnabled: true,
    runtimeStatus: "degraded",
    runtimeRunningRuleCount: 0,
    runtimeExpectedRuleCount: 100,
    members: [
      { id: 301, memberType: "host", hostId: 1, isEnabled: true },
      { id: 302, memberType: "host", hostId: 2, isEnabled: true },
    ],
  }];
  const { groupAvailabilityById } = buildLinkAvailabilityIndex({
    hosts: [{ id: 1, isOnline: true }, { id: 2, isOnline: true }],
    groups,
    tunnels: [],
    now,
  });

  assert.equal(groupAvailabilityById.get(30)?.status, "available");
});

test("a missing endpoint group makes the saved tunnel configuration unavailable", () => {
  const { tunnelAvailabilityById } = buildLinkAvailabilityIndex({
    hosts: [{ id: 1, isOnline: true }, { id: 2, isOnline: true }],
    groups: [],
    tunnels: [{
      id: 40,
      isEnabled: true,
      entryGroupId: 999,
      entryHostId: 1,
      exitHostId: 2,
      hopHostIds: [1, 2],
      latestLatencyMs: 20,
      latestLatencyIsTimeout: false,
      latestLatencyAt: now - 10_000,
    }],
    now,
  });

  const state = tunnelAvailabilityById.get(40);
  assert.equal(state?.status, "unavailable");
  assert.equal(state?.source, "config");
  assert.equal(state?.message, "关联入口组不存在");
});

test("a missing entry group makes a saved forward chain unavailable", () => {
  const { groupAvailabilityById } = buildLinkAvailabilityIndex({
    hosts: [{ id: 1, isOnline: true }],
    groups: [{
      id: 50,
      groupMode: "chain",
      entryGroupId: 999,
      isEnabled: true,
      members: [{ id: 501, memberType: "host", hostId: 1, isEnabled: true }],
    }],
    tunnels: [],
    now,
  });

  const state = groupAvailabilityById.get(50);
  assert.equal(state?.status, "unavailable");
  assert.equal(state?.source, "config");
  assert.equal(state?.message, "关联入口组不存在");
});

test("china health filtering never marks an unhealthy online member as usable", () => {
  const { groupAvailabilityById } = buildLinkAvailabilityIndex({
    hosts: [
      { id: 1, isOnline: true, ipv4: "192.0.2.1" },
      { id: 2, isOnline: true, ipv4: "192.0.2.2" },
    ],
    groups: [{
      id: 60,
      groupMode: "entry",
      domain: "entry.example.com",
      recordType: "A",
      chinaHealthCheckEnabled: true,
      isEnabled: true,
      members: [
        { id: 601, hostId: 1, isEnabled: true, chinaHealthStatus: "healthy" },
        { id: 602, hostId: 2, isEnabled: true, chinaHealthStatus: "unhealthy" },
      ],
    }],
    tunnels: [],
    now,
  });

  const state = groupAvailabilityById.get(60);
  assert.equal(state?.status, "available");
  assert.deepEqual([...state!.usableMemberIds], [601]);
});
