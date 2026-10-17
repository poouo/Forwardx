import type { ReactNode } from "react";
import { planDescription, renderPlanDescriptionHtml } from "@/lib/planDisplay";

/** Custom copy replaces the default presentation, never pricing or entitlements. */
export function PlanDetails({ description, children }: { description?: unknown; children?: ReactNode }) {
  const text = planDescription({ description });
  if (!text) return <>{children}</>;
  return <div
    className="plan-description min-w-0 max-w-full overflow-x-auto [overflow-wrap:anywhere] text-sm leading-7 text-muted-foreground"
    dangerouslySetInnerHTML={{ __html: renderPlanDescriptionHtml(text) }}
  />;
}
