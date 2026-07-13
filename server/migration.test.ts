import assert from "node:assert/strict";
import test from "node:test";
import {
  buildMigrationRuntimeExpectations,
  type MigrationImportedIds,
  type MigrationSnapshot,
} from "./migration";
import {
  approveMigrationRequest,
  consumeApprovedMigrationRequest,
  consumeTakeoverToken,
  createMigrationCode,
  createMigrationRequest,
  prepareTakeoverToken,
} from "./migrationCodes";

function snapshot(tables: MigrationSnapshot["tables"]): MigrationSnapshot {
  return {
    version: 1,
    exportedAt: 2_000_000,
    tables,
  };
}

const importedIds: MigrationImportedIds = {
  hosts: { 1: 101, 2: 102 },
  tunnels: { 10: 110 },
  forwardRules: { 20: 120, 21: 121 },
};

test("migration runtime expectations include fresh hosts and previously running resources", () => {
  const result = buildMigrationRuntimeExpectations(snapshot({
    hosts: [
      { id: 1, isOnline: true, lastHeartbeat: 1_990 },
      { id: 2, isOnline: true, lastHeartbeat: 1_000 },
    ],
    tunnels: [{ id: 10, isEnabled: true, isRunning: true }],
    forward_rules: [
      { id: 20, isEnabled: true, isRunning: true, pendingDelete: false },
      { id: 21, isEnabled: true, isRunning: false, pendingDelete: false },
    ],
  }), importedIds);

  assert.deepEqual(result.hostIds, [101]);
  assert.deepEqual(result.ruleIds, [120]);
  assert.deepEqual(result.tunnelIds, [110]);
  assert.deepEqual(result.allImportedHostIds, [101, 102]);
});

test("migration refuses active forwarding when no online Agent can be verified", () => {
  assert.throws(() => buildMigrationRuntimeExpectations(snapshot({
    hosts: [{ id: 1, isOnline: false, lastHeartbeat: 1_990 }],
    forward_rules: [{ id: 20, isEnabled: true, isRunning: true, pendingDelete: false }],
  }), importedIds), /没有可验证的在线 Agent/);
});

test("takeover token is target-bound and can only commit after prepare", () => {
  const code = createMigrationCode();
  const target = "https://new.example.com";
  const request = createMigrationRequest(code.code, target);
  assert.ok(request);
  assert.ok(approveMigrationRequest(request.id));
  const takeover = consumeApprovedMigrationRequest(request.id, code.code, target);
  assert.ok(takeover);

  assert.equal(consumeTakeoverToken(takeover.takeoverToken, target), false);
  assert.equal(prepareTakeoverToken(takeover.takeoverToken, "https://other.example.com"), null);
  assert.ok(prepareTakeoverToken(takeover.takeoverToken, target));
  assert.equal(consumeTakeoverToken(takeover.takeoverToken, "https://other.example.com"), false);
  assert.equal(consumeTakeoverToken(takeover.takeoverToken, target), true);
  assert.equal(consumeTakeoverToken(takeover.takeoverToken, target), false);
});
