import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import {
  applyLegacyCompatibilityMigration,
  inspectLegacyCompatibility,
  isCurrentSessionLeaseValue,
  migrateLegacyForwardProtocolsValue,
  type LegacyMigrationDatabase,
} from "./legacyMigration";

function sqliteMigrationDatabase(sqlite: Database.Database): LegacyMigrationDatabase {
  return {
    kind: "sqlite",
    async query<T extends Record<string, unknown>>(sql: string, params: unknown[] = []) {
      return sqlite.prepare(sql).all(...params) as T[];
    },
    async execute(sql: string, params: unknown[] = []) {
      return sqlite.prepare(sql).run(...params).changes;
    },
    async transaction<T>(work: () => Promise<T>) {
      sqlite.exec("BEGIN IMMEDIATE");
      try {
        const result = await work();
        sqlite.exec("COMMIT");
        return result;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

function createLegacyDatabase() {
  const sqlite = new Database(":memory:");
  sqlite.exec([
    "CREATE TABLE tunnels (id INTEGER PRIMARY KEY, mode TEXT NOT NULL, updatedAt INTEGER NOT NULL);",
    "CREATE TABLE users (",
    "id INTEGER PRIMARY KEY,",
    "browserSessionToken TEXT,",
    "mobileSessionToken TEXT,",
    "telegramSessionToken TEXT",
    ");",
    "CREATE TABLE system_settings (key TEXT PRIMARY KEY, value TEXT, updatedAt INTEGER NOT NULL);",
  ].join("\n"));
  return sqlite;
}

test("forward protocol migration keeps an explicit current value", () => {
  const result = migrateLegacyForwardProtocolsValue(
    JSON.stringify({ nginx_tls: true, nginx_stream: false, tls: true }),
  );
  assert.equal(result.state, "pending");
  assert.deepEqual(
    JSON.parse(result.migratedValue || "{}"),
    { nginx_stream: false, tls: true },
  );
  assert.equal(migrateLegacyForwardProtocolsValue("not-json").state, "invalid");
  assert.equal(
    migrateLegacyForwardProtocolsValue(JSON.stringify({ nginx_stream: true })).state,
    "unchanged",
  );
});

test("session lease detection accepts only the current shape", () => {
  assert.equal(isCurrentSessionLeaseValue('{"sid":"abc","activeAt":123}'), true);
  assert.equal(isCurrentSessionLeaseValue("plain-sid"), false);
  assert.equal(isCurrentSessionLeaseValue('{"sid":"abc"}'), false);
  assert.equal(isCurrentSessionLeaseValue('{"sid":"","activeAt":123}'), false);
});

test("legacy migration applies once and is idempotent", async () => {
  const sqlite = createLegacyDatabase();
  try {
    sqlite.prepare("INSERT INTO tunnels (id, mode, updatedAt) VALUES (?, ?, ?)")
      .run(1, "nginx_tls", 1);
    sqlite.prepare("INSERT INTO tunnels (id, mode, updatedAt) VALUES (?, ?, ?)")
      .run(2, "nginx_stream", 1);
    sqlite.prepare(
      "INSERT INTO system_settings (key, value, updatedAt) VALUES (?, ?, ?)",
    ).run(
      "forwardProtocols",
      JSON.stringify({ nginx_tls: true, tls: false }),
      1,
    );
    sqlite.prepare(
      "INSERT INTO users "
        + "(id, browserSessionToken, mobileSessionToken, telegramSessionToken) "
        + "VALUES (?, ?, ?, ?)",
    ).run(
      1,
      " legacy-browser-sid ",
      '{"sid":"mobile","activeAt":123}',
      '{"sid":"missing-active"}',
    );

    const db = sqliteMigrationDatabase(sqlite);
    const before = await inspectLegacyCompatibility(db);
    assert.equal(before.pendingChanges, 4);
    assert.equal(before.legacyTunnelModes, 1);
    assert.equal(before.legacySessionValues, 2);
    assert.equal(before.currentSessionValues, 1);

    const applied = await applyLegacyCompatibilityMigration(
      db,
      new Date("2026-07-18T00:00:00.000Z"),
    );
    assert.deepEqual(
      applied.applied,
      { tunnelModes: 1, forwardProtocols: 1, sessionValues: 2 },
    );
    assert.equal(applied.after.pendingChanges, 0);
    assert.equal(applied.after.markerPresent, true);

    const tunnel = sqlite.prepare("SELECT mode FROM tunnels WHERE id = 1")
      .get() as { mode: string };
    assert.equal(tunnel.mode, "nginx_stream");
    const setting = sqlite.prepare(
      "SELECT value FROM system_settings WHERE key = ?",
    ).get("forwardProtocols") as { value: string };
    assert.deepEqual(
      JSON.parse(setting.value),
      { nginx_stream: true, tls: false },
    );
    const user = sqlite.prepare("SELECT * FROM users WHERE id = 1")
      .get() as Record<string, unknown>;
    assert.equal(user.browserSessionToken, null);
    assert.equal(user.mobileSessionToken, '{"sid":"mobile","activeAt":123}');
    assert.equal(user.telegramSessionToken, null);

    const repeated = await applyLegacyCompatibilityMigration(
      db,
      new Date("2026-07-18T00:01:00.000Z"),
    );
    assert.deepEqual(
      repeated.applied,
      { tunnelModes: 0, forwardProtocols: 0, sessionValues: 0 },
    );
    assert.equal(repeated.after.pendingChanges, 0);
  } finally {
    sqlite.close();
  }
});

test("invalid forward protocol JSON blocks apply and rolls back", async () => {
  const sqlite = createLegacyDatabase();
  try {
    sqlite.prepare("INSERT INTO tunnels (id, mode, updatedAt) VALUES (?, ?, ?)")
      .run(1, "nginx_tls", 1);
    sqlite.prepare(
      "INSERT INTO system_settings (key, value, updatedAt) VALUES (?, ?, ?)",
    ).run("forwardProtocols", "{invalid", 1);
    const db = sqliteMigrationDatabase(sqlite);
    await assert.rejects(
      () => applyLegacyCompatibilityMigration(db),
      /valid JSON/,
    );
    const tunnel = sqlite.prepare("SELECT mode FROM tunnels WHERE id = 1")
      .get() as { mode: string };
    assert.equal(tunnel.mode, "nginx_tls");
  } finally {
    sqlite.close();
  }
});
