/**
 * Agent <-> 面板 通讯加密模块（AES-256-CTR + HMAC-SHA256）
 *
 * 选用 CTR + HMAC（Encrypt-then-MAC）的原因：
 *   - Agent 和面板两端实现简单稳定
 *   - HMAC 覆盖 iv/ct/ts，服务端可在解密前验证完整性
 *
 * 协议：
 *   key_enc = SHA-256(token | "forwardx-agent-v1")        // 32 bytes，AES-256-CTR 密钥
 *   key_mac = SHA-256(token | "forwardx-agent-mac")       // 32 bytes，HMAC-SHA256 密钥
 *   iv      = 16 bytes 随机
 *   ct      = AES-256-CTR(key_enc, iv, plaintext_utf8)
 *   mac     = HMAC-SHA256(key_mac, "v1" || iv || ct || ts_bytes_8)
 *   信封    = { v:1, iv:<hex>, ct:<hex>, mac:<hex>, ts:<unix_ms> }
 *
 *   防重放：服务器对比 ts，超过 ±5 分钟拒绝
 *   关联消息：HMAC 把 iv/ct/ts 都覆盖，篡改任一字段即失败
 */
import crypto from "crypto";

const KEY_SALT_ENC = "forwardx-agent-v1";
const KEY_SALT_MAC = "forwardx-agent-mac";
const KEY_SALT_AUTH = "forwardx-agent-auth";
const KEY_SALT_AUTH_ID = "forwardx-agent-auth-id";
const IV_LEN = 16;
const REPLAY_WINDOW_MS = 5 * 60 * 1000;
const REPLAY_CACHE_CLEANUP_INTERVAL_MS = 10 * 1000;
const DERIVED_KEY_CACHE_LIMIT = 4096;
const seenEnvelopeMacs = new Map<string, number>();
const seenAuthProofs = new Map<string, number>();
const replayCacheCleanupAt = new WeakMap<Map<string, number>, number>();
const derivedKeyCache = new Map<string, {
  enc: Buffer;
  mac: Buffer;
  auth: Buffer;
  fingerprint: string;
}>();
let replayCacheCleanupSweeps = 0;

function derivedKeys(token: string) {
  const cached = derivedKeyCache.get(token);
  if (cached) return cached;
  if (derivedKeyCache.size >= DERIVED_KEY_CACHE_LIMIT) derivedKeyCache.clear();
  const keys = {
    enc: crypto.createHash("sha256").update(`${token}|${KEY_SALT_ENC}`).digest(),
    mac: crypto.createHash("sha256").update(`${token}|${KEY_SALT_MAC}`).digest(),
    auth: crypto.createHash("sha256").update(`${token}|${KEY_SALT_AUTH}`).digest(),
    fingerprint: crypto.createHash("sha256").update(`${token}|${KEY_SALT_AUTH_ID}`).digest("hex").slice(0, 32),
  };
  derivedKeyCache.set(token, keys);
  return keys;
}

function deriveEncKey(token: string): Buffer {
  return derivedKeys(token).enc;
}

function deriveMacKey(token: string): Buffer {
  return derivedKeys(token).mac;
}

function deriveAuthKey(token: string): Buffer {
  return derivedKeys(token).auth;
}

export interface EncryptedEnvelope {
  v: number;
  iv: string;  // hex
  ct: string;  // hex
  mac: string; // hex
  ts: number;  // unix ms
}

export function isEncryptedEnvelope(body: any): body is EncryptedEnvelope {
  return (
    body && typeof body === "object" &&
    body.v === 1 &&
    typeof body.iv === "string" &&
    typeof body.ct === "string" &&
    typeof body.mac === "string" &&
    typeof body.ts === "number"
  );
}

export function agentTokenFingerprint(token: string): string {
  return derivedKeys(token).fingerprint;
}

function cleanupReplayCache(cache: Map<string, number>, now: number) {
  if (now < (replayCacheCleanupAt.get(cache) || 0)) return;
  replayCacheCleanupAt.set(cache, now + REPLAY_CACHE_CLEANUP_INTERVAL_MS);
  replayCacheCleanupSweeps += 1;
  for (const [key, expiresAt] of cache) {
    if (expiresAt <= now) cache.delete(key);
  }
}

function rememberOnce(cache: Map<string, number>, key: string, errorMessage: string) {
  const now = Date.now();
  const existingExpiry = cache.get(key) || 0;
  if (existingExpiry > now) throw new Error(errorMessage);
  if (existingExpiry > 0) cache.delete(key);
  cleanupReplayCache(cache, now);
  cache.set(key, now + REPLAY_WINDOW_MS);
}

export function getAgentCryptoCacheStats() {
  return {
    envelopeReplayEntries: seenEnvelopeMacs.size,
    authReplayEntries: seenAuthProofs.size,
    derivedKeyEntries: derivedKeyCache.size,
    replayCleanupSweeps: replayCacheCleanupSweeps,
  };
}

export function resetAgentCryptoCaches() {
  seenEnvelopeMacs.clear();
  seenAuthProofs.clear();
  derivedKeyCache.clear();
  replayCacheCleanupAt.set(seenEnvelopeMacs, 0);
  replayCacheCleanupAt.set(seenAuthProofs, 0);
  replayCacheCleanupSweeps = 0;
}

