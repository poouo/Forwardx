import type { Pool } from "mysql2/promise";
import type Database from "better-sqlite3";
import { getDatabaseKind, getPool, getSqlite } from "./dbRuntime";

type ColumnType = "id" | "text" | "varchar" | "int" | "bigint" | "bool" | "epoch";

type ColumnDef = {
  name: string;
  type: ColumnType;
  notNull?: boolean;
  default?: string | number | boolean | null | "now";
  length?: number;
};

type TableDef = {
  name: string;
  columns: ColumnDef[];
  unique?: string[][];
  indexes?: string[][];
};

const c = (name: string, type: ColumnType, opts: Omit<ColumnDef, "name" | "type"> = {}): ColumnDef => ({ name, type, ...opts });

export const MIGRATION_TABLES = [
  "users",
  "hosts",
  "tunnels",
  "tunnel_hops",
  "forward_rules",
  "forward_groups",
  "forward_group_members",
  "forward_group_events",
  "host_metrics",
  "traffic_stats",
  "tunnel_latency_stats",
  "agent_tokens",
  "tcping_stats",
  "forward_tests",
  "user_host_permissions",
  "user_tunnel_permissions",
  "system_settings",
  "payment_orders",
  "subscription_plans",
  "subscription_plan_hosts",
  "subscription_plan_tunnels",
  "subscription_plan_forward_groups",
  "subscription_plan_traffic_addons",
  "user_subscriptions",
  "user_traffic_addons",
  "balance_transactions",
  "traffic_billing_configs",
  "traffic_billing_records",
  "traffic_billing_usage",
  "user_traffic_billing_permissions",
  "redemption_codes",
  "discount_codes",
  "discount_code_plans",
  "announcements",
  "announcement_reads",
] as const;

