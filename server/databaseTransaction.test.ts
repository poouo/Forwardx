import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import mysql from "mysql2/promise";
import pg from "pg";
import { databasePoolSettingsForHostCount } from "./databasePoolSizing";
import { testMysqlConnection, testPostgresqlConnection } from "./dbRuntime";

test("database pool capacity scales automatically with the host count", () => {
  assert.deepEqual(databasePoolSettingsForHostCount(30), {
    maxOpen: 16,
    maxIdle: 16,
    queueLimit: 256,
    idleTimeoutMillis: 300_000,
    maxLifetimeSeconds: 0,
    connectTimeoutMillis: 6000,
  });
  assert.deepEqual(
    { maxOpen: databasePoolSettingsForHostCount(31).maxOpen, queueLimit: databasePoolSettingsForHostCount(31).queueLimit },
    { maxOpen: 24, queueLimit: 384 },
  );
  assert.equal(databasePoolSettingsForHostCount(101).maxOpen, 32);
  assert.equal(databasePoolSettingsForHostCount(10_000).maxOpen, 32);
});

test("MySQL pool tiers retain opened connections and bound queued work", () => {
  for (const hostCount of [0, 30, 31, 100, 101, 10_000]) {
    const settings = databasePoolSettingsForHostCount(hostCount);
    assert.equal(settings.maxIdle, settings.maxOpen, `hostCount=${hostCount}`);
    assert.ok(settings.queueLimit >= settings.maxOpen, `hostCount=${hostCount}`);
    assert.ok(settings.queueLimit <= 512, `hostCount=${hostCount}`);
  }
});

test("MySQL pool does not start the rapid excess-idle connection reaper", async () => {
  const settings = databasePoolSettingsForHostCount(30);
  const pool = mysql.createPool({
    host: "127.0.0.1",
    user: "forwardx",
    database: "forwardx",
    connectionLimit: settings.maxOpen,
    maxIdle: settings.maxIdle,
    idleTimeout: settings.idleTimeoutMillis,
    queueLimit: settings.queueLimit,
  });
  try {
    const basePool = (pool as any).pool;
    assert.equal(basePool.config.connectionLimit, 16);
    assert.equal(basePool.config.maxIdle, 16);
    assert.equal(basePool.config.queueLimit, 256);
    assert.equal(basePool._removeIdleTimeoutConnectionsTimer, undefined);
  } finally {
    await pool.end();
  }
});

test("PostgreSQL pool retains opened clients without synchronized lifetime rotation", async () => {
  const settings = databasePoolSettingsForHostCount(30);
  const pool = new pg.Pool({
    host: "127.0.0.1",
    user: "forwardx",
    database: "forwardx",
    max: settings.maxOpen,
    min: settings.maxIdle,
    idleTimeoutMillis: settings.idleTimeoutMillis,
    connectionTimeoutMillis: settings.connectTimeoutMillis,
    maxLifetimeSeconds: settings.maxLifetimeSeconds,
  } as pg.PoolConfig);
  try {
    assert.equal(pool.options.max, 16);
    assert.equal(pool.options.min, 16);
    assert.equal(pool.options.connectionTimeoutMillis, 6000);
    assert.equal(pool.options.maxLifetimeSeconds, 0);
    assert.equal(pool.totalCount, 0, "the stable minimum must not eagerly open PostgreSQL connections");
  } finally {
    await pool.end();
  }
});

