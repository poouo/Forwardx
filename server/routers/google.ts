import jwt from "jsonwebtoken";
import type { Request } from "express";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { users } from "../../drizzle/schema";
import { adminProcedure, protectedProcedure, publicProcedure, router } from "../_core/trpc";
import { getSessionCookieOptions } from "../_core/cookies";
import { getGoogleSettings, googleConfigured, googleSettingsSummary, GOOGLE_FLOW_COOKIE, GOOGLE_FLOW_TTL_MS,
  GOOGLE_SETTINGS_KEY, googleFlows, normalizeGoogleRedirectUri, GoogleAuthError } from "../googleOAuth";
import { setSetting } from "../repositories/settingsRepository";
import { getUserById, resetUserPassword, verifyUserPassword } from "../repositories/userRepository";
import { authRateLimitState, recordTwoFactorFailure } from "../authRateLimit";
import { getDb } from "../dbRuntime";
import { ENV } from "../env";
import { withKeyedTaskLock } from "../keyedTaskLock";
import { issueLoginSession } from "./auth";

export const GOOGLE_RESULT_COOKIE = "forwardx_google_result";
export const GOOGLE_RECENT_COOKIE = "forwardx_google_recent";
export function googleClearCookieOptions(req: Request) {
  const { maxAge: _maxAge, ...options } = getSessionCookieOptions(req);
  return options;
}
export const googleProofOptions = { algorithms: ["HS256"] as ["HS256"], audience: "forwardx-google" };
export function readGoogleProof(value: unknown) {
  try {
    if (typeof value !== "string" || value.length > 4096) return null;
    const payload = jwt.verify(value, ENV.cookieSecret, googleProofOptions);
    return typeof payload === "object" ? payload : null;
  } catch { return null; }
}
export function signGoogleProof(data: Record<string, unknown>) {
  return jwt.sign(data, ENV.cookieSecret, { algorithm: "HS256", audience: "forwardx-google", expiresIn: 300 });
}

