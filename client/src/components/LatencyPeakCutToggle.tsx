import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

type LatencyPeakCutToggleProps = {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  className?: string;
  id?: string;
};

export function LatencyPeakCutToggle({
  checked,
  onCheckedChange,
  className,
  id = "latency-peak-cut",
}: LatencyPeakCutToggleProps) {
  return (
    <div className={cn("flex items-center gap-2", className)}>
      <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} />
      <Label htmlFor={id} className="cursor-pointer text-xs text-muted-foreground">
        削峰
      </Label>
    </div>
  );
}
