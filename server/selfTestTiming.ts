export const SELF_TEST_TIMEOUT_SECONDS = 8;
export const RUNTIME_SELF_TEST_TIMEOUT_SECONDS = 45;
export const FORWARD_TUNNEL_LATENCY_WAIT_MS = 12_000;
export const SELF_TEST_SWEEP_INTERVAL_MS = 2_000;
export const SELF_TEST_SWEEP_ACTIVE_WINDOW_MS =
  RUNTIME_SELF_TEST_TIMEOUT_SECONDS * 1000 + SELF_TEST_SWEEP_INTERVAL_MS * 2;

const RUNTIME_SELF_TEST_KINDS = new Set([
  "tunnel",
  "tunnel-hop",
  "forward-via-tunnel",
  "forward-via-tunnel-entry",
  "forward-chain",
]);

export function selfTestTimeoutSeconds(meta: { kind?: string; runtimeDependent?: boolean } | null | undefined) {
  const runtimeDependent = meta
    && RUNTIME_SELF_TEST_KINDS.has(String(meta.kind || ""))
    && !(meta.kind === "forward-chain" && meta.runtimeDependent === false);
  return runtimeDependent ? RUNTIME_SELF_TEST_TIMEOUT_SECONDS : SELF_TEST_TIMEOUT_SECONDS;
}

export class SelfTestSweepActivity {
  private activeUntilMs: number;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly now: () => number = Date.now,
    startActive = false,
  ) {
    this.activeUntilMs = startActive ? this.now() + SELF_TEST_SWEEP_ACTIVE_WINDOW_MS : 0;
  }

  markActive() {
    this.activeUntilMs = Math.max(
      this.activeUntilMs,
      this.now() + SELF_TEST_SWEEP_ACTIVE_WINDOW_MS,
    );
    for (const listener of this.listeners) listener();
  }

  shouldSweep() {
    return this.now() < this.activeUntilMs;
  }

  onActive(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export const selfTestSweepActivity = new SelfTestSweepActivity();

type SelfTestSweepTimerApi = {
  setTimeout: (callback: () => void | Promise<void>, delayMs: number) => any;
  clearTimeout: (handle: any) => void;
};

const defaultSelfTestSweepTimerApi: SelfTestSweepTimerApi = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle),
};

export function startSelfTestSweepTimer(
  runSweep: () => void | Promise<void>,
  options: {
    activity?: SelfTestSweepActivity;
    intervalMs?: number;
    timers?: SelfTestSweepTimerApi;
  } = {},
) {
  const activity = options.activity || selfTestSweepActivity;
  const intervalMs = options.intervalMs || SELF_TEST_SWEEP_INTERVAL_MS;
  const timers = options.timers || defaultSelfTestSweepTimerApi;
  let timer: any = null;
  let running = false;
  let stopped = false;

  const arm = () => {
    if (stopped || timer || running || !activity.shouldSweep()) return;
    timer = timers.setTimeout(async () => {
      timer = null;
      if (stopped || !activity.shouldSweep()) return;
      running = true;
      try {
        await runSweep();
      } finally {
        running = false;
        arm();
      }
    }, intervalMs);
    timer?.unref?.();
  };

  const unsubscribe = activity.onActive(arm);
  arm();

  return () => {
    stopped = true;
    unsubscribe();
    if (timer) timers.clearTimeout(timer);
    timer = null;
  };
}
