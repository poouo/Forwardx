import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import mysql from "mysql2/promise";
import pg from "pg";
import {
  applyLegacyCompatibilityMigration,
  inspectLegacyCompatibility,
  type LegacyMigrationDatabase,
  type LegacyMigrationDatabaseKind,
  type LegacyMigrationReport,
} from "./legacyMigration";

type ServerConfig = {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  ssl: boolean;
};

type DatabaseConfig =
  | { type: "sqlite"; path: string }
  | { type: "mysql"; config: ServerConfig }
  | { type: "postgresql"; config: ServerConfig };

type CliOptions = {
  apply: boolean;
  json: boolean;
  help: boolean;
  configPath: string | null;
  sqlitePath: string | null;
};

function usage() {
  return [
    "ForwardX legacy compatibility migration",
    "",
    "Usage:",
    "  node dist/migrate-legacy.js [--json]",
    "  node dist/migrate-legacy.js --apply [--json]",
    "",
    "Options:",
    "  --apply            Apply the migration. Without this flag the command is read-only.",
    "  --config PATH      Override DATABASE_CONFIG_PATH.",
    "  --sqlite PATH      Override SQLITE_PATH and use SQLite.",
    "  --json             Print the report as JSON.",
    "  --help             Show this help.",
    "",
    "Stop the panel and back up the database before using --apply.",
    "No migration is executed automatically by the panel or installer.",
  ].join("\n");
}

function takeValue(argv: string[], index: number, option: string) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(option + " requires a value");
  return value;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    apply: false,
    json: false,
    help: false,
    configPath: null,
    sqlitePath: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") options.apply = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--config") {
      options.configPath = takeValue(argv, index, arg);
      index += 1;
    } else if (arg.startsWith("--config=")) {
      options.configPath = arg.slice("--config=".length);
    } else if (arg === "--sqlite") {
      options.sqlitePath = takeValue(argv, index, arg);
      index += 1;
    } else if (arg.startsWith("--sqlite=")) {
      options.sqlitePath = arg.slice("--sqlite=".length);
    } else {
      throw new Error("Unknown option: " + arg);
    }
  }
  return options;
}

function envValue(...names: string[]) {
  for (const name of names) {
    const value = String(process.env[name] ?? "").trim();
    if (value) return value;
  }
  return "";
}

function boolValue(value: unknown) {
  return String(value ?? "").trim().toLowerCase() === "true";
}

function normalizeDatabaseKind(value: unknown): LegacyMigrationDatabaseKind | "" {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "postgres" || normalized === "pg" || normalized === "postgresql") {
    return "postgresql";
  }
  if (normalized === "mysql" || normalized === "sqlite") return normalized;
  return "";
}

function configFromUrl(rawUrl: string, defaultPort: number): ServerConfig {
  const url = new URL(rawUrl);
  return {
    host: url.hostname,
    port: Number(url.port || defaultPort),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.replace(/^\/+/, ""),
    ssl: url.searchParams.get("ssl") === "true"
      || url.searchParams.get("sslmode") === "require",
  };
}

function mysqlConfigFromEnv(): ServerConfig | null {
  const url = envValue("MYSQL_URL");
  if (url) return configFromUrl(url, 3306);
  const host = envValue("MYSQL_HOST");
  const user = envValue("MYSQL_USER");
  const database = envValue("MYSQL_DATABASE");
  if (!host || !user || !database) return null;
  return {
    host,
    port: Number(envValue("MYSQL_PORT") || 3306),
    user,
    password: process.env.MYSQL_PASSWORD ?? "",
    database,
    ssl: boolValue(process.env.MYSQL_SSL),
  };
}

function postgresConfigFromEnv(): ServerConfig | null {
  const url = envValue("POSTGRES_URL", "POSTGRESQL_URL", "PG_URL");
  if (url) return configFromUrl(url, 5432);
  const host = envValue("POSTGRES_HOST", "POSTGRESQL_HOST", "PGHOST");
  const user = envValue("POSTGRES_USER", "POSTGRESQL_USER", "PGUSER");
  const database = envValue("POSTGRES_DATABASE", "POSTGRESQL_DATABASE", "PGDATABASE");
  if (!host || !user || !database) return null;
  return {
    host,
    port: Number(envValue("POSTGRES_PORT", "POSTGRESQL_PORT", "PGPORT") || 5432),
    user,
    password: process.env.POSTGRES_PASSWORD
      ?? process.env.POSTGRESQL_PASSWORD
      ?? process.env.PGPASSWORD
      ?? "",
    database,
    ssl: boolValue(
      process.env.POSTGRES_SSL ?? process.env.POSTGRESQL_SSL ?? process.env.PGSSL,
    ),
  };
}

