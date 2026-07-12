import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { portForwardTemplateHostRepairs } from "./portForwardRuleHosts";

test("repairs stale port-forward template hosts using the current highest-priority member", () => {
  const repairs = portForwardTemplateHostRepairs([
    { ruleId: 10, storedHostId: 1, groupId: 5, memberId: 22, memberHostId: 3, memberPriority: 1 },
    { ruleId: 10, storedHostId: 1, groupId: 5, memberId: 21, memberHostId: 2, memberPriority: 0 },
    { ruleId: 11, storedHostId: 4, groupId: 6, memberId: 23, memberHostId: 4, memberPriority: 0 },
  ]);

  assert.deepEqual(repairs, [
    { ruleId: 10, groupId: 5, fromHostId: 1, toHostId: 2 },
  ]);
});

test("ignores invalid and duplicate member rows", () => {
  assert.deepEqual(portForwardTemplateHostRepairs([
    { ruleId: 0, storedHostId: 1, groupId: 5, memberId: 1, memberHostId: 2, memberPriority: 0 },
    { ruleId: 12, storedHostId: 1, groupId: 5, memberId: 1, memberHostId: 0, memberPriority: 0 },
  ]), []);
});

test("repairs persisted port-forward hosts before host deletion checks", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-port-host-"));
  const databasePath = path.join(directory, "repair.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const moduleUrl = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(moduleUrl("server/dbRuntime.ts"));
    const repairModule = await import(moduleUrl("server/portForwardRuleHosts.ts"));
    const hostRepository = await import(moduleUrl("server/repositories/hostRepository.ts"));

    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
    await runtime.executeRaw('CREATE TABLE "forward_groups" ("id" INTEGER PRIMARY KEY, "groupMode" TEXT NOT NULL)');
    await runtime.executeRaw('CREATE TABLE "forward_group_members" ("id" INTEGER PRIMARY KEY, "groupId" INTEGER NOT NULL, "memberType" TEXT NOT NULL, "hostId" INTEGER, "priority" INTEGER NOT NULL, "ruleId" INTEGER)');
    await runtime.executeRaw('CREATE TABLE "forward_rules" ("id" INTEGER PRIMARY KEY, "hostId" INTEGER NOT NULL, "forwardGroupId" INTEGER, "forwardGroupRuleId" INTEGER, "isForwardGroupTemplate" INTEGER NOT NULL, "pendingDelete" INTEGER NOT NULL, "isRunning" INTEGER NOT NULL, "updatedAt" INTEGER NOT NULL)');
    await runtime.executeRaw('INSERT INTO "forward_groups" ("id", "groupMode") VALUES (5, \'port\')');
    await runtime.executeRaw('INSERT INTO "forward_group_members" ("id", "groupId", "memberType", "hostId", "priority", "ruleId") VALUES (20, 5, \'host\', 2, 0, NULL)');
    await runtime.executeRaw('INSERT INTO "forward_rules" ("id", "hostId", "forwardGroupId", "forwardGroupRuleId", "isForwardGroupTemplate", "pendingDelete", "isRunning", "updatedAt") VALUES (10, 1, 5, NULL, 1, 0, 1, 1)');

    const repairs = await repairModule.repairPortForwardRuleHostReferences(5);
    assert.deepEqual(repairs, [{ ruleId: 10, groupId: 5, fromHostId: 1, toHostId: 2 }]);
    const rows = await runtime.queryRaw('SELECT "hostId", "isRunning" FROM "forward_rules" WHERE "id" = 10');
    assert.deepEqual(rows, [{ hostId: 2, isRunning: 0 }]);

    const oldHostBlockers = await hostRepository.getHostRuleDeleteBlockers(1);
    assert.deepEqual(oldHostBlockers, { ruleCount: 0, managedRuleCount: 0, pendingCleanupCount: 0 });
    const currentHostBlockers = await hostRepository.getHostRuleDeleteBlockers(2);
    assert.equal(currentHostBlockers.ruleCount, 1);

    await runtime.executeRaw('DELETE FROM "forward_rules" WHERE "hostId" = 1');
    const retained = await runtime.queryRaw('SELECT "id", "hostId" FROM "forward_rules" WHERE "id" = 10');
    assert.deepEqual(retained, [{ id: 10, hostId: 2 }]);
    await runtime.closeDatabase();
  `;

  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DATABASE_TYPE: "sqlite",
        FORWARDX_TEST_DB: databasePath,
      },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
