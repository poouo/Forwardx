import { sql } from "drizzle-orm";
import { sqliteTable, integer, text } from "drizzle-orm/sqlite-core";

/**
 * SQLite schema for ForwardX.
 *
 * Notes:
 * - Time fields stored as Unix epoch seconds (integer) to avoid TZ ambiguity.
 *   Drizzle can map them to JS Date via { mode: "timestamp" }, in seconds.
 * - Booleans stored as integer 0/1 via { mode: "boolean" } so app code stays clean.
 * - Enum-like columns are stored as plain text plus an explicit CHECK constraint
 *   maintained in initDatabase() (sqlite-core has no enum helper).
 * - All `id` fields are auto-incrementing primary keys.
 */

export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  username: text("username").notNull().unique(),
  password: text("password").notNull(),
  name: text("name"),
  email: text("email"),
  role: text("role").notNull().default("user"), // 'user' | 'admin'
  // ===== 权限控制 =====
  canAddRules: integer("canAddRules", { mode: "boolean" }).notNull().default(false), // 是否允许添加转发规则
  // ===== 流量管理字段 =====
  trafficLimit: integer("trafficLimit").notNull().default(0),           // 流量额度（字节），0 = 不限制
  trafficUsed: integer("trafficUsed").notNull().default(0),             // 已用流量（字节）
  expiresAt: integer("expiresAt", { mode: "timestamp" }),               // 到期时间，null = 永不过期
  trafficAutoReset: integer("trafficAutoReset", { mode: "boolean" }).notNull().default(false), // 月度自动重置开关
  trafficResetDay: integer("trafficResetDay").notNull().default(1),     // 每月重置日（1-28）
  lastTrafficReset: integer("lastTrafficReset", { mode: "timestamp" }), // 上次重置时间
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  lastSignedIn: integer("lastSignedIn", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
});
export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

export const hosts = sqliteTable("hosts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  ip: text("ip").notNull(),
  port: integer("port").default(22),
  hostType: text("hostType").notNull().default("slave"), // 'master' | 'slave'
  connectionType: text("connectionType").notNull().default("agent"), // 'ssh' | 'agent'
  sshUser: text("sshUser"),
  sshPassword: text("sshPassword"),
  sshKeyContent: text("sshKeyContent"),
  agentToken: text("agentToken"),
  osInfo: text("osInfo"),
  cpuInfo: text("cpuInfo"),
  memoryTotal: integer("memoryTotal"),
  networkInterface: text("networkInterface"),
  // ===== 端口区间限制 =====
  portRangeStart: integer("portRangeStart"),  // 允许转发的起始端口，null = 不限制
  portRangeEnd: integer("portRangeEnd"),      // 允许转发的结束端口，null = 不限制
  isOnline: integer("isOnline", { mode: "boolean" }).notNull().default(false),
  lastHeartbeat: integer("lastHeartbeat", { mode: "timestamp" }),
  userId: integer("userId").notNull(),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
});
export type Host = typeof hosts.$inferSelect;
export type InsertHost = typeof hosts.$inferInsert;

export const forwardRules = sqliteTable("forward_rules", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  hostId: integer("hostId").notNull(),
  name: text("name").notNull(),
  forwardType: text("forwardType").notNull().default("iptables"), // 'iptables' | 'realm' | 'socat'
  protocol: text("protocol").notNull().default("tcp"), // 'tcp' | 'udp' | 'both'
  sourcePort: integer("sourcePort").notNull(),
  targetIp: text("targetIp").notNull(),
  targetPort: integer("targetPort").notNull(),
  isEnabled: integer("isEnabled", { mode: "boolean" }).notNull().default(true),
  isRunning: integer("isRunning", { mode: "boolean" }).notNull().default(false),
  userId: integer("userId").notNull(),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
});
export type ForwardRule = typeof forwardRules.$inferSelect;
export type InsertForwardRule = typeof forwardRules.$inferInsert;

export const hostMetrics = sqliteTable("host_metrics", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  hostId: integer("hostId").notNull(),
  cpuUsage: integer("cpuUsage"),
  memoryUsage: integer("memoryUsage"),
  memoryUsed: integer("memoryUsed"),
  networkIn: integer("networkIn"),
  networkOut: integer("networkOut"),
  diskUsage: integer("diskUsage"),
  uptime: integer("uptime"),
  recordedAt: integer("recordedAt", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
});
export type HostMetric = typeof hostMetrics.$inferSelect;
export type InsertHostMetric = typeof hostMetrics.$inferInsert;

export const trafficStats = sqliteTable("traffic_stats", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ruleId: integer("ruleId").notNull(),
  hostId: integer("hostId").notNull(),
  bytesIn: integer("bytesIn").notNull().default(0),
  bytesOut: integer("bytesOut").notNull().default(0),
  connections: integer("connections").notNull().default(0),
  recordedAt: integer("recordedAt", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
});
export type TrafficStat = typeof trafficStats.$inferSelect;
export type InsertTrafficStat = typeof trafficStats.$inferInsert;

export const agentTokens = sqliteTable("agent_tokens", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  token: text("token").notNull().unique(),
  hostId: integer("hostId"),
  description: text("description"),
  isUsed: integer("isUsed", { mode: "boolean" }).notNull().default(false),
  userId: integer("userId").notNull(),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
});
export type AgentToken = typeof agentTokens.$inferSelect;
export type InsertAgentToken = typeof agentTokens.$inferInsert;

export const forwardTests = sqliteTable("forward_tests", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ruleId: integer("ruleId").notNull(),
  hostId: integer("hostId").notNull(),
  userId: integer("userId").notNull(),
  status: text("status").notNull().default("pending"), // pending | running | success | failed | timeout
  listenOk: integer("listenOk", { mode: "boolean" }).notNull().default(false),
  targetReachable: integer("targetReachable", { mode: "boolean" }).notNull().default(false),
  forwardOk: integer("forwardOk", { mode: "boolean" }).notNull().default(false),
  latencyMs: integer("latencyMs"),
  message: text("message"),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
});
export type ForwardTest = typeof forwardTests.$inferSelect;
export type InsertForwardTest = typeof forwardTests.$inferInsert;
