/**
 * Database entrypoint.
 *
 * ForwardX now uses the user's MySQL database as the source of truth. The panel
 * never creates or resets a default administrator during normal startup. If a
 * connected database already contains users/admins, that data is reused.
 */

import { eq } from "drizzle-orm";
import { users } from "../drizzle/schema";
import { hashPassword } from "./password";
import { connectDatabase, executeRaw, getDb, getDatabaseKind, insertAndGetId, nowDate, queryRaw } from "./dbRuntime";
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
import { backfillManualEntitlementsFromEffectiveUsers } from "./repositories/billingRepository";
import { backfillTrafficBillingRuleUsageFromStats } from "./repositories/trafficBillingRepository";
import { purgeSettledPendingForwardRuleDeletes } from "./repositories/forwardRuleRepository";
import { markLocalSetupComplete } from "./setupState";
import { seedDevPanelData } from "./devPanel";
import { repairPortForwardRuleHostReferences } from "./portForwardRuleHosts";

export { getDb } from "./dbRuntime";
export * from "./repositories/userRepository";
export * from "./repositories/hostRepository";
export * from "./repositories/forwardRuleRepository";
export * from "./repositories/tunnelRepository";
export * from "./repositories/metricsRepository";
export * from "./repositories/tokenRepository";
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

export async function initDatabase() {
  try {
    const db = await connectDatabase();
    const kind = getDatabaseKind();
    if (!db || !kind) {
      console.warn("[Database] Not configured. Open the panel to complete setup.");
      return { configured: false, ready: false, hasAdmin: false } as const;
    }

    await ensureDatabaseSchema();
    await repairPortForwardRuleHostReferences().then((repairs) => {
      if (repairs.length > 0) console.log(`[Database] Repaired stale port-forward rule hosts count=${repairs.length}`);
    }).catch((error) => {
      console.warn("[Database] Port-forward rule host repair skipped:", error instanceof Error ? error.message : String(error));
    });
    await purgeSettledPendingForwardRuleDeletes().then((count) => {
      if (count > 0) console.log(`[Database] Purged settled pending forward rules count=${count}`);
    }).catch((error) => {
      console.warn("[Database] Pending forward rule purge skipped:", error instanceof Error ? error.message : String(error));
    });
    await backfillTunnelProxyProtocolSplit().catch((error) => {
      console.warn("[Database] PROXY Protocol split backfill skipped:", error instanceof Error ? error.message : String(error));
    });
    await backfillRateLimitsToMbps().catch((error) => {
      console.warn("[Database] Rate limit unit backfill skipped:", error instanceof Error ? error.message : String(error));
    });
    await backfillLinkManagementSortOrder().catch((error) => {
      console.warn("[Database] Link management sort order backfill skipped:", error instanceof Error ? error.message : String(error));
    });
    await backfillForwardRuleSortOrder().catch((error) => {
      console.warn("[Database] Forward rule sort order backfill skipped:", error instanceof Error ? error.message : String(error));
    });
    await backfillHostManagementSortOrder().catch((error) => {
      console.warn("[Database] Host management sort order backfill skipped:", error instanceof Error ? error.message : String(error));
    });
    await backfillTrafficBillingRuleUsageFromStats().catch((error) => {
      console.warn("[TrafficBilling] Rule usage backfill skipped:", error instanceof Error ? error.message : String(error));
    });
    await ensureTrafficStatBucketsBackfilled().catch((error) => {
      console.warn("[TrafficSummary] Startup bucket backfill skipped:", error instanceof Error ? error.message : String(error));
    });
    await ensureUserTrafficCountersBackfilled().catch((error) => {
      console.warn("[TrafficCounter] Startup cumulative counter backfill skipped:", error instanceof Error ? error.message : String(error));
    });
    await cleanOldTrafficStats(72).catch((error) => {
      console.warn("[TrafficSummary] Startup traffic stats cleanup skipped:", error instanceof Error ? error.message : String(error));
    });
    await cleanOldTrafficStatBuckets(72).catch((error) => {
      console.warn("[TrafficSummary] Startup traffic bucket cleanup skipped:", error instanceof Error ? error.message : String(error));
    });
    await backfillManualEntitlementsFromEffectiveUsers().catch((error) => {
      console.warn("[Database] Manual entitlement backfill skipped:", error instanceof Error ? error.message : String(error));
    });
    await seedDevPanelData().catch((error) => {
      console.warn("[DevPanel] Seed data skipped:", error instanceof Error ? error.message : String(error));
    });
    await ensureBundledDeveloperAnnouncements().catch((error) => {
      console.warn("[Announcement] Bundled developer announcements skipped:", error instanceof Error ? error.message : String(error));
    });
    await maintainCurrentPostgresqlDatabase().catch((error) => {
      console.warn("[PostgreSQL] Startup health check skipped:", error instanceof Error ? error.message : String(error));
    });
    await maintainCurrentMysqlDatabase().catch((error) => {
      console.warn("[MySQL] Startup health check skipped:", error instanceof Error ? error.message : String(error));
    });
    const migratedAvatars = await migrateLegacyUserAvatars();
    if (migratedAvatars > 0) {
      console.log(`[Database] Migrated legacy preset avatars count=${migratedAvatars}`);
    }
    const hasAdmin = await hasAdminUser();
    if (hasAdmin) markLocalSetupComplete();
    console.log(`[Database] Initialization complete (${kind}, ${hasAdmin ? "admin exists" : "no admin yet"})`);
    return { configured: true, ready: true, hasAdmin, kind } as const;
  } catch (error) {
    const message = summarizeDatabaseStartupError(error);
    console.error(`[Database] Initialization failed: ${message}`);
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

  const id = await insertAndGetId("users", {
    username: input.email,
    password: hashPassword(input.password),
    name: input.name?.trim() || input.email,
    email: input.email,
    avatar: randomAvataaarsValue(String(`admin-${input.email}-${Date.now()}`)),
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
  const admin = (await db.select().from(users).where(eq(users.role, "admin")).limit(1))[0];
  if (!admin) throw new Error("管理员账户不存在");
  const payload: Record<string, unknown> = {
    username: input.email,
    email: input.email,
    name: input.name?.trim() || input.email,
    avatar: (admin as any).avatar?.startsWith?.("preset:")
      ? randomAvataaarsValue(String(`admin-${input.email}-${Date.now()}`))
      : (admin as any).avatar || randomAvataaarsValue(String(`admin-${input.email}-${Date.now()}`)),
    updatedAt: nowDate(),
  };
  if (input.password?.trim()) {
    await revokeUserAuthSessions(admin.id, { reason: "password_reset" });
    payload.password = hashPassword(input.password);
  }
  await db.update(users).set(payload).where(eq(users.id, admin.id));
  return admin.id;
}
