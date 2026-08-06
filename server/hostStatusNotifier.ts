import * as db from "./db";
import { ENV } from "./env";
import { sendTelegramMessage } from "./telegramBot";
import { clearTunnelRuntimeStatusForHost } from "./tunnelRuntimeStatus";
import { partitionHostsByRecentAgentActivity } from "./agentActivity";
import {
  getPresenceCapableHostLivenessSnapshot,
  isPresenceCapableHostConfirmedOffline,
  subscribeAgentFastLiveness,
  type AgentFastLivenessTransition,
} from "./agentFastLiveness";
import { withKeyedTaskLock } from "./keyedTaskLock";

type HostStatus = "online" | "offline";

const lastKnownStatus = new Map<number, HostStatus>();
const FAST_LIVENESS_RETRY_DELAYS_MS = [0, 1_000, 3_000, 7_000, 15_000] as const;
let hostStatusNotifierPrimed = false;

function waitForRetry(delayMs: number) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, delayMs);
    timer.unref?.();
  });
}

function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function formatTime(value = new Date()) {
  return value.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
}

function hostName(host: any) {
  return String(host?.name || `主机 ${host?.id || ""}`).trim();
}

function hostAddress(host: any) {
  const seen = new Set<string>();
  const values = [host?.ip, host?.ipv4, host?.ipv6]
    .map((value) => String(value || "").trim())
    .filter((value) => value && value.toLowerCase() !== "unknown")
    .filter((value) => {
      const key = value.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  return values.join(" / ") || "-";
}

function hostStatusMessage(host: any, status: HostStatus) {
  const online = status === "online";
  const marker = online ? "🟢" : "🔴";
  const title = online ? "ForwardX 主机上线通知" : "ForwardX 主机离线告警";
  const statusLabel = online ? "在线" : "离线";
  const statusText = online ? "Agent 已重新连接面板" : "心跳超时，主机已被标记离线";
  return [
    `<b>${marker} ${escapeHtml(title)}</b>`,
    "",
    `<b>状态</b>：${marker} ${escapeHtml(statusLabel)}`,
    `<b>主机</b>：${escapeHtml(hostName(host))} (#${escapeHtml(host?.id || "-")})`,
    `<b>地址</b>：<code>${escapeHtml(hostAddress(host))}</code>`,
    `<b>说明</b>：${escapeHtml(statusText)}`,
    `<b>时间</b>：${escapeHtml(formatTime())}`,
  ].join("\n");
}

export function isHostStatusOnline(host: any) {
  if (!host?.lastHeartbeat) return false;
  const last = new Date(host.lastHeartbeat as any).getTime();
  return !!host?.isOnline
    && Number.isFinite(last)
    && Date.now() - last <= db.HOST_ONLINE_TTL_MS
    && !isPresenceCapableHostConfirmedOffline(host?.id);
}

async function telegramHostStatusEnabled() {
  const settings = await db.getAllSettings();
  const envToken = ENV.telegramBotToken.trim();
  const botEnabled = settings.telegramBotEnabled === "true" || (!!envToken && settings.telegramBotEnabled !== "false");
  const botConfigured = !!String(settings.telegramBotToken || envToken).trim();
  return settings.telegramHostStatusNotify === "true" && botEnabled && botConfigured;
}

async function sendHostStatusTelegram(host: any, status: HostStatus) {
  if (!(await telegramHostStatusEnabled())) return;
  const recipients = await db.getTelegramAdminRecipients();
  if (recipients.length === 0) return;
  const text = hostStatusMessage(host, status);
  let sent = 0;
  let failed = 0;
  for (const user of recipients as any[]) {
    if (!user.telegramId) continue;
    try {
      await sendTelegramMessage(user.telegramId, text);
      sent += 1;
    } catch (error) {
      failed += 1;
      console.warn(`[Telegram] Host status notify failed user=${user.id} host=${host?.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (sent > 0 || failed > 0) {
    console.info(`[Telegram] Host status notify status=${status} host=${host?.id} sent=${sent} failed=${failed}`);
  }
}

async function notifyHostStatusChange(host: any, status: HostStatus) {
  const hostId = Number(host?.id || 0);
  if (!Number.isFinite(hostId) || hostId <= 0) return;
  const previous = lastKnownStatus.get(hostId);
  if (previous === status) return;

  if (previous === undefined) {
    lastKnownStatus.set(hostId, status);
    if (hostStatusNotifierPrimed && status === "online") {
      await sendHostStatusTelegram(host, status);
    }
    return;
  }

  lastKnownStatus.set(hostId, status);
  await sendHostStatusTelegram(host, status);
}

export async function primeHostStatusNotifier() {
  try {
    const [hosts, staleOnlineHosts] = await Promise.all([
      db.getHosts(),
      db.getStaleOnlineHosts(),
    ]);
    for (const host of hosts as any[]) {
      lastKnownStatus.set(Number(host.id), host.isOnline ? "online" : "offline");
    }
    const staleIds = (staleOnlineHosts as any[]).map((host) => Number(host.id)).filter((id) => Number.isFinite(id) && id > 0);
    if (staleIds.length > 0) {
      const transitionedIds = await db.markStaleHostsOffline(staleIds);
      for (const hostId of transitionedIds) {
        lastKnownStatus.set(hostId, "offline");
        clearTunnelRuntimeStatusForHost(hostId);
      }
      if (transitionedIds.length > 0) {
        console.info(`[HostStatus] Primed ${transitionedIds.length} stale online host(s) silently`);
      }
    }
    hostStatusNotifierPrimed = true;
  } catch (error) {
    hostStatusNotifierPrimed = false;
    console.warn(`[HostStatus] Prime failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function notifyHostOnlineIfNeeded(host: any) {
  await notifyHostStatusChange(host, "online");
  void db.scheduleForwardGroupsForHostHealthChange(Number(host?.id || 0)).catch((error) => {
    console.warn(`[HostStatus] Online forward-group evaluation failed host=${host?.id}: ${error instanceof Error ? error.message : String(error)}`);
  });
}

async function restoreHostOnlineAfterStaleOfflineTransition(hostId: number) {
  const before = getPresenceCapableHostLivenessSnapshot(hostId);
  if (!before || before.confirmedOffline) return;
  await db.touchHostHeartbeat(hostId);
  // A second silence transition may have completed while the compensating DB
  // write was in flight. In that case the newest transition must win.
  const after = getPresenceCapableHostLivenessSnapshot(hostId);
  if (after?.confirmedOffline) await db.markHostOffline(hostId);
}

async function handlePresenceCapableHostOnline(event: AgentFastLivenessTransition) {
  if (event.kind !== "activity-restored" || event.confirmedOffline !== false) return;
  if (!event.isCurrent()) return;
  const hostId = Number(event.hostId || 0);
  if (!Number.isFinite(hostId) || hostId <= 0) return;

  // The regular presence route deliberately throttles database writes. A
  // recovery transition must still repair a host that was marked offline by a
  // just-completed silence deadline, then immediately re-evaluate its groups.
  await db.touchHostHeartbeat(hostId);
  if (!event.isCurrent()) return;
  const host = await db.getHostById(hostId);
  if (!host || !event.isCurrent()) return;
  await db.scheduleForwardGroupsForHostHealthChange(hostId);
  if (!event.isCurrent()) return;
  await notifyHostStatusChange({ ...host, isOnline: true, lastHeartbeat: new Date() }, "online");
}

export async function handlePresenceCapableHostOffline(event: AgentFastLivenessTransition) {
  if (event.kind !== "confirmed-offline" || event.confirmedOffline !== true || !event.offlineAt) return;
  const hostId = Number(event.hostId || 0);
  const host = await db.getHostById(hostId);
  if (!host || !event.isCurrent()) return;

  await db.markHostOffline(hostId);
  if (!event.isCurrent()) {
    await restoreHostOnlineAfterStaleOfflineTransition(hostId);
    return;
  }

  clearTunnelRuntimeStatusForHost(hostId);
  await db.scheduleForwardGroupsForHostHealthChange(hostId);
  if (!event.isCurrent()) {
    await restoreHostOnlineAfterStaleOfflineTransition(hostId);
    return;
  }
  await notifyHostStatusChange(host, "offline");
  console.info(`[HostStatus] Fast offline confirmed host=${hostId} silenceMs=${Math.max(0, event.offlineAt! - (event.lastSeenAt || event.offlineAt!))}`);
}

subscribeAgentFastLiveness((event) => {
  const hostId = Number(event.hostId || 0);
  if (!Number.isFinite(hostId) || hostId <= 0) return;
  // A host can recover while the previous offline transition is still doing
  // database or DDNS work. Keep all transitions for that host in event order;
  // the generation checks below then make stale work a no-op.
  void withKeyedTaskLock(`agent-liveness:${hostId}`, async () => {
    if (event.kind === "activity-restored") {
      for (let attempt = 0; attempt < FAST_LIVENESS_RETRY_DELAYS_MS.length; attempt += 1) {
        if (!event.isCurrent()) return;
        const delayMs = FAST_LIVENESS_RETRY_DELAYS_MS[attempt];
        if (delayMs > 0) await waitForRetry(delayMs);
        if (!event.isCurrent()) return;
        try {
          await handlePresenceCapableHostOnline(event);
          return;
        } catch (error) {
          const finalAttempt = attempt === FAST_LIVENESS_RETRY_DELAYS_MS.length - 1;
          console.warn(
            `[HostStatus] Fast online transition failed host=${hostId} attempt=${attempt + 1}/${FAST_LIVENESS_RETRY_DELAYS_MS.length}${finalAttempt ? " giving-up=true" : ""}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      return;
    }

    for (let attempt = 0; attempt < FAST_LIVENESS_RETRY_DELAYS_MS.length; attempt += 1) {
      if (!event.isCurrent()) return;
      const delayMs = FAST_LIVENESS_RETRY_DELAYS_MS[attempt];
      if (delayMs > 0) await waitForRetry(delayMs);
      if (!event.isCurrent()) return;
      try {
        await handlePresenceCapableHostOffline(event);
        return;
      } catch (error) {
        const finalAttempt = attempt === FAST_LIVENESS_RETRY_DELAYS_MS.length - 1;
        console.warn(
          `[HostStatus] Fast offline transition failed host=${hostId} attempt=${attempt + 1}/${FAST_LIVENESS_RETRY_DELAYS_MS.length}${finalAttempt ? " giving-up=true" : ""}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }).catch((error) => {
    console.warn(`[HostStatus] Fast liveness transition queue failed host=${hostId}: ${error instanceof Error ? error.message : String(error)}`);
  });
});

export async function sweepOfflineHostsAndNotify() {
  if (!hostStatusNotifierPrimed) {
    await primeHostStatusNotifier();
    if (!hostStatusNotifierPrimed) return 0;
  }
  const candidates = await db.getStaleOnlineHosts();
  const { active, stale: staleHosts } = partitionHostsByRecentAgentActivity(candidates as any[]);
  if (active.length > 0) {
    await Promise.all(active.map(async (host: any) => {
      try {
        await db.touchHostHeartbeat(Number(host.id));
      } catch (error) {
        console.warn(`[HostStatus] Recent Agent activity heartbeat refresh failed host=${host.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }));
  }
  if (staleHosts.length === 0) return 0;
  const transitionedIds = await db.markStaleHostsOffline((staleHosts as any[]).map((host) => Number(host.id)));
  if (transitionedIds.length === 0) return 0;
  const transitionedIdSet = new Set(transitionedIds);
  const transitionedHosts = (staleHosts as any[]).filter((host) => transitionedIdSet.has(Number(host.id)));
  for (const host of transitionedHosts) {
    clearTunnelRuntimeStatusForHost(Number(host.id));
    void db.scheduleForwardGroupsForHostHealthChange(Number(host.id)).catch((error) => {
      console.warn(`[HostStatus] Offline forward-group evaluation failed host=${host.id}: ${error instanceof Error ? error.message : String(error)}`);
    });
    await notifyHostStatusChange(host, "offline");
  }
  return transitionedHosts.length;
}
