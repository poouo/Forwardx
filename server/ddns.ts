import crypto from "crypto";
import { domainToASCII } from "node:url";
import * as db from "./db";

export type DdnsProvider = "disabled" | "cloudflare" | "webhook" | "huaweicloud" | "aliyun" | "tencentcloud";

export interface DdnsSettings {
  provider: DdnsProvider;
  enabled: boolean;
  ttl: number;
  cloudflareZoneId: string;
  cloudflareApiToken: string;
  webhookUrl: string;
  webhookMethod: "POST" | "PUT" | "GET";
  webhookHeaders: string;
  huaweicloudAccessKeyId: string;
  huaweicloudSecretKey: string;
  huaweicloudRegion: string;
  huaweicloudEndpoint: string;
  huaweicloudZoneId: string;
  huaweicloudTtl: number;
  huaweicloudLine: string;
  aliyunAccessKeyId: string;
  aliyunAccessKeySecret: string;
  aliyunDomainName: string;
  aliyunEndpoint: string;
  aliyunTtl: number;
  aliyunLine: string;
  tencentcloudSecretId: string;
  tencentcloudSecretKey: string;
  tencentcloudDomainName: string;
  tencentcloudTtl: number;
  tencentcloudRecordLine: string;
  tencentcloudRecordLineId: string;
}

export type DdnsRecordInput = {
  domain: string;
  recordType: string;
  value: string;
  groupId: number;
  ttl?: number;
  lineId?: string;
  lineName?: string;
};

export type DdnsRecordValuesInput = Omit<DdnsRecordInput, "value"> & {
  values: string[];
};

export function maskSecret(value: string | null | undefined) {
  const v = String(value || "").trim();
  if (!v) return "";
  if (v.length <= 8) return `${v.slice(0, 2)}${"*".repeat(Math.max(4, v.length - 2))}`;
  return `${v.slice(0, 4)}${"*".repeat(Math.max(6, v.length - 8))}${v.slice(-4)}`;
}

function normalizeProvider(value: string): DdnsProvider {
  if (
    value === "cloudflare" ||
    value === "webhook" ||
    value === "huaweicloud" ||
    value === "aliyun" ||
    value === "tencentcloud"
  ) {
    return value;
  }
  return "disabled";
}

function parseTtl(value: unknown, fallback = 600) {
  const ttl = Math.floor(Number(value || fallback));
  if (!Number.isFinite(ttl)) return fallback;
  return Math.min(86400, Math.max(60, ttl));
}

