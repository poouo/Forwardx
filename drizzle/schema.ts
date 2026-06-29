import fs from "fs";
import path from "path";
import { sql } from "drizzle-orm";
import {
  bigint as mysqlBigint,
  boolean as mysqlBoolean,
  customType,
  int as mysqlInt,
  mysqlTable,
  serial as mysqlSerial,
  text as mysqlText,
  varchar as mysqlVarchar,
} from "drizzle-orm/mysql-core";
import {
  integer as sqliteInteger,
  sqliteTable,
  text as sqliteText,
} from "drizzle-orm/sqlite-core";
import {
  bigint as pgBigint,
  bigserial as pgBigSerial,
  boolean as pgBoolean,
  customType as pgCustomType,
  integer as pgInteger,
  pgTable,
  text as pgText,
  varchar as pgVarchar,
} from "drizzle-orm/pg-core";

/**
 * MySQL schema for ForwardX.
 *
 * Notes:
 * - Time fields are stored as Unix epoch seconds to keep compatibility with the
 *   existing API shape. Drizzle maps them to JS Date values for application code.
 * - Booleans are mapped by mysql-core boolean() so app code stays clean.
 * - All `id` fields are auto-incrementing primary keys.
 */

export type DatabaseDialect = "mysql" | "sqlite" | "postgresql";

function readConfiguredDialect(): DatabaseDialect {
  const explicit = (process.env.DATABASE_TYPE || process.env.DB_TYPE || "").toLowerCase();
  if (explicit === "sqlite" || explicit === "mysql" || explicit === "postgresql" || explicit === "postgres" || explicit === "pg") {
    return explicit === "postgres" || explicit === "pg" ? "postgresql" : explicit;
  }
  const candidates = [
    process.env.DATABASE_CONFIG_PATH || "",
    process.env.DB_CONFIG_PATH || "",
    "/data/database.json",
    path.resolve(process.cwd(), "data", "database.json"),
  ].filter(Boolean);
  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) continue;
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      const type = String(parsed?.type || "").toLowerCase();
      if (type === "sqlite" || type === "mysql" || type === "postgresql" || type === "postgres" || type === "pg") {
        return type === "postgres" || type === "pg" ? "postgresql" : type;
      }
    } catch {
      // dbRuntime reports malformed config with a useful setup error.
    }
  }
  if (process.env.SQLITE_PATH && fs.existsSync(process.env.SQLITE_PATH)) return "sqlite";
  return "mysql";
}

export const SCHEMA_DIALECT: DatabaseDialect = readConfiguredDialect();
const isSqliteDialect = SCHEMA_DIALECT === "sqlite";
const isPostgresqlDialect = SCHEMA_DIALECT === "postgresql";

const table = (name: string, columns: any): any =>
  isSqliteDialect ? sqliteTable(name, columns) : isPostgresqlDialect ? pgTable(name, columns) : mysqlTable(name, columns);
const serial = (name: string): any =>
  isSqliteDialect
    ? sqliteInteger(name).primaryKey({ autoIncrement: true })
    : isPostgresqlDialect
      ? pgBigSerial(name, { mode: "number" }).primaryKey()
      : mysqlSerial(name);
const text = (name: string): any => (isSqliteDialect ? sqliteText(name) : isPostgresqlDialect ? pgText(name) : mysqlText(name));
const varchar = (name: string, config: { length: number }): any =>
  isSqliteDialect ? sqliteText(name) : isPostgresqlDialect ? pgVarchar(name, config) : mysqlVarchar(name, config);
const int = (name: string): any => (isSqliteDialect ? sqliteInteger(name) : isPostgresqlDialect ? pgInteger(name) : mysqlInt(name));
const boolean = (name: string): any =>
  isSqliteDialect ? sqliteInteger(name, { mode: "boolean" }) : isPostgresqlDialect ? pgBoolean(name) : mysqlBoolean(name);
const bigint = (name: string, config?: { mode?: "number" }): any =>
  isSqliteDialect ? sqliteInteger(name) : isPostgresqlDialect ? pgBigint(name, config as any) : mysqlBigint(name, config as any);
const nowDefault = () => (isSqliteDialect ? sql`(unixepoch())` : isPostgresqlDialect ? sql`(EXTRACT(EPOCH FROM NOW())::INT)` : sql`(UNIX_TIMESTAMP())`);

const mysqlEpoch = customType<{ data: Date; driverData: number | string | null }>({
  dataType() {
    return "int";
  },
  fromDriver(value) {
    if (value === null || value === undefined || value === "") return null as any;
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return null as any;
    return new Date(n * 1000);
  },
  toDriver(value) {
    if (!value) return null;
    return Math.floor(value.getTime() / 1000);
  },
});

const postgresEpoch = pgCustomType<{ data: Date; driverData: number | string | null }>({
  dataType() {
    return "int";
  },
  fromDriver(value) {
    if (value === null || value === undefined || value === "") return null as any;
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return null as any;
    return new Date(n * 1000);
  },
  toDriver(value) {
    if (!value) return null;
    return Math.floor(value.getTime() / 1000);
  },
});

const epoch = (name: string): any =>
  isSqliteDialect
    ? sqliteInteger(name, { mode: "timestamp" })
    : isPostgresqlDialect
      ? postgresEpoch(name)
    : mysqlEpoch(name);

