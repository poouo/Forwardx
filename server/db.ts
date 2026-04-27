/**
 * SQLite 数据访问层（基于 better-sqlite3 + drizzle-orm/better-sqlite3）。
 */

import { and, asc, desc, eq, gte, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import {
  InsertUser, users,
  hosts, InsertHost, Host,
  forwardRules, InsertForwardRule, ForwardRule,
  hostMetrics, InsertHostMetric,
  trafficStats, InsertTrafficStat,
  agentTokens, InsertAgentToken,
  forwardTests, InsertForwardTest,
  userHostPermissions, InsertUserHostPermission,
  systemSettings,
  tcpingStats, InsertTcpingStat,
} from "../drizzle/schema";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { ENV } from "./env";

let _db: ReturnType<typeof drizzle> | null = null;
let _sqlite: Database.Database | null = null;

function resolveDbPath(): string {
  const p = ENV.sqlitePath || "/data/forwardx.db";
  const dir = path.dirname(p);
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
  return p;
}

export async function getDb() {
  if (_db) return _db;
  try {
    const dbPath = resolveDbPath();
    _sqlite = new Database(dbPath);
    _sqlite.pragma("journal_mode = WAL");
    _sqlite.pragma("synchronous = NORMAL");
    _sqlite.pragma("foreign_keys = ON");
    _db = drizzle(_sqlite);
    console.log(`[Database] SQLite opened at ${dbPath}`);
  } catch (error) {
    console.error("[Database] Failed to open SQLite:", error);
    _db = null;
  }
  return _db;
}

// ==================== Password Hashing ====================

function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const testHash = crypto.scryptSync(password, salt, 64).toString("hex");
  return hash === testHash;
}

// ==================== Initialization ====================