export const googleRouter = router({
  loginStatus: publicProcedure.query(async () => {
    const settings = await getGoogleSettings();
    return { enabled: settings.enabled && googleConfigured(settings) };
  }),
  settings: adminProcedure.query(async () => googleSettingsSummary(await getGoogleSettings())),
  saveSettings: adminProcedure.input(z.object({ enabled: z.boolean(), clientId: z.string().trim().max(256),
    clientSecret: z.string().trim().max(1024).optional(), redirectUri: z.string().trim().max(1024), clearSecret: z.boolean().optional() }))
    .mutation(async ({ input, ctx }) => withKeyedTaskLock("google-settings", async () => {
      const current = await getGoogleSettings();
      const config = { enabled: input.enabled, clientId: input.clientId,
        clientSecret: input.clearSecret ? "" : (input.clientSecret || current.clientSecret),
        redirectUri: input.redirectUri ? normalizeGoogleRedirectUri(input.redirectUri) : "" };
      if (input.redirectUri && !config.redirectUri) throw new Error("Google 回调地址必须为 HTTPS（本机开发可用 HTTP），路径为 /api/auth/google/callback，且不含查询参数");
      if (config.clientId && !/^[a-zA-Z0-9_-]+\.apps\.googleusercontent\.com$/.test(config.clientId)) throw new Error("请输入 Google Web 应用的客户端 ID");
      if (config.enabled && !googleConfigured(config)) throw new GoogleAuthError("disabled");
      await setSetting(GOOGLE_SETTINGS_KEY, JSON.stringify(config));
      console.info(`[GoogleAuth] settings updated actor=${ctx.user.id} enabled=${config.enabled} configured=${googleConfigured(config)}`);
      return googleSettingsSummary(config);
    })),
  start: publicProcedure.input(z.object({ bind: z.boolean().optional() })).mutation(async ({ ctx, input }) => {
    if (input.bind && (!ctx.user || !ctx.authSession?.sid)) throw new GoogleAuthError("session_expired");
    const ip = String(ctx.req.ip || ctx.req.socket.remoteAddress || "unknown");
    if (authRateLimitState(ip, "google-login").limited) throw new GoogleAuthError("rate_limited");
    const config = await getGoogleSettings();
    // Cookies must reach the configured callback on this same panel origin.
    // The explicit configured URL avoids deriving OAuth redirects from Host headers.
    const origin = ctx.req.headers.origin;
    if (origin && origin !== new URL(config.redirectUri || "http://invalid").origin) throw new Error("请从 Google 回调地址对应的面板域名发起登录");
    const flow = googleFlows.create(config, ip, input.bind ? { userId: ctx.user!.id, sid: ctx.authSession!.sid! } : undefined);
    ctx.res.cookie(GOOGLE_FLOW_COOKIE, flow.browserToken, { ...getSessionCookieOptions(ctx.req), maxAge: GOOGLE_FLOW_TTL_MS, path: "/api/auth/google", secure: config.redirectUri.startsWith("https:") });
    ctx.res.clearCookie(GOOGLE_RESULT_COOKIE, googleClearCookieOptions(ctx.req));
    return { url: flow.url };
  }),
  finishTwoFactor: publicProcedure.mutation(({ ctx }) => {
    const proof = readGoogleProof(ctx.req.cookies?.[GOOGLE_RESULT_COOKIE]);
    ctx.res.clearCookie(GOOGLE_RESULT_COOKIE, googleClearCookieOptions(ctx.req));
    if (!proof || proof.purpose !== "two-factor" || proof.ip !== String(ctx.req.ip || ctx.req.socket.remoteAddress || "unknown")) throw new GoogleAuthError("invalid_state");
    return { challengeId: String(proof.challengeId), username: String(proof.username), expiresInSeconds: Math.max(0, Math.min(300, Number(proof.exp) - Math.floor(Date.now() / 1000))) };
  }),
  status: protectedProcedure.query(async ({ ctx }) => {
    const user = await getUserById(ctx.user.id);
    const config = await getGoogleSettings();
    return { enabled: config.enabled && googleConfigured(config), bound: !!user?.googleSubject,
      email: user?.googleEmail || "", passwordSet: !!user?.password.includes(":"), linkedAt: user?.googleLinkedAt || null };
  }),
  unbind: protectedProcedure.input(z.object({ password: z.string().min(1).max(256) })).mutation(async ({ ctx, input }) => {
    const ip = String(ctx.req.ip || ctx.req.socket.remoteAddress || "unknown");
    if (authRateLimitState(ip, ctx.user.username).limited) throw new GoogleAuthError("rate_limited");
    if (!(await verifyUserPassword(ctx.user.id, input.password))) {
      recordTwoFactorFailure(ip, ctx.user.username); throw new Error("当前密码错误");
    }
    const db = await getDb();
    if (!db) throw new Error("Database unavailable");
    await db.update(users).set({ googleSubject: null, googleEmail: null, googleLinkedAt: null, updatedAt: new Date() }).where(eq(users.id, ctx.user.id));
    ctx.res.clearCookie(GOOGLE_RECENT_COOKIE, googleClearCookieOptions(ctx.req));
    console.info(`[GoogleAuth] account unbound userId=${ctx.user.id}`);
    return { success: true };
  }),
  setPassword: protectedProcedure.input(z.object({ password: z.string().min(6).max(256) })).mutation(async ({ ctx, input }) => {
    const user = await getUserById(ctx.user.id);
    const proof = readGoogleProof(ctx.req.cookies?.[GOOGLE_RECENT_COOKIE]);
    if (!proof || proof.purpose !== "recent" || proof.userId !== user?.id || proof.subject !== user?.googleSubject || !user?.googleSubject) throw new Error("请先使用 Google 重新登录，再在五分钟内设置密码");
    // Password changes revoke previous sessions just like the regular password flow.
    await resetUserPassword(ctx.user.id, input.password);
    ctx.res.clearCookie(GOOGLE_RECENT_COOKIE, googleClearCookieOptions(ctx.req));
    await issueLoginSession(ctx, (await getUserById(ctx.user.id))!, "browser");
    console.info(`[GoogleAuth] password set userId=${ctx.user.id}`);
    return { success: true };
  }),
});
