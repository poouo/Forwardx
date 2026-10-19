import { useEffect, useSyncExternalStore } from "react";
import { t } from "@/i18n";
import type { ClientPage } from "../../../shared/clientRoutes";
import { getRouteModule } from "@/lib/routeModules";

export function RoutePagePlaceholder() {
  return (
    <div role="status" aria-label={t("加载中")} className="mx-auto w-full max-w-7xl space-y-4 p-4 sm:p-6">
      <div className="h-6 w-32 rounded bg-muted" />
      <div className="h-24 rounded-xl border border-border/50 bg-muted/30" />
      <span className="sr-only">{t("加载中")}</span>
    </div>
  );
}

export default function RoutePage({ page, pageProps }: { page: ClientPage; pageProps?: Record<string, unknown> }) {
  const resource = getRouteModule(page);
  const snapshot = useSyncExternalStore(resource.subscribe, resource.getSnapshot, resource.getSnapshot);
  useEffect(() => { void resource.load(); }, [resource]);
  if (snapshot.status === "ready" && snapshot.value) {
    const Component = snapshot.value.default;
    return <Component {...pageProps} />;
  }
  if (snapshot.status === "error") {
    return (
      <div role="alert" className="m-4 rounded-xl border p-4 text-sm sm:m-6">
        <p>{t("页面加载失败，请重试")}</p>
        <button className="mt-3 rounded-md border px-3 py-1.5 hover:bg-muted" onClick={() => void resource.load()}>{t("重试")}</button>
        <button className="ml-2 rounded-md border px-3 py-1.5 hover:bg-muted" onClick={() => window.location.reload()}>{t("刷新页面")}</button>
      </div>
    );
  }
  return <RoutePagePlaceholder />;
}
