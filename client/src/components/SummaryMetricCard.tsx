import type { LucideIcon } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { MetricReadout } from "./MetricReadout";

/** Static readout: hover feedback never animates values or starts a new entry animation. */
export function SummaryMetricCard({ title, value, hint, icon, compact = false, direction }: {
  title: string;
  value: string;
  hint?: string;
  icon: LucideIcon;
  direction?: "inbound" | "outbound";
  compact?: boolean;
}) {
  return <Card hoverable disableEnterAnimation className="h-full border-border/60">
    <CardContent className="h-full p-4">
      <MetricReadout title={title} value={value} hint={hint} icon={icon} compact={compact} direction={direction} />
    </CardContent>
  </Card>;
}