export const users = table("users", {
  id: serial("id"),
  username: text("username").notNull().unique(),
  password: text("password").notNull(),
  name: text("name"),
  email: text("email"),
  emailVerified: boolean("emailVerified").notNull().default(false),
  emailVerifiedAt: epoch("emailVerifiedAt"),
  displayRemark: text("displayRemark"),
  avatar: text("avatar"),
  avatarChangeDay: varchar("avatarChangeDay", { length: 16 }),
  avatarChangeCount: int("avatarChangeCount").notNull().default(0),
  role: varchar("role", { length: 32 }).notNull().default("user"), // 'user' | 'admin'
  accountEnabled: boolean("accountEnabled").notNull().default(true),
  // ===== 权限控制 =====
  canAddRules: boolean("canAddRules").notNull().default(false), // 是否允许添加转发规则
  forwardAccessPauseReason: varchar("forwardAccessPauseReason", { length: 64 }),
  maxRules: int("maxRules").notNull().default(0),       // 最大规则条数，0 = 不限制
  maxPorts: int("maxPorts").notNull().default(0),       // 最大端口数，0 = 不限制（与 maxRules 相同概念，但可独立控制）
  // 允许使用的转发方式，逗号分隔，如 "iptables,realm,socat"；null 或空串 = 全部允许
  allowedForwardTypes: text("allowedForwardTypes"),
  allowForwardXTunnel: boolean("allowForwardXTunnel").notNull().default(false),
  gostRateLimitIn: int("gostRateLimitIn").notNull().default(0),
  gostRateLimitOut: int("gostRateLimitOut").notNull().default(0),
  maxConnections: int("maxConnections").notNull().default(0),
  maxIPs: int("maxIPs").notNull().default(0),
  manualCanAddRules: boolean("manualCanAddRules").notNull().default(false),
  manualMaxRules: int("manualMaxRules").notNull().default(0),
  manualMaxPorts: int("manualMaxPorts").notNull().default(0),
  manualMaxConnections: int("manualMaxConnections").notNull().default(0),
  manualMaxIPs: int("manualMaxIPs").notNull().default(0),
  manualAllowForwardXTunnel: boolean("manualAllowForwardXTunnel").notNull().default(false),
  manualGostRateLimitIn: int("manualGostRateLimitIn").notNull().default(0),
  manualGostRateLimitOut: int("manualGostRateLimitOut").notNull().default(0),
  manualTrafficLimit: bigint("manualTrafficLimit", { mode: "number" }).notNull().default(0),
  manualExpiresAt: epoch("manualExpiresAt"),
  balanceCents: bigint("balanceCents", { mode: "number" }).notNull().default(0),
  // ===== 流量管理字段 =====
  trafficLimit: bigint("trafficLimit", { mode: "number" }).notNull().default(0),           // 流量额度（字节），0 = 不限制
  trafficUsed: bigint("trafficUsed", { mode: "number" }).notNull().default(0),             // 已用流量（字节）
  expiresAt: epoch("expiresAt"),               // 到期时间，null = 永不过期
  trafficAutoReset: boolean("trafficAutoReset").notNull().default(false), // 月度自动重置开关
  trafficResetDay: int("trafficResetDay").notNull().default(1),     // 每月重置日（1-28）
  lastTrafficReset: epoch("lastTrafficReset"), // 上次重置时间
  telegramId: text("telegramId").unique(),
  telegramUsername: text("telegramUsername"),
  telegramFirstName: text("telegramFirstName"),
  telegramLastName: text("telegramLastName"),
  telegramLinkedAt: epoch("telegramLinkedAt"),
  telegramLastSeenAt: epoch("telegramLastSeenAt"),
  telegramAnnouncementSubscribed: boolean("telegramAnnouncementSubscribed").notNull().default(false),
  telegramBindCode: text("telegramBindCode").unique(),
  telegramBindCodeExpiresAt: epoch("telegramBindCodeExpiresAt"),
  telegramLoginCode: text("telegramLoginCode").unique(),
  telegramLoginCodeExpiresAt: epoch("telegramLoginCodeExpiresAt"),
  twoFactorEnabled: boolean("twoFactorEnabled").notNull().default(false),
  twoFactorSecret: text("twoFactorSecret"),
  twoFactorEnabledAt: epoch("twoFactorEnabledAt"),
  createdAt: epoch("createdAt").notNull().default(nowDefault()),
  updatedAt: epoch("updatedAt").notNull().default(nowDefault()),
  lastSignedIn: epoch("lastSignedIn").notNull().default(nowDefault()),
});
export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

export const hosts = table("hosts", {
  id: serial("id"),
  name: text("name").notNull(),
  ip: text("ip").notNull(),
  ipv4: text("ipv4"),
  ipv6: text("ipv6"),
  hostType: varchar("hostType", { length: 32 }).notNull().default("slave"), // 'master' | 'slave'
  agentToken: text("agentToken"),
  // 用户自定义的入口 IP/域名，为空时回退使用 ip
  entryIp: text("entryIp"),
  // 隧道链路使用的内网/专用入口地址（可选）
  tunnelEntryIp: text("tunnelEntryIp"),
  osInfo: text("osInfo"),
  cpuInfo: text("cpuInfo"),
  memoryTotal: bigint("memoryTotal", { mode: "number" }),
  agentVersion: text("agentVersion"),
  agentUpgradeRequested: boolean("agentUpgradeRequested").notNull().default(false),
  agentUpgradeTargetVersion: text("agentUpgradeTargetVersion"),
  agentUpgradeRequestedAt: epoch("agentUpgradeRequestedAt"),
  purchasedAt: epoch("purchasedAt"),
  stoppedAt: epoch("stoppedAt"),
  trafficLimit: bigint("trafficLimit", { mode: "number" }).notNull().default(0),
  trafficMeasureMode: varchar("trafficMeasureMode", { length: 16 }).notNull().default("both"),
  telegramTrafficAlertEnabled: boolean("telegramTrafficAlertEnabled").notNull().default(false),
  trafficAlertThresholdPercent: int("trafficAlertThresholdPercent").notNull().default(20),
  telegramRenewalReminderEnabled: boolean("telegramRenewalReminderEnabled").notNull().default(false),
  renewalReminderDays: int("renewalReminderDays").notNull().default(7),
  trafficAutoReset: boolean("trafficAutoReset").notNull().default(false),
  trafficResetDay: int("trafficResetDay").notNull().default(1),
  lastTrafficReset: epoch("lastTrafficReset"),
  ddnsEnabled: boolean("ddnsEnabled").notNull().default(false),
  ddnsDomain: text("ddnsDomain"),
  ddnsRecordType: varchar("ddnsRecordType", { length: 8 }).notNull().default("A"),
  ddnsIpVersion: varchar("ddnsIpVersion", { length: 8 }).notNull().default("ipv4"),
  lastDdnsValue: text("lastDdnsValue"),
  lastDdnsAt: epoch("lastDdnsAt"),
  lastDdnsError: text("lastDdnsError"),
  networkInterface: text("networkInterface"),
  sortOrder: int("sortOrder").notNull().default(0),
  geoCountryCode: varchar("geoCountryCode", { length: 8 }),
  geoCountryName: text("geoCountryName"),
  geoRegion: text("geoRegion"),
  geoEmoji: varchar("geoEmoji", { length: 16 }),
  geoLatitudeMicro: int("geoLatitudeMicro"),
  geoLongitudeMicro: int("geoLongitudeMicro"),
  geoUpdatedAt: epoch("geoUpdatedAt"),
  // ===== 端口区间限制 =====
  portRangeStart: int("portRangeStart"),  // 允许转发的起始端口，null = 不限制
  portRangeEnd: int("portRangeEnd"),      // 允许转发的结束端口，null = 不限制
  portAllowlist: text("portAllowlist"),    // 逗号分隔的额外允许端口
  blockHttp: boolean("blockHttp").notNull().default(false),
  blockSocks: boolean("blockSocks").notNull().default(false),
  blockTls: boolean("blockTls").notNull().default(false),
  isOnline: boolean("isOnline").notNull().default(false),
  lastHeartbeat: epoch("lastHeartbeat"),
  userId: int("userId").notNull(),
  createdAt: epoch("createdAt").notNull().default(nowDefault()),
  updatedAt: epoch("updatedAt").notNull().default(nowDefault()),
});
export type Host = typeof hosts.$inferSelect;
export type InsertHost = typeof hosts.$inferInsert;

