import { Request, Response, NextFunction } from "express";
import { decryptPayload, encryptPayload, isEncryptedEnvelope } from "./agentCrypto";

export function agentEncryptionMiddleware(req: Request, res: Response, next: NextFunction) {
  const encHeader = req.header("X-Agent-Encrypted");
  if (encHeader !== "1" || !isEncryptedEnvelope(req.body)) {
    res.status(401).json({
      error: "Encrypted communication required",
      hint: "This server only accepts AES-256-CTR + HMAC-SHA256 encrypted requests. Please upgrade your Agent.",
    });
    return;
  }

  let token: string | undefined;
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    token = authHeader.substring(7);
  }
  if (!token) {
    res.status(401).json({ error: "Encrypted request missing token" });
    return;
  }

  try {
    req.body = decryptPayload(req.body, token);
  } catch (err: any) {
    res.status(400).json({ error: "Decryption failed", message: err?.message });
    return;
  }

  const tokenForResp = token;
  const originalJson = res.json.bind(res);
  res.json = (body?: any) => {
    const env = encryptPayload(body, tokenForResp);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("X-Agent-Encrypted", "1");
    return originalJson(env);
  };

  next();
}
