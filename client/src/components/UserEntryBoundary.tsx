import { useEffect, useLayoutEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import { userEntry } from "@/lib/userImpersonation";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { StatValuePersistenceContext } from "./AnimatedStatValue";
import "./UserEntryBoundary.css";

function EntryBanner() {
  const banner = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.dataset.userEntry = "active";
    const measure = () => root.style.setProperty("--user-entry-height", `${banner.current?.offsetHeight || 48}px`);
    measure();
    const observer = new ResizeObserver(measure);
    if (banner.current) observer.observe(banner.current);
    return () => {
      observer.disconnect();
      delete root.dataset.userEntry;
      root.style.removeProperty("--user-entry-height");
    };
  }, []);
  const { data: user } = trpc.auth.me.useQuery(undefined, { retry: false, refetchOnWindowFocus: true, refetchInterval: 60_000 });
  const exit = trpc.auth.logout.useMutation({ onSettled: () => userEntry.finish() });
  return <div ref={banner} role="status" className="sticky top-0 z-[60] flex flex-wrap items-center justify-between gap-2 border-b border-amber-500/30 bg-amber-50 px-4 py-2 text-sm text-amber-950 dark:bg-amber-950 dark:text-amber-100">
    <span>{user ? t("正在以 {0} 的身份操作", [user.name || user.username]) : t("正在验证用户身份…")}</span>
    <Button size="sm" variant="outline" disabled={exit.isPending} onClick={() => exit.mutate()}>{t("退出代入")}</Button>
  </div>;
}

export function UserEntryBoundary({ children }: { children: ReactNode }) {
  const state = useSyncExternalStore(userEntry.subscribe, userEntry.getState);
  useEffect(() => {
    if (state.mode !== "active") return;
    const timer = setTimeout(userEntry.finish, Math.max(0, state.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [state]);
  if (state.mode === "ended") return <main className="flex min-h-svh flex-col items-center justify-center gap-4 px-6 text-center">
    <h1 className="text-xl font-semibold">{t("用户代入已结束")}</h1>
    <p className="text-sm text-muted-foreground">{t("请关闭此窗口，从用户管理重新进入。管理员原窗口不受影响。")}</p>
    <Button variant="outline" onClick={() => window.close()}>{t("关闭窗口")}</Button>
  </main>;
  return <StatValuePersistenceContext.Provider value={state.mode === "normal"}>
    {state.mode === "active" && <EntryBanner />}{children}
  </StatValuePersistenceContext.Provider>;
}
