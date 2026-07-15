export type ForwardGroupRuntimeStatus = "disabled" | "idle" | "pending" | "degraded" | "running";

export type ForwardGroupRuleRuntimeStatus = {
  templateRuleId: number;
  status: ForwardGroupRuntimeStatus;
  expectedRuleCount: number;
  configuredRuleCount: number;
  runningRuleCount: number;
  failedRuleCount: number;
};

export type ForwardGroupRuntimeSummary = {
  status: ForwardGroupRuntimeStatus;
  expectedRuleCount: number;
  configuredRuleCount: number;
  runningRuleCount: number;
  failedRuleCount: number;
  ruleStatuses: ForwardGroupRuleRuntimeStatus[];
};

function enabled(value: unknown) {
  return value === true || value === 1 || value === "1" || String(value).toLowerCase() === "true";
}

function positiveId(value: unknown) {
  const id = Number(value || 0);
  return Number.isInteger(id) && id > 0 ? id : 0;
}

function normalizeGroupMode(group: any) {
  const mode = String(group?.groupMode || "").toLowerCase();
  if (mode === "port" || mode === "chain" || mode === "entry" || mode === "exit") return mode;
  return "failover";
}

function expectedChildIdentities(group: any, members: any[], entryMembers: any[]) {
  const mode = normalizeGroupMode(group);
  const activeMembers = members.filter((member) => enabled(member?.isEnabled) && positiveId(member?.id) > 0);
  if (mode === "entry" || mode === "exit") return new Set<string>();
  if (mode !== "chain") return new Set(activeMembers.map((member) => `member:${positiveId(member.id)}`));

  const identities = new Set(activeMembers.map((member) => (
    `member:${positiveId(member.id)}:host:${positiveId(member.hostId)}`
  )));
  const firstMemberId = positiveId(activeMembers[0]?.id);
  if (positiveId(group?.entryGroupId) > 0 && firstMemberId > 0) {
    for (const entryMember of entryMembers) {
      const hostId = enabled(entryMember?.isEnabled) ? positiveId(entryMember?.hostId) : 0;
      if (hostId > 0) identities.add(`member:${firstMemberId}:host:${hostId}`);
    }
  }
  return identities;
}

function childIdentity(group: any, child: any) {
  const memberId = positiveId(child?.forwardGroupMemberId);
  if (memberId <= 0) return "";
  return normalizeGroupMode(group) === "chain"
    ? `member:${memberId}:host:${positiveId(child?.hostId)}`
    : `member:${memberId}`;
}

function statusForCounts(disabled: boolean, expected: number, running: number) {
  if (disabled) return "disabled" as const;
  if (expected <= 0) return "pending" as const;
  if (running >= expected) return "running" as const;
  if (running > 0) return "degraded" as const;
  return "pending" as const;
}

export function summarizeForwardGroupRuntime(input: {
  group: any;
  members?: any[];
  entryMembers?: any[];
  templateRules?: any[];
  childRules?: any[];
}): ForwardGroupRuntimeSummary {
  const group = input.group || {};
  const members = input.members || [];
  const entryMembers = input.entryMembers || [];
  const templates = (input.templateRules || []).filter((rule) => !enabled(rule?.pendingDelete));
  const children = (input.childRules || []).filter((rule) => !enabled(rule?.pendingDelete));
  const groupDisabled = !enabled(group?.isEnabled);
  const expectedIdentities = expectedChildIdentities(group, members, entryMembers);

  const ruleStatuses = templates.map((template): ForwardGroupRuleRuntimeStatus => {
    const templateRuleId = positiveId(template?.id);
    const templateDisabled = groupDisabled || !enabled(template?.isEnabled);
    const expectedRuleCount = templateDisabled ? 0 : expectedIdentities.size;
    const matchingChildren = children.filter((rule) => positiveId(rule?.forwardGroupRuleId) === templateRuleId);
    const configuredIdentities = new Set(matchingChildren
      .map((rule) => childIdentity(group, rule))
      .filter((identity) => expectedIdentities.has(identity)));
    const runningIdentities = new Set(matchingChildren
      .filter((rule) => enabled(rule?.isEnabled) && enabled(rule?.isRunning))
      .map((rule) => childIdentity(group, rule))
      .filter((identity) => expectedIdentities.has(identity)));
    const runningRuleCount = runningIdentities.size;
    return {
      templateRuleId,
      status: statusForCounts(templateDisabled, expectedRuleCount, runningRuleCount),
      expectedRuleCount,
      configuredRuleCount: configuredIdentities.size,
      runningRuleCount,
      failedRuleCount: Math.max(0, expectedRuleCount - runningRuleCount),
    };
  });

  if (groupDisabled) {
    return {
      status: "disabled",
      expectedRuleCount: 0,
      configuredRuleCount: children.length,
      runningRuleCount: 0,
      failedRuleCount: 0,
      ruleStatuses,
    };
  }

  const activeRuleStatuses = ruleStatuses.filter((status) => status.status !== "disabled");
  if (activeRuleStatuses.length === 0) {
    return {
      status: "idle",
      expectedRuleCount: 0,
      configuredRuleCount: children.length,
      runningRuleCount: 0,
      failedRuleCount: 0,
      ruleStatuses,
    };
  }

  const expectedRuleCount = activeRuleStatuses.reduce((sum, status) => sum + status.expectedRuleCount, 0);
  const configuredRuleCount = activeRuleStatuses.reduce((sum, status) => sum + status.configuredRuleCount, 0);
  const runningRuleCount = activeRuleStatuses.reduce((sum, status) => sum + status.runningRuleCount, 0);
  const failedRuleCount = Math.max(0, expectedRuleCount - runningRuleCount);
  const status = expectedRuleCount > 0 && activeRuleStatuses.every((item) => item.status === "running")
    ? "running"
    : runningRuleCount > 0
      ? "degraded"
      : "pending";

  return {
    status,
    expectedRuleCount,
    configuredRuleCount,
    runningRuleCount,
    failedRuleCount,
    ruleStatuses,
  };
}
