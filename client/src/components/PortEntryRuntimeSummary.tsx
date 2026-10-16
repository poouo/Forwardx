import type { PortEntryRuntimeSummary as Summary } from "../../../shared/portEntryDiagnostics";
import { t, getFormatLocale } from "../i18n";

function time(value: number | null | undefined) {
  return value ? new Date(value).toLocaleString(getFormatLocale(), {month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit"}) : "—";
}

export function PortEntryRuntimeSummary({summary}: {summary?: Summary}) {
  if (!summary) return null;
  const labels = {running:t("运行正常"),degraded:t("部分运行"),offline:t("离线"),excluded:t("流量达量已排除"),pending:t("等待下发"),idle:t("暂无启用规则"),disabled:t("停用")};
  return (
    <details className="rounded-md border border-border/40 bg-background/35 text-xs">
      <summary className="cursor-pointer select-none px-2.5 py-2 text-muted-foreground">
        {t("入口节点 {0}/{1}", [summary.runningHostCount,summary.expectedHostCount])}
        <span className="ml-2">{t("节点详情")}</span>
      </summary>
      <div className="max-h-72 space-y-2 overflow-y-auto border-t border-border/40 p-2.5">
        <p className="text-muted-foreground">{t("全部启用规则运行且主机在线才计为正常节点；不代表端到端业务探测。")}</p>
        {summary.nodes.map((node) => (
          <div key={node.memberId} className="space-y-1.5 rounded-md bg-muted/25 p-2">
            <div className="flex flex-wrap items-center justify-between gap-1.5">
              <span className="min-w-0 break-words font-medium">{node.hostName || t("主机 #{0}",[node.hostId])}</span>
              <span className={node.status === "running" ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground"}>{node.status === "pending" && (node.runtimeErrors.length > 0 || node.syncDiagnostic) ? t("执行失败") : labels[node.status]}</span>
            </div>
            <p className="text-muted-foreground">{t("运行规则 {0}/{1}",[node.runningRuleCount,node.expectedRuleCount])}</p>
            {node.syncDiagnostic && <div className="space-y-1 text-amber-700 dark:text-amber-300">
              <p>{t("配置同步失败：{0} 条规则，尝试 {1} 次",[node.syncDiagnostic.failedRuleCount,node.syncDiagnostic.attempts])}</p>
              <p>{t("最近失败 {0}",[time(node.syncDiagnostic.lastFailedAt)])}</p>
              <p>{t("最早重试 {0}",[time(node.syncDiagnostic.nextRetryAt)])}</p>
              {node.syncDiagnostic.errors.map((error,index) => <p className="break-words" key={`${error.ruleId}:${index}`}>{t("规则 #{0}",[error.ruleId])} · {error.message}</p>)}
            </div>}
            {node.runtimeErrors.map((error) => <div key={error.runtimeRuleId} className="space-y-1 break-words text-amber-700 dark:text-amber-300">
              <p>{t("规则 #{0}",[error.ruleId])} · {error.message}</p>
              <p>{t("最近失败 {0}",[time(error.reportedAt)])}{error.consecutiveFailures ? ` · ${t("连续失败 {0} 次",[error.consecutiveFailures])}` : ""}</p>
              <p>{error.retryNotBefore ? t("Agent 最早重试 {0}",[time(error.retryNotBefore)]) : t("等待 Agent 重试，旧版未上报具体重试时间")}</p>
            </div>)}
          </div>
        ))}
        <p className="text-muted-foreground">{t("重试时间为最早可重试时间，实际执行取决于调度及 Agent 连接。每节点同步与执行错误各最多三条。")}</p>
      </div>
    </details>
  );
}
