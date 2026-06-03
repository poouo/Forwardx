import { z } from "zod";
import { nanoid } from "nanoid";
import jwt from "jsonwebtoken";
import { ACCOUNT_DISABLED_ERR_MSG, COOKIE_NAME } from "../../shared/const";
import { TRPCError } from "@trpc/server";
import { getSessionCookieOptions } from "../_core/cookies";
import { publicProcedure, protectedProcedure, router } from "../_core/trpc";
import { ENV } from "../env";
import * as db from "../db";
import { getEmailConfig, sendVerificationCode } from "../email";
import { createTotpSecret, createTotpUri, verifyTotpToken } from "../totp";
import { clearTwoFactorChallenge, createTwoFactorChallenge, getTwoFactorChallenge, recordTwoFactorChallengeFailure } from "../twoFactorChallenges";
import { clearTwoFactorSetupChallenge, clearTwoFactorSetupChallengesForUser, createTwoFactorSetupChallenge, getTwoFactorSetupChallenge } from "../twoFactorSetupChallenges";

interface CaptchaEntry {
  question: string;
  answer: number;
  expiresAt: number;
}

const captchaStore = new Map<string, CaptchaEntry>();
type LoginFailEntry = { count: number; lastFailAt: number };
const loginFailStore = new Map<string, LoginFailEntry>();
const loginIpFailStore = new Map<string, LoginFailEntry>();
const emailCodeStore = new Map<string, { code: string; expiresAt: number; lastSentAt: number; attempts: number }>();
const emailSendIpStore = new Map<string, LoginFailEntry>();
const LOGIN_FAIL_THRESHOLD = 1;
const LOGIN_FAIL_WINDOW_MS = 30 * 60 * 1000;
const LOGIN_BLOCK_MS = 15 * 60 * 1000;
const LOGIN_BLOCK_THRESHOLD_PER_ACCOUNT = 8;
const LOGIN_BLOCK_THRESHOLD_PER_IP = 40;
const EMAIL_CODE_TTL_MS = 5 * 60 * 1000;
const EMAIL_CODE_COOLDOWN_MS = 60 * 1000;
const EMAIL_CODE_MAX_ATTEMPTS = 5;
const EMAIL_CODE_IP_WINDOW_MS = 30 * 60 * 1000;
const EMAIL_CODE_IP_MAX_PER_WINDOW = 10;
const TWO_FACTOR_ISSUER = "ForwardX";
const DISPLAY_NAME_MAX_LENGTH = 24;

function generateCaptcha(): { captchaId: string; question: string } {
  const a = Math.floor(Math.random() * 20) + 1;
  const b = Math.floor(Math.random() * 20) + 1;
  const ops = [
    { symbol: "+", fn: (x: number, y: number) => x + y },
    { symbol: "-", fn: (x: number, y: number) => x - y },
  ];
  const op = ops[Math.floor(Math.random() * ops.length)];
  const answer = op.fn(a, b);
  const question = `${a} ${op.symbol} ${b} = ?`;
  const captchaId = nanoid(16);
  captchaStore.set(captchaId, { question, answer, expiresAt: Date.now() + 5 * 60 * 1000 });
  for (const [key, value] of captchaStore) {
    if (value.expiresAt < Date.now()) captchaStore.delete(key);
  }
  return { captchaId, question };
}

function verifyCaptcha(captchaId: string, captchaAnswer: number): boolean {
  const entry = captchaStore.get(captchaId);
  if (!entry) return false;
  captchaStore.delete(captchaId);
  if (entry.expiresAt < Date.now()) return false;
  return entry.answer === captchaAnswer;
}

function getLoginFailKey(ip: string, username: string) {
  return `${ip}:${username}`;
}

function getActiveLoginFailEntry(store: Map<string, LoginFailEntry>, key: string) {
  const entry = store.get(key);
  if (!entry) return null;
  const now = Date.now();
  if (entry && now - entry.lastFailAt < LOGIN_FAIL_WINDOW_MS) {
    return entry;
  }
  store.delete(key);
  return null;
}

