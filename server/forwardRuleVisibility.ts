function positiveId(value: unknown) {
  const id = Number(value || 0);
  return Number.isInteger(id) && id > 0 ? id : 0;
}

export function isManagedForwardGroupChildRule(rule: any) {
  return positiveId(rule?.forwardGroupRuleId) > 0 || positiveId(rule?.forwardGroupMemberId) > 0;
}

export function filterForwardRulesForUserSurface<T>(rules: T[]) {
  return rules.filter((rule) => !isManagedForwardGroupChildRule(rule));
}

export function gateForwardRulesForUserSurface<T extends Record<string, any>>(
  rules: T[],
  hasResourceAccess: (rule: T) => boolean,
) {
  return filterForwardRulesForUserSurface(rules).map((rule) => {
    if (hasResourceAccess(rule)) return rule;
    return {
      ...rule,
      isEnabled: false,
      resourceAccessAllowed: false,
      resourceAccessDenied: true,
    };
  });
}
