import { getNotificationSettings } from "./notificationSettings";
import { setSettings } from "./repositories/settingsRepository";
import { KeyedTaskDispatcher } from "./keyedTaskDispatcher";
import { seamlessBackgroundPaused } from "./seamlessMigrationState";
import { processDiscordBotUpdate, TELEGRAM_BOT_COMMANDS } from "./telegramBot";
import { isDiscordSnowflake as snowflake } from "./discordIdentity";

const REST_BASE = "https://discord.com/api/v10";
const GATEWAY = "wss://gateway.discord.gg/?v=10&encoding=json";
const apiQueue = new KeyedTaskDispatcher(1);
const updates = new KeyedTaskDispatcher(4);
const seen = new Map<string, number>();
const actorRequests = new Map<string, { count: number; until: number }>();
let gateway: WebSocket | null = null;
let heartbeat: ReturnType<typeof setInterval> | null = null;
let watchdog: ReturnType<typeof setInterval> | null = null;
let nextApiAt = 0;
let activeToken = "";
let generation = 0;
let sequence: number | null = null;
let sessionId = "";
let acknowledged = true;
let reconnectAt = 0;
let failures = 0;
let blockedToken = "";
let connected = false;
let connectingAt = 0;
let reconciling = false;
let lastConfigurationWarning = 0;
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function discordText(html: string) {
  return String(html || "").replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
}
export function discordComponents(markup: any) {
  const buttons = (markup?.inline_keyboard || []).flat().map((button: any) => {
    const url = button.url || button.web_app?.url;
    if (url && !/^https?:\/\//i.test(url)) return null;
    if (!url && (!button.callback_data || String(button.callback_data).length > 100)) return null;
    return { type: 2, style: url ? 5 : 1, label: discordText(button.text).slice(0, 80) || "操作",
      ...(url ? { url } : { custom_id: button.callback_data }) };
  }).filter(Boolean);
  if (buttons.length > 25) throw new Error("Discord 菜单超过 25 个按钮，请使用指令查询");
  return Array.from({ length: Math.ceil(buttons.length / 5) }, (_, index) => ({ type: 1, components: buttons.slice(index * 5, index * 5 + 5) }));
}

export async function discordRequest(path: string, method = "GET", body?: unknown, allowInactive = false): Promise<any> {
  if (!path.startsWith("/") || path.includes("://")) throw new Error("Invalid Discord API path");
  if (apiQueue.pendingCount >= 256) throw new Error("Discord 请求队列繁忙，请稍后重试");
  return apiQueue.enqueue("discord-rest", async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      await delay(Math.max(0, nextApiAt - Date.now()));
      const settings = await getNotificationSettings("discord");
      if (!settings.token || (!allowInactive && (!settings.active || seamlessBackgroundPaused()))) throw new Error("Discord 通知渠道未启用或未配置");
      nextApiAt = Date.now() + 350;
      const response = await fetch(`${REST_BASE}${path}`, { method, headers: { Authorization: `Bot ${settings.token}`, "Content-Type": "application/json" },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10_000) });
      const json = response.status === 204 ? null : await response.json().catch(() => null) as any;
      if (response.status === 429 && attempt < 2) {
        const retryMs = Math.max(350, Number(json?.retry_after || 1) * 1000);
        if (!Number.isFinite(retryMs) || retryMs > 10_000) throw new Error("Discord 限流，请稍后重试");
        nextApiAt = Date.now() + retryMs;
        continue;
      }
      if (!response.ok) throw new Error(`Discord API ${response.status}${json?.code ? ` (code=${json.code})` : ""}: ${String(json?.message || "request failed").slice(0, 160)}`);
      return json;
    }
  });
}

