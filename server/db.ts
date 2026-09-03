/**
 * Database entrypoint.
 *
 * ForwardX uses the configured SQLite, MySQL, or PostgreSQL database as the
 * source of truth and reuses existing users during normal startup.
 */

import { eq } from "drizzle-orm";
import { users } from "../drizzle/schema";
import { hashPassword } from "./password";
import { connectDatabase, executeRaw, getDb, getDatabaseKind, insertAndGetId, nowDate, queryRaw, rawAffectedRows, refreshDatabasePoolSettings } from "./dbRuntime";
import { ensureDatabaseSchema } from "./dbSchema";
import { boolLiteral, castInteger, quoteIdentifier } from "./dbCompat";
import { maintainCurrentPostgresqlDatabase } from "./postgresqlMaintenance";
import { maintainCurrentMysqlDatabase } from "./mysqlMaintenance";
import { randomAvataaarsValue } from "../shared/avatar";
import { migrateLegacyUserAvatars } from "./repositories/userRepository";
import { revokeUserAuthSessions } from "./repositories/sessionRepository";
import { cleanOldTrafficStatBuckets, cleanOldTrafficStats, ensureTrafficStatBucketsBackfilled, ensureUserTrafficCountersBackfilled } from "./repositories/metricsRepository";
import { getSetting, setSetting } from "./repositories/settingsRepository";
import { ensureBundledDeveloperAnnouncements } from "./repositories/announcementRepository";
import { backfillManualEntitlementsFromEffectiveUsers, repairSubscriptionBillingStateOnce } from "./repositories/billingRepository";
import { backfillTrafficBillingRuleUsageFromStats } from "./repositories/trafficBillingRepository";
import { purgeSettledPendingForwardRuleDeletes, repairConflictingProtocolPortRules } from "./repositories/forwardRuleRepository";
import { markLocalSetupComplete } from "./setupState";
import { seedDevPanelData } from "./devPanel";
import { repairPortForwardRuleHostReferences } from "./portForwardRuleHosts";
import { backfillTunnelExitGroupReferences } from "./repositories/tunnelRepository";
import { repairForwardGroupRuleIntegrity } from "./forwardGroupRuleIntegrity";

export { getDb, refreshDatabasePoolSettings, withDatabaseTransaction } from "./dbRuntime";
export * from "./repositories/userRepository";
export * from "./repositories/hostRepository";
export * from "./repositories/forwardRuleRepository";
export * from "./repositories/tunnelRepository";
export * from "./repositories/metricsRepository";
export * from "./repositories/tokenRepository";
export * from "./forwardGroupRuleIntegrity";
export * from "./repositories/dashboardRepository";
export * from "./repositories/forwardTestRepository";
export * from "./repositories/permissionRepository";
export * from "./repositories/settingsRepository";
export * from "./repositories/billingRepository";
export * from "./repositories/trafficBillingRepository";
export * from "./repositories/announcementRepository";
export * from "./repositories/forwardGroupRepository";
export * from "./repositories/hostProbeServiceRepository";
export * from "./repositories/hostGroupRepository";
export * from "./repositories/pluginRepository";

// ==================== Initialization ====================

function summarizeDatabaseStartupError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const code = String((error as any)?.code || "");
  const hostname = String((error as any)?.hostname || "").trim();
  if (code === "ENOTFOUND" || /getaddrinfo ENOTFOUND/i.test(message)) {
    const hostMatch = message.match(/ENOTFOUND\s+([^\s]+)/i);
    const host = hostname || hostMatch?.[1] || "database host";
    return `cannot resolve database host ${host}; check the address from inside the panel container`;
  }
  return message;
}

async function backfillTunnelProxyProtocolSplit() {
  const marker = "proxy-protocol-split-v1";
  if (await getSetting(marker)) return;
  const db = await getDb();
  if (!db) return;
  const q = quoteIdentifier;
  await executeRaw(
    `UPDATE ${q("forward_rules")}
       SET ${q("proxyProtocolExitReceive")} = ${boolLiteral(true)},
           ${q("proxyProtocolExitSend")} = ${boolLiteral(true)}
     WHERE ${q("tunnelId")} IS NOT NULL
       AND ${q("proxyProtocolSend")} = ${boolLiteral(true)}`,
  );
  await setSetting(marker, String(Math.floor(Date.now() / 1000)));
  console.log("[Database] Backfilled split PROXY Protocol settings for tunnel rules");
}

