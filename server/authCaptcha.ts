import { timingSafeEqual } from "node:crypto";
import { nanoid } from "nanoid";
import * as svgCaptcha from "svg-captcha";
import Cap from "@cap.js/server";
import { Router, type Request, type Response } from "express";
import { setBoundedMapValue } from "./boundedCache";

export const LOGIN_CAPTCHA_FAILURE_THRESHOLD = 3;
export const LOGIN_CAPTCHA_REQUIREMENT_TTL_MS = 15 * 60 * 1000;
export const CAPTCHA_CHALLENGE_TTL_MS = 5 * 60 * 1000;
export const CAPTCHA_REFRESH_WINDOW_MS = 60 * 1000;
export const CAPTCHA_REFRESH_MAX_PER_WINDOW = 6;

const CAPTCHA_MAX_CHALLENGES = 5_000;
const CAP_MAX_CHALLENGES = 5_000;
const CAP_MAX_TOKENS = 5_000;
const CAPTCHA_MAX_RATE_LIMIT_KEYS = 50_000;
const CAPTCHA_CHARACTERS = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

export type CaptchaPurpose = "login" | "register";

type SvgCaptchaGenerator = (options?: svgCaptcha.ConfigObject) => svgCaptcha.CaptchaObj;

interface CaptchaChallengeEntry {
  answer: string;
  expiresAt: number;
  ip: string;
  purpose: CaptchaPurpose;
}

interface CapChallengeEntry {
  expiresAt: number;
  ip: string;
  purpose: CaptchaPurpose;
}

interface CapTokenEntry {
  expiresAt: number;
  ip: string;
  purpose: CaptchaPurpose;
}

