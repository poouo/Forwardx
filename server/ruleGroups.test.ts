import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { personalRuleGroupIdsSchema, personalRuleGroupSaveSchema, personalRuleGroupChangeFilterSchema } from "../shared/ruleGroups";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-rule-groups-"));
process.env.DATABASE_TYPE = "sqlite";
process.env.SQLITE_PATH = path.join(directory, "groups.db");
process.env.DATABASE_CONFIG_PATH = path.join(directory, "database.json");
process.env.FORWARDX_LOG_DIR = path.join(directory, "logs");
let runtime: typeof import("./dbRuntime");
let groups: typeof import("./repositories/ruleGroupRepository");
let rules: typeof import("./repositories/forwardRuleRepository");
let router: typeof import("./routers/rules").rulesRouter;
const context = (id: number, role = "user") => ({ user: { id, role, username: `user-${id}`, accountEnabled: true }, req: { headers: {}, socket: {} }, res: {} }) as any;
const payload = (userId: number, name: string) => ({ userId, name, hostId: 1, forwardType: "realm", protocol: "tcp", sourcePort: 10000, targetIp: "192.0.2.1", targetPort: 443 }) as any;
let ruleA: number, ruleB: number, ruleOther: number, groupA: number, groupB: number, groupOther: number;

before(async () => {
  runtime = await import("./dbRuntime");
  await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.SQLITE_PATH! } });
  await (await import("./dbSchema")).ensureDatabaseSchema();
  groups = await import("./repositories/ruleGroupRepository");
  rules = await import("./repositories/forwardRuleRepository");
  router = (await import("./routers/rules")).rulesRouter;
  for (const id of [1, 2, 3]) await runtime.insertAndGetId("users", { id, username: `user-${id}`, password: "unused", role: id === 3 ? "admin" : "user" });
  ruleA = await runtime.insertAndGetId("forward_rules", payload(1, "alpha"));
  ruleB = await runtime.insertAndGetId("forward_rules", { ...payload(1, "beta"), adminManaged: true });
  ruleOther = await runtime.insertAndGetId("forward_rules", payload(2, "other"));
  groupA = (await groups.savePersonalRuleGroup(1, "游戏")).id;
  groupB = (await groups.savePersonalRuleGroup(1, "常用")).id;
  groupOther = (await groups.savePersonalRuleGroup(2, "游戏")).id;
});
after(async () => { await runtime?.closeDatabase(); fs.rmSync(directory, { recursive: true, force: true }); });

test("personal group schema deduplicates IDs and rejects invalid input", () => {
  assert.deepEqual(personalRuleGroupIdsSchema.parse([1, 2, 1]), [1, 2]);
  for (const value of [[0], [-1], [1.5], Array(101).fill(1)]) assert.equal(personalRuleGroupIdsSchema.safeParse(value).success, false);
});

test("multiple memberships, independent totals, add/remove/replace, managed rules", async () => {
  await groups.moveRulesToPersonalGroups(1, [ruleA, ruleB], [groupA, groupB], "replace");
  const data = await groups.getPersonalRuleGroups(1);
  assert.equal(data.total, 2);
  assert.equal(data.ungrouped, 0);
  assert.deepEqual(data.groups.map(group => group.count), [2, 2]);
  await groups.moveRulesToPersonalGroups(1, [ruleA], [groupA], "remove");
  assert.deepEqual((await groups.getRulePersonalGroupIds(1, [ruleA])).get(ruleA), [groupB]);
  await groups.moveRulesToPersonalGroups(1, [ruleA], [groupA, groupA], "add");
  assert.deepEqual((await groups.getRulePersonalGroupIds(1, [ruleA])).get(ruleA), [groupA, groupB]);
  await groups.moveRulesToPersonalGroups(1, [ruleB], [], "replace");
  assert.equal((await groups.getPersonalRuleGroups(1)).ungrouped, 1);
});

