import { t as translateText } from "@/i18n";

const PAYMENT_STATUS_LABELS: Record<string, string> = {
  pending: "待支付",
  paid: "已支付",
  completed: "已完成",
  expired: "已过期",
  cancelled: "已取消",
  failed: "失败",
  processing: "处理中",
};

export function paymentStatusText(status?: string | null) {
  const normalized = String(status || "").trim().toLowerCase();
  return translateText(PAYMENT_STATUS_LABELS[normalized] || status || "未知");
}