const tables: TableDef[] = [
  {
    name: "users",
    columns: [
      c("id", "id"), c("username", "text", { notNull: true }), c("password", "text", { notNull: true }),
      c("name", "text"), c("email", "text"), c("emailVerified", "bool", { notNull: true, default: false }), c("emailVerifiedAt", "epoch"), c("displayRemark", "text"), c("avatar", "text"),
      c("avatarChangeDay", "varchar", { length: 16 }), c("avatarChangeCount", "int", { notNull: true, default: 0 }), c("role", "varchar", { length: 32, notNull: true, default: "user" }), c("accountEnabled", "bool", { notNull: true, default: true }),
      c("canAddRules", "bool", { notNull: true, default: false }), c("forwardAccessPauseReason", "varchar", { length: 64 }), c("maxRules", "int", { notNull: true, default: 0 }),
      c("maxPorts", "int", { notNull: true, default: 0 }), c("allowedForwardTypes", "text"),
      c("allowForwardXTunnel", "bool", { notNull: true, default: false }), c("gostRateLimitIn", "int", { notNull: true, default: 0 }),
      c("gostRateLimitOut", "int", { notNull: true, default: 0 }), c("maxConnections", "int", { notNull: true, default: 0 }),
      c("maxIPs", "int", { notNull: true, default: 0 }), c("balanceCents", "bigint", { notNull: true, default: 0 }),
      c("trafficLimit", "bigint", { notNull: true, default: 0 }), c("trafficUsed", "bigint", { notNull: true, default: 0 }),
      c("expiresAt", "epoch"), c("trafficAutoReset", "bool", { notNull: true, default: false }),
      c("trafficResetDay", "int", { notNull: true, default: 1 }), c("lastTrafficReset", "epoch"),
      c("telegramId", "text"), c("telegramUsername", "text"), c("telegramFirstName", "text"), c("telegramLastName", "text"),
      c("telegramLinkedAt", "epoch"), c("telegramLastSeenAt", "epoch"), c("telegramBindCode", "text"),
      c("telegramBindCodeExpiresAt", "epoch"), c("telegramLoginCode", "text"), c("telegramLoginCodeExpiresAt", "epoch"),
      c("twoFactorEnabled", "bool", { notNull: true, default: false }), c("twoFactorSecret", "text"), c("twoFactorEnabledAt", "epoch"),
      c("createdAt", "epoch", { notNull: true, default: "now" }), c("updatedAt", "epoch", { notNull: true, default: "now" }),
      c("lastSignedIn", "epoch", { notNull: true, default: "now" }),
    ],
    unique: [["username"], ["telegramId"], ["telegramBindCode"], ["telegramLoginCode"]],
  },
  {
    name: "hosts",
    columns: [
      c("id", "id"), c("name", "text", { notNull: true }), c("ip", "text", { notNull: true }),
      c("ipv4", "text"), c("ipv6", "text"), c("hostType", "varchar", { length: 32, notNull: true, default: "slave" }),
      c("agentToken", "text"), c("entryIp", "text"), c("tunnelEntryIp", "text"), c("osInfo", "text"), c("cpuInfo", "text"),
      c("memoryTotal", "bigint"), c("agentVersion", "text"), c("agentUpgradeRequested", "bool", { notNull: true, default: false }),
      c("agentUpgradeTargetVersion", "text"), c("agentUpgradeRequestedAt", "epoch"), c("networkInterface", "text"),
      c("portRangeStart", "int"), c("portRangeEnd", "int"), c("isOnline", "bool", { notNull: true, default: false }),
      c("lastHeartbeat", "epoch"), c("userId", "int", { notNull: true }), c("createdAt", "epoch", { notNull: true, default: "now" }),
      c("updatedAt", "epoch", { notNull: true, default: "now" }),
    ],
    indexes: [["userId"], ["agentToken"]],
  },
  {
    name: "forward_rules",
    columns: [
      c("id", "id"), c("hostId", "int", { notNull: true }), c("name", "text", { notNull: true }),
      c("forwardType", "varchar", { length: 32, notNull: true, default: "iptables" }), c("protocol", "varchar", { length: 16, notNull: true, default: "both" }),
      c("gostMode", "varchar", { length: 32, notNull: true, default: "direct" }), c("gostRelayHost", "text"), c("gostRelayPort", "int"),
      c("tunnelId", "int"), c("tunnelExitPort", "int"),
      c("forwardGroupId", "int"), c("forwardGroupRuleId", "int"), c("forwardGroupMemberId", "int"),
      c("isForwardGroupTemplate", "bool", { notNull: true, default: false }),
      c("sourcePort", "int", { notNull: true }), c("targetIp", "text", { notNull: true }),
      c("targetPort", "int", { notNull: true }), c("protocolBlockReason", "text"), c("isEnabled", "bool", { notNull: true, default: true }),
      c("failoverEnabled", "bool", { notNull: true, default: false }), c("failoverTargets", "text"),
      c("failoverStrategy", "varchar", { length: 32, notNull: true, default: "fallback" }),
      c("failoverSeconds", "int", { notNull: true, default: 60 }), c("recoverSeconds", "int", { notNull: true, default: 120 }),
      c("autoFailback", "bool", { notNull: true, default: true }),
      c("disabledByTunnel", "bool", { notNull: true, default: false }), c("disabledByUser", "bool", { notNull: true, default: false }),
      c("isRunning", "bool", { notNull: true, default: false }), c("pendingDelete", "bool", { notNull: true, default: false }),
      c("userId", "int", { notNull: true }), c("createdAt", "epoch", { notNull: true, default: "now" }),
      c("updatedAt", "epoch", { notNull: true, default: "now" }),
    ],
    indexes: [["hostId"], ["userId"], ["tunnelId"], ["forwardGroupId"], ["forwardGroupRuleId"], ["forwardGroupMemberId"]],
  },
  {
    name: "forward_groups",
    columns: [
      c("id", "id"), c("name", "text", { notNull: true }), c("groupType", "varchar", { length: 32, notNull: true, default: "host" }),
      c("groupMode", "varchar", { length: 32, notNull: true, default: "failover" }),
      c("forwardType", "varchar", { length: 32, notNull: true, default: "iptables" }), c("domain", "text"),
      c("recordType", "varchar", { length: 16, notNull: true, default: "A" }), c("sourcePort", "int", { notNull: true, default: 1 }),
      c("protocol", "varchar", { length: 16, notNull: true, default: "both" }), c("targetIp", "text", { notNull: true, default: "0.0.0.0" }),
      c("targetPort", "int", { notNull: true, default: 1 }), c("failoverSeconds", "int", { notNull: true, default: 60 }),
      c("recoverSeconds", "int", { notNull: true, default: 120 }), c("autoFailback", "bool", { notNull: true, default: true }),
      c("isEnabled", "bool", { notNull: true, default: true }), c("activeMemberId", "int"), c("lastDdnsValue", "text"),
      c("lastDdnsAt", "epoch"), c("lastFailoverAt", "epoch"), c("lastStatus", "varchar", { length: 32, notNull: true, default: "unknown" }),
      c("lastMessage", "text"), c("userId", "int", { notNull: true }), c("createdAt", "epoch", { notNull: true, default: "now" }),
      c("updatedAt", "epoch", { notNull: true, default: "now" }),
    ],
    indexes: [["userId"], ["isEnabled"], ["activeMemberId"]],
  },
  {
    name: "forward_group_members",
    columns: [
      c("id", "id"), c("groupId", "int", { notNull: true }), c("memberType", "varchar", { length: 32, notNull: true }),
      c("hostId", "int"), c("tunnelId", "int"), c("connectHost", "text"), c("priority", "int", { notNull: true, default: 0 }), c("ruleId", "int"),
      c("isEnabled", "bool", { notNull: true, default: true }), c("healthStatus", "varchar", { length: 32, notNull: true, default: "unknown" }),
      c("lastLatencyMs", "int"), c("failureSince", "epoch"), c("healthySince", "epoch"), c("lastCheckedAt", "epoch"),
      c("createdAt", "epoch", { notNull: true, default: "now" }), c("updatedAt", "epoch", { notNull: true, default: "now" }),
    ],
    indexes: [["groupId", "priority"], ["ruleId"], ["hostId"], ["tunnelId"]],
  },
  {
    name: "forward_group_events",
    columns: [
      c("id", "id"), c("groupId", "int", { notNull: true }), c("memberId", "int"),
      c("type", "varchar", { length: 32, notNull: true }), c("message", "text"),
      c("createdAt", "epoch", { notNull: true, default: "now" }),
    ],
    indexes: [["groupId", "createdAt"], ["memberId"]],
  },
  {
    name: "tunnels",
    columns: [
      c("id", "id"), c("name", "text", { notNull: true }), c("entryHostId", "int", { notNull: true }),
      c("exitHostId", "int", { notNull: true }), c("mode", "varchar", { length: 32, notNull: true, default: "tls" }),
      c("secret", "text"), c("listenPort", "int", { notNull: true }), c("portRangeStart", "int"), c("portRangeEnd", "int"),
      c("networkType", "varchar", { length: 32, notNull: true, default: "public" }), c("connectHost", "text"),
      c("blockHttp", "bool", { notNull: true, default: false }), c("blockSocks", "bool", { notNull: true, default: false }),
      c("blockTls", "bool", { notNull: true, default: false }), c("isEnabled", "bool", { notNull: true, default: true }), c("isRunning", "bool", { notNull: true, default: false }),
      c("lastLatencyMs", "int"), c("lastTestStatus", "text"), c("lastTestMessage", "text"), c("lastTestAt", "epoch"),
      c("userId", "int", { notNull: true }), c("createdAt", "epoch", { notNull: true, default: "now" }),
      c("updatedAt", "epoch", { notNull: true, default: "now" }),
    ],
    indexes: [["entryHostId"], ["exitHostId"], ["userId"]],
  },
  { name: "tunnel_hops", columns: [c("id", "id"), c("tunnelId", "int", { notNull: true }), c("seq", "int", { notNull: true }), c("hostId", "int", { notNull: true }), c("listenPort", "int", { notNull: true, default: 0 }), c("connectHost", "text")], unique: [["tunnelId", "seq"]], indexes: [["tunnelId"], ["hostId"]] },
  { name: "host_metrics", columns: [c("id", "id"), c("hostId", "int", { notNull: true }), c("cpuUsage", "int"), c("memoryUsage", "int"), c("memoryUsed", "bigint"), c("networkIn", "bigint"), c("networkOut", "bigint"), c("diskUsage", "int"), c("diskUsed", "bigint"), c("diskTotal", "bigint"), c("uptime", "bigint"), c("recordedAt", "epoch", { notNull: true, default: "now" })], indexes: [["hostId", "recordedAt"]] },
  { name: "traffic_stats", columns: [c("id", "id"), c("ruleId", "int", { notNull: true }), c("hostId", "int", { notNull: true }), c("bytesIn", "bigint", { notNull: true, default: 0 }), c("bytesOut", "bigint", { notNull: true, default: 0 }), c("connections", "int", { notNull: true, default: 0 }), c("recordedAt", "epoch", { notNull: true, default: "now" })], indexes: [["ruleId", "recordedAt"], ["hostId", "recordedAt"]] },
  { name: "tunnel_latency_stats", columns: [c("id", "id"), c("tunnelId", "int", { notNull: true }), c("latencyMs", "int"), c("isTimeout", "bool", { notNull: true, default: false }), c("recordedAt", "epoch", { notNull: true, default: "now" })], indexes: [["tunnelId", "recordedAt"]] },
  { name: "agent_tokens", columns: [c("id", "id"), c("token", "text", { notNull: true }), c("hostId", "int"), c("description", "text"), c("isUsed", "bool", { notNull: true, default: false }), c("userId", "int", { notNull: true }), c("createdAt", "epoch", { notNull: true, default: "now" })], unique: [["token"]], indexes: [["userId"]] },
  { name: "tcping_stats", columns: [c("id", "id"), c("ruleId", "int", { notNull: true }), c("hostId", "int", { notNull: true }), c("latencyMs", "int"), c("isTimeout", "bool", { notNull: true, default: false }), c("recordedAt", "epoch", { notNull: true, default: "now" })], indexes: [["ruleId", "recordedAt"], ["hostId", "recordedAt"]] },
  { name: "forward_tests", columns: [c("id", "id"), c("ruleId", "int", { notNull: true }), c("hostId", "int", { notNull: true }), c("userId", "int", { notNull: true }), c("status", "varchar", { length: 32, notNull: true, default: "pending" }), c("listenOk", "bool", { notNull: true, default: false }), c("targetReachable", "bool", { notNull: true, default: false }), c("forwardOk", "bool", { notNull: true, default: false }), c("latencyMs", "int"), c("message", "text"), c("createdAt", "epoch", { notNull: true, default: "now" }), c("updatedAt", "epoch", { notNull: true, default: "now" })], indexes: [["ruleId", "createdAt"], ["hostId", "status"]] },
  { name: "user_host_permissions", columns: [c("id", "id"), c("userId", "int", { notNull: true }), c("hostId", "int", { notNull: true }), c("createdAt", "epoch", { notNull: true, default: "now" })], unique: [["userId", "hostId"]], indexes: [["hostId"]] },
  { name: "user_tunnel_permissions", columns: [c("id", "id"), c("userId", "int", { notNull: true }), c("tunnelId", "int", { notNull: true }), c("createdAt", "epoch", { notNull: true, default: "now" })], unique: [["userId", "tunnelId"]], indexes: [["tunnelId"]] },
  { name: "system_settings", columns: [c("key", "varchar", { length: 191, notNull: true }), c("value", "text"), c("updatedAt", "epoch", { notNull: true, default: "now" })], unique: [["key"]] },
  { name: "payment_orders", columns: [c("id", "id"), c("outTradeNo", "text", { notNull: true }), c("userId", "int", { notNull: true }), c("provider", "varchar", { length: 32, notNull: true }), c("paymentType", "varchar", { length: 32, notNull: true }), c("status", "varchar", { length: 32, notNull: true, default: "pending" }), c("subject", "text", { notNull: true }), c("amountCents", "bigint", { notNull: true }), c("currency", "varchar", { length: 16, notNull: true, default: "CNY" }), c("tradeNo", "text"), c("payUrl", "text"), c("qrCode", "text"), c("orderType", "varchar", { length: 32, notNull: true, default: "balance" }), c("planId", "int"), c("subscriptionId", "int"), c("discountCodeId", "int"), c("discountAmountCents", "bigint", { notNull: true, default: 0 }), c("clientIp", "text"), c("rawNotify", "text"), c("expiresAt", "epoch"), c("paidAt", "epoch"), c("createdAt", "epoch", { notNull: true, default: "now" }), c("updatedAt", "epoch", { notNull: true, default: "now" })], unique: [["outTradeNo"]], indexes: [["userId", "createdAt"], ["status", "createdAt"]] },
  { name: "subscription_plans", columns: [c("id", "id"), c("name", "text", { notNull: true }), c("description", "text"), c("priceCents", "bigint", { notNull: true, default: 0 }), c("currency", "varchar", { length: 16, notNull: true, default: "CNY" }), c("durationDays", "int", { notNull: true, default: 30 }), c("portCount", "int", { notNull: true, default: 20 }), c("trafficLimit", "bigint", { notNull: true, default: 0 }), c("rateLimitMbps", "int", { notNull: true, default: 0 }), c("maxRules", "int", { notNull: true, default: 20 }), c("maxConnections", "int", { notNull: true, default: 2000 }), c("maxIPs", "int", { notNull: true, default: 10 }), c("isActive", "bool", { notNull: true, default: true }), c("isStoreVisible", "bool", { notNull: true, default: true }), c("sortOrder", "int", { notNull: true, default: 0 }), c("createdAt", "epoch", { notNull: true, default: "now" }), c("updatedAt", "epoch", { notNull: true, default: "now" })] },
  { name: "subscription_plan_hosts", columns: [c("id", "id"), c("planId", "int", { notNull: true }), c("hostId", "int", { notNull: true }), c("createdAt", "epoch", { notNull: true, default: "now" })], unique: [["planId", "hostId"]] },
  { name: "subscription_plan_tunnels", columns: [c("id", "id"), c("planId", "int", { notNull: true }), c("tunnelId", "int", { notNull: true }), c("createdAt", "epoch", { notNull: true, default: "now" })], unique: [["planId", "tunnelId"]] },
  { name: "subscription_plan_forward_groups", columns: [c("id", "id"), c("planId", "int", { notNull: true }), c("forwardGroupId", "int", { notNull: true }), c("createdAt", "epoch", { notNull: true, default: "now" })], unique: [["planId", "forwardGroupId"]], indexes: [["forwardGroupId"]] },
  { name: "subscription_plan_traffic_addons", columns: [c("id", "id"), c("planId", "int", { notNull: true }), c("trafficBytes", "bigint", { notNull: true, default: 0 }), c("priceCents", "bigint", { notNull: true, default: 0 }), c("isActive", "bool", { notNull: true, default: true }), c("sortOrder", "int", { notNull: true, default: 0 }), c("createdAt", "epoch", { notNull: true, default: "now" }), c("updatedAt", "epoch", { notNull: true, default: "now" })], indexes: [["planId", "isActive"], ["planId", "sortOrder"]] },
  { name: "user_subscriptions", columns: [c("id", "id"), c("userId", "int", { notNull: true }), c("planId", "int", { notNull: true }), c("status", "varchar", { length: 32, notNull: true, default: "active" }), c("source", "varchar", { length: 32, notNull: true, default: "admin" }), c("paymentOrderNo", "text"), c("portRangeStart", "int"), c("portRangeEnd", "int"), c("nextTrafficResetAt", "epoch"), c("lastTrafficResetAt", "epoch"), c("startedAt", "epoch", { notNull: true, default: "now" }), c("expiresAt", "epoch"), c("createdAt", "epoch", { notNull: true, default: "now" }), c("updatedAt", "epoch", { notNull: true, default: "now" })], indexes: [["userId", "status", "expiresAt"], ["planId"], ["paymentOrderNo"]] },
  { name: "user_traffic_addons", columns: [c("id", "id"), c("userId", "int", { notNull: true }), c("subscriptionId", "int", { notNull: true }), c("planId", "int", { notNull: true }), c("addonId", "int"), c("trafficBytes", "bigint", { notNull: true, default: 0 }), c("priceCents", "bigint", { notNull: true, default: 0 }), c("source", "varchar", { length: 32, notNull: true, default: "user" }), c("status", "varchar", { length: 32, notNull: true, default: "active" }), c("operatorUserId", "int"), c("description", "text"), c("cycleResetAt", "epoch"), c("expiresAt", "epoch"), c("expiredAt", "epoch"), c("createdAt", "epoch", { notNull: true, default: "now" }), c("updatedAt", "epoch", { notNull: true, default: "now" })], indexes: [["userId", "status", "expiresAt"], ["subscriptionId", "status"], ["addonId"]] },
  { name: "balance_transactions", columns: [c("id", "id"), c("userId", "int", { notNull: true }), c("type", "varchar", { length: 32, notNull: true }), c("amountCents", "bigint", { notNull: true }), c("balanceAfterCents", "bigint", { notNull: true }), c("description", "text"), c("operatorUserId", "int"), c("paymentOrderNo", "text"), c("redemptionCodeId", "int"), c("createdAt", "epoch", { notNull: true, default: "now" })], indexes: [["userId", "createdAt"], ["paymentOrderNo"]] },
  { name: "traffic_billing_configs", columns: [c("id", "id"), c("resourceType", "varchar", { length: 16, notNull: true }), c("resourceId", "int", { notNull: true }), c("enabled", "bool", { notNull: true, default: true }), c("requiresPermission", "bool", { notNull: true, default: false }), c("pricePerGbCents", "bigint", { notNull: true, default: 0 }), c("multiplier", "int", { notNull: true, default: 100 }), c("createdAt", "epoch", { notNull: true, default: "now" }), c("updatedAt", "epoch", { notNull: true, default: "now" })], unique: [["resourceType", "resourceId"]], indexes: [["enabled"], ["requiresPermission"]] },
  { name: "traffic_billing_records", columns: [c("id", "id"), c("userId", "int", { notNull: true }), c("ruleId", "int", { notNull: true }), c("resourceType", "varchar", { length: 16, notNull: true }), c("resourceId", "int", { notNull: true }), c("bytes", "bigint", { notNull: true, default: 0 }), c("billedGb", "int", { notNull: true, default: 0 }), c("pricePerGbCents", "bigint", { notNull: true, default: 0 }), c("multiplier", "int", { notNull: true, default: 100 }), c("amountCents", "bigint", { notNull: true, default: 0 }), c("balanceAfterCents", "bigint", { notNull: true, default: 0 }), c("createdAt", "epoch", { notNull: true, default: "now" })], indexes: [["userId", "createdAt"], ["resourceType", "resourceId", "createdAt"], ["ruleId", "createdAt"]] },
  { name: "traffic_billing_usage", columns: [c("id", "id"), c("userId", "int", { notNull: true }), c("resourceType", "varchar", { length: 16, notNull: true }), c("resourceId", "int", { notNull: true }), c("totalBytes", "bigint", { notNull: true, default: 0 }), c("billedGb", "int", { notNull: true, default: 0 }), c("updatedAt", "epoch", { notNull: true, default: "now" })], unique: [["userId", "resourceType", "resourceId"]], indexes: [["resourceType", "resourceId"]] },
  { name: "user_traffic_billing_permissions", columns: [c("id", "id"), c("userId", "int", { notNull: true }), c("resourceType", "varchar", { length: 16, notNull: true }), c("resourceId", "int", { notNull: true }), c("createdAt", "epoch", { notNull: true, default: "now" })], unique: [["userId", "resourceType", "resourceId"]], indexes: [["userId"], ["resourceType", "resourceId"]] },
  { name: "redemption_codes", columns: [c("id", "id"), c("code", "text", { notNull: true }), c("type", "varchar", { length: 32, notNull: true }), c("planId", "int"), c("durationDays", "int"), c("amountCents", "bigint", { notNull: true, default: 0 }), c("startsAt", "epoch"), c("expiresAt", "epoch"), c("isActive", "bool", { notNull: true, default: true }), c("usedByUserId", "int"), c("usedAt", "epoch"), c("createdByUserId", "int"), c("createdAt", "epoch", { notNull: true, default: "now" }), c("updatedAt", "epoch", { notNull: true, default: "now" })], unique: [["code"]], indexes: [["isActive", "startsAt", "expiresAt", "usedAt"]] },
  { name: "discount_codes", columns: [c("id", "id"), c("code", "text", { notNull: true }), c("discountType", "varchar", { length: 32, notNull: true }), c("discountValue", "int", { notNull: true }), c("maxUses", "int", { notNull: true, default: 0 }), c("usedCount", "int", { notNull: true, default: 0 }), c("startsAt", "epoch"), c("expiresAt", "epoch"), c("isActive", "bool", { notNull: true, default: true }), c("createdByUserId", "int"), c("createdAt", "epoch", { notNull: true, default: "now" }), c("updatedAt", "epoch", { notNull: true, default: "now" })], unique: [["code"]], indexes: [["isActive", "startsAt", "expiresAt", "usedCount"]] },
  { name: "discount_code_plans", columns: [c("id", "id"), c("discountCodeId", "int", { notNull: true }), c("planId", "int", { notNull: true }), c("createdAt", "epoch", { notNull: true, default: "now" })], unique: [["discountCodeId", "planId"]], indexes: [["planId"]] },
  { name: "announcements", columns: [c("id", "id"), c("title", "text", { notNull: true }), c("content", "text", { notNull: true }), c("type", "varchar", { length: 32, notNull: true, default: "normal" }), c("isActive", "bool", { notNull: true, default: true }), c("startsAt", "epoch"), c("expiresAt", "epoch"), c("createdByUserId", "int"), c("createdAt", "epoch", { notNull: true, default: "now" }), c("updatedAt", "epoch", { notNull: true, default: "now" })], indexes: [["type", "isActive", "updatedAt"]] },
  { name: "announcement_reads", columns: [c("id", "id"), c("announcementId", "int", { notNull: true }), c("userId", "int", { notNull: true }), c("dismissedAt", "epoch", { notNull: true, default: "now" })], unique: [["announcementId", "userId"]], indexes: [["userId", "announcementId"]] },
];

