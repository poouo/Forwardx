export const PAYMENT_RETURN_PATHS = ["/store", "/subscriptions", "/wallet", "/payments"] as const;

export type PaymentReturnPath = (typeof PAYMENT_RETURN_PATHS)[number];
export type PaymentProvider = "easypay" | "alipay" | "wxpay" | "stripe" | "gmpay";

export const DEFAULT_PAYMENT_RETURN_PATH: PaymentReturnPath = "/wallet";

const paymentReturnPathSet = new Set<string>(PAYMENT_RETURN_PATHS);

export function firstStringValue(value: unknown): string {
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === "string" ? first.trim() : "";
}

export function normalizePaymentReturnPath(
  value: unknown,
  fallback: PaymentReturnPath = DEFAULT_PAYMENT_RETURN_PATH,
): PaymentReturnPath {
  const candidate = firstStringValue(value);
  return paymentReturnPathSet.has(candidate) ? candidate as PaymentReturnPath : fallback;
}

export function isPaymentReturnPath(value: unknown): value is PaymentReturnPath {
  return paymentReturnPathSet.has(firstStringValue(value));
}

export function buildPanelUrl(panelUrl: string, path: string, query?: Record<string, string | undefined>): string {
  const url = new URL(panelUrl);
  const basePath = url.pathname.replace(/\/+$/, "");
  const targetPath = path.startsWith("/") ? path : `/${path}`;
  url.pathname = `${basePath}${targetPath}` || "/";
  url.search = "";
  url.hash = "";
  for (const [key, value] of Object.entries(query || {})) {
    if (value) url.searchParams.set(key, value);
  }
  return url.toString();
}

export function buildPaymentWebhookUrl(panelUrl: string, provider: PaymentProvider): string {
  return buildPanelUrl(panelUrl, `/api/payment/webhook/${provider}`);
}

export function buildPaymentProviderReturnUrl(input: {
  panelUrl: string;
  provider: PaymentProvider;
  returnPath: PaymentReturnPath;
  outTradeNo: string;
  cancelled?: boolean;
}): string {
  return buildPanelUrl(input.panelUrl, `/api/payment/return/${input.provider}`, {
    return_to: input.returnPath,
    out_trade_no: input.outTradeNo,
    payment_cancelled: input.cancelled ? "1" : undefined,
  });
}

export function buildPaymentFrontendReturnUrl(input: {
  panelUrl: string;
  provider: PaymentProvider;
  returnPath: PaymentReturnPath;
  outTradeNo?: string;
  cancelled?: boolean;
}): string {
  return buildPanelUrl(input.panelUrl, input.returnPath, {
    payment_return: input.provider,
    out_trade_no: input.outTradeNo,
    payment_cancelled: input.cancelled ? "1" : undefined,
  });
}

export function appendWxpayH5Redirect(h5Url: string, returnUrl: string): string {
  if (!h5Url || !returnUrl) return h5Url;
  try {
    const url = new URL(h5Url);
    url.searchParams.set("redirect_url", returnUrl);
    return url.toString();
  } catch {
    const separator = h5Url.includes("?") ? "&" : "?";
    return `${h5Url}${separator}redirect_url=${encodeURIComponent(returnUrl)}`;
  }
}

export function queryToStringRecord(query: Record<string, unknown>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(query)) {
    const normalized = firstStringValue(value);
    if (normalized) result[key] = normalized;
  }
  return result;
}
