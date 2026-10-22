import assert from "node:assert/strict";
import test from "node:test";
import { setupDatabaseConfigKey, setupDatabaseRestartReady } from "./setupDatabase";

const sqlite = { type: "sqlite" as const, sqlite: { path: "/data/forwardx.db" } };
const mysql = { type: "mysql" as const, mysql: { host: "db", user: "forwardx", database: "forwardx", port: 3306, ssl: false } };
const postgres = { type: "postgresql" as const, postgresql: { host: "pg", user: "forwardx", database: "forwardx", port: 5432, ssl: true } };

test("setup matches masked destinations without including database passwords", () => {
  assert.equal(setupDatabaseConfigKey({ ...mysql, mysql: { ...mysql.mysql, host: " db ", port: undefined } }), setupDatabaseConfigKey(mysql));
  assert.equal(setupDatabaseConfigKey({ type: "sqlite", sqlite: {} }, "/data/forwardx.db"), setupDatabaseConfigKey(sqlite));
  const secret = { ...mysql, mysql: { ...mysql.mysql, password: "private-secret" } };
  assert.equal(setupDatabaseConfigKey(secret), setupDatabaseConfigKey(mysql));
  assert.doesNotMatch(setupDatabaseConfigKey(secret), /private-secret/);
  assert.notEqual(setupDatabaseConfigKey(mysql), setupDatabaseConfigKey(postgres));
  assert.equal(setupDatabaseConfigKey(null), "");
});

test("all database types resume only after a fresh connected and initialized status", () => {
  for (const config of [sqlite, mysql, postgres]) {
    const restart = { configKey: setupDatabaseConfigKey(config), afterUpdatedAt: 100 };
    const ready = { databaseConfigured: true, databaseConnected: true, schemaReady: true, needsRestart: false, setupLocked: false, error: null, config };
    assert.equal(setupDatabaseRestartReady(restart, ready, 101), true);
    assert.equal(setupDatabaseRestartReady(restart, ready, 100), false, "do not accept the pre-save cache");
    for (const changed of [
      { databaseConfigured: false }, { databaseConnected: false }, { schemaReady: false },
      { needsRestart: true }, { setupLocked: true }, { error: "初始化失败" }, { config: null },
    ]) assert.equal(setupDatabaseRestartReady(restart, { ...ready, ...changed }, 101), false);
    assert.equal(setupDatabaseRestartReady(restart, undefined, 101), false, "keep waiting through outages");
  }
});

test("cached readiness from another database or destination cannot finish a switch", () => {
  const restart = { configKey: setupDatabaseConfigKey(mysql), afterUpdatedAt: 100 };
  const ready = { databaseConfigured: true, databaseConnected: true, schemaReady: true, config: mysql };
  for (const config of [sqlite, postgres, { ...mysql, mysql: { ...mysql.mysql, host: "another-db" } }, { ...mysql, mysql: { ...mysql.mysql, database: "another-database" } }]) {
    assert.equal(setupDatabaseRestartReady(restart, { ...ready, config }, 101), false);
  }
  assert.equal(setupDatabaseRestartReady({ ...restart, configKey: "" }, ready, 101), false);
  // This same completion rule is used after returning from step 2; it does not
  // depend on the old databaseStepReviewed flag and keeps working after errors.
  assert.equal(setupDatabaseRestartReady(restart, { ...ready, needsRestart: true }, 101), false);
  assert.equal(setupDatabaseRestartReady(restart, { ...ready, databaseConnected: false }, 102), false);
  assert.equal(setupDatabaseRestartReady(restart, ready, 103), true);
});
