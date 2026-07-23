export const SELF_TEST_TIMEOUT_SECONDS = 8;
export const SELF_TEST_SWEEP_INTERVAL_MS = 2_000;
export const SELF_TEST_SWEEP_ACTIVE_WINDOW_MS =
  SELF_TEST_TIMEOUT_SECONDS * 1000 + SELF_TEST_SWEEP_INTERVAL_MS * 2;

export class SelfTestSweepActivity {
  private activeUntilMs: number;

  constructor(
    private readonly now: () => number = Date.now,
    startActive = true,
  ) {
    this.activeUntilMs = startActive ? this.now() + SELF_TEST_SWEEP_ACTIVE_WINDOW_MS : 0;
  }

  markActive() {
    this.activeUntilMs = Math.max(
      this.activeUntilMs,
      this.now() + SELF_TEST_SWEEP_ACTIVE_WINDOW_MS,
    );
  }

  shouldSweep() {
    return this.now() < this.activeUntilMs;
  }
}

export const selfTestSweepActivity = new SelfTestSweepActivity();
