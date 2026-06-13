import crypto from "crypto";
import fs from "fs";
import path from "path";

function readOrCreateCookieSecret() {
  const envSecret = String(process.env.JWT_SECRET || "").trim();
  if (envSecret) return envSecret;

  const configuredPath = String(process.env.FORWARDX_JWT_SECRET_PATH || "").trim();
  const defaultDataDir = process.platform === "win32" ? path.resolve(process.cwd(), "data") : "/data";
  const sqliteDir = path.dirname(String(process.env.SQLITE_PATH || path.join(defaultDataDir, "forwardx.db")));
  const candidates = [
    configuredPath,
    path.join(sqliteDir, "jwt.secret"),
    path.resolve(process.cwd(), "data", "jwt.secret"),
  ].filter(Boolean);

  for (const filePath of candidates) {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8").trim() : "";
      if (existing.length >= 32) return existing;
      const generated = crypto.randomBytes(32).toString("hex");
      fs.writeFileSync(filePath, `${generated}\n`, { encoding: "utf8", mode: 0o600 });
      console.warn(`[Security] JWT_SECRET is not set; generated persistent cookie secret at ${filePath}`);
      return generated;
    } catch {
      // Try the next candidate path.
    }
  }

  console.warn("[Security] JWT_SECRET is not set and no writable secret path was found; using an in-memory cookie secret.");
  return crypto.randomBytes(32).toString("hex");
}

function readIntEnv(names: string[], fallback: number, min: number, max: number) {
  for (const name of names) {
    const raw = process.env[name];
    if (raw === undefined || raw.trim() === "") continue;
    const value = Number.parseInt(raw, 10);
    if (Number.isFinite(value)) return Math.max(min, Math.min(max, value));
  }
  return fallback;
}

const databaseMaxOpenConns = readIntEnv(["DATABASE_MAX_OPEN_CONNS", "DB_MAX_OPEN_CONNS"], 50, 1, 500);
const databaseMaxIdleConns = Math.min(
  readIntEnv(["DATABASE_MAX_IDLE_CONNS", "DB_MAX_IDLE_CONNS"], 10, 0, 500),
  databaseMaxOpenConns,
);

export const ENV = {
  cookieSecret: readOrCreateCookieSecret(),
  mysqlUrl: process.env.MYSQL_URL ?? "",
  mysqlHost: process.env.MYSQL_HOST ?? "",
  mysqlPort: Number.parseInt(process.env.MYSQL_PORT || "3306", 10),
  mysqlUser: process.env.MYSQL_USER ?? "",
  mysqlPassword: process.env.MYSQL_PASSWORD ?? "",
  mysqlDatabase: process.env.MYSQL_DATABASE ?? "",
  mysqlSsl: process.env.MYSQL_SSL === "true",
  mysqlConfigPath: process.env.MYSQL_CONFIG_PATH ?? "/data/mysql.json",
  postgresUrl: process.env.POSTGRES_URL ?? process.env.POSTGRESQL_URL ?? process.env.PG_URL ?? "",
  postgresHost: process.env.POSTGRES_HOST ?? process.env.POSTGRESQL_HOST ?? process.env.PGHOST ?? "",
  postgresPort: Number.parseInt(process.env.POSTGRES_PORT || process.env.POSTGRESQL_PORT || process.env.PGPORT || "5432", 10),
  postgresUser: process.env.POSTGRES_USER ?? process.env.POSTGRESQL_USER ?? process.env.PGUSER ?? "",
  postgresPassword: process.env.POSTGRES_PASSWORD ?? process.env.POSTGRESQL_PASSWORD ?? process.env.PGPASSWORD ?? "",
  postgresDatabase: process.env.POSTGRES_DATABASE ?? process.env.POSTGRESQL_DATABASE ?? process.env.PGDATABASE ?? "",
  postgresSsl: process.env.POSTGRES_SSL === "true" || process.env.POSTGRESQL_SSL === "true" || process.env.PGSSL === "true",
  databaseType: process.env.DATABASE_TYPE ?? process.env.DB_TYPE ?? "",
  databaseConfigPath: process.env.DATABASE_CONFIG_PATH ?? process.env.DB_CONFIG_PATH ?? "/data/database.json",
  databaseMaxOpenConns,
  databaseMaxIdleConns,
  databaseConnMaxLifetimeMinutes: readIntEnv(["DATABASE_CONN_MAX_LIFETIME_MINUTES", "DB_CONN_MAX_LIFETIME_MINUTES"], 30, 0, 1440),
  databaseConnMaxIdleTimeMinutes: readIntEnv(["DATABASE_CONN_MAX_IDLE_TIME_MINUTES", "DB_CONN_MAX_IDLE_TIME_MINUTES"], 5, 1, 1440),
  databaseConnectTimeoutMs: readIntEnv(["DATABASE_CONNECT_TIMEOUT_MS", "DB_CONNECT_TIMEOUT_MS"], 6000, 1000, 120000),
  sqlitePath: process.env.SQLITE_PATH ?? "/data/forwardx.db",
  port: Number.parseInt(process.env.PORT || "3000", 10),
  portConfigPath: process.env.FORWARDX_PORT_CONFIG_PATH ?? "",
  portManagement: process.env.FORWARDX_PORT_MANAGEMENT ?? "",
  panelSslEnabled: process.env.FORWARDX_PANEL_SSL_ENABLED === "true",
  panelSslCertPath: process.env.FORWARDX_PANEL_SSL_CERT_PATH ?? "",
  panelSslKeyPath: process.env.FORWARDX_PANEL_SSL_KEY_PATH ?? "",
  // 管理后台一键升级命令。为空时只允许检查更新，不执行升级。
  // 执行时会注入 FORWARDX_TARGET_VERSION / FORWARDX_CURRENT_VERSION / FORWARDX_REPO_URL。
  upgradeCommand: process.env.FORWARDX_UPGRADE_COMMAND ?? "",
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN ?? "",
  telegramBotPolling: process.env.TELEGRAM_BOT_POLLING !== "false",
  isProduction: process.env.NODE_ENV === "production",
};
