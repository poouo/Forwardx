import type { Pool } from "mysql2/promise";
import type Database from "better-sqlite3";
import type pg from "pg";
import { seamlessBackgroundPaused } from "./seamlessMigrationState";
import { getDatabaseKind, getPool, getPostgresPool, getSqlite } from "./dbRuntime";
import { normalizeSidebarMenuSettings } from "../shared/sidebarMenu";

export type ColumnType = "id" | "text" | "longtext" | "varchar" | "int" | "bigint" | "real" | "bool" | "epoch";

export type ColumnDef = {
  name: string;
  type: ColumnType;
  notNull?: boolean;
  default?: string | number | boolean | null | "now";
  length?: number;
};

export type TableDef = {
  name: string;
  columns: ColumnDef[];
  unique?: string[][];
  indexes?: string[][];
};

const c = (name: string, type: ColumnType, opts: Omit<ColumnDef, "name" | "type"> = {}): ColumnDef => ({ name, type, ...opts });

export const MIGRATION_TABLES = [
  "ai_bot_workflows",
  "users",
  "hosts",
  "agent_installations",
  "host_groups",
  "host_group_members",
  "tunnels",
  "tunnel_exit_nodes",
  "tunnel_hops",
  "forward_rule_tunnel_exits",
  "forward_rules",
  "rule_groups",
  "rule_group_members",
  "forward_groups",
  "forward_group_members",
  "forward_group_events",
  "host_metrics",
  "host_availability_intervals",
  "host_traffic_counters",
  "user_traffic_counters",
  "forward_rule_traffic_counters",
  "resource_traffic_baselines",
  "traffic_stats",
  "traffic_stat_buckets",
  "operations_traffic_daily",
  "operations_source_daily",
  "operations_source_status",
  "operations_ip_geo",
  "agent_traffic_reports",
  "tunnel_latency_stats",
  "forward_group_latency_stats",
  "host_probe_services",
  "host_probe_service_stats",
  "ip_geo_cache",
  "agent_tokens",
  "tcping_stats",
  "probe_counter_snapshots",
  "forward_tests",
  "user_host_permissions",
  "user_tunnel_permissions",
  "user_forward_group_permissions",
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
  "traffic_billing_rule_usage",
  "user_traffic_billing_permissions",
  "redemption_codes",
  "discount_codes",
  "discount_code_plans",
  "announcements",
  "announcement_reads",
  "support_tickets",
  "support_ticket_messages",
  "support_ticket_attachments",
  "support_ticket_reads",
  "support_canned_replies",
  "affiliate_accounts",
  "affiliate_codes",
  "affiliate_referrals",
  "affiliate_commissions",
  "affiliate_withdrawals",
  "affiliate_ledger",
  "plugins",
  "plugin_store_sources",
  "plugin_assets",
  "plugin_agent_states",
  "config_audit_events",
] as const;

const LAST_AUTO_TRAFFIC_RESET_BACKFILL_MARKER = "last-auto-traffic-reset-backfill-v1";

function backfillSqliteLastAutoTrafficReset(sqlite: Database.Database) {
  const migrate = sqlite.transaction(() => {
    const claimed = sqlite.prepare(
      "INSERT OR IGNORE INTO system_settings (key, value, updatedAt) VALUES (?, '1', unixepoch())",
    ).run(LAST_AUTO_TRAFFIC_RESET_BACKFILL_MARKER);
    if (claimed.changes === 0) return;
    sqlite.exec(
      'UPDATE "users" SET "lastAutoTrafficReset" = "lastTrafficReset" WHERE "lastAutoTrafficReset" IS NULL AND "lastTrafficReset" IS NOT NULL',
    );
  });
  migrate();
}

async function backfillMysqlLastAutoTrafficReset(pool: Pool) {
  const [rows] = await pool.query<any[]>(
    "SELECT `key` FROM `system_settings` WHERE `key` = ? LIMIT 1",
    [LAST_AUTO_TRAFFIC_RESET_BACKFILL_MARKER],
  );
  if (rows.length > 0) return;
  await pool.query(
    'UPDATE `users` SET `lastAutoTrafficReset` = `lastTrafficReset` WHERE `lastAutoTrafficReset` IS NULL AND `lastTrafficReset` IS NOT NULL',
  );
  await pool.execute(
    "INSERT INTO system_settings (`key`, value, updatedAt) VALUES (?, '1', UNIX_TIMESTAMP()) ON DUPLICATE KEY UPDATE `key` = `key`",
    [LAST_AUTO_TRAFFIC_RESET_BACKFILL_MARKER],
  );
}

async function backfillPostgresqlLastAutoTrafficReset(pool: pg.Pool) {
  await pool.query(
    `WITH claimed AS (
       INSERT INTO "system_settings" ("key", value, "updatedAt")
       VALUES ($1, '1', EXTRACT(EPOCH FROM NOW())::INT)
       ON CONFLICT ("key") DO NOTHING
       RETURNING "key"
     )
     UPDATE "users"
     SET "lastAutoTrafficReset" = "lastTrafficReset"
     WHERE "lastAutoTrafficReset" IS NULL
       AND "lastTrafficReset" IS NOT NULL
       AND EXISTS (SELECT 1 FROM claimed)`,
    [LAST_AUTO_TRAFFIC_RESET_BACKFILL_MARKER],
  );
}

