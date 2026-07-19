import { protectedProcedure, adminProcedure, publicProcedure, router } from "../_core/trpc";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { nanoid } from "nanoid";
import * as db from "../db";
import { appendPanelLog } from "../_core/panelLogger";
import { markHostMetricsWatching, pushAgentRefresh, pushAgentUpgrade } from "../agentEvents";
import { AGENT_ASSET_NAMES, getMissingBundledAgentAssets } from "../agentAssets";
import { pushTunnelEndpointRefresh, requireHostAccess } from "./helpers";
import { AGENT_VERSION, APP_VERSION, REPO_URL } from "../_core/systemRouter";
import { isAgentUpgradeTargetSatisfied, isAgentVersionAtLeast } from "../agentRouteUtils";
import { scheduleHostGeoRefresh } from "../hostGeo";
import { refreshHostAddressRuntime } from "../hostAddressRuntime";
import { scheduleHostDdnsUpdate } from "../hostDdns";
import { clearTunnelRuntimeStatusForHost } from "../tunnelRuntimeStatus";
import { createQueryCache } from "../queryCache";
import { describePortPolicy, normalizePortAllowlist, portPolicyFrom, portPolicyHasRestriction } from "../portPolicy";
import { ENV } from "../env";
import { isValidHostOrIp as isValidNetworkHostOrIp } from "../networkAddress";

const HOST_UPGRADE_CLEANUP_INTERVAL_MS = 60 * 1000;
const GITHUB_API_LIMIT_STATUSES = new Set([403, 429]);
const hostQueryCache = createQueryCache(500);

let lastHostUpgradeCleanupAt = 0;
let hostUpgradeCleanupRunning = false;
const ORPHANED_AGENT_HOST_CLEANUP_INTERVAL_MS = 60 * 1000;
let lastOrphanedAgentHostCleanupAt = 0;
let orphanedAgentHostCleanupRunning = false;
const hostProtocolPolicyFields = ["blockHttp", "blockSocks", "blockTls"] as const;