// The traffic-padding capability was removed from the runtime. Keep the
// legacy columns for schema compatibility, but clear values left by older
// releases once so a later rollback cannot unexpectedly re-enable it.
async function clearLegacyTrafficPaddingOnce() {
  const marker = "legacy-traffic-padding-disabled-v1";
  if (await getSetting(marker)) return 0;
  const q = quoteIdentifier;
  const result = await executeRaw(
    `UPDATE ${q("tunnels")}
        SET ${q("trafficPaddingEnabled")} = ${boolLiteral(false)},
            ${q("trafficPaddingRatio")} = 0,
            ${q("trafficPaddingMaxMbps")} = 0
      WHERE ${q("trafficPaddingEnabled")} = ${boolLiteral(true)}
         OR ${q("trafficPaddingRatio")} <> 0
         OR ${q("trafficPaddingMaxMbps")} <> 0`,
  );
  const cleared = rawAffectedRows(result);
  await setSetting(marker, String(Math.floor(Date.now() / 1000)));
  return cleared;
}

function databaseBool(value: unknown) {
  return value === true || value === 1 || value === "1" || String(value).toLowerCase() === "true";
}

function normalizedRuntimeType(value: unknown) {
  return String(value || "").trim().toLowerCase();
}

function legacyRuntimeFieldDiffers(key: string, left: unknown, right: unknown) {
  if (key === "forwardType") return normalizedRuntimeType(left) !== normalizedRuntimeType(right);
  if (key === "proxyProtocolVersion") return Number(left || 0) !== Number(right || 0);
  return databaseBool(left) !== databaseBool(right);
}

