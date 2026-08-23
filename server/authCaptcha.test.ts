import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  AuthCaptchaService,
  CaptchaRefreshRateLimitError,
} from "./authCaptcha";

function createService(overrides: ConstructorParameters<typeof AuthCaptchaService>[0] = {}) {
  return new AuthCaptchaService({
    challengeTtlMs: 1_000,
    requirementTtlMs: 10_000,
    failureThreshold: 3,
    refreshWindowMs: 1_000,
    refreshMaxPerWindow: 3,
    svgGenerator: () => ({ text: "A7K9P", data: "<svg></svg>" }),
    ...overrides,
  });
}

function capPrng(seed: string, length: number) {
  let state = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    state ^= seed.charCodeAt(index);
    state += (state << 1) + (state << 4) + (state << 7) + (state << 8) + (state << 24);
  }
  state >>>= 0;
  let result = "";
  while (result.length < length) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    result += (state >>> 0).toString(16).padStart(8, "0");
  }
  return result.substring(0, length);
}

function capSolutions(token: string, challenge: { c: number; s: number; d: number }) {
  return Array.from({ length: challenge.c }, (_, index) => {
    const salt = capPrng(`${token}${index + 1}`, challenge.s);
    const target = capPrng(`${token}${index + 1}d`, challenge.d);
    for (let nonce = 0; nonce < 2_000_000; nonce += 1) {
      const digest = createHash("sha256").update(`${salt}${nonce}`).digest("hex");
      if (digest.startsWith(target)) return nonce;
    }
    throw new Error("unable to solve Cap test challenge");
  });
}

test("requires a captcha after three failures and survives a new browser session", () => {
  const service = createService();
  service.recordLoginFailure("203.0.113.8", "User@example.com", 1_000);
  service.recordLoginFailure("203.0.113.8", "user@example.com", 1_100);
  assert.equal(service.requiresLoginCaptcha("203.0.113.8", "USER@example.com", 1_200), false);

  service.recordLoginFailure("203.0.113.8", "user@example.com", 1_300);
  assert.equal(service.requiresLoginCaptcha("203.0.113.8", "user@example.com", 1_400), true);
  assert.equal(service.requiresLoginCaptcha("203.0.113.9", "user@example.com", 1_400), false);
});

test("solving a captcha or waiting for the requirement window removes the gate", () => {
  const service = createService();
  for (let index = 0; index < 3; index += 1) {
    service.recordLoginFailure("198.51.100.4", "demo", 2_000 + index);
  }
  assert.equal(service.requiresLoginCaptcha("198.51.100.4", "demo", 2_100), true);

  service.clearLoginCaptchaRequirement("198.51.100.4", "demo");
  assert.equal(service.requiresLoginCaptcha("198.51.100.4", "demo", 2_200), false);

  for (let index = 0; index < 3; index += 1) {
    service.recordLoginFailure("198.51.100.4", "demo", 3_000 + index);
  }
  assert.equal(service.requiresLoginCaptcha("198.51.100.4", "demo", 13_100), false);
});

test("image challenges are IP-bound, purpose-bound, expiring, and single-use", () => {
  const service = createService();
  const first = service.createImageChallenge("192.0.2.10", "login", 10_000);
  assert.match(first.imageDataUrl, /^data:image\/svg\+xml;base64,/);
  assert.equal(service.verifyChallenge(first.captchaId, "a7k9p", "192.0.2.10", "login", 10_500), true);
  assert.equal(service.verifyChallenge(first.captchaId, "A7K9P", "192.0.2.10", "login", 10_600), false);

  const wrongIp = service.createImageChallenge("192.0.2.10", "login", 10_700);
  assert.equal(service.verifyChallenge(wrongIp.captchaId, "A7K9P", "192.0.2.11", "login", 10_800), false);

  const wrongPurpose = service.createImageChallenge("192.0.2.10", "register", 10_900);
  assert.equal(service.verifyChallenge(wrongPurpose.captchaId, "A7K9P", "192.0.2.10", "login", 11_000), false);

  const expiredService = createService();
  const expired = expiredService.createImageChallenge("192.0.2.10", "login", 20_000);
  assert.equal(expiredService.verifyChallenge(expired.captchaId, "A7K9P", "192.0.2.10", "login", 21_001), false);
});

test("limits challenge generation per IP and releases the limit after the window", () => {
  const service = createService();
  service.createImageChallenge("203.0.113.9", "login", 30_000);
  service.createImageChallenge("203.0.113.9", "login", 30_100);
  service.createImageChallenge("203.0.113.9", "login", 30_200);

  assert.throws(
    () => service.createImageChallenge("203.0.113.9", "login", 30_300),
    (error) => error instanceof CaptchaRefreshRateLimitError && error.retryAfterSeconds === 1,
  );
  assert.doesNotThrow(() => service.createImageChallenge("203.0.113.9", "login", 31_001));
  assert.doesNotThrow(() => service.createImageChallenge("203.0.113.10", "login", 30_300));
});

test("bounds attacker-controlled rate-limit keys and prunes expired entries", () => {
  const service = createService({ maxRateLimitKeys: 3 });
  for (let index = 0; index < 10; index += 1) {
    service.recordLoginFailure(`192.0.2.${index}`, `user-${index}`, 40_000 + index);
    service.createImageChallenge(`198.51.100.${index}`, "login", 40_000 + index);
  }
  assert.equal(service.stateSizesForTest().loginFailures, 3);
  assert.equal(service.stateSizesForTest().refreshTimestamps, 3);

  service.pruneExpired(51_000);
  assert.equal(service.stateSizesForTest().loginFailures, 0);
  assert.equal(service.stateSizesForTest().refreshTimestamps, 0);
});

test("Cap challenges are bound to IP and purpose and tokens are single-use", async () => {
  const service = createService();
  const issued = await service.createCapChallenge("192.0.2.40", "login");
  assert.ok(issued.token);
  const solutions = capSolutions(issued.token!, issued.challenge);
  const redeemed = await service.redeemCapChallenge("192.0.2.40", "login", issued.token!, solutions);
  assert.equal(redeemed.success, true);
  assert.ok(redeemed.token);
  assert.equal(await service.verifyCapToken("192.0.2.41", "login", redeemed.token!), false);
  assert.equal(await service.verifyCapToken("192.0.2.40", "register", redeemed.token!), false);
  assert.equal(await service.verifyCapToken("192.0.2.40", "login", redeemed.token!), true);
  assert.equal(await service.verifyCapToken("192.0.2.40", "login", redeemed.token!), false);
});
