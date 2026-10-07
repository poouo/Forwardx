import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import jwt from "jsonwebtoken";
import { googleAuthMessage, GOOGLE_AUTH_MESSAGES } from "../shared/googleAuth";
import { GoogleFlowStore, GoogleAuthError, normalizeGoogleRedirectUri, readGoogleSettings, googleSettingsSummary, verifyGoogleClaims, exchangeGoogleCode } from "./googleOAuth";

const config = { enabled: true, clientId: "fixture.apps.googleusercontent.com", clientSecret: "never-public", redirectUri: "https://panel.example.com/api/auth/google/callback" };
const errorCode = (code: string) => (error: unknown) => error instanceof GoogleAuthError && error.code === code;

test("callback notices accept only known fixed messages, including prototype-like query values", () => {
  assert.equal(googleAuthMessage("cancelled"), GOOGLE_AUTH_MESSAGES.cancelled);
  for (const value of [undefined, null, "unknown", "toString", "__proto__", "constructor", "<script>"]) assert.equal(googleAuthMessage(value), GOOGLE_AUTH_MESSAGES.failed);
});

test("Google redirects use a fixed callback path, HTTPS or explicit loopback, never credentials or query strings", () => {
  for (const origin of ["https://panel.example.com", "http://localhost:5173", "http://127.0.0.1:9810", "http://[::1]:9810"]) {
    const value = `${origin}/api/auth/google/callback`;
    assert.equal(normalizeGoogleRedirectUri(value), value);
  }
  for (const value of ["http://panel.example.com/api/auth/google/callback", "https://x.example/other", "https://user:pass@x.example/api/auth/google/callback", "https://x.example/api/auth/google/callback?next=https://evil.example", "https://x.example/api/auth/google/callback#token", "//example.com", "javascript:alert(1)"]) assert.equal(normalizeGoogleRedirectUri(value), "");
  assert.equal(readGoogleSettings("invalid").enabled, false);
  assert.equal(readGoogleSettings("null").enabled, false);
  assert.equal(readGoogleSettings('{"enabled":"true"}').enabled, false);
  assert.ok(!JSON.stringify(googleSettingsSummary(config)).includes(config.clientSecret));
});

test("Google flow binds browser, nonce and PKCE; successful consumption is single-use", () => {
  const store = new GoogleFlowStore();
  const pending = store.create(config, "127.0.0.1", { userId: 7, sid: "authenticated-session" });
  const url = new URL(pending.url);
  assert.equal(url.origin, "https://accounts.google.com");
  assert.equal(url.searchParams.get("scope"), "openid email profile");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.ok(!pending.url.includes(config.clientSecret));
  assert.throws(() => store.consume(url.searchParams.get("state"), "another-browser", config), errorCode("invalid_state"));
  const flow = store.consume(url.searchParams.get("state"), pending.browserToken, config);
  assert.equal(flow.userId, 7); assert.equal(flow.sid, "authenticated-session");
  assert.equal(flow.nonce, url.searchParams.get("nonce"));
  assert.equal(crypto.createHash("sha256").update(flow.verifier).digest("base64url"), url.searchParams.get("code_challenge"));
  assert.throws(() => store.consume(url.searchParams.get("state"), pending.browserToken, config), errorCode("invalid_state"));
});

test("expired, disabled and changed Google configurations fail closed; state stores are bounded and rate-limited", () => {
  const store = new GoogleFlowStore(2);
  const a = store.create(config, "a", undefined, 100_000);
  const b = store.create(config, "b", undefined, 100_000);
  assert.throws(() => store.create(config, "c", undefined, 100_000), errorCode("rate_limited"));
  assert.throws(() => store.consume(new URL(a.url).searchParams.get("state"), a.browserToken, config, 800_000), errorCode("invalid_state"));
  const fresh = store.create(config, "c", undefined, 800_000);
  assert.throws(() => store.consume(new URL(fresh.url).searchParams.get("state"), fresh.browserToken, { ...config, clientSecret: "rotated" }, 800_000), errorCode("disabled"));
  assert.throws(() => store.consume(new URL(b.url).searchParams.get("state"), b.browserToken, config, 800_000), errorCode("invalid_state"));
  assert.throws(() => store.create({ ...config, enabled: false }, "a"), errorCode("disabled"));
  const rate = new GoogleFlowStore();
  for (let i = 0; i < 20; i++) {
    const item = rate.create(config, "same-ip");
    rate.consume(new URL(item.url).searchParams.get("state"), item.browserToken, config);
  }
  assert.throws(() => rate.create(config, "same-ip"), errorCode("rate_limited"));
});