export const forwardRules = table("forward_rules", {
  id: serial("id"),
  hostId: int("hostId").notNull(),
  name: text("name").notNull(),
  forwardType: varchar("forwardType", { length: 32 }).notNull().default("iptables"), // 'iptables' | 'realm' | 'socat'
  protocol: varchar("protocol", { length: 16 }).notNull().default("both"), // 'tcp' | 'udp' | 'both'
  gostMode: varchar("gostMode", { length: 32 }).notNull().default("direct"), // 'direct' | 'reverse'
  gostRelayHost: text("gostRelayHost"),
  gostRelayPort: int("gostRelayPort"),
  tunnelId: int("tunnelId"),
  tunnelExitPort: int("tunnelExitPort"),
  forwardGroupId: int("forwardGroupId"),
  forwardGroupRuleId: int("forwardGroupRuleId"),
  forwardGroupMemberId: int("forwardGroupMemberId"),
  isForwardGroupTemplate: boolean("isForwardGroupTemplate").notNull().default(false),
  sourcePort: int("sourcePort").notNull(),
  targetIp: text("targetIp").notNull(),
  targetPort: int("targetPort").notNull(),
  telegramErrorNotifyEnabled: boolean("telegramErrorNotifyEnabled").notNull().default(false),
  blockHttp: boolean("blockHttp").notNull().default(false),
  blockSocks: boolean("blockSocks").notNull().default(false),
  blockTls: boolean("blockTls").notNull().default(false),
  proxyProtocolReceive: boolean("proxyProtocolReceive").notNull().default(false),
  proxyProtocolSend: boolean("proxyProtocolSend").notNull().default(false),
  proxyProtocolExitReceive: boolean("proxyProtocolExitReceive").notNull().default(false),
  proxyProtocolExitSend: boolean("proxyProtocolExitSend").notNull().default(false),
  proxyProtocolVersion: int("proxyProtocolVersion").notNull().default(1),
  tcpFastOpen: boolean("tcpFastOpen").notNull().default(false),
  zeroCopy: boolean("zeroCopy").notNull().default(false),
  udpOverTcp: boolean("udpOverTcp").notNull().default(false),
  udpOverTcpPort: int("udpOverTcpPort"),
  protocolBlockReason: text("protocolBlockReason"),
  isEnabled: boolean("isEnabled").notNull().default(true),
  failoverEnabled: boolean("failoverEnabled").notNull().default(false),
  failoverStrategy: varchar("failoverStrategy", { length: 32 }).notNull().default("fallback"),
  failoverTargets: text("failoverTargets"),
  failoverSeconds: int("failoverSeconds").notNull().default(60),
  recoverSeconds: int("recoverSeconds").notNull().default(120),
  autoFailback: boolean("autoFailback").notNull().default(true),
  disabledByTunnel: boolean("disabledByTunnel").notNull().default(false),
  disabledByUser: boolean("disabledByUser").notNull().default(false),
  isRunning: boolean("isRunning").notNull().default(false),
  pendingDelete: boolean("pendingDelete").notNull().default(false),
  userId: int("userId").notNull(),
  createdAt: epoch("createdAt").notNull().default(nowDefault()),
  updatedAt: epoch("updatedAt").notNull().default(nowDefault()),
});
export type ForwardRule = typeof forwardRules.$inferSelect;
export type InsertForwardRule = typeof forwardRules.$inferInsert;

export const forwardGroups = table("forward_groups", {
  id: serial("id"),
  name: text("name").notNull(),
  remark: text("remark"),
  groupType: varchar("groupType", { length: 32 }).notNull().default("host"),
  groupMode: varchar("groupMode", { length: 32 }).notNull().default("failover"),
  entryGroupId: int("entryGroupId"),
  forwardType: varchar("forwardType", { length: 32 }).notNull().default("iptables"),
  domain: text("domain"),
  recordType: varchar("recordType", { length: 16 }).notNull().default("A"),
  sourcePort: int("sourcePort").notNull().default(1),
  protocol: varchar("protocol", { length: 16 }).notNull().default("both"),
  targetIp: text("targetIp").notNull(),
  targetPort: int("targetPort").notNull().default(1),
  failoverSeconds: int("failoverSeconds").notNull().default(60),
  recoverSeconds: int("recoverSeconds").notNull().default(120),
  chinaHealthCheckEnabled: boolean("chinaHealthCheckEnabled").notNull().default(false),
  chinaHealthCheckTarget: text("chinaHealthCheckTarget"),
  telegramSwitchNotifyEnabled: boolean("telegramSwitchNotifyEnabled").notNull().default(false),
  ddnsAutoResolveEnabled: boolean("ddnsAutoResolveEnabled").notNull().default(true),
  autoFailback: boolean("autoFailback").notNull().default(true),
  isEnabled: boolean("isEnabled").notNull().default(true),
  activeMemberId: int("activeMemberId"),
  lastDdnsValue: text("lastDdnsValue"),
  lastDdnsAt: epoch("lastDdnsAt"),
  lastFailoverAt: epoch("lastFailoverAt"),
  lastStatus: varchar("lastStatus", { length: 32 }).notNull().default("unknown"),
  lastMessage: text("lastMessage"),
  userId: int("userId").notNull(),
  createdAt: epoch("createdAt").notNull().default(nowDefault()),
  updatedAt: epoch("updatedAt").notNull().default(nowDefault()),
});
export type ForwardGroup = typeof forwardGroups.$inferSelect;
export type InsertForwardGroup = typeof forwardGroups.$inferInsert;

