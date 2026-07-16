export type DashboardTrafficRuleIdentityInput = {
  name?: string | null;
  forwardGroupRuleId?: number | null;
};

export function resolveDashboardTrafficRuleIdentity(
  ruleIdValue: unknown,
  rule: DashboardTrafficRuleIdentityInput | undefined,
  templateNames: ReadonlyMap<number, string>,
) {
  const ruleId = Math.max(0, Math.trunc(Number(ruleIdValue) || 0));
  const templateRuleId = Math.max(0, Math.trunc(Number(rule?.forwardGroupRuleId) || 0));
  if (templateRuleId > 0) {
    return {
      id: templateRuleId,
      name: String(templateNames.get(templateRuleId) || "").trim() || `规则 #${templateRuleId}`,
    };
  }
  return {
    id: ruleId,
    name: String(rule?.name || "").trim() || `规则 #${ruleId}`,
  };
}
