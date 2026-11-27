import { getFormatLocale, t } from "@/i18n";

type AnnouncementDates = {
  scheduledAt?: Date | string | null;
  publishedAt?: Date | string | null;
  createdAt: Date | string;
  editedAt?: Date | string | null;
};

export function isScheduledAnnouncement(item: AnnouncementDates) {
  return Boolean(item.scheduledAt && !item.publishedAt);
}

export function announcementDateText(item: AnnouncementDates) {
  if (item.scheduledAt && isScheduledAnnouncement(item)) {
    return t("计划发布时间：{0}", [new Date(item.scheduledAt).toLocaleString(getFormatLocale())]);
  }
  const published = new Date(item.publishedAt ?? item.createdAt).toLocaleString(getFormatLocale());
  const labels = [t("发布时间：") + published];
  if (item.editedAt) {
    labels.push(t("最后编辑：{0}", [new Date(item.editedAt).toLocaleString(getFormatLocale())]));
  }
  return labels.join(" · ");
}

export function toLocalDateTime(value: Date | string) {
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 19);
}
