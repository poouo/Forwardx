export type PortEntrySyncDiagnostic = {
  attempts: number;
  failedRuleCount: number;
  firstFailedAt: number;
  lastFailedAt: number;
  nextRetryAt: number;
  errors: Array<{ ruleId: number; message: string }>;
};

export type RuleRuntimeDiagnostic = {
  message: string;
  reportedAt: number;
  consecutiveFailures: number | null;
  retryNotBefore: number | null;
};

export type PortEntryNodeRuntime = {
  memberId:number; hostId:number; hostName:string;
  status:"disabled" | "idle" | "excluded" | "offline" | "running" | "degraded" | "pending";
  online:boolean; expectedRuleCount:number; runningRuleCount:number; configuredRuleCount:number;
  syncDiagnostic:PortEntrySyncDiagnostic | null;
  runtimeErrors:Array<Partial<RuleRuntimeDiagnostic> & {ruleId:number;runtimeRuleId:number}>;
};

export type PortEntryRuntimeSummary = {expectedHostCount:number;runningHostCount:number;nodes:PortEntryNodeRuntime[]};

function object(value: unknown): any {
  try {
    const item = typeof value === "string" ? JSON.parse(value) : value;
    return item && typeof item === "object" && !Array.isArray(item) ? item : null;
  } catch { return null; }
}

export function parsePortEntrySyncDiagnostic(value: unknown): PortEntrySyncDiagnostic | null {
  const item = object(value);
  if (!item || !Number.isSafeInteger(item.attempts) || item.attempts < 1
    || !Number.isSafeInteger(item.failedRuleCount) || item.failedRuleCount < 1
    || !Number.isFinite(item.firstFailedAt) || !Number.isFinite(item.lastFailedAt) || !Number.isFinite(item.nextRetryAt)) return null;
  return {
    attempts: Math.min(item.attempts, 1_000_000), failedRuleCount: item.failedRuleCount,
    firstFailedAt: item.firstFailedAt, lastFailedAt: item.lastFailedAt, nextRetryAt: item.nextRetryAt,
    errors: Array.isArray(item.errors) ? item.errors.slice(0, 3).map((error: any) => ({ruleId:Number(error?.ruleId) || 0,message:String(error?.message || "").slice(0,500)})) : [],
  };
}

export function nextPortEntrySyncDiagnostic(previous: unknown, errors: Array<{ruleId: number; message: string}>, now: number): PortEntrySyncDiagnostic | null {
  if (!errors.length) return null;
  const before = parsePortEntrySyncDiagnostic(previous);
  return {
    attempts: Math.min(1_000_000, (before?.attempts || 0) + 1),
    failedRuleCount: errors.length,
    firstFailedAt: before?.firstFailedAt || now,
    lastFailedAt: now,
    nextRetryAt: now + 60_000,
    errors: errors.slice(0, 3).map((error) => ({ruleId:error.ruleId,message:error.message.slice(0,500)})),
  };
}

export function parseRuleRuntimeDiagnostic(value: unknown): RuleRuntimeDiagnostic | null {
  const item = object(value);
  if (!item || typeof item.message !== "string" || !Number.isFinite(item.reportedAt)) return null;
  return {
    message: item.message.slice(0, 500), reportedAt: item.reportedAt,
    consecutiveFailures: Number.isSafeInteger(item.consecutiveFailures) && item.consecutiveFailures > 0 ? Math.min(item.consecutiveFailures,1_000_000) : null,
    retryNotBefore: Number.isFinite(item.retryNotBefore) && item.retryNotBefore > 0 ? item.retryNotBefore : null,
  };
}
