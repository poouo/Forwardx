export type HopTestResult = {
  success: boolean;
  latencyMs: number | null;
  message: string | null;
  hopLabel: string;
  routeLabel?: string | null;
  method?: "tcp" | "ping" | string | null;
};

type HopTestBatch = {
  ownerId: number;
  expected: number;
  createdAt: number;
  byTestId: Map<number, HopTestResult | null>;
};

export type HopTestAggregate = {
  ownerId: number;
  success: boolean;
  latencyMs: number | null;
  message: string;
  details: HopTestResult[];
};

const batches = new Map<string, HopTestBatch>();
const testToBatch = new Map<number, string>();

const BATCH_TTL_MS = 10 * 60 * 1000;

function cleanupExpiredBatches() {
  const now = Date.now();
  for (const [batchId, batch] of batches.entries()) {
    if (now - batch.createdAt <= BATCH_TTL_MS) continue;
    for (const testId of batch.byTestId.keys()) testToBatch.delete(testId);
    batches.delete(batchId);
  }
}

export function createHopTestBatch(prefix: string, ownerId: number) {
  cleanupExpiredBatches();
  const safePrefix = String(prefix || "hb").replace(/[^a-z0-9_-]/gi, "").slice(0, 16) || "hb";
  const batchId = `${safePrefix}-${ownerId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  batches.set(batchId, {
    ownerId,
    expected: 0,
    createdAt: Date.now(),
    byTestId: new Map<number, HopTestResult | null>(),
  });
  return batchId;
}

export function registerHopTest(batchId: string, testId: number) {
  const batch = batches.get(batchId);
  if (!batch) return;
  batch.expected += 1;
  batch.byTestId.set(testId, null);
  testToBatch.set(testId, batchId);
}

export function recordHopTestResult(
  testId: number,
  result: HopTestResult,
  options: {
    successPrefix: string;
    failurePrefix: string;
    totalLabel?: string;
  },
): HopTestAggregate | null {
  const batchId = testToBatch.get(testId);
  if (!batchId) return null;
  const batch = batches.get(batchId);
  if (!batch) {
    testToBatch.delete(testId);
    return null;
  }
  if (!batch.byTestId.has(testId)) return null;
  batch.byTestId.set(testId, result);
  testToBatch.delete(testId);

  const values = Array.from(batch.byTestId.values());
  const completed = values.every((value) => value !== null);
  if (!completed) return null;

  const details = values.filter((value): value is HopTestResult => value !== null);
  const allSuccess = details.every((value) => value.success);
  const totalLatency = allSuccess
    ? details.reduce((sum, value) => sum + (Number(value.latencyMs) || 0), 0)
    : null;
  const detailLines = details.map((value) => {
    const route = String(value.routeLabel || value.hopLabel || "未知链路").trim();
    const latency = value.success && value.latencyMs !== null ? ` ${value.latencyMs}ms` : "";
    const suffix = !value.success && value.message ? `：${value.message}` : "";
    return `${route} ${value.success ? "成功" : "失败"}${latency}${suffix}`;
  });
  const totalLabel = options.totalLabel || "总延迟";
  const message = allSuccess
    ? `${options.successPrefix}，${totalLabel} ${totalLatency}ms（${details.length} 跳）`
    : `${options.failurePrefix}：${detailLines.join("；")}`;

  batches.delete(batchId);

  return {
    ownerId: batch.ownerId,
    success: allSuccess,
    latencyMs: totalLatency,
    message,
    details,
  };
}
