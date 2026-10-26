import type { DatabaseHealth } from "../shared/databaseHealth";

// Never expose driver messages: they can contain passwords, SQL, parameters,
// internal addresses or filesystem paths. Codes and explanations are allowlisted.
const mysqlErrorCodes: Record<number, string> = {
  1040: "ER_CON_COUNT_ERROR", 1203: "ER_TOO_MANY_USER_CONNECTIONS",
  1044: "ER_DBACCESS_DENIED_ERROR", 1045: "ER_ACCESS_DENIED_ERROR",
  1049: "ER_BAD_DB_ERROR", 1054: "ER_BAD_FIELD_ERROR", 1062: "ER_DUP_ENTRY",
  1064: "ER_PARSE_ERROR", 1071: "ER_TOO_LONG_KEY", 1114: "ER_RECORD_FILE_FULL",
  1118: "ER_TOO_BIG_ROWSIZE", 1129: "ER_HOST_IS_BLOCKED", 1130: "ER_HOST_NOT_PRIVILEGED",
  1142: "ER_TABLEACCESS_DENIED_ERROR", 1143: "ER_COLUMNACCESS_DENIED_ERROR",
  1146: "ER_NO_SUCH_TABLE", 1205: "ER_LOCK_WAIT_TIMEOUT", 1213: "ER_LOCK_DEADLOCK",
  1227: "ER_SPECIFIC_ACCESS_DENIED_ERROR", 1235: "ER_NOT_SUPPORTED_YET",
};

// Startup SQL/DDL failures cannot be repaired by repeating migrations, even
// if a subsequent connection probe succeeds. Do not classify business SQL
// failures as whole-database outages outside initialization.
const initializationOnlyCodes = new Set([
  "ER_TABLEACCESS_DENIED_ERROR", "ER_COLUMNACCESS_DENIED_ERROR", "ER_SPECIFIC_ACCESS_DENIED_ERROR", "42501",
  "ER_NO_SUCH_TABLE", "ER_BAD_FIELD_ERROR", "42P01", "42703",
  "ER_PARSE_ERROR", "ER_NOT_SUPPORTED_YET", "42601", "0A000",
  "ER_TOO_LONG_KEY", "ER_TOO_BIG_ROWSIZE", "ER_DUP_ENTRY", "23505",
  "ER_RECORD_FILE_FULL", "53100", "ER_LOCK_WAIT_TIMEOUT", "ER_LOCK_DEADLOCK", "55P03", "40P01",
]);

// Pool saturation is backpressure, not proof of invalid credentials or a
// disconnected database. Drivers/Drizzle may nest these errors in cause.
export function isDatabaseBusyError(error: unknown): boolean {
  const pending: unknown[] = [error];
  const seen = new Set<unknown>();
  for (let count = 0; pending.length && count < 16; count++) {
    const item = pending.shift();
    if (!item || typeof item !== "object" || seen.has(item)) continue;
    seen.add(item);
    const value = item as { code?: unknown; errno?: unknown; message?: unknown; cause?: unknown; errors?: unknown[] };
    const code = String(value.code || mysqlErrorCodes[Number(value.errno)] || "").toUpperCase();
    if (["POOL_ENQUEUELIMIT", "POOL_CONNLIMIT", "ER_CON_COUNT_ERROR", "ER_TOO_MANY_USER_CONNECTIONS", "53300", "ER_LOCK_WAIT_TIMEOUT", "SQLITE_BUSY", "SQLITE_LOCKED"].includes(code) ||
      /^(Queue limit reached\.?|No connections available\.?)$/i.test(String(value.message || ""))) return true;
    pending.push(value.cause);
    if (Array.isArray(value.errors)) pending.push(...value.errors.slice(0, 8));
  }
  return false;
}

