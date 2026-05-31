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
import { connectDatabase, getDb, getDatabaseKind, insertAndGetId, nowDate } from "./dbRuntime";
import { ensureDatabaseSchema } from "./dbSchema";
import { randomAvatarPreset } from "../shared/avatar";

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

// ==================== Initialization ====================

export async function initDatabase() {
  try {
    const db = await connectDatabase();
    const kind = getDatabaseKind();
    if (!db || !kind) {
      console.warn("[Database] Not configured. Open the panel to complete setup.");
      return { configured: false, ready: false, hasAdmin: false } as const;
    }

    await ensureDatabaseSchema();
    const hasAdmin = await hasAdminUser();
    console.log(`[Database] Initialization complete (${kind}, ${hasAdmin ? "admin exists" : "no admin yet"})`);
    return { configured: true, ready: true, hasAdmin, kind } as const;
  } catch (error) {
    console.error("[Database] Initialization failed:", error);
    return { configured: true, ready: false, hasAdmin: false, error: error instanceof Error ? error.message : String(error) } as const;
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
    avatar: randomAvatarPreset(),
    role: "admin",
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
    avatar: (admin as any).avatar || randomAvatarPreset(),
    updatedAt: nowDate(),
  };
  if (input.password?.trim()) {
    payload.password = hashPassword(input.password);
  }
  await db.update(users).set(payload).where(eq(users.id, admin.id));
  return admin.id;
}
