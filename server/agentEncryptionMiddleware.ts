import { Request, Response, NextFunction } from "express";
import * as db from "./db";
import { decryptPayload, decryptPayloadWithCandidates, encryptPayload, isEncryptedEnvelope, rememberEncryptedEnvelope } from "./agentCrypto";
import {
  AGENT_AUTH_RESULT_ACCEPTED,
  AGENT_AUTH_RESULT_HEADER,
  AGENT_AUTH_RESULT_REJECTED,
  getCandidateAgentTokens,
  hasClocklessAgentAuth,
  hasSignedAgentAuthAttempt,
  hasVerifiedAgentAuthProof,
  resolveAgentTokenFromAuthorization,
} from "./agentAuth";
import { panelCryptoNowMs } from "./panelClock";
import { appendPanelLog } from "./_core/panelLogger";
import { pruneMapEntries, setBoundedMapValue } from "./boundedCache";

export const AGENT_TUNNEL_PATHS = new Set([
  "/api/agent/register",
  "/api/agent/heartbeat",
  "/api/agent/presence",
  "/api/agent/selftest-pull",
  "/api/agent/selftest-result",
  "/api/agent/looking-glass-result",
  "/api/agent/looking-glass-progress",
  "/api/agent/iperf3-result",
  "/api/agent/plugin-action-result",
  "/api/agent/support-bundle-result",
  "/api/agent/migration-rollback",
  "/api/agent/traffic",
  "/api/agent/tcping",
  "/api/agent/protocol-block",
  "/api/agent/rule-status",
  "/api/agent/rule-status-batch",
]);

const AGENT_AUTH_FAILURE_LOG_INTERVAL_MS = 5 * 60 * 1000;
const AGENT_AUTH_FAILURE_CACHE_RETENTION_MS = 60 * 60 * 1000;
const AGENT_AUTH_FAILURE_CACHE_MAX = 2048;
const agentAuthFailureLogAt = new Map<string, number>();

const agentAuthFailureCacheCleanupTimer = setInterval(() => {
  const now = Date.now();
  pruneMapEntries(agentAuthFailureLogAt, (loggedAt) => now - loggedAt >= AGENT_AUTH_FAILURE_CACHE_RETENTION_MS);
}, 10 * 60 * 1000);
agentAuthFailureCacheCleanupTimer.unref?.();

function agentAuthFailureCategory(error: unknown) {
  const message = String(error instanceof Error ? error.message : error || "").toLowerCase();
  if (message.includes("timestamp out of window")) return "timestamp-out-of-window";
  if (message.includes("mac verification failed")) return "mac-verification-failed";
  if (message.includes("replay detected")) return "replay-detected";
  if (message.includes("invalid agent auth proof")) return "invalid-auth-proof";
  if (message.includes("invalid iv")) return "invalid-envelope";
  if (message.includes("no token candidates")) return "no-token-candidates";
  if (message.includes("unexpected token") || message.includes("json")) return "invalid-payload";
  return "unauthorized";
}

function logAgentAuthRejection(req: Request, stage: string, error?: unknown) {
  const category = agentAuthFailureCategory(error);
  const method = String(req.method || "?").toUpperCase();
  const path = String(req.path || "/").replace(/[\r\n\t]+/g, " ").slice(0, 96);
  const key = `${method}:${path}:${stage}:${category}`;
  const now = Date.now();
  const last = agentAuthFailureLogAt.get(key) || 0;
  if (now - last < AGENT_AUTH_FAILURE_LOG_INTERVAL_MS) return;
  setBoundedMapValue(agentAuthFailureLogAt, key, now, AGENT_AUTH_FAILURE_CACHE_MAX);
  appendPanelLog(
    "warn",
    `[AgentAuth] rejected method=${method} path=${path} stage=${stage} reason=${category}`
      + ` signed=${hasSignedAgentAuthAttempt(req)} verified=${hasVerifiedAgentAuthProof(req)}`,
  );
}

function normalizeTunnelPath(value: unknown) {
  const path = String(value || "").trim();
  return AGENT_TUNNEL_PATHS.has(path) ? path : "";
}

