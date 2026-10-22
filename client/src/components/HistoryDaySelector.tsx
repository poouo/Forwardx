import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { useMotionEnabled } from "@/components/MotionPolicy";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export type HistoryDayOption = {
  date: string;
  health: "good" | "warning" | "bad" | "none";
  label: string;
  partial?: boolean;
  tooltip: ReactNode;
  trend?: ReactNode;
};

const healthClasses = {
  good: "bg-emerald-500/20 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/30",
  warning: "bg-amber-500/20 text-amber-700 dark:text-amber-300 hover:bg-amber-500/30",
  bad: "bg-red-500/20 text-red-700 dark:text-red-300 hover:bg-red-500/30",
  none: "bg-muted/60 text-muted-foreground hover:bg-muted",
};

const partialStyle = { backgroundImage: "repeating-linear-gradient(135deg, transparent, transparent 5px, var(--color-border) 5px, var(--color-border) 6px)" };

/** Compact days expand on hover/focus; touch layouts use the same dates in a select. */
export function HistoryDaySelector({ items, selectedDay, onSelect, ariaLabel }: {
  items: HistoryDayOption[];
  selectedDay: string | null;
  onSelect: (date: string) => void;
  ariaLabel: string;
}) {
  const motionEnabled = useMotionEnabled();
  const selected = items.find(item => item.date === selectedDay);
  const renderLabel = (item: HistoryDayOption) => <span className="flex min-w-0 flex-1 items-center gap-2">
    <span aria-hidden="true" className={cn("h-3 w-3 shrink-0 rounded-[4px]", healthClasses[item.health])} style={item.partial ? partialStyle : undefined} />
    <span className="tabular-nums">{item.date}</span>
    <span className="ml-auto truncate text-xs text-muted-foreground">{item.label}</span>
  </span>;

  return <div className="min-w-0 w-full" data-history-day-selector="true">
    <div className="sm:hidden" data-history-day-mobile="true">
      <Select value={selected?.date || ""} onValueChange={onSelect}>
        <SelectTrigger aria-label={ariaLabel} className="h-9 text-xs [&>span]:flex-1">
          <SelectValue placeholder={ariaLabel}>{selected ? renderLabel(selected) : undefined}</SelectValue>
        </SelectTrigger>
        <SelectContent className="max-h-[min(24rem,var(--radix-select-content-available-height))]">
          {items.map(item => <SelectItem key={item.date} value={item.date} textValue={item.date} className="min-h-10">
            {renderLabel(item)}
          </SelectItem>)}
        </SelectContent>
      </Select>
    </div>
    <div role="group" aria-label={ariaLabel} data-history-day-strip="true"
      className="hidden w-full min-w-0 gap-1 rounded-xl border border-border/60 bg-muted/20 p-1.5 sm:flex">
      {items.map(item => <Tooltip key={item.date}><TooltipTrigger asChild>
        <button type="button" data-history-day={item.date} data-health={item.health} data-partial={item.partial || false}
          aria-label={`${item.date} ${item.label}`} aria-pressed={selectedDay === item.date} onClick={() => onSelect(item.date)}
          className={cn("group/day relative h-7 min-w-0 flex-1 overflow-hidden rounded-[4px] hover:basis-12 focus-visible:basis-12 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
            motionEnabled ? "transition-[flex-basis,background-color] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)]" : "transition-none",
            healthClasses[item.health], selectedDay === item.date && "ring-2 ring-primary ring-inset")}
          style={item.partial ? partialStyle : undefined}>
          {item.trend && <span aria-hidden="true" data-history-trend-preview="true"
            className={cn("pointer-events-none absolute inset-0 opacity-0 group-hover/day:opacity-100 group-focus-visible/day:opacity-100",
              motionEnabled ? "transition-opacity duration-150" : "transition-none")}>
            {item.trend}
            {item.partial && <span className="absolute inset-0" style={partialStyle} />}
          </span>}
          <span aria-hidden="true" className={cn("pointer-events-none relative z-10 mx-auto block w-fit rounded-sm bg-background/75 px-1 whitespace-nowrap text-[10px] font-medium tabular-nums opacity-0 group-hover/day:opacity-100 group-focus-visible/day:opacity-100",
            motionEnabled ? "transition-opacity duration-150" : "transition-none")}>
            {item.date.slice(5).replace("-", "/")}
          </span>
        </button>
      </TooltipTrigger><TooltipContent side="top" className="max-w-80 space-y-1">{item.tooltip}</TooltipContent></Tooltip>)}
    </div>
  </div>;
}