async function refreshHostPolicyRuntime(hostId: number, reason: string) {
  const id = Number(hostId);
  if (!Number.isFinite(id) || id <= 0) return;
  const host = await db.getHostById(id).catch(() => null);
  await db.resetAgentRuntimeStateForHost(id);
  clearTunnelRuntimeStatusForHost(id);
  const tunnels = await db.getTunnelsByHost(id);
  appendPanelLog("info", `[Host] refresh runtime host=${id} name=${String(host?.name || `主机 #${id}`)} reason=${reason} tunnelCount=${tunnels.length}`);
  for (const tunnel of tunnels as any[]) {
    await pushTunnelEndpointRefresh(tunnel, reason);
  }
  pushAgentRefresh(id, reason);
}

const isValidHostOrIp = (value: unknown) => isValidNetworkHostOrIp(value, { allowUnderscore: true, allowLooseIpLiteral: true });

const hostAddressSchema = z.string().trim().min(1).max(253).refine(isValidHostOrIp, "Invalid host or IP");
const optionalHostAddressSchema = z.string().trim().max(253).nullable().optional().refine(
  (value) => !value || isValidHostOrIp(value),
  "Invalid host or IP",
);
const networkInterfaceSchema = z.string().trim().max(32).nullable().optional().refine(
  (value) => !value || /^[a-zA-Z0-9_.:@-]+$/.test(value),
  "Invalid network interface",
);
const hostSortOrderSchema = z.number().int().min(0).max(200).optional();

const optionalDateInputSchema = z.string().trim().max(64).nullable().optional();
const hostTrafficMeasureModeSchema = z.enum(["outbound", "both", "max"]).default("both");
const hostDdnsIpVersionSchema = z.enum(["ipv4", "ipv6"]);
const hostDdnsRecordTypeSchema = z.enum(["A", "AAAA"]);
const hostDdnsDomainSchema = z.string().trim().max(253).nullable().optional();
const pageRequestSchema = z.object({
  page: z.number().int().positive().default(1),
  pageSize: z.number().int().min(1).max(100).default(12),
});
const hostProbeTargetSchema = z.string().trim().min(1).max(253).refine(isValidHostOrIp, "Invalid target IP or host");
const hostProbeIdsSchema = z.array(z.number().int().positive()).max(500).optional();
const hostProbeServiceInputSchema = z.object({
  name: z.string().trim().min(1).max(128),
  method: z.enum(["tcping", "ping"]),
  targetIp: hostProbeTargetSchema,
  targetPort: z.number().int().min(1).max(65535).nullable().optional(),
  hostScope: z.enum(["all", "exclude", "specific"]).default("all"),
  hostIds: hostProbeIdsSchema,
  excludeHostIds: hostProbeIdsSchema,
  intervalSeconds: z.number().int().min(5).max(86400).default(30),
  isEnabled: z.boolean().optional(),
});
const hostGroupInputSchema = z.object({
  name: z.string().trim().min(1).max(128),
  hostIds: z.array(z.number().int().positive()).max(500).optional(),
  isEnabled: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(200).optional(),
});
const reorderIdsSchema = z.array(z.number().int().positive()).min(1).max(2000);

function normalizeHostProbeServiceInput(input: z.infer<typeof hostProbeServiceInputSchema>) {
  if (input.method === "tcping" && !input.targetPort) throw new Error("TCPing 服务需要填写目标端口");
  const hostIds = Array.from(new Set((input.hostIds || []).map(Number).filter((id) => Number.isInteger(id) && id > 0)));
  const excludeHostIds = Array.from(new Set((input.excludeHostIds || []).map(Number).filter((id) => Number.isInteger(id) && id > 0)));
  if (input.hostScope === "specific" && hostIds.length === 0) throw new Error("请选择需要运行服务的主机");
  return {
    ...input,
    targetPort: input.method === "tcping" ? Number(input.targetPort) : null,
    hostIds: input.hostScope === "specific" ? hostIds : [],
    excludeHostIds: input.hostScope === "exclude" ? excludeHostIds : [],
    intervalSeconds: Math.max(5, Number(input.intervalSeconds) || 30),
    isEnabled: input.isEnabled !== false,
  };
}

function normalizeHostGroupInput(input: z.infer<typeof hostGroupInputSchema>) {
  return {
    name: input.name.trim(),
    hostIds: Array.from(new Set((input.hostIds || []).map(Number).filter((id) => Number.isInteger(id) && id > 0))),
    isEnabled: input.isEnabled !== false,
    sortOrder: input.sortOrder === undefined ? undefined : Math.max(0, Math.floor(Number(input.sortOrder) || 0)),
  };
}

async function assertHostGroupHostIdsExist(hostIds: number[]) {
  if (hostIds.length === 0) return;
  const allHosts = await db.getHosts();
  const existingIds = new Set((allHosts as any[]).map((host) => Number(host.id)));
  const missing = hostIds.filter((hostId) => !existingIds.has(hostId));
  if (missing.length > 0) throw new Error(`主机不存在：${missing.join(", ")}`);
}

function parseOptionalDateInput(value: string | null | undefined, label: string) {
  const text = String(value || "").trim();
  if (!text) return null;
  const date = new Date(text);
  if (!Number.isFinite(date.getTime())) throw new Error(`${label}格式不正确`);
  return date;
}

function normalizeExistingOptionalDate(value: unknown) {
  if (!value) return null;
  if (value instanceof Date) {
    return value.getTime() > 0 ? value : null;
  }
  const date = new Date(String(value));
  return Number.isFinite(date.getTime()) && date.getTime() > 0 ? date : null;
}

function assertHostTrafficDates(purchasedAt: Date | null, stoppedAt: Date | null) {
  if (purchasedAt && stoppedAt && stoppedAt.getTime() <= purchasedAt.getTime()) {
    throw new Error("机器停止时间必须晚于购买时间");
  }
}

function normalizeHostTrafficMeasureMode(value: unknown) {
  if (value === "outbound" || value === "max") return value;
  return "both";
}

function normalizeTrafficAlertThresholdPercent(value: unknown) {
  return Math.min(99, Math.max(1, Math.floor(Number(value) || 20)));
}

function normalizeRenewalReminderDays(value: unknown) {
  return Math.min(365, Math.max(1, Math.floor(Number(value) || 7)));
}

function normalizeHostDdnsIpVersion(value: unknown, recordType?: string) {
  if (value === "ipv6" || (!value && String(recordType || "").toUpperCase() === "AAAA")) return "ipv6";
  return "ipv4";
}

function normalizeHostDdnsRecordType(ipVersion: unknown) {
  return ipVersion === "ipv6" ? "AAAA" : "A";
}

function normalizeHostDdnsPayload(input: {
  ddnsEnabled?: boolean;
  ddnsDomain?: string | null;
  ddnsRecordType?: "A" | "AAAA";
  ddnsIpVersion?: "ipv4" | "ipv6";
}) {
  const ipVersion = normalizeHostDdnsIpVersion(input.ddnsIpVersion, input.ddnsRecordType);
  const recordType = normalizeHostDdnsRecordType(ipVersion);
  const domain = String(input.ddnsDomain || "").trim().replace(/\.+$/, "").toLowerCase();
  if (input.ddnsEnabled && !domain) throw new Error("开启 DDNS 服务需要填写域名");
  return {
    ddnsEnabled: !!input.ddnsEnabled,
    ddnsDomain: domain || null,
    ddnsRecordType: recordType,
    ddnsIpVersion: ipVersion,
  };
}

async function assertHostDdnsServiceConfigured() {
  const settings = await db.getAllSettings();
  const provider = String(settings.ddnsProvider || "disabled");
  if (settings.ddnsEnabled !== "true" || provider === "disabled") {
    throw new Error("请先在系统设置内启用 DDNS 服务商");
  }
}

async function assertTelegramBotConfiguredForHostReminder() {
  const settings = await db.getAllSettings();
  const envToken = ENV.telegramBotToken.trim();
  const botEnabled = settings.telegramBotEnabled === "true" || (!!envToken && settings.telegramBotEnabled !== "false");
  const botConfigured = !!String(settings.telegramBotToken || envToken).trim();
  if (!botEnabled || !botConfigured) {
    throw new Error("请先在系统设置内配置并启用 Telegram 机器人");
  }
}

function hostTrafficConfigPayload(input: {
  purchasedAt?: string | null;
  stoppedAt?: string | null;
  trafficLimit?: number;
  trafficMeasureMode?: "outbound" | "both" | "max";
  telegramTrafficAlertEnabled?: boolean;
  trafficAlertThresholdPercent?: number;
  telegramRenewalReminderEnabled?: boolean;
  renewalReminderDays?: number;
  trafficAutoReset?: boolean;
  trafficResetDay?: number;
}) {
  const purchasedAt = parseOptionalDateInput(input.purchasedAt, "机器购买时间");
  const stoppedAt = parseOptionalDateInput(input.stoppedAt, "机器停止时间");
  assertHostTrafficDates(purchasedAt, stoppedAt);
  return {
    purchasedAt,
    stoppedAt,
    trafficLimit: Math.max(0, Math.floor(Number(input.trafficLimit || 0))),
    trafficMeasureMode: normalizeHostTrafficMeasureMode(input.trafficMeasureMode),
    telegramTrafficAlertEnabled: !!input.telegramTrafficAlertEnabled,
    trafficAlertThresholdPercent: normalizeTrafficAlertThresholdPercent(input.trafficAlertThresholdPercent),
    telegramRenewalReminderEnabled: !!input.telegramRenewalReminderEnabled,
    renewalReminderDays: normalizeRenewalReminderDays(input.renewalReminderDays),
    trafficAutoReset: !!input.trafficAutoReset,
    trafficResetDay: input.trafficResetDay ?? 1,
  };
}
function normalizeVersion(version: string | null | undefined) {
  return String(version || "").trim().replace(/^v/i, "");
}

function githubRepoParts(repoUrl: string) {
  const match = repoUrl.match(/github\.com\/([^/]+)\/([^/#?]+)/i);
  if (!match) throw new Error("GitHub 仓库地址格式不正确");
  return { owner: match[1], repo: match[2].replace(/\.git$/i, "") };
}

async function releaseAssetExistsViaDownloadUrl(tag: string, assetName: string) {
  const { owner, repo } = githubRepoParts(REPO_URL);
  const url = `https://github.com/${owner}/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(assetName)}`;
  const headers = {
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
    "User-Agent": `ForwardX/${APP_VERSION}`,
  };
  let res = await fetch(`${url}?_=${Date.now()}`, {
    cache: "no-store",
    method: "HEAD",
    redirect: "follow",
    headers,
  });
  if (res.status === 405) {
    res = await fetch(`${url}?_=${Date.now()}`, {
      cache: "no-store",
      method: "GET",
      redirect: "follow",
      headers: {
        ...headers,
        Range: "bytes=0-0",
      },
    });
  }
  return res.ok;
}

async function assertAgentReleaseAssetsReady(agentVersion: string, releaseVersion = APP_VERSION) {
  const normalizedAgentVersion = normalizeVersion(agentVersion);
  const missingBundledAssets = getMissingBundledAgentAssets(releaseVersion);
  if (missingBundledAssets.length === 0) return;

  const tag = `v${normalizeVersion(releaseVersion)}`;
  const { owner, repo } = githubRepoParts(REPO_URL);
  const url = `https://api.github.com/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(tag)}`;
  const res = await fetch(`${url}?_=${Date.now()}`, {
    cache: "no-store",
    headers: {
      Accept: "application/vnd.github+json",
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
      "User-Agent": `ForwardX/${APP_VERSION}`,
    },
  });
  if (res.status === 404) {
    throw new Error(`Agent v${normalizedAgentVersion} 所需的 Release ${tag} 尚未生成，可能仍在构建中，请稍后再试`);
  }
  if (!res.ok) {
    if (GITHUB_API_LIMIT_STATUSES.has(res.status)) {
      const missingByUrl: string[] = [];
      for (const name of missingBundledAssets) {
        if (!await releaseAssetExistsViaDownloadUrl(tag, name)) missingByUrl.push(name);
      }
      if (missingByUrl.length === 0) return;
      throw new Error(`GitHub API 已限流，且无法通过下载直链确认 Release ${tag} 的 Agent 资产，请稍后再试：${missingByUrl.join(", ")}`);
    }
    throw new Error(`无法验证 Release ${tag} 的 Agent 资产：${res.status} ${res.statusText}`);
  }
  const release = await res.json() as { assets?: Array<{ name?: string; state?: string; size?: number }> };
  const assets = new Map((release.assets || []).map((asset) => [asset.name || "", asset]));
  const missing = missingBundledAssets.filter((name) => {
    const asset = assets.get(name);
    return !asset || asset.state !== "uploaded" || Number(asset.size || 0) <= 0;
  });
  if (missing.length > 0) {
    throw new Error(`Agent v${normalizedAgentVersion} 所需的 Release ${tag} 资产还未构建完成，请稍后再试：${missing.join(", ")}`);
  }
}

async function clearCompletedHostAgentUpgradeRequests<T extends any[]>(hostRows: T): Promise<T> {
  const completedIds: number[] = [];
  const cleanedRows = hostRows.map((host: any) => {
    const targetVersion = host.agentUpgradeTargetVersion || AGENT_VERSION;
    if (host.agentUpgradeRequested && host.agentVersion && isAgentUpgradeTargetSatisfied(host.agentVersion, targetVersion, AGENT_VERSION)) {
      completedIds.push(Number(host.id));
      return {
        ...host,
        agentUpgradeRequested: false,
        agentUpgradeTargetVersion: null,
        agentUpgradeReleaseVersion: null,
      };
    }
    return host;
  }) as T;
  await Promise.all(completedIds.map((id) => db.clearHostAgentUpgradeRequest(id)));
  return cleanedRows;
}

async function getHostsWithUpgradeStateCleanup(userId?: number) {
  return clearCompletedHostAgentUpgradeRequests(await db.getHosts(userId));
}

async function visibleHostQueryScope(user: { id: number; role: string }) {
  if (user.role === "admin") return {} as { ownerUserId?: number; allowedHostIds?: number[] };
  const [allowedHostIds, billingResourceIds] = await Promise.all([
    db.getUserEffectiveAllowedHostIds(user.id),
    db.getUserUsableTrafficBillingResourceIds(user.id),
  ]);
  return {
    ownerUserId: user.id,
    allowedHostIds: Array.from(new Set([...allowedHostIds, ...billingResourceIds.hostIds])),
  };
}

async function getVisibleHostsForUser(user: { id: number; role: string }, options: { scheduleGeoRefresh?: boolean } = {}) {
  const shouldScheduleGeoRefresh = options.scheduleGeoRefresh !== false;
  const isAdmin = user.role === "admin";
  if (isAdmin) {
    const hosts = await getHostsWithUpgradeStateCleanup();
    if (shouldScheduleGeoRefresh) scheduleHostGeoRefresh(hosts);
    return hosts;
  }
  // 普通用户可见自己创建、获授权及按量计费授权的主机。
  const [allowedHostIds, billingResourceIds] = await Promise.all([
    db.getUserEffectiveAllowedHostIds(user.id),
    db.getUserUsableTrafficBillingResourceIds(user.id),
  ]);
  const allHosts = await getHostsWithUpgradeStateCleanup();
  const allowedSet = new Set([...allowedHostIds, ...billingResourceIds.hostIds]);
  const visibleHosts = allHosts.filter((h: any) => allowedSet.has(h.id) || h.userId === user.id);
  if (shouldScheduleGeoRefresh) scheduleHostGeoRefresh(visibleHosts);
  return visibleHosts;
}

function compactHostForList(host: any) {
  const { agentToken, ...rest } = host || {};
  return rest;
}

function hostMatchesListSearch(host: any, search: string) {
  const tokens = String(search || "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;
  const text = [
    host?.id,
    host?.name,
    host?.ip,
    host?.ipv4,
    host?.ipv6,
    host?.entryIp,
    host?.tunnelEntryIp,
    host?.osInfo,
    host?.cpuInfo,
    host?.agentVersion,
    host?.hostType,
  ].map((value) => String(value || "").toLowerCase()).join(" ");
  return tokens.every((token) => text.includes(token));
}

function orderHostsByGroups(hostRows: any[], groups: any[], selectedGroupId?: number | null) {
  const hostById = new Map(hostRows.map((host) => [Number(host.id), host]));
  const enabledGroups = [...groups]
    .filter((group) => group?.isEnabled !== false)
    .sort((a, b) => Number(a.sortOrder || 0) - Number(b.sortOrder || 0) || Number(a.id || 0) - Number(b.id || 0));
  if (selectedGroupId) {
    const selected = enabledGroups.find((group) => Number(group.id) === Number(selectedGroupId));
    return (selected?.hostIds || selected?.members?.map((member: any) => member.hostId) || [])
      .map((hostId: unknown) => hostById.get(Number(hostId)))
      .filter(Boolean);
  }
  if (enabledGroups.length === 0) return hostRows;

  const ordered: any[] = [];
  const used = new Set<number>();
  for (const group of enabledGroups) {
    const hostIds = group?.hostIds || group?.members?.map((member: any) => member.hostId) || [];
    for (const value of hostIds) {
      const hostId = Number(value || 0);
      const host = hostById.get(hostId);
      if (!host || used.has(hostId)) continue;
      used.add(hostId);
      ordered.push(host);
    }
  }
  for (const host of hostRows) {
    const hostId = Number(host.id || 0);
    if (!used.has(hostId)) ordered.push(host);
  }
  return ordered;
}

function compactHostStatus(host: any) {
  return {
    id: Number(host?.id || 0),
    isOnline: !!host?.isOnline,
    lastHeartbeat: host?.lastHeartbeat || null,
    agentVersion: host?.agentVersion || null,
    agentUpgradeRequested: !!host?.agentUpgradeRequested,
    agentUpgradeTargetVersion: host?.agentUpgradeTargetVersion || null,
    agentUpgradeRequestedAt: host?.agentUpgradeRequestedAt || null,
    updatedAt: host?.updatedAt || null,
  };
}

function compactHostMetricSummary(row: any) {
  return {
    hostId: Number(row?.hostId || 0),
    cpuUsage: row?.cpuUsage ?? null,
    memoryUsage: row?.memoryUsage ?? null,
    memoryUsed: row?.memoryUsed ?? null,
    swapUsage: row?.swapUsage ?? null,
    swapUsed: row?.swapUsed ?? null,
    swapTotal: row?.swapTotal ?? null,
    networkSpeedIn: row?.networkSpeedIn == null ? null : Math.round(Number(row.networkSpeedIn) || 0),
    networkIn: row?.networkIn == null ? null : Math.max(0, Number(row.networkIn) || 0),
    networkOut: row?.networkOut == null ? null : Math.max(0, Number(row.networkOut) || 0),
    networkSpeedOut: row?.networkSpeedOut == null ? null : Math.round(Number(row.networkSpeedOut) || 0),
    diskUsage: row?.diskUsage ?? null,
    diskUsed: row?.diskUsed ?? null,
    diskTotal: row?.diskTotal ?? null,
    uptime: row?.uptime ?? null,
    recordedAt: row?.recordedAt || null,
  };
}

function compactHostTrafficSummary(row: any) {
  return {
    hostId: Number(row?.hostId || 0),
    bytesIn: Math.max(0, Number(row?.bytesIn) || 0),
    bytesOut: Math.max(0, Number(row?.bytesOut) || 0),
  };
}

function normalizePublicHostMonitorPath(value: unknown) {
  const text = String(value || "dev")
    .trim()
    .replace(/^\/+|\/+$/g, "")
    .toLowerCase();
  return text || "dev";
}

function compactPublicMonitorHost(host: any) {
  return {
    id: Number(host?.id || 0),
    name: host?.name || "",
    memoryTotal: host?.memoryTotal ?? null,
    agentVersion: host?.agentVersion || null,
    stoppedAt: host?.stoppedAt || null,
    trafficLimit: host?.trafficLimit ?? 0,
    trafficMeasureMode: host?.trafficMeasureMode || "both",
    isOnline: !!host?.isOnline,
    lastHeartbeat: host?.lastHeartbeat || null,
    sortOrder: Number(host?.sortOrder || 0),
    geoCountryCode: host?.geoCountryCode || null,
    geoCountryName: host?.geoCountryName || null,
    geoRegion: host?.geoRegion || null,
    geoEmoji: host?.geoEmoji || null,
  };
}

function compactPublicMonitorGroup(group: any, visibleHostIds: Set<number>) {
  const hostIds = (group?.hostIds || [])
    .map((id: unknown) => Number(id))
    .filter((id: number) => Number.isInteger(id) && id > 0 && visibleHostIds.has(id));
  return {
    id: Number(group?.id || 0),
    name: String(group?.name || ""),
    sortOrder: Number(group?.sortOrder || 0),
    hostIds,
  };
}

function publicProbeServiceAppliesToHost(service: any, hostId: number) {
  const id = Number(hostId);
  if (!id || service?.isEnabled === false) return false;
  const scope = String(service?.hostScope || "all");
  if (scope === "specific") return (service.hostIds || []).map(Number).includes(id);
  if (scope === "exclude") return !(service.excludeHostIds || []).map(Number).includes(id);
  return true;
}

function compactPublicProbeService(service: any, latest?: any) {
  return {
    id: Number(service?.id || 0),
    name: String(service?.name || ""),
    method: service?.method === "ping" ? "ping" : "tcping",
    latest: latest ? {
      latencyMs: latest.latencyMs == null ? null : Number(latest.latencyMs),
      isTimeout: !!latest.isTimeout,
      recordedAt: latest.recordedAt || null,
    } : null,
  };
}

function compactPublicProbeSeries(row: any) {
  return {
    serviceId: Number(row?.serviceId || 0),
    hostId: Number(row?.hostId || 0),
    latencyMs: row?.latencyMs == null ? null : Number(row.latencyMs),
    isTimeout: !!row?.isTimeout,
    recordedAt: row?.recordedAt || null,
  };
}

async function assertPublicHostMonitorRequest(path: unknown) {
  const settings = await db.getAllSettings();
  const configuredPath = normalizePublicHostMonitorPath(settings.publicHostMonitorPath);
  const requestedPath = normalizePublicHostMonitorPath(path);
  if (settings.publicHostMonitorEnabled !== "true" || requestedPath !== configuredPath) {
    throw new TRPCError({ code: "NOT_FOUND", message: "主机监控面板未开启或路径不正确" });
  }
  return { settings, configuredPath };
}

function scheduleStaleHostUpgradeCleanup() {
  const now = Date.now();
  if (hostUpgradeCleanupRunning || now - lastHostUpgradeCleanupAt < HOST_UPGRADE_CLEANUP_INTERVAL_MS) return;
  hostUpgradeCleanupRunning = true;
  lastHostUpgradeCleanupAt = now;
  void db.clearStaleHostAgentUpgradeRequests()
    .catch((error) => {
      console.warn("[Hosts] Failed to clear stale Agent upgrade requests:", error);
    })
    .finally(() => {
      hostUpgradeCleanupRunning = false;
    });
}

function scheduleOrphanedAgentHostCleanup() {
  const now = Date.now();
  if (orphanedAgentHostCleanupRunning || now - lastOrphanedAgentHostCleanupAt < ORPHANED_AGENT_HOST_CLEANUP_INTERVAL_MS) return;
  orphanedAgentHostCleanupRunning = true;
  lastOrphanedAgentHostCleanupAt = now;
  void db.purgeOrphanedAgentHosts()
    .then((count) => {
      if (count > 0) console.info(`[Hosts] Purged orphaned Agent host records count=${count}`);
    })
    .catch((error) => {
      console.warn("[Hosts] Failed to purge orphaned Agent hosts:", error instanceof Error ? error.message : String(error));
    })
    .finally(() => {
      orphanedAgentHostCleanupRunning = false;
    });
}

export const hostsRouter = router({
    publicMonitor: publicProcedure
      .input(z.object({ path: z.string().max(128).optional() }).optional())
      .query(async ({ input }) => {
        const { configuredPath } = await assertPublicHostMonitorRequest(input?.path);
        const hosts = (await db.getHosts() as any[]).map(compactPublicMonitorHost).filter((host) => host.id > 0);
        const hostIds = hosts.map((host) => host.id);
        const visibleHostIds = new Set(hostIds);
        const [metricRows, trafficRows] = await Promise.all([
          db.getLatestHostMetricRows(hostIds),
          db.getHostTrafficSummary(hostIds),
        ]);
        const groups = ((await db.getHostGroups()) as any[])
          .filter((group) => !!group?.isEnabled)
          .map((group) => compactPublicMonitorGroup(group, visibleHostIds))
          .filter((group) => group.id > 0 && group.name && group.hostIds.length > 0)
          .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
        const compactMetrics = (metricRows as any[]).map(compactHostMetricSummary).filter((row) => row.hostId > 0);
        const compactTraffic = (trafficRows as any[]).map(compactHostTrafficSummary).filter((row) => row.hostId > 0);
        let currentTrafficIn = 0;
        let currentTrafficOut = 0;
        for (const row of compactMetrics) {
          currentTrafficIn += Math.max(0, Number(row.networkSpeedIn) || 0);
          currentTrafficOut += Math.max(0, Number(row.networkSpeedOut) || 0);
        }
        let totalTrafficIn = 0;
        let totalTrafficOut = 0;
        for (const row of compactTraffic) {
          totalTrafficIn += Math.max(0, Number(row.bytesIn) || 0);
          totalTrafficOut += Math.max(0, Number(row.bytesOut) || 0);
        }
        return {
          path: configuredPath,
          refreshedAt: new Date().toISOString(),
          hosts,
          groups,
          metrics: compactMetrics,
          traffic: compactTraffic,
          summary: {
            totalHosts: hosts.length,
            onlineHosts: hosts.filter((host) => !!host.isOnline).length,
            currentTrafficIn,
            currentTrafficOut,
            totalTrafficIn,
            totalTrafficOut,
          },
        };
      }),
    publicMonitorHostDetail: publicProcedure
      .input(z.object({
        path: z.string().max(128).optional(),
        hostId: z.number().int().positive(),
        hours: z.number().int().min(1).max(72).default(24),
      }))
      .query(async ({ input }) => {
        const { configuredPath } = await assertPublicHostMonitorRequest(input.path);
        const rawHost = await db.getHostById(input.hostId) as any;
        if (!rawHost) throw new TRPCError({ code: "NOT_FOUND", message: "主机不存在" });
        const host = compactPublicMonitorHost(rawHost);
        const [metricRows, trafficRows, allServices] = await Promise.all([
          db.getLatestHostMetricRows([host.id]),
          db.getHostTrafficSummary([host.id]),
          db.getHostProbeServices(),
        ]);
        const services = (allServices as any[])
          .filter((service) => publicProbeServiceAppliesToHost(service, host.id));
        const serviceIds = services.map((service) => Number(service.id)).filter((id) => Number.isInteger(id) && id > 0);
        const series = serviceIds.length > 0
          ? (await db.getHostProbeServiceSeries({ serviceIds, hostId: host.id, hours: input.hours, limit: 20_000 }) as any[])
            .map(compactPublicProbeSeries)
            .filter((row) => row.serviceId > 0 && row.hostId === host.id)
          : [];
        const latestByService = new Map<number, any>();
        for (const row of series) latestByService.set(Number(row.serviceId), row);
        return {
          path: configuredPath,
          refreshedAt: new Date().toISOString(),
          host,
          metric: (metricRows as any[]).map(compactHostMetricSummary).find((row) => row.hostId === host.id) || null,
          traffic: (trafficRows as any[]).map(compactHostTrafficSummary).find((row) => row.hostId === host.id) || compactHostTrafficSummary({ hostId: host.id }),
          services: services.map((service) => compactPublicProbeService(service, latestByService.get(Number(service.id))))
            .filter((service) => service.id > 0 && service.name),
          serviceSeries: series,
        };
      }),
    list: protectedProcedure.query(async ({ ctx }) => {
      if (ctx.user.role === "admin") {
        scheduleStaleHostUpgradeCleanup();
        scheduleOrphanedAgentHostCleanup();
      }
      const hosts = await getVisibleHostsForUser(ctx.user);
      return hosts.map(compactHostForList);
    }),
    options: protectedProcedure.query(async ({ ctx }) => {
      const scope = await visibleHostQueryScope(ctx.user);
      const hosts = await db.getHostOptions(scope.ownerUserId, scope.allowedHostIds);
      scheduleHostGeoRefresh(hosts);
      return hosts;
    }),
    listPage: protectedProcedure
      .input(pageRequestSchema.extend({
        search: z.string().trim().max(200).optional().default(""),
        groupId: z.number().int().positive().nullable().optional(),
      }))
      .query(async ({ input, ctx }) => {
        if (ctx.user.role === "admin") {
          scheduleStaleHostUpgradeCleanup();
          scheduleOrphanedAgentHostCleanup();
        }
        const scope = await visibleHostQueryScope(ctx.user);
        const [pageData, groups] = await Promise.all([
          db.getHostsPage({
            ...input,
            ...scope,
            orderByGroups: ctx.user.role === "admin",
          }),
          ctx.user.role === "admin" ? db.getHostGroups() : Promise.resolve([]),
        ]);
        const items = await clearCompletedHostAgentUpgradeRequests(pageData.items as any[]);
        scheduleHostGeoRefresh(items);
        let outdatedItems = 0;
        let onlineOutdatedItems = 0;
        let offlineUpgradeableItems = 0;
        for (const row of pageData.versionCounts as any[]) {
          if (!row?.agentVersion || isAgentVersionAtLeast(row.agentVersion, AGENT_VERSION)) continue;
          const count = Math.max(0, Number(row.count || 0));
          outdatedItems += count;
          if (row.online) onlineOutdatedItems += count;
          else offlineUpgradeableItems += count;
        }
        const groupCounts = Object.fromEntries((groups as any[]).map((group) => [
          Number(group.id),
          (group.hostIds || group.members?.map((member: any) => member.hostId) || [])
            .filter((hostId: unknown) => Number(hostId) > 0).length,
        ]));
        return {
          ...pageData,
          items: items.map(compactHostForList),
          versionCounts: undefined,
          outdatedItems,
          onlineOutdatedItems,
          offlineUpgradeableItems,
          groupCounts,
        };
      }),
    upgradeCandidates: adminProcedure
      .input(z.object({
        search: z.string().trim().max(200).optional().default(""),
        groupId: z.number().int().positive().nullable().optional(),
      }))
      .query(async ({ input }) => {
        scheduleStaleHostUpgradeCleanup();
        const hosts = await db.getHostUpgradeCandidates(input) as any[];
        const outdated = hosts.filter((host: any) => (
          !!host.agentVersion && !isAgentVersionAtLeast(host.agentVersion, AGENT_VERSION)
        ));
        const candidates = outdated.filter((host: any) => {
          if (!host.isOnline) return false;
          const requestedAt = host.agentUpgradeRequestedAt ? new Date(host.agentUpgradeRequestedAt).getTime() : 0;
          const timedOut = !!host.agentUpgradeRequested && requestedAt > 0 && Date.now() - requestedAt > 10 * 60 * 1000;
          return !host.agentUpgradeRequested || timedOut;
        });
        return {
          ids: candidates.map((host: any) => Number(host.id)),
          totalItems: candidates.length,
          offlineItems: outdated.filter((host: any) => !host.isOnline).length,
        };
      }),
    mapPoints: protectedProcedure
      .input(z.object({
        cursor: z.number().int().min(0).optional(),
        limit: z.number().int().min(20).max(250).default(100),
        search: z.string().trim().max(200).optional().default(""),
        groupId: z.number().int().positive().nullable().optional(),
      }))
      .query(async ({ input, ctx }) => {
        const cursor = Math.max(0, Number(input.cursor || 0));
        const scope = await visibleHostQueryScope(ctx.user);
        const pageData = await db.getHostsPage({
          ...scope,
          search: input.search,
          groupId: input.groupId,
          orderByGroups: ctx.user.role === "admin",
          page: Math.floor(cursor / input.limit) + 1,
          pageSize: input.limit,
        });
        const rows = cursor < pageData.totalItems ? pageData.items as any[] : [];
        scheduleHostGeoRefresh(rows);
        const items = rows.map((host: any) => ({
          id: Number(host.id),
          name: String(host.name || ""),
          ip: host.ip || null,
          ipv4: host.ipv4 || null,
          ipv6: host.ipv6 || null,
          isOnline: !!host.isOnline,
          osInfo: host.osInfo || null,
          agentVersion: host.agentVersion || null,
          geoCountryCode: host.geoCountryCode || null,
          geoCountryName: host.geoCountryName || null,
          geoRegion: host.geoRegion || null,
          geoLatitudeMicro: host.geoLatitudeMicro ?? null,
          geoLongitudeMicro: host.geoLongitudeMicro ?? null,
        }));
        const nextCursor = cursor + rows.length < pageData.totalItems ? cursor + rows.length : undefined;
        return { items, nextCursor, totalItems: pageData.totalItems };
      }),
    statusSummary: protectedProcedure
      .input(z.object({ hostIds: z.array(z.number().int().positive()).max(100).optional() }).optional())
      .query(async ({ input, ctx }) => {
      const requestedIds = Array.from(new Set((input?.hostIds || []).map(Number).filter((id) => id > 0)));
      if (requestedIds.length === 0) return [];
      const scope = await visibleHostQueryScope(ctx.user);
      const hosts = await db.getHostStatusRows({ ...scope, hostIds: requestedIds });
      return hosts
        .map(compactHostStatus)
        .filter((host: ReturnType<typeof compactHostStatus>) => host.id > 0);
    }),
    summary: protectedProcedure
      .input(z.object({
        search: z.string().trim().max(200).optional().default(""),
        groupId: z.number().int().positive().nullable().optional(),
      }).optional())
      .query(async ({ input, ctx }) => hostQueryCache.get(
      `summary:${ctx.user.id}:${input?.groupId || "all"}:${input?.search || ""}`,
      { ttlMs: 2_000, staleMs: 10_000 },
      async () => {
        const scope = await visibleHostQueryScope(ctx.user);
        const summaryScope = await db.getHostSummaryScope({
          ...scope,
          search: input?.search || "",
          groupId: input?.groupId,
        });
        const hostIds = summaryScope.hostIds;
        const [metricSnapshots, trafficRows] = await Promise.all([
          db.getLatestHostMetricSnapshots(hostIds),
          db.getHostTrafficSummary(hostIds),
        ]);
        const instantTraffic = db.summarizeHostInstantTraffic(metricSnapshots);
        let totalTrafficIn = 0;
        let totalTrafficOut = 0;
        for (const row of trafficRows as any[]) {
          totalTrafficIn += Math.max(0, Number(row?.bytesIn) || 0);
          totalTrafficOut += Math.max(0, Number(row?.bytesOut) || 0);
        }
        return {
          totalHosts: summaryScope.totalHosts,
          onlineHosts: summaryScope.onlineHosts,
          currentTrafficIn: instantTraffic.currentTrafficIn,
          currentTrafficOut: instantTraffic.currentTrafficOut,
          currentTrafficTotal: instantTraffic.currentTrafficTotal,
          measuredHosts: instantTraffic.measuredHosts,
          totalTrafficIn,
          totalTrafficOut,
          totalTraffic: totalTrafficIn + totalTrafficOut,
        };
      },
    )),
    probeServices: protectedProcedure.query(async ({ ctx }) => {
      const isAdmin = ctx.user.role === "admin";
      const services = await db.getHostProbeServices(isAdmin ? undefined : ctx.user.id);
      const latestById = await db.getLatestHostProbeServiceStats(services.map((service: any) => Number(service.id)));
      return services.map((service: any) => ({
        ...service,
        latest: latestById.get(Number(service.id)) || null,
      }));
    }),
    probeServiceSeries: protectedProcedure
      .input(z.object({ serviceIds: z.array(z.number().int().positive()).max(200).optional(), hostId: z.number().int().positive().optional(), hours: z.number().min(0.5).max(24 * 3).default(24) }).optional())
      .query(async ({ input, ctx }) => {
        const isAdmin = ctx.user.role === "admin";
        const visibleServices = await db.getHostProbeServices(isAdmin ? undefined : ctx.user.id);
        const visibleIds = new Set((visibleServices as any[]).map((service) => Number(service.id)));
        const requested = Array.from(new Set((input?.serviceIds || []).map(Number).filter((id) => Number.isInteger(id) && id > 0)));
        const serviceIds = requested.length > 0 ? requested.filter((id) => visibleIds.has(id)) : Array.from(visibleIds);
        if (serviceIds.length === 0) return [];
        return db.getHostProbeServiceSeries({ serviceIds, hostId: input?.hostId, hours: input?.hours || 24 });
      }),
    createProbeService: adminProcedure
      .input(hostProbeServiceInputSchema)
      .mutation(async ({ input, ctx }) => {
        const payload = normalizeHostProbeServiceInput(input);
        const id = await db.createHostProbeService({ ...payload, userId: ctx.user.id });
        return { id };
      }),
    updateProbeService: adminProcedure
      .input(hostProbeServiceInputSchema.extend({ id: z.number().int().positive() }))
      .mutation(async ({ input }) => {
        const service = await db.getHostProbeServiceById(input.id);
        if (!service) throw new Error("服务不存在");
        const payload = normalizeHostProbeServiceInput(input);
        await db.updateHostProbeService(input.id, payload);
        return { success: true };
      }),
    deleteProbeService: adminProcedure
      .input(z.object({ id: z.number().int().positive() }))
      .mutation(async ({ input }) => {
        const service = await db.getHostProbeServiceById(input.id);
        if (!service) throw new Error("服务不存在");
        await db.deleteHostProbeService(input.id);
        return { success: true };
      }),
    reorderProbeServices: adminProcedure
      .input(z.object({ ids: reorderIdsSchema }))
      .mutation(async ({ input }) => {
        await db.reorderHostProbeServices(input.ids);
        return { success: true };
      }),
    hostGroups: adminProcedure.query(async () => db.getHostGroups()),
    createHostGroup: adminProcedure
      .input(hostGroupInputSchema)
      .mutation(async ({ input, ctx }) => {
        const payload = normalizeHostGroupInput(input);
        await assertHostGroupHostIdsExist(payload.hostIds);
        const id = await db.createHostGroup({ ...payload, userId: ctx.user.id });
        return { id };
      }),
    updateHostGroup: adminProcedure
      .input(hostGroupInputSchema.extend({ id: z.number().int().positive() }))
      .mutation(async ({ input }) => {
        const group = await db.getHostGroupById(input.id);
        if (!group) throw new Error("主机分组不存在");
        const payload = normalizeHostGroupInput(input);
        await assertHostGroupHostIdsExist(payload.hostIds);
        await db.updateHostGroup(input.id, payload);
        return { success: true };
      }),
    deleteHostGroup: adminProcedure
      .input(z.object({ id: z.number().int().positive() }))
      .mutation(async ({ input }) => {
        const group = await db.getHostGroupById(input.id);
        if (!group) throw new Error("主机分组不存在");
        await db.deleteHostGroup(input.id);
        return { success: true };
      }),
    reorderHostGroups: adminProcedure
      .input(z.object({ ids: reorderIdsSchema }))
      .mutation(async ({ input }) => {
        await db.reorderHostGroups(input.ids);
        return { success: true };
      }),
    reorderHostGroupMembers: adminProcedure
      .input(z.object({
        groupId: z.number().int().positive(),
        hostIds: reorderIdsSchema,
        startIndex: z.number().int().min(0).max(1_000_000).optional().default(0),
      }))
      .mutation(async ({ input }) => {
        const group = await db.getHostGroupById(input.groupId);
        if (!group) throw new Error("主机分组不存在");
        await assertHostGroupHostIdsExist(input.hostIds);
        await db.reorderHostGroupMembers(input.groupId, input.hostIds, input.startIndex);
        return { success: true };
      }),
    /** 获取所有主机列表（管理员用，用于权限分配） */
    listAll: adminProcedure.query(async () => {
      const hosts = await getHostsWithUpgradeStateCleanup();
      scheduleHostGeoRefresh(hosts);
      return hosts;
    }),
    getById: protectedProcedure
      .input(z.object({ id: z.number() }))
      .query(async ({ input, ctx }) => {
        const host = await db.getHostById(input.id);
        if (!host) return null;
        if (ctx.user.role !== "admin") {
          if (host.userId !== ctx.user.id) {
            const hasPermission = await db.checkUserHostPermission(ctx.user.id, host.id);
            if (!hasPermission) return null;
          }
        }
        return ctx.user.role === "admin" ? host : compactHostForList(host);
      }),
    create: protectedProcedure
      .input(z.object({
        name: z.string().min(1).max(128),
        ip: hostAddressSchema,
        hostType: z.enum(["master", "slave"]).default("slave"),
        networkInterface: networkInterfaceSchema,
        sortOrder: hostSortOrderSchema,
        entryIp: optionalHostAddressSchema,
        tunnelEntryIp: optionalHostAddressSchema,
        portRangeStart: z.number().int().min(1).max(65535).nullable().optional(),
        portRangeEnd: z.number().int().min(1).max(65535).nullable().optional(),
        portAllowlist: z.string().max(2000).nullable().optional(),
        purchasedAt: optionalDateInputSchema,
        stoppedAt: optionalDateInputSchema,
        trafficLimit: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
        trafficMeasureMode: hostTrafficMeasureModeSchema.optional(),
        telegramTrafficAlertEnabled: z.boolean().optional(),
        trafficAlertThresholdPercent: z.number().int().min(1).max(99).optional(),
        telegramRenewalReminderEnabled: z.boolean().optional(),
        renewalReminderDays: z.number().int().min(1).max(365).optional(),
        trafficAutoReset: z.boolean().optional(),
        trafficResetDay: z.number().int().min(1).max(31).optional(),
        ddnsEnabled: z.boolean().optional(),
        ddnsDomain: hostDdnsDomainSchema,
        ddnsRecordType: hostDdnsRecordTypeSchema.optional(),
        ddnsIpVersion: hostDdnsIpVersionSchema.optional(),
        blockHttp: z.boolean().optional(),
        blockSocks: z.boolean().optional(),
        blockTls: z.boolean().optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        // 验证端口区间
        if ((input.portRangeStart != null && input.portRangeEnd == null) || (input.portRangeStart == null && input.portRangeEnd != null)) {
          throw new Error("请同时填写端口区间的起始和结束值，或同时留空");
        }
        if (input.portRangeStart != null && input.portRangeEnd != null) {
          if (input.portRangeStart > input.portRangeEnd) {
            throw new Error("端口区间起始值不能大于结束值");
          }
        }
        const agentToken = nanoid(32);
        const trafficConfig = ctx.user.role === "admin"
          ? hostTrafficConfigPayload(input)
          : { purchasedAt: null, stoppedAt: null, trafficLimit: 0, trafficMeasureMode: "both", telegramTrafficAlertEnabled: false, trafficAlertThresholdPercent: 20, telegramRenewalReminderEnabled: false, renewalReminderDays: 7, trafficAutoReset: false, trafficResetDay: 1 };
        if (ctx.user.role === "admin" && (trafficConfig.telegramTrafficAlertEnabled || trafficConfig.telegramRenewalReminderEnabled)) {
          await assertTelegramBotConfiguredForHostReminder();
        }
        const ddnsConfig = ctx.user.role === "admin"
          ? normalizeHostDdnsPayload(input)
          : { ddnsEnabled: false, ddnsDomain: null, ddnsRecordType: "A", ddnsIpVersion: "ipv4" };
        if ((ddnsConfig as any).ddnsEnabled) await assertHostDdnsServiceConfigured();
        const id = await db.createHost({
          ...input,
          ...trafficConfig,
          ...ddnsConfig,
          agentToken,
          networkInterface: input.networkInterface || null,
          sortOrder: input.sortOrder ?? 0,
          entryIp: input.entryIp || null,
          tunnelEntryIp: input.tunnelEntryIp || null,
          portRangeStart: input.portRangeStart ?? null,
          portRangeEnd: input.portRangeEnd ?? null,
          portAllowlist: normalizePortAllowlist(input.portAllowlist) || null,
          blockHttp: ctx.user.role === "admin" ? !!input.blockHttp : false,
          blockSocks: ctx.user.role === "admin" ? !!input.blockSocks : false,
          blockTls: ctx.user.role === "admin" ? !!input.blockTls : false,
          userId: ctx.user.id,
        });
        return { id, agentToken };
      }),
    reorder: protectedProcedure
      .input(z.object({
        ids: reorderIdsSchema,
        startIndex: z.number().int().min(0).max(1_000_000).optional().default(0),
      }))
      .mutation(async ({ input, ctx }) => {
        await db.reorderHosts(input.ids, ctx.user.role === "admin" ? undefined : ctx.user.id, input.startIndex);
        return { success: true };
      }),
    update: protectedProcedure
      .input(z.object({
        id: z.number(),
        name: z.string().min(1).max(128).optional(),
        ip: hostAddressSchema.optional(),
        hostType: z.enum(["master", "slave"]).optional(),
        networkInterface: networkInterfaceSchema,
        sortOrder: hostSortOrderSchema,
        entryIp: optionalHostAddressSchema,
        tunnelEntryIp: optionalHostAddressSchema,
        portRangeStart: z.number().int().min(1).max(65535).nullable().optional(),
        portRangeEnd: z.number().int().min(1).max(65535).nullable().optional(),
        portAllowlist: z.string().max(2000).nullable().optional(),
        purchasedAt: optionalDateInputSchema,
        stoppedAt: optionalDateInputSchema,
        trafficLimit: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
        trafficMeasureMode: hostTrafficMeasureModeSchema.optional(),
        telegramTrafficAlertEnabled: z.boolean().optional(),
        trafficAlertThresholdPercent: z.number().int().min(1).max(99).optional(),
        telegramRenewalReminderEnabled: z.boolean().optional(),
        renewalReminderDays: z.number().int().min(1).max(365).optional(),
        trafficAutoReset: z.boolean().optional(),
        trafficResetDay: z.number().int().min(1).max(31).optional(),
        ddnsEnabled: z.boolean().optional(),
        ddnsDomain: hostDdnsDomainSchema,
        ddnsRecordType: hostDdnsRecordTypeSchema.optional(),
        ddnsIpVersion: hostDdnsIpVersionSchema.optional(),
        blockHttp: z.boolean().optional(),
        blockSocks: z.boolean().optional(),
        blockTls: z.boolean().optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        const host = await db.getHostById(input.id);
        if (!host) throw new Error("主机不存在");
        if (ctx.user.role !== "admin" && host.userId !== ctx.user.id) throw new Error("无权操作此主机");
        // 验证端口区间
        const pStart = input.portRangeStart !== undefined ? input.portRangeStart : (host as any).portRangeStart;
        const pEnd = input.portRangeEnd !== undefined ? input.portRangeEnd : (host as any).portRangeEnd;
        if ((input.portRangeStart !== undefined || input.portRangeEnd !== undefined) && ((pStart != null && pEnd == null) || (pStart == null && pEnd != null))) {
          throw new Error("请同时填写端口区间的起始和结束值，或同时留空");
        }
        if (pStart != null && pEnd != null && pStart > pEnd) {
          throw new Error("端口区间起始值不能大于结束值");
        }
        const nextPortAllowlist = input.portAllowlist !== undefined
          ? normalizePortAllowlist(input.portAllowlist)
          : String((host as any).portAllowlist || "");
        const { id, ...data } = input;
        let ddnsConfigChanged = false;
        if (data.networkInterface !== undefined) data.networkInterface = data.networkInterface || null;
        if ((data as any).sortOrder !== undefined) (data as any).sortOrder = Math.min(200, Math.max(0, Math.floor(Number((data as any).sortOrder) || 0)));
        if (data.entryIp !== undefined) data.entryIp = data.entryIp || null;
        if (data.tunnelEntryIp !== undefined) data.tunnelEntryIp = data.tunnelEntryIp || null;
        if ((data as any).portAllowlist !== undefined) (data as any).portAllowlist = nextPortAllowlist || null;
        if (ctx.user.role === "admin") {
          const hasDdnsConfigInput = ["ddnsEnabled", "ddnsDomain", "ddnsRecordType", "ddnsIpVersion"].some((key) => (data as any)[key] !== undefined);
          if (hasDdnsConfigInput) {
            const ddnsConfig = normalizeHostDdnsPayload({
              ddnsEnabled: (data as any).ddnsEnabled !== undefined ? (data as any).ddnsEnabled : (host as any).ddnsEnabled,
              ddnsDomain: (data as any).ddnsDomain !== undefined ? (data as any).ddnsDomain : (host as any).ddnsDomain,
              ddnsRecordType: (data as any).ddnsRecordType !== undefined ? (data as any).ddnsRecordType : (host as any).ddnsRecordType,
              ddnsIpVersion: (data as any).ddnsIpVersion !== undefined ? (data as any).ddnsIpVersion : (host as any).ddnsIpVersion,
            });
            if (ddnsConfig.ddnsEnabled) await assertHostDdnsServiceConfigured();
            Object.assign(data as any, ddnsConfig);
            ddnsConfigChanged = true;
            const previousDdnsDomain = String((host as any).ddnsDomain || "").trim().replace(/\.+$/, "").toLowerCase();
            const ddnsTargetChanged = ddnsConfig.ddnsDomain !== previousDdnsDomain
              || ddnsConfig.ddnsEnabled !== !!(host as any).ddnsEnabled
              || ddnsConfig.ddnsIpVersion !== normalizeHostDdnsIpVersion((host as any).ddnsIpVersion, (host as any).ddnsRecordType);
            if (ddnsTargetChanged) {
              (data as any).lastDdnsValue = null;
              (data as any).lastDdnsAt = null;
              (data as any).lastDdnsError = null;
            }
          }
          const hasTrafficConfigInput = ["purchasedAt", "stoppedAt", "trafficLimit", "trafficMeasureMode", "telegramTrafficAlertEnabled", "trafficAlertThresholdPercent", "telegramRenewalReminderEnabled", "renewalReminderDays", "trafficAutoReset", "trafficResetDay"].some((key) => (data as any)[key] !== undefined);
          if (hasTrafficConfigInput) {
            const purchasedAt = (data as any).purchasedAt !== undefined
              ? parseOptionalDateInput((data as any).purchasedAt, "机器购买时间")
              : normalizeExistingOptionalDate((host as any).purchasedAt);
            const stoppedAt = (data as any).stoppedAt !== undefined
              ? parseOptionalDateInput((data as any).stoppedAt, "机器停止时间")
              : normalizeExistingOptionalDate((host as any).stoppedAt);
            assertHostTrafficDates(purchasedAt, stoppedAt);
            if ((data as any).purchasedAt !== undefined) (data as any).purchasedAt = purchasedAt;
            if ((data as any).stoppedAt !== undefined) (data as any).stoppedAt = stoppedAt;
            if ((data as any).trafficLimit !== undefined) (data as any).trafficLimit = Math.max(0, Math.floor(Number((data as any).trafficLimit) || 0));
            if ((data as any).trafficMeasureMode !== undefined) (data as any).trafficMeasureMode = normalizeHostTrafficMeasureMode((data as any).trafficMeasureMode);
            if ((data as any).telegramTrafficAlertEnabled !== undefined) (data as any).telegramTrafficAlertEnabled = !!(data as any).telegramTrafficAlertEnabled;
            if ((data as any).trafficAlertThresholdPercent !== undefined) (data as any).trafficAlertThresholdPercent = normalizeTrafficAlertThresholdPercent((data as any).trafficAlertThresholdPercent);
            if ((data as any).telegramRenewalReminderEnabled !== undefined) (data as any).telegramRenewalReminderEnabled = !!(data as any).telegramRenewalReminderEnabled;
            if ((data as any).renewalReminderDays !== undefined) (data as any).renewalReminderDays = normalizeRenewalReminderDays((data as any).renewalReminderDays);
            if ((data as any).trafficAutoReset !== undefined) (data as any).trafficAutoReset = !!(data as any).trafficAutoReset;
            if ((data as any).trafficResetDay !== undefined) (data as any).trafficResetDay = Math.min(31, Math.max(1, Number((data as any).trafficResetDay) || 1));
            const nextTelegramTrafficAlertEnabled = (data as any).telegramTrafficAlertEnabled !== undefined
              ? !!(data as any).telegramTrafficAlertEnabled
              : !!(host as any).telegramTrafficAlertEnabled;
            const nextTelegramRenewalReminderEnabled = (data as any).telegramRenewalReminderEnabled !== undefined
              ? !!(data as any).telegramRenewalReminderEnabled
              : !!(host as any).telegramRenewalReminderEnabled;
            if (nextTelegramTrafficAlertEnabled || nextTelegramRenewalReminderEnabled) {
              await assertTelegramBotConfiguredForHostReminder();
            }
          }
        } else {
          for (const field of ["purchasedAt", "stoppedAt", "trafficLimit", "trafficMeasureMode", "telegramTrafficAlertEnabled", "trafficAlertThresholdPercent", "telegramRenewalReminderEnabled", "renewalReminderDays", "trafficAutoReset", "trafficResetDay", "ddnsEnabled", "ddnsDomain", "ddnsRecordType", "ddnsIpVersion"] as const) delete (data as any)[field];
        }
        if (ctx.user.role !== "admin") {
          for (const field of hostProtocolPolicyFields) delete (data as any)[field];
        }
        const protocolPolicyChanged = hostProtocolPolicyFields.some((key) =>
          (data as any)[key] !== undefined && !!(data as any)[key] !== !!(host as any)[key]
        );
        const portRangeChanged = ["portRangeStart", "portRangeEnd"].some((key) =>
          (data as any)[key] !== undefined && Number((data as any)[key] ?? 0) !== Number((host as any)[key] ?? 0)
        ) || ((data as any).portAllowlist !== undefined && nextPortAllowlist !== String((host as any).portAllowlist || ""));
        const entryChanged = ["entryIp", "tunnelEntryIp"].some((key) =>
          (data as any)[key] !== undefined && String((data as any)[key] || "") !== String((host as any)[key] || "")
        );
        if (entryChanged) {
          Object.assign(data as any, {
            geoCountryCode: null,
            geoCountryName: null,
            geoRegion: null,
            geoEmoji: null,
            geoLatitudeMicro: null,
            geoLongitudeMicro: null,
            geoUpdatedAt: null,
          });
        }
        await db.updateHost(id, data as any);
        if (ddnsConfigChanged) {
          scheduleHostDdnsUpdate({ ...host, ...(data as any), id }, "host-ddns-config-updated");
        }
        if (entryChanged) {
          await refreshHostAddressRuntime(id, host, "host-address-updated");
        }
        if (portRangeChanged) {
          const nextPolicy = portPolicyFrom({
            portRangeStart: pStart,
            portRangeEnd: pEnd,
            portAllowlist: nextPortAllowlist,
          });
          const policyText = describePortPolicy(nextPolicy);
          const disabledCount = await db.disableForwardRulesOutsideHostPortRange(
            id,
            {
              portRangeStart: pStart,
              portRangeEnd: pEnd,
              portAllowlist: nextPortAllowlist,
            },
            portPolicyHasRestriction(nextPolicy)
              ? `入口端口不在当前主机允许范围 ${policyText} 内，请修改端口后再启用。`
              : "主机端口限制已变更，请确认端口后再启用。",
          );
          if (disabledCount > 0) {
            console.info(`[HostPolicy] disabled out-of-range rules host=${id} count=${disabledCount} range=${pStart ?? "-"}-${pEnd ?? "-"}`);
          }
          await refreshHostPolicyRuntime(id, "host-port-policy-updated");
        }
        if (protocolPolicyChanged) {
          await refreshHostPolicyRuntime(id, "host-protocol-policy-updated");
        }
        return { success: true };
      }),
    delete: protectedProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input, ctx }) => {
        const host = await db.getHostById(input.id);
        if (!host) throw new Error("主机不存在");
        if (ctx.user.role !== "admin" && host.userId !== ctx.user.id) throw new Error("无权操作此主机");
        // 检查是否存在仍会占用此主机的规则。已标记删除且停止运行的历史记录不应阻止删除主机。
        const blockers = await db.getHostRuleDeleteBlockers(input.id);
        if (blockers.ruleCount > 0) {
          throw new Error(`该主机下还有 ${blockers.ruleCount} 条转发规则，请先删除所有规则后再删除主机`);
        }
        if (blockers.managedRuleCount > 0) {
          throw new Error(`该主机仍被 ${blockers.managedRuleCount} 条转发组/转发链规则引用，请先在转发组中移除该主机或删除对应转发组`);
        }
        if (blockers.pendingCleanupCount > 0) {
          await db.releaseHostPendingRuleCleanup(input.id);
        }
        await db.deleteHostPermissions(input.id);
        await db.deleteHost(input.id);
        return { success: true };
      }),
    metrics: protectedProcedure
      .input(z.object({ hostId: z.number(), limit: z.number().default(60), live: z.boolean().optional() }))
      .query(async ({ input, ctx }) => {
        await requireHostAccess(ctx, input.hostId);
        if (input.live) return db.getLatestHostMetrics(input.hostId, input.limit);
        return hostQueryCache.get(
          `metrics:${ctx.user.id}:${input.hostId}:${input.limit}`,
          { ttlMs: 10_000, staleMs: 60_000 },
          () => db.getLatestHostMetrics(input.hostId, input.limit),
        );
      }),
    latestMetricsSummary: protectedProcedure
      .input(z.object({ hostIds: z.array(z.number()).max(500).optional() }).optional())
      .query(async ({ input, ctx }) => {
        const hostIds = Array.from(new Set((input?.hostIds || [])
          .map((id) => Number(id))
          .filter((id) => Number.isInteger(id) && id > 0)));
        if (hostIds.length === 0) return [];
        for (const hostId of hostIds) await requireHostAccess(ctx, hostId);
        const rows = await db.getLatestHostMetricRows(hostIds);
        return (rows as any[]).map(compactHostMetricSummary).filter((row) => row.hostId > 0);
      }),
    traffic: protectedProcedure
      .input(z.object({ hostId: z.number() }))
      .query(async ({ input, ctx }) => {
        await requireHostAccess(ctx, input.hostId);
        return db.getHostTraffic(input.hostId);
      }),
    trafficSummary: protectedProcedure
      .input(z.object({ hostIds: z.array(z.number()).max(500).optional() }).optional())
      .query(async ({ input, ctx }) => {
        const hostIds = Array.from(new Set((input?.hostIds || [])
          .map((id) => Number(id))
          .filter((id) => Number.isInteger(id) && id > 0)));
        if (ctx.user.role !== "admin" && hostIds.length === 0) return [];
        if (ctx.user.role !== "admin" || hostIds.length > 0) {
          for (const hostId of hostIds) await requireHostAccess(ctx, hostId);
          const rows = await db.getHostTrafficSummary(hostIds);
          return (rows as any[]).map(compactHostTrafficSummary).filter((row) => row.hostId > 0);
        }
        const rows = await db.getHostTrafficSummary();
        return (rows as any[]).map(compactHostTrafficSummary).filter((row) => row.hostId > 0);
      }),
    resetTraffic: adminProcedure
      .input(z.object({ hostId: z.number() }))
      .mutation(async ({ input }) => {
        const host = await db.getHostById(input.hostId);
        if (!host) throw new Error("主机不存在");
        appendPanelLog("info", `[HostTraffic] reset host=${host.id} name=${host.name} reason=manual-admin-reset`);
        return db.resetHostTraffic(input.hostId);
      }),
    watchMetrics: protectedProcedure
      .input(z.object({ hostIds: z.array(z.number()).max(200) }))
      .mutation(async ({ input, ctx }) => {
        const allowed: number[] = [];
        for (const hostId of input.hostIds) {
          await requireHostAccess(ctx, hostId);
          allowed.push(hostId);
        }
        const newlyWatched = markHostMetricsWatching(allowed);
        for (const hostId of newlyWatched) pushAgentRefresh(hostId, "metrics-watch");
        return { success: true, count: allowed.length };
      }),
    requestAgentUpgrade: adminProcedure
      .input(z.object({ hostId: z.number(), targetVersion: z.string().max(64).nullable().optional() }))
      .mutation(async ({ input }) => {
        const host = await db.getHostById(input.hostId);
        if (!host) throw new Error("主机不存在");
        if (!(host as any).isOnline) {
          return { success: true, pushed: false, alreadyLatest: false, skippedOffline: true };
        }
        const targetVersion = normalizeVersion(input.targetVersion || AGENT_VERSION);
        const currentVersion = normalizeVersion((host as any).agentVersion);
        if (currentVersion && isAgentVersionAtLeast(currentVersion, targetVersion)) {
          return { success: true, pushed: false, alreadyLatest: true };
        }
        appendPanelLog("info", `[AgentUpgrade] request host=${host.id} name=${host.name} current=${currentVersion || "-"} target=${targetVersion}`);
        await assertAgentReleaseAssetsReady(targetVersion);
        await db.requestHostAgentUpgrade(input.hostId, targetVersion);
        const configuredPanelUrl = (await db.getSetting("panelPublicUrl")) || "";
        const panelUrl = /^https?:\/\//.test(configuredPanelUrl) ? configuredPanelUrl.replace(/\/+$/, "") : "";
        const pushed = pushAgentUpgrade(input.hostId, targetVersion, panelUrl);
        return { success: true, pushed };
      }),
    requestAgentUpgradeMany: adminProcedure
      .input(z.object({ hostIds: z.array(z.number()).min(1).max(500), targetVersion: z.string().max(64).nullable().optional() }))
      .mutation(async ({ input }) => {
        const targetVersion = normalizeVersion(input.targetVersion || AGENT_VERSION);
        const configuredPanelUrl = (await db.getSetting("panelPublicUrl")) || "";
        const panelUrl = /^https?:\/\//.test(configuredPanelUrl) ? configuredPanelUrl.replace(/\/+$/, "") : "";
        let requested = 0;
        let pushed = 0;
        let skippedLatest = 0;
        let skippedOffline = 0;
        const missing: number[] = [];
        const uniqueHostIds = Array.from(new Set(input.hostIds.map((id) => Number(id)).filter((id) => id > 0)));
        const onlineHosts: any[] = [];
        for (const hostId of uniqueHostIds) {
          const host = await db.getHostById(hostId);
          if (!host) {
            missing.push(hostId);
            continue;
          }
          if (!(host as any).isOnline) {
            skippedOffline += 1;
            continue;
          }
          onlineHosts.push(host);
        }
        if (onlineHosts.length > 0) {
          await assertAgentReleaseAssetsReady(targetVersion);
        }
        for (const host of onlineHosts) {
          const currentVersion = normalizeVersion((host as any).agentVersion);
          if (currentVersion && isAgentVersionAtLeast(currentVersion, targetVersion)) {
            skippedLatest += 1;
            continue;
          }
          appendPanelLog("info", `[AgentUpgrade] request host=${host.id} name=${host.name} current=${currentVersion || "-"} target=${targetVersion} batch=true`);
          await db.requestHostAgentUpgrade(host.id, targetVersion);
          requested += 1;
          if (pushAgentUpgrade(host.id, targetVersion, panelUrl)) pushed += 1;
        }
        return { success: true, requested, pushed, missing, skippedLatest, skippedOffline };
      }),
  });
