import { isIP } from "node:net";
import * as db from "./db";
import { executeRaw, queryRaw } from "./dbRuntime";
import { quoteIdentifier as q } from "./dbCompat";
import { withKeyedTaskLock } from "./keyedTaskLock";
import { assertSafeOutboundHost } from "./ssrf";
import { handleHostAddressChanged } from "./hostAddressRuntime";
import { normalizeHostIp, parseHostAddresses } from "../shared/hostAddresses";
import { hostChinaHealthSchema } from "../shared/hostChinaHealth";
import { appendPanelLog } from "./_core/panelLogger";
import { recordConfigAuditEvent } from "./configAudit";
import { getNotificationAdminRecipients, sendUserNotification } from "./notifications";
import { seamlessBackgroundPaused } from "./seamlessMigrationState";

const snapshotFields = ["ip", "ipv4", "ipv6", "ipv4Addresses", "ipv6Addresses", "entryIp", "tunnelEntryIp", "preferredIpv4", "preferredIpv6", "agentInstallationId"] as const;
export function ipSwitchAddressSnapshot(host: any) {
  return Object.fromEntries(snapshotFields.map(field => [field, host?.[field] ?? null]));
}

// Only compare the same address family. Missing reports, known secondary IPs,
// a provider's response, and changes to an unrelated family are not proof.
export function observedIpSwitchAddress(previous: any, current: any, expectedIp: string) {
  const family = isIP(expectedIp) === 6 || (!isIP(expectedIp) && !previous?.ipv4 && previous?.ipv6) ? "ipv6" : "ipv4";
  const oldIp = normalizeHostIp(previous?.[family], family) || normalizeHostIp(previous?.ip, family);
  const nextIp = normalizeHostIp(current?.[family], family);
  if (!oldIp || !nextIp || oldIp === nextIp) return null;
  if (isIP(expectedIp) && normalizeHostIp(expectedIp, family) !== oldIp) return null;
  if (parseHostAddresses(previous?.[`${family}Addresses`], family).includes(nextIp)) return null;
  return { oldIp, newIp: nextIp };
}

export function ipSwitchAddressPatch(previous: any, current: any, oldIp: string, newIp: string) {
  const family = isIP(oldIp) === 6 ? "ipv6" : "ipv4";
  const patch: Record<string, string> = {};
  const otherFamily = family === "ipv4" ? "ipv6" : "ipv4";
  const otherChange = previous?.[otherFamily] ? observedIpSwitchAddress(previous, current, previous[otherFamily]) : null;
  for (const change of [{ oldIp, newIp }, ...(otherChange ? [otherChange] : [])]) {
    const changeFamily = isIP(change.oldIp) === 6 ? "ipv6" : "ipv4";
    for (const field of ["entryIp", "tunnelEntryIp", changeFamily === "ipv4" ? "preferredIpv4" : "preferredIpv6"]) {
      // A custom domain, private endpoint, or concurrent administrator edit wins.
      if (normalizeHostIp(previous?.[field], changeFamily) === change.oldIp && current?.[field] === previous?.[field]) patch[field] = change.newIp;
    }
  }
  return patch;
}

async function notifyObservedSwitch(attempt: any, host: any, newIp: string) {
  const message = `Agent 已检测到主机 IP 变更为 ${newIp}，换 IP 成功；已刷新关联转发配置，实际连通性以后续探测为准`;
  appendPanelLog("info", `[ChinaHealth] host=${host.id} service=${attempt.serviceId} task=${attempt.incidentId} stage=ip_change_confirmed ${message}`);
  const [health] = await queryRaw<any>(`SELECT ${q("config")} FROM ${q("host_probe_health")} WHERE ${q("serviceId")} = ?`, [attempt.serviceId]);
  if (!health || !hostChinaHealthSchema.parse(JSON.parse(health.config)).notify) return;
  for (const user of await getNotificationAdminRecipients()) {
    await sendUserNotification(user, message).catch(() => console.warn(`[ChinaHealth] IP change notification failed host=${host.id} user=${user.id}`));
  }
}