test("cross-owner access and mixed batches fail atomically, including administrators", async () => {
  const caller = router.createCaller(context(1));
  const before = await groups.getRulePersonalGroupIds(1, [ruleA]);
  await assert.rejects(caller.moveToPersonalGroups({ ids: [ruleA, ruleOther], groupIds: [], mode: "replace" }), { code: "FORBIDDEN" });
  await assert.rejects(caller.moveToPersonalGroups({ ids: [ruleA], groupIds: [groupOther], mode: "add" }), { code: "NOT_FOUND" });
  await assert.rejects(caller.deletePersonalGroup({ id: groupOther }), { code: "NOT_FOUND" });
  await assert.rejects(caller.savePersonalGroup({ id: groupOther, name: "no" }), { code: "NOT_FOUND" });
  await assert.rejects(router.createCaller(context(3, "admin")).moveToPersonalGroups({ ids: [ruleA], groupIds: [], mode: "replace" }), { code: "FORBIDDEN" });
  // Unknown owner fields cannot change the server-derived owner.
  const own = await (caller.personalGroups as any)({ userId: 2 });
  assert.deepEqual(own.groups.map((group: any) => group.id), [groupA, groupB]);
  assert.deepEqual(await groups.getRulePersonalGroupIds(1, [ruleA]), before);
});

test("page/map/summary filters agree and do not duplicate multiply grouped rules", async () => {
  const filter = { ownerUserId: 1, personalGroupOwnerId: 1, personalGroupId: groupA, category: "all" as const, search: "" };
  const page = await rules.getForwardRulesPage({ ...filter, page: 1, pageSize: 12 });
  const map = await rules.getForwardRuleMapBatch(filter, 0, 20);
  const summary = await rules.getForwardRuleSummarySelection(filter);
  assert.equal(page.totalItems, 1);
  assert.equal(page.categoryCounts.all, 1);
  assert.deepEqual(page.items.map((rule: any) => rule.id), [ruleA]);
  assert.equal(map.totalItems, 1);
  assert.equal(summary.totalItems, 1);
  assert.deepEqual(summary.ruleIds, [ruleA]);
  const ungrouped = await rules.getForwardRulesPage({ ...filter, personalGroupId: 0 });
  assert.deepEqual(ungrouped.items.map((rule: any) => rule.id), [ruleB]);
  assert.equal((await rules.getForwardRulesPage({ ...filter, personalGroupId: groupOther })).totalItems, 0);
  assert.equal((await rules.getForwardRulesPage({ ...filter, ownerUserId: 2 })).totalItems, 0);
  const decorated = await router.createCaller(context(1)).getById({ id: ruleA });
  assert.deepEqual((decorated as any).personalGroupIds, [groupA, groupB]);
  const adminView = await router.createCaller(context(3, "admin")).getById({ id: ruleA });
  assert.deepEqual((adminView as any).personalGroupIds, []);
});

test("pending and hidden children cannot be organized", async () => {
  const pending = await runtime.insertAndGetId("forward_rules", { ...payload(1, "pending"), pendingDelete: true });
  const child = await runtime.insertAndGetId("forward_rules", { ...payload(1, "child"), forwardGroupRuleId: ruleA });
  for (const id of [pending, child]) await assert.rejects(groups.moveRulesToPersonalGroups(1, [ruleA, id], [], "replace"), { code: "FORBIDDEN" });
  assert.equal((await groups.getPersonalRuleGroups(1)).total, 2);
});

test("create and update save memberships atomically; metadata never enters rule columns", async () => {
  const created = await rules.createForwardRule({ ...payload(1, "created"), personalGroupIds: [groupA, groupB] });
  assert.deepEqual((await groups.getRulePersonalGroupIds(1, [created])).get(created), [groupA, groupB]);
  await rules.updateForwardRule(created, { name: "changed", personalGroupIds: [groupB] });
  assert.deepEqual((await groups.getRulePersonalGroupIds(1, [created])).get(created), [groupB]);
  await assert.rejects(rules.updateForwardRule(created, { name: "bad", personalGroupIds: [groupOther] }));
  assert.equal((await rules.getForwardRuleById(created))?.name, "changed");
  await assert.rejects(rules.createForwardRule({ ...payload(1, "must rollback"), personalGroupIds: [groupOther] }));
  assert.equal((await runtime.queryRaw<any>('SELECT id FROM forward_rules WHERE name = ?', ["must rollback"])).length, 0);
  await rules.deleteForwardRule(created);
  await rules.finalizeForwardRuleDelete(created);
  assert.equal((await groups.getRulePersonalGroupIds(1, [created])).size, 0);
});