function recordFailInStore(store: Map<string, LoginFailEntry>, key: string) {
  const entry = getActiveLoginFailEntry(store, key);
  const now = Date.now();
  if (entry) {
    entry.count += 1;
    entry.lastFailAt = now;
  } else {
    store.set(key, { count: 1, lastFailAt: now });
  }
}

function recordLoginFail(ip: string, username: string) {
  recordFailInStore(loginFailStore, getLoginFailKey(ip, username));
  recordFailInStore(loginIpFailStore, ip);
}

function needsCaptcha(ip: string, username: string): boolean {
  const entry = getActiveLoginFailEntry(loginFailStore, getLoginFailKey(ip, username));
  if (!entry) return false;
  return entry.count >= LOGIN_FAIL_THRESHOLD;
}

function loginRateLimitState(ip: string, username: string) {
  const now = Date.now();
  const checks = [
    { entry: getActiveLoginFailEntry(loginFailStore, getLoginFailKey(ip, username)), threshold: LOGIN_BLOCK_THRESHOLD_PER_ACCOUNT },
    { entry: getActiveLoginFailEntry(loginIpFailStore, ip), threshold: LOGIN_BLOCK_THRESHOLD_PER_IP },
  ];
  for (const check of checks) {
    const entry = check.entry;
    if (!entry || entry.count < check.threshold) continue;
    const retryAt = entry.lastFailAt + LOGIN_BLOCK_MS;
    if (retryAt > now) {
      return {
        limited: true,
        retryAfterSeconds: Math.max(1, Math.ceil((retryAt - now) / 1000)),
      };
    }
  }
  return { limited: false, retryAfterSeconds: 0 };
}

function clearLoginFail(ip: string, username: string) {
  loginFailStore.delete(getLoginFailKey(ip, username));
}

function recordEmailSend(ip: string) {
  const now = Date.now();
  const entry = emailSendIpStore.get(ip);
  if (entry && now - entry.lastFailAt < EMAIL_CODE_IP_WINDOW_MS) {
    entry.count += 1;
    entry.lastFailAt = now;
  } else {
    emailSendIpStore.set(ip, { count: 1, lastFailAt: now });
  }
}

function isEmailSendRateLimited(ip: string) {
  const entry = emailSendIpStore.get(ip);
  if (!entry) return false;
  if (Date.now() - entry.lastFailAt >= EMAIL_CODE_IP_WINDOW_MS) {
    emailSendIpStore.delete(ip);
    return false;
  }
  return entry.count >= EMAIL_CODE_IP_MAX_PER_WINDOW;
}

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

function maskIdentifier(value?: string | null) {
  const text = String(value || "").trim();
  if (!text) return "unknown";
  const [name, domain] = text.split("@");
  if (domain) {
    const visible = name.length <= 2 ? `${name[0] || "*"}*` : `${name.slice(0, 2)}***`;
    return `${visible}@${domain}`;
  }
  if (text.length <= 3) return `${text[0] || "*"}***`;
  return `${text.slice(0, 2)}***${text.slice(-1)}`;
}

function getRequestIp(ctx: { req: { ip?: string; socket: { remoteAddress?: string } } }) {
  return ctx.req.ip || ctx.req.socket.remoteAddress || "unknown";
}

function createLoginSession(ctx: any, user: any, mobile?: boolean) {
  if (user?.accountEnabled === false) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: ACCOUNT_DISABLED_ERR_MSG });
  }
  const token = jwt.sign({ userId: user.id }, ENV.cookieSecret, { expiresIn: "10d" });
  ctx.res.cookie(COOKIE_NAME, token, getSessionCookieOptions(ctx.req));
  const { password, twoFactorSecret: _twoFactorSecret, ...safeUser } = user;
  return { ...safeUser, mobileToken: mobile ? token : null };
}

function sanitizeUser(user: any) {
  const { password, twoFactorSecret: _twoFactorSecret, ...safeUser } = user;
  return safeUser;
}

