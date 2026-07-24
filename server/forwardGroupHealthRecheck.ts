type HealthWindowMember = {
  healthy?: boolean;
  failureSince?: Date | string | number | null;
  healthySince?: Date | string | number | null;
  failedLongEnough?: boolean;
  recoveredLongEnough?: boolean;
};

export const FORWARD_GROUP_CHINA_HEALTH_FRESHNESS_TTL_MS = 8 * 60 * 1000;

export type ForwardGroupChinaHealthState = "healthy" | "unhealthy" | "pending" | "stale";

export function forwardGroupChinaHealthStateAt(member: any, nowValue = Date.now()): ForwardGroupChinaHealthState {
  const status = String(member?.chinaHealthStatus || "unknown").trim().toLowerCase();
  if (status === "unknown") return "pending";
  if (status !== "healthy" && status !== "unhealthy") return "stale";

  const now = Number(nowValue);
  const checkedAt = timestamp(member?.chinaHealthCheckedAt);
  if (!Number.isFinite(now) || checkedAt <= 0 || checkedAt > now + 60_000) return "stale";
  return now - checkedAt < FORWARD_GROUP_CHINA_HEALTH_FRESHNESS_TTL_MS ? status : "stale";
}

export function nextForwardGroupChinaHealthExpiryAt(input: {
  enabled: boolean;
  members: any[];
  now?: number;
}) {
  if (!input.enabled) return null;
  const now = Number.isFinite(input.now) ? Number(input.now) : Date.now();
  const deadlines: number[] = [];
  for (const member of input.members || []) {
    const enabled = member?.isEnabled;
    if (enabled === false || enabled === 0 || enabled === "0" || String(enabled).toLowerCase() === "false") continue;
    if (forwardGroupChinaHealthStateAt(member, now) !== "healthy") continue;
    const checkedAt = timestamp(member?.chinaHealthCheckedAt);
    deadlines.push(checkedAt + FORWARD_GROUP_CHINA_HEALTH_FRESHNESS_TTL_MS);
  }
  return deadlines.length > 0 ? Math.min(...deadlines) : null;
}

type TimerHandle = ReturnType<typeof setTimeout>;
type SetTimer = (callback: () => void, delayMs: number) => TimerHandle;
type ClearTimer = (timer: TimerHandle) => void;

const MAX_TIMER_DELAY_MS = 2_147_483_647;

function timerDelay(dueAt: number, now: number) {
  return Math.min(MAX_TIMER_DELAY_MS, Math.max(0, dueAt - now));
}

export function isActivityFreshAt(lastSeenAtValue: unknown, timeoutMsValue: unknown, nowValue = Date.now()) {
  const lastSeenAt = Number(lastSeenAtValue);
  const timeoutMs = Number(timeoutMsValue);
  const now = Number(nowValue);
  if (!Number.isFinite(lastSeenAt) || lastSeenAt <= 0) return false;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || !Number.isFinite(now)) return false;
  return now - lastSeenAt < timeoutMs;
}

type ForwardGroupEvaluationQueueOptions = {
  debounceMs?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  setTimer?: SetTimer;
  clearTimer?: ClearTimer;
  onError?: (error: unknown, retryDelayMs: number) => void;
};

export class ForwardGroupEvaluationBatchError extends Error {
  readonly retryGroupIds: number[];
  readonly errors: unknown[];

  constructor(failures: Array<{ groupId: unknown; error: unknown }>) {
    const normalized = failures
      .map((failure) => ({ groupId: Number(failure.groupId), error: failure.error }))
      .filter((failure) => Number.isInteger(failure.groupId) && failure.groupId > 0);
    const detail = normalized.map((failure) => {
      const message = failure.error instanceof Error ? failure.error.message : String(failure.error);
      return `${failure.groupId}: ${message}`;
    }).join("; ");
    super(`Forward group evaluation failed for ${detail || "unknown group"}`);
    this.name = "ForwardGroupEvaluationBatchError";
    this.retryGroupIds = Array.from(new Set(normalized.map((failure) => failure.groupId)));
    this.errors = normalized.map((failure) => failure.error);
  }
}

