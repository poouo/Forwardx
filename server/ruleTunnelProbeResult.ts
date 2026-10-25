import { structuredLinkTestMessage } from "./linkTestMessages";

/** A batch owns its samples: a fast entry never completes a slower entry. */
export function buildRuleTunnelProbeResult(rows: any[]) {
  if (!rows.length) return undefined;
  const details = rows.map(row => {
    const request = JSON.parse(row.requestMessage);
    const pending = row.status === "pending" || row.status === "running";
    const success = row.status === "success" && Number(row.latencyMs) > 0;
    return {
      ...request, pending, success, latencyMs: success ? Number(row.latencyMs) : null,
      message: pending ? null : row.status === "timeout"
        ? "探测超时：未在截止时间内收到 Agent 结果"
        : row.message === row.requestMessage ? null : row.message,
    };
  });
  const pending = details.some(detail => detail.pending);
  const paths = new Map<string, typeof details>();
  for (const detail of details) for (const key of detail.pathKeys || []) {
    const path = paths.get(key) || [];
    path.push(detail);
    paths.set(key, path);
  }
  const available = [...paths.values()].filter(path => path.every(detail => detail.success));
  const success = available.length > 0;
  const latencyMs = success ? Math.max(...available.map(path => path.reduce((sum, detail) => sum + detail.latencyMs, 0))) : null;
  const completed = details.filter(detail => !detail.pending).length;
  const status = pending ? "running" : success ? "success"
    : details.some(detail => detail.message?.startsWith("探测超时")) ? "timeout" : "failed";
  const last = rows[rows.length - 1];
  return {
    ...last, status, latencyMs, listenOk: success, targetReachable: success, forwardOk: success,
    message: structuredLinkTestMessage({ kind: "forward-via-tunnel", tunnelId: Number(details[0].tunnelId),
      message: pending ? `链路探测中：${completed}/${rows.length}` : success
        ? `隧道整体链路测试成功（${available.length}/${paths.size} 路可用）`
        : "隧道整体链路测试失败，请查看分段详情",
      details, totalLatencyMs: latencyMs,
    }),
  };
}
