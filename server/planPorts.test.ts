import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("unlimited and large plan port allocations work across purchases, renewals, syncing and resource policies", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-plan-ports-"));
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "server/planPorts.fixture.ts"], {
      cwd: process.cwd(), encoding: "utf8", timeout: 90000,
      env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(directory, "fixture.db"), FORWARDX_LOG_DIR: path.join(directory, "logs"), JWT_SECRET: "plan-ports-test-secret-32-characters" },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