export class ForwardGroupEvaluationQueue {
  private readonly pending = new Set<number>();
  private readonly debounceMs: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly setTimer: SetTimer;
  private readonly clearTimer: ClearTimer;
  private readonly onError: (error: unknown, retryDelayMs: number) => void;
  private readonly retryTimers = new Map<number, TimerHandle>();
  private readonly consecutiveFailures = new Map<number, number>();
  private timer: TimerHandle | null = null;
  private running = false;

  constructor(
    private readonly evaluate: (groupIds: number[]) => void | Promise<void>,
    options: ForwardGroupEvaluationQueueOptions = {},
  ) {
    this.debounceMs = Math.max(0, Number(options.debounceMs ?? 250));
    this.retryBaseMs = Math.max(1, Number(options.retryBaseMs ?? 1_000));
    this.retryMaxMs = Math.max(this.retryBaseMs, Number(options.retryMaxMs ?? 30_000));
    this.setTimer = options.setTimer ?? setTimeout;
    this.clearTimer = options.clearTimer ?? clearTimeout;
    this.onError = options.onError ?? (() => {});
  }

  enqueue(groupIds: Iterable<unknown>) {
    for (const value of groupIds) {
      const groupId = Number(value || 0);
      if (Number.isInteger(groupId) && groupId > 0) this.pending.add(groupId);
    }
    this.arm(this.debounceMs);
    return this.pending.size;
  }

  private arm(delayMs: number) {
    if (this.timer || this.running || this.pending.size === 0) return;
    this.timer = this.setTimer(() => {
      this.timer = null;
      void this.flush();
    }, delayMs);
    this.timer.unref?.();
  }

  private retryDelayMs(groupId: number) {
    const failures = (this.consecutiveFailures.get(groupId) || 0) + 1;
    this.consecutiveFailures.set(groupId, failures);
    const exponent = Math.min(Math.max(0, failures - 1), 30);
    return Math.min(this.retryMaxMs, this.retryBaseMs * (2 ** exponent));
  }

  private clearRetry(groupId: number) {
    this.consecutiveFailures.delete(groupId);
    const timer = this.retryTimers.get(groupId);
    if (timer) this.clearTimer(timer);
    this.retryTimers.delete(groupId);
  }

  private scheduleRetry(groupId: number) {
    const existing = this.retryTimers.get(groupId);
    if (existing) this.clearTimer(existing);
    const delayMs = this.retryDelayMs(groupId);
    const timer = this.setTimer(() => {
      if (this.retryTimers.get(groupId) !== timer) return;
      this.retryTimers.delete(groupId);
      this.pending.add(groupId);
      this.arm(0);
    }, delayMs);
    timer.unref?.();
    this.retryTimers.set(groupId, timer);
    return delayMs;
  }

  private async flush() {
    if (this.running || this.pending.size === 0) return;
    const groupIds = Array.from(this.pending);
    this.pending.clear();
    this.running = true;
    try {
      await this.evaluate(groupIds);
      for (const groupId of groupIds) this.clearRetry(groupId);
    } catch (error) {
      const batchIds = new Set(groupIds);
      const requestedRetryIds = error instanceof ForwardGroupEvaluationBatchError
        ? error.retryGroupIds.filter((groupId) => batchIds.has(groupId))
        : groupIds;
      const retryIds = requestedRetryIds.length > 0 ? requestedRetryIds : groupIds;
      const retryIdSet = new Set(retryIds);
      for (const groupId of groupIds) {
        if (!retryIdSet.has(groupId)) this.clearRetry(groupId);
      }
      const retryDelayMs = Math.min(...retryIds.map((groupId) => this.scheduleRetry(groupId)));
      try {
        this.onError(error, retryDelayMs);
      } catch {
        // Queue progress must not depend on diagnostics succeeding.
      }
    } finally {
      this.running = false;
      this.arm(this.debounceMs);
    }
  }
}

