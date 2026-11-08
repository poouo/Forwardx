import { structuredLinkTestMessage } from "./linkTestMessages";

/** Parallel entries are independent paths; never add their latencies together. */
export function buildPortEntrySelfTestResult(rows: any[]) {
  if (!rows.length) return undefined;
  const details = rows.map(row => {
    const request = JSON.parse(row.requestMessage);
    const pending = row.status === "pending" || row.status === "running";
    const success = row.status === "success" && Number(row.latencyMs) > 0;
    return { ...request, fromHostId: Number(row.hostId),
      routeLabel: `${request.sourceLabel} -> ${request.targetLabel}`,
      hopIndex: 0, hopCount: 1, pending, success,
      latencyMs: success ? Number(row.latencyMs) : null,
      message: pending ? null : row.status === "timeout" ? "探测超时：未在截止时间内收到 Agent 结果"
        : row.message === row.requestMessage ? null : row.message };
  });
  const pending = details.some(detail => detail.pending);
  const available = details.filter(detail => detail.success);
  const totalLatencyMs = available.length ? Math.max(...available.map(detail => detail.latencyMs)) : null;
  return { ...rows[rows.length - 1], status: pending ? "running" : available.length ? "success" : rows.some(row => row.status === "timeout") ? "timeout" : "failed",
    latencyMs: totalLatencyMs, listenOk: available.length > 0, targetReachable: available.length > 0, forwardOk: available.length > 0,
    message: structuredLinkTestMessage({ kind: "port-entry-summary", groupId: details[0].groupId, details, totalLatencyMs,
      message: pending ? `入口探测中：${details.filter(detail => !detail.pending).length}/${details.length}`
        : `入口探测完成：${available.length}/${details.length} 个入口可用` }) };
}
