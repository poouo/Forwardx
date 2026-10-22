import type { ReactNode } from "react";

/** Sorting availability must not move the switch or change the title width. */
export function RuleCardControls({ dragHandle, children }: { dragHandle?: ReactNode; children: ReactNode }) {
  return (
    <div data-rule-card-controls="" className="flex h-6 shrink-0 items-center gap-1">
      <span data-rule-card-drag-slot="" className="flex size-6 shrink-0 items-center justify-center">
        {dragHandle}
      </span>
      {children}
    </div>
  );
}
