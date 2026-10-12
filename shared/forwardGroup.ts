/** Maximum members for group modes that expand into an ordered host chain. */
export const MAX_FORWARD_GROUP_MEMBERS = 20;

/** Current failover route first; chain ordering must remain unchanged. */
export function forwardGroupRouteMembers(group: any): any[] {
  const activeId = Number(group?.activeMemberId || 0);
  const mode = String(group?.groupMode || "failover");
  return [...(group?.members || [])]
    .filter((member: any) => ![false, 0, "0", "false"].includes(member.isEnabled))
    .sort((left: any, right: any) => {
      if (mode !== "chain" && activeId > 0) {
        const activeOrder = Number(Number(right.id) === activeId) - Number(Number(left.id) === activeId);
        if (activeOrder) return activeOrder;
      }
      if (mode !== "chain" && !activeId) {
        const onlineOrder = Number(right.host?.isOnline === true) - Number(left.host?.isOnline === true);
        if (onlineOrder) return onlineOrder;
      }
      return Number(left.priority || 0) - Number(right.priority || 0) || Number(left.id || 0) - Number(right.id || 0);
    });
}

/** A completed/pending test describes its own route, not today's active member. */
export function forwardGroupSelfTestSource(test: { requestMessage?: unknown; hostId?: unknown } | null | undefined) {
  try {
    const request = JSON.parse(String(test?.requestMessage || ""));
    const hostId = Number(test?.hostId || 0);
    if (request?.kind !== "forward-group" || !Number.isInteger(hostId) || hostId <= 0) return null;
    return {
      hostId,
      label: String(request.sourceLabel || `主机 #${hostId}`),
      targetLabel: String(request.targetLabel || ""),
    };
  } catch { return null; }
}
