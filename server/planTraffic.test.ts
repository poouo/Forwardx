import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDatabaseTableDefs } from "./dbSchema";

test("all database dialects define a backward-compatible two-way default for plans", () => {
  const column = getDatabaseTableDefs().find(table => table.name === "subscription_plans")!.columns.find(column => column.name === "trafficMode");
  assert.deepEqual(column, { name: "trafficMode", type: "varchar", length: 16, notNull: true, default: "both" });
});

test("plan snapshots, edits and actual Agent accounting honor the selected mode without rewriting history", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-plan-traffic-"));
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "server/planTraffic.fixture.ts"], {
      cwd: process.cwd(), encoding: "utf8", timeout: 90000,
      env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(directory, "fixture.db"), FORWARDX_LOG_DIR: path.join(directory, "logs"), JWT_SECRET: "plan-traffic-test-secret-32-characters" },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
