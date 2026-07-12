import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { ensureDatabaseSchema } from "./dbSchema";

test("plugin trust and third-party store schema migrate on an existing database", async () => {
  const sqlite = new Database(":memory:");
  try {
    sqlite.exec(`
      CREATE TABLE plugins (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pluginId TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        version TEXT NOT NULL DEFAULT '0.0.0',
        manifestJson TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'disabled',
        installedAt INTEGER NOT NULL DEFAULT (unixepoch()),
        updatedAt INTEGER NOT NULL DEFAULT (unixepoch())
      );
    `);

    await ensureDatabaseSchema(sqlite);

    const pluginColumns = sqlite.prepare("PRAGMA table_info(plugins)").all() as Array<{ name: string }>;
    const sourceTable = sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'plugin_store_sources'").get();
    const sourceColumns = sqlite.prepare("PRAGMA table_info(plugin_store_sources)").all() as Array<{ name: string }>;

    assert.equal(pluginColumns.some((column) => column.name === "trusted"), true);
    assert.ok(sourceTable);
    assert.equal(sourceColumns.some((column) => column.name === "itemsJson"), true);
    assert.equal(sourceColumns.some((column) => column.name === "lastSyncedAt"), true);
  } finally {
    sqlite.close();
  }
});
