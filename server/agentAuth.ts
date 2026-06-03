import type { Request } from "express";
import * as db from "./db";
import { verifyAgentAuthProof } from "./agentCrypto";

export function getResolvedAgentToken(req: Request): string | undefined {
  return (req as any).agentToken || undefined;
}

export async function getAgentHostFromRequest(req: Request) {
  const token = getResolvedAgentToken(req);
  if (!token) return null;
  return db.getHostByAgentToken(token);
}

export async function getCandidateAgentTokens() {
  return db.getAgentAuthTokenCandidates();
}

export async function resolveAgentTokenFromAuthorization(req: Request, bodyText = "") {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) return null;
  const credential = authHeader.substring(7).trim();
  if (!credential) return null;
  if (!credential.startsWith("v1.")) return credential;
  const tokens = await getCandidateAgentTokens();
  return verifyAgentAuthProof({
    raw: credential,
    candidateTokens: tokens,
    method: req.method,
    path: req.path,
    bodyText,
  });
}
