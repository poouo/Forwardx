import {
  getSupportTicket,
  type TicketActor,
} from "./repositories/supportTicketRepository";
import {
  getNotificationAdminRecipients,
  isNotificationReady,
  sendUserNotification,
} from "./notifications";
import { getUserById } from "./repositories/userRepository";
import { appendPanelLog } from "./_core/panelLogger";

const escape = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** A failed optional push must never roll back or duplicate a committed reply. */
export function notifySupportTicket(
  actor: TicketActor,
  id: number,
  created = false,
) {
  void (async () => {
    if (!(await isNotificationReady())) return;
    const ticket = await getSupportTicket(actor, id);
    const recipients =
      actor.role === "admin" && !created
        ? [await getUserById(Number(ticket.userId))].filter(Boolean)
        : await getNotificationAdminRecipients();
    const message = `<b>ForwardX ${created ? "新工单" : "工单更新"} #${id}</b>\n${escape(ticket.title)}\n请登录面板的「工单支持」查看详情。`;
    for (const user of recipients) {
      if (
        Number(user!.id) === actor.id ||
        (!user!.telegramId && !user!.discordId)
      )
        continue;
      try {
        await sendUserNotification(user, message);
      } catch {
        appendPanelLog(
          "warn",
          `[Support] notification failed ticket=${id} user=${user!.id}`,
        );
      }
    }
  })().catch(() =>
    appendPanelLog("warn", `[Support] notification unavailable ticket=${id}`),
  );
}
