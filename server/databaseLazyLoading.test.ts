import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("SQLite startup, health and migration imports do not load other database drivers", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-lazy-db-"));
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", String.raw`
      import assert from "node:assert/strict";
      import { createRequire } from "node:module";
      const require = createRequire(import.meta.url);
      const loaded = name => Object.keys(require.cache).some(file => file.replaceAll("\\", "/").includes("/node_modules/" + name + "/"));
      const rt = await import("./server/dbRuntime.ts");
      const health = await import("./server/databaseHealthMonitor.ts");
      await import("./server/databaseSwitch.ts");
      await import("./server/migration.ts");
      for (const name of ["mysql2", "pg", "better-sqlite3"]) assert.equal(loaded(name), false, name + " loaded too early");
      const config = { type: "sqlite", sqlite: { path: process.env.SQLITE_PATH } };
      await rt.testDatabaseConnection(config);
      await rt.connectDatabase(config);
      try {
        await health.probeDatabase(config);
        await rt.executeRaw("CREATE TABLE lazy_probe (value INTEGER)");
        await rt.withDatabaseTransaction(async () => {
          await rt.executeRaw("INSERT INTO lazy_probe (value) VALUES (?)", [7]);
          assert.equal((await rt.queryRaw("SELECT value FROM lazy_probe"))[0].value, 7);
        });
        assert.equal(loaded("better-sqlite3"), true);
        assert.equal(loaded("mysql2"), false);
        assert.equal(loaded("pg"), false);
        // A future migration can request another driver without restarting or
        // opening a connection to that database merely by loading the module.
        const drivers = await import("./server/databaseDrivers.ts");
        const mysql = await drivers.loadMysqlDriver();
        assert.equal(typeof mysql.createPool, "function");
        assert.equal(loaded("mysql2"), true);
        assert.equal(loaded("pg"), false);
        assert.equal(await drivers.loadMysqlDriver(), mysql);
        const pg = await drivers.loadPostgresqlDriver();
        assert.equal(typeof pg.Pool, "function");
        assert.equal(loaded("pg"), true);
      } finally { await rt.closeDatabase(); }
    `], {
      encoding: "utf8", timeout: 30_000,
      env: {
        ...process.env, DATABASE_TYPE: "sqlite", SQLITE_PATH: path.join(directory, "panel.db"),
        DATABASE_CONFIG_PATH: path.join(directory, "database.json"),
        MYSQL_CONFIG_PATH: path.join(directory, "mysql.json"),
        JWT_SECRET: "lazy-driver-loading-test-only-secret",
      },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout || String(result.error));
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
