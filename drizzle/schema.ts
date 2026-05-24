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

/**
 * MySQL schema for ForwardX.
 *
 * Notes:
 * - Time fields are stored as Unix epoch seconds to keep compatibility with the
 *   existing API shape. Drizzle maps them to JS Date values for application code.
 * - Booleans are mapped by mysql-core boolean() so app code stays clean.
 * - All `id` fields are auto-incrementing primary keys.
 */

export type DatabaseDialect = "mysql" | "sqlite";

function readConfiguredDialect(): DatabaseDialect {
  const explicit = (process.env.DATABASE_TYPE || process.env.DB_TYPE || "").toLowerCase();
  if (explicit === "sqlite" || explicit === "mysql") return explicit;
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
      if (type === "sqlite" || type === "mysql") return type;
    } catch {
      // dbRuntime reports malformed config with a useful setup error.
    }
  }
  if (process.env.SQLITE_PATH && fs.existsSync(process.env.SQLITE_PATH)) return "sqlite";
  return "mysql";
}

export const SCHEMA_DIALECT: DatabaseDialect = readConfiguredDialect();
const isSqliteDialect = SCHEMA_DIALECT === "sqlite";

const table = (name: string, columns: any): any =>
  isSqliteDialect ? sqliteTable(name, columns) : mysqlTable(name, columns);
const serial = (name: string): any =>
  isSqliteDialect ? sqliteInteger(name).primaryKey({ autoIncrement: true }) : mysqlSerial(name);
const text = (name: string): any => (isSqliteDialect ? sqliteText(name) : mysqlText(name));
const varchar = (name: string, config: { length: number }): any =>
  isSqliteDialect ? sqliteText(name) : mysqlVarchar(name, config);
const int = (name: string): any => (isSqliteDialect ? sqliteInteger(name) : mysqlInt(name));
const boolean = (name: string): any =>
  isSqliteDialect ? sqliteInteger(name, { mode: "boolean" }) : mysqlBoolean(name);
const bigint = (name: string, config?: { mode?: "number" }): any =>
  isSqliteDialect ? sqliteInteger(name) : mysqlBigint(name, config as any);
const nowDefault = () => (isSqliteDialect ? sql`(unixepoch())` : sql`(UNIX_TIMESTAMP())`);

