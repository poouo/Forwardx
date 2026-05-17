import crypto from "crypto";
import express from "express";
import { z } from "zod";
import { adminProcedure, protectedProcedure, router } from "./_core/trpc";
import { appendPanelLog } from "./_core/panelLogger";
import * as db from "./db";

const PAYMENT_CONFIG_KEY = "paymentConfig";

type EasyPayConfig = {
  enabled: boolean;
  apiBase: string;
  pid: string;
  pkey: string;
  mode: "redirect" | "api";
  cidAlipay: string;
  cidWxpay: string;
};

type StripeConfig = {
  enabled: boolean;
  secretKey: string;
  publishableKey: string;
  webhookSecret: string;
  currency: string;
};

type AlipayConfig = {
  enabled: boolean;
  appId: string;
  privateKey: string;
  publicKey: string;
  gateway: string;
  mode: "precreate" | "page" | "wap";
};

type WxpayConfig = {
  enabled: boolean;
  appId: string;
  mchId: string;
  privateKey: string;
  apiV3Key: string;
  certSerial: string;
  publicKey: string;
  publicKeyId: string;
  mode: "native" | "h5" | "jsapi";
  h5AppName: string;
  h5AppUrl: string;
};

type PaymentConfig = {
  enabled: boolean;
  productName: string;
  minAmount: number;
  maxAmount: number;
  orderTimeoutMinutes: number;
  maxPendingOrders: number;
  routes: {
    alipay: "easypay" | "alipay";
    wxpay: "easypay" | "wxpay";
  };
  easypay: EasyPayConfig;
  alipay: AlipayConfig;
  wxpay: WxpayConfig;
  stripe: StripeConfig;
};

const defaultPaymentConfig: PaymentConfig = {
  enabled: false,
  productName: "ForwardX 充值",
  minAmount: 1,
  maxAmount: 0,
  orderTimeoutMinutes: 30,
  maxPendingOrders: 3,
  routes: {
    alipay: "easypay",
    wxpay: "easypay",
  },
  easypay: {
    enabled: false,
    apiBase: "",
    pid: "",
    pkey: "",
    mode: "redirect",
    cidAlipay: "",
    cidWxpay: "",
  },
  alipay: {
    enabled: false,
    appId: "",
    privateKey: "",
    publicKey: "",
    gateway: "https://openapi.alipay.com/gateway.do",
    mode: "precreate",
  },
  wxpay: {
    enabled: false,
    appId: "",
    mchId: "",
    privateKey: "",
    apiV3Key: "",
    certSerial: "",
    publicKey: "",
    publicKeyId: "",
    mode: "native",
    h5AppName: "",
    h5AppUrl: "",
  },
  stripe: {
    enabled: false,
    secretKey: "",
    publishableKey: "",
    webhookSecret: "",
    currency: "cny",
  },
};

const paymentConfigInput = z.object({
  enabled: z.boolean(),
  productName: z.string().trim().min(1).max(80),
  minAmount: z.number().min(0).max(1_000_000),
  maxAmount: z.number().min(0).max(1_000_000),
  orderTimeoutMinutes: z.number().int().min(1).max(1440),
  maxPendingOrders: z.number().int().min(0).max(100),
  routes: z.object({
    alipay: z.enum(["easypay", "alipay"]),
    wxpay: z.enum(["easypay", "wxpay"]),
  }),
  easypay: z.object({
    enabled: z.boolean(),
    apiBase: z.string().trim().max(256),
    pid: z.string().trim().max(128),
    pkey: z.string().max(256).optional(),
    mode: z.enum(["redirect", "api"]),
    cidAlipay: z.string().trim().max(128),
    cidWxpay: z.string().trim().max(128),
  }),
  alipay: z.object({
    enabled: z.boolean(),
    appId: z.string().trim().max(128),
    privateKey: z.string().max(8192).optional(),
    publicKey: z.string().max(8192).optional(),
    gateway: z.string().trim().max(256),
    mode: z.enum(["precreate", "page", "wap"]),
  }),
  wxpay: z.object({
    enabled: z.boolean(),
    appId: z.string().trim().max(128),
    mchId: z.string().trim().max(64),
    privateKey: z.string().max(8192).optional(),
    apiV3Key: z.string().max(128).optional(),
    certSerial: z.string().trim().max(128),
    publicKey: z.string().max(8192).optional(),
    publicKeyId: z.string().trim().max(128),
    mode: z.enum(["native", "h5", "jsapi"]),
    h5AppName: z.string().trim().max(80),
    h5AppUrl: z.string().trim().max(256),
  }),
  stripe: z.object({
    enabled: z.boolean(),
    secretKey: z.string().max(256).optional(),
    publishableKey: z.string().trim().max(256),
    webhookSecret: z.string().max(256).optional(),
    currency: z.string().trim().min(3).max(8),
  }),
});