// v2.3.278 briefly applied failover group-level runtime settings to existing
// child rules during the startup sweep. Keep this migration read-only: old
// groups remain in compatibility mode until an administrator explicitly saves
// them, while the scan identifies rules that may need review.
export async function warnLegacyForwardGroupRuntimeInheritanceOnce() {
  const marker = "forward-group-runtime-inheritance-compat-v1";
  if (await getSetting(marker)) return 0;
  const q = quoteIdentifier;
  const rows = await queryRaw<any>(
    `SELECT g.${q("id")} AS ${q("groupId")},
            g.${q("name")} AS ${q("groupName")},
            g.${q("forwardType")} AS ${q("groupForwardType")},
            g.${q("failoverRuntimeInheritanceEnabled")} AS ${q("inheritanceEnabled")},
            g.${q("proxyProtocolReceive")} AS ${q("groupProxyProtocolReceive")},
            g.${q("proxyProtocolSend")} AS ${q("groupProxyProtocolSend")},
            g.${q("proxyProtocolVersion")} AS ${q("groupProxyProtocolVersion")},
            c.${q("id")} AS ${q("childRuleId")},
            c.${q("forwardType")} AS ${q("childForwardType")},
            c.${q("proxyProtocolReceive")} AS ${q("childProxyProtocolReceive")},
            c.${q("proxyProtocolSend")} AS ${q("childProxyProtocolSend")},
            c.${q("proxyProtocolVersion")} AS ${q("childProxyProtocolVersion")},
            c.${q("tunnelId")} AS ${q("childTunnelId")},
            t.${q("forwardType")} AS ${q("templateForwardType")},
            t.${q("proxyProtocolReceive")} AS ${q("templateProxyProtocolReceive")},
            t.${q("proxyProtocolSend")} AS ${q("templateProxyProtocolSend")},
            t.${q("proxyProtocolVersion")} AS ${q("templateProxyProtocolVersion")}
       FROM ${q("forward_groups")} g
       INNER JOIN ${q("forward_rules")} c
         ON c.${q("forwardGroupId")} = g.${q("id")}
        AND c.${q("isForwardGroupTemplate")} = ${boolLiteral(false)}
        AND c.${q("pendingDelete")} = ${boolLiteral(false)}
       LEFT JOIN ${q("forward_rules")} t
         ON t.${q("id")} = c.${q("forwardGroupRuleId")}
        AND t.${q("forwardGroupId")} = g.${q("id")}
        AND t.${q("isForwardGroupTemplate")} = ${boolLiteral(true)}
       WHERE g.${q("groupMode")} = ?`,
    ["failover"],
  );
  const affected = (rows as any[]).filter((row) => {
    if (databaseBool(row.inheritanceEnabled)) return false;
    // Tunnel members intentionally derive their runtime tool/PROXY fields
    // from the tunnel, so a difference from the group is expected.
    if (Number(row.childTunnelId || 0) > 0) return false;
    const groupType = normalizedRuntimeType(row.groupForwardType);
    if (groupType !== "gost" && groupType !== "realm") return false;
    // Legacy failover children should follow their template. A 2.3.278
    // startup sweep instead copied the group fields, so compare both sides:
    // report only when the group differs from its template and the child no
    // longer matches that template. This catches copied fields even when the
    // child happens to equal the group exactly.
    if (row.templateForwardType == null) return false;
    const runtimeKeys: Array<[string, unknown, unknown, unknown]> = [
      ["forwardType", row.groupForwardType, row.childForwardType, row.templateForwardType],
      ["proxyProtocolReceive", row.groupProxyProtocolReceive, row.childProxyProtocolReceive, row.templateProxyProtocolReceive],
      ["proxyProtocolSend", row.groupProxyProtocolSend, row.childProxyProtocolSend, row.templateProxyProtocolSend],
      ["proxyProtocolVersion", row.groupProxyProtocolVersion, row.childProxyProtocolVersion, row.templateProxyProtocolVersion],
    ];
    const groupDiffersFromTemplate = runtimeKeys.some(([key, groupValue, , templateValue]) => legacyRuntimeFieldDiffers(String(key), groupValue, templateValue));
    if (!groupDiffersFromTemplate) return false;
    return runtimeKeys.some(([key, , childValue, templateValue]) => legacyRuntimeFieldDiffers(String(key), childValue, templateValue));
  });
  await setSetting(marker, String(Math.floor(Date.now() / 1000)));
  if (affected.length === 0) return 0;
  const groupIds = Array.from(new Set(affected.map((row) => Number(row.groupId)).filter((id) => id > 0)));
  const childIds = affected.map((row) => Number(row.childRuleId)).filter((id) => id > 0);
  const sampleGroups = affected
    .map((row) => `${Number(row.groupId)}:${String(row.groupName || "group")}`)
    .filter((value, index, values) => values.indexOf(value) === index)
    .slice(0, 20)
    .join(", ");
  console.warn(
    `[Database] COMPATIBILITY WARNING: ${affected.length} failover child rule(s) in ${groupIds.length} legacy group(s) have runtime fields inconsistent with their template/group; no rules were changed. `
      + `Review child rule IDs=${childIds.slice(0, 50).join(",")}${childIds.length > 50 ? ",..." : ""}; groups=${sampleGroups}${groupIds.length > 20 ? ",..." : ""}. `
      + "Save a group explicitly after reviewing its PROXY/转发工具 settings to enable group-level inheritance.",
  );
  return affected.length;
}

function legacyRateLimitMbpsExpr(column: string) {
  const q = quoteIdentifier;
  const col = q(column);
  const rounded = castInteger(`ROUND(${col} / 1048576.0)`);
  return `CASE WHEN ${col} >= 10240 THEN CASE WHEN ${rounded} < 1 THEN 1 ELSE ${rounded} END ELSE ${col} END`;
}

async function backfillRateLimitsToMbps() {
  const marker = "rate-limit-mbps-v1";
  if (await getSetting(marker)) return;
  const q = quoteIdentifier;
  await executeRaw(
    `UPDATE ${q("users")}
        SET ${q("gostRateLimitIn")} = ${legacyRateLimitMbpsExpr("gostRateLimitIn")},
            ${q("gostRateLimitOut")} = ${legacyRateLimitMbpsExpr("gostRateLimitOut")}
      WHERE ${q("gostRateLimitIn")} >= 10240 OR ${q("gostRateLimitOut")} >= 10240`,
  );
  await executeRaw(
    `UPDATE ${q("subscription_plans")}
        SET ${q("rateLimitMbps")} = ${legacyRateLimitMbpsExpr("rateLimitMbps")}
      WHERE ${q("rateLimitMbps")} >= 10240`,
  );
  await setSetting(marker, String(Math.floor(Date.now() / 1000)));
  console.log("[Database] Backfilled tunnel rate limits from legacy byte-rate storage to Mbps values");
}