type ObservationOptions = { refresh?: typeof handleHostAddressChanged; notify?: typeof notifyObservedSwitch };
/** Caller must supply the persisted host, never the provider response or request source IP. */
export async function observeIpSwitchAddress(host: any, options: ObservationOptions = {}): Promise<boolean> {
  if (seamlessBackgroundPaused()) return false;
  return withKeyedTaskLock(`ip-switch-address-observation:${host.id}`, async () => {
    const [attempt] = await queryRaw<any>(`SELECT * FROM ${q("host_ip_switch_attempts")} WHERE ${q("hostId")} = ? ORDER BY ${q("id")} DESC LIMIT 1`, [host.id]);
    if (!attempt?.addressSnapshot || !["pending", "accepted", "uncertain", "sync_pending", "sync_failed"].includes(attempt.status) || (attempt.status === "pending" && attempt.reason !== "claimed")) return false;
    let previous: any;
    try { previous = JSON.parse(attempt.addressSnapshot); } catch { return false; }
    if (previous.agentInstallationId && host.agentInstallationId !== previous.agentInstallationId) return false;
    const change = observedIpSwitchAddress(previous, host, String(attempt.oldIp || ""));
    const heartbeatAt = new Date(host.lastHeartbeat || 0).getTime() / 1000;
    if (!change || !Number.isFinite(heartbeatAt) || heartbeatAt < Number(attempt.createdAt)) return false;
    try { await assertSafeOutboundHost(change.newIp, { purpose: "Agent 上报的新 IP" }); } catch { return false; }
    // Persist observed proof first. A late HTTP result must never overwrite it.
    await executeRaw(`UPDATE ${q("host_ip_switch_attempts")} SET ${q("status")} = 'sync_pending', ${q("newIp")} = ? WHERE ${q("id")} = ?`, [change.newIp, attempt.id]);
    try {
      const current = await db.getHostById(host.id);
      if (!current || observedIpSwitchAddress(previous, current, String(attempt.oldIp || ""))?.newIp !== change.newIp) return false;
      const patch = ipSwitchAddressPatch(previous, current, change.oldIp, change.newIp);
      for (const address of new Set(Object.values(patch))) await assertSafeOutboundHost(address, { purpose: "Agent 上报的新 IP" });
      for (const [field, address] of Object.entries(patch)) {
        // Compare-and-set also protects an edit made after the host read above.
        await executeRaw(`UPDATE ${q("hosts")} SET ${q(field)} = ?, ${q("updatedAt")} = ? WHERE ${q("id")} = ? AND ${q(field)} = ?`, [address, Math.floor(Date.now() / 1000), host.id, current[field as keyof typeof current]]);
      }
      const updated = Object.keys(patch).length ? await db.getHostById(host.id) : current;
      if (!updated) return false;
      if (Object.keys(patch).length) await recordConfigAuditEvent({ resourceType: "host", resourceId: host.id, hostId: host.id, action: "update", before: current, after: updated });
      Object.assign(host, updated);
      await (options.refresh || handleHostAddressChanged)(host.id, host, { ...previous, id: host.id }, "china-health-ip-observed", { forceRuntimeRefresh: true, retryDdnsFailures: true });
    } catch {
      await executeRaw(`UPDATE ${q("host_ip_switch_attempts")} SET ${q("status")} = 'sync_failed', ${q("reason")} = 'runtime_sync_failed' WHERE ${q("id")} = ?`, [attempt.id]);
      if (attempt.status !== "sync_failed") appendPanelLog("warn", `[ChinaHealth] host=${host.id} service=${attempt.serviceId} stage=address_sync_failed IP 已变化，关联配置或 DDNS 同步失败；将重试同步，不会再次请求换 IP`);
      return false;
    }
    await executeRaw(`UPDATE ${q("host_ip_switch_attempts")} SET ${q("status")} = 'succeeded', ${q("reason")} = 'ip_changed', ${q("finishedAt")} = ? WHERE ${q("id")} = ?`, [Math.floor(Date.now() / 1000), attempt.id]);
    await (options.notify || notifyObservedSwitch)(attempt, host, change.newIp).catch(() => console.warn(`[ChinaHealth] IP change notification unavailable host=${host.id}`));
    return true;
  });
}

let observationCursor = 0;
/** Bounded recovery for panel restarts, missed callbacks and failed config sync. */
export async function reconcileIpSwitchAddresses() {
  const rows = await queryRaw<any>(`SELECT ${q("id")}, ${q("hostId")} FROM ${q("host_ip_switch_attempts")} WHERE ${q("id")} > ? AND ${q("createdAt")} >= ? AND ${q("addressSnapshot")} IS NOT NULL AND ${q("status")} IN ('pending','accepted','uncertain','sync_pending','sync_failed') ORDER BY ${q("id")} LIMIT 50`, [observationCursor, Math.floor(Date.now() / 1000) - 86400]);
  observationCursor = rows.length === 50 ? Number(rows[rows.length - 1].id) : 0;
  for (const hostId of new Set(rows.map(row => Number(row.hostId)))) {
    const host = await db.getHostById(hostId);
    if (host) await observeIpSwitchAddress(host);
  }
}