export const forwardGroupMembers = table("forward_group_members", {
  id: serial("id"),
  groupId: int("groupId").notNull(),
  memberType: varchar("memberType", { length: 32 }).notNull(),
  hostId: int("hostId"),
  tunnelId: int("tunnelId"),
  connectHost: text("connectHost"),
  priority: int("priority").notNull().default(0),
  ruleId: int("ruleId"),
  isEnabled: boolean("isEnabled").notNull().default(true),
  healthStatus: varchar("healthStatus", { length: 32 }).notNull().default("unknown"),
  lastLatencyMs: int("lastLatencyMs"),
  chinaHealthStatus: varchar("chinaHealthStatus", { length: 32 }).notNull().default("unknown"),
  chinaHealthLatencyMs: int("chinaHealthLatencyMs"),
  chinaHealthCheckedAt: epoch("chinaHealthCheckedAt"),
  failureSince: epoch("failureSince"),
  healthySince: epoch("healthySince"),
  lastCheckedAt: epoch("lastCheckedAt"),
  createdAt: epoch("createdAt").notNull().default(nowDefault()),
  updatedAt: epoch("updatedAt").notNull().default(nowDefault()),
});
export type ForwardGroupMember = typeof forwardGroupMembers.$inferSelect;
export type InsertForwardGroupMember = typeof forwardGroupMembers.$inferInsert;

export const forwardGroupEvents = table("forward_group_events", {
  id: serial("id"),
  groupId: int("groupId").notNull(),
  memberId: int("memberId"),
  type: varchar("type", { length: 32 }).notNull(),
  message: text("message"),
  createdAt: epoch("createdAt").notNull().default(nowDefault()),
});
export type ForwardGroupEvent = typeof forwardGroupEvents.$inferSelect;
export type InsertForwardGroupEvent = typeof forwardGroupEvents.$inferInsert;

// ===== gost 隧道配置（两台公网 Agent 组建链路） =====
export const tunnels = table("tunnels", {
  id: serial("id"),
  name: text("name").notNull(),
  entryGroupId: int("entryGroupId"),
  entryHostId: int("entryHostId").notNull(),
  exitHostId: int("exitHostId").notNull(),
  mode: varchar("mode", { length: 32 }).notNull().default("tls"), // forwardx | tls | wss | tcp | mtls | mwss | mtcp | nginx_stream
  certDomain: text("certDomain"),
  secret: text("secret"),
  listenPort: int("listenPort").notNull(),
  rateLimitMbps: int("rateLimitMbps").notNull().default(0),
  portRangeStart: int("portRangeStart"),
  portRangeEnd: int("portRangeEnd"),
  networkType: varchar("networkType", { length: 32 }).notNull().default("public"),
  connectHost: text("connectHost"),
  blockHttp: boolean("blockHttp").notNull().default(false),
  blockSocks: boolean("blockSocks").notNull().default(false),
  blockTls: boolean("blockTls").notNull().default(false),
  loadBalanceEnabled: boolean("loadBalanceEnabled").notNull().default(false),
  loadBalanceStrategy: varchar("loadBalanceStrategy", { length: 32 }).notNull().default("round_robin"),
  isEnabled: boolean("isEnabled").notNull().default(true),
  isRunning: boolean("isRunning").notNull().default(false),
  lastLatencyMs: int("lastLatencyMs"),
  lastTestStatus: text("lastTestStatus"),
  lastTestMessage: text("lastTestMessage"),
  lastTestAt: epoch("lastTestAt"),
  userId: int("userId").notNull(),
  createdAt: epoch("createdAt").notNull().default(nowDefault()),
  updatedAt: epoch("updatedAt").notNull().default(nowDefault()),
});
export type Tunnel = typeof tunnels.$inferSelect;
export type InsertTunnel = typeof tunnels.$inferInsert;

export const tunnelExitNodes = table("tunnel_exit_nodes", {
  id: serial("id"),
  tunnelId: int("tunnelId").notNull(),
  seq: int("seq").notNull(),
  hostId: int("hostId").notNull(),
  listenPort: int("listenPort").notNull(),
  connectHost: text("connectHost"),
  isEnabled: boolean("isEnabled").notNull().default(true),
  createdAt: epoch("createdAt").notNull().default(nowDefault()),
  updatedAt: epoch("updatedAt").notNull().default(nowDefault()),
});
export type TunnelExitNode = typeof tunnelExitNodes.$inferSelect;
export type InsertTunnelExitNode = typeof tunnelExitNodes.$inferInsert;

export const tunnelHops = table("tunnel_hops", {
  id: serial("id"),
  tunnelId: int("tunnelId").notNull(),
  seq: int("seq").notNull(),
  hostId: int("hostId").notNull(),
  listenPort: int("listenPort").notNull().default(0),
  connectHost: text("connectHost"),
});
export type TunnelHop = typeof tunnelHops.$inferSelect;
export type InsertTunnelHop = typeof tunnelHops.$inferInsert;

export const forwardRuleTunnelExits = table("forward_rule_tunnel_exits", {
  id: serial("id"),
  ruleId: int("ruleId").notNull(),
  tunnelId: int("tunnelId").notNull(),
  exitNodeId: int("exitNodeId").notNull(),
  exitSeq: int("exitSeq").notNull(),
  exitHostId: int("exitHostId").notNull(),
  tunnelExitPort: int("tunnelExitPort").notNull(),
  createdAt: epoch("createdAt").notNull().default(nowDefault()),
  updatedAt: epoch("updatedAt").notNull().default(nowDefault()),
});
export type ForwardRuleTunnelExit = typeof forwardRuleTunnelExits.$inferSelect;
export type InsertForwardRuleTunnelExit = typeof forwardRuleTunnelExits.$inferInsert;

export const hostMetrics = table("host_metrics", {
  id: serial("id"),
  hostId: int("hostId").notNull(),
  cpuUsage: int("cpuUsage"),
  memoryUsage: int("memoryUsage"),
  memoryUsed: bigint("memoryUsed", { mode: "number" }),
  swapUsage: int("swapUsage"),
  swapUsed: bigint("swapUsed", { mode: "number" }),
  swapTotal: bigint("swapTotal", { mode: "number" }),
  networkIn: bigint("networkIn", { mode: "number" }),
  networkOut: bigint("networkOut", { mode: "number" }),
  diskUsage: int("diskUsage"),
  diskUsed: bigint("diskUsed", { mode: "number" }),
  diskTotal: bigint("diskTotal", { mode: "number" }),
  uptime: bigint("uptime", { mode: "number" }),
  recordedAt: epoch("recordedAt").notNull().default(nowDefault()),
});
export type HostMetric = typeof hostMetrics.$inferSelect;
export type InsertHostMetric = typeof hostMetrics.$inferInsert;

