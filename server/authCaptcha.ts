import { timingSafeEqual } from "node:crypto";
import { nanoid } from "nanoid";
import * as svgCaptcha from "svg-captcha";

export const LOGIN_CAPTCHA_FAILURE_THRESHOLD = 3;
export const LOGIN_CAPTCHA_REQUIREMENT_TTL_MS = 15 * 60 * 1000;
export const CAPTCHA_CHALLENGE_TTL_MS = 5 * 60 * 1000;
export const CAPTCHA_REFRESH_WINDOW_MS = 60 * 1000;
export const CAPTCHA_REFRESH_MAX_PER_WINDOW = 6;

const CAPTCHA_MAX_CHALLENGES = 5_000;
const CAPTCHA_CHARACTERS = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

export type CaptchaPurpose = "login" | "register";

type SvgCaptchaGenerator = (options?: svgCaptcha.ConfigObject) => svgCaptcha.CaptchaObj;

interface CaptchaChallengeEntry {
  answer: string;
  expiresAt: number;
  ip: string;
  purpose: CaptchaPurpose;
}

interface FailureEntry {
  count: number;
  lastFailureAt: number;
}

interface CaptchaServiceOptions {
  challengeTtlMs?: number;
  requirementTtlMs?: number;
  failureThreshold?: number;
  refreshWindowMs?: number;
  refreshMaxPerWindow?: number;
  maxChallenges?: number;
  svgGenerator?: SvgCaptchaGenerator;
}

export class CaptchaRefreshRateLimitError extends Error {
  constructor(public readonly retryAfterSeconds: number) {
    super("CAPTCHA_REFRESH_RATE_LIMITED");
    this.name = "CaptchaRefreshRateLimitError";
  }
}

function normalizeIp(ip: string) {
  return String(ip || "unknown").trim().toLowerCase() || "unknown";
}

function normalizeUsername(username: string) {
  return String(username || "").trim().toLowerCase();
}

function normalizeAnswer(answer: string | number) {
  return String(answer).replace(/\s+/g, "").toUpperCase();
}

function answersEqual(expected: string, actual: string) {
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(actual);
  return expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer);
}

export class AuthCaptchaService {
  private readonly challenges = new Map<string, CaptchaChallengeEntry>();
  private readonly loginFailures = new Map<string, FailureEntry>();
  private readonly refreshTimestamps = new Map<string, number[]>();
  private readonly challengeTtlMs: number;
  private readonly requirementTtlMs: number;
  private readonly failureThreshold: number;
  private readonly refreshWindowMs: number;
  private readonly refreshMaxPerWindow: number;
  private readonly maxChallenges: number;
  private readonly svgGenerator: SvgCaptchaGenerator;

  constructor(options: CaptchaServiceOptions = {}) {
    this.challengeTtlMs = options.challengeTtlMs ?? CAPTCHA_CHALLENGE_TTL_MS;
    this.requirementTtlMs = options.requirementTtlMs ?? LOGIN_CAPTCHA_REQUIREMENT_TTL_MS;
    this.failureThreshold = options.failureThreshold ?? LOGIN_CAPTCHA_FAILURE_THRESHOLD;
    this.refreshWindowMs = options.refreshWindowMs ?? CAPTCHA_REFRESH_WINDOW_MS;
    this.refreshMaxPerWindow = options.refreshMaxPerWindow ?? CAPTCHA_REFRESH_MAX_PER_WINDOW;
    this.maxChallenges = options.maxChallenges ?? CAPTCHA_MAX_CHALLENGES;
    this.svgGenerator = options.svgGenerator ?? svgCaptcha.create;
  }

  private loginKey(ip: string, username: string) {
    return `${normalizeIp(ip)}:${normalizeUsername(username)}`;
  }

  private consumeRefreshSlot(ip: string, now: number) {
    const key = normalizeIp(ip);
    const cutoff = now - this.refreshWindowMs;
    const active = (this.refreshTimestamps.get(key) || []).filter((timestamp) => timestamp > cutoff);
    if (active.length >= this.refreshMaxPerWindow) {
      const retryAfterMs = active[0] + this.refreshWindowMs - now;
      this.refreshTimestamps.set(key, active);
      throw new CaptchaRefreshRateLimitError(Math.max(1, Math.ceil(retryAfterMs / 1000)));
    }
    active.push(now);
    this.refreshTimestamps.set(key, active);
  }

  private pruneChallenges(now: number) {
    for (const [id, challenge] of this.challenges) {
      if (challenge.expiresAt <= now) this.challenges.delete(id);
    }
    while (this.challenges.size >= this.maxChallenges) {
      const oldestId = this.challenges.keys().next().value;
      if (!oldestId) break;
      this.challenges.delete(oldestId);
    }
  }

  private storeChallenge(input: {
    answer: string | number;
    ip: string;
    purpose: CaptchaPurpose;
    now: number;
  }) {
    this.pruneChallenges(input.now);
    const captchaId = nanoid(20);
    this.challenges.set(captchaId, {
      answer: normalizeAnswer(input.answer),
      expiresAt: input.now + this.challengeTtlMs,
      ip: normalizeIp(input.ip),
      purpose: input.purpose,
    });
    return captchaId;
  }

  createImageChallenge(ip: string, purpose: CaptchaPurpose, now = Date.now()) {
    this.consumeRefreshSlot(ip, now);
    const generated = this.svgGenerator({
      size: 5,
      width: 190,
      height: 56,
      fontSize: 44,
      charPreset: CAPTCHA_CHARACTERS,
      noise: 3,
      color: true,
      background: "#f8fafc",
    });
    const captchaId = this.storeChallenge({ answer: generated.text, ip, purpose, now });
    return {
      captchaId,
      imageDataUrl: `data:image/svg+xml;base64,${Buffer.from(generated.data, "utf8").toString("base64")}`,
      expiresInSeconds: Math.floor(this.challengeTtlMs / 1000),
    };
  }

  verifyChallenge(
    captchaId: string,
    answer: string | number,
    ip: string,
    purpose: CaptchaPurpose,
    now = Date.now(),
  ) {
    const challenge = this.challenges.get(captchaId);
    if (!challenge) return false;
    this.challenges.delete(captchaId);
    if (challenge.expiresAt <= now) return false;
    if (challenge.ip !== normalizeIp(ip)) return false;
    if (challenge.purpose !== purpose) return false;
    return answersEqual(challenge.answer, normalizeAnswer(answer));
  }

  recordLoginFailure(ip: string, username: string, now = Date.now()) {
    const key = this.loginKey(ip, username);
    const entry = this.loginFailures.get(key);
    if (!entry || now - entry.lastFailureAt >= this.requirementTtlMs) {
      this.loginFailures.set(key, { count: 1, lastFailureAt: now });
      return;
    }
    entry.count += 1;
    entry.lastFailureAt = now;
  }

  requiresLoginCaptcha(ip: string, username: string, now = Date.now()) {
    const key = this.loginKey(ip, username);
    const entry = this.loginFailures.get(key);
    if (!entry) return false;
    if (now - entry.lastFailureAt >= this.requirementTtlMs) {
      this.loginFailures.delete(key);
      return false;
    }
    return entry.count >= this.failureThreshold;
  }

  clearLoginCaptchaRequirement(ip: string, username: string) {
    this.loginFailures.delete(this.loginKey(ip, username));
  }

  clearForTest() {
    this.challenges.clear();
    this.loginFailures.clear();
    this.refreshTimestamps.clear();
  }
}

export const authCaptcha = new AuthCaptchaService();
