const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
const STATUS_ORDER_CACHE_MAX_SIZE = 20_000;
const STATUS_ORDER_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export function normalizeAgentStatusIssuedAt(value: unknown, now = Date.now()) {
  const issuedAt = Number(value || 0);
  if (!Number.isFinite(issuedAt) || issuedAt <= 0 || issuedAt > now + MAX_FUTURE_SKEW_MS) return 0;
  return Math.floor(issuedAt);
}

export function agentStatusOrderingKey(hostIdValue: unknown, payload: Record<string, any>) {
  const hostId = Number(hostIdValue || 0);
  const statusType = String(payload?.statusType || (Number(payload?.ruleId) > 0 ? "rule" : "tunnel"));
  const resourceId = statusType === "runtime"
    ? String(payload?.forwardType || "runtime")
    : statusType === "tunnel"
      ? Number(payload?.tunnelId || 0)
      : Number(payload?.ruleId || 0);
  return `agent-status:${hostId}:${statusType}:${resourceId}`;
}

export class AgentStatusOrderGuard {
  private readonly latest = new Map<string, { issuedAt: number; seenAt: number }>();

  accept(key: string, value: unknown, now = Date.now()) {
    const issuedAt = normalizeAgentStatusIssuedAt(value, now);
    if (!key || issuedAt <= 0) return true;
    const current = this.latest.get(key);
    if (current && issuedAt < current.issuedAt) return false;
    this.expect(key, issuedAt, now);
    return true;
  }

  expect(key: string, value: unknown, now = Date.now()) {
    const issuedAt = normalizeAgentStatusIssuedAt(value, now);
    if (!key || issuedAt <= 0) return;
    const current = this.latest.get(key);
    this.latest.set(key, { issuedAt: Math.max(issuedAt, current?.issuedAt || 0), seenAt: now });
    if (this.latest.size > STATUS_ORDER_CACHE_MAX_SIZE) this.prune(now);
  }

  clear() {
    this.latest.clear();
  }

  private prune(now: number) {
    for (const [key, value] of this.latest) {
      if (now - value.seenAt > STATUS_ORDER_CACHE_TTL_MS) this.latest.delete(key);
    }
  }
}

export const agentStatusOrderGuard = new AgentStatusOrderGuard();
