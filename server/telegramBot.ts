import * as db from "./db";
import { requireMainBackupAllowed } from "./routers/rules.crud";
import { ENV } from "./env";
import { ACCOUNT_DISABLED_ERR_MSG } from "../shared/const";
import { pushAgentRefresh, pushAgentUpgrade } from "./agentEvents";
import { pushTunnelEndpointRefresh, requireHostUseAccess, requireTunnelUseOrTrafficBillingAccess } from "./routers/helpers";
import { addMonthsClamped } from "./repositories/repositoryUtils";
import { clearMobileTelegramLoginChallenge, hasMobileTelegramLoginChallenge } from "./telegramMobileLogin";
import { createTelegramWebAppLoginChallenge } from "./telegramWebAppLogin";
import { formatForwardRuleProtocol } from "../shared/forwardTypes";
import { combinePortPolicies, isPortAllowedByPolicy, portPolicyErrorMessage, portPolicyFrom } from "./portPolicy";
import { isAgentVersionAtLeast } from "./agentRouteUtils";
import { APP_VERSION, AGENT_VERSION } from "../shared/versions";
import { checkPanelUpdateTask, startPanelUpgradeTask } from "./_core/systemRouter";
import { requireRuleProtocolEnabled } from "./forwardProtocolSettings";

type TelegramUser = {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
};

type TelegramMessage = {
  message_id: number;
  text?: string;
  chat: { id: number; type?: string };
  from?: TelegramUser;
};

type TelegramCallbackQuery = {
  id: string;
  from?: TelegramUser;
  message?: TelegramMessage;
  data?: string;
};

type TelegramBotCommand = {
  command: string;
  description: string;
};

type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
};

type AiQueryIntent = {
  intent: "usage" | "rules" | "rule_detail" | "rule_usage" | "hosts" | "tunnels" | "forward_groups" | "users" | "account" | "help" | "unsupported";
  id?: number;
  keyword?: string;
};

type ManageActionKind =
  | "none"
  | "balance_set"
  | "balance_adjust"
  | "renew"
  | "account_enable"
  | "account_disable"
  | "forward_enable"
  | "forward_disable"
  | "rule_enable"
  | "rule_disable"
  | "rule_create"
  | "rule_delete"
  | "tunnel_rules_enable"
  | "tunnel_rules_disable"
  | "traffic_reset"
  | "redeem_code_generate_balance"
  | "discount_code_generate_percent";

type ManageDurationUnit = "day" | "month" | "year";
type ManageForwardMode = "host" | "tunnel";

type ManageActionIntent = {
  action: ManageActionKind;
  target?: string;
  amountYuan?: number;
  durationValue?: number;
  durationUnit?: ManageDurationUnit;
  ruleId?: number;
  tunnel?: string;
  host?: string;
  forwardMode?: ManageForwardMode;
  sourcePort?: number;
  targetIp?: string;
  targetPort?: number;
  codeCount?: number;
  discountPercent?: number;
};

type PendingManageAction = {
  key: string;
  actorUserId: number;
  actorRole: "admin" | "user";
  action: Exclude<ManageActionKind, "none">;
  targetUserId?: number;
  amountCents?: number;
  durationValue?: number;
  durationUnit?: ManageDurationUnit;
  ruleId?: number;
  ruleIds?: number[];
  rulePreview?: string[];
  tunnelId?: number;
  tunnelName?: string;
  hostId?: number;
  hostName?: string;
  forwardMode?: ManageForwardMode;
  sourcePort?: number;
  targetIp?: string;
  targetPort?: number;
  codeCount?: number;
  discountPercent?: number;
  sourceText: string;
  createdAt: number;
  expiresAt: number;
};

type PreparedManageAction = {
  pending: Omit<PendingManageAction, "key" | "createdAt" | "expiresAt">;
  target?: any;
  actor: any;
};

type ManageClarifyPrompt = {
  actor: any;
  intent: ManageActionIntent;
  missingFields: ManageClarifyField[];
  text: string;
  keyboard?: InlineKeyboardMarkup;
};

type ManageActionPrepareResult = {
  prepared?: PreparedManageAction;
  clarify?: ManageClarifyPrompt;
  error?: string;
};

type ManageClarifyField = "target" | "amountYuan" | "codeCount" | "discountPercent" | "forwardMode" | "tunnel" | "host" | "ruleId";

type PendingManageClarifySession = {
  actorUserId: number;
  actorRole: "admin" | "user";
  action: Exclude<ManageActionKind, "none">;
  intent: ManageActionIntent;
  sourceText: string;
  missingFields: ManageClarifyField[];
  createdAt: number;
  expiresAt: number;
};

type UpdateCommandKind = "panel" | "agent";

type PendingUpdateAction = {
  key: string;
  actorUserId: number;
  kind: UpdateCommandKind;
  targetVersion?: string;
  hostIds?: number[];
  createdAt: number;
  expiresAt: number;
};

let pollingStarted = false;
let pollingAbort = false;
let updateOffset = 0;
let activeTokenKey = "";
const pendingBindChats = new Map<string, number>();
const pendingRedeemChats = new Map<string, number>();
const pendingManageActions = new Map<string, PendingManageAction>();
const pendingManageClarifySessions = new Map<string, PendingManageClarifySession>();
const pendingUpdateActions = new Map<string, PendingUpdateAction>();
const updateCommandRateLimit = new Map<string, number>();

const LOGIN_CODE_TTL_MS = 5 * 60 * 1000;
const LOGIN_SUCCESS_MESSAGE_DELETE_MS = 60 * 1000;
const BIND_SESSION_TTL_MS = 10 * 60 * 1000;
const REDEEM_SESSION_TTL_MS = 10 * 60 * 1000;
const USER_PAGE_SIZE = 10;
const RULE_PAGE_SIZE = 10;
const AI_QUERY_RESULT_LIMIT = 10;
type AiProvider = "deepseek" | "siliconflow" | "custom";
type DeepSeekSettings = {
  provider: AiProvider;
  enabled: boolean;
  apiKey: string;
  baseUrl: string;
  chatCompletionsUrl: string;
  model: string;
  maxTokens: number;
  temperature: number;
  telegramUserManageEnabled: boolean;
  telegramAutoRecallEnabled: boolean;
  telegramAutoRecallSeconds: number;
  redemptionEnabled: boolean;
  discountEnabled: boolean;
};
const DEFAULT_AI_PROVIDER: AiProvider = "deepseek";
const DEFAULT_DEEPSEEK_BASE_URL = "https://api.deepseek.com";
const DEFAULT_DEEPSEEK_MODEL = "deepseek-chat";
const DEFAULT_SILICONFLOW_BASE_URL = "https://api.siliconflow.cn/v1";
const DEFAULT_SILICONFLOW_MODEL = "Qwen/Qwen3-8B";
const DEFAULT_DEEPSEEK_MAX_TOKENS = 1024;
const DEFAULT_DEEPSEEK_TEMPERATURE = 0.2;
const MANAGE_ACTION_CONFIRM_TTL_MS = 10 * 60 * 1000;
const MANAGE_CLARIFY_TTL_MS = 60 * 1000;
const MANAGE_BALANCE_MAX_CENTS = 100_000_000;
const MANAGE_CODE_MAX_COUNT = 500;
const MANAGE_CODE_DISPLAY_LIMIT = 60;
const UPDATE_ACTION_CONFIRM_TTL_MS = 5 * 60 * 1000;
const UPDATE_COMMAND_COOLDOWN_MS = 60 * 1000;
const UPDATE_AGENT_PREVIEW_LIMIT = 15;
const GENERIC_AI_QUERY_KEYWORD_RE = /^(帮我|请|给我|查|查下|查一下|查询|查看|看看|看下|看一下|显示|列出|搜索|我的|我|全部|所有|当前|现在|目前|已有|有的|有|哪些|哪条|列表|信息|状态|详情|是多少|多少|用了|使用|消耗|占用|用量|流量|额度|余额|套餐|转发规则|规则|端口|转发|主机|机器|节点|隧道|链路|转发链|转发组|入口组|用户|账户|账号|的|吗)+$/;
const TELEGRAM_BOT_COMMANDS: TelegramBotCommand[] = [
  { command: "start", description: "打开菜单或完成账号绑定" },
  { command: "menu", description: "打开功能菜单" },
  { command: "usage", description: "查询流量和额度" },
  { command: "rules", description: "查看和管理转发规则" },
  { command: "ask", description: "自然语言查询面板信息" },
  { command: "redeem", description: "兑换余额或套餐兑换码" },
  { command: "bind", description: "使用绑定码绑定后台账号" },
  { command: "login", description: "生成网页登录链接" },
  { command: "webapp", description: "在 Telegram 内打开面板" },
  { command: "unbind", description: "解除 Telegram 绑定" },
  { command: "users", description: "管理员用户管理" },
  { command: "reset", description: "管理员重置用户流量" },
  { command: "renew", description: "管理员续期用户套餐" },
  { command: "updatepanel", description: "管理员更新面板（需确认）" },
  { command: "updateagent", description: "管理员更新 Agent（需确认）" },
  { command: "help", description: "查看帮助" },
];

function randomCode(length = 32) {
  let out = "";
  while (out.length < length) out += crypto.randomUUID().replace(/-/g, "");
  return out.slice(0, length).toUpperCase();
}

function isMobileLoginCode(value: string | undefined) {
  return /^APP[A-Z0-9]{20,64}$/i.test((value || "").trim());
}

function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function formatBytes(bytes: number | string | null | undefined) {
  const num = Number(bytes) || 0;
  if (num <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const index = Math.min(units.length - 1, Math.floor(Math.log(num) / Math.log(1024)));
  return `${parseFloat((num / 1024 ** index).toFixed(index === 0 ? 0 : 2))} ${units[index]}`;
}

function formatMoneyCny(cents: number | string | null | undefined) {
  return `¥${((Number(cents) || 0) / 100).toFixed(2)}`;
}

function formatDate(value: unknown) {
  if (!value) return "永久有效";
  const date = new Date(value as any);
  return Number.isNaN(date.getTime()) ? "永久有效" : date.toLocaleDateString("zh-CN");
}

function formatDateTime(value: unknown) {
  if (!value) return "永久有效";
  const date = new Date(value as any);
  return Number.isNaN(date.getTime()) ? "永久有效" : date.toLocaleString("zh-CN");
}

function formatTelegramName(from?: TelegramUser) {
  const parts = [from?.first_name, from?.last_name].filter(Boolean);
  if (parts.length) return parts.join(" ");
  return from?.username ? `@${from.username}` : String(from?.id || "");
}

function clampPage(page: number, total: number, pageSize: number) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(0, Math.floor(page) || 0), totalPages - 1);
  return { page: safePage, totalPages };
}

function shortText(value: unknown, length = 18) {
  const text = String(value || "-");
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

function getRenewalDates(user: any, months = 1) {
  const currentExpiresAt = user?.expiresAt ? new Date(user.expiresAt) : null;
  const now = new Date();
  const base = currentExpiresAt && currentExpiresAt.getTime() > now.getTime() ? currentExpiresAt : now;
  return { base, nextExpiresAt: addMonthsClamped(base, months) };
}

function getRenewalDatesByDuration(user: any, value: number, unit: ManageDurationUnit) {
  const safeValue = Math.max(1, Math.floor(value || 1));
  const currentExpiresAt = user?.expiresAt ? new Date(user.expiresAt) : null;
  const now = new Date();
  const base = currentExpiresAt && currentExpiresAt.getTime() > now.getTime() ? currentExpiresAt : now;
  if (unit === "month") return { base, nextExpiresAt: addMonthsClamped(base, safeValue) };
  if (unit === "year") return { base, nextExpiresAt: addMonthsClamped(base, safeValue * 12) };
  return { base, nextExpiresAt: new Date(base.getTime() + safeValue * 24 * 3600 * 1000) };
}

function formatUserLabel(user: any) {
  return `#${Number(user?.id || 0)} ${escapeHtml(user?.name || user?.username || "-")}`;
}

function formatManageDuration(value: number, unit: ManageDurationUnit) {
  const safeValue = Math.max(1, Math.floor(value || 1));
  if (unit === "day") return `${safeValue} 天`;
  if (unit === "year") return `${safeValue} 年`;
  return `${safeValue} 个月`;
}

function formatDiscountPercentLabel(discountPercent: number | string | null | undefined) {
  const offPercent = Math.max(1, Math.min(100, Math.round(Number(discountPercent || 0))));
  const payPercent = Math.max(0, 100 - offPercent);
  const zheText = payPercent % 10 === 0
    ? String(payPercent / 10)
    : (payPercent / 10).toFixed(1).replace(/\.0$/, "");
  return `${zheText} 折（减 ${offPercent}%）`;
}

function formatManageRulePreview(rule: any) {
  const name = shortText(rule?.name || "-", 24);
  const sourcePort = rule?.sourcePort ?? "-";
  const targetIp = rule?.targetIp || "-";
  const targetPort = rule?.targetPort ?? "-";
  return `#${Number(rule?.id || 0)} ${name} :${sourcePort} -> ${targetIp}:${targetPort}`;
}

function manageForwardModeLabel(mode?: ManageForwardMode | null) {
  return mode === "tunnel" ? "隧道转发" : "端口转发";
}

const MANAGE_RULE_TARGET_HOST_RE = /^[a-zA-Z0-9]([a-zA-Z0-9\-_.]*[a-zA-Z0-9])?$|^[a-fA-F0-9:.]+$/;

function isValidManageRuleTargetHost(value: unknown) {
  const host = String(value || "").trim();
  return !!host && MANAGE_RULE_TARGET_HOST_RE.test(host);
}

function pickManageRuleForwardType(actor: any, mode: ManageForwardMode) {
  const preferred = mode === "tunnel"
    ? ["gost"]
    : ["iptables", "realm", "socat", "gost"];
  if (String(actor?.role) === "admin") return preferred[0];
  const allowedRaw = (actor as any)?.allowedForwardTypes as string | null | undefined;
  if (allowedRaw === null || allowedRaw === undefined) return preferred[0];
  const allowedSet = new Set(String(allowedRaw).split(",").map((item) => item.trim()).filter(Boolean));
  if (allowedSet.size === 0) return preferred[0];
  const selected = preferred.find((type) => allowedSet.has(type));
  if (!selected) {
    throw new Error(mode === "tunnel"
      ? "当前账户没有使用隧道转发（gost）的权限，请联系管理员授权。"
      : "当前账户没有可用的端口转发类型权限，请联系管理员授权。");
  }
  return selected;
}

async function settleTrafficBillingForDeletedRuleByTelegram(rule: any) {
  const tunnelId = Number(rule?.tunnelId || 0);
  const billed = await db.settleTrafficBillingRuleOnDelete({
    userId: Number(rule?.userId || 0),
    ruleId: Number(rule?.id || 0),
    resourceType: tunnelId > 0 ? "tunnel" : "host",
    resourceId: tunnelId > 0 ? tunnelId : Number(rule?.hostId || 0),
  });
  if (billed && Number((billed as any).balanceAfterCents) < 0) {
    await db.setUserForwardAccess(Number(rule?.userId || 0), false, "traffic_billing_balance");
    await refreshUserForwardEndpoints(Number(rule?.userId || 0), "telegram-traffic-billing-delete-balance-negative");
  }
  return billed;
}

function cleanupExpiredPendingManageActions() {
  const now = Date.now();
  for (const [key, item] of pendingManageActions.entries()) {
    if (!item.expiresAt || item.expiresAt <= now) pendingManageActions.delete(key);
  }
}

function createPendingManageAction(action: Omit<PendingManageAction, "key" | "createdAt" | "expiresAt">) {
  cleanupExpiredPendingManageActions();
  const now = Date.now();
  const key = randomCode(18).toLowerCase();
  const pending: PendingManageAction = {
    ...action,
    key,
    createdAt: now,
    expiresAt: now + MANAGE_ACTION_CONFIRM_TTL_MS,
  };
  pendingManageActions.set(key, pending);
  return pending;
}

function getPendingManageAction(actionKey: string) {
  cleanupExpiredPendingManageActions();
  const key = String(actionKey || "").trim().toLowerCase();
  if (!key) return null;
  const pending = pendingManageActions.get(key);
  if (!pending) return null;
  if (!pending.expiresAt || pending.expiresAt <= Date.now()) {
    pendingManageActions.delete(key);
    return null;
  }
  return pending;
}

function consumePendingManageAction(actionKey: string) {
  const pending = getPendingManageAction(actionKey);
  if (!pending) return null;
  pendingManageActions.delete(pending.key);
  return pending;
}

function getManageClarifySessionKey(chatId: number | string, actorUserId: number | string) {
  return `${chatId}:${actorUserId}`;
}

function cleanupExpiredPendingManageClarifySessions() {
  const now = Date.now();
  for (const [key, item] of pendingManageClarifySessions.entries()) {
    if (!item.expiresAt || item.expiresAt <= now) pendingManageClarifySessions.delete(key);
  }
}

function createPendingManageClarifySession(
  chatId: number | string,
  actor: any,
  sourceText: string,
  intent: ManageActionIntent,
  missingFields: ManageClarifyField[],
) {
  cleanupExpiredPendingManageClarifySessions();
  const now = Date.now();
  const key = getManageClarifySessionKey(chatId, Number(actor?.id || 0));
  const session: PendingManageClarifySession = {
    actorUserId: Number(actor?.id || 0),
    actorRole: String(actor?.role) === "admin" ? "admin" : "user",
    action: intent.action as Exclude<ManageActionKind, "none">,
    intent,
    sourceText: sourceText.slice(0, 500),
    missingFields,
    createdAt: now,
    expiresAt: now + MANAGE_CLARIFY_TTL_MS,
  };
  pendingManageClarifySessions.set(key, session);
  return session;
}

function getPendingManageClarifySession(chatId: number | string, actorUserId: number | string) {
  cleanupExpiredPendingManageClarifySessions();
  const key = getManageClarifySessionKey(chatId, actorUserId);
  const session = pendingManageClarifySessions.get(key);
  if (!session) return null;
  if (!session.expiresAt || session.expiresAt <= Date.now()) {
    pendingManageClarifySessions.delete(key);
    return null;
  }
  return session;
}

function clearPendingManageClarifySession(chatId: number | string, actorUserId: number | string) {
  pendingManageClarifySessions.delete(getManageClarifySessionKey(chatId, actorUserId));
}

function getUpdateRateLimitKey(actorUserId: number | string, kind: UpdateCommandKind) {
  return `${Number(actorUserId) || 0}:${kind}`;
}

function cleanupExpiredUpdateRateLimits() {
  const now = Date.now();
  for (const [key, ts] of updateCommandRateLimit.entries()) {
    if (!Number.isFinite(ts) || now - ts > UPDATE_COMMAND_COOLDOWN_MS * 3) updateCommandRateLimit.delete(key);
  }
}

function takeUpdateCommandCooldown(actorUserId: number | string, kind: UpdateCommandKind) {
  cleanupExpiredUpdateRateLimits();
  const key = getUpdateRateLimitKey(actorUserId, kind);
  const now = Date.now();
  const lastAt = updateCommandRateLimit.get(key) || 0;
  const waitMs = UPDATE_COMMAND_COOLDOWN_MS - (now - lastAt);
  if (waitMs > 0) return waitMs;
  updateCommandRateLimit.set(key, now);
  return 0;
}

function cleanupExpiredPendingUpdateActions() {
  const now = Date.now();
  for (const [key, item] of pendingUpdateActions.entries()) {
    if (!item.expiresAt || item.expiresAt <= now) pendingUpdateActions.delete(key);
  }
}

function createPendingUpdateAction(action: Omit<PendingUpdateAction, "key" | "createdAt" | "expiresAt">) {
  cleanupExpiredPendingUpdateActions();
  const now = Date.now();
  const key = randomCode(18).toLowerCase();
  const pending: PendingUpdateAction = {
    ...action,
    key,
    createdAt: now,
    expiresAt: now + UPDATE_ACTION_CONFIRM_TTL_MS,
  };
  pendingUpdateActions.set(key, pending);
  return pending;
}

function getPendingUpdateAction(actionKey: string) {
  cleanupExpiredPendingUpdateActions();
  const key = String(actionKey || "").trim().toLowerCase();
  if (!key) return null;
  const pending = pendingUpdateActions.get(key);
  if (!pending) return null;
  if (!pending.expiresAt || pending.expiresAt <= Date.now()) {
    pendingUpdateActions.delete(key);
    return null;
  }
  return pending;
}

function consumePendingUpdateAction(actionKey: string) {
  const pending = getPendingUpdateAction(actionKey);
  if (!pending) return null;
  pendingUpdateActions.delete(pending.key);
  return pending;
}

function getBindSessionKey(chatId: number | string, telegramId: string | number) {
  return `${chatId}:${telegramId}`;
}

function startBindSession(chatId: number | string, telegramId: string | number) {
  pendingBindChats.set(getBindSessionKey(chatId, telegramId), Date.now() + BIND_SESSION_TTL_MS);
}

function hasValidBindSession(chatId: number | string, telegramId: string | number) {
  const key = getBindSessionKey(chatId, telegramId);
  const expiresAt = pendingBindChats.get(key) || 0;
  if (!expiresAt || expiresAt <= Date.now()) {
    pendingBindChats.delete(key);
    return false;
  }
  return true;
}

function clearBindSession(chatId: number | string, telegramId: string | number) {
  pendingBindChats.delete(getBindSessionKey(chatId, telegramId));
}

function getRedeemSessionKey(chatId: number | string, telegramId: string | number) {
  return `${chatId}:${telegramId}`;
}

function startRedeemSession(chatId: number | string, telegramId: string | number) {
  pendingRedeemChats.set(getRedeemSessionKey(chatId, telegramId), Date.now() + REDEEM_SESSION_TTL_MS);
}

function hasValidRedeemSession(chatId: number | string, telegramId: string | number) {
  const key = getRedeemSessionKey(chatId, telegramId);
  const expiresAt = pendingRedeemChats.get(key) || 0;
  if (!expiresAt || expiresAt <= Date.now()) {
    pendingRedeemChats.delete(key);
    return false;
  }
  return true;
}

function clearRedeemSession(chatId: number | string, telegramId: string | number) {
  pendingRedeemChats.delete(getRedeemSessionKey(chatId, telegramId));
}

function getTokenKey(token: string) {
  if (!token) return "";
  return `${token.length}:${token.slice(0, 8)}:${token.slice(-8)}`;
}

async function getTelegramSettings() {
  const settings = await db.getAllSettings();
  const envToken = ENV.telegramBotToken.trim();
  const dbToken = String(settings.telegramBotToken || "").trim();
  const token = envToken || dbToken;
  const enabled = settings.telegramBotEnabled === "true" || (!!envToken && settings.telegramBotEnabled !== "false");
  return {
    token,
    enabled,
    botUsername: String(settings.telegramBotUsername || "").trim(),
    panelPublicUrl: String(settings.panelPublicUrl || "").trim().replace(/\/+$/, ""),
  };
}

async function telegramApi<T = any>(method: string, body?: Record<string, unknown>): Promise<T> {
  const settings = await getTelegramSettings();
  if (!settings.token) throw new Error("Telegram Bot Token is not configured");
  const resp = await fetch(`https://api.telegram.org/bot${settings.token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  const json = await resp.json().catch(() => null) as any;
  if (!resp.ok || !json?.ok) {
    throw new Error(json?.description || `Telegram API ${method} failed: ${resp.status}`);
  }
  return json.result as T;
}

type InlineKeyboardButton = {
  text: string;
  callback_data?: string;
  url?: string;
  web_app?: { url: string };
};

type InlineKeyboardMarkup = {
  inline_keyboard: Array<Array<InlineKeyboardButton>>;
};

type TelegramSentMessage = {
  message_id: number;
};

async function sendMessage(chatId: number | string, text: string, replyMarkup?: InlineKeyboardMarkup) {
  return telegramApi<TelegramSentMessage>("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
}

export async function sendTelegramMessage(chatId: number | string, text: string) {
  await sendMessage(chatId, text);
}

export async function syncTelegramBotCommands() {
  const settings = await getTelegramSettings();
  if (!settings.token) return false;
  await telegramApi("setMyCommands", {
    commands: TELEGRAM_BOT_COMMANDS,
    scope: { type: "default" },
  });
  return true;
}

async function editMessage(chatId: number | string, messageId: number, text: string, replyMarkup?: InlineKeyboardMarkup) {
  await telegramApi("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
}

async function deleteMessage(chatId: number | string, messageId: number) {
  await telegramApi("deleteMessage", {
    chat_id: chatId,
    message_id: messageId,
  });
}

function deleteMessageLater(chatId: number | string, messageId: number, delayMs: number) {
  const timer = setTimeout(() => {
    deleteMessage(chatId, messageId).catch(() => undefined);
  }, delayMs);
  (timer as any).unref?.();
}

async function answerCallback(callbackId: string, text?: string) {
  await telegramApi("answerCallbackQuery", {
    callback_query_id: callbackId,
    ...(text ? { text } : {}),
  });
}

async function ensureTelegramUser(from?: TelegramUser) {
  if (!from?.id || from.is_bot) return null;
  const telegramId = String(from.id);
  const user = await db.getUserByTelegramId(telegramId);
  if (user) {
    await db.updateTelegramLastSeen(telegramId, {
      username: from.username || null,
      firstName: from.first_name || null,
      lastName: from.last_name || null,
    });
  }
  return { telegramId, user, from };
}

async function ensureTelegramIdentity(message: TelegramMessage) {
  return ensureTelegramUser(message.from);
}

function helpText(bound: boolean, isAdmin = false) {
  const base = [
    "ForwardX Telegram Bot",
    "",
    bound
      ? "可用命令："
      : "请先在面板个人菜单点击 Telegram 绑定按钮生成绑定码，然后在这里完成绑定。",
    "/usage - 查询我的用量",
    "/rules - 查看我的转发规则",
    "/ask 问题 - 用自然语言查询面板信息",
    "/redeem 兑换码 - 兑换余额或套餐",
    "/login - 生成网页一次性登录链接",
    "/webapp - 在 Telegram 内打开面板",
    "/enable 规则ID - 启用规则",
    "/disable 规则ID - 停用规则",
    "/unbind - 解除当前 Telegram 绑定（需要确认）",
  ];
  if (isAdmin) {
    base.push(
      "",
      "管理员命令：",
      "/users - 查看用户管理",
      "/reset 用户ID - 重置用户流量",
      "/renew 用户ID - 续期用户一个月",
      "/updatepanel - 检查并更新面板（60 秒限流）",
      "/updateagent - 检查并更新 Agent（60 秒限流）",
    );
  }
  return base.map(escapeHtml).join("\n");
}

function bindPromptKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: "🔗 绑定 Telegram", callback_data: "fx:bind:start" }],
    ],
  };
}

function bindCancelKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: "❌ 取消绑定", callback_data: "fx:bind:cancel" }],
    ],
  };
}

function redeemCancelKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: "❌ 取消兑换", callback_data: "fx:redeem:cancel" }],
      [{ text: "🏠 返回菜单", callback_data: "fx:menu" }],
    ],
  };
}

function unbindConfirmKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: "⚠️ 确认解除绑定", callback_data: "fx:unbind:confirm" },
        { text: "❌ 取消", callback_data: "fx:menu" },
      ],
    ],
  };
}

function mobileLoginConfirmKeyboard(code: string): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: "✅ 确认登录", callback_data: `fx:app-login:${code}` },
        { text: "❌ 取消", callback_data: `fx:app-login-cancel:${code}` },
      ],
    ],
  };
}

async function sendBindPrompt(chatId: number | string) {
  await sendMessage(
    chatId,
    [
      "<b>绑定 Telegram</b>",
      "",
      "当前 Telegram 尚未绑定 ForwardX 账户。",
      "请先在网页面板的个人菜单里点击 Telegram 绑定生成绑定码，然后点击下面按钮并发送绑定码。",
    ].join("\n"),
    bindPromptKeyboard(),
  );
}

async function sendBindCodePrompt(chatId: number | string, telegramId: string | number) {
  startBindSession(chatId, telegramId);
  await sendMessage(
    chatId,
    [
      "<b>请输入绑定码</b>",
      "",
      `请在 ${Math.round(BIND_SESSION_TTL_MS / 60000)} 分钟内直接发送网页面板生成的 Telegram 绑定码。`,
      "绑定码通常是一串大写字母和数字。",
    ].join("\n"),
    bindCancelKeyboard(),
  );
}

async function editBindCodePrompt(chatId: number | string, messageId: number, telegramId: string | number) {
  startBindSession(chatId, telegramId);
  await editMessage(
    chatId,
    messageId,
    [
      "<b>请输入绑定码</b>",
      "",
      `请在 ${Math.round(BIND_SESSION_TTL_MS / 60000)} 分钟内直接发送网页面板生成的 Telegram 绑定码。`,
      "绑定码通常是一串大写字母和数字。",
    ].join("\n"),
    bindCancelKeyboard(),
  );
}

async function sendRedeemCodePrompt(chatId: number | string, telegramId: string | number) {
  startRedeemSession(chatId, telegramId);
  await sendMessage(
    chatId,
    [
      "<b>兑换码</b>",
      "",
      `请在 ${Math.round(REDEEM_SESSION_TTL_MS / 60000)} 分钟内直接发送余额或套餐兑换码。`,
      "也可以使用命令：/redeem 兑换码",
    ].join("\n"),
    redeemCancelKeyboard(),
  );
}

async function editRedeemCodePrompt(chatId: number | string, messageId: number, telegramId: string | number) {
  startRedeemSession(chatId, telegramId);
  await editMessage(
    chatId,
    messageId,
    [
      "<b>兑换码</b>",
      "",
      `请在 ${Math.round(REDEEM_SESSION_TTL_MS / 60000)} 分钟内直接发送余额或套餐兑换码。`,
      "也可以使用命令：/redeem 兑换码",
    ].join("\n"),
    redeemCancelKeyboard(),
  );
}

function parseCommand(text: string) {
  const parts = text.trim().split(/\s+/).filter(Boolean);
  const command = (parts.shift() || "").split("@")[0].toLowerCase();
  return { command, args: parts };
}

function buildTelegramWebAppUrl(panelPublicUrl: string, challenge?: string) {
  const base = String(panelPublicUrl || "").trim().replace(/\/+$/, "");
  if (!base) return "";
  const params = new URLSearchParams({ tgWebApp: "1" });
  const normalizedChallenge = String(challenge || "").trim().toLowerCase();
  if (normalizedChallenge) params.set("wa", normalizedChallenge);
  return `${base}/login?${params.toString()}`;
}

function webAppOpenKeyboard(url: string): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: "🌐 打开面板", web_app: { url } },
        { text: "🔗 浏览器", url },
      ],
    ],
  };
}

function mainMenuKeyboard(user: any, webAppUrl?: string): InlineKeyboardMarkup {
  const rows: InlineKeyboardMarkup["inline_keyboard"] = [
    [
      { text: "👤 账户", callback_data: "fx:user" },
      { text: "📊 流量", callback_data: "fx:usage" },
      { text: "⚙️ 规则", callback_data: "fx:rules" },
    ],
  ];
  const secondaryRow: InlineKeyboardButton[] = [];
  if (user?.role === "admin") {
    secondaryRow.push({ text: "👥 用户", callback_data: "fx:users:0" });
  } else {
    secondaryRow.push({ text: "🎟 兑换", callback_data: "fx:redeem" });
  }
  if (webAppUrl) {
    secondaryRow.push({ text: "🌐 面板", web_app: { url: webAppUrl } });
  }
  rows.push(secondaryRow);
  return { inline_keyboard: rows };
}

function backMenuKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: "🏠 返回菜单", callback_data: "fx:menu" }],
    ],
  };
}

function userManageBackKeyboard(page = 0): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: "👥 返回用户列表", callback_data: `fx:users:${page}` }],
      [{ text: "🏠 返回菜单", callback_data: "fx:menu" }],
    ],
  };
}

function renewalConfirmKeyboard(userId: number, page = 0): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: "✅ 确认续期 1 个月", callback_data: `fx:admin:renew:confirm:${userId}:${page}` },
        { text: "❌ 取消", callback_data: `fx:admin:user:${userId}:${page}` },
      ],
      [{ text: "👤 返回用户详情", callback_data: `fx:admin:user:${userId}:${page}` }],
    ],
  };
}

function manageActionConfirmKeyboard(actionKey: string): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: "✅ 确认执行", callback_data: `fx:op:confirm:${actionKey}` },
        { text: "❌ 取消", callback_data: `fx:op:cancel:${actionKey}` },
      ],
      [{ text: "🏠 返回菜单", callback_data: "fx:menu" }],
    ],
  };
}

function manageClarifyCancelKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: "❌ 取消本次操作", callback_data: "fx:op:clarify:cancel" }],
      [{ text: "🏠 返回菜单", callback_data: "fx:menu" }],
    ],
  };
}

function manageClarifyModeKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: "🖥 端口转发", callback_data: "fx:op:clarify:mode:host" },
        { text: "🔗 隧道转发", callback_data: "fx:op:clarify:mode:tunnel" },
      ],
      [{ text: "❌ 取消", callback_data: "fx:op:clarify:cancel" }],
    ],
  };
}

function manageClarifyTunnelKeyboard(tunnels: any[]): InlineKeyboardMarkup {
  const rows: InlineKeyboardMarkup["inline_keyboard"] = [];
  const max = 12;
  let row: InlineKeyboardButton[] = [];
  for (const tunnel of tunnels.slice(0, max)) {
    const id = Number(tunnel?.id || 0);
    if (!id) continue;
    const label = `#${id} ${shortText(tunnel?.name || "-", 10)}`;
    row.push({ text: label, callback_data: `fx:op:clarify:tunnel:${id}` });
    if (row.length >= 2) {
      rows.push(row);
      row = [];
    }
  }
  if (row.length > 0) rows.push(row);
  rows.push([{ text: "❌ 取消", callback_data: "fx:op:clarify:cancel" }]);
  return { inline_keyboard: rows };
}

function manageClarifyHostKeyboard(hosts: any[]): InlineKeyboardMarkup {
  const rows: InlineKeyboardMarkup["inline_keyboard"] = [];
  const max = 12;
  let row: InlineKeyboardButton[] = [];
  for (const host of hosts.slice(0, max)) {
    const id = Number(host?.id || 0);
    if (!id) continue;
    const label = `#${id} ${shortText(host?.name || host?.ip || "-", 10)}`;
    row.push({ text: label, callback_data: `fx:op:clarify:host:${id}` });
    if (row.length >= 2) {
      rows.push(row);
      row = [];
    }
  }
  if (row.length > 0) rows.push(row);
  rows.push([{ text: "❌ 取消", callback_data: "fx:op:clarify:cancel" }]);
  return { inline_keyboard: rows };
}

function manageClarifyRuleKeyboard(rules: any[]): InlineKeyboardMarkup {
  const rows: InlineKeyboardMarkup["inline_keyboard"] = [];
  for (const rule of rules.slice(0, 10)) {
    const id = Number(rule?.id || 0);
    if (!id) continue;
    const target = `${shortText(rule?.targetIp || "-", 10)}:${rule?.targetPort ?? "-"}`;
    rows.push([{ text: `#${id} ${target}`, callback_data: `fx:op:clarify:rule:${id}` }]);
  }
  rows.push([{ text: "❌ 取消", callback_data: "fx:op:clarify:cancel" }]);
  return { inline_keyboard: rows };
}

function updateActionConfirmKeyboard(kind: UpdateCommandKind, actionKey: string): InlineKeyboardMarkup {
  const confirmText = kind === "panel" ? "✅ 确认更新面板" : "✅ 确认更新 Agent";
  return {
    inline_keyboard: [
      [
        { text: confirmText, callback_data: `fx:update:${kind}:confirm:${actionKey}` },
        { text: "❌ 取消", callback_data: `fx:update:${kind}:cancel:${actionKey}` },
      ],
      [{ text: "🏠 返回菜单", callback_data: "fx:menu" }],
    ],
  };
}

function ruleListBackKeyboard(page = 0): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: "⚙️ 返回规则列表", callback_data: `fx:rules:${page}` }],
      [{ text: "🏠 返回菜单", callback_data: "fx:menu" }],
    ],
  };
}

