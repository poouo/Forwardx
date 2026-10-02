import type { DatabaseHealth } from "../shared/databaseHealth";

// Never expose driver messages: they can contain passwords, SQL, parameters,
// internal addresses or filesystem paths. Codes and explanations are allowlisted.
export function describeDatabaseError(error: unknown): NonNullable<DatabaseHealth["reason"]> | null {
  const pending: unknown[] = [error];
  const seen = new Set<unknown>();
  for (let count = 0; pending.length && count < 16; count++) {
    const item = pending.shift();
    if (!item || typeof item !== "object" || seen.has(item)) continue;
    seen.add(item);
    const value = item as { code?: unknown; message?: unknown; cause?: unknown; errors?: unknown[] };
    const code = String(value.code || "").toUpperCase();
    const message = String(value.message || "");
    const reason = (safeCode: string, text: string, suggestion: string) => ({ code: safeCode, message: text, suggestion });
    if (code === "ECONNREFUSED") return reason(code, "数据库连接被拒绝", "检查数据库服务是否启动、监听端口和容器网络是否正确。");
    if (["ENOTFOUND", "EAI_AGAIN"].includes(code)) return reason(code, "无法解析数据库地址", "检查数据库主机名、DNS 和容器网络。");
    if (["ETIMEDOUT", "ESOCKETTIMEDOUT"].includes(code) || /connection terminated due to connection timeout|query read timeout|connect timeout|connection timeout|timeout exceeded when trying to connect/i.test(message)) {
      return reason("ETIMEDOUT", "数据库连接或响应超时", "检查数据库负载、网络、防火墙和连接池是否拥堵。");
    }
    if (["ECONNRESET", "EPIPE", "ENETUNREACH", "EHOSTUNREACH", "PROTOCOL_CONNECTION_LOST", "57P01", "57P02", "57P03"].includes(code) || code.startsWith("08") || /connection terminated unexpectedly|connection is closed|database connection is not open|can't add new command when connection is in closed state/i.test(message)) {
      return reason(code || "CONNECTION_LOST", "数据库连接中断或服务正在停止", "检查数据库重启、服务日志和网络状态。");
    }
    if (["28P01", "28000", "ER_ACCESS_DENIED_ERROR", "ER_DBACCESS_DENIED_ERROR"].includes(code)) return reason(code, "数据库账号认证或访问权限失败", "由管理员检查数据库账号、密码和授权；不要在公开页面粘贴密码。");
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
  constructor(private log: (message: string) => void = (message) => console.warn(message)) {}

  snapshot(): DatabaseHealth { return { ...this.health, reason: this.health.reason ? { ...this.health.reason } : null }; }

  configure(databaseType: DatabaseHealth["databaseType"]) { this.health.databaseType = databaseType; }

  unavailable(error: unknown, initialization = false, force = false) {
    const reason = describeDatabaseError(error);
    if (!reason && !initialization && !force) return false;
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
    if (this.health.state === "unavailable") this.log(`[DatabaseHealth] recovered type=${this.health.databaseType || "unknown"}`);
    this.health = { ...this.health, state: "healthy", checkedAt: new Date().toISOString(), unavailableSince: null, reason: null, restartRequired: false };
  }

  notConfigured() { this.health = { state: "not_configured", databaseType: null, checkedAt: new Date().toISOString(), unavailableSince: null, reason: null, restartRequired: false }; }
}

export const databaseHealth = new DatabaseHealthTracker();
