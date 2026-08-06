import { isAgentVersionAtLeast } from "./agentRouteUtils";
import { clearAuthenticatedAgentActivity } from "./agentActivity";

export const AGENT_FAST_LIVENESS_MIN_VERSION = "2.2.171";
export const AGENT_FAST_LIVENESS_SILENCE_MS = 25_000;
// A live Agent reconnects its event stream within at most 30 seconds and its
// presence loop within 5 seconds. Keep a little startup margin without falling
// back to the legacy 150-second display TTL.
export const AGENT_FAST_LIVENESS_STARTUP_GRACE_MS = 45_000;

type TimerHandle = ReturnType<typeof setTimeout>;
type SetTimer = (callback: () => void, delayMs: number) => TimerHandle;
type ClearTimer = (timer: TimerHandle) => void;

export type AgentFastLivenessHost = {
  id?: unknown;
  hostId?: unknown;
  agentVersion?: unknown;
  version?: unknown;
  isOnline?: unknown;
  lastHeartbeat?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
};

export type AgentFastLivenessState = {
  hostId: number;
  agentVersion: string;
  transitionEpoch: number;
  lastSeenAt: number | null;
  deadlineAt: number;
  offlineAt: number | null;
  lastOfflineAt: number | null;
  confirmedOffline: boolean;
};

export type AgentFastLivenessTransitionKind = "confirmed-offline" | "activity-restored";

export type AgentFastLivenessTransition = AgentFastLivenessState & {
  kind: AgentFastLivenessTransitionKind;
  /**
   * Async consumers must check this after every await before applying a
   * transition. A newer Agent request invalidates an older offline event.
   */
  isCurrent: () => boolean;
};

export type AgentFastLivenessTrackerOptions = {
  silenceMs?: number;
  startupGraceMs?: number;
  now?: () => number;
  setTimer?: SetTimer;
  clearTimer?: ClearTimer;
  onError?: (error: unknown, event: AgentFastLivenessTransition) => void;
};

type MutableAgentFastLivenessState = AgentFastLivenessState & {
  timerGeneration: number;
  timer: TimerHandle | null;
};

function positiveHostId(value: unknown) {
  const hostId = Number(value);
  return Number.isInteger(hostId) && hostId > 0 ? hostId : null;
}

function normalizedTimestamp(value: unknown, now: number) {
  if (value instanceof Date) {
    const timestamp = value.getTime();
    return Number.isFinite(timestamp) && timestamp > 0 ? Math.min(timestamp, now) : null;
  }
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    return Math.min(numeric, now);
  }
  const parsed = new Date(String(value || "")).getTime();
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, now) : null;
}

function nextGeneration(current: number) {
  return current >= Number.MAX_SAFE_INTEGER ? 1 : current + 1;
}

function snapshot(state: MutableAgentFastLivenessState): AgentFastLivenessState {
  return {
    hostId: state.hostId,
    agentVersion: state.agentVersion,
    transitionEpoch: state.transitionEpoch,
    lastSeenAt: state.lastSeenAt,
    deadlineAt: state.deadlineAt,
    offlineAt: state.offlineAt,
    lastOfflineAt: state.lastOfflineAt,
    confirmedOffline: state.confirmedOffline,
  };
}

export function supportsAgentFastLiveness(agentVersion: unknown) {
  return isAgentVersionAtLeast(String(agentVersion || ""), AGENT_FAST_LIVENESS_MIN_VERSION);
}

export class AgentFastLivenessTracker {
  private readonly silenceMs: number;
  private readonly startupGraceMs: number;
  private readonly now: () => number;
  private readonly setTimer: SetTimer;
  private readonly clearTimer: ClearTimer;
  private readonly onError: (error: unknown, event: AgentFastLivenessTransition) => void;
  private readonly hosts = new Map<number, MutableAgentFastLivenessState>();
  private readonly listeners = new Set<(event: AgentFastLivenessTransition) => void | Promise<void>>();
  private transitionEpochCounter = 0;

  constructor(options: AgentFastLivenessTrackerOptions = {}) {
    this.silenceMs = Math.max(1, Number(options.silenceMs ?? AGENT_FAST_LIVENESS_SILENCE_MS));
    this.startupGraceMs = Math.max(0, Number(options.startupGraceMs ?? AGENT_FAST_LIVENESS_STARTUP_GRACE_MS));
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? setTimeout;
    this.clearTimer = options.clearTimer ?? clearTimeout;
    this.onError = options.onError ?? (() => {});
  }

  subscribe(listener: (event: AgentFastLivenessTransition) => void | Promise<void>) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  subscribeOffline(listener: (event: AgentFastLivenessTransition) => void | Promise<void>) {
    return this.subscribe((event) => {
      if (event.kind === "confirmed-offline") return listener(event);
    });
  }

