import type { ElementType, ReactNode } from "react";

/** Shared hierarchy for static and cached metrics; callers keep their own data lifecycle. */
export function MetricReadout({ title, value, hint, icon: Icon, compact = false, direction }: {
  title: string;
  value: ReactNode;
  hint?: ReactNode;
  icon?: ElementType;
  compact?: boolean;
  direction?: "inbound" | "outbound";
}) {
  return <div className="pearl-metric" data-compact={compact || undefined} data-direction={direction}>
    <div className="pearl-metric-heading">
      <p className="pearl-metric-label">{title}</p>
      {Icon && <span aria-hidden="true" className="pearl-metric-icon"><Icon className="h-4 w-4" strokeWidth={1.5} /></span>}
    </div>
    <div className="pearl-metric-value">{value}</div>
    {hint && <div className="pearl-metric-hint">{hint}</div>}
  </div>;
}