const tables: TableDef[] = [
  { name: "resource_traffic_baselines", columns: [
    c("id", "id"), c("groupId", "int", { notNull: true }), c("ruleId", "int", { notNull: true }), c("hostId", "int", { notNull: true }),
    c("bytesIn", "bigint", { notNull: true, default: 0 }), c("bytesOut", "bigint", { notNull: true, default: 0 }),
    c("dailyIn", "bigint", { notNull: true, default: 0 }), c("dailyOut", "bigint", { notNull: true, default: 0 }),
    c("resetDay", "epoch", { notNull: true }), c("resetAt", "epoch", { notNull: true }),
  ], unique: [["groupId", "ruleId", "hostId"]], indexes: [["ruleId"]] },
  // Provider credentials and action state must be reconfigured after core merge migrations.
  { name: "host_probe_health", columns: [c("id", "id"), c("serviceId", "int", { notNull: true }), c("hostId", "int", { notNull: true }), c("config", "text", { notNull: true }), c("hookCiphertext", "longtext"), c("state", "text"), c("updatedAt", "epoch", { notNull: true })], unique: [["serviceId"]], indexes: [["hostId"]] },
  { name: "host_ip_switch_attempts", columns: [c("id", "id"), c("hostId", "int", { notNull: true }), c("serviceId", "int", { notNull: true }), c("incidentId", "varchar", { length: 64, notNull: true }), c("status", "varchar", { length: 40, notNull: true }), c("createdAt", "epoch", { notNull: true }), c("finishedAt", "epoch"), c("newIp", "varchar", { length: 64 }), c("acknowledged", "bool", { notNull: true, default: false })], unique: [["incidentId"]], indexes: [["hostId", "createdAt"], ["serviceId", "createdAt"]] },
  { name: "operations_alert_state", columns: [c("id", "id"), c("hostId", "int", { notNull: true }), c("metric", "varchar", { length: 16, notNull: true }), c("phase", "varchar", { length: 16, notNull: true }), c("since", "epoch", { notNull: true }), c("lastSeen", "epoch", { notNull: true }), c("peak", "int", { notNull: true })], unique: [["hostId", "metric"]], indexes: [["lastSeen"]] },
  { name: "resource_alert_service_state", columns: [c("id", "id"), c("serviceId", "varchar", { length: 64, notNull: true }), c("hostId", "int", { notNull: true }), c("metric", "varchar", { length: 16, notNull: true }), c("phase", "varchar", { length: 16, notNull: true }), c("since", "epoch", { notNull: true }), c("lastSeen", "epoch", { notNull: true }), c("peak", "int", { notNull: true })], unique: [["hostId", "serviceId"]], indexes: [["lastSeen"]] },
  { name: "operations_alert_events", columns: [c("id", "id"), c("hostId", "int", { notNull: true }), c("hostName", "varchar", { length: 255, notNull: true }), c("serviceId", "varchar", { length: 64 }), c("serviceName", "varchar", { length: 80 }), c("metric", "varchar", { length: 16, notNull: true }), c("type", "varchar", { length: 16, notNull: true }), c("value", "int", { notNull: true }), c("createdAt", "epoch", { notNull: true })], indexes: [["createdAt"], ["hostId", "createdAt"]] },
  // Credentials deliberately do not travel with merge migrations: issue fresh tokens at the destination.
  { name: "external_mcp_tokens", columns: [c("id", "id"), c("userId", "int", { notNull: true }), c("name", "varchar", { length: 80, notNull: true }), c("tokenHash", "varchar", { length: 64, notNull: true }), c("prefix", "varchar", { length: 20, notNull: true }), c("expiresAt", "epoch", { notNull: true }), c("createdAt", "epoch", { notNull: true }), c("lastUsedAt", "epoch")], unique: [["tokenHash"]], indexes: [["userId"], ["expiresAt"]] },
  { name: "operations_traffic_daily", columns: [c("id", "id"), c("dayStart", "epoch", { notNull: true }), c("ruleId", "int", { notNull: true }), c("hostId", "int", { notNull: true }), c("userId", "int", { notNull: true }), c("logicalRuleId", "int", { notNull: true }), c("resourceKey", "varchar", { length: 64, notNull: true }), c("ruleName", "varchar", { length: 255, notNull: true }), c("hostName", "varchar", { length: 255, notNull: true }), c("resourceName", "varchar", { length: 255, notNull: true }), c("bytesIn", "bigint", { notNull: true, default: 0 }), c("bytesOut", "bigint", { notNull: true, default: 0 }), c("connections", "bigint", { notNull: true, default: 0 })], unique: [["dayStart", "ruleId", "hostId", "userId", "resourceKey"]], indexes: [["dayStart", "userId"], ["logicalRuleId", "dayStart"], ["hostId", "dayStart"], ["resourceKey", "dayStart"]] },
  { name: "operations_source_daily", columns: [c("id", "id"), c("dayStart", "epoch", { notNull: true }), c("ruleId", "int", { notNull: true }), c("hostId", "int", { notNull: true }), c("ip", "varchar", { length: 64, notNull: true }), c("userId", "int", { notNull: true }), c("logicalRuleId", "int", { notNull: true }), c("bytesIn", "bigint", { notNull: true, default: 0 }), c("bytesOut", "bigint", { notNull: true, default: 0 }), c("unknownSamples", "bigint", { notNull: true, default: 0 }), c("knownSamples", "bigint", { notNull: true, default: 0 }), c("lastSeen", "epoch", { notNull: true })], unique: [["dayStart", "ruleId", "hostId", "ip"]], indexes: [["dayStart", "ip"], ["userId", "dayStart"], ["hostId", "dayStart"]] },
  { name: "operations_source_status", columns: [c("id", "id"), c("hostId", "int", { notNull: true }), c("status", "varchar", { length: 32, notNull: true }), c("lastSeen", "epoch", { notNull: true })], unique: [["hostId"]], indexes: [["lastSeen"]] },
  { name: "operations_ip_geo", columns: [c("id", "id"), c("address", "varchar", { length: 64, notNull: true }), c("countryCode", "varchar", { length: 8, notNull: true }), c("countryName", "varchar", { length: 128 }), c("region", "varchar", { length: 128 }), c("city", "varchar", { length: 128 }), c("isp", "varchar", { length: 128 }), c("datasetVersion", "varchar", { length: 64, notNull: true }), c("expiresAt", "epoch", { notNull: true })], unique: [["address"]], indexes: [["expiresAt"]] },
  { name: "host_availability_intervals", columns: [c("id", "id"), c("observationKey", "varchar", { length: 36, notNull: true }), c("hostId", "int", { notNull: true }), c("online", "int", { notNull: true }), c("offlineIncident", "int", { notNull: true, default: 0 }), c("startAt", "epoch", { notNull: true }), c("endAt", "epoch", { notNull: true })], unique: [["observationKey"]], indexes: [["hostId", "startAt", "id"], ["endAt", "id"]] },
  { name: "affiliate_accounts", columns: [c("id", "id"), c("userId", "int", { notNull: true }), c("availableCents", "bigint", { notNull: true, default: 0 }), c("blocked", "bool", { notNull: true, default: false }), c("rateBps", "int"), c("createdAt", "epoch", { notNull: true, default: "now" })], unique: [["userId"]] },
  { name: "affiliate_codes", columns: [c("id", "id"), c("userId", "int", { notNull: true }), c("code", "varchar", { length: 32, notNull: true }), c("active", "bool", { notNull: true, default: true }), c("createdAt", "epoch", { notNull: true, default: "now" })], unique: [["code"]], indexes: [["userId"]] },
  { name: "affiliate_referrals", columns: [c("id", "id"), c("userId", "int", { notNull: true }), c("affiliateUserId", "int", { notNull: true }), c("codeId", "int", { notNull: true }), c("createdAt", "epoch", { notNull: true, default: "now" })], unique: [["userId"]], indexes: [["affiliateUserId"]] },
  { name: "affiliate_commissions", columns: [c("id", "id"), c("userId", "int", { notNull: true }), c("referredUserId", "int", { notNull: true }), c("orderNo", "varchar", { length: 128, notNull: true }), c("orderAmountCents", "bigint", { notNull: true }), c("amountCents", "bigint", { notNull: true }), c("rateBps", "int", { notNull: true }), c("status", "varchar", { length: 24, notNull: true, default: "pending" }), c("confirmAt", "epoch", { notNull: true }), c("reason", "text"), c("createdAt", "epoch", { notNull: true, default: "now" }), c("settledAt", "epoch")], unique: [["orderNo"]], indexes: [["userId", "status", "confirmAt"], ["referredUserId"]] },
  { name: "affiliate_withdrawals", columns: [c("id", "id"), c("userId", "int", { notNull: true }), c("amountCents", "bigint", { notNull: true }), c("method", "varchar", { length: 24, notNull: true }), c("account", "text", { notNull: true }), c("payee", "varchar", { length: 120, notNull: true }), c("status", "varchar", { length: 24, notNull: true, default: "pending" }), c("note", "text"), c("operatorUserId", "int"), c("requestKey", "varchar", { length: 64, notNull: true }), c("createdAt", "epoch", { notNull: true, default: "now" }), c("reviewedAt", "epoch")], unique: [["userId", "requestKey"]], indexes: [["userId", "status"]] },
  { name: "affiliate_ledger", columns: [c("id", "id"), c("userId", "int", { notNull: true }), c("type", "varchar", { length: 32, notNull: true }), c("amountCents", "bigint", { notNull: true }), c("balanceAfterCents", "bigint", { notNull: true }), c("reference", "varchar", { length: 128, notNull: true }), c("operatorUserId", "int"), c("note", "text"), c("createdAt", "epoch", { notNull: true, default: "now" })], unique: [["userId", "type", "reference"]], indexes: [["userId", "createdAt"]] },
  {
    name: "support_tickets",
    columns: [
      c("id", "id"), c("userId", "int", { notNull: true }), c("title", "varchar", { length: 160, notNull: true }),
      c("status", "varchar", { length: 24, notNull: true, default: "open" }), c("priority", "varchar", { length: 16, notNull: true, default: "normal" }),
      c("category", "varchar", { length: 24, notNull: true, default: "technical" }), c("serviceType", "varchar", { length: 24 }),
      c("serviceId", "int"), c("serviceName", "text"), c("assignedTo", "int"),
      c("version", "int", { notNull: true, default: 1 }), c("publicVersion", "int", { notNull: true, default: 1 }),
      c("rating", "int"), c("ratingComment", "text"), c("firstResponseAt", "epoch"), c("resolvedAt", "epoch"), c("closedAt", "epoch"),
      c("createdAt", "epoch", { notNull: true, default: "now" }), c("updatedAt", "epoch", { notNull: true, default: "now" }),
    ],
    indexes: [["userId", "updatedAt"], ["status", "updatedAt"], ["assignedTo", "status"], ["userId", "createdAt"]],
  },
  {
    name: "support_ticket_messages",
    columns: [
      c("id", "id"), c("ticketId", "int", { notNull: true }), c("authorId", "int", { notNull: true }),
      c("authorName", "varchar", { length: 160, notNull: true }), c("authorRole", "varchar", { length: 16, notNull: true }),
      c("kind", "varchar", { length: 16, notNull: true, default: "reply" }), c("visibility", "varchar", { length: 16, notNull: true, default: "public" }),
      c("content", "longtext", { notNull: true }), c("createdAt", "epoch", { notNull: true, default: "now" }),
    ], indexes: [["ticketId", "id"], ["authorId", "createdAt"]],
  },
  {
    name: "support_ticket_attachments",
    columns: [
      c("id", "id"), c("ticketId", "int", { notNull: true }), c("messageId", "int", { notNull: true }),
      c("name", "varchar", { length: 160, notNull: true }), c("mime", "varchar", { length: 64, notNull: true }),
      c("size", "int", { notNull: true }), c("base64", "longtext", { notNull: true }),
    ], indexes: [["ticketId"], ["messageId"]],
  },
  {
    name: "support_ticket_reads",
    columns: [c("id", "id"), c("ticketId", "int", { notNull: true }), c("userId", "int", { notNull: true }), c("version", "int", { notNull: true, default: 0 })],
    unique: [["ticketId", "userId"]], indexes: [["userId"]],
  },
  {
    name: "support_canned_replies",
    columns: [c("id", "id"), c("title", "varchar", { length: 120, notNull: true }), c("content", "longtext", { notNull: true }), c("updatedAt", "epoch", { notNull: true, default: "now" })],
  },
  { name: "ai_bot_workflows", columns: [c("id", "varchar", { length: 96, notNull: true }), c("scopeKey", "varchar", { length: 64, notNull: true }), c("status", "varchar", { length: 32, notNull: true }), c("payload", "longtext", { notNull: true }), c("result", "longtext"), c("updatedAt", "bigint", { notNull: true })], unique: [["id"]], indexes: [["scopeKey"], ["status", "updatedAt"]] },
  {
    name: "agent_installations",
    columns: [c("id", "id"), c("hostId", "int", { notNull: true }), c("installationId", "varchar", { length: 64, notNull: true }), c("createdAt", "epoch", { notNull: true, default: "now" })],
    unique: [["hostId", "installationId"]],
  },
  {
    name: "probe_counter_snapshots",
    columns: [
      c("id", "id"), c("kind", "varchar", { length: 16, notNull: true }),
      c("refId", "int", { notNull: true }), c("hostId", "int", { notNull: true }),
      c("probeKey", "varchar", { length: 64, notNull: true }), c("epoch", "varchar", { length: 64, notNull: true }),
      c("totalCount", "int", { notNull: true }), c("totalSuccesses", "int", { notNull: true }),
      c("batchCount", "int", { notNull: true }), c("batchSuccesses", "int", { notNull: true }),
      c("recordedAt", "epoch", { notNull: true, default: "now" }),
    ],
    unique: [["hostId", "kind", "refId", "probeKey", "epoch", "totalCount"]],
    indexes: [["kind", "refId", "recordedAt"], ["recordedAt"]],
  },
  {
    name: "users",
    columns: [
      c("id", "id"), c("username", "text", { notNull: true }), c("password", "text", { notNull: true }),
      c("googleSubject", "varchar", { length: 255 }), c("googleEmail", "varchar", { length: 254 }), c("googleLinkedAt", "epoch"),
      c("name", "text"), c("email", "text"), c("emailVerified", "bool", { notNull: true, default: false }), c("emailVerifiedAt", "epoch"), c("displayRemark", "text"), c("avatar", "text"),
      c("avatarChangeDay", "varchar", { length: 16 }), c("avatarChangeCount", "int", { notNull: true, default: 0 }), c("role", "varchar", { length: 32, notNull: true, default: "user" }), c("accountEnabled", "bool", { notNull: true, default: true }),
      c("canAddRules", "bool", { notNull: true, default: false }), c("forwardAccessPauseReason", "varchar", { length: 64 }), c("maxRules", "int", { notNull: true, default: 0 }),
      c("maxPorts", "int", { notNull: true, default: 0 }), c("allowedForwardTypes", "text"),
      c("allowForwardXTunnel", "bool", { notNull: true, default: false }), c("gostRateLimitIn", "int", { notNull: true, default: 0 }),
      c("gostRateLimitOut", "int", { notNull: true, default: 0 }), c("maxConnections", "int", { notNull: true, default: 0 }),
      c("maxIPs", "int", { notNull: true, default: 0 }), c("balanceCents", "bigint", { notNull: true, default: 0 }),
      c("manualCanAddRules", "bool", { notNull: true, default: false }), c("manualMaxRules", "int", { notNull: true, default: 0 }),
      c("manualMaxPorts", "int", { notNull: true, default: 0 }), c("manualMaxConnections", "int", { notNull: true, default: 0 }),
      c("manualMaxIPs", "int", { notNull: true, default: 0 }), c("manualAllowForwardXTunnel", "bool", { notNull: true, default: false }),
      c("manualGostRateLimitIn", "int", { notNull: true, default: 0 }), c("manualGostRateLimitOut", "int", { notNull: true, default: 0 }),
      c("manualTrafficLimit", "bigint", { notNull: true, default: 0 }), c("manualExpiresAt", "epoch"),
      c("trafficLimit", "bigint", { notNull: true, default: 0 }), c("trafficUsed", "bigint", { notNull: true, default: 0 }),
      c("trafficBillingResetBytes", "bigint", { notNull: true, default: 0 }),
      c("expiresAt", "epoch"), c("trafficAutoReset", "bool", { notNull: true, default: false }),
      c("trafficResetDay", "int", { notNull: true, default: 1 }), c("lastTrafficReset", "epoch"), c("lastAutoTrafficReset", "epoch"),
      c("telegramId", "text"), c("telegramUsername", "text"), c("telegramFirstName", "text"), c("telegramLastName", "text"),
      c("discordId", "varchar", { length: 32 }), c("discordUsername", "text"),
      c("discordLinkedAt", "epoch"), c("discordLastSeenAt", "epoch"),
      c("discordAnnouncementSubscribed", "bool", { notNull: true, default: false }),
      c("supportTicketNotificationSubscribed", "bool", { notNull: true, default: true }),
      c("animationsEnabled", "bool", { notNull: true, default: true }),
      c("ruleTableLayout", "text"),
      c("hostTableLayout", "text"),
      c("discordBindCode", "varchar", { length: 64 }), c("discordBindCodeExpiresAt", "epoch"),
      c("discordLoginCode", "varchar", { length: 64 }), c("discordLoginCodeExpiresAt", "epoch"),
      c("telegramLinkedAt", "epoch"), c("telegramLastSeenAt", "epoch"), c("telegramAnnouncementSubscribed", "bool", { notNull: true, default: false }), c("telegramBindCode", "text"),
      c("telegramBindCodeExpiresAt", "epoch"), c("telegramLoginCode", "text"), c("telegramLoginCodeExpiresAt", "epoch"),
      c("twoFactorEnabled", "bool", { notNull: true, default: false }), c("twoFactorSecret", "text"), c("twoFactorEnabledAt", "epoch"),
      c("browserSessionToken", "text"), c("mobileSessionToken", "text"), c("telegramSessionToken", "text"),
      c("createdAt", "epoch", { notNull: true, default: "now" }), c("updatedAt", "epoch", { notNull: true, default: "now" }),
      c("lastSignedIn", "epoch", { notNull: true, default: "now" }),
    ],
    unique: [["username"], ["googleSubject"], ["telegramId"], ["telegramBindCode"], ["telegramLoginCode"], ["discordId"], ["discordBindCode"], ["discordLoginCode"]],
  },
  {
    name: "auth_sessions",
    columns: [
      c("id", "id"), c("sid", "varchar", { length: 80, notNull: true }), c("userId", "int", { notNull: true }),
      c("kind", "varchar", { length: 32, notNull: true, default: "browser" }), c("expiresAt", "epoch", { notNull: true }),
      c("revokedAt", "epoch"), c("revokeReason", "varchar", { length: 64 }),
      c("createdAt", "epoch", { notNull: true, default: "now" }), c("lastSeenAt", "epoch", { notNull: true, default: "now" }),
    ],
    unique: [["sid"]],
    indexes: [["userId"], ["userId", "kind"], ["expiresAt"]],
  },
  {
    name: "hosts",
    columns: [
      c("id", "id"), c("name", "text", { notNull: true }), c("ip", "text", { notNull: true }),
      c("ipv4", "text"), c("ipv6", "text"), c("hostType", "varchar", { length: 32, notNull: true, default: "slave" }),
      c("ipv4Addresses", "text"), c("ipv6Addresses", "text"), c("preferredIpv4", "text"), c("preferredIpv6", "text"),
      c("agentToken", "text"), c("agentInstallationId", "varchar", { length: 64 }), c("entryIp", "text"), c("tunnelEntryIp", "text"), c("osInfo", "text"), c("cpuInfo", "text"),
      c("memoryTotal", "bigint"), c("agentVersion", "text"),
      c("mimicAvailable", "bool"), c("mimicVersion", "text"), c("mimicStatus", "varchar", { length: 64 }),
      c("mimicMessage", "text"), c("mimicCheckedAt", "epoch"),
      c("mimicRuntimeStatus", "varchar", { length: 32 }), c("mimicRuntimeMessage", "text"), c("mimicRuntimeCheckedAt", "epoch"),
      c("agentBootId", "varchar", { length: 128 }), c("agentBootedAt", "epoch"), c("agentProcessId", "int"), c("agentProcessStartedAt", "epoch"),
      c("agentLastReceivedRevision", "bigint", { notNull: true, default: 0 }), c("agentLastAppliedRevision", "bigint", { notNull: true, default: 0 }),
      c("agentLastReceivedHash", "varchar", { length: 64 }), c("agentLastAppliedHash", "varchar", { length: 64 }),
      c("agentRecoveryStartedAt", "epoch"), c("agentRecoveryCompletedAt", "epoch"),
      c("agentRecoveryExpected", "int", { notNull: true, default: 0 }), c("agentRecoveryReady", "int", { notNull: true, default: 0 }),
      c("agentUpgradeRequested", "bool", { notNull: true, default: false }),
      c("agentUpgradeTargetVersion", "text"), c("agentUpgradeReleaseVersion", "text"), c("agentUpgradeRequestedAt", "epoch"), c("purchasedAt", "epoch"), c("stoppedAt", "epoch"),
      c("billingCycleMonths", "int", { notNull: true, default: 1 }), c("billingMonth", "int", { notNull: true, default: 1 }),
      c("billingDay", "int", { notNull: true, default: 1 }), c("expiryHandling", "varchar", { length: 24, notNull: true, default: "none" }),
      c("trafficLimit", "bigint", { notNull: true, default: 0 }), c("trafficMeasureMode", "varchar", { length: 16, notNull: true, default: "both" }),
      c("trafficFailoverEnabled", "bool", { notNull: true, default: false }), c("trafficFailoverThresholdPercent", "int", { notNull: true, default: 100 }),
      c("trafficFailoverExcluded", "bool", { notNull: true, default: false }),
      c("trafficShutdownEnabled", "bool", { notNull: true, default: false }), c("trafficShutdownThresholdPercent", "int", { notNull: true, default: 100 }),
      c("trafficShutdownTriggered", "bool", { notNull: true, default: false }),
      c("hostStatusNotifyEnabled", "bool", { notNull: true, default: true }),
      c("resourceAlertConfig", "text"),
      c("telegramTrafficAlertEnabled", "bool", { notNull: true, default: false }), c("trafficAlertThresholdPercent", "int", { notNull: true, default: 20 }),
      c("telegramRenewalReminderEnabled", "bool", { notNull: true, default: false }), c("renewalReminderDays", "int", { notNull: true, default: 3 }),
      c("trafficAutoReset", "bool", { notNull: true, default: false }), c("trafficResetDay", "int", { notNull: true, default: 1 }),
      c("lastTrafficReset", "epoch"), c("ddnsEnabled", "bool", { notNull: true, default: false }), c("ddnsDomain", "text"),
      c("ddnsRecordType", "varchar", { length: 8, notNull: true, default: "A" }), c("ddnsIpVersion", "varchar", { length: 8, notNull: true, default: "ipv4" }),
      c("ddnsAddressMode", "varchar", { length: 16, notNull: true, default: "primary" }),
      c("lastDdnsValue", "text"), c("lastDdnsAt", "epoch"), c("lastDdnsError", "text"), c("networkInterface", "text"), c("sortOrder", "int", { notNull: true, default: 0 }),
      c("geoCountryCode", "varchar", { length: 8 }), c("geoCountryName", "text"), c("geoRegion", "text"), c("geoEmoji", "varchar", { length: 16 }),
      c("geoLatitudeMicro", "int"), c("geoLongitudeMicro", "int"), c("geoUpdatedAt", "epoch"),
      c("portRangeStart", "int"), c("portRangeEnd", "int"), c("portAllowlist", "text"),
      c("blockHttp", "bool", { notNull: true, default: false }), c("blockSocks", "bool", { notNull: true, default: false }),
      c("blockTls", "bool", { notNull: true, default: false }), c("isOnline", "bool", { notNull: true, default: false }),
      c("lastHeartbeat", "epoch"), c("userId", "int", { notNull: true }), c("createdAt", "epoch", { notNull: true, default: "now" }),
      c("updatedAt", "epoch", { notNull: true, default: "now" }),
    ],
    indexes: [
      ["userId"],
      ["userId", "sortOrder"],
      ["userId", "createdAt"],
      ["agentToken"],
      ["isOnline", "lastHeartbeat"],
      ["trafficFailoverExcluded"],
    ],
  },
  {
    name: "host_groups",
    columns: [
      c("id", "id"), c("name", "text", { notNull: true }), c("isEnabled", "bool", { notNull: true, default: true }),
      c("sortOrder", "int", { notNull: true, default: 0 }), c("userId", "int", { notNull: true }),
      c("createdAt", "epoch", { notNull: true, default: "now" }), c("updatedAt", "epoch", { notNull: true, default: "now" }),
    ],
    indexes: [["userId", "sortOrder"], ["userId", "createdAt"], ["isEnabled"]],
  },
  {
    name: "host_group_members",
    columns: [
      c("id", "id"), c("groupId", "int", { notNull: true }), c("hostId", "int", { notNull: true }),
      c("sortOrder", "int", { notNull: true, default: 0 }), c("createdAt", "epoch", { notNull: true, default: "now" }),
    ],
    unique: [["groupId", "hostId"]],
    indexes: [["groupId", "sortOrder"], ["hostId"]],
  },
  {
    name: "rule_groups",
    columns: [
      c("id", "id"), c("userId", "int", { notNull: true }), c("name", "varchar", { length: 64, notNull: true }),
      c("sortOrder", "int", { notNull: true, default: 0 }), c("createdAt", "epoch", { notNull: true, default: "now" }),
    ],
    unique: [["userId", "name"]],
    indexes: [["userId", "sortOrder"]],
  },
  {
    name: "rule_group_members",
    columns: [c("id", "id"), c("userId", "int", { notNull: true }), c("ruleId", "int", { notNull: true }), c("groupId", "int", { notNull: true })],
    unique: [["userId", "ruleId", "groupId"]],
    indexes: [["userId", "groupId", "ruleId"], ["ruleId"]],
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
      c("targetPort", "int", { notNull: true }),
      c("rateLimitMbps", "int", { notNull: true, default: 0 }),
      c("trafficLimit", "bigint", { notNull: true, default: 0 }),
      c("trafficMode", "varchar", { length: 16, notNull: true, default: "both" }),
      c("expiresAt", "epoch"), c("ruleLimitReason", "varchar", { length: 32 }),
      c("adminManaged", "bool", { notNull: true, default: false }),
      c("quotaUsedIn", "bigint"), c("quotaUsedOut", "bigint"),
      c("telegramErrorNotifyEnabled", "bool", { notNull: true, default: false }),
      c("blockHttp", "bool", { notNull: true, default: false }), c("blockSocks", "bool", { notNull: true, default: false }),
      c("blockTls", "bool", { notNull: true, default: false }),
      c("proxyProtocolReceive", "bool", { notNull: true, default: false }), c("proxyProtocolSend", "bool", { notNull: true, default: false }),
      c("proxyProtocolExitReceive", "bool", { notNull: true, default: false }), c("proxyProtocolExitSend", "bool", { notNull: true, default: false }),
      c("proxyProtocolVersion", "int", { notNull: true, default: 1 }),
      c("tcpFastOpen", "bool", { notNull: true, default: false }), c("zeroCopy", "bool", { notNull: true, default: false }),
      c("udpOverTcp", "bool", { notNull: true, default: false }),
      c("udpOverTcpPort", "int"),
      c("protocolBlockReason", "text"), c("isEnabled", "bool", { notNull: true, default: true }),
      c("failoverEnabled", "bool", { notNull: true, default: false }), c("failoverTargets", "text"),
      c("failoverStrategy", "varchar", { length: 32, notNull: true, default: "fallback" }),
      c("failoverSeconds", "int", { notNull: true, default: 60 }), c("recoverSeconds", "int", { notNull: true, default: 120 }),
      c("autoFailback", "bool", { notNull: true, default: true }),
      c("disabledByTunnel", "bool", { notNull: true, default: false }), c("disabledByGroup", "bool", { notNull: true, default: false }),
      c("disabledByUser", "bool", { notNull: true, default: false }),
      c("isRunning", "bool", { notNull: true, default: false }), c("pendingDelete", "bool", { notNull: true, default: false }),
      c("runtimeDiagnostic", "text"),
      c("sortOrder", "int", { notNull: true, default: 0 }),
      c("userId", "int", { notNull: true }), c("createdAt", "epoch", { notNull: true, default: "now" }),
      c("updatedAt", "epoch", { notNull: true, default: "now" }),
    ],
    indexes: [["hostId"], ["hostId", "createdAt"], ["hostId", "sourcePort", "pendingDelete", "isEnabled"], ["userId"], ["userId", "sortOrder"], ["userId", "createdAt"], ["userId", "pendingDelete", "createdAt"], ["tunnelId"], ["forwardGroupId"], ["forwardGroupId", "isForwardGroupTemplate", "pendingDelete"], ["forwardGroupRuleId"], ["forwardGroupRuleId", "pendingDelete"], ["forwardGroupMemberId"], ["forwardGroupMemberId", "pendingDelete"]],
  },
  {
    name: "forward_groups",
    columns: [
      c("id", "id"), c("name", "text", { notNull: true }), c("remark", "text"), c("groupType", "varchar", { length: 32, notNull: true, default: "host" }),
      c("groupMode", "varchar", { length: 32, notNull: true, default: "failover" }), c("exitStrategy", "varchar", { length: 32, notNull: true, default: "round_robin" }), c("entryGroupId", "int"),
      c("forwardType", "varchar", { length: 32, notNull: true, default: "iptables" }), c("failoverRuntimeInheritanceEnabled", "bool", { notNull: true, default: false }), c("domain", "text"),
      c("recordType", "varchar", { length: 16, notNull: true, default: "A" }), c("sourcePort", "int", { notNull: true, default: 1 }),
      c("protocol", "varchar", { length: 16, notNull: true, default: "both" }), c("targetIp", "text", { notNull: true }),
      c("targetPort", "int", { notNull: true, default: 1 }), c("rateLimitMbps", "int", { notNull: true, default: 0 }),
      c("trafficMultiplier", "int", { notNull: true, default: 100 }),
      c("proxyProtocolReceive", "bool", { notNull: true, default: false }), c("proxyProtocolSend", "bool", { notNull: true, default: false }),
      c("proxyProtocolExitReceive", "bool", { notNull: true, default: false }), c("proxyProtocolExitSend", "bool", { notNull: true, default: false }),
      c("proxyProtocolVersion", "int", { notNull: true, default: 1 }),
      c("tcpFastOpen", "bool", { notNull: true, default: false }), c("zeroCopy", "bool", { notNull: true, default: false }),
      c("udpOverTcp", "bool", { notNull: true, default: false }), c("udpOverTcpPort", "int"),
      c("failoverEnabled", "bool", { notNull: true, default: false }), c("failoverTargets", "text"),
      c("failoverStrategy", "varchar", { length: 32, notNull: true, default: "fallback" }),
      c("failoverSeconds", "int", { notNull: true, default: 60 }),
      c("recoverSeconds", "int", { notNull: true, default: 120 }), c("chinaHealthCheckEnabled", "bool", { notNull: true, default: false }), c("chinaHealthCheckTarget", "text"),
      c("telegramSwitchNotifyEnabled", "bool", { notNull: true, default: false }),
      c("ddnsAutoResolveEnabled", "bool", { notNull: true, default: true }), c("autoFailback", "bool", { notNull: true, default: true }),
      c("isEnabled", "bool", { notNull: true, default: true }), c("activeMemberId", "int"), c("lastDdnsValue", "text"),
      c("lastDdnsAt", "epoch"), c("lastFailoverAt", "epoch"), c("lastStatus", "varchar", { length: 32, notNull: true, default: "unknown" }),
      c("lastMessage", "text"), c("sortOrder", "int", { notNull: true, default: 0 }), c("userId", "int", { notNull: true }), c("createdAt", "epoch", { notNull: true, default: "now" }),
      c("updatedAt", "epoch", { notNull: true, default: "now" }),
    ],
    indexes: [["userId"], ["userId", "sortOrder"], ["userId", "createdAt"], ["isEnabled"], ["activeMemberId"], ["entryGroupId"]],
  },
  {
    name: "forward_group_members",
    columns: [
      c("id", "id"), c("groupId", "int", { notNull: true }), c("memberType", "varchar", { length: 32, notNull: true }),
      c("hostId", "int"), c("tunnelId", "int"), c("connectHost", "text"), c("priority", "int", { notNull: true, default: 0 }), c("ruleId", "int"),
      c("syncDiagnostic", "text"),
      c("isEnabled", "bool", { notNull: true, default: true }), c("healthStatus", "varchar", { length: 32, notNull: true, default: "unknown" }),
      c("lastLatencyMs", "int"), c("chinaHealthStatus", "varchar", { length: 32, notNull: true, default: "unknown" }), c("chinaHealthLatencyMs", "int"), c("chinaHealthCheckedAt", "epoch"), c("failureSince", "epoch"), c("healthySince", "epoch"), c("lastCheckedAt", "epoch"),
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
    indexes: [["groupId", "createdAt"], ["createdAt", "groupId"], ["memberId"]],
  },
  {
    name: "tunnels",
    columns: [
      c("id", "id"), c("name", "text", { notNull: true }), c("entryGroupId", "int"), c("exitGroupId", "int"), c("entryHostId", "int", { notNull: true }),
      c("exitHostId", "int", { notNull: true }), c("mode", "varchar", { length: 32, notNull: true, default: "tls" }),
      c("relayMode", "varchar", { length: 16, notNull: true, default: "chain" }),
      c("forwardxVersion", "varchar", { length: 8, notNull: true, default: "v1" }), c("certDomain", "text"),
      // V3 outer-transport options (null for v1/v2 tunnels).
      c("v3Transport", "varchar", { length: 8 }), c("v3Host", "text"), c("v3Path", "text"),
      c("v3UserAgent", "text"), c("v3ServerName", "text"), c("v3Multiplex", "bool"),
      c("certPem", "text"), c("certKeyPem", "text"),
      c("secret", "text"), c("listenPort", "int", { notNull: true }), c("mimicPort", "int", { notNull: true, default: 0 }),
      c("rateLimitMbps", "int", { notNull: true, default: 0 }),
      c("trafficMultiplier", "int", { notNull: true, default: 100 }),
      // Legacy columns retained for migration compatibility; runtime ignores them.
      c("trafficPaddingEnabled", "bool", { notNull: true, default: false }),
      c("trafficPaddingRatio", "int", { notNull: true, default: 0 }),
      c("trafficPaddingMaxMbps", "int", { notNull: true, default: 0 }),
      c("portRangeStart", "int"), c("portRangeEnd", "int"),
      c("networkType", "varchar", { length: 32, notNull: true, default: "public" }), c("connectHost", "text"),
      c("proxyProtocolReceive", "bool", { notNull: true, default: false }), c("proxyProtocolSend", "bool", { notNull: true, default: false }),
      c("proxyProtocolExitReceive", "bool", { notNull: true, default: false }), c("proxyProtocolExitSend", "bool", { notNull: true, default: false }),
      c("proxyProtocolVersion", "int", { notNull: true, default: 1 }),
      c("tcpFastOpen", "bool", { notNull: true, default: false }), c("udpOverTcp", "bool", { notNull: true, default: false }),
      c("blockHttp", "bool", { notNull: true, default: false }), c("blockSocks", "bool", { notNull: true, default: false }),
      c("blockTls", "bool", { notNull: true, default: false }), c("loadBalanceEnabled", "bool", { notNull: true, default: false }),
      c("loadBalanceStrategy", "varchar", { length: 32, notNull: true, default: "round_robin" }),
      c("isEnabled", "bool", { notNull: true, default: true }), c("disabledByGroup", "bool", { notNull: true, default: false }),
      c("isRunning", "bool", { notNull: true, default: false }),
      c("lastLatencyMs", "int"), c("lastTestStatus", "text"), c("lastTestMessage", "longtext"), c("lastTestAt", "epoch"),
      c("sortOrder", "int", { notNull: true, default: 0 }), c("userId", "int", { notNull: true }), c("createdAt", "epoch", { notNull: true, default: "now" }),
      c("updatedAt", "epoch", { notNull: true, default: "now" }),
    ],
    indexes: [["entryGroupId"], ["exitGroupId"], ["entryHostId"], ["exitHostId"], ["userId"], ["userId", "sortOrder"], ["userId", "createdAt"]],
  },
  { name: "tunnel_exit_nodes", columns: [c("id", "id"), c("tunnelId", "int", { notNull: true }), c("seq", "int", { notNull: true }), c("hostId", "int", { notNull: true }), c("listenPort", "int", { notNull: true }), c("mimicPort", "int", { notNull: true, default: 0 }), c("connectHost", "text"), c("isEnabled", "bool", { notNull: true, default: true }), c("createdAt", "epoch", { notNull: true, default: "now" }), c("updatedAt", "epoch", { notNull: true, default: "now" })], unique: [["tunnelId", "seq"]], indexes: [["tunnelId"], ["hostId"], ["hostId", "listenPort"]] },
  { name: "tunnel_hops", columns: [c("id", "id"), c("tunnelId", "int", { notNull: true }), c("seq", "int", { notNull: true }), c("hostId", "int", { notNull: true }), c("listenPort", "int", { notNull: true, default: 0 }), c("mimicPort", "int", { notNull: true, default: 0 }), c("connectHost", "text")], unique: [["tunnelId", "seq"]], indexes: [["tunnelId"], ["hostId"]] },
  { name: "forward_rule_tunnel_exits", columns: [c("id", "id"), c("ruleId", "int", { notNull: true }), c("tunnelId", "int", { notNull: true }), c("exitNodeId", "int", { notNull: true }), c("exitSeq", "int", { notNull: true }), c("exitHostId", "int", { notNull: true }), c("tunnelExitPort", "int", { notNull: true }), c("createdAt", "epoch", { notNull: true, default: "now" }), c("updatedAt", "epoch", { notNull: true, default: "now" })], unique: [["ruleId", "exitNodeId"], ["ruleId", "exitSeq"]], indexes: [["ruleId"], ["tunnelId"], ["exitHostId"], ["exitHostId", "tunnelExitPort"]] },
  { name: "host_metrics", columns: [c("id", "id"), c("hostId", "int", { notNull: true }), c("cpuUsage", "int"), c("load1", "real"), c("load5", "real"), c("load15", "real"), c("memoryUsage", "int"), c("memoryUsed", "bigint"), c("swapUsage", "int"), c("swapUsed", "bigint"), c("swapTotal", "bigint"), c("networkIn", "bigint"), c("networkOut", "bigint"), c("diskUsage", "int"), c("diskUsed", "bigint"), c("diskTotal", "bigint"), c("uptime", "bigint"), c("recordedAt", "epoch", { notNull: true, default: "now" })], indexes: [["hostId", "recordedAt"], ["recordedAt", "hostId"]] },
  { name: "host_traffic_counters", columns: [c("id", "id"), c("hostId", "int", { notNull: true }), c("bytesIn", "bigint", { notNull: true, default: 0 }), c("bytesOut", "bigint", { notNull: true, default: 0 }), c("lastSystemIn", "bigint"), c("lastSystemOut", "bigint"), c("lastDeltaIn", "bigint", { notNull: true, default: 0 }), c("lastDeltaOut", "bigint", { notNull: true, default: 0 }), c("lastReportedAt", "epoch"), c("resetAt", "epoch"), c("createdAt", "epoch", { notNull: true, default: "now" }), c("updatedAt", "epoch", { notNull: true, default: "now" })], unique: [["hostId"]], indexes: [["updatedAt"], ["lastReportedAt"]] },
  { name: "user_traffic_counters", columns: [c("id", "id"), c("userId", "int", { notNull: true }), c("bytesIn", "bigint", { notNull: true, default: 0 }), c("bytesOut", "bigint", { notNull: true, default: 0 }), c("connections", "int", { notNull: true, default: 0 }), c("createdAt", "epoch", { notNull: true, default: "now" }), c("updatedAt", "epoch", { notNull: true, default: "now" })], unique: [["userId"]], indexes: [["updatedAt"]] },
  { name: "forward_rule_traffic_counters", columns: [c("id", "id"), c("ruleId", "int", { notNull: true }), c("hostId", "int", { notNull: true }), c("userId", "int", { notNull: true }), c("bytesIn", "bigint", { notNull: true, default: 0 }), c("bytesOut", "bigint", { notNull: true, default: 0 }), c("connections", "int", { notNull: true, default: 0 }), c("createdAt", "epoch", { notNull: true, default: "now" }), c("updatedAt", "epoch", { notNull: true, default: "now" })], unique: [["ruleId", "hostId"]], indexes: [["userId"], ["ruleId"], ["hostId"], ["updatedAt"]] },
  { name: "traffic_stats", columns: [c("id", "id"), c("ruleId", "int", { notNull: true }), c("hostId", "int", { notNull: true }), c("bytesIn", "bigint", { notNull: true, default: 0 }), c("bytesOut", "bigint", { notNull: true, default: 0 }), c("connections", "int", { notNull: true, default: 0 }), c("recordedAt", "epoch", { notNull: true, default: "now" })], indexes: [["ruleId", "recordedAt"], ["hostId", "recordedAt"], ["recordedAt", "ruleId"], ["recordedAt", "hostId"]] },
  { name: "traffic_stat_buckets", columns: [c("id", "id"), c("bucketStart", "epoch", { notNull: true }), c("bucketMinutes", "int", { notNull: true, default: 30 }), c("userId", "int", { notNull: true }), c("ruleId", "int", { notNull: true }), c("hostId", "int", { notNull: true }), c("bytesIn", "bigint", { notNull: true, default: 0 }), c("bytesOut", "bigint", { notNull: true, default: 0 }), c("connections", "int", { notNull: true, default: 0 }), c("updatedAt", "epoch", { notNull: true, default: "now" })], unique: [["bucketStart", "bucketMinutes", "ruleId", "hostId"]], indexes: [["userId", "bucketStart"], ["bucketStart", "userId"], ["bucketMinutes", "bucketStart"], ["bucketMinutes", "userId", "bucketStart"], ["bucketMinutes", "ruleId", "bucketStart"], ["bucketMinutes", "hostId", "bucketStart"], ["ruleId", "bucketStart"], ["hostId", "bucketStart"]] },
  { name: "agent_traffic_reports", columns: [c("id", "id"), c("hostId", "int", { notNull: true }), c("producerId", "varchar", { length: 128 }), c("reportId", "varchar", { length: 128, notNull: true }), c("receivedAt", "epoch", { notNull: true, default: "now" })], unique: [["hostId", "reportId"], ["hostId", "producerId"]], indexes: [["receivedAt"]] },
  { name: "tunnel_latency_stats", columns: [c("id", "id"), c("tunnelId", "int", { notNull: true }), c("seriesKey", "varchar", { length: 64 }), c("seriesLabel", "text"), c("latencyMs", "int"), c("isTimeout", "bool", { notNull: true, default: false }), c("probeCount", "int", { notNull: true, default: 1 }), c("probeSuccesses", "int", { notNull: true, default: 0 }), c("recordedAt", "epoch", { notNull: true, default: "now" })], indexes: [["tunnelId", "recordedAt"], ["tunnelId", "seriesKey", "recordedAt"], ["recordedAt", "tunnelId"]] },
  { name: "forward_group_latency_stats", columns: [c("id", "id"), c("groupId", "int", { notNull: true }), c("latencyMs", "int"), c("isTimeout", "bool", { notNull: true, default: false }), c("probeCount", "int", { notNull: true, default: 1 }), c("probeSuccesses", "int", { notNull: true, default: 0 }), c("recordedAt", "epoch", { notNull: true, default: "now" })], indexes: [["groupId", "recordedAt"], ["recordedAt", "groupId"]] },
  { name: "host_probe_services", columns: [c("id", "id"), c("name", "text", { notNull: true }), c("method", "varchar", { length: 16, notNull: true, default: "tcping" }), c("targetIp", "text", { notNull: true }), c("targetPort", "int"), c("targetUrl", "text"), c("timeoutSeconds", "int", { notNull: true, default: 5 }), c("expectedStatus", "int", { notNull: true, default: 200 }), c("hostScope", "varchar", { length: 16, notNull: true, default: "all" }), c("hostIds", "text"), c("excludeHostIds", "text"), c("intervalSeconds", "int", { notNull: true, default: 30 }), c("isEnabled", "bool", { notNull: true, default: true }), c("sortOrder", "int", { notNull: true, default: 0 }), c("userId", "int", { notNull: true }), c("createdAt", "epoch", { notNull: true, default: "now" }), c("updatedAt", "epoch", { notNull: true, default: "now" })], indexes: [["userId", "sortOrder"], ["userId", "createdAt"], ["isEnabled"], ["hostScope"]] },
  { name: "host_probe_service_stats", columns: [c("id", "id"), c("serviceId", "int", { notNull: true }), c("hostId", "int", { notNull: true }), c("latencyMs", "int"), c("isTimeout", "bool", { notNull: true, default: false }), c("probeCount", "int", { notNull: true, default: 1 }), c("probeSuccesses", "int", { notNull: true, default: 0 }), c("recordedAt", "epoch", { notNull: true, default: "now" })], indexes: [["serviceId", "recordedAt"], ["hostId", "recordedAt"], ["recordedAt", "serviceId"], ["serviceId", "hostId", "recordedAt"], ["serviceId", "id"], ["serviceId", "hostId", "id"]] },
  { name: "ip_geo_cache", columns: [c("id", "id"), c("address", "varchar", { length: 253, notNull: true }), c("resolvedAddress", "varchar", { length: 64, notNull: true }), c("geoCountryCode", "varchar", { length: 8, notNull: true }), c("geoCountryName", "text"), c("geoRegion", "text"), c("geoEmoji", "varchar", { length: 16 }), c("geoLatitudeMicro", "int"), c("geoLongitudeMicro", "int"), c("provider", "varchar", { length: 32, notNull: true, default: "ipapi.co" }), c("fetchedAt", "epoch", { notNull: true, default: "now" }), c("expiresAt", "epoch", { notNull: true })], unique: [["address"]], indexes: [["resolvedAddress"], ["expiresAt"]] },
  { name: "agent_tokens", columns: [c("id", "id"), c("token", "text", { notNull: true }), c("hostId", "int"), c("description", "text"), c("isUsed", "bool", { notNull: true, default: false }), c("sortOrder", "int", { notNull: true, default: 0 }), c("userId", "int", { notNull: true }), c("createdAt", "epoch", { notNull: true, default: "now" })], unique: [["token"]], indexes: [["userId"], ["userId", "sortOrder"]] },
  { name: "tcping_stats", columns: [c("id", "id"), c("ruleId", "int", { notNull: true }), c("hostId", "int", { notNull: true }), c("latencyMs", "int"), c("isTimeout", "bool", { notNull: true, default: false }), c("probeCount", "int", { notNull: true, default: 1 }), c("probeSuccesses", "int", { notNull: true, default: 0 }), c("healthStatus", "varchar", { length: 16 }), c("healthPending", "bool", { notNull: true, default: false }), c("recordedAt", "epoch", { notNull: true, default: "now" })], indexes: [["ruleId", "recordedAt"], ["hostId", "recordedAt"], ["recordedAt", "ruleId"], ["recordedAt", "hostId"]] },
  { name: "forward_tests", columns: [c("id", "id"), c("ruleId", "int", { notNull: true }), c("hostId", "int", { notNull: true }), c("userId", "int", { notNull: true }), c("status", "varchar", { length: 32, notNull: true, default: "pending" }), c("listenOk", "bool", { notNull: true, default: false }), c("targetReachable", "bool", { notNull: true, default: false }), c("forwardOk", "bool", { notNull: true, default: false }), c("latencyMs", "int"), c("message", "longtext"), c("requestMessage", "text"), c("batchId", "varchar", { length: 96 }), c("batchSettled", "bool", { notNull: true, default: false }), c("firstDispatchedAt", "epoch"), c("createdAt", "epoch", { notNull: true, default: "now" }), c("updatedAt", "epoch", { notNull: true, default: "now" })], indexes: [["ruleId", "createdAt"], ["hostId", "status"], ["batchId"], ["batchSettled", "batchId"], ["status", "createdAt"], ["status", "updatedAt"], ["updatedAt"]] },
  { name: "user_host_permissions", columns: [c("id", "id"), c("userId", "int", { notNull: true }), c("hostId", "int", { notNull: true }), c("createdAt", "epoch", { notNull: true, default: "now" })], unique: [["userId", "hostId"]], indexes: [["hostId"]] },
  { name: "user_tunnel_permissions", columns: [c("id", "id"), c("userId", "int", { notNull: true }), c("tunnelId", "int", { notNull: true }), c("createdAt", "epoch", { notNull: true, default: "now" })], unique: [["userId", "tunnelId"]], indexes: [["tunnelId"]] },
  { name: "user_forward_group_permissions", columns: [c("id", "id"), c("userId", "int", { notNull: true }), c("forwardGroupId", "int", { notNull: true }), c("createdAt", "epoch", { notNull: true, default: "now" })], unique: [["userId", "forwardGroupId"]], indexes: [["forwardGroupId"]] },
  { name: "system_settings", columns: [c("key", "varchar", { length: 191, notNull: true }), c("value", "longtext"), c("updatedAt", "epoch", { notNull: true, default: "now" })], unique: [["key"]] },
  { name: "payment_orders", columns: [c("id", "id"), c("outTradeNo", "text", { notNull: true }), c("userId", "int", { notNull: true }), c("provider", "varchar", { length: 32, notNull: true }), c("paymentType", "varchar", { length: 32, notNull: true }), c("status", "varchar", { length: 32, notNull: true, default: "pending" }), c("subject", "text", { notNull: true }), c("amountCents", "bigint", { notNull: true }), c("currency", "varchar", { length: 16, notNull: true, default: "CNY" }), c("tradeNo", "text"), c("payUrl", "text"), c("qrCode", "text"), c("orderType", "varchar", { length: 32, notNull: true, default: "balance" }), c("planId", "int"), c("subscriptionId", "int"), c("discountCodeId", "int"), c("discountConsumed", "bool", { notNull: true, default: false }), c("stockReserved", "bool", { notNull: true, default: false }), c("discountAmountCents", "bigint", { notNull: true, default: 0 }), c("clientIp", "text"), c("rawNotify", "text"), c("merchantIdentity", "text"), c("failureReason", "text"), c("lastPaymentCheckAt", "epoch"), c("expiresAt", "epoch"), c("paidAt", "epoch"), c("createdAt", "epoch", { notNull: true, default: "now" }), c("updatedAt", "epoch", { notNull: true, default: "now" })], unique: [["outTradeNo"]], indexes: [["userId", "createdAt"], ["status", "createdAt"], ["status", "lastPaymentCheckAt"]] },
  { name: "subscription_plans", columns: [c("id", "id"), c("name", "text", { notNull: true }), c("description", "text"), c("stockLimit", "int", { notNull: true, default: 0 }), c("stockUsed", "int", { notNull: true, default: 0 }), c("priceCents", "bigint", { notNull: true, default: 0 }), c("currency", "varchar", { length: 16, notNull: true, default: "CNY" }), c("durationDays", "int", { notNull: true, default: 30 }), c("portCount", "int", { notNull: true, default: 20 }), c("trafficLimit", "bigint", { notNull: true, default: 0 }), c("rateLimitMbps", "int", { notNull: true, default: 0 }), c("maxRules", "int", { notNull: true, default: 20 }), c("maxConnections", "int", { notNull: true, default: 2000 }), c("maxIPs", "int", { notNull: true, default: 10 }), c("isActive", "bool", { notNull: true, default: true }), c("isStoreVisible", "bool", { notNull: true, default: true }), c("sortOrder", "int", { notNull: true, default: 0 }), c("createdAt", "epoch", { notNull: true, default: "now" }), c("updatedAt", "epoch", { notNull: true, default: "now" })] },
  { name: "subscription_plan_hosts", columns: [c("id", "id"), c("planId", "int", { notNull: true }), c("hostId", "int", { notNull: true }), c("createdAt", "epoch", { notNull: true, default: "now" })], unique: [["planId", "hostId"]] },
  { name: "subscription_plan_tunnels", columns: [c("id", "id"), c("planId", "int", { notNull: true }), c("tunnelId", "int", { notNull: true }), c("createdAt", "epoch", { notNull: true, default: "now" })], unique: [["planId", "tunnelId"]] },
  { name: "subscription_plan_forward_groups", columns: [c("id", "id"), c("planId", "int", { notNull: true }), c("forwardGroupId", "int", { notNull: true }), c("createdAt", "epoch", { notNull: true, default: "now" })], unique: [["planId", "forwardGroupId"]], indexes: [["forwardGroupId"]] },
  { name: "subscription_plan_traffic_addons", columns: [c("id", "id"), c("planId", "int", { notNull: true }), c("trafficBytes", "bigint", { notNull: true, default: 0 }), c("priceCents", "bigint", { notNull: true, default: 0 }), c("isActive", "bool", { notNull: true, default: true }), c("sortOrder", "int", { notNull: true, default: 0 }), c("createdAt", "epoch", { notNull: true, default: "now" }), c("updatedAt", "epoch", { notNull: true, default: "now" })], indexes: [["planId", "isActive"], ["planId", "sortOrder"]] },
  { name: "user_subscriptions", columns: [c("id", "id"), c("userId", "int", { notNull: true }), c("planId", "int", { notNull: true }), c("status", "varchar", { length: 32, notNull: true, default: "active" }), c("source", "varchar", { length: 32, notNull: true, default: "admin" }), c("paymentOrderNo", "text"), c("planSnapshot", "text"), c("portRangeStart", "int"), c("portRangeEnd", "int"), c("nextTrafficResetAt", "epoch"), c("lastTrafficResetAt", "epoch"), c("userDismissedAt", "epoch"), c("adminDismissedAt", "epoch"), c("startedAt", "epoch", { notNull: true, default: "now" }), c("expiresAt", "epoch"), c("createdAt", "epoch", { notNull: true, default: "now" }), c("updatedAt", "epoch", { notNull: true, default: "now" })], indexes: [["userId", "status", "expiresAt"], ["planId"], ["paymentOrderNo"]] },
  { name: "user_traffic_addons", columns: [c("id", "id"), c("userId", "int", { notNull: true }), c("subscriptionId", "int", { notNull: true }), c("planId", "int", { notNull: true }), c("addonId", "int"), c("trafficBytes", "bigint", { notNull: true, default: 0 }), c("priceCents", "bigint", { notNull: true, default: 0 }), c("source", "varchar", { length: 32, notNull: true, default: "user" }), c("status", "varchar", { length: 32, notNull: true, default: "active" }), c("operatorUserId", "int"), c("description", "text"), c("cycleResetAt", "epoch"), c("expiresAt", "epoch"), c("expiredAt", "epoch"), c("createdAt", "epoch", { notNull: true, default: "now" }), c("updatedAt", "epoch", { notNull: true, default: "now" })], indexes: [["userId", "status", "expiresAt"], ["subscriptionId", "status"], ["addonId"]] },
  { name: "balance_transactions", columns: [c("id", "id"), c("userId", "int", { notNull: true }), c("type", "varchar", { length: 32, notNull: true }), c("amountCents", "bigint", { notNull: true }), c("balanceAfterCents", "bigint", { notNull: true }), c("description", "text"), c("operatorUserId", "int"), c("paymentOrderNo", "text"), c("redemptionCodeId", "int"), c("createdAt", "epoch", { notNull: true, default: "now" })], indexes: [["userId", "createdAt"], ["paymentOrderNo"]] },
  { name: "traffic_billing_configs", columns: [c("id", "id"), c("sortOrder", "int", { notNull: true, default: 0 }), c("name", "varchar", { length: 255, notNull: true, default: "" }), c("stockLimit", "int", { notNull: true, default: 0 }), c("maxRulesPerUser", "int", { notNull: true, default: 0 }), c("resourceType", "varchar", { length: 16, notNull: true }), c("resourceId", "int", { notNull: true }), c("enabled", "bool", { notNull: true, default: true }), c("requiresPermission", "bool", { notNull: true, default: false }), c("description", "text"), c("pricePerGbCents", "bigint", { notNull: true, default: 0 }), c("pricePerGbMilliCents", "bigint", { notNull: true, default: 0 }), c("multiplier", "int", { notNull: true, default: 100 }), c("createdAt", "epoch", { notNull: true, default: "now" }), c("updatedAt", "epoch", { notNull: true, default: "now" })], unique: [["resourceType", "resourceId"]], indexes: [["enabled"], ["requiresPermission"]] },
  { name: "traffic_billing_records", columns: [c("id", "id"), c("userId", "int", { notNull: true }), c("ruleId", "int", { notNull: true }), c("resourceType", "varchar", { length: 16, notNull: true }), c("resourceId", "int", { notNull: true }), c("bytes", "bigint", { notNull: true, default: 0 }), c("billedGb", "int", { notNull: true, default: 0 }), c("pricePerGbCents", "bigint", { notNull: true, default: 0 }), c("pricePerGbMilliCents", "bigint", { notNull: true, default: 0 }), c("multiplier", "int", { notNull: true, default: 100 }), c("amountCents", "bigint", { notNull: true, default: 0 }), c("balanceAfterCents", "bigint", { notNull: true, default: 0 }), c("createdAt", "epoch", { notNull: true, default: "now" })], indexes: [["userId", "createdAt"], ["resourceType", "resourceId", "createdAt"], ["ruleId", "createdAt"]] },
  { name: "traffic_billing_usage", columns: [c("id", "id"), c("userId", "int", { notNull: true }), c("resourceType", "varchar", { length: 16, notNull: true }), c("resourceId", "int", { notNull: true }), c("totalBytes", "bigint", { notNull: true, default: 0 }), c("billedGb", "int", { notNull: true, default: 0 }), c("pendingMilliCents", "bigint", { notNull: true, default: 0 }), c("updatedAt", "epoch", { notNull: true, default: "now" })], unique: [["userId", "resourceType", "resourceId"]], indexes: [["resourceType", "resourceId"]] },
  { name: "traffic_billing_rule_usage", columns: [c("id", "id"), c("userId", "int", { notNull: true }), c("ruleId", "int", { notNull: true }), c("resourceType", "varchar", { length: 16, notNull: true }), c("resourceId", "int", { notNull: true }), c("totalBytes", "bigint", { notNull: true, default: 0 }), c("billedGb", "int", { notNull: true, default: 0 }), c("pendingMilliCents", "bigint", { notNull: true, default: 0 }), c("settled", "bool", { notNull: true, default: false }), c("updatedAt", "epoch", { notNull: true, default: "now" })], unique: [["ruleId", "resourceType", "resourceId"]], indexes: [["userId", "resourceType", "resourceId"], ["resourceType", "resourceId"]] },
  { name: "user_traffic_billing_permissions", columns: [c("id", "id"), c("userId", "int", { notNull: true }), c("resourceType", "varchar", { length: 16, notNull: true }), c("resourceId", "int", { notNull: true }), c("createdAt", "epoch", { notNull: true, default: "now" })], unique: [["userId", "resourceType", "resourceId"]], indexes: [["userId"], ["resourceType", "resourceId"]] },
  { name: "redemption_codes", columns: [c("id", "id"), c("code", "text", { notNull: true }), c("type", "varchar", { length: 32, notNull: true }), c("planId", "int"), c("durationDays", "int"), c("amountCents", "bigint", { notNull: true, default: 0 }), c("startsAt", "epoch"), c("expiresAt", "epoch"), c("isActive", "bool", { notNull: true, default: true }), c("usedByUserId", "int"), c("usedAt", "epoch"), c("createdByUserId", "int"), c("createdAt", "epoch", { notNull: true, default: "now" }), c("updatedAt", "epoch", { notNull: true, default: "now" })], unique: [["code"]], indexes: [["isActive", "startsAt", "expiresAt", "usedAt"]] },
  { name: "discount_codes", columns: [c("id", "id"), c("code", "text", { notNull: true }), c("discountType", "varchar", { length: 32, notNull: true }), c("discountValue", "int", { notNull: true }), c("maxUses", "int", { notNull: true, default: 0 }), c("usedCount", "int", { notNull: true, default: 0 }), c("startsAt", "epoch"), c("expiresAt", "epoch"), c("isActive", "bool", { notNull: true, default: true }), c("createdByUserId", "int"), c("createdAt", "epoch", { notNull: true, default: "now" }), c("updatedAt", "epoch", { notNull: true, default: "now" })], unique: [["code"]], indexes: [["isActive", "startsAt", "expiresAt", "usedCount"]] },
  { name: "discount_code_plans", columns: [c("id", "id"), c("discountCodeId", "int", { notNull: true }), c("planId", "int", { notNull: true }), c("createdAt", "epoch", { notNull: true, default: "now" })], unique: [["discountCodeId", "planId"]], indexes: [["planId"]] },
  { name: "announcements", columns: [c("id", "id"), c("title", "text", { notNull: true }), c("content", "text", { notNull: true }), c("type", "varchar", { length: 32, notNull: true, default: "normal" }), c("targetVersion", "text"), c("isActive", "bool", { notNull: true, default: true }), c("startsAt", "epoch"), c("expiresAt", "epoch"), c("createdByUserId", "int"), c("createdAt", "epoch", { notNull: true, default: "now" }), c("updatedAt", "epoch", { notNull: true, default: "now" })], indexes: [["type", "isActive", "updatedAt"], ["type", "targetVersion", "isActive"]] },
  { name: "announcement_reads", columns: [c("id", "id"), c("announcementId", "int", { notNull: true }), c("userId", "int", { notNull: true }), c("dismissedAt", "epoch", { notNull: true, default: "now" })], unique: [["announcementId", "userId"]], indexes: [["userId", "announcementId"]] },
  { name: "plugins", columns: [c("id", "id"), c("pluginId", "varchar", { length: 128, notNull: true }), c("name", "text", { notNull: true }), c("version", "varchar", { length: 64, notNull: true, default: "0.0.0" }), c("description", "text"), c("author", "text"), c("homepage", "text"), c("repository", "text"), c("sourceType", "varchar", { length: 32, notNull: true, default: "github" }), c("sourceUrl", "text"), c("branch", "varchar", { length: 128 }), c("manifestPath", "text"), c("manifestJson", "text", { notNull: true }), c("permissionsJson", "text"), c("extensionPointsJson", "text"), c("status", "varchar", { length: 32, notNull: true, default: "disabled" }), c("trusted", "bool", { notNull: true, default: false }), c("installedAt", "epoch", { notNull: true, default: "now" }), c("updatedAt", "epoch", { notNull: true, default: "now" }), c("lastCheckedAt", "epoch"), c("latestVersion", "varchar", { length: 64 }), c("lastError", "text")], unique: [["pluginId"]], indexes: [["status"], ["sourceType"]] },
  { name: "plugin_store_sources", columns: [c("id", "id"), c("name", "text", { notNull: true }), c("repository", "text", { notNull: true }), c("branch", "varchar", { length: 128, notNull: true, default: "main" }), c("catalogPath", "text", { notNull: true, default: "forwardx-store.json" }), c("itemsJson", "text"), c("lastSyncedAt", "epoch"), c("lastError", "text"), c("createdAt", "epoch", { notNull: true, default: "now" }), c("updatedAt", "epoch", { notNull: true, default: "now" })], unique: [["repository", "branch", "catalogPath"]], indexes: [["updatedAt"]] },
  { name: "plugin_assets", columns: [c("id", "id"), c("pluginId", "varchar", { length: 128, notNull: true }), c("path", "text", { notNull: true }), c("contentType", "varchar", { length: 128 }), c("size", "int", { notNull: true, default: 0 }), c("sha256", "varchar", { length: 64 }), c("content", "text"), c("createdAt", "epoch", { notNull: true, default: "now" }), c("updatedAt", "epoch", { notNull: true, default: "now" })], unique: [["pluginId", "path"]], indexes: [["pluginId"]] },
  { name: "plugin_agent_states", columns: [c("id", "id"), c("pluginId", "varchar", { length: 128, notNull: true }), c("resourceViewId", "varchar", { length: 128, notNull: true }), c("hostId", "int", { notNull: true }), c("pluginVersion", "varchar", { length: 64 }), c("actionId", "varchar", { length: 128 }), c("groupId", "varchar", { length: 64 }), c("taskId", "varchar", { length: 64 }), c("status", "varchar", { length: 32, notNull: true, default: "idle" }), c("dataJson", "text"), c("output", "text"), c("error", "text"), c("startedAt", "epoch"), c("finishedAt", "epoch"), c("createdAt", "epoch", { notNull: true, default: "now" }), c("updatedAt", "epoch", { notNull: true, default: "now" })], unique: [["pluginId", "resourceViewId", "hostId"]], indexes: [["hostId"], ["pluginId", "resourceViewId"], ["groupId"]] },
  { name: "config_audit_events", columns: [c("id", "id"), c("resourceType", "varchar", { length: 32, notNull: true }), c("resourceId", "int", { notNull: true }), c("hostId", "int"), c("action", "varchar", { length: 32, notNull: true }), c("source", "varchar", { length: 64, notNull: true, default: "system" }), c("actorUserId", "int"), c("actorName", "text"), c("requestId", "varchar", { length: 64 }), c("requestPath", "text"), c("beforeJson", "text"), c("afterJson", "text"), c("diffJson", "text"), c("configHash", "varchar", { length: 64, notNull: true }), c("createdAt", "epoch", { notNull: true, default: "now" })], indexes: [["resourceType", "resourceId", "id"], ["hostId", "id"], ["actorUserId", "id"]] },
];