test("rename/order and deletion preserve rules and their other memberships", async () => {
  await assert.rejects(groups.savePersonalRuleGroup(1, "游戏"), { code: "CONFLICT" });
  await groups.reorderPersonalRuleGroups(1, [groupB, groupA]);
  assert.deepEqual((await groups.getPersonalRuleGroups(1)).groups.map(group => group.id), [groupB, groupA]);
  await assert.rejects(groups.reorderPersonalRuleGroups(1, [groupA]), { code: "BAD_REQUEST" });
  await groups.savePersonalRuleGroup(1, "改名", groupA);
  const before = await rules.getForwardRuleById(ruleA);
  await groups.deletePersonalRuleGroup(1, groupA);
  assert.deepEqual(await rules.getForwardRuleById(ruleA), before);
  assert.deepEqual((await groups.getRulePersonalGroupIds(1, [ruleA])).get(ruleA), [groupB]);
  assert.equal((await groups.getPersonalRuleGroups(2)).groups[0].id, groupOther);
});

test("schema upgrades are idempotent and migration/backup include both metadata tables", async () => {
  const schema = await import("./dbSchema");
  await schema.ensureDatabaseSchema();
  for (const table of ["rule_groups", "rule_group_members"] as const) {
    assert.ok(schema.MIGRATION_TABLES.includes(table));
    assert.ok(schema.getDatabaseTableDefs().some(def => def.name === table));
    const indexes = await runtime.queryRaw<any>(`PRAGMA index_list('${table}')`);
    assert.ok(indexes.some(index => index.unique));
  }
});

test("nested forwarding transactions and concurrent group changes do not invert locks", { timeout: 10_000 }, async () => {
  const [, created] = await Promise.all([
    groups.moveRulesToPersonalGroups(1, [ruleB], [groupB], "add"),
    runtime.withDatabaseTransaction(() => rules.createForwardRule({ ...payload(1, "nested transaction"), personalGroupIds: [groupB] })),
  ]);
  assert.deepEqual((await groups.getRulePersonalGroupIds(1, [created])).get(created), [groupB]);
  await rules.finalizeForwardRuleDelete(created);
  assert.deepEqual((await groups.getRulePersonalGroupIds(1, [created])).get(created), [groupB], "finalizing a live rule cannot clear its groups");
  await Promise.all([
    groups.deletePersonalRuleGroup(1, groupB),
    groups.moveRulesToPersonalGroups(1, [created], [groupB], "add").catch(error => { assert.equal(error.code, "NOT_FOUND"); }),
  ]);
  assert.equal((await groups.getRulePersonalGroupIds(1, [created])).size, 0);
});

test("incremental migration remaps the owner, group and rule IDs together", async () => {
  const { importMigrationSnapshot } = await import("./migration");
  const result = await importMigrationSnapshot({ version: 1, exportedAt: Date.now(), dataScope: "essential", tables: {
    users: [{ id: 1001, username: "imported-groups-user", password: "unused" }],
    hosts: [{ id: 2001, userId: 1001, name: "imported-host", ip: "192.0.2.10" }],
    forward_rules: [{ ...payload(1001, "imported-rule"), id: 3001, hostId: 2001, isEnabled: false }],
    rule_groups: [{ id: 4001, userId: 1001, name: "imported-group", sortOrder: 0 }],
    rule_group_members: [{ id: 5001, userId: 1001, ruleId: 3001, groupId: 4001 }],
  } });
  assert.equal(result.skipped.rule_group_members || 0, 0);
  const [owner] = await runtime.queryRaw<any>("SELECT id FROM users WHERE username = ?", ["imported-groups-user"]);
  const [rule] = await runtime.queryRaw<any>("SELECT id FROM forward_rules WHERE name = ?", ["imported-rule"]);
  const data = await groups.getPersonalRuleGroups(Number(owner.id));
  assert.equal(data.groups.length, 1);
  assert.equal(data.groups[0].count, 1);
  assert.deepEqual((await groups.getRulePersonalGroupIds(Number(owner.id), [Number(rule.id)])).get(Number(rule.id)), [data.groups[0].id]);
  assert.notEqual(Number(owner.id), 1001);
  assert.notEqual(Number(rule.id), 3001);
});

