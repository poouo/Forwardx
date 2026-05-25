import * as db from "./db";

export type DdnsProvider = "disabled" | "cloudflare" | "webhook";

export interface DdnsSettings {
  provider: DdnsProvider;
  enabled: boolean;
  cloudflareZoneId: string;
  cloudflareApiToken: string;
  webhookUrl: string;
  webhookMethod: "POST" | "PUT" | "GET";
  webhookHeaders: string;
}

export function maskSecret(value: string | null | undefined) {
  const v = String(value || "").trim();
  if (!v) return "";
  if (v.length <= 8) return `${v.slice(0, 2)}${"*".repeat(Math.max(4, v.length - 2))}`;
  return `${v.slice(0, 4)}${"*".repeat(Math.max(6, v.length - 8))}${v.slice(-4)}`;
}

export async function getDdnsSettings(): Promise<DdnsSettings> {
  const all = await db.getAllSettings();
  const provider = String(all.ddnsProvider || "disabled") as DdnsProvider;
  const method = String(all.ddnsWebhookMethod || "POST").toUpperCase();
  return {
    provider: provider === "cloudflare" || provider === "webhook" ? provider : "disabled",
    enabled: all.ddnsEnabled === "true",
    cloudflareZoneId: String(all.ddnsCloudflareZoneId || ""),
    cloudflareApiToken: String(all.ddnsCloudflareApiToken || ""),
    webhookUrl: String(all.ddnsWebhookUrl || ""),
    webhookMethod: method === "PUT" || method === "GET" ? method : "POST",
    webhookHeaders: String(all.ddnsWebhookHeaders || ""),
  };
}

function parseHeaders(raw: string) {
  const out: Record<string, string> = {};
  const value = raw.trim();
  if (!value) return out;
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === "object") {
      for (const [key, val] of Object.entries(parsed)) {
        if (key && val != null) out[key] = String(val);
      }
    }
  } catch {
    for (const line of value.split(/\r?\n/)) {
      const idx = line.indexOf(":");
      if (idx <= 0) continue;
      out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
  }
  return out;
}

async function updateCloudflare(input: {
  zoneId: string;
  apiToken: string;
  domain: string;
  recordType: string;
  value: string;
}) {
  const base = `https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(input.zoneId)}/dns_records`;
  const headers = {
    Authorization: `Bearer ${input.apiToken}`,
    "Content-Type": "application/json",
  };
  const findUrl = `${base}?type=${encodeURIComponent(input.recordType)}&name=${encodeURIComponent(input.domain)}`;
  const findResp = await fetch(findUrl, { headers });
  const findBody = await findResp.json().catch(() => ({}));
  if (!findResp.ok || findBody?.success === false) {
    throw new Error(findBody?.errors?.[0]?.message || `Cloudflare 查询记录失败 ${findResp.status}`);
  }
  const record = Array.isArray(findBody?.result) ? findBody.result[0] : null;
  const payload = {
    type: input.recordType,
    name: input.domain,
    content: input.value,
    ttl: 60,
    proxied: false,
  };
  const resp = await fetch(record?.id ? `${base}/${record.id}` : base, {
    method: record?.id ? "PUT" : "POST",
    headers,
    body: JSON.stringify(payload),
  });
  const body = await resp.json().catch(() => ({}));
  if (!resp.ok || body?.success === false) {
    throw new Error(body?.errors?.[0]?.message || `Cloudflare 更新记录失败 ${resp.status}`);
  }
}

function applyTemplate(input: string, vars: Record<string, string>) {
  let out = input;
  for (const [key, value] of Object.entries(vars)) {
    out = out.replaceAll(`{{${key}}}`, value);
  }
  return out;
}

async function updateWebhook(input: {
  url: string;
  method: "POST" | "PUT" | "GET";
  headers: string;
  domain: string;
  recordType: string;
  value: string;
  groupId: number;
}) {
  const vars = {
    domain: input.domain,
    type: input.recordType,
    value: input.value,
    groupId: String(input.groupId),
  };
  const url = applyTemplate(input.url, vars);
  const headers = parseHeaders(input.headers);
  const body = JSON.stringify({
    domain: input.domain,
    recordType: input.recordType,
    value: input.value,
    groupId: input.groupId,
  });
  const resp = await fetch(url, {
    method: input.method,
    headers: input.method === "GET" ? headers : { "Content-Type": "application/json", ...headers },
    body: input.method === "GET" ? undefined : body,
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(text || `Webhook 更新失败 ${resp.status}`);
  }
}

export async function updateDdnsRecord(input: {
  domain: string;
  recordType: string;
  value: string;
  groupId: number;
}) {
  const settings = await getDdnsSettings();
  if (!settings.enabled || settings.provider === "disabled") {
    throw new Error("DDNS 未启用");
  }
  if (!input.domain.trim()) throw new Error("转发组未配置域名");
  if (!input.value.trim()) throw new Error("没有可用入口地址");

  if (settings.provider === "cloudflare") {
    if (!settings.cloudflareZoneId || !settings.cloudflareApiToken) {
      throw new Error("Cloudflare DDNS 配置不完整");
    }
    await updateCloudflare({
      zoneId: settings.cloudflareZoneId,
      apiToken: settings.cloudflareApiToken,
      domain: input.domain.trim(),
      recordType: input.recordType || "A",
      value: input.value.trim(),
    });
    return;
  }

  if (settings.provider === "webhook") {
    if (!settings.webhookUrl) throw new Error("Webhook DDNS 地址未配置");
    await updateWebhook({
      url: settings.webhookUrl,
      method: settings.webhookMethod,
      headers: settings.webhookHeaders,
      domain: input.domain.trim(),
      recordType: input.recordType || "A",
      value: input.value.trim(),
      groupId: input.groupId,
    });
  }
}
