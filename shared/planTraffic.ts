export type PlanTrafficMode = "both" | "outbound";

export function normalizePlanTrafficMode(value: unknown): PlanTrafficMode {
  return value === "outbound" ? "outbound" : "both";
}

/** Direction is from the forwarding listener: outbound is sent to its client. */
export function planTrafficBytes(mode: unknown, bytesIn: number, bytesOut: number) {
  const inbound = Number.isFinite(bytesIn) ? Math.max(0, bytesIn) : 0;
  const outbound = Number.isFinite(bytesOut) ? Math.max(0, bytesOut) : 0;
  return normalizePlanTrafficMode(mode) === "outbound" ? outbound : inbound + outbound;
}

export type PlanTrafficEntitlement = {
  userId: number;
  portRangeStart: number;
  portRangeEnd: number;
  portCount?: number;
  trafficMode: PlanTrafficMode;
  hostIds: number[];
  tunnelIds: number[];
  forwardGroupIds: number[];
};

export function rulePlanTrafficMode(rule: {
  userId: number; sourcePort: number; quotaSourcePort?: number;
  hostId?: number | null; tunnelId?: number | null; forwardGroupId?: number | null;
}, subscriptions: readonly PlanTrafficEntitlement[]): PlanTrafficMode {
  const port = Number(rule.quotaSourcePort ?? rule.sourcePort);
  const matches = subscriptions.filter(sub => sub.userId === Number(rule.userId)
    && (sub.portCount === 0 || (port >= sub.portRangeStart && port <= sub.portRangeEnd))
    && ((Number(rule.forwardGroupId) > 0 && sub.forwardGroupIds.includes(Number(rule.forwardGroupId)))
      || (Number(rule.tunnelId) > 0 && sub.tunnelIds.includes(Number(rule.tunnelId)))
      || (Number(rule.hostId) > 0 && sub.hostIds.includes(Number(rule.hostId)))));
  // Manual rules keep historical accounting. If old allocations overlap,
  // a one-way plan must not silently discount a matching two-way entitlement.
  return matches.length > 0 && matches.every(sub => sub.trafficMode === "outbound") ? "outbound" : "both";
}
