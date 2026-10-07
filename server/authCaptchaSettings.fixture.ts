import assert from "node:assert/strict";
import { connectDatabase, closeDatabase, executeRaw } from "./dbRuntime";
import { ensureDatabaseSchema } from "./dbSchema";
import { createUser, getUserById } from "./repositories/userRepository";
import { getSetting, setSetting } from "./repositories/settingsRepository";
import { authRouter } from "./routers/auth";
import { systemRouter } from "./_core/systemRouter";
import { authCaptcha } from "./authCaptcha";

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
  await assert.rejects(auth.register(registration), /CAPTCHA_REQUIRED/);
  for (let i = 0; i < 3; i++) authCaptcha.recordLoginFailure(ip, "user@example.com");
  assert.deepEqual(await auth.needsCaptcha({ username: "user@example.com" }), { enabled: true, required: true });
  await assert.rejects(auth.login({ username: "user@example.com", password: "test-user-password" }), /CAPTCHA_REQUIRED/);
  await assert.rejects(ordinary.updateSettings({ authCaptchaEnabled: false }), error => (error as any).code === "FORBIDDEN");
  await assert.rejects(anonymous.updateSettings({ authCaptchaEnabled: false }), error => (error as any).code === "UNAUTHORIZED");

  await admin.updateSettings({ authCaptchaEnabled: false });
  assert.equal(await getSetting("authCaptchaEnabled"), "false");
  assert.equal((await auth.emailConfig()).authCaptchaEnabled, false);
  assert.equal((await anonymous.publicInfo()).authCaptchaEnabled, false);
  assert.equal((await anonymous.getSettings()).authCaptchaEnabled, false);
  assert.deepEqual(await auth.needsCaptcha({ username: "user@example.com" }), { enabled: false, required: false });
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
} finally {
  await closeDatabase();
}