export const hostTrafficCounters = table("host_traffic_counters", {
  id: serial("id"),
  hostId: int("hostId").notNull().unique(),
  bytesIn: bigint("bytesIn", { mode: "number" }).notNull().default(0),
  bytesOut: bigint("bytesOut", { mode: "number" }).notNull().default(0),
  lastSystemIn: bigint("lastSystemIn", { mode: "number" }),
  lastSystemOut: bigint("lastSystemOut", { mode: "number" }),
  lastDeltaIn: bigint("lastDeltaIn", { mode: "number" }).notNull().default(0),
  lastDeltaOut: bigint("lastDeltaOut", { mode: "number" }).notNull().default(0),
  lastReportedAt: epoch("lastReportedAt"),
  resetAt: epoch("resetAt"),
  createdAt: epoch("createdAt").notNull().default(nowDefault()),
  updatedAt: epoch("updatedAt").notNull().default(nowDefault()),
});
export type HostTrafficCounter = typeof hostTrafficCounters.$inferSelect;
export type InsertHostTrafficCounter = typeof hostTrafficCounters.$inferInsert;
export const trafficStats = table("traffic_stats", {
  id: serial("id"),
  ruleId: int("ruleId").notNull(),
  hostId: int("hostId").notNull(),
  bytesIn: bigint("bytesIn", { mode: "number" }).notNull().default(0),
  bytesOut: bigint("bytesOut", { mode: "number" }).notNull().default(0),
  connections: int("connections").notNull().default(0),
  recordedAt: epoch("recordedAt").notNull().default(nowDefault()),
});
export type TrafficStat = typeof trafficStats.$inferSelect;
export type InsertTrafficStat = typeof trafficStats.$inferInsert;

export const trafficStatBuckets = table("traffic_stat_buckets", {
  id: serial("id"),
  bucketStart: epoch("bucketStart").notNull(),
  bucketMinutes: int("bucketMinutes").notNull().default(30),
  userId: int("userId").notNull(),
  ruleId: int("ruleId").notNull(),
  hostId: int("hostId").notNull(),
  bytesIn: bigint("bytesIn", { mode: "number" }).notNull().default(0),
  bytesOut: bigint("bytesOut", { mode: "number" }).notNull().default(0),
  connections: int("connections").notNull().default(0),
  updatedAt: epoch("updatedAt").notNull().default(nowDefault()),
});
export type TrafficStatBucket = typeof trafficStatBuckets.$inferSelect;
export type InsertTrafficStatBucket = typeof trafficStatBuckets.$inferInsert;

export const tunnelLatencyStats = table("tunnel_latency_stats", {
  id: serial("id"),
  tunnelId: int("tunnelId").notNull(),
  seriesKey: varchar("seriesKey", { length: 64 }),
  seriesLabel: text("seriesLabel"),
  latencyMs: int("latencyMs"),
  isTimeout: boolean("isTimeout").notNull().default(false),
  recordedAt: epoch("recordedAt").notNull().default(nowDefault()),
});
export type TunnelLatencyStat = typeof tunnelLatencyStats.$inferSelect;
export type InsertTunnelLatencyStat = typeof tunnelLatencyStats.$inferInsert;

export const forwardGroupLatencyStats = table("forward_group_latency_stats", {
  id: serial("id"),
  groupId: int("groupId").notNull(),
  latencyMs: int("latencyMs"),
  isTimeout: boolean("isTimeout").notNull().default(false),
  recordedAt: epoch("recordedAt").notNull().default(nowDefault()),
});
export type ForwardGroupLatencyStat = typeof forwardGroupLatencyStats.$inferSelect;
export type InsertForwardGroupLatencyStat = typeof forwardGroupLatencyStats.$inferInsert;

export const hostProbeServices = table("host_probe_services", {
  id: serial("id"),
  name: text("name").notNull(),
  method: varchar("method", { length: 16 }).notNull().default("tcping"),
  targetIp: text("targetIp").notNull(),
  targetPort: int("targetPort"),
  hostScope: varchar("hostScope", { length: 16 }).notNull().default("all"),
  hostIds: text("hostIds"),
  excludeHostIds: text("excludeHostIds"),
  intervalSeconds: int("intervalSeconds").notNull().default(30),
  isEnabled: boolean("isEnabled").notNull().default(true),
  userId: int("userId").notNull(),
  createdAt: epoch("createdAt").notNull().default(nowDefault()),
  updatedAt: epoch("updatedAt").notNull().default(nowDefault()),
});
export type HostProbeService = typeof hostProbeServices.$inferSelect;
export type InsertHostProbeService = typeof hostProbeServices.$inferInsert;

export const hostProbeServiceStats = table("host_probe_service_stats", {
  id: serial("id"),
  serviceId: int("serviceId").notNull(),
  hostId: int("hostId").notNull(),
  latencyMs: int("latencyMs"),
  isTimeout: boolean("isTimeout").notNull().default(false),
  recordedAt: epoch("recordedAt").notNull().default(nowDefault()),
});
export type HostProbeServiceStat = typeof hostProbeServiceStats.$inferSelect;
export type InsertHostProbeServiceStat = typeof hostProbeServiceStats.$inferInsert;

export const ipGeoCache = table("ip_geo_cache", {
  id: serial("id"),
  address: varchar("address", { length: 253 }).notNull().unique(),
  resolvedAddress: varchar("resolvedAddress", { length: 64 }).notNull(),
  geoCountryCode: varchar("geoCountryCode", { length: 8 }).notNull(),
  geoCountryName: text("geoCountryName"),
  geoRegion: text("geoRegion"),
  geoEmoji: varchar("geoEmoji", { length: 16 }),
  geoLatitudeMicro: int("geoLatitudeMicro"),
  geoLongitudeMicro: int("geoLongitudeMicro"),
  provider: varchar("provider", { length: 32 }).notNull().default("ipapi.co"),
  fetchedAt: epoch("fetchedAt").notNull().default(nowDefault()),
  expiresAt: epoch("expiresAt").notNull(),
});
export type IpGeoCache = typeof ipGeoCache.$inferSelect;
export type InsertIpGeoCache = typeof ipGeoCache.$inferInsert;

