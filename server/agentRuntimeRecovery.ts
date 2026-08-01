/**
 * Coordinates runtime recovery requests that can be triggered by both the
 * agent event stream and the heartbeat path.
 *
 * A host has two recovery strengths:
 * - preserveReportedRuntime=true is a light reconciliation from the local
 *   Agent snapshot.
 * - preserveReportedRuntime=false is a full reset and must take precedence
 *   over a recent light recovery.
 *
 * The cooldown is committed only after the task succeeds. This is important
 * for transient database failures: a failed recovery must be retryable on the
 * next heartbeat instead of being hidden for the whole cooldown window.
 */

export const AGENT_RUNTIME_RECOVERY_COOLDOWN_MS = 60 * 1000;

export type AgentRuntimeRecoveryOptions = {
  preserveReportedRuntime?: boolean;
};

export type AgentRuntimeRecoveryCoordinatorOptions = {
  cooldownMs?: number;
  now?: () => number;
};

type RecoveryState = {
  lastSuccessAt: number;
  lastSuccessStrength: number;
  inFlight?: {
    strength: number;
    promise: Promise<void>;
  };
};

type RecoveryTask = () => Promise<void> | void;

function recoveryStrength(options: AgentRuntimeRecoveryOptions | undefined) {
  // A full reset (preserve=false) is stronger than snapshot reconciliation.
  return options?.preserveReportedRuntime ? 0 : 1;
}

export class AgentRuntimeRecoveryCoordinator {
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private readonly states = new Map<number, RecoveryState>();

  constructor(options: AgentRuntimeRecoveryCoordinatorOptions = {}) {
    this.cooldownMs = Math.max(0, Number(options.cooldownMs ?? AGENT_RUNTIME_RECOVERY_COOLDOWN_MS));
    this.now = options.now || (() => Date.now());
  }

  /**
   * Run a recovery task unless an equivalent or stronger successful recovery
   * is still inside the cooldown window.
   *
   * Returns true when this call ran the task, and false when it was coalesced.
   * If a task fails its error is propagated and no cooldown is recorded.
   */
  async run(
    hostIdValue: number,
    options: AgentRuntimeRecoveryOptions,
    task: RecoveryTask,
  ): Promise<boolean> {
    const hostId = Number(hostIdValue);
    if (!Number.isFinite(hostId) || hostId <= 0) return false;

    const strength = recoveryStrength(options);
    let state = this.states.get(hostId);
    if (!state) {
      state = { lastSuccessAt: 0, lastSuccessStrength: -1 };
      this.states.set(hostId, state);
    }

    // A stronger request arriving while a light recovery is in flight must
    // wait for it, then run its own full recovery if needed.
    if (state.inFlight) {
      const running = state.inFlight;
      if (running.strength >= strength) {
        try {
          await running.promise;
          return false;
        } catch {
          // A failed in-flight task did not commit cooldown. Retry from this
          // request instead of propagating a transient failure to a duplicate
          // heartbeat/SSE caller.
          return this.run(hostId, options, task);
        }
      }
      try {
        await running.promise;
      } catch {
        // The original failure is re-evaluated below so this request can retry.
      }
      return this.run(hostId, options, task);
    }

    const now = this.now();
    if (
      now - state.lastSuccessAt < this.cooldownMs
      && state.lastSuccessStrength >= strength
    ) {
      return false;
    }

    const promise = Promise.resolve().then(task);
    state.inFlight = { strength, promise };
    try {
      await promise;
      state.lastSuccessAt = this.now();
      state.lastSuccessStrength = strength;
      return true;
    } finally {
      // Do not leave a rejected promise or an old in-flight marker blocking
      // future retries. A failed task deliberately leaves lastSuccessAt intact.
      if (state.inFlight?.promise === promise) state.inFlight = undefined;
    }
  }

  /** Clear state for a host that has been removed from the panel. */
  clear(hostIdValue: number) {
    const hostId = Number(hostIdValue);
    if (Number.isFinite(hostId) && hostId > 0) this.states.delete(hostId);
  }

  /** Test/support hook for inspecting and resetting coordinator state. */
  clearAll() {
    this.states.clear();
  }
}

export const agentRuntimeRecoveryCoordinator = new AgentRuntimeRecoveryCoordinator();

export async function runAgentRuntimeRecovery(
  hostId: number,
  options: AgentRuntimeRecoveryOptions,
  task: RecoveryTask,
) {
  return agentRuntimeRecoveryCoordinator.run(hostId, options, task);
}
