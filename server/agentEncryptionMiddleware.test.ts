import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("Agent encryption authenticates database-backed credentials and preserves response semantics", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-agent-middleware-"));
  try {
    const { NODE_TEST_CONTEXT: _testContext, ...environment } = process.env;
    const result = spawnSync(process.execPath, ["--import", "tsx", "--test", "server/agentEncryptionMiddleware.fixture.ts"], {
      cwd: process.cwd(), encoding: "utf8", timeout: 60000,
      env: { ...environment, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(directory, "middleware.db"), DATABASE_CONFIG_PATH: path.join(directory, "database.json"), FORWARDX_LOG_DIR: path.join(directory, "logs"), JWT_SECRET: "isolated-agent-middleware-test-secret" },
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /authenticated business 403 stays accepted and encrypted/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
