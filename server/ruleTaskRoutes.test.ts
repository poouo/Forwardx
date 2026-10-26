import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("queued rules use live sessions and original CRUD authorization, validation and cache invalidation", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-rule-tasks-"));
  const script = String.raw`
    import assert from "node:assert/strict";
    import { randomUUID } from "node:crypto";
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    const moduleUrl = file => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(moduleUrl("server/dbRuntime.ts"));
    const schema = await import(moduleUrl("server/dbSchema.ts"));
    const { rulesRouter } = await import(moduleUrl("server/routers/rules.ts"));
    const { queuedRuleTasks } = await import(moduleUrl("server/routers/rules.tasks.ts"));
    const { createAuthSession, revokeAuthSession } = await import(moduleUrl("server/repositories/sessionRepository.ts"));
    const { getUserById } = await import(moduleUrl("server/repositories/userRepository.ts"));
    const insert = async (table, data) => {
      const q = name => '"' + name + '"';
      await runtime.executeRaw("INSERT INTO " + q(table) + " (" + Object.keys(data).map(q).join(", ") + ") VALUES (" + Object.values(data).map(() => "?").join(", ") + ")", Object.values(data));
    };
    const caller = async (id, sid = "sid-" + id) => rulesRouter.createCaller({
      req: { headers: {}, protocol: "http" }, res: { clearCookie() {} },
      user: await getUserById(id), authSession: sid ? { userId: id, sid, kind: "browser", token: "NEVER-RETAIN-THIS" } : null,
      authFailureReason: null,
    });
    const action = (operation, input, conflictStrategy = "error") => ({ operation, input, conflictStrategy });
    const enqueue = (api, actions) => api.enqueueTask({ requestId: randomUUID(), title: "test batch", actions });
    const finish = async (userId, id) => {
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        const task = queuedRuleTasks.get(userId, id);
        if (task?.finishedAt) return task;
        await new Promise(resolve => setTimeout(resolve, 2));
      }
      throw Error("task did not finish");
    };
    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      for (const id of [1, 2, 3, 4, 5, 6]) {
        await insert("users", { id, username: "test-" + id, password: "x", role: id === 1 || id === 4 ? "admin" : "user", accountEnabled: 1, canAddRules: 1, balanceCents: 1000 });
        await createAuthSession({ userId: id, sid: "sid-" + id, kind: "browser", expiresAt: new Date(Date.now() + 60000) });
      }
      await insert("hosts", { id: 1, name: "test-entry", ip: "198.51.100.10", userId: 1 });
      const base = { hostId: 1, userId: 1, name: "test", forwardType: "iptables", protocol: "tcp", targetIp: "203.0.113.10", targetPort: 443, isEnabled: 1, isRunning: 1 };
      for (const id of [1, 2, 3, 4]) await insert("forward_rules", { ...base, id, userId: id === 2 ? 2 : 1, sourcePort: 15000 + id, ...(id === 2 ? { isEnabled: 0, disabledByUser: 1 } : {}) });
      const admin = await caller(1), customer = await caller(2);
      await assert.rejects(() => (async () => (await caller(1, null)).enqueueTask({ requestId: randomUUID(), title: "test", actions: [action("delete", { id: 4 })] }))(), /重新登录/);

      const partial = await enqueue(customer, [action("restart", { id: 1 }), action("restart", { id: 2 }), action("restart", { id: 0 })]);
      const result = await finish(2, partial.task.id);
      assert.deepEqual([result.failed, result.skipped, result.succeeded], [2, 1, 0]);
      assert.match(result.results[0].error, /无权/);
      assert.doesNotMatch(JSON.stringify(result), /NEVER-RETAIN|sid-2|targetIp|"input"/);
      assert.equal((await admin.taskStatus({ ids: [result.id] })).tasks[0], null);
      assert.equal((await admin.taskLookup({ requestId: result.requestId })).task, null);
      await assert.rejects(() => admin.cancelTask({ id: result.id }), /不存在/);

      const key = { requestId: randomUUID(), title: "delete one", actions: [action("delete", { id: 4 })] };
      const first = await admin.enqueueTask(key), duplicate = await admin.enqueueTask(key);
      assert.equal(first.task.id, duplicate.task.id);
      assert.equal((await finish(1, first.task.id)).succeeded, 1);
      assert.equal((await admin.taskLookup({ requestId: key.requestId })).task.id, first.task.id);

      const create = { hostId: 1, name: "queued-create", forwardType: "iptables", protocol: "tcp", sourcePort: 16200, targetIp: "203.0.113.20", targetPort: 443 };
      const created = await enqueue(admin, [action("create", create), action("create", { ...create, name: "skipped" }, "skip"), action("create", { ...create, name: "random" }, "auto")]);
      const createdResult = await finish(1, created.task.id);
      assert.deepEqual([createdResult.succeeded, createdResult.skipped, createdResult.failed], [2, 1, 0], JSON.stringify(createdResult));
      const id = createdResult.results[0].value.id;
      const mutations = await enqueue(admin, [action("update", { id, name: "updated" }), action("toggle", { id, isEnabled: false }), action("restart", { id }), action("delete", { id })]);
      const updated = await finish(1, mutations.task.id);
      assert.deepEqual([updated.succeeded, updated.skipped, updated.failed], [3, 1, 0], JSON.stringify(updated));

      const revokedApi = await caller(3);
      const revoked = await enqueue(revokedApi, [action("restart", { id: 1 }), action("restart", { id: 1 })]);
      await revokeAuthSession(3, "sid-3", "browser");
      const revokedResult = await finish(3, revoked.task.id);
      assert.deepEqual([revokedResult.failed, revokedResult.cancelled], [1, 1]);
      assert.match(revokedResult.results[0].error, /失效/);

      const formerAdmin = await caller(4);
      const demoted = await enqueue(formerAdmin, [action("delete", { id: 3 })]);
      await runtime.executeRaw('UPDATE "users" SET "role" = ? WHERE "id" = ?', ["user", 4]);
      const demotedResult = await finish(4, demoted.task.id);
      assert.equal(demotedResult.failed, 1, "queued job cannot retain old administrator role");
      assert.match(demotedResult.results[0].error, /无权/);
      assert.equal((await runtime.queryRaw('SELECT "id" FROM "forward_rules" WHERE "id" = 3')).length, 1);

      const disabled = await enqueue(await caller(5), [action("restart", { id: 1 }), action("restart", { id: 1 })]);
      await runtime.executeRaw('UPDATE "users" SET "accountEnabled" = 0 WHERE "id" = 5');
      const disabledResult = await finish(5, disabled.task.id);
      assert.deepEqual([disabledResult.failed, disabledResult.cancelled], [1, 1]);
      assert.match(disabledResult.results[0].error, /失效/);
      const replaced = await enqueue(await caller(6), [action("restart", { id: 1 }), action("restart", { id: 1 })]);
      await runtime.executeRaw('UPDATE "users" SET "browserSessionToken" = ? WHERE "id" = 6', [JSON.stringify({ sid: "replacement", activeAt: Date.now() })]);
      const replacedResult = await finish(6, replaced.task.id);
      assert.deepEqual([replacedResult.failed, replacedResult.cancelled], [1, 1]);
      assert.match(replacedResult.results[0].error, /替换/);
    } finally { await runtime.closeDatabase(); }
  `;
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(), encoding: "utf8", timeout: 60_000,
      env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(directory, "tasks.db"), FORWARDX_LOG_DIR: path.join(directory, "logs"), FORWARDX_DEV_PANEL: "0" },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
