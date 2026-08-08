export const HOST_OFFLINE_NOTIFICATION_DEBOUNCE_MS = 15_000;

type TimerHandle = ReturnType<typeof setTimeout>;
type SetTimer = (callback: () => void, delayMs: number) => TimerHandle;
type ClearTimer = (timer: TimerHandle) => void;

export type HostOfflineNotificationDebouncerOptions = {
  delayMs?: number;
  setTimer?: SetTimer;
  clearTimer?: ClearTimer;
  onError?: (error: unknown, hostId: number) => void;
};

type PendingNotification = {
  generation: number;
  timer: TimerHandle;
};

function positiveHostId(value: unknown) {
  const hostId = Number(value);
  return Number.isInteger(hostId) && hostId > 0 ? hostId : null;
}

export class HostOfflineNotificationDebouncer {
  private readonly delayMs: number;
  private readonly setTimer: SetTimer;
  private readonly clearTimer: ClearTimer;
  private readonly onError: (error: unknown, hostId: number) => void;
  private readonly pending = new Map<number, PendingNotification>();
  private generation = 0;

  constructor(options: HostOfflineNotificationDebouncerOptions = {}) {
    this.delayMs = Math.max(0, Number(options.delayMs ?? HOST_OFFLINE_NOTIFICATION_DEBOUNCE_MS));
    this.setTimer = options.setTimer ?? setTimeout;
    this.clearTimer = options.clearTimer ?? clearTimeout;
    this.onError = options.onError ?? (() => {});
  }

  schedule(
    hostIdValue: unknown,
    isCurrent: () => boolean,
    notify: () => void | Promise<void>,
  ) {
    const hostId = positiveHostId(hostIdValue);
    if (!hostId) return false;

    this.cancel(hostId);
    const generation = this.nextGeneration();
    const timer = this.setTimer(() => {
      const current = this.pending.get(hostId);
      if (!current || current.generation !== generation || current.timer !== timer) return;
      this.pending.delete(hostId);

      let shouldNotify = false;
      try {
        shouldNotify = isCurrent();
      } catch (error) {
        this.reportError(error, hostId);
        return;
      }
      if (!shouldNotify) return;

      try {
        const result = notify();
        if (result && typeof (result as Promise<void>).then === "function") {
          void Promise.resolve(result).catch((error) => this.reportError(error, hostId));
        }
      } catch (error) {
        this.reportError(error, hostId);
      }
    }, this.delayMs);
    timer.unref?.();
    this.pending.set(hostId, { generation, timer });
    return true;
  }

  cancel(hostIdValue: unknown) {
    const hostId = positiveHostId(hostIdValue);
    if (!hostId) return false;
    const current = this.pending.get(hostId);
    if (!current) return false;
    this.clearTimer(current.timer);
    this.pending.delete(hostId);
    return true;
  }

  clear() {
    for (const current of this.pending.values()) this.clearTimer(current.timer);
    this.pending.clear();
  }

  hasPending(hostIdValue: unknown) {
    const hostId = positiveHostId(hostIdValue);
    return !!hostId && this.pending.has(hostId);
  }

  private nextGeneration() {
    this.generation = this.generation >= Number.MAX_SAFE_INTEGER ? 1 : this.generation + 1;
    return this.generation;
  }

  private reportError(error: unknown, hostId: number) {
    try {
      this.onError(error, hostId);
    } catch {
      // Notification scheduling must not depend on diagnostics succeeding.
    }
  }
}
