import * as db from "./db";
import { requireMainBackupAllowed } from "./routers/rules.crud";
import { ENV } from "./env";
import { ACCOUNT_DISABLED_ERR_MSG } from "../shared/const";
import { pushAgentRefresh } from "./agentEvents";
import { pushTunnelEndpointRefresh } from "./routers/helpers";
import { addMonthsClamped } from "./repositories/repositoryUtils";
import { clearMobileTelegramLoginChallenge, hasMobileTelegramLoginChallenge } from "./telegramMobileLogin";
import { formatForwardRuleProtocol } from "../shared/forwardTypes";

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

let pollingStarted = false;
let pollingAbort = false;
let updateOffset = 0;
let activeTokenKey = "";
const pendingBindChats = new Map<string, number>();
const pendingRedeemChats = new Map<string, number>();

const LOGIN_CODE_TTL_MS = 5 * 60 * 1000;
const BIND_SESSION_TTL_MS = 10 * 60 * 1000;
const REDEEM_SESSION_TTL_MS = 10 * 60 * 1000;
const USER_PAGE_SIZE = 10;
const RULE_PAGE_SIZE = 10;
const TELEGRAM_BOT_COMMANDS: TelegramBotCommand[] = [
  { command: "start", description: "打开菜单或完成账号绑定" },
  { command: "menu", description: "打开功能菜单" },
  { command: "usage", description: "查询流量和额度" },
  { command: "rules", description: "查看和管理转发规则" },
  { command: "redeem", description: "兑换余额或套餐兑换码" },
  { command: "bind", description: "使用绑定码绑定后台账号" },
  { command: "login", description: "生成网页登录链接" },
  { command: "unbind", description: "解除 Telegram 绑定" },
  { command: "users", description: "管理员用户管理" },
  { command: "reset", description: "管理员重置用户流量" },
  { command: "renew", description: "管理员续期用户一个月" },
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

type InlineKeyboardMarkup = {
  inline_keyboard: Array<Array<{ text: string; callback_data?: string; url?: string }>>;
};

async function sendMessage(chatId: number | string, text: string, replyMarkup?: InlineKeyboardMarkup) {
  await telegramApi("sendMessage", {
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
    "/redeem 兑换码 - 兑换余额或套餐",
    "/login - 生成网页一次性登录链接",
    "/enable 规则ID - 启用规则",
    "/disable 规则ID - 停用规则",
    "/unbind - 解除当前 Telegram 绑定（需要确认）",
  ];
  if (isAdmin) {
    base.push("", "管理员命令：", "/users - 查看用户管理", "/reset 用户ID - 重置用户流量", "/renew 用户ID - 续期用户一个月");
  }
  return base.map(escapeHtml).join("\n");
}

function bindPromptKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: "绑定 Telegram", callback_data: "fx:bind:start" }],
    ],
  };
}

function bindCancelKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: "取消绑定", callback_data: "fx:bind:cancel" }],
    ],
  };
}

function redeemCancelKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: "取消兑换", callback_data: "fx:redeem:cancel" }],
      [{ text: "返回菜单", callback_data: "fx:menu" }],
    ],
  };
}

function unbindConfirmKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: "确认解除绑定", callback_data: "fx:unbind:confirm" },
        { text: "取消", callback_data: "fx:menu" },
      ],
    ],
  };
}

function mobileLoginConfirmKeyboard(code: string): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: "确认登录", callback_data: `fx:app-login:${code}` },
        { text: "取消", callback_data: `fx:app-login-cancel:${code}` },
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

function mainMenuKeyboard(user: any): InlineKeyboardMarkup {
  const rows: InlineKeyboardMarkup["inline_keyboard"] = [
    [
      { text: "用户信息", callback_data: "fx:user" },
      { text: "流量用量", callback_data: "fx:usage" },
    ],
    [
      { text: "转发规则", callback_data: "fx:rules" },
      ...(user?.role === "admin" ? [] : [{ text: "兑换码", callback_data: "fx:redeem" }]),
    ],
  ];
  if (user?.role === "admin") {
    rows.push([{ text: "用户管理", callback_data: "fx:users:0" }]);
  }
  rows.push([{ text: "解除绑定", callback_data: "fx:unbind" }]);
  return { inline_keyboard: rows };
}

function backMenuKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: "返回菜单", callback_data: "fx:menu" }],
    ],
  };
}

