import { useCallback, useMemo, useRef } from "react";
import { trpc } from "@/lib/trpc";
import { toast } from "@/lib/localizedToast";
import { t } from "@/i18n";
import { defaultHostTableLayout, normalizeHostTableLayout, hostTableColumns, type HostTableLayout } from "@shared/hostTableLayout";

export function useHostTableLayout(user: { id?: number; hostTableLayout?: unknown } | null) {
  const utils = trpc.useUtils();
  const mutation = trpc.auth.updateHostTableLayout.useMutation();
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const revision = useRef(0);
  const layout = useMemo(() => normalizeHostTableLayout(user?.hostTableLayout), [user?.hostTableLayout]);
  const setLayout = useCallback((next: HostTableLayout) => {
    if (!user?.id) return;
    const accountId = user.id;
    const normalized = normalizeHostTableLayout(next);
    const request = ++revision.current;
    utils.auth.me.setData(undefined, (current: typeof user) => current?.id === accountId ? { ...current, hostTableLayout: JSON.stringify(normalized) } : current);
    // Persist in order so older saves cannot overwrite the latest column edits.
    queue.current = queue.current.catch(() => {}).then(async () => {
      if (utils.auth.me.getData()?.id !== accountId) return;
      await mutation.mutateAsync({ accountId, layout: normalized });
    }).catch(() => {
      if (utils.auth.me.getData()?.id !== accountId) return;
      toast.error(t("列表设置保存失败"));
      if (request === revision.current) void utils.auth.me.invalidate();
    });
  }, [user?.id, utils, mutation.mutateAsync]);
  return {
    layout, setLayout,
    columns: useMemo(() => hostTableColumns(layout), [layout]),
    allColumns: useMemo(() => hostTableColumns(layout, true), [layout]),
    reset: () => setLayout(defaultHostTableLayout()),
  };
}
