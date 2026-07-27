export function handoffManualTestResult<T>(
  result: T | null | undefined,
  cacheCompletedResult: (result: T) => void,
  finishTesting: () => void,
) {
  if (result === null || result === undefined) return false;
  cacheCompletedResult(result);
  finishTesting();
  return true;
}

export function hasQuerySnapshotAfter(
  baselineUpdatedAt: number | null | undefined,
  currentUpdatedAt: number,
) {
  if (baselineUpdatedAt === null || baselineUpdatedAt === undefined) return false;
  return Number.isFinite(currentUpdatedAt) && currentUpdatedAt > baselineUpdatedAt;
}