async function backfillLinkManagementSortOrder() {
  const marker = "link-management-sort-order-v1";
  if (await getSetting(marker)) return;
  const q = quoteIdentifier;
  const fillTableOrder = async (table: string, whereSql = "", params: any[] = []) => {
    const rows = await queryRaw<{ id: number }>(
      `SELECT ${q("id")} FROM ${q(table)}${whereSql} ORDER BY ${q("createdAt")} DESC, ${q("id")} DESC`,
      params,
    );
    for (const [index, row] of rows.entries()) {
      await executeRaw(`UPDATE ${q(table)} SET ${q("sortOrder")} = ? WHERE ${q("id")} = ?`, [index, Number(row.id)]);
    }
  };
  await fillTableOrder("tunnels");
  for (const mode of ["port", "chain", "failover", "entry", "exit"]) {
    await fillTableOrder("forward_groups", ` WHERE ${q("groupMode")} = ?`, [mode]);
  }
  await setSetting(marker, String(Math.floor(Date.now() / 1000)));
  console.log("[Database] Backfilled link management display order");
}

async function backfillForwardRuleSortOrder() {
  const marker = "forward-rule-sort-order-v1";
  if (await getSetting(marker)) return;
  const q = quoteIdentifier;
  const categorySql = `CASE
    WHEN g.${q("groupMode")} = 'port' THEN 'local'
    WHEN g.${q("groupMode")} = 'chain' THEN 'chain'
    WHEN r.${q("forwardGroupId")} IS NOT NULL AND r.${q("forwardGroupId")} <> 0 THEN 'group'
    WHEN r.${q("tunnelId")} IS NOT NULL AND r.${q("tunnelId")} <> 0 THEN 'tunnel'
    ELSE 'local'
  END`;
  const rows = await queryRaw<{ id: number; userId: number; category: string }>(
    `SELECT
        r.${q("id")} AS ${q("id")},
        r.${q("userId")} AS ${q("userId")},
        ${categorySql} AS ${q("category")}
       FROM ${q("forward_rules")} r
       LEFT JOIN ${q("forward_groups")} g ON g.${q("id")} = r.${q("forwardGroupId")}
      WHERE r.${q("pendingDelete")} = ${boolLiteral(false)}
        AND r.${q("forwardGroupRuleId")} IS NULL
        AND r.${q("id")} NOT IN (
          SELECT ${q("ruleId")} FROM ${q("forward_group_members")} WHERE ${q("ruleId")} IS NOT NULL
        )
      ORDER BY r.${q("userId")} ASC, ${categorySql} ASC, r.${q("createdAt")} DESC, r.${q("id")} DESC`,
  );
  const counters = new Map<string, number>();
  for (const row of rows) {
    const key = `${Number(row.userId || 0)}:${String(row.category || "local")}`;
    const index = counters.get(key) || 0;
    counters.set(key, index + 1);
    await executeRaw(`UPDATE ${q("forward_rules")} SET ${q("sortOrder")} = ? WHERE ${q("id")} = ?`, [index, Number(row.id)]);
  }
  await setSetting(marker, String(Math.floor(Date.now() / 1000)));
  console.log("[Database] Backfilled forward rule display order");
}

async function backfillHostManagementSortOrder() {
  const marker = "host-management-sort-order-v1";
  if (await getSetting(marker)) return;
  const q = quoteIdentifier;
  const fillTableOrder = async (table: string) => {
    const rows = await queryRaw<{ id: number }>(
      `SELECT ${q("id")} FROM ${q(table)} ORDER BY ${q("createdAt")} DESC, ${q("id")} DESC`,
    );
    for (const [index, row] of rows.entries()) {
      await executeRaw(`UPDATE ${q(table)} SET ${q("sortOrder")} = ? WHERE ${q("id")} = ?`, [index, Number(row.id)]);
    }
  };
  // Hosts and groups already had sortOrder in previous versions; do not overwrite
  // user-defined ordering during upgrade. Services and tokens gain ordering now.
  await fillTableOrder("host_probe_services");
  await fillTableOrder("agent_tokens");
  await setSetting(marker, String(Math.floor(Date.now() / 1000)));
  console.log("[Database] Backfilled host management display order");
}

async function backfillTunnelExitGroups() {
  const marker = "tunnel-exit-group-reference-v1";
  if (await getSetting(marker)) return;
  const count = await backfillTunnelExitGroupReferences();
  await setSetting(marker, String(Math.floor(Date.now() / 1000)));
  if (count > 0) console.log(`[Database] Backfilled tunnel exit group references count=${count}`);
}

