import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import * as runtime from "./dbRuntime";
import * as db from "./db";
import { ensureDatabaseSchema } from "./dbSchema";
import { ipSwitchAddressSnapshot, observeIpSwitchAddress, reconcileIpSwitchAddresses } from "./hostIpSwitchObservation";
import { registerAgentEventClient } from "./agentEvents";
import { scheduleHostDdnsUpdate } from "./hostDdns";
import { handleHostAddressChanged } from "./hostAddressRuntime";

await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB! } });
const streams: { close: () => void }[] = [];
const originalFetch = globalThis.fetch;
try {
  await ensureDatabaseSchema();
  const now = Math.floor(Date.now() / 1000);
  const oldIp = "8.8.8.8", newIp = "8.8.4.4";
  const oldIpv6 = "2606:4700:4700::1111", newIpv6 = "2606:4700:4700::1001";
  const previous = { id: 1, name: "Exit", ip: oldIp, ipv4: oldIp, ipv6: oldIpv6, ipv4Addresses: JSON.stringify([oldIp]), ipv6Addresses: JSON.stringify([oldIpv6]), entryIp: oldIp, tunnelEntryIp: oldIp, preferredIpv4: oldIp, userId: 1,
    ddnsEnabled: true, ddnsDomain: "host.example.test", ddnsIpVersion: "both", ddnsAddressMode: "all", lastDdnsValue: JSON.stringify({ A: [oldIp], AAAA: [oldIpv6] }) };
  await runtime.insertAndGetId("hosts", previous);
  for (const id of [2, 3, 4, 5]) await runtime.insertAndGetId("hosts", { id, name: `Host ${id}`, ip: "1.1.1.1", userId: 1 });
  await runtime.insertAndGetId("forward_groups", { id: 1, name: "Entries", groupMode: "entry", groupType: "host", targetIp: "0.0.0.0", userId: 1, isEnabled: true });
  for (const hostId of [2, 3]) await runtime.insertAndGetId("forward_group_members", { groupId: 1, memberType: "host", hostId, isEnabled: true });
  await runtime.insertAndGetId("tunnels", { id: 1, name: "Multi-entry tunnel", entryHostId: 2, exitHostId: 1, entryGroupId: 1, connectHost: oldIp, listenPort: 17000, mode: "forwardx", userId: 1, isRunning: true });
  for (const [seq, hostId] of [[0, 2], [1, 1]]) await runtime.insertAndGetId("tunnel_hops", { tunnelId: 1, seq, hostId, connectHost: seq ? oldIp : null, listenPort: 17000 + seq });
  for (const [seq, hostId] of [[0, 1], [1, 4]]) await runtime.insertAndGetId("tunnel_exit_nodes", { tunnelId: 1, seq, hostId, connectHost: seq ? "custom.example.com" : oldIp, listenPort: 17000 + seq });
  for (const hostId of [2, 5]) await runtime.insertAndGetId("forward_rules", { id: hostId, name: `Rule ${hostId}`, hostId, userId: 1, sourcePort: 18000, targetIp: oldIp, targetPort: 443, protocol: "tcp", forwardType: "realm", tunnelId: hostId === 2 ? 1 : null, isRunning: true });
  await db.setSettings({ ddnsEnabled: "true", ddnsProvider: "webhook", ddnsWebhookUrl: "https://ddns.example.test/update", ddnsWebhookMethod: "POST" });
  const dnsRequests: any[] = [];
  let failGroup = true, failHostAAAA = false;
  globalThis.fetch = (async (url, options) => {
    // No real provider or paid IP-switch API may be contacted by this fixture.
    assert.equal(String(url), "https://ddns.example.test/update");
    const record = JSON.parse(String(options?.body));
    dnsRequests.push(record);
    if ((failGroup && record.domain === "failover.example.test") || (failHostAAAA && record.domain === "host.example.test" && record.recordType === "AAAA")) {
      if (record.domain === "host.example.test") failHostAAAA = false;
      return new Response("test DNS provider unavailable", { status: 503 });
    }
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  for (const [id, groupMode, domain] of [[2, "entry", "entry.example.test"], [3, "failover", "failover.example.test"]] as const) {
    await runtime.insertAndGetId("forward_groups", { id, name: domain, groupMode, groupType: "host", domain, recordType: "BOTH", targetIp: "0.0.0.0", userId: 1, isEnabled: true, lastDdnsValue: `${oldIp},${oldIpv6}` });
    await runtime.insertAndGetId("forward_group_members", { groupId: id, memberType: "host", hostId: 1, isEnabled: true, healthStatus: "healthy", lastCheckedAt: now, healthySince: now - 180 });
  }
  const responses = new Map<number, { writes: string[] }>();
  for (const hostId of [1, 2, 3, 4, 5]) {
    class Response extends EventEmitter {
      writes: string[] = [];
      write(value: string) { this.writes.push(value); return true; }
      end() { this.emit("finish"); }
    }
    const response = new Response(); responses.set(hostId, response);
    streams.push(registerAgentEventClient(hostId, "fixture-token", response as any));
    response.writes.length = 0;
  }
  const attemptId = await runtime.insertAndGetId("host_ip_switch_attempts", { hostId: 1, serviceId: 1, incidentId: randomUUID(), status: "uncertain", reason: "request_failed", oldIp, addressSnapshot: JSON.stringify(ipSwitchAddressSnapshot(previous)), createdAt: now - 1, cooldownUntil: now + 3600 });
  await db.updateHostHeartbeat(1, { ip: newIp, ipv4: newIp, ipv6: newIpv6, ipv4Addresses: JSON.stringify([newIp]), ipv6Addresses: JSON.stringify([newIpv6]) } as any);
  await reconcileIpSwitchAddresses(); // Also covers recovery without an in-memory request/task.
  assert.equal((await runtime.queryRaw<any>("SELECT status FROM host_ip_switch_attempts WHERE id = ?", [attemptId]))[0].status, "sync_failed", "group DNS failures must remain retryable even though the IP changed");
  assert.equal((await runtime.queryRaw<any>("SELECT connectHost FROM tunnels WHERE id = 1"))[0].connectHost, newIp, "DNS failure cannot block forwarding address recovery");
  failGroup = false;
  await reconcileIpSwitchAddresses();
  const host = (await db.getHostById(1))!;
  assert.equal(host.entryIp, newIp); assert.equal(host.tunnelEntryIp, newIp); assert.equal(host.preferredIpv4, newIp);
  const [attempt] = await runtime.queryRaw<any>("SELECT * FROM host_ip_switch_attempts WHERE id = ?", [attemptId]);
  assert.equal(attempt.status, "succeeded"); assert.equal(attempt.reason, "ip_changed"); assert.equal(attempt.newIp, newIp);
  assert.equal(attempt.cooldownUntil, now + 3600, "confirmation does not clear the merchant cooldown");
  const [tunnel] = await runtime.queryRaw<any>("SELECT * FROM tunnels WHERE id = 1");
  assert.equal(tunnel.connectHost, newIp, "old stored endpoint follows the updated tunnel address");
  const exits = await runtime.queryRaw<any>("SELECT connectHost FROM tunnel_exit_nodes ORDER BY seq");
  assert.equal(exits[0].connectHost, newIp); assert.equal(exits[1].connectHost, "custom.example.com");
  for (const hostId of [1, 2, 3, 4]) assert.ok(responses.get(hostId)!.writes.length > 0, `encrypted refresh for peer ${hostId}, including secondary entry`);
  assert.equal(responses.get(5)!.writes.length, 0, "unrelated hosts receive no reset");
  const [unrelated] = await runtime.queryRaw<any>("SELECT * FROM forward_rules WHERE id = 5");
  assert.equal(unrelated.targetIp, oldIp, "never globally replace manually configured destinations");
  assert.equal(unrelated.isRunning, 1);
  assert.equal(await observeIpSwitchAddress(host), false, "a completed switch cannot run again");

  const waitForHostDns = async (predicate: (host: any) => boolean) => {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const current = await db.getHostById(1);
      if (predicate(current)) return current!;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail("host DDNS did not reach the expected state");
  };
  await waitForHostDns(current => current.lastDdnsAt && !current.lastDdnsError);
  for (const domain of ["host.example.test", "entry.example.test", "failover.example.test"]) {
    const records = dnsRequests.filter(item => item.domain === domain);
    assert.deepEqual(records.filter(item => item.recordType === "A").at(-1)?.values, [newIp]);
    assert.deepEqual(records.filter(item => item.recordType === "AAAA").at(-1)?.values, [newIpv6]);
    assert.ok(records.every(item => item.action === "replace" && !item.values.includes(oldIp) && !item.values.includes(oldIpv6)), "replace stale values, never publish the vendor response or snapshot");
  }
  assert.equal(dnsRequests.filter(item => item.domain === "host.example.test").length, 2, "configuration retries must not rewrite already-converged host DNS");

  // Partial host DNS failure uses its own retry path, keeping a successfully
  // updated A RRset while retrying only AAAA. It never requests another IP.
  const nextIp = "9.9.9.9", nextIpv6 = "2001:4860:4860::8888";
  await db.updateHostHeartbeat(1, { ip: nextIp, ipv4: nextIp, ipv6: nextIpv6, ipv4Addresses: JSON.stringify([nextIp]), ipv6Addresses: JSON.stringify([nextIpv6]) } as any);
  failHostAAAA = true;
  await handleHostAddressChanged(1, (await db.getHostById(1))!, host, "fixture-next-address");
  const partial = await waitForHostDns(current => !!current.lastDdnsError);
  assert.deepEqual(JSON.parse(partial.lastDdnsValue!), { A: [nextIp], AAAA: [newIpv6] });
  const hostAUpdates = dnsRequests.filter(item => item.domain === "host.example.test" && item.recordType === "A").length;
  // Trigger the same non-forced update used by retries without waiting out
  // the one-minute backoff (timer/backoff behavior has separate unit tests).
  await new Promise(resolve => setImmediate(resolve));
  scheduleHostDdnsUpdate(partial, "fixture-ddns-retry");
  await waitForHostDns(current => !current.lastDdnsError && JSON.parse(current.lastDdnsValue).AAAA[0] === nextIpv6);
  assert.equal(dnsRequests.filter(item => item.domain === "host.example.test" && item.recordType === "A").length, hostAUpdates);
  await db.updateHost(1, { ddnsEnabled: false });
  await runtime.executeRaw("UPDATE forward_groups SET isEnabled = 0 WHERE id IN (2,3)");
  const beforeDisabled = dnsRequests.length;
  await handleHostAddressChanged(1, (await db.getHostById(1))!, host, "fixture-disabled-ddns");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(dnsRequests.length, beforeDisabled, "disabled DNS must not be enabled or updated by IP recovery");

  // A stale report, a private address, or an unclaimed task cannot confirm.
  const before2 = (await db.getHostById(2))!;
  const id2 = await runtime.insertAndGetId("host_ip_switch_attempts", { hostId: 2, serviceId: 2, incidentId: randomUUID(), status: "pending", oldIp: "1.1.1.1", addressSnapshot: JSON.stringify(ipSwitchAddressSnapshot(before2)), createdAt: now });
  await db.updateHostHeartbeat(2, { ip: "9.9.9.9", ipv4: "9.9.9.9" } as any);
  assert.equal(await observeIpSwitchAddress((await db.getHostById(2))!), false);
  await runtime.executeRaw("UPDATE host_ip_switch_attempts SET reason = 'claimed' WHERE id = ?", [id2]);
  await db.updateHost(2, { lastHeartbeat: new Date((now - 10) * 1000) });
  assert.equal(await observeIpSwitchAddress((await db.getHostById(2))!), false);
  await db.updateHostHeartbeat(2, { ip: "10.0.0.2", ipv4: "10.0.0.2" } as any);
  assert.equal(await observeIpSwitchAddress((await db.getHostById(2))!), false);
  await db.updateHostHeartbeat(2, { ip: "9.9.9.9", ipv4: "9.9.9.9" } as any);
  assert.equal(await observeIpSwitchAddress((await db.getHostById(2))!, { refresh: async () => {}, notify: async () => {} }), true);
  await runtime.executeRaw("UPDATE host_ip_switch_attempts SET status = 'accepted' WHERE id = ? AND newIp IS NULL", [id2]);
  assert.equal((await runtime.queryRaw<any>("SELECT status FROM host_ip_switch_attempts WHERE id = ?", [id2]))[0].status, "succeeded", "late HTTP callbacks cannot overwrite observed success");
} finally {
  globalThis.fetch = originalFetch;
  streams.forEach(stream => stream.close());
  await runtime.closeDatabase();
}
