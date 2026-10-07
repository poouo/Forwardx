import { queryRaw, executeRaw, getDatabaseKind, rawAffectedRows, withDatabaseTransaction } from "./dbRuntime";
import { quoteIdentifier as q, boolLiteral } from "./dbCompat";
import { aggregateHopTestResults } from "./hopTestState";
import { structuredLinkTestMessage } from "./linkTestMessages";
import { insertForwardGroupLatencyStat } from "./repositories/metricsRepository";
import { updateForwardTestResult } from "./repositories/forwardTestRepository";
import { selfTestSweepActivity } from "./selfTestTiming";
import { appendPanelLog } from "./_core/panelLogger";

export async function settleManualForwardChainBatch(batchId: string) {
  if (!batchId?.startsWith("fc-")) return false;
  return withDatabaseTransaction(async () => {
    const lock = getDatabaseKind() === "sqlite" ? "" : " FOR UPDATE";
    const rows = await queryRaw<any>(`SELECT * FROM ${q("forward_tests")} WHERE ${q("batchId")} = ? ORDER BY ${q("id")}${lock}`, [batchId]);
    if (!rows.length || rows.every(row => row.batchSettled === true || Number(row.batchSettled) === 1)
      || rows.some(row => ["pending", "running"].includes(row.status))) return false;
    const meta = JSON.parse(rows[0].requestMessage);
    const aggregate = aggregateHopTestResults(Number(meta.groupId), rows.map(row => {
      const request = JSON.parse(row.requestMessage);
      const success = row.status === "success" && Number(row.latencyMs) > 0;
      return {
        success, latencyMs: success ? Number(row.latencyMs) : null,
        message: row.status === "timeout" ? "探测超时：未收到 Agent 结果" : row.message,
        hopLabel: request.hopLabel, routeLabel: request.routeLabel, method: request.method,
      };
    }), {
      successPrefix: "转发链逐跳测试成功", failurePrefix: "转发链逐跳测试失败",
      latencyMode: ["remaining-path", "multi-source-remaining-path"].includes(meta.latencyMode) ? meta.latencyMode : "sum",
    });
    const claimed = await executeRaw(`UPDATE ${q("forward_tests")} SET ${q("batchSettled")} = ${boolLiteral(true)}
      WHERE ${q("batchId")} = ? AND ${q("batchSettled")} = ${boolLiteral(false)}`, [batchId]);
    if (!rawAffectedRows(claimed)) return false;
    // Keep raw per-hop reports intact; only the last row carries the public
    // summary, matching getLatestForwardTest's existing result contract.
    await updateForwardTestResult(Number(rows[rows.length - 1].id), {
      status: aggregate.success ? "success" : "failed", latencyMs: aggregate.latencyMs,
      listenOk: aggregate.success, forwardOk: aggregate.success, targetReachable: aggregate.success,
      message: structuredLinkTestMessage({ kind: "forward-chain-hop-summary", groupId: Number(meta.groupId),
        message: aggregate.message, details: aggregate.details, totalLatencyMs: aggregate.latencyMs }),
    });
    await insertForwardGroupLatencyStat({ groupId: Number(meta.groupId), latencyMs: aggregate.latencyMs, isTimeout: !aggregate.success });
    appendPanelLog(aggregate.success ? "info" : "warn", `[SelfTest] forward-chain=${meta.groupId} batch=${batchId} completed segments=${rows.length} success=${aggregate.success} latency=${aggregate.latencyMs ?? "-"}ms`);
    return true;
  });
}

export async function recoverManualForwardChainBatches() {
  const batches = await queryRaw<{ batchId: string }>(`SELECT ${q("batchId")} FROM ${q("forward_tests")}
    WHERE ${q("batchSettled")} = ${boolLiteral(false)} AND ${q("batchId")} LIKE 'fc-%'
    GROUP BY ${q("batchId")} HAVING SUM(CASE WHEN ${q("status")} IN ('pending', 'running') THEN 1 ELSE 0 END) = 0 LIMIT 100`);
  for (const { batchId } of batches) await settleManualForwardChainBatch(batchId);
  if (batches.length === 100) selfTestSweepActivity.markActive();
}