  registerHost(
    host: AgentFastLivenessHost,
    options: { startupGrace?: boolean; activityAt?: unknown } = {},
  ) {
    const hostId = positiveHostId(host?.hostId ?? host?.id);
    if (!hostId) return false;
    const agentVersion = String(host?.agentVersion ?? host?.version ?? "").trim();
    if (!supportsAgentFastLiveness(agentVersion)) {
      this.removeHost(hostId);
      return false;
    }

    const existing = this.hosts.get(hostId);
    if (existing) {
      existing.agentVersion = agentVersion;
      if (options.activityAt !== undefined) this.observeActivity(hostId, options.activityAt);
      return true;
    }

    const now = this.now();
    const activityAt = options.activityAt === undefined
      ? null
      : normalizedTimestamp(options.activityAt, now) ?? now;
    const persistedSeenAt = normalizedTimestamp(host?.lastHeartbeat, now);
    const persistedOffline = options.startupGrace
      && (host?.isOnline === false || host?.isOnline === 0 || host?.isOnline === "0");
    const deadlineDelay = options.startupGrace && activityAt === null
      ? this.startupGraceMs
      : this.silenceMs;
    const state: MutableAgentFastLivenessState = {
      hostId,
      agentVersion,
      transitionEpoch: 0,
      lastSeenAt: activityAt ?? persistedSeenAt,
      deadlineAt: now + deadlineDelay,
      offlineAt: null,
      // A persisted offline host must not reuse health samples from before a
      // panel restart when it reconnects during startup grace.
      lastOfflineAt: persistedOffline ? now : null,
      confirmedOffline: false,
      timerGeneration: 1,
      timer: null,
    };
    this.hosts.set(hostId, state);
    this.arm(state);
    return true;
  }

  /** Registers eligible persisted hosts without trusting a potentially stale DB heartbeat. */
  primeHosts(hosts: Iterable<AgentFastLivenessHost>) {
    let eligible = 0;
    for (const host of hosts) {
      if (this.registerHost(host, { startupGrace: true })) eligible += 1;
    }
    return eligible;
  }

  /** Registers a host whose request itself proves presence capability and liveness. */
  registerPresenceCapableHost(hostIdValue: unknown, seenAtValue: unknown = this.now()) {
    const hostId = positiveHostId(hostIdValue);
    if (!hostId) return false;
    if (this.hosts.has(hostId)) return this.observeActivity(hostId, seenAtValue);
    return this.registerHost(
      { hostId, agentVersion: AGENT_FAST_LIVENESS_MIN_VERSION },
      { activityAt: seenAtValue },
    );
  }

  observeActivity(hostIdValue: unknown, seenAtValue: unknown = this.now()) {
    const hostId = positiveHostId(hostIdValue);
    if (!hostId) return false;
    const state = this.hosts.get(hostId);
    if (!state) return false;

    const now = this.now();
    const seenAt = normalizedTimestamp(seenAtValue, now) ?? now;
    const wasOffline = state.confirmedOffline;
    if (state.timer) this.clearTimer(state.timer);
    state.timer = null;
    state.timerGeneration = nextGeneration(state.timerGeneration);
    state.lastSeenAt = Math.max(state.lastSeenAt ?? 0, seenAt);
    state.deadlineAt = now + this.silenceMs;
    state.confirmedOffline = false;
    state.offlineAt = null;
    if (wasOffline) state.transitionEpoch = this.nextTransitionEpoch();
    this.arm(state);

    if (wasOffline) this.emit("activity-restored", state);
    return true;
  }

  removeHost(hostIdValue: unknown) {
    const hostId = positiveHostId(hostIdValue);
    if (!hostId) return false;
    const state = this.hosts.get(hostId);
    if (!state) return false;
    if (state.timer) this.clearTimer(state.timer);
    this.hosts.delete(hostId);
    return true;
  }

  clear() {
    for (const state of this.hosts.values()) {
      if (state.timer) this.clearTimer(state.timer);
    }
    this.hosts.clear();
  }

  hasHost(hostIdValue: unknown) {
    const hostId = positiveHostId(hostIdValue);
    return !!hostId && this.hosts.has(hostId);
  }

  isConfirmedOffline(hostIdValue: unknown) {
    const hostId = positiveHostId(hostIdValue);
    return !!hostId && this.hosts.get(hostId)?.confirmedOffline === true;
  }

