import type { ReactNode } from "react";
import { DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

/** Separate mobile controls from the title; use columns only when the panel fits. */
export function LatencyChartDialogHeader({ title, description, children }: {
  title: ReactNode;
  description: ReactNode;
  children: ReactNode;
}) {
  return (
    <DialogHeader className="@container/latency-header space-y-0">
      <div className="grid min-w-0 gap-3 @min-[40rem]/latency-header:grid-cols-[minmax(0,1fr)_auto]">
        <div className="min-w-0 space-y-1.5" data-latency-heading="true">
          <DialogTitle className="text-base sm:text-lg">{title}</DialogTitle>
          <DialogDescription className="text-xs sm:text-sm">{description}</DialogDescription>
        </div>
        <div data-latency-controls="true" className="flex min-w-0 flex-wrap items-center gap-2 @min-[40rem]/latency-header:self-start @min-[40rem]/latency-header:justify-end @min-[40rem]/latency-header:pr-10">
          {children}
        </div>
      </div>
    </DialogHeader>
  );
}
