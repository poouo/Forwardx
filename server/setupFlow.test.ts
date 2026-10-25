import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

function runSetupFlow(body: string) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-setup-flow-"));
  const databasePath = path.join(directory, "forwardx.db");
  const configPath = path.join(directory, "database.json");
  fs.writeFileSync(configPath, JSON.stringify({ type: "sqlite", sqlite: { path: databasePath } }));

  const script = String.raw`
    import assert from "node:assert/strict";
    import fs from "node:fs";
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(url("server/dbRuntime.ts"));
    const schema = await import(url("server/dbSchema.ts"));
    const db = await import(url("server/db.ts"));
    const migration = await import(url("server/migration.ts"));
    const users = await import(url("server/repositories/userRepository.ts"));
    const taskLocks = await import(url("server/keyedTaskLock.ts"));
    const { setupRouter, friendlyDatabaseError } = await import(url("server/routers/setup.ts"));
    try {
      await runtime.connectDatabase();
      await schema.ensureDatabaseSchema();
      const caller = setupRouter.createCaller({ user: null });
      ${body}
    } finally {
      await runtime.closeDatabase();
    }
  `;

  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_CONFIG_PATH: configPath,
      SQLITE_PATH: databasePath,
      JWT_SECRET: "setup-flow-test-secret",
      NODE_ENV: "test",
      FORWARDX_TEST_DIRECTORY: directory,
    },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
}

test("setup status shares table counts, expires them, and invalidates on reconnect or setup writes", () => {
  runSetupFlow(String.raw`
    const sqlite = runtime.getSqlite();
    const originalPrepare = sqlite.prepare;
    const originalNow = Date.now;
    let now = originalNow();
    let fullCounts = 0;
    sqlite.prepare = function(sql, ...args) {
      if (/^SELECT COUNT\(\*\) AS "count" FROM "[^"]+"$/i.test(sql)) fullCounts++;
      return originalPrepare.call(this, sql, ...args);
    };
    Date.now = () => now;
    try {
      const first = await Promise.all(Array.from({ length: 8 }, () => caller.status()));
      const tables = schema.MIGRATION_TABLES.length;
      assert.equal(fullCounts, tables, "concurrent setup polls must share one table-count pass");
      assert.deepEqual(first[0].existingData, first[7].existingData);
      for (let index = 0; index < 5; index++) await caller.status();
      assert.equal(fullCounts, tables, "3-second polls must reuse recent counts");
      now += 60_001;
      await caller.status();
      assert.equal(fullCounts, tables * 2, "expired counts must refresh");

      await caller.testDatabase({ type: "sqlite", sqlite: { path: process.env.SQLITE_PATH } });
      await caller.status();
      assert.equal(fullCounts, tables * 3, "setup operations must invalidate the summary");
    } finally {
      Date.now = originalNow;
      sqlite.prepare = originalPrepare;
    }
    await runtime.reconnectDatabase();
    const reconnected = runtime.getSqlite();
    const prepareAfterReconnect = reconnected.prepare;
    reconnected.prepare = function(sql, ...args) {
      if (/^SELECT COUNT\(\*\) AS "count" FROM "[^"]+"$/i.test(sql)) fullCounts++;
      return prepareAfterReconnect.call(this, sql, ...args);
    };
    try {
      await caller.status();
      assert.equal(fullCounts, schema.MIGRATION_TABLES.length * 4, "new database handles must not reuse old summaries");
    } finally { reconnected.prepare = prepareAfterReconnect; }
  `);
});

