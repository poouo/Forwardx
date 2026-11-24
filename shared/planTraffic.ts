export const PLAN_TRAFFIC_MODES = ["both", "outbound", "inbound_outbound"] as const;
export type PlanTrafficMode = typeof PLAN_TRAFFIC_MODES[number];

export function normalizePlanTrafficMode(value: unknown): PlanTrafficMode {
  return value === "outbound" || value === "inbound_outbound" ? value : "both";
}

/** Direction is from the forwarding listener. A two-way plan charges both legs of the relay. */
export function planTrafficBytes(mode: PlanTrafficMode | undefined, bytesIn: number, bytesOut: number) {
  const inbound = Number.isFinite(bytesIn) ? Math.max(0, bytesIn) : 0;
  const outbound = Number.isFinite(bytesOut) ? Math.max(0, bytesOut) : 0;
  if (mode === "outbound") return outbound;
  const listenerBytes = inbound + outbound;
  return mode === "both" ? 2 * listenerBytes : listenerBytes;
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
}, subscriptions: readonly PlanTrafficEntitlement[]): PlanTrafficMode | undefined {
  const port = Number(rule.quotaSourcePort ?? rule.sourcePort);
  const matches = subscriptions.filter(sub => sub.userId === Number(rule.userId)
    && (sub.portCount === 0 || (port >= sub.portRangeStart && port <= sub.portRangeEnd))
    && ((Number(rule.forwardGroupId) > 0 && sub.forwardGroupIds.includes(Number(rule.forwardGroupId)))
      || (Number(rule.tunnelId) > 0 && sub.tunnelIds.includes(Number(rule.tunnelId)))
      || (Number(rule.hostId) > 0 && sub.hostIds.includes(Number(rule.hostId)))));
  if (!matches.length) return undefined;
  // For overlapping entitlements, use the mode that counts the most traffic.
  if (matches.some(sub => sub.trafficMode === "both")) return "both";
  return matches.some(sub => sub.trafficMode === "inbound_outbound") ? "inbound_outbound" : "outbound";
}
