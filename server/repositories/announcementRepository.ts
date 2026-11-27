import { and, asc, desc, eq, isNotNull, isNull, lte, ne, or, sql } from "drizzle-orm";
import { announcementReads, announcements, type Announcement, type InsertAnnouncement } from "../../drizzle/schema";
import { executeRaw, getDatabaseKind, getDb, insertAndGetId, nowDate, queryRaw, quoteDbIdentifier, withDatabaseTransaction } from "../dbRuntime";
import { getSetting, setSetting } from "./settingsRepository";

const CURRENT_DEVELOPER_UPGRADE_ANNOUNCEMENT: {
  targetVersion: string;
  title: string;
  content: string;
} | null = null;

function normalizeAnnouncementVersion(version: string | null | undefined) {
  return String(version || "").trim().replace(/^v/i, "");
}

const publicationTime = sql<number>`COALESCE(${announcements.publishedAt}, ${announcements.createdAt})`;

const published = or(isNull(announcements.scheduledAt), isNotNull(announcements.publishedAt));
const visible = and(eq(announcements.isActive, true), published);

async function getAnnouncementForUpdate(id: number): Promise<Announcement | undefined> {
  const db = await getDb();
  if (!db) return undefined;
  const q = quoteDbIdentifier;
  const lock = getDatabaseKind() === "sqlite" ? "" : " FOR UPDATE";
  const rows = await queryRaw(`SELECT id FROM ${q("announcements")} WHERE id = ?${lock}`, [id]);
  if (!rows.length) return undefined;
  return (await db.select().from(announcements).where(eq(announcements.id, id)).limit(1))[0];
}

async function replacePublishedPopup(item: Announcement) {
  if (item.type !== "popup" && (item.type !== "upgrade_popup" || !item.targetVersion)) return;
  const db = await getDb();
  if (!db) return;
  const sameGroup = item.type === "popup"
    ? eq(announcements.type, "popup")
    : and(eq(announcements.type, "upgrade_popup"), eq(announcements.targetVersion, item.targetVersion!));
  await db.update(announcements).set({ isActive: false }).where(and(
    sameGroup,
    ne(announcements.id, item.id),
    eq(announcements.isActive, true),
    published,
  ));
}

export async function listAnnouncements(includeInactive = false): Promise<Announcement[]> {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(announcements)
    .where(includeInactive ? undefined : visible)
    .orderBy(desc(publicationTime), desc(announcements.id));
}

export async function createAnnouncement(data: InsertAnnouncement) {
  return withDatabaseTransaction(async () => {
    const now = nowDate();
    const scheduledAt = data.scheduledAt ?? null;
    if (scheduledAt && scheduledAt <= now) throw new Error("定时发布时间必须晚于当前时间");
    const id = await insertAndGetId("announcements", {
      ...data,
      targetVersion: data.type === "upgrade_popup" ? normalizeAnnouncementVersion(data.targetVersion) || null : null,
      isActive: true,
      scheduledAt,
      publishedAt: scheduledAt ? null : now,
    });
    const item = await getAnnouncementForUpdate(id);
    if (!item) throw new Error("公告不存在");
    if (!scheduledAt) await replacePublishedPopup(item);
    return item;
  });
}

export async function updateAnnouncement(id: number, data: Partial<InsertAnnouncement>) {
  return withDatabaseTransaction(async () => {
    const db = await getDb();
    const current = await getAnnouncementForUpdate(id);
    if (!db || !current) throw new Error("公告不存在");
    const now = nowDate();
    const scheduled = !!current.scheduledAt && !current.publishedAt;
    const scheduledAt = data.scheduledAt === undefined ? current.scheduledAt : data.scheduledAt;
    if (!scheduled && data.scheduledAt != null) throw new Error("已发布公告的发布时间不能更改");
    if (scheduled && data.scheduledAt && data.scheduledAt <= now) throw new Error("定时发布时间必须晚于当前时间");
    const type = data.type ?? current.type;
    const targetVersion = type === "upgrade_popup"
      ? normalizeAnnouncementVersion(data.targetVersion ?? current.targetVersion) || null
      : null;
    const publishingNow = scheduled && !scheduledAt;
    const notificationRequested = data.pushOnPublish ?? current.pushOnPublish;
    const edited = !scheduled && (data.title !== undefined && data.title !== current.title
      || data.content !== undefined && data.content !== current.content
      || type !== current.type || targetVersion !== current.targetVersion);
    await db.update(announcements).set({
      ...data,
      type,
      targetVersion,
      scheduledAt: scheduled ? scheduledAt : current.scheduledAt,
      publishedAt: publishingNow ? now : current.publishedAt,
      editedAt: edited ? now : current.editedAt,
      pushOnPublish: scheduled && !publishingNow && notificationRequested,
      updatedAt: now,
    }).where(eq(announcements.id, id));
    const next = (await db.select().from(announcements).where(eq(announcements.id, id)).limit(1))[0] as Announcement;
    if (next.isActive && (publishingNow || (!scheduled && (type !== current.type || targetVersion !== current.targetVersion)))) {
      await replacePublishedPopup(next);
    }
    return {
      announcement: next,
      shouldPush: next.isActive && (!scheduled || publishingNow) && notificationRequested,
    };
  });
}

export async function publishDueAnnouncements(now = nowDate()) {
  const db = await getDb();
  if (!db) return [];
  const due = await db.select({ id: announcements.id }).from(announcements).where(and(
    eq(announcements.isActive, true),
    isNull(announcements.publishedAt),
    lte(announcements.scheduledAt, now),
  )).orderBy(asc(announcements.scheduledAt), asc(announcements.id)).limit(50);
  const published: Announcement[] = [];
  for (const { id } of due) {
    const item = await withDatabaseTransaction(async () => {
      const row = await getAnnouncementForUpdate(id);
      if (!row?.isActive || row.publishedAt || !row.scheduledAt || row.scheduledAt > now) return;
      await (await getDb())!.update(announcements).set({ publishedAt: now, pushOnPublish: false }).where(eq(announcements.id, id));
      await replacePublishedPopup(row);
      return row;
    });
    if (item) published.push(item);
  }
  return published;
}

export async function deleteAnnouncement(id: number) {
  await withDatabaseTransaction(async () => {
    const db = await getDb();
    if (!db || !await getAnnouncementForUpdate(id)) return;
    await db.delete(announcementReads).where(eq(announcementReads.announcementId, id));
    await db.delete(announcements).where(eq(announcements.id, id));
  });
}

export async function listUserAnnouncements(includeInactive = false) {
  const rows = await listAnnouncements(includeInactive);
  return rows.filter((row: Announcement) => row.type !== "upgrade_popup");
}

export async function getUnreadPopupAnnouncement(userId: number) {
  const db = await getDb();
  if (!db) return undefined;
  const popupRows = await db
    .select()
    .from(announcements)
    .where(and(eq(announcements.type, "popup"), visible))
    .orderBy(desc(publicationTime), desc(announcements.id))
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
        visible,
      ),
    )
    .orderBy(desc(publicationTime), desc(announcements.id))
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
