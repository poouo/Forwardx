import * as db from "./db";
import { ENV } from "./env";
import { sendTelegramMessage } from "./telegramBot";

type HostStatus = "online" | "offline";

const lastKnownStatus = new Map<number, HostStatus>();
let hostStatusNotifierPrimed = false;

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
  return !!host?.isOnline && Number.isFinite(last) && Date.now() - last <= db.HOST_ONLINE_TTL_MS;
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
      await db.markHostsOffline(staleIds);
      console.info(`[HostStatus] Primed ${staleIds.length} stale online host(s) silently`);
    }
  } catch (error) {
    console.warn(`[HostStatus] Prime failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    hostStatusNotifierPrimed = true;
  }
}

export async function notifyHostOnlineIfNeeded(host: any) {
  await notifyHostStatusChange(host, "online");
}

export async function sweepOfflineHostsAndNotify() {
  const staleHosts = await db.getStaleOnlineHosts();
  if (staleHosts.length === 0) return 0;
  await db.markHostsOffline((staleHosts as any[]).map((host) => Number(host.id)));
  for (const host of staleHosts as any[]) {
    await notifyHostStatusChange(host, "offline");
  }
  return staleHosts.length;
}
