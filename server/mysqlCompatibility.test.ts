import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import mysql, { type ConnectionOptions, type PoolOptions } from "mysql2/promise";
import { MYSQL_COMPATIBILITY_FLAGS } from "./mysqlCompatibility";

const QUERY_ATTRIBUTES = 0x08000000;
const config = { host: "localhost", port: 3306, user: "test", password: "test-only", database: "test", ssl: false };

test("MySQL compatibility disables only query attributes, retaining every other driver capability", async () => {
  const defaults = mysql.createPool({ ...config, ssl: undefined });
  const compatible = mysql.createPool({ ...config, ssl: undefined, flags: MYSQL_COMPATIBILITY_FLAGS });
  try {
    const flags = (pool: mysql.Pool) => (pool as any).pool.config.connectionConfig.clientFlags;
    assert.equal(flags(compatible) & QUERY_ATTRIBUTES, 0);
    assert.equal(flags(compatible), flags(defaults) & ~QUERY_ATTRIBUTES);
  } finally {
    await Promise.all([defaults.end(), compatible.end()]);
  }
});

test("setup checks, monitoring and runtime pools all use compatible MySQL options with and without TLS", async (t) => {
  const previousType = process.env.DATABASE_TYPE;
  process.env.DATABASE_TYPE = "mysql";
  const runtime = await import("./dbRuntime");
  const { probeDatabase } = await import("./databaseHealthMonitor");
  const connections: ConnectionOptions[] = [];
  const pools: PoolOptions[] = [];
  const createPool = mysql.createPool;
  let ended = 0;
  let destroyed = 0;
  t.mock.method(mysql, "createConnection", async (options: ConnectionOptions) => {
    connections.push(options);
    return {
      async ping() {},
      async query() { return [[{ version: "8.0.24" }], []]; },
      async end() { ended++; },
      destroy() { destroyed++; },
    };
  });
  t.mock.method(mysql, "createPool", (options: PoolOptions) => {
    pools.push(options);
    const pool = createPool(options);
    t.mock.method(pool, "query", async () => [[{ version: "8.0.24" }], []]);
    return pool;
  });
  assert.equal(runtime.getSchemaDialect(), "mysql");
  try {
    for (const ssl of [false, true]) {
      const input = { ...config, ssl };
      await runtime.testMysqlConnection(input);
      await probeDatabase({ type: "mysql", mysql: input });
      await runtime.connectDatabase({ type: "mysql", mysql: input });
      assert.equal((runtime.getPool() as any).pool.config.connectionConfig.clientFlags & QUERY_ATTRIBUTES, 0);
      await runtime.closeDatabase();
    }
    assert.equal(connections.length, 4);
    assert.equal(pools.length, 2);
    assert.equal(ended, 2);
    assert.equal(destroyed, 2);
    const optionsWithTls = new Set([connections[2], connections[3], pools[1]]);
    for (const options of [...connections, ...pools]) {
      assert.equal(options.flags, MYSQL_COMPATIBILITY_FLAGS);
      assert.equal(options.password, config.password);
      assert.equal(options.multipleStatements, undefined, "do not enable SQL statement concatenation");
      assert.equal(options.ssl !== undefined, optionsWithTls.has(options));
      if (options.ssl) assert.notEqual((options.ssl as { rejectUnauthorized?: boolean }).rejectUnauthorized, false);
    }
  } finally {
    await runtime.closeDatabase();
    if (previousType === undefined) delete process.env.DATABASE_TYPE;
    else process.env.DATABASE_TYPE = previousType;
  }
});

test("database switch and legacy migration clients share the same compatibility policy", () => {
  for (const file of ["databaseSwitch.ts", "legacyMigrationCli.ts"]) {
    const source = fs.readFileSync(new URL(file, import.meta.url), "utf8");
    assert.match(source, /import \{ MYSQL_COMPATIBILITY_FLAGS \} from "\.\/mysqlCompatibility"/);
    assert.match(source, /flags: MYSQL_COMPATIBILITY_FLAGS/);
  }
});
