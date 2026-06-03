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
  databaseType: process.env.DATABASE_TYPE ?? process.env.DB_TYPE ?? "",
  databaseConfigPath: process.env.DATABASE_CONFIG_PATH ?? process.env.DB_CONFIG_PATH ?? "/data/database.json",
  sqlitePath: process.env.SQLITE_PATH ?? "/data/forwardx.db",
  port: Number.parseInt(process.env.PORT || "3000", 10),
  portConfigPath: process.env.FORWARDX_PORT_CONFIG_PATH ?? "",
  portManagement: process.env.FORWARDX_PORT_MANAGEMENT ?? "",
  // 管理后台一键升级命令。为空时只允许检查更新，不执行升级。
  // 执行时会注入 FORWARDX_TARGET_VERSION / FORWARDX_CURRENT_VERSION / FORWARDX_REPO_URL。
  upgradeCommand: process.env.FORWARDX_UPGRADE_COMMAND ?? "",
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN ?? "",
  telegramBotPolling: process.env.TELEGRAM_BOT_POLLING !== "false",
  isProduction: process.env.NODE_ENV === "production",
};
