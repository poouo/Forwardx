import { and, desc, eq, sql } from "drizzle-orm";
import { announcementReads, announcements, InsertAnnouncement } from "../../drizzle/schema";
import { executeRaw, getDatabaseKind, getDb, nowDate } from "../dbRuntime";
import { getSetting, setSetting } from "./settingsRepository";

const CURRENT_DEVELOPER_UPGRADE_ANNOUNCEMENT: {
  targetVersion: string;
  title: string;
  content: string;
} | null = null;

function normalizeAnnouncementVersion(version: string | null | undefined) {
  return String(version || "").trim().replace(/^v/i, "");
}

async function deactivateOtherPopups(exceptId?: number) {
  const db = await getDb();
  if (!db) return;
  const where = exceptId
    ? and(eq(announcements.type, "popup"), sql`${announcements.id} != ${exceptId}`)
    : eq(announcements.type, "popup");
  await db.update(announcements).set({ isActive: false, updatedAt: nowDate() } as any).where(where);
}

async function deactivateOtherUpgradePopups(targetVersion: string, exceptId?: number) {
  const db = await getDb();
  if (!db) return;
  const normalizedVersion = normalizeAnnouncementVersion(targetVersion);
  if (!normalizedVersion) return;
  const baseWhere = and(eq(announcements.type, "upgrade_popup"), eq(announcements.targetVersion, normalizedVersion));
  const where = exceptId ? and(baseWhere, sql`${announcements.id} != ${exceptId}`) : baseWhere;
  await db.update(announcements).set({ isActive: false, updatedAt: nowDate() } as any).where(where);
}

export async function listAnnouncements(includeInactive = false) {
  const db = await getDb();
  if (!db) return [];
  const base = db.select().from(announcements);
  if (!includeInactive) {
    return base
      .where(eq(announcements.isActive, true))
      .orderBy(desc(announcements.updatedAt), desc(announcements.createdAt));
  }
  return base.orderBy(desc(announcements.updatedAt), desc(announcements.createdAt));
}

export async function createAnnouncement(data: InsertAnnouncement) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const next = {
    ...data,
    targetVersion: data.type === "upgrade_popup" ? normalizeAnnouncementVersion(data.targetVersion) || null : null,
    isActive: true,
    startsAt: null,
    expiresAt: null,
  } as any;
  if (next.type === "popup") await deactivateOtherPopups();
  if (next.type === "upgrade_popup" && next.targetVersion) await deactivateOtherUpgradePopups(next.targetVersion);
  await db.insert(announcements).values(next);
  return listAnnouncements(true);
}

export async function updateAnnouncement(id: number, data: Partial<InsertAnnouncement>) {
  const db = await getDb();
  if (!db) return undefined;
  const next = {
    ...data,
    targetVersion: data.type === "upgrade_popup" ? normalizeAnnouncementVersion(data.targetVersion) || null : null,
    isActive: true,
    startsAt: null,
    expiresAt: null,
    updatedAt: nowDate(),
  } as any;
  if (next.type === "popup") await deactivateOtherPopups(id);
  if (next.type === "upgrade_popup" && next.targetVersion) await deactivateOtherUpgradePopups(next.targetVersion, id);
  await db.update(announcements).set(next).where(eq(announcements.id, id));
  const rows = await db.select().from(announcements).where(eq(announcements.id, id)).limit(1);
  return rows[0];
}

export async function deleteAnnouncement(id: number) {
  const db = await getDb();
  if (!db) return;
  await db.delete(announcementReads).where(eq(announcementReads.announcementId, id));
  await db.delete(announcements).where(eq(announcements.id, id));
}

export async function listUserAnnouncements() {
  const rows = await listAnnouncements(false);
  return rows.filter((row: any) => row?.type !== "upgrade_popup");
}

export async function getUnreadPopupAnnouncement(userId: number) {
  const db = await getDb();
  if (!db) return undefined;
  const popupRows = await db
    .select()
    .from(announcements)
    .where(and(eq(announcements.type, "popup"), eq(announcements.isActive, true)))
    .orderBy(desc(announcements.updatedAt), desc(announcements.createdAt))
    .limit(1);
  const popup = popupRows[0];
  if (!popup) return undefined;
  const readRows = await db
    .select({ id: announcementReads.id })
    .from(announcementReads)
    .where(and(eq(announcementReads.announcementId, popup.id), eq(announcementReads.userId, userId)))
    .limit(1);
  return readRows[0] ? undefined : popup;
}

export async function getUnreadUpgradeAnnouncement(userId: number, version: string) {
  const db = await getDb();
  if (!db) return undefined;
  const normalizedVersion = normalizeAnnouncementVersion(version);
  if (!normalizedVersion) return undefined;
  const rows = await db
    .select()
    .from(announcements)
    .where(
      and(
        eq(announcements.type, "upgrade_popup"),
        eq(announcements.targetVersion, normalizedVersion),
        eq(announcements.isActive, true),
      ),
    )
    .orderBy(desc(announcements.updatedAt), desc(announcements.createdAt))
    .limit(1);
  const upgradePopup = rows[0];
  if (!upgradePopup) return undefined;
  const readRows = await db
    .select({ id: announcementReads.id })
    .from(announcementReads)
    .where(and(eq(announcementReads.announcementId, upgradePopup.id), eq(announcementReads.userId, userId)))
    .limit(1);
  return readRows[0] ? undefined : upgradePopup;
}

export async function dismissAnnouncement(userId: number, announcementId: number) {
  const db = await getDb();
  if (!db) return;
  const nowSec = Math.floor(Date.now() / 1000);
  if (getDatabaseKind() === "sqlite") {
    await executeRaw(
      "INSERT INTO announcement_reads (userId, announcementId, dismissedAt) VALUES (?, ?, ?) ON CONFLICT(announcementId, userId) DO UPDATE SET dismissedAt=excluded.dismissedAt",
      [userId, announcementId, nowSec],
    );
  } else if (getDatabaseKind() === "postgresql") {
    await executeRaw(
      'INSERT INTO announcement_reads ("userId", "announcementId", "dismissedAt") VALUES (?, ?, ?) ON CONFLICT ("announcementId", "userId") DO UPDATE SET "dismissedAt"=excluded."dismissedAt"',
      [userId, announcementId, nowSec],
    );
  } else {
    await executeRaw(
      "INSERT INTO announcement_reads (userId, announcementId, dismissedAt) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE dismissedAt=VALUES(dismissedAt)",
      [userId, announcementId, nowSec],
    );
  }
}

export async function ensureBundledDeveloperAnnouncements() {
  const db = await getDb();
  if (!db) return;
  const item = CURRENT_DEVELOPER_UPGRADE_ANNOUNCEMENT;
  if (!item) return;
  const marker = `bundled-developer-announcement:${item.targetVersion}`;
  if (await getSetting(marker)) return;
  const targetVersion = normalizeAnnouncementVersion(item.targetVersion);
  const existing = await db
    .select({ id: announcements.id })
    .from(announcements)
    .where(and(
      eq(announcements.type, "upgrade_popup"),
      eq(announcements.targetVersion, targetVersion),
      eq(announcements.isActive, true),
    ))
    .limit(1);
  if (existing.length === 0) {
    await db.insert(announcements).values({
      title: item.title,
      content: item.content,
      type: "upgrade_popup",
      targetVersion,
      isActive: true,
      startsAt: null,
      expiresAt: null,
      createdByUserId: null,
      createdAt: nowDate(),
      updatedAt: nowDate(),
    } as any);
  }
  await setSetting(marker, String(Math.floor(Date.now() / 1000)));
}
