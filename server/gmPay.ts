import crypto from "crypto";

export type GmPayNetwork = "tron" | "ethereum" | "bsc" | "polygon" | "solana" | "aptos" | "plasma";

export const GM_PAY_NETWORKS = ["tron", "ethereum", "bsc", "polygon", "solana", "aptos", "plasma"] as const;

type GmPaySignValue = string | number | null | undefined;

export type GmPayCreateResponse = {
  tradeId: string;
  orderId: string;
  amount: number;
  actualAmount: number;
  receiveAddress: string;
  token: string;
  status: number;
  expirationTime: number;
  paymentUrl: string;
};

export type GmPayGatewayInfo = {
  version: string;
  supportedAssets: Array<{
    network: string;
    displayName: string;
    tokens: string[];
  }>;
};

export function normalizeGmPayBase(value: string): string {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.search || url.hash) return "";
    url.pathname = url.pathname
      .replace(/\/(?:payments\/gmpay\/v1\/(?:order\/create-transaction|config))\/?$/i, "")
      .replace(/\/+$/, "");
    return url.toString().replace(/\/$/, "");
  } catch {
    return "";
  }
}

export function buildGmPayUrl(apiBase: string, path: string): string {
  const normalized = normalizeGmPayBase(apiBase);
  if (!normalized) throw new Error("GM Pay 接口地址无效");
  const url = new URL(normalized);
  const basePath = url.pathname.replace(/\/+$/, "");
  url.pathname = `${basePath}/${path.replace(/^\/+/, "")}`;
  return url.toString();
}

export function normalizeGmPayHostedUrl(value: string, apiBase: string): string {
  const base = normalizeGmPayBase(apiBase);
  if (!base) throw new Error("GM Pay 接口地址无效");
  try {
    const url = new URL(String(value || "").trim(), `${base}/`);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("invalid protocol");
    return url.toString();
  } catch {
    throw new Error("GM Pay 返回的收银台地址无效");
  }
}

function gmPaySignValue(value: GmPaySignValue): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("GM Pay 签名参数包含无效数字");
    return String(value);
  }
  return value;
}

export function gmPaySign(params: Record<string, GmPaySignValue>, secretKey: string): string {
  const content = Object.keys(params)
    .filter((key) => key !== "signature")
    .sort()
    .map((key) => [key, gmPaySignValue(params[key])] as const)
    .filter(([, value]) => value !== "")
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
  return crypto.createHash("md5").update(content + secretKey).digest("hex");
}

export function verifyGmPaySignature(params: Record<string, GmPaySignValue>, secretKey: string): boolean {
  const provided = String(params.signature || "").trim().toLowerCase();
  if (!/^[a-f0-9]{32}$/.test(provided) || !secretKey) return false;
  const expected = gmPaySign(params, secretKey).toLowerCase();
  return crypto.timingSafeEqual(Buffer.from(provided, "ascii"), Buffer.from(expected, "ascii"));
}

async function fetchWithTimeout(url: string, init?: RequestInit, timeoutMs = 15_000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error: any) {
    if (error?.name === "AbortError") throw new Error("GM Pay 请求超时");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function readGmPayJson(response: Response): Promise<any> {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`GM Pay 返回格式异常：${text.slice(0, 160)}`);
  }
}

export async function createGmPayOrder(config: {
  apiBase: string;
  pid: string;
  secretKey: string;
  network: GmPayNetwork;
}, order: {
  outTradeNo: string;
  subject: string;
  amountCents: number;
  notifyUrl: string;
  returnUrl: string;
}): Promise<GmPayCreateResponse> {
  if (!config.pid || !config.secretKey || !config.network) throw new Error("USDT 支付配置不完整");
  if (order.amountCents <= 1) throw new Error("GM Pay 支付金额必须大于 0.01 CNY");
  const params: Record<string, string> = {
    pid: config.pid,
    order_id: order.outTradeNo,
    currency: "cny",
    token: "usdt",
    network: config.network,
    amount: (order.amountCents / 100).toFixed(2),
    notify_url: order.notifyUrl,
    redirect_url: order.returnUrl,
    name: order.subject,
  };
  params.signature = gmPaySign(params, config.secretKey);
  const response = await fetchWithTimeout(buildGmPayUrl(config.apiBase, "/payments/gmpay/v1/order/create-transaction"), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded;charset=utf-8" },
    body: new URLSearchParams(params),
  });
  const payload = await readGmPayJson(response);
  if (!response.ok || Number(payload?.status_code) !== 200 || !payload?.data) {
    throw new Error(payload?.message || `GM Pay 创建订单失败：${response.status}`);
  }
  const data = payload.data;
  if (String(data.order_id || "") !== order.outTradeNo) throw new Error("GM Pay 返回的商户订单号不一致");
  if (String(data.token || "").toUpperCase() !== "USDT") throw new Error("GM Pay 返回的支付币种不是 USDT");
  if (!data.trade_id || !data.payment_url) throw new Error("GM Pay 未返回交易号或收银台地址");
  const paymentUrl = normalizeGmPayHostedUrl(String(data.payment_url), config.apiBase);
  return {
    tradeId: String(data.trade_id),
    orderId: String(data.order_id),
    amount: Number(data.amount || 0),
    actualAmount: Number(data.actual_amount || 0),
    receiveAddress: String(data.receive_address || ""),
    token: String(data.token || "").toUpperCase(),
    status: Number(data.status || 0),
    expirationTime: Number(data.expiration_time || 0),
    paymentUrl,
  };
}

export async function getGmPayGatewayInfo(apiBase: string): Promise<GmPayGatewayInfo> {
  const response = await fetchWithTimeout(buildGmPayUrl(apiBase, "/payments/gmpay/v1/config"), {
    headers: { Accept: "application/json" },
  }, 10_000);
  const payload = await readGmPayJson(response);
  if (!response.ok || Number(payload?.status_code) !== 200 || !payload?.data) {
    throw new Error(payload?.message || `GM Pay 网关检测失败：${response.status}`);
  }
  const supportedAssets = Array.isArray(payload.data.supported_assets)
    ? payload.data.supported_assets.map((asset: any) => ({
      network: String(asset?.network || "").toLowerCase(),
      displayName: String(asset?.display_name || asset?.network || ""),
      tokens: Array.isArray(asset?.tokens) ? asset.tokens.map((token: unknown) => String(token).toUpperCase()) : [],
    })).filter((asset: any) => asset.network)
    : [];
  return {
    version: String(payload.data.version || ""),
    supportedAssets,
  };
}
