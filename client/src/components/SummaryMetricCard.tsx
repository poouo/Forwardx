import type { LucideIcon } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";

const TONES = {
  sky: "bg-gradient-to-br from-sky-500 to-sky-600",
  emerald: "bg-gradient-to-br from-emerald-500 to-emerald-600",
  violet: "bg-gradient-to-br from-violet-500 to-violet-600",
  amber: "bg-gradient-to-br from-amber-500 to-amber-600",
} as const;

/** Static readout: hover feedback never animates values or starts a new entry animation. */
export function SummaryMetricCard({ title, value, hint, icon: Icon, tone, compact = false }: {
  title: string;
  value: string;
  hint?: string;
  icon: LucideIcon;
  tone: keyof typeof TONES;
  compact?: boolean;
}) {
  return <Card hoverable disableEnterAnimation className="relative h-full overflow-hidden border-border/40 bg-card/60">
    <div aria-hidden="true" className={`pointer-events-none absolute inset-0 opacity-[0.04] ${TONES[tone]}`} />
    <CardContent className={`relative flex h-full items-start justify-between gap-3 ${compact ? "p-4" : "p-5"}`}>
      <div className="min-w-0 flex-1">
        <p className={compact ? "text-xs text-muted-foreground" : "text-sm text-muted-foreground"}>{title}</p>
        <p className={`mt-2 break-words font-semibold tabular-nums [overflow-wrap:anywhere] ${compact ? "text-xl" : "text-2xl"}`}>{value}</p>
        {hint && <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">{hint}</p>}
      </div>
      <div aria-hidden="true" className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl shadow-sm ${TONES[tone]}`}>
        <Icon className="h-5 w-5 text-white" />
      </div>
    </CardContent>
  </Card>;
}
