import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { hostChinaHealthSchema, advanceChinaHealth, ipSwitchReasonLabels, type ChinaHealthState, type HostChinaHealthConfig, type IpSwitchHook } from "../shared/hostChinaHealth";
import { ENV } from "./env";
import { executeRaw, insertAndGetId, queryRaw } from "./dbRuntime";
import { boolLiteral, inList, quoteIdentifier as q } from "./dbCompat";
import { withKeyedTaskLock } from "./keyedTaskLock";
import { assertSafeOutboundHost } from "./ssrf";
import * as db from "./db";
import { requestIpSwitch, verifyIpSwitchResponse } from "./hostIpSwitchProvider";
import { hostIngressAddress, refreshHostAddressRuntime } from "./hostAddressRuntime";
import { getNotificationAdminRecipients, sendUserNotification } from "./notifications";
import { appendPanelLog } from "./_core/panelLogger";
import { seamlessBackgroundPaused } from "./seamlessMigrationState";
import { setBoundedMapValue } from "./boundedCache";
import { ipSwitchAgentReady, IpSwitchNotDispatchedError, type IpSwitchAgentResult } from "./agentIpSwitchTasks";

const key = createHash("sha256").update("forwardx-host-ip-switch-v1:").update(ENV.cookieSecret).digest();
const inactiveHosts = new Map<number, number>();
export function encryptIpSwitchHook(hook: IpSwitchHook) {
  const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(hook), "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), body.toString("base64")].join(":");
}
function decryptHook(value: string): IpSwitchHook {
  const [version, iv, tag, body] = value.split(":");
  if (version !== "v1") throw new Error("invalid_hook_ciphertext");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return hostChinaHealthSchema.parse({ hook: JSON.parse(Buffer.concat([decipher.update(Buffer.from(body, "base64")), decipher.final()]).toString("utf8")) }).hook!;
}
/** Sensitive detail: only call from the administrator's explicit edit request. */
export async function getProbeHealthHook(serviceId: number) {
  const [row] = await queryRaw<any>(`SELECT ${q("hookCiphertext")} FROM ${q("host_probe_health")} WHERE ${q("serviceId")} = ?`, [serviceId]);
  if (!row?.hookCiphertext) return null;
  try { return decryptHook(row.hookCiphertext); }
  catch { throw new Error("无法读取已保存的换 IP 参数，请重新配置接口"); }
}
function parseState(value: string | null): ChinaHealthState | null { try { return value ? JSON.parse(value) : null; } catch { return null; } }
export const probeHealthLock = (id: number) => `probe-health-service:${id}`;
export async function getProbeHealthViews(ids: number[]) {
  if (!ids.length) return new Map<number, any>();
  const list = inList(ids);
  const rows = await queryRaw<any>(`SELECT h.*, s.${q("intervalSeconds")} AS ${q("intervalSeconds")} FROM ${q("host_probe_health")} h LEFT JOIN ${q("host_probe_services")} s ON s.${q("id")} = h.${q("serviceId")} WHERE h.${q("serviceId")} IN ${list.sql}`, list.params);
  const attempts = await queryRaw<any>(`SELECT a.* FROM ${q("host_ip_switch_attempts")} a WHERE a.${q("id")} IN (SELECT MAX(${q("id")}) FROM ${q("host_ip_switch_attempts")} WHERE ${q("serviceId")} IN ${list.sql} GROUP BY ${q("serviceId")})`, list.params);
  const hosts = inList([...new Set(rows.map(row => Number(row.hostId)))]);
  const blocked = rows.length ? await queryRaw<any>(`SELECT a.* FROM ${q("host_ip_switch_attempts")} a WHERE a.${q("id")} IN (SELECT MAX(${q("id")}) FROM ${q("host_ip_switch_attempts")} WHERE ${q("hostId")} IN ${hosts.sql} AND ${q("status")} IN ('pending','uncertain') AND ${q("acknowledged")} = ${boolLiteral(false)} GROUP BY ${q("hostId")})`, hosts.params) : [];
  const cooldowns = rows.length ? await queryRaw<any>(`SELECT ${q("hostId")}, MAX(${q("cooldownUntil")}) AS ${q("nextAt")} FROM ${q("host_ip_switch_attempts")} WHERE ${q("hostId")} IN ${hosts.sql} GROUP BY ${q("hostId")}`, hosts.params) : [];
  const actionView = (item: any) => item ? { id: Number(item.id), status: item.status, reason: item.reason || null, httpStatus: item.httpStatus == null ? null : Number(item.httpStatus), newIp: item.newIp, createdAt: Number(item.createdAt), acknowledged: item.acknowledged === true || Number(item.acknowledged) === 1 } : null;
  return new Map(rows.map(row => {
    const config = hostChinaHealthSchema.parse(JSON.parse(row.config)), state = parseState(row.state);
    const lastAction = attempts.find(item => Number(item.serviceId) === Number(row.serviceId));
    return [Number(row.serviceId), { ...config, hook: undefined, hookConfigured: !!row.hookCiphertext, hostId: Number(row.hostId),
      agentReady: ipSwitchAgentReady(Number(row.hostId)),
      nextSwitchAt: Number(cooldowns.find(item => Number(item.hostId) === Number(row.hostId))?.nextAt || state?.actionRetryAt || 0),
      state: state ? { ...state, stale: Date.now() / 1000 - state.lastSeen > Math.max(120, Number(row.intervalSeconds || 30) * 3) } : null,
      lastAction: actionView(lastAction), blockedAction: actionView(blocked.find(item => Number(item.hostId) === Number(row.hostId))) }];
  }));
}
/** Called in the same transaction as service changes. Missing input preserves saved configuration. */
export async function saveProbeHealth(service: any, input?: HostChinaHealthConfig | null, previous?: any) {
  const [existing] = await queryRaw<any>(`SELECT * FROM ${q("host_probe_health")} WHERE ${q("serviceId")} = ?`, [service.id]);
  if (input === null) { await executeRaw(`DELETE FROM ${q("host_probe_health")} WHERE ${q("serviceId")} = ?`, [service.id]); return; }
  if (input === undefined && !existing) return;
  const config = hostChinaHealthSchema.parse(input ?? JSON.parse(existing.config));
  if (!existing && !config.enabled) return;
  const hostId = Number(service.hostIds?.[0]);
  if (config.enabled) {
    if (service.method === "url") throw new Error("国内健康检测仅支持 Ping / TCPing");
    if (service.hostScope !== "specific" || service.hostIds?.length !== 1) throw new Error("国内健康检测必须选择一台特定主机");
    if (!await db.getHostById(hostId)) throw new Error("检测主机不存在");
    if (!isIP(service.targetIp)) throw new Error("国内健康检测请填写固定公网 IP，不使用域名");
    await assertSafeOutboundHost(service.targetIp, { purpose: "国内健康检测" });
    if (Number(service.intervalSeconds) > 300) throw new Error("国内健康检测间隔不能超过 300 秒");
    if (config.autoSwitch && !config.hook && !existing?.hookCiphertext) throw new Error("自动换 IP 需要先配置商家接口");
  }
  const { hook, ...publicConfig } = config;
  const ciphertext = hook ? encryptIpSwitchHook(hook) : existing?.hookCiphertext || null;
  const reset = input !== undefined || !previous || ["targetIp", "targetPort", "method", "isEnabled"].some(field => service[field] !== previous[field]) || Number(existing?.hostId) !== hostId;
  if (existing) await executeRaw(`UPDATE ${q("host_probe_health")} SET ${q("hostId")} = ?, ${q("config")} = ?, ${q("hookCiphertext")} = ?, ${q("state")} = ?, ${q("updatedAt")} = ? WHERE ${q("id")} = ?`, [Number.isInteger(hostId) ? hostId : Number(existing.hostId), JSON.stringify(publicConfig), ciphertext, reset ? null : existing.state, Math.floor(Date.now() / 1000), existing.id]);
  else await insertAndGetId("host_probe_health", { serviceId: service.id, hostId, config: JSON.stringify(publicConfig), hookCiphertext: ciphertext, updatedAt: Math.floor(Date.now() / 1000) });
  inactiveHosts.delete(hostId); if (existing) inactiveHosts.delete(Number(existing.hostId));
}
const html = (value: unknown) => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
async function notify(service: any, host: any, message: string, config: HostChinaHealthConfig) {
  appendPanelLog("info", `[ChinaHealth] host=${host.id} service=${service.id} ${message}`);
  if (!config.notify) return;
  const recipients = await getNotificationAdminRecipients().catch(() => {
    console.warn(`[ChinaHealth] notification recipients unavailable host=${host.id} service=${service.id}`);
    return [];
  });
  for (const user of recipients) {
    await sendUserNotification(user, `<b>国内健康检测 · ${html(host.name)}</b>\n${html(service.name)}\n${html(message)}`).catch(() => {
      console.warn(`[ChinaHealth] notification failed host=${host.id} service=${service.id} user=${user.id}`);
    });
  }
}
type Dependencies = { request: typeof requestIpSwitch; notify: typeof notify; refresh: typeof refreshHostAddressRuntime; ready: typeof ipSwitchAgentReady };
const dependencies: Dependencies = { request: requestIpSwitch, notify, refresh: refreshHostAddressRuntime, ready: ipSwitchAgentReady };
async function performSwitch(row: any, service: any, host: any, state: ChinaHealthState, config: HostChinaHealthConfig, now: number, deps: Dependencies) {
  return withKeyedTaskLock(`probe-health-ip-switch:${host.id}`, async () => {
    // Authentication deliberately supplies only an ID/name, not mutable addresses.
    // Hydrate lazily on the action path, never on every healthy Agent report.
    const snapshot = await db.getHostById(host.id);
    const expectedIp = hostIngressAddress(host) || hostIngressAddress(snapshot);
    if (snapshot) host = snapshot;
    let attemptId: number;
    let blockedMessage = "";
    const allowed = await withKeyedTaskLock(probeHealthLock(service.id), async () => {
      const [currentRow] = await queryRaw<any>(`SELECT * FROM ${q("host_probe_health")} WHERE ${q("serviceId")} = ? AND ${q("hostId")} = ?`, [service.id, host.id]);
      const currentState = parseState(currentRow?.state);
      if (!currentRow || !currentState || currentState.phase !== "unhealthy" || currentState.actionAttempted || currentState.incidentId !== state.incidentId) return false;
      row = currentRow; state = currentState;
      config = hostChinaHealthSchema.parse(JSON.parse(row.config));
      if (state.failures < config.failureThreshold || !state.failureSince || now - state.failureSince < config.failureSeconds) return false;
      service = await db.getHostProbeServiceById(service.id);
      if (!config.enabled || !config.autoSwitch || !row.hookCiphertext || !service?.isEnabled || service.hostScope !== "specific" || service.hostIds.length !== 1 || service.hostIds[0] !== host.id) return false;
      const defer = async (reason: NonNullable<ChinaHealthState["actionBlockedReason"]>, message: string, retryAt = 0) => {
        if (state.actionBlockedReason !== reason || state.actionRetryAt !== retryAt) {
          state.actionBlockedReason = reason; state.actionRetryAt = retryAt;
          await executeRaw(`UPDATE ${q("host_probe_health")} SET ${q("state")} = ? WHERE ${q("id")} = ?`, [JSON.stringify(state), row.id]);
          blockedMessage = message;
        }
        return false;
      };
      if (!deps.ready(host.id)) return defer("agent_unavailable", "自动换 IP 等待中：Agent 未在线上报换 IP 能力，尚未请求商家接口");
      const [limits] = await queryRaw<any>(`SELECT COUNT(*) AS ${q("count")}, MIN(${q("createdAt")}) AS ${q("firstAt")} FROM ${q("host_ip_switch_attempts")} WHERE ${q("hostId")} = ? AND ${q("createdAt")} > ?`, [host.id, now - 86400]);
      const [latest] = await queryRaw<any>(`SELECT ${q("createdAt")}, ${q("finishedAt")}, ${q("cooldownUntil")} FROM ${q("host_ip_switch_attempts")} WHERE ${q("hostId")} = ? ORDER BY ${q("createdAt")} DESC, ${q("id")} DESC LIMIT 1`, [host.id]);
      const unresolved = await queryRaw<any>(`SELECT ${q("id")} FROM ${q("host_ip_switch_attempts")} WHERE ${q("hostId")} = ? AND ${q("status")} IN ('pending','uncertain') AND ${q("acknowledged")} = ${boolLiteral(false)} LIMIT 1`, [host.id]);
      if (unresolved.length) return defer("unresolved", "自动换 IP 已暂停：上次请求结果不明确，请先核对商家结果");
      // Measure the merchant interval from completion, not merely queueing.
      // History is host-wide, so editing/recreating services cannot bypass it.
      const nextAt = latest ? Math.max(Number(latest.cooldownUntil || 0), Math.max(Number(latest.createdAt), Number(latest.finishedAt || 0)) + config.cooldownSeconds) : 0;
      if (nextAt > now) return defer("cooldown", `自动换 IP 等待中：商家请求间隔尚未结束，剩余 ${Math.ceil((nextAt - now) / 60)} 分钟`, nextAt);
      if (Number(limits?.count || 0) >= config.maxSwitchesPerDay) return defer("daily_limit", "自动换 IP 等待中：已达到最近 24 小时请求上限", Number(limits.firstAt) + 86400);
      const freshHost = await db.getHostById(host.id);
      if (!freshHost || !expectedIp) return defer("host_address_unavailable", "自动换 IP 等待中：主机不存在或入口地址为空，尚未请求商家接口");
      if (hostIngressAddress(freshHost) !== expectedIp) return defer("host_address_changed", "自动换 IP 等待中：主机地址已变更，等待下一次探测，尚未请求商家接口");
      // Persist intent BEFORE any request: a crash or timeout must not silently retry a paid action.
      attemptId = await insertAndGetId("host_ip_switch_attempts", { hostId: host.id, serviceId: service.id, incidentId: state.incidentId, status: "pending", createdAt: now, cooldownUntil: now + config.cooldownSeconds });
      state.actionAttempted = true;
      delete state.actionBlockedReason; delete state.actionRetryAt;
      await executeRaw(`UPDATE ${q("host_probe_health")} SET ${q("state")} = ? WHERE ${q("id")} = ?`, [JSON.stringify(state), row.id]);
      return true;
    });
    if (!allowed) {
      if (blockedMessage) await deps.notify(service, host, blockedMessage, config);
      return;
    }
    let status = "uncertain", newIp: string | null = null, message = "换 IP 请求结果未确认，已停止自动重试，请核对商家结果";
    let reason: string = "request_failed", httpStatus: number | null = null;
    try {
      let hook: IpSwitchHook;
      try { hook = decryptHook(row.hookCiphertext); }
      catch { throw new IpSwitchNotDispatchedError("invalid_request"); }
      const response = await deps.request(hook, { hostId: host.id, serviceId: service.id, ip: expectedIp, incidentId: state.incidentId });
      reason = response.reason; httpStatus = response.httpStatus ?? null;
      if (response.outcome === "not_executed") {
        status = "not_executed"; message = `Agent 未执行换 IP 请求：${ipSwitchReasonMessage(response.reason)}；后续仍遵循商家请求间隔`;
        throw new Error("not_executed");
      }
      if (response.outcome === "uncertain") {
        message = `换 IP 请求结果未确认：${ipSwitchReasonMessage(response.reason)}${httpStatus ? `（HTTP ${httpStatus}）` : ""}；已停止自动重试，请核对商家结果`;
      }
      newIp = await verifyIpSwitchResponse(hook, response, expectedIp);
      status = response.outcome === "accepted" ? "accepted" : "succeeded";
      message = response.outcome === "accepted" ? "商家接口已接收请求（HTTP 2xx），实际换 IP 结果以后续探测或商家状态为准" : "商家接口确认换 IP 请求成功，等待后续探测恢复";
      if (newIp && hook.updateAddress !== "none") {
        const current = await db.getHostById(host.id);
        if (current && hostIngressAddress(current) === expectedIp) {
          status = "sync_failed"; message = "商家接口已成功，但面板地址或关联链路同步失败，请检查配置";
          await db.updateHost(host.id, { entryIp: newIp, ...(hook.updateAddress === "entry_and_tunnel" ? { tunnelEntryIp: newIp } : {}) });
          await deps.refresh(host.id, current, "china-health-ip-switch");
          status = "succeeded";
          message = `商家接口确认换 IP 请求成功，已同步主机地址 ${newIp}，等待后续探测恢复`;
        } else { status = "sync_skipped"; message = "商家接口确认成功，但主机地址已变更或主机已删除，未覆盖面板配置"; }
      }
    } catch (error) {
      if (error instanceof IpSwitchNotDispatchedError) {
        status = "not_executed"; reason = error.message === "invalid_request" ? "invalid_request" : "agent_unavailable";
        message = `换 IP 任务未下发给 Agent：${ipSwitchReasonMessage(reason)}；尚未调用商家接口，后续仍遵循商家请求间隔`;
      } else if (status === "uncertain" && reason === "ok") {
        reason = newIp || (error instanceof Error && error.message === "provider_invalid_new_ip") ? "invalid_ip" : "success_mismatch";
        message = `换 IP 请求结果未确认：${ipSwitchReasonMessage(reason)}；已停止自动重试，请核对商家结果`;
      }
      // Neither exception messages nor response bodies are safe to log (URLs/headers may contain keys).
      // Even HTTP errors can follow a successful provider-side action: require operator verification.
    }
    const finishedAt = Math.max(now, Math.floor(Date.now() / 1000));
    await executeRaw(`UPDATE ${q("host_ip_switch_attempts")} SET ${q("status")} = ?, ${q("reason")} = ?, ${q("httpStatus")} = ?, ${q("newIp")} = ?, ${q("finishedAt")} = ?, ${q("cooldownUntil")} = ? WHERE ${q("id")} = ?`, [status, reason, httpStatus, newIp, finishedAt, finishedAt + config.cooldownSeconds, attemptId!]);
    if (status === "not_executed") {
      // A definite non-execution is safe to schedule again after the interval.
      // Give it a fresh durable task ID; ambiguous/accepted requests NEVER retry.
      await withKeyedTaskLock(probeHealthLock(service.id), async () => {
        const [current] = await queryRaw<any>(`SELECT ${q("state")} FROM ${q("host_probe_health")} WHERE ${q("id")} = ?`, [row.id]);
        const next = parseState(current?.state);
        if (next?.incidentId !== state.incidentId) return;
        next.actionAttempted = false; next.incidentId = randomUUID();
        await executeRaw(`UPDATE ${q("host_probe_health")} SET ${q("state")} = ? WHERE ${q("id")} = ?`, [JSON.stringify(next), row.id]);
      });
    }
    await deps.notify(service, host, message, config);
  });
}

