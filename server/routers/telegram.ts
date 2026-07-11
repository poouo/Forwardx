import { z } from "zod";
import jwt from "jsonwebtoken";
import { createHash, createHmac, timingSafeEqual } from "crypto";
import { ACCOUNT_DISABLED_ERR_MSG, COOKIE_NAME } from "../../shared/const";
import { getSessionCookieOptions } from "../_core/cookies";
import { adminProcedure, protectedProcedure, publicProcedure, router } from "../_core/trpc";
import { ENV } from "../env";
import { TRPCError } from "@trpc/server";
import * as db from "../db";
import { sendTelegramMessage } from "../telegramBot";
import { createMobileTelegramLoginChallenge, takeMobileTelegramLoginChallenge } from "../telegramMobileLogin";
import { consumeTelegramWebAppLoginChallenge } from "../telegramWebAppLogin";
import { SESSION_TOKEN_TTL_MS, SESSION_TOKEN_TTL_SECONDS, type SessionKind } from "../session";
import { createAuthSession } from "../repositories/sessionRepository";

const BIND_CODE_TTL_MS = 5 * 60 * 1000;
const MOBILE_LOGIN_TTL_MS = 5 * 60 * 1000;
const TELEGRAM_WEBAPP_LOGIN_MAX_AGE_SECONDS = 5 * 60;
const TELEGRAM_WEBAPP_REPLAY_TTL_MS = 10 * 60 * 1000;
const usedTelegramWebAppLogins = new Map<string, number>();

function randomCode(length = 24) {
  let out = "";
  while (out.length < length) out += crypto.randomUUID().replace(/-/g, "");
  return out.slice(0, length).toUpperCase();
}

function isMobileLoginCode(code: string) {
  return /^APP[A-Z0-9]{20,64}$/.test(code.trim().toUpperCase());
}

function maskToken(token: string) {
  if (!token) return "";
  if (token.length <= 12) return `${token.slice(0, 4)}...`;
  return `${token.slice(0, 8)}...${token.slice(-4)}`;
}

function compareByteOrder(a: string, b: string) {
  return a < b ? -1 : a > b ? 1 : 0;
}

async function getTelegramRuntimeSettings() {
  const settings = await db.getAllSettings();
  const envToken = ENV.telegramBotToken.trim();
  const dbToken = String(settings.telegramBotToken || "").trim();
  const token = envToken || dbToken;
  const enabled = settings.telegramBotEnabled === "true" || (!!envToken && settings.telegramBotEnabled !== "false");
  return {
    token,
    enabled,
    configured: !!token,
    botUsername: settings.telegramBotUsername || "",
    panelPublicUrl: String(settings.panelPublicUrl || "").trim().replace(/\/+$/, ""),
    polling: ENV.telegramBotPolling,
    tokenSource: envToken ? "env" : dbToken ? "database" : "none",
    tokenMasked: maskToken(token),
  };
}

async function getTelegramSettings() {
  const { token: _token, ...settings } = await getTelegramRuntimeSettings();
  return settings;
}

const telegramWidgetLoginSchema = z.object({
  id: z.union([z.string(), z.number()]),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  username: z.string().optional(),
  photo_url: z.string().optional(),
  auth_date: z.union([z.string(), z.number()]),
  hash: z.string().min(1),
}).passthrough();

const telegramWebAppLoginSchema = z.object({
  initData: z.string().min(16).max(8192),
  challenge: z.string().min(16).max(192).optional(),
  mobile: z.boolean().optional(),
});

type TelegramWebAppAuthPayload = {
  hash: string;
  authDate: number;
  queryId: string;
  telegramId: string;
  username: string | null;
  firstName: string | null;
  lastName: string | null;
};

function pruneUsedTelegramWebAppLogins(now = Date.now()) {
  for (const [key, expiresAt] of usedTelegramWebAppLogins.entries()) {
    if (!expiresAt || expiresAt <= now) usedTelegramWebAppLogins.delete(key);
  }
}

