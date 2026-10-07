import type { Express, Request, Response } from "express";
import { GOOGLE_CALLBACK_PATH } from "../shared/googleAuth";
import { getSessionCookieOptions } from "./_core/cookies";
import { createContext } from "./_core/context";
import { exchangeGoogleCode, getGoogleSettings, googleFlows, GoogleAuthError, GOOGLE_FLOW_COOKIE } from "./googleOAuth";
import { resolveGoogleAccount } from "./googleAccounts";
import { GOOGLE_RECENT_COOKIE, GOOGLE_RESULT_COOKIE, googleClearCookieOptions, signGoogleProof } from "./routers/google";
import { issueLoginSession } from "./routers/auth";
import { getSetting } from "./repositories/settingsRepository";
import { authRateLimitState, clearAuthAccountFailures, clearTwoFactorChallengeIssueHistory, recordTwoFactorChallengeIssue, twoFactorChallengeIssueState } from "./authRateLimit";
import { createTwoFactorChallenge } from "./twoFactorChallenges";

const rejectedLogs = new Map<string, { at: number; suppressed: number }>();
function logRejection(mode: string, code: string) {
  const key = `${mode}:${code}`;
  const previous = rejectedLogs.get(key);
  if (previous && Date.now() - previous.at < 30_000) { previous.suppressed++; return; }
  console.warn(`[GoogleAuth] callback rejected mode=${mode} reason=${code} suppressed=${previous?.suppressed || 0}`);
  rejectedLogs.set(key, { at: Date.now(), suppressed: 0 });
}

export async function handleGoogleCallback(req: Request, res: Response) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  let binding = false;
  try {
    const config = await getGoogleSettings();
    const flow = googleFlows.consume(req.query.state, req.cookies?.[GOOGLE_FLOW_COOKIE], config);
    binding = !!flow.userId;
    res.clearCookie(GOOGLE_FLOW_COOKIE, { ...googleClearCookieOptions(req), path: "/api/auth/google", secure: config.redirectUri.startsWith("https:") });
    if (req.query.error) throw new GoogleAuthError(req.query.error === "access_denied" ? "cancelled" : "provider_error");
    const checkBinding = async () => {
      if (!binding) return;
      const ctx = await createContext({ req, res, info: {} as any });
      if (!ctx.user || ctx.user.id !== flow.userId || ctx.authSession?.sid !== flow.sid) throw new GoogleAuthError("session_expired");
    };
    await checkBinding();
    const identity = await exchangeGoogleCode(config, flow, req.query.code);
    // If credentials/enable state changed while the Google request was running,
    // do not complete a previously authorized flow with stale configuration.
    const current = await getGoogleSettings();
    if (JSON.stringify(config) !== JSON.stringify(current)) throw new GoogleAuthError("disabled");
    await checkBinding();
    const user = await resolveGoogleAccount(identity, flow.userId);
    if (binding) {
      console.info(`[GoogleAuth] account bound userId=${user.id}`);
      res.redirect(303, "/profile?google=bound");
      return;
    }
    const ip = String(req.ip || req.socket.remoteAddress || "unknown");
    if (authRateLimitState(ip, user.username).limited) throw new GoogleAuthError("rate_limited");
    if ((await getSetting("twoFactorEnabled")) === "true" && user.twoFactorEnabled && user.twoFactorSecret) {
      if (twoFactorChallengeIssueState(ip, user.username).limited) throw new GoogleAuthError("rate_limited");
      const challenge = createTwoFactorChallenge({ userId: user.id, username: user.username, ip });
      recordTwoFactorChallengeIssue(ip, user.username);
      res.cookie(GOOGLE_RESULT_COOKIE, signGoogleProof({ purpose: "two-factor", ip, username: user.username, challengeId: challenge.challengeId }),
        { ...getSessionCookieOptions(req), maxAge: Math.min(challenge.expiresInSeconds * 1000, 300_000) });
      res.cookie(GOOGLE_RECENT_COOKIE, signGoogleProof({ purpose: "recent", userId: user.id, subject: identity.subject }), { ...getSessionCookieOptions(req), maxAge: 300_000 });
      res.redirect(303, "/login?google=two_factor");
      return;
    }
    await issueLoginSession({ req, res }, user, "browser");
    clearAuthAccountFailures(ip, user.username);
    clearTwoFactorChallengeIssueHistory(ip, user.username);
    res.cookie(GOOGLE_RECENT_COOKIE, signGoogleProof({ purpose: "recent", userId: user.id, subject: identity.subject }), { ...getSessionCookieOptions(req), maxAge: 300_000 });
    console.info(`[GoogleAuth] login success userId=${user.id}`);
    res.redirect(303, "/");
  } catch (error) {
    const code = error instanceof GoogleAuthError ? error.code : "failed";
    // Do not log callback URLs, authorization codes, tokens, client secrets or
    // raw provider responses. The fixed reason is sufficient for diagnosis.
    logRejection(binding ? "bind" : "login", code);
    res.redirect(303, `${binding ? "/profile" : "/login"}?google=${code}`);
  }
}

export function registerGoogleAuthRoutes(app: Express) {
  app.get(GOOGLE_CALLBACK_PATH, (req, res) => { void handleGoogleCallback(req, res); });
}
