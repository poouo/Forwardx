export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrencyValue: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const concurrency = Math.max(1, Math.min(items.length, Math.floor(Number(concurrencyValue) || 1)));
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  let failed = false;
  let firstError: unknown;

  const worker = async () => {
    while (!failed) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      try {
        results[index] = await mapper(items[index], index);
      } catch (error) {
        failed = true;
        firstError = error;
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  if (failed) throw firstError;
  return results;
}