export function describeDatabaseError(error: unknown, initialization = false): NonNullable<DatabaseHealth["reason"]> | null {
  const pending: unknown[] = [error];
  const seen = new Set<unknown>();
  for (let count = 0; pending.length && count < 16; count++) {
    const item = pending.shift();
    if (!item || typeof item !== "object" || seen.has(item)) continue;
    seen.add(item);
    const value = item as { code?: unknown; errno?: unknown; message?: unknown; sqlMessage?: unknown; cause?: unknown; errors?: unknown[] };
    let code = String(value.code || mysqlErrorCodes[Number(value.errno)] || "").toUpperCase();
    const message = String(value.sqlMessage || value.message || "");
    // Some wrappers retain only this server message. Never interpolate its
    // host, account, SQL or parameters into the publicly accessible summary.
    if (!code && /\bHost ['"][^'"\r\n]+['"] is not allowed to connect to this MySQL server\b/i.test(message)) code = "ER_HOST_NOT_PRIVILEGED";
    const reason = (safeCode: string, text: string, suggestion: string) => ({ code: safeCode, message: text, suggestion });
    if (code === "ECONNREFUSED") return reason(code, "数据库连接被拒绝", "检查数据库服务是否启动、监听端口和容器网络是否正确。");
    if (["ENOTFOUND", "EAI_AGAIN"].includes(code)) return reason(code, "无法解析数据库地址", "检查数据库主机名、DNS 和容器网络。");
    if (["ETIMEDOUT", "ESOCKETTIMEDOUT"].includes(code) || /connection terminated due to connection timeout|query read timeout|connect timeout|connection timeout|timeout exceeded when trying to connect/i.test(message)) {
      return reason("ETIMEDOUT", "数据库连接或响应超时", "检查数据库负载、网络、防火墙和连接池是否拥堵。");
    }
    const connectionLostCode = ["ECONNRESET", "EPIPE", "ENETUNREACH", "EHOSTUNREACH", "PROTOCOL_CONNECTION_LOST", "57P01", "57P02", "57P03"].includes(code) || /^08[A-Z0-9]{3}$/.test(code);
    if (connectionLostCode || /connection terminated unexpectedly|connection is closed|database connection is not open|can't add new command when connection is in closed state/i.test(message)) {
      return reason(connectionLostCode ? code : "CONNECTION_LOST", "数据库连接中断或服务正在停止", "检查数据库重启、服务日志和网络状态。");
    }
    if (code === "ER_HOST_NOT_PRIVILEGED") return reason(code, "MySQL 不允许面板所在主机连接", "检查数据库账号的 Host（允许访问来源）授权。Docker 部署需允许实际容器来源 IP 或受限网段，不要只授权 localhost；修正后会自动重新检查。");
    if (code === "ER_HOST_IS_BLOCKED") return reason(code, "MySQL 因连接错误过多封禁了面板来源主机", "先检查网络和数据库连接配置，再由数据库管理员检查主机缓存封禁及 max_connect_errors；不要仅反复重启面板。");
    if (["28P01", "28000", "ER_ACCESS_DENIED_ERROR"].includes(code)) return reason(code, "数据库账号认证失败", "检查面板配置的数据库用户名、密码和认证方式，以及账号允许访问的来源主机；不要公开密码。");
    if (code === "ER_DBACCESS_DENIED_ERROR") return reason(code, "数据库账号无权访问配置的数据库", "检查数据库名及该账号对此数据库的授权；连接到 MySQL 服务不代表拥有数据库访问权限。");
    if (initialization && initializationOnlyCodes.has(code)) {
      if (["ER_TABLEACCESS_DENIED_ERROR", "ER_COLUMNACCESS_DENIED_ERROR", "ER_SPECIFIC_ACCESS_DENIED_ERROR", "42501"].includes(code)) return reason(code, "数据库账号缺少初始化或升级所需权限", "检查面板日志中的失败操作，为账号授予面板数据库内所需的建表、改表、索引及读写权限；修正后重启面板。");
      if (["ER_NO_SUCH_TABLE", "ER_BAD_FIELD_ERROR", "42P01", "42703"].includes(code)) return reason(code, "数据库升级所需的表或字段缺失", "查看面板日志确认缺失的表或字段，检查是否选错数据库或升级迁移未完成；不要删库，修正后重启面板。");
      if (["ER_PARSE_ERROR", "ER_NOT_SUPPORTED_YET", "42601", "0A000"].includes(code)) return reason(code, "数据库初始化或升级 SQL 执行失败", "核对数据库版本与升级日志。MySQL 要求 8.0.13+；受支持版本仍报错时，请提供失败日志排查 SQL 兼容问题，修正后重启面板。");
      if (["ER_TOO_LONG_KEY", "ER_TOO_BIG_ROWSIZE"].includes(code)) return reason(code, "数据库表的索引或行大小超过限制", "检查日志中的表结构错误及 MySQL 版本、字符集和行格式；备份后按具体错误处理，勿删库或盲目截断数据，修正后重启面板。");
      if (["ER_DUP_ENTRY", "23505"].includes(code)) return reason(code, "数据库升级遇到重复数据或唯一索引冲突", "先备份数据库，查看面板日志定位重复数据或索引冲突；不要直接删除业务数据，修正后重启面板。");
      if (["ER_RECORD_FILE_FULL", "53100"].includes(code)) return reason(code, "数据库存储空间或表空间不足", "检查数据库服务器磁盘、表空间和临时目录容量；腾出空间或调整容量后重启面板。");
      return reason(code, "数据库升级被锁等待或事务冲突中断", "检查是否有其他面板实例同时升级，或数据库存在长事务；处理锁冲突后重启面板。");
    }
    if (["3D000", "ER_BAD_DB_ERROR"].includes(code)) return reason(code, "配置的数据库不存在", "检查数据库是否存在，以及面板配置的数据库名是否正确。");
    if (["53300", "ER_CON_COUNT_ERROR", "ER_TOO_MANY_USER_CONNECTIONS"].includes(code)) return reason(code, "数据库连接数达到上限", "检查数据库连接数限制和其他应用的连接占用。");
    if (/^(SQLITE_(CANTOPEN|IOERR|CORRUPT|NOTADB|FULL|READONLY|BUSY|LOCKED))(_|$)/.test(code)) return reason(code.split("_").slice(0, 2).join("_"), "SQLite 文件访问、存储或锁状态异常", "检查磁盘空间、文件权限、数据库日志和是否有其他进程占用；勿删除数据库文件。");
    if (["SELF_SIGNED_CERT_IN_CHAIN", "DEPTH_ZERO_SELF_SIGNED_CERT", "CERT_HAS_EXPIRED", "ERR_TLS_CERT_ALTNAME_INVALID", "UNABLE_TO_VERIFY_LEAF_SIGNATURE"].includes(code)) return reason(code, "数据库 TLS 证书验证失败", "检查数据库证书有效期、证书链和连接主机名。");
    pending.push(value.cause);
    if (Array.isArray(value.errors)) pending.push(...value.errors.slice(0, 8));
  }
  return null;
}

