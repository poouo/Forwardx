import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("routine routes, disabled email and image captcha do not load optional service engines", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-routine-dependencies-"));
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", String.raw`
      import assert from "node:assert/strict";
      import path from "node:path";
      import { createRequire } from "node:module";
      const require = createRequire(import.meta.url);
      const loaded = name => Object.keys(require.cache).some(file => file.replaceAll("\\", "/").includes("/node_modules/" + name + "/"));
      const rt = await import("./server/dbRuntime.ts");
      await rt.connectDatabase({type:"sqlite",sqlite:{path:process.env.SQLITE_PATH}});
      try {
        await (await import("./server/dbSchema.ts")).ensureDatabaseSchema();
        await import("./server/routers.ts");
        await import("./server/billingExportRoutes.ts");
        const { authCaptcha: captcha } = await import("./server/authCaptcha.ts");
        const email = await import("./server/email.ts");
        const telegram = await import("./server/telegramApiTransport.ts");
        const { setSetting } = await import("./server/repositories/settingsRepository.ts");
        for (const name of ["exceljs", "nodemailer", "undici", "@cap.js/server"]) assert.equal(loaded(name), false, name + " loaded before use");
        captcha.pruneExpired();
        captcha.clearForTest();
        assert.equal(await captcha.verifyCapToken("192.0.2.1", "login", "invalid"), false);
        assert.match(captcha.createImageChallenge("192.0.2.1", "login").imageDataUrl, /^data:image\/svg/);
        assert.equal(loaded("@cap.js/server"), false);
        await setSetting("emailEnabled", "false");
        assert.deepEqual(await email.sendMail({to:"no-send@example.invalid",subject:"not sent"}), {skipped:true,reason:"email disabled"});
        assert.equal(loaded("nodemailer"), false);
        const aborted = new AbortController(); aborted.abort();
        await assert.rejects(telegram.telegramApiFetch("https://telegram.invalid", {signal:aborted.signal}));
        assert.equal(loaded("undici"), false, "pre-aborted requests must not create a pool");
        const { writeBillingLedgerXlsx } = await import("./server/billingExport.ts");
        const cancelled = new AbortController(); cancelled.abort();
        async function* empty() {}
        await assert.rejects(writeBillingLedgerXlsx(path.join(process.env.TEST_DIRECTORY,"cancelled.xlsx"), {viewerUserId:1}, cancelled.signal, empty()));
        assert.equal(loaded("exceljs"), false);
        assert.equal(await writeBillingLedgerXlsx(path.join(process.env.TEST_DIRECTORY,"ledger.xlsx"), {viewerUserId:1}, undefined, empty()), 0);
        assert.equal(loaded("exceljs"), true);
        const challenges = await Promise.all([
          captcha.createCapChallenge("192.0.2.2", "login"),
          captcha.createCapChallenge("192.0.2.3", "register"),
        ]);
        assert.ok(challenges.every(item => item.token));
        assert.equal(captcha.stateSizesForTest().capChallenges, 2);
        assert.equal(loaded("@cap.js/server"), true);
        const calls = [];
        globalThis.fetch = async (url, options) => { calls.push(options); return Response.json({ok:true}); };
        await Promise.all([1,2,3].map(() => telegram.telegramApiFetch("https://telegram.invalid", {method:"POST"})));
        assert.equal(loaded("undici"), true);
        assert.equal(calls.length, 3);
        assert.ok(calls.every(call => call.dispatcher === calls[0].dispatcher), "first concurrent requests must share one pool");
        await calls[0].dispatcher.destroy();
        // Inspect the SMTP path without real mail/network access.
        await setSetting("emailEnabled", "true");
        await setSetting("emailHost", "smtp.invalid");
        await setSetting("emailFrom", "panel@example.invalid");
        assert.equal(loaded("nodemailer"), false);
        const nodemailer = (await import("nodemailer")).default;
        const original = nodemailer.createTransport;
        let closed = 0;
        nodemailer.createTransport = () => ({sendMail:async () => ({messageId:"local-test"}),close:() => {closed++}});
        try {
          assert.deepEqual(await email.sendMail({to:"recipient@example.invalid",subject:"fake SMTP"}), {skipped:false,messageId:"local-test"});
          assert.equal(closed, 1);
        } finally { nodemailer.createTransport = original; }
        captcha.clearForTest();
      } finally { await rt.closeDatabase(); }
    `], {
      encoding: "utf8", timeout: 30_000,
      env: {
        ...process.env, NODE_ENV: "test", DATABASE_TYPE: "sqlite", SQLITE_PATH: path.join(directory, "panel.db"),
        DATABASE_CONFIG_PATH: path.join(directory, "database.json"), MYSQL_CONFIG_PATH: path.join(directory, "mysql.json"),
        JWT_SECRET: "routine-optional-dependencies-test-only-secret",
        FORWARDX_LOG_DIR: path.join(directory, "logs"), TEST_DIRECTORY: directory,
      },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout || String(result.error));
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