async function sendToChannel(channelId: string, text: string, markup?: unknown, messageId?: string) {
  if (!snowflake(channelId) || (messageId && !snowflake(messageId))) throw new Error("Invalid Discord message identity");
  const plain = discordText(text);
  // Preserve all output, with interactive controls on the last message. Each
  // request stays inside Discord's 2,000-character message limit.
  const chunks = Array.from({ length: Math.max(1, Math.ceil(plain.length / 1900)) }, (_, index) => plain.slice(index * 1900, index * 1900 + 1900));
  let result: any;
  const messageIds: string[] = [];
  for (let index = 0; index < chunks.length; index++) {
    const editing = index === 0 && messageId;
    result = await discordRequest(`/channels/${channelId}/messages${editing ? `/${messageId}` : ""}`, editing ? "PATCH" : "POST", {
      content: chunks[index] || " ", allowed_mentions: { parse: [] }, components: index === chunks.length - 1 ? discordComponents(markup) : [],
    });
    messageIds.push(String(result.id));
  }
  return { message_id: String(result.id), message_ids: messageIds };
}
export async function sendDiscordMessage(userId: string, text: string) {
  if (!snowflake(userId)) throw new Error("Invalid Discord user identity");
  const channel = await discordRequest("/users/@me/channels", "POST", { recipient_id: userId });
  return sendToChannel(String(channel.id), text);
}
export async function discordBotApi(method: string, body: Record<string, unknown> = {}) {
  const channelId = String(body.chat_id || "");
  if (method === "sendMessage") return sendToChannel(channelId, String(body.text || ""), body.reply_markup);
  if (method === "editMessageText") return sendToChannel(channelId, String(body.text || ""), body.reply_markup, String(body.message_id || ""));
  if (method === "deleteMessage") {
    if (!snowflake(channelId) || !snowflake(String(body.message_id))) throw new Error("Invalid Discord message identity");
    return discordRequest(`/channels/${channelId}/messages/${body.message_id}`, "DELETE");
  }
  if (method === "sendChatAction") return discordRequest(`/channels/${channelId}/typing`, "POST");
  if (method === "answerCallbackQuery") return true; // Gateway callback acknowledged before queued business work.
  throw new Error(`Unsupported Discord bot operation: ${method}`);
}

