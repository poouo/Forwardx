import { t, getFormatLocale } from "@/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Download, LockKeyhole } from "lucide-react";
import {
  TICKET_CATEGORY_LABELS,
  TICKET_PRIORITY_LABELS,
  TICKET_STATUS_LABELS,
  type TicketStatus,
} from "@shared/supportTickets";

export function TicketStatusBadge({ status }: { status: TicketStatus }) {
  return (
    <Badge
      variant="outline"
      className={`shrink-0 whitespace-nowrap ${status === "open" ? "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300" : status === "resolved" ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" : "bg-muted/50"}`}
    >
      {t(TICKET_STATUS_LABELS[status])}
    </Badge>
  );
}
export function ticketDate(value: number | null) {
  return value ? new Date(value * 1000).toLocaleString(getFormatLocale()) : "—";
}
export function ticketEventText(
  content: string,
  staffNames: Record<number, string> = {},
) {
  try {
    const event = JSON.parse(content);
    if (event.action === "status")
      return t("状态变更：{0} → {1}", [
        t(TICKET_STATUS_LABELS[event.from as TicketStatus] || event.from),
        t(TICKET_STATUS_LABELS[event.to as TicketStatus] || event.to),
      ]);
    if (event.action === "priority")
      return t("优先级变更：{0}", [
        t(
          TICKET_PRIORITY_LABELS[
            event.to as keyof typeof TICKET_PRIORITY_LABELS
          ] || event.to,
        ),
      ]);
    if (event.action === "category")
      return t("分类变更：{0}", [
        t(
          TICKET_CATEGORY_LABELS[
            event.to as keyof typeof TICKET_CATEGORY_LABELS
          ] || event.to,
        ),
      ]);
    if (event.action === "assignedTo")
      return t("处理人变更：{0}", [
        event.to ? staffNames[event.to] || `#${event.to}` : t("未指派"),
      ]);
    if (event.action === "rating") return t("用户评价：{0} / 5", [event.to]);
  } catch {
    /* Unknown historical events are rendered as plain text. */
  }
  return t("工单已更新");
}
export type SupportMessageView = {
  id: number;
  authorId: number;
  authorName: string;
  authorRole: string;
  kind: string;
  visibility: string;
  content: string;
  createdAt: number;
  attachments: { id: number; name: string; size: number; mime: string }[];
};
export function SupportTicketMessage({
  message,
  staffNames,
  onDownload,
  downloading,
}: {
  message: SupportMessageView;
  staffNames?: Record<number, string>;
  onDownload: (id: number) => void;
  downloading?: boolean;
}) {
  if (message.kind === "event")
    return (
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 border-l-2 border-border pl-3 text-xs text-muted-foreground">
        <span className="min-w-0 break-words">
          {ticketEventText(message.content, staffNames)}
        </span>
        {message.visibility === "internal" && <span>{t("仅管理员可见")}</span>}
        <time className="shrink-0">{ticketDate(message.createdAt)}</time>
      </div>
    );
  return (
    <article
      className={`min-w-0 rounded-xl border p-4 ${message.visibility === "internal" ? "border-amber-500/30 bg-amber-500/5" : message.authorRole === "admin" ? "border-primary/20 bg-primary/5" : "border-border bg-background/60"}`}
    >
      <header className="mb-3 flex min-w-0 flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="break-words font-semibold text-foreground">
            {message.authorName ||
              t(message.authorRole === "admin" ? "管理员" : "用户")}
          </span>
          {message.authorName &&
            message.authorName !==
              t(message.authorRole === "admin" ? "管理员" : "用户") && (
              <Badge variant="outline" className="shrink-0 whitespace-nowrap">
                {t(message.authorRole === "admin" ? "管理员" : "用户")}
              </Badge>
            )}
          {message.visibility === "internal" && (
            <Badge variant="outline" className="shrink-0 whitespace-nowrap">
              <LockKeyhole className="mr-1 h-3 w-3" />
              {t("内部备注")}
            </Badge>
          )}
        </div>
        <time className="shrink-0">{ticketDate(message.createdAt)}</time>
      </header>
      <div className="whitespace-pre-wrap text-sm leading-7 [overflow-wrap:anywhere]">
        {message.content}
      </div>
      {!!message.attachments.length && (
        <div className="mt-3 flex flex-wrap gap-2">
          {message.attachments.map((file) => (
            <Button
              key={file.id}
              type="button"
              variant="outline"
              size="sm"
              className="h-auto max-w-full gap-2 py-2 text-left"
              disabled={downloading}
              onClick={() => onDownload(file.id)}
            >
              <Download className="h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 break-all whitespace-normal">
                {file.name}
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {Math.ceil(file.size / 1024)} KB
              </span>
            </Button>
          ))}
        </div>
      )}
    </article>
  );
}
