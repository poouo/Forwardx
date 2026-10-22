type DatabaseType = "mysql" | "postgresql" | "sqlite";
type DatabaseConfig = {
  type?: DatabaseType;
  sqlite?: { path?: string };
  mysql?: ExternalDatabaseConfig;
  postgresql?: ExternalDatabaseConfig;
};
type ExternalDatabaseConfig = { host?: string; port?: number; user?: string; database?: string; ssl?: boolean };

/** Matches a saved/masked config to the requested destination, never retaining a password. */
export function setupDatabaseConfigKey(config: DatabaseConfig | null | undefined, defaultSqlitePath = "") {
  if (config?.type === "sqlite") return JSON.stringify(["sqlite", config.sqlite?.path || defaultSqlitePath]);
  if (config?.type !== "mysql" && config?.type !== "postgresql") return "";
  const external = config.type === "mysql" ? config.mysql : config.postgresql;
  if (!external) return "";
  return JSON.stringify([config.type, external.host?.trim() || "", Number(external.port || (config.type === "mysql" ? 3306 : 5432)), external.user?.trim() || "", external.database?.trim() || "", !!external.ssl]);
}

export type SetupDatabaseRestart = { configKey: string; afterUpdatedAt: number };

export function setupDatabaseRestartReady(
  restart: SetupDatabaseRestart,
  status: { databaseConfigured?: boolean; databaseConnected?: boolean; schemaReady?: boolean; needsRestart?: boolean; setupLocked?: boolean; error?: string | null; config?: DatabaseConfig | null; defaultSqlitePath?: string } | undefined,
  updatedAt: number,
) {
  return updatedAt > restart.afterUpdatedAt
    && !!status?.databaseConfigured && !!status.databaseConnected && !!status.schemaReady
    && !status.needsRestart && !status.setupLocked && !status.error
    && !!restart.configKey && setupDatabaseConfigKey(status.config, status.defaultSqlitePath) === restart.configKey;
}