// Date-range reporting also needs time-leading indexes for the admin "all
// users" scope; existing user-leading indexes cover individual accounts.
for (const [name, indexes] of [
  ["payment_orders", [["createdAt"], ["paidAt"], ["userId", "paidAt"]]],
  ["balance_transactions", [["createdAt"]]],
  ["user_subscriptions", [["createdAt"], ["userId", "createdAt"]]],
] as const) {
  const table = tables.find(table => table.name === name)!;
  table.indexes = [...(table.indexes || []), ...indexes.map(columns => [...columns])];
}

const seedSettings = [
  ["storeEnabled", "false"],
  ["registrationEnabled", "true"],
  ["homepageEnabled", "true"],
  ["homepageCustomEnabled", "false"],
  ["personalizationTheme", "ink"],
  ["lookingGlassUserEnabled", "true"],
  ["allowMultiDeviceLogin", "false"],
  ["publicHostMonitorEnabled", "false"],
  ["publicHostMonitorPath", "dev"],
  ["publicHostMonitorTitle", ""],
  ["redemptionEnabled", "true"],
  ["discountEnabled", "true"],
  ["trafficBillingEnabled", "false"],
  ["pluginsEnabled", "false"],
  ["twoFactorEnabled", "false"],
  ["ddnsTtl", "600"],
] as const;

