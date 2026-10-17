import type { PortEntryRuntimeSummary as Summary } from "../../../shared/portEntryDiagnostics";
import { t, getFormatLocale } from "../i18n";
import { ChevronRight } from "lucide-react";
import { Button } from "./ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "./ui/dialog";

function time(value: number | null | undefined) {
  return value ? new Date(value).toLocaleString(getFormatLocale(), {month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit"}) : "—";
}

export function PortEntryRuntimeDetails({ summary }: { summary: Summary }) {
  const labels = {running:t("运行正常"),degraded:t("部分运行"),offline:t("离线"),excluded:t("流量达量已排除"),pending:t("等待下发"),idle:t("暂无启用规则"),disabled:t("停用")};
  return (
      <div className="min-h-0 space-y-3 overflow-y-auto overscroll-contain pr-1 text-xs [overflow-wrap:anywhere]">
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
  );
}

export function PortEntryRuntimeSummary({ summary, resourceName }: { summary?: Summary; resourceName?: string }) {
  if (!summary) return null;
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="h-auto w-full min-w-0 justify-between gap-2 bg-background/35 px-2.5 py-2 text-xs font-normal">
          <span className="min-w-0 truncate text-muted-foreground">{t("入口节点 {0}/{1}", [summary.runningHostCount, summary.expectedHostCount])}</span>
          <span className="inline-flex shrink-0 items-center gap-1">{t("节点详情")}<ChevronRight className="h-3.5 w-3.5" /></span>
        </Button>
      </DialogTrigger>
      <DialogContent className="flex max-h-[85svh] flex-col sm:max-w-xl">
        <DialogHeader className="shrink-0 pr-8">
          <DialogTitle>{t("节点详情")}</DialogTitle>
          <DialogDescription className="break-words [overflow-wrap:anywhere]">
            {resourceName && <span>{resourceName} · </span>}
            {t("入口节点 {0}/{1}", [summary.runningHostCount, summary.expectedHostCount])}
          </DialogDescription>
        </DialogHeader>
        <PortEntryRuntimeDetails summary={summary} />
        <DialogFooter className="shrink-0">
          <DialogClose asChild><Button variant="outline">{t("关闭")}</Button></DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
