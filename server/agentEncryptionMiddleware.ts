import { Request, Response, NextFunction } from "express";
import { decryptPayload, decryptPayloadWithCandidates, encryptPayload, isEncryptedEnvelope, rememberEncryptedEnvelope } from "./agentCrypto";
import { getCandidateAgentTokens, resolveAgentTokenFromAuthorization } from "./agentAuth";

export const AGENT_TUNNEL_PATHS = new Set([
  "/api/agent/register",
  "/api/agent/heartbeat",
  "/api/agent/selftest-pull",
  "/api/agent/selftest-result",
  "/api/agent/looking-glass-result",
  "/api/agent/looking-glass-progress",
  "/api/agent/iperf3-result",
  "/api/agent/traffic",
  "/api/agent/tcping",
  "/api/agent/protocol-block",
  "/api/agent/rule-status",
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
  try {
    token = await resolveAgentTokenFromAuthorization(req, rawBodyText);
    if (token) {
      payload = decryptPayload(req.body, token);
    } else {
      const resolved = decryptPayloadWithCandidates(req.body, await getCandidateAgentTokens());
      token = resolved.token;
      payload = resolved.payload;
      rememberEncryptedEnvelope(req.body);
    }
  } catch (err: any) {
    res.status(401).json({ error: "Unauthorized", message: err?.message });
    return;
  }
  if (!token) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
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
