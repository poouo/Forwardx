import assert from "node:assert/strict";
import test from "node:test";
import {
  clearTwoFactorChallenge,
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

test("unknown proxy addresses remain compatible with the challenge flow", () => {
  const challenge = createTwoFactorChallenge({
    userId: 1,
    username: "user@example.com",
    ip: "unknown",
  });
  assert.ok(getTwoFactorChallenge(challenge.challengeId, "203.0.113.10"));
  clearTwoFactorChallenge(challenge.challengeId);
});