const createOrderInput = z.object({
  amount: z.number().min(0.01).max(1_000_000),
  paymentType: z.enum(["alipay", "wxpay", "stripe"]),
  planId: z.number().int().positive().optional(),
});

function mergeConfig(raw: any): PaymentConfig {
  return {
    ...defaultPaymentConfig,
    ...(raw || {}),
    routes: { ...defaultPaymentConfig.routes, ...(raw?.routes || {}) },
    easypay: { ...defaultPaymentConfig.easypay, ...(raw?.easypay || {}) },
    alipay: { ...defaultPaymentConfig.alipay, ...(raw?.alipay || {}) },
    wxpay: { ...defaultPaymentConfig.wxpay, ...(raw?.wxpay || {}) },
    stripe: { ...defaultPaymentConfig.stripe, ...(raw?.stripe || {}) },
  };
}

function sanitizeConfig(config: PaymentConfig) {
  return {
    ...config,
    easypay: {
      ...config.easypay,
      pkey: "",
      hasPkey: !!config.easypay.pkey,
    },
    alipay: {
      ...config.alipay,
      privateKey: "",
      publicKey: "",
      hasPrivateKey: !!config.alipay.privateKey,
      hasPublicKey: !!config.alipay.publicKey,
    },
    wxpay: {
      ...config.wxpay,
      privateKey: "",
      apiV3Key: "",
      publicKey: "",
      hasPrivateKey: !!config.wxpay.privateKey,
      hasApiV3Key: !!config.wxpay.apiV3Key,
      hasPublicKey: !!config.wxpay.publicKey,
    },
    stripe: {
      ...config.stripe,
      secretKey: "",
      webhookSecret: "",
      hasSecretKey: !!config.stripe.secretKey,
      hasWebhookSecret: !!config.stripe.webhookSecret,
    },
  };
}

export async function getPaymentConfig(): Promise<PaymentConfig> {
  const raw = await db.getSetting(PAYMENT_CONFIG_KEY);
  if (!raw) return defaultPaymentConfig;
  try {
    return mergeConfig(JSON.parse(raw));
  } catch {
    return defaultPaymentConfig;
  }
}

async function savePaymentConfig(config: PaymentConfig) {
  await db.setSetting(PAYMENT_CONFIG_KEY, JSON.stringify(config));
}

async function getPanelPublicUrl(req?: express.Request) {
  const configured = (await db.getSetting("panelPublicUrl"))?.trim().replace(/\/+$/, "");
  if (configured) return configured;
  if (!req) return "";
  const proto = (req.headers["x-forwarded-proto"] as string)?.split(",")[0]?.trim() || req.protocol || "http";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return host ? `${proto}://${host}` : "";
}

function normalizeEasyPayBase(apiBase: string) {
  return apiBase.trim().replace(/\/(?:submit|mapi|api)\.php$/i, "").replace(/\/+$/, "");
}

function normalizeGateway(url: string, fallback: string) {
  return (url || fallback).trim().replace(/\/+$/, "");
}

function formatMoney(amountCents: number) {
  return (amountCents / 100).toFixed(2);
}

function parseAmountCents(value: string | number | undefined | null) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

function easyPaySign(params: Record<string, string>, pkey: string) {
  const raw = Object.keys(params)
    .filter((key) => key !== "sign" && key !== "sign_type" && params[key] !== "")
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join("&") + pkey;
  return crypto.createHash("md5").update(raw).digest("hex");
}

function createOutTradeNo() {
  const suffix = crypto.randomBytes(4).toString("hex");
  return `FWX${Date.now()}${suffix}`.toUpperCase();
}

