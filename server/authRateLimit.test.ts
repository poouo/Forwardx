import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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

test("periodic 2FA cleanup terminates and preserves active account and IP limits", () => {
  // Isolate the synchronous cleanup: a live Map iteration regression must not
  // block the whole test runner or leave a CPU-bound background process behind.
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import {
      recordTwoFactorChallengeIssue, pruneAuthRateLimitState,
      twoFactorChallengeIssueState, authRateLimitStoreSizesForTests,
    } from ${JSON.stringify(new URL("./authRateLimit.ts", import.meta.url).href)};
    recordTwoFactorChallengeIssue("192.0.2.3", "expired", 900);
    recordTwoFactorChallengeIssue("192.0.2.1", "mixed", 1000);
    for (let i = 0; i < 4; i++) recordTwoFactorChallengeIssue("192.0.2.1", "mixed", 1500);
    for (let i = 0; i < 5; i++) recordTwoFactorChallengeIssue("192.0.2.2", "active", 2000);

    pruneAuthRateLimitState(2100);
    pruneAuthRateLimitState(2100);
    assert.equal(authRateLimitStoreSizesForTests().challengeIssues, 9);
    assert.equal(twoFactorChallengeIssueState("192.0.2.1", "mixed", 2100).limited, true);

    // Old timestamps disappear, but valid timestamps continue to count.
    pruneAuthRateLimitState(61000);
    pruneAuthRateLimitState(61000);
    assert.equal(authRateLimitStoreSizesForTests().challengeIssues, 6);
    assert.equal(twoFactorChallengeIssueState("192.0.2.1", "mixed", 61000).limited, false);
    recordTwoFactorChallengeIssue("192.0.2.1", "mixed", 61001);
    assert.equal(twoFactorChallengeIssueState("192.0.2.1", "mixed", 61001).limited, true);
    assert.equal(twoFactorChallengeIssueState("192.0.2.2", "active", 61001).limited, true);
    assert.equal(twoFactorChallengeIssueState("192.0.2.99", "active", 61001).limited, true);
    assert.equal(twoFactorChallengeIssueState("192.0.2.2", "another-user", 61001).limited, true);

    pruneAuthRateLimitState(121001);
    assert.deepEqual(authRateLimitStoreSizesForTests(), { failures: 0, challengeIssues: 0 });
  `], { timeout: 10_000, encoding: "utf8", windowsHide: true });
  assert.equal(result.error, undefined, `2FA cleanup child failed: ${result.error}\n${result.stderr}`);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
