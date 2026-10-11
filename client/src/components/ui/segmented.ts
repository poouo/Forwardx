import { cn } from "@/lib/utils";

export const segmentedControlClassName = "pearl-segmented rounded-xl border border-border/60 bg-muted/60 p-1 shadow-inner shadow-black/5";

export function segmentedOptionClassName(active: boolean, disabled = false, className?: string) {
  return cn(
    "group flex h-9 min-w-0 items-center justify-center gap-2 rounded-lg border px-3 text-center text-sm font-medium ring-1 ring-transparent transition-all",
    active
      ? "border-border bg-card text-primary shadow-sm"
      : "border-transparent text-muted-foreground hover:bg-background/70 hover:text-foreground",
    disabled && "cursor-not-allowed opacity-50 hover:bg-transparent hover:text-muted-foreground",
    className,
  );
}

export function segmentedIconClassName(active: boolean, className?: string) {
  return cn("h-4 w-4 shrink-0", active ? "text-primary" : "text-current", className);
}