export function getDatabaseTableDefs(): readonly TableDef[] {
  return tables;
}

type SchemaKind = "mysql" | "sqlite" | "postgresql";

function quote(kind: SchemaKind, id: string) {
  if (kind === "mysql") return `\`${id.replace(/`/g, "``")}\``;
  return `"${id.replace(/"/g, "\"\"")}"`;
}

function defaultSql(kind: SchemaKind, value: ColumnDef["default"], columnType?: ColumnType) {
  if (value === undefined || value === null) return "";
  if (kind === "mysql" && (columnType === "text" || columnType === "longtext")) return "";
  if (value === "now") {
    if (kind === "mysql") return " DEFAULT (UNIX_TIMESTAMP())";
    if (kind === "postgresql") return " DEFAULT (EXTRACT(EPOCH FROM NOW())::INT)";
    return " DEFAULT (unixepoch())";
  }
  if (typeof value === "boolean") {
    return kind === "postgresql" ? ` DEFAULT ${value ? "TRUE" : "FALSE"}` : ` DEFAULT ${value ? 1 : 0}`;
  }
  if (typeof value === "number") return ` DEFAULT ${value}`;
  return ` DEFAULT '${String(value).replace(/'/g, "''")}'`;
}

function columnSql(kind: SchemaKind, column: ColumnDef, forAlter = false) {
  const name = quote(kind, column.name);
  if (column.type === "id") {
    if (forAlter) return "";
    if (kind === "mysql") return `${name} BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY`;
    if (kind === "postgresql") return `${name} BIGSERIAL PRIMARY KEY`;
    return `${name} INTEGER PRIMARY KEY AUTOINCREMENT`;
  }
  const type = kind === "sqlite"
    ? (column.type === "varchar" || column.type === "text" || column.type === "longtext" ? "TEXT" : column.type === "real" ? "REAL" : "INTEGER")
    : kind === "postgresql"
      ? ({
        text: "TEXT",
        longtext: "TEXT",
        varchar: `VARCHAR(${column.length || 191})`,
        int: "INTEGER",
        bigint: "BIGINT",
        real: "DOUBLE PRECISION",
        bool: "BOOLEAN",
        epoch: "INTEGER",
      } as Record<ColumnType, string>)[column.type]
    : ({
      text: "TEXT",
      longtext: "LONGTEXT",
      varchar: `VARCHAR(${column.length || 191})`,
      int: "INT",
      bigint: "BIGINT",
      real: "DOUBLE",
      bool: "BOOLEAN",
      epoch: "INT",
    } as Record<ColumnType, string>)[column.type];
  return `${name} ${type}${column.notNull ? " NOT NULL" : ""}${defaultSql(kind, column.default, column.type)}`;
}