async function repairPortForwardRuleHostReferencesOnce() {
  const marker = "port-forward-rule-host-reference-repair-v1";
  if (await getSetting(marker)) return [];
  const repairs = await repairPortForwardRuleHostReferences();
  await setSetting(marker, String(Math.floor(Date.now() / 1000)));
  return repairs;
}

async function migrateLegacyUserAvatarsOnce() {
  const marker = "legacy-user-avatar-preset-migration-v1";
  if (await getSetting(marker)) return 0;
  const migrated = await migrateLegacyUserAvatars();
  await setSetting(marker, String(Math.floor(Date.now() / 1000)));
  return migrated;
}

export async function clearLegacyTunnelRuleLatencyHistoryOnce() {
  const marker = "tunnel-rule-exit-latency-v1";
  if (await getSetting(marker)) return 0;
  const q = quoteIdentifier;
  const result = await executeRaw(
    `DELETE FROM ${q("tcping_stats")}
      WHERE ${q("ruleId")} IN (
        SELECT ${q("id")}
          FROM ${q("forward_rules")}
         WHERE ${q("tunnelId")} IS NOT NULL
           AND ${q("tunnelId")} <> 0
      )`,
  );
  const deleted = rawAffectedRows(result);
  await setSetting(marker, String(Math.floor(Date.now() / 1000)));
  return deleted;
}

