type HopResult = {
  success: boolean;
  latencyMs: number | null;
  message: string | null;
  hopLabel: string;
  routeLabel?: string | null;
};

type TunnelHopBatch = {
  tunnelId: number;
  expected: number;
  createdAt: number;
  byTestId: Map<number, HopResult | null>;
};

const batches = new Map<string, TunnelHopBatch>();
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

export function createTunnelHopBatch(tunnelId: number) {
  cleanupExpiredBatches();
  const batchId = `tb-${tunnelId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  batches.set(batchId, {
    tunnelId,
    expected: 0,
    createdAt: Date.now(),
    byTestId: new Map<number, HopResult | null>(),
  });
  return batchId;
}

export function registerTunnelHopTest(batchId: string, testId: number) {
  const batch = batches.get(batchId);
  if (!batch) return;
  batch.expected += 1;
  batch.byTestId.set(testId, null);
  testToBatch.set(testId, batchId);
}

export function recordTunnelHopTestResult(
  testId: number,
  result: HopResult,
): null | {
  tunnelId: number;
  success: boolean;
  latencyMs: number | null;
  message: string;
} {
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
  const completed = values.every((v) => v !== null);
  if (!completed) return null;

  const hopResults = values.filter((v): v is HopResult => v !== null);
  const allSuccess = hopResults.every((v) => v.success);
  const totalLatency = allSuccess
    ? hopResults.reduce((sum, v) => sum + (Number(v.latencyMs) || 0), 0)
    : null;
  const detailLines = hopResults.map((v) => {
    const route = String(v.routeLabel || v.hopLabel || "未知跳点").trim();
    const latency = v.success && v.latencyMs !== null ? ` ${v.latencyMs}ms` : "";
    const suffix = !v.success && v.message ? `：${v.message}` : "";
    return `${route} ${v.success ? "成功" : "失败"}${latency}${suffix}`;
  });
  const message = allSuccess
    ? `多级隧道逐跳测试成功，总延迟 ${totalLatency}ms（${hopResults.length} 跳）`
    : `多级隧道逐跳测试失败：${detailLines.join("；")}`;

  batches.delete(batchId);

  return {
    tunnelId: batch.tunnelId,
    success: allSuccess,
    latencyMs: totalLatency,
    message,
  };
}
