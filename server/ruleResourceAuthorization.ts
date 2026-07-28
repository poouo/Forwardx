import { pushAgentRefresh } from "./agentEvents";
import * as db from "./db";
import { mapWithConcurrency } from "./asyncPool";
import { canUseForwardRuleResource, getLinkAccessScope, type LinkAccessScope } from "./linkAccessView";
import { pushTunnelEndpointRefresh } from "./routers/helpers";

export const RULE_RESOURCE_AUTHORIZATION_REVOKED_REASON = "资源授权已失效，请编辑规则并选择当前有权限的端口转发或隧道";

function positiveId(value: unknown) {
  const id = Number(value || 0);
  return Number.isInteger(id) && id > 0 ? id : 0;
}

function dbBool(value: unknown, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return value === true || value === 1 || value === "1" || String(value).trim().toLowerCase() === "true";
}

async function loadRuleResourceAccess(userId: number): Promise<LinkAccessScope | null> {
  const user = await db.getUserById(userId);
  if (!user) throw new Error("用户不存在");
  return getLinkAccessScope({ id: Number(user.id), role: String(user.role || "user") });
}

function ruleHasResourceAccess(rule: any, access: LinkAccessScope | null) {
  return canUseForwardRuleResource(rule, access);
}

/**
 * Stop, but do not delete, user-owned rules whose selected resource is no
 * longer usable. The rule stays editable so it can be moved to a new grant.
 */
export async function reconcileUserRuleResourceAuthorization(userId: number) {
  const [rules, access] = await Promise.all([
    db.getForwardRules(userId),
    loadRuleResourceAccess(userId),
  ]);
  const revokedRules = (rules as any[]).filter((rule) => !ruleHasResourceAccess(rule, access));
  const changedRules = revokedRules.filter((rule) => (
    dbBool(rule.isEnabled)
    || dbBool(rule.isRunning)
    || String(rule.protocolBlockReason || "") !== RULE_RESOURCE_AUTHORIZATION_REVOKED_REASON
  ));

  await mapWithConcurrency(changedRules, 8, async (rule) => {
    await db.updateForwardRule(Number(rule.id), {
      isEnabled: false,
      isRunning: false,
      disabledByUser: false,
      disabledByTunnel: false,
      disabledByGroup: false,
      protocolBlockReason: RULE_RESOURCE_AUTHORIZATION_REVOKED_REASON,
    } as any);
  });

  // Always resync revoked groups. A prior authorization update may have saved
  // the template before child synchronization or endpoint refresh completed.
  const groupIds = new Set(revokedRules.map((rule) => positiveId(rule.forwardGroupId)).filter(Boolean));
  const tunnelIds = new Set(changedRules
    .filter((rule) => !positiveId(rule.forwardGroupId))
    .map((rule) => positiveId(rule.tunnelId))
    .filter(Boolean));
  const hostIds = new Set(changedRules
    .filter((rule) => !positiveId(rule.forwardGroupId) && !positiveId(rule.tunnelId))
    .map((rule) => positiveId(rule.hostId))
    .filter(Boolean));

  await mapWithConcurrency(Array.from(groupIds), 4, async (groupId) => {
    await db.syncForwardGroupRules(groupId);
    await db.runForwardGroupFailover(groupId);
  });
  await mapWithConcurrency(Array.from(tunnelIds), 4, async (tunnelId) => {
    const tunnel = await db.getTunnelById(tunnelId);
    if (tunnel) await pushTunnelEndpointRefresh(tunnel, "rule-resource-authorization-revoked", { urgent: true });
  });
  for (const hostId of hostIds) {
    pushAgentRefresh(hostId, "rule-resource-authorization-revoked", { urgent: true });
  }

  return {
    disabledRuleIds: changedRules.map((rule) => Number(rule.id)),
    revokedRuleIds: revokedRules.map((rule) => Number(rule.id)),
  };
}
