import assert from "node:assert/strict";
import crypto from "node:crypto";
import express from "express";
import cookieParser from "cookie-parser";
import jwt from "jsonwebtoken";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { appRouter } from "./routers";
import { createContext } from "./_core/context";
import * as runtime from "./dbRuntime";
import { ensureDatabaseSchema } from "./dbSchema";
import { createUser, getUserById, verifyUserPassword } from "./repositories/userRepository";
import { getSetting, setSetting } from "./repositories/settingsRepository";
import { issueLoginSession } from "./routers/auth";
import { registerGoogleAuthRoutes } from "./googleAuthRoutes";
import { GOOGLE_SETTINGS_KEY, GOOGLE_FLOW_COOKIE } from "./googleOAuth";
import { GOOGLE_RESULT_COOKIE } from "./routers/google";
import { COOKIE_NAME } from "../shared/const";

const networkFetch = globalThis.fetch;
const keys = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const codes = new Map<string, { nonce: string; challenge: string; claims: Record<string, unknown> }>();
let tokenRequests = 0;
let certRequests = 0;
globalThis.fetch = async (input: any, init?: RequestInit) => {
  const url = String(input);
  if (url === "https://www.googleapis.com/oauth2/v3/certs") {
    certRequests++;
    return Response.json({ keys: [{ ...keys.publicKey.export({ format: "jwk" }), kid: "fixture-key", alg: "RS256", use: "sig" }] });
  }
  if (url === "https://oauth2.googleapis.com/token") {
    tokenRequests++;
    assert.equal(init?.redirect, "error"); assert.ok(init?.signal);
    const body = new URLSearchParams(String(init?.body));
    const item = codes.get(body.get("code")!); assert.ok(item, "unknown authorization code");
    codes.delete(body.get("code")!);
    assert.equal(crypto.createHash("sha256").update(body.get("code_verifier")!).digest("base64url"), item.challenge);
    assert.equal(body.get("client_secret"), "fixture-client-secret");
    assert.equal(body.get("grant_type"), "authorization_code");
    return Response.json({ id_token: jwt.sign({ iss: "https://accounts.google.com", aud: "fixture.apps.googleusercontent.com", nonce: item.nonce,
      sub: "new-google-user", email: "new-user@example.com", email_verified: true, name: "Google User", ...item.claims }, keys.privateKey,
    { algorithm: "RS256", keyid: "fixture-key", expiresIn: 300 }) });
  }
  return networkFetch(input, init);
};

await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.SQLITE_PATH! } });
await ensureDatabaseSchema();
const adminId = await createUser({ username: "admin@example.com", password: "fixture-admin-password", role: "admin" });
await createUser({ username: "existing@example.com", password: "existing-password" });
await ensureDatabaseSchema(); // idempotent migration preserves existing accounts
assert.ok(await verifyUserPassword(adminId, "fixture-admin-password"));
const app = express();
app.use(express.json()); app.use(cookieParser()); registerGoogleAuthRoutes(app);
app.use("/api/trpc", createExpressMiddleware({ router: appRouter, createContext }));
const server = app.listen(0, "127.0.0.1");
await new Promise<void>(resolve => server.once("listening", resolve));
const origin = `http://127.0.0.1:${(server.address() as any).port}`;
type Jar = Map<string, string>;
function capture(jar: Jar, response: Response) {
  for (const cookie of response.headers.getSetCookie()) {
    const pair = cookie.split(";", 1)[0]; const at = pair.indexOf("=");
    const name = pair.slice(0, at); const value = decodeURIComponent(pair.slice(at + 1));
    if (!value) jar.delete(name); else jar.set(name, value);
  }
}
async function request(url: string, jar: Jar, init: RequestInit = {}) {
  const response = await networkFetch(origin + url, { ...init, redirect: "manual", headers: { ...init.headers,
    Cookie: [...jar].map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join(";"), Origin: origin } });
  capture(jar, response); return response;
}
async function rpc(name: string, jar: Jar, input?: unknown, query = false) {
  const response = await request(`/api/trpc/${name}`, jar, query ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ json: input ?? null }) });
  const body = await response.json();
  return { response, data: body.result?.data?.json, error: body.error?.json?.message };
}
async function session(jar: Jar, userId: number) {
  await issueLoginSession({ req: { secure: false, protocol: "http" }, res: { cookie(name: string, value: string) { jar.set(name, value); } } }, await getUserById(userId), "browser");
}
async function begin(jar: Jar, claims: Record<string, unknown> = {}, bind = false) {
  const result = await rpc("google.start", jar, { bind });
  assert.equal(result.error, undefined);
  const url = new URL(result.data.url);
  const code = crypto.randomBytes(20).toString("hex");
  codes.set(code, { nonce: url.searchParams.get("nonce")!, challenge: url.searchParams.get("code_challenge")!, claims });
  return `/api/auth/google/callback?${new URLSearchParams({ state: url.searchParams.get("state")!, code })}`;
}
async function callback(jar: Jar, claims: Record<string, unknown> = {}, bind = false) {
  return request(await begin(jar, claims, bind), jar);
}

