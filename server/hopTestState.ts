export type HopTestResult = {
  success: boolean;
  latencyMs: number | null;
  message: string | null;
  hopLabel: string;
  routeLabel?: string | null;
  method?: "tcp" | "ping" | string | null;
  groupKey?: string | null;
  groupLabel?: string | null;
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

function cleanRouteNodeLabel(value: unknown) {
  return String(value || "").replace(/^第\s*\d+\s*跳\s*/, "").replace(/\s+/g, " ").trim();
}

function parseRouteEndpoints(detail: HopTestResult, index: number) {
  const route = String(detail.routeLabel || "").replace(/\s+/g, " ").trim();
  const arrowParts = route.split(/\s*(?:->|→)\s*/).filter(Boolean);
  if (arrowParts.length >= 2) {
    return {
      from: cleanRouteNodeLabel(arrowParts[0]),
      to: cleanRouteNodeLabel(arrowParts.slice(1).join(" -> ")),
    };
  }
  const hopLabel = String(detail.hopLabel || "").replace(/\s+/g, " ").trim();
  const hopMatch = hopLabel.match(/(?:(?:入口|出口)\s*)?(?:\d+\s*\/\s*\d+\s*)?(.+?)\s*->\s*(.+)$/);
  if (hopMatch) {
    return {
      from: cleanRouteNodeLabel(hopMatch[1]),
      to: cleanRouteNodeLabel(hopMatch[2]),
    };
  }
  return { from: index === 0 ? "入口" : `节点 ${index + 1}`, to: `节点 ${index + 2}` };
}

function multiSourceAdjustedLatency(details: HopTestResult[], latencies: number[]) {
  if (details.length < 2) return null;
  const firstTarget = parseRouteEndpoints(details[0], 0).to;
  if (!firstTarget) return null;
  const initialIndexes: number[] = [];
  for (let index = 0; index < details.length; index += 1) {
    const detail = details[index];
    const endpoints = parseRouteEndpoints(detail, index);
    if (detail.groupKey || endpoints.to !== firstTarget) break;
    initialIndexes.push(index);
  }
  const uniqueSources = new Set(initialIndexes.map((index) => parseRouteEndpoints(details[index], index).from).filter(Boolean));
  if (initialIndexes.length < 2 || uniqueSources.size < 2) return null;
  const initialLatency = Math.max(...initialIndexes.map((index) => latencies[index] || 0));
  const restLatency = latencies.slice(initialIndexes.length).reduce((sum, value) => sum + value, 0);
  return initialLatency + restLatency;
}

export function recordHopTestResult(
  testId: number,
  result: HopTestResult,
  options: {
    successPrefix: string;
    failurePrefix: string;
    totalLabel?: string;
    latencyMode?: "sum" | "max" | "multi-source";
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
  const successfulLatencies = details.map((value) => Number(value.latencyMs) || 0);
  const totalLatency = allSuccess
    ? options.latencyMode === "max"
      ? successfulLatencies.reduce((max, value) => Math.max(max, value), 0)
      : options.latencyMode === "multi-source"
        ? multiSourceAdjustedLatency(details, successfulLatencies) ?? successfulLatencies.reduce((sum, value) => sum + value, 0)
        : successfulLatencies.reduce((sum, value) => sum + value, 0)
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