function getClientIp(req: express.Request) {
  return (
    (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ||
    req.socket.remoteAddress ||
    ""
  );
}

function formatPem(key: string, type: "PRIVATE KEY" | "PUBLIC KEY") {
  const value = key.trim();
  if (!value) return "";
  if (value.includes("-----BEGIN")) return value;
  const lines = value.replace(/\s+/g, "").match(/.{1,64}/g)?.join("\n") || value;
  return `-----BEGIN ${type}-----\n${lines}\n-----END ${type}-----`;
}

function importPrivateKey(key: string) {
  return crypto.createPrivateKey(formatPem(key, "PRIVATE KEY"));
}

function importPublicKey(key: string) {
  return crypto.createPublicKey(formatPem(key, "PUBLIC KEY"));
}

function rsaSha256Sign(data: string, privateKey: string, output: BufferEncoding = "base64") {
  return crypto.sign("RSA-SHA256", Buffer.from(data), importPrivateKey(privateKey)).toString(output);
}

function rsaSha256Verify(data: string, signature: string, publicKey: string, input: BufferEncoding = "base64") {
  try {
    return crypto.verify("RSA-SHA256", Buffer.from(data), importPublicKey(publicKey), Buffer.from(signature, input));
  } catch {
    return false;
  }
}

function stableJson(value: unknown) {
  return JSON.stringify(value);
}

async function createEasyPayOrder(config: PaymentConfig, order: {
  outTradeNo: string;
  subject: string;
  amountCents: number;
  paymentType: "alipay" | "wxpay";
  panelUrl: string;
  clientIp: string;
}) {
  const ep = config.easypay;
  const apiBase = normalizeEasyPayBase(ep.apiBase);
  if (!ep.enabled || !apiBase || !ep.pid || !ep.pkey) throw new Error("易支付配置不完整");

  const params: Record<string, string> = {
    pid: ep.pid,
    type: order.paymentType,
    out_trade_no: order.outTradeNo,
    notify_url: `${order.panelUrl}/api/payment/webhook/easypay`,
    return_url: `${order.panelUrl}/api/payment/return/easypay`,
    name: order.subject,
    money: formatMoney(order.amountCents),
  };
  const cid = order.paymentType === "alipay" ? ep.cidAlipay : ep.cidWxpay;
  if (cid) params.cid = cid;

  params.sign = easyPaySign(params, ep.pkey);
  params.sign_type = "MD5";

  if (ep.mode === "redirect") {
    return {
      tradeNo: null,
      payUrl: `${apiBase}/submit.php?${new URLSearchParams(params).toString()}`,
      qrCode: null,
    };
  }

  const body = new URLSearchParams({ ...params, clientip: order.clientIp || "127.0.0.1" });
  const res = await fetch(`${apiBase}/mapi.php`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const text = await res.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`易支付返回格式异常：${text.slice(0, 120)}`);
  }
  if (!res.ok || Number(data.code) !== 1) {
    throw new Error(data.msg || data.message || `易支付创建订单失败：${res.status}`);
  }
  return {
    tradeNo: data.trade_no || null,
    payUrl: data.payurl || data.payurl2 || data.qrcode || null,
    qrCode: data.qrcode || null,
  };
}

function alipaySign(params: Record<string, string>, privateKey: string) {
  const signContent = Object.keys(params)
    .filter((key) => key !== "sign" && params[key] !== "")
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join("&");
  return rsaSha256Sign(signContent, privateKey);
}

function alipaySignContent(params: Record<string, string>) {
  return Object.keys(params)
    .filter((key) => key !== "sign" && key !== "sign_type" && params[key] !== "")
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join("&");
}

function normalizeAlipayBaseParams(config: PaymentConfig, method: string, panelUrl: string) {
  const alipay = config.alipay;
  return {
    app_id: alipay.appId,
    method,
    charset: "utf-8",
    sign_type: "RSA2",
    timestamp: new Date().toISOString().slice(0, 19).replace("T", " "),
    version: "1.0",
    notify_url: `${panelUrl}/api/payment/webhook/alipay`,
    return_url: `${panelUrl}/api/payment/return/alipay`,
  };
}

async function callAlipayGateway(config: PaymentConfig, method: string, bizContent: Record<string, unknown>, panelUrl: string) {
  const alipay = config.alipay;
  const gateway = normalizeGateway(alipay.gateway, defaultPaymentConfig.alipay.gateway);
  if (!alipay.enabled || !alipay.appId || !alipay.privateKey || !alipay.publicKey) throw new Error("支付宝官方配置不完整");
  const params: Record<string, string> = {
    ...normalizeAlipayBaseParams(config, method, panelUrl),
    biz_content: stableJson(bizContent),
  };
  params.sign = alipaySign(params, alipay.privateKey);
  const res = await fetch(gateway, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded;charset=utf-8" },
    body: new URLSearchParams(params),
  });
  const text = await res.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`支付宝返回格式异常：${text.slice(0, 120)}`);
  }
  const responseKey = method.replace(/\./g, "_") + "_response";
  const payload = data[responseKey];
  if (!res.ok || !payload || payload.code !== "10000") {
    throw new Error(payload?.sub_msg || payload?.msg || `支付宝请求失败：${res.status}`);
  }
  return payload;
}