function menuText(user: any) {
  const title = user?.role === "admin" ? "ForwardX 管理菜单" : "ForwardX 用户菜单";
  return [
    `<b>${escapeHtml(title)}</b>`,
    "",
    `当前账户：<b>${escapeHtml(user?.name || user?.username || "-")}</b>`,
    `角色：${user?.role === "admin" ? "管理员" : "用户"}`,
    "",
    "请选择下面的功能按钮。",
  ].join("\n");
}

function userInfoText(user: any) {
  return [
    "<b>用户信息</b>",
    "",
    `账户：<b>${escapeHtml(user.name || user.username)}</b>`,
    `用户名：${escapeHtml(user.username)}`,
    `角色：${user.role === "admin" ? "管理员" : "用户"}`,
    `余额：${formatMoneyCny(user.balanceCents)}`,
    `到期时间：${escapeHtml(formatDate(user.expiresAt))}`,
    `转发权限：${user.role === "admin" || user.canAddRules ? "已启用" : "已停用"}`,
    `绑定时间：${escapeHtml(formatDate(user.telegramLinkedAt))}`,
    `最近使用：${escapeHtml(formatDate(user.telegramLastSeenAt))}`,
  ].join("\n");
}

async function usageText(user: any) {
  const [ruleCount, portCount] = await Promise.all([
    db.getUserRuleCount(user.id),
    db.getUserPortCount(user.id),
  ]);
  const limit = Number(user.trafficLimit) || 0;
  const used = Number(user.trafficUsed) || 0;
  const remaining = limit > 0 ? Math.max(0, limit - used) : null;
  const percent = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  return [
    "<b>流量用量</b>",
    "",
    `已用流量：${escapeHtml(formatBytes(used))}`,
    `流量额度：${limit > 0 ? escapeHtml(formatBytes(limit)) : "不限"}`,
    `剩余流量：${remaining === null ? "不限" : escapeHtml(formatBytes(remaining))}`,
    limit > 0 ? `使用率：${percent}%` : "",
    `规则/端口：${ruleCount}${user.maxRules ? `/${user.maxRules}` : ""} 条，${portCount}${user.maxPorts ? `/${user.maxPorts}` : ""} 个端口`,
    user.trafficAutoReset ? `自动重置：每月 ${user.trafficResetDay || 1} 日` : "",
  ].filter(Boolean).join("\n");
}

async function rulesText(user: any) {
  const rules = await db.getForwardRules(user.role === "admin" ? undefined : user.id);
  const visible = user.role === "admin" ? rules.slice(0, 10) : rules.slice(0, 15);
  if (visible.length === 0) return "<b>转发规则</b>\n\n暂无转发规则。";
  const lines = visible.map((rule: any) => {
    const status = rule.isEnabled ? (rule.isRunning ? "运行中" : "等待同步") : "已停用";
    return [
      `#${rule.id} <b>${escapeHtml(rule.name)}</b>`,
      `${status} · ${escapeHtml(rule.forwardType)} ${escapeHtml(formatForwardRuleProtocol(rule.protocol))}`,
      `:${rule.sourcePort} → ${escapeHtml(rule.targetIp)}:${rule.targetPort}`,
    ].join("\n");
  });
  const more = rules.length > visible.length ? `\n\n还有 ${rules.length - visible.length} 条规则未展示，可发送 /rules 查看更多。` : "";
  return `<b>转发规则</b>\n\n${lines.join("\n\n")}${more}`;
}

async function rulesView(user: any, page = 0) {
  const rules = await db.getForwardRules(user.role === "admin" ? undefined : user.id);
  const { page: safePage, totalPages } = clampPage(page, rules.length, RULE_PAGE_SIZE);
  const visible = rules.slice(safePage * RULE_PAGE_SIZE, safePage * RULE_PAGE_SIZE + RULE_PAGE_SIZE);
  const text = visible.length === 0
    ? "<b>转发规则</b>\n\n暂无转发规则。"
    : [
        "<b>转发规则</b>",
        `第 ${safePage + 1}/${totalPages} 页，共 ${rules.length} 条`,
        "",
        ...visible.map((rule: any) => {
          const status = rule.isEnabled ? (rule.isRunning ? "运行中" : "等待同步") : "已停用";
          return `#${rule.id} <b>${escapeHtml(shortText(rule.name, 24))}</b>\n${status} · ${escapeHtml(rule.forwardType)} ${escapeHtml(formatForwardRuleProtocol(rule.protocol))} · :${rule.sourcePort}`;
        }),
      ].join("\n\n");
  const rows: InlineKeyboardMarkup["inline_keyboard"] = [];
  for (const rule of visible) {
    rows.push([
      { text: `${rule.isEnabled ? "⛔ 停用" : "✅ 启用"} #${rule.id}`, callback_data: `fx:rule:toggle:${rule.id}:${safePage}` },
      { text: `📄 详情 #${rule.id}`, callback_data: `fx:rule:view:${rule.id}:${safePage}` },
    ]);
  }
  if (totalPages > 1) {
    rows.push([
      { text: "⬅️ 上一页", callback_data: `fx:rules:${Math.max(0, safePage - 1)}` },
      { text: "➡️ 下一页", callback_data: `fx:rules:${Math.min(totalPages - 1, safePage + 1)}` },
    ]);
  }
  rows.push([{ text: "🏠 返回菜单", callback_data: "fx:menu" }]);
  return { text, keyboard: { inline_keyboard: rows } };
}

async function ruleDetailText(ruleId: number, user: any) {
  const rule = await db.getForwardRuleById(ruleId);
  if (!rule || (user.role !== "admin" && rule.userId !== user.id)) return "规则不存在或无权查看。";
  const status = rule.isEnabled ? (rule.isRunning ? "运行中" : "等待同步") : "已停用";
  return [
    `<b>规则 #${rule.id}</b>`,
    "",
    `名称：${escapeHtml(rule.name)}`,
    `状态：${status}`,
    `类型：${escapeHtml(rule.forwardType)} / ${escapeHtml(formatForwardRuleProtocol(rule.protocol))}`,
    `入口端口：${rule.sourcePort}`,
    `目标：${escapeHtml(rule.targetIp)}:${rule.targetPort}`,
    `主机 ID：${rule.hostId}`,
    rule.tunnelId ? `隧道 ID：${rule.tunnelId}` : "",
  ].filter(Boolean).join("\n");
}

async function usersText() {
  const users = await db.getUserTrafficSummaries();
  if (users.length === 0) return "<b>用户概览</b>\n\n暂无用户。";
  const lines = users.slice(0, 20).map((user: any) => {
    const limit = Number(user.trafficLimit) || 0;
    return `#${user.id} ${escapeHtml(user.name || user.username)} ${escapeHtml(formatBytes(user.trafficUsed))}/${limit > 0 ? escapeHtml(formatBytes(limit)) : "不限"}`;
  });
  return `<b>用户概览</b>\n\n${lines.join("\n")}`;
}

async function usersView(page = 0) {
  const users = await db.getUserTrafficSummaries();
  const { page: safePage, totalPages } = clampPage(page, users.length, USER_PAGE_SIZE);
  const visible = users.slice(safePage * USER_PAGE_SIZE, safePage * USER_PAGE_SIZE + USER_PAGE_SIZE);
  const text = visible.length === 0
    ? "<b>用户管理</b>\n\n暂无用户。"
    : [
        "<b>用户管理</b>",
        `第 ${safePage + 1}/${totalPages} 页，共 ${users.length} 个用户`,
        "",
        ...visible.map((user: any) => {
          const limit = Number(user.trafficLimit) || 0;
          const access = user.role === "admin" || user.canAddRules ? "转发启用" : "转发停用";
          return `#${user.id} <b>${escapeHtml(shortText(user.name || user.username, 18))}</b> · ${user.role === "admin" ? "管理员" : "用户"}\n${access} · ${escapeHtml(formatBytes(user.trafficUsed))}/${limit > 0 ? escapeHtml(formatBytes(limit)) : "不限"}`;
        }),
      ].join("\n\n");
  const rows: InlineKeyboardMarkup["inline_keyboard"] = [];
  for (const user of visible) {
    rows.push([{ text: `🛠 管理 #${user.id} ${shortText(user.name || user.username, 14)}`, callback_data: `fx:admin:user:${user.id}:${safePage}` }]);
  }
  if (totalPages > 1) {
    rows.push([
      { text: "⬅️ 上一页", callback_data: `fx:users:${Math.max(0, safePage - 1)}` },
      { text: "➡️ 下一页", callback_data: `fx:users:${Math.min(totalPages - 1, safePage + 1)}` },
    ]);
  }
  rows.push([{ text: "🏠 返回菜单", callback_data: "fx:menu" }]);
  return { text, keyboard: { inline_keyboard: rows } };
}

async function adminUserText(userId: number) {
  const target = await db.getUserById(userId);
  if (!target) return { target: null, text: "用户不存在。" };
  const [ruleCount, portCount] = await Promise.all([
    db.getUserRuleCount(target.id),
    db.getUserPortCount(target.id),
  ]);
  const limit = Number(target.trafficLimit) || 0;
  const used = Number(target.trafficUsed) || 0;
  const remaining = limit > 0 ? Math.max(0, limit - used) : null;
  const percent = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  const text = [
    `<b>管理用户 #${target.id}</b>`,
    "",
    `账户：${escapeHtml(target.name || target.username)}`,
    `用户名：${escapeHtml(target.username)}`,
    `角色：${target.role === "admin" ? "管理员" : "用户"}`,
    `转发权限：${target.role === "admin" || target.canAddRules ? "已启用" : "已停用"}`,
    `已用流量：${escapeHtml(formatBytes(used))}`,
    `流量额度：${limit > 0 ? escapeHtml(formatBytes(limit)) : "不限"}`,
    `剩余流量：${remaining === null ? "不限" : escapeHtml(formatBytes(remaining))}`,
    limit > 0 ? `使用率：${percent}%` : "",
    `到期时间：${escapeHtml(formatDate(target.expiresAt))}`,
    `规则/端口：${ruleCount}${target.maxRules ? `/${target.maxRules}` : ""} 条，${portCount}${target.maxPorts ? `/${target.maxPorts}` : ""} 个端口`,
    `TG：${target.telegramId ? (target.telegramUsername ? `@${escapeHtml(target.telegramUsername)}` : target.telegramId) : "未绑定"}`,
  ].filter(Boolean).join("\n");
  return { target, text };
}

async function adminUserKeyboard(userId: number, page = 0): Promise<InlineKeyboardMarkup> {
  const target = await db.getUserById(userId);
  const accessEnabled = !!target && (target.role === "admin" || target.canAddRules);
  return {
    inline_keyboard: [
      [
        { text: "🔄 重置流量", callback_data: `fx:admin:reset:${userId}:${page}` },
        { text: accessEnabled ? "⛔ 停用转发" : "✅ 启用转发", callback_data: `fx:admin:access:${userId}:${accessEnabled ? "0" : "1"}:${page}` },
      ],
      [{ text: "📆 续期 1 个月", callback_data: `fx:admin:renew:${userId}:${page}` }],
      [{ text: "🔄 刷新详情", callback_data: `fx:admin:user:${userId}:${page}` }],
      [{ text: "👥 返回用户列表", callback_data: `fx:users:${page}` }],
      [{ text: "🏠 返回菜单", callback_data: "fx:menu" }],
    ],
  };
}

async function renewalConfirmText(userId: number) {
  const target = await db.getUserById(userId);
  if (!target) return { target: null, text: "用户不存在。" };
  const { base, nextExpiresAt } = getRenewalDates(target, 1);
  const text = [
    "<b>确认套餐续期</b>",
    "",
    `用户：#${target.id} ${escapeHtml(target.name || target.username)}`,
    `当前到期：${escapeHtml(formatDateTime(target.expiresAt))}`,
    `续期方式：从${base.getTime() > Date.now() ? "当前到期时间" : "当前时间"}起延长 1 个月`,
    `续期后到期：<b>${escapeHtml(formatDateTime(nextExpiresAt))}</b>`,
    "",
    "请确认后再执行续期。",
  ].join("\n");
  return { target, text, nextExpiresAt };
}

async function renewUserOneMonth(userId: number) {
  const target = await db.getUserById(userId);
  if (!target) throw new Error("用户不存在");
  const { nextExpiresAt } = getRenewalDates(target, 1);
  await db.updateUserTrafficSettings(userId, {
    expiresAt: nextExpiresAt,
  });
  return { target, nextExpiresAt };
}

async function loginText(user: any) {
  const settings = await getTelegramSettings();
  const code = randomCode(32);
  const expiresAt = new Date(Date.now() + LOGIN_CODE_TTL_MS);
  await db.createTelegramLoginCode(user.id, code, expiresAt);
  const path = `/login?tg=${encodeURIComponent(code)}`;
  const url = settings.panelPublicUrl ? `${settings.panelPublicUrl}${path}` : path;
  return [
    "<b>网页登录</b>",
    "",
    "一次性登录链接 5 分钟内有效：",
    escapeHtml(url),
    "",
    settings.panelPublicUrl ? "" : `如果未配置面板公开访问地址，请在浏览器打开面板后访问：${escapeHtml(path)}`,
  ].filter(Boolean).join("\n");
}

async function sendMainMenu(chatId: number | string, user: any) {
  const settings = await getTelegramSettings();
  const webAppUrl = settings.panelPublicUrl
    ? buildTelegramWebAppUrl(
      settings.panelPublicUrl,
      createTelegramWebAppLoginChallenge({ telegramId: user?.telegramId || null }),
    )
    : "";
  await sendMessage(chatId, menuText(user), mainMenuKeyboard(user, webAppUrl || undefined));
}

async function editMainMenu(chatId: number | string, messageId: number, user: any) {
  const settings = await getTelegramSettings();
  const webAppUrl = settings.panelPublicUrl
    ? buildTelegramWebAppUrl(
      settings.panelPublicUrl,
      createTelegramWebAppLoginChallenge({ telegramId: user?.telegramId || null }),
    )
    : "";
  await editMessage(chatId, messageId, menuText(user), mainMenuKeyboard(user, webAppUrl || undefined));
}

async function handleBind(message: TelegramMessage, code: string) {
  const from = message.from;
  if (!from?.id || from.is_bot) return;
  const normalized = code.trim().toUpperCase();
  const user = await db.getUserByTelegramBindCode(normalized);
  if (!user) {
    if (from?.id) startBindSession(message.chat.id, from.id);
    await sendMessage(message.chat.id, "绑定码无效。请在面板中重新生成或检查后再次发送。", bindCancelKeyboard());
    return;
  }
  const expiresAt = user.telegramBindCodeExpiresAt ? new Date(user.telegramBindCodeExpiresAt).getTime() : 0;
  if (!expiresAt || expiresAt <= Date.now()) {
    await db.clearTelegramBindCode(user.id);
    if (from?.id) startBindSession(message.chat.id, from.id);
    await sendMessage(message.chat.id, "绑定码已过期。请在面板中重新生成绑定码后再次发送。", bindCancelKeyboard());
    return;
  }
  await db.bindTelegramAccount(user.id, {
    id: String(from.id),
    username: from.username || null,
    firstName: from.first_name || null,
    lastName: from.last_name || null,
  });
  await sendMessage(
    message.chat.id,
    `已绑定到 ForwardX 账户：<b>${escapeHtml(user.name || user.username)}</b>\n之后可以使用 /usage、/rules 和功能菜单。`,
  );
  const boundUser = await db.getUserById(user.id);
  if (boundUser) await sendMainMenu(message.chat.id, boundUser);
}

async function handleMobileLoginStart(message: TelegramMessage, code: string, user: any | null | undefined) {
  const normalized = code.trim().toUpperCase();
  if (!hasMobileTelegramLoginChallenge(normalized)) {
    await sendMessage(message.chat.id, "登录请求已过期，请回到 ForwardX 重新发起。");
    return;
  }
  if (!user) {
    await sendMessage(message.chat.id, "当前 Telegram 未绑定任何 ForwardX 账户，请先使用账号密码登录后绑定 Telegram。", bindPromptKeyboard());
    return;
  }
  if ((user as any).accountEnabled === false) {
    await sendMessage(message.chat.id, ACCOUNT_DISABLED_ERR_MSG);
    return;
  }
  await sendMessage(
    message.chat.id,
    [
      "<b>ForwardX 登录确认</b>",
      "",
      `将登录账户：<b>${escapeHtml(user.name || user.username)}</b>`,
      "如果这是你本人操作，请点击下方按钮确认。登录请求 5 分钟内有效。",
    ].join("\n"),
    mobileLoginConfirmKeyboard(normalized),
  );
}

async function confirmMobileLogin(chatId: number | string, messageId: number, code: string, user: any) {
  const normalized = code.trim().toUpperCase();
  if (!hasMobileTelegramLoginChallenge(normalized)) {
    await editMessage(chatId, messageId, "登录请求已过期，请回到 ForwardX 重新发起。");
    return;
  }
  if ((user as any).accountEnabled === false) {
    await editMessage(chatId, messageId, ACCOUNT_DISABLED_ERR_MSG);
    return;
  }
  await db.createTelegramLoginCode(user.id, normalized, new Date(Date.now() + LOGIN_CODE_TTL_MS));
  await editMessage(chatId, messageId, "登录已确认，请返回 ForwardX。");
  deleteMessageLater(chatId, messageId, LOGIN_SUCCESS_MESSAGE_DELETE_MS);
}

function normalizeDeepSeekNumber(value: unknown, fallback: number, min: number, max: number) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, numeric));
}

function normalizeAiProvider(value: unknown): AiProvider {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "siliconflow") return "siliconflow";
  if (raw === "custom") return "custom";
  return DEFAULT_AI_PROVIDER;
}

function getAiProviderDefaultBaseUrl(provider: AiProvider) {
  if (provider === "siliconflow") return DEFAULT_SILICONFLOW_BASE_URL;
  return DEFAULT_DEEPSEEK_BASE_URL;
}

function getAiProviderDefaultModel(provider: AiProvider) {
  if (provider === "siliconflow") return DEFAULT_SILICONFLOW_MODEL;
  return DEFAULT_DEEPSEEK_MODEL;
}

const AI_PROVIDER_SETTING_KEYS: Record<AiProvider, { apiKey: string; baseUrl: string; model: string }> = {
  deepseek: {
    apiKey: "deepseekApiKeyDeepseek",
    baseUrl: "deepseekBaseUrlDeepseek",
    model: "deepseekModelDeepseek",
  },
  siliconflow: {
    apiKey: "deepseekApiKeySiliconflow",
    baseUrl: "deepseekBaseUrlSiliconflow",
    model: "deepseekModelSiliconflow",
  },
  custom: {
    apiKey: "deepseekApiKeyCustom",
    baseUrl: "deepseekBaseUrlCustom",
    model: "deepseekModelCustom",
  },
};

function getAiProviderSettingKeys(provider: AiProvider) {
  return AI_PROVIDER_SETTING_KEYS[provider];
}

function buildAiChatCompletionsUrl(baseUrl: string) {
  const normalized = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (/\/chat\/completions$/i.test(normalized)) return normalized;
  return `${normalized}/chat/completions`;
}

function normalizeTelegramAiAutoRecallSeconds(value: unknown) {
  const numeric = Math.floor(Number(value));
  if (!Number.isFinite(numeric)) return 60;
  return Math.min(1200, Math.max(30, numeric));
}

async function getDeepSeekSettings(): Promise<DeepSeekSettings> {
  const settings = await db.getAllSettings();
  const provider = normalizeAiProvider(settings.deepseekProvider);
  const providerKeys = getAiProviderSettingKeys(provider);
  const defaultBaseUrl = getAiProviderDefaultBaseUrl(provider);
  const defaultModel = getAiProviderDefaultModel(provider);
  const legacyApiKey = provider === DEFAULT_AI_PROVIDER ? String(settings.deepseekApiKey || "").trim() : "";
  const legacyBaseUrl = provider === DEFAULT_AI_PROVIDER ? String(settings.deepseekBaseUrl || "").trim() : "";
  const legacyModel = provider === DEFAULT_AI_PROVIDER ? String(settings.deepseekModel || "").trim() : "";
  const apiKey = String(settings[providerKeys.apiKey] || "").trim() || legacyApiKey;
  const baseUrl = String(settings[providerKeys.baseUrl] || legacyBaseUrl || defaultBaseUrl).trim().replace(/\/+$/, "") || defaultBaseUrl;
  const model = String(settings[providerKeys.model] || legacyModel || defaultModel).trim() || defaultModel;
  return {
    provider,
    enabled: settings.deepseekAiEnabled === "true",
    apiKey,
    baseUrl,
    chatCompletionsUrl: buildAiChatCompletionsUrl(baseUrl),
    model,
    maxTokens: normalizeDeepSeekNumber(settings.deepseekMaxTokens, DEFAULT_DEEPSEEK_MAX_TOKENS, 128, 8192),
    temperature: normalizeDeepSeekNumber(settings.deepseekTemperature, DEFAULT_DEEPSEEK_TEMPERATURE, 0, 2),
    telegramUserManageEnabled: settings.telegramAiUserManageEnabled !== "false",
    telegramAutoRecallEnabled: settings.telegramAiAutoRecallEnabled === "true",
    telegramAutoRecallSeconds: normalizeTelegramAiAutoRecallSeconds(settings.telegramAiAutoRecallSeconds),
    redemptionEnabled: settings.redemptionEnabled !== "false",
    discountEnabled: settings.discountEnabled !== "false",
  };
}

async function getTelegramAiAutoRecallConfig() {
  const deepseek = await getDeepSeekSettings();
  const seconds = normalizeTelegramAiAutoRecallSeconds(deepseek.telegramAutoRecallSeconds);
  return {
    enabled: !!deepseek.telegramAutoRecallEnabled,
    delayMs: seconds * 1000,
  };
}

async function scheduleAiMessageAutoRecall(chatId: number | string, sourceMessageId?: number, botMessage?: { message_id?: number } | number | null) {
  const config = await getTelegramAiAutoRecallConfig().catch(() => ({ enabled: false, delayMs: 60_000 }));
  if (!config.enabled) return;
  const sourceId = Number(sourceMessageId);
  if (Number.isFinite(sourceId) && sourceId > 0) {
    deleteMessageLater(chatId, sourceId, config.delayMs);
  }
  const botMessageId = typeof botMessage === "number"
    ? Number(botMessage)
    : Number(botMessage?.message_id || 0);
  if (Number.isFinite(botMessageId) && botMessageId > 0) {
    deleteMessageLater(chatId, botMessageId, config.delayMs);
  }
}

function normalizeKeyword(value: unknown) {
  return String(value || "").trim().slice(0, 80);
}

function isGenericAiQueryKeyword(value: unknown) {
  const normalized = String(value || "")
    .trim()
    .replace(/^\/ask(?:@\w+)?\s*/i, "")
    .replace(/[\s，,。？?！!：:、的]+/g, "");
  if (!normalized) return true;
  if (/^\d+$/.test(normalized)) return false;
  return GENERIC_AI_QUERY_KEYWORD_RE.test(normalized);
}

function parseChineseNumeralToken(raw: string) {
  const normalized = String(raw || "").trim();
  if (!normalized) return undefined;
  if (!/^[零〇一二两三四五六七八九十百千]+$/.test(normalized)) return undefined;
  const digitMap: Record<string, number> = {
    零: 0,
    〇: 0,
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
  };
  const unitMap: Record<string, number> = { 十: 10, 百: 100, 千: 1000 };
  let section = 0;
  let current = 0;
  for (const ch of normalized) {
    if (Object.prototype.hasOwnProperty.call(digitMap, ch)) {
      current = digitMap[ch];
      continue;
    }
    const unit = unitMap[ch];
    if (!unit) return undefined;
    if (current === 0) current = 1;
    section += current * unit;
    current = 0;
  }
  const result = section + current;
  return Number.isFinite(result) && result > 0 ? result : undefined;
}