test("setup localizes unsupported MySQL versions and host authorization through driver wrappers", () => {
  runSetupFlow(String.raw`
    for (const version of ["5.7.44", "5.7.44-log", "8.0.12-ubuntu"]) {
      let actual;
      await assert.rejects(runtime.assertSupportedMysqlServer(async () => [[{ version }]]), error => {
        actual = error;
        return true;
      });
      const expected = "当前 MySQL " + version.match(/\d+\.\d+\.\d+/)[0] + " 版本过低，请升级到 8.0.13 及以上。";
      assert.equal(friendlyDatabaseError(actual), expected);
      assert.equal(friendlyDatabaseError(new Error("connection wrapper", { cause: actual })), expected);
      assert.equal(friendlyDatabaseError(new AggregateError([actual])), expected);
    }
    assert.match(friendlyDatabaseError(new Error("Unsupported MySQL server version unknown. ForwardX requires MySQL 8.0.13 or later.")), /无法识别.*8\.0\.13/);
    const sensitive = "Host '172.27.0.2' is not allowed to connect to this MySQL server password=private-secret SQL=private-query";
    for (const error of [
      Object.assign(new Error(sensitive), { code: "ER_HOST_NOT_PRIVILEGED" }),
      { errno: 1130, sqlMessage: sensitive },
      new Error(sensitive),
      new Error("driver wrapper", { cause: { errno: 1130, sqlMessage: sensitive } }),
      new AggregateError([{ code: "ER_HOST_NOT_PRIVILEGED", message: sensitive }]),
    ]) {
      const message = friendlyDatabaseError(error);
      assert.match(message, /MySQL 未授权.*容器网段/);
      assert.match(message, /Host.*实际来源 IP.*受限网段/);
      assert.doesNotMatch(message, /172\.27|private-secret|private-query|is not allowed/);
    }
    assert.match(friendlyDatabaseError({ errno: 1129 }), /封禁/);
    assert.match(friendlyDatabaseError(Object.assign(new Error("lookup failed"), { code: "ENOTFOUND", hostname: "mysql-internal" })), /无法解析数据库地址 mysql-internal/);
    assert.match(friendlyDatabaseError(new Error("connect ECONNREFUSED")), /连接被拒绝/);
    assert.match(friendlyDatabaseError(new Error("connect ETIMEDOUT")), /连接超时/);
    assert.match(friendlyDatabaseError(new Error("Access denied for user")), /账号或密码验证失败/);
    const cycle = new Error("unclassified failure"); cycle.cause = cycle;
    assert.equal(friendlyDatabaseError(cycle), "unclassified failure");
    assert.equal(friendlyDatabaseError("unclassified string"), "unclassified string");
  `);
});

test("setup test/save endpoints return localized DB errors without persisting failed config or bypassing locks", () => {
  runSetupFlow(String.raw`
    const mysql = (await import("mysql2/promise")).default;
    const originalCreateConnection = mysql.createConnection;
    const originalConfig = fs.readFileSync(process.env.DATABASE_CONFIG_PATH, "utf8");
    const input = { host: "fake-mysql", port: 3306, user: "test", password: "private-secret", database: "forwardx", ssl: false };
    const methods = [
      () => caller.testDatabase({ type: "mysql", mysql: input }),
      () => caller.saveDatabase({ type: "mysql", mysql: input }),
      () => caller.testMysql(input),
      () => caller.saveMysql(input),
    ];
    let closed = 0;
    try {
      mysql.createConnection = async () => ({
        async ping() {},
        async query() { return [[{ version: "5.7.44" }]]; },
        async end() { closed++; },
      });
      for (const call of methods) {
        await assert.rejects(call, error => {
          assert.equal(error.code, "BAD_REQUEST");
          assert.equal(error.message, "当前 MySQL 5.7.44 版本过低，请升级到 8.0.13 及以上。");
          return true;
        });
      }
      assert.equal(closed, 4, "failed version checks close every test connection");
      mysql.createConnection = async () => { throw Object.assign(new Error("Host '172.27.0.2' is not allowed to connect to this MySQL server private-secret"), { code: "ER_HOST_NOT_PRIVILEGED", errno: 1130 }); };
      for (const call of methods) {
        await assert.rejects(call, error => {
          assert.equal(error.code, "BAD_REQUEST");
          assert.match(error.message, /MySQL 未授权.*容器网段/);
          assert.doesNotMatch(error.message, /172\.27|private-secret/);
          return true;
        });
      }
      assert.equal(fs.readFileSync(process.env.DATABASE_CONFIG_PATH, "utf8"), originalConfig);
      await caller.createAdmin({ email: "admin@example.com", password: "safe-password" });
      for (const call of methods) await assert.rejects(call, /SETUP_LOCKED/);
    } finally {
      mysql.createConnection = originalCreateConnection;
    }
  `);
});

