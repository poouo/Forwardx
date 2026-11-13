import { useCallback, useState } from "react";
import { BarChart3, ChevronUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { t as translateText } from "@/i18n";
import { cn } from "@/lib/utils";

const STORAGE_PREFIX = "forwardx.summaryCollapsed.";

function readCollapsed(page: string) {
  try {
    return window.localStorage.getItem(STORAGE_PREFIX + page) === "1";
  } catch {
    return false;
  }
}

/** Remembers per browser whether the summary cards of a list page are hidden,
 * so people who manage long lists can give the rows the whole screen. */
export function useSummaryCollapsed(page: string) {
  const [collapsed, setCollapsedState] = useState(() => readCollapsed(page));
  const setCollapsed = useCallback((next: boolean) => {
    setCollapsedState(next);
    try {
      if (next) window.localStorage.setItem(STORAGE_PREFIX + page, "1");
      else window.localStorage.removeItem(STORAGE_PREFIX + page);
    } catch {
      // Private mode or a full quota: the choice then lasts for this visit only.
    }
  }, [page]);
  return [collapsed, setCollapsed] as const;
}

export function SummaryToggle({
  collapsed,
  onCollapsedChange,
  className,
}: {
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  className?: string;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      aria-expanded={!collapsed}
      className={cn("h-8 gap-1.5 px-2.5 text-xs font-normal text-muted-foreground", className)}
      onClick={() => onCollapsedChange(!collapsed)}
    >
      <BarChart3 className="h-3.5 w-3.5" />
      {collapsed ? translateText("展开统计") : translateText("收起统计")}
      <ChevronUp className={cn("h-3.5 w-3.5 transition-transform", collapsed && "rotate-180")} />
    </Button>
  );
}
