import { appendPanelLog } from "./_core/panelLogger";
import { getNotificationAnnouncementSubscribers, sendUserNotification } from "./notifications";
import { publishDueAnnouncements } from "./repositories/announcementRepository";

function escapeTelegramHtml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function announcementTelegramText(title: string, content: string) {
  const plain = content
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?>[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[#*_`>~-]/g, "")
    .replace(/\s+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const body = plain.length > 3200 ? `${plain.slice(0, 3200)}...` : plain;
  return [
    "<b>ForwardX 新公告</b>",
    "",
    `<b>${escapeTelegramHtml(title)}</b>`,
    "",
    escapeTelegramHtml(body || "请登录面板查看公告详情。"),
    "",
    "可在个人资料中关闭公告通知。",
  ].join("\n");
}

export async function pushAnnouncement(announcement: { id: number; title: string; content: string }, requested: boolean) {
  if (!requested) return { requested, sent: 0, failed: 0, total: 0 };
  const subscribers = await getNotificationAnnouncementSubscribers().catch((error) => {
    console.warn(`[Announcement] Could not load subscribers id=${announcement.id}:`, error);
    return null;
  });
  if (!subscribers) return { requested, sent: 0, failed: 1, total: 0 };
  const text = announcementTelegramText(announcement.title, announcement.content);
  let sent = 0;
  let failed = 0;
  for (const user of subscribers) {
    if (!user.notificationId) continue;
    try {
      await sendUserNotification(user, text);
      sent += 1;
    } catch (error) {
      failed += 1;
      console.warn(`[Announcement] Notification push failed user=${user.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  appendPanelLog("info", `[Announcement] notification push id=${announcement.id} sent=${sent} failed=${failed} total=${subscribers.length}`);
  return { requested, sent, failed, total: subscribers.length };
}

export async function runScheduledAnnouncementPublishing() {
  for (const announcement of await publishDueAnnouncements()) {
    appendPanelLog("info", `[Announcement] published scheduled id=${announcement.id}`);
    if (announcement.pushOnPublish) {
      void pushAnnouncement(announcement, true).catch((error) => {
        console.warn(`[Announcement] Scheduled notification push failed id=${announcement.id}:`, error);
      });
    }
  }
}