export const agentTokens = table("agent_tokens", {
  id: serial("id"),
  token: text("token").notNull().unique(),
  hostId: int("hostId"),
  description: text("description"),
  isUsed: boolean("isUsed").notNull().default(false),
  userId: int("userId").notNull(),
  createdAt: epoch("createdAt").notNull().default(nowDefault()),
});
export type AgentToken = typeof agentTokens.$inferSelect;
export type InsertAgentToken = typeof agentTokens.$inferInsert;

export const forwardTests = table("forward_tests", {
  id: serial("id"),
  ruleId: int("ruleId").notNull(),
  hostId: int("hostId").notNull(),
  userId: int("userId").notNull(),
  status: varchar("status", { length: 32 }).notNull().default("pending"), // pending | running | success | failed | timeout
  listenOk: boolean("listenOk").notNull().default(false),
  targetReachable: boolean("targetReachable").notNull().default(false),
  forwardOk: boolean("forwardOk").notNull().default(false),
  latencyMs: int("latencyMs"),
  message: text("message"),
  createdAt: epoch("createdAt").notNull().default(nowDefault()),
  updatedAt: epoch("updatedAt").notNull().default(nowDefault()),
});
export type ForwardTest = typeof forwardTests.$inferSelect;
export type InsertForwardTest = typeof forwardTests.$inferInsert;

// ===== TCPing 延迟统计表 =====
export const tcpingStats = table("tcping_stats", {
  id: serial("id"),
  ruleId: int("ruleId").notNull(),
  hostId: int("hostId").notNull(),
  latencyMs: int("latencyMs"),           // 延迟毫秒数，null 表示超时/不可达
  isTimeout: boolean("isTimeout").notNull().default(false),
  recordedAt: epoch("recordedAt").notNull().default(nowDefault()),
});
export type TcpingStat = typeof tcpingStats.$inferSelect;
export type InsertTcpingStat = typeof tcpingStats.$inferInsert;

// ===== 系统设置表（键值存储） =====
export const systemSettings = table("system_settings", {
  key: varchar("key", { length: 191 }).primaryKey(),
  value: text("value"),
  updatedAt: epoch("updatedAt").notNull().default(nowDefault()),
});
export type SystemSetting = typeof systemSettings.$inferSelect;
export type InsertSystemSetting = typeof systemSettings.$inferInsert;

// ===== Payment orders =====
export const paymentOrders = table("payment_orders", {
  id: serial("id"),
  outTradeNo: text("outTradeNo").notNull().unique(),
  userId: int("userId").notNull(),
  provider: varchar("provider", { length: 32 }).notNull(), // easypay | alipay | wxpay | stripe
  paymentType: varchar("paymentType", { length: 32 }).notNull(), // alipay | wxpay | stripe
  status: varchar("status", { length: 32 }).notNull().default("pending"), // pending | paid | completed | expired | cancelled | failed
  subject: text("subject").notNull(),
  amountCents: bigint("amountCents", { mode: "number" }).notNull(),
  currency: varchar("currency", { length: 16 }).notNull().default("CNY"),
  tradeNo: text("tradeNo"),
  payUrl: text("payUrl"),
  qrCode: text("qrCode"),
  orderType: varchar("orderType", { length: 32 }).notNull().default("balance"), // balance | plan | test
  planId: int("planId"),
  subscriptionId: int("subscriptionId"),
  discountCodeId: int("discountCodeId"),
  discountAmountCents: bigint("discountAmountCents", { mode: "number" }).notNull().default(0),
  clientIp: text("clientIp"),
  rawNotify: text("rawNotify"),
  expiresAt: epoch("expiresAt"),
  paidAt: epoch("paidAt"),
  createdAt: epoch("createdAt").notNull().default(nowDefault()),
  updatedAt: epoch("updatedAt").notNull().default(nowDefault()),
});
export type PaymentOrder = typeof paymentOrders.$inferSelect;
export type InsertPaymentOrder = typeof paymentOrders.$inferInsert;

// ===== Subscription plans =====
export const subscriptionPlans = table("subscription_plans", {
  id: serial("id"),
  name: text("name").notNull(),
  description: text("description"),
  priceCents: bigint("priceCents", { mode: "number" }).notNull().default(0),
  currency: varchar("currency", { length: 16 }).notNull().default("CNY"),
  durationDays: int("durationDays").notNull().default(30),
  portCount: int("portCount").notNull().default(20),
  trafficLimit: bigint("trafficLimit", { mode: "number" }).notNull().default(0),
  rateLimitMbps: int("rateLimitMbps").notNull().default(0),
  maxRules: int("maxRules").notNull().default(20),
  maxConnections: int("maxConnections").notNull().default(2000),
  maxIPs: int("maxIPs").notNull().default(10),
  isActive: boolean("isActive").notNull().default(true),
  isStoreVisible: boolean("isStoreVisible").notNull().default(true),
  sortOrder: int("sortOrder").notNull().default(0),
  createdAt: epoch("createdAt").notNull().default(nowDefault()),
  updatedAt: epoch("updatedAt").notNull().default(nowDefault()),
});
export type SubscriptionPlan = typeof subscriptionPlans.$inferSelect;
export type InsertSubscriptionPlan = typeof subscriptionPlans.$inferInsert;

export const subscriptionPlanHosts = table("subscription_plan_hosts", {
  id: serial("id"),
  planId: int("planId").notNull(),
  hostId: int("hostId").notNull(),
  createdAt: epoch("createdAt").notNull().default(nowDefault()),
});
export type SubscriptionPlanHost = typeof subscriptionPlanHosts.$inferSelect;
export type InsertSubscriptionPlanHost = typeof subscriptionPlanHosts.$inferInsert;

export const subscriptionPlanTunnels = table("subscription_plan_tunnels", {
  id: serial("id"),
  planId: int("planId").notNull(),
  tunnelId: int("tunnelId").notNull(),
  createdAt: epoch("createdAt").notNull().default(nowDefault()),
});
export type SubscriptionPlanTunnel = typeof subscriptionPlanTunnels.$inferSelect;
export type InsertSubscriptionPlanTunnel = typeof subscriptionPlanTunnels.$inferInsert;

