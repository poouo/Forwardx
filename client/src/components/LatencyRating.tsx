import { Activity, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";

export function getLatencyRating(latencyMs: number | null | undefined) {
  if (typeof latencyMs !== "number" || !Number.isFinite(latencyMs)) {
    return { label: "", className: "text-muted-foreground" };
  }
  if (latencyMs <= 80) return { label: "优秀", className: "text-emerald-600 dark:text-emerald-400" };
  if (latencyMs <= 180) return { label: "良好", className: "text-sky-600 dark:text-sky-400" };
  if (latencyMs <= 350) return { label: "一般", className: "text-amber-600 dark:text-amber-400" };
  return { label: "较差", className: "text-destructive" };
}

export function LatencyRating({
  latencyMs,
  isTimeout = false,
  emptyText = "暂无数据",
  timeoutText = "超时/不可达",
  className,
  icon = "activity",
}: {
  latencyMs?: number | null;
  isTimeout?: boolean;
  emptyText?: string;
  timeoutText?: string;
  className?: string;
  icon?: "activity" | "none";
}) {
  if (isTimeout) {
    return (
      <span className={cn("inline-flex items-center gap-1 text-xs text-destructive", className)}>
        <XCircle className="h-3 w-3" />
        {timeoutText}
      </span>
    );
  }

  if (typeof latencyMs !== "number" || !Number.isFinite(latencyMs)) {
    return <span className={cn("text-xs text-muted-foreground", className)}>{emptyText}</span>;
  }

  const rating = getLatencyRating(latencyMs);
  return (
    <span className={cn("inline-flex items-center gap-1 text-xs", rating.className, className)}>
      {icon === "activity" ? <Activity className="h-3 w-3" /> : null}
      <span className="tabular-nums">{latencyMs}ms</span>
      <span className="rounded-full border border-current/20 px-1.5 py-0.5 text-[10px] font-medium leading-none">
        {rating.label}
      </span>
    </span>
  );
}
