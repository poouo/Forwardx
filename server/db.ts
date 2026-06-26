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
import { connectDatabase, executeRaw, getDb, getDatabaseKind, insertAndGetId, nowDate } from "./dbRuntime";
import { ensureDatabaseSchema } from "./dbSchema";
import { boolLiteral, castInteger, quoteIdentifier } from "./dbCompat";
import { maintainCurrentPostgresqlDatabase } from "./postgresqlMaintenance";
import { maintainCurrentMysqlDatabase } from "./mysqlMaintenance";
import { randomMultiavatarValue } from "../shared/avatar";
import { migrateLegacyUserAvatars } from "./repositories/userRepository";
import { ensureTrafficStatBucketsBackfilled } from "./repositories/metricsRepository";
import { getSetting, setSetting } from "./repositories/settingsRepository";
import { markLocalSetupComplete } from "./setupState";

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

export async function initDatabase() {
  try {
    const db = await connectDatabase();
    const kind = getDatabaseKind();
    if (!db || !kind) {
      console.warn("[Database] Not configured. Open the panel to complete setup.");
      return { configured: false, ready: false, hasAdmin: false } as const;
    }

    await ensureDatabaseSchema();
    await backfillTunnelProxyProtocolSplit().catch((error) => {
      console.warn("[Database] PROXY Protocol split backfill skipped:", error instanceof Error ? error.message : String(error));
    });
    await backfillRateLimitsToMbps().catch((error) => {
      console.warn("[Database] Rate limit unit backfill skipped:", error instanceof Error ? error.message : String(error));
    });
    await ensureTrafficStatBucketsBackfilled().catch((error) => {
      console.warn("[TrafficSummary] Startup bucket backfill skipped:", error instanceof Error ? error.message : String(error));
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
    avatar: randomMultiavatarValue(String(`admin-${input.email}-${Date.now()}`)),
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
      ? randomMultiavatarValue(String(`admin-${input.email}-${Date.now()}`))
      : (admin as any).avatar || randomMultiavatarValue(String(`admin-${input.email}-${Date.now()}`)),
    updatedAt: nowDate(),
  };
  if (input.password?.trim()) {
    payload.password = hashPassword(input.password);
  }
  await db.update(users).set(payload).where(eq(users.id, admin.id));
  return admin.id;
}