function parseEmailWhitelist(value?: string | null) {
  const items = String(value || "")
    .split(/[,，]/)
    .map((item) => item.trim().toLowerCase().replace(/^@+/, "").replace(/\.+$/, ""))
    .filter(Boolean)
    .filter((item) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(item));
  return [...new Set(items)];
}

function ensureAllowedEmail(email: string, config: Awaited<ReturnType<typeof getEmailConfig>>) {
  const normalized = normalizeEmail(email);
  if (!z.string().email().safeParse(normalized).success) {
    throw new Error("邮箱格式不正确");
  }
  if (!config.whitelistEnabled) return normalized;
  const whitelist = parseEmailWhitelist(config.whitelist);
  if (!whitelist.length) return normalized;
  const domain = normalized.split("@")[1] || "";
  if (!whitelist.some((suffix) => domain === suffix || domain.endsWith(`.${suffix}`))) {
    throw new Error("该邮箱后缀不在注册白名单内");
  }
  return normalized;
}

function generateEmailCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function verifyEmailCode(email: string, code?: string) {
  const key = normalizeEmail(email);
  const entry = emailCodeStore.get(key);
  if (!entry) return false;
  if (entry.expiresAt < Date.now()) {
    emailCodeStore.delete(key);
    return false;
  }
  const ok = entry.code === String(code || "").trim();
  if (ok) emailCodeStore.delete(key);
  else {
    entry.attempts += 1;
    if (entry.attempts >= EMAIL_CODE_MAX_ATTEMPTS) emailCodeStore.delete(key);
  }
  return ok;
}

