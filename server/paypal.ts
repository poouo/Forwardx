import { z } from "zod";
import type { PayPalCurrency } from "../shared/paymentMethods";
import { fetchPaymentText } from "./paymentProtocol";

export type PayPalConfig = {
  enabled: boolean;
  environment: "sandbox" | "live";
  clientId: string;
  clientSecret: string;
  webhookId: string;
  currency: PayPalCurrency;
  cnyPerUnit: number;
};

const paypalId = z.string().regex(/^[A-Z0-9]{1,64}$/i);
const paypalAmount = z.object({
  currency_code: z.string().regex(/^[A-Z]{3}$/),
  value: z.string().regex(/^\d{1,13}(\.\d{1,2})?$/),
}).transform(({ currency_code, value }) => {
  const [whole, fraction = ""] = value.split(".");
  return { currency: currency_code, cents: Number(whole) * 100 + Number(fraction.padEnd(2, "0")) };
});

const paypalOrder = z.object({
  id: paypalId,
  intent: z.literal("CAPTURE"),
  status: z.string(),
  purchase_units: z.tuple([z.object({
    reference_id: z.string().min(1).max(64),
    amount: paypalAmount,
    payments: z.object({
      captures: z.array(z.object({
        id: paypalId,
        status: z.string(),
        amount: paypalAmount,
        final_capture: z.boolean().optional(),
      })).optional(),
    }).optional(),
  })]),
});

export type PayPalOrder = z.infer<typeof paypalOrder>;

const checkoutResponse = z.object({
  id: paypalId,
  links: z.array(z.object({ rel: z.string(), href: z.string() })),
});

export const paypalWebhookEvent = z.object({
  event_type: z.string(),
  resource: z.object({
    id: paypalId,
    supplementary_data: z.object({
      related_ids: z.object({ order_id: paypalId }).optional(),
    }).optional(),
  }),
});

class PayPalApiError extends Error {
  constructor(status: number, readonly issues: string[]) {
    super(`PayPal API returned HTTP ${status}${issues.length ? ` (${issues.join(", ")})` : ""}`);
  }
}

async function paypalJson(url: string, options: RequestInit) {
  const { response, text } = await fetchPaymentText(url, { ...options, redirect: "error" });
  if (!response.ok) {
    const issues = z.object({
      details: z.array(z.object({ issue: z.string().regex(/^[A-Z0-9_]{1,80}$/) })).optional(),
    }).safeParse(parseJson(text));
    throw new PayPalApiError(response.status, issues.success ? issues.data.details?.map(({ issue }) => issue) ?? [] : []);
  }
  return JSON.parse(text) as unknown;
}

function parseJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return null; }
}

export function createPayPalClient(config: PayPalConfig) {
  const sandbox = config.environment === "sandbox";
  const apiHost = sandbox ? "api-m.sandbox.paypal.com" : "api-m.paypal.com";
  const base = `https://${apiHost}`;
  let token: Promise<string> | undefined;
  const getAccessToken = async () => {
    const credentials = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64");
    const response = await paypalJson(`${base}/v1/oauth2/token`, {
      method: "POST",
      headers: { Authorization: `Basic ${credentials}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials",
    });
    return z.object({ access_token: z.string().min(1) }).parse(response).access_token;
  };
  const request = async (path: string, body?: unknown, requestId?: string) => {
    const accessToken = await (token ??= getAccessToken());
    return paypalJson(`${base}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        ...(requestId ? { "PayPal-Request-Id": requestId, Prefer: "return=representation" } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  };
  const orderPath = (id: string) => `/v2/checkout/orders/${paypalId.parse(id)}`;
  const getOrder = async (id: string) => paypalOrder.parse(await request(orderPath(id)));

  return {
    async createOrder(order: { outTradeNo: string; subject: string; amountCents: number; returnUrl: string; cancelUrl: string }) {
      const data = checkoutResponse.parse(await request("/v2/checkout/orders", {
        intent: "CAPTURE",
        purchase_units: [{
          reference_id: order.outTradeNo,
          description: order.subject.slice(0, 127),
          amount: { currency_code: config.currency, value: (order.amountCents / 100).toFixed(2) },
        }],
        payment_source: { paypal: { experience_context: {
          shipping_preference: "NO_SHIPPING",
          user_action: "PAY_NOW",
          return_url: order.returnUrl,
          cancel_url: order.cancelUrl,
        } } },
      }, `create-${order.outTradeNo}`));
      const href = data.links.find(link => link.rel === "payer-action" || link.rel === "approve")?.href;
      if (!href) throw new Error("PayPal approval URL missing");
      const url = new URL(href);
      const checkoutHost = sandbox ? "www.sandbox.paypal.com" : "www.paypal.com";
      if (url.origin !== `https://${checkoutHost}` || url.username || url.password) {
        throw new Error("Invalid PayPal approval URL");
      }
      return { tradeNo: data.id, payUrl: url.href, qrCode: null };
    },
    getOrder,
    async captureOrder(id: string, outTradeNo: string) {
      try {
        const result = paypalOrder.safeParse(await request(`${orderPath(id)}/capture`, {}, `capture-${outTradeNo}`));
        if (result.success) return result.data;
      } catch (error) {
        if (!(error instanceof PayPalApiError && error.issues.includes("ORDER_ALREADY_CAPTURED"))) throw error;
      }
      // A minimal or duplicate-capture response needs a full order lookup.
      return getOrder(id);
    },
    async verifyWebhook(headers: Record<string, unknown>, event: unknown) {
      const payload = {
        auth_algo: headers["paypal-auth-algo"],
        cert_url: headers["paypal-cert-url"],
        transmission_id: headers["paypal-transmission-id"],
        transmission_sig: headers["paypal-transmission-sig"],
        transmission_time: headers["paypal-transmission-time"],
      };
      if (Object.values(payload).some(value => typeof value !== "string" || !value)) return false;
      const result = z.object({ verification_status: z.string() }).parse(await request(
        "/v1/notifications/verify-webhook-signature",
        { ...payload, webhook_id: config.webhookId, webhook_event: event },
      ));
      return result.verification_status === "SUCCESS";
    },
  };
}