function mysqlKey(table: string, prefix: string, cols: string[]) {
  const rawName = `${prefix}_${table}_${cols.join("_")}`.slice(0, 60);
  const name = quote("mysql", rawName);
  const expr = cols.map((col) => {
    const def = tables.find((t) => t.name === table)?.columns.find((c) => c.name === col);
    const q = quote("mysql", col);
    return def?.type === "text" || def?.type === "longtext" ? `${q}(191)` : q;
  }).join(", ");
  return { name, expr, rawName };
}

function featureEnabledFromLegacySidebar(value: string | null | undefined, feature: "affiliates" | "tickets") {
  try {
    return String(normalizeSidebarMenuSettings(JSON.parse(value || "{}"))[feature]);
  } catch {
    return "false";
  }
}
export const affiliateEnabledFromLegacySidebar = (value?: string | null) => featureEnabledFromLegacySidebar(value, "affiliates");
export const supportTicketsEnabledFromLegacySidebar = (value?: string | null) => featureEnabledFromLegacySidebar(value, "tickets");

async function mysqlSchemaQuery(pool: Pool, sql: string, context: string, duplicateCode?: string) {
  try {
    return await pool.query(sql);
  } catch (error) {
    const code = String((error as { code?: unknown })?.code || "");
    const errno = Number((error as { errno?: unknown })?.errno);
    // Concurrent initializers may have already added this exact column/index.
    // Permission, data, storage and lock errors must fail initialization.
    if (duplicateCode && (code === duplicateCode || errno === (duplicateCode === "ER_DUP_FIELDNAME" ? 1060 : 1061))) return;
    console.error(`[DatabaseSchema] MySQL migration failed ${context} code=${/^[A-Z0-9_]+$/.test(code) ? code : "UNKNOWN"}`);
    throw error;
  }
}