export function admitDiscordEvent(id: string, actorId: string, now = Date.now()) {
  for (const [key, expiresAt] of seen) if (expiresAt <= now) seen.delete(key);
  for (const [key, value] of actorRequests) if (value.until <= now) actorRequests.delete(key);
  if (seen.has(id) || updates.pendingCount >= 128) return false;
  const counter = actorRequests.get(actorId) || { count: 0, until: now + 60_000 };
  if (counter.count >= 30) return false;
  if (seen.size >= 2000) seen.delete(seen.keys().next().value!);
  if (!actorRequests.has(actorId) && actorRequests.size >= 2000) return false;
  counter.count++;
  actorRequests.set(actorId, counter);
  seen.set(id, now + 300_000);
  return true;
}
async function acknowledgeInteraction(interaction: any, type: number, content?: string) {
  if (!snowflake(interaction.id) || typeof interaction.token !== "string" || !/^[A-Za-z0-9._-]{10,256}$/.test(interaction.token)) return;
  const response = await fetch(`${REST_BASE}/interactions/${interaction.id}/${interaction.token}/callback`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type, ...(content ? { data: { content, flags: 64, allowed_mentions: { parse: [] } } } : {}) }),
    signal: AbortSignal.timeout(2000),
  });
  if (!response.ok) throw new Error(`Discord interaction acknowledgement failed: ${response.status}`);
}
export async function handleDiscordGatewayDispatch(event: string, data: any) {
  if (event !== "MESSAGE_CREATE" && event !== "INTERACTION_CREATE") return;
  const settings = await getNotificationSettings("discord");
  if (seamlessBackgroundPaused() || !settings.active || !data) return;
  if (event === "INTERACTION_CREATE" && data.application_id !== settings.botId) return;
  const actor = event === "MESSAGE_CREATE" ? data.author : data.user;
  // Guild/group messages and bot messages never enter account/private handlers.
  if (data.guild_id || !actor || actor.bot || !snowflake(actor.id) || !snowflake(data.channel_id) || !snowflake(data.id)) {
    if (event === "INTERACTION_CREATE" && data.guild_id) await acknowledgeInteraction(data, 4, "请在机器人私聊中使用 ForwardX 指令，账号信息不会发送到公共频道。");
    return;
  }
  if (!admitDiscordEvent(data.id, actor.id)) {
    if (event === "INTERACTION_CREATE") await acknowledgeInteraction(data, 4, "操作过于频繁，请稍后重试。");
    return;
  }
  const from = { id: actor.id, username: actor.username, first_name: actor.global_name || actor.username };
  let update: any;
  if (event === "MESSAGE_CREATE") {
    if (typeof data.content !== "string" || !data.content.trim() || data.content.length > 4000) return;
    update = { message: { message_id: data.id, chat: { id: data.channel_id, type: "private" }, from, text: data.content } };
  } else if (data.type === 3 && data.message && snowflake(data.message.id) && String(data.data?.custom_id || "").startsWith("fx:")) {
    await acknowledgeInteraction(data, 6);
    update = { callback_query: { id: data.id, from, message: { message_id: data.message.id, chat: { id: data.channel_id, type: "private" } }, data: data.data.custom_id } };
  } else if (data.type === 2 && TELEGRAM_BOT_COMMANDS.some((command) => command.command === data.data?.name)) {
    await acknowledgeInteraction(data, 4, "正在处理，结果会发送到当前私聊。");
    const args = String(data.data?.options?.find((option: any) => option.name === "args")?.value || "").slice(0, 4000);
    update = { message: { message_id: data.id, chat: { id: data.channel_id, type: "private" }, from, text: `/${data.data.name} ${args}` } };
  } else return;
  void updates.enqueue(`discord:${data.channel_id}`, () => processDiscordBotUpdate(update, discordBotApi))
    .catch((error) => console.warn(`[Discord] update failed: ${error instanceof Error ? error.message : "unknown error"}`));
}

