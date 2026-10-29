import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultRuleTableLayout, normalizeRuleTableLayout } from "../shared/ruleTableLayout";
import { defaultHostTableLayout, normalizeHostTableLayout } from "../shared/hostTableLayout";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-list-settings-"));
process.env.DATABASE_TYPE = "sqlite";
process.env.SQLITE_PATH = path.join(directory, "preferences.db");
process.env.DATABASE_CONFIG_PATH = path.join(directory, "database.json");
process.env.FORWARDX_LOG_DIR = path.join(directory, "logs");
let runtime: typeof import("./dbRuntime");
let repository: typeof import("./repositories/userRepository");
let auth: typeof import("./routers/auth").authRouter;
const context = (user: any) => ({ user, req: { headers: {}, socket: {} }, res: {}, authSession: null, authFailureReason: null }) as any;

before(async () => {
  runtime = await import("./dbRuntime");
  await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.SQLITE_PATH! } });
  await runtime.executeRaw('CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL, password TEXT NOT NULL, "createdAt" INTEGER NOT NULL DEFAULT 0, "updatedAt" INTEGER NOT NULL DEFAULT 0, "lastSignedIn" INTEGER NOT NULL DEFAULT 0)');
  await runtime.executeRaw("INSERT INTO users (id, username, password) VALUES (1, 'legacy', 'unused')");
  await (await import("./dbSchema")).ensureDatabaseSchema();
  repository = await import("./repositories/userRepository");
  auth = (await import("./routers/auth")).authRouter;
  for (const id of [2, 3]) await runtime.insertAndGetId("users", { id, username: `user-${id}`, password: "unused", role: id === 3 ? "admin" : "user" });
});

after(async () => {
  await runtime?.closeDatabase();
  fs.rmSync(directory, { recursive: true, force: true });
});

test("old and new SQLite accounts start with default layouts", async () => {
  for (const id of [1, 2, 3]) {
    const user = await repository.getUserById(id);
    assert.equal(user?.ruleTableLayout, null);
    assert.deepEqual(normalizeRuleTableLayout(user?.ruleTableLayout), defaultRuleTableLayout());
    assert.equal(user?.hostTableLayout, null);
    assert.deepEqual(normalizeHostTableLayout(user?.hostTableLayout), defaultHostTableLayout());
  }
});

test("ordinary users and admins save independent layouts and auth.me restores them", async () => {
  for (const id of [2, 3]) {
    const layout = normalizeRuleTableLayout({ order: ["entry", "name"], hidden: id === 2 ? ["daily"] : ["resource"], widths: { entry: 200 + id } });
    await auth.createCaller(context(await repository.getUserById(id))).updateRuleTableLayout({ accountId: id, layout });
    const fresh = await repository.getUserById(id);
    const result = await auth.createCaller(context(fresh)).me();
    assert.deepEqual(normalizeRuleTableLayout(result?.ruleTableLayout), layout);
    assert.equal("password" in result!, false);
  }
  assert.deepEqual(normalizeRuleTableLayout((await repository.getUserById(2))?.ruleTableLayout).hidden, ["daily"]);
  assert.equal((await repository.getUserById(1))?.ruleTableLayout, null);
});

test("cross-account, anonymous and malformed updates are rejected without overwriting preferences", async () => {
  const user = await repository.getUserById(2);
  const caller = auth.createCaller(context(user));
  await assert.rejects(caller.updateRuleTableLayout({ accountId: 3, layout: defaultRuleTableLayout() }), { code: "FORBIDDEN" });
  await assert.rejects(auth.createCaller(context(null)).updateRuleTableLayout({ accountId: 2, layout: defaultRuleTableLayout() }), { code: "UNAUTHORIZED" });
  await assert.rejects(caller.updateRuleTableLayout({ accountId: 2, layout: { ...defaultRuleTableLayout(), widths: { name: 1e9 } } }), { code: "BAD_REQUEST" });
  assert.equal((await repository.getUserById(2))?.ruleTableLayout, user?.ruleTableLayout);
  await caller.updateProfile({ name: "Renamed" });
  assert.equal((await repository.getUserById(2))?.ruleTableLayout, user?.ruleTableLayout);
  await caller.updateRuleTableLayout({ accountId: 2, layout: defaultRuleTableLayout() });
  assert.deepEqual(normalizeRuleTableLayout((await repository.getUserById(2))?.ruleTableLayout), defaultRuleTableLayout());
});

test("host preferences are isolated per account and independent of rule preferences", async () => {
  const ruleLayoutBefore = (await repository.getUserById(2))?.ruleTableLayout;
  for (const id of [2, 3]) {
    const layout = normalizeHostTableLayout({ order: ["address", "name"], hidden: id === 2 ? ["region"] : ["version"], widths: { address: 200 + id } });
    await auth.createCaller(context(await repository.getUserById(id))).updateHostTableLayout({ accountId: id, layout });
    const fresh = await repository.getUserById(id);
    const result = await auth.createCaller(context(fresh)).me();
    assert.deepEqual(normalizeHostTableLayout(result?.hostTableLayout), layout);
    assert.equal("password" in result!, false);
  }
  assert.equal((await repository.getUserById(2))?.ruleTableLayout, ruleLayoutBefore);
  assert.equal((await repository.getUserById(1))?.hostTableLayout, null);
  assert.deepEqual(normalizeHostTableLayout((await repository.getUserById(2))?.hostTableLayout).hidden, ["region"]);
});

