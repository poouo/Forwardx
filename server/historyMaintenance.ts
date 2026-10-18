type CleanupJob = readonly [name: string, run: () => Promise<unknown>];

/** Serial cleanup avoids flooding the business pool with unrelated DELETEs.
 * One table's failure must not skip retention for every remaining table. */
export async function runHistoryMaintenance(
  jobs: readonly CleanupJob[],
  options: { shouldContinue?: () => boolean; logger?: Pick<typeof console, "error"> } = {},
) {
  for (const [name, run] of jobs) {
    if (options.shouldContinue && !options.shouldContinue()) return;
    try {
      await run();
    } catch (error) {
      (options.logger ?? console).error(`[HistoryCleanup] failed task=${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}