test("MySQL and PostgreSQL schema creation includes group ownership and membership indexes", async () => {
  const { ensureDatabaseSchema, getDatabaseTableDefs } = await import("./dbSchema");
  for (const kind of ["mysql", "postgresql"] as const) {
    const queries: string[] = [];
    const pool = {
      ...(kind === "mysql" ? { getConnection() { throw new Error("not used"); } } : {}),
      async query(sql: string) {
        queries.push(sql);
        if (kind === "mysql" && sql.startsWith("SHOW COLUMNS")) {
          const table = sql.match(/`([^`]+)`/)![1];
          return [getDatabaseTableDefs().find(def => def.name === table)!.columns.map(column => ({ Field: column.name, Type: column.type })), []];
        }
        return kind === "mysql" ? [[], []] : { rows: [] };
      },
      async execute() { return [[], []]; },
    };
    await ensureDatabaseSchema(pool as any);
    const quote = kind === "mysql" ? "`" : '"';
    for (const table of ["rule_groups", "rule_group_members"]) {
      assert.ok(queries.some(sql => sql.startsWith(`CREATE TABLE IF NOT EXISTS ${quote}${table}${quote}`) && sql.includes(`${quote}userId${quote}`)));
    }
    assert.ok(queries.some(sql => sql.includes("rule_group_members") && /UNIQUE/.test(sql) && /userId.*ruleId.*groupId/.test(sql)));
  }
});

test("group dialog saves name and member deltas together without affecting other groups", async () => {
  const caller = router.createCaller(context(1));
  const secondary = (await groups.savePersonalRuleGroup(1, "dialog-secondary")).id;
  const current = (await caller.savePersonalGroup({ name: "dialog-current", addRuleIds: [ruleA, ruleB] })).id;
  await groups.moveRulesToPersonalGroups(1, [ruleA], [secondary], "add");
  const ruleBefore = await rules.getForwardRuleById(ruleA);
  await caller.savePersonalGroup({ id: current, name: "dialog-renamed", removeRuleIds: [ruleA] });
  assert.deepEqual((await groups.getRulePersonalGroupIds(1, [ruleA])).get(ruleA), [secondary]);
  assert.deepEqual((await groups.getRulePersonalGroupIds(1, [ruleB])).get(ruleB), [current]);
  assert.deepEqual(await rules.getForwardRuleById(ruleA), ruleBefore, "editing a group cannot rewrite the forwarding configuration");
  // The valid add must roll back along with the rename when removal fails.
  await assert.rejects(caller.savePersonalGroup({ id: current, name: "must roll back", addRuleIds: [ruleA], removeRuleIds: [ruleOther] }), { code: "FORBIDDEN" });
  assert.equal((await groups.getPersonalRuleGroups(1)).groups.find(group => group.id === current)?.name, "dialog-renamed");
  assert.deepEqual((await groups.getRulePersonalGroupIds(1, [ruleA])).get(ruleA), [secondary]);
  await assert.rejects(caller.savePersonalGroup({ name: "invalid creation", addRuleIds: [ruleOther] }), { code: "FORBIDDEN" });
  assert.ok(!(await groups.getPersonalRuleGroups(1)).groups.some(group => group.name === "invalid creation"));
  await assert.rejects(router.createCaller(context(3, "admin")).savePersonalGroup({ id: current, name: "no" }), { code: "NOT_FOUND" });
});

test("group editor input rejects conflicting membership changes and oversized saves", () => {
  assert.deepEqual(personalRuleGroupSaveSchema.parse({ name: "test", addRuleIds: [1, 1, 2] }).addRuleIds, [1, 2]);
  assert.equal(personalRuleGroupSaveSchema.safeParse({ name: "test", addRuleIds: [1], removeRuleIds: [1] }).success, false);
  assert.equal(personalRuleGroupSaveSchema.safeParse({ name: "test", addRuleIds: Array.from({ length: 300 }, (_, id) => id + 1), removeRuleIds: Array.from({ length: 201 }, (_, id) => id + 500) }).success, false);
});

test("group eligibility is filtered before pagination, preserves multi-group semantics and stays self-scoped", async () => {
  const owner = 9000;
  await runtime.insertAndGetId("users", { id: owner, username: "group-candidate-owner", password: "unused", role: "admin" });
  const a = (await groups.savePersonalRuleGroup(owner, "candidate-a")).id;
  const b = (await groups.savePersonalRuleGroup(owner, "candidate-b")).id;
  const unrelated = (await groups.savePersonalRuleGroup(owner, "candidate-unrelated")).id;
  const complete: number[] = [];
  for (let index = 0; index < 25; index++) complete.push(await runtime.insertAndGetId("forward_rules", payload(owner, `complete-${index}`)));
  await groups.moveRulesToPersonalGroups(owner, complete, [a, b], "add");
  const partialA = await runtime.insertAndGetId("forward_rules", payload(owner, "candidate partial-a"));
  const partialB = await runtime.insertAndGetId("forward_rules", payload(owner, "candidate partial-b"));
  const empty = await runtime.insertAndGetId("forward_rules", payload(owner, "candidate empty"));
  await groups.moveRulesToPersonalGroups(owner, [partialA], [a, unrelated], "add");
  await groups.moveRulesToPersonalGroups(owner, [partialB], [b], "add");
  const caller = router.createCaller(context(owner, "admin"));
  const input = { scope: "all" as const, page: 1, pageSize: 100, category: "all" as const };
  const add = await caller.listPage({ ...input, personalGroupChange: { mode: "add", groupIds: [a, b, a] } });
  assert.equal(add.totalItems, 3);
  assert.deepEqual(new Set(add.items.map(rule => rule.id)), new Set([partialA, partialB, empty]));
  const one = await caller.listPage({ ...input, pageSize: 1, personalGroupChange: { mode: "add", groupIds: [a, b] } });
  const two = await caller.listPage({ ...input, pageSize: 1, page: 2, personalGroupChange: { mode: "add", groupIds: [a, b] } });
  assert.equal(one.totalPages, 3);
  assert.equal(one.items.length, 1);
  assert.equal(two.items.length, 1);
  assert.notEqual(one.items[0].id, two.items[0].id);
  const single = await caller.listPage({ ...input, personalGroupChange: { mode: "add", groupIds: [a] } });
  assert.deepEqual(new Set(single.items.map(rule => rule.id)), new Set([partialB, empty]));
  const remove = await caller.listPage({ ...input, personalGroupChange: { mode: "remove", groupIds: [a, b] } });
  assert.equal(remove.totalItems, 27);
  assert.ok(!remove.items.some(rule => rule.id === empty));
  for (const mode of ["add", "remove"] as const) {
    assert.equal((await caller.listPage({ ...input, personalGroupChange: { mode, groupIds: [] } })).totalItems, 0);
  }
  const searched = await caller.listPage({ ...input, search: "partial-a", personalGroupChange: { mode: "remove", groupIds: [a, b] } });
  assert.deepEqual(searched.items.map(rule => rule.id), [partialA]);
  await assert.rejects(caller.listPage({ ...input, personalGroupChange: { mode: "remove", groupIds: [groupOther] } }), { code: "NOT_FOUND" });
  await assert.rejects(router.createCaller(context(2)).listPage({ ...input, personalGroupChange: { mode: "add", groupIds: [a] } }), { code: "NOT_FOUND" });
  // Applying the operation removes candidates and keeps unrelated memberships.
  await caller.moveToPersonalGroups({ ids: [partialA], groupIds: [a, b], mode: "add" });
  assert.equal((await caller.listPage({ ...input, personalGroupChange: { mode: "add", groupIds: [a, b] } })).totalItems, 2);
  await caller.moveToPersonalGroups({ ids: [partialA], groupIds: [a, b], mode: "remove" });
  assert.deepEqual((await groups.getRulePersonalGroupIds(owner, [partialA])).get(partialA), [unrelated]);
  assert.equal((await caller.listPage({ ...input, personalGroupChange: { mode: "remove", groupIds: [a, b] } })).totalItems, 26);
});

test("group eligibility filter validates its bounded input", () => {
  assert.deepEqual(personalRuleGroupChangeFilterSchema.parse({ mode: "add", groupIds: [1, 2, 1] }), { mode: "add", groupIds: [1, 2] });
  for (const value of [{ mode: "replace", groupIds: [] }, { mode: "add", groupIds: [0] }, { mode: "remove", groupIds: Array(101).fill(1) }]) {
    assert.equal(personalRuleGroupChangeFilterSchema.safeParse(value).success, false);
  }
});
