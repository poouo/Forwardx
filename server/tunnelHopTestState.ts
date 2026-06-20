import {
  createHopTestBatch,
  recordHopTestResult,
  registerHopTest,
  type HopTestAggregate,
  type HopTestResult,
} from "./hopTestState";

export type TunnelHopResult = HopTestResult;

export function createTunnelHopBatch(tunnelId: number) {
  return createHopTestBatch("tb", tunnelId);
}

export function registerTunnelHopTest(batchId: string, testId: number) {
  registerHopTest(batchId, testId);
}

export function recordTunnelHopTestResult(
  testId: number,
  result: TunnelHopResult,
  options?: {
    successPrefix?: string;
    failurePrefix?: string;
    totalLabel?: string;
    latencyMode?: "sum" | "max";
  },
): null | (Omit<HopTestAggregate, "ownerId"> & { tunnelId: number }) {
  const aggregate = recordHopTestResult(testId, result, {
    successPrefix: options?.successPrefix || "多级隧道逐跳测试成功",
    failurePrefix: options?.failurePrefix || "多级隧道逐跳测试失败",
    totalLabel: options?.totalLabel,
    latencyMode: options?.latencyMode,
  });
  if (!aggregate) return null;
  return {
    tunnelId: aggregate.ownerId,
    success: aggregate.success,
    latencyMs: aggregate.latencyMs,
    message: aggregate.message,
    details: aggregate.details,
  };
}