function parseNumericToken(value: unknown) {
  const normalized = String(value || "")
    .trim()
    .replace(/\s+/g, "")
    .replace(/^第/, "")
    .replace(/[号条个]$/, "");
  if (!normalized) return undefined;
  if (/^\d+$/.test(normalized)) {
    const id = Number(normalized);
    return Number.isFinite(id) && id > 0 ? id : undefined;
  }
  return parseChineseNumeralToken(normalized);
}

function normalizeNumericKeyword(value: unknown) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const parsed = parseNumericToken(raw);
  return parsed ? String(parsed) : raw;
}

function normalizeAiQueryKeyword(value: unknown) {
  const keyword = normalizeNumericKeyword(normalizeKeyword(value));
  return isGenericAiQueryKeyword(keyword) ? "" : keyword;
}

function textAsksRuleUsage(text: string) {
  return /(规则|rule|#)/i.test(text) && /(流量|用量|用了|使用|消耗|traffic|usage)/i.test(text);
}

function textAsksRuleDetail(text: string) {
  return /(详情|状态|detail|status)/i.test(text)
    || /#\s*\d+/.test(text)
    || /\d+\s*(?:号|#)\s*(?:规则|rule)/i.test(text);
}

function normalizeAiQueryIntent(value: any, fallback: AiQueryIntent): AiQueryIntent {
  const allowed = new Set<AiQueryIntent["intent"]>([
    "usage",
    "rules",
    "rule_detail",
    "rule_usage",
    "hosts",
    "tunnels",
    "forward_groups",
    "users",
    "account",
    "help",
    "unsupported",
  ]);
  const modelIntent = allowed.has(value?.intent) ? value.intent : undefined;
  let intent = modelIntent || fallback.intent;
  if (["rule_usage", "rule_detail", "rules"].includes(fallback.intent)) intent = fallback.intent;
  const modelId = Number(value?.id);
  const fallbackId = Number(fallback.id);
  const id = Number.isFinite(modelId) && modelId > 0
    ? modelId
    : (Number.isFinite(fallbackId) && fallbackId > 0 ? fallbackId : undefined);
  const modelKeyword = intent === "users"
    ? normalizeUserLookupKeyword(value?.keyword)
    : normalizeAiQueryKeyword(value?.keyword);
  const fallbackKeyword = intent === "users"
    ? normalizeUserLookupKeyword(fallback.keyword)
    : normalizeAiQueryKeyword(fallback.keyword);
  const keyword = modelKeyword || fallbackKeyword;
  return {
    intent,
    ...(id ? { id } : {}),
    ...(keyword ? { keyword } : {}),
  };
}

function extractAiJsonObject(content: string) {
  const trimmed = content.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

function extractRuleId(text: string) {
  const match = text.match(/(?:规则|rule)\s*#?\s*([0-9零〇一二两三四五六七八九十百千]+)/i)
    || text.match(/第\s*([0-9零〇一二两三四五六七八九十百千]+)\s*条?\s*(?:规则|rule)/i)
    || text.match(/([0-9零〇一二两三四五六七八九十百千]+)\s*(?:号|条|#)?\s*(?:规则|rule)/i)
    || text.match(/#\s*([0-9]+)/);
  return parseNumericToken(match?.[1]);
}

function extractExplicitSearchKeyword(text: string) {
  const trimmed = text.replace(/^\/ask(?:@\w+)?\s*/i, "").trim();
  const explicit = trimmed.match(/(?:关键字|关键词|搜索|端口|名称|备注|IP|ip|域名)[:：]?\s*([^\s，,。]+)/);
  return normalizeAiQueryKeyword(explicit?.[1]);
}

function cleanAiEntityKeyword(value: unknown) {
  const cleaned = String(value || "")
    .replace(/^(帮我|请|给我|把|将|列出|显示|查看|查询|看看|看下|看一下|现在|当前|目前|已有|有的|所有|全部)+/g, "")
    .replace(/(的|下|一下)$/g, "");
  return normalizeAiQueryKeyword(cleaned);
}

function normalizeUserLookupKeyword(value: unknown) {
  const cleaned = String(value || "")
    .replace(/^(?:用户|账户|账号|user)\s*/i, "")
    .trim();
  return cleanAiEntityKeyword(cleaned);
}

function extractUserFilterKeyword(text: string) {
  const before = text.match(/([^\s，,。？?！!：:、的]+?)\s*(?:用户|账户|账号|user)(?=主机|机器|节点|规则|转发|端口|$|[\s，,。？?！!：:、的])/i);
  const beforeKeyword = cleanAiEntityKeyword(before?.[1]);
  if (beforeKeyword) return beforeKeyword;
  const after = text.match(/(?:用户|账户|账号|user)\s*[:：]?\s*([^\s，,。？?！!：:、的]+?)(?=主机|机器|节点|规则|转发|端口|$|[\s，,。？?！!：:、的])/i);
  return cleanAiEntityKeyword(after?.[1]);
}

function extractHostFilterKeyword(text: string) {
  const cleanHostKeyword = (value: unknown) => cleanAiEntityKeyword(String(value || "").replace(/^.*(?:用户|账户|账号|user)/i, ""));
  const before = text.match(/([^\s，,。？?！!：:、的]+?)\s*(?:主机|机器|节点|agent|host|server)(?=规则|转发|端口|$|[\s，,。？?！!：:、的])/i);
  const beforeKeyword = cleanHostKeyword(before?.[1]);
  if (beforeKeyword) return beforeKeyword;
  const after = text.match(/(?:主机|机器|节点|agent|host|server)\s*[:：]?\s*([^\s，,。？?！!：:、的]+?)(?=规则|转发|端口|$|[\s，,。？?！!：:、的])/i);
  return cleanHostKeyword(after?.[1]);
}

function stripAiEntityClauses(text: string) {
  return text
    .replace(/(?:用户|账户|账号|user)\s*[:：]?\s*[^\s，,。？?！!：:、的]+/gi, " ")
    .replace(/[^\s，,。？?！!：:、]+\s*(?:用户|账户|账号|user)/gi, " ")
    .replace(/(?:主机|机器|节点|agent|host|server)\s*[:：]?\s*[^\s，,。？?！!：:、的]+/gi, " ")
    .replace(/[^\s，,。？?！!：:、]+\s*(?:主机|机器|节点|agent|host|server)/gi, " ");
}

function extractSearchKeyword(text: string) {
  const explicit = extractExplicitSearchKeyword(text);
  if (explicit) return explicit;
  const cleaned = stripAiEntityClauses(text.replace(/^\/ask(?:@\w+)?\s*/i, "").trim())
    .replace(/(帮我|请|给我|一下|查下|查一下|查询|查看|看看|看下|看一下|显示|列出|搜索|我的|我|全部|所有|当前|现在|目前|已有|有的|有哪些|有|转发规则|规则详情|规则|主机|机器|节点|隧道|链路|转发链|转发组|入口组|用户|账户|账号|信息|状态|详情|列表|哪些|哪条|是多少|多少|用了|使用|消耗|占用|用量|流量|额度|余额|套餐)/g, " ")
    .replace(/[，,。？?！!：:、]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalizeAiQueryKeyword(cleaned);
}

function localAiQueryIntent(text: string): AiQueryIntent {
  const raw = text.trim();
  const compact = raw.replace(/\s+/g, "");
  const lower = raw.toLowerCase();
  const readHint = /(查询|查看|看看|看下|看一下|显示|列出|搜索|多少|哪些|哪条|状态|详情|流量|用量|规则|主机|机器|节点|隧道|链路|转发组|入口组|用户|账户|账号|端口|ip|域名)/i.test(raw);
  const questionHint = /(查询|查看|看看|看下|看一下|显示|列出|搜索|多少|哪些|哪条|状态|详情|列表|有哪些|有的|吗|？|\?)/i.test(raw);
  const writeHint = /(开启|启用|关闭|停用|禁用|删除|移除|重置|续期|兑换|创建|新增|修改|更新|编辑|enable|disable|delete|remove|reset|renew|create|add|update|edit)/i.test(lower);
  if (writeHint && !readHint) return { intent: "unsupported" };
  if (!questionHint && /^(帮我|请|给我|把|将)?(开启|启用|关闭|停用|禁用|删除|移除|重置|续期|兑换|创建|新增|修改|更新|编辑)/.test(compact)) {
    return { intent: "unsupported" };
  }
  const id = extractRuleId(raw);
  const keyword = extractSearchKeyword(raw);
  const userKeyword = normalizeUserLookupKeyword(extractUserFilterKeyword(raw) || keyword);
  if (/(帮助|怎么用|help)/i.test(raw)) return { intent: "help" };
  if (textAsksRuleUsage(raw)) return id ? { intent: "rule_usage", id } : { intent: "rules", keyword };
  if (id && textAsksRuleDetail(raw)) return { intent: "rule_detail", id };
  if (/(用户|user)/i.test(raw) && /(详情|明细|使用|用了|流量|用量|到期|角色|usage|traffic)/i.test(raw)) {
    return { intent: "users", ...(userKeyword ? { keyword: userKeyword } : {}) };
  }
  if (/(用量|流量|额度|余额|套餐|usage|traffic)/i.test(raw)) return { intent: "usage", keyword };
  if (/(我是谁|账户|账号|个人|信息|资料|account|profile)/i.test(raw)) return { intent: "account", keyword };
  if (/(转发组|入口组|多入口|forward\s*group|group)/i.test(raw)) return { intent: "forward_groups", keyword };
  if (/(隧道|链路|转发链|tunnel|link)/i.test(raw)) return { intent: "tunnels", keyword };
  if (/(规则|端口|转发|rule|port)/i.test(raw)) return { intent: "rules", keyword };
  if (/(用户|user)/i.test(raw)) return { intent: "users", ...(userKeyword ? { keyword: userKeyword } : {}) };
  if (/(主机|机器|节点|agent|host|server)/i.test(raw)) return { intent: "hosts", keyword };
  if (keyword) return { intent: "rules", keyword };
  return { intent: "help" };
}

async function parseAiQueryIntent(text: string): Promise<AiQueryIntent> {
  const fallback = localAiQueryIntent(text);
  if (fallback.intent === "unsupported") return fallback;
  const settings = await getDeepSeekSettings().catch(() => null);
  if (!settings?.enabled || !settings.apiKey) return fallback;
  try {
    const resp = await fetch(settings.chatCompletionsUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${settings.apiKey}`,
      },
      body: JSON.stringify({
        model: settings.model,
        messages: [
          {
            role: "system",
            content: [
              "You classify ForwardX Telegram user messages into read-only query intents.",
              "Return only JSON with keys: intent, id, keyword.",
              "Allowed intents: usage, rules, rule_detail, rule_usage, hosts, tunnels, forward_groups, users, account, help, unsupported.",
              "Use rule_usage when the user asks how much traffic a specific rule used; include id when a rule number is present.",
              "Use rule_detail only when the user asks for detail/status or explicitly refers to #12 / 12号规则; rule 443 usually means keyword/port search.",
              "Recognize rule id formats such as 第9条规则 / 9号规则 / 规则#9 and include id.",
              "If the message asks for rules filtered by a user or host, classify it as rules, not users or hosts.",
              "For user detail queries like 用户1/用户一的使用详情, classify as users and return keyword as the precise user token (for example 1).",
              "Do not use vague words like now/current/all/my as keyword; leave keyword empty for list-all queries.",
              "Do not erase explicit ids or keywords from the user message.",
              "If the user asks to enable, disable, create, update, delete, reset, renew, redeem, or otherwise change data, return unsupported.",
              "Do not answer the user. Do not include markdown.",
            ].join(" "),
          },
          { role: "user", content: text.slice(0, 500) },
        ],
        response_format: { type: "json_object" },
        temperature: 0,
        max_tokens: Math.min(512, Math.max(128, Math.floor(settings.maxTokens || DEFAULT_DEEPSEEK_MAX_TOKENS))),
      }),
    });
    if (!resp.ok) throw new Error(`AI HTTP ${resp.status}`);
    const json = await resp.json().catch(() => null) as any;
    const content = String(json?.choices?.[0]?.message?.content || "");
    const parsed = extractAiJsonObject(content);
    if (!parsed) return fallback;
    return normalizeAiQueryIntent(parsed, fallback);
  } catch (error) {
    console.warn("[TelegramBot] AI query intent fallback:", error);
    return fallback;
  }
}

function normalizeManageTargetKeyword(value: unknown) {
  let keyword = String(value || "")
    .trim()
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
    .replace(/^目标[:：]?\s*/i, "")
    .replace(/^用户[:：]?\s*/i, "")
    .replace(/^账号[:：]?\s*/i, "")
    .replace(/^账户[:：]?\s*/i, "")
    .trim();
  if (!keyword) return "";
  const parsed = parseNumericToken(keyword.replace(/^#/, ""));
  if (parsed) return String(parsed);
  return keyword.slice(0, 80);
}

function extractManageTargetKeyword(text: string) {
  const raw = text.replace(/^\/ask(?:@\w+)?\s*/i, "").trim();
  if (!raw) return "";
  if (/(我的|我自己|本人|self|me)/i.test(raw)) return "self";

  const explicit = raw.match(/(?:用户|账号|账户|user)\s*[:：#]?\s*([^\s，,。；;！？!?]+)/i);
  if (explicit?.[1]) return normalizeManageTargetKeyword(explicit[1]);

  const email = raw.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  if (email?.[0]) return normalizeManageTargetKeyword(email[0]);

  const hashId = raw.match(/#\s*([0-9]+)/);
  if (hashId?.[1]) return normalizeManageTargetKeyword(hashId[1]);

  const viaVerb = raw.match(/(?:给|把|将|帮(?:我)?|为)\s*([^\s，,。；;！？!?]+)\s*(?:充值|续费|停用|启用|关闭|开启|重置|设置|调整|转发|流量|账号|账户|用户)/i);
  if (viaVerb?.[1]) return normalizeManageTargetKeyword(viaVerb[1]);

  return "";
}

function extractManageAmountYuan(text: string) {
  const cleaned = text
    .replace(/(?:用户|账号|账户|user)\s*#?\s*[0-9零〇一二两三四五六七八九十百千]+/gi, " ")
    .replace(/#\s*[0-9]+/g, " ");
  const withCurrency = cleaned.match(/([+-]?\d+(?:\.\d+)?)\s*(?:元|块|rmb|RMB|¥|￥)/);
  if (withCurrency?.[1]) {
    const amount = Number(withCurrency[1]);
    return Number.isFinite(amount) ? amount : undefined;
  }
  const nearVerb = cleaned.match(/(?:充值|充|加钱|加|增加|补款|退款|扣除|扣减|扣|减少|减去|调整(?:余额|金额)?|设置(?:余额)?(?:为|成)?|设为|改为|改成|变成)\s*([+-]?\d+(?:\.\d+)?)/);
  if (nearVerb?.[1]) {
    const amount = Number(nearVerb[1]);
    return Number.isFinite(amount) ? amount : undefined;
  }
  return undefined;
}

function parseManageCodeCount(value: unknown) {
  const parsed = parseNumericToken(value);
  if (!Number.isFinite(parsed as number)) return undefined;
  const count = Math.floor(Number(parsed));
  if (!Number.isFinite(count) || count <= 0) return undefined;
  return count;
}

function normalizeManageDiscountPercent(value: unknown) {
  const numeric = Math.round(Number(value));
  if (!Number.isFinite(numeric) || numeric <= 0 || numeric > 100) return undefined;
  return numeric;
}

function extractManageCodeCount(text: string) {
  const raw = text.replace(/^\/ask(?:@\w+)?\s*/i, "").trim();
  if (!raw) return undefined;

  const byCountAndCode = raw.match(
    /([0-9零〇一二两三四五六七八九十百千]+)\s*(?:个|张|份|组)\s*(?:[0-9]+(?:\.\d+)?\s*(?:元|块|¥|￥)?\s*)?(?:余额|充值|折扣|优惠)?(?:兑换码|折扣码|优惠码|代金码)/i,
  );
  if (byCountAndCode?.[1]) {
    return parseManageCodeCount(byCountAndCode[1]);
  }

  const byGenerateCount = raw.match(
    /(?:生成|创建|新增|来|发|做|弄)\s*([0-9零〇一二两三四五六七八九十百千]+)\s*(?:个|张|份|组)/i,
  );
  if (byGenerateCount?.[1]) {
    return parseManageCodeCount(byGenerateCount[1]);
  }

  const byDirectCount = raw.match(
    /(?:生成|创建|新增|来|发|做|弄|给我)\s*([0-9零〇一二两三四五六七八九十百千]+)\s*(?:个|张|份|组)?\s*(?:余额|充值|折扣|优惠)?(?:兑换码|折扣码|优惠码|代金码)/i,
  );
  if (byDirectCount?.[1]) {
    return parseManageCodeCount(byDirectCount[1]);
  }
  return undefined;
}

function extractManageRedeemAmountYuan(text: string) {
  const raw = text.replace(/^\/ask(?:@\w+)?\s*/i, "").trim();
  if (!raw) return undefined;

  const byCountThenAmount = raw.match(
    /(?:[0-9零〇一二两三四五六七八九十百千]+)\s*(?:个|张|份|组)\s*([+-]?\d+(?:\.\d+)?)\s*(?:元|块|¥|￥)?\s*(?:余额|充值)?(?:兑换码|代金码)/i,
  );
  if (byCountThenAmount?.[1]) {
    const amount = Number(byCountThenAmount[1]);
    if (Number.isFinite(amount)) return amount;
  }

  const byPer = raw.match(/(?:每个|每张|单个|面额|金额|额度)\s*[:：]?\s*([+-]?\d+(?:\.\d+)?)\s*(?:元|块|¥|￥)?/i);
  if (byPer?.[1]) {
    const amount = Number(byPer[1]);
    if (Number.isFinite(amount)) return amount;
  }

  const byCodeAmount = raw.match(/([+-]?\d+(?:\.\d+)?)\s*(?:元|块|¥|￥)?\s*(?:的)?\s*(?:余额|充值)?(?:兑换码|代金码)/i);
  if (byCodeAmount?.[1]) {
    const amount = Number(byCodeAmount[1]);
    if (Number.isFinite(amount)) return amount;
  }
  return undefined;
}

function extractManageDiscountPercent(text: string) {
  const raw = text.replace(/^\/ask(?:@\w+)?\s*/i, "").trim();
  if (!raw) return undefined;

  const byZhe = raw.match(/([0-9]+(?:\.\d+)?)\s*折/);
  if (byZhe?.[1]) {
    const zhe = Number(byZhe[1]);
    if (Number.isFinite(zhe) && zhe > 0 && zhe <= 10) {
      return normalizeManageDiscountPercent(Math.round((10 - zhe) * 10));
    }
  }

  const byPercent = raw.match(/([1-9]\d{0,2})\s*%\s*(?:off|折扣|优惠|折)?/i)
    || raw.match(/(?:减|优惠|折扣)\s*([1-9]\d{0,2})\s*%/i)
    || raw.match(/(?:减|优惠|折扣)\s*([1-9]\d{0,2})\s*(?:个点|百分点)/i)
    || raw.match(/^([1-9]\d{0,2})\s*%?$/i);
  if (byPercent?.[1]) {
    return normalizeManageDiscountPercent(byPercent[1]);
  }
  return undefined;
}

function extractManageDuration(text: string): { value: number; unit: ManageDurationUnit } | null {
  const hit = text.match(/([0-9零〇一二两三四五六七八九十百千]+)\s*(天|日|个月|月|年)/);
  if (!hit) return null;
  const value = parseNumericToken(hit[1]) || Number(hit[1]);
  if (!Number.isFinite(value) || value <= 0) return null;
  const rawUnit = hit[2];
  const unit: ManageDurationUnit = rawUnit === "年"
    ? "year"
    : (rawUnit === "天" || rawUnit === "日" ? "day" : "month");
  return { value: Math.max(1, Math.floor(Number(value))), unit };
}

function extractManageRuleId(text: string) {
  return extractRuleId(text);
}

function normalizeManageTunnelKeyword(value: unknown) {
  let keyword = String(value || "")
    .trim()
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
    .replace(/^目标[:：]?\s*/i, "")
    .replace(/^(?:隧道|链路|tunnel|link)\s*/i, "")
    .replace(/\s*(?:隧道|链路|tunnel|link)\s*$/i, "")
    .replace(/\s*(?:的)?\s*(?:规则|rule)\s*$/i, "")
    .trim();
  if (!keyword) return "";
  const parsed = parseNumericToken(keyword.replace(/^#/, ""));
  if (parsed) return String(parsed);
  return keyword.slice(0, 80);
}

function extractManageTunnelKeyword(text: string) {
  const raw = text.replace(/^\/ask(?:@\w+)?\s*/i, "").trim();
  if (!raw) return "";

  const byEntity = raw.match(/(?:隧道|链路|tunnel|link)\s*[:：#]?\s*([^\s，,。；;！？!?]+)/i);
  if (byEntity?.[1]) return normalizeManageTunnelKeyword(byEntity[1]);

  const byVerbBefore = raw.match(/(?:关闭|停用|禁用|开启|启用|恢复)\s*([^\s，,。；;！？!?]+)\s*(?:隧道|链路|tunnel|link)(?:的)?规则/i);
  if (byVerbBefore?.[1]) return normalizeManageTunnelKeyword(byVerbBefore[1]);

  const byVerbAfter = raw.match(/(?:关闭|停用|禁用|开启|启用|恢复)\s*(?:隧道|链路|tunnel|link)\s*([^\s，,。；;！？!?]+)(?:的)?规则/i);
  if (byVerbAfter?.[1]) return normalizeManageTunnelKeyword(byVerbAfter[1]);

  const byHashId = raw.match(/#\s*([0-9]+)\s*(?:隧道|链路|tunnel|link)/i);
  if (byHashId?.[1]) return normalizeManageTunnelKeyword(byHashId[1]);

  return "";
}

function normalizeManageHostKeyword(value: unknown) {
  let keyword = String(value || "")
    .trim()
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
    .replace(/^目标[:：]?\s*/i, "")
    .replace(/^(?:主机|机器|节点|agent|host|server)\s*/i, "")
    .replace(/\s*(?:主机|机器|节点|agent|host|server)\s*$/i, "")
    .trim();
  if (!keyword) return "";
  const parsed = parseNumericToken(keyword.replace(/^#/, ""));
  if (parsed) return String(parsed);
  return keyword.slice(0, 80);
}

function extractManageHostKeyword(text: string) {
  const raw = text.replace(/^\/ask(?:@\w+)?\s*/i, "").trim();
  if (!raw) return "";

  const byEntity = raw.match(/(?:主机|机器|节点|agent|host|server)\s*[:：#]?\s*([^\s，,。；;！？!?]+)/i);
  if (byEntity?.[1]) return normalizeManageHostKeyword(byEntity[1]);

  const byVerb = raw.match(/(?:添加|新增|增加|创建|删除|移除)\s*([^\s，,。；;！？!?]+)\s*(?:主机|机器|节点|agent|host|server)/i);
  if (byVerb?.[1]) return normalizeManageHostKeyword(byVerb[1]);

  const byHashId = raw.match(/#\s*([0-9]+)\s*(?:主机|机器|节点|agent|host|server)/i);
  if (byHashId?.[1]) return normalizeManageHostKeyword(byHashId[1]);

  return "";
}

function normalizeManageForwardMode(value: unknown): ManageForwardMode | undefined {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return undefined;
  if (/(隧道|链路|tunnel|link)/i.test(raw)) return "tunnel";
  if (/(端口|主机|host|server|machine|节点|直连|普通转发)/i.test(raw)) return "host";
  return undefined;
}

function extractManageForwardMode(text: string): ManageForwardMode | undefined {
  const raw = text.replace(/^\/ask(?:@\w+)?\s*/i, "").trim();
  if (!raw) return undefined;
  const hasTunnel = /(隧道转发|隧道规则|隧道|链路|tunnel|link)/i.test(raw);
  const hasHost = /(端口转发|主机转发|主机|机器|节点|host|server|普通转发|直连)/i.test(raw);
  if (hasTunnel && !hasHost) return "tunnel";
  if (hasHost && !hasTunnel) return "host";
  if (/(加入|添加到|走)\s*(?:隧道|链路)/i.test(raw)) return "tunnel";
  if (/(端口转发|普通转发|直连)/i.test(raw)) return "host";
  return undefined;
}

function normalizeManageTargetIp(value: unknown) {
  let host = String(value || "")
    .trim()
    .replace(/^目标[:：]?\s*/i, "")
    .replace(/^到\s*/i, "")
    .replace(/^转发到\s*/i, "")
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "");
  if (!host) return "";
  if (/^https?:\/\//i.test(host)) {
    try {
      host = new URL(host).hostname || host;
    } catch {
      // ignore invalid URL parsing
    }
  }
  host = host.replace(/^\[+|\]+$/g, "").trim();
  return host.slice(0, 253);
}

function parseManagePort(value: unknown) {
  const port = Math.floor(Number(value));
  if (!Number.isFinite(port) || port < 1 || port > 65535) return undefined;
  return port;
}

function extractManageTargetEndpoint(text: string): { targetIp?: string; targetPort?: number } {
  const raw = text.replace(/^\/ask(?:@\w+)?\s*/i, "").trim();
  if (!raw) return {};

  const bracketHost = raw.match(/\[\s*([0-9a-fA-F:]+)\s*]\s*[:：]\s*(\d{1,5})/);
  if (bracketHost?.[1] && bracketHost?.[2]) {
    const targetPort = parseManagePort(bracketHost[2]);
    const targetIp = normalizeManageTargetIp(bracketHost[1]);
    if (targetIp && targetPort) return { targetIp, targetPort };
  }

  const toPort = raw.match(/(?:目标|转发到|到)\s*([A-Za-z0-9._:\-\[\]]+)\s*(?:的)?\s*(\d{1,5})\s*端口/i);
  if (toPort?.[1] && toPort?.[2]) {
    const targetPort = parseManagePort(toPort[2]);
    const targetIp = normalizeManageTargetIp(toPort[1]);
    if (targetIp && targetPort) return { targetIp, targetPort };
  }

  const hostPort = raw.match(/([A-Za-z0-9][A-Za-z0-9._:-]{1,252})\s*[:：]\s*(\d{1,5})/);
  if (hostPort?.[1] && hostPort?.[2]) {
    const targetPort = parseManagePort(hostPort[2]);
    const targetIp = normalizeManageTargetIp(hostPort[1]);
    if (targetIp && targetPort) return { targetIp, targetPort };
  }

  return {};
}

function extractManageSourcePort(text: string): number | undefined {
  const raw = text.replace(/^\/ask(?:@\w+)?\s*/i, "").trim();
  if (!raw) return undefined;
  if (/(随机(?:源)?端口|自动(?:分配)?端口|auto\s*port)/i.test(raw)) return 0;

  const byName = raw.match(/(?:源端口|入口端口|监听端口|本地端口|source\s*port|listen\s*port)\s*[:：]?\s*(\d{1,5})/i);
  if (byName?.[1]) return parseManagePort(byName[1]);

  const byFrom = raw.match(/从\s*(\d{1,5})\s*端口/i);
  if (byFrom?.[1]) return parseManagePort(byFrom[1]);

  const byEntry = raw.match(/入口\s*[:：]?\s*(\d{1,5})/i);
  if (byEntry?.[1]) return parseManagePort(byEntry[1]);

  return undefined;
}

function normalizeManageActionIntent(value: any, fallback: ManageActionIntent): ManageActionIntent {
  const allowed = new Set<ManageActionKind>([
    "none",
    "balance_set",
    "balance_adjust",
    "renew",
    "account_enable",
    "account_disable",
    "forward_enable",
    "forward_disable",
    "rule_enable",
    "rule_disable",
    "rule_create",
    "rule_delete",
    "tunnel_rules_enable",
    "tunnel_rules_disable",
    "traffic_reset",
    "redeem_code_generate_balance",
    "discount_code_generate_percent",
  ]);
  const action = allowed.has(value?.action as ManageActionKind)
    ? (value.action as ManageActionKind)
    : fallback.action;
  const target = normalizeManageTargetKeyword(value?.target || fallback.target);
  const amountModel = Number(value?.amountYuan);
  const amountFallback = Number(fallback.amountYuan);
  const amountYuan = Number.isFinite(amountModel)
    ? amountModel
    : (Number.isFinite(amountFallback) ? amountFallback : undefined);
  const durationModel = Math.floor(Number(value?.durationValue));
  const durationFallback = Math.floor(Number(fallback.durationValue));
  const durationValue = Number.isFinite(durationModel) && durationModel > 0
    ? durationModel
    : (Number.isFinite(durationFallback) && durationFallback > 0 ? durationFallback : undefined);
  const durationUnitRaw = String(value?.durationUnit || fallback.durationUnit || "").toLowerCase();
  const durationUnit: ManageDurationUnit | undefined =
    durationUnitRaw === "day" || durationUnitRaw === "month" || durationUnitRaw === "year"
      ? (durationUnitRaw as ManageDurationUnit)
      : undefined;
  const modelRuleId = parseNumericToken(value?.ruleId);
  const fallbackRuleId = parseNumericToken(fallback.ruleId);
  const ruleId = modelRuleId || fallbackRuleId;
  const tunnel = normalizeManageTunnelKeyword(value?.tunnel || fallback.tunnel);
  const host = normalizeManageHostKeyword(value?.host || fallback.host);
  const forwardMode = normalizeManageForwardMode(value?.forwardMode || fallback.forwardMode);
  const modelTargetIp = normalizeManageTargetIp(value?.targetIp);
  const fallbackTargetIp = normalizeManageTargetIp(fallback.targetIp);
  const targetIp = modelTargetIp || fallbackTargetIp;
  const modelTargetPort = parseManagePort(value?.targetPort);
  const fallbackTargetPort = parseManagePort(fallback.targetPort);
  const targetPort = modelTargetPort || fallbackTargetPort;
  const sourceModelRaw = value?.sourcePort;
  const sourceFallbackRaw = fallback.sourcePort;
  const sourcePortModel = sourceModelRaw === 0 || String(sourceModelRaw || "").trim() === "0"
    ? 0
    : parseManagePort(sourceModelRaw);
  const sourcePortFallback = sourceFallbackRaw === 0 || String(sourceFallbackRaw || "").trim() === "0"
    ? 0
    : parseManagePort(sourceFallbackRaw);
  const sourcePort = sourcePortModel ?? sourcePortFallback;
  const codeCountModel = parseManageCodeCount(value?.codeCount);
  const codeCountFallback = parseManageCodeCount(fallback.codeCount);
  const codeCount = codeCountModel || codeCountFallback;
  const discountPercentModel = normalizeManageDiscountPercent(value?.discountPercent);
  const discountPercentFallback = normalizeManageDiscountPercent(fallback.discountPercent);
  const discountPercent = discountPercentModel || discountPercentFallback;
  return {
    action,
    ...(target ? { target } : {}),
    ...(Number.isFinite(amountYuan as number) ? { amountYuan } : {}),
    ...(durationValue ? { durationValue } : {}),
    ...(durationUnit ? { durationUnit } : {}),
    ...(ruleId ? { ruleId } : {}),
    ...(tunnel ? { tunnel } : {}),
    ...(host ? { host } : {}),
    ...(forwardMode ? { forwardMode } : {}),
    ...(targetIp ? { targetIp } : {}),
    ...(targetPort ? { targetPort } : {}),
    ...(sourcePort !== undefined ? { sourcePort } : {}),
    ...(codeCount ? { codeCount } : {}),
    ...(discountPercent ? { discountPercent } : {}),
  };
}

function extractManageIntentPatchFromText(text: string, missingFields: ManageClarifyField[] = []): Partial<ManageActionIntent> {
  const raw = text.replace(/^\/ask(?:@\w+)?\s*/i, "").trim();
  if (!raw) return {};
  const expectAmount = missingFields.includes("amountYuan");
  const expectCodeCount = missingFields.includes("codeCount");
  const expectDiscountPercent = missingFields.includes("discountPercent");
  const plainNumberMatch = raw.match(/^([+-]?\d+(?:\.\d+)?)$/);
  const hasCountUnit = /(?:个|张|份|组)/i.test(raw);
  const target = normalizeManageTargetKeyword(extractManageTargetKeyword(raw));
  const amountRaw = extractManageAmountYuan(raw);
  const redeemAmountRaw = extractManageRedeemAmountYuan(raw);
  let amountYuan = Number.isFinite(Number(amountRaw)) ? Number(amountRaw) : undefined;
  if (!Number.isFinite(amountYuan as number) && Number.isFinite(Number(redeemAmountRaw))) {
    amountYuan = Number(redeemAmountRaw);
  }
  if (!Number.isFinite(amountYuan as number) && expectAmount) {
    if (plainNumberMatch?.[1]) {
      const parsed = Number(plainNumberMatch[1]);
      if (Number.isFinite(parsed)) amountYuan = parsed;
    }
  }
  let codeCount = extractManageCodeCount(raw);
  if (!Number.isFinite(codeCount as number) && expectCodeCount) {
    const shouldDeferCodeCountForSingleNumber = !!plainNumberMatch?.[1] && !hasCountUnit && (expectAmount || expectDiscountPercent);
    if (!shouldDeferCodeCountForSingleNumber) {
      codeCount = parseManageCodeCount(raw);
    }
  }
  let discountPercent = extractManageDiscountPercent(raw);
  if (!Number.isFinite(discountPercent as number) && expectDiscountPercent) {
    const unsignedNumber = plainNumberMatch?.[1]?.startsWith("+")
      ? plainNumberMatch[1].slice(1)
      : plainNumberMatch?.[1];
    if (unsignedNumber && /^[0-9]+(?:\.\d+)?$/.test(unsignedNumber)) {
      const numeric = Number(unsignedNumber);
      if (Number.isFinite(numeric)) {
        discountPercent = numeric > 0 && numeric <= 10
          ? normalizeManageDiscountPercent(Math.round((10 - numeric) * 10))
          : normalizeManageDiscountPercent(Math.round(numeric));
      }
    }
  }
  const duration = extractManageDuration(raw);
  const ruleId = extractManageRuleId(raw);
  const tunnel = normalizeManageTunnelKeyword(extractManageTunnelKeyword(raw));
  const host = normalizeManageHostKeyword(extractManageHostKeyword(raw));
  const forwardMode = normalizeManageForwardMode(extractManageForwardMode(raw));
  const endpoint = extractManageTargetEndpoint(raw);
  const targetIp = normalizeManageTargetIp(endpoint.targetIp || "");
  const targetPort = parseManagePort(endpoint.targetPort);
  const sourceRaw = extractManageSourcePort(raw);
  const sourcePort = sourceRaw === 0 ? 0 : parseManagePort(sourceRaw);
  const patch: Partial<ManageActionIntent> = {};
  if (target) patch.target = target;
  if (Number.isFinite(amountYuan as number)) patch.amountYuan = Number(amountYuan);
  if (duration) {
    patch.durationValue = duration.value;
    patch.durationUnit = duration.unit;
  }
  if (ruleId) patch.ruleId = ruleId;
  if (tunnel) patch.tunnel = tunnel;
  if (host) patch.host = host;
  if (forwardMode) patch.forwardMode = forwardMode;
  if (sourcePort !== undefined) patch.sourcePort = sourcePort;
  if (targetIp) patch.targetIp = targetIp;
  if (targetPort) patch.targetPort = targetPort;
  if (Number.isFinite(codeCount as number)) patch.codeCount = Number(codeCount);
  if (Number.isFinite(discountPercent as number)) patch.discountPercent = Number(discountPercent);
  return patch;
}

function mergeManageActionIntent(base: ManageActionIntent, patch: Partial<ManageActionIntent>) {
  return normalizeManageActionIntent({ ...base, ...patch, action: base.action }, base);
}

function localManageActionIntent(text: string): { intent: ManageActionIntent; writeLike: boolean } {
  const raw = text.replace(/^\/ask(?:@\w+)?\s*/i, "").trim();
  if (!raw) return { intent: { action: "none" }, writeLike: false };
  const writeLike = /(充值|充钱|余额|续费|续期|延期|停用|禁用|启用|恢复|关闭|开启|重置|清零|扣除|扣减|减少|增加|新增|添加|创建|删除|移除|调整|规则|转发|折扣码|优惠码|兑换码|代金码)/i.test(raw);
  const enableVerb = /(开启|启用|恢复|打开)/i.test(raw);
  const disableVerb = /(关闭|停用|禁用|暂停)/i.test(raw);
  const createVerb = /(新增|添加|增加|创建|加一个|开一个|新建)/i.test(raw);
  const generateVerb = /(?:生成|给我生成|来|发我|发我点|做|弄)/i.test(raw);
  const deleteVerb = /(删除|移除|去掉|取消|删掉)/i.test(raw);
  const hasForwardWord = /(转发|规则|rule|port|端口)/i.test(raw);
  const hasRuleWord = /(规则|rule)/i.test(raw);
  const hasTunnelWord = /(隧道|链路|tunnel|link)/i.test(raw);
  const hasDiscountCodeWord = /(折扣码|优惠码|优惠券|折扣券|discount\s*code)/i.test(raw);
  const hasRedeemCodeWord = /(兑换码|余额码|代金码|redeem\s*code)/i.test(raw);
  const codeCount = extractManageCodeCount(raw);
  const discountPercent = extractManageDiscountPercent(raw);
  const ruleId = extractManageRuleId(raw);
  const endpoint = extractManageTargetEndpoint(raw);
  const sourcePort = extractManageSourcePort(raw);
  const forwardMode = extractManageForwardMode(raw);
  const tunnelKeyword = normalizeManageTunnelKeyword(extractManageTunnelKeyword(raw));
  const hostKeyword = normalizeManageHostKeyword(extractManageHostKeyword(raw));
  let action: ManageActionKind = "none";
  if ((createVerb || generateVerb) && hasDiscountCodeWord) {
    action = "discount_code_generate_percent";
  } else if ((createVerb || generateVerb) && hasRedeemCodeWord) {
    action = "redeem_code_generate_balance";
  } else if (
    (/(?:折扣|优惠).*(?:码|code)|(?:码|code).*(?:折扣|优惠)/i.test(raw))
    && /(?:生成|创建|新增|来|发|做|弄)/i.test(raw)
  ) {
    action = "discount_code_generate_percent";
  } else if (
    (/(?:余额|充值|兑换|代金).*(?:码|code)|(?:码|code).*(?:余额|充值|兑换|代金)/i.test(raw))
    && /(?:生成|创建|新增|来|发|做|弄)/i.test(raw)
  ) {
    action = "redeem_code_generate_balance";
  } else if (deleteVerb && (hasForwardWord || ruleId || endpoint.targetPort)) {
    action = "rule_delete";
  } else if (createVerb && (hasForwardWord || endpoint.targetPort)) {
    action = "rule_create";
  } else if (hasRuleWord && hasTunnelWord && disableVerb) {
    action = "tunnel_rules_disable";
  } else if (hasRuleWord && hasTunnelWord && enableVerb) {
    action = "tunnel_rules_enable";
  } else if (hasRuleWord && ruleId && disableVerb) {
    action = "rule_disable";
  } else if (hasRuleWord && ruleId && enableVerb) {
    action = "rule_enable";
  } else if (/(重置|清零).*(流量|用量|traffic)|(?:流量|用量).*(重置|清零)/i.test(raw)) {
    action = "traffic_reset";
  } else if (/(停用|禁用|关闭|封禁).*(账号|账户|用户)|(?:账号|账户|用户).*(停用|禁用|关闭|封禁)/i.test(raw)) {
    action = "account_disable";
  } else if (/(启用|恢复|解封).*(账号|账户|用户)|(?:账号|账户|用户).*(启用|恢复|解封)/i.test(raw)) {
    action = "account_enable";
  } else if (/(关闭|停用|禁用).*(转发|转发权限|规则权限)|(?:转发|转发权限|规则权限).*(关闭|停用|禁用)/i.test(raw)) {
    action = "forward_disable";
  } else if (/(开启|启用|恢复).*(转发|转发权限|规则权限)|(?:转发|转发权限|规则权限).*(开启|启用|恢复)/i.test(raw)) {
    action = "forward_enable";
  } else if (/(续费|续期|延期|延长)/i.test(raw)) {
    action = "renew";
  } else if (/(余额|余款).*(设置|设为|改为|改成|变成)|(?:设置|设为|改为|改成|变成).*(余额|余款)/i.test(raw)) {
    action = "balance_set";
  } else if (/(充值|充钱|加钱|加余额|扣除|扣减|扣|减少|减去|增减|调整(?:余额|金额)?|补款|退款)/i.test(raw)) {
    action = "balance_adjust";
  } else if (/^(给|把|将|帮(?:我)?|为).*(\d+(?:\.\d+)?)(?:元|块|¥|￥)?/.test(raw)) {
    action = "balance_adjust";
  }

  const target = normalizeManageTargetKeyword(extractManageTargetKeyword(raw));
  const amountRaw = extractManageAmountYuan(raw);
  const redeemAmountRaw = extractManageRedeemAmountYuan(raw);
  let amountYuan = Number.isFinite(amountRaw as number) ? Number(amountRaw) : undefined;
  if (!Number.isFinite(amountYuan as number) && Number.isFinite(redeemAmountRaw as number)) {
    amountYuan = Number(redeemAmountRaw);
  }
  if (Number.isFinite(amountYuan as number) && action === "balance_adjust") {
    if (/(扣除|扣减|减少|减去|下调)/.test(raw) && (amountYuan as number) > 0) amountYuan = -Math.abs(amountYuan as number);
    if (/(充值|充钱|加钱|增加|补款|上调)/.test(raw) && (amountYuan as number) < 0) amountYuan = Math.abs(amountYuan as number);
  }

  const duration = extractManageDuration(raw);
  return {
    writeLike: writeLike || action !== "none",
    intent: {
      action,
      ...(target ? { target } : {}),
      ...(Number.isFinite(amountYuan as number) ? { amountYuan } : {}),
      ...(duration ? { durationValue: duration.value, durationUnit: duration.unit } : {}),
      ...(ruleId ? { ruleId } : {}),
      ...(tunnelKeyword ? { tunnel: tunnelKeyword } : {}),
      ...(hostKeyword ? { host: hostKeyword } : {}),
      ...(forwardMode ? { forwardMode } : {}),
      ...(sourcePort !== undefined ? { sourcePort } : {}),
      ...(endpoint.targetIp ? { targetIp: endpoint.targetIp } : {}),
      ...(endpoint.targetPort ? { targetPort: endpoint.targetPort } : {}),
      ...(Number.isFinite(codeCount as number) ? { codeCount: Number(codeCount) } : {}),
      ...(Number.isFinite(discountPercent as number) ? { discountPercent: Number(discountPercent) } : {}),
    },
  };
}

async function parseManageActionIntent(text: string): Promise<{ intent: ManageActionIntent; writeLike: boolean }> {
  const fallback = localManageActionIntent(text);
  if (!fallback.writeLike) return fallback;
  const settings = await getDeepSeekSettings().catch(() => null);
  if (!settings?.enabled || !settings.apiKey) return fallback;
  try {
    const resp = await fetch(settings.chatCompletionsUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${settings.apiKey}`,
      },
      body: JSON.stringify({
        model: settings.model,
        messages: [
          {
            role: "system",
            content: [
              "You classify ForwardX Telegram write-operation intents.",
              "Return only JSON keys: action,target,amountYuan,durationValue,durationUnit,ruleId,tunnel,host,forwardMode,sourcePort,targetIp,targetPort,codeCount,discountPercent,writeLike.",
              "Allowed action: none,balance_set,balance_adjust,renew,account_enable,account_disable,forward_enable,forward_disable,rule_enable,rule_disable,rule_create,rule_delete,tunnel_rules_enable,tunnel_rules_disable,traffic_reset,redeem_code_generate_balance,discount_code_generate_percent.",
              "target should be user id/username/email/remark keyword when possible.",
              "durationUnit must be one of day,month,year.",
              "Use rule_enable/rule_disable when user asks to enable/disable a specific rule by id.",
              "Use rule_create for add/create forwarding rule requests.",
              "Use rule_delete for delete/remove forwarding rule requests.",
              "forwardMode should be host or tunnel when user states port-forward/tunnel-forward explicitly.",
              "sourcePort can be 0 when user asks random source port.",
              "targetIp and targetPort should be extracted when user provides destination endpoint.",
              "Use tunnel_rules_enable/tunnel_rules_disable when user asks to batch enable/disable rules in a tunnel, and include tunnel keyword.",
              "ruleId should be numeric when available.",
              "For recharge/add/subtract balance use balance_adjust.",
              "For set balance directly use balance_set.",
              "Use redeem_code_generate_balance when user asks to create/generate balance redemption codes; include amountYuan (face value in CNY) and codeCount when available.",
              "Use discount_code_generate_percent when user asks to create/generate discount codes; discountPercent means off-percent (e.g. 20 means 20% off, equivalent to 8-zhe), include codeCount when available.",
              "If message is not a write operation, action should be none and writeLike false.",
              "Do not answer user; do not use markdown.",
            ].join(" "),
          },
          { role: "user", content: text.slice(0, 500) },
        ],
        response_format: { type: "json_object" },
        temperature: 0,
        max_tokens: Math.min(512, Math.max(128, Math.floor(settings.maxTokens || DEFAULT_DEEPSEEK_MAX_TOKENS))),
      }),
    });
    if (!resp.ok) throw new Error(`AI HTTP ${resp.status}`);
    const json = await resp.json().catch(() => null) as any;
    const content = String(json?.choices?.[0]?.message?.content || "");
    const parsed = extractAiJsonObject(content);
    if (!parsed) return fallback;
    const intent = normalizeManageActionIntent(parsed, fallback.intent);
    return {
      intent,
      writeLike: Boolean(parsed?.writeLike) || fallback.writeLike || intent.action !== "none",
    };
  } catch (error) {
    console.warn("[TelegramBot] AI manage intent fallback:", error);
    return fallback;
  }
}

function isManageActionAllowedForRole(role: unknown, action: ManageActionKind) {
  if (action === "none") return false;
  if (String(role) === "admin") return true;
  return action === "forward_enable"
    || action === "forward_disable"
    || action === "rule_create"
    || action === "rule_delete"
    || action === "rule_enable"
    || action === "rule_disable"
    || action === "tunnel_rules_enable"
    || action === "tunnel_rules_disable";
}

function manageRoleLabel(role: unknown) {
  return String(role) === "admin" ? "管理员" : "用户";
}

function manageActionLabel(action: Exclude<ManageActionKind, "none">) {
  const mapping: Record<Exclude<ManageActionKind, "none">, string> = {
    balance_set: "设置余额",
    balance_adjust: "调整余额",
    renew: "续费",
    account_enable: "启用账号",
    account_disable: "停用账号",
    forward_enable: "启用转发",
    forward_disable: "关闭转发",
    rule_enable: "启用规则",
    rule_disable: "关闭规则",
    rule_create: "新增转发规则",
    rule_delete: "删除转发规则",
    tunnel_rules_enable: "启用隧道规则",
    tunnel_rules_disable: "关闭隧道规则",
    traffic_reset: "重置流量",
    redeem_code_generate_balance: "生成余额兑换码",
    discount_code_generate_percent: "生成折扣码",
  };
  return mapping[action];
}

function manageActionPermissionHint(isAdmin: boolean) {
  if (isAdmin) {
    return "管理员可执行：余额设置/调整、续费、启停账号、启停转发、规则新增/删除/启停、按隧道批量启停规则、重置流量、生成兑换码与折扣码。";
  }
  return "普通用户仅可操作自己的转发开关与可见规则（新增/删除/单条启停/按隧道批量启停），例如“新增转发到 10.10.0.1:5151”、“删除第12条规则”。";
}

function isSelfTargetForUser(actor: any, keyword: string) {
  const raw = normalizeManageTargetKeyword(keyword).toLowerCase();
  if (!raw) return true;
  if (["我", "我的", "我自己", "本人", "self", "me"].includes(raw)) return true;
  const actorId = String(actor?.id || "");
  if (raw === actorId || raw === `#${actorId}`) return true;
  const userTokens = [actor?.username, actor?.email, actor?.name]
    .map((v) => String(v || "").trim().toLowerCase())
    .filter(Boolean);
  if (userTokens.includes(raw)) return true;
  const numeric = parseNumericToken(raw.replace(/^#/, "").replace(/^(用户|账号|账户|user)/i, ""));
  return Number.isFinite(numeric as number) && Number(numeric) === Number(actor?.id || 0);
}

async function resolveManageTargetUser(actor: any, rawKeyword: string) {
  const keyword = normalizeManageTargetKeyword(rawKeyword);
  const isAdmin = String(actor?.role) === "admin";
  if (!isAdmin) {
    if (isSelfTargetForUser(actor, keyword)) return { target: actor };
    return { error: "普通用户仅可操作自己的账号。可使用“关闭我的转发”或“启用我的转发”。" };
  }
  if (!keyword) return { error: "请指定目标用户（ID、用户名、邮箱或备注名）。" };
  if (["我", "我的", "我自己", "本人", "self", "me"].includes(keyword.toLowerCase())) return { target: actor };

  const users = await db.getUserTrafficSummaries();
  const normalizedIdKeyword = keyword
    .replace(/^#/, "")
    .replace(/^(用户|账号|账户|user)\s*/i, "");
  const numericId = parseNumericToken(normalizedIdKeyword);
  const matchedById = numericId ? (users as any[]).filter((item) => Number(item.id) === Number(numericId)) : [];
  const matched = matchedById.length > 0
    ? matchedById
    : (users as any[]).filter((item) => {
      const variants = [keyword, normalizedIdKeyword].filter(Boolean);
      return variants.some((needle) => searchMatches(needle, userSearchValues(item)));
    });
  if (matched.length === 0) {
    return { error: `没有找到匹配用户：${escapeHtml(keyword)}` };
  }
  if (matched.length > 1) {
    const preview = matched
      .slice(0, 5)
      .map((item: any) => `#${item.id} ${item.name || item.username}`)
      .join("、");
    return { error: `匹配到多个用户：${escapeHtml(preview)}。请补充更精确的用户ID或邮箱。` };
  }
  return { target: matched[0] };
}

function isRuleManageAction(action: ManageActionKind) {
  return action === "rule_enable"
    || action === "rule_disable"
    || action === "rule_create"
    || action === "rule_delete"
    || action === "tunnel_rules_enable"
    || action === "tunnel_rules_disable";
}

async function resolveManageTunnel(actor: any, rawKeyword: string) {
  const keyword = normalizeManageTunnelKeyword(rawKeyword);
  if (!keyword) return { error: "请指定隧道（ID 或名称），例如：关闭 2 号隧道的规则。" };
  const tunnels = await visibleTunnelsForTelegramUser(actor);
  const numericId = parseNumericToken(keyword.replace(/^#/, ""));
  const matchedById = numericId ? (tunnels as any[]).filter((item) => Number(item.id) === Number(numericId)) : [];
  const matched = matchedById.length > 0
    ? matchedById
    : (tunnels as any[]).filter((item: any) => searchMatches(keyword, tunnelSearchValues(item)));
  if (matched.length === 0) {
    return { error: `没有找到匹配隧道：${escapeHtml(keyword)}` };
  }
  if (matched.length > 1) {
    const preview = matched
      .slice(0, 5)
      .map((item: any) => `#${item.id} ${item.name || "-"}`)
      .join("、");
    return { error: `匹配到多个隧道：${escapeHtml(preview)}。请补充更精确的隧道 ID。` };
  }
  return { tunnel: matched[0] };
}

async function resolveManageHost(actor: any, rawKeyword: string) {
  const keyword = normalizeManageHostKeyword(rawKeyword);
  if (!keyword) return { error: "请指定主机（ID 或名称），例如：添加到上海主机。" };
  const hosts = await visibleHostsForTelegramUser(actor);
  const numericId = parseNumericToken(keyword.replace(/^#/, ""));
  const matchedById = numericId ? (hosts as any[]).filter((item) => Number(item.id) === Number(numericId)) : [];
  const matched = matchedById.length > 0
    ? matchedById
    : (hosts as any[]).filter((item: any) => searchMatches(keyword, hostSearchValues(item)));
  if (matched.length === 0) {
    return { error: `没有找到匹配主机：${escapeHtml(keyword)}` };
  }
  if (matched.length > 1) {
    const preview = matched
      .slice(0, 5)
      .map((item: any) => `#${item.id} ${item.name || item.ip || "-"}`)
      .join("、");
    return { error: `匹配到多个主机：${escapeHtml(preview)}。请补充更精确的主机 ID。` };
  }
  return { host: matched[0] };
}

async function prepareManageAction(user: any, sourceText: string, intent: ManageActionIntent): Promise<ManageActionPrepareResult> {
  if (!intent || intent.action === "none") return { error: "未识别到可执行的管理操作。" };
  const action = intent.action as Exclude<ManageActionKind, "none">;
  const actor = (await db.getUserById(Number(user?.id || 0)).catch(() => null)) || user;
  const isAdmin = String(actor?.role) === "admin";
  if (!isManageActionAllowedForRole(actor?.role, action)) {
    return { error: `你没有执行「${manageActionLabel(action)}」的权限。\n${manageActionPermissionHint(isAdmin)}` };
  }

  if (action === "redeem_code_generate_balance" || action === "discount_code_generate_percent") {
    const deepseekSettings = await getDeepSeekSettings().catch(() => null);
    if (!isAdmin) {
      return { error: "只有管理员可以生成兑换码或折扣码。" };
    }

    const askCountHint = /(几[个张份组]?|多少[个张份组]?|一批|批量|若干|一些)/i.test(sourceText);
    let codeCount = parseManageCodeCount(intent.codeCount ?? extractManageCodeCount(sourceText));
    if (!codeCount && !askCountHint) codeCount = 1;

    if (action === "redeem_code_generate_balance") {
      if (deepseekSettings?.redemptionEnabled === false) {
        return { error: "兑换码功能当前已关闭，请在设置中启用后再试。" };
      }
      const parsedAmount = Number.isFinite(Number(intent.amountYuan))
        ? Number(intent.amountYuan)
        : Number(extractManageRedeemAmountYuan(sourceText));
      const amountYuan = Number.isFinite(parsedAmount) ? parsedAmount : undefined;

      const missingFields: ManageClarifyField[] = [];
      if (!Number.isFinite(amountYuan as number)) missingFields.push("amountYuan");
      if (!codeCount) missingFields.push("codeCount");
      if (missingFields.length > 0) {
        const nextIntent: ManageActionIntent = {
          ...intent,
          action,
          ...(Number.isFinite(amountYuan as number) ? { amountYuan } : {}),
          ...(codeCount ? { codeCount } : {}),
        };
        let text = `请补充余额兑换码信息（${Math.round(MANAGE_CLARIFY_TTL_MS / 1000)} 秒内有效）。`;
        if (missingFields.includes("amountYuan") && missingFields.includes("codeCount")) {
          text = `请补充兑换码面额和数量，例如“50 元 20 个”（${Math.round(MANAGE_CLARIFY_TTL_MS / 1000)} 秒内有效）。`;
        } else if (missingFields.includes("amountYuan")) {
          text = `请补充每个兑换码金额（单位：元），例如“50”（${Math.round(MANAGE_CLARIFY_TTL_MS / 1000)} 秒内有效）。`;
        } else if (missingFields.includes("codeCount")) {
          text = `请补充要生成的兑换码数量，例如“20 个”（${Math.round(MANAGE_CLARIFY_TTL_MS / 1000)} 秒内有效）。`;
        }
        return {
          clarify: {
            actor,
            intent: nextIntent,
            missingFields,
            text,
            keyboard: manageClarifyCancelKeyboard(),
          },
        };
      }
      const amountCents = Math.round(Number(amountYuan) * 100);
      if (!Number.isFinite(amountCents) || amountCents <= 0) {
        return { error: "兑换码金额必须大于 0。" };
      }
      if (amountCents > MANAGE_BALANCE_MAX_CENTS) {
        return { error: "兑换码金额超出允许范围，请控制在 1,000,000 元以内。" };
      }
      if (!codeCount || codeCount <= 0 || codeCount > MANAGE_CODE_MAX_COUNT) {
        return { error: `兑换码数量必须在 1-${MANAGE_CODE_MAX_COUNT} 之间。` };
      }
      const pending: Omit<PendingManageAction, "key" | "createdAt" | "expiresAt"> = {
        actorUserId: Number(actor.id),
        actorRole: "admin",
        action,
        amountCents,
        codeCount,
        sourceText: sourceText.slice(0, 500),
      };
      return { prepared: { pending, actor } as PreparedManageAction };
    }

    if (deepseekSettings?.discountEnabled === false) {
      return { error: "折扣码功能当前已关闭，请在设置中启用后再试。" };
    }
    const discountPercent = normalizeManageDiscountPercent(
      intent.discountPercent ?? extractManageDiscountPercent(sourceText),
    );
    const missingFields: ManageClarifyField[] = [];
    if (!discountPercent) missingFields.push("discountPercent");
    if (!codeCount) missingFields.push("codeCount");
    if (missingFields.length > 0) {
      const nextIntent: ManageActionIntent = {
        ...intent,
        action,
        ...(discountPercent ? { discountPercent } : {}),
        ...(codeCount ? { codeCount } : {}),
      };
      let text = `请补充折扣码信息（${Math.round(MANAGE_CLARIFY_TTL_MS / 1000)} 秒内有效）。`;
      if (missingFields.includes("discountPercent") && missingFields.includes("codeCount")) {
        text = `请补充折扣力度和数量，例如“8 折 10 个”或“减 20% 10 个”（${Math.round(MANAGE_CLARIFY_TTL_MS / 1000)} 秒内有效）。`;
      } else if (missingFields.includes("discountPercent")) {
        text = `请补充折扣力度，例如“8 折”或“减 20%”（${Math.round(MANAGE_CLARIFY_TTL_MS / 1000)} 秒内有效）。`;
      } else if (missingFields.includes("codeCount")) {
        text = `请补充要生成的折扣码数量，例如“10 个”（${Math.round(MANAGE_CLARIFY_TTL_MS / 1000)} 秒内有效）。`;
      }
      return {
        clarify: {
          actor,
          intent: nextIntent,
          missingFields,
          text,
          keyboard: manageClarifyCancelKeyboard(),
        },
      };
    }
    if (!codeCount || codeCount <= 0 || codeCount > MANAGE_CODE_MAX_COUNT) {
      return { error: `折扣码数量必须在 1-${MANAGE_CODE_MAX_COUNT} 之间。` };
    }
    const pending: Omit<PendingManageAction, "key" | "createdAt" | "expiresAt"> = {
      actorUserId: Number(actor.id),
      actorRole: "admin",
      action,
      codeCount,
      discountPercent,
      sourceText: sourceText.slice(0, 500),
    };
    return { prepared: { pending, actor } as PreparedManageAction };
  }

  if (isRuleManageAction(action)) {
    const rules = await visibleRulesForTelegramUser(actor);
    if (action === "rule_enable" || action === "rule_disable" || action === "rule_delete") {
      const ruleId = parseNumericToken(intent.ruleId) || extractManageRuleId(sourceText);
      if (ruleId) {
        const targetRule = (rules as any[]).find((item: any) => Number(item.id) === Number(ruleId));
        if (!targetRule) return { error: `规则 #${ruleId} 不存在或无权操作。` };
        const targetUserId = Number((targetRule as any).userId || 0);
        const targetUser = targetUserId > 0 ? await db.getUserById(targetUserId).catch(() => null) : null;
        const pending: Omit<PendingManageAction, "key" | "createdAt" | "expiresAt"> = {
          actorUserId: Number(actor.id),
          actorRole: isAdmin ? "admin" : "user",
          action,
          ...(targetUserId > 0 ? { targetUserId } : {}),
          ruleId: Number((targetRule as any).id),
          rulePreview: [formatManageRulePreview(targetRule)],
          ...(Number((targetRule as any).hostId || 0) > 0 ? { hostId: Number((targetRule as any).hostId) } : {}),
          ...(Number((targetRule as any).tunnelId || 0) > 0 ? { tunnelId: Number((targetRule as any).tunnelId) } : {}),
          sourceText: sourceText.slice(0, 500),
        };
        return { prepared: { pending, target: targetUser || undefined, actor } as PreparedManageAction };
      }

      if (action !== "rule_delete") {
        return {
          error: action === "rule_enable"
            ? "请提供规则 ID，例如：开启第 12 条规则。"
            : "请提供规则 ID，例如：关闭 #12 号规则。",
        };
      }

      const endpoint = extractManageTargetEndpoint(sourceText);
      const targetIp = normalizeManageTargetIp(intent.targetIp || endpoint.targetIp || "");
      const targetPort = parseManagePort(intent.targetPort ?? endpoint.targetPort);
      const sourcePortRaw = intent.sourcePort === 0 || String(intent.sourcePort || "").trim() === "0"
        ? 0
        : parseManagePort(intent.sourcePort);
      const sourcePort = sourcePortRaw === 0 ? undefined : sourcePortRaw;
      const forwardMode = normalizeManageForwardMode(intent.forwardMode || extractManageForwardMode(sourceText));
      const tunnelKeyword = normalizeManageTunnelKeyword(intent.tunnel || extractManageTunnelKeyword(sourceText));
      const hostKeyword = normalizeManageHostKeyword(intent.host || extractManageHostKeyword(sourceText));

      let tunnel: any = null;
      if (tunnelKeyword) {
        const resolvedTunnel = await resolveManageTunnel(actor, tunnelKeyword);
        if (!resolvedTunnel.tunnel) return { error: resolvedTunnel.error || "隧道不存在或无权操作。" };
        tunnel = resolvedTunnel.tunnel;
      }
      let host: any = null;
      if (hostKeyword) {
        const resolvedHost = await resolveManageHost(actor, hostKeyword);
        if (!resolvedHost.host) return { error: resolvedHost.error || "主机不存在或无权操作。" };
        host = resolvedHost.host;
      }

      const hasFilter = !!targetIp
        || Number.isFinite(targetPort as number)
        || Number.isFinite(sourcePort as number)
        || !!forwardMode
        || !!tunnel
        || !!host;
      if (!hasFilter) {
        return { error: "请提供要删除的规则信息，例如：删除第12条规则，或删除转发到 10.10.0.1:5151 的规则。" };
      }

      let matchedRules = [...(rules as any[])];
      if (forwardMode === "host") matchedRules = matchedRules.filter((item: any) => Number(item.tunnelId || 0) <= 0);
      if (forwardMode === "tunnel") matchedRules = matchedRules.filter((item: any) => Number(item.tunnelId || 0) > 0);
      if (tunnel) matchedRules = matchedRules.filter((item: any) => Number(item.tunnelId || 0) === Number((tunnel as any).id || 0));
      if (host) matchedRules = matchedRules.filter((item: any) => Number(item.hostId || 0) === Number((host as any).id || 0));
      if (targetIp) {
        const needle = targetIp.toLowerCase();
        matchedRules = matchedRules.filter((item: any) => String(item.targetIp || "").trim().toLowerCase() === needle);
      }
      if (Number.isFinite(targetPort as number)) {
        matchedRules = matchedRules.filter((item: any) => Number(item.targetPort || 0) === Number(targetPort));
      }
      if (Number.isFinite(sourcePort as number)) {
        matchedRules = matchedRules.filter((item: any) => Number(item.sourcePort || 0) === Number(sourcePort));
      }
      matchedRules = matchedRules.sort((a: any, b: any) => Number(a.id) - Number(b.id));
      if (matchedRules.length === 0) {
        return { error: "没有找到可删除的匹配规则，请补充规则 ID、隧道/主机、目标地址端口等信息。" };
      }
      if (matchedRules.length > 1) {
        const nextIntent: ManageActionIntent = {
          ...intent,
          action,
          ...(targetIp ? { targetIp } : {}),
          ...(Number.isFinite(targetPort as number) ? { targetPort } : {}),
          ...(Number.isFinite(sourcePort as number) ? { sourcePort } : {}),
          ...(forwardMode ? { forwardMode } : {}),
          ...(tunnel ? { tunnel: String((tunnel as any).id || "") } : {}),
          ...(host ? { host: String((host as any).id || "") } : {}),
        };
        return {
          clarify: {
            actor,
            intent: nextIntent,
            missingFields: ["ruleId"],
            text: `匹配到 ${matchedRules.length} 条规则，请选择要删除的规则（${Math.round(MANAGE_CLARIFY_TTL_MS / 1000)} 秒内有效）。`,
            keyboard: manageClarifyRuleKeyboard(matchedRules),
          },
        };
      }
      const targetRule = matchedRules[0];
      const targetUserId = Number((targetRule as any).userId || 0);
      const targetUser = targetUserId > 0 ? await db.getUserById(targetUserId).catch(() => null) : null;
      const pending: Omit<PendingManageAction, "key" | "createdAt" | "expiresAt"> = {
        actorUserId: Number(actor.id),
        actorRole: isAdmin ? "admin" : "user",
        action,
        ...(targetUserId > 0 ? { targetUserId } : {}),
        ruleId: Number((targetRule as any).id),
        rulePreview: [formatManageRulePreview(targetRule)],
        ...(Number((targetRule as any).hostId || 0) > 0 ? { hostId: Number((targetRule as any).hostId) } : {}),
        ...(Number((targetRule as any).tunnelId || 0) > 0 ? { tunnelId: Number((targetRule as any).tunnelId) } : {}),
        sourceText: sourceText.slice(0, 500),
      };
      return { prepared: { pending, target: targetUser || undefined, actor } as PreparedManageAction };
    }

    if (action === "rule_create") {
      const endpoint = extractManageTargetEndpoint(sourceText);
      const targetIp = normalizeManageTargetIp(intent.targetIp || endpoint.targetIp || "");
      const targetPort = parseManagePort(intent.targetPort ?? endpoint.targetPort);
      if (!targetIp || !targetPort) {
        return { error: "请提供目标地址和端口，例如：增加一个转发到 10.10.0.1 的 5151 端口。" };
      }

      let sourcePort: number | undefined;
      if (intent.sourcePort === 0 || String(intent.sourcePort || "").trim() === "0") {
        sourcePort = 0;
      } else if (intent.sourcePort !== undefined && intent.sourcePort !== null && String(intent.sourcePort).trim() !== "") {
        const parsed = parseManagePort(intent.sourcePort);
        if (!parsed) return { error: "源端口无效，请输入 1-65535，或省略源端口使用随机端口。" };
        sourcePort = parsed;
      } else {
        const extracted = extractManageSourcePort(sourceText);
        if (extracted === 0) sourcePort = 0;
        else if (Number.isFinite(extracted as number)) sourcePort = extracted;
      }
      if (!Number.isFinite(sourcePort as number)) sourcePort = 0;

      const forwardMode = normalizeManageForwardMode(intent.forwardMode || extractManageForwardMode(sourceText));
      if (!forwardMode) {
        const nextIntent: ManageActionIntent = {
          ...intent,
          action,
          targetIp,
          targetPort,
          sourcePort,
        };
        return {
          clarify: {
            actor,
            intent: nextIntent,
            missingFields: ["forwardMode"],
            text: `请先选择要新增为哪种转发方式（${Math.round(MANAGE_CLARIFY_TTL_MS / 1000)} 秒内有效）。`,
            keyboard: manageClarifyModeKeyboard(),
          },
        };
      }

      let host: any = null;
      let tunnel: any = null;
      if (forwardMode === "tunnel") {
        const tunnelKeyword = normalizeManageTunnelKeyword(intent.tunnel || extractManageTunnelKeyword(sourceText));
        if (tunnelKeyword) {
          const resolvedTunnel = await resolveManageTunnel(actor, tunnelKeyword);
          if (!resolvedTunnel.tunnel) return { error: resolvedTunnel.error || "隧道不存在或无权操作。" };
          tunnel = resolvedTunnel.tunnel;
        } else {
          const tunnels = await visibleTunnelsForTelegramUser(actor);
          if ((tunnels as any[]).length === 0) return { error: "当前没有可用隧道，无法新增隧道转发规则。" };
          if ((tunnels as any[]).length === 1) {
            tunnel = (tunnels as any[])[0];
          } else {
            const nextIntent: ManageActionIntent = {
              ...intent,
              action,
              forwardMode: "tunnel",
              targetIp,
              targetPort,
              sourcePort,
            };
            return {
              clarify: {
                actor,
                intent: nextIntent,
                missingFields: ["tunnel"],
                text: `请选择要添加到哪个隧道（${Math.round(MANAGE_CLARIFY_TTL_MS / 1000)} 秒内有效）。`,
                keyboard: manageClarifyTunnelKeyboard(tunnels as any[]),
              },
            };
          }
        }
        const hostIdFromTunnel = Number((tunnel as any)?.entryHostId || 0);
        if (!hostIdFromTunnel) return { error: "所选隧道入口主机无效，无法创建规则。" };
        host = await db.getHostById(hostIdFromTunnel).catch(() => null);
      } else {
        const hostKeyword = normalizeManageHostKeyword(intent.host || extractManageHostKeyword(sourceText));
        if (hostKeyword) {
          const resolvedHost = await resolveManageHost(actor, hostKeyword);
          if (!resolvedHost.host) return { error: resolvedHost.error || "主机不存在或无权操作。" };
          host = resolvedHost.host;
        } else {
          const hosts = await visibleHostsForTelegramUser(actor);
          if ((hosts as any[]).length === 0) return { error: "当前没有可用主机，无法新增端口转发规则。" };
          if ((hosts as any[]).length === 1) {
            host = (hosts as any[])[0];
          } else {
            const nextIntent: ManageActionIntent = {
              ...intent,
              action,
              forwardMode: "host",
              targetIp,
              targetPort,
              sourcePort,
            };
            return {
              clarify: {
                actor,
                intent: nextIntent,
                missingFields: ["host"],
                text: `请选择要添加到哪个主机（${Math.round(MANAGE_CLARIFY_TTL_MS / 1000)} 秒内有效）。`,
                keyboard: manageClarifyHostKeyboard(hosts as any[]),
              },
            };
          }
        }
      }
      if (!host) return { error: "没有可用的入口主机，无法新增规则。" };
      const hostId = Number((host as any).id || 0);
      const tunnelId = forwardMode === "tunnel" ? Number((tunnel as any)?.id || 0) : 0;
      if (!hostId) return { error: "入口主机无效，无法新增规则。" };
      const pending: Omit<PendingManageAction, "key" | "createdAt" | "expiresAt"> = {
        actorUserId: Number(actor.id),
        actorRole: isAdmin ? "admin" : "user",
        action,
        forwardMode,
        hostId,
        hostName: String((host as any).name || (host as any).ip || `主机 #${hostId}`).slice(0, 80),
        ...(tunnelId > 0 ? { tunnelId, tunnelName: String((tunnel as any).name || `隧道 #${tunnelId}`).slice(0, 80) } : {}),
        sourcePort,
        targetIp,
        targetPort,
        sourceText: sourceText.slice(0, 500),
      };
      return { prepared: { pending, actor } as PreparedManageAction };
    }

    const tunnelKeyword = normalizeManageTunnelKeyword(intent.tunnel || extractManageTunnelKeyword(sourceText));
    const resolvedTunnel = await resolveManageTunnel(actor, tunnelKeyword);
    if (!resolvedTunnel.tunnel) return { error: resolvedTunnel.error || "隧道不存在或无权操作。" };
    const tunnel = resolvedTunnel.tunnel as any;
    const tunnelId = Number(tunnel.id || 0);
    if (!tunnelId) return { error: "隧道 ID 无效，无法执行批量规则操作。" };
    const tunnelRules = (rules as any[])
      .filter((item: any) => Number(item.tunnelId || 0) === tunnelId)
      .sort((a: any, b: any) => Number(a.id) - Number(b.id));
    if (tunnelRules.length === 0) {
      return { error: `隧道 #${tunnelId} ${escapeHtml(tunnel.name || "-")} 下没有可操作的规则。` };
    }
    const pending: Omit<PendingManageAction, "key" | "createdAt" | "expiresAt"> = {
      actorUserId: Number(actor.id),
      actorRole: isAdmin ? "admin" : "user",
      action,
      tunnelId,
      tunnelName: String(tunnel.name || `隧道 #${tunnelId}`).slice(0, 80),
      ruleIds: tunnelRules.map((item: any) => Number(item.id)).filter((id: number) => Number.isFinite(id) && id > 0),
      rulePreview: tunnelRules.map((item: any) => formatManageRulePreview(item)),
      sourceText: sourceText.slice(0, 500),
    };
    return { prepared: { pending, actor } as PreparedManageAction };
  }

  const targetKeyword = normalizeManageTargetKeyword(intent.target || extractManageTargetKeyword(sourceText));
  if (isAdmin && !targetKeyword) {
    return {
      clarify: {
        actor,
        intent: { ...intent, action },
        missingFields: ["target"],
        text: `请补充要操作的目标用户（用户ID/用户名/邮箱），${Math.round(MANAGE_CLARIFY_TTL_MS / 1000)} 秒内有效。`,
        keyboard: manageClarifyCancelKeyboard(),
      },
    };
  }
  const resolved = await resolveManageTargetUser(actor, targetKeyword);
  if (!resolved.target) {
    return { error: `${resolved.error || "目标用户不存在。"}\n${manageActionPermissionHint(isAdmin)}` };
  }
  const target = resolved.target as any;
  if (!isAdmin && Number(target.id) !== Number(actor.id)) {
    return { error: "普通用户只允许操作自己的账号。" };
  }
  if (action === "forward_disable" && String(target.role) === "admin") {
    return { error: "管理员账号不能在机器人中关闭转发权限。" };
  }
  if (action === "forward_enable" && String(target.role) === "admin") {
    return { error: "管理员账号默认拥有转发权限，无需启用。" };
  }
  if (action === "account_disable" && Number(target.id) === Number(actor.id)) {
    return { error: "不能停用当前登录账号。" };
  }
  if (action === "account_disable" && String(target.role) === "admin") {
    return { error: "管理员账号不能通过机器人停用。" };
  }

  let amountCents: number | undefined;
  if (action === "balance_set" || action === "balance_adjust") {
    const amountYuan = Number(intent.amountYuan);
    if (!Number.isFinite(amountYuan)) {
      return {
        clarify: {
          actor,
          intent: { ...intent, action, target: targetKeyword || intent.target },
          missingFields: ["amountYuan"],
          text: action === "balance_set"
            ? `请补充要设置的余额金额（单位：元），${Math.round(MANAGE_CLARIFY_TTL_MS / 1000)} 秒内有效。`
            : `请补充要调整的金额（单位：元，可正可负），${Math.round(MANAGE_CLARIFY_TTL_MS / 1000)} 秒内有效。`,
          keyboard: manageClarifyCancelKeyboard(),
        },
      };
    }
    amountCents = Math.round(amountYuan * 100);
    if (action === "balance_set" && amountCents < 0) return { error: "余额不能小于 0。" };
    if (action === "balance_adjust" && amountCents === 0) return { error: "调整金额不能为 0。" };
    if (Math.abs(amountCents) > MANAGE_BALANCE_MAX_CENTS) {
      return { error: "金额超出允许范围，请控制在 1,000,000 元以内。" };
    }
    if (action === "balance_adjust" && Number(target.balanceCents || 0) + amountCents < 0) {
      return { error: "扣减后余额不能小于 0。" };
    }
  }

  let durationValue: number | undefined;
  let durationUnit: ManageDurationUnit | undefined;
  if (action === "renew") {
    durationValue = Math.max(1, Math.floor(Number(intent.durationValue || 1)));
    const rawUnit = String(intent.durationUnit || "month");
    durationUnit = rawUnit === "day" || rawUnit === "year" || rawUnit === "month"
      ? (rawUnit as ManageDurationUnit)
      : "month";
  }

  const pending: Omit<PendingManageAction, "key" | "createdAt" | "expiresAt"> = {
    actorUserId: Number(actor.id),
    actorRole: isAdmin ? "admin" : "user",
    action,
    targetUserId: Number(target.id),
    ...(Number.isFinite(amountCents as number) ? { amountCents } : {}),
    ...(durationValue ? { durationValue } : {}),
    ...(durationUnit ? { durationUnit } : {}),
    sourceText: sourceText.slice(0, 500),
  };
  return { prepared: { pending, target, actor } as PreparedManageAction };
}

function manageActionConfirmText(pending: PendingManageAction, actor: any, target?: any) {
  const action = pending.action as Exclude<ManageActionKind, "none">;
  const lines: string[] = [
    "<b>操作确认</b>",
    "",
    `发起人：${formatUserLabel(actor)}（${manageRoleLabel(actor?.role)}）`,
    ...(target ? [`目标用户：${formatUserLabel(target)}`] : []),
    `操作类型：<b>${escapeHtml(manageActionLabel(action))}</b>`,
  ];
  if (action === "balance_set") {
    lines.push(`当前余额：${formatMoneyCny(target?.balanceCents)}`);
    lines.push(`设置为：<b>${formatMoneyCny(pending.amountCents)}</b>`);
  } else if (action === "balance_adjust") {
    const delta = Number(pending.amountCents || 0);
    lines.push(`当前余额：${formatMoneyCny(target?.balanceCents)}`);
    lines.push(`变更金额：<b>${delta >= 0 ? "+" : ""}${formatMoneyCny(delta)}</b>`);
    lines.push(`预计余额：<b>${formatMoneyCny(Number(target?.balanceCents || 0) + delta)}</b>`);
  } else if (action === "renew") {
    const durationValue = Math.max(1, Math.floor(Number(pending.durationValue || 1)));
    const durationUnit = pending.durationUnit || "month";
    const { nextExpiresAt } = getRenewalDatesByDuration(target, durationValue, durationUnit);
    lines.push(`续费时长：<b>${escapeHtml(formatManageDuration(durationValue, durationUnit))}</b>`);
    lines.push(`当前到期：${escapeHtml(formatDateTime(target?.expiresAt))}`);
    lines.push(`续费后到期：<b>${escapeHtml(formatDateTime(nextExpiresAt))}</b>`);
  } else if (action === "account_disable") {
    lines.push("将停用该用户账号，用户将无法登录和使用机器人。");
  } else if (action === "account_enable") {
    lines.push("将启用该用户账号。");
  } else if (action === "forward_disable") {
    lines.push("将关闭该用户转发权限，并暂停其转发规则。");
  } else if (action === "forward_enable") {
    lines.push("将启用该用户转发权限。");
  } else if (action === "rule_disable" || action === "rule_enable") {
    const ruleText = pending.rulePreview?.[0] || (pending.ruleId ? `#${pending.ruleId}` : "未指定");
    lines.push(`目标规则：${aiCode(ruleText)}`);
    lines.push(action === "rule_disable" ? "将停用该规则。" : "将启用该规则。");
  } else if (action === "rule_create") {
    const hostLabel = pending.hostId
      ? `#${pending.hostId} ${pending.hostName || ""}`.trim()
      : (pending.hostName || "-");
    const tunnelLabel = pending.tunnelId
      ? `#${pending.tunnelId} ${pending.tunnelName || ""}`.trim()
      : "";
    lines.push(`转发方式：<b>${escapeHtml(manageForwardModeLabel(pending.forwardMode))}</b>`);
    lines.push(`入口主机：${aiCode(hostLabel)}`);
    if (tunnelLabel) lines.push(`所属隧道：${aiCode(tunnelLabel)}`);
    lines.push(`入口端口：${pending.sourcePort === 0 ? "<b>随机分配</b>" : aiCode(`:${pending.sourcePort ?? "-"}`)}`);
    lines.push(`目标地址：${aiCode(`${pending.targetIp || "-"}:${pending.targetPort ?? "-"}`)}`);
    lines.push("确认后将创建新规则并下发到对应节点。");
  } else if (action === "rule_delete") {
    const ruleText = pending.rulePreview?.[0] || (pending.ruleId ? `#${pending.ruleId}` : "未指定");
    lines.push(`目标规则：${aiCode(ruleText)}`);
    lines.push("确认后将删除该规则，并同步刷新对应节点。");
  } else if (action === "tunnel_rules_disable" || action === "tunnel_rules_enable") {
    const tunnelLabel = pending.tunnelId
      ? `#${pending.tunnelId} ${pending.tunnelName || ""}`.trim()
      : (pending.tunnelName || "-");
    const previews = pending.rulePreview || [];
    lines.push(`目标隧道：${aiCode(tunnelLabel)}`);
    lines.push(`包含规则：<b>${previews.length}</b> 条`);
    if (previews.length > 0) {
      lines.push("规则清单：");
      const limit = 20;
      for (const item of previews.slice(0, limit)) {
        lines.push(`- ${aiCode(item)}`);
      }
      if (previews.length > limit) {
        lines.push(`- 其余 ${previews.length - limit} 条将一并执行`);
      }
    }
    lines.push(action === "tunnel_rules_disable" ? "确认后将批量停用以上规则。" : "确认后将批量启用以上规则。");
  } else if (action === "traffic_reset") {
    lines.push("将清零该用户当前统计流量。");
  } else if (action === "redeem_code_generate_balance") {
    const count = Math.max(1, Math.floor(Number(pending.codeCount || 1)));
    const amountCents = Math.round(Number(pending.amountCents || 0));
    lines.push(`生成数量：<b>${count}</b>`);
    lines.push(`面额：<b>${formatMoneyCny(amountCents)}</b>/个`);
    lines.push(`总面额：<b>${formatMoneyCny(amountCents * count)}</b>`);
    lines.push("确认后将立即生成余额兑换码。");
  } else if (action === "discount_code_generate_percent") {
    const count = Math.max(1, Math.floor(Number(pending.codeCount || 1)));
    const discountPercent = normalizeManageDiscountPercent(pending.discountPercent);
    lines.push(`生成数量：<b>${count}</b>`);
    lines.push(`折扣力度：<b>${escapeHtml(discountPercent ? formatDiscountPercentLabel(discountPercent) : "-")}</b>`);
    lines.push("确认后将立即生成折扣码（默认不限次数，可在后台调整限制）。");
  }
  lines.push("", `原始指令：${aiCode(shortText(pending.sourceText, 120))}`);
  lines.push(`请在 ${Math.round(MANAGE_ACTION_CONFIRM_TTL_MS / 60000)} 分钟内点击「确认执行」。`);
  return lines.join("\n");
}

async function executePendingManageAction(pending: PendingManageAction, callbackUser: any) {
  const actor = (await db.getUserById(Number(callbackUser?.id || 0)).catch(() => null)) || callbackUser;
  if (Number(actor?.id || 0) !== Number(pending.actorUserId || 0)) {
    throw new Error("只有原发起人可以确认该操作。");
  }
  const deepseekSettings = await getDeepSeekSettings().catch(() => null);
  if (String(actor?.role) !== "admin" && deepseekSettings?.telegramUserManageEnabled === false) {
    throw new Error("当前仅管理员可使用 AI 对话管理功能。");
  }
  if (!isManageActionAllowedForRole(actor?.role, pending.action)) {
    throw new Error("当前账户已无该操作权限。");
  }
  const sourceText = shortText(pending.sourceText || "", 180);

  if (isRuleManageAction(pending.action)) {
    if (pending.action === "rule_enable" || pending.action === "rule_disable") {
      const enabled = pending.action === "rule_enable";
      const ruleId = Number(pending.ruleId || 0);
      if (!Number.isFinite(ruleId) || ruleId <= 0) throw new Error("规则 ID 无效。");
      const rule = await toggleRuleForUser(actor, ruleId, enabled);
      const targetUser = Number((rule as any)?.userId || 0) > 0
        ? await db.getUserById(Number((rule as any).userId)).catch(() => null)
        : null;
      return [
        "<b>执行成功</b>",
        targetUser ? `用户：${formatUserLabel(targetUser)}` : "",
        `规则：${aiCode(formatManageRulePreview(rule))}`,
        `操作：${enabled ? "启用规则" : "关闭规则"}`,
      ].filter(Boolean).join("\n");
    }

    if (pending.action === "rule_create") {
      const mode: ManageForwardMode = pending.forwardMode === "tunnel" ? "tunnel" : "host";
      const hostId = Number(pending.hostId || 0);
      const tunnelId = mode === "tunnel" ? Number(pending.tunnelId || 0) : 0;
      const targetIp = normalizeManageTargetIp(pending.targetIp || "");
      const targetPort = parseManagePort(pending.targetPort);
      let sourcePort = Number(pending.sourcePort ?? 0);
      if (!Number.isFinite(hostId) || hostId <= 0) throw new Error("入口主机无效。");
      if (!targetIp || !isValidManageRuleTargetHost(targetIp)) throw new Error("目标地址格式无效，请输入 IP 或域名。");
      if (!targetPort) throw new Error("目标端口无效，请输入 1-65535。");
      if (!(sourcePort === 0 || parseManagePort(sourcePort))) {
        throw new Error("源端口无效，请输入 1-65535，或省略源端口使用随机端口。");
      }

      let host = await db.getHostById(hostId).catch(() => null);
      if (!host) throw new Error("入口主机不存在。");

      let tunnel: any = null;
      let isTrafficBillingRule = false;
      if (tunnelId > 0) {
        const access = await requireTunnelUseOrTrafficBillingAccess(
          { user: { id: Number(actor.id), role: String(actor.role || "user") } },
          tunnelId,
        );
        tunnel = access.tunnel;
        isTrafficBillingRule = !!access.isTrafficBillingResource;
        if (!(tunnel as any)?.isEnabled) throw new Error("所选隧道已停用。");
        if (Number((tunnel as any)?.entryHostId || 0) !== hostId) {
          throw new Error("所选隧道入口主机与规则入口主机不一致。");
        }
      } else {
        const access = await requireHostUseAccess(
          { user: { id: Number(actor.id), role: String(actor.role || "user") } },
          hostId,
        );
        host = access.host;
        isTrafficBillingRule = !!access.isTrafficBillingResource;
      }

      if (String(actor?.role) !== "admin") {
        const check = await db.ensureUserForwardAccessReady(Number(actor.id), { allowTrafficBillingRecovery: isTrafficBillingRule });
        if (!check.allowed) throw new Error(check.message || "转发权限已暂停，请续费后再添加规则。");
        const owner = check.user || await db.getUserById(Number(actor.id));
        if (owner?.expiresAt && new Date(owner.expiresAt) <= new Date()) {
          throw new Error("账户已到期，无法添加规则。");
        }
        if (Number((owner as any)?.maxRules || 0) > 0) {
          const ruleCount = await db.getUserRuleCount(Number(actor.id));
          if (ruleCount >= Number((owner as any).maxRules)) {
            throw new Error(`你已达到最大规则数量限制（${Number((owner as any).maxRules)} 条）。`);
          }
        }
        if (Number((owner as any)?.maxPorts || 0) > 0) {
          const portCount = await db.getUserPortCount(Number(actor.id));
          if (portCount >= Number((owner as any).maxPorts)) {
            throw new Error(`你已达到最大端口数量限制（${Number((owner as any).maxPorts)} 个）。`);
          }
        }
        if (isTrafficBillingRule && Number((owner as any)?.balanceCents || 0) <= 0) {
          throw new Error("流量计费余额不足，请充值后再使用该计费资源。");
        }
        if (!isTrafficBillingRule && Number((owner as any)?.trafficLimit || 0) > 0) {
          if (Number((owner as any)?.trafficUsed || 0) >= Number((owner as any)?.trafficLimit || 0)) {
            throw new Error("流量已用完，无法添加规则。");
          }
        }
      }

      const forwardType = pickManageRuleForwardType(actor, mode);
      await requireRuleProtocolEnabled({ forwardType, tunnelId: tunnelId || null }, tunnel || undefined);

      const entryPolicy = tunnelId > 0
        ? combinePortPolicies(
            portPolicyFrom(host as any),
            portPolicyFrom({
              portRangeStart: (tunnel as any)?.portRangeStart,
              portRangeEnd: (tunnel as any)?.portRangeEnd,
            }),
          )
        : portPolicyFrom(host as any);
      const planRange = String(actor?.role) !== "admin"
        ? await db.getUserPlanPortRange(Number(actor.id), hostId, tunnelId || undefined)
        : null;
      const effectivePolicy = planRange
        ? combinePortPolicies(
            entryPolicy,
            portPolicyFrom({
              portRangeStart: planRange.start,
              portRangeEnd: planRange.end,
            }),
          )
        : entryPolicy;

      if (sourcePort === 0) {
        let randomRangeStart = tunnelId > 0 ? Number((tunnel as any)?.portRangeStart || 0) || null : null;
        let randomRangeEnd = tunnelId > 0 ? Number((tunnel as any)?.portRangeEnd || 0) || null : null;
        if (planRange) {
          randomRangeStart = Math.max(Number(randomRangeStart || planRange.start), planRange.start);
          randomRangeEnd = Math.min(Number(randomRangeEnd || planRange.end), planRange.end);
        }
        const randomPort = await db.findAvailablePort(hostId, randomRangeStart, randomRangeEnd);
        if (!randomPort) throw new Error("该主机端口范围内暂无可用入口端口。");
        sourcePort = Number(randomPort);
      } else {
        if (!isPortAllowedByPolicy(sourcePort, effectivePolicy)) {
          throw new Error(portPolicyErrorMessage(effectivePolicy, "入口端口"));
        }
        const used = await db.isPortUsedOnHost(hostId, sourcePort);
        if (used) throw new Error(`端口 ${sourcePort} 已被占用，请更换端口后再试。`);
      }

      let tunnelExitPort: number | null = null;
      if (tunnelId > 0) {
        const exitHost = await db.getHostById(Number((tunnel as any)?.exitHostId || 0));
        tunnelExitPort = await db.findAvailableTunnelExitPort(
          Number((tunnel as any)?.exitHostId || 0),
          (exitHost as any)?.portRangeStart,
          (exitHost as any)?.portRangeEnd,
        );
        if (!tunnelExitPort) throw new Error("隧道出口主机没有可用出口端口。");
      }

      const ruleName = `TG-${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "")}-${sourcePort}`;
      const id = await db.createForwardRule({
        hostId,
        name: shortText(ruleName, 64),
        forwardType,
        protocol: "both",
        gostMode: "direct",
        gostRelayHost: null,
        gostRelayPort: null,
        tunnelId: tunnelId || null,
        tunnelExitPort: tunnelExitPort ?? null,
        forwardGroupId: null,
        forwardGroupRuleId: null,
        forwardGroupMemberId: null,
        isForwardGroupTemplate: false,
        sourcePort,
        targetIp,
        targetPort,
        blockHttp: false,
        blockSocks: false,
        blockTls: false,
        proxyProtocolReceive: false,
        proxyProtocolSend: false,
        proxyProtocolExitReceive: false,
        proxyProtocolExitSend: false,
        tcpFastOpen: false,
        zeroCopy: false,
        failoverEnabled: false,
        failoverStrategy: "fallback",
        failoverTargets: null,
        failoverSeconds: 60,
        recoverSeconds: 120,
        autoFailback: true,
        isEnabled: true,
        isRunning: false,
        userId: Number(actor.id),
      } as any);

      if (tunnelId > 0) {
        const tunnelForSync = tunnel || await db.getTunnelById(tunnelId);
        if (tunnelForSync) {
          await db.reconcileForwardRuleTunnelExits(
            { id, hostId, tunnelId, sourcePort, targetIp, targetPort, tunnelExitPort },
            tunnelForSync,
          );
          await db.updateTunnel(tunnelId, { isRunning: false } as any);
          await pushTunnelEndpointRefresh(tunnelForSync, "telegram-rule-created");
        } else {
          pushAgentRefresh(hostId, "telegram-rule-created");
        }
      } else {
        pushAgentRefresh(hostId, "telegram-rule-created");
      }

      const createdRule = await db.getForwardRuleById(Number(id)).catch(() => null);
      return [
        "<b>执行成功</b>",
        `操作：新增转发规则`,
        `规则：${aiCode(createdRule ? formatManageRulePreview(createdRule) : `#${id} :${sourcePort} -> ${targetIp}:${targetPort}`)}`,
        `转发方式：${escapeHtml(manageForwardModeLabel(mode))}`,
        `入口端口：${aiCode(`:${sourcePort}`)}`,
        tunnelId > 0 ? `隧道：${aiCode(`#${tunnelId} ${(tunnel as any)?.name || ""}`.trim())}` : "",
      ].filter(Boolean).join("\n");
    }

    if (pending.action === "rule_delete") {
      const ruleId = Number(pending.ruleId || 0);
      if (!Number.isFinite(ruleId) || ruleId <= 0) throw new Error("规则 ID 无效。");
      const rule = await db.getForwardRuleById(ruleId);
      if (!rule || (rule as any)?.pendingDelete) throw new Error("规则不存在或已删除。");
      if (String(actor?.role) !== "admin" && Number((rule as any).userId) !== Number(actor.id)) {
        throw new Error("规则不存在或无权操作。");
      }
      if ((rule as any).forwardGroupRuleId) {
        throw new Error("转发组成员规则由系统维护，不支持在机器人中直接删除。");
      }

      let chargedCents = 0;
      let balanceAfterCents: number | null = null;
      const collectBilling = (billed: any) => {
        if (!billed) return;
        chargedCents += Math.max(0, Number((billed as any).amountCents || 0));
        if (Number.isFinite(Number((billed as any).balanceAfterCents))) {
          balanceAfterCents = Number((billed as any).balanceAfterCents);
        }
      };

      if ((rule as any).isForwardGroupTemplate) {
        const childRules = await db.getForwardGroupChildRulesForTemplate(ruleId);
        for (const child of childRules as any[]) {
          collectBilling(await settleTrafficBillingForDeletedRuleByTelegram(child));
          const childTunnelId = Number((child as any).tunnelId || 0);
          if (childTunnelId > 0) {
            const tunnel = await db.getTunnelById(childTunnelId);
            await db.updateTunnel(childTunnelId, { isRunning: false } as any);
            if (tunnel) await pushTunnelEndpointRefresh(tunnel, "telegram-forward-group-rule-deleted");
          }
          await db.markForwardRulePendingDelete(Number((child as any).id || 0));
          pushAgentRefresh(Number((child as any).hostId || 0), "telegram-forward-group-rule-deleted");
        }
        collectBilling(await settleTrafficBillingForDeletedRuleByTelegram(rule));
        await db.markForwardRulePendingDelete(ruleId);
        const groupId = Number((rule as any).forwardGroupId || 0);
        if (groupId > 0) await db.runForwardGroupFailover(groupId);
        return [
          "<b>执行成功</b>",
          `操作：删除转发规则`,
          `规则：${aiCode(formatManageRulePreview(rule))}`,
          `已联动删除子规则：<b>${(childRules as any[]).length}</b> 条`,
          chargedCents > 0 ? `删除结算扣费：<b>${formatMoneyCny(chargedCents)}</b>` : "",
          balanceAfterCents !== null ? `当前余额：<b>${formatMoneyCny(balanceAfterCents)}</b>` : "",
        ].filter(Boolean).join("\n");
      }

      collectBilling(await settleTrafficBillingForDeletedRuleByTelegram(rule));
      const tunnelId = Number((rule as any).tunnelId || 0);
      if (tunnelId > 0) {
        const tunnel = await db.getTunnelById(tunnelId);
        await db.updateTunnel(tunnelId, { isRunning: false } as any);
        if (tunnel) await pushTunnelEndpointRefresh(tunnel, "telegram-rule-deleted");
      }
      await db.markForwardRulePendingDelete(ruleId);
      pushAgentRefresh(Number((rule as any).hostId || 0), "telegram-rule-deleted");

      const targetUser = Number((rule as any).userId || 0) > 0
        ? await db.getUserById(Number((rule as any).userId)).catch(() => null)
        : null;
      return [
        "<b>执行成功</b>",
        `操作：删除转发规则`,
        targetUser ? `用户：${formatUserLabel(targetUser)}` : "",
        `规则：${aiCode(formatManageRulePreview(rule))}`,
        chargedCents > 0 ? `删除结算扣费：<b>${formatMoneyCny(chargedCents)}</b>` : "",
        balanceAfterCents !== null ? `当前余额：<b>${formatMoneyCny(balanceAfterCents)}</b>` : "",
      ].filter(Boolean).join("\n");
    }

    const enabled = pending.action === "tunnel_rules_enable";
    const ruleIds = Array.from(new Set((pending.ruleIds || [])
      .map((id) => Number(id))
      .filter((id) => Number.isFinite(id) && id > 0)));
    if (ruleIds.length === 0) throw new Error("未找到可操作的规则。");

    const successRules: any[] = [];
    const failedRules: Array<{ id: number; reason: string }> = [];
    for (const ruleId of ruleIds) {
      try {
        const rule = await toggleRuleForUser(actor, ruleId, enabled);
        successRules.push(rule);
      } catch (error: any) {
        failedRules.push({ id: ruleId, reason: String(error?.message || "执行失败") });
      }
    }
    if (successRules.length === 0) {
      throw new Error(`批量操作失败：${failedRules[0]?.reason || "没有可操作规则"}`);
    }
    const lines = [
      "<b>批量执行完成</b>",
      `隧道：${aiCode(pending.tunnelId ? `#${pending.tunnelId} ${pending.tunnelName || ""}`.trim() : (pending.tunnelName || "-"))}`,
      `操作：${enabled ? "启用隧道规则" : "关闭隧道规则"}`,
      `成功：<b>${successRules.length}</b> / ${ruleIds.length}`,
      failedRules.length > 0 ? `失败：<b>${failedRules.length}</b>` : "",
    ].filter(Boolean);
    if (successRules.length > 0) {
      lines.push("成功规则：");
      for (const rule of successRules.slice(0, 15)) {
        lines.push(`- ${aiCode(formatManageRulePreview(rule))}`);
      }
      if (successRules.length > 15) lines.push(`- 其余 ${successRules.length - 15} 条已执行`);
    }
    if (failedRules.length > 0) {
      lines.push("失败详情：");
      for (const item of failedRules.slice(0, 8)) {
        lines.push(`- #${item.id} ${escapeHtml(shortText(item.reason, 36))}`);
      }
      if (failedRules.length > 8) lines.push(`- 其余 ${failedRules.length - 8} 条请在面板查看`);
    }
    return lines.join("\n");
  }

  if (pending.action === "redeem_code_generate_balance") {
    if (String(actor?.role) !== "admin") throw new Error("只有管理员可以生成兑换码。");
    if (deepseekSettings?.redemptionEnabled === false) throw new Error("兑换码功能当前已关闭。");
    const codeCount = parseManageCodeCount(pending.codeCount) || 1;
    if (codeCount <= 0 || codeCount > MANAGE_CODE_MAX_COUNT) {
      throw new Error(`兑换码数量必须在 1-${MANAGE_CODE_MAX_COUNT} 之间。`);
    }
    const amountCents = Math.round(Number(pending.amountCents || 0));
    if (!Number.isFinite(amountCents) || amountCents <= 0) throw new Error("兑换码金额无效。");
    if (amountCents > MANAGE_BALANCE_MAX_CENTS) {
      throw new Error("兑换码金额超出允许范围，请控制在 1,000,000 元以内。");
    }
    const codes = await db.createRedemptionCodes({
      type: "balance",
      planId: null,
      durationDays: null,
      amountCents,
      startsAt: null,
      expiresAt: null,
      isActive: true,
      createdByUserId: Number(actor.id),
    } as any, codeCount);
    const createdCodes = (codes || []).map((item: any) => String(item || "").trim()).filter(Boolean);
    if (createdCodes.length === 0) throw new Error("兑换码生成失败，请稍后重试。");
    const preview = createdCodes.slice(0, MANAGE_CODE_DISPLAY_LIMIT);
    const lines: string[] = [
      "<b>执行成功</b>",
      "操作：生成余额兑换码",
      `数量：<b>${createdCodes.length}</b>`,
      `面额：<b>${formatMoneyCny(amountCents)}</b>/个`,
      `总面额：<b>${formatMoneyCny(amountCents * createdCodes.length)}</b>`,
      "兑换码：",
      ...preview.map((code) => `- ${aiCode(code)}`),
    ];
    if (createdCodes.length > preview.length) {
      lines.push(`- 其余 ${createdCodes.length - preview.length} 个请到后台账单页面查看`);
    }
    return lines.join("\n");
  }

  if (pending.action === "discount_code_generate_percent") {
    if (String(actor?.role) !== "admin") throw new Error("只有管理员可以生成折扣码。");
    if (deepseekSettings?.discountEnabled === false) throw new Error("折扣码功能当前已关闭。");
    const codeCount = parseManageCodeCount(pending.codeCount) || 1;
    if (codeCount <= 0 || codeCount > MANAGE_CODE_MAX_COUNT) {
      throw new Error(`折扣码数量必须在 1-${MANAGE_CODE_MAX_COUNT} 之间。`);
    }
    const discountPercent = normalizeManageDiscountPercent(pending.discountPercent);
    if (!discountPercent) throw new Error("折扣力度无效，请输入 1-100% 或 1-10 折。");
    const createdCodes: string[] = [];
    for (let i = 0; i < codeCount; i++) {
      const code = await db.createDiscountCode({
        discountType: "percent",
        discountValue: discountPercent,
        maxUses: 0,
        startsAt: null,
        expiresAt: null,
        isActive: true,
        createdByUserId: Number(actor.id),
      } as any, []);
      const codeText = String((code as any)?.code || "").trim();
      if (codeText) createdCodes.push(codeText);
    }
    if (createdCodes.length === 0) throw new Error("折扣码生成失败，请稍后重试。");
    const preview = createdCodes.slice(0, MANAGE_CODE_DISPLAY_LIMIT);
    const lines: string[] = [
      "<b>执行成功</b>",
      "操作：生成折扣码",
      `数量：<b>${createdCodes.length}</b>`,
      `折扣力度：<b>${escapeHtml(formatDiscountPercentLabel(discountPercent))}</b>`,
      "折扣码：",
      ...preview.map((code) => `- ${aiCode(code)}`),
    ];
    if (createdCodes.length > preview.length) {
      lines.push(`- 其余 ${createdCodes.length - preview.length} 个请到后台账单页面查看`);
    }
    return lines.join("\n");
  }

  const targetUserId = Number(pending.targetUserId || 0);
  if (!Number.isFinite(targetUserId) || targetUserId <= 0) {
    throw new Error("目标用户无效。");
  }
  const target = await db.getUserById(targetUserId);
  if (!target) throw new Error("目标用户不存在或已被删除。");
  if (String(actor?.role) !== "admin" && Number(target.id) !== Number(actor.id)) {
    throw new Error("普通用户仅可操作自己的账号。");
  }

  switch (pending.action) {
    case "balance_set": {
      const amountCents = Math.round(Number(pending.amountCents || 0));
      if (!Number.isFinite(amountCents) || amountCents < 0) throw new Error("余额金额无效。");
      const result = await db.setUserBalance(Number(target.id), amountCents, {
        type: "admin_adjust",
        description: `Telegram 余额设置：${sourceText}`,
        operatorUserId: Number(actor.id),
      } as any);
      const recovery = await db.recoverUserForwardAccessIfEligible(Number(target.id));
      if (recovery.restored) {
        await refreshUserForwardEndpoints(Number(target.id), "telegram-balance-set-forward-restored");
      } else if (recovery.reason === "traffic_billing_balance") {
        await refreshUserForwardEndpoints(Number(target.id), "telegram-balance-set-forward-paused");
      }
      return [
        "<b>执行成功</b>",
        `用户：${formatUserLabel(target)}`,
        "操作：设置余额",
        `当前余额：<b>${formatMoneyCny(result.balanceCents)}</b>`,
      ].join("\n");
    }
    case "balance_adjust": {
      const amountCents = Math.round(Number(pending.amountCents || 0));
      if (!Number.isFinite(amountCents) || amountCents === 0) throw new Error("调整金额无效。");
      const result = await db.addUserBalance(Number(target.id), amountCents, {
        type: amountCents > 0 ? "admin_recharge" : "admin_adjust",
        description: `Telegram 余额调整：${sourceText}`,
        operatorUserId: Number(actor.id),
      } as any);
      const recovery = await db.recoverUserForwardAccessIfEligible(Number(target.id));
      if (recovery.restored) {
        await refreshUserForwardEndpoints(Number(target.id), "telegram-balance-adjust-forward-restored");
      } else if (recovery.reason === "traffic_billing_balance") {
        await refreshUserForwardEndpoints(Number(target.id), "telegram-balance-adjust-forward-paused");
      }
      return [
        "<b>执行成功</b>",
        `用户：${formatUserLabel(target)}`,
        "操作：调整余额",
        `变更金额：<b>${amountCents >= 0 ? "+" : ""}${formatMoneyCny(amountCents)}</b>`,
        `当前余额：<b>${formatMoneyCny(result.balanceCents)}</b>`,
      ].join("\n");
    }
    case "renew": {
      const durationValue = Math.max(1, Math.floor(Number(pending.durationValue || 1)));
      const durationUnit: ManageDurationUnit = pending.durationUnit || "month";
      const { nextExpiresAt } = getRenewalDatesByDuration(target, durationValue, durationUnit);
      await db.updateUserTrafficSettings(Number(target.id), { expiresAt: nextExpiresAt });
      const recovery = await db.recoverUserForwardAccessIfEligible(Number(target.id));
      if (recovery.restored) {
        await refreshUserForwardEndpoints(Number(target.id), "telegram-user-renewed-forward-restored");
      }
      return [
        "<b>执行成功</b>",
        `用户：${formatUserLabel(target)}`,
        `操作：续费 ${escapeHtml(formatManageDuration(durationValue, durationUnit))}`,
        `新到期时间：<b>${escapeHtml(formatDateTime(nextExpiresAt))}</b>`,
      ].join("\n");
    }
    case "account_disable": {
      if (Number(target.id) === Number(actor.id)) throw new Error("不能停用当前登录账号。");
      if (String(target.role) === "admin") throw new Error("管理员账号不能通过机器人停用。");
      await db.setUserAccountEnabled(Number(target.id), false);
      await refreshUserForwardEndpoints(Number(target.id), "telegram-user-account-disabled");
      return [
        "<b>执行成功</b>",
        `用户：${formatUserLabel(target)}`,
        "操作：停用账号",
      ].join("\n");
    }
    case "account_enable": {
      await db.setUserAccountEnabled(Number(target.id), true);
      const recovery = await db.recoverUserForwardAccessIfEligible(Number(target.id));
      if (recovery.restored) {
        await refreshUserForwardEndpoints(Number(target.id), "telegram-user-account-enabled-forward-restored");
      }
      return [
        "<b>执行成功</b>",
        `用户：${formatUserLabel(target)}`,
        "操作：启用账号",
      ].join("\n");
    }
    case "forward_disable": {
      if (String(target.role) === "admin") throw new Error("管理员账号不能关闭转发权限。");
      await db.setUserForwardAccess(Number(target.id), false, "manual");
      await refreshUserForwardEndpoints(Number(target.id), "telegram-user-forward-disabled");
      return [
        "<b>执行成功</b>",
        `用户：${formatUserLabel(target)}`,
        "操作：关闭转发",
      ].join("\n");
    }
    case "forward_enable": {
      if (String(target.role) === "admin") throw new Error("管理员账号默认拥有转发权限。");
      await db.setUserForwardAccess(Number(target.id), true);
      await refreshUserForwardEndpoints(Number(target.id), "telegram-user-forward-enabled");
      return [
        "<b>执行成功</b>",
        `用户：${formatUserLabel(target)}`,
        "操作：启用转发",
      ].join("\n");
    }
    case "traffic_reset": {
      await db.resetUserTraffic(Number(target.id));
      const recovery = await db.recoverUserForwardAccessIfEligible(Number(target.id));
      if (recovery.restored) {
        await refreshUserForwardEndpoints(Number(target.id), "telegram-user-traffic-reset-forward-restored");
      }
      return [
        "<b>执行成功</b>",
        `用户：${formatUserLabel(target)}`,
        "操作：重置流量",
      ].join("\n");
    }
    default:
      throw new Error("暂不支持的管理操作。");
  }
}

async function tryHandleManageAction(message: TelegramMessage, user: any, rawText: string) {
  const query = rawText.replace(/^\/ask(?:@\w+)?\s*/i, "").trim();
  if (!query) return false;
  const deepseekSettings = await getDeepSeekSettings().catch(() => null);
  const userManageDisabled = String(user?.role) !== "admin" && deepseekSettings?.telegramUserManageEnabled === false;
  const activeClarify = getPendingManageClarifySession(message.chat.id, user.id);
  if (activeClarify) {
    if (/^(取消|放弃|算了|退出|cancel)$/i.test(query)) {
      clearPendingManageClarifySession(message.chat.id, user.id);
      const sent = await sendMessage(message.chat.id, "已取消本次操作。", backMenuKeyboard());
      await scheduleAiMessageAutoRecall(message.chat.id, message.message_id, sent);
      return true;
    }
    if (userManageDisabled) {
      const sent = await sendMessage(message.chat.id, "当前仅管理员可使用 AI 对话管理功能。");
      await scheduleAiMessageAutoRecall(message.chat.id, message.message_id, sent);
      return true;
    }
    const mergedIntent = mergeManageActionIntent(
      activeClarify.intent,
      extractManageIntentPatchFromText(query, activeClarify.missingFields || []),
    );
    const mergedSourceText = `${activeClarify.sourceText}\n补充：${query}`.slice(0, 500);
    const prepared = await prepareManageAction(user, mergedSourceText, mergedIntent);
    if (prepared.clarify) {
      createPendingManageClarifySession(
        message.chat.id,
        prepared.clarify.actor || user,
        mergedSourceText,
        prepared.clarify.intent,
        prepared.clarify.missingFields,
      );
      const sent = await sendMessage(
        message.chat.id,
        prepared.clarify.text,
        prepared.clarify.keyboard || manageClarifyCancelKeyboard(),
      );
      await scheduleAiMessageAutoRecall(message.chat.id, message.message_id, sent);
      return true;
    }
    if (!prepared.prepared) {
      const sent = await sendMessage(
        message.chat.id,
        `${prepared.error || "信息仍不完整，请继续补充。"}\n\n可继续补充信息，或发送“取消”结束本次操作。`,
        manageClarifyCancelKeyboard(),
      );
      await scheduleAiMessageAutoRecall(message.chat.id, message.message_id, sent);
      return true;
    }
    clearPendingManageClarifySession(message.chat.id, user.id);
    const pending = createPendingManageAction(prepared.prepared.pending);
    const sent = await sendMessage(
      message.chat.id,
      manageActionConfirmText(pending, prepared.prepared.actor, prepared.prepared.target),
      manageActionConfirmKeyboard(pending.key),
    );
    await scheduleAiMessageAutoRecall(message.chat.id, message.message_id, sent);
    return true;
  }

  const { intent, writeLike } = await parseManageActionIntent(query);
  if (!writeLike || intent.action === "none") return false;
  if (userManageDisabled) {
    const sent = await sendMessage(message.chat.id, "当前仅管理员可使用 AI 对话管理功能。");
    await scheduleAiMessageAutoRecall(message.chat.id, message.message_id, sent);
    return true;
  }
  const prepared = await prepareManageAction(user, query, intent);
  if (prepared.clarify) {
    createPendingManageClarifySession(
      message.chat.id,
      prepared.clarify.actor || user,
      query,
      prepared.clarify.intent,
      prepared.clarify.missingFields,
    );
    const sent = await sendMessage(
      message.chat.id,
      prepared.clarify.text,
      prepared.clarify.keyboard || manageClarifyCancelKeyboard(),
    );
    await scheduleAiMessageAutoRecall(message.chat.id, message.message_id, sent);
    return true;
  }
  if (!prepared.prepared) {
    const sent = await sendMessage(message.chat.id, prepared.error || "未识别到可执行的管理操作。");
    await scheduleAiMessageAutoRecall(message.chat.id, message.message_id, sent);
    return true;
  }
  const pending = createPendingManageAction(prepared.prepared.pending);
  const sent = await sendMessage(
    message.chat.id,
    manageActionConfirmText(pending, prepared.prepared.actor, prepared.prepared.target),
    manageActionConfirmKeyboard(pending.key),
  );
  await scheduleAiMessageAutoRecall(message.chat.id, message.message_id, sent);
  return true;
}

function isVisibleForwardGroupRuleForTelegramUser(rule: any, allowedForwardGroupIds: Set<number>) {
  return !!rule?.isForwardGroupTemplate
    && !!rule?.forwardGroupId
    && !rule?.forwardGroupRuleId
    && !rule?.forwardGroupMemberId
    && allowedForwardGroupIds.has(Number(rule.forwardGroupId));
}

async function visibleRulesForTelegramUser(user: any) {
  const isAdmin = user.role === "admin";
  const rules = await db.getForwardRules(isAdmin ? undefined : user.id);
  if (isAdmin) return rules as any[];
  const allowedForwardGroupIds = new Set(await db.getUserAllowedForwardGroupIds(user.id));
  return (rules as any[]).filter((rule: any) => {
    const isForwardGroupRule = !!(rule?.forwardGroupId || rule?.isForwardGroupTemplate || rule?.forwardGroupRuleId || rule?.forwardGroupMemberId);
    return !isForwardGroupRule || isVisibleForwardGroupRuleForTelegramUser(rule, allowedForwardGroupIds);
  });
}

async function visibleHostsForTelegramUser(user: any) {
  if (user.role === "admin") return db.getHosts() as Promise<any[]>;
  const [allowedHostIds, billingResourceIds, allHosts] = await Promise.all([
    db.getUserAllowedHostIds(user.id),
    db.getUserUsableTrafficBillingResourceIds(user.id),
    db.getHosts(),
  ]);
  const allowedSet = new Set([...(allowedHostIds || []), ...((billingResourceIds as any)?.hostIds || [])].map(Number));
  return (allHosts as any[]).filter((host: any) => allowedSet.has(Number(host.id)) || Number(host.userId) === Number(user.id));
}

async function visibleTunnelsForTelegramUser(user: any) {
  return (user.role === "admin" ? db.getTunnels() : db.getTunnelsForUser(user.id)) as Promise<any[]>;
}

async function visibleForwardGroupsForTelegramUser(user: any) {
  if (user.role === "admin") return db.getForwardGroups() as Promise<any[]>;
  const allowed = new Set((await db.getUserAllowedForwardGroupIds(user.id)).map(Number));
  const groups = (await db.getForwardGroups()) as any[];
  return db.filterForwardGroupFieldsForUse(groups.filter((group: any) => allowed.has(Number(group.id)))) as any[];
}

function searchMatches(keyword: string | undefined, values: unknown[]) {
  const needle = normalizeKeyword(keyword).toLowerCase();
  if (!needle) return true;
  return values.some((value) => String(value ?? "").toLowerCase().includes(needle));
}

function ruleSearchValues(rule: any) {
  return [
    rule.id,
    rule.name,
    rule.sourcePort,
    rule.targetIp,
    rule.targetPort,
    rule.forwardType,
    rule.protocol,
    rule.hostId,
    rule.tunnelId,
    rule.remark,
    rule.remarks,
    rule.description,
    ruleStatusText(rule),
    rule.entryIp,
    rule.entryDomain,
  ];
}

function hostSearchValues(host: any) {
  return [
    host.id,
    host.name,
    host.ip,
    host.ipv4,
    host.ipv6,
    host.entryIp,
    host.tunnelEntryIp,
    host.networkInterface,
    host.agentVersion,
    host.remark,
    host.remarks,
    host.description,
    onlineStatusText(host.isOnline),
  ];
}

function tunnelSearchValues(tunnel: any, entryHost?: any, exitHost?: any) {
  return [
    tunnel.id,
    tunnel.name,
    tunnel.mode,
    tunnel.listenPort,
    tunnel.networkType,
    tunnel.connectHost,
    tunnel.entryHostId,
    tunnel.exitHostId,
    entryHost?.name,
    entryHost?.ip,
    entryHost?.entryIp,
    exitHost?.name,
    exitHost?.ip,
    exitHost?.entryIp,
    tunnel.remark,
    tunnel.remarks,
    tunnel.description,
    runningStatusText(tunnel.isRunning),
  ];
}

function forwardGroupSearchValues(group: any) {
  return [
    group.id,
    group.name,
    group.groupType,
    group.groupMode,
    group.remark,
    group.remarks,
    group.description,
    group.isEnabled === false ? "已停用" : "已启用",
  ];
}

function ruleStatusText(rule: any) {
  return rule.isEnabled ? (rule.isRunning ? "运行中" : "等待同步") : "已停用";
}

function runningStatusText(value: unknown) {
  return value ? "运行中" : "未运行";
}

function onlineStatusText(value: unknown) {
  return value ? "在线" : "离线";
}

function moreText(total: number, shown: number) {
  return total > shown ? `\n\n<i>还有 ${total - shown} 条未展示，可加关键字缩小范围。</i>` : "";
}

function aiCode(value: unknown) {
  return `<code>${escapeHtml(value ?? "-")}</code>`;
}

function aiFilterPart(label: string, value: unknown) {
  return `${escapeHtml(label)} ${aiCode(value)}`;
}

function aiResultHeader(title: string, matched: number, total: number, unit: string, filterText = "") {
  return [
    `<b>${escapeHtml(title)}</b>`,
    `结果：<b>${matched}</b> / ${total} ${escapeHtml(unit)}`,
    filterText ? `筛选：${filterText}` : "",
  ].filter(Boolean).join("\n");
}

async function hostNameByIdMap(hostIds: number[]) {
  const uniqueIds = Array.from(new Set(hostIds.filter((id) => Number.isFinite(id) && id > 0)));
  const entries = await Promise.all(uniqueIds.map(async (id) => [id, await db.getHostById(id).catch(() => null)] as const));
  return new Map(entries.filter((entry) => entry[1]).map(([id, host]) => [id, host]));
}

type AiRuleTrafficSummary = {
  bytesIn: number;
  bytesOut: number;
  connections: number;
};

type AiRuleFilters = {
  keyword?: string;
  userKeyword?: string;
  hostKeyword?: string;
};

function emptyAiRuleTrafficSummary(): AiRuleTrafficSummary {
  return { bytesIn: 0, bytesOut: 0, connections: 0 };
}

function formatRuleTrafficSummary(summary: AiRuleTrafficSummary | undefined, compact = false) {
  const bytesIn = Math.max(0, Number(summary?.bytesIn || 0));
  const bytesOut = Math.max(0, Number(summary?.bytesOut || 0));
  const connections = Math.max(0, Number(summary?.connections || 0));
  const total = bytesIn + bytesOut;
  const line = compact
    ? `流量：<b>${escapeHtml(formatBytes(total))}</b>（入 ${escapeHtml(formatBytes(bytesIn))} / 出 ${escapeHtml(formatBytes(bytesOut))}）`
    : `已用流量：<b>${escapeHtml(formatBytes(total))}</b>\n入站：${escapeHtml(formatBytes(bytesIn))}\n出站：${escapeHtml(formatBytes(bytesOut))}`;
  return connections > 0 ? `${line}\n连接：${connections}` : line;
}

async function aiRuleTrafficSummaryMap(user: any, ruleIds: number[]) {
  const ids = Array.from(new Set(ruleIds.map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0)));
  const map = new Map<number, AiRuleTrafficSummary>();
  if (ids.length === 0) return map;
  const rows = await db.getTrafficSummaryByRule({
    userId: user.role === "admin" ? undefined : user.id,
    ruleIds: ids,
    includeLatency: false,
  }).catch(() => [] as any[]);
  for (const row of rows as any[]) {
    const ruleId = Number(row?.ruleId || 0);
    if (!ruleId) continue;
    const prev = map.get(ruleId) || emptyAiRuleTrafficSummary();
    prev.bytesIn += Math.max(0, Number(row?.bytesIn || 0));
    prev.bytesOut += Math.max(0, Number(row?.bytesOut || 0));
    prev.connections += Math.max(0, Number(row?.connections || 0));
    map.set(ruleId, prev);
  }
  for (const id of ids) if (!map.has(id)) map.set(id, emptyAiRuleTrafficSummary());
  return map;
}

function userSearchValues(user: any) {
  return [user.id, user.name, user.username, user.email, user.telegramUsername, user.role];
}

async function aiRulesWithFilters(user: any, filters: AiRuleFilters = {}) {
  const rules = await visibleRulesForTelegramUser(user);
  const keyword = normalizeAiQueryKeyword(filters.keyword);
  const requestedUserKeyword = normalizeAiQueryKeyword(filters.userKeyword);
  const userKeyword = user.role === "admin" ? requestedUserKeyword : "";
  const hostKeyword = normalizeAiQueryKeyword(filters.hostKeyword);
  const userIds = new Set<number>();
  if (userKeyword) {
    const users = await db.getUserTrafficSummaries().catch(() => [] as any[]);
    for (const item of users as any[]) {
      if (searchMatches(userKeyword, userSearchValues(item))) userIds.add(Number(item.id));
    }
  }
  const hosts = await visibleHostsForTelegramUser(user).catch(() => [] as any[]);
  const hostById = new Map((hosts as any[]).map((host: any) => [Number(host.id), host]));
  const hostIds = new Set<number>();
  if (hostKeyword) {
    for (const host of hosts as any[]) {
      if (searchMatches(hostKeyword, hostSearchValues(host))) hostIds.add(Number(host.id));
    }
  }
  const matched = (rules as any[]).filter((rule: any) => {
    if (keyword && !searchMatches(keyword, ruleSearchValues(rule))) return false;
    if (userKeyword && !userIds.has(Number(rule.userId))) return false;
    if (hostKeyword && !hostIds.has(Number(rule.hostId))) return false;
    return true;
  });
  return { rules, matched, hostById, keyword, userKeyword, hostKeyword };
}

function aiRuleFilterSuffix(filters: { keyword?: string; userKeyword?: string; hostKeyword?: string }) {
  return [
    filters.userKeyword ? aiFilterPart("用户", filters.userKeyword) : "",
    filters.hostKeyword ? aiFilterPart("主机", filters.hostKeyword) : "",
    filters.keyword ? aiFilterPart("关键字", filters.keyword) : "",
  ].filter(Boolean).join("，");
}

async function aiRulesText(user: any, keywordOrFilters?: string | AiRuleFilters) {
  const filters: AiRuleFilters = typeof keywordOrFilters === "string" ? { keyword: keywordOrFilters } : (keywordOrFilters || {});
  const { rules, matched, hostById, keyword, userKeyword, hostKeyword } = await aiRulesWithFilters(user, filters);
  const filterText = aiRuleFilterSuffix({ keyword, userKeyword, hostKeyword });
  const header = aiResultHeader("转发规则查询", matched.length, rules.length, "条", filterText);
  if (matched.length === 0) return `${header}\n\n没有找到匹配的规则。`;
  const visible = matched.slice(0, AI_QUERY_RESULT_LIMIT);
  const trafficByRuleId = await aiRuleTrafficSummaryMap(user, visible.map((rule: any) => Number(rule.id)));
  const lines = visible.map((rule: any) => {
    const host = hostById.get(Number(rule.hostId));
    return [
      `<b>#${rule.id} ${escapeHtml(shortText(rule.name, 28))}</b>`,
      `状态：<b>${escapeHtml(ruleStatusText(rule))}</b> · 类型：${aiCode(`${rule.forwardType || "-"} / ${formatForwardRuleProtocol(rule.protocol)}`)}`,
      `入口：${aiCode(`:${rule.sourcePort ?? "-"}`)} → 目标：${aiCode(`${rule.targetIp || "-"}:${rule.targetPort ?? "-"}`)}`,
      rule.tunnelId ? `所属：隧道 ${aiCode(`#${rule.tunnelId}`)}` : `所属：主机 ${aiCode(`#${rule.hostId}`)}${host?.name ? `（${escapeHtml(shortText(host.name, 18))}）` : ""}`,
      formatRuleTrafficSummary(trafficByRuleId.get(Number(rule.id)), true),
      rule.remark || rule.remarks || rule.description ? `备注：${escapeHtml(shortText(rule.remark || rule.remarks || rule.description, 32))}` : "",
    ].filter(Boolean).join("\n");
  });
  return `${header}\n\n${lines.join("\n\n")}${moreText(matched.length, visible.length)}`;
}

async function aiRuleDetailText(user: any, ruleId: number) {
  const rules = await visibleRulesForTelegramUser(user);
  const rule = rules.find((item: any) => Number(item.id) === Number(ruleId));
  if (!rule) return "规则不存在或无权查看。";
  const traffic = (await aiRuleTrafficSummaryMap(user, [Number(rule.id)])).get(Number(rule.id));
  return [
    `<b>规则 #${rule.id}</b>`,
    "",
    `名称：${escapeHtml(rule.name)}`,
    `状态：<b>${escapeHtml(ruleStatusText(rule))}</b>`,
    `类型：${aiCode(`${rule.forwardType || "-"} / ${formatForwardRuleProtocol(rule.protocol)}`)}`,
    `入口端口：${aiCode(`:${rule.sourcePort ?? "-"}`)}`,
    `目标：${aiCode(`${rule.targetIp || "-"}:${rule.targetPort ?? "-"}`)}`,
    rule.tunnelId ? `隧道：${aiCode(`#${rule.tunnelId}`)}` : `主机：${aiCode(`#${rule.hostId}`)}`,
    formatRuleTrafficSummary(traffic),
    rule.remark || rule.remarks || rule.description ? `备注：${escapeHtml(rule.remark || rule.remarks || rule.description)}` : "",
  ].filter(Boolean).join("\n");
}

async function aiRuleUsageText(user: any, ruleId: number) {
  const rules = await visibleRulesForTelegramUser(user);
  const rule = rules.find((item: any) => Number(item.id) === Number(ruleId));
  if (!rule) return "规则不存在或无权查看。";
  const traffic = (await aiRuleTrafficSummaryMap(user, [Number(rule.id)])).get(Number(rule.id));
  return [
    `<b>规则 #${rule.id} 流量</b>`,
    "",
    `名称：${escapeHtml(rule.name)}`,
    `入口：${aiCode(`:${rule.sourcePort ?? "-"}`)} → 目标：${aiCode(`${rule.targetIp || "-"}:${rule.targetPort ?? "-"}`)}`,
    formatRuleTrafficSummary(traffic),
  ].filter(Boolean).join("\n");
}

async function aiHostsText(user: any, keyword?: string) {
  const safeKeyword = normalizeAiQueryKeyword(keyword);
  const hosts = await visibleHostsForTelegramUser(user);
  const matched = hosts.filter((host) => searchMatches(safeKeyword, hostSearchValues(host)));
  const filterText = safeKeyword ? aiFilterPart("关键字", safeKeyword) : "";
  const header = aiResultHeader("主机查询", matched.length, hosts.length, "台", filterText);
  if (matched.length === 0) return `${header}\n\n没有找到匹配的主机。`;
  const visible = matched.slice(0, AI_QUERY_RESULT_LIMIT);
  const lines = visible.map((host: any) => {
    const address = host.ip || host.ipv4 || host.ipv6 || "-";
    return [
      `<b>#${host.id} ${escapeHtml(shortText(host.name, 28))}</b>`,
      `状态：<b>${escapeHtml(onlineStatusText(host.isOnline))}</b>`,
      `地址：${aiCode(address)}`,
      host.ipv4 && host.ipv4 !== address ? `IPv4：${aiCode(host.ipv4)}` : "",
      host.ipv6 && host.ipv6 !== address ? `IPv6：${aiCode(host.ipv6)}` : "",
      host.entryIp ? `入口：${aiCode(host.entryIp)}` : "",
      host.tunnelEntryIp ? `内网入口：${aiCode(host.tunnelEntryIp)}` : "",
      host.agentVersion ? `Agent：${aiCode(host.agentVersion)}` : "",
      host.lastHeartbeat ? `心跳：${escapeHtml(formatDateTime(host.lastHeartbeat))}` : "",
    ].filter(Boolean).join("\n");
  });
  return `${header}\n\n${lines.join("\n\n")}${moreText(matched.length, visible.length)}`;
}

async function aiTunnelsText(user: any, keyword?: string) {
  const safeKeyword = normalizeAiQueryKeyword(keyword);
  const tunnels = await visibleTunnelsForTelegramUser(user);
  const hostIds = tunnels.flatMap((tunnel: any) => [Number(tunnel.entryHostId || 0), Number(tunnel.exitHostId || 0)]);
  const hostsById = await hostNameByIdMap(hostIds);
  const matched = tunnels.filter((tunnel: any) => {
    const entryHost = hostsById.get(Number(tunnel.entryHostId || 0));
    const exitHost = hostsById.get(Number(tunnel.exitHostId || 0));
    return searchMatches(safeKeyword, tunnelSearchValues(tunnel, entryHost, exitHost));
  });
  const filterText = safeKeyword ? aiFilterPart("关键字", safeKeyword) : "";
  const header = aiResultHeader("链路查询", matched.length, tunnels.length, "条", filterText);
  if (matched.length === 0) return `${header}\n\n没有找到匹配的链路。`;
  const visible = matched.slice(0, AI_QUERY_RESULT_LIMIT);
  const lines = visible.map((tunnel: any) => {
    const entryHost = hostsById.get(Number(tunnel.entryHostId || 0));
    const exitHost = hostsById.get(Number(tunnel.exitHostId || 0));
    const latency = tunnel.latestLatencyMs ?? tunnel.lastLatencyMs;
    return [
      `<b>#${tunnel.id} ${escapeHtml(shortText(tunnel.name, 28))}</b>`,
      `状态：<b>${escapeHtml(runningStatusText(tunnel.isRunning))}</b>`,
      `路径：${aiCode(entryHost?.name || tunnel.entryHostId || "-")} → ${aiCode(exitHost?.name || tunnel.exitHostId || "-")}`,
      `模式：${aiCode(tunnel.mode || "-")}${tunnel.networkType ? ` · 网络：${aiCode(tunnel.networkType)}` : ""}`,
      tunnel.listenPort ? `出口端口：${aiCode(tunnel.listenPort)}` : "",
      tunnel.connectHost ? `连接地址：${aiCode(tunnel.connectHost)}` : "",
      latency != null ? `延迟：<b>${escapeHtml(`${latency} ms`)}</b>` : "",
      tunnel.remark || tunnel.remarks || tunnel.description ? `备注：${escapeHtml(shortText(tunnel.remark || tunnel.remarks || tunnel.description, 32))}` : "",
    ].filter(Boolean).join("\n");
  });
  return `${header}\n\n${lines.join("\n\n")}${moreText(matched.length, visible.length)}`;
}

async function aiForwardGroupsText(user: any, keyword?: string) {
  const safeKeyword = normalizeAiQueryKeyword(keyword);
  const groups = await visibleForwardGroupsForTelegramUser(user);
  const matched = groups.filter((group) => searchMatches(safeKeyword, forwardGroupSearchValues(group)));
  const filterText = safeKeyword ? aiFilterPart("关键字", safeKeyword) : "";
  const header = aiResultHeader("转发组查询", matched.length, groups.length, "个", filterText);
  if (matched.length === 0) return `${header}\n\n没有找到匹配的转发组。`;
  const visible = matched.slice(0, AI_QUERY_RESULT_LIMIT);
  const lines = visible.map((group: any) => [
    `<b>#${group.id} ${escapeHtml(shortText(group.name, 28))}</b>`,
    `状态：<b>${group.isEnabled === false ? "已停用" : "已启用"}</b>`,
    `类型：${aiCode(`${group.groupType || "-"} / ${group.groupMode || "-"}`)}`,
    group.remark || group.remarks || group.description ? `备注：${escapeHtml(shortText(group.remark || group.remarks || group.description, 32))}` : "",
  ].filter(Boolean).join("\n"));
  return `${header}\n\n${lines.join("\n\n")}${moreText(matched.length, visible.length)}`;
}

async function aiUsersText(user: any, keyword?: string) {
  const safeKeyword = normalizeAiQueryKeyword(keyword);
  if (user.role !== "admin") {
    return [userInfoText(user), "", await usageText(user)].join("\n");
  }
  const users = await db.getUserTrafficSummaries();
  const exactUserId = /^\d+$/.test(safeKeyword) ? Number(safeKeyword) : undefined;
  const matchedById = exactUserId ? (users as any[]).filter((item) => Number(item.id) === exactUserId) : [];
  const matched = matchedById.length > 0
    ? matchedById
    : (users as any[]).filter((item) => searchMatches(safeKeyword, [item.id, item.name, item.username, item.role, item.email, item.telegramUsername]));
  const filterText = safeKeyword ? aiFilterPart("关键字", safeKeyword) : "";
  const header = aiResultHeader("用户查询", matched.length, users.length, "个", filterText);
  if (matched.length === 0) return `${header}\n\n没有找到匹配的用户。`;
  const visible = matched.slice(0, AI_QUERY_RESULT_LIMIT);
  const lines = visible.map((item: any) => {
    const limit = Number(item.trafficLimit) || 0;
    const trafficUsed = escapeHtml(formatBytes(item.trafficUsed));
    const trafficLimit = limit > 0 ? escapeHtml(formatBytes(limit)) : "不限";
    return [
      `<b>#${item.id} ${escapeHtml(shortText(item.name || item.username, 22))}</b>`,
      `角色：<b>${item.role === "admin" ? "管理员" : "用户"}</b> · 用户名：${aiCode(item.username || "-")}`,
      item.telegramUsername ? `TG：${aiCode(item.telegramUsername)}` : "",
      `流量：<b>${trafficUsed}</b> / ${trafficLimit}`,
      `到期：${escapeHtml(formatDate(item.expiresAt))}`,
    ].filter(Boolean).join("\n");
  });
  return `${header}\n\n${lines.join("\n\n")}${moreText(matched.length, visible.length)}`;
}

function aiQueryHelpText() {
  return [
    "<b>自然语言查询</b>",
    "",
    "可以直接发送：",
    `${aiCode("我的流量")}`,
    `${aiCode("查规则 443")}`,
    `${aiCode("规则 #12 详情")}`,
    `${aiCode("第9条规则用了多少流量")}`,
    `${aiCode("9号规则用了多少流量")}`,
    `${aiCode("用户1的使用详情")}`,
    `${aiCode("列出张三用户上海主机的规则")}`,
    `${aiCode("现在有哪些用户")}`,
    `${aiCode("主机 上海")}`,
    `${aiCode("链路 东京")}`,
    "",
    "<b>管理操作（需要点击确认后才会执行）</b>",
    `${aiCode("给用户 1 充值 50")}`,
    `${aiCode("给我充点钱（会继续追问金额）")}`,
    `${aiCode("把用户 test111 余额设置为 88")}`,
    `${aiCode("给用户1续费 3 个月")}`,
    `${aiCode("停用用户 3937064828@qq.com")}`,
    `${aiCode("启用用户 #5")}`,
    `${aiCode("关闭用户1转发")}`,
    `${aiCode("启用 test111 转发")}`,
    `${aiCode("关闭第 12 条规则")}`,
    `${aiCode("开启 #9 号规则")}`,
    `${aiCode("关闭 东京 隧道 的规则")}`,
    `${aiCode("开启 2 号隧道的规则")}`,
    `${aiCode("给我增加一个转发到 10.10.0.1 的 5151 端口")}`,
    `${aiCode("给我加一个端口转发到 1.1.1.1:443，源端口随机")}`,
    `${aiCode("给我增加一个隧道转发到 10.10.0.1:5151，隧道 东京01")}`,
    `${aiCode("删除转发到 10.10.0.1:5151 的规则")}`,
    `${aiCode("删除第 12 条规则")}`,
    `${aiCode("重置用户 1 流量")}`,
    "",
    "<b>普通用户可用操作（仅限自己）</b>",
    `${aiCode("关闭我的转发")}`,
    `${aiCode("启用我的转发")}`,
    "",
    "<i>新增转发时，若未说明“端口转发/隧道转发”会先弹出选择；未提供源端口时默认随机分配。</i>",
    "",
    "<i>所有写操作都会先生成确认卡片，点击“确认执行”后才会生效。</i>",
  ].join("\n");
}

async function aiQueryText(user: any, rawText: string) {
  const query = rawText.replace(/^\/ask(?:@\w+)?\s*/i, "").trim();
  if (!query) return aiQueryHelpText();
  const parsed = await parseAiQueryIntent(query);
  switch (parsed.intent) {
    case "usage":
      return usageText(user);
    case "account":
      return userInfoText(user);
    case "rules": {
      return aiRulesText(user, {
        keyword: parsed.keyword,
        userKeyword: extractUserFilterKeyword(query),
        hostKeyword: extractHostFilterKeyword(query),
      });
    }
    case "rule_detail": {
      const ruleId = parsed.id || extractRuleId(query);
      return ruleId ? aiRuleDetailText(user, ruleId) : aiRulesText(user, parsed.keyword);
    }
    case "rule_usage": {
      const ruleId = parsed.id || extractRuleId(query);
      return ruleId ? aiRuleUsageText(user, ruleId) : aiRulesText(user, {
        keyword: parsed.keyword,
        userKeyword: extractUserFilterKeyword(query),
        hostKeyword: extractHostFilterKeyword(query),
      });
    }
    case "hosts":
      return aiHostsText(user, parsed.keyword);
    case "tunnels":
      return aiTunnelsText(user, parsed.keyword);
    case "forward_groups":
      return aiForwardGroupsText(user, parsed.keyword);
    case "users": {
      const userKeyword = parsed.keyword || normalizeUserLookupKeyword(extractUserFilterKeyword(query));
      return aiUsersText(user, userKeyword);
    }
    case "unsupported":
      return "未识别到可执行的指令。可以先发查询，或直接说明要调整什么（例如：给用户1充值50、关闭我的转发），系统会先要求二次确认。";
    case "help":
    default:
      return aiQueryHelpText();
  }
}

async function handleAiQuery(message: TelegramMessage, user: any, rawText: string) {
  const sent = await sendMessage(message.chat.id, await aiQueryText(user, rawText));
  await scheduleAiMessageAutoRecall(message.chat.id, message.message_id, sent);
}
async function handleUsage(message: TelegramMessage, user: any) {
  await sendMessage(message.chat.id, await usageText(user));
}

async function handleRules(message: TelegramMessage, user: any) {
  const view = await rulesView(user, 0);
  await sendMessage(message.chat.id, view.text, view.keyboard);
}

function redeemSuccessText(result: any) {
  if (result.type === "balance") {
    return [
      "<b>兑换成功</b>",
      "",
      `类型：余额`,
      `入账金额：${formatMoneyCny(result.amountCents)}`,
      `当前余额：${formatMoneyCny(result.balanceCents)}`,
    ].join("\n");
  }
  if (result.type === "plan") {
    return [
      "<b>兑换成功</b>",
      "",
      `类型：套餐`,
      `套餐：${escapeHtml(result.planName || `套餐 #${result.planId}`)}`,
      result.durationDays ? `有效期：${result.durationDays} 天` : "",
      `到期时间：${escapeHtml(formatDateTime(result.expiresAt))}`,
      result.portRangeStart && result.portRangeEnd ? `端口段：${result.portRangeStart}-${result.portRangeEnd}` : "",
    ].filter(Boolean).join("\n");
  }
  return "<b>兑换成功</b>";
}

async function redeemForTelegramUser(user: any, code: string) {
  const normalized = code.trim();
  if (!normalized) throw new Error("请输入兑换码");
  if (user.role === "admin") throw new Error("管理员账户无需兑换码");
  const result = await db.redeemCode(user.id, normalized);
  const recovery = await db.recoverUserForwardAccessIfEligible(user.id);
  if (recovery.restored) {
    await refreshUserForwardEndpoints(user.id, "telegram-code-redeemed-forward-restored");
  }
  return result;
}

async function handleRedeem(message: TelegramMessage, user: any, code?: string) {
  if (!code?.trim()) {
    if (message.from?.id) await sendRedeemCodePrompt(message.chat.id, message.from.id);
    return;
  }
  try {
    const result = await redeemForTelegramUser(user, code);
    await sendMessage(message.chat.id, redeemSuccessText(result), backMenuKeyboard());
  } catch (error: any) {
    await sendMessage(message.chat.id, `兑换失败：${escapeHtml(error?.message || "兑换码无效")}`, redeemCancelKeyboard());
  }
}

async function refreshRuleEndpoint(rule: any, reason: string) {
  if (rule.tunnelId) {
    const tunnel = await db.getTunnelById(Number(rule.tunnelId));
    await db.updateTunnel(Number(rule.tunnelId), { isRunning: false } as any);
    if (tunnel) await pushTunnelEndpointRefresh(tunnel, reason);
  } else {
    pushAgentRefresh(Number(rule.hostId), reason);
  }
}

async function refreshUserForwardEndpoints(userId: number, reason: string) {
  const rules = await db.getForwardRulesForUserSync(userId);
  const hostIds = new Set<number>();
  const tunnelIds = new Set<number>();
  for (const rule of rules as any[]) {
    if (rule.tunnelId) tunnelIds.add(Number(rule.tunnelId));
    else if (rule.hostId) hostIds.add(Number(rule.hostId));
  }
  for (const tunnelId of tunnelIds) {
    const tunnel = await db.getTunnelById(tunnelId);
    await db.updateTunnel(tunnelId, { isRunning: false } as any);
    if (tunnel) await pushTunnelEndpointRefresh(tunnel, reason);
  }
  for (const hostId of hostIds) pushAgentRefresh(hostId, reason);
}

async function assertRuleCanBeEnabledFromTelegram(user: any, rule: any) {
  let group: any = null;
  if ((rule as any).isForwardGroupTemplate && (rule as any).forwardGroupId) {
    group = await db.getForwardGroupById(Number((rule as any).forwardGroupId));
    await db.validateForwardGroupRuleConfig(Number((rule as any).forwardGroupId), {
      sourcePort: Number(rule.sourcePort),
      excludeTemplateRuleId: Number(rule.id),
    });
  } else {
    let policy = portPolicyFrom(null);
    if (Number((rule as any).tunnelId || 0) > 0) {
      const tunnel = await db.getTunnelById(Number((rule as any).tunnelId));
      const entryHost = await db.getHostById(Number((tunnel as any)?.entryHostId || rule.hostId));
      policy = combinePortPolicies(
        portPolicyFrom(entryHost as any),
        portPolicyFrom({
          portRangeStart: (tunnel as any)?.portRangeStart,
          portRangeEnd: (tunnel as any)?.portRangeEnd,
        }),
      );
    } else {
      const host = await db.getHostById(Number(rule.hostId));
      policy = portPolicyFrom(host as any);
    }
    const sourcePort = Number(rule.sourcePort);
    if (!isPortAllowedByPolicy(sourcePort, policy)) {
      throw new Error(`${portPolicyErrorMessage(policy, "入口端口")}，请修改端口后再启用`);
    }
  }
  requireMainBackupAllowed({
    enabled: (rule as any).failoverEnabled,
    protocol: (rule as any).protocol,
    forwardType: group?.groupType === "tunnel" ? "gost" : (rule as any).forwardType,
    tunnelId: (rule as any).tunnelId,
    isTunnelRoute: group?.groupType === "tunnel",
    isAdmin: user.role === "admin",
  });
  if (user.role !== "admin") {
    const check = await db.ensureUserForwardAccessReady(Number(user.id));
    if (!check.allowed) throw new Error(check.message || "你的转发权限已停用，无法启用规则");
    const owner = check.user || await db.getUserById(Number(user.id));
    if (owner?.expiresAt && new Date(owner.expiresAt) <= new Date()) throw new Error("账户已到期，无法启用规则");
    if (Number(owner?.trafficLimit) > 0 && Number(owner?.trafficUsed) >= Number(owner?.trafficLimit)) throw new Error("流量已用完，无法启用规则");
  }
  const used = await db.isPortUsedOnHost(Number(rule.hostId), Number(rule.sourcePort), Number(rule.id));
  if (used) throw new Error(`端口 ${rule.sourcePort} 已被占用，请更换端口后再启用`);
}

async function handleRuleToggle(message: TelegramMessage, user: any, ruleIdRaw: string | undefined, enabled: boolean) {
  const ruleId = Number(ruleIdRaw);
  if (!Number.isFinite(ruleId) || ruleId <= 0) {
    await sendMessage(message.chat.id, `请发送 ${enabled ? "/enable" : "/disable"} 规则ID，例如：${enabled ? "/enable" : "/disable"} 12`);
    return;
  }
  const rule = await db.getForwardRuleById(ruleId);
  if (!rule || (user.role !== "admin" && rule.userId !== user.id)) {
    await sendMessage(message.chat.id, "规则不存在或无权操作。");
    return;
  }
  if (enabled) {
    try {
      await assertRuleCanBeEnabledFromTelegram(user, rule);
    } catch (error: any) {
      await sendMessage(message.chat.id, error?.message || "无法启用规则。");
      return;
    }
  }
  if (enabled) {
    await db.updateForwardRule(rule.id, { isEnabled: true, isRunning: false, disabledByUser: false, disabledByTunnel: false, protocolBlockReason: null } as any);
  } else {
    await db.toggleForwardRule(rule.id, false);
  }
  await refreshRuleEndpoint(rule, enabled ? "telegram-rule-enabled" : "telegram-rule-disabled");
  await sendMessage(message.chat.id, `规则 #${rule.id} ${enabled ? "已启用，等待 Agent 同步" : "已停用"}。`);
}

async function toggleRuleForUser(user: any, ruleId: number, enabled: boolean) {
  if (!Number.isFinite(ruleId) || ruleId <= 0) {
    throw new Error("规则 ID 无效");
  }
  const rule = await db.getForwardRuleById(ruleId);
  if (!rule || (user.role !== "admin" && rule.userId !== user.id)) {
    throw new Error("规则不存在或无权操作");
  }
  if (enabled) await assertRuleCanBeEnabledFromTelegram(user, rule);
  if (enabled) {
    await db.updateForwardRule(rule.id, { isEnabled: true, isRunning: false, disabledByUser: false, disabledByTunnel: false, protocolBlockReason: null } as any);
  } else {
    await db.toggleForwardRule(rule.id, false);
  }
  await refreshRuleEndpoint(rule, enabled ? "telegram-rule-enabled" : "telegram-rule-disabled");
  return rule;
}

async function handleLogin(message: TelegramMessage, user: any) {
  await sendMessage(message.chat.id, await loginText(user));
}

async function handleWebApp(message: TelegramMessage, user?: any | null) {
  if (user && (user as any).accountEnabled === false) {
    await sendMessage(message.chat.id, ACCOUNT_DISABLED_ERR_MSG);
    return;
  }
  const settings = await getTelegramSettings();
  const webAppUrl = settings.panelPublicUrl
    ? buildTelegramWebAppUrl(
      settings.panelPublicUrl,
      createTelegramWebAppLoginChallenge({ telegramId: user?.telegramId || message.from?.id || null }),
    )
    : "";
  if (!webAppUrl) {
    await sendMessage(message.chat.id, "管理员尚未配置可公开访问的面板地址，暂时无法在 Telegram 内打开面板。");
    return;
  }
  await sendMessage(
    message.chat.id,
    [
      "<b>ForwardX WebApp</b>",
      "",
      user
        ? "点击下方按钮可在 Telegram 内打开面板，已绑定账号会自动登录。"
        : "点击下方按钮打开面板后，请先用账号密码登录并在个人设置完成 Telegram 绑定。",
      "为保障安全，请勿将入口链接分享给他人。",
    ].join("\n"),
    webAppOpenKeyboard(webAppUrl),
  );
}

async function handleUsers(message: TelegramMessage) {
  const view = await usersView(0);
  await sendMessage(message.chat.id, view.text, view.keyboard);
}

async function handleReset(message: TelegramMessage, userIdRaw: string | undefined) {
  const userId = Number(userIdRaw);
  if (!Number.isFinite(userId) || userId <= 0) {
    await sendMessage(message.chat.id, "请发送 /reset 用户ID，例如：/reset 8");
    return;
  }
  const user = await db.getUserById(userId);
  if (!user) {
    await sendMessage(message.chat.id, "用户不存在。");
    return;
  }
  await db.resetUserTraffic(userId);
  await sendMessage(message.chat.id, `用户 #${userId} ${escapeHtml(user.name || user.username)} 的流量已重置。`);
}

async function handleRenew(message: TelegramMessage, userIdRaw: string | undefined) {
  const userId = Number(userIdRaw);
  if (!Number.isFinite(userId) || userId <= 0) {
    await sendMessage(message.chat.id, "请发送 /renew 用户ID，例如：/renew 8。该操作需要二次确认。");
    return;
  }
  const detail = await renewalConfirmText(userId);
  await sendMessage(message.chat.id, detail.text, detail.target ? renewalConfirmKeyboard(userId, 0) : undefined);
}

async function handleUpdatePanel(message: TelegramMessage, user: any) {
  const waitMs = takeUpdateCommandCooldown(user.id, "panel");
  if (waitMs > 0) {
    await sendMessage(message.chat.id, `操作太频繁，请 ${Math.max(1, Math.ceil(waitMs / 1000))} 秒后再试。`);
    return;
  }
  const info = await checkPanelUpdateTask(true);
  if (info.error) {
    await sendMessage(message.chat.id, `检查面板更新失败：${escapeHtml(info.error)}`);
    return;
  }
  const currentVersion = String(info.currentVersion || APP_VERSION).trim() || APP_VERSION;
  const latestVersion = String(info.latestVersion || "").trim();
  if (!latestVersion) {
    await sendMessage(message.chat.id, "暂时未获取到最新面板版本，请稍后重试。");
    return;
  }
  if (!info.hasUpdate) {
    if (info.pendingReason) {
      await sendMessage(
        message.chat.id,
        [
          "<b>面板更新检查</b>",
          `当前版本：<b>v${escapeHtml(currentVersion)}</b>`,
          `最新版本：<b>v${escapeHtml(latestVersion)}</b>`,
          "",
          escapeHtml(info.pendingReason),
        ].join("\n"),
      );
      return;
    }
    await sendMessage(
      message.chat.id,
      [
        "<b>面板更新检查</b>",
        `当前版本：<b>v${escapeHtml(currentVersion)}</b>`,
        `最新版本：<b>v${escapeHtml(latestVersion)}</b>`,
        "",
        "当前已经是最新版本。",
      ].join("\n"),
    );
    return;
  }
  const pending = createPendingUpdateAction({
    actorUserId: Number(user.id),
    kind: "panel",
    targetVersion: latestVersion,
  });
  await sendMessage(
    message.chat.id,
    [
      "<b>检测到面板新版本</b>",
      `当前版本：<b>v${escapeHtml(currentVersion)}</b>`,
      `目标版本：<b>v${escapeHtml(latestVersion)}</b>`,
      "",
      "确认后将开始后台升级任务，期间面板可能短暂重启。",
      `请在 ${Math.round(UPDATE_ACTION_CONFIRM_TTL_MS / 60000)} 分钟内确认。`,
    ].join("\n"),
    updateActionConfirmKeyboard("panel", pending.key),
  );
}

async function handleUpdateAgent(message: TelegramMessage, user: any) {
  const waitMs = takeUpdateCommandCooldown(user.id, "agent");
  if (waitMs > 0) {
    await sendMessage(message.chat.id, `操作太频繁，请 ${Math.max(1, Math.ceil(waitMs / 1000))} 秒后再试。`);
    return;
  }
  const hosts = await db.getHosts() as any[];
  if (hosts.length === 0) {
    await sendMessage(message.chat.id, "当前没有可升级的 Agent 主机。");
    return;
  }
  const targetVersion = String(AGENT_VERSION || "").trim() || "latest";
  const outdated = hosts.filter((host) => {
    const current = String(host?.agentVersion || "").trim();
    if (!current) return true;
    return !isAgentVersionAtLeast(current, targetVersion);
  });
  if (outdated.length === 0) {
    await sendMessage(
      message.chat.id,
      [
        "<b>Agent 更新检查</b>",
        `目标版本：<b>v${escapeHtml(targetVersion)}</b>`,
        `主机数量：${hosts.length}`,
        "",
        "所有主机的 Agent 已是最新版本。",
      ].join("\n"),
    );
    return;
  }
  const hostIds = outdated
    .map((host) => Number(host?.id || 0))
    .filter((id) => Number.isFinite(id) && id > 0);
  const preview = outdated.slice(0, UPDATE_AGENT_PREVIEW_LIMIT).map((host) => {
    const hostId = Number(host?.id || 0);
    const hostName = shortText(host?.name || host?.ip || host?.entryIp || `主机${hostId}`, 20);
    const current = String(host?.agentVersion || "").trim() || "未知";
    return `- #${hostId} ${escapeHtml(hostName)} · v${escapeHtml(current)} -> v${escapeHtml(targetVersion)}`;
  });
  if (outdated.length > UPDATE_AGENT_PREVIEW_LIMIT) {
    preview.push(`- 其余 ${outdated.length - UPDATE_AGENT_PREVIEW_LIMIT} 台主机将一并下发升级`);
  }
  const pending = createPendingUpdateAction({
    actorUserId: Number(user.id),
    kind: "agent",
    targetVersion,
    hostIds,
  });
  await sendMessage(
    message.chat.id,
    [
      "<b>检测到可升级 Agent</b>",
      `目标版本：<b>v${escapeHtml(targetVersion)}</b>`,
      `可升级主机：<b>${outdated.length}</b> / ${hosts.length}`,
      "",
      ...preview,
      "",
      `请在 ${Math.round(UPDATE_ACTION_CONFIRM_TTL_MS / 60000)} 分钟内确认执行。`,
    ].join("\n"),
    updateActionConfirmKeyboard("agent", pending.key),
  );
}

async function executePendingUpdateAction(pending: PendingUpdateAction) {
  if (pending.kind === "panel") {
    const targetVersion = String(pending.targetVersion || "").trim() || undefined;
    const result = await startPanelUpgradeTask(targetVersion || null);
    if (!result?.success) {
      return [
        "<b>面板升级暂未开始</b>",
        targetVersion ? `目标版本：<b>v${escapeHtml(targetVersion)}</b>` : "",
        "",
        escapeHtml(result?.pendingReason || "发布资产仍在构建中，请稍后重新检查更新。"),
      ].filter(Boolean).join("\n");
    }
    return [
      "<b>面板升级任务已启动</b>",
      `目标版本：<b>v${escapeHtml(result?.targetVersion || targetVersion || "latest")}</b>`,
      "",
      "可在网页后台的系统设置中查看升级状态和日志。",
    ].join("\n");
  }

  const targetVersion = String(pending.targetVersion || AGENT_VERSION || "").trim() || String(AGENT_VERSION || "latest");
  const hostIds = Array.from(new Set((pending.hostIds || [])
    .map((id) => Number(id))
    .filter((id) => Number.isFinite(id) && id > 0)));
  if (hostIds.length === 0) {
    return "没有可执行更新的 Agent 主机，请重新检查。";
  }
  const configuredPanelUrl = String((await db.getSetting("panelPublicUrl")) || "").trim();
  const panelUrl = /^https?:\/\//i.test(configuredPanelUrl) ? configuredPanelUrl.replace(/\/+$/, "") : "";
  let requested = 0;
  let pushed = 0;
  let skippedLatest = 0;
  let missing = 0;
  let failed = 0;
  const failedHostIds: number[] = [];
  for (const hostId of hostIds) {
    const host = await db.getHostById(hostId);
    if (!host) {
      missing += 1;
      continue;
    }
    const currentVersion = String((host as any)?.agentVersion || "").trim();
    if (currentVersion && isAgentVersionAtLeast(currentVersion, targetVersion)) {
      skippedLatest += 1;
      continue;
    }
    try {
      await db.requestHostAgentUpgrade(hostId, targetVersion);
      requested += 1;
      if (pushAgentUpgrade(hostId, targetVersion, panelUrl)) pushed += 1;
    } catch {
      failed += 1;
      failedHostIds.push(hostId);
    }
  }
  const failedText = failedHostIds.length
    ? `失败主机：${failedHostIds.slice(0, 10).map((id) => `#${id}`).join(" ")}${failedHostIds.length > 10 ? " ..." : ""}`
    : "";
  return [
    "<b>Agent 升级任务已处理</b>",
    `目标版本：<b>v${escapeHtml(targetVersion)}</b>`,
    `待升级目标：${hostIds.length}`,
    `已下发升级：${requested}`,
    `已在线推送：${pushed}`,
    skippedLatest > 0 ? `已是最新：${skippedLatest}` : "",
    missing > 0 ? `主机不存在：${missing}` : "",
    failed > 0 ? `下发失败：${failed}` : "",
    failedText ? escapeHtml(failedText) : "",
  ].filter(Boolean).join("\n");
}

async function handleMessage(message: TelegramMessage) {
  const text = message.text?.trim();
  if (!text) return;
  const { command, args } = parseCommand(text);
  const identity = await ensureTelegramIdentity(message);
  if (!identity) return;
  const waitingForBindCode = hasValidBindSession(message.chat.id, identity.telegramId);
  const waitingForRedeemCode = hasValidRedeemSession(message.chat.id, identity.telegramId);

  if (command === "/start" && args[0]) {
    if (isMobileLoginCode(args[0])) {
      await handleMobileLoginStart(message, args[0], identity.user);
      return;
    }
    await handleBind(message, args[0]);
    return;
  }
  if (command === "/start" || command === "/help") {
    if (identity.user) {
      if ((identity.user as any).accountEnabled === false) {
        await sendMessage(message.chat.id, ACCOUNT_DISABLED_ERR_MSG);
        return;
      }
      await sendMainMenu(message.chat.id, identity.user);
    } else {
      await sendBindPrompt(message.chat.id);
    }
    return;
  }
  if (command === "/bind") {
    if (identity.user) {
      if ((identity.user as any).accountEnabled === false) {
        await sendMessage(message.chat.id, ACCOUNT_DISABLED_ERR_MSG);
        return;
      }
      await sendMainMenu(message.chat.id, identity.user);
      return;
    }
    if (args[0]) await handleBind(message, args[0]);
    else await sendBindCodePrompt(message.chat.id, identity.telegramId);
    return;
  }
  if (command === "/webapp") {
    await handleWebApp(message, identity.user);
    return;
  }

  const user = identity.user;
  if (!user) {
    if (waitingForBindCode && !text.startsWith("/")) {
      await handleBind(message, text);
      clearBindSession(message.chat.id, identity.telegramId);
      return;
    }
    await sendBindPrompt(message.chat.id);
    return;
  }
  if ((user as any).accountEnabled === false) {
    await sendMessage(message.chat.id, ACCOUNT_DISABLED_ERR_MSG);
    return;
  }

  if (waitingForRedeemCode && !text.startsWith("/")) {
    clearRedeemSession(message.chat.id, identity.telegramId);
    await handleRedeem(message, user, text);
    return;
  }

  if (command === "/menu") return sendMainMenu(message.chat.id, user);
  if (command === "/usage") return handleUsage(message, user);
  if (command === "/rules") return handleRules(message, user);
  if (command === "/ask") {
    if (await tryHandleManageAction(message, user, text)) return;
    return handleAiQuery(message, user, text);
  }
  if (command === "/redeem") return handleRedeem(message, user, args.join(" "));
  if (command === "/login") return handleLogin(message, user);
  if (command === "/webapp") return handleWebApp(message, user);
  if (command === "/enable") return handleRuleToggle(message, user, args[0], true);
  if (command === "/disable") return handleRuleToggle(message, user, args[0], false);
  if (command === "/unbind") {
    await sendMessage(message.chat.id, "确认解除当前 Telegram 绑定吗？解除后需要重新绑定才能使用机器人。", unbindConfirmKeyboard());
    return;
  }

  if (user.role === "admin" && command === "/users") return handleUsers(message);
  if (user.role === "admin" && command === "/reset") return handleReset(message, args[0]);
  if (user.role === "admin" && command === "/renew") return handleRenew(message, args[0]);
  if (user.role === "admin" && command === "/updatepanel") return handleUpdatePanel(message, user);
  if (user.role === "admin" && command === "/updateagent") return handleUpdateAgent(message, user);

  if (!text.startsWith("/")) {
    if (await tryHandleManageAction(message, user, text)) return;
    return handleAiQuery(message, user, text);
  }

  await sendMessage(message.chat.id, helpText(true, user.role === "admin"));
}

async function handleCallback(query: TelegramCallbackQuery) {
  if (!query.message?.chat?.id || !query.message.message_id) return;
  await answerCallback(query.id).catch(() => undefined);
  const identity = await ensureTelegramUser(query.from);
  if (!identity) return;
  const user = identity.user;
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const data = query.data || "";
  if (data === "fx:bind:start") {
    if (user) {
      if ((user as any).accountEnabled === false) {
        await editMessage(chatId, messageId, ACCOUNT_DISABLED_ERR_MSG);
        return;
      }
      await editMainMenu(chatId, messageId, user);
    } else {
      await editBindCodePrompt(chatId, messageId, identity.telegramId);
    }
    return;
  }
  if (data === "fx:bind:cancel") {
    clearBindSession(chatId, identity.telegramId);
    await editMessage(chatId, messageId, "已取消本次绑定。需要绑定时可再次点击下方按钮。", bindPromptKeyboard());
    return;
  }
  if (!user) {
    await editMessage(chatId, messageId, "当前 Telegram 尚未绑定 ForwardX 账户。请先完成绑定。", bindPromptKeyboard());
    return;
  }
  if ((user as any).accountEnabled === false) {
    await editMessage(chatId, messageId, ACCOUNT_DISABLED_ERR_MSG);
    return;
  }

  if (data.startsWith("fx:app-login:")) {
    await confirmMobileLogin(chatId, messageId, data.slice("fx:app-login:".length), user);
    return;
  }
  if (data.startsWith("fx:app-login-cancel:")) {
    clearMobileTelegramLoginChallenge(data.slice("fx:app-login-cancel:".length));
    await editMessage(chatId, messageId, "已取消本次登录。");
    return;
  }

  if (data.startsWith("fx:update:")) {
    if (user.role !== "admin") {
      await editMessage(chatId, messageId, "你没有管理员权限。", backMenuKeyboard());
      return;
    }
    const [, , kindRaw, opRaw, actionKeyRaw] = data.split(":");
    const kind: UpdateCommandKind | null = kindRaw === "panel" || kindRaw === "agent" ? kindRaw : null;
    const op = opRaw === "confirm" || opRaw === "cancel" ? opRaw : null;
    const actionKey = String(actionKeyRaw || "").trim().toLowerCase();
    if (!kind || !op || !actionKey) {
      await editMessage(chatId, messageId, "无法识别该更新操作，请重新执行命令。", backMenuKeyboard());
      return;
    }
    const pending = getPendingUpdateAction(actionKey);
    if (!pending || pending.kind !== kind) {
      await editMessage(chatId, messageId, "更新操作已超时或已被处理，请重新执行命令。", backMenuKeyboard());
      return;
    }
    if (Number(pending.actorUserId) !== Number(user.id)) {
      await editMessage(chatId, messageId, "只有原发起人才可以确认或取消该更新操作。", updateActionConfirmKeyboard(kind, pending.key));
      return;
    }
    if (op === "cancel") {
      consumePendingUpdateAction(actionKey);
      await editMessage(chatId, messageId, "已取消本次更新操作。", backMenuKeyboard());
      return;
    }
    const consumed = consumePendingUpdateAction(actionKey);
    if (!consumed || consumed.kind !== kind) {
      await editMessage(chatId, messageId, "更新操作已超时或已被处理，请重新执行命令。", backMenuKeyboard());
      return;
    }
    const result = await executePendingUpdateAction(consumed)
      .catch((error) => `执行更新失败：${escapeHtml(error instanceof Error ? error.message : String(error))}`);
    await editMessage(chatId, messageId, result, backMenuKeyboard());
    return;
  }

  if (data === "fx:redeem") {
    if (user.role === "admin") {
      await editMessage(chatId, messageId, "管理员账户无需兑换码。", backMenuKeyboard());
      return;
    }
    await editRedeemCodePrompt(chatId, messageId, identity.telegramId);
    return;
  }
  if (data === "fx:redeem:cancel") {
    clearRedeemSession(chatId, identity.telegramId);
    await editMessage(chatId, messageId, "已取消本次兑换。", backMenuKeyboard());
    return;
  }

  if (data.startsWith("fx:rules:")) {
    const page = Number(data.split(":")[2] || 0);
    const view = await rulesView(user, page);
    await editMessage(chatId, messageId, view.text, view.keyboard);
    return;
  }
  if (data.startsWith("fx:rule:view:")) {
    const [, , , ruleIdRaw, pageRaw] = data.split(":");
    const ruleId = Number(ruleIdRaw);
    const page = Number(pageRaw || 0);
    await editMessage(chatId, messageId, await ruleDetailText(ruleId, user), ruleListBackKeyboard(page));
    return;
  }
  if (data.startsWith("fx:rule:toggle:")) {
    const [, , , ruleIdRaw, pageRaw] = data.split(":");
    const ruleId = Number(ruleIdRaw);
    const page = Number(pageRaw || 0);
    const rule = await db.getForwardRuleById(ruleId);
    if (!rule) {
      await editMessage(chatId, messageId, "规则不存在。", ruleListBackKeyboard(page));
      return;
    }
    await toggleRuleForUser(user, ruleId, !rule.isEnabled);
    const view = await rulesView(user, page);
    await editMessage(chatId, messageId, `规则 #${ruleId} 已${rule.isEnabled ? "停用" : "启用"}。\n\n${view.text}`, view.keyboard);
    return;
  }
  if (data.startsWith("fx:users:")) {
    if (user.role !== "admin") {
      await editMessage(chatId, messageId, "你没有管理员权限。", backMenuKeyboard());
      return;
    }
    const page = Number(data.split(":")[2] || 0);
    const view = await usersView(page);
    await editMessage(chatId, messageId, view.text, view.keyboard);
    return;
  }
  if (data.startsWith("fx:admin:user:")) {
    if (user.role !== "admin") {
      await editMessage(chatId, messageId, "你没有管理员权限。", backMenuKeyboard());
      return;
    }
    const [, , , userIdRaw, pageRaw] = data.split(":");
    const userId = Number(userIdRaw);
    const page = Number(pageRaw || 0);
    const detail = await adminUserText(userId);
    await editMessage(chatId, messageId, detail.text, detail.target ? await adminUserKeyboard(userId, page) : userManageBackKeyboard(page));
    return;
  }
  if (data.startsWith("fx:admin:reset:")) {
    if (user.role !== "admin") {
      await editMessage(chatId, messageId, "你没有管理员权限。", backMenuKeyboard());
      return;
    }
    const [, , , userIdRaw, pageRaw] = data.split(":");
    const userId = Number(userIdRaw);
    const page = Number(pageRaw || 0);
    const target = await db.getUserById(userId);
    if (!target) {
      await editMessage(chatId, messageId, "用户不存在。", userManageBackKeyboard(page));
      return;
    }
    await db.resetUserTraffic(userId);
    const detail = await adminUserText(userId);
    await editMessage(chatId, messageId, `已重置用户 #${userId} 的流量。\n\n${detail.text}`, await adminUserKeyboard(userId, page));
    return;
  }
  if (data.startsWith("fx:admin:access:")) {
    if (user.role !== "admin") {
      await editMessage(chatId, messageId, "你没有管理员权限。", backMenuKeyboard());
      return;
    }
    const [, , , userIdRaw, enabledRaw, pageRaw] = data.split(":");
    const userId = Number(userIdRaw);
    const page = Number(pageRaw || 0);
    const target = await db.getUserById(userId);
    if (!target) {
      await editMessage(chatId, messageId, "用户不存在。", userManageBackKeyboard(page));
      return;
    }
    if (target.role === "admin") {
      await editMessage(chatId, messageId, "管理员账户不能在机器人内停用转发权限。", await adminUserKeyboard(userId, page));
      return;
    }
    const enabled = enabledRaw === "1";
    await db.setUserForwardAccess(userId, enabled);
    await refreshUserForwardEndpoints(userId, enabled ? "telegram-user-forward-enabled" : "telegram-user-forward-disabled");
    const detail = await adminUserText(userId);
    await editMessage(chatId, messageId, `已${enabled ? "启用" : "停用"}用户 #${userId} 的转发权限。\n\n${detail.text}`, await adminUserKeyboard(userId, page));
    return;
  }
  if (data.startsWith("fx:admin:renew:confirm:")) {
    if (user.role !== "admin") {
      await editMessage(chatId, messageId, "你没有管理员权限。", backMenuKeyboard());
      return;
    }
    const [, , , , userIdRaw, pageRaw] = data.split(":");
    const userId = Number(userIdRaw);
    const page = Number(pageRaw || 0);
    const result = await renewUserOneMonth(userId);
    const detail = await adminUserText(userId);
    await editMessage(
      chatId,
      messageId,
      `已为用户 #${userId} 续期 1 个月。\n新到期时间：<b>${escapeHtml(formatDateTime(result.nextExpiresAt))}</b>\n\n${detail.text}`,
      await adminUserKeyboard(userId, page),
    );
    return;
  }
  if (data.startsWith("fx:admin:renew:")) {
    if (user.role !== "admin") {
      await editMessage(chatId, messageId, "你没有管理员权限。", backMenuKeyboard());
      return;
    }
    const [, , , userIdRaw, pageRaw] = data.split(":");
    const userId = Number(userIdRaw);
    const page = Number(pageRaw || 0);
    const detail = await renewalConfirmText(userId);
    await editMessage(chatId, messageId, detail.text, detail.target ? renewalConfirmKeyboard(userId, page) : userManageBackKeyboard(page));
    return;
  }

  if (data.startsWith("fx:op:clarify:")) {
    const session = getPendingManageClarifySession(chatId, user.id);
    if (!session) {
      await editMessage(chatId, messageId, "补充信息会话已超时，请重新发送操作指令。", backMenuKeyboard());
      await scheduleAiMessageAutoRecall(chatId, undefined, messageId);
      return;
    }
    const action = data.slice("fx:op:clarify:".length);
    if (action === "cancel") {
      clearPendingManageClarifySession(chatId, user.id);
      await editMessage(chatId, messageId, "已取消本次操作。", backMenuKeyboard());
      await scheduleAiMessageAutoRecall(chatId, undefined, messageId);
      return;
    }

    const nextIntent: ManageActionIntent = { ...session.intent };
    if (action.startsWith("mode:")) {
      const modeRaw = action.slice("mode:".length);
      if (modeRaw !== "host" && modeRaw !== "tunnel") {
        await editMessage(chatId, messageId, "转发模式选项无效，请重新选择。", manageClarifyModeKeyboard());
        await scheduleAiMessageAutoRecall(chatId, undefined, messageId);
        return;
      }
      nextIntent.forwardMode = modeRaw as ManageForwardMode;
      if (modeRaw === "host") delete nextIntent.tunnel;
      if (modeRaw === "tunnel") delete nextIntent.host;
    } else if (action.startsWith("tunnel:")) {
      const tunnelId = Number(action.slice("tunnel:".length));
      if (!Number.isFinite(tunnelId) || tunnelId <= 0) {
        await editMessage(chatId, messageId, "隧道选项无效，请重新选择。", manageClarifyCancelKeyboard());
        await scheduleAiMessageAutoRecall(chatId, undefined, messageId);
        return;
      }
      nextIntent.forwardMode = "tunnel";
      nextIntent.tunnel = String(tunnelId);
      delete nextIntent.host;
    } else if (action.startsWith("host:")) {
      const hostId = Number(action.slice("host:".length));
      if (!Number.isFinite(hostId) || hostId <= 0) {
        await editMessage(chatId, messageId, "主机选项无效，请重新选择。", manageClarifyCancelKeyboard());
        await scheduleAiMessageAutoRecall(chatId, undefined, messageId);
        return;
      }
      nextIntent.forwardMode = "host";
      nextIntent.host = String(hostId);
      delete nextIntent.tunnel;
    } else if (action.startsWith("rule:")) {
      const ruleId = Number(action.slice("rule:".length));
      if (!Number.isFinite(ruleId) || ruleId <= 0) {
        await editMessage(chatId, messageId, "规则选项无效，请重新选择。", manageClarifyCancelKeyboard());
        await scheduleAiMessageAutoRecall(chatId, undefined, messageId);
        return;
      }
      nextIntent.ruleId = ruleId;
    } else {
      await editMessage(chatId, messageId, "无法识别该补充操作，请重新发送指令。", backMenuKeyboard());
      await scheduleAiMessageAutoRecall(chatId, undefined, messageId);
      return;
    }

    const prepared = await prepareManageAction(user, session.sourceText, nextIntent);
    if (prepared.clarify) {
      createPendingManageClarifySession(
        chatId,
        prepared.clarify.actor || user,
        session.sourceText,
        prepared.clarify.intent,
        prepared.clarify.missingFields,
      );
      await editMessage(chatId, messageId, prepared.clarify.text, prepared.clarify.keyboard || manageClarifyCancelKeyboard());
      await scheduleAiMessageAutoRecall(chatId, undefined, messageId);
      return;
    }

    clearPendingManageClarifySession(chatId, user.id);
    if (!prepared.prepared) {
      await editMessage(chatId, messageId, prepared.error || "未识别到可执行的管理操作。", backMenuKeyboard());
      await scheduleAiMessageAutoRecall(chatId, undefined, messageId);
      return;
    }
    const actionPending = createPendingManageAction(prepared.prepared.pending);
    await editMessage(
      chatId,
      messageId,
      manageActionConfirmText(actionPending, prepared.prepared.actor, prepared.prepared.target),
      manageActionConfirmKeyboard(actionPending.key),
    );
    await scheduleAiMessageAutoRecall(chatId, undefined, messageId);
    return;
  }

  if (data.startsWith("fx:op:confirm:")) {
    const actionKey = data.slice("fx:op:confirm:".length).trim().toLowerCase();
    const pending = getPendingManageAction(actionKey);
    if (!pending) {
      await editMessage(chatId, messageId, "操作已超时或已被处理，请重新发送指令。", backMenuKeyboard());
      await scheduleAiMessageAutoRecall(chatId, undefined, messageId);
      return;
    }
    if (Number(pending.actorUserId) !== Number(user.id)) {
      await editMessage(chatId, messageId, "只有原发起人才可以确认执行该操作。", manageActionConfirmKeyboard(pending.key));
      await scheduleAiMessageAutoRecall(chatId, undefined, messageId);
      return;
    }
    const consumed = consumePendingManageAction(actionKey);
    if (!consumed) {
      await editMessage(chatId, messageId, "操作已超时或已被处理，请重新发送指令。", backMenuKeyboard());
      await scheduleAiMessageAutoRecall(chatId, undefined, messageId);
      return;
    }
    const result = await executePendingManageAction(consumed, user);
    await editMessage(chatId, messageId, result, backMenuKeyboard());
    await scheduleAiMessageAutoRecall(chatId, undefined, messageId);
    return;
  }
  if (data.startsWith("fx:op:cancel:")) {
    const actionKey = data.slice("fx:op:cancel:".length).trim().toLowerCase();
    const pending = getPendingManageAction(actionKey);
    if (!pending) {
      await editMessage(chatId, messageId, "操作已超时或已被处理，请重新发送指令。", backMenuKeyboard());
      await scheduleAiMessageAutoRecall(chatId, undefined, messageId);
      return;
    }
    if (Number(pending.actorUserId) !== Number(user.id)) {
      await editMessage(chatId, messageId, "只有原发起人才可以取消该操作。", manageActionConfirmKeyboard(pending.key));
      await scheduleAiMessageAutoRecall(chatId, undefined, messageId);
      return;
    }
    consumePendingManageAction(actionKey);
    await editMessage(chatId, messageId, "已取消本次操作。", backMenuKeyboard());
    await scheduleAiMessageAutoRecall(chatId, undefined, messageId);
    return;
  }
  switch (data) {
    case "fx:menu":
      await editMainMenu(chatId, messageId, user);
      return;
    case "fx:user":
      await editMessage(chatId, messageId, userInfoText(user), backMenuKeyboard());
      return;
    case "fx:usage":
      await editMessage(chatId, messageId, await usageText(user), backMenuKeyboard());
      return;
    case "fx:rules":
      {
        const view = await rulesView(user, 0);
        await editMessage(chatId, messageId, view.text, view.keyboard);
      }
      return;
    case "fx:redeem":
      if (user.role === "admin") {
        await editMessage(chatId, messageId, "管理员账户无需兑换码。", backMenuKeyboard());
        return;
      }
      await editRedeemCodePrompt(chatId, messageId, identity.telegramId);
      return;
    case "fx:users":
      if (user.role !== "admin") {
        await editMessage(chatId, messageId, "你没有管理员权限。", backMenuKeyboard());
        return;
      }
      {
        const view = await usersView(0);
        await editMessage(chatId, messageId, view.text, view.keyboard);
      }
      return;
    case "fx:unbind":
      await editMessage(chatId, messageId, "确认解除当前 Telegram 绑定吗？解除后需要重新绑定才能使用机器人。", unbindConfirmKeyboard());
      return;
    case "fx:unbind:confirm":
      await db.unbindTelegramAccount(user.id);
      await editMessage(chatId, messageId, "已解除当前 Telegram 绑定。", bindPromptKeyboard());
      return;
    default:
      await editMainMenu(chatId, messageId, user);
  }
}

async function pollOnce() {
  const settings = await getTelegramSettings();
  if (!settings.enabled || !settings.token) {
    await new Promise((resolve) => setTimeout(resolve, 30000));
    return;
  }
  const tokenKey = getTokenKey(settings.token);
  if (tokenKey !== activeTokenKey) {
    updateOffset = 0;
    activeTokenKey = tokenKey;
  }
  const updates = await telegramApi<TelegramUpdate[]>("getUpdates", {
    offset: updateOffset || undefined,
    timeout: 25,
    allowed_updates: ["message", "callback_query"],
  });
  for (const update of updates) {
    updateOffset = Math.max(updateOffset, update.update_id + 1);
    try {
      if (update.message) await handleMessage(update.message);
      if (update.callback_query) await handleCallback(update.callback_query);
    } catch (error) {
      console.error("[Telegram] Failed to handle message:", error);
      const chatId = update.message?.chat.id || update.callback_query?.message?.chat.id;
      if (chatId) await sendMessage(chatId, `操作失败：${escapeHtml(error instanceof Error ? error.message : String(error))}`).catch(() => undefined);
    }
  }
}

export async function refreshTelegramBotProfile() {
  const settings = await getTelegramSettings();
  if (!settings.token) return null;
  const me = await telegramApi<{ username?: string; first_name?: string; id?: number }>("getMe");
  if (me.username) await db.setSetting("telegramBotUsername", me.username);
  await syncTelegramBotCommands().catch((error) => {
    console.warn(`[Telegram] setMyCommands failed: ${error instanceof Error ? error.message : String(error)}`);
  });
  return me;
}

export async function startTelegramBot() {
  if (pollingStarted) return;
  const settings = await getTelegramSettings();
  if (!settings.enabled || !settings.token) {
    console.info("[Telegram] Bot is disabled or token is not configured");
    return;
  }
  if (!ENV.telegramBotPolling) {
    console.info("[Telegram] Bot polling is disabled");
    return;
  }
  pollingStarted = true;
  pollingAbort = false;
  console.info("[Telegram] Starting bot polling");
  refreshTelegramBotProfile().catch((error) => console.warn(`[Telegram] getMe failed: ${error instanceof Error ? error.message : String(error)}`));

  void (async () => {
    while (!pollingAbort) {
      try {
        await pollOnce();
      } catch (error) {
        console.warn(`[Telegram] Polling failed: ${error instanceof Error ? error.message : String(error)}`);
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }
  })();
}

export function stopTelegramBot() {
  pollingAbort = true;
  pollingStarted = false;
}

export function resetTelegramBotPolling() {
  updateOffset = 0;
  activeTokenKey = "";
}

