import assert from "node:assert/strict";
import test from "node:test";
import { SlidingWindowRateLimiter } from "./rateLimiter";

test("limits one identity without affecting another identity", () => {
  let now = 1_000;
  const limiter = new SlidingWindowRateLimiter({ limit: 2, windowMs: 1_000, now: () => now });
  assert.equal(limiter.consume("user:1").allowed, true);
  assert.equal(limiter.consume("user:1").allowed, true);
  const denied = limiter.consume("user:1");
  assert.equal(denied.allowed, false);
  assert.equal(denied.retryAfterMs, 1_000);
  assert.equal(limiter.consume("user:2").allowed, true);
  now = 2_001;
  assert.equal(limiter.consume("user:1").allowed, true);
});