export const subscriptionPlanForwardGroups = table("subscription_plan_forward_groups", {
  id: serial("id"),
  planId: int("planId").notNull(),
  forwardGroupId: int("forwardGroupId").notNull(),
  createdAt: epoch("createdAt").notNull().default(nowDefault()),
});
export type SubscriptionPlanForwardGroup = typeof subscriptionPlanForwardGroups.$inferSelect;
export type InsertSubscriptionPlanForwardGroup = typeof subscriptionPlanForwardGroups.$inferInsert;

export const subscriptionPlanTrafficAddons = table("subscription_plan_traffic_addons", {
  id: serial("id"),
  planId: int("planId").notNull(),
  trafficBytes: bigint("trafficBytes", { mode: "number" }).notNull().default(0),
  priceCents: bigint("priceCents", { mode: "number" }).notNull().default(0),
  isActive: boolean("isActive").notNull().default(true),
  sortOrder: int("sortOrder").notNull().default(0),
  createdAt: epoch("createdAt").notNull().default(nowDefault()),
  updatedAt: epoch("updatedAt").notNull().default(nowDefault()),
});
export type SubscriptionPlanTrafficAddon = typeof subscriptionPlanTrafficAddons.$inferSelect;
export type InsertSubscriptionPlanTrafficAddon = typeof subscriptionPlanTrafficAddons.$inferInsert;

export const userSubscriptions = table("user_subscriptions", {
  id: serial("id"),
  userId: int("userId").notNull(),
  planId: int("planId").notNull(),
  status: varchar("status", { length: 32 }).notNull().default("active"), // active | expired | cancelled
  source: varchar("source", { length: 32 }).notNull().default("admin"), // admin | payment
  paymentOrderNo: text("paymentOrderNo"),
  planSnapshot: text("planSnapshot"),
  portRangeStart: int("portRangeStart"),
  portRangeEnd: int("portRangeEnd"),
  nextTrafficResetAt: epoch("nextTrafficResetAt"),
  lastTrafficResetAt: epoch("lastTrafficResetAt"),
  startedAt: epoch("startedAt").notNull().default(nowDefault()),
  expiresAt: epoch("expiresAt"),
  createdAt: epoch("createdAt").notNull().default(nowDefault()),
  updatedAt: epoch("updatedAt").notNull().default(nowDefault()),
});
export type UserSubscription = typeof userSubscriptions.$inferSelect;
export type InsertUserSubscription = typeof userSubscriptions.$inferInsert;

export const userTrafficAddons = table("user_traffic_addons", {
  id: serial("id"),
  userId: int("userId").notNull(),
  subscriptionId: int("subscriptionId").notNull(),
  planId: int("planId").notNull(),
  addonId: int("addonId"),
  trafficBytes: bigint("trafficBytes", { mode: "number" }).notNull().default(0),
  priceCents: bigint("priceCents", { mode: "number" }).notNull().default(0),
  source: varchar("source", { length: 32 }).notNull().default("user"), // user | admin
  status: varchar("status", { length: 32 }).notNull().default("active"), // active | expired
  operatorUserId: int("operatorUserId"),
  description: text("description"),
  cycleResetAt: epoch("cycleResetAt"),
  expiresAt: epoch("expiresAt"),
  expiredAt: epoch("expiredAt"),
  createdAt: epoch("createdAt").notNull().default(nowDefault()),
  updatedAt: epoch("updatedAt").notNull().default(nowDefault()),
});
export type UserTrafficAddon = typeof userTrafficAddons.$inferSelect;
export type InsertUserTrafficAddon = typeof userTrafficAddons.$inferInsert;

export const balanceTransactions = table("balance_transactions", {
  id: serial("id"),
  userId: int("userId").notNull(),
  type: varchar("type", { length: 32 }).notNull(), // admin_recharge | admin_adjust | payment | purchase | redeem | traffic_addon_purchase
  amountCents: bigint("amountCents", { mode: "number" }).notNull(),
  balanceAfterCents: bigint("balanceAfterCents", { mode: "number" }).notNull(),
  description: text("description"),
  operatorUserId: int("operatorUserId"),
  paymentOrderNo: text("paymentOrderNo"),
  redemptionCodeId: int("redemptionCodeId"),
  createdAt: epoch("createdAt").notNull().default(nowDefault()),
});
export type BalanceTransaction = typeof balanceTransactions.$inferSelect;
export type InsertBalanceTransaction = typeof balanceTransactions.$inferInsert;

export const trafficBillingConfigs = table("traffic_billing_configs", {
  id: serial("id"),
  resourceType: varchar("resourceType", { length: 16 }).notNull(), // host | tunnel
  resourceId: int("resourceId").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  requiresPermission: boolean("requiresPermission").notNull().default(false),
  description: text("description"),
  pricePerGbCents: bigint("pricePerGbCents", { mode: "number" }).notNull().default(0),
  pricePerGbMilliCents: bigint("pricePerGbMilliCents", { mode: "number" }).notNull().default(0),
  multiplier: int("multiplier").notNull().default(100), // 0.01x = 1, 1x = 100, 30x = 3000
  createdAt: epoch("createdAt").notNull().default(nowDefault()),
  updatedAt: epoch("updatedAt").notNull().default(nowDefault()),
});
export type TrafficBillingConfig = typeof trafficBillingConfigs.$inferSelect;
export type InsertTrafficBillingConfig = typeof trafficBillingConfigs.$inferInsert;

export const trafficBillingRecords = table("traffic_billing_records", {
  id: serial("id"),
  userId: int("userId").notNull(),
  ruleId: int("ruleId").notNull(),
  resourceType: varchar("resourceType", { length: 16 }).notNull(),
  resourceId: int("resourceId").notNull(),
  bytes: bigint("bytes", { mode: "number" }).notNull().default(0),
  billedGb: int("billedGb").notNull().default(0),
  pricePerGbCents: bigint("pricePerGbCents", { mode: "number" }).notNull().default(0),
  pricePerGbMilliCents: bigint("pricePerGbMilliCents", { mode: "number" }).notNull().default(0),
  multiplier: int("multiplier").notNull().default(100),
  amountCents: bigint("amountCents", { mode: "number" }).notNull().default(0),
  balanceAfterCents: bigint("balanceAfterCents", { mode: "number" }).notNull().default(0),
  createdAt: epoch("createdAt").notNull().default(nowDefault()),
});
export type TrafficBillingRecord = typeof trafficBillingRecords.$inferSelect;
export type InsertTrafficBillingRecord = typeof trafficBillingRecords.$inferInsert;