export const authRouter = router({
  me: publicProcedure.query(({ ctx }) => {
    if (!ctx.user) return null;
    if ((ctx.user as any).accountEnabled === false) {
      ctx.res.clearCookie(COOKIE_NAME, { ...getSessionCookieOptions(ctx.req), maxAge: -1 });
      throw new TRPCError({ code: "UNAUTHORIZED", message: ACCOUNT_DISABLED_ERR_MSG });
    }
    return sanitizeUser(ctx.user);
  }),

  getCaptcha: publicProcedure.query(() => {
    return generateCaptcha();
  }),

  emailConfig: publicProcedure.query(async () => {
    const config = await getEmailConfig();
    const registrationEnabled = (await db.getSetting("registrationEnabled")) !== "false";
    return { verifyRegistration: config.enabled && config.verifyRegistration, registrationEnabled };
  }),

  sendEmailCode: publicProcedure
    .input(z.object({ email: z.string().email("邮箱格式不正确") }))
    .mutation(async ({ input, ctx }) => {
      const registrationEnabled = (await db.getSetting("registrationEnabled")) !== "false";
      if (!registrationEnabled) {
        console.warn(`[Auth] Email verification rejected registration disabled target=${maskIdentifier(input.email)} ip=${getRequestIp(ctx)}`);
        throw new Error("当前注册未开放，请联系管理员");
      }
      const config = await getEmailConfig();
      if (!config.enabled || !config.verifyRegistration) {
        console.info(`[Auth] Email verification skipped ip=${getRequestIp(ctx)}`);
        return { skipped: true };
      }
      const ip = getRequestIp(ctx);
      if (isEmailSendRateLimited(ip)) {
        console.warn(`[Auth] Email verification rate limited target=${maskIdentifier(input.email)} ip=${ip}`);
        throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "EMAIL_RATE_LIMITED" });
      }
      const email = ensureAllowedEmail(input.email, config);
      const existing = emailCodeStore.get(email);
      if (existing?.lastSentAt && Date.now() - existing.lastSentAt < EMAIL_CODE_COOLDOWN_MS) {
        throw new Error("验证码发送过于频繁，请稍后再试");
      }
      const code = generateEmailCode();
      await sendVerificationCode(email, code);
      recordEmailSend(ip);
      emailCodeStore.set(email, { code, expiresAt: Date.now() + EMAIL_CODE_TTL_MS, lastSentAt: Date.now(), attempts: 0 });
      console.info(`[Auth] Verification email sent target=${maskIdentifier(email)} ip=${ip}`);
      return { success: true, expiresInSeconds: 300 };
    }),

  needsCaptcha: publicProcedure
    .input(z.object({ username: z.string() }))
    .query(({ input, ctx }) => {
      const ip = ctx.req.ip || ctx.req.socket.remoteAddress || "unknown";
      return { required: needsCaptcha(ip, input.username) };
    }),

  login: publicProcedure
    .input(z.object({
      username: z.string().min(1, "请输入用户名"),
      password: z.string().min(1, "请输入密码"),
      captchaId: z.string().optional(),
      captchaAnswer: z.number().optional(),
      mobile: z.boolean().optional(),
      twoFactorCode: z.string().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const ip = ctx.req.ip || ctx.req.socket.remoteAddress || "unknown";
      const limited = loginRateLimitState(ip, input.username);
      if (limited.limited) {
        console.warn(`[Auth] Login rate limited username=${maskIdentifier(input.username)} ip=${ip} retryAfter=${limited.retryAfterSeconds}s`);
        throw new TRPCError({
          code: "TOO_MANY_REQUESTS",
          message: `LOGIN_RATE_LIMITED:${Math.ceil(limited.retryAfterSeconds / 60)}`,
        });
      }

      if (needsCaptcha(ip, input.username)) {
        if (!input.captchaId || input.captchaAnswer === undefined) {
          console.warn(`[Auth] Login requires captcha username=${maskIdentifier(input.username)} ip=${ip}`);
          throw new Error("CAPTCHA_REQUIRED");
        }
        if (!verifyCaptcha(input.captchaId, input.captchaAnswer)) {
          recordLoginFail(ip, input.username);
          console.warn(`[Auth] Login captcha failed username=${maskIdentifier(input.username)} ip=${ip}`);
          throw new Error("验证码错误，请重新输入");
        }
      }

      const user = await db.authenticateUser(input.username, input.password);
      if (!user) {
        recordLoginFail(ip, input.username);
        console.warn(`[Auth] Login failed username=${maskIdentifier(input.username)} ip=${ip}`);
        if (needsCaptcha(ip, input.username)) {
          throw new Error("CAPTCHA_REQUIRED_AFTER_FAIL");
        }
        throw new Error("用户名或密码错误");
      }
      if ((user as any).accountEnabled === false) {
        console.warn(`[Auth] Login rejected disabled userId=${user.id} username=${maskIdentifier(user.username)} ip=${ip}`);
        throw new TRPCError({ code: "UNAUTHORIZED", message: ACCOUNT_DISABLED_ERR_MSG });
      }

      const twoFactorEnabled = (await db.getSetting("twoFactorEnabled")) === "true";
      if (twoFactorEnabled && user.twoFactorEnabled && user.twoFactorSecret) {
        if (!input.twoFactorCode?.trim()) {
          const challenge = createTwoFactorChallenge({ userId: user.id, username: user.username, mobile: input.mobile });
          return { twoFactorRequired: true as const, username: user.username, ...challenge };
        }
        if (!verifyTotpToken(user.twoFactorSecret, input.twoFactorCode)) {
          recordLoginFail(ip, input.username);
          console.warn(`[Auth] Login 2FA failed userId=${user.id} username=${maskIdentifier(user.username)} ip=${ip}`);
          throw new Error("双重验证验证码错误或已过期");
        }
      }

      clearLoginFail(ip, input.username);
      console.info(`[Auth] Login success userId=${user.id} username=${maskIdentifier(user.username)} ip=${ip}`);
      return createLoginSession(ctx, user, input.mobile);
    }),

  verifyTwoFactorLogin: publicProcedure
    .input(z.object({
      challengeId: z.string().min(16),
      code: z.string().min(6).max(12),
      mobile: z.boolean().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const challenge = getTwoFactorChallenge(input.challengeId);
      if (!challenge) throw new Error("双重验证已过期，请重新登录");
      const user = await db.getUserById(challenge.userId);
      if (!user?.twoFactorEnabled || !user.twoFactorSecret) {
        throw new Error("当前账户未启用双重验证");
      }
      if ((user as any).accountEnabled === false) {
        throw new TRPCError({ code: "UNAUTHORIZED", message: ACCOUNT_DISABLED_ERR_MSG });
      }
      if (!verifyTotpToken(user.twoFactorSecret, input.code)) {
        console.warn(`[Auth] 2FA challenge failed userId=${user.id} ip=${getRequestIp(ctx)}`);
        recordTwoFactorChallengeFailure(input.challengeId);
        throw new Error("双重验证验证码错误或已过期");
      }
      clearTwoFactorChallenge(input.challengeId);
      clearLoginFail(getRequestIp(ctx), challenge.username);
      console.info(`[Auth] 2FA login success userId=${user.id} username=${maskIdentifier(user.username)} ip=${getRequestIp(ctx)}`);
      return createLoginSession(ctx, user, input.mobile ?? challenge.mobile);
    }),

  register: publicProcedure
    .input(z.object({
      username: z.string().email("用户名必须是邮箱格式").max(64),
      password: z.string().min(6, "密码至少6个字符"),
      name: z.string().trim().max(DISPLAY_NAME_MAX_LENGTH).optional(),
      email: z.string().email("邮箱格式不正确").optional(),
      emailCode: z.string().optional(),
      captchaId: z.string(),
      captchaAnswer: z.number(),
    }))
    .mutation(async ({ input, ctx }) => {
      const registrationEnabled = (await db.getSetting("registrationEnabled")) !== "false";
      if (!registrationEnabled) {
        console.warn(`[Auth] Register rejected disabled username=${maskIdentifier(input.username)} ip=${getRequestIp(ctx)}`);
        throw new Error("当前注册未开放，请联系管理员");
      }
      if (!verifyCaptcha(input.captchaId, input.captchaAnswer)) {
        console.warn(`[Auth] Register captcha failed username=${maskIdentifier(input.username)} ip=${getRequestIp(ctx)}`);
        throw new Error("验证码错误，请重新输入");
      }
      const emailConfig = await getEmailConfig();
      const usernameEmail = ensureAllowedEmail(input.username, emailConfig);
      const existing = await db.getUserByUsername(usernameEmail);
      if (existing) {
        console.warn(`[Auth] Register rejected duplicate username=${maskIdentifier(usernameEmail)} ip=${getRequestIp(ctx)}`);
        throw new Error("用户名已存在");
      }
      let verifiedEmail = false;
      if (emailConfig.enabled && emailConfig.verifyRegistration) {
        if (!input.email) throw new Error("请填写邮箱地址");
        const inputEmail = ensureAllowedEmail(input.email, emailConfig);
        if (inputEmail !== usernameEmail) throw new Error("验证邮箱必须和用户名邮箱一致");
        if (!verifyEmailCode(input.email, input.emailCode)) {
          throw new Error("邮箱验证码错误或已过期");
        }
        verifiedEmail = true;
      }
      const { captchaId: _captchaId, captchaAnswer: _captchaAnswer, emailCode: _emailCode, ...userData } = input;
      const id = await db.registerUser({
        ...userData,
        username: usernameEmail,
        email: usernameEmail,
        emailVerified: verifiedEmail,
        emailVerifiedAt: verifiedEmail ? new Date() : null,
      });
      console.info(`[Auth] Register success userId=${id} username=${maskIdentifier(usernameEmail)} emailVerified=${verifiedEmail} ip=${getRequestIp(ctx)}`);
      return { id, message: "注册成功，请联系管理员开通权限" };
    }),

  logout: publicProcedure.mutation(({ ctx }) => {
    const cookieOptions = getSessionCookieOptions(ctx.req);
    ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
    if (ctx.user) {
      console.info(`[Auth] Logout userId=${ctx.user.id} username=${maskIdentifier(ctx.user.username)} ip=${getRequestIp(ctx)}`);
    }
    return { success: true } as const;
  }),

  changePassword: protectedProcedure
    .input(z.object({
      oldPassword: z.string().min(1, "请输入当前密码"),
      newPassword: z.string().min(6, "新密码至少6个字符"),
    }))
    .mutation(async ({ input, ctx }) => {
      const success = await db.changeUserPassword(ctx.user.id, input.oldPassword, input.newPassword);
      if (!success) {
        console.warn(`[Auth] Change password failed userId=${ctx.user.id}`);
        throw new Error("当前密码错误");
      }
      console.info(`[Auth] Password changed userId=${ctx.user.id}`);
      return { success: true };
    }),

  twoFactorStatus: protectedProcedure.query(async ({ ctx }) => {
    const globalEnabled = (await db.getSetting("twoFactorEnabled")) === "true";
    return {
      globalEnabled,
      enabled: !!ctx.user.twoFactorEnabled,
      enabledAt: ctx.user.twoFactorEnabledAt,
    };
  }),

  beginTwoFactorSetup: protectedProcedure.mutation(async ({ ctx }) => {
    const globalEnabled = (await db.getSetting("twoFactorEnabled")) === "true";
    if (!globalEnabled) throw new Error("管理员尚未启用双重验证功能");
    const secret = createTotpSecret();
    clearTwoFactorSetupChallengesForUser(ctx.user.id);
    const challenge = createTwoFactorSetupChallenge({ userId: ctx.user.id, secret });
    return {
      secret,
      ...challenge,
      otpauthUrl: createTotpUri({
        issuer: TWO_FACTOR_ISSUER,
        account: ctx.user.username,
        secret,
      }),
    };
  }),

  enableTwoFactor: protectedProcedure
    .input(z.object({
      setupId: z.string().min(16),
      code: z.string().min(6).max(12),
      password: z.string().min(1, "请输入当前密码"),
    }))
    .mutation(async ({ input, ctx }) => {
      const globalEnabled = (await db.getSetting("twoFactorEnabled")) === "true";
      if (!globalEnabled) throw new Error("管理员尚未启用双重验证功能");
      if (!(await db.verifyUserPassword(ctx.user.id, input.password))) {
        throw new Error("当前密码错误");
      }
      const setup = getTwoFactorSetupChallenge(input.setupId, ctx.user.id);
      if (!setup) {
        throw new Error("双重验证二维码已过期，请重新生成后再绑定");
      }
      if (!verifyTotpToken(setup.secret, input.code)) {
        throw new Error("双重验证验证码错误或已过期");
      }
      const secret = setup.secret.trim().replace(/[\s=-]/g, "").toUpperCase();
      await db.enableUserTwoFactor(ctx.user.id, secret);
      clearTwoFactorSetupChallenge(input.setupId);
      clearTwoFactorSetupChallengesForUser(ctx.user.id);
      console.info(`[Auth] 2FA enabled userId=${ctx.user.id}`);
      return { success: true };
    }),

  disableTwoFactor: protectedProcedure
    .input(z.object({
      password: z.string().min(1, "请输入当前密码"),
      code: z.string().min(6).max(12).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      if (!(await db.verifyUserPassword(ctx.user.id, input.password))) {
        throw new Error("当前密码错误");
      }
      if (ctx.user.twoFactorSecret && !verifyTotpToken(ctx.user.twoFactorSecret, input.code || "")) {
        throw new Error("双重验证验证码错误或已过期");
      }
      await db.disableUserTwoFactor(ctx.user.id);
      console.info(`[Auth] 2FA disabled userId=${ctx.user.id}`);
      return { success: true };
    }),

  updateProfile: protectedProcedure
    .input(z.object({
      name: z.string().trim().min(1).max(DISPLAY_NAME_MAX_LENGTH).optional(),
      email: z.string().email().max(320).optional(),
      displayRemark: z.string().trim().max(24).nullable().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      await db.updateUserProfile(ctx.user.id, {
        ...input,
        name: input.name === undefined ? undefined : input.name.trim(),
        displayRemark: input.displayRemark === undefined ? undefined : input.displayRemark?.trim() || null,
      });
      console.info(`[Auth] Profile updated userId=${ctx.user.id}`);
      return { success: true };
    }),
});