function readJsonFile(filePath: string) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, any>;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error("Cannot parse database config " + filePath + ": " + message);
  }
}

function normalizeServerConfig(input: Record<string, any>, defaultPort: number) {
  if (!input?.host || !input?.user || !input?.database) return null;
  return {
    host: String(input.host).trim(),
    port: Number(input.port || defaultPort),
    user: String(input.user).trim(),
    password: String(input.password ?? ""),
    database: String(input.database).trim(),
    ssl: boolValue(input.ssl),
  } satisfies ServerConfig;
}

function resolveDatabaseConfig(options: CliOptions): DatabaseConfig {
  if (options.sqlitePath) {
    return { type: "sqlite", path: path.resolve(options.sqlitePath) };
  }

  const explicitType = normalizeDatabaseKind(envValue("DATABASE_TYPE", "DB_TYPE"));
  const mysqlEnv = mysqlConfigFromEnv();
  const postgresEnv = postgresConfigFromEnv();
  if (explicitType === "sqlite") {
    return {
      type: "sqlite",
      path: path.resolve(envValue("SQLITE_PATH") || "/data/forwardx.db"),
    };
  }
  if (explicitType === "mysql" && mysqlEnv) return { type: "mysql", config: mysqlEnv };
  if (explicitType === "postgresql" && postgresEnv) {
    return { type: "postgresql", config: postgresEnv };
  }
  if (postgresEnv) return { type: "postgresql", config: postgresEnv };
  if (mysqlEnv) return { type: "mysql", config: mysqlEnv };

  const configPath = path.resolve(
    options.configPath
      || envValue("DATABASE_CONFIG_PATH", "DB_CONFIG_PATH")
      || "/data/database.json",
  );
  const fileConfig = readJsonFile(configPath);
  if (fileConfig) {
    const type = normalizeDatabaseKind(fileConfig.type);
    if (type === "sqlite") {
      const sqlitePath = String(
        fileConfig.sqlite?.path
          || fileConfig.path
          || envValue("SQLITE_PATH")
          || "/data/forwardx.db",
      );
      return { type, path: path.resolve(sqlitePath) };
    }
    if (type === "mysql") {
      const config = normalizeServerConfig(fileConfig.mysql || fileConfig, 3306);
      if (config) return { type, config };
    }
    if (type === "postgresql") {
      const source = fileConfig.postgresql
        || fileConfig.postgres
        || fileConfig.pg
        || fileConfig;
      const config = normalizeServerConfig(source, 5432);
      if (config) return { type, config };
    }
    throw new Error("Database config " + configPath + " is incomplete");
  }

  const legacyMysqlPath = path.resolve(
    envValue("MYSQL_CONFIG_PATH") || "/data/mysql.json",
  );
  const legacyMysql = readJsonFile(legacyMysqlPath);
  if (legacyMysql) {
    const config = normalizeServerConfig(legacyMysql, 3306);
    if (config) return { type: "mysql", config };
  }

  const sqlitePath = path.resolve(envValue("SQLITE_PATH") || "/data/forwardx.db");
  if (fs.existsSync(sqlitePath)) return { type: "sqlite", path: sqlitePath };
  throw new Error(
    "Database is not configured. Checked " + configPath + " and " + sqlitePath,
  );
}

function postgresSql(sql: string) {
  let index = 0;
  return sql.replace(/\?/g, () => "$" + String(++index));
}

