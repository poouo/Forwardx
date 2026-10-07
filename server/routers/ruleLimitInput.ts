import { z } from "zod";
import * as db from "../db";
import { isAgentVersionAtLeast } from "../agentRouteUtils";

export const ruleLimitInputShape = {
  rateLimitMbps: z.number().int().min(0).max(1_000_000).optional(),
  trafficLimit: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  trafficMode: z.enum(["outbound", "both", "max"]).optional(),
  createdAt: z.coerce.date().optional(),
  expiresAt: z.coerce.date().nullable().optional(),
};
export function ruleLimitPatch(input: Record<string, any>) {
  return Object.fromEntries([...Object.keys(ruleLimitInputShape), "adminManaged"]
    .filter(key => input[key] !== undefined).map(key => [key, input[key]]));
}
export function hasRuleLimitInput(input: Record<string, any>) {
  return Object.keys(ruleLimitInputShape).some(key => input[key] !== undefined);
}
export function validateRuleLimitInput(role: string, input: Record<string, any>, existing?: Record<string, any>) {
  if (hasRuleLimitInput(input) && role !== "admin") throw new Error("仅管理员可修改单条规则的限额和有效期");
  const createdAt = input.createdAt ?? existing?.createdAt ?? new Date();
  const expiresAt = input.expiresAt !== undefined ? input.expiresAt : existing?.expiresAt;
  if (expiresAt && new Date(expiresAt).getTime() <= new Date(createdAt).getTime()) {
    throw new Error("到期时间必须晚于创建时间");
  }
}

export async function validateRuleRateLimitTargets(rule: Record<string, any>) {
  if (!(Number(rule.rateLimitMbps) > 0)) return;
  let hostIds: number[] = [];
  if (rule.forwardGroupId) hostIds = await db.getForwardGroupRuleEntryHostIds(Number(rule.forwardGroupId));
  else if (rule.tunnelId) {
    const tunnel = await db.getTunnelById(Number(rule.tunnelId));
    if (tunnel?.entryGroupId) hostIds = await db.getForwardGroupRuleEntryHostIds(Number(tunnel.entryGroupId));
    else if (tunnel) hostIds = [Number(tunnel.entryHostId)];
  } else if (rule.hostId) hostIds = [Number(rule.hostId)];
  for (const id of new Set(hostIds)) {
    const host = await db.getHostById(id);
    if (!isAgentVersionAtLeast(host?.agentVersion, "2.2.187")) throw new Error("单条规则限速需要入口 Agent 2.2.187 或以上，请先升级 Agent");
  }
}