export async function getDdnsSettings(): Promise<DdnsSettings> {
  const all = await db.getAllSettings();
  const method = String(all.ddnsWebhookMethod || "POST").toUpperCase();
  const ttl = parseTtl(
    all.ddnsTtl,
    parseTtl(all.ddnsHuaweiCloudTtl || all.ddnsAliyunTtl || all.ddnsTencentCloudTtl, 600),
  );
  return {
    provider: normalizeProvider(String(all.ddnsProvider || "disabled")),
    enabled: all.ddnsEnabled === "true",
    ttl,
    cloudflareZoneId: String(all.ddnsCloudflareZoneId || ""),
    cloudflareApiToken: String(all.ddnsCloudflareApiToken || ""),
    webhookUrl: String(all.ddnsWebhookUrl || ""),
    webhookMethod: method === "PUT" || method === "GET" ? method : "POST",
    webhookHeaders: String(all.ddnsWebhookHeaders || ""),
    huaweicloudAccessKeyId: String(all.ddnsHuaweiCloudAccessKeyId || ""),
    huaweicloudSecretKey: String(all.ddnsHuaweiCloudSecretKey || ""),
    huaweicloudRegion: String(all.ddnsHuaweiCloudRegion || "cn-north-4"),
    huaweicloudEndpoint: String(all.ddnsHuaweiCloudEndpoint || ""),
    huaweicloudZoneId: String(all.ddnsHuaweiCloudZoneId || ""),
    huaweicloudTtl: ttl,
    huaweicloudLine: String(all.ddnsHuaweiCloudLine || "default_view"),
    aliyunAccessKeyId: String(all.ddnsAliyunAccessKeyId || ""),
    aliyunAccessKeySecret: String(all.ddnsAliyunAccessKeySecret || ""),
    aliyunDomainName: String(all.ddnsAliyunDomainName || ""),
    aliyunEndpoint: String(all.ddnsAliyunEndpoint || "https://alidns.aliyuncs.com"),
    aliyunTtl: ttl,
    aliyunLine: String(all.ddnsAliyunLine || "default"),
    tencentcloudSecretId: String(all.ddnsTencentCloudSecretId || ""),
    tencentcloudSecretKey: String(all.ddnsTencentCloudSecretKey || ""),
    tencentcloudDomainName: String(all.ddnsTencentCloudDomainName || ""),
    tencentcloudTtl: ttl,
    tencentcloudRecordLine: String(all.ddnsTencentCloudRecordLine || "默认"),
    tencentcloudRecordLineId: String(all.ddnsTencentCloudRecordLineId || ""),
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

function normalizeDomain(value: string) {
  return String(value || "").trim().replace(/\.+$/, "").toLowerCase();
}

function normalizeDnsName(value: string) {
  const normalized = normalizeDomain(value);
  return domainToASCII(normalized) || normalized;
}

function cloudflareZoneCandidates(domain: string) {
  const labels = normalizeDnsName(domain).split(".").filter(Boolean);
  const candidates: string[] = [];
  for (let index = 0; index < labels.length - 1; index += 1) {
    const candidate = labels.slice(index).join(".");
    if (candidate && !candidates.includes(candidate)) candidates.push(candidate);
  }
  return candidates;
}

function fqdn(value: string) {
  const normalized = normalizeDomain(value);
  return normalized ? `${normalized}.` : "";
}

function splitDnsName(fullDomain: string, rootDomain: string, providerLabel: string) {
  const full = normalizeDomain(fullDomain);
  const root = normalizeDomain(rootDomain);
  if (!root) throw new Error(`${providerLabel} DDNS 主域名未配置`);
  if (full === root) return { root, rr: "@", subDomain: "@" };
  const suffix = `.${root}`;
  if (!full.endsWith(suffix)) {
    throw new Error(`${providerLabel} DDNS 域名 ${fullDomain} 不在主域名 ${rootDomain} 下`);
  }
  const rr = full.slice(0, -suffix.length);
  return { root, rr, subDomain: rr };
}

function normalizeEndpoint(value: string, fallback: string) {
  const raw = String(value || fallback || "").trim().replace(/\/+$/, "");
  if (!raw) return "";
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
}

function sha256Hex(value: string) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function hmac(key: crypto.BinaryLike | crypto.KeyObject, value: string, encoding?: crypto.BinaryToTextEncoding) {
  const digest = crypto.createHmac("sha256", key).update(value, "utf8").digest();
  return encoding ? digest.toString(encoding) : digest;
}

function encodeRfc3986(value: string) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
}

function canonicalQuery(params: Record<string, string | number | undefined>) {
  return Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== "")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${encodeRfc3986(key)}=${encodeRfc3986(String(value))}`)
    .join("&");
}

function extractJsonError(body: any, fallback: string) {
  return (
    body?.message ||
    body?.Message ||
    body?.error_msg ||
    body?.Error?.Message ||
    body?.Response?.Error?.Message ||
    body?.errors?.[0]?.message ||
    fallback
  );
}

async function readJson(resp: Response, fallback: string) {
  const text = await resp.text().catch(() => "");
  let body: any = {};
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { message: text };
    }
  }
  if (!resp.ok) {
    throw new Error(extractJsonError(body, `${fallback} ${resp.status}`));
  }
  return body;
}

async function resolveCloudflareZoneId(input: {
  zoneId?: string;
  apiToken: string;
  domain: string;
}) {
  const configuredZoneId = String(input.zoneId || "").trim();
  if (configuredZoneId) return configuredZoneId;

  const headers = {
    Authorization: `Bearer ${input.apiToken}`,
    "Content-Type": "application/json",
  };
  const candidates = cloudflareZoneCandidates(input.domain);
  for (const candidate of candidates) {
    const query = new URLSearchParams({ name: candidate, status: "active", per_page: "50" });
    const resp = await fetch(`https://api.cloudflare.com/client/v4/zones?${query.toString()}`, { headers });
    const body = await readJson(resp, "Cloudflare 查询 Zone 失败");
    if (body?.success === false) {
      throw new Error(extractJsonError(body, "Cloudflare 查询 Zone 失败"));
    }
    const zones = Array.isArray(body?.result) ? body.result : [];
    const zone = zones.find((item: any) => normalizeDnsName(String(item?.name || "")) === candidate) || zones[0];
    if (zone?.id) return String(zone.id);
  }

  throw new Error("Cloudflare 未找到匹配的 Zone；请确认 API Token 有 Zone:Read + DNS:Edit 权限，或手动填写 Zone ID");
}

