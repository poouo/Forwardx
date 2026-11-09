import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { TRPCError } from "@trpc/server";
import { ENV } from "./env";
import { getUserById, getUserByUsername, resetUserPasswordFromRecovery } from "./repositories/userRepository";
import { getEmailConfig, sendMail } from "./email";
import { getNotificationSettings } from "./notificationSettings";
import { getConfiguredPanelUrl, normalizePanelUrl } from "./agentPanelUrl";
import { createRequestWorkPool } from "./requestWorkPool";
import { setBoundedMapValue } from "./boundedCache";
import { clearTwoFactorChallengesForUser } from "./twoFactorChallenges";
import { clearTwoFactorSetupChallengesForUser } from "./twoFactorSetupChallenges";
import { PASSWORD_RECOVERY_INVALID_MESSAGE, PASSWORD_RECOVERY_REQUEST_MESSAGE, PASSWORD_RECOVERY_TTL_SECONDS, type PasswordRecoveryChannel } from "../shared/passwordRecovery";

type RecoveryUser = {
  id: number; password: string; username: string; accountEnabled?: boolean;
  email?: string | null; emailVerified?: boolean; telegramId?: string | null;
};
type RecoveryOptions = { email: boolean; telegram: boolean; panelUrl: string };
const PURPOSE = "forwardx-password-recovery";
const invalidLink = () => new TRPCError({ code: "BAD_REQUEST", message: PASSWORD_RECOVERY_INVALID_MESSAGE });

export function recoveryDestination(user: RecoveryUser, channel: PasswordRecoveryChannel) {
  if (user.accountEnabled === false) return "";
  if (channel === "email") return user.emailVerified && user.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(user.email.trim()) ? user.email.trim().toLowerCase() : "";
  return /^[1-9]\d{0,19}$/.test(String(user.telegramId || "")) ? String(user.telegramId) : "";
}

function recoverySigningKey(user: RecoveryUser, channel: PasswordRecoveryChannel, secret: string) {
  // Changing the password or recovery binding invalidates every outstanding link,
  // including after a restart. No reset credentials are stored in the database.
  return crypto.createHmac("sha256", secret).update(JSON.stringify([PURPOSE, user.id, user.password, channel, recoveryDestination(user, channel)])).digest();
}

export function issuePasswordRecoveryToken(user: RecoveryUser, channel: PasswordRecoveryChannel, secret: string, now = Date.now()) {
  if (!recoveryDestination(user, channel)) throw invalidLink();
  return jwt.sign({ purpose: PURPOSE, channel, nonce: crypto.randomBytes(24).toString("base64url"), iat: Math.floor(now / 1000) }, recoverySigningKey(user, channel, secret), {
    algorithm: "HS256", subject: String(user.id), issuer: PURPOSE, audience: PURPOSE, expiresIn: PASSWORD_RECOVERY_TTL_SECONDS,
  });
}

export function readPasswordRecoveryToken(token: string) {
  if (!token || token.length > 2048) throw invalidLink();
  let decoded: ReturnType<typeof jwt.decode>;
  try { decoded = jwt.decode(token); } catch { throw invalidLink(); }
  if (!decoded || typeof decoded === "string" || decoded.purpose !== PURPOSE || !/^[1-9]\d{0,14}$/.test(String(decoded.sub || ""))
    || (decoded.channel !== "email" && decoded.channel !== "telegram")) throw invalidLink();
  return { userId: Number(decoded.sub), channel: decoded.channel as PasswordRecoveryChannel };
}

export function verifyPasswordRecoveryToken(token: string, user: RecoveryUser, secret: string, now = Date.now()) {
  const decoded = readPasswordRecoveryToken(token);
  if (decoded.userId !== user.id || !recoveryDestination(user, decoded.channel)) throw invalidLink();
  try {
    jwt.verify(token, recoverySigningKey(user, decoded.channel, secret), {
      algorithms: ["HS256"], issuer: PURPOSE, audience: PURPOSE, subject: String(user.id), clockTimestamp: Math.floor(now / 1000), maxAge: PASSWORD_RECOVERY_TTL_SECONDS,
    });
  } catch { throw invalidLink(); }
  return decoded.channel;
}

export function passwordRecoveryLink(panelUrl: string, token: string) {
  const base = normalizePanelUrl(panelUrl);
  if (!base) throw new Error("Password recovery requires a configured panel public URL");
  // A fragment never appears in HTTP access logs or Referer headers. Do not
  // derive this origin from unauthenticated Host / X-Forwarded-Host headers.
  return `${base}/login#password-reset=${encodeURIComponent(token)}`;
}

export async function getPasswordRecoveryOptions(): Promise<RecoveryOptions> {
  const [email, telegram, panelUrl] = await Promise.all([getEmailConfig(), getNotificationSettings("telegram"), getConfiguredPanelUrl()]);
  return { panelUrl, email: !!panelUrl && email.enabled && !!email.host && !!email.from, telegram: !!panelUrl && telegram.active };
}

