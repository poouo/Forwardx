import { useEffect, useRef, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { CheckCircle2, Loader2, AlertCircle, X } from "lucide-react";
import { useAuth } from "@/_core/hooks/useAuth";
import { trpc } from "@/lib/trpc";
import { t } from "@/i18n";
import { configureRuleTasks, dismissRuleTask, ruleTaskScope, ruleTaskTracker, updateRuleTasks, type TrackedRuleTask } from "@/lib/ruleTaskTracker";
import type { RuleTaskSnapshot } from "@shared/ruleTaskQueue";

export function RuleTaskProgress({ task, lost, onStop, onDismiss }: { task: RuleTaskSnapshot; lost?: boolean; onStop?: () => void; onDismiss?: () => void }) {
  const done = !!task.finishedAt || lost;
  const processed = task.completed - task.cancelled;
  const percent = task.total ? Math.min(100, Math.floor(processed * 100 / task.total)) : 0;
  const failed = lost || task.failed > 0 || task.cancelled > 0;
  const Icon = done ? failed ? AlertCircle : CheckCircle2 : Loader2;
  const status = lost ? t("任务状态待核对") : task.state === "cancelled" ? t("已停止") : done ? task.failed ? t(task.failed === task.total ? "执行失败" : "部分执行失败") : task.skipped === task.total ? t("处理完成") : t("执行成功") : task.state === "queued" ? t("排队中") : t("执行中");
  return <div className="w-[min(356px,calc(100vw-2rem))] rounded-xl border border-border bg-background p-4 text-foreground shadow-lg" role="status">
    <div className="flex items-start gap-2.5">
      <Icon className={`mt-0.5 size-4 shrink-0 ${done ? failed ? "text-amber-500" : "text-emerald-500" : "text-primary motion-safe:animate-spin"}`} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{t(task.title)}</div>
        <div className="mt-1 flex items-center justify-between gap-3 text-xs text-muted-foreground"><span>{status} {processed} / {task.total}</span><span className="tabular-nums">{percent}%</span></div>
      </div>
      {done && <button type="button" className="shrink-0 text-muted-foreground hover:text-foreground" aria-label={t("关闭")} onClick={onDismiss}><X className="size-4" /></button>}
    </div>
    {!lost && <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted" role="progressbar" aria-label={status} aria-valuemin={0} aria-valuemax={task.total} aria-valuenow={processed}><div className={`h-full rounded-full ${failed ? "bg-amber-500" : done ? "bg-emerald-500" : "bg-primary"}`} style={{ width: `${percent}%` }} /></div>}
    {lost ? <p className="mt-2 text-xs leading-5 text-muted-foreground">{t("面板可能已重启或任务已过期，请核对规则后再操作，不要重复提交")}</p>
      : <div className="mt-2 flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span title={t("执行成功表示面板操作完成，Agent 应用及网络连通情况请查看规则状态")}>{t("成功 {0} · 失败 {1} · 跳过 {2}", [task.succeeded, task.failed, task.skipped])}{task.cancelled ? t(" · 未执行 {0}", [task.cancelled]) : ""}</span>
        {!done && onStop && <button type="button" className="shrink-0 hover:text-foreground" onClick={onStop} title={t("当前项执行完后停止，不撤销已完成操作")}>{t("停止排队")}</button>}
      </div>}
    {done && task.failed > 0 && <p className="mt-2 line-clamp-2 text-xs text-muted-foreground">{task.results?.find(row => row.status === "failed")?.error}</p>}
  </div>;
}

export default function RuleTaskNotifications() {
  const { user } = useAuth();
  const utils = trpc.useUtils();
  const all = useSyncExternalStore(ruleTaskTracker.subscribe, ruleTaskTracker.snapshot, ruleTaskTracker.snapshot);
  const scope = user ? ruleTaskScope(user.id) : "";
  const tracked = all.filter(row => row.ownerId === user?.id && row.scope === scope);
  const pending = tracked.filter(row => !row.task.finishedAt && !row.lost);
  const ids = pending.map(row => row.task.id);
  const query = trpc.rules.taskStatus.useQuery({ ids }, { enabled: !!user && ids.length > 0, retry: false, staleTime: 0,
    refetchInterval: query => Math.min(10_000, 1500 * 2 ** Math.min(query.state.fetchFailureCount, 3)),
    refetchIntervalInBackground: false, refetchOnWindowFocus: true });
  const cancel = trpc.rules.cancelTask.useMutation({ onSuccess: () => { void query.refetch(); }, onError: error => toast.error(error.message) });
  const finished = useRef(new Set<string>());
  const shown = useRef(new Map<string, TrackedRuleTask>());
  useEffect(() => { if (user) configureRuleTasks(user.id); }, [user?.id, scope]);
  useEffect(() => { if (user && query.data) updateRuleTasks(user.id, query.data.instanceId, ids, query.data.tasks); }, [query.data, user?.id]);
  useEffect(() => {
    const visible = new Set(tracked.map(row => row.task.id));
    for (const id of finished.current) if (!visible.has(id)) finished.current.delete(id);
    for (const id of shown.current.keys()) if (!visible.has(id)) { toast.dismiss(`rule-task:${id}`); shown.current.delete(id); }
    for (const row of tracked) {
      if (shown.current.get(row.task.id) === row) continue;
      shown.current.set(row.task.id, row);
      const done = !!row.task.finishedAt || row.lost;
      toast.custom(() => <RuleTaskProgress task={row.task} lost={row.lost}
        onStop={() => cancel.mutate({ id: row.task.id })}
        onDismiss={() => { toast.dismiss(`rule-task:${row.task.id}`); dismissRuleTask(row.task.id); }} />,
      { id: `rule-task:${row.task.id}`, dismissible: !!done,
        onAutoClose: () => { if (done) dismissRuleTask(row.task.id); },
        onDismiss: () => { if (done) dismissRuleTask(row.task.id); },
        duration: done ? row.lost || row.task.failed || row.task.cancelled ? 30_000 : 8_000 : Infinity });
      if (done && !finished.current.has(row.task.id)) {
        finished.current.add(row.task.id);
        void Promise.all([utils.rules.invalidate(), utils.auth.me.invalidate(), utils.billing.me.invalidate()]);
      }
    }
  }, [all, user?.id, scope]);
  return null;
}
