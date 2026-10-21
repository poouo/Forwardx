import { ArrowDownLeft, ArrowUpRight } from "lucide-react";
import { t } from "../i18n";

export type ResourceTrafficTotals = {
  bytesIn: number;
  bytesOut: number;
  totalBytes: number;
  ruleCount: number;
};

function formatBytes(value: number) {
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let size = Math.max(0, Number(value) || 0);
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit++; }
  return `${size.toFixed(unit === 0 || size >= 100 ? 0 : 2)} ${units[unit]}`;
}

export function ResourceTrafficSummary({ summary, compact = false, showRuleCount = true, table = false }: {
  summary?: ResourceTrafficTotals;
  compact?: boolean;
  showRuleCount?: boolean;
  table?: boolean;
}) {
  const title = t("汇总当前关联规则的累计实际流量，入向加出向，不按倍率折算；重置规则流量后同步更新。");
  if (table) return <div className="min-w-0 space-y-1 text-xs tabular-nums" title={`${title}\n${showRuleCount ? `${t("引用规则")} ${summary?.ruleCount ?? "—"} · ` : ""}${t("累计流量")} ${summary ? formatBytes(summary.totalBytes) : "—"}\n${t("入向")} ${summary ? formatBytes(summary.bytesIn) : "—"} · ${t("出向")} ${summary ? formatBytes(summary.bytesOut) : "—"}`}>
    <div className="flex min-w-0 items-baseline gap-3 whitespace-nowrap">
      {showRuleCount && <span className="shrink-0 text-muted-foreground">{t("引用规则")} {summary?.ruleCount ?? "—"}</span>}
      <span className="truncate font-medium">{summary ? formatBytes(summary.totalBytes) : "—"}</span>
    </div>
    <div className="flex min-w-0 gap-3 whitespace-nowrap text-muted-foreground">
      <span className="inline-flex min-w-0 items-center gap-1"><ArrowDownLeft className="h-3 w-3 shrink-0 text-sky-500" aria-label={t("入向")} /><span className="truncate">{summary ? formatBytes(summary.bytesIn) : "—"}</span></span>
      <span className="inline-flex min-w-0 items-center gap-1"><ArrowUpRight className="h-3 w-3 shrink-0 text-emerald-500" aria-label={t("出向")} /><span className="truncate">{summary ? formatBytes(summary.bytesOut) : "—"}</span></span>
    </div>
  </div>;
  return (
    <div className={compact ? "min-w-[10rem] space-y-1" : "space-y-2 rounded-md border border-border/40 bg-background/35 p-2.5"} title={title}>
      {showRuleCount && <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-xs" title={t("引用规则按逻辑规则去重，包含停用规则，不含待删除规则；普通用户仅统计自己的规则。")}>
        <span className="text-muted-foreground">{t("引用规则")}</span>
        <span className="font-medium tabular-nums">{summary ? summary.ruleCount : "—"}</span>
      </div>}
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        {!compact && <span className="text-xs text-muted-foreground">{t("累计流量")}</span>}
        <span className="text-sm font-medium tabular-nums">{summary ? formatBytes(summary.totalBytes) : "—"}</span>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground tabular-nums">
        <span className="inline-flex items-center gap-1" aria-label={t("入向")}>
          <ArrowDownLeft className="h-3 w-3 shrink-0 text-sky-500" aria-hidden="true" />
          <span>{t("入向")} {summary ? formatBytes(summary.bytesIn) : "—"}</span>
        </span>
        <span className="inline-flex items-center gap-1" aria-label={t("出向")}>
          <ArrowUpRight className="h-3 w-3 shrink-0 text-emerald-500" aria-hidden="true" />
          <span>{t("出向")} {summary ? formatBytes(summary.bytesOut) : "—"}</span>
        </span>
      </div>
    </div>
  );
}
