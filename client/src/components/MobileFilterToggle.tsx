import { ChevronDown, SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { t as translateText } from "@/i18n";
import { cn } from "@/lib/utils";

/**
 * Phone-only switch for the secondary filters of a list page. The search box
 * stays visible; the selects sit in a sibling wrapper built with
 * `mobileFilterPanelClass`, which is `display: contents` from `sm` up so the
 * desktop toolbar keeps its single flex row.
 */
export function MobileFilterToggle({
  open,
  onOpenChange,
  activeCount = 0,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  activeCount?: number;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      aria-expanded={open}
      className="h-8 shrink-0 gap-1.5 px-2.5 text-xs font-normal sm:hidden"
      onClick={() => onOpenChange(!open)}
    >
      <SlidersHorizontal className="h-3.5 w-3.5" />
      {translateText("筛选")}
      {activeCount > 0 && (
        <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[11px] font-medium leading-none text-primary-foreground">
          {activeCount}
        </span>
      )}
      <ChevronDown className={cn("h-3.5 w-3.5 text-muted-foreground transition-transform", open && "rotate-180")} />
    </Button>
  );
}

export function mobileFilterPanelClass(open: boolean) {
  return cn(open ? "grid" : "hidden", "gap-2 sm:contents");
}
