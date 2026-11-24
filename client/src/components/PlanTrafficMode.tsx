import { t } from "@/i18n";
import { normalizePlanTrafficMode, PLAN_TRAFFIC_MODES, type PlanTrafficMode } from "@shared/planTraffic";
import { Badge } from "./ui/badge";
import { Label } from "./ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";

const labels: Record<PlanTrafficMode, string> = {
  both: "双向合计",
  outbound: "单向（仅出向）",
  inbound_outbound: "单向（上下行）",
};

const usage: Partial<Record<PlanTrafficMode, string>> = {
  both: "按中转节点两侧计量，扣量为（入向 + 出向）× 2。",
  inbound_outbound: "按规则的入向 + 出向扣量，每个方向各计一次。",
};

export function PlanTrafficModeBadge({ mode }: { mode?: unknown }) {
  const selectedMode = normalizePlanTrafficMode(mode);
  return <Badge variant="outline" className="shrink-0 text-[11px] font-normal" title={t(usage[selectedMode] ?? labels[selectedMode])}>{t(labels[selectedMode])}</Badge>;
}

export function PlanTrafficModeField({ value, onChange }: { value: PlanTrafficMode; onChange: (value: PlanTrafficMode) => void }) {
  const description = usage[value];
  return <div className="space-y-2">
    <Label htmlFor="plan-traffic-mode">{t("流量计算方式")}</Label>
    <Select value={value} onValueChange={value => onChange(normalizePlanTrafficMode(value))}>
      <SelectTrigger id="plan-traffic-mode" className="w-full" aria-describedby={description ? "plan-traffic-mode-help" : undefined}><SelectValue /></SelectTrigger>
      <SelectContent>
        {PLAN_TRAFFIC_MODES.map(mode => <SelectItem key={mode} value={mode}>{t(labels[mode])}</SelectItem>)}
      </SelectContent>
    </Select>
    {description && <p id="plan-traffic-mode-help" className="text-xs text-muted-foreground">{t(description)}</p>}
  </div>;
}
