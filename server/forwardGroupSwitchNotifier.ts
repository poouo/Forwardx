import { ENV } from "./env";
import { sendTelegramMessage } from "./telegramBot";
import { getAllSettings } from "./repositories/settingsRepository";
import { getTelegramAdminRecipients } from "./repositories/userRepository";

type ForwardGroupSwitchNotifyPayload = {
  groupId: number;
  groupName: string;
  groupMode: "failover" | "entry";
  domain?: string | null;
  recordType?: string | null;
  fromLabel?: string | null;
  fromValue?: string | null;
  toLabel?: string | null;
  toValue?: string | null;
  reason: string;
  detail?: string | null;
};

function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function formatTime(value = new Date()) {
  return value.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
}

function valueOrDash(value: unknown) {
  const text = String(value || "").trim();
  return text || "-";
}

async function telegramForwardGroupSwitchEnabled() {
  const settings = await getAllSettings();
  const envToken = ENV.telegramBotToken.trim();
  const botEnabled = settings.telegramBotEnabled === "true" || (!!envToken && settings.telegramBotEnabled !== "false");
  const botConfigured = !!String(settings.telegramBotToken || envToken).trim();
  return botEnabled && botConfigured;
}

function forwardGroupSwitchMessage(payload: ForwardGroupSwitchNotifyPayload) {
  const title = payload.groupMode === "entry" ? "ForwardX 入口组自动切换告警" : "ForwardX 转发组自动切换告警";
  const modeLabel = payload.groupMode === "entry" ? "入口组" : "转发组";
  const lines = [
    `<b>▌ ${escapeHtml(title)}</b>`,
    "",
    `<b>${modeLabel}</b>：${escapeHtml(payload.groupName)} (#${escapeHtml(payload.groupId)})`,
    payload.domain ? `<b>域名</b>：<code>${escapeHtml(payload.domain)}</code>` : "",
    payload.recordType ? `<b>记录</b>：${escapeHtml(payload.recordType)}` : "",
    "",
    `<b>原因</b>：${escapeHtml(payload.reason)}`,
    payload.detail ? `<b>详情</b>：${escapeHtml(payload.detail)}` : "",
    "",
    `<b>切换前</b>：${escapeHtml(valueOrDash(payload.fromLabel))} / <code>${escapeHtml(valueOrDash(payload.fromValue))}</code>`,
    `<b>切换后</b>：${escapeHtml(valueOrDash(payload.toLabel))} / <code>${escapeHtml(valueOrDash(payload.toValue))}</code>`,
    `<b>时间</b>：${escapeHtml(formatTime())}`,
  ].filter(Boolean);
  return lines.join("\n");
}

export async function notifyForwardGroupSwitch(payload: ForwardGroupSwitchNotifyPayload) {
  if (!(await telegramForwardGroupSwitchEnabled())) return;
  const recipients = await getTelegramAdminRecipients();
  if (recipients.length === 0) return;
  const text = forwardGroupSwitchMessage(payload);
  let sent = 0;
  let failed = 0;
  for (const user of recipients as any[]) {
    if (!user.telegramId) continue;
    try {
      await sendTelegramMessage(user.telegramId, text);
      sent += 1;
    } catch (error) {
      failed += 1;
      console.warn(`[Telegram] Forward group switch notify failed user=${user.id} group=${payload.groupId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (sent > 0 || failed > 0) {
    console.info(`[Telegram] Forward group switch notify group=${payload.groupId} sent=${sent} failed=${failed}`);
  }
}
