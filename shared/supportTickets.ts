export const TICKET_STATUSES = [
  "open",
  "in_progress",
  "waiting_user",
  "resolved",
  "closed",
] as const;
export const TICKET_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export const TICKET_CATEGORIES = [
  "technical",
  "billing",
  "account",
  "other",
] as const;
export const TICKET_SERVICE_TYPES = [
  "subscription",
  "rule",
  "host",
  "tunnel",
  "group",
  "billing",
] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];
export type TicketCategory = (typeof TICKET_CATEGORIES)[number];
export type TicketServiceType = (typeof TICKET_SERVICE_TYPES)[number];
export const TICKET_STATUS_LABELS: Record<TicketStatus, string> = {
  open: "待处理",
  in_progress: "处理中",
  waiting_user: "待用户回复",
  resolved: "已解决",
  closed: "已关闭",
};
export const TICKET_PRIORITY_LABELS: Record<TicketPriority, string> = {
  low: "低",
  normal: "普通",
  high: "高",
  urgent: "紧急",
};
export const TICKET_CATEGORY_LABELS: Record<TicketCategory, string> = {
  technical: "技术问题",
  billing: "账务问题",
  account: "账户问题",
  other: "其他问题",
};
export const TICKET_SERVICE_LABELS: Record<TicketServiceType, string> = {
  subscription: "订阅套餐",
  rule: "转发规则",
  host: "端口转发",
  tunnel: "隧道",
  group: "转发组",
  billing: "按量计费服务",
};
export const TICKET_ATTACHMENT_MAX_BYTES = 2 * 1024 * 1024;
export const TICKET_ATTACHMENT_MAX_COUNT = 3;
export type TicketAttachmentInput = {
  name: string;
  mime: string;
  base64: string;
};
export type TicketService = {
  type: TicketServiceType;
  id: number;
  name: string;
};
export type SupportActor = { id: number; role: string };
export function isTicketFinished(status: TicketStatus) {
  return status === "resolved" || status === "closed";
}
export function canChangeTicketStatus(
  actor: SupportActor,
  ownerId: number,
  next: TicketStatus,
) {
  return (
    actor.role === "admin" ||
    (actor.id === ownerId && (next === "open" || next === "closed"))
  );
}
