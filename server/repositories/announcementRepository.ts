import { and, desc, eq, sql } from "drizzle-orm";
import { announcementReads, announcements, InsertAnnouncement } from "../../drizzle/schema";
import { executeRaw, getDatabaseKind, getDb, nowDate } from "../dbRuntime";
import { getSetting, setSetting } from "./settingsRepository";

const CURRENT_DEVELOPER_UPGRADE_ANNOUNCEMENT: {
  targetVersion: string;
  title: string;
  content: string;
} | null = {
  targetVersion: "2.3.219",
  title: "开发者公告：转发规则创建方式调整",
  content: [
    "这次版本把转发入口拆得更清楚了：新增规则时，不再建议直接挂在主机上随手建普通转发，而是先选已经建好的「端口转发」「隧道转发」「端口转发链」或「转发组」。",
    "",
    "老规则升级后会继续尽量兼容，不会因为这次更新马上失效。但为了后续版本更稳，也方便排查问题，建议管理员抽空把还在用旧方式创建的规则逐步迁到新的转发资源上。",
    "",
    "简单说：普通端口先建「端口转发」再让规则引用；多节点路径用「端口转发链」；多入口、自动切换这类场景用「转发组」或「入口组」。后面的版本可能会减少对老旧配置方式的兼容，建议这次升级后顺手整理一下。",
    "",
    "这次转发相关的调整不算小，如果升级后发现哪里不对，或者有使用上的建议，可以优先到群组里反馈，通常回复和修复都会快一些。GitHub 上提交的问题和需求也会看，只是不会一直盯着；如果想尽快处理，建议直接在群组里说，或者通过 TG 机器人联系我。",
  ].join("\n"),
};

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

export async function listUserAnnouncements(options: { includeUpgradePopups?: boolean } = {}) {
  const rows = await listAnnouncements(false);
  if (options.includeUpgradePopups) return rows;
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
