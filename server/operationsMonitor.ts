import { advanceResourceAlert, defaultOperationsMonitor, operationsMonitorSchema, type ResourceAlertState } from "../shared/operationsMonitor";
import { executeRaw, insertAndGetId, queryRaw, withDatabaseTransaction } from "./dbRuntime";
import { quoteIdentifier as q } from "./dbCompat";
import { getSetting, setSetting } from "./repositories/settingsRepository";
import { withKeyedTaskLock } from "./keyedTaskLock";
import { getNotificationAdminRecipients, sendUserNotification } from "./notifications";
import { getHosts, getLatestHostMetricRows } from "./db";
import { setBoundedMapValue } from "./boundedCache";
import { seamlessBackgroundPaused } from "./seamlessMigrationState";

const settingKey = "operationsResourceAlerts";
const observed = new Map<number, number>();
let configCache: { value: typeof defaultOperationsMonitor; until: number } | null = null;
export async function getMonitorSettings() {
  if (configCache && configCache.until > Date.now()) return configCache.value;
  let value = defaultOperationsMonitor;
  try { value = operationsMonitorSchema.parse(JSON.parse(await getSetting(settingKey) || "{}")); } catch { /* Invalid stored configuration fails closed. */ }
  configCache = { value, until: Date.now() + 5000 }; return value;
}
export async function saveMonitorSettings(value: unknown) {
  const parsed = operationsMonitorSchema.parse(value);
  await withKeyedTaskLock("operations-alert-config", async () => {
    await setSetting(settingKey, JSON.stringify(parsed));
    // A new threshold/window starts a fresh observation, not a synthetic recovery.
    await executeRaw(`DELETE FROM ${q("operations_alert_state")}`);
    observed.clear(); configCache = null;
  });
  return parsed;
}
const metricNames: Record<string, string> = { cpu: "CPU", memory: "内存", disk: "磁盘" };
const escape = (value: unknown) => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export async function observeHostResources(host: { id: number; name?: string }, values: { cpu?: number | null; memory?: number | null; disk?: number | null }, now = Math.floor(Date.now() / 1000)) {
  if (seamlessBackgroundPaused()) return;
  if (now - (observed.get(host.id) || 0) < 30) return;
  setBoundedMapValue(observed, host.id, now, 50000);
  await withKeyedTaskLock("operations-alert-config", async () => {
    const settings = await getMonitorSettings();
    if (!settings.enabled) return;
    const emitted: { metric: string; type: string; value: number }[] = [];
    await withDatabaseTransaction(async () => {
      const rows = await queryRaw<any>(`SELECT * FROM ${q("operations_alert_state")} WHERE ${q("hostId")} = ?`, [host.id]);
      for (const metric of ["cpu", "memory", "disk"] as const) {
        const value = values[metric];
        if (value == null || !Number.isFinite(value) || value < 0 || value > 100) continue;
        const row = rows.find(item => item.metric === metric);
        const previous: ResourceAlertState | null = row ? { phase: row.phase, since: Number(row.since), lastSeen: Number(row.lastSeen), peak: Number(row.peak) } : null;
        const next = advanceResourceAlert(previous, value, settings[metric], now, settings.durationSeconds, settings.recoverySeconds);
        if (row && !next.state) await executeRaw(`DELETE FROM ${q("operations_alert_state")} WHERE ${q("id")} = ?`, [row.id]);
        else if (next.state) {
          const state = { ...next.state, peak: Math.ceil(next.state.peak) };
          if (row) await executeRaw(`UPDATE ${q("operations_alert_state")} SET ${q("phase")} = ?, ${q("since")} = ?, ${q("lastSeen")} = ?, ${q("peak")} = ? WHERE ${q("id")} = ?`, [state.phase, state.since, state.lastSeen, state.peak, row.id]);
          else await insertAndGetId("operations_alert_state", { hostId: host.id, metric, ...state });
        }
        if (next.event) {
          await insertAndGetId("operations_alert_events", { hostId: host.id, hostName: String(host.name || `#${host.id}`).slice(0, 255), metric, type: next.event, value: Math.ceil(value), createdAt: now });
          emitted.push({ metric, type: next.event, value });
        }
      }
    });
    if (settings.notify && emitted.length) {
      // Do not block Agent replies on notification delivery. No automatic host/process mutations.
      void (async () => {
        const recipients = await getNotificationAdminRecipients();
        const text = [`<b>资源告警 · ${escape(host.name || `#${host.id}`)}</b>`, ...emitted.map(event => `${metricNames[event.metric]} ${event.type === "triggered" ? "持续超限" : "已恢复"}：${event.value.toFixed(1)}%`)].join("\n");
        for (const recipient of recipients) await sendUserNotification(recipient, text).catch(() => console.warn(`[OperationsMonitor] notification delivery failed host=${host.id} admin=${recipient.id}`));
      })().catch(() => console.warn(`[OperationsMonitor] notification failed host=${host.id}`));
    }
  });
}

export async function monitorOverview(page = 0) {
  const settings = await getMonitorSettings(), now = Math.floor(Date.now() / 1000);
  const [active, events, counts, admins, hosts, allSettings] = await Promise.all([
    queryRaw<any>(`SELECT a.*, h.${q("name")} AS ${q("hostName")} FROM ${q("operations_alert_state")} a INNER JOIN ${q("hosts")} h ON h.${q("id")} = a.${q("hostId")} WHERE a.${q("phase")} IN ('active','recovering') ORDER BY a.${q("since")} DESC LIMIT 50`),
    queryRaw<any>(`SELECT * FROM ${q("operations_alert_events")} WHERE ${q("createdAt")} >= ? ORDER BY ${q("id")} DESC LIMIT 20 OFFSET ${page * 20}`, [now - 30 * 86400]),
    queryRaw<any>(`SELECT COUNT(*) AS ${q("total")} FROM ${q("operations_alert_events")} WHERE ${q("createdAt")} >= ?`, [now - 30 * 86400]),
    queryRaw<any>(`SELECT COUNT(*) AS ${q("total")}, SUM(CASE WHEN ${q("twoFactorEnabled")} = ${"TRUE"} THEN 1 ELSE 0 END) AS ${q("secured")} FROM ${q("users")} WHERE ${q("role")} = 'admin'`),
    getHosts(), import("./db").then(db => db.getAllSettings()),
  ]);
  const metrics = await getLatestHostMetricRows(hosts.map((host: any) => host.id));
  const byId = new Map(hosts.map((host: any) => [host.id, host]));
  const resources = metrics.map((metric: any) => ({ hostId: metric.hostId, hostName: (byId.get(metric.hostId) as any)?.name || `#${metric.hostId}`, cpu: metric.cpuUsage, memory: metric.memoryUsage, disk: metric.diskUsage, sampledAt: metric.recordedAt, stale: Date.now() - new Date(metric.recordedAt).getTime() > 120000 }))
    .sort((a, b) => Number(a.stale) - Number(b.stale) || Math.max(Number(b.cpu), Number(b.memory), Number(b.disk)) - Math.max(Number(a.cpu), Number(a.memory), Number(a.disk))).slice(0, 10);
  return { settings, active: active.map(row => ({ ...row, stale: now - Number(row.lastSeen) > 120 })), events, total: Number(counts[0]?.total || 0), page, resources,
    security: [
      { name: "管理员双因素认证", status: Number(admins[0]?.secured || 0) === Number(admins[0]?.total || 0) ? "ok" : "warning", message: `${Number(admins[0]?.secured || 0)}/${Number(admins[0]?.total || 0)} 个管理员已开启 2FA`, messageTemplate: "{0}/{1} 个管理员已开启 2FA", messageArgs: [Number(admins[0]?.secured || 0), Number(admins[0]?.total || 0)] },
      { name: "面板公开地址", status: /^https:\/\//i.test(allSettings.panelPublicUrl || "") ? "ok" : "warning", message: /^https:\/\//i.test(allSettings.panelPublicUrl || "") ? "公开地址配置为 HTTPS；不替代实际证书验证" : "未配置 HTTPS 公开地址，请检查反向代理和证书" },
      { name: "开放注册", status: allSettings.registrationEnabled !== "false" ? "warning" : "ok", message: allSettings.registrationEnabled !== "false" ? "当前允许注册，请确认验证码、邮箱与资源授权策略" : "当前未开放注册" },
    ], sampledAt: new Date().toISOString() };
}

export async function cleanMonitorHistory() {
  const cutoff = Math.floor(Date.now() / 1000) - 30 * 86400;
  await executeRaw(`DELETE FROM ${q("operations_alert_events")} WHERE ${q("createdAt")} < ?`, [cutoff]);
  await executeRaw(`DELETE FROM ${q("operations_alert_state")} WHERE ${q("lastSeen")} < ?`, [cutoff]);
  await executeRaw(`DELETE FROM ${q("external_mcp_tokens")} WHERE ${q("expiresAt")} <= ?`, [Math.floor(Date.now() / 1000)]);
}
