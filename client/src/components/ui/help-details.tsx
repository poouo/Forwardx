import type { ReactNode } from "react";
import { ChevronDown, CircleHelp } from "lucide-react";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";

/** Secondary guidance stays available to keyboard and touch users without crowding forms. */
export function HelpDetails({ title, children, className }: { title?: string; children: ReactNode; className?: string }) {
  return (
    <details className={cn("pearl-disclosure pearl-help min-w-0", className)}>
      <summary className="flex w-fit max-w-full cursor-pointer items-center gap-1.5 rounded-md text-xs font-medium text-muted-foreground hover:text-foreground">
        <CircleHelp aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0 break-words">{title || t("使用说明")}</span>
        <ChevronDown aria-hidden="true" className="pearl-disclosure-chevron h-3.5 w-3.5 shrink-0" />
      </summary>
      <div className="pearl-help-content mt-2 space-y-2 rounded-lg border border-border/50 bg-muted/25 p-3 text-xs leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
        {children}
      </div>
    </details>
  );
}
