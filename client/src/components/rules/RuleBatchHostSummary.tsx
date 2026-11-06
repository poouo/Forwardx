import { Server } from "lucide-react";
import { t } from "@/i18n";
import { ruleBatchHostLabel, type RuleBatchHost } from "@/lib/ruleBatchHosts";

export function RuleBatchHostSummary({ hosts }: { hosts: readonly RuleBatchHost[] }) {
  const detail = hosts.length ? hosts.map(ruleBatchHostLabel).join("\n") : t("未知");
  const preview = hosts.slice(0, 2).map(ruleBatchHostLabel).join(" / ");
  return <span className="mt-1 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground" title={detail}>
    <Server aria-hidden="true" className="size-3 shrink-0" />
    <span className="shrink-0">{t("入口主机")}:</span>
    <span className="min-w-0 truncate">{preview || t("未知")}</span>
    {hosts.length > 2 && <span className="shrink-0 tabular-nums">+{hosts.length - 2}</span>}
  </span>;
}
