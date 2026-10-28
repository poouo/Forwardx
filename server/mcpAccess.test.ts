import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

for (const dialect of ["mysql", "postgresql", "sqlite"]) {
  test(dialect === "sqlite" ? "MCP SQLite token lifecycle and real HTTP authentication"
    : `MCP ${dialect} SQL quotes fields after startup connection, not at module import`, () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-mcp-access-"));
    try {
      const result = spawnSync(process.execPath, ["--import", "tsx", "server/mcpAccess.fixture.ts", dialect], {
        encoding: "utf8", timeout: 30_000,
        env: { ...process.env, DATABASE_TYPE: dialect, SQLITE_PATH: path.join(directory, "fixture.db"),
          DATABASE_CONFIG_PATH: path.join(directory, "database.json"), MYSQL_CONFIG_PATH: path.join(directory, "mysql.json"),
          JWT_SECRET: "isolated-mcp-access-test-secret-not-for-production", FORWARDX_LOG_DIR: path.join(directory, "logs"),
          FORWARDX_SEAMLESS_MIGRATION_STATE_PATH: path.join(directory, "migration.json") },
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
}
