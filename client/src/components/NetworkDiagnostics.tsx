import { trpc } from "@/lib/trpc";
import { t } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Activity } from "lucide-react";
import { copyTextToClipboard } from "@/lib/clipboard";
import { toast } from "@/lib/localizedToast";

export default function NetworkDiagnostics({ hostId }: { hostId: number }) {
  const report = trpc.lookingGlass.diagnose.useQuery({ hostId }, { enabled: false, retry: false });
  // Query keys isolate hosts; never show a previous machine's report during selection changes.
  return <Card><CardHeader className="flex-row items-center justify-between gap-2"><CardTitle className="flex items-center gap-2 text-base"><Activity className="size-4 text-sky-500" />{t("网络配置体检")}</CardTitle><Button variant="outline" disabled={!hostId || report.isFetching} onClick={() => void report.refetch()}>{report.isFetching ? t("检查中") : t("开始检查")}</Button></CardHeader>
    <CardContent className="space-y-3"><p className="text-xs text-muted-foreground">{t("检查当前主机的 Agent、资源采样和配置状态，不发送额外探测。")}</p>
      {report.error && <p role="alert" className="text-sm text-destructive">{report.error.message}</p>}
      {report.data && <><div className="grid gap-2 sm:grid-cols-2">{report.data.checks.map(item => <div key={item.name} className="rounded-lg border p-3"><p className="flex items-center gap-2 text-sm"><span className={`size-2 shrink-0 rounded-full ${item.status === "ok" ? "bg-emerald-500" : item.status === "error" ? "bg-red-500" : item.status === "warning" ? "bg-amber-500" : "bg-slate-400"}`} />{t(item.name)}</p><p className="mt-1 text-xs text-muted-foreground">{t(item.messageTemplate || item.message, item.messageArgs)}</p></div>)}</div>
        <div className="flex flex-wrap items-center justify-between gap-2"><span className="text-xs text-muted-foreground">{report.data.resourceName} · {new Date(report.data.sampledAt).toLocaleString()}</span><Button size="sm" variant="outline" onClick={async () => { if (await copyTextToClipboard(JSON.stringify(report.data, null, 2))) toast.success(t("已复制")); else toast.error(t("复制失败")); }}>{t("复制排查报告")}</Button></div></>}
    </CardContent></Card>;
}