async function ensureMysqlSchema(pool: Pool) {
  let addedColumns = 0;
  let addedIndexes = 0;
  let widenedColumns = 0;
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
    await mysqlSchemaQuery(pool,
      `CREATE TABLE IF NOT EXISTS ${quote("mysql", table.name)} (${[...columns, ...unique, ...indexes].join(", ")}) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      `operation=create-table table=${table.name}`,
    );
    const columnResult = await mysqlSchemaQuery(pool, `SHOW COLUMNS FROM ${quote("mysql", table.name)}`, `operation=inspect-columns table=${table.name}`);
    const existingColumns = new Map((columnResult![0] as Array<{ Field: string; Type: string }>).map(row => [row.Field, row.Type]));
    const indexResult = await mysqlSchemaQuery(pool, `SHOW INDEX FROM ${quote("mysql", table.name)}`, `operation=inspect-indexes table=${table.name}`);
    const existingIndexes = new Set((indexResult![0] as Array<{ Key_name: string }>).map(row => row.Key_name));
    for (const column of table.columns) {
      if (column.type === "id") continue;
      if (!existingColumns.has(column.name)) {
        await mysqlSchemaQuery(pool, `ALTER TABLE ${quote("mysql", table.name)} ADD COLUMN ${columnSql("mysql", column, true)}`,
          `operation=add-column table=${table.name} column=${column.name}`, "ER_DUP_FIELDNAME");
        addedColumns++;
      }
      // Existing LONGTEXT columns need no ALTER on every startup. In
      // particular, avoid taking needless metadata locks on busy old tables.
      if (column.type === "longtext" && existingColumns.has(column.name) && existingColumns.get(column.name)?.toLowerCase() !== "longtext") {
        const definition = columnSql("mysql", column, true);
        await mysqlSchemaQuery(pool, `ALTER TABLE ${quote("mysql", table.name)} MODIFY COLUMN ${definition}${column.notNull ? "" : " NULL"}`,
          `operation=widen-column table=${table.name} column=${column.name}`);
        widenedColumns++;
      }
    }
    for (const cols of [...(table.indexes || []), ...(table.unique || [])]) {
      const uniquePrefix = (table.unique || []).some((u) => u.join("|") === cols.join("|")) ? "uniq" : "idx";
      const key = mysqlKey(table.name, uniquePrefix, cols);
      if (!existingIndexes.has(key.rawName)) {
        await mysqlSchemaQuery(pool, `ALTER TABLE ${quote("mysql", table.name)} ADD ${uniquePrefix === "uniq" ? "UNIQUE " : ""}INDEX ${key.name} (${key.expr})`,
          `operation=add-index table=${table.name} index=${key.rawName}`, "ER_DUP_KEYNAME");
        addedIndexes++;
        existingIndexes.add(key.rawName);
      }
    }
  }
  if (addedColumns || addedIndexes || widenedColumns) {
    console.info(`[DatabaseSchema] MySQL schema updated columns=${addedColumns} indexes=${addedIndexes} widened=${widenedColumns}`);
  }
  for (const [key, value] of seedSettings) {
    await pool.execute(
      "INSERT INTO system_settings (`key`, value, updatedAt) VALUES (?, ?, UNIX_TIMESTAMP()) ON DUPLICATE KEY UPDATE `key` = `key`",
      [key, value],
    );
  }
  // One-time separation of the business switch from sidebar visibility.
  // Conflict handling preserves the independent switch on later startups.
  const [sidebarRows] = await pool.execute<any[]>("SELECT value FROM system_settings WHERE `key` = ?", ["sidebarMenu"]);
  for (const [key, value] of [
    ["affiliateEnabled", affiliateEnabledFromLegacySidebar(sidebarRows[0]?.value)],
    ["supportTicketsEnabled", supportTicketsEnabledFromLegacySidebar(sidebarRows[0]?.value)],
  ]) await pool.execute(
    "INSERT INTO system_settings (`key`, value, updatedAt) VALUES (?, ?, UNIX_TIMESTAMP()) ON DUPLICATE KEY UPDATE `key` = `key`",
    [key, value],
  );
  await backfillMysqlLastAutoTrafficReset(pool);
}

function indexName(prefix: string, table: string, cols: string[]) {
  return `${prefix}_${table}_${cols.join("_")}`.slice(0, 60);
}

async function ensurePostgresqlSchema(pool: pg.Pool) {
  for (const table of tables) {
    const columns = table.columns.map((column) => columnSql("postgresql", column)).filter(Boolean);
    const unique = (table.unique || []).map((cols) => `UNIQUE (${cols.map((col) => quote("postgresql", col)).join(", ")})`);
    await pool.query(
      `CREATE TABLE IF NOT EXISTS ${quote("postgresql", table.name)} (${[...columns, ...unique].join(", ")})`,
    );
    for (const column of table.columns) {
      if (column.type === "id") continue;
      await pool.query(`ALTER TABLE ${quote("postgresql", table.name)} ADD COLUMN ${columnSql("postgresql", column, true)}`).catch(() => undefined);
    }
    for (const cols of table.indexes || []) {
      const name = quote("postgresql", indexName("idx", table.name, cols));
      await pool.query(`CREATE INDEX IF NOT EXISTS ${name} ON ${quote("postgresql", table.name)} (${cols.map((col) => quote("postgresql", col)).join(", ")})`).catch(() => undefined);
    }
    for (const cols of table.unique || []) {
      const name = quote("postgresql", indexName("uniq", table.name, cols));
      await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS ${name} ON ${quote("postgresql", table.name)} (${cols.map((col) => quote("postgresql", col)).join(", ")})`).catch(() => undefined);
    }
  }
  for (const [key, value] of seedSettings) {
    await pool.query(
      'INSERT INTO system_settings ("key", value, "updatedAt") VALUES ($1, $2, EXTRACT(EPOCH FROM NOW())::INT) ON CONFLICT ("key") DO NOTHING',
      [key, value],
    );
  }
  const sidebarRows = await pool.query('SELECT value FROM system_settings WHERE "key" = $1', ["sidebarMenu"]);
  for (const [key, value] of [
    ["affiliateEnabled", affiliateEnabledFromLegacySidebar(sidebarRows.rows[0]?.value)],
    ["supportTicketsEnabled", supportTicketsEnabledFromLegacySidebar(sidebarRows.rows[0]?.value)],
  ]) await pool.query(
    'INSERT INTO system_settings ("key", value, "updatedAt") VALUES ($1, $2, EXTRACT(EPOCH FROM NOW())::INT) ON CONFLICT ("key") DO NOTHING',
    [key, value],
  );
  await backfillPostgresqlLastAutoTrafficReset(pool);
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
  const sidebarRow = sqlite.prepare("SELECT value FROM system_settings WHERE key = ?").get("sidebarMenu") as { value: string | null } | undefined;
  const insertFeatureSetting = sqlite.prepare(
    "INSERT OR IGNORE INTO system_settings (key, value, updatedAt) VALUES (?, ?, unixepoch())",
  );
  insertFeatureSetting.run("affiliateEnabled", affiliateEnabledFromLegacySidebar(sidebarRow?.value));
  insertFeatureSetting.run("supportTicketsEnabled", supportTicketsEnabledFromLegacySidebar(sidebarRow?.value));
  backfillSqliteLastAutoTrafficReset(sqlite);
}

export async function ensureDatabaseSchema(target?: Pool | pg.Pool | Database.Database) {
  if (!target && seamlessBackgroundPaused()) return; // frozen snapshots and isolated receivers are already schema-ready
  if (target && "prepare" in target) {
    ensureSqliteSchema(target as Database.Database);
    return;
  }
  if (target && "getConnection" in target) {
    await ensureMysqlSchema(target as unknown as Pool);
    return;
  }
  if (target) {
    await ensurePostgresqlSchema(target as pg.Pool);
    return;
  }
  const kind = getDatabaseKind();
  if (kind === "sqlite") {
    const sqlite = getSqlite();
    if (!sqlite) throw new Error("SQLite database is not connected");
    ensureSqliteSchema(sqlite);
    return;
  }
  if (kind === "postgresql") {
    const pool = getPostgresPool();
    if (!pool) throw new Error("PostgreSQL database is not connected");
    await ensurePostgresqlSchema(pool);
    return;
  }
  const pool = getPool();
  if (!pool) throw new Error("MySQL database is not connected");
  await ensureMysqlSchema(pool);
}
