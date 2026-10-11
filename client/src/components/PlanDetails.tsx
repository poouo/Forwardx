import type { ReactNode } from "react";
import { planDescription } from "@/lib/planDisplay";

/** Custom copy replaces the default presentation, never pricing or entitlements. */
export function PlanDetails({ description, children }: { description?: unknown; children?: ReactNode }) {
  const text = planDescription({ description });
  if (!text) return <>{children}</>;
  return <div className="min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere] text-sm leading-7 text-muted-foreground">{text}</div>;
}