async function updateCloudflare(input: {
  zoneId?: string;
  apiToken: string;
  domain: string;
  recordType: string;
  value: string;
  ttl?: number;
}) {
  const headers = {
    Authorization: `Bearer ${input.apiToken}`,
    "Content-Type": "application/json",
  };
  const zoneId = await resolveCloudflareZoneId(input);
  const base = `https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(zoneId)}/dns_records`;
  const recordName = normalizeDnsName(input.domain);
  const query = new URLSearchParams({ type: input.recordType, name: recordName, per_page: "50" });
  const findResp = await fetch(`${base}?${query.toString()}`, { headers });
  const findBody = await readJson(findResp, "Cloudflare 查询记录失败");
  if (findBody?.success === false) {
    throw new Error(extractJsonError(findBody, "Cloudflare 查询记录失败"));
  }
  const records = Array.isArray(findBody?.result) ? findBody.result : [];
  const record = records.find((item: any) => (
    normalizeDnsName(String(item?.name || "")) === recordName &&
    String(item?.type || "").toUpperCase() === input.recordType
  )) || records[0] || null;
  const payload: Record<string, unknown> = {
    type: input.recordType,
    name: recordName,
    content: input.value,
    ttl: parseTtl(input.ttl, 60),
    proxied: !!record?.proxied,
  };
  if (typeof record?.comment === "string" && record.comment) payload.comment = record.comment;
  const resp = await fetch(record?.id ? `${base}/${encodeURIComponent(String(record.id))}` : base, {
    method: record?.id ? "PUT" : "POST",
    headers,
    body: JSON.stringify(payload),
  });
  const body = await readJson(resp, "Cloudflare 更新记录失败");
  if (body?.success === false) {
    throw new Error(extractJsonError(body, "Cloudflare 更新记录失败"));
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
  ttl?: number;
  lineId?: string;
  lineName?: string;
}) {
  const ttl = parseTtl(input.ttl, 600);
  const vars = {
    domain: input.domain,
    type: input.recordType,
    value: input.value,
    groupId: String(input.groupId),
    ttl: String(ttl),
    lineId: input.lineId || "",
    lineName: input.lineName || "",
  };
  const url = applyTemplate(input.url, vars);
  const headers = parseHeaders(input.headers);
  const body = JSON.stringify({
    domain: input.domain,
    recordType: input.recordType,
    value: input.value,
    groupId: input.groupId,
    ttl,
    lineId: input.lineId || undefined,
    lineName: input.lineName || undefined,
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

function huaweicloudEndpoint(settings: DdnsSettings) {
  const region = settings.huaweicloudRegion.trim() || "cn-north-4";
  return normalizeEndpoint(settings.huaweicloudEndpoint, `https://dns.${region}.myhuaweicloud.com`);
}

function huaweicloudDate(date = new Date()) {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

async function huaweicloudRequest(settings: DdnsSettings, method: string, path: string, query: Record<string, string | number | undefined>, payload?: any) {
  const endpoint = huaweicloudEndpoint(settings);
  const host = new URL(endpoint).host;
  const body = payload === undefined ? "" : JSON.stringify(payload);
  const queryString = canonicalQuery(query);
  const sdkDate = huaweicloudDate();
  const signedHeaders = "content-type;host;x-sdk-date";
  const canonicalHeaders = `content-type:application/json\nhost:${host}\nx-sdk-date:${sdkDate}\n`;
  const canonicalRequest = [
    method.toUpperCase(),
    path,
    queryString,
    canonicalHeaders,
    signedHeaders,
    sha256Hex(body),
  ].join("\n");
  const stringToSign = ["SDK-HMAC-SHA256", sdkDate, sha256Hex(canonicalRequest)].join("\n");
  const signature = hmac(settings.huaweicloudSecretKey, stringToSign, "hex");
  const authorization = `SDK-HMAC-SHA256 Access=${settings.huaweicloudAccessKeyId}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const resp = await fetch(`${endpoint}${path}${queryString ? `?${queryString}` : ""}`, {
    method,
    headers: {
      Authorization: authorization,
      "Content-Type": "application/json",
      "X-Sdk-Date": sdkDate,
    },
    body: method.toUpperCase() === "GET" ? undefined : body,
  });
  return readJson(resp, "华为云 DNS 请求失败");
}

async function updateHuaweiCloud(settings: DdnsSettings, input: DdnsRecordInput) {
  if (!settings.huaweicloudAccessKeyId || !settings.huaweicloudSecretKey || !settings.huaweicloudZoneId) {
    throw new Error("华为云 DDNS 配置不完整");
  }
  const name = fqdn(input.domain);
  const recordType = (input.recordType || "A").toUpperCase();
  const line = (input.lineId || settings.huaweicloudLine || "default_view").trim();
  const ttl = parseTtl(input.ttl, settings.huaweicloudTtl);
  const zoneId = encodeURIComponent(settings.huaweicloudZoneId);
  const basePath = `/v2.1/zones/${zoneId}/recordsets`;
  const list = await huaweicloudRequest(settings, "GET", basePath, {
    name,
    type: recordType,
    line_id: line,
    limit: 100,
  });
  const recordsets = Array.isArray(list?.recordsets) ? list.recordsets : [];
  const record = recordsets.find((item: any) => (
    String(item?.name || "").toLowerCase() === name.toLowerCase() &&
    String(item?.type || "").toUpperCase() === recordType &&
    (!line || String(item?.line || "") === line)
  ));
  const payload = {
    name,
    type: recordType,
    ttl,
    records: [input.value],
  };
  if (record?.id) {
    await huaweicloudRequest(settings, "PUT", `${basePath}/${encodeURIComponent(String(record.id))}`, {}, payload);
    return;
  }
  await huaweicloudRequest(settings, "POST", basePath, {}, { ...payload, line });
}

function aliyunEncode(value: string) {
  return encodeURIComponent(value)
    .replace(/\+/g, "%20")
    .replace(/\*/g, "%2A")
    .replace(/%7E/g, "~")
    .replace(/[!'()]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
}

async function aliyunRequest(settings: DdnsSettings, action: string, params: Record<string, string | number | undefined>) {
  const endpoint = normalizeEndpoint(settings.aliyunEndpoint, "https://alidns.aliyuncs.com");
  const common: Record<string, string | number> = {
    Action: action,
    Version: "2015-01-09",
    Format: "JSON",
    AccessKeyId: settings.aliyunAccessKeyId,
    SignatureMethod: "HMAC-SHA1",
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    SignatureVersion: "1.0",
    SignatureNonce: crypto.randomUUID(),
  };
  const all: Record<string, string | number> = { ...common };
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") all[key] = value;
  }
  const canonical = Object.entries(all)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${aliyunEncode(key)}=${aliyunEncode(String(value))}`)
    .join("&");
  const stringToSign = `GET&${aliyunEncode("/")}&${aliyunEncode(canonical)}`;
  const signature = crypto
    .createHmac("sha1", `${settings.aliyunAccessKeySecret}&`)
    .update(stringToSign, "utf8")
    .digest("base64");
  const resp = await fetch(`${endpoint}/?Signature=${aliyunEncode(signature)}&${canonical}`);
  const body = await readJson(resp, "阿里云 DNS 请求失败");
  if (body?.Code) throw new Error(body?.Message || `阿里云 DNS 请求失败: ${body.Code}`);
  return body;
}

async function updateAliyun(settings: DdnsSettings, input: DdnsRecordInput) {
  if (!settings.aliyunAccessKeyId || !settings.aliyunAccessKeySecret || !settings.aliyunDomainName) {
    throw new Error("阿里云 DDNS 配置不完整");
  }
  const { root, rr } = splitDnsName(input.domain, settings.aliyunDomainName, "阿里云");
  const domain = normalizeDomain(input.domain);
  const recordType = (input.recordType || "A").toUpperCase();
  const line = (input.lineId || settings.aliyunLine || "default").trim();
  const ttl = parseTtl(input.ttl, settings.aliyunTtl);
  const list = await aliyunRequest(settings, "DescribeSubDomainRecords", {
    DomainName: root,
    SubDomain: domain,
    Type: recordType,
    Line: line,
    PageNumber: 1,
    PageSize: 100,
  });
  const records = list?.DomainRecords?.Record;
  const candidates = Array.isArray(records) ? records : records ? [records] : [];
  const record = candidates.find((item: any) => (
    String(item?.RR || "") === rr &&
    String(item?.Type || "").toUpperCase() === recordType &&
    (!line || String(item?.Line || "") === line)
  ));
  const payload = {
    RR: rr,
    Type: recordType,
    Value: input.value,
    Line: line,
    TTL: ttl,
  };
  if (record?.RecordId) {
    await aliyunRequest(settings, "UpdateDomainRecord", { RecordId: String(record.RecordId), ...payload });
    return;
  }
  await aliyunRequest(settings, "AddDomainRecord", { DomainName: root, ...payload });
}

function tencentDate(timestamp: number) {
  return new Date(timestamp * 1000).toISOString().slice(0, 10);
}

async function tencentCloudRequest(settings: DdnsSettings, action: string, payload: Record<string, any>) {
  const host = "dnspod.tencentcloudapi.com";
  const service = "dnspod";
  const version = "2021-03-23";
  const algorithm = "TC3-HMAC-SHA256";
  const timestamp = Math.floor(Date.now() / 1000);
  const body = JSON.stringify(payload);
  const hashedRequestPayload = sha256Hex(body);
  const canonicalHeaders = `content-type:application/json; charset=utf-8\nhost:${host}\n`;
  const signedHeaders = "content-type;host";
  const canonicalRequest = [
    "POST",
    "/",
    "",
    canonicalHeaders,
    signedHeaders,
    hashedRequestPayload,
  ].join("\n");
  const date = tencentDate(timestamp);
  const credentialScope = `${date}/${service}/tc3_request`;
  const stringToSign = [
    algorithm,
    String(timestamp),
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");
  const secretDate = hmac(`TC3${settings.tencentcloudSecretKey}`, date);
  const secretService = hmac(secretDate, service);
  const secretSigning = hmac(secretService, "tc3_request");
  const signature = hmac(secretSigning, stringToSign, "hex");
  const authorization = `${algorithm} Credential=${settings.tencentcloudSecretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const resp = await fetch(`https://${host}`, {
    method: "POST",
    headers: {
      Authorization: authorization,
      "Content-Type": "application/json; charset=utf-8",
      "X-TC-Action": action,
      "X-TC-Timestamp": String(timestamp),
      "X-TC-Version": version,
      "X-TC-Language": "zh-CN",
    },
    body,
  });
  const result = await readJson(resp, "腾讯云 DNSPod 请求失败");
  if (result?.Response?.Error) {
    const error = result.Response.Error;
    throw new Error(error.Message || `腾讯云 DNSPod 请求失败: ${error.Code}`);
  }
  return result?.Response || {};
}

async function updateTencentCloud(settings: DdnsSettings, input: DdnsRecordInput) {
  if (!settings.tencentcloudSecretId || !settings.tencentcloudSecretKey || !settings.tencentcloudDomainName) {
    throw new Error("腾讯云 DNSPod DDNS 配置不完整");
  }
  const { root, subDomain } = splitDnsName(input.domain, settings.tencentcloudDomainName, "腾讯云 DNSPod");
  const recordType = (input.recordType || "A").toUpperCase();
  const recordLine = (input.lineName || settings.tencentcloudRecordLine || "默认").trim();
  const recordLineId = (input.lineId || settings.tencentcloudRecordLineId || "").trim();
  const ttl = parseTtl(input.ttl, settings.tencentcloudTtl);
  const listPayload: Record<string, any> = {
    Domain: root,
    Subdomain: subDomain,
    RecordType: recordType,
    RecordLine: recordLine,
    Limit: 3000,
    ErrorOnEmpty: "no",
  };
  if (recordLineId) listPayload.RecordLineId = recordLineId;
  const list = await tencentCloudRequest(settings, "DescribeRecordList", listPayload);
  const records = Array.isArray(list?.RecordList) ? list.RecordList : [];
  const record = records.find((item: any) => (
    String(item?.Name || "") === subDomain &&
    String(item?.Type || "").toUpperCase() === recordType &&
    (recordLineId ? String(item?.LineId || "") === recordLineId : String(item?.Line || "") === recordLine)
  ));
  const payload: Record<string, any> = {
    Domain: root,
    SubDomain: subDomain,
    RecordType: recordType,
    RecordLine: recordLine,
    Value: input.value,
    TTL: ttl,
  };
  if (recordLineId) payload.RecordLineId = recordLineId;
  if (record?.RecordId) {
    await tencentCloudRequest(settings, "ModifyRecord", { ...payload, RecordId: Number(record.RecordId) });
    return;
  }
  await tencentCloudRequest(settings, "CreateRecord", payload);
}

function uniqueDdnsValues(values: string[]) {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const text = String(value || "").trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

async function updateCloudflareValues(input: {
  zoneId?: string;
  apiToken: string;
  domain: string;
  recordType: string;
  values: string[];
  ttl?: number;
}) {
  const headers = {
    Authorization: "Bearer " + input.apiToken,
    "Content-Type": "application/json",
  };
  const zoneId = await resolveCloudflareZoneId(input);
  const base = "https://api.cloudflare.com/client/v4/zones/" + encodeURIComponent(zoneId) + "/dns_records";
  const recordName = normalizeDnsName(input.domain);
  const recordType = input.recordType.toUpperCase();
  const query = new URLSearchParams({ type: recordType, name: recordName, per_page: "100" });
  const findResp = await fetch(base + "?" + query.toString(), { headers });
  const findBody = await readJson(findResp, "Cloudflare 查询记录失败");
  if (findBody?.success === false) throw new Error(extractJsonError(findBody, "Cloudflare 查询记录失败"));

  const records = (Array.isArray(findBody?.result) ? findBody.result : []).filter((item: any) => (
    normalizeDnsName(String(item?.name || "")) === recordName &&
    String(item?.type || "").toUpperCase() === recordType
  ));
  const desired = uniqueDdnsValues(input.values);
  const template = records[0] || null;

  for (const record of records) {
    const id = String(record?.id || "");
    if (!id) continue;
    const resp = await fetch(base + "/" + encodeURIComponent(id), { method: "DELETE", headers });
    const body = await readJson(resp, "Cloudflare 删除记录失败");
    if (body?.success === false) throw new Error(extractJsonError(body, "Cloudflare 删除记录失败"));
  }

  for (const value of desired) {
    const payload: Record<string, unknown> = {
      type: recordType,
      name: recordName,
      content: value,
      ttl: parseTtl(input.ttl, 60),
      proxied: !!template?.proxied,
    };
    const resp = await fetch(base, { method: "POST", headers, body: JSON.stringify(payload) });
    const body = await readJson(resp, "Cloudflare 创建记录失败");
    if (body?.success === false) throw new Error(extractJsonError(body, "Cloudflare 创建记录失败"));
  }
}

async function updateWebhookValues(settings: DdnsSettings, input: DdnsRecordValuesInput, values: string[]) {
  if (!settings.webhookUrl) throw new Error("Webhook DDNS 地址未配置");
  const value = values.join(",");
  const ttl = parseTtl(input.ttl, settings.ttl);
  const vars = {
    domain: input.domain,
    type: input.recordType,
    value,
    values: value,
    groupId: String(input.groupId),
    ttl: String(ttl),
    lineId: input.lineId || "",
    lineName: input.lineName || "",
  };
  const url = applyTemplate(settings.webhookUrl, vars);
  const headers = parseHeaders(settings.webhookHeaders);
  const body = JSON.stringify({
    domain: input.domain,
    recordType: input.recordType,
    value,
    values,
    groupId: input.groupId,
    ttl,
    lineId: input.lineId || undefined,
    lineName: input.lineName || undefined,
  });
  const resp = await fetch(url, {
    method: settings.webhookMethod,
    headers: settings.webhookMethod === "GET" ? headers : { "Content-Type": "application/json", ...headers },
    body: settings.webhookMethod === "GET" ? undefined : body,
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(text || `Webhook 更新失败 ${resp.status}`);
  }
}

async function updateHuaweiCloudValues(settings: DdnsSettings, input: DdnsRecordValuesInput, values: string[]) {
  if (!settings.huaweicloudAccessKeyId || !settings.huaweicloudSecretKey || !settings.huaweicloudZoneId) {
    throw new Error("华为云 DDNS 配置不完整");
  }
  const name = fqdn(input.domain);
  const recordType = (input.recordType || "A").toUpperCase();
  const line = (input.lineId || settings.huaweicloudLine || "default_view").trim();
  const ttl = parseTtl(input.ttl, settings.huaweicloudTtl);
  const zoneId = encodeURIComponent(settings.huaweicloudZoneId);
  const basePath = "/v2.1/zones/" + zoneId + "/recordsets";
  const list = await huaweicloudRequest(settings, "GET", basePath, { name, type: recordType, line_id: line, limit: 100 });
  const recordsets = Array.isArray(list?.recordsets) ? list.recordsets : [];
  const record = recordsets.find((item: any) => (
    String(item?.name || "").toLowerCase() === name.toLowerCase() &&
    String(item?.type || "").toUpperCase() === recordType &&
    (!line || String(item?.line || "") === line)
  ));
  const payload = { name, type: recordType, ttl, records: values };
  if (record?.id) {
    await huaweicloudRequest(settings, "PUT", basePath + "/" + encodeURIComponent(String(record.id)), {}, payload);
    return;
  }
  await huaweicloudRequest(settings, "POST", basePath, {}, { ...payload, line });
}

async function updateAliyunValues(settings: DdnsSettings, input: DdnsRecordValuesInput, values: string[]) {
  if (!settings.aliyunAccessKeyId || !settings.aliyunAccessKeySecret || !settings.aliyunDomainName) {
    throw new Error("阿里云 DDNS 配置不完整");
  }
  const { root, rr } = splitDnsName(input.domain, settings.aliyunDomainName, "阿里云");
  const domain = normalizeDomain(input.domain);
  const recordType = (input.recordType || "A").toUpperCase();
  const line = (input.lineId || settings.aliyunLine || "default").trim();
  const ttl = parseTtl(input.ttl, settings.aliyunTtl);
  const list = await aliyunRequest(settings, "DescribeSubDomainRecords", {
    DomainName: root,
    SubDomain: domain,
    Type: recordType,
    Line: line,
    PageNumber: 1,
    PageSize: 100,
  });
  const records = list?.DomainRecords?.Record;
  const candidates = (Array.isArray(records) ? records : records ? [records] : []).filter((item: any) => (
    String(item?.RR || "") === rr &&
    String(item?.Type || "").toUpperCase() === recordType &&
    (!line || String(item?.Line || "") === line)
  ));
  for (const record of candidates) {
    const id = String(record?.RecordId || "");
    if (id) await aliyunRequest(settings, "DeleteDomainRecord", { RecordId: id });
  }
  for (const value of values) {
    await aliyunRequest(settings, "AddDomainRecord", { DomainName: root, RR: rr, Type: recordType, Value: value, Line: line, TTL: ttl });
  }
}

async function updateTencentCloudValues(settings: DdnsSettings, input: DdnsRecordValuesInput, values: string[]) {
  if (!settings.tencentcloudSecretId || !settings.tencentcloudSecretKey || !settings.tencentcloudDomainName) {
    throw new Error("腾讯云 DNSPod DDNS 配置不完整");
  }
  const { root, subDomain } = splitDnsName(input.domain, settings.tencentcloudDomainName, "腾讯云 DNSPod");
  const recordType = (input.recordType || "A").toUpperCase();
  const recordLine = (input.lineName || settings.tencentcloudRecordLine || "默认").trim();
  const recordLineId = (input.lineId || settings.tencentcloudRecordLineId || "").trim();
  const ttl = parseTtl(input.ttl, settings.tencentcloudTtl);
  const listPayload: Record<string, any> = {
    Domain: root,
    Subdomain: subDomain,
    RecordType: recordType,
    RecordLine: recordLine,
    Limit: 3000,
    ErrorOnEmpty: "no",
  };
  if (recordLineId) listPayload.RecordLineId = recordLineId;
  const list = await tencentCloudRequest(settings, "DescribeRecordList", listPayload);
  const candidates = (Array.isArray(list?.RecordList) ? list.RecordList : []).filter((item: any) => (
    String(item?.Name || "") === subDomain &&
    String(item?.Type || "").toUpperCase() === recordType &&
    (recordLineId ? String(item?.LineId || "") === recordLineId : String(item?.Line || "") === recordLine)
  ));
  for (const record of candidates) {
    const id = String(record?.RecordId || "");
    if (id) await tencentCloudRequest(settings, "DeleteRecord", { Domain: root, RecordId: Number(id) });
  }
  for (const value of values) {
    const payload: Record<string, any> = {
      Domain: root,
      SubDomain: subDomain,
      RecordType: recordType,
      RecordLine: recordLine,
      Value: value,
      TTL: ttl,
    };
    if (recordLineId) payload.RecordLineId = recordLineId;
    await tencentCloudRequest(settings, "CreateRecord", payload);
  }
}

export async function updateDdnsRecordValues(input: DdnsRecordValuesInput) {
  const settings = await getDdnsSettings();
  if (!settings.enabled || settings.provider === "disabled") {
    throw new Error("DDNS 未启用");
  }
  const normalizedInput = {
    ...input,
    domain: input.domain.trim(),
    recordType: (input.recordType || "A").trim().toUpperCase(),
    lineId: input.lineId?.trim() || undefined,
    lineName: input.lineName?.trim() || undefined,
  };
  if (!normalizedInput.domain) throw new Error("入口组未配置 DDNS 域名");
  const values = uniqueDdnsValues(input.values);
  if (values.length === 0) throw new Error("没有可用入口地址");
  if (normalizedInput.recordType === "CNAME" && values.length > 1) throw new Error("CNAME 记录只能指向一个值");

  if (settings.provider === "cloudflare") {
    if (!settings.cloudflareApiToken) throw new Error("Cloudflare DDNS 未配置 API Token");
    await updateCloudflareValues({
      zoneId: settings.cloudflareZoneId,
      apiToken: settings.cloudflareApiToken,
      domain: normalizedInput.domain,
      recordType: normalizedInput.recordType,
      values,
      ttl: normalizedInput.ttl ?? settings.ttl,
    });
    return;
  }

  if (settings.provider === "webhook") {
    await updateWebhookValues(settings, { ...normalizedInput, ttl: normalizedInput.ttl ?? settings.ttl }, values);
    return;
  }

  if (settings.provider === "huaweicloud") {
    await updateHuaweiCloudValues(settings, normalizedInput, values);
    return;
  }

  if (settings.provider === "aliyun") {
    await updateAliyunValues(settings, normalizedInput, values);
    return;
  }

  if (settings.provider === "tencentcloud") {
    await updateTencentCloudValues(settings, normalizedInput, values);
  }
}
export async function updateDdnsRecord(input: DdnsRecordInput) {
  const settings = await getDdnsSettings();
  if (!settings.enabled || settings.provider === "disabled") {
    throw new Error("DDNS 未启用");
  }
  if (!input.domain.trim()) throw new Error("转发组未配置域名");
  if (!input.value.trim()) throw new Error("没有可用入口地址");

  const normalizedInput = {
    ...input,
    domain: input.domain.trim(),
    recordType: (input.recordType || "A").trim().toUpperCase(),
    value: input.value.trim(),
    lineId: input.lineId?.trim() || undefined,
    lineName: input.lineName?.trim() || undefined,
  };

  if (settings.provider === "cloudflare") {
    if (!settings.cloudflareApiToken) {
      throw new Error("Cloudflare DDNS 未配置 API Token");
    }
    await updateCloudflare({
      zoneId: settings.cloudflareZoneId,
      apiToken: settings.cloudflareApiToken,
      domain: normalizedInput.domain,
      recordType: normalizedInput.recordType,
      value: normalizedInput.value,
      ttl: normalizedInput.ttl ?? settings.ttl,
    });
    return;
  }

  if (settings.provider === "webhook") {
    if (!settings.webhookUrl) throw new Error("Webhook DDNS 地址未配置");
    await updateWebhook({
      url: settings.webhookUrl,
      method: settings.webhookMethod,
      headers: settings.webhookHeaders,
      domain: normalizedInput.domain,
      recordType: normalizedInput.recordType,
      value: normalizedInput.value,
      groupId: normalizedInput.groupId,
      ttl: normalizedInput.ttl ?? settings.ttl,
      lineId: normalizedInput.lineId,
      lineName: normalizedInput.lineName,
    });
    return;
  }

  if (settings.provider === "huaweicloud") {
    await updateHuaweiCloud(settings, normalizedInput);
    return;
  }

  if (settings.provider === "aliyun") {
    await updateAliyun(settings, normalizedInput);
    return;
  }

  if (settings.provider === "tencentcloud") {
    await updateTencentCloud(settings, normalizedInput);
  }
}
