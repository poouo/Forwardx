import { getFormatLocale } from "@/i18n";
import { t as translateText } from "@/i18n";
import { useEffect, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { AlertTriangle, RefreshCw, Database } from "lucide-react";
import type { DatabaseHealth } from "@shared/databaseHealth";
import { mobileAuth } from "@/lib/mobileAuth";

export function DatabaseUnavailableView({ health, checking, onRetry }: {
  health: DatabaseHealth;
  checking: boolean;
  onRetry: () => void;
}) {
  return (
    <main className="min-h-screen bg-background px-5 py-12 text-foreground flex items-center justify-center">
      <section className="w-full max-w-2xl rounded-2xl border bg-card p-6 shadow-sm sm:p-9" role="alert">
        <div className="mb-6 flex items-center gap-3">
          <div className="rounded-xl bg-amber-500/10 p-3 text-amber-600"><AlertTriangle className="h-6 w-6" /></div>
          <div><h1 className="text-xl font-semibold">{translateText("数据库暂时不可用")}</h1><p className="mt-1 text-sm text-muted-foreground">{translateText("面板 Web 服务仍在运行，数据库相关功能暂时暂停。")}</p></div>
        </div>
        <div className="space-y-4 rounded-xl border bg-muted/30 p-5">
          <div className="flex items-center gap-2 text-sm font-medium"><Database className="h-4 w-4" />{health.databaseType === "postgresql" ? "PostgreSQL" : health.databaseType === "mysql" ? "MySQL" : health.databaseType === "sqlite" ? "SQLite" : translateText("数据库")}</div>
          <div><p className="text-sm text-muted-foreground">{translateText("异常原因")}</p><p className="mt-1 break-words font-medium">{health.reason?.message || translateText("数据库服务暂时无法访问")}</p>{health.reason?.code && <code className="mt-2 inline-block rounded bg-muted px-2 py-1 text-xs">{health.reason.code}</code>}</div>
          <p className="text-sm leading-6">{health.reason?.suggestion || translateText("请联系管理员检查数据库服务和面板日志。")}</p>
          {health.restartRequired && <p className="text-sm text-amber-700 dark:text-amber-400">{translateText("连接故障恢复后会自动重试初始化；若为结构、配置或存储错误，请检查日志，修正后重启面板。")}</p>}
          {health.unavailableSince && <p className="text-xs text-muted-foreground">{translateText("异常检测时间：")}{new Date(health.unavailableSince).toLocaleString(getFormatLocale())}</p>}
          {health.checkedAt && <p className="text-xs text-muted-foreground">{translateText("最近检查：")}{new Date(health.checkedAt).toLocaleString(getFormatLocale())}</p>}
        </div>
        <div className="mt-6 flex flex-wrap items-center gap-4">
          <button type="button" disabled={checking} onClick={onRetry} className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"><RefreshCw className={`h-4 w-4 ${checking ? "animate-spin" : ""}`} />{checking ? translateText("检查中") : translateText("重新检查")}</button>
          <p className="text-xs text-muted-foreground">{translateText("自动检查恢复状态，不会清除你的登录信息。")}</p>
        </div>
        <p className="mt-6 text-xs leading-5 text-muted-foreground">{translateText("管理员可查看本地部署的 journalctl 服务日志，或 Docker 的 docker logs 容器日志。页面仅展示安全错误摘要，不公开数据库密码和连接串。")}</p>
      </section>
    </main>
  );
}

export default function DatabaseHealthGate({ children }: { children: ReactNode }) {
  useLocation(); // Re-read the native panel URL when navigating after setup.
  const queryClient = useQueryClient();
  const panelUrl = mobileAuth.isNative ? mobileAuth.getPanelUrl() : "";
  const health = useQuery<DatabaseHealth | null>({
    queryKey: ["database-health", panelUrl],
    enabled: !mobileAuth.isNative || mobileAuth.hasPanelUrl(),
    queryFn: async ({ signal }) => {
      const response = await fetch(`${panelUrl}/api/database-health`, { signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]), cache: "no-store" });
      // Older panels may not have this endpoint; keep their normal bootstrap.
      if (!response.ok) return null;
      const data = await response.json();
      return ["checking", "healthy", "unavailable", "not_configured"].includes(data?.state) ? data : null;
    },
    retry: false,
    refetchOnWindowFocus: true,
    refetchInterval: (query) => query.state.data?.state === "unavailable" ? 5000 : 15_000,
  });
  useEffect(() => {
    if (health.data?.state === "healthy") {
      // Fresh session/account checks are still performed after DB recovery.
      void queryClient.invalidateQueries({ predicate: (query) => query.queryKey[0] !== "database-health" });
    }
  }, [health.data?.state, queryClient]);

  if (health.isLoading) return <div className="flex min-h-screen items-center justify-center text-sm text-muted-foreground" role="status">{translateText("正在检查面板状态…")}</div>;
  if (health.data?.state === "unavailable") return <DatabaseUnavailableView health={health.data} checking={health.isFetching} onRetry={() => { void health.refetch(); }} />;
  return <>{children}</>;
}
