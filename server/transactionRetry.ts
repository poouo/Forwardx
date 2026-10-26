export type TransactionAttemptState = { rolledBack: boolean };

export function isRetryableTransactionConflict(error: unknown): boolean {
  const seen = new Set<unknown>();
  for (let current: any = error; current && !seen.has(current); current = current.cause) {
    seen.add(current);
    if (current.code === "ER_LOCK_DEADLOCK" || Number(current.errno) === 1213
      || current.code === "40P01" || current.code === "40001") return true;
    if (seen.size >= 8) break;
  }
  return false;
}

/** Opt-in only: callers must keep external effects in afterDatabaseCommit. */
export async function retryTransactionConflicts<T>(
  run: (state: TransactionAttemptState) => Promise<T>,
  enabled = false,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const state = { rolledBack: false };
    try { return await run(state); }
    catch (error) {
      // Never retry an ambiguous commit, failed rollback or post-commit callback.
      if (!enabled || !state.rolledBack || attempt >= 2 || !isRetryableTransactionConflict(error)) throw error;
      await new Promise(resolve => setTimeout(resolve, 10 * (attempt + 1) + Math.floor(Math.random() * 20)));
    }
  }
}