async function createAlipayOrder(config: PaymentConfig, order: {
  outTradeNo: string;
  subject: string;
  amountCents: number;
  panelUrl: string;
}) {
  const alipay = config.alipay;
  const gateway = normalizeGateway(alipay.gateway, defaultPaymentConfig.alipay.gateway);
  const amount = formatMoney(order.amountCents);
  if (!alipay.enabled || !alipay.appId || !alipay.privateKey || !alipay.publicKey) throw new Error("支付宝官方配置不完整");
  if (alipay.mode === "page" || alipay.mode === "wap") {
    const method = alipay.mode === "wap" ? "alipay.trade.wap.pay" : "alipay.trade.page.pay";
    const productCode = alipay.mode === "wap" ? "QUICK_WAP_WAY" : "FAST_INSTANT_TRADE_PAY";
    const params: Record<string, string> = {
      ...normalizeAlipayBaseParams(config, method, order.panelUrl),
      biz_content: stableJson({
        out_trade_no: order.outTradeNo,
        total_amount: amount,
        subject: order.subject,
        product_code: productCode,
      }),
    };
    params.sign = alipaySign(params, alipay.privateKey);
    return {
      tradeNo: order.outTradeNo,
      payUrl: `${gateway}?${new URLSearchParams(params).toString()}`,
      qrCode: null,
    };
  }

  const payload = await callAlipayGateway(config, "alipay.trade.precreate", {
    out_trade_no: order.outTradeNo,
    total_amount: amount,
    subject: order.subject,
    product_code: "FACE_TO_FACE_PAYMENT",
  }, order.panelUrl);
  return {
    tradeNo: payload.trade_no || order.outTradeNo,
    payUrl: payload.qr_code || null,
    qrCode: payload.qr_code || null,
  };
}

const zeroDecimalCurrencies = new Set([
  "bif", "clp", "djf", "gnf", "jpy", "kmf", "krw", "mga", "pyg", "rwf", "ugx", "vnd", "vuv", "xaf", "xof", "xpf",
]);

function stripeAmountForCurrency(amountCents: number, currency: string) {
  const normalized = currency.toLowerCase();
  return zeroDecimalCurrencies.has(normalized) ? Math.round(amountCents / 100) : amountCents;
}

async function createStripeCheckoutOrder(config: PaymentConfig, order: {
  outTradeNo: string;
  subject: string;
  amountCents: number;
  panelUrl: string;
}) {
  const stripe = config.stripe;
  if (!stripe.enabled || !stripe.secretKey) throw new Error("Stripe 配置不完整");
  const currency = stripe.currency.trim().toLowerCase();
  const params = new URLSearchParams();
  params.set("mode", "payment");
  params.set("success_url", `${order.panelUrl}/api/payment/return/stripe?out_trade_no=${encodeURIComponent(order.outTradeNo)}`);
  params.set("cancel_url", `${order.panelUrl}/payments?payment_cancelled=1&out_trade_no=${encodeURIComponent(order.outTradeNo)}`);
  params.set("line_items[0][price_data][currency]", currency);
  params.set("line_items[0][price_data][product_data][name]", order.subject);
  params.set("line_items[0][price_data][unit_amount]", String(stripeAmountForCurrency(order.amountCents, currency)));
  params.set("line_items[0][quantity]", "1");
  params.set("metadata[outTradeNo]", order.outTradeNo);
  params.set("payment_intent_data[metadata][outTradeNo]", order.outTradeNo);

  const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${stripe.secretKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "Idempotency-Key": `forwardx-${order.outTradeNo}`,
    },
    body: params,
  });
  const data = await res.json() as any;
  if (!res.ok) {
    throw new Error(data?.error?.message || `Stripe 创建订单失败：${res.status}`);
  }
  if (!data.url) throw new Error("Stripe 未返回 Checkout 链接");
  return {
    tradeNo: data.id || null,
    payUrl: data.url,
    qrCode: null,
  };
}

function wxpayNonce() {
  return crypto.randomBytes(16).toString("hex");
}

function wxpayAuthorization(config: WxpayConfig, method: string, urlPathWithQuery: string, body: string) {
  if (!config.mchId || !config.certSerial || !config.privateKey) throw new Error("微信支付配置不完整");
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = wxpayNonce();
  const message = `${method}\n${urlPathWithQuery}\n${timestamp}\n${nonce}\n${body}\n`;
  const signature = rsaSha256Sign(message, config.privateKey);
  return `WECHATPAY2-SHA256-RSA2048 mchid="${config.mchId}",nonce_str="${nonce}",timestamp="${timestamp}",serial_no="${config.certSerial}",signature="${signature}"`;
}

async function wxpayPost(config: WxpayConfig, urlPath: string, payload: Record<string, unknown>) {
  const body = stableJson(payload);
  const res = await fetch(`https://api.mch.weixin.qq.com${urlPath}`, {
    method: "POST",
    headers: {
      "Authorization": wxpayAuthorization(config, "POST", urlPath, body),
      "Accept": "application/json",
      "Content-Type": "application/json",
    },
    body,
  });
  const text = await res.text();
  let data: any = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`微信支付返回格式异常：${text.slice(0, 120)}`);
    }
  }
  if (!res.ok) {
    throw new Error(data.message || data.code || `微信支付请求失败：${res.status}`);
  }
  return data;
}