function timestamp(value: unknown) {
  if (value instanceof Date) return value.getTime();
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
  const parsed = new Date(String(value || "")).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

export function nextForwardGroupHealthRecheckAt(input: {
  members: HealthWindowMember[];
  failoverMs: number;
  recoverMs: number;
  now?: number;
}) {
  const now = Number.isFinite(input.now) ? Number(input.now) : Date.now();
  const deadlines: number[] = [];
  for (const member of input.members) {
    if (!member.healthy && !member.failedLongEnough) {
      const since = timestamp(member.failureSince);
      if (since > 0) deadlines.push(since + Math.max(0, Number(input.failoverMs) || 0));
    }
    if (member.healthy && !member.recoveredLongEnough) {
      const since = timestamp(member.healthySince);
      if (since > 0) deadlines.push(since + Math.max(0, Number(input.recoverMs) || 0));
    }
  }
  if (deadlines.length === 0) return null;
  return Math.max(now, Math.min(...deadlines));
}

export class ForwardGroupHealthRecheckScheduler {
  private readonly pending = new Map<number, { dueAt: number; timer: TimerHandle }>();

  constructor(
    private readonly evaluate: (groupId: number) => void | Promise<void>,
    private readonly now: () => number = Date.now,
    private readonly setTimer: SetTimer = setTimeout,
    private readonly clearTimer: ClearTimer = clearTimeout,
    private readonly onError: (error: unknown) => void = () => {},
  ) {}

  replace(groupIdValue: unknown, dueAtValue: unknown) {
    const groupId = Number(groupIdValue);
    const dueAt = Number(dueAtValue);
    if (!Number.isInteger(groupId) || groupId <= 0) return false;
    const existing = this.pending.get(groupId);
    if (!Number.isFinite(dueAt) || dueAt <= 0) {
      if (existing) this.clearTimer(existing.timer);
      this.pending.delete(groupId);
      return false;
    }
    if (existing?.dueAt === dueAt) return true;
    if (existing) this.clearTimer(existing.timer);
    // A small margin prevents an early timer tick from evaluating just before
    // the configured health window has elapsed.
    const delayMs = Math.max(0, dueAt - this.now()) + 25;
    const timer = this.setTimer(() => {
      const current = this.pending.get(groupId);
      if (!current || current.timer !== timer) return;
      this.pending.delete(groupId);
      void Promise.resolve(this.evaluate(groupId)).catch(this.onError);
    }, delayMs);
    timer.unref?.();
    this.pending.set(groupId, { dueAt, timer });
    return true;
  }

  dueAt(groupIdValue: unknown) {
    return this.pending.get(Number(groupIdValue))?.dueAt ?? null;
  }
}

export type ForwardGroupHostDeadline = {
  groupId: number;
  timeoutMs: number;
};

export type ForwardGroupHostSilenceSchedulerErrorContext = {
  phase: "resolve" | "trigger";
  retryAt: number;
  hostId?: number;
  groupIds?: number[];
};

export type ForwardGroupHostSilenceSchedulerOptions = {
  silenceMs?: number;
  retryMs?: number;
  now?: () => number;
  setTimer?: SetTimer;
  clearTimer?: ClearTimer;
  onError?: (error: unknown, context: ForwardGroupHostSilenceSchedulerErrorContext) => void;
};

type HostSilenceState = {
  generation: number;
  seenAt: number;
  silentAt: number;
  attemptAt: number;
  timer: TimerHandle | null;
  resolving: boolean;
};

type HostGroupDeadline = {
  hostId: number;
  groupId: number;
  generation: number;
  dueAt: number;
};

/**
 * Defers the database lookup for a host until it actually goes silent, then
 * wakes only at the failover deadlines returned for that host.
 */
export class ForwardGroupHostSilenceScheduler {
  private readonly silenceMs: number;
  private readonly retryMs: number;
  private readonly now: () => number;
  private readonly setTimer: SetTimer;
  private readonly clearTimer: ClearTimer;
  private readonly onError: (error: unknown, context: ForwardGroupHostSilenceSchedulerErrorContext) => void;
  private readonly hosts = new Map<number, HostSilenceState>();
  private readonly groupDeadlines = new Map<string, HostGroupDeadline>();
  private groupTimer: TimerHandle | null = null;
  private groupTimerDueAt: number | null = null;
  private groupTriggerRunning = false;

  constructor(
    private readonly resolveDeadlines: (hostId: number) => Iterable<ForwardGroupHostDeadline> | Promise<Iterable<ForwardGroupHostDeadline>>,
    private readonly trigger: (groupIds: number[]) => void | Promise<void>,
    options: ForwardGroupHostSilenceSchedulerOptions = {},
  ) {
    this.silenceMs = Math.max(0, Number(options.silenceMs ?? 0));
    this.retryMs = Math.max(1, Number(options.retryMs ?? 1_000));
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? setTimeout;
    this.clearTimer = options.clearTimer ?? clearTimeout;
    this.onError = options.onError ?? (() => {});
  }

  observe(hostIdValue: unknown, seenAtValue = this.now(), notBeforeValue?: unknown) {
    const hostId = Number(hostIdValue);
    const seenAt = Number(seenAtValue);
    if (!Number.isInteger(hostId) || hostId <= 0 || !Number.isFinite(seenAt) || seenAt < 0) return false;

    const notBefore = Number(notBeforeValue);
    const silentAt = seenAt + this.silenceMs;
    const attemptAt = Math.max(
      silentAt,
      Number.isFinite(notBefore) && notBefore > 0 ? notBefore : 0,
    );
    const existing = this.hosts.get(hostId);
    if (existing && seenAt < existing.seenAt) return false;
    if (existing && seenAt === existing.seenAt && silentAt === existing.silentAt) return true;

    if (existing?.timer) this.clearTimer(existing.timer);
    const generation = (existing?.generation ?? 0) + 1;
    const state: HostSilenceState = {
      generation,
      seenAt,
      silentAt,
      attemptAt,
      timer: null,
      resolving: false,
    };
    this.hosts.set(hostId, state);
    this.removeDeadlinesForHost(hostId);
    this.armHost(hostId, state);
    return true;
  }

  clear(hostIdValue: unknown) {
    const hostId = Number(hostIdValue);
    const state = this.hosts.get(hostId);
    if (state?.timer) this.clearTimer(state.timer);
    const removed = this.hosts.delete(hostId);
    this.removeDeadlinesForHost(hostId);
    return removed;
  }

  pendingAt(hostIdValue: unknown) {
    const state = this.hosts.get(Number(hostIdValue));
    return state && (state.timer || state.resolving) ? state.attemptAt : null;
  }

  pendingHostIds() {
    return Array.from(this.hosts.entries())
      .filter(([, state]) => !!state.timer || state.resolving)
      .map(([hostId]) => hostId);
  }

  dueAt(groupIdValue: unknown) {
    const groupId = Number(groupIdValue);
    let dueAt: number | null = null;
    for (const deadline of this.groupDeadlines.values()) {
      if (deadline.groupId !== groupId) continue;
      dueAt = dueAt === null ? deadline.dueAt : Math.min(dueAt, deadline.dueAt);
    }
    return dueAt;
  }

  pendingGroupIds() {
    return Array.from(new Set(Array.from(this.groupDeadlines.values(), (deadline) => deadline.groupId)));
  }

  dispose() {
    for (const state of this.hosts.values()) {
      if (state.timer) this.clearTimer(state.timer);
    }
    if (this.groupTimer) this.clearTimer(this.groupTimer);
    this.hosts.clear();
    this.groupDeadlines.clear();
    this.groupTimer = null;
    this.groupTimerDueAt = null;
  }

  private deadlineKey(hostId: number, groupId: number) {
    return `${hostId}:${groupId}`;
  }

  private reportError(error: unknown, context: ForwardGroupHostSilenceSchedulerErrorContext) {
    try {
      this.onError(error, context);
    } catch {
      // Scheduling must not depend on diagnostics succeeding.
    }
  }

  private armHost(hostId: number, state: HostSilenceState) {
    if (this.hosts.get(hostId) !== state || state.timer || state.resolving) return;
    const timer = this.setTimer(() => {
      if (this.hosts.get(hostId) !== state || state.timer !== timer) return;
      state.timer = null;
      if (this.now() < state.attemptAt) {
        this.armHost(hostId, state);
        return;
      }
      void this.resolveHost(hostId, state);
    }, timerDelay(state.attemptAt, this.now()));
    timer.unref?.();
    state.timer = timer;
  }

  private async resolveHost(hostId: number, state: HostSilenceState) {
    if (this.hosts.get(hostId) !== state || state.resolving) return;
    state.resolving = true;
    try {
      const resolved = await this.resolveDeadlines(hostId);
      if (this.hosts.get(hostId) !== state) return;
      const byGroupId = new Map<number, number>();
      for (const value of resolved || []) {
        const groupId = Number(value?.groupId);
        const timeoutMs = Number(value?.timeoutMs);
        if (!Number.isInteger(groupId) || groupId <= 0 || !Number.isFinite(timeoutMs)) continue;
        const normalizedTimeout = Math.max(0, timeoutMs);
        const previous = byGroupId.get(groupId);
        if (previous === undefined || normalizedTimeout < previous) byGroupId.set(groupId, normalizedTimeout);
      }
      for (const [groupId, timeoutMs] of byGroupId) {
        const deadline: HostGroupDeadline = {
          hostId,
          groupId,
          generation: state.generation,
          dueAt: state.silentAt + timeoutMs,
        };
        this.groupDeadlines.set(this.deadlineKey(hostId, groupId), deadline);
      }
      this.armGroupTimer();
    } catch (error) {
      if (this.hosts.get(hostId) !== state) return;
      state.attemptAt = this.now() + this.retryMs;
      this.reportError(error, { phase: "resolve", hostId, retryAt: state.attemptAt });
    } finally {
      state.resolving = false;
      if (this.hosts.get(hostId) === state && state.attemptAt > this.now()) this.armHost(hostId, state);
    }
  }

  private removeDeadlinesForHost(hostId: number) {
    let removed = false;
    for (const [key, deadline] of this.groupDeadlines) {
      if (deadline.hostId !== hostId) continue;
      this.groupDeadlines.delete(key);
      removed = true;
    }
    if (removed) this.armGroupTimer(true);
  }

  private earliestGroupDueAt() {
    let earliest: number | null = null;
    for (const deadline of this.groupDeadlines.values()) {
      earliest = earliest === null ? deadline.dueAt : Math.min(earliest, deadline.dueAt);
    }
    return earliest;
  }

  private armGroupTimer(force = false) {
    if (this.groupTriggerRunning) return;
    const dueAt = this.earliestGroupDueAt();
    if (dueAt === null) {
      if (this.groupTimer) this.clearTimer(this.groupTimer);
      this.groupTimer = null;
      this.groupTimerDueAt = null;
      return;
    }
    if (!force && this.groupTimer && this.groupTimerDueAt === dueAt) return;
    if (this.groupTimer) this.clearTimer(this.groupTimer);
    const timer = this.setTimer(() => {
      if (this.groupTimer !== timer) return;
      this.groupTimer = null;
      this.groupTimerDueAt = null;
      if (this.now() < dueAt) {
        this.armGroupTimer();
        return;
      }
      void this.triggerDueGroups();
    }, timerDelay(dueAt, this.now()));
    timer.unref?.();
    this.groupTimer = timer;
    this.groupTimerDueAt = dueAt;
  }

  private async triggerDueGroups() {
    if (this.groupTriggerRunning) return;
    const now = this.now();
    const dueEntries: HostGroupDeadline[] = [];
    for (const [key, deadline] of this.groupDeadlines) {
      if (deadline.dueAt > now) continue;
      this.groupDeadlines.delete(key);
      dueEntries.push(deadline);
    }
    if (dueEntries.length === 0) {
      this.armGroupTimer();
      return;
    }

    this.groupTriggerRunning = true;
    const groupIds = Array.from(new Set(dueEntries.map((deadline) => deadline.groupId)));
    try {
      await this.trigger(groupIds);
    } catch (error) {
      const retryAt = this.now() + this.retryMs;
      for (const deadline of dueEntries) {
        const state = this.hosts.get(deadline.hostId);
        if (!state || state.generation !== deadline.generation) continue;
        const key = this.deadlineKey(deadline.hostId, deadline.groupId);
        const existing = this.groupDeadlines.get(key);
        if (!existing || retryAt < existing.dueAt) {
          this.groupDeadlines.set(key, { ...deadline, dueAt: retryAt });
        }
      }
      this.reportError(error, { phase: "trigger", groupIds, retryAt });
    } finally {
      this.groupTriggerRunning = false;
      this.armGroupTimer(true);
    }
  }
}
