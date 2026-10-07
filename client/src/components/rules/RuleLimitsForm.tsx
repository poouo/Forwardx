import DatePickerInput, { formatDateInputValue, parseDateInputValue } from "@/components/DatePickerInput";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { t } from "@/i18n";
import type { RuleTrafficMode } from "@shared/ruleLimits";
import { ruleTrafficUsed } from "@shared/ruleLimits";

export type RuleLimitsFormValue = {
  speed: string; quota: string; mode: RuleTrafficMode;
  createdDate: string; createdTime: string; expiresDate: string; expiresTime: string;
  quotaUsedIn: number | null; quotaUsedOut: number | null;
};
function timeText(value: Date) {
  return [value.getHours(), value.getMinutes(), value.getSeconds()].map(n => String(n).padStart(2, "0")).join(":");
}
export function newRuleLimitsForm(rule?: any): RuleLimitsFormValue {
  const created = rule?.createdAt ? new Date(rule.createdAt) : new Date();
  const expires = rule?.expiresAt ? new Date(rule.expiresAt) : null;
  return { speed: String(rule?.rateLimitMbps || ""), quota: rule?.trafficLimit ? String(rule.trafficLimit / 1024 ** 3) : "",
    mode: ["outbound", "max"].includes(rule?.trafficMode) ? rule.trafficMode : "both",
    createdDate: formatDateInputValue(created), createdTime: timeText(created),
    expiresDate: expires ? formatDateInputValue(expires) : "", expiresTime: expires ? timeText(expires) : "23:59:59",
    quotaUsedIn: rule?.quotaUsedIn == null ? null : Number(rule.quotaUsedIn), quotaUsedOut: rule?.quotaUsedOut == null ? null : Number(rule.quotaUsedOut) };
}
export function ruleLimitsPayload(value: RuleLimitsFormValue) {
  const speed = Number(value.speed || 0);
  const quota = Number(value.quota || 0);
  if (!Number.isInteger(speed) || speed < 0 || speed > 1_000_000 || !Number.isFinite(quota) || quota < 0 || quota * 1024 ** 3 > Number.MAX_SAFE_INTEGER) {
    throw new Error(t("请输入有效的限速和流量额度"));
  }
  const timestamp = (date: string, time: string) => {
    const result = parseDateInputValue(date);
    if (!result || !/^\d{2}:\d{2}(:\d{2})?$/.test(time)) throw new Error(t("请选择有效的日期和时间"));
    const [hours, minutes, seconds = 0] = time.split(":").map(Number);
    if (hours > 23 || minutes > 59 || seconds > 59) throw new Error(t("请选择有效的日期和时间"));
    result.setHours(hours, minutes, seconds, 0);
    return result;
  };
  const createdAt = timestamp(value.createdDate, value.createdTime);
  const expiresAt = value.expiresDate ? timestamp(value.expiresDate, value.expiresTime) : null;
  if (expiresAt && expiresAt <= createdAt) throw new Error(t("到期时间必须晚于创建时间"));
  return { rateLimitMbps: speed, trafficLimit: Math.max(quota > 0 ? 1 : 0, Math.round(quota * 1024 ** 3)), trafficMode: value.mode, createdAt, expiresAt };
}

export function RuleLimitsForm({ value, onChange }: { value: RuleLimitsFormValue; onChange: (value: RuleLimitsFormValue) => void }) {
  const patch = (data: Partial<RuleLimitsFormValue>) => onChange({ ...value, ...data });
  return <details className="rounded-lg border border-border/60 bg-muted/20 p-3">
    <summary className="cursor-pointer text-sm font-medium">{t("单条规则限额与有效期")}</summary>
    <div className="mt-4 space-y-4">
      <p className="text-xs text-muted-foreground">{t("管理员可为本人或其他用户的规则设置独立限额；本人账户下提供给他人使用的规则同样适用。")}</p>
      <p className="text-xs text-muted-foreground">{t("0 或留空表示不限制；流量按当前累计统计计算，与用户账户限制同时生效。")}</p>
      {value.quotaUsedIn !== null && <p className="text-xs text-muted-foreground">{t("已用额度：{0} 字节", [ruleTrafficUsed(value.mode, value.quotaUsedIn || 0, value.quotaUsedOut || 0).toLocaleString()])}</p>}
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2"><Label>{t("速度限制 (Mbps)")}</Label><Input type="number" min="0" max="1000000" step="1" value={value.speed} placeholder="0" onChange={e => patch({ speed: e.target.value })} /></div>
        <div className="space-y-2"><Label>{t("流量额度 (GiB)")}</Label><Input type="number" min="0" step="any" value={value.quota} placeholder="0" onChange={e => patch({ quota: e.target.value })} /></div>
      </div>
      <div className="space-y-2"><Label>{t("流量计算方式")}</Label><Select value={value.mode} onValueChange={mode => patch({ mode: mode as RuleTrafficMode })}>
        <SelectTrigger className="w-full"><SelectValue /></SelectTrigger><SelectContent>
          <SelectItem value="outbound">{t("单向（仅出向）")}</SelectItem><SelectItem value="both">{t("双向合计")}</SelectItem><SelectItem value="max">{t("取最大值")}</SelectItem>
        </SelectContent></Select></div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2"><Label>{t("创建时间")}</Label><DatePickerInput value={value.createdDate} onChange={createdDate => patch({ createdDate })} /><Input aria-label={t("创建时间")} type="time" step="1" value={value.createdTime} onChange={e => patch({ createdTime: e.target.value })} /></div>
        <div className="space-y-2"><Label>{t("到期时间")}</Label><DatePickerInput value={value.expiresDate} placeholder={t("不限制")} onChange={expiresDate => patch({ expiresDate })} /><Input aria-label={t("到期时间")} type="time" step="1" disabled={!value.expiresDate} value={value.expiresTime} onChange={e => patch({ expiresTime: e.target.value })} /></div>
      </div>
      <p className="text-xs text-muted-foreground">{t("到期时间留空表示永久有效；创建时间仅用于记录，不影响启用时间。修改日期不会清零已用流量。")}</p>
    </div>
  </details>;
}