export function ipSwitchReasonMessage(reason: IpSwitchAgentResult["reason"] | string) {
  return ipSwitchReasonLabels[reason] || "请求结果未确认";
}
const observingHosts = new Set<number>();
export async function observeProbeHealth(host: any, reports: { serviceId: number; targetIp?: string; targetPort?: number; method?: string; probeSuccesses?: number; probeCount?: number }[], now = Math.floor(Date.now() / 1000), overrides: Partial<Dependencies> = {}) {
  if (seamlessBackgroundPaused() || observingHosts.has(host.id) || (inactiveHosts.get(host.id) || 0) > Date.now()) return;
  observingHosts.add(host.id);
  const deps = { ...dependencies, ...overrides };
  const actions: (() => Promise<unknown>)[] = [];
  try {
    const configured = await queryRaw<any>(`SELECT ${q("serviceId")}, ${q("config")} FROM ${q("host_probe_health")} WHERE ${q("hostId")} = ?`, [host.id]);
    const enabledIds = new Set(configured.filter(row => hostChinaHealthSchema.parse(JSON.parse(row.config)).enabled).map(row => Number(row.serviceId)));
    if (!enabledIds.size) { setBoundedMapValue(inactiveHosts, host.id, Date.now() + 30000, 50000); return; }
    for (const report of new Map(reports.map(report => [Number(report.serviceId), report])).values()) {
      if (!enabledIds.has(report.serviceId)) continue;
      await withKeyedTaskLock(probeHealthLock(report.serviceId), async () => {
      const [row] = await queryRaw<any>(`SELECT * FROM ${q("host_probe_health")} WHERE ${q("serviceId")} = ? AND ${q("hostId")} = ?`, [report.serviceId, host.id]);
      if (!row) return;
      const config = hostChinaHealthSchema.parse(JSON.parse(row.config));
      if (!config.enabled) return;
      const service = await db.getHostProbeServiceById(report.serviceId);
      if (!service?.isEnabled || service.hostScope !== "specific" || service.hostIds.length !== 1 || service.hostIds[0] !== Number(host.id)) return;
      if (report.targetIp !== service.targetIp || report.method !== service.method || Number(report.targetPort || 0) !== Number(service.targetPort || 0) || !Number.isInteger(report.probeCount) || Number(report.probeCount) <= 0 || !Number.isInteger(report.probeSuccesses) || Number(report.probeSuccesses) < 0 || Number(report.probeSuccesses) > Number(report.probeCount)) return;
      const previous = parseState(row.state);
      const next = advanceChinaHealth(previous, Number(report.probeSuccesses) > 0, now, service.intervalSeconds, config);
      if (previous && previous.lastSeen === next.state.lastSeen) return;
      if (next.event === "unhealthy") next.state.incidentId = randomUUID();
      await executeRaw(`UPDATE ${q("host_probe_health")} SET ${q("state")} = ? WHERE ${q("id")} = ?`, [JSON.stringify(next.state), row.id]);
      if (next.event) await deps.notify(service, host, next.event === "unhealthy" ? "连续探测失败，疑似国内连通异常；不等同于确认被墙" : "国内连通已恢复", config);
      if (next.state.phase === "unhealthy" && next.state.incidentId && !next.state.actionAttempted && config.autoSwitch && row.hookCiphertext) actions.push(() => performSwitch(row, service, host, next.state, config, now, deps));
      });
    }
  } finally { observingHosts.delete(host.id); }
  // Keep observations and edits responsive while the Agent/vendor is in flight.
  await Promise.all(actions.map(action => action()));
}
export async function acknowledgeIpSwitch(serviceId: number) {
  const service = await db.getHostProbeServiceById(serviceId);
  if (!service) throw new Error("服务不存在");
  const [health] = await queryRaw<any>(`SELECT ${q("hostId")} FROM ${q("host_probe_health")} WHERE ${q("serviceId")} = ?`, [serviceId]);
  if (!health) throw new Error("国内健康检测配置不存在");
  // A pending request could still be in flight. Only unlock one older than the maximum request timeout.
  await executeRaw(`UPDATE ${q("host_ip_switch_attempts")} SET ${q("acknowledged")} = ${boolLiteral(true)} WHERE ${q("hostId")} = ? AND ${q("status")} IN ('pending','uncertain') AND ${q("createdAt")} < ?`, [health.hostId, Math.floor(Date.now() / 1000) - 150]);
  appendPanelLog("info", `[ChinaHealth] acknowledged uncertain IP switch service=${serviceId}`);
}
/** Final machine-to-machine check, not human confirmation. Never returns credentials. */
export async function validateIpSwitchClaim(hostId: number, serviceId: number, incidentId: string, expectedIp: string) {
  if (seamlessBackgroundPaused()) return false;
  const [row] = await queryRaw<any>(`SELECT * FROM ${q("host_probe_health")} WHERE ${q("serviceId")} = ? AND ${q("hostId")} = ?`, [serviceId, hostId]);
  if (!row) return false;
  const config = hostChinaHealthSchema.parse(JSON.parse(row.config)), state = parseState(row.state);
  const service = await db.getHostProbeServiceById(serviceId);
  const host = await db.getHostById(hostId);
  const [attempt] = await queryRaw<any>(`SELECT ${q("status")} FROM ${q("host_ip_switch_attempts")} WHERE ${q("incidentId")} = ? AND ${q("hostId")} = ?`, [incidentId, hostId]);
  return !!(host && hostIngressAddress(host) === expectedIp && config.enabled && config.autoSwitch && service?.isEnabled && service.hostScope === "specific" && service.hostIds.length === 1 && service.hostIds[0] === hostId && state?.incidentId === incidentId && state.phase === "unhealthy" && state.actionAttempted && attempt?.status === "pending");
}
export async function cleanProbeHealthHistory() {
  await executeRaw(`DELETE FROM ${q("host_ip_switch_attempts")} WHERE ${q("createdAt")} < ? AND (${q("status")} NOT IN ('pending','uncertain') OR ${q("acknowledged")} = ${boolLiteral(true)})`, [Math.floor(Date.now() / 1000) - 90 * 86400]);
}