function createRecoveryBudgets() {
  const entries = new Map<string, { count: number; until: number }>();
  let pruneAt = 0;
  return (key: string, max: number, windowMs: number, now: number) => {
    if (now >= pruneAt) {
      for (const [entryKey, entry] of entries) if (entry.until <= now) entries.delete(entryKey);
      pruneAt = now + 60_000;
    }
    const old = entries.get(key);
    const entry = old && old.until > now ? old : { count: 0, until: now + windowMs };
    if (entry.count >= max) return false;
    entry.count++;
    setBoundedMapValue(entries, key, entry, 5000);
    return true;
  };
}

type RecoveryDependencies = {
  findUser: (identifier: string) => Promise<RecoveryUser | undefined>;
  getUser: (id: number) => Promise<RecoveryUser | undefined>;
  options: () => Promise<RecoveryOptions>;
  send: (user: RecoveryUser, channel: PasswordRecoveryChannel, link: string) => Promise<void>;
  consume: (user: RecoveryUser, channel: PasswordRecoveryChannel, password: string) => Promise<boolean>;
  schedule: (work: () => Promise<void>) => void;
  secret: () => string;
  now?: () => number;
};

export function createPasswordRecoveryService(deps: RecoveryDependencies) {
  const budget = createRecoveryBudgets();
  const now = deps.now || Date.now;
  return {
    request(identifier: string, channel: PasswordRecoveryChannel, ip: string) {
      if (!budget(`send-ip:${ip}`, 10, 30 * 60_000, now())) {
        throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "申请过于频繁，请稍后再试或联系管理员" });
      }
      // Lookup and delivery both happen after the generic response. Existing,
      // unbound and unknown accounts must not have distinguishable responses.
      deps.schedule(async () => {
        const user = await deps.findUser(identifier.trim());
        if (!user || !recoveryDestination(user, channel)) return;
        const options = await deps.options();
        if (!options[channel] || !options.panelUrl) return;
        if (!budget(`send-user:${user.id}`, 1, 60_000, now())) return;
        const token = issuePasswordRecoveryToken(user, channel, deps.secret(), now());
        await deps.send(user, channel, passwordRecoveryLink(options.panelUrl, token));
        console.info(`[AuthRecovery] link delivered userId=${user.id} channel=${channel}`);
      });
      return { success: true, message: PASSWORD_RECOVERY_REQUEST_MESSAGE };
    },
    async reset(token: string, password: string, ip: string) {
      if (!budget(`reset-ip:${ip}`, 30, 15 * 60_000, now())) {
        throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "尝试过于频繁，请稍后再试" });
      }
      if (password.length < 6 || password.length > 128) throw new TRPCError({ code: "BAD_REQUEST", message: "新密码长度应为6到128个字符" });
      const { userId } = readPasswordRecoveryToken(token);
      const user = await deps.getUser(userId);
      if (!user) throw invalidLink();
      const channel = verifyPasswordRecoveryToken(token, user, deps.secret(), now());
      if (!await deps.consume(user, channel, password)) throw invalidLink();
      clearTwoFactorChallengesForUser(userId);
      clearTwoFactorSetupChallengesForUser(userId);
      console.info(`[AuthRecovery] password reset userId=${userId} channel=${channel}; sessions revoked`);
      return { success: true };
    },
  };
}

const deliveryPool = createRequestWorkPool({ concurrency: 2, maxQueued: 8, queueTimeoutMs: 1000 });
const resetPool = createRequestWorkPool({ concurrency: 2, maxQueued: 8, queueTimeoutMs: 1000 });
export const passwordRecovery = createPasswordRecoveryService({
  findUser: getUserByUsername, getUser: getUserById, options: getPasswordRecoveryOptions,
  secret: () => ENV.cookieSecret,
  schedule(work) {
    void deliveryPool.run(work).catch(() => console.warn("[AuthRecovery] delivery failed; check recovery channel settings and connectivity"));
  },
  async send(user, channel, link) {
    if (channel === "email") {
      const result = await sendMail({ to: recoveryDestination(user, channel), subject: "ForwardX 密码重置", text: `请通过以下链接设置新密码（15 分钟内有效，只能成功使用一次）：\n${link}\n\n如非本人操作，请忽略此消息。不要向他人转发该链接。` });
      if (result.skipped) throw new Error("Recovery email was not sent");
    } else {
      const { sendTelegramMessage } = await import("./telegramBot");
      const safeLink = link.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      await sendTelegramMessage(recoveryDestination(user, channel), `ForwardX 密码重置\n\n请通过以下链接设置新密码（15 分钟内有效，只能成功使用一次）：\n${safeLink}\n\n如非本人操作，请忽略此消息。不要向他人转发该链接。`);
    }
  },
  consume: (user, channel, password) => resetPool.run(() => resetUserPasswordFromRecovery(user, channel, password)),
});
