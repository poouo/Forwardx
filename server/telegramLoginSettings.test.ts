import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("TG login entry defaults on, is admin-controlled and leaves signed WebApp and bot login available", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-tg-login-settings-"));
  const script = String.raw`
    import assert from "node:assert/strict";
    import { createHmac } from "node:crypto";
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    const url = file => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(url("server/dbRuntime.ts"));
    const schema = await import(url("server/dbSchema.ts"));
    const db = await import(url("server/db.ts"));
    const { systemRouter } = await import(url("server/_core/systemRouter.ts"));
    const { telegramRouter } = await import(url("server/routers/telegram.ts"));
    try {
      await runtime.connectDatabase({type:"sqlite",sqlite:{path:process.env.FORWARDX_TEST_DB}});
      await schema.ensureDatabaseSchema();
      const token = "123456:test-token-only";
      await db.setSettings({notificationChannel:"telegram",telegramBotEnabled:"true",telegramBotToken:token,telegramBotUsername:"test_bot"});
      await runtime.executeRaw('INSERT INTO users (id,username,password,role,telegramId) VALUES (1,?,?,?,?)', ["admin","x","admin","123456789"]);
      const cookies = [];
      const context = user => ({user,req:{headers:{},socket:{remoteAddress:"127.0.0.1"}},res:{cookie(...args){cookies.push(args)},clearCookie(){}}});
      const admin = systemRouter.createCaller(context({id:1,username:"admin",role:"admin"}));
      const ordinary = systemRouter.createCaller(context({id:2,username:"user",role:"user"}));
      const anonymous = systemRouter.createCaller(context(null));
      const telegram = telegramRouter.createCaller(context(null));
      async function checkFlag(expected) {
        assert.equal((await admin.getSettings()).telegram.loginEnabled,expected);
        assert.equal((await ordinary.getSettings()).telegram.loginEnabled,expected);
        assert.equal((await anonymous.getSettings()).telegram.loginEnabled,expected);
        assert.equal((await anonymous.publicInfo()).telegramLoginEnabled,expected);
        assert.equal((await telegram.loginStatus()).loginEnabled,expected);
      }
      await checkFlag(true);
      await assert.rejects(ordinary.updateSettings({telegram:{loginEnabled:false}}), e => e.code === "FORBIDDEN");
      await assert.rejects(anonymous.updateSettings({telegram:{loginEnabled:false}}), e => e.code === "UNAUTHORIZED");
      await admin.updateSettings({telegram:{loginEnabled:false}});
      assert.equal(await db.getSetting("telegramLoginEnabled"),"false");
      await checkFlag(false);
      assert.equal((await telegram.loginStatus()).enabled,true);
      assert.equal(await db.getSetting("telegramBotToken"),token);
      // Updating other options must preserve an explicitly disabled entry.
      await admin.updateSettings({telegram:{trafficReminderThreshold:25}});
      await checkFlag(false);
      const params = new URLSearchParams({
        auth_date:String(Math.floor(Date.now()/1000)),
        query_id:"TEST_QUERY_12345",
        user:JSON.stringify({id:123456789,first_name:"Test"}),
      });
      const checkString = [...params.entries()].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,value])=>key+"="+value).join("\n");
      const secret = createHmac("sha256","WebAppData").update(token).digest();
      params.set("hash",createHmac("sha256",secret).update(checkString).digest("hex"));
      const signedIn = await telegram.loginWithWebApp({initData:params.toString()});
      assert.equal(signedIn.id,1);
      assert.equal(cookies.length,1);
      await assert.rejects(telegram.loginWithWebApp({initData:params.toString()}),/TELEGRAM_WEBAPP_REPLAYED/);
      params.set("hash","0".repeat(64));
      await assert.rejects(telegram.loginWithWebApp({initData:params.toString()}),/TELEGRAM_WEBAPP_VERIFY_FAILED/);
      await runtime.executeRaw('UPDATE users SET telegramLoginCode=?,telegramLoginCodeExpiresAt=? WHERE id=1', ["BOT-LOGIN-CODE-123",Math.floor(Date.now()/1000)+300]);
      assert.equal((await telegram.login({code:"BOT-LOGIN-CODE-123"})).id,1);
      assert.equal(cookies.length,2);
      await admin.updateSettings({telegram:{loginEnabled:true}});
      await checkFlag(true);
    } finally { await runtime.closeDatabase(); }
  `;
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
      cwd: process.cwd(), encoding: "utf8", timeout: 60_000,
      env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(directory, "panel.db"), FORWARDX_LOG_DIR: path.join(directory, "logs"), TELEGRAM_BOT_TOKEN: "", JWT_SECRET: "telegram-login-test-secret-32-characters" },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