test("host layout writes reject other accounts, anonymous callers and malformed settings", async () => {
  const user = await repository.getUserById(2);
  const caller = auth.createCaller(context(user));
  await assert.rejects(caller.updateHostTableLayout({ accountId: 3, layout: defaultHostTableLayout() }), { code: "FORBIDDEN" });
  await assert.rejects(auth.createCaller(context(null)).updateHostTableLayout({ accountId: 2, layout: defaultHostTableLayout() }), { code: "UNAUTHORIZED" });
  await assert.rejects(caller.updateHostTableLayout({ accountId: 2, layout: { ...defaultHostTableLayout(), widths: { name: 1e9 } } }), { code: "BAD_REQUEST" });
  assert.equal((await repository.getUserById(2))?.hostTableLayout, user?.hostTableLayout);
  await caller.updateProfile({ name: "Host owner" });
  assert.equal((await repository.getUserById(2))?.hostTableLayout, user?.hostTableLayout);
  await caller.updateHostTableLayout({ accountId: 2, layout: defaultHostTableLayout() });
  assert.deepEqual(normalizeHostTableLayout((await repository.getUserById(2))?.hostTableLayout), defaultHostTableLayout());
});

test("MySQL and PostgreSQL create and upgrade both layout fields without rewriting existing users", async () => {
  const { ensureDatabaseSchema, getDatabaseTableDefs } = await import("./dbSchema");
  for (const [kind, scenario] of [
    ["mysql", "fresh"], ["mysql", "upgrade"],
    ["postgresql", "fresh"], ["postgresql", "upgrade"],
  ] as const) {
    const queries: string[] = [];
    const definitions = getDatabaseTableDefs();
    const columns = new Map(scenario === "fresh" ? [] : definitions.map(table => [table.name,
      new Set(table.columns.filter(column => !["ruleTableLayout", "hostTableLayout"].includes(column.name)).map(column => column.name)),
    ]));
    const pool = {
      ...(kind === "mysql" ? { getConnection() { throw new Error("not used"); } } : {}),
      async query(sql: string, params: any[] = []) {
        queries.push(sql);
        if (kind === "mysql" && sql.startsWith("SHOW COLUMNS")) {
          const table = sql.match(/`([^`]+)`/)![1];
          return [definitions.find(def => def.name === table)!.columns.filter(column => columns.get(table)?.has(column.name)).map(column => ({ Field: column.name, Type: column.type })), []];
        }
        if (kind === "postgresql" && sql.includes("pg_catalog.pg_attribute")) {
          return { rows: params[0].flatMap((table_name: string) =>
            [...(columns.get(table_name) || [])].map(column_name => ({ table_name, column_name }))) };
        }
        const creation = sql.match(/^CREATE TABLE IF NOT EXISTS [`"]([^`"]+)[`"]/);
        if (creation && !columns.has(creation[1])) {
          columns.set(creation[1], new Set(definitions.find(table => table.name === creation[1])!.columns.map(column => column.name)));
        }
        const addition = sql.match(/^ALTER TABLE [`"]([^`"]+)[`"] ADD COLUMN (?:IF NOT EXISTS )?[`"]([^`"]+)[`"]/);
        if (addition) {
          columns.get(addition[1])!.add(addition[2]);
        }
        return kind === "mysql" ? [[], []] : { rows: [] };
      },
      async execute() { return [[], []]; },
    };
    await ensureDatabaseSchema(pool as any);
    const quote = kind === "mysql" ? "`" : '"';
    for (const name of ["ruleTableLayout", "hostTableLayout"]) {
      const column = `${quote}${name}${quote} TEXT`;
      const create = queries.some(sql => sql.startsWith(`CREATE TABLE IF NOT EXISTS ${quote}users${quote}`) && sql.includes(column));
      const upgrade = queries.some(sql => sql.startsWith(`ALTER TABLE ${quote}users${quote} ADD COLUMN ${kind === "postgresql" ? "IF NOT EXISTS " : ""}${column}`));
      assert.equal(create, kind === "mysql" || scenario === "fresh", `${kind} ${scenario} ${name} create`);
      assert.equal(upgrade, scenario === "upgrade", `${kind} ${scenario} ${name} upgrade`);
      assert.ok(columns.get("users")?.has(name), `${kind} ${scenario} ${name} exists`);
    }
    assert.ok(!queries.some(sql => /UPDATE\s+[`"]?users[^;]*(?:ruleTableLayout|hostTableLayout)/i.test(sql)));
    queries.length = 0;
    await ensureDatabaseSchema(pool as any);
    assert.ok(!queries.some(sql => /^ALTER TABLE/.test(sql) && /ruleTableLayout|hostTableLayout/.test(sql)), `${kind} ${scenario} restart preserves layouts`);
  }
});