export async function initDatabase() {
  const db = await getDb();
  if (!db || !_sqlite) {
    console.warn("[Database] Cannot initialize: SQLite not available");
    return;
  }
  try {
    _sqlite.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        password TEXT NOT NULL,
        name TEXT,
        email TEXT,
        role TEXT NOT NULL DEFAULT 'user',
        canAddRules INTEGER NOT NULL DEFAULT 0,
        trafficLimit INTEGER NOT NULL DEFAULT 0,
        trafficUsed INTEGER NOT NULL DEFAULT 0,
        expiresAt INTEGER,
        trafficAutoReset INTEGER NOT NULL DEFAULT 0,
        trafficResetDay INTEGER NOT NULL DEFAULT 1,
        lastTrafficReset INTEGER,
        createdAt INTEGER NOT NULL DEFAULT (unixepoch()),
        updatedAt INTEGER NOT NULL DEFAULT (unixepoch()),
        lastSignedIn INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE TABLE IF NOT EXISTS hosts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        ip TEXT NOT NULL,
        hostType TEXT NOT NULL DEFAULT 'slave',
        agentToken TEXT,
        osInfo TEXT,
        cpuInfo TEXT,
        memoryTotal INTEGER,
        networkInterface TEXT,
        portRangeStart INTEGER,
        portRangeEnd INTEGER,
        isOnline INTEGER NOT NULL DEFAULT 0,
        lastHeartbeat INTEGER,
        userId INTEGER NOT NULL,
        createdAt INTEGER NOT NULL DEFAULT (unixepoch()),
        updatedAt INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS idx_hosts_user ON hosts(userId);
      CREATE INDEX IF NOT EXISTS idx_hosts_token ON hosts(agentToken);

      CREATE TABLE IF NOT EXISTS forward_rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        hostId INTEGER NOT NULL,
        name TEXT NOT NULL,
        forwardType TEXT NOT NULL DEFAULT 'iptables',
        protocol TEXT NOT NULL DEFAULT 'tcp',
        sourcePort INTEGER NOT NULL,
        targetIp TEXT NOT NULL,
        targetPort INTEGER NOT NULL,
        isEnabled INTEGER NOT NULL DEFAULT 1,
        isRunning INTEGER NOT NULL DEFAULT 0,
        userId INTEGER NOT NULL,
        createdAt INTEGER NOT NULL DEFAULT (unixepoch()),
        updatedAt INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS idx_rules_host ON forward_rules(hostId);
      CREATE INDEX IF NOT EXISTS idx_rules_user ON forward_rules(userId);

      CREATE TABLE IF NOT EXISTS host_metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        hostId INTEGER NOT NULL,
        cpuUsage INTEGER,
        memoryUsage INTEGER,
        memoryUsed INTEGER,
        networkIn INTEGER,
        networkOut INTEGER,
        diskUsage INTEGER,
        uptime INTEGER,
        recordedAt INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS idx_host_metrics_host_time ON host_metrics(hostId, recordedAt DESC);

      CREATE TABLE IF NOT EXISTS traffic_stats (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ruleId INTEGER NOT NULL,
        hostId INTEGER NOT NULL,
        bytesIn INTEGER NOT NULL DEFAULT 0,
        bytesOut INTEGER NOT NULL DEFAULT 0,
        connections INTEGER NOT NULL DEFAULT 0,
        recordedAt INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS idx_traffic_rule_time ON traffic_stats(ruleId, recordedAt DESC);
      CREATE INDEX IF NOT EXISTS idx_traffic_host_time ON traffic_stats(hostId, recordedAt DESC);

      CREATE TABLE IF NOT EXISTS agent_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        token TEXT NOT NULL UNIQUE,
        hostId INTEGER,
        description TEXT,
        isUsed INTEGER NOT NULL DEFAULT 0,
        userId INTEGER NOT NULL,
        createdAt INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS idx_agent_tokens_user ON agent_tokens(userId);

      CREATE TABLE IF NOT EXISTS tcping_stats (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ruleId INTEGER NOT NULL,
        hostId INTEGER NOT NULL,
        latencyMs INTEGER,
        isTimeout INTEGER NOT NULL DEFAULT 0,
        recordedAt INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS idx_tcping_rule_time ON tcping_stats(ruleId, recordedAt DESC);
      CREATE INDEX IF NOT EXISTS idx_tcping_host_time ON tcping_stats(hostId, recordedAt DESC);

      CREATE TABLE IF NOT EXISTS forward_tests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ruleId INTEGER NOT NULL,
        hostId INTEGER NOT NULL,
        userId INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        listenOk INTEGER NOT NULL DEFAULT 0,
        targetReachable INTEGER NOT NULL DEFAULT 0,
        forwardOk INTEGER NOT NULL DEFAULT 0,
        latencyMs INTEGER,
        message TEXT,
        createdAt INTEGER NOT NULL DEFAULT (unixepoch()),
        updatedAt INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS idx_forward_tests_rule ON forward_tests(ruleId, createdAt DESC);
      CREATE INDEX IF NOT EXISTS idx_forward_tests_host_status ON forward_tests(hostId, status);
    `);

    // 数据库迁移：为旧数据库添加新列（ALTER TABLE ADD COLUMN 在列已存在时会报错，忽略即可）
    const migrations = [
      `ALTER TABLE hosts ADD COLUMN networkInterface TEXT`,
      `ALTER TABLE hosts ADD COLUMN portRangeStart INTEGER`,
      `ALTER TABLE hosts ADD COLUMN portRangeEnd INTEGER`,
      `ALTER TABLE users ADD COLUMN canAddRules INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE users ADD COLUMN trafficLimit INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE users ADD COLUMN trafficUsed INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE users ADD COLUMN expiresAt INTEGER`,
      `ALTER TABLE users ADD COLUMN trafficAutoReset INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE users ADD COLUMN trafficResetDay INTEGER NOT NULL DEFAULT 1`,
      `ALTER TABLE users ADD COLUMN lastTrafficReset INTEGER`,
      `ALTER TABLE users ADD COLUMN maxRules INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE users ADD COLUMN maxPorts INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE hosts ADD COLUMN entryIp TEXT`,
      `ALTER TABLE users ADD COLUMN allowedForwardTypes TEXT`,
    ];

    // 创建用户-主机权限表
    _sqlite.exec(`
      CREATE TABLE IF NOT EXISTS user_host_permissions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        userId INTEGER NOT NULL,
        hostId INTEGER NOT NULL,
        createdAt INTEGER NOT NULL DEFAULT (unixepoch()),
        UNIQUE(userId, hostId)
      );
      CREATE INDEX IF NOT EXISTS idx_uhp_user ON user_host_permissions(userId);
      CREATE INDEX IF NOT EXISTS idx_uhp_host ON user_host_permissions(hostId);
    `);

    // 创建系统设置表（k-v）
    _sqlite.exec(`
      CREATE TABLE IF NOT EXISTS system_settings (
        key TEXT PRIMARY KEY,
        value TEXT,
        updatedAt INTEGER NOT NULL DEFAULT (unixepoch())
      );
    `);
    for (const m of migrations) {
      try { _sqlite.exec(m); } catch { /* column already exists */ }
    }

    // Seed or reset default admin user
    const defaultPassword = process.env.ADMIN_PASSWORD || "admin123";
    const existing = await db.select().from(users).where(eq(users.username, "admin")).limit(1);
    if (existing.length === 0) {
      const hashedPassword = hashPassword(defaultPassword);
      await db.insert(users).values({
        username: "admin",
        password: hashedPassword,
        name: "管理员",
        email: "admin@forwardx.local",
        role: "admin",
        canAddRules: true,
      });
      console.log("[Database] Default admin user created (admin / admin123)");
    } else {
      const hashedPassword = hashPassword(defaultPassword);
      await db.update(users).set({ password: hashedPassword, role: "admin", canAddRules: true, updatedAt: nowDate() }).where(eq(users.username, "admin"));
      console.log("[Database] Admin password has been reset to default");
    }
    console.log("[Database] Initialization complete");
  } catch (error) {
    console.error("[Database] Initialization failed:", error);
    throw error;
  }
}

function lastRowId(): number {
  if (!_sqlite) return 0;
  const r = _sqlite.prepare("SELECT last_insert_rowid() as id").get() as { id: number | bigint };
  return Number(r.id);
}

const nowDate = () => new Date();

// ==================== User Queries ====================

export async function getUserByUsername(username: string) {
  const db = await getDb();
  if (!db) return undefined;
  const r = await db.select().from(users).where(eq(users.username, username)).limit(1);
  return r[0];
}

export async function getUserById(id: number) {
  const db = await getDb();
  if (!db) return undefined;
  const r = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return r[0];
}

export async function authenticateUser(username: string, password: string) {
  const user = await getUserByUsername(username);
  if (!user) return null;
  if (!verifyPassword(password, user.password)) return null;
  const db = await getDb();
  if (db) {
    await db.update(users).set({ lastSignedIn: nowDate(), updatedAt: nowDate() }).where(eq(users.id, user.id));
  }
  return user;
}

export async function changeUserPassword(userId: number, oldPassword: string, newPassword: string): Promise<boolean> {
  const user = await getUserById(userId);
  if (!user) return false;
  if (!verifyPassword(oldPassword, user.password)) return false;
  const db = await getDb();
  if (!db) return false;
  await db.update(users).set({ password: hashPassword(newPassword), updatedAt: nowDate() }).where(eq(users.id, userId));
  return true;
}

export async function updateUserProfile(userId: number, data: { name?: string; email?: string }) {
  const db = await getDb();
  if (!db) return;
  await db.update(users).set({ ...data, updatedAt: nowDate() }).where(eq(users.id, userId));
}

export async function createUser(data: { username: string; password: string; name?: string; email?: string; role?: "user" | "admin"; canAddRules?: boolean }) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.insert(users).values({
    username: data.username,
    password: hashPassword(data.password),
    name: data.name ?? data.username,
    email: data.email ?? null,
    role: data.role ?? "user",
    canAddRules: data.canAddRules ?? false,
  });
  return lastRowId();
}

/** 用户自行注册（默认 role=user, canAddRules=false） */
export async function registerUser(data: { username: string; password: string; name?: string; email?: string }) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.insert(users).values({
    username: data.username,
    password: hashPassword(data.password),
    name: data.name ?? data.username,
    email: data.email ?? null,
    role: "user",
    canAddRules: false,
  });
  return lastRowId();
}

export async function resetUserPassword(userId: number, newPassword: string) {
  const db = await getDb();
  if (!db) return;
  await db.update(users).set({ password: hashPassword(newPassword), updatedAt: nowDate() }).where(eq(users.id, userId));
}

export async function getAllUsers() {
  const db = await getDb();
  if (!db) return [];
  return db
    .select({
      id: users.id,
      username: users.username,
      name: users.name,
      email: users.email,
      role: users.role,
      canAddRules: users.canAddRules,
      maxRules: users.maxRules,
      maxPorts: users.maxPorts,
      trafficLimit: users.trafficLimit,
      trafficUsed: users.trafficUsed,
      expiresAt: users.expiresAt,
      trafficAutoReset: users.trafficAutoReset,
      trafficResetDay: users.trafficResetDay,
      lastTrafficReset: users.lastTrafficReset,
      createdAt: users.createdAt,
      lastSignedIn: users.lastSignedIn,
    })
    .from(users)
    .orderBy(desc(users.createdAt));
}

export async function updateUserRole(userId: number, role: "user" | "admin") {
  const db = await getDb();
  if (!db) return;
  await db.update(users).set({ role, updatedAt: nowDate() }).where(eq(users.id, userId));
}

export async function deleteUser(userId: number) {
  const db = await getDb();
  if (!db) return;
  await db.delete(users).where(eq(users.id, userId));
}

/** 更新用户流量管理设置（管理员操作） */
export async function updateUserTrafficSettings(userId: number, data: {
  trafficLimit?: number;
  expiresAt?: Date | null;
  trafficAutoReset?: boolean;
  trafficResetDay?: number;
  canAddRules?: boolean;
  maxRules?: number;
  maxPorts?: number;
  allowedForwardTypes?: string | null;
}) {
  const db = await getDb();
  if (!db) return;
  await db.update(users).set({ ...data, updatedAt: nowDate() } as any).where(eq(users.id, userId));
}

/** 手动重置用户流量 */
export async function resetUserTraffic(userId: number) {
  const db = await getDb();
  if (!db) return;
  await db.update(users).set({
    trafficUsed: 0,
    lastTrafficReset: nowDate(),
    updatedAt: nowDate(),
  }).where(eq(users.id, userId));
}

/** 累加用户已用流量 */
export async function addUserTraffic(userId: number, bytes: number) {
  const db = await getDb();
  if (!db) return;
  await db.update(users).set({
    trafficUsed: sql`${users.trafficUsed} + ${bytes}`,
    updatedAt: nowDate(),
  }).where(eq(users.id, userId));
}

/** 获取所有需要月度自动重置的用户 */
export async function getUsersForAutoReset(day: number) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(users).where(
    and(eq(users.trafficAutoReset, true), eq(users.trafficResetDay, day))
  );
}

/** 获取所有已到期的用户 */
export async function getExpiredUsers() {
  const db = await getDb();
  if (!db) return [];
  const now = nowDate();
  return db.select().from(users).where(
    and(
      sql`${users.expiresAt} IS NOT NULL`,
      sql`${users.expiresAt} <= ${Math.floor(now.getTime() / 1000)}`
    )
  );
}

/** 禁用某用户的所有转发规则（到期/超额时调用） */
export async function disableAllUserRules(userId: number) {
  const db = await getDb();
  if (!db) return;
  await db.update(forwardRules).set({ isEnabled: false, updatedAt: nowDate() }).where(eq(forwardRules.userId, userId));
}

/** 获取用户流量汇总信息（用于仪表盘展示） */
export async function getUserTrafficSummaries() {
  const db = await getDb();
  if (!db) return [];
  return db.select({
    id: users.id,
    username: users.username,
    name: users.name,
    role: users.role,
    trafficLimit: users.trafficLimit,
    trafficUsed: users.trafficUsed,
    expiresAt: users.expiresAt,
    trafficAutoReset: users.trafficAutoReset,
    trafficResetDay: users.trafficResetDay,
  }).from(users).orderBy(desc(users.trafficUsed));
}

// ==================== Host Queries ====================

export async function getHosts(userId?: number) {
  const db = await getDb();
  if (!db) return [];
  if (userId) {
    return db.select().from(hosts).where(eq(hosts.userId, userId)).orderBy(desc(hosts.createdAt));
  }
  return db.select().from(hosts).orderBy(desc(hosts.createdAt));
}

export async function getHostById(id: number) {
  const db = await getDb();
  if (!db) return undefined;
  const r = await db.select().from(hosts).where(eq(hosts.id, id)).limit(1);
  return r[0];
}

export async function createHost(host: InsertHost) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.insert(hosts).values(host);
  return lastRowId();
}

export async function updateHost(id: number, data: Partial<InsertHost>) {
  const db = await getDb();
  if (!db) return;
  await db.update(hosts).set({ ...data, updatedAt: nowDate() }).where(eq(hosts.id, id));
}

export async function deleteHost(id: number) {
  const db = await getDb();
  if (!db) return;
  await db.delete(forwardRules).where(eq(forwardRules.hostId, id));
  await db.delete(hostMetrics).where(eq(hostMetrics.hostId, id));
  await db.delete(trafficStats).where(eq(trafficStats.hostId, id));
  await db.delete(hosts).where(eq(hosts.id, id));
}

export async function updateHostHeartbeat(id: number, metrics?: Partial<InsertHost>) {
  const db = await getDb();
  if (!db) return;
  await db.update(hosts).set({ isOnline: true, lastHeartbeat: nowDate(), updatedAt: nowDate(), ...(metrics ?? {}) }).where(eq(hosts.id, id));
}

export async function getHostByAgentToken(token: string) {
  const db = await getDb();
  if (!db) return undefined;
  const r = await db.select().from(hosts).where(eq(hosts.agentToken, token)).limit(1);
  return r[0];
}

/** 获取主机下的转发规则数量 */
export async function getHostRuleCount(hostId: number): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const r = await db.select({ count: sql<number>`COUNT(*)` }).from(forwardRules).where(eq(forwardRules.hostId, hostId));
  return Number(r[0]?.count) || 0;
}

// ==================== Forward Rule Queries ====================

export async function getForwardRules(userId?: number, hostId?: number) {
  const db = await getDb();
  if (!db) return [];
  const conds: any[] = [];
  if (userId) conds.push(eq(forwardRules.userId, userId));
  if (hostId) conds.push(eq(forwardRules.hostId, hostId));
  if (conds.length > 0) {
    return db.select().from(forwardRules).where(and(...conds)).orderBy(desc(forwardRules.createdAt));
  }
  return db.select().from(forwardRules).orderBy(desc(forwardRules.createdAt));
}

export async function getForwardRuleById(id: number) {
  const db = await getDb();
  if (!db) return undefined;
  const r = await db.select().from(forwardRules).where(eq(forwardRules.id, id)).limit(1);
  return r[0];
}

export async function createForwardRule(rule: InsertForwardRule) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.insert(forwardRules).values(rule);
  return lastRowId();
}

export async function updateForwardRule(id: number, data: Partial<InsertForwardRule>) {
  const db = await getDb();
  if (!db) return;
  await db.update(forwardRules).set({ ...data, updatedAt: nowDate() }).where(eq(forwardRules.id, id));
}

export async function deleteForwardRule(id: number) {
  const db = await getDb();
  if (!db) return;
  await db.delete(trafficStats).where(eq(trafficStats.ruleId, id));
  await db.delete(forwardRules).where(eq(forwardRules.id, id));
}

export async function toggleForwardRule(id: number, isEnabled: boolean) {
  const db = await getDb();
  if (!db) return;
  await db.update(forwardRules).set({ isEnabled, updatedAt: nowDate() }).where(eq(forwardRules.id, id));
}

export async function updateRuleRunningStatus(id: number, isRunning: boolean) {
  const db = await getDb();
  if (!db) return;
  await db.update(forwardRules).set({ isRunning, updatedAt: nowDate() }).where(eq(forwardRules.id, id));
}

/** 检查某主机上某端口是否已被占用 */
export async function isPortUsedOnHost(hostId: number, sourcePort: number, excludeRuleId?: number): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  const conds: any[] = [eq(forwardRules.hostId, hostId), eq(forwardRules.sourcePort, sourcePort)];
  if (excludeRuleId) conds.push(sql`${forwardRules.id} != ${excludeRuleId}`);
  const r = await db.select({ count: sql<number>`COUNT(*)` }).from(forwardRules).where(and(...conds));
  return (Number(r[0]?.count) || 0) > 0;
}

/** 在主机端口区间内找一个未被占用的随机端口 */
export async function findAvailablePort(hostId: number, rangeStart?: number | null, rangeEnd?: number | null): Promise<number | null> {
  const db = await getDb();
  if (!db) return null;
  const start = rangeStart ?? 10000;
  const end = rangeEnd ?? 65535;
  // 获取该主机已占用的端口
  const usedRows = await db.select({ port: forwardRules.sourcePort }).from(forwardRules).where(eq(forwardRules.hostId, hostId));
  const usedPorts = new Set(usedRows.map(r => r.port));
  // 随机尝试
  const range = end - start + 1;
  if (range <= 0) return null;
  // 如果区间不大，直接遍历找空闲
  if (range <= 10000) {
    const available: number[] = [];
    for (let p = start; p <= end; p++) {
      if (!usedPorts.has(p)) available.push(p);
    }
    if (available.length === 0) return null;
    return available[Math.floor(Math.random() * available.length)];
  }
  // 区间较大时随机尝试
  for (let i = 0; i < 100; i++) {
    const p = start + Math.floor(Math.random() * range);
    if (!usedPorts.has(p)) return p;
  }
  return null;
}

// ==================== Host Metrics Queries ====================

export async function insertHostMetric(metric: InsertHostMetric) {
  const db = await getDb();
  if (!db) return;
  await db.insert(hostMetrics).values(metric);
}

export async function getLatestHostMetrics(hostId: number, limit = 60) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(hostMetrics).where(eq(hostMetrics.hostId, hostId)).orderBy(desc(hostMetrics.recordedAt)).limit(limit);
}

// ==================== Traffic Stats Queries ====================

export async function insertTrafficStat(stat: InsertTrafficStat) {
  const db = await getDb();
  if (!db) return;
  await db.insert(trafficStats).values(stat);
}

export async function getTrafficStats(ruleId: number, limit = 60) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(trafficStats).where(eq(trafficStats.ruleId, ruleId)).orderBy(desc(trafficStats.recordedAt)).limit(limit);
}

export async function getTotalTraffic() {
  const db = await getDb();
  if (!db) return { totalIn: 0, totalOut: 0 };
  const r = await db.select({
    totalIn: sql<number>`COALESCE(SUM(bytesIn), 0)`,
    totalOut: sql<number>`COALESCE(SUM(bytesOut), 0)`,
  }).from(trafficStats);
  const row = r[0];
  return {
    totalIn: Number(row?.totalIn) || 0,
    totalOut: Number(row?.totalOut) || 0,
  };
}

/** 按规则汇总流量 */
export async function getTrafficSummaryByRule(opts: {
  userId?: number;
  hostId?: number;
  since?: Date;
} = {}) {
  const db = await getDb();
  if (!db) return [] as Array<{ ruleId: number; hostId: number; bytesIn: number; bytesOut: number; connections: number }>;
  const conds: any[] = [];
  if (opts.hostId) conds.push(eq(trafficStats.hostId, opts.hostId));
  if (opts.since) conds.push(gte(trafficStats.recordedAt, opts.since));
  const baseQuery = db
    .select({
      ruleId: trafficStats.ruleId,
      hostId: trafficStats.hostId,
      bytesIn: sql<number>`COALESCE(SUM(${trafficStats.bytesIn}), 0)`,
      bytesOut: sql<number>`COALESCE(SUM(${trafficStats.bytesOut}), 0)`,
      connections: sql<number>`COALESCE(SUM(${trafficStats.connections}), 0)`,
    })
    .from(trafficStats);
  const rows = await (conds.length ? baseQuery.where(and(...conds)) : baseQuery).groupBy(trafficStats.ruleId, trafficStats.hostId);

  let result = rows.map((r) => ({
    ruleId: Number(r.ruleId),
    hostId: Number(r.hostId),
    bytesIn: Number(r.bytesIn) || 0,
    bytesOut: Number(r.bytesOut) || 0,
    connections: Number(r.connections) || 0,
  }));

  if (opts.userId) {
    const allowed = await db.select({ id: hosts.id }).from(hosts).where(eq(hosts.userId, opts.userId));
    const ok = new Set(allowed.map((h) => Number(h.id)));
    result = result.filter((r) => ok.has(r.hostId));
  }
  return result;
}

/** 按时间分桶聚合某条规则的流量序列 */
export async function getTrafficSeriesByRule(
  ruleId: number,
  opts: { bucketMinutes?: number; since?: Date } = {}
) {
  const db = await getDb();
  if (!db) return [] as Array<{ bucket: Date; bytesIn: number; bytesOut: number; connections: number }>;
  const bucket = Math.max(1, opts.bucketMinutes ?? 1);
  const since = opts.since ?? new Date(Date.now() - 60 * 60 * 1000);
  const sinceSec = Math.floor(since.getTime() / 1000);
  const bucketSec = bucket * 60;

  const bucketExpr = sql.raw(`("recordedAt" / ${bucketSec}) * ${bucketSec}`);

  const rows = await db
    .select({
      bucket: sql<number>`${bucketExpr}`,
      bytesIn: sql<number>`COALESCE(SUM(${trafficStats.bytesIn}), 0)`,
      bytesOut: sql<number>`COALESCE(SUM(${trafficStats.bytesOut}), 0)`,
      connections: sql<number>`COALESCE(SUM(${trafficStats.connections}), 0)`,
    })
    .from(trafficStats)
    .where(and(eq(trafficStats.ruleId, ruleId), gte(trafficStats.recordedAt, since)))
    .groupBy(bucketExpr)
    .orderBy(asc(bucketExpr));

  return rows.map((r) => ({
    bucket: new Date(Number(r.bucket) * 1000),
    bytesIn: Number(r.bytesIn) || 0,
    bytesOut: Number(r.bytesOut) || 0,
    connections: Number(r.connections) || 0,
  })).filter((r) => r.bucket.getTime() / 1000 >= sinceSec);
}

/** 获取全局流量走势（按时间分桶，用于仪表盘） */
export async function getGlobalTrafficSeries(opts: { bucketMinutes?: number; since?: Date; userId?: number } = {}) {
  const db = await getDb();
  if (!db) return [] as Array<{ bucket: Date; bytesIn: number; bytesOut: number }>;
  const bucket = Math.max(1, opts.bucketMinutes ?? 5);
  const since = opts.since ?? new Date(Date.now() - 24 * 60 * 60 * 1000);
  const bucketSec = bucket * 60;

  const conds: any[] = [gte(trafficStats.recordedAt, since)];
  if (opts.userId) {
    const allowed = await db.select({ id: hosts.id }).from(hosts).where(eq(hosts.userId, opts.userId));
    const hostIds = allowed.map(h => h.id);
    if (hostIds.length === 0) return [];
    conds.push(sql`${trafficStats.hostId} IN (${sql.join(hostIds.map(id => sql`${id}`), sql`, `)})`);
  }

  const bucketExpr = sql.raw(`("recordedAt" / ${bucketSec}) * ${bucketSec}`);

  const rows = await db
    .select({
      bucket: sql<number>`${bucketExpr}`,
      bytesIn: sql<number>`COALESCE(SUM(${trafficStats.bytesIn}), 0)`,
      bytesOut: sql<number>`COALESCE(SUM(${trafficStats.bytesOut}), 0)`,
    })
    .from(trafficStats)
    .where(and(...conds))
    .groupBy(bucketExpr)
    .orderBy(asc(bucketExpr));

  return rows.map((r) => ({
    bucket: new Date(Number(r.bucket) * 1000),
    bytesIn: Number(r.bytesIn) || 0,
    bytesOut: Number(r.bytesOut) || 0,
  }));
}

// ==================== Agent Token Queries ====================

export async function createAgentToken(data: InsertAgentToken) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.insert(agentTokens).values(data);
  return lastRowId();
}

export async function getAgentTokenByToken(token: string) {
  const db = await getDb();
  if (!db) return undefined;
  const r = await db.select().from(agentTokens).where(eq(agentTokens.token, token)).limit(1);
  return r[0];
}

export async function getAgentTokens(userId?: number) {
  const db = await getDb();
  if (!db) return [];
  if (userId) {
    return db.select().from(agentTokens).where(eq(agentTokens.userId, userId)).orderBy(desc(agentTokens.createdAt));
  }
  return db.select().from(agentTokens).orderBy(desc(agentTokens.createdAt));
}

export async function markAgentTokenUsed(token: string, hostId: number) {
  const db = await getDb();
  if (!db) return;
  await db.update(agentTokens).set({ isUsed: true, hostId }).where(eq(agentTokens.token, token));
}

export async function deleteAgentToken(id: number) {
  const db = await getDb();
  if (!db) return;
  await db.delete(agentTokens).where(eq(agentTokens.id, id));
}

// ==================== Dashboard Stats ====================

export async function getDashboardStats(userId?: number) {
  const db = await getDb();
  if (!db) return { totalHosts: 0, onlineHosts: 0, totalRules: 0, activeRules: 0, totalTrafficIn: 0, totalTrafficOut: 0 };

  const hostConditions = userId ? eq(hosts.userId, userId) : undefined;
  const ruleConditions = userId ? eq(forwardRules.userId, userId) : undefined;

  const hostStatsRows = await db
    .select({
      totalHosts: sql<number>`COUNT(*)`,
      onlineHosts: sql<number>`SUM(CASE WHEN isOnline = 1 THEN 1 ELSE 0 END)`,
    })
    .from(hosts)
    .where(hostConditions as any);

  const ruleStatsRows = await db
    .select({
      totalRules: sql<number>`COUNT(*)`,
      activeRules: sql<number>`SUM(CASE WHEN isEnabled = 1 AND isRunning = 1 THEN 1 ELSE 0 END)`,
    })
    .from(forwardRules)
    .where(ruleConditions as any);

  const hostStats = hostStatsRows[0];
  const ruleStats = ruleStatsRows[0];
  const traffic = await getTotalTraffic();

  return {
    totalHosts: Number(hostStats?.totalHosts) || 0,
    onlineHosts: Number(hostStats?.onlineHosts) || 0,
    totalRules: Number(ruleStats?.totalRules) || 0,
    activeRules: Number(ruleStats?.activeRules) || 0,
    totalTrafficIn: traffic.totalIn,
    totalTrafficOut: traffic.totalOut,
  };
}

// ==================== Forward Tests ====================

export async function createForwardTest(data: InsertForwardTest) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db.insert(forwardTests).values(data);
  return lastRowId();
}

export async function getPendingForwardTestsByHost(hostId: number) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(forwardTests)
    .where(and(eq(forwardTests.hostId, hostId), eq(forwardTests.status, "pending")));
}

export async function markForwardTestRunning(id: number) {
  const db = await getDb();
  if (!db) return;
  await db.update(forwardTests).set({ status: "running", updatedAt: nowDate() }).where(eq(forwardTests.id, id));
}

export async function updateForwardTestResult(
  id: number,
  data: {
    status: "success" | "failed" | "timeout";
    listenOk?: boolean;
    targetReachable?: boolean;
    forwardOk?: boolean;
    latencyMs?: number | null;
    message?: string | null;
  }
) {
  const db = await getDb();
  if (!db) return;
  await db.update(forwardTests).set({ ...data, updatedAt: nowDate() } as any).where(eq(forwardTests.id, id));
}

export async function getLatestForwardTest(ruleId: number) {
  const db = await getDb();
  if (!db) return undefined;
  const rows = await db
    .select()
    .from(forwardTests)
    .where(eq(forwardTests.ruleId, ruleId))
    .orderBy(desc(forwardTests.createdAt))
    .limit(1);
  return rows[0];
}

export async function getForwardTestById(id: number) {
  const db = await getDb();
  if (!db) return undefined;
  const rows = await db.select().from(forwardTests).where(eq(forwardTests.id, id)).limit(1);
  return rows[0];
}

// ==================== User-Host Permissions ====================

/** 获取某用户被授权的主机ID列表 */
export async function getUserAllowedHostIds(userId: number): Promise<number[]> {
  const db = await getDb();
  if (!db) return [];
  const rows = await db.select({ hostId: userHostPermissions.hostId }).from(userHostPermissions).where(eq(userHostPermissions.userId, userId));
  return rows.map(r => r.hostId);
}

/** 获取某用户被授权的主机列表（含主机信息） */
export async function getUserAllowedHosts(userId: number) {
  const db = await getDb();
  if (!db) return [];
  const permRows = await db.select({ hostId: userHostPermissions.hostId }).from(userHostPermissions).where(eq(userHostPermissions.userId, userId));
  if (permRows.length === 0) return [];
  const hostIds = permRows.map(r => r.hostId);
  const allHosts = await db.select().from(hosts);
  return allHosts.filter(h => hostIds.includes(h.id));
}

/** 设置某用户的主机权限（全量替换） */
export async function setUserHostPermissions(userId: number, hostIds: number[]) {
  const db = await getDb();
  if (!db) return;
  // 先删除旧权限
  await db.delete(userHostPermissions).where(eq(userHostPermissions.userId, userId));
  // 插入新权限
  if (hostIds.length > 0) {
    await db.insert(userHostPermissions).values(hostIds.map(hostId => ({ userId, hostId })));
  }
}

/** 获取某主机被授权的用户ID列表 */
export async function getHostAllowedUserIds(hostId: number): Promise<number[]> {
  const db = await getDb();
  if (!db) return [];
  const rows = await db.select({ userId: userHostPermissions.userId }).from(userHostPermissions).where(eq(userHostPermissions.hostId, hostId));
  return rows.map(r => r.userId);
}

/** 检查用户是否有某主机的使用权限 */
export async function checkUserHostPermission(userId: number, hostId: number): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  const rows = await db.select().from(userHostPermissions).where(
    and(eq(userHostPermissions.userId, userId), eq(userHostPermissions.hostId, hostId))
  ).limit(1);
  return rows.length > 0;
}

/** 删除主机时清理相关权限 */
export async function deleteHostPermissions(hostId: number) {
  const db = await getDb();
  if (!db) return;
  await db.delete(userHostPermissions).where(eq(userHostPermissions.hostId, hostId));
}

/** 删除用户时清理相关权限 */
export async function deleteUserPermissions(userId: number) {
  const db = await getDb();
  if (!db) return;
  await db.delete(userHostPermissions).where(eq(userHostPermissions.userId, userId));
}

// ==================== User Rule/Port Count ====================

/** 获取某用户的规则数量 */
export async function getUserRuleCount(userId: number): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const r = await db.select({ count: sql<number>`COUNT(*)` }).from(forwardRules).where(eq(forwardRules.userId, userId));
  return Number(r[0]?.count) || 0;
}

/** 获取某用户使用的端口数量（去重） */
export async function getUserPortCount(userId: number): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const r = await db.select({ count: sql<number>`COUNT(DISTINCT sourcePort)` }).from(forwardRules).where(eq(forwardRules.userId, userId));
  return Number(r[0]?.count) || 0;
}

/** 获取所有用户的主机权限映射 */
export async function getAllUserHostPermissions(): Promise<Array<{ userId: number; hostId: number }>> {
  const db = await getDb();
  if (!db) return [];
  return db.select({ userId: userHostPermissions.userId, hostId: userHostPermissions.hostId }).from(userHostPermissions);
}

// ==================== System Settings (key-value) ====================

/** 读取单个系统设置；不存在返回 null */
export async function getSetting(key: string): Promise<string | null> {
  const db = await getDb();
  if (!db) return null;
  const r = await db.select().from(systemSettings).where(eq(systemSettings.key, key)).limit(1);
  return r[0]?.value ?? null;
}

/** 批量读取所有系统设置 */
export async function getAllSettings(): Promise<Record<string, string | null>> {
  const db = await getDb();
  if (!db) return {};
  const rows = await db.select().from(systemSettings);
  const out: Record<string, string | null> = {};
  for (const r of rows) out[r.key] = r.value ?? null;
  return out;
}

/** UPSERT 单个系统设置 */
export async function setSetting(key: string, value: string | null): Promise<void> {
  if (!_sqlite) return;
  // 直接使用 sqlite UPSERT，避免 drizzle 的 onConflict 写法版本差异
  _sqlite.prepare(
    `INSERT INTO system_settings (key, value, updatedAt) VALUES (?, ?, unixepoch())
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updatedAt=unixepoch()`
  ).run(key, value);
}

/** 批量 UPSERT */
export async function setSettings(map: Record<string, string | null>): Promise<void> {
  for (const [k, v] of Object.entries(map)) {
    await setSetting(k, v);
  }
}

// ==================== Forward Test 超时清理 ====================

/**
 * 将超时的转发自测任务标记为 timeout。
 * - pending 超过 ttlSeconds：Agent 一直没拉到任务（可能 Agent 离线）
 * - running 超过 ttlSeconds：Agent 拉走但没回报结果（可能 Agent 崩溃 / 上报被拒 / 网络中断）
 * 返回被超时清理的任务数量。
 */
// ==================== TCPing Stats ====================

export async function insertTcpingStat(stat: InsertTcpingStat) {
  const db = await getDb();
  if (!db) return;
  await db.insert(tcpingStats).values(stat);
}

export async function insertTcpingStats(stats: InsertTcpingStat[]) {
  const db = await getDb();
  if (!db) return;
  if (stats.length === 0) return;
  await db.insert(tcpingStats).values(stats);
}

/** 获取某条规则的 TCPing 延迟序列（按时间升序） */
export async function getTcpingSeriesByRule(
  ruleId: number,
  opts: { since?: Date; limit?: number } = {}
) {
  const db = await getDb();
  if (!db) return [] as Array<{ latencyMs: number | null; isTimeout: boolean; recordedAt: Date }>;
  const since = opts.since ?? new Date(Date.now() - 24 * 60 * 60 * 1000);
  const limit = opts.limit ?? 2880; // 24h * 120 per hour max
  const rows = await db
    .select({
      latencyMs: tcpingStats.latencyMs,
      isTimeout: tcpingStats.isTimeout,
      recordedAt: tcpingStats.recordedAt,
    })
    .from(tcpingStats)
    .where(and(eq(tcpingStats.ruleId, ruleId), gte(tcpingStats.recordedAt, since)))
    .orderBy(asc(tcpingStats.recordedAt))
    .limit(limit);
  return rows;
}

/** 获取全局 TCPing 延迟序列（所有规则的平均延迟，按时间分桶） */
export async function getGlobalTcpingSeries(opts: { bucketMinutes?: number; since?: Date; userId?: number } = {}) {
  const db = await getDb();
  if (!db) return [] as Array<{ bucket: Date; avgLatency: number; maxLatency: number; minLatency: number; timeoutCount: number; totalCount: number }>;
  const bucket = Math.max(1, opts.bucketMinutes ?? 1);
  const since = opts.since ?? new Date(Date.now() - 24 * 60 * 60 * 1000);
  const bucketSec = bucket * 60;

  const conds: any[] = [gte(tcpingStats.recordedAt, since)];
  if (opts.userId) {
    const allowed = await db.select({ id: hosts.id }).from(hosts).where(eq(hosts.userId, opts.userId));
    const hostIds = allowed.map(h => h.id);
    if (hostIds.length === 0) return [];
    conds.push(sql`${tcpingStats.hostId} IN (${sql.join(hostIds.map(id => sql`${id}`), sql`, `)})`);
  }

  const bucketExpr = sql.raw(`("recordedAt" / ${bucketSec}) * ${bucketSec}`);

  const rows = await db
    .select({
      bucket: sql<number>`${bucketExpr}`,
      avgLatency: sql<number>`COALESCE(AVG(CASE WHEN ${tcpingStats.isTimeout} = 0 AND ${tcpingStats.latencyMs} IS NOT NULL THEN ${tcpingStats.latencyMs} END), 0)`,
      maxLatency: sql<number>`COALESCE(MAX(CASE WHEN ${tcpingStats.isTimeout} = 0 AND ${tcpingStats.latencyMs} IS NOT NULL THEN ${tcpingStats.latencyMs} END), 0)`,
      minLatency: sql<number>`COALESCE(MIN(CASE WHEN ${tcpingStats.isTimeout} = 0 AND ${tcpingStats.latencyMs} IS NOT NULL THEN ${tcpingStats.latencyMs} END), 0)`,
      timeoutCount: sql<number>`SUM(CASE WHEN ${tcpingStats.isTimeout} = 1 THEN 1 ELSE 0 END)`,
      totalCount: sql<number>`COUNT(*)`,
    })
    .from(tcpingStats)
    .where(and(...conds))
    .groupBy(bucketExpr)
    .orderBy(asc(bucketExpr));

  return rows.map((r) => ({
    bucket: new Date(Number(r.bucket) * 1000),
    avgLatency: Math.round(Number(r.avgLatency) || 0),
    maxLatency: Number(r.maxLatency) || 0,
    minLatency: Number(r.minLatency) || 0,
    timeoutCount: Number(r.timeoutCount) || 0,
    totalCount: Number(r.totalCount) || 0,
  }));
}

/** 清理过期的 TCPing 数据（保留最近 N 小时） */
export async function cleanOldTcpingStats(retainHours: number = 48) {
  const db = await getDb();
  if (!db) return;
  const cutoff = new Date(Date.now() - retainHours * 3600 * 1000);
  if (!_sqlite) return;
  const cutoffSec = Math.floor(cutoff.getTime() / 1000);
  _sqlite.prepare(`DELETE FROM tcping_stats WHERE recordedAt < ?`).run(cutoffSec);
}

export async function timeoutStaleForwardTests(ttlSeconds: number = 60): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const cutoff = new Date(Date.now() - ttlSeconds * 1000);
  // 用 SQL 直接 update，避免拉取后再写入的竞争
  if (!_sqlite) return 0;
  const cutoffSec = Math.floor(cutoff.getTime() / 1000);
  const stmt = _sqlite.prepare(
    `UPDATE forward_tests
     SET status = 'timeout',
         message = COALESCE(NULLIF(message, ''), '自测超时：Agent 未在' || ? || '秒内上报结果，请检查 Agent 是否在线或已升级到最新版本'),
         updatedAt = unixepoch()
     WHERE status IN ('pending', 'running')
       AND updatedAt < ?`
  );
  const info = stmt.run(ttlSeconds, cutoffSec);
  return info.changes || 0;
}