function wxpayAesDecrypt(apiV3Key: string, resource: any) {
  const key = Buffer.from(apiV3Key, "utf8");
  if (key.length !== 32) throw new Error("微信 APIv3 密钥必须为 32 个字符");
  const ciphertext = Buffer.from(resource.ciphertext, "base64");
  const authTag = ciphertext.subarray(ciphertext.length - 16);
  const encrypted = ciphertext.subarray(0, ciphertext.length - 16);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(resource.nonce, "utf8"));
  decipher.setAuthTag(authTag);
  if (resource.associated_data) decipher.setAAD(Buffer.from(resource.associated_data, "utf8"));
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

function verifyWxpaySignature(raw: string, headers: express.Request["headers"], publicKey: string) {
  const timestamp = String(headers["wechatpay-timestamp"] || "");
  const nonce = String(headers["wechatpay-nonce"] || "");
  const signature = String(headers["wechatpay-signature"] || "");
  if (!timestamp || !nonce || !signature || !publicKey) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 5 * 60) return false;
  const message = `${timestamp}\n${nonce}\n${raw}\n`;
  return rsaSha256Verify(message, signature, publicKey);
}

function verifyWxpaySerial(headers: express.Request["headers"], expectedPublicKeyId: string) {
  const serial = String(headers["wechatpay-serial"] || "");
  return !expectedPublicKeyId || serial === expectedPublicKeyId;
}

async function createWxpayOrder(config: PaymentConfig, order: {
  outTradeNo: string;
  subject: string;
  amountCents: number;
  panelUrl: string;
  clientIp: string;
}) {
  const wxpay = config.wxpay;
  if (!wxpay.enabled || !wxpay.appId || !wxpay.mchId || !wxpay.privateKey || !wxpay.apiV3Key || !wxpay.certSerial || !wxpay.publicKey || !wxpay.publicKeyId) {
    throw new Error("微信支付配置不完整");
  }
  const basePayload: Record<string, unknown> = {
    appid: wxpay.appId,
    mchid: wxpay.mchId,
    description: order.subject.slice(0, 127),
    out_trade_no: order.outTradeNo,
    notify_url: `${order.panelUrl}/api/payment/webhook/wxpay`,
    amount: {
      total: order.amountCents,
      currency: "CNY",
    },
  };

  if (wxpay.mode === "h5") {
    const sceneInfo: Record<string, unknown> = {
      payer_client_ip: order.clientIp || "127.0.0.1",
      h5_info: { type: "Wap" },
    };
    if (wxpay.h5AppName) (sceneInfo.h5_info as any).app_name = wxpay.h5AppName;
    if (wxpay.h5AppUrl) (sceneInfo.h5_info as any).app_url = wxpay.h5AppUrl;
    const data = await wxpayPost(wxpay, "/v3/pay/transactions/h5", { ...basePayload, scene_info: sceneInfo });
    return {
      tradeNo: order.outTradeNo,
      payUrl: data.h5_url || null,
      qrCode: null,
    };
  }

  if (wxpay.mode === "jsapi") {
    throw new Error("微信 JSAPI 需要用户 OpenID，当前版本暂未开放前台 OAuth 流程");
  }

  const data = await wxpayPost(wxpay, "/v3/pay/transactions/native", basePayload);
  return {
    tradeNo: order.outTradeNo,
    payUrl: data.code_url || null,
    qrCode: data.code_url || null,
  };
}

function parseRawForm(raw: string) {
  const params = new URLSearchParams(raw);
  const out: Record<string, string> = {};
  for (const [key, value] of params.entries()) out[key] = value;
  return out;
}

