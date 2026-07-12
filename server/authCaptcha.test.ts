import assert from "node:assert/strict";
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
