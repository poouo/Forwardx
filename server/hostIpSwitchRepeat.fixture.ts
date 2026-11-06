import assert from "node:assert/strict";
import * as runtime from "./dbRuntime";
import * as db from "./db";
import { ensureDatabaseSchema } from "./dbSchema";
import { hostsRouter } from "./routers/hosts";
import { hostChinaHealthSchema } from "../shared/hostChinaHealth";
import { getProbeHealthViews, observeProbeHealth, validateIpSwitchClaim } from "./hostProbeHealth";
import { observeIpSwitchAddress } from "./hostIpSwitchObservation";

await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB! } });
const realNow = Date.now;
let clock = Math.floor(realNow() / 1000);
Date.now = () => clock * 1000;
try {
  await ensureDatabaseSchema();
  await runtime.insertAndGetId("users", { id: 1, username: "admin", password: "test", name: "Admin", role: "admin" });
  const admin = hostsRouter.createCaller({ user: { id: 1, role: "admin" }, req: { headers: {}, socket: {} }, res: {}, authSession: null, authFailureReason: null } as any);
  async function scenario(hostId: number, outcome: "accepted" | "uncertain" = "accepted", dailyLimit = 2) {
    const base = clock + 1000;
    clock = base;
    await runtime.insertAndGetId("hosts", { id: hostId, userId: 1, name: `Host ${hostId}`, ip: "1.1.1.1", ipv4: "1.1.1.1", agentToken: `local-test-${hostId}` });
    const health = hostChinaHealthSchema.parse({ enabled: true, autoSwitch: true, notify: false,
      failureThreshold: 2, failureSeconds: 30, cooldownSeconds: 300, maxSwitchesPerDay: dailyLimit,
      hook: { url: "http://10.0.0.1/test-only-do-not-request" },
    });
    const { id } = await admin.createProbeService({ name: `Probe ${hostId}`, method: "tcping", targetIp: "223.5.5.5", targetPort: 443,
      hostScope: "specific", hostIds: [hostId], intervalSeconds: 15, health });
    const requests: { incidentId: string; ip: string }[] = [];
    const deps = { ready: () => true, refresh: async () => {}, notify: async () => {}, request: async (_hook: any, context: any) => {
      assert.equal(await validateIpSwitchClaim(hostId, id, context.incidentId, context.ip), true);
      requests.push({ incidentId: context.incidentId, ip: context.ip });
      return { taskId: context.incidentId, outcome, reason: outcome === "accepted" ? "ok" as const : "request_failed" as const };
    } };
    const report = { serviceId: id, targetIp: "223.5.5.5", targetPort: 443, method: "tcping", probeCount: 3, probeSuccesses: 0 };
    const sample = async (offset: number, success = false) => {
      clock = base + offset;
      await observeProbeHealth({ id: hostId, name: `Host ${hostId}` }, [{ ...report, probeSuccesses: success ? 3 : 0 }], clock, deps);
    };
    const view = async () => (await getProbeHealthViews([id])).get(id);
    const confirm = async (offset: number, ip: string) => {
      clock = base + offset;
      await db.updateHost(hostId, { ip, ipv4: ip, lastHeartbeat: new Date(clock * 1000) } as any);
      assert.equal(await observeIpSwitchAddress(await db.getHostById(hostId), { refresh: deps.refresh, notify: async () => {} }), true);
      assert.equal((await view()).lastAction.reason, "ip_changed");
    };
    for (const offset of [0, 15, 30]) await sample(offset);
    assert.equal(requests.length, 1);
    assert.equal((await view()).state.actionAttempted, true);
    return { base, id, requests, sample, view, confirm };
  }

  // No successful reachability samples between IP allocations: this is the
  // production failure case, not recovery followed by a separate outage.
  const repeat = await scenario(1);
  await repeat.confirm(45, "8.8.8.8");
  await repeat.sample(45);
  let state = (await repeat.view()).state;
  assert.equal(state.actionAttempted, false, "confirmed IP changes must rearm monitoring even when the new IP is still unreachable");
  assert.equal(state.failures, 1, "old IP failures cannot count against the new IP");
  assert.equal(state.failureSince, repeat.base + 45);
  assert.notEqual(state.incidentId, repeat.requests[0].incidentId);
  for (let offset = 60; offset <= 330; offset += 15) await repeat.sample(offset);
  assert.equal(repeat.requests.length, 1, "confirmation must not bypass the host-wide merchant interval");
  assert.equal((await repeat.view()).state.actionBlockedReason, "cooldown");
  await Promise.all([repeat.sample(345), repeat.sample(345)]);
  assert.equal(repeat.requests.length, 2, "the next interval must allow another switch without requiring a healthy sample first");
  assert.equal(repeat.requests[1].ip, "8.8.8.8");
  assert.notEqual(repeat.requests[0].incidentId, repeat.requests[1].incidentId);
  await repeat.confirm(360, "8.8.4.4");
  for (let offset = 360; offset <= 660; offset += 15) await repeat.sample(offset);
  assert.equal(repeat.requests.length, 2, "each newly confirmed IP still consumes the rolling daily limit");
  state = (await repeat.view()).state;
  assert.equal(state.actionBlockedReason, "daily_limit");
  assert.equal(state.lastSeen, repeat.base + 660, "monitoring continues even when no more switches are permitted");
  for (const offset of [675, 690]) await repeat.sample(offset, true);
  assert.equal((await repeat.view()).state.phase, "healthy");

  const accepted = await scenario(2);
  for (let offset = 45; offset <= 660; offset += 15) await accepted.sample(offset);
  assert.equal(accepted.requests.length, 1, "a receipt alone is not permission to repeat a possibly paid action");

  const legacy = await scenario(5);
  await runtime.executeRaw("UPDATE host_ip_switch_attempts SET status = 'succeeded', reason = 'ok', newIp = ? WHERE incidentId = ?", ["8.8.8.8", legacy.requests[0].incidentId]);
  for (let offset = 45; offset <= 660; offset += 15) await legacy.sample(offset);
  assert.equal(legacy.requests.length, 1, "legacy provider-reported success must not substitute for an Agent-confirmed IP change");

  const syncFailure = await scenario(6);
  clock = syncFailure.base + 45;
  await db.updateHost(6, { ip: "8.8.8.8", ipv4: "8.8.8.8", lastHeartbeat: new Date(clock * 1000) } as any);
  assert.equal(await observeIpSwitchAddress(await db.getHostById(6), { refresh: async () => { throw new Error("test runtime sync failure"); }, notify: async () => {} }), false);
  assert.equal((await syncFailure.view()).lastAction.status, "sync_failed");
  for (let offset = 45; offset <= 660; offset += 15) await syncFailure.sample(offset);
  assert.equal(syncFailure.requests.length, 1, "failed config sync must recover before a new paid switch can be scheduled");
  await syncFailure.confirm(675, "8.8.8.8");
  for (let offset = 675; offset <= 975; offset += 15) await syncFailure.sample(offset);
  assert.equal(syncFailure.requests.length, 2, "successful config-sync retry unlocks the next monitoring round");

  const uncertain = await scenario(3, "uncertain");
  for (let offset = 45; offset <= 330; offset += 15) await uncertain.sample(offset);
  assert.equal(uncertain.requests.length, 1);
  await uncertain.confirm(345, "9.9.9.9");
  // Reconnect before the next health report: unlocking relies on durable
  // proof and state, never an in-memory callback from the original request.
  await runtime.closeDatabase();
  await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB! } });
  for (let offset = 345; offset <= 645; offset += 15) await uncertain.sample(offset);
  assert.equal(uncertain.requests.length, 2, "persisted proof must unlock an earlier ambiguous request after reconnect too");

  const gap = await scenario(4);
  await gap.confirm(45, "8.8.4.4");
  await gap.sample(600);
  assert.equal(gap.requests.length, 1, "an expired interval alone cannot replace fresh sustained failures");
  for (const offset of [615, 630]) await gap.sample(offset);
  assert.equal(gap.requests.length, 2);
} finally {
  Date.now = realNow;
  await runtime.closeDatabase();
}
