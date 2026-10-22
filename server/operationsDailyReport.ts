import { createHash } from "node:crypto";
import { operationsDate, operationsDay, OPERATIONS_DAY_SECONDS } from "../shared/operations";
import { OPERATIONS_REPORT_CONFIG_KEY, OPERATIONS_REPORT_STATE_KEY, parseOperationsReportConfig, type OperationsReportConfig } from "../shared/operationsDailyReport";
import type { getOperationsOverview } from "./repositories/operationsRepository";
import type { OperationsFinance } from "./repositories/operationsFinanceRepository";

type Overview = Awaited<ReturnType<typeof getOperationsOverview>>;
type Recipient = { id: number; telegramId: string | null; discordId: string | null };
type Channel = "telegram" | "discord";
type Delivery = { day: string; sent: string[]; complete: boolean; retryAt: number };
export type DailyReportDependencies = {
  config: () => Promise<OperationsReportConfig>;
  load: () => Promise<string | null>;
  save: (value: string) => Promise<void>;
  recipients: () => Promise<{ channel: Channel; users: Recipient[] }>;
  overview: (start: number, end: number) => Promise<Overview>;
  finance: (start: number, end: number) => Promise<OperationsFinance>;
  send: (user: Recipient, text: string, channel: Channel) => Promise<void>;
  warn: (message: string) => void;
};

function bytes(value: number) {
  if (!(value > 0)) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const index = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  return `${(value / 1024 ** index).toFixed(index ? 2 : 0)} ${units[index]}`;
}
// Keep user-provided names on one line, bounded and safe for both bot renderers.
function label(value: unknown) {
  return String(value || "未命名").replace(/[\r\n\t\u0000-\u001f]/g, " ").slice(0, 60);
}
export function formatOperationsDailyReport(day: string, overview: Overview, finance: OperationsFinance) {
  const incoming = overview.trend.reduce((sum, row) => sum + Number(row.bytesIn || 0), 0);
  const outgoing = overview.trend.reduce((sum, row) => sum + Number(row.bytesOut || 0), 0);
  const hosts = overview.current.reduce((sum, row) => sum + Number(row.count), 0);
  const online = overview.current.filter(row => row.isOnline === true || Number(row.isOnline) === 1).reduce((sum, row) => sum + Number(row.count), 0);
  const currencies = new Map<string, number>();
  for (const row of finance.receipts) currencies.set(row.currency, (currencies.get(row.currency) || 0) + row.amountCents);
  const ranks = (rows: any[]) => rows.slice(0, 3).map((row, i) => `${i + 1}. ${label(row.name || `#${row.id}`)} · ${bytes(Number(row.bytesIn || 0) + Number(row.bytesOut || 0))}`);
  const offline = overview.availability.filter(row => Number(row.offlineSeconds) > 0).slice(0, 3).map(row => `${label(row.name || `#${row.hostId}`)} · ${(Number(row.offlineSeconds) / 60).toFixed(1)} 分钟 / ${Number(row.incidents)} 次`);
  return [
    `ForwardX 运维日报 · ${day}`,
    "北京时间 00:00–24:00 · 全部用户",
    `实际流量：${bytes(incoming + outgoing)}`,
    `入向 ${bytes(incoming)} / 出向 ${bytes(outgoing)}`,
    `发送时在线主机：${online}/${hosts}`,
    `在线实收：${[...currencies].slice(0, 10).map(([currency, cents]) => `${label(currency)} ${(cents / 100).toFixed(2)}`).join(" / ") || "0"}`,
    "", "用户流量 TOP 3", ...(ranks(overview.users).length ? ranks(overview.users) : ["无流量记录"]),
    "", "规则流量 TOP 3", ...(ranks(overview.rules).length ? ranks(overview.rules) : ["无流量记录"]),
    "", "离线时长 TOP 3",
    ...(offline.length ? offline : ["无离线记录"]),
    "仅含已采集数据；流量不含计费倍率，未观测时段不计离线。",
  ].join("\n");
}

export async function deliverOperationsDailyReport(deps: DailyReportDependencies, now = Date.now() / 1000) {
  const config = await deps.config();
  if (!config.enabled) return;
  const today = operationsDay(now);
  const [hours, minutes] = config.time.split(":").map(Number);
  const due = today + hours * 3600 + minutes * 60;
  // Only today's scheduled report is eligible. Enabling after its due time waits
  // for tomorrow; a restart may catch up today, never a backlog of old reports.
  if (now < due || config.enabledAt > due) return;
  const start = today - OPERATIONS_DAY_SECONDS, day = operationsDate(start);
  let state: Delivery = { day, sent: [], complete: false, retryAt: 0 };
  // Database failures must propagate: treating a failed read as empty state
  // could resend a report that was already successfully delivered.
  const rawState = await deps.load();
  try {
    const saved = JSON.parse(rawState || "null");
    if (saved?.day === day && Array.isArray(saved.sent)) state = { day, sent: saved.sent.filter((id: unknown) => typeof id === "string"), complete: saved.complete === true, retryAt: Number(saved.retryAt) || 0 };
  } catch { /* Old or invalid delivery state must not disable future reports. */ }
  if (state.complete || now < state.retryAt) return;
  state.retryAt = now + 300;
  const persist = () => deps.save(JSON.stringify(state));
  await persist();
  const { channel, users: recipients } = await deps.recipients();
  const users = recipients.filter(user => channel === "telegram" ? user.telegramId : user.discordId);
  if (!users.length) return;
  const [overview, finance] = await Promise.all([deps.overview(start, today), deps.finance(start, today)]);
  const report = formatOperationsDailyReport(day, overview, finance);
  // Telegram consumes HTML; Discord converts these entities back to plain text.
  const text = report.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  let failed = false;
  for (const user of users) {
    const destination = channel === "telegram" ? user.telegramId : user.discordId;
    const key = createHash("sha256").update(`${channel}:${destination}`).digest("hex");
    if (state.sent.includes(key)) continue;
    const current = await deps.config();
    if (!current.enabled || current.time !== config.time || current.enabledAt !== config.enabledAt) return;
    try {
      await deps.send(user, text, channel);
    } catch {
      failed = true;
      deps.warn(`[OperationsDailyReport] delivery failed admin=${user.id} channel=${channel}; retry in 5 minutes`);
      continue;
    }
    // Persist each successful destination, so a later failed recipient or a
    // normal panel restart does not resend already delivered notifications.
    state.sent.push(key);
    await persist();
  }
  state.complete = !failed;
  await persist();
}

export async function runOperationsDailyReport() {
  const settings = await import("./repositories/settingsRepository");
  const notifications = await import("./notifications");
  const { getNotificationSettings } = await import("./notificationSettings");
  await deliverOperationsDailyReport({
    config: async () => parseOperationsReportConfig(await settings.getSetting(OPERATIONS_REPORT_CONFIG_KEY)),
    load: () => settings.getSetting(OPERATIONS_REPORT_STATE_KEY),
    save: value => settings.setSetting(OPERATIONS_REPORT_STATE_KEY, value),
    recipients: async () => ({ channel: (await getNotificationSettings()).channel, users: await notifications.getNotificationAdminRecipients() }),
    overview: async (start, end) => (await import("./repositories/operationsRepository")).getOperationsOverview(start, end),
    finance: async (start, end) => (await import("./repositories/operationsFinanceRepository")).getOperationsFinance(start, end),
    send: async (user, text, channel) => {
      const current = await getNotificationSettings();
      if (!current.active || current.channel !== channel) throw new Error("Notification channel changed");
      await notifications.sendUserNotification(user, text);
    },
    warn: message => console.warn(message),
  });
}