export class DatabaseHealthTracker {
  private health: DatabaseHealth = { state: "checking", databaseType: null, checkedAt: null, unavailableSince: null, reason: null, restartRequired: false };
  private lastLogAt = 0;
  private initializationBlocked = false;
  constructor(private log: (message: string) => void = (message) => console.warn(message)) {}

  snapshot(): DatabaseHealth { return { ...this.health, reason: this.health.reason ? { ...this.health.reason } : null }; }

  configure(databaseType: DatabaseHealth["databaseType"]) { this.health.databaseType = databaseType; }

  canRetryInitialization() { return !this.initializationBlocked; }

  unavailable(error: unknown, initialization = false, force = false) {
    if (!initialization && isDatabaseBusyError(error)) return false;
    const reason = describeDatabaseError(error, initialization);
    if (!reason && !initialization && !force) return false;
    // A later network probe must not hide the original failed migration or
    // make it eligible for recurring retries after the network recovers.
    if (this.initializationBlocked) {
      this.health = { ...this.health, checkedAt: new Date().toISOString() };
      return true;
    }
    if (initialization && (!reason || initializationOnlyCodes.has(reason.code))) this.initializationBlocked = true;
    const now = Date.now();
    const changed = this.health.state !== "unavailable";
    const sqliteStorageFailure = /^SQLITE_(FULL|READONLY|CORRUPT|NOTADB|IOERR)$/.test(reason?.code || "");
    this.health = { ...this.health, state: "unavailable", checkedAt: new Date(now).toISOString(), unavailableSince: this.health.unavailableSince || new Date(now).toISOString(), reason: reason || { code: initialization ? "INITIALIZATION_FAILED" : "DATABASE_CHECK_FAILED", message: initialization ? "数据库初始化失败" : "数据库健康检查失败", suggestion: "查看面板日志，检查数据库结构、权限和版本兼容性。" }, restartRequired: this.health.restartRequired || initialization || sqliteStorageFailure };
    if (changed || now - this.lastLogAt >= 60_000) {
      this.lastLogAt = now;
      this.log(`[DatabaseHealth] unavailable type=${this.health.databaseType || "unknown"} code=${this.health.reason!.code}; ${this.health.reason!.message}`);
    }
    return true;
  }

  healthy() {
    this.initializationBlocked = false;
    if (this.health.state === "unavailable") this.log(`[DatabaseHealth] recovered type=${this.health.databaseType || "unknown"}`);
    this.health = { ...this.health, state: "healthy", checkedAt: new Date().toISOString(), unavailableSince: null, reason: null, restartRequired: false };
  }

  notConfigured() { this.initializationBlocked = false; this.health = { state: "not_configured", databaseType: null, checkedAt: new Date().toISOString(), unavailableSince: null, reason: null, restartRequired: false }; }
}

export const databaseHealth = new DatabaseHealthTracker();