const seedSettings = [
  ["storeEnabled", "false"],
  ["registrationEnabled", "true"],
  ["homepageEnabled", "true"],
  ["homepageCustomEnabled", "false"],
  ["lookingGlassUserEnabled", "true"],
  ["redemptionEnabled", "true"],
  ["discountEnabled", "true"],
  ["trafficBillingEnabled", "false"],
  ["twoFactorEnabled", "false"],
] as const;

function quote(kind: "mysql" | "sqlite", id: string) {
  return kind === "mysql" ? `\`${id}\`` : `"${id}"`;
}

function defaultSql(kind: "mysql" | "sqlite", value: ColumnDef["default"]) {
  if (value === undefined || value === null) return "";
  if (value === "now") return ` DEFAULT ${kind === "mysql" ? "(UNIX_TIMESTAMP())" : "(unixepoch())"}`;
  if (typeof value === "boolean") return ` DEFAULT ${value ? 1 : 0}`;
  if (typeof value === "number") return ` DEFAULT ${value}`;
  return ` DEFAULT '${String(value).replace(/'/g, "''")}'`;
}

function columnSql(kind: "mysql" | "sqlite", column: ColumnDef, forAlter = false) {
  const name = quote(kind, column.name);
  if (column.type === "id") {
    if (forAlter) return "";
    return kind === "mysql"
      ? `${name} BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY`
      : `${name} INTEGER PRIMARY KEY AUTOINCREMENT`;
  }
  const type = kind === "sqlite"
    ? (column.type === "varchar" || column.type === "text" ? "TEXT" : "INTEGER")
    : ({
      text: "TEXT",
      varchar: `VARCHAR(${column.length || 191})`,
      int: "INT",
      bigint: "BIGINT",
      bool: "BOOLEAN",
      epoch: "INT",
    } as Record<ColumnType, string>)[column.type];
  return `${name} ${type}${column.notNull ? " NOT NULL" : ""}${defaultSql(kind, column.default)}`;
}