function userManageBackKeyboard(page = 0): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: "返回用户列表", callback_data: `fx:users:${page}` }],
      [{ text: "返回菜单", callback_data: "fx:menu" }],
    ],
  };
}

function renewalConfirmKeyboard(userId: number, page = 0): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: "确认续期 1 个月", callback_data: `fx:admin:renew:confirm:${userId}:${page}` },
        { text: "取消", callback_data: `fx:admin:user:${userId}:${page}` },
      ],
      [{ text: "返回用户详情", callback_data: `fx:admin:user:${userId}:${page}` }],
    ],
  };
}

function ruleListBackKeyboard(page = 0): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: "返回规则列表", callback_data: `fx:rules:${page}` }],
      [{ text: "返回菜单", callback_data: "fx:menu" }],
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
      { text: `${rule.isEnabled ? "停用" : "启用"} #${rule.id}`, callback_data: `fx:rule:toggle:${rule.id}:${safePage}` },
      { text: `详情 #${rule.id}`, callback_data: `fx:rule:view:${rule.id}:${safePage}` },
    ]);
  }
  if (totalPages > 1) {
    rows.push([
      { text: "上一页", callback_data: `fx:rules:${Math.max(0, safePage - 1)}` },
      { text: "下一页", callback_data: `fx:rules:${Math.min(totalPages - 1, safePage + 1)}` },
    ]);
  }
  rows.push([{ text: "返回菜单", callback_data: "fx:menu" }]);
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
    rows.push([{ text: `管理 #${user.id} ${shortText(user.name || user.username, 14)}`, callback_data: `fx:admin:user:${user.id}:${safePage}` }]);
  }
  if (totalPages > 1) {
    rows.push([
      { text: "上一页", callback_data: `fx:users:${Math.max(0, safePage - 1)}` },
      { text: "下一页", callback_data: `fx:users:${Math.min(totalPages - 1, safePage + 1)}` },
    ]);
  }
  rows.push([{ text: "返回菜单", callback_data: "fx:menu" }]);
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
        { text: "重置流量", callback_data: `fx:admin:reset:${userId}:${page}` },
        { text: accessEnabled ? "停用转发" : "启用转发", callback_data: `fx:admin:access:${userId}:${accessEnabled ? "0" : "1"}:${page}` },
      ],
      [{ text: "续期 1 个月", callback_data: `fx:admin:renew:${userId}:${page}` }],
      [{ text: "刷新详情", callback_data: `fx:admin:user:${userId}:${page}` }],
      [{ text: "返回用户列表", callback_data: `fx:users:${page}` }],
      [{ text: "返回菜单", callback_data: "fx:menu" }],
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
  await sendMessage(chatId, menuText(user), mainMenuKeyboard(user));
}

async function editMainMenu(chatId: number | string, messageId: number, user: any) {
  await editMessage(chatId, messageId, menuText(user), mainMenuKeyboard(user));
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
    let rangeStart: number | null | undefined;
    let rangeEnd: number | null | undefined;
    if (Number((rule as any).tunnelId || 0) > 0) {
      const tunnel = await db.getTunnelById(Number((rule as any).tunnelId));
      rangeStart = (tunnel as any)?.portRangeStart;
      rangeEnd = (tunnel as any)?.portRangeEnd;
    } else {
      const host = await db.getHostById(Number(rule.hostId));
      rangeStart = (host as any)?.portRangeStart;
      rangeEnd = (host as any)?.portRangeEnd;
    }
    const sourcePort = Number(rule.sourcePort);
    if (rangeStart != null && rangeEnd != null && (sourcePort < Number(rangeStart) || sourcePort > Number(rangeEnd))) {
      throw new Error(`入口端口必须在 ${rangeStart}-${rangeEnd} 范围内，请修改端口后再启用`);
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
  if (command === "/redeem") return handleRedeem(message, user, args.join(" "));
  if (command === "/login") return handleLogin(message, user);
  if (command === "/enable") return handleRuleToggle(message, user, args[0], true);
  if (command === "/disable") return handleRuleToggle(message, user, args[0], false);
  if (command === "/unbind") {
    await sendMessage(message.chat.id, "确认解除当前 Telegram 绑定吗？解除后需要重新绑定才能使用机器人。", unbindConfirmKeyboard());
    return;
  }

  if (user.role === "admin" && command === "/users") return handleUsers(message);
  if (user.role === "admin" && command === "/reset") return handleReset(message, args[0]);
  if (user.role === "admin" && command === "/renew") return handleRenew(message, args[0]);

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