test("initial admin email login is case-insensitive and an existing admin always completes setup", () => {
  runSetupFlow(String.raw`
    assert.equal((await caller.status()).defaultDatabaseType, runtime.getSchemaDialect());
    await caller.createAdmin({
      email: "Admin@Example.COM",
      password: " correct-horse-123 ",
      name: "Admin",
    });
    const stored = (await runtime.queryRaw('SELECT "id", "username", "role" FROM "users"'))[0];
    assert.equal(stored.username, "admin@example.com");
    assert.ok(await users.authenticateUser("ADMIN@example.com", " correct-horse-123 "));
    assert.equal(await users.authenticateUser("admin@example.com", "correct-horse-123"), null);
    await runtime.executeRaw('UPDATE "users" SET "email" = ? WHERE "id" = ?', ["owner@example.net", stored.id]);
    assert.ok(await users.authenticateUser("OWNER@EXAMPLE.NET", " correct-horse-123 "));

    await runtime.executeRaw(
      'INSERT INTO "hosts" ("name", "ip", "hostType", "userId") VALUES (?, ?, ?, ?)',
      ["legacy-host", "127.0.0.1", "slave", stored.id],
    );
    await runtime.executeRaw('DELETE FROM "system_settings" WHERE "key" = ?', ["setupDataChoice"]);
    const status = await caller.status();
    assert.equal(status.hasAdmin, true);
    assert.equal(status.setupComplete, true);
  `);
});

