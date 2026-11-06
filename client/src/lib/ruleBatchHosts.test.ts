import assert from "node:assert/strict";
import test from "node:test";
import { getRuleBatchEntryHosts, matchesRuleBatchHost, ruleBatchHostOptions, type RuleBatchHostContext } from "./ruleBatchHosts";

function context(): RuleBatchHostContext {
  return {
    hostById: new Map([
      [1, { id: 1, name: "Entry A", ipv4: "192.0.2.1" }],
      [2, { id: 2, name: "Entry B", ipv6: "2001:db8::2" }],
      [3, { id: 3, name: "Exit C", ip: "192.0.2.3" }],
      [4, { id: 4, name: "Relay D", ip: "192.0.2.4" }],
    ]),
    tunnelById: new Map(), forwardGroupById: new Map(),
  };
}
const ids = (hosts: ReturnType<typeof getRuleBatchEntryHosts>) => hosts.map(host => host.id);

test("host choices are deduplicated from source rules, not every host visible to the administrator", () => {
  const ctx = context();
  const index = new Map([1, 2, 3].map(id => [id, getRuleBatchEntryHosts({ hostId: id === 3 ? 2 : 1 }, ctx)]));
  assert.deepEqual(ids(ruleBatchHostOptions(index)), [1, 2]);
  assert.equal(matchesRuleBatchHost(index.get(1)!, "1"), true);
  assert.equal(matchesRuleBatchHost(index.get(1)!, "2"), false);
  assert.equal(matchesRuleBatchHost([], "all"), true);
  assert.equal(matchesRuleBatchHost(index.get(1)!, "bad-id"), false);
  assert.equal(index.get(1)![0].address, "192.0.2.1");
  assert.equal(index.get(3)![0].address, "2001:db8::2");
});

test("tunnels resolve their actual entry rather than stale rule hosts, relays or exits", () => {
  const ctx = context();
  (ctx.tunnelById as Map<number, any>).set(10, { entryHostId: 1, exitHostId: 3, hopHostIds: [1, 4, 3] });
  assert.deepEqual(ids(getRuleBatchEntryHosts({ hostId: 3, tunnelId: 10 }, ctx)), [1]);
  assert.deepEqual(ids(getRuleBatchEntryHosts({ hostId: 2, tunnelId: 999 }, ctx)), [2]);
  assert.deepEqual(getRuleBatchEntryHosts({ hostId: -1 }, ctx), []);
});

test("multi-entry tunnels and port resources match every enabled entry, deduplicating shared nested summaries", () => {
  const ctx = context();
  const entry = { members: [
    { hostId: 1, priority: 1 }, { hostId: 2, priority: 2 }, { hostId: 2, priority: 3 },
    { hostId: 3, isEnabled: false }, { hostId: 4, isEnabled: 0 },
    { hostId: 5, priority: 4, host: { id: 5, name: "Shared entry", entryIp: "entry.example.test" } },
  ] };
  (ctx.tunnelById as Map<number, any>).set(10, { entryHostId: 1, exitHostId: 3, entryGroupId: 20, entryGroup: entry });
  (ctx.forwardGroupById as Map<number, any>).set(30, { groupMode: "port", entryGroupId: 20, entryGroup: entry, members: [{ hostId: 4 }] });
  for (const rule of [{ tunnelId: 10 }, { forwardGroupId: 30 }]) {
    const hosts = getRuleBatchEntryHosts(rule, ctx);
    assert.deepEqual(ids(hosts), [1, 2, 5]);
    for (const id of [1, 2, 5]) assert.equal(matchesRuleBatchHost(hosts, String(id)), true);
    for (const id of [3, 4]) assert.equal(matchesRuleBatchHost(hosts, String(id)), false);
    assert.equal(hosts[2].name, "Shared entry");
    assert.equal(hosts[2].address, "entry.example.test");
  }
});

test("chains use their first node or external entries; failover resources include alternative entries", () => {
  const ctx = context();
  const groups = ctx.forwardGroupById as Map<number, any>;
  groups.set(30, { groupMode: "chain", members: [{ hostId: 3, priority: 2 }, { hostId: 1, priority: 1 }] });
  assert.deepEqual(ids(getRuleBatchEntryHosts({ hostId: 3, forwardGroupId: 30 }, ctx)), [1]);
  groups.set(31, { groupMode: "entry", members: [{ hostId: 2 }] });
  groups.set(30, { ...groups.get(30), entryGroupId: 31 });
  assert.deepEqual(ids(getRuleBatchEntryHosts({ hostId: 1, forwardGroupId: 30 }, ctx)), [2]);
  (ctx.tunnelById as Map<number, any>).set(10, { entryHostId: 2, exitHostId: 3 });
  groups.set(40, { groupMode: "failover", members: [{ hostId: 1 }, { memberType: "tunnel", tunnelId: 10 }] });
  assert.deepEqual(ids(getRuleBatchEntryHosts({ forwardGroupId: 40 }, ctx)), [1, 2]);
});

test("empty entry groups never fall back to a downstream or previously stored host", () => {
  const ctx = context();
  (ctx.forwardGroupById as Map<number, any>).set(20, { groupMode: "entry", members: [] });
  (ctx.tunnelById as Map<number, any>).set(10, { entryGroupId: 20, entryHostId: 1 });
  assert.deepEqual(getRuleBatchEntryHosts({ hostId: 1, tunnelId: 10 }, ctx), []);
});

test("shared tunnel entries use authorized nested hop summaries without querying hidden hosts", () => {
  const ctx = context();
  (ctx.tunnelById as Map<number, any>).set(10, {
    entryGroupId: 20, entryGroup: { members: [{ hostId: 5 }, { hostId: 5 }] },
    hopHosts: [{ id: 5, name: "Shared hop", ip: "192.0.2.5" }],
  });
  assert.deepEqual(getRuleBatchEntryHosts({ tunnelId: 10 }, ctx), [{ id: 5, name: "Shared hop", address: "192.0.2.5" }]);
});
