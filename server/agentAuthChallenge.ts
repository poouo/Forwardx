import crypto from "node:crypto";
import { performance } from "node:perf_hooks";

const CHALLENGE_RANDOM_BYTES = 24;
const CHALLENGE_MAC_BYTES = 32;
const CHALLENGE_PAYLOAD_BYTES = 8 + CHALLENGE_RANDOM_BYTES;
const CHALLENGE_BYTES = CHALLENGE_PAYLOAD_BYTES + CHALLENGE_MAC_BYTES;
const CHALLENGE_VALIDITY_MS = 10 * 60 * 1000;
const CHALLENGE_FUTURE_TOLERANCE_MS = 1_000;
const CONSUMED_CACHE_CLEANUP_INTERVAL_MS = 10_000;
const challengeSecret = crypto.randomBytes(32);
const consumedChallenges = new Map<string, number>();
let consumedCacheCleanupAt = 0;

function challengeMac(payload: Buffer) {
  return crypto.createHmac("sha256", challengeSecret).update("forwardx-agent-challenge-v2\n").update(payload).digest();
}

function decodeChallenge(value: string) {
  if (!/^[A-Za-z0-9_-]{80,100}$/.test(value)) return null;
  try {
    const decoded = Buffer.from(value, "base64url");
    if (decoded.length !== CHALLENGE_BYTES || decoded.toString("base64url") !== value) return null;
    return decoded;
  } catch {
    return null;
  }
}

function cleanupConsumedChallenges(nowMs: number) {
  if (nowMs < consumedCacheCleanupAt) return;
  consumedCacheCleanupAt = nowMs + CONSUMED_CACHE_CLEANUP_INTERVAL_MS;
  for (const [challenge, expiresAt] of consumedChallenges) {
    if (expiresAt <= nowMs) consumedChallenges.delete(challenge);
  }
}

export function issueAgentAuthChallenge(nowMs = performance.now()) {
  const payload = Buffer.alloc(CHALLENGE_PAYLOAD_BYTES);
  payload.writeBigUInt64BE(BigInt(Math.max(0, Math.floor(nowMs))), 0);
  crypto.randomFillSync(payload, 8, CHALLENGE_RANDOM_BYTES);
  return Buffer.concat([payload, challengeMac(payload)]).toString("base64url");
}

export function validateAgentAuthChallenge(challenge: string, nowMs = performance.now()) {
  const decoded = decodeChallenge(challenge);
  if (!decoded) return false;
  const payload = decoded.subarray(0, CHALLENGE_PAYLOAD_BYTES);
  const receivedMac = decoded.subarray(CHALLENGE_PAYLOAD_BYTES);
  const expectedMac = challengeMac(payload);
  if (!crypto.timingSafeEqual(receivedMac, expectedMac)) return false;
  const issuedAtMs = Number(payload.readBigUInt64BE(0));
  const ageMs = nowMs - issuedAtMs;
  return ageMs >= -CHALLENGE_FUTURE_TOLERANCE_MS && ageMs <= CHALLENGE_VALIDITY_MS;
}

export function consumeAgentAuthChallenge(challenge: string, nowMs = performance.now()) {
  if (!validateAgentAuthChallenge(challenge, nowMs)) return false;
  cleanupConsumedChallenges(nowMs);
  const existingExpiry = consumedChallenges.get(challenge) || 0;
  if (existingExpiry > nowMs) return false;
  consumedChallenges.set(challenge, nowMs + CHALLENGE_VALIDITY_MS);
  return true;
}

export function issueAgentAuthChallenges(countValue: unknown) {
  const count = Math.min(32, Math.max(1, Number.parseInt(String(countValue || "16"), 10) || 16));
  return Array.from({ length: count }, () => issueAgentAuthChallenge());
}

export function resetAgentAuthChallengesForTests() {
  consumedChallenges.clear();
  consumedCacheCleanupAt = 0;
}
