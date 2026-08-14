import assert from "node:assert/strict";
import test from "node:test";
import {
  authRateLimitState,
  authRateLimitStoreSizesForTests,
  clearAuthAccountFailures,
  clearAuthRateLimitStateForTests,
  recordAuthFailure,
  recordPasswordFailure,
  recordTwoFactorFailure,
  recordTwoFactorChallengeIssue,
  pruneAuthRateLimitState,
  twoFactorChallengeIssueState,
} from "./authRateLimit";

test.afterEach(() => {
  clearAuthRateLimitStateForTests();
});

test("2FA failures share the account and IP budget across fresh challenges", () => {
  const ip = "203.0.113.10";
  const username = "Admin@Example.com";
  const now = 1_800_000_000_000;

  for (let attempt = 0; attempt < 8; attempt += 1) {
    recordAuthFailure(ip, username, now + attempt);
  }

  const limited = authRateLimitState(ip, username, now + 8);
  assert.equal(limited.limited, true);
  assert.ok(limited.retryAfterSeconds > 0);
  assert.equal(authRateLimitState(ip, "admin@example.com", now + 8).limited, true);

  clearAuthAccountFailures(ip, username);
  assert.equal(authRateLimitState(ip, username, now + 8).limited, false);
});

test("password failures do not create a cross-IP account lock", () => {
  const username = "user@example.com";
  const now = 1_800_000_100_000;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    recordPasswordFailure("203.0.113.20", username, now + attempt);
  }

  assert.equal(authRateLimitState("203.0.113.20", username, now + 8).limited, true);
  assert.equal(authRateLimitState("203.0.113.21", username, now + 8).limited, false);
});

test("known-account 2FA failures do create a cross-IP account lock", () => {
  const username = "user@example.com";
  const now = 1_800_000_200_000;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    recordTwoFactorFailure("198.51.100.20", username, now + attempt);
  }

  assert.equal(authRateLimitState("198.51.100.21", username, now + 8).limited, true);
});

test("2FA challenge issuance is limited independently of per-challenge attempts", () => {
  const ip = "198.51.100.20";
  const username = "user@example.com";
  const now = 1_800_000_000_000;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.equal(twoFactorChallengeIssueState(ip, username, now + attempt).limited, false);
    recordTwoFactorChallengeIssue(ip, username, now + attempt);
  }
  const limited = twoFactorChallengeIssueState(ip, username, now + 5);
  assert.equal(limited.limited, true);
  assert.ok(limited.retryAfterSeconds > 0);
});

test("periodic maintenance removes expired failure and challenge keys", () => {
  const now = 1_800_000_000_000;
  recordPasswordFailure("192.0.2.1", "expired-user", now);
  recordTwoFactorChallengeIssue("192.0.2.1", "expired-user", now);
  assert.ok(authRateLimitStoreSizesForTests().failures > 0);
  assert.ok(authRateLimitStoreSizesForTests().challengeIssues > 0);

  pruneAuthRateLimitState(now + 31 * 60 * 1000);
  assert.deepEqual(authRateLimitStoreSizesForTests(), { failures: 0, challengeIssues: 0 });
});