export const trafficBillingUsage = table("traffic_billing_usage", {
  id: serial("id"),
  userId: int("userId").notNull(),
  resourceType: varchar("resourceType", { length: 16 }).notNull(),
  resourceId: int("resourceId").notNull(),
  totalBytes: bigint("totalBytes", { mode: "number" }).notNull().default(0),
  billedGb: int("billedGb").notNull().default(0),
  pendingMilliCents: bigint("pendingMilliCents", { mode: "number" }).notNull().default(0),
  updatedAt: epoch("updatedAt").notNull().default(nowDefault()),
});
export type TrafficBillingUsage = typeof trafficBillingUsage.$inferSelect;
export type InsertTrafficBillingUsage = typeof trafficBillingUsage.$inferInsert;

export const trafficBillingRuleUsage = table("traffic_billing_rule_usage", {
  id: serial("id"),
  userId: int("userId").notNull(),
  ruleId: int("ruleId").notNull(),
  resourceType: varchar("resourceType", { length: 16 }).notNull(),
  resourceId: int("resourceId").notNull(),
  totalBytes: bigint("totalBytes", { mode: "number" }).notNull().default(0),
  billedGb: int("billedGb").notNull().default(0),
  pendingMilliCents: bigint("pendingMilliCents", { mode: "number" }).notNull().default(0),
  settled: boolean("settled").notNull().default(false),
  updatedAt: epoch("updatedAt").notNull().default(nowDefault()),
});
export type TrafficBillingRuleUsage = typeof trafficBillingRuleUsage.$inferSelect;
export type InsertTrafficBillingRuleUsage = typeof trafficBillingRuleUsage.$inferInsert;

export const userTrafficBillingPermissions = table("user_traffic_billing_permissions", {
  id: serial("id"),
  userId: int("userId").notNull(),
  resourceType: varchar("resourceType", { length: 16 }).notNull(),
  resourceId: int("resourceId").notNull(),
  createdAt: epoch("createdAt").notNull().default(nowDefault()),
});
export type UserTrafficBillingPermission = typeof userTrafficBillingPermissions.$inferSelect;
export type InsertUserTrafficBillingPermission = typeof userTrafficBillingPermissions.$inferInsert;

export const redemptionCodes = table("redemption_codes", {
  id: serial("id"),
  code: text("code").notNull().unique(),
  type: varchar("type", { length: 32 }).notNull(), // plan | balance
  planId: int("planId"),
  durationDays: int("durationDays"),
  amountCents: bigint("amountCents", { mode: "number" }).notNull().default(0),
  startsAt: epoch("startsAt"),
  expiresAt: epoch("expiresAt"),
  isActive: boolean("isActive").notNull().default(true),
  usedByUserId: int("usedByUserId"),
  usedAt: epoch("usedAt"),
  createdByUserId: int("createdByUserId"),
  createdAt: epoch("createdAt").notNull().default(nowDefault()),
  updatedAt: epoch("updatedAt").notNull().default(nowDefault()),
});
export type RedemptionCode = typeof redemptionCodes.$inferSelect;
export type InsertRedemptionCode = typeof redemptionCodes.$inferInsert;

export const discountCodes = table("discount_codes", {
  id: serial("id"),
  code: text("code").notNull().unique(),
  discountType: varchar("discountType", { length: 32 }).notNull(), // percent | amount
  discountValue: int("discountValue").notNull(),
  maxUses: int("maxUses").notNull().default(0),
  usedCount: int("usedCount").notNull().default(0),
  startsAt: epoch("startsAt"),
  expiresAt: epoch("expiresAt"),
  isActive: boolean("isActive").notNull().default(true),
  createdByUserId: int("createdByUserId"),
  createdAt: epoch("createdAt").notNull().default(nowDefault()),
  updatedAt: epoch("updatedAt").notNull().default(nowDefault()),
});
export type DiscountCode = typeof discountCodes.$inferSelect;
export type InsertDiscountCode = typeof discountCodes.$inferInsert;

export const discountCodePlans = table("discount_code_plans", {
  id: serial("id"),
  discountCodeId: int("discountCodeId").notNull(),
  planId: int("planId").notNull(),
  createdAt: epoch("createdAt").notNull().default(nowDefault()),
});
export type DiscountCodePlan = typeof discountCodePlans.$inferSelect;
export type InsertDiscountCodePlan = typeof discountCodePlans.$inferInsert;

export const announcements = table("announcements", {
  id: serial("id"),
  title: text("title").notNull(),
  content: text("content").notNull(),
  type: varchar("type", { length: 32 }).notNull().default("normal"), // normal | popup
  isActive: boolean("isActive").notNull().default(true),
  startsAt: epoch("startsAt"),
  expiresAt: epoch("expiresAt"),
  createdByUserId: int("createdByUserId"),
  createdAt: epoch("createdAt").notNull().default(nowDefault()),
  updatedAt: epoch("updatedAt").notNull().default(nowDefault()),
});
export type Announcement = typeof announcements.$inferSelect;
export type InsertAnnouncement = typeof announcements.$inferInsert;

export const announcementReads = table("announcement_reads", {
  id: serial("id"),
  announcementId: int("announcementId").notNull(),
  userId: int("userId").notNull(),
  dismissedAt: epoch("dismissedAt").notNull().default(nowDefault()),
});
export type AnnouncementRead = typeof announcementReads.$inferSelect;
export type InsertAnnouncementRead = typeof announcementReads.$inferInsert;

// ===== 用户-主机权限表（管理员指定用户可使用哪些 Agent/主机） =====
export const userHostPermissions = table("user_host_permissions", {
  id: serial("id"),
  userId: int("userId").notNull(),
  hostId: int("hostId").notNull(),
  createdAt: epoch("createdAt").notNull().default(nowDefault()),
});
export type UserHostPermission = typeof userHostPermissions.$inferSelect;
export type InsertUserHostPermission = typeof userHostPermissions.$inferInsert;

export const userTunnelPermissions = table("user_tunnel_permissions", {
  id: serial("id"),
  userId: int("userId").notNull(),
  tunnelId: int("tunnelId").notNull(),
  createdAt: epoch("createdAt").notNull().default(nowDefault()),
});
export type UserTunnelPermission = typeof userTunnelPermissions.$inferSelect;
export type InsertUserTunnelPermission = typeof userTunnelPermissions.$inferInsert;
