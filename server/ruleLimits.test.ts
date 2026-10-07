import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ruleTrafficUsed, ruleLimitReason } from "../shared/ruleLimits";
import { selectEffectiveForwardRateLimit, selectProtocolGuardRateLimit } from "./agentHeartbeatRoute";

test("rule quota uses cumulative directional totals; optional expiry doesn't depend on creation time", () => {
  assert.equal(ruleTrafficUsed("outbound", 600, 500), 500);
  assert.equal(ruleTrafficUsed("both", 600, 500), 1100);
  assert.equal(ruleTrafficUsed("max", 600, 500), 600);
  assert.equal(ruleLimitReason({ trafficLimit: 1000, trafficMode: "both" }, { bytesIn: 600, bytesOut: 500 }), "traffic_limit");
  assert.equal(ruleLimitReason({ trafficLimit: 1000, trafficMode: "max" }, { bytesIn: 600, bytesOut: 500 }), null);
  assert.equal(ruleLimitReason({ trafficLimit: 0, expiresAt: null }), null);
  assert.equal(ruleLimitReason({ expiresAt: new Date(10) }, undefined, 10), "expired");
  assert.equal(ruleLimitReason({ expiresAt: new Date(11) }, undefined, 10), null);
});
test("per-rule speed caps reuse supported backend guards and cannot relax wider caps", () => {
  const base = { userId: 2, hostId: 1, ruleId: 8, ruleLimitMbps: 10 };
  assert.deepEqual(selectEffectiveForwardRateLimit(base), { mbps: 10, scope: "rule-8-host-1" });
  assert.deepEqual(selectEffectiveForwardRateLimit({ ...base, userLimitMbps: 5 }), { mbps: 5, scope: "user-2-host-1" });
  assert.equal(selectEffectiveForwardRateLimit({ ...base, forwardGroupId: 2, forwardGroupLimitMbps: 3 }).mbps, 3);
  for (const forwardType of ["iptables", "nftables", "realm", "socat", "nginx"]) {
    assert.equal(selectProtocolGuardRateLimit({ agentVersion: "2.2.190", hostId: 1, rule: { forwardType, userId: 2 }, rateLimitScope: "rule-8-host-1", limitIn: 1250000, limitOut: 1250000 }).rateLimitScope, "rule-8-host-1");
  }
});
test("real SQLite rule quotas, admin permissions, expiry, resets, member inheritance and migration defaults", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-rule-limits-"));
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "server/ruleLimits.fixture.ts"], {
      cwd: process.cwd(), encoding: "utf8", timeout: 60_000,
      env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(directory, "limits.db"), FORWARDX_LOG_DIR: path.join(directory, "logs") },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
