import { t } from "@/i18n";
import { isAdminManagedRule, ruleTrafficUsed } from "../../../../shared/ruleLimits";

function bytes(value: number) {
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
  let index = 0;
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index++; }
  return `${value.toFixed(index ? 2 : 0)} ${units[index]}`;
}

/** Uses the same logical-rule counters and cumulative calculation as enforcement. */
export function RuleUsageSummary({ rule, totals }: { rule: any; totals?: { bytesIn: number; bytesOut: number } }) {
  if (!isAdminManagedRule(rule)) return null;
  const initialized = rule.quotaUsedIn != null && rule.quotaUsedOut != null;
  const known = initialized || !!totals;
  const used = ruleTrafficUsed(rule.trafficMode, initialized ? rule.quotaUsedIn : totals?.bytesIn || 0,
    initialized ? rule.quotaUsedOut : totals?.bytesOut || 0);
  const limit = Math.max(0, Number(rule.trafficLimit) || 0);
  const percent = limit ? Math.min(100, used / limit * 100) : 0;
  const mode = rule.trafficMode === "outbound" ? t("仅出向") : rule.trafficMode === "max" ? t("取最大值") : t("双向");
  return <div className="min-w-0 space-y-1 rounded-md border border-border/40 p-2 text-[11px] leading-4">
    <div className="flex flex-wrap justify-between gap-x-2 gap-y-1">
      <span className="text-muted-foreground">{t("管理员自定义规则")}</span>
      <span>{mode}</span>
    </div>
    <div className="break-words tabular-nums">{t("已用 {0} / 额度 {1}", [known ? bytes(used) : "—", limit ? bytes(limit) : t("不限")])}</div>
    {limit > 0 && known && <>
      <div role="progressbar" aria-label={t("流量用量")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(percent)} className="h-1 overflow-hidden rounded bg-muted">
        <div className={used >= limit ? "h-full bg-destructive" : "h-full bg-primary"} style={{ width: `${percent}%` }} />
      </div>
      <div className="text-muted-foreground">{t("剩余 {0}", [bytes(Math.max(0, limit - used))])}</div>
    </>}
    {rule.ruleLimitReason && <div className="text-destructive">{rule.ruleLimitReason === "expired" ? t("规则已到期") : t("规则流量额度已用尽")}</div>}
  </div>;
}