export async function initDatabase() {
  const initializationStartedAt = Date.now();
  const runInitializationStep = async <T>(name: string, work: () => Promise<T> | T) => {
    const startedAt = Date.now();
    try {
      return await work();
    } finally {
      const durationMs = Date.now() - startedAt;
      // Startup maintenance is intentionally quiet when it is fast. A slow
      // step is actionable when a local panel appears stuck during boot.
      if (durationMs >= 2_000) {
        console.warn(`[Database] initialization step slow step=${name} durationMs=${durationMs}`);
      }
    }
  };
  try {
    const db = await runInitializationStep("connect", () => connectDatabase());
    const kind = getDatabaseKind();
    if (!db || !kind) {
      console.warn("[Database] Not configured. Open the panel to complete setup.");
      return { configured: false, ready: false, hasAdmin: false } as const;
    }

    await runInitializationStep("schema", () => ensureDatabaseSchema());
    await runInitializationStep("clear-legacy-traffic-padding", () => clearLegacyTrafficPaddingOnce().then((count) => {
      if (count > 0) console.log(`[Database] Cleared legacy traffic padding settings count=${count}`);
    }).catch((error) => {
      console.warn("[Database] Legacy traffic padding cleanup skipped:", error instanceof Error ? error.message : String(error));
    }));
    await runInitializationStep("refresh-pool-settings", () => refreshDatabasePoolSettings().catch((error) => {
      console.warn("[Database] Automatic pool sizing skipped:", error instanceof Error ? error.message : String(error));
    }));
    await runInitializationStep("clear-legacy-latency", () => clearLegacyTunnelRuleLatencyHistoryOnce().then((count) => {
      if (count > 0) console.log(`[Database] Cleared legacy tunnel rule latency samples count=${count}`);
    }).catch((error) => {
      console.warn("[Database] Legacy tunnel rule latency cleanup skipped:", error instanceof Error ? error.message : String(error));
    }));
    await runInitializationStep("repair-rule-hosts", () => repairPortForwardRuleHostReferencesOnce().then((repairs) => {
      if (repairs.length > 0) console.log(`[Database] Repaired stale port-forward rule hosts count=${repairs.length}`);
    }).catch((error) => {
      console.warn("[Database] Port-forward rule host repair skipped:", error instanceof Error ? error.message : String(error));
    }));
    await runInitializationStep("repair-port-conflicts", () => repairConflictingProtocolPortRules().then((repairs) => {
      if (repairs.length > 0) console.warn(`[Database] Disabled conflicting same-port rules count=${repairs.length}`);
    }).catch((error) => {
      console.warn("[Database] Same-port rule conflict repair skipped:", error instanceof Error ? error.message : String(error));
    }));
    await runInitializationStep("repair-forward-groups", () => repairForwardGroupRuleIntegrity().then((repair) => {
      const total = repair.orphanRules + repair.legacyRules + repair.legacyPointers + repair.orphanTemplates;
      if (total > 0) {
        console.warn(
          `[Database] Repaired historical forward-group rule references orphanRules=${repair.orphanRules}`
          + ` legacyRules=${repair.legacyRules} legacyPointers=${repair.legacyPointers}`
          + ` orphanTemplates=${repair.orphanTemplates}`,
        );
      }
    }).catch((error) => {
      console.warn("[Database] Forward-group rule integrity repair skipped:", error instanceof Error ? error.message : String(error));
    }));
    // Run the compatibility scan after relationship repairs so valid template
    // pointers are visible and retired/orphaned children are excluded. This
    // remains before any scheduler-driven group synchronization.
    await runInitializationStep("scan-forward-group-compatibility", () => warnLegacyForwardGroupRuntimeInheritanceOnce().catch((error) => {
      console.warn("[Database] Forward-group runtime inheritance compatibility scan skipped:", error instanceof Error ? error.message : String(error));
    }));
    await runInitializationStep("purge-pending-rules", () => purgeSettledPendingForwardRuleDeletes().then((count) => {
      if (count > 0) console.log(`[Database] Purged settled pending forward rules count=${count}`);
    }).catch((error) => {
      console.warn("[Database] Pending forward rule purge skipped:", error instanceof Error ? error.message : String(error));
    }));
    await runInitializationStep("backfill-proxy-protocol", () => backfillTunnelProxyProtocolSplit().catch((error) => {
      console.warn("[Database] PROXY Protocol split backfill skipped:", error instanceof Error ? error.message : String(error));
    }));
    await runInitializationStep("backfill-rate-limits", () => backfillRateLimitsToMbps().catch((error) => {
      console.warn("[Database] Rate limit unit backfill skipped:", error instanceof Error ? error.message : String(error));
    }));
    await runInitializationStep("backfill-link-order", () => backfillLinkManagementSortOrder().catch((error) => {
      console.warn("[Database] Link management sort order backfill skipped:", error instanceof Error ? error.message : String(error));
    }));
    await runInitializationStep("backfill-rule-order", () => backfillForwardRuleSortOrder().catch((error) => {
      console.warn("[Database] Forward rule sort order backfill skipped:", error instanceof Error ? error.message : String(error));
    }));
    await runInitializationStep("backfill-host-order", () => backfillHostManagementSortOrder().catch((error) => {
      console.warn("[Database] Host management sort order backfill skipped:", error instanceof Error ? error.message : String(error));
    }));
    await runInitializationStep("backfill-tunnel-exit-groups", () => backfillTunnelExitGroups().catch((error) => {
      console.warn("[Database] Tunnel exit group reference backfill skipped:", error instanceof Error ? error.message : String(error));
    }));
    await runInitializationStep("backfill-traffic-billing", () => backfillTrafficBillingRuleUsageFromStats().catch((error) => {
      console.warn("[TrafficBilling] Rule usage backfill skipped:", error instanceof Error ? error.message : String(error));
    }));
    await runInitializationStep("backfill-traffic-buckets", () => ensureTrafficStatBucketsBackfilled().catch((error) => {
      console.warn("[TrafficSummary] Startup bucket backfill skipped:", error instanceof Error ? error.message : String(error));
    }));
    await runInitializationStep("backfill-traffic-counters", () => ensureUserTrafficCountersBackfilled().catch((error) => {
      console.warn("[TrafficCounter] Startup cumulative counter backfill skipped:", error instanceof Error ? error.message : String(error));
    }));
    await runInitializationStep("cleanup-traffic-stats", () => cleanOldTrafficStats(72).catch((error) => {
      console.warn("[TrafficSummary] Startup traffic stats cleanup skipped:", error instanceof Error ? error.message : String(error));
    }));
    await runInitializationStep("cleanup-traffic-buckets", () => cleanOldTrafficStatBuckets(72).catch((error) => {
      console.warn("[TrafficSummary] Startup traffic bucket cleanup skipped:", error instanceof Error ? error.message : String(error));
    }));
    await runInitializationStep("backfill-manual-entitlements", () => backfillManualEntitlementsFromEffectiveUsers().catch((error) => {
      console.warn("[Database] Manual entitlement backfill skipped:", error instanceof Error ? error.message : String(error));
    }));
    await runInitializationStep("seed-dev-panel", () => seedDevPanelData().catch((error) => {
      console.warn("[DevPanel] Seed data skipped:", error instanceof Error ? error.message : String(error));
    }));
    await runInitializationStep("repair-subscription-billing", () => repairSubscriptionBillingStateOnce().then((result) => {
      if (result.users > 0) {
        console.log(`[Database] Reconciled subscription billing users=${result.users} resets=${result.resets}`);
      }
    }).catch((error) => {
      console.warn("[Database] Subscription billing reconciliation skipped:", error instanceof Error ? error.message : String(error));
    }));
    await runInitializationStep("ensure-announcements", () => ensureBundledDeveloperAnnouncements().catch((error) => {
      console.warn("[Announcement] Bundled developer announcements skipped:", error instanceof Error ? error.message : String(error));
    }));
    await runInitializationStep("postgres-health-check", () => maintainCurrentPostgresqlDatabase().catch((error) => {
      console.warn("[PostgreSQL] Startup health check skipped:", error instanceof Error ? error.message : String(error));
    }));
    await runInitializationStep("mysql-health-check", () => maintainCurrentMysqlDatabase().catch((error) => {
      console.warn("[MySQL] Startup health check skipped:", error instanceof Error ? error.message : String(error));
    }));
    const migratedAvatars = await runInitializationStep("migrate-avatars", () => migrateLegacyUserAvatarsOnce());
    if (migratedAvatars > 0) {
      console.log(`[Database] Migrated legacy preset avatars count=${migratedAvatars}`);
    }
    const hasAdmin = await runInitializationStep("check-admin", () => hasAdminUser());
    if (hasAdmin) markLocalSetupComplete();
    console.log(`[Database] Initialization complete (${kind}, ${hasAdmin ? "admin exists" : "no admin yet"}) durationMs=${Date.now() - initializationStartedAt}`);
    return { configured: true, ready: true, hasAdmin, kind } as const;
  } catch (error) {
    const message = summarizeDatabaseStartupError(error);
    console.error(`[Database] Initialization failed after ${Date.now() - initializationStartedAt}ms: ${message}`);
    return { configured: true, ready: false, hasAdmin: false, error: message } as const;
  }
}

