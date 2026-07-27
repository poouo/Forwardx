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
  try {
    token = await resolveAgentTokenFromAuthorization(req, rawBodyText, protocolNowMs);
    if (token) {
      if (hasVerifiedAgentAuthProof(req)) {
        res.setHeader(AGENT_AUTH_RESULT_HEADER, AGENT_AUTH_RESULT_ACCEPTED);
      }
      payload = decryptPayload(req.body, token, {
        validateTimestamp: !hasClocklessAgentAuth(req),
        nowMs: protocolNowMs,
      });
    } else if (hasSignedAgentAuthAttempt(req)) {
      throw new Error("Invalid Agent auth proof");
    } else {
      let resolved;
      try {
        resolved = decryptPayloadWithCandidates(req.body, await getCandidateAgentTokens(), { nowMs: protocolNowMs });
      } catch {
        resolved = decryptPayloadWithCandidates(req.body, await db.getAgentAuthTokenCandidates({ force: true }), { nowMs: protocolNowMs });
      }
      token = resolved.token;
      payload = resolved.payload;
      rememberEncryptedEnvelope(req.body);
    }
  } catch (err: any) {
    const message = String(err?.message || "Unauthorized");
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
    res.status(400).json({ error: "Decryption failed", message: err?.message });
    return;
  }

  const tokenForResp = token;
  const originalJson = res.json.bind(res);
  res.json = (body?: any) => {
    const env = encryptPayload(body, tokenForResp);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return originalJson(env);
  };

  next();
}