const capServer = new Cap({ noFSState: true });

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
  maxRateLimitKeys?: number;
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
  private readonly capChallenges = new Map<string, CapChallengeEntry>();
  private readonly capTokens = new Map<string, CapTokenEntry>();
  private readonly loginFailures = new Map<string, FailureEntry>();
  private readonly refreshTimestamps = new Map<string, number[]>();
  private readonly challengeTtlMs: number;
  private readonly requirementTtlMs: number;
  private readonly failureThreshold: number;
  private readonly refreshWindowMs: number;
  private readonly refreshMaxPerWindow: number;
  private readonly maxChallenges: number;
  private readonly maxRateLimitKeys: number;
  private readonly svgGenerator: SvgCaptchaGenerator;
  private readonly cap: Cap = capServer;

  constructor(options: CaptchaServiceOptions = {}) {
    this.challengeTtlMs = options.challengeTtlMs ?? CAPTCHA_CHALLENGE_TTL_MS;
    this.requirementTtlMs = options.requirementTtlMs ?? LOGIN_CAPTCHA_REQUIREMENT_TTL_MS;
    this.failureThreshold = options.failureThreshold ?? LOGIN_CAPTCHA_FAILURE_THRESHOLD;
    this.refreshWindowMs = options.refreshWindowMs ?? CAPTCHA_REFRESH_WINDOW_MS;
    this.refreshMaxPerWindow = options.refreshMaxPerWindow ?? CAPTCHA_REFRESH_MAX_PER_WINDOW;
    this.maxChallenges = options.maxChallenges ?? CAPTCHA_MAX_CHALLENGES;
    this.maxRateLimitKeys = options.maxRateLimitKeys ?? CAPTCHA_MAX_RATE_LIMIT_KEYS;
    this.svgGenerator = options.svgGenerator ?? svgCaptcha.create;
    // Cap's default file-backed token store is not appropriate for a panel
    // process and can leave state in the working directory. The business
    // layer below binds all tokens to IP and purpose and bounds that state.
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
      setBoundedMapValue(this.refreshTimestamps, key, active, this.maxRateLimitKeys);
      throw new CaptchaRefreshRateLimitError(Math.max(1, Math.ceil(retryAfterMs / 1000)));
    }
    active.push(now);
    setBoundedMapValue(this.refreshTimestamps, key, active, this.maxRateLimitKeys);
  }

  private pruneChallenges(now: number) {
    if (this.challenges.size < this.maxChallenges) return;
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

  async createCapChallenge(ip: string, purpose: CaptchaPurpose, now = Date.now()) {
    this.consumeRefreshSlot(ip, now);
    this.pruneCapState(now);
    const result = await this.cap.createChallenge({
      // A short PoW keeps the interaction to one click while still making
      // high-volume automated requests expensive.
      challengeCount: 5,
      challengeSize: 32,
      challengeDifficulty: 3,
      expiresMs: this.challengeTtlMs,
    });
    if (!result.token) throw new Error("CAPTCHA_CHALLENGE_UNAVAILABLE");
    setBoundedMapValue(this.capChallenges, result.token, {
      expiresAt: result.expires,
      ip: normalizeIp(ip),
      purpose,
    }, CAP_MAX_CHALLENGES);
    return result;
  }

  async redeemCapChallenge(
    ip: string,
    purpose: CaptchaPurpose,
    token: string,
    solutions: number[],
    now = Date.now(),
  ) {
    this.pruneCapState(now);
    const challenge = this.capChallenges.get(token);
    if (!challenge || challenge.expiresAt <= now || challenge.ip !== normalizeIp(ip) || challenge.purpose !== purpose) {
      return { success: false as const, message: "CAPTCHA_INVALID" };
    }
    // Cap consumes challenges on redemption, including invalid solutions.
    this.capChallenges.delete(token);
    const result = await this.cap.redeemChallenge({ token, solutions });
    if (!result.success || !result.token || !result.expires) return result;
    setBoundedMapValue(this.capTokens, result.token, {
      expiresAt: result.expires,
      ip: normalizeIp(ip),
      purpose,
    }, CAP_MAX_TOKENS);
    return result;
  }

  async verifyCapToken(
    ip: string,
    purpose: CaptchaPurpose,
    token: string,
    now = Date.now(),
  ) {
    this.pruneCapState(now);
    const entry = this.capTokens.get(token);
    if (!entry || entry.expiresAt <= now || entry.ip !== normalizeIp(ip) || entry.purpose !== purpose) return false;
    // Remove before awaiting validation so a concurrent login cannot consume
    // the same token twice. A failed validation is intentionally non-reusable.
    this.capTokens.delete(token);
    const result = await this.cap.validateToken(token);
    return result.success;
  }

  private pruneCapState(now: number) {
    for (const [token, entry] of this.capChallenges) {
      if (entry.expiresAt <= now) this.capChallenges.delete(token);
    }
    for (const [token, entry] of this.capTokens) {
      if (entry.expiresAt <= now) this.capTokens.delete(token);
    }
    const state = this.cap.config.state;
    for (const [token, entry] of Object.entries(state.challengesList)) {
      if (entry.expires <= now) delete state.challengesList[token];
    }
    for (const [token, expires] of Object.entries(state.tokensList)) {
      if (expires <= now) delete state.tokensList[token];
    }
    while (Object.keys(state.challengesList).length > CAP_MAX_CHALLENGES) {
      const oldest = Object.keys(state.challengesList)[0];
      if (!oldest) break;
      delete state.challengesList[oldest];
    }
    while (Object.keys(state.tokensList).length > CAP_MAX_TOKENS) {
      const oldest = Object.keys(state.tokensList)[0];
      if (!oldest) break;
      delete state.tokensList[oldest];
    }
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
      setBoundedMapValue(this.loginFailures, key, { count: 1, lastFailureAt: now }, this.maxRateLimitKeys);
      return;
    }
    entry.count += 1;
    entry.lastFailureAt = now;
    setBoundedMapValue(this.loginFailures, key, entry, this.maxRateLimitKeys);
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

  pruneExpired(now = Date.now()) {
    for (const [id, challenge] of this.challenges) {
      if (challenge.expiresAt <= now) this.challenges.delete(id);
    }
    for (const [key, entry] of this.loginFailures) {
      if (now - entry.lastFailureAt >= this.requirementTtlMs) this.loginFailures.delete(key);
    }
    const cutoff = now - this.refreshWindowMs;
    for (const [key, timestamps] of this.refreshTimestamps) {
      const active = timestamps.filter((timestamp) => timestamp > cutoff);
      if (active.length > 0) setBoundedMapValue(this.refreshTimestamps, key, active, this.maxRateLimitKeys);
      else this.refreshTimestamps.delete(key);
    }
    this.pruneCapState(now);
  }

  stateSizesForTest() {
    return {
      challenges: this.challenges.size,
      loginFailures: this.loginFailures.size,
      refreshTimestamps: this.refreshTimestamps.size,
      capChallenges: this.capChallenges.size,
      capTokens: this.capTokens.size,
    };
  }

  clearForTest() {
    this.challenges.clear();
    this.loginFailures.clear();
    this.refreshTimestamps.clear();
    this.capChallenges.clear();
    this.capTokens.clear();
    this.cap.config.state.challengesList = {};
    this.cap.config.state.tokensList = {};
  }
}

