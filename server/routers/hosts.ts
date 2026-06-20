import { protectedProcedure, adminProcedure, router } from "../_core/trpc";
import { z } from "zod";
import { nanoid } from "nanoid";
import * as db from "../db";
import { markHostMetricsWatching, pushAgentRefresh, pushAgentUpgrade } from "../agentEvents";
import { AGENT_ASSET_NAMES, getMissingBundledAgentAssets } from "../agentAssets";
import { pushTunnelEndpointRefresh, requireHostAccess } from "./helpers";
import { AGENT_VERSION, APP_VERSION, REPO_URL } from "../_core/systemRouter";
import { isAgentVersionAtLeast } from "../agentRouteUtils";
import { scheduleHostGeoRefresh } from "../hostGeo";
import { refreshHostAddressRuntime } from "../hostAddressRuntime";
import { createQueryCache } from "../queryCache";
import { describePortPolicy, normalizePortAllowlist, portPolicyFrom, portPolicyHasRestriction } from "../portPolicy";

const HOST_UPGRADE_CLEANUP_INTERVAL_MS = 60 * 1000;
const GITHUB_API_LIMIT_STATUSES = new Set([403, 429]);
const hostQueryCache = createQueryCache(500);

let lastHostUpgradeCleanupAt = 0;
let hostUpgradeCleanupRunning = false;
const hostProtocolPolicyFields = ["blockHttp", "blockSocks", "blockTls"] as const;

async function refreshHostPolicyRuntime(hostId: number, reason: string) {
  const id = Number(hostId);
  if (!Number.isFinite(id) || id <= 0) return;
  await db.resetAgentRuntimeStateForHost(id);
  const tunnels = await db.getTunnelsByHost(id);
  for (const tunnel of tunnels as any[]) {
    await pushTunnelEndpointRefresh(tunnel, reason);
  }
  pushAgentRefresh(id, reason);
}

function isValidHostOrIp(value: string) {
  return /^[a-zA-Z0-9]([a-zA-Z0-9\-_.]*[a-zA-Z0-9])?$|^[a-fA-F0-9:.]+$/.test(value.trim());
}

const hostAddressSchema = z.string().trim().min(1).max(253).refine(isValidHostOrIp, "Invalid host or IP");
const optionalHostAddressSchema = z.string().trim().max(253).nullable().optional().refine(
  (value) => !value || isValidHostOrIp(value),
  "Invalid host or IP",
);
const networkInterfaceSchema = z.string().trim().max(32).nullable().optional().refine(
  (value) => !value || /^[a-zA-Z0-9_.:@-]+$/.test(value),
  "Invalid network interface",
);

const optionalDateInputSchema = z.string().trim().max(64).nullable().optional();
const hostTrafficMeasureModeSchema = z.enum(["outbound", "both"]).default("both");
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
  return value === "outbound" ? "outbound" : "both";
}

