export type CheckoutOrder = {
  outTradeNo: string;
  subject?: string | null;
  payUrl?: string | null;
  qrCode?: string | null;
};

export function paymentPageUrl(value?: string | null) {
  try {
    const url = new URL(value || "");
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

export function paymentQrContent(order: CheckoutOrder) {
  return order.qrCode || (order.payUrl && !paymentPageUrl(order.payUrl) ? order.payUrl : null);
}

export function paymentCheckoutState(status?: string) {
  if (status === "completed") return "completed";
  if (status === "paid" || status === "processing") return "processing";
  if (["expired", "failed", "cancelled"].includes(status || "")) return "closed";
  return "pending";
}