  isCurrentTransition(hostIdValue: unknown, transitionEpochValue: unknown, confirmedOffline?: boolean) {
    const hostId = positiveHostId(hostIdValue);
    const transitionEpoch = Number(transitionEpochValue);
    if (!hostId || !Number.isSafeInteger(transitionEpoch) || transitionEpoch <= 0) return false;
    const state = this.hosts.get(hostId);
    if (!state || state.transitionEpoch !== transitionEpoch) return false;
    return confirmedOffline === undefined || state.confirmedOffline === confirmedOffline;
  }

  state(hostIdValue: unknown) {
    const hostId = positiveHostId(hostIdValue);
    const state = hostId ? this.hosts.get(hostId) : null;
    return state ? snapshot(state) : null;
  }

  registeredHostIds() {
    return Array.from(this.hosts.keys());
  }

  private arm(state: MutableAgentFastLivenessState) {
    const timerGeneration = state.timerGeneration;
    const delayMs = Math.max(0, state.deadlineAt - this.now());
    const timer = this.setTimer(() => {
      const current = this.hosts.get(state.hostId);
      if (!current || current.timerGeneration !== timerGeneration || current.timer !== timer) return;
      current.timer = null;
      if (this.now() < current.deadlineAt) {
        this.arm(current);
        return;
      }
      if (current.confirmedOffline) return;
      current.confirmedOffline = true;
      current.offlineAt = this.now();
      current.lastOfflineAt = current.offlineAt;
      current.transitionEpoch = this.nextTransitionEpoch();
      this.emit("confirmed-offline", current);
    }, delayMs);
    timer.unref?.();
    state.timer = timer;
  }

  private emit(kind: AgentFastLivenessTransitionKind, state: MutableAgentFastLivenessState) {
    const expectedOffline = kind === "confirmed-offline";
    const transitionEpoch = state.transitionEpoch;
    const event: AgentFastLivenessTransition = {
      ...snapshot(state),
      kind,
      isCurrent: () => this.isCurrentTransition(state.hostId, transitionEpoch, expectedOffline),
    };
    for (const listener of this.listeners) {
      try {
        const result = listener(event);
        if (result && typeof (result as Promise<void>).then === "function") {
          void Promise.resolve(result).catch((error) => this.reportError(error, event));
        }
      } catch (error) {
        this.reportError(error, event);
      }
    }
  }

  private reportError(error: unknown, event: AgentFastLivenessTransition) {
    try {
      this.onError(error, event);
    } catch {
      // Liveness progression must not depend on diagnostics succeeding.
    }
  }

  private nextTransitionEpoch() {
    this.transitionEpochCounter = nextGeneration(this.transitionEpochCounter);
    return this.transitionEpochCounter;
  }
}

/** Shared process-local state for host status and DDNS health integration. */
export const agentFastLivenessTracker = new AgentFastLivenessTracker();

export function registerPresenceCapableHost(hostId: unknown, seenAt: unknown = Date.now()) {
  return agentFastLivenessTracker.registerPresenceCapableHost(hostId, seenAt);
}

/** Refreshes only an already registered presence-capable host. */
export function observePresenceCapableHostActivity(hostId: unknown, seenAt: unknown = Date.now()) {
  return agentFastLivenessTracker.observeActivity(hostId, seenAt);
}

export function primePresenceCapableHost(host: AgentFastLivenessHost) {
  return agentFastLivenessTracker.registerHost(host, { startupGrace: true });
}

export function primePresenceCapableHosts(hosts: Iterable<AgentFastLivenessHost>) {
  return agentFastLivenessTracker.primeHosts(hosts);
}

export function removePresenceCapableHost(hostId: unknown) {
  clearAuthenticatedAgentActivity(hostId);
  return agentFastLivenessTracker.removeHost(hostId);
}

export function subscribeAgentFastLivenessOffline(
  listener: (event: AgentFastLivenessTransition) => void | Promise<void>,
) {
  return agentFastLivenessTracker.subscribeOffline(listener);
}

/**
 * Observe every generation-safe liveness transition. Consumers that persist
 * host state can serialize online/offline transitions for one host so a late
 * database write cannot overwrite a newer recovery.
 */
export function subscribeAgentFastLiveness(
  listener: (event: AgentFastLivenessTransition) => void | Promise<void>,
) {
  return agentFastLivenessTracker.subscribe(listener);
}

export function isAgentFastLivenessConfirmedOffline(hostId: unknown) {
  return agentFastLivenessTracker.isConfirmedOffline(hostId);
}

export function getAgentFastLivenessState(hostId: unknown) {
  return agentFastLivenessTracker.state(hostId);
}

export const getPresenceCapableHostLivenessSnapshot = getAgentFastLivenessState;
export const isPresenceCapableHostConfirmedOffline = isAgentFastLivenessConfirmedOffline;
export const subscribePresenceCapableHostOffline = subscribeAgentFastLivenessOffline;
