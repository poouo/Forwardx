import { Globe, LayoutGrid, List, MapPinned, Rows3 } from "lucide-react";
import { Button } from "@/components/ui/button";
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
  return <div role="group" aria-label={t("视图")} className="flex shrink-0 items-center overflow-hidden rounded-md border border-border/40">
    {views.map(view => <Button
      key={view.value}
      type="button"
      variant={value === view.value ? "secondary" : "ghost"}
      size="icon"
      className={"desktop" in view ? "hidden h-8 w-8 rounded-none md:inline-flex" : "h-8 w-8 rounded-none"}
      title={t(view.label)}
      aria-label={t(view.label)}
      aria-pressed={value === view.value}
      onClick={() => onChange(view.value)}
    >
      <view.icon aria-hidden="true" className="h-4 w-4 shrink-0" />
    </Button>)}
  </div>;
}
