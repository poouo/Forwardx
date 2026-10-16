import { hostTrafficExcluded, hostPolicyBool as enabled } from "../shared/hostTrafficPolicy";
import { parsePortEntrySyncDiagnostic, parseRuleRuntimeDiagnostic } from "../shared/portEntryDiagnostics";
import type { PortEntryNodeRuntime, PortEntryRuntimeSummary } from "../shared/portEntryDiagnostics";

export function summarizePortEntryRuntime(input: {group: any; members: any[]; templates: any[]; children: any[]; dependencyEnabled?: boolean}): PortEntryRuntimeSummary {
  const disabled = !enabled(input.group?.isEnabled) || input.dependencyEnabled === false;
  const templates = input.templates.filter((rule) => enabled(rule.isEnabled) && !enabled(rule.pendingDelete));
  const templateIds = new Set(templates.map((rule) => Number(rule.id)));
  const childrenByMember = new Map<string, any[]>();
  for (const child of input.children) {
    if (enabled(child.pendingDelete) || !templateIds.has(Number(child.forwardGroupRuleId))) continue;
    const key = `${Number(child.forwardGroupMemberId)}:${Number(child.hostId)}`;
    const rows = childrenByMember.get(key) || [];
    rows.push(child);
    childrenByMember.set(key, rows);
  }
  const nodes = input.members.filter((member) => member.memberType === "host" && Number(member.hostId) > 0).map((member) => {
    const hostId = Number(member.hostId);
    const nodeDisabled = disabled || !enabled(member.isEnabled);
    const expectedRuleCount = nodeDisabled ? 0 : templateIds.size;
    const children = childrenByMember.get(`${Number(member.id)}:${hostId}`) || [];
    const running = new Set(children.filter((child) => enabled(child.isEnabled) && enabled(child.isRunning)).map((child) => Number(child.forwardGroupRuleId)));
    const runningRuleCount = nodeDisabled ? 0 : running.size;
    const configured = new Set(children.map((child) => Number(child.forwardGroupRuleId)));
    const syncDiagnostic = nodeDisabled ? null : parsePortEntrySyncDiagnostic(member.syncDiagnostic);
    const runtimeErrors = children.filter((child) => !enabled(child.isRunning) && enabled(child.isEnabled))
      .map((child) => ({ ruleId:Number(child.forwardGroupRuleId), runtimeRuleId:Number(child.id), ...parseRuleRuntimeDiagnostic(child.runtimeDiagnostic) }))
      .filter((error) => !!error.message).sort((a,b) => Number(b.reportedAt || 0)-Number(a.reportedAt || 0)).slice(0,3);
    const online = enabled(member.host?.isOnline);
    const excluded = hostTrafficExcluded(member.host);
    const status: PortEntryNodeRuntime["status"] = nodeDisabled ? "disabled" : expectedRuleCount === 0 ? "idle"
      : excluded ? "excluded" : !online ? "offline" : runningRuleCount === expectedRuleCount && !syncDiagnostic ? "running"
        : runningRuleCount > 0 ? "degraded" : "pending";
    return {memberId:Number(member.id),hostId,hostName:String(member.host?.name || ""),status,online,
      expectedRuleCount,runningRuleCount,configuredRuleCount:configured.size,
      syncDiagnostic,runtimeErrors};
  });
  return { expectedHostCount:nodes.filter((node) => node.status !== "disabled").length,
    runningHostCount:nodes.filter((node) => node.status === "running").length,nodes };
}