function timingSafeEqualHex(a: string, b: string): boolean {
  try {
    const left = Buffer.from(a, "hex");
    const right = Buffer.from(b, "hex");
    return left.length === right.length && crypto.timingSafeEqual(left, right);
  } catch {
    return false;
  }
}

function authInput(method: string, path: string, bodyText: string, ts: number, nonce: string): string {
  const bodyHash = crypto.createHash("sha256").update(bodyText || "", "utf8").digest("hex");
  return ["v1", method.toUpperCase(), path, String(ts), nonce, bodyHash].join("\n");
}

export function signAgentAuthProof(input: {
  token: string;
  method: string;
  path: string;
  bodyText?: string;
  ts: number;
  nonce: string;
}): string {
  return crypto
    .createHmac("sha256", deriveAuthKey(input.token))
    .update(authInput(input.method, input.path, input.bodyText || "", input.ts, input.nonce))
    .digest("hex");
}

export function parseAgentAuthProof(raw: string | undefined | null) {
  const value = String(raw || "").trim();
  const match = /^v1\.([a-f0-9]{32})\.(\d{10,})\.([a-f0-9]{16,64})\.([a-f0-9]{64})$/i.exec(value);
  if (!match) return null;
  return {
    fingerprint: match[1].toLowerCase(),
    ts: Number(match[2]),
    nonce: match[3].toLowerCase(),
    sig: match[4].toLowerCase(),
  };
}

export function rememberEncryptedEnvelope(envelope: EncryptedEnvelope) {
  rememberOnce(seenEnvelopeMacs, envelope.mac, "Encrypted request replay detected");
}

export function verifyAgentAuthProof(input: {
  raw: string;
  candidateTokens: string[];
  method: string;
  path: string;
  bodyText?: string;
}): string | null {
  const proof = parseAgentAuthProof(input.raw);
  if (!proof || !Number.isFinite(proof.ts)) return null;
  if (Math.abs(Date.now() - proof.ts) > REPLAY_WINDOW_MS) return null;

  const token = input.candidateTokens.find((item) => agentTokenFingerprint(item) === proof.fingerprint);
  if (!token) return null;
  const expected = signAgentAuthProof({
    token,
    method: input.method,
    path: input.path,
    bodyText: input.bodyText || "",
    ts: proof.ts,
    nonce: proof.nonce,
  });
  if (!timingSafeEqualHex(expected, proof.sig)) return null;
  rememberOnce(seenAuthProofs, `${proof.fingerprint}:${proof.ts}:${proof.nonce}:${proof.sig}`, "Agent auth replay detected");
  return token;
}

function macInput(iv: Buffer, ct: Buffer, ts: number): Buffer {
  const tsBuf = Buffer.alloc(8);
  // 写入 64 位毫秒大端
  tsBuf.writeBigUInt64BE(BigInt(ts));
  return Buffer.concat([Buffer.from("v1"), iv, ct, tsBuf]);
}

/** 加密一段 JSON 可序列化数据 */
export function encryptPayload(payload: any, token: string): EncryptedEnvelope {
  const keyEnc = deriveEncKey(token);
  const keyMac = deriveMacKey(token);
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv("aes-256-ctr", keyEnc, iv);
  const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const ts = Date.now();
  const mac = crypto.createHmac("sha256", keyMac).update(macInput(iv, ct, ts)).digest();
  return {
    v: 1,
    iv: iv.toString("hex"),
    ct: ct.toString("hex"),
    mac: mac.toString("hex"),
    ts,
  };
}

/** 解密信封；解密失败抛错 */
export function decryptPayload(envelope: EncryptedEnvelope, token: string, options: { rememberReplay?: boolean } = {}): any {
  const keyEnc = deriveEncKey(token);
  const keyMac = deriveMacKey(token);
  const iv = Buffer.from(envelope.iv, "hex");
  const ct = Buffer.from(envelope.ct, "hex");
  const macReceived = Buffer.from(envelope.mac, "hex");
  if (iv.length !== IV_LEN) throw new Error("Invalid IV length");

  if (Math.abs(Date.now() - envelope.ts) > REPLAY_WINDOW_MS) {
    throw new Error("Request timestamp out of window (replay protection)");
  }

  const macExpected = crypto.createHmac("sha256", keyMac).update(macInput(iv, ct, envelope.ts)).digest();
  if (macExpected.length !== macReceived.length || !crypto.timingSafeEqual(macExpected, macReceived)) {
    throw new Error("MAC verification failed");
  }
  if (options.rememberReplay !== false) {
    rememberOnce(seenEnvelopeMacs, envelope.mac, "Encrypted request replay detected");
  }

  const decipher = crypto.createDecipheriv("aes-256-ctr", keyEnc, iv);
  const plaintext = Buffer.concat([decipher.update(ct), decipher.final()]);
  return JSON.parse(plaintext.toString("utf8"));
}

export function decryptPayloadWithCandidates(envelope: EncryptedEnvelope, tokens: string[]) {
  let lastError: Error | null = null;
  for (const token of tokens) {
    try {
      return {
        token,
        payload: decryptPayload(envelope, token, { rememberReplay: false }),
      };
    } catch (error: any) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }
  throw lastError || new Error("No token candidates available");
}
