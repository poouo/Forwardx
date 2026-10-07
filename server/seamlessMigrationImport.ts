import { MIGRATION_TABLES, getDatabaseTableDefs } from "./dbSchema";
import { executeRaw, queryRaw, quoteDbIdentifier as q, withDatabaseTransaction, getDatabaseKind } from "./dbRuntime";
import { seamlessInternal } from "./seamlessMigrationState";
import type { MigrationSnapshot } from "./migration";
import { invalidateAllSettingsCache } from "./repositories/settingsRepository";
import { invalidatePanelMigrationAgentStateCache } from "./panelMigrationAgentState";

// No ID remapping, skipped rows, runtime resets or incremental merging. A
// partially imported configuration must never become the data-plane owner.
export async function assertEmptySeamlessTarget() {
  for (const table of MIGRATION_TABLES) {
    if (table === "system_settings") continue;
    const rows = await queryRaw(`SELECT * FROM ${q(table)} LIMIT 2`);
    if (table === "users" && rows.length <= 1 && rows.every((row) => row.role === "admin")) continue;
    if (rows.length) throw new Error(`无缝迁移需要空业务目标面板（${table} 已有数据）；不支持增量合并`);
  }
}

export async function importSeamlessSnapshot(snapshot: MigrationSnapshot, targetUrl: string) {
  const defs = new Map(getDatabaseTableDefs().map((table) => [table.name, table]));
  for (const table of Object.keys(snapshot.tables)) {
    if (!(MIGRATION_TABLES as readonly string[]).includes(table)) throw new Error(`不支持的迁移表：${table}`);
  }
  if (!snapshot.tables.users?.some((row) => row.role === "admin")) throw new Error("迁移数据缺少管理员");
  await seamlessInternal(() => withDatabaseTransaction(async () => {
    await assertEmptySeamlessTarget();
    const deploymentKeys = ["databaseConfigured", "databaseType", "mysqlConfigured", "mysqlHost", "mysqlDatabase", "postgresqlConfigured", "postgresqlHost", "postgresqlDatabase", "sqlitePath", "panelSslEnabled", "panelSslMode", "panelSslCertPath", "panelSslKeyPath", "panelSslCertPem", "panelSslKeyPem"];
    const deploymentSettings = await queryRaw(`SELECT * FROM ${q("system_settings")} WHERE ${q("key")} IN (${deploymentKeys.map(() => "?").join(",")})`, deploymentKeys);
    await executeRaw(`DELETE FROM ${q("auth_sessions")}`); // new panel requires a fresh login
    await executeRaw(`DELETE FROM ${q("users")}`);
    await executeRaw(`DELETE FROM ${q("system_settings")}`);
    for (const table of MIGRATION_TABLES) {
      const def = defs.get(table);
      if (!def) throw new Error(`缺少数据表定义：${table}`);
      const allowed = new Set(def.columns.map((column) => column.name));
      const bools = new Set(def.columns.filter((column) => column.type === "bool").map((column) => column.name));
      const rows = snapshot.tables[table] || [];
      for (let index = 0; index < rows.length; index++) {
        const row = rows[index];
        const columns = Object.keys(row);
        if (!columns.length || columns.some((key) => !allowed.has(key))) throw new Error(`数据表 ${table} 的结构不兼容`);
        const values = columns.map((key) => bools.has(key) && row[key] !== null
          ? row[key] === true || row[key] === 1 || row[key] === "1" || row[key] === "true" : row[key]);
        try {
          await executeRaw(`INSERT INTO ${q(table)} (${columns.map(q).join(",")}) VALUES (${columns.map(() => "?").join(",")})`, values);
        } catch (error) {
          // Driver errors can include unique-key values (tokens, addresses,
          // usernames). Never expose those in the public migration progress.
          throw new Error(`导入 ${table} 失败，整个事务已回滚（${String((error as any)?.code || "database error")}）`);
        }
        if (index % 256 === 255) await new Promise<void>((resolve) => setImmediate(resolve));
      }
      const counts = await queryRaw(`SELECT COUNT(*) AS total FROM ${q(table)}`);
      if (Number(counts[0]?.total) !== rows.length) throw new Error(`迁移行数校验失败：${table}`);
      if (getDatabaseKind() === "postgresql" && def.columns.some((column) => column.type === "id")) {
        await queryRaw(`SELECT setval(pg_get_serial_sequence(?, 'id')::regclass, GREATEST(COALESCE(MAX(${q("id")}), 0), 1), COALESCE(MAX(${q("id")}), 0) > 0) FROM ${q(table)}`, [table]);
      }
    }
    // Retired migration directives and source setup flags must not send Agents
    // to a different URL or reopen setup after takeover.
    const removedSettings = [...deploymentKeys, "panelPublicUrl", "migratedToPanelUrl", "migratedAt", "panelMigrationId", "panelMigrationPhase", "panelMigrationTargetPanelUrl", "panelMigrationSourceUrl", "panelMigrationHostIds", "panelMigrationStartedAt", "agentMigrationTargetPanelUrl", "agentMigrationTargetExpiresAt", "seamlessMigrationImportId", "setupDataChoice", "migrationImportInProgress"];
    await executeRaw(`DELETE FROM ${q("system_settings")} WHERE ${q("key")} IN (${removedSettings.map(() => "?").join(",")})`, removedSettings);
    for (const row of deploymentSettings) {
      await executeRaw(`INSERT INTO ${q("system_settings")} (${q("key")}, ${q("value")}, ${q("updatedAt")}) VALUES (?, ?, ?)`, [row.key, row.value, row.updatedAt]);
    }
    await executeRaw(`INSERT INTO ${q("system_settings")} (${q("key")}, ${q("value")}, ${q("updatedAt")}) VALUES (?, ?, ?)`, ["panelPublicUrl", targetUrl, Math.floor(Date.now() / 1000)]);
    if (snapshot.seamless) await executeRaw(`INSERT INTO ${q("system_settings")} (${q("key")}, ${q("value")}, ${q("updatedAt")}) VALUES (?, ?, ?)`, ["seamlessMigrationImportId", snapshot.seamless.id, Math.floor(Date.now() / 1000)]);
  }));
  invalidateAllSettingsCache();
  invalidatePanelMigrationAgentStateCache();
}