test("Google ID tokens require RSA signature, issuer, audience, expiry, verified email and matching nonce/authorized party", () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const claims = { iss: "https://accounts.google.com", aud: config.clientId, sub: "google-user-123", email: "USER@example.com", email_verified: true, nonce: "fixture-nonce", exp: Math.floor(Date.now() / 1000) + 60 };
  const sign = (patch: Record<string, unknown> = {}) => jwt.sign(Object.fromEntries(Object.entries({ ...claims, ...patch }).filter(([, value]) => value !== undefined)), privateKey, { algorithm: "RS256" });
  assert.deepEqual(verifyGoogleClaims(sign(), publicKey, config.clientId, "fixture-nonce"), { subject: "google-user-123", email: "user@example.com", name: "" });
  for (const patch of [{ iss: "https://evil.example" }, { aud: "other-client" }, { email_verified: false }, { email_verified: "true" }, { nonce: "other" }, { exp: 1 }, { exp: undefined }, { email: "not-an-email" }, { sub: "" }, { azp: "other-client" }, { aud: [config.clientId, "other"] }, { iat: Math.floor(Date.now() / 1000) + 100 }]) {
    assert.throws(() => verifyGoogleClaims(sign(patch), publicKey, config.clientId, "fixture-nonce"), errorCode("invalid_identity"));
  }
  const other = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  assert.throws(() => verifyGoogleClaims(sign(), other.publicKey, config.clientId, "fixture-nonce"), errorCode("invalid_identity"));
  assert.throws(() => verifyGoogleClaims(jwt.sign(claims, "attacker", { algorithm: "HS256" }), publicKey, config.clientId, "fixture-nonce"), errorCode("invalid_identity"));
});

test("Google network errors are sanitized and concurrent outbound exchanges have a hard cap without a waiting queue", async () => {
  const original = globalThis.fetch;
  const releases: Array<() => void> = [];
  let requests = 0;
  globalThis.fetch = async (_input, init) => {
    requests++;
    assert.ok(init?.signal); assert.equal(init?.redirect, "error");
    await new Promise<void>(resolve => releases.push(resolve));
    return new Response("sensitive-provider-response", { status: 503 });
  };
  try {
    const store = new GoogleFlowStore();
    const item = store.create(config, "network-fixture");
    const flow = store.consume(new URL(item.url).searchParams.get("state"), item.browserToken, config);
    const running = Array.from({ length: 32 }, () => exchangeGoogleCode(config, flow, "code").then(() => null, error => error));
    assert.equal(requests, 32);
    await assert.rejects(exchangeGoogleCode(config, flow, "overflow"), errorCode("rate_limited"));
    assert.equal(requests, 32);
    for (const release of releases) release();
    const errors = await Promise.all(running);
    assert.ok(errors.every(error => errorCode("provider_error")(error)));
    assert.ok(errors.every(error => !String(error).includes("sensitive-provider-response")));
    // Every failure released its capacity.
    await assert.rejects(exchangeGoogleCode(config, flow, ""), errorCode("invalid_identity"));
  } finally {
    for (const release of releases) release();
    globalThis.fetch = original;
  }
});

test("real SQLite and HTTP Google login, explicit linking, permissions, disabled registration/account, 2FA and password recovery", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-google-auth-"));
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "server/googleOAuth.fixture.ts"], {
      encoding: "utf8", timeout: 60_000,
      env: { ...process.env, DATABASE_TYPE: "sqlite", SQLITE_PATH: path.join(directory, "google.db"), JWT_SECRET: "google-fixture-secret-that-is-long-enough", FORWARDX_DEV_PANEL: "0", FORWARDX_LOG_DIR: path.join(directory, "logs") },
    });
    assert.equal(result.status, 0, result.stderr + result.stdout);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
