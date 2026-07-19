import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc";
import { SESSION_BUSY_ERR_MSG } from "@shared/const";
import { Loader2, MonitorUp, RefreshCw } from "lucide-react";

const SESSION_BUSY_RETURN_PATH_KEY = "forwardx.sessionBusyReturnPath";

function sessionReturnPath() {
  if (typeof window === "undefined") return "/";
  const value = String(window.sessionStorage.getItem(SESSION_BUSY_RETURN_PATH_KEY) || "").trim();
  if (!value.startsWith("/") || value.startsWith("//") || value.startsWith("/login") || value.startsWith("/session-wait")) {
    return "/";
  }
  return value;
}

export default function SessionWait() {
  const mountedAtRef = useRef(Date.now());
  const me = trpc.auth.me.useQuery(undefined, {
    retry: false,
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
    refetchInterval: 3_000,
    refetchIntervalInBackground: true,
  });

  useEffect(() => {
    if (!me.data || me.dataUpdatedAt < mountedAtRef.current) return;
    const returnPath = sessionReturnPath();
    window.sessionStorage.removeItem(SESSION_BUSY_RETURN_PATH_KEY);
    window.location.replace(returnPath);
  }, [me.data, me.dataUpdatedAt]);

  const waiting = me.error?.message === SESSION_BUSY_ERR_MSG || me.isLoading || me.isFetching;

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-5 py-12 text-foreground">
      <div className="w-full max-w-md text-center">
        <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-full border border-border bg-muted/40 text-primary">
          <MonitorUp className="h-6 w-6" />
        </div>
        <h1 className="text-xl font-semibold">账号正在其他设备使用</h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          另一台设备停止使用后，此页面会自动恢复原登录状态，无需重新输入账号和密码。
        </p>
        <div className="mt-6 flex items-center justify-center gap-2 text-xs text-muted-foreground">
          {waiting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          <span>{waiting ? "正在等待可用状态" : "正在确认登录状态"}</span>
        </div>
        <Button type="button" variant="outline" className="mt-5" disabled={me.isFetching} onClick={() => void me.refetch()}>
          <RefreshCw className={`mr-2 h-4 w-4 ${me.isFetching ? "animate-spin" : ""}`} />
          立即检查
        </Button>
      </div>
    </main>
  );
}