export function getAgentTunneledPath(req: Request) {
  return (req as any).agentTunneledPath ? String((req as any).agentTunneledPath) : "";
}

export async function agentEncryptionMiddleware(req: Request, res: Response, next: NextFunction) {
  if ((req as any).agentToken) {
    return next();
  }

  if (!isEncryptedEnvelope(req.body)) {
    logAgentAuthRejection(req, "envelope", "Encrypted communication required");
    res.setHeader(AGENT_AUTH_RESULT_HEADER, AGENT_AUTH_RESULT_REJECTED);
    res.status(401).json({
      error: "Encrypted communication required",
      hint: "Please upgrade your Agent.",
    });
    return;
  }

  const rawBodyText = JSON.stringify(req.body);
  const isSyncRequest = req.path === "/api/sync";
  let token: string | null = null;
  let payload: any = null;
  const protocolNowMs = panelCryptoNowMs();
  let authStage = "resolve-token";
  try {
    token = await resolveAgentTokenFromAuthorization(req, rawBodyText, protocolNowMs);
    if (token) {
      if (hasVerifiedAgentAuthProof(req)) {
        res.setHeader(AGENT_AUTH_RESULT_HEADER, AGENT_AUTH_RESULT_ACCEPTED);
      }
      authStage = "decrypt-authorized";
      payload = decryptPayload(req.body, token, {
        validateTimestamp: !hasClocklessAgentAuth(req),
        nowMs: protocolNowMs,
      });
    } else if (hasSignedAgentAuthAttempt(req)) {
      authStage = "verify-proof";
      throw new Error("Invalid Agent auth proof");
    } else {
      let resolved;
      try {
        authStage = "decrypt-candidates";
        resolved = decryptPayloadWithCandidates(req.body, await getCandidateAgentTokens(), { nowMs: protocolNowMs });
      } catch {
        authStage = "refresh-token-candidates";
        resolved = decryptPayloadWithCandidates(req.body, await db.getAgentAuthTokenCandidates({ force: true }), { nowMs: protocolNowMs });
      }
      token = resolved.token;
      payload = resolved.payload;
      rememberEncryptedEnvelope(req.body);
    }
  } catch (err: any) {
    const message = String(err?.message || "Unauthorized");
    logAgentAuthRejection(req, authStage, message);
    res.setHeader(
      AGENT_AUTH_RESULT_HEADER,
      hasVerifiedAgentAuthProof(req) ? AGENT_AUTH_RESULT_ACCEPTED : AGENT_AUTH_RESULT_REJECTED,
    );
    res.status(401).json({
      error: "Unauthorized",
      message,
      ...(message.toLowerCase().includes("mac verification failed") ? {
        hint: "Agent Token 与当前面板不匹配，或面板地址/反代指向了另一个 ForwardX 实例。",
      } : {}),
    });
    return;
  }
  if (!token) {
    logAgentAuthRejection(req, "resolve-token", "No token candidates available");
    res.setHeader(AGENT_AUTH_RESULT_HEADER, AGENT_AUTH_RESULT_REJECTED);
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    res.setHeader(AGENT_AUTH_RESULT_HEADER, AGENT_AUTH_RESULT_ACCEPTED);
    req.body = payload;
    (req as any).agentToken = token;
    const tunneledPath = isSyncRequest ? normalizeTunnelPath(req.body?.path) : "";
    if (isSyncRequest && !tunneledPath) {
      res.status(400).json({ error: "Invalid encrypted request" });
      return;
    }
    if (tunneledPath) {
      (req as any).agentTunneledPath = tunneledPath;
      req.body = req.body?.payload ?? {};
    }
  } catch (err: any) {
    logAgentAuthRejection(req, "payload", err);
    res.status(400).json({ error: "Decryption failed", message: err?.message });
    return;
  }

  const tokenForResp = token;
  // Bind the response timestamp window to the panel's protocol clock. The
  // Agent authenticates the encrypted envelope before using this hint.
  res.setHeader("X-ForwardX-Panel-Time", String(panelCryptoNowMs()));
  const originalJson = res.json.bind(res);
  res.json = (body?: any) => {
    const env = encryptPayload(body, tokenForResp);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return originalJson(env);
  };

  next();
}