export async function refreshDiscordBotProfile() {
  const user = await discordRequest("/users/@me", "GET", undefined, true);
  if (!user?.bot || !snowflake(user.id)) throw new Error("请配置 Discord Bot Token，而不是用户 Token 或 Webhook");
  await setSettings({ discordBotUsername: user.username, discordBotId: user.id });
  await discordRequest(`/applications/${user.id}/commands`, "PUT", TELEGRAM_BOT_COMMANDS.map((command) => ({
    name: command.command, description: (command.command === "webapp" ? "获取一次性网页登录链接" : discordText(command.description)).slice(0, 100), contexts: [1],
    options: [{ type: 3, name: "args", description: "指令参数，例如绑定码、规则 ID 或自然语言问题", required: false }],
  })), true);
  return { id: user.id, username: user.username };
}
export function discordConnectionStatus() { return { connected, queued: updates.pendingCount }; }
function closeGateway() {
  generation++;
  if (heartbeat) clearInterval(heartbeat);
  heartbeat = null;
  gateway?.close();
  gateway = null;
  connected = false;
  connectingAt = 0;
}
async function reconcileDiscordGateway() {
  if (reconciling) return;
  reconciling = true;
  try {
    const configurationGeneration = generation;
    const settings = await getNotificationSettings("discord");
    if (configurationGeneration !== generation) return;
    if (!settings.active || seamlessBackgroundPaused()) {
      closeGateway(); activeToken = "";
      if (!settings.active && watchdog) { clearInterval(watchdog); watchdog = null; }
      return;
    }
    if (activeToken !== settings.token) {
      closeGateway(); activeToken = settings.token; sessionId = ""; sequence = null; failures = 0; reconnectAt = 0;
      const configurationGeneration = generation;
      await refreshDiscordBotProfile().catch(() => console.warn("[Discord] Bot identity/commands could not be synchronized; retry in notification settings"));
      if (configurationGeneration !== generation) return;
    }
    if (gateway && !connected && Date.now() - connectingAt > 30_000) {
      closeGateway();
      reconnectAt = Date.now() + 10_000;
      console.warn("[Discord] Gateway handshake timed out; retry scheduled");
    }
    if (gateway || blockedToken === activeToken || Date.now() < reconnectAt) return;
    const epoch = ++generation;
    const socket = new WebSocket(GATEWAY);
    gateway = socket;
    connectingAt = Date.now();
    const send = (payload: unknown) => { if (gateway === socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload)); };
    socket.addEventListener("message", (message) => {
      if (epoch !== generation || typeof message.data !== "string" || message.data.length > 256_000) return;
      let payload: any;
      try { payload = JSON.parse(message.data); } catch { return; }
      if (typeof payload.s === "number") sequence = payload.s;
      if (payload.op === 10) {
        if (heartbeat) clearInterval(heartbeat);
        const interval = Number(payload.d?.heartbeat_interval);
        if (!Number.isFinite(interval) || interval < 1000 || interval > 120_000) { socket.close(); return; }
        acknowledged = true;
        heartbeat = setInterval(() => {
          if (!acknowledged) {
            closeGateway();
            reconnectAt = Date.now() + Math.min(60_000, 2000 * 2 ** Math.min(++failures, 5));
            console.warn("[Discord] Gateway heartbeat not acknowledged; reconnect scheduled");
            return;
          }
          acknowledged = false; send({ op: 1, d: sequence });
        }, interval);
        heartbeat.unref?.();
        if (sessionId) send({ op: 6, d: { token: activeToken, session_id: sessionId, seq: sequence } });
        else send({ op: 2, d: { token: activeToken, intents: 4096, properties: { os: process.platform, browser: "ForwardX", device: "ForwardX" } } });
      } else if (payload.op === 11) acknowledged = true;
      else if (payload.op === 1) send({ op: 1, d: sequence });
      else if (payload.op === 7) socket.close();
      else if (payload.op === 9) { sessionId = ""; sequence = null; socket.close(); }
      else if (payload.op === 0) {
        if (payload.t === "READY") { sessionId = String(payload.d.session_id || ""); connected = true; failures = 0; console.info("[Discord] Bot gateway connected"); }
        if (payload.t === "RESUMED") { connected = true; failures = 0; }
        void handleDiscordGatewayDispatch(payload.t, payload.d).catch((error) => console.warn(`[Discord] event rejected: ${error instanceof Error ? error.message : "unknown error"}`));
      }
    });
    socket.addEventListener("error", () => { if (epoch === generation) socket.close(); });
    socket.addEventListener("close", (event) => {
      if (epoch !== generation) return;
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = null; gateway = null; connected = false;
      if ([4004, 4010, 4011, 4013, 4014].includes(event.code)) blockedToken = activeToken;
      if ([4007, 4009].includes(event.code)) { sessionId = ""; sequence = null; }
      reconnectAt = Date.now() + Math.min(60_000, 2000 * 2 ** Math.min(++failures, 5)) + Math.random() * 1000;
      console.warn(`[Discord] Gateway disconnected code=${event.code}; ${blockedToken === activeToken ? "check bot configuration" : "reconnect scheduled"}`);
    });
  } finally { reconciling = false; }
}
export async function startDiscordBot() {
  if (!watchdog) {
    watchdog = setInterval(() => { void reconcileDiscordGateway().catch(() => {
      if (Date.now() - lastConfigurationWarning < 60_000) return;
      lastConfigurationWarning = Date.now();
      console.warn("[Discord] Gateway configuration temporarily unavailable");
    }); }, 5000);
    watchdog.unref?.();
  }
  await reconcileDiscordGateway();
}
export function resetDiscordBot() { closeGateway(); activeToken = ""; blockedToken = ""; sessionId = ""; sequence = null; reconnectAt = 0; }
export function stopDiscordBot() { if (watchdog) clearInterval(watchdog); watchdog = null; resetDiscordBot(); }
