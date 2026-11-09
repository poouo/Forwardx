import { Globe, LayoutGrid, List, MapPinned, Rows3 } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { t } from "@/i18n";

const views = [
  { value: "compact-card", label: "精简卡片", icon: Rows3 },
  { value: "card", label: "标准卡片", icon: LayoutGrid },
  { value: "table", label: "列表视图", icon: List },
  { value: "map", label: "3D 地球视图", icon: Globe, desktop: true },
  { value: "flat-map", label: "平面地图视图", icon: MapPinned, desktop: true },
] as const;

export default function HostViewSelect({ value, onChange }: {
  value: typeof views[number]["value"];
  onChange: (value: typeof views[number]["value"]) => void;
}) {
  const selected = views.find(view => view.value === value) || views[0];
  return <Select value={value} onValueChange={next => {
    const view = views.find(item => item.value === next);
    if (view) onChange(view.value);
  }}>
    <SelectTrigger className="h-9 w-auto min-w-36" aria-label={t("视图")}>
      <SelectValue><span className="flex items-center gap-2"><selected.icon aria-hidden="true" className="h-4 w-4 shrink-0" strokeWidth={1.5} />{t(selected.label)}</span></SelectValue>
    </SelectTrigger>
    <SelectContent>{views.map(view => <SelectItem key={view.value} value={view.value} className={"desktop" in view ? "hidden md:flex" : undefined}>
      <span className="flex items-center gap-2"><view.icon aria-hidden="true" className="h-4 w-4 shrink-0" strokeWidth={1.5} />{t(view.label)}</span>
    </SelectItem>)}</SelectContent>
  </Select>;
}
