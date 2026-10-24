import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentInstallationGate, normalizeAgentInstallationId } from "./agentInstallation";

test("installation IDs reject malformed or non-string values", () => {
  assert.equal(normalizeAgentInstallationId("a".repeat(64)), "a".repeat(64));
  for (const value of [undefined, {}, "", "x".repeat(64), "a".repeat(65), "A".repeat(64)]) assert.equal(normalizeAgentInstallationId(value), "");
});

test("registration drains old reports and blocks later reports until the switch completes", async () => {
  const gate = new AgentInstallationGate();
  const report1 = await gate.acquire("same-token");
  const report2 = await gate.acquire("same-token");
  const order: string[] = [];
  const claim = gate.acquire("same-token", true).then((release) => { order.push("register"); return release; });
  const laterReport = gate.acquire("same-token").then((release) => { order.push("report"); return release; });
  const otherHost = await gate.acquire("other-token", true);
  otherHost();
  report1();
  await Promise.resolve();
  assert.deepEqual(order, []);
  report2();
  const releaseClaim = await claim;
  assert.deepEqual(order, ["register"]);
  releaseClaim();
  releaseClaim(); // response finish + close must be idempotent
  (await laterReport)();
  assert.deepEqual(order, ["register", "report"]);
});

test("same-token registration, Realm recovery and stale-agent fencing survive restart", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-agent-ownership-"));
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "server/agentInstallation.fixture.ts"], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(directory, "ownership.db"), FORWARDX_DEV_PANEL: "1" },
      encoding: "utf8",
      timeout: 60_000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
