import assert from "node:assert/strict";
import test from "node:test";
import {
  clearTwoFactorChallenge,
  clearTwoFactorChallengesForUser,
  createTwoFactorChallenge,
  getTwoFactorChallenge,
} from "./twoFactorChallenges";

test("2FA challenge is bound to the source IP when both addresses are known", () => {
  const challenge = createTwoFactorChallenge({
    userId: 1,
    username: "user@example.com",
    ip: "203.0.113.10",
  });
  assert.ok(getTwoFactorChallenge(challenge.challengeId, "203.0.113.10"));
  assert.equal(getTwoFactorChallenge(challenge.challengeId, "203.0.113.11"), null);
  clearTwoFactorChallenge(challenge.challengeId);
});

test("password recovery can clear only the affected user's pending 2FA logins", () => {
  const own = createTwoFactorChallenge({ userId: 101, username: "alice", passwordHash: "old-hash" });
  const other = createTwoFactorChallenge({ userId: 102, username: "bob", passwordHash: "other-hash" });
  assert.equal(getTwoFactorChallenge(own.challengeId)?.passwordHash, "old-hash");
  clearTwoFactorChallengesForUser(101);
  assert.equal(getTwoFactorChallenge(own.challengeId), null);
  assert.ok(getTwoFactorChallenge(other.challengeId));
  clearTwoFactorChallenge(other.challengeId);
});

test("unknown proxy addresses remain compatible with the challenge flow", () => {
  const challenge = createTwoFactorChallenge({
    userId: 1,
    username: "user@example.com",
    ip: "unknown",
  });
  assert.ok(getTwoFactorChallenge(challenge.challengeId, "203.0.113.10"));
  clearTwoFactorChallenge(challenge.challengeId);
});