function verifyStripeSignature(raw: string, header: string | undefined, secret: string) {
  if (!header || !secret) return false;
  const parts = header.split(",").reduce<{ t?: string; v1: string[] }>((acc, part) => {
    const [key, ...rest] = part.split("=");
    const value = rest.join("=");
    if (key === "t") acc.t = value;
    if (key === "v1") acc.v1.push(value);
    return acc;
  }, { v1: [] });
  if (!parts.t || parts.v1.length === 0) return false;
  const timestamp = Number(parts.t);
  if (!Number.isFinite(timestamp) || Math.abs(Date.now() / 1000 - timestamp) > 5 * 60) return false;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${parts.t}.${raw}`)
    .digest("hex");
  return parts.v1.some((sig) => {
    const a = Buffer.from(sig, "hex");
    const b = Buffer.from(expected, "hex");
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  });
}

async function expireStalePendingOrders() {
  const orders = await db.listPaymentOrders(200);
  const now = Date.now();
  for (const order of orders) {
    if (order.status === "pending" && order.expiresAt && new Date(order.expiresAt).getTime() < now) {
      await db.updatePaymentOrder(order.outTradeNo, { status: "expired" } as any);
    }
  }
}

async function finalizePaidOrder(outTradeNo: string) {
  const order = await db.getPaymentOrderByOutTradeNo(outTradeNo);
  if (!order || !order.planId || order.subscriptionId) return;
  const result = await db.applySubscriptionToUser(order.userId, order.planId, "payment", outTradeNo);
  await db.updatePaymentOrder(outTradeNo, { subscriptionId: result.subscriptionId, status: "completed" } as any);
  appendPanelLog("info", `[Plan] subscription granted user=${order.userId} plan=${order.planId} order=${outTradeNo} ports=${result.portRangeStart}-${result.portRangeEnd}`);
}

export const paymentRouter = router({
  availableMethods: protectedProcedure.query(async () => {
    const config = await getPaymentConfig();
    if (!config.enabled) return [];
    const methods: Array<{ value: "alipay" | "wxpay" | "stripe"; label: string }> = [];
    const alipayProvider = config.routes.alipay;
    const wxpayProvider = config.routes.wxpay;
    if ((alipayProvider === "easypay" && config.easypay.enabled) || (alipayProvider === "alipay" && config.alipay.enabled)) {
      methods.push({ value: "alipay", label: "支付宝" });
    }
    if ((wxpayProvider === "easypay" && config.easypay.enabled) || (wxpayProvider === "wxpay" && config.wxpay.enabled)) {
      methods.push({ value: "wxpay", label: "微信支付" });
    }
    if (config.stripe.enabled) {
      methods.push({ value: "stripe", label: "Stripe" });
    }
    return methods;
  }),

  getConfig: adminProcedure.query(async () => {
    const config = await getPaymentConfig();
    return sanitizeConfig(config);
  }),

  updateConfig: adminProcedure
    .input(paymentConfigInput)
    .mutation(async ({ input }) => {
      const previous = await getPaymentConfig();
      const next = mergeConfig({
        ...input,
        easypay: {
          ...input.easypay,
          pkey: input.easypay.pkey?.trim() || previous.easypay.pkey,
          apiBase: normalizeEasyPayBase(input.easypay.apiBase),
        },
        alipay: {
          ...input.alipay,
          privateKey: input.alipay.privateKey?.trim() || previous.alipay.privateKey,
          publicKey: input.alipay.publicKey?.trim() || previous.alipay.publicKey,
          gateway: normalizeGateway(input.alipay.gateway, defaultPaymentConfig.alipay.gateway),
        },
        wxpay: {
          ...input.wxpay,
          privateKey: input.wxpay.privateKey?.trim() || previous.wxpay.privateKey,
          apiV3Key: input.wxpay.apiV3Key?.trim() || previous.wxpay.apiV3Key,
          publicKey: input.wxpay.publicKey?.trim() || previous.wxpay.publicKey,
        },
        stripe: {
          ...input.stripe,
          secretKey: input.stripe.secretKey?.trim() || previous.stripe.secretKey,
          webhookSecret: input.stripe.webhookSecret?.trim() || previous.stripe.webhookSecret,
          currency: input.stripe.currency.trim().toLowerCase(),
        },
      });
      await savePaymentConfig(next);
      appendPanelLog("info", "[Payment] config updated");
      return sanitizeConfig(next);
    }),

  stats: adminProcedure.query(async () => {
    await expireStalePendingOrders();
    return db.getPaymentOrderStats();
  }),

  listOrders: adminProcedure
    .input(z.object({ limit: z.number().int().min(1).max(500).default(100) }).optional())
    .query(async ({ input }) => {
      await expireStalePendingOrders();
      return db.listPaymentOrders(input?.limit || 100);
    }),

  createOrder: protectedProcedure
    .input(createOrderInput)
    .mutation(async ({ input, ctx }) => {
      const config = await getPaymentConfig();
      if (!config.enabled) throw new Error("支付功能未启用");
      let amount = input.amount;
      let subjectSuffix = ctx.user.username;
      if (input.planId) {
        const shopEnabled = (await db.getSetting("storeEnabled")) === "true";
        if (!shopEnabled) throw new Error("商店功能未开启");
        const plan = await db.getSubscriptionPlanById(input.planId);
        if (!plan || !plan.isActive || !plan.isStoreVisible) throw new Error("套餐不可购买");
        amount = Number(plan.priceCents || 0) / 100;
        subjectSuffix = `${plan.name} - ${ctx.user.username}`;
      }
      if (amount < config.minAmount) throw new Error(`最低支付金额为 ${config.minAmount}`);
      if (config.maxAmount > 0 && amount > config.maxAmount) throw new Error(`最高支付金额为 ${config.maxAmount}`);

      const userOrders = await db.listPaymentOrders(200, ctx.user.id);
      const pendingCount = userOrders.filter((order) => order.status === "pending" && (!order.expiresAt || new Date(order.expiresAt).getTime() > Date.now())).length;
      if (config.maxPendingOrders > 0 && pendingCount >= config.maxPendingOrders) {
        throw new Error("待支付订单过多，请先完成或等待旧订单过期");
      }

      const provider = input.paymentType === "stripe"
        ? "stripe"
        : input.paymentType === "alipay"
          ? config.routes.alipay
          : config.routes.wxpay;
      if (provider === "alipay" && !config.alipay.enabled) throw new Error("支付宝官方未启用");
      if (provider === "wxpay" && !config.wxpay.enabled) throw new Error("微信支付未启用");
      if (provider === "easypay" && !config.easypay.enabled) throw new Error("易支付未启用");
      if (provider === "stripe" && !config.stripe.enabled) throw new Error("Stripe 未启用");

      const amountCents = Math.round(amount * 100);
      const outTradeNo = createOutTradeNo();
      const panelUrl = await getPanelPublicUrl(ctx.req);
      if (!panelUrl) throw new Error("请先配置面板公开访问地址");
      const subject = input.planId ? subjectSuffix : `${config.productName} - ${ctx.user.username}`;
      const expiresAt = new Date(Date.now() + config.orderTimeoutMinutes * 60 * 1000);
      const paymentResult = provider === "stripe"
        ? await createStripeCheckoutOrder(config, { outTradeNo, subject, amountCents, panelUrl })
        : provider === "alipay"
          ? await createAlipayOrder(config, { outTradeNo, subject, amountCents, panelUrl })
          : provider === "wxpay"
            ? await createWxpayOrder(config, { outTradeNo, subject, amountCents, panelUrl, clientIp: getClientIp(ctx.req) })
            : await createEasyPayOrder(config, {
              outTradeNo,
              subject,
              amountCents,
              paymentType: input.paymentType as "alipay" | "wxpay",
              panelUrl,
              clientIp: getClientIp(ctx.req),
            });

      const order = await db.createPaymentOrder({
        outTradeNo,
        userId: ctx.user.id,
        provider,
        paymentType: input.paymentType,
        status: "pending",
        subject,
        amountCents,
        currency: provider === "stripe" ? config.stripe.currency.toUpperCase() : "CNY",
        tradeNo: paymentResult.tradeNo,
        payUrl: paymentResult.payUrl,
        qrCode: paymentResult.qrCode,
        planId: input.planId ?? null,
        clientIp: getClientIp(ctx.req),
        expiresAt,
      } as any);
      appendPanelLog("info", `[Payment] order created user=${ctx.user.id} provider=${provider} outTradeNo=${outTradeNo}`);
      return order;
    }),
});

export const paymentCallbackRouter = express.Router();

paymentCallbackRouter.post("/api/payment/webhook/easypay", express.raw({ type: "*/*", limit: "1mb" }), async (req, res) => {
  try {
    const config = await getPaymentConfig();
    const raw = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";
    const params = parseRawForm(raw);
    const expected = easyPaySign(params, config.easypay.pkey);
    if (!params.sign || expected.toLowerCase() !== params.sign.toLowerCase()) {
      appendPanelLog("warn", "[Payment] EasyPay notify signature failed");
      res.status(400).send("fail");
      return;
    }
    if (params.trade_status !== "TRADE_SUCCESS") {
      res.send("success");
      return;
    }
    const outTradeNo = params.out_trade_no;
    if (!outTradeNo) throw new Error("missing out_trade_no");
    await db.markPaymentOrderPaid(outTradeNo, {
      tradeNo: params.trade_no,
      amountCents: parseAmountCents(params.money),
      currency: "CNY",
      rawNotify: raw,
    });
    await finalizePaidOrder(outTradeNo);
    appendPanelLog("info", `[Payment] EasyPay paid outTradeNo=${outTradeNo}`);
    res.send("success");
  } catch (error: any) {
    appendPanelLog("error", `[Payment] EasyPay notify failed: ${error?.message || error}`);
    res.status(500).send("fail");
  }
});

paymentCallbackRouter.get("/api/payment/return/easypay", async (_req, res) => {
  res.redirect("/payments?payment_return=easypay");
});

paymentCallbackRouter.post("/api/payment/webhook/alipay", express.raw({ type: "*/*", limit: "1mb" }), async (req, res) => {
  try {
    const config = await getPaymentConfig();
    const raw = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";
    const params = parseRawForm(raw);
    const sign = params.sign || "";
    if (!config.alipay.publicKey || !sign || !rsaSha256Verify(alipaySignContent(params), sign, config.alipay.publicKey)) {
      appendPanelLog("warn", "[Payment] Alipay notify signature failed");
      res.status(400).send("failure");
      return;
    }
    if (params.trade_status !== "TRADE_SUCCESS" && params.trade_status !== "TRADE_FINISHED") {
      res.send("success");
      return;
    }
    const outTradeNo = params.out_trade_no;
    if (!outTradeNo) throw new Error("missing out_trade_no");
    await db.markPaymentOrderPaid(outTradeNo, {
      tradeNo: params.trade_no,
      amountCents: parseAmountCents(params.total_amount),
      currency: "CNY",
      rawNotify: raw,
    });
    await finalizePaidOrder(outTradeNo);
    appendPanelLog("info", `[Payment] Alipay paid outTradeNo=${outTradeNo}`);
    res.send("success");
  } catch (error: any) {
    appendPanelLog("error", `[Payment] Alipay notify failed: ${error?.message || error}`);
    res.status(500).send("failure");
  }
});

paymentCallbackRouter.get("/api/payment/return/alipay", async (_req, res) => {
  res.redirect("/payments?payment_return=alipay");
});

paymentCallbackRouter.post("/api/payment/webhook/wxpay", express.raw({ type: "*/*", limit: "1mb" }), async (req, res) => {
  try {
    const config = await getPaymentConfig();
    const raw = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";
    if (!verifyWxpaySerial(req.headers, config.wxpay.publicKeyId)) {
      appendPanelLog("warn", "[Payment] WeChat Pay notify serial mismatch");
      res.status(400).json({ code: "FAIL", message: "invalid serial" });
      return;
    }
    if (!verifyWxpaySignature(raw, req.headers, config.wxpay.publicKey)) {
      appendPanelLog("warn", "[Payment] WeChat Pay notify signature failed");
      res.status(400).json({ code: "FAIL", message: "invalid signature" });
      return;
    }
    const event = JSON.parse(raw);
    if (event.event_type !== "TRANSACTION.SUCCESS" || !event.resource) {
      res.status(204).end();
      return;
    }
    const decrypted = wxpayAesDecrypt(config.wxpay.apiV3Key, event.resource);
    const transaction = JSON.parse(decrypted);
    if (transaction.trade_state !== "SUCCESS") {
      res.status(204).end();
      return;
    }
    const outTradeNo = transaction.out_trade_no;
    if (!outTradeNo) throw new Error("missing out_trade_no");
    await db.markPaymentOrderPaid(outTradeNo, {
      tradeNo: transaction.transaction_id,
      amountCents: Number(transaction.amount?.total || 0),
      currency: transaction.amount?.currency || "CNY",
      rawNotify: raw,
    });
    await finalizePaidOrder(outTradeNo);
    appendPanelLog("info", `[Payment] WeChat Pay paid outTradeNo=${outTradeNo}`);
    res.status(204).end();
  } catch (error: any) {
    appendPanelLog("error", `[Payment] WeChat Pay notify failed: ${error?.message || error}`);
    res.status(500).json({ code: "FAIL", message: "webhook failed" });
  }
});

paymentCallbackRouter.get("/api/payment/return/wxpay", async (_req, res) => {
  res.redirect("/payments?payment_return=wxpay");
});

paymentCallbackRouter.post("/api/payment/webhook/stripe", express.raw({ type: "*/*", limit: "1mb" }), async (req, res) => {
  try {
    const config = await getPaymentConfig();
    const raw = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";
    const signature = req.headers["stripe-signature"] as string | undefined;
    if (!verifyStripeSignature(raw, signature, config.stripe.webhookSecret)) {
      appendPanelLog("warn", "[Payment] Stripe webhook signature failed");
      res.status(400).json({ error: "invalid signature" });
      return;
    }
    const event = JSON.parse(raw);
    const object = event?.data?.object || {};
    const outTradeNo = object?.metadata?.outTradeNo || object?.metadata?.orderId;
    if (event.type === "checkout.session.completed" && outTradeNo && object.payment_status === "paid") {
      await db.markPaymentOrderPaid(outTradeNo, {
        tradeNo: object.payment_intent || object.id,
        amountCents: Number(object.amount_total || 0),
        currency: String(object.currency || config.stripe.currency).toUpperCase(),
        rawNotify: raw,
      });
      await finalizePaidOrder(outTradeNo);
      appendPanelLog("info", `[Payment] Stripe paid outTradeNo=${outTradeNo}`);
    } else if (event.type === "checkout.session.expired" && outTradeNo) {
      await db.updatePaymentOrder(outTradeNo, { status: "expired", rawNotify: raw } as any);
    } else if (event.type === "payment_intent.payment_failed" && outTradeNo) {
      await db.updatePaymentOrder(outTradeNo, { status: "failed", rawNotify: raw } as any);
    }
    res.json({ received: true });
  } catch (error: any) {
    appendPanelLog("error", `[Payment] Stripe webhook failed: ${error?.message || error}`);
    res.status(500).json({ error: "webhook failed" });
  }
});

paymentCallbackRouter.get("/api/payment/return/stripe", async (_req, res) => {
  res.redirect("/payments?payment_return=stripe");
});