test("a fresh setup exposes its schema default and becomes ready after a real dialect-switch process restart", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-setup-restart-"));
  const env = {
    ...process.env,
    DATABASE_CONFIG_PATH: path.join(directory, "database.json"),
    MYSQL_CONFIG_PATH: path.join(directory, "legacy-mysql.json"),
    SQLITE_PATH: path.join(directory, "forwardx.db"),
    DATABASE_TYPE: "", DB_TYPE: "", MYSQL_URL: "", MYSQL_HOST: "",
    POSTGRES_URL: "", POSTGRESQL_URL: "", PG_URL: "",
    POSTGRES_HOST: "", POSTGRESQL_HOST: "", PGHOST: "",
    JWT_SECRET: "setup-restart-test-only-secret", NODE_ENV: "test", FORWARDX_DEV_PANEL: "0",
  };
  const bootstrap = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    const url = file => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(url("server/dbRuntime.ts"));
    const { setupRouter } = await import(url("server/routers/setup.ts"));
    const caller = setupRouter.createCaller({ user: null });
  `;
  const phases = [String.raw`
    const initial = await caller.status();
    assert.equal(initial.databaseConfigured, false);
    assert.equal(initial.defaultDatabaseType, runtime.getSchemaDialect());
    assert.equal(initial.defaultDatabaseType, "mysql");
    const result = await caller.saveDatabase({ type: "sqlite", sqlite: { path: process.env.SQLITE_PATH } });
    assert.equal(result.needsRestart, true);
    assert.equal(result.databaseConfigured, true);
    assert.equal(result.databaseConnected, false);
    assert.equal(result.schemaReady, false);
    assert.equal(runtime.readDatabaseConfig().type, "sqlite");
  `, String.raw`
    try {
      const ready = await caller.status();
      assert.equal(ready.defaultDatabaseType, "sqlite");
      assert.equal(ready.databaseConfigured, true);
      assert.equal(ready.databaseConnected, true);
      assert.equal(ready.schemaReady, true);
      assert.equal(ready.needsRestart, false);
      assert.equal(ready.config.type, "sqlite");
      assert.equal(ready.setupComplete, false);
    } finally { await runtime.closeDatabase(); }
  `];
  for (const phase of phases) {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", bootstrap + phase], { cwd: process.cwd(), env, encoding: "utf8", timeout: 30_000 });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  }
});

test("a stale local marker stays locked until local recovery and concurrent setup creates one admin", () => {
  runSetupFlow(String.raw`
    const marker = path.join(process.env.FORWARDX_TEST_DIRECTORY, ".setup-complete");
    fs.writeFileSync(marker, "legacy\n");
    const lockedStatus = await caller.status();
    assert.equal(lockedStatus.setupLocked, true);
    assert.equal(lockedStatus.hasExistingData, false);
    assert.equal(lockedStatus.existingData, null);
    assert.equal(lockedStatus.setupDataChoice, null);
    assert.equal(lockedStatus.config, null);
    assert.equal(lockedStatus.defaultSqlitePath, "");
    assert.equal(lockedStatus.error, null);
    const localAdminStatus = await setupRouter.createCaller({ user: { role: "admin" } }).status();
    assert.notEqual(localAdminStatus.config, null);
    assert.notEqual(localAdminStatus.defaultSqlitePath, "");
    await assert.rejects(
      caller.createAdmin({ email: "Blocked@Example.com", password: "blocked-password", name: "Blocked" }),
      /SETUP_LOCKED/,
    );
    assert.equal((await runtime.queryRaw('SELECT COUNT(*) AS "count" FROM "users"'))[0].count, 0);

    fs.unlinkSync(marker);
    await assert.rejects(
      caller.createAdmin({ email: "Spaces@Example.com", password: "        ", name: "Spaces" }),
      /请输入管理员密码/,
    );
    const attempts = await Promise.allSettled([
      caller.createAdmin({ email: "First@Example.com", password: "first-password", name: "First" }),
      caller.createAdmin({ email: "Second@Example.com", password: "second-password", name: "Second" }),
    ]);
    assert.equal(attempts.filter((item) => item.status === "fulfilled").length, 1);
    assert.equal(attempts.filter((item) => item.status === "rejected").length, 1);
    const count = (await runtime.queryRaw('SELECT COUNT(*) AS "count" FROM "users" WHERE "role" = ?', ["admin"]))[0].count;
    assert.equal(count, 1);
    assert.equal(await db.getSetting("setupDataChoice"), "new-panel");
  `);
});

test("concurrent admin creation prevents a stale setup reset from deleting the new account", () => {
  runSetupFlow(String.raw`
    const lockKey = "panel-setup-write";
    let releaseGate;
    const gate = new Promise((resolve) => { releaseGate = resolve; });
    const blocker = taskLocks.withKeyedTaskLock(lockKey, () => gate);
    const waitForDepth = async (expected) => {
      for (let attempt = 0; attempt < 100 && taskLocks.keyedTaskDepth(lockKey) < expected; attempt += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      if (taskLocks.keyedTaskDepth(lockKey) < expected) {
        releaseGate();
        throw new Error('setup request did not enter the shared lock');
      }
    };

    const createdPromise = caller.createAdmin({ email: "Winner@Example.com", password: "winner-password", name: "Winner" });
    await waitForDepth(2);
    const resetPromise = caller.resetExistingData();
    await waitForDepth(3);
    releaseGate();
    await blocker;
    const [created, reset] = await Promise.allSettled([createdPromise, resetPromise]);
    assert.equal(created.status, "fulfilled");
    assert.equal(reset.status, "rejected");
    assert.match(String(reset.status === "rejected" ? reset.reason?.message : ""), /SETUP_LOCKED/);
    const admins = await runtime.queryRaw('SELECT "username" FROM "users" WHERE "role" = ?', ["admin"]);
    assert.deepEqual(admins.map((row) => row.username), ["winner@example.com"]);
    assert.equal(await db.getSetting("setupDataChoice"), "new-panel");
    assert.equal(fs.existsSync(path.join(process.env.FORWARDX_TEST_DIRECTORY, ".setup-complete")), true);
  `);
});

test("an active panel migration keeps setup open after administrator rows arrive", () => {
  runSetupFlow(String.raw`
    const http = await import("node:http");
    const os = await import("node:os");
    const localAddress = Object.values(os.networkInterfaces())
      .flat()
      .find((entry) => entry?.family === "IPv4" && !entry.internal)?.address;
    assert.ok(localAddress, "a non-loopback IPv4 address is required for the migration test");
    let finishRequest = () => {};
    let markRequestSeen;
    const requestSeen = new Promise((resolve) => { markRequestSeen = resolve; });
    const server = http.createServer((_request, response) => {
      finishRequest = () => {
        if (response.writableEnded) return;
        response.statusCode = 503;
        response.end("migration test finished");
      };
      markRequestSeen();
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "0.0.0.0", resolve);
    });
    try {
      const address = server.address();
      assert.ok(address && typeof address === "object");
      const job = await caller.startMigration({
        oldPanelUrl: "http://" + localAddress + ":" + address.port,
        migrationCode: "migration-test-code",
        targetPanelUrl: "http://127.0.0.1:9810",
        dataScope: "essential",
      });
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("migration request was not received")), 3000);
        requestSeen.then(() => {
          clearTimeout(timer);
          resolve();
        }, reject);
      });
      await db.createInitialAdmin({ email: "Migrated@Example.com", password: "migrated-password", name: "Migrated" });
      const status = await caller.status();
      assert.equal(status.hasAdmin, true);
      assert.equal(status.setupComplete, false);

      finishRequest();
      for (let attempt = 0; attempt < 100 && migration.getMigrationJob(job.id)?.status !== "failed"; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(migration.getMigrationJob(job.id)?.status, "failed");
    } finally {
      finishRequest();
      await new Promise((resolve) => server.close(resolve));
    }
  `);
});
