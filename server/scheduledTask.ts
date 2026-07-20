type ScheduledTaskLogger = Pick<typeof console, "warn" | "error">;

export function createNonOverlappingScheduledTask(
  name: string,
  task: () => Promise<void>,
  options: {
    logger?: ScheduledTaskLogger;
    now?: () => number;
    slowTaskMs?: number;
    skipLogIntervalMs?: number;
  } = {},
) {
  const logger = options.logger ?? console;
  const now = options.now ?? Date.now;
  const slowTaskMs = Math.max(0, Number(options.slowTaskMs ?? 5_000));
  const skipLogIntervalMs = Math.max(1_000, Number(options.skipLogIntervalMs ?? 5 * 60_000));
  let running = false;
  let lastSkipLogAt = Number.NEGATIVE_INFINITY;

  return async () => {
    if (running) {
      const skippedAt = now();
      if (skippedAt - lastSkipLogAt >= skipLogIntervalMs) {
        lastSkipLogAt = skippedAt;
        logger.warn(`[Scheduler] ${name} is still running; skipped overlapping execution`);
      }
      return false;
    }

    running = true;
    const startedAt = now();
    try {
      await task();
    } catch (error) {
      logger.error(`[Scheduler] ${name} failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      const elapsedMs = Math.max(0, now() - startedAt);
      running = false;
      if (slowTaskMs > 0 && elapsedMs >= slowTaskMs) {
        logger.warn(`[Scheduler] ${name} completed slowly duration=${elapsedMs}ms`);
      }
    }
    return true;
  };
}
