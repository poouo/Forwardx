export type RuleTrafficMode = "outbound" | "both" | "max";

/** Legacy per-rule policies were admin-only before the explicit ownership flag. */
export function isAdminManagedRule(rule: any): boolean {
  return rule?.adminManaged === true || rule?.adminManaged === 1
    || Number(rule?.rateLimitMbps) > 0 || Number(rule?.trafficLimit) > 0 || !!rule?.expiresAt;
}

export function assertRuleWritable(actor: { id: number; role: string }, rule: any) {
  if (actor.role === "admin") return;
  if (Number(rule?.userId) !== actor.id) throw new Error("无权操作此规则");
  if (isAdminManagedRule(rule)) throw new Error("管理员自定义规则仅可查看，请联系管理员修改");
}

export function ruleTrafficUsed(mode: unknown, bytesIn: number, bytesOut: number): number {
  const inbound = Math.max(0, Number(bytesIn) || 0);
  const outbound = Math.max(0, Number(bytesOut) || 0);
  if (mode === "outbound") return outbound;
  if (mode === "max") return Math.max(inbound, outbound);
  return inbound + outbound;
}

export function ruleLimitReason(rule: { expiresAt?: unknown; trafficLimit?: unknown; trafficMode?: unknown },
  traffic: { bytesIn: number; bytesOut: number } = { bytesIn: 0, bytesOut: 0 }, now = Date.now()): "expired" | "traffic_limit" | null {
  // createdAt is descriptive metadata, not a scheduled activation time.
  if (rule.expiresAt && new Date(rule.expiresAt as string).getTime() <= now) return "expired";
  const limit = Number(rule.trafficLimit || 0);
  return limit > 0 && ruleTrafficUsed(rule.trafficMode, traffic.bytesIn, traffic.bytesOut) >= limit ? "traffic_limit" : null;
}
