import { protectedProcedure, adminProcedure, router } from "../_core/trpc";
import { z } from "zod";
import { nanoid } from "nanoid";
import * as db from "../db";
import { markHostMetricsWatching, pushAgentRefresh, pushAgentUpgrade } from "../agentEvents";
import { requireHostAccess } from "./helpers";
import { AGENT_VERSION, APP_VERSION, REPO_URL } from "../_core/systemRouter";

const AGENT_UPGRADE_ASSET_NAMES = [
  "forwardx-agent-linux-amd64",
  "forwardx-agent-linux-arm64",
  "forwardx-fxp-linux-amd64",
  "forwardx-fxp-linux-arm64",
];
const HOST_UPGRADE_CLEANUP_INTERVAL_MS = 60 * 1000;

let lastHostUpgradeCleanupAt = 0;
let hostUpgradeCleanupRunning = false;

function normalizeVersion(version: string | null | undefined) {
  return String(version || "").trim().replace(/^v/i, "");
}

function githubRepoParts(repoUrl: string) {
  const match = repoUrl.match(/github\.com\/([^/]+)\/([^/#?]+)/i);
  if (!match) throw new Error("GitHub 仓库地址格式不正确");
  return { owner: match[1], repo: match[2].replace(/\.git$/i, "") };
}

async function assertAgentReleaseAssetsReady(agentVersion: string, releaseVersion = APP_VERSION) {
  const normalizedAgentVersion = normalizeVersion(agentVersion);
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
    throw new Error(`无法验证 Release ${tag} 的 Agent 资产：${res.status} ${res.statusText}`);
  }
  const release = await res.json() as { assets?: Array<{ name?: string; state?: string; size?: number }> };
  const assets = new Map((release.assets || []).map((asset) => [asset.name || "", asset]));
  const missing = AGENT_UPGRADE_ASSET_NAMES.filter((name) => {
    const asset = assets.get(name);
    return !asset || asset.state !== "uploaded" || Number(asset.size || 0) <= 0;
  });
  if (missing.length > 0) {
    throw new Error(`Agent v${normalizedAgentVersion} 所需的 Release ${tag} 资产还未构建完成，请稍后再试：${missing.join(", ")}`);
  }
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
      if (isAdmin) return db.getHosts();
      // 普通用户：返回自己创建的主机 + 普通授权主机 + 已授权的流量计费主机
      const [allowedHostIds, billingResourceIds] = await Promise.all([
        db.getUserAllowedHostIds(ctx.user.id),
        db.getUserUsableTrafficBillingResourceIds(ctx.user.id),
      ]);
      const allHosts = await db.getHosts();
      const allowedSet = new Set([...allowedHostIds, ...billingResourceIds.hostIds]);
      return allHosts.filter(h => allowedSet.has(h.id) || h.userId === ctx.user.id);
    }),
    /** 获取所有主机列表（管理员用，用于权限分配） */
    listAll: adminProcedure.query(async () => {
      return db.getHosts();
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
        ip: z.string().min(1).max(64),
        hostType: z.enum(["master", "slave"]).default("slave"),
        networkInterface: z.string().max(32).optional(),
        entryIp: z.string().max(128).nullable().optional(),
        tunnelEntryIp: z.string().max(128).nullable().optional(),
        portRangeStart: z.number().int().min(1).max(65535).nullable().optional(),
        portRangeEnd: z.number().int().min(1).max(65535).nullable().optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        // 验证端口区间
        if (input.portRangeStart != null && input.portRangeEnd != null) {
          if (input.portRangeStart > input.portRangeEnd) {
            throw new Error("端口区间起始值不能大于结束值");
          }
        }
        const agentToken = nanoid(32);
        const id = await db.createHost({
          ...input,
          agentToken,
          networkInterface: input.networkInterface || null,
          tunnelEntryIp: input.tunnelEntryIp || null,
          portRangeStart: input.portRangeStart ?? null,
          portRangeEnd: input.portRangeEnd ?? null,
          userId: ctx.user.id,
        });
        return { id, agentToken };
      }),
    update: protectedProcedure
      .input(z.object({
        id: z.number(),
        name: z.string().min(1).max(128).optional(),
        ip: z.string().min(1).max(64).optional(),
        hostType: z.enum(["master", "slave"]).optional(),
        networkInterface: z.string().max(32).nullable().optional(),
        entryIp: z.string().max(128).nullable().optional(),
        tunnelEntryIp: z.string().max(128).nullable().optional(),
        portRangeStart: z.number().int().min(1).max(65535).nullable().optional(),
        portRangeEnd: z.number().int().min(1).max(65535).nullable().optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        const host = await db.getHostById(input.id);
        if (!host) throw new Error("主机不存在");
        if (ctx.user.role !== "admin" && host.userId !== ctx.user.id) throw new Error("无权操作此主机");
        // 验证端口区间
        const pStart = input.portRangeStart !== undefined ? input.portRangeStart : (host as any).portRangeStart;
        const pEnd = input.portRangeEnd !== undefined ? input.portRangeEnd : (host as any).portRangeEnd;
        if (pStart != null && pEnd != null && pStart > pEnd) {
          throw new Error("端口区间起始值不能大于结束值");
        }
        const { id, ...data } = input;
        await db.updateHost(id, data as any);
        return { success: true };
      }),
    delete: protectedProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input, ctx }) => {
        const host = await db.getHostById(input.id);
        if (!host) throw new Error("主机不存在");
        if (ctx.user.role !== "admin" && host.userId !== ctx.user.id) throw new Error("无权操作此主机");
        // 检查是否存在转发规则
        const ruleCount = await db.getHostRuleCount(input.id);
        if (ruleCount > 0) {
          throw new Error(`该主机下还有 ${ruleCount} 条转发规则，请先删除所有规则后再删除主机`);
        }
        await db.deleteHostPermissions(input.id);
        await db.deleteHost(input.id);
        return { success: true };
      }),
    metrics: protectedProcedure
      .input(z.object({ hostId: z.number(), limit: z.number().default(60) }))
      .query(async ({ input, ctx }) => {
        await requireHostAccess(ctx, input.hostId);
        return db.getLatestHostMetrics(input.hostId, input.limit);
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
        await assertAgentReleaseAssetsReady(targetVersion);
        await db.requestHostAgentUpgrade(input.hostId, targetVersion);
        const configuredPanelUrl = (await db.getSetting("panelPublicUrl")) || "";
        const panelUrl = /^https?:\/\//.test(configuredPanelUrl) ? configuredPanelUrl.replace(/\/+$/, "") : "";
        const pushed = pushAgentUpgrade(input.hostId, targetVersion, panelUrl);
        return { success: true, pushed };
      }),
  });
