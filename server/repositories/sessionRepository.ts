import { and, eq, gt, isNull } from "drizzle-orm";
import { authSessions } from "../../drizzle/schema";
import { getDb, nowDate } from "../dbRuntime";
import { getSetting } from "./settingsRepository";
import { SESSION_TOUCH_INTERVAL_MS, type SessionKind } from "../session";

type CreateAuthSessionInput = {
  userId: number;
  sid: string;
  kind: SessionKind;
  expiresAt: Date;
};

function activeSessionWhere(userId: number, sid: string, kind: SessionKind, now = nowDate()) {
  return and(
    eq(authSessions.userId, userId),
    eq(authSessions.sid, sid),
    eq(authSessions.kind, kind),
    isNull(authSessions.revokedAt),
    gt(authSessions.expiresAt, now),
  );
}

export async function createAuthSession(input: CreateAuthSessionInput) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const allowMultiDeviceLogin = (await getSetting("allowMultiDeviceLogin").catch(() => null)) === "true";
  if (!allowMultiDeviceLogin) {
    await revokeUserAuthSessions(input.userId, { kind: input.kind, reason: "replaced" });
  }
  const now = nowDate();
  await db.insert(authSessions).values({
    userId: input.userId,
    sid: input.sid,
    kind: input.kind,
    expiresAt: input.expiresAt,
    createdAt: now,
    lastSeenAt: now,
  } as any);
}

export async function getActiveAuthSession(userId: number, sid: string, kind: SessionKind) {
  const db = await getDb();
  if (!db) return undefined;
  const rows = await db.select().from(authSessions).where(activeSessionWhere(userId, sid, kind)).limit(1);
  return rows[0];
}

export async function touchAuthSession(userId: number, sid: string, kind: SessionKind) {
  const db = await getDb();
  if (!db) return;
  const session = await getActiveAuthSession(userId, sid, kind);
  if (!session) return;
  const lastSeenAt = new Date((session as any).lastSeenAt || 0).getTime();
  if (Number.isFinite(lastSeenAt) && Date.now() - lastSeenAt < SESSION_TOUCH_INTERVAL_MS) return;
  await db.update(authSessions)
    .set({ lastSeenAt: nowDate() } as any)
    .where(activeSessionWhere(userId, sid, kind));
}

export async function revokeAuthSession(userId: number, sid: string, kind: SessionKind, reason = "logout") {
  const db = await getDb();
  if (!db) return;
  await db.update(authSessions)
    .set({ revokedAt: nowDate(), revokeReason: reason } as any)
    .where(and(
      eq(authSessions.userId, userId),
      eq(authSessions.sid, sid),
      eq(authSessions.kind, kind),
      isNull(authSessions.revokedAt),
    ));
}

export async function revokeUserAuthSessions(userId: number, options: { kind?: SessionKind; reason?: string } = {}) {
  const db = await getDb();
  if (!db) return;
  const conditions = [eq(authSessions.userId, userId), isNull(authSessions.revokedAt)];
  if (options.kind) conditions.push(eq(authSessions.kind, options.kind));
  await db.update(authSessions)
    .set({ revokedAt: nowDate(), revokeReason: options.reason || "revoked" } as any)
    .where(and(...conditions));
}
