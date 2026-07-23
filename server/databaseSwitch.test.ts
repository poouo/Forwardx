import assert from "node:assert/strict";
import test from "node:test";
import {
  describeDatabaseSwitchFailure,
  getDatabaseSwitchStagePlan,
} from "./databaseSwitch";

test("explains PostgreSQL schema permission failures with an actionable grant", () => {
  const error = Object.assign(new Error("permission denied for schema public"), { code: "42501" });
  const failure = describeDatabaseSwitchFailure(error, {
    type: "postgresql",
    postgresql: {
      host: "127.0.0.1",
      port: 5432,
      user: "forwardx",
      password: "secret",
      database: "forwardx",
      ssl: false,
    },
  });

  assert.equal(failure.code, "POSTGRESQL_SCHEMA_PERMISSION_DENIED");
  assert.match(failure.message, /forwardx/);
  assert.match(failure.message, /public/);
  assert.equal(failure.detail, "permission denied for schema public");
  assert.equal(failure.suggestionCommand, 'GRANT USAGE, CREATE ON SCHEMA "public" TO "forwardx";');
  assert.doesNotMatch(`${failure.message}${failure.suggestion}`, /secret/);
});

test("does not suggest a schema grant for other PostgreSQL object permission failures", () => {
  const error = Object.assign(new Error("permission denied for table existing_data"), { code: "42501" });
  const failure = describeDatabaseSwitchFailure(error, {
    type: "postgresql",
    postgresql: {
      host: "127.0.0.1",
      port: 5432,
      user: "forwardx",
      password: "secret",
      database: "forwardx",
      ssl: false,
    },
  });

  assert.equal(failure.code, "POSTGRESQL_WRITE_PERMISSION_DENIED");
  assert.equal(failure.suggestionCommand, undefined);
  assert.match(failure.suggestion || "", /数据库对象操作权限|建表/);
});

test("explains MySQL write permission failures without exposing credentials", () => {
  const error = Object.assign(new Error("CREATE command denied to user"), { code: "ER_TABLEACCESS_DENIED_ERROR" });
  const failure = describeDatabaseSwitchFailure(error, {
    type: "mysql",
    mysql: {
      host: "127.0.0.1",
      port: 3306,
      user: "forwardx",
      password: "secret",
      database: "forwardx",
      ssl: false,
    },
  });

  assert.equal(failure.code, "MYSQL_WRITE_PERMISSION_DENIED");
  assert.match(failure.suggestion || "", /CREATE/);
  assert.doesNotMatch(`${failure.message}${failure.suggestion}`, /secret/);
});

test("database switch stage plans expose PostgreSQL optimization as a distinct step", () => {
  assert.deepEqual(getDatabaseSwitchStagePlan("sqlite"), [
    "connection",
    "permissions",
    "schema",
    "target-check",
    "export",
    "transfer",
    "switch",
  ]);
  assert.deepEqual(getDatabaseSwitchStagePlan("postgresql"), [
    "connection",
    "permissions",
    "schema",
    "target-check",
    "export",
    "transfer",
    "optimize",
    "switch",
  ]);
});
