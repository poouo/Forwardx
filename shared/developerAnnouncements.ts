import { z } from "zod";
import { ADMIN_VISIT_CHECK_INTERVAL_MS } from "./visitChecks";

export const DEVELOPER_ANNOUNCEMENT_INTERVAL_MS = ADMIN_VISIT_CHECK_INTERVAL_MS;
const version = z.string().regex(/^\d{1,6}\.\d{1,6}\.\d{1,6}$/);
const localized = (max: number) => z.object({ "zh-CN": z.string().trim().min(1).max(max), en: z.string().trim().min(1).max(max) }).strict();
export const developerAnnouncementSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/),
  revision: z.number().int().min(1).max(999999),
  title: localized(120), content: localized(12000),
  publishedAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }).optional(),
  minVersion: version.optional(), maxVersion: version.optional(), fixedVersion: version.optional(),
}).strict().refine(item => !item.minVersion || !item.maxVersion || compareAnnouncementVersions(item.minVersion, item.maxVersion) <= 0, "Invalid version range");
export const developerAnnouncementFeedSchema = z.object({
  version: z.literal(1), announcements: z.array(developerAnnouncementSchema).max(100),
}).strict().refine(feed => new Set(feed.announcements.map(item => item.id)).size === feed.announcements.length, "Duplicate announcement IDs");
export type DeveloperAnnouncement = z.infer<typeof developerAnnouncementSchema>;
export const developerAnnouncementReadKeySchema = z.string().regex(/^developer:[A-Za-z0-9][A-Za-z0-9._-]{0,79}:[1-9]\d{0,5}$/);
export function developerAnnouncementReadKey(item: Pick<DeveloperAnnouncement, "id" | "revision">) {
  return `developer:${item.id}:${item.revision}`;
}
export function compareAnnouncementVersions(a: string, b: string) {
  const aa = a.replace(/^v/i, "").split(".").map(Number), bb = b.replace(/^v/i, "").split(".").map(Number);
  for (let i = 0; i < 3; i++) if (aa[i] !== bb[i]) return aa[i] > bb[i] ? 1 : -1;
  return 0;
}
export function eligibleDeveloperAnnouncements(items: DeveloperAnnouncement[], installedVersion: string, now = Date.now()) {
  if (!version.safeParse(installedVersion.replace(/^v/i, "")).success) return [];
  return items.filter(item => Date.parse(item.publishedAt) <= now && (!item.expiresAt || Date.parse(item.expiresAt) > now)
    && (!item.minVersion || compareAnnouncementVersions(installedVersion, item.minVersion) >= 0)
    && (!item.maxVersion || compareAnnouncementVersions(installedVersion, item.maxVersion) <= 0)
    && (!item.fixedVersion || compareAnnouncementVersions(installedVersion, item.fixedVersion) < 0))
    .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt) || b.revision - a.revision || a.id.localeCompare(b.id));
}