async function verifyLoopbackDatabaseConnection(connect: (port: number) => Promise<void>) {
  let acceptedConnections = 0;
  const server = net.createServer((socket) => {
    acceptedConnections += 1;
    socket.destroy();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    let connectionError: unknown;
    try {
      await connect(address.port);
    } catch (error) {
      connectionError = error;
    }
    assert.ok(connectionError instanceof Error);
    assert.doesNotMatch(connectionError.message, /(?:不允许访问|受限地址)/);
    assert.ok(acceptedConnections > 0, "database driver should attempt a real loopback connection");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("database checks allow user-provided loopback MySQL and PostgreSQL hosts", async () => {
  await verifyLoopbackDatabaseConnection((port) => testMysqlConnection({
    host: "127.0.0.1",
    port,
    user: "forwardx",
    password: "test",
    database: "forwardx",
  }));
  await verifyLoopbackDatabaseConnection((port) => testPostgresqlConnection({
    host: "127.0.0.1",
    port,
    user: "forwardx",
    password: "test",
    database: "forwardx",
  }));
});

test("SQLite billing transactions roll back and serialize concurrent updates", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-transaction-"));
  const databasePath = path.join(directory, "transaction.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(url("server/dbRuntime.ts"));
    const schema = await import(url("server/dbSchema.ts"));
    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      await runtime.executeRaw('INSERT INTO "users" ("id", "username", "password", "name", "role", "balanceCents") VALUES (?, ?, ?, ?, ?, ?)', [1, "alice", "x", "Alice", "user", 1000]);

      await assert.rejects(() => runtime.withDatabaseTransaction(async () => {
        await runtime.executeRaw('UPDATE "users" SET "balanceCents" = ? WHERE "id" = ?', [1, 1]);
        await runtime.withDatabaseTransaction(async () => {
          await runtime.executeRaw('UPDATE "users" SET "balanceCents" = ? WHERE "id" = ?', [2, 1]);
        });
        throw new Error("rollback");
      }), /rollback/);
      assert.equal((await runtime.queryRaw('SELECT "balanceCents" FROM "users" WHERE "id" = ?', [1]))[0].balanceCents, 1000);

      const billing = await import(url("server/repositories/billingRepository.ts"));
      await Promise.all(Array.from({ length: 20 }, () => billing.addUserBalance(1, -10, { type: "purchase", description: "concurrent" })));
      assert.equal((await runtime.queryRaw('SELECT "balanceCents" FROM "users" WHERE "id" = ?', [1]))[0].balanceCents, 800);
      assert.equal((await runtime.queryRaw('SELECT COUNT(*) AS count FROM "balance_transactions"'))[0].count, 20);

      await runtime.executeRaw('INSERT INTO "discount_codes" ("id", "code", "discountType", "discountValue", "maxUses", "usedCount", "isActive") VALUES (?, ?, ?, ?, ?, ?, ?)', [1, "ONLY-ONE", "percent", 10, 1, 0, true]);
      const attempts = await Promise.allSettled(Array.from({ length: 8 }, () => billing.consumeDiscountCode(1)));
      assert.equal(attempts.filter((item) => item.status === "fulfilled").length, 1);
      assert.equal((await runtime.queryRaw('SELECT "usedCount" FROM "discount_codes" WHERE "id" = ?', [1]))[0].usedCount, 1);

      const nowSeconds = Math.floor(Date.now() / 1000);
      await runtime.executeRaw('INSERT INTO "redemption_codes" ("id", "code", "type", "amountCents", "startsAt", "isActive") VALUES (?, ?, ?, ?, ?, ?)', [1, "FUTURE-CODE", "balance", 50, nowSeconds + 3600, true]);
      await runtime.executeRaw('INSERT INTO "redemption_codes" ("id", "code", "type", "amountCents", "expiresAt", "isActive") VALUES (?, ?, ?, ?, ?, ?)', [2, "ACTIVE-CODE", "balance", 50, nowSeconds + 3600, true]);
      await assert.rejects(() => billing.redeemCode(1, "FUTURE-CODE", "future-test"));
      const redeemed = await billing.redeemCode(1, "ACTIVE-CODE", "active-test");
      assert.equal(redeemed.success, true);
      assert.equal((await runtime.queryRaw('SELECT "balanceCents" FROM "users" WHERE "id" = ?', [1]))[0].balanceCents, 850);

      await runtime.executeRaw('INSERT INTO "hosts" ("id", "name", "ip", "hostType", "userId") VALUES (?, ?, ?, ?, ?)', [1, "edge", "127.0.0.1", "slave", 1]);
      await runtime.executeRaw('INSERT INTO "forward_rules" ("id", "hostId", "name", "forwardType", "protocol", "sourcePort", "targetIp", "targetPort", "userId") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [1, 1, "tcp", "gost", "tcp", 12000, "127.0.0.1", 80, 1]);
      await runtime.executeRaw('INSERT INTO "forward_rules" ("id", "hostId", "name", "forwardType", "protocol", "sourcePort", "targetIp", "targetPort", "userId") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [2, 1, "udp", "gost", "udp", 12000, "127.0.0.1", 80, 1]);
      const rules = await import(url("server/repositories/forwardRuleRepository.ts"));
      const repaired = await rules.repairConflictingProtocolPortRules();
      assert.equal(repaired.length, 1);
      const ruleRows = await runtime.queryRaw('SELECT "id", "isEnabled", "protocolBlockReason" FROM "forward_rules" ORDER BY "id"');
      assert.equal(ruleRows[0].isEnabled, 1);
      assert.equal(ruleRows[1].isEnabled, 0);
      assert.match(ruleRows[1].protocolBlockReason, /规则 #1 冲突/);
    } finally {
      await runtime.closeDatabase();
    }
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: databasePath },
    encoding: "utf8",
    timeout: 60_000,
  });
  fs.rmSync(directory, { recursive: true, force: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
