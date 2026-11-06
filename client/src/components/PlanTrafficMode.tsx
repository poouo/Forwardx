import { t } from "@/i18n";
import { normalizePlanTrafficMode, type PlanTrafficMode } from "@shared/planTraffic";
import { Badge } from "./ui/badge";
import { Label } from "./ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";

export function PlanTrafficModeBadge({ mode }: { mode?: unknown }) {
  const label = normalizePlanTrafficMode(mode) === "outbound" ? t("单向（仅出向）") : t("双向合计");
  return <Badge variant="outline" className="shrink-0 text-[10px] font-normal" title={`${t("流量计算方式")}: ${label}`}>{label}</Badge>;
}

export function PlanTrafficModeField({ value, onChange }: { value: PlanTrafficMode; onChange: (value: PlanTrafficMode) => void }) {
  return <div className="space-y-2">
    <Label htmlFor="plan-traffic-mode">{t("流量计算方式")}</Label>
    <Select value={value} onValueChange={value => onChange(normalizePlanTrafficMode(value))}>
      <SelectTrigger id="plan-traffic-mode" className="w-full"><SelectValue /></SelectTrigger>
      <SelectContent>
        <SelectItem value="both">{t("双向合计")}</SelectItem>
        <SelectItem value="outbound">{t("单向（仅出向）")}</SelectItem>
      </SelectContent>
    </Select>
  </div>;
}
