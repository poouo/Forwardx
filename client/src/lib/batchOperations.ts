export type BatchOperationResult<T, R> =
  | { item: T; status: "fulfilled"; value: R }
  | { item: T; status: "rejected"; reason: unknown };

export async function runBatchOperations<T, R>(
  items: readonly T[],
  concurrencyValue: number,
  operation: (item: T, index: number) => Promise<R>,
): Promise<Array<BatchOperationResult<T, R>>> {
  if (items.length === 0) return [];
  const concurrency = Math.max(1, Math.min(items.length, Math.floor(Number(concurrencyValue) || 1)));
  const results = new Array<BatchOperationResult<T, R>>(items.length);
  let nextIndex = 0;

  const worker = async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      const item = items[index];
      try {
        results[index] = { item, status: "fulfilled", value: await operation(item, index) };
      } catch (reason) {
        results[index] = { item, status: "rejected", reason };
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}

export function batchOperationErrorMessage(reason: unknown) {
  return reason instanceof Error ? reason.message : String(reason || "未知错误");
}

export function isBatchPortConflictError(reason: unknown) {
  const message = batchOperationErrorMessage(reason);
  return /(?:端口.*(?:占用|冲突|正在被.*分配)|(?:port|entry agent port).*?(?:already (?:used|in use)|being allocated)|EADDRINUSE)/i.test(message);
}

export function chunkBatchItems<T>(items: readonly T[], sizeValue: number): T[][] {
  const size = Math.max(1, Math.floor(Number(sizeValue) || 1));
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}