try {
  const admin: Jar = new Map(); await session(admin, adminId);
  const anonymous: Jar = new Map();
  assert.equal((await rpc("google.loginStatus", anonymous, undefined, true)).data.enabled, false);
  assert.ok((await rpc("google.start", anonymous, {})).error);
  assert.ok((await rpc("google.settings", anonymous, undefined, true)).error);
  const config = { enabled: true, clientId: "fixture.apps.googleusercontent.com", clientSecret: "fixture-client-secret", redirectUri: `${origin}/api/auth/google/callback` };
  assert.ok((await rpc("google.saveSettings", anonymous, config)).error);
  assert.ok((await rpc("google.saveSettings", admin, { ...config, redirectUri: "http://remote.example/api/auth/google/callback" })).error);
  assert.equal((await rpc("google.saveSettings", admin, config)).error, undefined);
  const settings = (await rpc("google.settings", admin, undefined, true)).data;
  assert.equal(settings.secretConfigured, true); assert.ok(!JSON.stringify(settings).includes(config.clientSecret));
  assert.ok(!JSON.stringify((await rpc("system.getSettings", anonymous, undefined, true)).data).includes(config.clientSecret));
  assert.equal((await rpc("google.saveSettings", admin, { ...config, clientSecret: "" })).error, undefined);
  assert.equal(JSON.parse((await getSetting(GOOGLE_SETTINGS_KEY))!).clientSecret, config.clientSecret);
  assert.ok((await rpc("google.start", anonymous, { bind: true })).error);

  // Only the initiating browser can complete a flow, and callbacks cannot replay.
  const pending = await begin(anonymous);
  const before = tokenRequests;
  assert.match((await request(pending, new Map())).headers.get("location")!, /invalid_state/);
  assert.equal(tokenRequests, before);
  assert.equal((await request(pending, anonymous)).headers.get("location"), "/");
  const me = (await rpc("auth.me", anonymous, undefined, true)).data;
  const id = me.id;
  assert.equal(me.role, "user"); assert.equal(me.canAddRules, false); assert.equal(me.emailVerified, true);
  assert.ok((await rpc("google.settings", anonymous, undefined, true)).error);
  assert.ok((await rpc("google.saveSettings", anonymous, config)).error);
  assert.equal(me.password, undefined); assert.equal(me.googleSubject, undefined);
  assert.equal((await getUserById(id))!.password, "!google-only");
  assert.match((await request(pending, anonymous)).headers.get("location")!, /invalid_state/);
  assert.equal((await callback(anonymous)).headers.get("location"), "/");
  assert.equal((await runtime.queryRaw('SELECT id FROM users WHERE "googleSubject"=?', ["new-google-user"])).length, 1);

  // Google-only users can safely create a password using recent identity proof.
  assert.ok((await rpc("google.unbind", anonymous, { password: "wrong-password" })).error);
  assert.equal((await rpc("google.setPassword", anonymous, { password: "new-user-password" })).error, undefined);
  assert.ok(await verifyUserPassword(id, "new-user-password"));
  assert.ok((await rpc("google.setPassword", anonymous, { password: "replayed-proof" })).error);
  assert.equal((await rpc("google.unbind", anonymous, { password: "new-user-password" })).error, undefined);
  assert.equal((await getUserById(id))!.googleSubject, null);

  // Reuse of an existing email is never an implicit account link.
  assert.match((await callback(new Map(), { sub: "other-subject", email: "existing@example.com" })).headers.get("location")!, /existing_account/);
  assert.equal((await runtime.queryRaw('SELECT "googleSubject" FROM users WHERE username=?', ["existing@example.com"]))[0].googleSubject, null);
  assert.equal((await callback(admin, { sub: "admin-google", email: "admin@example.com" }, true)).headers.get("location"), "/profile?google=bound");
  const googleAdmin: Jar = new Map();
  assert.equal((await callback(googleAdmin, { sub: "admin-google", email: "admin@example.com" })).headers.get("location"), "/");
  assert.equal((await rpc("auth.me", googleAdmin, undefined, true)).data.id, adminId);
  // Re-authenticate the previous administrator browser after single-device takeover.
  await session(admin, adminId);
  assert.match((await callback(anonymous, { sub: "admin-google", email: "admin@example.com" }, true)).headers.get("location")!, /already_bound/);
  const expiredBinding = await begin(anonymous, { sub: "link-after-logout" }, true);
  await rpc("auth.logout", anonymous, undefined);
  assert.match((await request(expiredBinding, anonymous)).headers.get("location")!, /session_expired/);

  await setSetting("registrationEnabled", "false");
  assert.match((await callback(new Map(), { sub: "closed-registration", email: "closed@example.com" })).headers.get("location")!, /registration_closed/);
  assert.equal((await callback(new Map(), { sub: "admin-google", email: "admin@example.com" })).headers.get("location"), "/");
  await session(admin, adminId);
  await setSetting("registrationEnabled", "true");
  await setSetting("emailWhitelistEnabled", "true"); await setSetting("emailWhitelist", "allowed.example");
  assert.match((await callback(new Map(), { sub: "not-allowed", email: "new@other.example" })).headers.get("location")!, /email_not_allowed/);
  await setSetting("emailWhitelistEnabled", "false");

  const waiting: Jar = new Map(); const changed = await begin(waiting, { sub: "changed-config" });
  await rpc("google.saveSettings", admin, { ...config, enabled: false });
  assert.match((await request(changed, waiting)).headers.get("location")!, /disabled/);
  assert.equal((await rpc("google.loginStatus", new Map(), undefined, true)).data.enabled, false);
  await rpc("google.saveSettings", admin, config);
  // A provider denial is also bound to the browser and cannot log anyone in.
  const cancelJar: Jar = new Map(); const cancellation = await begin(cancelJar);
  const cancelUrl = new URL(origin + cancellation); cancelUrl.searchParams.delete("code"); cancelUrl.searchParams.set("error", "access_denied");
  assert.match((await request(cancelUrl.pathname + cancelUrl.search, cancelJar)).headers.get("location")!, /cancelled/);

  await runtime.executeRaw('UPDATE users SET "accountEnabled"=0 WHERE id=?', [adminId]);
  assert.match((await callback(new Map(), { sub: "admin-google", email: "admin@example.com" })).headers.get("location")!, /account_disabled/);
  await runtime.executeRaw('UPDATE users SET "accountEnabled"=1 WHERE id=?', [adminId]);
  await setSetting("twoFactorEnabled", "true");
  await runtime.executeRaw('UPDATE users SET "twoFactorEnabled"=1,"twoFactorSecret"=? WHERE id=?', ["GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", adminId]);
  const twoFactor: Jar = new Map();
  assert.equal((await callback(twoFactor, { sub: "admin-google", email: "admin@example.com" })).headers.get("location"), "/login?google=two_factor");
  assert.equal(twoFactor.has(COOKIE_NAME), false);
  assert.ok(twoFactor.has(GOOGLE_RESULT_COOKIE));
  const challenge = await rpc("google.finishTwoFactor", twoFactor);
  assert.ok(challenge.data.challengeId); assert.equal(challenge.data.username, "admin@example.com");
  assert.ok((await rpc("google.finishTwoFactor", twoFactor)).error);
  assert.ok((await rpc("auth.verifyTwoFactorLogin", twoFactor, { challengeId: challenge.data.challengeId, code: "invalid" })).error);
  assert.equal(twoFactor.has(COOKIE_NAME), false);
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const hmac = crypto.createHmac("sha1", Buffer.from("12345678901234567890")).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 15;
  const code = String((hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
  assert.equal((await rpc("auth.verifyTwoFactorLogin", twoFactor, { challengeId: challenge.data.challengeId, code })).error, undefined);
  assert.ok(twoFactor.has(COOKIE_NAME));
  assert.equal((await rpc("auth.me", twoFactor, undefined, true)).data.id, adminId);

  // Credential clearing is explicit and disables the public entry point.
  await session(admin, adminId);
  assert.equal((await rpc("google.saveSettings", admin, { ...config, clientSecret: undefined, enabled: false, clearSecret: true })).error, undefined);
  assert.equal((await rpc("google.settings", admin, undefined, true)).data.secretConfigured, false);
  assert.equal(certRequests, 1, "Google signing keys are cached across logins");
  assert.equal(anonymous.has(GOOGLE_FLOW_COOKIE), false);
} finally {
  globalThis.fetch = networkFetch;
  await new Promise<void>(resolve => server.close(() => resolve()));
  await runtime.closeDatabase();
}