function mysqlKey(table: string, prefix: string, cols: string[]) {
  const name = quote("mysql", `${prefix}_${table}_${cols.join("_")}`.slice(0, 60));
  const expr = cols.map((col) => {
    const def = tables.find((t) => t.name === table)?.columns.find((c) => c.name === col);
    const q = quote("mysql", col);
    return def?.type === "text" ? `${q}(191)` : q;
  }).join(", ");
  return { name, expr };
}

async function ensureMysqlSchema(pool: Pool) {
  for (const table of tables) {
    const columns = table.columns.map((column) => columnSql("mysql", column)).filter(Boolean);
    const unique = (table.unique || []).map((cols) => {
      const key = mysqlKey(table.name, "uniq", cols);
      return `UNIQUE KEY ${key.name} (${key.expr})`;
    });
    const indexes = (table.indexes || []).map((cols) => {
      const key = mysqlKey(table.name, "idx", cols);
      return `KEY ${key.name} (${key.expr})`;
    });
    await pool.query(
      `CREATE TABLE IF NOT EXISTS ${quote("mysql", table.name)} (${[...columns, ...unique, ...indexes].join(", ")}) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    );
    for (const column of table.columns) {
      if (column.type === "id") continue;
      await pool.query(`ALTER TABLE ${quote("mysql", table.name)} ADD COLUMN ${columnSql("mysql", column, true)}`).catch(() => undefined);
    }
    for (const cols of [...(table.indexes || []), ...(table.unique || [])]) {
      const uniquePrefix = (table.unique || []).some((u) => u.join("|") === cols.join("|")) ? "uniq" : "idx";
      const key = mysqlKey(table.name, uniquePrefix, cols);
      await pool.query(`ALTER TABLE ${quote("mysql", table.name)} ADD ${uniquePrefix === "uniq" ? "UNIQUE " : ""}INDEX ${key.name} (${key.expr})`).catch(() => undefined);
    }
  }
  for (const [key, value] of seedSettings) {
    await pool.execute(
      "INSERT INTO system_settings (`key`, value, updatedAt) VALUES (?, ?, UNIX_TIMESTAMP()) ON DUPLICATE KEY UPDATE `key` = `key`",
      [key, value],
    );
  }
}

function ensureSqliteSchema(sqlite: Database.Database) {
  for (const table of tables) {
    const columns = table.columns.map((column) => columnSql("sqlite", column)).filter(Boolean);
    const unique = (table.unique || []).map((cols) => `UNIQUE (${cols.map((col) => quote("sqlite", col)).join(", ")})`);
    sqlite.exec(`CREATE TABLE IF NOT EXISTS ${quote("sqlite", table.name)} (${[...columns, ...unique].join(", ")})`);
    for (const column of table.columns) {
      if (column.type === "id") continue;
      try {
        sqlite.exec(`ALTER TABLE ${quote("sqlite", table.name)} ADD COLUMN ${columnSql("sqlite", column, true)}`);
      } catch {
        // Column already exists.
      }
    }
    for (const cols of [...(table.indexes || []), ...(table.unique || [])]) {
      const uniquePrefix = (table.unique || []).some((u) => u.join("|") === cols.join("|")) ? "UNIQUE " : "";
      const indexName = quote("sqlite", `${uniquePrefix ? "uniq" : "idx"}_${table.name}_${cols.join("_")}`.slice(0, 60));
      sqlite.exec(`CREATE ${uniquePrefix}INDEX IF NOT EXISTS ${indexName} ON ${quote("sqlite", table.name)} (${cols.map((col) => quote("sqlite", col)).join(", ")})`);
    }
  }
  for (const [key, value] of seedSettings) {
    sqlite.prepare(
      "INSERT OR IGNORE INTO system_settings (key, value, updatedAt) VALUES (?, ?, unixepoch())",
    ).run(key, value);
  }
}

export async function ensureDatabaseSchema(target?: Pool | Database.Database) {
  if (target && "prepare" in target) {
    ensureSqliteSchema(target as Database.Database);
    return;
  }
  if (target) {
    await ensureMysqlSchema(target as Pool);
    return;
  }
  const kind = getDatabaseKind();
  if (kind === "sqlite") {
    const sqlite = getSqlite();
    if (!sqlite) throw new Error("SQLite database is not connected");
    ensureSqliteSchema(sqlite);
    return;
  }
  const pool = getPool();
  if (!pool) throw new Error("MySQL database is not connected");
  await ensureMysqlSchema(pool);
}
