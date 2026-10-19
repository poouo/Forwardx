import assert from "node:assert/strict";
import { connectDatabase, closeDatabase, executeRaw } from "./dbRuntime";
import { ensureDatabaseSchema } from "./dbSchema";
import { createUser, getUserById } from "./repositories/userRepository";
import { getSetting, setSetting } from "./repositories/settingsRepository";
import { authRouter } from "./routers/auth";
import { systemRouter } from "./_core/systemRouter";
import { authCaptcha, AuthCaptchaService, authCapRouter } from "./authCaptcha";
import express from "express";

await connectDatabase();
await ensureDatabaseSchema();
try {
  const ip = "192.0.2.90";
  const context = (user: any = null) => ({
    user, req: { ip, socket: { remoteAddress: ip }, headers: {}, secure: false },
    res: { cookie() {}, clearCookie() {} },
  }) as any;
  const auth = authRouter.createCaller(context());
  const anonymous = systemRouter.createCaller(context());
  const adminId = await createUser({ username: "admin@example.com", password: "test-admin-password", role: "admin" });
  const admin = systemRouter.createCaller(context(await getUserById(adminId)));
  const userId = await createUser({ username: "user@example.com", password: "test-user-password" });
  const ordinary = systemRouter.createCaller(context(await getUserById(userId)));
  const registration = { username: "new@example.com", password: "test-new-password" };

  assert.equal((await auth.emailConfig()).authCaptchaEnabled, true);
  assert.equal((await anonymous.publicInfo()).authCaptchaEnabled, true);
  assert.equal((await anonymous.getSettings()).authCaptchaEnabled, true);
  assert.equal((await auth.emailConfig()).authCaptchaProvider, "cap");
  assert.equal((await anonymous.publicInfo()).authCaptchaProvider, "cap");
  assert.equal((await anonymous.getSettings()).authCaptchaProvider, "cap");
  await assert.rejects(auth.createCaptcha({ purpose: "login" }), /验证码方式已更改/);
  await assert.rejects(auth.register(registration), /CAPTCHA_REQUIRED/);
  for (let i = 0; i < 3; i++) authCaptcha.recordLoginFailure(ip, "user@example.com");
  assert.deepEqual(await auth.needsCaptcha({ username: "user@example.com" }), { enabled: true, provider: "cap", required: true });
  await assert.rejects(auth.login({ username: "user@example.com", password: "test-user-password" }), /CAPTCHA_REQUIRED/);
  await assert.rejects(ordinary.updateSettings({ authCaptchaEnabled: false }), error => (error as any).code === "FORBIDDEN");
  await assert.rejects(anonymous.updateSettings({ authCaptchaEnabled: false }), error => (error as any).code === "UNAUTHORIZED");
  await assert.rejects(ordinary.updateSettings({ authCaptchaProvider: "image" }), error => (error as any).code === "FORBIDDEN");
  await assert.rejects(anonymous.updateSettings({ authCaptchaProvider: "image" }), error => (error as any).code === "UNAUTHORIZED");
  await assert.rejects(admin.updateSettings({ authCaptchaProvider: "unknown" } as any), error => (error as any).code === "BAD_REQUEST");

  await admin.updateSettings({ authCaptchaEnabled: false });
  assert.equal(await getSetting("authCaptchaEnabled"), "false");
  assert.equal((await auth.emailConfig()).authCaptchaEnabled, false);
  assert.equal((await anonymous.publicInfo()).authCaptchaEnabled, false);
  assert.equal((await anonymous.getSettings()).authCaptchaEnabled, false);
  assert.deepEqual(await auth.needsCaptcha({ username: "user@example.com" }), { enabled: false, provider: "cap", required: false });
  await assert.rejects(auth.createCaptcha({ purpose: "register" }), /验证码方式已更改/);
  assert.equal((await auth.login({ username: "user@example.com", password: "test-user-password" }) as any).id, userId);
  assert.ok((await auth.register(registration)).id);

  // Disabling verification must not disable password checks or brute-force limits.
  for (let i = 0; i < 8; i++) {
    await assert.rejects(auth.login({ username: "blocked@example.com", password: "wrong-password" }), /用户名或密码错误/);
  }
  await assert.rejects(auth.login({ username: "blocked@example.com", password: "wrong-password" }), error => (error as any).code === "TOO_MANY_REQUESTS");
  await setSetting("twoFactorEnabled", "true");
  await executeRaw('UPDATE users SET "twoFactorEnabled"=1,"twoFactorSecret"=? WHERE id=?', ["GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", adminId]);
  assert.equal((await auth.login({ username: "admin@example.com", password: "test-admin-password" }) as any).twoFactorRequired, true);
  await setSetting("registrationEnabled", "false");
  await assert.rejects(auth.register({ ...registration, username: "other@example.com" }), /当前注册未开放/);
  await setSetting("registrationEnabled", "true");

  await admin.updateSettings({ authCaptchaEnabled: true });
  assert.equal((await auth.emailConfig()).authCaptchaEnabled, true);
  await assert.rejects(auth.register({ ...registration, username: "other@example.com" }), /CAPTCHA_REQUIRED/);
  for (let i = 0; i < 3; i++) authCaptcha.recordLoginFailure(ip, "user@example.com");
  await assert.rejects(auth.login({ username: "user@example.com", password: "test-user-password" }), /CAPTCHA_REQUIRED/);
  // Invalid/unknown persisted values cannot accidentally disable protection.
  await setSetting("authCaptchaEnabled", "invalid");
  assert.equal((await auth.emailConfig()).authCaptchaEnabled, true);

  await admin.updateSettings({ authCaptchaProvider: "image" });
  assert.equal(await getSetting("authCaptchaProvider"), "image");
  assert.equal((await auth.emailConfig()).authCaptchaProvider, "image");
  assert.equal((await anonymous.publicInfo()).authCaptchaProvider, "image");
  assert.equal((await anonymous.getSettings()).authCaptchaProvider, "image");
  assert.equal((await auth.needsCaptcha({ username: "user@example.com" })).provider, "image");
  const rendered = await auth.createCaptcha({ purpose: "register" });
  assert.match(rendered.imageDataUrl, /^data:image\/svg\+xml;base64,/);
  assert.ok(!("text" in rendered) && !("answer" in rendered));

  // Deterministic answers exist only in this isolated fixture, never in APIs.
  const imageService = new AuthCaptchaService({ svgGenerator: () => ({ text: "A7K9P2", data: "<svg/>" }) });
  const originalCreate = authCaptcha.createImageChallenge;
  const originalVerify = authCaptcha.verifyChallenge;
  authCaptcha.createImageChallenge = imageService.createImageChallenge.bind(imageService);
  authCaptcha.verifyChallenge = imageService.verifyChallenge.bind(imageService);
  try {
    const loginImage = await auth.createCaptcha({ purpose: "login" });
    await assert.rejects(auth.login({ username: "user@example.com", password: "test-user-password", capToken: "wrong-method" }), /CAPTCHA_INVALID/);
    await assert.rejects(auth.login({ username: "user@example.com", password: "test-user-password", captchaId: loginImage.captchaId, captchaAnswer: "WRONG" }), /CAPTCHA_INVALID/);
    await assert.rejects(auth.login({ username: "user@example.com", password: "test-user-password", captchaId: loginImage.captchaId, captchaAnswer: "A7K9P2" }), /CAPTCHA_INVALID/);
    const retryImage = await auth.createCaptcha({ purpose: "login" });
    assert.equal((await auth.login({ username: "user@example.com", password: "test-user-password", captchaId: retryImage.captchaId, captchaAnswer: "a7k9p2" }) as any).id, userId);
    const registerImage = await auth.createCaptcha({ purpose: "register" });
    assert.ok((await auth.register({ username: "image-user@example.com", password: "test-image-password", captchaId: registerImage.captchaId, captchaAnswer: "A7K9P2" })).id);
    await assert.rejects(auth.register({ username: "replay@example.com", password: "test-image-password", captchaId: registerImage.captchaId, captchaAnswer: "A7K9P2" }), /CAPTCHA_INVALID/);
    const oldImage = await auth.createCaptcha({ purpose: "register" });
    await admin.updateSettings({ authCaptchaProvider: "cap" });
    await assert.rejects(auth.register({ username: "stale-method@example.com", password: "test-image-password", captchaId: oldImage.captchaId, captchaAnswer: "A7K9P2" }), /CAPTCHA_INVALID/);
    await assert.rejects(auth.createCaptcha({ purpose: "register" }), /验证码方式已更改/);
  } finally {
    authCaptcha.createImageChallenge = originalCreate;
    authCaptcha.verifyChallenge = originalVerify;
  }

  // The public PoW endpoints must not mint/redeem the unselected method.
  const app = express();
  app.use(express.json()); app.use(authCapRouter);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  try {
    const base = `http://127.0.0.1:${(server.address() as any).port}/api/auth/cap/register`;
    await admin.updateSettings({ authCaptchaProvider: "image" });
    assert.equal((await fetch(base + "/challenge", { method: "POST" })).status, 409);
    assert.equal((await fetch(base + "/redeem", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: "a".repeat(50), solutions: [1] }) })).status, 409);
    await admin.updateSettings({ authCaptchaProvider: "cap" });
    assert.equal((await fetch(base + "/challenge", { method: "POST" })).status, 200);
    await admin.updateSettings({ authCaptchaEnabled: false });
    assert.equal((await fetch(base + "/challenge", { method: "POST" })).status, 409);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  await setSetting("authCaptchaProvider", "invalid");
  assert.equal((await auth.emailConfig()).authCaptchaProvider, "cap");
} finally {
  await closeDatabase();
}