export const authCaptcha = new AuthCaptchaService();

function requestIp(req: Request) {
  return req.ip || req.socket.remoteAddress || "unknown";
}

function capPurpose(value: unknown): CaptchaPurpose | null {
  return value === "login" || value === "register" ? value : null;
}

/**
 * Self-hosted Cap.js HTTP API used by the login/register widget. The Cap
 * protocol itself is deliberately kept separate from tRPC because the widget
 * posts directly to /challenge and /redeem.
 */
export const authCapRouter = Router();

authCapRouter.post("/api/auth/cap/:purpose/challenge", async (req: Request, res: Response) => {
  const purpose = capPurpose(req.params.purpose);
  if (!purpose) {
    res.status(404).json({ success: false, error: "Not found" });
    return;
  }
  try {
    const challenge = await authCaptcha.createCapChallenge(requestIp(req), purpose);
    res.setHeader("Cache-Control", "no-store");
    res.json(challenge);
  } catch (error) {
    if (error instanceof CaptchaRefreshRateLimitError) {
      res.setHeader("Retry-After", String(error.retryAfterSeconds));
      res.status(429).json({ success: false, error: "CAPTCHA_REFRESH_RATE_LIMITED" });
      return;
    }
    console.warn(`[Auth] Cap challenge failed ip=${requestIp(req)}`, error);
    res.status(503).json({ success: false, error: "CAPTCHA_CHALLENGE_UNAVAILABLE" });
  }
});

authCapRouter.post("/api/auth/cap/:purpose/redeem", async (req: Request, res: Response) => {
  const purpose = capPurpose(req.params.purpose);
  if (!purpose) {
    res.status(404).json({ success: false, error: "Not found" });
    return;
  }
  const token = typeof req.body?.token === "string" ? req.body.token.trim() : "";
  const solutions = req.body?.solutions;
  // Challenge tokens are randomHex(25) in Cap.js (50 hexadecimal chars).
  if (!/^[a-f0-9]{50}$/i.test(token)
    || !Array.isArray(solutions)
    || solutions.length < 1
    || solutions.length > 100
    || solutions.some((value: unknown) => typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)) {
    res.status(400).json({ success: false, error: "Invalid body" });
    return;
  }
  try {
    const result = await authCaptcha.redeemCapChallenge(requestIp(req), purpose, token, solutions);
    if (!result.success) {
      res.status(400).json({ success: false, error: result.message || "CAPTCHA_INVALID" });
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    res.json(result);
  } catch (error) {
    console.warn(`[Auth] Cap redeem failed ip=${requestIp(req)}`, error);
    res.status(400).json({ success: false, error: "CAPTCHA_INVALID" });
  }
});

const authCaptchaCleanupTimer = setInterval(() => authCaptcha.pruneExpired(), 5 * 60 * 1000);
authCaptchaCleanupTimer.unref?.();
