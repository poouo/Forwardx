import crypto from "crypto";

type TwoFactorChallenge = {
  userId: number;
  username: string;
  mobile: boolean;
  /** Source address that completed the password step. */
  issueIp: string;
  expiresAt: number;
  attempts: number;
};

const TWO_FACTOR_CHALLENGE_TTL_MS = 5 * 60 * 1000;
const TWO_FACTOR_CHALLENGE_MAX_ATTEMPTS = 5;
const challenges = new Map<string, TwoFactorChallenge>();

function normalizeIp(ip: unknown) {
  return String(ip || "unknown").trim().toLowerCase() || "unknown";
}

function challengeIpMatches(issueIp: string, requestIp: string) {
  // Some deployments cannot determine a reliable peer address (for example,
  // an untrusted proxy or a test client). Do not lock out those clients, but
  // bind challenges whenever both sides provide a concrete address.
  const issued = normalizeIp(issueIp);
  const requested = normalizeIp(requestIp);
  if (issued === "unknown" || requested === "unknown") return true;
  return issued === requested;
}

function pruneExpired(now = Date.now()) {
  for (const [id, challenge] of challenges) {
    if (challenge.expiresAt <= now) challenges.delete(id);
  }
}

export function createTwoFactorChallenge(input: { userId: number; username: string; mobile?: boolean; ip?: string }) {
  pruneExpired();
  const challengeId = crypto.randomBytes(24).toString("hex");
  challenges.set(challengeId, {
    userId: input.userId,
    username: input.username,
    mobile: !!input.mobile,
    issueIp: normalizeIp(input.ip),
    expiresAt: Date.now() + TWO_FACTOR_CHALLENGE_TTL_MS,
    attempts: 0,
  });
  return {
    challengeId,
    expiresInSeconds: Math.floor(TWO_FACTOR_CHALLENGE_TTL_MS / 1000),
  };
}

export function getTwoFactorChallenge(challengeId: string, requestIp?: string) {
  const challenge = challenges.get(challengeId);
  if (!challenge) return null;
  if (challenge.expiresAt <= Date.now()) {
    challenges.delete(challengeId);
    return null;
  }
  if (requestIp !== undefined && !challengeIpMatches(challenge.issueIp, requestIp)) return null;
  return challenge;
}

export function clearTwoFactorChallenge(challengeId: string) {
  challenges.delete(challengeId);
}

export function recordTwoFactorChallengeFailure(challengeId: string) {
  const challenge = getTwoFactorChallenge(challengeId);
  if (!challenge) return false;
  challenge.attempts += 1;
  if (challenge.attempts >= TWO_FACTOR_CHALLENGE_MAX_ATTEMPTS) {
    challenges.delete(challengeId);
    return false;
  }
  return true;
}
