import { t as translateText } from "@/i18n";
import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { mobileAuth } from "@/lib/mobileAuth";
import { useLocation } from "wouter";

type Status = { state: null | { role: "source" | "target"; phase: string; targetUrl: string; sourceUrl: string; imported?: boolean; busy?: boolean;
  job?: { step: string; progress: number; error?: string }; readiness?: { hosts: number; rules: number; tunnels: number } } };

export function SeamlessMigrationGate({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const panelUrl = mobileAuth.isNative ? mobileAuth.getPanelUrl() : "";
  const status = useQuery<Status>({
    queryKey: ["seamless-migration-status", panelUrl],
    enabled: !mobileAuth.isNative || mobileAuth.hasPanelUrl(),
    queryFn: async ({ signal }) => {
      const response = await fetch(`${panelUrl}/api/migration/seamless-status`, { cache: "no-store", signal: AbortSignal.any([signal, AbortSignal.timeout(8_000)]) });
      if (response.status === 404) return { state: null }; // older panels
      if (!response.ok) throw new Error(translateText("迁移状态暂时无法读取"));
      const data = await response.json();
      return data.protocol === 1 ? data : { state: null };
    },
    refetchInterval: 5_000, staleTime: 3_000, retry: false,
  });
  const resume = trpc.system.resumeSeamlessMigration.useMutation({ onSettled: () => { void status.refetch(); } });
  const cancel = trpc.system.cancelSeamlessSourceMigration.useMutation({ onSettled: () => { void status.refetch(); } });
  const state = status.data?.state;
  if (!state || (state.role === "target" && state.phase === "active")) return children;
  const target = state.role === "target";
  // Imported accounts must log in again before an operator can resume a
  // migration after a process/network failure. Never expose a public commit.
  const loginPage = target && location === "/login";
  const content = <section className="mx-auto w-full max-w-xl rounded-xl border bg-card p-6 shadow-sm space-y-4">
    <h1 className="text-xl font-semibold">{target ? translateText("无缝迁移验证中") : state.phase === "frozen" ? translateText("面板迁移中，已暂停新操作") : translateText("面板已迁移，旧数据保留")}</h1>
    <p className="text-sm text-muted-foreground">{translateText("迁移不会要求重启 Agent 或现有转发进程。旧面板数据库不会自动删除。")}</p>
    {target ? <>
      <p>{state.job?.step || translateText("等待继续验证")} {state.job ? `${state.job.progress}%` : ""}</p>
      {state.readiness && <p className="text-sm">{translateText("待验证：")}{state.readiness.hosts}{translateText(" 台主机 / ")}{state.readiness.rules}{translateText(" 条规则 / ")}{state.readiness.tunnels}{translateText(" 条隧道")}</p>}
      {state.job?.error && <p className="text-sm text-destructive">{state.job.error}</p>}
      <p className="text-sm text-muted-foreground">{translateText("旧地址 ")}{state.sourceUrl}{translateText(" 必须持续可访问。中断后请使用迁移前的管理员账号登录新面板，继续验证；不要重新启用旧数据库写入。")}</p>
      {state.imported && <div className="flex gap-3">
        <Button asChild variant="outline"><a href="/login">{translateText("登录管理员")}</a></Button>
        <Button disabled={state.busy || resume.isPending} onClick={() => resume.mutate()}>{state.busy || resume.isPending ? translateText("正在验证…") : translateText("继续验证并接管")}</Button>
      </div>}
      {resume.error && <p className="text-sm text-destructive">{resume.error.message}</p>}
    </> : <>
      <p className="text-sm">{state.phase === "frozen" ? translateText("正在导出一致快照。未完成转交的冻结会在一小时后解除。") : translateText("此地址继续转交 Agent 和支付回调，请勿停止或卸载旧面板。")}</p>
      <Button asChild><a href={state.targetUrl}>{translateText("打开新面板")}</a></Button>
      {state.phase === "frozen" && <div className="space-y-2">
        <Button variant="outline" disabled={cancel.isPending} onClick={() => {
          if (window.confirm(translateText("取消尚未接管的迁移并恢复旧面板写入？新端已导入的快照将无法继续接管，需重新准备空目标迁移。"))) cancel.mutate();
        }}>{translateText("管理员取消未接管的迁移")}</Button>
        <p className="text-xs text-muted-foreground">{translateText("需要迁移前仍有效的管理员登录会话；请求已转交后禁止此操作。")}</p>
        {cancel.error && <p className="text-sm text-destructive">{cancel.error.message}</p>}
      </div>}
    </>}
  </section>;
  if (loginPage) return <><div className="p-4">{content}</div>{children}</>;
  return <main className="min-h-screen bg-background p-6 flex items-center justify-center">{content}</main>;
}
