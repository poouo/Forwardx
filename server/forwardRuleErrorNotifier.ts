import crypto from "crypto";
import { sendTelegramMessage } from "./telegramBot";
import { getTelegramAdminRecipients } from "./repositories/userRepository";
import { formatForwardRuleProtocol, FORWARD_TYPE_LABELS, type ForwardType } from "../shared/forwardTypes";
import { isTelegramBotReady } from "./telegramReady";

type ForwardRuleErrorPayload = {
  rule: any;
  host?: any | null;
  forwardGroup?: any | null;
  message?: string | null;
};

const RULE_ERROR_NOTIFY_COOLDOWN_MS = 5 * 60 * 1000;
const RULE_ERROR_NOTIFY_CACHE_MAX = 10_000;
const lastRuleErrorNotifyAt = new Map<string, number>();

export function pruneForwardRuleErrorNotifyCache(now = Date.now()) {
  let deleted = 0;
  for (const [signature, lastAt] of lastRuleErrorNotifyAt) {
    if (now - lastAt < RULE_ERROR_NOTIFY_COOLDOWN_MS) continue;
    lastRuleErrorNotifyAt.delete(signature);
    deleted += 1;
  }
  return deleted;
}

export function shouldNotifyForwardRuleError(ruleId: number, message?: string | null, now = Date.now()) {
  const normalized = String(message || "").trim() || "runtime-error";
  const digest = crypto.createHash("sha256").update(normalized).digest("base64url");
  const signature = `${ruleId}:${digest}`;
  const lastAt = lastRuleErrorNotifyAt.get(signature) || 0;
  if (now - lastAt < RULE_ERROR_NOTIFY_COOLDOWN_MS) return false;
  pruneForwardRuleErrorNotifyCache(now);
  while (lastRuleErrorNotifyAt.size >= RULE_ERROR_NOTIFY_CACHE_MAX) {
    const oldest = lastRuleErrorNotifyAt.keys().next().value as string | undefined;
    if (!oldest) break;
    lastRuleErrorNotifyAt.delete(oldest);
  }
  lastRuleErrorNotifyAt.set(signature, now);
  return true;
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
  return String(host?.name || (host?.id ? `主机 ${host.id}` : "")).trim() || "-";
}

function formatTarget(rule: any) {
  const ip = String(rule?.targetIp || "").trim() || "-";
  const port = Number(rule?.targetPort || 0) || "-";
  return `${ip}:${port}`;
}

function ruleModeLabel(rule: any, forwardGroup?: any | null) {
  const type = String(rule?.forwardType || "") as ForwardType;
  const typeLabel = FORWARD_TYPE_LABELS[type] || type || "-";
  const forwardGroupId = Number(rule?.forwardGroupId || 0);
  if (forwardGroupId > 0) {
    const groupMode = String(forwardGroup?.groupMode || "");
    const resourceLabel = groupMode === "port" ? "端口转发" : groupMode === "chain" ? "转发链" : groupMode === "failover" ? "转发组" : "转发资源";
    return `${resourceLabel} / ${typeLabel}`;
  }
  if (Number(rule?.tunnelId || 0) > 0) return `隧道转发 / ${typeLabel}`;
  return `端口转发 / ${typeLabel}`;
}

function ruleErrorMessage(payload: ForwardRuleErrorPayload) {
  const { rule, host, forwardGroup, message } = payload;
  const reason = String(message || "").trim() || "Agent 上报规则运行异常";
  const modeLabel = ruleModeLabel(rule, forwardGroup);
  return [
    `<b>🔴 ForwardX 转发规则异常提醒</b>`,
    "",
    `<b>规则</b>：${escapeHtml(rule?.name || "未命名规则")} (#${escapeHtml(rule?.id || "-")})`,
    `<b>入口主机</b>：${escapeHtml(hostName(host))} (#${escapeHtml(host?.id || rule?.hostId || "-")})`,
    `<b>入口端口</b>：<code>${escapeHtml(rule?.sourcePort || "-")}</code>`,
    `<b>目标</b>：<code>${escapeHtml(formatTarget(rule))}</code>`,
    `<b>方式</b>：${escapeHtml(modeLabel)}`,
    `<b>协议</b>：${escapeHtml(formatForwardRuleProtocol(rule?.protocol))}`,
    `<b>原因</b>：${escapeHtml(reason)}`,
    `<b>时间</b>：${escapeHtml(formatTime())}`,
  ].join("\n");
}

export async function notifyForwardRuleError(payload: ForwardRuleErrorPayload) {
  const ruleId = Number(payload.rule?.id || 0);
  if (!ruleId || !payload.rule?.telegramErrorNotifyEnabled) return;
  if (!(await isTelegramBotReady())) return;

  const recipients = await getTelegramAdminRecipients();
  if (recipients.length === 0) return;
  if (!shouldNotifyForwardRuleError(ruleId, payload.message)) return;
  const text = ruleErrorMessage(payload);
  let sent = 0;
  let failed = 0;
  for (const user of recipients as any[]) {
    if (!user.telegramId) continue;
    try {
      await sendTelegramMessage(user.telegramId, text);
      sent += 1;
    } catch (error) {
      failed += 1;
      console.warn(`[Telegram] Forward rule error notify failed user=${user.id} rule=${ruleId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (sent > 0 || failed > 0) {
    console.info(`[Telegram] Forward rule error notify rule=${ruleId} sent=${sent} failed=${failed}`);
  }
}

const notifyCacheCleanupTimer = setInterval(() => pruneForwardRuleErrorNotifyCache(), RULE_ERROR_NOTIFY_COOLDOWN_MS);
notifyCacheCleanupTimer.unref?.();
