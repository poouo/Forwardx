import type { Request } from "express";
import * as db from "./db";
import { agentTokenFingerprint, parseAgentAuthProof, verifyAgentAuthProof } from "./agentCrypto";

let indexedTokens: string[] | null = null;
let tokenByFingerprint = new Map<string, string>();

function tokenCandidateForProof(raw: string, tokens: string[]) {
  const proof = parseAgentAuthProof(raw);
  if (!proof) return null;
  if (indexedTokens !== tokens) {
    indexedTokens = tokens;
    tokenByFingerprint = new Map(tokens.map((token) => [agentTokenFingerprint(token), token]));
  }
  return tokenByFingerprint.get(proof.fingerprint) || null;
}

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
  const verify = (tokens: string[]) => {
    const candidate = tokenCandidateForProof(credential, tokens);
    if (!candidate) return null;
    return verifyAgentAuthProof({
      raw: credential,
      candidateTokens: [candidate],
      method: req.method,
      path: req.path,
      bodyText,
    });
  };
  const token = verify(await getCandidateAgentTokens());
  if (token) return token;
  return verify(await db.getAgentAuthTokenCandidates({ force: true }));
}