const mysqlEpoch = customType<{ data: Date; driverData: number | string | null }>({
  dataType() {
    return "int";
  },
  fromDriver(value) {
    const n = Number(value || 0);
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
  role: varchar("role", { length: 32 }).notNull().default("user"), // 'user' | 'admin'
  // ===== 鏉冮檺鎺у埗 =====
  canAddRules: boolean("canAddRules").notNull().default(false), // 鏄惁鍏佽娣诲姞杞彂瑙勫垯
  maxRules: int("maxRules").notNull().default(0),       // 鏈€澶ц鍒欐潯鏁帮紝0 = 涓嶉檺鍒?
  maxPorts: int("maxPorts").notNull().default(0),       // 鏈€澶х鍙ｆ暟锛? = 涓嶉檺鍒讹紙涓?maxRules 鐩稿悓姒傚康锛屼絾鍙嫭绔嬫帶鍒讹級
  // 鍏佽浣跨敤鐨勮浆鍙戞柟寮忥紝閫楀彿鍒嗛殧锛?iptables,realm,socat"锛沶ull 鎴栫┖涓?= 鍏ㄩ儴鍏佽
  allowedForwardTypes: text("allowedForwardTypes"),
  allowForwardXTunnel: boolean("allowForwardXTunnel").notNull().default(false),
  gostRateLimitIn: int("gostRateLimitIn").notNull().default(0),
  gostRateLimitOut: int("gostRateLimitOut").notNull().default(0),
  maxConnections: int("maxConnections").notNull().default(0),
  maxIPs: int("maxIPs").notNull().default(0),
  balanceCents: bigint("balanceCents", { mode: "number" }).notNull().default(0),
  // ===== 娴侀噺绠＄悊瀛楁 =====
  trafficLimit: bigint("trafficLimit", { mode: "number" }).notNull().default(0),           // 娴侀噺棰濆害锛堝瓧鑺傦級锛? = 涓嶉檺鍒?
  trafficUsed: bigint("trafficUsed", { mode: "number" }).notNull().default(0),             // 宸茬敤娴侀噺锛堝瓧鑺傦級
  expiresAt: epoch("expiresAt"),               // 鍒版湡鏃堕棿锛宯ull = 姘镐笉杩囨湡
  trafficAutoReset: boolean("trafficAutoReset").notNull().default(false), // 鏈堝害鑷姩閲嶇疆寮€鍏?
  trafficResetDay: int("trafficResetDay").notNull().default(1),     // 姣忔湀閲嶇疆鏃ワ紙1-28锛?
  lastTrafficReset: epoch("lastTrafficReset"), // 涓婃閲嶇疆鏃堕棿
  telegramId: text("telegramId").unique(),
  telegramUsername: text("telegramUsername"),
  telegramFirstName: text("telegramFirstName"),
  telegramLastName: text("telegramLastName"),
  telegramLinkedAt: epoch("telegramLinkedAt"),
  telegramLastSeenAt: epoch("telegramLastSeenAt"),
  telegramBindCode: text("telegramBindCode").unique(),
  telegramBindCodeExpiresAt: epoch("telegramBindCodeExpiresAt"),
  telegramLoginCode: text("telegramLoginCode").unique(),
  telegramLoginCodeExpiresAt: epoch("telegramLoginCodeExpiresAt"),
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
  // 鐢ㄦ埛鑷畾涔夌殑鍏ュ彛 IP/鍩熷悕锛屼负绌烘椂鍥為€€浣跨敤 ip
  entryIp: text("entryIp"),
  osInfo: text("osInfo"),
  cpuInfo: text("cpuInfo"),
  memoryTotal: bigint("memoryTotal", { mode: "number" }),
  agentVersion: text("agentVersion"),
  agentUpgradeRequested: boolean("agentUpgradeRequested").notNull().default(false),
  agentUpgradeTargetVersion: text("agentUpgradeTargetVersion"),
  agentUpgradeRequestedAt: epoch("agentUpgradeRequestedAt"),
  networkInterface: text("networkInterface"),
  // ===== 绔彛鍖洪棿闄愬埗 =====
  portRangeStart: int("portRangeStart"),  // 鍏佽杞彂鐨勮捣濮嬬鍙ｏ紝null = 涓嶉檺鍒?
  portRangeEnd: int("portRangeEnd"),      // 鍏佽杞彂鐨勭粨鏉熺鍙ｏ紝null = 涓嶉檺鍒?
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
  sourcePort: int("sourcePort").notNull(),
  targetIp: text("targetIp").notNull(),
  targetPort: int("targetPort").notNull(),
  protocolBlockReason: text("protocolBlockReason"),
  isEnabled: boolean("isEnabled").notNull().default(true),
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

// ===== gost 闅ч亾閰嶇疆锛堜袱鍙板叕缃?Agent 缁勫缓閾捐矾锛?=====
export const tunnels = table("tunnels", {
  id: serial("id"),
  name: text("name").notNull(),
  entryHostId: int("entryHostId").notNull(),
  exitHostId: int("exitHostId").notNull(),
  mode: varchar("mode", { length: 32 }).notNull().default("tls"), // tls | wss | tcp | mtls | mwss | mtcp
  secret: text("secret"),
  listenPort: int("listenPort").notNull(),
  portRangeStart: int("portRangeStart"),
  portRangeEnd: int("portRangeEnd"),
  blockHttp: boolean("blockHttp").notNull().default(false),
  blockSocks: boolean("blockSocks").notNull().default(false),
  blockTls: boolean("blockTls").notNull().default(false),
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

export const hostMetrics = table("host_metrics", {
  id: serial("id"),
  hostId: int("hostId").notNull(),
  cpuUsage: int("cpuUsage"),
  memoryUsage: int("memoryUsage"),
  memoryUsed: bigint("memoryUsed", { mode: "number" }),
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

export const tunnelLatencyStats = table("tunnel_latency_stats", {
  id: serial("id"),
  tunnelId: int("tunnelId").notNull(),
  latencyMs: int("latencyMs"),
  isTimeout: boolean("isTimeout").notNull().default(false),
  recordedAt: epoch("recordedAt").notNull().default(nowDefault()),
});
export type TunnelLatencyStat = typeof tunnelLatencyStats.$inferSelect;
export type InsertTunnelLatencyStat = typeof tunnelLatencyStats.$inferInsert;

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

// ===== TCPing 寤惰繜缁熻琛?=====
export const tcpingStats = table("tcping_stats", {
  id: serial("id"),
  ruleId: int("ruleId").notNull(),
  hostId: int("hostId").notNull(),
  latencyMs: int("latencyMs"),           // 寤惰繜姣鏁帮紝null 琛ㄧず瓒呮椂/涓嶅彲杈?
  isTimeout: boolean("isTimeout").notNull().default(false),
  recordedAt: epoch("recordedAt").notNull().default(nowDefault()),
});
export type TcpingStat = typeof tcpingStats.$inferSelect;
export type InsertTcpingStat = typeof tcpingStats.$inferInsert;

// ===== 绯荤粺璁剧疆琛紙閿€煎瓨鍌級 =====
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

export const userSubscriptions = table("user_subscriptions", {
  id: serial("id"),
  userId: int("userId").notNull(),
  planId: int("planId").notNull(),
  status: varchar("status", { length: 32 }).notNull().default("active"), // active | expired | cancelled
  source: varchar("source", { length: 32 }).notNull().default("admin"), // admin | payment
  paymentOrderNo: text("paymentOrderNo"),
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

export const balanceTransactions = table("balance_transactions", {
  id: serial("id"),
  userId: int("userId").notNull(),
  type: varchar("type", { length: 32 }).notNull(), // admin_recharge | payment | purchase | redeem
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
  pricePerGbCents: bigint("pricePerGbCents", { mode: "number" }).notNull().default(0),
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
  updatedAt: epoch("updatedAt").notNull().default(nowDefault()),
});
export type TrafficBillingUsage = typeof trafficBillingUsage.$inferSelect;
export type InsertTrafficBillingUsage = typeof trafficBillingUsage.$inferInsert;

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

// ===== 鐢ㄦ埛-涓绘満鏉冮檺琛紙绠＄悊鍛樻寚瀹氱敤鎴峰彲浣跨敤鍝簺 Agent/涓绘満锛?=====
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


