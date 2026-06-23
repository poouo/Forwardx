import { cn } from "@/lib/utils";

export const segmentedControlClassName = "rounded-md border border-border/60 bg-muted/25 p-1 shadow-inner shadow-black/5";

export function segmentedOptionClassName(active: boolean, disabled = false, className?: string) {
  return cn(
    "group flex h-9 min-w-0 items-center justify-center gap-2 rounded-sm border px-3 text-center text-sm font-medium ring-1 ring-transparent transition-all",
    active
      ? "border-primary bg-primary/15 text-primary shadow-md shadow-primary/15 ring-primary/35"
      : "border-transparent text-muted-foreground hover:bg-background/70 hover:text-foreground",
    disabled && "cursor-not-allowed opacity-50 hover:bg-transparent hover:text-muted-foreground",
    className,
  );
}

export function segmentedIconClassName(active: boolean, className?: string) {
  return cn("h-4 w-4 shrink-0", active ? "text-primary" : "text-current", className);
}