async function openDatabase(
  config: DatabaseConfig,
): Promise<{ db: LegacyMigrationDatabase; close: () => Promise<void> }> {
  if (config.type === "sqlite") {
    if (!fs.existsSync(config.path)) {
      throw new Error("SQLite database does not exist: " + config.path);
    }
    const sqlite = new Database(config.path);
    sqlite.pragma("busy_timeout = 10000");
    sqlite.pragma("foreign_keys = ON");
    const db: LegacyMigrationDatabase = {
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
    return {
      db,
      close: async () => {
        sqlite.close();
      },
    };
  }

  if (config.type === "mysql") {
    const connection = await mysql.createConnection({
      host: config.config.host,
      port: config.config.port,
      user: config.config.user,
      password: config.config.password,
      database: config.config.database,
      ssl: config.config.ssl ? {} : undefined,
      connectTimeout: 10_000,
      supportBigNumbers: true,
      bigNumberStrings: true,
    });
    const db: LegacyMigrationDatabase = {
      kind: "mysql",
      async query<T extends Record<string, unknown>>(sql: string, params: unknown[] = []) {
        const [rows] = await connection.query(sql, params as any[]);
        return rows as T[];
      },
      async execute(sql: string, params: unknown[] = []) {
        const [result] = await connection.execute(sql, params as any[]) as any;
        return Number(result?.affectedRows || 0);
      },
      async transaction<T>(work: () => Promise<T>) {
        await connection.beginTransaction();
        try {
          const result = await work();
          await connection.commit();
          return result;
        } catch (error) {
          await connection.rollback();
          throw error;
        }
      },
    };
    return { db, close: async () => connection.end() };
  }

  const client = new pg.Client({
    host: config.config.host,
    port: config.config.port,
    user: config.config.user,
    password: config.config.password,
    database: config.config.database,
    connectionTimeoutMillis: 10_000,
    ssl: config.config.ssl ? { rejectUnauthorized: false } : undefined,
  });
  await client.connect();
  const db: LegacyMigrationDatabase = {
    kind: "postgresql",
    async query<T extends Record<string, unknown>>(sql: string, params: unknown[] = []) {
      const result = await client.query(postgresSql(sql), params);
      return result.rows as T[];
    },
    async execute(sql: string, params: unknown[] = []) {
      const result = await client.query(postgresSql(sql), params);
      return Number(result.rowCount || 0);
    },
    async transaction<T>(work: () => Promise<T>) {
      await client.query("BEGIN");
      try {
        const result = await work();
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    },
  };
  return { db, close: async () => client.end() };
}

function forwardProtocolsLabel(report: LegacyMigrationReport) {
  if (report.forwardProtocols.state !== "pending") {
    return report.forwardProtocols.state;
  }
  return report.forwardProtocols.hasCurrentKey
    ? "pending (nginx_stream kept, nginx_tls removed)"
    : "pending (nginx_tls renamed to nginx_stream)";
}

function printReport(report: LegacyMigrationReport) {
  console.log("Migration: " + report.migrationId);
  console.log("Database: " + report.databaseKind);
  console.log("Completion marker: " + (report.markerPresent ? "present" : "absent"));
  console.log("Legacy tunnel modes: " + report.legacyTunnelModes);
  console.log("Forward protocol settings: " + forwardProtocolsLabel(report));
  console.log(
    "Legacy session values: " + report.legacySessionValues
      + " across " + report.legacySessionUsers + " users",
  );
  console.log("Current session values preserved: " + report.currentSessionValues);
  console.log("Pending changes: " + report.pendingChanges);
  for (const warning of report.warnings) console.warn("Warning: " + warning);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  const connection = await openDatabase(resolveDatabaseConfig(options));
  try {
    if (!options.apply) {
      const report = await inspectLegacyCompatibility(connection.db);
      if (options.json) {
        console.log(JSON.stringify({ mode: "check", report }, null, 2));
      } else {
        printReport(report);
        console.log(
          "Check only: no data was changed. Re-run with --apply after stopping "
            + "the panel and creating a backup.",
        );
      }
      return;
    }

    const result = await applyLegacyCompatibilityMigration(connection.db);
    if (options.json) {
      console.log(JSON.stringify({ mode: "apply", result }, null, 2));
    } else {
      printReport(result.before);
      console.log(
        "Applied: tunnel modes=" + result.applied.tunnelModes
          + ", forward settings=" + result.applied.forwardProtocols
          + ", session values=" + result.applied.sessionValues,
      );
      console.log("Remaining legacy changes: " + result.after.pendingChanges);
      console.log(
        "Migration complete. Restart the panel, upgrade Agents to 2.2.151 or "
          + "newer, then re-sync Agent plugins.",
      );
    }
  } finally {
    await connection.close();
  }
}

main().catch((error) => {
  console.error(
    "Migration failed: " + (error instanceof Error ? error.message : String(error)),
  );
  process.exitCode = 1;
});