export async function ensureConfiguredDatabase() {
  const db = await getDb();
  if (!db || !getDatabaseKind()) return false;
  await ensureDatabaseSchema();
  return true;
}

export async function hasAdminUser() {
  const db = await getDb();
  if (!db) return false;
  const rows = await db.select({ id: users.id }).from(users).where(eq(users.role, "admin")).limit(1);
  return rows.length > 0;
}

export async function createInitialAdmin(input: { email: string; password: string; name?: string }) {
  const db = await getDb();
  if (!db) throw new Error("Database is not configured");
  if (await hasAdminUser()) throw new Error("管理员账户已存在，请直接登录");
  const email = input.email.trim().toLowerCase();

  const id = await insertAndGetId("users", {
    username: email,
    password: hashPassword(input.password),
    name: input.name?.trim() || email,
    email,
    avatar: randomAvataaarsValue(String(`admin-${email}-${Date.now()}`)),
    role: "admin",
    accountEnabled: true,
    canAddRules: true,
    allowForwardXTunnel: true,
    createdAt: nowDate(),
    updatedAt: nowDate(),
    lastSignedIn: nowDate(),
  });
  return id;
}

export async function updateInitialAdmin(input: { email: string; password?: string; name?: string }) {
  const db = await getDb();
  if (!db) throw new Error("Database is not configured");
  const admin = (await db.select().from(users).where(eq(users.role, "admin")).orderBy(users.id).limit(1))[0];
  if (!admin) throw new Error("管理员账户不存在");
  const email = input.email.trim().toLowerCase();
  const payload: Record<string, unknown> = {
    username: email,
    email,
    name: input.name?.trim() || email,
    avatar: (admin as any).avatar?.startsWith?.("preset:")
      ? randomAvataaarsValue(String(`admin-${email}-${Date.now()}`))
      : (admin as any).avatar || randomAvataaarsValue(String(`admin-${email}-${Date.now()}`)),
    updatedAt: nowDate(),
  };
  if (input.password?.trim()) {
    await revokeUserAuthSessions(admin.id, { reason: "password_reset" });
    payload.password = hashPassword(input.password);
  }
  await db.update(users).set(payload).where(eq(users.id, admin.id));
  return admin.id;
}
