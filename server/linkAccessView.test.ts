import assert from "node:assert/strict";
import test from "node:test";

import { filterTunnelFieldsForUser, type LinkAccessScope } from "./linkAccessView";
import { publicLinkAvailabilitySummary } from "./linkAvailabilitySummary";
import { filterForwardGroupFieldsForUse } from "./repositories/forwardGroupRepository";

const scope: LinkAccessScope = {
  hostIds: new Set([1]),
  tunnelIds: new Set([10]),
  groupIds: new Set([20]),
};

test("shared tunnel status does not expose hosts outside the user's host scope", () => {
  const filtered = filterTunnelFieldsForUser({
    id: 10,
    entryHostId: 1,
    exitHostId: 2,
    certPem: "certificate",
    certKeyPem: "private-key",
    secret: "secret",
    entryHost: { id: 1, name: "visible", ip: "192.0.2.1", lastHeartbeat: 100 },
    exitHost: { id: 2, name: "hidden", ip: "192.0.2.2", lastHeartbeat: 200 },
    hopHostIds: [1, 2],
    hopConnectHosts: ["192.0.2.1", "192.0.2.2"],
    hopHosts: [{ id: 1, name: "visible" }, { id: 2, name: "hidden" }],
    loadBalanceExits: [{ hostId: 3, connectHost: "192.0.2.3", host: { id: 3, name: "hidden-exit" } }],
    entryGroup: { id: 30, members: [{ id: 300, hostId: 2 }] },
    lastTestMessage: "TUNNEL_TEST_TARGET_INVALID target=hidden.example.test port=65432",
    latestLatencySeries: [{ seriesLabel: "hidden.example.test (host 2):65432", latencyMs: 42 }],
    availability: { status: "available", available: true, source: "hosts", message: "online" },
  }, scope) as any;

  assert.equal(filtered.entryHost.name, "visible");
  assert.equal(filtered.exitHost, null);
  assert.equal(filtered.entryHostId, 1);
  assert.equal(filtered.exitHostId, null);
  assert.equal(filtered.connectHost, null);
  assert.deepEqual(filtered.hopHostIds, [1]);
  assert.deepEqual(filtered.hopConnectHosts, ["192.0.2.1"]);
  assert.deepEqual(filtered.loadBalanceExits, []);
  assert.equal("entryGroup" in filtered, false);
  assert.equal("lastTestMessage" in filtered, false);
  assert.equal("latestLatencySeries" in filtered, false);
  assert.equal("certPem" in filtered, false);
  assert.equal("certKeyPem" in filtered, false);
  assert.equal("secret" in filtered, false);
  assert.equal(filtered.availability.status, "available");
  assert.equal(JSON.stringify(filtered).includes("hidden"), false);
  assert.equal(JSON.stringify(filtered).includes("192.0.2.2"), false);
  assert.equal(JSON.stringify(filtered).includes("hidden.example.test"), false);
  assert.equal(JSON.stringify(filtered).includes('"lastHeartbeat":200'), false);
});

test("shared group keeps an accurate summary while removing unauthorized members", () => {
  const availability = publicLinkAvailabilitySummary({
    status: "degraded",
    available: true,
    source: "hosts",
    message: "partially online",
    usableHostIds: new Set([1, 2]),
    usableMemberIds: new Set([101, 102, 103]),
  }, [101, 103]);
  const [filtered] = filterForwardGroupFieldsForUse([{
    id: 20,
    name: "shared",
    groupMode: "failover",
    availability,
    members: [
      { id: 101, memberType: "host", hostId: 1, host: { id: 1, name: "visible", ip: "192.0.2.1" } },
      { id: 102, memberType: "host", hostId: 2, host: { id: 2, name: "hidden", ip: "192.0.2.2" } },
      { id: 103, memberType: "tunnel", tunnelId: 10, host: { id: 2, name: "hidden-entry", ip: "192.0.2.2" } },
      { id: 104, memberType: "tunnel", tunnelId: 11, host: { id: 1, name: "visible-but-member-hidden" } },
    ],
  }], scope) as any[];

  assert.deepEqual(filtered.members.map((member: any) => member.id), [101, 103]);
  assert.equal(filtered.members[0].host.name, "visible");
  assert.equal(filtered.members[1].host, null);
  assert.equal(filtered.members[1].connectHost, null);
  assert.equal(filtered.members[1].entryAddress, null);
  assert.deepEqual(filtered.availability.usableMemberIds, [101, 103]);
  assert.equal(filtered.availability.status, "degraded");
});
