import * as db from "./db";
import { ENV } from "./env";
import { pushAgentRefresh } from "./agentEvents";
import { pushTunnelEndpointRefresh } from "./routers/helpers";

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

type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
};

let pollingStarted = false;
let pollingAbort = false;
let updateOffset = 0;
let activeTokenKey = "";

const LOGIN_CODE_TTL_MS = 5 * 60 * 1000;

function randomCode(length = 32) {
  let out = "";
  while (out.length < length) out += crypto.randomUUID().replace(/-/g, "");
  return out.slice(0, length).toUpperCase();
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

function formatDate(value: unknown) {
  if (!value) return "永久有效";
  const date = new Date(value as any);
  return Number.isNaN(date.getTime()) ? "永久有效" : date.toLocaleDateString("zh-CN");
}

function formatTelegramName(from?: TelegramUser) {
  const parts = [from?.first_name, from?.last_name].filter(Boolean);
  if (parts.length) return parts.join(" ");
  return from?.username ? `@${from.username}` : String(from?.id || "");
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
      : "请先在面板个人菜单点击 Telegram 绑定按钮，或发送 /bind 绑定码。",
    "/usage - 查询我的用量",
    "/rules - 查看我的转发规则",
    "/enable 规则ID - 启用规则",
    "/disable 规则ID - 停用规则",
    "/login - 生成网页登录链接",
    "/unbind - 解除当前 Telegram 绑定",
  ];
  if (isAdmin) {
    base.push("", "管理员命令：", "/users - 查看用户流量概览", "/reset 用户ID - 重置用户流量");
  }
  return base.map(escapeHtml).join("\n");
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
      { text: "登录后台", callback_data: "fx:login" },
    ],
  ];
  if (user?.role === "admin") {
    rows.push([{ text: "用户概览", callback_data: "fx:users" }]);
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
    `余额：¥${((Number(user.balanceCents) || 0) / 100).toFixed(2)}`,
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
      `${status} · ${escapeHtml(rule.forwardType)} ${escapeHtml(rule.protocol)}`,
      `:${rule.sourcePort} → ${escapeHtml(rule.targetIp)}:${rule.targetPort}`,
    ].join("\n");
  });
  const more = rules.length > visible.length ? `\n\n还有 ${rules.length - visible.length} 条规则未展示，可发送 /rules 查看更多。` : "";
  return `<b>转发规则</b>\n\n${lines.join("\n\n")}${more}`;
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
    await sendMessage(message.chat.id, "绑定码无效。请在面板中重新生成绑定码。");
    return;
  }
  const expiresAt = user.telegramBindCodeExpiresAt ? new Date(user.telegramBindCodeExpiresAt).getTime() : 0;
  if (!expiresAt || expiresAt <= Date.now()) {
    await db.clearTelegramBindCode(user.id);
    await sendMessage(message.chat.id, "绑定码已过期。请在面板中重新生成绑定码。");
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
    `已绑定到 ForwardX 账户：<b>${escapeHtml(user.name || user.username)}</b>\n之后可以使用 /usage、/rules、/login。`,
  );
  const boundUser = await db.getUserById(user.id);
  if (boundUser) await sendMainMenu(message.chat.id, boundUser);
}

async function handleUsage(message: TelegramMessage, user: any) {
  await sendMessage(message.chat.id, await usageText(user));
}

async function handleRules(message: TelegramMessage, user: any) {
  await sendMessage(message.chat.id, await rulesText(user));
}

async function refreshRuleEndpoint(rule: any, reason: string) {
  if (rule.tunnelId) {
    const tunnel = await db.getTunnelById(Number(rule.tunnelId));
    await db.updateTunnel(Number(rule.tunnelId), { isRunning: false } as any);
    if (tunnel) pushTunnelEndpointRefresh(tunnel, reason);
  } else {
    pushAgentRefresh(Number(rule.hostId), reason);
  }
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
  if (enabled && user.role !== "admin") {
    if (!user.canAddRules) {
      await sendMessage(message.chat.id, "你的转发权限已停用，无法启用规则。");
      return;
    }
    if (user.expiresAt && new Date(user.expiresAt) <= new Date()) {
      await sendMessage(message.chat.id, "账户已到期，无法启用规则。");
      return;
    }
    if (Number(user.trafficLimit) > 0 && Number(user.trafficUsed) >= Number(user.trafficLimit)) {
      await sendMessage(message.chat.id, "流量已用完，无法启用规则。");
      return;
    }
  }
  if (enabled) {
    await db.updateForwardRule(rule.id, { isEnabled: true, isRunning: false });
  } else {
    await db.toggleForwardRule(rule.id, false);
  }
  await refreshRuleEndpoint(rule, enabled ? "telegram-rule-enabled" : "telegram-rule-disabled");
  await sendMessage(message.chat.id, `规则 #${rule.id} ${enabled ? "已启用，等待 Agent 同步" : "已停用"}。`);
}

async function handleLogin(message: TelegramMessage, user: any) {
  await sendMessage(message.chat.id, await loginText(user));
}

async function handleUsers(message: TelegramMessage) {
  await sendMessage(message.chat.id, await usersText());
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

async function handleMessage(message: TelegramMessage) {
  const text = message.text?.trim();
  if (!text) return;
  const { command, args } = parseCommand(text);
  const identity = await ensureTelegramIdentity(message);
  if (!identity) return;

  if (command === "/start" && args[0]) {
    await handleBind(message, args[0]);
    return;
  }
  if (command === "/start" || command === "/help") {
    if (identity.user) {
      await sendMainMenu(message.chat.id, identity.user);
    } else {
      await sendMessage(message.chat.id, helpText(false));
    }
    return;
  }
  if (command === "/bind") {
    await handleBind(message, args[0] || "");
    return;
  }

  const user = identity.user;
  if (!user) {
    await sendMessage(message.chat.id, "当前 Telegram 尚未绑定 ForwardX 账户。请先在面板个人菜单点击 Telegram 绑定按钮，或发送 /bind 绑定码。");
    return;
  }

  if (command === "/menu") return sendMainMenu(message.chat.id, user);
  if (command === "/usage") return handleUsage(message, user);
  if (command === "/rules") return handleRules(message, user);
  if (command === "/enable") return handleRuleToggle(message, user, args[0], true);
  if (command === "/disable") return handleRuleToggle(message, user, args[0], false);
  if (command === "/login") return handleLogin(message, user);
  if (command === "/unbind") {
    await db.unbindTelegramAccount(user.id);
    await sendMessage(message.chat.id, "已解除当前 Telegram 绑定。");
    return;
  }

  if (user.role === "admin" && command === "/users") return handleUsers(message);
  if (user.role === "admin" && command === "/reset") return handleReset(message, args[0]);

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
  if (!user) {
    await editMessage(chatId, messageId, "当前 Telegram 尚未绑定 ForwardX 账户。请先在面板中完成绑定。");
    return;
  }

  switch (query.data) {
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
      await editMessage(chatId, messageId, await rulesText(user), backMenuKeyboard());
      return;
    case "fx:login":
      await editMessage(chatId, messageId, await loginText(user), backMenuKeyboard());
      return;
    case "fx:users":
      if (user.role !== "admin") {
        await editMessage(chatId, messageId, "你没有管理员权限。", backMenuKeyboard());
        return;
      }
      await editMessage(chatId, messageId, await usersText(), backMenuKeyboard());
      return;
    case "fx:unbind":
      await db.unbindTelegramAccount(user.id);
      await editMessage(chatId, messageId, "已解除当前 Telegram 绑定。");
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