function consumeTelegramWebAppLoginOnce(replayKey: string, ttlMs = TELEGRAM_WEBAPP_REPLAY_TTL_MS) {
  const normalized = String(replayKey || "").trim().toLowerCase();
  if (!normalized) return false;
  pruneUsedTelegramWebAppLogins();
  if (usedTelegramWebAppLogins.has(normalized)) return false;
  usedTelegramWebAppLogins.set(normalized, Date.now() + ttlMs);
  return true;
}

function parseTelegramWebAppUser(rawUser: string | null) {
  if (!rawUser) return null;
  let parsed: any = null;
  try {
    parsed = JSON.parse(rawUser);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const telegramId = String(parsed.id ?? "").trim();
  if (!telegramId) return null;
  return {
    telegramId,
    username: parsed.username ? String(parsed.username) : null,
    firstName: parsed.first_name ? String(parsed.first_name) : null,
    lastName: parsed.last_name ? String(parsed.last_name) : null,
  };
}

function verifyTelegramWebAppLogin(initData: string, token: string): TelegramWebAppAuthPayload | null {
  const normalized = String(initData || "").trim();
  if (!normalized) return null;
  const params = new URLSearchParams(normalized);
  const hash = String(params.get("hash") || "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(hash)) return null;
  const queryId = String(params.get("query_id") || "").trim();
  if (!/^[a-z0-9_-]{8,128}$/i.test(queryId)) return null;
  const authDate = Number(params.get("auth_date") || 0);
  if (!Number.isFinite(authDate) || authDate <= 0) return null;
  const now = Math.floor(Date.now() / 1000);
  if (authDate > now + 30) return null;
  if (now - authDate > TELEGRAM_WEBAPP_LOGIN_MAX_AGE_SECONDS) return null;
  const parsedUser = parseTelegramWebAppUser(params.get("user"));
  if (!parsedUser) return null;

  const dataCheckString = Array.from(params.entries())
    .filter(([key]) => key !== "hash")
    .sort(([a], [b]) => compareByteOrder(a, b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  const actual = createHmac("sha256", secret).update(dataCheckString).digest("hex").toLowerCase();
  const expected = Buffer.from(hash, "hex");
  const current = Buffer.from(actual, "hex");
  if (expected.length !== current.length || !timingSafeEqual(expected, current)) return null;

  return {
    hash,
    authDate,
    queryId,
    ...parsedUser,
  };
}

function verifyTelegramWidgetLogin(payload: z.infer<typeof telegramWidgetLoginSchema>, token: string) {
  const authDate = Number(payload.auth_date);
  if (!Number.isFinite(authDate) || authDate <= 0) return false;
  if (Date.now() / 1000 - authDate > 24 * 60 * 60) return false;

  const data = payload as Record<string, unknown>;
  const checkString = Object.keys(data)
    .filter((key) => key !== "hash" && data[key] !== undefined && data[key] !== null)
    .sort()
    .map((key) => `${key}=${String(data[key])}`)
    .join("\n");
  const secret = createHash("sha256").update(token).digest();
  const expected = Buffer.from(String(payload.hash), "hex");
  const actual = Buffer.from(createHmac("sha256", secret).update(checkString).digest("hex"), "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

async function issueTelegramSession(ctx: any, user: any, sessionKind: SessionKind, mobile?: boolean) {
  if (user?.accountEnabled === false) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: ACCOUNT_DISABLED_ERR_MSG });
  }
  const sid = crypto.randomUUID().replace(/-/g, "").slice(0, 24);
  await createAuthSession({
    userId: user.id,
    sid,
    kind: sessionKind,
    expiresAt: new Date(Date.now() + SESSION_TOKEN_TTL_MS),
  });
  const token = jwt.sign({ userId: user.id, sid, kind: sessionKind }, ENV.cookieSecret, { expiresIn: SESSION_TOKEN_TTL_SECONDS });
  ctx.res.cookie(COOKIE_NAME, token, getSessionCookieOptions(ctx.req));
  const { password, ...safeUser } = user;
  return { ...safeUser, mobileToken: mobile ? token : null };
}

export const telegramRouter = router({
  loginStatus: publicProcedure.query(async () => {
    const settings = await getTelegramSettings();
    return {
      enabled: settings.enabled,
      configured: settings.configured,
      botUsername: settings.botUsername,
      panelPublicUrl: settings.panelPublicUrl,
    };
  }),

  status: protectedProcedure.query(async ({ ctx }) => {
    const settings = await getTelegramSettings();
    const user = await db.getUserById(ctx.user.id);
    let pendingBind: {
      code: string;
      expiresAt: Date;
      expiresInSeconds: number;
      botUsername: string;
      configured: boolean;
      enabled: boolean;
    } | null = null;
    if (!user?.telegramId && user?.telegramBindCode && user.telegramBindCodeExpiresAt) {
      const expiresAt = new Date(user.telegramBindCodeExpiresAt);
      const expiresInSeconds = Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
      if (expiresInSeconds > 0) {
        pendingBind = {
          code: user.telegramBindCode,
          expiresAt,
          expiresInSeconds,
          botUsername: settings.botUsername,
          configured: settings.configured,
          enabled: settings.enabled,
        };
      } else {
        await db.clearTelegramBindCode(user.id);
      }
    }
    return {
      enabled: settings.enabled,
      configured: settings.configured,
      botUsername: settings.botUsername,
      polling: settings.polling,
      bound: !!user?.telegramId,
      announcementSubscribed: !!user?.telegramAnnouncementSubscribed,
      pendingBind,
      account: user?.telegramId
        ? {
            id: user.telegramId,
            username: user.telegramUsername,
            firstName: user.telegramFirstName,
            lastName: user.telegramLastName,
            linkedAt: user.telegramLinkedAt,
            lastSeenAt: user.telegramLastSeenAt,
          }
        : null,
    };
  }),

  adminStatus: adminProcedure.query(async () => {
    return getTelegramSettings();
  }),

  testSend: adminProcedure.mutation(async ({ ctx }) => {
    const settings = await getTelegramSettings();
    if (!settings.enabled || !settings.configured) {
      throw new Error("Telegram 机器人尚未启用或未配置");
    }
    const user = await db.getUserById(ctx.user.id);
    if (!user?.telegramId) {
      throw new Error("当前管理员尚未绑定 Telegram，无法发送测试消息");
    }
    const displayName = user.name || user.username || `#${user.id}`;
    const botLabel = settings.botUsername ? `@${settings.botUsername}` : "当前机器人";
    await sendTelegramMessage(
      user.telegramId,
      [
        "ForwardX Telegram 测试消息",
        "",
        `接收用户：${displayName}`,
        `机器人：${botLabel}`,
        `时间：${new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}`,
      ].join("\n"),
    );
    return { success: true };
  }),

  createBindCode: protectedProcedure.mutation(async ({ ctx }) => {
    const settings = await getTelegramSettings();
    if (!settings.configured || !settings.enabled) {
      throw new Error("管理员尚未启用 Telegram 机器人");
    }
    const code = `TG-${randomCode(12)}`;
    const expiresAt = new Date(Date.now() + BIND_CODE_TTL_MS);
    await db.createTelegramBindCode(ctx.user.id, code, expiresAt);
    return {
      code,
      expiresAt,
      expiresInSeconds: Math.floor(BIND_CODE_TTL_MS / 1000),
      botUsername: settings.botUsername,
      configured: settings.configured,
      enabled: settings.enabled,
    };
  }),

  unbind: protectedProcedure.mutation(async ({ ctx }) => {
    await db.unbindTelegramAccount(ctx.user.id);
    return { success: true };
  }),

  startMobileLogin: publicProcedure.mutation(async () => {
    const settings = await getTelegramSettings();
    if (!settings.enabled || !settings.configured || !settings.botUsername) {
      throw new Error("Telegram 登录尚未启用");
    }
    const code = `APP${randomCode(28)}`;
    createMobileTelegramLoginChallenge(code, MOBILE_LOGIN_TTL_MS);
    const botUsername = settings.botUsername.trim().replace(/^@/, "");
    return {
      code,
      expiresInSeconds: Math.floor(MOBILE_LOGIN_TTL_MS / 1000),
      botUsername,
      telegramUrl: `https://t.me/${botUsername}?start=${encodeURIComponent(code)}`,
    };
  }),

  mobileLoginStatus: publicProcedure
    .input(z.object({ code: z.string().min(8).max(64) }))
    .mutation(async ({ input, ctx }) => {
      const code = input.code.trim().toUpperCase();
      if (!isMobileLoginCode(code)) return { status: "pending" as const };
      const user = await db.consumeTelegramLoginCode(code);
      if (!user) return { status: "pending" as const };
      takeMobileTelegramLoginChallenge(code);
      return { status: "success" as const, ...await issueTelegramSession(ctx, user, "telegram", true) };
    }),

  login: publicProcedure
    .input(z.object({ code: z.string().min(8).max(64), mobile: z.boolean().optional() }))
    .mutation(async ({ input, ctx }) => {
      const user = await db.consumeTelegramLoginCode(input.code.trim().toUpperCase());
      if (!user) throw new Error("Telegram 登录码无效或已过期");
      return await issueTelegramSession(ctx, user, "telegram", input.mobile);
    }),

  loginWithWidget: publicProcedure
    .input(telegramWidgetLoginSchema)
    .mutation(async ({ input, ctx }) => {
      const settings = await getTelegramRuntimeSettings();
      if (!settings.enabled || !settings.configured || !settings.token) {
        throw new Error("TELEGRAM_LOGIN_DISABLED");
      }
      if (!verifyTelegramWidgetLogin(input, settings.token)) {
        throw new Error("Telegram 登录验证失败，请重新尝试");
      }

      const telegramId = String(input.id);
      const user = await db.getUserByTelegramId(telegramId);
      if (!user) {
        throw new Error("当前 Telegram 未绑定任何账户，请先使用账号密码登录后绑定 Telegram");
      }
      await db.updateTelegramLastSeen(telegramId, {
        username: input.username || null,
        firstName: input.first_name || null,
        lastName: input.last_name || null,
      });
      return await issueTelegramSession(ctx, user, "telegram");
    }),

  loginWithWebApp: publicProcedure
    .input(telegramWebAppLoginSchema)
    .mutation(async ({ input, ctx }) => {
      const settings = await getTelegramRuntimeSettings();
      if (!settings.enabled || !settings.configured || !settings.token) {
        throw new Error("TELEGRAM_LOGIN_DISABLED");
      }
      const payload = verifyTelegramWebAppLogin(input.initData, settings.token);
      if (!payload) {
        throw new Error("TELEGRAM_WEBAPP_VERIFY_FAILED");
      }
      if (input.challenge) {
        const challengeResult = consumeTelegramWebAppLoginChallenge(input.challenge, payload.telegramId);
        if (challengeResult === "mismatch") {
          throw new Error("TELEGRAM_WEBAPP_CHALLENGE_INVALID");
        }
      }
      const replayKey = `${payload.queryId}:${payload.hash}`;
      if (!consumeTelegramWebAppLoginOnce(replayKey)) {
        throw new Error("TELEGRAM_WEBAPP_REPLAYED");
      }

      const user = await db.getUserByTelegramId(payload.telegramId);
      if (!user) {
        throw new Error("TELEGRAM_NOT_BOUND");
      }
      await db.updateTelegramLastSeen(payload.telegramId, {
        username: payload.username,
        firstName: payload.firstName,
        lastName: payload.lastName,
      });
      return await issueTelegramSession(ctx, user, "telegram", input.mobile);
    }),
});

