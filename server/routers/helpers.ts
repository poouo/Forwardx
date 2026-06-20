import * as db from "../db";
import { pushAgentRefresh } from "../agentEvents";
import { appendPanelLog } from "../_core/panelLogger";

export function ensureAdminOrSelf(ctx: { user: { id: number; role: string } }, userId: number) {
  if (ctx.user.role !== "admin" && ctx.user.id !== userId) {
    throw new Error("无权访问该用户的数据");
  }
}

export async function requireHostAccess(ctx: { user: { id: number; role: string } }, hostId: number) {
  const host = await db.getHostById(hostId);
  if (!host) throw new Error("主机不存在");
  if (ctx.user.role !== "admin" && host.userId !== ctx.user.id) {
    const hasPermission = await db.checkUserHostPermission(ctx.user.id, host.id);
    if (!hasPermission) throw new Error("无权访问该主机");
  }
  return host;
}

export async function requireRuleAccess(ctx: { user: { id: number; role: string } }, ruleId: number) {
  const rule = await db.getForwardRuleById(ruleId);
  if (!rule) throw new Error("规则不存在");
  if (ctx.user.role !== "admin" && rule.userId !== ctx.user.id) {
    throw new Error("无权访问该规则");
  }
  return rule;
}

export async function requireTunnelAccess(ctx: { user: { id: number; role: string } }, tunnelId: number) {
  const tunnel = await db.getTunnelById(tunnelId);
  if (!tunnel) throw new Error("隧道不存在");
  if (ctx.user.role !== "admin" && tunnel.userId !== ctx.user.id) {
    throw new Error("无权访问该隧道");
  }
  return tunnel;
}

export async function requireTunnelUseAccess(ctx: { user: { id: number; role: string } }, tunnelId: number) {
  const tunnel = await db.getTunnelById(tunnelId);
  if (!tunnel) throw new Error("隧道不存在");
  if (ctx.user.role !== "admin" && tunnel.userId !== ctx.user.id) {
    const hasPermission = await db.checkUserTunnelPermission(ctx.user.id, tunnel.id);
    if (!hasPermission) throw new Error("无权使用该隧道");
  }
  return tunnel;
}

export async function requireTrafficBillingAccessIfConfigured(
  ctx: { user: { id: number; role: string } },
  resourceType: "host" | "tunnel",
  resourceId: number,
) {
  if (ctx.user.role === "admin") return false;
  if (!(await db.isTrafficBillingEnabled())) return false;
  const config = await db.findTrafficBillingConfig(resourceType, resourceId);
  if (!config) return false;
  const hasPermission = await db.checkUserTrafficBillingPermission(ctx.user.id, resourceType, resourceId);
  if (!hasPermission) {
    throw new Error(resourceType === "host"
      ? "您没有使用该主机流量计费资源的权限，请联系管理员授权"
      : "您没有使用该隧道流量计费资源的权限，请联系管理员授权");
  }
  return true;
}

export async function requireHostUseAccess(ctx: { user: { id: number; role: string } }, hostId: number) {
  const host = await db.getHostById(hostId);
  if (!host) throw new Error("主机不存在");
  const isTrafficBillingResource = await requireTrafficBillingAccessIfConfigured(ctx, "host", host.id);
  if (ctx.user.role !== "admin" && !isTrafficBillingResource && host.userId !== ctx.user.id) {
    const hasPermission = await db.checkUserHostPermission(ctx.user.id, host.id);
    if (!hasPermission) throw new Error("您没有使用该主机的权限，请联系管理员授权");
  }
  return { host, isTrafficBillingResource };
}

export async function requireTunnelUseOrTrafficBillingAccess(ctx: { user: { id: number; role: string } }, tunnelId: number) {
  const tunnel = await db.getTunnelById(tunnelId);
  if (!tunnel) throw new Error("隧道不存在");
  const isTrafficBillingResource = await requireTrafficBillingAccessIfConfigured(ctx, "tunnel", tunnel.id);
  if (ctx.user.role !== "admin" && !isTrafficBillingResource && tunnel.userId !== ctx.user.id) {
    const hasPermission = await db.checkUserTunnelPermission(ctx.user.id, tunnel.id);
    if (!hasPermission) throw new Error("无权使用该隧道");
  }
  return { tunnel, isTrafficBillingResource };
}

export async function pushTunnelEndpointRefresh(tunnel: any, reason: string) {
  const hopRows = tunnel?.id ? await db.getTunnelHops(Number(tunnel.id)) : [];
  const extraExitRows = tunnel?.id ? await db.getTunnelExitNodes(Number(tunnel.id)) : [];
  const hopHostIds = Array.isArray(hopRows)
    ? hopRows.map((hop: any) => Number(hop.hostId)).filter((id: number) => Number.isFinite(id) && id > 0)
    : [];
  const extraExitHostIds = Array.isArray(extraExitRows)
    ? extraExitRows.map((exit: any) => Number(exit.hostId)).filter((id: number) => Number.isFinite(id) && id > 0)
    : [];
  const hostIds = [
    ...(hopHostIds.length >= 3
    ? hopHostIds
    : [Number(tunnel.entryHostId), Number(tunnel.exitHostId)].filter((id) => Number.isFinite(id) && id > 0)),
    ...extraExitHostIds,
  ];
  const uniqueHostIds = Array.from(new Set(hostIds));
  const pushed = uniqueHostIds.map((hostId) => ({
    hostId,
    pushed: pushAgentRefresh(hostId, `${reason}-host-${hostId}`),
  }));
  const allPushed = pushed.every((item) => item.pushed);
  appendPanelLog(
    allPushed ? "info" : "warn",
    `[Tunnel] refresh tunnel=${tunnel.id} reason=${reason} hosts=${pushed.map((item) => `${item.hostId}:${item.pushed}`).join(",") || "-"}`,
  );
  return {
    entryPushed: pushed.some((item) => item.hostId === Number(tunnel.entryHostId) && item.pushed),
    exitPushed: pushed.some((item) => item.hostId === Number(tunnel.exitHostId) && item.pushed),
    hostPushed: pushed,
  };
}

export async function refreshUserForwardEndpoints(userId: number, reason: string) {
  const rules = await db.getForwardRulesForUserSync(userId);
  const hostIds = new Set<number>();
  const tunnelIds = new Set<number>();
  for (const rule of rules as any[]) {
    hostIds.add(Number(rule.hostId));
    if (rule.tunnelId) tunnelIds.add(Number(rule.tunnelId));
  }
  for (const hostId of hostIds) {
    if (hostId > 0) pushAgentRefresh(hostId, reason);
  }
  for (const tunnelId of tunnelIds) {
    const tunnel = await db.getTunnelById(tunnelId);
    if (!tunnel) continue;
    await db.updateTunnel(tunnelId, { isRunning: false } as any);
    await pushTunnelEndpointRefresh(tunnel, reason);
  }
}

export function maskToken(token: string) {
  if (!token) return "";
  if (token.length <= 12) return `${token.slice(0, 4)}...`;
  return `${token.slice(0, 8)}...${token.slice(-4)}`;
}