function hostTrafficConfigPayload(input: {
  purchasedAt?: string | null;
  stoppedAt?: string | null;
  trafficLimit?: number;
  trafficMeasureMode?: "outbound" | "both";
  telegramTrafficAlertEnabled?: boolean;
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
    if (host.agentUpgradeRequested && host.agentVersion && isAgentVersionAtLeast(host.agentVersion, targetVersion)) {
      completedIds.push(Number(host.id));
      return {
        ...host,
        agentUpgradeRequested: false,
        agentUpgradeTargetVersion: null,
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

export const hostsRouter = router({
    list: protectedProcedure.query(async ({ ctx }) => {
      const isAdmin = ctx.user.role === "admin";
      if (isAdmin) scheduleStaleHostUpgradeCleanup();
      if (isAdmin) {
        const hosts = await getHostsWithUpgradeStateCleanup();
        scheduleHostGeoRefresh(hosts);
        return hosts;
      }
      // 普通用户：返回自己创建的主机 + 普通授权主机 + 已授权的流量计费主机
      const [allowedHostIds, billingResourceIds] = await Promise.all([
        db.getUserAllowedHostIds(ctx.user.id),
        db.getUserUsableTrafficBillingResourceIds(ctx.user.id),
      ]);
      const allHosts = await getHostsWithUpgradeStateCleanup();
      const allowedSet = new Set([...allowedHostIds, ...billingResourceIds.hostIds]);
      const visibleHosts = allHosts.filter((h: any) => allowedSet.has(h.id) || h.userId === ctx.user.id);
      scheduleHostGeoRefresh(visibleHosts);
      return visibleHosts;
    }),
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
      .input(z.object({ serviceIds: z.array(z.number().int().positive()).max(200).optional(), hostId: z.number().int().positive().optional(), hours: z.number().int().min(1).max(24 * 30).default(24) }).optional())
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
        return host;
      }),
    create: protectedProcedure
      .input(z.object({
        name: z.string().min(1).max(128),
        ip: hostAddressSchema,
        hostType: z.enum(["master", "slave"]).default("slave"),
        networkInterface: networkInterfaceSchema,
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
        trafficAutoReset: z.boolean().optional(),
        trafficResetDay: z.number().int().min(1).max(31).optional(),
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
          : { purchasedAt: null, stoppedAt: null, trafficLimit: 0, trafficMeasureMode: "both", telegramTrafficAlertEnabled: false, trafficAutoReset: false, trafficResetDay: 1 };
        const id = await db.createHost({
          ...input,
          ...trafficConfig,
          agentToken,
          networkInterface: input.networkInterface || null,
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
    update: protectedProcedure
      .input(z.object({
        id: z.number(),
        name: z.string().min(1).max(128).optional(),
        ip: hostAddressSchema.optional(),
        hostType: z.enum(["master", "slave"]).optional(),
        networkInterface: networkInterfaceSchema,
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
        trafficAutoReset: z.boolean().optional(),
        trafficResetDay: z.number().int().min(1).max(31).optional(),
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
        if (data.networkInterface !== undefined) data.networkInterface = data.networkInterface || null;
        if (data.entryIp !== undefined) data.entryIp = data.entryIp || null;
        if (data.tunnelEntryIp !== undefined) data.tunnelEntryIp = data.tunnelEntryIp || null;
        if ((data as any).portAllowlist !== undefined) (data as any).portAllowlist = nextPortAllowlist || null;
        if (ctx.user.role === "admin") {
          const hasTrafficConfigInput = ["purchasedAt", "stoppedAt", "trafficLimit", "trafficMeasureMode", "telegramTrafficAlertEnabled", "trafficAutoReset", "trafficResetDay"].some((key) => (data as any)[key] !== undefined);
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
            if ((data as any).trafficAutoReset !== undefined) (data as any).trafficAutoReset = !!(data as any).trafficAutoReset;
            if ((data as any).trafficResetDay !== undefined) (data as any).trafficResetDay = Math.min(31, Math.max(1, Number((data as any).trafficResetDay) || 1));
          }
        } else {
          for (const field of ["purchasedAt", "stoppedAt", "trafficLimit", "trafficMeasureMode", "telegramTrafficAlertEnabled", "trafficAutoReset", "trafficResetDay"] as const) delete (data as any)[field];
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
      .input(z.object({ hostId: z.number(), limit: z.number().default(60) }))
      .query(async ({ input, ctx }) => {
        await requireHostAccess(ctx, input.hostId);
        return hostQueryCache.get(
          `metrics:${ctx.user.id}:${input.hostId}:${input.limit}`,
          { ttlMs: 10_000, staleMs: 60_000 },
          () => db.getLatestHostMetrics(input.hostId, input.limit),
        );
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
          return db.getHostTrafficSummary(hostIds);
        }
        return db.getHostTrafficSummary();
      }),
    resetTraffic: adminProcedure
      .input(z.object({ hostId: z.number() }))
      .mutation(async ({ input }) => {
        const host = await db.getHostById(input.hostId);
        if (!host) throw new Error("主机不存在");
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
        markHostMetricsWatching(allowed);
        for (const hostId of allowed) pushAgentRefresh(hostId, "metrics-watch");
        return { success: true, count: allowed.length };
      }),
    requestAgentUpgrade: adminProcedure
      .input(z.object({ hostId: z.number(), targetVersion: z.string().max(64).nullable().optional() }))
      .mutation(async ({ input }) => {
        const host = await db.getHostById(input.hostId);
        if (!host) throw new Error("主机不存在");
        const targetVersion = normalizeVersion(input.targetVersion || AGENT_VERSION);
        const currentVersion = normalizeVersion((host as any).agentVersion);
        if (currentVersion && isAgentVersionAtLeast(currentVersion, targetVersion)) {
          return { success: true, pushed: false, alreadyLatest: true };
        }
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
        await assertAgentReleaseAssetsReady(targetVersion);
        const configuredPanelUrl = (await db.getSetting("panelPublicUrl")) || "";
        const panelUrl = /^https?:\/\//.test(configuredPanelUrl) ? configuredPanelUrl.replace(/\/+$/, "") : "";
        let requested = 0;
        let pushed = 0;
        let skippedLatest = 0;
        const missing: number[] = [];
        const uniqueHostIds = Array.from(new Set(input.hostIds.map((id) => Number(id)).filter((id) => id > 0)));
        for (const hostId of uniqueHostIds) {
          const host = await db.getHostById(hostId);
          if (!host) {
            missing.push(hostId);
            continue;
          }
          const currentVersion = normalizeVersion((host as any).agentVersion);
          if (currentVersion && isAgentVersionAtLeast(currentVersion, targetVersion)) {
            skippedLatest += 1;
            continue;
          }
          await db.requestHostAgentUpgrade(hostId, targetVersion);
          requested += 1;
          if (pushAgentUpgrade(hostId, targetVersion, panelUrl)) pushed += 1;
        }
        return { success: true, requested, pushed, missing, skippedLatest };
      }),
  });
