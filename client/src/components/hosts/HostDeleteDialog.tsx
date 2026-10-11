import { useEffect, useState } from "react";
import { Link } from "wouter";
import { Loader2 } from "lucide-react";
import { t } from "@/i18n";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export default function HostDeleteDialog({ hostId, onClose, onDelete, pending }: {
  hostId: number; onClose: () => void;
  onDelete: (input: { id: number; confirmOfflineCleanup: boolean }) => void;
  pending: boolean;
}) {
  const [confirmOfflineCleanup, setConfirmOfflineCleanup] = useState(false);
  const prepare = trpc.hosts.prepareDelete.useMutation({ retry: false });
  const prepareDelete = prepare.mutate;
  useEffect(() => { prepareDelete({ id: hostId }); }, [hostId, prepareDelete]);
  const impact = trpc.hosts.deleteImpact.useQuery({ id: hostId }, {
    enabled: prepare.isSuccess,
    retry: false, staleTime: 0,
    refetchInterval: (query) => query.state.data?.pendingCleanupCount ? 3000 : false,
    refetchIntervalInBackground: false,
  });
  const data = impact.data;
  const waiting = !!data?.online && data.pendingCleanupCount > 0;
  const offlineCleanup = !!data && !data.online && data.pendingCleanupCount > 0;
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !pending) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="break-words">{t("删除主机")}{data ? ` · ${data.hostName}` : ""}</DialogTitle>
          <DialogDescription>{t("删除前检查真实依赖；移出转发组后不需要逐条重新保存规则。")}</DialogDescription>
        </DialogHeader>
        {(prepare.isPending || !prepare.isError && impact.isLoading) && <p className="flex items-center gap-2 text-sm"><Loader2 className="h-4 w-4 animate-spin" />{t("正在检查关联配置...")}</p>}
        {prepare.isError && <p role="alert" className="break-words text-sm text-destructive">{t(prepare.error.message)}</p>}
        {impact.isError && <p role="alert" className="break-words text-sm text-destructive">{t(impact.error.message)}</p>}
        {data && <div className="max-h-[50vh] space-y-4 overflow-y-auto text-sm">
          {data.blocked ? <>
            <p className="text-amber-600 dark:text-amber-400">{t("该主机仍被以下配置使用，请先移除引用。停用的配置也会保留依赖保护。")}</p>
            {[
              { label: "转发规则", refs: data.rules, href: "/rules" },
              { label: "转发组 / 转发链 / 入口组 / 出口组", refs: data.groups, href: "/forward-groups" },
              { label: "隧道", refs: data.tunnels, href: "/tunnels" },
            ].filter((section) => section.refs.count > 0).map((section) => (
              <section key={section.href} className="rounded-md border p-3">
                <div className="flex flex-wrap items-center justify-between gap-2 font-medium">
                  <span>{t(section.label)} ({section.refs.count})</span>
                  <Link href={section.href} className="text-primary underline" onClick={onClose}>{t("前往处理")}</Link>
                </div>
                <ul className="mt-2 space-y-1 break-words text-muted-foreground">
                  {section.refs.items.map((item) => <li key={item.id}>{item.name} (#{item.id})</li>)}
                  {section.refs.count > section.refs.items.length && <li>{t("仅展示前 50 项")}</li>}
                </ul>
              </section>
            ))}
          </> : <p>{t("确定要删除此主机吗？删除后相关状态和配置会同步移除。")}</p>}
          {waiting && <p role="status" className="text-amber-600 dark:text-amber-400">{t("Agent 正在清理已移除的规则，将自动刷新检查结果；不需要重新保存规则。")}</p>}
          {offlineCleanup && !data.blocked && <div className="space-y-3 rounded-md border border-destructive/40 p-3">
            <p className="text-destructive">{t("主机离线，无法确认旧转发已停止。移除面板记录不会停止离线主机上的进程，请自行停止或卸载 Agent。")}</p>
            <label className="flex items-center gap-3">
              <Switch checked={confirmOfflineCleanup} onCheckedChange={setConfirmOfflineCleanup} />
              <span>{t("我已了解风险，仍要移除离线主机记录")}</span>
            </label>
          </div>}
        </div>}
        <DialogFooter className="flex-wrap gap-2">
          <Button variant="outline" disabled={pending || prepare.isPending || impact.isFetching} onClick={() => { setConfirmOfflineCleanup(false); if (prepare.isError) prepareDelete({ id: hostId }); else void impact.refetch(); }}>{t("重新检查")}</Button>
          <Button variant="outline" disabled={pending} onClick={onClose}>{t("取消")}</Button>
          <Button variant="destructive" disabled={pending || !prepare.isSuccess || impact.isFetching || impact.isError || !data || data.blocked || waiting || (offlineCleanup && !confirmOfflineCleanup)}
            onClick={() => onDelete({ id: hostId, confirmOfflineCleanup: offlineCleanup && confirmOfflineCleanup })}>
            {pending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}{t("删除")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
