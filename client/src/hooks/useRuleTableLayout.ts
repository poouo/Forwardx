import { useCallback, useMemo, useRef } from "react";
import { trpc } from "@/lib/trpc";
import { toast } from "@/lib/localizedToast";
import { t } from "@/i18n";
import { defaultRuleTableLayout, normalizeRuleTableLayout, ruleTableColumns, type RuleTableLayout } from "@shared/ruleTableLayout";

export function useRuleTableLayout(user: { id?: number; role?: string; ruleTableLayout?: unknown } | null) {
  const utils = trpc.useUtils();
  const mutation = trpc.auth.updateRuleTableLayout.useMutation();
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const revision = useRef(0);
  const layout = useMemo(() => normalizeRuleTableLayout(user?.ruleTableLayout), [user?.ruleTableLayout]);
  const setLayout = useCallback((next: RuleTableLayout) => {
    if (!user?.id) return;
    const accountId = user.id;
    const normalized = normalizeRuleTableLayout(next);
    const request = ++revision.current;
    utils.auth.me.setData(undefined, (current: typeof user) => current?.id === accountId ? { ...current, ruleTableLayout: JSON.stringify(normalized) } : current);
    // Serialize saves. A slower old response must never overwrite a newer edit.
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
    columns: useMemo(() => ruleTableColumns(layout, user?.role === "admin"), [layout, user?.role]),
    allColumns: useMemo(() => ruleTableColumns(layout, user?.role === "admin", true), [layout, user?.role]),
    reset: () => setLayout(defaultRuleTableLayout()),
  };
}
